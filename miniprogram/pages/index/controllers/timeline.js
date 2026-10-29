// 日期浏览、清单筛选与当天执行；不直接访问云数据库。
const d = require('../../../utils/domain');
const { completionMessage } = require('../../../utils/task-feedback');
const timeLabel = (iso) => (iso ? d.chinaTime(iso) : '');
const HISTORY_SWIPE = { distance: 60, maxDuration: 1000, axisRatio: 1.5 };
// 与前台轮询周期一致，标签切换复用刚确认过的快照，不为每次点击重复下载头像。
const SNAPSHOT_FRESH_MS = 20000;
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
  /**
   * 将同一授权日期快照组装为事项、统计、执行流水和通知展示。
   * @returns {void} 无快照时不渲染；筛选仅影响展示，不修改家庭业务数据。
   */
  renderRows() {
    // 未完成初始化或已失去访问权限时，不从残留页面状态拼装家庭资料。
    if (!this._snapshot) return;
    // 新日期尚未加载时，切换筛选也不能把旧日期记录重新填进空白加载区。
    if (this.data.timelinePending && ['today', 'history'].includes(this.data.view)) return;
    // 任务与执行记录必须来自同一日期，不能用今天的完成情况替代历史。
    const { home, day, date, actorId, messages } = this._snapshot;
    let rows = d
      .rowsForDate(home, day, date)
      .filter((r) => r.scope === (this.data.scope || 'baby'));
    // 家庭事项没有宝宝归属，仅宝宝事项需要应用具体宝宝筛选。
    if (this.data.scope !== 'family' && this.data.selectedBaby !== 'all')
      rows = rows.filter((r) => r.babyId === this.data.selectedBaby);
    // 统计在完成状态筛选之前计算，否则只看待办时总数和完成率会失真。
    const total = rows.length,
      doneCount = rows.filter((r) => r.done).length;
    // 流水及通知随业务范围过滤，不能因暂时隐藏已完成行而丢掉其执行记录。
    const visibleTaskIds = rows.map((r) => r.id);
    // 完成/待办仅是当前清单的视觉筛选，不改变服务端的任务归属和历史。
    rows = rows.filter(
      (r) => this.data.filter === 'all' || (this.data.filter === 'done' ? r.done : !r.done)
    );
    // 在副本上补展示字段，后续点击仍以服务端任务ID和revision提交。
    rows = rows.map((r) => ({
      // 保留当前日期重建的业务字段，不把显示时间写回完成记录。
      ...r,
      initial: r.subjectName.slice(0, 1),
      time: timeLabel(r.completedAt),
      mine: r.assigneeId === actorId,
      // 关注是当前操作者的偏好，不能根据负责人与关注人数推断本人关注。
      following: r.followers.includes(actorId),
      followerCount: r.followers.length,
      // 家庭事项自然没有宝宝头像，图片缺失只影响展示，不影响完成操作。
      picture: (this.data.babies.find((b) => b.id === r.babyId) || {}).picture || '',
    }));
    // 编辑列表预览明日起生效的版本，今天执行清单仍保留今天的规则。
    const taskList = home.tasks
      .map((task) => {
        // 同一天编辑从次日生效，列表应展示已保存而尚未执行的新规则。
        const v = d.taskVersion(task, d.addDays(this.data.today, 1));
        const scope = task.scope || 'baby';
        // 旧任务兼容为宝宝事项，家庭事项不借用任意宝宝作为主体。
        const baby = scope === 'baby' && home.babies.find((b) => b.id === task.babyId);
        const member = home.members.find((m) => m.id === v.assigneeId && m.active);
        return {
          ...v,
          id: task.id,
          scope,
          pinned: !!task.pinned,
          following: (task.followers || []).includes(actorId),
          // 关注人数只计仍有效的家人，历史残留ID不能充当有效通知接收人。
          followerCount: (task.followers || []).filter((id) =>
            home.members.some((m) => m.id === id && m.active)
          ).length,
          babyId: task.babyId,
          subjectName: scope === 'family' ? '全家' : baby && baby.name,
          // 已离家的执行人明确显示待分配，不能以管理员称呼掩盖未分配状态。
          assigneeName: member ? member.name : v.assigneeId ? '待重新分配' : '',
          ruleLabel: d.ruleLabel(v),
          // 生效标志让用户区分今天正在执行与明天才采用的编辑结果。
          scheduled: v.effectiveDate > this.data.today,
        };
      })
      .filter(
        (t) =>
          // 停用版本不出现在可编辑清单；历史仍由日期快照独立重建。
          !t.archived &&
          // 停用过滤后仍按事项范围隔离，不能把家庭任务混入宝宝清单。
          t.scope === (this.data.scope || 'baby') &&
          // “全部宝宝”只扩大宝宝范围，家庭任务无需与不存在的babyId比较。
          (t.scope === 'family' ||
            this.data.selectedBaby === 'all' ||
            t.babyId === this.data.selectedBaby)
      )
      .sort(d.compareTaskOrder);
    // 执行流水只展示当前业务范围，倒序让最近一次真实操作优先可见。
    const events = ((day && day.events) || [])
      .filter((e) => visibleTaskIds.includes(e.taskId))
      .slice()
      .reverse()
      .map((e) => ({
        // 旧流水兼容babyName，避免家庭事项引入后历史主体名称丢失。
        ...e,
        subjectName: e.subjectName || e.babyName || '全家',
        time: timeLabel(e.at),
        // 流水描述的是业务动作；催办动作不代表微信通知已经发送成功。
        label: e.type === 'complete' ? '完成了' : e.type === 'undo' ? '撤销了勾选' : '发起了提醒',
      }));
    // 一次提交相关清单和统计，避免页面短暂混用两次筛选的结果。
    this.setData({
      rows,
      total,
      doneCount,
      progress: total ? Math.round((doneCount / total) * 100) : 0,
      events,
      taskList,
      // 生日面向全家，不依附宝宝事项过滤，也不混入单任务通知。
      birthdayMessages: messages
        .filter((m) => m.type === 'birthday')
        .map((m) => ({
          // 未知发送状态不能说成成功，保留“待确认”提示供家人判断。
          ...m,
          label: STATUS[m.status] || '发送结果待确认',
        })),
      // 任务通知只跟随当前范围；微信接收状态和事项完成状态分别展示。
      messages: messages
        .filter((m) => visibleTaskIds.includes(m.taskId))
        .map((m) => ({
          // 优先采用通知入队时保存的标题，编辑任务不会改写旧消息描述。
          ...m,
          // 这里只展示后端发送记录，接口接收状态不能等同于家人已经阅读。
          label: STATUS[m.status] || '发送结果待确认',
          // 兼容旧消息无标题的情况，任务已不存在时仍提供可理解的占位名称。
          title:
            m.title ||
            (
              home.tasks.find((t) => t.id === m.taskId) || { versions: [{ title: '任务提醒' }] }
            ).versions.slice(-1)[0].title,
        })),
    });
  },

  /**
   * 立即切换主页面，已有授权数据先展示，过期快照在后台更新。
   * @param {object} e 标签事件，dataset.id为today/history/tasks/family。
   * @returns {Promise<boolean>} 当前切换仍有效时为true，后台同步不阻塞标签显示。
   */
  async switchTab(e) {
    // 业务提交仍保护原上下文；普通后台读取不再阻止导航点击。
    if (this.data.busy || this.data.gate) return false;
    const view = e.currentTarget.dataset.id;
    if (!['today', 'history', 'tasks', 'family'].includes(view)) return false;
    if (view === this.data.view) return true;
    // 每次真实导航撤销旧日期请求的回写资格，连续点击只服从最后一次选择。
    const generation = (this._navigationVersion || 0) + 1;
    this._navigationVersion = generation;
    const today = d.chinaDate(new Date());
    const timelinePending =
      ['today', 'history'].includes(view) && (!this._snapshot || this._snapshot.date !== today);
    this.setData({ view, today, date: today, filter: 'all', timelinePending });
    if (timelinePending) {
      // 日期标题可先切换，但必须撤下旧记录和统计，不能把昨日完成状态贴成今天。
      this.setData({
        rows: [],
        events: [],
        messages: [],
        birthdayMessages: [],
        total: 0,
        doneCount: 0,
        progress: 0,
      });
    } else this.renderRows();
    // 只保留一个已有请求和最新导航意图，不为快速切页堆积网络请求。
    return this.syncTabSnapshot(generation);
  },
  /**
   * 复用在途请求，按最后一次标签选择补充必要的快照。
   * @param {number} generation 本次真实导航序号，旧序号不得再发起补读。
   * @returns {Promise<boolean>} 页面仍有效且拥有所需快照时为true；失败保留重试提示。
   */
  async syncTabSnapshot(generation) {
    // 旧请求结束前不启动第二个快照，头像下载与轮询不会因连续点击成倍增加。
    if (this._refreshPromise) await this._refreshPromise;
    if (generation !== this._navigationVersion || this.data.gate || this.data.busy) return false;
    // 当前日期已加载且仍在同步周期内，无需为切页重复获取同一份家庭数据。
    if (
      !this.data.timelinePending &&
      Date.now() - (this._snapshotLoadedAt || 0) < SNAPSHOT_FRESH_MS
    )
      return true;
    return this.refresh(true);
  },
  /**
   * 切换宝宝或家庭事项范围。
   * @param {object} e 范围事件，dataset.id为baby或family。
   * @returns {void} 使用已授权快照重新派生当前范围清单。
   */
  switchScope(e) {
    // 两大事项块使用各自的统计与流水，切换时清除宝宝和完成状态筛选。
    this.setData({ scope: e.currentTarget.dataset.id, selectedBaby: 'all', filter: 'all' });
    this.renderRows();
  },
  /**
   * 限定当前宝宝事项的展示对象。
   * @param {object} e 宝宝选项事件，dataset.id为宝宝ID或all。
   * @returns {void} 只重绘筛选，不向后端修改任务归属。
   */
  selectBaby(e) {
    // 宝宝归属是任务业务字段，此处只改变查看范围，不能将任务移动给另一宝宝。
    this.setData({ selectedBaby: e.currentTarget.dataset.id });
    this.renderRows();
  },
  /**
   * 查看全部、待办或完成事项。
   * @param {object} e 筛选事件，dataset.id为all/todo/done。
   * @returns {void} 保留同一日期快照并重绘筛选结果。
   */
  selectFilter(e) {
    // 完成率继续按当前范围全部事项统计，筛选本身不会产生执行流水。
    this.setData({ filter: e.currentTarget.dataset.id });
    this.renderRows();
  },
  /**
   * 从日期选择器请求历史快照。
   * @param {object} e 日期事件，detail.value为公历YYYY-MM-DD。
   * @returns {Promise<void>} 加载指定日期，失败由统一刷新流程提示。
   */
  async changeDate(e) {
    // 日期刷新中或提交中不竞争请求，旧清单和日期始终成对保留。
    if (this.data.busy || this.data.refreshing) return;
    const date = e && e.detail && e.detail.value;
    if (!d.validDate(date) || date > this.data.today) return;
    // 切日只有成功后才提交目标日期，失败不把旧记录显示成新一天。
    await this.refresh(false, { date, filter: 'all' });
  },
  /**
   * 按日浏览过去历史，家庭创建前显示空白记录。
   * @param {object} e 日期箭头事件，dataset.step为前后移动天数。
   * @returns {Promise<void>} 合法日期请求快照，越界时不发请求。
   */
  async changeDay(e) {
    // 连续点击不会提前改变日期或与正在提交的记录竞争快照。
    if (this.data.busy || this.data.refreshing || !d.validDate(this.data.date)) return;
    const step = Number(e && e.currentTarget && e.currentTarget.dataset.step);
    if (step !== -1 && step !== 1) return;
    const date = d.addDays(this.data.date, step);
    // 创建前可以看空白历史，未来则不能冒充已有执行历史。
    if (!d.validDate(date) || date > this.data.today) return;
    await this.refresh(false, { date, filter: 'all' });
  },
  /**
   * 记录历史日期条的单指起点，不拦截正常竖向滚动。
   * @param {object} event 微信触摸事件，touches应只有一个有效clientX/clientY点。
   * @returns {void} 仅保存本次手势的坐标与开始时间，不请求后端。
   */
  startHistorySwipe(event) {
    // 每次触摸先丢弃旧起点，跨页面或多指操作不能沿用上次日期手势。
    this._historyTouch = null;
    // 微信client坐标与滑动阈值都以逻辑像素计，不能混入屏幕物理像素。
    const touches = event && event.touches;
    if (
      this.data.view !== 'history' ||
      this.data.busy ||
      this.data.refreshing ||
      !touches ||
      touches.length !== 1
    )
      return;
    const { clientX: x, clientY: y } = touches[0];
    // 不接受异常坐标，避免NaN或无穷值被误判成一次有效滑动。
    // 这里只保存起点，结束时仍会重新检查页面和提交状态。
    if (Number.isFinite(x) && Number.isFinite(y)) this._historyTouch = { x, y, at: Date.now() };
  },
  /**
   * 将明确的横向滑动转换为前后一天，共用按钮的日期及并发边界。
   * @param {object} event changedTouches包含本次手势结束位置。
   * @returns {Promise<void>} 横向有效手势按日切换，其余触摸不产生请求。
   */
  async endHistorySwipe(event) {
    const origin = this._historyTouch;
    // 起点只消费一次，重复touchend或离开历史页后不能再次切日。
    this._historyTouch = null;
    // changedTouches限定一指，双指缩放或意外触控不映射成日期操作。
    const touches = event && event.changedTouches;
    if (!origin || this.data.view !== 'history' || !touches || touches.length !== 1) return;
    // 只比较相对位移，日期条在页面中的位置不影响方向判断。
    const dx = touches[0].clientX - origin.x,
      dy = touches[0].clientY - origin.y;
    // 只接受短时、足够长且横向占主导的手势，竖向滚动和点击不会误翻页。
    if (
      !Number.isFinite(dx) ||
      !Number.isFinite(dy) ||
      Date.now() - origin.at > HISTORY_SWIPE.maxDuration ||
      Math.abs(dx) < HISTORY_SWIPE.distance ||
      Math.abs(dx) <= Math.abs(dy) * HISTORY_SWIPE.axisRatio
    )
      return;
    // 向右看前一天，向左看后一天；未来和并发边界由统一切日方法处理。
    await this.changeDay({ currentTarget: { dataset: { step: dx > 0 ? -1 : 1 } } });
  },
  /**
   * 完成或撤销当天事项，完成时允许用户主动选择拍照。
   * @param {object} e 勾选事件，dataset.id为当前清单中的事项ID。
   * @returns {Promise<void>} 仅服务端提交成功才显示完成感谢，取消保持原状态。
   */
  async toggle(e) {
    // 历史只读；提交或拍照选择尚未结束时不能启动第二次完成流程。
    if (this.data.view === 'history' || this.data.busy || this._completing) return;
    const row = this.data.rows.find((r) => r.id === e.currentTarget.dataset.id);
    // 页面刷新后行可能已移除，过期点击不能凭旧ID制造完成记录。
    if (!row) return;
    // 撤销与完成均带版本号，服务端拒绝覆盖其他家人的新状态。
    if (row.done) {
      const confirm = await wx.showModal({
        title: '撤销这次打勾？',
        content: `${row.subjectName} · ${row.title}`,
      });
      // 撤销确认被取消时不提交新revision，也不删除已有完成照片。
      if (!confirm.confirm) return;
    }
    // 拍照期间也阻止重复点击；取消拍照或上传失败时保留未完成状态。
    this._completing = true;
    try {
      // 照片可选；直接完成不会申请相机权限或创建占位照片。
      let photoId = '';
      if (!row.done) {
        let choice;
        try {
          // 先由用户明确选择拍照，不能因为点击完成而自动打开系统相机。
          choice = await wx.showActionSheet({ itemList: ['拍照记录并完成', '直接完成'] });
        } catch (_) {
          // 关闭操作菜单等同放弃本次完成，不把关闭菜单当成直接完成。
          return;
        }
        if (choice.tapIndex === 0) {
          photoId = await this.chooseCompletionPhoto(row);
          // 取消拍照或上传未成功时不提交完成，避免展示不存在的记录照片。
          if (!photoId) return;
        }
      }
      // 预期版本来自点击时那一行，另一位家人并发更新后必须由服务端拒绝覆盖。
      await this.run(
        'complete',
        {
          taskId: row.id,
          date: this.data.today,
          done: !row.done,
          expectedRevision: row.revision,
          photoId,
        },
        !row.done ? completionMessage(row) : '已撤销打勾'
      );
    } finally {
      // 所有退出路径都释放本次选择状态，下次仍可直接完成。
      this._completing = false;
    }
  },
  /**
   * 为当天未完成事项发起一次手动提醒。
   * @param {object} e 提醒按钮事件，dataset.id为事项ID。
   * @returns {Promise<void>} 展示后端实际发送状态，失败不冒充已送达。
   */
  async nudge(e) {
    // 接收人和冷却时间由服务端确定，客户端不能在按钮参数里任意指定家人。
    await this.run('nudge', { taskId: e.currentTarget.dataset.id, date: this.data.today });
  },
};
