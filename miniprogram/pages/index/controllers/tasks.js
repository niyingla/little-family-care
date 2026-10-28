// 任务表单只组装业务输入，周期与权限仍由共用规则和服务端校验。
const d = require('../../../utils/domain');
const EMPTY_TASK = require('../../../utils/forms').emptyTask;
module.exports = {
  openTask(e) {
    if (this.data.scope !== 'family' && !this.data.babies.length) {
      wx.showToast({ title: '先在家庭页添加宝宝吧', icon: 'none' });
      return;
    }
    const id = e && e.currentTarget.dataset.id;
    const task = id && this._snapshot.home.tasks.find((t) => t.id === id);
    const form = task
      ? {
          ...d.taskVersion(task, d.addDays(this.data.today, 1)),
          taskId: id,
          scope: task.scope || 'baby',
          babyIds: task.babyId ? [task.babyId] : [],
        }
      : {
          ...EMPTY_TASK(),
          scope: this.data.scope || 'baby',
          babyIds:
            this.data.scope === 'family'
              ? []
              : this.data.selectedBaby === 'all'
                ? [this.data.babies[0].id]
                : [this.data.selectedBaby],
          assigneeId: this._snapshot.actorId,
        };
    // 执行人已离家时显示明确占位，不能把列表第一位误显示为新的执行人。
    const taskMembers = [{ id: '', name: '请选择执行人' }, ...this.data.members];
    const notifyOptions = [{ id: '', name: '与执行人相同' }, ...this.data.members];
    if (form.notifyMemberId && !this.data.members.some((m) => m.id === form.notifyMemberId)) {
      notifyOptions.unshift({ id: form.notifyMemberId, name: '原通知人已离家，请重选' });
    }
    this.setData({
      modal: 'task',
      form,
      memberIndex: Math.max(
        0,
        taskMembers.findIndex((m) => m.id === form.assigneeId)
      ),
      taskMembers,
      notifyOptions,
      notifyIndex: Math.max(
        0,
        notifyOptions.findIndex((m) => m.id === (form.notifyMemberId || ''))
      ),
      taskBabies: this.data.babies.map((b) => ({ ...b, selected: form.babyIds.includes(b.id) })),
      week: this.data.week.map((w) => ({ ...w, selected: form.weekdays.includes(w.n) })),
    });
  },
  input(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
  },
  chooseFrequency(e) {
    this.setData({ 'form.frequency': e.currentTarget.dataset.id });
  },
  chooseTaskBaby(e) {
    if (this.data.form.taskId) return;
    const id = e.currentTarget.dataset.id;
    const ids = this.data.form.babyIds.slice();
    const next = ids.includes(id) ? ids.filter((v) => v !== id) : [...ids, id];
    this.setData({
      'form.babyIds': next,
      taskBabies: this.data.taskBabies.map((b) => ({ ...b, selected: next.includes(b.id) })),
    });
  },
  chooseWeekday(e) {
    const n = Number(e.currentTarget.dataset.n),
      days = this.data.form.weekdays;
    const next = days.includes(n) ? days.filter((v) => v !== n) : [...days, n];
    this.setData({
      'form.weekdays': next,
      week: this.data.week.map((w) => ({ ...w, selected: next.includes(w.n) })),
    });
  },
  chooseMember(e) {
    const index = Number(e.detail.value);
    this.setData({ memberIndex: index, 'form.assigneeId': this.data.taskMembers[index].id });
  },
  chooseNotifyMember(e) {
    const index = Number(e.detail.value);
    // 被通知人可与执行人不同，服务端会再次验证其家庭成员资格。
    this.setData({ notifyIndex: index, 'form.notifyMemberId': this.data.notifyOptions[index].id });
  },
  clearExecutionTime() {
    // 清空计划时间会同时关闭该任务的自动超时通知，手动提醒仍保留。
    this.setData({ 'form.executionTime': '' });
  },
  async saveTask() {
    const result = await this.run('saveTask', {
      ...this.data.form,
      interval: Number(this.data.form.interval),
    });
    if (result) this.closeModal();
  },
  async archive(e) {
    const response = await wx.showModal({
      title: '停止这项任务？',
      content: '明天起不再出现，今天和已有历史记录都会保留。',
    });
    if (response.confirm) await this.run('archiveTask', { taskId: e.currentTarget.dataset.id });
  },
  async togglePin(e) {
    const id = e.currentTarget.dataset.id;
    const task = this._snapshot.home.tasks.find((t) => t.id === id);
    // 通过服务端共享状态，其他家人刷新后会看到相同的重点事项。
    if (task) await this.run('setPinned', { taskId: id, pinned: !task.pinned });
  },
};
