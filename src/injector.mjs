// 注入器：把面板打包成一段脚本，经 CDP Runtime.evaluate 推进 WorkBuddy 渲染进程。
// 面板本体跑在 Shadow DOM 里（与官方 700+ 全局 class 隔离），只读官方 --wb-* token 取色。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND, VERSION, HOST, profile } from './config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PANEL_DIR = path.join(here, 'panel');

let cache = { mtime: 0, payload: null };

function readPanel() {
  const cssPath = path.join(PANEL_DIR, 'panel.css');
  const jsPath = path.join(PANEL_DIR, 'panel.js');
  const stamps = [fs.statSync(cssPath).mtimeMs, fs.statSync(jsPath).mtimeMs].join(':');
  const key = Number(stamps.split(':')[0]) + Number(stamps.split(':')[1]) / 1e6;
  if (cache.mtime === key && cache.payload) return cache.payload;
  const css = fs.readFileSync(cssPath, 'utf8');
  const js = fs.readFileSync(jsPath, 'utf8');
  const payload = { css, js };
  cache = { mtime: key, payload };
  return payload;
}

export function buildInjectScript({ apiBase, apiToken, forcedPort }) {
  const { css, js } = readPanel();
  const p = profile();
  const config = {
    brand: BRAND,
    version: VERSION,
    apiBase,
    apiToken,
    profileId: p.id,
    isAi: !!p.isAi,
    appName: p.name,
    platform: process.platform,
    uiPort: forcedPort,
  };
  return `
(function () {
  var FB_CONFIG = ${JSON.stringify(config)};
  var FB_CSS = ${JSON.stringify(css)};
  var FB_UI = function () {
${js}
  };
  ${RUNTIME_SHIM}
  try {
    if (window.__fbWidget && typeof window.__fbWidget.destroy === 'function') {
      window.__fbWidget.destroy();
    }
  } catch (e) {}
  try { delete window.__fbWidget; } catch (e) { window.__fbWidget = undefined; }
  var host = document.getElementById('freebuddy-host');
  if (host && host.parentNode) host.parentNode.removeChild(host);
  window.__fbWidget = FB_UI();
})();`.trim();
}

// 面板代码用到的极简运行时辅助（注入到页面上下文，随面板一起执行）
const RUNTIME_SHIM = `
  function fbEl(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
`;

export async function injectWidget(session, opts) {
  const script = buildInjectScript(opts);
  await session.evaluate('true');
  await session.evaluate(script);
  // 回读校验：宿主元素 + 面板导出接口
  const probe = await session.evaluate(
    `JSON.stringify({ host: !!document.getElementById('freebuddy-host'), api: typeof window.__fbWidget, fab: !!document.querySelector('#freebuddy-host') })`,
  );
  return JSON.parse(probe);
}

export async function destroyWidget(session) {
  try {
    await session.evaluate(
      `(function(){ try { if (window.__fbWidget && window.__fbWidget.destroy) window.__fbWidget.destroy(); } catch(e){} try { delete window.__fbWidget } catch(e){ window.__fbWidget = undefined } var h = document.getElementById('freebuddy-host'); if (h && h.parentNode) h.parentNode.removeChild(h); return true })()`,
    );
    return true;
  } catch {
    return false;
  }
}
