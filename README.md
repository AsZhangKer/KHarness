# KHarness

本地单用户的 AI Agent Harness：Vue 3 前端 + Express 5 后端 + SQLite，外面套一层 Electron 桌面壳。
模型管理、Agent 工具调用、SSH 远程执行、终端、内置浏览器、监工/托管、用量与轨迹都在这里。
无鉴权、只监听 `127.0.0.1`，数据全在本机一个 `.db` 文件里。

当前版本 **1.4.8**。

## 两种跑法

| 形态 | 起来的方式 | 数据落哪 | 端口 |
|---|---|---|---|
| 桌面端（推荐） | `npm run desktop`（先构建前端再 `electron .`），或装好的 `KHarness.exe` | `%APPDATA%\KHarness` | 记住上一次（`desktop-port.json`），绑不上才换 |
| 纯 Web | `npm run setup && npm start` | `server/kh.db` | 默认 8317（`.env` 里 `PORT=` 改） |

主进程会自己拉起后端 Node 进程（带随包的 `runtime/node.exe`，因为 better-sqlite3 编的是 Node 22 ABI），
窗口是无框自绘顶栏：左边标识、右边文件/编辑/视图/检查更新四个菜单 + 三颗窗口键。
只有一个实例锁（`requestSingleInstanceLock`），第二个进程会安静退出 —— 点了没反应先查这个。

## 功能面

**模型与提供商**：OpenAI 兼容 / Anthropic 等协议接入、批量导入、延迟与可用性测试、单价与费用估算、
固定模型、异常模型折叠、收藏置顶、工具风格（native / text / auto）可批量改。

**Agent 回合**：工具调用循环（只读工具同批并发执行）、审批三模式（严格 / 默认 / 免除）+ 黑名单与「始终允许」、
Plan 任务清单、思考档位 `auto|off|low|medium|high|xhigh|max`、工具输出脱敏、中断/撤回/继续生成、
上下文用量以上游实测 `prompt+completion` 为锚点（不是只估正文），到 80% 那轮先压缩再回答、压缩过程是一张可见的卡。
`/insert` 预埋的提示词在**一批工具结果回喂完之后**注入上下文。

**工具**：文件读写与编辑（带彩色 diff 和一键撤销）、`grep`/`glob`、命令执行（超时会杀进程树）、后台任务四件套、
长期记忆、`ask_user` 弹选项、子智能体、外部接口类工具（天气 / GitHub / WHOIS / B 站 / OCR / 网页元数据 / Minecraft 等，按次计分）、
以及接进来的 MCP server（含一个操作真实浏览器的 MCP）。设置页「工具」标签按分组整组开关，无参工具可以就地试跑。

**远程**：SSH 连接管理（密码 / 私钥）、会话绑定远端主机、远端工具执行与后台任务、SFTP 文件面板、
远端删除进远端回收站、跨设备 rename 兜底。

**终端**：底部胶囊弹起的终端抽屉，本地走 node-pty、远程走 SSH shell，多标签、可浮动、设置持久化。

**内置浏览器**（桌面端）：右栏浏览器面板跟随 AI 的操作，基于主进程 BrowserView，带 screencast 帧流。

**监工与托管**：读项目里的 `kh.checks.md` 跑用例并出报告；托管模式是监督者派活、工作者执行、验收出口 `project_done`，
带护栏计数与撞线暂停。右栏各一个面板。

**侧栏提问**：只读分身，硬锁工作目录，流式回答，可以把结论一键投递进主对话（走 `/insert` 通道）。

**界面**：六套主题（暗色 / 亮色 / 米白 / 云母·蓝 / 云母·紫 / 星夜）、侧栏选中态是跟着滑的胶囊、
左右栏贴边临时展开、窄屏改抽屉、弹窗与页内动效统一、小鲸鱼挂件（设置里关）。

**数据**：设置页可导出/导入整个数据库、换数据目录、恢复出厂；撤销快照与终端归档都落在数据目录里。

## 开发

```bash
npm run setup        # 装 server/client 依赖 + 构建前端
npm run dev:server   # 后端 node --watch
npm run dev:client   # 前端 vite（代理 /api → 8317）
npm run desktop      # 构建前端并起 Electron 壳
npm run desktop:raw  # 跳过构建直接起壳
```

前端在 `client/src`（features/ 按域分、ui/ 是共用组件与组合式函数），后端在 `server`（`routes/ai.js` 是 Agent 主循环），
桌面壳在 `desktop/`（主进程 + preload + 窗口控制 IPC）。模块地图见 [STRUCTURE.md](STRUCTURE.md)，
工具调用约定见 [TOOLS-CALLING.md](TOOLS-CALLING.md)，MCP 接入见 [MCP.md](MCP.md)。

## 打 Windows 安装包

两步，别让 electron-builder 去压 NSIS（它调的是单线程 7za，在这台机器上跑到两小时不落盘）：

```bash
npm run dist:dir                                   # 构建前端 + pack-prep + electron-builder --win dir
"D:\Inno Setup 6\ISCC.exe" installer\KHarness.iss   # 十来秒出 release-new\KHarness-Setup-<版本>.exe
```

- `desktop/pack-prep.js` 负责把后端预演成 `build/server-payload/app/`（多垫一层目录，否则 extraResources 会把第一层 `node_modules` 整个剔掉）、
  拷 `build/runtime/node.exe`、必要时生成 `build/icon.ico`，并做**隐私硬卡口**：清单里出现
  `kh.db*` / `.env` / 日志 / `agent-skills/` / `weather-cities.json` / 指向仓库根的 junction 就打包失败退出。
- 版本号两处：根 `package.json` 的 `version` 与 `installer/KHarness.iss` 的 `MyAppVersion`。
- 出包前必须先杀掉正在跑的 `KHarness.exe`，否则 `--win dir` 覆盖不了 `win-unpacked`。

## 隐私边界

`kh.db`（含提供商密钥与全部对话）、`kh.db.bak-*`、`.env`、`desktop-port.json`、`build/`、`release*/`、
`_tmp_*` 与日志都在 `.gitignore` 里；安装包侧由 `pack-prep.js` 的卡口和 `.iss` 的 `Excludes` 兜第二道。
本项目没有联网更新服务，也不会主动往外发任何东西。

## 第三方与许可

「终末地」主题（第 80 轮）的视觉规格参考了两个以 **MIT** 许可发布的第三方项目，此处按许可要求保留版权声明：

- [ymh0000123/dsh-theme-endfield](https://github.com/ymh0000123/dsh-theme-endfield) — Copyright (c) 2026 ymh0000123，MIT
  —— 开屏加载板的结构与几何取自该项目。
- [NCreeper233/endfield-baker-chat](https://github.com/NCreeper233/endfield-baker-chat) — Copyright (c) 2026 NCreeper233，MIT
  —— 对话页的令牌分层、聊天框外框画法与实测数值参考该项目。
- [zaihuaovo/FlowerTerminal](https://github.com/zaihuaovo/FlowerTerminal) — 作者：再花（zaihuaovo），**上游未声明许可证**，承蒙允许取用，在此鸣谢
  —— 粒子组合图形效果（SVG 采样目标点 → 粒子缓动聚形 + 上浮粉尘）的做法参考该项目；
  我们只取算法与视觉思路，用无依赖的 2D canvas 重写，不引入其 Angular / GSAP / PixiJS，也不使用其任何美术素材。

三处引用都做了本地化重写（本项目前端是 Vue 3 + 纯 CSS，无 SCSS / 无构建期变量 / 无绝对定位画布），
数值出处逐条记录在仓库内。MIT 许可原文、引用范围与本项目的非官方声明见
[`design/endfield/ATTRIBUTION.md`](design/endfield/ATTRIBUTION.md)。

> 二次署名：FlowerTerminal 仓库内那两份「终末地风格」直播皮肤 CSS 实为 **B 站弹幕机活动皮肤**，
> 文件头注明原作者为 **@橙橙子君**（非再花本人）。我们从这两份里只取通用做法
> （缩放令牌、三重同参 text-shadow、纯 CSS 的 N 秒自退场、`order:` 重排），不复制其素材与配色。

另参考 **endspace** 主题（作者：澳求，**Apache License 2.0**）的侧边栏层级与选中态、字体设计
（展示体 + 正文 + 等宽的字重字距搭配）、按钮配色的灰阶-强调黄分工，以及 HUD 角标与扫描线等 UI 风格件。
按该许可要求：Apache License 2.0 全文副本随仓库发布于
[`design/endfield/APACHE-2.0.txt`](design/endfield/APACHE-2.0.txt)，版权与归属声明保留在
[`design/endfield/ATTRIBUTION.md`](design/endfield/ATTRIBUTION.md) 第四节，
**凡搬入其代码或数值的文件，顶部均按 §4(b) 显著标注改动内容**。

《明日方舟：终末地》（Arknights: Endfield）的游戏名称、标识、商标、设计语言与美术素材版权归
**鹰角网络（上海鹰角网络科技有限公司）**所有；本项目是非官方同人向致敬作品，与鹰角网络不存在任何隶属、
赞助或背书关系。**游戏截图、立绘、表情、官方字标与一切可辨认的官方图形均不进入本仓库与安装包**，
主题内的斜纹 / 点阵 / 等高线 / 切角等纹理全部由 CSS 生成，不含位图素材。
