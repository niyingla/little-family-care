const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createService } = require('../server/service.cjs');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
function fixture() {
  let store = {},
    chain = Promise.resolve(),
    time = '2026-10-28T02:00:00.000Z',
    sends = 0,
    failCode = '';
  const access = (target) => ({
    get: async (c, id) => structuredClone(target[`${c}/${id}`] || null),
    put: async (c, id, data) => {
      target[`${c}/${id}`] = structuredClone(data);
    },
  });
  const repo = {
    ...access(store),
    list: async (c, filter, limit) =>
      Object.entries(store)
        .filter(
          ([k, v]) => k.startsWith(c + '/') && Object.entries(filter).every(([a, b]) => v[a] === b)
        )
        .slice(0, limit)
        .map(([, v]) => structuredClone(v)),
    transaction: (fn) => {
      const promise = chain.then(async () => {
        const draft = structuredClone(store);
        const result = await fn(access(draft));
        for (const key of Object.keys(store)) delete store[key];
        Object.assign(store, draft);
        return result;
      });
      chain = promise.catch(() => {});
      return promise;
    },
  };
  const service = createService(repo, {
    ownerOpenId: 'owner',
    templateId: 'template',
    now: () => time,
    randomId: () => crypto.randomBytes(16).toString('hex'),
    hash,
    sendMessage: async () => {
      sends++;
      if (failCode) throw Object.assign(new Error('微信接口错误'), { errCode: failCode });
    },
  });
  return {
    service,
    repo,
    sends: () => sends,
    fail: (code) => {
      failCode = code;
    },
    setTime: (value) => {
      time = value;
    },
  };
}
async function setup(f, extra = {}) {
  await f.service.call('owner', 'createHome', { name: '妈妈' });
  await f.service.call('owner', 'saveBaby', { name: '大宝' });
  const h = (await f.service.call('owner', 'snapshot')).home;
  await f.service.call('owner', 'saveTask', {
    title: '准备用品',
    babyIds: [h.babies[0].id],
    assigneeId: h.ownerId,
    frequency: 'daily',
    startDate: '2026-10-28',
    executionTime: '09:00',
    ...extra,
  });
  return (await f.service.call('owner', 'snapshot')).home;
}

async function addFamilyMember(f, identity, name = identity) {
  const invite = await f.service.call('owner', 'makeInvite', { name });
  await f.service.call(identity, 'applyInvite', { token: invite.token });
  return hash(identity).slice(0, 32);
}

test('创建当天也能向前浏览空白历史，创建前不泄露旧日记录且未来仍拒绝', async () => {
  const f = fixture();
  await setup(f);
  await f.repo.put('care_days', '2026-10-27', { date: '2026-10-27', events: [{ legacy: true }] });
  const snapshot = await f.service.call('owner', 'snapshot', { date: '2026-10-27' });
  assert.equal(snapshot.date, '2026-10-27');
  assert.equal(snapshot.beforeCreation, true);
  assert.equal(snapshot.day, null);
  assert.deepEqual(snapshot.messages, []);
  assert.equal((await f.repo.get('care_days', '2026-10-27')).events[0].legacy, true);
  await assert.rejects(f.service.call('guest', 'snapshot', { date: '2026-10-27' }), /无权/);
  await assert.rejects(f.service.call('owner', 'snapshot', { date: '2026-10-29' }), /日期/);
  await assert.rejects(f.service.call('owner', 'snapshot', { date: '2026-02-30' }), /日期/);
});

test('家人可独立关注与取消，完成后只通知仍关注的有效家人，执行者本人不重复通知', async () => {
  const f = fixture();
  const home = await setup(f);
  const dad = await addFamilyMember(f, 'dad', '爸爸');
  await addFamilyMember(f, 'mum', '妈妈');
  await f.service.call('dad', 'subscribe', { accepted: true, templateId: 'template' });
  await f.service.call('mum', 'subscribe', { accepted: true, templateId: 'template' });
  const taskId = home.tasks[0].id;
  await f.service.call('dad', 'setFollowing', { taskId, following: true, actorId: home.ownerId });
  await f.service.call('dad', 'setFollowing', { taskId, following: true });
  await f.service.call('mum', 'setFollowing', { taskId, following: true });
  await f.service.call('mum', 'setFollowing', { taskId, following: false });
  await f.service.call('owner', 'setFollowing', { taskId, following: true });
  await f.service.call('owner', 'subscribe', { accepted: true, templateId: 'template' });
  const before = await f.service.call('dad', 'snapshot');
  assert.deepEqual(before.home.tasks[0].followers, [dad, home.ownerId]);
  await f.service.call('owner', 'complete', {
    taskId,
    date: '2026-10-28',
    done: true,
    expectedRevision: 0,
  });
  const messages = (await f.service.call('owner', 'snapshot')).messages;
  assert.equal(f.sends(), 1);
  assert.equal(messages[0].type, 'completion');
  assert.equal(messages[0].recipientId, dad);
  assert.equal(messages[0].status, 'sent');
  await assert.rejects(
    f.service.call('stranger', 'setFollowing', { taskId, following: true }),
    /无权/
  );
  await assert.rejects(f.service.call('dad', 'setFollowing', { taskId, following: 'yes' }), /关注/);
});

test('管理员可维护所有人生日，家人仅改本人；提前三天10点通知全体且重复扫描不重发', async () => {
  const f = fixture();
  await setup(f, { executionTime: '' });
  const dad = await addFamilyMember(f, 'dad', '爸爸');
  await f.service.call('owner', 'saveBirthday', {
    memberId: dad,
    calendar: 'solar',
    month: 11,
    day: 1,
    leap: false,
  });
  await assert.rejects(
    f.service.call('dad', 'saveBirthday', {
      memberId: hash('owner').slice(0, 32),
      calendar: 'solar',
      month: 11,
      day: 2,
      leap: false,
    }),
    /本人|管理/
  );
  await assert.rejects(
    f.service.call('stranger', 'saveBirthday', { memberId: dad, birthday: null }),
    /无权/
  );
  await f.service.call('dad', 'saveBirthday', {
    memberId: dad,
    calendar: 'solar',
    month: 11,
    day: 1,
    leap: false,
  });
  for (const identity of ['owner', 'dad'])
    await f.service.call(identity, 'subscribe', { accepted: true, templateId: 'template' });
  f.setTime('2026-10-29T01:59:59.000Z');
  await f.service.tick();
  assert.equal(f.sends(), 0);
  f.setTime('2026-10-29T02:00:00.000Z');
  await Promise.all([f.service.tick(), f.service.tick()]);
  assert.equal(f.sends(), 2);
  const snapshot = await f.service.call('owner', 'snapshot');
  assert.equal(
    snapshot.messages.filter((m) => m.type === 'birthday' && m.status === 'sent').length,
    2
  );
  await f.service.call('owner', 'saveBirthday', { memberId: dad, birthday: null });
  assert.equal(
    (await f.service.call('owner', 'snapshot')).home.members.find((m) => m.id === dad).birthday,
    null
  );
});

test('完成照片只接受同人同日同任务已上传的记录，撤销不抹执行流水，缺少授权如实记录', async () => {
  const f = fixture();
  const home = await setup(f);
  await addFamilyMember(f, 'dad', '爸爸');
  const taskId = home.tasks[0].id,
    photoId = 'photo:' + 'a'.repeat(32) + '.jpg';
  await f.service.call('dad', 'setFollowing', { taskId, following: true });
  const complete = { taskId, date: '2026-10-28', done: true, expectedRevision: 0, photoId };
  await assert.rejects(f.service.call('owner', 'complete', complete), /照片/);
  const file = {
    kind: 'completion',
    fileID: photoId,
    ownerId: home.ownerId,
    uploadedBy: hash('dad').slice(0, 32),
    taskId,
    date: '2026-10-28',
  };
  await f.repo.put('care_files', hash(photoId), file);
  await assert.rejects(f.service.call('owner', 'complete', complete), /照片/);
  await f.repo.put('care_files', hash(photoId), {
    ...file,
    uploadedBy: home.ownerId,
    date: '2026-10-27',
  });
  await assert.rejects(f.service.call('owner', 'complete', complete), /照片/);
  await f.repo.put('care_files', hash(photoId), { ...file, uploadedBy: home.ownerId });
  await f.service.call('owner', 'complete', complete);
  const result = await f.service.call('owner', 'snapshot');
  assert.equal(result.day.records[taskId].photoId, photoId);
  assert.equal(result.day.events[0].photoId, photoId);
  assert.equal(result.messages[0].status, 'no_quota');
  assert.equal(f.sends(), 0);
  await f.service.call('owner', 'complete', {
    taskId,
    date: '2026-10-28',
    done: false,
    expectedRevision: 1,
  });
  const undone = await f.service.call('owner', 'snapshot');
  assert.equal(undone.day.records[taskId].photoId, '');
  assert.equal(undone.day.events[0].photoId, photoId);
});
test('仅宝宝事项带照片完成时原子进入照片墙，普通完成与家庭照片不生成宝宝墙记录', async () => {
  const f = fixture();
  const home = await setup(f);
  const taskId = home.tasks[0].id;
  const date = '2026-10-28';
  await f.service.call('owner', 'complete', { taskId, date, done: true, expectedRevision: 0 });
  assert.equal(await f.repo.get('care_photo_feed', 'home'), null);
  assert.equal((await f.repo.list('care_photo_posts', {}, 10)).length, 0);
  await f.service.call('owner', 'complete', { taskId, date, done: false, expectedRevision: 1 });
  const photoId = 'photo:' + 'b'.repeat(32) + '.jpg';
  await f.repo.put('care_files', hash(photoId), {
    kind: 'completion',
    fileID: photoId,
    ownerId: home.ownerId,
    uploadedBy: home.ownerId,
    taskId,
    date,
  });
  await f.service.call('owner', 'complete', {
    taskId,
    date,
    done: true,
    expectedRevision: 2,
    photoId,
  });
  const snapshot = await f.service.call('owner', 'snapshot');
  const event = snapshot.day.events.at(-1);
  const feed = await f.repo.get('care_photo_feed', 'home');
  assert.ok(feed, '宝宝照片完成后应产生照片墙索引');
  assert.equal(feed.head, event.id);
  const post = await f.repo.get('care_photo_posts', event.id);
  assert.equal(post.source, 'completion');
  assert.equal(post.authorId, home.ownerId);
  assert.equal(post.authorName, '妈妈');
  assert.equal(post.babyId, home.babies[0].id);
  assert.equal(post.taskId, taskId);
  assert.equal(post.date, date);
  assert.deepEqual(post.photoIds, [photoId]);
  await f.service.call('owner', 'saveTask', {
    scope: 'family',
    title: '整理客厅',
    babyIds: [],
    assigneeId: home.ownerId,
    frequency: 'daily',
    startDate: date,
    executionTime: '',
  });
  const familyTask = (await f.service.call('owner', 'snapshot')).home.tasks.find(
    (item) => item.scope === 'family'
  );
  const familyPhoto = 'photo:' + 'c'.repeat(32) + '.png';
  await f.repo.put('care_files', hash(familyPhoto), {
    kind: 'completion',
    fileID: familyPhoto,
    ownerId: home.ownerId,
    uploadedBy: home.ownerId,
    taskId: familyTask.id,
    date,
  });
  await f.service.call('owner', 'complete', {
    taskId: familyTask.id,
    date,
    done: true,
    expectedRevision: 0,
    photoId: familyPhoto,
  });
  const after = await f.service.call('owner', 'snapshot');
  assert.equal(after.day.records[familyTask.id].photoId, familyPhoto);
  assert.equal((await f.repo.get('care_photo_feed', 'home')).head, event.id);
  assert.equal((await f.repo.list('care_photo_posts', {}, 10)).length, 1);
});

test('外人不能抢先创建、伪造管理员、读取家庭、触发定时发送', async () => {
  const f = fixture();
  await assert.rejects(f.service.call('stranger', 'createHome', { name: '坏人' }), /管理员/);
  await setup(f);
  const b = await f.service.call('stranger', 'bootstrap');
  assert.equal(b.member, false);
  assert.equal(b.home, undefined);
  await assert.rejects(f.service.call('stranger', 'snapshot', { actorId: hash('owner') }), /无权/);
  await assert.rejects(f.service.call('stranger', 'tick'), /不支持/);
});

test('未知动作不能把请求文本写入行为日志，合法业务仍记录实际名称和结果', async () => {
  const f = fixture();
  await assert.rejects(f.service.call('owner', 'MySecret'), /不支持/);
  await f.service.call('owner', 'createHome', { name: '妈妈' });
  await assert.rejects(f.service.call('stranger', 'createHome', { name: '外人' }), /管理员/);
  const events = await f.repo.list('care_activity', {}, 10);
  assert.deepEqual(
    events.map(({ name, outcome }) => ({ name, outcome })),
    [
      { name: 'unknown', outcome: 'failure' },
      { name: 'createHome', outcome: 'success' },
      { name: 'createHome', outcome: 'failure' },
    ]
  );
  assert.doesNotMatch(JSON.stringify(events), /MySecret/);
});
test('仅管理员签发的一次性卡片可直接加入；移除后旧卡失效且须重新邀请', async () => {
  const f = fixture();
  await setup(f);
  const invite = await f.service.call('owner', 'makeInvite');
  await f.service.call('dad', 'applyInvite', { token: invite.token, name: '爸爸' });
  await assert.rejects(
    f.service.call('aunt', 'applyInvite', { token: invite.token, name: '阿姨' }),
    /失效/
  );
  const s = await f.service.call('dad', 'snapshot');
  assert.equal(s.home.members.length, 2);
  await assert.rejects(f.service.call('dad', 'makeInvite'), /管理/);
  await f.service.call('owner', 'removeMember', { memberId: s.actorId });
  await assert.rejects(f.service.call('dad', 'snapshot'), /无权/);
  await assert.rejects(
    f.service.call('dad', 'applyInvite', { token: invite.token, name: '爸爸' }),
    /失效/
  );
  const renewed = await f.service.call('owner', 'makeInvite', { name: '爸爸', relation: '爸爸' });
  await f.service.call('dad', 'applyInvite', { token: renewed.token });
  const rejoined = await f.service.call('dad', 'snapshot');
  assert.equal(rejoined.home.members.length, 2);
  assert.equal(rejoined.actorId, s.actorId);
});
test('过期邀请不能申请', async () => {
  const f = fixture();
  await setup(f);
  const invite = await f.service.call('owner', 'makeInvite');
  f.setTime('2026-10-30T02:00:00.000Z');
  await assert.rejects(
    f.service.call('dad', 'applyInvite', { token: invite.token, name: '爸爸' }),
    /失效/
  );
});

test('邀请预填称呼和家庭身份，预览不入家，接受后立即生效无需管理员二次审核', async () => {
  const f = fixture();
  await setup(f);
  const invite = await f.service.call('owner', 'makeInvite', {
    name: ' 晓红 ',
    relation: ' 妈妈 ',
  });
  assert.deepEqual(await f.service.call('mum', 'previewInvite', { token: invite.token }), {
    name: '晓红',
    relation: '妈妈',
  });
  // 预览不能消耗邀请，也不能泄露家庭资料或让申请人直接成为成员。
  await f.service.call('mum', 'previewInvite', { token: invite.token });
  await assert.rejects(f.service.call('mum', 'snapshot'), /无权/);
  await f.service.call('mum', 'applyInvite', { token: invite.token });
  const before = await f.service.call('owner', 'snapshot');
  assert.equal(before.home.members.length, 2);
  assert.deepEqual(before.requests, []);
  await assert.rejects(f.service.call('other', 'previewInvite', { token: invite.token }), /失效/);
  const member = (await f.service.call('mum', 'snapshot')).home.members.find(
    (m) => m.id !== before.actorId
  );
  assert.equal(member.name, '晓红');
  assert.equal(member.relation, '妈妈');
  await assert.rejects(f.service.call('mum', 'makeInvite'), /管理/);
});

test('申请人可确认修改家庭身份，身份文字不会授予管理员权限，旧邀请继续可用', async () => {
  const f = fixture();
  await setup(f);
  const invite = await f.service.call('owner', 'makeInvite', { name: '晓红', relation: '妈妈' });
  await f.service.call('guest', 'applyInvite', {
    token: invite.token,
    name: '外婆',
    relation: '管理员',
  });
  const guest = (await f.service.call('guest', 'snapshot')).home.members.find(
    (m) => m.id === hash('guest').slice(0, 32)
  );
  assert.equal(guest.name, '外婆');
  assert.equal(guest.relation, '管理员');
  await assert.rejects(f.service.call('guest', 'makeInvite'), /管理/);
  const legacy = await f.service.call('owner', 'makeInvite');
  assert.deepEqual(await f.service.call('dad', 'previewInvite', { token: legacy.token }), {
    name: '',
    relation: '',
  });
  await f.service.call('dad', 'applyInvite', { token: legacy.token, name: '爸爸' });
  assert.equal(
    (await f.service.call('dad', 'snapshot')).home.members.find(
      (m) => m.id === hash('dad').slice(0, 32)
    ).relation,
    ''
  );
});

test('邀请资料校验失败不消耗邀请，非法或过期token不返回预填资料', async () => {
  const f = fixture();
  await setup(f);
  for (const data of [{ name: '长'.repeat(13) }, { relation: { role: '妈妈' } }]) {
    await assert.rejects(f.service.call('owner', 'makeInvite', data), /称呼|身份/);
  }
  const invite = await f.service.call('owner', 'makeInvite', { name: '晓红', relation: '妈妈' });
  await assert.rejects(
    f.service.call('mum', 'applyInvite', { token: invite.token, relation: '长'.repeat(13) }),
    /身份/
  );
  assert.equal(
    (await f.service.call('mum', 'previewInvite', { token: invite.token })).name,
    '晓红'
  );
  await assert.rejects(f.service.call('', 'previewInvite', { token: invite.token }), /微信/);
  await assert.rejects(f.service.call('mum', 'previewInvite', { token: 'invalid' }), /邀请/);
  f.setTime('2026-10-30T02:00:00.000Z');
  await assert.rejects(f.service.call('mum', 'previewInvite', { token: invite.token }), /失效/);
});
test('并发定时扫描只发送一次，完成后不再发送', async () => {
  const f = fixture();
  await setup(f);
  await f.service.call('owner', 'subscribe', { accepted: true, templateId: 'template' });
  await Promise.all([f.service.tick(), f.service.tick(), f.service.tick()]);
  assert.equal(f.sends(), 1);
  const snapshot = await f.service.call('owner', 'snapshot');
  assert.equal(snapshot.messages[0].status, 'sent');
});
test('没有接收人订阅授权不会发微信，状态不能冒充成功', async () => {
  const f = fixture();
  const h = await setup(f);
  const result = await f.service.call('owner', 'nudge', {
    taskId: h.tasks[0].id,
    date: '2026-10-28',
  });
  assert.equal(f.sends(), 0);
  assert.equal(result.status, 'no_quota');
});
test('当天已完成的任务不会自动提醒', async () => {
  const f = fixture();
  const h = await setup(f);
  await f.service.call('owner', 'subscribe', { accepted: true, templateId: 'template' });
  await f.service.call('owner', 'complete', {
    taskId: h.tasks[0].id,
    date: '2026-10-28',
    done: true,
    expectedRevision: 0,
  });
  await f.service.tick();
  assert.equal(f.sends(), 0);
});

test('微信返回授权用尽时标记失败，不显示发送成功或无限重试', async () => {
  const f = fixture();
  await setup(f);
  await f.service.call('owner', 'subscribe', { accepted: true, templateId: 'template' });
  f.fail('43101');
  await f.service.tick();
  const snapshot = await f.service.call('owner', 'snapshot');
  assert.equal(snapshot.messages[0].status, 'no_quota');
  assert.equal(snapshot.subscribed, false);
  await f.service.tick();
  assert.equal(f.sends(), 1);
});

test('未知发送失败保留失败状态，不在下一次定时扫描盲目重发', async () => {
  const f = fixture();
  await setup(f);
  await f.service.call('owner', 'subscribe', { accepted: true, templateId: 'template' });
  f.fail('NETWORK');
  await f.service.tick();
  await f.service.tick();
  assert.equal((await f.service.call('owner', 'snapshot')).messages[0].status, 'failed');
  assert.equal(f.sends(), 1);
});

test('成员不能把任意云文件ID作为宝宝头像越权读取', async () => {
  const f = fixture();
  await setup(f);
  await assert.rejects(
    f.service.call('owner', 'saveBaby', {
      name: '二宝',
      avatar: 'cloud://other-family/private.jpg',
    }),
    /头像文件/
  );
  assert.equal((await f.service.call('owner', 'snapshot')).home.babies.length, 1);
});

test('执行时间可选；未设置时再晚也不自动通知', async () => {
  const f = fixture();
  await setup(f, { executionTime: '' });
  await f.service.call('owner', 'subscribe', { accepted: true, templateId: 'template' });
  f.setTime('2026-10-28T15:50:00.000Z');
  await f.service.tick();
  assert.equal(f.sends(), 0);
});

test('无提醒人不发超时通知；只有提醒人而无负责人仍可在到期后通知', async () => {
  const without = fixture();
  await setup(without, { assigneeId: hash('owner').slice(0, 32), notifyMemberId: '' });
  await without.service.call('owner', 'subscribe', { accepted: true, templateId: 'template' });
  await without.service.tick();
  assert.equal(without.sends(), 0);
  const notifyOnly = fixture();
  await setup(notifyOnly, { assigneeId: '', notifyMemberId: hash('owner').slice(0, 32) });
  await notifyOnly.service.call('owner', 'subscribe', { accepted: true, templateId: 'template' });
  await notifyOnly.service.tick();
  assert.equal(notifyOnly.sends(), 1);
});

test('超过执行时间30分钟才通知，29分钟不通知，30分钟后只通知一次', async () => {
  const f = fixture();
  await setup(f, { executionTime: '10:00' });
  await f.service.call('owner', 'subscribe', { accepted: true, templateId: 'template' });
  f.setTime('2026-10-28T02:29:00.000Z');
  await f.service.tick();
  assert.equal(f.sends(), 0);
  f.setTime('2026-10-28T02:30:00.000Z');
  await f.service.tick();
  await f.service.tick();
  assert.equal(f.sends(), 1);
});

test('23点50分安排的任务在次日0点20分仍能触发通知', async () => {
  const f = fixture();
  await setup(f, { executionTime: '23:50' });
  await f.service.call('owner', 'subscribe', { accepted: true, templateId: 'template' });
  f.setTime('2026-10-28T16:19:00.000Z');
  await f.service.tick();
  assert.equal(f.sends(), 0);
  f.setTime('2026-10-28T16:20:00.000Z');
  await f.service.tick();
  assert.equal(f.sends(), 1);
});

test('被通知人与执行人分开选择，消息发送给所选被通知人', async () => {
  const f = fixture();
  const h = await setup(f);
  const invite = await f.service.call('owner', 'makeInvite');
  await f.service.call('dad', 'applyInvite', { token: invite.token, name: '爸爸' });
  const dadId = hash('dad').slice(0, 32);
  await f.service.call('owner', 'complete', {
    taskId: h.tasks[0].id,
    date: '2026-10-28',
    done: true,
    expectedRevision: 0,
  });
  await f.service.call('owner', 'saveTask', {
    scope: 'family',
    title: '家里的事',
    babyIds: [],
    assigneeId: dadId,
    notifyMemberId: h.ownerId,
    frequency: 'daily',
    startDate: '2026-10-28',
    executionTime: '09:00',
  });
  await f.service.call('owner', 'subscribe', { accepted: true, templateId: 'template' });
  await f.service.tick();
  const result = await f.service.call('owner', 'snapshot');
  assert.equal(
    result.messages.find((m) => m.type === 'auto' && m.status === 'sent').recipientId,
    h.ownerId
  );
  assert.equal(f.sends(), 1);
});
