const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');
const { mysqlOptions } = require('../selfhost/mysql-repository.cjs');
const migration = require('../selfhost/relational/migration.cjs');

/**
 * 读取迁移命令参数，默认只做只读演练，拒绝混合多个操作。
 * @param {string[]} args Node命令后的选项，私有配置只能传文件路径。
 * @returns {object} configFile、mode、writersPaused与可选backupFile。
 * @throws {Error} 参数缺失、重复或包含未支持选项时停止。
 */
function parseArguments(args) {
  const result = { mode: 'inspect', writersPaused: false },
    modes = [];
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    // 口令不得通过命令行传递，避免进程列表与shell历史记录私密配置。
    if (['--config-file', '--backup-file'].includes(option)) {
      const key = option === '--config-file' ? 'configFile' : 'backupFile';
      if (result[key] || !args[index + 1] || args[index + 1].startsWith('--'))
        throw new Error('文件参数不正确');
      result[key] = path.resolve(args[++index]);
    } else if (['--inspect', '--prepare', '--migrate', '--activate', '--rollback'].includes(option))
      modes.push(option.slice(2));
    else if (option === '--writers-paused') result.writersPaused = true;
    else throw new Error('不支持的迁移参数');
  }
  if (!result.configFile || modes.length > 1) throw new Error('请指定私有配置文件及唯一迁移操作');
  if (modes.length) result.mode = modes[0];
  return result;
}

/**
 * 执行一个显式迁移步骤，连接仅用于指定业务库。
 * @param {string[]} args 命令行选项，默认process.argv.slice(2)。
 * @returns {Promise<object>} 仅包含计数、摘要及动作的执行结果。
 * @throws {Error} 私有配置、数据库权限、备份或校验失败时由命令出口给出稳定错误码。
 */
async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args),
    config = JSON.parse(fs.readFileSync(options.configFile, 'utf8'));
  // 普通跨云连接沿用双向TLS；服务器本机管理连接可使用明确的Unix socket。
  const connectionOptions = config.socketPath
    ? {
        socketPath: config.socketPath,
        user: config.user,
        password: config.password,
        database: config.database,
        charset: 'utf8mb4',
        multipleStatements: false,
      }
    : mysqlOptions(config);
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(config.database || '')) throw new Error('数据库名不正确');
  const connection = await mysql.createConnection(connectionOptions);
  const started = Date.now();
  try {
    let report;
    if (options.mode === 'inspect') {
      // 演练使用一致性只读事务，不执行建表、备份或业务写入。
      await connection.query('START TRANSACTION READ ONLY');
      report = migration.inspectDocuments(await migration.readLegacy(connection));
      await connection.commit();
    } else if (options.mode === 'prepare') {
      await migration.prepareSchema(connection);
      report = { prepared: true };
    } else {
      const operation = {
        migrate: migration.migrateLegacy,
        activate: migration.activateLayout,
        rollback: migration.rollbackLayout,
      }[options.mode];
      report = await operation(connection, options);
    }
    return { action: options.mode, ...report, elapsedMs: Date.now() - started };
  } finally {
    // 不打印数据库异常正文，驱动错误可能包含SQL、家庭标识或连接细节。
    await connection.end();
  }
}
if (require.main === module)
  main()
    .then((result) => console.info(JSON.stringify(result)))
    .catch((error) => {
      console.error(
        JSON.stringify({ migrated: false, errorCode: error.code || 'STORAGE_MIGRATION_FAILED' })
      );
      process.exitCode = 1;
    });
module.exports = { parseArguments, main };
