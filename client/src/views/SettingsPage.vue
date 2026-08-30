<template>
  <div class="page">
    <div class="page-header" v-reveal>
      <h2><i class="fas fa-gear"></i> 设置</h2>
    </div>

    <!-- 默认 Shell -->
    <section class="set-card" data-tour="set-shell" v-reveal>
      <h3><i class="fas fa-terminal"></i> 默认 Shell（Agent 执行命令使用）</h3>
      <p class="set-desc">当前：<code>{{ shellCurrent || '系统默认' }}</code>。修改后立即生效，无需重启。</p>
      <div class="shell-list">
        <div
          v-for="c in shellCandidates" :key="c.value"
          class="shell-item" :class="{ active: c.value === shellCurrent, missing: c.missing }"
          @click="!c.missing && saveShell(c.value)"
        >
          <i class="fas fa-square-terminal"></i>
          <span class="shell-label">{{ c.label }}</span>
          <code>{{ c.value }}</code>
          <i v-if="c.value === shellCurrent" class="fas fa-circle-check ok"></i>
        </div>
      </div>
      <div class="shell-custom">
        <input v-model="customShell" :placeholder="pShellCustom" @keydown.enter="saveCustomShell">
        <button class="btn btn-primary btn-small" :disabled="!customShell.trim()" @click="saveCustomShell">保存路径</button>
        <button v-if="shellCurrent" class="btn btn-small" @click="saveShell('')" title="恢复系统默认 Shell">恢复默认</button>
      </div>
    </section>

    <!-- 界面字体 -->
    <section class="set-card" data-tour="set-font" v-reveal>
      <h3><i class="fas fa-font"></i> 界面字体</h3>
      <p class="set-desc">
        全局生效于整个界面，仅保存在当前浏览器。可选常见系统字体、扫描本机字体，或直接输入任意已安装的字体名；默认使用内置字体。
      </p>
      <div class="font-row">
        <select v-model="fontChoice" class="font-select" @change="onFontChoice">
          <option value="">默认字体（内置）</option>
          <option v-for="f in fontList" :key="f" :value="f">{{ f }}</option>
        </select>
        <button class="btn btn-small" :disabled="scanning" @click="scanFonts">
          <i class="fas fa-rotate"></i> {{ scanning ? '扫描中…' : '扫描系统字体' }}
        </button>
      </div>
      <div class="font-row">
        <input v-model="fontCustom" placeholder="或手动输入字体名，如 微软雅黑 / Cascadia Code" @keydown.enter="applyCustomFont">
        <button class="btn btn-primary" :disabled="!fontCustom.trim()" @click="applyCustomFont">应用</button>
      </div>
      <p v-if="scanTip" class="set-desc" style="margin:.5rem 0 0">{{ scanTip }}</p>
    </section>

    <!-- 敏感数据脱敏 -->
    <section class="set-card" data-tour="set-secrets" v-reveal>
      <h3><i class="fas fa-shield-halved"></i> 敏感数据脱敏表</h3>
      <p class="set-desc">
        规则为 JavaScript 正则；<b>只对发送给 AI 的工具输出脱敏</b>（如 read_file 读到 .env 内容），AI 生成的代码/文件内容不做处理。
        示例：<code>sk-[a-zA-Z0-9]{20,}</code>、<code>PASSWORD\s*=\s*\S+</code>
      </p>
      <div class="secret-add">
        <input v-model="newPattern" placeholder="正则表达式，如 api[_-]?key\s*=\s*\S+" @keydown.enter="addSecret">
        <input v-model="newLabel" class="label-input" placeholder="备注（可选）" @keydown.enter="addSecret">
        <button class="btn btn-primary" :disabled="!newPattern.trim() || saving" @click="addSecret">
          <i class="fas fa-plus"></i> 添加
        </button>
      </div>
      <div v-if="secretErr" class="secret-err"><i class="fas fa-circle-exclamation"></i> {{ secretErr }}</div>
      <table v-if="secrets.length" class="secret-tbl">
        <thead><tr><th>正则</th><th>备注</th><th></th></tr></thead>
        <tbody>
          <tr v-for="s in secrets" :key="s.id">
            <td><code>{{ s.pattern }}</code></td>
            <td>{{ s.label || '—' }}</td>
            <td><button class="btn btn-small del" @click="removeSecret(s)"><i class="fas fa-trash"></i></button></td>
          </tr>
        </tbody>
      </table>
      <p v-else class="set-desc" style="margin-top:.8rem">当前为空（默认状态）。工具输出不会做任何脱敏。</p>
    </section>

    <!-- AGENTS.md 长期记忆说明 -->
    <section class="set-card" data-tour="set-agents" v-reveal>
      <h3><i class="fas fa-file-lines"></i> AGENTS.md 长期记忆</h3>
      <p class="set-desc">
        在以下位置放置 <code>AGENTS.md</code>（或 <code>AGENT.md</code>）文件，内容会自动注入每次 Agent 对话（叠加生效，单文件上限 200KB）：<br>
        1. 全局：<code>{{ pAgentsPath }}</code><br>
        2. 项目：<code>{{ pProjectAgents }}</code>（仅项目会话）<br>
        3. 自由会话：<code>&lt;当前目录&gt;/AGENTS.md</code><br>
        格式为纯 Markdown，无需 frontmatter；完整说明见聊天页「帮助」菜单与项目根目录的 <code>AGENTMD_USAGE.md</code>。
      </p>
    </section>

    <!-- 重新运行初始设置 -->
    <section class="set-card" v-reveal>
      <h3><i class="fas fa-wand-magic-sparkles"></i> 初始设置（OOBE）</h3>
      <p class="set-desc">重新运行首次启动向导：选择系统、导入提供商与模型、主题与功能学习。已有数据不会被清除。</p>
      <button class="btn" :disabled="oobeResetting" @click="resetOobe">
        <i class="fas" :class="oobeResetting ? 'fa-spinner fa-spin' : 'fa-rotate-right'"></i>
        重新运行初始设置向导
      </button>
    </section>

    <!-- 技能导入 -->
    <section class="set-card" v-reveal>
      <h3><i class="fas fa-book"></i> 自定义技能导入</h3>
      <p class="set-desc">
        遵循通用 skills 规范：<code>--- frontmatter（name / description）---</code> + Markdown 正文。
        导入后 AI 通过 <code>load_skill(name)</code> 按需加载（不占用 System Prompt）；聊天中输入 <code>@技能名</code> 可手动注入。
      </p>
      <div class="skill-add">
        <input v-model="skillFilename" placeholder="文件名（不含 .md，如 my-deploy）">
        <button class="btn btn-primary" :disabled="!skillContent.trim() || skillSaving" @click="importSkill">
          <i class="fas fa-file-import"></i> 导入
        </button>
      </div>
      <textarea v-model="skillContent" class="skill-editor" rows="6" placeholder="---&#10;name: my-deploy&#10;description: 我的部署流程&#10;---&#10;&#10;1. 第一步..."></textarea>
      <table v-if="skills.length" class="secret-tbl" style="margin-top:.8rem">
        <thead><tr><th>名称</th><th>说明</th><th>来源</th><th></th></tr></thead>
        <tbody>
          <tr v-for="s in skills" :key="s.name">
            <td><code>{{ s.name }}</code></td>
            <td>{{ s.description || '—' }}</td>
            <td>{{ s.custom ? '自定义' : '内置' }}</td>
            <td><button v-if="s.custom" class="btn btn-small del" @click="removeSkill(s)"><i class="fas fa-trash"></i></button></td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { aiApi } from '../api';
import { toast } from '../utils/toast';
import { COMMON_FONTS, getAppFont, applyAppFont, scanLocalFonts } from '../utils/appFont';
import { agentsFilePath, projectAgentsExample, shellCustomPlaceholder } from '../utils/platformText';

const pAgentsPath = computed(agentsFilePath);
const pProjectAgents = computed(projectAgentsExample);
const pShellCustom = computed(shellCustomPlaceholder);
const oobeResetting = ref(false);

async function resetOobe() {
  if (!confirm('重新运行初始设置向导？现有数据不会被删除，但向导中再次保存会新增提供商/模型。')) return;
  oobeResetting.value = true;
  try {
    await aiApi.resetOobe();
    location.reload();
  } catch (e) {
    toast(e.response?.data?.message || '重置失败', 'error');
    oobeResetting.value = false;
  }
}

const shellCandidates = ref([]);
const shellCurrent = ref('');
const customShell = ref('');
const fontChoice = ref('');
const fontList = ref([...COMMON_FONTS]);
const fontCustom = ref('');
const scanning = ref(false);
const scanTip = ref('');
const secrets = ref([]);
const newPattern = ref('');
const newLabel = ref('');
const secretErr = ref('');
const saving = ref(false);
const skills = ref([]);
const skillFilename = ref('');
const skillContent = ref('');
const skillSaving = ref(false);

async function loadShell() {
  try {
    const res = await aiApi.getShell();
    shellCandidates.value = res.data.candidates || [];
    shellCurrent.value = res.data.current || '';
  } catch (e) { /* 静默 */ }
}

async function saveShell(value) {
  try {
    const res = await aiApi.setShell(value);
    shellCurrent.value = value;
    if (value) customShell.value = value;
    toast(res.message || '已保存', 'success');
  } catch (e) {
    toast(e.response?.data?.message || '保存失败', 'error');
  }
}

function saveCustomShell() {
  const v = customShell.value.trim();
  if (!v) { toast('请输入路径', 'info'); return; }
  saveShell(v);
}

async function loadSecrets() {
  try { secrets.value = (await aiApi.getSecrets()).data; } catch (e) { /* 静默 */ }
}

async function addSecret() {
  // 防重复触发（回车+按钮）：空输入静默返回，进行中禁止再次提交
  if (saving.value || !newPattern.value.trim()) return;
  saving.value = true;
  secretErr.value = '';
  try {
    await aiApi.createSecret({ pattern: newPattern.value.trim(), label: newLabel.value.trim() });
    newPattern.value = '';
    newLabel.value = '';
    await loadSecrets();
    toast('规则已添加', 'success');
  } catch (e) {
    secretErr.value = e.response?.data?.message || '添加失败';
  } finally {
    saving.value = false;
  }
}

async function removeSecret(s) {
  if (!confirm(`删除规则「${s.pattern}」？`)) return;
  try {
    await aiApi.deleteSecret(s.id);
    await loadSecrets();
    toast('已删除', 'success');
  } catch (e) {
    toast(e.response?.data?.message || '删除失败', 'error');
  }
}

async function loadSkills() {
  try { skills.value = (await aiApi.getSkills()).data; } catch (e) { /* 静默 */ }
}

async function importSkill() {
  if (skillSaving.value || !skillContent.value.trim()) return;
  skillSaving.value = true;
  try {
    const res = await aiApi.importSkill({ filename: skillFilename.value.trim(), content: skillContent.value });
    toast(res.message || '已导入', 'success');
    skillFilename.value = '';
    skillContent.value = '';
    await loadSkills();
  } catch (e) {
    toast(e.response?.data?.message || '导入失败', 'error');
  } finally {
    skillSaving.value = false;
  }
}

async function removeSkill(s) {
  if (!confirm(`删除自定义技能「${s.name}」？`)) return;
  try {
    await aiApi.deleteSkill(s.name);
    await loadSkills();
    toast('已删除', 'success');
  } catch (e) {
    toast(e.response?.data?.message || '删除失败', 'error');
  }
}

function onFontChoice() {
  fontCustom.value = '';
  applyAppFont(fontChoice.value);
}

function applyCustomFont() {
  const v = fontCustom.value.trim().replace(/['"]/g, '');
  if (!v) return;
  applyAppFont(v);
  if (!fontList.value.includes(v)) fontList.value.push(v);
  fontChoice.value = v;
}

async function scanFonts() {
  scanning.value = true;
  scanTip.value = '';
  try {
    const list = await scanLocalFonts();
    if (list === null) {
      scanTip.value = '当前浏览器不支持枚举系统字体（需要 Chrome/Edge 并在弹窗中授权），可直接手动输入字体名。';
    } else if (!list.length) {
      scanTip.value = '未枚举到系统字体，可手动输入字体名。';
    } else {
      fontList.value = list;
      scanTip.value = `已载入 ${list.length} 个系统字体族。`;
    }
  } catch (e) {
    scanTip.value = '扫描被拒绝或失败，可直接手动输入字体名。';
  } finally {
    scanning.value = false;
  }
}

onMounted(async () => {
  await Promise.all([loadShell(), loadSecrets(), loadSkills()]);
  // 恢复已保存的字体（不在列表中时补进列表）
  const saved = getAppFont();
  if (saved) {
    if (!fontList.value.includes(saved)) fontList.value.push(saved);
    fontChoice.value = saved;
  }
});
</script>

<style scoped>
.page{max-width:900px;margin:0 auto}
.page-header{margin-bottom:1.2rem}
.page-header h2{margin:0;color:var(--text-dark);font-size:1.3rem}
.page-header h2 i{color:var(--primary-gold);margin-right:.4rem}
.set-card{background:var(--bg-card);border:1px solid var(--border-light);border-radius:14px;padding:1.1rem 1.3rem;margin-bottom:1.2rem}
.set-card h3{margin:0 0 .4rem;font-size:1rem;color:var(--text-dark)}
.set-card h3 i{color:var(--primary-gold);margin-right:.4rem}
.set-desc{color:var(--text-muted);font-size:.82rem;line-height:1.6;margin:.2rem 0 .8rem}
.set-desc code,td code{background:var(--accent-pink);border-radius:5px;padding:.05rem .35rem;font-size:.78rem}
.shell-list{display:flex;flex-direction:column;gap:.4rem}
.shell-item{display:flex;align-items:center;gap:.6rem;border:1px solid var(--border-light);border-radius:10px;padding:.55rem .8rem;cursor:pointer;color:var(--text-dark)}
.shell-item:hover{border-color:var(--primary-gold)}
.shell-item.active{border-color:var(--primary-blue);background:var(--accent-pink)}
.shell-item.missing{opacity:.5;cursor:not-allowed}
.shell-item i{color:var(--primary-gold)}
.shell-label{flex:1;font-size:.88rem}
.shell-item code{color:var(--text-muted);font-size:.75rem}
.ok{color:#27ae60}
.shell-custom{display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.8rem;align-items:center}
.shell-custom input{flex:1;min-width:260px;border:2px solid var(--border-light);background:var(--bg-base);color:var(--text-dark);border-radius:10px;padding:.5rem .7rem;font-family:Consolas,Menlo,monospace;font-size:.82rem;outline:none}
.shell-custom input:focus{border-color:var(--primary-gold)}
.font-row{display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:.5rem}
.font-select{flex:1;min-width:240px;border:2px solid var(--border-light);background:var(--bg-base);color:var(--text-dark);border-radius:10px;padding:.5rem .7rem;font-family:inherit;font-size:.85rem;outline:none}
.font-select:focus{border-color:var(--primary-gold)}
.font-row input{flex:1;min-width:240px;border:2px solid var(--border-light);background:var(--bg-base);color:var(--text-dark);border-radius:10px;padding:.5rem .7rem;font-family:inherit;font-size:.85rem;outline:none}
.font-row input:focus{border-color:var(--primary-gold)}
.secret-add{display:flex;gap:.5rem;flex-wrap:wrap}
.secret-add input{flex:1;min-width:220px;border:2px solid var(--border-light);background:var(--bg-base);color:var(--text-dark);border-radius:10px;padding:.5rem .7rem;font-family:Consolas,Menlo,monospace;font-size:.82rem;outline:none}
.secret-add input:focus{border-color:var(--primary-gold)}
.secret-add .label-input{font-family:inherit;flex:0 1 180px}
.secret-err{color:#c0392b;font-size:.8rem;margin-top:.5rem}
.secret-tbl{width:100%;border-collapse:collapse;font-size:.84rem;margin-top:.8rem}
.secret-tbl th{color:var(--text-muted);text-align:left;font-weight:500;padding:.4rem .5rem;border-bottom:1px solid var(--border-light)}
.secret-tbl td{padding:.45rem .5rem;border-bottom:1px dashed var(--border-light);color:var(--text-dark);word-break:break-all}
.btn.del{color:#c0392b}
.skill-add{display:flex;gap:.5rem;margin-bottom:.5rem}
.skill-add input{flex:1;border:2px solid var(--border-light);background:var(--bg-base);color:var(--text-dark);border-radius:10px;padding:.5rem .7rem;font-family:inherit;outline:none}
.skill-add input:focus{border-color:var(--primary-gold)}
.skill-editor{width:100%;box-sizing:border-box;border:2px solid var(--border-light);background:var(--bg-base);color:var(--text-dark);border-radius:10px;padding:.6rem .7rem;font-family:Consolas,Menlo,monospace;font-size:.82rem;resize:vertical;outline:none}
.skill-editor:focus{border-color:var(--primary-gold)}
</style>
