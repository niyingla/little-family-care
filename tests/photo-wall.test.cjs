const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { MAX_IMAGE_BYTES } = require('../miniprogram/utils/media-policy');
const { createPhotoWall, addCompletion } = require('../server/photo-wall.cjs');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const uid = (value) => hash(value).slice(0, 32);
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]).toString('base64');

function wallController(files, reply) {
  const filename = path.resolve(__dirname, '../miniprogram/pages/index/controllers/photo-wall.js');
  const localRequire = createRequire(filename),
    module = { exports: {} };
  const calls = [],
    selections = [],
    toasts = [];
  let reads = 0;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module,
    require: (name) =>
      name.endsWith('/client')
        ? {
            call: async (action, data) => {
              calls.push({ action, data });
              if (reply) return reply(action, data);
              return { photoId: `photo:${calls.length}` };
            },
          }
        : localRequire(name),
    wx: {
      chooseMedia: async (options) => {
        selections.push(options);
        return { tempFiles: files };
      },
      getFileSystemManager: () => ({
        readFileSync: () => {
          reads++;
          return png;
        },
      }),
      showToast: (options) => toasts.push(options.title),
    },
  });
  const page = {
    ...module.exports,
    data: {
      busy: false,
      demo: false,
      babies: [],
      wallComposerOpen: false,
      wallDraft: { babyId: 'family', text: '保留草稿', photos: [] },
    },
    setData(value) {
      Object.assign(this.data, value);
    },
  };
  return { controller: module.exports, page, calls, selections, toasts, reads: () => reads };
}

test('照片墙初始发布区收起，展开收起均保留草稿，上传期间不能切换', () => {
  const indexPath = path.resolve(__dirname, '../miniprogram/pages/index/index.js');
  let definition;
  vm.runInNewContext(fs.readFileSync(indexPath, 'utf8'), {
    require: createRequire(indexPath),
    Page: (value) => {
      definition = value;
    },
  });
  assert.equal(definition.data.wallComposerOpen, false);
  const f = wallController([]);
  f.page.data.wallComposerBabies = [{ id: 'family', name: '家庭日常' }];
  f.page.data.wallDraft = {
    babyId: 'family',
    text: '保留文字',
    photos: [{ photoId: 'photo:keep', path: '/keep.png' }],
  };
  const draft = f.page.data.wallDraft;
  f.page.openWallComposer();
  assert.equal(f.page.data.wallComposerOpen, true);
  f.page.data.busy = true;
  f.page.collapseWallComposer();
  assert.equal(f.page.data.wallComposerOpen, true);
  f.page.data.busy = false;
  f.page.collapseWallComposer();
  assert.equal(f.page.data.wallComposerOpen, false);
  assert.equal(f.page.data.wallDraft, draft);
  f.page.data.busy = true;
  f.page.openWallComposer();
  assert.equal(f.page.data.wallComposerOpen, false);
  f.page.data.busy = false;
  f.page.openWallComposer();
  assert.equal(f.page.data.wallDraft, draft);
  assert.equal(f.calls.length, 0);
});

test('重新进入照片墙默认收起但保留有效范围和草稿，并照常加载列表', async () => {
  const f = wallController([]);
  const draft = { babyId: 'family', text: '尚未发布', photos: [{ photoId: 'photo:keep' }] };
  f.page.data.wallDraft = draft;
  f.page.data.wallComposerOpen = true;
  let loads = 0;
  f.page.loadPhotoWall = async (reset) => {
    assert.equal(reset, true);
    loads++;
  };
  await f.page.openPhotoWall();
  assert.equal(f.page.data.wallComposerOpen, false);
  assert.equal(f.page.data.wallDraft, draft);
  assert.equal(f.page.data.wallComposerBabies[0].id, 'family');
  assert.equal(loads, 1);
});

test('真实发布成功后同时清空草稿并收起，再刷新列表，不改家庭发布归属', async () => {
  const f = wallController([], async () => ({ postId: 'post:published' }));
  f.page.data.wallComposerOpen = true;
  f.page.data.wallDraft = {
    babyId: 'family',
    text: '这次成功',
    photos: [{ photoId: 'photo:keep' }],
  };
  let loads = 0;
  f.page.loadPhotoWall = async () => {
    loads++;
    assert.equal(f.page.data.wallComposerOpen, false);
    assert.equal(f.page.data.wallDraft.photos.length, 0);
  };
  await f.page.publishWallPost();
  assert.equal(f.page.data.wallComposerOpen, false);
  assert.equal(f.page.data.wallDraft.babyId, 'family');
  assert.equal(f.page.data.wallDraft.text, '');
  assert.equal(f.page.data.wallDraft.photos.length, 0);
  assert.equal(f.page.data.busy, false);
  assert.equal(f.calls[0].action, 'publishPhotoPost');
  assert.equal(f.calls[0].data.scope, 'family');
  assert.equal(f.calls[0].data.babyId, '');
  assert.equal(loads, 1);
});

for (const reply of [
  async () => {
    throw new Error('发布失败');
  },
  async () => ({}),
]) {
  test('发布失败或未返回帖子ID时保持展开和完整草稿，不能刷新成假成功', async () => {
    const f = wallController([], reply);
    const draft = { babyId: 'family', text: '失败保留', photos: [{ photoId: 'photo:keep' }] };
    f.page.data.wallDraft = draft;
    f.page.loadPhotoWall = async () => {
      throw new Error('失败不得刷新列表');
    };
    await f.page.publishWallPost();
    assert.equal(f.page.data.wallComposerOpen, true);
    assert.equal(f.page.data.wallDraft, draft);
    assert.equal(f.page.data.busy, false);
    assert.equal(f.calls.length, 1);
    assert.match(f.toasts[0], /失败|未发布成功/);
  });
}

test('封面加载只记录当前图片原始比例，竖横图、过期图片与无效尺寸分别处理', () => {
  const f = wallController([]);
  f.page.data.view = 'photos';
  f.page.data.gate = false;
  const other = { id: 'other', cover: '/other.jpg' };
  f.page.data.wallPosts = [{ id: 'current', cover: '/current.jpg' }, other];
  const event = {
    currentTarget: { dataset: { id: 'current', cover: '/current.jpg' } },
    detail: { width: 400, height: 600 },
  };
  f.page.wallCoverLoaded(event);
  assert.equal(f.page.data.wallPosts[0].coverRatio, 1.5);
  assert.equal(f.page.data.wallPosts[1], other);
  f.page.wallCoverLoaded({ ...event, detail: { width: 800, height: 400 } });
  assert.equal(f.page.data.wallPosts[0].coverRatio, 0.5);
  const unchanged = f.page.data.wallPosts;
  for (const detail of [
    { width: 0, height: 600 },
    { width: 400, height: Infinity },
    { width: -1, height: 1 },
  ])
    f.page.wallCoverLoaded({ ...event, detail });
  f.page.wallCoverLoaded({
    ...event,
    currentTarget: { dataset: { id: 'current', cover: '/old.jpg' } },
  });
  f.page.data.view = 'today';
  f.page.wallCoverLoaded(event);
  assert.equal(f.page.data.wallPosts, unchanged);
  assert.equal(f.calls.length, 0);
});

test('照片墙选择允许10MiB图片且每篇仍最多9张，不因放大单图限制增加张数', async () => {
  const files = Array.from({ length: 9 }, (_, index) => ({
    size: index ? 1024 * 1024 + 1 : MAX_IMAGE_BYTES,
    tempFilePath: `/selected-${index}.png`,
  }));
  const f = wallController(files);
  await f.controller.chooseWallPhotos.call(f.page);
  assert.equal(f.calls.length, 9);
  assert.equal(f.reads(), 9);
  assert.equal(f.selections[0].count, 9);
  assert.equal(f.page.data.wallDraft.photos.length, 9);
  assert.equal(f.page.data.wallDraft.text, '保留草稿');
  for (const call of f.calls) {
    assert.equal(call.action, 'uploadWallPhoto');
    assert.equal(call.data.scope, 'family');
    assert.equal(call.data.babyId, '');
  }
  await f.controller.chooseWallPhotos.call(f.page);
  assert.equal(f.selections.length, 1);
  assert.deepEqual(f.toasts, []);
  assert.equal(f.page.data.busy, false);
});

test('照片墙整批有一张超10MiB时在读取上传任何照片之前拒绝，保留原草稿', async () => {
  const f = wallController([
    { size: 9, tempFilePath: '/small.png' },
    { size: MAX_IMAGE_BYTES + 1, tempFilePath: '/large.png' },
  ]);
  await f.controller.chooseWallPhotos.call(f.page);
  assert.equal(f.calls.length, 0);
  assert.equal(f.reads(), 0);
  assert.equal(f.page.data.wallDraft.photos.length, 0);
  assert.equal(f.page.data.wallDraft.text, '保留草稿');
  assert.match(f.toasts[0], /10MB/);
  assert.equal(f.page.data.busy, false);
});

function fixture() {
  const store = new Map();
  let chain = Promise.resolve(),
    id = 0;
  const access = (target) => ({
    get: async (collection, key) => structuredClone(target.get(`${collection}/${key}`) || null),
    put: async (collection, key, value) =>
      target.set(`${collection}/${key}`, structuredClone(value)),
  });
  const repo = {
    ...access(store),
    transaction(fn) {
      const result = chain.then(async () => {
        const draft = structuredClone(store);
        const value = await fn(access(draft));
        store.clear();
        for (const [key, item] of draft) store.set(key, item);
        return value;
      });
      chain = result.catch(() => {});
      return result;
    },
  };
  store.set('care_home/home', {
    ownerId: uid('owner'),
    babies: [
      { id: 'baby-a', name: '大宝' },
      { id: 'baby-b', name: '二宝' },
    ],
    members: [
      { id: uid('owner'), name: '妈妈', active: true },
      { id: uid('dad'), name: '爸爸', active: true, relation: '管理员' },
      { id: uid('aunt'), name: '阿姨', active: true },
      { id: uid('removed'), name: '已移除', active: false },
    ],
  });
  const signed = [],
    blobs = new Map();
  const wall = createPhotoWall(repo, {
    hash,
    randomId: () => (++id).toString(16).padStart(32, '0'),
    now: () => '2026-10-28T04:00:00.000Z',
    readMember: async (openid) => {
      const home = await repo.get('care_home', 'home');
      if (!home.members.some((member) => member.id === uid(openid) && member.active))
        throw new Error('无权访问这个家庭');
      return home;
    },
    avatars: { write: async (name, buffer) => blobs.set(name, Buffer.from(buffer)) },
    photoUrl: (name) => {
      signed.push(name);
      return `/private/${name}?signed=true`;
    },
  });
  return { wall, repo, store, signed, blobs };
}

async function publish(f, openid = 'dad', babyId = 'baby-a', text = '记下今天的小美好') {
  const uploaded = await f.wall.uploadWallPhoto(openid, { babyId, base64: png });
  return f.wall.publishPhotoPost(openid, { babyId, text, photoIds: [uploaded.photoId] });
}

test('有效家人可上传发布，未加入和已移除者拒绝，未发布文件不签发短链', async () => {
  const f = fixture();
  await assert.rejects(
    f.wall.uploadWallPhoto('stranger', { babyId: 'baby-a', base64: png }),
    /无权/
  );
  await assert.rejects(f.wall.listPhotoPosts('removed', {}), /无权/);
  const uploaded = await f.wall.uploadWallPhoto('dad', { babyId: 'baby-a', base64: png });
  const file = await f.repo.get('care_files', hash(uploaded.photoId));
  assert.equal(file.kind, 'wall');
  assert.equal(file.uploadedBy, uid('dad'));
  assert.equal(file.ownerId, uid('owner'));
  assert.equal(file.babyId, 'baby-a');
  assert.equal(f.blobs.size, 1);
  assert.equal(f.signed.length, 0);
  const post = await f.wall.publishPhotoPost('dad', {
    babyId: 'baby-a',
    text: '宝宝的第一张合照',
    photoIds: [uploaded.photoId],
    authorId: uid('owner'),
  });
  assert.equal(f.signed.length, 0);
  const listed = await f.wall.listPhotoPosts('aunt', {});
  assert.equal(listed.posts[0].id, post.postId);
  assert.equal(listed.posts[0].authorId, uid('dad'));
  assert.match(listed.posts[0].photos[0].photoUrl, /signed=true/);
  assert.equal(listed.posts[0].canDelete, false);
});

test('没有宝宝也能发布家庭日常照片，持久化scope为family且不制造宝宝ID', async () => {
  const f = fixture(),
    home = await f.repo.get('care_home', 'home');
  home.babies = [];
  await f.repo.put('care_home', 'home', home);
  const uploaded = await f.wall.uploadWallPhoto('dad', {
    scope: 'family',
    babyId: '',
    base64: png,
  });
  const file = await f.repo.get('care_files', hash(uploaded.photoId));
  assert.equal(file.scope, 'family');
  assert.equal(file.babyId, '');
  await f.wall.publishPhotoPost('dad', {
    scope: 'family',
    babyId: '',
    text: '全家人的合照',
    photoIds: [uploaded.photoId],
  });
  const list = await f.wall.listPhotoPosts('owner', { scope: 'family' });
  assert.equal(list.posts.length, 1);
  assert.equal(list.posts[0].scope, 'family');
  assert.equal(list.posts[0].babyId, '');
});

test('家庭与宝宝照片不能跨目标复用，范围筛选各自独立，旧宝宝参数保持兼容', async () => {
  const f = fixture();
  const family = await f.wall.uploadWallPhoto('dad', { scope: 'family', babyId: '', base64: png });
  const baby = await f.wall.uploadWallPhoto('dad', { babyId: 'baby-a', base64: png });
  await assert.rejects(
    f.wall.publishPhotoPost('dad', { scope: 'family', photoIds: [baby.photoId] }),
    /照片/
  );
  await assert.rejects(
    f.wall.publishPhotoPost('dad', { scope: 'baby', babyId: 'baby-a', photoIds: [family.photoId] }),
    /照片/
  );
  await assert.rejects(
    f.wall.uploadWallPhoto('dad', { scope: 'family', babyId: 'baby-a', base64: png }),
    /家庭|范围/
  );
  await f.wall.publishPhotoPost('dad', { scope: 'family', photoIds: [family.photoId] });
  await f.wall.publishPhotoPost('dad', { babyId: 'baby-a', photoIds: [baby.photoId] });
  assert.equal((await f.wall.listPhotoPosts('owner', {})).posts.length, 2);
  assert.deepEqual(
    (await f.wall.listPhotoPosts('owner', { scope: 'family' })).posts.map((post) => post.scope),
    ['family']
  );
  assert.deepEqual(
    (await f.wall.listPhotoPosts('owner', { babyId: 'baby-a' })).posts.map((post) => post.scope),
    ['baby']
  );
});

test('发布必须使用本人为同宝宝上传的wall照片，不能猜文件、复用完成照或伪造家庭', async () => {
  const f = fixture();
  const { photoId } = await f.wall.uploadWallPhoto('dad', { babyId: 'baby-a', base64: png });
  await assert.rejects(
    f.wall.publishPhotoPost('aunt', { babyId: 'baby-a', text: '', photoIds: [photoId] }),
    /照片/
  );
  await assert.rejects(
    f.wall.publishPhotoPost('dad', { babyId: 'baby-b', text: '', photoIds: [photoId] }),
    /照片/
  );
  const file = await f.repo.get('care_files', hash(photoId));
  for (const override of [
    { kind: 'completion' },
    { ownerId: 'other-home' },
    { fileID: 'forged' },
  ]) {
    await f.repo.put('care_files', hash(photoId), { ...file, ...override });
    await assert.rejects(
      f.wall.publishPhotoPost('dad', { babyId: 'baby-a', text: '', photoIds: [photoId] }),
      /照片/
    );
  }
  await f.repo.put('care_files', hash(photoId), file);
  await assert.rejects(
    f.wall.publishPhotoPost('dad', { babyId: 'baby-a', text: '', photoIds: [] }),
    /照片/
  );
  await assert.rejects(
    f.wall.publishPhotoPost('dad', { babyId: 'baby-a', text: '', photoIds: [photoId, photoId] }),
    /照片/
  );
  await assert.rejects(
    f.wall.publishPhotoPost('dad', {
      babyId: 'baby-a',
      text: '字'.repeat(201),
      photoIds: [photoId],
    }),
    /200/
  );
  await assert.rejects(
    f.wall.publishPhotoPost('dad', { babyId: 'missing-baby', text: '', photoIds: [photoId] }),
    /宝宝/
  );
  assert.deepEqual((await f.wall.listPhotoPosts('owner', {})).posts, []);
});

test('作者仅删本人帖子，真正管理员可删全部，软删保持分页指针且不泄露已删照片', async () => {
  const f = fixture();
  const first = await publish(f, 'aunt');
  const second = await publish(f, 'dad');
  await assert.rejects(
    f.wall.deletePhotoPost('dad', { postId: first.postId, owner: true }),
    /本人|管理员/
  );
  await f.wall.deletePhotoPost('owner', { postId: second.postId });
  const tombstone = await f.repo.get('care_photo_posts', second.postId);
  assert.equal(tombstone.previousId, first.postId);
  assert.ok(tombstone.deletedAt);
  const page = await f.wall.listPhotoPosts('aunt', { cursor: second.postId, limit: 1 });
  assert.deepEqual(
    page.posts.map((post) => post.id),
    [first.postId]
  );
  await f.wall.deletePhotoPost('aunt', { postId: first.postId });
  f.signed.length = 0;
  assert.deepEqual((await f.wall.listPhotoPosts('owner', {})).posts, []);
  assert.equal(f.signed.length, 0);
});

test('历史按插入时间倒序真分页，筛选扫描上限后仍提供游标，不因前N条截断漏历史', async () => {
  const f = fixture();
  const old = await publish(f, 'dad', 'baby-b');
  for (let n = 0; n < 204; n++) await publish(f, 'dad', 'baby-a');
  const first = await f.wall.listPhotoPosts('owner', { babyId: 'baby-b', limit: 20 });
  assert.equal(first.posts.length, 0);
  assert.ok(first.nextCursor);
  const second = await f.wall.listPhotoPosts('owner', {
    babyId: 'baby-b',
    cursor: first.nextCursor,
  });
  assert.deepEqual(
    second.posts.map((post) => post.id),
    [old.postId]
  );
  assert.equal(second.nextCursor, '');
  const page1 = await f.wall.listPhotoPosts('owner', { limit: 2 });
  const page2 = await f.wall.listPhotoPosts('owner', { limit: 2, cursor: page1.nextCursor });
  assert.equal(new Set([...page1.posts, ...page2.posts].map((post) => post.id)).size, 4);
  const foreign = 'f'.repeat(32);
  await f.repo.put('care_photo_posts', foreign, { ownerId: 'foreign-home', previousId: '' });
  await assert.rejects(f.wall.listPhotoPosts('owner', { cursor: foreign }), /无权|分页/);
});

test('并发发布不丢feed节点，上传校验真实字节并拒绝错误类型及超限大小', async () => {
  const f = fixture();
  for (const base64 of [
    'not-base64!',
    Buffer.from('not an image').toString('base64'),
    png.slice(0, -1),
  ])
    await assert.rejects(f.wall.uploadWallPhoto('dad', { babyId: 'baby-a', base64 }), /照片/);
  const large = Buffer.alloc(10 * 1024 * 1024 + 1, 0);
  Buffer.from(png, 'base64').copy(large);
  await assert.rejects(
    f.wall.uploadWallPhoto('dad', { babyId: 'baby-a', base64: large.toString('base64') }),
    /10MB/
  );
  const uploaded = await f.wall.uploadWallPhoto('dad', { babyId: 'baby-a', base64: png });
  const posts = await Promise.all(
    Array.from({ length: 3 }, () =>
      f.wall.publishPhotoPost('dad', { babyId: 'baby-a', text: '', photoIds: [uploaded.photoId] })
    )
  );
  assert.equal((await f.wall.listPhotoPosts('owner', {})).posts.length, 3);
  assert.equal(new Set(posts.map((post) => post.postId)).size, 3);
});

test('HTTP业务分发真实记录成功与失败，不存文字或图片，也不开放内部完成入口', async () => {
  const f = fixture();
  await f.wall.call('dad', 'uploadWallPhoto', { babyId: 'baby-a', base64: png });
  await assert.rejects(
    f.wall.call('dad', 'uploadWallPhoto', { babyId: 'baby-a', base64: 'private-photo-body' }),
    /照片/
  );
  const events = [...f.store]
    .filter(([key]) => key.startsWith('care_activity/'))
    .map(([, value]) => value);
  assert.deepEqual(
    events.map(({ name, outcome }) => ({ name, outcome })),
    [
      { name: 'uploadWallPhoto', outcome: 'success' },
      { name: 'uploadWallPhoto', outcome: 'failure' },
    ]
  );
  assert.doesNotMatch(JSON.stringify(events), /private-photo-body|base64/);
  for (const action of ['addCompletion', 'constructor', 'toString'])
    await assert.rejects(f.wall.call('dad', action, {}), /不支持/);
});

test('完成照片在同一事务入墙且eventId幂等，删墙不抹任务历史，元数据不匹配时回滚', async () => {
  const f = fixture(),
    home = await f.repo.get('care_home', 'home');
  const photoId = `photo:${'a'.repeat(32)}.png`,
    eventId = 'b'.repeat(32);
  await f.repo.put('care_files', hash(photoId), {
    kind: 'completion',
    fileID: photoId,
    uploadedBy: uid('dad'),
    ownerId: home.ownerId,
    taskId: 'task-a',
    date: '2026-10-28',
  });
  const input = {
    home,
    actorId: uid('dad'),
    actorName: '爸爸',
    taskId: 'task-a',
    babyId: 'baby-a',
    date: '2026-10-28',
    photoId,
    eventId,
    at: '2026-10-28T04:00:00.000Z',
  };
  await f.repo.transaction(async (tx) => {
    await tx.put('care_days', input.date, { records: { 'task-a': { done: true, photoId } } });
    await addCompletion(tx, input);
    await addCompletion(tx, input);
  });
  const posts = await f.wall.listPhotoPosts('owner', {});
  assert.equal(posts.posts.length, 1);
  assert.equal(posts.posts[0].source, 'completion');
  await f.wall.deletePhotoPost('dad', { postId: eventId });
  assert.equal((await f.repo.get('care_days', input.date)).records['task-a'].photoId, photoId);
  await f.repo.transaction((tx) => addCompletion(tx, input));
  assert.equal((await f.wall.listPhotoPosts('owner', {})).posts.length, 0);
  await assert.rejects(
    f.repo.transaction((tx) =>
      addCompletion(tx, { ...input, eventId: 'c'.repeat(32), date: '2026-10-27' })
    ),
    /照片/
  );
});

test('页面先加载首图，点击才预览全组，删除失败保留动态，成功后才从页面移除', async (t) => {
  const controller = require('../miniprogram/pages/index/controllers/photo-wall');
  const api = require('../miniprogram/utils/client');
  const previous = {
    call: api.call,
    load: api.loadPrivateImage,
    batch: api.loadPrivateImages,
    wx: global.wx,
  };
  let downloads = 0,
    deletionFails = true;
  const post = {
    id: 'a'.repeat(32),
    babyId: 'baby-a',
    authorName: '爸爸',
    text: '今天的照片',
    createdAt: '2026-10-28T04:00:00.000Z',
    photos: [{ photoId: 'photo', photoUrl: '/private/pic' }],
    canDelete: true,
  };
  api.call = async (action) => {
    if (action === 'listPhotoPosts') return { posts: [post], nextCursor: '' };
    if (action === 'deletePhotoPost' && deletionFails) throw new Error('服务暂不可用');
    return { message: '已删除' };
  };
  api.loadPrivateImage = async () => {
    downloads++;
    return '/local/photo.png';
  };
  api.loadPrivateImages = (urls) => Promise.all(urls.map((url) => api.loadPrivateImage(url)));
  global.wx = {
    showToast() {},
    showModal: async () => ({ confirm: true }),
    previewImage: async () => {},
  };
  t.after(() => {
    api.call = previous.call;
    api.loadPrivateImage = previous.load;
    api.loadPrivateImages = previous.batch;
    global.wx = previous.wx;
  });
  const page = {
    ...controller,
    data: {
      demo: false,
      view: 'photos',
      busy: false,
      babies: [{ id: 'baby-a', name: '大宝' }],
      wallPosts: [],
      wallBabyId: 'all',
      wallDraft: { babyId: 'baby-a', text: '', photos: [] },
    },
    setData(update) {
      Object.assign(this.data, update);
    },
  };
  await page.loadPhotoWall(true);
  assert.equal(downloads, 1);
  await page.previewWallPost({ currentTarget: { dataset: { id: post.id, index: 0 } } });
  assert.equal(downloads, 2);
  await page.deleteWallPost({ currentTarget: { dataset: { id: post.id } } });
  assert.equal(page.data.wallPosts.length, 1);
  deletionFails = false;
  await page.deleteWallPost({ currentTarget: { dataset: { id: post.id } } });
  assert.equal(page.data.wallPosts.length, 0);
});

test('预览鉴权返回或报错时已离开照片墙，不再弹图、回写或显示旧错误', async (t) => {
  const controller = require('../miniprogram/pages/index/controllers/photo-wall');
  const api = require('../miniprogram/utils/client');
  const previous = {
    call: api.call,
    batch: api.loadPrivateImages,
    load: api.loadPrivateImage,
    wx: global.wx,
  };
  t.after(() => {
    api.call = previous.call;
    api.loadPrivateImages = previous.batch;
    api.loadPrivateImage = previous.load;
    global.wx = previous.wx;
  });
  for (const fail of [false, true]) {
    let resolve,
      reject,
      previews = 0,
      notices = 0,
      writes = 0;
    const pending = new Promise((ok, no) => {
      resolve = ok;
      reject = no;
    });
    const post = {
      id: 'a'.repeat(32),
      babyId: 'baby-a',
      photos: [{ photoUrl: '/private/photo' }],
      localImages: [],
    };
    api.call = () => pending;
    api.loadPrivateImage = async () => '/local/photo';
    api.loadPrivateImages = async () => ['/local/photo'];
    global.wx = {
      previewImage: async () => {
        previews++;
      },
      showToast: () => {
        notices++;
      },
    };
    const page = {
      ...controller,
      _wallGeneration: 1,
      data: { view: 'photos', gate: false, wallPosts: [post] },
      setData(update) {
        if (update.wallPosts) writes++;
        Object.assign(this.data, update);
      },
    };
    const request = page.previewWallPost({ currentTarget: { dataset: { id: post.id } } });
    page.cancelWallCovers();
    page.data.view = 'today';
    if (fail) reject(new Error('旧页面请求失败'));
    else resolve({ posts: [post] });
    await request;
    assert.equal(previews, 0);
    assert.equal(notices, 0);
    assert.equal(writes, 0);
  }
});

test('整组图片下载中失去成员权限，完成后不弹图也不回写旧动态', async (t) => {
  const controller = require('../miniprogram/pages/index/controllers/photo-wall');
  const api = require('../miniprogram/utils/client');
  const previous = {
    call: api.call,
    batch: api.loadPrivateImages,
    load: api.loadPrivateImage,
    wx: global.wx,
  };
  let finish,
    previews = 0,
    writes = 0;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const post = {
    id: 'a'.repeat(32),
    babyId: 'baby-a',
    photos: [{ photoUrl: '/private/photo' }],
    localImages: [],
  };
  api.call = async () => ({ posts: [post] });
  api.loadPrivateImage = () => pending;
  api.loadPrivateImages = () => pending.then((path) => [path]);
  global.wx = {
    previewImage: async () => {
      previews++;
    },
    showToast() {},
  };
  t.after(() => {
    api.call = previous.call;
    api.loadPrivateImages = previous.batch;
    api.loadPrivateImage = previous.load;
    global.wx = previous.wx;
  });
  const page = {
    ...controller,
    _wallGeneration: 1,
    data: { view: 'photos', gate: false, wallPosts: [post] },
    setData(update) {
      if (update.wallPosts) writes++;
      Object.assign(this.data, update);
    },
  };
  const request = page.previewWallPost({ currentTarget: { dataset: { id: post.id } } });
  await new Promise(setImmediate);
  page.data.gate = true;
  finish('/local/photo');
  await request;
  assert.equal(previews, 0);
  assert.equal(writes, 0);
});

test('重新进入照片墙可以新建预览，旧请求finally不能释放新预览锁', async (t) => {
  const controller = require('../miniprogram/pages/index/controllers/photo-wall');
  const api = require('../miniprogram/utils/client');
  const previous = {
    call: api.call,
    batch: api.loadPrivateImages,
    load: api.loadPrivateImage,
    wx: global.wx,
  };
  const requests = [];
  let previews = 0;
  const post = { id: 'a'.repeat(32), babyId: 'baby-a', photos: [{ photoUrl: '/private/photo' }] };
  api.call = () => new Promise((resolve) => requests.push(resolve));
  api.loadPrivateImage = async () => '/local/photo';
  api.loadPrivateImages = async () => ['/local/photo'];
  global.wx = {
    previewImage: async () => {
      previews++;
    },
    showToast() {},
  };
  t.after(() => {
    api.call = previous.call;
    api.loadPrivateImages = previous.batch;
    api.loadPrivateImage = previous.load;
    global.wx = previous.wx;
  });
  const page = {
    ...controller,
    _wallGeneration: 1,
    data: { view: 'photos', gate: false, wallPosts: [post] },
    setData(update) {
      Object.assign(this.data, update);
    },
  };
  const first = page.previewWallPost({ currentTarget: { dataset: { id: post.id } } });
  page.cancelWallCovers();
  const second = page.previewWallPost({ currentTarget: { dataset: { id: post.id } } });
  const newLock = page._wallPreviewing;
  requests[0]({ posts: [post] });
  await first;
  assert.equal(page._wallPreviewing, newLock);
  assert.equal(requests.length, 2);
  requests[1]({ posts: [post] });
  await second;
  assert.equal(previews, 1);
});

test('首图加载前元数据立即可见，每批只取首图且全页最多3个并发', async (t) => {
  const controller = require('../miniprogram/pages/index/controllers/photo-wall');
  const api = require('../miniprogram/utils/client');
  const previous = { call: api.call, load: api.loadPrivateImage };
  const pending = [],
    requested = [];
  let active = 0,
    peak = 0;
  api.call = async () => ({
    posts: Array.from({ length: 5 }, (_, i) => ({
      id: String(i),
      babyId: 'baby-a',
      createdAt: '2026-10-28T04:00:00.000Z',
      photos: [{ photoUrl: `first-${i}` }, { photoUrl: `second-${i}` }],
    })),
    nextCursor: '',
  });
  api.loadPrivateImage = (url) =>
    new Promise((resolve) => {
      requested.push(url);
      active++;
      peak = Math.max(peak, active);
      pending.push(() => {
        active--;
        resolve(`/local/${url}`);
      });
    });
  t.after(() => {
    api.call = previous.call;
    api.loadPrivateImage = previous.load;
  });
  const page = {
    ...controller,
    data: { view: 'photos', demo: false, wallPosts: [], wallBabyId: 'all' },
    setData(update) {
      Object.assign(this.data, update);
    },
  };
  const loading = page.loadPhotoWall(true);
  await new Promise(setImmediate);
  assert.equal(page.data.wallPosts.length, 5);
  assert.equal(requested.length, 3);
  assert.equal(page.data.wallPosts[0].cover, '');
  while (pending.length) {
    pending.shift()();
    await new Promise(setImmediate);
  }
  await loading;
  assert.equal(peak, 3);
  assert.deepEqual(requested.sort(), ['first-0', 'first-1', 'first-2', 'first-3', 'first-4']);
  assert.ok(page.data.wallPosts.every((post) => post.cover.startsWith('/local/first-')));
});

test('切换筛选后旧请求失败不能覆盖新页', async (t) => {
  const controller = require('../miniprogram/pages/index/controllers/photo-wall');
  const api = require('../miniprogram/utils/client');
  const previous = { call: api.call, load: api.loadPrivateImage };
  let rejectOld;
  const old = new Promise((resolve, reject) => {
    rejectOld = reject;
  });
  let calls = 0;
  api.call = async () => (++calls === 1 ? old : { posts: [], nextCursor: '' });
  api.loadPrivateImage = async () => '/local/cover';
  t.after(() => {
    api.call = previous.call;
    api.loadPrivateImage = previous.load;
  });
  const page = {
    ...controller,
    data: { view: 'photos', demo: false, wallPosts: [], wallBabyId: 'all' },
    setData(update) {
      Object.assign(this.data, update);
    },
  };
  const first = page.loadPhotoWall(true);
  await new Promise(setImmediate);
  page.data.babies = [];
  await page.openPhotoWall();
  assert.equal(calls, 2);
  rejectOld(new Error('旧宝宝请求超时'));
  await first;
  assert.equal(page.data.wallNotice, '');
  assert.equal(page.data.wallBabyId, 'all');
});

test('真实HTTP四动作只接受已认证成员，私有图片及软删由同一服务器持久保存', async (t) => {
  const { createHttpApplication } = require('../selfhost/app.cjs');
  const { createSQLiteRepository } = require('../selfhost/sqlite-repository.cjs');
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
    wechat: { exchangeCode: async (code) => ({ openid: code }), sendMessage: async () => {} },
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await app.close();
    await repo.close();
  });
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const response = await fetch(origin + '/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'owner' }),
  });
  const token = (await response.json()).data.token;
  const call = async (action, data = {}, authenticated = true) => {
    const result = await fetch(origin + '/api/call', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(authenticated ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ action, data }),
    });
    return result.json();
  };
  assert.equal((await call('listPhotoPosts', {}, false)).ok, false);
  await call('createHome', { name: '妈妈' });
  await call('saveBaby', { name: '宝宝' });
  const babyId = (await call('snapshot')).data.home.babies[0].id;
  const uploaded = await call('uploadWallPhoto', { babyId, base64: png });
  assert.equal(uploaded.ok, true);
  const posted = await call('publishPhotoPost', {
    babyId,
    text: '今天的日常',
    photoIds: [uploaded.data.photoId],
  });
  assert.equal(posted.ok, true);
  const list = await call('listPhotoPosts');
  assert.equal(list.data.posts.length, 1);
  const image = await fetch(origin + list.data.posts[0].photos[0].photoUrl);
  assert.equal(image.status, 200);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), Buffer.from(png, 'base64'));
  assert.equal((await call('deletePhotoPost', { postId: posted.data.postId })).ok, true);
  assert.deepEqual((await call('listPhotoPosts')).data.posts, []);
});
