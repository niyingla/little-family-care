// 物理表由静态白名单定义；逻辑集合只用于兼容现有业务接口，不再作为存储分类列。
const field = (column, type = 'string') => ({ column, type });
const fields = (spec) =>
  Object.fromEntries(spec.map(([name, column, type]) => [name, field(column, type)]));
const node = (table, spec, children = []) => ({ table, fields: fields(spec), children });
const child = (property, kind, definition, links, key = 'position') => ({
  property,
  kind,
  node: definition,
  links,
  key,
});
const root = (definition) => ({ ...definition, keyColumns: ['namespace', 'record_id'] });

// 家庭、成员、宝宝和任务分表；生日、星期和上传参数也逐列保存，不使用JSON业务列。
const versions = node('care_task_versions', [
  ['title', 'title'],
  ['assigneeId', 'assignee_id'],
  ['notifyMemberId', 'notify_member_id'],
  ['frequency', 'frequency'],
  ['interval', 'interval_days', 'number'],
  ['startDate', 'start_date'],
  ['effectiveDate', 'effective_date'],
  ['executionTime', 'execution_time'],
  ['reminderTime', 'legacy_reminder_time'],
  ['archived', 'archived', 'boolean'],
]);
versions.children.push(
  child('weekdays', 'array', node('care_task_weekdays', [['$value', 'weekday', 'number']]), {
    home_id: 'home_id',
    task_id: 'task_id',
    version_position: 'position',
  })
);
const followers = node('care_task_followers', [['$value', 'member_id']]);
const tasks = node(
  'care_tasks',
  [
    ['id', 'id'],
    ['scope', 'scope'],
    ['babyId', 'baby_id'],
    ['pinned', 'pinned', 'boolean'],
  ],
  [
    child('versions', 'array', versions, { home_id: 'home_id', task_id: 'id' }),
    child('followers', 'array', followers, { home_id: 'home_id', task_id: 'id' }),
  ]
);
const members = node('care_members', [
  ['id', 'id'],
  ['name', 'name'],
  ['relation', 'relation'],
  ['active', 'active', 'boolean'],
  ['avatar', 'avatar'],
]);
members.children.push(
  child(
    'birthday',
    'object',
    node('care_member_birthdays', [
      ['calendar', 'calendar'],
      ['month', 'month', 'number'],
      ['day', 'day', 'number'],
      ['leap', 'is_leap', 'boolean'],
    ]),
    { home_id: 'home_id', member_id: 'id' }
  )
);
const babies = node('care_babies', [
  ['id', 'id'],
  ['name', 'name'],
  ['avatar', 'avatar'],
  ['color', 'color'],
  ['birthDate', 'birth_date'],
]);
const home = root(
  node(
    'care_families',
    [
      ['id', 'id'],
      ['ownerId', 'owner_id'],
      ['createdDate', 'created_date'],
      ['version', 'version', 'number'],
    ],
    [
      child('members', 'array', members, { home_id: 'record_id' }),
      child('babies', 'array', babies, { home_id: 'record_id' }),
      child('tasks', 'array', tasks, { home_id: 'record_id' }),
    ]
  )
);

// 当前执行状态、不可丢失的操作流水、手动催办冷却分别存储。
const executions = node('care_executions', [
  ['revision', 'revision', 'number'],
  ['done', 'done', 'boolean'],
  ['completedBy', 'completed_by'],
  ['completedByName', 'completed_by_name'],
  ['completedAt', 'completed_at'],
  ['photoId', 'photo_id'],
  ['photoUrl', 'legacy_photo_url'],
]);
const events = node('care_execution_events', [
  ['id', 'id'],
  ['type', 'type'],
  ['taskId', 'task_id'],
  ['title', 'title'],
  ['subjectName', 'subject_name'],
  ['actorName', 'actor_name'],
  ['at', 'occurred_at'],
  ['photoId', 'photo_id'],
  ['recipientId', 'recipient_id'],
]);
const days = root(
  node(
    'care_days',
    [['date', 'date']],
    [
      child('records', 'map', executions, { day_id: 'record_id' }, 'task_id'),
      child('events', 'array', events, { day_id: 'record_id' }),
      child(
        'nudges',
        'map',
        node('care_nudges', [['$value', 'nudged_at']]),
        { day_id: 'record_id' },
        'nudge_key'
      ),
    ]
  )
);
const posts = root(
  node(
    'care_photo_posts',
    [
      ['id', 'id'],
      ['ownerId', 'owner_id'],
      ['authorId', 'author_id'],
      ['authorName', 'author_name'],
      ['babyId', 'baby_id'],
      ['babyName', 'baby_name'],
      ['scope', 'scope'],
      ['source', 'source'],
      ['taskId', 'task_id'],
      ['date', 'date'],
      ['text', 'content', 'text'],
      ['createdAt', 'created_at'],
      ['previousId', 'previous_id'],
      ['deletedAt', 'deleted_at'],
      ['deletedBy', 'deleted_by'],
    ],
    [
      child('photoIds', 'array', node('care_post_images', [['$value', 'file_id']]), {
        post_id: 'record_id',
      }),
    ]
  )
);

const ROOTS = {
  care_home: home,
  care_days: days,
  care_users: root(
    node('care_users', [
      ['openid', 'openid'],
      ['subscribed', 'subscribed', 'boolean'],
      ['subscribedAt', 'subscribed_at'],
    ])
  ),
  care_sessions: root(
    node('care_sessions', [
      ['openid', 'openid'],
      ['expiresAt', 'expires_at', 'number'],
    ])
  ),
  care_invites: root(
    node('care_invites', [
      ['ownerId', 'owner_id'],
      ['status', 'status'],
      ['expiresAt', 'expires_at'],
      ['name', 'name'],
      ['relation', 'relation'],
      ['usedBy', 'used_by'],
    ])
  ),
  care_messages: root(
    node('care_messages', [
      ['id', 'id'],
      ['taskId', 'task_id'],
      ['date', 'date'],
      ['recipientId', 'recipient_id'],
      ['type', 'type'],
      ['title', 'title'],
      ['subjectName', 'subject_name'],
      ['time', 'time'],
      ['status', 'status'],
      ['createdAt', 'created_at'],
      ['revision', 'revision', 'number'],
      ['memberId', 'member_id'],
      ['birthdayDate', 'birthday_date'],
      ['claimedAt', 'claimed_at'],
      ['finishedAt', 'finished_at'],
      ['errorCode', 'error_code', 'text'],
    ])
  ),
  care_activity: root(
    node('care_activity', [
      ['at', 'occurred_at'],
      ['actorId', 'actor_id'],
      ['kind', 'kind'],
      ['name', 'name'],
      ['source', 'source'],
      ['outcome', 'outcome'],
      ['view', 'view'],
      ['durationMs', 'duration_ms', 'number'],
      ['errorCode', 'error_code'],
      ['wechatCode', 'wechat_code', 'number'],
    ])
  ),
  care_files: root(
    node('care_files', [
      ['fileID', 'file_id'],
      ['ownerId', 'owner_id'],
      ['kind', 'kind'],
      ['uploadedBy', 'uploaded_by'],
      ['babyId', 'baby_id'],
      ['memberId', 'member_id'],
      ['taskId', 'task_id'],
      ['date', 'date'],
      ['scope', 'scope'],
    ])
  ),
  // 图片存LONGBLOB，保留同一文件标识，HTTP权限与签名无需改变，也不移动到公开目录。
  care_avatar_blobs: root(node('care_image_blobs', [['base64', 'image_bytes', 'binary']])),
  care_photo_posts: posts,
  care_photo_feed: root(
    node('care_photo_feeds', [
      ['ownerId', 'owner_id'],
      ['head', 'head_post_id'],
    ])
  ),
  care_uploads: root(
    node('care_upload_sessions', [
      ['id', 'id'],
      ['action', 'action'],
      ['totalLength', 'total_length', 'number'],
      ['totalParts', 'total_parts', 'number'],
      ['uploadedBy', 'uploaded_by'],
      ['ownerId', 'owner_id'],
      ['createdAt', 'created_at'],
      ['expiresAt', 'expires_at', 'number'],
      ['status', 'status'],
      ['finishedAt', 'finished_at'],
    ])
  ),
  care_upload_parts: root(
    node('care_upload_parts', [
      ['chunk', 'chunk', 'text'],
      ['cleared', 'cleared', 'boolean'],
    ])
  ),
  care_upload_limits: root(
    node(
      'care_upload_limits',
      [],
      [
        child('sessionIds', 'array', node('care_upload_limit_items', [['$value', 'upload_id']]), {
          member_id: 'record_id',
        }),
      ]
    )
  ),
  // 已停用的旧申请也保留独立表，迁移遇到未支持结构时必须报错，不能静默丢弃。
  care_requests: root(
    node('care_join_requests', [
      ['id', 'id'],
      ['name', 'name'],
      ['relation', 'relation'],
      ['status', 'status'],
      ['createdAt', 'created_at'],
      ['reviewedAt', 'reviewed_at'],
    ])
  ),
};

ROOTS.care_uploads.children.push(
  child(
    'metadata',
    'object',
    node('care_upload_targets', [
      ['babyId', 'baby_id'],
      ['memberId', 'member_id'],
      ['taskId', 'task_id'],
      ['date', 'date'],
      ['scope', 'scope'],
    ]),
    { upload_id: 'record_id' }
  ),
  child(
    'result',
    'object',
    node('care_upload_results', [
      ['fileID', 'file_id'],
      ['photoId', 'photo_id'],
      ['message', 'message'],
    ]),
    { upload_id: 'record_id' }
  )
);

/**
 * 将固定业务名映射至物理表与隔离空间。
 * @param {string} collection 服务端业务集合名，支持review_前缀但不接受任意SQL名称。
 * @returns {object} definition及family/review命名空间。
 * @throws {Error} 未映射集合拒绝使用，防止迁移遗失或SQL标识符注入。
 */
function resolve(collection) {
  // 表名始终出自静态对象，输入只参与白名单查找。
  const review = typeof collection === 'string' && collection.startsWith('review_');
  const name = review ? collection.slice(7) : collection;
  if (!Object.hasOwn(ROOTS, name)) throw new Error('存在未映射的数据类别');
  return { definition: ROOTS[name], namespace: review ? 'review' : 'family' };
}

/**
 * 规范化单字段为SQL参数，图片在迁移时转为原始二进制。
 * @param {*} value 原JSON字段值，可为明确null。
 * @param {object} spec 受信字段类型及列定义。
 * @returns {*} 可安全绑定的SQL参数，不包含拼接标识符。
 * @throws {Error} 字段类型不兼容时停止迁移，不能隐式转换历史数据。
 */
function encodeValue(value, spec) {
  // 显式null由字段存在标记区分于未填写，不以空字符串代替。
  if (value === null) return null;
  if (spec.type === 'boolean' && typeof value === 'boolean') return value ? 1 : 0;
  if (spec.type === 'number' && Number.isSafeInteger(value)) return value;
  if (['string', 'text', 'binary'].includes(spec.type) && typeof value === 'string') {
    // Base64必须可完整回转，拒绝损坏编码，以免迁移把照片悄悄截断。
    if (spec.type !== 'binary') return value;
    const bytes = Buffer.from(value, 'base64');
    if (bytes.toString('base64') === value) return bytes;
  }
  throw new Error('字段类型无法无损迁移');
}

/**
 * 将完整业务对象拆成多张业务表记录，保留字段存在性与数组顺序。
 * @param {string} collection 已映射的业务类别。
 * @param {string} id 原业务主键，不重新生成用户、照片或任务标识。
 * @param {object} value 完整业务快照，必须是可JSON序列化对象。
 * @returns {object[]} table/values行列表，业务内容均在明确字段列中。
 * @throws {Error} 未知字段、超长主键或无损转换失败时整份对象拒绝写入。
 */
function encodeDocument(collection, id, value) {
  const { definition, namespace } = resolve(collection);
  if (typeof id !== 'string' || !id || id.length > 128) throw new Error('业务主键不正确');
  const rows = [];
  /**
   * 拆解一个实体及其下级列表。
   * @param {object} current 当前物理表定义。
   * @param {*} item 对象或字符串列表项。
   * @param {object} keys 已确定的命名空间、外部键及顺序键。
   * @returns {void} 将实体追加到本次待写列表。
   */
  function visit(current, item, keys) {
    // 序列化与旧存储保持一致，undefined字段不落库，禁止未知字段被丢弃。
    const scalar = Object.hasOwn(current.fields, '$value');
    const document = scalar ? { $value: item } : item;
    if (!document || typeof document !== 'object' || Array.isArray(document))
      throw new Error('业务实体结构不正确');
    const names = Object.keys(document).filter((name) => document[name] !== undefined);
    const childNames = new Set(current.children.map((entry) => entry.property));
    if (names.some((name) => !Object.hasOwn(current.fields, name) && !childNames.has(name)))
      throw new Error(`存在未映射的业务字段：${current.table}`);
    // 位图仅记录字段是否填写，不使用JSON或业务正文；字段顺序只能追加，不能重排。
    const order = [
      ...Object.keys(current.fields),
      ...current.children.map((entry) => entry.property),
    ];
    if (order.length > 52) throw new Error('字段存在位图超过安全整数边界');
    const mask = names.reduce((value, name) => value + 2 ** order.indexOf(name), 0);
    const values = { ...keys, field_mask: mask };
    for (const [name, spec] of Object.entries(current.fields))
      values[spec.column] = names.includes(name) ? encodeValue(document[name], spec) : null;
    rows.push({ table: current.table, values });
    for (const entry of current.children) {
      if (!names.includes(entry.property)) continue;
      const items = document[entry.property];
      // 对象的null表示明确清空，与缺字段及空对象分别还原。
      if (entry.kind === 'object' && items === null) continue;
      if (
        entry.kind === 'array'
          ? !Array.isArray(items)
          : !items || Array.isArray(items) || typeof items !== 'object'
      )
        throw new Error('业务子表结构不正确');
      const links = { namespace };
      for (const [column, source] of Object.entries(entry.links)) {
        if (
          !(typeof values[source] === 'string' && values[source]) &&
          !Number.isSafeInteger(values[source])
        )
          throw new Error('业务关联主键缺失');
        links[column] = values[source];
      }
      // 独立顺序列保证任务版本与流水顺序不受主键字典序影响。
      for (const [index, childItem] of entry.kind === 'object'
        ? [[0, items]]
        : entry.kind === 'array'
          ? items.entries()
          : Object.entries(items))
        visit(entry.node, childItem, { ...links, [entry.key]: index });
    }
  }
  visit(definition, value, { namespace, record_id: id });
  return rows;
}

/**
 * 从独立实体表恢复业务快照，供现有领域规则使用。
 * @param {string} collection 已映射的业务类别及审核隔离前缀。
 * @param {string} id 原主键。
 * @param {object[]} rows 当前读取事务中的table/values实体行列表。
 * @returns {object|null} 无损业务对象；对应根实体不存在时为null。
 * @throws {Error} 字段标记或JSON内容损坏时拒绝使用。
 */
function decodeDocument(collection, id, rows) {
  const { definition, namespace } = resolve(collection);
  /**
   * 恢复实体字段并按外部键装配子实体。
   * @param {object} current 当前实体定义。
   * @param {object} values 数据库返回的实体列。
   * @returns {*} 对象快照或标量列表项。
   */
  function restore(current, values) {
    // 只恢复原本存在的字段，不把SQL的NULL扩大成所有可选字段均已填写。
    const order = [
      ...Object.keys(current.fields),
      ...current.children.map((entry) => entry.property),
    ];
    const mask = Number(values.field_mask),
      document = {};
    if (!Number.isSafeInteger(mask) || mask < 0 || mask >= 2 ** order.length)
      throw new Error('字段存在位图不正确');
    const names = order.filter((name, index) => Math.floor(mask / 2 ** index) % 2 === 1);
    for (const [name, spec] of Object.entries(current.fields)) {
      if (!names.includes(name)) continue;
      const raw = values[spec.column];
      document[name] =
        raw === null
          ? null
          : spec.type === 'boolean'
            ? !!raw
            : spec.type === 'number'
              ? Number(raw)
              : spec.type === 'binary'
                ? Buffer.from(raw).toString('base64')
                : raw;
    }
    for (const entry of current.children) {
      if (!names.includes(entry.property)) continue;
      const matches = rows.filter(
        (row) =>
          row.table === entry.node.table &&
          row.values.namespace === namespace &&
          Object.entries(entry.links).every(
            ([target, source]) => row.values[target] === values[source]
          )
      );
      // 数组用数值位置排序；字典键本身不决定操作流水顺序。
      if (entry.kind === 'array')
        matches.sort((a, b) => Number(a.values[entry.key]) - Number(b.values[entry.key]));
      document[entry.property] =
        entry.kind === 'object'
          ? matches.length
            ? restore(entry.node, matches[0].values)
            : null
          : entry.kind === 'array'
            ? matches.map((row) => restore(entry.node, row.values))
            : Object.fromEntries(
                matches.map((row) => [row.values[entry.key], restore(entry.node, row.values)])
              );
    }
    return Object.hasOwn(current.fields, '$value') ? document.$value : document;
  }
  const found = rows.find(
    (row) =>
      row.table === definition.table &&
      row.values.namespace === namespace &&
      row.values.record_id === id
  );
  return found ? restore(definition, found.values) : null;
}

/**
 * 列举一个业务类别包含的物理表，统一建表和仓库读写规则。
 * @param {object} definition resolve返回的根实体定义。
 * @returns {object[]} 含columns/keyColumns/parent的先父后子表定义。
 */
function tablesFor(definition) {
  const result = [];
  /**
   * 为实体展开受信的主键与字段列。
   * @param {object} current 当前实体定义。
   * @param {string[]} keys 当前表联合主键列。
   * @param {?object} parent 父子映射，根表为null。
   * @param {string} rootColumn 当前表指向根记录的列，用于整份资料的事务查询。
   * @returns {void} 追加当前表并递归处理子表。
   */
  function collect(current, keys, parent, rootColumn) {
    // 表结构来自静态白名单，调用方不能通过请求新增列或索引。
    result.push({ ...current, keyColumns: keys, parent, rootColumn });
    for (const entry of current.children) {
      // 后代继续携带根实体外部键，读取一份家庭时不会扫描其他家庭或审核空间。
      const nextRoot = Object.keys(entry.links).find((key) => entry.links[key] === rootColumn);
      if (!nextRoot) throw new Error('子表缺少根实体关联');
      collect(
        entry.node,
        ['namespace', ...Object.keys(entry.links), entry.key],
        { table: current.table, ...entry },
        nextRoot
      );
    }
  }
  collect(definition, definition.keyColumns, null, 'record_id');
  return result;
}
module.exports = { ROOTS, resolve, encodeDocument, decodeDocument, tablesFor };
