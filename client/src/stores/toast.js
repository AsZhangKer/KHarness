// 极简 toast store（不引入 pinia）
import { reactive } from 'vue';

export const toastState = reactive({ items: [] });
let seq = 0;

/**
 * detail：报错的技术原因。toast 上只显示概括那一行（不刷屏），
 * 点一下把「概括 + 换行 + 详情」一起复制走 —— 复制动作在 UiToasts 里。
 * report：点击复制时要拿走的**全量**报告（时间/页面/请求/异常链/堆栈/最近日志），
 *         由 utils/errText.js 的 errReport() 生成。界面上不显示，只跟着复制走。
 * 带详情的 error 停得更久一点，不然还没来得及点就消失了。
 */
export function toast(message, type = 'info', duration = 3500, detailRaw = '', report = '') {
  const id = ++seq;
  const text = String(message ?? '');
  let detail = String(detailRaw ?? '').trim();
  // 调用方没单独给 detail、而这一句本身就长的时候，从**第一个**分隔符处切开：
  // 前半句是给人看的概括（留在界面上），后半整段是技术原因（收进详情，点击复制才拿得到）。
  // 像「拉取失败: TypeError: fetch failed｜bad port」→ 上屏「拉取失败」，详情「TypeError: …｜bad port」。
  // 取最靠前的分隔符而不是最靠后的：最靠后那种会切出「bad port」这种没头没尾的碎片。
  // 门槛（整句 > 26 且尾段 >= 12）是为了别把「无效的正则表达式：x」这种本来就短的原因也藏起来。
  if (!detail && type === 'error' && text.length > 26) {
    const marks = [' · ', '：', '｜', ': ']
      .map((m) => text.indexOf(m))
      .filter((i) => i >= 2)
      .sort((a, b) => a - b);
    const cut = marks.find((i) => text.length - i - 1 >= 12);
    if (cut != null) detail = text.slice(cut).replace(/^[ ·｜:：]+/, '');
  }
  const summary = (detail && text.endsWith(detail))
    ? text.slice(0, text.length - detail.length).replace(/[ ·｜:：]+$/, '')
    : text;
  const ms = type === 'error' && detail ? Math.max(duration, 8000) : duration;
  // 同一句报错只留一条：拦截器报一次、调用方再报一次是最常见的重复来源，
  // 两条一模一样的红条除了挡视线没有信息量。1.5 秒内同文案视为同一件事。
  if (type === 'error') {
    const dup = toastState.items.find((x) => x.type === 'error' && x.message === summary && Date.now() - x.at < 1500);
    if (dup) {
      if (detail && !dup.detail) dup.detail = detail;
      // 后到的那份报告带的时间更新、日志更全，能换就换
      if (report) dup.report = report;
      return;
    }
  }
  toastState.items.push({ id, message: summary, type, detail, report: String(report || ''), at: Date.now() });
  setTimeout(() => {
    const i = toastState.items.findIndex((x) => x.id === id);
    if (i >= 0) toastState.items.splice(i, 1);
  }, ms);
}

export function toastStore() {
  return toastState;
}
