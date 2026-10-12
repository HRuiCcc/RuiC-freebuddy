# FreeBuddy · 模型管理 / 会话分支迁移 / 自动化任务

> 2026-10-11 落。这三个页签都在 `src/`，面板入口在 `src/panel/`；`package.json` 只是描述文件，
> 这个项目**零 npm 依赖**，直接 `node src/launcher.mjs` 就跑。

## 一、模型管理（`src/models.mjs`）

读写官方 `<userData>/models.json`（本机 = `~/.workbuddy/models.json`）。

- 顶层两种形态都支持：纯数组 / `{models:[…]}`，**保形态写回**。
- **未知字段原样保留**（本机就有 `ocFerryOwner`、`onlyReasoning` 这类别人写进去的扩展字段）。
- 每次写前把原件复制到 `%APPDATA%\FreeBuddy\models-backup\`（滚动保留 20 份）。
- 「默认模型」写客户端 `settings.json` 的 `model` 字段：写法与官方一致（无末尾换行的 2 空格缩进），
  **实测设成同一个值时文件逐字节不变**（39790 B → 39790 B）。
- 探活：url 规约到 base 后依次试 `/models`、`/v1/models`、base（HEAD 失败退 GET，404 继续下一候选），
  只回网络/HTTP 结论，不回显 URL 参数与密钥。

| 接口 | 说明 |
|---|---|
| `GET /api/models` | 列表（密钥打码）+ 默认模型 + 备份份数 |
| `POST /api/models/save` | `{model, index}`：index 空=新增，否则就地更新 |
| `POST /api/models/delete` `/duplicate` `/reveal` | `{index}` |
| `POST /api/models/probe` | `{index}` → `{reachable, authorized, status, message}` |
| `POST /api/models/default` | `{id}` → 写 settings.json（带备份） |
| `GET /api/models/export` / `POST /api/models/import` | 明文 JSON 搬运（`{content, replace}`） |
| `POST /api/models/backups` | 列备份 |

## 二、会话分支 / 迁移 / 管理（`src/sessions.mjs` 纯逻辑 + `src/sessionops.mjs` 落库）

一个会话 = `projects/<slug>/<id>.jsonl` + 同名产物目录 + `workspace/sessions/<id>` + `tasks/<id>` +
`file-history/<id>` + `artifact-index/<id>.json` + `workbuddy.db` 的 `sessions` 行。

- **分支**：按「消息锚点」（有可见正文的 user/assistant 消息）截前缀。切点取**下一条 message 之前**，
  不会留下没有结果的 `function_call`；`user` 先抽 `<user_query>` 里的真话，注入块单独成条时跳过。
- **迁移**：整份记录复制到目标工作区/账号，逐行把 `sessionId`（和 `cwd`）重绑到新 id；
  目标工作区 slug 优先用 `projects/*` 里已有的（靠记录里的 `cwd` 反查），没有才按规则推导。
- 两者都**先写文件、后写索引行**；插行失败就把刚写的文件删掉。
- 前端上报「角色串 + 下标 + 完成时间」时，只有角色串一致才信下标，否则按完成时间匹配（容差 30 秒），
  对不上就报错 —— 不猜位置。
- 删除：记录文件 + 同名目录 + `workspace/sessions`、`tasks`、`file-history`、`artifact-index` + 索引行
  （顺带 `session_usage`）。

| 接口 | 说明 |
|---|---|
| `GET /api/sessions?q=&limit=` | 列表 + 数据库状态 + 工作区清单 |
| `GET /api/sessions/detail?id=` | 一条会话 + 锚点清单 + 记录统计 |
| `POST /api/sessions/fork` | `{id, anchor|latest|at, title}` |
| `POST /api/sessions/copy` | `{id, targetCwd, targetUid, title}` |
| `POST /api/sessions/rename` `/delete` | `{id, title}` / `{ids}` |
| `POST /api/sessions/export` `/import` | 加密归档（AES-256-GCM+scrypt+gzip，单包 ≤ 48 MiB） |
| `POST /api/open-path` | `{path}` 在资源管理器里打开 |

## 三、自动化任务引擎（`src/automations.mjs` + `src/wbdb.mjs`）

**关键事实：WorkBuddy 客户端自带常驻的本地调度器**（`LocalAutomationScheduler`，`~/.workbuddy/logs/automation.log`
里能看到 `started tickMs=30000 activeTickMs=5000`），它跑的是 `automations` / `automation_runs` /
`automation_runtime_state` / `automation_delivery_outbox` 四张表。任务体是「prompt + 模型 + 技能」，
到点由客户端自己起真实会话执行。

所以这里**不另造调度器**，而是读写同一张表，用官方同一套约定：

- `status`：`ACTIVE` / `PAUSED`
- `schedule_type`：`recurring` / `once`
- `rrule`：RFC 5545，`FREQ` ∈ `MINUTELY|HOURLY|DAILY|WEEKLY|MONTHLY|YEARLY`
  （各频率的必需段与客户端自带 `automation_update` 工具描述逐字对齐）
- `scheduled_at`（once，ISO 8601）、`cwds`（JSON 数组）、`model_id`、`skills_json`、`push_to_wechat`
- 我们写的行带 `owner_source='freebuddy'` 溯源；删除走软删（`deleted_at`）

「立即执行」= 把 `next_run_at` 置为当下，客户端下一跳派发。

**实测证据**（`logs/automation.log`）：

```
[LocalAutomationScheduler] run start: id=fb_mv3z3hpi_m4rjc8, name=FreeBuddy 验收任务
[LocalAutomationScheduler] dispatch automation fb_mv3z3hpi_m4rjc8 ...
[LocalAutomationScheduler] run finished: id=..., success=true
```

运行记录里 `output: "收到"`（与提示词要求一致），会话 `is_background_automation=1`。

| 接口 | 说明 |
|---|---|
| `GET /api/automations` | 任务 + 运行记录 + 模板 |
| `POST /api/automations/save` | `{task, id}` |
| `POST /api/automations/toggle` | `{id, enabled}` |
| `POST /api/automations/run` | `{id}` 立即执行 |
| `POST /api/automations/delete` | `{ids}` 软删 |
| `POST /api/automations/runs/clear` | 清运行记录 |
| `GET /api/automations/templates` | 5 个模板 |

## 四、验收怎么跑

```bash
node tools/fb-selftest.mjs        # 60 项：sqlite / 会话纯逻辑 / 分支迁移删除 / 模型增删 / 任务增删与调度计算
node tools/fb-live-check.mjs 4    # 真建一条任务，让客户端原生调度器跑一次，再自己清理
node tools/shot.mjs tools/x.png tasks   # 注入面板并截某个页签
node tools/fb-shot-fork.mjs      # 截分支弹窗
```

`fb-selftest.mjs` 写下的东西自己清掉（分支/迁移的会话、临时模型、临时任务），可反复跑。

## 五、已知边界

- 会话「分支」写的是**本机**记录 + 索引行；官方云端副本不受影响，客户端按本机记录重建会话这点
  在真机上已确认会话能创建成功、但**「客户端会不会按这份截断记录重建出界面」没有逐条比对过**。
- 模型/设置的写入需要客户端**重新载入配置或重启**才生效（没有文件监听）。
- `node:sqlite` 在 Node 24 是实验特性：加载时临时静音 `ExperimentalWarning`，不写日志。
- Windows 与 macOS 都已实现（2026-10-12 补 mac）。两边客户端**同版本号下数据库列也可能不同**，
  所以所有查询都按「想要的列 ∩ 实际存在的列」拼（`wbdb.selectList`），缺列只让那个字段取不到。
- macOS 实测：WorkBuddy 5.5.6 的 `sessions` 没有 `transport`、`automation_runs` 没有
  `failure_code` / `reason_code`；`automations` / `automation_runtime_state` 与 Windows 一致。
