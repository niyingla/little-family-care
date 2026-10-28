const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  completionMessage,
  shareTaskCard,
  readSharedTask,
} = require('../miniprogram/utils/task-feedback');

test('宝宝和家庭完成后分别感谢付出，分享卡片包含具体事项和对应日期', () => {
  assert.equal(
    completionMessage({ scope: 'baby', subjectName: '朵朵' }),
    '辛苦了，感谢你对朵朵的付出 ♡'
  );
  assert.equal(
    completionMessage({ scope: 'family', subjectName: '全家' }),
    '辛苦了，感谢你对家庭的付出 ♡'
  );
  const card = shareTaskCard({ id: 'a'.repeat(32), title: '整理外出用品' }, '2026-10-28');
  assert.match(card.title, /整理外出用品/);
  assert.equal(card.path, '/pages/index/index?task=' + 'a'.repeat(32) + '&date=2026-10-28');
  // 卡片仅传递定位信息，不夹带邀请、角色或个人身份来绕过成员审批。
  assert.doesNotMatch(card.path, /invite|openid|owner|role/);
  assert.deepEqual(readSharedTask({ task: 'a'.repeat(32), date: '2026-10-28' }, '2026-10-28'), {
    id: 'a'.repeat(32),
    date: '2026-10-28',
  });
  assert.equal(readSharedTask({ task: '../../private', date: '2026-10-28' }, '2026-10-28'), null);
  assert.equal(readSharedTask({ task: 'a'.repeat(32), date: '2026-10-29' }, '2026-10-28'), null);
});
