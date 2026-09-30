# AGENTS.md / AGENT.md 使用说明

本文档详细说明 KHarness 中 `AGENTS.md` 与 `AGENT.md` 长期记忆文件的用法、位置优先级、格式与限制。

---

## 1. 支持的文件名

- `AGENTS.md`（推荐，兼容 OpenCode / 未来规范）
- `AGENT.md`（单数别名，兼容旧项目）

> 查找顺序：同一目录下优先读取 `AGENTS.md`，若不存在则回退读取 `AGENT.md`；两者同时存在时仅注入 `AGENTS.md`。

---

## 2. 位置与优先级（叠加注入）

`~` 即当前用户的家目录（Windows 上就是 `C:\Users\<用户名>`；代码里通过 `os.homedir()` 解析，两系统通用）。

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
<<AGENTS.md：全局（C:\Users\<用户名>\.kharness\AGENTS.md）>>
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
C:\Users\<用户名>\
  .kharness\
    AGENTS.md        # 全局记忆（所有会话生效）

D:\my-project\
  AGENTS.md          # 项目记忆（仅项目会话生效）
  src\
  ...

D:\any-workdir\
  AGENT.md           # 自由会话按 cwd 读取
```
