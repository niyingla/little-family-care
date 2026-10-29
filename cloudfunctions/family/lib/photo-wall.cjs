const crypto = require('node:crypto');
const d = require('./domain');
const { createActivityRecorder } = require('./activity.cjs');
const { MAX_IMAGE_BYTES, MAX_BASE64_LENGTH } = require('./media-policy');
const PHOTO_ID = /^photo:[a-f0-9]{32}\.(png|jpg)$/;
const POST_ID = /^[a-f0-9]{32}$/;
const MAX_PHOTOS = 9;
const MAX_PAGE = 20;
const MAX_SCAN = 200;
const hashFile = (value) => crypto.createHash('sha256').update(value).digest('hex');
const check = (condition, message) => {
  if (!condition) throw new Error(message);
};

/**
 * 在调用方事务中追加不可变的照片墙节点，与头指针一起提交。
 * @param {object} tx 已开启事务的get/put仓库。
 * @param {object} post 已验证身份及照片归属的完整帖子，不含短链。
 * @returns {Promise<object>} 新节点或同一完成事件此前写入的节点。
 * @throws {Error} 同ID不同事件、家庭不匹配或存储提交失败。
 */
async function appendPost(tx, post) {
  // 完成事务重试复用事件ID；幂等返回不会复活已经被作者软删的帖子。
  const existing = await tx.get('care_photo_posts', post.id);
  if (existing) {
    // 普通发布遇到随机ID碰撞必须失败，不能把另一篇动态当成本次发布成功。
    check(
      post.source === 'completion' &&
        existing.source === 'completion' &&
        // 同一事件重试仍须属于同一家庭和作者，不能仅凭相同事件ID认定相同业务。
        existing.ownerId === post.ownerId &&
        existing.authorId === post.authorId &&
        existing.babyId === post.babyId &&
        existing.taskId === post.taskId &&
        // 完成日期及照片集合也属于幂等内容，重复ID不得悄悄指向不同照片。
        existing.date === post.date &&
        JSON.stringify(existing.photoIds) === JSON.stringify(post.photoIds),
      '照片记录编号冲突'
    );
    return existing;
  }
  // 单家庭头指针也携带家庭归属，迁移或异常数据不能跨家庭串联。
  const feed = await tx.get('care_photo_feed', 'home');
  check(!feed || feed.ownerId === post.ownerId, '无权访问这份照片历史');
  const node = { ...post, previousId: (feed && feed.head) || '', deletedAt: '' };
  // 指针与帖子必须同事务写入，多个副本并发发布时才能保留每一篇历史。
  await tx.put('care_photo_posts', node.id, node);
  await tx.put('care_photo_feed', 'home', { ownerId: post.ownerId, head: node.id });
  return node;
}

/**
 * 将宝宝事项的真实完成照片写进同一照片墙，不对外提供HTTP写入入口。
 * @param {object} tx complete业务事务，任何校验失败都应随完成记录一起回滚。
 * @param {object} input 受信home、actorId/Name、taskId、babyId、date、photoId、eventId及at。
 * @returns {Promise<object>} 与完成事件ID一致的照片墙节点；重复调用不会重复入墙。
 * @throws {Error} 非有效家人、宝宝不存在、照片用途或任务日期归属不符。
 */
async function addCompletion(tx, input) {
  // 输入由完成事务提供，HTTP普通发布无法指定本次事件及执行时间。
  const { home, actorId, actorName, taskId, babyId, date, photoId, eventId, at } = input;
  // 身份和宝宝归属仍重新确认，家庭事项不能借一个空babyId进入宝宝照片墙。
  d.assertMember(home, actorId);
  const baby = home.babies.find((item) => item.id === babyId);
  check(baby && POST_ID.test(eventId) && PHOTO_ID.test(photoId), '完成照片参数不正确');
  // 读取登记元数据而非图片本体，校验失败由外层事务整体回滚。
  const file = await tx.get('care_files', hashFile(photoId));
  // 完成照只能由内部事务接入，普通发布接口没有提升文件kind的能力。
  check(
    file &&
      file.kind === 'completion' &&
      file.fileID === photoId &&
      // 上传者必须就是本次完成人，不能将另一位家人尚未提交的照片拿来完成。
      file.ownerId === home.ownerId &&
      file.uploadedBy === actorId &&
      file.taskId === taskId &&
      file.date === date,
    '完成照片归属不正确'
  );
  // 保存当时的发布者称呼和宝宝主体，删除墙帖不修改care_days里的执行证据。
  return appendPost(tx, {
    id: eventId,
    ownerId: home.ownerId,
    authorId: actorId,
    // 称呼保存为当时快照，后来修改个人称呼不会篡改这条完成动态的署名。
    authorName: actorName,
    babyId,
    babyName: baby.name,
    scope: 'baby',
    source: 'completion',
    taskId,
    date,
    text: '完成照护小事，留下这一刻 ♡',
    // 只保存受信文件标识，短链在已授权读取时生成，不写进长期历史。
    photoIds: [photoId],
    createdAt: at,
  });
}

/**
 * 创建授权成员可发布、按宝宝分页浏览的私有照片墙。
 * @param {object} repo 支持get/put/transaction的持久仓库，不要求DELETE权限。
 * @param {object} options readMember、hash、randomId、now、avatars.write及私有photoUrl签名器。
 * @returns {object} HTTP动作分发、四个业务方法及受信完成事务接入方法。
 */
function createPhotoWall(repo, { readMember, hash, randomId, now, avatars, photoUrl }) {
  // 行为审计只保留动作和结果，失败日志由记录器降级，不能反转已提交的发布结果。
  const activity = createActivityRecorder({ repo, now, randomId });
  // 发布只接收随机照片标识，真实身份始终来自会话和当前家庭成员表。
  const actorId = (openid) => hash(openid).slice(0, 32);
  /**
   * 在事务内重读家庭，避免鉴权后被移除的成员仍完成写入。
   * @param {object} tx 当前写事务。
   * @param {object} prior 请求开始时已鉴权的家庭。
   * @param {string} id 可信会话派生的成员ID。
   * @returns {Promise<object>} 当前仍可操作的家庭快照。
   * @throws {Error} 家庭已变更或成员已失去访问权限。
   */
  async function currentHome(tx, prior, id) {
    const home = await tx.get('care_home', 'home');
    // 重新校验成员及家庭，不能只凭请求刚开始时的旧快照授权写入。
    d.assertMember(home, id);
    check(home.ownerId === prior.ownerId, '无权访问这个家庭');
    return home;
  }
  /**
   * 验证当前家庭内的宝宝主体。
   * @param {object} home 已授权的家庭快照。
   * @param {string} id 宝宝ID，不能用all或任意外部ID发布。
   * @returns {object} 家庭内真实存在的宝宝。
   * @throws {Error} 宝宝不存在或没有选择具体宝宝。
   */
  function requireBaby(home, id) {
    // 墙帖必须有具体宝宝归属，“全部宝宝”只允许作为浏览筛选条件。
    const baby = home.babies.find((item) => item.id === id);
    check(baby, '请选择本家庭的一位宝宝');
    return baby;
  }
  /**
   * 将发布主体规范为真实宝宝或独立家庭日常，旧babyId参数按宝宝兼容。
   * @param {object} home 当前授权家庭。
   * @param {object} data scope为family/baby，家庭babyId必须为空。
   * @returns {object} 精确的scope、babyId及展示称呼，不生成虚拟宝宝。
   * @throws {Error} 范围非法、家庭夹带宝宝ID或宝宝不属于当前家庭。
   */
  function requireTarget(home, data) {
    // 旧接口只有babyId时仍是宝宝照片，不把历史数据静默改成家庭照片。
    const scope = data.scope === undefined ? 'baby' : data.scope;
    check(scope === 'family' || scope === 'baby', '照片所属范围不正确');
    if (scope === 'family') {
      // 家庭日常独立于宝宝档案，无宝宝的家庭也可以发布日常照片。
      check(!data.babyId, '家庭照片不应指定宝宝');
      return { scope, babyId: '', babyName: '' };
    }
    const baby = requireBaby(home, data.babyId);
    return { scope, babyId: baby.id, babyName: baby.name };
  }
  /**
   * 为当前家人上传一张私有墙照片，不立即发布或签发地址。
   * @param {string} openid 已认证的微信会话身份。
   * @param {object} data scope、babyId及base64；家庭babyId为空，JPG/PNG解码后最多10MB。
   * @returns {Promise<object>} 仅含photoId，后续发布仍须验证用途及归属。
   * @throws {Error} 身份、宝宝、图片格式或真实大小不合法，或持久化失败。
   */
  async function uploadWallPhoto(openid, data) {
    // 旧会话不代表仍是有效家人，每次上传都先验证当前家庭成员资格。
    const home = await readMember(openid);
    const target = requireTarget(home, data);
    const encoded = data.base64;
    // 编码长度先限流，解码后再核对真实字节，不能采信客户端文件扩展名或size。
    check(
      typeof encoded === 'string' &&
        encoded.length <= MAX_BASE64_LENGTH &&
        /^[a-zA-Z0-9+/=]+$/.test(encoded),
      '请上传10MB以内JPG或PNG照片'
    );
    const buffer = Buffer.from(encoded, 'base64');
    // 图片类型由二进制文件头区分，不使用相册里可任意改名的文件后缀。
    const jpeg = buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
    const png = buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    // 标准编码回转校验拒绝截断或多余填充，上传成功必须有完整可保存的字节。
    check(
      (jpeg || png) && buffer.length <= MAX_IMAGE_BYTES && buffer.toString('base64') === encoded,
      '请上传10MB以内JPG或PNG照片'
    );
    // 随机文件名不会暴露宝宝名字、拍摄时间或用户设备中的原始路径。
    const filename = `${randomId()}.${jpeg ? 'jpg' : 'png'}`,
      photoId = `photo:${filename}`;
    // 必须实际持久化成功才登记元数据并返回photoId，容器内缓存不算上传成功。
    await avatars.write(filename, buffer);
    // 元数据绑定当前上传者、家庭及宝宝，其他成员不能用猜到的fileID发帖。
    await repo.put('care_files', hash(photoId), {
      kind: 'wall',
      fileID: photoId,
      ownerId: home.ownerId,
      uploadedBy: actorId(openid),
      scope: target.scope,
      babyId: target.babyId,
    });
    return { photoId };
  }
  /**
   * 以1至9张本人同宝宝上传的墙照片发布一篇文字动态。
   * @param {string} openid 已认证的微信身份，不采信正文中的authorId或角色。
   * @param {object} data scope及可选babyId、最多200字text和1至9个不同photoIds。
   * @returns {Promise<object>} 提交后的postId及成功说明，不返回图片短链。
   * @throws {Error} 成员、文字、数量、文件用途或上传归属不符合要求。
   */
  async function publishPhotoPost(openid, data) {
    // 请求正文里的角色和作者不参与授权，提前鉴权仅用于尽早拒绝外人。
    const prior = await readMember(openid),
      id = actorId(openid);
    const text = data.text === undefined ? '' : data.text;
    // 表情按字符计数，不因UTF16代理对把一段合法说明错误计算成两倍长度。
    check(typeof text === 'string' && [...text].length <= 200, '照片文字最多200字');
    const photoIds = data.photoIds;
    // 每张上传限制10MB，发布还需独立限制整篇照片数量，不能无限引用已有文件。
    // 重复文件不能伪装成多张照片，也不能让用户提交头像或外部URL作为照片。
    check(
      Array.isArray(photoIds) &&
        photoIds.length >= 1 &&
        photoIds.length <= MAX_PHOTOS &&
        new Set(photoIds).size === photoIds.length &&
        photoIds.every((photo) => typeof photo === 'string' && PHOTO_ID.test(photo)),
      '请选择1至9张不同照片'
    );
    // 文件绑定与头指针提交共用同一事务，任何图片校验失败都不会留下半篇动态。
    return repo.transaction(async (tx) => {
      // 开始提交时重读家庭，防止上传后已被移除的成员继续发布。
      const home = await currentHome(tx, prior, id),
        target = requireTarget(home, data);
      // 成员资格与全部文件绑定在同一事务检查，任意一张不符就不发布整篇。
      for (const photoId of photoIds) {
        const file = await tx.get('care_files', hash(photoId));
        check(
          file &&
            file.kind === 'wall' &&
            file.fileID === photoId &&
            // 同一家人给不同宝宝上传的照片也不能混挂，必须与当前发布主体一致。
            file.ownerId === home.ownerId &&
            file.uploadedBy === id &&
            (file.scope === undefined ? 'baby' : file.scope) === target.scope &&
            file.babyId === target.babyId,
          '照片无权用于这个发布目标，请由本人重新上传'
        );
      }
      // 署名从当前有效成员记录取，不能通过输入文字伪装成另一位发布者。
      const member = d.assertMember(home, id);
      // 真实创建时间、作者和家庭均由服务端决定，调用方不能置顶或冒充别人。
      const node = await appendPost(tx, {
        id: randomId(),
        ownerId: home.ownerId,
        authorId: id,
        authorName: member.name,
        ...target,
        // 普通入口固定为wall来源，不能将自由发布伪装成已经完成照护的执行证据。
        source: 'wall',
        text: text.trim(),
        // 保存独立数组快照，调用方后续改动草稿不会改变已发布的图片集合。
        photoIds: photoIds.slice(),
        createdAt: now(),
      });
      return { postId: node.id, message: '家庭照片已发布' };
    });
  }
  /**
   * 只为已发布帖子引用且用途归属正确的照片签发短链。
   * @param {object} post 当前家庭中未软删的帖子。
   * @param {object} home 本次读取已授权的家庭。
   * @returns {Promise<Array<object>>} 含photoId和photoUrl的照片列表，不含私有存储元数据。
   */
  async function signedPhotos(post, home) {
    const photos = [];
    // 未发布上传不会走此路径；删除后的节点在分页层就会被排除。
    for (const photoId of post.photoIds) {
      if (!PHOTO_ID.test(photoId)) continue;
      // 合法随机格式仍不是访问凭证，必须命中当前帖子所引用的登记文件。
      const file = await repo.get('care_files', hash(photoId));
      const ownership =
        file &&
        file.fileID === photoId &&
        file.ownerId === home.ownerId &&
        // 即使同家庭共用存储，也不能替帖子作者签发另一位家人的未发布文件。
        file.uploadedBy === post.authorId;
      // 两类用途分别校验，完成照须精确匹配真实任务和日期，不能降格为普通墙上传。
      const bound =
        file &&
        (post.source === 'completion'
          ? file.kind === 'completion' && file.taskId === post.taskId && file.date === post.date
          : post.source === 'wall' &&
            file.kind === 'wall' &&
            // 旧照片缺scope时按宝宝兼容，显式家庭照片仍须同时匹配空babyId。
            (file.scope === undefined ? 'baby' : file.scope) ===
              (post.scope === undefined ? 'baby' : post.scope) &&
            file.babyId === post.babyId);
      // 绑定不完整的文件不产生签名，不通过错误响应泄露任意文件是否存在。
      if (ownership && bound) photos.push({ photoId, photoUrl: photoUrl(photoId.slice(6)) });
    }
    return photos;
  }
  /**
   * 从真实链表游标向前浏览，跳过软删和不匹配宝宝，最多扫描200节点。
   * @param {string} openid 当前可信微信身份，已移除成员即时失去读取权。
   * @param {object} data 省略scope默认全部；可指定家庭或具体宝宝，cursor节点及limit为1至20。
   * @returns {Promise<object>} posts及nextCursor，稀疏筛选空页仍可继续翻历史。
   * @throws {Error} 游标、家庭、宝宝筛选非法或链表数据不完整。
   */
  async function listPhotoPosts(openid, data = {}) {
    // 每一页重新核对有效成员，持有旧游标不能在被移除后继续翻阅家庭照片。
    const home = await readMember(openid),
      id = actorId(openid);
    const babyId = data.babyId || 'all',
      limit = data.limit === undefined ? MAX_PAGE : data.limit;
    // 一页最多20篇，结合逐节点扫描上限约束一次请求的图片元数据读取量。
    check(Number.isInteger(limit) && limit >= 1 && limit <= MAX_PAGE, '照片分页数量需为1至20');
    // 不指定范围代表全部；明确家庭范围无需宝宝，旧babyId筛选仍按宝宝解释。
    const target = data.scope === undefined && babyId === 'all' ? null : requireTarget(home, data);
    // 游标只接受已发布动态的随机编号，不接受文件路径、URL或数据库查询表达式。
    check(
      !data.cursor || (typeof data.cursor === 'string' && POST_ID.test(data.cursor)),
      '照片分页位置不正确'
    );
    // 同一个home文档键迁移后也必须匹配家庭归属，不能串到其他家庭的历史链。
    const feed = await repo.get('care_photo_feed', 'home');
    check(!feed || feed.ownerId === home.ownerId, '无权访问这份照片历史');
    let cursor = data.cursor || (feed && feed.head) || '';
    const posts = [],
      visited = new Set();
    // 扫描上限约束一页读取成本；返回未扫描指针，不把空页误当作历史结束。
    while (cursor && posts.length < limit && visited.size < MAX_SCAN) {
      check(POST_ID.test(cursor) && !visited.has(cursor), '照片历史分页位置不正确，请刷新');
      visited.add(cursor);
      const post = await repo.get('care_photo_posts', cursor);
      check(post && post.ownerId === home.ownerId, '照片分页位置不存在或无权访问');
      // 无论当前节点是否删除或匹配宝宝，下一次扫描都沿原始历史指针继续。
      cursor = post.previousId || '';
      // 保留删除节点的previousId，因此从旧游标继续也不会丢失更早历史。
      const scope = post.scope === undefined ? 'baby' : post.scope;
      if (post.deletedAt || (target && (scope !== target.scope || post.babyId !== target.babyId)))
        continue;
      // 列表只读取绑定元数据并签名，不读取图片二进制，不触发客户端下载。
      const photos = await signedPhotos(post, home);
      // 只返回展示字段，不暴露存储元数据或把客户端角色当作删除权限。
      posts.push({
        id: post.id,
        scope,
        babyId: post.babyId,
        babyName: post.babyName,
        // 月龄绑定照片记录日期；补填生日可补全旧照片，浏览当天不参与计算。
        ageLabel:
          scope === 'baby'
            ? d.babyAgeLabel(
                (home.babies.find((baby) => baby.id === post.babyId) || {}).birthDate,
                post.date || d.chinaDate(post.createdAt)
              )
            : '',
        authorId: post.authorId,
        authorName: post.authorName,
        text: post.text,
        createdAt: post.createdAt,
        // 来源用于区分主动分享与完成留档，删除权始终按当前身份重新计算。
        source: post.source,
        photos,
        photoCount: photos.length,
        canDelete: id === home.ownerId || id === post.authorId,
      });
    }
    return { posts, nextCursor: cursor };
  }
  /**
   * 允许作者删除本人动态，或真正家庭管理员删除任意动态。
   * @param {string} openid 当前可信微信身份，家庭称呼不授予管理员权限。
   * @param {object} data 随机postId，忽略正文中的owner、author及角色字段。
   * @returns {Promise<object>} 软删提交成功说明；不会删除任务执行历史或图片二进制。
   * @throws {Error} 已离家、帖子越权、非作者非管理员或写入失败。
   */
  async function deletePhotoPost(openid, data) {
    // 先验证家人成员资格，再探测指定帖子，避免外人凭ID获知家庭记录是否存在。
    const prior = await readMember(openid),
      id = actorId(openid);
    check(POST_ID.test(data.postId || ''), '照片动态编号不正确');
    // 删除权限与墓碑写入共用事务，已移除者的旧角色不能覆盖当前成员状态。
    return repo.transaction(async (tx) => {
      const home = await currentHome(tx, prior, id);
      const post = await tx.get('care_photo_posts', data.postId);
      // 角色只能由当前home.ownerId决定，家庭身份写“管理员”也不能删别人的帖子。
      check(post && post.ownerId === home.ownerId, '无权访问这篇照片动态');
      check(id === post.authorId || id === home.ownerId, '只能删除本人发布的动态，或由管理员删除');
      if (!post.deletedAt) {
        // 只加墓碑不改链指针；已下载图片及现有十分钟短链不在本次删除的撤回范围。
        await tx.put('care_photo_posts', post.id, { ...post, deletedAt: now(), deletedBy: id });
      }
      return { message: '照片动态已删除' };
    });
  }
  /**
   * 分发经过HTTP会话验证的照片墙动作，不开放内部完成接入方法。
   * @param {string} openid 可信会话身份。
   * @param {string} action 仅限上传、发布、列表和软删四种动作。
   * @param {object} data 对应动作参数，不能指定操作者身份。
   * @returns {Promise<object>} 业务真实结果，失败沿原异常返回。
   */
  async function call(openid, action, data = {}) {
    const started = Date.now();
    const actions = { uploadWallPhoto, publishPhotoPost, listPhotoPosts, deletePhotoPost };
    // 必须检查自身白名单属性，原型方法或内部addCompletion不属于公开动作。
    check(Object.hasOwn(actions, action), '不支持的照片墙操作');
    // 审计白名单动作与可信成员ID，不把照片标识、说明或原始图片编码附加到事件。
    const entry = { actorId: actorId(openid), kind: 'business', source: 'server', name: action };
    try {
      const result = await actions[action](openid, data);
      // 只有业务已完成才记录成功；提交回滚和上传失败不会被写成成功发布。
      await activity.record({ ...entry, outcome: 'success', durationMs: Date.now() - started });
      return result;
    } catch (error) {
      // 失败只记固定动作和结果，异常正文可能含数据库信息，因此不写入审计内容。
      await activity.record({ ...entry, outcome: 'failure', durationMs: Date.now() - started });
      throw error;
    }
  }
  // 内部完成入口只供业务事务调用，HTTP入口仅使用四动作白名单的call。
  return {
    call,
    uploadWallPhoto,
    publishPhotoPost,
    listPhotoPosts,
    deletePhotoPost,
    addCompletion,
  };
}

module.exports = { createPhotoWall, addCompletion };
