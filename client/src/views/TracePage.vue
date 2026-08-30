<template>
  <div class="page">
    <div class="page-header" v-reveal>
      <h2><i class="fas fa-timeline"></i> 轨迹记录（Tracing）</h2>
      <span class="hint">完整思维链：每次交互的推理、工具调用参数与结果，用于调试 Prompt 和定位问题</span>
    </div>

    <!-- 检索：关键词/正则 + 类型 + 模型；点击结果跳转聊天页定位原始记录 -->
    <div class="trace-searchbar" v-reveal>
      <div class="trace-search-row">
        <input v-model="sq" class="trace-search-input" :placeholder="useRegex ? '正则表达式，留空=按分类/模型筛选' : '关键词，留空=按分类/模型筛选'" @keydown.enter="doSearch">
        <button class="btn btn-small" :class="useRegex ? 'btn-primary' : 'btn-secondary'" @click="useRegex = !useRegex" title="切换关键词/正则模式">
          <i class="fas fa-code"></i> {{ useRegex ? '正则' : '关键词' }}
        </button>
        <select v-model="stype" class="trace-select">
          <option value="all">全部分类</option>
          <option value="user">用户消息</option>
          <option value="assistant">AI 回复</option>
          <option value="tool">工具调用</option>
          <option value="skill">Skill</option>
        </select>
        <select v-model="smodel" class="trace-select">
          <option value="">全部模型</option>
          <option v-for="m in modelOptions" :key="m.id" :value="m.display_name">{{ m.display_name }}</option>
        </select>
        <button class="btn btn-small btn-primary" :disabled="searching" @click="doSearch">
          <i class="fas fa-magnifying-glass"></i> 筛选
        </button>
      </div>
      <div v-if="results" class="trace-results">
        <div v-if="!results.length" class="trace-res-empty">无匹配结果</div>
        <div v-for="r in results" :key="r.msg_id" class="trace-res" @click="gotoResult(r)">
          <div class="trace-res-meta">
            <span class="trace-res-title">{{ r.title }}</span>
            <span class="trace-res-field">{{ r.field }}</span>
            <span v-if="r.model_name" class="trace-res-model">{{ r.model_name }}</span>
            <span class="trace-res-time">{{ shortTime(r.created_at) }}</span>
          </div>
          <div class="trace-res-snippet">{{ r.snippet }}</div>
        </div>
        <div class="trace-res-tip"><i class="fas fa-arrow-pointer"></i> 点击结果跳转聊天页并定位高亮原始记录</div>
      </div>
    </div>

    <div class="trace-layout" v-reveal>
      <!-- 左侧：项目/会话树 -->
      <aside class="trace-side">
        <input v-model="search" class="trace-search" placeholder="搜索会话…">
        <div class="trace-scroll">
          <div class="trace-group">
            <div class="trace-group-head"><i class="fas fa-comments"></i> 自由会话</div>
            <div
              v-for="c in freeChats" :key="c.id"
              class="trace-chat" :class="{ active: c.id === activeId }"
              @click="load(c.id)"
            >
              <div class="trace-chat-title">{{ c.title || '未命名会话' }}</div>
              <div class="trace-chat-meta">{{ c.message_count }} 条 · {{ shortTime(c.updated_at) }}</div>
            </div>
          </div>
          <div v-for="p in filteredProjects" :key="p.id" class="trace-group">
            <div class="trace-group-head project" :title="p.root_path">
              <i class="fas fa-folder"></i> {{ p.name }}
              <span class="cnt">{{ chatsOf(p.id).length }}</span>
            </div>
            <div
              v-for="c in chatsOf(p.id)" :key="c.id"
              class="trace-chat" :class="{ active: c.id === activeId }"
              @click="load(c.id)"
            >
              <div class="trace-chat-title">{{ c.title || '未命名会话' }}</div>
              <div class="trace-chat-meta">{{ c.message_count }} 条 · {{ shortTime(c.updated_at) }}</div>
            </div>
          </div>
          <div v-if="!chats.length && !projects.length" class="trace-empty">暂无会话记录</div>
        </div>
      </aside>

      <!-- 右侧：思维链 -->
      <div class="trace-main">
        <div v-if="!activeId" class="trace-empty-main">
          <i class="fas fa-timeline"></i>
          <p>从左侧选择一个会话查看完整轨迹</p>
        </div>
        <template v-else>
          <div class="trace-title-bar">
            <span class="trace-title">{{ activeTitle }}</span>
            <span v-if="activeProjectName" class="trace-proj"><i class="fas fa-folder"></i> {{ activeProjectName }}</span>
          </div>
          <div class="trace-timeline">
            <div v-for="(m, i) in messages" :key="i" class="tl-msg" :class="'role-' + m.role">
              <div class="tl-role">
                <i :class="m.role === 'user' ? 'fas fa-user' : 'fas fa-robot'"></i>
                {{ m.role === 'user' ? '用户' : 'AI' }}
                <span v-if="m.model_name" class="tl-model">{{ m.model_name }}</span>
                <span class="tl-time">{{ shortTime(m.created_at) }}</span>
              </div>
              <!-- 推理（思维链） -->
              <div v-if="m.reasoning" class="tl-reason">
                <div class="tl-reason-head"><i class="fas fa-brain"></i> 思维链（reasoning）</div>
                <pre>{{ m.reasoning }}</pre>
              </div>
              <!-- 工具调用链 -->
              <div v-if="m.steps && m.steps.length" class="tl-steps">
                <div v-for="(s, si) in m.steps" :key="si" class="tl-step">
                  <template v-if="s.type === 'tool'">
                    <span class="tl-step-tool"><i class="fas fa-gear"></i> {{ s.name }}</span>
                    <pre class="tl-args">{{ pretty(s.args) }}</pre>
                  </template>
                  <div v-else-if="s.type === 'result'" class="tl-result" :class="{ err: !!s.error }">
                    <span class="tl-step-label">{{ s.error ? '✗ 结果' : '✓ 结果' }}</span>
                    <pre>{{ String(s.error || s.output || '(无输出)').substring(0, 3000) }}</pre>
                  </div>
                  <div v-else-if="s.type === 'note'" class="tl-note"><i class="fas fa-circle-info"></i> {{ s.message }}</div>
                </div>
              </div>
              <!-- 正文 -->
              <div class="tl-content">{{ visible(m.content) || (m.role === 'assistant' && m.steps?.length ? '（仅工具调用）' : '') }}</div>
            </div>
            <div v-if="!messages.length" class="trace-empty-main"><p>该会话暂无消息</p></div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { aiApi } from '../api';

const router = useRouter();

const projects = ref([]);
const chats = ref([]);
const search = ref('');
const activeId = ref(null);
const activeTitle = ref('');
const activeProjectName = ref('');
const messages = ref([]);

/* 检索 */
const sq = ref('');
const stype = ref('all');
const smodel = ref('');
const useRegex = ref(false);
const searching = ref(false);
const results = ref(null);
const modelOptions = ref([]);

async function doSearch() {
  if (searching.value) return;
  searching.value = true;
  try {
    const res = await aiApi.searchTrace({ q: sq.value.trim(), type: stype.value, model: smodel.value, regex: useRegex.value ? 1 : 0 });
    results.value = res.data;
  } catch (e) {
    results.value = [];
  } finally {
    searching.value = false;
  }
}

function gotoResult(r) {
  router.push({ path: '/', query: { chat: r.chat_id, msg: r.msg_id } });
}

const q = computed(() => search.value.trim().toLowerCase());
const freeChats = computed(() => chats.value.filter(c => !c.project_id && (!q.value || (c.title || '').toLowerCase().includes(q.value))));
const chatsOf = (pid) => chats.value.filter(c => c.project_id === pid && (!q.value || (c.title || '').toLowerCase().includes(q.value)));
const filteredProjects = computed(() => projects.value.filter(p => chatsOf(p.id).length || !q.value));

const shortTime = (t) => String(t || '').replace('T', ' ').substring(5, 16);
const pretty = (args) => { try { return JSON.stringify(args, null, 2); } catch { return String(args); } };
const visible = (s) => String(s || '').replace(/\[\[img:[a-f0-9]+\]\]/g, '[图片]');

async function loadProjects() {
  try { projects.value = (await aiApi.getProjects()).data; } catch (e) { /* 静默 */ }
}
async function loadChats() {
  try { chats.value = (await aiApi.getChats()).data; } catch (e) { /* 静默 */ }
}
async function load(id) {
  activeId.value = id;
  try {
    const res = await aiApi.getChat(id);
    activeTitle.value = res.data.chat.title || `会话 #${id}`;
    const proj = projects.value.find(p => p.id === res.data.chat.project_id);
    activeProjectName.value = proj?.name || '';
    messages.value = res.data.messages || [];
  } catch (e) { /* 静默 */ }
}

onMounted(async () => {
  await Promise.all([loadProjects(), loadChats()]);
  try { modelOptions.value = (await aiApi.getModels()).data; } catch (e) { /* 静默 */ }
});
</script>

<style scoped>
.page{width:100%;margin:0 auto;display:flex;flex-direction:column;height:100%;min-height:420px}
.page-header{display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:.5rem;margin-bottom:1rem}
.page-header h2{margin:0;color:var(--text-dark);font-size:1.3rem}
.page-header h2 i{color:var(--primary-gold);margin-right:.4rem}
.hint{color:var(--text-muted);font-size:.78rem}

.trace-layout{display:flex;gap:14px;flex:1;min-height:0}
.trace-searchbar{background:var(--bg-card);border:1px solid var(--border-light);border-radius:14px;padding:.7rem .9rem;margin-bottom:.8rem}
.trace-search-row{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
.trace-search-input{flex:1;min-width:240px;border:2px solid var(--border-light);background:var(--bg-base);color:var(--text-dark);border-radius:10px;padding:.45rem .7rem;font-family:Consolas,Menlo,monospace;font-size:.85rem;outline:none}
.trace-search-input:focus{border-color:var(--primary-gold)}
.trace-select{border:2px solid var(--border-light);background:var(--bg-base);color:var(--text-dark);border-radius:10px;padding:.45rem .5rem;font-family:inherit;font-size:.82rem;outline:none}
.trace-results{margin-top:.6rem;max-height:260px;overflow-y:auto}
.trace-res{border:1px solid var(--border-light);border-radius:9px;padding:.45rem .6rem;margin-bottom:.35rem;cursor:pointer}
.trace-res:hover{border-color:var(--primary-gold);background:var(--accent-pink)}
.trace-res-meta{display:flex;gap:.6rem;align-items:center;font-size:.76rem;flex-wrap:wrap}
.trace-res-title{color:var(--text-dark);font-weight:600}
.trace-res-field{color:var(--primary-blue);background:var(--accent-pink);border-radius:6px;padding:0 .35rem}
.trace-res-model{color:var(--primary-gold)}
.trace-res-time{color:var(--text-muted);margin-left:auto}
.trace-res-snippet{color:var(--text-muted);font-size:.78rem;margin-top:.25rem;word-break:break-all;font-family:Consolas,Menlo,monospace}
.trace-res-empty{color:var(--text-muted);text-align:center;padding:.8rem;font-size:.85rem}
.trace-res-tip{color:var(--text-muted);font-size:.72rem;margin-top:.4rem}
.trace-res-tip i{color:var(--primary-gold);margin-right:.3rem}
.trace-side{width:300px;flex-shrink:0;background:var(--bg-card);border:1px solid var(--border-light);border-radius:14px;display:flex;flex-direction:column;overflow:hidden}
.trace-search{border:none;border-bottom:1px solid var(--border-light);background:transparent;color:var(--text-dark);padding:.7rem .9rem;outline:none;font-family:inherit;font-size:.85rem}
.trace-scroll{flex:1;overflow-y:auto;padding:.6rem}
.trace-group{margin-bottom:.9rem}
.trace-group-head{color:var(--text-muted);font-size:.76rem;font-weight:600;padding:.2rem .3rem;display:flex;align-items:center;gap:.4rem}
.trace-group-head .cnt{background:var(--accent-pink);border-radius:8px;padding:0 .35rem;font-size:.68rem;margin-left:auto}
.trace-chat{border:1px solid transparent;border-radius:8px;padding:.4rem .5rem;cursor:pointer;margin-top:.15rem}
.trace-chat:hover{background:var(--accent-pink)}
.trace-chat.active{background:var(--accent-pink);border-color:var(--primary-blue)}
.trace-chat-title{color:var(--text-dark);font-size:.82rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.trace-chat-meta{color:var(--text-muted);font-size:.7rem;margin-top:.1rem}
.trace-empty{color:var(--text-muted);font-size:.8rem;padding:.8rem .4rem}

.trace-main{flex:1;min-width:0;background:var(--bg-card);border:1px solid var(--border-light);border-radius:14px;display:flex;flex-direction:column;overflow:hidden}
.trace-title-bar{border-bottom:1px solid var(--border-light);padding:.6rem .9rem;display:flex;align-items:center;gap:.6rem}
.trace-title{color:var(--text-dark);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.trace-proj{color:var(--primary-blue);background:var(--accent-pink);border-radius:8px;padding:.1rem .5rem;font-size:.74rem;flex-shrink:0}
.trace-timeline{flex:1;overflow-y:auto;padding:1rem}
.trace-empty-main{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--text-muted);gap:.6rem;padding:2rem}
.trace-empty-main i{font-size:2rem;opacity:.5}

.tl-msg{border:1px solid var(--border-light);border-radius:12px;padding:.7rem .9rem;margin-bottom:.8rem;background:var(--bg-card-solid)}
.tl-role{color:var(--text-muted);font-size:.76rem;font-weight:600;margin-bottom:.45rem;display:flex;align-items:center;gap:.4rem}
.tl-model{color:var(--primary-gold);font-weight:400}
.tl-time{margin-left:auto;font-weight:400;opacity:.8}
.tl-reason{border:1px dashed var(--border-light);border-radius:9px;margin-bottom:.5rem;overflow:hidden}
.tl-reason-head{background:var(--bg-base);color:var(--text-muted);font-size:.74rem;padding:.3rem .6rem}
.tl-reason-head i{color:var(--primary-gold);margin-right:.3rem}
.tl-reason pre{background:var(--bg-base);color:var(--text-muted);padding:.5rem .7rem;font-size:.74rem;white-space:pre-wrap;word-break:break-word;max-height:240px;overflow-y:auto;margin:0;font-family:Consolas,Menlo,monospace}
.tl-steps{border-left:2px solid var(--primary-gold);padding-left:.6rem;margin-bottom:.5rem;display:flex;flex-direction:column;gap:.4rem}
.tl-step-tool{color:var(--primary-blue);font-size:.8rem;font-weight:600;font-family:Consolas,Menlo,monospace}
.tl-step-tool i{color:var(--primary-gold);margin-right:.3rem}
.tl-args{background:var(--bg-base);color:var(--text-muted);border-radius:7px;padding:.4rem .6rem;font-size:.72rem;margin:.25rem 0 0;white-space:pre-wrap;word-break:break-all;max-height:180px;overflow-y:auto;font-family:Consolas,Menlo,monospace}
.tl-result .tl-step-label{color:var(--text-muted);font-size:.74rem}
.tl-result.err .tl-step-label{color:#e67e22}
.tl-note{color:var(--text-muted);font-size:.75rem}
.tl-note i{margin-right:.3rem;color:var(--primary-gold)}
.tl-content{color:var(--text-dark);font-size:.86rem;line-height:1.55;white-space:pre-wrap;word-break:break-word}
</style>
