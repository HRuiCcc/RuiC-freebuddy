import { listTargets, attach } from '../src/cdplink.mjs';

console.log('=== 全部 CDP 目标 ===');
for (const t of await listTargets(9222)) {
  console.log(`[${t.type}] ${t.title} | ${String(t.url).slice(0, 100)}`);
}

const a = await attach(9222);
const { session } = a;

const probe = `(async () => {
  const out = { ls: [], idb: [], globals: [], hints: [] };
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      out.ls.push(k + '  (len=' + String(localStorage.getItem(k) || '').length + ')');
    }
  } catch (e) { out.ls.push('ERR ' + e.message); }
  try {
    if (indexedDB.databases) {
      const dbs = await indexedDB.databases();
      out.idb = dbs.map(d => d.name + ':' + d.version);
    }
  } catch (e) { out.idb.push('ERR ' + e.message); }
  // 粗略扫描 window 上像 API 客户端 / 会话态的对象
  try {
    for (const k of Object.keys(window)) {
      if (/api|client|session|auth|store|sdk|bridge/i.test(k)) out.hints.push(k + ':' + typeof window[k]);
    }
  } catch (e) {}
  return JSON.stringify(out, null, 2);
})()`;

const r = await session.evaluate(probe, { awaitPromise: true });
console.log('\n=== 渲染进程存储线索 ===');
console.log(r);
session.close();
