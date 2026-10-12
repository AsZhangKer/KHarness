/**
 * 文案表 · 聊天页与内嵌浏览器（第六十八轮第二批）。
 *
 * 这一批里有两类话：给他看的（右栏空态），和**回喂给模型的**（内嵌浏览器那句失败原因）。
 * 后者同样要专业化，但不能为了好听丢掉信息 —— 模型全靠这句话判断下一步换什么方案，
 * 所以变量（实际尺寸、期望尺寸、缩放倍数）一律保留。
 * 术语统一：「浏览器栏」→「内嵌浏览器」，「栏位」→「面板」。
 */
export default {
  // 右栏 · 待注入提示词（命令本身要敲，所以 /insert 这个名词留着）
  'chat.dock.insertEmpty1': '暂无，使用 ',
  'chat.dock.insertEmpty2': ' 插话',

  // 右栏 · 后台任务
  'chat.dock.bgEmpty': '暂无后台任务',
  // 后台任务按会话隔离之后，别的会话起的仍然在跑，只是这一栏不列出来 —— 说一句免得以为没跑
  'chat.dock.bgHidden': '另有 {n} 个后台任务属于其他会话（它们仍在跑，只是不在这一栏里）。',

  // 右栏 · 计划任务与子智能体（第七十一轮：不再在空态里讲课）
  'chat.dock.planEmpty': '暂无计划任务。',
  'chat.dock.agentEmpty': '还没有子智能体。若需使用，请在「设置 - 工具 - 子智能体」启用。',
  // 第七十五轮：点卡片看它到底跑了哪些步 + 停止那颗键
  'chat.agent.steps': '查看步骤',
  'chat.agent.modalTitle': '子智能体 {name} · 执行步骤',
  'chat.agent.stepsEmpty': '这一趟没有留下执行轨迹（一步就出结论的活也会有正文，这里通常是记录没落上）。',
  'chat.agent.stepsWaiting': '还在等它的第一步……',
  'chat.agent.stop': '停止',
  'chat.agent.stopAll': '全部停止',
  'chat.agent.stopAllConfirm': '停下本会话还在跑的 {n} 个子智能体？它们查到一半的进度会丢（已跑出的轨迹留着）。',
  'chat.agent.close': '关闭',
  // 第七十七轮：结论不再画气泡，全文只在这扇详情窗的结尾给
  'chat.agent.conclusion': '交回的结论',
  'chat.agent.remove': '删除记录',
  'chat.agent.stQueued': '排队中',
  'chat.agent.stRunning': '运行中',
  'chat.agent.stDone': '已交回',
  'chat.agent.stFailed': '失败',
  'chat.agent.stKilled': '已停止',

  // 右栏 · 修改历史（第七十六轮：展开改成「审阅」弹窗，撤销那颗红键搬进弹窗）
  'chat.hist.review': '审阅',
  'chat.hist.modalTitle': '审阅 · {name}',
  'chat.hist.undo': '撤销这次改动',
  'chat.hist.undone': '已撤销',
  'chat.hist.undoConfirm': '把 {name} 退回这次改动之前的样子？',
  'chat.hist.noDiff': '这次改动没有留下逐行对照。',
  'chat.hist.hidden': '另有 {n} 行未显示。',

  // 消息流 · 压缩卡的第一行（{thr} 是当时生效的阈值，由后端随卡片一起给，前端不写死）
  'chat.msg.compressManual': '正在压缩上下文… {used}/{limit} tok（{pct}{src}）',
  'chat.msg.compressAuto': '上下文 {used}/{limit} tok（{pct}{src}）已达 {thr}% → 先压缩再回答',
  // 老落库数据里没有阈值字段，宁可少说半句也不许编一个 80% 出来（他改了设置还显示 80% 就是这么来的）
  'chat.msg.compressAutoNoThr': '上下文 {used}/{limit} tok（{pct}{src}）已达压缩线 → 先压缩再回答',

  // 上下文弹窗里的说明（不写具体百分比：那是「设置 → 常规」里那个可调的值，写死就会与设置打架）
  'chat.ctx.compressHint': '用量达到「设置 → 常规」里的自动压缩阈值时自动压缩；上下文窗口若未单独设定，将退回「设置 → 常规」的默认窗口。',

  // 输入框上方那条信息横条：两个读数各自的口径要说清楚（首字取服务端实测，速度不含工具执行时间）
  'chat.meta.ttft': '请求发出到上游第一个字（思考、正文、工具调用谁先到算谁）；回合结束后换成服务端实测值',
  'chat.meta.speed': '跑动中是近 2 秒的平均速率，每 0.2 秒刷一次；回合结束换成这一回合的平均（思考与正文都算，工具执行时间不算）',

  // 内嵌浏览器 · 就位检查的失败原因（其中两条会作为工具结果回喂给模型）
  'chat.browser.viewportBad': '视口未就绪（视图 {iw}×{ih}，应为 {w}×{h}{zoom}）',
  'chat.browser.zoom': '，界面缩放 {z}×',
  'chat.browser.hidden': '视图仍处于隐藏状态（尺寸 {w}×{h}，面板 {pw}×{ph}）',
  // 展开有 0.18s 宽度过渡，量不到洞通常是这一栏还没撑开 —— 报真实尺寸比「无法正确渲染」有用
  'chat.browser.noHole': '浏览器栏还没有可用的显示区域（这一栏量到 {w}×{h}），动作未执行',
  'chat.browser.notReady': '视图或视口未就绪',
  'chat.browser.initFail': '内嵌浏览器初始化失败：{why}，动作未执行',
};
