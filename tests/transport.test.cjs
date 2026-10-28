const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createTransport } = require('../miniprogram/utils/transport');

test('会话前缀只由创建参数控制，审核私有图保持原路径且拒绝跨模式和路径跳转', async () => {
  const calls = [],
    config = { cloudRunEnvId: 'test', cloudRunService: 'family-care' };
  const platform = {
    cloud: {
      callContainer: async (options) => {
        calls.push(options);
        return {};
      },
    },
  };
  const family = createTransport(config, platform),
    review = createTransport(config, platform, { review: true });
  await family('/api/call', { action: 'bootstrap', review: true, mode: 'review' }, 'family-token');
  assert.equal(calls.at(-1).path, '/api/call');
  await review('/api/call', { action: 'bootstrap' }, 'review-token');
  assert.equal(calls.at(-1).path, '/review/api/call');
  await review('/review/api/call', { action: 'finishImageUpload' }, 'review-token');
  assert.equal(calls.at(-1).path, '/review/api/call');
  assert.equal(calls.at(-1).timeout, 60000);
  const photo = '/review/api/avatar/' + 'a'.repeat(32) + '.png?expires=1&signature=test';
  await review(photo, undefined, '', { method: 'GET' });
  assert.equal(calls.at(-1).path, photo);
  await assert.rejects(family('/review/api/call', {}), /审核/);
  await assert.rejects(review(photo.slice(7), undefined, '', { method: 'GET' }), /审核/);
  await assert.rejects(review('/review/api/avatar/../../api/call', {}), /审核/);
});

test('仅图片分片完成保留60秒组装窗口，登录、普通动作、追加分片及私有读取仍为15秒', async () => {
  // 真实跨云组装含214次读取及清理，独立预算不能放大登录和所有普通业务超时。
  for (const cloud of [true, false]) {
    const received = [];
    const platform = {
      cloud: {
        callContainer: async (options) => {
          received.push(options);
          return {};
        },
      },
      request: (options) => {
        received.push(options);
        options.success({});
      },
    };
    const config = cloud
      ? { cloudRunEnvId: 'env-test', cloudRunService: 'family-care' }
      : { apiBaseUrl: 'https://api.example.test' };
    const transport = createTransport(config, platform);
    await transport('/api/call', { action: 'finishImageUpload' }, 'session');
    for (const action of ['snapshot', 'appendImageChunk', 'initImageUpload'])
      await transport('/api/call', { action }, 'session');
    // 相同正文放在其他路由不获得更长时限，调用方自传timeout也不扩大预算。
    await transport('/api/login', { action: 'finishImageUpload' }, '', { timeout: 60000 });
    await transport('/api/avatar/image.jpg', undefined, '', { method: 'GET' });
    assert.deepEqual(
      received.map((options) => options.timeout),
      [60000, 15000, 15000, 15000, 15000, 15000]
    );
  }
});

test('云托管请求保留业务路径与会话，配置自有域名时也优先使用选定云入口', async () => {
  // 错误回落到wx.request会再次依赖未备案域名，此处禁止该调用发生。
  let received;
  const platform = {
    cloud: {
      callContainer: async (options) => {
        received = options;
        return { statusCode: 200, data: { ok: true } };
      },
    },
    request: () => {
      throw new Error('unexpected domain request');
    },
  };
  const transport = createTransport(
    {
      cloudRunEnvId: 'env-test',
      cloudRunService: 'family-care',
      apiBaseUrl: 'https://legacy.example.test',
    },
    platform
  );
  assert.equal((await transport('/api/call', { action: 'snapshot' }, 'session')).data.ok, true);
  assert.equal(received.path, '/api/call');
  assert.equal(received.config.env, 'env-test');
  assert.equal(received.header['X-WX-SERVICE'], 'family-care');
  assert.equal(received.header.Authorization, 'Bearer session');
  assert.deepEqual(received.data, { action: 'snapshot' });
  await transport('/api/avatar/test.png?expires=1', undefined, '', {
    method: 'GET',
    responseType: 'arraybuffer',
    header: { Range: 'bytes=0-524287' },
  });
  assert.equal(received.responseType, 'arraybuffer');
  assert.equal(received.method, 'GET');
  assert.equal(received.header.Range, 'bytes=0-524287');
});

test('后续仅配置HTTPS域名即可切换入口，云配置残缺时明确失败', async () => {
  let received;
  const platform = {
    request: (options) => {
      received = options;
      options.success({ statusCode: 200, data: { ok: true } });
    },
  };
  await createTransport({ apiBaseUrl: 'https://api.example.test/' }, platform)('/api/login', {
    code: 'test-code',
  });
  assert.equal(received.url, 'https://api.example.test/api/login');
  await assert.rejects(
    createTransport(
      { cloudRunEnvId: 'env-test', apiBaseUrl: 'https://api.example.test' },
      platform
    )('/api/call', {}),
    /完整/
  );
  await assert.rejects(
    createTransport({ apiBaseUrl: 'http://120.25.247.111' }, platform)('/api/call', {}),
    /HTTPS/
  );
});
