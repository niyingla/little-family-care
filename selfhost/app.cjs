const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const { createAvatarStore } = require('./avatar-store.cjs');
const { createService } = require('../server/service.cjs');
const { createWechat } = require('./wechat.cjs');
const { createActivityRecorder } = require('../server/activity.cjs');
const { createPhotoWall } = require('../server/photo-wall.cjs');
const d = require('../server/domain');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const randomId = () => crypto.randomBytes(16).toString('hex');
const fail = (message, status = 400) => {
  throw Object.assign(new Error(message), { status });
};

/**
 * 提取可公开给运维日志的错误代码，禁止输出SQL、连接串及外部URL。
 * @param {Error} error 请求边界捕获的数据库、网络或微信业务异常。
 * @returns {object} 仅含受限枚举格式的系统代码和整数微信错误码。
 */
function diagnosticCodes(error) {
  // 外部适配器可能把底层网络错误放在cause中，只提取可审计的代码。
  const code = error.code || (error.cause && error.cause.code) || 'UNKNOWN';
  // 不直接打印异常对象；其message、sql和cause可能包含登录凭据或业务资料。
  return {
    errorCode: /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'UNKNOWN',
    ...(Number.isInteger(error.errCode) ? { wechatCode: error.errCode } : {}),
  };
}

/**
 * 读取受限大小的JSON请求，避免图片上传把整个进程内存占满。
 * @param {object} request Node请求流，正文应为JSON对象且不超过1500000字节。
 * @returns {Promise<object>} 解码后的请求数据，空正文按空对象处理。
 * @throws {Error} 请求过大返回413，JSON损坏时返回业务格式错误。
 */
async function readBody(request) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    // 按流分段累计实际字节，不能依赖调用方声明的Content-Length。
    bytes += chunk.length;
    if (bytes > 1500000) fail('请求内容过大', 413);
    chunks.push(chunk);
  }
  try {
    // 空正文供无参数动作使用，不能因其缺省而阻断合法业务调用。
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch (_) {
    // 不把JSON解析错误正文返回给客户端，避免回显用户上传的数据。
    fail('请求格式不正确');
  }
}

/**
 * 创建服务器模式HTTP入口，与云函数共用同一业务服务和规则。
 * @param {object} options repo、服务端config，可注入微信接口用于隔离外部测试。
 * @returns {object} HTTP server、定时tick和close方法。
 * @throws {Error} 签名密钥缺失或长度不足时拒绝启动，不能提供无保护的图片入口。
 */
function createHttpApplication({ repo, config, wechat = createWechat(config) }) {
  // 图片依赖签名保护，配置不完整时在接受任何请求之前停止初始化。
  if (!config.signingSecret || config.signingSecret.length < 32)
    throw new Error('签名密钥至少需要32字符');
  const fields = config.fields || {};
  // 登录与业务使用同一持久仓库，审计身份统一派生自可信微信身份。
  const activity = createActivityRecorder({ repo, now: () => new Date().toISOString(), randomId });
  const templateId = fields.task && fields.baby && fields.time ? config.templateId || '' : '';
  // 模板字段不齐时显式视作未配置，避免向微信发送结构残缺的通知。
  // 真实时间由服务器提供，小程序不能通过传时间改变当天任务归属。
  const service = createService(repo, {
    ownerOpenId: config.ownerOpenId || '',
    templateId,
    now: () => new Date().toISOString(),
    randomId,
    hash,
    sendMessage: (message) => wechat.sendMessage(message),
  });
  const avatarDirectory = path.join(config.dataDir, 'avatars');
  // 完成照片复用私有图片存储，家庭和任务用途仍由care_files元数据区分。
  const avatars = createAvatarStore({
    repo,
    directory: avatarDirectory,
    mode: config.avatarStorage,
  });
  // 签名同时绑定随机文件名和失效时间，客户端不能延长已有图片链接寿命。
  const sign = (filename, expires) =>
    crypto
      .createHmac('sha256', config.signingSecret)
      .update(`${filename}:${expires}`)
      .digest('hex');
  const avatarUrl = (filename) => {
    // 十分钟窗口覆盖一次查看；长期历史需要成员重新鉴权后再取链接。
    const expires = Date.now() + 600000;
    return `${config.publicOrigin}/api/avatar/${filename}?expires=${expires}&signature=${sign(filename, expires)}`;
  };
  // 照片墙复用私有数据库图片存储，签名仅在成员授权后的帖子读取中生成。
  // 成员读取复用业务服务的即时权限，不能因持有墙帖游标绕过已离家状态。
  // 图片仍经同一私有分段出口，wall与completion用途由各自元数据单独校验。
  const photoWall = createPhotoWall(repo, {
    readMember: service.readMember,
    hash,
    randomId,
    now: () => new Date().toISOString(),
    avatars,
    photoUrl: avatarUrl,
  });
  // HTTP仅开放这四种动作，完成事务接入及内部链表方法不属于外部调用面。
  const wallActions = new Set([
    'uploadWallPhoto',
    'publishPhotoPost',
    'listPhotoPosts',
    'deletePhotoPost',
  ]);
  // 频率状态仅在本进程使用，不与家庭成员、业务执行记录混存。
  const counters = new Map();
  /**
   * 限制同一来源的短时请求数量，避免上传和图片接口被匿名连续扫描。
   * @param {object} request 含socket.remoteAddress的服务器请求。
   * @returns {void} 未超限时继续处理，不产生业务数据写入。
   * @throws {Error} 单来源一分钟超过240次请求时返回429。
   */
  function checkRate(request) {
    const address = request.socket.remoteAddress || 'unknown';
    const key = address;
    const time = Date.now(),
      entry = counters.get(key);
    // 时间窗到期后重置额度，不让历史计数永久阻断合法家人。
    if (!entry || entry.until < time) counters.set(key, { until: time + 60000, count: 1 });
    else if (++entry.count > 240) fail('请求过于频繁，请稍后再试', 429);
    // 限制匿名来源状态数量，避免外部扫描令内存持续增长。
    if (counters.size > 1000)
      for (const [id, record] of counters) if (record.until < time) counters.delete(id);
  }
  /**
   * 从服务器会话恢复真实微信身份，不采信请求正文中的成员标记。
   * @param {object} request Authorization头应携带64位随机Bearer会话令牌。
   * @returns {Promise<string>} 登录交换后保存在会话中的可信openid。
   * @throws {Error} 令牌缺失、格式不合法、会话不存在或过期时返回401。
   */
  async function identity(request) {
    // 先限制令牌格式，再访问仓库，避免任意输入成为会话查询键。
    const match = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.authorization || '');
    if (!match) fail('登录已过期，请重新登录', 401);
    // 仓库只按哈希查找，原令牌不进入业务日志和持久化主键。
    const session = await repo.get('care_sessions', hash(match[1]));
    if (!session || session.expiresAt < Date.now()) fail('登录已过期，请重新登录', 401);
    return session.openid;
  }
  /**
   * 仅允许当前管理员向私有图片仓库上传宝宝头像。
   * @param {string} openid 当前会话提供的可信微信身份。
   * @param {object} data 原始base64编码的JPG或PNG头像，解码后最多1MB。
   * @returns {Promise<object>} 可供保存宝宝资料引用的随机fileID及上传说明。
   * @throws {Error} 非管理员、图片过大、格式不支持或存储失败时拒绝上传。
   */
  async function uploadAvatar(openid, data) {
    // 管理员判断必须同时通过当前成员资格，移除后旧会话不能继续改头像。
    const home = await service.readMember(openid);
    if (home.ownerId !== hash(openid).slice(0, 32)) fail('仅管理员可修改宝宝头像', 403);
    const base64 = String(data.base64 || '');
    // 先限制编码字符和长度，避免解码任意正文或超大分配。
    if (base64.length > 1400000 || !/^[a-zA-Z0-9+/=]+$/.test(base64))
      fail('请上传1MB以内JPG或PNG头像');
    const buffer = Buffer.from(base64, 'base64');
    // 文件头和解码后大小由后端验证，不能采信客户端扩展名与size。
    const jpeg = buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
    const png = buffer.slice(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if ((!jpeg && !png) || buffer.length > 1024 * 1024) fail('请上传1MB以内JPG或PNG头像');
    const filename = `${randomId()}.${jpeg ? 'jpg' : 'png'}`,
      fileID = `avatar:${filename}`;
    // 文件使用随机名；只有登记为当前家庭所有后才可在宝宝资料中引用。
    await avatars.write(filename, buffer);
    await repo.put('care_files', hash(fileID), { ownerId: home.ownerId, fileID });
    return { fileID, message: '头像已上传' };
  }

  /**
   * 保存当前成员为当天待完成事项主动选择的照片，不修改完成状态。
   * @param {string} openid 已通过服务器会话验证的微信身份。
   * @param {object} data taskId、北京时间date与不含前缀的base64图片，最多1MB。
   * @returns {Promise<object>} 随机photoId，只有后续完成事务可以关联到执行记录。
   * @throws {Error} 成员无权、任务已完成、日期不合法或图片格式不符合限制。
   */
  async function uploadCompletionPhoto(openid, data) {
    // 即使当前请求持有未过期会话，已移除家人也不能继续写入文件。
    const home = await service.readMember(openid);
    const today = d.chinaDate(new Date().toISOString());
    // 上传只接受今天应做且尚未完成的事项；不能用历史页面补造照片记录。
    if (data.date !== today) fail('只能为当天待完成事项上传照片');
    const day = await repo.get('care_days', today);
    // 按任务的生效版本和周期重建当天清单，归档或尚未开始的任务不会通过。
    const row = d.rowsForDate(home, day, today).find((item) => item.id === data.taskId);
    if (!row || row.done) fail('事项不存在或已完成，请刷新后再操作');
    const encoded = data.base64;
    // 先限制编码长度再分配Buffer，避免大请求造成额外内存占用。
    if (
      typeof encoded !== 'string' ||
      encoded.length > 1400000 ||
      !/^[a-zA-Z0-9+/=]+$/.test(encoded)
    )
      fail('请上传1MB以内JPG或PNG照片');
    const buffer = Buffer.from(encoded, 'base64');
    const jpeg = buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
    const png = buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    // 依据文件头和实际解码字节数判断，不信任客户端扩展名及文件大小。
    if ((!jpeg && !png) || buffer.length > 1024 * 1024 || buffer.toString('base64') !== encoded)
      fail('请上传1MB以内JPG或PNG照片');
    // 文件名完全由服务端生成，不沿用相册名称、路径或可猜测的任务编号。
    const filename = `${randomId()}.${jpeg ? 'jpg' : 'png'}`;
    const photoId = `photo:${filename}`;
    await avatars.write(filename, buffer);
    // 用独立kind和任务、日期、上传人绑定，不能把照片当头像或跨任务复用。
    await repo.put('care_files', hash(photoId), {
      kind: 'completion',
      fileID: photoId,
      ownerId: home.ownerId,
      uploadedBy: hash(openid).slice(0, 32),
      taskId: row.id,
      date: today,
    });
    // 完成事务仍会再次校验上传人和任务版本；上传成功并不等同于打勾成功。
    console.info('事项照片已上传', { taskId: row.id, date: today, bytes: buffer.length });
    return { photoId };
  }

  /**
   * 仅在业务快照通过成员权限后签发照片短链，保持存储文件私有。
   * @param {object} snapshot 已鉴权的家庭、日期及当天执行记录。
   * @returns {Promise<void>} 原位补全records和events的photoUrl，不删除任何历史流水。
   * @throws {Error} 元数据仓库不可用时交给请求边界处理。
   */
  async function attachCompletionPhotos(snapshot) {
    if (!snapshot.day) return;
    const urls = new Map();
    /**
     * @param {object} item 当前完成记录或某条历史流水，可含photoId。
     * @param {string} taskId 记录本身所属的任务ID，不能取上传请求里的身份字段。
     * @returns {Promise<string>} 符合家庭、任务、日期绑定关系的短链，否则为空。
     * @throws {Error} 元数据读取失败时向请求边界传播，不伪造可访问地址。
     */
    async function resolvePhoto(item, taskId) {
      const photoId = item.photoId;
      // 只接受服务端随机照片ID；即使数据库存在其他地址，也不会替它签名。
      if (typeof photoId !== 'string' || !/^photo:[a-f0-9]{32}\.(png|jpg)$/.test(photoId))
        return '';
      const key = `${taskId}:${photoId}`;
      // 同一照片同时出现在当前状态与历史事件时复用一次元数据读取和签名。
      if (urls.has(key)) return urls.get(key);
      const file = await repo.get('care_files', hash(photoId));
      // 旧头像和其他任务的文件不能借快照获得访问签名。
      const valid =
        file &&
        file.kind === 'completion' &&
        file.fileID === photoId &&
        file.ownerId === snapshot.home.ownerId &&
        file.taskId === taskId &&
        file.date === snapshot.date;
      // 未通过绑定校验时缓存空结果，同一无权文件不会在本次快照内被反复查询。
      const url = valid ? avatarUrl(photoId.slice(6)) : '';
      urls.set(key, url);
      return url;
    }
    const records = snapshot.day.records || {};
    for (const [taskId, record] of Object.entries(records)) {
      // 家庭任务数最多200项；当前完成照片始终可见，不受流水窗口影响。
      record.photoUrl = await resolvePhoto(record, taskId);
    }
    const events = snapshot.day.events || [];
    // 旧流水仍返回photoId和文字，前端可明确区分暂未加载的历史图片。
    for (let index = 0; index < events.length; index += 1) {
      // 保留全部历史文本，仅为最近500条流水签名，避免重复撤销导致无界图片查询。
      const event = events[index];
      event.photoUrl = index >= events.length - 500 ? await resolvePhoto(event, event.taskId) : '';
    }
  }

  /**
   * 按需为某次真实执行记录签发照片短链，支持较早的完整历史流水。
   * @param {string} openid 会话验证后的微信身份，仍需重新校验家庭成员资格。
   * @param {object} data photoId、taskId和历史date，三者必须在日记录中精确关联。
   * @returns {Promise<object>} 只含本张照片10分钟有效的photoUrl。
   * @throws {Error} 访问无权、日期不合法、照片未关联或元数据不匹配。
   */
  async function completionPhoto(openid, data) {
    // 持有照片ID不等于仍有家庭访问权，已离家成员的有效会话也必须拒绝。
    const home = await service.readMember(openid);
    const today = d.chinaDate(new Date().toISOString());
    // 日期范围与家庭快照一致，不能用未来或建家前日期探测其他文件。
    if (!d.validDate(data.date) || data.date > today || data.date < home.createdDate)
      fail('请选择家庭创建之后、今天之前的有效日期');
    // 文件ID只允许服务端随机格式，防止把路径或任意URL传进签名器。
    if (
      typeof data.taskId !== 'string' ||
      !/^photo:[a-f0-9]{32}\.(png|jpg)$/.test(data.photoId || '')
    )
      fail('照片参数不正确，请刷新后重试');
    const day = await repo.get('care_days', data.date);
    const record = day && day.records && day.records[data.taskId];
    // 撤销会清空当前记录，但原完成流水仍可证明照片属于这次真实执行。
    const referenced =
      (record && record.photoId === data.photoId) ||
      (day &&
        (day.events || []).some(
          (event) => event.taskId === data.taskId && event.photoId === data.photoId
        ));
    if (!referenced) fail('照片未关联这条执行记录，请刷新后重试');
    // 关联证据来自服务端日记录；客户端提供的执行人或完成标记不能替代它。
    const file = await repo.get('care_files', hash(data.photoId));
    // 仅凭持有随机photoId仍无权读取，绑定家庭、任务和日期必须全部吻合。
    if (
      !file ||
      file.kind !== 'completion' ||
      file.fileID !== data.photoId ||
      file.ownerId !== home.ownerId ||
      file.taskId !== data.taskId ||
      file.date !== data.date
    )
      fail('当前照片暂时无法访问，请刷新后重试');
    // 复用头像的私有签名及分段读取入口，不返回原始图片或存储路径。
    return { photoUrl: avatarUrl(data.photoId.slice(6)) };
  }
  /**
   * 输出已签名的私有头像或完成照片，并支持小程序受限响应的分段下载。
   * @param {URL} url 随机文件名以及expires、signature查询参数。
   * @param {object} request 可含显式bytes起止范围的Node请求。
   * @param {object} response Node响应对象，成功后写出图片字节流。
   * @returns {Promise<void>} 图片以200或206输出，不返回存储元数据。
   * @throws {Error} 签名非法或过期返回403，范围非法返回416，存储失败向外传播。
   */
  async function serveAvatar(url, request, response) {
    // 路由后缀仍需验证随机名，不能直接用客户端路径读取磁盘。
    const filename = url.pathname.slice('/api/avatar/'.length);
    const expires = Number(url.searchParams.get('expires')),
      signature = url.searchParams.get('signature') || '';
    // 失效时间同时限制过去和超过十分钟的未来值，拒绝异常长效链接。
    if (
      !/^[a-f0-9]{32}\.(png|jpg)$/.test(filename) ||
      !Number.isSafeInteger(expires) ||
      expires < Date.now() ||
      expires > Date.now() + 600000 ||
      !/^[a-f0-9]{64}$/.test(signature)
    )
      fail('图片链接已失效', 403);
    // 文件名只允许服务端随机值，且签名长度固定后再做恒定时间比较。
    if (
      !crypto.timingSafeEqual(
        Buffer.from(signature, 'hex'),
        Buffer.from(sign(filename, expires), 'hex')
      )
    )
      fail('图片链接已失效', 403);
    // 完成签名验证后才访问私有存储，拒绝请求不会泄露文件是否存在。
    const data = await avatars.read(filename);
    // 未带Range时输出完整文件，带Range时严格按实际文件长度截取。
    let start = 0,
      end = data.length - 1;
    const range = request.headers.range;
    if (range) {
      // 云托管响应有1000KiB上限；客户端按512KiB分段读取1MB原始头像。
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);
      // 仅支持单一显式范围，不接受多段和后缀语法，降低错误缓存及拼接风险。
      if (!match) fail('图片读取范围不正确', 416);
      start = Number(match[1]);
      end = Math.min(Number(match[2]), data.length - 1);
      // 超过文件末尾可裁剪，但负向、空范围和非安全整数必须拒绝。
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        start > end ||
        start >= data.length
      )
        fail('图片读取范围不正确', 416);
    }
    // subarray不额外复制整张图片，分段读取仍保持原始字节顺序。
    const body = data.subarray(start, end + 1);
    // 私有短缓存减少重复查看流量，不让代理把家庭照片当成公开资源缓存。
    response.writeHead(range ? 206 : 200, {
      'content-type': filename.endsWith('.png') ? 'image/png' : 'image/jpeg',
      'cache-control': 'private, max-age=60',
      // 固定图片类型并禁用嗅探，客户端不能将上传内容当成可执行文档。
      'x-content-type-options': 'nosniff',
      'accept-ranges': 'bytes',
      'content-length': body.length,
      ...(range ? { 'content-range': `bytes ${start}-${end}/${data.length}` } : {}),
    });
    // 只有最终合法范围会写入响应，错误统一交给上层结构化异常边界。
    response.end(body);
  }
  /**
   * 输出不缓存的JSON业务响应，登录会话及家庭数据不能被共享缓存复用。
   * @param {object} response 尚未写入响应头的Node响应对象。
   * @param {number} status 已由请求边界确定的HTTP状态码。
   * @param {object} data 公开业务响应，内部凭据及异常对象不得传入。
   * @returns {void} 写入JSON并结束当前响应。
   */
  const send = (response, status, data) => {
    // 登录令牌和家庭快照均使用no-store，避免在浏览器或代理留下可复用副本。
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    // 统一序列化保证图片入口之外的所有结果遵循相同响应格式。
    response.end(JSON.stringify(data));
  };
  /**
   * 分发HTTP请求并统一屏蔽内部异常，身份校验必须早于家庭数据操作。
   * @param {object} request 原始Node请求，正文和客户端身份字段均不可信。
   * @param {object} response 当前请求独占的Node响应对象。
   * @returns {Promise<void>} 每个请求仅输出一次健康、业务JSON或已鉴权图片响应。
   * @throws {Error} 已写入响应后发生的底层网络异常由HTTP运行时处理。
   */
  const server = http.createServer(async (request, response) => {
    // 请求耗时只用于审计，不采信客户端时间或追踪字段。
    const started = Date.now();
    let operation = 'unknown';
    let activityActorId = '';
    try {
      // 使用固定本机基准解析相对路径，不从Host头构造对外链接。
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
        // 健康检查仅报告配置是否存在，不返回环境变量或任何微信凭据。
        send(response, 200, {
          ok: true,
          service: 'little-family-care',
          wechatConfigured: !!(config.appId && config.appSecret),
        });
        return;
      }
      // 健康探针之外的匿名请求也限频，图片接口不能绕过流量控制。
      checkRate(request);
      if (request.method === 'GET' && url.pathname.startsWith('/api/avatar/')) {
        // 图片访问依赖短链签名，不能把随机文件名视作身份凭证。
        operation = 'avatar';
        await serveAvatar(url, request, response);
        return;
      }
      // 业务统一使用JSON POST，避免URL查询串携带登录码或家庭操作内容。
      if (request.method !== 'POST') fail('接口不存在', 404);
      if (!String(request.headers['content-type'] || '').startsWith('application/json'))
        fail('请使用JSON请求');
      if (url.pathname === '/api/login') {
        // 登录是唯一无需已有会话的写入口，只接受微信短时code换取身份。
        operation = 'login';
        const data = await readBody(request);
        // 先约束类型和长度，防止异常输入被带到微信开放接口。
        if (typeof data.code !== 'string' || data.code.length < 1 || data.code.length > 256)
          fail('微信登录凭证不正确');
        // 微信返回的身份是后续会话唯一来源，请求体中的openid不会参与授权。
        const user = await wechat.exchangeCode(data.code);
        // 行为日志只使用不可逆内部成员ID，避免记录原始微信身份。
        activityActorId = hash(user.openid).slice(0, 32);
        const token = crypto.randomBytes(32).toString('hex');
        // 数据库仅存会话token的哈希，原值只在登录成功时给本人。
        await repo.put('care_sessions', hash(token), {
          openid: user.openid,
          expiresAt: Date.now() + 7 * 86400000,
        });
        // 会话已持久化后才记录登录成功，不能把微信交换成功误当成完整登录成功。
        await activity.record({
          actorId: activityActorId,
          kind: 'login',
          name: 'login',
          source: 'server',
          outcome: 'success',
          durationMs: Date.now() - started,
        });
        // 原始会话仅在此响应交给本人，其余业务响应不重复返回。
        send(response, 200, { ok: true, data: { token } });
        return;
      }
      // 拒绝未注册路径，不能把任意URL末段当成可执行的业务动作。
      if (url.pathname !== '/api/call') fail('接口不存在', 404);
      // 在解析上传正文前先验证会话，未登录调用不能进行家庭数据读写。
      const openid = await identity(request),
        payload = await readBody(request);
      const action = payload.action || '',
        data = payload.data || {};
      // 日志动作限制为短字母标识，未知输入不能把用户正文写进运维日志。
      operation = /^[a-zA-Z]{1,24}$/.test(action) ? action : 'unknown';
      // 文件入口只负责上传和签名，完成状态仍走事务化业务服务。
      let result =
        action === 'uploadAvatar'
          ? await uploadAvatar(openid, data)
          : action === 'uploadCompletionPhoto'
            ? await uploadCompletionPhoto(openid, data)
            : action === 'completionPhoto'
              ? await completionPhoto(openid, data)
              : wallActions.has(action)
                ? await photoWall.call(openid, action, data)
                : await service.call(openid, action, data);
      if (action === 'snapshot') {
        // 先由service验证当前家庭成员，再为返回给该成员的图片补短链。
        result.home.babies = result.home.babies.map((b) => ({
          ...b,
          avatarUrl:
            b.avatar && /^avatar:[a-f0-9]{32}\.(png|jpg)$/.test(b.avatar)
              ? avatarUrl(b.avatar.slice(7))
              : '',
        }));
        // 完成照片还需额外验证任务及日期绑定，不能沿用头像的仅文件名判断。
        await attachCompletionPhotos(result);
      }
      // 业务全部成功后才发送ok，异常不会被包装为成功的空结果。
      send(response, 200, { ok: true, data: result });
    } catch (error) {
      // 中文业务校验可以展示，数据库及网络原文统一屏蔽，防止泄露内部配置。
      const business = /^[\u4e00-\u9fff]/.test(error.message || '');
      const status = error.status || (business ? 400 : 500);
      // 登录失败独立留痕；未取得微信身份时保持空成员ID，不猜测或伪造身份。
      if (operation === 'login')
        await activity.record({
          actorId: activityActorId,
          kind: 'login',
          name: 'login',
          source: 'server',
          outcome: 'failure',
          durationMs: Date.now() - started,
          ...diagnosticCodes(error),
        });
      // 不记录URL查询、微信code、会话token、OpenID和图片内容。
      console.warn(
        '服务器请求失败',
        JSON.stringify({
          operation,
          status,
          ...diagnosticCodes(error),
          elapsedMs: Date.now() - started,
        })
      );
      // 响应头尚未发送时才写结构化错误，避免对已输出图片流重复发送JSON。
      if (!response.headersSent)
        send(response, status, {
          ok: false,
          message: business ? error.message : '服务器暂时不可用，请稍后重试',
        });
      // 图片流中途出错只结束连接，让客户端识别下载失败而不是缓存混合内容。
      else response.end();
    }
  });
  // 给上传正文和响应头分别设定超时，慢连接不能无限占用应用资源。
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  // 对外只暴露HTTP生命周期与受控调度入口，不暴露图片签名或微信身份解析器。
  return {
    server,
    tick: () => service.tick(),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
module.exports = { createHttpApplication };
