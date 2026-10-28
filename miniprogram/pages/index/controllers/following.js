// 关注是成员自己的订阅偏好，不能替别人开启，也不代表已获得微信发送授权。
module.exports = {
  /**
   * 切换本人对一件事项的关注，适用于当天清单及任务列表。
   * @param {object} event 点击事件，dataset.id为事项ID。
   * @returns {Promise<void>} 服务端保存后刷新家庭共享状态。
   */
  async toggleFollowing(event) {
    // 业务提交期间忽略连续切换，避免同一页面把关注状态来回覆盖。
    if (this.data.busy) return;
    const id = event.currentTarget.dataset.id;
    const task = this._snapshot && this._snapshot.home.tasks.find((item) => item.id === id);
    // 只允许操作当前授权快照中存在的事项，失去快照时等待下次刷新。
    if (!task) return;
    // 只传布尔偏好，可信操作者及有效成员资格均由服务端确定。
    const following = !(task.followers || []).includes(this._snapshot.actorId);
    await this.run('setFollowing', { taskId: id, following });
  },
};
