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

当前版本 **1.3.1**。

## 使用说明

| 形态           | 概述                                           | 数据存储             | 优缺点                     |
| -------------- | ---------------------------------------------- | -------------------- | -------------------------- |
| 桌面端（推荐） | `npm run desktop`，或安装发行版 `KHarness.exe` | `%APPDATA%\KHarness` | 更加方便使用，100%功能支持 |
| 纯 Web         | `npm run setup && npm start`                   | `server/kh.db`       | 部分功能缺失               |



## 功能面

**模型 与 提供商**：支持 OpenAI 兼容 / Anthropic 兼容协议 及 自定义格式接入、外部导入、延迟测试等；
工具风格支持native / text 或 auto（自动选择）用户可在设置中修改。

**Agent 与 上下文**：内置部分常用工具，支持自定义MCP服务器导入外部功能和Skills（技能）；可调整单个会话上下文窗口与压缩界限；

**工具**：文件读写与编辑、`grep`/`glob`、命令执行、后台任务、
长期记忆（知识库）、`ask_user` 向用户提问、SubAgent、外部接口 等工具、
同时可调用内嵌浏览器完成复杂网页操作；

**远程会话与SFTP**：SSH 连接管理 允许使用 密码 / 私钥、远程连接下的会话 AI Agent 可调用远端工具执行任务；右侧为SFTP 文件管理；

**终端**：从底部弹出抽屉式终端，本地实现方式为 Node-PTY、远程实现为 SSH-Shell，支持多标签、自由拖动等。

**内嵌浏览器**：内嵌浏览器面板在右侧点击浏览器图标弹出，主进程默认为 BrowserView，Agent可调用Tools操作。

**AI监工**：通过额外新建一个会话，用户可以实现AI监工功能，可于右侧栏勾选``监工``选项后使用，用户只需向监工简要描述任务，监工则会代理用户调用主Agent分条分步执行，并自行完成项目测试，当走到任务出口时，监工会Call Tool并向用户简要说明项目完成情况；

**侧栏**：Agent处于忙碌状态时，用户可以启动``侧栏``，侧栏与主Agent共享模型、会话 和 工作目录。侧栏模型仅有只读权限，且无法手动修改。用户可以点击按钮将侧栏聊天记录插入主Agent；

**UI**：内置多套主题。

**数据**：设置页可导出/导入 数据库、修改数据存储目录、恢复出厂设置等，用户的数据保证仅留存本机，绝不上传。

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
