'use strict';
/* FreeBuddy 控制台渲染进程：只通过 window.fb 这个窄接口和主进程说话。 */
const $ = (id) => document.getElementById(id);
const fmtTime = (t) => new Date(t).toTimeString().slice(0, 8);

/* ───────── 左侧菜单切换 ───────── */
function showView(name) {
  for (const v of document.querySelectorAll('.view')) v.classList.toggle('is-active', v.dataset.view === name);
  for (const b of document.querySelectorAll('.rail-item[data-view]')) b.classList.toggle('is-active', b.dataset.view === name);
}
for (const b of document.querySelectorAll('.rail-item[data-view]')) b.addEventListener('click', () => showView(b.dataset.view));
for (const b of document.querySelectorAll('[data-goto]')) b.addEventListener('click', () => showView(b.dataset.goto));

/* ───────── 状态磁贴 ───────── */
function setTile(id, state, text) {
  const el = $(id);
  el.classList.remove('is-ok', 'is-warn', 'is-off');
  el.classList.add(state);
  el.querySelector('em').textContent = text;
}
const shortUid = (u) => (!u ? '—' : String(u).length > 14 ? String(u).slice(0, 8) + '…' + String(u).slice(-4) : String(u));

let lastState = {};
async function refresh() {
  let s;
  try { s = await window.fb.status(); } catch { return; }
  lastState = s;

  // 磁贴
  const d = s.daemon;
  setTile('t-daemon', d ? 'is-ok' : 'is-off', d ? '运行中' : '未运行');
  setTile('t-cdp', d && d.cdpConnected ? 'is-ok' : d && d.cdpError ? 'is-warn' : 'is-off',
    d ? (d.cdpConnected ? '已连通' : (d.cdpError ? '连不上' : '未连')) : '未运行');
  setTile('t-panel', d && d.lastInjectAt ? 'is-ok' : d ? 'is-warn' : 'is-off',
    d && d.lastInjectAt ? '已挂载 ' + fmtTime(d.lastInjectAt) : d ? '还没挂上' : '未运行');
  setTile('t-account', d && d.current ? 'is-ok' : 'is-off', d && d.current ? shortUid(d.current) : '未读到');

  // 头部
  $('chip-ver').textContent = 'v' + s.app.version;
  $('about-ver').textContent = 'v' + s.app.version;
  $('head-sub').textContent = s.daemon
    ? `${s.profile.name} · 本地接口 127.0.0.1:${s.profile.apiPort} · 守护进程 PID ${s.daemon.pid ?? '—'}`
    : `${s.profile.name} · 守护进程尚未运行`;

  // 本机信息
  $('v-exe').textContent = s.workBuddyExe + (s.workBuddyExeExists ? '' : '（找不到，可能没装）');
  $('v-dir').textContent = s.dataDir;
  $('v-api').textContent = `http://127.0.0.1:${s.profile.apiPort}`;
  $('v-port').textContent = String(s.profile.cdpPort);

  // 档案下拉
  const sel = $('profile');
  if (sel.options.length !== s.profiles.length) {
    sel.textContent = '';
    for (const p of s.profiles) { const o = document.createElement('option'); o.value = p.id; o.textContent = p.name; sel.appendChild(o); }
  }
  sel.value = s.profile.id;

  // 设置
  $('opt-autostart').checked = !!s.autostart;
  $('opt-tray').checked = !!s.closeToTray;

  // 忙碌态
  const busy = !!s.busy;
  for (const id of ['btn-launch', 'btn-panel', 'btn-stop']) $(id).disabled = busy;
  $('busy-hint').textContent = busy ? `正在执行：${s.busy}…` : '';

  renderSessionLog();
}

/* ───────── 日志 ───────── */
const session = [];
window.fb.onLog((line) => {
  session.push(`[${fmtTime(Date.now())}] ${line}`);
  if (session.length > 300) session.shift();
  renderSessionLog();
});
function renderSessionLog() {
  const text = session.length ? session.slice(-120).join('\n') : '（暂无输出）';
  $('log-mini').textContent = text;
  const full = $('log-session');
  full.textContent = text;
  full.scrollTop = full.scrollHeight;
}
async function refreshDaemonLog() {
  try {
    const { daemon } = await window.fb.logTail();
    const lines = (daemon || []).filter((l) => l.trim());
    const pre = $('log-daemon');
    pre.textContent = lines.length ? lines.slice(-120).join('\n') : '（读不到日志文件）';
    pre.scrollTop = pre.scrollHeight;
  } catch {}
}

/* ───────── 操作按钮 ───────── */
function guard(fn) {
  return async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try { await fn(); } finally { setTimeout(() => refresh(), 400); }
  };
}
$('btn-launch').addEventListener('click', guard(async () => { $('launch-note').textContent = '正在接管客户端，可能需要十几秒…'; await window.fb.launch(); }));
$('btn-panel').addEventListener('click', guard(async () => { await window.fb.openPanel(); }));
$('btn-stop').addEventListener('click', guard(async () => { await window.fb.stop(); }));
$('btn-dir').addEventListener('click', () => window.fb.openDir());
$('btn-log-open').addEventListener('click', () => window.fb.openLog());
$('btn-log-clear').addEventListener('click', async () => { await window.fb.clearLog(); session.length = 0; renderSessionLog(); });
$('rail-quit').addEventListener('click', () => window.fb.quit());

/* ───────── 设置项 ───────── */
$('opt-autostart').addEventListener('change', (e) => window.fb.setAutostart(e.target.checked));
$('opt-tray').addEventListener('change', (e) => window.fb.setCloseToTray(e.target.checked));
$('profile').addEventListener('change', async (e) => {
  const id = e.target.value;
  $('head-sub').textContent = '切换客户端档案中…';
  await window.fb.setProfile(id);
  refresh();
});

/* ───────── 轮询 ───────── */
refresh();
setInterval(refresh, 2500);
setInterval(refreshDaemonLog, 3000);
refreshDaemonLog();
