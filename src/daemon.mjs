// freebuddy 本地守护进程：127.0.0.1 上的控制面。
// 职责：① 发现并连上 WorkBuddy 的 CDP；② 把面板注入渲染进程；③ 暴露本地 API 给面板。
// 只监听回环地址，所有 API 需要本机令牌。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BRAND, VERSION, BUILD_ID, HOST, profile, dataDir, ensureDirs, logFile, exePath, accountFile } from './config.mjs';
import { attach, probePort, listTargets, pickPageTarget, connect } from './cdplink.mjs';
import { injectWidget, destroyWidget } from './injector.mjs';
import * as store from './authstore.mjs';
import * as wbproc from './platform/index.mjs';
import * as loginflow from './loginflow.mjs';
import * as tokens from './tokens.mjs';
import * as checkincache from './checkincache.mjs';
import * as tokencache from './tokencache.mjs';
import * as datacache from './datacache.mjs';
import * as wbdecrypt from './wbdecrypt.mjs';
import * as official from './official.mjs';
import { power } from './platform/index.mjs';
import * as models from './models.mjs';
import * as sessionops from './sessionops.mjs';
import * as automations from './automations.mjs';

const PROFILE = profile();
const startedAt = Date.now();

/* ───────── 日志 ───────── */

let logStream = null;
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
  try {
    if (!logStream) {
      fs.mkdirSync(path.dirname(logFile()), { recursive: true });
      logStream = fs.createWriteStream(logFile(), { flags: 'a' });
    }
    logStream.write(line + '\n');
  } catch {
    /* 日志失败不影响主流程 */
  }
  if (process.env.FB_VERBOSE) console.log(line);
}

/* ───────── 令牌与锁 ───────── */

function tokenPath() {
  return path.join(dataDir(), '.api-token');
}
function lockPath() {
  return path.join(dataDir(), '.daemon.lock');
}

function loadToken() {
  try {
    const t = fs.readFileSync(tokenPath(), 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(t)) return t;
  } catch {
    /* 首次运行 */
  }
  const t = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(tokenPath(), t, { mode: 0o600 });
  return t;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock() {
  try {
    const prev = JSON.parse(fs.readFileSync(lockPath(), 'utf8'));
    if (prev && prev.pid && prev.pid !== process.pid && pidAlive(prev.pid)) {
      return { ok: false, owner: prev };
    }
  } catch {
    /* 无锁或锁损坏 */
  }
  try {
    fs.writeFileSync(lockPath(), JSON.stringify({ pid: process.pid, startedAt, version: VERSION, buildId: BUILD_ID }), { mode: 0o600 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function releaseLock() {
  try {
    const cur = JSON.parse(fs.readFileSync(lockPath(), 'utf8'));
    if (cur && cur.pid === process.pid) fs.unlinkSync(lockPath());
  } catch {
    /* 忽略 */
  }
}

/* ───────── 设置 ───────── */

const DEFAULT_SETTINGS = {
  noDisturb: false,
  autoContinue: false,
  stashPrompt: false,
  quickPhrases: false,
  // 快捷短语：面板里维护，注入到输入框的那个按钮读它
  phrases: [],
  sleepMode: 'allow',
  displaySleep: true,
};

/* ───────── 暂存提示词（待发送队列） ─────────
   面板侧从输入框里把草稿（含内联图片的 HTML）交上来，落一份 JSON。
   刻意放在独立文件而不是 settings.json：草稿可能带 data: 图片，体积和设置不是一个量级。 */

const STASH_LIMIT = 50;
const STASH_ITEM_BYTES = 2 * 1024 * 1024;

function stashPath() {
  return path.join(dataDir(), 'stash.json');
}

function readStash() {
  try {
    const j = JSON.parse(fs.readFileSync(stashPath(), 'utf8'));
    return Array.isArray(j.items) ? j : { items: [] };
  } catch {
    return { items: [] };
  }
}

function writeStash(store) {
  const tmp = `${stashPath()}.fb-tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, stashPath());
  return store;
}

// 每条只留结构化的最小集：正文、HTML（保留内联图片）、以及外部附件的情况
function normalizeStashItem(body) {
  const text = String(body.text || '').slice(0, 200_000);
  let html = String(body.html || '').slice(0, STASH_ITEM_BYTES);
  const files = Array.isArray(body.files)
    ? body.files.slice(0, 20).map((f) => ({
        name: String((f && f.name) || '').slice(0, 200),
        size: Number((f && f.size) || 0) || 0,
        type: String((f && f.type) || '').slice(0, 100),
      }))
    : [];
  if (!text.trim() && !files.length) throw new Error('草稿是空的，没什么可暂存的');
  if (Buffer.byteLength(html, 'utf8') > STASH_ITEM_BYTES) html = '';
  return {
    id: `st_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`,
    at: Date.now(),
    text,
    html,
    files,
    // 记录来源档案，切账号后能看出这条草稿是从哪个账号攒的
    profile: PROFILE.id,
  };
}

function settingsPath() {
  return path.join(dataDir(), 'settings.json');
}

function readSettings() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    /* 首次运行 */
  }
  const p = power.getMode();
  return { ...DEFAULT_SETTINGS, ...raw, sleepMode: p.mode, displaySleep: p.displaySleep };
}

function writeSettings(patch) {
  const merged = { ...readSettings(), ...patch };
  const onDisk = { ...merged };
  delete onDisk.sleepMode;
  delete onDisk.displaySleep;
  fs.writeFileSync(settingsPath(), JSON.stringify(onDisk, null, 2), { mode: 0o600 });
  return readSettings();
}

/* ───────── 账号自动备份 ─────────
   登录态一有变化（换账号、续期、token 更新）就落一份备份，
   所以面板不需要「备份」按钮 —— 让 WorkBuddy 保持登录就够了。 */
let autoBackupState = { uid: null, digest: null };

function autoBackupOnce() {
  let cur;
  try {
    cur = store.readCurrent();
  } catch {
    return;
  }
  if (!cur || !cur.raw) return;
  const digest = crypto.createHash('sha1').update(cur.raw).digest('hex');
  if (autoBackupState.uid === cur.uid && autoBackupState.digest === digest) return;
  try {
    const r = store.backupCurrent(currentSnapshot && currentSnapshot.uid === cur.uid ? currentSnapshot : null);
    autoBackupState = { uid: cur.uid, digest };
    accountCache.clear();
    officialCache = { at: 0, data: null };
    log('自动备份账号', (r.nickname || r.uid || '').slice(0, 14));
  } catch (e) {
    log('自动备份失败', e.message);
  }
}

/* ───────── CDP 会话与注入 ───────── */

let session = null;
let cdpPort = null;
let cdpState = { connected: false, error: null, appVersion: null, lastInjectAt: 0 };
let connectTimer = null;
let officialCache = { at: 0, data: null };
let currentSnapshot = null;

async function ensureSession() {
  if (session && !session.closed) return session;
  const found = await attach(PROFILE.cdpPort);
  if (!found) {
    cdpState = { ...cdpState, connected: false, error: '没有找到带调试端口的 WorkBuddy' };
    return null;
  }
  session = found.session;
  cdpPort = found.port;
  cdpState = { ...cdpState, connected: true, error: null };
  log('已连上 CDP', found.port, found.target.title);
  try {
    await session.send('Page.enable');
    await session.send('Runtime.enable');
  } catch {
    /* 老版本可能没有 Page 域 */
  }
  session.on('Page.loadEventFired', () => {
    log('页面加载完成，重新注入');
    setTimeout(() => safeInject('page-load'), 900);
  });
  session.on('__close', () => {
    log('CDP 连接断开');
    session = null;
    cdpState = { ...cdpState, connected: false, error: '调试通道已断开' };
  });
  // 读一次客户端版本
  try {
    const v = await session.evaluate(`document.body.getAttribute('data-product-version') || ''`);
    cdpState.appVersion = v || null;
  } catch {
    /* 忽略 */
  }
  await safeInject('connect');
  return session;
}

async function safeInject(reason) {
  if (!session || session.closed) return { ok: false, error: '未连接' };
  try {
    const apiBase = `http://${HOST}:${ACTUAL_PORT}`;
    const res = await injectWidget(session, { apiBase, apiToken: API_TOKEN, forcedPort: ACTUAL_PORT });
    cdpState.lastInjectAt = Date.now();
    log('注入完成', reason, res);
    return { ok: true, mounted: !!res.host };
  } catch (e) {
    log('注入失败', reason, e.message);
    return { ok: false, error: e.message };
  }
}

// 客户端当前真正登录的是哪个账号 —— 靠它自己发出去的取数请求返回的 Uin 判断。
// （页面 URL 里的 accountSnapshot 在 Page.reload 后不会更新，不能当依据。）
async function rendererUin() {
  if (!session || session.closed) return null;
  try {
    const res = await official.getResource(session);
    const accounts = res?.Response?.Data?.Accounts || res?.data?.Response?.Data?.Accounts || res?.Accounts || [];
    const uins = [...new Set(accounts.map((x) => String(x.Uin)))];
    return uins.length === 1 ? uins[0] : uins.length ? null : null;
  } catch {
    return null;
  }
}

async function reloadPage() {
  if (!session) return false;
  try {
    await session.send('Page.reload', { ignoreCache: false });
    return true;
  } catch (e) {
    log('刷新页面失败', e.message);
    return false;
  }
}

/* ───────── 当前账号快照（含渲染进程里的昵称） ───────── */

async function snapshotCurrent() {
  const cur = store.readCurrent();
  if (!cur) return null;
  let nickname = cur.nickname;
  let edition = cur.edition;
  let rendererUid = null;
  if (session && !session.closed) {
    try {
      const raw = await session.evaluate(
        `(function(){
           try {
             var s = new URLSearchParams(location.search || '').get('accountSnapshot');
             if (!s) return '{}';
             var o = null;
             try { o = JSON.parse(s); } catch (e) { o = JSON.parse(decodeURIComponent(s)); }
             return JSON.stringify({ uid: o.uid || null, nickname: o.nickname || null, edition: o.editionType || null, isPro: !!o.isPro });
           } catch (e) { return '{}'; }
         })()`,
      );
      const parsed = JSON.parse(raw || '{}');
      rendererUid = parsed.uid || null;
      // URL 里的快照只在「磁盘上解不出昵称」时当兜底，且要求 uid 对得上
      if (!nickname && parsed.uid && parsed.uid === cur.uid && parsed.nickname) nickname = parsed.nickname;
      if (!edition && parsed.uid && parsed.uid === cur.uid && parsed.edition) edition = parsed.edition;
    } catch {
      /* 取不到就用磁盘上的 */
    }
  }
  currentSnapshot = { uid: cur.uid, nickname, edition, rendererUid };
  return currentSnapshot;
}

/* ───────── 官方数据（带缓存） ───────── */

async function pullOfficial(force) {
  if (!session) return { ok: false, error: '调试通道未连接，取不到官方数据' };
  if (!force && officialCache.data && Date.now() - officialCache.at < 45_000) {
    return { ok: true, data: officialCache.data, cached: true };
  }
  try {
    const data = await official.pullCurrent(session);
    officialCache = { at: Date.now(), data };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* ───────── 状态聚合 ───────── */

async function buildStatus() {
  const cur = currentSnapshot || (await snapshotCurrent());
  return {
    brand: BRAND,
    version: VERSION,
    buildId: BUILD_ID,
    pid: process.pid,
    port: ACTUAL_PORT,
    profile: { id: PROFILE.id, name: PROFILE.name, isAi: !!PROFILE.isAi, apiHost: PROFILE.apiHost },
    cdpConnected: !!(session && !session.closed),
    cdpPort,
    appVersion: cdpState.appVersion,
    cdpError: cdpState.error,
    current: cur ? cur.uid : null,
    currentAccount: cur,
    dataDir: dataDir(),
    workBuddyExe: exePath(),
    uptimeMs: Date.now() - startedAt,
    lastInjectAt: cdpState.lastInjectAt || null,
  };
}

/* ───────── 单个账号的官方数据（明文 token 直连） ───────── */

const accountCache = new Map();

// 签到接口的 POST 是幂等的（已签到会返回 10001），所以每天每账号只问一次，结果落盘缓存。
async function ensureCheckin(uid, token) {
  const cached = checkincache.getToday(uid);
  if (cached) return cached;
  try {
    const r = await official.checkinDirect(token);
    const code = r.body?.code ?? r.body?.Code ?? null;
    const msg = r.body?.msg || r.body?.message || r.body?.Message || '';
    const already = code === 10001 || /已签到|已领取|already/i.test(String(msg));
    return checkincache.put(uid, { ok: code === 0 || code === null || already, already, code, message: msg });
  } catch (e) {
    return { ok: false, error: e.message, date: null };
  }
}

// 当前账号走客户端自己的登录态
async function ensureCheckinCurrent() {
  const cur = store.readCurrent();
  if (!cur) return null;
  const cached = checkincache.getToday(cur.uid);
  if (cached) return cached;
  if (!session || session.closed) return null;
  try {
    const r = await official.checkinViaRenderer(session);
    const body = r.body || {};
    const code = body.code ?? body.Code ?? null;
    const msg = body.msg || body.message || body.Message || r.error || '';
    const already = code === 10001 || /已签到|已领取|already/i.test(String(msg));
    if (code === null && !r.ok) return { ok: false, error: msg || '签到接口没有返回可判定的结果', date: null };
    return checkincache.put(cur.uid, { ok: code === 0 || code === null || already, already, code, message: msg });
  } catch (e) {
    return { ok: false, error: e.message, date: null };
  }
}
const ACCOUNT_TTL = 5 * 60 * 1000;

async function pullOneAccount(acc) {
  const hit = accountCache.get(acc.uid);
  if (hit && Date.now() - hit.at < ACCOUNT_TTL) return hit;
  let rec;
  try {
    rec = store.readAuthFile(accountFile(acc.uid));
  } catch {
    return null;
  }
  let token = rec.token;
  let refreshTok = rec.refreshToken;
  if (!token) {
    // 备份里的 token 被官方静态加密了；看凭据缓存里还有没有一份能用的
    const cachedTok = tokencache.get(acc.uid);
    if (cachedTok) {
      token = cachedTok.token;
      refreshTok = refreshTok || cachedTok.refreshToken;
    } else {
      const entry = { at: Date.now(), error: '该账号的登录凭据已被客户端加密，切到它即可看到实时积分', locked: true };
      accountCache.set(acc.uid, entry);
      return entry;
    }
  }
  let refreshed = false;
  try {
    // 快过期（或没记录到期时间）就先续期，并把结果写回备份 —— 账号能长期保活
    if ((!rec.expiresAt || rec.expiresAt - Date.now() < 86_400_000) && refreshTok) {
      const next = await official.refreshAccess(token, refreshTok);
      token = next.accessToken;
      store.applyTokenRefresh(acc.uid, next);
      tokencache.save(acc.uid, { token: next.accessToken, refreshToken: next.refreshToken, expiresAt: next.expiresAt });
      refreshed = true;
      log('已为账号续期', acc.uid.slice(0, 8));
    }
    const data = await official.pullWithToken(token);
    if (!data.credits && data.errors && data.errors.length) throw new Error(data.errors[0]);
    data.checkin = await ensureCheckin(acc.uid, token);
    tokencache.save(acc.uid, { token, refreshToken: rec.refreshToken, expiresAt: rec.expiresAt });
    datacache.save(acc.uid, { credits: data.credits, streak: data.streak, activity: data.activity, tasks: data.tasks, checkin: data.checkin });
    const entry = { at: Date.now(), data, refreshed };
    accountCache.set(acc.uid, entry);
    return entry;
  } catch (e) {
    const entry = { at: Date.now(), error: e.message, status: e.status || null, expired: e.status === 401 || e.status === 403 };
    accountCache.set(acc.uid, entry);
    log('账号取数失败', acc.uid.slice(0, 8), e.message);
    return entry;
  }
}

function mergeAccountData(a, data) {
  if (!data) return;
  a.dataAt = data.at || Date.now();
  if (data.credits) {
    a.credit = data.credits.remain;
    a.creditTotal = data.credits.total;
    a.creditRatio = data.credits.total ? data.credits.remain / data.credits.total : 0;
    a.creditSegments = data.credits.segments.slice(0, 40);
  }
  if (data.activity) {
    a.todayScore = data.activity.todayScore;
    a.activeDays30 = data.activity.activeDays30;
  }
  if (data.checkin) {
    const done = checkincache.isDoneToday(data.checkin);
    if (done !== null) a.checkedInToday = done;
    a.checkinMessage = data.checkin.message || null;
  }
  if (data.streak) a.streak = data.streak;
  if (data.tasks) a.tasks = data.tasks;
}

async function buildState(force) {
  const status = await buildStatus();
  const accounts = store.listAccounts();
  const res = await pullOfficial(force);
  const officialData = res.ok ? res.data : null;
  if (!res.ok) status.officialError = res.error;

  const cur = status.current;
  const live = status.currentAccount || {};

  // 1) 当前账号：走渲染进程（客户端自己的登录态，永远有效）
  if (officialData) {
    for (const a of accounts) {
      if (a.uid === cur) {
        if (live.nickname && !a.nickname) a.nickname = live.nickname;
        if (live.edition && !a.edition) a.edition = live.edition;
        a.isLive = true;
        mergeAccountData(a, officialData);
        datacache.save(a.uid, {
          credits: officialData.credits,
          streak: officialData.streak,
          activity: officialData.activity,
          tasks: officialData.tasks,
        });
        const chk = await ensureCheckinCurrent();
        if (chk) {
          const done = checkincache.isDoneToday(chk);
          if (done !== null) a.checkedInToday = done;
          a.checkinMessage = chk.message || null;
        }
      }
    }
  }

  // 2) 其他账号：token 还是明文的，直接打官方接口（每次并发 4 条）
  const others = accounts.filter((a) => a.uid !== cur && a.tokenUsable && !a.isLive);
  for (let i = 0; i < others.length; i += 4) {
    await Promise.all(
      others.slice(i, i + 4).map(async (a) => {
        const r = await pullOneAccount(a);
        if (!r) return;
        if (r.data) {
          mergeAccountData(a, r.data);
          a.refreshed = !!r.refreshed;
        } else if (r.error) {
          a.dataError = r.error;
          a.dataLocked = !!r.locked;
          if (r.expired) a.authValid = false;
        }
      }),
    );
  }

  // 3) 还没有数据的账号：用上次成功同步的快照兜底（标注时间，不假装是实时）
  for (const a of accounts) {
    if (a.credit != null) continue;
    const snap = datacache.get(a.uid);
    if (!snap) continue;
    if (snap.credits) {
      a.credit = snap.credits.remain;
      a.creditTotal = snap.credits.total;
      a.creditRatio = snap.credits.total ? snap.credits.remain / snap.credits.total : 0;
      a.creditSegments = (snap.credits.segments || []).slice(0, 40);
      a.creditStale = true;
      a.creditAt = snap.at;
    }
    if (snap.streak) a.streak = snap.streak;
    if (snap.activity) {
      a.todayScore = snap.activity.todayScore;
      a.activeDays30 = snap.activity.activeDays30;
    }
    if (snap.checkin) {
      const done = checkincache.isDoneToday(snap.checkin);
      if (done !== null) a.checkedInToday = done;
    }
  }

  status.totalCredit = accounts.reduce((s, a) => s + (a.credit || 0), 0);
  status.accountsWithData = accounts.filter((a) => a.credit != null).length;

  return { ok: true, status, accounts, settings: readSettings(), official: officialData };
}

/* ───────── HTTP 服务 ───────── */

let API_TOKEN = '';
let ACTUAL_PORT = PROFILE.apiPort;
const PUBLIC_PATHS = new Set(['/api/ping']);

function json(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-FreeBuddy-Token',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(buf);
}

function authorized(req) {
  const url = new URL(req.url, `http://${HOST}`);
  if (PUBLIC_PATHS.has(url.pathname)) return true;
  const t = req.headers['x-freebuddy-token'];
  if (!t || typeof t !== 'string') return false;
  const a = Buffer.from(t);
  const b = Buffer.from(API_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 8 * 1024 * 1024) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function route(req, res, body) {
  const url = new URL(req.url, `http://${HOST}`);
  const p = url.pathname;
  const method = req.method;

  if (method === 'GET' && p === '/api/ping') return json(res, 200, { ok: true, brand: BRAND, version: VERSION, profile: PROFILE.id });
  if (method === 'GET' && p === '/api/status') return json(res, 200, { ok: true, ...(await buildStatus()) });
  if (method === 'GET' && p === '/api/state') return json(res, 200, await buildState(url.searchParams.get('refresh') === '1'));

  if (method === 'POST' && p === '/api/inject') {
    if (!session || session.closed) {
      try { await ensureSession(); } catch (e) { log('注入前重连失败', e.message); }
    }
    const r = await safeInject('manual');
    return json(res, r.ok ? 200 : 500, r);
  }
  if (method === 'POST' && p === '/api/reload') {
    const ok = await reloadPage();
    return json(res, 200, { ok, reloaded: ok });
  }
  if (method === 'POST' && p === '/api/eject') {
    if (session) await destroyWidget(session);
    return json(res, 200, { ok: true });
  }
  if (method === 'POST' && p === '/api/backup') {
    try {
      const r = store.backupCurrent();
      officialCache = { at: 0, data: null };
      return json(res, 200, { ok: true, ...r });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }
  if (method === 'POST' && p === '/api/switch') {
    try {
      const r = store.switchTo(body.uid);
      officialCache = { at: 0, data: null };
      accountCache.clear();
      currentSnapshot = null;

      let method_ = 'reload';
      let reloaded = false;
      if (body.reload !== false) {
        reloaded = await reloadPage();
        await new Promise((x) => setTimeout(x, 3500));
        // 用真实取数返回的 Uin 校验：对得上说明刷新已经让新账号生效，不必重启客户端
        let wantUin = (store.readMeta().accounts[body.uid] || {}).uin || null;
        let gotUin = null;
        try {
          if (!wantUin) {
            const rec = store.readAuthFile(accountFile(body.uid));
            if (rec.uin) wantUin = String(rec.uin);
          }
          gotUin = await rendererUin();
        } catch {
          gotUin = null;
        }
        const ok = wantUin && gotUin && String(wantUin) === String(gotUin);
        if (ok) log('刷新已让新账号生效（uin', gotUin, '），无需重启客户端');
        if (!ok) {
          log('刷新后渲染进程仍是旧账号（期望 uin', wantUin, '实际', gotUin, '），改为重启客户端');
          log('刷新后渲染进程仍是旧账号，改为重启客户端');
          method_ = 'restart';
          const running = wbproc.findRunning();
          if (running.length) await wbproc.stopExact(running.map((x) => x.pid), log);
          session = null;
          let ready = false;
          for (let attempt = 1; attempt <= 2 && !ready; attempt++) {
            // 杀完立刻拉起时，单实例互斥锁可能还没释放，新进程会直接退出
            await new Promise((x) => setTimeout(x, 1500));
            wbproc.launchWithCdp(PROFILE.cdpPort);
            ready = await wbproc.waitTarget(PROFILE.cdpPort, attempt === 1 ? 22000 : 35000);
            if (!ready && attempt === 1) {
              const left = wbproc.findRunning();
              if (left.length) await wbproc.stopExact(left.map((x) => x.pid), log);
            }
          }
          reloaded = ready;
          if (ready) {
            await ensureSession();
            await safeInject('after-switch');
          }
        }
      }
      // 切换收尾：立刻拉一次官方数据并写快照，避免面板刷新时看到空白
      try {
        await ensureSession();
        if (session && !session.closed) {
          const fresh = await official.pullCurrent(session);
          officialCache = { at: Date.now(), data: fresh };
          datacache.save(body.uid, {
            credits: fresh.credits,
            streak: fresh.streak,
            activity: fresh.activity,
            tasks: fresh.tasks,
          });
          const chk = await ensureCheckinCurrent();
          if (chk) datacache.save(body.uid, { checkin: chk });
        }
      } catch (e) {
        log('切换后补拉数据失败（面板稍后会自己重试）', e.message);
      }
      currentSnapshot = null;
      accountCache.clear();
      return json(res, 200, { ok: true, ...r, reloaded, method: method_ });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }
  if (method === 'POST' && p === '/api/logout') {
    try {
      store.logoutCurrent();
      return json(res, 200, { ok: true, note: '已删除当前登录信息文件；请在官方窗口里重新扫码登录' });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }
  if (method === 'POST' && p === '/api/accounts/note') {
    try {
      return json(res, 200, { ok: true, ...store.setNote(body.uid, body.note) });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }
  if (method === 'POST' && p === '/api/accounts/primary') {
    try {
      return json(res, 200, { ok: true, ...store.setPrimary(body.uid) });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }
  if (method === 'POST' && p === '/api/accounts/delete') {
    try {
      return json(res, 200, { ok: true, ...store.deleteAccount(body.uid) });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }
  if (method === 'POST' && p === '/api/accounts/export') {
    try {
      const r = store.exportAccounts(body.password, body.uids);
      return json(res, 200, { ok: true, ...r });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }
  if (method === 'POST' && p === '/api/accounts/import') {
    try {
      const r = store.importAccounts(body.content, body.password);
      return json(res, 200, { ok: true, ...r });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }
  if (method === 'POST' && p === '/api/checkin') {
    const uid = body.uid || null;
    const cur = store.readCurrent();
    const isCurrent = !uid || uid === (cur && cur.uid) || uid === (currentSnapshot && currentSnapshot.uid);
    try {
      let code = null;
      let msg = '';
      let via;
      if (isCurrent) {
        if (!session) return json(res, 200, { ok: false, error: '调试通道未连接' });
        const r = await official.checkinViaRenderer(session);
        const body = r.body || {};
        code = body.code ?? body.Code ?? null;
        msg = body.msg || body.message || body.Message || r.error || '';
        via = 'client';
      } else {
        // 非当前账号：用它自己备份里的明文 token 直连官方接口
        const rec = store.readAuthFile(accountFile(uid));
        if (!rec.token) return json(res, 200, { ok: false, error: '这个账号的登录凭据是加密的，请先切换到它再签到' });
        let token = rec.token;
        if ((!rec.expiresAt || rec.expiresAt - Date.now() < 86_400_000) && rec.refreshToken) {
          try {
            const next = await official.refreshAccess(token, rec.refreshToken);
            token = next.accessToken;
            store.applyTokenRefresh(uid, next);
          } catch {
            /* 续期失败就先用旧 token 试 */
          }
        }
        const r = await official.checkinDirect(token);
        code = r.body?.code ?? r.body?.Code ?? null;
        msg = r.body?.msg || r.body?.message || r.body?.Message || '';
        via = 'direct';
      }
      const already = code === 10001 || /已签到|已领取|already/i.test(String(msg));
      const okAll = code === 0 || code === null || already;
      officialCache = { at: 0, data: null };
      if (uid) accountCache.delete(uid);
      const targetUid = uid || (cur && cur.uid);
      if (targetUid && okAll) checkincache.put(targetUid, { ok: true, already, code, message: msg });
      return json(res, 200, {
        ok: code === 0 || code === null || already,
        code,
        already,
        via,
        message: msg || (already ? '今天已签到' : '签到完成'),
      });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message, status: e.status || null });
    }
  }

  /* 登录：假退出（回到登录页，不动备份）
     重启失败时会把登录信息文件原样写回 —— 绝不允许出现「关了就回不来」。 */
  if (method === 'POST' && p === '/api/login/fake') {
    const p0 = PROFILE;
    let savedRaw = null;
    try {
      if (fs.existsSync(p0.authFile)) savedRaw = fs.readFileSync(p0.authFile, 'utf8');
    } catch {
      /* 读不到当作没有 */
    }
    const restore = (why) => {
      if (savedRaw == null) return false;
      try {
        fs.mkdirSync(path.dirname(p0.authFile), { recursive: true });
        const tmp = p0.authFile + '.fb-restore-' + process.pid;
        fs.writeFileSync(tmp, savedRaw, { mode: 0o600 });
        fs.renameSync(tmp, p0.authFile);
        log('已把登录信息文件写回', why);
        return true;
      } catch (e) {
        log('写回登录信息文件失败', e.message);
        return false;
      }
    };

    try {
      const running = wbproc.findRunning();
      if (running.length) await wbproc.stopExact(running.map((x) => x.pid), log);
      if (fs.existsSync(p0.authFile)) fs.unlinkSync(p0.authFile);
      session = null;
      currentSnapshot = null;
      officialCache = { at: 0, data: null };

      let ready = false;
      for (let attempt = 1; attempt <= 2 && !ready; attempt++) {
        wbproc.launchWithCdp(p0.cdpPort);
        ready = await wbproc.waitTarget(p0.cdpPort, attempt === 1 ? 45000 : 30000);
        if (!ready && attempt === 1) {
          log('第一次拉起没等到调试端口，清一遍残留进程再试');
          const left = wbproc.findRunning();
          if (left.length) await wbproc.stopExact(left.map((x) => x.pid), log);
        }
      }

      if (!ready) {
        const restored = restore('因为重启失败');
        wbproc.launchWithCdp(p0.cdpPort);
        await wbproc.waitTarget(p0.cdpPort, 20000);
        return json(res, 200, {
          ok: false,
          restored,
          error: restored
            ? 'WorkBuddy 没能带着调试端口重启，已把登录态写回。请手动打开 WorkBuddy 后再试。'
            : 'WorkBuddy 没能重启，请手动打开它。',
        });
      }

      setTimeout(() => safeInject('after-login'), 1200);
      return json(res, 200, { ok: true, quit: running.length > 0, relaunched: true, removedAuthFile: savedRaw != null });
    } catch (e) {
      const restored = restore('因为异常');
      return json(res, 200, { ok: false, restored, error: e.message });
    }
  }

  /* 登录：无感（不退出客户端，浏览器授权后自动入库） */
  if (method === 'POST' && p === '/api/login/seamless/start') {
    try {
      const r = await loginflow.startSeamless();
      wbproc.openInBrowser(r.url);
      return json(res, 200, { ok: true, loginId: r.loginId, url: r.url, expiresIn: r.expiresIn });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }
  if (method === 'GET' && p === '/api/login/seamless/poll') {
    try {
      const r = await loginflow.pollSeamless(url.searchParams.get('loginId') || '');
      if (r.done && r.result) accountCache.clear();
      return json(res, 200, { ok: true, ...r });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }
  if (method === 'POST' && p === '/api/official/refresh') {
    const d = await pullOfficial(true);
    return json(res, 200, d && d.ok === false ? { ok: false, error: d.error } : { ok: true, official: d });
  }
  if (method === 'GET' && p === '/api/token-stats') {
    try {
      const stats = tokens.scan({ force: url.searchParams.get('force') === '1' });
      return json(res, 200, { ok: true, stats });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }
  if (method === 'POST' && p === '/api/settings/set') {
    try {
      const next = writeSettings({ [body.name]: !!body.enabled });
      if (session && ['noDisturb', 'stashPrompt', 'quickPhrases', 'autoContinue'].includes(body.name)) {
        await safeInject('setting-change');
      }
      return json(res, 200, { ok: true, settings: next });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }
  /* 快捷短语清单：整体替换（面板里增删改后一次提交） */
  if (method === 'POST' && p === '/api/phrases') {
    try {
      const list = Array.isArray(body.phrases) ? body.phrases : [];
      const phrases = list
        .slice(0, 60)
        .map((x) => ({
          label: String((x && x.label) || '').trim().slice(0, 40),
          text: String((x && x.text) || '').slice(0, 4000),
        }))
        .filter((x) => x.label && x.text.trim());
      const next = writeSettings({ phrases });
      if (session) await safeInject('phrases-change');
      return json(res, 200, { ok: true, settings: next });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }
  /* 暂存提示词：待发送队列 */
  if (method === 'GET' && p === '/api/stash') {
    const store = readStash();
    return json(res, 200, {
      ok: true,
      items: store.items.map((x) => ({ id: x.id, at: x.at, text: x.text, files: x.files, profile: x.profile, bytes: Buffer.byteLength(x.html || '', 'utf8') })),
      count: store.items.length,
    });
  }
  if (method === 'POST' && p === '/api/stash/add') {
    try {
      const item = normalizeStashItem(body);
      const store = readStash();
      store.items.unshift(item);
      if (store.items.length > STASH_LIMIT) store.items.length = STASH_LIMIT;
      writeStash(store);
      return json(res, 200, { ok: true, item: { id: item.id, at: item.at }, count: store.items.length });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }
  if (method === 'POST' && p === '/api/stash/get') {
    const store = readStash();
    const it = store.items.find((x) => x.id === body.id);
    if (!it) return json(res, 200, { ok: false, error: '这条草稿已经不在了' });
    return json(res, 200, { ok: true, item: it });
  }
  if (method === 'POST' && p === '/api/stash/remove') {
    const ids = new Set((Array.isArray(body.ids) ? body.ids : [body.id]).filter(Boolean).map(String));
    const store = readStash();
    const before = store.items.length;
    store.items = store.items.filter((x) => !ids.has(x.id));
    writeStash(store);
    return json(res, 200, { ok: true, removed: before - store.items.length, count: store.items.length });
  }
  if (method === 'POST' && p === '/api/stash/clear') {
    writeStash({ items: [] });
    return json(res, 200, { ok: true, count: 0 });
  }
  if (method === 'POST' && p === '/api/power/sleep-mode') {
    try {
      power.setMode(body.mode, readSettings().displaySleep);
      return json(res, 200, { ok: true, settings: writeSettings({}) });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }
  if (method === 'POST' && p === '/api/power/display-sleep') {
    try {
      power.setDisplaySleep(!!body.enabled);
      return json(res, 200, { ok: true, settings: writeSettings({ displaySleep: !!body.enabled }) });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }
  /* ───────── 模型管理（读写官方 models.json） ───────── */
  if (method === 'GET' && p === '/api/models') {
    try {
      return json(res, 200, { ok: true, ...models.list() });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }
  if (method === 'POST' && p === '/api/models/save') {
    try {
      return json(res, 200, models.save(body.model || {}, body.index));
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }
  if (method === 'POST' && p === '/api/models/delete') {
    try {
      return json(res, 200, models.remove(body.index));
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }
  if (method === 'POST' && p === '/api/models/duplicate') {
    try {
      return json(res, 200, models.duplicate(body.index));
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }
  if (method === 'POST' && p === '/api/models/reveal') {
    try {
      return json(res, 200, { ok: true, ...models.reveal(body.index) });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }
  if (method === 'POST' && p === '/api/models/probe') {
    try {
      return json(res, 200, await models.probe(body.index));
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }
  if (method === 'POST' && p === '/api/models/default') {
    try {
      return json(res, 200, models.setDefaultModel(body.id));
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }
  if (method === 'GET' && p === '/api/models/export') {
    try {
      return json(res, 200, { ok: true, ...models.exportModels() });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }
  if (method === 'POST' && p === '/api/models/import') {
    try {
      return json(res, 200, models.importModels(body.content, { replace: !!body.replace }));
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }
  if (method === 'POST' && p === '/api/models/backups') {
    try {
      return json(res, 200, { ok: true, backups: models.listBackups() });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }

  /* ───────── 会话：列表 / 分支 / 迁移 / 重命名 / 删除 / 导出导入 ───────── */
  if (method === 'GET' && p === '/api/sessions') {
    try {
      const r = sessionops.list({
        uid: url.searchParams.get('uid'),
        q: url.searchParams.get('q') || '',
        limit: Number(url.searchParams.get('limit')) || 300,
        includeBackground: url.searchParams.get('background') !== '0',
      });
      return json(res, 200, { ok: r.ok, error: r.error, sessions: r.sessions, total: r.total, db: sessionops.dbStatus(), workspaces: sessionops.workspaces() });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message, sessions: [] });
    }
  }
  if (method === 'GET' && p === '/api/sessions/detail') {
    try {
      return json(res, 200, sessionops.detail(url.searchParams.get('id') || ''));
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }
  if (method === 'POST' && p === '/api/sessions/fork') {
    try {
      return json(res, 200, sessionops.fork({ id: body.id, anchor: body.anchor, at: body.at, latest: !!body.latest, title: body.title }));
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }
  if (method === 'POST' && p === '/api/sessions/copy') {
    try {
      return json(res, 200, sessionops.copy({ id: body.id, targetCwd: body.targetCwd, targetUid: body.targetUid, title: body.title }));
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }
  if (method === 'POST' && p === '/api/sessions/rename') {
    try {
      return json(res, 200, sessionops.rename(body.id, body.title));
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }
  if (method === 'POST' && p === '/api/sessions/delete') {
    try {
      return json(res, 200, sessionops.remove(body.ids || body.id));
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }
  if (method === 'POST' && p === '/api/sessions/export') {
    try {
      return json(res, 200, { ok: true, ...sessionops.exportArchive(body.ids, body.password) });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }
  if (method === 'POST' && p === '/api/sessions/import') {
    try {
      return json(res, 200, sessionops.importArchive(body.content, body.password));
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }

  /* ───────── 自动化任务：管 WorkBuddy 原生的 automations 表 ───────── */
  if (method === 'GET' && p === '/api/automations') {
    try {
      const r = automations.list({ runsLimit: Number(url.searchParams.get('runs')) || 30 });
      return json(res, 200, { ok: r.ok, error: r.error, tasks: r.tasks, runs: r.runs, templates: automations.templates(), db: r.backend || null });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message, tasks: [], runs: [] });
    }
  }
  if (method === 'GET' && p === '/api/automations/runs') {
    try {
      return json(res, 200, { ok: true, runs: automations.runs(Number(url.searchParams.get('limit')) || 50) });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message, runs: [] });
    }
  }
  if (method === 'POST' && p === '/api/automations/save') {
    try {
      const cur = store.readCurrent();
      return json(res, 200, automations.save(body.task || {}, body.id, { uid: cur && cur.uid }));
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }
  if (method === 'POST' && p === '/api/automations/toggle') {
    try {
      return json(res, 200, automations.setEnabled(body.id, !!body.enabled));
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }
  if (method === 'POST' && p === '/api/automations/run') {
    try {
      return json(res, 200, automations.runNow(body.id));
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }
  if (method === 'POST' && p === '/api/automations/delete') {
    try {
      return json(res, 200, automations.remove(body.ids || body.id));
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }
  if (method === 'POST' && p === '/api/automations/runs/clear') {
    return json(res, 200, automations.clearRuns());
  }
  if (method === 'GET' && p === '/api/automations/templates') {
    return json(res, 200, { ok: true, templates: automations.templates() });
  }

  if (method === 'POST' && p === '/api/open-dir') {
    try {
      wbproc.openPath(dataDir());
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }
  if (method === 'POST' && p === '/api/open-path') {
    try {
      const target = String(body.path || '');
      if (!target || !fs.existsSync(target)) throw new Error('路径不存在');
      wbproc.openPath(target);
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 200, { ok: false, error: e.message });
    }
  }
  return json(res, 404, { ok: false, error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, X-FreeBuddy-Token',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      });
      return res.end();
    }
    if (!req.url.startsWith('/api/')) return json(res, 404, { ok: false, error: 'not found' });
    if (!authorized(req)) return json(res, 401, { ok: false, error: 'token 校验失败' });
    const body = req.method === 'POST' ? await readBody(req) : {};
    await route(req, res, body);
  } catch (e) {
    log('请求处理异常', String(e && e.message));
    try {
      json(res, 500, { ok: false, error: String(e && e.message) });
    } catch {
      /* 已响应 */
    }
  }
});

/* ───────── 启动 ───────── */

function tryListen(port) {
  return new Promise((resolve) => {
    const onError = (e) => {
      server.removeListener('listening', onOk);
      resolve(e.code === 'EADDRINUSE' ? { ok: false, busy: true } : { ok: false, error: e.message });
    };
    const onOk = () => {
      server.removeListener('error', onError);
      resolve({ ok: true, port });
    };
    server.once('error', onError);
    server.once('listening', onOk);
    server.listen({ host: HOST, port, exclusive: true });
  });
}

async function start() {
  ensureDirs();
  API_TOKEN = loadToken();
  // 预热静态加密密钥（拿不到也不影响使用，只是加密账号要切过去才能看数据）
  try {
    const k = wbdecrypt.hydrateKey();
    log(k ? '已取得静态加密密钥，加密账号可直接查数据' : '未取到静态加密密钥：' + (wbdecrypt.keyStatus().error || ''));
  } catch (e) {
    log('取密钥异常', e.message);
  }

  const lock = acquireLock();
  if (!lock.ok) {
    log('已有实例在运行，退出', lock.owner);
    process.exit(0);
  }

  const candidates = [PROFILE.apiPort, PROFILE.apiPort + 1000, PROFILE.apiPort + 2000, PROFILE.apiPort + 3000];
  for (const port of candidates) {
    const r = await tryListen(port);
    if (r.ok) {
      ACTUAL_PORT = port;
      break;
    }
    if (!r.busy) {
      log('监听失败', port, r.error);
      break;
    }
  }
  if (!server.listening) {
    log('所有候选端口都被占用，退出');
    process.exit(3);
  }

  log(`${BRAND} daemon 启动`, `v${VERSION}`, `pid=${process.pid}`, `port=${ACTUAL_PORT}`, `profile=${PROFILE.id}`);

  // 连 CDP（失败就退避重试）
  const tick = async () => {
    if (!session || session.closed) {
      try {
        await ensureSession();
      } catch (e) {
        cdpState.error = String(e && e.message);
      }
    }
    connectTimer = setTimeout(tick, session && !session.closed ? 15000 : 4000);
    if (connectTimer.unref) connectTimer.unref();
  };
  tick();

  autoBackupOnce();
  const autoBackupTimer = setInterval(autoBackupOnce, 15000);
  if (autoBackupTimer.unref) autoBackupTimer.unref();

  // 定期补种：面板被官方重渲染干掉时自动回来
  const reinject = setInterval(async () => {
    if (!session || session.closed) return;
    try {
      const alive = await session.evaluate(`typeof window.__fbWidget === 'object' && !!document.getElementById('freebuddy-host')`);
      if (alive !== true) {
        log('面板不在页面上，补种一次');
        await safeInject('watch');
      }
    } catch {
      /* 页面切走时忽略 */
    }
  }, 20000);
  if (reinject.unref) reinject.unref();

  const stop = () => {
    log('收到退出信号，清理');
    if (connectTimer) clearTimeout(connectTimer);
    clearInterval(reinject);
    power.setMode('allow', true);
    releaseLock();
    try {
      server.close();
    } catch {
      /* 忽略 */
    }
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('exit', () => {
    try {
      power.setMode('allow', true);
    } catch {
      /* 忽略 */
    }
    releaseLock();
  });
}

start().catch((e) => {
  log('启动失败', String(e && e.message));
  process.exit(1);
});
