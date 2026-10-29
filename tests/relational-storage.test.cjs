const { test } = require('node:test');
const assert = require('node:assert/strict');
let model;
try {
  model = require('../selfhost/relational/model.cjs');
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

test('家庭资料拆为独立成员、宝宝、任务及版本表，往返保留顺序、空值与出生日期', () => {
  assert.ok(model, '独立业务表映射尚未实现');
  const home = {
    id: 'home',
    ownerId: 'mum',
    version: 4,
    createdDate: '2026-10-28',
    members: [
      { id: 'mum', name: '妈妈', active: true, birthday: null },
      {
        id: 'dad',
        name: '爸爸',
        active: false,
        birthday: { calendar: 'lunar', month: 8, day: 10, leap: false },
      },
    ],
    babies: [{ id: 'baby', name: '宝宝', birthDate: '2026-01-31', avatar: '', color: 'sage' }],
    tasks: [
      {
        id: 'task',
        scope: 'baby',
        babyId: 'baby',
        pinned: false,
        followers: ['dad'],
        versions: [
          {
            title: '打疫苗',
            assigneeId: '',
            notifyMemberId: '',
            frequency: 'once',
            interval: 1,
            weekdays: [],
            startDate: '2026-11-04',
            effectiveDate: '2026-10-28',
            executionTime: '10:00',
            archived: false,
          },
        ],
      },
    ],
  };
  const rows = model.encodeDocument('care_home', 'home', home);
  assert.deepEqual(
    [...new Set(rows.map((r) => r.table))],
    [
      'care_families',
      'care_members',
      'care_member_birthdays',
      'care_babies',
      'care_tasks',
      'care_task_versions',
      'care_task_followers',
    ]
  );
  assert.equal(rows.find((r) => r.table === 'care_babies').values.birth_date, '2026-01-31');
  assert.equal(rows.find((r) => r.table === 'care_task_versions').values.execution_time, '10:00');
  assert.deepEqual(model.decodeDocument('care_home', 'home', rows), home);
  assert.ok(rows.every((r) => !('body' in r.values)));
});

test('每日状态与追加执行流水分别落表，撤销、催办和照片关联不丢失', () => {
  assert.ok(model, '独立业务表映射尚未实现');
  const day = {
    date: '2026-10-28',
    records: {
      task: {
        revision: 2,
        done: false,
        completedAt: '',
        completedBy: '',
        completedByName: '',
        photoId: '',
      },
    },
    events: [
      {
        id: 'e1',
        type: 'complete',
        taskId: 'task',
        actorName: '妈妈',
        at: '2026-10-28T01:00:00Z',
        title: '喂奶',
        subjectName: '宝宝',
        photoId: 'photo:one',
      },
      {
        id: 'e2',
        type: 'undo',
        taskId: 'task',
        actorName: '妈妈',
        at: '2026-10-28T02:00:00Z',
        title: '喂奶',
        subjectName: '宝宝',
        photoId: '',
      },
    ],
    nudges: { 'task:dad': '2026-10-28T03:00:00Z' },
  };
  const rows = model.encodeDocument('care_days', day.date, day);
  assert.ok(rows.some((r) => r.table === 'care_executions'));
  assert.equal(rows.filter((r) => r.table === 'care_execution_events').length, 2);
  assert.deepEqual(model.decodeDocument('care_days', day.date, rows), day);
});

test('正式与审核命名空间隔离，未知类别或新增未映射字段必须阻断迁移', () => {
  assert.ok(model, '独立业务表映射尚未实现');
  const rows = model.encodeDocument('review_care_users', 'same', {
    openid: 'test',
    subscribed: false,
  });
  assert.equal(model.decodeDocument('care_users', 'same', rows), null);
  assert.deepEqual(model.decodeDocument('review_care_users', 'same', rows), {
    openid: 'test',
    subscribed: false,
  });
  assert.throws(() => model.encodeDocument('care_unmapped', 'one', {}), /未映射/);
  assert.throws(
    () => model.encodeDocument('care_users', 'one', { openid: 'x', futureField: 'keep' }),
    /未映射/
  );
  assert.throws(() => model.encodeDocument('care_users; DROP TABLE x', 'one', {}), /未映射/);
});

test('照片文件拆为二进制大字段，迁移前后原字节完全相同', () => {
  assert.ok(model, '独立业务表映射尚未实现');
  const photo = { base64: Buffer.from([0xff, 0xd8, 0, 13, 10, 0xff]).toString('base64') };
  const rows = model.encodeDocument('care_avatar_blobs', 'photo.jpg', photo);
  assert.ok(Buffer.isBuffer(rows[0].values.image_bytes));
  assert.deepEqual(model.decodeDocument('care_avatar_blobs', 'photo.jpg', rows), photo);
});

test('生日、星期、上传目标和结果均逐列保存，字段存在标记也不保存JSON', () => {
  const home = {
    id: 'home',
    members: [{ id: 'mum', birthday: { calendar: 'lunar', month: 8, day: 10, leap: false } }],
    tasks: [{ id: 'task', versions: [{ weekdays: [1, 3] }] }],
  };
  const rows = model.encodeDocument('care_home', 'home', home);
  const birthday = rows.find((r) => r.table === 'care_member_birthdays').values;
  assert.equal(birthday.calendar, 'lunar');
  assert.equal(birthday.month, 8);
  assert.equal(birthday.day, 10);
  assert.equal(birthday.is_leap, 0);
  assert.deepEqual(
    rows.filter((r) => r.table === 'care_task_weekdays').map((r) => r.values.weekday),
    [1, 3]
  );
  assert.ok(rows.every((r) => typeof r.values.field_mask === 'number'));
  assert.deepEqual(model.decodeDocument('care_home', 'home', rows), home);
  const upload = {
    metadata: { scope: 'baby', babyId: 'baby' },
    result: { photoId: 'photo:one', message: '完成' },
  };
  const saved = model.encodeDocument('care_uploads', 'upload', upload);
  assert.equal(saved.find((r) => r.table === 'care_upload_targets').values.baby_id, 'baby');
  assert.equal(saved.find((r) => r.table === 'care_upload_results').values.photo_id, 'photo:one');
  assert.deepEqual(model.decodeDocument('care_uploads', 'upload', saved), upload);
});
