const { test } = require('node:test');
const assert = require('node:assert/strict');
const handlers = require('../miniprogram/pages/index/controllers/tasks');

test('编辑已离家执行人的任务时明确提示重新选择，不把管理员显示成已分配', () => {
  const page = {
    ...handlers,
    data: {
      babies: [{ id: 'baby', name: '大宝' }],
      members: [{ id: 'owner', name: '妈妈' }],
      today: '2026-10-28',
      week: [],
    },
    _snapshot: {
      actorId: 'owner',
      home: {
        tasks: [
          {
            id: 'task',
            babyId: 'baby',
            versions: [
              {
                effectiveDate: '2026-10-28',
                title: '整理用品',
                assigneeId: 'removed',
                weekdays: [],
              },
            ],
          },
        ],
      },
    },
    setData(update) {
      for (const [path, value] of Object.entries(update)) {
        const parts = path.split('.');
        let target = this.data;
        for (const part of parts.slice(0, -1)) target = target[part];
        target[parts.at(-1)] = value;
      }
    },
  };
  page.openTask({ currentTarget: { dataset: { id: 'task' } } });
  assert.equal(page.data.taskMembers[page.data.memberIndex].id, '');
  page.chooseMember({ detail: { value: '1' } });
  assert.equal(page.data.form.assigneeId, 'owner');
});
