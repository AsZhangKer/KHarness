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
  // 审批横幅挂着等多久没人处理就按「拒绝」收掉（秒）
  approval_timeout_seconds: '180',
  // 纯前端显示偏好，放服务端是为了换机器/重开窗口后还是老样子
  reasoning_default_open: '0',
  long_reply_collapse: '1',
  tool_call_collapse: '0'
};

module.exports = { DEFAULT_SETTINGS };
