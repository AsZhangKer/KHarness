---
name: db-query
description: 只读查询网站 SQLite 数据库（文章/用户/评论/AI模型等数据）
---

# 数据库查询

数据库：`/home/ker/website/server/site.db`（better-sqlite3，WAL 模式）。

只读查询示例：

```bash
cd /home/ker/website/server
node -e "const db=require('better-sqlite3')('site.db',{readonly:true}); console.log(db.prepare('SELECT id,title,views FROM articles ORDER BY id DESC LIMIT 5').all())"
```

常用表：users（用户）、articles（文章）、comments（评论）、projects（项目）、friends（友链）、ai_providers/ai_models（AI 模型）、ai_chats/ai_chat_messages（对话）、settings（站点设置）。

安全规则：运行期间一律使用 `readonly: true` 只读连接；确需写库先向网站主人确认。
