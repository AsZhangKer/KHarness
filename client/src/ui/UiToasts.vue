<template>
  <div class="ui-toasts" aria-live="polite">
    <TransitionGroup name="toast">
      <div
        v-for="item in state.items"
        :key="item.id"
        class="toast"
        :class="[item.type, { clickable: !!copyBody(item) }]"
        role="button"
        :tabindex="copyBody(item) ? 0 : -1"
        :title="copyBody(item) ? '点击复制完整报错报告（概括 + 详情 + 异常链 + 最近日志）' : '点击关闭'"
        @click="onClick(item)"
        @keydown.enter.prevent="onClick(item)"
      >
        <i :class="icon(item.type)"></i>
        <span>{{ item.message }}</span>
        <button v-if="copyBody(item)" class="toast-x" type="button" title="关闭" @click.stop="remove(item.id)">
          <i class="fas fa-xmark"></i>
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>

<script setup>
import { toastState as state, toast } from '../stores/toast';
import { copyText } from '../utils/errText';
import { errLogText, logErr } from '../utils/errlog';

function icon(type) {
  return {
    success: 'fas fa-circle-check',
    error: 'fas fa-circle-xmark',
    warn: 'fas fa-triangle-exclamation',
    info: 'fas fa-circle-info',
  }[type] || 'fas fa-circle-info';
}

/**
 * 点击要复制走的内容：优先是 errReport() 生成的全量报告（时间/页面/请求/概括/详情/
 * 异常链/堆栈/最近日志）；老调用点只给了 detail 时退回「概括 + 详情」两行。
 * 普通提示（既没详情也没报告）维持原行为 —— 点一下就关。
 */
function copyBody(item) {
  if (item.report) return item.report;
  if (item.detail) return `${item.message}\n${item.detail}`;
  if (item.type === 'error') return thinErrorReport(item);
  return '';
}

/**
 * 红条但调用点只丢了四个字（「网络错误」「打开失败」这类）：以前点一下等于把它关掉，
 * 什么都复制不到，而这种情况下用户最需要的恰恰是「刚才发生了什么」。
 * 这里现拼一份：报错时间（按这条 toast 出现的时刻，不是我按复制的时间）、页面、概括、
 * 客户端台账里最近十条日志（含被吞掉的原始异常与接口 URL）。
 */
function thinErrorReport(item) {
  const d = new Date(item.at || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  const at = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  const lines = [
    `【KHarness 报错】${at}`,
    `页面：${location.pathname}${location.search}`,
    `概括：${item.message}`,
    '详情：（调用点没给技术原因；下面是报错前后的客户端台账，可能包含被吞掉的原始异常）',
  ];
  const log = errLogText(12);
  if (log) lines.push('—— 最近日志（客户端台账，最新在最后）——', log);
  logErr({ kind: 'error', where: '红条无详情（复制时现拼）', summary: item.message, detail: '' });
  return lines.join('\n');
}

async function onClick(item) {
  const body = copyBody(item);
  if (!body) return remove(item.id);
  const ok = await copyText(body);
  if (ok) {
    remove(item.id);
    toast('已复制完整报错报告', 'success', 1800);
  } else {
    toast('复制失败，请手动选择文本', 'warn', 3000);
  }
}

function remove(id) {
  const i = state.items.findIndex((x) => x.id === id);
  if (i >= 0) state.items.splice(i, 1);
}
</script>

<style scoped>
.ui-toasts {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 100;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: min(360px, calc(100vw - 32px));
}
.toast {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  text-align: left;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  color: var(--text);
  box-shadow: var(--shadow);
  font: inherit;
  width: 100%;
}
.toast.clickable { cursor: copy; }
.toast.clickable:hover { border-color: var(--accent); }
.toast.success i { color: var(--ok); }
.toast.error i { color: var(--danger); }
.toast.warn i { color: var(--warn); }
.toast.info i { color: var(--accent); }
.toast span {
  flex: 1;
  word-break: break-word;
  font-size: 12px;
}
.toast-x {
  border: 0;
  background: transparent;
  color: var(--text-3, var(--text-2));
  cursor: pointer;
  font-size: 11px;
  padding: 0 2px;
}
.toast-x:hover { color: var(--text); }
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(6px);
}
@media (prefers-reduced-motion: reduce) {
  .toast-enter-active,
  .toast-leave-active {
    transition: none;
  }
}
</style>
