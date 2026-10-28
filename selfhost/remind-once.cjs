const { createRuntime } = require('./runtime.cjs');
const { createHttpApplication } = require('./app.cjs');

/**
 * 执行一次到期扫描，供阿里云systemd定时器调用，不依赖微信容器常驻。
 * @returns {Promise<void>} 扫描结果仅记录数量；失败返回非零退出码。
 * @throws {Error} 初始化或扫描失败时传播到进程出口，供定时器识别失败。
 */
async function run() {
  // 计时覆盖初始化和扫描耗时，日志不包含家庭成员或消息正文。
  const started = Date.now();
  const { repo, config } = await createRuntime();
  try {
    // 复用同一消息领取与发送逻辑，不创建公开的定时任务HTTP接口。
    const application = createHttpApplication({ repo, config });
    const result = await application.tick();
    console.info('独立提醒扫描完成', { ...result, elapsedMs: Date.now() - started });
  } finally {
    // 一次性进程完成或失败都关闭仓库，避免连接池阻止定时任务退出。
    await repo.close();
  }
}
run().catch((error) => {
  // 只记录稳定错误码，不打印可能含连接信息和私有数据的异常对象。
  console.error('独立提醒扫描失败', { code: error.code || 'SCAN_FAILED' });
  process.exitCode = 1;
});
