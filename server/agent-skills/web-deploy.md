---
name: web-deploy
description: 前端改动后构建上线：在 client 目录执行 vite 构建写入 dist，无需重启服务
---

# 前端部署上线

当前网站的前端是 Vue3 + Vite，生产环境由后端直接托管 `client/dist`。

构建上线步骤：

```bash
cd /home/ker/website/client && npm run build
```

- 构建成功（看到 `✓ built`）即已生效，**无需重启后端**（静态文件即时托管）
- 构建失败时阅读报错，常见为模板语法错误，修复后重新构建
- 如需验证，可执行：`curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8080/`（应返回 200）
