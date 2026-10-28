const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeBirthday, birthdayOccurrences, birthdayDue } = require('../server/birthdays.cjs');
const controller = require('../miniprogram/pages/index/controllers/birthdays');

test('生日只保留公农历月日和闰月标志，明确清空，拒绝非法日期及伪造字段', () => {
  assert.equal(normalizeBirthday(null), null);
  assert.deepEqual(
    normalizeBirthday({ calendar: 'solar', month: 2, day: 29, leap: false, role: 'owner' }),
    { calendar: 'solar', month: 2, day: 29, leap: false }
  );
  for (const value of [
    {},
    { calendar: 'solar', month: 2, day: 30, leap: false },
    { calendar: 'solar', month: 4, day: 31, leap: false },
    { calendar: 'solar', month: 1, day: 1, leap: true },
    { calendar: 'lunar', month: 13, day: 1, leap: false },
    { calendar: 'lunar', month: 1, day: 31, leap: false },
    { calendar: 'lunar', month: 2, day: 1.5, leap: true },
    { calendar: 'lunar', month: 2, day: 1, leap: 'false' },
    { calendar: 'lunar', month: 12, day: 1, leap: true },
  ])
    assert.throws(() => normalizeBirthday(value), /生日/);
});

test('公历二月二十九在平年按二月二十八，在闰年保留二十九', () => {
  const member = { birthday: { calendar: 'solar', month: 2, day: 29, leap: false } };
  assert.deepEqual(birthdayOccurrences(member, '2023-01-01')[0], {
    date: '2023-02-28',
    birthdayYear: 2023,
  });
  assert.deepEqual(birthdayOccurrences(member, '2024-01-01')[0], {
    date: '2024-02-29',
    birthdayYear: 2024,
  });
  assert.equal(birthdayOccurrences(member, '2024-03-01')[0].date, '2025-02-28');
});

test('农历正月跨春节按农历年计算，不被立春或公历元旦换年影响', () => {
  // 独立期望来自香港天文台2024、2025年公农历对照表。
  const member = { birthday: { calendar: 'lunar', month: 1, day: 1, leap: false } };
  assert.deepEqual(birthdayOccurrences(member, '2024-02-09')[0], {
    date: '2024-02-10',
    birthdayYear: 2024,
  });
  assert.deepEqual(birthdayOccurrences(member, '2024-12-31')[0], {
    date: '2025-01-29',
    birthdayYear: 2025,
  });
});

test('农历闰二月在2023年使用闰月，无该闰月的2024年回落普通二月', () => {
  // 2023-03-22为闰二月初一；2024-03-10为二月初一。
  const member = { birthday: { calendar: 'lunar', month: 2, day: 1, leap: true } };
  assert.equal(birthdayOccurrences(member, '2023-01-01')[0].date, '2023-03-22');
  assert.equal(birthdayOccurrences(member, '2024-01-01')[0].date, '2024-03-10');
  assert.equal(
    birthdayOccurrences(member, '2023-01-01').filter((event) => event.birthdayYear === 2023).length,
    1
  );
});

test('腊月三十在小月按月底二十九，正确跨公历年且不把除夕推到正月', () => {
  const member = { birthday: { calendar: 'lunar', month: 12, day: 30, leap: false } };
  assert.deepEqual(birthdayOccurrences(member, '2024-01-01')[0], {
    date: '2024-02-09',
    birthdayYear: 2023,
  });
  assert.deepEqual(birthdayOccurrences(member, '2025-01-01')[0], {
    date: '2025-01-28',
    birthdayYear: 2024,
  });
});

test('生日候选只含今天及未来，拒绝超出支持年限或无效日期，不生成假生日', () => {
  const member = { birthday: { calendar: 'solar', month: 1, day: 1, leap: false } };
  assert.equal(birthdayOccurrences(member, '2026-01-01')[0].date, '2026-01-01');
  assert.equal(birthdayOccurrences(member, '2026-01-02')[0].date, '2027-01-01');
  assert.deepEqual(birthdayOccurrences({ birthday: null }, '2026-01-01'), []);
  for (const date of ['1899-12-31', '2101-01-01', '2026-02-30'])
    assert.throws(() => birthdayOccurrences(member, date), /日期|年份/);
});

test('生日前三天北京时间10点后向全部有效家人生成稳定提醒，跨年不漏且不补发', () => {
  const home = {
    members: [
      {
        id: 'mom',
        name: '妈妈',
        active: true,
        birthday: { calendar: 'solar', month: 1, day: 1, leap: false },
      },
      { id: 'dad', name: '爸爸', active: true },
      { id: 'removed', name: '已移除', active: false },
    ],
  };
  assert.deepEqual(birthdayDue(home, '2026-12-29T01:59:59.999Z'), []);
  const due = birthdayDue(home, '2026-12-29T02:00:00.000Z');
  assert.deepEqual(due.map((event) => event.recipientId).sort(), ['dad', 'mom']);
  assert.equal(new Set(due.map((event) => event.id)).size, 2);
  assert.deepEqual(
    due.map(({ memberId, date, time, birthdayDate }) => ({ memberId, date, time, birthdayDate })),
    [
      { memberId: 'mom', date: '2026-12-29', time: '10:00', birthdayDate: '2027-01-01' },
      { memberId: 'mom', date: '2026-12-29', time: '10:00', birthdayDate: '2027-01-01' },
    ]
  );
  assert.deepEqual(
    birthdayDue(home, '2026-12-29T15:59:59.999Z').map((event) => event.id),
    due.map((event) => event.id)
  );
  assert.deepEqual(birthdayDue(home, '2026-12-29T16:00:00.000Z'), []);
  home.members[0].active = false;
  assert.deepEqual(birthdayDue(home, '2026-12-29T02:00:00.000Z'), []);
});

test('农历生日提前三天的提醒在春节和除夕边界仍正确', () => {
  const home = {
    members: [
      {
        id: 'mom',
        name: '妈妈',
        active: true,
        birthday: { calendar: 'lunar', month: 1, day: 1, leap: false },
      },
    ],
  };
  assert.equal(birthdayDue(home, '2025-01-26T02:00:00.000Z')[0].birthdayDate, '2025-01-29');
  home.members[0].birthday = { calendar: 'lunar', month: 12, day: 30, leap: false };
  assert.equal(birthdayDue(home, '2025-01-25T02:00:00.000Z')[0].birthdayDate, '2025-01-28');
});

test('生日编辑按管理员或本人开放，提交只取明确表单，失败不关闭', async () => {
  const calls = [];
  const page = {
    ...controller,
    data: {
      owner: false,
      members: [
        { id: 'mom', name: '妈妈', active: true },
        { id: 'dad', name: '爸爸', active: true },
      ],
    },
    _snapshot: { actorId: 'dad' },
    setData(update) {
      Object.assign(this.data, update);
    },
    run: async (action, data) => {
      calls.push({ action, data });
      return null;
    },
    closeModal() {
      this.data.modal = '';
    },
  };
  page.openBirthday({ currentTarget: { dataset: { id: 'mom' } } });
  assert.equal(page.data.modal, undefined);
  page.openBirthday({ currentTarget: { dataset: { id: 'dad' } } });
  assert.equal(page.data.modal, 'birthday');
  assert.equal(page.data.birthdayForm.memberId, 'dad');
  page.changeBirthdayCalendar({ currentTarget: { dataset: { id: 'lunar' } } });
  page.changeBirthdayMonth({ detail: { value: '1' } });
  page.changeBirthdayDay({ detail: { value: '28' } });
  page.changeBirthdayLeap({ detail: { value: true } });
  assert.equal(page.data.birthdayForm.month, 2);
  assert.equal(page.data.birthdayForm.day, 29);
  assert.equal(page.data.birthdayForm.leap, true);
  await page.saveBirthday();
  assert.equal(page.data.modal, 'birthday');
  assert.equal(calls[0].action, 'saveBirthday');
  assert.equal(calls[0].data.memberId, 'dad');
  page.run = async () => ({ message: '已保存' });
  await page.saveBirthday();
  assert.equal(page.data.modal, '');
  page.data.owner = true;
  page.openBirthday({ currentTarget: { dataset: { id: 'mom' } } });
  assert.equal(page.data.birthdayForm.memberId, 'mom');
});

test('明确清空生日失败时保留表单，成功后关闭且不携带身份标签作为权限', async () => {
  const sent = [];
  let success = false;
  const page = {
    ...controller,
    data: { modal: 'birthday', birthdayForm: { memberId: 'mom', role: 'administrator' } },
    run: async (action, data) => {
      sent.push({ action, data });
      return success ? {} : null;
    },
    closeModal() {
      this.data.modal = '';
    },
  };
  await page.clearBirthday();
  assert.equal(page.data.modal, 'birthday');
  assert.deepEqual(sent[0], { action: 'saveBirthday', data: { memberId: 'mom', birthday: null } });
  success = true;
  await page.clearBirthday();
  assert.equal(page.data.modal, '');
});
