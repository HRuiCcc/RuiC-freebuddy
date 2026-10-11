// 每个账号最近一次成功取到的官方数据快照。
// 用途：账号一旦不是「当前登录」，且它的备份是加密的，我们就没法直连查它的积分；
// 这时显示上次成功同步的结果（并标注时间），而不是一片空白。
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './config.mjs';

function file() {
  return path.join(dataDir(), 'account-data-cache.json');
}

function readAll() {
  try {
    const j = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

let dirty = false;
let timer = null;

function flush() {
  dirty = false;
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    const tmp = `${file()}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(readAll(), null, 0), { mode: 0o600 });
    fs.renameSync(tmp, file());
  } catch {
    /* 忽略 */
  }
}

export function save(uid, snapshot) {
  if (!uid) return;
  const all = readAll();
  all[uid] = { ...snapshot, at: Date.now() };
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    const tmp = `${file()}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 0), { mode: 0o600 });
    fs.renameSync(tmp, file());
  } catch {
    /* 忽略 */
  }
}

export function get(uid) {
  const e = readAll()[uid];
  if (!e) return null;
  return e;
}
