const d = require('./domain');
const config = require('../config');
const KEY = 'little-family-care-demo-v1';
let demo = false;

function loadDemo() {
  let state = wx.getStorageSync(KEY);
  // 示例使用独立存储键，不会与真实家庭数据混在一起。
  if (!state) state = { home: d.createDemo(d.chinaDate(new Date())), days: {} };
  return state;
}

async function call(action, data = {}) {
  if (!demo) {
    if (!config.envId) throw new Error('尚未连接云开发，请先使用本地体验');
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
    throw new Error('本地体验不会发送邀请或微信消息；连接云开发后可使用');
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
