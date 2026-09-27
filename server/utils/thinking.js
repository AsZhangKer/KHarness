// 思考流处理与思考参数样式
// 1) 部分模型不走 delta.reasoning_content，而是把思考混在正文里（think 类标签）。
//    这里用增量状态机拆分：标签未闭合也能持续抽取，并防止标签被增量分片切断。
// 2) 各家上游思考参数样式不同，按序尝试、被 400 拒绝即换下一种样式。

const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'];

// 成对的思考标签（小写匹配）
const TAG_PAIRS = [
  ['<thin' + 'k>', '</thin' + 'k>'],
  ['<thinking>', '</thinking>'],
  ['<reasoning>', '</reasoning>'],
  ['<thought>', '</thought>'],
  ['<thoughts>', '</thoughts>'],
  ['<analysis>', '</analysis>']
];

// 上游可能下发原生特殊 token（用码位拼装，避免本文件出现字面量）
const LT = String.fromCharCode(60), GT = String.fromCharCode(62), BAR = String.fromCharCode(124);
function nativeToken(name) { return LT + BAR + name + BAR + GT; }
const NATIVE_TOKENS = [nativeToken('think'), nativeToken('/think'), nativeToken('thinking'), nativeToken('/thinking'), nativeToken('tool_call'), nativeToken('/tool_call')];

function effortBudget(eff) {
  return { minimal: 1024, low: 4096, medium: 16384, high: 32768, xhigh: 65536 }[String(eff || 'medium')] || 16384;
}

// ---------- 思考参数样式表 ----------
const ENABLE_VARIANTS = [
  { label: 'reasoning_effort', fields: (eff) => ({ reasoning_effort: eff }) },
  { label: 'thinking{type:enabled}', fields: () => ({ thinking: { type: 'enabled' } }) },
  { label: 'thinking{enabled,budget}', fields: (eff) => ({ thinking: { enabled: true, budget_tokens: effortBudget(eff) } }) },
  { label: 'reasoning{effort}', fields: (eff) => ({ reasoning: { effort: eff } }) },
  { label: 'reasoning{enabled}', fields: () => ({ reasoning: { enabled: true } }) },
  { label: 'enable_thinking', fields: () => ({ enable_thinking: true }) },
  { label: 'chat_template_kwargs', fields: () => ({ chat_template_kwargs: { thinking: true } }) }
];

const DISABLE_VARIANTS = [
  { label: 'thinking{type:disabled}', fields: () => ({ thinking: { type: 'disabled' } }) },
  { label: 'reasoning_effort:none', fields: () => ({ reasoning_effort: 'none' }) },
  { label: 'thinking{enabled:false}', fields: () => ({ thinking: { enabled: false } }) },
  { label: 'enable_thinking:false', fields: () => ({ enable_thinking: false, chat_template_kwargs: { thinking: false } }) }
];

// 会话设置里的强度值归一：auto/on/off/minimal/low/medium/high/xhigh（界面另有 max = 最高档）；其余按 medium 兜底
function normalizeThinkingLevel(raw, supportedCsv) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v || v === 'auto') return { mode: 'default', effort: null };
  if (/^(off|none|false|0|关闭)$/.test(v)) return { mode: 'off', effort: null };
  if (/^(on|true|enable|开启)$/.test(v)) return { mode: 'on', effort: 'medium' };
  let eff = EFFORTS.includes(v) ? v : null;
  // 'max' 是界面档位，不属于上游参数词表（OpenAI 系 reasoning_effort 最高 xhigh）。
  // 以前它既不在 EFFORTS 也不落在下面的正则分支里 → 兜底成 medium：选了 max 拿到 medium，静默降一档。
  // 这里显式并到最高档，让「界面档位」和「实际发出去的参数」对得上。
  if (!eff && /^(max|ultra|最高|极限)$/.test(v)) eff = 'xhigh';
  if (!eff) {
    if (/min/.test(v)) eff = 'minimal';
    else if (/low/.test(v)) eff = 'low';
    else if (/mid|中/.test(v)) eff = 'medium';
    else if (/xhigh|ultra|极/.test(v)) eff = 'xhigh';
    else if (/high/.test(v)) eff = 'high';
    else eff = 'medium';
  }
  const supported = String(supportedCsv || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  // 模型声明了档位清单时按清单收敛（别把 xhigh 发给只支持 low/high 的模型）
  if (supported.length && !supported.includes('auto') && !supported.includes(eff)) {
    const idx = EFFORTS.indexOf(eff);
    let best = null;
    for (const s of supported) {
      const i = EFFORTS.indexOf(s);
      if (i === -1) continue;
      if (best === null || Math.abs(i - idx) < Math.abs(EFFORTS.indexOf(best) - idx)) best = s;
    }
    if (best) eff = best;
  }
  return { mode: 'on', effort: eff };
}

function variantsFor(norm) {
  if (norm.mode === 'off') return DISABLE_VARIANTS;
  if (norm.mode === 'default') return [];
  return ENABLE_VARIANTS;
}

// 上游 400 错误体是否指向思考参数（避免把无关 400 误判成参数样式问题而轮流失效）
const THINK_PARAM_WORDS = /(thinking|reasoning|enable_thinking|reasoning_effort|thinking_budget|chat_template_kwargs)/i;
const REJECT_WORDS = /(not\s+supported|unsupported|unrecognized|unknown\s+(field|parameter|key|property)|invalid\s+(field|parameter|key|value|argument)|unexpected[^.]{0,20}(field|key|parameter|argument)|not\s+a\s+valid|is\s+not\s+allowed|disallow|cannot\s+be\s+used|extra\s+(input|fields)|additional\s+properties|参数.*(不支持|无效|非法|未知))/i;
function isThinkingParamError(body) {
  const b = String(body || '');
  return THINK_PARAM_WORDS.test(b) && REJECT_WORDS.test(b);
}

// ---------- 增量思考拆分状态机 ----------
function createReasoningSplitter() {
  let inReasoning = false;   // 标签内状态
  let nativeOpen = false;    // 原生 token 触发的思考态（一直吃到下一个原生 token 或结束）
  let carry = '';            // 可能与标签前缀重叠的尾巴
  let sawAny = false;

  const findTag = (s, from, tags) => {
    let best = -1, bestLen = 0;
    for (const t of tags) {
      const i = s.indexOf(t, from);
      if (i !== -1 && (best === -1 || i < best)) { best = i; bestLen = t.length; }
    }
    return best === -1 ? null : { index: best, length: bestLen };
  };

  const closeTags = () => (nativeOpen ? TAG_PAIRS.map(p => p[1]).concat(NATIVE_TOKENS) : TAG_PAIRS.map(p => p[1]));
  const openTags = () => (nativeOpen ? NATIVE_TOKENS : TAG_PAIRS.map(p => p[0]).concat(NATIVE_TOKENS));
  // 标签名最长后缀 = 可能因分片而不完整的长度
  const MAX_PARTIAL = Math.max(...NATIVE_TOKENS.map(t => t.length - 1), ...TAG_PAIRS.flatMap(p => [p[0], p[1]]).map(t => t.length - 1));
  const holdLength = (tail) => {
    const capped = tail.slice(-MAX_PARTIAL);
    const tags = inReasoning || nativeOpen ? closeTags() : openTags();
    for (let k = capped.length; k > 0; k--) {
      const cand = capped.slice(capped.length - k);
      if (tags.some(t => t.startsWith(cand))) return k;
    }
    return 0;
  };

  return {
    get sawReasoning() { return sawAny; },
    push(chunk) {
      let s = carry + String(chunk || '');
      carry = '';
      const out = { content: '', reasoning: '' };
      let pos = 0;
      for (;;) {
        const tags = inReasoning || nativeOpen ? closeTags() : openTags();
        const hit = findTag(s, pos, tags);
        if (!hit) {
          const tail = s.slice(pos);
          const hold = inReasoning || nativeOpen ? holdLength(tail) : holdLength(tail);
          const emitText = hold ? tail.slice(0, tail.length - hold) : tail;
          if (inReasoning || nativeOpen) out.reasoning += emitText; else out.content += emitText;
          carry = hold ? tail.slice(tail.length - hold) : '';
          pos = s.length;
          break;
        }
        const before = s.slice(pos, hit.index);
        if (inReasoning || nativeOpen) out.reasoning += before; else out.content += before;
        const hitStr = s.substr(hit.index, hit.length).toLowerCase();
        // 标签切换：成对标签按开/闭切换；原生 token 开启思考段，遇到下一个 token 或闭标签结束
        const isPairOpen = TAG_PAIRS.some(p => p[0] === hitStr);
        const isPairClose = TAG_PAIRS.some(p => p[1] === hitStr);
        if (nativeOpen) {
          nativeOpen = false;
          if (isPairOpen) inReasoning = true;
          sawAny = true;
        } else if (inReasoning) {
          if (isPairClose) inReasoning = false;
        } else {
          if (isPairOpen) inReasoning = true;
          else nativeOpen = true;   // 原生思考开 token
          sawAny = true;
        }
        pos = hit.index + hit.length;
      }
      if (out.reasoning) sawAny = true;
      return out;
    },
    flush() {
      const rest = carry;
      carry = '';
      return rest ? (inReasoning || nativeOpen ? { content: '', reasoning: rest } : { content: rest, reasoning: '' }) : { content: '', reasoning: '' };
    }
  };
}

// 整段清洗（用于历史消息/入库文本）：把内联思考抽出为 reasoning，正文只留回答
function stripInlineReasoning(text) {
  const sp = createReasoningSplitter();
  const a = sp.push(String(text || ''));
  const b = sp.flush();
  return { content: (a.content + b.content), reasoning: (a.reasoning + b.reasoning) };
}

// 去掉原生特殊 token（不改变正文其余内容）
function scrubNativeTokens(text) {
  let s = String(text || '');
  for (const t of NATIVE_TOKENS) s = s.split(t).join('');
  return s;
}

module.exports = {
  EFFORTS, ENABLE_VARIANTS, DISABLE_VARIANTS,
  normalizeThinkingLevel, variantsFor, isThinkingParamError,
  createReasoningSplitter, stripInlineReasoning, scrubNativeTokens, effortBudget
};
