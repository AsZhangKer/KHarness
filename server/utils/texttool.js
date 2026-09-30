// 文本工具调用协议：给「不会用原生 function calling」的模型兜底
// 许多便宜/新上线的模型（如 agnes 系）接受 tools 参数却几乎从不发起原生 tool_call，
// 只会用 markdown 把调用"写"出来。这里提供：
//   1) textToolPrompt(tools)  —— 明确告知输出格式的系统级指令
//   2) extractTextCalls(text) —— 从正文中抽取结构化调用（多形态容错）
//   3) stripExtractedCalls(text) —— 把已被执行的调用块从展示正文里剔除
const { TOOL_SCHEMAS } = require('./schemas');

// 支持三种书写形态：```json 围栏、裸对象、以及 {tool,arguments} 数组
const FENCE_RX = /```(?:json|JSON|tool|tool_call)?\s*\n?([\s\S]*?)```/g;

function tryParse(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}

function repair(s) {
  let t = String(s || '').trim();
  const m = t.match(/[[{][\s\S]*[\]}]/);
  if (m) t = m[0];
  t = t.replace(/[，]/g, ',').replace(/[：]/g, ':').replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  t = t.replace(/,\s*([}\]])/g, '$1');
  // 模型常漏引号：{tool: "x"} → {"tool": "x"}
  t = t.replace(/([{,]\s*)([A-Za-z_][\w-]*)\s*:/g, '$1"$2":');
  return t;
}

function toCall(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const name = obj.tool || obj.name || obj.function?.name || obj.tool_name;
  if (!name) return null;
  let args = obj.arguments ?? obj.args ?? obj.parameters ?? obj.input;
  if (typeof args === 'string') args = tryParse(args) || tryParse(repair(args)) || {};
  if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
  // 参数平铺在顶层的写法：{ "tool": "read_file", "path": "a.txt" }
  if (!Object.keys(args).length) {
    for (const [k, v] of Object.entries(obj)) {
      if (['tool', 'name', 'function', 'arguments', 'args', 'parameters', 'input', 'type', 'tool_name'].includes(k)) continue;
      args[k] = v;
    }
  }
  return { name: String(name), args };
}

// 从一段文本中抽取全部工具调用；known 为可选的合法工具名白名单（原生模式下过滤，避免把示例代码当调用）
function extractTextCalls(text, known) {
  const src = String(text || '');
  const okName = (n) => !known || known.includes(n);
  const calls = [];
  const ranges = [];
  let m;
  FENCE_RX.lastIndex = 0;
  while ((m = FENCE_RX.exec(src)) !== null) {
    const body = m[1];
    const parsed = tryParse(body) || tryParse(repair(body));
    if (!parsed) continue;
    const items = Array.isArray(parsed) ? parsed : [parsed];
    const picked = items.map(toCall).filter(c => c && okName(c.name));
    if (picked.length) {
      calls.push(...picked);
      ranges.push([m.index, m.index + m[0].length]);
    }
  }
  if (!calls.length) {
    // 无围栏的裸 JSON：{"tool":"run_command","arguments":{...}}（键名可能漏引号，repair 会补）
    const bare = src.match(/\{[\s\S]*?\b(?:tool|tool_name|function|name)\s*:[\s\S]*\}/);
    if (bare) {
      const parsed = tryParse(bare[0]) || tryParse(repair(bare[0]));
      const c = toCall(parsed);
      if (c && okName(c.name)) { calls.push(c); ranges.push([bare.index, bare.index + bare[0].length]); }
    }
  }
  return { calls, ranges };
}

function stripExtractedCalls(text, ranges) {
  if (!ranges.length) return String(text || '');
  let out = '';
  let last = 0;
  for (const [a, b] of ranges.sort((x, y) => x[0] - y[0])) {
    out = out.replace(/\s+$/, '');
    out += text.slice(last, a);
    last = b;
  }
  out = out.replace(/\s+$/, '');
  out += text.slice(last);
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

// 文本协议说明：只列真实存在的工具与参数，避免模型捏造
// schemas 由调用方传入（内置 + 已启用的外部 API 工具），缺省用内置表
function textToolPrompt(schemas) {
  const table = schemas && Object.keys(schemas).length ? schemas : TOOL_SCHEMAS;
  const lines = Object.entries(table).map(([name, schema]) => {
    const ps = Object.entries(schema).map(([k, r]) => `    "${k}"${r.required ? '（必填）' : '（可选）'}：${r.desc}`);
    return `  - ${name}：\n${ps.join('\n')}`;
  });
  return [
    '[工具调用协议（文本模式）]',
    '你无法使用原生 function calling。需要实际操作这台机器时，必须、且只能按下面的 JSON 格式发起调用：',
    '1) 单独一段 ```json 围栏，内部一个对象：{"tool":"工具名","arguments":{...参数...}}；或一个数组一次发起多个；',
    '2) 发起调用后立刻结束本轮回复，不要预测或编造执行结果；',
    '3) 宿主会把执行结果以「[工具执行结果]」开头的用户消息回给你，你据此继续；',
    '4) 重复第 1 步直到无需更多操作，最后用自然语言总结；',
    '5) 严禁只用文字描述"我已经执行了…"——不输出 JSON 调用就等于没有执行。',
    '可用工具与参数：',
    ...lines,
    '示例（读文件后编辑）：',
    '```json',
    '{"tool":"read_file","arguments":{"path":"src/index.js"}}',
    '```'
  ].join('\n');
}

// 结果回喂给模型的用户消息（文本模式没有 role:'tool'，用文本承载）
function textToolResultMessage(name, result) {
  const body = result && result.error ? `[错误] ${result.error}` : (result && result.output) || '(无输出)';
  return `[工具执行结果] ${name}\n${String(body).substring(0, 40000)}`;
}

module.exports = { textToolPrompt, extractTextCalls, stripExtractedCalls, textToolResultMessage, toCall };
