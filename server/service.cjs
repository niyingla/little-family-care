const d = require('./domain');
const { createActivityRecorder } = require('./activity.cjs');
const { normalizeBirthday, birthdayOccurrences, birthdayDue } = require('./birthdays.cjs');
const { addCompletion } = require('./photo-wall.cjs');
const MUTATION_ACTIONS = [
  'saveBaby',
  'saveTask',
  'setPinned',
  'archiveTask',
  'complete',
  'nudge',
  'profile',
  'removeMember',
  'setFollowing',
];
// 日志名称复用执行入口的业务白名单，不能持久化未知请求传入的任意文本。
const BUSINESS_ACTIONS = new Set([
  'createHome',
  'applyInvite',
  'makeInvite',
  'subscribe',
  'saveBirthday',
  ...MUTATION_ACTIONS,
]);

/**
 * 云端业务入口。数据库适配层负责事务和存储，本层负责权限与状态转换。
 * @param {object} repo 支持get、put、transaction、list的受信存储接口。
 * @param {object} options 云端配置与随机数、时间、微信发送适配器。
 * @returns {object} call处理小程序请求，tick仅供独立定时云函数调用。
 * @throws {Error} 不完整的运行时依赖在实际业务调用时向入口传播，不降级为伪造成功。
 */
function createService(repo, options) {
  // 时间、随机数和微信发送均由可信运行时注入，客户端不能替换这些业务边界。
  const { now, randomId, hash, ownerOpenId, templateId, sendMessage } = options;
  const uid = (openid) => hash(openid).slice(0, 32);
  // 所有操作复用同一身份派生和审计仓库，避免读写对成员归属采用不同标准。
  const activity = createActivityRecorder({ repo, now, randomId });
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  /**
   * @param {string} openid 微信上下文中的可信身份。
   * @returns {Promise<object>} 请求人有权访问的家庭。
   * @throws {Error} 不具有有效成员资格或已被移除时拒绝读取。
   */
  async function readMember(openid) {
    const home = await repo.get('care_home', 'home');
    // 每次读取重新校验成员资格；不能使用客户端缓存的管理员标记。
    d.assertMember(home, uid(openid));
    return home;
  }

  /**
   * @param {string} openid 当前微信身份。
   * @param {object} data 可选date，必须为今天或过去的有效公历日；创建前仅返回空历史。
   * @returns {Promise<object>} 权限过滤后的配置、日记录和消息结果。
   * @throws {Error} 无权访问或查询日期不合法。
   */
  async function snapshot(openid, data) {
    // 先校验身份，再读取任何宝宝、任务或执行信息。
    const home = await readMember(openid);
    const today = d.chinaDate(now());
    // 未指定日期只查询服务器认定的今天，不使用手机时区推断历史边界。
    const date = data.date || today;
    check(d.validDate(date) && date <= today, '请选择今天或之前的有效日期');
    // 创建当日也能左右浏览；创建前不读取可能残留的旧日数据，也不制造漏做记录。
    const beforeCreation = date < home.createdDate;
    // 日记录独立存储，避免家庭使用多年后单个配置文档持续膨胀。
    const day = beforeCreation ? null : await repo.get('care_days', date);
    // 只由管理员签发一次性邀请，接受即入家，不再读取历史待审核申请。
    const messages = beforeCreation ? [] : await repo.list('care_messages', { date }, 100);
    const user = await repo.get('care_users', uid(openid));
    // 只返回本人订阅状态，其他家人的微信身份和授权存量不进入快照。
    // OPENID只在care_users中供服务端发送，返回给家人的成员ID均为哈希。
    // 返回消息状态而不返回微信接口错误正文，避免内部配置进入产品页面。
    return {
      home,
      day,
      requests: [],
      messages: messages.map((m) => ({
        id: m.id,
        taskId: m.taskId,
        status: m.status,
        recipientId: m.recipientId,
        type: m.type,
        title: m.title,
      })),
      actorId: uid(openid),
      date,
      beforeCreation,
      today,
      configured: !!templateId,
      subscribed: !!(user && user.subscribed),
    };
  }

  /**
   * 保存家人生日；家庭关系文字不能代替真正的成员或管理员身份。
   * @param {string} openid 已通过微信登录验证的当前身份。
   * @param {object} data memberId及公农历月日，birthday:null明确清空。
   * @returns {Promise<object>} 保存结果，出生年不收集也不持久化。
   * @throws {Error} 无权限、目标已移除或生日日期不合法。
   */
  async function saveBirthday(openid, data) {
    // 生日与家庭版本同事务更新，校验失败时不能留下半份成员资料。
    return repo.transaction(async (tx) => {
      // 始终读取事务内最新成员状态，旧页面不能替已经离家的家人维护资料。
      const home = await tx.get('care_home', 'home');
      d.assertMember(home, uid(openid));
      // 管理员维护所有家人，普通成员只能维护自己的资料。
      check(
        home.ownerId === uid(openid) || data.memberId === uid(openid),
        '只有管理员或本人能编辑生日'
      );
      const member = home.members.find((item) => item.id === data.memberId && item.active);
      check(member, '家人不存在或已经离开家庭');
      // 只保存标准历法和月日，表单附带的姓名、标签或权限字段全部丢弃。
      member.birthday = normalizeBirthday(data.birthday === null ? null : data);
      // 资料变更推进家庭版本，后续快照可识别更新而无需重建历史执行记录。
      home.version += 1;
      await tx.put('care_home', 'home', home);
      return { message: member.birthday ? '生日已记好，提前三天上午十点提醒家人' : '生日已清空' };
    });
  }

  /**
   * 校验邀请中的展示资料；家庭身份不参与管理员权限判断。
   * @param {object} data 可选name和relation，各为12字以内的称呼与家庭关系。
   * @returns {object} 去除首尾空白的资料，只保留允许展示的字段。
   * @throws {Error} 非文本、控制字符或超长内容不能写入邀请及成员资料。
   */
  function inviteProfile(data) {
    // 明确允许的展示字段，额外的权限、家庭ID和微信身份字段不会被保留。
    const result = {};
    for (const [key, label] of [
      ['name', '称呼'],
      ['relation', '家庭身份'],
    ]) {
      // 空值允许稍后由被邀请人补充，不能把对象强制转成展示文字。
      const value = data[key] === undefined ? '' : data[key];
      check(typeof value === 'string', `${label}请填写文字`);
      // 清除首尾空白但拒绝控制符，避免分享预填内容破坏页面展示或日志布局。
      const text = value.trim();
      check(
        text.length <= 12 && !/[\u0000-\u001f\u007f]/.test(text),
        `${label}请填写12字以内的文字`
      );
      result[key] = text;
    }
    // 这里仅产出资料，不以“管理员”等关系文字改变任何授权结果。
    return result;
  }

  /**
   * 读取仍有效且属于当前家庭的邀请，预览和申请复用同一校验。
   * @param {object} store 当前存储或事务接口，提供get方法。
   * @param {string} token 32位随机邀请令牌，不包含家人的姓名或关系。
   * @returns {Promise<object>} 仅供服务端使用的邀请记录。
   * @throws {Error} 令牌格式错误、过期、已使用或家庭不匹配。
   */
  async function readInvitation(store, token) {
    // 在查库前限制令牌格式，外部任意文本不能成为邀请查询条件。
    check(
      typeof token === 'string' && /^[a-f0-9]{32}$/.test(token),
      '邀请链接无效，请联系管理员重新邀请'
    );
    // 只存令牌哈希；未持有效邀请者不能探查任何预填资料。
    const invitation = await store.get('care_invites', hash(token));
    check(
      invitation && invitation.status === 'active' && invitation.expiresAt > now(),
      '邀请已失效，请联系管理员重新邀请'
    );
    // 邀请记录还必须属于当前家庭，环境迁移或旧配置不能让历史卡片串入新家庭。
    const home = await store.get('care_home', 'home');
    check(home && home.ownerId === invitation.ownerId, '邀请不属于当前家庭');
    return invitation;
  }

  /**
   * @param {string} openid 申请者自己的微信身份，不能由请求体替换。
   * @param {object} data 一次性token、确认后的name和relation；未提供时沿用预填资料。
   * @returns {Promise<object>} 接受管理员邀请后立即入家的结果。
   * @throws {Error} 邀请过期、已使用、已是有效成员或称呼为空。
   */
  async function applyInvite(openid, data) {
    // 接受时间由服务端统一生成，不能让客户端延长邀请有效期。
    const at = now();
    const token = String(data.token || '').trim();
    check(/^[a-f0-9]{32}$/.test(token), '邀请链接无效，请联系管理员重新邀请');
    // 先校验展示资料，再进入消耗令牌的事务；输入错误不会浪费一次性邀请。
    const confirmed = inviteProfile(data);
    return repo.transaction(async (tx) => {
      // 邀请消耗和成员生效同事务提交，不会发生领了邀请却未入家的半成功。
      const invitation = await readInvitation(tx, token);
      const home = await tx.get('care_home', 'home');
      // 已是家人不能重复领取名额，人数限制只统计当前有效成员。
      check(!home.members.some((m) => m.id === uid(openid) && m.active), '你已经是家庭成员');
      check(home.members.filter((m) => m.active).length < 20, '家庭最多支持20位成员');
      const name = confirmed.name || invitation.name || '';
      // 显式传空身份表示清空；老客户端未传此字段时兼容邀请的预填身份。
      const relation = data.relation === undefined ? invitation.relation || '' : confirmed.relation;
      check(name, '请填写你在家庭中的称呼');
      // 一份卡片只供一人接受；旧链接不能在移除后重新入家。
      await tx.put('care_invites', hash(token), {
        ...invitation,
        status: 'used',
        usedBy: uid(openid),
      });
      const old = home.members.find((m) => m.id === uid(openid));
      const member = { id: uid(openid), name, relation, active: true };
      // 重新受邀时复用原身份及生日，避免把旧执行历史断成两个不同的人。
      if (old) Object.assign(old, member);
      else home.members.push(member);
      home.version += 1;
      // 成员生效与令牌消耗原子提交，接受成功后立即可读家庭，无需二次审核。
      await tx.put('care_home', 'home', home);
      // 重新加入仍需本人重新订阅，不能把过去的标记当成永久发送授权。
      await tx.put('care_users', uid(openid), { openid, subscribed: false });
      return { message: '欢迎回家，已加入家庭 ♡' };
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
    // 一次操作复用同一服务端时间，跨日事务内的记录、照片和消息归属保持一致。
    const at = now();
    const result = await repo.transaction(async (tx) => {
      // 在同一隔离快照内读取配置与日记录，避免用过期完成版本覆盖其他家人的操作。
      const home = await tx.get('care_home', 'home');
      const date = d.chinaDate(at);
      const day = await tx.get('care_days', date);
      // 领域转换负责成员权限、当天周期和版本冲突；校验异常时整笔事务回滚。
      const next = d.transition(home, day, uid(openid), action, data, at, randomId);
      if (action === 'saveBaby') {
        // 只接受由本家庭头像上传入口登记过的文件，不接受任意云文件ID。
        if (data.avatar) {
          const file = await tx.get('care_files', hash(data.avatar));
          check(
            file && file.ownerId === home.ownerId && file.kind !== 'completion',
            '头像文件无权使用，请重新上传'
          );
        }
      }
      if (action === 'complete' && data.done && data.photoId) {
        // 完成只能关联本人为当天这项任务上传的照片，不能借ID读取他人文件。
        const file =
          typeof data.photoId === 'string' && (await tx.get('care_files', hash(data.photoId)));
        // 不能把宝宝头像或别人的上传冒充本次执行留档；五项绑定必须同时成立。
        check(
          file &&
            file.kind === 'completion' &&
            file.ownerId === home.ownerId &&
            file.uploadedBy === uid(openid) &&
            file.taskId === data.taskId &&
            file.date === date,
          '完成照片无权使用，请为当前事项重新拍照'
        );
      }
      // 配置先写入同一事务草稿；后续照片墙或消息入队失败仍会整体回滚。
      await tx.put('care_home', 'home', next.home);
      // 仅执行和催办产生当天记录，资料编辑不能制造新的日执行历史。
      if (action === 'complete' || action === 'nudge') await tx.put('care_days', date, next.day);
      if (action === 'nudge') {
        // 催办收件人取领域结果，客户端无法借通知入口指定任意微信用户。
        const { row, recipientId, eventId } = next.result;
        await tx.put(
          'care_messages',
          eventId,
          notification(row, date, recipientId, 'manual', eventId)
        );
      }
      const completionIds = [];
      if (action === 'complete' && data.done) {
        // 与完成记录原子入队；版本冲突时整笔回滚，不会出现误报完成。
        const row = d.rowsForDate(next.home, next.day, date).find((r) => r.id === data.taskId);
        // 宝宝事项的照片随完成事务入墙；家庭事项仅保留执行留档，不进入宝宝墙。
        if (data.photoId && row.scope === 'baby') {
          // 最后一条流水由本次领域转换刚追加，墙记录不能错误关联到先前的完成或撤销。
          const lastCompleteEvent = next.day.events.at(-1);
          // 作者称呼取当前受信成员快照，之后改名不应篡改这次留档的原始归属。
          const member = d.assertMember(next.home, uid(openid));
          // 墙记录用刚生成的完成流水ID幂等关联，不能由客户端指定帖子ID或作者。
          await addCompletion(tx, {
            home: next.home,
            actorId: uid(openid),
            actorName: member.name,
            taskId: row.id,
            babyId: row.babyId,
            date,
            photoId: data.photoId,
            eventId: lastCompleteEvent.id,
            at,
          });
        }
        // 普通无照片完成仍只更新执行记录；不能为其创建没有照片的墙帖子。
        // 关注消息排除本次执行者，执行人不会收到自己完成事项的重复通知。
        for (const recipientId of row.followers.filter((id) => id !== uid(openid))) {
          const id = hash(`completion:${date}:${row.id}:${row.revision}:${recipientId}`).slice(
            0,
            40
          );
          // 日期、事项、完成修订和接收人共同组成幂等键，撤销后再次完成是新通知。
          await tx.put('care_messages', id, {
            ...notification(row, date, recipientId, 'completion', id),
            title: `已完成：${row.title}`,
            revision: row.revision,
          });
          completionIds.push(id);
        }
      }
      // 临时队列ID只供提交后投递，不直接暴露给小程序作为成功依据。
      return { ...next.result, completionIds };
    });
    // 外部微信请求始终发生在提交后；一位接收人失败不撤销家人已经完成的事。
    const completionStatuses = await Promise.all(
      result.completionIds.map(async (id) => {
        // 单个收件人的发送异常在此隔离，不能让其他家人的通知和完成结果跟着失败。
        try {
          return await deliver(id);
        } catch (_) {
          // 提交后的通知故障不能反转完成结果；持久队列留给定时任务继续处理。
          console.warn('完成通知暂未确认', { messageId: id });
          return 'pending';
        }
      })
    );
    // 去除内部队列标识，仅返回实际投递状态供产品如实展示。
    delete result.completionIds;
    if (completionStatuses.length) result.notifications = completionStatuses;
    // 催办单独给出本次消息反馈，不把关注者的多个通知状态混成统一发送结论。
    if (action === 'nudge') {
      // 事务只入队，微信外部请求在提交之后执行，避免事务重试重复通知。
      const status = await deliver(result.eventId);
      // 微信无授权、模板未配置和未知失败分别提示，不能统一声称已发送。
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
    // 无关注者时仍返回正常完成结果，不额外制造消息或伪造通知成功状态。
    return result;
  }

  /**
   * 构造待发送消息的业务快照，微信身份仍在投递时从受信用户表读取。
   * @param {object} row 领域规则筛出的事项，包含标题、展示对象和执行时间。
   * @param {string} date 执行或提醒所属的北京时间日历日期。
   * @param {string} recipientId 已校验的内部成员哈希ID，不接受原始微信身份。
   * @param {string} type manual、auto或completion，决定后续投递有效性规则。
   * @param {string} id 当前消息的幂等记录ID，来自流水或服务端组合哈希。
   * @returns {object} 初始queued消息，不代表已经交给微信发送。
   */
  function notification(row, date, recipientId, type, id) {
    // 接收人来自任务执行人，客户端不能指定任意微信用户作为发送对象。
    return {
      id,
      taskId: row.id,
      date,
      recipientId,
      type,
      // 保存触发时标题，任务改名后仍能解释这条通知原先指向的事项。
      title: row.title,
      subjectName: row.subjectName,
      // 无执行时间时用触发时刻展示，不能为任务凭空补出计划执行时间。
      time: row.executionTime || d.chinaTime(now()),
      status: 'queued',
      // 创建时间取服务端时钟，仅说明入队时间而非微信成功接收时间。
      createdAt: now(),
    };
  }

  /**
   * @param {string} messageId 已在数据库持久化的消息ID，不接受任意接收人参数。
   * @returns {Promise<string>} 真实处理状态，未发送不得返回sent。
   * @throws {Error} 数据库失败时由云函数日志与监控记录，未知外部结果不盲目重发。
   */
  async function deliver(messageId) {
    // 先在事务内抢占消息，再发微信；并发定时器只能由一个请求取得发送资格。
    const claim = await repo.transaction(async (tx) => {
      // 已发送、已跳过或已被抢占的消息不能再次发送，状态是幂等保护的一部分。
      const message = await tx.get('care_messages', messageId);
      if (!message || message.status !== 'queued') return null;
      const home = await tx.get('care_home', 'home');
      const day = await tx.get('care_days', message.date);
      const user = await tx.get('care_users', message.recipientId);
      // 发送时重新还原当前事项，任务撤销、关注取消和成员移除都会使旧队列失效。
      const row =
        home && d.rowsForDate(home, day, message.date).find((r) => r.id === message.taskId);
      let status = 'sending';
      const activeRecipient =
        home && home.members.some((m) => m.id === message.recipientId && m.active);
      // 只补昨天和今天的及时消息，不能在恢复服务时向家人集中发送多年旧提醒。
      const recent = [d.chinaDate(now()), d.addDays(d.chinaDate(now()), -1)].includes(message.date);
      // 完成消息与催办具有相反的完成状态条件，不能套用“完成就取消”的催办规则。
      const validCompletion =
        message.type === 'completion' &&
        row &&
        row.done &&
        row.revision === message.revision &&
        row.followers.includes(message.recipientId);
      // 负责人允许为空；但已指定且离家的负责人不能继续驱动催办，提醒人仍须有效。
      const validReminder =
        ['auto', 'manual'].includes(message.type) &&
        row &&
        !row.done &&
        (!row.assigneeId || row.assigneeActive) &&
        row.notifyMemberActive &&
        row.notifyMemberId === message.recipientId;
      const birthdayMember =
        home && home.members.find((m) => m.id === message.memberId && m.active);
      // 改生日或移除寿星后，尚未发送的旧提醒失效，不发给已离家的成员。
      // 生日提醒仅在提前三天当天十点后有效，不沿用普通任务的跨日补发条件。
      const validBirthday =
        message.type === 'birthday' &&
        birthdayMember &&
        message.date === d.chinaDate(now()) &&
        d.chinaTime(now()) >= '10:00' &&
        birthdayOccurrences(birthdayMember, message.date).some(
          (event) =>
            event.date === message.birthdayDate && d.addDays(event.date, -3) === message.date
        );
      // 发送前重新检查成员和完成状态，移除成员后队列也不能继续向其发送。
      if (!activeRecipient || !recent || !(validCompletion || validReminder || validBirthday))
        status = 'skipped';
      // 无模板或无本地订阅标记时不调用微信，用明确状态解释未投递原因。
      else if (!templateId) status = 'unconfigured';
      else if (!user || !user.subscribed) status = 'no_quota';
      // 在外部请求前原子写sending，进程异常后不盲目重发结果未知的请求。
      await tx.put('care_messages', messageId, { ...message, status, claimedAt: now() });
      return { ...message, status, openid: user && user.openid };
    });
    // 未抢到任务或已明确跳过的分支直接返回真实状态，不能落入发送路径。
    if (!claim) return 'already_processed';
    if (claim.status !== 'sending') return claim.status;
    let status = 'sent';
    let errorCode = '';
    try {
      // 只有微信接口正常返回才保留sent，调用异常一律按未知失败或无授权记录。
      await sendMessage(claim);
    } catch (error) {
      errorCode = String(error.errCode || error.errcode || 'unknown');
      status = errorCode === '43101' ? 'no_quota' : 'failed';
      // 不自动重发结果未知的外部调用，以免家人收到重复通知。
    }
    await repo.transaction(async (tx) => {
      // 最终状态与时间再次原子落库，前端看到的是已完成的投递判断。
      const stored = await tx.get('care_messages', messageId);
      await tx.put('care_messages', messageId, { ...stored, status, errorCode, finishedAt: now() });
      if (status === 'no_quota') {
        // 微信确认授权用尽后清除本地标记，避免后续任务继续发起无效请求。
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
    // 家庭未初始化时不生成示例任务或通知，调度返回真实的空检查结果。
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
      // 只筛未完成、接收人有效且超过计划30分钟的事项；无计划时间永不到期。
      for (const row of rows.filter(
        (r) =>
          !r.done &&
          (!r.assigneeId || r.assigneeActive) &&
          r.notifyMemberActive &&
          d.overdueAt(date, r.executionTime) <= currentTime
      )) {
        const messageId = hash(`auto:${date}:${row.id}:${row.notifyMemberId}`).slice(0, 40);
        // 唯一日期、任务、接收人组成消息ID，重复定时触发不会重复入队。
        await repo.transaction(async (tx) => {
          // 事务内查重可抵御多副本同时扫描，仅首次发现才写入待发送消息。
          // 已有消息保留其发送或失败状态，不能被周期扫描重置成queued后重复通知。
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
    // 生日按实际公历日期生成，闰月和跨年由独立日历模块处理。
    for (const entry of birthdayDue(home, now())) {
      checked += 1;
      const id = hash(entry.id).slice(0, 40);
      await repo.transaction(async (tx) => {
        // 寿星、实际生日年份及收件人已纳入entry.id，重复扫描不会重复入队。
        // 同一生日提醒的历史结果只创建一次，不因下次扫描覆盖其真实投递状态。
        if (!(await tx.get('care_messages', id)))
          await tx.put('care_messages', id, {
            ...entry,
            id,
            type: 'birthday',
            status: 'queued',
            createdAt: now(),
          });
      });
      if ((await deliver(id)) === 'sent') sent += 1;
    }
    // 完成事务提交后若进程中断，下一轮扫描补处理已入队的消息；未知发送结果不重发。
    for (const message of await repo.list('care_messages', { status: 'queued' }, 100)) {
      if ((await deliver(message.id)) === 'sent') sent += 1;
    }
    // sent仅统计本次微信接口成功接收，不把跳过、无授权或家人已读计入成功数。
    return { checked, sent };
  }

  /**
   * @param {string} openid 由云函数上下文传入的微信身份。
   * @param {string} action 明确白名单操作，禁止客户端触发tick。
   * @param {object} data 操作参数，敏感字段在对应分支逐项校验。
   * @returns {Promise<object>} 适合小程序消费的业务结果。
   * @throws {Error} 非法身份、未知操作或权限不足。
   */
  async function execute(openid, action, data = {}) {
    // 所有入口先要求可信微信身份，不能靠请求正文中的家庭ID绕过登录。
    check(openid, '需要通过微信小程序调用');
    const actorId = uid(openid);
    // 客户端埋点仅进入受限记录器，不能冒充服务器业务执行成功。
    if (action === 'recordActivity') return activity.client(actorId, data);
    if (action === 'bootstrap') {
      // 未入家用户只查询自己的状态，不能通过初始化接口读取成员和宝宝信息。
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
    // 建家只允许配置的微信白名单，前端按钮和家庭关系称呼均不能授予权限。
    if (action === 'createHome')
      return repo.transaction(async (tx) => {
        // 白名单与家庭不存在条件在事务中再次验证，防止并发重复初始化。
        check(ownerOpenId && openid === ownerOpenId, '仅预设管理员可以创建这个家庭');
        check(!(await tx.get('care_home', 'home')), '家庭已经创建');
        const home = d.createHome(actorId, data.name, d.chinaDate(now()));
        // 初始家庭与管理员身份原子写入，订阅授权必须之后由本人主动授予。
        await tx.put('care_home', 'home', home);
        await tx.put('care_users', actorId, { openid, subscribed: false });
        return { message: '欢迎回家，一起把日常小事记下来吧' };
      });
    // 管理员签发的一次性邀请在接受后立即入家，不保留旧的二次审批路径。
    if (action === 'applyInvite') return applyInvite(openid, data);
    // 生日权限由专用流程比较管理员或本人，家庭关系标签不会授予资料编辑权限。
    if (action === 'saveBirthday') return saveBirthday(openid, data);
    if (action === 'previewInvite') {
      const invitation = await readInvitation(repo, String(data.token || '').trim());
      // 持链接者仅预览该邀请的资料，不返回家庭、宝宝、成员或签发人身份。
      return { name: invitation.name || '', relation: invitation.relation || '' };
    }
    if (action === 'snapshot') return snapshot(openid, data);
    // 邀请链接属于管理员授权边界，普通家人即使有已有邀请也不能签发新卡片。
    if (action === 'makeInvite') {
      const home = await readMember(openid);
      d.assertOwner(home, actorId);
      const profile = inviteProfile(data);
      const token = randomId();
      // 链接24小时后失效，数据库仅保存令牌哈希，展示资料不参与访问权限判定。
      const expiresAt = new Date(new Date(now()).getTime() + 86400000).toISOString();
      await repo.put('care_invites', hash(token), {
        ownerId: actorId,
        status: 'active',
        expiresAt,
        ...profile,
      });
      return { token, expiresAt, message: '邀请卡片已生成，24小时有效，仅供一人加入' };
    }
    if (action === 'subscribe') {
      // 记录授权前重新检查成员身份和实际模板，不能替其他家人或其他模板授权。
      await readMember(openid);
      check(templateId, '微信提醒模板尚未配置');
      check(data.templateId === templateId && data.accepted === true, '未获得该模板的订阅授权');
      // 本地标记仅用于减少无效请求；最终是否有额度由微信发送接口判断。
      await repo.put('care_users', actorId, { openid, subscribed: true, subscribedAt: now() });
      return { message: '已记录订阅授权，实际发送次数以微信为准' };
    }
    // 最后的业务白名单阻止未知动作落入状态转换器，更不能由客户端调用调度tick。
    check(MUTATION_ACTIONS.includes(action), '不支持的操作');
    return mutate(openid, action, data);
  }
  /**
   * 在业务事务之外记录结果；客户端点击不能冒充服务端执行成功。
   * @param {string} openid 平台或已验证会话提供的身份，不接受请求体身份。
   * @param {string} action 当前业务操作名，未知操作以unknown记入日志。
   * @param {object} data 业务参数，只传给原有校验流程，不存入行为日志。
   * @returns {Promise<object>} 原业务结果，记录失败不会撤销已完成的业务。
   * @throws {Error} 原业务异常照常返回客户端。
   */
  async function call(openid, action, data = {}) {
    // 服务端自行计时，不采用客户端上报的执行耗时。
    const started = Date.now();
    // 查询和页面埋点已有独立语义，不把轮询算作业务执行。
    const tracked = !['snapshot', 'bootstrap', 'previewInvite', 'recordActivity'].includes(action);
    // 只允许真实业务动作名称进入日志，异常请求中的任意文本统一归为unknown。
    const entry = {
      actorId: openid ? uid(openid) : '',
      kind: 'business',
      source: 'server',
      name: BUSINESS_ACTIONS.has(action) ? action : 'unknown',
    };
    try {
      const result = await execute(openid, action, data);
      // 事务提交后再记录成功；记录器自行降级写入异常，不改变业务返回值。
      if (tracked)
        await activity.record({ ...entry, outcome: 'success', durationMs: Date.now() - started });
      return result;
    } catch (error) {
      // 权限和业务校验失败同样可追踪，原异常继续交给请求边界返回客户端。
      if (tracked)
        await activity.record({ ...entry, outcome: 'failure', durationMs: Date.now() - started });
      throw error;
    }
  }
  return { call, tick, readMember };
}
module.exports = { createService };
