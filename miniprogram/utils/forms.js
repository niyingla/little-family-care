const d = require('./domain');
// 每次返回新对象，避免关闭表单后复用上次编辑留下的数组引用。
exports.emptyTask = () => ({
  scope: 'baby',
  title: '',
  babyIds: [],
  assigneeId: '',
  frequency: 'daily',
  interval: 2,
  weekdays: [1, 3, 5],
  startDate: d.chinaDate(new Date()),
  executionTime: '',
  notifyMemberId: '',
});
