// 自动化任务：管理 WorkBuddy **原生**的定时任务表（workbuddy.db 的 automations 表）。
//
// 为什么管原生表而不是自己造一个调度器：客户端里有一个常驻的 LocalAutomationScheduler
// （每秒 tick，跑 automation_runs / automation_runtime_state / automation_delivery_outbox
// 这套记录），任务体是「一段 prompt + 模型 + 技能」，到点由官方自己起真实会话去执行。
// 我们用同一个表、同一个约定，任务就能被官方引擎真正跑起来，而不是另起一套旁路。
//
// 约定（从客户端自带的 automation_update 工具描述里核对出来的权威契约）：
//   status        'ACTIVE' | 'PAUSED'
//   schedule_type 'recurring' | 'once'
//   rrule         RFC5545 RRULE，FREQ ∈ MINUTELY|HOURLY|DAILY|WEEKLY|MONTHLY|YEARLY
//                 HOURLY 要 INTERVAL(+可选 BYDAY)；DAILY 要 BYHOUR+BYMINUTE；
//                 WEEKLY 要 BYDAY+BYHOUR+BYMINUTE；MONTHLY 要 BYMONTHDAY+BYHOUR+BYMINUTE；
//                 YEARLY 要 BYMONTH+BYMONTHDAY+BYHOUR+BYMINUTE
//   scheduled_at  once 用，ISO8601
//   cwds          工作目录列表（库里存 JSON 数组）
import * as db from './wbdb.mjs';

export const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const WEEKDAY_ZH = { SU: '周日', MO: '周一', TU: '周二', WE: '周三', TH: '周四', FR: '周五', SA: '周六' };
const FREQS = new Set(['MINUTELY', 'HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);
const MAX_TASKS = 500;
const MAX_PROMPT = 20000;

/* ───────── RRULE 解析 / 生成 ───────── */

export function rruleParse(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('RRULE 为空');
  const parts = new Map();
  for (const seg of raw.split(';')) {
    const eq = seg.indexOf('=');
    if (eq < 0) throw new Error('RRULE 片段缺少 =：' + seg);
    const k = seg.slice(0, eq).trim().toUpperCase();
    const v = seg.slice(eq + 1).trim().toUpperCase();
    if (!k) throw new Error('RRULE 片段缺少键名');
    const arr = parts.get(k) || [];
    arr.push(...v.split(',').map((x) => x.trim()).filter(Boolean));
    parts.set(k, arr);
  }
  const freq = (parts.get('FREQ') || [''])[0];
  if (!FREQS.has(freq)) throw new Error('不支持的 FREQ：' + (freq || '(缺失)'));
  const intOf = (k, def) => {
    const v = (parts.get(k) || [])[0];
    if (v === undefined) return def;
    const n = Number.parseInt(v, 10);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${k} 必须是正整数`);
    return n;
  };
  const rangeList = (k, lo, hi) => {
    const out = [];
    for (const v of parts.get(k) || []) {
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`${k} 取值必须是 ${lo}–${hi}`);
      out.push(n);
    }
    return out;
  };
  const byday = (parts.get('BYDAY') || []).map((d) => {
    const t = String(d).replace(/^[+-]?\d+/, '');
    if (!WEEKDAYS.includes(t)) throw new Error('BYDAY 不是合法的星期：' + d);
    return t;
  });
  const spec = {
    freq,
    interval: intOf('INTERVAL', 1),
    byday,
    bymonthday: rangeList('BYMONTHDAY', 1, 31),
    bymonth: rangeList('BYMONTH', 1, 12),
    byhour: (parts.get('BYHOUR') || ['0'])[0] !== undefined ? rangeList('BYHOUR', 0, 23) : [],
    byminute: (parts.get('BYMINUTE') || ['0'])[0] !== undefined ? rangeList('BYMINUTE', 0, 59) : [],
  };
  if (spec.freq === 'WEEKLY' && !spec.byday.length) throw new Error('WEEKLY 需要 BYDAY');
  if (spec.freq === 'MONTHLY' && !spec.bymonthday.length) throw new Error('MONTHLY 需要 BYMONTHDAY');
  if (spec.freq === 'YEARLY' && (!spec.bymonth.length || !spec.bymonthday.length)) throw new Error('YEARLY 需要 BYMONTH 与 BYMONTHDAY');
  if (spec.freq === 'DAILY' && (!spec.byhour.length || !spec.byminute.length)) throw new Error('DAILY 需要 BYHOUR 与 BYMINUTE');
  if (spec.freq === 'WEEKLY' && (!spec.byhour.length || !spec.byminute.length)) throw new Error('WEEKLY 需要 BYHOUR 与 BYMINUTE');
  if (spec.freq === 'MONTHLY' && (!spec.byhour.length || !spec.byminute.length)) throw new Error('MONTHLY 需要 BYHOUR 与 BYMINUTE');
  if (spec.freq === 'YEARLY' && (!spec.byhour.length || !spec.byminute.length)) throw new Error('YEARLY 需要 BYHOUR 与 BYMINUTE');
  return spec;
}

export function rruleBuild(spec) {
  const freq = String(spec.freq || '').toUpperCase();
  if (!FREQS.has(freq)) throw new Error('不支持的频率：' + spec.freq);
  const parts = [`FREQ=${freq}`];
  const interval = Math.max(1, Number(spec.interval) || 1);
  if (interval > 1) parts.push(`INTERVAL=${interval}`);
  if (freq === 'HOURLY') {
    const days = (spec.byday || []).map((d) => String(d).toUpperCase());
    if (days.length) parts.push(`BYDAY=${days.join(',')}`);
    return parts.join(';');
  }
  if (freq === 'WEEKLY') {
    const days = (spec.byday || []).map((d) => String(d).toUpperCase());
    if (!days.length) throw new Error('WEEKLY 需要选星期');
    parts.push(`BYDAY=${days.join(',')}`);
  }
  if (freq === 'MONTHLY' || freq === 'YEARLY') {
    const md = (spec.bymonthday || []).map(Number).filter((n) => n >= 1 && n <= 31).sort((a, b) => a - b);
    if (!md.length) throw new Error('MONTHLY/YEARLY 需要选日期');
    if (freq === 'YEARLY') {
      const mo = (spec.bymonth || []).map(Number).filter((n) => n >= 1 && n <= 12).sort((a, b) => a - b);
      if (!mo.length) throw new Error('YEARLY 需要选月份');
      parts.push(`BYMONTH=${mo.join(',')}`);
    }
    parts.push(`BYMONTHDAY=${md.join(',')}`);
  } else if (freq === 'DAILY' || freq === 'WEEKLY' || freq === 'YEARLY') {
    /* 已经在上面加过 */
  }
  const hour = Math.max(0, Math.min(23, Number(spec.byhour?.[0] ?? spec.hour ?? 9) || 0));
  const minute = Math.max(0, Math.min(59, Number(spec.byminute?.[0] ?? spec.minute ?? 0) || 0));
  parts.push(`BYHOUR=${hour}`, `BYMINUTE=${minute}`);
  return parts.join(';');
}

/* ───────── 下一次运行时刻（本地时区） ───────── */

const MIN = 60000;

function dayStart(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

// 从 fromMs 起算（含当天/当刻之后）的下一次；最多往后找 5 年。
export function nextRunAt(spec, fromMs = Date.now()) {
  const now = new Date(fromMs);
  const limit = fromMs + 5 * 366 * 86400000;
  const hours = spec.byhour && spec.byhour.length ? spec.byhour : null;
  const minutes = spec.byminute && spec.byminute.length ? spec.byminute : [0];
  const hitHM = (d) => (!hours || hours.includes(d.getHours())) && minutes.includes(d.getMinutes());

  if (spec.freq === 'MINUTELY') {
    return Math.floor(fromMs / MIN) * MIN + spec.interval * MIN;
  }

  if (spec.freq === 'HOURLY') {
    // 分钟固定取 byminute（默认 0）；按 interval 小时对齐
    const step = spec.interval * 60 * MIN;
    let t = Math.floor(fromMs / MIN) * MIN;
    for (let i = 0; i < 20000 && t <= limit; i++) {
      const d = new Date(t);
      const okDay = !spec.byday.length || spec.byday.includes(WEEKDAYS[d.getDay()]);
      if (minutes.includes(d.getMinutes()) && hoursSinceEpoch(t) % spec.interval === 0 && okDay) return t;
      t += MIN;
    }
    return null;
  }

  // 日历型：按天扫（最多 5 年），命中 BYDAY/BYMONTHDAY/月 且时刻匹配
  let day = dayStart(now);
  for (let i = 0; i <= 1830 && day.getTime() <= limit; i++, day = new Date(day.getTime() + 86400000)) {
    if (spec.freq === 'WEEKLY' && spec.byday.length && !spec.byday.includes(WEEKDAYS[day.getDay()])) continue;
    if (spec.freq === 'MONTHLY' && !spec.bymonthday.includes(day.getDate())) continue;
    if (spec.freq === 'YEARLY' && (!spec.bymonth.includes(day.getMonth() + 1) || !spec.bymonthday.includes(day.getDate()))) continue;
    if (spec.freq === 'DAILY' && spec.interval > 1) {
      const base = dayStart(new Date(0));
      const days = Math.round((day.getTime() - base.getTime()) / 86400000);
      if (days % spec.interval !== 0) continue;
    }
    if (spec.freq === 'WEEKLY' && spec.interval > 1) {
      const weeks = Math.floor((day.getTime() - dayStart(new Date(1970, 0, 4)).getTime()) / (7 * 86400000));
      if (weeks % spec.interval !== 0) continue;
    }
    for (const h of hours || [0]) {
      for (const m of minutes) {
        const cand = new Date(day);
        cand.setHours(h, m, 0, 0);
        if (cand.getTime() > fromMs && cand.getTime() <= limit) return cand.getTime();
      }
    }
  }
  return null;
}

function hoursSinceEpoch(ms) {
  return Math.floor(ms / 3600000);
}

export function describeSchedule(task) {
  if (!task) return '';
  if (task.scheduleType === 'once') return task.scheduledAt ? `一次 · ${String(task.scheduledAt).replace('T', ' ')}` : '一次';
  if (!task.rrule) return '未设置';
  let spec;
  try {
    spec = rruleParse(task.rrule);
  } catch {
    return task.rrule;
  }
  const hm = `${String(spec.byhour[0] ?? 9).padStart(2, '0')}:${String(spec.byminute[0] ?? 0).padStart(2, '0')}`;
  switch (spec.freq) {
    case 'MINUTELY':
      return `每 ${spec.interval} 分钟`;
    case 'HOURLY':
      return spec.byday.length ? `每 ${spec.interval} 小时（${spec.byday.map((d) => WEEKDAY_ZH[d]).join('、')}）` : `每 ${spec.interval} 小时`;
    case 'DAILY':
      return spec.interval > 1 ? `每 ${spec.interval} 天 ${hm}` : `每天 ${hm}`;
    case 'WEEKLY':
      return `${spec.interval > 1 ? `每 ${spec.interval} 周` : '每周'} ${spec.byday.map((d) => WEEKDAY_ZH[d]).join('、')} ${hm}`;
    case 'MONTHLY':
      return `每月 ${spec.bymonthday.join('、')} 日 ${hm}`;
    case 'YEARLY':
      return `每年 ${spec.bymonth.join('、')} 月 ${spec.bymonthday.join('、')} 日 ${hm}`;
    default:
      return task.rrule;
  }
}

/* ───────── 校验 ───────── */

function str(v, field, max, { required = false } = {}) {
  if (v === undefined || v === null) {
    if (required) throw new Error(`${field} 不能为空`);
    return undefined;
  }
  const s = String(v);
  if (s.length > max) throw new Error(`${field} 太长（上限 ${max} 字符）`);
  return s;
}

export function normalize(input, existing) {
  const base = { ...(existing || {}) };
  const merge = (k) => (input[k] !== undefined ? input[k] : base[k]);
  const out = { ...base };
  out.name = str(merge('name'), '任务名', 120, { required: true }).trim();
  out.prompt = str(merge('prompt'), '提示词', MAX_PROMPT, { required: true }).trim();
  const status = String(merge('status') || 'ACTIVE').toUpperCase();
  if (!['ACTIVE', 'PAUSED'].includes(status)) throw new Error('状态只能是 ACTIVE 或 PAUSED');
  out.status = status;
  const scheduleType = String(merge('scheduleType') || 'recurring').toLowerCase();
  if (!['recurring', 'once'].includes(scheduleType)) throw new Error('计划类型只能是 recurring 或 once');
  out.scheduleType = scheduleType;
  if (scheduleType === 'recurring') {
    const rrule = str(merge('rrule'), 'RRULE', 500, { required: true });
    rruleParse(rrule); // 校验
    out.rrule = rrule;
    out.scheduledAt = null;
  } else {
    const at = str(merge('scheduledAt'), '执行时间', 60, { required: true });
    const t = Date.parse(at);
    if (!Number.isFinite(t)) throw new Error('执行时间不是合法的 ISO 时间');
    out.scheduledAt = at;
    out.rrule = '';
  }
  const cwds = merge('cwds');
  out.cwds = Array.isArray(cwds) ? cwds.filter((x) => typeof x === 'string' && x.trim()).slice(0, 20) : [];
  out.validFrom = merge('validFrom') ? str(merge('validFrom'), '生效自', 60) : null;
  out.validUntil = merge('validUntil') ? str(merge('validUntil'), '生效至', 60) : null;
  out.modelId = merge('modelId') ? str(merge('modelId'), '模型', 200) : null;
  out.modelIsThinking = !!merge('modelIsThinking');
  out.pushToWeChat = !!merge('pushToWeChat');
  out.skills = Array.isArray(merge('skills')) ? merge('skills').filter((x) => typeof x === 'string').slice(0, 40) : [];
  out.permissionMode = merge('permissionMode') ? str(merge('permissionMode'), '权限模式', 40) : null;
  return out;
}

/* ───────── 读写任务 ───────── */

function rowsFromDb() {
  return db.all(
    `SELECT a.id, a.name, a.prompt, a.status, a.schedule_type, a.next_run_at, a.last_run_at, a.cwds,
            a.rrule, a.scheduled_at, a.valid_from, a.valid_until, a.model_id, a.model_is_thinking,
            a.skills_json, a.push_to_wechat, a.owner_user_id, a.owner_status, a.owner_source,
            a.permission_mode, a.created_at, a.updated_at, a.deleted_at,
            r.last_run_at AS rt_last_run, r.last_error AS rt_last_error, r.running AS rt_running,
            r.running_started_at AS rt_started
       FROM automations a
       LEFT JOIN automation_runtime_state r ON r.automation_id = a.id
      WHERE a.deleted_at IS NULL
      ORDER BY COALESCE(a.next_run_at, a.updated_at) ASC`,
  );
}

function parseJson(text, fallback) {
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function shape(r) {
  const task = {
    id: r.id,
    name: r.name,
    prompt: r.prompt,
    status: r.status,
    scheduleType: r.schedule_type || 'recurring',
    nextRunAt: r.next_run_at ?? null,
    lastRunAt: r.last_run_at ?? null,
    cwds: parseJson(r.cwds, []),
    rrule: r.rrule || '',
    scheduledAt: r.scheduled_at || null,
    validFrom: r.valid_from || null,
    validUntil: r.valid_until || null,
    modelId: r.model_id || null,
    modelIsThinking: !!r.model_is_thinking,
    skills: parseJson(r.skills_json, []),
    pushToWeChat: !!r.push_to_wechat,
    permissionMode: r.permission_mode || null,
    ownerUid: r.owner_user_id || null,
    ownerStatus: r.owner_status || 'legacy_unassigned',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  task.running = !!r.rt_running;
  task.runtimeLastRunAt = r.rt_last_run ?? null;
  task.lastError = r.rt_last_error || null;
  task.description = describeSchedule(task);
  return task;
}

export function list({ runsLimit = 30 } = {}) {
  if (!db.hasDb()) return { ok: false, error: '找不到 WorkBuddy 数据库', tasks: [], runs: [] };
  let tasks = [];
  try {
    tasks = rowsFromDb().map(shape);
  } catch (e) {
    return { ok: false, error: e.message, tasks: [], runs: [] };
  }
  return { ok: true, tasks, runs: runs(runsLimit), backend: db.status() };
}

export function runs(limit = 30) {
  try {
    const rows = db.all(
      `SELECT thread_id, automation_id, status, thread_title, source_cwd, result_success, runs_json,
              failure_code, reason_code, read_at, created_at, updated_at
         FROM automation_runs ORDER BY created_at DESC LIMIT ?`,
      [Math.max(1, Math.min(200, Number(limit) || 30))],
    );
    const byId = new Map();
    try {
      for (const a of db.all('SELECT id, name FROM automations')) byId.set(a.id, a.name);
    } catch {
      /* 忽略 */
    }
    return rows.map((r) => ({
      id: r.thread_id,
      automationId: r.automation_id,
      automationName: byId.get(r.automation_id) || null,
      status: r.status,
      title: r.thread_title || null,
      cwd: r.source_cwd || null,
      success: r.result_success == null ? null : !!r.result_success,
      failureCode: r.failure_code || null,
      reasonCode: r.reason_code || null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      runs: parseJson(r.runs_json, []),
    }));
  } catch {
    return [];
  }
}

// 写库：只写本表存在的列，未知列自动跳过（客户端升级加列不会把我们卡住）
function writeRow(values, cols) {
  const picked = Object.keys(values).filter((k) => cols.includes(k));
  return { picked, params: picked.map((k) => values[k]) };
}

export function save(input, id, { uid = null } = {}) {
  if (!db.hasDb()) throw new Error('找不到 WorkBuddy 数据库');
  const cols = db.columns('automations');
  const now = Date.now();
  if (id) {
    const cur = db.get('SELECT * FROM automations WHERE id = ?', [id]);
    if (!cur) throw new Error('没有这个任务');
    const task = normalize(input, {
      name: cur.name,
      prompt: cur.prompt,
      status: cur.status,
      scheduleType: cur.schedule_type,
      rrule: cur.rrule,
      scheduledAt: cur.scheduled_at,
      cwds: parseJson(cur.cwds, []),
      validFrom: cur.valid_from,
      validUntil: cur.valid_until,
      modelId: cur.model_id,
      modelIsThinking: !!cur.model_is_thinking,
      pushToWeChat: !!cur.push_to_wechat,
      skills: parseJson(cur.skills_json, []),
      permissionMode: cur.permission_mode,
    });
    const next = computeNext(task, now);
    const values = {
      name: task.name,
      prompt: task.prompt,
      status: task.status,
      schedule_type: task.scheduleType,
      rrule: task.rrule,
      scheduled_at: task.scheduledAt,
      cwds: JSON.stringify(task.cwds),
      valid_from: task.validFrom,
      valid_until: task.validUntil,
      model_id: task.modelId,
      model_is_thinking: task.modelIsThinking ? 1 : 0,
      skills_json: JSON.stringify(task.skills),
      push_to_wechat: task.pushToWeChat ? 1 : 0,
      permission_mode: task.permissionMode,
      next_run_at: next,
      updated_at: now,
    };
    const { picked, params } = writeRow(values, cols);
    db.run(`UPDATE automations SET ${picked.map((k) => `${k}=?`).join(',')} WHERE id = ?`, [...params, id]);
    return { ok: true, id, task: shape(db.get('SELECT * FROM automations WHERE id=?', [id])), nextRunAt: next };
  }
  const task = normalize(input, { status: 'ACTIVE' });
  if (db.get('SELECT COUNT(*) AS n FROM automations WHERE deleted_at IS NULL').n >= MAX_TASKS) {
    throw new Error(`任务数量已达上限（${MAX_TASKS}）`);
  }
  const newId = `fb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const next = computeNext(task, now);
  const values = {
    id: newId,
    name: task.name,
    prompt: task.prompt,
    status: task.status,
    schedule_type: task.scheduleType,
    rrule: task.rrule,
    scheduled_at: task.scheduledAt,
    next_run_at: next,
    last_run_at: null,
    cwds: JSON.stringify(task.cwds),
    valid_from: task.validFrom,
    valid_until: task.validUntil,
    model_id: task.modelId,
    model_is_thinking: task.modelIsThinking ? 1 : 0,
    skills_json: JSON.stringify(task.skills),
    push_to_wechat: task.pushToWeChat ? 1 : 0,
    permission_mode: task.permissionMode,
    owner_user_id: uid || null,
    owner_status: 'legacy_unassigned',
    owner_source: 'freebuddy',
    created_at: now,
    updated_at: now,
  };
  const { picked, params } = writeRow(values, cols);
  db.run(`INSERT INTO automations (${picked.join(',')}) VALUES (${picked.map(() => '?').join(',')})`, params);
  return { ok: true, id: newId, task: shape(db.get('SELECT * FROM automations WHERE id=?', [newId])), nextRunAt: next };
}

function computeNext(task, fromMs) {
  if (task.status !== 'ACTIVE') return null;
  if (task.scheduleType === 'once') {
    const t = Date.parse(task.scheduledAt);
    return Number.isFinite(t) && t > fromMs ? t : Number.isFinite(t) ? t : null;
  }
  try {
    return nextRunAt(rruleParse(task.rrule), fromMs);
  } catch {
    return null;
  }
}

export function setEnabled(id, enabled) {
  const cur = db.get('SELECT * FROM automations WHERE id = ?', [id]);
  if (!cur) throw new Error('没有这个任务');
  const status = enabled ? 'ACTIVE' : 'PAUSED';
  const now = Date.now();
  const task = {
    name: cur.name,
    prompt: cur.prompt,
    status,
    scheduleType: cur.schedule_type,
    rrule: cur.rrule,
    scheduledAt: cur.scheduled_at,
    cwds: parseJson(cur.cwds, []),
  };
  const next = enabled ? computeNext(task, now) : null;
  db.run('UPDATE automations SET status=?, next_run_at=?, updated_at=? WHERE id=?', [status, next, now, id]);
  return { ok: true, id, status, nextRunAt: next };
}

// 「立即执行」：把 next_run_at 置为当下，官方调度器下一跳就会派发。
// （客户端自己的 manualExecutionOwnership 就是靠这张表的 next_run_at/runtime_state 协作的。）
export function runNow(id) {
  const cur = db.get('SELECT * FROM automations WHERE id = ? AND deleted_at IS NULL', [id]);
  if (!cur) throw new Error('没有这个任务');
  const now = Date.now();
  db.run('UPDATE automations SET next_run_at=?, updated_at=? WHERE id=?', [now, now, id]);
  return { ok: true, id, nextRunAt: now, note: '已排入队列，由客户端调度器执行' };
}

export function remove(ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).map(String);
  const now = Date.now();
  let n = 0;
  for (const id of list) {
    const r = db.run('UPDATE automations SET deleted_at=?, status=?, next_run_at=NULL, updated_at=? WHERE id=? AND deleted_at IS NULL', [
      now,
      'PAUSED',
      now,
      id,
    ]);
    n += r.changes;
    try {
      db.run('DELETE FROM automation_runtime_state WHERE automation_id=?', [id]);
    } catch {
      /* 表可能不存在 */
    }
  }
  return { ok: true, removed: n };
}

export function clearRuns() {
  try {
    const r = db.run('DELETE FROM automation_runs');
    return { ok: true, removed: r.changes };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* ───────── 开局模板 ───────── */

export function templates() {
  const now = new Date();
  const y = now.getFullYear();
  return [
    {
      key: 'daily-brief',
      name: '每日工作简报',
      prompt: '汇总我昨天到今天的工作：看一下当前工作目录里的项目，列出完成项、待办项和今天最该推进的三件事。用中文，控制在 200 字以内。',
      scheduleType: 'recurring',
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
      description: '每天 09:00 生成工作简报',
    },
    {
      key: 'weekly-review',
      name: '周五收尾总结',
      prompt: '把本周做的事整理成一份周报：本周产出、遇到的问题、下周计划。用中文，条列式。',
      scheduleType: 'recurring',
      rrule: 'FREQ=WEEKLY;BYDAY=FR;BYHOUR=18;BYMINUTE=0',
      description: '每周五 18:00 出周报',
    },
    {
      key: 'hourly-slack',
      name: '定时巡检提醒',
      prompt: '检查当前工作目录是否有未提交的改动或异常文件，若有就列出来并给出处理建议；没有就回一句「一切正常」。',
      scheduleType: 'recurring',
      rrule: 'FREQ=HOURLY;INTERVAL=2',
      description: '每 2 小时巡检一次工作目录',
    },
    {
      key: 'monthly-clean',
      name: '月度整理',
      prompt: '梳理上个月的产物目录，找出可以归档或删除的临时文件，列一份清单给我确认（不要直接删）。',
      scheduleType: 'recurring',
      rrule: 'FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=10;BYMINUTE=0',
      description: '每月 1 日 10:00 清理清单',
    },
    {
      key: 'once-reminder',
      name: `一次性提醒（${y}）`,
      prompt: '提醒我：这是一个一次性任务，请汇报当前工作目录的状态。',
      scheduleType: 'once',
      scheduledAt: `${y}-12-31T18:00`,
      description: '只在指定时刻跑一次',
    },
  ];
}
