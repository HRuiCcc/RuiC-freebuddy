import { attach } from '../src/cdplink.mjs';

const a = await attach(9222);
const { session } = a;

const probe = `(() => {
  const b = window.__wbEventBridge;
  const out = { type: typeof b, ownKeys: [], proto: [], arity: null };
  if (!b) return JSON.stringify(out);
  out.arity = typeof b === 'function' ? b.length : null;
  try { out.ownKeys = Object.getOwnPropertyNames(b).map(k => k + ':' + typeof b[k]); } catch (e) {}
  try {
    let p = Object.getPrototypeOf(b);
    while (p && p !== Object.prototype) {
      out.proto.push(Object.getOwnPropertyNames(p).map(k => k + ':' + typeof b[k]).join(','));
      p = Object.getPrototypeOf(p);
    }
  } catch (e) {}
  try { out.src = String(b).slice(0, 700); } catch (e) {}
  return JSON.stringify(out, null, 2);
})()`;

console.log('=== __wbEventBridge ===');
console.log(await session.evaluate(probe));

// 顺带看看渲染进程有没有把 IPC 通道名暴露成常量
const chans = `(() => {
  const out = new Set();
  try {
    for (const k of Object.keys(window)) {
      const v = window[k];
      if (typeof v === 'object' && v && typeof v.invoke === 'function') out.add('obj:' + k);
      if (typeof v === 'function' && /invoke|send|ipc|bridge|rpc/i.test(k)) out.add('fn:' + k);
    }
  } catch (e) {}
  return JSON.stringify([...out]);
})()`;
console.log('\n=== IPC 相关全局 ===');
console.log(await session.evaluate(chans));
session.close();
