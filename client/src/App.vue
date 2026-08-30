<template>
  <div id="app" :class="themeClass">
    <StarField />
    <header v-show="!immersive" class="navbar">
      <div class="nav-left">
        <img :src="settings.site_icon || '/imgs/logo.png'" alt="site icon" class="site-icon">
        <span class="site-name">{{ settings.site_name || 'KHARNESS' }}</span>
      </div>

      <nav class="nav-center">
        <router-link to="/usage" class="nav-btn" exact-active-class="active"><i class="fas fa-chart-column"></i> 用量统计</router-link>
        <router-link to="/control" class="nav-btn" exact-active-class="active"><i class="fas fa-sliders"></i> 控制台</router-link>
        <router-link to="/" class="nav-btn" exact-active-class="active"><i class="fas fa-comments"></i> 聊天</router-link>
        <router-link to="/models" class="nav-btn" exact-active-class="active"><i class="fas fa-list-check"></i> 模型列表</router-link>
        <router-link to="/admin-models" class="nav-btn" exact-active-class="active"><i class="fas fa-screwdriver-wrench"></i> 管理模型</router-link>
        <router-link to="/trace" class="nav-btn" exact-active-class="active"><i class="fas fa-timeline"></i> 轨迹</router-link>
        <router-link to="/settings" class="nav-btn" exact-active-class="active"><i class="fas fa-gear"></i> 设置</router-link>
      </nav>

      <div class="nav-right">
        <button class="theme-toggle" @click="toggleTheme" :title="isDark ? '切换亮色' : '切换暗色'">
          <i :class="isDark ? 'fas fa-sun' : 'fas fa-moon'"></i>
        </button>
      </div>
    </header>

    <main class="main-content" :class="{ 'main-immersive': immersive }">
      <router-view v-slot="{ Component }">
        <Transition name="page-fade" mode="out-in">
          <KeepAlive include="ChatPage">
            <component :is="Component" />
          </KeepAlive>
        </Transition>
      </router-view>
    </main>

    <!-- 页脚已移除 -->

    <!-- OOBE 首次启动向导（全屏） -->
    <Teleport to="body">
      <Transition name="page-fade">
        <div v-if="oobeOpen" class="oobe-overlay">
          <div class="oobe-full">
            <div class="oobe-head">
              <span class="oobe-dots">
                <i v-for="n in 4" :key="n" class="fas" :class="n < oobeStep ? 'fa-circle' : n === oobeStep ? 'fa-circle-dot' : 'fa-circle-notch'"></i>
              </span>
              <span class="oobe-title">{{ oobeStep === 1 ? '欢迎使用 KHarness' : oobeStep === 2 ? '导入提供商与模型' : oobeStep === 3 ? '外观偏好' : '学习使用本工具' }}</span>
            </div>

            <!-- 第 1 步：选择系统 -->
            <div v-if="oobeStep === 1" class="oobe-body">
              <p class="oobe-desc">选择你的操作系统，向导将按此配置默认终端与路径风格（后续界面中的示例文案也会随之适配）。</p>
              <div class="oobe-os-row">
                <button class="oobe-os-card" :class="{ active: oobePlatform === 'windows' }" @click="oobePlatform = 'windows'">
                  <i class="fab fa-windows"></i>
                  <b>Windows</b>
                  <span>默认终端 cmd；路径如 C:\Users\…，分隔符为 \</span>
                </button>
                <button class="oobe-os-card" :class="{ active: oobePlatform === 'linux' }" @click="oobePlatform = 'linux'">
                  <i class="fab fa-linux"></i>
                  <b>Linux</b>
                  <span>默认终端 bash；路径如 /home/…，分隔符为 /</span>
                </button>
              </div>
              <p class="oobe-hint">检测到实际运行平台：{{ oobeActual === 'windows' ? 'Windows' : 'Linux' }}（选择不一致时，默认终端设置仅在平台匹配时写入）</p>
            </div>

            <!-- 第 2 步：提供商与模型 -->
            <div v-else-if="oobeStep === 2" class="oobe-body">
              <p class="oobe-desc">至少导入一个提供商和一个模型后即可开始使用（之后可随时在「管理模型」中增删）。</p>
              <div class="oobe-field"><label>提供商名称 *</label><input v-model="oobeProvider.name" placeholder="如：OpenAI / DeepSeek / 硅基流动"></div>
              <div class="oobe-field"><label>BaseURL（截止到 /v1）*</label><input v-model="oobeProvider.base_url" placeholder="https://api.example.com/v1"></div>
              <div class="oobe-field"><label>API Key *</label><input v-model="oobeProvider.api_key" placeholder="sk-..."></div>
              <div class="oobe-models">
                <div class="oobe-models-head">
                  <label>模型（至少 1 个）</label>
                  <button class="btn btn-small" @click="oobeModels.push({ model_id: '', display_name: '' })"><i class="fas fa-plus"></i> 加一行</button>
                </div>
                <div v-for="(m, i) in oobeModels" :key="i" class="oobe-model-row">
                  <input v-model="m.model_id" placeholder="模型 ID，如 gpt-4o-mini">
                  <input v-model="m.display_name" placeholder="别名（可空）">
                  <button v-if="oobeModels.length > 1" class="btn btn-small del" @click="oobeModels.splice(i, 1)"><i class="fas fa-trash"></i></button>
                </div>
              </div>
              <p v-if="oobeErr" class="oobe-err"><i class="fas fa-circle-exclamation"></i> {{ oobeErr }}</p>
            </div>

            <!-- 第 3 步：主题 -->
            <div v-else-if="oobeStep === 3" class="oobe-body">
              <p class="oobe-desc">选择界面主题（默认亮色，之后可随时用右上角按钮切换）。</p>
              <div class="oobe-os-row">
                <button class="oobe-os-card" :class="{ active: !isDark }" @click="applyOobeTheme(false)">
                  <i class="fas fa-sun"></i><b>亮色</b><span class="oobe-theme-preview light">Aa 背景 #faf0eb</span>
                </button>
                <button class="oobe-os-card" :class="{ active: isDark }" @click="applyOobeTheme(true)">
                  <i class="fas fa-moon"></i><b>暗色</b><span class="oobe-theme-preview dark">Aa 背景 #131417</span>
                </button>
              </div>
            </div>

            <!-- 第 4 步：交互式学习 -->
            <div v-else class="oobe-body">
              <p class="oobe-desc">选择想了解的功能，完成后将进入「引导模式」：高亮对应按钮并讲解，你可以随时点击它们亲自尝试。可全不选，以后也能在「设置」里重新学习。</p>
              <div class="oobe-learn-row">
                <button class="oobe-os-card" :class="{ active: oobeLearn.models }" @click="oobeLearn.models = !oobeLearn.models">
                  <i class="fas fa-cubes"></i><b>添加 / 删除外置 API 与管理模型</b>
                  <span>提供商与模型的增删改、批量导入、可用性测试与 Ping</span>
                </button>
                <button class="oobe-os-card" :class="{ active: oobeLearn.playground }" @click="oobeLearn.playground = !oobeLearn.playground">
                  <i class="fas fa-comments"></i><b>Playground 主要按钮与控件</b>
                  <span>模型切换、Agent、Plan、命令补全输入框、模型设置</span>
                </button>
                <button class="oobe-os-card" :class="{ active: oobeLearn.settings }" @click="oobeLearn.settings = !oobeLearn.settings">
                  <i class="fas fa-gear"></i><b>后台设置与 AGENTS.md</b>
                  <span>默认 Shell、界面字体、敏感数据脱敏、AGENTS.md 长期记忆</span>
                </button>
              </div>
            </div>

            <div class="oobe-foot">
              <button v-if="oobeStep === 2" class="oobe-skip" @click="skipProviderStep">跳过此步（暂不配置，稍后可在「管理模型」中添加）</button>
              <span style="flex:1"></span>
              <button v-if="oobeStep > 1" class="btn" @click="oobeStep--">上一步</button>
              <button v-if="oobeStep < 4" class="btn btn-primary" @click="oobeNext">下一步</button>
              <button v-else class="btn btn-primary" :disabled="oobeSaving" @click="finishOobe">
                <i v-if="oobeSaving" class="fas fa-spinner fa-spin"></i> 完成并进入主页
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- 引导模式（spotlight 教程） -->
    <Teleport to="body">
      <Transition name="page-fade">
        <div v-if="tourActive && tourRect" class="tour-layer">
          <div class="tour-spot" :style="tourSpotStyle"></div>
          <div class="tour-tip" :style="tourTipStyle">
            <div class="tour-tip-title"><i class="fas fa-hand-pointer"></i> {{ tourSteps[tourIdx].title }}</div>
            <div class="tour-tip-text">{{ tourSteps[tourIdx].text }}</div>
            <div class="tour-tip-hint">可以现在点击它亲自尝试；本引导不会替你操作</div>
            <div class="tour-tip-foot">
              <span class="tour-tip-idx">{{ tourIdx + 1 }} / {{ tourSteps.length }}</span>
              <span style="flex:1"></span>
              <button class="btn btn-small" @click="endTour">跳过引导</button>
              <button v-if="tourIdx > 0" class="btn btn-small" @click="tourGo(tourIdx - 1)">上一步</button>
              <button class="btn btn-small btn-primary" @click="tourGo(tourIdx + 1)">{{ tourIdx + 1 < tourSteps.length ? '下一步' : '完成' }}</button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <Teleport to="body">
      <TransitionGroup name="toast" tag="div" class="toast-container">
        <div v-for="item in toastState.items" :key="item.id" :class="['toast-item', 'toast-' + item.type]">
          <i :class="'fas ' + toastIcons[item.type]"></i>
          <span>{{ item.message }}</span>
        </div>
      </TransitionGroup>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, computed, reactive, onMounted, onUnmounted, provide, watch, nextTick } from 'vue';
import { useRouter } from 'vue-router';
import { settingsApi, aiApi } from './api';
import StarField from './components/StarField.vue';
import { toastState, toastIcons } from './utils/toast';
import { setPlatform, agentsFilePath, projectAgentsExample, isActuallyWin } from './utils/platformText';

const router = useRouter();
const isDark = ref(false);
const settings = ref({});

// ---------- OOBE 首次启动向导 ----------
const oobeOpen = ref(false);
const oobeStep = ref(1);
const oobePlatform = ref('windows');
const oobeActual = ref('windows');
const oobeProvider = ref({ name: '', base_url: '', api_key: '' });
const oobeModels = ref([{ model_id: '', display_name: '' }]);
const oobeSaving = ref(false);
const oobeErr = ref('');
const oobeLearn = reactive({ models: true, playground: true, settings: true });
const oobeProviderSkipped = ref(false);

// 仅跳过「提供商与模型」这一步，继续向导
function skipProviderStep() {
  oobeErr.value = '';
  oobeProviderSkipped.value = true;
  oobeStep.value = 3;
}

function applyOobeTheme(dark) {
  isDark.value = dark;
  localStorage.setItem('theme', dark ? 'dark' : 'light');
}

function oobeNext() {
  oobeErr.value = '';
  if (oobeStep.value === 1) {
    setPlatform(oobePlatform.value);
    oobeStep.value = 2;
    return;
  }
  if (oobeStep.value === 2) {
    const p = oobeProvider.value;
    if (!p.name.trim()) { oobeErr.value = '请填写提供商名称'; return; }
    if (!/^https?:\/\//i.test(p.base_url.trim())) { oobeErr.value = 'BaseURL 需以 http(s):// 开头'; return; }
    if (!p.api_key.trim()) { oobeErr.value = '请填写 API Key'; return; }
    const models = oobeModels.value.filter(m => m.model_id.trim());
    if (!models.length) { oobeErr.value = '至少填写一个模型 ID'; return; }
    oobeProviderSkipped.value = false; // 返回本步补填后按正常流程保存
    oobeStep.value = 3;
    return;
  }
  if (oobeStep.value === 3) {
    oobeStep.value = 4; // 主题已在点击卡片时即时应用，无需校验
  }
}

async function finishOobe() {
  oobeSaving.value = true;
  oobeErr.value = '';
  const skipProvider = oobeProviderSkipped.value;
  let tourSteps = [];
  if (oobeLearn.models) tourSteps.push(...TOUR_MODELS());
  if (oobeLearn.playground) tourSteps.push(...TOUR_PLAYGROUND());
  if (oobeLearn.settings) tourSteps.push(...TOUR_SETTINGS());
  try {
    await aiApi.finishOobe({
      skip: skipProvider,
      platform: oobePlatform.value,
      provider: skipProvider ? null : oobeProvider.value,
      models: skipProvider ? [] : oobeModels.value.filter(m => m.model_id.trim()).map(m => ({ model_id: m.model_id.trim(), display_name: m.display_name.trim() || m.model_id.trim() }))
    });
    setPlatform(oobePlatform.value);
    oobeOpen.value = false;
    if (tourSteps.length) startTour(tourSteps);
  } catch (e) {
    oobeErr.value = e.response?.data?.message || '保存失败，请检查填写内容';
  } finally { oobeSaving.value = false; }
}

// ---------- 引导模式（spotlight 教程） ----------
// 文案按 OOBE 选择的系统偏好本地化（路径示例/分隔符），Shell 相关说明按实际运行平台提示
const TOUR_MODELS = () => [
  { route: '/admin-models', sel: '[data-tour="prov-add"]', title: '添加提供商（外置 API）', text: '点击「新增提供商」，填写名称、BaseURL（截止到 /v1）与 API Key 即可接入一个外部 API；列表中可随时编辑或删除。' },
  { route: '/admin-models', sel: '[data-tour="model-add"]', title: '添加 / 删除模型', text: '「新增模型」单个添加（支持从接口拉取模型列表单选）；「批量添加」可勾选多个并逐个设置别名与价格；行内「删除」删单个，勾选最左侧复选框后可「批量删除」。' },
  { route: '/admin-models', sel: '[data-tour="model-test"]', title: '可用性测试与 Ping', text: '「测试全部模型」并发检测可用性与首字延迟；右上角还可 Ping 提供商域名验证连通性（可自定义超时）。' }
];
const TOUR_PLAYGROUND = () => [
  { route: '/', sel: '[data-tour="pg-model-btn"]', title: '切换模型', text: '点击可打开模型选择窗口（按提供商分组）；「/pool」可配置模型池，开启自动模式后按池顺序自动尝试。' },
  { route: '/', sel: '[data-tour="pg-agent"]', title: 'Agent 开关', text: '开启后 AI 可以执行命令、读写文件（危险操作需人工审批，/mode bypass 可自动放行）。' },
  { route: '/', sel: '[data-tour="pg-plan"]', title: 'Plan 任务模式', text: '开启后 AI 会先输出 <plan> 计划，右侧任务面板实时跟踪每项任务的进行状态。' },
  { route: '/', sel: '[data-tour="pg-input"]', title: '输入框', text: 'Enter 发送；输入 / 唤起命令补全（/model /mode /context 等，↑↓ 选择、Tab 补全）；右下角可拖拽调整高度。' },
  { route: '/', sel: '[data-tour="pg-settings-btn"]', title: '模型设置', text: '温度、频率/存在惩罚、联网搜索与搜索策略、思考强度、最大上下文，以及言论审查词汇列表（会话级保存）。' }
];
const TOUR_SETTINGS = () => [
  { route: '/settings', sel: '[data-tour="set-shell"]', title: '默认 Shell', text: `Agent 执行命令使用的终端。下方候选列表按「实际运行平台」显示（当前宿主是 ${isActuallyWin() ? 'Windows' : 'Linux'}，与向导中的界面偏好是两回事）：Windows 默认 cmd、Linux 默认 bash，也可手动输入完整路径。` },
  { route: '/settings', sel: '[data-tour="set-agents"]', title: 'AGENTS.md 长期记忆', text: `在指定位置放置 AGENTS.md（或 AGENT.md），内容自动注入每次 Agent 对话。全局路径示例：${agentsFilePath()}；项目级示例：${projectAgentsExample()}。详见聊天页「帮助」菜单。` },
  { route: '/settings', sel: '[data-tour="set-secrets"]', title: '敏感数据脱敏', text: '配置正则规则后，工具输出（如 read_file 读到密钥）在进入 AI 上下文前自动打码。' },
  { route: '/settings', sel: '[data-tour="set-font"]', title: '界面字体', text: '全局字体设置：可选常见字体、扫描本机字体，或手动输入字体名；仅对当前浏览器生效。' }
];

const tourActive = ref(false);
const tourSteps = ref([]);
const tourIdx = ref(0);
const tourRect = ref(null);
let tourRaf = null;

const tourSpotStyle = computed(() => {
  const r = tourRect.value || { top: 0, left: 0, width: 0, height: 0 };
  return { top: r.top + 'px', left: r.left + 'px', width: r.width + 'px', height: r.height + 'px' };
});
const tourTipStyle = computed(() => {
  const r = tourRect.value || { top: 0, left: 0, width: 0, height: 0 };
  const tipW = 340, tipH = 190;
  let top = r.top + r.height + 14;
  if (top + tipH > window.innerHeight - 12) top = Math.max(12, r.top - tipH - 14);
  let left = Math.min(Math.max(12, r.left), window.innerWidth - tipW - 12);
  return { top: top + 'px', left: left + 'px', width: tipW + 'px' };
});

async function startTour(steps) {
  if (!steps || !steps.length) return;
  tourSteps.value = steps;
  tourIdx.value = 0;
  tourActive.value = true;
  await tourLocate();
}
async function tourLocate() {
  const step = tourSteps.value[tourIdx.value];
  if (!step) return;
  if (router.currentRoute.value.path !== step.route) {
    await router.push(step.route).catch(() => {});
    await new Promise(r => setTimeout(r, 420));
  }
  const find = () => {
    const el = document.querySelector(step.sel);
    if (el) {
      const r = el.getBoundingClientRect();
      tourRect.value = { top: r.top, left: r.left, width: r.width, height: r.height };
      return true;
    }
    return false;
  };
  await nextTick();
  if (!find()) {
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 120));
      if (find()) break;
    }
  }
  if (!tourRaf) {
    const loop = () => {
      if (!tourActive.value) { tourRaf = null; return; }
      const s = tourSteps.value[tourIdx.value];
      if (s) {
        const el = document.querySelector(s.sel);
        if (el) {
          const r = el.getBoundingClientRect();
          tourRect.value = { top: r.top, left: r.left, width: r.width, height: r.height };
        }
      }
      tourRaf = requestAnimationFrame(loop);
    };
    tourRaf = requestAnimationFrame(loop);
  }
}
function tourGo(i) {
  if (i >= tourSteps.value.length) { endTour(); return; }
  if (i < 0) i = 0;
  tourIdx.value = i;
  tourLocate();
}
function endTour() {
  tourActive.value = false;
  if (tourRaf) { cancelAnimationFrame(tourRaf); tourRaf = null; }
}

const themeClass = computed(() => isDark.value ? 'theme-dark' : 'theme-light');

// 沉浸模式（聊天页全屏）：隐藏导航/页脚，内容铺满视口；由聊天页按钮切换
const immersive = ref(sessionStorage.getItem('kh_immersive') === '1');
const onImmersive = (e) => { immersive.value = !!e.detail; };

const toggleTheme = () => {
  isDark.value = !isDark.value;
  localStorage.setItem('theme', isDark.value ? 'dark' : 'light');
};

provide('settings', settings);

onMounted(async () => {
  window.addEventListener('kh-immersive', onImmersive);
  const savedTheme = localStorage.getItem('theme');
  if (savedTheme) {
    isDark.value = savedTheme === 'dark';
  } else {
    isDark.value = window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  try {
    const res = await settingsApi.getAll();
    settings.value = res.data;
  } catch (e) {
    console.error('Failed to load settings');
  }

  // OOBE：仅在服务端标记为未完成时弹出（首次启动）；默认亮色
  try {
    const oobe = await aiApi.getOobe();
    oobeActual.value = oobe.data.actual || 'windows';
    oobePlatform.value = oobe.data.platform || oobeActual.value;
    if (!oobe.data.done) {
      isDark.value = false; // OOBE 默认浅色模式
      oobeOpen.value = true;
    }
  } catch (e) { /* 接口失败不阻塞 */ }
});

onUnmounted(() => {
  window.removeEventListener('kh-immersive', onImmersive);
  if (tourRaf) cancelAnimationFrame(tourRaf);
});

watch(isDark, (val) => {
  document.documentElement.classList.toggle('theme-dark', val);
  document.documentElement.classList.toggle('theme-light', !val);
});
</script>

<style>
@import url('https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css');
</style>

<style scoped>
/* ===== OOBE 首次启动向导（全屏） ===== */
.oobe-overlay{position:fixed;inset:0;z-index:50000;background:var(--bg-base);overflow-y:auto}
.oobe-full{min-height:100%;max-width:680px;margin:0 auto;padding:6vh 1.5rem 3rem;display:flex;flex-direction:column;justify-content:flex-start}
.oobe-head{display:flex;align-items:center;gap:.8rem;margin-bottom:1.6rem}
.oobe-dots{display:flex;gap:.5rem;color:var(--primary-gold);font-size:.7rem}
.oobe-title{font-size:1.5rem;font-weight:700;color:var(--primary-blue)}
.oobe-body{background:var(--bg-card);border:1px solid var(--border-light);border-radius:20px;padding:1.6rem 1.8rem;box-shadow:var(--shadow-soft)}
.oobe-desc{color:var(--text-muted);font-size:.92rem;line-height:1.7;margin-bottom:1.2rem}
.oobe-hint{color:var(--text-muted);font-size:.78rem;margin-top:1rem}
.oobe-os-row{display:flex;gap:1rem;flex-wrap:wrap}
.oobe-os-card{flex:1;min-width:210px;border:2px solid var(--border-light);border-radius:14px;background:var(--bg-card-solid);cursor:pointer;padding:1.1rem 1.2rem;text-align:left;display:flex;flex-direction:column;gap:.4rem;color:var(--text-dark);transition:all .15s}
.oobe-os-card i{font-size:1.6rem;color:var(--primary-gold)}
.oobe-os-card span{color:var(--text-muted);font-size:.78rem;line-height:1.55}
.oobe-os-card.active{border-color:var(--primary-blue);background:var(--accent-pink)}
.oobe-field{margin-bottom:.9rem}
.oobe-field label{display:block;font-size:.88rem;color:var(--primary-blue);margin-bottom:.35rem;font-weight:500}
.oobe-field input{width:100%;box-sizing:border-box;padding:.6rem .85rem;border:2px solid var(--border-light);border-radius:10px;background:var(--bg-base);color:var(--text-dark);outline:none}
.oobe-field input:focus{border-color:var(--primary-gold)}
.oobe-models{margin-top:.5rem}
.oobe-models-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:.45rem}
.oobe-models-head label{font-size:.88rem;color:var(--primary-blue);font-weight:500}
.oobe-model-row{display:flex;gap:.45rem;margin-bottom:.45rem}
.oobe-model-row input{flex:1;min-width:0;padding:.55rem .65rem;border:2px solid var(--border-light);border-radius:10px;background:var(--bg-base);color:var(--text-dark);outline:none;font-size:.88rem}
.oobe-model-row input:focus{border-color:var(--primary-gold)}
.oobe-model-row .del{color:#c0392b}
.oobe-err{color:#c0392b;font-size:.85rem;margin-top:.7rem}
.oobe-err i{margin-right:.3rem}
.oobe-theme-preview{font-size:.75rem !important;padding:.18rem .55rem;border-radius:6px;display:inline-block}
.oobe-theme-preview.light{background:#faf0eb;color:#3a322e;border:1px solid #e6d6ce}
.oobe-theme-preview.dark{background:#131417;color:#e8eaee;border:1px solid #2a2d34}
.oobe-learn-row{display:flex;flex-direction:column;gap:.8rem}
.oobe-foot{display:flex;align-items:center;gap:.7rem;margin-top:1.4rem}
.oobe-skip{border:none;background:none;color:var(--text-muted);font-size:.8rem;cursor:pointer;text-decoration:underline;font-family:inherit;padding:.3rem 0}
.oobe-skip:hover{color:var(--primary-gold)}

/* ===== 引导模式（spotlight 教程，绿色扁平风） ===== */
.tour-layer{position:fixed;inset:0;z-index:60000;pointer-events:none}
.tour-spot{position:fixed;border-radius:12px;box-shadow:0 0 0 3px #4caf50, 0 0 0 7px rgba(76,175,80,.18);transition:all .25s ease;pointer-events:none}
.tour-tip{position:fixed;background:#e8f6e9;border:1.5px solid #66bb6a;border-radius:14px;box-shadow:none;padding:1rem 1.1rem;pointer-events:auto;display:flex;flex-direction:column;gap:.5rem;color:#1b5e20}
.tour-tip-title{font-weight:600;color:#2e7d32;font-size:.95rem}
.tour-tip-title i{color:#4caf50;margin-right:.35rem}
.tour-tip-text{color:#1b5e20;font-size:.85rem;line-height:1.65}
.tour-tip-hint{color:#558b2f;font-size:.74rem}
.tour-tip-foot{display:flex;align-items:center;gap:.45rem;margin-top:.2rem}
.tour-tip-idx{color:#558b2f;font-size:.75rem;margin-right:.2rem}
.tour-tip-foot .btn{background:#fff;color:#2e7d32;border:1px solid #a5d6a7}
.tour-tip-foot .btn:hover{background:#c8e6c9}
.tour-tip-foot .btn-primary{background:#4caf50;color:#fff;border-color:#4caf50}
.tour-tip-foot .btn-primary:hover{background:#43a047}
</style>
