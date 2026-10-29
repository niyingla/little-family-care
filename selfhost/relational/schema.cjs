const { ROOTS, tablesFor } = require('./model.cjs');
const { description } = require('./descriptions.cjs');
const comment = (table, column) => ` COMMENT '${description(table, column).replace(/'/g, "''")}'`;
const SQL_TYPES = {
  string: 'VARCHAR(255)',
  text: 'LONGTEXT',
  number: 'BIGINT',
  boolean: 'TINYINT',
  binary: 'LONGBLOB',
};
// 常用检索列独立建索引，日期、状态和操作者不再依赖JSON_CONTAINS全集合筛选。
const INDEXES = {
  care_members: [['home_id', 'id']],
  care_babies: [['home_id', 'id']],
  care_tasks: [['home_id', 'id']],
  care_task_versions: [['home_id', 'task_id', 'effective_date']],
  care_messages: [
    ['status', 'record_id'],
    ['date', 'record_id'],
    ['recipient_id', 'created_at'],
  ],
  care_activity: [['actor_id', 'occurred_at'], ['occurred_at']],
  care_sessions: [['expires_at']],
  care_invites: [['expires_at']],
  care_files: [['owner_id', 'file_id']],
  care_photo_posts: [['owner_id', 'created_at']],
  care_upload_sessions: [['uploaded_by', 'status']],
};

/**
 * 生成独立业务表的MariaDB/MySQL建表语句，表名与列名均来自静态映射。
 * @returns {string[]} 可逐条执行的DDL；不修改或删除旧care_records。
 */
function schemaStatements() {
  const statements = [
    `CREATE TABLE IF NOT EXISTS care_storage_state (
      id TINYINT NOT NULL PRIMARY KEY${comment('care_storage_state', 'id')},
      schema_version INT NOT NULL${comment('care_storage_state', 'schema_version')},
      layout VARCHAR(16) NOT NULL${comment('care_storage_state', 'layout')},
      verified_digest CHAR(64) NULL${comment('care_storage_state', 'verified_digest')},
      verified_count BIGINT NULL${comment('care_storage_state', 'verified_count')},
      verified_at VARCHAR(40) NULL${comment('care_storage_state', 'verified_at')}
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin${comment('care_storage_state')}`,
    "INSERT IGNORE INTO care_storage_state(id,schema_version,layout) VALUES(1,2,'legacy')",
  ];
  for (const definition of Object.values(ROOTS)) {
    for (const table of tablesFor(definition)) {
      // 数组位置使用整数；业务主键与关联键保留原值，不重新编号。
      const columns = table.keyColumns.map(
        (name) =>
          `\`${name}\` ${name === 'position' || name.endsWith('_position') ? 'INT' : name === 'namespace' ? 'VARCHAR(8)' : 'VARCHAR(128)'} NOT NULL${comment(table.table, name)}`
      );
      columns.push('field_mask BIGINT NOT NULL' + comment(table.table, 'field_mask'));
      for (const spec of Object.values(table.fields)) {
        if (!table.keyColumns.includes(spec.column))
          columns.push(
            `\`${spec.column}\` ${SQL_TYPES[spec.type]} NULL${comment(table.table, spec.column)}`
          );
      }
      columns.push(`PRIMARY KEY (${table.keyColumns.map((name) => `\`${name}\``).join(',')})`);
      // 每个索引先固定隔离空间，正式与审核相同ID也不混在一次查询中。
      for (const [index, names] of (INDEXES[table.table] || []).entries())
        columns.push(
          `KEY idx_${index} (namespace,${names.map((name) => `\`${name}\``).join(',')})`
        );
      statements.push(
        `CREATE TABLE IF NOT EXISTS \`${table.table}\` (${columns.join(',\n')}) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin${comment(table.table)}`
      );
    }
  }
  return statements;
}
module.exports = { schemaStatements };
