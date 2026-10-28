const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');

const clientPath = path.resolve(__dirname, '../miniprogram/utils/client.js');
const clientRequire = createRequire(clientPath);
const original = crypto.randomBytes(10 * 1024 * 1024);
original.set([0xff, 0xd8, 0xff], 0);
const encoded = original.toString('base64');

function createClient({ configuration = {}, failure, unacceptedIndex, beforeReply } = {}) {
  const config = {
    cloudRunEnvId: 'test-cloud-env',
    cloudRunService: 'test-family-service',
    ...configuration,
  };
  const calls = [];
  const parts = [];
  let initialization;
  async function handle(options) {
    const data = JSON.parse(JSON.stringify(options.data));
    const bytes = Buffer.byteLength(JSON.stringify(data));
    const item = { path: options.path || new URL(options.url).pathname, bytes, ...data };
    calls.push(item);
    if (bytes > 100000)
      throw Object.assign(new Error('synthetic gateway size rejection'), { errCode: -606001 });
    if (item.path === '/api/login')
      return { statusCode: 200, data: { ok: true, data: { token: 'test-session-only' } } };
    if (beforeReply) await beforeReply(item);
    if (failure && failure(item))
      return { statusCode: 400, data: { ok: false, message: '本步上传失败' } };
    let result;
    if (data.action === 'initImageUpload') {
      initialization = data.data;
      result = { uploadId: 'test-upload-001' };
    } else if (data.action === 'appendImageChunk') {
      parts.push(data.data.chunk);
      result = { accepted: data.data.index !== unacceptedIndex };
    } else if (data.action === 'finishImageUpload') {
      assert.equal(parts.length, initialization.totalParts);
      assert.equal(parts.join('').length, initialization.totalLength);
      result =
        initialization.action === 'uploadAvatar'
          ? { fileID: 'avatar:test-image' }
          : { photoId: 'photo:test-image' };
    } else if (data.action === 'uploadAvatar') result = { fileID: 'avatar:test-image' };
    else result = { photoId: 'photo:test-image' };
    return { statusCode: 200, data: { ok: true, data: result } };
  }
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(clientPath, 'utf8'),
    {
      module,
      require: (name) => (name === '../config' ? config : clientRequire(name)),
      wx: {
        login: ({ success }) => success({ code: 'test-once-code' }),
        cloud: { callContainer: handle },
        request: (options) => {
          void handle(options).then(options.success, options.fail);
        },
      },
      console: { warn() {}, info() {}, error() {} },
    },
    { filename: clientPath }
  );
  return { api: module.exports, calls, parts };
}

for (const [action, metadata] of [
  ['uploadAvatar', {}],
  ['uploadCompletionPhoto', { taskId: 'task-001', date: '2026-10-28' }],
  ['uploadWallPhoto', { scope: 'baby', babyId: 'baby-001' }],
  ['uploadWallPhoto', { scope: 'family', babyId: '' }],
]) {
  test(`${action}以真实client把10MiB高熵JPEG完整拆成214个安全请求并保留白名单元数据`, async () => {
    const { api, calls, parts } = createClient();
    const payload = {
      ...metadata,
      base64: encoded,
      name: 'must-not-send',
      openid: 'must-not-send',
      token: 'must-not-send',
    };
    const result = await api.call(action, payload);
    const business = calls.filter((call) => call.path === '/api/call');
    assert.deepEqual(business[0], {
      path: '/api/call',
      bytes: business[0].bytes,
      action: 'initImageUpload',
      data: { action, metadata, totalLength: encoded.length, totalParts: 214 },
    });
    assert.equal(parts.length, 214);
    assert.deepEqual(Buffer.from(parts.join(''), 'base64'), original);
    for (let index = 0; index < 214; index++) {
      const part = business[index + 1];
      assert.equal(part.action, 'appendImageChunk');
      assert.deepEqual(Object.keys(part.data).sort(), ['chunk', 'index', 'uploadId']);
      assert.equal(part.data.index, index);
      assert.equal(part.data.uploadId, 'test-upload-001');
      assert.ok(part.data.chunk.length <= 65536);
    }
    assert.equal(business.at(-1).action, 'finishImageUpload');
    assert.deepEqual(business.at(-1).data, { uploadId: 'test-upload-001' });
    assert.equal(calls.filter((call) => call.path === '/api/login').length, 1);
    assert.ok(calls.every((call) => call.bytes <= 100000));
    assert.equal(JSON.stringify(business).includes('must-not-send'), false);
    assert.equal(payload.base64, encoded);
    assert.equal(
      action === 'uploadAvatar' ? result.fileID : result.photoId,
      action === 'uploadAvatar' ? 'avatar:test-image' : 'photo:test-image'
    );
  });
}

test('65536字符的小图保留单包上传，超过边界才创建分片会话', async () => {
  const small = createClient();
  await small.api.call('uploadAvatar', { base64: 'A'.repeat(65536) });
  assert.deepEqual(
    small.calls.filter((call) => call.path === '/api/call').map((call) => call.action),
    ['uploadAvatar']
  );
  const large = createClient();
  await large.api.call('uploadAvatar', { base64: 'A'.repeat(65540) });
  assert.deepEqual(
    large.calls.filter((call) => call.path === '/api/call').map((call) => call.action),
    ['initImageUpload', 'appendImageChunk', 'appendImageChunk', 'finishImageUpload']
  );
});

for (const [name, failure, expected] of [
  ['初始化', (call) => call.action === 'initImageUpload', ['initImageUpload']],
  [
    '第二片',
    (call) => call.action === 'appendImageChunk' && call.data.index === 1,
    ['initImageUpload', 'appendImageChunk', 'appendImageChunk'],
  ],
  [
    '完成',
    (call) => call.action === 'finishImageUpload',
    ['initImageUpload', 'appendImageChunk', 'appendImageChunk', 'finishImageUpload'],
  ],
]) {
  test(`${name}失败立即向原调用方抛错，不继续后续阶段或重建会话`, async () => {
    const { api, calls } = createClient({ failure });
    await assert.rejects(api.call('uploadAvatar', { base64: 'A'.repeat(65540) }), /本步上传失败/);
    assert.deepEqual(
      calls.filter((call) => call.path === '/api/call').map((call) => call.action),
      expected
    );
  });
}

test('服务端未明确接收分片时不发送下一片或完成请求', async () => {
  const { api, calls } = createClient({ unacceptedIndex: 0 });
  await assert.rejects(api.call('uploadAvatar', { base64: 'A'.repeat(65540) }), /分片|上传/);
  assert.deepEqual(
    calls.filter((call) => call.path === '/api/call').map((call) => call.action),
    ['initImageUpload', 'appendImageChunk']
  );
});

test('上一片响应未返回时不会提前发送下一片或完成请求', async () => {
  let release, entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const first = new Promise((resolve) => {
    entered = resolve;
  });
  const { api, calls } = createClient({
    beforeReply: async (call) => {
      if (call.action === 'appendImageChunk' && call.data.index === 0) {
        entered();
        await gate;
      }
    },
  });
  const pending = api.call('uploadAvatar', { base64: 'A'.repeat(131076) });
  await first;
  try {
    assert.deepEqual(
      calls.filter((call) => call.path === '/api/call').map((call) => call.action),
      ['initImageUpload', 'appendImageChunk']
    );
  } finally {
    release();
  }
  await pending;
  assert.deepEqual(
    calls.filter((call) => call.action === 'appendImageChunk').map((call) => call.data.index),
    [0, 1, 2]
  );
});

test('超过10MiB编码上限的上传在初始化前拒绝，不创建无法完成的会话', async () => {
  const { api, calls } = createClient();
  await assert.rejects(
    api.call('uploadAvatar', { base64: 'A'.repeat(13981020) }),
    /大小|过大|10MB/
  );
  assert.equal(calls.length, 0);
});

test('原图只超10MiB一个字节且Base64总长仍相同时也在初始化前拒绝', async () => {
  const { api, calls } = createClient();
  const oversized = Buffer.concat([original, Buffer.from([1])]).toString('base64');
  assert.equal(oversized.length, encoded.length);
  await assert.rejects(api.call('uploadAvatar', { base64: oversized }), /大小|过大|10MB/);
  assert.equal(calls.length, 0);
});

test('自有HTTPS入口也以214块上传10MiB图像，其他业务动作不进入分片流程', async () => {
  const direct = createClient({
    configuration: { cloudRunEnvId: '', cloudRunService: '', apiBaseUrl: 'https://test.example' },
  });
  await direct.api.call('uploadAvatar', { base64: encoded });
  const business = direct.calls.filter((call) => call.path === '/api/call');
  assert.equal(business[0].action, 'initImageUpload');
  assert.equal(business.filter((call) => call.action === 'appendImageChunk').length, 214);
  assert.equal(business.at(-1).action, 'finishImageUpload');
  assert.ok(direct.calls.every((call) => call.bytes <= 100000));
  assert.deepEqual(Buffer.from(direct.parts.join(''), 'base64'), original);
  const cloud = createClient();
  await cloud.api.call('saveBaby', { name: '测试宝宝' });
  assert.deepEqual(
    cloud.calls.filter((call) => call.path === '/api/call').map((call) => call.action),
    ['saveBaby']
  );
});

test('旧云开发备选入口明确拒绝大图，不伪装成支持10MiB分片', async () => {
  const { api, calls } = createClient({
    configuration: { cloudRunEnvId: '', cloudRunService: '', envId: 'legacy-env' },
  });
  await assert.rejects(
    api.call('uploadAvatar', { base64: 'A'.repeat(65540) }),
    /云开发.*不支持|不支持.*大图/
  );
  assert.equal(calls.length, 0);
});
