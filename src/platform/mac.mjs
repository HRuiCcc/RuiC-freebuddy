// FreeBuddy —— macOS 平台实现。
//
// 只依赖系统自带命令（ps / kill / open / lsof / caffeinate），零 npm 依赖。
// 接口与 win.mjs 一一对应，语义对齐：
//   findRunning / stopExact / killPids / launchWithCdp / waitTarget / cleanChildEnv
//   openInBrowser / openPath / focusApp / pidsOnPort
//   power.{getMode,isHolding,setMode,setDisplaySleep}
//
// 关键约定与 Windows 侧一致：一切判定基于「可执行文件绝对路径 + PID」，
// 绝不按进程名批杀 —— mac 上 Electron 会派生一堆 * Helper 进程，按名批杀会连渲染进程一起打死。
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { exePath, appBundle, profile } from '../config.mjs';
import { probePort, listTargets, pickPageTarget } from '../cdplink.mjs';

/* ───────── 进程控制 ───────── */

// mac 上 `ps -o comm=` 对 GUI 程序给的是完整可执行路径；
// Helper 进程的路径里带 " Helper.app"，精确全等匹配天然只命中主进程。
export function findRunning(target = exePath()) {
  if (!target) return [];
  const r = spawnSync('ps', ['-Ao', 'pid=,comm='], { encoding: 'utf8' });
  const want = path.resolve(target);
  const base = path.basename(target);
  const out = [];
  for (const line of String(r.stdout || '').split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const comm = m[2].trim();
    const isHelper = / Helper( \(|$)/.test(comm) || /\.app\/Contents\/Frameworks\//.test(comm);
    // 首选：comm 就是完整路径且与目标全等；退路：只给了短名，且不是 Helper 进程
    const hit = comm === want || (comm === base && !isHelper);
    if (hit) out.push({ pid, path: comm === want ? comm : target });
  }
  return out;
}

export function cdpListening(port) {
  return probePort(port);
}

export async function targetReady(port) {
  if (!(await probePort(port))) return false;
  try {
    return !!pickPageTarget(await listTargets(port));
  } catch {
    return false;
  }
}

export async function waitTarget(port, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await targetReady(port)) return true;
    await new Promise((r) => setTimeout(r, 1200));
  }
  return false;
}

// 先 SIGTERM（等价 Windows 不带 /F 的 taskkill），超时再 SIGKILL；始终只针对具体 PID
export async function stopExact(pids, log = () => {}) {
  for (const pid of pids) {
    log(`结束进程 ${pid}`);
    try {
      process.kill(Number(pid), 'SIGTERM');
    } catch {
      /* 已不存在 */
    }
  }
  await new Promise((r) => setTimeout(r, 3000));
  for (const p of findRunning()) {
    log(`仍存活，强制结束 ${p.pid}`);
    try {
      process.kill(Number(p.pid), 'SIGKILL');
    } catch {
      /* 已不存在 */
    }
  }
  await new Promise((r) => setTimeout(r, 800));
  return findRunning().length === 0;
}

// 结束任意 PID（stop.mjs 用它收掉守护进程）：先给一次优雅退出的机会，再补刀。
export async function killPids(pids) {
  const done = [];
  for (const pid of pids) {
    const n = Number(pid);
    try {
      process.kill(n, 'SIGTERM');
      done.push({ pid: n, ok: true });
    } catch {
      done.push({ pid: n, ok: false });
    }
  }
  await new Promise((r) => setTimeout(r, 1500));
  for (const d of done) {
    try {
      process.kill(d.pid, 'SIGKILL');
    } catch {
      /* 已退出 */
    }
  }
  return done;
}

// 与 Windows 侧同一坑：守护进程可能由「Electron 当 Node 跑」的宿主拉起，
// 那种环境带 ELECTRON_RUN_AS_NODE=1；透传给 WorkBuddy 会让它以 Node 模式启动并立刻退出。
export function cleanChildEnv(env = process.env) {
  const out = { ...env };
  delete out.ELECTRON_RUN_AS_NODE;
  delete out.ELECTRON_NO_ATTACH_CONSOLE;
  delete out.ELECTRON_FORCE_IS_PACKAGED;
  return out;
}

// 用 open -a 拉起：走 LaunchServices，mac 上比直接 spawn 二进制更稳。
// 注意：对已在运行的 app，open 只做激活、不会追加参数 ⇒ 调用前必须先 stopExact（现有流程即如此）。
export function launchWithCdp(port = profile().cdpPort) {
  const bundle = appBundle() || profile().appDir;
  const child = spawn('open', ['-a', bundle, '--args', `--remote-debugging-port=${port}`], {
    detached: true,
    stdio: 'ignore',
    env: cleanChildEnv(),
  });
  child.unref();
  return true;
}

export function openInBrowser(url) {
  if (!/^https?:\/\//i.test(url)) throw new Error('只允许打开 http(s) 链接');
  spawn('open', [url], { detached: true, stdio: 'ignore', env: cleanChildEnv() }).unref();
  return true;
}

export function openPath(p) {
  spawn('open', [p], { detached: true, stdio: 'ignore', env: cleanChildEnv() }).unref();
  return true;
}

// 等价 Windows 侧的 WScript.AppActivate：把 WorkBuddy 提到前台
export function focusApp() {
  const bundle = appBundle() || profile().appDir;
  const r = spawnSync('open', ['-a', bundle], { encoding: 'utf8' });
  return r.status === 0 ? 'activated' : 'err:' + String(r.stderr || '').trim();
}

export function pidsOnPort(port) {
  const r = spawnSync('lsof', ['-nP', `-iTCP:${Number(port)}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
  return String(r.stdout || '')
    .split('\n')
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

/* ───────── 电源（休眠策略） ───────── */

// caffeinate 就是 mac 上的 SetThreadExecutionState。
//  -i 禁止空闲休眠 · -s 禁止系统休眠（仅接电时生效） · -d 禁止息屏
//  -w <pid>：守护进程一退 caffeinate 自己退，不会留下"锁没放"的孤儿。
// 已知边界：合盖休眠（clamshell）caffeinate 挡不住，这是 mac 自身规则，不修。
let child = null;
let current = { mode: 'allow', displaySleep: true };

export function isHolding() {
  return !!child && child.exitCode === null && !child.killed;
}

export function getMode() {
  return { ...current, holding: isHolding() };
}

function releaseHold() {
  try {
    if (child && child.exitCode === null) child.kill();
  } catch {
    /* 已退出 */
  }
  child = null;
}

export function setMode(mode, displaySleep) {
  if (!['allow', 'keep', 'until-done'].includes(mode)) throw new Error('未知的休眠模式');
  current = { mode, displaySleep: displaySleep !== false };
  releaseHold();
  if (mode === 'allow') return getMode();
  const args = ['-i', '-s'];
  if (current.displaySleep) args.push('-d');
  args.push('-w', String(process.pid)); // 守护进程退出即自动释放
  child = spawn('caffeinate', args, { stdio: 'ignore' });
  child.on('exit', () => {
    child = null;
  });
  return getMode();
}

export function setDisplaySleep(enabled) {
  current.displaySleep = !!enabled;
  if (isHolding()) return setMode(current.mode, enabled);
  return getMode();
}

export const power = { isHolding, getMode, setMode, setDisplaySleep };

export const platform = 'darwin';
