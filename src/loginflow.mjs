// 登录流程：假退出（不动别人的登录态，回到登录页）与无感登录（不退出客户端，浏览器授权后自动入库）。
// 无感登录的三个官方端点（在客户端自己的插件前缀下）：
//   POST /v2/plugin/auth/state?platform=workbuddy   → 拿 state 与授权链接
//   GET  /v2/plugin/auth/token?state=...            → 轮询授权结果
//   GET  /v2/plugin/login/account?state=...         → 用新 token 换账号资料
import crypto from 'node:crypto';
import fs from 'node:fs';
import { profile, ensureDirs, accountFile } from './config.mjs';
import * as store from './authstore.mjs';

const PREFIX = '/v2/plugin';
const TIMEOUT_SECONDS = 600;
const flows = new Map();

function apiBase() {
  return profile().apiHost;
}

async function httpJson(url, init = {}, timeoutMs = 12000) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 300) };
  }
  return { status: res.status, ok: res.ok, body };
}

function normTs(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

// 把官方返回的两个对象拼成本地登录信息文件（结构照官方，不压缩成白名单）
function buildAuthFile(tokenData, accData) {
  const now = Date.now();
  const t = tokenData || {};
  const domain = String(t.domain || '');
  let expiresAt = normTs(t.expiresAt ?? t.expires_at);
  if (expiresAt == null) {
    const expiresIn = Number(t.expiresIn ?? t.expires_in);
    if (Number.isFinite(expiresIn) && expiresIn > 0) expiresAt = now + expiresIn * 1000;
  }
  let refreshExpiresAt = normTs(t.refreshExpiresAt ?? t.refresh_expires_at);
  if (refreshExpiresAt == null) {
    const rei = Number(t.refreshExpiresIn ?? t.refresh_expires_in);
    if (Number.isFinite(rei) && rei > 0) refreshExpiresAt = now + rei * 1000;
  }
  const account = {
    ...(accData || {}),
    uid: String(accData?.uid || ''),
    nickname: String(accData?.nickname || ''),
    uin: accData?.uin || '',
    phoneNumber: accData?.phoneNumber || '',
    type: accData?.type || 'personal',
    lastLogin: true,
    pluginEnabled: true,
  };
  const auth = {
    ...t,
    accessToken: String(t.accessToken || t.access_token || ''),
    refreshToken: String(t.refreshToken || t.refresh_token || ''),
    tokenType: String(t.tokenType || t.token_type || 'Bearer'),
    domain,
    lastRefreshTime: now,
    scope: t.scope || 'openid profile offline_access email',
    notBeforePolicy: t.notBeforePolicy != null ? t.notBeforePolicy : 0,
    sessionState: t.sessionState || '',
  };
  if (expiresAt != null) {
    auth.expiresAt = expiresAt;
    auth.expiresIn = Math.max(0, Math.round((expiresAt - now) / 1000));
  }
  if (refreshExpiresAt != null) {
    auth.refreshExpiresAt = refreshExpiresAt;
    auth.refreshExpiresIn = Math.max(0, Math.round((refreshExpiresAt - now) / 1000));
  }
  return { account, auth, accounts: [account], allAccounts: [account] };
}

export async function startSeamless() {
  const host = apiBase();
  const platform = profile().isAi ? 'workbuddy-ai' : 'workbuddy';
  const r = await httpJson(`${host}${PREFIX}/auth/state?platform=${platform}`, { method: 'POST' });
  const d = r.body?.data || {};
  if (!d.state) throw new Error(`申请授权失败（HTTP ${r.status}）：${JSON.stringify(r.body).slice(0, 160)}`);
  const url = d.authUrl || d.auth_url || d.url || `${host}/login/started?platform=${platform}&state=${encodeURIComponent(d.state)}`;
  const loginId = 'fb_' + crypto.randomUUID().replace(/-/g, '');
  flows.set(loginId, { state: d.state, expiresAt: Date.now() + TIMEOUT_SECONDS * 1000, done: false, result: null, error: null });
  return { loginId, url, host, expiresIn: TIMEOUT_SECONDS };
}

export async function pollSeamless(loginId) {
  const f = flows.get(loginId);
  if (!f) return { done: true, error: '登录请求不存在或已过期，请重新发起' };
  if (f.done) return { done: true, result: f.result, error: f.error };
  if (Date.now() > f.expiresAt) {
    f.done = true;
    f.error = '授权超时，请重新发起';
    return { done: true, error: f.error };
  }
  const host = apiBase();
  const t = await httpJson(`${host}${PREFIX}/auth/token?state=${encodeURIComponent(f.state)}`, { method: 'GET' });
  const code = typeof t.body?.code === 'number' ? t.body.code : -1;
  if (code !== 0 && code !== 200) return { done: false, waiting: true };
  const tokenData = t.body?.data || {};
  if (!tokenData.accessToken && !tokenData.access_token) return { done: false, waiting: true };

  const headers = { Authorization: `Bearer ${tokenData.accessToken || tokenData.access_token}` };
  if (tokenData.domain) headers['X-Domain'] = tokenData.domain;
  const a = await httpJson(`${host}${PREFIX}/login/account?state=${encodeURIComponent(f.state)}`, { method: 'GET', headers });
  const accData = a.body?.data || {};
  if (!accData.uid) {
    f.done = true;
    f.error = '官方接口没有返回账号标识，无法入库';
    return { done: true, error: f.error };
  }
  try {
    const session = buildAuthFile(tokenData, accData);
    ensureDirs();
    const dest = accountFile(String(accData.uid));
    const tmp = `${dest}.fb-login-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(session, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, dest);
    store.setNote(String(accData.uid), null);
    const meta = store.readMeta();
    store.touchAccount(meta, String(accData.uid), {
      nickname: accData.nickname || null,
      phone: accData.phoneNumber || null,
      uin: accData.uin || null,
      edition: accData.type || null,
      via: 'seamless',
    });
    store.writeMeta(meta);
    f.done = true;
    f.result = { uid: String(accData.uid), nickname: accData.nickname || '' };
    return { done: true, result: f.result };
  } catch (e) {
    f.done = true;
    f.error = e.message;
    return { done: true, error: f.error };
  }
}
