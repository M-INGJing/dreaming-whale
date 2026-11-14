'use strict';

// 兼容层：定位服务及外部脚本用这里的天气/热搜接口。通用网页搜索已由 DeepSeek 官方
// 托管搜索（deepseek_web_search 工具，见 src/llm/client.js）接管，这里不再自建 bing/so360 抓取。
const quality = require('../core/search/quality');
const { formatResult } = require('../core/search/result');
const { hotlistResult } = require('./search/hotlists');
const weather = require('./search/weather');

async function hotNews(limit = 10, timeoutMs = 8000) {
  return (await hotlistResult('toutiao', { limit, timeoutMs })).items.map(({ title, url, hot }) => ({ title, url, hot }));
}
async function hotNewsText(limit = 8, timeoutMs = 8000) { return formatResult(await hotlistResult('toutiao', { limit, timeoutMs })); }
async function bilibiliHot(limit = 10, timeoutMs = 8000) { return (await hotlistResult('bilibili', { limit, timeoutMs })).items.map(x => x.title); }
async function weiboHot(limit = 10, timeoutMs = 8000) { return (await hotlistResult('weibo', { limit, timeoutMs })).items.map(x => x.title); }
async function bilibiliHotText(limit = 10, timeoutMs = 8000) { return formatResult(await hotlistResult('bilibili', { limit, timeoutMs })); }
async function weiboHotText(limit = 10, timeoutMs = 8000) { return formatResult(await hotlistResult('weibo', { limit, timeoutMs })); }
async function geocodeCity(city, timeoutMs = 8000) { try { return await weather.geocodeCity(city, { timeoutMs }); } catch { return null; } }
async function ipCity(timeoutMs = 6000) { try { return await weather.ipCity({ timeoutMs }); } catch { return ''; } }
async function weatherText(city, opts) { return formatResult(await weather.weatherResult(city, opts)); }

module.exports = { ...quality, hotlistResult, weatherResult: weather.weatherResult,
  hotNews, hotNewsText, bilibiliHot, bilibiliHotText, weiboHot, weiboHotText,
  geocodeCity, ipCity, weatherText, wmoText: weather.wmoText };
