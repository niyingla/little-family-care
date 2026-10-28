const { readSharedTask } = require('../../../utils/task-feedback');
module.exports = {
  /**
   * 保存分享定位信息，必须等成员身份确认后才能读取具体事项。
   * @param {object} query 微信进入参数，任务ID及日期均需格式校验。
   * @returns {void} 不发出额外数据请求，不改变家庭访问权限。
   */
  receiveSharedTask(query) {
    this._sharedTask = readSharedTask(query, this.data.today);
  },
  /**
   * 加载卡片对应日期，成功后才消费定位目标和滚动到事项。
   * @returns {Promise<void>} 加载失败时保留原日期页面和定位目标，允许下拉重试。
   */
  async openSharedTask() {
    // 未加入或快照尚未读取时只保留目标，不额外请求家庭资料。
    if (!this._sharedTask || this.data.gate || !this._snapshot) return;
    // 不改变正在执行的业务或刷新目标，避免并发请求消费尚未加载的卡片。
    if (this.data.refreshing || this.data.busy) return;
    const request = this._sharedTask;
    const task = this._snapshot.home.tasks.find((item) => item.id === request.id);
    // 只在已授权的家庭快照中查找；卡片不能指向其他家庭或创建前的日期。
    if (!task || request.date < this._snapshot.home.createdDate) {
      this._sharedTask = null;
      this.setData({ sharedTaskNotice: '这张卡片中的事项暂不可查看，请联系分享给你的家人。' });
      return;
    }
    // 目标先交给刷新请求，日期和清单必须在成功后一起切换。
    const target = {
      view: request.date === this.data.today ? 'today' : 'history',
      date: request.date,
      scope: task.scope || 'baby',
      selectedBaby: task.babyId || 'all',
      filter: 'all',
    };
    // 加载提示不改变原日期，失败时仍可使用此前已授权的清单和表单。
    this.setData({
      sharedTaskId: '',
      sharedTaskNotice: '正在打开家人分享的事项…',
    });
    const refreshed = await this.refresh(false, target);
    // refresh不再以“未抛异常”代表成功；只有目标日期的快照能确认定位结果。
    if (!refreshed || !this._snapshot || this._snapshot.date !== request.date) {
      this.setData({ sharedTaskNotice: '事项暂未加载，请下拉刷新重试。' });
      return;
    }
    this._sharedTask = null;
    // 已成功读取且没有该任务是终态；连接失败不会走到这里消费重试目标。
    if (!this.data.rows.some((row) => row.id === request.id)) {
      this.setData({ sharedTaskNotice: '这一天没有安排这件事项，可能已调整或停止重复。' });
      return;
    }
    // 日期和任务都得到确认后才高亮，避免相同ID的其他日期行被误定位。
    this.setData({ sharedTaskId: request.id, sharedTaskNotice: '家人提醒你看看这件小事 ♡' });
    // 页面渲染后再定位；旧卡片进入只读历史，不能通过分享补写过去完成状态。
    wx.nextTick(() => wx.pageScrollTo({ selector: '#task-' + request.id, duration: 250 }));
  },
};
