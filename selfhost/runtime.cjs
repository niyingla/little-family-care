const fs = require('node:fs');
const path = require('node:path');
const { gunzipSync } = require('node:zlib');
const { createSQLiteRepository } = require('./sqlite-repository.cjs');
const { createMySQLRepository } = require('./mysql-repository.cjs');

/**
 * 读取私有数据库配置，兼容早期JSON与平台长度限制下的gzip编码。
 * @param {string} encoded 部署端生成的base64，内容只能是JSON或gzip压缩JSON。
 * @returns {object} 供连接层继续校验的数据库配置。
 * @throws {Error} 编码、压缩内容或JSON无效时拒绝启动。
 */
function decodeDatabaseConfig(encoded) {
  // 配置缺失直接失败，不能把空值解码后误判为有效的默认数据库。
  if (!encoded) throw new Error('请配置阿里云数据库连接');
  const bytes = Buffer.from(encoded, 'base64');
  // 以gzip文件头识别新格式，旧部署不必同步修改已有环境变量。
  const compressed = bytes[0] === 0x1f && bytes[1] === 0x8b;
  // 解压上限约束异常配置的内存占用；base64与gzip本身都不提供保密性。
  const json = compressed ? gunzipSync(bytes, { maxOutputLength: 64 * 1024 }) : bytes;
  return JSON.parse(json.toString('utf8'));
}

/**
 * 装配可迁移的运行环境，业务数据不依赖云托管容器本地目录。
 * @param {object} env 服务端环境变量；真实密钥只通过部署环境注入。
 * @returns {Promise<object>} 持久repo与HTTP、提醒任务共用的config。
 * @throws {Error} 连接或消息字段JSON无效时拒绝启动，避免误用空环境。
 */
async function createRuntime(env = process.env) {
  // 相对路径只用于文件存储模式，统一解析后供头像和SQLite复用。
  const dataDir = path.resolve(env.DATA_DIR || './local-data');
  const mysql = env.DATABASE_DRIVER === 'mysql';
  // MySQL模式不创建本地业务文件，容器中的临时目录仅供运行时使用。
  if (!mysql) fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const config = {
    dataDir,
    avatarStorage: mysql ? 'database' : 'filesystem',
    // 身份、微信密钥及签名材料仅驻留运行时配置，不输出到启动日志。
    ownerOpenId: env.OWNER_OPENID || '',
    appId: env.WX_APP_ID || '',
    appSecret: env.WX_APP_SECRET || '',
    templateId: env.REMIND_TEMPLATE_ID || '',
    // 提醒字段必须是可解析JSON，错误配置在启动阶段暴露而非扫描中吞掉。
    fields: JSON.parse(env.REMIND_FIELDS || '{}'),
    // 消息阶段随部署环境显式选择，供HTTP请求与独立扫描使用同一配置。
    messageStage: env.MESSAGE_STAGE || 'trial',
    signingSecret: env.SIGNING_SECRET || '',
    // 统一去掉末尾斜杠，避免生成公开入口或私有资源地址时重复分隔符。
    publicOrigin: String(env.PUBLIC_ORIGIN || '').replace(/\/$/, ''),
  };
  let repo;
  if (mysql) {
    // 压缩减少平台环境变量占用，不是加密；真实证书仍只在私有环境中传递。
    const options = decodeDatabaseConfig(env.MYSQL_CONFIG_BASE64);
    repo = await createMySQLRepository(options);
  } else repo = createSQLiteRepository(path.join(dataDir, 'family.sqlite'));
  // 只返回已完成连接验证的仓库，调用方无需自行选择或重建存储驱动。
  return { repo, config };
}
module.exports = { createRuntime, decodeDatabaseConfig };
