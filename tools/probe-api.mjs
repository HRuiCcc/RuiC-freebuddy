import { attach } from '../src/cdplink.mjs';

const a = await attach(9222);
const { session } = a;

const probe = `(async () => {
  const out = {};
  const safe = (v, n) => {
    try {
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      return String(s).replace(/eyJ[A-Za-z0-9._-]{10,}/g, '<jwt节略>').replace(/(Bearer\\s+)\\S+/gi, '$1<略>').slice(0, n || 900);
    } catch (e) { return 'ERR:' + e.message; }
  };
  try { out.account = safe(await window.wb.account(), 700); } catch (e) { out.account = 'THROW:' + e.message; }
  try { out.config = safe(await window.wb.config(), 700); } catch (e) { out.config = 'THROW:' + e.message; }
  try {
    const r = await window.wb.http.get('https://www.codebuddy.cn/activity/growth/streak');
    out.streak = safe({ status: r && r.status, data: r && r.data }, 600);
  } catch (e) { out.streak = 'THROW:' + safe(e && (e.message || e), 300); }
  try {
    const r2 = await window.wb.http.get('https://www.workbuddy.cn/activity/growth/streak');
    out.streak2 = safe({ status: r2 && r2.status, data: r2 && r2.data }, 600);
  } catch (e) { out.streak2 = 'THROW:' + safe(e && (e.message || e), 300); }
  return JSON.stringify(out, null, 2);
})()`;
console.log(await session.evaluate(probe, { awaitPromise: true }));
session.close();
