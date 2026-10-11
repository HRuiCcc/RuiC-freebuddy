// 签到状态缓存：签到接口是唯一的权威来源（返回 10001 表示当天已签到），
// 但它是个 POST（会真的执行签到）。所以按「账号 + 日期」缓存结果，每天每个账号最多问一次。
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './config.mjs';

function file() {
  return path.join(dataDir(), 'checkin-cache.json');
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function readAll() {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8')) || {};
  } catch {
    return {};
  }
}

function writeAll(map) {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    const tmp = `${file()}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file());
  } catch {
    /* 写失败不影响主流程 */
  }
}

// 今天的签到结论；没问过返回 null
export function getToday(uid) {
  const all = readAll();
  const e = all[uid];
  if (!e || e.date !== today()) return null;
  return e;
}

export function put(uid, result) {
  const all = readAll();
  all[uid] = {
    date: today(),
    ok: !!result.ok,
    already: !!result.already,
    code: result.code ?? null,
    message: result.message || '',
    at: Date.now(),
  };
  writeAll(all);
  return all[uid];
}

export function clear(uid) {
  const all = readAll();
  if (uid) delete all[uid];
  else for (const k of Object.keys(all)) delete all[k];
  writeAll(all);
}

// 把签到结论归一成「今日是否已完成签到」
export function isDoneToday(entry) {
  if (!entry || entry.date !== today()) return null;
  if (entry.already) return true;
  if (entry.ok) return true;
  return false;
}
