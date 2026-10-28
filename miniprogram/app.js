const config = require('./config');
App({
  onLaunch() {
    // 未绑定环境时绝不自动创建、购买或连接其他云资源。
    if (!config.apiBaseUrl && config.envId && wx.cloud) wx.cloud.init({ env: config.envId });
  },
});
