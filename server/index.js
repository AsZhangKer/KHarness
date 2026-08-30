const express = require('express');
const cors = require('cors');
const compression = require('compression');
const path = require('path');

const { PORT, isProduction } = require('./config');
const { initDatabase } = require('./database');

initDatabase();

const app = express();
const PORT_FINAL = PORT || 8317;

app.set('trust proxy', 1);

// 本地 harness：跨域全放开（桌面端单用户场景）
app.use(cors());
app.use(compression({
  // SSE（AI 聊天流式响应）禁用压缩：压缩缓冲会让逐字输出变成一次性到达
  filter: (req, res) => {
    if (String(res.getHeader('Content-Type') || '').includes('text/event-stream')) return false;
    return compression.filter(req, res);
  }
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// 基础安全响应头
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // CSP：允许同源 + Font Awesome CDN + 内联样式（Vue 需要）
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; " +
    "font-src 'self' https://cdnjs.cloudflare.com; " +
    "img-src 'self' data: blob:; " +
    "connect-src 'self'; " +
    "frame-ancestors 'self'"
  );
  next();
});

app.use('/api/ai', require('./routes/ai'));
app.use('/api/settings', require('./routes/settings'));

// API 404：返回 JSON 而不是 HTML
app.use('/api', (req, res) => {
  res.status(404).json({ code: 404, message: '接口不存在' });
});

// 托管前端构建产物（HTML 禁缓存：构建后 chunk 文件名带 hash，旧 index.html 会引用不存在的 chunk）
if (isProduction) {
  const distPath = path.join(__dirname, '../client/dist');
  console.log('Serving static from:', distPath);
  app.use(express.static(distPath, {
    maxAge: '7d',
    index: false,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    }
  }));
  // SPA fallback（Express 5 不再支持 '*' 通配，用兜底中间件；HEAD 同样返回以支持探测）
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

// 全局错误处理：记录详细日志，对外只暴露统一错误信息
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(`[error] ${req.method} ${req.path}:`, err.message);
  if (!isProduction) console.error(err.stack);
  const status = err.status || 500;
  res.status(status).json({ code: status, message: status === 500 ? '服务器错误' : err.message });
});

app.listen(PORT_FINAL, () => {
  console.log(`KHarness server running on http://localhost:${PORT_FINAL} (${isProduction ? 'production' : 'development'})`);
});
