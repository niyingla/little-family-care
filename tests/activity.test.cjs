const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createActivityRecorder } = require('../server/activity.cjs');

test('行为记录使用服务端身份和时间，客户端只能报告白名单页面与点击且不保存输入内容', async () => {
  const records = [];
  const recorder = createActivityRecorder({
    repo: { put: async (collection, id, value) => records.push({ collection, id, ...value }) },
    now: () => '2026-10-28T12:00:00.000Z',
    randomId: () => String(records.length),
  });
  await recorder.client('trusted-member', {
    events: [
      {
        kind: 'click',
        name: 'toggle',
        view: 'today',
        actorId: 'forged',
        password: 'private',
        title: 'private task',
      },
    ],
  });
  assert.equal(records[0].actorId, 'trusted-member');
  assert.equal(records[0].at, '2026-10-28T12:00:00.000Z');
  assert.equal(records[0].source, 'client');
  assert.equal(records[0].outcome, 'observed');
  assert.doesNotMatch(JSON.stringify(records), /forged|password|private task/);
  await assert.rejects(
    recorder.client('trusted-member', {
      events: [{ kind: 'business', name: 'complete', view: 'today', outcome: 'success' }],
    }),
    /事件/
  );
  await assert.rejects(
    recorder.client('trusted-member', {
      events: [{ kind: 'click', name: 'unknown-handler', view: 'today' }],
    }),
    /事件/
  );
  await assert.rejects(
    recorder.client('trusted-member', {
      events: Array(21).fill({ kind: 'page_view', view: 'today' }),
    }),
    /数量/
  );
});

test('写日志失败不会把已经成功的业务变成失败，也不会记录数据库异常中的敏感内容', async (t) => {
  const warnings = [];
  const previous = console.warn;
  console.warn = (...args) => warnings.push(args);
  t.after(() => {
    console.warn = previous;
  });
  const recorder = createActivityRecorder({
    repo: {
      put: async () => {
        throw Object.assign(new Error('password=private-value'), { code: 'ER_TEST' });
      },
    },
    now: () => new Date().toISOString(),
    randomId: () => 'id',
  });
  assert.equal(
    await recorder.record({ kind: 'login', name: 'login', source: 'server', outcome: 'failure' }),
    false
  );
  assert.doesNotMatch(JSON.stringify(warnings), /private-value/);
});
