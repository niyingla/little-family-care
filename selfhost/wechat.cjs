/**
 * 微信服务端接口适配；密钥只存在服务端环境，不向小程序返回。
 * @param {object} config appId/appSecret/templateId/fields/messageStage。
 * @returns {object} 登录凭证交换和订阅消息发送接口。
 */
function createWechat(config) {
  let token = '',
    expiresAt = 0,
    refreshing = null;
  async function request(url, options) {
    // 不记录带AppSecret或access_token的外部URL。
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error('微信接口暂时不可用');
    const result = await response.json();
    if (result.errcode)
      throw Object.assign(new Error('微信接口未接受请求'), { errCode: result.errcode });
    return result;
  }
  async function accessToken() {
    if (token && Date.now() < expiresAt) return token;
    if (!refreshing)
      refreshing = (async () => {
        const url = new URL('https://api.weixin.qq.com/cgi-bin/token');
        url.search = new URLSearchParams({
          grant_type: 'client_credential',
          appid: config.appId,
          secret: config.appSecret,
        });
        const result = await request(url);
        if (!result.access_token) throw new Error('微信接口配置尚未完成');
        token = result.access_token;
        expiresAt = Date.now() + Math.max(60, result.expires_in - 300) * 1000;
        return token;
      })().finally(() => {
        refreshing = null;
      });
    return refreshing;
  }
  return {
    async exchangeCode(code) {
      if (!config.appId || !config.appSecret) throw new Error('服务器的小程序登录配置尚未完成');
      const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
      url.search = new URLSearchParams({
        appid: config.appId,
        secret: config.appSecret,
        js_code: code,
        grant_type: 'authorization_code',
      });
      const result = await request(url);
      if (!result.openid) throw new Error('微信登录失败，请重新进入小程序');
      // session_key无需用于当前业务，不保存也不返回给客户端。
      return { openid: result.openid };
    },
    async sendMessage(message) {
      const fields = config.fields;
      const data = {};
      data[fields.task] = { value: message.title.slice(0, 20) };
      data[fields.baby] = { value: message.subjectName.slice(0, 12) };
      data[fields.time] = { value: `${message.date} ${message.time}:00` };
      const auth = await accessToken();
      await request(
        `https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${encodeURIComponent(auth)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            touser: message.openid,
            template_id: config.templateId,
            page: 'pages/index/index',
            miniprogram_state: config.messageStage || 'trial',
            data,
          }),
        }
      );
    },
  };
}
module.exports = { createWechat };
