<template>
  <div class="page">
    <header class="page-head">
      <div>
        <h1>设置</h1>
        <p>Shell、MCP、权限等……</p>
      </div>
    </header>

    <KTabs v-model="tab" :items="tabs" />

    <!-- 切分页时整块淡入推出一点：keyed Transition 保证旧的先走、新的再进，不会两屏内容叠在一起 -->
    <Transition name="pane" mode="out-in">
      <div :key="tab" class="pane-wrap">
    <!-- 常规 -->
    <section v-show="tab === 'general'" class="card">
      <h3>Shell执行器</h3>
      <div class="form">
        <label class="field">
          <span>默认 Shell</span>
          <KDropdown :items="shellItems" v-model="shell" block width="100%" />
        </label>
        <!-- 候选列表以外的那个 Shell（比如装在 D:\Tools 下的 portable busybox / nu）以前没法选，
             所以这里给一个直接填路径的口子；存的是同一条 agent_shell，服务端会校验文件能不能执行 -->
        <label class="field">
          <span>自定义 Shell 路径</span>
          <div class="shell-custom">
            <KInput v-model="shellCustom" placeholder="可执行文件完整路径，如 D:\Tools\nu\nu.exe" block />
            <button class="k-btn sm" type="button" @click="applyShellCustom">用这个</button>
          </div>
        </label>
        <p class="field-note">填了「用这个」后立刻生效（覆盖上面下拉选的那个）；路径不存在或不可执行会被服务端拒绝，不会把 Agent 的 Shell 设成一个跑不起来的东西。</p>
        <KInput v-model="cmdTimeout" label="命令超时（秒，0=不限）" type="number" block />
        <KInput v-model="defaultContext" label="默认上下文窗口（token）" type="number" block />
        <KInput v-model="rlRetryMax" label="上游 429 最大重试" type="number" block />
        <button class="k-btn primary sm" type="button" @click="saveUpstream">
          <i class="fas fa-floppy-disk"></i> 保存上游设置
        </button>
      </div>
    </section>

    <!-- 常规 · 全局提示词：所有本机会话都会带上的那一份 AGENTS.md -->
    <section v-show="tab === 'general'" class="card">
      <h3>全局提示词</h3>
      <div class="form">
        <p class="muted gp-note">
          这份文件会作为「知识库」或「长期记忆」、「系统提示词」合并进每一次请求的头部；
          项目根目录里的 <code>AGENTS.md</code> 会合并进它后面；保存后回到主页生效。
        </p>
        <div class="field">
          <span>文件</span>
          <div class="gp-line">
            <code class="gp-path" :title="gpInfo.path">{{ gpInfo.path || '正在读取…' }}</code>
            <span class="gp-state" :class="{ new: !gpInfo.exists }">
              {{ gpInfo.exists ? `约 ${gpInfo.tokens} tok` : '还没有，编辑保存即新建' }}
            </span>
            <button class="k-btn sm" type="button" @click="gpOpen = true">
              <i class="fas fa-pen"></i> 编辑
            </button>
          </div>
        </div>
      </div>
    </section>

    <!-- 常规 · 对话显示与提示音：改动即时生效，不用点保存 -->
    <section v-show="tab === 'general'" class="card">
      <h3>对话与提示音</h3>
      <div class="form">
        <label class="field line">
          <input class="k-check" type="checkbox" :checked="prefs.sound" @change="savePref({ sound: $event.target.checked })" />
          <span>提示音</span>
        </label>
        <label class="field">
          <span>音量 {{ Math.round(prefs.volume * 100) }}%</span>
          <span class="slider-line">
            <input
              type="range" min="0" max="100" step="5"
              :value="Math.round(prefs.volume * 100)"
              :disabled="!prefs.sound"
              @change="savePref({ volume: Number($event.target.value) / 100 })"
            />
            <button class="k-btn ghost sm" type="button" :disabled="!prefs.sound" @click="previewSound">
              <i class="fas fa-volume-high"></i> 试听
            </button>
          </span>
        </label>
        <label class="field">
          <span>压缩保留条数</span>
          <input
            class="k-input w120" type="number" min="0" max="50" step="1"
            :value="prefs.compressKeep"
            @change="savePref({ compressKeep: Number($event.target.value) })"
          />
        </label>
        <label class="field">
          <span>审批等待时长(以秒计)</span>
          <input
            class="k-input w120" type="number" min="30" max="3600" step="30"
            :value="prefs.approvalTimeout"
            @change="savePref({ approvalTimeout: Number($event.target.value) })"
          />
        </label>
        <label class="field">
          <span>重复调用打断次数</span>
          <input
            class="k-input w120" type="number" min="2" max="20" step="1"
            :value="prefs.repeatBreak"
            @change="savePref({ repeatBreak: Number($event.target.value) })"
          />
        </label>
        <p class="field-note">
          模型连续 {{ prefs.repeatBreak }} 次调用同一个操作（工具名和参数完全一样）就打断这一轮，避免它陷在自循环里白烧额度。
          调到 2 很激进 —— 正常的「换个写法再试一次」也会被掐断；弱模型反复重试同一个命令时才需要往上调。改完下一轮对话就生效。
        </p>
        <label class="field line">
          <input class="k-check" type="checkbox" :checked="prefs.reasonOpen" @change="savePref({ reasonOpen: $event.target.checked })" />
          <span>思考默认展开</span>
        </label>
        <label class="field line">
          <input class="k-check" type="checkbox" :checked="prefs.longCollapse" @change="savePref({ longCollapse: $event.target.checked })" />
          <span>长回复自动折叠</span>
        </label>
        <label class="field line">
          <input class="k-check" type="checkbox" :checked="prefs.toolCollapse" @change="savePref({ toolCollapse: $event.target.checked })" />
          <span>工具调用自动折叠</span>
        </label>
      </div>
    </section>

    <!-- 网络：代理总闸。提供商上勾的「代理」只是声明要走它，这里能一键全免 -->
    <section v-show="tab === 'general'" class="card">
      <h3>网络</h3>
      <div class="form">
        <label class="field line">
          <input class="k-check" type="checkbox" :checked="prefs.proxyDisabled" @change="savePref({ proxyDisabled: $event.target.checked })" />
          <span>禁用全局代理设定</span>
        </label>
        <p class="field-note">
          打开后，所有提供商即使勾了「代理」也一律直连，提供商上的代理配置保留不动，关掉就恢复。
          关闭时，若某个勾了代理的提供商连不上代理节点，会自动退回直连重试并在对话里提示一次。
        </p>
      </div>
    </section>

    <!-- 安全 -->
    <section v-show="tab === 'security'" class="card">
      <h3>审批模式</h3>
      <div class="links">
        <button
          v-for="m in ['default', 'strict', 'exempt']"
          :key="m"
          class="btn"
          :class="{ primary: approvalMode === m }"
          type="button"
          @click="setApproval(m)"
        >{{ { default: '默认', strict: '严格', exempt: '免除' }[m] }}</button>
      </div>
    </section>

    <section v-show="tab === 'security'" class="card">
      <h3>敏感数据脱敏</h3>
      <div class="form">
        <KInput v-model="secretForm" label="新规则（原样替换为 ***）" block placeholder="sk-xxx / 密码字段名" />
        <button class="btn" type="button" @click="addSecret">添加脱敏规则</button>
      </div>
      <div v-for="s in secrets" :key="s.id" class="row">
        <span class="mono">{{ s.pattern || s.value }}</span>
        <button class="btn sm danger" type="button" @click="removeSecret(s)">删除</button>
      </div>
    </section>

    <section v-show="tab === 'security'" class="card">
      <h3>权限规则</h3>
      <p class="muted">命中黑名单直接拒绝（即使免除审批也拦得住）；白名单用于在严格/默认模式下放行特定目标。</p>
      <div class="grid-4">
        <label class="field">
          <span>类型</span>
          <KDropdown :items="kindItems" v-model="permForm.kind" block width="100%" />
        </label>
        <label class="field">
          <span>名单</span>
          <KDropdown :items="listItems" v-model="permForm.list" block width="100%" />
        </label>
        <label class="field">
          <span>匹配</span>
          <KDropdown :items="matchItems" v-model="permForm.match" block width="100%" />
        </label>
        <KInput v-model="permForm.pattern" label="内容（命令 / 路径 / 关键词 / 工具名）" block />
      </div>
      <div class="grid-2">
        <KInput v-model="permForm.note" label="备注（可留空）" block />
        <button class="btn primary" type="button" style="align-self:end" @click="addPerm">添加规则</button>
      </div>
      <div v-if="!perms.length" class="muted" style="margin-top:10px">还没有权限规则。</div>
      <div v-for="p in perms" :key="p.id" class="row">
        <div class="grow">
          <div class="mono">{{ permSummary(p) }}</div>
          <div v-if="p.note" class="muted">{{ p.note }}</div>
        </div>
        <button class="btn sm danger" type="button" @click="removePerm(p)">删除</button>
      </div>

      <h4 class="sub">规则试跑（不执行，只看判定）</h4>
      <div class="grid-2">
        <KInput v-model="permTestForm.tool" label="工具名" block placeholder="run_command" />
        <KInput v-model="permTestForm.command" label="命令行" block placeholder="rm -rf /" />
        <KInput v-model="permTestForm.paths" label="路径（分号或换行分隔）" block placeholder="D:\projects\foo" />
        <KInput v-model="permTestForm.text" label="关键词文本" block />
      </div>
      <button class="btn" type="button" @click="runPermTest">试跑判定</button>
      <pre v-if="permTestResult" class="perm-out">{{ JSON.stringify(permTestResult, null, 2) }}</pre>
    </section>

    <!-- 技能 -->
    <section v-show="tab === 'skills'" class="card">
      <h3>自定义技能</h3>
      <div class="form">
        <KInput v-model="skillName" label="技能名（kebab-case）" block />
        <label class="field">
          <span>Markdown 正文</span>
          <textarea v-model="skillBody" class="textarea" rows="8"></textarea>
        </label>
        <button class="btn primary" type="button" @click="importSkill">按上面内容导入</button>
        <div class="links">
          <button class="btn" type="button" @click="pickSkillFile">
            <i class="fas fa-file-import"></i> 从 .md 文件导入
          </button>
          <input ref="skillFileEl" type="file" accept=".md,.markdown,text/markdown,text/plain" style="display:none" @change="onPickSkillFile" />
        </div>
        <p class="muted">自定义技能存在数据目录的 skills/ 下（重装与热同步都不会冲掉）；同名会覆盖内置示例技能。</p>
      </div>
      <div v-for="s in skills" :key="s.name" class="row">
        <div class="grow">
          <div class="name">{{ s.name }}</div>
          <div class="muted">{{ s.description || s.title || '' }}</div>
        </div>
        <button class="btn sm danger" type="button" @click="removeSkill(s)">删除</button>
      </div>
    </section>

    <!-- 工具 -->
    <section v-show="tab === 'tools'" class="card">
      <h3>工具（按需启用）</h3>
      <p class="muted">内置 12 个基础工具（读写文件、edit_file、grep/glob、run_command 等）始终可用；这里只管增强工具与外部接口。</p>
      <div class="tool-search">
        <input v-model="toolQ" class="k-input" type="search" placeholder="搜索工具：名字 / 描述 / 提供方 / 分类…" @input="persistToolQ" />
        <span v-if="toolQ" class="muted">{{ toolMatchCount }} / {{ tools.length }} 命中</span>
      </div>
      <div v-if="toolQ && !toolSections.length" class="muted">没有匹配「{{ toolQ }}」的工具，换个关键词试试。</div>
      <div v-for="sec in toolSections" :key="sec.key" class="tool-sec">
        <h4 class="sub">
          {{ sec.title }} <span class="muted">{{ sec.onCount }}/{{ sec.total }} 已启用</span>
          <span class="set-actions">
            <button class="btn sm" type="button" :disabled="bulkBusy" @click="setSectionAll(sec, true)">本节全开</button>
            <button class="btn sm" type="button" :disabled="bulkBusy" @click="setSectionAll(sec, false)">本节全关</button>
          </span>
        </h4>
        <div v-for="g in sec.groups" :key="g.name" class="tool-group">
          <div class="group-head">
            {{ g.name }} <span class="muted">{{ g.onCount }}/{{ g.tools.length }}</span>
            <span class="set-actions">
              <button class="link-btn" type="button" :disabled="bulkBusy" @click="setGroupAll(g, true)">全开</button>
              <button class="link-btn" type="button" :disabled="bulkBusy" @click="setGroupAll(g, false)">全关</button>
            </span>
          </div>
          <div v-for="t in g.tools" :key="t.name" class="tool-card" :class="{ on: t.enabled }">
            <div class="row">
              <div class="grow">
                <div class="name">
                  {{ t.label || t.name }}
                  <span v-if="t.cost" class="tag">{{ t.cost }}</span>
                  <span v-if="t.calls" class="tag dim">已调用 {{ t.calls }} 次</span>
                </div>
                <div class="muted" :title="t.description">{{ (t.description || '').slice(0, 120) }}{{ (t.description || '').length > 120 ? '…' : '' }}</div>
                <div class="muted src">{{ t.source }}</div>
                <div v-if="t.schemaParams && t.schemaParams.length" class="muted src">
                  参数：<span v-for="(p, pi) in t.schemaParams" :key="p.name">{{ pi ? '、' : '' }}<code>{{ p.name }}</code>{{ p.required ? '*' : '' }}</span>
                </div>
              </div>
              <button class="k-btn sm" type="button" @click="toggleTool(t)">{{ t.enabled ? '关闭' : '启用' }}</button>
            </div>
            <div v-if="t.configFields?.length" class="cfg">
              <label v-for="f in t.configFields" :key="f.key" class="cfg-item">
                <span>{{ f.label }}</span>
                <input
                  v-if="f.type === 'bool'"
                  class="k-check"
                  type="checkbox"
                  v-model="f.value"
                />
                <input
                  v-else
                  class="k-input"
                  :type="f.type === 'secret' ? 'password' : (f.type === 'number' ? 'number' : 'text')"
                  v-model="f.value"
                  :placeholder="f.hint || ''"
                />
              </label>
              <button class="btn sm" type="button" @click="saveToolConfig(t)">保存配置</button>
            </div>
            <div class="run">
              <input
                class="k-input"
                v-model="t.testInput"
                :placeholder="t.testArg ? `试跑参数 ${t.testArg}：${t.testHint || ''}` : (t.testHint || '试跑：该工具无需参数')"
              />
              <button class="btn sm" type="button" :disabled="t.testResult?.loading" @click="testTool(t)">
                {{ t.testResult?.loading ? '调用中…' : '试跑' }}
              </button>
            </div>
            <pre v-if="t.testResult && !t.testResult.loading" class="tool-out" :class="{ err: !t.testResult.ok }">{{ t.testResult.text }}</pre>
          </div>
        </div>
      </div>
      <p v-if="!tools.length" class="muted" style="margin-top:10px">暂无可接入的工具。</p>
    </section>

    <!-- MCP 服务器：外部能力接入（发现出的工具在上面的「工具」页里逐个启用） -->
    <section v-show="tab === 'mcp'" class="card">
      <h3>MCP 服务器</h3>
      <p class="muted">
        接外部 MCP 能力（stdio 子进程或 Streamable HTTP）。发现出来的工具会出现在「工具」页的 MCP 一节，默认关闭。
        第三方工具不天然免审批：只有它自声明 readOnlyHint 才当只读放行，自声明破坏性的走红色确认。
      </p>
      <div v-for="s in mcpServers" :key="s.id" class="tool-card" :class="{ on: s.enabled }">
        <div class="row">
          <div class="grow">
            <div class="name">
              {{ s.name }}
              <span class="tag">{{ s.transport === 'http' ? 'HTTP' : 'stdio' }}</span>
              <span class="tag" :class="'mcp-' + s.status">{{ mcpStatusText(s) }}</span>
              <span v-if="s.tools.length" class="tag dim">{{ s.tools.length }} 个工具</span>
            </div>
            <div class="muted src mono">{{ s.transport === 'http' ? s.url : [s.command, ...(s.args || [])].join(' ') }}</div>
            <div v-if="s.last_error" class="mcp-err">{{ s.last_error }}</div>
          </div>
          <div class="row-actions">
            <button class="k-btn sm" type="button" @click="toggleMcp(s)">{{ s.enabled ? '停用' : '启用' }}</button>
            <button class="btn sm" type="button" :disabled="mcpBusy === s.id" @click="reconnectMcp(s)">
              {{ mcpBusy === s.id ? '连接中…' : '重连' }}
            </button>
            <button class="btn sm" type="button" :disabled="bulkBusy" @click="setMcpToolsAll(s, true)">工具全开</button>
            <button class="btn sm" type="button" :disabled="bulkBusy" @click="setMcpToolsAll(s, false)">工具全关</button>
            <button class="btn sm" type="button" @click="editMcp(s)">编辑</button>
            <button class="btn sm danger" type="button" @click="removeMcp(s)">删除</button>
          </div>
        </div>
        <button class="link-btn" type="button" @click="s.open = !s.open">{{ s.open ? '收起工具清单' : '展开工具清单' }}</button>
        <div v-if="s.open" class="mcp-tools">
          <div v-for="t in s.tools" :key="t.name" class="mcp-tool">
            <code>mcp__{{ mcpSlug(s.name) }}__{{ t.name }}</code>
            <span v-if="t.read_only" class="tag">只读</span>
            <span v-if="t.destructive" class="tag mcp-danger">破坏性</span>
            <span class="muted">{{ t.desc }}</span>
          </div>
          <p v-if="!s.tools.length" class="muted">尚未发现工具（连接成功后会有）。</p>
        </div>
      </div>
      <p v-if="!mcpServers.length" class="muted">还没有 MCP 服务器，下面新增第一个。</p>
      <h4 class="sub">{{ mcpForm.id ? '编辑服务器' : '新增服务器' }}</h4>
      <div class="form">
        <div class="cfg">
          <label class="cfg-item">
            <span>名称</span>
            <input class="k-input" v-model="mcpForm.name" placeholder="browser" />
          </label>
          <label class="cfg-item">
            <span>transport</span>
            <KDropdown :items="MCP_TRANSPORTS" v-model="mcpForm.transport" width="170px" />
          </label>
          <label class="cfg-item">
            <span>启用并连接</span>
            <input class="k-check" type="checkbox" v-model="mcpForm.enabled" />
          </label>
        </div>
        <div v-if="mcpForm.transport === 'stdio'" class="cfg">
          <label class="cfg-item">
            <span>command</span>
            <input class="k-input mono" v-model="mcpForm.command" placeholder="node / npx / python" />
          </label>
          <label class="cfg-item">
            <span>args（JSON 数组，或一行一个）</span>
            <textarea class="k-input mono" rows="3" v-model="mcpForm.argsText" placeholder='["index.js"]'></textarea>
          </label>
          <label class="cfg-item">
            <span>cwd（可空）</span>
            <input class="k-input mono" v-model="mcpForm.cwd" />
          </label>
          <label class="cfg-item">
            <span>env（JSON 对象，可空）</span>
            <textarea class="k-input mono" rows="2" v-model="mcpForm.envText" placeholder='{"API_KEY":"..."}'></textarea>
          </label>
        </div>
        <div v-else class="cfg">
          <label class="cfg-item">
            <span>url</span>
            <input class="k-input mono" v-model="mcpForm.url" placeholder="http://127.0.0.1:8000/mcp" />
          </label>
          <label class="cfg-item">
            <span>headers（JSON 对象，鉴权头写这里）</span>
            <textarea class="k-input mono" rows="2" v-model="mcpForm.headersText" placeholder='{"authorization":"Bearer ..."}'></textarea>
          </label>
        </div>
        <div class="row-actions">
          <button class="k-btn sm" type="button" :disabled="mcpSaving" @click="saveMcp">
            {{ mcpSaving ? '保存并连接…' : '保存并连接' }}
          </button>
          <button v-if="mcpForm.id" class="btn sm" type="button" @click="resetMcpForm">取消编辑</button>
        </div>
      </div>
    </section>

    <!-- 外观 -->
    <section v-show="tab === 'appearance'" class="card">
      <h3>外观</h3>
      <div class="form">
        <div class="field">
          <span>主题</span>
          <div class="theme-grid">
            <button
              v-for="t in THEMES"
              :key="t.id"
              type="button"
              class="theme-card"
              :class="{ on: themeState.id === t.id }"
              :aria-pressed="themeState.id === t.id"
              @click="setTheme(t.id)"
            >
              <span class="theme-prev" :class="'prev-' + t.id">
                <i class="pv-bar"></i>
                <i class="pv-line"></i>
                <i class="pv-line short"></i>
              </span>
              <span class="theme-name">{{ t.name }}</span>
              <span class="theme-desc">{{ t.desc }}</span>
            </button>
          </div>
        </div>
        <label class="field">
          <span>界面字体</span>
          <KDropdown :items="fontList" v-model="fontChoice" placeholder="默认" block width="100%" @change="applyFont" />
        </label>
        <div class="muted">分栏宽度可在聊天页拖拽调节并记忆。云母·蓝 / 云母·紫 / 星夜带动态背景，若机器性能吃紧可在系统里关掉动画。</div>
        <label class="field">
          <span>消息区最大宽度</span>
          <KDropdown :items="widthItems" v-model="contentWidth" block width="100%" @change="applyWidth" />
        </label>
        <label class="field line">
          <input class="k-check" type="checkbox" :checked="whaleOn" @change="setWhaleOn($event.target.checked)" />
          <span>小鲸鱼挂件（关掉就不再显示；挂件自己的菜单与位置/音效配置都保留）</span>
        </label>
      </div>
    </section>

    <!-- 实验室功能 -->
    <section v-show="tab === 'lab'" class="card">
      <h3>实验室功能</h3>
      <div class="form">
        <label v-for="x in labsSimple" :key="x.key" class="k-row-card" style="display:flex;align-items:center;gap:12px">
          <div style="flex:1">
            <div class="k-row-title">{{ x.title }}</div>
            <div class="k-row-desc">{{ x.desc }}</div>
          </div>
          <!-- 没实装的功能给一枚「待实装」，不给开关：能点、点了没反应是最难猜的界面 -->
          <span v-if="x.wip" class="lab-wip">待实装</span>
          <button v-else type="button" class="k-switch" :class="{ on: labOn[x.key] }" @click.prevent="toggleLab(x.key)"></button>
        </label>

        <!-- Computer Use：这一条不是占位，是真面板。总开关只在这里 ——
             后端已把 cu_* 那组工具从「工具」页隐藏了，别处再放一个开关只会两头打架。 -->
        <div class="k-row-card">
          <div class="cu-head">
            <div class="grow">
              <div class="k-row-title">Computer Use</div>
              <div class="k-row-desc">
                {{ !cu.supported
                  ? '本平台不可用：坐标引擎要 PowerShell + Win32 SendInput + UIA，netwright 也是 Windows 桌面自动化。'
                  : (cu.enabled
                      ? 'AI 可以看屏、点窗口、动鼠标；每一步都要你批准（除非开「全部开放」）。'
                      : '让 AI 直接操作这台电脑：netwright 在线就用它，没装就全程走坐标引擎。') }}
              </div>
            </div>
            <button
              type="button"
              class="k-switch"
              :class="{ on: cu.enabled }"
              :disabled="cuBusy || !cu.supported"
              :title="!cu.supported ? '只有 Windows 可用' : (cu.enabled ? '关掉 Computer Use' : '打开 Computer Use')"
              @click.prevent="setComputerEnabled(!cu.enabled)"
            ></button>
            <button v-if="cu.enabled && cu.supported" class="link-btn" type="button" @click="cuOpen = !cuOpen">
              {{ cuOpen ? '收起设置' : '展开设置' }}
            </button>
          </div>

          <p v-if="cuError" class="cu-err">{{ cuError }}</p>

          <!-- 总开关没开就没有后面这些：引擎没跑、授权表是空的，摆出来只会误导。
               本平台不支持时同样整块收起（库里可能带着从 Windows 导入的 enabled=1）。 -->
          <div v-if="cu.supported && cu.enabled && cuOpen" class="cu-body">
            <div class="cu-sec">引擎状态</div>
            <div class="cu-line">
              <span class="cu-k">netwright（上位引擎）</span>
              <span class="tag" :class="netTagClass">{{ netwrightText }}</span>
              <span v-if="cu.netwright.status === 'live'" class="muted">{{ cu.netwright.tools }} 个工具</span>
            </div>
            <!-- 没装的那句原文照抄：里面带着 dotnet tool install 的安装命令，翻日志不如直接拷 -->
            <pre v-if="cu.netwright.error" class="cu-err mono">{{ cu.netwright.error }}</pre>
            <p v-if="cu.netwright.status === 'absent'" class="field-note">将全程使用坐标引擎（会真的移动系统鼠标）。</p>
            <div class="cu-line">
              <span class="cu-k">坐标引擎守护进程</span>
              <span class="tag" :class="cu.daemon ? 'cu-ok' : 'cu-off'">{{ cu.daemon ? '在跑' : '不在' }}</span>
            </div>
            <div class="row-actions">
              <button class="btn sm" type="button" :disabled="cuDetecting" @click="reDetectNetwright">
                {{ cuDetecting ? '检测中…' : '重新检测 netwright' }}
              </button>
              <span class="muted">装完 netwright 点一下就行，不用重启。</span>
            </div>

            <div class="cu-sec">引擎偏好</div>
            <KDropdown :items="CU_ENGINES" :model-value="cu.engine_pref" width="280px" @change="setComputerEngine" />

            <div class="cu-sec">全部开放</div>
            <div class="cu-line cu-danger-line">
              <div class="grow">
                <div class="cu-k strong">全部开放（危险）</div>
                <div class="k-row-desc">
                  开了之后 AI 的整屏截图和一切操作都不再问你，直接落在这台电脑上：
                  鼠标会真的动、窗口会真的关、输入框会真的打字，出错没有反悔的机会。
                  重启后它<b>不会自动关</b>，只会在你下次进设置页时问一次。
                </div>
              </div>
              <button
                type="button"
                class="k-switch danger"
                :class="{ on: cu.open_all }"
                :disabled="cuBusy"
                @click.prevent="setComputerOpenAll(!cu.open_all)"
              ></button>
            </div>

            <div class="cu-sec">全局急停快捷键</div>
            <div class="cu-line">
              <button
                type="button"
                class="btn sm cu-capture"
                :class="{ listening: cuCapturing }"
                @click="toggleHotkeyCapture"
              >
                <i class="fas fa-key"></i>
                {{ cuCapturing ? '请按下组合键 / 鼠标侧键…' : (cu.hotkey ? hotkeyDisplay(cu.hotkey) : '点这里录入快捷键') }}
              </button>
              <button v-if="cu.hotkey && !cuCapturing" class="btn sm" type="button" @click="clearHotkey">清除</button>
              <button v-if="cuCapturing" class="btn sm" type="button" @click="stopHotkeyCapture">取消</button>
              <span class="tag" :class="hotkeyActiveTag.class">{{ hotkeyActiveTag.text }}</span>
              <button class="link-btn" type="button" :disabled="hotkeyChecking" @click="checkHotkeyActive">
                {{ hotkeyChecking ? '查中…' : '复查' }}
              </button>
            </div>
            <p class="field-note">
              任意场合（别的程序在前台也算）按下就撤销 AI 的全部授权。
              键盘组合要至少带 Ctrl / Alt / Shift / Win 一个修饰键；鼠标侧键（XButton1 / XButton2）可以单按。
            </p>
            <p v-if="cuHotkeyNote" class="warn-text">{{ cuHotkeyNote }}</p>

            <div class="cu-sec">已放行目标<span class="muted">　{{ (cu.grants || []).length }} 个</span></div>
            <p v-if="!(cu.grants || []).length" class="muted">当前没有放行中的目标。</p>
            <div v-for="g in cu.grants" :key="g.id" class="cu-line">
              <span class="mono cu-exe" :title="g.exe || ''">{{ g.exe || '（按窗口放行）' }}</span>
              <span class="muted">PID {{ g.pid || '—' }}</span>
              <span class="muted grow cu-ellip" :title="g.title || ''">{{ g.title }}</span>
              <button class="btn sm" type="button" @click="revokeGrant(g)">撤销</button>
            </div>
            <p v-if="cu.last_stop_ts" class="muted">
              上次急停：{{ fmtTs(cu.last_stop_ts) }}（{{ stopReasonText(cu.last_stop_reason) }}）
            </p>
            <div class="row-actions">
              <button class="k-btn sm danger" type="button" :disabled="cuBusy" @click="emergencyStop">
                <i class="fas fa-hand"></i> 急停：撤销全部授权
              </button>
            </div>
          </div>
        </div>

        <!-- 图片大小控制：截图是这个 harness 里最大的一块请求体，单独一道闸 -->
        <div class="k-row-card">
          <div class="cu-head">
            <div class="grow">
              <div class="k-row-title">图片大小控制</div>
              <div class="k-row-desc">
                截图送给模型之前统一压到这个尺寸（按最长边算）并转成 JPEG。
                当前：{{ prefs.imgMaxSide ? prefs.imgMaxSide + ' px' : '不限制（原图送出）' }}
              </div>
            </div>
          </div>
          <div class="cu-line" style="margin-top:8px">
            <button
              v-for="p in IMG_SIZES"
              :key="p.value"
              type="button"
              class="btn sm img-pick"
              :class="{ on: !imgCustomPicked && prefs.imgMaxSide === p.value }"
              @click="pickImgSize(p.value)"
            >{{ p.label }}</button>
            <input
              v-model.number="imgCustomInput"
              class="k-input mono img-custom"
              type="number"
              min="0"
              max="8192"
              step="10"
              placeholder="自定义"
              @change="applyImgCustom"
            />
            <span class="muted">px 最长边（0 = 不限制）</span>
          </div>
          <p class="field-note">
            管的是「全屏截图 / 整屏截取 / 网页整页截图」这几类送进模型的图。
            另外有一条固定规则：整个上下文里**只有最近一张图会真的发出去**，更早的会换成「[过期的图片]」——
            截图是一步一张的，留着旧图只会让请求体越来越大直到被上游拒收。
          </p>
        </div>

        <!-- AI 监工 / 托管：半废弃。功能没删，但入口收在这道闸后面 ——
             关掉时右栏「监工」页签、/supervise 命令都没有，后端两条 run 路由也直接拒。 -->
        <div class="k-row-card">
          <div class="cu-head">
            <div class="grow">
              <div class="k-row-title">AI 监工 / 托管<span class="muted">　半废弃</span></div>
              <div class="k-row-desc">
                {{ prefs.supervisorOn
                  ? '已打开：右栏「监工」页签和 /supervise 命令回来了。这条线不再继续维护，出问题先当已知风险看。'
                  : '监工（跑 kh.checks.md 清单、给你派活给主智能体）与托管模式已半废弃，默认关闭。' }}
              </div>
            </div>
            <button
              type="button"
              class="k-switch"
              :class="{ on: prefs.supervisorOn }"
              :title="prefs.supervisorOn ? '关掉监工入口' : '打开监工入口'"
              @click.prevent="savePref({ supervisorOn: !prefs.supervisorOn })"
            ></button>
          </div>
          <p class="field-note">
            打开后多出来的是：右栏「监工」页签（三行控制台 + 跑清单）、输入框的 <span class="mono">/supervise</span> 命令、
            以及后端 <span class="mono">/api/ai/supervise/run</span> 与 <span class="mono">/api/ai/hosted/run</span> 两条执行通道。
            关掉只是收起入口，历史报告（<span class="mono">ai_supervise_runs</span> 与数据目录里的 supervise 报告）都还在，重新打开就看得见。
          </p>
        </div>
      </div>
    </section>

    <!-- 关于 -->
    <section v-show="tab === 'about'" class="card">
      <h3>关于 KHarness</h3>
      <div class="muted">
        本地 AI Harness：模型管理 / 延迟测试 / Playground（Agent 工具调用、项目会话、任务面板、用量与轨迹）。
      </div>
      <div class="row"><span class="muted">前端</span><span>NewUI-dev 重构版</span></div>
      <div class="row"><span class="muted">形态</span><span>{{ isDesktop ? '桌面端（Electron）' : '网页端（浏览器直连本机服务）' }}</span></div>
      <div class="row"><span class="muted">文档</span><span>README.md / TOOLS-CALLING.md</span></div>
    </section>

    <!-- 数据库：桌面端与仓库端之间不自动搬，只有这两个口子 -->
    <section v-show="tab === 'about'" class="card">
      <h3>数据库</h3>
      <p class="muted">
        导出走的是一致性快照（含 WAL 里还没落盘的写入），拿到的是一个自包含的单文件；
        导入会先做完整性与表结构校验，通过了也只是「暂存」，<b>重启后才应用</b>，
        应用前会自动给现库留一份 <code>kh.db.pre-import-*</code> 备份。
      </p>
      <div class="row"><span class="muted">位置</span><span class="mono">{{ dbInfo.path || '—' }}</span></div>
      <div class="row">
        <span class="muted">大小</span>
        <span>{{ dbInfo.bytes ? (dbInfo.bytes / 1024 / 1024).toFixed(2) + ' MB' : '—' }}
          <span v-if="dbInfo.counts" class="muted">（{{ Object.entries(dbInfo.counts).map(([k, v]) => k + ' ' + v).join('，') }}）</span>
        </span>
      </div>
      <div v-if="dbInfo.pending" class="row">
        <span class="muted">待应用</span>
        <span class="warn-text">{{ dbInfo.pending.source }}（{{ new Date(dbInfo.pending.created_at).toLocaleString() }}）—— 重启后生效</span>
        <button class="btn sm" type="button" @click="cancelImport">撤销</button>
      </div>
      <div v-if="dbInfo.last_result && !dbInfo.last_result.ok" class="row">
        <span class="muted">上次导入</span><span class="warn-text">未应用：{{ dbInfo.last_result.error }}</span>
      </div>
      <div class="row-actions">
        <a class="k-btn sm" :href="exportUrl" download>导出数据库</a>
        <button class="btn sm" type="button" :disabled="importing" @click="pickImportFile">
          {{ importing ? '上传校验中…' : '导入数据库' }}
        </button>
        <button v-if="canRestart" class="btn sm" type="button" :disabled="importing || !dbInfo.pending" @click="restartNow">
          重启并应用
        </button>
        <input ref="fileEl" type="file" accept=".db,.sqlite,.sqlite3,application/octet-stream" style="display:none" @change="onPickImport" />
      </div>
      <p v-if="!canRestart && dbInfo.pending" class="muted">
        网页端没有外壳代劳重启：重启后端进程（例如重跑 <code>npm start</code>）即会应用这份导入。
      </p>

      <!-- 换位置：桌面端专属。网页端既弹不出目录选择框，也没有指针文件供下次启动读回 -->
      <div class="sub-head">改数据库位置</div>
      <p class="muted">
        目标目录里<b>已经有 <code>kh.db</code> 就直接改用</b>，没有则把当前库整份复制过去（一致性快照，原文件一律不动）。
        两种情况都只是「排定」，<b>重启后才生效</b>。
      </p>
      <template v-if="isDesktop">
        <div class="row"><span class="muted">当前目录</span><span class="mono">{{ loc.dir || dbInfo.path || '—' }}</span></div>
        <div class="row"><span class="muted">取自</span><span>{{ loc.using_default ? '默认位置' : '自定义位置（指针文件里记着）' }}</span></div>
        <div v-if="loc.error" class="row"><span class="muted">读取失败</span><span class="warn-text">{{ loc.error }}</span></div>
        <div class="row-actions">
          <button class="btn sm" type="button" :disabled="locBusy" @click="chooseDbDir">
            {{ locBusy ? '处理中…' : '选择目录并迁移…' }}
          </button>
          <button class="btn sm" type="button" :disabled="!loc.needsRestart && !loc.reset_pending" @click="restartNow">重启并生效</button>
        </div>
        <p v-if="loc.needsRestart" class="muted">
          新位置：<code>{{ loc.file }}</code>{{ loc.used_existing ? '（沿用那里已有的库）' : '（已复制一份过去）' }}
        </p>
      </template>
      <p v-else class="muted">
        这项只在桌面端开放。网页端请给后端进程设 <code>KH_DATA_DIR</code> 环境变量后重启。
      </p>
    </section>

    <!-- 恢复出厂设置：清库不可逆，所以逐字确认 + 三次点击，误触不了 -->
    <section v-show="tab === 'about'" class="card">
      <h3>恢复出厂设置</h3>
      <p class="muted">
        清空整份数据库：模型与提供方、全部会话与消息、用量记录、设置全部归零。
        <b>不做任何备份，删了就找不回来</b>。想留底请先用上面的「导出数据库」。
      </p>
      <template v-if="isDesktop">
        <div v-if="loc.reset_pending" class="row">
          <span class="muted">状态</span><span class="warn-text">已排定清空，重启后端时执行（这一步还没真的删）</span>
        </div>
        <label class="field">
          <span>请逐字输入下面这句话</span>
          <input v-model="factoryPhrase" class="k-input" autocomplete="off" :placeholder="FACTORY_PHRASE" />
          <span class="muted phrase-hint">{{ FACTORY_PHRASE }}</span>
        </label>
        <div class="row">
          <span class="muted">确认进度</span>
          <span class="phrase-steps">
            <i v-for="n in 3" :key="n" :class="{ on: factoryClicks >= n }"></i>
            <span class="muted">{{ factoryClicks }}/3</span>
          </span>
        </div>
        <div class="row-actions">
          <button class="btn sm danger" type="button" :disabled="!factoryArmed || factoryBusy" @click="factoryConfirm">
            {{ factoryBusy ? '正在排定…' : factoryArmed ? `确认恢复出厂（第 ${Math.min(factoryClicks + 1, 3)}/3 次）` : '先逐字输入确认语' }}
          </button>
          <button v-if="factoryClicks" class="btn sm" type="button" @click="resetFactoryFlow">重新开始</button>
        </div>
        <p v-if="factoryPhrase && !factoryArmed" class="muted">输入的文字和确认语不一致，按钮还点不动。</p>
      </template>
      <p v-else class="muted">
        这项只在桌面端开放：清库要由外壳带着本机 token 走后端接口，网页端不给这个口子。
      </p>
    </section>
      </div>
    </Transition>

    <AgentsEditor
      :open="gpOpen"
      :target="{ scope: 'global' }"
      title="全局提示词（AGENTS.md）"
      @close="gpOpen = false"
      @saved="onPromptSaved"
    />

    <!-- 「全部开放」重启后不会自己关（后端刻意留着这个状态），所以进设置页问一次。
         ack 过就不再问；关掉之后也不再问 —— 两个按钮都会调 /open-all/ack。 -->
    <KModal :open="cuAckOpen" title="上次重启前「全部开放」是开着的" width="460px" @close="ackKeepOpen">
      <p class="muted cu-ack-text">
        Computer Use 的「全部开放」仍在生效：AI 的整屏截图和所有操作都不经过你批准，
        鼠标、键盘、窗口都归它直接动。它不会因为你重启了 KHarness 就自己关掉。
      </p>
      <p class="muted cu-ack-text">现在要不要关掉？关掉后每次操作仍会先问你。</p>
      <template #footer>
        <button class="k-btn ghost sm" type="button" @click="ackKeepOpen">保持开启</button>
        <button class="k-btn danger sm" type="button" @click="ackTurnOff">立即关闭</button>
      </template>
    </KModal>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { aiApi, settingsApi } from '../../api';
import { toast } from '../../stores/toast';
import { toastErr, errFull } from '../../utils/errText';
import KTabs from '../../ui/KTabs.vue';
import KInput from '../../ui/KInput.vue';
import KDropdown from '../../ui/KDropdown.vue';
import KModal from '../../ui/KModal.vue';
import AgentsEditor from '../../ui/AgentsEditor.vue';
import { THEMES, themeState, setTheme } from '../../stores/theme';
import { uiPrefs } from '../../stores/prefs';
import { soundApproval } from '../../utils/sound';
import { promptDialog } from '../../stores/prompt';
import { confirmDialog } from '../../stores/confirm';

const tabs = [
  { id: 'general', label: '常规' },
  { id: 'security', label: '安全' },
  { id: 'skills', label: '技能' },
  { id: 'tools', label: '工具' },
  { id: 'mcp', label: 'MCP' },
  { id: 'appearance', label: '外观' },
  { id: 'lab', label: '实验室' },
  { id: 'about', label: '关于' },
];
const tab = ref('general');

const shell = ref('');
const shellCandidates = ref([]);
const shellCustom = ref('');
const cmdTimeout = ref(360);
const defaultContext = ref(0);
const rlRetryMax = ref(2);
const approvalMode = ref('default');
const secretForm = ref('');
const secrets = ref([]);
const permMeta = ref({ kinds: [], lists: [], matches: [] });
const permForm = reactive({ kind: 'command', list: 'black', match: 'contains', pattern: '', note: '' });
const permTestForm = reactive({ tool: 'run_command', command: '', paths: '', text: '' });
const permTestResult = ref(null);
const perms = ref([]);
const skillName = ref('');
const skillBody = ref('');
const skills = ref([]);
const tools = ref([]);
const fontChoice = ref(localStorage.getItem('nu_font') || '');
const fontList = [
  { value: '', label: '默认' },
  { value: 'Inter, "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif', label: '系统默认' },
  { value: '"PingFang SC", "Microsoft YaHei", sans-serif', label: '苹方 / 微软雅黑' },
  { value: 'Consolas, "SF Mono", "Cascadia Code", monospace', label: '等宽代码' },
  { value: 'Georgia, "Times New Roman", serif', label: '衬线' },
  { value: '"Segoe UI", Tahoma, sans-serif', label: 'Segoe UI' },
];

function applyFont() {
  localStorage.setItem('nu_font', fontChoice.value);
  if (fontChoice.value) document.documentElement.style.setProperty('--font', fontChoice.value);
  else document.documentElement.style.removeProperty('--font');
}

const contentWidth = ref(localStorage.getItem('nu_w') || '860');
const labOn = ref({ ...(JSON.parse(localStorage.getItem('nu_labs') || '{}')) });
/* 实验室只放「还没实装、先占个位置」的东西。
   原来这三条：会话互聊一直没做；Git 版本预览与未提交变更提醒已经生效，
   不该再挂着「实验」的名头，所以这一页清空重列。开关值仍留在 localStorage 的 nu_labs 里，
   聊天页照旧按 labFlags 读 —— 谁以后要恢复入口，把条目加回来就认得。 */
const labs = [
  {
    key: 'computerUse',
    title: 'Computer Use',
    desc: '让 AI 操作这台电脑（面板见下方）。',
    panel: true,
  },
];
// 带 panel 的那条不走上面的占位行（自己有一整套真设置区），其余照旧
const labsSimple = computed(() => labs.filter((x) => !x.panel));
function toggleLab(k) {
  labOn.value = { ...labOn.value, [k]: !labOn.value[k] };
  localStorage.setItem('nu_labs', JSON.stringify(labOn.value));
}

/* ---------------- Computer Use（实验室 → 面板） ----------------
   状态一律以服务端 /state 为准，本地只留「面板开没开」这种视觉状态。
   netwright 是上位引擎（用户自装），没装后端自动全程走坐标引擎 —— 前端不做选择判断，只如实显示。 */
const cu = ref({
  supported: true,
  enabled: false,
  open_all: false,
  engine_pref: 'auto',
  netwright: { status: 'unknown', error: '', tools: 0 },
  daemon: false,
  grants: [],
  hotkey: '',
  last_stop_ts: '',
  last_stop_reason: '',
  open_pending_ack: false,
});
// 默认展开。这里曾经默认 false，于是「上次已经打开过总开关」的人一进实验室就只剩一颗亮着的开关、
// 配置项全藏起来（只有点开关那一下会置 true），刷新或换页回来必定复现。
const cuOpen = ref(true);
const cuBusy = ref(false);
const cuError = ref('');
const cuDetecting = ref(false);
const cuAckOpen = ref(false);
// 重启警告只问一次：切来切去反复弹同一句「要不要关掉」比不弹还烦人
const cuAckAsked = ref(false);
const CU_ENGINES = [
  { value: 'auto', label: '自动（有 netwright 先用它，失败降级坐标）' },
  { value: 'coords', label: '只用坐标引擎（会真的动鼠标）' },
  { value: 'netwright', label: '只用 netwright（没装就不会操作）' },
];
const NETWRIGHT_TEXT = { live: '在线', absent: '未安装', error: '检测失败', unknown: '还没检测' };
const netwrightText = computed(() => NETWRIGHT_TEXT[cu.value.netwright?.status] || cu.value.netwright?.status || '—');
const netTagClass = computed(() => (cu.value.netwright?.status === 'live' ? 'cu-ok' : cu.value.netwright?.status === 'absent' ? 'cu-off' : 'cu-bad'));

function stopReasonText(r) {
  return { hotkey: '快捷键按下', manual: '界面按钮', blacklist: '命中黑名单' }[r] || (r || '未知');
}
// 后端存的是 Date.now() 毫秒串，直接摆在界面上是一串没人看得懂的 1790718303475
function fmtTs(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return String(ts || '');
  const d = new Date(n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function loadComputerState() {
  try {
    const s = await aiApi.computerState();
    if (s) cu.value = { ...cu.value, ...s, netwright: { status: 'unknown', error: '', tools: 0, ...(s.netwright || {}) } };
    cuError.value = '';
    // 重启后「全部开放」还开着：后端置了待确认标记，这里问一次（ack 之后不再弹）
    if (cu.value.open_pending_ack && !cuAckAsked.value) {
      cuAckAsked.value = true;
      cuAckOpen.value = true;
    }
    // 设过快捷键 + 引擎在跑：这一趟顺手问一次钩子状态，别让人对着「未检测」自己猜
    if (cu.value.enabled && cu.value.hotkey && cu.value.daemon && !hotkeyProbed) checkHotkeyActive();
  } catch (e) {
    // 后端没起来 / 引擎没跑：状态读不到就说出来，别让它显示成「关着」的样子
    cuError.value = errFull(e, 'Computer Use 状态读取失败');
  }
}

async function setComputerEnabled(on) {
  cuBusy.value = true;
  try {
    await aiApi.computerSetEnabled(on);
    cu.value.enabled = on;
    if (on) cuOpen.value = true;          // 刚打开就把面板摊开：引擎、快捷键、授权都要在这一屏里配
    await loadComputerState();
    toast(on ? 'Computer Use 已打开' : 'Computer Use 已关闭', 'success', 2000);
  } catch (e) {
    cuError.value = errFull(e, on ? 'Computer Use 打不开' : 'Computer Use 关不掉');
  } finally {
    cuBusy.value = false;
  }
}

async function setComputerOpenAll(on) {
  cuBusy.value = true;
  try {
    await aiApi.computerSetOpenAll(on);
    cu.value.open_all = on;
    await loadComputerState();
    toast(on ? '已开启全部开放：AI 的操作不再询问你' : '已关闭全部开放', on ? 'warn' : 'success', 3000);
  } catch (e) {
    cuError.value = errFull(e, '「全部开放」设置失败');
  } finally {
    cuBusy.value = false;
  }
}

/** 重启警告的两个出口都算「看过了」，否则每次进设置页都要重弹 */
async function ackKeepOpen() {
  cuAckOpen.value = false;
  try {
    await aiApi.computerAckOpenAll();
    cu.value.open_pending_ack = false;
  } catch (e) { /* 确认没写进去，下次进来再问一次就是了 */ }
}
async function ackTurnOff() {
  cuAckOpen.value = false;
  try {
    await aiApi.computerSetOpenAll(false);
    await aiApi.computerAckOpenAll();
    await loadComputerState();
    toast('已关闭全部开放，操作会重新问你', 'success', 2600);
  } catch (e) {
    cuError.value = errFull(e, '关闭「全部开放」失败');
  }
}

async function setComputerEngine(v) {
  try {
    await aiApi.computerSetEngine(v);
    cu.value.engine_pref = v;
    toast(`引擎偏好已改成 ${v}`, 'info', 1800);
  } catch (e) {
    cuError.value = errFull(e, '引擎偏好保存失败');
  }
}

/** netwright 探测是异步的：POST /detect 只回「检测中」，隔一会儿再读 /state 才是真结果 */
let cuDetectTimer = null;
async function reDetectNetwright() {
  cuDetecting.value = true;
  try {
    await aiApi.computerDetect();
    clearTimeout(cuDetectTimer);
    cuDetectTimer = setTimeout(async () => {
      await loadComputerState();
      cuDetecting.value = false;
      toast(
        cu.value.netwright.status === 'live' ? 'netwright 在线，可以用上位引擎' : '还是没检测到 netwright，继续用坐标引擎',
        cu.value.netwright.status === 'live' ? 'success' : 'info',
        2600,
      );
    }, 1800);
  } catch (e) {
    cuDetecting.value = false;
    cuError.value = errFull(e, '重新检测失败');
  }
}

/* ---- 急停快捷键的录入控件：点一下进监听态，按下的组合键 / 鼠标侧键就是快捷键 ----
   全局 keydown + pointerdown（button 3/4 = XButton1/2 侧键），一律 preventDefault：
   监听的时候按下 Ctrl+W、Alt+Tab 这种真快捷键，不能让它们顺带把窗口关了。 */
const cuCapturing = ref(false);
const cuHotkeyActive = ref(null);      // null = 还没查
const hotkeyChecking = ref(false);
const cuHotkeyNote = ref('');
let hotkeyProbed = false;              // 一次进页只自动查一遍，切来切去不重复敲守护进程
const hotkeyActiveTag = computed(() => {
  if (!cu.value.hotkey) return { class: 'cu-off', text: '未设置' };
  if (cuHotkeyActive.value === true) return { class: 'cu-ok', text: '钩子已装载' };
  if (cuHotkeyActive.value === false) return { class: 'cu-bad', text: '钩子没装上' };
  return { class: 'cu-off', text: '未检测' };
});

// 后端只认这套键名（见 cudaemon.ps1 的 KeyByName），拼错会被回 bad-key
const CU_KEY_MAP = {
  Escape: 'esc', Tab: 'tab', Enter: 'enter', ' ': 'space', Backspace: 'backspace',
  Delete: 'delete', Insert: 'insert', Home: 'home', End: 'end',
  PageUp: 'pageup', PageDown: 'pagedown',
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  PrintScreen: 'printscreen',
};
const CU_MOD_ORDER = [['ctrl', 'ctrlKey'], ['alt', 'altKey'], ['shift', 'shiftKey'], ['win', 'metaKey']];

/** 事件 → spec 字符串（小写、+ 连接）。拼不出来就回空串 + 一句为什么不行 */
function cuSpecFromEvent(e) {
  const mods = CU_MOD_ORDER.filter(([, prop]) => e[prop]).map(([n]) => n);
  const main = CU_KEY_MAP[e.key]
    || (/^F([1-9]|1[0-6])$/i.test(e.key || '') ? `f${e.key.slice(1).toLowerCase()}` : '')
    || (/^[a-z0-9]$/i.test(e.key || '') ? e.key.toLowerCase() : '');
  if (!main) return { spec: '', why: '' };
  if (!mods.length) return { spec: '', why: '键盘快捷键要至少带上 Ctrl / Alt / Shift / Win 一个修饰键，否则整机那个键就没用了' };
  return { spec: [...mods, main].join('+'), why: '' };
}

function cuSpecFromPointer(e) {
  const btn = e.button === 3 ? 'xbutton1' : e.button === 4 ? 'xbutton2' : '';
  if (!btn) return { spec: '', why: '' };
  const mods = CU_MOD_ORDER.filter(([, prop]) => e[prop]).map(([n]) => n);
  return { spec: [...mods, btn].join('+'), why: '' };
}

function onCaptureKey(e) {
  e.preventDefault();
  e.stopPropagation();
  if (e.type !== 'keydown') return;
  const { spec, why } = cuSpecFromEvent(e);
  if (why) { cuHotkeyNote.value = why; return; }
  if (spec) {
    stopHotkeyCapture();
    saveHotkey(spec);
  }
}
function onCapturePointer(e) {
  // 只认侧键（button 3/4）：左键要留给「取消」那颗按钮 —— pointerdown 上乱 preventDefault 会把 click 一起吞掉
  if (e.button !== 3 && e.button !== 4) return;
  e.preventDefault();
  e.stopPropagation();
  const { spec } = cuSpecFromPointer(e);
  if (spec) {
    stopHotkeyCapture();
    saveHotkey(spec);
  }
}

function startHotkeyCapture() {
  cuCapturing.value = true;
  cuHotkeyNote.value = '';
  window.addEventListener('keydown', onCaptureKey, true);
  window.addEventListener('keyup', onCaptureKey, true);
  window.addEventListener('pointerdown', onCapturePointer, true);
}
function stopHotkeyCapture() {
  cuCapturing.value = false;
  window.removeEventListener('keydown', onCaptureKey, true);
  window.removeEventListener('keyup', onCaptureKey, true);
  window.removeEventListener('pointerdown', onCapturePointer, true);
}
function toggleHotkeyCapture() {
  if (cuCapturing.value) stopHotkeyCapture();
  else startHotkeyCapture();
}

const HOTKEY_NAME = {
  ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', win: 'Win', esc: 'Esc', enter: 'Enter', space: '空格',
  backspace: 'Backspace', delete: 'Delete', insert: 'Insert', home: 'Home', end: 'End',
  pageup: 'PgUp', pagedown: 'PgDn', up: '↑', down: '↓', left: '←', right: '→',
  printscreen: 'PrtSc', xbutton1: '鼠标侧键1', xbutton2: '鼠标侧键2',
};
function hotkeyDisplay(spec) {
  return String(spec || '').split('+').filter(Boolean).map((p) => HOTKEY_NAME[p] || (p.length === 1 ? p.toUpperCase() : p)).join(' + ');
}
/** 守护进程回的那几个失败码翻成人话（它回的是 result 字段，不是异常） */
function hotkeyFailText(code) {
  const s = String(code || '');
  if (s.startsWith('bad-key')) return `键名不认（${s.slice(8)}）：只支持 a-z、0-9、f1–f16 和 esc/tab/enter/space 这类`;
  if (s === 'hook-failed') return '系统全局钩子装不上（权限不够，或被别的程序占着）';
  if (s === 'no-key') return '没给出主键';
  if (s === 'no-spec') return '没给出组合键';
  return s;
}

async function saveHotkey(spec) {
  cuBusy.value = true;
  cuHotkeyNote.value = '';
  try {
    const r = await aiApi.computerSetHotkey(spec);
    cu.value.hotkey = spec;
    // 这一路的坑：后端回 200 不代表钩子真装上了。note 是「引擎没跑，稍后才生效」，
    // ok:false 是下发失败，result.result 非 ok 是守护进程装了但报错（钩子装不上 / 键名不认识）
    if (r && r.ok === false) cuHotkeyNote.value = `快捷键没能下发：${r.error || '未知原因'}`;
    else if (r && r.note) cuHotkeyNote.value = r.note;
    else if (r?.result && r.result.result && r.result.result !== 'ok') {
      cuHotkeyNote.value = `快捷键没能装上：${hotkeyFailText(r.result.result)}`;
    }
    await checkHotkeyActive();
    if (!cuHotkeyNote.value) toast(`急停快捷键已设为 ${hotkeyDisplay(spec)}`, 'success', 2600);
  } catch (e) {
    cuError.value = errFull(e, '快捷键保存失败');
  } finally {
    cuBusy.value = false;
  }
}

async function clearHotkey() {
  cuBusy.value = true;
  try {
    await aiApi.computerSetHotkey('');     // 空串 = 取消快捷键
    cu.value.hotkey = '';
    cuHotkeyActive.value = false;
    cuHotkeyNote.value = '';
    toast('已取消急停快捷键', 'info', 2000);
  } catch (e) {
    cuError.value = errFull(e, '快捷键取消失败');
  } finally {
    cuBusy.value = false;
  }
}

/** hotkey_state 问的是守护进程里那道钩子到底装上了没有（比信一遍 POST 的返回靠谱） */
async function checkHotkeyActive() {
  hotkeyChecking.value = true;
  hotkeyProbed = true;
  try {
    const r = await aiApi.computerProbe('hotkey_state');
    cuHotkeyActive.value = !!(r && r.active);
  } catch (e) {
    // 坐标引擎没跑时这条探测必然失败，那是「没装上」而不是另一个错；
    // 已经有更具体的原因（比如钩子报错码）就别用这句盖掉它
    cuHotkeyActive.value = false;
    if (!cuHotkeyNote.value) cuHotkeyNote.value = errFull(e, '快捷键状态查不到');
  } finally {
    hotkeyChecking.value = false;
  }
}

async function revokeGrant(g) {
  try {
    await aiApi.computerRevokeGrant(g.id);
    await loadComputerState();
  } catch (e) {
    cuError.value = errFull(e, '撤销失败');
  }
}

async function emergencyStop() {
  cuBusy.value = true;
  try {
    const r = await aiApi.computerEmergencyStop('settings panel');
    await loadComputerState();
    toast(`已急停，全部授权撤销（${r?.stopped_at || ''}）`, 'warn', 3000);
  } catch (e) {
    cuError.value = errFull(e, '急停失败');
  } finally {
    cuBusy.value = false;
  }
}

watch(tab, (v) => { if (v === 'lab') loadComputerState(); });
// 离开设置页：还在监听就把全局键监听摘掉（否则整台机器的按键都被这里吃掉），探测的延时也一并清掉
onUnmounted(() => {
  stopHotkeyCapture();
  clearTimeout(cuDetectTimer);
});

/* ---- 全局提示词（~/.kharness/AGENTS.md）：路径与状态从后端读，编辑在 AgentsEditor 弹窗里 ---- */
const gpOpen = ref(false);
const gpInfo = ref({ path: '', exists: false, tokens: 0 });

async function loadGlobalPrompt() {
  try {
    gpInfo.value = await aiApi.agentsFile({ scope: 'global' });
  } catch (e) {
    // 读不到路径也别空着：按同一套规则给个提示，用户至少知道该去哪儿放这份文件
    gpInfo.value = { path: '', exists: false, tokens: 0 };
    toastErr(e, '读取全局提示词失败');
  }
}
function onPromptSaved(d) {
  if (d) gpInfo.value = { ...gpInfo.value, ...d, tokens: d.tokens ?? gpInfo.value.tokens };
}

/* ---- 小鲸鱼挂件总开关：配置与挂件自己的菜单共用一份（settings.whale_widget.enabled） ---- */
const whaleOn = ref(true);

async function loadWhale() {
  try {
    const c = await aiApi.whaleConfig();
    whaleOn.value = c?.enabled !== false;   // 没这个字段 = 老配置，按开处理
  } catch (e) { /* 读不到就维持默认开，不影响界面 */ }
}
async function setWhaleOn(v) {
  whaleOn.value = v;
  try {
    await aiApi.saveWhaleConfig({ enabled: v });
    toast(v ? '已开启小鲸鱼挂件' : '已关闭小鲸鱼挂件（回到聊天页就看不见它了）', 'info', 2200);
  } catch (e) {
    whaleOn.value = !v;
    toastErr(e, '挂件开关保存失败');
  }
}
function applyWidth() {
  localStorage.setItem('nu_w', contentWidth.value);
  document.documentElement.style.setProperty('--msg-w', `${contentWidth.value}px`);
}

/** 解析 shell 候选：字符串路径 / 对象 / 误序列化成 JSON 的情况 */
function shellVal(c) {
  if (c == null) return '';
  if (typeof c === 'string') {
    const t = c.trim();
    if (t.startsWith('{') || t.startsWith('[')) {
      try {
        const o = JSON.parse(t);
        return o.path || o.value || o.shell || o.command || t;
      } catch { /* keep raw */ }
    }
    return t;
  }
  return c.path || c.value || c.shell || c.command || String(c);
}

function shellLabel(c) {
  const v = shellVal(c);
  const name = v.split(/[\\/]/).pop() || v;
  // 显示友好名：pwsh / powershell / bash / cmd / wsl
  const map = {
    pwsh: 'PowerShell 7',
    powershell: 'PowerShell 5',
    cmd: 'CMD',
    bash: 'Bash',
    wsl: 'WSL Bash',
    'wsl.exe': 'WSL Bash',
  };
  const key = name.toLowerCase().replace(/\.exe$/, '');
  return map[key] || map[name.toLowerCase()] || name;
}

/** 下拉选项：全部走 KDropdown，与输入框/按钮同一套控件语言 */
const shellItems = computed(() => shellCandidates.value.map((c) => ({ value: c.value, label: c.label || shellLabel(c.value) })));

/**
 * 自定义 Shell 路径：立刻生效（不等「保存上游设置」那颗按钮）。
 * 服务端会 fs.accessSync(X_OK) 校验，填错路径直接 400 回来，不会把 Agent 的 Shell 设成跑不起来的东西。
 */
async function applyShellCustom() {
  const p = shellCustom.value.trim();
  if (!p) return toast('先填可执行文件的完整路径', 'warn');
  try {
    await aiApi.setShell(p);
  } catch (e) {
    return toastErr(e, 'Shell 路径不可用');
  }
  shell.value = p;
  localStorage.setItem('nu_shell', p);
  toast(`默认 Shell 已设为 ${p}`, 'success');
}
const widthItems = [
  { value: '720', label: '紧凑 720px' },
  { value: '860', label: '标准 860px' },
  { value: '1000', label: '宽松 1000px' },
];

onMounted(() => {
  applyFont();
  applyWidth();
  loadAll();
  loadDbInfo();
  loadLoc();
  loadGlobalPrompt();
  loadWhale();
  // Computer Use 的状态进页面就读一次：总开关摆在哪都要看得见，重启警告也要靠它
  loadComputerState();
});

async function loadAll() {
  // 逐项独立加载：任何一项失败都要说出来，别静默用默认值盖住真值
  const bad = [];
  try {
    const sh = await aiApi.getShell();
    const rawCands = sh?.candidates || [];
    // 保留服务端给的中文名（PowerShell 5 / Git Bash / WSL Bash…），别只按文件名推，否则两个 bash 同名
    shellCandidates.value = (Array.isArray(rawCands) ? rawCands : [])
      .map((c) => (typeof c === 'object' && c ? { value: shellVal(c), label: c.label || '' } : { value: shellVal(c), label: '' }))
      .filter((c) => c.value);
    // 服务端字段是 current（早期写成 shell，导致回显永远落到第一个候选）
    const cur = shellVal(sh?.current || sh?.shell || '');
    shell.value = cur || shellCandidates.value[0]?.value || '';
    // 当前值不在候选里 = 用户自己填的路径，回填到「自定义 Shell 路径」里，别让输入框显示成空白
    shellCustom.value = cur && !shellCandidates.value.some((c) => c.value === cur) ? cur : '';
  } catch { bad.push('Shell'); }
  try {
    const st = await settingsApi.getAll();
    cmdTimeout.value = Number(st?.cmd_timeout_seconds ?? 360);
    defaultContext.value = Number(st?.default_context_limit ?? 0);
    rlRetryMax.value = Number(st?.rl_retry_max ?? 2);
  } catch { bad.push('上游设置'); }
  try {
    const am = await aiApi.getApprovalMode();
    approvalMode.value = am?.mode || 'default';
  } catch { bad.push('审批模式'); }
  try {
    const s = await aiApi.getSecrets();
    secrets.value = Array.isArray(s) ? s : (s?.rules || []);
  } catch { bad.push('脱敏规则'); }
  try {
    // 权限接口返回 {rules, kinds, lists, matches}，直接当数组用会永远是空表
    const pr = await aiApi.getPermissions();
    perms.value = Array.isArray(pr) ? pr : (pr?.rules || []);
    permMeta.value = {
      kinds: pr?.kinds || ['command', 'path', 'keyword', 'tool'],
      lists: pr?.lists || ['black', 'white'],
      matches: pr?.matches || ['exact', 'prefix', 'regex', 'contains'],
    };
  } catch { bad.push('权限规则'); }
  try {
    const sk = await aiApi.getSkills();
    skills.value = Array.isArray(sk) ? sk : (sk?.list || []);
  } catch { bad.push('技能'); }
  try {
    await loadTools();
  } catch { bad.push('工具'); }
  try {
    await loadMcp();
  } catch { bad.push('MCP'); }
  if (bad.length) toast(`部分设置读取失败：${bad.join('、')}（显示的可能是默认值）`, 'warn', 5000);
}

/** 工具清单（含 MCP 发现出来的）；启用/删除 MCP 服务器后要重新拉一次 */
async function loadTools() {
  const t = await aiApi.getApiTools();
  const list = Array.isArray(t) ? t : (t?.list || []);
  const prev = new Map(tools.value.map((x) => [x.name, x]));
  for (const x of list) {
    const old = prev.get(x.name);
    x.testResult = old ? old.testResult : null;
    x.testInput = old ? old.testInput : '';
  }
  tools.value = list;
}

/** 常规页这几项（显示、提示音、Agent 行为阈值）：改动即存即生效（数字先夹到合法区间，免得把服务端校验挡下的值发上去） */
const prefs = uiPrefs.state;
async function savePref(patch) {
  if (patch.compressKeep !== undefined) patch.compressKeep = Math.min(50, Math.max(0, Math.round(Number(patch.compressKeep) || 0)));
  if (patch.approvalTimeout !== undefined) patch.approvalTimeout = Math.min(3600, Math.max(30, Math.round(Number(patch.approvalTimeout) || 180)));
  if (patch.volume !== undefined) patch.volume = Math.min(1, Math.max(0, Number(patch.volume) || 0));
  if (patch.imgMaxSide !== undefined) patch.imgMaxSide = Math.min(8192, Math.max(0, Math.round(Number(patch.imgMaxSide) || 0)));
  if (patch.repeatBreak !== undefined) patch.repeatBreak = Math.min(20, Math.max(2, Math.round(Number(patch.repeatBreak) || 3)));
  const okk = await uiPrefs.save(patch);
  if (okk && patch.volume !== undefined && patch.sound !== false) soundApproval();
  return okk;
}

/* ---- 图片大小控制（实验室）----
   截图是这个 harness 里最大的一块请求体：1920×1200 一张 PNG 实测 2MB 上下，base64 后还要乘 4/3。
   缩放动作本身在桌面外壳里做（那里有 nativeImage，服务端是裸 node 没有图片编码器），
   这里只负责把上限写进 settings 让外壳读。 */
const IMG_SIZES = [
  { value: 0, label: '不限制' },
  { value: 480, label: '480p' },
  { value: 720, label: '720p' },
  { value: 900, label: '900p' },
  { value: 1080, label: '1080p' },
];
const imgCustomInput = ref(0);
// 「自定义」是不是当前生效的那一个：只在用户真的走输入框时高亮输入框、取消预设高亮，
// 否则预设按钮会全都不亮，看上去像没保存成功
const imgCustomPicked = computed(() =>
  prefs.imgMaxSide > 0 && !IMG_SIZES.some((p) => p.value === prefs.imgMaxSide));

async function pickImgSize(v) {
  imgCustomInput.value = v;
  await savePref({ imgMaxSide: v });
}
async function applyImgCustom() {
  const n = Math.min(8192, Math.max(0, Math.round(Number(imgCustomInput.value) || 0)));
  imgCustomInput.value = n;
  await savePref({ imgMaxSide: n });
}
// 输入框跟着真实值走：偏好是启动后异步拉回来的，不跟就会先亮着一个 0
watch(() => prefs.imgMaxSide, (v) => { imgCustomInput.value = v; }, { immediate: true });
function previewSound() {
  soundApproval();
}

async function saveUpstream() {
  const payload = {
    cmd_timeout_seconds: Number(cmdTimeout.value) || 0,
    default_context_limit: Number(defaultContext.value) || 0,
    rl_retry_max: Number(rlRetryMax.value) || 0,
  };
  try {
    await settingsApi.update(payload);
  } catch (e) {
    return toastErr(e, '上游设置保存失败');
  }
  if (shell.value) {
    try {
      await aiApi.setShell(shell.value);
    } catch (e) {
      return toastErr(e, 'Shell 设置失败');
    }
  }
  localStorage.setItem('nu_shell', shell.value || '');
  localStorage.setItem('nu_cmd_timeout', String(cmdTimeout.value));
  localStorage.setItem('nu_ctx', String(defaultContext.value));
  localStorage.setItem('nu_rl', String(rlRetryMax.value));
  await loadAll();   // 用服务端真值回填，保存后看到的和刷新后看到的一致
  toast('已保存', 'success');
}

async function setApproval(mode) {
  try {
    await aiApi.setApprovalMode(mode);
    approvalMode.value = mode;
    toast('审批模式已切换', 'success');
  } catch (e) {
    toastErr(e, '切换失败');
  }
}

async function addSecret() {
  if (!secretForm.value.trim()) return;
  try {
    await aiApi.createSecret({ pattern: secretForm.value.trim(), label: '手动添加' });
    secretForm.value = '';
    const s = await aiApi.getSecrets();
    secrets.value = Array.isArray(s) ? s : (s?.rules || []);
    toast('脱敏规则已添加', 'success');
  } catch (e) {
    toastErr(e, '添加失败');
  }
}

async function removeSecret(s) {
  try {
    await aiApi.deleteSecret(s.id);
    secrets.value = secrets.value.filter((x) => x.id !== s.id);
  } catch (e) {
    toastErr(e, '删除失败');
  }
}

const KIND_LABEL = { command: '命令', path: '路径', keyword: '关键词', tool: '工具' };
const LIST_LABEL = { black: '黑名单（拒绝）', white: '白名单（放行）' };
const MATCH_LABEL = { exact: '完全相等', prefix: '前缀', regex: '正则', contains: '包含' };

const kindItems = computed(() => permMeta.value.kinds.map((k) => ({ value: k, label: KIND_LABEL[k] || k })));
const listItems = computed(() => permMeta.value.lists.map((l) => ({ value: l, label: LIST_LABEL[l] || l })));
const matchItems = computed(() => permMeta.value.matches.map((m) => ({ value: m, label: MATCH_LABEL[m] || m })));

function permSummary(p) {
  return `${KIND_LABEL[p.kind] || p.kind} · ${p.list === 'white' ? '白' : '黑'} · ${MATCH_LABEL[p.match] || p.match} · ${p.pattern}`;
}

async function addPerm() {
  if (!permForm.pattern.trim()) return toast('请填写匹配内容', 'warn');
  try {
    await aiApi.createPermission({
      kind: permForm.kind,
      list: permForm.list,
      match: permForm.match,
      pattern: permForm.pattern.trim(),
      note: permForm.note.trim(),
    });
    permForm.pattern = '';
    permForm.note = '';
    const pr = await aiApi.getPermissions();
    perms.value = pr?.rules || [];
    toast('规则已添加并立即生效', 'success');
  } catch (e) {
    toastErr(e, '添加失败');
  }
}

async function removePerm(p) {
  try {
    await aiApi.deletePermission(p.id);
    perms.value = perms.value.filter((x) => x.id !== p.id);
  } catch (e) {
    toastErr(e, '删除失败');
  }
}

/** 试跑：把一条真实调用交给规则引擎，看它会被放行还是拦下 */
async function runPermTest() {
  try {
    const r = await aiApi.testPermission({
      tool: permTestForm.tool,
      command: permTestForm.command,
      paths: permTestForm.paths.split(/[\n;]+/).map((s) => s.trim()).filter(Boolean),
      text: permTestForm.text,
    });
    permTestResult.value = r;
  } catch (e) {
    toastErr(e, '试跑失败');
  }
}

async function importSkill() {
  if (!skillName.value.trim() || !skillBody.value.trim()) return toast('技能名与正文都要填', 'warn');
  try {
    await aiApi.importSkill({ name: skillName.value.trim(), content: skillBody.value });
    skillName.value = '';
    skillBody.value = '';
    skills.value = (await aiApi.getSkills()) || [];
    toast('技能已导入', 'success');
  } catch (e) {
    toastErr(e, '导入失败');
  }
}

const skillFileEl = ref(null);
function pickSkillFile() {
  if (skillFileEl.value) skillFileEl.value.click();
}

/**
 * 从本地 .md 导入技能：先读文件，再弹窗让他命名（默认就是去掉 .md 后缀的文件名）。
 * 撞名时服务端回 409，这里问一句要不要覆盖，而不是静悄悄把别人的技能换掉。
 */
async function onPickSkillFile(ev) {
  const file = ev.target.files && ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  let text = '';
  try {
    text = await file.text();
  } catch (e) {
    return toastErr(e, '读不出这个文件');
  }
  if (!text.trim()) return toast('这个文件是空的', 'warn');
  const guess = String(file.name || '').replace(/\.(md|markdown)$/i, '').trim() || 'skill';
  const name = await promptDialog({
    title: '导入技能',
    label: `来自 ${file.name}（${(text.length / 1024).toFixed(1)} KB），给它起个名字`,
    value: guess,
    confirmText: '导入',
  });
  if (!name) return;
  const send = async (overwrite) => {
    await aiApi.importSkill({ name, content: text, overwrite });
    skills.value = (await aiApi.getSkills()) || [];
    toast(`技能「${name}」已导入`, 'success');
  };
  try {
    await send(false);
  } catch (e) {
    if (e?.response?.status !== 409) return toastErr(e, '导入失败');
    if (!(await confirmDialog(`已有同名技能「${name}」，要覆盖它吗？`))) return;
    try {
      await send(true);
    } catch (e2) {
      toastErr(e2, '覆盖导入失败');
    }
  }
}

async function removeSkill(s) {
  try {
    await aiApi.deleteSkill(s.name);
    skills.value = skills.value.filter((x) => x.name !== s.name);
  } catch (e) {
    toastErr(e, '删除失败');
  }
}

/* ---------- 工具：按「内置增强 / MCP / 外部接口」三节 + 提供方·类别分组 ---------- */
/* 工具页搜索：名字/描述/提供方/分类都算命中，搜的时候只显示匹配的那几组，
   「本节全开/全关」也跟着筛选走 —— 看见什么就操作什么，别偷偷改动没显示的工具。 */
const toolQ = ref((localStorage.getItem('nu_tool_q') || '').trim());
const toolSections = computed(() => {
  const q = toolQ.value.toLowerCase().trim();
  const hit = (t) => !q
    || String(t.name || '').toLowerCase().includes(q)
    || String(t.label || '').toLowerCase().includes(q)
    || String(t.description || '').toLowerCase().includes(q)
    || String(t.provider || '').toLowerCase().includes(q)
    || String(t.category || '').toLowerCase().includes(q);
  const byKind = new Map();
  for (const t of tools.value) {
    if (!hit(t)) continue;
    const kind = t.kind === 'builtin' ? 'builtin' : (t.mcp || t.kind === 'mcp' ? 'mcp' : 'api');
    if (!byKind.has(kind)) byKind.set(kind, new Map());
    const gk = `${t.provider || '其它'} · ${t.category || '未分类'}`;
    const g = byKind.get(kind);
    if (!g.has(gk)) g.set(gk, []);
    g.get(gk).push(t);
  }
  const titles = { builtin: '内置增强工具', mcp: 'MCP 服务器工具', api: '外部 API 接口' };
  const rank = { builtin: 0, mcp: 1, api: 2 };
  return [...byKind.entries()].sort((a, b) => rank[a[0]] - rank[b[0]]).map(([kind, g]) => ({
    key: kind,
    title: titles[kind],
    total: [...g.values()].flat().length,
    onCount: [...g.values()].flat().filter((t) => t.enabled).length,
    groups: [...g.entries()].map(([name, list]) => ({
      name,
      tools: list,
      onCount: list.filter((t) => t.enabled).length,
    })),
  }));
});
const toolMatchCount = computed(() => toolSections.value.reduce((n, s) => n + s.total, 0));
function persistToolQ() { localStorage.setItem('nu_tool_q', toolQ.value); }

async function toggleTool(t) {
  try {
    await aiApi.updateApiTool(t.name, { enabled: !t.enabled, config: configOf(t) });
    t.enabled = !t.enabled;
    toast(t.enabled ? `${t.label || t.name} 已启用` : `${t.label || t.name} 已停用`, 'success');
  } catch (e) {
    toastErr(e, '操作失败');
  }
}

const bulkBusy = ref(false);

/** 整组开关：一个套装十几个工具逐个点不叫功能，一次请求落库后重拉清单（不靠本地乐观改值） */
async function bulkSet(list, enabled, label) {
  const names = (list || []).map((t) => t.name).filter(Boolean);
  if (!names.length) return toast('这一组里没有工具', 'warn');
  bulkBusy.value = true;
  try {
    const r = await aiApi.bulkTools(names, enabled);
    await loadTools();
    const n = r?.changed ?? names.length;
    toast(`${label}：${enabled ? '已启用' : '已停用'} ${n} 个工具${r?.ignored?.length ? `，忽略 ${r.ignored.length} 个未注册` : ''}`, 'success');
  } catch (e) {
    toastErr(e, '批量开关失败');
  } finally {
    bulkBusy.value = false;
  }
}

function setGroupAll(g, enabled) {
  return bulkSet(g.tools, enabled, g.name);
}

function setSectionAll(sec, enabled) {
  return bulkSet(sec.groups.flatMap((g) => g.tools), enabled, sec.title);
}

function configOf(t) {
  const cfg = {};
  for (const f of t.configFields || []) cfg[f.key] = f.value;
  return cfg;
}

async function saveToolConfig(t) {
  try {
    await aiApi.updateApiTool(t.name, { enabled: t.enabled, config: configOf(t) });
    toast(`${t.label || t.name} 配置已保存`, 'success');
  } catch (e) {
    toastErr(e, '保存失败');
  }
}

/* ---------- MCP 服务器 ---------- */
const MCP_TRANSPORTS = [
  { value: 'stdio', label: 'stdio（本机子进程）' },
  { value: 'http', label: 'HTTP（Streamable HTTP）' },
];
const mcpServers = ref([]);
const mcpBusy = ref(0);
const mcpSaving = ref(false);
const emptyMcp = () => ({ id: 0, name: '', transport: 'stdio', command: '', argsText: '', cwd: '', envText: '', url: '', headersText: '', enabled: true });
const mcpForm = reactive(emptyMcp());

function mcpStatusText(s) {
  if (s.enabled && s.connected) return '已连接';
  return { live: '就绪未启用', error: '连接失败', dead: '子进程已退出', off: '未启用' }[s.status] || s.status || '未启用';
}

/** 与 server/utils/mcp.js 的 slug() 同规则，仅用于界面展示真实工具名 */
function mcpSlug(name) {
  const s = String(name || '').trim().replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return (s || 'server').slice(0, 20);
}

function parseArgsText(text) {
  const t = String(text || '').trim();
  if (!t) return [];
  if (t.startsWith('[')) {
    const v = JSON.parse(t);
    if (!Array.isArray(v)) throw new Error('args 必须是 JSON 数组');
    return v.map(String);
  }
  return t.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
}

function parseObjText(text, label) {
  const t = String(text || '').trim();
  if (!t) return {};
  const v = JSON.parse(t);
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${label} 必须是 JSON 对象`);
  return v;
}

async function loadMcp() {
  try {
    const list = await aiApi.getMcpServers();
    mcpServers.value = (Array.isArray(list) ? list : []).map((s) => ({ ...s, open: false }));
  } catch (e) {
    toastErr(e, 'MCP 列表读取失败');
  }
}

function mcpBodyFromForm() {
  return {
    name: mcpForm.name,
    transport: mcpForm.transport,
    command: mcpForm.command,
    args: parseArgsText(mcpForm.argsText),
    cwd: mcpForm.cwd,
    env: parseObjText(mcpForm.envText, 'env'),
    url: mcpForm.url,
    headers: parseObjText(mcpForm.headersText, 'headers'),
    enabled: !!mcpForm.enabled,
  };
}

async function saveMcp() {
  mcpSaving.value = true;
  try {
    const body = mcpBodyFromForm();
    const r = mcpForm.id ? await aiApi.updateMcpServer(mcpForm.id, body) : await aiApi.createMcpServer(body);
    toast(r?.message || '已保存', r?.data?.error ? 'warn' : 'success');
    resetMcpForm();
    await loadMcp();
    await loadTools();          // 工具清单多了 MCP 一节，设置页要跟着刷新
  } catch (e) {
    toastErr(e, '保存失败（args/env 得是合法 JSON）');
  } finally {
    mcpSaving.value = false;
  }
}

function resetMcpForm() {
  Object.assign(mcpForm, emptyMcp());
}

function editMcp(s) {
  Object.assign(mcpForm, {
    id: s.id,
    name: s.name,
    transport: s.transport,
    command: s.command || '',
    argsText: JSON.stringify(s.args || [], null, 1),
    cwd: s.cwd || '',
    envText: Object.keys(s.env || {}).length ? JSON.stringify(s.env, null, 1) : '',
    url: s.url || '',
    headersText: Object.keys(s.headers || {}).length ? JSON.stringify(s.headers, null, 1) : '',
    enabled: !!s.enabled,
  });
}

/** 这台服务器发现出来的工具整组开关（按 provider 认，服务器名就是 provider） */
function setMcpToolsAll(s, enabled) {
  const list = tools.value.filter((t) => t.mcp && t.provider === s.name);
  return bulkSet(list, enabled, `MCP「${s.name}」`);
}

/* ---------- 数据库导出 / 导入 ---------- */
const dbInfo = ref({});
const importing = ref(false);
const fileEl = ref(null);
const canRestart = typeof window !== 'undefined' && !!(window.khDesktop && window.khDesktop.isDesktop);
const isDesktop = canRestart;
const exportUrl = '/api/ai/database/export';

async function loadDbInfo() {
  try {
    dbInfo.value = (await aiApi.getDatabase()) || {};
  } catch (e) { /* 拦截器已经提示过 */ }
}

function pickImportFile() {
  fileEl.value?.click();
}

async function onPickImport(e) {
  const file = e.target?.files?.[0];
  e.target.value = '';            // 允许连续选同一个文件
  if (!file) return;
  importing.value = true;
  try {
    const r = await aiApi.importDatabase(file);
    toast(r?.message || '已暂存，重启后生效', 'success', 8000);
    await loadDbInfo();
  } catch (err) {
    // 校验失败的具体原因（魔数不对 / 完整性坏了 / 不是 KHarness 的表）由后端给出
    toastErr(err, '导入失败', 8000);
  } finally {
    importing.value = false;
  }
}

async function cancelImport() {
  try {
    await aiApi.cancelDatabaseImport();
    toast('已撤销待应用的导入', 'success');
    await loadDbInfo();
  } catch (e) { /* 拦截器已提示 */ }
}

async function restartNow() {
  try {
    const r = await window.khDesktop.restartApp();
    if (!r?.ok) toast('外壳没能重启后端，请手动重启', 'warn', 8000);
  } catch (e) {
    toastErr(e, '重启失败');
  }
}

/* ---------- 改数据库位置 / 恢复出厂设置（都只在桌面端开放） ---------- */
const FACTORY_PHRASE = '我确认清空数据库，并理解删除后无法找回';
const loc = ref({});
const locBusy = ref(false);
const factoryPhrase = ref('');
const factoryClicks = ref(0);
const factoryBusy = ref(false);
// 只掐首尾空白：全角逗号、中间的字都得对上，多打一个空格就不算确认
const factoryArmed = computed(() => factoryPhrase.value.trim() === FACTORY_PHRASE);

// 改过确认语就把点击计数清零：三次点击必须是「对着同一句话」连点
watch(factoryPhrase, () => { factoryClicks.value = 0; });

function resetFactoryFlow() {
  factoryClicks.value = 0;
}

async function loadLoc() {
  if (!isDesktop) return;
  try {
    const r = await window.khDesktop.dbLocation('info');
    if (r && r.ok === false) loc.value = { error: String(r.error || '外壳读不到数据库信息') };
    else loc.value = r || { error: '外壳没有回应' };
  } catch (e) {
    loc.value = { error: String((e && e.message) || e) };
  }
}

async function chooseDbDir() {
  let picked = null;
  try {
    picked = await window.khDesktop.dbLocation('pick');
  } catch (e) {
    return toastErr(e, '选目录失败');
  }
  if (!picked?.ok) {
    if (!picked?.canceled) toast(picked?.error || '选目录失败', 'error', 8000);
    return;
  }
  const dir = String(picked.dir || '');
  const ok = await confirmDialog(
    `数据库将改到：\n${dir}\n\n那里已有 kh.db 就直接改用，否则先复制一份过去。原目录的文件不会删除，重启后生效。`,
    { title: '改数据库位置', danger: true },
  );
  if (!ok) return;
  locBusy.value = true;
  try {
    const r = await window.khDesktop.dbLocation('set', dir);
    if (!r?.ok) return toast(r?.error || '改位置失败', 'error', 8000);
    loc.value = { ...loc.value, needsRestart: true, file: r.file, used_existing: r.used_existing, dir };
    toast(r.used_existing
      ? '目标已有数据库，重启后直接改用；现在可以点「重启并生效」'
      : '已复制一份到新位置，重启后从这里打开；现在可以点「重启并生效」', 'success', 9000);
    await loadDbInfo();
  } catch (e) {
    toastErr(e, '改位置失败', 8000);
  } finally {
    locBusy.value = false;
  }
}

// 三次点击：前两/三次只是「再确认一遍」，第三次才真的向后端落清库标记
async function factoryConfirm() {
  if (!factoryArmed.value) return;
  if (factoryClicks.value < 2) {
    factoryClicks.value += 1;
    toast(`已确认 ${factoryClicks.value}/3 —— 还要再点 ${3 - factoryClicks.value} 次才会真的清空`, 'warn', 5000);
    return;
  }
  const ok = await confirmDialog(
    '最后一次确认：重启后数据库将被清空且没有备份，模型配置、全部会话与消息、用量记录、设置都找不回来。',
    { title: '恢复出厂设置', danger: true },
  );
  if (!ok) return;
  factoryClicks.value = 3;
  factoryBusy.value = true;
  try {
    const r = await window.khDesktop.factoryReset();
    if (!r?.ok) {
      factoryClicks.value = 0;
      return toast(r?.error || '排定清库失败', 'error', 8000);
    }
    if (r.needsManualRestart) toast('清库已排定，但外壳没能自动重启后端：请手动重启一次', 'warn', 12000);
    else toast('已排定：后端正在重启，重启完成时数据库即被清空', 'warn', 12000);
    await loadLoc();
  } catch (e) {
    factoryClicks.value = 0;
    toastErr(e, '恢复出厂失败', 8000);
  } finally {
    factoryBusy.value = false;
  }
}

async function reconnectMcp(s) {
  mcpBusy.value = s.id;
  try {
    const r = await aiApi.reconnectMcpServer(s.id);
    const n = r?.data?.tools?.length || 0;
    toast(r?.data?.error ? `连接失败：${r.data.error}` : `已连接，发现 ${n} 个工具`, r?.data?.error ? 'error' : 'success');
    await loadMcp();
    await loadTools();
  } catch (e) {
    toastErr(e, '重连失败');
  } finally {
    mcpBusy.value = 0;
  }
}

async function toggleMcp(s) {
  try {
    const r = await aiApi.updateMcpServer(s.id, { ...s, args: s.args, env: s.env, headers: s.headers, enabled: !s.enabled });
    toast(r?.message || (s.enabled ? '已停用' : '已启用'), r?.data?.error ? 'warn' : 'success');
    await loadMcp();
    await loadTools();
  } catch (e) {
    toastErr(e, '操作失败');
  }
}

async function removeMcp(s) {
  try {
    await aiApi.deleteMcpServer(s.id);
    toast(`已删除「${s.name}」，其工具同时从注册表摘除`, 'success');
    await loadMcp();
    await loadTools();
  } catch (e) {
    toastErr(e, '删除失败');
  }
}

async function testTool(t) {
  t.testResult = { loading: true };
  try {
    const args = {};
    const raw = (t.testInput || '').trim();
    if (raw && raw.startsWith('{')) {
      // MCP 工具多为多参数 / 嵌套参数，直接写 JSON 最省事
      const v = JSON.parse(raw);
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('试跑参数需是 JSON 对象');
      Object.assign(args, v);
    } else if (t.testArg && raw) {
      args[t.testArg] = raw;
    }
    const r = await aiApi.testApiTool(t.name, args);
    t.testResult = { ok: !!r?.ok, text: r?.text || '（空输出）' };
  } catch (e) {
    t.testResult = { ok: false, text: e?.response?.data?.message || e.message || '调用失败' };
  }
}
</script>

<style scoped>
/* 全局提示词那一行：路径可能很长，省略号收，鼠标悬停看全 */
.gp-note { margin: 0 0 4px; line-height: 1.7; }
.gp-line { display: flex; align-items: center; gap: 10px; min-width: 0; }
.gp-path {
  flex: 1;
  min-width: 0;
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.gp-state { font-size: 11.5px; color: var(--ok); flex-shrink: 0; }
.gp-state.new { color: var(--text-3); }
.page { padding: 24px 28px 40px; max-width: 900px; margin: 0 auto; }
/* 实验室里「待实装」那枚牌子：比开关轻，明摆着现在点不动 */
.lab-wip {
  font-size: 11px;
  color: var(--text-3);
  border: 1px dashed var(--border-strong);
  border-radius: 999px;
  padding: 2px 10px;
  white-space: nowrap;
}
/* ---- Computer Use 面板：行都用现成的 k-row-card / k-switch / tag，只补这一套排布 ---- */
.cu-head { display: flex; align-items: center; gap: 12px; }
.cu-body {
  margin-top: 12px;
  padding-top: 4px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-top: 1px solid var(--border-soft);
}
.cu-sec { margin-top: 10px; font-size: 12px; font-weight: 600; color: var(--text-2); }
.cu-line { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12px; }
.cu-k { color: var(--text-2); }
.cu-k.strong { color: var(--danger); font-weight: 600; }
/* 「全部开放」整行染红：这一颗键的后果跟别的开关不是一个量级 */
.cu-danger-line {
  padding: 8px 10px;
  border: 1px solid var(--danger-line);
  border-radius: var(--radius-sm);
  background: var(--danger-soft);
}
.k-switch.danger.on { background: var(--danger); border-color: var(--danger); }
.k-switch.danger.on::after { background: var(--on-scrim); }
.tag.cu-ok { color: var(--ok); border-color: var(--ok-line); }
.tag.cu-bad, .tag.cu-err { color: var(--danger); border-color: var(--danger-line); }
.tag.cu-off { color: var(--text-3); }
.cu-err { margin: 0; color: var(--danger); font-size: 11.5px; line-height: 1.6; word-break: break-all; white-space: pre-wrap; }
pre.cu-err {
  padding: 8px 10px;
  max-height: 130px;
  overflow: auto;
  background: var(--bg-panel);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
}
/* 录入中的那颗：边框点亮 + 文案在闪，一眼看得出「现在按的东西会被吃掉」 */
.cu-capture { display: inline-flex; align-items: center; gap: 6px; }
.cu-capture.listening { border-color: var(--accent); color: var(--accent); }

/* 图片大小控制的预设档：选中态用主色描边 + 淡底，和右侧栏那套开关同一语言 */
.img-pick.on { border-color: var(--accent); color: var(--accent); background: var(--accent-soft, rgba(120, 170, 255, 0.14)); }
.img-custom { width: 96px; }
.cu-exe { max-width: 210px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cu-ellip { max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cu-ack-text { margin: 0 0 8px; line-height: 1.7; }
.page { padding: 24px 28px 40px; max-width: 900px; margin: 0 auto; }
/* 分页切换：新的从下面一点淡入，旧的快速让开，150ms 内完事。
   容器保持普通块级流 —— 卡片自己带 margin-top，别再叠一层 flex gap。 */
.pane-wrap { display: block; }
.pane-enter-active { transition: opacity 0.16s ease, transform 0.18s var(--ease); }
.pane-leave-active { transition: opacity 0.09s ease; }
.pane-enter-from { opacity: 0; transform: translateY(8px); }
.pane-leave-to { opacity: 0; }
@media (prefers-reduced-motion: reduce) {
  .pane-enter-active,
  .pane-leave-active { transition: none; }
}
.page-head { margin-bottom: 16px; }
.page-head h1 { margin: 0; font-size: 20px; }
.page-head p { margin: 4px 0 0; color: var(--text-3); font-size: 12px; }
.card {
  background: var(--bg-elev);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius);
  padding: 14px;
  margin-top: 14px;
}
.card h3 { margin: 0 0 12px; font-size: 14px; }
.form { display: flex; flex-direction: column; gap: 12px; max-width: 560px; }
.field { display: flex; flex-direction: column; gap: 6px; }
.field span { font-size: 12px; color: var(--text-3); }
/* 勾选项：方框和文字并排，整行可点 */
.field.line { flex-direction: row; align-items: center; gap: 8px; cursor: pointer; }
.field.line span { font-size: 12px; color: var(--text-2); }
/* 自定义 Shell：输入框 + 那颗「用这个」贴在一起，路径长会截断（有 title 可看全） */
.shell-custom { display: flex; align-items: flex-end; gap: 8px; }
.shell-custom :deep(.k-input) { flex: 1 1 auto; min-width: 0; }
.shell-custom .k-btn { flex: 0 0 auto; margin-bottom: 2px; }
.field-note { margin: 2px 0 0; font-size: 11px; line-height: 1.6; color: var(--text-3); }
.slider-line { display: flex; align-items: center; gap: 10px; }
.tool-search { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.tool-search .k-input { flex: 1; }
.slider-line input[type="range"] { flex: 1; accent-color: var(--accent); }
.w120 { width: 120px; }
.input, .textarea {
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
}
.textarea { width: 100%; resize: vertical; font-family: var(--mono); font-size: 12px; }
.grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; }
.grid-4 { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; align-items: end; }
.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; align-items: end; }
h4.sub { margin: 16px 0 8px; font-size: 13px; color: var(--text-2); }
.group-head { margin: 12px 0 6px; font-size: 12px; color: var(--text-3); }
.perm-out, .tool-out {
  margin: 8px 0 0;
  padding: 8px 10px;
  max-height: 240px;
  overflow: auto;
  background: var(--bg-panel);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  font-family: var(--mono);
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--text-2);
}
.tool-out.err { color: var(--danger); border-color: var(--danger-line); }
.tool-card {
  padding: 10px 0;
  border-bottom: 1px solid var(--border-soft);
}
.tool-card:last-child { border-bottom: 0; }
.tool-card .name { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tag {
  font-size: 10px;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--text-3);
}
.tag.dim { opacity: 0.7; }
.src { font-family: var(--mono); font-size: 11px; opacity: 0.75; margin-top: 2px; }
.cfg {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: flex-end;
  margin-top: 8px;
  padding: 8px 10px;
  background: var(--bg-panel);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
}
.cfg-item { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--text-3); min-width: 140px; }
.cfg-item input.k-input { padding: 5px 8px; font-size: 12px; }
.run { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
.run input.k-input { flex: 1; padding: 6px 8px; font-size: 12px; }
.row {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 10px 0;
  border-bottom: 1px solid var(--border-soft);
}
.row:last-child { border-bottom: 0; }
.grow { flex: 1; min-width: 0; }
.name { font-weight: 500; }
.mono { font-family: var(--mono); font-size: 12px; word-break: break-all; }
.muted { color: var(--text-3); font-size: 12px; }
.links { display: flex; gap: 8px; flex-wrap: wrap; }
.btn {
  border: 1px solid var(--border);
  background: var(--bg-panel);
  color: var(--text);
  border-radius: var(--radius-xs);
  padding: 6px 12px;
  font-size: 12px;
}
.btn.sm { padding: 4px 8px; font-size: 11px; }
.btn.primary { background: var(--accent); border-color: transparent; color: var(--on-accent); font-weight: 600; }
.btn.danger { color: var(--danger); }

/* 主题选择卡：预览条用当前主题自己的令牌，所以选中的那张一眼能看出效果 */
.theme-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
  gap: 10px;
}
.theme-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  text-align: left;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-panel);
  color: var(--text-2);
  transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.theme-card:hover { border-color: var(--border-strong); color: var(--text); }
.theme-card.on { border-color: var(--accent); color: var(--text); }
.theme-name { font-size: 12.5px; font-weight: 600; }
.theme-desc { font-size: 11px; color: var(--text-3); line-height: 1.45; }
.theme-prev {
  display: block;
  height: 46px;
  border-radius: var(--radius-xs);
  border: 1px solid var(--border-soft);
  overflow: hidden;
  position: relative;
  padding: 8px;
}
.pv-bar {
  display: block;
  height: 6px;
  width: 40%;
  border-radius: 3px;
  background: var(--text-3);
  margin-bottom: 8px;
}
.pv-line { display: block; height: 5px; border-radius: 3px; background: var(--text-2); opacity: 0.55; }
.pv-line.short { width: 62%; margin-top: 5px; opacity: 0.32; }
.prev-dark { background: #0d0d0d; }
.prev-light { background: #faf0eb; }
.prev-gray { background: #e9ebee; }
.prev-aurora-blue {
  background:
    radial-gradient(120px 70px at 18% 8%, #2fd4c4 0%, transparent 68%),
    radial-gradient(130px 80px at 82% 34%, #1f6fb8 0%, transparent 70%),
    #05080f;
}
.prev-aurora-purple {
  background:
    radial-gradient(120px 70px at 20% 10%, #c0479e 0%, transparent 68%),
    radial-gradient(130px 80px at 80% 36%, #6d3fc4 0%, transparent 70%),
    #07050f;
}
.prev-starry {
  background:
    radial-gradient(1.5px 1.5px at 22% 30%, #e8ebf2 50%, transparent 51%),
    radial-gradient(1.5px 1.5px at 64% 18%, #e8ebf2 50%, transparent 51%),
    radial-gradient(1.5px 1.5px at 82% 62%, #e8ebf2 50%, transparent 51%),
    radial-gradient(1.5px 1.5px at 38% 74%, #e8ebf2 50%, transparent 51%),
    #000000;
}
.prev-light .pv-bar, .prev-gray .pv-bar { background: #8b7c74; }
.prev-light .pv-line, .prev-gray .pv-line { background: #3a322e; }

/* MCP 面板 */
.mono { font-family: var(--mono); }
.row-actions { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.link-btn { background: none; border: 0; color: var(--text-3); font-size: 11px; padding: 2px 0; }
.link-btn:hover { color: var(--text-2); }
.mcp-err { font-size: 11px; color: var(--danger); word-break: break-all; margin-top: 3px; }
.mcp-tools {
  margin: 8px 0;
  padding: 8px 10px;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-xs);
  background: var(--bg-soft);
  max-height: 320px;
  overflow: auto;
}
.mcp-tool {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  padding: 3px 0;
  border-bottom: 1px dashed var(--border-soft);
}
.mcp-tool:last-child { border-bottom: 0; }
.mcp-tool code { font-family: var(--mono); font-size: 11px; color: var(--text-2); flex-shrink: 0; }
.mcp-tool .muted {
  flex: 1 1 auto;
  min-width: 0; /* 没有这条，长描述会把旁边的徽标挤成竖排 */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mcp-danger { color: var(--danger); border-color: var(--danger-line); }
.warn-text { color: var(--warn); font-size: 12px; }
/* 卡片内的小标题：把「导出/导入」和「改位置」两段隔开，不用另起一张卡 */
.sub-head {
  margin: 14px 0 6px;
  padding-top: 12px;
  border-top: 1px solid var(--border-soft);
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-2);
}
/* 确认语单独再显示一行，方便逐字对着抄；不靠 placeholder，因为一输入就看不见了 */
.phrase-hint {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--text-2);
  letter-spacing: 0.2px;
  user-select: all;
}
.phrase-steps { display: inline-flex; align-items: center; gap: 6px; }
.phrase-steps i {
  width: 22px;
  height: 4px;
  border-radius: 2px;
  background: var(--border-strong);
  transition: background var(--dur) var(--ease);
}
.phrase-steps i.on { background: var(--danger); }
.set-actions { margin-left: auto; display: inline-flex; gap: 6px; align-items: center; }
.tool-sec h4.sub { display: flex; align-items: center; gap: 8px; }
.group-head { display: flex; align-items: center; gap: 8px; }
a.k-btn { display: inline-flex; align-items: center; text-decoration: none; }
.tag.mcp-live { color: var(--ok); border-color: var(--ok-line); }
.tag.mcp-error, .tag.mcp-dead { color: var(--danger); border-color: var(--danger-line); }
.tag.mcp-off { color: var(--text-3); }
</style>
