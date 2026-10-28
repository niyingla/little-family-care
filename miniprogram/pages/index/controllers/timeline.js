// 日期浏览、清单筛选与当天执行；不直接访问云数据库。
const d = require('../../../utils/domain');
const timeLabel = (iso) => (iso ? d.chinaTime(iso) : '');
const STATUS = {
  queued: '等待发送',
  sending: '正在处理，结果待确认',
  sent: '微信接口已接收',
  no_quota: '缺少接收人授权',
  unconfigured: '通知尚未配置',
  skipped: '已取消发送',
  failed: '发送失败',
};
module.exports = {
  renderRows() {
    if (!this._snapshot) return;
    const { home, day, date, actorId, messages } = this._snapshot;
    let rows = d
      .rowsForDate(home, day, date)
      .filter((r) => r.scope === (this.data.scope || 'baby'));
    if (this.data.scope !== 'family' && this.data.selectedBaby !== 'all')
      rows = rows.filter((r) => r.babyId === this.data.selectedBaby);
    const total = rows.length,
      doneCount = rows.filter((r) => r.done).length;
    const visibleTaskIds = rows.map((r) => r.id);
    rows = rows.filter(
      (r) => this.data.filter === 'all' || (this.data.filter === 'done' ? r.done : !r.done)
    );
    rows = rows.map((r) => ({
      ...r,
      initial: r.subjectName.slice(0, 1),
      time: timeLabel(r.completedAt),
      mine: r.assigneeId === actorId,
      picture: (this.data.babies.find((b) => b.id === r.babyId) || {}).picture || '',
    }));
    const taskList = home.tasks
      .map((task) => {
        const v = d.taskVersion(task, d.addDays(this.data.today, 1));
        const scope = task.scope || 'baby';
        const baby = scope === 'baby' && home.babies.find((b) => b.id === task.babyId);
        const member = home.members.find((m) => m.id === v.assigneeId && m.active);
        return {
          ...v,
          id: task.id,
          scope,
          pinned: !!task.pinned,
          babyId: task.babyId,
          subjectName: scope === 'family' ? '全家' : baby && baby.name,
          assigneeName: member ? member.name : '待重新分配',
          ruleLabel: d.ruleLabel(v),
          scheduled: v.effectiveDate > this.data.today,
        };
      })
      .filter(
        (t) =>
          !t.archived &&
          t.scope === (this.data.scope || 'baby') &&
          (t.scope === 'family' ||
            this.data.selectedBaby === 'all' ||
            t.babyId === this.data.selectedBaby)
      )
      .sort(d.compareTaskOrder);
    const events = ((day && day.events) || [])
      .filter((e) => visibleTaskIds.includes(e.taskId))
      .slice()
      .reverse()
      .map((e) => ({
        ...e,
        subjectName: e.subjectName || e.babyName || '全家',
        time: timeLabel(e.at),
        label: e.type === 'complete' ? '完成了' : e.type === 'undo' ? '撤销了勾选' : '发起了提醒',
      }));
    this.setData({
      rows,
      total,
      doneCount,
      progress: total ? Math.round((doneCount / total) * 100) : 0,
      events,
      taskList,
      messages: messages
        .filter((m) => visibleTaskIds.includes(m.taskId))
        .map((m) => ({
          ...m,
          label: STATUS[m.status] || '发送结果待确认',
          title: (
            home.tasks.find((t) => t.id === m.taskId) || { versions: [{ title: '任务提醒' }] }
          ).versions.slice(-1)[0].title,
        })),
    });
  },

  switchTab(e) {
    const view = e.currentTarget.dataset.id;
    this.setData({ view, filter: 'all', date: this.data.today });
    this.refresh();
  },
  switchScope(e) {
    // 两大事项块使用各自的统计与流水，切换时清除宝宝和完成状态筛选。
    this.setData({ scope: e.currentTarget.dataset.id, selectedBaby: 'all', filter: 'all' });
    this.renderRows();
  },
  selectBaby(e) {
    this.setData({ selectedBaby: e.currentTarget.dataset.id });
    this.renderRows();
  },
  selectFilter(e) {
    this.setData({ filter: e.currentTarget.dataset.id });
    this.renderRows();
  },
  async changeDate(e) {
    this.setData({ date: e.detail.value, filter: 'all' });
    await this.refresh();
  },
  async changeDay(e) {
    const date = d.addDays(this.data.date, Number(e.currentTarget.dataset.step));
    if (date < this.data.createdDate || date > this.data.today) return;
    this.setData({ date, filter: 'all' });
    await this.refresh();
  },
  async toggle(e) {
    if (this.data.view === 'history') return;
    const row = this.data.rows.find((r) => r.id === e.currentTarget.dataset.id);
    if (!row) return;
    // 撤销与完成均带版本号，服务端拒绝覆盖其他家人的新状态。
    if (row.done) {
      const confirm = await wx.showModal({
        title: '撤销这次打勾？',
        content: `${row.subjectName} · ${row.title}`,
      });
      if (!confirm.confirm) return;
    }
    await this.run('complete', {
      taskId: row.id,
      date: this.data.today,
      done: !row.done,
      expectedRevision: row.revision,
    });
  },
  async nudge(e) {
    await this.run('nudge', { taskId: e.currentTarget.dataset.id, date: this.data.today });
  },
};
