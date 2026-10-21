# 界面自测探针（浏览器实跑，不是 jsdom）

`client/__tests__/` 跑的是 jsdom：**它不跑 `@media`、不做布局、不加载图片**。凡是「界面到底画成什么样」的结论，都要用这里这套真浏览器探针拿读数。

## 怎么跑

1. 先起一个**自测实例**（绝不碰 8317 那个正式实例）：

```bash
cd server && KH_DATA_DIR=D:/tmp/ef_selftest_data NODE_ENV=production PORT=8421 node index.js
```

2. `npm run build --prefix client`（探针读的是 `client/dist`，源码改了没构建 = 白测）。
3. `node tools/selftest/ef_v20_run.js`（或 `ef_v13_run.js`）。跑完自动把 `dist` 里的探针文件删掉。

改端口的话，探针里那个 `127.0.0.1:8421` 要一起改。

## 里面各是什么

| 文件 | 量什么 |
|---|---|
| `ef_probe_v13.html` + `ef_v13_run.js` | 终末地主题入口收进实验室：默认 6 张主题卡 → 实验室拨开当场 7 张 → 点卡切过去 → 拨关当场退回暗色 |
| `ef_probe_v20.html` + `ef_v20_run.js` | 用户气泡的附图缩略图（真尺寸/盒子尺寸/正文不留 `[[img:`）+ 「界面动效」开关（`data-motion` 与 computed 的 transitionDuration） |

## 三条踩过的坑（写探针前先读这段，能省一晚）

1. **探针 HTML 会被缓存**：`express.static` 给 `dist` 下的文件发 `max-age=7d`（只有 `.html` 走 `no-cache` 再验证，而 ETag 撞上就吃缓存）。所以**每次都要用带时间戳的新文件名**落进 `dist`（`ef_v20_run.js` 就是这么写的），不然你跑到的是上一版探针，读数看着像"改了没生效"。
2. **`--virtual-time-budget` 会把动画冻在中间帧**：虚拟时间下 `transition`/`animation` 的进度和 `transitionend` 都不可信，别拿它判"有没有动画"。要判动画就用 computed 读 `transition-duration`/`animation-name`（值本身不受虚拟时间影响），或者常驻浏览器真点。
3. **内置浏览器面板的视口是 0×0**：在 Qoder 的内嵌浏览器里 `innerWidth/innerHeight` 回 0，于是所有宽度塌成 2px、懒加载的图永远不载入 —— 量宽屏布局必须走「同源 iframe 撑到 1440×900」这一条（本目录两个探针都是这个形状）。
