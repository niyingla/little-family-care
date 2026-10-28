// 复制为config.local.js；envId与templateId不是密钥，仍不必公开实际部署信息。
module.exports = {
  // 云托管模式填写两项；以后切换自有域名时清空这两项并填写apiBaseUrl。
  cloudRunEnvId: '',
  cloudRunService: '',
  // 服务器模式填写已配置的HTTPS域名；云开发模式保持空串。
  apiBaseUrl: '',
  envId: '',
  templateId: '',
};
