// 取数凭据缓存：官方新版客户端会把登录会话在磁盘上做静态加密，
// 一旦备份被覆盖成加密版，我们就再也读不出明文 token 了（那条账号的积分/签到就没法直连查）。
// 所以在还能读到明文 token 的时候把它另存一份，切换账号/重写备份都不会丢。
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './config.mjs';

const MARGIN_MS = 86_400_000; // 距过期不足一天就不再用了

function file() {
  return path.join(dataDir(), 'credential-cache.json');
}

function readAll() {
  try {
    const j = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

function writeAll(map) {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    const tmp = `${file()}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(map, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, file());
  } catch {
    /* 写失败不影响主流程 */
  }
}

export function save(uid, entry) {
  if (!uid || !entry || !entry.token) return;
  const all = readAll();
  all[uid] = {
    token: entry.token,
    refreshToken: entry.refreshToken || (all[uid] && all[uid].refreshToken) || null,
    expiresAt: entry.expiresAt || null,
    savedAt: Date.now(),
  };
  writeAll(all);
}

export function get(uid) {
  const e = readAll()[uid];
  if (!e || !e.token) return null;
  if (e.expiresAt && e.expiresAt - Date.now() < MARGIN_MS) return null;
  return e;
}

export function drop(uid) {
  const all = readAll();
  if (all[uid]) {
    delete all[uid];
    writeAll(all);
  }
}

export function list() {
  return Object.keys(readAll());
}
