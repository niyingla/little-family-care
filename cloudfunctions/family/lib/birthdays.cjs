const { Lunar, LunarMonth } = require('lunar-javascript');
const d = require('./domain');
const MIN_YEAR = 1900;
const MAX_YEAR = 2100;
const REMINDER_DAYS = 3;
const REMINDER_TIME = '10:00';
const lunarValidity = new Map();

/**
 * 核对无出生年的农历月日，必须在支持年份内真实存在过。
 * @param {object} birthday 已校验整数范围的农历月日及闰月标志。
 * @returns {boolean} 至少一个对应农历月能够容纳该日期时为true。
 */
function validLunarBirthday(birthday) {
  // 阴阳历换算全部交给锁定版本的库；负月份是其公开的闰月表示。
  const month = birthday.leap ? -birthday.month : birthday.month;
  const key = `${month}:${birthday.day}`;
  // 无年份生日的有效性与请求无关，缓存后不会每次定时扫描完整年表。
  if (!lunarValidity.has(key)) {
    let valid = false;
    // 公历年初可能属于上一农历年，因此验证范围包含1899农历年。
    for (let year = MIN_YEAR - 1; year <= MAX_YEAR && !valid; year++) {
      const lunarMonth = LunarMonth.fromYm(year, month);
      valid = !!lunarMonth && birthday.day <= lunarMonth.getDayCount();
    }
    lunarValidity.set(key, valid);
  }
  return lunarValidity.get(key);
}

/**
 * 校验并收敛生日数据，不保留出生年、权限或其他调用方字段。
 * @param {?object} input 公农历月日及布尔leap；null明确表示清空生日。
 * @returns {?object} 标准{calendar,month,day,leap}，或用于删除的null。
 * @throws {Error} 日历、日期或闰月标志非法，或农历日期在支持范围内从未存在。
 */
function normalizeBirthday(input) {
  // 清空必须显式传null，缺字段不能被静默解释成删除已有生日。
  if (input === null) return null;
  if (!input || Array.isArray(input)) throw new Error('生日资料不正确');
  // 明确提取字段，调用方附带的成员身份、出生年和权限均不进入结果。
  const { calendar, month, day, leap } = input;
  // 不允许字符串布尔或小数混入持久化模型，避免闰月语义反转。
  if (
    !['solar', 'lunar'].includes(calendar) ||
    !Number.isInteger(month) ||
    month < 1 ||
    month > 12 ||
    !Number.isInteger(day) ||
    day < 1 ||
    typeof leap !== 'boolean'
  )
    throw new Error('生日日期或日历不正确');
  const birthday = { calendar, month, day, leap };
  // 用闰年验证公历月日，允许无出生年的2月29日，但不接受4月31日。
  // 农历的30日上限只是初筛，仍需通过真实年表验证对应月份存在。
  // 无出生年不意味着允许任意闰月组合，支持区间内从未存在的日期应拒绝。
  const valid =
    calendar === 'solar'
      ? !leap &&
        d.validDate(`2000-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`)
      : day <= 30 && validLunarBirthday(birthday);
  if (!valid) throw new Error('生日日期不正确，请检查月份、日期和闰月');
  // 返回新对象，防止表单的后续修改改变服务端已校验的数据。
  return birthday;
}

/**
 * 将某一公历年或农历年的生日转换为公历日期。
 * @param {object} birthday 标准生日，不含出生年。
 * @param {number} year 当前候选历法年；农历年可与最终公历年不同。
 * @returns {string} 公历YYYY-MM-DD，按约定处理闰日、缺失闰月及小月三十。
 */
function occurrenceDate(birthday, year) {
  if (birthday.calendar === 'solar') {
    // 2月29日的平年生日按2月28日，其他公历月日保持原样。
    const date = `${year}-${String(birthday.month).padStart(2, '0')}-${String(birthday.day).padStart(2, '0')}`;
    return d.validDate(date) ? date : `${year}-02-28`;
  }
  // 有对应闰月才使用负月份；没有时只使用普通同月，不生成两次生日。
  const leapMonth = birthday.leap && LunarMonth.fromYm(year, -birthday.month);
  const month = leapMonth ? -birthday.month : birthday.month;
  const lunarMonth = leapMonth || LunarMonth.fromYm(year, month);
  // 月份只有29天时在月底过生日，不能将三十溢出到下月初一。
  const day = Math.min(birthday.day, lunarMonth.getDayCount());
  return Lunar.fromYmd(year, month, day).getSolar().toYmd();
}

/**
 * 枚举未来生日候选，覆盖公历年初属于上一农历年及年底跨年提醒。
 * @param {object} member 家人成员，生日位于birthday字段；未设置则返回空数组。
 * @param {string} today 北京时间公历日期，支持1900-01-01至2100-12-31。
 * @returns {Array<object>} 升序{date,birthdayYear}；birthdayYear属于生日所用历法。
 * @throws {Error} 当前日期超出范围、日期非法或存储的生日不合法。
 */
function birthdayOccurrences(member, today) {
  // 约束输入与候选输出范围，避免库的远古历法规则影响现代家庭记录。
  const year = Number(String(today).slice(0, 4));
  if (!d.validDate(today) || year < MIN_YEAR || year > MAX_YEAR)
    throw new Error('生日计算日期或年份超出1900至2100年范围');
  if (!member || !member.birthday) return [];
  // 已存生日仍经同一校验入口，不能因读取路径绕过月日合法性检查。
  const birthday = normalizeBirthday(member.birthday);
  const events = [];
  // 前一年覆盖春节之前的腊月；后一年覆盖12月底对元旦生日的提前提醒。
  for (let candidateYear = year - 1; candidateYear <= year + 1; candidateYear++) {
    const date = occurrenceDate(birthday, candidateYear);
    // 只交付今天及未来、且处于支持区间的事件，不把过去生日补发成今天。
    if (date >= today && date <= `${MAX_YEAR}-12-31`)
      events.push({ date, birthdayYear: candidateYear });
  }
  return events.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 生成当天到点的生日提醒候选，不读取数据库、不发送微信。
 * @param {?object} home 当前受信家庭快照，仅active成员作为寿星和收件人。
 * @param {string} nowISO 服务端ISO时间，按北京时间判定提醒日期与10点窗口。
 * @returns {Array<object>} 含稳定未哈希id、寿星memberId、日期及recipientId的提醒列表。
 * @throws {Error} 时间无效、超出支持年份或已保存生日不合法。
 */
function birthdayDue(home, nowISO) {
  // 时区偏移只由共用日期工具处理，主机本地时区不参与提醒判断。
  if (!Number.isFinite(new Date(nowISO).getTime())) throw new Error('生日提醒时间不正确');
  const today = d.chinaDate(nowISO);
  // 窗口仅覆盖提醒日10点至午夜，不将停机期间错过的提醒挪到其他日期。
  if (d.chinaTime(nowISO) < REMINDER_TIME || !home) return [];
  // 尚未受邀加入或已移除的成员不参与生日通知，称呼不会改变资格。
  const members = home.members.filter((member) => member.active);
  // 这里只产出候选，订阅额度检查及持久化去重由服务层统一处理。
  const due = [];
  // 每个有效寿星分别提醒全部有效家人，寿星本人也在接收范围内。
  for (const member of members) {
    for (const occurrence of birthdayOccurrences(member, today)) {
      // 对实际公历生日减三天，春节或元旦跨年仍与普通日期走同一路径。
      if (d.addDays(occurrence.date, -REMINDER_DAYS) !== today) continue;
      for (const recipient of members) {
        // 身份、实际生日和收件人组成幂等键；持久化时由服务入口统一hash。
        // 不含出生年份或OpenID；称呼仅来自受信家庭快照。
        due.push({
          id: `birthday:${member.id}:${occurrence.date}:${recipient.id}`,
          memberId: member.id,
          title: `${member.name}还有3天过生日，记得送上祝福 ♡`,
          subjectName: member.name,
          date: today,
          time: REMINDER_TIME,
          birthdayDate: occurrence.date,
          recipientId: recipient.id,
        });
      }
    }
  }
  return due;
}

module.exports = { normalizeBirthday, birthdayOccurrences, birthdayDue };
