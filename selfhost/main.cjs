const fs = require('node:fs');
const path = require('node:path');
const { createSQLiteRepository } = require('./sqlite-repository.cjs');
const { createHttpApplication } = require('./app.cjs');
const dataDir = path.resolve(process.env.DATA_DIR || './local-data');
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
let fields = {};
try {
  fields = JSON.parse(process.env.REMIND_FIELDS || '{}');
} catch (_) {
  console.warn('消息字段配置无效，通知暂不可用');
}
const repo = createSQLiteRepository(path.join(dataDir, 'family.sqlite'));
const application = createHttpApplication({
  repo,
  config: {
    dataDir,
    ownerOpenId: process.env.OWNER_OPENID || '',
    appId: process.env.WX_APP_ID || '',
    appSecret: process.env.WX_APP_SECRET || '',
    templateId: process.env.REMIND_TEMPLATE_ID || '',
    fields,
    messageStage: process.env.MESSAGE_STAGE || 'trial',
    signingSecret: process.env.SIGNING_SECRET || '',
    publicOrigin: String(process.env.PUBLIC_ORIGIN || '').replace(/\/$/, ''),
  },
});
const port = Number(process.env.PORT || 3000),
  host = process.env.BIND_HOST || '127.0.0.1';
application.server.listen(port, host, () => console.info('家庭服务已启动', { host, port }));
let running = false;
const timer = setInterval(async () => {
  if (running) return;
  running = true;
  try {
    const result = await application.tick();
    console.info('超时事项检查完成', result);
  } catch (_) {
    console.error('超时事项检查失败，请检查数据库或消息配置');
  } finally {
    running = false;
  }
}, 300000);
const shutdown = async () => {
  clearInterval(timer);
  await application.close();
  await repo.close();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
