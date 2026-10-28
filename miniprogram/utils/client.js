const d = require('./domain');
const config = require('../config');
const KEY = 'little-family-care-demo-v1';
let demo = false;
let sessionToken = '';
let loginPromise = null;

function request(route, data, token) {
  return new Promise((resolve, reject) =>
    wx.request({
      url: config.apiBaseUrl.replace(/\/$/, '') + route,
      method: 'POST',
      data,
      timeout: 15000,
      header: {
        'content-type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      success: resolve,
      fail: () => reject(new Error('家庭服务暂时连接不上，请稍后重试')),
    })
  );
}

async function login() {
  if (sessionToken) return sessionToken;
  if (!loginPromise)
    loginPromise = (async () => {
      // 会话仅在本次小程序进程内复用，重新启动时重新取得当前微信身份。
      const identity = await new Promise((resolve, reject) =>
        wx.login({ success: resolve, fail: reject })
      );
      if (!identity.code) throw new Error('微信登录暂时不可用');
      const response = await request('/api/login', { code: identity.code });
      if (!response.data || !response.data.ok)
        throw new Error((response.data && response.data.message) || '登录失败，请稍后重试');
      sessionToken = response.data.data.token;
      return sessionToken;
    })().finally(() => {
      loginPromise = null;
    });
  return loginPromise;
}

async function callServer(action, data) {
  if (!/^https:\/\//.test(config.apiBaseUrl)) throw new Error('请配置家庭服务的HTTPS域名');
  let response = await request('/api/call', { action, data }, await login());
  if (response.statusCode === 401) {
    // 只有服务端拒绝身份、尚未执行业务时才重登重试，避免重复提交操作。
    sessionToken = '';
    response = await request('/api/call', { action, data }, await login());
  }
  if (!response.data || !response.data.ok)
    throw new Error((response.data && response.data.message) || '操作失败，请稍后重试');
  return response.data.data;
}

function loadDemo() {
  let state = wx.getStorageSync(KEY);
  // 示例使用独立存储键，不会与真实家庭数据混在一起。
  if (!state) state = { home: d.createDemo(d.chinaDate(new Date())), days: {} };
  return state;
}

async function call(action, data = {}) {
  if (!demo) {
    if (config.apiBaseUrl) return callServer(action, data);
    if (!config.envId) throw new Error('家庭共享服务尚未准备好，请先使用本地体验');
    const response = await wx.cloud.callFunction({ name: 'family', data: { action, data } });
    if (!response.result || !response.result.ok)
      throw new Error((response.result && response.result.message) || '云端响应异常');
    return response.result.data;
  }
  const state = loadDemo();
  const actorId = state.home.ownerId;
  const today = d.chinaDate(new Date());
  if (action === 'bootstrap') return { member: true, actorId };
  if (action === 'snapshot') {
    const date = data.date || today;
    return {
      home: state.home,
      day: state.days[date] || null,
      actorId,
      date,
      today,
      requests: [],
      messages: [],
      configured: false,
      subscribed: false,
    };
  }
  if (['makeInvite', 'reviewInvite', 'subscribe', 'applyInvite'].includes(action))
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
  state.home = next.home;
  if (action === 'complete' || action === 'nudge') state.days[today] = next.day;
  wx.setStorageSync(KEY, state);
  // 体验版只保存催办记录，不把模拟操作说成已发微信。
  return action === 'nudge'
    ? { message: '已记录本地催办；体验版不会发送微信通知', status: 'demo' }
    : next.result;
}
module.exports = {
  call,
  config,
  setDemo: (value) => {
    demo = value;
  },
  isDemo: () => demo,
};
