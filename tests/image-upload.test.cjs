const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createImageUpload } = require('../selfhost/image-upload.cjs');
const { createSQLiteRepository } = require('../selfhost/sqlite-repository.cjs');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const uid = (value) => hash(value).slice(0, 32);
const CHUNK = 65536;

async function fixture(t) {
  const repo = createSQLiteRepository(':memory:');
  t.after(() => repo.close());
  await repo.put('care_home', 'home', {
    ownerId: uid('owner'),
    members: [
      { id: uid('owner'), active: true },
      { id: uid('dad'), active: true },
    ],
  });
  let time = Date.parse('2026-10-28T04:00:00.000Z'),
    count = 0,
    execute;
  const uploads = [];
  const manager = createImageUpload(repo, {
    hash,
    now: () => new Date(time).toISOString(),
    randomId: () => (++count).toString(16).padStart(32, '0'),
    readMember: async (openid) => {
      const home = await repo.get('care_home', 'home');
      if (!home.members.some((m) => m.id === uid(openid) && m.active))
        throw new Error('无权访问家庭');
      return home;
    },
    upload: async (action, openid, data) => {
      uploads.push({ action, openid, data });
      if (execute) return execute();
      return { photoId: `photo:${'a'.repeat(32)}.jpg` };
    },
  });
  return {
    repo,
    manager,
    uploads,
    advance: (ms) => {
      time += ms;
    },
    setUpload: (fn) => {
      execute = fn;
    },
  };
}

async function init(
  f,
  encoded,
  openid = 'dad',
  action = 'uploadWallPhoto',
  metadata = { scope: 'family', babyId: '' }
) {
  return f.manager.call(openid, 'initImageUpload', {
    action,
    metadata,
    totalLength: encoded.length,
    totalParts: Math.ceil(encoded.length / CHUNK),
  });
}

test('真实SQLite会话可乱序追加，同片幂等、冲突拒绝，缺块不执行原上传，finish重试不重复文件', async (t) => {
  const f = await fixture(t),
    encoded = Buffer.alloc(60000, 7).toString('base64');
  const { uploadId } = await init(f, encoded);
  const tail = { uploadId, index: 1, chunk: encoded.slice(CHUNK) };
  assert.deepEqual(await f.manager.call('dad', 'appendImageChunk', tail), { accepted: true });
  assert.deepEqual(await f.manager.call('dad', 'appendImageChunk', tail), { accepted: true });
  await assert.rejects(
    f.manager.call('dad', 'appendImageChunk', { ...tail, chunk: 'A'.repeat(tail.chunk.length) }),
    /冲突|不同/
  );
  await assert.rejects(f.manager.call('dad', 'finishImageUpload', { uploadId }), /缺少|完整/);
  assert.equal(f.uploads.length, 0);
  await f.manager.call('dad', 'appendImageChunk', {
    uploadId,
    index: 0,
    chunk: encoded.slice(0, CHUNK),
  });
  const result = await f.manager.call('dad', 'finishImageUpload', { uploadId });
  assert.deepEqual(await f.manager.call('dad', 'finishImageUpload', { uploadId }), result);
  assert.equal(f.uploads.length, 1);
  assert.equal(f.uploads[0].data.base64, encoded);
  assert.deepEqual(Object.keys(f.uploads[0].data).sort(), ['babyId', 'base64', 'scope']);
  assert.equal((await f.repo.get('care_uploads', uploadId)).status, 'done');
  for (const index of [0, 1])
    assert.equal((await f.repo.get('care_upload_parts', `${uploadId}:${index}`)).chunk, '');
});

test('每个分片重新鉴权，拒绝他人、离家、过期、越界及伪造metadata', async (t) => {
  const f = await fixture(t),
    encoded = Buffer.alloc(60000, 7).toString('base64');
  await assert.rejects(init(f, encoded, 'dad', 'uploadAvatar', {}), /管理员/);
  for (const metadata of [
    { scope: 'family', ownerId: 'forged' },
    { scope: 'family', photoId: 'forged' },
    { scope: 'family', uploadedBy: uid('owner') },
  ])
    await assert.rejects(init(f, encoded, 'dad', 'uploadWallPhoto', metadata), /参数|资料|字段/);
  const { uploadId } = await init(f, encoded);
  const part = { uploadId, index: 0, chunk: encoded.slice(0, CHUNK) };
  await assert.rejects(f.manager.call('owner', 'appendImageChunk', part), /无权/);
  await assert.rejects(f.manager.call('owner', 'finishImageUpload', { uploadId }), /无权/);
  for (const override of [
    { index: -1 },
    { index: 0.5 },
    { index: 2 },
    { chunk: part.chunk.slice(1) },
    { chunk: '!'.repeat(CHUNK) },
  ])
    await assert.rejects(
      f.manager.call('dad', 'appendImageChunk', { ...part, ...override }),
      /分片|编码/
    );
  const home = await f.repo.get('care_home', 'home');
  home.members.find((m) => m.id === uid('dad')).active = false;
  await f.repo.put('care_home', 'home', home);
  await assert.rejects(f.manager.call('dad', 'appendImageChunk', part), /无权/);
  home.members.find((m) => m.id === uid('dad')).active = true;
  await f.repo.put('care_home', 'home', home);
  f.advance(600001);
  await assert.rejects(f.manager.call('dad', 'appendImageChunk', part), /过期/);
});

test('整数与总长度严格限制，同人并发最多四个活动会话，过期后释放额度', async (t) => {
  const f = await fixture(t),
    encoded = Buffer.alloc(60000, 7).toString('base64');
  for (const data of [
    { totalLength: 0 },
    { totalLength: 13981020 },
    { totalLength: 8.5 },
    { totalParts: 1 },
    { totalParts: 2.5 },
  ])
    await assert.rejects(
      f.manager.call('dad', 'initImageUpload', {
        action: 'uploadWallPhoto',
        metadata: { scope: 'family' },
        totalLength: encoded.length,
        totalParts: 2,
        ...data,
      }),
      /长度|数量|分片/
    );
  const attempted = await Promise.allSettled(Array.from({ length: 5 }, () => init(f, encoded)));
  assert.equal(attempted.filter((item) => item.status === 'fulfilled').length, 4);
  assert.equal(attempted.filter((item) => item.status === 'rejected').length, 1);
  f.advance(600001);
  assert.ok((await init(f, encoded)).uploadId);
});

test('finishing抢占只执行一次副作用，失败转failed并清空内容，允许建立新会话', async (t) => {
  const f = await fixture(t),
    encoded = Buffer.alloc(12, 1).toString('base64');
  const { uploadId } = await init(f, encoded);
  await f.manager.call('dad', 'appendImageChunk', { uploadId, index: 0, chunk: encoded });
  let release;
  f.setUpload(
    () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  const first = f.manager.call('dad', 'finishImageUpload', { uploadId });
  await new Promise(setImmediate);
  await assert.rejects(f.manager.call('dad', 'finishImageUpload', { uploadId }), /处理中|确认/);
  release({ photoId: 'once' });
  await first;
  assert.equal(f.uploads.length, 1);
  const next = await init(f, encoded);
  await f.manager.call('dad', 'appendImageChunk', {
    uploadId: next.uploadId,
    index: 0,
    chunk: encoded,
  });
  f.setUpload(() => {
    throw new Error('原始图片校验拒绝');
  });
  await assert.rejects(f.manager.call('dad', 'finishImageUpload', next), /校验拒绝/);
  assert.equal((await f.repo.get('care_uploads', next.uploadId)).status, 'failed');
  assert.equal((await f.repo.get('care_upload_parts', `${next.uploadId}:0`)).chunk, '');
  await assert.rejects(f.manager.call('dad', 'finishImageUpload', next), /失败|重新/);
  assert.ok((await init(f, encoded)).uploadId);
});

test('HTTP真实仓库保存1MiB和10MiB JPEG，22/214片JSON低于100KB，超10MiB三原入口和完成分片均拒绝', async (t) => {
  const { createHttpApplication } = require('../selfhost/app.cjs');
  const repo = createSQLiteRepository(':memory:');
  const app = createHttpApplication({
    repo,
    config: {
      dataDir: require('node:os').tmpdir(),
      avatarStorage: 'database',
      ownerOpenId: 'owner',
      signingSecret: 's'.repeat(64),
      publicOrigin: '',
      fields: {},
    },
    wechat: { exchangeCode: async () => ({ openid: 'owner' }), sendMessage: async () => {} },
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await app.close();
    await repo.close();
  });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const login = await fetch(origin + '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'local-test-only' }),
  });
  const token = (await login.json()).data.token;
  const call = async (action, data = {}) => {
    const body = JSON.stringify({ action, data });
    assert.ok(Buffer.byteLength(body) < 100000);
    const response = await fetch(origin + '/api/call', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body,
    });
    const result = await response.json();
    assert.equal(result.ok, true, result.message);
    return result.data;
  };
  await call('createHome', { name: '妈妈' });
  // 仅本地测试生成高熵字节验证传输及持久化，绝不上传至生产或作为用户真实照片。
  for (const [bytes, parts] of [
    [1024 * 1024, 22],
    [10 * 1024 * 1024, 214],
  ]) {
    const image = crypto.randomBytes(bytes);
    Buffer.from([255, 216, 255]).copy(image);
    const encoded = image.toString('base64'),
      totalParts = Math.ceil(encoded.length / CHUNK);
    assert.equal(totalParts, parts);
    const session = await call('initImageUpload', {
      action: 'uploadWallPhoto',
      metadata: { scope: 'family', babyId: '' },
      totalLength: encoded.length,
      totalParts,
    });
    for (let index = 0; index < totalParts; index++)
      await call('appendImageChunk', {
        uploadId: session.uploadId,
        index,
        chunk: encoded.slice(index * CHUNK, (index + 1) * CHUNK),
      });
    const finished = await call('finishImageUpload', session);
    assert.deepEqual(await call('finishImageUpload', session), finished);
    const stored = await repo.get('care_avatar_blobs', finished.photoId.slice(6));
    assert.deepEqual(Buffer.from(stored.base64, 'base64'), image);
  }
  const today = require('../server/domain').chinaDate(new Date());
  await call('saveTask', {
    scope: 'family',
    title: '本地上传上限验证',
    babyIds: [],
    assigneeId: uid('owner'),
    frequency: 'once',
    startDate: today,
  });
  const snapshot = await call('snapshot'),
    taskId = snapshot.home.tasks[0].id;
  const excessive = Buffer.alloc(10 * 1024 * 1024 + 1, 7);
  Buffer.from([255, 216, 255]).copy(excessive);
  const base64 = excessive.toString('base64');
  // 多一个原始字节仍可能有相同Base64字符数，必须检查解码后的真实字节。
  assert.equal(base64.length, 13981016);
  for (const [action, data] of [
    ['uploadAvatar', { base64 }],
    ['uploadCompletionPhoto', { taskId, date: today, base64 }],
    ['uploadWallPhoto', { scope: 'family', babyId: '', base64 }],
  ]) {
    const response = await fetch(origin + '/api/call', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, data }),
    });
    const result = await response.json();
    assert.equal(result.ok, false);
    assert.match(result.message, /10MB/);
  }
  const session = await call('initImageUpload', {
    action: 'uploadWallPhoto',
    metadata: { scope: 'family' },
    totalLength: base64.length,
    totalParts: 214,
  });
  for (let index = 0; index < 214; index++)
    await call('appendImageChunk', {
      uploadId: session.uploadId,
      index,
      chunk: base64.slice(index * CHUNK, (index + 1) * CHUNK),
    });
  const response = await fetch(origin + '/api/call', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ action: 'finishImageUpload', data: session }),
  });
  const result = await response.json();
  assert.equal(result.ok, false);
  assert.match(result.message, /10MB/);
  assert.equal((await repo.get('care_uploads', session.uploadId)).status, 'failed');
  assert.equal((await repo.get('care_upload_parts', `${session.uploadId}:0`)).chunk, '');
});

test('HTTP登录仍限60每IP分钟，普通业务仍限240每成员分钟，不随大图扩容而放开', async (t) => {
  const { createHttpApplication } = require('../selfhost/app.cjs');
  const repo = createSQLiteRepository(':memory:');
  let exchanged = 0;
  const app = createHttpApplication({
    repo,
    config: {
      dataDir: require('node:os').tmpdir(),
      avatarStorage: 'database',
      ownerOpenId: 'owner',
      signingSecret: 's'.repeat(64),
      publicOrigin: '',
      fields: {},
    },
    wechat: {
      exchangeCode: async () => {
        exchanged++;
        return { openid: 'owner' };
      },
      sendMessage: async () => {},
    },
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await app.close();
    await repo.close();
  });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const login = () =>
    fetch(origin + '/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'local-rate-test' }),
    });
  const token = (await (await login()).json()).data.token;
  const request = (action) =>
    fetch(origin + '/api/call', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ action }),
    });
  for (let index = 0; index < 240; index++) assert.equal((await request('bootstrap')).status, 200);
  assert.equal((await request('bootstrap')).status, 429);
  for (let index = 0; index < 59; index++) assert.equal((await login()).status, 200);
  assert.equal((await login()).status, 429);
  assert.equal(exchanged, 60);
});
