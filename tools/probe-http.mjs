import { attach } from '../src/cdplink.mjs';

const a = await attach(9222);
const { session } = a;

const probe = `(() => {
  const dump = (label, v, depth) => {
    const o = { label, type: typeof v };
    try { o.own = Object.getOwnPropertyNames(v).slice(0, 40).map(k => k + ':' + typeof v[k]); } catch (e) { o.own = ['ERR:' + e.message]; }
    try { if (typeof v === 'function') { o.arity = v.length; o.src = String(v).slice(0, 500); } } catch (e) {}
    return o;
  };
  const list = [];
  list.push(dump('wb', window.wb));
  list.push(dump('wb.http', window.wb && window.wb.http));
  try {
    if (window.wb && window.wb.http) {
      for (const k of Object.getOwnPropertyNames(window.wb.http)) {
        const v = window.wb.http[k];
        if (typeof v === 'function') list.push(dump('wb.http.' + k, v));
      }
    }
  } catch (e) {}
  list.push(dump('wb.login', window.wb && window.wb.login));
  list.push(dump('workbuddyDesktop.network', window.workbuddyDesktop && window.workbuddyDesktop.network));
  list.push(dump('workbuddyDesktop.app', window.workbuddyDesktop && window.workbuddyDesktop.app));
  return JSON.stringify(list, null, 2);
})()`;
console.log(await session.evaluate(probe));
session.close();
