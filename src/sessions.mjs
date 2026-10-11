// 会话记录的纯逻辑：解析、锚点、切片、新标题、路径定位、运行身份重绑。
//
// 这里**不碰数据库、不写任何文件** —— 落库与写盘都在 sessionops.mjs。
// 会话记录是逐行 JSON 落在 <userData>/projects/<工作区slug>/<会话id>.jsonl。
//
// 分叉只支持「保留前缀到某个锚点为止」：丢掉前缀会让新会话从半轮开始、
// 缺开头的 user 消息，那种产物没有意义。
import fs from 'node:fs';
import path from 'node:path';
import { profile, projectsDir } from './config.mjs';

// 一条记录最大 64 MiB，超过就 fail closed，不把异常文件读进内存
export const MAX_RECORD_BYTES = 64 * 1024 * 1024;
export const MAX_ANCHOR = 100000;
export const TITLE_LIMIT = 60;
export const DEFAULT_SUFFIX = '（分支）';

// harness 注入块的起始标记：这类 user 记录不是用户真说的话
const INJECTED_PREFIX = /^\s*<(cb_summary|system-reminder|additional_data|identity_context|task-notification)/;
const ANCHOR_ROLES = new Set(['user', 'assistant']);

export function parseRecords(text) {
  const records = [];
  let skipped = 0;
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      records.push({ line, value: JSON.parse(line) });
    } catch {
      skipped++;
    }
  }
  return { records, skipped };
}

function messageText(record) {
  if (!record || !Array.isArray(record.content)) return '';
  let out = '';
  for (const item of record.content) {
    if (item && typeof item.text === 'string') out += item.text;
  }
  return out.trim();
}

// user 消息正文：先抽 <user_query> 里的真话（注入块可能与真话同行），
// 抽不到且整条以注入块开头时返回空串，调用方据此跳过。
function userQueryText(record) {
  const raw = messageText(record);
  if (!raw) return '';
  const m = raw.match(/<user_query>([\s\S]*?)<\/user_query>/);
  if (m) return m[1].trim();
  if (INJECTED_PREFIX.test(raw)) return '';
  return raw;
}

// 锚点 = 有可见正文的 user / assistant 消息，按出现顺序从 1 编号
export function buildAnchors(records) {
  const anchors = [];
  records.forEach((entry, index) => {
    const r = entry.value;
    if (!r || r.type !== 'message' || !ANCHOR_ROLES.has(r.role)) return;
    const text = r.role === 'user' ? userQueryText(r) : messageText(r);
    if (!text) return;
    anchors.push({
      n: anchors.length + 1,
      index,
      role: r.role,
      timestamp: Number(r.timestamp) || 0,
      chars: text.length,
      text,
      messageId: r.id || null,
    });
  });
  return anchors;
}

export function clockOf(timestamp) {
  if (!timestamp) return '--:--';
  const d = new Date(timestamp);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 解析锚点选择器：12 / #12 / "09-17 15:30" / "15:30"（时间从尾部往前找）
export function resolveAnchor(spec, anchors) {
  if (spec === undefined || spec === null || spec === true) return null;
  const text = String(spec).replace(/^#/, '').trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    if (!Number.isSafeInteger(n) || n < 1 || n > MAX_ANCHOR) return null;
    return anchors.find((a) => a.n === n) || null;
  }
  for (let i = anchors.length - 1; i >= 0; i--) {
    if (clockOf(anchors[i].timestamp).includes(text)) return anchors[i];
  }
  return null;
}

// 切点：锚点这一轮结束的位置 = 下一条 message 记录之前。
// 直接砍在锚点之后会留下没有结果的 function_call。
export function cutIndexFor(anchor, records) {
  for (let i = anchor.index + 1; i < records.length; i++) {
    if (records[i].value && records[i].value.type === 'message') return i;
  }
  return records.length;
}

export function forkedTitle(title, suffix = DEFAULT_SUFFIX) {
  const base = String(title || '').trim();
  const tail = String(suffix || '');
  if (!base) return tail.slice(0, TITLE_LIMIT);
  const room = Math.max(1, TITLE_LIMIT - tail.length);
  return (base.length > room ? base.slice(0, room) : base) + tail;
}

export function planFork(text, spec, options = {}) {
  const suffix = options.suffix === undefined ? DEFAULT_SUFFIX : options.suffix;
  const parsed = parseRecords(text);
  if (!parsed.records.length) return { ok: false, reason: '会话记录为空', anchors: [], skipped: parsed.skipped };
  const anchors = buildAnchors(parsed.records);
  if (!anchors.length) return { ok: false, reason: '会话里没有可分叉的消息', anchors, skipped: parsed.skipped };
  const anchor = resolveAnchor(spec, anchors);
  if (!anchor) return { ok: false, reason: `锚点没解析出来：${String(spec)}`, anchors, skipped: parsed.skipped };
  const cut = cutIndexFor(anchor, parsed.records);
  const kept = parsed.records.slice(0, cut);
  const keptAnchors = anchors.filter((a) => a.index < cut);
  if (!keptAnchors.length) return { ok: false, reason: '分叉点之前没有可保留的消息', anchors, skipped: parsed.skipped };
  return {
    ok: true,
    anchor,
    anchors,
    skipped: parsed.skipped,
    keep: keptAnchors.length,
    drop: anchors.length - keptAnchors.length,
    keptRecords: kept.length,
    droppedRecords: parsed.records.length - kept.length,
    text: kept.map((e) => e.line).join('\n') + '\n',
    suffix,
  };
}

// 渲染层上报的是「角色串 + 选中下标 + 该回复完成时间」；渲染层的消息序列
// 和 jsonl 记录序列形状并不一致（一轮流式回复可能落成多条 assistant 记录，
// task-notification 这类 user 记录在界面上被隐藏），所以只有两边角色串一致
// 时才敢用下标，否则用完成时间精确匹配（容差 30 秒，宁可报错也不猜位置）。
export function planForkAtMessage(text, selection) {
  const invalid = (reason) => ({ ok: false, reason });
  const roles = selection && selection.roles;
  const index = selection && selection.messageIndex;
  const finishedAt = selection && selection.finishedAt;
  if (
    typeof roles !== 'string' ||
    !/^[ua]{2,10000}$/.test(roles) ||
    roles[0] !== 'u' ||
    roles[roles.length - 1] !== 'a' ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= roles.length ||
    roles[index] !== 'a' ||
    !Number.isSafeInteger(finishedAt) ||
    finishedAt <= 0
  ) {
    return invalid('分支位置参数无效');
  }
  const parsed = parseRecords(text);
  if (parsed.skipped) return invalid('会话记录正在写入或包含损坏的行，请稍后重试');
  const messages = parsed.records
    .map((entry, recordIndex) => ({ recordIndex, value: entry.value }))
    .filter((e) => e.value && e.value.type === 'message' && ANCHOR_ROLES.has(e.value.role));
  const assistantMessages = messages.filter((e) => e.value.role === 'assistant');
  const rawRoles = messages.map((e) => (e.value.role === 'user' ? 'u' : 'a')).join('');
  let selected;
  if (rawRoles === roles) {
    selected = messages[index];
  } else {
    selected = assistantMessages.find((e) => Number(e.value.timestamp) === finishedAt);
  }
  if (!selected && rawRoles !== roles) {
    selected = assistantMessages
      .filter((e) => Number.isSafeInteger(Number(e.value.timestamp)) && Number(e.value.timestamp) > 0)
      .map((e) => ({ e, distance: Math.abs(Number(e.value.timestamp) - finishedAt) }))
      .filter((x) => x.distance <= 30000)
      .sort((a, b) => a.distance - b.distance)[0]?.e;
  }
  const recordedAt = selected && selected.value.timestamp;
  if (
    !selected ||
    selected.value.role !== 'assistant' ||
    !Number.isSafeInteger(recordedAt) ||
    recordedAt <= 0 ||
    Math.abs(recordedAt - finishedAt) > 30000
  ) {
    return invalid('无法确认所选消息的分支位置');
  }
  const anchor = buildAnchors(parsed.records).find((a) => a.index === selected.recordIndex);
  if (!anchor) return invalid('所选消息没有可分支的正文');
  return planFork(text, anchor.n, selection);
}

export function describeAnchor(anchor) {
  const text = anchor.text.replace(/\s+/g, ' ').trim();
  return `#${String(anchor.n).padStart(3, '0')} | ${clockOf(anchor.timestamp)} | ${anchor.role.padEnd(9)} | ${text.slice(0, 80)}（${anchor.chars} 字）`;
}

export function summarizeRecords(records) {
  let messages = 0;
  let tools = 0;
  let reasoning = 0;
  let firstTs = 0;
  let lastTs = 0;
  for (const { value: r } of records) {
    if (!r) continue;
    const t = Number(r.timestamp) || 0;
    if (t) {
      if (!firstTs || t < firstTs) firstTs = t;
      if (t > lastTs) lastTs = t;
    }
    if (r.type === 'message') messages++;
    else if (r.type === 'function_call' || r.type === 'function_call_result' || r.type === 'tool_call') tools++;
    else if (r.type === 'reasoning') reasoning++;
  }
  return { records: records.length, messages, tools, reasoning, firstTs, lastTs };
}

/* ───────── 路径与工作区 slug ───────── */

// WorkBuddy 的工作区目录名 = cwd 里非字母数字的字符换成 "-"（盘符小写，其余保持大小写）
// 例：C:\Users\Admin\WorkBuddy\2026-09-17-21-10-04 → C-Users-... 的实际目录
//     c-Users-Admin-WorkBuddy-2026-09-17-21-10-04
export function slugFor(cwd) {
  const raw = String(cwd || '').trim();
  if (!raw) return null;
  const normalized = raw.replace(/[\\/]+/g, '\\');
  const drive = /^([A-Za-z]):/.exec(normalized);
  const body = drive ? normalized.slice(2) : normalized;
  const slug = body.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (drive ? drive[1].toLowerCase() : '') + (drive ? '-' : '') + slug;
}

// 枚举 projects/*，用记录里的 cwd 反查真实 slug（比推导靠得住）
export function workspaceMap() {
  const root = projectsDir();
  const out = new Map(); // cwd(lower) -> slug
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files.slice(0, 3)) {
      try {
        const head = fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/, 1)[0];
        const rec = JSON.parse(head);
        if (rec && rec.cwd) {
          out.set(String(rec.cwd).toLowerCase(), e.name);
          break;
        }
      } catch {
        /* 读不到就下一个 */
      }
    }
  }
  return out;
}

export function listWorkspaces() {
  const root = projectsDir();
  const seen = new Map();
  const map = workspaceMap();
  for (const [cwd, slug] of map.entries()) seen.set(slug, cwd);
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    /* 没有 projects 目录 */
  }
  for (const e of entries) {
    if (!e.isDirectory() || seen.has(e.name)) continue;
    let n = 0;
    try {
      n = fs.readdirSync(path.join(root, e.name)).filter((f) => f.endsWith('.jsonl')).length;
    } catch {
      /* 忽略 */
    }
    seen.set(e.name, null);
    if (n === 0) continue;
  }
  return [...seen.entries()].map(([slug, cwd]) => ({ slug, cwd }));
}

// 会话记录文件：projects/<slug>/<id>.jsonl（跨所有工作区找）
export function findSessionFile(sessionId) {
  const id = String(sessionId || '');
  if (!id || /[\\/]/.test(id) || id === '.' || id === '..') return null;
  const root = projectsDir();
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const hits = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const file = path.join(root, e.name, `${id}.jsonl`);
    if (fs.existsSync(file)) hits.push({ file, slug: e.name });
  }
  return hits.length === 1 ? hits[0] : hits.length ? { ...hits[0], ambiguous: hits.length } : null;
}

export function readRecordsFile(file) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error('会话记录不是普通文件');
  if (stat.size > MAX_RECORD_BYTES) throw new Error('会话记录过大，已拒绝读取');
  return fs.readFileSync(file, 'utf8');
}

// 运行身份重绑：把记录里的 sessionId（和可选 cwd）改成新会话的。
// 逐行解析后只改这两个字段，其它字段、顺序、数字精度都保留；
// 解析不了的行走原样（分叉时已知有坏行的情形在调用方就已拦住）。
export function rebindRecords(text, { newSessionId, cwd, oldSessionId } = {}) {
  let changed = 0;
  const lines = String(text).split('\n');
  const out = lines.map((line) => {
    if (!line.trim()) return line;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      return line;
    }
    if (!rec || typeof rec !== 'object') return line;
    let touched = false;
    if (newSessionId && rec.sessionId !== undefined && (!oldSessionId || rec.sessionId === oldSessionId)) {
      rec.sessionId = newSessionId;
      touched = true;
    }
    if (cwd && rec.cwd !== undefined && rec.cwd !== cwd) {
      rec.cwd = cwd;
      touched = true;
    }
    if (!touched) return line;
    changed++;
    return JSON.stringify(rec);
  });
  return { text: out.join('\n'), changed };
}

export function profileUserId() {
  return profile().id;
}
