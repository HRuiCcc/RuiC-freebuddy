# FreeBuddy macOS 端设计方案

> 目标：让 FreeBuddy 在 Mac 上跑起来（多账号秒切、跨账号积分签到、Token 热力图、免打扰、休眠策略），
> **Windows 行为一行不许变**。本文只讲设计与落地路径，不含"要不要做"的讨论。
> 依据：2026-10-11 通读 `freebuddy/src`、`freebuddy/desktop`、官方 Download-History 页。

---

## 落地结果（2026-10-12 实测）

**P0 → P1 已完成并通过真机验收**，与本文预测的差异逐条记录在这里：

| 项 | 预测 | 实测 |
|---|---|---|
| R1 at-rest 密钥（成败手） | 未知，mac 包里绑定是否同名可用待验 | **✓ 可用**。`keytool.cjs` 以 `ELECTRON_RUN_AS_NODE=1` 跑包内二进制拿到 `FBKEY`（payload v1，keyLen=44），守护进程日志「已取得静态加密密钥」 |
| R2 登录文件路径 | 候选三个，需扫 | **✓ 命中第一个候选**：`~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info` |
| R3 `ps -o comm=` 是否给全路径 | 可能退化为 basename | **✓ 给全路径**，精确全等匹配可用；Helper 进程路径带 ` Helper.app`，天然不误伤 |
| mac 客户端版本 | 5.6+（以为静态加密已生效） | **实测 5.5.6**，登录文件**根本没有 `$wbEncrypted` 信封**（顶层键 `account`/`auth`/`accounts`，明文）。⇒ 解密链路是**备用**而非必需 |
| 可执行文件路径 | `Contents/MacOS/WorkBuddy` | **实际叫 `Electron`**（按 `CFBundleExecutable`）。⇒ 代码里读 Info.plist 取，不写死产品名 |
| 数据库列 | 与 Windows 一致 | **不一致**：5.5.6 的 `sessions` 没有 `transport`，`automation_runs` 没有 `failure_code`/`reason_code`。⇒ 新增 `wbdb.selectList()`，查询按「想要的列 ∩ 实际存在的列」拼 |

额外结论：

- **`src/platform/` 平台层已接线**：`index.mjs` 选实现，`win.mjs` 是**薄转发**（直接 re-export 未被
  改动的 `wbproc.mjs` / `power.mjs`，Windows 行为等于零改动），`mac.mjs` 用系统自带命令实现。
  调用方（daemon / launcher / stop）只把 import 指向 `platform/index.mjs`，函数体一行未改。
- **控制台外壳已整体删除**（`desktop/`、`build/` 与打包配置）—— 这个项目只保留注入面板。
  因此本文 §4.5、§4.6 与 §7 的 P2/P3 **不再适用**，留作历史记录。
  mac 侧的替代品：`scripts/Start-FreeBuddy.command` / `Stop-FreeBuddy.command`（等价 Windows 的 `.cmd`）；
  前台化由 `launcher.mjs` 收尾调用 `platform.focusApp()` 完成。
- 验收证据：面板在 WorkBuddy 5.5.6 里注入成功（`{"host":true,"api":"object","fab":true}`）、
  自动备份账号、跨账号积分与签到状态取到、`/api/sessions` 返回真实会话、stop 路径能摘面板并停守护进程。

---

## 0. 结论（先看这段）

1. **可做，工作量小。** 现有代码约 **90% 平台无关**：CDP 客户端、面板、账号解析、静态解密、
   官方取数、登录流、Token 统计全都不用动。Windows 专有面收敛在 **8 个点**（见 §2）。
2. **mac 版 WorkBuddy 确实存在**，且版本落在"5.6+ 静态加密"之后 —— 我们依赖的解密链路前提成立（§1）。
3. **唯一的真不确定项**：`electron_browser_workbuddy_storage` 这个 Electron 私有绑定在 mac 包里是否同名可用。
   到 Mac 上第一件事就是验它（`tools/probe-mac.mjs --key`）。验不过，加密账号只能"切过去才看得到数据"，
   其余功能不受影响。
4. **推荐路线**：新增一层 `src/platform/`，mac 实现单开一个文件；**先不重写现有 Windows 文件**，
   避免把在用的 Windows 端搞坏。落地顺序：P0 探针 → P1 平台层+路径 → P2 控制台外壳 → P3 打包（§7）。

---

## 1. 可行性事实（已核实）

| 项 | 事实 | 来源 |
|---|---|---|
| 是否有 mac 包 | 有，`.dmg`，分 Apple 芯片与 Intel 两档 | 官方 Download-History |
| 下载地址形态 | `https://download.codebuddy.cn/workbuddy/saas/darwin-{arm64,x64}/WorkBuddy-darwin-*.dmg`，镜像 `acc-1258344699.cos.ap-guangzhou.myqcloud.com`（同路径） | 同上 |
| 版本覆盖 | `WorkBuddy-darwin-arm64-5.7.7.40774747-2e8619da.dmg` 这类命名，5.0.x → 5.7.x 每档都有 mac 包 | 同上 |
| 技术栈 | 同为 Electron（Windows 侧 `resources/app.asar` + Electron 全套 dll 印证，版本 5.7.x） | 本机安装目录 |
| 安装形态 | `.app` 拖进 `/Applications`；可执行文件在 `Contents/MacOS/` | macOS 常规 |
| 关键结论 | 同一份 asar、同一个 Chromium ⇒ **CDP 注入 + 面板 + 账号解析 + 官方取数整套照搬**，只是路径与进程控制换皮 | 推理 |

---

## 2. 要改的边界（全在这张表里）

| # | 文件 | Windows 专有 | mac 对应 |
|---|---|---|---|
| 1 | `src/config.mjs` | `LOCALAPPDATA`/`APPDATA`、`WorkBuddy.exe`、`appDir` | `~/Library/Application Support`、`/Applications/WorkBuddy.app` |
| 2 | `src/wbproc.mjs` | powershell 查进程 / `taskkill` / `rundll32` 开链接 | `ps` 精确匹配 + `kill` / `open` |
| 3 | `src/power.mjs` | powershell + `kernel32!SetThreadExecutionState` | `caffeinate` |
| 4 | `src/daemon.mjs:917` | `explorer.exe <dir>` | `open <dir>` |
| 5 | `src/stop.mjs:34-44,85` | `Get-NetTCPConnection` + `Stop-Process` | `lsof`，或直接读 `.daemon.lock` 里的 pid |
| 6 | `src/wbdecrypt.mjs:55` | 以 `.exe` 跑 `keytool.cjs` | 只需 `exePath()` 返回 mac 路径，**代码本身不用改** |
| 7 | ~~`desktop/main.cjs`~~（已删除） | `reg.exe` 自启 / `WScript.AppActivate` 焦点 / 安装目录 | `app.setLoginItemSettings` / `open -a` / mac 目录；另需一个最小 mac 应用菜单 |
| 8 | `scripts/*.cmd`（已补 `.command`）、~~NSIS 打包~~ | `.cmd` + `.ico/.bmp` | `.command` 或直接双击 `.app`；打包换 `dmg` |

**完全不用碰（平台无关）**：`cdplink.mjs`、`injector.mjs`、`src/panel/*`、`authstore.mjs`、
`official.mjs`、`loginflow.mjs`、`tokens.mjs`、`checkincache/tokencache/datacache`、`keytool.cjs`。

> 说明：面板已经拿到 `platform: process.platform`（`injector.mjs:37`），文案/布局无需为 mac 分叉；
> `loginflow.mjs:86` 的 `platform` 参数是**产品标识**（`workbuddy` / `workbuddy-ai`），不是操作系统 —— 别改。

---

## 3. 平台抽象层

### 3.1 目录

```
src/platform/index.mjs   # 按 process.platform 选实现并统一导出
src/platform/win.mjs     # 现有 wbproc.mjs + power.mjs 的逻辑原样搬进来（行为逐字不变）
src/platform/mac.mjs     # 新写（本次已附参考实现）
```

### 3.2 统一接口（两个实现必须都给全）

```
paths(profile)                     -> { appBundle?, exe, dataDir, authFile, workBuddyUserData }
findRunning(exe?)                  -> [{ pid, path }]
stopExact(pids, log)               -> boolean
launchWithCdp(port, exe?)          -> boolean
cleanChildEnv(env)                 -> env          // 摘掉 ELECTRON_RUN_AS_NODE 等
openInBrowser(url)                 -> boolean      // 只放行 http(s)
openPath(p)                        -> boolean
focusApp(profile)                  -> string
pidsOnPort(port)                   -> number[]
power.getMode/isHolding/setMode/setDisplaySleep
autostart.get()/set(on)            -> boolean      // mac 优先走 Electron API
```

### 3.3 落地手法（关键：不破坏 Windows）

`win.mjs` 里的函数体**逐字复制**现有 `wbproc.mjs` / `power.mjs`，只是换个 import 路径；
`daemon.mjs` / `launcher.mjs` / `stop.mjs` / `main.cjs` 把 `import * as wbproc from './wbproc.mjs'`
改成 `import * as wbproc from './platform/index.mjs'`。改完在 Windows 上跑一遍
`node src/launcher.mjs` + `node src/stop.mjs` 冒烟（本机 WorkBuddy 在装、现成环境），确认逐条日志与改前一致。

---

## 4. macOS 逐项映射（可直接抄）

### 4.1 路径

| 用途 | mac 路径 |
|---|---|
| 应用 | `/Applications/WorkBuddy.app`（退路 `~/Applications/WorkBuddy.app`） |
| 可执行 | `/Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy` |
| 登录信息 | **待探针确认**。候选：`~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info`、`~/Library/Application Support/WorkBuddy/...`、`~/.codebuddy/...` |
| 会话记录（Token 统计） | `~/.workbuddy/projects`（homedir 基准，**与 Windows 相同**） |
| FreeBuddy 数据 | `~/Library/Application Support/FreeBuddy`（= Electron 的 `app.getPath('userData')`） |

> Windows 那份在 `%LOCALAPPDATA%\CodeBuddyExtension\...`，注意是 **Local** 而不是 Roaming ——
> 说明官方没用 Electron 默认的 `appData`，所以 mac 路径**不能靠推断**，必须扫（见 §6/R2）。
> 另外观察到官方自己会轮转备份：`workbuddy-desktop.<ISO时间>.<pid>.<uuid>.info`，我们那份自动备份正好互补。

### 4.2 进程控制

```bash
# 精确找主进程：mac 上 `ps -o comm=` 给的是完整可执行路径，
# 而 Helper 进程的路径带 " Helper.app"，精确全等匹配天然只命中主进程
ps -Ao pid=,comm= | awk -v t="/Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy" '$2==t{print $1}'
```
- 结束：先 `kill -TERM <pid>`，3 秒后仍在的 `kill -KILL <pid>`（等价 Windows 的"先 taskkill 后 /F"）。
- 拉起：`open -a "/Applications/WorkBuddy.app" --args --remote-debugging-port=9222`。
  **前提是先停掉旧实例**（`open` 对已在运行的 app 只做激活、不会加参数）—— 现有 launcher/switch 流程正是"先停再起"，天然吻合。
- 焦点：`open -a "/Applications/WorkBuddy.app"`（等价 `WScript.AppActivate`）。
- 按端口找 pid：`lsof -nP -iTCP:<port> -sTCP:LISTEN -t`；不过 `stop.mjs` 其实可以直接读 `.daemon.lock` 里的 pid，比查端口更稳。

### 4.3 电源（休眠策略）

`caffeinate` 就是 mac 上的 `SetThreadExecutionState`：

| 语义 | 命令 |
|---|---|
| 禁止空闲/系统休眠 | `caffeinate -i -s` |
| 同时禁止息屏（`displaySleep=true`） | `caffeinate -d -i -s` |
| 释放 | kill 掉这个子进程 |
| 防"守护进程崩了锁没放" | 加 `-w <守护进程pid>`：守护进程一退，caffeinate 自己退 |

- 与 Windows 语义差异：`-s` 只在**接电**时生效（电池下会被系统忽略，这是 mac 自身规则）；
  **合盖休眠（clamshell）caffeinate 挡不住**，需要在方案里写明这一条已知边界。
- 默认档位映射不变：`allow` = 不持锁；`keep` / `until-done` = 持锁。

### 4.4 开机自启

- **首选 Electron 原生**：`app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true })`，
  查：`app.getLoginItemSettings().openAtLogin`。macOS 13+ 走 SMAppService，Electron 已封装。
- 退路（脱离 Electron 也能自启）：写 `~/Library/LaunchAgents/com.freebuddy.console.plist`，
  `RunAtLoad=true` + `ProgramArguments=[<FreeBuddy.app>/Contents/MacOS/FreeBuddy, --hidden]`。
- `--hidden` 在 mac 上还要额外 `app.dock.hide()`，否则隐藏启动仍会在 Dock 留图标。

### 4.5 控制台外壳（`desktop/main.cjs`）的 mac 适配 —— ⚠️ 已废弃（控制台整体删除，留作历史）

1. **托盘图**：菜单栏用 22pt 模板图（`trayTemplate.png` + `@2x`）+ `setTemplateImage(true)`，否则浅色菜单栏下看不见。
2. **应用菜单**：现在 `Menu.setApplicationMenu(null)` 在 mac 上会导致**没有 Cmd+Q / Cmd+C**。
   mac 分支要给一个最小模板（App 子菜单 + Edit 子菜单）。
3. `windowsHide: true` 在 mac 上是空操作，可保留不用改。
4. `spawnNode()` 用 `process.execPath + ELECTRON_RUN_AS_NODE=1` 拉起守护进程 ——
   mac 上 `process.execPath` = `.../FreeBuddy.app/Contents/MacOS/FreeBuddy`，**同一套写法直接可用**。
5. `app.on('window-all-closed')` 已是"不退出"，符合 mac 习惯。

### 4.6 打包与签名 —— ⚠️ 已废弃（只保留注入面板，不再打包）

- `electron-builder` mac target：`['dmg', 'zip']`，`category: public.app-category.utilities`，
  `icon: build/icon.icns`（可由现有 `icon.png` 自动生成），`identity: null`（**强制不签名构建**，省掉证书环节）。
- arch：默认按他的 Mac 出 `arm64`；要一份通用的就 `universal`（体积翻倍）。
- Gatekeeper：不签名 =.app 首启被拦。自用两条路：
  `codesign --force --deep -s - FreeBuddy.app`（ad-hoc 签名）或首次右键→打开；
  分发过的话再加 `xattr -dr com.apple.quarantine FreeBuddy.app`。
- **不做 notarization、不上架** —— 与"禁止外发"红线一致。
- Windows 那套 NSIS 素材（`installerHeader.bmp` / `installerSidebar.bmp`）mac 用不上，dmg 背景图另做。

### 4.7 权限

本方案只用 **127.0.0.1 回环 + CDP**，**不需要** 辅助功能（AX）、不需要屏幕录制、不需要完全磁盘访问 ——
这点比上游干净，也是 mac 上少踩坑的关键。唯一可能弹的是首次 Gatekeeper 的"无法验证开发者"。

---

## 5. 启动脚本

`.cmd` 在 mac 上无效。给一份等价物（无需 Electron 也能起）：

```bash
#!/bin/bash
# scripts/Start-FreeBuddy.command   （chmod +x 后双击可跑）
cd "$(dirname "$0")/.."
node src/launcher.mjs || { echo "出错，日志在 ~/Library/Application Support/FreeBuddy/logs/daemon.log"; read -n1; }
```
`Stop-FreeBuddy.command` 同理调 `src/stop.mjs`。

---

## 6. 风险与 Mac 侧待验清单（最重要）

| 级别 | 项 | 怎么验 |
|---|---|---|
| **高** | R1 `electron_browser_workbuddy_storage` 绑定在 mac 包上是否同名可用 | `node tools/probe-mac.mjs --key`（以 `ELECTRON_RUN_AS_NODE=1` 跑 app 内二进制 + `keytool.cjs`，看有没有 `FBKEY`） |
| 中 | R2 登录信息文件确切路径 | `node tools/probe-mac.mjs --auth`（在若干候选根下扫 `**/auth/*.info`） |
| 中 | R6 mac 版是否也"重启才能切号" | 复用现有 reload 后按 `Uin` 校验、失败即重启的回退逻辑，无需提前假设 |
| 低 | R3 `ps -o comm=` 是否给完整路径 | 探针 `--ps`，若只给短名则退化为 basename 匹配 + 排除 `* Helper*` |
| 低 | R4 `caffeinate` 合盖挡不住 | 文档标注，不修 |
| 低 | R5 Gatekeeper 首次拦 | ad-hoc 签名 + 右键打开 |

**R1 是整个 mac 端的成败手**：过不了不影响功能可用性（只是加密账号要切过去看数据），
所以设计上不强依赖它 —— `pullOneAccount` 里"没明文 token → 标记 locked"的既有分支已经兜住了。

---

## 7. 分阶段落地计划

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0** | 在 Mac 上装 WorkBuddy（官方 dmg）+ 跑 `tools/probe-mac.mjs` 全量 | 拿到 R1/R2/R3 的确定结论；`--json` 报告存档 |
| **P1** | 建 `src/platform/`（win 原样搬 + mac 新写）；`config.mjs` 加 mac 档案；`wbproc`/`power`/`stop`/`daemon:917` 改 import | Windows 冒烟逐条日志与改前一致；Mac 上 `node src/launcher.mjs` 能注入出面板 |
| **P2** | ~~`desktop/main.cjs` 的 mac 分支（自启 / 焦点 / 菜单 / 托盘模板图 / dock.hide）~~ **已废弃** | 控制台外壳整体删除，不再需要 |
| **P3** | ~~`electron-builder` mac 配置 + `icon.icns` + dmg 构建 + ad-hoc 签名~~ **已废弃** | 同上；mac 侧改为双击 `scripts/Start-FreeBuddy.command` |

---

## 8. 附：参考实现

- `src/platform/mac.mjs` —— 本方案 §3.2 接口的 mac 实现（**新文件，未接线，不影响 Windows**）。
- `tools/probe-mac.mjs` —— Mac 侧自检探针，专答 §6 的 R1/R2/R3。

接线方式（P1 阶段做）：把现有 `import * as wbproc from './wbproc.mjs'` 换成
`from './platform/index.mjs'`，并让 `config.mjs` 按 `process.platform` 返回对应 `PROFILES` 路径。
