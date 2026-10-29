const { test } = require('node:test');
const assert = require('node:assert/strict');
const { instrumentPage } = require('../miniprogram/utils/activity-client');

test('异步切页保持原Promise，只有成功切到真实新view之后才记录页面访问', async () => {
  let finish;
  const result = { loaded: true },
    pending = new Promise((resolve) => {
      finish = resolve;
    });
  const events = [];
  const page = instrumentPage({
    data: { view: 'today', gate: false },
    recordActivity(event) {
      events.push(event);
    },
    switchTab() {
      return pending;
    },
  });
  const returned = page.switchTab({ currentTarget: { dataset: { id: 'history' } } });
  assert.equal(returned, pending);
  assert.deepEqual(events, [{ kind: 'click', name: 'switchTab', view: 'today' }]);
  page.data.view = 'history';
  finish(result);
  assert.equal(await returned, result);
  assert.deepEqual(events.at(-1), { kind: 'page_view', view: 'history' });
});

test('异步切页失败或未改变view不误记新页面，原拒绝对象和返回值继续交给调用方', async () => {
  for (const reject of [false, true]) {
    const events = [],
      error = new Error('查询失败');
    const pending = reject ? Promise.reject(error) : Promise.resolve(false);
    const page = instrumentPage({
      data: { view: 'today', gate: false },
      recordActivity(event) {
        events.push(event);
      },
      switchTab() {
        return pending;
      },
    });
    const returned = page.switchTab();
    assert.equal(returned, pending);
    if (reject) await assert.rejects(returned, (actual) => actual === error);
    else assert.equal(await returned, false);
    assert.deepEqual(events, [{ kind: 'click', name: 'switchTab', view: 'today' }]);
  }
});

test('标签已立即切换时先记访问，不等后台同步，也不在旧Promise结束后重复记新页', async () => {
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const events = [];
  const page = instrumentPage({
    data: { view: 'today', gate: false },
    recordActivity(event) {
      events.push(event);
    },
    switchTab() {
      this.data.view = 'family';
      return pending;
    },
  });
  assert.equal(page.switchTab(), pending);
  assert.deepEqual(events.at(-1), { kind: 'page_view', view: 'family' });
  page.data.view = 'tasks';
  finish(true);
  await pending;
  assert.equal(events.filter((event) => event.kind === 'page_view').length, 1);
});

test('同步切页仍同步返回原值并记录切换后的页面，不额外包装成Promise', () => {
  const events = [];
  const page = instrumentPage({
    data: { view: 'today', gate: false },
    recordActivity(event) {
      events.push(event);
    },
    switchTab() {
      this.data.view = 'tasks';
      return 42;
    },
  });
  assert.equal(page.switchTab(), 42);
  assert.deepEqual(events.at(-1), { kind: 'page_view', view: 'tasks' });
});
