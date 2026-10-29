const { test } = require('node:test');
const assert = require('node:assert/strict');
const api = require('../miniprogram/utils/client');
const d = require('../miniprogram/utils/domain');
let definition;
global.Page = (value) => {
  definition = value;
};
require('../miniprogram/pages/index/index');
delete global.Page;

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function snapshot(date) {
  return {
    date,
    actorId: 'owner',
    day: null,
    requests: [],
    messages: [],
    home: {
      ownerId: 'owner',
      createdDate: date,
      babies: [],
      tasks: [],
      members: [{ id: 'owner', name: '家人', active: true }],
    },
  };
}

function page() {
  const today = d.chinaDate(new Date());
  return {
    ...definition,
    _snapshot: snapshot(today),
    _snapshotLoadedAt: Date.now(),
    data: { ...structuredClone(definition.data), ready: true, gate: false, today, date: today },
    recordActivity() {},
    setData(value) {
      Object.assign(this.data, value);
    },
  };
}
const tab = (id) => ({ currentTarget: { dataset: { id } } });

test('慢同步期间仍立即切换Tab，连续点击不排队回跳，也不额外请求快照', async (t) => {
  const original = api.call,
    response = deferred(),
    p = page();
  t.after(() => {
    api.call = original;
  });
  let calls = 0;
  api.call = () => {
    calls++;
    return response.promise;
  };
  const syncing = p.refresh(true);
  const first = p.navigateTab(tab('family'));
  assert.equal(p.data.view, 'family');
  const last = p.navigateTab(tab('tasks'));
  assert.equal(p.data.view, 'tasks');
  response.resolve(snapshot(p.data.today));
  await Promise.all([syncing, first, last]);
  assert.equal(p.data.view, 'tasks');
  assert.equal(calls, 1);
});

test('复用当前日期快照，反复切Tab不会重复下载快照和头像', async (t) => {
  const original = api.call,
    p = page();
  t.after(() => {
    api.call = original;
  });
  let calls = 0;
  api.call = async () => {
    calls++;
    return snapshot(p.data.today);
  };
  for (let i = 0; i < 30; i++) {
    await p.navigateTab(tab('family'));
    await p.navigateTab(tab('tasks'));
    await p.navigateTab(tab('today'));
  }
  assert.equal(calls, 0);
  assert.equal(p.data.view, 'today');
});

test('历史切日的旧响应不能覆盖之后进入的照片墙，也不能覆盖它的日期', async (t) => {
  const original = api.call,
    pending = deferred(),
    p = page();
  t.after(() => {
    api.call = original;
  });
  api.call = () => pending.promise;
  p.data.view = 'history';
  const previous = d.addDays(p.data.today, -1);
  const changing = p.refresh(false, { date: previous, view: 'history' });
  p.loadPhotoWall = async () => {};
  await p.navigateTab(tab('photos'));
  assert.equal(p.data.view, 'photos');
  pending.resolve(snapshot(previous));
  await changing;
  assert.equal(p.data.view, 'photos');
  assert.equal(p._snapshot.date, p.data.today);
  assert.equal(p.data.date, p.data.today);
});

test('从昨日历史立即进入今天，数据到达前不把昨日完成记录标成今日', async (t) => {
  const original = api.call,
    pending = deferred(),
    p = page();
  const previous = d.addDays(p.data.today, -1);
  p._snapshot = snapshot(previous);
  p.data.view = 'history';
  p.data.date = previous;
  p.data.rows = [{ id: 'old', done: true }];
  p.data.doneCount = 1;
  t.after(() => {
    api.call = original;
  });
  api.call = () => pending.promise;
  const switching = p.navigateTab(tab('today'));
  assert.equal(p.data.view, 'today');
  assert.equal(p.data.timelinePending, true);
  assert.deepEqual(p.data.rows, []);
  p.selectFilter({ currentTarget: { dataset: { id: 'done' } } });
  assert.deepEqual(p.data.rows, []);
  pending.resolve(snapshot(p.data.today));
  await switching;
  assert.equal(p.data.timelinePending, false);
  assert.equal(p._snapshot.date, p.data.today);
});

test('同步时仍可进入照片墙；提交中的操作继续阻止切换', async () => {
  const p = page();
  p.data.refreshing = true;
  p.loadPhotoWall = async () => {};
  await p.navigateTab(tab('photos'));
  assert.equal(p.data.view, 'photos');
  p.data.busy = true;
  await p.navigateTab(tab('family'));
  assert.equal(p.data.view, 'photos');
});

test('过期快照后台补读一次，先切换；旧网络错误不覆盖新页但权限失效仍清空', async (t) => {
  const original = api.call,
    originalWx = global.wx;
  t.after(() => {
    api.call = original;
    global.wx = originalWx;
  });
  global.wx = { showToast() {} };
  for (const denied of [false, true]) {
    const p = page(),
      pending = deferred();
    api.call = () => pending.promise;
    p._snapshotLoadedAt = 0;
    const reading = p.refresh(true);
    // 当前缓存是本家庭的有效日期，切换先使用缓存；授权错误仍由后台收回资料。
    const navigating = p.navigateTab(tab('family'));
    assert.equal(p.data.view, 'family');
    // 网络失败后最新导航需要重试一次；重试也失败时保留当前页和可见错误。
    pending.reject(new Error(denied ? '无权访问家庭' : '网络连接失败'));
    await Promise.all([reading, navigating]);
    assert.equal(p.data.view, 'family');
    assert.equal(p.data.gate, denied);
    if (denied) {
      assert.equal(p._snapshot, null);
      assert.deepEqual(p.data.members, []);
    } else assert.equal(p.data.error, '网络连接失败');
  }
});

test('加载目标日期失败保持空白重试提示，不把旧日期记录重新显示', async (t) => {
  const original = api.call,
    p = page();
  t.after(() => {
    api.call = original;
  });
  p._snapshot = snapshot(d.addDays(p.data.today, -1));
  p.data.view = 'history';
  api.call = async () => {
    throw Error('网络连接失败');
  };
  await p.navigateTab(tab('today'));
  assert.equal(p.data.view, 'today');
  assert.equal(p.data.timelinePending, true);
  assert.equal(p.data.refreshing, false);
  assert.deepEqual(p.data.rows, []);
  assert.equal(p.data.error, '网络连接失败');
});
