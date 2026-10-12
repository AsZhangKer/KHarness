/**
 * 文案表 · 设置页（第六十八轮第一批：只搬「常规」与「外观」里被他点到的那几条，
 * 后续按板块整页整页迁，搬一页就删一页的硬编码）。
 */
export default {
  // 数字项没读到时输入框留空，得说清楚空着是什么意思（不提交 = 保持服务端现值）
  'settings.unsetPlaceholder': '未设置（用服务端默认值）',
  // 默认 Shell 与自定义 Shell
  'settings.shell.label': '默认 Shell',
  'settings.shell.customLabel': '自定义 Shell 执行器',
  'settings.shell.customPlaceholder': '可执行文件完整路径，如 D:\\Tools\\nu\\nu.exe',
  'settings.shell.apply': '确认',
  'settings.shell.note': '键入自定义 Shell 执行器的可执行文件路径，启用后代替「默认 Shell」选项；路径无效则该命令无法执行。',

  // 上下文自动压缩阈值
  'settings.compress.label': '自动压缩阈值（%，10~95，默认 80）',
  // 子智能体并发上限（判定点 server/utils/subagent.js 的 maxParallelPerChat）
  'settings.agentParallel.label': '子智能体并发上限（0 = 不限，默认 5）',
  'settings.agentParallel.note': '同一条会话里同时在跑的子智能体个数上限，改完立即生效，无需重启。',
  // 服务端回了「已保存」但读回来没有这一项：只有后端版本旧才出这种形状，要直接说人该干什么
  'settings.notStored': '这几项没有存进服务端：{keys}。后端仍在运行旧版本，重启 KHarness 后再保存。',

  // 娱乐挂件（原「小鲸鱼挂件」）
  'settings.whale.label': '娱乐挂件',
  'settings.whale.note': '若取消勾选，配置将被保存',
  'settings.whale.on': '娱乐挂件已开启',
  'settings.whale.off': '娱乐挂件已关闭，配置已保留',

  /* ---- 第七十一轮：他给的文案对照表整页落地 ----
     说明段凡是他标「留空」的都直接删掉了（不留一个空 <p>），
     这里只留他在界面上真会读到的那一句。 */
  'settings.searchPlaceholder': '在设置中搜索……',
  'settings.save': '保存配置',
  'settings.defaultShell.label': '默认 Shell',
  'settings.cmdTimeout.label': '命令超时（秒，0=不限）',
  'settings.defaultContext.label': '默认上下文窗口（token）',
  'settings.retry.rl': '上游限流最大重试次数',
  'settings.retry.gw': '上游断流不可用最大重试次数',

  'settings.agents.title': '全局系统提示词',
  'settings.agents.note': '项目根若有 AGENTS.md 将会与其一同作为系统提示词。',

  'settings.stall.label': '自动中止死循环',
  'settings.roundFold.label': '工具返回值落盘（部分模型出现反复读取问题）',

  'settings.approval.note': '此处规定为缺省值',
  'settings.secret.newLabel': '新规则',

  // 权限规则那四个下拉：他说「以下几个为了防止混淆」——键/类型/规则/值 是重新命名后的一套
  'settings.perm.kind': '键',
  'settings.perm.list': '类型',
  'settings.perm.match': '规则',
  'settings.perm.pattern': '值',
  'settings.perm.note': '备注',
  'settings.perm.testTitle': '权限规则测试',
  'settings.perm.testPaths': '路径',
  'settings.perm.testRun': '检测',

  'settings.skill.name': '名称（推荐仅大小写英语字母、数字、下划线、连接线）',
  'settings.skill.body': '技能内容（使用Markdown语法标注）',

  'settings.mcp.note': '连接到外部MCP Server，管理其工具请转到「工具」页；',

  'settings.lab.fullsend.desc': '将会赋予模型全部权限审查免除，谨慎开启。',
  'settings.lab.cu.desc': '将会赋予模型操作计算机权限，谨慎开启。',
  'settings.lab.img.desc': '将会压缩图片并转码为JPEG格式。',
  'settings.lab.img.maxSide': 'px 最长边（键入"0"则为不限制）',
  'settings.lab.img.note': '将会压缩屏幕截图 / 网页截图，仅应在模型能力有限时开启，会大幅度降低准确度。',

  'settings.about.desc': '开源、自由、无商业化的AI Coding Agent.',
  'settings.db.moveTitle': '迁移数据库',
  'settings.db.moveNote': '修改后需要重启KHarness.',
  'settings.factory.confirmLabel': '键入文本以确认',
};
