const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createTransport } = require('../miniprogram/utils/transport');
const { createAvatarCache } = require('../miniprogram/utils/avatar-cache');
const media = require('../miniprogram/utils/media-policy');
const familyToken = 'f'.repeat(64),
  reviewToken = 'a'.repeat(64);
const pictureName = 'b'.repeat(32) + '.png';
const familyPicture = '/api/avatar/' + pictureName + '?expires=1&signature=test';
const reviewPicture = '/review' + familyPicture;

function fixture(configOverride = {}) {
  const calls = [],
    writes = [],
    logs = [],
    files = new Map(),
    navigation = [];
  let wechatLogins = 0;
  const state = { reviewStatus: 200, handler: null, imageWait: null };
  const platform = {
    env: { USER_DATA_PATH: '/private' },
    login({ success }) {
      wechatLogins++;
      success({ code: 'trusted-wechat-code' });
    },
    setStorageSync(...args) {
      writes.push(args);
    },
    getStorageSync() {
      return null;
    },
    reLaunch(options) {
      navigation.push(options.url);
    },
    getFileSystemManager: () => ({
      readdirSync: () => [...files.keys()].map((name) => name.split('/').at(-1)),
      unlinkSync: (name) => {
        files.delete(name);
      },
      writeFile(options) {
        files.set(options.filePath, Buffer.from(options.data));
        options.success();
      },
    }),
    cloud: {
      callContainer: async (options) => {
        calls.push(options);
        if (state.handler) {
          const result = state.handler(options);
          if (result !== undefined) return result;
        }
        if (options.method === 'GET') {
          if (state.imageWait) await state.imageWait;
          return {
            statusCode: 206,
            header: { 'content-range': 'bytes 0-8/9' },
            data: new Uint8Array([
              137,
              80,
              78,
              71,
              13,
              10,
              26,
              10,
              options.path.startsWith('/review') ? 2 : 1,
            ]).buffer,
          };
        }
        if (options.path === '/api/login')
          return { statusCode: 200, data: { ok: true, data: { token: familyToken } } };
        if (options.path === '/review/api/login') {
          if (options.data.username !== 'reviewer' || options.data.password !== 'test-password')
            return { statusCode: 401, data: { ok: false, message: '审核账号或口令不正确' } };
          return { statusCode: 200, data: { ok: true, data: { token: reviewToken } } };
        }
        if (options.path === '/review/api/call' && state.reviewStatus !== 200)
          return {
            statusCode: state.reviewStatus,
            data: {
              ok: false,
              message: state.reviewStatus === 401 ? '登录已过期' : '审核访问未开放或已到期',
            },
          };
        const action = options.data && options.data.action;
        const data =
          action === 'initImageUpload'
            ? { uploadId: 'c'.repeat(32) }
            : action === 'appendImageChunk'
              ? { accepted: true }
              : action === 'finishImageUpload'
                ? { fileID: 'avatar:' + pictureName }
                : action === 'snapshot'
                  ? { home: { babies: [], members: [] } }
                  : { member: true, ownerConfigured: true };
        return { statusCode: 200, data: { ok: true, data } };
      },
    },
  };
  platform.request = (options) =>
    platform.cloud
      .callContainer({ ...options, path: options.url.replace('https://api.example.test', '') })
      .then(options.success, options.fail);
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../miniprogram/utils/client.js'), 'utf8'),
    {
      module,
      wx: platform,
      console: {
        log: (...args) => logs.push(args),
        warn: (...args) => logs.push(args),
        error: (...args) => logs.push(args),
      },
      require(name) {
        if (name === '../config')
          return {
            cloudRunEnvId: 'isolated-test',
            cloudRunService: 'family-care',
            ...configOverride,
          };
        if (name === './transport') return { createTransport };
        if (name === './avatar-cache') return { createAvatarCache };
        return require('../miniprogram/utils/' + name.slice(2));
      },
    }
  );
  return {
    api: module.exports,
    calls,
    files,
    writes,
    logs,
    state,
    platform,
    navigation,
    wechatLogins: () => wechatLogins,
  };
}

test('审核账号失败不切换会话、不借正式微信登录，凭据不存储或写日志', async () => {
  const f = fixture();
  await assert.rejects(
    f.api.loginReview({ username: 'reviewer', password: 'wrong-password' }),
    /审核账号|口令/
  );
  assert.equal(f.api.isReviewMode(), false);
  assert.equal(f.wechatLogins(), 0);
  assert.deepEqual(
    f.calls.map((call) => call.path),
    ['/review/api/login']
  );
  assert.equal(f.calls[0].header.Authorization, undefined);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.logs, []);
});

test('审核成功只使用隔离路由和令牌，正式及审核token不交叉，退出必须重新微信登录', async () => {
  const f = fixture();
  await f.api.call('bootstrap');
  await f.api.loginReview({ username: 'reviewer', password: 'test-password' });
  assert.equal(f.api.isReviewMode(), true);
  await f.api.call('bootstrap');
  const reviewed = f.calls.find((call) => call.path === '/review/api/call');
  assert.equal(reviewed.header.Authorization, 'Bearer ' + reviewToken);
  assert.equal(
    f.calls.find((call) => call.path === '/review/api/login').header.Authorization,
    undefined
  );
  f.api.exitReview();
  assert.equal(f.api.isReviewMode(), false);
  await f.api.call('bootstrap');
  assert.equal(f.wechatLogins(), 2);
  assert.equal(f.calls.at(-1).path, '/api/call');
  assert.equal(f.calls.at(-1).header.Authorization, 'Bearer ' + familyToken);
  assert.ok(
    f.calls
      .filter((call) => call.data?.action)
      .every((call) => !('username' in call.data) && !('password' in call.data))
  );
});

test('审核401或门禁403只使审核会话失效，绝不自动调用wx.login或正式家庭接口', async () => {
  for (const status of [401, 403]) {
    const f = fixture();
    await f.api.loginReview({ username: 'reviewer', password: 'test-password' });
    f.state.reviewStatus = status;
    await assert.rejects(
      f.api.call('snapshot'),
      (error) => error.code === 'REVIEW_SESSION_EXPIRED' && /审核/.test(error.message)
    );
    assert.equal(f.api.isReviewMode(), true);
    assert.equal(f.api.hasReviewSession(), false);
    const count = f.calls.length;
    await assert.rejects(f.api.call('bootstrap'), /审核/);
    assert.equal(f.calls.length, count);
    assert.equal(f.wechatLogins(), 0);
    assert.ok(f.calls.every((call) => call.path.startsWith('/review/')));
  }
});

test('审核禁止邀请等普通权限403保留审核身份，只显示该操作的真实拒绝说明', async () => {
  const f = fixture();
  await f.api.loginReview({ username: 'reviewer', password: 'test-password' });
  f.state.handler = (options) =>
    options.data?.action === 'makeInvite'
      ? { statusCode: 403, data: { ok: false, message: '审核环境不允许发送真实邀请' } }
      : undefined;
  await assert.rejects(f.api.call('makeInvite'), /审核环境不允许发送真实邀请/);
  assert.equal(f.api.hasReviewSession(), true);
  await f.api.call('bootstrap');
  assert.equal(f.calls.at(-1).header.Authorization, 'Bearer ' + reviewToken);
  assert.equal(f.wechatLogins(), 0);
});

test('审核快照中的家人头像也在隔离缓存下载，主页面不再额外请求正式图片', async () => {
  const f = fixture();
  await f.api.loginReview({ username: 'reviewer', password: 'test-password' });
  f.state.handler = (options) =>
    options.data?.action === 'snapshot'
      ? {
          statusCode: 200,
          data: {
            ok: true,
            data: { home: { babies: [], members: [{ id: 'member', avatarUrl: reviewPicture }] } },
          },
        }
      : undefined;
  const snapshot = await f.api.call('snapshot');
  assert.match(snapshot.home.members[0].avatarUrl, /^\/private\/care-private-review-/);
  assert.equal(f.calls.at(-1).path, reviewPicture);
});

test('正式与审核图片路径及沙盒缓存隔离，退出清图且旧图片请求不能回写', async () => {
  const f = fixture();
  const normal = await f.api.loadPrivateImage(familyPicture);
  assert.equal(f.files.get(normal).at(-1), 1);
  await f.api.loginReview({ username: 'reviewer', password: 'test-password' });
  assert.equal(f.files.has(normal), false);
  await assert.rejects(f.api.loadPrivateImage(familyPicture), /审核|图片地址/);
  const reviewed = await f.api.loadPrivateImage(reviewPicture);
  assert.notEqual(reviewed, normal);
  assert.equal(f.files.get(reviewed).at(-1), 2);
  assert.equal(f.calls.at(-1).path, reviewPicture);
  assert.equal(f.calls.at(-1).header.Authorization, undefined);
  let release;
  f.state.imageWait = new Promise((resolve) => {
    release = resolve;
  });
  const pending = f.api.loadPrivateImage(
    reviewPicture.replace(pictureName, 'd'.repeat(32) + '.png')
  );
  await new Promise(setImmediate);
  f.api.exitReview();
  release();
  await assert.rejects(pending, /会话|审核|已结束/);
  assert.equal(f.files.size, 0);
});

test('自有HTTPS入口也拒绝跨模式图片，审核会话过期后不能沿用旧短链', async () => {
  const f = fixture({
    cloudRunEnvId: '',
    cloudRunService: '',
    apiBaseUrl: 'https://api.example.test',
  });
  await assert.rejects(
    f.api.loadPrivateImage('https://api.example.test' + reviewPicture),
    /审核|会话/
  );
  await f.api.loginReview({ username: 'reviewer', password: 'test-password' });
  await assert.rejects(
    f.api.loadPrivateImage('https://api.example.test' + familyPicture),
    /审核|图片地址/
  );
  await assert.rejects(
    f.api.loadPrivateImages(['https://api.example.test' + familyPicture]),
    /审核|图片地址/
  );
  f.state.reviewStatus = 401;
  await assert.rejects(f.api.call('bootstrap'), /审核/);
  await assert.rejects(
    f.api.loadPrivateImages(['https://api.example.test' + reviewPicture]),
    /审核/
  );
});

test('审核成员头像10MiB走214片且仅传memberId白名单，分片请求从不复用正式身份', async () => {
  const f = fixture();
  await f.api.loginReview({ username: 'reviewer', password: 'test-password' });
  const base64 = Buffer.alloc(10 * 1024 * 1024, 1).toString('base64');
  const result = await f.api.call('uploadMemberAvatar', {
    memberId: 'member-id',
    base64,
    owner: true,
    password: 'must-not-forward',
  });
  assert.equal(result.fileID, 'avatar:' + pictureName);
  const init = f.calls.find((call) => call.data?.action === 'initImageUpload');
  assert.equal(init.data.data.action, 'uploadMemberAvatar');
  assert.equal(init.data.data.totalParts, 214);
  assert.deepEqual(Object.keys(init.data.data.metadata), ['memberId']);
  assert.equal(init.data.data.metadata.memberId, 'member-id');
  const parts = f.calls.filter((call) => call.data?.action === 'appendImageChunk');
  assert.equal(parts.length, 214);
  assert.ok(
    parts.every(
      (call) =>
        call.path === '/review/api/call' && call.header.Authorization === 'Bearer ' + reviewToken
    )
  );
  assert.equal(f.calls.at(-1).timeout, 60000);
  assert.equal(f.wechatLogins(), 0);
});

test('退出后晚到的审核登录响应不能重新启用审核身份', async () => {
  const f = fixture();
  let complete;
  f.state.handler = (options) =>
    options.path === '/review/api/login'
      ? new Promise((resolve) => {
          complete = resolve;
        })
      : undefined;
  const pending = f.api.loginReview({ username: 'reviewer', password: 'test-password' });
  await new Promise(setImmediate);
  f.api.exitReview();
  complete({ statusCode: 200, data: { ok: true, data: { token: reviewToken } } });
  await assert.rejects(pending, /会话|取消|重新/);
  assert.equal(f.api.isReviewMode(), false);
});

test('晚到的正式登录不会覆盖已成功切换的审核token', async () => {
  const f = fixture();
  let complete;
  f.state.handler = (options) =>
    options.path === '/api/login'
      ? new Promise((resolve) => {
          complete = resolve;
        })
      : undefined;
  const pending = f.api.call('bootstrap');
  await new Promise(setImmediate);
  await f.api.loginReview({ username: 'reviewer', password: 'test-password' });
  complete({ statusCode: 200, data: { ok: true, data: { token: familyToken } } });
  await assert.rejects(pending, /会话|切换|重新/);
  await f.api.call('bootstrap');
  assert.equal(f.calls.at(-1).header.Authorization, 'Bearer ' + reviewToken);
});

test('审核页面忽略query身份并只在密码登录成功后跳转，取消与退出清空输入', async () => {
  const f = fixture(),
    pageModule = { exports: {} };
  let definition;
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../miniprogram/pages/review/index.js'), 'utf8'),
    {
      module: pageModule,
      Page: (page) => {
        definition = page;
      },
      wx: f.platform,
      require: () => f.api,
    }
  );
  const page = {
    ...definition,
    data: structuredClone(definition.data),
    setData(update) {
      Object.assign(this.data, update);
    },
  };
  page.onLoad({
    review: 'true',
    token: reviewToken,
    username: 'reviewer',
    password: 'test-password',
  });
  assert.equal(f.calls.length, 0);
  assert.equal(f.api.isReviewMode(), false);
  assert.equal(page.data.username, '');
  assert.equal(page.data.password, '');
  page.onUsernameInput({ detail: { value: 'reviewer' } });
  page.onPasswordInput({ detail: { value: 'wrong-password' } });
  await page.submitReviewLogin();
  assert.equal(f.navigation.length, 0);
  assert.equal(page.data.password, '');
  assert.match(page.data.error, /审核账号|口令/);
  page.onPasswordInput({ detail: { value: 'test-password' } });
  await page.submitReviewLogin();
  assert.equal(f.navigation.at(-1), '/pages/index/index');
  assert.equal(page.data.password, '');
  assert.equal(page.data.username, '');
  page.returnToFamily();
  assert.equal(f.api.isReviewMode(), false);
  assert.equal(f.navigation.at(-1), '/pages/index/index');
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.logs, []);
});

test('退出前停止埋点能撤销已排入发送微任务的审核事件，之后不得用正式身份补发', async () => {
  const f = fixture();
  const { createActivityLogger } = require('../miniprogram/utils/activity-client');
  await f.api.loginReview({ username: 'reviewer', password: 'test-password' });
  const logger = createActivityLogger(
    (data) => f.api.call('recordActivity', data),
    () => true
  );
  for (let index = 0; index < 20; index++)
    logger.record({ kind: 'click', name: 'toggle', view: 'today' });
  logger.stop();
  f.api.exitReview();
  await new Promise(setImmediate);
  assert.equal(f.calls.filter((call) => call.data?.action === 'recordActivity').length, 0);
  assert.equal(f.wechatLogins(), 0);
  logger.record({ kind: 'click', name: 'toggle', view: 'today' });
  await logger.flush();
  assert.equal(f.calls.filter((call) => call.data?.action === 'recordActivity').length, 0);
});

test('主页面退出及审核过期先停埋点，再清空任务消息、照片草稿、邀请和私有表单', async () => {
  const f = fixture(),
    module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(
      path.join(__dirname, '../miniprogram/pages/index/controllers/review.js'),
      'utf8'
    ),
    {
      module,
      wx: f.platform,
      clearInterval,
      require(name) {
        return name.endsWith('/client') ? f.api : require('../miniprogram/utils/forms');
      },
    }
  );
  const controller = module.exports;
  for (const expired of [false, true]) {
    await f.api.loginReview({ username: 'reviewer', password: 'test-password' });
    let stoppedWhileReview = false;
    const page = {
      ...controller,
      _snapshot: { private: true },
      _sharedTask: { private: true },
      _activity: {
        stop() {
          stoppedWhileReview = f.api.isReviewMode();
        },
      },
      data: {
        busy: false,
        cloudAvailable: true,
        rows: ['private'],
        babies: ['private'],
        members: ['private'],
        taskList: ['private'],
        messages: ['private'],
        wallDraft: { photos: ['private'] },
        modal: 'member-avatar',
        token: 'private',
        inviteToken: 'private',
        birthdayForm: { private: true },
        babyForm: { name: 'private' },
        wallComposerOpen: true,
      },
      setData(update) {
        Object.assign(this.data, update);
      },
      cancelWallCovers() {},
    };
    if (expired)
      assert.equal(page.handleReviewSessionError({ code: 'REVIEW_SESSION_EXPIRED' }), true);
    else page.exitReview();
    assert.equal(stoppedWhileReview, true);
    assert.equal(page.data.cloudAvailable, false);
    assert.equal(page._snapshot, null);
    assert.equal(page.data.taskList.length, 0);
    assert.equal(page.data.messages.length, 0);
    assert.equal(page.data.wallDraft.photos.length, 0);
    assert.equal(page.data.wallComposerOpen, false);
    assert.equal(page.data.modal, '');
    assert.equal(page.data.token, '');
    assert.equal(page.data.inviteToken, '');
    assert.equal(page.data.babyForm.name, '');
    assert.equal(Object.keys(page.data.birthdayForm).length, 0);
    assert.equal(f.navigation.at(-1), expired ? '/pages/review/index' : '/pages/index/index');
  }
});
