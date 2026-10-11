// freebuddy —— 客户端档案与本机路径
// 只面向 Windows 上的 WorkBuddy 国内版（workbuddy-cn）与 WorkBuddy AI（workbuddy-ai）。
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const BRAND = 'FreeBuddy';
// 版本号跟 package.json 保持一致（打包那条线用它做安装包名）
export const VERSION = '0.1.0';
export const BUILD_ID = 'freebuddy-0.1.0+models-sessions-automations';

const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const ROAMING = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');

export const PROFILES = {
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

export function profile() {
  const id = process.env.FB_PROFILE || 'workbuddy-cn';
  const p = PROFILES[id];
  if (!p) throw new Error(`未知 profile: ${id}`);
  return p;
}

export const HOST = '127.0.0.1';

export function dataDir() {
  return process.env.FB_DATA_DIR || path.join(ROAMING, 'FreeBuddy');
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
  return process.env.FB_WORKBUDDY_EXE || path.join(p.appDir, p.exe);
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
