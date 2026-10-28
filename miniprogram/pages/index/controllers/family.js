// 宝宝资料、成员邀请与订阅交互；真实身份由云端获取。
const api = require('../../../utils/client');
module.exports = {
  openBaby(e) {
    const id = e && e.currentTarget.dataset.id;
    const baby = this.data.babies.find((b) => b.id === id);
    this.setData({
      modal: 'baby',
      babyForm: baby
        ? { babyId: id, name: baby.name, avatar: baby.avatar, picture: baby.picture }
        : { name: '', avatar: '', picture: '' },
    });
  },
  async chooseAvatar() {
    try {
      // 使用系统相册/相机入口；只读取用户主动选中的这一张图片。
      const response = await wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sourceType: ['album', 'camera'],
        sizeType: ['compressed'],
      });
      const file = response.tempFiles[0];
      if (file.size > 1024 * 1024) throw new Error('请选择1MB以内的图片，或先裁剪压缩');
      if (this.data.demo) {
        const saved = await new Promise((resolve, reject) =>
          wx
            .getFileSystemManager()
            .saveFile({ tempFilePath: file.tempFilePath, success: resolve, fail: reject })
        );
        this.setData({
          'babyForm.avatar': saved.savedFilePath,
          'babyForm.picture': saved.savedFilePath,
        });
      } else {
        this.setData({ busy: true });
        const base64 = wx.getFileSystemManager().readFileSync(file.tempFilePath, 'base64');
        const upload = await api.call('uploadAvatar', { base64 });
        this.setData({ 'babyForm.avatar': upload.fileID, 'babyForm.picture': file.tempFilePath });
      }
    } catch (error) {
      if (!/cancel/.test(error.errMsg || ''))
        wx.showToast({ title: error.message || '图片选择失败，请使用JPG或PNG', icon: 'none' });
    } finally {
      this.setData({ busy: false });
    }
  },
  async saveBaby() {
    if (await this.run('saveBaby', this.data.babyForm)) this.closeModal();
  },
  closeModal() {
    if (!this.data.busy) this.setData({ modal: '' });
  },
  noop() {},

  async makeInvite() {
    const result = await this.run('makeInvite', {});
    if (result) this.setData({ modal: 'invite', inviteToken: result.token });
  },
  copyInvite() {
    wx.setClipboardData({ data: this.data.inviteToken });
  },
  async review(e) {
    await this.run('reviewInvite', {
      requestId: e.currentTarget.dataset.id,
      approve: e.currentTarget.dataset.approve === 'yes',
    });
  },
  async removeMember(e) {
    const response = await wx.showModal({
      title: '移除这位家人？',
      content: '移除后立即失去访问权限，历史执行记录保留。该家人的任务需要重新分配。',
    });
    if (response.confirm) await this.run('removeMember', { memberId: e.currentTarget.dataset.id });
  },
  async saveProfile() {
    await this.run('profile', { name: this.data.profileName });
  },
  async createFamily() {
    if (await this.run('createHome', { name: this.data.joinName })) await this.boot();
  },
  async joinFamily() {
    if (await this.run('applyInvite', { token: this.data.token, name: this.data.joinName }))
      await this.boot();
  },
  copyIdentity() {
    wx.setClipboardData({ data: this.data.bootstrap.openid });
  },
  async subscribe() {
    if (this.data.demo || !api.config.templateId) {
      wx.showModal({
        title: '微信提醒待接入',
        content: '需要真实小程序和可用的订阅消息模板。本地体验不会向家人发送消息。',
        showCancel: false,
      });
      return;
    }
    try {
      const answer = await wx.requestSubscribeMessage({ tmplIds: [api.config.templateId] });
      if (answer[api.config.templateId] === 'accept')
        await this.run('subscribe', { templateId: api.config.templateId, accepted: true });
      else wx.showToast({ title: '你尚未同意接收提醒', icon: 'none' });
    } catch (_) {
      wx.showToast({ title: '订阅暂时不可用，请检查模板配置', icon: 'none' });
    }
  },
};
