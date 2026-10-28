const d = require('../../utils/domain');
const api = require('../../utils/client');
const EMPTY_TASK = require('../../utils/forms').emptyTask;
const timeline = require('./controllers/timeline');
const tasks = require('./controllers/tasks');
const family = require('./controllers/family');

Page({
  ...timeline,
  ...tasks,
  ...family,
  data: {
    ready: false,
    demo: false,
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
    modal: '',
    form: EMPTY_TASK(),
    babyForm: { name: '', avatar: '' },
    token: '',
    joinName: '',
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
      { id: 'family', icon: '♡', label: '家人' },
    ],
  },

  async onLoad(query) {
    // 邀请链接只携带随机token，申请人仍需管理员确认。
    this.setData({ token: (query && query.invite) || '' });
    await this.boot();
  },
  onShow() {
    if (this.data.ready && !this.data.gate) this.refresh();
    // 定期拉取可见页面，家人操作后会同步；不在后台持续运行。
    clearInterval(this._poll);
    this._poll = setInterval(() => {
      if (!this.data.gate && !this.data.modal && !this.data.busy) this.refresh(true);
    }, 20000);
  },
  onHide() {
    clearInterval(this._poll);
  },
  onUnload() {
    clearInterval(this._poll);
  },
  async onPullDownRefresh() {
    try {
      await (this.data.gate ? this.boot() : this.refresh());
    } finally {
      wx.stopPullDownRefresh();
    }
  },

  async boot() {
    this.setData({ error: '' });
    if (!api.config.apiBaseUrl && !api.config.envId) {
      this.setData({ ready: true, gate: true, cloudAvailable: false });
      return;
    }
    try {
      const status = await api.call('bootstrap');
      this.setData({ ready: true, gate: !status.member, cloudAvailable: true, bootstrap: status });
      if (status.member) await this.refresh();
    } catch (error) {
      this.setData({ ready: true, error: error.message });
    }
  },

  async startDemo() {
    api.setDemo(true);
    // 用户主动进入本地体验，不会因云端失败悄悄展示缓存家庭资料。
    this.setData({
      demo: true,
      gate: false,
      date: d.chinaDate(new Date()),
      selectedBaby: 'all',
      error: '',
    });
    await this.refresh();
  },
  async leaveDemo() {
    api.setDemo(false);
    this._snapshot = null;
    this.setData({
      demo: false,
      gate: true,
      rows: [],
      babies: [],
      members: [],
      taskList: [],
      events: [],
      messages: [],
      modal: '',
    });
    await this.boot();
  },

  /**
   * 同步当前可见日期，失败时不使用演示数据替代真实家庭。
   * @param {boolean} quiet 定时刷新时为true，保留错误提示但不反复弹窗。
   * @returns {Promise<void>} 成功后更新快照；无权访问时清空页面资料。
   */
  async refresh(quiet = false) {
    if (this.data.refreshing || this.data.busy) return;
    this.setData({ refreshing: true });
    try {
      const today = d.chinaDate(new Date());
      // 今天页跨午夜自动切换；历史页保留正在查看的日期。
      const date = this.data.view === 'history' ? this.data.date : today;
      const snapshot = await api.call('snapshot', { date });
      this._snapshot = snapshot;
      this.setData({
        gate: false,
        error: '',
        today,
        date,
        owner: snapshot.home.ownerId === snapshot.actorId,
        babies: snapshot.home.babies.map((b) => ({
          ...b,
          picture: b.avatarUrl || (this.data.demo ? b.avatar : ''),
          initial: b.name.slice(0, 1),
        })),
        members: snapshot.home.members.filter((m) => m.active),
        requests: snapshot.requests,
        profileName: snapshot.home.members.find((m) => m.id === snapshot.actorId).name,
        configured: snapshot.configured,
        subscribed: snapshot.subscribed,
        createdDate: snapshot.home.createdDate,
      });
      this.renderRows();
    } catch (error) {
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
        });
      }
      if (!quiet) wx.showToast({ title: error.message, icon: 'none' });
    } finally {
      this.setData({ refreshing: false });
    }
  },

  /**
   * 提交一次业务操作，统一处理忙碌、失败提示与提交后的刷新。
   * @param {string} action 服务端业务白名单操作名。
   * @param {object} data 表单组装的业务参数，不能作为可信身份或时间。
   * @returns {Promise<object|null>} 成功结果，失败或已有请求执行时为空。
   */
  async run(action, data) {
    if (this.data.busy) return null;
    this.setData({ busy: true, error: '' });
    let result = null;
    try {
      result = await api.call(action, data);
      wx.showToast({ title: result.message || '已保存', icon: 'none', duration: 2500 });
    } catch (error) {
      wx.showModal({ title: '暂时没有完成', content: error.message, showCancel: false });
    } finally {
      this.setData({ busy: false });
    }
    if (result && !this.data.gate) await this.refresh();
    return result;
  },

  onShareAppMessage(e) {
    // 平台发送的分享卡片由用户手动选择收件人；不会自动私信或拉人入家。
    if (this.data.modal === 'invite' && this.data.inviteToken && !this.data.demo)
      return {
        title: '邀请你一起照顾宝宝 ♡',
        path: `/pages/index/index?invite=${this.data.inviteToken}`,
      };
    const id = e && e.target && e.target.dataset.id;
    const row = this.data.rows.find((r) => r.id === id);
    return {
      title: row ? '有件照护小事，等你来看一下 ♡' : '我家日常小事簿 · 一起照顾宝宝',
      path: row ? `/pages/index/index?task=${row.id}` : '/pages/index/index',
    };
  },
});
