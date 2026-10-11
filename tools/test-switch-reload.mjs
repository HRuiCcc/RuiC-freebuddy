// 判定「切换账号是否必须重启客户端」：写登录文件 → 只做 Page.reload →
// 用渲染进程真正发出去的取数请求返回的 Uin 来判断当前到底是哪个账号。
import fs from 'node:fs';
import path from 'node:path';
import { HOST, profile, dataDir } from '../src/config.mjs';
import * as store from '../src/authstore.mjs';
import { attach } from '../src/cdplink.mjs';
import { getResource } from '../src/official.mjs';

const PROFILE = profile();
const token = fs.readFileSync(path.join(dataDir(), '.api-token'), 'utf8').trim();
const TARGET = process.argv[2] || '02a57cc2-db63-4c56-b875-ec49e18b5df1';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function uinNow() {
  const a = await attach(PROFILE.cdpPort);
  if (!a) return { error: '未连上 CDP' };
  try {
    const res = await getResource(a.session);
    const accounts = res?.Response?.Data?.Accounts || res?.data?.Response?.Data?.Accounts || [];
    const uins = [...new Set(accounts.map((x) => String(x.Uin)))];
    return { uins, count: accounts.length };
  } catch (e) {
    return { error: e.message };
  } finally {
    a.session.close();
  }
}

const before = await uinNow();
console.log('切换前，渲染进程取数返回的 Uin:', JSON.stringify(before));

const meta = store.readMeta();
const targetUin = (meta.accounts[TARGET] || {}).uin;
console.log('目标账号 uin:', targetUin);

console.log('\n写入目标账号登录文件…');
store.switchTo(TARGET);

console.log('只做 Page.reload（不重启客户端）…');
const a = await attach(PROFILE.cdpPort);
await a.session.send('Page.reload', { ignoreCache: false });
await wait(6000);

const after = await uinNow();
console.log('重载后，渲染进程取数返回的 Uin:', JSON.stringify(after));

const hit = after.uins && targetUin && after.uins.includes(String(targetUin));
console.log('\n结论:', hit ? '✅ 只靠刷新就能切账号（不需要重启）' : '❌ 刷新不够，必须重启客户端');
