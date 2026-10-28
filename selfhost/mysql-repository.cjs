const mysql = require('mysql2/promise');
const net = require('node:net');

/**
 * 生成跨云连接配置，拒绝明文连接及共享管理账号。
 * @param {object} config 专用数据库账号、地址和双向TLS的ca/cert/key PEM内容。
 * @returns {object} 开启证书链、主机名校验且禁用多语句的连接池配置。
 * @throws {Error} 数据库名、专用账号、口令或证书不完整时拒绝启动。
 */
function mysqlOptions(config) {
  // 不接受root跨云访问，应用账号仅由部署脚本授予业务库的读写权限。
  if (!config.user || config.user === 'root') throw new Error('请配置专用数据库账号');
  // 库名必须符合部署脚本约束，避免错连未受授权的业务库。
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(config.database || '')) throw new Error('数据库名不正确');
  // 在建立网络连接前拒绝弱口令或缺失的地址，不以驱动默认值继续启动。
  if (!config.host || typeof config.password !== 'string' || config.password.length < 24)
    throw new Error('数据库连接配置不完整');
  // 证书由本项目独立CA签发，不能因配置遗漏退回到明文或跳过身份验证。
  if (
    ![config.ca, config.cert, config.key].every(
      (value) => typeof value === 'string' && value.length
    )
  )
    throw new Error('跨云数据库需要完整的双向TLS证书');
  // IP直连时仍使用固定的证书身份；mysql2对IP省略SNI会回落验证localhost。
  if (net.isIP(config.host) && !config.serverName) throw new Error('请配置数据库TLS证书主机名');
  return {
    // 证书身份与实际拨号地址分离，跨云私网IP变化不影响服务端身份校验。
    host: config.serverName || config.host,
    port: config.port || 3306,
    user: config.user,
    password: config.password,
    database: config.database,
    // 小规模连接池与有界等待队列限制容器扩容时对数据库的并发压力。
    connectionLimit: 3,
    waitForConnections: true,
    queueLimit: 40,
    connectTimeout: 8000,
    charset: 'utf8mb4',
    // 单次执行只允许一条语句，业务值仍统一使用预处理参数绑定。
    multipleStatements: false,
    ...(config.serverName
      ? { stream: () => net.connect({ host: config.host, port: config.port || 3306 }) }
      : {}),
    // mysql2默认不验证主机名；这里显式校验服务器SAN及私有CA。
    ssl: {
      ca: config.ca,
      cert: config.cert,
      key: config.key,
      rejectUnauthorized: true,
      verifyIdentity: true,
      minVersion: 'TLSv1.2',
    },
  };
}

/**
 * 将同一连接上的文档读写封装为业务仓库，供普通请求与事务复用。
 * @param {object} connection mysql2连接池或当前事务的独占连接。
 * @returns {object} 参数化的get/put接口，缺少文档时返回null。
 */
function documentAccess(connection) {
  // 闭包保留调用方传入的连接，事务内部不会意外切回池中的其他连接。
  return {
    /**
     * 按集合与业务主键读取一个文档。
     * @param {string} collection 受服务端控制的逻辑集合名。
     * @param {string|number} id 业务主键，按字符串绑定查询。
     * @returns {Promise<object|null>} 解析后的业务文档；不存在时返回null。
     * @throws {Error} 查询失败或持久化JSON损坏时向调用方传播。
     */
    async get(collection, id) {
      // 集合名和文档ID始终作为值绑定，不拼接为SQL标识符。
      const [rows] = await connection.execute(
        'SELECT body FROM care_records WHERE collection=? AND id=?',
        [collection, String(id)]
      );
      // 不存在与损坏JSON分开处理，后者交由事务或请求边界报告异常。
      return rows.length ? JSON.parse(rows[0].body) : null;
    },
    /**
     * 按文档主键写入完整业务快照。
     * @param {string} collection 受服务端控制的逻辑集合名。
     * @param {string|number} id 需要写入或覆盖的业务主键。
     * @param {object} value 可序列化的业务快照，不应包含连接凭据。
     * @returns {Promise<void>} 数据库完成写入后结束；事务提交仍由外层负责。
     * @throws {Error} 序列化或数据库写入失败时向事务边界传播。
     */
    async put(collection, id, value) {
      // JSON和头像内容不进入日志；重复写入同一文档保持原有upsert语义。
      await connection.execute(
        'INSERT INTO care_records(collection,id,body) VALUES(?,?,?) ON DUPLICATE KEY UPDATE body=VALUES(body)',
        [collection, String(id), JSON.stringify(value)]
      );
    },
  };
}

/**
 * 创建阿里云持久仓库，事务锁保证多个云托管副本更新家庭数据时不丢失变更。
 * @param {object} config 专用业务库连接配置，表结构由部署脚本提前初始化。
 * @returns {Promise<object>} get/put/list/transaction及close接口。
 * @throws {Error} 连接、双向TLS或初始化表不可用时启动失败。
 */
async function createMySQLRepository(config) {
  // 连接参数校验先于连接池创建，配置错误不会留下可复用的不安全连接。
  const pool = mysql.createPool(mysqlOptions(config));
  try {
    // 启动时确认真实业务库已初始化；不在应用请求中自动建库或升级结构。
    const [locks] = await pool.execute('SELECT id FROM care_mutex WHERE id=1');
    if (locks.length !== 1) throw new Error('数据库事务锁尚未初始化');
  } catch (error) {
    // 启动探针失败时关闭整个池，避免未就绪进程继续占用数据库连接。
    await pool.end();
    throw error;
  }
  return {
    // 普通读写复用连接池，只有显式事务才领取并独占单个连接。
    ...documentAccess(pool),
    /**
     * 使用类型严格的JSON条件列出集合文档。
     * @param {string} collection 需要查询的逻辑集合。
     * @param {object} filter 单层字段与字符串、数字、布尔值组成的等值条件。
     * @param {number} limit 最大返回数量，必须为0至10000的整数。
     * @returns {Promise<object[]>} 按业务主键排序的文档列表。
     * @throws {Error} 数量、条件或数据库返回的JSON不正确时拒绝查询。
     */
    async list(collection, filter, limit) {
      const entries = Object.entries(filter);
      if (!Number.isInteger(limit) || limit < 0 || limit > 10000) throw new Error('查询数量不正确');
      // 只接受业务服务给出的单层字段；禁止对象转换成含糊的字符串筛选。
      if (
        entries.some(
          ([key, value]) =>
            !/^[a-zA-Z][a-zA-Z0-9]*$/.test(key) ||
            !['string', 'number', 'boolean'].includes(typeof value)
        )
      )
        throw new Error('查询条件不正确');
      // JSON_CONTAINS保持值类型，不让MariaDB/MySQL的隐式字符串转换误匹配或漏匹配。
      const parameters = [collection, JSON.stringify(filter)];
      // LIMIT只能插入前面已验证的整数，筛选内容仍按参数传递。
      const [rows] = await pool.execute(
        `SELECT body FROM care_records WHERE collection=? AND JSON_CONTAINS(body,?) ORDER BY id LIMIT ${limit}`,
        parameters
      );
      // 返回独立反序列化快照，调用方不会持有驱动内部的行对象。
      return rows.map((row) => JSON.parse(row.body));
    },
    /**
     * 在跨副本共享互斥锁内执行一组文档读写。
     * @param {Function} fn 只通过当前事务仓库读写的异步业务回调。
     * @returns {Promise<*>} 提交成功后返回业务回调结果。
     * @throws {Error} 业务或SQL失败时回滚，并向调用方传播异常。
     */
    async transaction(fn) {
      // 独占连接直到提交或回滚完成，避免锁与后续写入分散到不同会话。
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        // 单家庭规模使用一行互斥锁；跨副本、定时任务与审批共享同一原子边界。
        await connection.execute('SELECT id FROM care_mutex WHERE id=1 FOR UPDATE');
        const result = await fn(documentAccess(connection));
        // 提交完成才向上层报告成功，外层不能把未提交数据当作持久结果。
        await connection.commit();
        return result;
      } catch (error) {
        // 业务异常与SQL异常均回滚，连接释放后下一次家庭操作仍能继续。
        await connection.rollback();
        throw error;
      } finally {
        // 成功与异常路径都归还连接，避免有限连接池被失败请求耗尽。
        connection.release();
      }
    },
    close: () => pool.end(),
  };
}
module.exports = { mysqlOptions, createMySQLRepository };
