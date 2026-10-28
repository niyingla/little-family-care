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
    let rows = d.rowsForDate(home, day, date);
    if (this.data.selectedBaby !== 'all')
      rows = rows.filter((r) => r.babyId === this.data.selectedBaby);
    const total = rows.length,
      doneCount = rows.filter((r) => r.done).length;
    rows = rows.filter(
      (r) => this.data.filter === 'all' || (this.data.filter === 'done' ? r.done : !r.done)
    );
    rows = rows.map((r) => ({
      ...r,
      initial: r.babyName.slice(0, 1),
      time: timeLabel(r.completedAt),
      mine: r.assigneeId === actorId,
      picture: (this.data.babies.find((b) => b.id === r.babyId) || {}).picture || '',
    }));
    const taskList = home.tasks
      .map((task) => {
        const v = d.taskVersion(task, d.addDays(this.data.today, 1));
        const baby = home.babies.find((b) => b.id === task.babyId);
        const member = home.members.find((m) => m.id === v.assigneeId && m.active);
        return {
          ...v,
          id: task.id,
          babyId: task.babyId,
          babyName: baby && baby.name,
          assigneeName: member ? member.name : '待重新分配',
          ruleLabel: d.ruleLabel(v),
          scheduled: v.effectiveDate > this.data.today,
        };
      })
      .filter(
        (t) =>
          !t.archived && (this.data.selectedBaby === 'all' || t.babyId === this.data.selectedBaby)
      );
    const events = ((day && day.events) || [])
      .filter(
        (e) =>
          rows.some((r) => r.id === e.taskId) ||
          (this.data.filter === 'all' && this.data.selectedBaby === 'all')
      )
      .slice()
      .reverse()
      .map((e) => ({
        ...e,
        time: timeLabel(e.at),
        label: e.type === 'complete' ? '完成了' : e.type === 'undo' ? '撤销了勾选' : '提醒了执行人',
      }));
    this.setData({
      rows,
      total,
      doneCount,
      progress: total ? Math.round((doneCount / total) * 100) : 0,
      events,
      taskList,
      messages: messages.map((m) => ({
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
        content: `${row.babyName} · ${row.title}`,
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
