# FreeBuddy

WorkBuddy 桌面端的**本机增强面板**：多账号备份与秒切、跨账号积分/签到、Token 活动统计、免打扰、休眠控制。

实现方式是**本机回环 CDP 注入**——给 WorkBuddy 多带一个 `--remote-debugging-port` 参数启动，
把一块面板推进它的渲染进程；**不改官方安装包、不改签名**。

> 本机增强面板：把一块面板注入 WorkBuddy 渲染进程，做多账号切换、积分签到、用量统计、免打扰与休眠控制。
> 纯本机运行，不收集、不上传任何数据。

---

## 现状：能用的 / 还不能用的

**能用（都在这台机器上实测过）**

| 能力 | 说明 |
|---|---|
| 账号备份 | 守护进程**自动**备份：登录态一变化就落一份，无需手动点 |
| 账号切换 | 写登录文件 + 刷新渲染进程，**约 4 秒**，不重启客户端；切完立刻有数据 |
| 跨账号积分 | 全部账号的剩余积分/资源包分段，一次拉齐（靠解密官方静态加密的凭据） |
| 每日签到 | 各账号签到状态自动查询并按天缓存；非当前账号也能直连签到 |
| 连续登录 | 每个账号的连续活跃天数与档位进度 |
| Token 活动 | 读本机会话记录画热力图（每日/每周/累计）+ 输入/输出/缓存构成 |
| 免打扰 | 权限弹窗自动点「允许」，可整夜无人值守 |
| 休眠策略 | 允许 / 禁止 / 跑完再休眠（用常驻 PowerShell 持有唤醒锁，改回即释放） |
| 登录新账号 | 无感登录：浏览器授权后自动加入列表 |
| 账号导入导出 | AES-256-GCM + scrypt + gzip 加密；同名账号不覆盖 |
| 中英界面 | 面板文案双语 |

**还不能用（界面上已明确标注 v0.2，不会假装能用）**

- 异常中断自动续接、暂存提示词、快捷短语
- 主题接管（换肤 / 壁纸）
- 自动化任务引擎、会话迁移/分支、模型管理

---

## 运行

装好的版本（推荐）：**双击桌面上的 FreeBuddy 图标 —— 它自己没有窗口、也没有托盘**，
直接把 WorkBuddy 打开（在跑但没开调试端口就按可执行文件绝对路径精确重启它）→ 拉起守护进程
→ 把面板注入进去 → 把 WorkBuddy 顶到前台，然后自己退出。你看到的就是 WorkBuddy，
面板在窗口右下角那颗靛蓝悬浮球里。

想看状态 / 手动启停 / 调设置：开始菜单 → **FreeBuddy 控制台**（等同 `FreeBuddy.exe --console`），
那才是有窗口有托盘的控制台。三种模式：

```
FreeBuddy.exe              进去模式：接管 + 注入 + 前置 WorkBuddy，干完就退（桌面图标就是这个）
FreeBuddy.exe --console    控制台窗口 + 托盘（开始菜单那个）
FreeBuddy.exe --tray       只常驻托盘 + 守护进程，不接管（可选的开机自启项用这个）
```

不想装、只用脚本也可以：

```
scripts\Start-FreeBuddy.cmd      # 接管 WorkBuddy 并把面板注入进去
scripts\Stop-FreeBuddy.cmd       # 摘掉面板、释放唤醒锁、停守护进程
```

数据目录：`%APPDATA%\FreeBuddy\`（控制台自己的 Chromium 档案在 `desktop\` 子目录里，
不跟账号备份混在一起）。

---

## 装成软件（桌面版）

```
npm run assets        # 用 Pillow 重绘 logo / 图标 / 安装页图（改设计后跑）
npm run desktop       # 开发模式起控制台
npm run build:win     # 出 release\FreeBuddy-Setup-<版本>-win-x64.exe（NSIS 安装包）
```

- 外壳在 `desktop/`：Electron 壳（`main.cjs` 三种模式 + 守护进程托管 + 托盘 + IPC，
  `preload.cjs` 只暴露窄接口，界面 `index.html` / `style.css` / `renderer.js` 沿用面板的靛蓝 token）。
  **进去模式下不创建任何窗口**，只在失败时把控制台亮出来让人看见原因。
- 品牌资产在 `build/`：`make-assets.py` 用 Pillow 程序化绘制，输出 `icon.ico`（多尺寸）、
  `installerSidebar.bmp`（安装页左侧 164×314 大图）、`installerHeader.bmp`（页眉 150×57）、
  `logo-preview.png`（预览图）。**不含任何需要密钥的图 API**。
- 安装页：`build/installer.nsh` 里定义 `customWelcomePage` 宏插一张欢迎页（electron-builder 的
  辅助式向导本身没有欢迎页），配 `installerSidebar` 就是那一页左侧的 logo 大图；
  `build/license.txt` 是「使用说明与安全边界」页。
- 开机自启：**默认不写**（跟 WorkDaddy 一样，点图标才起作用）；控制台「关于」页可以开，
  开的是 `"<安装目录>\FreeBuddy.exe" --tray`（托盘常驻、不主动接管 WorkBuddy），卸载自动删。
- 进去模式拉起的 WorkBuddy 首窗常常是**最小化**的（HWND 落在 -32000 那一带），所以前台化那步是
  `ShowWindowAsync(hwnd, SW_RESTORE)` + `SetForegroundWindow` 再 `AppActivate`，窗口没建好就重试。
- 守护进程用 **Electron 当 Node 跑**（`ELECTRON_RUN_AS_NODE=1`）。因此 `src/wbproc.mjs`
  在拉起真客户端前会把 `ELECTRON_RUN_AS_NODE` 从子进程环境里摘掉 —— 否则 WorkBuddy.exe
  会以 Node 模式启动并立刻退出。

数据目录：`%APPDATA%\FreeBuddy\`

```
accounts\<uid>.info          账号登录备份（官方加密的内容原样保存）
meta.json                    账号备注/排序/主账号
credential-cache.json        能读到明文 token 时另存一份，避免被加密后丢失取数能力
account-data-cache.json      各账号最近一次成功的官方数据（切走后仍能显示）
checkin-cache.json           按天的签到结论
settings.json                面板开关与休眠策略
logs\daemon.log              守护日志
```

环境变量：`FB_PROFILE`（`workbuddy-cn` / `workbuddy-ai`）、`FB_DATA_DIR`、`FB_WORKBUDDY_EXE`、`FB_VERBOSE=1`。

---

## 结构

```
src/config.mjs       档案与本机路径（客户端、登录文件、端口）
src/cdplink.mjs      自研 CDP 客户端（零依赖，用 Node 内建 WebSocket）
src/injector.mjs     把面板打包成脚本，经 Runtime.evaluate 注入
src/panel/           面板本体（Shadow DOM；panel.css 定义全部设计 token）
src/daemon.mjs       本地 API + CDP 协调 + 自动备份 + 定时器
src/authstore.mjs    登录文件解析/备份/切换/删除/加密导入导出
src/wbdecrypt.mjs    解密官方静态加密（$wbEncrypted 信封）
src/keytool.cjs      以 ELECTRON_RUN_AS_NODE 跑，向父进程交回 at-rest 密钥
src/official.mjs     官方接口取数（渲染进程通道 + 直连通道）
src/tokens.mjs       本机会话记录的 Token 统计
src/loginflow.mjs    无感登录（auth/state → 浏览器授权 → auth/token → login/account）
src/wbproc.mjs       Windows 进程控制（精确匹配、优雅退出）
src/power.mjs        休眠策略
src/tokens/…         （见上）
src/launcher.mjs     启动器；src/stop.mjs 停止器
tools\               真机探针与截图工具（改面板后用它们验收）
```

---

## 安全边界

- 守护进程**只监听 127.0.0.1**，所有接口要 `X-FreeBuddy-Token`（本机随机 32 字节）。
- 静态加密密钥取自 WorkBuddy 自带的 Electron 绑定，**只在内存里**，不落盘、不进日志。
- `credential-cache.json` 会保存可用的 token（与官方登录文件同等级别的秘密，权限 0600）；
  不需要账号直连取数时可以删掉它，代价是加密账号要切过去才能看数据。
- 面板不收集、不上传任何数据；Token 统计只读本机 `~/.workbuddy/projects` 下的会话记录。

---

## 已知边界

- 官方客户端升级后，如果登录文件结构或 DOM 锚点大改，取数/注入可能需要跟着调整。
- 面板统计的是**本机会话记录**，官方 App 里的「使用统计」是账号维度的全量接口数据，两者口径不同。
- 目前只实现 Windows。
