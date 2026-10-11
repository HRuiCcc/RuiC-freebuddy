// 休眠策略：用一个常驻 PowerShell 子进程持有 SetThreadExecutionState 唤醒锁。
// 释放 = 结束子进程 + 删标志文件，不改系统电源计划，可随时反悔。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './config.mjs';

const ES_CONTINUOUS = 2147483648;
const ES_SYSTEM_REQUIRED = 1;
const ES_DISPLAY_REQUIRED = 2;

let child = null;
let current = { mode: 'allow', displaySleep: true };

function flagFile() {
  return path.join(dataDir(), 'keep-awake.flag');
}

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
  try {
    if (fs.existsSync(flagFile())) fs.unlinkSync(flagFile());
  } catch {
    /* 忽略 */
  }
}

function scriptFor(flag, flags) {
  const flagLiteral = flag.replace(/\\/g, '\\\\').replace(/'/g, "''");
  return [
    "$ErrorActionPreference='SilentlyContinue'",
    "Add-Type -Namespace FreeBuddy -Name Power -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);'",
    `$flag = '${flagLiteral}'`,
    `while (Test-Path -LiteralPath $flag) { [FreeBuddy.Power]::SetThreadExecutionState(${flags}) | Out-Null; Start-Sleep -Milliseconds 4000 }`,
    `[FreeBuddy.Power]::SetThreadExecutionState(${ES_CONTINUOUS}) | Out-Null`,
  ].join('; ');
}

export function setMode(mode, displaySleep) {
  if (!['allow', 'keep', 'until-done'].includes(mode)) throw new Error('未知的休眠模式');
  current = { mode, displaySleep: displaySleep !== false };
  releaseHold();
  if (mode === 'allow') return getMode();
  const flags = ES_CONTINUOUS | ES_SYSTEM_REQUIRED | (current.displaySleep ? ES_DISPLAY_REQUIRED : 0);
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(flagFile(), mode);
  child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', scriptFor(flagFile(), flags)], {
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('exit', () => {
    child = null;
  });
  return getMode();
}

export function setDisplaySleep(enabled) {
  current.displaySleep = !!enabled;
  // 正在持锁时按新参数重挂
  if (isHolding()) return setMode(current.mode, enabled);
  return getMode();
}
