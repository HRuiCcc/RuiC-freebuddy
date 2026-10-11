// WorkBuddy 进程控制（Windows）。所有判定都基于「可执行文件绝对路径 + PID」，
// 绝不按映像名批杀 —— 同名进程可能有多个（国内版 / 国际版 / 其他用户）。
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { exePath, profile } from './config.mjs';
import { probePort, listTargets, pickPageTarget } from './cdplink.mjs';

function ps(script) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return { code: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

function q(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

// 返回与目标 exe 绝对路径完全一致、且属于当前用户的进程
export function findRunning(target = exePath()) {
  const script = [
    `$name = ${q(path.basename(target))}`,
    `$target = ${q(target)}`,
    `$me = (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).Identity.Name`,
    `$out = @()`,
    `try { $ps = Get-CimInstance Win32_Process -Filter "Name='$name'" -ErrorAction Stop } catch { $ps = @() }`,
    `foreach ($p in $ps) {`,
    `  $pth = $null; try { $pth = $p.ExecutablePath } catch {}`,
    `  $own = $null; try { $o = Invoke-CimMethod -InputObject $p -MethodName GetOwner; $own = $o.Domain + '\\' + $o.User } catch {}`,
    `  if ($pth -and ($pth -ieq $target)) { $out += [pscustomobject]@{ pid=$p.ProcessId; path=$pth; owner=$own } }`,
    `}`,
    `if ($out.Count -gt 0) { $out | ConvertTo-Json -Compress } else { '[]' }`,
  ].join('\n');
  const r = ps(script);
  if (!r.stdout) return [];
  try {
    const parsed = JSON.parse(r.stdout);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
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

// 优雅退出优先（taskkill 不带 /F 等价于发关闭消息），超时再强制，始终只针对具体 PID
export async function stopExact(pids, log = () => {}) {
  for (const pid of pids) {
    log(`结束进程 ${pid}`);
    ps(`taskkill /PID ${Number(pid)} 2>$null | Out-Null`);
  }
  await new Promise((r) => setTimeout(r, 3000));
  const still = findRunning().map((p) => p.pid);
  for (const pid of still) {
    log(`仍存活，强制结束 ${pid}`);
    ps(`taskkill /F /PID ${Number(pid)} 2>$null | Out-Null`);
  }
  await new Promise((r) => setTimeout(r, 800));
  return findRunning().length === 0;
}

// 守护进程可能由「Electron 当 Node 跑」的宿主（桌面版 FreeBuddy.exe）拉起，
// 那种环境里带 ELECTRON_RUN_AS_NODE=1 —— 一旦透传给 WorkBuddy.exe，它会以 Node 模式
// 启动并立刻退出。拉起真实客户端前必须把这几个 Electron 变量摘掉。
export function cleanChildEnv(env = process.env) {
  const out = { ...env };
  delete out.ELECTRON_RUN_AS_NODE;
  delete out.ELECTRON_NO_ATTACH_CONSOLE;
  delete out.ELECTRON_FORCE_IS_PACKAGED;
  return out;
}

export function launchWithCdp(port = profile().cdpPort, target = exePath()) {
  const child = spawn(target, [`--remote-debugging-port=${port}`], {
    detached: true,
    stdio: 'ignore',
    env: cleanChildEnv(),
  });
  child.unref();
  return true;
}

export function openInBrowser(url) {
  if (!/^https?:\/\//i.test(url)) throw new Error('只允许打开 http(s) 链接');
  spawn('rundll32', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', env: cleanChildEnv() }).unref();
  return true;
}
