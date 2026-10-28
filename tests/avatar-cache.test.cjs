const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAvatarCache } = require('../miniprogram/utils/avatar-cache');

test('云托管头像按响应上限分段读取并写成真实本机图片，相同头像不重复下载', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'care-avatar-test-'));
  t.after(() => {
    if (!directory.startsWith(path.join(os.tmpdir(), 'care-avatar-test-')))
      throw new Error('测试目录越界');
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const platform = {
    env: { USER_DATA_PATH: directory },
    getFileSystemManager: () => ({
      readdirSync: fs.readdirSync,
      unlinkSync: fs.unlinkSync,
      writeFile: (options) =>
        fs.writeFile(options.filePath, Buffer.from(options.data), (error) =>
          error ? options.fail(error) : options.success()
        ),
    }),
  };
  const original = Buffer.alloc(1024 * 1024, 9);
  const ranges = [];
  const request = async (_route, _data, _token, options) => {
    ranges.push(options.header.Range);
    const first = options.header.Range === 'bytes=0-524287';
    const start = first ? 0 : 524288,
      end = first ? 524287 : 1048575;
    return {
      statusCode: 206,
      header: { 'Content-Range': `bytes ${start}-${end}/1048576` },
      data: Uint8Array.from(original.subarray(start, end + 1)).buffer,
    };
  };
  const load = createAvatarCache(request, platform);
  const route = '/api/avatar/' + 'a'.repeat(32) + '.png?expires=1&signature=' + 'b'.repeat(64);
  const filename = await load(route);
  assert.deepEqual(fs.readFileSync(filename), original);
  assert.equal(await load(route), filename);
  assert.deepEqual(ranges, ['bytes=0-524287', 'bytes=524288-1048575']);
  await assert.rejects(load('https://untrusted.example/avatar.png'), /图片地址/);
});

test('拒绝错误分段长度，不把截断头像写入小程序私有目录', async () => {
  const platform = {
    env: { USER_DATA_PATH: '/unused' },
    getFileSystemManager: () => ({
      readdirSync: () => [],
      writeFile: () => {
        throw new Error('should not write truncated image');
      },
    }),
  };
  const load = createAvatarCache(
    async () => ({
      statusCode: 206,
      header: { 'content-range': 'bytes 0-524287/1048576' },
      data: new ArrayBuffer(10),
    }),
    platform
  );
  await assert.rejects(load('/api/avatar/' + 'a'.repeat(32) + '.jpg?expires=1'), /完整/);
});

function avatarRoute(id) {
  return '/api/avatar/' + id.toString(16).padStart(32, '0') + '.jpg?expires=1';
}

function mockCache(beforeResponse = async () => {}) {
  const files = new Map([['/sandbox/unrelated.txt', Buffer.from('keep')]]);
  const calls = new Map();
  let maximumFiles = 0;
  const platform = {
    env: { USER_DATA_PATH: '/sandbox' },
    getFileSystemManager: () => ({
      readdirSync: () => [...files.keys()].map((name) => name.slice('/sandbox/'.length)),
      unlinkSync: (name) => {
        assert.match(name, /^\/sandbox\/care-private-avatar-[a-f0-9]{32}\.(png|jpg)$/);
        files.delete(name);
      },
      writeFile: ({ filePath, data, success }) => {
        files.set(filePath, Buffer.from(data));
        maximumFiles = Math.max(maximumFiles, files.size - 1);
        success();
      },
    }),
  };
  const request = async (route) => {
    calls.set(route, (calls.get(route) || 0) + 1);
    await beforeResponse(route);
    return {
      statusCode: 206,
      header: { 'Content-Range': 'bytes 0-3/4' },
      data: new Uint8Array([1, 2, 3, 4]).buffer,
    };
  };
  return {
    load: createAvatarCache(request, platform),
    files,
    calls,
    maximumFiles: () => maximumFiles,
  };
}

test('缓存命中更新LRU顺序，新增头像淘汰真正最久未用的文件', async () => {
  const { load, files, calls } = mockCache();
  const first = await load(avatarRoute(0));
  const second = await load(avatarRoute(1));
  for (let id = 2; id < 20; id++) await load(avatarRoute(id));
  assert.equal(await load(avatarRoute(0)), first);
  await load(avatarRoute(20));
  assert.ok(files.has(first));
  assert.equal(files.has(second), false);
  assert.equal(calls.get(avatarRoute(0)), 1);
});

test('20张封面缓存后预览命中首图与8张新图，并发更多封面不删除当前9张预览', async () => {
  const { load, files, maximumFiles } = mockCache();
  for (let id = 0; id < 20; id++) await load(avatarRoute(id));
  const routes = [0, ...Array.from({ length: 8 }, (_, index) => index + 20)].map(avatarRoute);
  load.pin(routes);
  const [preview] = await Promise.all([
    Promise.all(routes.map(load)),
    Promise.all(Array.from({ length: 40 }, (_, index) => load(avatarRoute(index + 28)))),
  ]);
  assert.equal(preview.length, 9);
  for (const filename of preview) assert.ok(files.has(filename), filename);
  assert.ok(maximumFiles() <= 20);
  assert.equal(files.size, 21);
  assert.ok(files.has('/sandbox/unrelated.txt'));
});

test('预览固定集合整批校验且原子替换，切换批次释放旧保护并保持20张预算', async () => {
  const { load, files, maximumFiles } = mockCache();
  load.pin([avatarRoute(0)]);
  const first = await load(avatarRoute(0));
  assert.throws(
    () => load.pin([avatarRoute(1), 'https://invalid.example/private.jpg']),
    /图片地址/
  );
  assert.throws(() => load.pin(Array.from({ length: 10 }, (_, index) => avatarRoute(index))), /9/);
  for (let id = 1; id < 40; id++) await load(avatarRoute(id));
  assert.ok(files.has(first), '错误批次不能部分覆盖原保护集合');
  const next = Array.from({ length: 9 }, (_, index) => avatarRoute(index + 100));
  load.pin(next);
  const paths = await Promise.all(next.map(load));
  for (let id = 40; id < 80; id++) await load(avatarRoute(id));
  assert.equal(files.has(first), false, '重选批次后旧预览可以被正常淘汰');
  for (const filename of paths) assert.ok(files.has(filename));
  assert.ok(maximumFiles() <= 20);
  load.pin([]);
  for (let id = 200; id < 230; id++) await load(avatarRoute(id));
  for (const filename of paths) assert.equal(files.has(filename), false);
  assert.equal(files.size, 21);
});

test('缓存淘汰不删除进行中条目，同一慢下载的并发调用始终复用一次请求', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { load, files, calls, maximumFiles } = mockCache(async (route) => {
    if (route === avatarRoute(0)) await gate;
  });
  const pending = load(avatarRoute(0));
  await Promise.all(Array.from({ length: 39 }, (_, index) => load(avatarRoute(index + 1))));
  const duplicate = load(avatarRoute(0));
  assert.equal(calls.get(avatarRoute(0)), 1);
  release();
  const [first, second] = await Promise.all([pending, duplicate]);
  assert.equal(first, second);
  assert.ok(files.has(first));
  assert.ok(maximumFiles() <= 20);
});

test('20个进行中下载占满预算后新任务等待，不扩大缓存或重复下载', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { load, calls, maximumFiles } = mockCache(() => gate);
  const pending = Array.from({ length: 40 }, (_, index) => load(avatarRoute(index)));
  await Promise.resolve();
  try {
    assert.equal(calls.size, 20);
  } finally {
    release();
    await Promise.all(pending);
  }
  assert.ok(maximumFiles() <= 20);
});
