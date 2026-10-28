/* 小程序、云函数与本地体验共用业务规则，避免三种运行方式出现不同周期。 */
const DAY = 86400000;
const clone = (value) => JSON.parse(JSON.stringify(value));
const ensure = (condition, message) => {
  if (!condition) throw new Error(message);
};
const text = (value, max = 30) =>
  String(value || '')
    .trim()
    .slice(0, max);
const shifted = (now) => new Date(new Date(now).getTime() + 8 * 3600000).toISOString();
const chinaDate = (now) => shifted(now).slice(0, 10);
const chinaTime = (now) => shifted(now).slice(11, 16);
const dateNumber = (date) => Date.parse(`${date}T00:00:00Z`);
const validDate = (date) =>
  /^\d{4}-\d{2}-\d{2}$/.test(date || '') &&
  Number.isFinite(dateNumber(date)) &&
  new Date(dateNumber(date)).toISOString().slice(0, 10) === date;
const addDays = (date, count) =>
  new Date(dateNumber(date) + count * DAY).toISOString().slice(0, 10);
const weekday = (date) => new Date(dateNumber(date)).getUTCDay() || 7;

/**
 * 判断固定日历周期；打勾时间不会改变下一次执行日期。
 * @param {object} rule 任务版本中的周期，星期取1至7。
 * @param {string} date 北京时间日历日期，格式YYYY-MM-DD。
 * @returns {boolean} 该日期是否应执行。
 */
function isDue(rule, date) {
  // 先排除任务开始之前的日期；按UTC日历整数计算可避开夏令时。
  if (!validDate(date) || date < rule.startDate) return false;
  if (rule.frequency === 'daily') return true;
  if (rule.frequency === 'weekly') return rule.weekdays.includes(weekday(date));
  return Math.round((dateNumber(date) - dateNumber(rule.startDate)) / DAY) % rule.interval === 0;
}

/**
 * 验证请求人仍是有效家人。
 * @param {?object} home 服务端读取的家庭，不存在时也拒绝访问。
 * @param {string} actorId 从可信微信身份派生的成员ID。
 * @returns {object} 当前有效成员。
 * @throws {Error} 未受邀、未审批或已移除时拒绝。
 */
function assertMember(home, actorId) {
  // 不信任客户端传入的家庭ID或身份；后端actor来自微信OPENID。
  const member = home && home.members.find((m) => m.id === actorId && m.active);
  ensure(member, '无权访问这个家庭，请等待邀请审核或重新联系管理员');
  return member;
}

/**
 * 验证家庭管理权限。
 * @param {object} home 当前家庭配置。
 * @param {string} actorId 当前可信成员ID，必须同时是有效成员和管理员。
 * @returns {void} 校验通过则继续执行。
 * @throws {Error} 请求人不是有效管理员。
 */
function assertOwner(home, actorId) {
  assertMember(home, actorId);
  // 成员不能通过修改前端界面获得管理权限。
  ensure(home.ownerId === actorId, '仅家庭管理员可以进行此操作');
}

/**
 * 生成空白家庭，真实入口还需校验预设管理员白名单。
 * @param {string} ownerId 管理员的内部成员ID，不是客户端提交的角色标记。
 * @param {string} name 管理员家庭称呼，最多12字。
 * @param {string} date 创建日期，北京时间YYYY-MM-DD。
 * @returns {object} 不含示例宝宝或任务的家庭配置。
 * @throws {Error} 家庭称呼为空。
 */
function createHome(ownerId, name, date) {
  // 真实环境只允许配置的OWNER_OPENID初始化，入口另作服务端校验。
  ensure(text(name), '请填写你的家庭称呼');
  // 正式家庭从空白开始，示例数据只能由独立体验入口生成。
  // 管理员身份保留在配置中，前端隐藏按钮只是交互提示而非权限措施。
  return {
    id: 'home',
    ownerId,
    createdDate: date,
    version: 1,
    members: [{ id: ownerId, name: text(name, 12), active: true }],
    babies: [],
    tasks: [],
  };
}

/**
 * 获取某日期生效的任务版本。
 * @param {object} task 带完整版本历史的任务。
 * @param {string} date 查询日期，YYYY-MM-DD。
 * @returns {object|undefined} 最近生效版本，尚未创建时为空。
 */
function taskVersion(task, date) {
  // 每次编辑保存版本；历史查询按当时的规则重建，而非套用今天的配置。
  return task.versions
    .filter((v) => v.effectiveDate <= date)
    .sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate))[0];
}

function ruleLabel(rule) {
  // 给用户显示具体周期，避免把“每2天”误解为“隔2天”。
  if (rule.frequency === 'daily') return '每天';
  if (rule.frequency === 'interval')
    return rule.interval === 2 ? '隔一天' : `每 ${rule.interval} 天`;
  return `每周${rule.weekdays.map((n) => '一二三四五六日'[n - 1]).join('、')}`;
}

/**
 * 合并日历任务与当日记录；没有打开过小程序的日期仍可还原应做项目。
 * @param {object} home 家庭配置与版本化任务。
 * @param {?object} day 当日记录；不存在时传null。
 * @param {string} date 待查询的日历日期。
 * @returns {Array} 附带宝宝、执行人与完成信息的清单。
 */
function rowsForDate(home, day, date) {
  // 当天没有操作记录时，应做任务仍需显示为未完成，不能误判为没有任务。
  const records = (day && day.records) || {};
  return home.tasks
    .map((task) => {
      const version = taskVersion(task, date);
      // 归档从次日生效，不抹掉归档前的任务或完成记录。
      if (!version || version.archived || !isDue(version, date)) return null;
      const baby = home.babies.find((b) => b.id === task.babyId);
      // 执行人离家后不继续发送通知，但历史任务仍显示并提示重新分配。
      const assignee = home.members.find((m) => m.id === version.assigneeId && m.active);
      const record = records[task.id] || {};
      // 已完成者的称呼取自执行当时的快照，改名或移除成员不能篡改历史归属。
      // revision交给客户端随操作带回，以拒绝过期页面覆盖刚发生的完成动作。
      return {
        ...version,
        id: task.id,
        babyId: task.babyId,
        babyName: baby ? baby.name : '宝宝',
        avatar: (baby && baby.avatar) || '',
        color: (baby && baby.color) || 'peach',
        assigneeName: assignee ? assignee.name : '待重新分配',
        assigneeActive: !!assignee,
        done: !!record.done,
        revision: record.revision || 0,
        completedAt: record.completedAt || '',
        completedByName: record.completedByName || '',
        ruleLabel: ruleLabel(version),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.reminderTime.localeCompare(b.reminderTime) || a.id.localeCompare(b.id));
}

/**
 * 校验任务表单并生成有界周期配置。
 * @param {object} home 用于验证宝宝与执行人的家庭配置。
 * @param {object} data 标题、开始日期、重复规则、执行人与提醒时间。
 * @returns {object} 仅包含允许保存的任务字段。
 * @throws {Error} 日期、星期、间隔、时间或执行人不合法。
 */
function validateTask(home, data) {
  const startDate = data.startDate;
  // 不能让无效日期被JavaScript自动顺延成下个月，也不能分配给外人。
  ensure(text(data.title, 60), '请填写任务名称');
  ensure(validDate(startDate), '开始日期不正确');
  ensure(['daily', 'interval', 'weekly'].includes(data.frequency), '请选择重复周期');
  ensure(
    home.members.some((m) => m.id === data.assigneeId && m.active),
    '请选择有效的家庭执行人'
  );
  const interval = Number(data.interval || (data.frequency === 'interval' ? 0 : 1));
  // 去重后按星期排列，重复点击或乱序传参不会产生多次执行。
  const weekdays = [...new Set(data.weekdays || [])].sort((a, b) => a - b);
  ensure(
    data.frequency !== 'interval' ||
      (Number.isInteger(interval) && interval >= 1 && interval <= 365),
    '间隔需为1至365天'
  );
  ensure(
    data.frequency !== 'weekly' ||
      (weekdays.length > 0 && weekdays.every((n) => Number.isInteger(n) && n >= 1 && n <= 7)),
    '至少选择一个有效星期'
  );
  ensure(/^([01]\d|2[0-3]):[0-5]\d$/.test(data.reminderTime || ''), '提醒时间不正确');
  // 只返回业务白名单字段，防止客户端夹带archived或effectiveDate改写历史。
  return {
    title: text(data.title, 60),
    assigneeId: data.assigneeId,
    frequency: data.frequency,
    interval,
    weekdays,
    startDate,
    reminderTime: data.reminderTime,
    archived: false,
  };
}

/**
 * 新建任务，或保存次日起生效的任务版本。
 * @param {object} home 待提交的家庭副本。
 * @param {object} data 编辑时带taskId，新建时带有效babyIds。
 * @param {string} today 服务端计算的北京时间日期。
 * @param {Function} makeId 服务端随机ID生成器，不使用可预测的递增ID。
 * @returns {object} 用户可理解的生效时间说明。
 * @throws {Error} 任务不存在、宝宝无效或超出数量边界。
 */
function saveTask(home, data, today, makeId) {
  const version = validateTask(home, data);
  if (data.taskId) {
    const task = home.tasks.find((t) => t.id === data.taskId);
    ensure(task, '任务不存在');
    // 编辑从次日生效；同一天反复修改只保留次日的最终版本。
    const effectiveDate = addDays(today, 1);
    task.versions = task.versions.filter((v) => v.effectiveDate !== effectiveDate);
    task.versions.push({ ...version, effectiveDate });
    return { message: '已保存，明天起生效；今天和历史记录保持原样' };
  }
  const babyIds = [...new Set(data.babyIds || [])];
  ensure(
    babyIds.length > 0 && babyIds.every((id) => home.babies.some((b) => b.id === id)),
    '请选择宝宝'
  );
  ensure(home.tasks.length + babyIds.length <= 200, '任务数量已达200项，请整理后再添加');
  // 为两个宝宝创建不同任务ID，之后独立打勾与追踪历史。
  babyIds.forEach((babyId) =>
    home.tasks.push({
      id: makeId(),
      babyId,
      versions: [
        {
          ...version,
          effectiveDate: today,
          startDate: version.startDate < today ? today : version.startDate,
        },
      ],
    })
  );
  return { message: '任务已添加' };
}

/**
 * 保存当天完成、撤销或手动催办。
 * @param {object} home 当前家庭配置。
 * @param {object} day 当前日期的执行记录副本。
 * @param {object} member 已通过成员校验的操作者。
 * @param {string} action complete或nudge，不接受任意事件类型。
 * @param {object} data 任务ID、当天日期与完成时的预期记录版本。
 * @param {string} now 服务端当前ISO时间，用于审计与冷却。
 * @param {Function} makeId 执行流水与催办事件的随机ID生成器。
 * @returns {object} 提交结果，催办时还返回可信接收人与任务摘要。
 * @throws {Error} 非当天、状态冲突、已完成、执行人离家或催办过频。
 */
function modifyDay(home, day, member, action, data, now, makeId) {
  const today = chinaDate(now);
  ensure(data.date === today, '只能操作当天任务，历史记录仅供查看');
  const row = rowsForDate(home, day, today).find((r) => r.id === data.taskId);
  // 客户端即使伪造任务ID，也不能给非当天应做的事项制造执行记录。
  ensure(row, '这一天没有此项任务');
  const current = day.records[row.id] || { revision: 0, done: false };
  if (action === 'complete') {
    // 防止多个家人同时操作时，旧页面把他人刚完成的状态覆盖掉。
    ensure(data.expectedRevision === current.revision, '记录已更新，请刷新后再操作');
    ensure(typeof data.done === 'boolean', '完成状态不正确');
    // 撤销保留独立流水，但清空当前完成标记，避免页面同时展示两种状态。
    day.records[row.id] = {
      revision: current.revision + 1,
      done: data.done,
      completedByName: data.done ? member.name : '',
      completedBy: data.done ? member.id : '',
      completedAt: data.done ? now : '',
    };
    day.events.push({
      id: makeId(),
      type: data.done ? 'complete' : 'undo',
      taskId: row.id,
      title: row.title,
      babyName: row.babyName,
      actorName: member.name,
      at: now,
    });
    return { message: data.done ? '完成啦，辛苦了 ♡' : '已撤销勾选' };
  }
  ensure(!row.done, '这件事已经完成，不需要再提醒');
  ensure(row.assigneeActive, '请先重新分配执行人');
  const key = `${row.id}:${row.assigneeId}`;
  const previous = day.nudges[key];
  // 按任务和接收人统一冷却，避免多个家人轮流点击产生刷屏。
  ensure(!previous || new Date(now) - new Date(previous) >= 600000, '刚刚提醒过，请稍后再试');
  day.nudges[key] = now;
  const eventId = makeId();
  // 催办只记录真实发起人，不能直接作为微信发送成功的证据。
  day.events.push({
    id: eventId,
    type: 'nudge',
    taskId: row.id,
    title: row.title,
    babyName: row.babyName,
    actorName: member.name,
    at: now,
    recipientId: row.assigneeId,
  });
  return {
    message: '已记下提醒；微信通知结果请查看发送状态',
    recipientId: row.assigneeId,
    eventId,
    row,
  };
}

/**
 * 家庭状态转换。调用方负责事务提交；此函数不会原地修改传入对象。
 * @param {object} originalHome 经过服务端读取的家庭配置。
 * @param {?object} originalDay 对应日期的记录。
 * @param {string} actorId 服务端可信身份，本地体验使用模拟身份。
 * @param {string} action 明确列入白名单的业务操作。
 * @param {object} data 经本函数校验的业务参数。
 * @param {string} now 当前ISO时间，不接受客户端指定云端时间。
 * @param {Function} makeId 服务端随机ID生成器。
 * @returns {object} 待提交的home、day和业务结果；无权限或冲突时抛出异常。
 */
function transition(originalHome, originalDay, actorId, action, data, now, makeId) {
  // 原对象来自数据库或本地持久化；操作失败时必须能整体丢弃这份副本。
  const home = clone(originalHome);
  const member = assertMember(home, actorId);
  const today = chinaDate(now);
  const day = clone(originalDay || { date: today, records: {}, events: [], nudges: {} });
  let result;
  if (action === 'saveBaby') {
    assertOwner(home, actorId);
    // 宝宝资料由管理员统一维护，避免家人误把另一个宝宝的名字或头像改掉。
    ensure(text(data.name, 12), '请填写宝宝名字');
    const baby = home.babies.find((b) => b.id === data.babyId);
    if (data.babyId) ensure(baby, '宝宝不存在');
    ensure(baby || home.babies.length < 10, '最多可添加10位宝宝');
    // 头像地址必须通过服务端上传入口验证；本地体验才使用本地图片路径。
    if (baby)
      Object.assign(baby, {
        name: text(data.name, 12),
        avatar: data.avatar === undefined ? baby.avatar : data.avatar,
      });
    else
      home.babies.push({
        id: makeId(),
        name: text(data.name, 12),
        avatar: data.avatar || '',
        color: home.babies.length % 2 ? 'sage' : 'peach',
      });
    result = { message: '宝宝资料已保存' };
  } else if (action === 'saveTask') {
    result = saveTask(home, data, today, makeId);
  } else if (action === 'archiveTask') {
    const task = home.tasks.find((t) => t.id === data.taskId);
    ensure(task, '任务不存在');
    const effectiveDate = addDays(today, 1);
    const current = taskVersion(task, effectiveDate);
    // 与当天编辑使用相同生效边界，先编辑再停用也只留下一个最终版本。
    task.versions = task.versions.filter((v) => v.effectiveDate !== effectiveDate);
    task.versions.push({ ...current, effectiveDate, archived: true });
    result = { message: '明天起停止此任务，历史记录保留' };
  } else if (action === 'complete' || action === 'nudge') {
    result = modifyDay(home, day, member, action, data, now, makeId);
  } else if (action === 'profile') {
    // 成员只能修改自己的家庭称呼，不能借此修改其他成员或管理员身份。
    ensure(text(data.name, 12), '请填写家庭称呼');
    member.name = text(data.name, 12);
    result = { message: '称呼已更新' };
  } else if (action === 'removeMember') {
    assertOwner(home, actorId);
    ensure(data.memberId !== home.ownerId, '不能移除家庭管理员');
    const target = home.members.find((m) => m.id === data.memberId && m.active);
    ensure(target, '成员不存在');
    // 保留历史中的完成人姓名，只撤销之后的访问权限。
    target.active = false;
    result = { message: '已移除成员，请检查该成员负责的任务' };
  } else throw new Error('不支持的操作');
  home.version += 1;
  // 版本与业务变更一起提交，客户端可以据此识别家庭配置发生变化。
  return { home, day, result };
}

function createDemo(today) {
  const home = createHome('demo-owner', '我', addDays(today, -7));
  home.members.push({ id: 'demo-family', name: '家人', active: true });
  home.babies = [
    { id: 'baby-one', name: '大宝', avatar: '', color: 'peach' },
    { id: 'baby-two', name: '二宝', avatar: '', color: 'sage' },
  ];
  // 示例仅存本机，不冒充已接通的家庭同步或微信通知。
  const specs = [
    ['准备外出用品', 'baby-one', '08:00', 'daily'],
    ['清洗安抚玩具', 'baby-two', '10:30', 'interval'],
    ['整理宝宝衣物', 'baby-one', '15:00', 'weekly'],
    ['准备睡前用品', 'baby-two', '20:00', 'daily'],
  ];
  specs.forEach((s, i) =>
    home.tasks.push({
      id: `demo-task-${i}`,
      babyId: s[1],
      versions: [
        {
          title: s[0],
          assigneeId: i % 2 ? 'demo-family' : 'demo-owner',
          frequency: s[3],
          interval: 2,
          weekdays: [weekday(today)],
          startDate: today,
          effectiveDate: today,
          reminderTime: s[2],
          archived: false,
        },
      ],
    })
  );
  return home;
}

const api = {
  chinaDate,
  chinaTime,
  validDate,
  addDays,
  weekday,
  isDue,
  assertMember,
  assertOwner,
  createHome,
  rowsForDate,
  taskVersion,
  ruleLabel,
  transition,
  createDemo,
};
if (typeof module !== 'undefined') module.exports = api;
if (typeof window !== 'undefined') window.CareDomain = api;
