const assert = require('node:assert/strict');
const { TABLES, description } = require('./descriptions.cjs');
const quote = (value) => `'${value.replace(/'/g, "''")}'`;

/**
 * 读取当前业务库表及字段元数据，不读取家庭业务行。
 * @param {object} connection 已选定本项目业务库的mysql2管理连接。
 * @returns {Promise<object>} 所有表说明及字段类型、默认值、排序规则等原始定义。
 */
async function metadata(connection) {
  // 固定使用当前连接选定的库，不接收外部表名、库名或任意SQL。
  const [tables] = await connection.execute(
    'SELECT TABLE_NAME AS tableName,TABLE_COMMENT AS comment FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME'
  );
  const [columns] =
    await connection.execute(`SELECT TABLE_NAME AS tableName,COLUMN_NAME AS name,COLUMN_TYPE AS type,
    IS_NULLABLE AS nullable,COLUMN_DEFAULT AS defaultValue,CHARACTER_SET_NAME AS charset,COLLATION_NAME AS collation,
    EXTRA AS extra,COLUMN_KEY AS keyType,ORDINAL_POSITION AS ordinal,COLUMN_COMMENT AS comment
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,ORDINAL_POSITION`);
  return { tables, columns };
}

/**
 * 保留当前列定义，只替换中文注释，拒绝不受支持的生成列和默认表达式。
 * @param {object} column information_schema返回的单列定义。
 * @returns {string} 不改变类型、可空性、字符集或默认值的MODIFY COLUMN片段。
 * @throws {Error} 表/字段未登记、类型或默认值需要人工核对时停止。
 */
function columnDefinition(column) {
  // 类型仅允许本项目实际使用的范围，避免不完整还原未知DDL属性。
  if (
    !/^(?:varchar|char)\(\d+\)$|^(?:tinyint|int|bigint)(?:\(\d+\))?(?: unsigned)?$|^long(?:text|blob)$/.test(
      column.type
    ) ||
    column.extra
  )
    throw new Error('字段定义需要人工核对，未执行注释修改');
  let sql = `MODIFY COLUMN \`${column.name}\` ${column.type}`;
  if (column.charset) {
    // 字符集及排序规则全部保留，不借补注释改变大小写比较或索引语义。
    if (!/^[a-z0-9_]+$/.test(column.charset) || !/^[a-z0-9_]+$/.test(column.collation))
      throw new Error('字段字符集不正确');
    sql += ` CHARACTER SET ${column.charset} COLLATE ${column.collation}`;
  }
  sql += column.nullable === 'YES' ? ' NULL' : ' NOT NULL';
  if (column.defaultValue !== null) {
    // MariaDB元数据中NULL是SQL默认值；字符串默认值不得直接作为表达式拼入DDL。
    const value = String(column.defaultValue);
    if (value === 'NULL') sql += ' DEFAULT NULL';
    else if (/^-?\d+$/.test(value)) sql += ' DEFAULT ' + value;
    else if (/^'(?:[^']|'')*'$/.test(value))
      sql += ' DEFAULT ' + quote(value.slice(1, -1).replace(/''/g, "'"));
    else throw new Error('字段默认值需要人工核对');
  }
  return sql + ' COMMENT ' + quote(description(column.tableName, column.name));
}

/**
 * 补齐所有表及字段的中文COMMENT，默认只预览，应用时禁止表复制和阻塞写入。
 * @param {object} connection 当前业务库管理连接，需ALTER权限。
 * @param {object} options apply为true时执行，否则只返回计划计数。
 * @returns {Promise<object>} 表数、字段数、变更表数及结构保持校验结果。
 * @throws {Error} 未登记列、锁等待、不能在线修改或结构发生差异时明确失败。
 */
async function describeSchema(connection, options = {}) {
  const before = await metadata(connection),
    statements = [];
  for (const table of before.tables) {
    // 在执行第一条DDL之前验证全部说明和列定义，缺字典不留下半套新注释。
    const expected = description(table.tableName),
      clauses = [];
    for (const column of before.columns.filter((c) => c.tableName === table.tableName)) {
      const definition = columnDefinition(column);
      if (column.comment !== description(column.tableName, column.name)) clauses.push(definition);
    }
    if (table.comment !== expected) clauses.push('COMMENT=' + quote(expected));
    if (clauses.length)
      statements.push(
        `ALTER TABLE \`${table.tableName}\` ${clauses.join(',')}, ALGORITHM=INPLACE, LOCK=NONE`
      );
  }
  if (!before.tables.length || before.tables.some((t) => !Object.hasOwn(TABLES, t.tableName)))
    throw new Error('业务库表结构不完整或含未知表');
  if (options.apply) {
    // 等待元数据锁最多5秒，不能因修缮说明长期阻塞小程序的正常读写。
    await connection.query('SET SESSION lock_wait_timeout=5');
    for (const statement of statements) await connection.query(statement);
    const after = await metadata(connection);
    // 注释之外的字段属性必须逐项保持，不能把改了类型误报为仅补说明。
    const structure = (rows) => rows.map(({ comment, ...definition }) => definition);
    assert.deepStrictEqual(structure(after.columns), structure(before.columns));
    for (const table of after.tables) assert.equal(table.comment, description(table.tableName));
    for (const column of after.columns)
      assert.equal(column.comment, description(column.tableName, column.name));
  }
  return {
    tables: before.tables.length,
    columns: before.columns.length,
    changedTables: statements.length,
    applied: !!options.apply,
    structureUnchanged: !!options.apply,
  };
}
module.exports = { metadata, columnDefinition, describeSchema };
