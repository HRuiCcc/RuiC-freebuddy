// 从 WorkDaddy 迁移账号备份：把它的 accounts/*.info 原样拷进 freebuddy，
// 昵称/手机号/首次出现时间从它的 meta.json 带过来。
// 只读 WorkDaddy 的数据；只写 freebuddy 自己的目录；不碰当前登录态、不切账号。
//   node tools/import-from-workdaddy.mjs              # 迁移（已导入的跳过）
//   node tools/import-from-workdaddy.mjs --dry-run    # 只预览将做什么
//   node tools/import-from-workdaddy.mjs --from DIR   # 指定 WorkDaddy 数据目录
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { accountFile, ensureDirs } from '../src/config.mjs';
import * as store from '../src/authstore.mjs';
import * as tokencache from '../src/tokencache.mjs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const fromIdx = args.indexOf('--from');

function workdaddyDir() {
  if (fromIdx !== -1 && args[fromIdx + 1]) return path.resolve(args[fromIdx + 1]);
  if (process.env.WORKDADDY_DATA_DIR) return process.env.WORKDADDY_DATA_DIR;
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'WorkDaddy');
  }
  // Windows：优先 APPDATA（Electron 惯例），LOCALAPPDATA 作为候选
  const cands = [process.env.APPDATA, process.env.LOCALAPPDATA]
    .filter(Boolean)
    .map((base) => path.join(base, 'WorkDaddy'));
  for (const c of cands) if (fs.existsSync(c)) return c;
  return cands[0] || path.join(os.homedir(), 'AppData', 'Roaming', 'WorkDaddy');
}

function writeAtomic(file, content) {
  const tmp = `${file}.fb-tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const wdDir = workdaddyDir();
const srcDir = path.join(wdDir, 'accounts');
console.log(`WorkDaddy 数据目录：${wdDir}`);
if (!fs.existsSync(srcDir)) {
  console.error(`✗ 找不到账号目录 ${srcDir}（用 --from 指定 WorkDaddy 数据目录）`);
  process.exit(1);
}

// WorkDaddy 的 meta.json 里也有昵称/手机号——登录文件被加密时靠它补全展示信息
let wdMeta = {};
try {
  wdMeta = JSON.parse(fs.readFileSync(path.join(wdDir, 'meta.json'), 'utf8')).accounts || {};
} catch {
  /* 没有 meta 也能迁，只是展示信息少一点 */
}

const files = fs.readdirSync(srcDir).filter((f) => f.endsWith('.info'));
const toImport = [];
const skipped = [];
const broken = [];

for (const f of files) {
  const uid = f.slice(0, -5);
  try {
    store.safeUid(uid);
  } catch {
    broken.push({ file: f, reason: '文件名不是合法 uid' });
    continue;
  }
  if (fs.existsSync(accountFile(uid))) {
    skipped.push(uid);
    continue;
  }
  let parsed;
  try {
    parsed = store.parseAuth(fs.readFileSync(path.join(srcDir, f), 'utf8'));
  } catch (e) {
    broken.push({ file: f, reason: e.message });
    continue;
  }
  if (parsed.uid !== uid) {
    broken.push({ file: f, reason: '文件名与内容 uid 不一致' });
    continue;
  }
  const wd = wdMeta[uid] || {};
  toImport.push({
    uid,
    file: f,
    raw: fs.readFileSync(path.join(srcDir, f), 'utf8'),
    nickname: parsed.nickname || wd.nickname || null,
    phone: parsed.phone || wd.phone || null,
    uin: parsed.uin || wd.uin || null,
    edition: parsed.edition || null,
    domain: parsed.domain || null,
    firstSeen: Number(wd.firstSeen) || null,
    token: parsed.token,
    refreshToken: parsed.refreshToken,
    expiresAt: parsed.expiresAt,
  });
}

for (const a of toImport) {
  console.log(`  待导入  ${a.uid}  ${a.nickname || '(无昵称)'}  ${a.expiresAt ? 'token 至 ' + new Date(a.expiresAt).toLocaleDateString() : 'token 加密/缺失'}`);
}
for (const uid of skipped) console.log(`  已存在  ${uid}  → 跳过`);
for (const b of broken) console.log(`  ✗ ${b.file}  ${b.reason}`);
console.log(`\n共 ${files.length} 个：待导入 ${toImport.length}、已存在 ${skipped.length}、无法解析 ${broken.length}`);

if (dryRun) {
  console.log('\n（--dry-run：没有写任何文件）');
  process.exit(0);
}
if (!toImport.length) {
  console.log('没有需要导入的账号。');
  process.exit(0);
}

ensureDirs();
for (const a of toImport) {
  // 1) 原样落盘：密文保持密文，不做解密也不改写（与备份口径一致）
  writeAtomic(accountFile(a.uid), a.raw);

  // 2) 明文 token 趁现在存进凭据缓存——备份以后被加密版覆盖也能直连官方查积分/签到
  if (a.token) tokencache.save(a.uid, { token: a.token, refreshToken: a.refreshToken, expiresAt: a.expiresAt });

  // 3) 登记元数据（每次现读现写，避免覆盖守护进程刚写的其它字段）
  const meta = store.readMeta();
  const patch = { authFileName: 'workbuddy-desktop.info', via: 'workdaddy' };
  if (a.nickname) patch.nickname = a.nickname;
  if (a.phone) patch.phone = a.phone;
  if (a.uin) patch.uin = a.uin;
  if (a.edition) patch.edition = a.edition;
  if (a.domain) patch.domain = a.domain;
  if (a.firstSeen) patch.firstSeen = a.firstSeen;
  store.touchAccount(meta, a.uid, patch);
  store.writeMeta(meta);
}

const now = store.listAccounts();
console.log(`\n✓ 导入完成，freebuddy 现在共 ${now.length} 个账号备份。`);
console.log('  WorkDaddy 侧数据未做任何改动；当前登录态也没动。');
console.log('  打开面板「账号」页即可看到（跨账号积分会随状态刷新自动拉取）。');
