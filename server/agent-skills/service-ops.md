---
name: service-ops
description: 查看与重启网站后端服务（PM2），以及查看运行日志排查问题
---

# 后端服务运维

网站后端由 PM2 托管，进程名 `zker-site`，入口 `/home/ker/website/server/index.js`，监听 8080。

常用命令：

```bash
pm2 ls                                   # 查看状态（应 online）
pm2 restart zker-site                    # 重启（改了后端代码后必须）
pm2 logs zker-site --lines 50 --nostream # 最近 50 行日志
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8080/   # 健康检查，应 200
```

注意：改后端代码（server/ 下文件）后必须 `pm2 restart zker-site`；只改前端（client/）只需 npm run build。
