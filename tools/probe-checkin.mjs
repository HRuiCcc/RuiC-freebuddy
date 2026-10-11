import { listAccounts, readAuthFile } from '../src/authstore.mjs';
import { accountFile, profile, HOST } from '../src/config.mjs';

const acc = listAccounts().find((a) => a.tokenUsable && a.uid.startsWith(process.argv[2] || 'ef62'));
const rec = readAuthFile(accountFile(acc.uid));
const host = profile().apiHost;

function headers(extra) {
  return {
    authorization: `Bearer ${rec.token}`,
    'x-client-platform': 'web',
    origin: host,
    referer: `${host}/profile/growth-center`,
    accept: 'application/json, text/plain, */*',
    ...extra,
  };
}

async function tryCall(label, url, init) {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
    const text = await res.text();
    console.log(`\n[${label}] HTTP ${res.status}`);
    console.log('  ', text.slice(0, 420));
  } catch (e) {
    console.log(`\n[${label}] 异常 ${e.message}`);
  }
}

const P = `${host}/billing/meter/daily-checkin`;
const P2 = `${host}/v2/billing/meter/daily-checkin`;

await tryCall('POST {} 无 x-user-id', P, { method: 'POST', headers: headers({ 'content-type': 'application/json' }), body: '{}' });
await tryCall('POST {} + x-user-id', P, {
  method: 'POST',
  headers: headers({ 'content-type': 'application/json', 'x-user-id': String(acc.uin || '') }),
  body: '{}',
});
await tryCall('POST 空 body', P, { method: 'POST', headers: headers({}), body: '' });
await tryCall('GET', P, { method: 'GET', headers: headers({}) });
await tryCall('POST v2 {}', P2, { method: 'POST', headers: headers({ 'content-type': 'application/json' }), body: '{}' });
await tryCall('POST {userId}', P, {
  method: 'POST',
  headers: headers({ 'content-type': 'application/json' }),
  body: JSON.stringify({ userId: acc.uin, uin: acc.uin, uid: acc.uid }),
});
