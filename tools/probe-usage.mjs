import { attach } from '../src/cdplink.mjs';
const a = await attach(9222);
const { session } = a;
const r = await session.evaluate(`(async () => {
  const out = {};
  const safe = (v,n) => { try { const s = typeof v==='string'?v:JSON.stringify(v); return String(s).replace(/eyJ[A-Za-z0-9._-]{10,}/g,'<jwt>').slice(0,n||500);} catch(e){return 'ERR';} };
  try { out.metricsFns = Object.getOwnPropertyNames(window.wb.metrics).map(k=>k+':'+typeof window.wb.metrics[k]); } catch(e){ out.metricsFns='ERR '+e.message; }
  const cands = [
    '/v2/activity/usage/stat',
    '/v2/usage/stat',
    '/activity/usage/stat',
    '/v2/billing/meter/get-user-daily-usage',
    '/v2/plugin/usage/stat',
    '/activity/growth/heatmap',
  ];
  out.tries = {};
  for (const p of cands) {
    try {
      const res = await window.wb.http.get('https://www.codebuddy.cn' + p);
      const d = res && res.data;
      out.tries[p] = 'code=' + (d && d.code) + ' keys=' + (d && d.data ? Object.keys(d.data).join('|').slice(0,80) : 'none');
    } catch (e) { out.tries[p] = 'ERR ' + String(e && (e.message||e)).slice(0,60); }
  }
  return JSON.stringify(out, null, 1);
})()`, { awaitPromise: true });
console.log(r);
session.close();
