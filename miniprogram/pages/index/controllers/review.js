const api = require('../../../utils/client');
const { emptyTask } = require('../../../utils/forms');

/**
 * 在改变身份之前停止后台任务并撤下所有当前家庭资料。
 * @param {object} page 当前原生页面，持有快照、埋点、表单和私有图片队列。
 * @param {boolean} reviewMode 清理后的展示身份标记，不在此授予任何审核权限。
 * @returns {void} 隐藏列表与表单一并清空，等待新页面按新会话重新初始化。
 */
function clearIdentityPage(page, reviewMode) {
  // 必须先永久停止埋点实例，待发送的旧审核事件不能被新正式身份领取。
  if (page._activity) page._activity.stop();
  // 新页面必须建立新队列，旧logger即使被异步闭包持有也已经永久停止。
  page._activity = null;
  // 封面和整组预览都通过已有generation取消，旧异步结果不再回填。
  if (page.cancelWallCovers) page.cancelWallCovers();
  // 轮询和手动请求独立，离开页面前停止轮询，避免后台继续读取旧家庭快照。
  clearInterval(page._poll);
  // 不只关闭可见gate，内存快照和邀请预填也必须撤下，避免随后重新渲染。
  page._snapshot = null;
  page._invitePreview = null;
  // 分享定位含原家庭事项及日期，不能在新身份初始化后继续消费。
  page._sharedTask = null;
  page.setData({
    gate: true,
    // 旧onLoad等回调即使重新创建logger也保持禁用，只有新页面可信bootstrap能恢复上报。
    cloudAvailable: false,
    reviewMode,
    view: 'today',
    scope: 'baby',
    filter: 'all',
    selectedBaby: 'all',
    // 清单、执行历史、成员和消息使用同一身份，不能只清可见rows而保留旁页资料。
    rows: [],
    babies: [],
    members: [],
    events: [],
    taskList: [],
    messages: [],
    requests: [],
    // 旧管理员和订阅标记不能在新登录完成前继续驱动按钮或通知提示。
    owner: false,
    configured: false,
    subscribed: false,
    bootstrap: {},
    // 统计也属于家庭执行资料，gate打开后不能短暂显示上一家庭的完成数量。
    total: 0,
    doneCount: 0,
    progress: 0,
    // 已发布照片和未发布私有草稿都属于旧身份，发布选择器也需一起关闭。
    wallPosts: [],
    wallCursor: '',
    wallDraft: { babyId: '', text: '', photos: [] },
    // 选择器内含宝宝姓名，清图片和草稿之外也要移除隐藏的展示选项。
    wallBabyOptions: [],
    wallComposerBabies: [],
    wallComposerOpen: false,
    wallBabyId: 'all',
    wallBabyIndex: 0,
    wallComposerIndex: 0,
    wallLoading: false,
    wallUploading: false,
    wallNotice: '',
    // 隐藏编辑器里的宝宝、任务及生日同样是私有资料，不能带入另一模式提交。
    modal: '',
    form: emptyTask(),
    babyForm: { name: '', avatar: '' },
    birthdayForm: {},
    // 生日推导出的日期选项可能来自旧家人资料，重开编辑器时重新计算。
    birthdayMessages: [],
    birthdayMonths: [],
    birthdayDays: [],
    profileName: '',
    // 尚未分享的邀请令牌和输入资料不随正式/审核切换迁移。
    token: '',
    inviteToken: '',
    inviteForm: { name: '', relation: '' },
    inviteNotice: '',
    inviteLoading: false,
    joinName: '',
    joinRelation: '',
    // 旧分享定位只对旧家庭有意义，新会话不能消费它并切到旧日期或事项。
    sharedTaskId: '',
    sharedTaskNotice: '',
    error: '',
  });
}

module.exports = {
  /**
   * 打开显式审核登录页，普通入口的query不具备切换身份的能力。
   * @returns {void} 页面跳转不携带任何审核凭据。
   */
  openReviewLogin() {
    // 正在提交事项时不离开，避免用户误认为未完成请求已经取消。
    if (this.data.busy) return;
    // 先撤下正式页面缓存，审核表单失败时也不会把家人资料当成审核结果显示。
    clearIdentityPage(this, api.isReviewMode());
    wx.reLaunch({ url: '/pages/review/index' });
  },

  /**
   * 退出审核并撤下当前隔离资料，下一页重新使用普通微信登录。
   * @returns {void} 清空审核令牌、私有图片缓存和主页面快照，不复用正式旧令牌。
   */
  exitReview() {
    if (this.data.busy) return;
    // 停止队列和撤下私有表单都发生在模式切换前，避免旧内容以新身份发出。
    clearIdentityPage(this, false);
    api.exitReview();
    // 使用无参数普通入口，客户端必须重新取得微信会话而不是自动恢复审核身份。
    wx.reLaunch({ url: '/pages/index/index' });
  },

  /**
   * 将审核过期或窗口关闭的业务错误转回显式审核登录。
   * @param {Error} error 客户端抛出的固定REVIEW_SESSION_EXPIRED业务错误。
   * @returns {boolean} 已接管审核失效时为true，普通业务错误留给原页面处理。
   */
  handleReviewSessionError(error) {
    // 只识别固定业务代码，不根据query或任意错误文字切换身份。
    if (!error || error.code !== 'REVIEW_SESSION_EXPIRED') return false;
    // 客户端已清掉失效令牌，此处仍需停止页面任务并撤下所有旧隔离数据。
    clearIdentityPage(this, true);
    // 仍保持审核模式；登录页只有用户明确退出才会回到真实微信入口。
    wx.reLaunch({ url: '/pages/review/index' });
    return true;
  },
};
