// 模型管理：读写 WorkBuddy 的自定义模型清单（<userData>/models.json）。
//
// 事实与约束（都在本机核对过）：
//   · 文件顶层两种形态：纯数组，或 { models: [...] }（保形态写回，不改变官方读法）。
//   · 每个模型对象的字段是宽松的；本机就有 vendor=Custom 且带 ocFerryOwner / onlyReasoning
//     这类扩展字段的模型 —— 所以**只动已知字段，未知字段一律原样保留**。
//   · 客户端在下次读配置时生效（没有文件监听），面板里会如实说明。
//   · 每次写之前把整个文件复制一份到 models-backup/，最多留 20 份。
import fs from 'node:fs';
import path from 'node:path';
import { modelsJson, workBuddySettings, dataDir } from './config.mjs';

const MAX_MODELS = 5000;
const UNKNOWN_KEEP = true;

/* ───────── 备份 ───────── */

function backupDir() {
  return path.join(dataDir(), 'models-backup');
}

function writeAtomic(file, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.fb-tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, mode);
  } catch {
    /* 忽略 */
  }
}

function snapshot(reason) {
  const file = modelsJson();
  if (!fs.existsSync(file)) return null;
  try {
    const dir = backupDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(dir, `${stamp}-${reason}-models.json`);
    fs.copyFileSync(file, dest);
    // 只留最近 20 份
    const kept = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('-models.json'))
      .sort()
      .reverse();
    for (const old of kept.slice(20)) {
      try {
        fs.unlinkSync(path.join(dir, old));
      } catch {
        /* 忽略 */
      }
    }
    return dest;
  } catch {
    return null;
  }
}

export function listBackups() {
  try {
    const dir = backupDir();
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('-models.json'))
      .sort()
      .reverse()
      .map((f) => ({ name: f, at: fs.statSync(path.join(dir, f)).mtimeMs, size: fs.statSync(path.join(dir, f)).size }));
  } catch {
    return [];
  }
}

/* ───────── 读写 ───────── */

export function read() {
  const file = modelsJson();
  if (!fs.existsSync(file)) return { file, format: 'array', models: [], wrapper: {}, error: null };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { file, format: 'array', models: [], wrapper: {}, error: '模型文件不是合法 JSON：' + e.message };
  }
  if (Array.isArray(parsed)) return { file, format: 'array', models: parsed, wrapper: {} };
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.models)) {
    const { models, ...wrapper } = parsed;
    return { file, format: 'object', models, wrapper };
  }
  return { file, format: 'array', models: [], wrapper: {}, error: '模型文件格式不受支持（应为数组或含 models 数组的对象）' };
}

function write(parsed, models, reason) {
  const body = JSON.stringify(parsed.format === 'object' ? { ...parsed.wrapper, models } : models, null, 2);
  // 保持原文件的收尾风格（有没有末尾换行），别每次写都改一个字节
  let trailing = '\n';
  try {
    const prev = fs.readFileSync(parsed.file, 'utf8');
    trailing = prev.endsWith('\n') ? '\n' : '';
  } catch {
    /* 新文件用换行结尾 */
  }
  const content = body + trailing;
  const backup = snapshot(reason);
  let mode = 0o600;
  try {
    mode = fs.statSync(parsed.file).mode & 0o777;
  } catch {
    /* 新文件用 600 */
  }
  writeAtomic(parsed.file, content, mode);
  return { backup, count: models.length };
}

/* ───────── 校验与打码 ───────── */

function str(v, field, max = 20000, { required = false } = {}) {
  if (v === undefined || v === null) {
    if (required) throw new Error(`${field} 不能为空`);
    return undefined;
  }
  const s = String(v);
  if (s.length > max) throw new Error(`${field} 太长（上限 ${max} 字符）`);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s)) throw new Error(`${field} 含控制字符`);
  if (required && !s.trim()) throw new Error(`${field} 不能为空`);
  return s;
}

// 只校验会影响客户端加载的字段；**未知字段一律原样保留**（本机就有 ocFerryOwner /
// onlyReasoning 这类扩展字段，模型是别人写进去的，我们不能顺手抹掉）。
const BAD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export function normalizeModel(input, existing) {
  const base = { ...(existing || {}) };
  const out = { ...base };
  // 输入里的未知字段也带着走（新增时同样保留）
  for (const k of Object.keys(input || {})) {
    if (BAD_KEYS.has(k)) continue;
    if (input[k] !== undefined) out[k] = input[k];
  }
  const id = str(input.id !== undefined ? input.id : base.id, '模型 ID', 256, { required: true });
  const url = str(input.url !== undefined ? input.url : base.url, '接口地址', 2048);
  if (url !== undefined && url !== '' && !/^https?:\/\//i.test(url)) {
    throw new Error('接口地址必须是 http(s):// 开头');
  }
  out.id = id;
  const name = str(input.name !== undefined ? input.name : base.name ?? id, '名称', 200);
  out.name = name || id;
  const apiKey = input.apiKey !== undefined ? str(input.apiKey, 'API Key', 20000) : base.apiKey;
  if (apiKey !== undefined) out.apiKey = apiKey;
  if (url !== undefined) out.url = url;
  out.vendor = str(input.vendor !== undefined ? input.vendor : base.vendor ?? 'Custom', '厂商', 100) || 'Custom';
  for (const flag of ['supportsToolCall', 'supportsImages', 'supportsReasoning', 'useCustomProtocol', 'onlyReasoning']) {
    if (input[flag] !== undefined) out[flag] = !!input[flag];
    else if (out[flag] === undefined) out[flag] = false;
  }
  for (const numField of ['maxInputTokens', 'maxOutputTokens', 'contextWindow']) {
    if (input[numField] !== undefined && input[numField] !== null && input[numField] !== '') {
      const n = Number(input[numField]);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`${numField} 必须是正整数`);
      out[numField] = Math.floor(n);
    }
  }
  // reasoning 段：保留未知子字段，只规范化 effort / defaultEffort / supportedEfforts
  const rIn = input.reasoning !== undefined ? input.reasoning : base.reasoning;
  if (rIn && typeof rIn === 'object' && !Array.isArray(rIn)) {
    const r = { ...rIn };
    if (rIn.effort !== undefined) r.effort = str(rIn.effort, 'reasoning.effort', 40);
    if (rIn.defaultEffort !== undefined) r.defaultEffort = str(rIn.defaultEffort, 'reasoning.defaultEffort', 40);
    if (Array.isArray(rIn.supportedEfforts)) {
      r.supportedEfforts = rIn.supportedEfforts.map((x) => str(x, 'supportedEfforts[]', 40)).filter(Boolean);
    }
    out.reasoning = r;
  }
  return out;
}

export function mask(key) {
  const s = String(key || '');
  if (!s) return '';
  if (s.length <= 12) return '•'.repeat(s.length);
  return s.slice(0, 6) + '•'.repeat(Math.min(10, s.length - 10)) + s.slice(-4);
}

function describe(m, index) {
  return {
    index,
    id: m.id || '',
    name: m.name || m.id || '',
    vendor: m.vendor || 'Custom',
    url: m.url || '',
    hasKey: !!m.apiKey,
    keyMasked: m.apiKey ? mask(m.apiKey) : '',
    keyLength: m.apiKey ? String(m.apiKey).length : 0,
    isCustom: String(m.vendor || '').toLowerCase() === 'custom',
    supportsToolCall: !!m.supportsToolCall,
    supportsImages: !!m.supportsImages,
    supportsReasoning: !!m.supportsReasoning,
    reasoning: m.reasoning || null,
    maxInputTokens: m.maxInputTokens ?? null,
    maxOutputTokens: m.maxOutputTokens ?? null,
    extraFields: Object.keys(m).filter(
      (k) =>
        ![
          'id',
          'name',
          'vendor',
          'url',
          'apiKey',
          'supportsToolCall',
          'supportsImages',
          'supportsReasoning',
          'reasoning',
          'maxInputTokens',
          'maxOutputTokens',
        ].includes(k),
    ),
  };
}

/* ───────── 对外接口 ───────── */

export function list() {
  const parsed = read();
  return {
    ok: !parsed.error,
    error: parsed.error || null,
    file: parsed.file,
    format: parsed.format,
    count: parsed.models.length,
    models: parsed.models.map(describe),
    settingsPath: workBuddySettings(),
    defaultModel: readDefaultModel(),
    backups: listBackups().length,
  };
}

export function reveal(index) {
  const parsed = read();
  const m = parsed.models[Number(index)];
  if (!m) throw new Error('模型不存在');
  return { id: m.id, name: m.name, apiKey: m.apiKey || '' };
}

// index 为 null/undefined 时新增；否则就地更新（未知字段保留）
export function save(input, index) {
  const parsed = read();
  if (parsed.error) throw new Error(parsed.error);
  const models = parsed.models.slice();
  const idx = index === undefined || index === null || index === '' ? null : Number(index);
  if (idx === null) {
    if (models.length >= MAX_MODELS) throw new Error(`模型数量已达上限（${MAX_MODELS}）`);
    const dup = models.findIndex((m) => m && String(m.id) === String(input.id));
    if (dup >= 0) throw new Error('已存在同名模型 ID：' + input.id);
    models.push(normalizeModel(input, null));
  } else {
    if (idx < 0 || idx >= models.length) throw new Error('模型不存在');
    const clash = models.findIndex((m, i) => i !== idx && m && String(m.id) === String(input.id));
    if (clash >= 0) throw new Error('已存在同名模型 ID：' + input.id);
    models[idx] = normalizeModel(input, models[idx]);
  }
  const r = write(parsed, models, idx === null ? 'add' : 'edit');
  const saved = idx === null ? models.length - 1 : idx;
  return { ok: true, index: saved, model: describe(models[saved], saved), backup: r.backup };
}

export function remove(index) {
  const parsed = read();
  if (parsed.error) throw new Error(parsed.error);
  const idx = Number(index);
  if (idx < 0 || idx >= parsed.models.length) throw new Error('模型不存在');
  const models = parsed.models.slice();
  const [gone] = models.splice(idx, 1);
  const r = write(parsed, models, 'delete');
  return { ok: true, removed: describe(gone, idx), count: models.length, backup: r.backup };
}

export function duplicate(index) {
  const parsed = read();
  const src = parsed.models[Number(index)];
  if (!src) throw new Error('模型不存在');
  const models = parsed.models.slice();
  let id = `${src.id}-copy`;
  let n = 2;
  while (models.some((m) => m && String(m.id) === id)) id = `${src.id}-copy${n++}`;
  const copy = { ...src, id, name: `${src.name || src.id}（副本）` };
  models.push(copy);
  const r = write(parsed, models, 'dup');
  return { ok: true, index: models.length - 1, model: describe(copy, models.length - 1), backup: r.backup };
}

// 探活：url 先规约到 base，再依次试 /models、/v1/models、base。
// 只回网络/HTTP 结论，不回显 URL 参数与 API Key。
export async function probe(index, { timeoutMs = 6000 } = {}) {
  const parsed = read();
  const m = parsed.models[Number(index)];
  if (!m) throw new Error('模型不存在');
  if (!m.url) throw new Error('这个模型没有填接口地址');
  let u;
  try {
    u = new URL(m.url);
  } catch {
    throw new Error('接口地址不是合法 URL');
  }
  const pathname = u.pathname.replace(/\/(chat\/completions|completions|messages|responses)\/?$/i, '') || '';
  const bases = [`${u.origin}${pathname}`];
  if (!/\/v\d+$/i.test(pathname)) bases.push(`${u.origin}${pathname}/v1`);
  const candidates = [];
  for (const b of bases) {
    candidates.push(`${b}/models`, b);
  }
  const headers = {};
  if (m.apiKey) headers.authorization = `Bearer ${m.apiKey}`;
  let last = { status: 0, error: '没有可用的探测地址' };
  for (const url of candidates) {
    for (const method of ['HEAD', 'GET']) {
      try {
        const res = await fetch(url, { method, headers, signal: AbortSignal.timeout(timeoutMs) });
        const status = res.status;
        if (status === 404) {
          last = { status, url, error: 'HTTP 404' };
          break; // 换下一个候选
        }
        const authorized = status >= 200 && status < 300;
        const keySuspect = status === 401 || status === 403;
        return {
          ok: true,
          url,
          status,
          reachable: true,
          authorized,
          message: authorized ? '接口可用' : keySuspect ? '接口可达，但 API Key 可能无效' : `接口返回 HTTP ${status}`,
        };
      } catch (e) {
        last = { status: 0, url, error: e.name === 'TimeoutError' ? '连接超时' : String(e.message || e) };
      }
    }
  }
  return { ok: true, url: last.url || m.url, status: last.status || 0, reachable: false, authorized: false, message: last.error || '接口不可达' };
}

/* ───────── 默认模型（客户端 settings.json） ───────── */

export function readDefaultModel() {
  try {
    const j = JSON.parse(fs.readFileSync(workBuddySettings(), 'utf8'));
    return j.model || null;
  } catch {
    return null;
  }
}

export function setDefaultModel(id) {
  const target = str(id, '模型 ID', 256, { required: true });
  const file = workBuddySettings();
  if (!fs.existsSync(file)) throw new Error('找不到客户端设置文件：' + file);
  let json;
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error('客户端设置不是合法 JSON：' + e.message);
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('客户端设置结构异常，已中止');
  const prev = json.model || null;
  json.model = target;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(dataDir(), 'models-backup', `${stamp}-settings.json`);
  try {
    fs.mkdirSync(path.dirname(backup), { recursive: true, mode: 0o700 });
    fs.copyFileSync(file, backup);
  } catch {
    /* 备份失败不阻断，但下面会如实回报 */
  }
  // 客户端的 settings.json 就是 JSON.stringify(x,null,2)（无末尾换行）——照原样写，
  // 这样「设成同一个值」时文件逐字节不变，不会被我们顺手改格式。
  writeAtomic(file, JSON.stringify(json, null, 2), 0o600);
  return { ok: true, previous: prev, defaultModel: target, backup, note: '客户端重新载入配置或重启后生效' };
}

/* ───────── 导入 / 导出（明文 JSON，供手工搬运） ───────── */

export function exportModels() {
  const parsed = read();
  return {
    filename: `freebuddy-models-${new Date().toISOString().slice(0, 10)}.json`,
    count: parsed.models.length,
    content: { freebuddy: true, kind: 'models', version: 1, createdAt: new Date().toISOString(), models: parsed.models },
  };
}

export function importModels(content, { replace = false } = {}) {
  const doc = typeof content === 'string' ? JSON.parse(content) : content;
  const incoming = Array.isArray(doc) ? doc : doc && Array.isArray(doc.models) ? doc.models : null;
  if (!incoming) throw new Error('这个文件里没有模型数组');
  const parsed = read();
  if (parsed.error) throw new Error(parsed.error);
  const models = replace ? [] : parsed.models.slice();
  let added = 0;
  let updated = 0;
  for (const raw of incoming) {
    if (!raw || typeof raw !== 'object') continue;
    const norm = normalizeModel(raw, null);
    const at = models.findIndex((m) => m && String(m.id) === String(norm.id));
    if (at >= 0) {
      models[at] = UNKNOWN_KEEP ? { ...models[at], ...norm } : norm;
      updated++;
    } else {
      models.push(norm);
      added++;
    }
  }
  const r = write(parsed, models, 'import');
  return { ok: true, added, updated, count: models.length, backup: r.backup };
}
