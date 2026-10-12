// freebuddy —— 客户端档案与本机路径
// Windows：%LOCALAPPDATA%\Programs\<产品> 那套；macOS：/Applications/<产品>.app + ~/Library/Application Support。
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const BRAND = 'FreeBuddy';
// 版本号跟 package.json 保持一致（打包那条线用它做安装包名）
export const VERSION = '0.1.0';
export const BUILD_ID = 'freebuddy-0.1.0+models-sessions-automations';

const IS_MAC = process.platform === 'darwin';

const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const ROAMING = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const HOME = os.homedir();

/* ───────── macOS 客户端定位 ───────── */

// .app 包位置：优先 /Applications，退路 ~/Applications
function macBundle(name) {
  const cands = [path.join('/Applications', `${name}.app`), path.join(HOME, 'Applications', `${name}.app`)];
  for (const c of cands) if (fs.existsSync(c)) return c;
  return cands[0];
}

// 包内可执行文件按 Info.plist 的 CFBundleExecutable 取 —— 实测 mac 包里它可能叫 Electron
// （并非产品名），不能写死；读不到就退回扫 Contents/MacOS。
function macExe(bundle) {
  try {
    const plist = fs.readFileSync(path.join(bundle, 'Contents', 'Info.plist'), 'utf8');
    const name = (plist.match(/<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/) || [])[1];
    if (name) return path.join(bundle, 'Contents', 'MacOS', name);
  } catch {
    /* 包不在或没有 Info.plist */
  }
  try {
    const dir = path.join(bundle, 'Contents', 'MacOS');
    const bin = fs.readdirSync(dir).find((f) => !f.endsWith('.plist') && f !== 'LICENSES.chromium.html');
    if (bin) return path.join(dir, bin);
  } catch {
    /* 给不出可执行文件 */
  }
  return path.join(bundle, 'Contents', 'MacOS', path.basename(bundle, '.app'));
}

const MAC_AUTH_DIR = path.join(HOME, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth');

function buildProfiles() {
  if (!IS_MAC) {
    // Windows：与移植前逐字一致
    return {
      'workbuddy-cn': {
        id: 'workbuddy-cn',
        name: 'WorkBuddy',
        isAi: false,
        appDir: path.join(LOCAL, 'Programs', 'WorkBuddy'),
        exe: 'WorkBuddy.exe',
        authFile: path.join(LOCAL, 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'),
        dataFolder: '.workbuddy',
        // 官方后端：签到 / 成长 / 积分 / 用量都打这里
        apiHost: 'https://www.codebuddy.cn',
        authOrigins: ['https://www.workbuddy.cn', 'https://www.codebuddy.cn', 'https://copilot.tencent.com'],
        cdpPort: 9222,
        apiPort: 47842,
      },
      'workbuddy-ai': {
        id: 'workbuddy-ai',
        name: 'WorkBuddy AI',
        isAi: true,
        appDir: path.join(LOCAL, 'Programs', 'WorkBuddyAI'),
        exe: 'WorkBuddyAI.exe',
        authFile: path.join(LOCAL, 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop-ai.info'),
        dataFolder: '.workbuddy-ai',
        apiHost: 'https://www.workbuddy.ai',
        authOrigins: ['https://www.workbuddy.ai', 'https://www.codebuddy.ai'],
        cdpPort: 9223,
        apiPort: 47843,
      },
    };
  }

  // macOS：exe 直接是包内可执行文件的绝对路径；appBundle 给 open -a / 前台化用
  const cnBundle = macBundle('WorkBuddy');
  const aiBundle = macBundle('WorkBuddyAI');
  return {
    'workbuddy-cn': {
      id: 'workbuddy-cn',
      name: 'WorkBuddy',
      isAi: false,
      appBundle: cnBundle,
      appDir: cnBundle,
      exe: macExe(cnBundle),
      authFile: path.join(MAC_AUTH_DIR, 'workbuddy-desktop.info'),
      dataFolder: '.workbuddy',
      apiHost: 'https://www.codebuddy.cn',
      authOrigins: ['https://www.workbuddy.cn', 'https://www.codebuddy.cn', 'https://copilot.tencent.com'],
      cdpPort: 9222,
      apiPort: 47842,
    },
    'workbuddy-ai': {
      id: 'workbuddy-ai',
      name: 'WorkBuddy AI',
      isAi: true,
      appBundle: aiBundle,
      appDir: aiBundle,
      exe: macExe(aiBundle),
      authFile: path.join(MAC_AUTH_DIR, 'workbuddy-desktop-ai.info'),
      dataFolder: '.workbuddy-ai',
      apiHost: 'https://www.workbuddy.ai',
      authOrigins: ['https://www.workbuddy.ai', 'https://www.codebuddy.ai'],
      cdpPort: 9223,
      apiPort: 47843,
    },
  };
}

export const PROFILES = buildProfiles();

export function profile() {
  const id = process.env.FB_PROFILE || 'workbuddy-cn';
  const p = PROFILES[id];
  if (!p) throw new Error(`未知 profile: ${id}`);
  return p;
}

// macOS 上给 open -a / 前台化用的 .app 包路径；Windows 没有这个概念
export function appBundle(p = profile()) {
  return p.appBundle || null;
}

export const HOST = '127.0.0.1';

export function dataDir() {
  if (process.env.FB_DATA_DIR) return process.env.FB_DATA_DIR;
  if (IS_MAC) return path.join(HOME, 'Library', 'Application Support', 'FreeBuddy');
  return path.join(ROAMING, 'FreeBuddy');
}

export function accountsDir() {
  return path.join(dataDir(), 'accounts');
}

export function accountFile(uid) {
  return path.join(accountsDir(), `${uid}.info`);
}

export function ensureDirs() {
  for (const d of [dataDir(), accountsDir(), path.join(dataDir(), 'logs')]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  }
}

export function logFile() {
  return path.join(dataDir(), 'logs', 'daemon.log');
}

export function exePath(p = profile()) {
  if (process.env.FB_WORKBUDDY_EXE) return process.env.FB_WORKBUDDY_EXE;
  // macOS：档案里的 exe 已经是包内可执行文件的绝对路径
  if (path.isAbsolute(p.exe)) return p.exe;
  return path.join(p.appDir, p.exe);
}

export function workBuddyUserData(p = profile()) {
  return path.join(os.homedir(), p.dataFolder);
}

// WorkBuddy 自己的本机数据库（会话索引 / 原生自动化任务都在这里）
export function workBuddyDb(p = profile()) {
  return path.join(workBuddyUserData(p), 'workbuddy.db');
}

// 自定义模型清单（官方客户端读它做模型下拉）
export function modelsJson(p = profile()) {
  return path.join(workBuddyUserData(p), 'models.json');
}

// 客户端设置（默认模型等；写它有风险，一律先备份）
export function workBuddySettings(p = profile()) {
  return path.join(workBuddyUserData(p), 'settings.json');
}

// 会话记录所在目录：<userData>/projects/<工作区slug>/<会话id>.jsonl
export function projectsDir(p = profile()) {
  return path.join(workBuddyUserData(p), 'projects');
}
