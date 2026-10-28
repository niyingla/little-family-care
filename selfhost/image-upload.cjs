const d = require('../server/domain');
const {
  MAX_BASE64_LENGTH: MAX_LENGTH,
  UPLOAD_CHUNK_CHARACTERS: CHUNK_SIZE,
  MAX_UPLOAD_PARTS: MAX_PARTS,
} = require('../server/media-policy');
const MAX_ACTIVE = 4;
const TTL_MS = 10 * 60000;
const ID = /^[a-f0-9]{32}$/;
const META_KEYS = {
  uploadAvatar: [],
  uploadCompletionPhoto: ['taskId', 'date'],
  uploadWallPhoto: ['scope', 'babyId'],
};
const check = (valid, message) => {
  if (!valid) throw new Error(message);
};

/**
 * 提取各图片入口允许的业务定位参数，禁止身份和文件标识透传。
 * @param {string} action 原始上传动作，只允许头像、完成照和照片墙。
 * @param {object} input 明确业务metadata，不能含base64、fileID、角色或其他字段。
 * @returns {object} 独立的白名单定位参数，最终仍由原上传入口验证业务归属。
 * @throws {Error} 动作不支持、字段越界或定位参数类型不合法。
 */
function metadataFor(action, input = {}) {
  // 原始动作不可由任意方法名派发，尤其不能把分片上传当成业务RPC代理。
  check(Object.hasOwn(META_KEYS, action), '图片上传动作不支持');
  check(input && typeof input === 'object' && !Array.isArray(input), '图片定位参数不正确');
  const allowed = META_KEYS[action];
  // 未知字段直接拒绝而不是转发，上传者、家庭、fileID只能由服务端赋值。
  check(
    Object.keys(input).every((key) => allowed.includes(key)),
    '图片定位参数含非法字段'
  );
  const result = {};
  // 定位字段仅接受短字符串，不能藏入图片正文、对象或数组。
  for (const key of allowed) {
    if (input[key] === undefined) continue;
    check(typeof input[key] === 'string' && input[key].length <= 128, '图片定位参数类型不正确');
    result[key] = input[key];
  }
  // 完成照只接受任务及真实公历日，业务当天/待办校验保留在原入口。
  if (action === 'uploadCompletionPhoto')
    check(result.taskId && d.validDate(result.date), '完成照片定位参数不正确');
  if (action === 'uploadWallPhoto') {
    // 这里只检查范围形状，真实宝宝归属仍由原照片墙入口核对。
    check(
      result.scope === undefined || ['family', 'baby'].includes(result.scope),
      '照片范围参数不正确'
    );
    // 家庭不伪造宝宝ID；旧的只有babyId参数继续按宝宝兼容。
    check(result.scope === 'family' ? !result.babyId : !!result.babyId, '照片所属资料不正确');
  }
  return result;
}

/**
 * 创建受限分片会话，最终图片内容交回已有上传入口校验和持久化。
 * @param {object} repo 支持get/put/transaction的持久仓库，不需要DELETE权限。
 * @param {object} options readMember、hash、randomId、now及upload(action,openid,data)回调。
 * @returns {object} 仅公开call分发初始化、追加分片和完成上传三个动作。
 */
function createImageUpload(repo, { readMember, hash, randomId, now, upload }) {
  // 所有身份字段取自真实会话派生ID，不接受正文里的上传者或家庭ID。
  const uid = (openid) => hash(openid).slice(0, 32);
  const clock = () => new Date(now()).getTime();
  /**
   * 在事务中重新确认当前家人和会话归属。
   * @param {object} tx 当前事务仓库。
   * @param {object} auth 请求开始时的可信家庭及成员ID。
   * @param {string} uploadId 服务端随机上传会话编号。
   * @returns {Promise<object>} 只属于当前家庭和上传者的会话，done允许幂等读取结果。
   * @throws {Error} 已离家、跨家庭、跨上传者、会话不存在或尚未完成就已过期。
   */
  async function ownedSession(tx, auth, uploadId) {
    // 随机会话编号不是访问凭据，但需先限制格式避免任意仓库键探测。
    check(typeof uploadId === 'string' && ID.test(uploadId), '图片上传会话参数不正确');
    const home = await tx.get('care_home', 'home');
    // 写锁内重新读当前成员，旧登录状态不能绕过刚发生的移除或家庭变更。
    d.assertMember(home, auth.actorId);
    const session = await tx.get('care_uploads', uploadId);
    // 同一家人也不能替另一成员补片或读取结果，上传者与家庭必须同时吻合。
    check(
      session &&
        session.ownerId === home.ownerId &&
        home.ownerId === auth.home.ownerId &&
        session.uploadedBy === auth.actorId,
      '无权访问图片上传会话'
    );
    // 成功会话已无原始分片，过期后同人仍可安全取回原结果而无需重建文件。
    check(
      session.status === 'done' || session.expiresAt > clock(),
      '图片上传会话已过期，请重新选择照片'
    );
    return session;
  }
  /**
   * 清空一份会话的原始分片内容，保留轻量墓碑而不申请数据库DELETE权限。
   * @param {object} tx 当前状态提交事务。
   * @param {object} session 已验证且总分片数受共享图片上限限制的会话。
   * @returns {Promise<void>} 所有分片内容为空，后续finish仅可取已存结果。
   */
  async function eraseParts(tx, session) {
    // 成功、失败和过期都不继续持久保留原始base64，业务图片由原存储入口独立持有。
    for (let index = 0; index < session.totalParts; index++)
      await tx.put('care_upload_parts', `${session.id}:${index}`, { chunk: '', cleared: true });
  }
  /**
   * 初始化十分钟上传会话，并在同一事务限制每人最多四个活动会话。
   * @param {string} openid 真实微信身份。
   * @param {object} data 原动作、白名单metadata、严格整数totalLength和totalParts。
   * @returns {Promise<object>} 随机uploadId，原始业务文件尚未创建。
   * @throws {Error} 长度/数量不符、非管理员上传头像、成员无权或活动会话过多。
   */
  async function initImageUpload(openid, data) {
    // 初始化只创建临时会话，不能沿用上一次请求已通过的成员资格。
    const home = await readMember(openid),
      actorId = uid(openid);
    const { totalLength, totalParts } = data;
    // 总长按ASCII编码字符计数，不能把解码后文件字节数当成base64长度。
    // base64总长必须是四的倍数，数量必须精确对应固定块长，不能虚报预留空间。
    check(
      Number.isInteger(totalLength) &&
        totalLength > 0 &&
        totalLength <= MAX_LENGTH &&
        totalLength % 4 === 0,
      '图片总长度不正确'
    );
    check(
      Number.isInteger(totalParts) &&
        totalParts >= 1 &&
        totalParts <= MAX_PARTS &&
        totalParts === Math.ceil(totalLength / CHUNK_SIZE),
      '图片分片数量不正确'
    );
    // 先校验定位白名单再占额度，恶意参数不能获得可继续上传的会话。
    const metadata = metadataFor(data.action, data.metadata);
    // 头像能力只属于真正管理员；完成照和墙照片最终还会重新核对业务绑定。
    if (data.action === 'uploadAvatar') check(home.ownerId === actorId, '仅管理员可上传宝宝头像');
    // 单成员索引文档原子控制额度，不依赖事务适配器未提供的list方法。
    return repo.transaction(async (tx) => {
      const current = await tx.get('care_home', 'home');
      // 限额与当前成员身份共用事务边界，多个初始化请求不能同时越过四会话上限。
      d.assertMember(current, actorId);
      check(current.ownerId === home.ownerId, '无权访问这个家庭');
      if (data.action === 'uploadAvatar')
        check(current.ownerId === actorId, '仅管理员可上传宝宝头像');
      // 只读取该成员先前登记的少量会话，不扫描其他成员或整张图片表。
      const limits = await tx.get('care_upload_limits', actorId),
        active = [];
      for (const id of (limits && limits.sessionIds) || []) {
        const prior = await tx.get('care_uploads', id);
        // 已完成和失败会话释放名额，幂等finish仍可通过原会话取回结果。
        if (!prior || ['done', 'failed', 'expired'].includes(prior.status)) continue;
        // 仍在执行原上传入口的finishing也占额度，防止利用并发完成突破限额。
        if (prior.expiresAt > clock()) active.push(id);
        else {
          // 过期释放名额时一并清内容，避免反复建立会话让未完成的图片长期积累。
          await eraseParts(tx, prior);
          await tx.put('care_uploads', id, { ...prior, status: 'expired' });
        }
      }
      check(active.length < MAX_ACTIVE, '同时上传的照片过多，请完成当前上传或十分钟后重试');
      const id = randomId();
      // 编号不含照片或个人信息，每次使用仍须重新检查上传者身份。
      // 会话归属和期限均由服务器指定；metadata不会夹带身份证明或已有文件ID。
      await tx.put('care_uploads', id, {
        id,
        action: data.action,
        metadata,
        totalLength,
        totalParts,
        uploadedBy: actorId,
        ownerId: current.ownerId,
        createdAt: now(),
        expiresAt: clock() + TTL_MS,
        status: 'pending',
      });
      // 会话与限额索引一起提交，不能出现游离于并发计数之外的活动记录。
      await tx.put('care_upload_limits', actorId, { sessionIds: [...active, id] });
      return { uploadId: id };
    });
  }
  /**
   * 保存一个固定索引分片，支持乱序与相同内容重试。
   * @param {string} openid 真实微信身份，每个分片都重新检查成员资格。
   * @param {object} data uploadId、整数index及最多65536个ASCII base64字符chunk。
   * @returns {Promise<object>} 持久化成功后的accepted:true，冲突不覆盖旧内容。
   * @throws {Error} 他人会话、过期、状态非pending、分片越界、大小或编码不正确。
   */
  async function appendImageChunk(openid, data) {
    // 每片是独立HTTP请求，初始化曾通过授权不代表成员之后一直有效。
    const auth = { home: await readMember(openid), actorId: uid(openid) };
    return repo.transaction(async (tx) => {
      const session = await ownedSession(tx, auth, data.uploadId);
      // 处理中或已结束不能再写内容，否则可能改动已经开始拼装的文件。
      check(session.status === 'pending', '图片分片已结束或正在处理中，请重新上传');
      const { index, chunk } = data;
      // 索引范围先校验，不能用负数、小数或额外块给会话无限扩容。
      check(
        Number.isInteger(index) && index >= 0 && index < session.totalParts,
        '图片分片索引不正确'
      );
      const tail = index === session.totalParts - 1;
      // 尾片也必须等于声明总长的余数，不能缩短内容或增加隐藏的额外字节。
      const expected = tail ? session.totalLength - index * CHUNK_SIZE : CHUNK_SIZE;
      // 限制ASCII字符后，单片字符上限才能可靠约束网关收到的实际字节数。
      check(
        typeof chunk === 'string' &&
          chunk.length === expected &&
          chunk.length <= CHUNK_SIZE &&
          (tail ? /^[A-Za-z0-9+/]+={0,2}$/ : /^[A-Za-z0-9+/]+$/).test(chunk),
        '图片分片长度或编码不正确'
      );
      const key = `${session.id}:${index}`,
        prior = await tx.get('care_upload_parts', key);
      // 同一索引的不同内容必须拒绝，不能让网络重试悄悄改变已经接收的图片。
      check(!prior || prior.chunk === chunk, '图片分片内容冲突，请重新上传');
      if (!prior) await tx.put('care_upload_parts', key, { chunk });
      // 返回值在事务提交后才交给HTTP层，数据库写入拒绝不能被包装成accepted。
      return { accepted: true };
    });
  }
  /**
   * 抢占完成权、拼装所有分片，再复用原上传入口一次性验证和存储图片。
   * @param {string} openid 真实微信身份，不能代他人完成或读取其结果。
   * @param {object} data 仅需uploadId，原动作与metadata从可信会话记录恢复。
   * @returns {Promise<object>} 原上传结果；done重试返回同一结果，不重复创建文件。
   * @throws {Error} 缺块、正在处理、已失败、内容校验不符或原上传入口拒绝。
   */
  async function finishImageUpload(openid, data) {
    // 幂等查询的结果也属于私有资料，必须重新验证当前有效家人身份。
    const auth = { home: await readMember(openid), actorId: uid(openid) };
    const claim = await repo.transaction(async (tx) => {
      // 抢占与完整性检查共用事务锁，相同会话只有一次执行原文件副作用的机会。
      const session = await ownedSession(tx, auth, data.uploadId);
      if (session.status === 'done') return { done: true, result: session.result };
      // 处理中表示结果尚未确定，不能自动当成失败并重试创建同一文件。
      check(session.status !== 'finishing', '图片正在处理中，结果待确认，请勿重复提交');
      check(session.status === 'pending', '图片上传已失败，请重新选择照片上传');
      // 抢占状态与完整性检查在一个事务内，缺块回滚为pending且不执行文件副作用。
      await tx.put('care_uploads', session.id, { ...session, status: 'finishing' });
      const chunks = [];
      // 按固定索引读取，网络乱序抵达不影响图片顺序，缺少任意一片则事务回滚。
      for (let index = 0; index < session.totalParts; index++) {
        const part = await tx.get('care_upload_parts', `${session.id}:${index}`);
        check(
          part && typeof part.chunk === 'string' && part.chunk.length > 0,
          '图片缺少完整分片，请继续上传'
        );
        chunks.push(part.chunk);
      }
      // 拼装范围只含会话声明的有限块数，不能借其他索引扩大内存分配。
      const base64 = chunks.join('');
      // 整串回转验证最终编码，逐块合法也不能造成尾部填充或总长伪造。
      check(
        base64.length === session.totalLength &&
          Buffer.from(base64, 'base64').toString('base64') === base64,
        '图片分片内容不完整或编码不正确'
      );
      return { session, base64 };
    });
    // 已完成直接返回缓存结果，不再次访问原上传入口或输出一次新的完成日志。
    if (claim.done) return claim.result;
    try {
      // 外部上传副作用在抢占事务提交后执行，finishing并发请求不会再创建第二个文件。
      const result = await upload(claim.session.action, openid, {
        ...claim.session.metadata,
        base64: claim.base64,
      });
      await repo.transaction(async (tx) => {
        // 原上传入口真实返回后才能记done，不能提前保存一个表面成功结果。
        const session = await tx.get('care_uploads', data.uploadId);
        check(session && session.status === 'finishing', '图片上传状态已变化，请重新检查');
        // 先保存可重试读取的原结果，再在同一事务清空所有临时图片内容。
        await tx.put('care_uploads', session.id, {
          ...session,
          status: 'done',
          result,
          finishedAt: now(),
        });
        // 结果缓存与清空临时正文一起提交，后续重试不再需要原始图片分片。
        await eraseParts(tx, session);
      });
      // 只记随机会话、固定动作和数量，不记录图片编码、定位文字或微信身份。
      console.info('分片图片上传完成', {
        uploadId: data.uploadId,
        action: claim.session.action,
        parts: claim.session.totalParts,
      });
      return result;
    } catch (error) {
      // 结果失败不重试原文件副作用；标记failed后只能建立新会话，避免同会话重复建文件。
      // 清理异常只能保留待确认状态，不能为掩盖数据库问题再次执行原上传入口。
      await repo
        .transaction(async (tx) => {
          // 仅收尾仍由本次完成请求抢占的状态，不覆盖已经成功提交的结果。
          const session = await tx.get('care_uploads', data.uploadId);
          if (session && session.status === 'finishing') {
            // 错误对象可能带数据库细节，因此失败记录不保存异常正文。
            await tx.put('care_uploads', session.id, {
              ...session,
              status: 'failed',
              finishedAt: now(),
            });
            // failed不再接收新片，清正文后只能新建会话重新上传。
            await eraseParts(tx, session);
          }
        })
        .catch(() => console.warn('图片上传失败状态暂未保存，请稍后重试'));
      throw error;
    }
  }
  /**
   * 分发三种受限分片动作，原上传动作仅能从已验证会话恢复。
   * @param {string} openid HTTP会话提供的真实身份。
   * @param {string} action initImageUpload、appendImageChunk或finishImageUpload。
   * @param {object} data 对应请求参数，原图片内容禁止写入日志。
   * @returns {Promise<object>} 持久化结果，原始业务失败照常抛出。
   */
  async function call(openid, action, data = {}) {
    const actions = { initImageUpload, appendImageChunk, finishImageUpload };
    // 自身白名单属性阻止原型方法或任意业务入口借用上传分发执行。
    check(Object.hasOwn(actions, action), '不支持的图片分片操作');
    return actions[action](openid, data);
  }
  // 外部只能使用受限分发器，不能绕过会话状态机直接执行内部完成副作用。
  return { call };
}

module.exports = { createImageUpload };
