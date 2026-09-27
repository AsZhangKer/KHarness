// 工具参数 schema 单一来源：既用于入参校验，也用于向「文本协议」模型生成格式说明
const TOOL_SCHEMAS = {
  run_command: { command: { type: 'string', required: true, desc: '要执行的 shell 命令' } },
  read_file: { path: { type: 'string', required: true, desc: '文件路径' } },
  write_file: { path: { type: 'string', required: true, desc: '文件路径' }, content: { type: 'string', required: true, desc: '完整文件内容' } },
  edit_file: { path: { type: 'string', required: true, desc: '要替换的原文所在文件路径' }, old_text: { type: 'string', required: true, desc: '要替换的原文（唯一匹配）' }, new_text: { type: 'string', required: true, desc: '替换后的新内容' } },
  list_dir: { path: { type: 'string', required: false, desc: '目录路径，默认当前目录' } },
  grep: { pattern: { type: 'string', required: true, desc: '正则表达式' }, path: { type: 'string', required: false, desc: '搜索的起始目录，默认当前目录' }, include: { type: 'string', required: false, desc: '文件名过滤，如 *.js、*.{ts,vue}' } },
  glob: { pattern: { type: 'string', required: true, desc: '通配符模式，如 **/*.ts、package.json' }, path: { type: 'string', required: false, desc: '查找的起始目录，默认当前目录' } },
  web_fetch: { url: { type: 'string', required: true, desc: '完整的 http/https 地址' } },
  load_skill: { name: { type: 'string', required: true, desc: '技能名称' } },
  use_skill: { name: { type: 'string', required: true, desc: '技能名称' } },
  delete_file: { path: { type: 'string', required: true, desc: '要删除的文件路径（严格模式下进回收站）' } },
  delete_dir: { path: { type: 'string', required: true, desc: '要删除的目录路径（先做整树快照，可撤销恢复；严格模式下进回收站）' } },
  create_dir: { path: { type: 'string', required: true, desc: '要创建的目录路径' } },
  rename_file: { path: { type: 'string', required: true, desc: '原文件路径' }, new_path: { type: 'string', required: true, desc: '新文件路径' } }
};

// 旧工具名 → 新工具名：模型沿用旧调用习惯（或历史轨迹重放）时仍然可用，但不再出现在工具清单里
const TOOL_ALIASES = { search_files: 'grep', find_files: 'glob' };

function resolveToolName(name) {
  const n = String(name || '');
  return TOOL_ALIASES[n] || n;
}

module.exports = { TOOL_SCHEMAS, TOOL_ALIASES, resolveToolName };
