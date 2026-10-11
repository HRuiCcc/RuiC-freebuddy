// 解密 WorkBuddy 5.6+ 对登录信息做的静态加密（$wbEncrypted 信封）。
// 密钥来自 WorkBuddy 自带的 Electron 绑定：以 ELECTRON_RUN_AS_NODE 方式跑 keytool.cjs，
// 由它把 atRestSecretKey 从管道交回来（密钥只在内存里，不落盘、不写日志）。
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exePath } from './config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const KEYTOOL = path.join(here, 'keytool.cjs');

const FMT_FIELD = 'WBEV1';
const SUITE_NAME = 'sym-v1';

let cache = { key: null, at: 0, error: null };
const RETRY_MS = 60000;

function lp(s) {
  const b = Buffer.from(String(s), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(b.length, 0);
  return Buffer.concat([len, b]);
}

function buildAad(suite, keyId) {
  const u32 = Buffer.alloc(4);
  u32.writeUInt32BE(Number(suite) || 1, 0);
  return Buffer.concat([
    Buffer.from('WB-AAD\0', 'utf8'),
    Buffer.from([0x01]),
    lp(FMT_FIELD),
    lp(SUITE_NAME),
    u32,
    lp(String(keyId || '')),
    Buffer.from([0x02, 0x00, 0x00]),
  ]);
}

export function isEnvelope(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v) && v.$wbEncrypted === 1 && typeof v.envelope === 'string';
}

// 取密钥（带 60 秒失败退避）；成功返回 32 字节 Buffer
export function hydrateKey() {
  if (cache.key) return cache.key;
  if (cache.error && Date.now() - cache.at < RETRY_MS) return null;
  const exe = exePath();
  if (!fs.existsSync(exe) || !fs.existsSync(KEYTOOL)) {
    cache = { key: null, at: Date.now(), error: '找不到客户端或取钥脚本' };
    return null;
  }
  try {
    const r = spawnSync(exe, [KEYTOOL], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeout: 20000,
      encoding: 'utf8',
      windowsHide: true,
    });
    const m = String(r.stdout || '').match(/FBKEY ([A-Za-z0-9+/=]+)/);
    if (!m) {
      cache = { key: null, at: Date.now(), error: `取钥失败 exit=${r.status}` };
      return null;
    }
    const payload = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
    if (payload.version !== 1 || typeof payload.key !== 'string') {
      cache = { key: null, at: Date.now(), error: '密钥格式不匹配' };
      return null;
    }
    cache = { key: crypto.createHash('sha256').update(payload.key, 'utf8').digest(), at: Date.now(), error: null };
    return cache.key;
  } catch (e) {
    cache = { key: null, at: Date.now(), error: String((e && e.message) || e) };
    return null;
  }
}

export function keyStatus() {
  return { available: !!cache.key, error: cache.error };
}

// 解一个信封，失败返回 null（调用方应保留原值）
export function decryptEnvelope(env) {
  if (!isEnvelope(env)) return null;
  const key = hydrateKey();
  if (!key) return null;
  try {
    const frame = JSON.parse(Buffer.from(env.envelope, 'base64').toString('utf8'));
    const nonce = Buffer.from(frame.nonce, 'base64');
    const tag = Buffer.from(frame.authTag, 'base64');
    const ct = Buffer.from(frame.ciphertext, 'base64');
    const aad = buildAad(frame.suite, frame.keyId);
    const d = crypto.createDecipheriv('aes-256-gcm', key, nonce);
    d.setAAD(aad);
    d.setAuthTag(tag);
    const out = Buffer.concat([d.update(ct), d.final()]);
    return out.toString('utf8');
  } catch {
    return null;
  }
}

// 字段级：是信封就解，否则原样返回
export function decryptField(value) {
  if (isEnvelope(value)) return decryptEnvelope(value);
  return null;
}
