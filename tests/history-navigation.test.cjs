const { test } = require('node:test');
const assert = require('node:assert/strict');
const timeline = require('../miniprogram/pages/index/controllers/timeline');

function page() {
  return {
    ...timeline,
    data: {
      view: 'history',
      date: '2026-10-28',
      today: '2026-10-28',
      createdDate: '2026-10-28',
      filter: 'done',
    },
    targets: [],
    setData(value) {
      Object.assign(this.data, value);
    },
    async refresh(quiet, target) {
      this.targets.push(target);
      Object.assign(this.data, target);
      return true;
    },
  };
}

test('切日请求中切标签不覆写日期，标签切换失败保留原日期和视图', async () => {
  const p = page();
  p.data.date = '2026-10-27';
  p.data.refreshing = true;
  await p.switchTab({ currentTarget: { dataset: { id: 'today' } } });
  assert.equal(p.data.view, 'history');
  assert.equal(p.data.date, '2026-10-27');
  assert.equal(p.targets.length, 0);
  p.data.refreshing = false;
  p.refresh = async () => false;
  await p.switchTab({ currentTarget: { dataset: { id: 'today' } } });
  assert.equal(p.data.view, 'history');
  assert.equal(p.data.date, '2026-10-27');
});

test('家庭创建当天可翻前一天，向右恢复今天，跨月年闰日正确且未来与非法步长拒绝', async () => {
  const p = page(),
    step = async (n) => p.changeDay({ currentTarget: { dataset: { step: n } } });
  await step(-1);
  assert.equal(p.data.date, '2026-10-27');
  assert.equal(p.data.filter, 'all');
  await step(1);
  assert.equal(p.data.date, '2026-10-28');
  const count = p.targets.length;
  for (const n of [1, NaN, Infinity, 0, 2, -2, 'bad']) await step(n);
  assert.equal(p.targets.length, count);
  p.data.date = '2026-01-01';
  await step(-1);
  assert.equal(p.data.date, '2025-12-31');
  p.data.date = '2024-03-01';
  await step(-1);
  assert.equal(p.data.date, '2024-02-29');
});

test('历史切日失败、请求中及提交中不提前把旧记录标成新日期', async () => {
  const p = page();
  p.refresh = async () => false;
  await p.changeDay({ currentTarget: { dataset: { step: -1 } } });
  await p.changeDate({ detail: { value: '2026-10-20' } });
  assert.equal(p.data.date, '2026-10-28');
  for (const flag of ['refreshing', 'busy']) {
    p.data[flag] = true;
    p.refresh = async () => {
      throw Error('unexpected request');
    };
    await p.changeDay({ currentTarget: { dataset: { step: -1 } } });
    p.data[flag] = false;
  }
});

test('历史左右滑动切日，竖向滚动、短触和离开历史页面不触发', async () => {
  const p = page();
  const swipe = async (dx, dy = 0) => {
    p.startHistorySwipe({ touches: [{ clientX: 100, clientY: 100 }] });
    await p.endHistorySwipe({ changedTouches: [{ clientX: 100 + dx, clientY: 100 + dy }] });
  };
  await swipe(100);
  assert.equal(p.data.date, '2026-10-27');
  await swipe(-100);
  assert.equal(p.data.date, '2026-10-28');
  const count = p.targets.length;
  await swipe(20);
  await swipe(70, 100);
  p.data.view = 'today';
  await swipe(100);
  assert.equal(p.targets.length, count);
});
