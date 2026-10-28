const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createSQLiteRepository } = require('../selfhost/sqlite-repository.cjs');
const { createHttpApplication } = require('../selfhost/app.cjs');
const { createReviewApplication, createReviewRepository } = require('../selfhost/review.cjs');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const TEST_PASSWORD = 'unit-test-only-not-a-real-password';
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]).toString('base64');

function access(expiresAt) {
  return {
    version: 1,
    expiresAt,
    accounts: ['owner', 'member'].map((role, index) => {
      const salt = Buffer.alloc(16, index + 1);
      return {
        role,
        username: `fixture-${role}`,
        salt: salt.toString('hex'),
        passwordHash: crypto
          .scryptSync(TEST_PASSWORD, salt, 64, { N: 16384, r: 8, p: 1 })
          .toString('hex'),
      };
    }),
  };
}

async function fixture(t, override = {}) {
  const repo = override.repo || createSQLiteRepository(':memory:');
  let time = Date.now();
  const config = {
    dataDir: require('node:os').tmpdir(),
    avatarStorage: 'database',
    ownerOpenId: 'formal-owner',
    signingSecret: 's'.repeat(64),
    publicOrigin: '',
    fields: {},
    ...override.config,
  };
  const primary = createHttpApplication({
    repo,
    config,
    wechat: {
      exchangeCode: async () => ({ openid: 'formal-owner' }),
      sendMessage: async () => {
        throw new Error('测试不应外发');
      },
    },
  });
  const reviewAccess =
    override.access === undefined
      ? access(new Date(time + 7 * 86400000).toISOString())
      : override.access;
  const app = await createReviewApplication({
    repo,
    config,
    primary,
    access: reviewAccess,
    now: () => new Date(time).toISOString(),
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await app.close();
    await repo.close();
  };
  t.after(close);
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (route, data, token) => {
    const response = await fetch(origin + route, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(data),
    });
    return { status: response.status, body: await response.json() };
  };
  const login = async (username = 'fixture-owner', password = TEST_PASSWORD) =>
    request('/review/api/login', { username, password });
  const call = async (token, action, data = {}, review = true) =>
    request(`${review ? '/review' : ''}/api/call`, { action, data }, token);
  return {
    repo,
    app,
    origin,
    request,
    login,
    call,
    close,
    config,
    reviewAccess,
    advance: (delta) => {
      time += delta;
    },
  };
}

test('审核仓库get/put/list/transaction均强制review_前缀，无法访问正式集合', async (t) => {
  const repo = createSQLiteRepository(':memory:');
  t.after(() => repo.close());
  const review = createReviewRepository(repo);
  await repo.put('care_records', 'one', { value: 'formal' });
  await review.put('care_records', 'one', { value: 'review' });
  assert.equal((await review.get('care_records', 'one')).value, 'review');
  assert.equal((await repo.get('care_records', 'one')).value, 'formal');
  assert.deepEqual(await review.list('care_records', {}, 20), [{ value: 'review' }]);
  await review.transaction((tx) => tx.put('care_records', 'two', { value: 'tx-review' }));
  assert.equal(await repo.get('care_records', 'two'), null);
  assert.equal((await repo.get('review_care_records', 'two')).value, 'tx-review');
  await assert.rejects(review.get('../care_records', 'one'), /集合/);
});

test('审核账号真实登录及持久化领域操作，管理员和家人权限不同且正式数据不受影响', async (t) => {
  const f = await fixture(t);
  const formal = await f.request('/api/login', { code: 'unit-only' });
  const formalToken = formal.body.data.token;
  await f.call(formalToken, 'createHome', { name: '正式私有称呼' }, false);
  const admin = await f.login(),
    member = await f.login('fixture-member');
  assert.equal(admin.status, 200);
  assert.equal(member.status, 200);
  const ownerToken = admin.body.data.token,
    memberToken = member.body.data.token;
  const session = await f.repo.get('review_care_sessions', hash(ownerToken));
  assert.ok(session.expiresAt <= Date.parse(f.reviewAccess.expiresAt));
  const snapshot = await f.call(ownerToken, 'snapshot');
  assert.equal(snapshot.body.data.configured, false);
  assert.equal(snapshot.body.data.reviewMode, true);
  assert.match(snapshot.body.data.notificationNotice, /不发送/);
  assert.equal(snapshot.body.data.home.babies.length, 1);
  assert.equal(snapshot.body.data.home.tasks.length, 2);
  assert.doesNotMatch(JSON.stringify(snapshot.body.data), /正式私有称呼/);
  const blocked = await f.call(memberToken, 'saveBaby', { name: '普通家人不应新增' });
  assert.equal(blocked.body.ok, false);
  assert.equal((await f.call(ownerToken, 'saveBaby', { name: '审核新增宝宝' })).body.ok, true);
  const home = await f.repo.get('review_care_home', 'home');
  assert.equal(home.babies.length, 2);
  assert.equal((await f.repo.get('care_home', 'home')).babies.length, 0);
  const task = home.tasks.find((item) => item.scope === 'baby');
  const date = require('../server/domain').chinaDate(new Date());
  assert.equal(home.createdDate, require('../server/domain').addDays(date, -7));
  assert.equal(
    (
      await f.call(memberToken, 'complete', {
        taskId: task.id,
        date,
        done: true,
        expectedRevision: 0,
      })
    ).body.ok,
    true
  );
  assert.equal((await f.repo.get('review_care_days', date)).records[task.id].done, true);
  assert.equal(await f.repo.get('care_days', date), null);
  for (const action of ['makeInvite', 'applyInvite', 'previewInvite', 'subscribe'])
    assert.equal((await f.call(ownerToken, action, {})).status, 403);
});

test('错误口令返回固定401，登录保留60每IP分钟限流且日志不输出口令', async (t) => {
  const f = await fixture(t);
  const original = console.warn,
    warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  t.after(() => {
    console.warn = original;
  });
  assert.equal((await f.login('fixture-owner', 'wrong-test-only')).status, 401);
  assert.equal(
    (await f.login('unknown-fixture', 'wrong-test-only')).body.message,
    '审核账号或口令不正确'
  );
  assert.equal((await f.request('/review/api/login', null)).status, 401);
  assert.equal((await f.request('/review/api/login', { username: 'fixture-owner' })).status, 401);
  for (let index = 0; index < 56; index++)
    assert.equal((await f.login('fixture-owner', '')).status, 401);
  assert.equal((await f.login()).status, 429);
  assert.doesNotMatch(warnings.join('\n'), /wrong-test-only|unit-test-only-not-a-real-password/);
});

test('审核文件模式目录隔离，真实SQLite重连保留操作且重启不覆盖样例', async (t) => {
  const fs = require('node:fs'),
    path = require('node:path'),
    os = require('node:os');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'review-storage-test-'));
  const database = path.join(directory, 'family.sqlite');
  const f = await fixture(t, {
    repo: createSQLiteRepository(database),
    config: { dataDir: directory, avatarStorage: 'filesystem' },
  });
  let reopened, rebuilt;
  try {
    const token = (await f.login()).body.data.token;
    assert.equal((await f.call(token, 'saveBaby', { name: '重启仍保留的测试宝宝' })).body.ok, true);
    const uploaded = await f.call(token, 'uploadWallPhoto', {
      scope: 'family',
      babyId: '',
      base64: png,
    });
    assert.equal(uploaded.body.ok, true);
    const filename = uploaded.body.data.photoId.slice(6);
    assert.equal(fs.existsSync(path.join(directory, 'review', 'avatars', filename)), true);
    assert.equal(fs.existsSync(path.join(directory, 'avatars', filename)), false);
    await f.close();
    reopened = createSQLiteRepository(database);
    const primary = createHttpApplication({ repo: reopened, config: f.config });
    rebuilt = await createReviewApplication({
      repo: reopened,
      config: f.config,
      primary,
      access: f.reviewAccess,
    });
    const home = await reopened.get('review_care_home', 'home');
    assert.equal(home.babies.length, 2);
    assert.ok(home.babies.some((baby) => baby.name === '重启仍保留的测试宝宝'));
    assert.equal(home.tasks.length, 2);
    assert.equal(await reopened.get('care_home', 'home'), null);
  } finally {
    await rebuilt?.close();
    await reopened?.close();
    await f.close();
    const resolved = path.resolve(directory),
      root = path.resolve(os.tmpdir());
    assert.ok(resolved.startsWith(root + path.sep));
    assert.ok(path.basename(resolved).startsWith('review-storage-test-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

test('正式与审核token和签名不能互用，审核图片仅存在独立命名空间，期限覆盖文件入口', async (t) => {
  const f = await fixture(t);
  const formal = (await f.request('/api/login', { code: 'unit-only' })).body.data.token;
  await f.call(formal, 'createHome', { name: '正式管理员' }, false);
  const token = (await f.login()).body.data.token;
  assert.equal((await f.call(token, 'snapshot', {}, false)).status, 401);
  assert.equal((await f.call(formal, 'snapshot')).status, 401);
  const uploaded = await f.call(token, 'uploadWallPhoto', {
    scope: 'family',
    babyId: '',
    base64: png,
  });
  const photoId = uploaded.body.data.photoId;
  await f.call(token, 'publishPhotoPost', {
    scope: 'family',
    babyId: '',
    photoIds: [photoId],
    text: '审核独立图片',
  });
  const post = (await f.call(token, 'listPhotoPosts')).body.data.posts[0];
  const route = post.photos[0].photoUrl;
  assert.match(route, /^\/review\/api\/avatar\//);
  assert.equal(await f.repo.get('care_avatar_blobs', photoId.slice(6)), null);
  assert.ok(await f.repo.get('review_care_avatar_blobs', photoId.slice(6)));
  assert.equal((await fetch(f.origin + route)).status, 200);
  assert.equal((await fetch(f.origin + route.replace('/review', ''))).status, 403);
  const formalUpload = await f.call(formal, 'uploadAvatar', { base64: png }, false);
  const formalId = formalUpload.body.data.fileID;
  await f.call(formal, 'saveBaby', { name: '正式宝宝', avatar: formalId }, false);
  const formalRoute = (await f.call(formal, 'snapshot', {}, false)).body.data.home.babies[0]
    .avatarUrl;
  assert.equal((await fetch(f.origin + '/review' + formalRoute)).status, 403);
  const malformed = await new Promise((resolve, reject) => {
    const request = require('node:http').get(f.origin, { path: 'http://[' }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
  });
  assert.equal(malformed, 400);
  f.advance(7 * 86400000 + 1);
  assert.equal((await f.call(token, 'snapshot')).status, 403);
  assert.equal((await f.login()).status, 403);
  assert.equal((await fetch(f.origin + route)).status, 403);
  assert.equal((await f.call(formal, 'snapshot', {}, false)).status, 200);
});

test('审核配置缺失、损坏或已过期均关闭入口，不初始化审核数据且正式入口保持可用', async (t) => {
  for (const invalid of ['', '{invalid', access(new Date(Date.now() - 1).toISOString())]) {
    const f = await fixture(t, { access: invalid });
    assert.equal((await f.login()).status, 403);
    assert.equal(await f.repo.get('review_care_home', 'home'), null);
    assert.equal((await f.request('/api/login', { code: 'unit-only' })).status, 200);
  }
});
