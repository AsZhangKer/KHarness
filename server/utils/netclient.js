/**
 * 上游请求的连接层（#271）：一套自己的 undici Agent，外加按代理地址缓存的 ProxyAgent。
 *
 * 要治的是「半死连接」这一类断流：kh 与上游之间是一条 keep-alive 长连接，工具循环里两次请求之间
 * 常常空闲几秒到几十秒（跑工具、等审批），而**上游或它前面的 CDN/负载均衡先把它掐了又不通知**。
 * 下一次请求从池子里捞出这条已经死了的 socket → ECONNRESET / socket hang up，落在流式上就是断流。
 * 第六十一轮的「零输出整发重发」只是把症状兜住，这里才是根因层：**让我们比上游先放手**。
 *
 * 为什么光靠 undici 的默认值不够：默认 keepAliveTimeout 是 4 秒，但只要上游回一个
 * `Keep-Alive: timeout=N`，undici 就改用 `min(N - 2s, keepAliveMaxTimeout)`，而 keepAliveMaxTimeout
 * 默认 **600 秒** —— 也就是说 CDN 说"这条连接我给你留 300 秒"，我们就真抱 298 秒，
 * 而 CDN 自己往往 60~90 秒就回收了。所以关键不是把默认值调小，是把**上限**钉住。
 *
 * 顺带修一处泄漏：以前 proxyFor() 每次调用都 `new ProxyAgent(...)` 且从不关闭 ——
 * 每个提供商的每一条请求都攒一整套连接池。现在按 `代理地址` 缓存复用。
 *
 * 覆盖范围：`setGlobalDispatcher` 管的是**用户态 undici**（routes/ai.js、utils/apitools.js、
 * utils/mcp.js、utils/proxy.js 都是 require('undici') 的那一份），也就是所有打到模型上游的路径。
 * 剩下三处用 Node 内置 fetch 的是 kh→kh 自己的 localhost 转发（sidebar / subagent / supervisor），
 * 没有跨网半死连接问题，故不去动全局 fetch。
 */
const { Agent, ProxyAgent, setGlobalDispatcher } = require('undici');

/** 空闲连接最多抱 3 秒；上游说多久都不算数，超过 5 秒一律按 5 秒收 */
const KEEP_ALIVE_TIMEOUT_MS = 3000;
const KEEP_ALIVE_MAX_MS = 5000;

/** 给任何 dispatcher 的构造参数：连接层策略只有这一份定义 */
function clientOptions(extra = {}) {
  return {
    ...extra,
    keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
    keepAliveMaxTimeout: KEEP_ALIVE_MAX_MS,
  };
}

const directAgent = new Agent(clientOptions());
let installed = false;

/** 在 server 启动时调一次（幂等）：没显式传 dispatcher 的请求也走这套空闲策略 */
function install() {
  if (installed) return directAgent;
  installed = true;
  setGlobalDispatcher(directAgent);
  return directAgent;
}

// ProxyAgent 自带一套池子，建一次就要一直用；键是代理地址（同地址不同提供商也共用，省 socket）
const proxyAgents = new Map();

/** @param {string} proxyUrl 形如 http://127.0.0.1:7890 */
function proxyAgentFor(proxyUrl) {
  let a = proxyAgents.get(proxyUrl);
  if (!a) {
    a = new ProxyAgent({ uri: proxyUrl, ...clientOptions() });
    proxyAgents.set(proxyUrl, a);
  }
  return a;
}

module.exports = {
  install,
  directAgent,
  proxyAgentFor,
  clientOptions,
  KEEP_ALIVE_TIMEOUT_MS,
  KEEP_ALIVE_MAX_MS,
};
