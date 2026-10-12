// 停止 FreeBuddy：从当前页面移除面板 → 释放唤醒锁 → 结束守护进程。
// 只结束我们自己的守护进程（按端口反查 PID），不碰 WorkBuddy 与其它 node 进程。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND, HOST, profile, dataDir } from './config.mjs';
import { attach } from './cdplink.mjs';
import { destroyWidget } from './injector.mjs';
import * as wbproc from './platform/index.mjs';
import { power } from './platform/index.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PROFILE = profile();

function token() {
  try {
    return fs.readFileSync(path.join(dataDir(), '.api-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

async function daemonPing(port) {
  try {
    const r = await fetch(`http://${HOST}:${port}/api/ping`, { signal: AbortSignal.timeout(1000) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

// 按监听端口反查 PID（避免按进程名批杀）
async function main() {
  console.log(`${BRAND} 停止中…`);

  // 1) 先从页面摘掉面板
  const attached = await attach(PROFILE.cdpPort);
  if (attached) {
    await destroyWidget(attached.session);
    console.log('  已从 WorkBuddy 页面移除面板');
    attached.session.close();
  } else {
    console.log('  调试通道没连上，跳过移除面板');
  }

  // 2) 释放唤醒锁
  try {
    power.setMode('allow', true);
    console.log('  已释放休眠唤醒锁');
  } catch {
    /* 忽略 */
  }

  // 3) 结束守护进程
  const ping = await daemonPing(PROFILE.apiPort);
  if (!ping) {
    console.log('  守护进程没在运行');
    return;
  }
  const tok = token();
  try {
    await fetch(`http://${HOST}:${PROFILE.apiPort}/api/ping`, { headers: { 'X-FreeBuddy-Token': tok } });
  } catch {
    /* 忽略 */
  }
  const pids = wbproc.pidsOnPort(PROFILE.apiPort);
  if (!pids.length) {
    console.log('  没找到监听端口的进程');
    return;
  }
  for (const r of await wbproc.killPids(pids)) {
    console.log(r.ok ? `  已结束守护进程 ${r.pid}` : `  结束 ${r.pid} 失败`);
  }
}

main().catch((e) => {
  console.log('停止失败：' + (e && e.message));
  process.exit(1);
});
