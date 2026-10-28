const { createRuntime } = require('./runtime.cjs');
const { createHttpApplication } = require('./app.cjs');
const { createReviewApplication } = require('./review.cjs');

/**
 * 启动服务；自建服务器可带扫描，云托管由阿里云独立调度保证提醒及时。
 * @returns {Promise<void>} 数据库准备完成后开放HTTP监听。
 * @throws {Error} 运行环境或应用初始化失败时交由进程出口记录稳定错误码。
 */
async function start() {
  // 先确认持久化环境可用，再开放业务入口，避免使用空仓库接收家庭请求。
  const { repo, config } = await createRuntime();
  const primary = createHttpApplication({ repo, config });
  // 正式与审核共用已有监听器和连接池，仅审核集合及签名用途隔离，不新建云资源。
  const application = await createReviewApplication({
    repo,
    config,
    primary,
    access: config.reviewAccess,
  });
  // 审核路由准备好后才开始接收请求，不能让登录落到尚未完成隔离的数据路径。
  // 默认仅绑定回环地址，由部署的HTTPS入口转发；容器可显式覆盖监听地址。
  const port = Number(process.env.PORT || 3000),
    host = process.env.BIND_HOST || '127.0.0.1';
  application.server.listen(port, host, () =>
    console.info('家庭服务已启动', {
      host,
      port,
      database: process.env.DATABASE_DRIVER || 'sqlite',
    })
  );
  let running = false,
    timer;
  // 云托管可禁用容器内扫描，交由独立调度，避免依赖容器持续常驻。
  if (process.env.REMINDER_ENABLED !== 'false')
    timer = setInterval(async () => {
      // 单进程扫描尚未结束时跳过下一拍，跨副本领取冲突仍由仓库事务保证。
      if (running) return;
      running = true;
      try {
        // 扫描结果只记录计数，不输出待发送正文或家庭成员身份。
        console.info('超时事项检查完成', await application.tick());
      } catch (_) {
        // 一轮失败只记录固定提示，下次时钟仍可继续扫描未处理的到期事件。
        console.error('超时事项检查失败，请检查数据库或消息配置');
      } finally {
        // 无论发送是否成功都释放本进程互斥标记，避免一次异常停掉后续扫描。
        running = false;
      }
    }, 300000);
  /**
   * 收到停止信号时依次释放入口、扫描与持久仓库。
   * @returns {Promise<void>} 资源关闭完成后正常退出进程。
   * @throws {Error} 资源关闭失败时保留异常，不假报已完整停止。
   */
  const shutdown = async () => {
    // 先停止入口与调度，再关闭连接，防止请求在提交过程中丢失。
    clearInterval(timer);
    await application.close();
    await repo.close();
    process.exit(0);
  };
  // 服务停止与交互中断共用关闭顺序，不在信号到来时直接切断持久化连接。
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
start().catch((error) => {
  // 只记录错误类别；连接配置、证书私钥与用户标识不进入容器日志。
  console.error('家庭服务启动失败', { code: error.code || 'CONFIG_OR_DATABASE' });
  process.exitCode = 1;
});
