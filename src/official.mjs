// 官方数据取数：不自己拼 token，而是让**渲染进程用它自带的已鉴权 HTTP 客户端**去请求官方接口。
// 好处：登录态由 WorkBuddy 自己维护，我们既不落 token，也不做静态加密的解密。
import { profile } from './config.mjs';

function evalCall(spec) {
  const args = [JSON.stringify(spec.url)];
  if (spec.body !== undefined) args.push(JSON.stringify(spec.body));
  return `(async () => {
    try {
      if (!window.wb || !window.wb.http || typeof window.wb.http.${spec.method} !== 'function') {
        return JSON.stringify({ ok: false, error: 'wb.http 不可用（客户端版本不支持或页面未就绪）' });
      }
      var r = await window.wb.http.${spec.method}(${args.join(', ')});
      var d = r && r.data !== undefined ? r.data : r;
      return JSON.stringify({ ok: true, status: (r && r.status) || 200, data: d });
    } catch (e) {
      return JSON.stringify({ ok: false, error: String((e && (e.message || e)) || e) });
    }
  })()`;
}

async function call(session, spec) {
  const raw = await session.evaluate(evalCall(spec), { awaitPromise: true });
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('渲染进程返回了不可解析的结果');
  }
  if (!parsed.ok) throw new Error(parsed.error || '官方接口调用失败');
  return parsed.data;
}

function get(session, path) {
  return call(session, { method: 'get', url: profile().apiHost + path });
}
function post(session, path, body) {
  return call(session, { method: 'post', url: profile().apiHost + path, body });
}

export function getStreak(session) {
  return get(session, '/activity/growth/streak');
}

export function getHeatmap(session) {
  return get(session, '/activity/growth/heatmap');
}

export function getGrowthTasks(session) {
  return get(session, '/v2/activity/growth/tasks').catch(() => get(session, '/activity/growth/tasks'));
}

export function getResource(session) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const begin = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  return post(session, '/v2/billing/meter/get-user-resource', {
    PageNumber: 1,
    PageSize: 100,
    ProductCode: 'p_tcaca',
    Status: [0, 3],
    PackageEndTimeRangeBegin: begin,
    PackageEndTimeRangeEnd: '2126-01-01 00:00:00',
  });
}

export function dailyCheckin(session) {
  return post(session, '/billing/meter/daily-checkin', {});
}

// 「已签到」时官方返回 HTTP 400 + code 10001；渲染进程那条通道用的 axios 会直接抛错，
// 所以这里把响应体从异常里捞出来交给调用方判断。
// 注意：配置里不能带函数（validateStatus 之类）—— 参数要过 IPC 的结构化克隆，函数过不去。
export async function checkinViaRenderer(session) {
  const host = profile().apiHost;
  const expr = `(async () => {
    try {
      var res = await window.wb.http.post(${JSON.stringify(host)} + '/billing/meter/daily-checkin', {});
      return JSON.stringify({ ok: true, status: (res && res.status) || 200, body: (res && res.data) || null });
    } catch (e) {
      var r = e && e.response;
      var b = (r && r.data) || null;
      return JSON.stringify({ ok: !!b, status: (r && r.status) || 0, body: b, error: b ? null : String((e && (e.message || e)) || e) });
    }
  })()`;
  const raw = await session.evaluate(expr, { awaitPromise: true });
  try {
    return JSON.parse(raw);
  } catch {
    return { ok: false, error: '渲染进程返回不可解析的结果' };
  }
}

/* ───────── 归一化 ───────── */

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// 官方不同通道返回的包裹层数不一样（渲染进程给 {Response:{Data:{...}}}，
// 直连给 {code,data:{Response:{Data:{...}}}}），所以按结构往下找而不是写死路径。
function findArray(res, key) {
  const seen = new Set();
  const stack = [res];
  let guard = 0;
  while (stack.length && guard++ < 200) {
    const cur = stack.shift();
    if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
    seen.add(cur);
    if (Array.isArray(cur[key])) return cur[key];
    for (const k of Object.keys(cur)) {
      const v = cur[k];
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  return [];
}

// 把官方资源列表折成「剩余 / 总量 / 分段」
export function summarizeResource(res) {
  const accounts = findArray(res, 'Accounts');
  const segments = [];
  let remain = 0;
  let total = 0;
  for (const a of accounts) {
    const r = num(a.CapacityRemainPrecise ?? a.CycleCapacityRemainPrecise ?? a.CapacityRemain ?? a.CycleCapacityRemain);
    const s = num(a.CapacitySizePrecise ?? a.CycleCapacitySizePrecise ?? a.CapacitySize ?? a.CycleCapacitySize);
    if (r <= 0 && s <= 0) continue;
    remain += r;
    total += Math.max(s, r);
    segments.push({
      name: a.PackageName || a.SubProductName || '资源包',
      remain: r,
      size: Math.max(s, r),
      expiresAt: a.CycleEndTime || a.ExpiredTime || null,
      cycleStart: a.CycleStartTime || null,
      cycleEnd: a.CycleEndTime || null,
    });
  }
  segments.sort((a, b) => String(a.expiresAt || '9999').localeCompare(String(b.expiresAt || '9999')));
  return {
    remain,
    total: Math.max(total, remain),
    count: segments.length,
    segments,
    unlimited: false,
  };
}

export function summarizeStreak(res) {
  const s = res?.streak || {};
  const r = res?.redemption_status || {};
  return {
    days: num(s.days),
    monthTotal: num(s.month_total_days),
    nextTier: s.next_tier || null,
    nextTierRemaining: num(s.next_tier_remaining),
    makeupCards: num(res?.makeup_cards?.balance),
    tiers: Array.isArray(r.tiers)
      ? r.tiers.map((t) => ({
          tier: t.tier,
          days: num(t.days),
          credit: num(t.credit),
          energy: num(t.energy),
          status: r[`tier_${t.tier}_status`] || 'unknown',
        }))
      : [],
  };
}

export function summarizeHeatmap(res) {
  const cells = Array.isArray(res?.cells) ? res.cells : [];
  const today = res?.today || null;
  const last = cells.length ? cells[cells.length - 1] : null;
  return {
    todayScore: num(today?.score ?? last?.score),
    todayDate: today?.date || last?.date || null,
    todayActive: today ? !!today.is_active : num(last?.score) > 0,
    activeDays30: cells.slice(-30).filter((c) => num(c.score) > 0).length,
  };
}

export function summarizeTasks(res) {
  const tasks = Array.isArray(res?.tasks) ? res.tasks : [];
  const open = tasks.filter((t) => t.accept_status !== 'claimed' && !t.locked);
  return {
    total: tasks.length,
    done: tasks.filter((t) => t.accept_status === 'claimed').length,
    pendingCredit: open.reduce((a, t) => a + num(t.reward_credit), 0),
    pendingEnergy: open.reduce((a, t) => a + num(t.reward_energy), 0),
  };
}

// 一次拉齐当前账号的官方数据（走渲染进程，用客户端自己的登录态）
export async function pullCurrent(session) {
  const out = { at: Date.now() };
  const results = await Promise.allSettled([
    getResource(session).then((r) => {
      out.credits = summarizeResource(r);
    }),
    getStreak(session).then((r) => {
      out.streak = summarizeStreak(r);
    }),
    getHeatmap(session).then((r) => {
      out.activity = summarizeHeatmap(r);
    }),
    getGrowthTasks(session).then((r) => {
      out.tasks = summarizeTasks(r);
    }),
  ]);
  out.errors = results.filter((r) => r.status === 'rejected').map((r) => String(r.reason?.message || r.reason));
  return out;
}

/* ───────── 直连官方接口（用于那些 token 还是明文的账号备份） ───────── */

function headers(token) {
  const host = profile().apiHost;
  return {
    authorization: `Bearer ${token}`,
    'x-client-platform': 'web',
    origin: host,
    referer: `${host}/profile/plans-usage`,
    'content-type': 'application/json',
    accept: 'application/json, text/plain, */*',
  };
}

async function httpJson(url, init, timeoutMs = 12000) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 400) };
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

// 用 refreshToken 换新的 accessToken；官方刷新端点需要 X-Refresh-Token 头
export async function refreshAccess(accessToken, refreshToken) {
  const host = profile().apiHost;
  const h = headers(accessToken || '');
  h['X-Refresh-Token'] = refreshToken;
  const body = await httpJson(`${host}/v2/plugin/auth/token/refresh`, { method: 'POST', headers: h, body: '{}' });
  const d = body?.data || body?.Data || {};
  const next = {
    accessToken: d.accessToken || d.access_token || d.AccessToken || null,
    refreshToken: d.refreshToken || d.refresh_token || refreshToken,
    expiresAt: d.expiresAt || d.expires_at || (d.expiresIn ? Date.now() + Number(d.expiresIn) * 1000 : null),
    refreshExpiresAt: d.refreshExpiresAt || d.refresh_expires_at || null,
    lastRefreshTime: Date.now(),
  };
  if (!next.accessToken) throw new Error('刷新登录态失败：响应里没有 accessToken');
  return next;
}

export async function resourceDirect(token) {
  const host = profile().apiHost;
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const begin = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  return httpJson(`${host}/v2/billing/meter/get-user-resource`, {
    method: 'POST',
    headers: headers(token),
    body: JSON.stringify({
      PageNumber: 1,
      PageSize: 100,
      ProductCode: 'p_tcaca',
      Status: [0, 3],
      PackageEndTimeRangeBegin: begin,
      PackageEndTimeRangeEnd: '2126-01-01 00:00:00',
    }),
  });
}

export async function streakDirect(token) {
  const host = profile().apiHost;
  return httpJson(`${host}/activity/growth/streak`, { method: 'GET', headers: headers(token) });
}

export async function heatmapDirect(token) {
  const host = profile().apiHost;
  return httpJson(`${host}/activity/growth/heatmap`, { method: 'GET', headers: headers(token) });
}

// 签到接口在「今天已签到」时返回 HTTP 400 + code 10001，所以这里不按 HTTP 状态抛错，
// 而是把状态码与响应体一起交回调用方判定。
export async function checkinDirect(token) {
  const host = profile().apiHost;
  const res = await fetch(`${host}/billing/meter/daily-checkin`, {
    method: 'POST',
    headers: headers(token),
    body: '{}',
    signal: AbortSignal.timeout(12000),
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 300) };
  }
  return { status: res.status, body };
}

// 某个账号备份（明文 token）的一次性取数
export async function pullWithToken(token) {
  const out = {};
  const results = await Promise.allSettled([
    resourceDirect(token).then((r) => {
      out.credits = summarizeResource(r);
    }),
    streakDirect(token).then((r) => {
      out.streak = summarizeStreak(r);
    }),
    heatmapDirect(token).then((r) => {
      out.activity = summarizeHeatmap(r);
    }),
  ]);
  out.errors = results.filter((r) => r.status === 'rejected').map((r) => String(r.reason?.message || r.reason));
  out.at = Date.now();
  return out;
}
