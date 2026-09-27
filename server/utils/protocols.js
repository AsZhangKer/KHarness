// 上游协议适配层。
// 思路：内部一律用「OpenAI 形状」的请求与响应，只在真正发 HTTP 前后做翻译。
// 这样 agent 主循环、consumeStream 的 SSE 解析、tool_calls 分片累积、思考拆分、
// usage 统计、审批与撤销链路都不必为某个协议写特判。
// 协议挂在提供商上（同一提供商上所有模型同协议），字段 ai_providers.api_style / max_tokens / custom。
const STYLES = ['openai', 'anthropic', 'custom'];
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 8192;

function styleOf(provider) {
  const s = String((provider && provider.api_style) || 'openai').toLowerCase();
  return STYLES.includes(s) ? s : 'openai';
}

// 自定义协议的配置（存 ai_providers.custom，JSON 字符串）
function customConfig(provider) {
  const raw = provider && provider.custom;
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw)) || {}; } catch (e) { return {}; }
}

function trimBase(url) { return String(url || '').replace(/\/+$/, ''); }

// max_tokens：0 = 不发送该参数（部分网关允许）；空/未填 = 8192；最小 512
function maxTokensOf(provider) {
  const n = parseInt(provider && provider.max_tokens);
  if (!Number.isFinite(n)) return DEFAULT_MAX_TOKENS;
  if (n === 0) return 0;
  return Math.max(512, n);
}

/* ============================ OpenAI 兼容（现状，直通） ============================ */
function openaiRequest(provider, payload) {
  return {
    url: `${trimBase(provider.base_url)}/chat/completions`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.api_key}` },
    body: payload
  };
}

/* ============================ Anthropic 兼容 ============================ */
// OpenAI 的 data:image/png;base64,xxx → Anthropic 的 image source
function toAnthropicImage(url) {
  const m = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(String(url || ''));
  if (!m) return null;
  return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
}

function contentBlocks(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && part.text) out.push({ type: 'text', text: String(part.text) });
    else if (part.type === 'image_url') {
      const img = toAnthropicImage(part.image_url && (part.image_url.url || part.image_url));
      if (img) out.push(img);
    } else if (part.type === 'image' && part.source) out.push(part);
  }
  return out;
}

function safeJsonObj(s) {
  if (s && typeof s === 'object') return s;
  try {
    const v = JSON.parse(String(s || '{}'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch (e) { return {}; }
}

// OpenAI messages → Anthropic messages（system 提到顶层、tool 结果转 tool_result、
// 连续同角色必须合并，否则 Anthropic 直接 400）
function toAnthropicMessages(messages) {
  const systems = [];
  const list = [];
  for (const msg of messages || []) {
    if (!msg) continue;
    const role = String(msg.role || '');
    if (role === 'system') {
      const t = typeof msg.content === 'string' ? msg.content : contentBlocks(msg.content).map(b => b.text || '').join('\n');
      if (t.trim()) systems.push(t.trim());
      continue;
    }
    if (role === 'tool') {
      const text = typeof msg.content === 'string' ? msg.content : contentBlocks(msg.content).map(b => b.text || '').join('\n');
      list.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: msg.tool_call_id || '', content: text || '(无输出)' }] });
      continue;
    }
    if (role === 'assistant') {
      const blocks = contentBlocks(msg.content);
      for (const call of msg.tool_calls || []) {
        const fn = call.function || {};
        blocks.push({ type: 'tool_use', id: call.id || '', name: fn.name || '', input: safeJsonObj(fn.arguments) });
      }
      if (blocks.length) list.push({ role: 'assistant', content: blocks });
      continue;
    }
    const blocks = contentBlocks(msg.content);
    if (blocks.length) list.push({ role: 'user', content: blocks });
  }
  // 合并连续同角色
  const merged = [];
  for (const m of list) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content = last.content.concat(m.content);
    else merged.push({ role: m.role, content: m.content });
  }
  return { system: systems.join('\n\n'), messages: merged };
}

// 内部思考参数（OpenAI 系各样式）→ Anthropic 的 thinking 对象
const EFFORT_BUDGET = { minimal: 1024, low: 2048, medium: 4096, high: 8192, xhigh: 16384, max: 16384 };
function anthropicThinking(payload, maxTokens) {
  let want = null;   // null = 未提及；false = 明确关闭；number = 预算
  if (payload.thinking && typeof payload.thinking === 'object') {
    if (payload.thinking.type === 'disabled') want = false;
    else if (payload.thinking.type === 'enabled') want = Number(payload.thinking.budget_tokens) || Number(payload.thinking.budget) || 4096;
  }
  if (payload.enable_thinking === false) want = false;
  if (payload.enable_thinking === true && want === null) want = 4096;
  if (payload.chat_template_kwargs && payload.chat_template_kwargs.enable_thinking === false) want = false;
  if (typeof payload.reasoning_effort === 'string' && payload.reasoning_effort !== 'none') {
    want = EFFORT_BUDGET[String(payload.reasoning_effort).toLowerCase()] || 4096;
  }
  if (payload.reasoning && typeof payload.reasoning === 'object' && payload.reasoning.effort) {
    want = EFFORT_BUDGET[String(payload.reasoning.effort).toLowerCase()] || 4096;
  }
  if (want === null) return null;
  if (want === false) return { type: 'disabled' };
  // budget 必须 ≥1024 且 < max_tokens；max_tokens 未限时给足空间
  const cap = maxTokens > 0 ? maxTokens - 1024 : 32768;
  const budget = Math.max(1024, Math.min(Number(want) || 4096, cap));
  if (maxTokens > 0 && budget >= maxTokens) return null; // 空间不够就不开思考，避免 400
  return { type: 'enabled', budget_tokens: budget };
}

function anthropicRequest(provider, payload) {
  const { system, messages } = toAnthropicMessages(payload.messages);
  const maxTokens = maxTokensOf(provider);
  const body = { model: payload.model, messages };
  if (system) body.system = system;
  if (maxTokens > 0) body.max_tokens = maxTokens;
  if (payload.stream) body.stream = true;
  // tools：OpenAI function 形状 → Anthropic input_schema
  const tools = (payload.tools || []).map(t => ({
    name: t.function?.name || t.name,
    description: t.function?.description || t.description || '',
    input_schema: (t.function?.parameters || t.parameters) || { type: 'object', properties: {} }
  })).filter(t => t.name);
  if (tools.length) body.tools = tools;
  // 思考：开启时 Anthropic 要求 temperature 必须为 1，且不能同时给 top_p/top_k
  const thinking = anthropicThinking(payload, maxTokens);
  if (thinking) {
    body.thinking = thinking;
    body.temperature = 1;
  } else if (Number.isFinite(Number(payload.temperature))) {
    body.temperature = Math.min(1, Math.max(0, Number(payload.temperature)));
  }
  if (Array.isArray(payload.stop) && payload.stop.length) body.stop_sequences = payload.stop.map(String).slice(0, 8);
  else if (typeof payload.stop === 'string' && payload.stop) body.stop_sequences = [payload.stop];
  // 明确丢弃：frequency_penalty / presence_penalty / top_p / top_k / reasoning_effort 等 OpenAI 专有键
  const url = /\/messages$/i.test(trimBase(provider.base_url)) ? trimBase(provider.base_url) : `${trimBase(provider.base_url)}/messages`;
  return {
    url, method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': String(provider.api_key || ''),
      'anthropic-version': ANTHROPIC_VERSION,
      accept: payload.stream ? 'text/event-stream' : 'application/json'
    },
    body
  };
}

// Anthropic SSE 事件 → OpenAI 形状的增量。需要跨 chunk 状态（内容块索引 → tool_calls 序号、usage 累计）
function createAnthropicNormalizer() {
  let usage = null;
  const blockToTool = new Map();
  let toolOrdinal = 0;
  const bumpUsage = (patch) => {
    usage = Object.assign({ prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0, reasoning_tokens: 0 }, usage || {}, patch);
    return usage;
  };
  // consumeStream 按 OpenAI 口径读 cached_tokens（prompt_tokens_details.cached_tokens），
  // 每一帧都要带上这个嵌套结构，否则后到的帧会把前面的值清零
  const usageSnapshot = () => Object.assign({}, usage, { prompt_tokens_details: { cached_tokens: usage.cached_tokens } });
  return (obj) => {
    if (!obj || typeof obj !== 'object') return null;
    const type = String(obj.type || '');
    if (type === 'error' || obj.error) {
      return { error: { message: String((obj.error && (obj.error.message || obj.error.type)) || obj.message || '上游错误') } };
    }
    if (type === 'ping' || type === 'content_block_stop') return null;
    if (type === 'message_start') {
      const u = obj.message?.usage || {};
      bumpUsage({
        prompt_tokens: Number(u.input_tokens) || 0,
        completion_tokens: Number(u.output_tokens) || 0,
        cached_tokens: Number(u.cache_read_input_tokens) || 0
      });
      return { usage: usageSnapshot() };
    }
    if (type === 'message_delta') {
      const u = obj.usage || {};
      if (u.output_tokens != null) bumpUsage({ completion_tokens: Number(u.output_tokens) || usage?.completion_tokens || 0 });
      if (u.cache_read_input_tokens != null) bumpUsage({ cached_tokens: Number(u.cache_read_input_tokens) || 0 });
      const stop = obj.delta && obj.delta.stop_reason;
      const out = { usage: usageSnapshot() };
      if (stop) out.choices = [{ delta: {}, finish_reason: stop === 'max_tokens' ? 'length' : (stop === 'tool_use' ? 'tool_calls' : 'stop') }];
      return out;
    }
    if (type === 'message_stop') return null;   // 流自然结束，无需合成 [DONE]
    if (type === 'content_block_start') {
      const blk = obj.content_block || {};
      const idx = Number(obj.index) || 0;
      if (blk.type === 'tool_use') {
        const ordinal = toolOrdinal++;
        blockToTool.set(idx, ordinal);
        return { choices: [{ delta: { tool_calls: [{ index: ordinal, id: blk.id || `toolu_${ordinal}`, function: { name: String(blk.name || ''), arguments: '' } }] } }] };
      }
      return null;
    }
    if (type === 'content_block_delta') {
      const d = obj.delta || {};
      const idx = Number(obj.index) || 0;
      if (d.type === 'text_delta' && d.text) return { choices: [{ delta: { content: String(d.text) } }] };
      if (d.type === 'thinking_delta' && d.thinking) return { choices: [{ delta: { reasoning_content: String(d.thinking) } }] };
      if (d.type === 'input_json_delta' && d.partial_json != null) {
        const ordinal = blockToTool.has(idx) ? blockToTool.get(idx) : (blockToTool.set(idx, toolOrdinal), toolOrdinal++);
        return { choices: [{ delta: { tool_calls: [{ index: ordinal, function: { arguments: String(d.partial_json) } }] } }] };
      }
      return null;
    }
    // 未知事件类型：忽略而不是报错，避免上游加字段就把对话打断
    return null;
  };
}

function anthropicReplyToOpenai(data) {
  const blocks = Array.isArray(data && data.content) ? data.content : [];
  let text = '';
  let reasoning = '';
  const toolCalls = [];
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text') text += String(b.text || '');
    else if (b.type === 'thinking') reasoning += String(b.thinking || '');
    else if (b.type === 'tool_use') toolCalls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } });
  }
  const u = (data && data.usage) || {};
  const stop = data && data.stop_reason;
  return {
    choices: [{
      message: Object.assign({ role: 'assistant', content: text }, reasoning ? { reasoning } : {}, toolCalls.length ? { tool_calls: toolCalls } : {}),
      finish_reason: stop === 'max_tokens' ? 'length' : (stop === 'tool_use' ? 'tool_calls' : 'stop')
    }],
    usage: {
      prompt_tokens: Number(u.input_tokens) || 0,
      completion_tokens: Number(u.output_tokens) || 0,
      prompt_tokens_details: { cached_tokens: Number(u.cache_read_input_tokens) || 0 }
    }
  };
}

/* ============================ 自定义协议 ============================ */
// 极简 JSONPath：只支持 $.a.b[0].c 与 a.b.0 形式（够用且不必引第三方库）
function pathTokens(p) {
  return String(p || '').trim().replace(/^\$\.?/, '').split(/[.[\]]+/).map(s => s.replace(/^['"]|['"]$/g, '')).filter(Boolean);
}
function getPath(obj, p) {
  if (!p) return undefined;
  let cur = obj;
  for (const k of pathTokens(p)) {
    if (cur == null) return undefined;
    cur = Array.isArray(cur) ? cur[Number(k)] : cur[k];
  }
  return cur;
}
function firstString(obj, paths) {
  for (const p of paths) {
    const v = getPath(obj, p);
    if (typeof v === 'string' && v) return v;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return '';
}
// 只有路径真的指到一个数值才算「有用量」——否则一个不存在的字段会被 Number(undefined)=NaN 变成 0，
// 让每个无关帧都看起来像带 usage 的有效帧
function firstNumberOrNull(obj, p) {
  if (!p) return null;
  const v = getPath(obj, p);
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// 模板渲染：值恰好是 "{{x}}" 的字符串 → 整体替换成变量原值（可以是数组/对象，键名随用户模板）；
// 其它字符串里的 {{x}} 按文本替换（对象/数组会被序列化）；变量缺失时整个键删掉，
// 免得把 "tools": [] 或 "{{model}}" 原样发给上游
const UNSET = Symbol('kh-unset');
function renderTemplate(node, vars) {
  if (Array.isArray(node)) {
    return node.map(n => { const v = renderTemplate(n, vars); return v === UNSET ? null : v; });
  }
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      const rv = renderTemplate(v, vars);
      if (rv !== UNSET) out[k] = rv;
    }
    return out;
  }
  if (typeof node !== 'string') return node;
  const whole = /^\{\{(\w+)\}\}$/.exec(node.trim());
  if (whole) {
    const v = vars[whole[1]];
    return (v === undefined || v === null || v === '') ? UNSET : v;
  }
  return node.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    const v = vars[k];
    if (v === undefined || v === null) return '';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

function customVars(provider, payload) {
  const msgs = payload.messages || [];
  const lastUser = [...msgs].reverse().find(m => m && m.role === 'user');
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  return {
    key: String(provider.api_key || ''),
    base: trimBase(provider.base_url),
    model: payload.model,
    messages: msgs,
    prompt: typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content ?? ''),
    system: msgs.filter(m => m && m.role === 'system').map(m => (typeof m.content === 'string' ? m.content : '')).join('\n\n'),
    stream: payload.stream === true,
    temperature: Number.isFinite(Number(payload.temperature)) ? Number(payload.temperature) : 1,
    max_tokens: Number.isFinite(Number(payload.max_tokens)) ? Number(payload.max_tokens) : (maxTokensOf(provider) || DEFAULT_MAX_TOKENS),
    tools: tools.length ? tools : undefined
  };
}

function customRequest(provider, payload) {
  const cfg = customConfig(provider);
  const vars = customVars(provider, payload);
  const tpl = cfg.body && typeof cfg.body === 'object' ? cfg.body : { model: '{{model}}', messages: '{{messages}}', stream: '{{stream}}' };
  const body = renderTemplate(tpl, vars);
  const headers = {};
  for (const [k, v] of Object.entries(cfg.headers && typeof cfg.headers === 'object' ? cfg.headers : {})) {
    const hv = renderTemplate(String(v), vars);
    if (hv !== '' && hv != null && hv !== UNSET) headers[k] = String(hv);
  }
  if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json';
  const rawUrl = renderTemplate(String(cfg.chat_url || '{{base}}/chat/completions'), vars);
  return {
    url: /^https?:\/\//i.test(rawUrl) ? rawUrl : `${trimBase(provider.base_url)}${rawUrl.startsWith('/') ? '' : '/'}${rawUrl}`,
    method: String(cfg.method || 'POST').toUpperCase(),
    headers, body
  };
}

function createCustomNormalizer(provider) {
  const cfg = customConfig(provider);
  const doneValues = new Set(['[DONE]', String(cfg.done_value || '')].filter(Boolean));
  return (obj, rawPayload) => {
    if (rawPayload && doneValues.has(String(rawPayload).trim())) return null;
    if (!obj || typeof obj !== 'object') return null;
    const content = cfg.stream_content_path ? firstString(obj, [cfg.stream_content_path]) : '';
    const reasoning = cfg.stream_reasoning_path ? firstString(obj, [cfg.stream_reasoning_path]) : '';
    // 只有确实取到内容/思考/用量才算有效帧；错误帧要在「没有任何正文」时才判失败（避免把 error 字段当普通文本忽略）
    const usage = {};
    const pt = firstNumberOrNull(obj, cfg.usage_prompt_path);
    const ct = firstNumberOrNull(obj, cfg.usage_completion_path);
    if (pt !== null) usage.prompt_tokens = pt;
    if (ct !== null) usage.completion_tokens = ct;
    if (!content && !reasoning && !Object.keys(usage).length) {
      const errTxt = cfg.error_path ? firstString(obj, [cfg.error_path]) : '';
      return errTxt ? { error: { message: errTxt } } : null;
    }
    const out = { choices: [{ delta: {} }] };
    if (content) out.choices[0].delta.content = content;
    if (reasoning) out.choices[0].delta.reasoning_content = reasoning;
    if (Object.keys(usage).length) out.usage = usage;
    return out;
  };
}

function customReplyToOpenai(provider, data) {
  const cfg = customConfig(provider);
  const text = firstString(data, [cfg.content_path, cfg.stream_content_path].filter(Boolean));
  const reasoning = cfg.reasoning_path ? firstString(data, [cfg.reasoning_path]) : '';
  const usage = {};
  const pt = firstNumberOrNull(data, cfg.usage_prompt_path);
  const ct = firstNumberOrNull(data, cfg.usage_completion_path);
  if (pt !== null) usage.prompt_tokens = pt;
  if (ct !== null) usage.completion_tokens = ct;
  const errTxt = cfg.error_path ? firstString(data, [cfg.error_path]) : '';
  return {
    choices: [{ message: Object.assign({ role: 'assistant', content: text }, reasoning ? { reasoning } : {}), finish_reason: 'stop' }],
    usage, error: (!text && errTxt) ? { message: errTxt } : undefined
  };
}

/* ============================ 对外统一入口 ============================ */
function buildChatRequest(provider, payload) {
  const style = styleOf(provider);
  if (style === 'anthropic') return anthropicRequest(provider, payload);
  if (style === 'custom') return customRequest(provider, payload);
  return openaiRequest(provider, payload);
}

// 返回 normalize(obj, rawPayloadText) → OpenAI 形状对象 | null（null = 该事件忽略）
function createChunkNormalizer(provider) {
  const style = styleOf(provider);
  if (style === 'anthropic') return createAnthropicNormalizer();
  if (style === 'custom') return createCustomNormalizer(provider);
  return (obj) => obj || null;
}

// 非流式响应（测速、压缩用）归一化为 OpenAI 形状
function normalizeReply(provider, data) {
  const style = styleOf(provider);
  if (style === 'anthropic') return anthropicReplyToOpenai(data);
  if (style === 'custom') return customReplyToOpenai(provider, data);
  return data;
}

// 模型列表请求：openai/custom 可拉，anthropic 官方是 /v1/models（需 beta 头，多数网关没有）
function listRequest(provider) {
  const style = styleOf(provider);
  if (style === 'anthropic') {
    return { url: `${trimBase(provider.base_url)}/models`, headers: { 'x-api-key': String(provider.api_key || ''), 'anthropic-version': ANTHROPIC_VERSION, accept: 'application/json' } };
  }
  if (style === 'custom') {
    const cfg = customConfig(provider);
    if (!cfg.list_url) return null;
    const vars = { key: String(provider.api_key || ''), base: trimBase(provider.base_url) };
    const rawUrl = renderTemplate(String(cfg.list_url), vars);
    const headers = { 'Content-Type': 'application/json' };
    for (const [k, v] of Object.entries(cfg.headers || {})) { const hv = renderTemplate(String(v), vars); if (hv !== '') headers[k] = String(hv); }
    return { url: /^https?:\/\//i.test(rawUrl) ? rawUrl : `${trimBase(provider.base_url)}${rawUrl.startsWith('/') ? '' : '/'}${rawUrl}`, headers };
  }
  return { url: `${trimBase(provider.base_url)}/models`, headers: { Authorization: `Bearer ${provider.api_key}`, 'Content-Type': 'application/json' } };
}

// 列表响应 → 模型 ID 数组
function parseModelList(provider, data) {
  const style = styleOf(provider);
  const pick = (x) => (typeof x === 'string' ? x : (x && (x.id || x.name || x.model_id || x.model)) || '');
  if (style === 'custom') {
    const cfg = customConfig(provider);
    const arr = cfg.list_path ? getPath(data, cfg.list_path) : (Array.isArray(data) ? data : (data && (data.data || data.models || data.result)));
    return (Array.isArray(arr) ? arr : []).map(pick).filter(Boolean);
  }
  if (style === 'anthropic') {
    const arr = (data && (data.data || data.models)) || (Array.isArray(data) ? data : []);
    return (Array.isArray(arr) ? arr : []).map(x => (typeof x === 'string' ? x : (x && (x.id || x.name || x.display_name))).trim()).filter(Boolean);
  }
  const arr = Array.isArray(data) ? data : (data && (data.data || data.models)) || [];
  return (Array.isArray(arr) ? arr : []).map(pick).filter(Boolean);
}

// 该协议是否支持思考参数（决定要不要做多样式轮转）
function supportsThinkingRotation(provider) {
  return styleOf(provider) !== 'anthropic';
}

// Anthropic 只有一个思考形状，不参与 OpenAI 系的轮转；mode=default 时不发思考参数
function anthropicVariants(norm) {
  const mode = String((norm && norm.mode) || 'default');
  if (mode === 'off') return [{ name: 'anthropic-disabled', fields: () => ({ thinking: { type: 'disabled' } }) }];
  if (mode === 'default') return [];
  return [{
    name: 'anthropic-enabled',
    fields: (eff) => ({ thinking: { type: 'enabled', budget_tokens: EFFORT_BUDGET[String(eff || 'medium').toLowerCase()] || 4096 } })
  }];
}

module.exports = {
  STYLES, DEFAULT_MAX_TOKENS,
  styleOf, customConfig, maxTokensOf,
  buildChatRequest, createChunkNormalizer, normalizeReply,
  listRequest, parseModelList, anthropicVariants,
  // 暴露给测试
  _internal: { toAnthropicMessages, anthropicThinking, anthropicRequest, anthropicReplyToOpenai, createAnthropicNormalizer, getPath, renderTemplate, customRequest, customVars, createCustomNormalizer }
};
