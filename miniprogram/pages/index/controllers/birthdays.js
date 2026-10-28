const LUNAR_MONTHS = [
  '正月',
  '二月',
  '三月',
  '四月',
  '五月',
  '六月',
  '七月',
  '八月',
  '九月',
  '十月',
  '冬月',
  '腊月',
];

/**
 * 生成生日选择器展示信息，月日仍保存为独立数字。
 * @param {object} form 包含成员身份、日历、月日及闰月标志的当前表单。
 * @returns {object} 带选择器索引和简明日期标签的表单。
 */
function describeBirthday(form) {
  // 公历使用闰年最大月长；平年的2月29日由服务端按2月28日执行。
  // 农历月长随年份变化，此处提供可保存的上限，实际日期由服务端年表验证。
  const days =
    form.calendar === 'solar'
      ? [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][form.month - 1]
      : 30;
  const day = Math.min(form.day, days);
  // 日历切换只调整超出月长的日期，不改变被编辑成员身份。
  // 标签只用于展示，小程序端不自行实现阴阳历换算。
  const label =
    form.calendar === 'lunar'
      ? `农历${form.leap ? '闰' : ''}${LUNAR_MONTHS[form.month - 1]}${day}日`
      : `公历${form.month}月${day}日`;
  // 数字月日与0起始选择器索引分别保存，避免把索引误传为生日日期。
  return { ...form, day, label, monthIndex: form.month - 1, dayIndex: day - 1, days };
}

/**
 * 更新表单及其日期选择范围，避免把输入字符串留在生日数据里。
 * @param {object} page 当前原生页面，需提供data和setData。
 * @param {object} patch 当前交互产生的受控日历、月日或闰月修改。
 * @returns {void} 同步表单标签及选择器范围，不触发后端请求。
 */
function updateBirthday(page, patch) {
  // 选择器展示数据与实际提交的数字月日由同一份表单派生。
  const form = describeBirthday({ ...page.data.birthdayForm, ...patch });
  page.setData({
    birthdayForm: form,
    birthdayMonths:
      form.calendar === 'lunar' ? LUNAR_MONTHS : Array.from({ length: 12 }, (_, i) => `${i + 1}月`),
    // 切换月份时立即收敛日期选项，用户不能选到公历4月31日。
    birthdayDays: Array.from({ length: form.days }, (_, i) => `${i + 1}日`),
  });
}

module.exports = {
  /**
   * 打开当前本人或管理员有权编辑的家人生日。
   * @param {object} event 按钮事件，dataset.id为当前有效成员ID。
   * @returns {void} 无权或成员已移除时不打开；最终权限仍由服务端验证。
   */
  openBirthday(event) {
    const id = event.currentTarget.dataset.id;
    const member = this.data.members.find((item) => item.id === id && item.active);
    // 家庭称呼与身份标签不赋予权限；只看可信管理员状态和当前操作者ID。
    if (!member || !this._snapshot || (!this.data.owner && this._snapshot.actorId !== id)) return;
    this.setData({ modal: 'birthday', birthdayForm: { memberId: id, name: member.name } });
    // 只载入月日，不索取出生年；未设置的生日从公历1月1日开始选择。
    updateBirthday(this, member.birthday || { calendar: 'solar', month: 1, day: 1, leap: false });
  },
  /**
   * 切换公历或农历，公历必须清除闰月状态。
   * @param {object} event 日历选项事件，dataset.id仅支持solar或lunar。
   * @returns {void} 更新表单，不发请求。
   */
  changeBirthdayCalendar(event) {
    const calendar = event.currentTarget.dataset.id;
    // 不接受未知选项，也不让农历闰月状态泄露到公历模型。
    if (['solar', 'lunar'].includes(calendar)) updateBirthday(this, { calendar, leap: false });
  },
  /**
   * 接收月份选择器索引。
   * @param {object} event detail.value为0至11的选择器索引。
   * @returns {void} 保存1至12的月份并更新可选日期。
   */
  changeBirthdayMonth(event) {
    // 选择器返回字符串索引，持久化表单统一转换为整数月份。
    const month = Number(event.detail.value) + 1;
    if (Number.isInteger(month) && month >= 1 && month <= 12) updateBirthday(this, { month });
  },
  /**
   * 接收日期选择器索引。
   * @param {object} event detail.value为0起始的日期索引。
   * @returns {void} 保存1起始的日期，超出当前月长的事件忽略。
   */
  changeBirthdayDay(event) {
    const day = Number(event.detail.value) + 1;
    // 数字范围以当前选择器真实月长为准，不能通过事件构造非法日期。
    if (Number.isInteger(day) && day >= 1 && day <= this.data.birthdayForm.days)
      updateBirthday(this, { day });
  },
  /**
   * 修改农历闰月标志。
   * @param {object} event 微信switch事件，detail.value必须为布尔值。
   * @returns {void} 公历或非布尔输入忽略，普通农历月可明确关闭闰月。
   */
  changeBirthdayLeap(event) {
    // 闰月只属于农历，不以字符串真值推断用户选择。
    if (this.data.birthdayForm.calendar === 'lunar' && typeof event.detail.value === 'boolean')
      updateBirthday(this, { leap: event.detail.value });
  },
  /**
   * 保存当前家人生日，失败时保留表单让用户修正。
   * @returns {Promise<void>} 服务端保存成功后关闭编辑器。
   */
  async saveBirthday() {
    // run统一处理失败反馈，不能在提交失败时丢弃用户输入。
    if (await this.run('saveBirthday', this.data.birthdayForm)) this.closeModal();
  },
  /**
   * 明确清空当前成员生日，不用空月日冒充删除操作。
   * @returns {Promise<void>} 服务端清空成功后关闭，失败保持编辑器。
   */
  async clearBirthday() {
    // 服务端以birthday:null区分清空和非法缺字段，成员仍由原表单确定。
    if (
      await this.run('saveBirthday', { memberId: this.data.birthdayForm.memberId, birthday: null })
    )
      this.closeModal();
  },
};
