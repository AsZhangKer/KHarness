<template>
  <aside ref="dockEl" class="dock" :class="{ collapsed, peek: collapsed && peek }">
    <button ref="toggleEl" class="dock-toggle" type="button" :title="collapsed ? '展开面板（也可把鼠标贴到栏右边）' : '收起面板'" @click="collapsed = !collapsed">
      <i class="fas" :class="collapsed ? 'fa-chevron-left' : 'fa-chevron-right'"></i>
    </button>
    <div v-show="!collapsed || peek" class="dock-inner">
      <!-- 标签条右键可勾选显示哪些面板：默认只留 计划 / 后台 / 电脑 / 用量参数，其余要用的人自己开 -->
      <div class="dock-tabs" @contextmenu.prevent="openTabsMenu">
        <KTabs v-model="tab" :items="tabs" icons-only />
      </div>
      <div class="dock-body">
      <!-- 计划 -->
      <section v-show="tab === 'plan'">
        <h4>计划任务</h4>
        <div class="card">
          <div v-if="!tasks.length" class="muted">
            {{ planMode ? '计划模式，使用任务栏可检阅Agent下发的计划任务;' : '计划模式未开启，使用任务栏可检阅Agent下发的计划任务;' }}
          </div>
          <div v-for="t in tasks" :key="t.id" class="task" :class="'is-' + t.status">
            <i :class="taskIcon(t.status)"></i>
            <div class="t" :title="t.error_summary || ''">{{ t.content }}</div>
            <KDropdown
              class="task-status"
              :items="TASK_STATUS"
              :model-value="t.status"
              :label="taskStatusLabel(t.status)"
              width="104px"
              @change="(v) => $emit('update-task', t.id, { status: v })"
            />
          </div>
        </div>
      </section>

      <!-- 后台任务 -->
      <section v-show="tab === 'bg'">
        <h4>
          后台任务
          <button class="k-btn sm ghost refresh" type="button" @click="loadBg">刷新</button>
        </h4>
        <div class="card">
          <div v-if="bgErr" class="muted">{{ bgErr }}</div>
          <div v-else-if="!bgTasks.length" class="muted">
            暂无后台任务。模型可调用<code>run_background</code>启动后台异步构建。
          </div>
          <div v-for="t in bgTasks" :key="t.id" class="bg-item">
            <div class="row">
              <span class="badge" :class="t.state === 'running' ? 'on' : ''">{{ bgState(t.state) }}</span>
              <span class="mono grow" :title="t.command">{{ t.command }}</span>
              <button
                v-if="t.state === 'running'"
                class="k-btn sm danger"
                type="button"
                @click="killBg(t.id)"
              >终止</button>
            </div>
            <div class="row muted small">
              <span>{{ t.id }}</span><span>PID {{ t.pid }}</span><span>{{ fmtDur(t.runtime_ms) }}</span>
              <span v-if="t.exit != null">退出码 {{ t.exit }}</span>
            </div>
            <pre v-if="t.tail" class="bg-tail">{{ t.tail }}</pre>
          </div>
        </div>
      </section>

      <!-- 电脑操作（Computer Use）：总开关和急停快捷键在「设置 → 实验室功能」，
           这一栏看的是「屏幕上现在有什么、已经放行了什么」，并留一颗急停。 -->
      <section v-show="tab === 'cu'">
        <!-- 只在这一页开着时挂着：面板自己 3 秒一轮状态 + 一条长轮询，切走就该把定时器和轮询一起停 -->
        <ComputerUsePanel v-if="tab === 'cu'" :chat-id="store.state.chatId || 0" :paused="collapsed" />
      </section>

      <!-- 子智能体 -->
      <section v-show="tab === 'agents'">
        <h4>
          子智能体
          <button class="k-btn sm ghost refresh" type="button" @click="loadAgents">刷新</button>
        </h4>
        <div class="card">
          <div v-if="!agents.length" class="muted">
            还没有子智能体。模型使用 <code>agent_run</code> 和 <code>agent_spawn</code> 派出的只读子智能体将列出于此；
            你也可以直接手动派遣一个子智能体。要使用该功能，请在「设置 → 工具 → 子智能体」勾选启用。
          </div>
          <div v-for="a in agents" :key="a.id" class="bg-item">
            <div class="row">
              <span class="badge" :class="a.status === 'running' || a.status === 'queued' ? 'on' : (a.status === 'done' ? '' : 'err')">{{ agentState(a.status) }}</span>
              <span class="grow" :title="a.task">{{ a.name }}</span>
              <button v-if="a.running" class="k-btn sm danger" type="button" @click="killAgent(a.id)">停止</button>
              <button class="k-btn sm ghost" type="button" @click="toggleAgent(a.id)">{{ openAgent[a.id] ? '收起' : '详情' }}</button>
              <button class="k-btn sm ghost" type="button" title="删除记录" @click="delAgent(a.id)"><i class="fas fa-trash"></i></button>
            </div>
            <div class="row muted small">
              <span>{{ a.id }}</span>
              <span v-if="a.model">{{ a.model }}</span>
              <span>{{ a.iter }} 轮 / {{ a.steps }} 步</span>
            </div>
            <template v-if="openAgent[a.id]">
              <div class="ag-task">{{ a.task_full || a.task }}</div>
              <pre v-if="a.status === 'done' || a.result_preview" class="bg-tail">{{ a.result_full || a.result_preview }}</pre>
              <pre v-if="a.error" class="bg-tail err-text">{{ a.error }}</pre>
            </template>
          </div>
        </div>
        <div class="card ag-new">
          <input v-model="agName" class="k-input" placeholder="短名（可空），如 survey-auth" />
          <textarea v-model="agTask" class="k-input nu-textarea" rows="3" placeholder="要它去查什么？子智能体只读、看不到本会话历史，背景要写清楚"></textarea>
          <button class="k-btn primary sm" type="button" :disabled="!agTask.trim() || agBusy" @click="spawnAgent">下发任务</button>
        </div>
      </section>

      <!-- 修改历史 -->
      <section v-show="tab === 'history'">
        <h4>修改历史</h4>
        <div class="card">
          <div v-if="!history.length" class="muted">本会话尚无文件修改/撤销记录。</div>
          <div v-for="(h, i) in history" :key="i" class="row hist">
            <div class="grow">
              <div>{{ h.tool }}</div>
              <div class="mono muted">{{ h.path || h.undo_id }}</div>
              <div v-if="openHist[i]" class="hist-body">
                <div v-if="h.diff?.length" class="mini-diff">
                  <div
                    v-for="(ln, li) in histLines(h)"
                    :key="li"
                    class="dline"
                    :class="ln.kind"
                  >{{ ln.text }}</div>
                </div>
                <div v-else class="muted">{{ h.output || '（无详情）' }}</div>
              </div>
            </div>
            <div class="col">
              <button class="k-btn sm ghost" type="button" @click="openHist[i] = !openHist[i]">
                {{ openHist[i] ? '收起' : '展开' }}
              </button>
              <button
                class="k-btn sm"
                type="button"
                :disabled="histUndone(h)"
                @click="$emit('undo', h.ref || h)"
              >{{ histUndone(h) ? '已撤销' : '撤销' }}</button>
            </div>
          </div>
        </div>
      </section>

      <!-- 文件列表 -->
      <section v-show="tab === 'files'">
        <h4>文件列表</h4>
        <div class="card">
          <div v-if="cwd" class="row">
            <span class="muted">工作目录</span>
            <span class="mono">{{ cwd }}</span>
          </div>
          <div v-if="!files.length" class="muted">对话中读写的文件会汇总到这里。</div>
          <div v-for="f in files" :key="f" class="file">
            <i class="fas fa-file-lines"></i>
            <span class="mono" :title="f">{{ f }}</span>
          </div>
        </div>

        <h4 class="sub-head">
          工作区变更
          <button class="k-btn sm ghost" type="button" @click="loadChanges">刷新</button>
        </h4>
        <div class="card">
          <div v-if="!labGit" class="muted">
            该功能先前为实验室功能，现已弃用。
          </div>
          <div v-else-if="chgErr" class="muted">{{ chgErr }}</div>
          <div v-else-if="!chg.is_repo" class="muted">当前工作目录不是 Git 仓库。</div>
          <template v-else>
            <div class="row">
              <span class="muted">分支</span>
              <span class="mono">{{ chg.branch || '—' }}</span>
              <span class="muted">{{ chg.files.length }} 项未提交{{ chg.truncated ? '（已截断）' : '' }}</span>
            </div>
            <div v-if="chg.stat" class="chg-stat">{{ chg.stat }}</div>
            <div v-for="f in chg.files.slice(0, 60)" :key="f.path" class="row chg-row">
              <span class="chg-flag" :class="flagClass(f.status)">{{ f.status || '?' }}</span>
              <span class="mono grow ellip" :title="f.path">{{ f.path }}</span>
            </div>
            <div v-if="!chg.files.length" class="muted">工作区干净，没有未提交变更。</div>
            <div class="actions">
              <button class="btn" type="button" :disabled="!chg.files.length" @click="$emit('git-action', 'commit')">
                提交全部
              </button>
              <button class="btn" type="button" :disabled="!chg.files.length" @click="$emit('git-action', 'commit-push')">
                提交并推送
              </button>
            </div>
            <p class="muted tip">提交走服务端 /git/commit：暂存区若混入 kh.db / 日志 / 撤销快照会被拦下。</p>
          </template>
        </div>
      </section>

      <!-- 用量 + 参数 -->
      <section v-show="tab === 'usage'">
        <h4>用量信息</h4>
        <div class="card">
          <div class="row"><span class="muted">本轮输入</span><span>{{ fmt(usage.prompt_tokens) }} tok</span></div>
          <div class="row"><span class="muted">本轮输出</span><span>{{ fmt(usage.completion_tokens) }} tok</span></div>
          <div class="row"><span class="muted">缓存</span><span>{{ fmt(usage.cached_tokens) }} tok</span></div>
          <div class="row"><span class="muted">思考</span><span>{{ fmt(usage.reasoning_tokens) }} tok</span></div>
          <div class="row"><span class="muted">上下文</span><span>{{ fmt(contextUsed) }} / {{ fmt(contextLimit) || '—' }}</span></div>
          <div class="actions">
            <button class="btn" type="button" @click="$emit('press')">压缩上下文</button>
            <button class="btn" type="button" @click="ctxOpen = true">设定窗口</button>
          </div>
        </div>
      </section>

      <!-- 参数 -->
      <section v-show="tab === 'usage'">
        <h4>会话参数</h4>
        <div class="card">
          <div class="row"><span class="muted">模型</span><span>{{ modelName || '未选择' }}</span></div>
          <div class="row"><span class="muted">Agent</span><span>{{ agentMode ? '开' : '关' }}</span></div>
          <div class="row"><span class="muted">Plan</span><span>{{ planMode ? '开' : '关' }}</span></div>
          <div class="row"><span class="muted">只读</span><span>{{ readonlyMode ? '开' : '关' }}</span></div>
          <div class="row"><span class="muted">模型池</span><span>{{ autoMode ? '自动' : '单模型' }}</span></div>
          <div class="row"><span class="muted">审批</span><span>{{ approvalLabel }}</span></div>
          <div class="row"><span class="muted">目录</span><span class="mono">{{ cwd || '—' }}</span></div>
        </div>
        <h4>已加载技能</h4>
        <div class="card chips">
          <span v-if="!loadedSkills.length" class="muted">无</span>
          <span v-for="s in loadedSkills" :key="s" class="chip">{{ s }}</span>
        </div>
        <h4>待注入提示词</h4>
        <div class="card">
          <div v-if="!insertItems.length" class="muted">无。可用 <code>/insert</code> 预埋。</div>
          <div v-for="(it, i) in insertItems" :key="i" class="insert-item">{{ it }}</div>
          <button v-if="insertItems.length" class="btn" type="button" @click="$emit('clear-insert')">
            清空
          </button>
        </div>
      </section>

      <!-- 监工：三行控制台（选模型 / 说话 / 发送·停止）+ 它自己的对话记录。
           监工替用户跟主智能体说话：它拆计划、下发命令、自己开浏览器验收，直到 project_done。 -->
      <section v-show="tab === 'watch'">
        <div class="sup-console">
          <KDropdown class="sup-row" :items="supModelItems" :label="supModelLabel" width="100%" @change="svSetModel" />
          <textarea
            v-model="svSup.draft"
            class="sup-row sup-input"
            rows="3"
            placeholder="把任务交给监工：它拆计划、给主智能体下命令、自己验收，直到宣布完工"
            @keydown.enter.exact.prevent="svSay"
          ></textarea>
          <div class="sup-row sup-acts">
            <button class="btn sm" type="button" :disabled="svSup.running || svSup.waiting || !svSup.draft.trim()" @click="svSay">
              {{ svSup.running ? '监工在想…' : '发送' }}
            </button>
            <button class="btn sm ghost" type="button" :disabled="!svSup.running && !svSup.waiting" @click="svStopSay">停止</button>
            <button v-if="!svSup.running && !svSup.waiting && svSup.turns.length" class="btn sm ghost" type="button" @click="superviseStore.clearTurns()">清空</button>
            <span class="sup-hint">Enter 发送, Shift+Enter 换行</span>
          </div>
          <div v-if="svSup.waiting" class="sup-row sup-status">
            <i class="fas fa-circle-notch fa-spin"></i> 主智能体正在工作，结束后会自动回叫监工接下一棒（按「停止」可中断操作）
          </div>
        </div>
        <div v-if="svSup.error" class="ck-bad">{{ svSup.error }}</div>

        <div class="sup-turns">
          <div v-if="!svSup.turns.length" class="muted">
            还没跟监工说过话。快来下发你的第一个监工任务，例如「把这个项目做成能跑的单页站，每一步自己验收完再进下一步」。
          </div>
          <template v-for="turn in svSup.turns" :key="turn.id">
            <div v-if="turn.kind === 'user'" class="sup-turn is-user">{{ turn.text }}</div>
            <div v-else-if="turn.kind === 'cmd'" class="sup-turn is-cmd">
              <div class="t">▸ 下发给主智能体：{{ turn.title }}</div>
              <pre>{{ turn.text }}</pre>
            </div>
            <div v-else-if="turn.kind === 'plan'" class="sup-turn is-note">
              <div v-for="(it, i) in turn.items" :key="i">{{ i + 1 }}. {{ it }}</div>
            </div>
            <div v-else-if="turn.kind === 'case'" class="sup-turn" :class="turn.ok ? 'is-ok' : 'is-bad'">
              {{ turn.ok ? '✅' : '❌' }} {{ turn.name }}
            </div>
            <div v-else-if="turn.kind === 'report'" class="sup-turn is-note">交付报告：<code>{{ turn.text }}</code></div>
            <div v-else class="sup-turn is-sup">
              <div v-if="turn.steps && turn.steps.length" class="s-steps">
                <span
                  v-for="(s, i) in turn.steps"
                  :key="i"
                  class="s-chip"
                  :class="{ note: s.type === 'note', bad: s.type === 'result' && s.ok === false }"
                  :title="s.message || s.preview || ''"
                >{{ s.type === 'note' ? s.message : (s.type === 'tool' ? s.name : `${s.name} ${s.ok === false ? '✗' : '✓'}`) }}</span>
              </div>
              <div class="s-text">{{ turn.text }}<span v-if="turn.streaming" class="s-caret">▍</span></div>
            </div>
          </template>
        </div>

        <details class="sup-manual">
          <summary>手动验收清单（kh.checks.md）</summary>
        <h4>
          验收清单
          <button class="btn sm" type="button" :disabled="sv.running" @click="runWatch">{{ sv.running ? '跑测中…' : '跑一轮' }}</button>
          <button v-if="sv.running" class="btn sm" type="button" @click="svStop">停止</button>
          <button class="btn sm ghost" type="button" @click="svLoad(store.state.chatId)">刷新</button>
        </h4>
        <div class="card">
          <div v-if="sv.loading" class="muted">读清单中…</div>
          <div v-else-if="!sv.exists" class="muted">
            项目里还没有 <code>kh.checks.md</code>。
            <button class="btn sm" type="button" @click="copyTemplate">复制模板</button>
            <pre class="ck-tpl">{{ sv.template }}</pre>
          </div>
          <template v-else>
            <div class="muted ck-file">{{ sv.file }}</div>
            <div v-for="(c, i) in sv.cases" :key="i" class="ck-case">
              <div class="ck-name">{{ c.name }}</div>
              <div class="muted ck-asserts">{{ assertBrief(c) }}</div>
            </div>
            <div v-if="!sv.cases.length" class="muted">解析不出可跑的用例，先看下面的格式问题。</div>
          </template>
          <div v-if="sv.parseErrors.length" class="ck-errs">
            <div v-for="(e, i) in sv.parseErrors" :key="i" class="ck-bad">第 {{ e.line }} 行：{{ e.message }}</div>
          </div>
        </div>

        <h4>本轮结果<span v-if="sv.summary" class="muted">　{{ sv.summary.passed }}/{{ sv.summary.total }} 通过{{ sv.summary.stopped ? '（已中断）' : '' }}</span></h4>
        <div class="card">
          <div v-if="!sv.results.length" class="muted">还没跑。清单好了就点「跑一轮」。</div>
          <div v-for="r in sv.results" :key="r.idx" class="ck-run" :class="'is-' + r.status">
            <div class="ck-hd">
              <i :class="runIcon(r.status)"></i>
              <span class="nm">{{ r.name || `用例 ${r.idx + 1}` }}</span>
              <span v-if="r.ms" class="muted">{{ (r.ms / 1000).toFixed(1) }}s</span>
            </div>
            <div v-for="(k, i) in r.checks" :key="i" class="ck-line" :class="{ bad: !k.ok }">
              {{ k.ok ? '✓' : '✗' }} {{ k.kind }}<span v-if="k.detail" class="muted"> — {{ firstLine(k.detail) }}</span>
            </div>
            <div v-if="r.diag" class="ck-line">诊断：{{ r.diag }}</div>
            <div v-if="r.shot" class="ck-line muted">证据截图：{{ r.shot }}</div>
          </div>
          <div v-if="sv.summary && sv.summary.failed" class="ck-acts">
            <button class="btn sm" type="button" @click="svHand(store.state.chatId)">
              把 {{ sv.summary.failed }} 项失败交给主 Agent
            </button>
          </div>
          <div v-if="sv.summary && !sv.summary.failed && sv.summary.total" class="ck-acts muted">
            全过了。报告在 <code>{{ sv.summary.report }}</code>
          </div>
          <div v-if="sv.error" class="ck-bad">{{ sv.error }}</div>
        </div>
        </details>
      </section>
      </div>
    </div>

    <KModal :open="ctxOpen" title="设定上下文窗口" @close="ctxOpen = false">
      <KInput v-model="ctxLimit" label="context limit（token）" type="number" block />
      <template #footer>
        <button class="btn" type="button" @click="ctxOpen = false">取消</button>
        <button class="btn" type="button" @click="saveCtx">确定</button>
      </template>
    </KModal>

    <!-- 标签条的右键菜单：勾哪些页就显示哪些页，点一下即时生效并写回本地 -->
    <Teleport to="body">
      <div v-if="tabsMenu" class="ctx-mask" @mousedown="tabsMenu = false" @contextmenu.prevent="tabsMenu = false"></div>
      <div v-if="tabsMenu" class="ctx-menu dock-tabs-menu" :style="{ left: tabsPos.x + 'px', top: tabsPos.y + 'px' }" @contextmenu.prevent="tabsMenu = false">
        <div class="dtm-hint">在标签条显示</div>
        <button v-for="t in visibleTabs" :key="t.id" type="button" @click="toggleTabShown(t.id)">
          <i class="fas" :class="shownTabs.includes(t.id) ? 'fa-square-check' : 'fa-square'"></i>
          <span class="grow">{{ t.label }}</span>
        </button>
        <div class="dtm-sep"></div>
        <button type="button" @click="resetTabsShown"><i class="fas fa-rotate-left"></i> 恢复默认</button>
      </div>
    </Teleport>
  </aside>
</template>

<script setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import KTabs from '../../ui/KTabs.vue';
import KModal from '../../ui/KModal.vue';
import KInput from '../../ui/KInput.vue';
import KDropdown from '../../ui/KDropdown.vue';
import ComputerUsePanel from './ComputerUsePanel.vue';
import { useEdgePeek } from '../../ui/useEdgePeek';
import { formatTokens } from '../../utils/format';
import { aiApi } from '../../api';
import { uiPrefs } from '../../stores/prefs';
import { useChatStore } from './chatStore';
import { superviseStore } from './superviseStore';
import { toast } from '../../stores/toast';
import { confirmDialog } from '../../stores/confirm';

const store = useChatStore();

const TASK_STATUS = [
  { value: 'pending', label: '待办' },
  { value: 'doing', label: '进行' },
  { value: 'done', label: '完成' },
  { value: 'failed', label: '失败' },
];

const props = defineProps({
  tasks: { type: Array, default: () => [] },
  history: { type: Array, default: () => [] },
  files: { type: Array, default: () => [] },
  usage: { type: Object, default: () => ({}) },
  cwd: { type: String, default: '' },
  planMode: Boolean,
  agentMode: Boolean,
  readonlyMode: Boolean,
  autoMode: Boolean,
  approvalMode: { type: String, default: 'default' },
  modelName: { type: String, default: '' },
  loadedSkills: { type: Array, default: () => [] },
  insertItems: { type: Array, default: () => [] },
  contextUsed: { type: Number, default: 0 },
  contextLimit: { type: Number, default: 0 },
  /** 实验室「Git 版本预览」开关（来自 localStorage，随请求一起发给后端） */
  labGit: { type: Boolean, default: false },
  /** 展开态的栏宽（父组件拖分栏那个值）：贴边临时展开时按它判断指针是否已离开栏体 */
  dockW: { type: Number, default: 300 },
});

const emit = defineEmits(['undo', 'update-task', 'press', 'set-context', 'clear-insert', 'git-action']);

/* ---- 工作区变更预览 ---- */
const chg = ref({ is_repo: false, branch: '', files: [], stat: '' });
const chgErr = ref('');

function flagClass(s) {
  const v = String(s || '');
  if (v.includes('D')) return 'del';
  if (v.includes('A') || v === '??') return 'add';
  if (v.includes('M') || v.includes('R')) return 'mod';
  return '';
}

async function loadChanges() {
  if (!props.labGit) return;
  chgErr.value = '';
  try {
    const r = await aiApi.gitChanges({ path: props.cwd || undefined, chat_id: store.state.chatId || undefined });
    chg.value = {
      is_repo: !!r?.is_repo,
      branch: r?.branch || '',
      files: r?.files || [],
      stat: r?.stat || '',
      truncated: !!r?.truncated,
    };
  } catch (e) {
    chgErr.value = e?.response?.data?.message || '变更读取失败';
  }
}

const ALL_TABS = [
  { id: 'plan', label: '计划', icon: 'fas fa-list-check' },
  { id: 'bg', label: '后台', icon: 'fas fa-gears' },
  { id: 'cu', label: '电脑', icon: 'fas fa-computer' },
  { id: 'agents', label: '子智能体', icon: 'fas fa-diagram-project' },
  { id: 'watch', label: '监工', icon: 'fas fa-clipboard-check' },
  { id: 'history', label: '历史', icon: 'fas fa-clock-rotate-left' },
  { id: 'files', label: '文件', icon: 'fas fa-folder-open' },
  { id: 'usage', label: '用量参数', icon: 'fas fa-chart-simple' },
];
// 八项全摆在窄栏上太挤，默认只留这四个；其余右键标签条自己打开
const DEFAULT_SHOWN = ['plan', 'bg', 'cu', 'usage'];
const SHOWN_KEY = 'kh.dock.tabs';
// 「电脑」是后加的一页：老清单里没有它，光靠 DEFAULT_SHOWN 对已经有存档的人没用。
// 补一次之后就记个标记，免得用户手动关掉后每次进来又被塞回去。
const CU_BACKFILL_KEY = 'kh.dock.tabs.cu_backfilled';

function loadShownTabs() {
  try {
    const raw = JSON.parse(localStorage.getItem(SHOWN_KEY) || 'null');
    if (!Array.isArray(raw)) return [...DEFAULT_SHOWN];
    // 只认已知 id，且顺序按 ALL_TABS 走：以后加页/调序都不会被老数据卡住
    let ok = ALL_TABS.filter((t) => raw.includes(t.id)).map((t) => t.id);
    if (!ok.includes('cu') && !localStorage.getItem(CU_BACKFILL_KEY)) {
      try { localStorage.setItem(CU_BACKFILL_KEY, '1'); } catch (e) { /* 写不进去就算了，大不了多补一次 */ }
      ok = ALL_TABS.filter((t) => t.id === 'cu' || ok.includes(t.id)).map((t) => t.id);
    }
    return ok.length ? ok : [...DEFAULT_SHOWN];
  } catch (e) {
    return [...DEFAULT_SHOWN];
  }
}

const shownTabs = ref(loadShownTabs());
/* 「监工」这一页受实验室开关管：supervisor_enabled 关着（默认）时，页签、右键菜单里都不出现，
   后端 /supervise/run 与 /hosted/run 也跟着拒 —— 半废弃的功能不留能点却没反应的入口。
   本地存档（kh.dock.tabs）里已经勾过 watch 的人也不用清：这里只是不显示，开关打开就回来。 */
const visibleTabs = computed(() => ALL_TABS.filter((t) => t.id !== 'watch' || uiPrefs.state.supervisorOn));
const tabs = computed(() => visibleTabs.value.filter((t) => shownTabs.value.includes(t.id)));
watch(() => uiPrefs.state.supervisorOn, (on) => {
  if (!on && tab.value === 'watch') tab.value = tabs.value[0] ? tabs.value[0].id : 'plan';
});
const tabsMenu = ref(false);
const tabsPos = ref({ x: 0, y: 0 });

function persistShownTabs() {
  try { localStorage.setItem(SHOWN_KEY, JSON.stringify(shownTabs.value)); } catch (e) { /* 隐私模式下写不进，不影响本次使用 */ }
}

function openTabsMenu(e) {
  // 菜单约 8 行 + 提示 + 分隔线，贴着光标往下长，底部放不下就往上收
  const h = ALL_TABS.length * 30 + 68;
  tabsPos.value = {
    x: Math.max(6, Math.min(e.clientX, window.innerWidth - 200)),
    y: Math.max(6, Math.min(e.clientY, window.innerHeight - h)),
  };
  tabsMenu.value = true;
}

function toggleTabShown(id) {
  const i = shownTabs.value.indexOf(id);
  if (i >= 0) {
    if (shownTabs.value.length === 1) {
      toast('至少要留一个面板', 'warn');
      return;
    }
    shownTabs.value = shownTabs.value.filter((x) => x !== id);
    if (tab.value === id) tab.value = shownTabs.value[0];
  } else {
    // 按 ALL_TABS 的顺序插回去，别把用户开出来的页堆到末尾乱了序
    shownTabs.value = ALL_TABS.filter((t) => t.id === id || shownTabs.value.includes(t.id)).map((t) => t.id);
    tab.value = id;
  }
  persistShownTabs();
}

function resetTabsShown() {
  shownTabs.value = [...DEFAULT_SHOWN];
  if (!shownTabs.value.includes(tab.value)) tab.value = 'plan';
  persistShownTabs();
  tabsMenu.value = false;
}

const tab = ref(shownTabs.value[0] || 'plan');
const collapsed = ref(false);
const dockEl = ref(null);
const toggleEl = ref(null);
// 收起时鼠标贴栏右边临时探出来；把手那条通道刻意排除（见 useEdgePeek 注释）
const { peek } = useEdgePeek({
  collapsed,
  side: 'right',
  hostEl: dockEl,
  toggleEl,
  widthOf: () => props.dockW || 300,
});

// 别处（监工聚焦、切页时选中被藏起来的面板）改 tab 时自动把那页摆回标签条，
// 否则会停在一个没有按钮、高亮框也量不到的页上
watch(tab, (v) => {
  if (shownTabs.value.includes(v)) return;
  shownTabs.value = ALL_TABS.filter((t) => t.id === v || shownTabs.value.includes(t.id)).map((t) => t.id);
  persistShownTabs();
});

/* 监工：状态在服务端跑，这里只是遥控器（清单预览 + 跑一轮 + 看结果） */
const sv = superviseStore.state;
const { loadChecks: svLoad, stop: svStop, handToMain: svHand } = superviseStore;

/* ---------------- 监工控制台（托管） ---------------- */
const svSup = sv.sup;
const supModelItems = computed(() => [
  { value: 0, label: '监工模型：跟随会话模型' },
  ...store.state.models
    .filter((m) => !m.disabled)
    .map((m) => ({ value: m.id, label: m.display_name || m.model_id })),
]);
const supModelLabel = computed(() => {
  const id = svSup.model;
  if (!id) return '监工模型：跟随会话';
  const m = store.state.models.find((x) => x.id === id);
  return m ? `监工：${m.display_name || m.model_id}` : '监工模型：跟随会话';
});
function svSetModel(v) { superviseStore.setSupModel(v); }
function svSay() {
  superviseStore.say({ chatId: store.state.chatId, workerModel: store.currentModel.value?.id });
}
function svStopSay() { superviseStore.stopSay(); }

function runWatch() {
  superviseStore.run({ chatId: store.state.chatId, modelRowId: store.currentModel.value?.id });
}
function runIcon(s) {
  return { wait: 'far fa-circle', run: 'fas fa-circle-notch fa-spin', pass: 'fas fa-circle-check', fail: 'fas fa-circle-xmark' }[s] || 'far fa-circle';
}
function firstLine(s) {
  return String(s || '').split('\n')[0].slice(0, 90);
}
function assertBrief(c) {
  const bits = [];
  if (c.url) bits.push(c.url);
  if (c.steps.length) bits.push(`${c.steps.length} 步`);
  if (c.expect_text.length) bits.push(`含「${c.expect_text.join('、')}」`);
  if (c.expect_not.length) bits.push(`不含「${c.expect_not.join('、')}」`);
  if (c.expect_selector.length) bits.push(`可见 ${c.expect_selector.join('、')}`);
  if (c.wait_for || c.wait_text) bits.push(`等 ${c.wait_for || c.wait_text}`);
  if (c.console_no_errors !== false) bits.push('控制台零错误');
  return bits.join('　');
}
function copyTemplate() {
  navigator.clipboard?.writeText(sv.template || '').then(
    () => toast('模板已复制，存成项目根的 kh.checks.md 即可', 'success'),
    () => toast('复制失败，直接照上面手写', 'error'),
  );
}

// /supervise 或点结果里的按钮时，把这一页翻出来（实验室开关关着就不翻 —— 那一页压根没显示）
watch(() => sv.focusSeq, () => {
  if (!uiPrefs.state.supervisorOn) return;
  tab.value = 'watch'; collapsed.value = false;
});
watch(tab, (v) => {
  if (v !== 'watch') return;
  if (!sv.cases.length && !sv.loading) svLoad(store.state.chatId);
  superviseStore.loadTurns(store.state.chatId);          // 面板历史落在会话消息里，切过来要捞回来
});
// 换会话/换目录，清单可能就换了一份，跟着重读
watch(() => [store.state.chatId, props.cwd], () => {
  if (tab.value === 'watch') svLoad(store.state.chatId);
  superviseStore.loadTurns(store.state.chatId);
});
const openHist = reactive({});
const ctxOpen = ref(false);
const ctxLimit = ref(0);

/* 后台任务：切到该页才拉，页内每 5s 自动刷新 */
const bgTasks = ref([]);
const bgErr = ref('');
let bgTimer = null;

function bgState(s) {
  return { running: '运行中', exited: '已退出', 'exited-error': '异常退出', killed: '已终止', failed: '启动失败' }[s] || s;
}

function fmtDur(ms) {
  const sec = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, '0')}s`;
  return `${Math.floor(sec / 3600)}h${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}m`;
}

async function loadBg() {
  try {
    const res = await aiApi.getBackground();
    bgTasks.value = res?.tasks || [];
    bgErr.value = '';
  } catch (e) {
    bgErr.value = e?.response?.data?.message || '后台任务列表读取失败';
  }
}

async function killBg(id) {
  try {
    await aiApi.killBackground(id);
    await loadBg();
  } catch (e) {
    bgErr.value = e?.response?.data?.message || '终止失败';
  }
}

watch(tab, (t) => {
  if (t === 'bg') loadBg();
  if (t === 'agents') loadAgents();
});
// 切到「文件」页或换工作目录时刷新变更预览
watch(
  () => [tab.value, props.cwd, props.labGit],
  () => {
    if (tab.value === 'files' && props.labGit) loadChanges();
  }
);

/* 子智能体：列表 + 详情 + 人工下发。SSE 推来的实时进度合并进列表，
   所以主 Agent 正在派活时不用刷新也能看到步数在涨。 */
const agents = ref([]);
const openAgent = reactive({});
const agName = ref('');
const agTask = ref('');
const agBusy = ref(false);
let agTimer = null;

function agentState(s) {
  return { queued: '排队中', running: '运行中', done: '已交回', failed: '失败', killed: '已停止' }[s] || s;
}

function mergeLive(list) {
  const live = store.state.subagents || {};
  const byId = new Map(list.map((a) => [a.id, { ...a }]));
  for (const [id, l] of Object.entries(live)) {
    const row = byId.get(id) || { id, name: l.name, task: l.task || '', steps: 0, iter: 0, running: true };
    if (l.iter != null) row.iter = l.iter;
    if (l.phase) row.status = l.phase === 'tool' || l.phase === 'start' ? 'running' : l.phase;
    if (l.result) row.result_preview = String(l.result).slice(0, 160);
    if (l.error) row.error = l.error;
    row.running = row.status === 'running' || row.status === 'queued';
    byId.set(row.id, row);
  }
  return [...byId.values()].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
}

async function loadAgents() {
  try {
    const res = await aiApi.getSubagents(store.state.chatId || undefined);
    agents.value = mergeLive(Array.isArray(res) ? res : []);
  } catch (e) {
    /* 列表读不到不影响其它面板，静默 */
  }
}

async function toggleAgent(id) {
  openAgent[id] = !openAgent[id];
  if (!openAgent[id]) return;
  try {
    const d = await aiApi.getSubagent(id);
    const row = agents.value.find((a) => a.id === id);
    if (row && d) {
      row.task_full = d.task;
      row.result_full = d.result;
      row.error = d.error || row.error;
    }
  } catch (e) { /* 详情拉不到就退回列表里的摘要 */ }
}

async function killAgent(id) {
  const r = await aiApi.killSubagent(id);
  toast(r?.message || '已请求停止', 'info');
  await loadAgents();
}

async function delAgent(id) {
  if (!(await confirmDialog('删除这个子智能体的记录？正在跑的会被停掉。'))) return;
  const r = await aiApi.deleteSubagent(id);
  toast(r?.message || '已删除', 'success');
  delete openAgent[id];
  await loadAgents();
}

async function spawnAgent() {
  const task = agTask.value.trim();
  if (!task) return;
  agBusy.value = true;
  try {
    const r = await aiApi.spawnSubagent({ name: agName.value.trim(), task, chat_id: store.state.chatId || undefined, cwd: props.cwd || undefined });
    toast(r?.message || '已派出', 'success');
    agTask.value = '';
    agName.value = '';
    await loadAgents();
  } catch (e) {
    /* 拦截器已提示 */
  } finally {
    agBusy.value = false;
  }
}

// 主 Agent 派了新分身时立刻同步一次，避免等 5s 轮询
watch(
  () => Object.keys(store.state.subagents || {}).length,
  () => { if (tab.value === 'agents') loadAgents(); }
);

onMounted(() => {
  bgTimer = setInterval(() => { if (tab.value === 'bg' && !collapsed.value) loadBg(); }, 5000);
  agTimer = setInterval(() => { if (tab.value === 'agents' && !collapsed.value) loadAgents(); }, 5000);
});
onUnmounted(() => {
  if (bgTimer) clearInterval(bgTimer);
  if (agTimer) clearInterval(agTimer);
});

const approvalLabel = computed(
  () => ({ strict: '严格', default: '默认', exempt: '免除' }[props.approvalMode] || props.approvalMode)
);

function taskStatusLabel(s) {
  return TASK_STATUS.find((x) => x.value === s)?.label || s || '待办';
}

function taskIcon(status) {
  return {
    pending: 'fas fa-circle',
    doing: 'fas fa-spinner',
    done: 'fas fa-circle-check',
    failed: 'fas fa-circle-xmark',
  }[status] || 'fas fa-circle';
}

function fmt(n) {
  return formatTokens(n || 0);
}

// 打开「设定窗口」时回填当前窗口值，否则每次都要重填
watch(ctxOpen, (v) => {
  if (v) ctxLimit.value = Number(props.contextLimit) || 0;
});

function saveCtx() {
  emit('set-context', Number(ctxLimit.value) || 0);
  ctxOpen.value = false;
}

/** 历史卡里的 diff：服务端给的是 {t:'add'|'del'|'ctx', text}，也兼容 +/- 开头的字符串 */
function histLines(h) {
  return (h.diff || []).slice(0, 80).map((l) => {
    if (typeof l === 'string') {
      if (l.startsWith('+++') || l.startsWith('---')) return { kind: '', text: l };
      if (l.startsWith('+')) return { kind: 'add', text: l };
      if (l.startsWith('-')) return { kind: 'del', text: l };
      return { kind: '', text: l };
    }
    const k = String(l?.t || l?.kind || l?.type || '').toLowerCase();
    const text = String(l?.text ?? l?.line ?? '');
    if (k === 'add' || k === 'insert') return { kind: 'add', text: `+${text}` };
    if (k === 'del' || k === 'delete' || k === 'remove') return { kind: 'del', text: `-${text}` };
    return { kind: '', text };
  });
}

/** 撤销状态以 steps 里的活对象为准 */
function histUndone(h) {
  return !!(h.ref && h.ref.undone) || !!h.undone;
}
</script>

<style scoped>
/* 右栏：对齐参考图环境信息/任务清单面板 */
.dock {
  width: var(--dock-w, 300px);
  flex-shrink: 0;
  border-left: 0;
  background: transparent;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 10px 10px 10px 0;
  position: relative;
  transition: width var(--dur) var(--ease);
}
.dock.collapsed { width: 36px; padding-right: 0; }
/* 贴边临时探出：占排版位置把消息区推过去（浮层盖法在半透明主题下会让两层文字叠在一起） */
.dock.collapsed.peek { width: var(--dock-w, 300px); padding: 10px; }
.dock.collapsed.peek .dock-toggle { left: -14px; }
.dock-inner {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-soft);
  overflow: hidden;
}
.dock-toggle {
  position: absolute;
  left: -14px;
  top: 18px;
  z-index: 5;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text-2);
  display: grid;
  place-items: center;
}
.dock-toggle:hover { color: var(--text); background: var(--bg-hover); }
.dock.collapsed .dock-toggle { left: 2px; }
.dock-body {
  flex: 1;
  overflow: auto;
  padding: 12px;
}
h4 {
  margin: 0 0 8px;
  font-size: 11px;
  color: var(--text-3);
  font-weight: 600;
}
section + section,
section h4 + .card { margin-bottom: 14px; }
section h4 + h4 { margin-top: 14px; }
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
  justify-content: space-between;
  gap: 8px;
  padding: 6px 0;
  border-bottom: 1px solid var(--border-soft);
  font-size: 12px;
}
.row:last-child { border-bottom: 0; }
.grow { flex: 1; min-width: 0; }
/* 标签条右键菜单：勾选态用对勾方块，未选用空方块 */
.dock-tabs-menu { min-width: 168px; }
.dtm-hint { padding: 6px 10px 4px; font-size: 11px; color: var(--text-3); }
.dtm-sep { height: 1px; margin: 4px 2px; background: var(--border-soft); }
.dock-tabs-menu i.fa-square-check { color: var(--accent); }
.dock-tabs-menu i.fa-square { color: var(--text-3); }
.mono {
  font-family: var(--mono);
  font-size: 11px;
  word-break: break-all;
}
/* 后台任务列表 */
section h4 .refresh { margin-left: auto; }
.bg-item { padding: 8px 0; border-bottom: 1px solid var(--border-soft); }
.bg-item:last-child { border-bottom: 0; }
.bg-item .row { border-bottom: 0; padding: 2px 0; }
.bg-item .small { font-size: 11px; gap: 10px; justify-content: flex-start; }
.bg-tail {
  margin: 6px 0 0;
  padding: 6px 8px;
  max-height: 140px;
  overflow: auto;
  background: var(--bg-elev);
  border-radius: var(--radius-sm);
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-3);
  white-space: pre-wrap;
}
/* 子智能体面板 */
.ag-task {
  margin-top: 6px;
  padding: 6px 8px;
  background: var(--bg-elev);
  border-radius: var(--radius-sm);
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-2);
  white-space: pre-wrap;
  max-height: 120px;
  overflow: auto;
}
.ag-new {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ag-new .k-btn.primary { align-self: flex-start; }
.bg-tail.err-text { color: var(--danger); }
.badge.err {
  color: var(--danger);
  border-color: var(--danger-line);
}
.badge {
  font-size: 10px;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  color: var(--text-3);
}
.badge.on {
  color: var(--ok);
  border-color: var(--ok);
  background: var(--ok-soft);
}
/* 工作区变更预览 */
.sub-head { display: flex; align-items: center; gap: 8px; margin: 14px 0 6px; font-size: 13px; }
.sub-head button { margin-left: auto; }
.chg-row { padding: 4px 0; }
.chg-flag {
  font-family: var(--mono);
  font-size: 10px;
  min-width: 22px;
  text-align: center;
  color: var(--text-3);
}
.chg-flag.add { color: var(--ok); }
.chg-flag.del { color: var(--danger); }
.chg-flag.mod { color: var(--gold); }
.ellip { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chg-stat {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-3);
  white-space: pre-wrap;
  max-height: 120px;
  overflow: auto;
  padding: 6px 8px;
  background: var(--bg-elev);
  border-radius: var(--radius-sm);
}
.actions { display: flex; gap: 8px; margin-top: 8px; }
.tip { margin: 6px 0 0; font-size: 11px; opacity: 0.8; }
.task {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 8px 0;
  border-bottom: 1px solid var(--border-soft);
  font-size: 12px;
}
.task:last-child { border-bottom: 0; }
.task .t { flex: 1; }
.task.is-done .t {
  color: var(--text-3);
  text-decoration: line-through;
}
.task.is-failed .t { color: var(--danger); }
.file {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 6px 4px;
  font-size: 11px;
  color: var(--text-2);
}
.file .mono {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.chip {
  background: var(--bg-hover);
  border: 1px solid var(--border-soft);
  border-radius: 999px;
  padding: 3px 8px;
  font-size: 11px;
}
.insert-item {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-2);
  padding: 4px 0;
  border-bottom: 1px solid var(--border-soft);
}
.actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
.btn {
  border: 1px solid var(--border);
  background: var(--bg-hover);
  color: var(--text);
  border-radius: var(--radius-xs);
  padding: 6px 12px;
  font-size: 12px;
}
.btn:disabled { opacity: 0.45; }
.mini-select {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  color: var(--text-2);
  border-radius: 4px;
  font-size: 11px;
  padding: 2px 4px;
}

/* 监工页 */
.ck-tpl {
  margin: 8px 0 0;
  padding: 8px;
  max-height: 220px;
  overflow: auto;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-xs);
  background: var(--bg-panel);
  font-family: var(--mono);
  font-size: 11px;
  line-height: 1.6;
  white-space: pre-wrap;
  color: var(--text-2);
}
.ck-file { font-family: var(--mono); font-size: 11px; word-break: break-all; margin-bottom: 6px; }
.ck-case { padding: 6px 0; border-top: 1px solid var(--border-soft); }
.ck-case:first-of-type { border-top: 0; }
.ck-name { font-size: 12.5px; }
.ck-asserts { font-size: 11px; line-height: 1.6; margin-top: 2px; }
.ck-errs { margin-top: 8px; display: flex; flex-direction: column; gap: 3px; }
.ck-bad { color: var(--danger); font-size: 11.5px; }
.ck-run { padding: 6px 0; border-top: 1px solid var(--border-soft); }
.ck-run:first-child { border-top: 0; }
.ck-hd { display: flex; align-items: center; gap: 6px; font-size: 12.5px; }
.ck-hd .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ck-run.is-pass i { color: var(--ok, #3fb950); }
.ck-run.is-fail i { color: var(--danger); }
.ck-run.is-run i { color: var(--accent); }
.ck-line { font-size: 11.5px; line-height: 1.6; padding-left: 18px; word-break: break-word; }
.ck-line.bad { color: var(--danger); }
.ck-acts { margin-top: 8px; }

/* ---------------- 监工控制台 ---------------- */
.sup-console { display: flex; flex-direction: column; gap: 8px; margin-bottom: 10px; }
.sup-input {
  width: 100%;
  resize: vertical;
  min-height: 62px;
  padding: 8px 10px;
  border: 1px solid var(--border-soft);
  border-radius: 10px;
  background: var(--surface-2, transparent);
  color: var(--text);
  font: inherit;
  font-size: 12.5px;
  line-height: 1.6;
}
.sup-input:focus { outline: none; border-color: var(--accent); }
.sup-acts { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.sup-hint { font-size: 11px; color: var(--text-3); margin-left: auto; }
.sup-status { font-size: 11.5px; color: var(--text-3); line-height: 1.6; }
.sup-status i { margin-right: 5px; color: var(--accent); }
.sup-turns { display: flex; flex-direction: column; gap: 8px; }
.sup-turn { font-size: 12.5px; line-height: 1.65; word-break: break-word; }
.sup-turn.is-user {
  align-self: flex-end;
  max-width: 92%;
  padding: 6px 10px;
  border-radius: 10px;
  background: var(--surface-2, rgba(255, 255, 255, .06));
  color: var(--text-2);
}
.sup-turn.is-sup { padding: 2px 0 2px 9px; border-left: 2px solid var(--accent); }
.sup-turn.is-cmd { color: var(--text-2); }
.sup-turn.is-cmd .t { font-size: 11.5px; color: var(--text-3); }
.sup-turn.is-cmd pre {
  margin: 4px 0 0;
  padding: 6px 8px;
  max-height: 132px;
  overflow: auto;
  border-radius: 8px;
  background: var(--surface-2, rgba(255, 255, 255, .04));
  font-size: 11.5px;
  white-space: pre-wrap;
}
.sup-turn.is-note { font-size: 11.5px; color: var(--text-2); line-height: 1.7; }
.sup-turn.is-ok { color: var(--ok); }
.sup-turn.is-bad { color: var(--danger); }
.s-steps { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 4px; }
.s-chip {
  padding: 1px 6px;
  border: 1px solid var(--border-soft);
  border-radius: 999px;
  font-size: 11px;
  color: var(--text-3);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.s-chip.bad { color: var(--danger); border-color: var(--danger); }
.s-chip.note { border-style: dashed; }
.s-text { color: var(--text); }
.s-caret { color: var(--accent); animation: sup-blink 1s steps(2) infinite; }
@keyframes sup-blink { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
.sup-manual { margin-top: 12px; border-top: 1px solid var(--border-soft); padding-top: 8px; }
.sup-manual > summary { cursor: pointer; font-size: 11.5px; color: var(--text-3); }
@media (prefers-reduced-motion: reduce) { .s-caret { animation: none; } }
</style>
