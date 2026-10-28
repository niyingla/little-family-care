const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const { promisify } = require('node:util');
const { createHttpApplication } = require('./app.cjs');
const d = require('../server/domain');
const scrypt = promisify(crypto.scrypt);
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const randomId = () => crypto.randomBytes(16).toString('hex');
const IDENTITY = { owner: 'review-owner', member: 'review-dad' };
const NOTICE = '审核隔离环境不发送真实微信通知。';

/**
 * 为所有仓库操作固定添加审核集合前缀，事务回调不能获得原始仓库。
 * @param {object} repo 正式连接池提供的get/put/list/transaction适配器。
 * @returns {object} 仅操作review_集合的仓库，保留原适配器的原子提交语义。
 * @throws {Error} 集合名含路径或非法字符，或底层存储读写失败。
 */
function createReviewRepository(repo) {
  /**
   * 校验逻辑集合名并映射至固定命名空间。
   * @param {string} collection 业务代码给出的逻辑集合名，不能含路径或SQL片段。
   * @returns {string} 永远以review_起始的物理逻辑集合。
   * @throws {Error} 集合名类型或字符范围不合法。
   */
  function name(collection) {
    // 即使传入已有review_前缀也只会再加前缀，不存在逃回正式集合的特殊分支。
    if (typeof collection !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(collection))
      throw new Error('审核集合名不正确');
    return `review_${collection}`;
  }
  /**
   * 包装连接池或当前事务，所有数据入口共用同一集合映射。
   * @param {object} scope 原始连接池或事务作用域。
   * @returns {object} 只读写审核集合的get/put/list方法。
   */
  function wrap(scope) {
    // 不把原始scope作为属性交给业务层，避免后续方法旁路访问正式集合。
    // 只包装最小数据接口，连接池对象及事务句柄不暴露给审核业务。
    return {
      /**
       * 读取当前审核集合中的单份文档。
       * @param {string} collection 受信业务逻辑集合名，必须通过固定前缀映射。
       * @param {string} id 当前审核集合的文档主键。
       * @returns {Promise<object|null>} 已保存文档；不存在时为null。
       * @throws {Error} 集合名无效或底层查询失败。
       */
      async get(collection, id) {
        // 相同文档ID也只在审核集合查找，不回退到正式家庭的同名记录。
        return scope.get(name(collection), id);
      },
      /**
       * 在当前审核集合保存文档。
       * @param {string} collection 受信业务逻辑集合名。
       * @param {string} id 仅在审核命名空间内生效的文档主键。
       * @param {object} value 业务领域已校验的完整持久化内容。
       * @returns {Promise<*>} 底层适配器的提交结果。
       * @throws {Error} 集合名无效或底层写入失败。
       */
      async put(collection, id, value) {
        // 覆盖写同样固定前缀，不能借用户传来的ownerId决定物理集合。
        return scope.put(name(collection), id, value);
      },
      /**
       * 按同一适配器规则列出审核文档。
       * @param {string} collection 受信业务逻辑集合名。
       * @param {object} filter 底层适配器支持的筛选条件。
       * @param {number} limit 业务已约束的最大返回数量。
       * @returns {Promise<object[]>} 不包含正式集合内容的审核文档列表。
       * @throws {Error} 当前事务不提供列表查询或底层查询失败。
       */
      async list(collection, filter, limit) {
        // 筛选和条数继续交给受信适配器，唯有集合名由隔离包装统一决定。
        if (typeof scope.list !== 'function') throw new Error('审核事务不支持列表查询');
        return scope.list(name(collection), filter, limit);
      },
    };
  }
  // 事务仍复用同一持久连接的锁，内部回调得到的也只是审核包装。
  return { ...wrap(repo), transaction: (fn) => repo.transaction((tx) => fn(wrap(tx))) };
}

/**
 * 读取服务端审核访问配置，只接受两种固定测试角色及scrypt摘要。
 * @param {object|string} value REVIEW_ACCESS的JSON文本或私有运行时对象。
 * @param {number} time 当前服务端毫秒时间，过期配置视为关闭。
 * @returns {?object} 规范化期限和账户；缺失、无效或过期时为null。
 */
function readAccess(value, time) {
  // 此输入仅来自服务器运行环境，HTTP登录正文不能提供或切换认证配置。
  if (!value) return null;
  try {
    const input = typeof value === 'string' ? JSON.parse(value) : value;
    // 保存绝对到期时刻，后续请求逐次比较，不能因重启重新滚动延长七天。
    const expiresAt = Date.parse(input.expiresAt);
    // 未配置、损坏或到期不能阻断正式服务，但审核入口必须保持关闭。
    if (
      input.version !== 1 ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= time ||
      !Array.isArray(input.accounts) ||
      input.accounts.length !== 2
    )
      return null;
    // 两个测试角色必须都存在，不能把任意可配置身份当成正式家庭成员登录。
    const accounts = input.accounts.map((item) => {
      // 固定摘要长度保证后续恒定时间比较不会因长度不同提前报错。
      // 限制用户名长度与字符集合，异常私有配置不能建立无界认证输入。
      if (
        !item ||
        !Object.hasOwn(IDENTITY, item.role) ||
        !/^[A-Za-z0-9_.@-]{3,64}$/.test(item.username || '') ||
        !/^[a-f0-9]{32}$/i.test(item.salt || '') ||
        !/^[a-f0-9]{128}$/i.test(item.passwordHash || '')
      )
        throw new Error('invalid-review-config');
      // 盐按hex解码为16字节；私有配置中不接受或保存明文口令。
      // 只复制经过验证的四项，不透传配置里其他可能敏感的账户属性。
      return {
        username: item.username,
        role: item.role,
        salt: Buffer.from(item.salt, 'hex'),
        digest: Buffer.from(item.passwordHash, 'hex'),
      };
    });
    // 两个不同用户名分别对应owner/member，重复角色或用户名不能相互覆盖。
    if (
      new Set(accounts.map((item) => item.username)).size !== 2 ||
      new Set(accounts.map((item) => item.role)).size !== 2
    )
      return null;
    // 原始JSON不继续流入业务响应，运行时只持有本地认证必需的信息。
    return { accounts, expiresAt };
  } catch (_) {
    // 配置异常不写出原JSON、摘要或账户标识，避免私有认证信息进入启动日志。
    return null;
  }
}

/**
 * 创建审核账号认证器，默认业务仍走原应用而不是演示分支。
 * @param {object} access 已验证的两账户摘要与统一到期时间。
 * @param {Function} clock 返回当前服务端毫秒的函数。
 * @returns {Function} authenticateLogin(payload)，返回受信测试身份及最晚会话期限。
 */
function createReviewLogin(access, clock) {
  // scrypt并发数受限，低内存容器不会因匿名同时登录分配过多派生内存。
  let active = 0;
  /**
   * 验证账号与口令，仅返回固定的隔离测试身份。
   * @param {object} payload 登录正文；username为配置中的账号，password为1至256字符口令。
   * @returns {Promise<object>} 受信测试openid及不超过审核配置的绝对到期时间。
   * @throws {Error} 凭据不合法为401、配置到期为403、并发派生超过两次为429。
   */
  async function authenticateLogin(payload) {
    // 所有登录都按当前时间核对期限，旧浏览器页面不能延续已到期的访问。
    if (clock() >= access.expiresAt)
      throw Object.assign(new Error('审核访问未开放或已到期'), { status: 403 });
    // 非对象正文同样按无效凭据处理，避免空JSON触发属性访问异常或暴露内部错误。
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      throw Object.assign(new Error('审核账号或口令不正确'), { status: 401 });
    const username = typeof payload.username === 'string' ? payload.username.trim() : '';
    // 口令不trim，空格也是用户配置的真实秘密的一部分。
    const password = payload.password;
    // 返回固定错误，既不透露账户是否存在，也不回显用户名或口令。
    if (!username || typeof password !== 'string' || !password.length || password.length > 256)
      throw Object.assign(new Error('审核账号或口令不正确'), { status: 401 });
    if (active >= 2)
      throw Object.assign(new Error('审核登录请求过于频繁，请稍后重试'), { status: 429 });
    // 进入异步派生前同步占用名额，同一轮多个请求也不能突破两并发限制。
    active++;
    try {
      const account = access.accounts.find((item) => item.username === username);
      // 未知用户名仍执行同等scrypt计算，不能通过明显时差枚举两个审核账户。
      const candidate = account || access.accounts[0];
      const derived = await scrypt(password, candidate.salt, 64, {
        N: 16384,
        r: 8,
        p: 1,
        maxmem: 64 * 1024 * 1024,
      });
      // 密钥派生期间也可能刚好到期，不给已到期配置颁发一份新的登录结果。
      if (clock() >= access.expiresAt)
        throw Object.assign(new Error('审核访问未开放或已到期'), { status: 403 });
      if (!account || !crypto.timingSafeEqual(derived, candidate.digest))
        throw Object.assign(new Error('审核账号或口令不正确'), { status: 401 });
      // 角色只映射两种固定测试身份，不能通过配置或请求登录为正式家庭的OpenID。
      return { openid: IDENTITY[account.role], expiresAt: access.expiresAt };
    } finally {
      // 错误口令和派生异常同样释放名额，不能把一次失败变成永久无法登录。
      active--;
    }
  }
  return authenticateLogin;
}

/**
 * 通过同一领域规则初始化独立测试家庭，重复启动不覆盖审核人员的真实测试操作。
 * @param {object} repo 只能操作review_集合的事务仓库。
 * @param {string} at 服务端ISO时间，种子历史从七天前开始。
 * @returns {Promise<void>} 初始化已提交，后续完整业务直接读取这些持久记录。
 * @throws {Error} 领域规则拒绝种子或数据库提交失败。
 */
async function seedReview(repo, at) {
  // 宝宝、成员和两个版本化任务一次提交，审核首页不能看到初始化到一半的家庭。
  return repo.transaction(async (tx) => {
    // 多副本在同一事务中检查是否存在，不会重复插入宝宝、任务或重置已完成记录。
    if (await tx.get('care_home', 'home')) return;
    // 固定测试身份只在审核集合中使用，绝不复用部署者或真实家人的OpenID。
    const ownerId = hash(IDENTITY.owner).slice(0, 32),
      memberId = hash(IDENTITY.member).slice(0, 32);
    // 从七天前建家，使审核人员能真实切换历史日期验证周期清单。
    const date = d.addDays(d.chinaDate(at), -7),
      seedAt = `${date}T04:00:00.000Z`;
    // 建家与后续状态转换使用真实领域规则，管理员权限不是前端布尔值伪造。
    let home = d.createHome(ownerId, '审核管理员', date);
    // 这两个固定测试成员与真实家庭无关联，家庭身份称呼不改变owner权限。
    home.members.push({ id: memberId, name: '审核家人', active: true });
    // 样例宝宝同样经过管理员资料维护规则，后续上传和编辑按真实对象ID验证。
    home = d.transition(
      home,
      null,
      ownerId,
      'saveBaby',
      { name: '审核示例宝宝' },
      seedAt,
      randomId
    ).home;
    // 宝宝任务从种子日起每日有效，历史无需伪造执行记录就能按版本重建。
    home = d.transition(
      home,
      null,
      ownerId,
      'saveTask',
      {
        scope: 'baby',
        babyIds: [home.babies[0].id],
        title: '审核示例：整理宝宝外出用品',
        // 交给普通测试家人负责，便于验收成员显示、打勾与管理员能力的区别。
        assigneeId: memberId,
        notifyMemberId: '',
        // 无通知接收人与审核禁发配置形成双重边界，不占真实微信订阅额度。
        frequency: 'daily',
        startDate: date,
      },
      seedAt,
      randomId
    ).home;
    // 家庭事项没有宝宝占位ID，能独立验收两类事项的筛选和统计。
    home = d.transition(
      home,
      null,
      ownerId,
      'saveTask',
      {
        scope: 'family',
        babyIds: [],
        title: '审核示例：整理家庭小角落',
        // 第二个任务分给管理员，让两种审核账户都有可执行的真实样例。
        assigneeId: ownerId,
        notifyMemberId: '',
        frequency: 'daily',
        startDate: date,
      },
      seedAt,
      randomId
    ).home;
    // 先按真实规则生成版本，再同事务写入；不是只在bootstrap假报member=true。
    // 不预造过去的完成状态，历史页面会如实显示这些样例当日尚未打勾。
    await tx.put('care_home', 'home', home);
    // 用户资料只含固定测试身份，订阅标记始终为未授权，不冒充可外发微信。
    await tx.put('care_users', ownerId, { openid: IDENTITY.owner, subscribed: false });
    await tx.put('care_users', memberId, { openid: IDENTITY.member, subscribed: false });
  });
}

/**
 * 在同一HTTP监听器组合正式与独立审核应用，所有审核路径先过期限门禁。
 * @param {object} options repo、正式config/primary、私有access及可注入服务端now。
 * @returns {Promise<object>} 同原应用的server/tick/close；tick只扫描正式家庭。
 * @throws {Error} 有效审核配置初始化存储失败或创建HTTP应用失败。
 */
async function createReviewApplication({
  repo,
  config,
  primary,
  access,
  now = () => new Date().toISOString(),
}) {
  // 时间只来自服务端，不接受查询参数或审核用户正文改变访问期限。
  const clock = () => new Date(now()).getTime();
  const settings = readAccess(access, clock());
  // 缺失或无效配置不创建审核数据，正式应用仍按原流程服务真实家庭。
  let review;
  if (settings) {
    const reviewRepo = createReviewRepository(repo);
    // 初始化与业务共用同一私有前缀仓库，图片、会话和行为记录也不会漏回正式集合。
    await seedReview(reviewRepo, now());
    // 签名用途域与文件目录都隔离，替换/review前缀不能把测试短链改成正式图片链接。
    const signingSecret = crypto
      .createHmac('sha256', config.signingSecret)
      .update('family-care-review-v1')
      .digest('hex');
    review = createHttpApplication({
      repo: reviewRepo,
      config: {
        ...config,
        // 禁用真实微信配置，仅登录认证方式变化，其余业务仍是同一套真实实现。
        reviewMode: true,
        ownerOpenId: IDENTITY.owner,
        appId: '',
        appSecret: '',
        templateId: '',
        fields: {},
        // 文件模式隔离到独立子目录；数据库模式由review_前缀隔离二进制内容。
        dataDir: path.join(config.dataDir, 'review'),
        publicOrigin: `${config.publicOrigin || ''}/review`,
        // 私有链接携带审核路由前缀，并使用独立HMAC用途密钥签发。
        signingSecret,
      },
      // 两种账户从受信认证器变成固定测试成员，不能通过正文指定业务身份。
      authenticateLogin: createReviewLogin(settings, clock),
      // 审核消息无论任何业务路径都不能发送到微信，禁发不伪装成已送达。
      wechat: {
        sendMessage: async () => {
          throw new Error(NOTICE);
        },
      },
    });
  }
  /**
   * 依据固定路径与服务端期限分流，所有审核资源都经过相同门禁。
   * @param {http.IncomingMessage} request 原始HTTP请求，不能提供命名空间或认证配置。
   * @param {http.ServerResponse} response 原始响应；关闭入口时返回固定403正文。
   * @returns {void} 将请求交给原业务应用或结束当前响应。
   */
  function handleRequest(request, response) {
    // 畸形绝对URL不得抛出未捕获异常，避免一个匿名请求终止整个家庭服务进程。
    let url;
    try {
      url = new URL(request.url, 'http://127.0.0.1');
    } catch (_) {
      response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: false, message: '请求地址不正确' }));
      return;
    }
    // 仅固定路径前缀决定路由，账号、token或任意query都不能切换数据命名空间。
    const isReview = url.pathname === '/review' || url.pathname.startsWith('/review/');
    // 正式URL完整交回原应用，不修改其登录方式、鉴权或数据集合。
    if (!isReview) return primary.server.emit('request', request, response);
    // 门禁覆盖登录、业务、分片和已签图片，旧token或旧短链也不能绕过到期关闭。
    if (!review || clock() >= settings.expiresAt) {
      response.writeHead(403, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(JSON.stringify({ ok: false, message: '审核访问未开放或已到期' }));
      return;
    }
    // 仅移除已确认的固定前缀，底层仍用完全相同的路由、权限和持久化业务。
    request.url = (url.pathname.slice('/review'.length) || '/') + url.search;
    review.server.emit('request', request, response);
  }
  // 只新增同一监听器下的路由分支，数据库连接和云服务资源不额外新建。
  const server = http.createServer(handleRequest);
  // 继承原入口的正文与响应头超时，审核端不能成为无限慢请求的旁路。
  server.requestTimeout = primary.server.requestTimeout;
  server.headersTimeout = primary.server.headersTimeout;
  // 审核环境不加入定时发送循环，真实家庭提醒仍由原应用及独立调度负责。
  return {
    server,
    tick: () => primary.tick(),
    close: () =>
      new Promise((resolve, reject) => {
        if (!server.listening) return resolve();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

module.exports = { createReviewApplication, createReviewRepository };
