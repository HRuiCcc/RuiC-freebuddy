import fs from 'node:fs';
import { listAccounts, readAuthFile } from '../src/authstore.mjs';
import { accountFile, profile } from '../src/config.mjs';
import { resourceDirect, streakDirect } from '../src/official.mjs';

const target = process.argv[2];
const accts = listAccounts().filter((a) => a.tokenUsable && (!target || a.uid.startsWith(target)));
if (!accts.length) {
  console.log('没有目标账号');
  process.exit(1);
}
const acc = accts[0];
const rec = readAuthFile(accountFile(acc.uid));
console.log('账号:', acc.nickname || acc.uid.slice(0, 8), '| host:', profile().apiHost);
console.log('token 前缀:', rec.token.slice(0, 6) + '…', '| 长度', rec.token.length, '| 到期', rec.expiresAt ? new Date(rec.expiresAt).toISOString() : '无');

try {
  const r = await resourceDirect(rec.token);
  console.log('\n=== resource 顶层键 ===', Object.keys(r || {}).join(','));
  console.log('code =', r && (r.code ?? r.Code), '| message =', r && (r.message || r.msg || r.Message));
  const inner = r?.Response?.Data ?? r?.data?.Response?.Data ?? null;
  console.log('Accounts 条数 =', inner?.Accounts?.length ?? null);
  if (inner?.Accounts?.length) {
    const a0 = inner.Accounts[0];
    console.log('首条:', JSON.stringify({ name: a0.PackageName, remain: a0.CapacityRemainPrecise ?? a0.CapacityRemain, size: a0.CapacitySizePrecise ?? a0.CapacitySize, status: a0.Status }));
  }
  console.log('\n原始片段:', JSON.stringify(r).slice(0, 400));
} catch (e) {
  console.log('\nresource 失败:', e.message, e.status || '');
  if (e.body) console.log('body:', JSON.stringify(e.body).slice(0, 500));
}

try {
  const s = await streakDirect(rec.token);
  console.log('\nstreak:', JSON.stringify(s).slice(0, 300));
} catch (e) {
  console.log('\nstreak 失败:', e.message, e.status || '', e.body ? JSON.stringify(e.body).slice(0, 300) : '');
}
