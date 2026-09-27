<template>
  <div class="msg" :class="['role-' + role, spkClass, { busy }]">
    <div class="meta">
      <span class="who">{{ whoLabel }}</span>
      <span v-if="model_name" class="dim">{{ model_name }}</span>
      <span v-if="usage" class="dim">入 {{ usage.prompt_tokens || 0 }} · 出 {{ usage.completion_tokens || 0 }}</span>
      <button class="link-btn" type="button" @click="copyBody">复制</button>
      <button
        v-if="role === 'user' && canRetract"
        class="link-btn"
        type="button"
        @click="$emit('retract', { id: msgId, content, index })"
      >撤回</button>
    </div>

    <!-- 时间线：工具 / 思考 / 正文交错 -->
    <template v-if="role !== 'user'">
      <template v-for="(item, i) in timeline" :key="i">
        <details v-if="item.kind === 'reason' && item.text" class="reason" :open="busy || item.open || prefs.reasonOpen">
          <summary>思考过程</summary>
          <pre>{{ item.text }}</pre>
        </details>

        <!-- 一整组工具调用折叠成的一行（点开才铺开，正文之前不打扰） -->
        <div
          v-else-if="isFoldHead(i)"
          class="step fold"
          role="button"
          tabindex="0"
          @click="unfoldGroup(i)"
          @keydown.enter.prevent="unfoldGroup(i)"
        >
          <i class="fas fa-screwdriver-wrench"></i>
          <span>{{ isFoldHead(i).len }} 步工具调用</span>
          <button class="link-btn" type="button" @click.stop="unfoldGroup(i)">展开</button>
        </div>

        <div
          v-else-if="item.kind === 'step' && !item.hide && !stepsHidden(i)"
          class="step"
          :class="['t-' + (item.type || 'tool'), { edit: isEdit(item) && item.type === 'result', err: !!item.error }]"
        >
          <div class="step-head" :class="{ clickable: isEdit(item) && item.diff?.length }"
               @click="isEdit(item) && item.diff?.length ? toggleDiff(i) : null">
            <i :class="iconOf(item)"></i>
            <span v-if="isEdit(item) && item.type === 'result'" class="verb">{{ verbOf(item) }}</span>
            <code v-else>{{ item.name || (item.type === 'note' ? 'note' : item.type === 'compress' ? '压缩上下文' : 'step') }}</code>
            <span v-if="pathOf(item)" class="path" :title="pathOf(item)">{{ pathOf(item) }}</span>
            <span v-if="item.type === 'result' && item.new_file" class="badge">新建</span>
            <span v-if="item.diff?.length" class="nums">
              <span class="num-pos">+{{ countSign(item, '+') }}</span>
              <span class="num-neg">-{{ countSign(item, '-') }}</span>
            </span>
            <button
              v-if="item.undo_id"
              class="link-btn"
              type="button"
              :disabled="item.undone"
              @click.stop="$emit('undo', item.ref || item)"
            >{{ item.undone ? '已撤销' : '撤销 ↺' }}</button>
            <button
              v-if="isEdit(item) && item.diff?.length"
              class="link-btn review"
              type="button"
              @click.stop="toggleDiff(i)"
            >{{ diffOpen(i) ? '收起' : '审阅' }}</button>
          </div>
          <div v-if="item.type === 'note'" class="step-note">{{ item.message }}</div>
          <!-- 压缩上下文：一条卡看完「为什么压、压掉多少、压完剩多少」，摘要原文折叠在里面可展开 -->
          <div v-else-if="item.type === 'compress'" class="step-note">
            {{ compressLine(item) }}
            <details v-if="item.summary" class="cp-detail">
              <summary>摘要原文（{{ item.chars || item.summary.length }} 字）</summary>
              <pre class="step-body cp-summary">{{ item.summary }}</pre>
            </details>
          </div>
          <div v-else-if="diffOpen(i) && item.diff?.length" class="diff">
            <div
              v-for="(ln, li) in diffLines(item)"
              :key="li"
              class="diff-line"
              :class="ln.kind"
            ><span class="gutter">{{ ln.mark }}</span><span class="code" v-html="ln.html"></span></div>
          </div>
          <div v-else-if="item.kind === 'step' && preview(item)" class="step-body-wrap">
            <button class="copy-code" type="button" title="复制" @click.stop="copyText(preview(item))">
              <i class="fas fa-copy"></i>
            </button>
            <pre class="step-body"><code class="hl" v-html="highlightCode(preview(item), guessLang(item))"></code></pre>
          </div>
        </div>

        <div
          v-else-if="item.kind === 'text' && item.text"
          class="body-wrap"
        >
          <div
            class="body md"
            :class="{ clamped: prefs.longCollapse && !textOpen[i] && isLongText(item.text) }"
            @click="onMdClick"
            v-html="withCaret(renderMarkdown(item.text), busy && i === timeline.length - 1)"
          ></div>
          <button
            v-if="prefs.longCollapse && isLongText(item.text)"
            class="link-btn unfold"
            type="button"
            @click="textOpen[i] = !textOpen[i]"
          >{{ textOpen[i] ? '收起' : `展开回复（${lineCount(item.text)} 行）` }}</button>
        </div>
        <div v-if="busy && i === timeline.length - 1" class="phase">
          <i class="fas fa-circle-notch fa-spin"></i> {{ phaseLabel }}
        </div>
      </template>
      <div v-if="!timeline.length" class="body md" v-html="renderMarkdown(content)"></div>
    </template>
    <div v-else class="body user-body">
      <template v-for="(sg, i) in userSegments" :key="i">
        <button
          v-if="sg.at"
          class="at-chip"
          type="button"
          :title="`点击复制：${sg.abs}${sg.hint || ''}`"
          @click="copyMention(sg.abs)"
        ><i class="fas fa-at"></i>{{ sg.name }}</button>
        <span v-else>{{ sg.text }}</span>
      </template>
    </div>
  </div>
</template>

<script setup>
import { computed, reactive } from 'vue';
import { renderMarkdown, highlightCode, highlightToLines, langFromPath, escapeHtml } from '../../utils/format';
import { toast } from '../../stores/toast';
import { uiPrefs } from '../../stores/prefs';

const prefs = uiPrefs.state;

const phaseLabel = computed(() => {
  const last = (props.steps || []).slice(-1)[0];
  if (last && last.type === 'tool') {
    return last.name === 'write_file' || last.name === 'edit_file' ? '~ Editing…' : '~ Working…';
  }
  return '~ Thinking…';
});

function withCaret(html, on) {
  if (!on) return html;
  // 插到最后一个块级闭合前，光标贴住最后一行文字
  const m = /^(.*)(<\/(?:p|li|pre|h[1-6]|blockquote)>)([\s\S]*)$/i.exec(html);
  if (m) return `${m[1]}<span class="caret-dot"></span>${m[2]}${m[3]}`;
  return `${html}<span class="caret-dot"></span>`;
}

const props = defineProps({
  role: { type: String, default: 'assistant' },
  content: { type: String, default: '' },
  /** 当前会话的工作目录：用来把 @path 里的相对路径补成可复制的绝对路径 */
  cwd: { type: String, default: '' },
  /** 这条会话在远端：路径按 posix 拼，否则按 Windows 的分隔符拼 */
  remote: { type: Boolean, default: false },
  reasoning: { type: String, default: '' },
  steps: { type: Array, default: () => [] },
  timeline: { type: Array, default: null },
  usage: { type: Object, default: null },
  model_name: { type: String, default: '' },
  // 托管模式：同一条会话里监工与工作者各说各的，空 = 普通对话
  speaker: { type: String, default: '' },
  index: { type: Number, default: -1 },
  msgId: { type: Number, default: null },
  canRetract: { type: Boolean, default: false },
  busy: { type: Boolean, default: false },
});

defineEmits(['undo', 'retract']);

/**
 * 用户消息里的 @路径 芯片化。
 * 与输入框那边同一套记号：@ 必须在行首或空白后，token 到下一个空白/中文标点为止。
 * 一律走文本分段（不 v-html），所以模型或用户写的 HTML 仍然不可能被注入。
 */
const MENTION_RE = /(^|[\s(（【「])@([^\s)）】」，。、；：!?！？'"`]{1,300})/g;

function joinPath(base, rel) {
  const b = String(base || '');
  const win = !props.remote && /^[A-Za-z]:/.test(b);
  const sep = win ? '\\' : '/';
  const clean = String(rel || '').replace(/^\.\/+/, '');
  if (!b) return clean;
  if (/^[A-Za-z]:[\\/]/.test(clean) || clean.startsWith('/') || clean.startsWith('\\')) {
    // 绝对路径：Windows 下 '/x/y' 这种盘相对写法补上当前盘符，其余原样
    return win && clean.startsWith('/') && b ? b.slice(0, 2) + clean.replace(/\//g, sep) : clean;
  }
  const head = b.replace(/[\\/]+$/, '');
  const out = `${head}${sep}${clean.replace(/[\\/]/g, sep)}`;
  // 折叠 ./ 与 a/../（够用即可；这是给人看的绝对路径，不是解析器）
  const parts = out.split(sep);
  const stack = [];
  for (const p of parts) {
    if (!p || p === '.') continue;
    if (p === '..' && stack.length && !/^[A-Za-z]:$/.test(stack[stack.length - 1])) stack.pop();
    else stack.push(p);
  }
  return (win ? `${stack.shift() || ''}${stack.length ? sep : ''}` : sep) + stack.join(sep);
}

const userSegments = computed(() => {
  const text = String(props.content || '');
  const segs = [];
  let last = 0;
  MENTION_RE.lastIndex = 0;
  let m;
  while ((m = MENTION_RE.exec(text))) {
    const lead = m[1] || '';
    const startIdx = m.index + lead.length;   // 指向 '@'
    const token = m[2];
    if (startIdx > last) segs.push({ text: text.slice(last, startIdx) });
    const abs = joinPath(props.cwd, token);
    // 会话还没有工作目录时（新建的自由会话），相对路径就是它本身 —— 标题里说清楚，别让人以为复制到的是绝对路径
    segs.push({ at: true, name: `@${token}`, abs, hint: abs === token ? '（相对会话目录；当前会话还没选定目录）' : '' });
    last = startIdx + token.length + 1;
  }
  if (last < text.length) segs.push({ text: text.slice(last) });
  return segs.length ? segs : [{ text }];
});

async function copyMention(abs) {
  try {
    await navigator.clipboard.writeText(abs);
    toast(`已复制路径：${abs}`, 'success');
  } catch (e) {
    toast(`复制失败，路径是：${abs}`, 'warn', 6000);
  }
}

const openDiff = reactive({});
const textOpen = reactive({});

/** 托管模式下的说话人标签：普通对话仍是「你 / AI」，载荷一字不变 */
const whoLabel = computed(() => {
  // 监工替用户下发的命令也是一条 user 消息，得标出来，不然用户以为是自己说的
  if (props.speaker === 'supervisor') return '监工';
  if (props.role === 'user') return '你';
  if (props.speaker === 'worker') return '执行';
  return 'AI';
});
const spkClass = computed(() => (props.speaker ? 'spk-' + props.speaker : ''));

/** diff 默认展开（参考图：编辑卡一眼看到改动），用户点「收起」后记住 */
function diffOpen(i) {
  return i in openDiff ? openDiff[i] : true;
}

/** 时间线：优先用流式顺序（timeline），否则 steps+正文 */
const timeline = computed(() => {
  let items;
  if (Array.isArray(props.timeline) && props.timeline.length) {
    // 关键：step 的展示字段从 ref（steps 里的活对象）取，撤销等状态变化才会即时回写
    items = props.timeline.map((item) =>
      item.kind === 'step' ? { kind: 'step', ...item.ref, ref: item.ref || item } : item
    );
  } else {
    const out = [];
    if (props.reasoning && String(props.reasoning).trim()) {
      out.push({ kind: 'reason', text: String(props.reasoning) });
    }
    for (const s of props.steps || []) out.push({ kind: 'step', ...s, ref: s });
    if (props.content) out.push({ kind: 'text', text: props.content });
    items = out;
  }
  // 工具调用行与它的结果行成对出现时，只留结果行（编辑卡一张就够）
  for (let i = 0; i < items.length; i++) {
    const cur = items[i];
    const next = items[i + 1];
    if (
      cur.kind === 'step' && cur.type === 'tool' &&
      next?.kind === 'step' && next.type === 'result' && next.name === cur.name
    ) {
      items[i] = { ...cur, hide: true };
    }
  }
  return items;
});

/* ── 连续的工具调用归成一组 ────────────────────────────────────────────
   开了「工具调用自动折叠」（设置 → 常规）且这一轮已经跑完时，整组收成一行
   「N 步工具调用 · 展开」；正在流式输出时永远不折，否则用户看不见 AI 在干嘛。
   只有一步不成组 —— 收成一行反而更难看。 */
const foldOpen = reactive({});
const stepGroup = computed(() => {
  const map = new Map();
  const tl = timeline.value || [];
  let start = -1;
  for (let i = 0; i <= tl.length; i++) {
    const isStep = i < tl.length && tl[i].kind === 'step' && !tl[i].hide && tl[i].type !== 'compress';
    if (isStep) { if (start < 0) start = i; continue; }
    if (start >= 0) {
      for (let j = start; j < i; j++) map.set(j, { start, len: i - start });
      start = -1;
    }
  }
  return map;
});
function foldedGroup(i) {
  const g = stepGroup.value.get(i);
  if (!g || g.len < 2 || !prefs.toolCollapse || props.busy) return null;
  return foldOpen[g.start] ? null : g;
}
function isFoldHead(i) {
  const g = foldedGroup(i);
  return g && g.start === i ? g : null;
}
function stepsHidden(i) {
  const g = foldedGroup(i);
  return !!g && g.start !== i;
}
function unfoldGroup(i) {
  const g = stepGroup.value.get(i);
  if (g) foldOpen[g.start] = true;
}

function isEdit(s) {
  const n = s.name || '';
  return n === 'write_file' || n === 'edit_file' || !!s.diff;
}

/** 卡片动词：对齐参考图「已编辑 / 已创建 / 已删除」 */
function verbOf(s) {
  const n = s.name || '';
  if (n === 'write_file') return s.new_file ? '已创建' : '已重写';
  if (n === 'edit_file') return '已编辑';
  if (n === 'delete_file') return '已删除';
  if (n === 'delete_dir') return '已删除目录';
  if (n === 'create_dir') return '已建目录';
  if (n === 'rename_file') return '已改名';
  return n || '已改动';
}

function pathOf(s) {
  return s.path || s.args?.path || s.args?.new_path || '';
}

function lineCount(t) {
  return String(t || '').split('\n').length;
}
function isLongText(t) {
  const s = String(t || '');
  if (s.split('\n').length > 8) return true;
  return s.length > 1400;
}

function normDiffLine(l) {
  if (typeof l === 'string') {
    if (l.startsWith('+++') || l.startsWith('---')) return { kind: 'meta', mark: ' ', text: l };
    if (l.startsWith('+')) return { kind: 'add', mark: '+', text: l.slice(1) };
    if (l.startsWith('-')) return { kind: 'del', mark: '-', text: l.slice(1) };
    return { kind: 'ctx', mark: ' ', text: l };
  }
  if (l && typeof l === 'object') {
    const text = String(l.text ?? l.line ?? '');
    // 服务端 diff 行是 {t:'add'|'del'|'ctx', text, new, old}；也兼容 {kind}/{type} 两种写法
    const k = String(l.t || l.kind || l.type || '').toLowerCase();
    if (k === 'add' || k === 'insert') return { kind: 'add', mark: '+', text };
    if (k === 'del' || k === 'delete' || k === 'remove') return { kind: 'del', mark: '-', text };
    if (l.mark === '+') return { kind: 'add', mark: '+', text };
    if (l.mark === '-') return { kind: 'del', mark: '-', text };
    return { kind: k === 'meta' ? 'meta' : 'ctx', mark: ' ', text };
  }
  return { kind: 'ctx', mark: ' ', text: String(l ?? '') };
}

function countSign(s, sign) {
  return (s.diff || []).filter((l) => normDiffLine(l).mark === sign).length;
}
function toggleDiff(i) {
  openDiff[i] = !diffOpen(i);
}

async function copyBody() {
  await copyText(props.content || '');
}
async function copyText(t) {
  try {
    await navigator.clipboard.writeText(t);
    toast('已复制', 'success');
  } catch {
    toast('复制失败', 'error');
  }
}

function onMdClick(e) {
  const btn = e.target.closest?.('.md-copy');
  if (!btn) return;
  const pre = btn.closest('.md-code')?.querySelector('pre');
  copyText(pre?.innerText || '');
}

function guessLang(s) {
  return langFromPath(s?.path || s?.args?.path || s?.args?.new_path || '');
}

function diffLines(s) {
  const rows = (s.diff || []).map(normDiffLine);
  const lang = guessLang(s);
  const htmls = highlightToLines(rows.map((r) => r.text).join('\n'), lang);
  rows.forEach((r, idx) => {
    r.html = htmls[idx] || escapeHtml(r.text);
  });
  return rows;
}

function iconOf(s) {
  if (s.type === 'note') return 'fas fa-circle-info';
  if (s.type === 'compress') return s.phase === 'failed' ? 'fas fa-triangle-exclamation' : s.phase === 'start' ? 'fas fa-circle-notch fa-spin' : 'fas fa-compress';
  if (s.type === 'result') return s.error ? 'fas fa-circle-xmark' : 'fas fa-circle-check';
  return 'fas fa-wrench';
}

const fmtTok = (n) => (Number(n) >= 1000 ? `${(Number(n) / 1000).toFixed(1)}k` : String(Number(n) || 0));

/** 压缩卡的一行话：进行中 / 完成（前后对比）/ 跳过 / 失败（带原因） */
function compressLine(s) {
  const pct = s.percent != null ? `${s.percent}%` : '';
  if (s.phase === 'start') {
    const from = s.from ? `，窗口来自${s.from}` : '';
    return `上下文 ${fmtTok(s.used)}/${fmtTok(s.limit)} tok（${pct}${from}）已达 80% → 先压缩再回答`;
  }
  if (s.phase === 'done') {
    // 压完锚点作废、要等下一次上游回执才重新校准 → 这个「剩多少」在没锚点时只是正文口径，标清楚
    const uncal = s.after_basis && s.after_basis !== 'anchor' ? '（待下一轮校准）' : '';
    return `已压缩：归档 ${s.archived || 0} 条消息、摘要 ${s.chars || 0} 字，上下文 ${fmtTok(s.used)} → ${fmtTok(s.after)} tok${uncal}（窗口 ${fmtTok(s.limit)}）`;
  }
  if (s.phase === 'skipped') return `无需压缩：${s.message || '最近交互已保留'}`;
  return `压缩失败：${s.message || '未知错误'}（继续用原上下文回答）`;
}

function preview(s) {
  if (s.type === 'result') {
    let v = s.error || s.output;
    if (v == null) return s.path ? String(s.path) : '';
    if (typeof v !== 'string') {
      try {
        v = JSON.stringify(v, null, 2);
      } catch {
        v = String(v);
      }
    }
    return String(v);
  }
  if (s.type === 'tool') {
    try {
      return JSON.stringify(s.args ?? {}, null, 2).substring(0, 400);
    } catch {
      return '';
    }
  }
  return '';
}
</script>

<style scoped>
.msg {
  margin-bottom: 28px;
  padding-bottom: 8px;
  border-bottom: 1px dashed var(--border-soft);
  animation: msg-rise 0.2s var(--ease) both;
}
.msg:last-child { border-bottom: 0; }
.msg.role-user {
  padding-left: 12%;
}
.msg.role-assistant {
  padding-right: 4%;
}
.msg.role-user .who { color: var(--accent); }
.msg.role-assistant .who { color: var(--ok); }
/* 托管：监工与执行同屏。只靠标签配色 + 执行者略微缩进来表示从属，不加色条那种花活 */
.msg.spk-supervisor .who { color: var(--accent); }
.msg.spk-worker { margin-left: 18px; }
.msg.spk-worker .who { color: var(--text-3); }
.bubble-wrap {
  border-radius: 14px;
  padding: 10px 14px;
  background: transparent;
}
.msg.role-user .bubble-wrap {
  background: var(--bg-bubble);
  border: 1px solid var(--border);
}
.msg.role-assistant .bubble-wrap {
  background: var(--bg-panel);
  border: 1px solid var(--border-soft);
}
@keyframes msg-rise {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}
.meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--text-3);
  margin-bottom: 6px;
}
.who { color: var(--text-2); font-weight: 600; }
.dim { opacity: 0.85; }
.link-btn {
  margin-left: 4px;
  color: var(--text-3);
  font-size: 11px;
}
.link-btn:first-of-type { margin-left: auto; }
.link-btn:hover { color: var(--text-2); }
.user-body {
  background: var(--bg-bubble);
  border: 1px solid var(--border-soft);
  border-radius: 18px;
  padding: 12px 16px;
  white-space: pre-wrap;
  word-break: break-word;
}
/* @文件提及的芯片：点一下复制绝对路径，悬停 title 里先看解析结果 */
.at-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  margin: 0 2px;
  padding: 1px 8px 1px 6px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg-panel);
  color: var(--text);
  font-family: var(--mono);
  font-size: 0.92em;
  vertical-align: baseline;
  cursor: pointer;
}
.at-chip i { font-size: 10px; color: var(--text-3); }
.at-chip:hover { background: var(--bg-hover); border-color: var(--border-strong, var(--border)); }
.at-chip:hover i { color: var(--text-2); }
.body { word-break: break-word; }
/* 生成中：圆形光标贴在正文最后 */
.msg.busy .body.md::after,
.msg.busy .user-body::after {
  content: '';
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-left: 3px;
  border-radius: 50%;
  background: currentColor;
  vertical-align: middle;
  animation: caret-glow 1s ease-in-out infinite;
}
@keyframes caret-glow {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.15; }
}
@media (prefers-reduced-motion: reduce) {
  .msg.busy .body.md::after,
  .msg.busy .user-body::after { animation: none; }
}
.phase {
  margin-top: 4px;
  font-size: 11px;
  color: var(--text-3);
  display: flex;
  align-items: center;
  gap: 6px;
}
.caret-dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-left: 3px;
  border-radius: 50%;
  background: currentColor;
  vertical-align: 0.12em;
  animation: caret-blink 0.9s step-end infinite;
}
/* 紧随最后文字：不占独立行 */
.msg.busy .body.md:last-of-type::after,
.msg.busy .user-body::after {
  content: '';
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-left: 2px;
  border-radius: 50%;
  background: currentColor;
  vertical-align: 0.12em;
  animation: caret-glow 1s ease-in-out infinite;
}
@keyframes caret-glow {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.15; }
}
@media (prefers-reduced-motion: reduce) {
  .caret-dot { animation: none; }
}
.reason {
  margin-bottom: 8px;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  background: var(--bg-panel);
}
.reason summary {
  cursor: pointer;
  padding: 8px 10px;
  color: var(--text-3);
  font-size: 12px;
}
.reason pre {
  margin: 0;
  padding: 0 10px 10px;
  color: var(--text-2);
  font-family: var(--mono);
  font-size: 11px;
  white-space: pre-wrap;
}
.step {
  margin: 8px 0;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  background: var(--bg-panel);
  overflow: hidden;
}
/* 折叠成的一行：比正常步骤更轻，鼠标过去才提亮，看着就是「这里收着东西」 */
.step.fold {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  font-size: 12px;
  color: var(--text-3);
  border-style: dashed;
  background: transparent;
  cursor: pointer;
  transition: color 0.16s var(--ease), border-color 0.16s var(--ease), transform 0.16s var(--ease);
}
.step.fold:hover { color: var(--text); border-color: var(--border); transform: translateX(2px); }
.step.fold i { font-size: 11px; }
.step-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  font-size: 12px;
  color: var(--text-2);
  flex-wrap: wrap;
}
.step-head code { font-family: var(--mono); }
.path {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-3);
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.badge {
  font-size: 10px;
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  padding: 1px 6px;
  color: var(--text-3);
}
.plus { font-size: 11px; }
.minus { font-size: 11px; }
/* 编辑卡：动词 + 路径 + 增删计数分开放，避免「+5-1」挤成一团 */
.step.edit {
  border-color: var(--border);
  background: var(--bg-elev);
}
.step.err { border-color: var(--danger-line); }
.step-head.clickable { cursor: pointer; }
.step-head.clickable:hover { background: var(--state-layer); }
.verb { font-weight: 600; color: var(--text); }
.nums {
  display: inline-flex;
  gap: 6px;
  font-family: var(--mono);
  font-size: 11px;
}
.body-wrap { position: relative; }
.body.md.clamped {
  max-height: 168px;
  overflow: hidden;
  -webkit-mask-image: linear-gradient(180deg, #000 62%, transparent 100%);
  mask-image: linear-gradient(180deg, #000 62%, transparent 100%);
}
.link-btn.unfold {
  display: block;
  margin: 4px 0 0;
}
.step-note {
  padding: 0 10px 8px;
  color: var(--text-3);
  font-size: 12px;
}
/* 压缩上下文卡里的摘要原文：默认折起，点开才占地方 */
.cp-detail { margin-top: 4px; }
.cp-detail > summary { cursor: pointer; color: var(--text-3); }
.cp-detail > summary:hover { color: var(--text); }
.cp-summary {
  margin: 6px 0 0;
  max-height: 240px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}
.step-body-wrap { position: relative; }
.copy-code {
  position: absolute;
  top: 6px;
  right: 8px;
  color: var(--text-3);
  z-index: 1;
}
.copy-code:hover { color: var(--text); }
.step-body {
  margin: 0;
  padding: 0 10px 8px;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-3);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 180px;
  overflow: auto;
}
.diff {
  font-family: var(--mono);
  font-size: 11px;
  line-height: 1.45;
  max-height: 320px;
  overflow: auto;
  padding: 4px 0 8px;
}
.diff-line {
  padding: 0 10px;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--text-2);
}
.diff-line .gutter {
  display: inline-block;
  width: 16px;
  color: var(--text-3);
  user-select: none;
  font-weight: 700;
}
.diff-line.add {
  background: var(--diff-add-bg);
  color: var(--diff-add-fg);
}
.diff-line.add .gutter { color: var(--diff-add); }
.diff-line.del {
  background: var(--diff-del-bg);
  color: var(--diff-del-fg);
}
.diff-line.del .gutter { color: var(--diff-del); }
.diff-line.meta {
  color: var(--text-3);
  background: var(--bg-elev);
}
.diff-line .code { color: inherit; }
.diff-line.add .code [class^='hljs-'],
.diff-line.add .code [class*=' hljs-'] { color: var(--diff-add-fg); }
.diff-line.del .code [class^='hljs-'],
.diff-line.del .code [class*=' hljs-'] { color: var(--diff-del-fg); }
</style>
