// 通用：注入最新面板 → 在面板内执行一段动作 → 截图弹窗
import fs from 'node:fs';
import path from 'node:path';
import { attach } from '../src/cdplink.mjs';
import { dataDir } from '../src/config.mjs';

const out = process.argv[2] || 'tools/fb-action.png';
const expr = process.argv[3] || '';

const token = fs.readFileSync(path.join(dataDir(), '.api-token'), 'utf8').trim();
const a = await attach(9222);
if (!a) { console.log('未连上 CDP'); process.exit(1); }
const { session } = a;
await session.send('Page.enable');

const res = await fetch('http://127.0.0.1:47842/api/inject', { method: 'POST', headers: { 'X-FreeBuddy-Token': token } });
console.log('重新注入:', (await res.text()).slice(0, 60));
await new Promise((r) => setTimeout(r, 700));

await session.evaluate(`(function(){ window.__fbWidget.open(); return true; })()`);
await new Promise((r) => setTimeout(r, 600));

if (expr) {
  const r = await session.evaluate(`(function(){ var s = document.getElementById('freebuddy-host').shadowRoot; ${expr} })()`);
  console.log('动作结果:', r);
  await new Promise((r2) => setTimeout(r2, 900));
}

const rectRaw = await session.evaluate(
  `(function(){ var s = document.getElementById('freebuddy-host').shadowRoot; var m = s.querySelector('.fb-modal'); if (!m) return null; var r = m.getBoundingClientRect(); return JSON.stringify({x:r.x,y:r.y,width:r.width,height:r.height}); })()`,
);
if (rectRaw) {
  const rect = JSON.parse(rectRaw);
  const pad = 34;
  const shot = await session.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: Math.max(0, rect.x - pad), y: Math.max(0, rect.y - pad), width: rect.width + pad * 2, height: rect.height + pad * 2, scale: 1 },
  });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('已保存', out, rect);
} else {
  console.log('没有弹窗');
}

session.close();
