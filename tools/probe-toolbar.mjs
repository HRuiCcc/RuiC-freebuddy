// 探针：精确定位输入框工具栏里「暂存提示词 / 继续执行 / 继续」这些元素。
// 安全：只报结构，不打印聊天正文。
import { attach } from '../src/cdplink.mjs';

const a = await attach(9222);
if (!a) { console.log('未连上 CDP'); process.exit(1); }
const { session } = a;

const out = await session.evaluate(`(function(){
  function cls(el){ return (el.getAttribute && el.getAttribute('class') || '').slice(0,120); }
  function rect(el){ var r=el.getBoundingClientRect(); return [Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)]; }
  function path(el){
    var p=[], cur=el;
    for (var i=0;i<5 && cur && cur.tagName;i++){ p.unshift(cur.tagName.toLowerCase()+(cur.getAttribute('class')?'.'+String(cur.getAttribute('class')).split(' ')[0]:'')); cur=cur.parentElement; }
    return p.join(' > ');
  }
  var RE = /暂存|继续执行|快捷短语|继续/;
  var hits = [];
  [].slice.call(document.querySelectorAll('button,[role="button"],[class*="btn"],[class*="button"],div[tabindex],span[tabindex]')).forEach(function(el){
    if (el.closest && el.closest('#freebuddy-host')) return;
    var t = (el.textContent||'').trim();
    if (!t || t.length > 24) return;
    if (!RE.test(t)) return;
    var r = el.getBoundingClientRect();
    hits.push({
      tag: el.tagName.toLowerCase(),
      class: cls(el),
      aria: el.getAttribute('aria-label'),
      title: el.getAttribute('title'),
      text: t,
      rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      visible: r.width > 0 && r.height > 0,
      path: path(el)
    });
  });
  // 去掉被包含者（保留最内层元素）
  var inner = hits.filter(function(h){
    return !hits.some(function(o){ return o !== h && o.path.length > h.path.length && o.path.indexOf(h.path) === 0; });
  });
  return JSON.stringify({ raw: hits.length, kept: inner.length, hits: inner.slice(0,30) });
})()`);

const d = typeof out === 'string' ? JSON.parse(out) : out;
console.log('命中', d.raw, '个，保留最内层', d.kept, '个\n');
for (const h of d.hits) {
  console.log(`<${h.tag}> vis=${h.visible?1:0} rect=${h.rect.join(',').padEnd(20)} text="${h.text}"`);
  console.log(`    aria=${h.aria} title=${h.title}`);
  console.log(`    class="${h.class}"`);
  console.log(`    path= ${h.path}`);
  console.log('');
}

session.close?.();
process.exit(0);
