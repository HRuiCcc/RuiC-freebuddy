// 账号内核：登录信息文件的解析、备份、切换、删除，以及加密导入导出。
// 只碰官方写在磁盘上的登录信息文件与 freebuddy 自己的数据目录；不动官方安装包。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import * as tokencache from './tokencache.mjs';
import * as wbdecrypt from './wbdecrypt.mjs';
import {
  profile,
  dataDir,
  accountsDir,
  accountFile,
  ensureDirs,
} from './config.mjs';

const UID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const BAD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export function safeUid(uid) {
  if (typeof uid !== 'string' || !UID_RE.test(uid) || BAD_KEYS.has(uid)) {
    throw new Error('账号标识不合法');
  }
  return uid;
}

function isEnvelope(v) {
  return !!v && typeof v === 'object' && v.$wbEncrypted === 1;
}

// 解出明文值：普通值直接用；$wbEncrypted 信封用客户端自己的 at-rest 密钥解密
function plain(v) {
  if (v === null || v === undefined) return null;
  if (isEnvelope(v)) {
    const d = wbdecrypt.decryptField(v);
    return d == null ? null : d;
  }
  if (typeof v === 'object') return null;
  return String(v);
}

function pickToken(auth) {
  const t = auth.accessToken ?? auth.access_token ?? auth.token;
  if (isEnvelope(t)) {
    const d = wbdecrypt.decryptField(t);
    return { token: d || null, encrypted: d == null };
  }
  return { token: t ? String(t) : null, encrypted: false };
}

export function parseAuth(raw) {
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error('登录信息文件不是合法 JSON');
  }
  const account = json.account || (Array.isArray(json.accounts) ? json.accounts[0] : null) || {};
  const auth = json.auth || {};
  const uid = account.uid || json.uid;
  if (!uid) throw new Error('登录信息文件里没有账号标识');
  const { token, encrypted } = pickToken(auth);
  return {
    json,
    uid: String(uid),
    nickname: plain(account.nickname),
    phone: plain(account.phoneNumber ?? account.phone),
    uin: plain(account.uin),
    edition: plain(account.type) || null,
    enterpriseName: plain(account.enterpriseName),
    token,
    tokenEncrypted: encrypted,
    refreshToken: plain(auth.refreshToken),
    expiresAt: Number(auth.expiresAt) || null,
    refreshExpiresAt: Number(auth.refreshExpiresAt) || null,
    domain: auth.domain || null,
  };
}

export function readAuthFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return { raw, ...parseAuth(raw) };
}

export function readCurrent() {
  const p = profile();
  try {
    return readAuthFile(p.authFile);
  } catch {
    return null;
  }
}

/* ───────── meta.json ───────── */

function metaPath() {
  return path.join(dataDir(), 'meta.json');
}

export function readMeta() {
  try {
    const j = JSON.parse(fs.readFileSync(metaPath(), 'utf8'));
    return { accounts: j.accounts || {}, primaryUid: j.primaryUid || null, version: 1 };
  } catch {
    return { accounts: {}, primaryUid: null, version: 1 };
  }
}

function writeFileAtomic(file, content, mode) {
  const tmp = `${file}.fb-tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, { mode: mode || 0o600 });
  fs.renameSync(tmp, file);
}

export function writeMeta(meta) {
  ensureDirs();
  writeFileAtomic(metaPath(), JSON.stringify(meta, null, 2), 0o600);
}

export function touchAccount(meta, uid, patch) {
  const cur = meta.accounts[uid] || { uid, firstSeen: Date.now() };
  meta.accounts[uid] = { ...cur, ...patch, uid, lastSeen: Date.now() };
  return meta.accounts[uid];
}

/* ───────── 备份 / 切换 ───────── */

export function backupCurrent(hint) {
  const p = profile();
  const cur = readCurrent();
  if (!cur) throw new Error('读不到当前登录信息，可能还没登录');
  if (hint && hint.nickname && !cur.nickname) cur.nickname = hint.nickname;
  if (hint && hint.edition && !cur.edition) cur.edition = hint.edition;
  safeUid(cur.uid);
  ensureDirs();
  const dest = accountFile(cur.uid);
  // 覆盖前先抢救旧文件里的明文凭据：新版客户端会把会话加密，一旦覆盖就再也读不出来
  try {
    if (fs.existsSync(dest)) {
      const prev = parseAuth(fs.readFileSync(dest, 'utf8'));
      if (prev.token) {
        tokencache.save(cur.uid, { token: prev.token, refreshToken: prev.refreshToken, expiresAt: prev.expiresAt });
      }
    }
  } catch {
    /* 旧备份不可读就算了 */
  }
  // 原样落盘：密文保持密文，不做解密也不改写
  writeFileAtomic(dest, cur.raw, 0o600);
  const meta = readMeta();
  // 加密账号解析出来的 nickname/phone 是 null —— 绝不能拿它覆盖已有记录，
  // 否则每次备份都会把之前从别处迁移过来的账号资料抹掉。
  const patch = {
    uin: cur.uin || null,
    authFileName: path.basename(p.authFile),
    domain: cur.domain || null,
  };
  if (cur.nickname) patch.nickname = cur.nickname;
  if (cur.phone) patch.phone = cur.phone;
  if (cur.edition) patch.edition = cur.edition;
  if (cur.enterpriseName) patch.enterpriseName = cur.enterpriseName;
  const existing = meta.accounts[cur.uid] || {};
  for (const k of Object.keys(patch)) if (patch[k] == null && existing[k] != null) delete patch[k];
  touchAccount(meta, cur.uid, patch);
  writeMeta(meta);
  return { uid: cur.uid, nickname: cur.nickname || meta.accounts[cur.uid].nickname || null };
}

export function switchTo(uid) {
  safeUid(uid);
  const p = profile();
  const file = accountFile(uid);
  if (!fs.existsSync(file)) throw new Error('这个账号还没有本机备份');
  const raw = fs.readFileSync(file, 'utf8');
  // 校验备份与目标 uid 一致，避免写错人的登录态
  const parsed = parseAuth(raw);
  if (parsed.uid !== uid) throw new Error('备份内容与账号标识不一致，已中止');
  // 先备份一份当前的，防止切走后再也回不来
  try {
    backupCurrent();
  } catch {
    /* 当前没有可备份的登录态（例如停在登录页） */
  }
  fs.mkdirSync(path.dirname(p.authFile), { recursive: true });
  writeFileAtomic(p.authFile, raw, 0o600);
  // 清掉官方可能留下的退出标记
  for (const suffix of ['.logged-out', '.logout']) {
    const m = p.authFile + suffix;
    if (fs.existsSync(m)) {
      try {
        fs.unlinkSync(m);
      } catch {
        /* 忽略 */
      }
    }
  }
  const meta = readMeta();
  touchAccount(meta, uid, { authFileName: path.basename(p.authFile) });
  // 用户的预期是「切到哪个账号，主账号就是哪个」，这里跟着走；想固定也可以点星标再设一次
  meta.primaryUid = uid;
  writeMeta(meta);
  return { uid, nickname: parsed.nickname, primaryUid: uid };
}

export function deleteAccount(uid) {
  safeUid(uid);
  const file = accountFile(uid);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  const meta = readMeta();
  delete meta.accounts[uid];
  if (meta.primaryUid === uid) meta.primaryUid = null;
  writeMeta(meta);
  return { uid };
}

// 假装退出：删掉官方登录信息文件（备份保留，token 不过期，可随时切回）
export function logoutCurrent() {
  const p = profile();
  if (fs.existsSync(p.authFile)) fs.unlinkSync(p.authFile);
  return { removed: p.authFile };
}

export function setNote(uid, note) {
  safeUid(uid);
  const meta = readMeta();
  touchAccount(meta, uid, { note: String(note || '').slice(0, 60) });
  writeMeta(meta);
  return { uid, note };
}

export function setPrimary(uid) {
  safeUid(uid);
  const meta = readMeta();
  meta.primaryUid = uid;
  writeMeta(meta);
  return { uid };
}

// 刷新成功后把新的登录态写回明文备份（结构原样保留，只换 token 相关字段）
export function applyTokenRefresh(uid, refresh) {
  safeUid(uid);
  const file = accountFile(uid);
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!json.auth || typeof json.auth !== 'object') json.auth = {};
  if (refresh.accessToken) json.auth.accessToken = refresh.accessToken;
  if (refresh.refreshToken) json.auth.refreshToken = refresh.refreshToken;
  if (refresh.expiresAt) json.auth.expiresAt = refresh.expiresAt;
  if (refresh.refreshExpiresAt) json.auth.refreshExpiresAt = refresh.refreshExpiresAt;
  json.auth.lastRefreshTime = refresh.lastRefreshTime || Date.now();
  writeFileAtomic(file, JSON.stringify(json), 0o600);
  return { uid };
}

/* ───────── 列表 ───────── */

export function listAccounts() {
  ensureDirs();
  const meta = readMeta();
  const cur = readCurrent();
  const files = fs.existsSync(accountsDir()) ? fs.readdirSync(accountsDir()) : [];
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.info')) continue;
    const uid = f.slice(0, -5);
    if (!UID_RE.test(uid) || BAD_KEYS.has(uid)) continue;
    const m = meta.accounts[uid] || {};
    let parsed = null;
    try {
      parsed = parseAuth(fs.readFileSync(path.join(accountsDir(), f), 'utf8'));
    } catch {
      /* 备份损坏时仍列出来，让用户能删掉 */
    }
    const isCurrent = !!cur && cur.uid === uid;
    out.push({
      uid,
      note: m.note || null,
      // 优先用本机记录，其次用备份里的明文，最后（当前账号）用备份里的明文
      nickname: m.nickname || (parsed && parsed.nickname) || null,
      phone: m.phone || (parsed && parsed.phone) || null,
      uin: m.uin || (parsed && parsed.uin) || null,
      edition: m.edition || (parsed && parsed.edition) || null,
      isCurrent,
      isPrimary: meta.primaryUid === uid,
      tokenExpiresAt: parsed && parsed.expiresAt,
      tokenUsable: !!(parsed && parsed.token),
      tokenEncrypted: !!(parsed && parsed.tokenEncrypted),
      authValid: parsed !== null,
    });
  }
  // 当前登录但还没备份 → 也列出来，方便一键备份
  if (cur && UID_RE.test(cur.uid) && !out.some((a) => a.uid === cur.uid)) {
    out.push({
      uid: cur.uid,
      note: meta.accounts[cur.uid]?.note || null,
      nickname: cur.nickname,
      phone: cur.phone,
      uin: cur.uin,
      edition: cur.edition,
      isCurrent: true,
      isPrimary: meta.primaryUid === cur.uid,
      tokenExpiresAt: cur.expiresAt,
      tokenUsable: !!cur.token,
      tokenEncrypted: cur.tokenEncrypted,
      authValid: true,
      notBackedUp: true,
    });
  }
  out.sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || String(a.nickname || a.uid).localeCompare(String(b.nickname || b.uid)));
  return out;
}

/* ───────── 加密导入导出（AES-256-GCM + scrypt + gzip） ───────── */

export function exportAccounts(password, uids) {
  if (!password || typeof password !== 'string') throw new Error('请先设置导出密码');
  if (password.length > 1024) throw new Error('密码过长');
  const wanted = uids && uids.length ? new Set(uids.map(safeUid)) : null;
  const payload = { accounts: [] };
  const meta = readMeta();
  for (const a of listAccounts()) {
    if (wanted && !wanted.has(a.uid)) continue;
    const file = accountFile(a.uid);
    if (!fs.existsSync(file)) continue;
    payload.accounts.push({
      uid: a.uid,
      note: meta.accounts[a.uid]?.note || null,
      raw: fs.readFileSync(file, 'utf8'),
    });
  }
  if (!payload.accounts.length) throw new Error('没有可导出的账号备份');
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(password, salt, 32);
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'));
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(gz), cipher.final()]);
  const tag = cipher.getAuthTag();
  const envelope = {
    freebuddy: true,
    version: 1,
    createdAt: new Date().toISOString(),
    kdf: 'aes-256-gcm+scrypt',
    compression: 'gzip',
    salt: salt.toString('base64'),
    data: Buffer.concat([iv, tag, ct]).toString('base64'),
  };
  const stamp = new Date().toISOString().slice(0, 10);
  return {
    filename: `freebuddy-accounts-${stamp}.json`,
    count: payload.accounts.length,
    content: envelope,
  };
}

export function importAccounts(content, password) {
  const env = typeof content === 'string' ? JSON.parse(content) : content;
  if (!env || env.freebuddy !== true) throw new Error('这不是 FreeBuddy 导出的账号文件');
  if (!password) throw new Error('请输入导出时设置的密码');
  const salt = Buffer.from(env.salt, 'base64');
  const blob = Buffer.from(env.data, 'base64');
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ct = blob.subarray(28);
  const key = crypto.scryptSync(password, salt, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  let gz;
  try {
    gz = Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new Error('密码不对，或文件已损坏');
  }
  const payload = JSON.parse(zlib.gunzipSync(gz).toString('utf8'));
  ensureDirs();
  const meta = readMeta();
  const imported = [];
  let skipped = 0;
  for (const a of payload.accounts || []) {
    const uid = safeUid(a.uid);
    if (fs.existsSync(accountFile(uid))) {
      skipped++;
      continue;
    }
    parseAuth(a.raw); // 校验内容可解析
    writeFileAtomic(accountFile(uid), a.raw, 0o600);
    touchAccount(meta, uid, { note: a.note || null });
    imported.push(uid);
  }
  writeMeta(meta);
  return { imported, count: imported.length, skipped };
}
