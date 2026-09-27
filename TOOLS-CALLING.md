# 工具调用规范（给不会调工具的 AI 参考）

> 本文件由当前运行的 AI Agent 根据实际调用经验整理，供其他 AI / 开发者参考。

## 一、核心机制

**不是靠关键词触发，而是靠「结构化工具调用（tool call）」协议。**

模型在回复里输出一个符合 JSON 格式的结构化调用块，宿主程序识别并代为执行，再把执行结果作为新消息喂回给模型。

### 最小示例

```json
{
  "tool": "run_command",
  "arguments": {
    "command": "git -C D:\\1\\kharness-main status --short"
  }
}
```

宿主收到后：
1. 校验 `tool` 名是否在可用清单里
2. 校验 `arguments` 是否符合该工具的 schema
3. 在宿主进程里真正执行
4. 把 stdout / 结果作为一条新消息喂回给模型

## 二、可用工具清单

| 工具 | 关键参数 | 用途 |
|---|---|---|
| `run_command` | `command` | 前台执行 shell 命令并等结束；单次超时（默认 360s，设置项 `cmd_timeout_seconds`，0=不限）到点**终止整棵进程树**并回喂已收集输出 |
| `read_file` | `path` | 读文本文件，自动识别 UTF-8/GBK |
| `list_dir` | `path` | 列目录 |
| `glob` | `pattern`（通配符） | 按文件名递归查找，支持 `**/*.vue`；只回路径、上限 500 条、自动排除噪音目录 |
| `grep` | `pattern`（正则） | 按内容正则递归搜文件，返回「文件:行号: 行」；自动跳过 `node_modules`/`.git` 与二进制 |
| `edit_file` | `path` + `old_text` + `new_text` | 精确替换唯一匹配的片段（改已有文件首选） |
| `write_file` | `path` + `content` | **覆盖式写入**：新建文件或整体重写；改已有文件请用 `edit_file` |
| `delete_file` | `path` | 删除文件（严格模式入回收站；任何模式都留快照，可撤销） |
| `delete_dir` | `path` | 删除目录（先做整树快照，可撤销恢复；快照超限则拒绝删除） |
| `create_dir` | `path` | 创建目录 |
| `rename_file` | `path` + `new_path` | 重命名/移动 |
| `web_fetch` | `url` | 抓网页/接口内容转纯文本 |
| `load_skill` | `name` | 加载某个技能的完整说明（按需拉取） |

> `search_files` / `find_files` 已改名为 `grep` / `glob`。旧名仍可直接调用（内部按别名解析），但不再出现在工具清单里。

### 开关型扩展工具（设置 → 工具（按需启用），默认关闭）

启用后才注入工具清单；未启用时调用会拿到明确的「未启用」提示。

| 分组 | 工具 | 说明 |
|---|---|---|
| 后台任务 | `run_background` / `background_status` / `background_list` / `background_kill` | 异步起长任务（不阻塞对话），输出落临时文件；status 查单个、list 查全部、kill 按 handle 终止整棵树。任务不跨服务重启 |
| 长期记忆 | `memory_write` / `memory_read` / `memory_list` | 跨会话跨项目；name 用 kebab-case，单条 ≤4000 字，同名覆盖 |
| 交互 | `ask_user` | 需要用户拍板时正式提问，前端覆盖发送框给选项 + 自由输入 + 取消；10 分钟未答按未回答返回 |
| 外部接口 | `web_search`、`github_repo`、`whois_query`、`weather_city`、`image_ocr`、B站三件套… | 见第五轮记录；按次计费，本地有结果缓存 |

> 以上 6 个修改类工具（`write_file` / `edit_file` / `delete_file` / `delete_dir` / `create_dir` / `rename_file`）
> 的结果都会带 `undo_id`，前端在操作旁渲染「撤销」按钮；快照落盘在 `.kh-undo/` 并记入 `undo_ops` 表，
> 因此**重启服务后历史步骤依然可撤销**（原始字节丢失时接口会明确返回"无法恢复"）。

## 三、调用规则

1. **必须真正调用工具，禁止用文字假装** —— 用 markdown 代码块"模拟"调用会被宿主当成纯文本，等于没调
2. **相对路径基于工作目录**，绝对路径用 `D:\...`
3. **改已有文件优先 `edit_file`**（`old_text` 必须唯一匹配，否则报错），新建才用 `write_file`
4. **找文件用 `glob`、搜内容用 `grep`**，别在 shell 里手敲 `grep`/`findstr`/`ls`
5. **预计要跑很久的命令用 `run_background`**（装依赖、大仓构建、watch、起服务）；前台命令会等它结束，超时会杀进程树
6. **命令输出很长时用 `head`/`tail`/`Select-Object` 截段**，别把整份日志读进上下文
7. **执行前先想清楚必要性**，绝不执行毁灭性命令；改代码前先读文件确认现状
8. **有歧义先问用户** —— 分叉大、选错代价高的用 `ask_user`，一般偏好自己定并说明假设
9. **不主动 `npm run build` / 重启服务**（除非用户明确要求）
10. 用户在工具中断点预埋的指示会以 `[工具结果回喂时插入提示词_用户输入]` 开头出现（一批工具结果回喂完就插），优先级高于你自己的计划

## 四、两条调用通道（宿主自动选择）

| 通道 | 触发条件 | 表现 |
|---|---|---|
| **原生 function calling** | 默认（`tool_style = auto/native`） | 请求带 `tools` 参数，模型返回 `tool_calls` |
| **文本 JSON 协议** | 上游拒绝 `tools`（HTTP 400 含 tool 字样）、或模型连续把调用写成正文、或管理页手动设为 `text` | 请求不带 `tools`，系统提示追加协议说明，模型输出 ```json {"tool":"…","arguments":{…}}```，宿主抽取执行，结果以 `[工具执行结果]` 用户消息回喂 |

排查「某模型死活不会用工具」：
- 管理模型 → 编辑 → **Agent 工具调用方式** 看当前体征；改成「强制文本协议」即可绕过它不实现 function calling 的问题。
- 原生通道下如果模型只是**用文字描述**要做什么（"我先读取文件…"）却没发调用，宿主**不再追问、也不自动切协议** —— 那句话就是本轮终态，原样回给你（第三十六轮按主人要求改的）。这类模型要救，去「管理模型 → Agent 工具调用方式」显式设成文本协议。
- 文本协议下抽取调用时只接受**已知工具名**，避免把给用户看的示例代码当成调用执行。

## 五、提供商协议（openai / anthropic / custom）与工具调用

提供商级别可选三种上游协议（管理模型 → 提供商 → 新增/编辑 → **上游接口协议**），翻译全在 `server/utils/protocols.js`，
宿主内部始终按 OpenAI 形状收发，所以对**模型而言工具调用协议只有一条通道**（原生 tool_calls 或文本 JSON），不必为每种上游写不同实现：

| 协议 | tools | thinking | usage | 备注 |
|---|---|---|---|---|
| `openai`（默认） | ✅ | ✅ 7 种方言自动轮转 | ✅ | 与改造前行为完全一致 |
| `anthropic` | ✅（自动转 `input_schema`，`tool_use`/`tool_result` 双向映射） | ✅ 只认 `thinking:{type,budget_tokens}`，开启时强制 `temperature=1`，故不参与方言轮转 | ✅（含 `cache_read_input_tokens` → `cached_tokens`） | 上游必填 `max_tokens`：提供商表单留空=8192、最小 512、填 0=不发 |
| `custom` | ⚠️ 取决于上游自己是否兼容 OpenAI `tools` | ⚠️ 按你填的 `reasoning_path` 取 | ⚠️ 按你填的 `usage_*_path` 记 | 传参/取值全靠模板，宿主不自动探测；宿主只归一化正文/思考/用量 |

自定义协议要点（给要接非标准网关的人）：
- 必填 8 项：`chat_url / method / headers / body / content_path / stream_content_path / list_url / list_path`；可空 6 项：`reasoning_path / stream_reasoning_path / error_path / usage_prompt_path / usage_completion_path / done_value`
- body / headers 里可用变量：`{{model}} {{messages}} {{prompt}} {{system}} {{stream}} {{temperature}} {{max_tokens}} {{tools}} {{key}} {{base}}`
  值恰好写成 `"{{messages}}"` 时是**整体替换**（保留数组类型），变量没值则该键整个删掉
- 路径只支持极简 JSONPath：`$.choices[0].delta.content`
- 不确定怎么填就先点「填入 OpenAI 模板」，再把字段改成上游实际的形状；切协议后若模型不再发工具调用，把 **Agent 工具调用方式** 改成「强制文本协议」

## 六、给"不会调工具的 AI"的最短说明

> 你不需要写 shell 代码块、不需要写 JSON 示例让宿主解析——你只需要在回复里直接以结构化形式声明一个工具调用（宿主会自动识别并执行）。执行结果会以新消息的形式回来，你基于结果继续回答。关键是：别用 markdown 代码块假装调用，那宿主会当成纯文本，等于没调。
