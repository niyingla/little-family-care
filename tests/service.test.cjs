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
test('邀请只能申请一次，未经审批不能读数据；审批和移除后权限即时变化', async () => {
  const f = fixture();
  await setup(f);
  const invite = await f.service.call('owner', 'makeInvite');
  await f.service.call('dad', 'applyInvite', { token: invite.token, name: '爸爸' });
  await assert.rejects(
    f.service.call('aunt', 'applyInvite', { token: invite.token, name: '阿姨' }),
    /失效/
  );
  await assert.rejects(f.service.call('dad', 'snapshot'), /无权/);
  await assert.rejects(
    f.service.call('dad', 'reviewInvite', { requestId: hash('dad').slice(0, 32), approve: true }),
    /无权/
  );
  await f.service.call('owner', 'reviewInvite', {
    requestId: hash('dad').slice(0, 32),
    approve: true,
  });
  const s = await f.service.call('dad', 'snapshot');
  assert.equal(s.home.members.length, 2);
  await assert.rejects(f.service.call('dad', 'makeInvite'), /管理/);
  await f.service.call('owner', 'removeMember', { memberId: s.actorId });
  await assert.rejects(f.service.call('dad', 'snapshot'), /无权/);
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
  await f.service.call('owner', 'reviewInvite', { requestId: dadId, approve: true });
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
