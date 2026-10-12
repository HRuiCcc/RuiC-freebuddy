// 打开面板 → 会话页 → 点第一行的「分支」按钮 → 截分支弹窗。用于视觉验收新 UI。
import fs from 'node:fs';
import path from 'node:path';
import { attach } from '../src/cdplink.mjs';
import { dataDir } from '../src/config.mjs';

const out = process.argv[2] || 'tools/fb-fork-dialog.png';
const a = await attach(9222);
if (!a) {
  console.log('未连上 CDP');
  process.exit(1);
}
const { session } = a;
await session.send('Page.enable');
const token = fs.readFileSync(path.join(dataDir(), '.api-token'), 'utf8').trim();
await fetch('http://127.0.0.1:47842/api/inject', { method: 'POST', headers: { 'X-FreeBuddy-Token': token } });
await new Promise((r) => setTimeout(r, 700));

await session.evaluate(`(function(){ var w=window.__fbWidget; if(w) w.open(); var h=document.getElementById('freebuddy-host'); var b=h.shadowRoot.querySelector('.fb-rail-item[data-tab="sessions"]'); if(b) b.click(); })()`);
await new Promise((r) => setTimeout(r, 1800));

const clicked = await session.evaluate(
  `(function(){ var s=document.getElementById('freebuddy-host').shadowRoot; var row=s.querySelector('.fb-row.is-acct'); if(!row) return 'no-row'; var ops=row.querySelectorAll('.fb-row-ops .fb-icon-btn'); if(!ops.length) return 'no-ops'; ops[0].click(); return 'clicked:'+ops.length; })()`,
);
console.log('点分支按钮:', clicked);
await new Promise((r) => setTimeout(r, 2200));

const rectRaw = await session.evaluate(
  `(function(){ var s=document.getElementById('freebuddy-host').shadowRoot; var m=s.querySelector('.fb-mask .fb-modal'); if(!m) return null; var r=m.getBoundingClientRect(); return JSON.stringify({x:r.x,y:r.y,width:r.width,height:r.height, anchors: s.querySelectorAll('.fb-anchor').length}); })()`,
);
if (!rectRaw) {
  console.log('弹窗没出现');
  process.exit(1);
}
const rect = JSON.parse(rectRaw);
console.log('弹窗:', rect);
const shot = await session.send('Page.captureScreenshot', {
  format: 'png',
  clip: { x: Math.max(0, rect.x - 6), y: Math.max(0, rect.y - 6), width: rect.width + 12, height: Math.min(rect.height + 12, 900), scale: 1 },
});
fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log('已保存', out);
session.close();
