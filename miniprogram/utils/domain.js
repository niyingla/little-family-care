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
 * 按照片所属日历日计算宝宝周岁、月龄和余天，月底按当月最后一天对齐。
 * @param {string} birthDate 可空的公历出生日期，格式YYYY-MM-DD。
 * @param {string} date 照片的北京时间日期，不得早于出生日期。
 * @returns {string} 当天年龄文案；日期缺失、不合法或尚未出生时为空。
 */
function babyAgeLabel(birthDate, date) {
  // 不猜测缺失生日，也不为出生前的历史照片显示负年龄。
  if (!validDate(birthDate) || !validDate(date) || date < birthDate) return '';
  const [year, month, day] = birthDate.split('-').map(Number);
  const [targetYear, targetMonth] = date.split('-').map(Number);
  let months = (targetYear - year) * 12 + targetMonth - month;
  const anniversary = (count) => {
    // 31日出生遇到小月，以及闰日周年，均取目标月最后一个有效日期。
    const first = new Date(Date.UTC(year, month - 1 + count, 1));
    const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
    first.setUTCDate(Math.min(day, last.getUTCDate()));
    return first.toISOString().slice(0, 10);
  };
  // 未到本月对应日时，只计已满的月份，余天从最近满月日计算。
  if (anniversary(months) > date) months -= 1;
  const days = Math.round((dateNumber(date) - dateNumber(anniversary(months))) / DAY);
  if (!months) return days ? `出生${days}天` : '出生当天';
  return `${Math.floor(months / 12) ? `${Math.floor(months / 12)}岁` : ''}${months % 12 ? `${months % 12}个月` : ''}${days ? `${days}天` : ''}`;
}

/**
 * 判断固定日历周期；打勾时间不会改变下一次执行日期。
 * @param {object} rule 任务版本中的周期，星期取1至7。
 * @param {string} date 北京时间日历日期，格式YYYY-MM-DD。
 * @returns {boolean} 该日期是否应执行。
 */
function isDue(rule, date) {
  // 先排除任务开始之前的日期；按UTC日历整数计算可避开夏令时。
  if (!validDate(date) || date < rule.startDate) return false;
  // 仅一次任务严格匹配开始日，完成与否都不会自动顺延到其他日期。
  if (rule.frequency === 'once') return date === rule.startDate;
  if (rule.frequency === 'daily') return true;
  if (rule.frequency === 'weekly') return rule.weekdays.includes(weekday(date));
  return Math.round((dateNumber(date) - dateNumber(rule.startDate)) / DAY) % rule.interval === 0;
}

/**
 * 验证请求人仍是有效家人。
 * @param {?object} home 服务端读取的家庭，不存在时也拒绝访问。
 * @param {string} actorId 从可信微信身份派生的成员ID。
 * @returns {object} 当前有效成员。
 * @throws {Error} 尚未加入家庭或已被移除时拒绝访问。
 */
function assertMember(home, actorId) {
  // 不信任客户端传入的家庭ID或身份；后端actor来自微信OPENID。
  const member = home && home.members.find((m) => m.id === actorId && m.active);
  ensure(member, '无权访问这个家庭，请联系管理员发送邀请');
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
  const version = task.versions
    .filter((v) => v.effectiveDate <= date)
    .sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate))[0];
  // 创建之前查不到生效版本时保持缺失，不把最新配置倒灌进过去日期。
  if (!version) return undefined;
  // 兼容此前仅用于本地体验的旧字段；正式保存只使用执行时间语义。
  const { reminderTime, ...current } = version;
  return {
    ...current,
    executionTime: version.executionTime === undefined ? reminderTime || '' : version.executionTime,
    // 只有老记录未保存此字段时兼容负责人，显式空值表示不通知任何人。
    notifyMemberId:
      version.notifyMemberId === undefined
        ? version.assigneeId || ''
        : version.notifyMemberId || '',
  };
}

/**
 * @param {object} a 待排序的第一项，包含pinned及可选executionTime。
 * @param {object} b 待排序的第二项，包含pinned及可选executionTime。
 * @returns {number} 置顶优先，有时间的按时间，无时间的放在后面。
 */
function compareTaskOrder(a, b) {
  // 无执行时间不会被误当成凌晨，也不影响周期和是否需要执行。
  return (
    Number(b.pinned) - Number(a.pinned) ||
    (a.executionTime || '24:00').localeCompare(b.executionTime || '24:00')
  );
}

/**
 * @param {string} date 任务所属的北京时间日历日期。
 * @param {string} executionTime 可选HH:mm，未设置时为空。
 * @returns {number} 计划时间后30分钟的毫秒时间戳；无时间返回Infinity。
 */
function overdueAt(date, executionTime) {
  // 显式使用东八区，23:50的计划会在次日00:20达到通知条件。
  return executionTime ? Date.parse(`${date}T${executionTime}:00+08:00`) + 30 * 60000 : Infinity;
}

/**
 * 将已校验周期转换为家庭成员可理解的文案。
 * @param {object} rule 任务版本中的周期、间隔与星期集合。
 * @returns {string} 与日历执行规则一致的周期描述。
 */
function ruleLabel(rule) {
  // 单次任务无需展示循环周期，避免被误认为每天重复。
  if (rule.frequency === 'once') return '仅一次';
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
  // 家庭创建前允许浏览空历史，但不能把较早的周期起点重建为真实漏做事项。
  if (date < home.createdDate) return [];
  // 当天没有操作记录时，应做任务仍需显示为未完成，不能误判为没有任务。
  const records = (day && day.records) || {};
  // 每项按所查日期选择版本，过滤后再统一排序，不依赖当天是否曾打开页面。
  return home.tasks
    .map((task) => {
      const version = taskVersion(task, date);
      // 归档从次日生效，不抹掉归档前的任务或完成记录。
      if (!version || version.archived || !isDue(version, date)) return null;
      const scope = task.scope || 'baby';
      const baby = scope === 'baby' && home.babies.find((b) => b.id === task.babyId);
      // 执行人离家后不继续发送通知，但历史任务仍显示并提示重新分配。
      const assignee = home.members.find((m) => m.id === version.assigneeId && m.active);
      const recipient = home.members.find((m) => m.id === version.notifyMemberId && m.active);
      const record = records[task.id] || {};
      // 已完成者的称呼取自执行当时的快照，改名或移除成员不能篡改历史归属。
      // revision交给客户端随操作带回，以拒绝过期页面覆盖刚发生的完成动作。
      const common = {
        // 周期与展示归属来自对应历史版本，置顶仅取家庭当前共享偏好。
        ...version,
        id: task.id,
        scope,
        pinned: !!task.pinned,
        // 关注名单只保留仍在家庭内的成员，不向已移除身份继续派发完成通知。
        followers: (task.followers || []).filter((id) =>
          home.members.some((m) => m.id === id && m.active)
        ),
        assigneeName: assignee ? assignee.name : version.assigneeId ? '待重新分配' : '',
        assigneeActive: !!assignee,
        // 空通知人保持未设置；只有非空但失效的历史身份才展示重选提示。
        notifyMemberName: recipient
          ? recipient.name
          : version.notifyMemberId
            ? '待重新选择通知人'
            : '',
        notifyMemberActive: !!recipient,
        // 当前状态与并发版本取当天记录，不从任务配置推断谁已完成。
        done: !!record.done,
        revision: record.revision || 0,
        completedAt: record.completedAt || '',
        // 姓名和照片沿用执行快照，后续改名不影响当天已发生的事实。
        completedByName: record.completedByName || '',
        photoId: record.photoId || '',
        photoUrl: record.photoUrl || '',
        ruleLabel: ruleLabel(version),
      };
      // 家庭事项没有宝宝字段；两类事项只共享周期、执行人与完成信息。
      return scope === 'family'
        ? { ...common, subjectName: '全家', color: 'sage' }
        : {
            ...common,
            babyId: task.babyId,
            babyName: baby ? baby.name : '宝宝',
            subjectName: baby ? baby.name : '宝宝',
            avatar: (baby && baby.avatar) || '',
            color: (baby && baby.color) || 'peach',
          };
    })
    .filter(Boolean)
    .sort((a, b) => compareTaskOrder(a, b) || a.id.localeCompare(b.id));
}

/**
 * 校验任务表单并生成有界周期配置。
 * @param {object} home 用于验证宝宝与执行人的家庭配置。
 * @param {object} data 标题、开始日期、重复规则、可空执行人、执行时间与独立提醒人。
 * @returns {object} 仅包含允许保存的任务字段。
 * @throws {Error} 日期、星期、间隔、时间或执行人不合法。
 */
function validateTask(home, data) {
  // 所有周期先在同一入口校验，再供新建或版本编辑使用，避免规则分叉。
  const startDate = data.startDate;
  // 不能让无效日期被JavaScript自动顺延成下个月，也不能分配给外人。
  ensure(text(data.title, 60), '请填写任务名称');
  ensure(validDate(startDate), '开始日期不正确');
  ensure(['once', 'daily', 'interval', 'weekly'].includes(data.frequency), '请选择重复周期');
  const assigneeId = data.assigneeId == null ? '' : data.assigneeId;
  // 留空表示家人共同分担；有值时仍必须是本家庭有效成员，不能保存外部身份。
  ensure(
    typeof assigneeId === 'string' &&
      (!assigneeId || home.members.some((m) => m.id === assigneeId && m.active)),
    '请选择有效的家庭执行人'
  );
  const interval = Number(data.interval || (data.frequency === 'interval' ? 0 : 1));
  // 间隔周期缺值必须报错，不能因表单为空而悄悄变成每日任务。
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
  // 执行时间允许留空；有值才参与计划与自动超时通知的时间判断。
  const executionTime = data.executionTime || '';
  ensure(!executionTime || /^([01]\d|2[0-3]):[0-5]\d$/.test(executionTime), '执行时间不正确');
  // 老客户端未传通知字段时延用旧规则；明确选“未设置”后不再回退负责人。
  const notifyMemberId = data.notifyMemberId === undefined ? assigneeId : data.notifyMemberId || '';
  // 显式空值表示不通知；仅旧客户端完全缺字段时兼容沿用负责人。
  ensure(
    typeof notifyMemberId === 'string' &&
      (!notifyMemberId || home.members.some((m) => m.id === notifyMemberId && m.active)),
    '请选择有效的被通知人'
  );
  // 只返回业务白名单字段，防止客户端夹带archived或effectiveDate改写历史。
  return {
    // 文本和周期只保留规范化结果，不把表单控件状态写入任务版本。
    title: text(data.title, 60),
    assigneeId,
    frequency: data.frequency,
    interval,
    weekdays,
    startDate,
    executionTime,
    // 通知对象单独保存，与执行人解耦，后续修改负责人不应自动重新指定通知人。
    notifyMemberId,
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
  // 先验证完整任务配置，任何失败都不应留下部分创建或半个版本。
  const version = validateTask(home, data);
  if (data.taskId) {
    // 编辑只能定位家庭已存在的任务，任务归属类型不能借本次保存迁移。
    const task = home.tasks.find((t) => t.id === data.taskId);
    ensure(task, '任务不存在');
    ensure(
      !data.scope || data.scope === (task.scope || 'baby'),
      '不能把已有任务改到另一类事项，请另建任务'
    );
    // 编辑从次日生效；同一天反复修改只保留次日的最终版本。
    const effectiveDate = addDays(today, 1);
    // 明日旧草稿先剔除再追加，防止同一日期存在两个竞争生效版本。
    task.versions = task.versions.filter((v) => v.effectiveDate !== effectiveDate);
    task.versions.push({ ...version, effectiveDate });
    return { message: '已保存，明天起生效；今天和历史记录保持原样' };
  }
  const babyIds = [...new Set(data.babyIds || [])];
  // 宝宝选择先去重，批量新建时同一宝宝不会因重复ID创建重复任务。
  const scope = data.scope || 'baby';
  // 类型必须明确落在宝宝或家庭两类，不能以未知分类绕过归属校验。
  ensure(scope === 'baby' || scope === 'family', '事项类型不正确');
  if (scope === 'family') {
    // 全家事项独立占用一个任务配额，不受宝宝数量和选择影响。
    ensure(home.tasks.length < 200, '任务数量已达200项，请整理后再添加');
    // 家庭事项只有一个完成状态，不借用某个宝宝ID作为占位。
    home.tasks.push({
      id: makeId(),
      scope,
      versions: [
        {
          ...version,
          effectiveDate: today,
          // 新任务不能向今天之前补写应做历史，只允许从创建日或将来开始。
          startDate: version.startDate < today ? today : version.startDate,
        },
      ],
    });
    return { message: '家庭事项已添加' };
  }
  ensure(
    babyIds.length > 0 && babyIds.every((id) => home.babies.some((b) => b.id === id)),
    '请选择宝宝'
  );
  ensure(home.tasks.length + babyIds.length <= 200, '任务数量已达200项，请整理后再添加');
  // 批量容量先整体校验，通过后才逐宝宝创建，避免只成功一部分。
  // 为两个宝宝创建不同任务ID，之后独立打勾与追踪历史。
  babyIds.forEach((babyId) =>
    home.tasks.push({
      // 每个宝宝拥有独立任务标识，之后完成、提醒与版本编辑互不串联。
      id: makeId(),
      scope: 'baby',
      babyId,
      // 同一次表单的周期复制到各宝宝版本，不共享可变的任务容器。
      versions: [
        {
          ...version,
          // 生效日期记录创建边界，查询历史时能识别当时尚未存在的任务。
          effectiveDate: today,
          // 开始日期取今天与用户日期的较晚者，不制造创建前的待完成项。
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
  // 日期以服务端北京时间为准，客户端不能通过更改日期回写历史。
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
    // 重复提交相同状态不产生新的执行流水和关注通知。
    ensure(!!current.done !== data.done, '完成状态已更新，请刷新后再操作');
    // 撤销保留独立流水，但清空当前完成标记，避免页面同时展示两种状态。
    day.records[row.id] = {
      revision: current.revision + 1,
      done: data.done,
      // 完成时冻结执行人姓名与身份；撤销必须清空当前展示快照。
      completedByName: data.done ? member.name : '',
      completedBy: data.done ? member.id : '',
      completedAt: data.done ? now : '',
      // 照片只关联当前完成记录，撤销后不继续展示已解除的附件。
      photoId: data.done ? data.photoId || '' : '',
    };
    // 当前状态可被撤销，流水仍单独追加，用于如实还原家人操作过程。
    day.events.push({
      id: makeId(),
      type: data.done ? 'complete' : 'undo',
      taskId: row.id,
      title: row.title,
      subjectName: row.subjectName,
      actorName: member.name,
      // 审计时间由同一次服务端操作提供，与当前记录保持一致。
      at: now,
      photoId: data.done ? data.photoId || '' : '',
    });
    return { message: data.done ? '完成啦，辛苦了 ♡' : '已撤销勾选' };
  }
  ensure(!row.done, '这件事已经完成，不需要再提醒');
  // 未指定负责人不阻止向明确选定的提醒人发送；已离家的旧负责人需要重选。
  ensure(!row.assigneeId || row.assigneeActive, '请先重新分配执行人');
  ensure(row.notifyMemberActive, '请先重新选择被通知人');
  const key = `${row.id}:${row.notifyMemberId}`;
  // 冷却按实际接收人隔离；更换通知人不会误用另一个人的发送时间。
  const previous = day.nudges[key];
  // 按任务和接收人统一冷却，避免多个家人轮流点击产生刷屏。
  ensure(!previous || new Date(now) - new Date(previous) >= 600000, '刚刚提醒过，请稍后再试');
  day.nudges[key] = now;
  const eventId = makeId();
  // 发送事件使用独立标识，由外层领取和记录结果，此处不直接调用微信。
  // 催办只记录真实发起人，不能直接作为微信发送成功的证据。
  day.events.push({
    id: eventId,
    type: 'nudge',
    taskId: row.id,
    title: row.title,
    subjectName: row.subjectName,
    actorName: member.name,
    at: now,
    recipientId: row.notifyMemberId,
  });
  return {
    // 接收人与任务摘要来自已校验行，发送入口不使用请求自报成员身份。
    message: '已记下提醒；微信通知结果请查看发送状态',
    recipientId: row.notifyMemberId,
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
 * @throws {Error} 身份、表单、历史边界或并发版本校验失败时不返回待提交状态。
 */
function transition(originalHome, originalDay, actorId, action, data, now, makeId) {
  // 原对象来自数据库或本地持久化；操作失败时必须能整体丢弃这份副本。
  const home = clone(originalHome);
  const member = assertMember(home, actorId);
  const today = chinaDate(now);
  // 新的一天从空执行表开始；存在的当天流水随副本保留，失败可整体丢弃。
  const day = clone(originalDay || { date: today, records: {}, events: [], nudges: {} });
  let result;
  if (action === 'saveBaby') {
    assertOwner(home, actorId);
    // 宝宝资料由管理员统一维护，避免家人误把另一个宝宝的名字或头像改掉。
    ensure(text(data.name, 12), '请填写宝宝名字');
    const baby = home.babies.find((b) => b.id === data.babyId);
    // 有ID的编辑不得退化为新建，数量上限只约束新增宝宝。
    if (data.babyId) ensure(baby, '宝宝不存在');
    ensure(baby || home.babies.length < 10, '最多可添加10位宝宝');
    // 老客户端未传生日时保留原资料；空字符串明确清空，不能录入未来或无效日期。
    if (data.birthDate !== undefined)
      ensure(
        typeof data.birthDate === 'string' &&
          (!data.birthDate || (validDate(data.birthDate) && data.birthDate <= today)),
        '出生日期请选择今天或之前的有效日期'
      );
    // 头像地址必须通过服务端上传入口验证；本地体验才使用本地图片路径。
    if (baby)
      Object.assign(baby, {
        name: text(data.name, 12),
        // 未提交头像字段沿用旧值，显式空字符串才表示用户主动清空。
        avatar: data.avatar === undefined ? baby.avatar : data.avatar,
        ...(data.birthDate === undefined ? {} : { birthDate: data.birthDate }),
      });
    else
      home.babies.push({
        id: makeId(),
        name: text(data.name, 12),
        avatar: data.avatar || '',
        birthDate: data.birthDate || '',
        color: home.babies.length % 2 ? 'sage' : 'peach',
      });
    result = { message: '宝宝资料已保存' };
  } else if (action === 'saveTask') {
    // 新建与编辑共用任务校验器，生效日期和历史边界集中在保存逻辑处理。
    result = saveTask(home, data, today, makeId);
  } else if (action === 'setPinned') {
    const task = home.tasks.find((t) => t.id === data.taskId);
    ensure(task, '任务不存在');
    ensure(typeof data.pinned === 'boolean', '置顶状态不正确');
    // 置顶是家庭共享的展示偏好，不新增周期版本或改写执行历史。
    task.pinned = data.pinned;
    result = { message: data.pinned ? '重要事项已置顶' : '已取消置顶' };
  } else if (action === 'setFollowing') {
    const task = home.tasks.find((t) => t.id === data.taskId);
    ensure(task, '任务不存在');
    ensure(typeof data.following === 'boolean', '关注状态不正确');
    // 只能关注或取消本人，客户端传入别人的ID不参与权限决策。
    const active = new Set(home.members.filter((m) => m.active).map((m) => m.id));
    const followers = (task.followers || []).filter((id) => active.has(id) && id !== member.id);
    if (data.following) followers.push(member.id);
    // 限定为有效家庭成员，移除后不保留无效关注或产生重复接收人。
    task.followers = [...new Set(followers)];
    result = { message: data.following ? '已关注，完成后有授权时会通知你' : '已取消关注' };
  } else if (action === 'archiveTask') {
    // 停用通过追加次日版本实现，既不删除任务也不改变今天的应做项目。
    const task = home.tasks.find((t) => t.id === data.taskId);
    ensure(task, '任务不存在');
    const effectiveDate = addDays(today, 1);
    const current = taskVersion(task, effectiveDate);
    // 与当天编辑使用相同生效边界，先编辑再停用也只留下一个最终版本。
    task.versions = task.versions.filter((v) => v.effectiveDate !== effectiveDate);
    task.versions.push({ ...current, effectiveDate, archived: true });
    result = { message: '明天起停止此任务，历史记录保留' };
  } else if (action === 'complete' || action === 'nudge') {
    // 完成与催办共享当天成员快照，历史限制和并发校验统一下沉处理。
    result = modifyDay(home, day, member, action, data, now, makeId);
  } else if (action === 'profile') {
    // 成员只能修改自己的家庭称呼，不能借此修改其他成员或管理员身份。
    ensure(text(data.name, 12), '请填写家庭称呼');
    member.name = text(data.name, 12);
    result = { message: '称呼已更新' };
  } else if (action === 'removeMember') {
    // 移除属于管理操作，服务端重新鉴权，不能依赖页面是否显示按钮。
    assertOwner(home, actorId);
    ensure(data.memberId !== home.ownerId, '不能移除家庭管理员');
    const target = home.members.find((m) => m.id === data.memberId && m.active);
    ensure(target, '成员不存在');
    // 保留历史中的完成人姓名，只撤销之后的访问权限。
    target.active = false;
    // 移除立即撤销后续完成通知，历史执行流水继续保留。
    for (const task of home.tasks)
      task.followers = (task.followers || []).filter((id) => id !== target.id);
    result = { message: '已移除成员，请检查该成员负责的任务' };
  } else throw new Error('不支持的操作');
  home.version += 1;
  // 版本与业务变更一起提交，客户端可以据此识别家庭配置发生变化。
  return { home, day, result };
}

/**
 * 为主动进入本地体验的用户生成独立示例家庭。
 * @param {string} today 当前北京时间日期，示例任务仅从该日期开始生效。
 * @returns {object} 仅在本机保存的示例家庭，不代表真实登录或消息授权。
 */
function createDemo(today) {
  // 固定模拟身份与真实成员隔离，示例操作不能获得线上家庭权限。
  const home = createHome('demo-owner', '我', addDays(today, -7));
  home.members.push({ id: 'demo-family', name: '家人', active: true });
  // 双宝宝用于验证独立任务与切换视图，头像保留为空以避免额外网络请求。
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
      // 稳定示例ID只用于本地状态恢复，不作为真实服务器生成主键的方式。
      id: `demo-task-${i}`,
      babyId: s[1],
      // 示例按宝宝独立保存周期版本，完成记录仍沿用生产规则计算。
      versions: [
        {
          title: s[0],
          // 交替安排模拟家人，便于体验多人分担，而不是给真实成员自动派单。
          assigneeId: i % 2 ? 'demo-family' : 'demo-owner',
          frequency: s[3],
          interval: 2,
          // 周任务安排在体验当天，让首次查看即可看到各类周期的事项。
          weekdays: [weekday(today)],
          startDate: today,
          effectiveDate: today,
          // 计划时间仅用于本地展示与催办演示，不触发真实微信通知。
          executionTime: s[2],
          archived: false,
        },
      ],
    })
  );
  // 示例家庭事务独立于宝宝，切换两个入口时不会混合任务或完成数量。
  home.tasks.push({
    // 家庭事项无babyId，避免切换宝宝筛选时把全家任务挂到某个宝宝。
    id: 'demo-family-task',
    scope: 'family',
    // 单独版本与宝宝任务使用同一规则结构，体验不会另造一套周期算法。
    versions: [
      {
        title: '整理客厅的小角落',
        // 模拟负责人来自上面创建的本地成员，不引用任何真实身份。
        assigneeId: 'demo-family',
        frequency: 'daily',
        interval: 1,
        weekdays: [],
        // 与宝宝示例同样只从今天生效，不向七天前的家庭创建日补任务。
        startDate: today,
        effectiveDate: today,
        executionTime: '19:00',
        archived: false,
      },
    ],
  });
  // 返回普通业务状态交给体验入口持久化，生成器本身不发消息或写网络。
  return home;
}

const api = {
  chinaDate,
  chinaTime,
  validDate,
  babyAgeLabel,
  addDays,
  weekday,
  isDue,
  assertMember,
  assertOwner,
  createHome,
  rowsForDate,
  taskVersion,
  compareTaskOrder,
  overdueAt,
  ruleLabel,
  transition,
  createDemo,
};
if (typeof module !== 'undefined') module.exports = api;
if (typeof window !== 'undefined') window.CareDomain = api;
