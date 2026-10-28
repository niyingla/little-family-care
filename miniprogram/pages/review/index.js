const api = require('../../utils/client');

Page({
  data: { username: '', password: '', busy: false, error: '' },

  /**
   * 初始化显式账号表单，路由参数不能切换审核模式或注入凭据。
   * @returns {void} 始终从空输入开始，不读取query、存储或上次输入的密码。
   */
  onLoad() {
    // 登录页不接入行为埋点，用户名和口令不会作为点击参数上传。
    this._reviewActive = true;
    this._reviewSucceeded = false;
    this._reviewAttempt = 0;
    this.setData({ username: '', password: '', busy: false, error: '' });
  },

  /**
   * 接收审核账号输入，仅保留当前表单所需的短文本。
   * @param {object} event 用户输入事件，detail.value最多128字符。
   * @returns {void} 只更新内存表单，不写本地存储或日志。
   */
  onUsernameInput(event) {
    // 请求进行时固定本次输入，避免响应对应的账号与页面显示不一致。
    if (this.data.busy) return;
    this.setData({ username: String(event.detail.value || '').slice(0, 128) });
  },

  /**
   * 接收审核专用口令，保留原有空格而不把它当成个人微信密码。
   * @param {object} event 用户输入事件，detail.value最多256字符。
   * @returns {void} 密码仅在当前页面内存中短暂存在。
   */
  onPasswordInput(event) {
    // 不修剪密码内容；验证由审核登录服务按真实口令完成。
    if (this.data.busy) return;
    this.setData({ password: String(event.detail.value || '').slice(0, 256) });
  },

  /**
   * 以显式输入的审核账号登录，成功后才打开主页面的隔离业务数据。
   * @returns {Promise<void>} 失败保留账号及错误说明，任何结果都清除口令。
   * @throws {Error} 常规登录异常在页面内处理，不回退真实微信身份。
   */
  async submitReviewLogin() {
    if (this.data.busy) return;
    const attempt = ++this._reviewAttempt;
    this.setData({ busy: true, error: '' });
    try {
      // 凭据只提交审核登录入口，普通wx.login不会参与这个流程。
      await api.loginReview({ username: this.data.username, password: this.data.password });
      if (!this._reviewActive || attempt !== this._reviewAttempt) return;
      // 跳转不携带账号、密码或令牌，主页面只读取内存中已确认的审核会话。
      this._reviewSucceeded = true;
      this.setData({ username: '', password: '' });
      wx.reLaunch({ url: '/pages/index/index' });
    } catch (error) {
      // 已离开的页面不回写旧错误，更不能因晚到失败跳回普通家庭。
      if (this._reviewActive && attempt === this._reviewAttempt)
        this.setData({ error: error.message || '审核登录暂时失败，请重试' });
    } finally {
      // 不保存口令供自动续期，审核过期后必须由审核人重新明确输入。
      if (this._reviewActive && attempt === this._reviewAttempt)
        this.setData({ password: '', busy: false });
    }
  },

  /**
   * 明确退出审核流程并回到普通微信入口，取消尚未完成的账号登录。
   * @returns {void} 清空表单、令牌和审核图片缓存，不创建或修改正式家庭。
   */
  returnToFamily() {
    // 退出按钮允许取消在途登录，旧响应随后返回也不能再切换审核身份。
    this._reviewAttempt += 1;
    api.exitReview();
    this.setData({ username: '', password: '', busy: false, error: '' });
    wx.reLaunch({ url: '/pages/index/index' });
  },

  /**
   * 销毁登录页时清理凭据，并撤销未成功的异步登录。
   * @returns {void} 成功跳转保留刚建立的审核会话，其余离开路径仅取消请求资格。
   */
  onUnload() {
    this._reviewActive = false;
    // 成功跳转需要保留审核会话；返回或原生退出则必须阻止晚到登录响应生效。
    if (!this._reviewSucceeded) api.cancelReviewLogin();
    this.data.username = '';
    this.data.password = '';
  },
});
