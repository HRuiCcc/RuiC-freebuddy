// FreeBuddy —— Windows 平台实现。
//
// 这一层是**薄适配器**：进程/电源的主体逻辑仍留在 src/wbproc.mjs 与 src/power.mjs 里，
// 这里只是把它们的导出按 platform 统一接口重新摆一遍，顺带补上原先内联在
// daemon.mjs / stop.mjs 里的几个 Windows 动作（打开目录、按端口找 PID、结束 PID）。
// ⇒ Windows 行为 = 移植前逐字不变，一个字都没重写。
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { exePath } from '../config.mjs';

export {
  findRunning,
  cdpListening,
  targetReady,
  waitTarget,
  stopExact,
  cleanChildEnv,
  launchWithCdp,
  openInBrowser,
} from '../wbproc.mjs';

import * as powerImpl from '../power.mjs';
export const power = powerImpl;

/* ───────── 打开路径（原 daemon.mjs 内联） ───────── */

export function openPath(p) {
  spawn('explorer.exe', [p], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
  return true;
}

/* ───────── 前台化 ───────── */

// 只 AppActivate 不够：WorkBuddy 首窗常常是**最小化**状态（HWND 落在 -32000 那一带），
// 看着像「压根没打开」⇒ 先 SW_RESTORE 再置前，没建好就重试。
export function focusApp(attempts = 10) {
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

/* ───────── 按端口找 PID / 结束 PID（原 stop.mjs 内联） ───────── */

export function pidsOnPort(port) {
  const r = spawnSync('powershell.exe', [
    '-NoProfile',
    '-Command',
    `(Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique) -join ','`,
  ], { encoding: 'utf8', windowsHide: true });
  return String(r.stdout || '')
    .trim()
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

export function killPids(pids) {
  const done = [];
  for (const pid of pids) {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', `Stop-Process -Id ${Number(pid)} -Force`], {
      encoding: 'utf8',
      windowsHide: true,
    });
    done.push({ pid: Number(pid), ok: r.status === 0 });
  }
  return done;
}

export const platform = 'win32';
