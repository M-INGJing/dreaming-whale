'use strict';

/**
 * 农历 / 生肖 / 二十四节气（零依赖）。
 *
 * 农历数据用公开的 1900-2100 农历信息表（每一年一个十六进制值，编码当年
 * 各月大小 + 闰月位置）。生肖按农历年（正月初一换属相）。节气用「寿星公式」
 * 的分钟偏移表近似，误差在 1 天以内，够陪聊用。
 *
 * 纯函数：不碰存储、不碰网络，方便单测。
 */

const LUNAR_INFO = [
  0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2,
  0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977,
  0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970,
  0x06566, 0x0d4a0, 0x0ea50, 0x06e95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950,
  0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557,
  0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5d0, 0x14573, 0x052d0, 0x0a9a8, 0x0e950, 0x06aa0,
  0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0,
  0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b5a0, 0x195a6,
  0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570,
  0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x055c0, 0x0ab60, 0x096d5, 0x092e0,
  0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5,
  0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930,
  0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530,
  0x05aa0, 0x076a3, 0x096d0, 0x04bd7, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45,
  0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0,
  0x14b63, 0x09370, 0x049f8, 0x04970, 0x064b0, 0x168a6, 0x0ea50, 0x06b20, 0x1a6c4, 0x0aae0,
  0x0a2e0, 0x0d2e3, 0x0c960, 0x0d557, 0x0d4a0, 0x0da50, 0x05d55, 0x056a0, 0x0a6d0, 0x055d4,
  0x052d0, 0x0a9b8, 0x0a950, 0x0b4a0, 0x0b6a6, 0x0ad50, 0x055a0, 0x0aba4, 0x0a5b0, 0x052b0,
  0x0b273, 0x06930, 0x07337, 0x06aa0, 0x0ad50, 0x14b55, 0x04b60, 0x0a570, 0x054e4, 0x0d160,
  0x0e968, 0x0d520, 0x0daa0, 0x16aa6, 0x056d0, 0x04ae0, 0x0a9d4, 0x0a2d0, 0x0d150, 0x0f252,
  0x0d520,
];

const CN_MONTH = ['正', '二', '三', '四', '五', '六', '七', '八', '九', '十', '冬', '腊'];
const CN_DAY = ['初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
  '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十'];
const ZODIAC = ['鼠', '牛', '虎', '兔', '龙', '蛇', '马', '羊', '猴', '鸡', '狗', '猪'];

const STERM_NAMES = ['小寒', '大寒', '立春', '雨水', '惊蛰', '春分', '清明', '谷雨', '立夏', '小满',
  '芒种', '夏至', '小暑', '大暑', '立秋', '处暑', '白露', '秋分', '寒露', '霜降',
  '立冬', '小雪', '大雪', '冬至'];
// 每个节气相对 1900-01-06 02:05（小寒）的分钟偏移；公开的「寿星公式」参数。
const STERM_OFFSET = [0, 21208, 42467, 63836, 85337, 107014, 128867, 150921, 173149, 195551,
  218072, 240693, 263343, 285989, 308563, 331033, 353350, 375494, 397447, 419210,
  440795, 462224, 483532, 504758];

function leapMonth(year) {
  const v = LUNAR_INFO[year - 1900];
  return v == null ? 0 : v & 0xf;
}
function leapDays(year) {
  if (!leapMonth(year)) return 0;
  return (LUNAR_INFO[year - 1900] & 0x10000) ? 30 : 29;
}
function monthDays(year, month) {
  return (LUNAR_INFO[year - 1900] & (0x10000 >> month)) ? 30 : 29;
}
function lunarYearDays(year) {
  let sum = 348;
  for (let i = 0x8000; i > 0x8; i >>= 1) sum += (LUNAR_INFO[year - 1900] & i) ? 1 : 0;
  return sum + leapDays(year);
}

/**
 * 阳历 → 农历。
 * @param {number} y 公历年（4 位）
 * @param {number} m 公历月（1-12）
 * @param {number} d 公历日
 * @returns {{year:number, month:number, day:number, isLeap:boolean, monthName:string, dayName:string, text:string, zodiac:string}}
 */
function solarToLunar(y, m, d) {
  let offset = Math.floor((Date.UTC(y, m - 1, d) - Date.UTC(1900, 0, 31)) / 86400000);
  let lunarYear = 1900;
  let daysInYear = 0;
  for (lunarYear = 1900; lunarYear < 2101 && offset > 0; lunarYear += 1) {
    daysInYear = lunarYearDays(lunarYear);
    offset -= daysInYear;
  }
  if (offset < 0) {
    offset += daysInYear;
    lunarYear -= 1;
  }
  const leap = leapMonth(lunarYear);
  let isLeap = false;
  let lunarMonth = 0;
  for (lunarMonth = 1; lunarMonth < 13 && offset > 0; lunarMonth += 1) {
    if (leap > 0 && lunarMonth === leap + 1 && !isLeap) {
      lunarMonth -= 1;
      isLeap = true;
      daysInYear = leapDays(lunarYear);
    } else {
      daysInYear = monthDays(lunarYear, lunarMonth);
    }
    if (isLeap && lunarMonth === leap + 1) isLeap = false;
    offset -= daysInYear;
  }
  if (offset === 0 && leap > 0 && lunarMonth === leap + 1) {
    if (isLeap) { isLeap = false; } else { isLeap = true; lunarMonth -= 1; }
  }
  if (offset < 0) {
    offset += daysInYear;
    lunarMonth -= 1;
  }
  const day = offset + 1;
  const monthName = (isLeap ? '闰' : '') + CN_MONTH[lunarMonth - 1] + '月';
  const dayName = CN_DAY[day - 1] || String(day);
  return {
    year: lunarYear,
    month: lunarMonth,
    day,
    isLeap,
    monthName,
    dayName,
    text: `${monthName}${dayName}`,
    zodiac: ZODIAC[(lunarYear - 4) % 12],
  };
}

/** 公历某年的生肖（按农历年：正月初一之前算上一年）。 */
function zodiacOf(y, m = 1, d = 1) {
  return solarToLunar(y, m, d).zodiac;
}

/** 第 n 个节气（n=0..23）在公历 y 年的「日」。 */
function stermDay(y, n) {
  const ms = 31556925974.7 * (y - 1900) + STERM_OFFSET[n] * 60000 + Date.UTC(1900, 0, 6, 2, 5);
  return new Date(ms).getUTCDate();
}

/** 公历某天若是节气，返回节气名；否则 null。 */
function solarTerm(y, m, d) {
  for (let n = 0; n < 24; n += 1) {
    const month = Math.floor(n / 2);
    if (month + 1 === m && stermDay(y, n) === d) return STERM_NAMES[n];
  }
  return null;
}

/** 找从 from 起（含）之后的第一个「农历 month 月 day 日」，返回公历 Date。 */
function nextLunarDate(month, day, from = new Date()) {
  const start = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  for (let i = 0; i < 400; i += 1) {
    const d = new Date(start.getTime() + i * 86400000);
    const lu = solarToLunar(d.getFullYear(), d.getMonth() + 1, d.getDate());
    if (!lu.isLeap && lu.month === month && lu.day === day) return d;
  }
  return null;
}

/** 春节 = 正月初一。 */
function nextSpringFestival(from = new Date()) {
  return nextLunarDate(1, 1, from);
}
/** 中秋 = 八月十五。 */
function nextMidAutumn(from = new Date()) {
  return nextLunarDate(8, 15, from);
}

module.exports = {
  solarToLunar,
  zodiacOf,
  solarTerm,
  nextLunarDate,
  nextSpringFestival,
  nextMidAutumn,
  ZODIAC,
  STERM_NAMES,
};
