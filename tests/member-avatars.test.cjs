const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createSQLiteRepository } = require('../selfhost/sqlite-repository.cjs');
const { createAvatarStore } = require('../selfhost/avatar-store.cjs');
const { createMemberAvatars } = require('../server/member-avatars.cjs');
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const uid = (s) => hash(s).slice(0, 32);
const image = Buffer.from([255, 216, 255, 1, 2, 3]);

test('真实HTTP成员头像上传、保存、私有读取及分片元数据使用同一权限', async (t) => {
  const { createHttpApplication } = require('../selfhost/app.cjs');
  const { repo } = await fixture(t);
  const app = createHttpApplication({
    repo,
    config: {
      dataDir: require('node:os').tmpdir(),
      avatarStorage: 'database',
      ownerOpenId: 'owner',
      signingSecret: 'm'.repeat(64),
      publicOrigin: '',
      fields: {},
    },
    wechat: {
      exchangeCode: async (code) => ({ openid: code }),
      sendMessage: async () => {
        throw Error('No external messages');
      },
    },
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const origin = 'http://127.0.0.1:' + app.server.address().port;
  const request = async (route, data, token) => {
    const r = await fetch(origin + route, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: 'Bearer ' + token } : {}),
      },
      body: JSON.stringify(data),
    });
    return r.json();
  };
  const dad = (await request('/api/login', { code: 'dad' })).data.token;
  const call = (action, data = {}) => request('/api/call', { action, data }, dad);
  const uploaded = await call('uploadMemberAvatar', {
    memberId: uid('dad'),
    base64: image.toString('base64'),
  });
  assert.equal(uploaded.ok, true);
  assert.equal(
    (await call('setMemberAvatar', { memberId: uid('dad'), avatar: uploaded.data.fileID })).ok,
    true
  );
  const snapshot = (await call('snapshot')).data;
  const member = snapshot.home.members.find((m) => m.id === uid('dad'));
  const read = await fetch(origin + member.avatarUrl);
  assert.equal(read.status, 200);
  assert.deepEqual(Buffer.from(await read.arrayBuffer()), image);
  assert.equal(
    (await call('uploadMemberAvatar', { memberId: uid('mum'), base64: image.toString('base64') }))
      .ok,
    false
  );
  const session = await call('initImageUpload', {
    action: 'uploadMemberAvatar',
    metadata: { memberId: uid('dad') },
    totalLength: image.toString('base64').length,
    totalParts: 1,
  });
  assert.equal(session.ok, true);
  assert.equal(
    (await call('appendImageChunk', { ...session.data, index: 0, chunk: image.toString('base64') }))
      .data.accepted,
    true
  );
  assert.match((await call('finishImageUpload', session.data)).data.fileID, /^avatar:/);
});

async function fixture(t) {
  const repo = createSQLiteRepository(':memory:');
  t.after(() => repo.close());
  await repo.put('care_home', 'home', {
    ...require('../server/domain').createHome(uid('owner'), 'owner', '2026-10-28'),
    ownerId: uid('owner'),
    members: ['owner', 'dad', 'mum'].map((name) => ({ id: uid(name), name, active: true })),
  });
  const avatars = createAvatarStore({ repo, mode: 'database', directory: '' });
  const memberAvatars = createMemberAvatars(repo, {
    avatars,
    hash,
    randomId: () => crypto.randomBytes(16).toString('hex'),
    now: () => new Date().toISOString(),
    avatarUrl: (name) => '/signed/' + name,
    readMember: async (openid) => {
      const home = await repo.get('care_home', 'home');
      require('../server/domain').assertMember(home, uid(openid));
      return home;
    },
  });
  return { repo, avatars, memberAvatars };
}

test('家人修改本人头像，管理员修改其他有效家人，保存前不替换旧头像', async (t) => {
  const { repo, avatars, memberAvatars: a } = await fixture(t);
  const uploaded = await a.upload('dad', {
    memberId: uid('dad'),
    base64: image.toString('base64'),
  });
  assert.match(uploaded.fileID, /^avatar:[a-f0-9]{32}\.jpg$/);
  assert.equal((await repo.get('care_home', 'home')).members[1].avatar, undefined);
  await a.save('dad', { memberId: uid('dad'), avatar: uploaded.fileID });
  assert.equal((await repo.get('care_home', 'home')).members[1].avatar, uploaded.fileID);
  assert.deepEqual(await avatars.read(uploaded.fileID.slice(7)), image);
  const changed = await a.upload('owner', {
    memberId: uid('mum'),
    base64: image.toString('base64'),
  });
  await a.save('owner', { memberId: uid('mum'), avatar: changed.fileID });
  assert.equal((await repo.get('care_home', 'home')).members[2].avatar, changed.fileID);
});

test('不能用角色文字、他人的头像或宝宝头像越权设置家人头像', async (t) => {
  const { repo, memberAvatars: a } = await fixture(t);
  const home = await repo.get('care_home', 'home');
  home.members[1].role = '管理员';
  await repo.put('care_home', 'home', home);
  await assert.rejects(
    a.upload('dad', { memberId: uid('mum'), base64: image.toString('base64') }),
    /本人|管理员|权限/
  );
  const uploaded = await a.upload('owner', {
    memberId: uid('mum'),
    base64: image.toString('base64'),
  });
  await assert.rejects(
    a.save('dad', { memberId: uid('dad'), avatar: uploaded.fileID }),
    /头像|权限/
  );
  const other = 'avatar:' + 'b'.repeat(32) + '.jpg';
  await repo.put('care_files', hash(other), { fileID: other, ownerId: uid('owner') });
  await assert.rejects(a.save('owner', { memberId: uid('dad'), avatar: other }), /头像|权限/);
  const own = await a.upload('dad', { memberId: uid('dad'), base64: image.toString('base64') });
  await assert.rejects(a.save('owner', { memberId: uid('mum'), avatar: own.fileID }), /头像|权限/);
});

test('上传后被移除或目标失效时保存拒绝，失败不覆盖当前家庭', async (t) => {
  const { repo, memberAvatars: a } = await fixture(t);
  const uploaded = await a.upload('dad', {
    memberId: uid('dad'),
    base64: image.toString('base64'),
  });
  const home = await repo.get('care_home', 'home');
  home.members[1].active = false;
  await repo.put('care_home', 'home', home);
  await assert.rejects(a.save('dad', { memberId: uid('dad'), avatar: uploaded.fileID }));
  await assert.rejects(
    a.upload('owner', { memberId: uid('dad'), base64: image.toString('base64') })
  );
  assert.deepEqual(await repo.get('care_home', 'home'), home);
});

test('成员快照仅为当前成员绑定的有效头像签名，未知文件和不匹配目标不签名', async (t) => {
  const { repo, memberAvatars: a } = await fixture(t);
  const uploaded = await a.upload('dad', {
    memberId: uid('dad'),
    base64: image.toString('base64'),
  });
  await a.save('dad', { memberId: uid('dad'), avatar: uploaded.fileID });
  const home = await repo.get('care_home', 'home');
  home.members[2].avatar = uploaded.fileID;
  await a.attach(home);
  assert.match(home.members[1].avatarUrl, /^\/signed\//);
  assert.equal(home.members[2].avatarUrl, '');
  assert.equal(home.members[0].avatarUrl, '');
});

test('成员头像校验真实10MiB边界、规范Base64与JPEG或PNG头', async (t) => {
  const { memberAvatars: a } = await fixture(t);
  const maximal = Buffer.alloc(10 * 1024 * 1024, 7);
  image.copy(maximal);
  assert.ok(
    (await a.upload('dad', { memberId: uid('dad'), base64: maximal.toString('base64') })).fileID
  );
  const oversized = Buffer.concat([maximal, Buffer.from([7])]);
  for (const base64 of [
    oversized.toString('base64'),
    'invalid!',
    Buffer.from('not-image').toString('base64'),
  ])
    await assert.rejects(a.upload('dad', { memberId: uid('dad'), base64 }), /10MB|图片|头像/);
});
