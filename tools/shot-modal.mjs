// 注入最新面板 → 触发一个动作（例如打开导入弹窗）→ 截图，用于验证弹窗类界面。
import fs from 'node:fs';
import path from 'node:path';
import { attach } from '../src/cdplink.mjs';
import { dataDir } from '../src/config.mjs';

const out = process.argv[2] || 'tools/fb-modal.png';
const action = process.argv[3] || '/api/import';

const token = fs.readFileSync(path.join(dataDir(), '.api-token'), 'utf8').trim();

const a = await attach(9222);
if (!a) {
  console.log('未连上 CDP');
  process.exit(1);
}
const { session } = a;
await session.send('Page.enable');


// 用本地 API 重新注入（面板文件 mtime 变化即生效）
const res = await fetch('http://127.0.0.1:47842/api/inject', {
  method: 'POST',
  headers: { 'X-FreeBuddy-Token': token },
});
console.log('重新注入:', await res.text());
await new Promise((r) => setTimeout(r, 800));

await session.evaluate(`(function(){ window.__fbWidget.open(); return true; })()`);
await new Promise((r) => setTimeout(r, 700));

const clicked = await session.evaluate(`(function(){
  var h = document.getElementById('freebuddy-host');
  var s = h && h.shadowRoot;
  if (!s) return 'no-shadow';
  var btns = Array.from(s.querySelectorAll('.fb-btn')).filter(function(b){ return b.textContent.indexOf('导入') >= 0; });
  if (!btns.length) return 'no-button:' + Array.from(s.querySelectorAll('.fb-btn')).map(function(b){return b.textContent;}).join('|');
  btns[0].click();
  return 'clicked';
})()`);
console.log('点击导入:', clicked);
await new Promise((r) => setTimeout(r, 900));

const rectRaw = await session.evaluate(
  `(function(){ var h = document.getElementById('freebuddy-host'); var m = h && h.shadowRoot && h.shadowRoot.querySelector('.fb-modal'); if (!m) return null; var r = m.getBoundingClientRect(); return JSON.stringify({x:r.x,y:r.y,width:r.width,height:r.height}); })()`,
);
console.log('弹窗矩形:', rectRaw);
if (rectRaw) {
  const rect = JSON.parse(rectRaw);
  const pad = 30;
  const shot = await session.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: Math.max(0, rect.x - pad), y: Math.max(0, rect.y - pad), width: rect.width + pad * 2, height: rect.height + pad * 2, scale: 1 },
  });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('已保存', out);
}

const diag = await session.evaluate(`(function(){
  var h = document.getElementById('freebuddy-host'); var s = h && h.shadowRoot;
  var m = s && s.querySelector('.fb-modal');
  if (!m) return 'no-modal';
  var cs = getComputedStyle(m);
  var mask = s.querySelector('.fb-mask');
  return JSON.stringify({ modalBg: cs.backgroundColor, modalColor: cs.color, maskBg: mask ? getComputedStyle(mask).backgroundColor : null });
})()`);
console.log('弹窗计算样式:', diag);

session.close();
