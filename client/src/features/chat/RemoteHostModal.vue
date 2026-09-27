<template>
  <KModal :open="open" :title="editing ? '编辑远程连接' : '新建 SSH 连接'" width="560px" @close="close">
    <div class="form">
      <div class="row2">
        <KInput v-model="form.name" label="显示名" placeholder="例如：内网构建机" />
        <KInput v-model="form.username" label="用户名" placeholder="root" />
      </div>
      <div class="row2">
        <KInput v-model="form.host" label="主机域名 / IP" placeholder="192.168.1.100" />
        <KInput v-model="form.port" label="端口" placeholder="22" type="number" />
      </div>

      <label class="field">
        <span>认证方式</span>
        <KDropdown :items="authItems" :model-value="form.auth" :label="form.auth === 'key' ? 'PEM私钥' : '密码'" block width="100%" @change="(v) => (form.auth = v)" />
      </label>

      <template v-if="form.auth === 'password'">
        <label class="field">
          <span>{{ secretHint }}</span>
          <input v-model="form.secret" :type="showSecret ? 'text' : 'password'" :placeholder="editing ? '留空以保持原密码' : '登录密码'" autocomplete="off" />
          <button class="peek" type="button" :title="showSecret ? '隐藏' : '显示'" @click="showSecret = !showSecret">
            <i class="fas" :class="showSecret ? 'fa-eye-slash' : 'fa-eye'"></i>
          </button>
        </label>
      </template>
      <template v-else>
        <label class="field">
          <span>PEM私钥</span>
          <textarea v-model="form.private_key" rows="4" :placeholder="editing && form.has_key ? '留空以保持原PEM私钥' : '-----BEGIN OPENSSH PRIVATE KEY-----'" spellcheck="false"></textarea>
        </label>
        <KInput v-model="form.secret" :label="passHint" placeholder="私钥没有口令就留空" />
      </template>

      <label class="field">
        <span>工作目录</span>
        <input v-model="form.default_cwd" placeholder="/srv/app 或 /home/ker" spellcheck="false" />
        <button class="peek" type="button" title="浏览远端目录" :disabled="!hostId" @click="browse">
          <i class="fas fa-folder-open"></i>
        </button>
      </label>

      <div v-if="browsePath" class="browse">
        <div class="browse-bar">
          <button class="k-btn ghost sm" type="button" :disabled="atRoot" title="上一级" @click="cd(parentOf(browsePath))">
            <i class="fas fa-arrow-up"></i>
          </button>
          <span class="ellip" :title="browsePath">{{ browsePath }}</span>
          <button class="k-btn sm" type="button" @click="pickDir">选择此目录</button>
        </div>
        <div v-if="browseErr" class="browse-err">{{ browseErr }}</div>
        <div v-else class="browse-list">
          <button v-for="d in browseDirs" :key="d.name" class="browse-item" type="button" @click="cd(joinPosix(browsePath, d.name))">
            <i class="fas fa-folder"></i> {{ d.name }}
          </button>
          <div v-if="!browseDirs.length && !browseLoading" class="muted browse-empty">找不到子目录</div>
        </div>
      </div>

      <div v-if="testing" class="muted tip"><i class="fas fa-circle-notch fa-spin"></i> 正在连接…</div>
      <div v-else-if="testResult" class="tip" :class="testResult.ok ? 'good' : 'bad'">
        <i class="fas" :class="testResult.ok ? 'fa-circle-check' : 'fa-triangle-exclamation'"></i>
        <span class="ellip">{{ testResult.ok ? testResult.info : testResult.error }}</span>
      </div>
      <div class="muted tip">
        密码与PEM私钥位于本机数据库文件 <code>kh.db</code> 中。删除连接会连带删掉它下面的远端项目与会话记录，远端文件不动。
      </div>
    </div>
    <template #footer>
      <button class="k-btn ghost sm" type="button" @click="close">取消</button>
      <button v-if="hostId" class="k-btn sm" type="button" :disabled="testing" @click="test">
        <i class="fas fa-plug"></i> 测试
      </button>
      <button class="k-btn primary sm" type="button" :disabled="busy" @click="save">
        <i class="fas" :class="busy ? 'fa-circle-notch fa-spin' : 'fa-check'"></i> 保存
      </button>
    </template>
  </KModal>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue';
import KModal from '../../ui/KModal.vue';
import KInput from '../../ui/KInput.vue';
import KDropdown from '../../ui/KDropdown.vue';
import { aiApi } from '../../api';
import { toast } from '../../stores/toast';
import { remoteStore } from './remoteStore';

const props = defineProps({
  open: { type: Boolean, default: false },
  // 传了 host 就是编辑，没传就是新建
  host: { type: Object, default: null },
});
const emit = defineEmits(['close', 'saved']);

const authItems = [
  { value: 'password', label: '密码' },
  { value: 'key', label: '私钥' },
];

const editing = computed(() => !!(props.host && props.host.id));
const hostId = computed(() => (props.host ? props.host.id : 0));
const showSecret = ref(false);
const busy = ref(false);
const testing = ref(false);
const testResult = ref(null);

const form = reactive({
  name: '', host: '', port: 22, username: 'root', auth: 'password',
  secret: '', private_key: '', default_cwd: '', has_key: false,
});

const secretHint = computed(() => (editing.value ? '密码留空以保持不变' : '登录密码'));
const passHint = computed(() => (editing.value ? '私钥口令 passphrase（留空以保持私钥不变）' : '私钥口令 passphrase（留空以保持私钥不变）'));

function fillFromHost(h) {
  testResult.value = null;
  browsePath.value = '';
  Object.assign(form, {
    name: h?.name || '', host: h?.host || '', port: h?.port || 22, username: h?.username || 'root',
    auth: h?.auth || 'password', secret: '', private_key: '', default_cwd: h?.default_cwd || '',
    has_key: !!(h && h.has_key),
  });
}
watch(() => [props.open, props.host], () => { if (props.open) fillFromHost(props.host); }, { immediate: true });

function close() { emit('close'); }

/* ---------------- 远端目录浏览（要先保存过连接，浏览走的是它的 SFTP） ---------------- */
const browsePath = ref('');
const browseDirs = ref([]);
const browseErr = ref('');
const browseLoading = ref(false);
const joinPosix = (a, b) => `${String(a).replace(/\/+$/, '')}/${b}`;
const parentOf = (p) => {
  const s = String(p).replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  return i <= 0 ? '/' : s.slice(0, i);
};
const atRoot = computed(() => !browsePath.value || browsePath.value === '/');

async function cd(p) {
  if (!hostId.value) return toast('你需要先保存连接！', 'warn');
  browseLoading.value = true;
  browseErr.value = '';
  try {
    const r = await aiApi.remoteList(hostId.value, p);
    browsePath.value = r?.real_path || r?.path || p;
    browseDirs.value = (r?.items || []).filter((i) => i.type === 'dir');
  } catch (e) {
    browseErr.value = String(e?.message || e);
  } finally {
    browseLoading.value = false;
  }
}
async function browse() {
  await cd(form.default_cwd || remoteStore.state.hosts.find((h) => h.id === hostId.value)?.home || '/');
}
function pickDir() {
  form.default_cwd = browsePath.value;
  toast(`起始目录已设为 ${browsePath.value}`, 'success');
}

/* ---------------- 保存与测试 ---------------- */
async function save() {
  if (!form.host.trim()) return toast('要填主机地址', 'warn');
  busy.value = true;
  try {
    const body = {
      name: form.name.trim() || form.host.trim(),
      host: form.host.trim(),
      port: Number(form.port) || 22,
      username: form.username.trim() || 'root',
      auth: form.auth,
      default_cwd: form.default_cwd.trim(),
    };
    // 编辑时留空 = 保持原值，所以只在真的有内容时才把密钥带上
    if (form.secret) body.secret = form.secret;
    if (form.private_key) body.private_key = form.private_key;
    let id = hostId.value;
    if (id) await aiApi.updateRemoteHost(id, body);
    else {
      if (!form.secret && form.auth === 'password') { busy.value = false; return toast('要填密码', 'warn'); }
      const r = await aiApi.createRemoteHost(body);
      id = r?.id;
    }
    toast('已保存', 'success');
    await remoteStore.refresh();
    emit('saved', id);
    if (!editing.value) close();
    else fillFromHost(remoteStore.hostOf(id));
  } catch (e) {
    /* 拦截器弹过了 */
  } finally {
    busy.value = false;
  }
}

async function test() {
  if (!hostId.value) return toast('先保存再测试', 'warn');
  testing.value = true;
  testResult.value = null;
  try {
    const r = await remoteStore.test(remoteStore.hostOf(hostId.value) || { id: hostId.value });
    testResult.value = r || { ok: false, error: '结果获取失败' };
  } finally {
    testing.value = false;
  }
}
</script>

<style scoped>
.form { display: flex; flex-direction: column; gap: 10px; }
.row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-2); position: relative; }
.field input, .field textarea {
  width: 100%;
  padding: 8px 34px 8px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text);
  font: inherit;
  font-family: var(--mono);
}
.field textarea { padding-right: 10px; resize: vertical; }
.peek {
  position: absolute;
  right: 6px;
  top: 24px;
  width: 26px;
  height: 26px;
  border-radius: 6px;
  color: var(--text-3);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.peek:hover { background: var(--bg-hover); color: var(--text); }
.browse { border: 1px solid var(--border-soft); border-radius: var(--radius-sm); background: var(--bg-panel); overflow: hidden; }
.browse-bar { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-bottom: 1px solid var(--border-soft); font-family: var(--mono); font-size: 11px; }
.browse-bar .ellip { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.browse-list { max-height: 180px; overflow: auto; padding: 4px; }
.browse-item { display: block; width: 100%; text-align: left; padding: 5px 8px; border-radius: 6px; font-size: 12px; color: var(--text); }
.browse-item:hover { background: var(--bg-hover); }
.browse-empty, .browse-err { padding: 8px; font-size: 12px; }
.browse-err { color: var(--danger); }
.tip { font-size: 11px; line-height: 1.5; display: flex; gap: 6px; align-items: flex-start; }
.tip.good { color: var(--ok); }
.tip.bad { color: var(--danger); }
.tip code { font-family: var(--mono); }
</style>
