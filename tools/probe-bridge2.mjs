import { attach } from '../src/cdplink.mjs';

const a = await attach(9222);
const { session } = a;

const probe = `(() => {
  const dump = (name, v) => {
    const o = { name, type: typeof v };
    try { o.own = Object.getOwnPropertyNames(v).slice(0, 60).map(k => k + ':' + typeof v[k]); } catch (e) { o.own = ['ERR']; }
    try { o.src = String(v).slice(0, 400); } catch (e) {}
    try { if (typeof v === 'function') o.arity = v.length; } catch (e) {}
    return o;
  };
  return JSON.stringify([
    dump('__wbInvoke', window.__wbInvoke),
    dump('__HOST_BRIDGE__', window.__HOST_BRIDGE__),
    dump('workbuddyDesktop', window.workbuddyDesktop),
    dump('wb', window.wb),
  ], null, 2);
})()`;
console.log(await session.evaluate(probe));

// 试着调用一次无害的通道，看报错里会不会暴露通道名约定
const tryInvoke = `(async () => {
  const out = {};
  try {
    if (typeof window.__wbInvoke === 'function') {
      out.call1 = String(await window.__wbInvoke('__freebuddy_probe__', {}).catch(e => 'ERR:' + e.message)).slice(0, 300);
    }
  } catch (e) { out.call1 = 'THROW:' + e.message; }
  try {
    if (window.__HOST_BRIDGE__ && typeof window.__HOST_BRIDGE__.invoke === 'function') {
      out.bridgeKeys = Object.keys(window.__HOST_BRIDGE__).join(',').slice(0, 300);
    }
  } catch (e) { out.bridgeKeys = 'ERR:' + e.message; }
  return JSON.stringify(out, null, 2);
})()`;
console.log('\n=== 试探调用 ===');
console.log(await session.evaluate(tryInvoke, { awaitPromise: true }));
session.close();
