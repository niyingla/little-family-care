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
};
let demo = false;
let sessionToken = '';
let loginPromise = null;
let transport = null,
  avatarCache = null;

function request(route, data, token) {
  // 延迟创建，结构检查及本地体验不依赖真实微信运行环境。
  if (!transport) transport = createTransport(config, wx);
  return transport(route, data, token);
}

/**
 * 延迟创建当前进程的私有图片读取器，不在此下载图片。
 * @returns {Function} 共用load与pin能力的有界沙盒读取器。
 */
function privateImageLoader() {
  // 初始化不读取图片，调用方可在下载之前固定当前预览组的缓存。
  if (!transport) transport = createTransport(config, wx);
  if (!avatarCache) avatarCache = createAvatarCache(transport, wx);
  return avatarCache;
}

/**
 * 按需读取单张已授权图片，封面加载不改变当前预览组。
 * @param {string} url 有效的短期图片地址，云托管为受控相对路径。
 * @returns {Promise<string>} 供image组件使用的本地路径或HTTPS短链。
 * @throws {Error} 地址无效或分段下载失败时拒绝。
 */
async function loadPrivateImage(url) {
  if (!url) throw new Error('照片暂时不可用，请刷新后重试');
  // 云开发临时地址和自有域名可直接读取，云托管相对地址需要callContainer。
  if (!config.cloudRunEnvId) return url;
  // 封面只加载当前一张，不替换用户正在预览的整组文件保护范围。
  return privateImageLoader()(url);
}

/**
 * 固定并加载当前预览组，避免封面下载淘汰九图预览正在使用的本地文件。
 * @param {string[]} urls 当前已授权动态的一至九张照片短链。
 * @returns {Promise<string[]>} 全部可用的本地图片路径或直接可用的HTTPS地址。
 * @throws {Error} 照片列表非法或任意照片未完整下载时不打开残缺预览。
 */
async function loadPrivateImages(urls) {
  // 先验证整组数量和地址，任一无效都不替换当前预览保护集合或开始部分下载。
  if (
    !Array.isArray(urls) ||
    urls.length < 1 ||
    urls.length > 9 ||
    urls.some((url) => typeof url !== 'string' || !url)
  )
    throw new Error('预览照片列表不正确');
  // 只有云托管走沙盒缓存，其他传输方式继续使用其已鉴权短链。
  if (!config.cloudRunEnvId) return urls.slice();
  const load = privateImageLoader();
  // 整组先被固定再并发读取；不能等某张下载完成后才补保护。
  load.pin(urls);
  return Promise.all(urls.map((url) => load(url)));
}

/**
 * 获取当前微信身份的后端会话，并合并并发登录请求。
 * @returns {Promise<string>} 仅在本次小程序进程内复用的服务端会话令牌。
 * @throws {Error} 微信登录或服务端换取会话失败时拒绝，不保存微信会话密钥。
 */
async function login() {
  // 有效会话仅保留内存引用，不把令牌或微信session_key写入本地存储。
  if (sessionToken) return sessionToken;
  // 多个页面请求共享一次登录Promise，避免并发使用一次性微信登录凭证。
  if (!loginPromise)
    loginPromise = (async () => {
      // 会话仅在本次小程序进程内复用，重新启动时重新取得当前微信身份。
      const identity = await new Promise((resolve, reject) =>
        wx.login({ success: resolve, fail: reject })
      );
      if (!identity.code) throw new Error('微信登录暂时不可用');
      // 一次性code只发送给选定的登录入口，不打印到日志或拼接到地址。
      const response = await request('/api/login', { code: identity.code });
      if (!response.data || !response.data.ok)
        throw new Error((response.data && response.data.message) || '登录失败，请稍后重试');
      sessionToken = response.data.data.token;
      // 客户端仅持有业务令牌，微信服务端密钥的处理留在后端身份交换流程。
      return sessionToken;
    })().finally(() => {
      // 成败都释放进行中标记，失败后可重试而不会永远复用拒绝的Promise。
      loginPromise = null;
    });
  return loginPromise;
}

/**
 * 调用已配置后端，遇到身份拒绝时仅重登并重试一次。
 * @param {string} action 服务端支持的业务动作，不由传输层替换含义。
 * @param {object} data 当前动作的业务参数，身份来自会话令牌。
 * @returns {Promise<*>} 服务端确认成功的业务结果，图片局部失败可降级为空。
 * @throws {Error} 登录、网络或业务拒绝时向页面传播，不自动切换本地体验。
 */
async function callServer(action, data) {
  // 业务请求先取得同一内存会话，服务端据此确认身份而不信任自报成员ID。
  let response = await request('/api/call', { action, data }, await login());
  if (response.statusCode === 401) {
    // 只有服务端拒绝身份、尚未执行业务时才重登重试，避免重复提交操作。
    sessionToken = '';
    response = await request('/api/call', { action, data }, await login());
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
          return { ...baby, avatarUrl: await loadPrivateImage(baby.avatarUrl) };
        } catch (_) {
          // 私有头像失效只清空图片，保留真实家庭资料与任务读取结果。
          return { ...baby, avatarUrl: '' };
        }
      })
    );
  }
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
  for (const field of IMAGE_UPLOAD_FIELDS[action])
    if (data[field] !== undefined) metadata[field] = data[field];
  // 初始化不携带图片正文；每批只创建一次会话，后续失败留给服务端按期限回收。
  const session = await callServer('initImageUpload', {
    action,
    metadata,
    totalLength: base64.length,
    totalParts,
  });
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
    const result = await callServer('appendImageChunk', {
      uploadId: session.uploadId,
      index,
      // ASCII Base64按字符切分，每个请求正文远低于实际验证过的100KB边界。
      chunk: base64.slice(index * UPLOAD_CHUNK_CHARACTERS, (index + 1) * UPLOAD_CHUNK_CHARACTERS),
    });
    // HTTP成功仍需明确接收标记，未接收的块不能继续组装或冒充上传成功。
    if (!result || result.accepted !== true) throw new Error('图片分片上传失败，请重试');
  }
  // 只有全部块确认后才完成组装；不触发事项完成、发布或家人通知等后续业务。
  return callServer('finishImageUpload', { uploadId: session.uploadId });
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
    // 三种大图上传统一使用小包，未来从云托管切换自有HTTPS时不改变业务协议。
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
  config,
  setDemo: (value) => {
    demo = value;
  },
  isDemo: () => demo,
};
