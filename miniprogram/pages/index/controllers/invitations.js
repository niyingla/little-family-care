// 邀请只由管理员签发，卡片携带随机令牌；受邀者接受后立即入家。
const api = require('../../../utils/client');

module.exports = {
  /**
   * 打开新的邀请表单，每次都清空上一位家人的资料和令牌。
   * @returns {void} 等待管理员选填资料并生成邀请。
   */
  openInvite() {
    // 已生成令牌对应不可变的资料，避免编辑表单后分享旧邀请。
    if (this.data.busy) return;
    this.setData({ modal: 'invite', inviteToken: '', inviteForm: { name: '', relation: '' } });
  },

  /**
   * 提交管理员预填资料后生成一次性邀请。
   * @returns {Promise<void>} 成功显示分享入口，失败保留表单供修正。
   */
  async makeInvite() {
    // run负责管理员权限失败提示与重复提交保护，不在客户端授予权限。
    const result = await this.run('makeInvite', { ...this.data.inviteForm });
    if (result) this.setData({ inviteToken: result.token });
  },

  /**
   * 登录后读取邀请卡片的预填资料，网络失败不会绕过邀请校验。
   * @returns {Promise<boolean>} 当前令牌有效且已读取资料时为true。
   */
  async loadInvitePreview() {
    // 只有欢迎页才需要预览邀请，已加入的家人无需重复读取邀请资料。
    const token = this.data.token.trim();
    if (!token || !this.data.gate) return false;
    // 已读同一邀请时保留用户的确认修改，不用重复请求覆盖表单。
    if (this._invitePreview && this._invitePreview.token === token) return true;
    this.setData({ inviteLoading: true, inviteNotice: '' });
    try {
      const profile = await api.call('previewInvite', { token });
      // 请求返回时可能已经切换令牌，旧资料不能填入新的申请表。
      if (this.data.token.trim() !== token) return false;
      const prior = this._invitePreview;
      const update = { inviteNotice: '请核对称呼和家庭身份，点击加入即可回家。' };
      // 请求期间本人已输入的内容优先，异步预填不能覆盖用户的修改。
      if (!this.data.joinName || (prior && this.data.joinName === prior.name))
        update.joinName = profile.name;
      if (!this.data.joinRelation || (prior && this.data.joinRelation === prior.relation))
        update.joinRelation = profile.relation;
      this._invitePreview = { token, ...profile };
      // 缓存只代表预览成功，真正接受邀请仍由服务端原子处理。
      this.setData(update);
      return true;
    } catch (error) {
      // 过期与网络异常直接展示业务提示，不暴露原始响应或邀请内容。
      if (this.data.token.trim() === token) this.setData({ inviteNotice: error.message });
      return false;
    } finally {
      // 旧请求不能清除新卡片请求的加载状态。
      if (this.data.token.trim() === token) this.setData({ inviteLoading: false });
    }
  },

  /**
   * 提交本人确认后的资料并接受管理员邀请，无需管理员二次审核。
   * @returns {Promise<void>} 成功进入家庭清单，失败保留欢迎页。
   */
  async joinFamily() {
    // 服务端再次校验一次性令牌，预览并不占用或消耗邀请。
    if (this.data.busy || !(await this.loadInvitePreview())) return;
    // 提交时使用当前确认后的称呼与家庭身份，不使用预览返回值覆盖本人修改。
    const result = await this.run('applyInvite', {
      token: this.data.token.trim(),
      name: this.data.joinName,
      relation: this.data.joinRelation,
    });
    if (result) await this.boot();
  },
};
