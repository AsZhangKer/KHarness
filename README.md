# KHarness Agent



<div align="center">
  <img src="https://github.com/AsZhangKer/KHarness/blob/main/client/public/icon.png" alt="KHarness" width="120" height="120" />
</div>
<p align="center">
  <a href="https://qm.qq.com/q/Uk4hG6TAqW">QQ群</a> |
  <a href="https://zker.top/articles/41">官方站点</a>
</p>
<p align="center">
  KERAIAGENTHARENSS
</p>



## 技术栈

Vue 3  + Express 5 ，使用 SQLite 作为数据库，运行框架：Electron；

当前版本 **1.3.3**。

## 使用说明

| 形态           | 概述                                           | 数据存储             | 优缺点                     |
| -------------- | ---------------------------------------------- | -------------------- | -------------------------- |
| 桌面端（推荐） | `npm run desktop`，或安装发行版 `KHarness.exe` | `%APPDATA%\KHarness` | 更加方便使用，100%功能支持 |
| 纯 Web         | `npm run setup && npm start`                   | `server/kh.db`       | 部分功能缺失 * 自1.3.2版本起已不再推荐 *   |



## 功能面

**模型 与 提供商**：支持 OpenAI 兼容 / Anthropic 兼容协议 及 自定义格式接入、外部导入、延迟测试等；
工具风格支持native / text 或 auto（自动选择）用户可在设置中修改。

**Agent 与 上下文**：内置部分常用工具，支持自定义MCP服务器导入外部功能和Skills（技能）；可调整单个会话上下文窗口与压缩界限；审批支持三模式（严格 / 默认 / 免除），另有权限黑白名单与同一操作重复调用的打断阈值；

**图片收支两条规则**：截图类工具是请求体膨胀的主因，因此上下文里只有最近一张图会真的发给上游（更早的自动替换为占位文案），并且可在 设置→实验室 里限定图片最长边（480p/720p/900p/1080p 或自定义，0 = 不限制），送图前统一缩放并转 JPEG；

**工具**：文件读写与编辑、`grep`/`glob`、命令执行、后台任务、
长期记忆（知识库）、`ask_user` 向用户提问、SubAgent、外部接口 等工具、
同时可调用内嵌浏览器完成复杂网页操作；

**远程会话与SFTP**：SSH 连接管理 允许使用 密码 / 私钥、远程连接下的会话 AI Agent 可调用远端工具执行任务；右侧为SFTP 文件管理；

**终端**：从底部弹出抽屉式终端，本地实现方式为 Node-PTY、远程实现为 SSH-Shell，支持多标签、自由拖动等。

**内嵌浏览器**：内嵌浏览器面板在右侧点击浏览器图标弹出，主进程默认为 BrowserView，Agent可调用Tools操作。支持整页截图与多屏全屏截取。

**Computer Use（实验功能，默认关闭）**：让 Agent 查看屏幕、定位窗口并操作鼠标键盘。已安装 netwright 时优先使用它，未安装则由随包的坐标引擎接管（常驻 PowerShell 守护进程，SendInput + UIA 快照，坐标统一为物理像素）。授权以「进程 / 窗口」为粒度：放行一次后该目标内的后续动作免审；整屏截图默认每一步都要批准，仅在「全部开放」下免审。预置黑名单挡住任务管理器、注册表、终端类程序，并支持绑定一个全局急停快捷键（含鼠标侧键）立即撤销全部授权。功能有风险，请在 设置→实验室功能 中自行开启。

**AI监工**：通过额外新建一个会话，用户可以实现AI监工功能，可于右侧栏勾选``监工``选项后使用，用户只需向监工简要描述任务，监工则会代理用户调用主Agent分条分步执行，并自行完成项目测试，当走到任务出口时，监工会Call Tool并向用户简要说明项目完成情况；* 该功能已半废弃：代码与历史报告保留，但默认关闭，需要在 设置→实验室功能→AI 监工 打开后，右栏页签、`/supervise` 命令与相关接口才可用。 *


**侧栏**：Agent处于忙碌状态时，用户可以启动``侧栏``，侧栏与主Agent共享模型、会话 和 工作目录。侧栏模型仅有只读权限，且无法手动修改。用户可以点击按钮将侧栏聊天记录插入主Agent；

**UI**：内置多套主题。

**数据**：设置页可导出/导入 数据库、修改数据存储目录、恢复出厂设置等，用户的数据保证仅留存本机，绝不上传。

## Linux（.deb）

Linux 版由 GitHub Actions 构建：Actions 页面 → 「构建 Linux deb」→ 分支选 `linux` → Run workflow。
产物在 workflow Summary 页的 `kharness-deb` 里；打 `v*` tag 时也会自动附到对应 Release。
Windows 安装包仍在本机出（`electron-builder --win dir` → Inno Setup），不走 CI。

装完启动若报 `The SUID sandbox helper binary was found, but is not configured correctly`：
是 Chromium 的 chrome-sandbox 没拿到 setuid，用 root 修一下：
`sudo chown root:root /opt/KHarness/chrome-sandbox && sudo chmod 4755 /opt/KHarness/chrome-sandbox`，
或临时 `kharness --no-sandbox` 启动。数据落在 `~/.config/KHarness`，与 Windows 版同一套库格式，可在 设置→关于 里导出/导入。

## 开发

```bash
npm run setup        # 安装 server/client 依赖 + 构建前端
npm run dev:server   # 后端 node --watch
npm run dev:client   # 前端 vite（代理 /api → 8317）
npm run desktop      # 构建 Electron
npm run desktop:raw  # 跳过构建
```

模块地图见 [STRUCTURE.md](STRUCTURE.md)，

工具调用约定见 [TOOLS-CALLING.md](TOOLS-CALLING.md)，

MCP 接入见 [MCP.md](MCP.md)。



## 隐私处理

`kh.db`为主要数据库文件、`kh.db.bak-*`、`.env`、`desktop-port.json`、`build/`、`release*/`、
`_tmp_*` 与日志都在 `.gitignore` 里；
本项目暂无联网更新服务，也不会主动向外传递信息。

# 开源信息

本项目采用 GNU GENERAL PUBLIC LICENSE V3 许可协议，详见 [LICENSE](LICENSE)

# 鸣谢

本项目参考和使用了 https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget 的部分源码，并遵守其协议规范。
 感谢 Rainboow 对本项目的大力支持👍
