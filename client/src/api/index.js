import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  timeout: 10000
});

// 桌面端 harness 无鉴权：不需要 token 注入与 401/503 处理
api.interceptors.response.use(
  response => response.data,
  error => Promise.reject(error)
);

export const settingsApi = {
  getAll: () => api.get('/settings')
};

export const aiApi = {
  getStatus: () => api.get('/ai/status'),
  getProviders: () => api.get('/ai/providers'),
  createProvider: (data) => api.post('/ai/providers', data),
  updateProvider: (id, data) => api.put(`/ai/providers/${id}`, data),
  deleteProvider: (id) => api.delete(`/ai/providers/${id}`),
  getModels: () => api.get('/ai/models'),
  getRemoteModels: (providerId) => api.get(`/ai/providers/${providerId}/remote-models`),
  createModel: (data) => api.post('/ai/models', data),
  batchCreateModels: (data) => api.post('/ai/models/batch', data),
  updateModel: (id, data) => api.put(`/ai/models/${id}`, data),
  deleteModel: (id) => api.delete(`/ai/models/${id}`),
  batchDeleteModels: (ids) => api.post('/ai/models/batch-delete', { ids }),
  toggleModelDisabled: (id, disabled) => api.patch(`/ai/models/${id}/disabled`, { disabled }),
  pingProviders: (timeout) => api.post('/ai/providers/ping', timeout ? { timeout } : {}, { timeout: 30000 }),
  // 测试全部模型可能耗时较久，单独放宽超时
  testAll: () => api.post('/ai/test', {}, { timeout: 600000 }),
  testOne: (modelId) => api.post('/ai/test', { model_id: modelId }, { timeout: 120000 }),
  getChats: (modelRowId) => api.get('/ai/chats', { params: { model_row_id: modelRowId } }),
  createChat: (data) => api.post('/ai/chats', data),
  getChat: (id) => api.get(`/ai/chats/${id}`),
  deleteChat: (id) => api.delete(`/ai/chats/${id}`),
  updateChatSettings: (id, data) => api.patch(`/ai/chats/${id}/settings`, data),
  fetchMaxContext: (id) => api.post(`/ai/chats/${id}/fetch-max-context`, {}, { timeout: 15000 }),
  // 项目与会话分离
  getProjects: () => api.get('/ai/projects'),
  createProject: (data) => api.post('/ai/projects', data),
  updateProject: (id, data) => api.put(`/ai/projects/${id}`, data),
  deleteProject: (id, confirmed) => api.delete(`/ai/projects/${id}`, { params: confirmed ? { confirm: 1 } : {} }),
  uploadChatFile: (formData) => api.post('/ai/chat/upload', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 60000
  }),
  getAgentInfo: () => api.get('/ai/agent/info'),
  setCwd: (path, chatId, base) => api.post('/ai/chat/cwd', { path, chat_id: chatId, base }),
  retractChat: (data) => api.post('/ai/chat/retract', data, { timeout: 60000 }),
  approve: (data) => api.post('/ai/chat/approve', data, { timeout: 60000 }),
  pressChat: (data) => api.post('/ai/chat/press', data, { timeout: 120000 }),
  setContext: (data) => api.post('/ai/chat/context', data, { timeout: 120000 }),
  // 任务列表（Plan 模式）
  getTasks: (chatId) => api.get('/ai/tasks', { params: { chat_id: chatId } }),
  updateTask: (id, data) => api.patch(`/ai/tasks/${id}`, data),
  // AGENTS.md 预检（新建会话前估算 token 成本）
  checkAgentsMd: (params) => api.get('/ai/agents-md', { params }),
  // Shell 设置
  getShell: () => api.get('/ai/shell'),
  setShell: (shell) => api.put('/ai/shell', { shell }),
  // 敏感数据表
  getSecrets: () => api.get('/ai/secrets'),
  createSecret: (data) => api.post('/ai/secrets', data),
  deleteSecret: (id) => api.delete(`/ai/secrets/${id}`),
  // 用量统计
  getUsage: (days) => api.get('/ai/usage/summary', { params: { days }, timeout: 30000 }),
  // 技能
  getSkills: () => api.get('/ai/skills'),
  importSkill: (data) => api.post('/ai/skills', data),
  deleteSkill: (name) => api.delete(`/ai/skills/${encodeURIComponent(name)}`),
  // 轨迹检索
  searchTrace: (params) => api.get('/ai/trace/search', { params, timeout: 30000 }),
  // OOBE 首次启动向导
  getOobe: () => api.get('/ai/oobe'),
  finishOobe: (data) => api.post('/ai/oobe/finish', data, { timeout: 30000 }),
  resetOobe: () => api.post('/ai/oobe/reset', {}, { timeout: 30000 })
};

export default api;
