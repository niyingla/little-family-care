const { test } = require('node:test');
const assert = require('node:assert/strict');
const api = require('../miniprogram/utils/client');
let definition;
global.Page = (value) => {
  definition = value;
};
require('../miniprogram/pages/index/index');
delete global.Page;

function pageWith(row) {
  return {
    ...definition,
    data: {
      ...definition.data,
      gate: false,
      demo: false,
      rows: [row],
      today: '2026-10-28',
      date: '2026-10-28',
    },
    recordActivity() {},
    setData(update) {
      Object.assign(this.data, update);
    },
    refresh: async () => {},
  };
}

test('管理员先填写身份再生成邀请，卡片不含称呼和家庭身份', async (t) => {
  const originalCall = api.call,
    previousWx = global.wx;
  t.after(() => {
    api.call = originalCall;
    global.wx = previousWx;
  });
  global.wx = { showToast() {} };
  const page = pageWith({});
  page.openInvite();
  assert.equal(page.data.modal, 'invite');
  assert.equal(page.data.inviteToken, '');
  page.data.inviteForm = { name: '晓红', relation: '妈妈' };
  api.call = async (action, data) => {
    assert.equal(action, 'makeInvite');
    assert.deepEqual(data, { name: '晓红', relation: '妈妈' });
    return { token: 'a'.repeat(32) };
  };
  await page.makeInvite();
  const card = page.onShareAppMessage({});
  assert.equal(card.path, '/pages/index/index?invite=' + 'a'.repeat(32));
  assert.doesNotMatch(card.title + card.path, /晓红|妈妈/);
});

test('打开邀请预填称呼和身份，申请提交用户确认后的信息', async (t) => {
  const originalCall = api.call;
  t.after(() => {
    api.call = originalCall;
  });
  const page = pageWith({});
  page.data.gate = true;
  page.data.token = 'b'.repeat(32);
  api.call = async (action, data) => {
    assert.equal(action, 'previewInvite');
    assert.equal(data.token, 'b'.repeat(32));
    return { name: '晓红', relation: '妈妈' };
  };
  await page.loadInvitePreview();
  assert.equal(page.data.joinName, '晓红');
  assert.equal(page.data.joinRelation, '妈妈');
  page.data.joinName = '小红';
  page.data.joinRelation = '家人';
  page.run = async (action, data) => {
    assert.equal(action, 'applyInvite');
    assert.deepEqual(data, { token: 'b'.repeat(32), name: '小红', relation: '家人' });
    return {};
  };
  page.boot = async () => {};
  await page.joinFamily();
});

test('拍照取消和上传失败不误完成，照片上传成功后才关联当天记录', async (t) => {
  const previousWx = global.wx;
  t.after(() => {
    global.wx = previousWx;
  });
  global.wx = { showActionSheet: async () => ({ tapIndex: 0 }) };
  const row = { id: 'c'.repeat(32), scope: 'family', done: false, revision: 0 };
  const page = pageWith(row),
    calls = [];
  page.run = async (...args) => calls.push(args);
  page.chooseCompletionPhoto = async () => null;
  await page.toggle({ currentTarget: { dataset: { id: row.id } } });
  assert.equal(calls.length, 0);
  page.chooseCompletionPhoto = async () => 'photo:' + 'b'.repeat(32) + '.jpg';
  await page.toggle({ currentTarget: { dataset: { id: row.id } } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'complete');
  assert.equal(calls[0][1].photoId, 'photo:' + 'b'.repeat(32) + '.jpg');
  assert.equal(calls[0][1].date, '2026-10-28');
  assert.equal(calls[0][1].done, true);
});

test('切换邀请码后忽略旧请求返回，预填不能覆盖用户已经输入的称呼', async (t) => {
  const originalCall = api.call;
  t.after(() => {
    api.call = originalCall;
  });
  const page = pageWith({});
  page.data.gate = true;
  page.data.token = 'c'.repeat(32);
  let finish;
  api.call = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const pending = page.loadInvitePreview();
  page.data.token = 'd'.repeat(32);
  finish({ name: '旧家人', relation: '妈妈' });
  await pending;
  assert.equal(page.data.joinName, '');
  assert.equal(page.data.joinRelation, '');
  page.data.joinName = '自己填写';
  api.call = async () => ({ name: '管理员预填', relation: '妈妈' });
  await page.loadInvitePreview();
  assert.equal(page.data.joinName, '自己填写');
  assert.equal(page.data.joinRelation, '妈妈');
});

test('完成成功才显示感谢，保存失败和撤销不误报完成；分享不携带成员身份或邀请', async (t) => {
  const previousWx = global.wx,
    previousCall = api.call;
  const toasts = [];
  global.wx = {
    showToast: (value) => toasts.push(value.title),
    showModal: async () => ({ confirm: true }),
    showActionSheet: async () => ({ tapIndex: 1 }),
  };
  t.after(() => {
    global.wx = previousWx;
    api.call = previousCall;
  });
  const row = {
    id: 'b'.repeat(32),
    scope: 'baby',
    subjectName: '朵朵',
    title: '整理外出用品',
    done: false,
    revision: 0,
  };
  const page = pageWith(row);
  api.call = async () => ({ message: '已保存' });
  await page.toggle({ currentTarget: { dataset: { id: row.id } } });
  assert.deepEqual(toasts, ['辛苦了，感谢你对朵朵的付出 ♡']);
  toasts.length = 0;
  api.call = async () => {
    throw new Error('版本冲突');
  };
  await page.toggle({ currentTarget: { dataset: { id: row.id } } });
  assert.deepEqual(toasts, []);
  row.done = true;
  api.call = async () => ({ message: '已保存' });
  await page.toggle({ currentTarget: { dataset: { id: row.id } } });
  assert.deepEqual(toasts, ['已撤销打勾']);
  const card = page.onShareAppMessage({ target: { dataset: { id: row.id } } });
  assert.match(card.title, /整理外出用品/);
  assert.doesNotMatch(card.path, /invite|openid|actorId/);
});

test('B打开任务卡片先通过家庭访问控制，受邀加入后定位事项；旧卡片只读历史', async (t) => {
  const previousWx = global.wx;
  const positions = [];
  global.wx = {
    nextTick: (callback) => callback(),
    pageScrollTo: (value) => positions.push(value.selector),
  };
  t.after(() => {
    global.wx = previousWx;
  });
  const id = 'c'.repeat(32);
  const page = pageWith({ id, scope: 'family' });
  page.receiveSharedTask({ task: id, date: '2026-10-27' });
  page.data.gate = true;
  await page.openSharedTask();
  assert.equal(positions.length, 0);
  assert.ok(page._sharedTask);
  page.data.gate = false;
  const snapshot = { home: { createdDate: '2026-10-01', tasks: [{ id, scope: 'family' }] } };
  page._snapshot = snapshot;
  page.refresh = async (quiet, target) => {
    page.setData(target);
    page._snapshot = { ...snapshot, date: target.date };
    page.data.rows = [{ id, scope: 'family' }];
    return true;
  };
  await page.openSharedTask();
  assert.equal(page.data.view, 'history');
  assert.equal(page.data.scope, 'family');
  assert.equal(page.data.date, '2026-10-27');
  assert.deepEqual(positions, ['#task-' + id]);
});

test('历史分享加载失败保持原日期和数据，保留目标供下拉刷新后定位', async (t) => {
  const previousWx = global.wx,
    previousCall = api.call;
  const positions = [];
  global.wx = {
    showToast() {},
    stopPullDownRefresh() {},
    nextTick: (callback) => callback(),
    pageScrollTo: (value) => positions.push(value.selector),
  };
  t.after(() => {
    global.wx = previousWx;
    api.call = previousCall;
  });
  const id = 'd'.repeat(32);
  const page = pageWith({ id, scope: 'family', done: true });
  page.data.scope = 'family';
  page.refresh = definition.refresh;
  const home = {
    ownerId: 'owner',
    createdDate: '2026-10-01',
    babies: [],
    members: [{ id: 'owner', name: '妈妈', active: true }],
    tasks: [
      {
        id,
        scope: 'family',
        versions: [
          {
            effectiveDate: '2026-10-01',
            startDate: '2026-10-01',
            frequency: 'daily',
            title: '整理外出用品',
            assigneeId: 'owner',
          },
        ],
      },
    ],
  };
  page._snapshot = {
    home,
    date: '2026-10-28',
    actorId: 'owner',
    day: { records: { [id]: { done: true } } },
    messages: [],
  };
  page.receiveSharedTask({ task: id, date: '2026-10-27' });
  api.call = async () => {
    throw new Error('家庭服务暂时连接不上');
  };
  await page.openSharedTask();
  assert.equal(page.data.view, 'today');
  assert.equal(page.data.date, '2026-10-28');
  assert.equal(page.data.rows[0].done, true);
  assert.equal(page._snapshot.date, '2026-10-28');
  assert.deepEqual(page._sharedTask, { id, date: '2026-10-27' });
  assert.equal(page.data.sharedTaskId, '');
  assert.equal(positions.length, 0);
  assert.match(page.data.sharedTaskNotice, /下拉刷新/);
  // 失败后页面及筛选继续对应原日期，不将今日完成状态标成昨日记录。
  page.selectFilter({ currentTarget: { dataset: { id: 'all' } } });
  assert.equal(page.data.rows[0].done, true);
  const requestedDates = [];
  api.call = async (action, { date }) => {
    assert.equal(action, 'snapshot');
    requestedDates.push(date);
    return { home, date, actorId: 'owner', day: null, requests: [], messages: [] };
  };
  await page.onPullDownRefresh();
  assert.equal(page._snapshot.date, '2026-10-27');
  assert.equal(page.data.rows[0].done, false);
  assert.equal(page.data.sharedTaskId, id);
  assert.equal(page._sharedTask, null);
  assert.equal(requestedDates.at(-1), '2026-10-27');
  assert.deepEqual(positions, ['#task-' + id]);
});
