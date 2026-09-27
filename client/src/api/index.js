import axios from 'axios';
import { toastErr } from '../utils/errText';

const http = axios.create({ baseURL: '/api', timeout: 30000 });

http.interceptors.response.use(
  (res) => res.data,
  (err) => {
    // 概括进 toast，全量报告（含请求、状态、异常链、最近日志）挂在 toast 上供点击复制；
    // 有地方的界面自己取 errFull() 显示
    const cfg = err?.config || {};
    const request = `${(cfg.method || 'GET').toUpperCase()} ${cfg.url || ''}`.trim();
    toastErr(err, '请求失败', 3500, {
      request,
      status: err?.response?.status,
      code: err?.response?.data?.code,
    });
    return Promise.reject(err);
  }
);

function pick(res) {
  // 统一 { code, data } 信封
  return res && typeof res === 'object' && 'data' in res ? res.data : res;
}

export const aiApi = {
  // status / providers / models
  getStatus: () => http.get('/ai/status').then(pick),
  getProviders: () => http.get('/ai/providers').then(pick),
  createProvider: (b) => http.post('/ai/providers', b).then(pick),
  updateProvider: (id, b) => http.put(`/ai/providers/${id}`, b).then(pick),
  deleteProvider: (id) => http.delete(`/ai/providers/${id}`).then(pick),
  getRemoteModels: (id) => http.get(`/ai/providers/${id}/remote-models`).then(pick),
  pingProviders: (timeout) =>
    http.post('/ai/providers/ping', timeout ? { timeout } : {}, { timeout: 30000 }).then(pick),
  getModels: () => http.get('/ai/models').then(pick),
  createModel: (b) => http.post('/ai/models', b).then(pick),
  batchCreateModels: (b) => http.post('/ai/models/batch', b).then(pick),
  updateModel: (id, b) => http.put(`/ai/models/${id}`, b).then(pick),
  deleteModel: (id) => http.delete(`/ai/models/${id}`).then(pick),
  batchDeleteModels: (ids) => http.post('/ai/models/batch-delete', { ids }).then(pick),
  toggleModelDisabled: (id, disabled) =>
    http.patch(`/ai/models/${id}/disabled`, { disabled }).then(pick),
  setModelToolStyle: (id, tool_style, reset_thinking) =>
    http.patch(`/ai/models/${id}/tool-style`, { tool_style, reset_thinking }).then(pick),
  batchModelToolStyle: (b) => http.post('/ai/models/batch-tool-style', b).then(pick),
  testAll: () => http.post('/ai/test', {}, { timeout: 600000 }).then(pick),
  testOne: (model_id) => http.post('/ai/test', { model_id }, { timeout: 120000 }).then(pick),
  testMany: (model_ids) => http.post('/ai/test', { model_ids }, { timeout: 600000 }).then(pick),

  // projects / chats
  getProjects: () => http.get('/ai/projects').then(pick),
  createProject: (b) => http.post('/ai/projects', b).then(pick),
  updateProject: (id, b) => http.put(`/ai/projects/${id}`, b).then(pick),
  deleteProject: (id, confirm) =>
    http.delete(`/ai/projects/${id}`, { params: confirm ? { confirm: 1 } : {} }).then(pick),
  reorderProjects: (ids) => http.post('/ai/projects/reorder', { ids }).then(pick),
  getChats: () => http.get('/ai/chats').then(pick),
  createChat: (b) => http.post('/ai/chats', b).then(pick),
  getChat: (id) => http.get(`/ai/chats/${id}`).then(pick),
  deleteChat: (id) => http.delete(`/ai/chats/${id}`).then(pick),
  // 回收站（会话 / 项目快照）
  trashList: () => http.get('/ai/trash').then(pick),
  trashRestore: (id) => http.post(`/ai/trash/${id}/restore`, {}).then(pick),
  trashRemove: (id) => http.delete(`/ai/trash/${id}`).then(pick),
  trashClear: () => http.delete('/ai/trash').then(pick),
  updateChatSettings: (id, b) => http.patch(`/ai/chats/${id}/settings`, b).then(pick),
  reorderChats: (ids) => http.post('/ai/chats/reorder', { ids }).then(pick),
  fetchMaxContext: (id) => http.post(`/ai/chats/${id}/fetch-max-context`, {}, { timeout: 15000 }).then(pick),

  // 远程主机（SSH/SFTP）：列表不回显密钥，编辑时 secret/private_key 留空 = 不改
  getRemoteHosts: () => http.get('/ai/remote/hosts').then(pick),
  createRemoteHost: (b) => http.post('/ai/remote/hosts', b).then(pick),
  updateRemoteHost: (id, b) => http.put(`/ai/remote/hosts/${id}`, b).then(pick),
  // 有下属项目/会话时后端回 409，confirm=1 才级联删
  deleteRemoteHost: (id, confirm) =>
    http.delete(`/ai/remote/hosts/${id}`, { params: confirm ? { confirm: 1 } : {} }).then(pick),
  reorderRemoteHosts: (ids) => http.post('/ai/remote/hosts/reorder', { ids }).then(pick),
  testRemoteHost: (id) => http.post(`/ai/remote/hosts/${id}/test`, {}, { timeout: 40000 }).then(pick),
  remoteExec: (id, b) => http.post(`/ai/remote/hosts/${id}/exec`, b, { timeout: 620000 }).then(pick),
  remoteList: (id, path) => http.get(`/ai/remote/hosts/${id}/files`, { params: { path } }).then(pick),
  remoteRead: (id, path) => http.get(`/ai/remote/hosts/${id}/file`, { params: { path }, timeout: 60000 }).then(pick),
  remoteWrite: (id, b) => http.post(`/ai/remote/hosts/${id}/file`, b, { timeout: 60000 }).then(pick),
  remoteMkdir: (id, b) => http.post(`/ai/remote/hosts/${id}/mkdir`, b).then(pick),
  remoteRename: (id, b) => http.post(`/ai/remote/hosts/${id}/rename`, b).then(pick),
  remoteDelete: (id, b) => http.post(`/ai/remote/hosts/${id}/delete`, b, { timeout: 60000 }).then(pick),

  // 终端抽屉（输出走 EventSource，这里只有控制面）
  termOptions: () => http.get('/ai/term/options').then(pick),
  termFonts: () => http.get('/ai/term/fonts').then(pick),
  termCustom: (terminals) => http.post('/ai/term/custom', { terminals }).then(pick),
  termTitle: (id, title) => http.post(`/ai/term/${id}/title`, { title }).then(pick),
  termDump: (id) => http.get(`/ai/term/${id}/dump`).then(pick),
  termArchive: (id) => http.post(`/ai/term/${id}/archive`, {}).then(pick),
  termList: () => http.get('/ai/term').then(pick),
  termOpen: (b) => http.post('/ai/term/open', b, { timeout: 60000 }).then(pick),
  termInput: (id, b) => http.post(`/ai/term/${id}/input`, b),
  termResize: (id, b) => http.post(`/ai/term/${id}/resize`, b),
  termClose: (id) => http.post(`/ai/term/${id}/close`, {}),

  // agent
  getAgentInfo: () => http.get('/ai/agent/info').then(pick),
  setCwd: (path, chat_id, base) => http.post('/ai/chat/cwd', { path, chat_id, base }).then(pick),
  // @文件提及的候选：本地列 fs、远程列 SFTP，只列一层（输入框补全用）
  fsLs: (params) => http.get('/ai/fs/ls', { params, timeout: 15000 }).then(pick),
  approve: (b) => http.post('/ai/chat/approve', b, { timeout: 60000 }).then(pick),
  answerQuestion: (b) => http.post('/ai/chat/answer', b, { timeout: 30000 }).then(pick),
  toolTimeout: (chat_id) => http.post('/ai/chat/tool-timeout', { chat_id }, { timeout: 30000 }).then(pick),
  // 不走 pick：要把「用哪个模型压的、摘要多少字」这句 message 带回界面
  pressChat: (b) => http.post('/ai/chat/press', b, { timeout: 120000 }),
  setContext: (b) => http.post('/ai/chat/context', b, { timeout: 120000 }).then(pick),
  systemNotify: (b) => http.post('/ai/notify', b, { timeout: 25000 }).then(pick),
  retractChat: (b) => http.post('/ai/chat/retract', b, { timeout: 60000 }).then(pick),
  uploadChatFile: (formData) =>
    http.post('/ai/chat/upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 60000,
    }).then(pick),

  // approval mode
  getApprovalMode: () => http.get('/ai/approval-mode').then(pick),
  setApprovalMode: (mode) => http.put('/ai/approval-mode', { mode }).then(pick),
  overrideApprovalMode: (mode, chat_id) =>
    http.post('/ai/approval-mode/override', { mode, chat_id }).then(pick),

  // undo
  undo: (op_id, chat_id, message_id) =>
    http.post('/ai/undo', { op_id, chat_id, message_id }, { timeout: 30000 }).then(pick),
  undoStatus: (opId) => http.get(`/ai/undo/${encodeURIComponent(opId)}`).then(pick),

  // 上下文导入 / 导出（导入的正文可能几 MB，超时放宽）
  // importContext 不走 pick：要把服务端「原模型不在本机，已改用 X」这类 message 带回去
  exportContext: (chat_id, raw = false) =>
    http.get(`/ai/chats/${chat_id}/context`, { params: raw ? { raw: 1 } : {}, timeout: 60000 }).then(pick),
  importContext: (payload) =>
    http.post('/ai/chats/import', payload, { timeout: 120000 }),

  // permissions
  getPermissions: () => http.get('/ai/permissions').then(pick),
  createPermission: (b) => http.post('/ai/permissions', b).then(pick),
  updatePermission: (id, b) => http.put(`/ai/permissions/${id}`, b).then(pick),
  deletePermission: (id) => http.delete(`/ai/permissions/${id}`).then(pick),
  testPermission: (b) => http.post('/ai/permissions/test', b).then(pick),

  // tools
  getApiTools: () => http.get('/ai/tools').then(pick),
  updateApiTool: (name, b) => http.put(`/ai/tools/${encodeURIComponent(name)}`, b).then(pick),
  testApiTool: (name, args) =>
    http.post(`/ai/tools/${encodeURIComponent(name)}/test`, { args }, { timeout: 180000 }).then(pick),
  /** 整组开关：一个套装十几个工具，逐个点不叫功能 */
  bulkTools: (names, enabled) => http.post('/ai/tools/bulk', { names, enabled }).then(pick),

  // 整库导出 / 导入（导入只是暂存，重启才应用）
  getDatabase: () => http.get('/ai/database').then(pick),
  importDatabase: (file) => http.post('/ai/database/import', file, {
    headers: { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name || 'import.db') },
    timeout: 600000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  }).then((r) => r.data),
  cancelDatabaseImport: () => http.post('/ai/database/import/cancel').then(pick),

  // 内置浏览器：动作由服务端排队、桌面窗口长轮询取走执行
  browserPoll: () => http.get('/ai/browser/poll', { timeout: 40000 }).then(pick),
  browserReport: (b) => http.post('/ai/browser/report', b).then(pick),
  browserStatus: () => http.get('/ai/browser/status').then(pick),

  // 侧栏提问：只读旁路助手，线程与消息在服务端落库（流式走 chatStream 的 openSidebarStream）
  sidebarThreads: () => http.get('/ai/sidebar/threads').then(pick),
  sidebarThread: (id) => http.get('/ai/sidebar/thread', { params: { id } }).then(pick),
  createSidebarThread: (b) => http.post('/ai/sidebar/thread', b).then(pick),
  renameSidebarThread: (id, title) => http.post('/ai/sidebar/thread/rename', { id, title }).then(pick),
  deleteSidebarThread: (id) => http.post('/ai/sidebar/thread/delete', { id }).then(pick),

  // AI 监工：清单预览与历史（跑一轮走 chatStream 的 openSuperviseStream）
  superviseChecks: (chat_id) => http.get('/ai/supervise/checks', { params: chat_id ? { chat_id } : {} }).then(pick),
  superviseRuns: (limit = 10) => http.get('/ai/supervise/runs', { params: { limit } }).then(pick),

  // 托管模式（监工 ⇄ 工作者）：跑那一整场走 SSE（openHostedStream），这里只管停与查
  hostedStop: (chat_id) => http.post('/ai/hosted/stop', { chat_id }).then(pick),
  hostedStatus: (chat_id) => http.get('/ai/hosted/status', { params: { chat_id } }).then(pick),

  // MCP 服务器（外部能力接入；发现出来的工具走上面同一套 tools 开关与试跑）
  getMcpServers: () => http.get('/ai/mcp/servers').then(pick),
  createMcpServer: (b) => http.post('/ai/mcp/servers', b).then((r) => r.data),
  updateMcpServer: (id, b) => http.put(`/ai/mcp/servers/${id}`, b).then((r) => r.data),
  deleteMcpServer: (id) => http.delete(`/ai/mcp/servers/${id}`).then(pick),
  reconnectMcpServer: (id) => http.post(`/ai/mcp/servers/${id}/reconnect`).then((r) => r.data),

  // insert / skills
  getInsert: (chatId) => http.get(`/ai/chats/${chatId}/insert`).then(pick),
  addInsert: (chatId, text) => http.post(`/ai/chats/${chatId}/insert`, { text }).then(pick),
  clearInsert: (chatId) => http.delete(`/ai/chats/${chatId}/insert`).then(pick),
  getChatSkills: (chatId) => http.get(`/ai/chats/${chatId}/skills`).then(pick),
  setChatSkills: (chatId, loaded) => http.put(`/ai/chats/${chatId}/skills`, { loaded }).then(pick),
  getSkills: () => http.get('/ai/skills').then(pick),
  importSkill: (b) => http.post('/ai/skills', b).then(pick),
  deleteSkill: (name) => http.delete(`/ai/skills/${encodeURIComponent(name)}`).then(pick),

  // tasks / usage / trace / secrets / shell
  getTasks: (chat_id) => http.get('/ai/tasks', { params: { chat_id } }).then(pick),
  updateTask: (id, b) => http.patch(`/ai/tasks/${id}`, b).then(pick),
  getUsage: (days) => http.get('/ai/usage/summary', { params: { days }, timeout: 30000 }).then(pick),
  searchTrace: (params) => http.get('/ai/trace/search', { params, timeout: 30000 }).then(pick),
  getSecrets: () => http.get('/ai/secrets').then(pick),
  createSecret: (b) => http.post('/ai/secrets', b).then(pick),
  deleteSecret: (id) => http.delete(`/ai/secrets/${id}`).then(pick),
  getShell: () => http.get('/ai/shell').then(pick),
  setShell: (shell) => http.put('/ai/shell', { shell }).then(pick),
  checkAgentsMd: (params) => http.get('/ai/agents-md', { params }).then(pick),
  // 编辑提示词文件：只认 scope=global 或 project_id（目录由服务端从库里取，前端不能指路径）
  agentsFile: (params) => http.get('/ai/agents-file', { params, timeout: 20000 }).then(pick),
  saveAgentsFile: (b) => http.put('/ai/agents-file', b, { timeout: 25000 }).then(pick),
  // 小鲸鱼挂件：配置存在 settings.whale_widget 里，挂件自己的菜单与设置页共用一份
  whaleConfig: () => http.get('/ai/whale/config').then(pick),
  saveWhaleConfig: (b) => http.put('/ai/whale/config', b).then(pick),
  gitStatus: (b) => http.post('/ai/git/status', b || {}, { timeout: 15000 }).then(pick),
  gitCheckout: (b) => http.post('/ai/git/checkout', b, { timeout: 15000 }).then(pick),
  gitCommit: (b) => http.post('/ai/git/commit', b, { timeout: 30000 }).then(pick),
  gitPush: (b) => http.post('/ai/git/push', b, { timeout: 60000 }).then(pick),
  gitChanges: (b) => http.post('/ai/git/changes', b || {}, { timeout: 25000 }).then(pick),
  revealPath: (path) => http.post('/ai/reveal', { path }, { timeout: 10000 }).then(pick),
  // 后台任务（右栏「后台」页）
  getBackground: () => http.get('/ai/background', { timeout: 10000 }).then(pick),
  killBackground: (id) => http.post('/ai/background/kill', { id }, { timeout: 15000 }).then(pick),

  // 子智能体
  getSubagents: (chat_id) => http.get('/ai/subagents', { params: chat_id ? { chat_id } : {}, timeout: 10000 }).then(pick),
  getSubagent: (id) => http.get(`/ai/subagents/${encodeURIComponent(id)}`, { timeout: 10000 }).then(pick),
  spawnSubagent: (b) => http.post('/ai/subagents/spawn', b, { timeout: 20000 }),
  killSubagent: (agent_id) => http.post('/ai/subagents/kill', { agent_id }, { timeout: 15000 }),
  deleteSubagent: (agent_id) => http.post('/ai/subagents/delete', { agent_id }, { timeout: 15000 }),
};

export const settingsApi = {
  getAll: () => http.get('/settings').then(pick),
  update: (b) => http.put('/settings', b).then(pick),
};

export default { aiApi, settingsApi };
