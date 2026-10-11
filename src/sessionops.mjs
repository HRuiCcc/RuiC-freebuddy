// 会话的事务性操作：列表、分支、迁移（复制到别的账号/工作区）、重命名、删除、加密导出导入。
//
// 一个会话由这些部分组成（都在 WorkBuddy 数据根下）：
//   projects/<slug>/<id>.jsonl     消息记录（主体）
//   projects/<slug>/<id>/          同名产物目录
//   workspace/sessions/<id>/       工作区会话目录
//   tasks/<id>/                    任务清单
//   file-history/<id>/             文件历史
//   artifact-index/<id>.json       产物索引（里面记着归属会话）
//   workbuddy.db 的 sessions 行    索引（+ 可选 session_usage 行）
//
// 分支只取 ≤ 某锚点 的记录；迁移是把整份记录搬到另一个工作区/账号下并换新 id。
// 两件事都：**先写文件、后写行；行写失败就把刚写的文件删掉，不留半成品**。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import * as db from './wbdb.mjs';
import * as wb from './sessions.mjs';
import { workBuddyUserData, projectsDir, dataDir } from './config.mjs';

const MAX_ARCHIVE_BYTES = 48 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function safeId(id) {
  const s = String(id || '');
  if (!SAFE_ID.test(s) || s === '.' || s === '..') throw new Error('会话 ID 不合法');
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(s)) throw new Error('会话 ID 是系统保留名');
  return s;
}

function root() {
  return workBuddyUserData();
}

/* ───────── 列表 ───────── */

export function dbStatus() {
  return db.status();
}

export function workspaces() {
  return wb.listWorkspaces();
}

function fileInfo(id, slugHint) {
  const hit = slugHint ? { file: path.join(projectsDir(), slugHint, `${id}.jsonl`), slug: slugHint } : wb.findSessionFile(id);
  if (!hit || !fs.existsSync(hit.file)) return null;
  try {
    const st = fs.statSync(hit.file);
    return { file: hit.file, slug: hit.slug, size: st.size, mtime: st.mtimeMs };
  } catch {
    return null;
  }
}

export function list({ uid = null, includeBackground = true, limit = 300, query = '' } = {}) {
  if (!db.hasDb()) return { ok: false, error: '找不到 WorkBuddy 数据库', sessions: [] };
  const where = ['deleted_at IS NULL'];
  const params = [];
  if (uid) {
    where.push('user_id = ?');
    params.push(String(uid));
  }
  if (!includeBackground) where.push('COALESCE(is_background_automation,0) = 0');
  params.push(Math.max(1, Math.min(1000, Number(limit) || 300)));
  let rows;
  try {
    rows = db.all(
      `SELECT id, cwd, user_id, title, custom_title, status, created_at, updated_at, last_activity_at,
              is_background_automation, model, source_mode, transport, project_id
         FROM sessions WHERE ${where.join(' AND ')}
        ORDER BY COALESCE(last_activity_at, updated_at) DESC LIMIT ?`,
      params,
    );
  } catch (e) {
    return { ok: false, error: e.message, sessions: [] };
  }
  const q = String(query || '').trim().toLowerCase();
  const out = [];
  for (const r of rows) {
    const title = r.custom_title || r.title || '(无标题)';
    if (q && !(title.toLowerCase().includes(q) || String(r.id).toLowerCase().includes(q) || String(r.cwd || '').toLowerCase().includes(q))) {
      continue;
    }
    const fi = fileInfo(r.id, null);
    out.push({
      id: r.id,
      cwd: r.cwd || '',
      uid: r.user_id,
      title: r.custom_title || r.title || '(无标题)',
      baseTitle: r.title || '',
      customTitle: r.custom_title || '',
      status: r.status,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      lastActivityAt: r.last_activity_at,
      background: !!r.is_background_automation,
      model: r.model || null,
      sourceMode: r.source_mode || null,
      hasFile: !!fi,
      fileSize: fi ? fi.size : 0,
      slug: fi ? fi.slug : null,
    });
  }
  return { ok: true, sessions: out, total: rows.length };
}

export function detail(id) {
  safeId(id);
  const row = db.get('SELECT * FROM sessions WHERE id = ?', [id]);
  if (!row) throw new Error('没有这个会话');
  const hit = wb.findSessionFile(id);
  let summary = null;
  const anchors = [];
  if (hit && !hit.ambiguous) {
    const text = wb.readRecordsFile(hit.file);
    const parsed = wb.parseRecords(text);
    summary = { ...wb.summarizeRecords(parsed.records), skipped: parsed.skipped, file: hit.file, slug: hit.slug };
    for (const a of wb.buildAnchors(parsed.records)) anchors.push({ n: a.n, role: a.role, timestamp: a.timestamp, chars: a.chars, text: a.text.slice(0, 200) });
  }
  return { ok: true, session: row, file: hit ? hit.file : null, ambiguous: !!(hit && hit.ambiguous), summary, anchors };
}

/* ───────── 落库（按列名交集写，兼容客户端升级加列） ───────── */

function insertSession(values) {
  const cols = db.columns('sessions');
  const picked = Object.keys(values).filter((k) => cols.includes(k) && values[k] !== undefined);
  const sql = `INSERT INTO sessions (${picked.join(',')}) VALUES (${picked.map(() => '?').join(',')})`;
  return db.run(sql, picked.map((k) => values[k]));
}

function newSessionRow(src, { id, uid, cwd, title }) {
  const now = Date.now();
  return {
    id,
    cwd: cwd ?? src.cwd ?? '',
    user_id: uid || src.user_id,
    title: title ?? src.title ?? '',
    custom_title: title ?? src.custom_title ?? '',
    status: 'Pending',
    created_at: now,
    updated_at: now,
    last_activity_at: now,
    is_playground: Number(src.is_playground || 0),
    source_mode: src.source_mode ?? null,
    is_background_automation: src.is_background_automation == null ? null : Number(src.is_background_automation),
    mode: src.mode ?? null,
    model: src.model ?? null,
    expert_id: src.expert_id ?? null,
    expert_locale: src.expert_locale ?? null,
    expert_runtime_identity: src.expert_runtime_identity ?? null,
    expert_marketplace: src.expert_marketplace ?? null,
    permission_mode: src.permission_mode ?? null,
    use_sandbox_cli: src.use_sandbox_cli == null ? null : Number(src.use_sandbox_cli),
    project_id: src.project_id ?? null,
    thought_level: src.thought_level ?? null,
    context_window: src.context_window ?? null,
  };
}

/* ───────── 附属文件 ───────── */

function sidecarPaths(id) {
  const base = root();
  return [
    path.join(base, 'workspace', 'sessions', id),
    path.join(base, 'tasks', id),
    path.join(base, 'file-history', id),
    path.join(base, 'artifact-index', `${id}.json`),
  ];
}

function projectSidecars(id) {
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(projectsDir(), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(projectsDir(), e.name, id);
    if (fs.existsSync(dir)) out.push({ kind: 'dir', src: dir, slug: e.name });
  }
  return out;
}

function copyTree(src, dst) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) copyTree(path.join(src, name), path.join(dst, name));
  } else {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

function removeTree(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
}

// 复制附属目录到一个新 id（工作区变化时把 jsonl 的同名目录也搬过去）
function copySidecars(oldId, newId, { srcSlug, dstSlug } = {}) {
  const made = [];
  const mapDir = (src, dst) => {
    if (!fs.existsSync(src)) return;
    copyTree(src, dst);
    made.push(dst);
  };
  mapDir(path.join(root(), 'workspace', 'sessions', oldId), path.join(root(), 'workspace', 'sessions', newId));
  mapDir(path.join(root(), 'tasks', oldId), path.join(root(), 'tasks', newId));
  mapDir(path.join(root(), 'file-history', oldId), path.join(root(), 'file-history', newId));
  if (srcSlug) {
    mapDir(path.join(projectsDir(), srcSlug, oldId), path.join(projectsDir(), dstSlug || srcSlug, newId));
  }
  const artifact = path.join(root(), 'artifact-index', `${oldId}.json`);
  if (fs.existsSync(artifact)) {
    try {
      const doc = JSON.parse(fs.readFileSync(artifact, 'utf8'));
      const remap = (v) => (v === oldId ? newId : v);
      if (Array.isArray(doc.artifacts)) {
        for (const a of doc.artifacts) {
          if (a && a._meta && a._meta.ownerConversationId) a._meta.ownerConversationId = remap(a._meta.ownerConversationId);
        }
      }
      if (doc.ownerConversationId) doc.ownerConversationId = remap(doc.ownerConversationId);
      const dest = path.join(root(), 'artifact-index', `${newId}.json`);
      fs.writeFileSync(dest, JSON.stringify(doc, null, 2));
      made.push(dest);
    } catch {
      /* 索引坏了就跳过，不阻断 */
    }
  }
  return made;
}

/* ───────── 分支 ───────── */

export function fork({ id, anchor, at, latest, title, verbatim = false } = {}) {
  safeId(id);
  const src = db.get('SELECT * FROM sessions WHERE id = ? AND deleted_at IS NULL', [id]);
  if (!src) throw new Error('没有这个会话（或已被删除）');
  const hit = wb.findSessionFile(id);
  if (!hit) throw new Error('没有找到这个会话的记录文件');
  if (hit.ambiguous) throw new Error('这个会话 ID 在多个工作区都有记录，无法唯一确定源文件');
  const text = wb.readRecordsFile(hit.file);

  const spec = latest ? undefined : anchor;
  let plan;
  if (at && typeof at === 'object') {
    plan = wb.planForkAtMessage(text, at);
  } else {
    const parsed = wb.parseRecords(text);
    const anchors = wb.buildAnchors(parsed.records);
    if (!anchors.length) throw new Error('会话里没有可分叉的消息');
    const chosen = latest ? anchors[anchors.length - 1] : wb.resolveAnchor(spec, anchors);
    if (!chosen) throw new Error(`锚点没解析出来：${String(spec)}`);
    plan = wb.planFork(text, chosen.n);
  }
  if (!plan.ok) throw new Error(plan.reason);

  const newId = crypto.randomUUID();
  const destFile = path.join(path.dirname(hit.file), `${newId}.jsonl`);
  let content = plan.text;
  let rebound = 0;
  if (!verbatim) {
    const r = wb.rebindRecords(content, { newSessionId: newId, oldSessionId: id });
    content = r.text;
    rebound = r.changed;
  }
  fs.writeFileSync(destFile, content, { flag: 'wx', mode: 0o600 });
  const newTitle = wb.forkedTitle(title || src.custom_title || src.title, plan.suffix);
  let row;
  try {
    row = insertSession(newSessionRow(src, { id: newId, uid: src.user_id, cwd: src.cwd, title: newTitle }));
  } catch (e) {
    removeTree(destFile);
    throw new Error('写入会话索引失败，已回滚新文件：' + e.message);
  }
  const files = copySidecars(id, newId, { srcSlug: hit.slug, dstSlug: hit.slug });
  return {
    ok: true,
    id: newId,
    title: newTitle,
    file: destFile,
    keep: plan.keep,
    drop: plan.drop,
    keptRecords: plan.keptRecords,
    droppedRecords: plan.droppedRecords,
    rebound,
    anchor: { n: plan.anchor.n, role: plan.anchor.role, timestamp: plan.anchor.timestamp, clock: wb.clockOf(plan.anchor.timestamp) },
    rowChanges: row.changes,
    sidecars: files.length,
    sourceFile: hit.file,
  };
}

/* ───────── 迁移（整体复制到别的账号 / 别的工作区） ───────── */

export function copy({ id, targetCwd, targetUid, title, keepGroups = false } = {}) {
  safeId(id);
  const src = db.get('SELECT * FROM sessions WHERE id = ? AND deleted_at IS NULL', [id]);
  if (!src) throw new Error('没有这个会话（或已被删除）');
  const hit = wb.findSessionFile(id);
  if (!hit) throw new Error('没有找到这个会话的记录文件');
  const cwd = targetCwd !== undefined && targetCwd !== null && String(targetCwd).trim() ? String(targetCwd).trim() : src.cwd || '';
  if (cwd && !path.isAbsolute(cwd)) throw new Error('目标工作目录必须是绝对路径');
  const uid = targetUid ? String(targetUid) : src.user_id;

  // 目标工作区 slug：已有该 cwd 的目录就沿用，否则按规则推导
  const map = wb.workspaceMap();
  const dstSlug = (cwd && map.get(cwd.toLowerCase())) || (cwd ? wb.slugFor(cwd) : hit.slug);
  const dstDir = path.join(projectsDir(), dstSlug);
  fs.mkdirSync(dstDir, { recursive: true });

  const text = wb.readRecordsFile(hit.file);
  const newId = crypto.randomUUID();
  const rebind = wb.rebindRecords(text, { newSessionId: newId, cwd: cwd || undefined, oldSessionId: id });
  const destFile = path.join(dstDir, `${newId}.jsonl`);
  fs.writeFileSync(destFile, rebind.text, { flag: 'wx', mode: 0o600 });
  const newTitle = String(title || src.custom_title || src.title || '').slice(0, 200);
  let row;
  try {
    row = insertSession(newSessionRow(src, { id: newId, uid, cwd, title: newTitle }));
  } catch (e) {
    removeTree(destFile);
    throw new Error('写入会话索引失败，已回滚新文件：' + e.message);
  }
  const files = copySidecars(id, newId, { srcSlug: hit.slug, dstSlug });
  return {
    ok: true,
    id: newId,
    title: newTitle,
    uid,
    cwd,
    slug: dstSlug,
    file: destFile,
    rebound: rebind.changed,
    rowChanges: row.changes,
    sidecars: files.length,
    sourceSlug: hit.slug,
  };
}

/* ───────── 重命名 / 删除 ───────── */

export function rename(id, title) {
  safeId(id);
  const t = String(title || '').slice(0, 200);
  const r = db.run('UPDATE sessions SET custom_title = ?, updated_at = ? WHERE id = ?', [t, Date.now(), id]);
  if (!r.changes) throw new Error('没有这个会话（或标题没有变化）');
  return { ok: true, id, title: t };
}

export function remove(ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).map(safeId);
  const report = [];
  for (const id of list) {
    const hit = wb.findSessionFile(id);
    const removedFiles = [];
    if (hit && !hit.ambiguous) {
      removeTree(hit.file);
      removedFiles.push(hit.file);
      removeTree(path.join(path.dirname(hit.file), id));
      removedFiles.push(path.join(path.dirname(hit.file), id));
    }
    for (const p of sidecarPaths(id)) {
      if (fs.existsSync(p)) {
        removeTree(p);
        removedFiles.push(p);
      }
    }
    for (const sd of projectSidecars(id)) {
      removeTree(sd.src);
      removedFiles.push(sd.src);
    }
    let rowChanges = 0;
    try {
      rowChanges = db.run('DELETE FROM sessions WHERE id = ?', [id]).changes;
      try {
        db.run('DELETE FROM session_usage WHERE session_id = ?', [id]);
      } catch {
        /* 表可能不存在 */
      }
    } catch (e) {
      report.push({ id, ok: false, error: '删除索引失败（文件已清）：' + e.message });
      continue;
    }
    report.push({ id, ok: true, rowChanges, files: removedFiles.length });
  }
  return { ok: report.every((r) => r.ok), report };
}

/* ───────── 加密导出 / 导入（跨设备搬运） ───────── */

export function exportArchive(ids, password) {
  if (!password || typeof password !== 'string') throw new Error('请先设置导出密码');
  const list = (Array.isArray(ids) ? ids : [ids]).map(safeId);
  const payload = { freebuddy: true, kind: 'sessions', version: 1, createdAt: new Date().toISOString(), sessions: [] };
  let bytes = 0;
  for (const id of list) {
    const row = db.get('SELECT * FROM sessions WHERE id = ?', [id]);
    if (!row) continue;
    const hit = wb.findSessionFile(id);
    const entry = { row, transcript: null, files: [] };
    if (hit && !hit.ambiguous) {
      const text = wb.readRecordsFile(hit.file);
      bytes += Buffer.byteLength(text);
      entry.transcript = text;
      entry.slug = hit.slug;
      for (const sd of projectSidecars(id)) {
        for (const f of walkFiles(sd.src)) {
          const content = fs.readFileSync(f);
          bytes += content.length;
          if (bytes > MAX_ARCHIVE_BYTES) throw new Error('会话数据过大，已拒绝导出（上限 48 MiB）');
          entry.files.push({ rel: path.relative(root(), f).replace(/\\/g, '/'), base64: content.toString('base64') });
        }
      }
    }
    payload.sessions.push(entry);
  }
  if (!payload.sessions.length) throw new Error('没有可导出的会话');
  if (bytes > MAX_ARCHIVE_BYTES) throw new Error('会话数据过大，已拒绝导出（上限 48 MiB）');
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(password, salt, 32);
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'));
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(gz), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    filename: `freebuddy-sessions-${new Date().toISOString().slice(0, 10)}.json`,
    count: payload.sessions.length,
    bytes,
    content: {
      freebuddy: true,
      version: 1,
      kdf: 'aes-256-gcm+scrypt',
      compression: 'gzip',
      salt: salt.toString('base64'),
      data: Buffer.concat([iv, tag, ct]).toString('base64'),
    },
  };
}

function walkFiles(dir, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
  return out;
}

export function importArchive(content, password) {
  const env = typeof content === 'string' ? JSON.parse(content) : content;
  if (!env || env.freebuddy !== true) throw new Error('这不是 FreeBuddy 导出的会话文件');
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
  const imported = [];
  const failed = [];
  for (const entry of payload.sessions || []) {
    try {
      const src = entry.row || {};
      const newId = crypto.randomUUID();
      const cwd = src.cwd || '';
      const map = wb.workspaceMap();
      const slug = entry.slug || (cwd && map.get(cwd.toLowerCase())) || (cwd ? wb.slugFor(cwd) : 'imported');
      const dstDir = path.join(projectsDir(), slug);
      fs.mkdirSync(dstDir, { recursive: true });
      if (entry.transcript) {
        const rebind = wb.rebindRecords(entry.transcript, { newSessionId: newId, oldSessionId: src.id });
        fs.writeFileSync(path.join(dstDir, `${newId}.jsonl`), rebind.text, { flag: 'wx', mode: 0o600 });
      }
      insertSession(newSessionRow(src, { id: newId, uid: src.user_id, cwd, title: src.custom_title || src.title }));
      for (const f of entry.files || []) {
        // 附属文件的相对路径里带着源会话 id（目录名/索引文件名），换成新 id 再落盘
        const rel = String(f.rel || '').replace(/^[\\/]+/, '');
        if (!rel || rel.includes('..')) continue;
        const destRel = src.id ? rel.split('/').map((seg) => (seg === String(src.id) || seg === `${src.id}.json` ? seg.replace(String(src.id), newId) : seg)).join('/') : rel;
        const dest = path.join(root(), destRel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, Buffer.from(f.base64, 'base64'));
      }
      imported.push(newId);
    } catch (e) {
      failed.push(String(e.message || e));
    }
  }
  return { ok: true, imported: imported.length, failed, ids: imported };
}

export function openDataDirTarget() {
  return dataDir();
}
