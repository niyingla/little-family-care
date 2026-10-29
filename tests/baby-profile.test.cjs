const { test } = require('node:test');
const assert = require('node:assert/strict');
const d = require('../miniprogram/utils/domain');
const family = require('../miniprogram/pages/index/controllers/family');

test('照片月龄按记录当天计算，覆盖月底、闰年、出生当天和未来日期', () => {
  for (const [birth, date, expected] of [
    ['2026-10-28', '2026-10-28', '出生当天'],
    ['2026-10-01', '2026-10-28', '出生27天'],
    ['2026-01-31', '2026-02-28', '1个月'],
    ['2026-01-31', '2026-03-01', '1个月1天'],
    ['2024-02-29', '2025-02-28', '1岁'],
    ['2024-08-20', '2026-10-28', '2岁2个月8天'],
    ['', '2026-10-28', ''],
    ['2026-10-29', '2026-10-28', ''],
    ['2026-02-30', '2026-10-28', ''],
  ])
    assert.equal(d.babyAgeLabel(birth, date), expected);
});

test('宝宝出生日期可新增、保留和清空，拒绝未来日期且不更改原资料', () => {
  const h = d.createHome('owner', '妈妈', '2026-10-28');
  const save = (home, data) =>
    d.transition(home, null, 'owner', 'saveBaby', data, '2026-10-28T04:00:00Z', () => 'baby').home;
  const created = save(h, { name: '宝宝', birthDate: '2026-02-28' });
  assert.equal(created.babies[0].birthDate, '2026-02-28');
  assert.equal(save(created, { babyId: 'baby', name: '新名字' }).babies[0].birthDate, '2026-02-28');
  assert.equal(
    save(created, { babyId: 'baby', name: '宝宝', birthDate: '' }).babies[0].birthDate,
    ''
  );
  for (const value of ['2026-10-29', '2026-02-30', null, 20261001])
    assert.throws(
      () => save(created, { babyId: 'baby', name: '宝宝', birthDate: value }),
      /出生日期/
    );
  assert.equal(created.babies[0].birthDate, '2026-02-28');
});

test('头像预览只使用当前家人和宝宝的展示图片，空头像不打开选择器', async (t) => {
  const previous = global.wx;
  const previews = [];
  global.wx = { previewImage: async (value) => previews.push(value), showToast() {} };
  t.after(() => {
    global.wx = previous;
  });
  const page = {
    data: {
      babies: [{ id: 'b', picture: '/baby.jpg' }],
      members: [{ id: 'm', picture: '/member.jpg' }, { id: 'empty' }],
    },
  };
  for (const [kind, id] of [
    ['baby', 'b'],
    ['member', 'm'],
    ['member', 'empty'],
    ['baby', 'other'],
  ])
    await family.previewFamilyAvatar.call(page, {
      currentTarget: { dataset: { kind, id, url: '/untrusted' } },
    });
  assert.deepEqual(previews, [
    { current: '/baby.jpg', urls: ['/baby.jpg'] },
    { current: '/member.jpg', urls: ['/member.jpg'] },
  ]);
});

test('个人资料编辑主动展开、成功收起、保存失败保留输入，忙碌时不折叠', async () => {
  const page = {
    data: { profileEditorOpen: false, profileName: '妈妈', busy: false },
    setData(value) {
      Object.assign(this.data, value);
    },
    run: async () => false,
  };
  family.toggleProfileEditor.call(page);
  assert.equal(page.data.profileEditorOpen, true);
  await family.saveProfile.call(page);
  assert.equal(page.data.profileEditorOpen, true);
  page.run = async () => true;
  await family.saveProfile.call(page);
  assert.equal(page.data.profileEditorOpen, false);
  page.data.busy = true;
  family.toggleProfileEditor.call(page);
  assert.equal(page.data.profileEditorOpen, false);
});
