<!--
  修改历史的「审阅」弹窗（第七十六轮他点的那条：展开按钮改成审阅，点开看彩色文本，旁边一颗红色撤销）。
  看的是这条改动当时留下的逐行对照 —— 不是磁盘上的现状：撤销之后文件已经回滚，
  而这一栏记的是「AI 当时改了什么」，两份内容本来就该分开看。
  配色与高亮沿用消息流里那张编辑卡（utils/diffview.js 同一份规则，两边不会走偏）。
  撤销的二次确认在 ChatPage 的 onUndo 里，这里不重复问一遍。
-->
<template>
  <KModal :open="!!hist" :title="titleText" board="panel" tall code="HISTORY.REVIEW" ghost="HIST" width="820px" ef-width="1280" @close="$emit('close')">
    <div class="rv-meta">
      <span class="mono rv-path" :title="path">{{ path || hist?.undo_id || '' }}</span>
      <span v-if="hist?.tool" class="muted">{{ hist.tool }}</span>
      <span v-if="adds || dels" class="nums">
        <span class="num-pos">+{{ adds }}</span>
        <span class="num-neg">-{{ dels }}</span>
      </span>
      <button
        class="k-btn sm danger"
        type="button"
        :disabled="undone"
        @click="$emit('undo', hist.ref || hist)"
      >{{ undone ? txt('chat.hist.undone') : txt('chat.hist.undo') }}</button>
    </div>

    <div v-if="!rows.length" class="muted rv-empty">{{ txt('chat.hist.noDiff') }}</div>
    <div v-else class="rv-diff">
      <div v-for="(ln, i) in rows" :key="i" class="diff-line" :class="ln.kind"
        ><span class="gutter">{{ ln.mark }}</span><span class="code" v-html="ln.html"></span
      ></div>
      <div v-if="hidden" class="muted rv-hidden">{{ txt('chat.hist.hidden', { n: hidden }) }}</div>
    </div>

    <template #footer>
      <KButton variant="ghost" size="sm" @click="$emit('close')">{{ txt('chat.agent.close') }}</KButton>
    </template>
  </KModal>
</template>

<script setup>
import { computed } from 'vue';
import KModal from '../../ui/KModal.vue';
import KButton from '../../ui/KButton.vue';
import { baseName, diffView } from '../../utils/diffview';
import { langFromPath } from '../../utils/format';
import { txt } from '../../copy';

const props = defineProps({
  /** 侧栏「修改历史」或消息流编辑卡交来的那一条：{tool, path, diff, output, undone, ref} */
  hist: { type: Object, default: null },
});
defineEmits(['close', 'undo']);

// 弹窗里要一眼看完一整段改动，不像卡片那样只截 80 行；再长才收尾说明
const MAX = 400;

const path = computed(() => props.hist?.path || props.hist?.args?.path || props.hist?.new_path || '');
const titleText = computed(() => txt('chat.hist.modalTitle', { name: baseName(path.value) || props.hist?.tool || '' }));
const undone = computed(() => !!(props.hist?.ref && props.hist?.ref.undone) || !!props.hist?.undone);
const rows = computed(() => {
  const all = diffView(props.hist?.diff, langFromPath(path.value));
  return all.slice(0, MAX);
});
const hidden = computed(() => Math.max(0, (props.hist?.diff || []).length - Math.min(MAX, rows.value.length)));
const adds = computed(() => (props.hist?.diff || []).filter((l) => diffKind(l) === 'add').length);
const dels = computed(() => (props.hist?.diff || []).filter((l) => diffKind(l) === 'del').length);

// 计数要按整段算（不受上面 400 行的显示上限影响），所以单独归一一次形状判断
function diffKind(l) {
  if (typeof l === 'string') return l.startsWith('+') && !l.startsWith('+++') ? 'add' : (l.startsWith('-') && !l.startsWith('---') ? 'del' : 'ctx');
  const k = String(l?.t || l?.kind || l?.type || '').toLowerCase();
  if (k === 'add' || k === 'insert' || l?.mark === '+') return 'add';
  if (k === 'del' || k === 'delete' || k === 'remove' || l?.mark === '-') return 'del';
  return 'ctx';
}
</script>

<style scoped>
.rv-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; font-size: 12px; }
/* 路径长也必须看得见末尾：从前面截（保住文件名那一段），换行反而更难读 */
.rv-path { flex: 1; min-width: 200px; word-break: break-all; }
.rv-empty { padding: 14px 0; }
.rv-diff {
  max-height: 58vh; overflow: auto; border: 1px solid var(--line, #333); border-radius: 8px;
  font-family: var(--mono, ui-monospace, monospace); font-size: 12px; line-height: 1.55;
}
.diff-line { display: flex; gap: 8px; padding: 1px 8px; white-space: pre-wrap; word-break: break-word; }
.diff-line .gutter { width: 12px; flex: none; opacity: .7; user-select: none; }
.diff-line.add { background: var(--diff-add-bg); color: var(--diff-add-fg); }
.diff-line.add .gutter { color: var(--diff-add); }
.diff-line.del { background: var(--diff-del-bg); color: var(--diff-del-fg); }
.diff-line.del .gutter { color: var(--diff-del); }
.diff-line.meta { opacity: .62; }
.diff-line .code { color: inherit; }
/* 高亮 token 的默认色会把增删底色盖掉，两类各自压回本色 */
.diff-line.add .code :deep([class^='hljs-']),
.diff-line.add .code :deep([class*=' hljs-']) { color: var(--diff-add-fg); }
.diff-line.del .code :deep([class^='hljs-']),
.diff-line.del .code :deep([class*=' hljs-']) { color: var(--diff-del-fg); }
.rv-hidden { padding: 6px 8px; }
.num-pos { color: var(--diff-add); }
.num-neg { color: var(--diff-del); }
.nums { display: inline-flex; gap: 6px; }
</style>
