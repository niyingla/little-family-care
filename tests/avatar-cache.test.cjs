const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createAvatarCache } = require('../miniprogram/utils/avatar-cache');
const { MAX_IMAGE_BYTES } = require('../miniprogram/utils/media-policy');

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

function realDownload(t, source, transform = (response) => response) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'care-avatar-test-'));
  t.after(() => {
    if (!directory.startsWith(path.join(os.tmpdir(), 'care-avatar-test-')))
      throw new Error('测试目录越界');
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const ranges = [];
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
  const request = async (_route, _data, _token, options) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(options.header.Range);
    const start = Number(match[1]),
      end = Math.min(Number(match[2]), source.length - 1);
    ranges.push({ start, end });
    assert.ok(end - start + 1 <= 512 * 1024, '单段不能突破云托管回包边界');
    return transform(
      {
        statusCode: 206,
        header: { 'Content-Range': `bytes ${start}-${end}/${source.length}` },
        data: Uint8Array.from(source.subarray(start, end + 1)).buffer,
      },
      ranges.length
    );
  };
  return { directory, ranges, load: createAvatarCache(request, platform) };
}

test('10MiB高熵图片按20段连续512KiB读取，真实落盘字节完全一致且命中不再下载', async (t) => {
  const source = crypto.randomBytes(MAX_IMAGE_BYTES);
  const { directory, ranges, load } = realDownload(t, source);
  const file = await load(avatarRoute(500));
  assert.equal(path.dirname(file), directory);
  assert.deepEqual(fs.readFileSync(file), source);
  assert.equal(ranges.length, 20);
  for (let index = 0; index < ranges.length; index++)
    assert.deepEqual(ranges[index], {
      start: index * 512 * 1024,
      end: (index + 1) * 512 * 1024 - 1,
    });
  assert.equal(await load(avatarRoute(500)), file);
  assert.equal(ranges.length, 20);
});

test('超出10MiB的总长度在首段拒绝，沙盒中不产生可被预览的文件', async (t) => {
  const { directory, ranges, load } = realDownload(t, Buffer.alloc(MAX_IMAGE_BYTES + 1));
  await assert.rejects(load(avatarRoute(501)), /完整/);
  assert.equal(ranges.length, 1);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('10MiB图片中间段总长度变化立即拒绝，不落盘也不再请求后续段', async (t) => {
  const source = Buffer.alloc(MAX_IMAGE_BYTES, 1);
  const { directory, ranges, load } = realDownload(t, source, (response, count) => {
    if (count === 2)
      response.header['Content-Range'] = response.header['Content-Range'].replace(
        '/' + MAX_IMAGE_BYTES,
        '/' + (MAX_IMAGE_BYTES - 1)
      );
    return response;
  });
  await assert.rejects(load(avatarRoute(502)), /完整/);
  assert.equal(ranges.length, 2);
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('中间段起点不连续时拒绝，不能拼接错位图片', async (t) => {
  const { directory, ranges, load } = realDownload(
    t,
    Buffer.alloc(MAX_IMAGE_BYTES),
    (response, count) => {
      if (count === 2) response.header['Content-Range'] = `bytes 524289-1048575/${MAX_IMAGE_BYTES}`;
      return response;
    }
  );
  await assert.rejects(load(avatarRoute(503)), /完整/);
  assert.equal(ranges.length, 2);
  assert.deepEqual(fs.readdirSync(directory), []);
});

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

test('头像选择允许10MiB边界，超出时在读取文件和上传之前拒绝', async () => {
  const vm = require('node:vm');
  for (const size of [1024 * 1024 + 1, MAX_IMAGE_BYTES, MAX_IMAGE_BYTES + 1]) {
    const module = { exports: {} },
      calls = [],
      toasts = [];
    let reads = 0;
    vm.runInNewContext(
      fs.readFileSync(
        path.join(__dirname, '../miniprogram/pages/index/controllers/family.js'),
        'utf8'
      ),
      {
        module,
        require: (name) =>
          name.endsWith('/media-policy')
            ? { MAX_IMAGE_BYTES }
            : {
                call: async (action, data) => {
                  calls.push({ action, data });
                  return { fileID: 'avatar:chosen' };
                },
              },
        wx: {
          chooseMedia: async () => ({ tempFiles: [{ size, tempFilePath: '/chosen.png' }] }),
          getFileSystemManager: () => ({
            readFileSync: () => {
              reads++;
              return 'test-base64';
            },
          }),
          showToast: (options) => toasts.push(options.title),
        },
      }
    );
    const page = {
      data: { demo: false, busy: false },
      setData(value) {
        Object.assign(this.data, value);
      },
    };
    await module.exports.chooseAvatar.call(page);
    assert.equal(calls.length, size <= MAX_IMAGE_BYTES ? 1 : 0);
    assert.equal(reads, size <= MAX_IMAGE_BYTES ? 1 : 0);
    if (calls.length) assert.equal(calls[0].action, 'uploadAvatar');
    else assert.match(toasts[0], /10MB/);
    assert.equal(page.data.busy, false);
  }
});

test('沙盒写入失败明确拒绝且释放缓存条目，重试成功后才返回本地路径', async () => {
  let writes = 0,
    requests = 0;
  const files = new Set();
  const load = createAvatarCache(
    async () => {
      requests++;
      return {
        statusCode: 206,
        header: { 'Content-Range': 'bytes 0-3/4' },
        data: new Uint8Array([1, 2, 3, 4]).buffer,
      };
    },
    {
      env: { USER_DATA_PATH: '/sandbox' },
      getFileSystemManager: () => ({
        readdirSync: () => [],
        writeFile: ({ filePath, success, fail }) => {
          if (++writes === 1) fail(new Error('沙盒空间不足'));
          else {
            files.add(filePath);
            success();
          }
        },
      }),
    }
  );
  await assert.rejects(load(avatarRoute(700)), /沙盒空间不足/);
  assert.equal(files.size, 0);
  const filename = await load(avatarRoute(700));
  assert.ok(files.has(filename));
  assert.equal(requests, 2);
});
