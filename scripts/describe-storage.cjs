const fs = require('node:fs');
const mysql = require('mysql2/promise');
const { mysqlOptions } = require('../selfhost/mysql-repository.cjs');
const { describeSchema } = require('../selfhost/relational/describe.cjs');

/**
 * 为选定业务库补中文注释，默认仅预览，不把凭据放进命令行。
 * @param {string[]} args --config-file私有配置路径，可选--apply实际执行。
 * @returns {Promise<object>} 变更表数、字段数及结构保持校验结果。
 * @throws {Error} 配置不正确、没有ALTER权限或在线注释校验失败时停止。
 */
async function main(args = process.argv.slice(2)) {
  const index = args.indexOf('--config-file');
  // 限制参数形状，不能将连接口令、库名或额外SQL透传给元数据操作。
  if (
    index < 0 ||
    !args[index + 1] ||
    args.some((value, i) => i !== index + 1 && !['--config-file', '--apply'].includes(value))
  )
    throw new Error('请使用--config-file指定私有数据库配置');
  const config = JSON.parse(fs.readFileSync(args[index + 1], 'utf8'));
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(config.database || '')) throw new Error('数据库名不正确');
  const connection = await mysql.createConnection(
    config.socketPath
      ? {
          socketPath: config.socketPath,
          user: config.user,
          password: config.password,
          database: config.database,
          multipleStatements: false,
          charset: 'utf8mb4',
        }
      : mysqlOptions(config)
  );
  try {
    // 只有显式apply才能执行ALTER；读取预览不改变任何数据库字段。
    return await describeSchema(connection, { apply: args.includes('--apply') });
  } finally {
    // 元数据异常正文可能包含DDL，命令出口只输出稳定错误代码。
    await connection.end();
  }
}
if (require.main === module)
  main()
    .then((result) => console.info(JSON.stringify(result)))
    .catch((error) => {
      console.error(
        JSON.stringify({ applied: false, errorCode: error.code || 'STORAGE_DESCRIPTION_FAILED' })
      );
      process.exitCode = 1;
    });
module.exports = { main };
