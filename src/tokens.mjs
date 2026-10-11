// Token 用量统计：只读本机 WorkBuddy 的会话记录（projects/**/*.jsonl），
// 按天汇总输入/输出/缓存写入 token，供面板画活动热力图。不联网、不上传。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { workBuddyUserData, dataDir } from './config.mjs';

const SKIP_NAME = new Set(['subagents', 'modify_backup', '.modify_backup_meta', 'node_modules']);
const CACHE_FILE = () => path.join(dataDir(), 'token-stats-cache.json');
const MAX_FILES = 4000;
const MAX_FILE_BYTES = 32 * 1024 * 1024;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n && n > 0 ? n : 0) ? Math.max(0, n) : 0;
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj[k] != null) return num(obj[k]);
  }
  return 0;
}

// 一条记录里 usage 藏在不同层级（providerData.usage / message.usage / 顶层 usage…），
// 所以按深度找「第一个含 token 字段的对象」；同一条记录只算一次，避免重复计数。
const TOKEN_KEYS = [
  'input_tokens',
  'inputTokens',
  'prompt_tokens',
  'promptTokens',
  'output_tokens',
  'outputTokens',
  'completion_tokens',
  'completionTokens',
  'cache_creation_input_tokens',
  'cacheCreationInputTokens',
  'cache_read_input_tokens',
  'cacheReadInputTokens',
  'total_tokens',
  'totalTokens',
];

function looksLikeUsage(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return TOKEN_KEYS.some((k) => v[k] != null);
}

function findFirstUsage(node, depth, maxDepth) {
  if (!node || typeof node !== 'object' || depth > maxDepth) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const r = findFirstUsage(item, depth + 1, maxDepth);
      if (r) return r;
    }
    return null;
  }
  if (looksLikeUsage(node)) return node;
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (v && typeof v === 'object') {
      const r = findFirstUsage(v, depth + 1, maxDepth);
      if (r) return r;
    }
  }
  return null;
}

function toUsage(c) {
  const input = pick(c, ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens']);
  const output = pick(c, ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens']);
  const cacheWrite = pick(c, ['cache_creation_input_tokens', 'cacheCreationInputTokens', 'cache_write_input_tokens', 'cacheWriteInputTokens']);
  let cacheRead = pick(c, ['cache_read_input_tokens', 'cacheReadInputTokens', 'cached_tokens', 'cacheReadTokens']);
  // 有的记录把缓存命中放在数组细节里：inputTokensDetails:[{cached_tokens:n}]
  if (!cacheRead && Array.isArray(c.inputTokensDetails)) {
    cacheRead = c.inputTokensDetails.reduce((a, d) => a + num(d && d.cached_tokens), 0);
  }
  const totalTokens = pick(c, ['total_tokens', 'totalTokens']);
  const total = input + output + cacheWrite || totalTokens;
  if (!total) return null;
  return { input, output, cacheWrite, cacheRead, total };
}

// 优先 providerData.usage（官方口径），再退到别处
function extractUsage(record) {
  const preferred = [];
  if (record && record.providerData && record.providerData.usage) preferred.push(record.providerData.usage);
  if (record && record.usage) preferred.push(record.usage);
  for (const p of preferred) {
    if (looksLikeUsage(p)) {
      const u = toUsage(p);
      if (u) return u;
    }
  }
  const found = findFirstUsage(record, 0, 4);
  return found ? toUsage(found) : null;
}

function recordTime(record, fallbackMs) {
  const keys = ['timestamp', 'time', 'createdAt', 'created_at', 'ts', 'date'];
  for (const k of keys) {
    const v = record[k];
    if (v == null) continue;
    if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
    const t = Date.parse(String(v));
    if (Number.isFinite(t)) return t;
  }
  return fallbackMs;
}

function dayKey(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function walk(dir, out, budget) {
  if (out.length >= MAX_FILES || budget.left <= 0) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= MAX_FILES) return;
    const full = path.join(dir, e.name);
    if (e.name.startsWith('.') || SKIP_NAME.has(e.name)) continue;
    if (e.isDirectory()) walk(full, out, budget);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
  }
}

export function scan({ force = false } = {}) {
  if (!force) {
    try {
      const cached = JSON.parse(fs.readFileSync(CACHE_FILE(), 'utf8'));
      if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.stats;
    } catch {
      /* 没有缓存 */
    }
  }

  const root = path.join(workBuddyUserData(), 'projects');
  const files = [];
  walk(root, files, { left: MAX_FILES });

  const days = new Map();
  const seenLines = new Set();
  const models = new Map();
  let fileCount = 0;
  let recordCount = 0;

  for (const f of files) {
    let stat;
    try {
      stat = fs.statSync(f);
    } catch {
      continue;
    }
    if (stat.size > MAX_FILE_BYTES) continue;
    fileCount++;
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    const fallback = stat.mtimeMs;
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (!s || s.length > 2_000_000) continue;
      let record;
      try {
        record = JSON.parse(s);
      } catch {
        continue;
      }
      const usage = extractUsage(record);
      if (!usage) continue;
      recordCount++;
      // 同一条记录被复制进多个文件时只算一次
      const h = crypto.createHash('sha1').update(s).digest('hex');
      if (seenLines.has(h)) continue;
      seenLines.add(h);

      const day = dayKey(recordTime(record, fallback));
      const cur = days.get(day) || { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, records: 0 };
      cur.input += usage.input;
      cur.output += usage.output;
      cur.cacheWrite += usage.cacheWrite;
      cur.cacheRead += usage.cacheRead;
      cur.total += usage.total;
      cur.records += 1;
      days.set(day, cur);

      const model = record.model || record.modelName || record.model_name || (record.usage && record.usage.model) || null;
      if (model) {
        const m = models.get(model) || { model, total: 0, records: 0 };
        m.total += usage.total;
        m.records += 1;
        models.set(model, m);
      }
    }
  }

  const daily = [...days.entries()]
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const totals = daily.reduce(
    (a, d) => ({
      input: a.input + d.input,
      output: a.output + d.output,
      cacheWrite: a.cacheWrite + d.cacheWrite,
      cacheRead: a.cacheRead + d.cacheRead,
      total: a.total + d.total,
      records: a.records + d.records,
    }),
    { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, records: 0 },
  );

  const peak = daily.reduce((m, d) => (d.total > (m?.total || 0) ? d : m), null);

  // 连续天数：从今天往前数（今天为空则从昨天起算）
  const byDate = new Map(daily.map((d) => [d.date, d]));
  const today = dayKey(Date.now());
  const yesterday = dayKey(Date.now() - 86400000);
  let current = 0;
  let cursor = byDate.has(today) ? Date.now() : byDate.has(yesterday) ? Date.now() - 86400000 : null;
  if (cursor != null) {
    while (byDate.has(dayKey(cursor))) {
      current++;
      cursor -= 86400000;
    }
  }
  let longest = 0;
  let run = 0;
  let prev = null;
  for (const d of daily) {
    const t = Date.parse(d.date + 'T00:00:00');
    if (prev != null && t - prev === 86400000) run++;
    else run = 1;
    prev = t;
    if (run > longest) longest = run;
  }

  const stats = {
    at: Date.now(),
    fileCount,
    recordCount,
    daily,
    totals,
    peak: peak ? { date: peak.date, total: peak.total } : null,
    currentStreak: current,
    longestStreak: longest,
    models: [...models.values()].sort((a, b) => b.total - a.total).slice(0, 8),
    source: root,
  };
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(CACHE_FILE(), JSON.stringify({ at: Date.now(), stats }), { mode: 0o600 });
  } catch {
    /* 缓存失败不影响返回 */
  }
  return stats;
}
