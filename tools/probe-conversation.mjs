// 探针：打开一个会话，看消息流 / 输入框在会话里的真实结构。
//
// 安全：只报结构（标签 / class / aria / 计数），不打印聊天正文。
// 只做「点开侧边栏第一条会话」这一个动作，不发送任何消息。
//
//   node tools/probe-conversation.mjs
import { attach } from '../src/cdplink.mjs';

const a = await attach(9222);
if (!a) {
  console.log('未连上 CDP');
  process.exit(1);
}
const { session } = a;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (js) => {
  const r = await session.evaluate(js);
  try {
    return typeof r === 'string' ? JSON.parse(r) : r;
  } catch {
    return r;
  }
};

// 1. 点开侧边栏第一条会话卡片（只点一次）
const clicked = await ev(`(function(){
  var cards = document.querySelectorAll('conversation-tasks-independent-block [class*="cb-agent-card"], [class*="cb-agent-card"]');
  for (var i=0;i<cards.length;i++){
    var c = cards[i];
    if (c.closest('#freebuddy-host')) continue;
    var r = c.getBoundingClientRect();
    if (r.width < 100) continue;
    c.click();
    return 'clicked';
  }
  return 'no-card';
})()`);
console.log('点开会话:', clicked);
await wait(2500);

const out = await ev(`(function(){
  function cls(el){ return (el.getAttribute && el.getAttribute('class') || '').slice(0,110); }
  function rect(el){ var r=el.getBoundingClientRect(); return [Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)]; }
  var o = {};

  // 输入框（会话里叫什么）
  var eds = [].slice.call(document.querySelectorAll('[contenteditable="true"], textarea')).filter(function(e){ return !(e.closest && e.closest('#freebuddy-host')); });
  o.editables = eds.map(function(e){ return { tag:e.tagName.toLowerCase(), class:cls(e), ce:!!e.isContentEditable, rect:rect(e), role:e.getAttribute('role') }; });

  // 输入框工具栏（cr-* 命名空间）现在有哪些
  var crEls = [].slice.call(document.querySelectorAll('[class*="cr-"]'));
  var toolbar = [];
  crEls.forEach(function(e){
    var c = cls(e); if (!/cr-(add-menu|voice|send|model|input|toolbar|action)/.test(c)) return;
    var r = e.getBoundingClientRect(); if (r.width < 8) return;
    toolbar.push({ class:c, aria:e.getAttribute('aria-label'), title:e.getAttribute('title'), text:(e.textContent||'').trim().slice(0,10), rect:rect(e) });
  });
  o.composerToolbar = toolbar.slice(0, 25);

  // 消息流：主区域里最大的滚动容器
  var best = null;
  [].slice.call(document.querySelectorAll('main *, [class*="chat" i], [class*="message" i], [class*="session" i]')).forEach(function(el){
    if (el.closest && el.closest('#freebuddy-host')) return;
    var cs = getComputedStyle(el);
    if (!/(auto|scroll)/.test(cs.overflowY)) return;
    var r = el.getBoundingClientRect();
    if (r.height < 200 || r.width < 300) return;
    if (!best || r.height > best.r[3]) best = { el: el, r: rect(el) };
  });
  if (best) {
    o.scroller = { class: cls(best.el), rect: best.r, kids: best.el.children.length };
    var kids = [].slice.call(best.el.children);
    o.scrollerFirstChild = kids[0] ? { tag: kids[0].tagName.toLowerCase(), class: cls(kids[0]), kids: kids[0].children.length } : null;
    o.scrollerLastChild = kids.length ? { tag: kids[kids.length-1].tagName.toLowerCase(), class: cls(kids[kids.length-1]), kids: kids[kids.length-1].children.length } : null;
  }

  // 消息项候选：主区域里有 data-testid / data-role / 消息语义类的元素
  var msgSel = '[data-testid],[data-role],[data-message-id],[class*="message" i],[class*="bubble" i],[class*="turn" i]';
  var msgs = [].slice.call(document.querySelectorAll(msgSel)).filter(function(el){
    if (el.closest && el.closest('#freebuddy-host')) return false;
    var r = el.getBoundingClientRect();
    return r.height > 20 && r.width > 200;
  });
  o.msgCount = msgs.length;
  o.msgSamples = msgs.slice(0, 14).map(function(el){
    return {
      tag: el.tagName.toLowerCase(),
      class: cls(el),
      testid: el.getAttribute('data-testid'),
      role: el.getAttribute('data-role') || el.getAttribute('role'),
      msgRole: el.getAttribute('data-message-role') || el.getAttribute('data-author'),
      rect: rect(el)
    };
  });

  // 有无「停止生成 / 重试 / 继续」迹象（按 aria/title/class 判，不看正文）
  var sig = [];
  [].slice.call(document.querySelectorAll('button,[role="button"]')).forEach(function(b){
    if (b.closest && b.closest('#freebuddy-host')) return;
    var s = ((b.getAttribute('aria-label')||'')+' '+(b.getAttribute('title')||'')+' '+cls(b)).toLowerCase();
    if (/stop|abort|retry|regenerate|resume|停止|重试|重新生成|继续/.test(s)) {
      sig.push({ class: cls(b).slice(0,80), aria: b.getAttribute('aria-label'), title: b.getAttribute('title'), text:(b.textContent||'').trim().slice(0,12), rect: rect(b) });
    }
  });
  o.signalButtons = sig.slice(0, 12);

  // 错误/中断提示类元素
  var errs = [].slice.call(document.querySelectorAll('[class*="error" i],[class*="fail" i],[class*="interrupt" i],[class*="abort" i],[class*="retry" i]')).filter(function(el){
    if (el.closest && el.closest('#freebuddy-host')) return false;
    var r = el.getBoundingClientRect();
    return r.height > 10 && r.width > 60;
  });
  o.errorLike = errs.slice(0, 12).map(function(el){ return { tag: el.tagName.toLowerCase(), class: cls(el), rect: rect(el) }; });

  return JSON.stringify(o);
})()`);

console.log('\n=== 输入框 ===');
for (const e of out.editables || []) console.log(`  <${e.tag}> ce=${e.ce} rect=${e.rect.join(',')} class="${e.class}" role=${e.role}`);
console.log('\n=== 输入框工具栏 (cr-*) ===');
for (const t of out.composerToolbar || []) console.log(`  rect=${t.rect.join(',').padEnd(20)} aria=${t.aria} title=${t.title} text="${t.text}" class="${t.class}"`);
console.log('\n=== 滚动容器 ===');
console.log(' ', JSON.stringify(out.scroller), '\n  first:', JSON.stringify(out.scrollerFirstChild), '\n  last :', JSON.stringify(out.scrollerLastChild));
console.log('\n=== 消息项 (' + out.msgCount + ') ===');
for (const m of out.msgSamples || []) console.log(`  <${m.tag}> testid=${m.testid} role=${m.role} msgRole=${m.msgRole} rect=${m.rect.join(',')} class="${m.class}"`);
console.log('\n=== 停止/重试/继续 迹象 ===');
for (const s of out.signalButtons || []) console.log(`  rect=${s.rect.join(',').padEnd(20)} aria=${s.aria} title=${s.title} text="${s.text}" class="${s.class}"`);
console.log('\n=== 错误/中断类元素 ===');
for (const e of out.errorLike || []) console.log(`  <${e.tag}> rect=${e.rect.join(',')} class="${e.class}"`);

session.close?.();
process.exit(0);
