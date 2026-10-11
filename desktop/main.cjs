'use strict';
/**
 * FreeBuddy 桌面控制台（Electron 主进程）
 *
 * 职责：一个真正能装的「软件」外壳 —— 托盘常驻 + 控制台窗口 + 守护进程托管。
 *   · 拉起/托管 FreeBuddy 守护进程（src/daemon.mjs，以 Electron 当 Node 的方式跑）
 *   · 「启动并注入」调用 src/launcher.mjs（接管 WorkBuddy + 注入面板）
 *   · 「停止」调用 src/stop.mjs（摘面板 + 释放唤醒锁 + 停守护）
 *   · 开机自启写 HKCU\...\Run\FreeBuddy = "<exe>" --hidden（与安装包里的宏同名同值）
 *
 * 不重复实现面板：账号/积分/用量那些界面仍然注入在 WorkBuddy 窗口右下角，这里只做控制台。
 */
const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');

const APP_ROOT = path.join(__dirname, '..');
const ICON_PNG = path.join(__dirname, 'assets', 'icon-256.png');
const TRAY_PNG = path.join(__dirname, 'assets', 'tray.png');
const HOST = '127.0.0.1';
const RUN_KEY = 'FreeBuddy';

const PROFILES = {
  'workbuddy-cn': { id: 'workbuddy-cn', name: 'WorkBuddy 国内版', apiPort: 47842, cdpPort: 9222, exe: 'WorkBuddy.exe', appDirRel: ['Programs', 'WorkBuddy'] },
  'workbuddy-ai': { id: 'workbuddy-ai', name: 'WorkBuddy AI', apiPort: 47843, cdpPort: 9223, exe: 'WorkBuddyAI.exe', appDirRel: ['Programs', 'WorkBuddyAI'] },
};

const ROAMING = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const DATA_DIR = process.env.FB_DATA_DIR || path.join(ROAMING, 'FreeBuddy');
const DAEMON_LOG = path.join(DATA_DIR, 'logs', 'daemon.log');

// Chromium 的 userData 默认是 %APPDATA%reebuddy —— Windows 大小写不敏感，那正好跟守护进程的
// %APPDATA%\FreeBuddy 是同一个目录，会把 Cache/Network/Preferences 这些塞进账号备份旁边。
// 显式挪到子目录里，顺便把控制台自己的设置也放进去。
const PROFILE_DIR = path.join(DATA_DIR, 'desktop');
const SETTINGS_FILE = path.join(PROFILE_DIR, 'settings.json');
app.setPath('userData', PROFILE_DIR);

// ── 设置 ────────────────────────────────────────────────────────────────
const defaults = { profile: process.env.FB_PROFILE || 'workbuddy-cn', closeToTray: true };
let settings = { ...defaults };
try {
  Object.assign(settings, JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')));
} catch {}
function saveSettings() {
  try {
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch {}
}
const profile = () => PROFILES[settings.profile] || PROFILES['workbuddy-cn'];
const exePath = () => process.env.FB_WORKBUDDY_EXE || path.join(LOCAL, ...profile().appDirRel, profile().exe);

// ── 会话日志（控制台里能看到的实时输出） ─────────────────────────────────
const sessionLog = [];
let job = null; // { name, child }
function logLine(text) {
  const line = String(text).replace(/\r/g, '');
  for (const part of line.split('\n')) {
    if (!part.trim()) continue;
    sessionLog.push({ at: Date.now(), text: part });
    if (sessionLog.length > 400) sessionLog.shift();
    if (win && !win.isDestroyed()) win.webContents.send('fb:log', part);
  }
}

// ── 守护进程 ────────────────────────────────────────────────────────────
function token() {
  try { return fs.readFileSync(path.join(DATA_DIR, '.api-token'), 'utf8').trim(); } catch { return ''; }
}
async function api(pathname, opts = {}) {
  const r = await fetch(`http://${HOST}:${profile().apiPort}${pathname}`, {
    ...opts,
    headers: { 'X-FreeBuddy-Token': token(), ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
    signal: AbortSignal.timeout(opts.timeoutMs || 9000),
  });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { ok: r.ok, raw: text }; }
}
async function ping() {
  try {
    const r = await fetch(`http://${HOST}:${profile().apiPort}/api/ping`, { signal: AbortSignal.timeout(1200) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
// 与 launcher.mjs 同一套：守护进程用「Electron 当 Node」跑，detached 存活于本程序退出之后
function spawnNode(relPath, extraEnv = {}) {
  return spawn(process.execPath, [path.join(APP_ROOT, relPath)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', FB_PROFILE: settings.profile, ...extraEnv },
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
}
async function ensureDaemon(timeoutMs = 15000) {
  const p = await ping();
  if (p && p.brand === 'FreeBuddy') return true;
  logLine('守护进程未运行，正在拉起…');
  const child = spawnNode(path.join('src', 'daemon.mjs'));
  child.unref();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(600);
    const p2 = await ping();
    if (p2 && p2.brand === 'FreeBuddy') { logLine('守护进程已就绪'); return true; }
  }
  logLine(`守护进程没起来，请看 ${DAEMON_LOG}`);
  return false;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 长任务：启动 / 停止 ──────────────────────────────────────────────────
function runScript(relPath, name) {
  if (job && !job.child.killed) return { ok: false, error: `正在执行「${job.name}」，请等它结束` };
  logLine(`── ${name} ──`);
  const child = spawn(process.execPath, [path.join(APP_ROOT, relPath)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', FB_PROFILE: settings.profile },
    windowsHide: true,
  });
  job = { name, child };
  child.stdout.on('data', (d) => logLine(d.toString('utf8')));
  child.stderr.on('data', (d) => logLine(d.toString('utf8')));
  return new Promise((resolve) => {
    child.on('exit', (code) => {
      logLine(`── ${name}结束（退出码 ${code}） ──`);
      job = null;
      resolve({ ok: code === 0, code });
    });
    child.on('error', (e) => {
      logLine(`── ${name}失败：${e.message} ──`);
      job = null;
      resolve({ ok: false, error: e.message });
    });
  });
}

// ── WorkBuddy 窗口前台化 ─────────────────────────────────────────────────
// 只 AppActivate 不够：从「没有控制台」的宿主（进去模式下的我们自己就是）拉起来的 WorkBuddy 首窗
// 常常是**最小化**状态（HWND 落在 -32000 那一带），看着像「压根没打开」⇒ 先 SW_RESTORE 再置前，没建好就重试。
function focusWorkBuddy(attempts = 10) {
  const target = exePath();
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const script = [
    `$t = ${q(target)}`,
    `Add-Type -Namespace FB -Name Win -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int n); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);'`,
    `for ($i = 0; $i -lt ${Number(attempts)}; $i++) {`,
    `  $proc = Get-CimInstance Win32_Process -Filter "Name=${q(path.basename(target))}" -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -ieq $t } | Select-Object -First 1`,
    `  if ($proc) {`,
    `    $p = Get-Process -Id $proc.ProcessId -ErrorAction SilentlyContinue`,
    `    if ($p -and $p.MainWindowHandle -ne 0) {`,
    `      if ([FB.Win]::IsIconic($p.MainWindowHandle)) { [void][FB.Win]::ShowWindowAsync($p.MainWindowHandle, 9) }`,
    `      [void][FB.Win]::SetForegroundWindow($p.MainWindowHandle)`,
    `      try { (New-Object -ComObject WScript.Shell).AppActivate($p.Id) | Out-Null } catch {}`,
    `      'restored'`,
    `      exit`,
    `    }`,
    `  }`,
    `  Start-Sleep -Milliseconds 900`,
    `}`,
    `'not-ready'`,
  ].join('\n');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', windowsHide: true });
  return String(r.stdout || '').trim();
}

// ── 开机自启（注册表 Run 值，名字与安装包里的宏一致） ────────────────────
// 自启走 --tray：托盘常驻 + 守护进程，**不主动接管 WorkBuddy**（不然每次开机都把它顶到前面）。
// 默认不开自启，跟 WorkDaddy 一样——要用的时候点图标就行。
function autostartOn() {
  const r = spawnSync('reg.exe', ['QUERY', `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run`, '/v', RUN_KEY], { encoding: 'utf8', windowsHide: true });
  return /--tray|--hidden/.test(String(r.stdout || ''));
}
function setAutostart(on) {
  if (on) {
    spawnSync('reg.exe', ['ADD', `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run`, '/v', RUN_KEY, '/t', 'REG_SZ', '/d', `"${process.execPath}" --tray`, '/f'], { windowsHide: true });
  } else {
    spawnSync('reg.exe', ['DELETE', `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run`, '/v', RUN_KEY, '/f'], { windowsHide: true });
  }
  return autostartOn();
}

// ── 状态 ────────────────────────────────────────────────────────────────
async function getStatus() {
  const p = await ping();
  let status = null;
  if (p) { try { status = await api('/api/status', { timeoutMs: 5000 }); } catch {} }
  return {
    app: { version: app.getVersion(), electron: process.versions.electron, node: process.versions.node },
    profile: { id: profile().id, name: profile().name, apiPort: profile().apiPort, cdpPort: profile().cdpPort },
    profiles: Object.values(PROFILES).map((x) => ({ id: x.id, name: x.name })),
    daemon: p ? { ...p, ...(status || {}) } : null,
    dataDir: DATA_DIR,
    daemonLog: DAEMON_LOG,
    workBuddyExe: exePath(),
    workBuddyExeExists: fs.existsSync(exePath()),
    autostart: autostartOn(),
    closeToTray: !!settings.closeToTray,
    busy: job ? job.name : null,
  };
}

// ── 窗口 / 托盘 ─────────────────────────────────────────────────────────
let win = null;
let tray = null;
let quitting = false;

function createWindow() {
  win = new BrowserWindow({
    width: 1000,
    height: 660,
    minWidth: 860,
    minHeight: 560,
    show: false,
    backgroundColor: '#f5f6f8',
    title: 'FreeBuddy 控制台',
    icon: fs.existsSync(ICON_PNG) ? ICON_PNG : undefined,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => { if (SHOW_WINDOW_AT_START) showWindow(); });
  win.on('close', (e) => {
    if (!quitting && settings.closeToTray) { e.preventDefault(); win.hide(); }
  });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  win.show();
  win.focus();
}

function trayImage() {
  try { return fs.existsSync(TRAY_PNG) ? nativeImage.createFromPath(TRAY_PNG) : nativeImage.createFromPath(ICON_PNG); } catch { return nativeImage.createEmpty(); }
}

function buildTray() {
  tray = new Tray(trayImage());
  tray.setToolTip('FreeBuddy · WorkBuddy 增强面板');
  const menu = Menu.buildFromTemplate([
    { label: '显示控制台', click: () => showWindow() },
    { type: 'separator' },
    { label: '启动并注入', click: async () => { showWindow(); await doLaunch(); } },
    { label: '打开面板', click: async () => { await doOpenPanel(); } },
    { label: '停止 FreeBuddy', click: async () => { await runScript(path.join('src', 'stop.mjs'), '停止'); } },
    { type: 'separator' },
    { label: '打开数据目录', click: () => shell.openPath(DATA_DIR) },
    { type: 'separator' },
    { label: '退出 FreeBuddy 控制台', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('double-click', () => showWindow());
}

async function doLaunch() {
  await ensureDaemon();
  const r = await runScript(path.join('src', 'launcher.mjs'), '启动并注入');
  focusWorkBuddy();
  return r;
}
async function doOpenPanel() {
  if (!(await ensureDaemon())) return { ok: false, error: '守护进程没起来' };
  const r = await api('/api/panel/open', { method: 'POST', body: '{}', timeoutMs: 20000 });
  focusWorkBuddy();
  if (r && r.ok) logLine('面板已在 WorkBuddy 窗口里展开');
  else logLine(`打开面板失败：${(r && (r.error || r.result)) || '未知原因'}`);
  return r;
}

// ── IPC ─────────────────────────────────────────────────────────────────
function wireIpc() {
  ipcMain.handle('fb:status', () => getStatus());
  ipcMain.handle('fb:launch', () => doLaunch());
  ipcMain.handle('fb:stop', () => runScript(path.join('src', 'stop.mjs'), '停止'));
  ipcMain.handle('fb:open-panel', () => doOpenPanel());
  ipcMain.handle('fb:open-dir', () => { shell.openPath(DATA_DIR); return true; });
  ipcMain.handle('fb:open-log', () => { fs.mkdirSync(path.dirname(DAEMON_LOG), { recursive: true }); shell.openPath(DAEMON_LOG); return true; });
  ipcMain.handle('fb:log-tail', () => {
    let daemon = [];
    try { daemon = fs.readFileSync(DAEMON_LOG, 'utf8').split('\n').slice(-160); } catch {}
    return { session: sessionLog, daemon };
  });
  ipcMain.handle('fb:clear-log', () => { sessionLog.length = 0; return true; });
  ipcMain.handle('fb:set-autostart', (_e, on) => { const v = setAutostart(!!on); logLine(`开机自启已${v ? '开启' : '关闭'}`); return v; });
  ipcMain.handle('fb:set-profile', async (_e, id) => {
    if (!PROFILES[id] || id === settings.profile) return profile().id;
    const wasUp = !!(await ping());
    settings.profile = id; saveSettings();
    logLine(`已切换到 ${PROFILES[id].name}`);
    if (wasUp) { await runScript(path.join('src', 'stop.mjs'), '停止旧档案'); await sleep(500); }
    await ensureDaemon();
    return profile().id;
  });
  ipcMain.handle('fb:set-close-to-tray', (_e, on) => { settings.closeToTray = !!on; saveSettings(); return settings.closeToTray; });
  ipcMain.handle('fb:relaunch', (_e, hidden) => { quitting = true; app.relaunch({ args: hidden ? ['--hidden'] : [] }); app.quit(); });
  ipcMain.handle('fb:quit', () => { quitting = true; app.quit(); });
}

// ── 启动 ────────────────────────────────────────────────────────────────
// 三种模式：
//   （无参数）   进去模式 —— **不显示任何自己的窗口**：把 WorkBuddy 接管好、面板注入进去、
//                把 WorkBuddy 顶到前台，然后自己退出。桌面/开始菜单图标就是这个。
//   --console    控制台窗口（+ 托盘），用来手动启停、看日志、调设置。
//   --tray       只常驻托盘 + 守护进程，不接管（开机自启项用这个；--hidden 是它的旧名）。
const MODE = process.argv.includes('--console')
  ? 'console'
  : process.argv.includes('--tray') || process.argv.includes('--hidden')
    ? 'tray'
    : 'launch';
const SHOW_WINDOW_AT_START = MODE === 'console';

// 验收用：FB_DESKTOP_CDP=<port> 时给本窗口开一个调试端口，方便截图核对界面。
// 9333 在守护进程扫描的 9222–9232 之外，不会跟 WorkBuddy 的通道混淆。
if (process.env.FB_DESKTOP_CDP) app.commandLine.appendSwitch('remote-debugging-port', String(process.env.FB_DESKTOP_CDP));

if (!app.requestSingleInstanceLock()) {
  // 已经有实例在跑：让它去干活（进去模式＝再接管一次并前置；控制台模式＝把窗口叫出来）
  app.quit();
} else {
  app.on('second-instance', () => {
    if (MODE === 'console') showWindow();
    else doLaunch().catch(() => {});
  });
  app.whenReady().then(async () => {
    wireIpc();
    Menu.setApplicationMenu(null);

    if (MODE === 'launch') {
      // 干完就退（守护进程是 detached 的，会留在后台）
      const r = await doLaunch();
      if (!r.ok) {
        // 出问题了才把控制台亮出来，让他看得见原因
        quitting = false;
        createWindow();
        buildTray();
        showWindow();
        return;
      }
      quitting = true;
      app.quit();
      return;
    }

    createWindow();
    buildTray();
    logLine(`FreeBuddy 控制台 v${app.getVersion()} 启动（${MODE}）`);
    ensureDaemon().catch(() => {});
  });
  app.on('window-all-closed', () => { /* 托盘常驻，不随窗口退出 */ });
  app.on('before-quit', () => { quitting = true; });
}
