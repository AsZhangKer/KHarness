<template>
  <div class="composer">
    <Transition name="pop">
      <div v-if="apHead" class="approval" :class="apHead.level">
        <div class="ap-head">
          <strong>{{ apHead.level === 'red' ? '危险操作审批' : '越界访问审批' }}</strong>
          <code>{{ apHead.tool }}</code>
          <span class="ap-timer" :class="{ warn: apLeft <= 30 }">剩余 {{ apLeft }}s</span>
          <span v-if="approvals.length > 1" class="ap-queue">还有 {{ approvals.length - 1 }} 条待处理</span>
        </div>
        <div class="ap-reason">{{ apHead.reason }}</div>
        <pre v-if="!apHead.preview" class="ap-args">{{ pretty(apHead.args) }}</pre>
        <div class="ap-actions">
          <button class="k-btn sm danger" type="button" @click="$emit('approve', false)">拒绝</button>
          <button
            v-if="apHead.target"
            class="k-btn sm"
            type="button"
            title="之后同一目标不再询问"
            @click="$emit('approve', 'always')"
          >始终允许</button>
          <button
            v-if="apHead.preview"
            class="k-btn sm"
            type="button"
            title="批准之前先看清它到底要改什么"
            @click="apOpen = !apOpen"
          >{{ apOpen ? '收起审阅' : '审阅' }}</button>
          <button class="k-btn sm primary" type="button" @click="$emit('approve', true)">批准</button>
        </div>

        <!-- 审阅：参数这时已经生成完整，服务端顺手算好了真 diff / 命令原文，
             让用户心中有数再决定，而不是靠一句 reason 猜。 -->
        <div v-if="apOpen && apHead.preview" class="ap-preview">
          <div class="ap-sum">
            <code class="ap-path">{{ apHead.preview.path || apHead.preview.from || apHead.preview.cwd || apHead.preview.tool || '' }}</code>
            <span v-if="apHead.preview.isNew" class="ap-tag">新建文件</span>
            <span v-if="apHead.preview.added != null" class="ap-plus">+{{ apHead.preview.added }}</span>
            <span v-if="apHead.preview.removed != null" class="ap-minus">-{{ apHead.preview.removed }}</span>
          </div>
          <p v-if="apHead.preview.note" class="ap-warn">{{ apHead.preview.note }}</p>

          <div v-if="apHead.preview.kind === 'diff'" class="ap-diff">
            <div
              v-for="(row, i) in apHead.preview.diff"
              :key="i"
              class="ap-line"
              :class="row.kind"
            ><span class="ap-ln">{{ row.line || '' }}</span><span class="ap-tx">{{ row.kind === 'add' ? '+ ' : row.kind === 'del' ? '- ' : '  ' }}{{ row.text }}</span></div>
            <p v-if="apHead.preview.truncated" class="ap-warn">改动很长，这里只截了前 600 行；批准确认后仍会全部执行。</p>
            <details class="ap-raw">
              <summary>看原始参数</summary>
              <pre class="ap-args">{{ pretty(apHead.args) }}</pre>
            </details>
          </div>

          <template v-else-if="apHead.preview.kind === 'command'">
            <pre class="ap-cmd">{{ apHead.preview.command }}</pre>
            <p class="ap-warn">
              工作目录 {{ apHead.preview.cwd }} · Shell {{ apHead.preview.shell }}
              <template v-if="apHead.preview.paths && apHead.preview.paths.length">
                <br />命令里出现的路径：{{ apHead.preview.paths.join('、') }}
              </template>
            </p>
          </template>

          <p v-else-if="apHead.preview.kind === 'rename'" class="ap-warn">
            {{ apHead.preview.from }}
            <br />→ {{ apHead.preview.to }}
          </p>
        </div>
      </div>
    </Transition>

    <div v-if="queueLength" class="queue-strip">
      <i class="fas fa-layer-group"></i>
      队列中还有 {{ queueLength }} 条，回答结束会自动发送
      <button class="link-btn" type="button" @click="$emit('clear-queue')">清空队列</button>
    </div>

    <Transition name="pop">
      <div v-if="question" class="ask">
        <div class="ask-title">
          AI 提问
          <span v-if="askLeft != null" class="ap-timer" :class="{ warn: askLeft <= 30 }">剩余 {{ askLeft }}s</span>
        </div>
        <div class="ask-q">{{ question.question }}</div>
        <div class="ask-options">
          <button
            v-for="(opt, i) in question.options"
            :key="i"
            class="k-btn sm"
            type="button"
            @click="sendAsk(opt)"
          >{{ opt }}</button>
        </div>
        <input
          v-model="askText"
          class="ask-input"
          placeholder="自定义回答…"
          @keydown.enter.prevent="sendAsk(askText)"
        />
        <div class="ask-actions">
          <button class="k-btn sm ghost" type="button" @click="$emit('answer', { cancelled: true })">取消</button>
          <button class="k-btn sm primary" type="button" @click="sendAsk(askText)">提交</button>
        </div>
      </div>
    </Transition>

    <!-- 运行信息横条：常驻一行，没数据也写 0.0（以前一为空整条就消失，看着像功能坏了）。
         顺带显示当前模型的「提供商 / 模型真实 ID」—— 与下拉里那个展示名区分开，
         出问题时一眼能看出到底在调哪个上游、请求体里发的到底是哪个 model_id。 -->
    <div class="meta-bar">
      <span class="mb-item mb-model" :title="`展示名：${modelName || '—'}（下拉里显示的就是它）`">
        <i class="fas fa-plug"></i> {{ modelTag }}
      </span>
      <span class="mb-dot">·</span>
      <span class="mb-item" title="首个正文字节的延迟">首字 {{ firstTokenText }}</span>
      <span class="mb-dot">·</span>
      <span class="mb-item" title="跑动中是这两秒的瞬时速率，回合结束换成整轮平均">{{ tokPerSecText }} tok/s</span>
      <span class="mb-dot">·</span>
      <span class="mb-item" title="已用 / 窗口上限（以上游实测为锚点）">上下文 {{ ctxPct }}%（{{ ctxUsedText }} / {{ ctxLimitText }} tok）</span>
    </div>

    <div class="box">
      <!-- 上边缘的调高把手：平时不占地方，鼠标进了输入框才显出这条小横条 -->
      <div
        class="c-grip"
        :class="{ on: taDragging }"
        title="按住上下拖动可调输入框高度（双击回默认）"
        @mousedown.prevent="startTaGrip"
        @dblclick="resetTaHeight"
      ></div>
      <!-- / 命令提示 -->
      <Transition name="pop">
        <div v-if="cmdVisible" ref="cmdPopEl" class="cmd-pop" role="listbox">
          <div
            v-for="(c, i) in cmdMatches"
            :key="c.name"
            class="cmd-item"
            :class="{ on: i === cmdIdx }"
            role="option"
            :aria-selected="i === cmdIdx"
            @mousedown.prevent="pickCmd(c)"
            @mouseenter="cmdIdx = i"
          >
            <code class="cmd-name">/{{ c.name }}</code>
            <span class="cmd-desc">{{ c.desc }}</span>
          </div>
        </div>
      </Transition>

      <!-- @文件提及：逐层下钻列当前会话所在目录（本地列 fs，远程列 SFTP） -->
      <Transition name="pop">
        <div v-if="menVisible" ref="menPopEl" class="cmd-pop men-pop" role="listbox">
          <div class="men-dir">
            <i class="fas" :class="menRemote ? 'fa-server' : 'fa-hard-drive'"></i>
            <code :title="menShown">{{ menShown || '…' }}</code>
            <span class="men-tip">Tab或Enter 选中，Esc 收起</span>
          </div>
          <div
            v-for="(it, i) in menItems"
            :key="it.name + i"
            class="cmd-item men-item"
            :class="{ on: i === menIdx }"
            role="option"
            :aria-selected="i === menIdx"
            @mousedown.prevent="pickMention(it)"
            @mouseenter="menIdx = i"
          >
            <i class="fas men-ico" :class="it.skill ? 'fa-wand-magic-sparkles' : (it.dir ? 'fa-folder' : 'fa-file-lines')"></i>
            <code class="cmd-name">{{ it.name }}{{ it.dir ? '/' : '' }}</code>
            <span v-if="it.skill" class="men-tag">skill</span>
          </div>
          <div v-if="menLoading && !menItems.length" class="men-empty">读取目录中…</div>
          <div v-else-if="menErr" class="men-empty men-bad">{{ menErr }}</div>
          <div v-else-if="!menItems.length" class="men-empty">该层无匹配项（回上级用 @../）</div>
        </div>
      </Transition>

      <div v-if="attachments?.length" class="attach-row">
        <div v-for="(a, i) in attachments" :key="a.token || i" class="attach">
          <img
            v-if="a.isImage"
            :src="a.url"
            :alt="a.name"
            class="attach-img"
            title="双击放大查看"
            @dblclick="iv.openViewer({ url: a.url, title: a.name })"
          />
          <span v-else class="attach-file"><i class="fas fa-file"></i> {{ a.name }}</span>
          <button class="attach-x" type="button" @click="$emit('remove-attach', i)">×</button>
        </div>
      </div>
      <textarea
        ref="ta"
        v-model="draft"
        rows="3"
        :style="{ minHeight: taMin }"
        :placeholder="placeholder"
        @keydown="onKeydown"
        @input="onEdit"
        @click="syncMention"
        @paste="onPaste"
      ></textarea>
      <div ref="barEl" class="bar" :class="{ tight }">
        <button class="icon-btn" type="button" title="上传文件" @click="$emit('upload')">
          <i class="fas fa-plus"></i>
        </button>
        <button class="icon-btn" type="button" title="模型设置" @click="$emit('model-settings')">
          <i class="fas fa-sliders"></i>
        </button>
        <KDropdown
          :items="approvalItems"
          :model-value="approvalMode"
          :label="approvalShort"
          width="160px"
          :disabled="busy"
          :title="`审批：${approvalShort}（${approvalExplicit ? '本会话覆盖' : '跟随全局'}）`"
          @change="(v) => $emit('set-approval', v)"
        >
          <!-- 窄到放不下时（tight）只剩图标，文字靠 title 悬浮看 -->
          <template #trigger>
            <i class="fas fa-pen-nib"></i>
            <span v-if="!tight">{{ approvalShort }}</span>
          </template>
        </KDropdown>

        <KDropdown
          :items="thinkingItems"
          :model-value="thinkingSel"
          :label="thinkingLabel"
          width="180px"
          :disabled="busy"
          :title="`思考： ${thinkingShort}`"
          @change="(v) => $emit('set-thinking', v)"
        >
          <!-- 这一颗即使收窄也留着强度档位（去掉「思考 ·」前缀），用户要看的就是当前档 -->
          <template #trigger>
            <i class="fas fa-brain"></i>
            <span>{{ tight ? thinkingShort : thinkingLabel }}</span>
          </template>
        </KDropdown>

        <KDropdown
          v-if="gitEnabled"
          :items="gitItems"
          :model-value="''"
          label="Git"
          width="220px"
          :disabled="busy"
          :title="`分支： ${gitBranch || 'Git'}`"
          @change="(v) => $emit('git-action', v)"
        >
          <template #trigger>
            <i class="fas fa-code-branch"></i>
            <span v-if="!tight">{{ gitBranch || 'Git' }}</span>
          </template>
        </KDropdown>

        <div class="ctx-ring" :title="`上下文 ${ctxPct}%`" aria-label="上下文用量">
          <svg viewBox="0 0 36 36" class="ring">
            <circle class="ring-bg" cx="18" cy="18" r="15" />
            <circle class="ring-fg" cx="18" cy="18" r="15" :style="ringStyle" />
          </svg>
          <span class="ring-num">{{ ctxPct }}%</span>
        </div>

        <KDropdown
          :items="modelItems"
          :model-value="currentModelId"
          :label="modelName || '模型'"
          width="260px"
          :disabled="busy"
          :title="modelName || '模型'"
          @change="(v) => $emit('select-model', v)"
        >
          <template #trigger>
            <i v-if="busy" class="fas fa-circle-notch spin"></i>
            <span class="bar-txt">{{ modelName || '模型' }}</span>
          </template>
        </KDropdown>

        <button
          class="send"
          type="button"
          :disabled="!busy && !draft.trim()"
          :title="busy ? '停止' : '发送'"
          @click="busy ? $emit('stop') : submit()"
        >
          <i class="fas" :class="busy ? 'fa-stop' : 'fa-arrow-up'"></i>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import KDropdown from '../../ui/KDropdown.vue';
import { useBarOverflow, rowNeed } from '../../ui/useBarOverflow.js';
import { aiApi } from '../../api';
import { uiPrefs } from '../../stores/prefs';
import { imageViewer as iv } from '../../stores/viewer';

const props = defineProps({
  modelValue: { type: String, default: '' },
  busy: Boolean,
  attachments: { type: Array, default: () => [] },
  /** 当前会话的工作目录：@ 提及的相对路径按它解析（远程会话即远端目录） */
  cwd: { type: String, default: '' },
  /** 当前会话 id：后端靠它区分这条会话在本机还是在那台远端机器上 */
  chatId: { type: Number, default: null },
  modelName: { type: String, default: '' },
  models: { type: Array, default: () => [] },
  currentModelId: { type: Number, default: null },
  thinkingLevel: { type: String, default: '' },
  thinkingLevels: { type: Array, default: () => [] },
  gitBranch: { type: String, default: '' },
  gitBranches: { type: Array, default: () => [] },
  gitEnabled: { type: Boolean, default: false },
  approvalMode: { type: String, default: 'default' },
  /** 这条会话是否显式覆盖过审批模式（决定要不要给「跟随全局」出口，也写进 title 说明来源） */
  approvalExplicit: { type: Boolean, default: false },
  /** 可用技能列表（{name,title,description}）：@ 补全框里和文件一起列，选中即「本轮临时加载」 */
  skills: { type: Array, default: () => [] },
  /** 当前会话挂起的审批队列（队首即待处理） */
  approvals: { type: Array, default: () => [] },
  question: { type: Object, default: null },
  queueLength: { type: Number, default: 0 },
  contextUsed: { type: Number, default: 0 },
  contextLimit: { type: Number, default: 0 },
  /** 首个正文字节的延迟（ms）：圆环旁边那个时间显示的就是它（不是整轮耗时） */
  firstTokenMs: { type: Number, default: 0 },
  tokPerSec: { type: Number, default: 0 },
  placeholder: {
    type: String,
    default: '输入文本、上传文件描述任务，输入 / 使用指令，@引用文件',
  },
});

const emit = defineEmits([
  'update:modelValue',
  'send',
  'stop',
  'cycle-model',
  'cycle-approval',
  'select-model',
  'set-approval',
  'set-thinking',
  'approve',
  'answer',
  'upload',
  'model-settings',
  'git-action',
  'files',
  'remove-attach',
  'clear-queue',
]);

/**
 * 工具行（.bar）的窄屏降级：整行放不下时把文字收掉只剩图标（tight）。
 * 判定按「这一行实际需要多宽 vs 现在有多宽」实测，不用视口断点 ——
 * 模型名长短、有没有分支按钮都会改变需要的宽度，断点猜不准。见 ui/useBarOverflow.js。
 */
const barEl = ref(null);
const { compact: tight, remeasure: remeasureBar } = useBarOverflow(barEl, { need: (el) => rowNeed(el, 8) });
watch(
  () => [props.modelName, props.gitBranch, props.gitEnabled, props.thinkingLevel, props.approvalMode],
  remeasureBar,
);

function onPaste(e) {
  const files = [...(e.clipboardData?.items || [])]
    .filter((it) => it.kind === 'file')
    .map((it) => it.getAsFile())
    .filter(Boolean);
  if (files.length) {
    e.preventDefault();
    emit('files', files);
  }
}

const gitItems = computed(() => {
  const branchOpts = (props.gitBranches || []).map((b) => ({
    value: `checkout:${b}`,
    label: `分支： ${b}${b === props.gitBranch ? '（当前）' : ''}`,
  }));
  return [
    ...branchOpts.slice(0, 12),
    { value: 'commit', label: '提交' },
    { value: 'push', label: '推送' },
    { value: 'commit-push', label: '提交并推送' },
  ];
});

const approvalItems = computed(() => [
  { value: 'default', label: '默认审批' },
  { value: 'strict', label: '严格审批' },
  { value: 'exempt', label: '免除审批' },
  // 只有这条会话真被覆盖过才给出口，否则菜单里多一项没意义的「跟随全局」
  ...(props.approvalExplicit ? [{ value: 'follow', label: '跟随全局' }] : []),
]);

const thinkingItems = computed(() => {
  const fromModel = (props.thinkingLevels || []).map((lv) => String(lv).trim()).filter(Boolean);
  const base = ['auto', 'off', 'low', 'medium', 'high', 'xhigh', 'max'];
  // 每一项都必须带「真值」随请求发出去。之前第一项是空串、写着「medium（默认）」，
  // 但服务端把空串判成 default 档 = 一个思考参数都不发 → 界面显示 medium、实际根本没开思考。
  // 现在想跟随模型默认请选「自动」（值 auto，同样不发参数，但档位名实相符且能被会话记住）。
  const merged = [...new Set([...fromModel, ...base])];
  return merged.map((lv) => ({ value: lv, label: thinkName(lv) }));
});

/** 'auto'（含历史遗留空值）在界面上叫「自动」，其余档位按上游词表原样显示 */
function thinkName(v) {
  return !v || v === 'auto' ? '自动' : v;
}

const thinkingSel = computed(() => props.thinkingLevel || 'auto');

const thinkingLabel = computed(() => thinkName(props.thinkingLevel || 'auto'));

/** 收窄到只剩图标时也要看得见当前档位，所以只留强度本身（不带「思考 ·」前缀） */
const thinkingShort = computed(() => thinkName(props.thinkingLevel || 'auto'));

const modelItems = computed(() =>
  props.models.map((m) => ({
    value: m.id,
    label: m.display_name || m.model_id,
  }))
);

const apHead = computed(() => props.approvals[0] || null);

// 审批 180s 由服务端超时自动拒绝；这里只做倒计时显示
const apLeft = ref(180);
// 「审阅」面板是手动展开的，换一条审批就收回去（免得上一条的 diff 还挂在那）
const apOpen = ref(false);
watch(
  () => apHead.value?.id,
  (id) => { apLeft.value = id ? 180 : 0; apOpen.value = false; }
);

// ask_user 倒计时：时长由服务端随事件下发（默认 10 分钟）
const askLeft = ref(null);
watch(
  () => props.question?.id,
  (id) => {
    askLeft.value = id ? Math.max(1, Math.round((props.question.timeout_ms || 600000) / 1000)) : null;
  }
);

const ticker = setInterval(() => {
  if (apHead.value && apLeft.value > 0) apLeft.value -= 1;
  if (props.question && askLeft.value != null && askLeft.value > 0) askLeft.value -= 1;
}, 1000);
onUnmounted(() => clearInterval(ticker));

const ctxPct = computed(() => {
  if (!props.contextLimit) return 0;
  return Math.min(100, Math.round((props.contextUsed / props.contextLimit) * 100));
});

/* ---- 输入框上方那条信息横条（数字一律显示，没数据就是 0.0）---- */
const tokPerSecText = computed(() => (Number(props.tokPerSec) || 0).toFixed(1));
const firstTokenText = computed(() => ((Number(props.firstTokenMs) || 0) / 1000).toFixed(1) + 's');
const ctxUsedText = computed(() => Math.round(Number(props.contextUsed) || 0).toLocaleString('en-US'));
const ctxLimitText = computed(() => Math.round(Number(props.contextLimit) || 0).toLocaleString('en-US'));
/** 「提供商 / 模型真实 ID」：下拉里那个是展示名，这里给的是发请求时真正用的 model_id */
const modelTag = computed(() => {
  const m = (props.models || []).find((x) => x.id === props.currentModelId);
  if (!m) return props.modelName ? `${props.modelName}（未匹配到模型行）` : '未选模型';
  return `${m.provider_name || '未分组'} / ${m.model_id}`;
});

const ringStyle = computed(() => {
  const c = 2 * Math.PI * 15;
  const off = c * (1 - ctxPct.value / 100);
  return { strokeDasharray: `${c}`, strokeDashoffset: `${off}` };
});

const SLASH_COMMANDS = [
  { name: 'model', desc: '切换模型  /model <ID|名称>' },
  { name: 'pool', desc: '打开模型池' },
  { name: 'mode', desc: 'plan|auto|agent|readonly|strict|default|exempt' },
  { name: 'dir', desc: '切换工作目录  /dir <路径>' },
  { name: 'insert', desc: '预埋提示词  /insert <内容> 或 --clear' },
  { name: 'skills-load', desc: '勾选技能常驻本会话' },
  { name: 'supervise', desc: '监工网页自测（读 kh.checks.md）' },
  { name: 'press', desc: '压缩上下文' },
  { name: 'context', desc: '设定会话上下文长度  /context <token>' },
  { name: 'exit', desc: '退出 Agent 模式' },
  { name: 'help', desc: '显示命令帮助' },
];

/* /supervise 受实验室开关控制（监工已半废弃、默认关）：关着就不进补全列表。
   硬打进来由 chatStore 挡回并指路，不留「列表里看不到、敲进去撞后端 403」这种两不着陆。 */
const COMMANDS = computed(() =>
  SLASH_COMMANDS.filter((c) => c.name !== 'supervise' || uiPrefs.state.supervisorOn));

const ta = ref(null);
const cmdIdx = ref(0);
const cmdDismissed = ref(false);

const draft = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
});

watch(draft, () => {
  nextTick(sizeTa);
});

/* ---- 输入框自己调高：按住上边缘那条小横条往上拖（最多五倍初始值） ------------
   高度存服务端 settings（uiPrefs.composerHeight），不存 localStorage ——
   桌面端每次启动端口都可能变，origin 带端口，localStorage 跟着分家，等于每次回默认。
   0 = 没拖过，用样式里的初始值 56px。                                                        */
const TA_BASE = 56;
const TA_MAX = TA_BASE * 5;
const taDragging = ref(false);
const taMin = computed(() => `${uiPrefs.state.composerHeight || TA_BASE}px`);

/** 把 textarea 收/放到「不低于用户调过的高度」：内容多时仍按老规矩最多 84px 起自动长 */
function sizeTa() {
  const el = ta.value;
  if (!el) return;
  const base = uiPrefs.state.composerHeight || TA_BASE;
  el.style.height = 'auto';
  el.style.height = `${Math.max(base, Math.min(84, el.scrollHeight))}px`;
}

function startTaGrip(e) {
  const from = uiPrefs.state.composerHeight || TA_BASE;
  const startY = e.clientY;
  taDragging.value = true;
  // 拖的是 textarea 边上，不接管光标与选中的话，一路拖会变成一路选字
  document.body.style.cursor = 'ns-resize';
  document.body.style.userSelect = 'none';
  const move = (ev) => {
    uiPrefs.state.composerHeight = Math.min(TA_MAX, Math.max(TA_BASE, from + (startY - ev.clientY)));
    sizeTa();
  };
  const up = () => {
    taDragging.value = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    uiPrefs.save({ composerHeight: uiPrefs.state.composerHeight });
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

/** 双击把手：回到没调过时的默认高度 */
function resetTaHeight() {
  uiPrefs.state.composerHeight = 0;
  sizeTa();
  uiPrefs.save({ composerHeight: 0 });
}

// 服务端偏好回来的那一刻（启动后）也要按用户调过的高度重画一次
watch(() => uiPrefs.state.composerHeight, () => nextTick(sizeTa));

const approvalShort = computed(
  () => ({ strict: '严格', default: '审批', exempt: '免除' }[props.approvalMode] || '审批')
);

const cmdMatches = computed(() => {
  const s = draft.value;
  if (cmdDismissed.value) return [];
  if (!s.startsWith('/')) return [];
  const head = s.slice(1);
  // 已完成命令带参数时不再弹出
  if (head.includes(' ') && !head.endsWith(' ')) {
    const name = head.split(/\s+/)[0];
    if (COMMANDS.value.some((c) => c.name === name)) return [];
  }
  const q = head.trim().toLowerCase();
  return COMMANDS.value.filter((c) => !q || c.name.startsWith(q) || c.name.includes(q)).slice(0, 8);
});

const cmdVisible = computed(() => cmdMatches.value.length > 0);

// 补全之后不要把面板立刻弹回来（否则像「关不掉」）；用户再改文本才重新匹配
let pickedDraft = '';
watch(draft, (v) => {
  if (v === pickedDraft) return;
  pickedDraft = '';
  cmdIdx.value = 0;
  cmdDismissed.value = false;
});

function pickCmd(c) {
  const next = `/${c.name} `;
  pickedDraft = next;
  draft.value = next;
  cmdDismissed.value = true;
  ta.value?.focus();
}

const askText = ref('');

/**
 * @文件提及：在光标前找 @token，按「目录部分」列一层候选，前缀过滤在本地做
 * （缓存整个目录，边打边筛不再请求 —— 远端列目录要走 SFTP 往返，不能每敲一个字打一次）。
 * 只把 @路径 留在正文里，内容不进上下文：模型自己 read_file（远程会话即远端 read_file）。
 */
const menItems = ref([]);
const menIdx = ref(0);
const menOpen = ref(false);
const menLoading = ref(false);
const menShown = ref('');
const menRemote = ref(false);
const menCtx = ref(null);   // { start, end, dir, q }
const menErr = ref('');      // 越界被拒时的原文，直接显示在面板里
const dirCache = new Map(); // dir -> items（同一会话目录内不变；换会话/刷新时 clearMentionCache）
let menTimer = null;

/* ---- 上下键切换时让高亮项留在可视范围里 ----
   两个面板都是 max-height + overflow-y:auto，高亮循环到第 9 条时它已经在下面看不见了，
   原来一处 scrollIntoView 都没有（用户只能看见前几条在闪）。block:'nearest' 只在真出界时挪，
   且在面板内部滚，不会把整页带着走。 */
const cmdPopEl = ref(null);
const menPopEl = ref(null);
function keepActiveVisible(pop) {
  nextTick(() => {
    const on = pop.value && pop.value.querySelector('.cmd-item.on');
    if (on) on.scrollIntoView({ block: 'nearest' });
  });
}
watch(cmdIdx, () => keepActiveVisible(cmdPopEl));
watch(menIdx, () => keepActiveVisible(menPopEl));

function clearMentionCache() {
  dirCache.clear();
  menOpen.value = false;
  menCtx.value = null;
}

/** 光标前是不是一个 @token：@ 必须在行首或空白后，token 到下一个空白为止 */
function tokenAt(text, caret) {
  const before = text.slice(0, caret);
  const m = /(?:^|[\s(（[「])@([^\s@]*)$/.exec(before);
  if (!m) return null;
  const tok = m[1];
  return { start: caret - tok.length - 1, end: caret, tok };
}

function splitTok(tok) {
  const i = Math.max(tok.lastIndexOf('/'), tok.lastIndexOf('\\'));
  return { dir: tok.slice(0, i + 1), q: tok.slice(i + 1) };
}

/**
 * @ 后面还没打斜杠时把技能也列进来（技能名都是单段，和 @src/a.ts 这种路径天然不冲突）。
 * 技能排在文件前面、条目带 skill 标记 —— 同名冲突时的口径是「技能优先」，
 * 要引用同名文件就写带路径的那种写法（服务端 skillMentionsIn 认的也是「整段正好等于技能名」）。
 */
function mergeSkills(files, dir, q) {
  if (dir) return files;
  const qq = String(q || '').toLowerCase();
  const sk = (props.skills || [])
    .map((s) => String(s?.name || s?.title || '').trim())
    .filter((n) => n && n.toLowerCase().includes(qq))
    .slice(0, 12)
    .map((n) => ({ name: n, dir: false, skill: true }));
  return [...sk, ...files];
}

async function syncMention() {
  const el = ta.value;
  if (!el) return;
  const t = tokenAt(el.value || '', el.selectionStart ?? (el.value || '').length);
  if (!t) {
    menOpen.value = false;
    menCtx.value = null;
    return;
  }
  const { dir, q } = splitTok(t.tok);
  menCtx.value = { start: t.start, end: t.end, dir, q };
  menOpen.value = true;
  menIdx.value = 0;
  menErr.value = '';
  const key = `${props.chatId || 0}|${dir}`;
  const shown = dir || props.cwd || '.';
  menShown.value = shown;
  const hit = dirCache.get(key);
  if (hit) {
    menItems.value = mergeSkills(q ? hit.filter((it) => it.name.toLowerCase().includes(q.toLowerCase())) : hit, dir, q);
    return;
  }
  menLoading.value = true;
  try {
    const r = await aiApi.fsLs({ path: dir, chat_id: props.chatId || undefined, cwd: props.cwd || undefined, limit: 200 });
    const items = (r?.items || []).map((it) => ({ name: it.name, dir: !!it.dir }));
    dirCache.set(key, items);
    menRemote.value = !!r?.remote;
    menShown.value = r?.path || shown;
    const now = menCtx.value;
    // 请求回来时用户可能已经改了 token：只对还在打同一个目录的结果落地
    if (!now || `${props.chatId || 0}|${now.dir}` !== key) return;
    const qq = now.q.toLowerCase();
    menItems.value = mergeSkills(qq ? items.filter((it) => it.name.toLowerCase().includes(qq)) : items, now.dir, now.q);
  } catch (e) {
    // 越界（403）不能只回一句「该层无匹配项」—— 用户会以为自己打错了名字
    const msg = String(e?.response?.data?.message || e?.message || '');
    menErr.value = e?.response?.status === 403 || /只能浏览/.test(msg) ? msg : '';
    dirCache.set(key, []);
    menItems.value = [];
  } finally {
    menLoading.value = false;
  }
}

function pickMention(it) {
  const el = ta.value;
  const ctx = menCtx.value;
  if (!el || !ctx) return;
  // 技能是一条完整名字，选完就收起（不做「下钻」）；服务端按 @名字 整段匹配加载它
  if (it.skill) {
    const text = el.value || '';
    draft.value = text.slice(0, ctx.start) + '@' + it.name + ' ' + text.slice(ctx.end);
    const caret = ctx.start + 1 + it.name.length + 1;
    nextTick(() => {
      el.focus();
      try { el.setSelectionRange(caret, caret); } catch (e) { /* 不支持就算了 */ }
      menOpen.value = false;
    });
    return;
  }
  const name = it.name + (it.dir ? '/' : ' ');
  const text = el.value || '';
  const next = text.slice(0, ctx.start) + '@' + ctx.dir + name + text.slice(ctx.end);
  draft.value = next;
  const caret = ctx.start + 1 + ctx.dir.length + name.length;
  if (it.dir) dirCache.delete(`${props.chatId || 0}|${ctx.dir + it.name}/`);
  nextTick(() => {
    el.focus();
    try { el.setSelectionRange(caret, caret); } catch (e) { /* 不支持就算了 */ }
    if (it.dir) syncMention();
    else menOpen.value = false;   // 选完文件就收起；要继续 @ 再打一个 @ 会重新弹
  });
}

const menVisible = computed(() => menOpen.value);

/** 打字时防抖刷新候选（一次列目录就够，前缀过滤在本地做） */
function onEdit() {
  if (menTimer) clearTimeout(menTimer);
  menTimer = setTimeout(syncMention, 90);
}

// 换会话 / 换目录：缓存作废（同一目录名在两台机器上是两回事）
watch(() => [props.chatId, props.cwd], clearMentionCache);
onUnmounted(() => { if (menTimer) clearTimeout(menTimer); });

function onMentionKey(e) {
  // 正在打字（拼音合成中）不接管回车
  if (e.isComposing) return false;
  if (!menOpen.value || !menItems.value.length) {
    if (e.key === 'Escape' && menOpen.value) { menOpen.value = false; return true; }
    return false;
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    menIdx.value = (menIdx.value + 1) % menItems.value.length;
    return true;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    menIdx.value = (menIdx.value - 1 + menItems.value.length) % menItems.value.length;
    return true;
  }
  if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
    e.preventDefault();
    pickMention(menItems.value[menIdx.value]);
    return true;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    menOpen.value = false;
    return true;
  }
  return false;
}

function sendAsk(val) {
  const t = String(val ?? '').trim();
  if (!t) return;
  askText.value = '';
  emit('answer', { text: t });
}

function onKeydown(e) {
  // @ 文件提及优先：开着的时候 Enter/Tab 是「选中」，不是发送
  if (onMentionKey(e)) return;
  const bare = draft.value.trim().startsWith('/') && !/\s/.test(draft.value.trim());
  if (cmdVisible.value && bare) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      cmdIdx.value = (cmdIdx.value + 1) % cmdMatches.value.length;
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      cmdIdx.value = (cmdIdx.value - 1 + cmdMatches.value.length) % cmdMatches.value.length;
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      pickCmd(cmdMatches.value[cmdIdx.value]);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      cmdDismissed.value = true;
      return;
    }
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submit();
  }
}

function pretty(obj) {
  try {
    return JSON.stringify(obj ?? {}, null, 2).substring(0, 600);
  } catch {
    return '';
  }
}

function submit() {
  // 生成中同样接受：store 会把这条放进队列，答完自动发送
  if (!draft.value.trim()) return;
  emit('send');
}

function focus() {
  ta.value?.focus();
}

defineExpose({ focus });
</script>

<style scoped>
.composer { padding: 10px 22px 20px; }
/* 队列横幅：回答中追加的消息会排队，这里让它可见可清 */
.queue-strip {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 8px;
  padding: 6px 10px;
  font-size: 12px;
  color: var(--text-2);
  background: var(--bg-panel);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
}
.queue-strip i { color: var(--text-3); }
.queue-strip .link-btn { margin-left: auto; }
.ap-queue {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-3);
}
.box {
  position: relative;
  max-width: var(--msg-w, 860px);
  margin: 0 auto;
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: 18px;
  padding: 14px 14px 10px;
  box-shadow: var(--shadow-soft);
  transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}
.box:focus-within { border-color: var(--border-strong); }
/* 上边缘的调高把手：只有那条小横条可见，热区比它高一点，好按 */
.c-grip {
  position: absolute;
  top: -5px;
  left: 50%;
  transform: translateX(-50%);
  width: 132px;
  height: 12px;
  z-index: 6;
  cursor: ns-resize;
  opacity: 0;
  transition: opacity var(--dur) var(--ease);
}
.c-grip::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 5px;
  height: 3px;
  border-radius: 999px;
  background: var(--border-strong);
  transition: background var(--dur) var(--ease);
}
.box:hover .c-grip, .c-grip:hover, .c-grip.on { opacity: 1; }
.c-grip:hover::before, .c-grip.on::before { background: var(--accent); }

/* 弹层外观统一由 tokens.css 的 .cmd-pop / .cmd-item 提供，这里只定位与排布 */
.cmd-pop {
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(100% + 8px);
  width: 100%;
  z-index: 20;
  max-height: 280px;
  overflow-y: auto;
}
.cmd-item {
  gap: 12px;
  padding: 9px 12px;
  cursor: pointer;
}
.cmd-name {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--text);
  min-width: 96px;
}
.cmd-desc {
  font-size: 12px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* @文件提及的候选面板：沿用 .cmd-pop 的壳，多一行「在列哪个目录」 */
.men-pop { gap: 1px; }
.men-dir {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 7px 12px 6px;
  margin-bottom: 2px;
  font-size: 11px;
  color: var(--text-3);
  border-bottom: 1px solid var(--border-soft);
}
.men-dir code {
  font-family: var(--mono);
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.men-tip { margin-left: auto; flex: 0 0 auto; }
/* @ 补全框里的技能角标：和文件条目一眼分得开（选中谁插谁，同名时技能优先） */
.men-tag {
  margin-left: auto;
  flex: 0 0 auto;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--bg-elev);
  border: 1px solid var(--border-soft);
  color: var(--text-3);
}
.men-ico { width: 14px; text-align: center; color: var(--text-3); }
.men-item .cmd-name { flex: 1; min-width: 0; }
.men-empty { padding: 9px 12px; font-size: 11px; color: var(--text-3); }
/* 越界被拒：要说人话并且是警告色，不能混在「该层无匹配项」的灰字里 */
.men-bad { color: var(--warn); }

textarea {
  width: 100%;
  border: 0;
  resize: none;
  background: transparent;
  outline: none;
  min-height: 56px;
  max-height: 84px;
  overflow-y: auto;
  padding: 0 4px 8px;
}
textarea::placeholder { color: var(--text-3); }
.bar {
  display: flex;
  align-items: center;
  gap: 8px;
  /* 窄屏靠实测降级（tight），不靠换行：一换行整行高度就跳 */
  flex-wrap: nowrap;
}
.bar > * {
  /* 子项不许被压扁，否则 scrollWidth 量不出「真需要多宽」 */
  flex: 0 0 auto;
  min-width: 0;
}
.bar .k-dropdown {
  min-width: 0;
}
.bar-txt {
  display: inline-block;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
}
.bar.tight .bar-txt {
  max-width: 110px;
}
.attach-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
}
.attach {
  position: relative;
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  background: var(--bg-elev);
}
.attach-img {
  display: block;
  width: 72px;
  height: 72px;
  object-fit: cover;
}
.attach-file {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px;
  font-size: 11px;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.attach-x {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--scrim);
  color: var(--on-scrim);
  font-size: 12px;
  line-height: 1;
}
.icon-btn {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text-2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}
.icon-btn:hover { background: var(--bg-hover); color: var(--text); }
.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text-2);
  border-radius: var(--radius-pill);
  font-size: 12px;
}
.pill:hover { color: var(--text); background: var(--bg-hover); }
.pill .caret { font-size: 9px; opacity: 0.7; }
.ctx-ring {
  position: relative;
  width: 36px;
  height: 36px;
  margin-left: auto;
}
.ring {
  width: 36px;
  height: 36px;
  transform: rotate(-90deg);
}
.ring-bg {
  fill: none;
  stroke: var(--border);
  stroke-width: 3;
}
.ring-fg {
  fill: none;
  stroke: var(--text);
  stroke-width: 3;
  stroke-linecap: round;
  transition: stroke-dashoffset 0.35s var(--ease);
}
.ring-num {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: 8px;
  color: var(--text-2);
}
/* 输入框上方的信息横条：与 .box 同宽同中线、常驻一行。
   数字用等宽字体，否则每 2 秒刷一次速率会把整条的宽度拽来拽去；模型那一段可以被截断（带省略号），
   数字那几段永远显示（0.0 也显示），不玩「没数据就整条消失」。 */
.meta-bar {
  max-width: var(--msg-w, 860px);
  margin: 0 auto 5px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 4px;
  font-family: var(--mono);
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
}
.meta-bar .mb-item { display: inline-flex; align-items: center; gap: 4px; min-width: 0; overflow: hidden; text-overflow: ellipsis; flex: 0 0 auto; }
.meta-bar .mb-model { color: var(--text-2); flex: 0 1 auto; }
.meta-bar .mb-dot { opacity: 0.5; flex: 0 0 auto; }
.send {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: var(--text);
  color: var(--bg);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: transform var(--dur) var(--ease), opacity var(--dur) var(--ease);
}
.send:hover:not(:disabled) { transform: scale(1.05); }
.send:active:not(:disabled) { transform: scale(0.96); }
.send:disabled { opacity: 0.35; }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.approval,
.ask {
  max-width: 860px;
  margin: 0 auto 10px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px;
}
.ap-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.level {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: var(--radius-pill);
  background: var(--bg-active);
  color: var(--text-2);
}
.level.red { color: var(--danger); }
.ap-reason { color: var(--text-2); margin-bottom: 8px; }
.ap-args {
  margin: 0 0 10px;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-3);
  white-space: pre-wrap;
}
.ap-actions,
.ask-options {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
/* 审阅面板：批准前看清改动内容。diff 行直接用消息流那套 diff token（--diff-add-bg / --diff-del-bg / 前后景），
   自造一套绿红会在米白、云母这些主题下糊成看不清的行。 */
.ap-preview {
  margin-top: 10px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-panel);
  max-height: 46vh;
  overflow: auto;
}
.ap-sum {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 6px;
  font-size: 11px;
}
.ap-path {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-2);
  word-break: break-all;
}
.ap-tag {
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--text-3);
}
.ap-plus { color: var(--ok); }
.ap-minus { color: var(--danger); }
.ap-warn { margin: 6px 0 0; font-size: 11px; color: var(--text-3); line-height: 1.6; }
.ap-diff {
  font-family: var(--mono);
  font-size: 11px;
  line-height: 1.5;
  border-top: 1px solid var(--border-soft);
  padding-top: 6px;
}
.ap-line { display: flex; gap: 6px; white-space: pre-wrap; word-break: break-all; color: var(--text-2); }
.ap-line.add { background: var(--diff-add-bg); color: var(--diff-add-fg); }
.ap-line.del { background: var(--diff-del-bg); color: var(--diff-del-fg); }
.ap-line.gap { color: var(--text-3); font-style: italic; }
.ap-ln { flex: 0 0 34px; text-align: right; color: var(--text-3); user-select: none; }
.ap-tx { flex: 1 1 auto; }
.ap-cmd {
  margin: 0;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--bg-input);
  font-family: var(--mono);
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--text);
}
.ap-raw { margin-top: 6px; font-size: 11px; color: var(--text-3); }
.ap-raw summary { cursor: pointer; }
.ask-title {
  font-size: 12px;
  color: var(--text-3);
  margin-bottom: 6px;
}
.ask-q { margin-bottom: 10px; }
.ask-input {
  width: 100%;
  margin-top: 8px;
  background: var(--bg-input);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  font-size: 13px;
}
.ask-input::placeholder { color: var(--text-3); }
.ask-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
  justify-content: flex-end;
}
</style>
