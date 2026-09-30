<template>
  <div class="cu">
    <h4>
      电脑操作
      <button class="k-btn sm ghost refresh" type="button" @click="refresh(true)">刷新</button>
    </h4>

    <!-- 状态没读到时别装作「未启用」：那一行的真实原因只在报错里，摆出来才不用猜 -->
    <div v-if="err" class="err-text">{{ err }}</div>

    <!-- 本平台压根没有这条路（Linux/macOS）：先说这个，别让人去实验室找一个拨不动的开关 -->
    <div v-if="loaded && st.supported === false" class="card">
      <p class="muted">{{ st.support_note || 'Computer Use 只在 Windows 上可用（要 PowerShell + Win32 与 netwright）。' }}</p>
    </div>

    <!-- 总开关没开就只给这一句：摆一堆空表格会让人以为引擎坏了 -->
    <div v-else-if="!st.enabled" class="card">
      <p class="muted">
        {{ loaded
          ? 'Computer Use 未启用，请到 设置 → 实验室功能 → Computer Use 打开。'
          : '还没读到 Computer Use 的状态，上面就是原因。' }}
      </p>
    </div>

    <template v-else>
      <!-- 状态一行：用哪个引擎、坐标守护进程在不在、有没有免审批 -->
      <div class="badges">
        <span class="badge" :class="netLive ? 'on' : ''" :title="st.netwright.error || ''">{{ engineText }}</span>
        <span class="badge" :class="st.daemon ? 'on' : 'err'">坐标引擎{{ st.daemon ? '在' : '不在' }}</span>
        <span class="badge" :title="'快捷键：' + (st.hotkey || '未设置')">
          急停键 {{ st.hotkey ? hotkeyDisplay(st.hotkey) : '未设' }}
        </span>
      </div>
      <div v-if="st.open_all" class="open-all">
        <i class="fas fa-triangle-exclamation"></i> 全部开放中：截图与所有操作都不再问你
      </div>

      <!-- 屏幕上现在的窗口：挑一个放行，AI 才能对它动手 -->
      <div class="card">
        <div class="row">
          <span class="grow">屏幕上的窗口</span>
          <span v-if="wins.length" class="muted">{{ wins.length }} 个</span>
          <button class="k-btn sm" type="button" :disabled="probing" @click="loadWindows">
            {{ probing ? '读取中…' : '刷新屏幕上的窗口' }}
          </button>
        </div>
        <p v-if="!wins.length && !probing && !winErr" class="muted">
          还没有清单。坐标引擎在跑就能列出当前所有窗口，点「刷新屏幕上的窗口」。
        </p>
        <p v-if="winErr" class="err-text">{{ winErr }}</p>
        <div v-for="w in wins" :key="w.hwnd" class="win">
          <div class="row">
            <span class="grow ellip" :title="w.title || ''">{{ w.title || '（无标题）' }}</span>
            <button class="k-btn sm" type="button" @click="grantWindow(w)">授权</button>
          </div>
          <div class="row meta">
            <span class="mono ellip" :title="w.exe || ''">{{ baseName(w.exe) }}</span>
            <span>PID {{ w.pid }}</span>
            <span>{{ w.w }}×{{ w.h }}</span>
            <span v-if="w.foreground || w.hwnd === fg" class="badge on">前台</span>
            <span v-if="w.minimized" class="muted">最小化</span>
          </div>
        </div>
      </div>

      <!-- 已放行目标：和设置页、和 AI 用的是同一张表 -->
      <div class="card">
        <div class="row">
          <span class="grow">已放行目标</span>
          <span class="muted">{{ (st.grants || []).length }} 个</span>
        </div>
        <p v-if="!(st.grants || []).length" class="muted">现在没有任何目标被放行，AI 动不了东西。</p>
        <div v-for="g in st.grants" :key="g.id" class="win">
          <div class="row">
            <span class="grow ellip mono" :title="g.exe || g.title || ''">{{ baseName(g.exe) || g.title || '（按窗口放行）' }}</span>
            <button class="k-btn sm ghost" type="button" @click="revoke(g)">撤销</button>
          </div>
          <div class="row meta">
            <span>PID {{ g.pid || '—' }}</span>
            <span class="ellip">{{ g.title }}</span>
          </div>
        </div>
        <p v-if="st.last_stop_ts" class="muted">上次急停：{{ st.last_stop_ts }}（{{ stopReasonText(st.last_stop_reason) }}）</p>
      </div>

      <button class="k-btn danger stop" type="button" :disabled="busy" @click="emergencyStop">
        <i class="fas fa-hand"></i> 急停：撤销全部授权
      </button>
      <p class="muted tip">快捷键（如果设了）在任意场合按下同样有效，包括别的程序在前台时。</p>
    </template>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { aiApi } from '../../api';
import { toast } from '../../stores/toast';
import { errFull } from '../../utils/errText';

const props = defineProps({
  /** 当前会话：授权落在这一场对话上（后端 0 = 全局放行，跨会话都算） */
  chatId: { type: [Number, String], default: 0 },
  /** 右栏收起了：面板看不见就别继续轮询 */
  paused: { type: Boolean, default: false },
});

const st = ref({
  supported: true,
  support_note: '',
  enabled: false,
  open_all: false,
  engine_pref: 'auto',
  netwright: { status: 'unknown', error: '', tools: 0 },
  daemon: false,
  grants: [],
  hotkey: '',
  last_stop_ts: '',
  last_stop_reason: '',
});
const wins = ref([]);
const fg = ref(0);            // 清单里那份「当前前台 hwnd」
const err = ref('');          // 状态轮询本身读不到（后端没起来）
const winErr = ref('');       // 窗口清单与放行/撤销/急停这些动作的原因
const loaded = ref(false);
const probing = ref(false);
const busy = ref(false);

const netLive = computed(() => st.value.netwright?.status === 'live');
// 只照实说出「现在会用哪个引擎」：谁兜底是后端的事，前端不做判断
const engineText = computed(() => {
  const p = st.value.engine_pref;
  if (p === 'coords') return '引擎：坐标';
  if (p === 'netwright') return '引擎：netwright';
  return netLive.value ? '引擎：netwright' : '引擎：坐标兜底';
});

function baseName(p) {
  return String(p || '').split(/[\\/]/).pop() || '';
}
function stopReasonText(r) {
  return { hotkey: '快捷键按下', manual: '界面按钮', blacklist: '命中黑名单' }[r] || (r || '未知');
}
const HOTKEY_NAME = {
  ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', win: 'Win', esc: 'Esc', enter: 'Enter', space: '空格',
  backspace: 'Backspace', delete: 'Delete', insert: 'Insert', home: 'Home', end: 'End',
  pageup: 'PgUp', pagedown: 'PgDn', up: '↑', down: '↓', left: '←', right: '→',
  printscreen: 'PrtSc', xbutton1: '侧键1', xbutton2: '侧键2',
};
function hotkeyDisplay(spec) {
  return String(spec || '').split('+').filter(Boolean).map((p) => HOTKEY_NAME[p] || (p.length === 1 ? p.toUpperCase() : p)).join(' + ');
}

/** silent 轮询：后端没起来时在面板里说一句就行，不该每 3 秒刷一条红 toast */
async function refresh(manual) {
  try {
    const s = await aiApi.computerState(props.chatId || 0, !manual);
    if (s) st.value = { ...st.value, ...s, netwright: { status: 'unknown', error: '', tools: 0, ...(s.netwright || {}) } };
    loaded.value = true;
    err.value = '';
  } catch (e) {
    err.value = errFull(e, 'Computer Use 状态读取失败');
  }
}

async function loadWindows() {
  probing.value = true;
  try {
    const r = await aiApi.computerProbe('windows');
    wins.value = r?.list || [];
    fg.value = Number(r?.foreground) || 0;
    winErr.value = wins.value.length ? '' : '坐标引擎回了一份空清单（引擎没跑或读不到窗口）';
  } catch (e) {
    // 探测失败的原因全在这里给出：坐标引擎没跑时那句「没响应」后面跟的是真原因
    winErr.value = errFull(e, '窗口清单读取失败');
    wins.value = [];
  } finally {
    probing.value = false;
  }
}

async function grantWindow(w) {
  winErr.value = '';
  try {
    await aiApi.computerGrant({ chat_id: props.chatId || 0, pid: w.pid, exe: w.exe, title: w.title });
    toast(`已放行 ${baseName(w.exe) || w.title || '这个窗口'}`, 'success', 2200);
    await refresh(true);
  } catch (e) {
    winErr.value = errFull(e, '授权失败');
  }
}

async function revoke(g) {
  winErr.value = '';
  try {
    await aiApi.computerRevokeGrant(g.id);
    await refresh(true);
  } catch (e) {
    winErr.value = errFull(e, '撤销失败');
  }
}

async function emergencyStop() {
  busy.value = true;
  winErr.value = '';
  try {
    await aiApi.computerEmergencyStop('chat dock');
    toast('已急停，全部授权已撤销', 'warn', 3200);
    await refresh(true);
  } catch (e) {
    winErr.value = errFull(e, '急停失败');
  } finally {
    busy.value = false;
  }
}

/* ---- 快捷键急停要能立刻反映到界面：3 秒一轮状态 + 一条长轮询事件流 ---- */
let pollTimer = null;
let stopped = false;
let evCtrl = null;
let since = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function eventLoop() {
  while (!stopped) {
    try {
      evCtrl = new AbortController();
      const d = await aiApi.computerEvents(since, evCtrl.signal);
      if (stopped) break;
      since = Number(d?.latest) || since;
      const evs = d?.events || [];
      if (evs.length) {
        const last = evs[evs.length - 1];
        toast(last.reason === 'hotkey' ? '已急停，全部授权已撤销' : `已急停（${stopReasonText(last.reason)}），全部授权已撤销`, 'warn', 3600);
        await refresh(true);
      }
    } catch (e) {
      if (stopped) break;
      // 长轮询挂了（后端重启、网络断）就隔几秒再连，别把这里打成狂转
      await sleep(4000);
    }
  }
}

onMounted(async () => {
  await refresh(true);
  // 事件流只从现在这一刻开始要：服务端记着本次运行以来的全部急停，
  // 从 0 起读会把早就看过的那几次急停重新弹一遍 toast
  since = Date.now();
  pollTimer = setInterval(() => {
    if (!stopped && !props.paused && st.value.enabled) refresh(false);
  }, 3000);
  eventLoop();
});

onUnmounted(() => {
  stopped = true;
  clearInterval(pollTimer);
  // 在途的那次长轮询要真掐掉，不然卸载后它还挂着 20 秒、回来再写已销毁的组件
  if (evCtrl) evCtrl.abort();
});
</script>

<style scoped>
/* 这一栏跟 ChatDock 里其它面板同一套排布，只是样式得自带（scoped 不外溢） */
.cu { display: flex; flex-direction: column; gap: 10px; }
h4 {
  margin: 0;
  font-size: 11px;
  color: var(--text-3);
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
}
h4 .refresh { margin-left: auto; }
.card {
  background: var(--bg-panel);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  padding: 10px;
}
.muted { color: var(--text-3); font-size: 12px; }
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 0;
  font-size: 12px;
}
.grow { flex: 1; min-width: 0; }
.ellip { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mono { font-family: var(--mono); font-size: 11px; }
.badges { display: flex; flex-wrap: wrap; gap: 6px; }
.badge {
  font-size: 10px;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  color: var(--text-3);
}
.badge.on { color: var(--ok); border-color: var(--ok); background: var(--ok-soft); }
.badge.err { color: var(--danger); border-color: var(--danger-line); }
/* 「全部开放」开着的时候必须刺眼：这一条免掉的是所有审批 */
.open-all {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border: 1px solid var(--danger);
  border-radius: var(--radius-sm);
  background: var(--danger-soft);
  color: var(--danger);
  font-size: 11.5px;
  font-weight: 600;
}
.win { padding: 6px 0; }
.win + .win { border-top: 1px solid var(--border-soft); }
.meta { font-size: 11px; color: var(--text-3); gap: 10px; padding: 0 0 2px; }
.err-text { color: var(--danger); font-size: 11.5px; line-height: 1.6; word-break: break-all; }
.stop { align-self: stretch; }
.tip { margin: -4px 0 0; font-size: 11px; line-height: 1.6; }
</style>
