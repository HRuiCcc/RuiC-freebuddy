// 探针：WorkBuddy 输入框（composer）与消息流的真实 DOM 结构。
//
// 用途：给「异常中断自动续接 / 暂存提示词按钮 / 快捷短语按钮」这三项找锚点。
// 安全：**只报结构**（标签名 / class / aria / 尺寸 / 计数），不打印任何聊天正文。
//
//   node tools/probe-composer.mjs
import { attach } from '../src/cdplink.mjs';

const a = await attach(9222);
if (!a) {
  console.log('未连上 CDP（WorkBuddy 没带调试端口跑？先跑 node src/launcher.mjs）');
  process.exit(1);
}
const { session } = a;

const SCRIPT = `(function(){
  function cls(el){ return (el.getAttribute && el.getAttribute('class') || '').slice(0,120); }
  function rect(el){ var r = el.getBoundingClientRect(); return [Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)]; }
  function brief(el){
    if(!el) return null;
    return {
      tag: el.tagName.toLowerCase(),
      class: cls(el),
      role: el.getAttribute('role') || null,
      aria: el.getAttribute('aria-label') || null,
      placeholder: el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || null,
      ce: !!el.isContentEditable,
      id: el.id || null,
      rect: rect(el),
      childCount: el.children ? el.children.length : 0
    };
  }
  var out = { url: location.origin + location.pathname, title: document.title };

  // 1. 所有可编辑区
  var editable = [].slice.call(document.querySelectorAll('[contenteditable="true"], [contenteditable=""], textarea'));
  out.editables = editable.map(function(el){
    var o = brief(el);
    o.inPanel = !!(el.closest && el.closest('#freebuddy-host'));
    o.visible = o.rect[2] > 40 && o.rect[3] > 12;
    return o;
  });

  // 2. 所有按钮（带 aria / title / 短文本）
  var btns = [].slice.call(document.querySelectorAll('button, [role="button"]'));
  out.buttonCount = btns.length;
  out.buttons = btns.filter(function(b){
    if (b.closest && b.closest('#freebuddy-host')) return false;
    var r = b.getBoundingClientRect();
    return r.width > 8 && r.height > 8;
  }).map(function(b){
    return {
      class: cls(b),
      aria: b.getAttribute('aria-label') || null,
      title: b.getAttribute('title') || null,
      text: (b.textContent || '').trim().slice(0, 12),
      disabled: !!b.disabled,
      rect: rect(b),
      svg: !!b.querySelector('svg'),
      inForm: !!b.closest('form')
    };
  }).slice(0, 60);

  // 3. 消息流容器候选
  var cands = ['[class*="message" i]','[class*="Message"]','[class*="chat" i]','[class*="conversation" i]','[class*="thread" i]','[role="log"]','[role="list"]'];
  var seen = new Set(); out.streamCandidates = [];
  cands.forEach(function(sel){
    [].slice.call(document.querySelectorAll(sel)).forEach(function(el){
      if (seen.has(el)) return; seen.add(el);
      if (el.closest && el.closest('#freebuddy-host')) return;
      var r = el.getBoundingClientRect();
      if (r.height < 100) return;
      out.streamCandidates.push({ sel: sel, class: cls(el), rect: rect(el), kids: el.children.length, role: el.getAttribute('role')||null });
    });
  });
  out.streamCandidates = out.streamCandidates.slice(0, 12);

  // 4. 停止/中断相关（生成中通常是「停止」按钮或 stop 图标）
  out.stopLike = btns.filter(function(b){
    var s = ((b.getAttribute('aria-label')||'') + ' ' + (b.getAttribute('title')||'') + ' ' + cls(b)).toLowerCase();
    return /stop|abort|cancel|停止|中断/.test(s);
  }).map(brief).slice(0, 10);

  // 5. 是否有「重试 / 继续 / Retry」类按钮
  out.retryLike = btns.filter(function(b){
    var t = ((b.textContent||'') + ' ' + (b.getAttribute('aria-label')||'') + ' ' + (b.getAttribute('title')||'')).toLowerCase();
    return /retry|continue|resume|重试|继续|重新生成|regenerate/.test(t);
  }).map(function(b){ return { text:(b.textContent||'').trim().slice(0,16), aria:b.getAttribute('aria-label'), title:b.getAttribute('title'), class: cls(b) }; }).slice(0, 10);

  return JSON.stringify(out);
})()`;

const raw = await session.evaluate(SCRIPT);
const data = typeof raw === 'string' ? JSON.parse(raw) : raw;

console.log('页面:', data.title, '|', data.url);
console.log('\n=== 可编辑区 (' + data.editables.length + ') ===');
for (const e of data.editables) {
  console.log(`  <${e.tag}> ce=${e.ce} vis=${e.visible} inPanel=${e.inPanel} rect=${e.rect.join(',')}`);
  console.log(`      class="${e.class}" role=${e.role} ph=${e.placeholder}`);
}
console.log('\n=== 按钮 (' + data.buttonCount + ' 个，可见 ' + data.buttons.length + ') ===');
for (const b of data.buttons) {
  console.log(`  rect=${b.rect.join(',').padEnd(22)} dis=${b.disabled?1:0} svg=${b.svg?1:0} aria=${b.aria} title=${b.title} text="${b.text}" class="${b.class.slice(0,70)}"`);
}
console.log('\n=== 消息流候选 ===');
for (const s of data.streamCandidates) console.log(`  ${s.sel} -> <${s.class.slice(0,60)}> rect=${s.rect.join(',')} kids=${s.kids} role=${s.role}`);
console.log('\n=== 停止/中断类 ===', JSON.stringify(data.stopLike));
console.log('=== 重试/继续类 ===', JSON.stringify(data.retryLike));

session.close?.();
process.exit(0);
