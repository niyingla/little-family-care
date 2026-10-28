const d = require('./domain');
const { MAX_IMAGE_BYTES, MAX_BASE64_LENGTH } = require('./media-policy');
const { createActivityRecorder } = require('./activity.cjs');
const AVATAR_ID = /^avatar:[a-f0-9]{32}\.(png|jpg)$/;

/**
 * 从规范图片编码取出有界原始字节及受信后缀。
 * @param {string} encoded 不带data前缀的Base64，最多对应10MiB原图。
 * @returns {object} buffer为完整图片字节，extension只可能为jpg或png。
 * @throws {Error} 编码、大小或文件头不合法时拒绝解码结果。
 */
function decodeAvatar(encoded) {
  // 先限制编码字符再分配内存，伪造size和文件名都不能扩大真实上限。
  if (
    typeof encoded !== 'string' ||
    encoded.length > MAX_BASE64_LENGTH ||
    !/^[a-zA-Z0-9+/=]+$/.test(encoded)
  )
    throw new Error('请上传10MB以内JPG或PNG头像');
  const buffer = Buffer.from(encoded, 'base64');
  // JPEG前三字节与PNG八字节签名各自验证，不能把非图像文本当成头像。
  const jpeg = buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
  const png = buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  // Base64同长也可能多一个原图字节，真实大小和规范回转必须同时满足。
  if ((!jpeg && !png) || buffer.length > MAX_IMAGE_BYTES || buffer.toString('base64') !== encoded)
    throw new Error('请上传10MB以内JPG或PNG头像');
  // 后缀由已验证类型决定，不沿用相册文件名或调用方扩展名。
  return { buffer, extension: jpeg ? 'jpg' : 'png' };
}

/**
 * 确认操作者可修改目标家人，家庭称呼和角色文字不参与权限判断。
 * @param {object} home 当前事务读取的家庭，成员必须仍有效。
 * @param {string} actorId 已认证会话派生的成员ID。
 * @param {string} memberId 本次头像所属的有效成员ID。
 * @returns {object} 当前家庭中与memberId匹配的有效成员。
 * @throws {Error} 非有效家人、目标不存在或普通家人修改他人时拒绝。
 */
function assertMemberAvatarTarget(home, actorId, memberId) {
  // 每次修改都重新验证实际家人资格，旧会话不能绕过移除操作。
  d.assertMember(home, actorId);
  const target = home.members.find((member) => member.id === memberId && member.active);
  if (!target) throw new Error('目标家人不存在或已离开家庭');
  // 管理员取受信ownerId，昵称或关系写成管理员也不会增加权限。
  if (home.ownerId !== actorId && memberId !== actorId)
    throw new Error('只能修改本人头像，管理员可修改其他家人');
  return target;
}

/**
 * 创建家人头像上传、绑定与授权快照能力，不改变宝宝头像权限。
 * @param {object} repo 持久化仓库，事务get/put必须使用同一家庭锁。
 * @param {object} options 私有avatars、readMember、hash、randomId、now和avatarUrl依赖。
 * @returns {object} upload生成待绑定文件，save提交头像，attach为有效绑定签短链。
 */
function createMemberAvatars(repo, { avatars, readMember, hash, randomId, now, avatarUrl }) {
  // 文件内容和成员更新分开：选图上传成功不能提前替换用户现有头像。
  const actor = (openid) => hash(openid).slice(0, 32);
  const activity = createActivityRecorder({ repo, now, randomId });

  /**
   * 记录保存头像的固定业务结果，不把图片标识或异常正文写入行为库。
   * @param {string} actorId 可信会话派生的内部家人ID。
   * @param {string} outcome 内部固定success或failure结果。
   * @param {number} started 服务端本次操作开始的毫秒时间。
   * @returns {Promise<boolean>} 记录器实际写入结果，失败不影响已提交的头像。
   */
  function recordSave(actorId, outcome, started) {
    // 名称与来源完全由服务端指定，用户不能把资料文本写入日志字段。
    return activity.record({
      actorId,
      kind: 'business',
      name: 'setMemberAvatar',
      source: 'server',
      outcome,
      // 耗时只反映服务端处理，记录器会规范为有限非负整数。
      durationMs: Date.now() - started,
    });
  }

  /**
   * 验证用户主动选择的图片，生成仅用于指定家人的私有头像文件。
   * @param {string} openid 服务端登录会话提供的真实身份。
   * @param {object} data memberId与规范base64，真实文件最大10MiB，仅JPEG或PNG。
   * @returns {Promise<object>} 随机fileID，未绑定前不提供可查看短链。
   * @throws {Error} 权限、目标、格式或存储校验失败时保留原头像。
   */
  async function upload(openid, data = {}) {
    const home = await readMember(openid),
      actorId = actor(openid);
    // 在分配图片内存或写文件前拒绝普通家人修改他人的请求。
    assertMemberAvatarTarget(home, actorId, data.memberId);
    // 解码校验独立完成，上传入口只负责编排权限、持久化和登记流程。
    const { buffer, extension } = decodeAvatar(data.base64);
    const filename = `${randomId()}.${extension}`,
      fileID = `avatar:${filename}`;
    // 随机文件名只标识存储对象；查看和绑定仍需家庭、目标及上传者三重匹配。
    await avatars.write(filename, buffer);
    await repo.transaction(async (tx) => {
      const current = await tx.get('care_home', 'home');
      // 写入过程中可能刚好被移除，元数据登记前在事务中再次确认权限。
      assertMemberAvatarTarget(current, actorId, data.memberId);
      if (current.ownerId !== home.ownerId) throw new Error('家庭已变更，请重新选择头像');
      await tx.put('care_files', hash(fileID), {
        kind: 'member-avatar',
        fileID,
        ownerId: current.ownerId,
        memberId: data.memberId,
        uploadedBy: actorId,
      });
    });
    // 运维只记录内部目标ID和字节数，原图、微信身份及文件短链均不进入日志。
    console.info('家人头像已上传', { memberId: data.memberId, bytes: buffer.length });
    // 尚未绑定到资料，不在上传响应提前签发可浏览链接。
    return { fileID };
  }

  /**
   * 将本人本次为目标上传的头像原子绑定到家人资料。
   * @param {string} openid 当前认证身份，管理员可修改所有有效家人。
   * @param {object} data memberId与upload返回的avatar:fileID，不接受任意外链或宝宝头像。
   * @returns {Promise<object>} 成功后的目标memberId及文件标识。
   * @throws {Error} 身份失效、文件用途或归属不匹配时事务回滚，原头像不变。
   */
  async function save(openid, data = {}) {
    // 操作者始终从服务端会话派生，不读取表单中的actorId或家庭角色。
    const actorId = actor(openid),
      started = Date.now();
    try {
      const result = await repo.transaction(async (tx) => {
        const home = await tx.get('care_home', 'home');
        // 同一事务核对当前权限与文件绑定，上传时有效不代表保存时仍有权限。
        const target = assertMemberAvatarTarget(home, actorId, data.memberId);
        if (typeof data.avatar !== 'string' || !AVATAR_ID.test(data.avatar))
          throw new Error('家人头像文件不正确');
        const file = await tx.get('care_files', hash(data.avatar));
        // 宝宝头像、其他家人文件、其他上传者及其他家庭文件都不能重新绑定。
        if (
          !file ||
          file.kind !== 'member-avatar' ||
          file.fileID !== data.avatar ||
          file.ownerId !== home.ownerId ||
          file.memberId !== target.id ||
          file.uploadedBy !== actorId
        )
          throw new Error('无权使用这个家人头像');
        target.avatar = file.fileID;
        await tx.put('care_home', 'home', home);
        return { memberId: target.id, avatar: file.fileID };
      });
      // 只在持久化提交后记录成功，日志写入失败由记录器自行降级，不反转业务结果。
      await recordSave(actorId, 'success', started);
      return result;
    } catch (error) {
      // 失败日志不保存异常正文，拒绝的文件和头像内容不会被回显或写入行为记录。
      await recordSave(actorId, 'failure', started);
      throw error;
    }
  }

  /**
   * 在已授权家庭快照上补充仍有效且用途吻合的家人头像短链。
   * @param {object} home readMember后取得的本家庭快照，不得用于匿名访问。
   * @returns {Promise<void>} 原位设置avatarUrl，未知或失效文件统一为空。
   * @throws {Error} 仓库故障向请求边界传播，不签发未经核实的地址。
   */
  async function attach(home) {
    for (const member of home.members) {
      // 快照默认撤下上一轮地址，验证失败不能复用旧页面中的头像签名。
      member.avatarUrl = '';
      // 已移除家人或旧记录没有照片时不查询文件，也不暴露可访问链接。
      if (!member.active || !AVATAR_ID.test(member.avatar || '')) continue;
      // 相同文件若被错误填给另一位家人，仍逐个验证目标而非按文件ID共享授权。
      const file = await repo.get('care_files', hash(member.avatar));
      // 即使家庭JSON被旧版本写入了任意头像，签名入口仍独立验证实际用途及目标。
      if (
        file &&
        file.kind === 'member-avatar' &&
        file.fileID === member.avatar &&
        file.ownerId === home.ownerId &&
        file.memberId === member.id
      )
        member.avatarUrl = avatarUrl(member.avatar.slice(7));
    }
  }
  return { upload, save, attach };
}

module.exports = { createMemberAvatars, assertMemberAvatarTarget };
