// 端到端验证「假退出」：重启 → 确认调试端口回来 → 恢复登录态 → 重新注入面板
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { HOST, profile, dataDir } from '../src/config.mjs';
import * as store from '../src/authstore.mjs';
import * as wbproc from '../src/wbproc.mjs';

const PROFILE = profile();
const UID = '02a57cc2-db63-4c56-b875-ec49e18b5df1';
const token = fs.readFileSync(path.join(dataDir(), '.api-token'), 'utf8').trim();

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function restartDaemon() {
  const r = spawnSync('powershell.exe', [
    '-NoProfile',
    '-Command',
    `(Get-NetTCPConnection -LocalPort ${PROFILE.apiPort} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique) -join ','`,
  ], { encoding: 'utf8', windowsHide: true });
  for (const pid of String(r.stdout || '').trim().split(',').map((x) => Number(x.trim())).filter(Boolean)) {
    spawnSync('powershell.exe', ['-NoProfile', '-Command', `Stop-Process -Id ${pid} -Force`], { windowsHide: true });
  }
}

console.log('1) 重启守护进程以加载新代码');
restartDaemon();
await wait(2000);
const child = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true });
void child;
const { spawn } = await import('node:child_process');
const d = spawn(process.execPath, ['src/daemon.mjs'], { detached: true, stdio: 'ignore', windowsHide: true });
d.unref();
for (let i = 0; i < 20; i++) {
  await wait(700);
  try {
    const r = await fetch(`http://${HOST}:${PROFILE.apiPort}/api/ping`, { signal: AbortSignal.timeout(1000) });
    if (r.ok) break;
  } catch {
    /* 等它起来 */
  }
}
console.log('   守护进程就绪');

console.log('2) 调 /api/login/fake');
const t0 = Date.now();
let result = null;
try {
  const res = await fetch(`http://${HOST}:${PROFILE.apiPort}/api/login/fake`, {
    method: 'POST',
    headers: { 'X-FreeBuddy-Token': token, 'Content-Type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(180000),
  });
  result = await res.json();
} catch (e) {
  result = { ok: false, error: e.message };
}
console.log('   结果:', JSON.stringify(result), `耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

console.log('3) 独立复核 WorkBuddy 是否真的回来了（不信任接口自述）');
const procs = wbproc.findRunning();
const ready = await wbproc.targetReady(PROFILE.cdpPort);
console.log(`   进程数 ${procs.length} | 调试端口可用 ${ready}`);

console.log('4) 恢复登录态并刷新页面');
try {
  store.switchTo(UID);
  console.log('   已写回账号备份');
} catch (e) {
  console.log('   写回失败:', e.message);
}
await wait(1000);
try {
  const res = await fetch(`http://${HOST}:${PROFILE.apiPort}/api/inject`, {
    method: 'POST',
    headers: { 'X-FreeBuddy-Token': token },
  });
  console.log('   注入:', (await res.text()).slice(0, 60));
} catch (e) {
  console.log('   注入失败:', e.message);
}
