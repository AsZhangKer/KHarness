# 如何编写一个兼容大部分 MCP Tools 的 MCP Harness（Agent Runtime）

要写一个兼容市面上大部分 MCP Tools 的 **MCP Harness（Agent Runtime）**，核心思路不是“支持每个 MCP 工具”，而是实现：

- **MCP 协议层**
- **通用 Agent 调度层**
- **Tool Schema 理解层**

MCP（Model Context Protocol）的目标就是让客户端不关心工具实现，因此一个好的 Harness 应该像：

> 一个通用 MCP Client + Agent Runtime

---

# 一、整体架构设计

```text
                User
                 |
                 v
          Agent Controller
                 |
    +------------+-------------+
    |                          |
 LLM Planner              Memory System
    |
    v
 Tool Selection Engine
    |
    v
 MCP Client Layer
    |
    +-------------------------------+
    |               |               |
 filesystem     browser          database
 MCP Server     MCP Server       MCP Server
```

---

# 二、实现 MCP Client 层

不要直接为每个工具写适配。

MCP 的基本抽象：

```text
MCP Server
    |
    | JSON-RPC
    |
MCP Client
    |
    |
Agent
```

你的 Harness 只需要知道：

- Server 有哪些 Tools
- 每个 Tool 的 Schema
- 如何调用 Tool
- 如何处理返回结果

例如：

```json
{
  "name": "read_file",
  "description": "Read a file",
  "inputSchema": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string"
      }
    }
  }
}
```

Agent 不需要知道：

```text
这是 Linux 文件系统工具
```

只需要知道：

```text
存在一个名为 read_file 的能力
```

---

# 三、MCP Client 核心接口设计

建议抽象：

```python
class MCPClient:

    async def connect(self, server):
        pass


    async def list_tools(self):
        pass


    async def call_tool(
        self,
        name,
        arguments
    ):
        pass
```

调用：

```python
tools = await client.list_tools()

for tool in tools:
    print(tool.name)
```

返回：

```text
read_file
write_file
search
browser_open
execute_sql
```

---

# 四、Tool Registry（工具注册中心）

不要让 LLM 直接面对 MCP。

增加一层：

```text
MCP Tools
    |
    v
Tool Registry
    |
    v
LLM
```

例如：

```python
class ToolRegistry:

    def __init__(self):
        self.tools = {}


    def register(self, tool):
        self.tools[tool.name] = tool
```

存储：

```json
{
  "read_file": {
    "server": "filesystem",
    "schema": {},
    "description": "..."
  }
}
```

作用：

- 支持多个 MCP Server
- 解决工具重名
- 权限控制
- 工具缓存

---

# 五、自动生成 Function Calling Schema

现代 LLM 调用工具通常使用：

## OpenAI 格式

```json
{
  "name": "xxx",
  "parameters": {}
}
```

## Claude 格式

```json
{
  "name": "xxx",
  "input_schema": {}
}
```

因此需要：

```text
MCP Schema
      |
      v
LLM Function Schema
```

例如：

MCP：

```json
{
  "name": "search",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string"
      }
    }
  }
}
```

转换：

```json
{
  "type": "function",
  "function": {
    "name": "search",
    "description": "search something",
    "parameters": {
      "type": "object",
      "properties": {
        "query": {
          "type": "string"
        }
      }
    }
  }
}
```

---

# 六、Agent Loop（核心）

采用 ReAct 思路：

```text
User
 |
 v
LLM
 |
 +------+
        |
    tool_call?
        |
       yes
        |
        v
    MCP Tool
        |
        v
    Tool Result
        |
        v
       LLM
        |
        v
      Answer
```

伪代码：

```python
while True:

    response = llm.chat(
        messages,
        tools=registry.tools
    )


    if response.tool_calls:

        for call in response.tool_calls:

            result = await mcp.call_tool(
                call.name,
                call.arguments
            )

            messages.append(result)

    else:
        return response.text
```

---

# 七、多 MCP Server 管理

例如：

## config.yaml

```yaml
mcp_servers:

  filesystem:
    command:
      npx

    args:
      - "@modelcontextprotocol/server-filesystem"
      - "/home/user"


  github:
    command:
      docker

    args:
      - run
      - github-mcp


  postgres:
    url:
      http://localhost:8000
```

启动：

```python
for server in config:

    client.connect(server)
```

自动发现：

```text
filesystem

 ├── read_file
 ├── write_file


github

 ├── create_issue
 ├── search_repo


postgres

 ├── query
```

---

# 八、Tool 选择策略

## 简单方案

直接把所有工具提供给 LLM：

```text
tools=[
    read_file,
    search,
    execute_sql,
    ...
]
```

缺点：

工具数量过多时：

- Context 增大
- LLM 选择困难

---

## 推荐方案：Tool Router

先判断：

```text
这个任务需要什么能力？
```

例如：

用户：

```text
分析我的 GitHub Issue
```

Router：

```text
需要：

- github.search
- github.read
```

然后只加载：

```text
github tools
```

---

# 九、Memory 系统

完整 Agent：

```text
                Agent

       +----------------+
       | Planner        |
       |                |
       | Memory         |
       |                |
       | Tool Router    |
       |                |
       | MCP Runtime    |
       +----------------+
```

---

## 短期 Memory

保存：

```text
conversation history
```

---

## 长期 Memory

使用：

```text
Vector Database
```

保存：

```text
用户偏好
项目资料
历史任务
```

例如：

```text
用户喜欢：

- Python
- Linux
- Minecraft


项目：

- KPCL plugin
```

---

# 十、安全层（非常重要）

MCP Tool 本质是能力。

例如：

```text
execute_shell
```

如果 LLM 自己决定：

```bash
rm -rf /
```

会造成严重问题。

因此加入：

```text
Permission Middleware
```

例如：

```python
class Permission:

    def allow(tool, args):

        if tool == "delete_file":
            return False

        return True
```

---

# 十一、推荐技术栈

## Python 实现

推荐：

```text
FastAPI
+
asyncio
+
pydantic
+
mcp-sdk
+
OpenAI SDK / Anthropic SDK
```

项目结构：

```text
mcp-agent/

├── main.py


├── agent/
│   ├── planner.py
│   ├── memory.py
│   └── loop.py


├── mcp/
│   ├── client.py
│   ├── transport.py
│   └── registry.py


├── tools/
│   └── middleware.py


└── config.yaml
```

---

# 十二、兼容大部分 MCP Tool 所需能力

至少支持：

|能力|重要程度|
|-|-|
|stdio transport|★★★★★|
|SSE transport|★★★★★|
|HTTP transport|★★★★|
|tools/list|★★★★★|
|tools/call|★★★★★|
|resources/list|★★★★|
|prompts/list|★★★|
|JSON Schema|★★★★★|
|OAuth/Auth|★★★★|
|Streaming|★★★|

---

# 十三、项目规模预估

一个成熟 MCP Harness：

|模块|代码量|
|-|-:|
|MCP Client|1000~2000 行|
|Agent Loop|300~800 行|
|Tool Router|500 行|
|Memory|500~1000 行|
|UI/API|1000 行|

总计：

```text
约 3000~5000 行代码
```

个人项目完全可以实现。

---

# 十四、产品级 Agent 的核心

如果目标是实现：

- Claude Desktop
- Cursor Agent
- OpenHands
- OpenAI Operator

级别的 MCP Harness：

重点不是 MCP 协议。

真正困难的是：

1. Tool Discovery

2. Tool Selection

3. Context Management

4. Permission System

5. Agent Planning


MCP 本身只是能力接入层。

可以把 MCP Harness 理解为：

> 一个支持热插拔能力模块的 AI 操作系统。