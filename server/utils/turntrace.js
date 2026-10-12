/**
 * 中断回合的工具轨迹清单（#267）。
 *
 * 为什么要它：跨轮重建上文只 `SELECT role, content`（routes/ai.js 的 buildBaseMsgs），
 * `steps_json` 落了库也没有第二个读者 —— 于是一轮被上游报错打断、一个字没吐时，
 * 入库那一整条又被 `if (fullReply.trim())` 卡住不写，下一轮完全不知道刚才读过哪个文件、改过哪张表。
 * 这里把已经执行的部分压成一小段文字，由调用方接在 assistant 正文后面（**只给中断的回合**，
 * 正常回合不写：模型自己那段回复已经说了它做了什么，再抄一遍纯粹是撑上下文）。
 *
 * 形状是刻意挑的：一行一步、参数与结果各截一段、末尾单列本轮碰过的文件。
 * 模型要的是「我做到哪了」，不是把几十 KB 的工具输出再读一遍 —— 上限 40 步 / 8000 字。
 */

const DIGEST_MAX_STEPS = 40;
const DIGEST_MAX_CHARS = 8000;
const ARG_MAX = 120;
const OUT_MAX = 200;

/** 会真的动到文件的几个工具：清单末尾要把它们列出来（接着做时最想知道的就是哪些已经被改过） */
const FILE_TOOLS = new Set(['write_file', 'edit_file', 'delete_file', 'create_dir', 'delete_dir', 'rename_file']);

/** 压成一行并截断：清单是喂给模型看的，换行会把「一步一行」的结构打散 */
function oneLine(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/**
 * @param steps runAgent 那份 steps 数组（{type:'tool'|'result'|'text'|'note'|'compress', ...}）
 * @returns 清单正文；一步都没有时返回空串（调用方据此决定要不要追加）
 */
function traceDigest(steps) {
  const list = Array.isArray(steps) ? steps : [];
  const lines = [];
  const files = new Set();
  // 调用行与结果行是两条：结果行自己不带 args，用紧邻的那条调用补上
  let pendingArgs = null;
  let truncated = false;

  for (const st of list) {
    if (!st || !st.type) continue;
    if (st.type === 'tool') { pendingArgs = st.args; continue; }
    if (st.type !== 'result') continue;   // text / note / compress 都不是「动手」，不进清单
    if (lines.length >= DIGEST_MAX_STEPS) { truncated = true; break; }

    const args = st.args || pendingArgs;
    pendingArgs = null;
    const argText = args ? oneLine(typeof args === 'string' ? args : JSON.stringify(args), ARG_MAX) : '';
    let tail;
    if (st.error) tail = ` → 失败：${oneLine(st.error, OUT_MAX)}`;
    else if (st.open) tail = ' →（发起了，没执行完）';
    else tail = ` → ${oneLine(st.output, OUT_MAX) || '(无输出)'}`;
    lines.push(`${lines.length + 1}. ${st.name || 'tool'}${argText ? ` ${argText}` : ''}${tail}`);

    if (FILE_TOOLS.has(st.name)) {
      const p = st.path || (args && (args.path || args.new_path || args.to)) || '';
      if (p) files.add(String(p));
    }
  }
  if (!lines.length) return '';

  const head = '[本轮未完成即被打断，以下是已经执行过的工具调用，接着做时不要重复这些步骤]';
  const foot = truncated ? `…（还有更多步骤未列出）` : '';
  const fileList = files.size ? `\n本轮动过的文件：${[...files].join('、')}` : '';
  const note = '\n[以上由系统按中断回合自动记录，不是用户说的话]';
  let text = `${head}\n${lines.join('\n')}${foot}${fileList}${note}`;
  if (text.length > DIGEST_MAX_CHARS) {
    // 先给截断标记腾出位置再切，否则"上限 8000"实际会漏到 8011
    const tail = '\n…（清单过长已截断）';
    text = text.slice(0, DIGEST_MAX_CHARS - tail.length) + tail;
  }
  return text;
}

module.exports = { traceDigest, DIGEST_MAX_STEPS, DIGEST_MAX_CHARS };
