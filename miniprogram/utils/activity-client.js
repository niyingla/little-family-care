const { CLICKS } = require('./activity-policy');

/**
 * 缓冲无内容埋点；写日志失败不阻断页面、打勾或表单提交。
 * @param {Function} send 使用现有微信会话提交一批事件的函数。
 * @param {Function} enabled 仅真实共享模式且登录成功后允许上传。
 * @returns {object} record入队、flush提交及stop停止生命周期定时器。
 */
function createActivityLogger(send, enabled) {
  // 队列只保存白名单事件；单个进行中Promise限制并发上传数量。
  let queue = [],
    timer = null,
    inFlight = null;
  // 调度、队列与停止能力保持同一实例作用域，页面销毁时可统一释放。
  /**
   * 对尚未发送的事件设置一次合并上传定时器。
   * @returns {void} 空队列不启动定时器，连续触发延后到统一提交点。
   */
  const schedule = () => {
    // 后一次交互替换前一次定时器，避免同一队列被多个时钟并发领取。
    clearTimeout(timer);
    if (queue.length) timer = setTimeout(flush, 700);
  };
  /**
   * 尽力上传一批不超过20条的已入队事件。
   * @returns {Promise<void>|undefined} 返回进行中的上传，空队列或禁用时不发送。
   */
  async function flush() {
    clearTimeout(timer);
    // 已在上传时复用其Promise，不并发领取下一批或重复发送当前批。
    if (inFlight || !queue.length) return inFlight;
    if (!enabled()) {
      // 退出共享或登录失效后丢弃积压事件，不跨身份补发行为记录。
      queue = [];
      return;
    }
    const events = queue.splice(0, 20);
    // 先移出本批再异步发送，新交互仍能入队等待后续调度。
    // 仅尽力记录，不重试已经提交的业务，也不输出事件里的任意对象。
    inFlight = Promise.resolve()
      .then(() => send({ events }))
      .catch(() => {
        console.warn('页面行为暂未记录，不影响事项操作');
      })
      .finally(() => {
        // 成功失败都释放上传标记，剩余事件可继续按合并策略提交。
        inFlight = null;
        schedule();
      });
    return inFlight;
  }
  // 页面只操作队列生命周期，不直接暴露可修改的缓存和上传状态。
  return {
    /**
     * 接收一条已经过页面白名单裁剪的行为事件。
     * @param {object} event 只含交互类型、白名单方法名与视图的事件。
     * @returns {void} 仅入队或触发尽力上传，不影响原业务交互结果。
     */
    record(event) {
      if (!enabled()) return;
      // 有界队列优先保留最近交互，离线或密集点击不会无限占用内存。
      queue.push(event);
      if (queue.length > 60) queue.shift();
      // 连续点击合并小批量请求，避免一件事项产生大量独立网络调用。
      if (queue.length >= 20) void flush();
      else schedule();
    },
    flush,
    /**
     * 停止页面生命周期内待调度的事件上传。
     * @returns {void} 取消定时器并丢弃未发送队列，进行中请求由自身收尾。
     */
    stop() {
      // 离开页面后不再因旧定时器上传尚未发出的交互。
      clearTimeout(timer);
      queue = [];
    },
  };
}

/**
 * 为明确白名单的交互挂钩，不记录输入值或改变原事件返回值。
 * @param {object} definition 原生Page定义，提供recordActivity方法。
 * @returns {object} 保持同步/异步原语义的Page定义。
 */
function instrumentPage(definition) {
  // 拷贝Page定义避免原地替换调用方的方法表，包装仅针对明确白名单。
  const result = { ...definition };
  for (const name of CLICKS) {
    // 页面未实现的白名单方法保持缺失，不额外创造可触发的入口。
    if (typeof definition[name] !== 'function') continue;
    result[name] = function (...args) {
      // 只记录方法名与当前视图，不读取事件detail、dataset或表单内容。
      this.recordActivity({ kind: 'click', name, view: this.data.gate ? 'gate' : this.data.view });
      const value = definition[name].apply(this, args);
      // 切换后再读视图，确保page_view记录的是交互完成后的目标页面。
      if (name === 'switchTab') this.recordActivity({ kind: 'page_view', view: this.data.view });
      return value;
    };
  }
  return result;
}
module.exports = { createActivityLogger, instrumentPage };
