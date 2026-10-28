/**
 * 创建可配置的后端入口，云托管与自有HTTPS域名复用同一业务协议。
 * @param {object} config 云环境ID、服务名或已备案HTTPS接口地址。
 * @param {object} platform 微信API对象；测试可注入受控传输边界。
 * @param {object} session 仅由客户端受控会话创建，review为true时使用隔离审核路由。
 * @returns {Function} request(path,data,token,options)，返回原始HTTP状态及响应。
 */
function createTransport(config, platform, session = {}) {
  // 实例始终复用创建时选定的传输配置，避免同一请求链中途更换数据环境。
  const review = session.review === true;
  /**
   * 根据已创建的会话选择业务前缀，绝不从页面query或请求正文推断审核身份。
   * @param {string} path 业务固定入口或后端返回的私有图片相对地址。
   * @returns {string} 同一环境内匹配当前身份的路由，审核图片前缀不会被重复拼接。
   * @throws {Error} 正式会话调用审核资源，或审核会话混用正式图片地址时拒绝。
   */
  function routeFor(path) {
    // 路由只接受字符串，异常对象不能通过隐式转换形成另一个后端入口。
    if (typeof path !== 'string') throw new Error('家庭服务请求路径不正确');
    if (!review) {
      // 正式身份永远不能发送到审核命名空间，令牌与资源均保持同域隔离。
      if (path.startsWith('/review/')) throw new Error('当前家庭会话不能读取审核资源');
      return path;
    }
    // 审核登录与业务接受内部固定相对入口，外部页面参数不能指定身份或环境。
    if (path === '/api/login' || path === '/api/call') return '/review' + path;
    if (path === '/review/api/login' || path === '/review/api/call') return path;
    // 图片签名已经绑定审核前缀，不能剥离成正式路径或为正式签名补造审核前缀。
    if (/^\/review\/api\/avatar\/[a-f0-9]{32}\.(png|jpg)\?/.test(path)) return path;
    throw new Error('审核图片地址或请求路径不正确，请重新登录审核账号');
  }
  /**
   * 将家庭业务请求发送到当前配置的唯一后端入口。
   * @param {string} path 业务接口或私有资源的相对路径。
   * @param {*} data 请求载荷；二进制GET场景可不传。
   * @param {string} token 当前会话令牌；空值表示不附加会话头。
   * @param {object} options 可选method、header与responseType传输参数。
   * @returns {Promise<object>} 原始HTTP响应，由调用方判断业务状态。
   * @throws {Error} 环境配置不完整、入口不安全或网络失败时拒绝请求。
   */
  return async function request(path, data, token, options = {}) {
    // 在组装授权头之前确认命名空间，错误路由不能携带当前令牌发出网络请求。
    const target = routeFor(path);
    // 令牌仅进入授权头，不拼入URL，避免被地址缓存或引用链泄露。
    const header = {
      'content-type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      // Range等资源请求头由统一入口传入，保留二进制分段下载能力。
      ...(options.header || {}),
    };
    // 只切换传输入口，不改动登录、邀请和执行记录的业务数据结构。
    const parameters = {
      method: options.method || 'POST',
      data,
      // 大图完成需跨云读取、清空至多214片；只给固定完成动作更长预算，失败不自动重发。
      timeout:
        ['/api/call', '/review/api/call'].includes(target) &&
        data &&
        data.action === 'finishImageUpload'
          ? 60000
          : 15000,
      header,
      ...(options.responseType ? { responseType: options.responseType } : {}),
    };
    if (config.cloudRunEnvId || config.cloudRunService) {
      // 半配置也视为云托管模式并报错，不能静默把家庭请求发往另一环境。
      if (!config.cloudRunEnvId || !config.cloudRunService)
        throw new Error('微信云托管配置尚未完整');
      if (!platform.cloud || !platform.cloud.callContainer)
        throw new Error('请升级微信后使用家庭共享服务');
      // 配置云托管时绝不回退到旧域名，防止请求落到错误的数据环境。
      try {
        return await platform.cloud.callContainer({
          ...parameters,
          config: { env: config.cloudRunEnvId },
          path: target,
          header: { ...header, 'X-WX-SERVICE': config.cloudRunService },
        });
      } catch (_) {
        // 平台原始异常可能含环境与网络信息，页面只获得固定的重试提示。
        throw new Error('家庭服务暂时连接不上，请稍后重试');
      }
    }
    // 自有域名必须使用HTTPS，会话令牌与家庭数据不通过明文传输。
    if (!/^https:\/\//.test(config.apiBaseUrl || '')) throw new Error('请配置家庭服务的HTTPS域名');
    // 后续清空云托管配置并填写新域名，即可切回已有的HTTPS部署方式。
    return new Promise((resolve, reject) =>
      // 保持原始状态码，业务拒绝响应不能被传输层误判为网络失败。
      platform.request({
        ...parameters,
        url: config.apiBaseUrl.replace(/\/$/, '') + target,
        success: resolve,
        fail: () => reject(new Error('家庭服务暂时连接不上，请稍后重试')),
      })
    );
  };
}
module.exports = { createTransport };
