const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { MAX_IMAGE_BYTES } = require('../miniprogram/utils/media-policy');

function familyFixture(options = {}) {
  const filename = path.resolve(__dirname, '../miniprogram/pages/index/controllers/family.js');
  const localRequire = createRequire(filename),
    module = { exports: {} };
  const calls = [],
    selections = [],
    notices = [];
  let reads = 0;
  const members = [
    {
      id: 'owner',
      name: '妈妈',
      active: true,
      avatar: 'avatar:old-owner',
      picture: '/old-owner.png',
    },
    {
      id: 'self',
      name: '管理员',
      relation: '管理员',
      active: true,
      avatar: 'avatar:old-self',
      picture: '/old-self.png',
    },
    {
      id: 'other',
      name: '家人',
      active: true,
      avatar: 'avatar:old-other',
      picture: '/old-other.png',
    },
    {
      id: 'removed',
      name: '已移除',
      active: false,
      avatar: 'avatar:old-removed',
      picture: '/old-removed.png',
    },
  ];
  const api = {
    call: async (action, data) => {
      calls.push({ action, data: JSON.parse(JSON.stringify(data)) });
      if (action === 'uploadMemberAvatar') {
        if (options.uploadError) throw new Error('上传失败');
        return options.uploadResult === undefined ? { fileID: 'avatar:new' } : options.uploadResult;
      }
      if (action === 'setMemberAvatar') {
        if (options.onSave) return options.onSave();
        if (options.saveError) throw new Error('保存失败');
        return options.saveResult === undefined ? {} : options.saveResult;
      }
      throw new Error('不允许无关业务调用');
    },
  };
  vm.runInNewContext(
    fs.readFileSync(filename, 'utf8'),
    {
      module,
      require: (name) => (name.endsWith('/client') ? api : localRequire(name)),
      wx: {
        chooseMedia: async (settings) => {
          selections.push(settings);
          if (options.cancel) throw { errMsg: 'chooseMedia:fail cancel' };
          return {
            tempFiles: options.noSelection
              ? []
              : [{ tempFilePath: '/selected.png', size: options.size || 9 }],
          };
        },
        getFileSystemManager: () => ({
          readFileSync: (filename, encoding) => {
            reads++;
            assert.equal(filename, '/selected.png');
            assert.equal(encoding, 'base64');
            return 'c2VsZWN0ZWQ=';
          },
        }),
        showToast: (notice) => notices.push(notice.title),
      },
    },
    { filename }
  );
  const page = {
    ...module.exports,
    _snapshot: { actorId: options.actorId || 'self', home: { ownerId: 'owner', members } },
    data: { busy: !!options.busy, demo: !!options.demo, gate: false, members },
    setData(update) {
      Object.assign(this.data, update);
    },
  };
  return { page, calls, selections, notices, reads: () => reads };
}

const click = (id) => ({ currentTarget: { dataset: { id } } });

test('本人改头像经上传和保存双成功后才更新自己的行，其他成员不受影响', async () => {
  const f = familyFixture();
  const other = f.page.data.members[2];
  await f.page.chooseMemberAvatar(click('self'));
  assert.deepEqual(f.calls, [
    { action: 'uploadMemberAvatar', data: { memberId: 'self', base64: 'c2VsZWN0ZWQ=' } },
    { action: 'setMemberAvatar', data: { memberId: 'self', avatar: 'avatar:new' } },
  ]);
  assert.equal(f.page.data.members[1].avatar, 'avatar:new');
  assert.equal(f.page.data.members[1].picture, '/selected.png');
  assert.equal(f.page.data.members[2], other);
  assert.equal(f.page.data.busy, false);
  assert.deepEqual(f.notices, ['头像已更新']);
  assert.equal(f.selections[0].count, 1);
  assert.deepEqual(Array.from(f.selections[0].sourceType), ['album', 'camera']);
});

test('真实管理员可改任一有效成员，昵称或身份称呼为管理员不获得额外权限', async () => {
  for (const id of ['owner', 'self', 'other']) {
    const owner = familyFixture({ actorId: 'owner' });
    await owner.page.chooseMemberAvatar(click(id));
    assert.equal(owner.calls[1].data.memberId, id);
  }
  for (const id of ['owner', 'other', 'removed', 'missing']) {
    const ordinary = familyFixture();
    await ordinary.page.chooseMemberAvatar(click(id));
    assert.equal(ordinary.selections.length, 0);
    assert.equal(ordinary.calls.length, 0);
    assert.equal(ordinary.reads(), 0);
  }
  const owner = familyFixture({ actorId: 'owner' });
  await owner.page.chooseMemberAvatar(click('removed'));
  assert.equal(owner.calls.length, 0);
  const removedActor = familyFixture({ actorId: 'removed' });
  await removedActor.page.chooseMemberAvatar(click('other'));
  assert.equal(removedActor.calls.length, 0);
});

test('忙碌和本地体验不选图上传，10MiB边界接受而超限在读取前拒绝', async () => {
  for (const options of [{ busy: true }, { demo: true }]) {
    const f = familyFixture(options);
    await f.page.chooseMemberAvatar(click('self'));
    assert.equal(f.selections.length, 0);
    assert.equal(f.calls.length, 0);
  }
  const accepted = familyFixture({ size: MAX_IMAGE_BYTES });
  await accepted.page.chooseMemberAvatar(click('self'));
  assert.equal(accepted.calls.length, 2);
  const rejected = familyFixture({ size: MAX_IMAGE_BYTES + 1 });
  await rejected.page.chooseMemberAvatar(click('self'));
  assert.equal(rejected.calls.length, 0);
  assert.equal(rejected.reads(), 0);
  assert.match(rejected.notices[0], /10MB/);
});

for (const options of [
  { cancel: true },
  { noSelection: true },
  { uploadError: true },
  { saveError: true },
  { uploadResult: {} },
  { saveResult: null },
]) {
  test(`选图取消或任一上传保存步骤未成功时保留旧头像：${Object.keys(options)[0]}`, async () => {
    const f = familyFixture(options);
    const members = f.page.data.members;
    await f.page.chooseMemberAvatar(click('self'));
    assert.equal(f.page.data.members, members);
    assert.equal(f.page.data.members[1].picture, '/old-self.png');
    assert.equal(f.page.data.busy, false);
    assert.equal(f.notices.includes('头像已更新'), false);
    if (options.cancel || options.noSelection) assert.equal(f.notices.length, 0);
    if (options.uploadError || options.uploadResult) assert.equal(f.calls.length, 1);
  });
}

test('保存响应未成功前保留旧头像，锁定重复点击，成功后才展示新头像', async () => {
  let entered, release;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const f = familyFixture({
    onSave: async () => {
      entered();
      return pending;
    },
  });
  const operation = f.page.chooseMemberAvatar(click('self'));
  await started;
  assert.equal(f.page.data.members[1].picture, '/old-self.png');
  assert.equal(f.page.data.busy, true);
  await f.page.chooseMemberAvatar(click('self'));
  assert.equal(f.selections.length, 1);
  release({});
  await operation;
  assert.equal(f.page.data.members[1].picture, '/selected.png');
});

test('成员展示使用授权头像并仅向本人或真实管理员开放入口，不信任称呼与服务器展示标记', async () => {
  const filename = path.resolve(__dirname, '../miniprogram/pages/index/index.js');
  for (const actorId of ['self', 'owner']) {
    const home = {
      ownerId: 'owner',
      createdDate: '2026-10-28',
      babies: [],
      tasks: [],
      members: [
        { id: 'owner', name: '妈妈', active: true, avatar: 'avatar:private-only' },
        {
          id: 'self',
          name: '管理员',
          relation: '管理员',
          active: true,
          avatarUrl: '/authorized-local.png',
        },
        { id: 'other', name: '家人', active: true, canEditAvatar: true, isOwner: true },
        { id: 'removed', name: '离家成员', active: false },
      ],
    };
    let definition;
    const localRequire = createRequire(filename);
    vm.runInNewContext(
      fs.readFileSync(filename, 'utf8'),
      {
        require: (name) =>
          name === '../../utils/client'
            ? {
                call: async () => ({
                  home,
                  actorId,
                  requests: [],
                  configured: false,
                  subscribed: false,
                }),
              }
            : localRequire(name),
        Page: (value) => {
          definition = value;
        },
        wx: { showToast() {} },
      },
      { filename }
    );
    const page = {
      ...definition,
      data: structuredClone(definition.data),
      setData(update) {
        Object.assign(this.data, update);
      },
      renderRows() {},
      recordActivity() {},
    };
    assert.equal(await page.refresh(), true);
    assert.equal(page.data.members.length, 3);
    const owner = page.data.members.find((member) => member.id === 'owner');
    const self = page.data.members.find((member) => member.id === 'self');
    const other = page.data.members.find((member) => member.id === 'other');
    assert.equal(owner.isOwner, true);
    assert.equal(other.isOwner, false);
    assert.equal(self.picture, '/authorized-local.png');
    assert.equal(owner.picture, '');
    assert.equal(owner.initial, '妈');
    assert.equal(self.canEditAvatar, true);
    assert.equal(other.canEditAvatar, actorId === 'owner');
    assert.equal(owner.canEditAvatar, actorId === 'owner');
  }
});
