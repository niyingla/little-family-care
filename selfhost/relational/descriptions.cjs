// 表与字段的中文数据字典是唯一来源，建表和现有库注释修缮共用，避免两份说明漂移。
const TABLES = {
  care_families: '家庭基本资料与配置版本',
  care_users: '微信用户身份及订阅授权标记',
  care_members: '家庭成员资料及成员有效状态',
  care_member_birthdays: '家人公历或农历生日，不保存出生年份',
  care_babies: '宝宝档案与公历出生日期',
  care_tasks: '宝宝事项及家庭事项主体',
  care_task_versions: '事项规则历史版本，按生效日期还原历史',
  care_task_weekdays: '任务版本对应的执行星期，一行一个星期',
  care_task_followers: '事项关注人关联',
  care_days: '按北京时间日期组织的每日执行记录入口',
  care_executions: '每日各事项的当前完成状态与执行快照',
  care_execution_events: '完成、撤销及手动提醒的历史操作流水',
  care_nudges: '手动提醒的冷却时间，防止重复催办',
  care_messages: '任务及生日通知队列与真实投递状态',
  care_activity: '登录、页面进入、按钮点击与业务操作日志，不存表单正文',
  care_invites: '管理员签发的一人一次性家庭邀请',
  care_sessions: '登录会话与到期时间，仅保存令牌摘要',
  care_files: '私有图片用途与家庭归属元数据',
  care_image_blobs: '私有图片原始二进制，不保存Base64正文',
  care_photo_posts: '家庭照片墙动态与受权软删除状态',
  care_post_images: '照片动态与图片的有序关联',
  care_photo_feeds: '照片历史分页链入口',
  care_upload_sessions: '图片分片上传会话及处理状态',
  care_upload_targets: '分片上传绑定的宝宝、成员或事项目标',
  care_upload_results: '上传完成后的幂等结果缓存',
  care_upload_parts: '临时图片分片，组装完成或失败后清空正文',
  care_upload_limits: '成员活动上传会话的限额入口',
  care_upload_limit_items: '成员与活动上传会话的有序关联',
  care_join_requests: '旧版入家申请兼容数据，当前邀请流程不再新增',
  care_mutex: '跨副本业务事务互斥锁，必须保留id为1的记录',
  care_storage_state: '数据布局迁移、激活与回滚校验状态',
  care_records: '旧版聚合文档备份，仅用于核对及受控回滚，正式服务不再写入',
};
const FIELDS = {
  namespace: '数据隔离空间：family正式家庭，review审核沙箱',
  field_mask: '字段存在位图，仅区分缺省与显式空值；不存业务正文，字段顺序变更须迁移',
  record_id: '本业务记录的原始主键，迁移时保持不变',
  id: '业务实体唯一标识，沿用迁移前编号',
  home_id: '家庭记录标识，逻辑关联care_families.record_id',
  owner_id: '家庭管理员的内部成员ID，不是客户端角色标记',
  name: '展示称呼或行为名称，具体语义以所属业务表为准',
  relation: '家庭关系称呼，例如爸爸、妈妈；不参与权限判断',
  active: '成员有效状态：1有效，0已移除；历史执行信息仍保留',
  avatar: '私有头像文件标识，需后端鉴权生成可访问地址',
  calendar: '生日历法：solar公历，lunar农历',
  month: '生日月份，整数1至12',
  day: '生日日期，公历1至31、农历1至30，须通过真实日历校验',
  is_leap: '是否农历闰月：1是，0否；公历固定为0',
  birth_date: '宝宝公历出生日期，YYYY-MM-DD，可空；不能晚于当前北京时间日期',
  color: '宝宝展示配色标记，例如peach或sage，不影响业务权限',
  version: '家庭配置版本号，每次共享资料变更后递增',
  created_date: '家庭创建日期，按北京时间日历保存YYYY-MM-DD',
  scope: '事项或照片范围：baby宝宝，family家庭',
  baby_id: '关联宝宝内部ID；家庭事项或家庭照片为空',
  baby_name: '照片记录当时的宝宝称呼快照',
  pinned: '是否置顶：1是，0否',
  title: '事项或通知标题，通知保存触发时的名称快照',
  assignee_id: '负责人内部成员ID，可空；留空表示家人共同分担',
  notify_member_id: '被提醒人内部成员ID，可空；留空不自动通知任何人',
  frequency: '重复周期：once仅一次、daily每天、interval间隔天数、weekly每周',
  interval_days: '间隔天数，间隔周期下为1至365；按开始日期固定推算',
  weekday: '执行星期，整数1周一至7周日；一行仅保存一个星期',
  start_date: '任务开始执行的北京时间日期，YYYY-MM-DD',
  effective_date: '该任务版本生效日期，YYYY-MM-DD；历史按当时有效版本还原',
  execution_time: '可选执行时间，按北京时间HH:mm；留空不触发自动超时提醒',
  legacy_reminder_time: '旧版提醒时间兼容字段；新版本使用execution_time',
  archived: '版本是否归档：1是，0否；不删除过去执行事实',
  member_id: '关联家人内部ID，逻辑关联care_members.id',
  task_id: '关联事项内部ID，逻辑关联care_tasks.id，保留历史引用',
  day_id: '每日记录标识，逻辑关联care_days.record_id',
  date: '业务所属北京时间日期，YYYY-MM-DD',
  revision: '当天事项执行修订号，递增用于拒绝旧页面覆盖新操作',
  done: '当前完成状态：1已完成，0未完成或已撤销',
  completed_by: '本次实际完成人的内部成员ID，撤销后为空',
  completed_by_name: '完成当时的家人称呼快照，后续改名不篡改历史',
  completed_at: '实际完成时间，服务端UTC ISO8601字符串；展示时转北京时间',
  photo_id: '关联私有照片文件标识，文件用途与访问权限由后端验证',
  legacy_photo_url: '旧版照片展示地址兼容字段，访问权限仍须由后端校验',
  actor_id: '实际操作者内部成员ID，来源于可信微信身份',
  actor_name: '发生操作时的家人称呼快照',
  occurred_at: '服务端记录的发生时间，UTC ISO8601字符串；展示按北京时间',
  subject_name: '操作或通知发生时的宝宝称呼或家庭主体快照',
  recipient_id: '通知接收人的内部成员ID，发送前重新校验成员与授权',
  nudge_key: '任务ID与接收人ID组成的手动催办冷却键',
  nudged_at: '最近一次手动催办时间，服务端UTC ISO8601字符串',
  type: '业务事件或通知类型，具体取值以所属表为准',
  time: '通知展示时间，按北京时间HH:mm',
  status: '业务处理状态，具体取值以所属表为准',
  created_at: '服务端创建时间，UTC ISO8601字符串；展示按北京时间',
  claimed_at: '消息被领取准备发送的时间，UTC ISO8601字符串',
  finished_at: '业务处理完成时间，UTC ISO8601字符串，不等同于用户已阅读',
  birthday_date: '本次提醒对应的实际公历生日日期，YYYY-MM-DD',
  error_code: '固定业务错误代码或微信错误码，不保存原始异常正文和密钥',
  wechat_code: '微信接口返回的数值错误码，用于定位登录或调用失败',
  openid: '微信可信OpenID，仅服务端身份验证和消息发送使用，不向其他家人返回',
  subscribed: '本人订阅授权标记：1已记录授权，0未授权或额度已用尽；不代表永久额度',
  subscribed_at: '本人最近订阅授权的服务端时间，UTC ISO8601字符串',
  used_by: '接受并消耗该邀请的内部成员ID，未使用时为空',
  expires_at: '到期时间，具体单位依所属表字段类型定义',
  file_id: '私有图片文件标识，逻辑关联文件元数据，不是公开访问URL',
  uploaded_by: '图片实际上传人的内部成员ID，不能由客户端冒充',
  image_bytes: 'JPG或PNG原始二进制，单张上限10MiB；访问前必须验证家庭权限',
  author_id: '照片动态发布人的内部成员ID',
  author_name: '发布当时的家人称呼快照，后续改名不篡改署名',
  source: '记录来源，具体取值以所属业务表为准',
  content: '照片动态文字，最多200字，不含图片文件正文',
  previous_id: '前一条照片动态ID；软删除后仍保留以支持历史分页',
  deleted_at: '软删除时间，UTC ISO8601字符串；为空表示未删除',
  deleted_by: '执行软删除的内部成员ID，限发布者本人或管理员',
  post_id: '关联照片动态ID，逻辑关联care_photo_posts.record_id',
  head_post_id: '当前照片墙最新节点ID，沿previous_id读取更早动态',
  upload_id: '关联图片上传会话ID，逻辑关联care_upload_sessions.record_id',
  action: '上传业务动作，例如uploadAvatar、uploadWallPhoto、uploadCompletionPhoto',
  total_length: '完整Base64的ASCII字符数量，不是解码后图片字节数',
  total_parts: '图片分片总数，按每片最多65536字符计算',
  chunk: '临时Base64图片分片，最多65536个ASCII字符；合并或失败后清空',
  cleared: '分片正文是否已清空：1已清空，0尚未清空',
  message: '上传成功时缓存的业务提示文案，用于幂等返回',
  duration_ms: '操作耗时，单位毫秒，非负整数',
  outcome: '操作结果：success成功、failure失败、observed客户端观察到交互',
  view: '页面标识，受白名单限制：gate、today、history、tasks、family、photos',
  kind: '业务类型，具体含义以所属表为准',
  position: '聚合内数组顺序，从0开始；用于稳定还原历史顺序',
  version_position: '所属任务版本的顺序，从0开始，逻辑关联care_task_versions.position',
  reviewed_at: '旧入家申请处理时间，UTC ISO8601字符串，当前流程不再新增申请',
  schema_version: '数据库结构映射版本，当前为2；映射位图或结构变化须显式迁移',
  layout: '当前布局：legacy旧布局、ready已校验待激活、active已启用独立业务表',
  verified_digest: '迁移全量内容规范化后的SHA256摘要，用于激活前一致性核对',
  verified_count: '迁移时核对通过的旧文档数量，不是拆分后物理行数',
  verified_at: '最近一次迁移或回滚校验时间，UTC ISO8601字符串',
  collection: '旧版业务类别，仅在保留的回滚备份表使用',
  body: '旧版完整JSON文档，仅作迁移核对和回滚备份，正式业务已停写',
};
const RECORD_IDS = {
  care_users: '内部成员ID，为微信OpenID的SHA256前32位',
  care_sessions: '登录会话令牌的SHA256摘要，不保存原始令牌',
  care_invites: '一次性邀请令牌的SHA256摘要，不保存原始令牌',
  care_files: '私有图片文件标识的SHA256摘要',
  care_image_blobs: '私有图片文件名，迁移时保留原标识',
  care_days: '执行日期，按北京时间YYYY-MM-DD保存',
  care_activity: '服务端时间加随机标识组成的唯一操作记录ID',
  care_families: '家庭记录标识，当前固定为home',
  care_photo_feeds: '照片墙分页入口标识，当前固定为home',
  care_photo_posts: '照片动态唯一ID，迁移时保留原标识',
  care_messages: '消息幂等ID，同一任务、日期与接收人避免重复投递',
  care_upload_sessions: '图片上传会话唯一ID',
  care_upload_parts: '上传会话ID与分片序号组成的唯一键',
  care_upload_limits: '家人内部成员ID，关联该成员活动上传会话',
  care_join_requests: '旧入家申请成员内部ID，当前流程不再新增申请',
};

/**
 * 取得表或字段的完整中文说明，缺少说明时阻止执行DDL。
 * @param {string} table 白名单中的业务表或迁移控制表。
 * @param {string} column 可选字段名；不传时返回表说明。
 * @returns {string} 非空中文描述，状态、单位与时区按所属表收敛。
 * @throws {Error} 表或字段尚未编写中文说明时直接失败，不写含糊默认文案。
 */
function description(table, column) {
  // 元数据修缮与新建表使用同一份解释，不能用未知标识符触发任意表变更。
  if (!Object.hasOwn(TABLES, table)) throw new Error('缺少业务表中文说明');
  if (!column) return TABLES[table];
  if (!Object.hasOwn(FIELDS, column)) throw new Error('缺少数据库字段中文说明');
  // 同名主键在登录、邀请和文件表中承载不同摘要，不能用统一“ID”掩盖身份边界。
  if (column === 'record_id') return RECORD_IDS[table] || FIELDS.record_id;
  // 到期时间沿用原数据类型，避免把邀请ISO日期误解释为毫秒或反之。
  if (column === 'expires_at')
    return ['care_sessions', 'care_upload_sessions'].includes(table)
      ? '到期时间，Unix毫秒时间戳；由服务端统一判定'
      : '到期时间，服务端UTC ISO8601字符串';
  if (column === 'status') {
    // 邀请消耗状态与时间过期分开解释，避免把过期误认为仍可再次领取。
    if (table === 'care_invites')
      return '邀请状态：active未使用，used已使用；过期另由expires_at判断';
    // 微信投递失败、无订阅额度与未配置模板是不同结果，不能合并描述为发送失败。
    if (table === 'care_messages')
      return '投递状态：queued待发、sending发送中、sent已发、failed失败、no_quota无授权、unconfigured未配置、skipped已失效';
    // finishing期间禁止重复提交原上传副作用，done才表示结果已持久化。
    if (table === 'care_upload_sessions')
      return '上传状态：pending待完成、finishing组装中、done成功、failed失败、expired过期';
    // 历史申请只做兼容保留，描述不能暗示现在加入仍需要二次审批。
    return '旧申请审批状态，兼容历史记录；当前管理员邀请流程不再使用';
  }
  // 执行流水记录用户动作；通知类型记录触发原因，两者不能共用同一枚举解释。
  if (column === 'type')
    return table === 'care_execution_events'
      ? '操作类型：complete完成、undo撤销、nudge手动提醒'
      : '通知类型：manual手动催办、auto自动超时、completion关注完成、birthday生日';
  // 完成留档和自由发帖的来源影响后端文件用途校验，不仅是页面展示标签。
  if (column === 'source')
    return table === 'care_photo_posts'
      ? '动态来源：wall主动发布，completion完成事项留档'
      : '行为来源：server服务端确认，client客户端观察';
  // 文件kind决定资源归属，行为kind只用于无正文审计，必须按表区分。
  if (column === 'kind')
    return table === 'care_files'
      ? '文件用途：member-avatar家人头像、wall墙照片、completion完成照；空值兼容宝宝头像'
      : '行为类型：login登录、page_view进入页面、click按钮点击、business业务操作';
  // 控制表的唯一行不是业务自增编号，误删除会破坏事务或迁移保护。
  if (column === 'id' && table === 'care_mutex')
    return '全局事务互斥行标识，固定为1，不得删除或修改';
  if (column === 'id' && table === 'care_storage_state') return '迁移状态唯一行标识，固定为1';
  return FIELDS[column];
}
module.exports = { TABLES, description };
