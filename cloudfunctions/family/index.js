const cloud = require('wx-server-sdk');
const { runtime } = require('./lib/cloud.cjs');
const d = require('./lib/domain');
const crypto = require('node:crypto');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

/**
 * 上传当天待完成事项照片，可信成员身份始终来自微信上下文。
 * @param {string} openid 云函数当前调用人的微信身份。
 * @param {object} request taskId、当天date与最多1MB的JPEG或PNG原始base64。
 * @param {object} context 业务service、持久repo和hash方法。
 * @returns {Promise<object>} 随机photoId，上传本身不修改完成状态。
 * @throws {Error} 无家庭权限、事项无效、已完成或文件不符合限制。
 */
async function uploadCompletionPhoto(openid, request, { service, repo, hash }) {
  // 会话有效不代表成员仍有效，每次上传重新检查当前家庭成员资格。
  const home = await service.readMember(openid);
  const today = d.chinaDate(new Date().toISOString());
  // 不能通过传入历史日期或其他任务ID给已有执行记录补造照片。
  if (request.date !== today) throw new Error('只能为当天待完成事项上传照片');
  const day = await repo.get('care_days', today);
  // 生效日期、归档和执行周期统一使用领域规则，不能由前端传入的状态代替。
  const row = d.rowsForDate(home, day, today).find((item) => item.id === request.taskId);
  if (!row || row.done) throw new Error('事项不存在或已完成，请刷新后再操作');
  const encoded = request.base64;
  // 在解码之前限制文本长度，防止超大图片造成不必要的内存分配。
  if (typeof encoded !== 'string' || encoded.length > 1400000 || !/^[a-zA-Z0-9+/=]+$/.test(encoded))
    throw new Error('请上传1MB以内JPG或PNG照片');
  const buffer = Buffer.from(encoded, 'base64');
  const jpeg = buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
  const png = buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  // 不信任客户端文件名和size，按解码内容验证格式和实际字节数。
  if ((!jpeg && !png) || buffer.length > 1024 * 1024 || buffer.toString('base64') !== encoded)
    throw new Error('请上传1MB以内JPG或PNG照片');
  // 完成照片用随机业务ID，既不含个人原始文件名，也不含微信身份。
  const filename = `${crypto.randomBytes(16).toString('hex')}.${jpeg ? 'jpg' : 'png'}`;
  const photoId = `photo:${filename}`;
  const uploaded = await cloud.uploadFile({
    cloudPath: `completion/${home.ownerId}/${filename}`,
    fileContent: buffer,
  });
  // 上传和完成分开处理；未关联照片不通过任何家庭快照对外提供短链。
  // 对外ID不依赖云存储厂商，存储ID只用于服务端签发私有临时地址。
  await repo.put('care_files', hash(photoId), {
    kind: 'completion',
    fileID: photoId,
    cloudFileID: uploaded.fileID,
    ownerId: home.ownerId,
    uploadedBy: hash(openid).slice(0, 32),
    taskId: row.id,
    date: today,
  });
  return { photoId };
}

/**
 * 为已通过家庭成员权限的快照填充私有完成照片临时地址。
 * @param {object} snapshot service.snapshot已鉴权的家庭、日期和日记录。
 * @param {object} repo 支持读取照片绑定关系的持久仓库。
 * @param {Function} hash 对photoId计算仓库主键的哈希函数。
 * @returns {Promise<void>} 原位补充photoUrl，保留全部执行历史文本。
 * @throws {Error} 云存储或元数据查询失败。
 */
async function attachCompletionPhotos(snapshot, repo, hash) {
  // 没有日记录表示当天尚未产生执行留档，无需访问存储签名接口。
  if (!snapshot.day) return;
  const files = new Map(),
    targets = [];
  const records = Object.entries(snapshot.day.records || {}).map(([taskId, item]) => ({
    taskId,
    item,
  }));
  // 当前完成记录不受流水窗口影响，保证当天已完成事项的留档可查看。
  const events = snapshot.day.events || [];
  // 历史不截断，只为最近500条流水签发图片地址，限制外部签名调用规模。
  for (const event of events) event.photoUrl = '';
  const candidates = records.concat(
    events.slice(-500).map((item) => ({ taskId: item.taskId, item }))
  );
  for (const { taskId, item } of candidates) {
    item.photoUrl = '';
    // 任意URL和其他存储ID都不能被此入口直接转换成可访问地址。
    if (!/^photo:[a-f0-9]{32}\.(png|jpg)$/.test(item.photoId || '')) continue;
    // 当前记录与多条历史可能引用同一张照片，元数据只读一次且缓存拒绝结果。
    if (!files.has(item.photoId))
      files.set(item.photoId, await repo.get('care_files', hash(item.photoId)));
    const file = files.get(item.photoId);
    // 头像、其他家庭和其他任务日期的文件一律不能借快照获得临时访问权。
    if (
      file &&
      file.kind === 'completion' &&
      file.fileID === item.photoId &&
      file.ownerId === snapshot.home.ownerId &&
      file.taskId === taskId &&
      file.date === snapshot.date &&
      typeof file.cloudFileID === 'string'
    )
      targets.push({ item, fileID: file.cloudFileID });
  }
  // 短链只映射到已通过绑定检查的目标，不把完整care_files记录返回给小程序。
  const ids = [...new Set(targets.map((target) => target.fileID))],
    urls = new Map();
  // 去重后只向存储服务请求实际被本次授权快照引用的文件。
  for (let index = 0; index < ids.length; index += 50) {
    // 按50张分批，避免单次接口文件列表过大；同一照片在流水重复出现仅签名一次。
    const result = await cloud.getTempFileURL({
      fileList: ids.slice(index, index + 50).map((fileID) => ({ fileID, maxAge: 600 })),
    });
    for (const file of result.fileList)
      if (file.status === 0) urls.set(file.fileID, file.tempFileURL || '');
  }
  // 单个文件不存在时保持空地址，不用不受控原始URL替代。
  for (const target of targets) target.item.photoUrl = urls.get(target.fileID) || '';
}

/**
 * 从完整日记录按需读取照片，不受快照最近500条图片签名窗口限制。
 * @param {string} openid 微信上下文中的真实调用者身份。
 * @param {object} request photoId、taskId和date，必须对应一条已保存执行记录。
 * @param {object} context 已初始化的service、repo与hash方法。
 * @returns {Promise<object>} 经家庭权限验证的单张照片临时photoUrl。
 * @throws {Error} 无权访问、日期非法、未关联、绑定不匹配或临时地址签发失败。
 */
async function completionPhoto(openid, request, { service, repo, hash }) {
  // 旧链接或旧会话不能绕过最新的成员移除状态，先鉴权再读取任何照片记录。
  const home = await service.readMember(openid);
  const today = d.chinaDate(new Date().toISOString());
  // 与快照使用同一历史日期范围，不能依靠任意日期探测文件。
  if (!d.validDate(request.date) || request.date > today || request.date < home.createdDate)
    throw new Error('请选择家庭创建之后、今天之前的有效日期');
  // 拒绝任意云文件ID和URL，只处理本业务生成的随机照片标识。
  if (
    typeof request.taskId !== 'string' ||
    !/^photo:[a-f0-9]{32}\.(png|jpg)$/.test(request.photoId || '')
  )
    throw new Error('照片参数不正确，请刷新后重试');
  // 执行证据来自服务端日记录，客户端传来的完成状态不参与判断。
  const day = await repo.get('care_days', request.date);
  const record = day && day.records && day.records[request.taskId];
  // 撤销后仍保留原完成流水的照片；未关联的上传文件无法从此处读取。
  const referenced =
    (record && record.photoId === request.photoId) ||
    (day &&
      (day.events || []).some(
        (event) => event.taskId === request.taskId && event.photoId === request.photoId
      ));
  if (!referenced) throw new Error('照片未关联这条执行记录，请刷新后重试');
  // 即使拥有随机标识，也必须同时满足家庭、任务、日期与照片用途的绑定。
  const file = await repo.get('care_files', hash(request.photoId));
  // 除了真实记录引用，还必须验证照片元数据，头像或跨家庭文件不能签名。
  if (
    !file ||
    file.kind !== 'completion' ||
    file.fileID !== request.photoId ||
    file.ownerId !== home.ownerId ||
    file.taskId !== request.taskId ||
    file.date !== request.date ||
    typeof file.cloudFileID !== 'string'
  )
    throw new Error('当前照片暂时无法访问，请刷新后重试');
  // 一次点击只为一张真实引用的私有文件签发短链，不批量加载同日其他照片。
  const result = await cloud.getTempFileURL({
    fileList: [{ fileID: file.cloudFileID, maxAge: 600 }],
  });
  // 存储未返回成功短链时如实提示加载失败，不能用原存储地址代替。
  const photo = result.fileList.find(
    (item) => item.fileID === file.cloudFileID && item.status === 0
  );
  if (!photo || !photo.tempFileURL) throw new Error('照片暂时无法加载，请稍后重试');
  return { photoUrl: photo.tempFileURL };
}

/**
 * 家庭请求入口；身份只取微信上下文，不接受客户端指定OPENID。
 * @param {object} event 小程序发起的白名单操作和业务参数。
 * @returns {Promise<object>} 结构化业务结果；内部异常仅返回通用错误。
 * @throws {Error} 运行时初始化异常会拒绝调用；请求业务异常转换为ok=false响应。
 */
exports.main = async (event) => {
  // 耗时使用云端时钟，不能让调用方伪造操作时间影响审计。
  const started = Date.now();
  // 身份只来自微信运行时；event中的openid、角色或家庭标记均不能授权。
  const openid = cloud.getWXContext().OPENID;
  const action = (event && event.action) || '';
  // 同一次调用复用业务仓库和规则，避免上传和完成对家庭绑定采用不同来源。
  const { service, repo, hash } = runtime(cloud);
  try {
    let data;
    if (action === 'uploadAvatar') {
      // 修改宝宝头像要求当前有效管理员，已离家成员保留旧身份也不能操作。
      const home = await service.readMember(openid);
      if (home.ownerId !== hash(openid).slice(0, 32))
        throw new Error('仅家庭管理员可以修改宝宝头像');
      // 先限制正文长度及字符集，再解码图片，控制上传的内存占用。
      const encoded = String((event.data && event.data.base64) || '');
      if (encoded.length > 1400000 || !/^[a-zA-Z0-9+/=]+$/.test(encoded))
        throw new Error('图片过大或格式不正确，请选1MB以内图片');
      // 文件头和真实字节数由云端判断，不能相信相册扩展名和前端size。
      const buffer = Buffer.from(encoded, 'base64');
      const jpeg = buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
      const png = buffer.slice(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      if ((!jpeg && !png) || buffer.length > 1024 * 1024)
        throw new Error('请使用1MB以内的JPG或PNG图片');
      // 通过服务端上传到私有存储；不开放客户端任意文件写入权限。
      const uploaded = await cloud.uploadFile({
        cloudPath: `avatars/${home.ownerId}/${require('node:crypto').randomBytes(16).toString('hex')}.${jpeg ? 'jpg' : 'png'}`,
        fileContent: buffer,
      });
      // 头像文件登记家庭所有权后才能被保存宝宝资料的事务引用。
      await repo.put('care_files', hash(uploaded.fileID), {
        ownerId: home.ownerId,
        fileID: uploaded.fileID,
      });
      // 对外只给业务引用和结果说明，不返回私有文件内容或上传凭据。
      data = { fileID: uploaded.fileID, message: '头像已上传' };
    } else if (action === 'uploadCompletionPhoto') {
      // 上传只保存待关联照片，绝不在选图成功时提前打勾事项。
      data = await uploadCompletionPhoto(openid, event.data || {}, { service, repo, hash });
    } else if (action === 'completionPhoto') {
      // 按需查看会重新检查真实执行引用，可覆盖快照签名窗口之前的旧流水。
      data = await completionPhoto(openid, event.data || {}, { service, repo, hash });
    } else {
      // 其余操作由统一业务白名单和事务处理，不将未知动作映射为数据库命令。
      data = await service.call(openid, action, event.data || {});
      if (action === 'snapshot') {
        // 此时service已经验证成员权限，外人不能借头像列表探测存储文件。
        const ids = data.home.babies.map((b) => b.avatar).filter(Boolean);
        // 临时地址只在通过家庭权限检查后签发，存储保持私有。
        if (ids.length) {
          const files = await cloud.getTempFileURL({
            fileList: ids.map((fileID) => ({ fileID, maxAge: 600 })),
          });
          data.home.babies = data.home.babies.map((b) => ({
            ...b,
            avatarUrl:
              (files.fileList.find((f) => f.fileID === b.avatar && f.status === 0) || {})
                .tempFileURL || '',
          }));
        }
        // 完成照片还需逐项校验家庭、任务和日期绑定，不能直接把photoId当云文件ID。
        await attachCompletionPhotos(data, repo, hash);
      }
    }
    // 所有上传或签名步骤结束后才报告成功，内部失败不返回空的成功结果。
    console.info('家庭操作完成', { action, elapsedMs: Date.now() - started });
    return { ok: true, data };
  } catch (error) {
    // 日志记录操作和错误码，不打印微信身份、邀请token或图片内容。
    console.error('家庭操作失败', {
      action,
      code: error.errCode || error.code || 'BUSINESS',
      elapsedMs: Date.now() - started,
    });
    const internal =
      error.errCode ||
      error.code ||
      /database|cloud\.|collection|transaction|env/i.test(error.message || '');
    // 平台和数据库错误正文可能含环境配置，产品只展示通用可重试说明。
    return {
      ok: false,
      message: internal
        ? '云端暂时不可用，请检查部署配置后重试'
        : error.message || '操作失败，请稍后重试',
    };
  }
};
