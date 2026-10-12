<template>
  <div ref="rootEl" class="msg" :class="['role-' + role, spkClass, { busy }]">
    <div class="meta">
      <span class="who">{{ whoLabel }}</span>
      <span v-if="model_name" class="dim">{{ model_name }}</span>
      <span v-if="usage" class="dim">入 {{ usage.prompt_tokens || 0 }} · 出 {{ usage.completion_tokens || 0 }}</span>
      <button class="link-btn" type="button" @click="copyBody">复制</button>
      <button
        v-if="role === 'user' && canRetract"
        class="link-btn"
        type="button"
        title="删掉这条之后的消息，文件改动不动"
        @click="$emit('retract', { id: msgId, content, index })"
      >撤回</button>
      <button
        v-if="role === 'user' && canRetract"
        class="link-btn"
        type="button"
        title="消息一条不删，把这条之后改过的文件退回原样"
        @click="$emit('revert-from', { id: msgId })"
      >从此回退</button>
    </div>

    <!-- 时间线：工具 / 思考 / 正文交错 -->
    <template v-if="role !== 'user'">
      <!-- 长回合折叠的是**上面**那段：最近几段一直留在眼前，流式时这个数跟着长，不用手动往下翻 -->
      <button
        v-if="foldFrom > 0"
        class="link-btn fold-top"
        type="button"
        @click="roundOpen = true"
      ><i class="fas fa-angle-double-up"></i> 展开这一轮更早的 {{ foldFrom }} 段</button>
      <template v-for="(item, i) in timeline" :key="i">
        <!-- 折起来的那些根本不进 DOM：v-show 只是 display:none，节点照建、markdown 照跑一遍
             marked + DOMPurify + hljs（实测一轮 30 段渲染 30 次），「收起」不等于「没加载」。
             外面这层 template 带着下标 i 走，里面的 v-else-if 链仍然按整条时间线判，位置不会串。 -->
        <template v-if="!hiddenByFold(i)">
        <!-- 思考卡在流式期间也不再自动摊开：以前 :open 里挂着 busy，所以「思考默认展开」没勾也照样展开。
             折叠只是不显示，内容仍在收、仍入库、仍进上下文；卡片只留一个标题（跑的时候带转圈 +「思考中…」）。
             「思考中」只给**还在输出的那一段**：以前用的是整条消息级别的 busy，一轮里交错出的好几段思考
             全都显示「思考中…」，直到整个回合结束才一起变「思考过程」（他第七十四轮报的那条）。 -->
        <details v-if="item.kind === 'reason' && item.text" class="reason" :open="!!(item.open || prefs.reasonOpen)">
          <summary><i :class="reasonLive(i) ? 'fas fa-circle-notch fa-spin' : 'fas fa-brain'"></i> {{ reasonLive(i) ? '思考中…' : '思考过程' }}</summary>
          <pre>{{ item.text }}</pre>
        </details>

        <!-- 一整组工具调用折叠成的一行（点开才铺开，正文之前不打扰） -->
        <div
          v-else-if="isFoldHead(i)"
          class="step fold"
          role="button"
          tabindex="0"
          @click="toggleGroup(i)"
          @keydown.enter.prevent="toggleGroup(i)"
        >
          <i class="fas fa-screwdriver-wrench"></i>
          <span>{{ isFoldHead(i).len }} 步工具调用</span>
          <button class="link-btn" type="button" @click.stop="toggleGroup(i)">展开</button>
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
            <!-- 实际请求内容：命令原文 / 网址 / 短参数（结果卡已经从调用行并进了 args，见 timeline 那段配对） -->
            <code v-if="argsLine(item)" class="args" :title="argsLine(item)">{{ argsLine(item) }}</code>
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
              @click.stop="$emit('review', item.ref || item)"
            >{{ txt('chat.hist.review') }}</button>
            <!-- 子智能体那张卡：点它是为了看它到底跑了哪些步（第七十五轮他点名的缺口） -->
            <button
              v-if="item.subagentId"
              class="link-btn"
              type="button"
              @click.stop="$emit('open-subagent', item.subagentId)"
            >{{ txt('chat.agent.steps') }}</button>
            <!-- 展开之后要能收回去：以前那行「N 步工具调用」点开了就回不来，只能重进会话 -->
            <button
              v-if="isFoldTail(i)"
              class="link-btn"
              type="button"
              title="把这一组工具调用重新收起"
              @click.stop="toggleGroup(i)"
            >收起</button>
          </div>
          <div
            v-if="item.type === 'note'"
            class="step-note"
            :class="{ clickable: !!item.subagentId }"
            @click="item.subagentId ? $emit('open-subagent', item.subagentId) : null"
          >{{ item.message }}</div>
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
          <div v-else-if="item.kind === 'step' && (preview(item) || item.image_token)" class="step-body-wrap">
            <!-- 截图类工具：图直接显示在这条回执里（模型看到的和用户看到的是同一张）。
                 双击走内置查看器（缩放/拖拽看细节）；这里不再挂 <a> —— 图的地址是内存里的
                 30 分钟 token，开新标签页多半只会拿到一张过期的「图片已销毁」。 -->
            <div
              v-if="item.image_token"
              class="step-shot"
              :class="{ dead: deadShots[item.image_token] }"
              :role="deadShots[item.image_token] ? null : 'button'"
              :tabindex="deadShots[item.image_token] ? -1 : 0"
              :title="deadShots[item.image_token] ? '' : '双击放大查看（滚轮缩放、拖动平移、Esc 关闭）'"
              @dblclick="deadShots[item.image_token] || iv.openViewer({ url: `/api/ai/chat/image/${item.image_token}`, title: `${item.name || '截图'} · 双击缩放` })"
              @keydown.enter="deadShots[item.image_token] || iv.openViewer({ url: `/api/ai/chat/image/${item.image_token}`, title: item.name || '截图' })"
            >
              <!-- 图片地址是服务端内存里的 30 分钟 token：重启或超时之后 <img> 会拿到 404。
                   以前留一个破图图标 + 「截图」两个字，看着像「AI 截了张打不开的图」；
                   现在直接说明这张已被清理（他要的口径），也不再让它可点/可双击。 -->
              <img
                v-if="!deadShots[item.image_token]"
                :src="`/api/ai/chat/image/${item.image_token}`"
                alt=""
                loading="lazy"
                @error="deadShots[item.image_token] = true"
              />
              <span v-else class="shot-dead">图片已被清理</span>
            </div>
            <button v-if="preview(item)" class="copy-code" type="button" title="复制" @click.stop="copyText(preview(item))">
              <i class="fas fa-copy"></i>
            </button>
            <pre v-if="preview(item)" class="step-body"><code class="hl" v-html="highlightCode(preview(item), guessLang(item))"></code></pre>
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
            v-html="caret(renderMarkdownCached(item.text), busy && i === lastTextIdx)"
          ></div>
          <button
            v-if="prefs.longCollapse && isLongText(item.text)"
            class="link-btn unfold"
            type="button"
            @click="textOpen[i] = !textOpen[i]"
          >{{ textOpen[i] ? '收起' : `展开回复（${lineCount(item.text)} 行）` }}</button>
        </div>
        </template>
        <div v-if="busy && i === timeline.length - 1" class="phase">
          <i class="fas fa-circle-notch fa-spin"></i> {{ phaseLabel }}
        </div>
      </template>
      <div v-if="!timeline.length" class="body md" v-html="renderMarkdownCached(content)"></div>
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
import { computed, reactive, ref, watch, nextTick, onMounted } from 'vue';
import { highlightCode, langFromPath } from '../../utils/format';
import { diffView, normDiffLine } from '../../utils/diffview';
import { txt } from '../../copy';
import { renderMarkdownCached } from '../../utils/mdcache';
import { withCaret } from '../../utils/caret';
import { renderMermaid } from '../../utils/mermaid';
import { renderMath } from '../../utils/math';
import { toast } from '../../stores/toast';
import { uiPrefs } from '../../stores/prefs';
import { imageViewer as iv } from '../../stores/viewer';

const prefs = uiPrefs.state;

const phaseLabel = computed(() => {
  const last = (props.steps || []).slice(-1)[0];
  if (last && last.type === 'tool') {
    return last.name === 'write_file' || last.name === 'edit_file' ? '~ Editing…' : '~ Working…';
  }
  return '~ Thinking…';
});

/** 光标只有一个来源：utils/caret 那一份，插到最后一个实义字符之后（详见该文件注释） */
function caret(html, on) {
  return on ? withCaret(html) : html;
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
  /** 子智能体步骤弹窗那一路：每一步都摊开。那个窗口存在的意义就是「它到底做了什么」，
   *  把工具组折成一行「N 步工具调用」等于把这扇窗要答的问题又藏回去了。 */
  flat: { type: Boolean, default: false },
});

defineEmits(['undo', 'retract', 'revert-from', 'open-subagent']);

/* mermaid 出图的接线在 timeline 之后（见该 computed 下面）：签名要读它，写在它前面会在 setup 里踩 TDZ。 */

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
// 加载失败的截图 token（内存表 30 分钟就清，重启也清）：标出来换成一句人话，别留破图标
const deadShots = reactive({});

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
    // 关键：step 的展示字段从 ref（steps 里的活对象）取，撤销等状态变化才会即时回写。
    // 条目自己没带 ref 时退回它本身 —— 不然一条没有 ref 的 step 会被展成空对象（type 全丢，整条渲染不出来）
    items = props.timeline.map((item) =>
      item.kind === 'step' ? { kind: 'step', ...(item.ref || item), ref: item.ref || item } : item
    );
  } else {
    // 重进会话这一路：库里只有 content / reasoning / steps 三份，顺序全靠 steps 里
    // type:'text' 的那几条（第五十五轮 #241 起才存）。老消息没有这些条目，仍退回
    // 「工具卡在前、整段正文在尾」的旧摆法。
    const out = [];
    if (props.reasoning && String(props.reasoning).trim()) {
      out.push({ kind: 'reason', text: String(props.reasoning) });
    }
    let hasSeg = false;
    for (const s of props.steps || []) {
      if (s && s.type === 'text') {
        hasSeg = true;
        if (s.text) out.push({ kind: 'text', text: String(s.text) });
        continue;
      }
      out.push({ kind: 'step', ...s, ref: s });
    }
    if (!hasSeg && props.content) out.push({ kind: 'text', text: props.content });
    items = out;
  }
  // 工具调用行与它的结果行成对出现时，只留结果行（编辑卡一张就够）——
  // 但**调用参数不能跟着一起消失**：run_command 的卡片以前只剩「run_command + 输出」，
  // 命令原文（ls）压根没地方看，刷新后也一样（他第七十四轮报的那条）。这里把 args 并进结果卡。
  for (let i = 0; i < items.length; i++) {
    const cur = items[i];
    const next = items[i + 1];
    if (
      cur.kind === 'step' && cur.type === 'tool' &&
      next?.kind === 'step' && next.type === 'result' && next.name === cur.name
    ) {
      if (next.args == null) next.args = cur.args;
      items[i] = { ...cur, hide: true };
    }
  }
  return items;
});

/**
 * 该给哪一段正文挂光标：**时间线里最后一条「正文」**，不是「最后一个条目」。
 * 差别的形状就是他天天看的那个：Agent 说完一段话去调工具，条目尾部变成工具卡 ——
 * 按「最后一个条目」判，整段工具执行期间一个光标都没有（他报的「圆形光标没了」），
 * 而那段时间里屏幕上最后一个他看得懂的字，正是上面那段正文的末尾。
 * 一条正文都还没有（只在思考 / 上来就调工具）时不放光标，由那行 `.phase` 表示在跑。
 */
const lastTextIdx = computed(() => {
  for (let i = timeline.value.length - 1; i >= 0; i--) {
    const it = timeline.value[i];
    if (it.kind === 'text' && it.text) return i;
  }
  return -1;
});

/**
 * 「这一段思考还在输出吗」。
 * busy 是整条消息级别的（这条会话有流在跑），一轮里可以交错出好几段思考，
 * 所以还得问一句：它是时间线尾部那一段吗？后面一旦落了工具卡或正文，这段就已经过去了。
 * note（限流/重试那类过程提示）不算交棒 —— 与 chatStore 里 tailReason 同一套走法。
 *
 * 还有一个必要条件：只有**正在流式输出**的那条消息才带 timeline（chatStore 实时往里 push，
 * 落库后重进会话走的是 content / reasoning / steps 那份重建路径，timeline 是 null）。
 * 不问这一句会漏两种真的错：重建出来的那段思考天然坐在时间线尾部（后面没有 type:'text' 的
 * 正文条目，整段正文只在老消息没分段时才补在末尾），于是历史消息被标成「思考中…」一直转圈；
 * 切回正在生成的会话时那一瞬也是这条路（openChat 先从库里重建，timeline 还没长出来）。
 */
function reasonLive(i) {
  if (!props.busy) return false;
  if (!Array.isArray(props.timeline) || !props.timeline.length) return false;
  const tl = timeline.value || [];
  for (let k = tl.length - 1; k >= 0; k--) {
    const it = tl[k];
    if (it.kind === 'reason' && it.text) return k === i;
    if (it.kind === 'text' && String(it.text || '').trim()) return false;
    if (it.kind === 'step' && it.type !== 'note' && !it.hide) return false;
  }
  return false;
}

/**
 * 卡片上那行「实际请求内容」。命令/网址类给原文（那就是他要看的 ls），
 * 其余把短参数摊成 k=v；正文、diff、路径这类已经有自己的位置（编辑卡/路径位），不在这儿重复。
 */
const ARGS_QUIET_KEYS = new Set(['path', 'new_path', 'content', 'text', 'diff', 'old_string', 'new_string', 'questions', 'options']);
function argsLine(item) {
  const a = item && item.args;
  if (!a || typeof a !== 'object') return '';
  if (typeof a.command === 'string' && a.command) return a.command;
  if (typeof a.url === 'string' && a.url) return a.url;
  if (typeof a.query === 'string' && a.query) return a.query;
  const kv = Object.entries(a)
    .filter(([k, v]) => !ARGS_QUIET_KEYS.has(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'))
    .map(([k, v]) => `${k}=${v}`);
  return kv.join('  ');
}

/* mermaid 出图：markdown 那边只留了带源码的容器，图要等 DOM 挂上再补。
   签名用「正文 + 各段时间线文本的长度」，流式增长时自然触发；同一容器由 utils/mermaid 内部去过重，
   重复调用不会重画。库本身按需 import，消息里没图就一个字节都不加载。
   必须放在 timeline 后面：watch 的 getter 在 setup 里就会跑一次，早于 computed 声明会踩 TDZ ——
   那不是我改出来的理论问题，是 client/__tests__/formula-render.test.js 抓到的真 bug
   （症状是每条消息都渲染成空白）。 */
const rootEl = ref(null);
const mermaidSig = computed(() => {
  const parts = [String(props.content || '').length];
  for (const it of (timeline.value || [])) if (it && typeof it.text === 'string') parts.push(it.text.length);
  return parts.join('-');
});
function drawMermaid() { nextTick(() => { if (rootEl.value) { renderMath(rootEl.value); renderMermaid(rootEl.value); } }); }
onMounted(drawMermaid);
watch(mermaidSig, drawMermaid);

/* 长回合向上折叠（#231 三条里的第二条）：一轮里段落一多，就把**上面**那些折起来，只留最近 ROUND_KEEP 段。
   流式时 foldFrom 跟着数组长度往前推，所以「最新那一段永远在眼前」，不必手动下翻；
   方向特意选向上而不是向下 —— 向下折会把刚吐出来的结论藏掉（原来长回复的 clamped 就是折下面，只适合单段正文）。
   隐藏用 v-if 而不是切数组：时间线的下标被审阅/折叠组/光标到处用着，切一刀就会串位。
   已知遮蔽（他这轮说先不修）：整组落在 foldFrom 之上时连组头也不渲染，于是看不出「工具调用自动折叠」勾选的差别。 */
const ROUND_KEEP = 14;
const roundOpen = ref(false);
const foldFrom = computed(() => (roundOpen.value ? 0 : Math.max(0, timeline.value.length - ROUND_KEEP)));
const hiddenByFold = (i) => {
  if (props.flat || roundOpen.value || i >= foldFrom.value) return false;
  // 折叠组跨过界线时不能只藏头：藏了头、成员又因为「在组里」不渲染，整组就凭空消失了
  // 判的是组**实际占到的那一段**（end），不是可见步数 len —— 中间夹了思考段时两者不等长
  const g = foldedGroup(i);
  if (g && g.end + 1 > foldFrom.value) return false;
  return true;
};

/* ── 连续的工具调用归成一组 ────────────────────────────────────────────
   开了「工具调用自动折叠」（设置 → 常规）且这一轮已经跑完时，整组收成一行
   「N 步工具调用 · 展开」；正在流式输出时永远不折（他这轮拍的：流式不折，只折历史），
   否则用户看不见 AI 在干嘛。只有一步不成组 —— 收成一行反而更难看。 */
const foldOpen = reactive({});
/* 只有真的工具调用才算「一步」。note（429 限流重试、越界说明、注入提示这些过程消息）、
   question、insert、compress 都不是模型在动手 —— 以前只排了 compress，
   结果两条连排的 note 就能自成一组「N 步工具调用」，把步数虚报出来。 */
const isToolStep = (it) => !!it && it.kind === 'step' && !it.hide && (it.type === 'tool' || it.type === 'result');
/* 调用行与结果行成对时调用行被 hide 掉了（上面那个配对循环），但它仍在数组里占位：
   连排判断必须把它算进同一段，否则 [调用,结果,调用,结果] 这种最常见的形状会被拆成一堆长度 1 的段，
   「N 步工具调用」这个折叠永远出不来。步数只数可见的那几张卡（一次调用一张结果）。 */
const isGluedToolLine = (it) => !!it && it.kind === 'step' && it.hide;
/**
 * 「不打断组」的条目：思考段与 note。
 * 这一条才是他报「勾选看不出区别」的主因：流式时 chatStore 每换一次产物就 push 一条新 reason
 * （见 chatStore 的 tailReason 走法），于是时间线长这样 —— 思考, 调用, 结果, 思考, 调用, 结果…
 * 按「必须严格连排」判组，每一段都只有 1 步，`len < 2` 永远不成立；
 * 而重进会话那条路是从 steps 重建的（思考不插在中间），组反倒成立。
 * 结果就是「刚跑完那会儿不折，重开这个会话才折」，看着像这个勾没接线。
 * 它们只是不把组切断，自己照常显示，也不算进步数。
 */
const isGroupGapLine = (it) => !!it && (it.kind === 'reason' || (it.kind === 'step' && it.type === 'note'));
const stepGroup = computed(() => {
  const map = new Map();
  const tl = timeline.value || [];
  let members = [];
  let count = 0;
  const flush = () => {
    if (count > 0) {
      // tail = 组里最后一张**看得见**的卡：「收起」那颗键挂它身上（挂隐藏行上就点不着）
      const tail = members.filter((j) => isToolStep(tl[j])).pop();
      for (const j of members) map.set(j, { start: members[0], end: members[members.length - 1], len: count, tail });
    }
    members = [];
    count = 0;
  };
  for (let i = 0; i < tl.length; i++) {
    const it = tl[i];
    if (isToolStep(it) || isGluedToolLine(it)) {
      members.push(i);
      if (isToolStep(it)) count += 1;
      continue;
    }
    if (isGroupGapLine(it)) continue;
    flush();
  }
  flush();
  return map;
});
function foldedGroup(i) {
  const g = stepGroup.value.get(i);
  if (!g || g.len < 2 || props.flat || !prefs.toolCollapse || props.busy) return null;
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
/** 展开状态下组尾那张卡上的「收起」键（收回去就又是那一行「N 步工具调用」） */
function isFoldTail(i) {
  const g = stepGroup.value.get(i);
  if (!g || g.len < 2 || props.flat || !prefs.toolCollapse || props.busy) return null;
  return foldOpen[g.start] && g.tail === i ? g : null;
}
function toggleGroup(i) {
  const g = stepGroup.value.get(i);
  if (!g) return;
  if (foldOpen[g.start]) delete foldOpen[g.start];
  else foldOpen[g.start] = true;
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

/* diff 行的形状归一与整段高亮搬到 utils/diffview —— 侧栏「审阅」弹窗要用同一份规则，
   两边各写一套时改一处漏一处（同一份改动在卡里是绿的、到弹窗里就没色了）。 */
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

/** diff 一列的高亮与形状归一在 utils/diffview（侧栏「审阅」弹窗用的是同一份） */
function diffLines(s) {
  return diffView(s.diff, guessLang(s));
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
    const src = s.from ? `，窗口来自${s.from}` : '';
    // 手动压缩没有「80% 这条线」，写成已达 80% 就是假话；自动压缩才用下面那句。
    if (s.manual) return txt('chat.msg.compressManual', { used: fmtTok(s.used), limit: fmtTok(s.limit), pct, src });
    // 阈值由后端随卡片带过来（改了设置也不说假话）。缺字段就不报数 ——
    // 以前在这里兜一个 80，于是把设置改成 60 之后流式期间仍显示「已达 80%」（刷新才变对）。
    if (!s.threshold) return txt('chat.msg.compressAutoNoThr', { used: fmtTok(s.used), limit: fmtTok(s.limit), pct, src });
    return txt('chat.msg.compressAuto', {
      used: fmtTok(s.used), limit: fmtTok(s.limit), pct, src,
      thr: s.threshold,
    });
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
/* 生成中的那枚小圆点**只有一个来源**：withCaret() 往「本轮最后一个条目」的正文里插的 .caret-dot。
   这里原来还有一条纯 CSS 的 `.msg.busy .body.md::after` —— 它给 busy 消息里**每一条**正文都补一个
   闪烁点（第二条规则才带 :last-of-type，第一条不带），于是「说完一段话去调工具」时，
   上面那段正文尾巴还挂着一个点、末尾又点一个，看着就是两根光标一起闪（他报的那条）。 */
.phase {
  margin-top: 4px;
  font-size: 11px;
  color: var(--text-3);
  display: flex;
  align-items: center;
  gap: 6px;
}
/* 光标的样式和闪烁曲线在 styles/tokens.css（全局）。别挪回这里：
   .caret-dot 是 v-html 注进正文的节点，作用域样式给它编出的选择器带 [data-v-xxx]，永远匹配不上，
   结果是「HTML 里有点、屏幕上没有」—— 第七十七轮「圆形光标没了」的第二层原因。 */
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
/* 截图类工具回执里的图：限高显示，点开看原图（整页截图可能几千像素高） */
.step-shot {
  display: block;
  margin: 0 0 8px;
  max-width: 300px;
  line-height: 0;
}
.step-shot img {
  display: block;
  max-width: 100%;
  max-height: 220px;
  object-fit: contain;
  border: 1px solid var(--border);
  border-radius: var(--radius-xs);
  background: var(--bg-sunken);
}
/* 图已经不在内存里：给一句说明，不再给破图标，也不再响应双击 */
.step-shot.dead {
  line-height: 1.5;
  cursor: default;
}
.shot-dead {
  display: inline-block;
  padding: 8px 10px;
  border: 1px dashed var(--border);
  border-radius: var(--radius-xs);
  background: var(--bg-sunken);
  color: var(--text-3);
  font-size: 11px;
}
.shot-dead i { margin-right: 6px; }
.path {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-3);
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 工具卡那行「实际请求内容」：命令能很长，所以给到 460px 再省略，全文在 title 里 */
.step-head .args {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-2);
  background: var(--state-layer);
  border-radius: var(--radius-xs);
  padding: 1px 6px;
  max-width: 460px;
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
/* 长回合向上折叠的那颗按钮：居中、上面一道虚线，一眼看出「这以上是收起来的」 */
.link-btn.fold-top {
  display: block;
  margin: 0 auto 10px;
  padding: 3px 10px;
  border: 1px dashed var(--border-soft);
  border-radius: 999px;
  font-size: 11px;
}
.link-btn.fold-top i { margin-right: 5px; }
.step-note {
  padding: 0 10px 8px;
  color: var(--text-3);
  font-size: 12px;
}
/* 子智能体那张卡：整行都是入口（他说「点击 subagent 的 card」要看步骤），别只留那颗小键 */
.step-note.clickable { cursor: pointer; }
.step-note.clickable:hover { color: var(--text-2); text-decoration: underline; text-underline-offset: 3px; }
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
