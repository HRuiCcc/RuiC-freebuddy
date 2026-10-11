import { attach } from '../src/cdplink.mjs';

const a = await attach(9222);
const { session } = a;

const probe = `(async () => {
  const out = {};
  const safe = (v, n) => {
    try {
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      return String(s).replace(/eyJ[A-Za-z0-9._-]{10,}/g, '<jwt>').replace(/(Bearer\\s+)\\S+/gi, '$1<略>').slice(0, n || 1400);
    } catch (e) { return 'ERR:' + e.message; }
  };
  const H = 'https://www.codebuddy.cn';

  // 1) 积分资源
  try {
    const body = {
      PageNumber: 1, PageSize: 100, ProductCode: 'p_tcaca', Status: [0, 3],
      PackageEndTimeRangeBegin: new Date().toISOString().slice(0, 19).replace('T', ' '),
      PackageEndTimeRangeEnd: '2126-01-01 00:00:00',
    };
    const r = await window.wb.http.post(H + '/v2/billing/meter/get-user-resource', body);
    out.resource = safe({ status: r && r.status, keys: r && r.data && Object.keys(r.data), data: r && r.data }, 1500);
  } catch (e) { out.resource = 'THROW:' + safe(e && (e.message || e), 300); }

  // 2) 今日活跃 / 热力图
  try {
    const r2 = await window.wb.http.get(H + '/activity/growth/heatmap');
    out.heatmap = safe(r2 && r2.data, 700);
  } catch (e) { out.heatmap = 'THROW:' + safe(e && (e.message || e), 300); }

  // 3) 成长任务列表
  try {
    const r3 = await window.wb.http.get(H + '/v2/activity/growth/tasks');
    out.tasks = safe(r3 && r3.data, 900);
  } catch (e) { out.tasks = 'THROW:' + safe(e && (e.message || e), 300); }

  return JSON.stringify(out, null, 2);
})()`;
console.log(await session.evaluate(probe, { awaitPromise: true }));
session.close();
