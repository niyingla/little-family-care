const { test } = require('node:test');
const assert = require('node:assert/strict');
const d = require('../miniprogram/utils/domain');

const now = '2026-10-28T01:00:00.000Z';
let seq = 0;
const id = () => `id${++seq}`;
function home() {
  const h = d.createHome('owner', '我', '2026-10-26');
  h.members.push({ id: 'dad', name: '爸爸', active: true });
  h.babies.push(
    { id: 'b1', name: '大宝', avatar: '', color: 'peach' },
    { id: 'b2', name: '二宝', avatar: '', color: 'sage' }
  );
  return h;
}
function task(h, extra = {}) {
  return d.transition(
    h,
    null,
    'owner',
    'saveTask',
    {
      babyIds: ['b1'],
      title: '整理用品',
      assigneeId: 'dad',
      frequency: 'daily',
      interval: 2,
      weekdays: [1, 3, 5],
      startDate: '2026-10-28',
      executionTime: '09:00',
      ...extra,
    },
    now,
    id
  ).home;
}

test('北京时间跨日，不跟随云函数或手机的系统时区', () => {
  assert.equal(d.chinaDate('2026-10-28T16:01:00Z'), '2026-10-29');
  assert.equal(d.chinaTime('2026-10-28T16:01:00Z'), '00:01');
});
test('隔一天按开始日期跨月计算，漏做不移动周期', () => {
  const rule = { frequency: 'interval', interval: 2, startDate: '2026-10-28', weekdays: [] };
  assert.equal(d.isDue(rule, '2026-10-27'), false);
  assert.equal(d.isDue(rule, '2026-10-28'), true);
  assert.equal(d.isDue(rule, '2026-10-29'), false);
  assert.equal(d.isDue(rule, '2026-11-01'), true);
});
test('按星期执行，周日是7，开始日期之前不生成', () => {
  const rule = { frequency: 'weekly', weekdays: [3, 7], startDate: '2026-10-28' };
  assert.equal(d.isDue(rule, '2026-10-28'), true);
  assert.equal(d.isDue(rule, '2026-11-01'), true);
  assert.equal(d.isDue(rule, '2026-10-29'), false);
});
test('同一任务给两个宝宝创建后，完成状态相互独立', () => {
  const h = task(home(), { babyIds: ['b1', 'b2'] });
  const rows = d.rowsForDate(h, null, '2026-10-28');
  assert.equal(rows.length, 2);
  const result = d.transition(
    h,
    null,
    'dad',
    'complete',
    { taskId: rows[0].id, date: '2026-10-28', expectedRevision: 0, done: true },
    now,
    id
  );
  const actual = d.rowsForDate(result.home, result.day, '2026-10-28');
  assert.equal(actual[0].done, true);
  assert.equal(actual[0].completedByName, '爸爸');
  assert.equal(actual[1].done, false);
});
test('编辑从次日生效；更名、归档不覆盖过去的应做和完成记录', () => {
  let h = task(home());
  const t = h.tasks[0];
  h = d.transition(
    h,
    null,
    'owner',
    'saveTask',
    {
      taskId: t.id,
      babyIds: ['b1'],
      title: '新的用品任务',
      assigneeId: 'dad',
      frequency: 'daily',
      startDate: '2026-10-28',
      executionTime: '10:00',
    },
    now,
    id
  ).home;
  assert.equal(d.rowsForDate(h, null, '2026-10-28')[0].title, '整理用品');
  assert.equal(d.rowsForDate(h, null, '2026-10-29')[0].title, '新的用品任务');
  h = d.transition(h, null, 'owner', 'archiveTask', { taskId: t.id }, now, id).home;
  assert.equal(d.rowsForDate(h, null, '2026-10-28').length, 1);
  assert.equal(d.rowsForDate(h, null, '2026-10-29').length, 0);
});
test('未邀请和已移除的成员无法读取或操作家庭数据', () => {
  const h = task(home());
  assert.throws(() => d.assertMember(h, 'stranger'), /无权/);
  assert.throws(
    () => d.transition(h, null, 'dad', 'removeMember', { memberId: 'owner' }, now, id),
    /管理/
  );
  h.members[1].active = false;
  assert.throws(
    () =>
      d.transition(
        h,
        null,
        'dad',
        'complete',
        { taskId: h.tasks[0].id, date: '2026-10-28' },
        now,
        id
      ),
    /无权/
  );
});
test('不能覆盖其他家人刚完成的状态，撤销必须匹配版本', () => {
  const h = task(home());
  const data = { taskId: h.tasks[0].id, date: '2026-10-28', expectedRevision: 0, done: true };
  const first = d.transition(h, null, 'dad', 'complete', data, now, id);
  assert.throws(
    () =>
      d.transition(first.home, first.day, 'owner', 'complete', { ...data, done: false }, now, id),
    /已更新/
  );
  const undo = d.transition(
    first.home,
    first.day,
    'dad',
    'complete',
    { ...data, done: false, expectedRevision: 1 },
    now,
    id
  );
  assert.equal(d.rowsForDate(undo.home, undo.day, data.date)[0].done, false);
  assert.deepEqual(
    undo.day.events.map((e) => e.type),
    ['complete', 'undo']
  );
});
test('过去和未来的打勾被拒绝，不把漏做冒充按时完成', () => {
  const h = task(home());
  for (const date of ['2026-10-27', '2026-10-29']) {
    assert.throws(
      () =>
        d.transition(
          h,
          null,
          'dad',
          'complete',
          { taskId: h.tasks[0].id, date, done: true },
          now,
          id
        ),
      /当天/
    );
  }
});
test('催办完成任务被拒绝，重复催办有10分钟冷却', () => {
  const h = task(home());
  const data = { taskId: h.tasks[0].id, date: '2026-10-28' };
  const reminded = d.transition(h, null, 'owner', 'nudge', data, now, id);
  assert.equal(reminded.result.recipientId, 'dad');
  assert.throws(() => d.transition(h, reminded.day, 'owner', 'nudge', data, now, id), /稍后/);
  const done = d.transition(
    h,
    reminded.day,
    'dad',
    'complete',
    { ...data, done: true, expectedRevision: 0 },
    now,
    id
  );
  assert.throws(() => d.transition(h, done.day, 'owner', 'nudge', data, now, id), /完成/);
});
test('没有家庭成员的名字或无效日期、间隔、星期不得创建任务', () => {
  for (const extra of [
    { assigneeId: 'stranger' },
    { frequency: 'interval', interval: 0 },
    { frequency: 'weekly', weekdays: [] },
    { startDate: '2026-02-30' },
    { executionTime: '25:00' },
  ]) {
    assert.throws(() => task(home(), extra));
  }
});

test('负责人和提醒人可分别留空，显式清空提醒人不重新回退负责人', () => {
  const empty = task(home(), { assigneeId: '', notifyMemberId: '' });
  const row = d.rowsForDate(empty, null, '2026-10-28')[0];
  assert.equal(row.assigneeId, '');
  assert.equal(row.assigneeName, '');
  assert.equal(row.notifyMemberId, '');
  assert.equal(row.notifyMemberName, '');
  assert.equal(
    d.transition(
      empty,
      null,
      'dad',
      'complete',
      { taskId: row.id, date: '2026-10-28', done: true, expectedRevision: 0 },
      now,
      id
    ).day.records[row.id].done,
    true
  );
  const assigned = task(home(), { assigneeId: 'dad', notifyMemberId: '' });
  assert.equal(d.rowsForDate(assigned, null, '2026-10-28')[0].notifyMemberId, '');
  assert.throws(
    () =>
      d.transition(
        assigned,
        null,
        'owner',
        'nudge',
        { taskId: assigned.tasks[0].id, date: '2026-10-28' },
        now,
        id
      ),
    /通知/
  );
  const notifyOnly = task(home(), { assigneeId: '', notifyMemberId: 'owner' });
  assert.equal(
    d.transition(
      notifyOnly,
      null,
      'dad',
      'nudge',
      { taskId: notifyOnly.tasks[0].id, date: '2026-10-28' },
      now,
      id
    ).result.recipientId,
    'owner'
  );
});
test('移除执行人后任务标记为待分配，不再向被移除的人发提醒', () => {
  const h = task(home());
  const removed = d.transition(h, null, 'owner', 'removeMember', { memberId: 'dad' }, now, id);
  const row = d.rowsForDate(removed.home, null, '2026-10-28')[0];
  assert.equal(row.assigneeName, '待重新分配');
  assert.throws(
    () =>
      d.transition(
        removed.home,
        null,
        'owner',
        'nudge',
        { taskId: row.id, date: '2026-10-28' },
        now,
        id
      ),
    /分配/
  );
});
test('未打开过的历史日期也能重建漏做清单，创建之前没有任务', () => {
  const h = task(home());
  assert.equal(d.rowsForDate(h, null, '2026-10-29').length, 1);
  assert.equal(d.rowsForDate(h, null, '2026-10-27').length, 0);
});

test('家庭事项不绑定宝宝；宝宝事项仍需有效宝宝，各自历史独立', () => {
  const h = task(home(), { scope: 'family', babyIds: [], title: '整理客厅' });
  const result = d.rowsForDate(h, null, '2026-10-28');
  assert.equal(result.length, 1);
  assert.equal(result[0].scope, 'family');
  assert.equal(result[0].subjectName, '全家');
  assert.equal(Object.hasOwn(result[0], 'babyId'), false);
  const both = task(h, { scope: 'baby', title: '整理宝宝衣物' });
  const rows = d.rowsForDate(both, null, '2026-10-28');
  assert.equal(rows.filter((r) => r.scope === 'family').length, 1);
  assert.equal(rows.filter((r) => r.scope === 'baby').length, 1);
});

test('仅一次的家庭事项只出现在指定日期，不变成每天重复', () => {
  const h = task(home(), {
    scope: 'family',
    babyIds: [],
    frequency: 'once',
    startDate: '2026-10-29',
  });
  assert.equal(d.rowsForDate(h, null, '2026-10-28').length, 0);
  assert.equal(d.rowsForDate(h, null, '2026-10-29').length, 1);
  assert.equal(d.rowsForDate(h, null, '2026-10-30').length, 0);
});

test('未来具体日期与时间可提前安排，仅在指定当天进入待办清单', () => {
  const planned = task(home(), {
    frequency: 'once',
    startDate: '2026-11-04',
    executionTime: '10:00',
    title: '打疫苗',
    assigneeId: '',
    notifyMemberId: '',
  });
  assert.equal(d.rowsForDate(planned, null, '2026-10-28').length, 0);
  assert.equal(d.rowsForDate(planned, null, '2026-11-03').length, 0);
  const due = d.rowsForDate(planned, null, '2026-11-04');
  assert.equal(due.length, 1);
  assert.equal(due[0].title, '打疫苗');
  assert.equal(due[0].executionTime, '10:00');
  assert.equal(d.rowsForDate(planned, null, '2026-11-05').length, 0);
});

test('重要事项置顶优先于时间排序，取消置顶恢复原顺序且不改执行周期', () => {
  let h = task(home(), {
    scope: 'family',
    babyIds: [],
    title: '早上的家务',
    executionTime: '08:00',
  });
  h = task(h, { scope: 'family', babyIds: [], title: '重要的家庭安排', executionTime: '20:00' });
  const importantId = h.tasks[1].id;
  const pinned = d.transition(
    h,
    null,
    'owner',
    'setPinned',
    { taskId: importantId, pinned: true },
    now,
    id
  ).home;
  const rows = d.rowsForDate(pinned, null, '2026-10-28');
  assert.equal(rows[0].title, '重要的家庭安排');
  assert.equal(rows[0].pinned, true);
  assert.equal(d.rowsForDate(pinned, null, '2026-10-29').length, 2);
  const unpinned = d.transition(
    pinned,
    null,
    'owner',
    'setPinned',
    { taskId: importantId, pinned: false },
    now,
    id
  ).home;
  assert.equal(d.rowsForDate(unpinned, null, '2026-10-28')[0].title, '早上的家务');
});
