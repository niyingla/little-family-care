// 完成照片是可选留档；此模块只负责选图、上传和预览，不修改事项状态。
const api = require('../../../utils/client');
const { MAX_IMAGE_BYTES } = require('../../../utils/media-policy');

module.exports = {
  /**
   * 由用户主动拍摄或选取一张照片，上传成功后交由调用方提交完成事务。
   * @param {object} row 当前页面的待完成事项，id必须来自当天清单。
   * @returns {Promise<?string>} 上传成功的photoId；取消、失败或忙碌时返回null。
   * @throws {Error} 常规选图与上传异常在方法内展示并转换为null，不向完成流程透传。
   */
  async chooseCompletionPhoto(row) {
    // 选择器打开期间锁定入口，避免同一事项因连续点击发起多个并行上传。
    if (this.data.busy) return null;
    const date = this.data.date;
    this.setData({ busy: true });
    try {
      // 相机和相册都由系统授权界面处理，只读取用户主动选中的一张压缩图片。
      const response = await wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sourceType: ['camera', 'album'],
        sizeType: ['compressed'],
      });
      const file = response.tempFiles && response.tempFiles[0];
      // 系统未返回所选文件时视为未选图，不能沿用上一次选择的照片。
      if (!file) return null;
      if (file.size > MAX_IMAGE_BYTES) throw new Error('请选择10MB以内的照片，或先裁剪压缩');
      // 只读取用户明确选中的临时路径，不遍历相册或上传其他本地文件。
      const base64 = wx.getFileSystemManager().readFileSync(file.tempFilePath, 'base64');
      // 日期保留用户开始选图时的页面值；跨日后由后端拒绝，不能静默归到次日。
      const uploaded = await api.call('uploadCompletionPhoto', { taskId: row.id, date, base64 });
      if (!uploaded || !uploaded.photoId) throw new Error('照片上传失败，请重试或选择直接完成');
      return uploaded.photoId;
    } catch (error) {
      // 取消不提示错误；失败保留明确说明，返回null阻止调用方误勾选事项。
      if (!/cancel/i.test(error.errMsg || ''))
        wx.showToast({ title: error.message || '照片选择失败，请使用JPG或PNG', icon: 'none' });
      return null;
    } finally {
      // 取消和失败也要释放忙碌状态，让用户随后仍可选择直接完成。
      this.setData({ busy: false });
    }
  },

  /**
   * 按需加载已关联的完成照片，不在自动刷新时批量下载历史图片。
   * @param {object} event 点击事件，dataset可含url或photoId、taskId及所属date。
   * @returns {Promise<void>} 授权并缓存成功后预览，失败保留提示且不打开空图片。
   * @throws {Error} 常规授权、下载及预览错误在方法内提示，不改变事项完成状态。
   */
  async previewCompletionPhoto(event) {
    // 空点击不触发网络请求，避免没有留档的事项出现无意义错误。
    const data = (event && event.currentTarget && event.currentTarget.dataset) || {};
    if (!data.url && !data.photoId) return;
    try {
      let url = data.url;
      // 较早流水没有快照短链时，服务端重新检查成员权限及精确执行记录关联。
      if (!url) {
        const result = await api.call('completionPhoto', {
          photoId: data.photoId,
          taskId: data.taskId,
          date: data.date,
        });
        url = result.photoUrl;
      }
      if (!url) throw new Error('照片暂时无法加载，请稍后重试');
      // 云托管签名相对路径按现有私有分段缓存下载，其他入口由适配层处理。
      const local = await api.loadPrivateImage(url);
      // 下载必须真正得到可预览文件；短链字符串本身不能冒充加载成功。
      if (!local) throw new Error('照片暂时无法加载，请稍后重试');
      await wx.previewImage({ current: local, urls: [local] });
    } catch (error) {
      // 下载失败不等同于照片不存在，也不能把未完成加载的链接交给系统预览。
      wx.showToast({ title: error.message || '照片加载失败，请稍后重试', icon: 'none' });
    }
  },
};
