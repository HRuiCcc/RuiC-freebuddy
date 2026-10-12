// 探针：消息列表的真实结构 —— 每条消息的容器/状态类/动作行。
// 安全：只报结构，不打印正文。
import { attach } from '../src/cdplink.mjs';

const a = await attach(9222);
if (!a) { console.log('未连上 CDP'); process.exit(1); }
const { session } = a;

const evalJson = async (js) => {
  const r = await session.evaluate(js);
  try { return typeof r === 'string' ? JSON.parse(r) : r; } catch { return r; }
};

// 0. 如果当前不在会话里（没有消息列表），点开侧边栏第一条会话
const opened = await evalJson(`(function(){
  if (document.querySelector('.cr-message-list__content')) return 'already-in-conversation';
  var cards = document.querySelectorAll('[class*="cb-agent-card"]');
  for (var i=0;i<cards.length;i++){
    var c = cards[i];
    if (c.closest('#freebuddy-host')) continue;
    if (c.getBoundingClientRect().width < 100) continue;
    c.click();
    return 'clicked';
  }
  return 'no-card';
})()`);
console.log('进入会话:', opened);
if (opened === 'clicked') await new Promise((r) => setTimeout(r, 2500));

const out = await session.evaluate(`(function(){
  function cls(el){ return (el.getAttribute && el.getAttribute('class') || '').slice(0,140); }
  function rect(el){ var r=el.getBoundingClientRect(); return [Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)]; }
  function clean(el){ return el.cloneNode(true); }
  var o = {};

  // 发送按钮当前状态（生成中会带 --stop）
  var send = document.querySelector('.cr-send-button');
  o.sendButton = send ? { class: cls(send), disabled: !!send.disabled, aria: send.getAttribute('aria-label'), rect: rect(send) } : null;

  // 消息列表内容区
  var content = document.querySelector('.cr-message-list__content');
  o.contentClass = content ? cls(content) : null;
  o.contentKids = content ? content.children.length : 0;

  // 消息项：内容区里逐层往下找「有实质高度」的直接子元素
  function directChildren(root, maxDepth) {
    var lvl = [root], all = [];
    for (var d = 0; d < maxDepth && lvl.length; d++) {
      var next = [];
      for (var i = 0; i < lvl.length; i++) {
        var kids = [].slice.call(lvl[i].children || []);
        for (var j = 0; j < kids.length; j++) {
          var r = kids[j].getBoundingClientRect();
          if (r.height < 12) continue;
          all.push({ el: kids[j], depth: d });
          next.push(kids[j]);
        }
      }
      lvl = next;
    }
    return all;
  }
  var nodes = [];
  if (content) {
    // 只取路径上「像一条消息」的：深度 0-3，且宽度 > 400
    nodes = directChildren(content, 4).filter(function(n){
      var r = n.el.getBoundingClientRect();
      return r.width > 400;
    }).slice(0, 30);
  }
  o.nodes = nodes.map(function(n){
    var el = n.el, r = el.getBoundingClientRect();
    return { depth: n.depth, tag: el.tagName.toLowerCase(), class: cls(el), rect: rect(el), kids: el.children.length };
  });

  // 状态标记：这些类名出现就说明有错误/取消/中断
  var marks = ['cr-error','cr-status-error','cr-cancelled-indicator','cr-conversation-event--cancelled','cr-widget-error','cr-tool-call__error','cr-agent--with-status','cr-agent__completion-status','cr-agent__processing-status','cr-internal-status-error'];
  o.marks = [];
  marks.forEach(function(m){
    var list = document.querySelectorAll('[class*="'+m+'"]');
    for (var i=0;i<list.length;i++){
      var el = list[i];
      if (el.closest && el.closest('#freebuddy-host')) continue;
      o.marks.push({ mark: m, tag: el.tagName.toLowerCase(), class: cls(el), rect: rect(el), text: (el.textContent||'').trim().slice(0,40) });
    }
  });
  o.marks = o.marks.slice(0, 20);

  // 消息动作行（复制/重试/编辑等）
  o.actionRows = [];
  [].slice.call(document.querySelectorAll('[class*="action" i],[class*="toolbar" i],[class*="footer" i]')).forEach(function(el){
    if (el.closest && el.closest('#freebuddy-host')) return;
    var r = el.getBoundingClientRect();
    if (r.height > 48 || r.height < 10 || r.width < 60) return;
    var btns = el.querySelectorAll('button,[role="button"]');
    if (!btns.length) return;
    var txt = [];
    for (var i=0;i<btns.length;i++) txt.push((btns[i].getAttribute('aria-label')||btns[i].getAttribute('title')||(btns[i].textContent||'').trim()).slice(0,10));
    o.actionRows.push({ class: cls(el), rect: rect(el), btns: txt.slice(0,8) });
  });
  o.actionRows = o.actionRows.slice(0, 12);

  return JSON.stringify(o);
})()`);

const d = typeof out === 'string' ? JSON.parse(out) : out;
console.log('发送按钮:', JSON.stringify(d.sendButton));
console.log('内容区:', d.contentClass, '子元素', d.contentKids);
console.log('\n=== 消息结构树（深度/类名/尺寸） ===');
for (const n of d.nodes) console.log(`  d${n.depth} <${n.tag}> kids=${String(n.kids).padEnd(3)} rect=${n.rect.join(',').padEnd(22)} class="${n.class}"`);
console.log('\n=== 状态标记 ===');
if (!d.marks.length) console.log('  （无）');
for (const m of d.marks) console.log(`  [${m.mark}] <${m.tag}> rect=${m.rect.join(',')} text="${m.text}" class="${m.class}"`);
console.log('\n=== 动作行 ===');
if (!d.actionRows.length) console.log('  （无）');
for (const r of d.actionRows) console.log(`  rect=${r.rect.join(',').padEnd(22)} btns=[${r.btns.join(' | ')}] class="${r.class}"`);

session.close?.();
process.exit(0);
