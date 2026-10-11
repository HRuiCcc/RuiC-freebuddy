import { attach } from '../src/cdplink.mjs';

const a = await attach(9222);
const { session } = a;

const expr = `(function(){
  var out = {};
  out.searchLen = (location.search || '').length;
  var params = new URLSearchParams(location.search || '');
  var s = params.get('accountSnapshot');
  out.got = !!s;
  if (s) {
    out.head = s.slice(0, 70);
    try { out.direct = Object.keys(JSON.parse(s)).join(','); } catch (e) { out.direct = 'ERR ' + e.message; }
    try { var d = decodeURIComponent(s); out.decodedHead = d.slice(0, 70); out.decoded = Object.keys(JSON.parse(d)).join(','); } catch (e) { out.decoded = 'ERR ' + e.message; }
  }
  return JSON.stringify(out, null, 1);
})()`;

console.log(await session.evaluate(expr));
session.close();
