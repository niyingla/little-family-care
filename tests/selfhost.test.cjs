const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createSQLiteRepository } = require('../selfhost/sqlite-repository.cjs');
const { createHttpApplication } = require('../selfhost/app.cjs');

test('SQLite事务真实回滚，并发递增不会丢更新', async () => {
  const repo = createSQLiteRepository(':memory:');
  await assert.rejects(
    repo.transaction(async (tx) => {
      await tx.put('test', 'counter', { value: 99 });
      throw new Error('rollback');
    })
  );
  assert.equal(await repo.get('test', 'counter'), null);
  await repo.put('test', 'counter', { value: 0 });
  await Promise.all(
    Array.from({ length: 10 }, () =>
      repo.transaction(async (tx) => {
        const item = await tx.get('test', 'counter');
        await new Promise((resolve) => setImmediate(resolve));
        await tx.put('test', 'counter', { value: item.value + 1 });
      })
    )
  );
  assert.equal((await repo.get('test', 'counter')).value, 10);
  await repo.close();
});

test('服务器HTTP入口验证微信登录和会话，拒绝伪造身份及直接获取头像', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'family-care-test-'));
  const repo = createSQLiteRepository(':memory:');
  const app = createHttpApplication({
    repo,
    config: {
      dataDir,
      ownerOpenId: 'owner-openid',
      signingSecret: 'a'.repeat(64),
      publicOrigin: 'https://example.test',
      appId: 'test',
      appSecret: 'test',
      fields: {},
    },
    wechat: {
      exchangeCode: async (code) => ({
        openid: code === 'owner-code' ? 'owner-openid' : 'guest-openid',
      }),
      sendMessage: async () => {
        throw new Error('本测试不允许发送真实消息');
      },
    },
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await app.close();
    await repo.close();
    // 删除仅由本测试创建的临时目录，先验证绝对路径范围。
    const resolved = path.resolve(dataDir),
      prefix = path.resolve(os.tmpdir()) + path.sep + 'family-care-test-';
    if (!resolved.startsWith(prefix)) throw new Error('测试临时目录越界，未删除');
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const post = async (route, body, token) => {
    const response = await fetch(origin + route, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await fetch(origin + '/health')).status, 200);
  assert.equal(
    (await post('/api/call', { action: 'snapshot', openid: 'owner-openid' })).status,
    401
  );
  const owner = (await post('/api/login', { code: 'owner-code' })).body.data.token;
  assert.match(owner, /^[a-f0-9]{64}$/);
  const bootstrap = await post('/api/call', { action: 'bootstrap' }, owner);
  assert.equal(bootstrap.body.data.canCreate, true);
  assert.equal(
    (await post('/api/call', { action: 'createHome', data: { name: '妈妈' } }, owner)).body.ok,
    true
  );
  const guest = (await post('/api/login', { code: 'guest-code' })).body.data.token;
  const forbidden = await post(
    '/api/call',
    { action: 'snapshot', data: { openid: 'owner-openid' } },
    guest
  );
  assert.equal(forbidden.body.ok, false);
  assert.equal(forbidden.body.data, undefined);
  assert.equal(
    (await post('/api/call', { action: 'saveBaby', data: { name: '宝宝' } }, owner)).body.ok,
    true
  );
  const snapshot = (await post('/api/call', { action: 'snapshot' }, owner)).body.data;
  assert.equal(snapshot.home.babies[0].name, '宝宝');
  const unsigned = await fetch(origin + '/api/avatar/' + 'a'.repeat(32) + '.png');
  assert.equal(unsigned.status, 403);
  const wrongSession = await post('/api/call', { action: 'snapshot' }, 'b'.repeat(64));
  assert.equal(wrongSession.status, 401);
});
