// 任务表单只组装业务输入，周期与权限仍由共用规则和服务端校验。
const d = require('../../../utils/domain');
const EMPTY_TASK = require('../../../utils/forms').emptyTask;
module.exports = {
  /**
   * 打开新建或编辑任务表单，并保留未指定成员的空选项。
   * @param {object} e 可选点击事件，dataset.id存在时编辑该家庭任务。
   * @returns {void} 更新表单与选项；缺少宝宝时提示用户先补资料。
   */
  openTask(e) {
    // 只有宝宝事项需要先有宝宝，家庭事项不能被此条件误拦截。
    if (this.data.scope !== 'family' && !this.data.babies.length) {
      wx.showToast({ title: '先在家庭页添加宝宝吧', icon: 'none' });
      return;
    }
    const id = e && e.currentTarget.dataset.id;
    // 编辑对象从已加载家庭快照查找，不直接信任点击事件提供的完整任务字段。
    const task = id && this._snapshot.home.tasks.find((t) => t.id === id);
    // 编辑读取次日版本，重复编辑同日尚未生效的改动不会丢失上一次选择。
    const form = task
      ? {
          ...d.taskVersion(task, d.addDays(this.data.today, 1)),
          taskId: id,
          // 编辑保持任务既有分类和宝宝归属，避免保存时意外创建另一类事项。
          scope: task.scope || 'baby',
          babyIds: task.babyId ? [task.babyId] : [],
        }
      : {
          ...EMPTY_TASK(),
          // 新事项沿用当前分类；全家事项不借用宝宝ID作为占位。
          scope: this.data.scope || 'baby',
          babyIds:
            this.data.scope === 'family'
              ? []
              : this.data.selectedBaby === 'all'
                ? [this.data.babies[0].id]
                : [this.data.selectedBaby],
          // 新事项不替用户指定负责人，空值代表家人均可分担。
          assigneeId: '',
        };
    // 执行人已离家时显示明确占位，不能把列表第一位误显示为新的执行人。
    const taskMembers = [{ id: '', name: '未设置负责人' }, ...this.data.members];
    // 提醒人独立提供空选项，索引0代表不通知，绝不能映射到第一位家人。
    const notifyOptions = [{ id: '', name: '未设置提醒人' }, ...this.data.members];
    if (form.notifyMemberId && !this.data.members.some((m) => m.id === form.notifyMemberId)) {
      // 原通知人失效时保留明确占位，让用户决定重选或清空，不悄悄指定其他人。
      notifyOptions.unshift({ id: form.notifyMemberId, name: '原通知人已离家，请重选' });
    }
    this.setData({
      modal: 'task',
      // 表单与选择器状态一次更新，避免弹窗打开后短暂显示上一次任务的选择。
      form,
      // 找不到旧负责人时选中空项，展示占位不等于将表单ID自动改为其他成员。
      memberIndex: Math.max(
        0,
        taskMembers.findIndex((m) => m.id === form.assigneeId)
      ),
      taskMembers,
      notifyOptions,
      // 显式空提醒人仍落在未设置选项，兼容旧字段的处理留给业务规则入口。
      notifyIndex: Math.max(
        0,
        notifyOptions.findIndex((m) => m.id === (form.notifyMemberId || ''))
      ),
      taskBabies: this.data.babies.map((b) => ({ ...b, selected: form.babyIds.includes(b.id) })),
      // 按表单集合恢复星期控件，编辑周期不会依赖上一次打开弹窗的视觉状态。
      week: this.data.week.map((w) => ({ ...w, selected: form.weekdays.includes(w.n) })),
    });
  },
  input(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
  },
  chooseFrequency(e) {
    this.setData({ 'form.frequency': e.currentTarget.dataset.id });
  },
  /**
   * 切换新任务适用的宝宝集合。
   * @param {object} e 点击事件，dataset.id为当前家庭中的宝宝ID。
   * @returns {void} 更新选择状态；已有任务不允许借编辑迁移宝宝归属。
   */
  chooseTaskBaby(e) {
    // 每个已存在任务有独立历史，禁止编辑时把它移到另一位宝宝。
    if (this.data.form.taskId) return;
    const id = e.currentTarget.dataset.id;
    const ids = this.data.form.babyIds.slice();
    // 从原选择复制并切换，保持表单ID集合与界面选中态同步。
    const next = ids.includes(id) ? ids.filter((v) => v !== id) : [...ids, id];
    this.setData({
      'form.babyIds': next,
      taskBabies: this.data.taskBabies.map((b) => ({ ...b, selected: next.includes(b.id) })),
    });
  },
  /**
   * 切换周任务的一个执行星期。
   * @param {object} e 点击事件，dataset.n为1至7的星期编号。
   * @returns {void} 更新表单集合与星期控件，最终有效性由保存入口校验。
   */
  chooseWeekday(e) {
    // 控件值转为数字后比较，避免字符串星期和数字星期形成重复项。
    const n = Number(e.currentTarget.dataset.n),
      days = this.data.form.weekdays;
    const next = days.includes(n) ? days.filter((v) => v !== n) : [...days, n];
    // 不在点击阶段补选默认星期，空集合交由保存校验给出明确提示。
    this.setData({
      'form.weekdays': next,
      week: this.data.week.map((w) => ({ ...w, selected: next.includes(w.n) })),
    });
  },
  /**
   * 保存负责人选择，包含索引0的未设置状态。
   * @param {object} e 选择器事件，detail.value是taskMembers中的选项索引。
   * @returns {void} 更新表单负责人ID，空值不会替换为第一位真实成员。
   */
  chooseMember(e) {
    // 空选项本身携带空ID，保持用户未指定负责人的明确意图。
    const index = Number(e.detail.value);
    this.setData({ memberIndex: index, 'form.assigneeId': this.data.taskMembers[index].id });
  },
  /**
   * 保存独立提醒人选择。
   * @param {object} e 选择器事件，detail.value对应notifyOptions中的选项索引。
   * @returns {void} 未设置选项保存显式空ID，后端不再回退负责人。
   */
  chooseNotifyMember(e) {
    const index = Number(e.detail.value);
    // 被通知人可与执行人不同，服务端会再次验证其家庭成员资格。
    this.setData({ notifyIndex: index, 'form.notifyMemberId': this.data.notifyOptions[index].id });
  },
  clearExecutionTime() {
    // 清空计划时间会同时关闭该任务的自动超时通知，手动提醒仍保留。
    this.setData({ 'form.executionTime': '' });
  },
  /**
   * 提交当前任务表单，校验成功后关闭弹窗。
   * @returns {Promise<void>} 保存完成或页面统一错误提示结束后返回。
   */
  async saveTask() {
    // 将间隔控件转为数字，其余空负责人和空提醒人原样交由后端校验。
    const result = await this.run('saveTask', {
      ...this.data.form,
      interval: Number(this.data.form.interval),
    });
    // 只有明确保存成功才收起弹窗，失败时保留用户已填写的信息。
    if (result) this.closeModal();
  },
  /**
   * 确认后申请次日起停用任务。
   * @param {object} e 点击事件，dataset.id为需要停用的任务ID。
   * @returns {Promise<void>} 取消时不提交；确认后由服务端保留历史版本。
   */
  async archive(e) {
    // 停用影响未来应做清单，先明确告诉用户今天与历史都仍保留。
    const response = await wx.showModal({
      title: '停止这项任务？',
      content: '明天起不再出现，今天和已有历史记录都会保留。',
    });
    // 只有用户确认才修改家庭共享配置，关闭提示框不视为同意。
    if (response.confirm) await this.run('archiveTask', { taskId: e.currentTarget.dataset.id });
  },
  /**
   * 切换家庭共享的任务置顶偏好。
   * @param {object} e 点击事件，dataset.id为当前家庭中的任务ID。
   * @returns {Promise<void>} 已找到任务时提交反向状态，不改动周期历史。
   */
  async togglePin(e) {
    const id = e.currentTarget.dataset.id;
    const task = this._snapshot.home.tasks.find((t) => t.id === id);
    // 通过服务端共享状态，其他家人刷新后会看到相同的重点事项。
    if (task) await this.run('setPinned', { taskId: id, pinned: !task.pinned });
  },
};
