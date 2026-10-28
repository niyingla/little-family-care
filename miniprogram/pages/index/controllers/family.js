// 宝宝资料、成员邀请与订阅交互；真实身份由云端获取。
const api = require('../../../utils/client');
module.exports = {
  /**
   * 打开宝宝资料弹窗，区分已有资料与空白新建表单。
   * @param {object} e 可选点击事件，dataset.id存在时读取对应宝宝。
   * @returns {void} 设置表单副本，不立即写入家庭共享资料。
   */
  openBaby(e) {
    // 先按家庭已有宝宝定位，表单展示与持久化提交分开，取消不会改资料。
    const id = e && e.currentTarget.dataset.id;
    const baby = this.data.babies.find((b) => b.id === id);
    this.setData({
      modal: 'baby',
      // 编辑保留头像资源标识与展示路径；新建不继承上次弹窗的临时图片。
      babyForm: baby
        ? { babyId: id, name: baby.name, avatar: baby.avatar, picture: baby.picture }
        : { name: '', avatar: '', picture: '' },
    });
  },
  /**
   * 经用户主动选择后处理一张头像，并保留真实与体验存储边界。
   * @returns {Promise<void>} 更新表单图片或显示选择失败提示。
   */
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
      // 上传前限制体量，避免大图在base64转换和私有缓存中放大内存占用。
      if (file.size > 1024 * 1024) throw new Error('请选择1MB以内的图片，或先裁剪压缩');
      if (this.data.demo) {
        // 体验头像只持久化在微信沙盒，不调用真实家庭上传接口。
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
        // 真实头像通过鉴权业务入口上传，页面只暂存资源标识与本地预览路径。
        this.setData({ busy: true });
        const base64 = wx.getFileSystemManager().readFileSync(file.tempFilePath, 'base64');
        const upload = await api.call('uploadAvatar', { base64 });
        // 上传成功只更新待保存表单，宝宝资料在用户保存后才提交。
        this.setData({ 'babyForm.avatar': upload.fileID, 'babyForm.picture': file.tempFilePath });
      }
    } catch (error) {
      // 用户取消系统选择器是正常路径，不用失败提示干扰返回操作。
      if (!/cancel/.test(error.errMsg || ''))
        wx.showToast({ title: error.message || '图片选择失败，请使用JPG或PNG', icon: 'none' });
    } finally {
      // 选择、上传或异常退出都释放忙碌态，避免弹窗永久无法关闭。
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

  /**
   * 确认后申请撤销一名家庭成员的访问权限。
   * @param {object} e 点击事件，dataset.id为被移除成员ID。
   * @returns {Promise<void>} 用户取消时不请求；权限与历史边界由服务端校验。
   */
  async removeMember(e) {
    // 明确说明权限立即失效与历史保留，避免把移除误解为删除过去执行事实。
    const response = await wx.showModal({
      title: '移除这位家人？',
      content: '移除后立即失去访问权限，历史执行记录保留。该家人的任务需要重新分配。',
    });
    // 仅确认才提交成员ID，管理员身份与是否允许移除仍在服务端验证。
    if (response.confirm) await this.run('removeMember', { memberId: e.currentTarget.dataset.id });
  },
  async saveProfile() {
    await this.run('profile', { name: this.data.profileName });
  },
  async createFamily() {
    if (await this.run('createHome', { name: this.data.joinName })) await this.boot();
  },
  copyIdentity() {
    wx.setClipboardData({ data: this.data.bootstrap.openid });
  },
  /**
   * 由用户主动触发微信订阅授权，并记录明确同意的结果。
   * @returns {Promise<void>} 完成授权交互或提示，拒绝不记作订阅成功。
   */
  async subscribe() {
    // 体验模式和未配置模板都不能申请真实授权，也不能展示模拟成功。
    if (this.data.demo || !api.config.templateId) {
      wx.showModal({
        title: '微信提醒待接入',
        content: '需要真实小程序和可用的订阅消息模板。本地体验不会向家人发送消息。',
        showCancel: false,
      });
      return;
    }
    try {
      // 只请求当前已配置的模板，授权对象由微信系统弹窗呈现给用户确认。
      const answer = await wx.requestSubscribeMessage({ tmplIds: [api.config.templateId] });
      // 只有明确accept才告知后端，关闭弹窗或拒绝不会增加可发送授权记录。
      if (answer[api.config.templateId] === 'accept')
        await this.run('subscribe', { templateId: api.config.templateId, accepted: true });
      else wx.showToast({ title: '你尚未同意接收提醒', icon: 'none' });
    } catch (_) {
      // 平台原始错误可能包含环境信息，统一向页面提供可理解的配置提示。
      wx.showToast({ title: '订阅暂时不可用，请检查模板配置', icon: 'none' });
    }
  },
};
