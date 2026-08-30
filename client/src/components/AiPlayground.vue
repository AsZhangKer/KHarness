<template>
  <div class="pg-page" :class="{ 'pg-immersive': immersive }">
  <div class="pg-shell">
    <!-- 左栏：项目与会话 -->
    <aside class="pg-side" v-show="sidebarOpen" :style="{ width: sideWidth + 'px' }">
      <div class="pg-side-actions">
        <button class="btn btn-small pg-side-new" @click="openProjectModal" title="新建项目（绑定工作目录，其下会话的目录被限制在项目内）">
          <i class="fas fa-folder-plus"></i> 新建项目
        </button>
        <button class="btn btn-small pg-side-new" @click="createChatNamed(activeProjectObj)" title="新建会话（选中项目时归入该项目，否则为顶层自由会话）">
          <i class="fas fa-plus"></i> 新建会话
        </button>
      </div>
      <div class="pg-side-scroll">
        <div class="pg-side-group">
          <div class="pg-side-head">
            <i class="fas fa-comments"></i> 自由会话
            <span class="pg-side-count">{{ freeChats.length }}</span>
          </div>
          <div
            v-for="c in freeChats"
            :key="'f' + c.id"
            class="pg-side-item"
            :class="{ active: c.id === chatId }"
            :title="c.title || '未命名会话'"
            @click="loadChat(c.id)"
          >
            <i class="fas fa-message pg-side-item-icon"></i>
            <span class="pg-side-item-title">{{ c.title || '未命名会话' }}</span>
            <button class="pg-side-item-del" title="删除会话" @click.stop="removeChat(c.id)">
              <i class="fas fa-trash"></i>
            </button>
          </div>
          <div v-if="!freeChats.length" class="pg-side-empty">暂无会话</div>
        </div>

        <div v-for="p in projects" :key="p.id" class="pg-side-group">
          <div class="pg-side-head pg-side-head-project" :title="p.root_path" @click="toggleProject(p.id)">
            <i class="fas" :class="projExpanded(p.id) ? 'fa-folder-open' : 'fa-folder'"></i>
            <span class="pg-side-proj-name">{{ p.name }}</span>
            <span class="pg-side-count">{{ p.chat_count }}</span>
            <span class="pg-side-head-btns">
              <button class="pg-side-btn" :title="`在项目「${p.name}」下新建会话`" @click.stop="createChatNamed(p)">
                <i class="fas fa-plus"></i>
              </button>
              <button class="pg-side-btn pg-side-btn-del" title="删除项目" @click.stop="removeProject(p)">
                <i class="fas fa-trash"></i>
              </button>
            </span>
          </div>
          <Transition name="pg-expand">
            <div v-if="projExpanded(p.id)" class="pg-side-group-body">
              <div
                v-for="c in chatsOf(p.id)"
                :key="'p' + c.id"
                class="pg-side-item"
                :class="{ active: c.id === chatId }"
                :title="c.title || '未命名会话'"
                @click="loadChat(c.id)"
              >
                <i class="fas fa-message pg-side-item-icon"></i>
                <span class="pg-side-item-title">{{ c.title || '未命名会话' }}</span>
                <button class="pg-side-item-del" title="删除会话" @click.stop="removeChat(c.id)">
                  <i class="fas fa-trash"></i>
                </button>
              </div>
              <div v-if="!chatsOf(p.id).length" class="pg-side-empty">项目下暂无会话，点 + 新建</div>
            </div>
          </Transition>
        </div>

        <div v-if="!projects.length" class="pg-side-empty pg-side-empty-first">
          还没有项目，点击上方「新建项目」创建；<br>不建项目也可直接用自由会话
        </div>
      </div>
      <div class="pg-side-foot" title="所有会话共享同一套模型列表；项目会话的 /dir 与工具目录被限制在项目根目录内，自由会话可任意切换">
        <i class="fas fa-circle-info"></i> 项目会话目录限制在项目内
      </div>
    </aside>

    <!-- 拖拽分隔条：调整项目/会话栏宽度 -->
    <div v-if="sidebarOpen" class="pg-resizer" @mousedown="startResize('side', $event)" title="拖动调整宽度"></div>

    <div class="pg-modal pg-page-modal" :class="{ 'pg-modal-wide': !panelOpen }">
          <div class="pg-header">
            <div class="pg-title">
              <button class="btn btn-small pg-side-toggle" @click="sidebarOpen = !sidebarOpen" title="显示/隐藏 项目与会话栏">
                <i class="fas fa-bars"></i>
              </button>
              <i class="fas fa-terminal"></i>
              <button class="btn btn-small pg-model-btn" data-tour="pg-model-btn" @click="onModelBtn" title="切换模型（/model 指令）">
                <i class="fas fa-robot"></i>
                {{ autoMode ? '自动模式（模型池）' : activeModel?.display_name || '选择模型' }}
                <i class="fas fa-caret-down"></i>
              </button>
            </div>
            <div class="pg-header-actions">
              <button
                class="btn btn-small"
                data-tour="pg-agent"
                :class="agentMode ? 'btn-primary' : 'btn-secondary'"
                :title="agentMode ? 'Agent 已开启：AI 可执行命令、读写文件。点击关闭。AGENT.md 位置：' + pAgentsPath + '（全局）+ 项目根/AGENTS.md 或 AGENT.md（项目/目录级），纯 Markdown，无 frontmatter 要求' : 'Agent 已关闭：点击开启后 AI 才能执行命令操作服务器。AGENT.md 同上'"
                @click="toggleAgent"
              >
                <i class="fas fa-screwdriver-wrench"></i> Agent {{ agentMode ? '开' : '关' }}
              </button>
              <span class="pg-agent-help" title="AGENT.md / AGENTS.md 说明&#10;位置：&#10; 1. 全局：~/.kharness/AGENTS.md 或 AGENT.md&#10; 2. 项目：<项目根>/AGENTS.md 或 AGENT.md&#10; 3. 自由会话：<当前目录>/AGENTS.md 或 AGENT.md&#10;格式：纯 Markdown，首行可为 # 标题，正文为长期记忆/规范&#10;优先级：全局 + 项目/目录叠加，上限 200KB"><i class="fas fa-circle-question"></i></span>
              <button
                class="btn btn-small"
                data-tour="pg-plan"
                :class="planMode ? 'btn-primary' : 'btn-secondary'"
                title="任务模式：AI 先输出计划并维护右侧任务列表（/mode plan）"
                @click="togglePlan"
              >
                <i class="fas fa-list-check"></i> Plan {{ planMode ? '开' : '关' }}
              </button>
              <button class="btn btn-small" @click="createChatNamed(activeProjectObj)" title="新建会话（选中项目时归入该项目，否则为顶层自由会话）">
                <i class="fas fa-plus"></i> 新对话
              </button>
              <button class="btn btn-small" @click="toggleImmersion" :title="immersive ? '退出沉浸模式' : '沉浸模式：全屏平铺'">
                <i class="fas" :class="immersive ? 'fa-compress' : 'fa-expand'"></i>
              </button>
            </div>
          </div>

          <div class="pg-subheader">
            <span v-if="chatTitle" class="pg-sub-chat"><i class="fas fa-message"></i> {{ chatTitle }}</span>
            <span v-if="activeProjectObj" class="pg-sub-proj" :title="activeProjectObj.root_path">
              <i class="fas fa-folder"></i> {{ activeProjectObj.name }}
            </span>
            <span v-if="agentMode" class="pg-sub-cwd" title="Agent 工具执行目录，输入 /dir 路径 可切换（项目会话限制在项目根内）">
              <i class="fas fa-folder"></i> {{ cwd }}
            </span>
            <span v-if="bypassMode" class="pg-sub-bypass" title="自动审批模式：工具调用不再需要人工批准">
              <i class="fas fa-shield-halved"></i> 自动审批
            </span>
            <span class="pg-ctx" :title="contextLimit > 0 ? `上下文用量 ${contextUsed}/${contextLimit} 字符，达 80% 自动压缩` : '输入 /context <数值> 设定上下文窗口'">
              <i class="fas fa-ruler-horizontal"></i>
              <template v-if="contextLimit > 0">
                <span class="pg-ctx-bar"><span class="pg-ctx-fill" :class="{ warn: ctxPct >= 80 }" :style="{ width: ctxPct + '%' }"></span></span>
                {{ contextUsed }}/{{ contextLimit }} · 剩 {{ Math.max(0, contextLimit - contextUsed) }}
              </template>
              <template v-else>本轮 {{ contextUsed }} 字符 · 未设窗口（/context N）</template>
            </span>
          </div>

          <div class="pg-body">
            <div class="pg-messages" ref="messagesRef" @click="onCopyClick">              <div v-if="messages.length === 0" class="pg-empty">
                <i class="fas fa-comments"></i>
                <p>开始对话，自动保存上下文；可随时 /model 切换模型延续上下文</p>
                <p class="pg-hint">/model [ID] 切换模型 ｜ /pool 模型池 ｜ /mode auto 自动模式 ｜ /press 压缩上下文 ｜ /context N 设定窗口 ｜ /exit 退出</p>
                <p v-if="!agentMode" class="pg-hint pg-hint-agent">
                  <i class="fas fa-screwdriver-wrench"></i>
                  想让 AI 执行命令、读写文件？点击右上角 <b>Agent 开</b>（/dir 路径 可切换工作目录）
                </p>
              </div>
              <div
                v-for="(msg, i) in messages"
                :key="i"
                :id="msg.userMsgId || msg._id ? 'kh-msg-' + (msg.userMsgId || msg._id) : undefined"
                class="pg-msg"
                :class="[msg.role === 'note' ? 'pg-note' : 'pg-' + msg.role, { 'pg-flash': highlightId && (msg.userMsgId || msg._id) === highlightId }]"
                v-show="i < splitIdx ? historyExpanded : true"
              >
                <!-- 上文折叠开关（预览 5 行） -->
                <button v-if="i === splitIdx && !historyExpanded && splitIdx > 0" class="pg-history-toggle" @click="historyExpanded = true">
                  <i class="fas fa-caret-right"></i> 展开上文（{{ splitIdx }} 条已折叠）
                  <div class="pg-history-preview">{{ historyPreview }}</div>
                </button>

                <!-- 系统提示行（本地） -->
                <div v-if="msg.role === 'note'" class="pg-note-line"><i class="fas fa-circle-info"></i> {{ msg.content }}</div>

                <template v-else>
                  <div class="pg-msg-meta" v-if="msg.role === 'assistant' && (msg.model_name || msg.model)">
                    <span class="pg-msg-model"><i class="fas fa-robot"></i> {{ msg.model_name || msg.model?.display_name }}</span>
                  </div>
                  <div class="pg-bubble" :class="{ 'pg-bubble-assistant': msg.role === 'assistant' }">
                    <!-- 思考过程（默认折叠，可展开） -->
                    <div v-if="msg.role === 'assistant' && (msg.reasoning || msg.reasoningOpen)" class="pg-reason">
                      <div class="pg-reason-head" @click="msg.reasoningOpen = !msg.reasoningOpen">
                        <i class="fas fa-brain"></i> 思考过程
                        <i class="fas" :class="msg.reasoningOpen ? 'fa-caret-down' : 'fa-caret-right'"></i>
                      </div>
                      <pre v-if="msg.reasoningOpen" class="pg-reason-body">{{ msg.reasoning || '(模型未返回思考内容)' }}</pre>
                    </div>

                    <!-- 内容区 -->
                    <template v-if="msg.role === 'user'">
                      <template v-for="(part, pi) in splitParts(msg.content)" :key="pi">
                        <img
                          v-if="part.type === 'image'"
                          class="pg-chat-img"
                          :src="'/api/ai/chat/image/' + part.token"
                          alt="图片"
                          @error="imgBroken($event)"
                        >
                        <span v-else-if="part.type === 'dead-img'" class="pg-img-dead">[图片已销毁]</span>
                        <span v-else>{{ part.text }}</span>
                      </template>
                      <button
                        v-if="(msg.userMsgId || (msg.role === 'user' && !busy && chatId))"
                        class="pg-retract"
                        :title="'撤回该消息及其之后的内容'"
                        @click="retract(msg, i)"
                      ><i class="fas fa-rotate-left"></i> 撤回</button>
                      <button
                        v-if="msg.role === 'user' && msg.done"
                        class="pg-retract pg-copy-btn"
                        title="复制消息"
                        @click="copyMsg(msg)"
                      ><i class="fas fa-copy"></i> 复制</button>
                    </template>
                    <template v-else>
                      <template v-if="msg.collapsed">
                        <div class="pg-collapsed">
                          <button class="pg-collapse-toggle" @click="msg.collapsed = false">
                            <i class="fas fa-caret-right"></i> 查看完整回复(点击展开)
                          </button>
                          <div class="pg-md md-body" v-html="renderMd(collapsedPreview(msg))"></div>
                        </div>
                      </template>
                      <!-- 正文与工具步骤按到达顺序交错（timeline）；运行状态附在末尾行内，不替换正文 -->
                      <template v-else-if="msg.timeline && msg.timeline.length">
                        <template v-for="(item, ti) in msg.timeline" :key="ti">
                          <div v-if="item.kind === 'step'" class="pg-steps pg-tl-steps">
                            <div class="pg-step">
                              <template v-if="item.type === 'tool'">
                                <i class="fas fa-gear pg-step-icon"></i>
                                <span class="pg-step-name">{{ item.name }}</span>
                                <span class="pg-step-args">{{ shortArgs(item.args) }}</span>
                              </template>
                              <div v-else-if="item.type === 'result'" class="pg-step-result">
                                <!-- 编辑/创建文件:← Edit 路径 + 右侧小三角(失败为红色 ←X Error: Edit 路径) -->
                                <div v-if="(item.diff && item.diff.length) || (item.error && item.path && (item.name === 'edit_file' || item.name === 'write_file'))" class="pg-edit-diff">
                                  <div class="pg-edit-head" :class="{ err: !!item.error }" @click="item.open = !item.open" :title="item.open ? '收起' : '展开编辑内容'">
                                    <i class="fas fa-arrow-left pg-edit-arrow"></i>
                                    <i v-if="item.error" class="fas fa-xmark pg-edit-x"></i>
                                    <span>{{ item.error ? 'Error: Edit' : 'Edit' }}</span>
                                    <span class="pg-edit-path">{{ item.path }}</span>
                                    <span v-if="!item.error && item.new_file" class="pg-edit-tag-new">新建</span>
                                    <span v-else-if="!item.error" class="pg-edit-tag-edit">编辑</span>
                                    <i class="fas pg-edit-caret" :class="item.open ? 'fa-caret-down' : 'fa-caret-right'"></i>
                                  </div>
                                  <div v-if="item.open && item.diff && item.diff.length" class="pg-edit-lines">
                                    <div
                                      v-for="(dl, di) in item.diff"
                                      :key="di"
                                      class="pg-edit-line"
                                      :class="dl.kind"
                                    >
                                      <template v-if="dl.kind === 'gap'">
                                        <span class="pg-edit-gap">{{ dl.text }}</span>
                                      </template>
                                      <template v-else>
                                        <span class="pg-edit-no">{{ dl.line }}</span>
                                        <span class="pg-edit-mark">{{ dl.kind === 'add' ? '+' : dl.kind === 'del' ? '-' : ' ' }}</span>
                                        <code class="pg-edit-text">{{ dl.text }}</code>
                                      </template>
                                    </div>
                                  </div>
                                  <pre v-else-if="item.open && item.error" class="pg-step-out err pg-edit-err">{{ (item.error || '').substring(0, 2000) }}</pre>
                                </div>
                                <template v-else>
                                  <div class="pg-step-out-head" @click="item.open = !item.open" :title="item.open ? '收起' : '展开'">
                                    <i class="fas" :class="item.open ? 'fa-caret-down' : 'fa-caret-right'"></i>
                                    <span :class="item.error ? 'pg-step-err-line' : 'pg-step-ok-line'">
                                      {{ item.error ? '✗ 出错' : '✓ 完成' }}:{{ String(item.error || item.output || '').replace(/\s+/g, ' ').substring(0, 70) || '(无输出)' }}
                                    </span>
                                  </div>
                                  <pre v-if="item.open" class="pg-step-out" :class="{ err: item.error }">{{ (item.error || item.output || '').substring(0, 20000) }}</pre>
                                </template>
                              </div>
                              <div v-else-if="item.type === 'note'" class="pg-step-note"><i class="fas fa-circle-info"></i> {{ item.message }}</div>
                            </div>
                          </div>
                          <div v-else-if="segText(msg, item)" class="pg-md md-body" v-html="renderMd(segText(msg, item))"></div>
                        </template>
                        <span v-if="msg.phase === 'connecting'" class="pg-phase pg-phase-inline">
                          <i class="fas fa-satellite-dish fa-pulse"></i> Connecting...
                        </span>
                        <span v-else-if="msg.phase === 'thinking'" class="pg-phase pg-phase-inline">
                          <i class="fas fa-spinner fa-spin"></i> ~ Thinking...
                        </span>
                        <span v-else-if="msg.phase === 'editing'" class="pg-phase pg-phase-inline">
                          <i class="fas fa-spinner fa-spin"></i> ~ Editing...
                        </span>
                        <span v-else-if="msg.phase === 'working'" class="pg-phase pg-phase-inline">
                          <i class="fas fa-spinner fa-spin"></i> ~ Working...
                        </span>
                        <span v-else-if="showCaret(msg)" class="pg-caret"></span>
                        <button v-if="msg.done && isLongReply(msg)" class="pg-collapse-toggle pg-collapse-up" @click="msg.collapsed = true">
                          <i class="fas fa-caret-up"></i> 收起
                        </button>
                      </template>
                      <template v-else>
                        <span v-if="msg.phase === 'connecting'" class="pg-phase">
                          <i class="fas fa-satellite-dish fa-pulse"></i> Connecting...
                        </span>
                        <span v-else-if="msg.phase === 'thinking'" class="pg-phase">
                          <i class="fas fa-spinner fa-spin"></i> ~ Thinking...
                        </span>
                        <span v-else-if="msg.phase === 'editing'" class="pg-phase">
                          <i class="fas fa-spinner fa-spin"></i> ~ Editing...
                        </span>
                        <span v-else-if="msg.phase === 'working'" class="pg-phase">
                          <i class="fas fa-spinner fa-spin"></i> ~ Working...
                        </span>
                        <template v-else-if="msg.display && msg.display.length">
                          <div class="pg-md md-body" v-html="renderMd(msg.display)"></div>
                          <span v-if="showCaret(msg)" class="pg-caret"></span>
                        </template>
                        <span v-else-if="msg.done && !msg.content && !(msg.steps && msg.steps.length)" class="pg-img-dead">(空回复)</span>
                        <span v-else-if="!msg.done" class="pg-caret"></span>
                      </template>
                    </template>
                  </div>
                  <div v-if="msg.role === 'assistant' && (msg.latency_ms != null || msg.model_name || msg.done)" class="pg-latency">
                    <span v-if="msg.model_name">{{ msg.model_name }} · </span>
                    <span v-if="msg.latency_ms != null">{{ msg.latency_ms }} ms</span>
                    <button
                      v-if="msg.done && visibleText(msg.content || msg.display || '').trim()"
                      class="pg-retract pg-copy-btn"
                      title="复制回复"
                      @click="copyMsg(msg)"
                    ><i class="fas fa-copy"></i> 复制</button>
                  </div>
                </template>
              </div>
            </div>
          </div>

          <div v-if="error" class="pg-error">
            <span><i class="fas fa-exclamation-circle"></i> {{ error }}</span>
            <button v-if="lastUserMsg" class="btn btn-small" @click="retract(lastUserMsg.msg, lastUserMsg.idx, true)">
              <i class="fas fa-rotate-left"></i> 撤回重发
            </button>
          </div>

          <!-- 待发送附件 -->
          <div v-if="attachments.length" class="pg-attachments">
            <div v-for="(a, i) in attachments" :key="a.token" class="pg-attach-item">
              <img :src="'/api/ai/chat/image/' + a.token" alt="附件">
              <button class="pg-attach-del" title="移除" @click="attachments.splice(i, 1)"><i class="fas fa-times"></i></button>
            </div>
          </div>

          <!-- 运行状态与帮助：并入 subheader 与输入行（原底部状态栏已移除） -->

          <!-- 运行状态栏:状态指示 + 速度 + 首字延迟均值 -->
          <div class="pg-statsbar" title="红=已结束 / 绿=运行中 / 黄=超2分钟无输出">
            <span class="pg-stat-ind" :class="'st-' + statusKind">
              <i class="pg-stat-dot"></i>
              <template v-if="statusKind === 'running'">运行中</template>
              <template v-else-if="statusKind === 'stuck'">无输出 &gt;2min</template>
              <template v-else>已结束</template>
            </span>
            <span class="pg-stat" title="实时生成速度(近 2 秒平均)">
              <i class="fas fa-gauge-high"></i> {{ tokPerSec.toFixed(1) }} tok/s
            </span>
            <span class="pg-stat" title="首字响应延迟(本次会话平均)">
              <i class="fas fa-timer"></i> 首字 {{ ttftAvg }} ms
            </span>
            <button class="btn btn-small" @click="helpOpen = true" title="帮助菜单(/help)">
              <i class="fas fa-circle-question"></i> 帮助
            </button>
          </div>

          <div class="pg-input-row">
            <!-- 斜杠命令补全面板（悬浮于发送框上方） -->
            <div v-if="cmdVisible" class="pg-cmdbox">
              <button
                v-for="(c, ci) in cmdMatches" :key="c.cmd"
                class="pg-cmd-item" :class="{ active: ci === cmdIdx }"
                @mouseenter="cmdIdx = ci"
                @click="completeCmd"
              >
                <code>{{ c.cmd }}</code><span>{{ c.desc }}</span>
              </button>
              <div class="pg-cmd-hint">↑↓ 选择 · Tab / Enter 补全 · 继续输入筛选 · Esc 关闭</div>
            </div>
            <div class="pg-input-actions">
              <button class="btn btn-small" data-tour="pg-settings-btn" @click="openModelSettings" title="模型设置">
                <i class="fas fa-sliders"></i>
              </button>
              <button class="btn btn-small pg-upload" title="上传图片（视觉模型）" :disabled="busy" @click="$refs.fileInput.click()">
                <i class="fas fa-paperclip"></i>
              </button>
            </div>
            <textarea
              ref="inputRef"
              data-tour="pg-input"
              v-model="input"
              rows="2"
              placeholder="Enter 发送；/ 唤起命令补全；/model /pool /mode /press /context /dir /exit 可用"
              :disabled="busy"
              @keydown.enter.exact.prevent="onEnterKey"
              @keydown.tab="onCmdTab"
              @keydown.up="onCmdNav($event, -1)"
              @keydown.down="onCmdNav($event, 1)"
            ></textarea>
            <button v-if="busy" class="pg-send stop" @click="stop" title="停止生成（ESC）">
              <i class="fas fa-stop"></i>
            </button>
            <button v-else class="pg-send" :disabled="(!input.trim() && !attachments.length)" @click="send" title="发送">
              <i class="fas fa-paper-plane"></i>
            </button>
            <input
              ref="fileInput"
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              style="display: none"
              @change="onFileChange"
            >
          </div>
          <div v-if="panelOpen" class="pg-resizer pg-resizer-task" @mousedown="startResize('task', $event)" title="拖动调整宽度"></div>
    </div><!-- /pg-modal -->
    <!-- 模型设置弹窗 -->
    <Transition name="pg-fade">
      <div v-if="showModelSettings" class="pg-overlay" @click.self="showModelSettings = false">
        <div class="pg-picker pg-model-settings">
          <div class="pg-picker-head">
            <span><i class="fas fa-sliders"></i> 模型设置</span>
            <button class="btn btn-small" @click="showModelSettings = false"><i class="fas fa-times"></i></button>
          </div>
          <div class="pg-model-settings-body">
            <div class="ms-group">
              <label>温度 <span class="ms-hint">控制输出的随机性和创造性</span></label>
              <div class="ms-row">
                <input type="range" min="0" max="2" step="0.1" v-model.number="msForm.temperature" class="ms-range">
                <input type="number" min="0" max="2" step="0.1" v-model.number="msForm.temperature" class="ms-number">
                <span class="ms-default">默认 0.7</span>
              </div>
            </div>
            <div class="ms-group">
              <label>频率惩罚 <span class="ms-hint">减少重复措辞</span></label>
              <div class="ms-row">
                <input type="range" min="-2" max="2" step="0.1" v-model.number="msForm.frequency_penalty" class="ms-range">
                <input type="number" min="-2" max="2" step="0.1" v-model.number="msForm.frequency_penalty" class="ms-number">
                <span class="ms-default">默认 0</span>
              </div>
            </div>
            <div class="ms-group">
              <label>存在惩罚 <span class="ms-hint">鼓励讨论新话题</span></label>
              <div class="ms-row">
                <input type="range" min="-2" max="2" step="0.1" v-model.number="msForm.presence_penalty" class="ms-range">
                <input type="number" min="-2" max="2" step="0.1" v-model.number="msForm.presence_penalty" class="ms-number">
                <span class="ms-default">默认 0</span>
              </div>
            </div>
            <div class="ms-group">
              <label class="ms-check"><input type="checkbox" v-model="msForm.search_enabled" :disabled="!activeModelSupportsSearch"> 开启搜索 <span class="ms-hint">（仅支持联网搜索的模型，通过 tools: web_search 启用）</span></label>
              <span v-if="!activeModelSupportsSearch" class="ms-warn">当前模型不支持搜索</span>
              <div v-if="msForm.search_enabled && activeModelSupportsSearch" style="margin-top:.5rem">
                <label style="font-size:.85rem;color:var(--text-muted)">搜索策略（阿里云 search_strategy）</label>
                <select v-model="msForm.search_strategy" class="ms-select">
                  <option value="turbo">turbo（默认，更快）</option>
                  <option value="max">max（更全面但更慢）</option>
                </select>
                <div class="ms-hint" style="margin-top:.3rem">说明：阿里云等服务商支持；其他厂商忽略此参数。OpenAI Responses API 通过 tools: web_search 启用</div>
              </div>
            </div>
            <div class="ms-group" v-if="activeModelSupportsThinking">
              <label>思考强度 <span class="ms-hint">（仅支持思考的模型）</span></label>
              <select v-model="msForm.thinking_level" class="ms-select">
                <option value="">关闭思考</option>
                <option v-for="lv in thinkingOptions" :key="lv" :value="lv">{{ lv }}</option>
              </select>
              <div class="ms-hint" style="margin-top:.3rem">提示：将 reasoning 设为 high/xhigh 时，搜索会变为代理式搜索（Agentic search），显著加深搜索深度</div>
            </div>
            <div class="ms-group">
              <label>最大上下文 <span class="ms-hint">手动填入，0 表示不限</span></label>
              <input type="number" v-model.number="msForm.context_limit" placeholder="如 128000" class="ms-number" style="width:100%">
            </div>
            <div class="ms-group">
              <label>言论审查 <span class="ms-hint">出现列表中词汇时自动终止本轮对话（包括用户发送、AI 反馈、工具调用、文本内容）</span></label>
              <textarea v-model="msForm.censored_words" rows="3" placeholder="每行或逗号分隔一个词汇，如：违禁词1, 违禁词2" class="ms-textarea"></textarea>
            </div>
          </div>
          <div class="pg-picker-foot" style="display:flex;justify-content:flex-end;gap:.6rem;padding:.7rem 1rem;border-top:1px solid var(--border-light)">
            <button class="btn" @click="showModelSettings = false">取消</button>
            <button class="btn btn-primary" @click="saveModelSettings" :disabled="savingSettings"><i v-if="savingSettings" class="fas fa-spinner fa-spin"></i> 保存</button>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 任务面板 board（Plan 模式）：与项目/会话栏同级的独立面板，与 ReAct 循环联动 -->
    <aside v-if="panelOpen" class="pg-side pg-taskpanel pg-taskpanel-right" :style="{ width: taskWidth + 'px', height: taskHeight ? taskHeight + 'px' : undefined }">
      <div class="pg-taskpanel-head">
        <span><i class="fas fa-list-check"></i> 任务列表</span>
        <span class="pg-taskpanel-meta">{{ taskStats }}</span>
      </div>
      <div class="pg-taskpanel-list">
        <div v-for="t in tasks" :key="t.id" class="pg-task" :class="'is-' + t.status" :title="t.error_summary || taskTitle(t.status)">
          <button class="pg-task-check" @click="cycleTask(t)" :title="taskTitle(t.status)">
            <i class="fas" :class="taskIcon(t.status)"></i>
          </button>
          <div class="pg-task-main">
            <div class="pg-task-content" :class="{ done: t.status === 'done' }">{{ t.content }}</div>
            <div v-if="t.status === 'failed' && t.error_summary" class="pg-task-err">
              <i class="fas fa-triangle-exclamation"></i> {{ t.error_summary }}
            </div>
          </div>
          <span class="pg-task-seq">{{ t.seq }}</span>
        </div>
        <div v-if="!tasks.length" class="pg-taskpanel-empty">
          Plan 模式已开启。给 AI 布置多步任务，它会先输出 <code>&lt;plan&gt;</code> 计划，任务将逐项显示在这里。
        </div>
      </div>
      <div class="pg-task-resizer-v" @mousedown="startResizeTaskHeight($event)" title="拖动调整高度"></div>
    </aside>
  </div><!-- /pg-shell -->

    <!-- 新建项目弹窗（名称 + 工作目录，可浏览服务器目录） -->
    <Transition name="pg-fade">
      <div v-if="projectModalOpen" class="pg-overlay pg-picker-overlay" @click.self="closeProjectModal">
        <div class="pg-picker pg-project-modal">
          <div class="pg-picker-head">
            <span><i class="fas fa-folder-plus"></i> 新建项目</span>
            <button class="btn btn-small" @click="closeProjectModal"><i class="fas fa-times"></i></button>
          </div>
          <div class="pg-project-body">
            <label class="pg-project-label">项目名称</label>
            <input
              v-model="projectForm.name"
              class="pg-project-input"
              placeholder="例如：我的网站 / 实验项目"
              maxlength="60"
              @keydown.enter="createProject"
            >
            <label class="pg-project-label">工作目录（绝对路径，支持中文与空格；项目会话的 /dir 与工具操作都被限制在此目录内）</label>
            <input
              v-model="projectForm.root_path"
              class="pg-project-input pg-project-path"
              :placeholder="isWindows ? '例如 C:\\Users\\Administrator\\Desktop\\我的项目' : '例如 /home/you/我的 项目'"
              @keydown.enter="createProject"
            >
            <div v-if="projectErr" class="pg-project-err"><i class="fas fa-circle-exclamation"></i> {{ projectErr }}</div>
            <div class="pg-project-tip">
              <i class="fas fa-circle-info"></i>
              创建时自动标准化并校验路径（多余引号/斜杠自动处理，校验存在性、目录类型与写权限）。
            </div>
          </div>
          <div class="pg-project-actions">
            <button class="btn" @click="closeProjectModal">取消</button>
            <button class="btn btn-primary" :disabled="projectSaving || !projectForm.name.trim() || !projectForm.root_path.trim()" @click="createProject">
              <i v-if="projectSaving" class="fas fa-spinner fa-spin"></i>
              <i v-else class="fas fa-check"></i> 创建项目
            </button>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 首次启动：选择默认 Shell -->
    <Transition name="pg-fade">
      <div v-if="shellModalOpen" class="pg-overlay pg-picker-overlay">
        <div class="pg-picker pg-shell-modal">
          <div class="pg-picker-head">
            <span><i class="fas fa-terminal"></i> 选择 AI 默认使用的 Shell</span>
          </div>
          <div class="pg-project-body">
            <div class="pg-project-tip" style="margin:0 0 .4rem">
              <i class="fas fa-circle-info"></i>
              检测到首次启动。Agent 执行命令（run_command）时将使用该 Shell；之后可在「设置」页修改。
            </div>
            <div
              v-for="c in shellCandidates"
              :key="c.value"
              class="pg-shell-item"
              :class="{ missing: c.missing }"
              @click="!c.missing && pickShell(c.value)"
            >
              <i class="fas fa-square-terminal"></i>
              <span class="pg-shell-label">{{ c.label }}</span>
              <code class="pg-shell-value">{{ c.value }}</code>
              <span v-if="c.missing" class="pg-shell-missing">未检测到</span>
            </div>
          </div>
          <div class="pg-project-actions">
            <button class="btn" :disabled="shellSaving" @click="shellModalOpen = false">稍后在设置中选择</button>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 模型选择弹窗（键盘上下选择，Enter 确认） -->
    <Transition name="pg-fade">
      <div v-if="pickerOpen" class="pg-overlay pg-picker-overlay" @click.self="pickerOpen = false">
        <div class="pg-picker">
          <div class="pg-picker-head">
            <span><i class="fas fa-robot"></i> 选择模型</span>
            <button class="btn btn-small" @click="pickerOpen = false"><i class="fas fa-times"></i></button>
          </div>
          <div class="pg-picker-search">
            <i class="fas fa-search"></i>
            <input
              ref="pickerInputRef"
              v-model="pickerSearch"
              placeholder="搜索模型 ID / 名称 / 提供商"
            >
          </div>
          <div class="pg-picker-list">
            <template v-for="g in pickerGroups" :key="g.provider">
              <div class="pg-picker-group-head">{{ g.provider }}</div>
              <div
                v-for="m in g.items"
                :key="m.id"
                class="pg-picker-item"
                :class="{ active: activeModel && m.id === activeModel.id }"
                @click="switchModel(m)"
              >
              <div class="pg-picker-main">
                <span class="pg-picker-name">{{ m.display_name }}</span>
                <span class="pg-picker-id">{{ m.model_id }}</span>
              </div>
              <span class="ai-badge" :class="'badge-' + (m.status || 'untested')">
                {{ m.status === 'ok' ? '可用' : m.status === 'error' ? '异常' : '未测试' }}
              </span>
            </div>
            </template>
            <div v-if="pickerList.length === 0" class="pg-empty" style="padding: 2rem 0;"><p>没有匹配的模型</p></div>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 模型池面板(点击选取优先级顺序) -->
    <Transition name="pg-fade">
      <div v-if="poolOpen" class="pg-overlay pg-picker-overlay" @click.self="poolOpen = false">
        <div class="pg-picker">
          <div class="pg-picker-head">
            <span><i class="fas fa-layer-group"></i> 模型池(依次点击确定优先级)</span>
            <button class="btn btn-small" @click="poolOpen = false"><i class="fas fa-times"></i></button>
          </div>
          <div class="pg-pool-tip">
            <button class="btn btn-small" :class="autoMode ? 'btn-primary' : ''" @click="toggleAuto">
              <i class="fas fa-bolt"></i> {{ autoMode ? '自动模式:开' : '自动模式:关' }}
            </button>
            <span class="pg-pool-tip-text">按顺序点击模型加入池中,先点的优先级高;再次点击取消选择</span>
            <button class="btn btn-small" @click="poolReset" title="清空模型池顺序(恢复默认)">
              <i class="fas fa-rotate-left"></i> Reset
            </button>
          </div>
          <div class="pg-pool-seq" v-if="poolOrder.length">
            <i class="fas fa-arrow-down-short-wide"></i> 优先级:
            <span v-for="(m, si) in poolOrder" :key="m.id" class="pg-pool-seq-item">
              {{ si + 1 }}. {{ m.display_name }}
            </span>
          </div>
          <div class="pg-picker-list">
            <div
              v-for="m in models"
              :key="m.id"
              class="pg-picker-item pg-pool-item"
              :class="{ selected: poolSelSet.has(m.id) }"
              @click="poolClick(m)"
            >
              <span class="pg-pool-idx">{{ poolPos(m.id) }}</span>
              <div class="pg-picker-main">
                <span class="pg-picker-name">[{{ m.status === 'ok' ? '可用' : m.status === 'error' ? '异常' : '未测' }}]{{ m.provider_name }}/{{ m.display_name }}</span>
                <span class="pg-picker-id">{{ m.model_id }}</span>
              </div>
              <i v-if="poolSelSet.has(m.id)" class="fas fa-circle-check pg-pool-check"></i>
            </div>
            <div v-if="models.length === 0" class="pg-empty" style="padding: 2rem 0;"><p>暂无模型</p></div>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 工具审批弹窗（橙=越界，红=危险） -->
    <Transition name="pg-fade">
      <div v-if="currentApproval" class="pg-overlay pg-approval-overlay">
        <div class="pg-approval" :class="'level-' + currentApproval.level">
          <div class="pg-approval-head">
            <i class="fas fa-shield-halved"></i>
            {{ currentApproval.level === 'red' ? '危险操作审批' : '越界访问审批' }}
            <span v-if="bypassMode" class="pg-approval-bypass">（自动审批模式已开启）</span>
          </div>
          <div class="pg-approval-body">
            <p class="pg-approval-reason">{{ currentApproval.reason }}</p>
            <p class="pg-approval-tool">工具：<code>{{ currentApproval.tool }}</code></p>
            <pre class="pg-approval-args">{{ JSON.stringify(currentApproval.args, null, 2).substring(0, 600) }}</pre>
          </div>
          <div class="pg-approval-actions">
            <button class="btn" @click="decideApproval(false)">拒绝</button>
            <button class="btn" :class="currentApproval.level === 'red' ? 'btn-danger' : 'btn-primary'" @click="decideApproval(true)">
              {{ currentApproval.level === 'red' ? '仍要执行' : '批准' }}
            </button>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 帮助菜单(/help) -->
    <Transition name="pg-fade">
      <div v-if="helpOpen" class="pg-overlay pg-picker-overlay" @click.self="helpOpen = false">
        <div class="pg-picker pg-help">
          <div class="pg-picker-head">
            <span><i class="fas fa-circle-question"></i> 帮助中心</span>
            <button class="btn btn-small" @click="helpOpen = false"><i class="fas fa-times"></i></button>
          </div>
          <div class="pg-help-body">
            <h4><i class="fas fa-keyboard"></i> 斜杠指令</h4>
            <table class="pg-help-tbl">
              <tr><td>/model [ID]</td><td>打开模型选择弹窗;或用 ID/名称直接切换模型(自动模式下禁用)</td></tr>
              <tr><td>/pool</td><td>打开模型池,依次点击确定优先级(先点优先),Reset 恢复默认</td></tr>
              <tr><td>/mode plan</td><td>任务模式:AI 先输出 &lt;plan&gt; 计划,右侧任务面板实时联动(失败自动标记+摘要)</td></tr>
              <tr><td>/mode auto</td><td>切换自动模式:请求按模型池顺序自动尝试,失败自动切换下一个;再次输入退出</td></tr>
              <tr><td>/mode bypass</td><td>自动审批模式:工具/技能调用不再需要人工确认(谨慎);再次输入关闭</td></tr>
              <tr><td>/mode default</td><td>重置所有模式为默认</td></tr>
              <tr><td>/press</td><td>用当前模型把上下文压缩为摘要,用量从 0 重新统计</td></tr>
              <tr><td>/context N</td><td>设定上下文窗口为 N 字符并立即压缩;用量达 80% 自动压缩</td></tr>
              <tr><td>/dir [路径]</td><td>切换 Agent 工具工作目录(相对路径基于当前目录;项目会话只能切到项目根及子目录)</td></tr>
              <tr><td>/exit</td><td>退出 Playground</td></tr>
              <tr><td>/help</td><td>打开本帮助菜单</td></tr>
            </table>
            <h4><i class="fas fa-palette"></i> 按钮说明</h4>
            <table class="pg-help-tbl">
              <tr><td>🤖 模型名按钮</td><td>切换当前会话使用的模型</td></tr>
              <tr><td>🛠 Agent 开/关</td><td>开启后 AI 可执行命令、读写文件(受审批控制)</td></tr>
              <tr><td>🗂 左栏</td><td>项目与会话管理:新建项目(绑定工作目录)、项目下/顶层新建会话,点击切换,垃圾桶删除</td></tr>
              <tr><td>＋ 新对话</td><td>清空当前会话,开始新对话</td></tr>
              <tr><td>📎 图片</td><td>上传图片给视觉模型(仅存内存 30 分钟)</td></tr>
              <tr><td>■ 停止 / Esc</td><td>立即终止本次生成(会杀死正在运行的命令)</td></tr>
              <tr><td>↩ 撤回</td><td>hover 消息后可撤回该条及之后的内容(重新编辑)</td></tr>
              <tr><td>🧠 思考过程</td><td>模型思考内容,默认折叠,点击展开</td></tr>
              <tr><td>▶ 工具输出</td><td>Agent 工具执行结果,默认折叠,点击展开</td></tr>
            </table>
            <h4><i class="fas fa-file-lines"></i> AGENT.md / AGENTS.md 长期记忆</h4>
            <table class="pg-help-tbl">
              <tr><td>文件名</td><td><code>AGENTS.md</code>（推荐，兼容 OpenCode）或 <code>AGENT.md</code>（别名），前者优先</td></tr>
              <tr><td>位置</td><td>1. 全局：<code>{{ pAgentsPath }}</code><br>2. 项目：<code>{{ pProjectAgents }}</code><br>3. 自由会话：<code>&lt;当前目录&gt;/AGENTS.md</code><br>全局与项目/目录叠加注入；{{ pSepHint }}</td></tr>
              <tr><td>格式</td><td>纯 Markdown，无 frontmatter 要求；首行可为 <code># 标题</code>，正文为长期记忆、项目规范、技能说明等</td></tr>
              <tr><td>限制</td><td>单文件上限 200KB，超限跳过并提示；每次对话前重读并校验 SHA-256</td></tr>
              <tr><td>查看</td><td>Agent 开启时，系统提示词中会注入对应文件内容（可在对话前通过模型设置确认）</td></tr>
            </table>
          </div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onUnmounted, onActivated, onDeactivated } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { aiApi } from '../api';
import { copyText } from '../utils/clipboard';
import { toast } from '../utils/toast';
import { renderMarkdown } from '../utils/markdown';
import { mountWhaleWidget } from '../utils/whaleWidget';
import { fuzzyMatch } from '../utils/fuzzy';
import { agentsFilePath, projectAgentsExample, pathSepHint } from '../utils/platformText';

const pAgentsPath = computed(agentsFilePath);
const pProjectAgents = computed(projectAgentsExample);
const pSepHint = computed(pathSepHint);

const router = useRouter();
const route = useRoute();

// 页面化 Playground：model 为外部传入的初始模型（模型列表页跳转时指定）
const props = defineProps({
  model: { type: Object, default: null }
});

const messages = ref([]);
const input = ref('');
const error = ref('');
const chatId = ref(null);
const chatTitle = ref('');
const chats = ref([]);

/* ---------- 进行中的流（多会话并发：切换会话不打断生成，回来自动续显） ---------- */
// record: { originChatId(发起时,可能null), chatId('chat'事件后), ctrl, reply, sentInto, gen, approvals }
const streams = new Map();
let streamSeq = 0;
// 普通 Map 无响应性：增删流不会触发依赖它的 computed 重算，用版本号驱动 busy 更新
const streamsVersion = ref(0);
const streamChatKey = (s) => (s.chatId ?? s.originChatId ?? null);
const findStreamForChat = (id) => {
  for (const s of streams.values()) {
    if (streamChatKey(s) === (id ?? null)) return s;
  }
  return null;
};
const currentStream = () => findStreamForChat(chatId.value);
const busy = computed(() => {
  streamsVersion.value; // 依赖版本号：streams 增删时 busy 立即重算（发送↔停止按钮切换）
  return !!currentStream();
});

/* ---------- 项目与会话分离 ---------- */
const projects = ref([]);
const activeProjectId = ref((() => { const v = parseInt(localStorage.getItem('pg_active_project')); return Number.isInteger(v) ? v : null; })());          // 新建会话将归属的项目（null = 顶层自由会话）
const defaultCwd = ref('');                 // AGENT 默认目录（自由会话初始 cwd）
const sidebarOpen = ref(localStorage.getItem('pg_sidebar') !== '0');
const immersive = ref(sessionStorage.getItem('kh_immersive') === '1');
const isWindows = /Win/i.test(navigator.platform || navigator.userAgent || '');

const projectModalOpen = ref(false);
const projectForm = ref({ name: '', root_path: '' });
const projectErr = ref('');
const projectSaving = ref(false);

const expandedProjects = ref(new Set(JSON.parse(localStorage.getItem('pg_expanded') || '[]')));    // 展开的项目 id（持久化）

const freeChats = computed(() => chats.value.filter(c => !c.project_id));
const chatsOf = (pid) => chats.value.filter(c => c.project_id === pid);
const activeProjectObj = computed(() => projects.value.find(p => p.id === activeProjectId.value) || null);

const projExpanded = (id) => expandedProjects.value.has(id);
const toggleProject = (id) => {
  const s = new Set(expandedProjects.value);
  if (s.has(id)) s.delete(id); else s.add(id);
  expandedProjects.value = s;
  try { localStorage.setItem('pg_expanded', JSON.stringify([...s])); } catch(e) {}
};

watch(activeProjectId, (v) => {
  try {
    if (v) localStorage.setItem('pg_active_project', String(v));
    else localStorage.removeItem('pg_active_project');
  } catch(e) {}
});

function toggleImmersion() {
  immersive.value = !immersive.value;
  sessionStorage.setItem('kh_immersive', immersive.value ? '1' : '0');
  window.dispatchEvent(new CustomEvent('kh-immersive', { detail: immersive.value }));
}

/* ---------- board 宽度拖拽（类似窗口边缘拖动） ---------- */
const sideWidth = ref(parseInt(localStorage.getItem('pg_side_w')) || 280);
const taskWidth = ref(parseInt(localStorage.getItem('pg_task_w')) || 300);
const taskHeight = ref(parseInt(localStorage.getItem('pg_task_h')) || 0); // 0 表示使用 CSS 默认 75%

function startResize(which, e) {
  e.preventDefault();
  const startX = e.clientX;
  const startW = which === 'side' ? sideWidth.value : taskWidth.value;
  const onMove = (ev) => {
    if (which === 'side') {
      sideWidth.value = Math.min(520, Math.max(200, startW + ev.clientX - startX));
    } else {
      // 任务面板在右侧：向左拖增大
      taskWidth.value = Math.min(560, Math.max(220, startW - (ev.clientX - startX)));
    }
  };
  const onUp = () => {
    localStorage.setItem(which === 'side' ? 'pg_side_w' : 'pg_task_w', which === 'side' ? sideWidth.value : taskWidth.value);
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

function startResizeTaskHeight(e) {
  e.preventDefault();
  const startY = e.clientY;
  const startH = taskHeight.value || document.querySelector('.pg-taskpanel')?.offsetHeight || 300;
  // 最大到与聊天窗口平齐：取 .pg-modal 的高度或 84vh
  const maxH = document.querySelector('.pg-modal')?.offsetHeight || Math.round(window.innerHeight * 0.84);
  const onMove = (ev) => {
    const delta = ev.clientY - startY;
    taskHeight.value = Math.min(maxH, Math.max(200, startH + delta));
  };
  const onUp = () => {
    try { localStorage.setItem('pg_task_h', String(taskHeight.value)); } catch(e) {}
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

async function loadProjects() {
  try {
    const res = await aiApi.getProjects();
    projects.value = res.data;
  } catch (e) { /* 静默 */ }
}

function openProjectModal() {
  projectForm.value = { name: '', root_path: '' };
  projectErr.value = '';
  projectModalOpen.value = true;
}

const closeProjectModal = () => {
  projectModalOpen.value = false;
};

async function createProject() {
  if (projectSaving.value) return;
  projectErr.value = '';
  projectSaving.value = true;
  try {
    const res = await aiApi.createProject({
      name: projectForm.value.name.trim(),
      root_path: projectForm.value.root_path.trim()
    });
    projectModalOpen.value = false;
    toast(`项目「${res.data.name}」已创建，已为你切到该项目的新会话`, 'success', 5000);
    await loadProjects();
    await loadChats();
    const proj = projects.value.find(p => p.id === res.data.id);
    if (proj) createChatNamed(proj);
  } catch (e) {
    projectErr.value = e.response?.data?.message || '创建失败';
  } finally {
    projectSaving.value = false;
  }
}

/* 删除项目（有会话时级联确认） */
async function removeProject(p) {
  const cnt = p.chat_count || 0;
  const msg = cnt > 0
    ? `项目「${p.name}」下还有 ${cnt} 个会话及其全部消息，将一并删除。\n确定删除？`
    : `确定删除项目「${p.name}」？`;
  if (!confirm(msg)) return;
  try {
    const res = await aiApi.deleteProject(p.id, cnt > 0);
    if (cnt > 0) await loadChats();
    await loadProjects();
    if (activeProjectId.value === p.id) newChat();
    toast(res.message || '项目已删除', 'success');
  } catch (e) {
    toast(e.response?.data?.message || '删除失败', 'error');
  }
}
const attachments = ref([]);
const agentMode = ref(false);
const cwd = ref('');
const contextUsed = ref(0);
const contextLimit = ref(0);

// 多模型 / 模型池 / 模式
const models = ref([]);
const activeModel = ref(null);
const showModelSettings = ref(false);
const savingSettings = ref(false);
const fetchingContext = ref(false);
const msForm = ref({ temperature: 0.7, frequency_penalty: 0, presence_penalty: 0, search_enabled: false, search_strategy: 'turbo', thinking_level: '', censored_words: '', context_limit: 0 });
const activeModelSupportsSearch = computed(() => !!activeModel.value?.supports_search);
const activeModelSupportsThinking = computed(() => !!activeModel.value?.supports_thinking);
const thinkingOptions = computed(() => {
  const raw = activeModel.value?.thinking_levels || '';
  if (!raw) return ['low', 'medium', 'high', 'max'];
  return String(raw).split(',').map(s => s.trim()).filter(Boolean);
});
const pickerOpen = ref(false);
const pickerSearch = ref('');
const pickerInputRef = ref(null);
const poolOpen = ref(false);
const autoMode = ref(false);
const bypassMode = ref(false);

// 帮助菜单
const helpOpen = ref(false);

/* ---------- Plan 模式 / 任务列表 / 技能 / Shell ---------- */
const planMode = ref(false);
const tasks = ref([]);
const skills = ref([]);
const shellModalOpen = ref(false);
const shellCandidates = ref([]);
const shellSaving = ref(false);
const agentsMdChecked = new Set(); // 会话内已确认过预检的项目

// 任务面板仅跟随 Plan 模式：关闭 Plan 即隐藏（否则历史任务会把面板一直钉在界面上）
const panelOpen = computed(() => planMode.value);
const taskStats = computed(() => {
  const n = (s) => tasks.value.filter(t => t.status === s).length;
  return `${n('done')}/${tasks.value.length} 完成`;
});
const taskIcon = (s) => ({ pending: 'fa-circle', doing: 'fa-spinner fa-spin', done: 'fa-circle-check', failed: 'fa-circle-xmark' }[s] || 'fa-circle');
const taskTitle = (s) => ({ pending: '点击开始', doing: '点击完成', done: '点击重置', failed: '点击重置' }[s] || '');

function togglePlan() {
  planMode.value = !planMode.value;
  if (chatId.value) {
    aiApi.updateChatSettings(chatId.value, { plan_mode: planMode.value }).catch(() => { /* 静默 */ });
  }
  toast(planMode.value
    ? '任务模式已开启：AI 会先输出 <plan> 计划，右侧面板实时显示任务进度'
    : '任务模式已关闭', 'info', 5000);
}

async function cycleTask(t) {
  const next = { pending: 'doing', doing: 'done', done: 'pending', failed: 'pending' }[t.status] || 'pending';
  try {
    const res = await aiApi.updateTask(t.id, { status: next });
    if (res.data) tasks.value = res.data;
  } catch (e) { /* 静默 */ }
}

async function openModelSettings() {
  if (!chatId.value) { toast('请先开始一个对话', 'info'); return; }
  try {
    const res = await aiApi.getChat(chatId.value);
    const chat = res.data.chat;
    msForm.value = {
      temperature: chat.temperature ?? 0.7,
      frequency_penalty: chat.frequency_penalty ?? 0,
      presence_penalty: chat.presence_penalty ?? 0,
      search_enabled: !!chat.search_enabled,
      search_strategy: chat.search_strategy || 'turbo',
      thinking_level: chat.thinking_level || '',
      censored_words: chat.censored_words || '',
      context_limit: chat.context_limit || 0
    };
  } catch (e) { /* 保持默认值 */ }
  showModelSettings.value = true;
}
async function saveModelSettings() {
  if (!chatId.value) return;
  savingSettings.value = true;
  try {
    await aiApi.updateChatSettings(chatId.value, {
      temperature: msForm.value.temperature,
      frequency_penalty: msForm.value.frequency_penalty,
      presence_penalty: msForm.value.presence_penalty,
      search_enabled: msForm.value.search_enabled ? 1 : 0,
      search_strategy: msForm.value.search_strategy,
      thinking_level: msForm.value.thinking_level,
      censored_words: msForm.value.censored_words,
      context_limit: msForm.value.context_limit
    });
    contextLimit.value = msForm.value.context_limit;
    toast('模型设置已保存', 'success');
    showModelSettings.value = false;
  } catch (e) {
    toast(e.response?.data?.message || '保存失败', 'error');
  } finally { savingSettings.value = false; }
}
async function autoFetchContext() {
  if (!chatId.value) return;
  fetchingContext.value = true;
  try {
    const res = await aiApi.fetchMaxContext(chatId.value);
    msForm.value.context_limit = res.data.max_context || 0;
    toast(res.message || '已获取最大上下文', 'success');
  } catch (e) {
    toast(e.response?.data?.message || '获取失败', 'error');
  } finally { fetchingContext.value = false; }
}

async function loadSkills() {
  try {
    const res = await aiApi.getSkills();
    skills.value = res.data;
  } catch (e) { /* 静默 */ }
}

async function checkShellSetup() {
  try {
    // OOBE 未完成时不弹（避免与首次启动向导叠加）；OOBE 完成会写入 shell_confirmed
    const oobe = await aiApi.getOobe();
    if (oobe.data && oobe.data.done === false) return;
    const res = await aiApi.getShell();
    if (!res.data.is_set && !res.data.confirmed) {
      shellCandidates.value = res.data.candidates || [];
      shellModalOpen.value = true;
    }
  } catch (e) { /* 静默 */ }
}

async function pickShell(value) {
  shellSaving.value = true;
  try {
    await aiApi.setShell(value);
    shellModalOpen.value = false;
    toast('默认 Shell 已保存', 'success');
  } catch (e) {
    toast(e.response?.data?.message || '保存失败', 'error');
  } finally {
    shellSaving.value = false;
  }
}

// AGENTS.md 预检：新建项目会话前估算长期记忆的 token 成本，过大时让用户确认
async function preflightAgentsMd(project) {
  if (!project || agentsMdChecked.has(project.id)) return true;
  try {
    const res = await aiApi.checkAgentsMd({ project_id: project.id });
    const info = res.data;
    if (!info.files.length) return true;
    const skippedNote = info.files.filter(f => f.skipped).map(f => `${f.path}（${f.skipped}）`).join('；');
    if (info.total_tokens > 5000) {
      const priceIn = activeModel.value?.price_in || 0;
      const cost = priceIn > 0 ? `，每次对话约多花 $${(info.total_tokens / 1e6 * priceIn).toFixed(4)}` : '';
      const okGo = confirm(`项目 AGENTS.md 约 ${info.total_tokens} tokens，将注入每次对话的 System Prompt${cost}。是否继续？\n\n` + info.files.map(f => `- [${f.scope}] ${f.path} ≈ ${f.tokens} tokens`).join('\n'));
      if (!okGo) return false;
    } else if (info.total_tokens > 1000) {
      toast(`AGENTS.md 约 ${info.total_tokens} tokens，会注入每次对话（可能增加 token 消耗）`, 'info', 6000);
    }
    if (skippedNote) toast('部分 AGENTS.md 过大已跳过：' + skippedNote, 'info', 6000);
    agentsMdChecked.add(project.id);
    return true;
  } catch (e) { return true; /* 预检失败不阻塞 */ }
}

// 运行状态 / 速度 / 首字延迟
const statusKind = ref('idle'); // idle | running | stuck | done
const tokPerSec = ref(0);
const ttftAvg = ref(0);

const statusKindOf = (raw) => {
  const v = String(raw || 'idle');
  return v === 'running' || v === 'stuck' ? v : (v === 'done' ? 'done' : 'idle');
};

/* 生成统计:tok/s、首字延迟、状态指示器（绑定到流；仅当前会话驱动状态栏显示） */
const STUCK_MS = 120 * 1000;
const SPEED_WINDOW_MS = 2000;

let genTicker = null;

function ensureTicker() {
  if (genTicker) return;
  genTicker = setInterval(() => {
    const s = currentStream();
    if (!s || !s.gen) return;
    const cur = Date.now();
    // 速度:近 2 秒累计 token 数
    const cutoff = cur - SPEED_WINDOW_MS;
    s.gen.tickBuf = s.gen.tickBuf.filter(x => x.ts >= cutoff);
    const acc = s.gen.tickBuf.reduce((sum, x) => sum + x.n, 0);
    tokPerSec.value = acc / (SPEED_WINDOW_MS / 1000);
    // 卡住检测:2 分钟无任何 token
    if (s.gen.arrived && cur - s.gen.lastDataTs > STUCK_MS) statusKind.value = 'stuck';
  }, 1000);
}

function stopTickerIfIdle() {
  let anyGen = false;
  for (const s of streams.values()) if (s.gen) anyGen = true;
  if (!anyGen && genTicker) { clearInterval(genTicker); genTicker = null; }
}

function startGen(s) {
  s.gen = {
    startTs: nowTs(),
    tok: 0,
    firstTs: 0,
    lastDataTs: nowTs(),
    tickBuf: [],
    totalTtft: ttftAvg.value > 0 ? ttftAvg.value : 0,
    ttftCount: ttftAvg.value > 0 ? 1 : 0,
    arrived: false
  };
  if (currentStream() === s) {
    statusKind.value = 'running';
    ensureTicker();
  }
}

function feedGen(s, text) {
  if (!s.gen) return;
  const cur = Date.now();
  const n = Math.max(1, Math.round(String(text || '').length / 1.6));
  s.gen.tok += n;
  s.gen.tickBuf.push({ n, ts: cur });
  s.gen.lastDataTs = cur;
  if (!s.gen.firstTs) {
    s.gen.firstTs = cur;
    const ttft = cur - s.gen.startTs;
    s.gen.totalTtft += ttft;
    s.gen.ttftCount += 1;
    ttftAvg.value = Math.round(s.gen.totalTtft / s.gen.ttftCount);
  }
  s.gen.arrived = true;
}

function endGen(s) {
  if (s.gen) {
    if (currentStream() === s) {
      const elapsed = Math.max(1, Date.now() - s.gen.startTs) / 1000;
      tokPerSec.value = s.gen.tok / elapsed;
      statusKind.value = 'done';
    }
    s.gen = null;
  }
  stopTickerIfIdle();
}

// 切换会话后同步运行状态显示（当前会话在生成 → running；否则 idle）
function syncRunView() {
  const s = currentStream();
  if (s && s.gen) {
    statusKind.value = 'running';
    ensureTicker();
  } else {
    statusKind.value = 'idle';
    tokPerSec.value = 0;
    stopTickerIfIdle();
  }
}

const lastIdleReset = ref(0);

// 上文折叠
const historyExpanded = ref(false);

// 审批队列
const approvals = ref([]);
const currentApproval = computed(() => approvals.value[0] || null);

const messagesRef = ref(null);
const inputRef = ref(null);
const fileInput = ref(null);

const nowTs = () => Date.now();

const close = () => router.push('/control');

const visibleText = (raw) => {
  let s = String(raw || '');
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const open = s.toLowerCase().lastIndexOf('<think>');
  if (open !== -1) s = s.substring(0, open);
  // Plan 模式协议标签：不直接展示（计划与状态渲染在右侧任务面板）
  s = s.replace(/<task-status\b[^>]*\/?>/gi, '').replace(/<\/?plan\b[^>]*>/gi, '');
  const planOpen = s.toLowerCase().lastIndexOf('<plan>');
  if (planOpen !== -1) s = s.substring(0, planOpen);
  return s;
};

const renderMd = (text) => renderMarkdown(visibleText(text));

/* ---------- 一键复制（消息 / markdown 代码块） ---------- */
const onCopyClick = async (e) => {
  const btn = e.target.closest('.md-copy');
  if (!btn) return;
  const wrap = btn.parentElement;
  const pre = wrap ? wrap.querySelector('pre') : null;
  const ok = await copyText(pre ? pre.textContent : '');
  toast(ok ? '代码已复制' : '复制失败', ok ? 'success' : 'error');
};

const copyMsg = async (msg) => {
  const text = msg.role === 'user'
    ? String(msg.content || '').replace(/\[\[img:[a-f0-9]+\]\]/g, '').trim()
    : visibleText(msg.content || msg.display || '');
  const ok = await copyText(text);
  toast(ok ? '已复制' : '复制失败', ok ? 'success' : 'error');
};

const formatTime = (t) => String(t || '').replace('T', ' ').substring(0, 19);

// 上文折叠：保留最后 3 条完整显示，其余折叠（预览 5 行），避免折叠本次对话的用户消息
const splitIdx = computed(() => (messages.value.length > 6 ? messages.value.length - 3 : 0));
const historyPreview = computed(() => {
  const m = messages.value[splitIdx.value - 1];
  if (!m) return '';
  const text = visibleText(m.display || m.content || '');
  const lines = text.split('\n').filter(l => l.trim());
  return lines.slice(-5).join('\n').substring(0, 300);
});

// 用户消息内容切分：图片标记 → 图片组件，其余为文本
const IMG_RE = /\[\[img:([a-f0-9]+)\]\]/g;
function splitParts(content) {
  const parts = [];
  let last = 0;
  for (const match of String(content || '').matchAll(IMG_RE)) {
    const before = content.slice(last, match.index);
    if (before) parts.push({ type: 'text', text: before });
    parts.push(deadTokens.value.has(match[1]) ? { type: 'dead-img' } : { type: 'image', token: match[1] });
    last = match.index + match[0].length;
  }
  const tail = content.slice(last);
  if (tail) parts.push({ type: 'text', text: tail });
  return parts.length ? parts : [{ type: 'text', text: '' }];
}

const deadTokens = ref(new Set());
const imgBroken = (e) => {
  const src = e.target?.src || '';
  const m = src.match(/image\/([a-f0-9]+)/);
  if (m) deadTokens.value = new Set([...deadTokens.value, m[1]]);
  e.target.style.display = 'none';
};

const scrollToBottom = () => {
  nextTick(() => {
    const el = messagesRef.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
};

function stop() {
  const s = currentStream();
  if (s && s.ctrl) s.ctrl.abort();
}

/* ---------- 打字机平滑渲染 ---------- */
const typerTimers = new Set();

function stopAllTypers() {
  for (const t of typerTimers) clearInterval(t);
  typerTimers.clear();
}

function startTyper(reply) {
  if (reply.__typing) return;
  reply.__typing = true;
  const timer = setInterval(() => {
    const cur = reply.content || '';
    const shown = reply.display || '';
    if (shown.length >= cur.length) {
      // 关键：追平后重置标记，后续新内容才能再次启动打字机
      reply.__typing = false;
      clearInterval(timer);
      typerTimers.delete(timer);
      return;
    }
    const lag = cur.length - shown.length;
    const step = Math.max(2, Math.ceil(lag / 15));
    reply.display = cur.slice(0, shown.length + step);
    // 后台流的打字机不应滚动当前视图：仅当该消息仍显示在当前会话列表中才滚动
    if (messages.value.includes(reply)) scrollToBottom();
  }, 24);
  typerTimers.add(timer);
}

const showCaret = (msg) =>
  !msg.done || ((msg.display?.length ?? 0) < (msg.content?.length ?? 0));

/* ---------- 正文/工具步骤交错时间线 ----------
   timeline 项：{ kind:'text', start, end }（content 的字符区间）或 { kind:'step', ...step }
   按事件到达顺序排列，工具步骤不再堆在消息开头，而是穿插在正文中。 */

// 追加正文增量：延续当前文本段，或在上一步骤之后新开一段
function tlAppendText(reply, delta) {
  const tl = reply.timeline || (reply.timeline = []);
  const last = tl[tl.length - 1];
  if (last && last.kind === 'text') {
    last.end = reply.content.length;
  } else {
    tl.push({ kind: 'text', start: reply.content.length - String(delta || '').length, end: reply.content.length });
  }
}

// 工具事件到达时立刻放完打字机缓冲，保证「正文 → 工具 → 正文」的阅读顺序
function tlFlush(reply) {
  if (String(reply.display || '').length < String(reply.content || '').length) {
    reply.display = reply.content;
    reply.__typing = false;
  }
}

// 取文本段当前应显示的内容（跟随打字机进度 display）
const segText = (msg, item) => {
  const from = item.start || 0;
  const shown = String(msg.display || '').length;
  const to = Math.min(item.end ?? shown, Math.max(shown, from));
  return String(msg.content || '').slice(from, Math.max(from, to));
};

// 长回复折叠:超 6 行视为长回复,提供展开/收起（仅折叠 AI 回复，不折叠用户消息）
const LONG_REPLY_LINES = 6;
const isLongReply = (msg) => {
  if (msg.role !== 'assistant') return false;
  const t = visibleText(msg.display || msg.content || '');
  return t.split('\n').filter(l => l.trim()).length > LONG_REPLY_LINES;
};

const collapsedPreview = (msg) => {
  const t = visibleText(msg.display || msg.content || '');
  return t.split('\n').filter(l => l.trim()).slice(0, 6).join('\n') + '\n\n…(共 ' + t.split('\n').filter(l => l.trim()).length + ' 行)…';
};

/* ---------- 模型管理 ---------- */

async function loadModels() {
  try {
    const res = await aiApi.getStatus();
    models.value = res.data.list || [];
  } catch (e) { /* 静默 */ }
  migrateDefaultPool();
}

function openPicker() {
  if (autoMode.value) {
    toast('自动模式下不可切换模型（输入 /mode auto 可退出自动模式）', 'info', 5000);
    return;
  }
  pickerSearch.value = '';
  pickerOpen.value = true;
  nextTick(() => pickerInputRef.value?.focus());
}

const onModelBtn = () => openPicker();

const pickerList = computed(() => {
  const q = pickerSearch.value.trim();
  if (!q) return models.value;
  return models.value.filter(m =>
    [m.display_name, m.model_id, m.provider_name].some(v => v && fuzzyMatch(String(v), q))
  );
});

const pickerGroups = computed(() => {
  const map = new Map();
  for (const m of pickerList.value) {
    const key = m.provider_name || '未知提供商';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(m);
  }
  return [...map.entries()]
    .sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'zh-Hans-CN', { sensitivity: 'base' }))
    .map(([provider, items]) => ({
      provider,
      items: [...items].sort((a, b) => String(a.display_name || a.model_id).localeCompare(String(b.display_name || b.model_id), 'zh-Hans-CN', {sensitivity:'base'}))
    }));
});

function switchModel(m) {
  if (!m) return;
  if (autoMode.value) {
    autoMode.value = false;
    toast('已切换模型，自动模式已退出', 'info', 5000);
  }
  activeModel.value = m;
  localStorage.setItem('pg_model', String(m.id));
  // 会话级模型跟随：已有会话时把所选模型写回该会话
  if (chatId.value) {
    aiApi.updateChatSettings(chatId.value, { model_row_id: m.id }).catch(() => { /* 静默 */ });
  }
  pickerOpen.value = false;
  toast(`已切换到 ${m.display_name}（${m.model_id}），上下文保留`, 'success');
}

function switchModelById(arg) {
  const q = arg.trim().toLowerCase();
  if (!q) { openPicker(); return; }
  const m =
    models.value.find(x => (x.model_id || '').toLowerCase() === q) ||
    models.value.find(x => (x.model_id || '').toLowerCase().startsWith(q)) ||
    models.value.find(x => (x.display_name || '').toLowerCase() === q) ||
    models.value.find(x => (x.display_name || '').toLowerCase().includes(q));
  if (!m) {
    toast(`未找到模型「${arg}」，可输入 /model 打开列表`, 'error', 5000);
    return;
  }
  switchModel(m);
}

/* ---------- 模型池 / 模式 ---------- */

const readPool = () => {
  try {
    const raw = JSON.parse(localStorage.getItem('pg_pool') || '[]');
    if (!Array.isArray(raw)) return [];
    return [...new Set(raw.filter(id => Number.isInteger(id) && id > 0))];
  } catch { return []; }
};

// 模型池:依次点击模型加入优先级序列,先点的优先级高
const poolIds = ref(readPool());
const persistPool = () => localStorage.setItem('pg_pool', JSON.stringify(poolIds.value));

const poolOrder = computed(() =>
  poolIds.value.map(id => models.value.find(m => m.id === id)).filter(Boolean)
);
const poolSelSet = computed(() => new Set(poolOrder.value.map(m => m.id)));
const poolPos = (id) => {
  const i = poolIds.value.indexOf(id);
  return i >= 0 ? i + 1 : '';
};

// 点击切换选择:未选→追加到队尾(优先级最低),已选→移除
function poolClick(m) {
  if (poolIds.value.includes(m.id)) {
    poolIds.value = poolIds.value.filter(id => id !== m.id);
    toast(`已从模型池移除 ${m.display_name}`, 'info');
  } else {
    poolIds.value = [...poolIds.value, m.id];
    toast(`已加入模型池,优先级 ${poolIds.value.length}(${m.display_name})`, 'success');
  }
  persistPool();
}

// 清空模型池顺序(恢复默认)
function poolReset() {
  poolIds.value = [];
  persistPool();
  toast('模型池已重置(恢复默认顺序)', 'success');
}

// 旧版拖拽实现会在 localStorage 存全量默认顺序,视作"未设置"清空,避免一打开全选中
function migrateDefaultPool() {
  const all = models.value.map(m => m.id);
  if (all.length === 0 || poolIds.value.length === 0) return;
  const sorted = (arr) => [...arr].sort((a, b) => a - b);
  if (poolIds.value.length === all.length &&
      sorted(poolIds.value).every((id, i) => id === sorted(all)[i])) {
    poolIds.value = [];
    persistPool();
  }
}

function toggleAuto() {
  if (!models.value.length) { toast('模型池为空', 'error'); return; }
  autoMode.value = !autoMode.value;
  toast(autoMode.value
    ? '自动模式已开启：请求按池内顺序自动尝试，失败切换下一个'
    : '自动模式已关闭', 'info', 5000);
  poolOpen.value = false;
}

function toggleBypass() {
  bypassMode.value = !bypassMode.value;
  localStorage.setItem('pg_bypass', bypassMode.value ? '1' : '0');
  toast(bypassMode.value
    ? '自动审批模式开启：工具与技能调用不再需要人工批准（谨慎使用）'
    : '自动审批模式关闭', 'info', 5000);
}

function resetModes() {
  autoMode.value = false;
  bypassMode.value = false;
  localStorage.setItem('pg_bypass', '0');
  toast('所有模式已重置为默认（Agent 开关保持不变）', 'info');
}

/* ---------- 对话管理 ---------- */

async function loadChats() {
  try {
    const res = await aiApi.getChats();
    chats.value = res.data;
  } catch (e) { /* 静默 */ }
}

// 新建空白视图（本地占位；命名创建请用 createChatNamed，首条消息发送后才落库）
function newChat(project = null) {
  // 切走不打断后台生成；此处仅切换视图
  chatId.value = null;
  chatTitle.value = '';
  contextUsed.value = 0;
  contextLimit.value = 0;
  historyExpanded.value = false;
  messages.value = [];
  attachments.value = [];
  error.value = '';
  activeProjectId.value = project ? project.id : null;
  planMode.value = false;
  tasks.value = [];
  cwd.value = project ? project.root_path : (defaultCwd.value || cwd.value);
  localStorage.removeItem('pg_chat');
  syncRunView();
  approvals.value = [];
  nextTick(() => inputRef.value?.focus());
}

// 新建会话（可命名，创建即出现在左栏）：传入项目则归入该项目，否则为顶层自由会话
async function createChatNamed(project) {
  if (project && !(await preflightAgentsMd(project))) return; // AGENTS.md 过大时用户可取消
  const name = prompt(project ? `在项目「${project.name}」下新建会话，请输入名称：` : '新建自由会话，请输入名称：', '');
  if (name === null) return;
  const title = name.trim().substring(0, 60) || '新会话';
  try {
    const res = await aiApi.createChat({
      title,
      project_id: project ? project.id : undefined,
      model_row_id: (activeModel.value || models.value[0])?.id
    });
    const chat = res.data;
    if (project) expandedProjects.value = new Set(expandedProjects.value).add(project.id);
    await Promise.all([loadChats(), loadProjects()]);
    await loadChat(chat.id);
    toast(`会话「${chat.title}」已创建`, 'success');
  } catch (e) {
    toast(e.response?.data?.message || '创建失败', 'error');
  }
}

const loadChat = async (id) => {
  // 切换会话不打断生成：后台流继续写入其回复对象，此处仅切换视图
  try {
    const res = await aiApi.getChat(id);
    const chat = res.data.chat;
    chatId.value = chat.id;
    chatTitle.value = chat.title || '';
    contextLimit.value = res.data.usage?.limit || chat.context_limit || 0;
    contextUsed.value = res.data.usage?.used || 0;
    historyExpanded.value = false;
    // 会话配置跟随：项目归属 / 工作目录 / 模型 / Plan 模式 / 任务列表（会话共享模型列表，但各自记住配置）
    activeProjectId.value = chat.project_id || null;
    planMode.value = !!chat.plan_mode;
    tasks.value = res.data.tasks || [];
    if (chat.cwd) {
      cwd.value = chat.cwd;
    } else if (chat.project_id) {
      const proj = projects.value.find(p => p.id === chat.project_id);
      if (proj) cwd.value = proj.root_path;
    }
    if (!autoMode.value && chat.model_row_id) {
      const m = models.value.find(x => x.id === chat.model_row_id);
      if (m && (!activeModel.value || m.id !== activeModel.value.id)) activeModel.value = m;
    }
    localStorage.setItem('pg_chat', String(chat.id));
    messages.value = res.data.messages.map(m => {
      const steps = (Array.isArray(m.steps) && m.steps.length) ? m.steps.map(s => ({
        ...s,
        open: s.open === true,
        diff: (s.diff && s.diff.length) ? s.diff : null
      })) : (m.role === 'assistant' && (m.content ?? '').includes('[工具') ? [] : undefined);
      // 历史消息的时间线：无法还原当时的交错顺序，按「步骤块 + 正文」展示
      let timeline;
      if (m.role === 'assistant') {
        timeline = (steps || []).map(st => ({ kind: 'step', ...st }));
        if (m.content) timeline.push({ kind: 'text', start: 0, end: String(m.content).length });
      }
      return {
        role: m.role,
        content: m.content,
        display: m.content,
        reasoning: m.reasoning || '',
        reasoningOpen: false,
        collapsed: false,
        model_name: m.model_name || '',
        _id: m.id,
        userMsgId: m.role === 'user' ? m.id : null,
        steps,
        timeline,
        done: true,
        latency_ms: null
      };
    });
    // 该会话若有进行中的流，把未完成的回复接回列表尾部（后台仍在实时写入）
    const cs = findStreamForChat(id);
    if (cs) messages.value.push(cs.reply);
    syncRunView();
    approvals.value = [...(cs ? cs.approvals : [])];
    error.value = '';
    scrollToBottom();
  } catch (e) {
    toast(e.response?.data?.message || '载入对话失败', 'error');
  }
};

const removeChat = async (id) => {
  if (!confirm('确定删除该会话及其全部消息？')) return;
  try {
    await aiApi.deleteChat(id);
    const s = findStreamForChat(id);
    if (s && s.ctrl) s.ctrl.abort(); // 该会话若正在生成，一并终止
    if (id === chatId.value) newChat(activeProjectId.value ? (projects.value.find(p => p.id === activeProjectId.value) || null) : null);
    loadChats();
    loadProjects();
    toast('会话已删除', 'success');
  } catch (e) {
    toast(e.response?.data?.message || '删除失败', 'error');
  }
};

/* ---------- 撤回 ---------- */

const lastUserMsg = computed(() => {
  for (let i = messages.value.length - 1; i >= 0; i--) {
    const m = messages.value[i];
    if (m.role === 'user' && (m.userMsgId || m.id)) return { msg: m, idx: i };
  }
  return null;
});

async function retract(msg, idx, refillOnly = false) {
  const mid = msg.userMsgId || msg.id;
  if (!chatId.value || !mid) return;
  // 运行中撤回：先终止本次生成（静默，不弹「已取消」提示），再删除消息
  const s = findStreamForChat(chatId.value);
  if (s) { s.retracted = true; if (s.ctrl) s.ctrl.abort(); }
  try {
    const res = await aiApi.retractChat({ chat_id: chatId.value, message_id: mid });
    messages.value = messages.value.slice(0, idx);
    error.value = '';
    const text = String(res.data?.content || msg.content || '').replace(/\[\[img:[a-f0-9]+\]\]/g, '').trim();
    if (text) input.value = text;
    try {
      const u = await refreshUsage();
      if (u) { contextUsed.value = u.used; contextLimit.value = u.limit || contextLimit.value; }
    } catch (e) { /* 忽略 */ }
    toast(`已撤回 ${res.data?.deleted ?? 1} 条消息`, 'success');
    nextTick(() => inputRef.value?.focus());
  } catch (e) {
    toast(e.response?.data?.message || '撤回失败', 'error');
  }
}

const refreshUsage = async () => {
  if (!chatId.value) return null;
  try {
    const res = await aiApi.getChat(chatId.value);
    return res.data.usage;
  } catch (e) { return null; }
};

/* ---------- Agent 模式 ---------- */

async function toggleAgent() {
  agentMode.value = !agentMode.value;
  localStorage.setItem('pg_agent', agentMode.value ? '1' : '0');
  if (agentMode.value) {
    try {
      const res = await aiApi.getAgentInfo();
      // 仅在当前会话尚无工作目录时才用默认值；项目/自由会话各自的 cwd 不被覆盖
      if (!cwd.value) cwd.value = res.data.cwd;
      toast(`Agent 已开启（工具可操作服务器）。可用技能：${res.data.skills.map(s => s.name).join(', ') || '无'}`, 'info', 5000);
    } catch (e) {
      agentMode.value = false;
      localStorage.setItem('pg_agent', '0');
      toast(e.response?.data?.message || 'Agent 信息加载失败', 'error');
    }
  } else {
    toast('Agent 已关闭', 'info');
  }
}

const shortArgs = (args) => {
  try {
    const s = JSON.stringify(args) || '';
    return s.length > 80 ? s.substring(0, 80) + '…' : s;
  } catch {
    return '';
  }
};

/* ---------- 审批 ---------- */

const decideApproval = async (allow) => {
  const cur = approvals.value[0];
  if (!cur) return;
  approvals.value = approvals.value.slice(1);
  const cs = currentStream();
  if (cs) cs.approvals = approvals.value; // 与流内审批队列保持同步（切换会话后不复活）
  try {
    await aiApi.approve({ id: cur.id, allow });
  } catch (e) { /* 审批可能已超时 */ }
};

/* ---------- 图片上传 ---------- */

const onFileChange = async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    const fd = new FormData();
    fd.append('file', file);
    const res = await aiApi.uploadChatFile(fd);
    attachments.value.push({ token: res.data.token });
    toast('图片已就绪（30 分钟后自动销毁）', 'success');
  } catch (err) {
    toast(err.response?.data?.message || '上传失败', 'error');
  }
};

/* ---------- 发送与指令 ---------- */

/* 斜杠命令补全：输入 / 或 /片段 时在发送框上方显示候选，↑↓ 选择、Tab/Enter 补全 */
const SLASH_COMMANDS = [
  { cmd: '/model', desc: '切模型选择弹窗；后跟 ID/名称直接切换' },
  { cmd: '/pool', desc: '打开模型池，依次点击确定优先级' },
  { cmd: '/mode plan', desc: '计划模式：AI 输出计划，确认后执行' },
  { cmd: '/mode auto', desc: '自动模式：模型池依次自动尝试' },
  { cmd: '/mode bypass', desc: '自动放行模式：工具调用免确认' },
  { cmd: '/mode default', desc: '恢复默认模式' },
  { cmd: '/press', desc: '压缩当前上下文为摘要' },
  { cmd: '/context', desc: '设定上下文窗口，如 /context 30000' },
  { cmd: '/dir', desc: '切换 Agent 工作目录' },
  { cmd: '/exit', desc: '退出 Playground 返回控制台' },
  { cmd: '/help', desc: '打开帮助菜单' }
];
const cmdIdx = ref(0);
const cmdDismissed = ref(false);
const cmdMatches = computed(() => {
  const m = input.value.match(/^\/([\w-]*)$/); // 整行仅一个命令片段（无空格/换行）才补全
  if (!m) return [];
  const frag = '/' + m[1];
  return SLASH_COMMANDS.filter(c => c.cmd.startsWith(frag) || c.cmd.split(' ')[0].startsWith(frag));
});
const cmdVisible = computed(() => !busy.value && !cmdDismissed.value && cmdMatches.value.length > 0);
watch(input, () => { cmdIdx.value = 0; cmdDismissed.value = false; });

function completeCmd() {
  const c = cmdMatches.value[cmdIdx.value] || cmdMatches.value[0];
  if (!c) return;
  input.value = c.cmd + ' ';
  nextTick(() => inputRef.value?.focus());
}
function onCmdNav(e, dir) {
  if (!cmdVisible.value) return;
  e.preventDefault();
  const n = cmdMatches.value.length;
  cmdIdx.value = (cmdIdx.value + dir + n) % n;
}
function onCmdTab(e) {
  if (!cmdVisible.value) return;
  e.preventDefault();
  completeCmd();
}
function onEnterKey(e) {
  if (cmdVisible.value) { e.preventDefault(); completeCmd(); return; } // 补全面板打开时 Enter=补全，防止半截命令被发出
  send();
}

async function send() {
  const text = input.value.trim();
  if ((!text && !attachments.value.length) || busy.value) return;

  // /exit：返回控制台
if (text === '/exit') {
    input.value = '';
    close();
    return;
  }

  // /help:帮助菜单
  if (text === '/help' || text.startsWith('/help ')) {
    input.value = '';
    helpOpen.value = true;
    return;
  }

  // /dir:切换 Agent 工作目录（项目会话由后端校验边界：只能在项目根及子目录内）
  if (text.startsWith('/dir')) {
    const arg = text.slice(4).trim();
    try {
      const res = await aiApi.setCwd(arg || '.', chatId.value, cwd.value);
      cwd.value = res.data.cwd;
      toast(agentMode.value
        ? `工作目录已切换：${cwd.value}${res.data.project_name ? `（项目：${res.data.project_name}）` : ''}`
        : `工作目录已记录：${cwd.value}（注意：Agent 未开启，请点右上角 Agent）`, 'info', 6000);
    } catch (e) {
      toast(e.response?.data?.message || '目录切换失败', 'error');
    }
    input.value = '';
    return;
  }

  // /pool:打开模型池(依次点击确定优先级)
  if (text === '/pool' || text.startsWith('/pool ')) {
    input.value = '';
    poolOpen.value = true;
    return;
  }

  // /model / /mode 指令
  if (text.startsWith('/model') || text.startsWith('/mode')) {
    input.value = '';
    const isModel = text.startsWith('/model');
    const arg = text.replace(/^\/(model|mode)\s*/i, '').trim();
    if (!arg) {
      if (isModel && autoMode.value) {
        toast('自动模式下不可切换模型（/mode auto 可退出自动模式）', 'info', 5000);
        return;
      }
      openPicker();
      return;
    }
    const lower = arg.toLowerCase();
    if (lower === 'auto') {
      if (autoMode.value) {
        autoMode.value = false;
        toast('自动模式已退出，恢复手动选择模型', 'info', 5000);
      } else {
        toggleAuto();
      }
      return;
    }
    if (lower === 'plan') {
      togglePlan();
      return;
    }
    if (lower === 'bypass') {
      toggleBypass();
      return;
    }
    if (lower === 'default') {
      resetModes();
      return;
    }
    if (isModel) {
      if (autoMode.value) {
        toast('自动模式下不可切换模型（/mode auto 可退出自动模式）', 'info', 5000);
        return;
      }
      switchModelById(arg);
    } else {
      toast(`/mode 未知子指令：${arg}（可用：plan / auto / bypass / default）`, 'info', 5000);
    }
    return;
  }

  // /press：压缩上下文
  if (text.startsWith('/press')) {
    input.value = '';
    if (!chatId.value) { toast('当前还没有对话，先发送一条消息吧', 'info'); return; }
    if (!activeModel.value && !autoMode.value) { toast('请先选择模型', 'error'); return; }
    try {
      const res = await aiApi.pressChat({ chat_id: chatId.value, model_row_id: activeModel.value?.id });
      pushNote(res.message || '压缩完成');
      const u = await refreshUsage();
      if (u) { contextUsed.value = u.used; contextLimit.value = u.limit || contextLimit.value; }
    } catch (e) {
      toast(e.response?.data?.message || '压缩失败', 'error');
    }
    return;
  }

  // /context <N>：设定窗口并立即压缩
  if (text.startsWith('/context')) {
    input.value = '';
    const arg = text.slice(8).trim();
    if (!/^\d+$/.test(arg)) { toast('用法：/context <整数>（字符数，如 /context 30000）', 'info', 5000); return; }
    if (!chatId.value) { toast('当前还没有对话，先发送一条消息吧', 'info'); return; }
    if (!activeModel.value) { toast('请先选择模型', 'error'); return; }
    try {
      // 先行刷新标题栏：服务端要等压缩(LLM 调用)完成才响应，不能等返回再更新
      contextLimit.value = parseInt(arg);
      const res = await aiApi.setContext({ chat_id: chatId.value, limit: parseInt(arg), model_row_id: activeModel.value.id });
      pushNote(res.message || '上下文窗口已更新');
      const u = await refreshUsage();
      if (u) { contextUsed.value = u.used; contextLimit.value = u.limit || contextLimit.value; }
    } catch (e) {
      toast(e.response?.data?.message || '设置失败', 'error');
    }
    return;
  }

  if (!activeModel.value && !autoMode.value) { toast('请先选择模型（/model）', 'error'); return; }
  if (text.length > 8000) { toast('消息内容不能超过 8000 字符', 'error'); return; }

  error.value = '';

  // 消息内容 = 文本 + 附件图片标记；@技能名 手动注入技能文档
  const imgTokens = attachments.value.map(a => `[[img:${a.token}]]`);
  let content = [text, ...imgTokens].filter(Boolean).join('\n').trim();
  const skillRefs = [...text.matchAll(/@([\w\u4e00-\u9fff-]+)/g)].map(m => m[1]);
  for (const ref of skillRefs) {
    const skill = skills.value.find(s => s.name.toLowerCase() === ref.toLowerCase());
    if (skill) content = `[[技能文档：${skill.name}（用户通过 @${ref} 手动引用）]]\n<skill>\n${skill.body}\n</skill>\n\n${content}`;
  }
  input.value = '';
  attachments.value = [];

  messages.value.push({ role: 'user', content, done: true });
  const reply = {
    role: 'assistant', content: '', display: '', done: false, latency_ms: null,
    steps: agentMode.value ? [] : null, reasoning: '', reasoningOpen: false,
    collapsed: false, timeline: [],
    phase: 'connecting', model_name: autoMode.value ? '自动模式' : activeModel.value?.display_name
  };
  messages.value.push(reply);
  const replyReactive = messages.value[messages.value.length - 1];
  const sentInto = messages.value; // 判断用户是否停留在本会话（决定状态栏与滚动）
  const originChatId = chatId.value; // 发起时会话（可能为 null，等待服务端建号）
  historyExpanded.value = false;

  const ctrl = new AbortController();
  const stream = { seq: ++streamSeq, originChatId, chatId: null, ctrl, reply: replyReactive, sentInto, gen: null, approvals: [] };
  streams.set(stream.seq, stream);
  streamsVersion.value++; // 触发 busy 重算 → 发送按钮切换为停止
  startGen(stream);
  if (currentStream() === stream) scrollToBottom();

  try {
    const pool = autoMode.value ? poolOrder.value.map(m => m.id) : [activeModel.value?.id].filter(Boolean);
    const res = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model_row_id: pool[0],
        pool,
        chat_id: originChatId,
        project_id: originChatId ? undefined : (activeProjectId.value || undefined),
        plan_mode: originChatId ? undefined : planMode.value,
        content,
        agent: agentMode.value,
        cwd: cwd.value,
        bypass: bypassMode.value
      }),
      signal: ctrl.signal
    });
    replyReactive.phase = 'thinking';

    if (!res.ok || !res.body) {
      let msg = `HTTP ${res.status}`;
      try { msg = (await res.json()).message || msg; } catch (e) { /* 忽略 */ }
      throw new Error(msg);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let gotData = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      gotData = true;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';
      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith('data:')) continue;
        try {
          const evt = JSON.parse(line.slice(5).trim());
          if (evt.t === 'chat') {
            stream.chatId = evt.chat_id;
            // 用户仍停留在发起会话（含等待建号的空白会话）时才把新 ID 采纳进视图
            if ((stream.originChatId ?? null) === (chatId.value ?? null)) {
              chatId.value = evt.chat_id;
              if (evt.title) chatTitle.value = evt.title;
              localStorage.setItem('pg_chat', String(evt.chat_id));
            }
            const lastUser = [...sentInto].reverse().find(m => m.role === 'user');
            if (lastUser) lastUser.userMsgId = evt.user_message_id;
            loadChats();
            loadProjects();
          } else if (evt.t === 'model') {
            replyReactive.model_name = evt.name;
          } else if (evt.t === 'delta') {
            replyReactive.phase = null;
            gotData = true;
            replyReactive.content += evt.text;
            tlAppendText(replyReactive, evt.text);
            feedGen(stream, evt.text);
            startTyper(replyReactive);
            if (currentStream() === stream) scrollToBottom();
          } else if (evt.t === 'reason') {
            replyReactive.reasoning += evt.text;
            feedGen(stream, evt.text);
            gotData = true;
          } else if (evt.t === 'tool') {
            gotData = true;
            // 编辑类工具执行中显示 ~ Editing...,其他工具显示 ~ Working...
            replyReactive.phase = (evt.name === 'write_file' || evt.name === 'edit_file') ? 'editing' : 'working';
            tlFlush(replyReactive);
            const st = { type: 'tool', name: evt.name, args: evt.args };
            replyReactive.steps.push(st);
            replyReactive.timeline.push({ kind: 'step', ...st });
            if (currentStream() === stream) scrollToBottom();
          } else if (evt.t === 'tool_result') {
            replyReactive.phase = null;
            gotData = true;
            tlFlush(replyReactive);
            const st = {
              type: 'result', name: evt.name, output: evt.output, error: evt.error,
              open: evt.open === true, diff: (evt.diff && evt.diff.length) ? evt.diff : null,
              path: evt.path || null, new_file: !!evt.new_file
            };
            replyReactive.steps.push(st);
            replyReactive.timeline.push({ kind: 'step', ...st });
            if (currentStream() === stream) scrollToBottom();
          } else if (evt.t === 'approval') {
            stream.approvals = [...stream.approvals, evt];
            if (currentStream() === stream) approvals.value = stream.approvals;
          } else if (evt.t === 'note') {
            tlFlush(replyReactive);
            const st = { type: 'note', message: evt.message };
            replyReactive.steps.push(st);
            replyReactive.timeline.push({ kind: 'step', ...st });
            if (currentStream() === stream) scrollToBottom();
          } else if (evt.t === 'tasks') {
            if (currentStream() === stream) tasks.value = evt.tasks || [];
          } else if (evt.t === 'done') {
            replyReactive.phase = null;
            replyReactive.latency_ms = evt.latency_ms;
            if (currentStream() === stream) {
              if (evt.context_used != null) contextUsed.value = evt.context_used;
              if (evt.context_limit != null) contextLimit.value = evt.context_limit;
              if (evt.tasks) tasks.value = evt.tasks;
            }
          } else if (evt.t === 'error') {
            replyReactive.phase = null;
            if (currentStream() === stream) error.value = evt.message;
          }
        } catch (e) { /* 非 JSON 行跳过 */ }
      }
    }
    if (!gotData && !error.value && currentStream() === stream) error.value = '模型无响应';
  } catch (e) {
    if (e.name !== 'AbortError') {
      if (currentStream() === stream) error.value = e.message || '请求失败';
    } else if (messages.value === sentInto && !stream.retracted) {
      pushNote('已取消本次生成');
    }
  } finally {
    replyReactive.done = true;
    replyReactive.phase = null;
    if (!replyReactive.content && !error.value && !(replyReactive.steps && replyReactive.steps.length)) replyReactive.content = '(空回复)';
    if (replyReactive.content) startTyper(replyReactive);
    endGen(stream);          // 当前会话的流 → 状态栏落 done；后台流 → 仅清理
    streams.delete(stream.seq);
    streamsVersion.value++; // 触发 busy 重算 → 停止按钮恢复为发送
    if (messages.value === sentInto) scrollToBottom();
  }
}

function pushNote(text) {
  messages.value.push({ role: 'note', content: text, done: true });
  scrollToBottom();
}

const ctxPct = computed(() => contextLimit.value > 0 ? Math.min(100, Math.round(contextUsed.value / contextLimit.value * 100)) : 0);

/* ---------- 生命周期 ---------- */

// ESC：优先关闭弹层，其次停止生成
const onKeydown = (e) => {
  if (e.key !== 'Escape') return;
  if (helpOpen.value) { helpOpen.value = false; return; }
  if (pickerOpen.value) { pickerOpen.value = false; return; }
  if (poolOpen.value) { poolOpen.value = false; return; }
  if (cmdVisible.value) { cmdDismissed.value = true; return; }
  if (busy.value) { stop(); return; }
};

// 轨迹页跳转定位：?chat=ID&msg=ID → 载入对应会话并高亮消息
// 首次挂载与 KeepAlive 再激活共用；跳转前若正在生成会先停止（loadChat 内部处理）
let lastJumpKey = '';
async function handleTraceJump() {
  const targetChat = parseInt(route.query.chat);
  if (!Number.isInteger(targetChat) || targetChat <= 0) { lastJumpKey = ''; return false; }
  const jumpKey = String(route.query.chat) + '_' + String(route.query.msg || '');
  if (jumpKey === lastJumpKey) return true; // 挂载+激活双触发去重
  lastJumpKey = jumpKey;
  const targetMsg = parseInt(route.query.msg);
  try {
    const res = await aiApi.getChats();
    chats.value = res.data;
    const found = chats.value.find(c => c.id === targetChat);
    if (found) {
      await loadChat(found.id);
      if (targetMsg) highlightMessage(targetMsg);
      if (route.query.chat) { router.replace({ query: {} }); lastJumpKey = ''; }
      return true;
    }
  } catch (e) { /* 跳转失败留在当前会话 */ }
  lastJumpKey = '';
  return false;
}

// 小鲸鱼余额挂件句柄（mountWhaleWidget 为全局单例）
let whale = null;

// 页面化：挂载即初始化（等价于原弹窗打开逻辑）
onMounted(async () => {
  window.addEventListener('keydown', onKeydown);
  // 小鲸鱼余额挂件（聊天页右下角；KeepAlive 切页时仅隐藏，不销毁）
  if (!whale) whale = mountWhaleWidget();
  whale.setVisible(true);
  attachments.value = [];
  error.value = '';
  pickerOpen.value = false;
  historyExpanded.value = false;
  stopAllTypers();
  bypassMode.value = localStorage.getItem('pg_bypass') === '1';
  // Agent 开关持久化：刷新/重开后恢复上次状态
  agentMode.value = localStorage.getItem('pg_agent') === '1';

  // 加载全部模型并确定当前模型（优先：外部指定 > 上次使用 > 第一个）
  await loadModels();
  const savedId = parseInt(localStorage.getItem('pg_model'));
  activeModel.value =
    (props.model && models.value.find(m => m.id === props.model.id)) ||
    models.value.find(m => m.id === savedId) ||
    models.value[0] || null;

  // Agent 默认目录（自由会话初始 cwd）+ 项目列表（loadChat 需要两者）
  try {
    const res = await aiApi.getAgentInfo();
    defaultCwd.value = res.data.cwd;
  } catch (e) { /* 静默 */ }
  cwd.value = cwd.value || defaultCwd.value;
  await loadProjects();

  // 轨迹页跳转优先（命中则跳过默认会话恢复）
  const jumped = await handleTraceJump();

  // 首次启动：默认 Shell 未设置 → 弹窗选择；技能列表（@引用用）
  checkShellSetup();
  loadSkills();

  if (jumped) return;

  // 自动恢复最近一次会话（上下文延续；含项目/目录/模型跟随）
  const savedChat = parseInt(localStorage.getItem('pg_chat'));
  try {
    const res = await aiApi.getChats();
    chats.value = res.data;
    const foundSaved = chats.value.find(c => c.id === savedChat);
    if (foundSaved) {
      await loadChat(foundSaved.id);
      return;
    }
  } catch (e) { /* 载入失败按新对话处理 */ }
  newChat();
  nextTick(() => inputRef.value?.focus());
});

// 定位并闪烁高亮一条消息（轨迹页跳转用）
const highlightId = ref(null);
function highlightMessage(msgId) {
  highlightId.value = msgId;
  nextTick(() => {
    const el = document.getElementById('kh-msg-' + msgId);
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(() => { highlightId.value = null; }, 3500);
  });
}

// 外部切换初始模型（模型列表页点击不同模型名跳转）
watch(() => props.model, (m) => {
  if (m && models.value.length) {
    const found = models.value.find(x => x.id === m.id);
    if (found && (!activeModel.value || found.id !== activeModel.value.id)) switchModel(found);
  }
});

// KeepAlive 数据保鲜：管理页可能增删了模型/项目/会话（缓存期不会重新挂载，回到本页时刷新）
async function refreshModels() {
  try {
    const res = await aiApi.getStatus();
    models.value = res.data.list || [];
  } catch (e) { return; }
  migrateDefaultPool();
  if (activeModel.value) {
    // 保留当前选择；被删除时回落到上次使用/第一个
    const kept = models.value.find(m => m.id === activeModel.value.id);
    activeModel.value = kept ||
      models.value.find(m => m.id === parseInt(localStorage.getItem('pg_model'))) ||
      models.value[0] || null;
  }
}

// KeepAlive 缓存期：切走时组件不销毁，流式响应在后台继续写入
// 再激活时：保鲜数据 + 处理轨迹页跳转；正在生成则滚到底部看最新内容
onActivated(async () => {
  window.addEventListener('keydown', onKeydown);
  if (whale) whale.setVisible(true); // 小鲸鱼只在聊天页显示
  refreshModels();
  loadProjects();
  loadChats();
  await handleTraceJump();
  if (busy.value) scrollToBottom();
});

// 失活时摘除全局按键监听，避免在其他页面按 ESC 误触发停止生成/关弹层
onDeactivated(() => {
  window.removeEventListener('keydown', onKeydown);
  if (whale) whale.setVisible(false);
});

onUnmounted(() => {
  for (const s of streams.values()) { if (s.ctrl) { try { s.ctrl.abort(); } catch (e) { /* 忽略 */ } } }
  stopAllTypers();
  if (genTicker) { clearInterval(genTicker); genTicker = null; }
  window.removeEventListener('keydown', onKeydown);
  if (whale) { whale.destroy(); whale = null; } // 小鲸鱼随聊天页销毁（单例，重进可重建）
});
</script>

<style scoped>
/* 页面化容器：占满内容区（弹窗模式的 .pg-overlay 样式仅保留给子弹层使用） */
.pg-page{width:100%;max-width:1800px;margin:0 auto;display:flex;flex-direction:column;position:relative}
.pg-shell{display:flex;gap:14px;align-items:stretch;width:100%;min-height:0}
.pg-page-modal{max-width:none;height:100%;min-height:420px;flex:1;min-width:0}

/* 左栏：项目与会话 */
.pg-side{width:280px;flex-shrink:0;background:var(--bg-card);border:1px solid var(--border-light);border-radius:16px;display:flex;flex-direction:column;overflow:hidden;height:100%;min-height:420px}
.pg-side-actions{padding:.7rem;border-bottom:1px solid var(--border-light);display:flex;gap:.4rem;flex-shrink:0}
.pg-side-new{flex:1;justify-content:center;display:inline-flex;align-items:center;gap:.3rem;font-size:.8rem}
.pg-side-scroll{flex:1;overflow-y:auto;padding:.6rem}
.pg-side-group{margin-bottom:.8rem}
.pg-side-head{display:flex;align-items:center;gap:.4rem;color:var(--text-muted);font-size:.78rem;font-weight:600;padding:.3rem .4rem;user-select:none}
.pg-side-head-project{cursor:pointer;border-radius:8px;color:var(--text-dark)}
.pg-side-head-project:hover{background:var(--accent-pink);color:var(--primary-blue)}
.pg-side-proj-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.pg-side-count{background:var(--accent-pink);color:var(--text-muted);border-radius:8px;padding:0 .35rem;font-size:.68rem;flex-shrink:0}
.pg-side-head-btns{display:none;gap:.15rem;flex-shrink:0}
.pg-side-head-project:hover .pg-side-head-btns{display:inline-flex}
.pg-side-head-project:hover .pg-side-count{display:none}
.pg-side-btn{border:none;background:transparent;color:var(--text-muted);cursor:pointer;font-size:.7rem;padding:.2rem .3rem;border-radius:6px}
.pg-side-btn:hover{color:var(--primary-blue);background:var(--bg-card-solid)}
.pg-side-btn-del:hover{color:#c0392b}
.pg-side-item{display:flex;align-items:center;gap:.4rem;border:1px solid transparent;border-radius:8px;color:var(--text-dark);cursor:pointer;font-size:.82rem;padding:.4rem .5rem;margin-top:.15rem;transition:background .15s}
.pg-side-item:hover{background:var(--accent-pink)}
.pg-side-item.active{background:var(--accent-pink);border-color:var(--primary-blue)}
.pg-side-item-icon{color:var(--text-muted);font-size:.7rem;flex-shrink:0}
.pg-side-item.active .pg-side-item-icon{color:var(--primary-gold)}
.pg-side-item-title{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.pg-side-item-del{border:none;background:transparent;color:var(--text-muted);cursor:pointer;font-size:.7rem;padding:.15rem;border-radius:6px;opacity:0;flex-shrink:0;transition:opacity .15s}
.pg-side-item:hover .pg-side-item-del{opacity:1}
.pg-side-item-del:hover{color:#c0392b;background:var(--bg-card-solid)}
.pg-side-empty{color:var(--text-muted);font-size:.75rem;padding:.35rem .5rem;opacity:.8}
.pg-side-empty-first{line-height:1.6;margin-top:.5rem}
.pg-side-foot{border-top:1px solid var(--border-light);color:var(--text-muted);font-size:.7rem;padding:.5rem .7rem;flex-shrink:0}
.pg-side-toggle{margin-right:.2rem}

/* 拖拽分隔条（board 宽度调节） */
.pg-resizer{width:7px;flex-shrink:0;cursor:col-resize;border-radius:4px;transition:background .15s;position:relative}
.pg-resizer::after{content:'';position:absolute;top:50%;left:50%;width:3px;height:44px;transform:translate(-50%,-50%);border-radius:3px;background:var(--border-light);transition:background .15s}
.pg-resizer:hover::after,.pg-resizer:active::after{background:var(--primary-gold)}
.pg-resizer:active{cursor:col-resize}
.pg-resizer-task{position:absolute;top:0;right:0;bottom:0;width:7px;z-index:5;background:transparent}
.pg-taskpanel-right{margin-left:auto}
.pg-sub-proj{color:var(--primary-blue);background:var(--accent-pink);border-radius:8px;padding:.1rem .5rem;font-size:.75rem;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pg-sub-proj i{margin-right:.25rem}

/* 任务面板（Plan 模式）：与项目/会话栏同级的独立 board（复用 .pg-side 容器） */
.pg-taskpanel-head{border-bottom:1px solid var(--border-light);padding:.55rem .8rem;display:flex;justify-content:space-between;align-items:center;color:var(--primary-blue);font-weight:500;font-size:.85rem;flex-shrink:0}
.pg-taskpanel-head span:first-child i{color:var(--primary-gold);margin-right:.35rem}
.pg-taskpanel-meta{color:var(--text-muted);font-size:.72rem;font-weight:400}
.pg-taskpanel-list{flex:1;overflow-y:auto;padding:.6rem}
.pg-taskpanel{position:relative}
.pg-task-resizer-v{position:absolute;left:0;right:0;bottom:0;height:7px;cursor:row-resize;z-index:5}
.pg-task-resizer-v::after{content:'';position:absolute;top:50%;left:50%;width:44px;height:3px;transform:translate(-50%,-50%);border-radius:3px;background:var(--border-light);transition:background .15s}
.pg-task-resizer-v:hover::after{background:var(--primary-gold)}
.pg-taskpanel-empty{color:var(--text-muted);font-size:.78rem;line-height:1.6;padding:.8rem .4rem}
.pg-taskpanel-empty code{background:var(--accent-pink);border-radius:5px;padding:0 .3rem}
.pg-task{display:flex;gap:.45rem;align-items:flex-start;border:1px solid var(--border-light);border-radius:9px;padding:.45rem .5rem;margin-bottom:.4rem;background:var(--bg-card-solid)}
.pg-task.is-doing{border-color:var(--primary-blue)}
.pg-task.is-done{opacity:.65}
.pg-task.is-failed{border-color:#c0392b;background:#c0392b0d}
.pg-task-check{border:none;background:0 0;cursor:pointer;color:var(--text-muted);font-size:.95rem;padding:.05rem;flex-shrink:0}
.pg-task.is-doing .pg-task-check{color:var(--primary-blue)}
.pg-task.is-done .pg-task-check{color:#27ae60}
.pg-task.is-failed .pg-task-check{color:#c0392b}
.pg-task-main{flex:1;min-width:0}
.pg-task-content{font-size:.8rem;line-height:1.45;word-break:break-word;color:var(--text-dark)}
.pg-task-content.done{text-decoration:line-through;color:var(--text-muted)}
.pg-task-err{color:#c0392b;font-size:.72rem;margin-top:.2rem;line-height:1.4;word-break:break-word}
.pg-task-err i{margin-right:.2rem}
.pg-task-seq{color:var(--text-muted);font-size:.68rem;flex-shrink:0;opacity:.7}

/* Shell 选择弹窗 */
.pg-shell-modal{max-width:500px}
.pg-shell-item{display:flex;align-items:center;gap:.6rem;border:1px solid var(--border-light);border-radius:10px;padding:.6rem .8rem;cursor:pointer;margin-top:.4rem;color:var(--text-dark)}
.pg-shell-item:hover{border-color:var(--primary-gold);background:var(--accent-pink)}
.pg-shell-item.missing{opacity:.5;cursor:not-allowed}
.pg-shell-item i{color:var(--primary-gold)}
.pg-shell-label{flex:1;font-size:.88rem}
.pg-shell-value{color:var(--text-muted);font-size:.75rem;font-family:Consolas,Menlo,monospace}
.pg-shell-missing{color:#c0392b;font-size:.72rem}

/* 沉浸模式：隐藏导航/页脚（App 层），各 board 融合平铺铺满全屏 */
.pg-immersive{max-width:none;padding:0 .6rem}
.pg-immersive .pg-shell{height:100vh;gap:8px}
.pg-immersive .pg-page-modal{height:100vh;min-height:0}
.pg-immersive .pg-side{height:100vh;min-height:0;border-color:transparent;background:transparent}
.pg-immersive .pg-side-actions{border-bottom-color:var(--border-light)}
.pg-immersive .pg-modal{border-radius:0;box-shadow:none}
/* 任务面板：上下变短并往上收（顶部对齐、不再整列拉伸；列表内部滚动）。
   选择器用 .pg-shell 前缀压过 .pg-side / .pg-immersive .pg-side 的 height:100%/100vh */
.pg-shell .pg-taskpanel{align-self:flex-start;height:75%;min-height:0}

/* 新建项目弹窗 */
.pg-project-modal{max-width:520px}
.pg-project-body{padding:1rem;flex-direction:column;gap:.3rem;display:flex}
.pg-project-label{color:var(--text-muted);font-size:.78rem;margin-top:.4rem}
.pg-project-input{border:2px solid var(--border-light);background:var(--bg-base);color:var(--text-dark);border-radius:10px;padding:.5rem .7rem;font-family:inherit;font-size:.88rem;outline:none;width:100%}
.pg-project-input:focus{border-color:var(--primary-gold)}
.pg-project-path-row{display:flex;gap:.4rem;align-items:center}
.pg-project-path{flex:1;font-family:Consolas,Menlo,monospace;font-size:.8rem}
.pg-project-err{color:#c0392b;background:#c0392b14;border-radius:8px;padding:.4rem .6rem;font-size:.8rem;margin-top:.5rem}
.pg-project-tip{color:var(--text-muted);font-size:.74rem;line-height:1.5;margin-top:.6rem}
.pg-project-tip i{color:var(--primary-gold);margin-right:.3rem}
.pg-project-actions{border-top:1px solid var(--border-light);padding:.8rem 1rem;display:flex;gap:.8rem;justify-content:flex-end;flex-shrink:0}
.pg-overlay{z-index:1300;background:#0000008c;justify-content:center;align-items:center;padding:1rem;display:flex;position:fixed;inset:0}
.pg-modal{background:var(--bg-card-solid);width:100%;height:84vh;box-shadow:var(--shadow-dropdown);border-radius:16px;flex-direction:column;display:flex;overflow:hidden;position:relative;flex:1 1 0;min-width:320px;max-width:none}
.pg-modal-wide{max-width:none;flex:1 1 auto}
.pg-header{border-bottom:1px solid var(--border-light);justify-content:space-between;align-items:center;padding:.6rem .8rem;display:flex;flex-shrink:0;gap:.5rem;flex-wrap:wrap}
.pg-title{display:flex;align-items:center;gap:.5rem;min-width:0}
.pg-model-btn{display:inline-flex;align-items:center;gap:.4rem;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pg-header-actions{gap:.4rem;display:flex;flex-shrink:0;align-items:center;flex-wrap:wrap}
.pg-count{background:var(--primary-blue);color:#fff;border-radius:8px;padding:0 .35rem;font-size:.7rem;margin-left:2px}

.pg-subheader{border-bottom:1px dashed var(--border-light);color:var(--text-muted);font-size:.78rem;padding:.35rem .8rem;flex-shrink:0;display:flex;gap:1rem;align-items:center;flex-wrap:wrap}
.pg-sub-chat{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:34%}
.pg-sub-chat i,.pg-sub-cwd i,.pg-ctx i{margin-right:.3rem}
.pg-sub-cwd{font-family:Consolas,Menlo,monospace;color:var(--primary-gold)}
.pg-sub-bypass{color:#e67e22}
.pg-ctx{display:inline-flex;align-items:center;gap:.4rem;margin-left:auto}
.pg-ctx-bar{width:90px;height:6px;background:var(--accent-pink);border-radius:4px;overflow:hidden;display:inline-block}
.pg-ctx-fill{background:var(--primary-blue);height:100%;border-radius:4px;transition:width .3s;display:block}
.pg-ctx-fill.warn{background:#e67e22}

.pg-body{flex:1;position:relative;display:flex;min-height:0}
.pg-messages{flex:1;padding:1rem;overflow-y:auto}

.pg-empty{text-align:center;color:var(--text-muted);padding:3rem 0}
.pg-empty i{font-size:2rem;margin-bottom:.8rem;opacity:.5}
.pg-empty p{margin:.3rem 0}
.pg-hint{font-size:.8rem;opacity:.7}
.pg-hint-agent{color:var(--primary-gold);opacity:1;background:var(--bg-base);border-radius:8px;padding:.5rem .7rem;margin:.6rem auto 0;max-width:90%;display:inline-block}

.pg-msg{margin-bottom:.9rem;display:flex;flex-direction:column}
.pg-msg.pg-flash{animation:pg-flash-bg 1.2s ease-out 3;border-radius:12px}
@keyframes pg-flash-bg{0%,100%{background:transparent}40%{background:var(--accent-pink)}}
.pg-user{align-items:flex-end}
.pg-assistant{align-items:flex-start}
.pg-note{align-items:center}
.pg-note-line{color:var(--text-muted);font-size:.78rem;background:var(--bg-base);border-radius:20px;padding:.25rem .9rem}
.pg-note-line i{margin-right:.3rem;color:var(--primary-gold)}

.pg-history-toggle{align-self:stretch;border:1px dashed var(--border-light);background:var(--bg-base);color:var(--text-muted);cursor:pointer;border-radius:10px;padding:.4rem .7rem;font-family:inherit;font-size:.78rem;text-align:left;margin-bottom:.9rem;transition:border-color .15s}
.pg-history-toggle:hover{border-color:var(--primary-gold);color:var(--primary-blue)}
.pg-history-toggle .fa-caret-right{margin-right:.3rem;color:var(--primary-gold)}
.pg-history-preview{margin-top:.35rem;color:var(--text-muted);opacity:.75;white-space:pre-wrap;word-break:break-word;font-size:.75rem;line-height:1.5;display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden}

.pg-msg-meta{margin-bottom:.2rem;padding:0 .3rem}
.pg-msg-model{color:var(--text-muted);font-size:.72rem}
.pg-msg-model i{margin-right:.25rem;color:var(--primary-gold)}

.pg-bubble{background:var(--accent-pink);color:var(--text-dark);border-radius:14px;padding:.6rem .9rem;max-width:85%;font-size:.92rem;line-height:1.6;white-space:pre-wrap;word-break:break-word}
.pg-bubble-assistant{background:var(--bg-card);border:1px solid var(--border-light);white-space:normal}
.pg-md :first-child{margin-top:0}
.pg-md :last-child{margin-bottom:0}
.pg-user .pg-bubble{background:var(--primary-blue);color:#fff}
.pg-chat-img{max-width:220px;max-height:160px;border-radius:8px;display:block;margin:.3rem 0}
.pg-img-dead{opacity:.6;font-size:.85rem}
.pg-latency{color:var(--text-muted);font-size:.72rem;margin-top:.25rem;padding:0 .3rem;display:flex;align-items:center;gap:.5rem}
.pg-copy-btn{opacity:.7;border:1px solid var(--border-light);background:var(--bg-card-solid);border-radius:6px;padding:.2rem .45rem;font-size:.75rem;transition:all .15s}
.pg-copy-btn:hover{opacity:1;color:var(--primary-blue);border-color:var(--primary-gold);background:var(--accent-pink);transform:translateY(-1px)}
.pg-msg:hover .pg-copy-btn{opacity:.9}

/* markdown 代码块复制按钮 */
:deep(.md-code){position:relative}
:deep(.md-copy){position:absolute;top:.5rem;right:.6rem;z-index:2;border:1px solid var(--border-light);background:var(--bg-card-solid);color:var(--primary-blue);border-radius:8px;padding:.3rem .65rem;font-size:.75rem;cursor:pointer;opacity:.9;transition:all .15s;font-family:inherit;display:inline-flex;align-items:center;gap:.3rem;font-weight:500;box-shadow:0 2px 8px rgba(0,0,0,0.08)}
:deep(.md-copy):hover{opacity:1;color:#fff;background:var(--primary-blue);border-color:var(--primary-blue);transform:translateY(-1px);box-shadow:0 4px 12px rgba(0,0,0,0.15)}
:deep(.md-copy):active{transform:scale(0.96)}

.pg-retract{align-self:flex-end;border:none;background:0 0;color:var(--text-muted);cursor:pointer;font-size:.72rem;padding:.15rem .4rem;border-radius:6px;margin-top:.15rem;opacity:0;transition:opacity .15s}
.pg-msg:hover .pg-retract{opacity:1}
.pg-retract:hover{color:#e67e22;background:var(--bg-base)}

/* 连接/思考阶段 */
.pg-phase{color:var(--text-muted);font-size:.88rem}
.pg-phase i{margin-right:.4rem}
.pg-phase-inline{display:inline-block;margin:.1rem 0 .2rem}
.pg-model-settings-bar{padding:.4rem 1rem 0;display:flex;justify-content:flex-start}
.pg-model-settings{max-width:560px;width:95%}
.pg-model-settings-body{padding:1rem 1.2rem;max-height:60vh;overflow-y:auto;display:flex;flex-direction:column;gap:1rem}
.ms-group label{display:block;font-weight:500;color:var(--primary-blue);font-size:.9rem;margin-bottom:.3rem}
.ms-hint{color:var(--text-muted);font-weight:400;font-size:.78rem;margin-left:.4rem}
.ms-row{display:flex;align-items:center;gap:.6rem}
.ms-range{flex:1}
.ms-number{width:90px;padding:.4rem .5rem;border:2px solid var(--border-light);border-radius:8px;background:var(--bg-card-solid);color:var(--text-dark)}
.ms-check{display:flex;align-items:center;gap:.5rem;cursor:pointer;color:var(--text-dark)}
.ms-warn{color:#e67e22;font-size:.78rem;margin-left:.5rem}
.ms-select{width:100%;padding:.5rem;border:2px solid var(--border-light);border-radius:8px;background:var(--bg-card-solid);color:var(--text-dark)}
.ms-textarea{width:100%;padding:.5rem;border:2px solid var(--border-light);border-radius:8px;background:var(--bg-card-solid);color:var(--text-dark);resize:vertical;min-height:70px}
.ms-default{color:var(--text-muted);font-size:.78rem;white-space:nowrap}

/* 打字机光标 */
.pg-caret{display:inline-block;width:.55em;height:1em;background:currentColor;vertical-align:-.12em;margin-left:2px;animation:pg-blink 1s steps(2) infinite}
@keyframes pg-blink{50%{opacity:0}}

/* 长回复折叠 */
.pg-collapsed{border:1px dashed var(--border-light);border-radius:10px;padding:.4rem .7rem}
.pg-collapse-toggle{border:none;background:0 0;color:var(--primary-gold);cursor:pointer;font-size:.78rem;padding:.2rem 0;font-family:inherit;text-align:left}
.pg-collapse-toggle:hover{color:var(--primary-blue);text-decoration:underline}
.pg-collapse-toggle .fa-caret-right{margin-right:.3rem}
.pg-collapse-up{margin-top:.4rem;display:inline-flex;align-items:center;gap:.3rem}

/* 思考过程 */
.pg-reason{border:1px dashed var(--border-light);border-radius:10px;margin-bottom:.5rem;overflow:hidden}
.pg-reason-head{color:var(--text-muted);cursor:pointer;padding:.35rem .6rem;font-size:.78rem;display:flex;align-items:center;gap:.4rem;background:var(--bg-base)}
.pg-reason-head:hover{color:var(--primary-blue)}
.pg-reason-body{background:var(--bg-base);color:var(--text-muted);padding:.5rem .7rem;font-size:.75rem;white-space:pre-wrap;word-break:break-word;max-height:200px;overflow-y:auto;margin:0;font-family:Consolas,Menlo,monospace}

/* Agent 工具步骤 */
.pg-steps{margin-bottom:.4rem;border-left:2px solid var(--primary-gold);padding-left:.5rem;display:flex;flex-direction:column;gap:.25rem}
.pg-tl-steps{margin:.2rem 0 .4rem}
.pg-step{font-size:.8rem;min-width:0}
.pg-step-icon{color:var(--primary-gold);margin-right:.3rem}
.pg-step-name{color:var(--primary-blue);font-family:Consolas,Menlo,monospace;font-weight:600;margin-right:.4rem}
.pg-step-args{color:var(--text-muted);font-family:Consolas,Menlo,monospace;word-break:break-all}
.pg-step-result{min-width:0}
.pg-step-out-head{color:var(--text-muted);cursor:pointer;font-size:.75rem;display:flex;align-items:center;gap:.35rem;min-width:0}
.pg-step-out-head:hover{color:var(--primary-blue)}
.pg-step-out-head .fa-caret-down,.pg-step-out-head .fa-caret-right{color:var(--primary-gold);flex-shrink:0}
.pg-step-out-head span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pg-step-err-line{color:#e67e22}
.pg-step-ok-line{color:var(--text-muted)}
.pg-step-out{background:var(--bg-base);color:var(--text-muted);border-radius:6px;padding:.35rem .5rem;font-size:.72rem;white-space:pre-wrap;word-break:break-all;max-height:180px;overflow-y:auto;margin:.25rem 0 0}
.pg-step-out.err{color:#e67e22}
.pg-step-note{color:var(--text-muted)}

/* ← Edit 文件差异块 */
.pg-edit-diff{margin:.3rem 0 0;border:1px solid var(--border-light);border-radius:8px;overflow:hidden;font-size:.72rem}
.pg-edit-head{display:flex;align-items:center;gap:.4rem;padding:.3rem .55rem;background:var(--bg-base);color:var(--primary-blue);font-family:Consolas,Menlo,monospace;font-weight:600;border-bottom:1px solid var(--border-light);cursor:pointer;user-select:none;min-width:0}
.pg-edit-head:hover{background:var(--accent-pink)}
.pg-edit-head.err{color:#c0392b}
.pg-edit-arrow{color:var(--primary-gold);flex-shrink:0}
.pg-edit-head.err .pg-edit-arrow,.pg-edit-head.err .pg-edit-x,.pg-edit-head.err .pg-edit-caret{color:#c0392b}
.pg-edit-x{flex-shrink:0}
.pg-edit-path{color:inherit;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pg-edit-caret{margin-left:auto;flex-shrink:0;color:var(--primary-gold);font-size:.7rem}
.pg-edit-tag-new,.pg-edit-tag-edit{font-size:.62rem;font-weight:500;border-radius:5px;padding:.02rem .35rem;font-family:inherit;flex-shrink:0}
.pg-edit-tag-new{color:#27ae60;background:#27ae6018;border:1px solid #27ae60}
.pg-edit-tag-edit{color:#e67e22;background:#e67e2218;border:1px solid #e67e22}
.pg-edit-lines{max-height:260px;overflow-y:auto;background:var(--bg-base)}
.pg-edit-line{display:flex;align-items:flex-start;line-height:1.5}
.pg-edit-line.gap{justify-content:flex-start}
.pg-edit-gap{color:var(--text-muted);opacity:.85;font-style:italic;padding:.1rem 0 .1rem .55rem;font-family:inherit;user-select:none}
.pg-edit-err{margin:.3rem .55rem .35rem;border:1px solid #c0392b33}
.pg-edit-line.add{background:#27ae6014}
.pg-edit-line.del{background:#c0392b14}
.pg-edit-line.ctx:hover{background:var(--accent-pink)}
.pg-edit-line.add:hover{background:#27ae6022}
.pg-edit-line.del:hover{background:#c0392b22}
.pg-edit-no{flex-shrink:0;min-width:2.6rem;text-align:right;padding-right:.55rem;color:var(--text-muted);opacity:.75;user-select:none;font-variant-numeric:tabular-nums}
.pg-edit-mark{flex-shrink:0;width:1rem;color:var(--text-muted);user-select:none;text-align:center}
.pg-edit-line.add .pg-edit-mark{color:#27ae60}
.pg-edit-line.del .pg-edit-mark{color:#c0392b}
.pg-edit-text{flex:1;white-space:pre-wrap;word-break:break-all;color:var(--text-dark);font-family:Consolas,Menlo,monospace}
.pg-edit-line.add .pg-edit-text{color:#2a9d5f}
.pg-edit-line.del .pg-edit-text{color:#c0392b;text-decoration:line-through;text-decoration-thickness:.5px}
.pg-edit-line.ctx .pg-edit-text{color:var(--text-muted)}

.pg-error{color:#721c24;background:#f8d7da;border-radius:10px;margin:.6rem 1rem;padding:.55rem .9rem;font-size:.85rem;flex-shrink:0;word-break:break-all;display:flex;justify-content:space-between;align-items:center;gap:.6rem}

/* 附件缩略图 */
.pg-attachments{gap:.5rem;padding:.5rem 1rem 0;display:flex;flex-wrap:wrap;flex-shrink:0}
.pg-attach-item{position:relative}
.pg-attach-item img{border:2px solid var(--border-light);object-fit:cover;width:56px;height:56px;border-radius:8px;display:block}
.pg-attach-del{color:#fff;background:#0009;border:none;cursor:pointer;border-radius:50%;width:18px;height:18px;font-size:.6rem;position:absolute;top:-5px;right:-5px;display:flex;align-items:center;justify-content:center}

.pg-input-row{position:relative;border-top:1px solid var(--border-light);align-items:flex-end;gap:.6rem;padding:.8rem 1rem;display:flex;flex-shrink:0}
.pg-input-actions{display:flex;flex-direction:column;gap:.4rem;flex-shrink:0}
.pg-upload{flex-shrink:0}
.pg-input-row textarea{flex:1;border:2px solid var(--border-light);background:var(--bg-card);color:var(--text-dark);border-radius:12px;padding:.6rem .8rem;font-family:inherit;font-size:.92rem;resize:vertical;min-height:64px;max-height:45vh;outline:none}
.pg-cmdbox{position:absolute;bottom:calc(100% - .2rem);left:3.4rem;right:4.2rem;z-index:30;background:var(--bg-card-solid);border:1px solid var(--border-light);border-radius:12px;box-shadow:var(--shadow-dropdown);overflow:hidden;display:flex;flex-direction:column}
.pg-cmd-item{display:flex;align-items:baseline;gap:.7rem;border:none;background:transparent;text-align:left;cursor:pointer;padding:.45rem .8rem;color:var(--text-dark)}
.pg-cmd-item code{color:var(--primary-gold);font-family:Consolas,Menlo,monospace;font-weight:600;white-space:nowrap}
.pg-cmd-item span{color:var(--text-muted);font-size:.78rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pg-cmd-item.active{background:var(--accent-pink)}
.pg-cmd-hint{border-top:1px dashed var(--border-light);color:var(--text-muted);font-size:.7rem;padding:.3rem .8rem}
.pg-input-row textarea:focus{border-color:var(--primary-gold)}
.pg-send{border:none;color:#fff;background:var(--primary-blue);cursor:pointer;border-radius:10px;justify-content:center;align-items:center;width:44px;height:44px;font-size:1rem;flex-shrink:0;display:flex;transition:background .2s}
.pg-send:hover{background:var(--primary-gold)}
.pg-send:disabled{opacity:.5;cursor:not-allowed}
.pg-send.stop{background:#c0392b}
.pg-fade-enter-active,.pg-fade-leave-active{transition:opacity .2s}
.pg-fade-enter-from,.pg-fade-leave-to{opacity:0}
.pg-expand-enter-active,.pg-expand-leave-active{transition:max-height .25s ease, opacity .2s; overflow:hidden}
.pg-expand-enter-from,.pg-expand-leave-to{max-height:0;opacity:0}
.pg-expand-enter-to,.pg-expand-leave-from{max-height:400px;opacity:1}
.pg-side-group-body{overflow:hidden}

/* 模型选择/模型池弹窗 */
.pg-picker-overlay{z-index:1400}
.pg-picker{background:var(--bg-card-solid);width:100%;max-width:560px;max-height:76vh;box-shadow:var(--shadow-dropdown);border-radius:16px;flex-direction:column;display:flex;overflow:hidden}
.pg-picker-head{border-bottom:1px solid var(--border-light);justify-content:space-between;align-items:center;padding:.7rem 1rem;display:flex;color:var(--primary-blue);font-weight:600}
.pg-picker-search{border-bottom:1px solid var(--border-light);align-items:center;gap:.5rem;padding:.6rem 1rem;display:flex}
.pg-picker-group-head{padding:.45rem 1rem .35rem;font-size:.75rem;font-weight:600;color:var(--primary-gold);background:var(--accent-pink);border-bottom:1px solid var(--border-light);position:sticky;top:0;z-index:1}
.pg-picker-group-head:first-child{border-top:none}
.pg-picker-search input{flex:1;border:none;outline:none;background:transparent;color:var(--text-dark);font-family:inherit}
.pg-picker-search i{color:var(--text-muted)}
.pg-picker-list{flex:1;overflow-y:auto;padding:.5rem}
.pg-picker-item{border:1px solid var(--border-light);border-radius:10px;padding:.55rem .8rem;margin-bottom:.45rem;cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:.6rem;transition:border-color .15s}
.pg-picker-item:hover{border-color:var(--primary-gold)}
.pg-picker-item.active{border-color:var(--primary-blue);background:var(--accent-pink)}
.pg-picker-item.highlighted{border-color:var(--primary-gold);box-shadow:0 0 0 1px var(--primary-gold)}
.pg-picker-main{display:flex;flex-direction:column;min-width:0}
.pg-picker-name{color:var(--text-dark);font-size:.9rem;font-weight:500}
.pg-picker-id{color:var(--text-muted);font-size:.72rem;font-family:Consolas,Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ai-badge{display:inline-block;border-radius:10px;padding:.12rem .55rem;font-size:.75rem;white-space:nowrap;flex-shrink:0}
.badge-ok{color:#fff;background:#27ae60}
.badge-error{color:#fff;background:#c0392b}
.badge-untested{color:var(--text-muted);background:var(--accent-pink)}

/* 模型池 */
.pg-pool-tip{border-bottom:1px solid var(--border-light);padding:.6rem 1rem;display:flex;align-items:center;gap:.7rem;flex-wrap:wrap}
.pg-pool-tip-text{color:var(--text-muted);font-size:.75rem}
.pg-pool-item{cursor:pointer}
.pg-pool-item:hover{border-color:var(--primary-gold)}
.pg-pool-item.selected{border-color:var(--primary-gold);background:var(--accent-pink);box-shadow:0 0 0 1px var(--primary-gold)}
.pg-pool-idx{color:var(--primary-gold);font-weight:700;font-size:.85rem;width:1.2rem;text-align:center;flex-shrink:0}
.pg-pool-check{color:var(--primary-gold);flex-shrink:0}
.pg-pool-seq{border-bottom:1px solid var(--border-light);padding:.45rem 1rem;display:flex;align-items:center;gap:.4rem;flex-wrap:wrap;font-size:.75rem;color:var(--text-muted)}
.pg-pool-seq i{color:var(--primary-gold)}
.pg-pool-seq-item{color:var(--primary-blue);font-weight:500;background:var(--accent-pink);border-radius:10px;padding:.12rem .5rem;white-space:nowrap;font-size:.72rem}

/* 审批弹窗 */
.pg-approval-overlay{z-index:1500}
.pg-approval{background:var(--bg-card-solid);width:100%;max-width:520px;border-radius:16px;border:2px solid;overflow:hidden;box-shadow:var(--shadow-dropdown)}
.pg-approval.level-orange{border-color:#e67e22}
.pg-approval.level-red{border-color:#c0392b;box-shadow:0 0 0 4px #c0392b33, var(--shadow-dropdown)}
.pg-approval-head{padding:.7rem 1rem;font-weight:600;display:flex;align-items:center;gap:.5rem;color:#fff;background:#e67e22}
.pg-approval.level-red .pg-approval-head{background:#c0392b}
.pg-approval-body{padding:1rem}
.pg-approval-reason{color:var(--text-dark);font-size:.95rem;margin-bottom:.6rem}
.pg-approval-tool{color:var(--text-muted);font-size:.85rem;margin-bottom:.5rem}
.pg-approval-tool code{background:var(--accent-pink);padding:.1rem .4rem;border-radius:6px}
.pg-approval-args{background:var(--bg-base);color:var(--text-muted);border-radius:8px;padding:.6rem;font-size:.75rem;white-space:pre-wrap;word-break:break-all;max-height:180px;overflow-y:auto;margin:0;font-family:Consolas,Menlo,monospace}
.pg-approval-actions{padding:0 1rem 1rem;display:flex;gap:.8rem;justify-content:flex-end}
.pg-approval-bypass{font-size:.75rem;font-weight:400;opacity:.85}
.btn-danger{color:#fff;background:#c0392b;border:none;border-radius:12px;padding:.6rem 1.2rem;font-family:inherit;cursor:pointer}

/* 运行状态栏 */
.pg-statsbar{border-top:1px solid var(--border-light);padding:.35rem .9rem;display:flex;align-items:center;gap:1rem;flex-shrink:0;flex-wrap:wrap;font-size:.75rem;color:var(--text-muted)}
.pg-statsbar .btn{margin-left:auto}
.pg-stat{display:inline-flex;align-items:center;gap:.3rem;font-family:Consolas,Menlo,monospace}
.pg-stat i,.pg-stat-ind i{color:var(--primary-gold)}
.pg-stat-ind{display:inline-flex;align-items:center;gap:.35rem}
.pg-stat-dot{width:9px;height:9px;border-radius:50%;display:inline-block;background:var(--text-muted)}
.st-running .pg-stat-dot{background:#27ae60;box-shadow:0 0 6px #27ae60}
.st-stuck .pg-stat-dot{background:#f1c40f;box-shadow:0 0 6px #f1c40f}
.st-done .pg-stat-dot{background:#c0392b;box-shadow:0 0 4px #c0392b}
.pg-stat-ind.st-running .pg-stat-dot{animation:pg-blink 1s steps(2) infinite}

/* 帮助菜单 */
.pg-help{max-width:640px}
.pg-help-body{flex:1;overflow-y:auto;padding:.8rem 1rem 1.2rem}
.pg-help-body h4{color:var(--primary-blue);margin:.6rem 0 .4rem;font-size:.92rem}
.pg-help-body h4:first-child{margin-top:.2rem}
.pg-help-body h4 i{margin-right:.4rem;color:var(--primary-gold)}
.pg-help-tbl{width:100%;border-collapse:collapse}
.pg-help-tbl td{border-bottom:1px dashed var(--border-light);padding:.4rem .4rem;font-size:.8rem;vertical-align:top}
.pg-help-tbl td:first-child{white-space:nowrap;color:var(--primary-gold);font-family:Consolas,Menlo,monospace;font-weight:600;padding-right:1rem}
.pg-help-tbl tr:hover td{color:var(--text-dark)}

/* 移动端适配 */
@media (max-width: 640px){
  .pg-overlay{padding:0}
  .pg-modal{max-width:none;width:100vw;height:100dvh;border-radius:0}
  .pg-header{padding:.5rem}
  .pg-header-actions{gap:.25rem}
  .pg-header-actions .btn{padding:.35rem .5rem;font-size:.78rem}
  .pg-bubble{max-width:94%}
  .pg-sub-chat{max-width:100%}
  .pg-ctx{margin-left:0}
}

/* 窄屏：左栏变为覆盖式抽屉（header ☰ 按钮开合） */
@media (max-width: 900px){
  .pg-shell{gap:0}
  .pg-side{position:absolute;top:0;bottom:0;left:0;width:min(300px,86vw);height:auto;z-index:30;box-shadow:var(--shadow-dropdown)}
}
</style>
