// 公开配置只保留占位；真实值写config.local.js（已被Git忽略）。
let local = {};
try {
  local = require('./config.local');
} catch (_) {
  /* 未配置时只开放本地体验。 */
}
module.exports = { envId: '', templateId: '', apiBaseUrl: '', ...local };
