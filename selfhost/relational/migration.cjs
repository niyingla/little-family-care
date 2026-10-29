const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { ROOTS, encodeDocument, decodeDocument, tablesFor } = require('./model.cjs');
const { relationalAccess } = require('./repository.cjs');
const { schemaStatements } = require('./schema.cjs');

/**
 * 对对象键排序以生成与JSON属性顺序无关的迁移摘要。
 * @param {*} value 已解析的旧业务值，不包含连接配置或密钥。
 * @returns {*} 保留数组顺序及所有字段值的规范化副本。
 */
function canonical(value) {
  // 数组顺序属于历史语义；只有对象属性可按名称重新排列。
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((name) => [name, canonical(value[name])])
    );
  return value;
}

/**
 * 验证旧记录能无损拆表，生成不含家庭内容的统计与摘要。
 * @param {object[]} documents 按collection/id排序的旧记录，body为解析后的JSON。
 * @returns {object} 文档数量、分类数量、实体表数量及SHA256摘要。
 * @throws {Error} 未映射字段、损坏图片或还原不一致时阻断迁移。
 */
function inspectDocuments(documents) {
  const byCollection = {},
    byTable = {},
    digest = crypto.createHash('sha256');
  for (const document of documents) {
    // 在接触新表之前完成内存往返验证，任何遗漏都不能被计数校验掩盖。
    const rows = encodeDocument(document.collection, document.id, document.body);
    assert.deepStrictEqual(decodeDocument(document.collection, document.id, rows), document.body);
    byCollection[document.collection] = (byCollection[document.collection] || 0) + 1;
    // 一份家庭可能拆成多行，分别统计实体行，不能把文档数误当成新表行数。
    for (const row of rows) byTable[row.table] = (byTable[row.table] || 0) + 1;
    digest.update(JSON.stringify(canonical(document)) + '\n');
  }
  return { count: documents.length, byCollection, byTable, digest: digest.digest('hex') };
}

/**
 * 读取旧表的一致快照，仅供演练或已暂停写入的迁移事务调用。
 * @param {object} connection 当前mysql2连接。
 * @returns {Promise<object[]>} 按固定主键排序的旧JSON对象，不打印或记录内容。
 */
async function readLegacy(connection) {
  // 只读取业务表，不枚举系统用户、授权口令或其他数据库。
  const [rows] = await connection.execute(
    'SELECT collection,id,body FROM care_records ORDER BY collection,id'
  );
  return rows.map((row) => ({
    collection: row.collection,
    id: row.id,
    body: JSON.parse(row.body),
  }));
}

/**
 * 新建分表结构；保留原表和原业务布局，不在启动时自动执行DDL。
 * @param {object} connection 拥有本业务库建表权限的管理连接。
 * @returns {Promise<void>} 全部建表语句执行完成。
 * @throws {Error} 权限不足或结构冲突时直接失败，不更改旧表。
 */
async function prepareSchema(connection) {
  // MariaDB的DDL会隐式提交，因此与数据搬迁事务明确分开执行。
  for (const sql of schemaStatements()) await connection.execute(sql);
}

/**
 * 以排他文件方式保存私有快照，拒绝覆盖备份和把家庭数据写入代码仓库。
 * @param {string} filename 操作者提供的绝对路径，父目录须已存在且为私有目录。
 * @param {object[]} documents 本次操作前的完整业务快照。
 * @returns {void} 写入完成并fsync；不输出文件内容。
 * @throws {Error} 路径不安全、文件已存在或磁盘写入失败时停止迁移。
 */
function writeBackup(filename, documents) {
  if (!path.isAbsolute(filename || '')) throw new Error('备份必须使用私有目录的绝对路径');
  const repository = path.resolve(__dirname, '../..');
  const target = path.resolve(filename);
  // 备份可能包含真实照片及微信身份，不能进入公开代码或镜像构建目录。
  const relative = path.relative(repository, target);
  if (!relative || (!relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)))
    throw new Error('不能将家庭备份写入代码仓库');
  const descriptor = fs.openSync(target, 'wx', 0o600);
  try {
    // 逐条写入避免生成额外一份完整Base64字符串，文件必须落盘才可删除目标旧副本。
    for (const document of documents) fs.writeSync(descriptor, JSON.stringify(document) + '\n');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * 在维护窗口内执行迁移或激活，异常必须整体回滚。
 * @param {object} connection 管理连接，需读写业务表但不修改数据库账号。
 * @param {boolean} writersPaused 操作者确认所有HTTP写入与定时提醒已暂停。
 * @param {Function} fn 当前事务下的操作回调。
 * @returns {Promise<*>} 提交后的结果。
 * @throws {Error} 未暂停写入或任一步失败时拒绝提交。
 */
async function maintenanceTransaction(connection, writersPaused, fn) {
  // 旧版本存在非事务单行写入，互斥锁本身不足以代替真实暂停全部写入者。
  if (writersPaused !== true) throw new Error('迁移前必须暂停所有应用及提醒任务写入');
  await connection.beginTransaction();
  try {
    await connection.execute('SELECT id FROM care_mutex WHERE id=1 FOR UPDATE');
    const [state] = await connection.execute(
      'SELECT * FROM care_storage_state WHERE id=1 FOR UPDATE'
    );
    if (state[0]?.schema_version !== 2) throw new Error('请先执行分表建表步骤');
    const result = await fn(state[0]);
    await connection.commit();
    return result;
  } catch (error) {
    // 回滚只影响本次新表写入；旧care_records与磁盘备份始终保留。
    await connection.rollback();
    throw error;
  }
}

/**
 * 将旧数据全量迁入独立表，逐文档、逐表数量及内容摘要校验后标记ready。
 * @param {object} connection 已完成建表的业务库管理连接。
 * @param {object} options writersPaused及绝对backupFile，备份不允许覆盖。
 * @returns {Promise<object>} 不含家庭内容的迁移统计，尚未激活线上切换。
 * @throws {Error} 正在使用新表、备份失败或任何数据不一致时整体回滚。
 */
async function migrateLegacy(connection, options) {
  return maintenanceTransaction(connection, options.writersPaused, async (state) => {
    if (!['legacy', 'ready'].includes(state.layout))
      throw new Error('新表已激活，不能用旧快照覆盖');
    const documents = await readLegacy(connection),
      report = inspectDocuments(documents);
    if (!documents.length) throw new Error('旧业务库为空，请先核对目标数据库');
    writeBackup(options.backupFile, documents);
    // 只清理本工具创建且尚未激活的分表副本，旧表完全不动；失败时恢复清理前状态。
    const tables = Object.values(ROOTS).flatMap(tablesFor).reverse();
    for (const table of tables)
      await connection.execute(
        `DELETE FROM \`${table.table}\` WHERE namespace IN ('family','review')`
      );
    const target = relationalAccess(connection);
    for (const document of documents) {
      await target.put(document.collection, document.id, document.body);
      // 比较原始JSON语义，姓名、邀请状态、照片字节及历史顺序均必须一致。
      assert.deepStrictEqual(await target.get(document.collection, document.id), document.body);
    }
    for (const table of tables) {
      const [counts] = await connection.execute(
        `SELECT COUNT(*) AS total FROM \`${table.table}\` WHERE namespace IN ('family','review')`
      );
      if (Number(counts[0].total) !== (report.byTable[table.table] || 0))
        throw new Error('分表记录数量校验失败');
    }
    await connection.execute(
      "UPDATE care_storage_state SET layout='ready',verified_digest=?,verified_count=?,verified_at=? WHERE id=1",
      [report.digest, report.count, new Date().toISOString()]
    );
    return report;
  });
}

/**
 * 在全部写入仍暂停时最终激活，防止演练后又有旧数据写入而漏迁。
 * @param {object} connection 同一业务库管理连接。
 * @param {object} options writersPaused为真正完成维护隔离的确认。
 * @returns {Promise<object>} 最终数量与摘要；随后才可启动relational布局的新服务。
 * @throws {Error} 旧数据变化、新表损坏或迁移未完成时拒绝切换。
 */
async function activateLayout(connection, options) {
  return maintenanceTransaction(connection, options.writersPaused, async (state) => {
    if (state.layout !== 'ready') throw new Error('分表迁移未完成，不能激活');
    const documents = await readLegacy(connection),
      report = inspectDocuments(documents);
    if (state.verified_digest !== report.digest || Number(state.verified_count) !== report.count)
      throw new Error('迁移后旧数据已变化，请重新备份并迁移');
    const target = relationalAccess(connection);
    // 激活前重新读取每份新表对象，不能只信任上次迁移留下的成功标记。
    for (const document of documents)
      assert.deepStrictEqual(await target.get(document.collection, document.id), document.body);
    await connection.execute("UPDATE care_storage_state SET layout='active' WHERE id=1");
    return report;
  });
}

/**
 * 从独立表读取全部文档以生成回滚快照，读取同一维护事务。
 * @param {object} connection 当前数据库连接。
 * @returns {Promise<object[]>} 正式与审核分别重建的业务对象，顺序与旧表一致。
 */
async function readRelational(connection) {
  const documents = [],
    target = relationalAccess(connection);
  for (const [collection, definition] of Object.entries(ROOTS)) {
    // 只遍历静态根表，不读取系统库或调用方给出的任意标识符。
    const [rows] = await connection.execute(
      `SELECT namespace,record_id FROM \`${definition.table}\` ORDER BY namespace,record_id`
    );
    for (const row of rows) {
      if (!['family', 'review'].includes(row.namespace))
        throw new Error('存在未识别的分表命名空间');
      const name = row.namespace === 'review' ? `review_${collection}` : collection;
      documents.push({
        collection: name,
        id: row.record_id,
        body: await target.get(name, row.record_id),
      });
    }
  }
  return documents.sort((a, b) =>
    a.collection < b.collection
      ? -1
      : a.collection > b.collection
        ? 1
        : a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0
  );
}

/**
 * 回滚时先把切换后的最新数据同步回旧表，避免直接回旧代码丢失新操作。
 * @param {object} connection 已暂停所有新旧应用写入的管理连接。
 * @param {object} options writersPaused及全新私有backupFile。
 * @returns {Promise<object>} 回写校验结果；随后才能切回legacy布局并恢复服务。
 * @throws {Error} 尚未激活、备份失败或回写不一致时整体回滚。
 */
async function rollbackLayout(connection, options) {
  return maintenanceTransaction(connection, options.writersPaused, async (state) => {
    if (state.layout !== 'active') throw new Error('当前不处于已激活分表布局');
    const documents = await readRelational(connection),
      report = inspectDocuments(documents);
    if (!documents.length) throw new Error('分表数据为空，拒绝覆盖旧库');
    writeBackup(options.backupFile, documents);
    for (const document of documents)
      await connection.execute(
        'INSERT INTO care_records(collection,id,body) VALUES(?,?,?) ON DUPLICATE KEY UPDATE body=VALUES(body)',
        [document.collection, document.id, JSON.stringify(document.body)]
      );
    // 发现旧表存在额外游离数据也拒绝提交，不能悄悄删除作为回滚依据的原记录。
    const after = inspectDocuments(await readLegacy(connection));
    if (after.digest !== report.digest || after.count !== report.count)
      throw new Error('回写旧表校验不一致');
    await connection.execute(
      "UPDATE care_storage_state SET layout='legacy',verified_digest=?,verified_count=?,verified_at=? WHERE id=1",
      [report.digest, report.count, new Date().toISOString()]
    );
    return report;
  });
}
module.exports = {
  canonical,
  inspectDocuments,
  readLegacy,
  prepareSchema,
  migrateLegacy,
  activateLayout,
  rollbackLayout,
};
