// 探针：连上正在运行的 WorkBuddy CDP，回报目标页与注入面板的真实 DOM 情报。
// 只做只读查询（外加把面板自身区域截图），不触碰会话内容。
import { writeFileSync } from 'node:fs';

const PORT = Number(process.env.FB_CDP_PORT || 9222);

async function jsonList(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!res.ok) throw new Error(`/json/list ${res.status}`);
  return res.json();
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    let id = 0;
    ws.addEventListener('open', () =>
      resolve({
        send(method, params = {}) {
          const msgId = ++id;
          ws.send(JSON.stringify({ id: msgId, method, params }));
          return new Promise((res, rej) => pending.set(msgId, { res, rej }));
        },
        close: () => ws.close(),
      }),
    );
    ws.addEventListener('error', (e) => reject(new Error(String(e?.message || e))));
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
      } catch {
        return;
      }
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.rej(new Error(JSON.stringify(msg.error)));
      else p.res(msg.result);
    });
  });
}

const targets = await jsonList(PORT);
console.log('=== CDP 目标 ===');
for (const t of targets) {
  console.log(`[${t.type}] ${t.title} | ${t.url.slice(0, 90)} | ${t.id}`);
}

const page = targets.find((t) => t.type === 'page' && /WorkBuddy|workbuddy/i.test(t.url + t.title));
if (!page) {
  console.log('未找到 WorkBuddy page 目标');
  process.exit(1);
}
console.log('\n选用目标:', page.title, page.webSocketDebuggerUrl);

const cdp = await connect(page.webSocketDebuggerUrl);
await cdp.send('Runtime.enable');

const probe = `(() => {
  const q = (s) => document.querySelector(s);
  const qa = (s) => Array.from(document.querySelectorAll(s)).length;
  const cls = (el) => el ? (el.className && el.className.toString ? el.className.toString() : String(el.className)) : null;
  const out = {
    url: location.href,
    readyState: document.readyState,
    viewport: { w: innerWidth, h: innerHeight },
    htmlAttrs: Array.from(document.documentElement.attributes).map(a => a.name + '=' + a.value).slice(0, 24),
    bodyAttrs: Array.from(document.body.attributes).map(a => a.name + '=' + a.value).slice(0, 24),
    injected: {
      injectedHosts: qa('#freebuddy-host'),
      fbWidget: typeof window.__fbWidget,
      panelSize: null,
      fabRect: null,
      panelRect: null,
            
    },
    anchors: {
      crInputToolbarRight: qa('div.cr-input-toolbar__right'),
      inputBottom: qa('[class*="_inputBottom_"]'),
      voiceMicWrap: qa('.voice-mic-wrap'),
      sendButton: qa('button.cr-send-button:not(.cr-send-button--stop)'),
      sendButtonCls: cls(q('button.cr-send-button')),
      contentEditable: qa('[contenteditable="true"]'),
      slateEditor: qa('[data-slate-editor="true"]'),
      conversationInput: qa('.conversation-input'),
      crInputBox: qa('.cr-input-box'),
      crDocument: qa('.cr-document[data-root-id]'),
      conversationItem: qa('.conversation-item[data-conversation-id]'),
      messageQueueItem: qa('.cb-message-queue-item'),
      queueActions: qa('.cb-message-queue-item-actions'),
      cbAssistant: qa('.cb-assistant-message'),
      cbMarkdown: qa('.cb-markdown'),
      root: qa('#root'),
      navRail: qa('.wb-scene-tabs'),
    },
    toolbarRightHTML: (() => { const el = q('div.cr-input-toolbar__right'); return el ? el.outerHTML.slice(0, 3000) : null; })(),
    inputAreaHTML: (() => { const el = q('.cr-input-toolbar'); return el ? el.outerHTML.slice(0, 2500) : null; })(),
    cssVars: (() => {
      const cs = getComputedStyle(document.documentElement);
      const names = ['--wb-bg-primary','--wb-bg-secondary','--wb-bg-popover','--wb-border-subtle','--wb-color-text-primary','--wb-icon-secondary','--wb-accent-blue','--wb-button-primary-bg'];
      const o = {};
      for (const n of names) o[n] = cs.getPropertyValue(n).trim();
      return o;
    })(),
  };
  return JSON.stringify(out, null, 2);
})()`;

const r = await cdp.send('Runtime.evaluate', { expression: probe, returnByValue: true });
console.log('\n=== 渲染进程情报 ===');
console.log(r.result.value);

// 只截面板自身区域（不涉及用户会话内容）
try {
  const rectRes = await cdp.send('Runtime.evaluate', {
    expression: `(() => { const h = document.getElementById('freebuddy-host'); const p = h && h.shadowRoot && h.shadowRoot.querySelector('.fb-panel'); if (!p || !p.classList.contains('is-open')) return null; const r = p.getBoundingClientRect(); return JSON.stringify({x:r.x,y:r.y,width:r.width,height:r.height}); })()`,
    returnByValue: true,
  });
  const raw = rectRes.result.value;
  if (raw) {
    const rect = JSON.parse(raw);
    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: rect.width, height: rect.height, scale: 1 },
    });
    writeFileSync('tools/panel-live.png', Buffer.from(shot.data, 'base64'));
    console.log('\n面板截图已保存 tools/panel-live.png', rect);
  } else {
    console.log('\n面板当前未展开，跳过截图');
  }
} catch (e) {
  console.log('截图失败:', e.message);
}

cdp.close();
