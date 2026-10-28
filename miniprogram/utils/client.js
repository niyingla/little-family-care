const d = require('./domain');
const config = require('../config');
const { createTransport } = require('./transport');
const { createAvatarCache } = require('./avatar-cache');
const {
  MAX_IMAGE_BYTES,
  MAX_BASE64_LENGTH,
  UPLOAD_CHUNK_CHARACTERS,
  MAX_UPLOAD_PARTS,
} = require('./media-policy');
const KEY = 'little-family-care-demo-v1';
const IMAGE_UPLOAD_FIELDS = {
  uploadAvatar: [],
  uploadCompletionPhoto: ['taskId', 'date'],
  uploadWallPhoto: ['scope', 'babyId'],
  uploadMemberAvatar: ['memberId'],
};
let demo = false;
let sessionSequence = 0;
let reviewLoginAttempt = 0;

/**
 * 创建仅保留在进程内的身份上下文，正式和审核永不共享令牌或图片读取器。
 * @param {boolean} review 仅审核账号经服务器验证成功后才作为活动上下文使用。
 * @returns {object} 独立的令牌、并发登录、传输器及缓存容器。
 */
function createSession(review) {
  // 数字编号仅用于沙盒文件隔离，不包含令牌、账号或微信身份。
  // 并发登录只在同一身份内合并，不能让两个模式共享正在交换的登录结果。
  return {
    id: ++sessionSequence,
    review,
    token: '',
    loginPromise: null,
    transport: null,
    cache: null,
  };
}
let activeSession = createSession(false);

/**
 * 拒绝旧身份的在途结果，防止退出或切换模式后覆写新页面。
 * @param {object} session 发起当前操作时捕获的身份上下文。
 * @returns {void} 上下文仍有效时继续。
 * @throws {Error} 身份上下文已经切换时返回固定错误，不暴露旧响应内容。
 */
function assertSession(session) {
  // 依据对象身份而不是页面query判断，旧登录响应也不能恢复已经退出的令牌。
  if (session !== activeSession) throw new Error('登录会话已切换，请重新打开当前页面');
}

/**
 * 结束旧缓存并切换身份，原令牌不能随新上下文继续使用。
 * @param {object} next 已验证或明确退出后创建的新身份上下文。
 * @returns {void} 旧图片文件及等待者失效，新上下文不继承任何请求状态。
 */
function replaceSession(next) {
  // 先清空原令牌，再取消文件回写，切换瞬间也不向另一命名空间发送旧身份。
  activeSession.token = '';
  if (activeSession.cache && activeSession.cache.clear) activeSession.cache.clear();
  activeSession = next;
  demo = false;
}

/**
 * 为固定身份延迟创建不可变路由传输器。
 * @param {object} session 当前请求捕获的身份上下文。
 * @returns {Function} 只使用该身份的正式或审核路由前缀。
 */
function sessionTransport(session) {
  // 模式创建后不再随全局变量变化，在途分段不会中途换到另一套数据。
  if (!session.transport)
    session.transport = createTransport(config, wx, { review: session.review });
  return session.transport;
}

/**
 * 通过当前受控会话发送固定业务请求。
 * @param {string} route 内部业务相对入口。
 * @param {*} data 当前动作的业务参数，不持久化或写入日志。
 * @param {string} token 仅发送给匹配会话命名空间的授权令牌。
 * @param {object} session 发起当前流程时捕获的上下文。
 * @returns {Promise<object>} 传输层原始HTTP响应。
 * @throws {Error} 上下文已切换或网络请求失败时拒绝。
 */
function request(route, data, token, session = activeSession) {
  // 延迟创建，结构检查及本地体验不依赖真实微信运行环境。
  assertSession(session);
  return sessionTransport(session)(route, data, token);
}

/**
 * 延迟创建当前进程的私有图片读取器，不在此下载图片。
 * @param {object} session 发起图片读取时的身份上下文，不能跨模式复用。
 * @returns {Function} 共用load、pin与clear能力的有界沙盒读取器。
 */
function privateImageLoader(session = activeSession) {
  assertSession(session);
  // 初始化不读取图片，调用方可在下载之前固定当前预览组的缓存。
  // 命名空间同时包含模式和本次编号，同名图片也不会命中上一身份的沙盒文件。
  if (!session.cache)
    session.cache = createAvatarCache(sessionTransport(session), wx, {
      review: session.review,
      namespace: `${session.review ? 'review' : 'family'}-${session.id}`,
    });
  return session.cache;
}

/**
 * 在直连HTTPS与云托管两种传输中统一校验图片身份命名空间。
 * @param {string} url 服务端给出的相对地址或HTTPS私有短链。
 * @param {object} session 当前有效身份，审核只接受完整review图片路径。
 * @returns {void} 地址与身份匹配时继续，不更改原签名地址。
 * @throws {Error} 跨模式短链或审核图片路径不正确时拒绝展示。
 */
function assertImageSession(url, session) {
  // 仅去除HTTPS站点部分用于判断，发送时始终保留后端原始签名及review前缀。
  if (typeof url !== 'string') throw new Error('图片地址不正确');
  const route = url.replace(/^https:\/\/[^/]+/, '');
  if (session.review) {
    // 直连模式也不能绕过隔离检查，把正式家庭图片当成审核数据展示。
    if (!/^\/review\/api\/avatar\/[a-f0-9]{32}\.(png|jpg)\?/.test(route))
      throw new Error('审核图片地址不正确，请刷新后重试');
  } else if (route.startsWith('/review/')) {
    throw new Error('当前家庭会话不能读取审核图片');
  }
}

/**
 * 按需读取单张已授权图片，封面加载不改变当前预览组。
 * @param {string} url 有效的短期图片地址，云托管为受控相对路径。
 * @param {object} session 可选的内部身份上下文，快照头像读取必须与该快照一致。
 * @returns {Promise<string>} 供image组件使用的本地路径或HTTPS短链。
 * @throws {Error} 地址无效或分段下载失败时拒绝。
 */
async function loadPrivateImage(url, session = activeSession) {
  assertSession(session);
  if (!url) throw new Error('照片暂时不可用，请刷新后重试');
  // 审核已过期时连旧短链也不从缓存读取，必须重新通过审核账号登录。
  if (session.review && !session.token) throw reviewExpired();
  assertImageSession(url, session);
  // 云开发临时地址和自有域名可直接读取，云托管相对地址需要callContainer。
  if (!config.cloudRunEnvId) return url;
  // 封面只加载当前一张，不替换用户正在预览的整组文件保护范围。
  const local = await privateImageLoader(session)(url);
  assertSession(session);
  return local;
}

/**
 * 固定并加载当前预览组，避免封面下载淘汰九图预览正在使用的本地文件。
 * @param {string[]} urls 当前已授权动态的一至九张照片短链。
 * @returns {Promise<string[]>} 全部可用的本地图片路径或直接可用的HTTPS地址。
 * @throws {Error} 照片列表非法或任意照片未完整下载时不打开残缺预览。
 */
async function loadPrivateImages(urls) {
  const session = activeSession;
  // 先验证整组数量和地址，任一无效都不替换当前预览保护集合或开始部分下载。
  if (
    !Array.isArray(urls) ||
    urls.length < 1 ||
    urls.length > 9 ||
    urls.some((url) => typeof url !== 'string' || !url)
  )
    throw new Error('预览照片列表不正确');
  if (session.review && !session.token) throw reviewExpired();
  // 所有地址都通过校验后才启动下载，不能先展示前半组再发现后半组属于另一身份。
  for (const url of urls) assertImageSession(url, session);
  // 只有云托管走沙盒缓存，其他传输方式仍须先通过身份和图片命名空间校验。
  if (!config.cloudRunEnvId) return urls.slice();
  const load = privateImageLoader(session);
  // 整组先被固定再并发读取；不能等某张下载完成后才补保护。
  load.pin(urls);
  const local = await Promise.all(urls.map((url) => load(url)));
  assertSession(session);
  return local;
}

/**
 * 生成统一审核失效错误，页面据此返回审核登录而不是使用正式微信身份。
 * @returns {Error} 带固定业务代码的明确提示，不附带令牌或账号。
 */
function reviewExpired() {
  // 过期与访问窗口关闭都要求人工重新登录，禁止自动降级或猜测审核身份。
  return Object.assign(new Error('审核登录已过期或访问未开放，请重新登录审核账号'), {
    code: 'REVIEW_SESSION_EXPIRED',
  });
}

/**
 * 使用明确输入的审核账号换取隔离会话，成功前保持当前模式不变。
 * @param {object} credentials 账号username与口令password，仅此请求发送，不持久化。
 * @returns {Promise<object>} 审核会话已启用标记，不向页面返回原始令牌。
 * @throws {Error} 输入非法、账号拒绝、访问窗口过期、网络错误或登录已取消。
 */
async function loginReview(credentials) {
  const username = credentials && credentials.username;
  const password = credentials && credentials.password;
  // 只有显式表单的短文本可发往登录入口，页面query和旧正式token不能授权审核模式。
  if (
    typeof username !== 'string' ||
    !username.trim() ||
    username.length > 128 ||
    typeof password !== 'string' ||
    !password ||
    password.length > 256
  )
    throw new Error('请填写审核账号和口令');
  // 旧云函数没有审核账号合同，不能将输入凭据交给普通微信登录入口尝试。
  if (!config.cloudRunEnvId && !config.apiBaseUrl) throw new Error('审核服务尚未配置');
  // 登录序号允许页面取消在途请求，取消后的成功响应也不能恢复审核身份。
  const attempt = ++reviewLoginAttempt;
  // 捕获原上下文，慢登录不能挤掉等待期间另一次成功切换后的新身份。
  const prior = activeSession;
  const next = createSession(true);
  // 独立传输器只发送一次账号口令，不附加正式或此前审核会话的Authorization。
  // 用户名仅对提交副本去首尾空格，口令保留用户准确输入的空格以免改变凭据。
  const response = await sessionTransport(next)(
    '/api/login',
    { username: username.trim(), password },
    ''
  );
  if (attempt !== reviewLoginAttempt || prior !== activeSession)
    throw new Error('审核登录已取消，请重新登录');
  // 访问窗口关闭属于服务门禁，不能把它误当作账号错误后继续启用身份。
  if (response.statusCode === 403) throw reviewExpired();
  // 只有标准成功载荷中的非空令牌可信，页面参数或异常响应都不能指定审核身份。
  if (
    response.statusCode !== 200 ||
    !response.data ||
    !response.data.ok ||
    !response.data.data ||
    typeof response.data.data.token !== 'string' ||
    !response.data.data.token
  )
    throw new Error('审核账号或口令不正确，请重新输入');
  // 服务器明确确认成功后才启用审核身份，输入错误不修改正式家庭的权限或资料。
  next.token = response.data.data.token;
  replaceSession(next);
  // UI只需知道成功，原始令牌留在模块内存，不进入页面data或导航参数。
  return { review: true };
}

/**
 * 退出审核并撤销未完成的审核登录，回到需要真实微信登录的普通入口。
 * @returns {void} 令牌及图片缓存清空；不会主动创建正式家庭或恢复任何旧身份。
 */
function exitReview() {
  // 先废弃晚到的账号登录结果，退出后异步响应不能重新启用审核身份。
  reviewLoginAttempt += 1;
  replaceSession(createSession(false));
}

/**
 * 登录页销毁时取消未完成的审核登录，不影响已经成功建立的业务会话。
 * @returns {void} 晚到的审核凭据响应将被拒绝。
 */
function cancelReviewLogin() {
  // 页面卸载不能只清空输入，必须同时阻止旧响应在后台切换身份。
  reviewLoginAttempt += 1;
}

/**
 * 获取当前微信身份的后端会话，并合并并发登录请求。
 * @param {object} session 发起请求时的正式或审核上下文，审核仅使用已有账号令牌。
 * @returns {Promise<string>} 仅在本次小程序进程内复用的服务端会话令牌。
 * @throws {Error} 微信登录或服务端换取会话失败时拒绝，不保存微信会话密钥。
 */
async function login(session = activeSession) {
  assertSession(session);
  if (session.review) {
    // 审核身份绝不借wx.login续期；会话失效时必须回到显式账号口令入口。
    if (!session.token) throw reviewExpired();
    return session.token;
  }
  // 有效会话仅保留内存引用，不把令牌或微信session_key写入本地存储。
  if (session.token) return session.token;
  // 多个页面请求共享一次登录Promise，避免并发使用一次性微信登录凭证。
  if (!session.loginPromise)
    session.loginPromise = (async () => {
      // 会话仅在本次小程序进程内复用，重新启动时重新取得当前微信身份。
      const identity = await new Promise((resolve, reject) =>
        wx.login({ success: resolve, fail: reject })
      );
      if (!identity.code) throw new Error('微信登录暂时不可用');
      // 一次性code只发送给选定的登录入口，不打印到日志或拼接到地址。
      const response = await request('/api/login', { code: identity.code }, '', session);
      assertSession(session);
      if (!response.data || !response.data.ok)
        throw new Error((response.data && response.data.message) || '登录失败，请稍后重试');
      session.token = response.data.data.token;
      // 客户端仅持有业务令牌，微信服务端密钥的处理留在后端身份交换流程。
      return session.token;
    })().finally(() => {
      // 成败都释放进行中标记，失败后可重试而不会永远复用拒绝的Promise。
      session.loginPromise = null;
    });
  return session.loginPromise;
}

/**
 * 调用已配置后端，遇到身份拒绝时仅重登并重试一次。
 * @param {string} action 服务端支持的业务动作，不由传输层替换含义。
 * @param {object} data 当前动作的业务参数，身份来自会话令牌。
 * @param {object} session 当前业务流程捕获的上下文，分片续传不能中途切换。
 * @returns {Promise<*>} 服务端确认成功的业务结果，图片局部失败可降级为空。
 * @throws {Error} 登录、网络或业务拒绝时向页面传播，不自动切换本地体验。
 */
async function callServer(action, data, session = activeSession) {
  // 业务请求先取得同一内存会话，服务端据此确认身份而不信任自报成员ID。
  let response = await request('/api/call', { action, data }, await login(session), session);
  assertSession(session);
  // 角色权限不足也会返回403；只有固定期限门禁才销毁审核会话，不能误踢正常成员。
  const reviewAccessClosed =
    response.statusCode === 403 &&
    response.data &&
    response.data.message === '审核访问未开放或已到期';
  if (session.review && (response.statusCode === 401 || reviewAccessClosed)) {
    // 仅销毁审核上下文并保留审核模式，绝不把无效审核请求重发给正式家庭。
    replaceSession(createSession(true));
    throw reviewExpired();
  }
  if (response.statusCode === 401) {
    // 只有服务端拒绝身份、尚未执行业务时才重登重试，避免重复提交操作。
    session.token = '';
    response = await request('/api/call', { action, data }, await login(session), session);
    assertSession(session);
  }
  if (!response.data || !response.data.ok)
    throw new Error((response.data && response.data.message) || '操作失败，请稍后重试');
  // 只取明确成功的业务数据，失败响应不会被当作空家庭或缓存状态展示。
  const result = response.data.data;
  if (action === 'snapshot' && config.cloudRunEnvId && result.home) {
    // 单张图片失败不阻断家人读取当天事项；其余业务数据仍来自真实后端。
    result.home.babies = await Promise.all(
      result.home.babies.map(async (baby) => {
        // 没有授权头像链接时保持原记录，不为占位头像启动下载。
        if (!baby.avatarUrl) return baby;
        try {
          return { ...baby, avatarUrl: await loadPrivateImage(baby.avatarUrl, session) };
        } catch (_) {
          // 私有头像失效只清空图片，保留真实家庭资料与任务读取结果。
          return { ...baby, avatarUrl: '' };
        }
      })
    );
    // 成员头像与宝宝头像使用同一身份隔离缓存，页面只消费已经授权的本地路径。
    if (Array.isArray(result.home.members))
      result.home.members = await Promise.all(
        result.home.members.map(async (member) => {
          // 未返回授权链接的成员使用占位头像，不构造或猜测私有资源地址。
          if (!member.avatarUrl) return member;
          try {
            return { ...member, avatarUrl: await loadPrivateImage(member.avatarUrl, session) };
          } catch (_) {
            // 单头像不可用只隐藏图片，成员姓名、角色和权限仍保留服务端真实结果。
            return { ...member, avatarUrl: '' };
          }
        })
      );
  }
  // 图片局部降级会捕获下载错误，这里再次阻止旧快照跨身份回填整个页面。
  assertSession(session);
  return result;
}

function loadDemo() {
  let state = wx.getStorageSync(KEY);
  // 示例使用独立存储键，不会与真实家庭数据混在一起。
  if (!state) state = { home: d.createDemo(d.chinaDate(new Date())), days: {} };
  return state;
}

/**
 * 将云托管或自有HTTPS的大图拆成顺序小请求，保持原上传动作的业务结果。
 * @param {string} action 固定白名单内的头像、完成照片或照片墙上传动作。
 * @param {object} data 原上传参数，base64为无前缀完整图片，业务归属按动作白名单保留。
 * @returns {Promise<object>} 全部分片成功后由完成接口返回原fileID或photoId结果。
 * @throws {Error} 大小非法、初始化或任一分片失败时立即停止，不自动重建上传会话。
 */
async function uploadImageChunks(action, data) {
  // 整个上传绑定发起时的上下文，切换审核模式后不向另一套数据续传原uploadId。
  const sessionContext = activeSession;
  const base64 = data.base64;
  const totalParts = Math.ceil(base64.length / UPLOAD_CHUNK_CHARACTERS);
  // Base64按三字节取整，边界上超出一个字节也可能同长，需扣除末尾填充精确计数。
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  const imageBytes = (base64.length / 4) * 3 - padding;
  // 与前后端共享的原图及Base64上限保持一致，异常大图不创建无法完成的会话。
  if (
    base64.length > MAX_BASE64_LENGTH ||
    imageBytes > MAX_IMAGE_BYTES ||
    totalParts > MAX_UPLOAD_PARTS
  )
    throw new Error(`图片过大，请使用${MAX_IMAGE_BYTES / 1024 / 1024}MB以内的图片`);
  const metadata = {};
  // 只转交动作实际需要的归属字段，不能把姓名、凭据或整份表单送入分片元数据。
  // 成员头像只携带目标memberId，实际操作者和管理员权限仍由服务端会话校验。
  for (const field of IMAGE_UPLOAD_FIELDS[action])
    if (data[field] !== undefined) metadata[field] = data[field];
  // 初始化不携带图片正文；每批只创建一次会话，后续失败留给服务端按期限回收。
  const session = await callServer(
    'initImageUpload',
    {
      action,
      metadata,
      totalLength: base64.length,
      totalParts,
    },
    sessionContext
  );
  // 会话标识限定为有界字符串，异常响应不能放大为后续每片重复携带的大请求。
  if (
    !session ||
    typeof session.uploadId !== 'string' ||
    !session.uploadId ||
    session.uploadId.length > 128
  )
    throw new Error('图片上传初始化失败，请重试');
  // 分片序号从0开始，逐片确认后再前进，避免一次选图制造大量并发上传。
  for (let index = 0; index < totalParts; index++) {
    const result = await callServer(
      'appendImageChunk',
      {
        uploadId: session.uploadId,
        index,
        // ASCII Base64按字符切分，每个请求正文远低于实际验证过的100KB边界。
        chunk: base64.slice(index * UPLOAD_CHUNK_CHARACTERS, (index + 1) * UPLOAD_CHUNK_CHARACTERS),
      },
      sessionContext
    );
    // HTTP成功仍需明确接收标记，未接收的块不能继续组装或冒充上传成功。
    if (!result || result.accepted !== true) throw new Error('图片分片上传失败，请重试');
  }
  // 只有全部块确认后才完成组装；不触发事项完成、发布或家人通知等后续业务。
  // 返回的是待关联图片标识，资料保存或照片墙发布仍由原业务入口独立确认。
  return callServer('finishImageUpload', { uploadId: session.uploadId }, sessionContext);
}

/**
 * 在用户明确选择的真实共享或本地体验模式下执行业务动作。
 * @param {string} action 后端或共用业务域支持的动作名称。
 * @param {object} data 动作参数，省略时使用空对象。
 * @returns {Promise<*>} 当前模式的业务结果，真实失败不会返回模拟成功。
 * @throws {Error} 入口未配置、远端拒绝或体验模式禁止的外部动作时抛出。
 */
async function call(action, data = {}) {
  if (!demo) {
    // 白名单内大图上传统一使用小包，未来切换自有HTTPS时不改变业务协议。
    if (
      Object.prototype.hasOwnProperty.call(IMAGE_UPLOAD_FIELDS, action) &&
      typeof data.base64 === 'string' &&
      data.base64.length > UPLOAD_CHUNK_CHARACTERS
    ) {
      // 旧云开发备选入口没有同一分片合同，不能把大图交给旧单包流程后声称支持。
      if (!config.cloudRunEnvId && !config.cloudRunService && !config.apiBaseUrl)
        throw new Error('当前云开发模式暂不支持大图上传，请使用家庭共享服务');
      return uploadImageChunks(action, data);
    }
    // 已配置HTTP或云托管时优先使用实际后端，失败不静默回退旧云开发环境。
    if (config.cloudRunEnvId || config.cloudRunService || config.apiBaseUrl)
      return callServer(action, data);
    if (!config.envId) throw new Error('家庭共享服务尚未准备好，请先使用本地体验');
    // 只有未配置新后端时才使用显式配置的云开发环境，不擅自启用示例家庭。
    const response = await wx.cloud.callFunction({ name: 'family', data: { action, data } });
    if (!response.result || !response.result.ok)
      throw new Error((response.result && response.result.message) || '云端响应异常');
    // 云函数失败明确抛错，成功才返回其业务结果，绝不拼造示例快照。
    return response.result.data;
  }
  // 以下分支必须由用户主动进入体验模式，存储和身份均与真实家庭隔离。
  const state = loadDemo();
  // 本地模拟操作固定以示例家庭管理员执行，不从页面参数接收扮演身份。
  const actorId = state.home.ownerId;
  const today = d.chinaDate(new Date());
  // 体验身份仅表明本机模拟成员，不代表后端确认的微信登录状态。
  if (action === 'bootstrap') return { member: true, actorId };
  if (action === 'snapshot') {
    const date = data.date || today;
    return {
      // 示例快照只从独立本地键读取，不用真实后端失败后的缓存代替。
      home: state.home,
      day: state.days[date] || null,
      actorId,
      date,
      today,
      requests: [],
      // 体验模式永不宣称已有真实消息模板或订阅授权。
      messages: [],
      configured: false,
      subscribed: false,
    };
  }
  // 邀请和订阅涉及真实外部身份或微信发送，体验模式直接拒绝这些动作。
  if (['makeInvite', 'previewInvite', 'subscribe', 'applyInvite'].includes(action))
    throw new Error('本地体验不会发送邀请或微信消息；连接家庭服务后可使用');
  const next = d.transition(
    state.home,
    state.days[today] || null,
    actorId,
    action,
    data,
    new Date().toISOString(),
    () => `local-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  );
  // 仅业务规则转换成功后才整体保存，校验失败不会留下部分示例变更。
  state.home = next.home;
  if (action === 'complete' || action === 'nudge') state.days[today] = next.day;
  // 只有当天执行动作写入日记录；任务编辑通过家庭版本控制历史边界。
  wx.setStorageSync(KEY, state);
  // 体验版只保存催办记录，不把模拟操作说成已发微信。
  return action === 'nudge'
    ? { message: '已记录本地催办；体验版不会发送微信通知', status: 'demo' }
    : next.result;
}
module.exports = {
  call,
  loadPrivateImage,
  loadPrivateImages,
  loginReview,
  exitReview,
  cancelReviewLogin,
  isReviewMode: () => activeSession.review,
  hasReviewSession: () => activeSession.review && !!activeSession.token,
  config,
  setDemo: (value) => {
    // 审核访问不能借体验按钮静默回退为另一身份，必须明确退出审核后再选择。
    if (value && activeSession.review) throw new Error('请先退出审核登录，再进入本地体验');
    demo = value;
  },
  isDemo: () => demo,
};
