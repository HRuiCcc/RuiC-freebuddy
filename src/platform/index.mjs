// FreeBuddy —— 平台层入口。
//
// daemon / launcher / stop / desktop 一律只从这里拿平台能力，不再直接 import wbproc/power：
//   import * as wbproc from './platform/index.mjs';
//   import { power } from './platform/index.mjs';
// 这样两个平台共用同一套调用点，Windows 侧的行为由 win.mjs 原样转发给未被改动的
// src/wbproc.mjs 与 src/power.mjs —— 一个字节都没重写。
import * as win from './win.mjs';
import * as mac from './mac.mjs';

const impl = process.platform === 'darwin' ? mac : win;

export const platform = impl.platform;

/* ───────── 进程 / 客户端控制 ───────── */
export const findRunning = (...a) => impl.findRunning(...a);
export const cdpListening = (...a) => impl.cdpListening(...a);
export const targetReady = (...a) => impl.targetReady(...a);
export const waitTarget = (...a) => impl.waitTarget(...a);
export const stopExact = (...a) => impl.stopExact(...a);
export const killPids = (...a) => impl.killPids(...a);
export const cleanChildEnv = (...a) => impl.cleanChildEnv(...a);
export const launchWithCdp = (...a) => impl.launchWithCdp(...a);

/* ───────── 打开 / 前台化 ───────── */
export const openInBrowser = (...a) => impl.openInBrowser(...a);
export const openPath = (...a) => impl.openPath(...a);
export const focusApp = (...a) => impl.focusApp(...a);

/* ───────── 查询 ───────── */
export const pidsOnPort = (...a) => impl.pidsOnPort(...a);

/* ───────── 电源（休眠策略） ───────── */
export const power = impl.power;
