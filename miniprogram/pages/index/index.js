const d = require('../../utils/domain');
const api = require('../../utils/client');
const EMPTY_TASK = require('../../utils/forms').emptyTask;
const timeline = require('./controllers/timeline');
const tasks = require('./controllers/tasks');
const family = require('./controllers/family');
const invitations = require('./controllers/invitations');
const following = require('./controllers/following');
const birthdays = require('./controllers/birthdays');
const completionPhotos = require('./controllers/completion-photos');
const sharing = require('./controllers/sharing');
const photoWall = require('./controllers/photo-wall');
const review = require('./controllers/review');
const { shareTaskCard } = require('../../utils/task-feedback');
const { createActivityLogger, instrumentPage } = require('../../utils/activity-client');

Page(
  instrumentPage({
    ...timeline,
    ...tasks,
    ...family,
    ...invitations,
    ...following,
    ...birthdays,
    ...completionPhotos,
    ...sharing,
    ...photoWall,
    ...review,
    data: {
      ready: false,
      demo: false,
      reviewMode: false,
      gate: true,
      view: 'today',
      scope: 'baby',
      filter: 'all',
      selectedBaby: 'all',
      today: d.chinaDate(new Date()),
      date: d.chinaDate(new Date()),
      rows: [],
      events: [],
      babies: [],
      members: [],
      requests: [],
      messages: [],
      taskList: [],
      doneCount: 0,
      total: 0,
      progress: 0,
      owner: false,
      busy: false,
      refreshing: false,
      error: '',
      sharedTaskId: '',
      sharedTaskNotice: '',
      modal: '',
      form: EMPTY_TASK(),
      babyForm: { name: '', avatar: '' },
      token: '',
      joinName: '',
      joinRelation: '',
      inviteForm: { name: '', relation: '' },
      inviteNotice: '',
      inviteLoading: false,
      birthdayForm: {},
      birthdayMonths: [],
      birthdayDays: [],
      birthdayMessages: [],
      wallPosts: [],
      wallCursor: '',
      wallLoading: false,
      wallNotice: '',
      wallBabyId: 'all',
      wallBabyOptions: [],
      wallBabyIndex: 0,
      wallComposerBabies: [],
      wallComposerIndex: 0,
      wallComposerOpen: false,
      wallDraft: { babyId: '', text: '', photos: [] },
      wallUploading: false,
      profileName: '',
      inviteToken: '',
      frequencies: [
        { id: 'once', label: '仅一次' },
        { id: 'daily', label: '每天' },
        { id: 'interval', label: '每隔几天' },
        { id: 'weekly', label: '每周几' },
      ],
      week: [1, 2, 3, 4, 5, 6, 7].map((n, i) => ({
        n,
        label: '一二三四五六日'[i],
        selected: [1, 3, 5].includes(n),
      })),
      tabs: [
        { id: 'today', icon: '☀', label: '今天' },
        { id: 'history', icon: '◷', label: '历史' },
        { id: 'tasks', icon: '☷', label: '任务' },
        { id: 'photos', icon: '▧', label: '照片墙' },
        { id: 'family', icon: '♡', label: '家人' },
      ],
    },

    /**
     * 读取进入页面的定位参数，并以可信登录状态初始化家庭。
     * @param {object} query 微信页面参数，可含邀请令牌或事项定位信息，不含可信身份。
     * @returns {Promise<void>} 初始化完成后记录当前页面访问，失败由页面展示。
     */
    async onLoad(query) {
      // 邀请链接只携带随机token，申请人仍需管理员确认。
      this.setData({ token: (query && query.invite) || '' });
      this.receiveSharedTask(query);
      await this.boot();
      this.recordActivity({ kind: 'page_view', view: this.data.gate ? 'gate' : this.data.view });
    },
    /**
     * 恢复前台同步和页面访问记录。
     * @returns {void} 每个页面实例只保留一个前台轮询计时器。
     */
    onShow() {
      // 首次初始化由onLoad记录；再次进入前台才补充本次可见页面访问。
      if (this.data.ready)
        this.recordActivity({ kind: 'page_view', view: this.data.gate ? 'gate' : this.data.view });
      if (this.data.ready && !this.data.gate) this.refresh();
      // 定期拉取可见页面，家人操作后会同步；不在后台持续运行。
      clearInterval(this._poll);
      this._poll = setInterval(() => {
        // 编辑和提交时跳过静默同步，避免刷新覆盖用户正在确认的内容。
        if (!this.data.gate && !this.data.modal && !this.data.busy) this.refresh(true);
      }, 20000);
    },
    /**
     * 进入后台后停止轮询并尽力提交积累的无内容行为。
     * @returns {void} 不阻塞微信页面切换。
     */
    onHide() {
      // 后台页面不继续拉取家庭快照，降低网络和云调用消耗。
      clearInterval(this._poll);
      // 退出可见页面后取消未启动的照片墙首图，旧返回不能更新后台页面。
      this.cancelWallCovers();
      if (this._activity) void this._activity.flush();
    },
    /**
     * 销毁页面实例持有的轮询和行为缓冲。
     * @returns {void} 已卸载页面不再保留待发送事件。
     */
    onUnload() {
      // 实例销毁时清理两类计时器，防止旧页面重复同步和重复上报。
      clearInterval(this._poll);
      this.cancelWallCovers();
      if (this._activity) this._activity.stop();
    },
    /**
     * 手动重试家庭初始化或当前日期同步，并恢复待处理分享定位。
     * @returns {Promise<void>} 请求结束后关闭下拉动画，失败保留重试目标。
     */
    async onPullDownRefresh() {
      try {
        // 照片墙手动刷新只更新动态元数据，仍不下载历史图片。
        if (!this.data.gate && this.data.view === 'photos') await this.loadPhotoWall(true);
        else await (this.data.gate ? this.boot() : this.refresh());
        // 网络恢复后继续未完成的卡片定位；请求失败时仍保留目标供下次重试。
        if (!this.data.gate) await this.openSharedTask();
      } finally {
        // 下拉动画独立于业务请求，失败或定位不到事项也必须结束。
        wx.stopPullDownRefresh();
      }
    },

    /**
     * 从真实后端确认本人是否已加入家庭，再加载成员可访问的数据。
     * @returns {Promise<void>} 更新欢迎页或家庭页；失败保留可见错误提示。
     */
    async boot() {
      // 每次重试重新判断配置及身份，旧错误不代表本次连接也会失败。
      this.setData({ error: '', reviewMode: api.isReviewMode() });
      if (!api.config.apiBaseUrl && !api.config.envId && !api.config.cloudRunEnvId) {
        // 未配置共享服务时明确留在欢迎页，示例只能由用户主动进入。
        this.setData({ ready: true, gate: true, cloudAvailable: false });
        return;
      }
      try {
        // bootstrap只提供当前用户状态，邀请加入成功后成员权限立即生效。
        const status = await api.call('bootstrap');
        this.setData({
          ready: true,
          gate: !status.member,
          cloudAvailable: true,
          bootstrap: status,
        });
        if (status.member) {
          // 先取得授权快照再处理卡片，分享路径本身不授予成员访问权限。
          await this.refresh();
          await this.openSharedTask();
        } else if (this.data.token && !status.canCreate) {
          // 邀请链接只传令牌，登录后才读取该邀请的展示资料。
          await this.loadInvitePreview();
        }
      } catch (error) {
        // 初始化失败仍完成首屏加载，让用户能够看到错误并手动重试。
        if (this.handleReviewSessionError(error)) return;
        this.setData({ ready: true, error: error.message });
      }
    },

    /**
     * 按用户选择进入独立的本地体验。
     * @returns {Promise<void>} 加载示例家庭，不发送真实家庭通知。
     */
    async startDemo() {
      // 体验数据源只能由本次主动选择切换，真实连接失败不能隐式进入此路径。
      api.setDemo(true);
      // 用户主动进入本地体验，不会因云端失败悄悄展示缓存家庭资料。
      this.setData({
        demo: true,
        gate: false,
        date: d.chinaDate(new Date()),
        selectedBaby: 'all',
        error: '',
      });
      // 日期及宝宝筛选重新初始化，避免把真实页面的筛选带入示例家庭。
      await this.refresh();
    },
    /**
     * 退出本地体验并重新确认真实家庭身份。
     * @returns {Promise<void>} 示例资料先清空，真实初始化成功后再展示家庭。
     */
    async leaveDemo() {
      // 数据源切回真实服务后立即丢弃示例快照，失败时不能继续显示为真实数据。
      api.setDemo(false);
      this._snapshot = null;
      this.setData({
        demo: false,
        gate: true,
        // 任务、成员和执行流水一起撤下，防止切换数据源时短暂混显。
        rows: [],
        babies: [],
        members: [],
        taskList: [],
        events: [],
        messages: [],
        // 切换真实数据源时撤下墙帖和未发布照片，不能混入上一份体验上下文。
        wallPosts: [],
        wallCursor: '',
        wallDraft: { babyId: '', text: '', photos: [] },
        wallComposerOpen: false,
        // 关闭旧示例编辑器，避免尚未保存的示例表单被提交到真实家庭。
        modal: '',
      });
      // 欢迎页先恢复可见，再由服务端决定当前用户是否能够进入家庭。
      await this.boot();
    },

    /**
     * 同步当前可见日期，失败时不使用演示数据替代真实家庭。
     * @param {boolean} quiet 定时刷新时为true，保留错误提示但不反复弹窗。
     * @param {object} target 内部定位目标，可选view/date及事项筛选，仅在刷新成功后应用。
     * @returns {Promise<boolean>} 仅完成快照更新时为true；失败或正忙时为false。
     */
    async refresh(quiet = false, target = {}) {
      // 正忙时不启动竞争请求，调用方也不能据此认为目标已经加载。
      if (this.data.refreshing || this.data.busy) return false;
      this.setData({ refreshing: true });
      try {
        const today = d.chinaDate(new Date());
        // 今天页跨午夜自动切换；历史页保留正在查看的日期。
        // 分享目标先只用于请求，避免网络失败时旧数据被贴上目标日期。
        const view = target.view || this.data.view;
        const date = view === 'history' ? target.date || this.data.date : today;
        const snapshot = await api.call('snapshot', { date });
        // 请求成功后同时提交日期、筛选与快照；失败保留此前可用页面。
        this._snapshot = snapshot;
        this.setData({
          ...target,
          gate: false,
          error: '',
          today,
          date,
          // 成员和头像均使用同一份已授权快照，不混用请求前的家庭资料。
          owner: snapshot.home.ownerId === snapshot.actorId,
          babies: snapshot.home.babies.map((b) => ({
            // 共享模式仅显示后端签发的图片地址，原始文件标识不能直接当作URL。
            ...b,
            picture: b.avatarUrl || (this.data.demo ? b.avatar : ''),
            // 没有可用头像时使用称呼首字，不为展示再请求额外个人资料。
            initial: b.name.slice(0, 1),
          })),
          members: snapshot.home.members
            .filter((m) => m.active)
            .map((m) => ({
              // 编辑入口只属于管理员或本人，家庭身份称呼不参与权限判断。
              // 保留服务端规范化的生日和家庭称呼，展示层不根据称呼推断角色。
              ...m,
              // 私有短链由统一客户端解析，原始文件标识只在本地体验中作兼容显示。
              picture: m.avatarUrl || (this.data.demo ? m.avatar || '' : ''),
              initial: m.name.slice(0, 1),
              isOwner: m.id === snapshot.home.ownerId,
              canEditAvatar:
                snapshot.home.ownerId === snapshot.actorId || m.id === snapshot.actorId,
              canEditBirthday:
                snapshot.home.ownerId === snapshot.actorId || m.id === snapshot.actorId,
            })),
          requests: snapshot.requests,
          profileName: snapshot.home.members.find((m) => m.id === snapshot.actorId).name,
          configured: snapshot.configured,
          // 本地授权状态只用于提示，实际微信可发送额度仍由后端发送结果决定。
          subscribed: snapshot.subscribed,
          createdDate: snapshot.home.createdDate,
        });
        // 派生清单使用新快照及新筛选，不能复用另一日期的完成状态。
        this.renderRows();
        // 明确成功信号，分享控制器此时才允许消费定位请求。
        return true;
      } catch (error) {
        // 保留错误供界面重试；普通连接失败不丢弃已有授权快照。
        if (this.handleReviewSessionError(error)) return false;
        this.setData({ error: error.message });
        // 被移除后立即清空已显示的家庭资料，不退回本地体验绕过权限。
        if (/无权/.test(error.message)) {
          this._snapshot = null;
          this.setData({
            gate: true,
            babies: [],
            members: [],
            rows: [],
            events: [],
            taskList: [],
            messages: [],
            // 失去成员权限后同样撤下墙帖与私有草稿，不仅清空当天事项。
            wallPosts: [],
            wallCursor: '',
            wallDraft: { babyId: '', text: '', photos: [] },
            wallComposerOpen: false,
          });
        }
        // 轮询仍保留错误状态，但不持续打断用户。
        if (!quiet) wx.showToast({ title: error.message, icon: 'none' });
        return false;
      } finally {
        // 成功、失败和提前返回都释放刷新标记，允许用户继续重试。
        this.setData({ refreshing: false });
      }
    },

    /**
     * 提交一次业务操作，统一处理忙碌、失败提示与提交后的刷新。
     * @param {string} action 服务端业务白名单操作名。
     * @param {object} data 表单组装的业务参数，不能作为可信身份或时间。
     * @param {string} successMessage 可选的成功轻提示，仅成功提交后显示。
     * @returns {Promise<object|null>} 成功结果，失败或已有请求执行时为空。
     */
    async run(action, data, successMessage = '') {
      // 同一页面只允许一个业务请求，避免重复点击创建两份任务或邀请。
      if (this.data.busy) return null;
      this.setData({ busy: true, error: '' });
      let result = null;
      try {
        result = await api.call(action, data);
        // 成功提示只在可信响应后展示，拍照或点击并不代表事项已经完成。
        wx.showToast({
          title: successMessage || result.message || '已保存',
          icon: 'none',
          duration: successMessage ? 3500 : 2500,
        });
      } catch (error) {
        // 失败保留输入和对话框上下文，由调用者按非空返回值决定是否关闭。
        if (this.handleReviewSessionError(error)) return null;
        wx.showModal({ title: '暂时没有完成', content: error.message, showCancel: false });
      } finally {
        // 请求失败也释放忙碌状态，用户才能修正输入或重新提交。
        this.setData({ busy: false });
      }
      // 已提交结果与后续刷新分别处理；刷新失败不能把成功事务重新提交。
      if (result && !this.data.gate) await this.refresh();
      return result;
    },

    /**
     * 生成用户主动选择收件人的邀请或具体事项卡片。
     * @param {object} e 微信分享事件，按钮dataset.id可指向已授权读取的事项。
     * @returns {object} 微信卡片标题与页面路径，不携带成员身份或越权参数。
     */
    onShareAppMessage(e) {
      // 平台发送的分享卡片由用户手动选择收件人；不会自动私信或拉人入家。
      if (this.data.modal === 'invite' && this.data.inviteToken && !this.data.demo)
        return {
          title: '邀请你一起照顾宝宝 ♡',
          path: `/pages/index/index?invite=${this.data.inviteToken}`,
        };
      const id = e && e.target && e.target.dataset.id;
      // 事项必须来自当前显示清单，演示数据不能生成伪装成真实任务的链接。
      const row = this.data.rows.find((r) => r.id === id);
      if (row && !this.data.demo) return shareTaskCard(row, this.data.date);
      // 右上角菜单等没有具体事项的分享只打开首页，不臆造任务定位信息。
      return {
        title: '我家日常小事簿 · 一起照顾宝宝',
        path: '/pages/index/index',
      };
    },
    /**
     * 将无内容页面行为送入小批量队列，不记录宝宝资料或点击携带的表单参数。
     * @param {object} event 白名单kind/name/view，不允许在此附带输入内容。
     * @returns {void} 日志是尽力记录，不阻断主业务。
     */
    recordActivity(event) {
      // 首次有事件才创建队列；复用同一实例以合并连续点击的网络请求。
      if (!this._activity)
        this._activity = createActivityLogger(
          (data) => api.call('recordActivity', data),
          () => !api.isDemo() && !!this.data.cloudAvailable
        );
      // 只由白名单交互传入页面与方法名，表单内容不进入此上传入口。
      this._activity.record(event);
    },
  })
);
