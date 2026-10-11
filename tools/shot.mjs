// 打开面板并截图（只截面板自身区域），用于视觉验收。
import fs from 'node:fs';
import path from 'node:path';
import { attach } from '../src/cdplink.mjs';

const out = process.argv[2] || 'tools/freebuddy-panel.png';
const tab = process.argv[3] || null;

const a = await attach(9222);
if (!a) {
  console.log('未连上 CDP');
  process.exit(1);
}
const { session } = a;
await session.send('Page.enable');

// 先让守护进程用最新的面板文件重新注入
try {
  const token = fs.readFileSync(path.join(process.env.APPDATA || '', 'FreeBuddy', '.api-token'), 'utf8').trim();
  const r = await fetch('http://127.0.0.1:47842/api/inject', { method: 'POST', headers: { 'X-FreeBuddy-Token': token } });
  console.log('重新注入:', (await r.text()).slice(0, 60));
  await new Promise((res) => setTimeout(res, 600));
} catch (e) {
  console.log('重新注入失败（继续用页面上已有的面板）:', e.message);
}


await session.evaluate(`(function(){ var w = window.__fbWidget; if (!w) return 'no-widget'; w.open(); return 'opened'; })()`);
if (tab) {
  await session.evaluate(
    `(function(){ var h = document.getElementById('freebuddy-host'); if (!h) return; var b = h.shadowRoot.querySelector('.fb-rail-item[data-tab="${tab}"]'); if (b) b.click(); })()`,
  );
}
await new Promise((r) => setTimeout(r, 1500));

const rectRaw = await session.evaluate(
  `(function(){ var h = document.getElementById('freebuddy-host'); if (!h) return null; var p = h.shadowRoot.querySelector('.fb-panel'); if (!p || !p.classList.contains('is-open')) return null; var r = p.getBoundingClientRect(); return JSON.stringify({x:r.x,y:r.y,width:r.width,height:r.height}); })()`,
);
if (!rectRaw) {
  console.log('面板没打开');
  process.exit(1);
}
const rect = JSON.parse(rectRaw);
const shot = await session.send('Page.captureScreenshot', {
  format: 'png',
  clip: { x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: rect.width, height: rect.height, scale: 1 },
});
fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log('已保存', out, rect);

// 顺带把控制台错误与状态回读一下
const diag = await session.evaluate(
  `(function(){ var h = document.getElementById('freebuddy-host'); var s = h && h.shadowRoot; return JSON.stringify({ railItems: s ? s.querySelectorAll('.fb-rail-item').length : 0, activeTab: s && s.querySelector('.fb-rail-item.is-active') ? s.querySelector('.fb-rail-item.is-active').dataset.tab : null, rows: s ? s.querySelectorAll('.fb-row').length : 0, foot: s && s.querySelector('.fb-foot') ? s.querySelector('.fb-foot').textContent : null }); })()`,
);
console.log('面板状态:', diag);
session.close();
