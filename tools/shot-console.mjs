// 给桌面控制台截图（验收用）。窗口以 FB_DESKTOP_CDP=<port> 启动后跑：
//   node tools/shot-console.mjs <port> <out.png> [view]
// view = console | logs | about（切到对应页签再截）
import fs from 'node:fs';
import { listTargets, connect } from '../src/cdplink.mjs';

const port = Number(process.argv[2] || 9333);
const out = process.argv[3] || 'tools/freebuddy-console.png';
const view = process.argv[4] || null;

// 控制台窗口是 file:// 页面，不在 attach() 给 WorkBuddy 打分的范围内，这里直连。
const targets = await listTargets(port).catch(() => null);
const target = (targets || []).find((t) => t.type === 'page' && /desktop\/index\.html/.test(t.url));
if (!target) {
  console.log(`没在 ${port} 上找到控制台页面（${(targets || []).length} 个 target）`);
  process.exit(1);
}
const session = await connect(target.webSocketDebuggerUrl);
await session.send('Page.enable');

if (view) {
  await session.evaluate(
    `(function(){ var b = document.querySelector('.rail-item[data-view="${view}"]'); if (b) b.click(); return true })()`,
  );
  await new Promise((r) => setTimeout(r, 700));
}
await new Promise((r) => setTimeout(r, 600));

const shot = await session.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));

const diag = await session.evaluate(
  `JSON.stringify({ title: document.title, view: (document.querySelector('.view.is-active')||{}).dataset ? document.querySelector('.view.is-active').dataset.view : null, tiles: Array.from(document.querySelectorAll('.tile')).map(function(t){ return t.querySelector('b').textContent + '=' + t.querySelector('em').textContent }), sub: document.getElementById('head-sub').textContent, note: document.getElementById('launch-note').textContent, err: Array.from(document.querySelectorAll('body *')).length })`,
);
console.log('已保存', out);
console.log('界面状态:', diag);
session.close();
