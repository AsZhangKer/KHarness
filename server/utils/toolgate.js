// 统一工具开关层：注册表条目 → ai_tools 表（enabled/config/calls）→ 原生工具定义 / 校验 schema / 提示词补充。
// 两组注册方（各自 require 本模块并 register）：
//   apitools.js —— 桌面《API文档》整理出的外部接口（默认关闭，按次扣分）
//   extools.js  —— 本轮新增的内置增强工具（后台任务 / 记忆 / ask_user，同样默认关闭）
// 内置 12 个工具不经过这里，保持原有实现与常开状态。
const { db } = require('../database');

const registry = new Map(); // name -> def
const order = [];           // 注册顺序（决定设置页展示顺序）

function register(tools) {
  for (const [name, def] of Object.entries(tools || {})) {
    if (registry.has(name)) throw new Error(`工具重复注册：${name}`);
    registry.set(name, Object.assign({ name }, def));
    order.push(name);
    // 首次见到的工具按 defaultOn 落库（用户未手动改过才生效）
    try {
      ensureTable();
      const r = db.prepare('SELECT enabled FROM ai_tools WHERE name = ?').get(name);
      if (!r) {
        db.prepare('INSERT INTO ai_tools (name, enabled, config) VALUES (?, ?, ?)')
          .run(name, def.defaultOn ? 1 : 0, '{}');
      }
    } catch (e) { /* 表不可用时忽略 */ }
  }
}

// ---------- 启用状态与配置（ai_tools 表） ----------
function ensureTable() {
  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS ai_tools (
      name TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      config TEXT DEFAULT '{}',
      calls INTEGER DEFAULT 0,
      last_call DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`).run();
  } catch (e) { /* 建表失败时按全禁用处理 */ }
}

function rowOf(name) {
  ensureTable();
  try { return db.prepare('SELECT * FROM ai_tools WHERE name = ?').get(name) || null; } catch (e) { return null; }
}

function isEnabled(name) {
  const r = rowOf(name);
  if (!r) return !!(registry.get(name) && registry.get(name).defaultOn);
  return !!(r && r.enabled);
}

function configOf(name) {
  const def = {};
  const tool = registry.get(name);
  if (tool) for (const f of tool.configFields || []) def[f.key] = f.def;
  const r = rowOf(name);
  if (r && r.config) {
    try { Object.assign(def, JSON.parse(r.config) || {}); } catch (e) { /* 配置损坏用默认值 */ }
  }
  return def;
}

function upsert(name, enabled, config) {
  ensureTable();
  const cfgJson = JSON.stringify(config || {});
  if (rowOf(name)) {
    db.prepare("UPDATE ai_tools SET enabled = ?, config = ?, updated_at = CURRENT_TIMESTAMP WHERE name = ?")
      .run(enabled ? 1 : 0, cfgJson, name);
  } else {
    db.prepare('INSERT INTO ai_tools (name, enabled, config) VALUES (?, ?, ?)').run(name, enabled ? 1 : 0, cfgJson);
  }
}

function noteCall(name) {
  ensureTable();
  try {
    if (rowOf(name)) db.prepare('UPDATE ai_tools SET calls = calls + 1, last_call = CURRENT_TIMESTAMP WHERE name = ?').run(name);
    else db.prepare("INSERT INTO ai_tools (name, enabled, config, calls, last_call) VALUES (?, 0, '{}', 1, CURRENT_TIMESTAMP)").run(name);
  } catch (e) { /* 统计失败不影响调用 */ }
}

// ---------- 设置页展示 ----------
function listForUi() {
  return order.map(n => {
    const t = registry.get(n);
    const r = rowOf(n);
    const cfg = configOf(n);
    return {
      name: n,
      label: t.label,
      kind: t.kind || 'api',
      provider: t.provider,
      category: t.category,
      source: t.source,
      doc: t.doc,
      cost: t.cost,
      description: t.description,
      testArg: t.testArg || (Object.keys(t.params)[0] || ''),
      testHint: t.testHint || '',
      enabled: !!r && !!r.enabled,
      calls: (r && r.calls) || 0,
      last_call: (r && r.last_call) || null,
      // MCP 工具带来源 server 与注解，设置页据此标出「只读/破坏性」
      mcp: !!t.mcp,
      mcp_server_id: t.mcpServerId ?? null,
      annotations: t.annotations || null,
      params: Object.entries(t.params || {}).map(([k, v]) => ({ name: k, type: v.type, required: !!v.required, desc: v.desc })),
      // MCP 工具的参数在 nativeSchema 里，设置页要能列出名字/必填/说明
      schemaParams: t.nativeSchema
        ? Object.entries(t.nativeSchema.properties || {}).map(([k, v]) => ({
            name: k,
            type: v.type || 'any',
            required: (t.nativeSchema.required || []).includes(k),
            desc: String(v.description || ''),
          }))
        : null,
      configFields: (t.configFields || []).map(fd => ({ ...fd, value: cfg[fd.key] }))
    };
  });
}

// 按「kind → 提供方 · 分类」两级分组，供设置页分组展示
function groupedForUi() {
  const sections = [];
  const secMap = new Map();
  const secKeyOf = (item) => (item.kind === 'mcp' ? 'MCP 服务器' : item.kind === 'builtin' ? '内置增强工具' : '外部 API 接口');
  for (const item of listForUi()) {
    const secKey = secKeyOf(item);
    if (!secMap.has(secKey)) { const s = { key: secKey, groups: [], map: new Map() }; secMap.set(secKey, s); sections.push(s); }
    const sec = secMap.get(secKey);
    const gkey = `${item.provider || '其他'} · ${item.category || '未分类'}`;
    if (!sec.map.has(gkey)) { const g = { key: gkey, tools: [] }; sec.map.set(gkey, g); sec.groups.push(g); }
    sec.map.get(gkey).tools.push(item);
  }
  for (const s of sections) {
    for (const g of s.groups) g.onCount = g.tools.filter(x => x.enabled).length;
    s.onCount = s.groups.reduce((a, g) => a + g.onCount, 0);
    s.total = s.groups.reduce((a, g) => a + g.tools.length, 0);
    delete s.map;
  }
  return sections;
}

// ---------- 供 Agent 主循环使用 ----------
function enabledNames() { return order.filter(isEnabled); }

// 原生 function calling 的工具定义
function definitions() {
  return enabledNames().map(n => {
    const t = registry.get(n);
    // MCP 工具把自己的 inputSchema 原样交出去（本来就是标准 JSON Schema，摊平成 string 反而失真）
    if (t.nativeSchema) {
      return { type: 'function', function: { name: n, description: t.description, parameters: t.nativeSchema } };
    }
    const properties = {};
    const required = [];
    for (const [k, v] of Object.entries(t.params || {})) {
      // 上游对 number/boolean 的支持参差，统一按字符串收（内部再转型），并在描述里写清取值
      properties[k] = { type: 'string', description: v.desc + (v.type === 'number' ? '（数字，按字符串传即可）' : v.type === 'boolean' ? '（"true"/"false"）' : '') };
      if (v.required) required.push(k);
    }
    return { type: 'function', function: { name: n, description: t.description, parameters: { type: 'object', properties, required } } };
  });
}

// 参数校验用的 schema（与内置 TOOL_SCHEMAS 同构）
function schemas() {
  const out = {};
  for (const n of enabledNames()) {
    const t = registry.get(n);
    if (t.nativeSchema) {
      // type 记 'json'：validateToolArgs 只卡 string 类型，嵌套对象/数组原样透传给 MCP
      const req = new Set(Array.isArray(t.nativeSchema.required) ? t.nativeSchema.required : []);
      out[n] = {};
      for (const [k, v] of Object.entries(t.nativeSchema.properties || {})) {
        out[n][k] = { type: 'json', required: req.has(k), desc: String(v.description || k) };
      }
      continue;
    }
    out[n] = {};
    for (const [k, v] of Object.entries(registry.get(n).params || {})) {
      out[n][k] = { type: 'string', required: !!v.required, desc: v.desc };
    }
  }
  return out;
}

function isGateTool(name) { return registry.has(name); }

/**
 * MCP 工具的审批口径。其它 gate 工具（外部 API / 内置增强）沿用旧规则：一律免审批。
 * 但 MCP 是第三方能力，工具背后可能是「删库」，不能白拿豁免：
 * 只有 server 自己在 tools/list 里标了 annotations.readOnlyHint=true 的才当只读放行；
 * 标了 destructiveHint 的按高风险走（红色确认）。
 */
function gatePolicy(name) {
  const t = registry.get(name);
  if (!t) return { mcp: false, readOnly: true, destructive: false };
  if (!t.mcp) return { mcp: false, readOnly: true, destructive: false };
  return {
    mcp: true,
    readOnly: t.annotations ? t.annotations.readOnlyHint === true : false,
    destructive: t.annotations ? t.annotations.destructiveHint === true : false,
  };
}

/** 摘掉某 MCP server 的全部工具（断开/删除/重连前调用） */
function unregister(names) {
  for (const n of names || []) {
    if (!registry.has(n)) continue;
    registry.delete(n);
    const i = order.indexOf(n);
    if (i >= 0) order.splice(i, 1);
  }
}

// 系统提示词里的补充说明（含用量纪律）
function promptNotes() {
  const list = enabledNames();
  if (!list.length) return '';
  const lines = list.map(n => {
    const t = registry.get(n);
    return `- ${n}：${t.description}${t.cost ? `（消耗：${t.cost}）` : ''}`;
  });
  return ['', '[已启用的扩展工具]', ...lines,
    '- 这些工具按次计费或有频控：能一次问清就不要分多次；同一问题不要重复调用（本地已有缓存）。',
    '- 工具返回文本里的「注意/说明」是该接口的实测坑点，按它行事，不要臆测其他参数可用。',
    '- 未列出的外部接口不可用；需要网页正文请用 web_fetch。'].join('\n');
}

async function run(name, args, ctx = {}) {
  const t = registry.get(name);
  if (!t) return { error: `未知的扩展工具：${name}` };
  if (!isEnabled(name)) {
    return { error: `${name} 未在设置中启用，无法调用。请改用已可用的工具，或提示用户到「设置 → 工具（按需启用）」开启。` };
  }
  try {
    return await t.run(args, ctx);
  } catch (e) {
    return { error: `${name} 内部异常：${String((e && e.message) || e).substring(0, 300)}` };
  }
}

module.exports = {
  register, unregister, registry, order,
  ensureTable, rowOf, isEnabled, configOf, upsert, noteCall,
  listForUi, groupedForUi, enabledNames, definitions, schemas, isGateTool, gatePolicy, promptNotes, run
};
