const { ROOTS, resolve, tablesFor, encodeDocument, decodeDocument } = require('./model.cjs');

/**
 * 封装当前事务连接的分表读写，兼容现有领域服务的最小仓库接口。
 * @param {object} connection 已开始事务的mysql2连接，调用方负责提交与回滚。
 * @returns {object} get/put/list接口；不暴露连接、DDL或任意SQL执行能力。
 */
function relationalAccess(connection) {
  return {
    /**
     * 装配一个业务实体及其子表，读取同一事务的一致快照。
     * @param {string} collection 静态映射的业务类别，可带审核前缀。
     * @param {string} id 原业务主键。
     * @returns {Promise<object|null>} 完整领域快照；根实体不存在时为null。
     */
    async get(collection, id) {
      const { definition, namespace } = resolve(collection),
        rows = [];
      // 所有子表沿根外部键查询，不能取到其他家庭或正式空间的记录。
      for (const table of tablesFor(definition)) {
        const [items] = await connection.execute(
          `SELECT * FROM \`${table.table}\` WHERE namespace=? AND \`${table.rootColumn}\`=?`,
          [namespace, String(id)]
        );
        rows.push(...items.map((values) => ({ table: table.table, values })));
        if (!table.parent && !items.length) return null;
      }
      return decodeDocument(collection, String(id), rows);
    },
    /**
     * 原子替换一个聚合，成员、宝宝、任务版本等实际保存在各自物理表。
     * @param {string} collection 固定业务类别。
     * @param {string} id 原业务主键，不能重新生成。
     * @param {object} value 完整且通过业务权限检查的快照。
     * @returns {Promise<void>} 本连接写入完成；提交仍由外层事务负责。
     * @throws {Error} 任一字段未映射或任一SQL失败时向外层传播并整体回滚。
     */
    async put(collection, id, value) {
      const { definition, namespace } = resolve(collection);
      // 所有转换先于任何DELETE，未知字段不会导致历史数据被部分移除。
      const rows = encodeDocument(collection, String(id), value),
        tables = tablesFor(definition);
      for (const table of tables.slice(1).reverse())
        await connection.execute(
          `DELETE FROM \`${table.table}\` WHERE namespace=? AND \`${table.rootColumn}\`=?`,
          [namespace, String(id)]
        );
      // 仅替换当前聚合的子表；旧care_records始终不参与新写入。
      for (const { table, values } of rows) {
        const names = Object.keys(values),
          quoted = names.map((name) => `\`${name}\``);
        const updates = names.filter(
          (name) => !tables.find((item) => item.table === table).keyColumns.includes(name)
        );
        await connection.execute(
          `INSERT INTO \`${table}\` (${quoted.join(',')}) VALUES (${names.map(() => '?').join(',')}) ON DUPLICATE KEY UPDATE ${updates.map((name) => `\`${name}\`=VALUES(\`${name}\`)`).join(',')}`,
          names.map((name) => values[name])
        );
      }
    },
    /**
     * 使用独立列和类型严格条件检索根实体。
     * @param {string} collection 固定业务类别。
     * @param {object} filter 单层字符串、布尔值或整数等值筛选。
     * @param {number} limit 0至10000的整数上限。
     * @returns {Promise<object[]>} 按原主键排序的领域快照。
     * @throws {Error} 未映射筛选字段、非法数量或数据库查询失败。
     */
    async list(collection, filter, limit) {
      const { definition, namespace } = resolve(collection),
        parameters = [namespace],
        conditions = ['namespace=?'];
      // 筛选值类型必须匹配存储列，禁止数据库隐式转换把数字字符串误认成整数。
      if (!Number.isInteger(limit) || limit < 0 || limit > 10000) throw new Error('查询数量不正确');
      for (const [name, value] of Object.entries(filter)) {
        const spec = definition.fields[name];
        if (
          !spec ||
          !['string', 'number', 'boolean'].includes(spec.type) ||
          typeof value !== spec.type
        )
          return [];
        conditions.push(`\`${spec.column}\`=?`);
        parameters.push(spec.type === 'boolean' ? Number(value) : value);
      }
      const [ids] = await connection.execute(
        `SELECT record_id FROM \`${definition.table}\` WHERE ${conditions.join(' AND ')} ORDER BY record_id LIMIT ${limit}`,
        parameters
      );
      const result = [];
      // 继续复用当前事务连接，列表与关联子表不会取到不同时间的快照。
      for (const item of ids) result.push(await this.get(collection, item.record_id));
      return result;
    },
  };
}

/**
 * 创建经过迁移校验的分表仓库，保留现有跨副本事务锁。
 * @param {object} pool mysql2连接池，由原双向TLS配置创建。
 * @returns {Promise<object>} 兼容get/put/list/transaction/close的持久仓库。
 * @throws {Error} 迁移未完成或布局未激活时拒绝启动，不能回退为空数据。
 */
async function createRelationalRepository(pool) {
  // 新布局必须由迁移工具显式激活，不能仅改环境变量就绕过数据核对。
  const [state] = await pool.execute(
    'SELECT schema_version,layout FROM care_storage_state WHERE id=1'
  );
  if (state[0]?.schema_version !== 2 || state[0]?.layout !== 'active')
    throw new Error('分表迁移尚未完成并激活');
  // 用恒假条件验证新子表删除权限，不触碰任何家庭数据；缺权必须在就绪前暴露。
  for (const definition of Object.values(ROOTS))
    for (const table of tablesFor(definition).slice(1))
      await pool.execute(`DELETE FROM \`${table.table}\` WHERE 1=0`);
  /**
   * 对同一份家庭聚合进行串行读写，避免整体替换时丢失并发修改。
   * @param {Function} fn 仅使用当前事务接口的异步业务回调。
   * @returns {Promise<*>} 提交后的业务结果。
   * @throws {Error} 业务或SQL异常回滚并继续向上传播。
   */
  async function transaction(fn) {
    const connection = await pool.getConnection();
    try {
      // 即使顶层put只有一行，也统一进入锁，配合部署切换与迁移维护窗口。
      await connection.beginTransaction();
      await connection.execute('SELECT id FROM care_mutex WHERE id=1 FOR UPDATE');
      // 回滚或维护切换后，已创建的池也必须停止读写，不能继续产生第二套状态。
      const [current] = await connection.execute(
        'SELECT layout FROM care_storage_state WHERE id=1'
      );
      if (current[0]?.layout !== 'active') throw new Error('数据库布局已变化，请重新启动服务');
      const result = await fn(relationalAccess(connection));
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      // 成功、回滚均归还连接，避免小规模连接池被错误请求耗尽。
      connection.release();
    }
  }
  return {
    get: (collection, id) => transaction((tx) => tx.get(collection, id)),
    put: (collection, id, value) => transaction((tx) => tx.put(collection, id, value)),
    list: (collection, filter, limit) => transaction((tx) => tx.list(collection, filter, limit)),
    transaction,
    close: () => pool.end(),
  };
}
module.exports = { relationalAccess, createRelationalRepository };
