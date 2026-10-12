// 公开页配图：截面板（默认账号页），并量出「账号名字 / 手机号」的打码矩形。
// 产出两个文件：原始截图（未打码，只留本机，别提交）+ 打码矩形 JSON（CSS 像素，坐标相对截图左上角）。
// 再由 tools/mask-public.py 按 JSON 在马赛克掉对应区域，写进 assets/。
// 打码范围（2026-10-12 口径）：顶栏当前账号名字 + 每行账号名字 + 每行手机号；其余全部原样可见。
import fs from 'node:fs';
import path from 'node:path';
import { attach } from '../src/cdplink.mjs';
import { dataDir } from '../src/config.mjs';

const rawOut = process.argv[2] || 'tools/_public-raw.png';
const rectOut = process.argv[3] || 'tools/_public-masks.json';
const tab = process.argv[4] || 'accounts';

const a = await attach(9222);
if (!a) {
  console.log('未连上 CDP');
  process.exit(1);
}
const { session } = a;
await session.send('Page.enable');

const token = fs.readFileSync(path.join(dataDir(), '.api-token'), 'utf8').trim();
const r = await fetch('http://127.0.0.1:47842/api/inject', { method: 'POST', headers: { 'X-FreeBuddy-Token': token } });
console.log('重新注入:', (await r.text()).slice(0, 60));
await new Promise((res) => setTimeout(res, 700));

await session.evaluate(
  `(function(){ var w = window.__fbWidget; if (w) w.open(); var h = document.getElementById('freebuddy-host'); var b = h.shadowRoot.querySelector('.fb-rail-item[data-tab="${tab}"]'); if (b) b.click(); return true; })()`,
);
await new Promise((res) => setTimeout(res, 1800));

const dataRaw = await session.evaluate(`(function(){
  var s = document.getElementById('freebuddy-host').shadowRoot;
  var panel = s.querySelector('.fb-panel');
  if (!panel || !panel.classList.contains('is-open')) return null;
  var pr = panel.getBoundingClientRect();
  function rel(el){ var r = el.getBoundingClientRect(); return { x: r.x - pr.x, y: r.y - pr.y, w: r.width, h: r.height }; }
  var out = { panel: { x: pr.x, y: pr.y, w: pr.width, h: pr.height }, masks: [] };
  var hb = s.querySelector('.fb-head .fb-chip b');
  if (hb) out.masks.push({ kind: 'header-name', rect: rel(hb) });
  var rows = s.querySelectorAll('.fb-row.is-acct');
  for (var i = 0; i < rows.length; i++) {
    var n = rows[i].querySelector('.fb-acct-name');
    if (n) out.masks.push({ kind: 'name', row: i, rect: rel(n) });
    var spans = rows[i].querySelectorAll('.fb-acct-mid span');
    for (var j = 0; j < spans.length; j++) {
      if (spans[j].textContent.indexOf('手机') === 0) {
        var b = spans[j].querySelector('.fb-mono');
        if (b) out.masks.push({ kind: 'phone', row: i, rect: rel(b) });
      }
    }
  }
  return JSON.stringify(out);
})()`);
if (!dataRaw) {
  console.log('面板没打开');
  process.exit(1);
}
const data = JSON.parse(dataRaw);

const clip = {
  x: Math.max(0, data.panel.x),
  y: Math.max(0, data.panel.y),
  width: data.panel.w,
  height: data.panel.h,
  scale: 1,
};
const shot = await session.send('Page.captureScreenshot', { format: 'png', clip });
fs.writeFileSync(rawOut, Buffer.from(shot.data, 'base64'));

// 截图输出的像素宽 / clip 的 CSS 宽 = 实际倍率（Retina 下是 2）
const pngW = readPngWidth(fs.readFileSync(rawOut));
const scale = pngW ? pngW / clip.width : 1;
fs.writeFileSync(
  rectOut,
  JSON.stringify({ scale, clip: { w: clip.width, h: clip.height }, masks: data.masks }, null, 2),
);
console.log('已保存', rawOut, '尺寸', pngW + 'px, 倍率', scale, '打码块', data.masks.length);
session.close();

function readPngWidth(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return 0;
  return buf.readUInt32BE(16);
}
