const crypto = require('node:crypto');
const { createService } = require('./service.cjs');
const hash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

/**
 * 封装微信文档数据库，向业务层提供可替换的事务接口。
 * @param {object} db wx-server-sdk创建的云数据库实例，必须支持事务。
 * @returns {object} 单文档读取、写入、受限列表和事务适配器。
 */
function createRepository(db) {
  const wrap = (scope) => ({
    async get(collection, id) {
      try {
        const result = await scope.collection(collection).doc(id).get();
        const data = Array.isArray(result.data) ? result.data[0] : result.data;
        if (!data || !Object.keys(data).length) return null;
        const { _id, ...value } = data;
        return value;
      } catch (error) {
        // 只把“文档不存在”当空值，集合未创建、网络与权限错误原样上抛。
        if (
          /document.*(not exist|not found)|DOCUMENT_NOT_(EXIST|FOUND)/i.test(
            error.message || error.errMsg || ''
          )
        )
          return null;
        throw error;
      }
    },
    async put(collection, id, data) {
      // 数据来自业务白名单，不允许把客户端对象整体写入数据库。
      await scope.collection(collection).doc(id).set({ data });
    },
  });
  return {
    ...wrap(db),
    async list(collection, filter, limit) {
      const result = await db.collection(collection).where(filter).limit(limit).get();
      return result.data.map(({ _id, ...value }) => value);
    },
    async transaction(fn) {
      // SDK处理写冲突重试；回调内禁止微信发送等外部副作用。
      const value = await db.runTransaction((transaction) => fn(wrap(transaction)));
      return value && value.errMsg && Object.prototype.hasOwnProperty.call(value, 'result')
        ? value.result
        : value;
    },
  };
}

/**
 * 装配当前云环境的业务服务。
 * @param {object} cloud 已用DYNAMIC_CURRENT_ENV初始化的wx-server-sdk。
 * @returns {object} 服务实例、存储适配器与哈希工具，不向客户端返回密钥。
 */
function runtime(cloud) {
  const repo = createRepository(cloud.database());
  let fields = {};
  try {
    fields = JSON.parse(process.env.REMIND_FIELDS || '{}');
  } catch (_) {
    // 不把错误JSON当作已配置完成，部署者可以在控制台修正后重新测试。
  }
  const fieldsReady = ['task', 'baby', 'time'].every(
    (key) => typeof fields[key] === 'string' && /^[a-z]+\d+$/.test(fields[key])
  );
  const templateId = fieldsReady ? process.env.REMIND_TEMPLATE_ID || '' : '';
  const options = {
    hash,
    templateId,
    ownerOpenId: process.env.OWNER_OPENID || '',
    randomId: () => crypto.randomBytes(16).toString('hex'),
    now: () => new Date().toISOString(),
    async sendMessage(message) {
      if (!fields.task || !fields.baby || !fields.time)
        throw new Error('请配置真实消息模板字段映射');
      // 模板字段由部署环境决定，不能用示例字段冒充已经验证的微信模板。
      const data = {};
      data[fields.task] = { value: message.title.slice(0, 20) };
      data[fields.baby] = { value: message.babyName.slice(0, 12) };
      data[fields.time] = { value: `${message.date} ${message.time}:00` };
      const result = await cloud.openapi.subscribeMessage.send({
        touser: message.openid,
        templateId,
        page: 'pages/index/index',
        miniprogramState: process.env.MESSAGE_STAGE || 'trial',
        data,
      });
      if (result.errCode || result.errcode)
        throw Object.assign(new Error('微信发送失败'), {
          errCode: result.errCode || result.errcode,
        });
    },
  };
  return { service: createService(repo, options), repo, hash };
}
module.exports = { runtime, createRepository };
