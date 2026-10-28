// 任务表单只组装业务输入，周期与权限仍由共用规则和服务端校验。
const d = require('../../../utils/domain');
const EMPTY_TASK = require('../../../utils/forms').emptyTask;
module.exports = {
  openTask(e) {
    if (!this.data.babies.length) {
      wx.showToast({ title: '先在家庭页添加宝宝吧', icon: 'none' });
      return;
    }
    const id = e && e.currentTarget.dataset.id;
    const task = id && this._snapshot.home.tasks.find((t) => t.id === id);
    const form = task
      ? {
          ...d.taskVersion(task, d.addDays(this.data.today, 1)),
          taskId: id,
          babyIds: [task.babyId],
        }
      : {
          ...EMPTY_TASK(),
          babyIds:
            this.data.selectedBaby === 'all' ? [this.data.babies[0].id] : [this.data.selectedBaby],
          assigneeId: this._snapshot.actorId,
        };
    // 执行人已离家时显示明确占位，不能把列表第一位误显示为新的执行人。
    const taskMembers = [{ id: '', name: '请选择执行人' }, ...this.data.members];
    this.setData({
      modal: 'task',
      form,
      memberIndex: Math.max(
        0,
        taskMembers.findIndex((m) => m.id === form.assigneeId)
      ),
      taskMembers,
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
};
