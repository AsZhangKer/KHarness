---
name: git-commit
description: 网站项目的 git 提交规范与常用命令（仓库位于 /home/ker/website）
---

# Git 提交规范

仓库：`/home/ker/website`，分支 `main`，身份 `Ker <AsZhangker@users.noreply.github.com>`。

```bash
cd /home/ker/website
git status                 # 先看改了什么
git diff                   # 复查改动内容
git add -A && git commit -m "类型：简述"
git log --oneline -5
```

提交信息类型：功能 / 修复 / 调整 / 文档 / 优化。

禁止入库（.gitignore 已排除，勿强行 add）：`.env`、`site.db*`、`uploads/`、`node_modules`、`client/dist`、`backups/`。
