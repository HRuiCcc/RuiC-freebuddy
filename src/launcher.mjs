// FreeBuddy 启动器（Windows）：
//   1. 连上（必要时重启成）带调试端口的 WorkBuddy
//   2. 拉起本地守护进程
//   3. 让守护进程把面板注入进去
// 进程匹配一律用「可执行文件绝对路径 + PID」，绝不按映像名批杀。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BRAND, VERSION, HOST, profile, dataDir, ensureDirs, exePath } from './config.mjs';
import * as wbproc from './platform/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PROFILE = profile();

function out(msg) {
  console.log(msg);
}

async function daemonPing() {
  try {
    const r = await fetch(`http://${HOST}:${PROFILE.apiPort}/api/ping`, { signal: AbortSignal.timeout(1200) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

async function ensureDaemon() {
  const ping = await daemonPing();
  if (ping && ping.brand === BRAND) {
    out('守护进程已在运行');
    return true;
  }
  out('启动守护进程…');
  const child = spawn(process.execPath, [path.join(here, 'daemon.mjs')], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, FB_PROFILE: PROFILE.id },
  });
  child.unref();
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 700));
    const p = await daemonPing();
    if (p && p.brand === BRAND) return true;
  }
  return false;
}

function token() {
  try {
    return fs.readFileSync(path.join(dataDir(), '.api-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

async function inject(attempts = 6) {
  const t = token();
  let lastError = '未知错误';
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`http://${HOST}:${PROFILE.apiPort}/api/inject`, {
        method: 'POST',
        headers: { 'X-FreeBuddy-Token': t, 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(8000),
      });
      const data = await res.json();
      if (data.ok && data.mounted) return { ok: true };
      lastError = data.error || (data.ok ? '面板还没挂上' : '注入被拒绝');
      if (res.status === 401 || res.status === 404) return { ok: false, error: lastError };
    } catch (e) {
      lastError = e.message;
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  return { ok: false, error: lastError, pending: true };
}

async function main() {
  out(`${BRAND} v${VERSION} · ${PROFILE.name}`);
  ensureDirs();
  const exe = exePath();
  if (!fs.existsSync(exe) && !process.env.FB_WORKBUDDY_EXE) {
    out(`找不到 WorkBuddy 主程序：${exe}`);
    out('请先安装对应客户端，或用 FB_WORKBUDDY_EXE 指定它的 .exe。');
    process.exit(2);
  }
  out(`客户端：${exe}`);

  let ready = await wbproc.targetReady(PROFILE.cdpPort);
  if (ready) {
    out(`调试端口 ${PROFILE.cdpPort} 已可用，直接接管`);
  } else {
    const running = wbproc.findRunning();
    if (running.length) {
      out(`WorkBuddy 在运行但没开调试端口，按精确路径重启它（${running.length} 个进程）`);
      await wbproc.stopExact(running.map((p) => p.pid), out);
    }
    out(`以调试端口 ${PROFILE.cdpPort} 启动 WorkBuddy…`);
    wbproc.launchWithCdp(PROFILE.cdpPort);
    out('等待调试端口就绪（最多 60 秒）…');
    ready = await wbproc.waitTarget(PROFILE.cdpPort, 60000);
    if (!ready) {
      out('调试端口没起来。可能是单实例逻辑接管了这次启动：请完全退出 WorkBuddy 后再运行一次 FreeBuddy。');
      process.exit(3);
    }
  }

  if (!(await ensureDaemon())) {
    out(`守护进程没能启动，请看 ${path.join(dataDir(), 'logs', 'daemon.log')}`);
    process.exit(4);
  }

  const r = await inject();
  if (r.ok) out('面板已注入 —— 看 WorkBuddy 窗口右下角。');
  else out(`暂时没能挂上（${r.error}）。守护进程会在页面就绪后自动补种，不用重跑。`);
  // 把 WorkBuddy 顶到前台，让人一眼看到面板（mac：open -a；Windows：还原最小化首窗并置前）
  try {
    out(`前台化：${wbproc.focusApp()}`);
  } catch {
    /* 前台化失败不影响面板已经挂上这件事 */
  }
  process.exit(0);
}

main().catch((e) => {
  out('启动失败：' + (e && e.message));
  process.exit(1);
});
