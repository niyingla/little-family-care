const cloud = require('wx-server-sdk');
const { runtime } = require('./lib/cloud.cjs');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
exports.main = async () => {
  const context = cloud.getWXContext();
  // 定时入口独立部署，拒绝通过客户端callFunction触发批量发送。
  if (context.OPENID || String(context.SOURCE || '').includes('wx_client'))
    throw new Error('仅允许云端定时任务调用');
  const started = Date.now();
  const result = await runtime(cloud).service.tick();
  console.info('到期任务检查完成', { ...result, elapsedMs: Date.now() - started });
  return result;
};
