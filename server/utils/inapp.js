// 内置浏览器：AI 的工具调用要落到「桌面窗口里那个 <webview>」上执行。
//
// 为什么绕这一圈：Agent 循环跑在 Node 服务进程里，而页面只存在于 Electron 渲染进程。
// 服务端不持有任何浏览器实例，只能把动作排进队列，由窗口那头长轮询取走、执行、回填结果。
// 长轮询而不是 WebSocket：服务已经有 HTTP 了，不为一个队列再引 ws 依赖和端口。
//
// 因此有个硬约束：没有桌面端窗口在线，这些工具就不可用。这里把它做成明确报错而不是
// 静默挂起 —— 让模型知道该改用别的办法或提示你打开窗口，而不是白等 60 秒。
const toolgate = require('./toolgate');
const pagecap = require('./pagecap');

const PENDING_TTL = 90000;      // 单个动作从入队到回填的上限
const POLL_HOLD = 25000;        // 长轮询挂住的时间
const CLIENT_STALE = 35000;     // 超过这个时间没有任何联系 = 面板没在线
const ACTION_GRACE = 60000;     // 动作交出去之后，这段时间内窗口不会来轮询（它正忙着）

const pending = new Map();      // id -> { resolve, reject, timer, name }
const queue = [];               // 待取动作
let seq = 0;
let lastPollAt = 0;
let deliveredAt = 0;            // 最近一次把动作交给窗口的时间
let holder = null;              // 当前挂着的轮询请求 { resolve, timer }
let lastActivityAt = 0;

/**
 * 窗口是否在线。这里有两个坑，都是实测踩出来的：
 * ① 长轮询会在服务端挂住 25 秒，这期间不会再来新的轮询；
 * ② 动作交出去之后窗口一去执行，十几秒不吭声（导航/等渲染），回来才回填。
 * 只按「上次轮询时间」判活会把这两种情况都误判成掉线，
 * 于是第二个动作直接吐「窗口没在轮询」——实际窗口正干着活。
 */
function clientOnline() {
  if (holder) return true;
  if (deliveredAt && Date.now() - deliveredAt < ACTION_GRACE) return true;
  return lastPollAt > 0 && Date.now() - lastPollAt < CLIENT_STALE;
}

function release(action) {
  const w = pending.get(action.id);
  if (!w) return false;
  clearTimeout(w.timer);
  pending.delete(action.id);
  w.resolve(action.result === undefined ? { ok: true } : action.result);
  return true;
}

/** 把一个动作交给窗口执行；返回 Promise（超时/离线都给出可行动的文案） */
function call(name, args, timeoutMs = PENDING_TTL) {
  if (!clientOnline()) {
    return Promise.resolve({
      error: `内置浏览器当前不可用：桌面端窗口没有动静（最后联系 ${Math.round((Date.now() - lastPollAt) / 1000)} 秒前）。`
        + '请确认 KHarness 桌面端开着、右侧浏览器栏没被收起（收起后 AI 一调它还会自己弹出来）；或者改用 web_fetch 读取网页正文。',
    });
  }
  const id = ++seq;
  lastActivityAt = Date.now();
  const action = { id, name, args: args || {} };
  const p = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      const i = queue.indexOf(action);
      if (i >= 0) queue.splice(i, 1);
      reject(new Error(`${name} 执行超时 ${Math.round(timeoutMs / 1000)}s（页面可能卡住或在等下载）`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer, name });
  });
  queue.push(action);
  if (holder) {
    // 直接交给正挂着的那个轮询 —— 记得从队列里摘掉，
    // 否则窗口下次轮询会把同一个动作再取走一遍（实测会重复执行一次）
    const i = queue.indexOf(action);
    if (i >= 0) queue.splice(i, 1);
    const h = holder;
    holder = null;
    clearTimeout(h.timer);
    deliveredAt = Date.now();
    h.resolve(action);
  }
  return p;
}

/** 窗口那头取下一个动作（没动作就挂住一会儿，避免空转请求） */
function poll() {
  lastPollAt = Date.now();
  if (queue.length) { deliveredAt = Date.now(); return Promise.resolve(queue.shift()); }
  return new Promise((resolve) => {
    // 只允许一个消费者：新轮询进来就把上一个挂着的请求当超时释放掉，
    // 否则窗口刷新会留下永不结算的悬挂请求。
    if (holder) {
      clearTimeout(holder.timer);
      const stale = holder;
      holder = null;
      stale.resolve(null);
    }
    const entry = { resolve: null, timer: null };
    entry.resolve = (v) => {
      if (holder === entry) holder = null;
      resolve(v);
    };
    entry.timer = setTimeout(() => { if (holder === entry) holder = null; resolve(null); }, POLL_HOLD);
    holder = entry;
  });
}

function report(id, result, error) {
  const action = { id, result: error ? { error: String(error) } : (result || {}) };
  // 回填本身就是心跳：窗口能回话，说明它活着，不用等它下次轮询
  lastPollAt = Date.now();
  deliveredAt = 0;
  if (!pending.has(id)) return false;
  release(action);
  return true;
}

function dropPending(reason) {
  for (const [id, w] of [...pending.entries()]) {
    clearTimeout(w.timer);
    pending.delete(id);
    w.reject(new Error(reason));
  }
  queue.length = 0;
  deliveredAt = 0;
}

function status() {
  return {
    online: clientOnline(),
    queued: queue.length,
    waiting: pending.size,
    last_poll_ms_ago: lastPollAt ? Date.now() - lastPollAt : null,
    last_activity_ms_ago: lastActivityAt ? Date.now() - lastActivityAt : null,
  };
}

/* ---------------- 工具面 ---------------- */

const T = (desc, extra = {}) => ({ type: 'string', required: true, desc, ...extra });

/**
 * 所有 browser_* 工具走同一条路：入队 → 等窗口回填 → 归一成 toolgate 约定的
 * { output } / { error }。窗口回的是 { ok, text }，超时/离线在这里变成给模型看的文案。
 *
 * 传了 opts.page 的就是「正文类」结果（browser_text / browser_find）：整段过 pagecap 预算，
 * 超预算就全文落盘、只回一段并告诉模型怎么接着取。网页正文是上下文暴涨最快的一路，
 * 不能让它整篇进来。缓存的键用窗口回报的当前 URL，所以翻页续取读到的还是这一页。
 */
function runner(name, timeoutMs, opts = {}) {
  return async (args) => {
    let r;
    try {
      r = await call(name, args || {}, timeoutMs);
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
    if (!r) return { error: `${name}：窗口没有返回结果` };
    if (r.error) return { error: String(r.error) };
    // 截图类动作把 PNG 落盘路径单独带出来（image_file），由 routes/ai.js 那张口子把图片回喂给模型。
    // 不能让 base64 走这里 —— 它会先被 secret 扫描和审查词表过一遍，一命中就把整回合掐掉。
    const extra = r.image_file ? { image_file: r.image_file } : {};
    if (typeof r.text !== 'string') return { output: JSON.stringify(r, null, 1), ...extra };
    if (!opts.page) return { output: r.text, ...extra };
    const w = pagecap.windowOf(r.text, {
      offset: Math.max(0, Number(args.offset) || 0),
      cap: Math.min(40000, Math.max(500, Number(args.limit) || pagecap.DEFAULT_CAP)),
      prefix: opts.page.prefix,
      key: opts.page.keyOf ? opts.page.keyOf(r) : ''
    });
    // 宿主那头还有一道更大的天花板（防几 MB 的 innerText 拖死 IPC），撞上了它的话要说出来
    return { output: w.text + (r.note ? `\n${r.note}` : ''), ...extra };
  };
}

const TOOLS = {
  browser_open: {
    kind: 'builtin', provider: '内置浏览器', category: '浏览器',
    label: '打开网页',
    source: 'KHarness 桌面端右栏内嵌浏览器',
    doc: '—', cost: '不消耗积分',
    testArg: 'url', testHint: 'https://example.com',
    description: '在应用右侧的内置浏览器里打开一个网址（你会在同一栏看到页面，用户也能看到并直接上手操作）。这是内置浏览器的入口：之后的 snapshot/click/type 都作用于这个页面。只支持 http/https。',
    params: { url: T('要打开的网址') },
    run: runner('browser_open'),
  },
  browser_navigate: {
    kind: 'builtin', provider: '内置浏览器', category: '浏览器',
    label: '跳转网址', source: '内置浏览器', doc: '—', cost: '不消耗积分',
    testArg: 'url',
    description: '让当前标签页跳转到新网址（与 browser_open 的区别只是不换标签）。',
    params: { url: T('目标网址') },
    run: runner('browser_navigate'),
  },
  browser_back: {
    kind: 'builtin', provider: '内置浏览器', category: '浏览器',
    label: '后退', source: '内置浏览器', doc: '—', cost: '不消耗积分',
    description: '浏览器后一页。', params: {},
    run: runner('browser_back'),
  },
  browser_forward: {
    kind: 'builtin', provider: '内置浏览器', category: '浏览器',
    label: '前进', source: '内置浏览器', doc: '—', cost: '不消耗积分',
    description: '浏览器前一页。', params: {},
    run: runner('browser_forward'),
  },
  browser_reload: {
    kind: 'builtin', provider: '内置浏览器', category: '浏览器',
    label: '刷新', source: '内置浏览器', doc: '—', cost: '不消耗积分',
    description: '重新加载当前页面。hard=true 时忽略缓存。',
    params: { hard: { type: 'boolean', required: false, desc: '是否强制刷新（忽略缓存）' } },
    run: runner('browser_reload'),
  },
  browser_snapshot: {
    kind: 'builtin', provider: '内置浏览器', category: '浏览器',
    label: '页面结构快照', source: '内置浏览器', doc: '—', cost: '不消耗积分',
    description: '取当前页面上「可交互元素」的编号清单，每行一条：[编号] 标签:类型/角色 "可读名字" → href'
      + '（不在视口内的会标出来）。后续 click/type 用这个编号（ref）指向元素。'
      + '看页面结构优先用这个，比截图省 token；页面很长时它只给前 150 条并在结尾告诉你总共有多少条，'
      + '要后面的段落就带 offset 继续取。读正文用 browser_text，找某个词在哪用 browser_find。',
    params: {
      limit: { type: 'number', required: false, desc: '最多列多少个元素，默认 150，上限 400' },
      offset: { type: 'number', required: false, desc: '跳过前多少个可交互元素（翻页用），默认 0' }
    },
    run: runner('browser_snapshot'),
  },
  browser_text: {
    kind: 'builtin', provider: '内置浏览器', category: '浏览器',
    label: '读取正文', source: '内置浏览器', doc: '—', cost: '不消耗积分',
    description: '取页面可见正文（innerText）。给 ref/selector 时只取那个子树。'
      + '正文很长时是分页返回的：结尾写着「第 X–Y 字，全文 N 字」，接着读就把它给的 offset 原样传回来'
      + '（不重新导航，读的还是当前这一页；全文同时落了一份文件，路径在结尾给出）。'
      + '只是想确认某句话在不在，用 browser_find；只想看有哪些控件，用 browser_snapshot——别把整篇读进来找一句。',
    params: {
      ref: { type: 'string', required: false, desc: 'browser_snapshot 里的元素编号' },
      selector: { type: 'string', required: false, desc: 'CSS 选择器（与 ref 二选一）' },
      offset: { type: 'number', required: false, desc: '从第几个字符开始返回（上一次结尾提示的 next 值），默认 0' },
      limit: { type: 'number', required: false, desc: '本次最多返回多少字符，默认 8000，上限 40000' },
    },
    run: runner('browser_text', 30000, { page: { prefix: 'browser', keyOf: (r) => r.url || 'page' } }),
  },
  browser_find: {
    kind: 'builtin', provider: '内置浏览器', category: '浏览器',
    label: '页面内找词', source: '内置浏览器', doc: '—', cost: '不消耗积分',
    description: '在当前页面正文里找一个词（不区分大小写），只回命中处的上下文片段和命中总数。'
      + '这是「页面很长但我只关心某句话」的首选：几 KB 就能定位，不用整篇读进上下文。'
      + '命中数很多时说明这个词不唯一，配合 ref/selector 缩小范围或换更长的串。',
    params: {
      query: T('要找的词或短语'),
      context: { type: 'number', required: false, desc: '每处命中前后各取多少字符，默认 160，上限 600' },
      max_hits: { type: 'number', required: false, desc: '最多回几处命中，默认 8，上限 30' },
    },
    run: runner('browser_find', 30000, { page: { prefix: 'browser-find', keyOf: (r) => r.url || 'page' } }),
  },
  browser_click: {
    kind: 'builtin', provider: '内置浏览器', category: '浏览器',
    label: '点击元素', source: '内置浏览器', doc: '—', cost: '不消耗积分',
    description: '点击页面上的元素。优先用 browser_snapshot 给的 ref（编号稳定且带可读名字），也可以直接给 CSS 选择器。点击是真实鼠标事件，站点的风控判定与人工点击一致。',
    params: {
      ref: { type: 'string', required: false, desc: '快照里的元素编号，如 "12"' },
      selector: { type: 'string', required: false, desc: 'CSS 选择器' },
      index: { type: 'number', required: false, desc: '选择器命中多个时取第几个，默认 0' },
    },
    run: runner('browser_click'),
  },
  browser_type: {
    kind: 'builtin', provider: '内置浏览器', category: '浏览器',
    label: '输入文字', source: '内置浏览器', doc: '—', cost: '不消耗积分',
    description: '往输入框里打字（先聚焦并清空，再逐字输入，触发真实 input 事件）。submit=true 时输入完敲回车。',
    params: {
      ref: { type: 'string', required: false, desc: '元素编号' },
      selector: { type: 'string', required: false, desc: 'CSS 选择器' },
      text: T('要输入的内容'),
      submit: { type: 'boolean', required: false, desc: '输入后是否回车' },
    },
    run: runner('browser_type'),
  },
  browser_press: {
    kind: 'builtin', provider: '内置浏览器', category: '浏览器',
    label: '按键', source: '内置浏览器', doc: '—', cost: '不消耗积分',
    description: '敲一个按键：Enter / Escape / Tab / ArrowDown / Backspace 等。',
    params: { key: T('按键名') },
    run: runner('browser_press'),
  },
  browser_scroll: {
    kind: 'builtin', provider: '内置浏览器', category: '浏览器',
    label: '滚动页面', source: '内置浏览器', doc: '—', cost: '不消耗积分',
    description: '滚动当前页面。direction=down|up|top|bottom，amount 为像素（默认一屏）。',
    params: {
      direction: { type: 'string', required: false, desc: 'down|up|top|bottom' },
      amount: { type: 'number', required: false, desc: '滚动像素' },
    },
    run: runner('browser_scroll'),
  },
  browser_select: {
    kind: 'builtin', provider: '内置浏览器', category: '浏览器',
    label: '选择下拉项', source: '内置浏览器', doc: '—', cost: '不消耗积分',
    description: '操作原生 <select>。value 是选项的 value。',
    params: {
      ref: { type: 'string', required: false, desc: '元素编号' },
      selector: { type: 'string', required: false, desc: 'CSS 选择器' },
      value: T('要选中的 option value'),
    },
    run: runner('browser_select'),
  },
  browser_wait_for: {
    kind: 'builtin', provider: '内置浏览器', category: '浏览器',
    label: '等待条件', source: '内置浏览器', doc: '—', cost: '不消耗积分',
    description: '等页面出现某个元素或某段文字，或固定等若干毫秒。SPA 异步渲染时用这个，别靠反复 snapshot 猜。',
    params: {
      selector: { type: 'string', required: false, desc: '等这个选择器出现' },
      text: { type: 'string', required: false, desc: '等正文出现这段文字' },
      ms: { type: 'number', required: false, desc: '都没有时，固定等待毫秒（上限 15000）' },
      timeout_ms: { type: 'number', required: false, desc: '等元素/文字最多等多少毫秒（默认 8000，上限 20000）' },
    },
    run: runner('browser_wait_for', 30000),
  },
  browser_console: {
    kind: 'builtin', provider: '内置浏览器', category: '浏览器',
    label: '读控制台', source: '内置浏览器', doc: '—', cost: '不消耗积分',
    description: '取该页累积的 console 报错与未捕获异常（做网页自检常用）。clear=true 读完清空。',
    params: { clear: { type: 'boolean', required: false, desc: '读完是否清空缓冲' } },
    run: runner('browser_console'),
  },
  browser_screenshot: {
    kind: 'builtin', provider: '内置浏览器', category: '浏览器',
    label: '截图存档', source: '内置浏览器', doc: '—', cost: '不消耗积分',
    description: '把当前页面截图存成 PNG 文件并返回路径（只截当前视口，不能整页）。需要留证据时用；日常看页面直接 browser_snapshot 就够。',
    params: {},
    run: runner('browser_screenshot', 30000),
  },
  browser_screenshot_full: {
    kind: 'builtin', provider: '内置浏览器', category: '浏览器',
    label: '整页截取', source: '内置浏览器', doc: '—', cost: '按图片计 token',
    description: '把整个页面（含滚动区外的部分）截成一张 PNG。**当前模型支持图片时会把这张图直接回喂给你看**，比 browser_text 逐段翻正文快得多，也看得到排版、图表、按钮状态这些文本里没有的东西。多模态模型想看页面就用它；纯文本模型收到的是路径和尺寸说明。页面超高时只截前 12000px 并在结果里说明。',
    params: {},
    run: runner('browser_screenshot_full', 45000),
  },
  screen_capture: {
    kind: 'builtin', provider: '桌面', category: '屏幕',
    label: '全屏截取', source: 'Electron 桌面外壳', doc: '—', cost: '按图片计 token',
    description: '截取整块屏幕画面（不只是本应用窗口：屏幕上开着什么就一起进图）。**高权限操作，任何审批模式下都要用户当场确认，免除审批也不例外**；只在用户明确要你看他的屏幕、或必须看到 KHarness 之外的画面时才用。不传 display 就截鼠标所在那块屏；多屏时先不带参数截一次，返回值会列出每一块屏的序号与分辨率，要换屏照那份编号传 display。本工具与右侧浏览器栏无关，不会打开或操作那一栏。',
    testHint: '试跑：该工具无需参数（会弹审批）',
    params: { display: { type: 'number', required: false, desc: '显示器序号，从 0 开始（0=主屏）；留空取鼠标所在那块。可用的序号与分辨率看上一次返回值里的清单' } },
    run: runner('screen_capture', 30000),
  },
  browser_useragent: {
    kind: 'builtin', provider: '内置浏览器', category: '浏览器',
    label: '切换 UA（手机/电脑）', source: '内置浏览器', doc: '—', cost: '不消耗积分',
    description: '把内置浏览器的 UA 在手机版与电脑版之间切换，并自动重载当前页。**页面按手机版返回内容时用你（模型）主动调这个**：常见于同一个站的手机页/电脑页排版不同、或对方只给移动版渲染出内容。切换会记住（右侧浏览器栏那颗手机/显示器图标就是同一个开关，用户也能手动改）。视口宽度没变，所以有的站仍按宽度断点排版 —— 需要更窄时配合页面缩放或换移动版 URL。',
    testArg: 'mode', testHint: 'mobile',
    params: { mode: { type: 'string', required: true, desc: 'mobile 手机版 / desktop 电脑版' } },
    run: runner('browser_useragent', 30000),
  },
  browser_close: {
    kind: 'builtin', provider: '内置浏览器', category: '浏览器',
    label: '关闭页面', source: '内置浏览器', doc: '—', cost: '不消耗积分',
    description: '把内置浏览器回到空白页（不动用户自己打开的标签）。',
    params: {},
    run: runner('browser_close'),
  },
};

for (const k of Object.keys(TOOLS)) TOOLS[k].defaultOn = true;
toolgate.register(TOOLS);

module.exports = {
  TOOLS, NAMES: Object.keys(TOOLS),
  call, poll, report, status, clientOnline, dropPending,
  PENDING_TTL,
};
