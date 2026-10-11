// FreeBuddy —— macOS 侧自检探针（只读，不改任何东西）
//
// 到 Mac 上第一件事就跑它：docs/MAC-PORT.md §6 的 R1/R2/R3 全靠这个回答。
//   node tools/probe-mac.mjs            全部检查，给人看的摘要
//   node tools/probe-mac.mjs --json     全部检查，只吐 JSON（存档用）
//   node tools/probe-mac.mjs --key      只验 at-rest 密钥（成败手）
//   node tools/probe-mac.mjs --auth     只找登录信息文件
//   node tools/probe-mac.mjs --ps       只看进程形态
//
// 安全：**绝不打印密钥本身**，只报「拿到没 / 长度 / 版本」。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, '..');
const KEYTOOL = path.join(ROOT, 'src', 'keytool.cjs');

const argv = process.argv.slice(2);
const ONLY = argv.find((a) => a.startsWith('--') && a !== '--json');
const JSON_ONLY = argv.includes('--json');
const want = (name) => !ONLY || ONLY === `--${name}`;

const report = { at: new Date().toISOString(), platform: process.platform, node: process.version };

function human(...a) {
  if (!JSON_ONLY) console.log(...a);
}

/* ── 1. 找应用包 ─────────────────────────────────────────── */
function findApp() {
  const cands = [
    process.env.FB_APP_BUNDLE,
    '/Applications/WorkBuddy.app',
    path.join(os.homedir(), 'Applications', 'WorkBuddy.app'),
    '/Applications/WorkBuddyAI.app',
    path.join(os.homedir(), 'Applications', 'WorkBuddyAI.app'),
  ].filter(Boolean);
  for (const c of cands) if (fs.existsSync(c)) return c;
  return null;
}

// 从 Info.plist 读 CFBundleExecutable / 版本；读不到就列 Contents/MacOS 目录
function readBundle(app) {
  const out = { app, version: null, bundleId: null, exe: null, exeExists: false };
  try {
    const plist = fs.readFileSync(path.join(app, 'Contents', 'Info.plist'), 'utf8');
    out.version = (plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/) || [])[1] || null;
    out.bundleId = (plist.match(/<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/) || [])[1] || null;
    const exeName = (plist.match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/) || [])[1] || null;
    if (exeName) out.exe = path.join(app, 'Contents', 'MacOS', exeName);
  } catch {
    /* 没有 Info.plist，走下面的兜底 */
  }
  if (!out.exe) {
    try {
      const macosDir = path.join(app, 'Contents', 'MacOS');
      const files = fs.readdirSync(macosDir);
      const bin = files.find((f) => f !== 'LICENSES.chromium.html' && !f.endsWith('.plist'));
      if (bin) out.exe = path.join(macosDir, bin);
    } catch {
      /* 给不出可执行文件 */
    }
  }
  if (out.exe) out.exeExists = fs.existsSync(out.exe);
  return out;
}

/* ── 2. at-rest 密钥（R1，成败手） ────────────────────────── */
function probeKey(binary) {
  if (!binary || !fs.existsSync(binary)) return { ok: false, error: '找不到应用二进制' };
  if (!fs.existsSync(KEYTOOL)) return { ok: false, error: '找不到 keytool.cjs' };
  let r;
  try {
    r = spawnSync(binary, [KEYTOOL], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeout: 20000,
      encoding: 'utf8',
    });
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
  const stdout = String(r.stdout || '');
  const m = stdout.match(/FBKEY ([A-Za-z0-9+/=]+)/);
  if (!m) {
    const em = stdout.match(/FBKEY_ERR ([A-Za-z0-9+/=]+)/);
    let detail = `exit=${r.status}`;
    if (em) {
      try {
        detail = Buffer.from(em[1], 'base64').toString('utf8');
      } catch {
        /* 忽略 */
      }
    }
    return { ok: false, error: detail, stderr: String(r.stderr || '').slice(0, 400) };
  }
  try {
    const payload = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
    // 只报形状，不报内容
    return { ok: true, version: payload.version, keyLen: String(payload.key || '').length };
  } catch (e) {
    return { ok: false, error: '返回值不是合法 JSON：' + String(e && e.message) };
  }
}

/* ── 3. 登录信息文件在哪（R2） ────────────────────────────── */
function walk(root, depth = 4, hits = []) {
  if (depth < 0) return hits;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return hits;
  }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'Cache' || e.name === 'CachedData') continue;
      walk(full, depth - 1, hits);
    } else if (e.name.endsWith('.info')) {
      let st = null;
      try {
        st = fs.statSync(full);
      } catch {
        /* 忽略 */
      }
      hits.push({ file: full, size: st ? st.size : null, mtime: st ? st.mtime.toISOString() : null });
    }
  }
  return hits;
}

function findAuth() {
  const HOME = os.homedir();
  const roots = [
    path.join(HOME, 'Library', 'Application Support', 'CodeBuddyExtension'),
    path.join(HOME, 'Library', 'Application Support', 'WorkBuddy'),
    path.join(HOME, 'Library', 'Application Support', 'workbuddy-desktop'),
    path.join(HOME, 'Library', 'Application Support', 'CodeBuddy'),
    path.join(HOME, '.codebuddy'),
    path.join(HOME, '.workbuddy'),
  ];
  const out = [];
  for (const r of roots) {
    if (!fs.existsSync(r)) continue;
    out.push(...walk(r, 4));
  }
  // 主登录文件优先（无时间戳/pid 的那份）
  out.sort((a, b) => Number(/workbuddy-desktop\.info$/.test(b.file)) - Number(/workbuddy-desktop\.info$/.test(a.file)));
  return out;
}

/* ── 4. 进程形态（R3） ───────────────────────────────────── */
function probePs(binary) {
  const r = spawnSync('ps', ['-Ao', 'pid=,comm='], { encoding: 'utf8' });
  const lines = String(r.stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const workbuddy = lines.filter((l) => /WorkBuddy/i.test(l)).map((l) => {
    const m = l.match(/^(\d+)\s+(.*)$/);
    return { pid: Number(m[1]), comm: m[2] };
  });
  const exact = binary ? workbuddy.filter((x) => x.comm === binary) : [];
  return {
    total: lines.length,
    workbuddyLike: workbuddy.length,
    commIsFullPath: workbuddy.some((x) => x.comm.startsWith('/')),
    exactMatchCount: exact.length,
    samples: workbuddy.slice(0, 6),
  };
}

/* ── 5. 杂项：用户数据目录 / caffeinate / CDP 端口 ───────── */
function probeMisc() {
  const HOME = os.homedir();
  const projects = path.join(HOME, '.workbuddy', 'projects');
  const caf = spawnSync('caffeinate', ['-i', '-t', '1'], { timeout: 5000 });
  const cdp = [];
  for (let p = 9222; p <= 9232; p++) {
    const r = spawnSync('lsof', ['-nP', `-iTCP:${p}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
    const pids = String(r.stdout || '').trim();
    if (pids) cdp.push({ port: p, pids: pids.split('\n').map(Number) });
  }
  return {
    workBuddyUserData: fs.existsSync(path.join(HOME, '.workbuddy')),
    tokenProjectsDir: fs.existsSync(projects),
    caffeinate: { available: caf.status !== null, exit: caf.status, error: String(caf.error ? caf.error.message : '') },
    cdpListening: cdp,
    freebuddyDataDir: path.join(HOME, 'Library', 'Application Support', 'FreeBuddy'),
  };
}

/* ── 跑起来 ──────────────────────────────────────────────── */
function main() {
  if (process.platform !== 'darwin' && !JSON_ONLY) {
    human('⚠️  当前不是 macOS —— 文件类检查仍会跑，但结果无意义。请在 Mac 上运行。\n');
  }

  const app = findApp();
  const bundle = app ? readBundle(app) : null;
  const binary = bundle ? bundle.exe : null;

  if (want('ps')) report.ps = probePs(binary);
  if (want('key')) report.key = probeKey(binary);
  if (want('auth')) report.auth = findAuth();
  if (!ONLY) {
    report.bundle = bundle;
    report.key = probeKey(binary);
    report.auth = findAuth();
    report.ps = probePs(binary);
    report.misc = probeMisc();
  }

  if (JSON_ONLY) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }

  if (want('auth') || (!ONLY && report.auth)) {
    human('── 登录信息文件（R2）──');
    if (!report.auth.length) human('  ✗ 没找到 *.info —— 官方可能换了存放位置，需要手工全盘找一次');
    for (const a of report.auth.slice(0, 12)) human(`  · ${a.file}  (${a.size}B, ${a.mtime})`);
    human('');
  }
  if (want('key') || (!ONLY && report.key)) {
    human('── at-rest 密钥（R1，成败手）──');
    human(report.key.ok ? `  ✓ 拿到了（payload v${report.key.version}，keyLen=${report.key.keyLen}）` : `  ✗ ${report.key.error}`);
    human('');
  }
  if (want('ps') || (!ONLY && report.ps)) {
    human('── 进程形态（R3）──');
    human(`  comm 给完整路径：${report.ps.commIsFullPath ? '是（精确匹配可用）' : '否（要退化为 basename 匹配）'}`);
    human(`  WorkBuddy 相关进程 ${report.ps.workbuddyLike} 个，主进程精确命中 ${report.ps.exactMatchCount} 个`);
    for (const s of report.ps.samples) human(`  · ${s.pid}  ${s.comm}`);
    human('');
  }
  if (!ONLY) {
    human('── 应用 ──');
    if (!bundle) human('  ✗ 没在 /Applications 或 ~/Applications 找到 WorkBuddy.app');
    else {
      human(`  包：${bundle.app}`);
      human(`  版本：${bundle.version || '?'}   BundleId：${bundle.bundleId || '?'}`);
      human(`  二进制：${bundle.exe || '?'}  ${bundle.exeExists ? '✓ 存在' : '✗ 不存在'}`);
    }
    human('');
    human('── 环境 ──');
    const m = report.misc;
    human(`  ~/.workbuddy 存在：${m.workBuddyUserData ? '是' : '否'}`);
    human(`  Token 统计源 ~/.workbuddy/projects：${m.tokenProjectsDir ? '✓ 在' : '✗ 不在（热力图会没数据）'}`);
    human(`  caffeinate：${m.caffeinate.available ? '✓ 可用' : '✗ 不可用（休眠策略会失效）'}`);
    human(`  正在监听的调试端口：${m.cdpListening.length ? m.cdpListening.map((x) => x.port).join(', ') : '无（WorkBuddy 没带调试端口跑）'}`);
  }
}

main();
