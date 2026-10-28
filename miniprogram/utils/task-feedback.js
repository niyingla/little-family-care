const d = require('./domain');

/**
 * 为实际完成操作提供轻提示，家庭事项不错误套用某位宝宝的名称。
 * @param {object} row 当前已获授权读取的任务行，含scope和subjectName。
 * @returns {string} 仅在完成成功后显示的感谢文案。
 */
function completionMessage(row) {
  const subject = row.scope === 'family' ? '家庭' : row.subjectName || '宝宝';
  return `辛苦了，感谢你对${subject}的付出 ♡`;
}

/**
 * 创建用户手动转发的具体事项卡片，不通过分享赋予家庭访问权限。
 * @param {object} row 当前家人有权读取的任务，id来自服务端。
 * @param {string} date 事项对应的北京时间日期，避免旧卡片误指向新一天。
 * @returns {object} 微信分享标题及只包含任务定位信息的页面路径。
 */
function shareTaskCard(row, date) {
  return {
    title: `记得：${String(row.title).slice(0, 45)} ♡`,
    path: `/pages/index/index?task=${encodeURIComponent(row.id)}&date=${date}`,
  };
}

/**
 * 校验分享入口参数；参数只用于成员授权成功后的定位。
 * @param {object} query 微信页面进入参数，不信任其中的角色或身份字段。
 * @param {string} today 当前北京时间日期，不接受指向未来的卡片。
 * @returns {object|null} 合法任务id和日期，格式异常时忽略定位。
 */
function readSharedTask(query, today) {
  if (!query || !/^[a-f0-9]{32}$/.test(query.task || '')) return null;
  const date = query.date || today;
  // 旧卡片仅允许查看对应历史，不将过期事项变成今天的新任务。
  return d.validDate(date) && date <= today ? { id: query.task, date } : null;
}
module.exports = { completionMessage, shareTaskCard, readSharedTask };
