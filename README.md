# KHarness

# KerHarness
本地 AI Harness：模型导入 / 延迟测试 / Playground 聊天（含 Agent 工具调用 / 项目与会话 / 任务面板 / 用量统计 / 轨迹检索）。
从个人网站 AI 模块导出的独立项目，无鉴权（单管理员模式），保留原站点设计风格。跨平台：Windows / Linux / macOS。
## 页面结构
| 路由 | 页面 | 说明 |
|------|------|------|
| `/` | 聊天 | 默认页。Playground（项目/会话、模型池、Agent、Plan 任务面板、沉浸模式） |
| `/models` | 模型列表 | 全部模型的首字延迟、可用状态、搜索排序 |
| `/admin-models` | 管理模型 | 提供商与模型的增删改、单价配置、一键测试 |
| `/control` | 控制台 | 转移枢纽 |
| `/usage` | 用量统计 | 每日 token / 按模型费用估算（输入/输出/缓存分档计价） |
| `/trace` | 轨迹 | 完整思维链记录 + 跨会话检索（关键词/正则/分类/模型，点击回跳定位） |
| `/settings` | 设置 | 默认 Shell、敏感数据脱敏表、自定义技能导入 |
## 快速开始
```bash
# 1. 安装依赖 + 构建前端（首次 / 更新代码后）
npm run setup
# 2. 启动（默认端口 8317，可在 .env 修改）
npm start
```
浏览器打开 localhost 默认端口位于 8317
## Windows 11 部署
1. 安装 [Node.js 20 LTS](https://nodejs.org/)（安装时勾选 Add to PATH）
2. 把整个 `kharness-main` 文件夹拷到目标机器（如 `D:\kHarness`）
3. **双击 `start.bat`**：
   - 首次运行自动 `npm run setup`（安装依赖 + 构建前端，需联网下载 better-sqlite3 预编译包）
   - 自动打开浏览器 `http://localhost:8317`
   - 关闭窗口即停止服务
4. 局域网访问：Windows 防火墙首次会弹窗，勾选「专用网络」允许；其他设备访问 `http://localhost:8317`
5. 首次启动会弹窗选择默认 Shell（推荐 PowerShell 7，未安装则选 PowerShell 5 / CMD / WSL Bash / Git Bash，未安装的选项会标记）
命令行方式（等效 start.bat）：
```bat
set NODE_ENV=production
node server\index.js
```
> 若 better-sqlite3 安装失败（无预编译包时才需要）：安装 Visual Studio Build Tools（C++ 工作负载）后重试 `npm run setup`。
## 开发模式
```bash
npm run dev:server   # 后端（node --watch 自动重启）
npm run dev:client   # 前端 vite 开发服务器（代理 /api → 8317）
```
## 数据与配置
- `kharness-main/.env`：端口配置（`PORT=8317`）
- `kharness-main/server/kh.db`：SQLite 数据库（项目 / 会话 / 提供商 / 模型 / 单价 / 用量 / 脱敏规则），随项目携带
- `kharness-main/server/agent-skills/`：内置技能；`server/agent-skills-custom/`：自定义技能（设置页导入）
- 长期记忆：`~/.kharness/AGENTS.md`（全局兜底）+ 项目根 `AGENTS.md`（覆盖），SHA-256 热加载
- Agent 默认工作目录：KHarness 项目根；项目会话被限制在项目根内（防穿越/防链接逃逸），自由会话可用 `/dir 路径` 任意切换
## 从旧机器迁移数据
把 `server/kh.db`（连同 `kh.db-shm` / `kh.db-wal`，若有）拷到新机器同路径即可；模型、密钥、用量、脱敏规则全部随库带走。
## 携带到其他电脑
整个 `kharness-main` 目录拷走即可（无外部密钥依赖；模型 API Key 存于 kh.db）。
目标机器需要 Node.js ≥ 20，Windows 双击 `start.bat`，macOS/Linux 执行 `npm run setup && npm start`。

# AGENTS.md / AGENT.md 使用说明

本文档详细说明 KHarness 中 `AGENTS.md` 与 `AGENT.md` 长期记忆文件的用法、位置优先级、格式与限制。

---

## 1. 支持的文件名

- `AGENTS.md`（推荐，兼容 OpenCode / 未来规范）
- `AGENT.md`（单数别名，兼容旧项目）

> 查找顺序：同一目录下优先读取 `AGENTS.md`，若不存在则回退读取 `AGENT.md`；两者同时存在时仅注入 `AGENTS.md`。

---

## 2. 位置与优先级（叠加注入）

`~` 即当前用户的家目录（Windows 上就是 `C:\Users\<用户名>`，如 `C:\Users\Admin`；代码里通过 `os.homedir()` 解析，两系统通用）。

| 优先级 | 位置 | 适用会话 | 说明 |
|--------|------|----------|------|
| 1 | `~\.kharness\AGENTS.md` 或 `~\.kharness\AGENT.md` | **所有会话** | 全局兜底，所有项目与自由会话均生效。Windows 实际路径：`C:\Users\<用户名>\.kharness\AGENTS.md` |
| 2 | `<项目根>\AGENTS.md` 或 `<项目根>\AGENT.md` | **项目会话** | 仅当会话绑定了项目时生效，覆盖/叠加全局 |
| 3 | `<当前工作目录>\AGENTS.md` 或 `AGENT.md` | **自由会话** | 自由会话按 `cwd` 就近读取（`cwd` 可通过 `/dir` 切换） |

**Windows 快速创建全局记忆**（PowerShell）：

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.kharness"
New-Item -ItemType File "$env:USERPROFILE\.kharness\AGENTS.md"
notepad "$env:USERPROFILE\.kharness\AGENTS.md"
```

**注入方式**：全局 + 项目/目录 两级内容会**叠加**注入到 `System Prompt` 前缀，格式为：

```
<<AGENTS.md：全局（C:\Users\Admin\.kharness\AGENTS.md）>>
...全局文件内容...

<<AGENTS.md：项目（D:\my-project\AGENTS.md）>>
...项目文件内容...
```

> 可在新建会话前通过 `GET /api/ai/agents-md?project_id=xxx&cwd=yyy` 预检各文件的 token 估算（`tokens` 字段）与是否超限（`skipped`）。

---

## 3. 格式

- **纯 Markdown**，无强制 `frontmatter`。
- 首行可为 `# 标题`，正文建议包含：
  - 项目简介与业务目标
  - 关键目录结构与命名规范
  - 常用命令、构建/测试流程
  - 代码风格、提交规范
  - 长期记忆、待办与约定
- 示例：

```markdown
# MyProject 长期记忆

## 项目简介
- 目标：...
- 技术栈：...

## 目录规范
- `src/` 业务代码
- `docs/` 文档

## 约定
- 提交信息使用中文，动词开头
- 新增接口需补充单元测试
```

> 无需 `--- frontmatter ---`，如有也不会解析，直接作为普通文本注入。

---

## 4. 限制与刷新

- **单文件上限 200KB**：超限时注入跳过，并在预检接口返回 `skipped: "文件过大（xxxKB，上限 200KB，已跳过）"`。
- **热加载**：每次调用模型前**重读**文件并校验 `SHA-256`，`git checkout` / `touch` 等不依赖 `mtime`，修改后下一次对话即生效。
- **Token 估算**：粗估 `CJK 1字符≈1 token`，`非 CJK 4字符≈1 token`，可在预检接口查看 `tokens` 字段，`>5000 tokens` 会弹窗确认是否继续。

---

## 5. 查看与调试

- **前端提示**：开启 `Agent` 后，悬停 `Agent 开/关` 按钮可查看当前生效的 `AGENT.md` 路径与 token 数（通过 `GET /api/ai/agents-md`）。
- **帮助菜单**：聊天页 `帮助` 按钮 → `AGENT.md / AGENTS.md 长期记忆` 小节可查看本说明摘要。
- **日志**：注入内容会在服务端日志中以 `<<AGENTS.md：...>>` 前缀打印（仅调试）。

---

## 6. 常见问题

**Q: 我应该把内容写在全局还是项目？**
- 通用规范（个人偏好、全局技能）写 `C:\Users\<用户名>\.kharness\AGENTS.md`
- 项目特定规范写 `<项目根>\AGENTS.md`，随项目提交到 Git

**Q: 修改后为何未生效？**
- 确认文件路径与文件名拼写（`AGENTS.md` 优先）
- 确认未超 200KB
- 下一次发送消息时会自动重载，无需重启服务

**Q: 如何临时禁用？**
- 重命名文件（如 `AGENTS.md.bak`）或清空内容，下一次对话即不注入

---

## 7. 示例目录结构（Windows）

```
C:\Users\Admin\
  .kharness\
    AGENTS.md        # 全局记忆（所有会话生效）

D:\my-project\
  AGENTS.md          # 项目记忆（仅项目会话生效）
  src\
  ...

D:\any-workdir\
  AGENT.md           # 自由会话按 cwd 读取
```

***
This product includes software developed by https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget:

The MIT License (MIT)

Copyright (c) 2026, MeteorNOX.
***
