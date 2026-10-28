const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { createSQLiteRepository } = require('../selfhost/sqlite-repository.cjs');
const { createHttpApplication } = require('../selfhost/app.cjs');
const d = require('../miniprogram/utils/domain');
const { MAX_IMAGE_BYTES } = require('../miniprogram/utils/media-policy');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const uid = (value) => hash(value).slice(0, 32);
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);

async function fixture(t) {
  const repo = createSQLiteRepository(':memory:');
  const date = d.chinaDate(new Date().toISOString());
  const home = d.createHome(uid('owner'), '妈妈', date);
  home.members.push({ id: uid('member'), name: '爸爸', active: true });
  home.tasks.push({
    id: 'task1',
    scope: 'family',
    pinned: false,
    versions: [
      {
        effectiveDate: date,
        startDate: date,
        title: '整理用品',
        assigneeId: uid('member'),
        notifyMemberId: uid('member'),
        frequency: 'daily',
        executionTime: '',
        weekdays: [],
        interval: 1,
      },
    ],
  });
  await repo.put('care_home', 'home', home);
  const app = createHttpApplication({
    repo,
    config: {
      dataDir: path.join(os.tmpdir(), 'unused-completion-photos'),
      avatarStorage: 'database',
      signingSecret: 's'.repeat(64),
      publicOrigin: '',
      fields: {},
    },
    wechat: {
      exchangeCode: async (code) => ({ openid: code }),
      sendMessage: async () => {
        throw new Error('测试不允许发送微信消息');
      },
    },
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await app.close();
    await repo.close();
  });
  async function login(code) {
    const response = await fetch(origin + '/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    return (await response.json()).data.token;
  }
  async function call(action, data, token) {
    const response = await fetch(origin + '/api/call', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ action, data }),
    });
    return { status: response.status, ...(await response.json()) };
  }
  return { repo, date, home, origin, login, call };
}

test('家庭成员可上传当天待完成事项照片，文件私有且绑定实际上传人和任务日期', async (t) => {
  const f = await fixture(t),
    token = await f.login('member');
  const uploaded = await f.call(
    'uploadCompletionPhoto',
    {
      taskId: 'task1',
      date: f.date,
      base64: png.toString('base64'),
      uploadedBy: uid('owner'),
    },
    token
  );
  assert.equal(uploaded.ok, true);
  assert.match(uploaded.data.photoId, /^photo:[a-f0-9]{32}\.png$/);
  const file = await f.repo.get('care_files', hash(uploaded.data.photoId));
  assert.equal(file.kind, 'completion');
  assert.equal(file.fileID, uploaded.data.photoId);
  assert.equal(file.ownerId, uid('owner'));
  assert.equal(file.uploadedBy, uid('member'));
  assert.equal(file.taskId, 'task1');
  assert.equal(file.date, f.date);
  assert.deepEqual(
    Buffer.from(
      (await f.repo.get('care_avatar_blobs', uploaded.data.photoId.slice(6))).base64,
      'base64'
    ),
    png
  );
  assert.equal(
    (await fetch(f.origin + '/api/avatar/' + uploaded.data.photoId.slice(6))).status,
    403
  );
  assert.equal(await f.repo.get('care_days', f.date), null);
});

function photoController(platform, call, loadPrivateImage = async (url) => url) {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(
      path.join(__dirname, '../miniprogram/pages/index/controllers/completion-photos.js'),
      'utf8'
    ),
    {
      module,
      wx: platform,
      require: (name) =>
        name.endsWith('/media-policy') ? { MAX_IMAGE_BYTES } : { call, loadPrivateImage },
    }
  );
  const page = {
    data: { date: '2026-10-28', busy: false },
    setData(value) {
      Object.assign(this.data, value);
    },
    run() {
      throw new Error('照片选择不得提交完成状态');
    },
  };
  return { controller: module.exports, page };
}

test('选择照片只上传所选图片并返回photoId，不触发完成；预览使用已授权图片地址', async () => {
  const uploads = [],
    selections = [],
    previews = [];
  const { controller, page } = photoController(
    {
      chooseMedia: async (options) => {
        selections.push(options);
        return { tempFiles: [{ size: 9, tempFilePath: '/selected.png' }] };
      },
      getFileSystemManager: () => ({
        readFileSync: (file, encoding) => {
          assert.equal(file, '/selected.png');
          assert.equal(encoding, 'base64');
          return png.toString('base64');
        },
      }),
      previewImage: (options) => previews.push(options),
    },
    async (action, data) => {
      uploads.push({ action, data });
      return { photoId: 'photo:' + 'a'.repeat(32) + '.png' };
    }
  );
  assert.equal(
    await controller.chooseCompletionPhoto.call(page, { id: 'task1' }),
    'photo:' + 'a'.repeat(32) + '.png'
  );
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].action, 'uploadCompletionPhoto');
  assert.equal(uploads[0].data.taskId, 'task1');
  assert.equal(uploads[0].data.date, '2026-10-28');
  assert.equal(uploads[0].data.base64, png.toString('base64'));
  assert.equal(Array.from(selections[0].sourceType).join(','), 'camera,album');
  assert.equal(selections[0].sizeType[0], 'compressed');
  assert.equal(page.data.busy, false);
  await controller.previewCompletionPhoto({
    currentTarget: { dataset: { url: '/authorized-local.png' } },
  });
  assert.equal(previews[0].current, '/authorized-local.png');
  assert.equal(previews[0].urls[0], '/authorized-local.png');
});

test('历史照片按需接口支持500条之前的执行事件，拒绝无关联与外部成员读取', async (t) => {
  const f = await fixture(t),
    token = await f.login('member');
  const uploaded = await f.call(
    'uploadCompletionPhoto',
    { taskId: 'task1', date: f.date, base64: png.toString('base64') },
    token
  );
  const photoId = uploaded.data.photoId;
  const events = [
    { taskId: 'task1', photoId },
    ...Array.from({ length: 500 }, () => ({ taskId: 'task1', type: 'undo' })),
  ];
  await f.repo.put('care_days', f.date, { date: f.date, records: {}, events });
  const data = { photoId, taskId: 'task1', date: f.date };
  const response = await f.call('completionPhoto', data, token);
  assert.equal(response.ok, true);
  assert.match(response.data.photoUrl, /^\/api\/avatar\//);
  assert.equal((await fetch(f.origin + response.data.photoUrl)).status, 200);
  assert.equal((await f.call('completionPhoto', data, await f.login('outsider'))).ok, false);
  assert.equal((await f.call('completionPhoto', { ...data, taskId: 'other' }, token)).ok, false);
  assert.equal(
    (await f.call('completionPhoto', { ...data, date: d.addDays(f.date, 1) }, token)).ok,
    false
  );
  const metadata = await f.repo.get('care_files', hash(photoId));
  for (const change of [
    { kind: 'avatar' },
    { ownerId: 'other-home' },
    { taskId: 'other-task' },
    { date: d.addDays(f.date, -1) },
  ]) {
    await f.repo.put('care_files', hash(photoId), { ...metadata, ...change });
    assert.equal((await f.call('completionPhoto', data, token)).ok, false);
  }
  await f.repo.put('care_days', f.date, { date: f.date, records: {}, events: [] });
  assert.equal((await f.call('completionPhoto', data, token)).ok, false);
});

test('点击历史照片先申请授权短链再下载本机预览，下载失败给出说明且不打开空预览', async () => {
  const calls = [],
    previews = [],
    toasts = [],
    loaded = [];
  const { controller, page } = photoController(
    {
      previewImage: (options) => previews.push(options),
      showToast: (options) => toasts.push(options.title),
    },
    async (action, data) => {
      calls.push({ action, data });
      return { photoUrl: '/signed-photo' };
    },
    async (url) => {
      loaded.push(url);
      if (url === '/failed') throw new Error('照片暂时加载失败，请重试');
      return '/private-local.png';
    }
  );
  await controller.previewCompletionPhoto.call(page, {
    currentTarget: { dataset: { photoId: 'photo:id', taskId: 'task1', date: '2026-10-28' } },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'completionPhoto');
  assert.equal(calls[0].data.photoId, 'photo:id');
  assert.equal(calls[0].data.taskId, 'task1');
  assert.equal(calls[0].data.date, '2026-10-28');
  assert.equal(loaded[0], '/signed-photo');
  assert.equal(previews[0].current, '/private-local.png');
  await controller.previewCompletionPhoto.call(page, {
    currentTarget: { dataset: { url: '/failed' } },
  });
  assert.equal(previews.length, 1);
  assert.deepEqual(toasts, ['照片暂时加载失败，请重试']);
});

test('取消选图、图片过大和上传失败均不返回可完成的照片，失败仍显示说明', async () => {
  const toasts = [];
  for (const failure of ['cancel', 'size', 'upload']) {
    let uploaded = false;
    const { controller, page } = photoController(
      {
        chooseMedia: async () => {
          if (failure === 'cancel') throw { errMsg: 'chooseMedia:fail cancel' };
          return {
            tempFiles: [
              { size: failure === 'size' ? MAX_IMAGE_BYTES + 1 : 9, tempFilePath: '/selected.png' },
            ],
          };
        },
        getFileSystemManager: () => ({ readFileSync: () => png.toString('base64') }),
        showToast: (options) => toasts.push(options.title),
      },
      async () => {
        uploaded = true;
        throw new Error('照片上传失败');
      }
    );
    assert.equal(await controller.chooseCompletionPhoto.call(page, { id: 'task1' }), null);
    assert.equal(page.data.busy, false);
    assert.equal(uploaded, failure === 'upload');
  }
  assert.equal(toasts.length, 2);
  assert.match(toasts[0], /10MB/);
  assert.equal(toasts[1], '照片上传失败');
});

test('上传照片拒绝未入家或移除成员、非当天、非应做及已完成事项', async (t) => {
  const f = await fixture(t),
    token = await f.login('member');
  const data = { taskId: 'task1', date: f.date, base64: png.toString('base64') };
  assert.equal((await f.call('uploadCompletionPhoto', data, await f.login('outsider'))).ok, false);
  assert.equal(
    (await f.call('uploadCompletionPhoto', { ...data, date: d.addDays(f.date, -1) }, token)).ok,
    false
  );
  assert.equal(
    (await f.call('uploadCompletionPhoto', { ...data, taskId: 'missing' }, token)).ok,
    false
  );
  await f.repo.put('care_days', f.date, {
    date: f.date,
    records: { task1: { done: true, revision: 1 } },
    events: [],
  });
  assert.equal((await f.call('uploadCompletionPhoto', data, token)).ok, false);
  f.home.members[1].active = false;
  await f.repo.put('care_home', 'home', f.home);
  assert.equal((await f.call('uploadCompletionPhoto', data, token)).ok, false);
  assert.equal((await f.repo.list('care_files', {}, 10)).length, 0);
});

test('照片只接收最多10MB的JPEG或PNG，保留1MiB回归并拒绝畸形编码和伪造类型', async (t) => {
  const f = await fixture(t),
    token = await f.login('member');
  const oversized = Buffer.alloc(MAX_IMAGE_BYTES + 1);
  png.copy(oversized);
  for (const base64 of [
    '%%%bad',
    Buffer.from('not-image').toString('base64'),
    oversized.toString('base64'),
  ]) {
    const response = await f.call(
      'uploadCompletionPhoto',
      { taskId: 'task1', date: f.date, base64 },
      token
    );
    assert.equal(response.ok, false);
  }
  const jpeg = Buffer.alloc(1024 * 1024);
  Buffer.from([255, 216, 255]).copy(jpeg);
  const uploaded = await f.call(
    'uploadCompletionPhoto',
    { taskId: 'task1', date: f.date, base64: jpeg.toString('base64') },
    token
  );
  assert.equal(uploaded.ok, true);
  assert.match(uploaded.data.photoId, /\.jpg$/);
});

test('完成照片选择允许超过旧1MiB限制直到10MiB，不擅自提交完成动作', async () => {
  for (const size of [1024 * 1024 + 1, MAX_IMAGE_BYTES]) {
    const calls = [],
      toasts = [];
    const { controller, page } = photoController(
      {
        chooseMedia: async () => ({ tempFiles: [{ size, tempFilePath: '/selected.png' }] }),
        getFileSystemManager: () => ({ readFileSync: () => png.toString('base64') }),
        showToast: (options) => toasts.push(options.title),
      },
      async (action, data) => {
        calls.push({ action, data });
        return { photoId: 'photo:chosen' };
      }
    );
    assert.equal(
      await controller.chooseCompletionPhoto.call(page, { id: 'task1' }),
      'photo:chosen'
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, 'uploadCompletionPhoto');
    assert.equal(calls[0].data.taskId, 'task1');
    assert.equal(page.data.busy, false);
    assert.deepEqual(toasts, []);
  }
});

test('快照只为本家庭对应任务日期的照片生成短链，保留全部历史并限制签名数量', async (t) => {
  const f = await fixture(t),
    token = await f.login('member');
  const uploaded = await f.call(
    'uploadCompletionPhoto',
    { taskId: 'task1', date: f.date, base64: png.toString('base64') },
    token
  );
  assert.equal(uploaded.ok, true);
  const photoId = uploaded.data.photoId;
  const events = Array.from({ length: 501 }, (_, index) => ({
    id: `event${index}`,
    taskId: 'task1',
    photoId,
    type: 'complete',
  }));
  await f.repo.put('care_days', f.date, {
    date: f.date,
    records: { task1: { done: true, photoId } },
    events,
  });
  const snapshot = await f.call('snapshot', { date: f.date }, token);
  const day = snapshot.data.day;
  assert.equal(day.events.length, 501);
  assert.equal(day.events[0].photoUrl, '');
  assert.equal(day.events[500].photoUrl, day.records.task1.photoUrl);
  assert.match(day.records.task1.photoUrl, /^\/api\/avatar\/[a-f0-9]{32}\.png\?expires=/);
  const response = await fetch(f.origin + day.records.task1.photoUrl);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
  assert.equal(
    (await f.call('snapshot', { date: f.date }, await f.login('outsider'))).data,
    undefined
  );
  const metadata = await f.repo.get('care_files', hash(photoId));
  for (const change of [
    { kind: 'avatar' },
    { ownerId: 'other' },
    { taskId: 'other' },
    { date: d.addDays(f.date, -1) },
  ]) {
    await f.repo.put('care_files', hash(photoId), { ...metadata, ...change });
    const forbidden = await f.call('snapshot', { date: f.date }, token);
    assert.equal(forbidden.data.day.records.task1.photoUrl, '');
    assert.equal(forbidden.data.day.events[500].photoUrl, '');
  }
});

test('备选云函数上传使用可信微信身份，家庭快照才把私有照片解析为短链', async (t) => {
  const f = await fixture(t);
  const { createService } = require('../server/service.cjs');
  const service = createService(f.repo, {
    ownerOpenId: 'owner',
    templateId: '',
    now: () => new Date().toISOString(),
    randomId: () => crypto.randomBytes(16).toString('hex'),
    hash,
    sendMessage: async () => {
      throw new Error('测试不得发送微信消息');
    },
  });
  let openid = 'member';
  const stored = new Map(),
    signed = [];
  const cloud = {
    DYNAMIC_CURRENT_ENV: 'test',
    init() {},
    getWXContext: () => ({ OPENID: openid }),
    uploadFile: async ({ cloudPath, fileContent }) => {
      const fileID = 'cloud://private/' + cloudPath;
      stored.set(fileID, fileContent);
      return { fileID };
    },
    getTempFileURL: async ({ fileList }) => {
      assert.ok(fileList.length <= 50);
      signed.push(...fileList);
      return {
        fileList: fileList.map(({ fileID }) => ({
          fileID,
          status: 0,
          tempFileURL: 'https://private.test/signed/' + encodeURIComponent(fileID),
        })),
      };
    },
  };
  const fs = require('node:fs'),
    vm = require('node:vm'),
    exports = {};
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '../cloudfunctions/family/index.js'), 'utf8'),
    {
      exports,
      Buffer,
      console,
      require(name) {
        if (name === 'wx-server-sdk') return cloud;
        if (name === './lib/cloud.cjs') return { runtime: () => ({ service, repo: f.repo, hash }) };
        if (name === './lib/domain') return d;
        return require(name);
      },
    }
  );
  const uploaded = await exports.main({
    action: 'uploadCompletionPhoto',
    data: {
      taskId: 'task1',
      date: f.date,
      base64: png.toString('base64'),
      openid: 'owner',
    },
  });
  assert.equal(uploaded.ok, true);
  assert.match(uploaded.data.photoId, /^photo:[a-f0-9]{32}\.png$/);
  const metadata = await f.repo.get('care_files', hash(uploaded.data.photoId));
  assert.equal(metadata.uploadedBy, uid('member'));
  assert.equal(metadata.fileID, uploaded.data.photoId);
  assert.deepEqual(stored.get(metadata.cloudFileID), png);
  await f.repo.put('care_days', f.date, {
    date: f.date,
    records: { task1: { done: true, photoId: uploaded.data.photoId } },
    events: [{ taskId: 'task1', type: 'complete', photoId: uploaded.data.photoId }],
  });
  const snapshot = await exports.main({ action: 'snapshot', data: { date: f.date } });
  assert.equal(snapshot.ok, true);
  assert.match(snapshot.data.day.records.task1.photoUrl, /^https:\/\/private\.test\/signed\//);
  assert.equal(snapshot.data.day.events[0].photoUrl, snapshot.data.day.records.task1.photoUrl);
  assert.equal(signed.length, 1);
  await f.repo.put('care_days', f.date, {
    date: f.date,
    records: {},
    events: [
      { taskId: 'task1', photoId: uploaded.data.photoId },
      ...Array.from({ length: 500 }, () => ({ taskId: 'task1', type: 'undo' })),
    ],
  });
  const historical = await exports.main({
    action: 'completionPhoto',
    data: { photoId: uploaded.data.photoId, taskId: 'task1', date: f.date },
  });
  assert.equal(historical.ok, true);
  assert.match(historical.data.photoUrl, /^https:\/\/private\.test\/signed\//);
  assert.equal(
    (
      await exports.main({
        action: 'completionPhoto',
        data: { photoId: uploaded.data.photoId, taskId: 'other', date: f.date },
      })
    ).ok,
    false
  );
  assert.equal(signed.length, 2);
  openid = 'outsider';
  assert.equal((await exports.main({ action: 'snapshot', data: { date: f.date } })).ok, false);
  assert.equal(
    (
      await exports.main({
        action: 'completionPhoto',
        data: { photoId: uploaded.data.photoId, taskId: 'task1', date: f.date },
      })
    ).ok,
    false
  );
  assert.equal(signed.length, 2);
});
