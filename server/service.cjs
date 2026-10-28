const d = require('./domain');

/**
 * 云端业务入口。数据库适配层负责事务和存储，本层负责权限与状态转换。
 * @param {object} repo 支持get、put、transaction、list的受信存储接口。
 * @param {object} options 云端配置与随机数、时间、微信发送适配器。
 * @returns {object} call处理小程序请求，tick仅供独立定时云函数调用。
 */
function createService(repo, options) {
  const { now, randomId, hash, ownerOpenId, templateId, sendMessage } = options;
  const uid = (openid) => hash(openid).slice(0, 32);
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const cleanName = (value) =>
    String(value || '')
      .trim()
      .slice(0, 12);

  /**
   * @param {string} openid 微信上下文中的可信身份。
   * @returns {Promise<object>} 请求人有权访问的家庭。
   * @throws {Error} 未审批或已移除成员不能读取。
   */
  async function readMember(openid) {
    const home = await repo.get('care_home', 'home');
    // 每次读取重新校验成员资格；不能使用客户端缓存的管理员标记。
    d.assertMember(home, uid(openid));
    return home;
  }

  /**
   * @param {string} openid 当前微信身份。
   * @param {object} data 可选date，必须处于家庭创建日至今天之间。
   * @returns {Promise<object>} 权限过滤后的配置、日记录和消息结果。
   * @throws {Error} 无权访问或查询日期不合法。
   */
  async function snapshot(openid, data) {
    // 先校验身份，再读取任何宝宝、任务或执行信息。
    const home = await readMember(openid);
    const today = d.chinaDate(now());
    const date = data.date || today;
    check(
      d.validDate(date) && date <= today && date >= home.createdDate,
      '请选择家庭创建之后、今天之前的有效日期'
    );
    // 日记录独立存储，避免家庭使用多年后单个配置文档持续膨胀。
    const day = await repo.get('care_days', date);
    const requests =
      home.ownerId === uid(openid)
        ? await repo.list('care_requests', { status: 'pending' }, 50)
        : [];
    // 审批列表只给管理员；普通成员无需知道其他人的入家申请。
    const messages = await repo.list('care_messages', { date }, 100);
    const user = await repo.get('care_users', uid(openid));
    // OPENID只在care_users中供服务端发送，返回给家人的成员ID均为哈希。
    // 返回消息状态而不返回微信接口错误正文，避免内部配置进入产品页面。
    return {
      home,
      day,
      requests: requests.map((r) => ({ id: r.id, name: r.name, createdAt: r.createdAt })),
      messages: messages.map((m) => ({
        id: m.id,
        taskId: m.taskId,
        status: m.status,
        recipientId: m.recipientId,
        type: m.type,
      })),
      actorId: uid(openid),
      date,
      today,
      configured: !!templateId,
      subscribed: !!(user && user.subscribed),
    };
  }

  /**
   * @param {string} openid 申请者自己的微信身份，不能由请求体替换。
   * @param {object} data 一次性token及申请者家庭称呼。
   * @returns {Promise<object>} 等待管理员审核的提交结果。
   * @throws {Error} 邀请过期、已使用、已是有效成员或称呼为空。
   */
  async function applyInvite(openid, data) {
    const at = now();
    const token = String(data.token || '').trim();
    check(/^[a-f0-9]{32}$/.test(token), '邀请码不正确');
    check(cleanName(data.name), '请填写你在家庭中的称呼');
    return repo.transaction(async (tx) => {
      // 只存token的哈希，数据库普通记录不会直接暴露可使用的邀请码。
      const invitation = await tx.get('care_invites', hash(token));
      check(
        invitation && invitation.status === 'active' && invitation.expiresAt > at,
        '邀请已失效，请联系管理员重新邀请'
      );
      const home = await tx.get('care_home', 'home');
      // 验证签发人仍属于当前家庭，防止错误环境中的邀请串用。
      check(home && home.ownerId === invitation.ownerId, '邀请不属于当前家庭');
      check(!home.members.some((m) => m.id === uid(openid) && m.active), '你已经是家庭成员');
      // 一份邀请仅供一人申请；转发得到链接也仍需管理员批准。
      await tx.put('care_invites', hash(token), {
        ...invitation,
        status: 'used',
        usedBy: uid(openid),
      });
      await tx.put('care_requests', uid(openid), {
        id: uid(openid),
        name: cleanName(data.name),
        status: 'pending',
        createdAt: at,
      });
      // 审批前只保存申请身份，不把申请者写进有效成员列表。
      await tx.put('care_users', uid(openid), { openid, subscribed: false });
      return { message: '申请已提交，等待家庭管理员确认' };
    });
  }

  /**
   * @param {string} openid 审核者身份，必须是家庭管理员。
   * @param {object} data 待审requestId与布尔approve，审批结果不可为空。
   * @returns {Promise<object>} 已同意或拒绝的业务说明。
   * @throws {Error} 非管理员、申请已处理或成员人数达到上限。
   */
  async function reviewInvite(openid, data) {
    return repo.transaction(async (tx) => {
      const home = await tx.get('care_home', 'home');
      d.assertOwner(home, uid(openid));
      // 审批与成员生效在同一事务中，不能出现“审核成功但仍无访问权限”。
      const request = await tx.get('care_requests', data.requestId);
      check(request && request.status === 'pending', '该申请已经处理');
      check(typeof data.approve === 'boolean', '审核结果不正确');
      if (data.approve) {
        check(home.members.filter((m) => m.active).length < 20, '家庭最多支持20位成员');
        // 重新邀请已移除成员时复用身份，历史归属不会断开。
        const old = home.members.find((m) => m.id === request.id);
        if (old) Object.assign(old, { name: request.name, active: true });
        else home.members.push({ id: request.id, name: request.name, active: true });
        home.version += 1;
        await tx.put('care_home', 'home', home);
      }
      await tx.put('care_requests', request.id, {
        ...request,
        status: data.approve ? 'approved' : 'rejected',
        reviewedAt: now(),
      });
      return { message: data.approve ? '家人已加入' : '已拒绝该申请' };
    });
  }

  /**
   * @param {string} openid 当前可信微信身份。
   * @param {string} action 已通过入口白名单的业务操作。
   * @param {object} data 不包含可信时间或操作者身份的业务参数。
   * @returns {Promise<object>} 事务提交结果与实际通知状态。
   * @throws {Error} 权限、业务校验或数据库提交失败。
   */
  async function mutate(openid, action, data) {
    const at = now();
    const result = await repo.transaction(async (tx) => {
      const home = await tx.get('care_home', 'home');
      const date = d.chinaDate(at);
      const day = await tx.get('care_days', date);
      const next = d.transition(home, day, uid(openid), action, data, at, randomId);
      if (action === 'saveBaby') {
        // 只接受由本家庭头像上传入口登记过的文件，不接受任意云文件ID。
        if (data.avatar) {
          const file = await tx.get('care_files', hash(data.avatar));
          check(file && file.ownerId === home.ownerId, '头像文件无权使用，请重新上传');
        }
      }
      await tx.put('care_home', 'home', next.home);
      if (action === 'complete' || action === 'nudge') await tx.put('care_days', date, next.day);
      if (action === 'nudge') {
        const { row, recipientId, eventId } = next.result;
        await tx.put(
          'care_messages',
          eventId,
          notification(row, date, recipientId, 'manual', eventId)
        );
      }
      return next.result;
    });
    if (action === 'nudge') {
      // 事务只入队，微信外部请求在提交之后执行，避免事务重试重复通知。
      const status = await deliver(result.eventId);
      return {
        ...result,
        status,
        message:
          status === 'sent'
            ? '微信提醒已发送'
            : status === 'no_quota'
              ? '对方没有可用订阅授权，请分享任务卡片提醒'
              : status === 'unconfigured'
                ? '提醒已记录，微信通知尚未配置'
                : '提醒已记录，微信通知暂未发出',
      };
    }
    return result;
  }

  function notification(row, date, recipientId, type, id) {
    // 接收人来自任务执行人，客户端不能指定任意微信用户作为发送对象。
    return {
      id,
      taskId: row.id,
      date,
      recipientId,
      type,
      title: row.title,
      subjectName: row.subjectName,
      time: row.executionTime || d.chinaTime(now()),
      status: 'queued',
      createdAt: now(),
    };
  }

  /**
   * @param {string} messageId 已在数据库持久化的消息ID，不接受任意接收人参数。
   * @returns {Promise<string>} 真实处理状态，未发送不得返回sent。
   * @throws {Error} 数据库失败时由云函数日志与监控记录，未知外部结果不盲目重发。
   */
  async function deliver(messageId) {
    const claim = await repo.transaction(async (tx) => {
      const message = await tx.get('care_messages', messageId);
      if (!message || message.status !== 'queued') return null;
      const home = await tx.get('care_home', 'home');
      const day = await tx.get('care_days', message.date);
      const user = await tx.get('care_users', message.recipientId);
      const row =
        home && d.rowsForDate(home, day, message.date).find((r) => r.id === message.taskId);
      let status = 'sending';
      // 发送前重新检查成员和完成状态，移除成员后队列也不能继续向其发送。
      if (
        !row ||
        row.done ||
        !row.assigneeActive ||
        !row.notifyMemberActive ||
        row.notifyMemberId !== message.recipientId ||
        ![d.chinaDate(now()), d.addDays(d.chinaDate(now()), -1)].includes(message.date)
      )
        status = 'skipped';
      else if (!templateId) status = 'unconfigured';
      else if (!user || !user.subscribed) status = 'no_quota';
      await tx.put('care_messages', messageId, { ...message, status, claimedAt: now() });
      return { ...message, status, openid: user && user.openid };
    });
    if (!claim) return 'already_processed';
    if (claim.status !== 'sending') return claim.status;
    let status = 'sent';
    let errorCode = '';
    try {
      await sendMessage(claim);
    } catch (error) {
      errorCode = String(error.errCode || error.errcode || 'unknown');
      status = errorCode === '43101' ? 'no_quota' : 'failed';
      // 不自动重发结果未知的外部调用，以免家人收到重复通知。
    }
    await repo.transaction(async (tx) => {
      const stored = await tx.get('care_messages', messageId);
      await tx.put('care_messages', messageId, { ...stored, status, errorCode, finishedAt: now() });
      if (status === 'no_quota') {
        const user = await tx.get('care_users', claim.recipientId);
        if (user) await tx.put('care_users', claim.recipientId, { ...user, subscribed: false });
      }
    });
    return status;
  }

  /**
   * @returns {Promise<object>} 本次检查任务数与微信接口成功接收数；不代表家人已读。
   * @throws {Error} 云端存储不可用时让调度记录失败，不能假报无到期任务。
   */
  async function tick() {
    const home = await repo.get('care_home', 'home');
    if (!home) return { checked: 0, sent: 0 };
    const today = d.chinaDate(now());
    const currentTime = new Date(now()).getTime();
    let checked = 0;
    let sent = 0;
    // 同时检查昨天与今天，覆盖深夜任务在次日才超时的边界。
    for (const date of [d.addDays(today, -1), today]) {
      const rows = d.rowsForDate(home, await repo.get('care_days', date), date);
      checked += rows.length;
      for (const row of rows.filter(
        (r) =>
          !r.done &&
          r.assigneeActive &&
          r.notifyMemberActive &&
          d.overdueAt(date, r.executionTime) <= currentTime
      )) {
        const messageId = hash(`auto:${date}:${row.id}:${row.notifyMemberId}`).slice(0, 40);
        // 唯一日期、任务、接收人组成消息ID，重复定时触发不会重复入队。
        await repo.transaction(async (tx) => {
          if (!(await tx.get('care_messages', messageId)))
            await tx.put(
              'care_messages',
              messageId,
              notification(row, date, row.notifyMemberId, 'auto', messageId)
            );
        });
        if ((await deliver(messageId)) === 'sent') sent += 1;
      }
    }
    return { checked, sent };
  }

  /**
   * @param {string} openid 由云函数上下文传入的微信身份。
   * @param {string} action 明确白名单操作，禁止客户端触发tick。
   * @param {object} data 操作参数，敏感字段在对应分支逐项校验。
   * @returns {Promise<object>} 适合小程序消费的业务结果。
   * @throws {Error} 非法身份、未知操作或权限不足。
   */
  async function call(openid, action, data = {}) {
    check(openid, '需要通过微信小程序调用');
    const actorId = uid(openid);
    if (action === 'bootstrap') {
      const home = await repo.get('care_home', 'home');
      const member = home && home.members.find((m) => m.id === actorId && m.active);
      const request = !member && (await repo.get('care_requests', actorId));
      // 未加入用户只能得到自己的状态，不泄露宝宝或成员列表。
      return {
        actorId,
        openid,
        member: !!member,
        canCreate: !home && !!ownerOpenId && openid === ownerOpenId,
        ownerConfigured: !!ownerOpenId,
        requestStatus: (request && request.status) || '',
        configured: !!templateId,
      };
    }
    if (action === 'createHome')
      return repo.transaction(async (tx) => {
        check(ownerOpenId && openid === ownerOpenId, '仅预设管理员可以创建这个家庭');
        check(!(await tx.get('care_home', 'home')), '家庭已经创建');
        const home = d.createHome(actorId, data.name, d.chinaDate(now()));
        await tx.put('care_home', 'home', home);
        await tx.put('care_users', actorId, { openid, subscribed: false });
        return { message: '欢迎回家，一起把日常小事记下来吧' };
      });
    if (action === 'applyInvite') return applyInvite(openid, data);
    if (action === 'reviewInvite') return reviewInvite(openid, data);
    if (action === 'snapshot') return snapshot(openid, data);
    if (action === 'makeInvite') {
      const home = await readMember(openid);
      d.assertOwner(home, actorId);
      const token = randomId();
      const expiresAt = new Date(new Date(now()).getTime() + 86400000).toISOString();
      await repo.put('care_invites', hash(token), {
        ownerId: actorId,
        status: 'active',
        expiresAt,
      });
      return { token, expiresAt, message: '一次性邀请已生成，24小时有效，加入仍需你确认' };
    }
    if (action === 'subscribe') {
      await readMember(openid);
      check(templateId, '微信提醒模板尚未配置');
      check(data.templateId === templateId && data.accepted === true, '未获得该模板的订阅授权');
      // 本地标记仅用于减少无效请求；最终是否有额度由微信发送接口判断。
      await repo.put('care_users', actorId, { openid, subscribed: true, subscribedAt: now() });
      return { message: '已记录订阅授权，实际发送次数以微信为准' };
    }
    const actions = [
      'saveBaby',
      'saveTask',
      'setPinned',
      'archiveTask',
      'complete',
      'nudge',
      'profile',
      'removeMember',
    ];
    check(actions.includes(action), '不支持的操作');
    return mutate(openid, action, data);
  }
  return { call, tick, readMember };
}
module.exports = { createService };
