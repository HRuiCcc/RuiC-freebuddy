// WorkBuddy 本机数据库（workbuddy.db）的读写封装。
//
// 为什么直连数据库：会话分支/迁移要在 sessions 表里插一行，自动化任务要读写
// automations 表 —— 这些本来就没有别的入口，官方客户端自己也是这么落库的。
//
// 原则：
//   · 读用只读连接；写用独立连接 + BEGIN IMMEDIATE + busy_timeout，避免和客户端抢锁。
//   · 每次都开/关连接（与上游一致），靠 WAL 保证并发安全，不长期持有句柄。
//   · SQL 只由本仓库内部写死并参数化，绝不拼接外部字符串。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { profile, workBuddyDb } from './config.mjs';

const require = createRequire(import.meta.url);

let sqlite = null;
let loadError = null;

// node:sqlite 目前会打一条 ExperimentalWarning。它只是噪音，
// 而且会经 CDP 注入的日志混进面板控制台，所以加载这一刻临时静音。
export function available() {
  if (sqlite) return true;
  if (loadError) return false;
  try {
    const original = process.emitWarning;
    process.emitWarning = () => {};
    try {
      sqlite = require('node:sqlite');
    } finally {
      process.emitWarning = original;
    }
  } catch (e) {
    loadError = e.message;
    return false;
  }
  return !!(sqlite && typeof sqlite.DatabaseSync === 'function');
}

export function status() {
  const ok = available();
  return {
    ok,
    backend: 'node:sqlite',
    dbPath: workBuddyDb(),
    exists: fs.existsSync(workBuddyDb()),
    error: ok ? null : loadError || 'node:sqlite 不可用（需要 Node ≥ 22.5）',
  };
}

export function file() {
  return workBuddyDb();
}

export function hasDb() {
  return fs.existsSync(workBuddyDb());
}

function open(readOnly) {
  if (!available()) {
    throw new Error('当前 Node 不支持 node:sqlite（需要 ≥ 22.5）：' + (loadError || '未知原因'));
  }
  const f = workBuddyDb();
  if (!fs.existsSync(f)) throw new Error('找不到 WorkBuddy 数据库：' + f);
  const db = new sqlite.DatabaseSync(f, readOnly ? { readOnly: true } : {});
  // 客户端随时在写；给一点等待锁的时间，别立刻 SQLITE_BUSY
  try {
    db.exec('PRAGMA busy_timeout = 4000');
  } catch {
    /* 老版本不支持就算了 */
  }
  return db;
}

function rows(result) {
  return (result || []).map((r) => Object.fromEntries(Object.entries(r)));
}

// 只读查询（多条）
export function all(sql, params = []) {
  const db = open(true);
  try {
    return rows(db.prepare(sql).all(...params));
  } finally {
    try {
      db.close();
    } catch {
      /* 忽略 */
    }
  }
}

export function get(sql, params = []) {
  return all(sql, params)[0] || null;
}

// 单条写入
export function run(sql, params = []) {
  const db = open(false);
  try {
    const info = db.prepare(sql).run(...params);
    return { changes: Number(info.changes || 0), lastInsertRowid: Number(info.lastInsertRowid || 0) };
  } finally {
    try {
      db.close();
    } catch {
      /* 忽略 */
    }
  }
}

// 多条写入放进一个事务：要么全成，要么全不成（会话行 + 附属表的一致性靠它）
export function transaction(statements) {
  const db = open(false);
  try {
    db.exec('BEGIN IMMEDIATE');
    const out = [];
    for (const s of statements) {
      const info = db.prepare(s.sql).run(...(s.params || []));
      out.push({ changes: Number(info.changes || 0), lastInsertRowid: Number(info.lastInsertRowid || 0) });
    }
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 已经回滚或未开启 */
    }
    throw e;
  } finally {
    try {
      db.close();
    } catch {
      /* 忽略 */
    }
  }
}

const TABLE_RE = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;

// 表的真实列名（客户端升级会加列，所以插入时按列名交集写，不按位置）
export function columns(table) {
  if (!TABLE_RE.test(String(table))) throw new Error('表名不合法');
  return all(`PRAGMA table_info(${table})`).map((r) => r.name);
}

export function tableExists(table) {
  if (!TABLE_RE.test(String(table))) return false;
  try {
    return !!get(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, [table]);
  } catch {
    return false;
  }
}

export function dirnameOfDb() {
  return path.dirname(workBuddyDb());
}

export function profileId() {
  return profile().id;
}
