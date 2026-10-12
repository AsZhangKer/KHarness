// KHarness 默认种子设置（database.js 初始化用）

const DEFAULT_SETTINGS = {
  site_name: 'KHARNESS',
  site_description: '本地 AI Harness',
  site_icon: '/imgs/icon.png',
  footer_text: 'KHarness · 本地 AI 工具箱',
  icp_number: '',
  maintenance_mode: '0',
  maintenance_message: '',
  agent_shell: '',
  include_usage: '1',
  rl_retry_max: '16',
  default_context_limit: '0',
  // 提示音（Web Audio 合成，四类事件共用一个总闸与音量）
  sound_enabled: '1',
  sound_volume: '0.6',
  // 压缩历史时保留最近多少条原文，其余总结成摘要；0 = 一条都不留，全压进摘要
  compress_keep_messages: '2',
  // 上下文自动压缩阈值（占窗口的百分比）。以前只在代码里写死 80%，库里没这一行，
  // 设置页就只能显示空白 +「未设置」—— 现在种子化，界面显示的就是生效的那个数。
  // 老库启动时由 insertDefaultData() 的 INSERT OR IGNORE 补上，不会盖掉已有值。
  compress_threshold: '80',
  // 同一条会话同时在跑的子智能体上限；0 = 不限。判定点 server/utils/subagent.js 的 maxParallelPerChat。
  // 第七十六轮从写死的 4 挪到这里，老库靠 INSERT OR IGNORE 补这一行，不会盖掉用户已存的值。
  subagent_max_parallel: '5',
  // 审批横幅挂着等多久没人处理就按「拒绝」收掉（秒）
  approval_timeout_seconds: '180',
  // 纯前端显示偏好，放服务端是为了换机器/重开窗口后还是老样子
  reasoning_default_open: '0',
  long_reply_collapse: '1',
  tool_call_collapse: '0',
  // 全局代理总闸：开（'1'）时所有提供商即使勾了「代理」也直连
  proxy_disabled: '0',
  // 内置浏览器用哪种 UA：desktop / mobile（界面开关与 browser_useragent 工具共用这一条）
  browser_ua_mode: 'desktop'
};

module.exports = { DEFAULT_SETTINGS };
