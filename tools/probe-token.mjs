import { attach } from '../src/cdplink.mjs';

const a = await attach(9222);
if (!a) {
  console.log('未连上');
  process.exit(1);
}
const { session } = a;
const hits = [];
session.on('Network.requestWillBeSent', (p) => {
  const u = p.request?.url || '';
  if (!/codebuddy|workbuddy|copilot\.tencent/.test(u)) return;
  const h = p.request.headers || {};
  hits.push({
    method: p.request.method,
    url: u.slice(0, 120),
    auth: !!(h.Authorization || h.authorization),
    keys: Object.keys(h).join(',').slice(0, 80),
  });
});
await session.send('Network.enable');
console.log('已开启 Network 域，观察 9 秒…');
await new Promise((r) => setTimeout(r, 9000));
console.log('捕获到的官方请求数:', hits.length);
for (const h of hits.slice(0, 20)) {
  console.log(' ', h.method, h.auth ? '[有 Authorization]' : '[无]', h.url);
}
if (hits.length) console.log('首个请求头键:', hits[0].keys);
session.close();
