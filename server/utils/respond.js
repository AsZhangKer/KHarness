// 统一响应助手与异步路由包装器
function ok(res, data = null, message = 'success') {
  res.json({ code: 200, message, data });
}

function fail(res, status, message) {
  res.status(status).json({ code: status, message });
}

// 包装 async 路由处理器，异常统一抛给全局错误中间件
function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

module.exports = { ok, fail, wrap };
