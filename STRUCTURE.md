# KHarness 源码结构表

给「自己动手改源码」用的一张地图：每个文件干什么、改动会牵动哪里、改完要做什么才生效。
规模数字是 2026-09-26 的 `wc -l`，用来看体量分布，不必对得上。
更细的历史决策与踩坑在 `HANDOVER.md`（按轮次记），本文只讲「东西在哪」。

## 0. 总览

| 层 | 目录 | 入口 | 规模 | 改完怎么生效 |
| --- | --- | --- | --- | --- |
| 后端 | `server/` | `server/index.js`（Express 5，只绑 127.0.0.1） | 15602 行 / 34 个 utils | **必须重启进程**；改数据库内容不用重启（无缓存直查 SQLite） |
| 前端 | `client/src/` | `client/src/main.js` → `App.vue` → `layouts/AppShell.vue` | 19358 行 | `cd client && npm run build`（或 `npm run build`）；装机版还要把 `client/dist` 同步过去 |
| 桌面外壳 | `desktop/` | `desktop/main.js`（Electron 主进程）+ `preload.js` | 约 660 行 | 重启外壳；装机版在 `resources/app.asar` 里，**要重打 asar** |
| 打包 | `desktop/pack-prep.js` + `installer/KHarness.iss` | 两步：`electron-builder --win dir` → `ISCC` | — | 见第 5 节 |
| 数据 | `%APPDATA%\KHarness\`（装机版）/ `server/kh.db`（手跑的 8317） | `server/database.js` | — | 不在仓库里，**绝不进包** |

路由挂载（`server/index.js`）：`/api/ai/remote` → `routes/remote.js`；`/api/ai/term` → `routes/terminal.js`；`/api/ai` → `routes/ai.js`；`/api/settings` → `routes/settings.js`；其余 `/api/*` 走兜底 404；生产模式再 `express.static(client/dist)`。前端 axios 的 `baseURL` 就是 `/api`（`client/src/api/index.js`）。

## 1. 后端 `server/`

| 文件 | 行 | 干什么 | 改它的时候注意 |
| --- | --- | --- | --- |
| `routes/ai.js` | 5670 | 主战场：会话/项目/模型/提供商、`POST /api/ai/chat` 的 SSE、Agent 工具循环、AGENTS.md 读写、托管与监工入口、回收站/导出导入 | 单文件巨无霸。新工具优先去 `toolgate` 注册，别在这堆里另起一套；SSE 帧字段见 HANDOVER「调试约定」 |
| `routes/remote.js` | 288 | SSH 主机 CRUD + 远程会话切换 | 表名是 `ai_remote_hosts`（不是 ssh_hosts） |
| `routes/terminal.js` | 99 | 终端抽屉：SSE 输出流 + POST 输入 | 与 `utils/term.js` 配对 |
| `routes/settings.js` | — | 设置读写；**白名单校验**：一个非法键整条 PUT 400 且什么都不写 | 加界面偏好就往这里加键，前端配 `stores/prefs.js` 的 `FIELD_TO_KEY` |
| `database.js` | 397 | 建表/迁移/连接 | 动表结构先想清楚老库升级路径 |
| `config.js` | — | 端口、数据目录、token | — |
| `utils/toolgate.js` | 249 | 工具统一注册与开关层（内置 + MCP 两组都往这注册） | 加工具的正门 |
| `utils/apitools.js` | 1414 | 外部 API 工具集（天气/GitHub/OCR/Base64/QQ…），默认全关 | 每个工具的开关在「设置 → 外部 API 工具」 |
| `utils/orchestrator.js` | 676 | 托管：监督者派活 → 工作者执行 → 回报 | 下发给主智能体的那条路在这 |
| `utils/subagent.js` | 485 | 子智能体（强制只读、默认关） | 只回结论不回中间过程 |
| `utils/protocols.js` | 490 | 上游协议适配：内部统一 OpenAI 形状 | 加新提供方协议先过这里 |
| `utils/mcp.js` | 491 | MCP 客户端 | — |
| `utils/term.js` | 459 | 终端会话层：本地 node-pty(ConPTY) / 远程 SSH shell | 杀进程树走 `procguard` |
| `utils/remote.js` / `remoteexec.js` / `bgremote.js` | 443/287/113 | 远程通道 / 远程会话下的工具执行层 / 远端后台任务 | 远程改动要跑 `_tmp_ssh/real_probe.js` 真机探针 |
| `utils/sidebar.js` | 437 | 侧栏提问引擎（只读、硬锁工作目录、流式） | — |
| `utils/extools.js` | 374 | 后台任务 4 个 + 长期记忆 3 个 + ask_user | — |
| `utils/undo.js` | 339 | 文件操作撤销：小快照进库、大快照进 `.kh-undo/` | 快照目录必须在数据目录 |
| `utils/supervisor.js` / `checks.js` | 318/213 | 监工执行器（跑验收项、出报告、通知） / `kh.checks.md` 解析 | — |
| `utils/inapp.js` | 305 | 内置浏览器（动作队列 HTTP 通道） | 视图本体在 `desktop/main.js` 的 BrowserView |
| `utils/agentsmd.js` | 174 | AGENTS.md/AGENT.md 收集与读写（200KB 上限、SHA-256 热加载、原子写） | 四条对话路都要注入，见第 6 节 |
| `utils/thinking.js` | 187 | 思考内容剥离/分级 | — |
| `utils/bg.js` / `shellcmd.js` | 182/120 | 后台任务 / Shell 拼参（两条路径共用） | 改超时行为一起改 |
| `utils/permissions.js` | 191 | 审批规则：命令/路径/关键词 × 三档模式 | — |
| `utils/trash.js` / `recycle.js` | 200/— | 回收站（会话/项目快照可恢复）/ 文件删除回收 | 回收站里的库副本不许同步进包 |
| `utils/respond.js` | 小 | 统一响应助手 + 异步路由包装；`errDetail()` 把异常拆成人能看的详细原因（NameError/errno/syscall/HTTP 状态，顺 `cause`/`errors` 再下一层） | 新失败路径的报错都从这出，前端口径是 `failErr/toastErr/errFull` |
| `utils/schemas.js` | 小 | **工具参数 schema 的单一来源**：既做入参校验，也给「文本协议」模型生成格式说明 | 加工具参数改这里，别在调用点各写一份 |
| `utils/sanitize.js` | 小 | 纯文本清洗：去尖括号防标签注入、去控制字符、截断 | — |
| `utils/dbio.js` + `sqlitefile.js` | 133+ | 整库导出 / 暂存导入：只落盘 + 打标记，真正替换发生在下次进程启动最开头 | 不能热替换 —— 全站共用同一个 better-sqlite3 连接，换文件会让几十条已编译 statement 指向不存在的库 |
| `utils/recycle.js` | — | 把文件丢进系统回收站：Windows 走 Shell/VisualBasic API，Linux 走 trash-cli/gvfs，macOS 走 Finder | 全失败时由调用方决定退回普通删除（本项目：先撤销快照再退删） |
| `utils/sanitize.js` / `schemas.js` / `texttool.js` / `memory.js` / `notify.js` / `procguard.js` / `dbio.js` / `sqlitefile.js` / `userdir.js` | 小 | 脱敏 / JSON schema / 文本工具兜底 / 记忆表 / Windows 通知 / 杀进程树 / 库读写 / 数据目录定位 / 用户目录（桌面） | `notify.js` 的文本走环境变量，绝不拼进命令串 |

## 2. 前端 `client/src/`

| 目录 | 规模 | 内容 |
| --- | --- | --- |
| `main.js` `App.vue` `router/` | 50 + 48 | 启动：装报错台账 → 拉 `uiPrefs` → 挂 `html.kh-frame`；`App.vue` 只有 `ThemeBackdrop` + `WindowBar` + `.app-root`（**WindowBar 必须是 `.app-root` 的兄弟**，否则弹窗遮罩会盖住三颗键） |
| `layouts/AppShell.vue` | 202 | 左导航（滑动高亮胶囊）+ `shell-main`；聊天页是全宽（`shell-chat`） |
| `features/chat/` | 19 文件 / 10.4k 行 | 主界面。`ChatPage.vue`(2138) 布局与顶栏、`chatStore.js`(1025) 状态与 SSE、`ChatComposer.vue`(1045) 输入框与模型/审批/思考下拉、`ChatDock.vue`(1142) 右栏、`ChatRail.vue`(581) 左栏、`TerminalDock.vue`(526) 终端浮窗、`BrowserPanel.vue`(799) 内置浏览器、`ChatMessage.vue`(737) 消息渲染、`ModelPicker.vue`/`ContextDialog.vue`/`RemoteFiles.vue`/`RemoteHostModal.vue`/`SidebarAI.vue`，以及 `chatStream.js`/`terminalStore.js`/`remoteStore.js`/`sidebarStore.js`/`superviseStore.js` |
| `features/settings/SettingsPage.vue` | 1660 | 设置全部页签（常规/外观/技能/工具/MCP/权限/实验室/关于） |
| `features/models/` | 1318 | `ModelsPage.vue`（选择列表）+ `ManageModelsPage.vue`(1085)（管理：单价/延迟测试/批量导入） |
| `features/control/` `usage/` `trace/` | 160/270/154 | 控制台 / 用量 / 轨迹（轨迹页保留路由但导航不占格） |
| `stores/` | 478 | `prefs.js`（**服务端持久化的界面偏好单一来源**，`FIELD_TO_KEY` 加键处）、`theme.js`（`<html data-theme>`）、`toast/confirm/prompt/browser/recycle` |
| `ui/` | 1755 | 自研控件：`KModal/KTabs/KDropdown/KButton/KInput/KEmpty`、`WindowBar.vue`(296 自绘顶栏：标识+菜单+三颗键)、`ThemeBackdrop/StarField`、`AgentsEditor.vue`、`useSlidingPill.js`、`useBarOverflow.js`（横栏挤不挤的实测降级）、`useEdgePeek.js`（贴边临时展开） |
| `utils/` | 1408 | `errlog/errText`（报错口径）、`whaleWidget.js`(876 小鲸鱼挂件)、`highlight.js`、`appFont/format/sound/toast` |
| `styles/` | 1040 | `tokens.css`（尺寸/动效/弹层皮肤 `.title-menu`）、`themes.css`（六套主题的 `--aurora-*`/`--star-*` 等令牌）、`framebar.css`（无框顶栏配套，全挂 `html.kh-frame`）、`hljs.css` |
| `api/index.js` | 241 | axios 实例 + 各域接口聚合 |

## 3. 桌面外壳 `desktop/`

| 位置 | 干什么 |
| --- | --- |
| `main.js` 顶部常量 | `ROOT`、`resolveDataDir()`（`KH_DATA_DIR` 优先，否则 `%APPDATA%\KHarness`）、`LOG_FILE`、**`FRAMELESS`（自绘顶栏总开关，一处定生死）**、`EDIT_COMMANDS`/`clampZoom`（菜单动作白名单） |
| 端口那一段 | `PORT_FILE`=`<数据目录>/desktop-port.json`、`savedPort/savePort/pickPort/retryRandom` —— 端口一变 localStorage 就换一套，界面偏好全回默认，别动 |
| `startServer()` | 用随包的 `runtime/node.exe` 拉 `resources/server/app/index.js`；退出码 2 = 请主进程再拉一次（导入数据库走这条） |
| `createWindow()` | `frame:!FRAMELESS`、`additionalArguments:['--kh-frameless=…']`、`before-input-event` 里落 Ctrl+W/R/+/-/0、`bindWindowState`（maximize 事件里读 `getContentBounds()` 记一行） |
| `bview*` / `handleBview` | 内置浏览器是**主进程里的 BrowserView**（`<webview>` 被禁：guest 视口卡死 300×150），渲染进程只报位置、收发事件 |
| `ipcMain.handle` 清单 | `kh:restart`、`kh:db-location`、`kh:factory-reset`、`kh:cdp`、`kh:screenshot`、`kh:bview`、**`kh:win`**（minimize/toggle-maximize/close/state/edit+what/zoom+what/reload） |
| `preload.js` | `contextBridge` 暴露 `window.khDesktop = { isDesktop, platform, frameless, restartApp, dbLocation, factoryReset, cdp, screenshot, bview, onBview, winCtl(action,what), onWinState }` |
| `pack-prep.js` / `make-icon.ps1` | 打包前准备（见第 5 节） |

## 4. 界面偏好与提示词这两条链

| 链路 | 前端 | 后端 |
| --- | --- | --- |
| 界面偏好（终端字体/字号/高度、输入框高度、提示音、折叠…） | `stores/prefs.js` 的 `uiPrefs`（`load/save` + `FIELD_TO_KEY`） | `routes/settings.js` 白名单键，落 `settings` 表。**别再往 localStorage 加要紧偏好**（origin 带端口，端口一变就全丢） |
| 系统提示词 AGENTS.md | `ui/AgentsEditor.vue`（常规页编辑全局、项目右键编辑项目级） | `utils/agentsmd.js` + `GET/PUT /api/ai/agents-file`，目标只认 `scope=global` 或 `project_id`，**服务端绝不接受前端传的目录**。注入点四条：主聊天（开与不开 Agent 都要有）、侧栏提问、托管监工、子智能体 |

## 5. 打包链（v1.3.0 起就这么跑）

| 步 | 命令 | 产物 | 说明 |
| --- | --- | --- | --- |
| 1 | 改版本号（见下） | — | 两处 |
| 2 | `npm run build` | `client/dist` | 或 `cd client && npx vite build` |
| 3 | `node desktop/pack-prep.js` | `build/runtime/node.exe`、`build/icon.*`、`build/server-payload/app/` | 内含**隐私硬卡口**：命中 `kh.db*`/`.env`/`*.log`/`agent-skills/`/`node_modules/kharness/` 等直接 `exit(1)` |
| 4 | `npx electron-builder --win dir -c.directories.output=release-new` | `release-new/win-unpacked/` | **只用 `dir`**；`--win nsis` 那条 7za 单线程压 400MB，两小时不落盘，已弃用 |
| 5 | `"D:\Inno Setup 6\ISCC.exe" installer\KHarness.iss` | `release-new/KHarness-Setup-<版本>.exe` | 实测 13.4 秒 / 147MB |
| 6 | 冒烟 | — | `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /DIR=<临时目录> /TASKS="!desktopicon"` 装 → 起 → 验 → `unins000.exe /VERYSILENT` 卸 |

**版本号要改的两处**（改完产物名自动跟着变）：`package.json` 的 `"version"`、`installer/KHarness.iss` 的 `#define MyAppVersion`（同文件第 9 行注释里那个文件名顺手也改）。仓库里没有第三处写死版本的地方（关于页不显示版本号）。

## 6. 隐私与数据边界（改代码时最容易踩）

| 东西 | 在哪 | 规则 |
| --- | --- | --- |
| 真库 | `%APPDATA%\KHarness\kh.db`（装机版）、`server/kh.db`（手跑实例） | 含真实密钥与全部对话。**绝不进包、绝不 commit、绝不在它上面试「恢复出厂」** |
| 库备份 | `server/kh.db.bak-*` | 含密钥且没被 gitignore，`git add .` 前必看一眼 |
| `.env` | 仓库根 | 不在 `files` 白名单里，天然不进包 |
| 撤销快照 / 截图 / 监工托管报告 | 数据目录下 `.kh-undo/`、`browser-shots/`、`supervise/`、`hosted/` | pack-prep 一律跳过 |
| 内置技能笔记 | `server/agent-skills/` | 我自己的网站私密笔记，**已排除**；装机版技能列表为空没关系（`listSkills()` 对缺目录 catch 跳过） |
| 热同步 | `robocopy … /MIR`，涉及库要 `/XF kh.db*`（带星号） | `/E` 只增不删，删掉的文件会留尸体 |

## 7. 改完之后（我执行的部分）

你改完喊我，我按第 5 节跑：版本号 1.2.1 → **1.3.0**（`package.json` + `.iss` 两处）→ build → pack-prep（隐私卡口必须过）→ `electron-builder --win dir` → `ISCC` 出 `release-new/KHarness-Setup-1.3.0.exe` → 静默装到临时目录冒烟（起服务、验顶栏菜单与命中码、装前后 `kh.db` 字节数与 mtime 对比）→ 卸掉，只留安装包。
