<template>
  <div
    class="chat-page"
    :class="{ immersive, dragging, 'rail-open': railOpen, 'dock-open': dockOpen }"
    :style="railStyle"
    @click="menu = null; titleMenu = false"
    @dragenter.prevent="onDragEnter"
    @dragover.prevent="onDragOver"
    @dragleave.prevent="onDragLeave"
    @drop.prevent="onDrop"
  >
    <div v-if="railOpen || dockOpen" class="drawer-mask" @click="closeDrawers"></div>
    <ChatRail
      :projects="store.state.projects"
      :chats="store.state.chats"
      :hosts="remote.state.hosts"
      :active-chat-id="store.state.chatId"
      :busy-ids="busyChatIds"
      :rail-w="railW"
      @new-project="onNewProject"
      @new-chat="onNewChat"
      @select-chat="openChat"
      @toggle-project="onToggleProject"
      @toggle-host="remote.toggle"
      @new-host="openHostModal(null)"
      @remove-host="onRemoveHost"
      @open-settings="$router.push('/settings')"
      @open-recycle="recycleOpen = true"
      @remove-project="onRemoveProject"
      @remove-chat="onRemoveChat"
      @reorder="onReorder"
      @menu="onMenu"
    />
    <div class="resizer" title="拖动调宽" @mousedown.prevent="startDrag('rail')"></div>

    <section class="main">
      <!-- 顶栏 = 母本 ai/MESSAGE_BOX/聊天框顶栏与消息框.html 的 .ef-chat-head：
           左侧两道穿框的青色竖条 + 幽灵线稿 + 会话名，底部一条双色 strip，右端一整簇装饰。
           装饰件（__bar/__ghost/__strip/__deco 与里面两张 svg）逐字搬母本 body 第 73–109 行。 -->
      <header ref="titlebarEl" class="titlebar" :class="{ 'ef-chat-head': ef }">
        <template v-if="ef">
          <i class="ef-chat-head__bar ef-chat-head__bar--1"></i><i class="ef-chat-head__bar ef-chat-head__bar--2"></i>
          <svg class="ef-chat-head__ghost" viewBox="0 0 330 90" fill="none" stroke="#505050" stroke-width="1.3" aria-hidden="true">
            <path d="M18 3L96 49M33 53H84M12 16L56 44"/><path d="M122 24V34H195V6M205 3V53H262V33H224"/><path d="M290 8L298 16L294 22V53H322M300 3L312 3"/>
          </svg>
        </template>
        <div ref="titleEl" class="title" :class="{ 'ef-chat-head__name': ef }">
          <template v-if="store.activeProject.value">
            <span class="muted">{{ store.activeProject.value.name }} / </span>
          </template>
          <span>{{ store.chatTitle.value }}</span>
          <button class="icon-btn more" type="button" title="会话菜单" @click.stop="titleMenu = !titleMenu">
            <i class="fas fa-ellipsis"></i>
          </button>
          <div v-if="titleMenu" class="title-menu" @click.stop>
            <button type="button" @click="menuPinCurrent"><i class="fas fa-thumbtack"></i> 置顶对话</button>
            <button type="button" @click="menuRenameCurrent"><i class="fas fa-pen"></i> 重命名对话</button>
            <button type="button" @click="menuExportChat('md')"><i class="fas fa-file-export"></i> 导出 Markdown</button>
            <button type="button" @click="ctxDialog = true"><i class="fas fa-arrows-rotate"></i> 上下文导入 / 导出…</button>
            <button type="button" class="danger" @click="menuDeleteCurrent"><i class="fas fa-trash"></i> 删除对话</button>
          </div>
          <span v-if="store.state.cwd" class="cwd muted" :title="store.state.cwd"> · {{ store.state.cwd }}</span>
        </div>
        <template v-if="ef">
          <i class="ef-chat-head__strip"></i>
          <div class="ef-chat-head__deco" aria-hidden="true">
          <i class="ef-chat-head__cell" style="left:0;top:0;width:calc(var(--u)*32);height:calc(var(--u)*33)"></i>
          <i class="ef-chat-head__cell" style="left:0;top:calc(var(--u)*66);width:calc(var(--u)*32);height:calc(var(--u)*33)"></i>
          <i class="ef-chat-head__cell" style="left:calc(var(--u)*32);top:calc(var(--u)*33);width:calc(var(--u)*31.5);height:calc(var(--u)*33)"></i>
          <div class="ef-chat-head__field">
            <svg viewBox="0 0 481 91" preserveAspectRatio="none">
              <defs><pattern id="efHeadDp" width="26.7" height="26.2" patternUnits="userSpaceOnUse" x="191.65" y="14.4"><circle cx="13.35" cy="13.1" r="2.1" fill="#2a98b8"/></pattern></defs>
              <rect x="191.65" y="14.4" width="240" height="78.6" fill="url(#efHeadDp)"/>
              <g fill="#1993fd"><rect x="139" y="0" width="12" height="49"/><rect x="139" y="0" width="51" height="9"/></g>
              <path d="M143.5 5L186 47" stroke="#1993fd" stroke-width="12.5" fill="none"/>
              <circle cx="326.5" cy="94" r="35" fill="#3a3a3a"/><circle cx="326.5" cy="34" r="28" fill="#3a3a3a"/>
              <g fill="#19cffd"><rect x="288" y="63.5" width="76" height="2.6"/><rect x="288" y="70" width="76" height="3"/><rect x="288" y="82.5" width="76" height="3"/></g>
              <circle cx="394.8" cy="89.3" r="31" fill="none" stroke="#3a3a3a" stroke-width="5"/>
              <circle cx="393" cy="35" r="28.5" fill="none" stroke="#3a3a3a" stroke-width="5"/><circle cx="393" cy="35" r="20.5" fill="#3a3a3a"/>
            </svg>
          </div>
          <i class="ef-chat-head__stripe" style="left:calc(var(--u)*506);width:calc(var(--u)*2)"></i>
          <i class="ef-chat-head__stripe" style="left:calc(var(--u)*515);width:calc(var(--u)*4)"></i>
          <i class="ef-chat-head__stripe" style="left:calc(var(--u)*525);width:calc(var(--u)*4)"></i>
          <i class="ef-chat-head__stripe" style="left:calc(var(--u)*535);width:calc(var(--u)*7)"></i>
          <div class="ef-chat-head__tail">
            <svg viewBox="0 0 136 91" preserveAspectRatio="none" stroke="#3c3c3c" stroke-width="1.5" fill="none">
              <path d="M30.5 5.5h11M36 0v11M30.5 87.5h11M36 82v11"/>
              <g stroke="none" fill="#3c3c3c"><rect x="64.5" y="26" width="28.5" height="4.5"/><rect x="64.5" y="78" width="28.5" height="4" fill="#5a5c5c"/>
              <rect x="64.5" y="33.5" width="28.5" height="1.8" opacity=".85"/><rect x="64.5" y="37.4" width="28.5" height="1.8" opacity=".78"/><rect x="64.5" y="41.3" width="28.5" height="1.8" opacity=".7"/>
              <rect x="64.5" y="45.2" width="28.5" height="1.8" opacity=".62"/><rect x="64.5" y="49.1" width="28.5" height="1.8" opacity=".54"/><rect x="64.5" y="53" width="28.5" height="1.8" opacity=".46"/>
              <rect x="64.5" y="56.9" width="28.5" height="1.8" opacity=".38"/><rect x="64.5" y="60.8" width="28.5" height="1.8" opacity=".3"/><rect x="64.5" y="64.7" width="28.5" height="1.8" opacity=".22"/><rect x="64.5" y="68.6" width="28.5" height="1.8" opacity=".15"/></g>
            </svg>
          </div>
        </div>
        </template>
        <div
          ref="titleActionsEl"
          class="title-actions"
          :class="{ tight: barTight, expanded: barOpen }"
        >
          <button class="icon-btn narrow-only" type="button" title="会话栏" @click.stop="toggleDrawer('rail')">
            <i class="fas fa-bars-staggered"></i>
          </button>
          <button class="toggle-btn" :class="{ on: store.state.agentMode }" type="button" title="Agent" @click="store.setModeFlag('agentMode', !store.state.agentMode)">
            <i class="fas fa-screwdriver-wrench"></i><span>Agent</span>
          </button>
          <!-- 除 Agent 外其余开关平时折在这里：只有把鼠标送到最右那颗 ">" 上方那一小圈才展开 -->
          <div class="ta-fold">
            <div class="ta-fold-in">
              <button class="toggle-btn" :class="{ on: store.state.planMode }" type="button" title="Plan" @click="store.setModeFlag('planMode', !store.state.planMode)">
                <i class="fas fa-list-check"></i><span>Plan</span>
              </button>
              <button class="toggle-btn" :class="{ on: store.state.readonlyMode }" type="button" title="只读" @click="store.setModeFlag('readonlyMode', !store.state.readonlyMode)">
                <i class="fas fa-eye"></i><span>只读</span>
              </button>
              <button
                class="toggle-btn"
                :class="{ on: sbState.open }"
                type="button"
                title="侧栏提问：只读的旁路助手，主 Agent 干活时也能问（打开会暂时替掉右侧面板）"
                @click="sb.toggle()"
              >
                <i class="fas fa-comment-dots"></i><span>提问</span>
              </button>
              <button class="toggle-btn" :class="{ on: immersive }" type="button" title="沉浸模式" @click="immersive = !immersive">
                <i class="fas" :class="immersive ? 'fa-compress' : 'fa-expand'"></i><span>沉浸</span>
              </button>
            </div>
          </div>
          <button class="icon-btn narrow-only" type="button" title="侧栏面板" @click.stop="toggleDrawer('dock')">
            <i class="fas fa-panel-right"></i>
          </button>
          <!-- 手机审批/回答桥：末位常驻开关（不折进 ta-fold）。开着 = 手机能批准/回答/继续 -->
          <button
            class="toggle-btn"
            :class="{ on: lanbridgeOn }"
            type="button"
            :title="lanbridgeOn ? (lanbridgeConnected ? '手机审批桥已连接，手机可批准/回答/继续' : '手机审批桥已开启，等待手机连接…') : '手机审批桥（局域网内用手机批准 AI 操作、回答提问）'"
            @click="toggleLanbridge"
          >
            <i class="fas" :class="lanbridgeOn ? (lanbridgeConnected ? 'fa-mobile-screen-button' : 'fa-mobile-screen') : 'fa-mobile-screen'"></i><span>手机</span>
          </button>
          <!-- 热区用「padding + 等量负 margin」撑出来：命中范围比按钮大一圈，
               但布局盒和原来一样大，不会把右边距撑开。按钮本身还是它自己的孩子，照常可点。 -->
          <span class="ta-hot" @mouseenter="expandToggles">
            <button
              class="ta-expand"
              type="button"
              :title="barOpen ? '这些开关平时是收起来的，鼠标离开顶栏就收起' : '悬停展开：Plan / 只读 / 提问 / 沉浸'"
              @click="barOpen = !barOpen"
            >
              <i class="fas fa-chevron-right"></i>
            </button>
          </span>
        </div>
      </header>

      <div class="stream-wrap">
        <JumpRail :messages="store.state.messages" @goto="gotoMsg" />
        <div ref="streamEl" class="stream" @scroll.passive="onStreamScroll">
        <div v-if="!store.state.messages.length" class="empty">
          <h2>开始对话</h2>
          <p class="muted">还没有会话哦QwQ，请在左侧栏选择项目/会话或输入要求开始新的会话！</p>
        </div>
        <button
          v-if="hiddenCount > 0"
          class="k-btn sm ghost"
          type="button"
          style="margin: 0 auto 12px; display: flex"
          @click="openHistory"
        >
          <i class="fas fa-clock-rotate-left"></i> 展开更早 {{ Math.min(HISTORY_STEP, hiddenCount) }} 条
        </button>
        <button
          v-if="revealed > 0"
          class="k-btn sm ghost"
          type="button"
          style="margin: 0 auto 12px; display: flex"
          @click="collapseHistory"
        >
          收起历史
        </button>
        <TransitionGroup name="msg" tag="div" class="stream-inner">
          <ChatMessage
            v-for="(m, i) in visibleMessages"
            :id="'msg-' + (m.id ?? i)"
            :key="m.id || i"
            :role="m.role"
            :content="m.content"
            :cwd="store.state.cwd"
            :remote="!!activeRemoteHost"
            :reasoning="m.reasoning"
            :steps="m.steps"
            :timeline="m.timeline"
            :usage="m.usage"
            :model_name="m.model_name"
            :speaker="m.speaker"
            :index="i"
            :msg-id="m.id"
            :busy="store.state.busy && i === visibleMessages.length - 1"
            :can-retract="m.role === 'user' && !!m.id && store.state.chatId"
            :class="{ 'trace-flash': m.id && m.id === flashMsgId }"
            @undo="onUndo"
            @retract="onRetract"
            @revert-from="onRevertFrom"
            @open-subagent="openAgentSteps"
            @review="(s) => { reviewStep = s; }"
          />
        </TransitionGroup>
        </div>
      </div>

      <!-- 状态条只留「在不在跑」：速率、首字、上下文与「提供商 / 模型 ID」都在输入框上方那条信息横条里，
           这里再抄一遍只会跟着一堆数字一起抖 -->
      <div class="run-status" :class="runState.cls">
        <span class="dot"></span>
        <span>{{ runState.text }}</span>
        <button v-if="showDown" class="k-btn sm down-btn" type="button" title="回到底部" @click="scrollBottomAnimated()">
          <i class="fas fa-arrow-down"></i>
        </button>
      </div>

      <div v-if="store.state.insertItems.length || store.state.loadedSkills.length" class="safe-strip">
        <span v-if="store.state.insertItems.length" class="chip" title="下一次工具返回结果时插入">
          <i class="fas fa-arrow-down-to-line"></i>
          待注入 {{ store.state.insertItems.length }} 条
          <button type="button" class="x" @click="store.clearInserts">×</button>
        </span>
        <span v-if="store.state.loadedSkills.length" class="chip">
          <i class="fas fa-book-open"></i>
          已加载 {{ store.state.loadedSkills.length }} 个 skills
          <button type="button" class="x" @click="skillsPickerOpen">改</button>
        </span>
      </div>

      <div v-if="lastUnfinished || store.state.runningCmd" class="gen-actions">
        <button v-if="lastUnfinished" class="k-btn sm" type="button" @click="onContinue">
          <i class="fas fa-forward"></i> 继续生成
        </button>
        <button
          v-if="store.state.runningCmd"
          class="k-btn sm warn"
          type="button"
          title="只终止这条命令，会话继续"
          @click="onToolTimeout"
        >
          <i class="fas fa-hourglass-end"></i> 判定超时 {{ cmdElapsed }}
        </button>
        <code v-if="store.state.runningCmd" class="cmd-hint" :title="store.state.runningCmd.command">
          $ {{ store.state.runningCmd.command }}
        </code>
      </div>

      <div v-if="lastError" class="err-bar">
        <i class="fas fa-circle-exclamation"></i>
        <span class="err-text">{{ lastError }}</span>
        <button class="k-btn sm" type="button" title="复制完整报错（时间 / 页面 / 概括 / 详情 / 最近日志）" @click="copyLastError">复制详情</button>
        <button class="k-btn sm" type="button" :title="lastFailedMsg?.retryExhausted ? '自动重试已用尽：撤回本轮并按原文重发' : '撤回本轮并按原文重发'" @click="onRetryLast">
          {{ lastFailedMsg?.retryExhausted ? '重试' : '撤回重发' }}
        </button>
        <button class="k-btn sm ghost" type="button" @click="dismissError">忽略</button>
      </div>

      <ChatComposer
        v-model="store.state.draft"
        :busy="store.state.busy"
        :cwd="store.state.cwd"
        :chat-id="store.state.chatId || null"
        :model-name="store.modelName.value"
        :models="composerModels"
        :current-model-id="store.currentModel.value?.id"
        :thinking-level="store.state.thinkingLevel"
        :thinking-levels="thinkingLevels"
        :git-branch="gitBranch"
        :git-branches="gitBranches"
        :git-remote-branches="gitRemoteBranches"
        :git-dirty="gitDirty"
        :git-ahead="gitAhead"
        :git-behind="gitBehind"
        :git-enabled="gitOk"
        :approval-mode="store.state.approvalMode"
        :approval-explicit="store.state.approvalExplicit"
        :skills="skillList"
        :approvals="store.currentApprovals.value"
        :question="store.currentQuestion.value"
        :queue-length="store.queued.value.length"
        :context-used="store.state.contextUsed"
        :context-next="store.state.contextNext"
        :context-live="store.state.contextLive"
        :context-limit="store.state.contextLimit"
        :context-configured="store.state.contextConfigured"
        :first-token-ms="store.state.firstTokenMs"
        :tok-per-sec="store.state.tokPerSec"
        @send="onSend"
        @stop="store.stop"
        @cycle-model="cycleModel"
        @cycle-approval="cycleApproval"
        @select-model="selectModel"
        @set-approval="setApproval"
        @set-thinking="setThinking"
        @approve="onApprove"
        @answer="onAnswer"
        :attachments="attachments"
        @upload="onUpload"
        @files="uploadFiles"
        @remove-attach="removeAttach"
        @model-settings="modelSettingsOpen = true"
        @git-action="onGitAction"
        @clear-queue="onClearQueue"
      />
      <!-- 终端：自己 Teleport 到 body，收起时只剩页面底部一颗小胶囊，不占这里的布局 -->
      <TerminalDock />
    </section>

    <div class="resizer" title="拖动调宽" @mousedown.prevent="startDrag('dock')"></div>
    <!-- 侧栏提问打开时暂时替掉右侧面板：两者都是「主对话旁边的东西」，并排放太挤 -->
    <SidebarAI v-if="sbState.open" :models="sidebarModels" />
    <ChatDock
      v-else
      :tasks="store.state.tasks"
      :history="history"
      :files="files"
      :usage="store.state.usage"
      :cwd="store.state.cwd"
      :plan-mode="store.state.planMode"
      :agent-mode="store.state.agentMode"
      :readonly-mode="store.state.readonlyMode"
      :auto-mode="store.state.autoMode"
      :approval-mode="store.state.approvalMode"
      :model-name="store.modelName.value"
      :loaded-skills="store.state.loadedSkills"
      :insert-items="store.state.insertItems"
      :context-used="store.state.contextUsed"
      :context-next="store.state.contextNext"
      :context-live="store.state.contextLive"
      :context-limit="store.state.contextLimit"
      :context-configured="store.state.contextConfigured"
      :pressing="store.state.pressing"
      :lab-git="!!labFlags.gitPreview"
      :dock-w="dockW"
      @undo="onUndo"
      @update-task="onUpdateTask"
      @press="store.pressChat"
      @cancel-press="store.cancelPress"
      @set-context="store.setContext"
      @clear-insert="store.clearInserts"
      @remove-insert="store.removeInsert"
      @git-action="onGitAction"
      @open-agent="openAgentSteps"
      @review="(h) => { reviewStep = h; }"
    />

    <!-- 修改历史的「审阅」弹窗：消息流里的编辑卡和右栏那一行都开这一扇 -->
    <HistoryReviewModal
      :hist="reviewStep"
      @close="reviewStep = null"
      @undo="(h) => { reviewStep = null; onUndo(h.ref || h); }"
    />

    <!-- 子智能体的执行步骤：点消息流里那张卡或右栏那行都会开这一扇（只能看，没有输入框） -->
    <SubagentStepsModal
      :id="agentModal.id"
      :name="agentModal.name"
      :chat-id="store.state.chatId || null"
      @close="agentModal.id = ''"
    />

    <!-- 最右侧一栏：本机会话是内置浏览器；远程会话换成那台机器的文件快捷操作区（同一列二选一）。
         浏览器被独立成另一扇窗口时这一列整个不要 —— 侧栏留一条空壳既挡地方，
         又会和那扇窗抢同一个视图（AI 一动手它就自己弹开）。 -->
    <RemoteFiles v-if="activeRemoteHost" :key="activeRemoteHost.id" :host="activeRemoteHost" :cwd="store.state.cwd" />
    <BrowserPanel v-else-if="!browserStore.state.detached" />

    <!-- 模型选择 -->
    <ModelPicker
      :open="store.state.modelPicker"
      :models="pickerModels"
      :model-id="store.currentModel.value?.id"
      @close="store.state.modelPicker = false"
      @select="onPickModel"
      @pin="onPinModel"
    />

    <!-- 模型设置 -->
    <KModal :open="modelSettingsOpen" title="模型设置" board="panel" tall code="MODEL.SETTINGS" ghost="MODEL" width="520px" ef-width="1200" @close="modelSettingsOpen = false">
      <div class="form">
        <KInput v-model.number="modelForm.temperature" label="温度 (0–2)" type="number" block />
        <KInput v-model.number="modelForm.frequency_penalty" label="频率惩罚" type="number" block />
        <KInput v-model.number="modelForm.presence_penalty" label="存在惩罚" type="number" block />
        <label class="field">
          <span>思考强度</span>
          <input v-model="modelForm.thinkingLevel" class="nu-input" list="think-levels" placeholder="medium" />
          <datalist id="think-levels">
            <option value="auto"></option>
            <option value="off"></option>
            <option value="low"></option>
            <option value="medium"></option>
            <option value="high"></option>
            <option value="xhigh"></option>
            <option value="max"></option>
            <option v-for="lv in thinkingLevels" :key="lv" :value="lv"></option>
          </datalist>
        </label>
        <KInput v-model.number="modelForm.contextLimit" label="上下文窗口（token，0=不限）" type="number" block />
        <label class="field">
          <span>言论审查(每行一条)</span>
          <textarea v-model="modelForm.censoredWords" class="nu-textarea" rows="3"></textarea>
        </label>
        <p class="muted">{{ txt('chat.ctx.compressHint') }}</p>
      </div>
      <template #footer>
        <KButton variant="ghost" size="sm" @click="modelSettingsOpen = false">取消</KButton>
        <KButton variant="primary" size="sm" @click="saveModelParams">保存</KButton>
      </template>
    </KModal>

    <!-- 回收站 -->
    <KModal :open="recycleOpen" title="回收站" board="panel" tall code="RECYCLE.BOX" ghost="RECYCLE" width="560px" ef-width="1200" @close="recycleOpen = false">
      <p class="muted" style="margin-bottom:10px">
        会话与项目删除后会移动至此处，可手动恢复或彻底删除；注意：此处文件不会自动清理。
      </p>
      <div v-if="!recycleRows.length" class="muted">回收站为空</div>
      <div v-for="it in recycleRows" :key="it.key" class="recycle-row">
        <div class="grow">
          <div>
            {{ it.kind }} · {{ it.name }}
            <span v-if="it.detail" class="muted" style="font-size:11px"> · {{ it.detail }}</span>
            <span v-if="it.restored" class="num-pos"> · 已恢复</span>
          </div>
          <div class="muted" style="font-size:11px">{{ it.path || '' }}{{ it.path ? ' · ' : '' }}{{ it.at }}</div>
        </div>
        <button
          v-if="!it.restored && it.canRestore"
          class="k-btn sm ok"
          type="button"
          @click="restoreRow(it)"
        >恢复</button>
        <button
          v-else-if="!it.restored"
          class="k-btn sm ghost"
          type="button"
          disabled
          title="这条是旧记录：当时删除没有留下快照，内容已经找不回来了"
        >无法恢复</button>
        <button class="k-btn sm danger" type="button" @click="removeRow(it)">永久删除</button>
      </div>
      <template #footer>
        <KButton variant="ghost" @click="recycle.refresh()">刷新</KButton>
        <KButton variant="ghost" @click="recycleOpen = false">关闭</KButton>
        <KButton
          variant="danger"
          :disabled="!recycleRows.length"
          @click="clearRecycle"
        >清空回收站</KButton>
      </template>
    </KModal>

    <!-- 技能选择 -->
    <KModal :open="store.state.skillsPicker" title="加载技能到本会话" board="panel" tall code="SKILL.BOX" ghost="SKILL" width="560px" ef-width="1200" @close="store.state.skillsPicker = false">
      <div class="skill-list">
        <label v-for="s in skillList" :key="s.name" class="skill-item" :class="{ on: skillsChecked.includes(s.name) }">
          <input class="k-check" v-model="skillsChecked" type="checkbox" :value="s.name" />
          <div>
            <div class="skill-name">{{ s.name }}</div>
            <div class="skill-desc">{{ s.description || s.title || '' }}</div>
          </div>
        </label>
        <p v-if="!skillList.length" class="muted">暂无可用技能，可在设置导入。</p>
      </div>
      <template #footer>
        <KButton variant="ghost" @click="skillsChecked = skillList.map((s) => s.name)">全选</KButton>
        <KButton variant="ghost" @click="skillsChecked = []">清空</KButton>
        <KButton variant="primary" @click="applySkills">应用</KButton>
      </template>
    </KModal>

    <!-- 新建项目（remote_id 非空时是「新建远端项目」，路径填远端绝对路径） -->
    <KModal :open="projModal" :title="projTitle" width="480px" tall @close="projModal = false">
      <div class="form">
        <KInput v-model="projForm.name" label="项目名称" block placeholder="例如：my-project" />
        <div class="path-row">
          <KInput
            v-model="projForm.root_path"
            :label="projForm.remote_id ? '远端目录（绝对路径）' : '项目根目录（绝对路径）'"
            block
            :placeholder="projForm.remote_id ? '/srv/app' : 'D:\\projects\\foo'"
          />
          <!-- 桌面端才给这颗键：系统目录选择框必须由主进程弹（网页模式没这能力，藏掉比摆一颗死键好）。
               远端项目也藏掉：选的是本机目录，填到远端路径上是错的。 -->
          <button
            v-if="canPickDir && !projForm.remote_id"
            class="k-btn ghost sm pick-dir"
            type="button"
            title="在窗口里选一个文件夹"
            @click="pickProjectDir"
          ><i class="fas fa-folder-open"></i> 浏览…</button>
        </div>
        <div v-if="projForm.remote_id" class="muted hint-line">
          <i class="fas fa-server"></i>
          建在 {{ projHost ? `${projHost.name}（${projHost.username}@${projHost.host}）` : '所选连接' }} 上；
          该目录及之后的读写、命令都通过 SSH/SFTP 在这台机器上执行，创建时后端会真的去远端确认它存在。
        </div>
        <!-- 编辑态要把话说在前面：这里改的只是库里的两个字段，磁盘上一个文件都不会被动 -->
        <div v-else-if="projForm.editingId" class="muted hint-line">
          <i class="fas fa-hard-drive"></i>
          改名与改目录都只改记录，<b>不会重命名、移动或创建任何文件/目录</b>；
          换目录后，落在新目录之外的会话工作目录会被重置为新目录（保存后会说明条数）。
        </div>
      </div>
      <template #footer>
        <KButton variant="ghost" size="sm" @click="projModal = false">取消</KButton>
        <KButton variant="primary" size="sm" @click="submitProject">{{ projForm.editingId ? '保存' : '创建' }}</KButton>
      </template>
    </KModal>

    <!-- 会话右键「设置工作目录」：自由会话的目录出口（以前只有 /dir 一条命令） -->
    <KModal :open="cwdModal" title="设置工作目录" width="480px" tall @close="cwdModal = false">
      <div class="form">
        <div class="muted hint-line">会话：{{ cwdForm.title }}</div>
        <div class="path-row">
          <KInput
            v-model="cwdForm.path"
            :label="cwdForm.remote_id ? '远端目录（绝对路径）' : '工作目录（绝对路径）'"
            block
            :placeholder="cwdForm.remote_id ? '/srv/app' : 'D:\\work\\foo'"
          />
          <button
            v-if="canPickDir && !cwdForm.remote_id"
            class="k-btn ghost sm pick-dir"
            type="button"
            title="在窗口里选一个文件夹"
            @click="pickCwdDir"
          ><i class="fas fa-folder-open"></i> 浏览…</button>
        </div>
        <div class="muted hint-line">
          <i class="fas fa-info-circle"></i>
          这一条会话之后所有工具执行都以此为准，改了不会被发消息或重启改回去。
        </div>
      </div>
      <template #footer>
        <KButton variant="ghost" size="sm" @click="cwdModal = false">取消</KButton>
        <KButton variant="primary" size="sm" @click="submitCwd">确认</KButton>
      </template>
    </KModal>

    <!-- 新建会话 -->
    <KModal :open="chatModal" title="新建会话" width="480px" tall @close="chatModal = false">
      <div class="form">
        <KInput v-model="chatForm.title" label="会话名称" block placeholder="新会话" />
        <label class="field">
          <span>依附于项目……</span>
          <KDropdown :items="projectItems" :label="chatProjectLabel" block width="100%" @change="pickChatProject" />
        </label>
      </div>
      <template #footer>
        <KButton variant="ghost" size="sm" @click="chatModal = false">取消</KButton>
        <KButton variant="primary" size="sm" @click="submitChat">创建</KButton>
      </template>
    </KModal>

    <!-- SSH 连接：新建 / 编辑 / 测试 -->
    <RemoteHostModal :open="hostModal" :host="hostEditing" @close="hostModal = false" />

    <!-- 模型池 -->
    <KModal :open="store.state.poolPicker" title="模型池（先点优先）" width="560px" tall @close="store.state.poolPicker = false">
      <div class="pool-list">
        <button
          v-for="(m, i) in store.state.models"
          :key="m.id"
          class="pool-item"
          :class="{ selected: poolOrder.includes(m.id) }"
          type="button"
          @click="togglePool(m.id)"
        >
          <span class="idx">{{ poolPos(m.id) }}</span>
          <span>{{ m.display_name || m.model_id }}</span>
          <i v-if="poolOrder.includes(m.id)" class="fas fa-circle-check"></i>
        </button>
      </div>
      <template #footer>
        <KButton variant="ghost" @click="poolOrder = []">重置</KButton>
        <KButton variant="primary" @click="applyPool">应用</KButton>
      </template>
    </KModal>
    <!-- 首次启动选 Shell -->
    <KModal :open="shellOpen" title="选择命令执行用的 Shell" width="480px" tall @close="skipShell">
      <p class="muted">Agent 跑命令（run_command / 后台任务）会用这个 Shell。没装的就点不了，之后也能在「设置 → 常规」改。</p>
      <div class="shell-list">
        <button
          v-for="c in shellChoices"
          :key="c.value"
          class="shell-item"
          type="button"
          :disabled="c.missing"
          @click="pickShell(c.value)"
        >
          <span>{{ c.label }}</span>
          <i class="fas" :class="c.missing ? 'fa-ban' : 'fa-check'"></i>
        </button>
      </div>
      <template #footer>
        <KButton variant="ghost" size="sm" @click="skipShell">先用系统默认</KButton>
      </template>
    </KModal>

    <ContextDialog
      :open="ctxDialog"
      :chat-id="store.state.chatId || 0"
      @close="ctxDialog = false"
      @imported="onContextImported"
    />

    <div v-if="dragging" class="drop-veil">
      <div class="drop-card">
        <i class="fas fa-cloud-arrow-up"></i>
        <div>拖动到此处上传文件</div>
      </div>
    </div>
  </div>

  <Teleport to="body">
    <div v-if="menu" class="ctx-mask" @mousedown="menu = null" @contextmenu.prevent="menu = null"></div>
    <div
      v-if="menu"
      class="ctx-menu"
      :style="{ left: menu.x + 'px', top: menu.y + 'px' }"
      @click="menu = null"
      @contextmenu.prevent="menu = null"
    >
      <template v-if="menu.kind === 'chat'">
        <!-- 固定会话只对自由会话开：项目下的会话本来就钉在项目里，那颗键在他看来越多越乱（第七十七轮） -->
        <button v-if="!menu.item.project_id" type="button" @click="menuPin"><i class="fas fa-thumbtack"></i> {{ menu.item.pinned ? '取消固定' : '固定会话' }}</button>
        <button type="button" @click="menuRename">重命名</button>
        <!-- 自由会话才有独立的目录出口；项目会话的目录锁在项目根内，那条走 /dir -->
        <button v-if="!menu.item.project_id" type="button" @click="menuSetCwd"><i class="fas fa-folder-open"></i> 设置工作目录</button>
        <button type="button" @click="menuCopyName">复制会话名</button>
        <button type="button" class="danger" @click="onRemoveChat(menu.item); menu = null">删除会话</button>
      </template>
      <!-- 远程连接：测试 / 编辑 / 在其下建项目 / 级联删除 -->
      <template v-else-if="menu.kind === 'host'">
        <button type="button" @click="remote.test(menu.item)"><i class="fas fa-plug"></i> 测试连接</button>
        <button type="button" @click="openHostModal(menu.item)"><i class="fas fa-pen"></i> 编辑连接</button>
        <button type="button" @click="onNewProject(menu.item)"><i class="fas fa-folder-plus"></i> 新建远端项目</button>
        <button type="button" @click="onNewChatForHost(menu.item)"><i class="fas fa-plus"></i> 新建远端会话</button>
        <button type="button" class="danger" @click="onRemoveHost(menu.item); menu = null">删除连接</button>
      </template>
      <template v-else>
        <button type="button" @click="menuNewChatIn">在项目中新建会话</button>
        <button type="button" @click="menuEditProject"><i class="fas fa-pen"></i> 编辑项目</button>
        <button type="button" @click="menuEditPrompt"><i class="fas fa-file-lines"></i> 编辑系统提示词</button>
        <button v-if="!menu.item.remote_id" type="button" @click="menuOpenDir">在资源管理器中打开</button>
        <button type="button" @click="menuCopyPath">复制项目路径</button>
        <button type="button" class="danger" @click="onRemoveProject(menu.item); menu = null">删除项目</button>
      </template>
    </div>

    <!-- 项目右键「编辑系统提示词」：KModal 自己 Teleport 到 body，不受上面菜单的点击关闭影响 -->
    <AgentsEditor
      :open="promptOpen"
      :target="promptTarget"
      :title="promptTitle"
      @close="promptOpen = false"
    />
  </Teleport>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useChatStore } from './chatStore';
import { aiApi, settingsApi } from '../../api';
import { toast } from '../../stores/toast';
import { motionState } from '../../stores/motion';
import { txt } from '../../copy';
import { toastErr, errReport, copyText } from '../../utils/errText';
import { confirmDialog } from '../../stores/confirm';
import { promptDialog } from '../../stores/prompt';
import { recycleBin } from '../../stores/recycle';
import KModal from '../../ui/KModal.vue';
import KButton from '../../ui/KButton.vue';
import { themeState } from '../../stores/theme';
import AgentsEditor from '../../ui/AgentsEditor.vue';
import ContextDialog from './ContextDialog.vue';
import KInput from '../../ui/KInput.vue';
import KDropdown from '../../ui/KDropdown.vue';
import { useBarOverflow, rowNeed } from '../../ui/useBarOverflow.js';
import ChatRail from './ChatRail.vue';
import ChatMessage from './ChatMessage.vue';
import ChatComposer from './ChatComposer.vue';
import ChatDock from './ChatDock.vue';
import BrowserPanel from './BrowserPanel.vue';
import SubagentStepsModal from './SubagentStepsModal.vue';
import HistoryReviewModal from './HistoryReviewModal.vue';

// 审阅弹窗要的那条改动：消息流里的编辑卡和右栏「修改历史」那一行都往这里交
const reviewStep = ref(null);

// 子智能体步骤弹窗：消息流里那张卡和右栏那行都开同一扇（只有一个开着的）
const agentModal = ref({ id: '', name: '' });
function openAgentSteps(id) {
  if (!id) return;
  const known = store.state.subagents?.[id];
  agentModal.value = { id: String(id), name: known?.name || String(id) };
}
import { browserStore } from '../../stores/browser';
import SidebarAI from './SidebarAI.vue';
import RemoteHostModal from './RemoteHostModal.vue';
import RemoteFiles from './RemoteFiles.vue';
import TerminalDock from './TerminalDock.vue';
import { remoteStore } from './remoteStore';
import { sidebarStore as sb } from './sidebarStore';
import JumpRail from '../../components/chat/JumpRail.vue';
import ModelPicker from './ModelPicker.vue';
import { mountWhaleWidget } from '../../utils/whaleWidget';

defineOptions({ name: 'ChatPage' });

const route = useRoute();
const router = useRouter();
const store = useChatStore();
const streamEl = ref(null);
const railW = ref(Number(localStorage.getItem('nu_rail_w')) || 260);
const dockW = ref(Number(localStorage.getItem('nu_dock_w')) || 300);
const immersive = ref(false);
/**
 * 顶栏右侧那排开关（Agent / Plan / 只读 / 提问 / 沉浸）的窄屏降级：
 * 放不下就全部收成圆形纯图标（title 悬浮仍给文字），绝不允许文字换行把标题栏撑高。
 * 需要自定义「需要多宽」：这一排自己永远放得下（它是 flex:0 0 auto），
 * 真正会挤的是「标题 + 按钮」合起来的宽度，所以量两个子项的 scrollWidth 相加。
 */
const titlebarEl = ref(null);
const titleEl = ref(null);
const titleActionsEl = ref(null);
// 母本顶栏那批装饰件（竖条/线稿/strip/右端装饰簇）只在终末地下渲染：
// 六套原主题里它们没有样式，两张大 svg 会按固有尺寸直接杵在标题栏上。
const ef = computed(() => themeState.id === 'endfield');
const { compact: barTight, remeasure: remeasureTitlebar } = useBarOverflow(titlebarEl, {
  /**
   * 顶栏换成母本 .ef-chat-head 后，右端那簇装饰（.ef-chat-head__deco，680u 宽）是钉死在板右沿的，
   * 开关排只能排在它左边 ⇒ 可用宽度得把这一簇连缝一起扣掉，否则会晚一步才降级、标题压到装饰上。
   * 扣的量直接量装饰件本身，不写死数字（母本换档 --u 时它自己跟着变）。
   */
  need: () => {
    const deco = titlebarEl.value?.querySelector('.ef-chat-head__deco');
    const reserved = deco ? deco.offsetWidth + 12 : 0;
    return (titleEl.value?.scrollWidth || 0) + rowNeed(titleActionsEl.value, 6) + 16 + reserved;
  },
});
watch(
  () => [store.chatTitle.value, store.state.cwd, store.activeProject.value?.name],
  remeasureTitlebar,
);
// 窄屏（≤960px）下左右栏改成抽屉；宽屏时这两个开关不起作用（CSS 只在窄屏生效）
const railOpen = ref(false);
const dockOpen = ref(false);

/**
 * 顶栏开关的「平时收起」：只留 Agent 常驻，其余折在最右那颗 ">" 后面。
 *
 * 展开的判定范围刻意收得很小 —— 只有 ">" 上方和周围那一小圈（.ta-hot）算数。
 * 原来整条横栏都是触发区，结果想点 Agent 就顺手把一排开关撑出来，反而点不准。
 * 收起则放宽到「离开整条顶栏」：展开后在顶栏里怎么逛都保持展开，
 * 离开后留 260ms 缓冲（跨按钮那点空隙、顺手去点标题，都不该把刚展开的一排收掉）。
 *
 * 「在不在顶栏里」第三十三轮起改成量全局 mousemove 的纵坐标，不用 mouseenter/mouseleave。
 * 但**光靠事件在这个窗口里必然有洞**：窗口顶栏那一条是系统拖拽区（HTCAPTION），Blink 在里面
 * 一条鼠标事件都不发 —— 于是「把鼠标从 ">" 往上挪进窗口顶栏」「挪出窗口」这两种离开方式
 * 永远判不到，那一排就一直摊着（第三十六轮他报的就是这个）。所以现在两条腿走：
 *   1) 判据改成**上下双边**量 `.titlebar` 的矩形（原来只判下沿，往上出栏也算「还在栏里」）；
 *   2) 展开期间额外向主进程要**真实光标位置**（`kh:win / cursor`，不受 app-region 影响），
 *      浏览器里没有这条通道，就退回事件 + 「离开文档 / 窗口失焦」兜底。
 */
const barOpen = ref(false);
let barCloseTimer = null;
function expandToggles() {
  if (barCloseTimer) { clearTimeout(barCloseTimer); barCloseTimer = null; }
  barOpen.value = true;
}
function keepTogglesOpen() {
  if (barCloseTimer) { clearTimeout(barCloseTimer); barCloseTimer = null; }
}
function collapseTogglesSoon() {
  // 本来就收着 → 什么都不做
  if (!barOpen.value && !barCloseTimer) return;
  // **已经排上了就不再重新计时**：这条函数会被 mousemove（连续事件）和 180ms 的光标轮询反复触发，
  // 每次 clearTimeout+setTimeout 就等于无限续期 —— 轮询 180ms < 260ms，计时器永远等不到点，
  // 那一排就再也不收（第三十七轮第一次修完他仍说没修好，真因就是这里）。
  if (barCloseTimer) return;
  barCloseTimer = setTimeout(() => { barOpen.value = false; barCloseTimer = null; }, 260);
}

let barBandBottom = 44;
function measureBarBand() {
  const el = titlebarEl.value;
  barBandBottom = el ? el.getBoundingClientRect().bottom : 44;
}
/**
 * 「在不在顶栏里」= 横纵都要落在 `.titlebar` 的矩形内（各方向留几像素容差）。
 * 以前只判纵坐标 —— 于是他把鼠标往**左栏会话列表**或**右侧面板**一挪（高度没变、横向出栏了）
 * 照样算「还在栏里」，那一排就一直摊着；往上挪进窗口顶栏同理（那只瞎的是事件，见上面注释）。
 */
function inBarBand(x, y) {
  const el = titlebarEl.value;
  if (!el) return y <= barBandBottom + 4;
  const r = el.getBoundingClientRect();
  return x >= r.left - 6 && x <= r.right + 4 && y >= r.top - 6 && y <= r.bottom + 4;
}
function onBarBandMove(e) {
  if (inBarBand(e.clientX, e.clientY)) keepTogglesOpen();
  else collapseTogglesSoon();
}
// 展开才轮询（收起时不花这个钱），180ms 一次、一次一问，只在桌面端有这条通道
let barCursorWatch = null;
function startBarCursorWatch() {
  const ask = window.khDesktop && window.khDesktop.winCtl;
  if (!ask || barCursorWatch) return;
  barCursorWatch = setInterval(async () => {
    try {
      const c = await ask('cursor');
      if (!c || !c.ok) return;
      if (!c.inside || !inBarBand(c.x, c.y)) collapseTogglesSoon();
      else keepTogglesOpen();
    } catch { /* 窗口正在关闭之类：下一轮再说 */ }
  }, 180);
}
function stopBarCursorWatch() {
  if (barCursorWatch) { clearInterval(barCursorWatch); barCursorWatch = null; }
}
watch(barOpen, (v) => { if (v) startBarCursorWatch(); else stopBarCursorWatch(); });
// 非桌面端（浏览器访问）：光标出了文档或窗口失了焦，也按「离开顶栏」处理
function onDocLeave() { collapseTogglesSoon(); }
onMounted(() => {
  measureBarBand();
  window.addEventListener('mousemove', onBarBandMove, { passive: true });
  window.addEventListener('resize', measureBarBand);
  document.addEventListener('mouseleave', onDocLeave);
  window.addEventListener('blur', onDocLeave);
});
onUnmounted(() => {
  window.removeEventListener('mousemove', onBarBandMove);
  window.removeEventListener('resize', measureBarBand);
  document.removeEventListener('mouseleave', onDocLeave);
  window.removeEventListener('blur', onDocLeave);
  if (barCloseTimer) { clearTimeout(barCloseTimer); barCloseTimer = null; }
});

function toggleDrawer(which) {
  if (which === 'rail') { railOpen.value = !railOpen.value; dockOpen.value = false; }
  else { dockOpen.value = !dockOpen.value; railOpen.value = false; }
}
function closeDrawers() {
  railOpen.value = false;
  dockOpen.value = false;
}
const revealed = ref(0);
// 上一版子智能体的结论是落成一条 user 气泡的（speaker='subagent'）。现在改成像工具返回那样直接交回 AI，
// 气泡不画了；老库里那些历史行也一并藏掉，别让他看到几条凭空冒出来的「子智能体」消息。
const renderedMessages = computed(() => {
  const list = store.state.messages;
  return list.some((m) => m.speaker === 'subagent') ? list.filter((m) => m.speaker !== 'subagent') : list;
});
// 默认只展开「当前这一轮 + 上一轮」：从倒数第二条用户消息起渲染，更早的折起来
const foldAnchor = computed(() => {
  const list = renderedMessages.value;
  let seenUser = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].role === 'user') {
      seenUser += 1;
      if (seenUser === 2) return i;
    }
  }
  return 0;   // 不足两轮就全展开
});
// 「展开更早」按批给，不一次全摊开：一次点完全量渲染就是他要的那种「点一下卡一下」
const HISTORY_STEP = 20;
const shownFrom = computed(() => Math.max(0, foldAnchor.value - revealed.value));

const visibleMessages = computed(() => renderedMessages.value.slice(shownFrom.value));
const hiddenCount = computed(() => shownFrom.value);
const lastUnfinished = computed(() => {
  const list = store.state.messages;
  const last = list[list.length - 1];
  return last && last.role === 'assistant' && last.unfinished;
});

/** 最近一条出错的回复（红条 + 那颗重试键）；生成中不显示 */
const lastFailedMsg = computed(() => {
  if (store.state.busy) return null;
  const list = store.state.messages;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].role === 'assistant') return list[i].errorText ? list[i] : null;
  }
  return null;
});
const lastError = computed(() => lastFailedMsg.value?.errorText || '');

function lastAssistantMsg() {
  const list = store.state.messages;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].role === 'assistant') return list[i];
  }
  return null;
}

function dismissError() {
  const m = lastAssistantMsg();
  if (m) m.errorText = '';
}

/** 红条那句只是概括；复制要带走的是「时间 / 页面 / 概括 / 详情 / 最近日志」整份（日志里有被吞掉的原始异常） */
async function copyLastError() {
  const ok = await copyText(errReport({ message: lastError.value }, lastError.value, {
    where: '对话页底部红条',
    request: `POST /api/ai/chat chat=${store.state.chatId || '(新会话)'}`,
  }));
  toast(ok ? '已复制完整报错报告' : '复制失败，请手动选择文本', ok ? 'success' : 'warn', 2200);
}

/** 撤回上一条用户消息（连同本轮失败回复），把原文重新发出去 */
async function onRetryLast() {
  const list = store.state.messages;
  const idx = list.map((m) => m.role).lastIndexOf('user');
  if (idx < 0) return toast('没有可重发的消息', 'warn');
  const u = list[idx];
  if (!u.id) return toast('该消息尚未入库，无法重发', 'warn');
  try {
    await aiApi.retractChat({ chat_id: store.state.chatId, message_id: u.id });
  } catch (e) {
    return toastErr(e, '撤回失败');
  }
  list.splice(idx);
  delete store.state.msgBuf[store.state.chatId];
  store.state.draft = u.content || '';
  await store.send();
  scrollBottom(true);
}

// 状态条要按秒刷新（已跑时长 / 无输出计时），所以引入一个本地心跳
const nowTick = ref(Date.now());
let tickTimer = null;
onMounted(() => { tickTimer = setInterval(() => { nowTick.value = Date.now(); }, 1000); });
onUnmounted(() => { if (tickTimer) clearInterval(tickTimer); });

function fmtDur(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

const cmdElapsed = computed(() => {
  const rc = store.state.runningCmd;
  if (!rc) return '';
  // 心跳每 15s 才带一次 elapsed_ms；中间用本地时钟走秒，别停在 0s
  const local = nowTick.value - (rc.startedAt || nowTick.value);
  return fmtDur(Math.max(local, Number(rc.elapsedMs) || 0));
});

/** 状态条只管「在不在跑 + 跑了多久没声音」，数字都在输入框那行的圆环旁边 */
const runState = computed(() => {
  const st = store.state;
  if (st.runningCmd) return { cls: 'busy', text: `命令运行中 ${cmdElapsed.value}` };
  if (st.busy) {
    const idle = st.lastEventAt ? nowTick.value - st.lastEventAt : 0;
    if (idle > 120000) return { cls: 'warn', text: `运行中 · 已 ${fmtDur(idle)} 无输出` };
    return { cls: 'busy', text: '运行中' };
  }
  if (lastUnfinished.value) return { cls: 'warn', text: '已中断 · 可继续' };
  return { cls: '', text: '就绪' };
});

function skillsPickerOpen() {
  store.state.skillsPicker = true;
}
const railStyle = computed(() => ({
  '--rail-w': `${railW.value}px`,
  '--dock-w': `${dockW.value}px`,
}));

function startDrag(which) {
  const move = (e) => {
    if (which === 'rail') railW.value = Math.min(360, Math.max(200, e.clientX));
    else dockW.value = Math.min(400, Math.max(240, window.innerWidth - e.clientX));
  };
  const up = () => {
    localStorage.setItem('nu_rail_w', String(railW.value));
    localStorage.setItem('nu_dock_w', String(dockW.value));
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  };
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}
const skillList = ref([]);
const skillsChecked = ref([]);
const poolOrder = ref([]);

const files = computed(() => store.filesFromMessages());
const busyChatIds = computed(() => Object.keys(store.state.busyChats || {}).map(Number));
const history = computed(() => store.historyFromMessages());

// 实验室开关：设置页写 localStorage，聊天页挂载时读一次（无 KeepAlive，切页即重读）
let labFlags = {};
try { labFlags = JSON.parse(localStorage.getItem('nu_labs') || '{}') || {}; } catch { labFlags = {}; }

// 局域网手机审批/回答桥：顶栏那颗「手机」开关。状态从后端读（settings.lanbridge_enabled），
// 开关即存即生效（settingsApi.update → 后端 sync() 立即启停，不用重启）。
const lanbridgeOn = ref(false);
const lanbridgeConnected = ref(false);
async function loadLanbridge() {
  try {
    const st = await settingsApi.lanbridge();
    lanbridgeOn.value = !!st?.enabled;
    lanbridgeConnected.value = !!st?.connected;
  } catch { /* 老后端没这条路由：保持关 */ }
}
async function toggleLanbridge() {
  lanbridgeOn.value = !lanbridgeOn.value;
  try {
    await settingsApi.update({ lanbridge_enabled: lanbridgeOn.value ? 1 : 0 });
    toast(lanbridgeOn.value ? '已开启手机审批桥（手机装好 App 后同一局域网自动配对）' : '已关闭手机审批桥', lanbridgeOn.value ? 'success' : 'info', 3000);
    loadLanbridge();
  } catch (e) {
    lanbridgeOn.value = !lanbridgeOn.value;
    toastErr(e, '切换失败');
  }
}

// 小鲸鱼互动挂件：全局单例，离开聊天页只隐藏不销毁
let whale = null;
// 「设置 → 外观」里的总开关（settings.whale_widget.enabled）。null = 这次会话还没读到配置。
let whaleEnabled = null;

onMounted(() => {
  if (!whale) whale = mountWhaleWidget();
  // 已知关掉就直接不显示；不知道就先显示，配置回来再收（避免默认开的时候先闪一下空位）
  whale.setVisible(whaleEnabled !== false);
  aiApi.whaleConfig()
    .then((c) => {
      whaleEnabled = c?.enabled !== false;
      whale?.setVisible(whaleEnabled);
    })
    .catch(() => { /* 读不到配置按开处理，挂件本来默认就是开的 */ });
});

onUnmounted(() => {
  whale?.setVisible(false);
});

onMounted(async () => {
  const id = Number(route.params.id);
  // 「返回」按钮走的是 /chat（不带 id），但 store 里还是刚才那段会话，这一屏渲染出来的就是它。
  // 先按现状贴一次底，别等下面四个请求：它们跑完之前那一屏停在会话顶部（他就是从这儿进来的）。
  if (id || store.state.messages.length) scrollBottomAfterSettle();
  await Promise.all([store.refreshTree(), store.refreshModels(), remote.refresh(), store.loadGlobalApproval()]);
  loadLanbridge();
  // 直接以 /chat/:id 打开（或刷新）时没人滚过：切会话那条路只在路由参数变化时跑，
  // 首屏就停在最上面。和切会话同一套「跟到内容长齐」。
  if (id) { await store.openChat(id); scrollBottomAfterSettle(); }
  // query.model 预选
  const mid = Number(route.query.model);
  if (mid) {
    const idx = store.state.models.findIndex((m) => m.id === mid);
    if (idx >= 0) store.state.modelIdx = idx;
  }
  poolOrder.value = store.state.models.map((m) => m.id);
  await loadSkills();
  maybeAskShell();
});

watch(
  () => route.params.id,
  async (id) => {
    const n = Number(id);
    resetChatView();
    if (n && n !== store.state.chatId) await store.openChat(n);
    if (!n) {
      store.state.chatId = null;
      store.state.messages = [];
    }
    scrollBottomAfterSettle();
  }
);

/* 跟着流式滚到底：只看两个标量 —— 消息条数 + store 每落一批 +1 的 streamTick。
   以前这里是对整个 messages 数组开 `{ deep: true }`：每 30ms 一批就要把每条消息的 steps/timeline
   全遍历一遍去建依赖，实测（_tmp_kh77/perf_probe.js 场景 A）一条会话流式 6.5 秒里
   样式重算 1641 次、主线程任务合计 3.0 秒 —— 屏幕上的字一共才 120 个节点。
   消息内容变长一定伴随着这两者之一变化，所以少了 deep 遍历也不会漏滚。 */
watch(
  () => [store.state.messages.length, store.state.streamTick],
  () => scrollBottom()
);

function gotoMsg(id) {
  scrollToMsg(id, 3);
}

/** 高亮靠响应式 class，不能直接往 DOM 上塞 class —— TransitionGroup 会重建元素把它抹掉 */
const flashMsgId = ref(null);

/** 轨迹跳进来时消息可能还在异步加载，轮询几次再定位 */
function scrollToMsg(id, tries = 20) {
  revealed.value = store.state.messages.length;   // 要找的那条可能在折叠区里：先全放出来
  // 这一路是「我们把上面全摊开、再平滑滚到中间」：整个过程都不许自动贴底，
  // 否则摊开的那一刻就被拽到了底部、scrollIntoView 也白滚（每次重试都续一次窗口）
  suppressAutoFollow(1500);
  nextTick(() => {
    const el = document.getElementById(`msg-${id}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      flashMsgId.value = id;
      setTimeout(() => { if (flashMsgId.value === id) flashMsgId.value = null; }, 1800);
      return;
    }
    if (tries <= 0) return toast('没找到那条消息（可能已被撤回）', 'warn');
    setTimeout(() => scrollToMsg(id, tries - 1), 150);
  });
}

// 从轨迹页带 ?msg= 跳进来：展开历史、滚到那条并闪一下
watch(
  () => route.query.msg,
  (m) => {
    const id = Number(m);
    if (!id) return;
    scrollToMsg(id);
  },
  { immediate: true }
);

const showDown = ref(false);
// 是否跟随到底部（用户上翻即关闭，点「回到底部」或切会话重新打开）
const pinnedToBottom = ref(true);
let scrollAnimActive = false;   // 惯性滚到底正在进行（这段时间不认 scroll 事件的用户意图）
/**
 * 我们自己动了内容或位置的那一瞬间（展开更早的历史、轨迹跳转定位）：短暂关掉自动贴底。
 * 声明放在这里而不是 ResizeObserver 旁边 —— scrollToMsg 会被 immediate 的 watch 在 setup 期间
 * 就调到，那时下面的 let 还在 TDZ 里。
 */
let followSuppressUntil = 0;
function suppressAutoFollow(ms = 800) {
  followSuppressUntil = Date.now() + ms;
}
let programmaticScrollUntil = 0;  // 这一瞬间内的 scroll 事件可能是我们自己滚出来的（见 onStreamScroll）
let programmaticTop = -1;         // 那一下写下去的 scrollTop 原值：位置一离开它就不是我们干的了

function onStreamScroll() {
  const el = streamEl.value;
  if (!el) return;
  // 惯性滚到底的过程中：这时 gap 还大，若照常判定会把「跟随底部」关掉、动画当场撒手
  if (scrollAnimActive) return;
  // 这批 scrollTop 可能是自己写的（流式每落一批都滚一次）：还在我们写的那个位置上就连 scrollHeight 都不必读，
  // 读了就是「写→滚动事件→强制布局→再写」每批两趟来回。只认「位置还等于我们写下去的那个数」，
  // 用户这中间滚轮一拨 scrollTop 就离开它了 → 照常判，不吞他「往上翻」的意图。
  if (Date.now() < programmaticScrollUntil && Math.abs(el.scrollTop - programmaticTop) <= 1) return;
  const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
  showDown.value = gap > 80;
  // 动画刚收尾那一瞬：内容在这 0.5 秒里还在长，我们写下去的 scrollTop 已经落后于新的底部，
  // 这一次 scroll 事件是「我们自己造成的」而不是用户上翻 —— 有个短暂豁免窗，别把它读成用户意图，
  // 否则就是他报的「点了回到底部反而不再跟随」。
  if (Date.now() < ignoreUnpinUntil) return;
  // 用户上翻就停止跟随，回到底部附近自动恢复跟随
  pinnedToBottom.value = gap <= 80;
}

function scrollBottom(force = false) {
  if (!force && !pinnedToBottom.value) return;
  nextTick(() => {
    const el = streamEl.value;
    if (el) {
      programmaticScrollUntil = Date.now() + 120;
      el.scrollTop = el.scrollHeight;
      programmaticTop = el.scrollTop;
      showDown.value = false;
      pinnedToBottom.value = true;
    }
  });
}

/**
 * 「回到底部」按钮专用：这是用户主动点的，要看得见地在滚 —— 500ms、easeOutCubic（起步就快、
 * 末尾带衰减的惯性），以前是直接把 scrollTop 一设到底，看着像瞬移。
 * 流式跟随仍然走上面的 scrollBottom（瞬移），否则每来一个字都在动画，读起来是抖。
 */
let scrollAnim = null;
let ignoreUnpinUntil = 0;   // 「这次 scroll 是我们自己滚出来的」豁免窗（见 onStreamScroll）
function stopScrollAnim() {
  if (scrollAnim) { cancelAnimationFrame(scrollAnim); scrollAnim = null; }
  scrollAnimActive = false;
}
/** 把「用户自己动滚轮/触摸」那两个一次性监听摘干净：{ once:true } 只在事件真的发生时才自动解绑，
 *  动画自然结束时它们还没触发 —— 不摘就会留到下一次点击上，新动画刚起步就被上一轮的 giveUp 掐掉。 */
let scrollAnimReleasers = [];
function releaseScrollAnimListeners() {
  for (const off of scrollAnimReleasers.splice(0)) off();
}
function scrollBottomAnimated() {
  const el = streamEl.value;
  if (!el) return;
  if (scrollAnim) cancelAnimationFrame(scrollAnim);
  releaseScrollAnimListeners();
  const from = el.scrollTop;
  const reduced = !motionState.on;   // 只认设置-外观那颗「界面动效」开关（以前跟系统，桌面关了动画这里就静默没滚动了）
  pinnedToBottom.value = true;
  showDown.value = false;
  // 目标是「滚动过程中的最新底部」而不是点下去那一瞬的底部：流式还在吐字时底部一直在长
  const bottom = () => el.scrollHeight - el.clientHeight;
  if (reduced) { el.scrollTop = bottom(); ignoreUnpinUntil = Date.now() + 300; return; }
  const D = 500;
  const t0 = performance.now();
  const startGap = bottom() - from;
  const ease = (p) => 1 - Math.pow(1 - p, 3);   // easeOutCubic：一起步就快，末尾带衰减的惯性
  scrollAnimActive = true;
  const giveUp = () => { stopScrollAnim(); releaseScrollAnimListeners(); };
  el.addEventListener('wheel', giveUp, { passive: true });
  el.addEventListener('touchstart', giveUp, { passive: true });
  scrollAnimReleasers = [
    () => el.removeEventListener('wheel', giveUp),
    () => el.removeEventListener('touchstart', giveUp),
  ];
  const step = (now) => {
    const p = Math.min(1, (now - t0) / D);
    // 起点固定、终点跟着内容长：距离按当前值重算，短内容（startGap 很小）就直接落底
    el.scrollTop = startGap <= 4 ? bottom() : from + (bottom() - from) * ease(p);
    if (p < 1) { scrollAnim = requestAnimationFrame(step); return; }
    releaseScrollAnimListeners();
    scrollAnim = null;
    scrollAnimActive = false;
    // 收尾这一下算「落到底」，紧接着的 scroll 事件不能反过来把跟随关掉
    ignoreUnpinUntil = Date.now() + 300;
  };
  scrollAnim = requestAnimationFrame(step);
}
onUnmounted(stopScrollAnim);

/**
 * 切会话之后落到最底部。
 * 光在切换那一刻滚一次不够：内容是分帧长齐的（「只展开最近两轮」的折叠要渲染后才算得准，
 * 代码块还要等 highlight.js 动态 import 回来换一次高度）——那一刻量到的 scrollHeight 是错的。
 * 以前这件事靠下面那个 ResizeObserver 里的一段 1.2s（硬上限 6s）时间窗兜着，
 * 现在那条观察是**常驻**的（见 streamRo），所以这里只需要把跟随打开、立刻贴一次底。
 */
function scrollBottomAfterSettle() {
  scrollBottom(true);
}
/** 用户自己点开折叠（历史 / 本轮更早）时这段跟随必须立刻作废，否则刚摊开的内容会被拽回底部。
 *  （抑制窗口的变量与 suppressAutoFollow 声明在 pinnedToBottom 那一带，
 *   因为 scrollToMsg 会在 setup 期间就被 immediate 的 watch 调到。） */
function stopFollowBottom() {
  suppressAutoFollow();
}
/** 一次给一批（不是全摊开）：全量展开时上面几百条一起渲染，点一下就是一次长任务 */
function openHistory() {
  stopFollowBottom();
  const el = streamEl.value;
  // 展开是在**上方**加内容，视口不动的话人会被顶走：记下当前第一条，滚完把位移补回去
  const anchor = el && el.querySelector('.stream-inner > *');
  const before = anchor ? anchor.getBoundingClientRect().top : 0;
  revealed.value += HISTORY_STEP;
  nextTick(() => {
    if (!el || !anchor || !el.contains(anchor)) return;
    el.scrollTop += anchor.getBoundingClientRect().top - before;
  });
}
function collapseHistory() {
  stopFollowBottom();
  revealed.value = 0;
}

/**
 * 跟随底部：只要人还贴着底，内容一变高就贴回去。
 *
 * 旧版这里是把「跟随」限在切会话后的一小段时间窗里（followBottomUntil 1.2s / 硬上限 6s），
 * 窗口一过 RO 就撒手 —— 于是**异步**长高的东西全落在窗口之外：AI 截图 / 粘贴附图里的 <img>
 * 解码完成、mermaid 出图、代码高亮换行、图片 404 换成占位文字……内容在底部凭空长高 220px，
 * 视口被顶上去。更糟的是这时 pinnedToBottom 仍是 true（scrollTop 一个字节都没动过，
 * 连 scroll 事件都没发），所以「回到底部」那颗键也不亮，看着就是「跟随莫名其妙坏了」。
 *
 * 现在的判据只有一条：**scrollTop 没动、内容却变高了 ⇒ 长出来的那截在视口下方 ⇒ 贴底**。
 * scrollTop 跟着变了（浏览器的滚动锚定替我们保住了视觉位置）⇒ 长在了上方或中间
 * （点开一组工具调用、展开一段 diff）⇒ 贴底等于把人拽走，不干。
 * 「我们自己往上面塞内容」那几条路（展开更早 N 条、轨迹跳转）另有 suppressAutoFollow 兜着。
 */
let streamRo = null;
let roReady = false;    // 首次回调只用来落账基线（那时 scrollTop 还是上一个会话留下的）
let roLastH = 0;
let roLastTop = 0;
onMounted(() => {
  const el = streamEl.value;
  const inner = el && el.querySelector('.stream-inner');
  if (el && inner && typeof ResizeObserver !== 'undefined') {
    streamRo = new ResizeObserver(() => {
      const h = el.scrollHeight;
      const top = el.scrollTop;
      if (!roReady) { roReady = true; roLastH = h; roLastTop = top; return; }
      const grew = h - roLastH;
      const moved = top - roLastTop;
      roLastH = h;
      roLastTop = top;
      if (grew <= 0) return;               // 只跟「往下长」：内容变短/收起不用管
      if (!pinnedToBottom.value) return;   // 人已经上翻去看历史了
      if (Date.now() < followSuppressUntil) return;
      if (moved > 2) return;               // 长在视口上面（滚动锚定把 scrollTop 顶下来了）
      el.scrollTop = el.scrollHeight;
      showDown.value = false;
      roLastTop = el.scrollTop;            // 这一下是我们自己滚的，别算进下一轮的 moved
      // 紧跟着那个 scroll 事件是我们造成的，不能被 onStreamScroll 读成「用户上翻」而关掉跟随
      programmaticScrollUntil = Date.now() + 120;
      programmaticTop = el.scrollTop;
    });
    streamRo.observe(inner);
  }
});
onUnmounted(() => { if (streamRo) { streamRo.disconnect(); streamRo = null; } });

/** 切会话时清掉只属于上一会话的界面态（历史展开、待发送附件、滚动跟随、窄屏抽屉） */
function resetChatView() {
  revealed.value = 0;
  attachments.value = [];
  dragging.value = false;
  pinnedToBottom.value = true;
  closeDrawers();
}

async function openChat(id) {
  resetChatView();
  await store.openChat(id);
  if (String(route.params.id) !== String(id)) {
    router.replace({ name: 'Chat', params: { id } });
  }
  scrollBottomAfterSettle();
}

const projModal = ref(false);
const chatModal = ref(false);
/** remote_id 非空表示「新建远端项目」：root_path 填的是远端绝对路径，后端用 SFTP 校验 */
const projForm = reactive({ name: '', root_path: '', remote_id: 0, editingId: 0 });
/** 会话右键「设置工作目录」：自由会话唯一的图形入口（以前只有 /dir 一条命令） */
const cwdModal = ref(false);
const cwdForm = reactive({ id: 0, title: '', path: '', remote_id: 0 });
const chatForm = reactive({ title: '', project_id: null });
const projHost = computed(() => remoteStore.state.hosts.find((h) => h.id === projForm.remote_id) || null);
const projTitle = computed(() => (projForm.editingId ? '编辑项目' : projForm.remote_id ? '新建远端项目' : '新建项目'));

/** 桌面端才有系统目录选择框（主进程弹）；网页模式不摆死键 */
const canPickDir = typeof window !== 'undefined' && !!(window.khDesktop && window.khDesktop.pickDir);
async function pickProjectDir() {
  try {
    const r = await window.khDesktop.pickDir({ title: '选择项目根目录', defaultPath: projForm.root_path || undefined });
    if (r && r.ok && r.path) {
      projForm.root_path = r.path;
      // 名字空着时用目录名填上，省一次打字（他抱怨的就是「得手输绝对路径」）
      if (!projForm.name) projForm.name = String(r.path).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
    } else if (r && !r.ok) toast(r.error || '没拿到目录', 'warn');
  } catch (e) { toastErr(e, '打开目录选择框失败'); }
}

const hostModal = ref(false);
const hostEditing = ref(null);
const remote = remoteStore;   // 模板里用 remote.state.hosts
/** 当前会话属于哪台远程主机（null = 本机）；决定最右一列是浏览器还是远端文件区 */
const activeRemoteHost = computed(() => {
  const id = store.state.chatId;
  if (!id) return null;
  const rid = store.state.chats.find((c) => c.id === id)?.remote_id ?? store.activeChat.value?.remote_id;
  if (!rid) return null;
  return remoteStore.state.hosts.find((h) => h.id === rid) || null;
});
function openHostModal(host) {
  hostEditing.value = host || null;
  hostModal.value = true;
}
async function onRemoveHost(host) {
  const okGone = await remoteStore.remove(host);
  if (okGone) await store.refreshTree();   // 它下面的远端项目/会话记录一并没了，左栏要重取
}

// 新建会话的项目下拉（'' = 不关联项目）。远端项目标出所属机器，避免同名分不清
const projectItems = computed(() => [
  { value: '', label: '不关联项目' },
  ...store.state.projects.map((p) => {
    const h = p.remote_id ? remoteStore.state.hosts.find((x) => x.id === p.remote_id) : null;
    return { value: String(p.id), label: h ? `${p.name}（${h.name}）` : p.name };
  }),
]);
const chatProjectLabel = computed(() => {
  const id = chatForm.project_id;
  if (!id) return '不关联项目';
  return store.state.projects.find((p) => p.id === id)?.name || '不关联项目';
});
function pickChatProject(v) {
  chatForm.project_id = v ? Number(v) : null;
}

/** 从连接上右键进来时带 host = 建远端项目；不带就是本机项目 */
async function onNewProject(host) {
  projForm.editingId = 0;
  projForm.name = '';
  projForm.root_path = '';
  projForm.remote_id = host && host.id ? host.id : 0;
  if (projForm.remote_id) {
    const h = remoteStore.hostOf(projForm.remote_id);
    projForm.root_path = h?.default_cwd || h?.home || '/';
    if (!h?.default_cwd && !h?.home) toast('这条连接还没探到远端目录，先手动填绝对路径（或右键「测试连接」让它探一次家目录）', 'warn');
  }
  projModal.value = true;
}

async function submitProject() {
  if (!projForm.name.trim() || !projForm.root_path.trim()) {
    toast('请填写项目名称与根目录', 'warn');
    return;
  }
  if (projForm.editingId) {
    const r = await store.editProject(projForm.editingId, { name: projForm.name.trim(), root_path: projForm.root_path.trim() });
    projModal.value = false;
    // 改目录会把它下面「不在新根内」的会话工作目录一起重置，条数得报出来 —— 不然左栏看着没变、
    // 而某条会话悄悄换了地方
    toast(r?.chats_reset ? `项目已更新，${r.chats_reset} 条会话的目录不在新根内，已重置为新目录` : '项目已更新', 'success');
    if (store.state.chatId && store.activeChat.value?.project_id === projForm.editingId) {
      const row = store.state.chats.find((c) => c.id === store.state.chatId);
      if (row && row.cwd !== store.state.cwd) store.state.cwd = row.cwd || '';
    }
    projForm.editingId = 0;
    return;
  }
  await store.newProject(projForm.name.trim(), projForm.root_path.trim(), projForm.remote_id || undefined);
  projModal.value = false;
  toast(projForm.remote_id ? '远端项目已创建' : '项目已创建', 'success');
}

async function pickCwdDir() {
  try {
    const r = await window.khDesktop.pickDir({ title: '选择工作目录', defaultPath: cwdForm.path || undefined });
    if (r && r.ok && r.path) cwdForm.path = r.path;
    else if (r && !r.ok) toast(r.error || '没拿到目录', 'warn');
  } catch (e) { toastErr(e, '打开目录选择框失败'); }
}

async function submitCwd() {
  const p = String(cwdForm.path || '').trim();
  if (!p) return toast('请填写工作目录', 'warn');
  const r = await aiApi.setCwd(p, cwdForm.id);
  cwdModal.value = false;
  await store.refreshTree();
  const got = r?.cwd || p;
  if (store.state.chatId === cwdForm.id) store.state.cwd = got;
  toast(`工作目录已设为 ${got}`, 'success');
}

async function onNewChat(projectId) {
  chatForm.title = '';
  chatForm.project_id = projectId ?? store.activeProject.value?.id ?? null;
  chatModal.value = true;
}

/** 连接右键「新建远端会话」：不挂项目，直接开一条属于那台机器的自由会话 */
async function onNewChatForHost(host) {
  const created = await store.newChat(null, host.id);
  if (created?.id) await openChat(created.id);
}

async function submitChat() {
  const proj = store.state.projects.find((p) => p.id === chatForm.project_id);
  if (proj && !(await preflightAgentsMd(proj))) return;   // AGENTS.md 过大时用户可以取消
  // 用 ?? 而不是 ||：「不关联项目」是 null，`|| undefined` 会把它变成「没传」，
  // 落到 store.newChat 那边就被老兜底读成当前活动项目了
  const created = await store.newChat(chatForm.project_id ?? null);
  if (created?.id) {
    if (chatForm.title.trim()) await store.renameChat(created.id, chatForm.title.trim());
    await openChat(created.id);
  }
  chatModal.value = false;
}

/** 建会话前预检：项目 AGENTS.md 会常驻 System Prompt，太大就按 token/费用让用户确认 */
const agentsMdChecked = new Set();

async function preflightAgentsMd(project) {
  // 远端项目的 AGENTS.md 在远端，由后端读（本机这份是另一台机器的规矩，不预检也不注入）
  if (!project || project.remote_id) return true;
  if (agentsMdChecked.has(project.id)) return true;
  let res = null;
  try {
    res = await aiApi.checkAgentsMd({ project_id: project.id });
  } catch { return true; }   // 预检失败不阻塞建会话
  const files = res?.files || [];
  if (!files.length) return true;
  const total = Number(res?.total_tokens) || 0;
  const skipped = files.filter((f) => f.skipped).map((f) => `${f.path}（${f.skipped}）`).join('；');
  if (total > 5000) {
    const priceIn = Number(store.currentModel.value?.price_in) || 0;
    const cost = priceIn > 0 ? `，每次对话约多花 $${((total / 1e6) * priceIn).toFixed(4)}` : '';
    const list = files.map((f) => `- [${f.scope}] ${f.path} ≈ ${f.tokens} tokens`).join('\n');
    const okGo = await confirmDialog(
      `项目 AGENTS.md 约 ${total} tokens，将注入每次对话的 System Prompt${cost}。是否继续？\n\n${list}`,
      { title: 'AGENTS.md 预检' }
    );
    if (!okGo) return false;
  } else if (total > 1000) {
    toast(`AGENTS.md 约 ${total} tokens，会注入每次对话（可能增加 token 消耗）`, 'info', 6000);
  }
  if (skipped) toast('部分 AGENTS.md 过大已跳过：' + skipped, 'info', 6000);
  agentsMdChecked.add(project.id);
  return true;
}

function onToggleProject(id) {
  // 走 store：除了翻内存那个 open，还要记进折叠清单，否则下一次 refreshTree 就给人翻回来
  store.toggleProjectOpen(id);
}

const recycle = recycleBin();
// 开关状态挪到 store 里：入口现在在窗口顶栏「文件 → 回收站」（WindowBar 与本页不是父子，
// 得有个共同的地方挂），这里保持模板写法不变，用可写 computed 代理过去。
const recycleOpen = computed({
  get: () => recycle.state.open,
  set: (v) => { recycle.state.open = !!v; },
});
/* 项目右键的「编辑系统提示词」：target 只带 project_id，路径由后端从库里取 */
const promptOpen = ref(false);
const promptTarget = ref({ scope: 'global' });
const promptTitle = ref('编辑系统提示词');

/** 两类条目合成一张表：服务端快照（会话/项目，能真恢复）+ 本地台账（文件，走撤销） */
const recycleRows = computed(() => [
  ...(recycle.state.server || []).map((s) => ({
    key: `t${s.id}`,
    source: 'trash',
    raw: s,
    kind: s.kind === 'project' ? '项目' : '会话',
    name: s.title || '(未命名)',
    path: s.path || '',
    at: String(s.created_at || '').replace('T', ' ').slice(0, 16),
    detail: s.kind === 'project' ? `${s.chats} 个会话 · ${s.messages} 条消息` : `${s.messages} 条消息`,
    restored: !!s.restored_at,
    canRestore: true,
  })),
  ...(recycle.state.items || []).map((it) => ({
    key: `l${it.id}`,
    source: 'local',
    raw: it,
    kind: it.kind || '文件',
    name: it.name || it.path || it.id,
    path: it.path || '',
    at: String(it.deleted_at || '').replace('T', ' ').slice(0, 16),
    detail: '',
    restored: it.status === 'restored',
    canRestore: !!it.undo_id,
  })),
]);

watch(recycleOpen, (on) => { if (on) recycle.refresh(); });

async function clearRecycle() {
  if (!(await confirmDialog('确认清空回收站？清空后无法再从这里恢复。'))) return;
  recycle.clear();
  await recycle.clearTrash();
}

async function restoreRow(row) {
  if (row.source === 'trash') {
    const r = await recycle.restoreTrash(row.raw);
    if (!r) return;                       // 失败原因 toastErr 已经报过了
    const bits = [];
    if (r.modelChanged) bits.push('原模型已删除，改用了现存模型');
    if (r.remoteDropped) bits.push('原远程连接已删除，已改为普通会话');
    toast(`已恢复${bits.length ? `（${bits.join('；')}）` : ''}`, 'success');
    await store.refreshTree();
    if (store.state.chatId == null && (r.chats || []).length) store.openChat?.(r.chats[0]);
    return;
  }
  await restoreByUndo(row.raw);
}

async function removeRow(row) {
  // 「永久」是真的永久：回收站里这条就是最后一份，删了没有任何地方能找回
  if (!(await confirmDialog(`永久删除「${row.kind || ''} ${row.name || '该条目'}」？这是最后一份，删掉后无法再恢复。`, { title: '永久删除', danger: true, okText: '删除' }))) return;
  if (row.source === 'trash') await recycle.removeTrash(row.raw);
  else recycle.remove(row.raw.id);
}

/** 文件类：走撤销（原逻辑），恢复完把这条标成已恢复并把步骤状态同步过去 */
async function restoreByUndo(it) {
  if (!it.undo_id) return;
  try {
    await aiApi.undo(it.undo_id, it.chat_id || store.state.chatId, null);
    recycle.markRestored(it.undo_id);
    for (const m of store.state.messages) {
      for (const s of m.steps || []) {
        if (s.undo_id === it.undo_id) s.undone = true;
      }
    }
    toast('已恢复', 'success');
  } catch (e) {
    toastErr(e, '恢复失败');
  }
}

async function onRemoveProject(p) {
  if (!(await confirmDialog(`确认删除项目「${p.name || '未命名'}」？项目下的会话一并移除，可从回收站恢复。`))) return;
  try {
    await aiApi.deleteProject(p.id, true);
    await store.refreshTree();
    toast('项目已删除（含其下会话），可在回收站恢复', 'success');
  } catch (e) {
    toastErr(e, '删除失败');
  }
}

async function onRemoveChat(c) {
  if (!(await confirmDialog(`确认删除会话「${c.title || '未命名'}」？删除后可在回收站找回。`))) return;
  try {
    await store.removeChat(c.id);
    toast('会话已删除，可在回收站恢复', 'success');
  } catch (e) {
    toastErr(e, '删除失败');
  }
}

const titleMenu = ref(false);

async function menuPinCurrent() {
  titleMenu.value = false;
  const c = store.activeChat.value;
  if (c) store.pinChat(c.id, !c.pinned);
}

async function menuRenameCurrent() {
  titleMenu.value = false;
  const c = store.activeChat.value;
  if (!c) return;
  const t = await promptDialog({ title: '会话名称', value: c.title || '', confirmText: '改名' });
  if (t == null) return;
  store.renameChat(c.id, t || c.title);
}

/** 拖拽排序：ChatRail 给出同一列表内的新 id 顺序 */
async function onReorder({ kind, ids }) {
  try {
    if (kind === 'project') await aiApi.reorderProjects(ids);
    else await aiApi.reorderChats(ids);
    await store.refreshTree();
  } catch (e) {
    toastErr(e, '顺序保存失败');
    await store.refreshTree();
  }
}

/** 快速导出：只拿当前已加载的可见消息拼 Markdown（完整上下文走 ContextDialog） */
function menuExportChat(fmt = 'md') {
  titleMenu.value = false;
  const list = store.state.messages;
  if (!list.length) return toast('这个会话还没有内容', 'warn');
  const title = store.chatTitle.value || 'session';
  const safe = title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
  let text = '';
  let mime = 'text/plain;charset=utf-8';
  if (fmt === 'json') {
    mime = 'application/json;charset=utf-8';
    text = JSON.stringify({
      title,
      chat_id: store.state.chatId,
      cwd: store.state.cwd,
      exported_at: new Date().toISOString(),
      messages: list.map((m) => ({
        role: m.role,
        content: m.content,
        reasoning: m.reasoning || undefined,
        steps: (m.steps || []).map((s) => ({ type: s.type, name: s.name, path: s.path || undefined, output: s.output || undefined, error: s.error || undefined, undone: s.undone || undefined })),
        usage: m.usage || undefined,
        model_name: m.model_name || undefined,
      })),
    }, null, 2);
  } else {
    mime = 'text/markdown;charset=utf-8';
    const lines = [`# ${title}`, '', `- 导出时间：${new Date().toLocaleString()}`, `- 工作目录：${store.state.cwd || '（未设置）'}`, ''];
    for (const m of list) {
      lines.push(m.role === 'user' ? '## 你' : `## AI${m.model_name ? ` · ${m.model_name}` : ''}`);
      lines.push('');
      for (const s of m.steps || []) {
        if (s.type === 'tool') lines.push(`- 调用 \`${s.name}\`：\`${JSON.stringify(s.args || {}).slice(0, 200)}\``);
        else if (s.type === 'result') lines.push(`- \`${s.name}\` 结果：${(s.error || s.output || '').toString().split('\n')[0].slice(0, 200)}`);
        else if (s.type === 'note') lines.push(`- ${s.message}`);
      }
      if ((m.reasoning || '').trim()) lines.push('', '<details><summary>思考过程</summary>', '', m.reasoning, '', '</details>');
      lines.push(m.content || '', '');
    }
    text = lines.join('\n');
  }
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safe}.${fmt === 'json' ? 'json' : 'md'}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast(`已导出 ${a.download}`, 'success');
}

const ctxDialog = ref(false);

/** 导入成功：刷新左栏并跳到新会话 */
async function onContextImported(r) {
  ctxDialog.value = false;
  if (!r?.chat_id) return;
  await store.refreshTree();
  await openChat(r.chat_id);
}

async function menuDeleteCurrent() {
  titleMenu.value = false;
  const c = store.activeChat.value;
  if (!c) return;
  if (!(await confirmDialog(`确认删除会话「${c.title || '未命名'}」？删除后可在回收站找回。`))) return;
  store.removeChat(c.id);
}

const menu = ref(null);
const modelSettingsOpen = ref(false);
const modelForm = reactive({
  temperature: 0.7,
  frequency_penalty: 0,
  presence_penalty: 0,
  thinkingLevel: 'medium',
  contextLimit: 0,
  censoredWords: '',
});

watch(
  () => modelSettingsOpen.value,
  (v) => {
    if (!v) return;
    modelForm.temperature = store.state.temperature;
    modelForm.frequency_penalty = store.state.frequency_penalty;
    modelForm.presence_penalty = store.state.presence_penalty;
    modelForm.thinkingLevel = store.state.thinkingLevel || 'medium';
    // 回填「你亲手设的那个数」，不是分母（分母可能是 min(设定, 实测能力)）。
    // 用分母回填的话，一保存就把 100 万写成实测的三十几万 —— 他两次报的「我设的窗口自己变了」。
    modelForm.contextLimit = store.state.contextConfigured || store.state.contextLimit;
    modelForm.censoredWords = store.state.censoredWords;
  }
);

async function saveModelParams() {
  try {
    await store.saveModelParams({
      temperature: Number(modelForm.temperature) || 0,
      frequency_penalty: Number(modelForm.frequency_penalty) || 0,
      presence_penalty: Number(modelForm.presence_penalty) || 0,
      thinkingLevel: modelForm.thinkingLevel || 'medium',
      contextLimit: Number(modelForm.contextLimit) || 0,
      censoredWords: modelForm.censoredWords || '',
    });
  } catch {
    // 服务端拒了（比如上下文窗口填了非法值）：拦截器已经把原文弹出来了，
    // 弹窗保持开着让他改完再点一次，别一边报错一边报「已保存」。
    return;
  }
  modelSettingsOpen.value = false;
  toast('模型设置已保存', 'success');
}
async function onGitAction(action) {
  // chat_id 决定这一枪打在本机还是远端：远程会话的 Git 必须在那台机器上执行
  const at = () => ({ path: store.state.cwd || undefined, chat_id: store.state.chatId || undefined });
  try {
    if (action.startsWith('checkout:')) {
      const br = action.slice(9);
      await aiApi.gitCheckout({ branch: br, ...at() });
      toast(`已切换分支 ${br}`, 'success');
    } else if (action.startsWith('checkout-remote:')) {
      // 远端分支：本地还没有同名分支，从它建一条带跟踪的本地分支（这是以前完全没有的能力）
      const full = action.slice(16);
      const short = full.replace(/^[^/]+\//, '');
      await aiApi.gitCheckout({ branch: short, from: full, ...at() });
      toast(`已从 ${full} 建出 ${short}`, 'success');
    } else if (action === 'new-branch') {
      const name = await promptDialog({ title: '新分支名', value: '', confirmText: '创建并切换' });
      if (!name || !String(name).trim()) return;
      await aiApi.gitCheckout({ branch: String(name).trim(), create: true, ...at() });
      toast(`已新建并切到 ${String(name).trim()}`, 'success');
    } else if (action === 'pull') {
      const r = await aiApi.gitPull(at());
      toast(r?.message || '已拉取', 'success');
    } else if (action === 'commit') {
      const msg = (await promptDialog({ title: '提交说明', value: 'update', confirmText: '提交' })) || 'update';
      await aiApi.gitCommit({ message: msg, ...at() });
      toast('已提交', 'success');
    } else if (action === 'push') {
      const r = await aiApi.gitPush(at());
      toast(r?.message || '已推送', 'success');
    } else if (action === 'commit-push') {
      const msg = (await promptDialog({ title: '提交说明', value: 'update', confirmText: '提交并推送' })) || 'update';
      await aiApi.gitCommit({ message: msg, ...at() });
      const r = await aiApi.gitPush(at());
      toast(r?.message || '已提交并推送', 'success');
    }
    await loadGit();
  } catch (e) {
    toastErr(e, 'Git 操作失败');
  }
}

async function loadGit() {
  try {
    const info = await aiApi.gitStatus({ path: store.state.cwd || undefined, chat_id: store.state.chatId || undefined });
    gitBranch.value = info?.branch || '';
    gitBranches.value = info?.branches || [];
    gitRemoteBranches.value = info?.remote_branches || [];
    gitDirty.value = Number(info?.dirty_count) || 0;
    gitAhead.value = Number(info?.ahead) || 0;
    gitBehind.value = Number(info?.behind) || 0;
    gitOk.value = !!(info?.is_repo && info?.branch);
  } catch {
    gitBranch.value = '';
    gitBranches.value = [];
    gitRemoteBranches.value = [];
    gitDirty.value = 0;
    gitAhead.value = 0;
    gitBehind.value = 0;
    gitOk.value = false;
  }
}

const gitBranch = ref('');
const gitBranches = ref([]);
const gitRemoteBranches = ref([]);
const gitDirty = ref(0);
const gitAhead = ref(0);
const gitBehind = ref(0);
const gitOk = ref(false);
// 切会话/切项目都要重读：cwd 变了仓库就变了。另外切回窗口时也刷一次 ——
// 用户很可能刚在外部终端里提交/切过分支，界面不该一直显示旧状态。
function onWinFocus() { if (gitOk.value) loadGit(); }
watch(() => store.state.cwd, loadGit, { immediate: true });
watch(() => store.state.chatId, loadGit);
onMounted(() => window.addEventListener('focus', onWinFocus));
onUnmounted(() => window.removeEventListener('focus', onWinFocus));

function onMenu(payload) {
  menu.value = payload;
}
async function menuPin() {
  const c = menu.value?.item;
  menu.value = null;
  if (!c) return;
  await store.pinChat(c.id, !c.pinned);
}
function menuRename() {
  const c = menu.value?.item;
  menu.value = null;
  if (!c) return;
  promptDialog({ title: '会话名称', value: c.title || '', confirmText: '改名' }).then((t) => {
    if (t == null) return;
    store.renameChat(c.id, t || c.title);
  });
}
function menuCopyName() {
  const c = menu.value?.item;
  menu.value = null;
  if (c) navigator.clipboard.writeText(c.title || '');
}
function menuNewChatIn() {
  const p = menu.value?.item;
  menu.value = null;
  onNewChat(p?.id);
}
/** 右键「编辑项目」：同一个弹窗换成编辑态，预填这一行的名字与目录 */
function menuEditProject() {
  const p = menu.value?.item;
  menu.value = null;
  if (!p?.id) return;
  projForm.editingId = p.id;
  projForm.name = p.name || '';
  projForm.root_path = p.root_path || '';
  projForm.remote_id = p.remote_id || 0;
  projModal.value = true;
}
/** 右键「设置工作目录」：只给自由会话（项目会话的目录被锁在项目根内，那条用 /dir） */
function menuSetCwd() {
  const c = menu.value?.item;
  menu.value = null;
  if (!c?.id) return;
  cwdForm.id = c.id;
  cwdForm.title = c.title || '未命名会话';
  cwdForm.path = c.cwd || '';
  cwdForm.remote_id = c.remote_id || 0;
  cwdModal.value = true;
}
/** 右键「编辑系统提示词」→ 打开该项目根上的 AGENTS.md（远程项目由后端走 SFTP） */
function menuEditPrompt() {
  const p = menu.value?.item;
  menu.value = null;
  if (!p?.id) return;
  promptTarget.value = { project_id: p.id };
  promptTitle.value = `项目提示词 · ${p.name || ''}`;
  promptOpen.value = true;
}
function menuOpenDir() {
  const p = menu.value?.item;
  menu.value = null;
  if (p?.root_path) store.openInExplorer(p.root_path);
}
function menuCopyPath() {
  const p = menu.value?.item;
  menu.value = null;
  if (p?.root_path) navigator.clipboard.writeText(p.root_path);
}

async function onUpload() {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.onchange = async () => {
    // 与拖拽/粘贴走同一条路：拿到 token 后在输入框上方显示缩略图，发送时拼 [[img:token]]
    await uploadFiles([...(input.files || [])]);
  };
  input.click();
}

const dragging = ref(false);

/**
 * 遮罩只在「真的拖的是文件」时亮。
 * 以前 dragenter/dragover 一律 dragging=true，于是在会话栏里拖动条目排序（HTML5 draggable，
 * types 只有 text/plain）也会把「拖动到此处上传文件」那块遮罩叫出来 —— 他报的那条。
 */
const hasFiles = (e) => {
  const t = e?.dataTransfer?.types;
  if (!t) return false;
  return Array.from(t).includes('Files');
};

function onDragEnter(e) {
  if (hasFiles(e)) dragging.value = true;
}

function onDragOver(e) {
  // 没在亮就不碰：内部排序拖拽每帧都触发 dragover，来回写响应式值白白惹渲染
  if (dragging.value && !hasFiles(e)) dragging.value = false;
  else if (!dragging.value && hasFiles(e)) dragging.value = true;
}

function onDragLeave(e) {
  if (e?.currentTarget && !e.currentTarget.contains(e.relatedTarget)) {
    dragging.value = false;
  }
}

async function onDrop(e) {
  dragging.value = false;
  const files = [...(e.dataTransfer?.files || [])];
  if (files.length) await uploadFiles(files);
}

async function uploadFiles(files) {
  for (const f of files) {
    const fd = new FormData();
    fd.append('file', f);
    if (store.state.chatId) fd.append('chat_id', String(store.state.chatId));
    try {
      const res = await aiApi.uploadChatFile(fd);
      const token = res?.token;
      if (!token) continue;
      attachments.value.push({
        token,
        name: f.name || 'image',
        url: `/api/ai/chat/image/${token}`,
        isImage: (f.type || '').startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(f.name || ''),
      });
    } catch (e) {
      toastErr(e, `上传失败 ${f.name}`);
    }
  }
}

const attachments = ref([]);

function removeAttach(i) {
  attachments.value.splice(i, 1);
}

async function onSend() {
  const toks = attachments.value.map((a) => `[[img:${a.token}]]`).join('\n');
  if (toks) {
    store.state.draft = `${store.state.draft || ''}${store.state.draft ? '\n' : ''}${toks}`;
    attachments.value = [];
  }
  await store.send();
  scrollBottom(true);
}

async function onContinue() {
  await store.send('', { continue: true });
  scrollBottom(true);
}

async function onToolTimeout() {
  try {
    await aiApi.toolTimeout(store.state.chatId);
    toast('已判定超时', 'success');
  } catch (e) {
    toastErr(e, '判定失败');
  }
}

async function onUndo(step) {
  if (step.undone) return toast('这一步已经撤销过了', 'info');
  // 撤销是拿快照去覆盖现在的文件 —— 你在撤销之后手改的内容会被冲掉，且这一步没有二次反悔，
  // 所以必须确认（同名文件被后续再改过时尤其危险）
  const target = step.path || step.args?.path || '该文件';
  if (!(await confirmDialog(`撤销这一步？${target} 会回到操作前的样子，这期间你手动改进去的内容会被覆盖。`, { title: '撤销确认', danger: true, okText: '撤销' }))) return;
  try {
    const res = await store.undo(step);
    if (!res) return toast('这条操作没有可恢复的快照', 'warn');
    toast(`已撤销${res.path ? `：${res.path}` : ''}`, 'success');
  } catch (e) {
    toastErr(e, '撤销失败');
  }
}

async function onRetract(payload) {
  const messageId = typeof payload === 'object' ? payload.id || payload.msgId : payload;
  const text = typeof payload === 'object' ? payload.content || '' : '';
  if (!messageId) return toast('无效的消息ID', 'warn');
  if (!(await confirmDialog('撤回这条消息？它之后的内容一并删除，原文回到输入框。'))) return;
  try {
    // 旧版逻辑：立刻中断生成并从界面移除该用户消息及其后内容
    store.stop();
    const idx = store.state.messages.findIndex((m) => m.role === 'user' && m.id === messageId);
    if (idx >= 0) store.state.messages.splice(idx);
    delete store.state.msgBuf[store.state.chatId];
    const r = await aiApi.retractChat({ chat_id: store.state.chatId, message_id: messageId });
    // 服务端按「实测开销 + 剩余正文」把用量绝对落回去并随响应带回来，这里立刻写上：
    // 以前只减正文估数，扣完还剩一大坨 system + 工具 schema，右侧百分比看着像一点没动（第七十六轮他报的那条）
    if (r?.usage && Number.isFinite(Number(r.usage.used))) store.state.contextUsed = Number(r.usage.used);
    await store.openChat(store.state.chatId);
    store.state.draft = text;
    toast('已撤回，内容已回到输入框', 'success');
  } catch (e) {
    toastErr(e, '撤回失败');
  }
}

/**
 * 「从此回退」：消息一条不删，把这条之后改过的文件退回原样（撤回只删消息不动文件）。
 * 服务端按倒序应用快照，同一条被改几轮会退到最早那份；失败的不标已撤销，还能单条重试。
 */
async function onRevertFrom(payload) {
  const messageId = typeof payload === 'object' ? payload.id : payload;
  if (!messageId) return toast('无效的消息ID', 'warn');
  if (store.state.busy) return toast('正在生成，先停下再回退文件', 'warn');
  if (!(await confirmDialog('从此回退？这条之后的所有文件改动会退回原样，消息全部保留（Computer Use 的键鼠动作无法回退）。'))) return;
  try {
    const d = await aiApi.undoFromMessage({ chat_id: store.state.chatId, message_id: messageId }) || {};
    const bits = [];
    if (d.done) bits.push(`已回退 ${d.done} 处`);
    if (d.skipped) bits.push(`${d.skipped} 处跳过（此前已单独撤销或不属于本会话）`);
    if (d.failed && d.failed.length) bits.push(`${d.failed.length} 处失败，可单条重试`);
    toast(bits.length ? bits.join('，') : '这一段没有可回退的文件改动', d.done ? 'success' : 'warn');
    await store.openChat(store.state.chatId);   // 回退说明会写进最后一条回复，重新拉一次才对得上
  } catch (e) {
    toastErr(e, '从此回退失败');
  }
}

/** 队列里的消息是用户已经打好的字，一清就没地方找了，所以必须确认（并报数量） */
async function onClearQueue() {
  const mine = store.queued.value;   // 只清这一条会话的：横幅数的是当前会话，按钮也不能顺手清掉别条会话攒的话
  const n = mine.length;
  if (!n) return;
  if (!(await confirmDialog(`清空队列里剩下的 ${n} 条消息？这些内容会被丢弃，输入框里正在写的不动。`))) return;
  store.state.queue = store.state.queue.filter((q) => !mine.includes(q));
  toast('已清空队列', 'info');
}

async function onApprove(allow) {
  await store.decideApproval(allow);
}

async function onAnswer(payload) {
  await store.answerQuestion(payload);
}

async function onUpdateTask(id, patch) {
  await store.updateTask(id, patch);
}

function cycleModel() {
  const n = store.state.models.length;
  if (!n) return;
  store.state.modelIdx = (store.state.modelIdx + 1) % n;
  store.persistModel();
}

function onPickModel(m) {
  const idx = store.state.models.findIndex((x) => x.id === m.id);
  if (idx >= 0) {
    store.state.modelIdx = idx;
    store.persistModel();
  }
}

const pickerModels = computed(() => store.state.models);

/** 发送栏下拉不给异常模型（迁移后 280 个里 135 个异常，翻找成本太高）；当前正在用的那个保留 */
const composerModels = computed(() => {
  const cur = store.state.models[store.state.modelIdx];
  return store.state.models.filter((m) => m.status !== 'error' || (cur && m.id === cur.id));
});

/* ---------------- 侧栏提问（只读旁路） ---------------- */
const sbState = sb.state;
const sidebarModels = computed(() => composerModels.value.map((m) => ({ value: m.id, label: m.display_name || m.model_id })));

// 主会话换了目录 / 模型 / 会话，侧栏跟着走（侧栏里锁定了目录就不跟）
watch(
  () => [store.state.cwd, store.state.chatId, store.currentModel.value?.id],
  ([cwd, chatId, modelId]) => sb.setContext({ cwd, chatId, modelRowId: modelId || 0 }),
  { immediate: true },
);

function onPinModel(m, on) {
  store.toggleModelPin(m.id, on);
}

function selectModel(id) {
  const idx = store.state.models.findIndex((m) => m.id === id);
  if (idx >= 0) {
    store.state.modelIdx = idx;
    store.persistModel();
  }
}

function setApproval(mode) {
  if (mode === 'follow') store.followGlobalApproval();
  else store.setApprovalMode(mode);
}

function setThinking(level) {
  store.setThinkingLevel(level);
}

const thinkingLevels = computed(() => {
  const m = store.currentModel.value;
  const raw = m?.thinking_levels || '';
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
});

function cycleApproval() {
  // FULL-SEND 不进这个循环：顶栏连点是「快速切换」，不该让人一不留神点到越级档上；
  // 但当前已经是 fullsend 时必须能靠它出来（否则只能去下拉里翻）。
  const order = ['default', 'strict', 'exempt'];
  if (store.state.approvalMode === 'fullsend') return store.setApprovalMode('default');
  const next = order[(order.indexOf(store.state.approvalMode) + 1) % order.length];
  store.setApprovalMode(next);
}

/* ---------- 首次启动：选 Shell（本机没设过 agent_shell 时问一次） ---------- */
const shellOpen = ref(false);
const shellChoices = ref([]);

async function maybeAskShell() {
  try {
    if (localStorage.getItem('nu_shell_asked') === '1') return;
    const sh = await aiApi.getShell();
    shellChoices.value = (sh?.candidates || []).map((c) => ({
      value: c.value || c.path || String(c),
      label: c.label || (c.value || '').split(/[\\/]/).pop(),
      missing: !!c.missing,
    }));
    if (!sh?.is_set && shellChoices.value.length) shellOpen.value = true;
    else localStorage.setItem('nu_shell_asked', '1');
  } catch { /* 拿不到就不打扰 */ }
}

async function pickShell(value) {
  try {
    await aiApi.setShell(value);
    localStorage.setItem('nu_shell_asked', '1');
    shellOpen.value = false;
    toast('默认 Shell 已设置', 'success');
  } catch (e) {
    toastErr(e, '设置失败');
  }
}

function skipShell() {
  localStorage.setItem('nu_shell_asked', '1');
  shellOpen.value = false;
}

async function loadSkills() {
  try {
    const res = await aiApi.getSkills();
    skillList.value = res?.list || res || [];
  } catch {
    skillList.value = [];
  }
}

async function applySkills() {
  const okSaved = await store.saveSkills(skillsChecked.value);
  if (!okSaved) return;
  store.state.skillsPicker = false;
  toast(skillsChecked.value.length ? `已加载 ${skillsChecked.value.length} 个技能` : '已清空本会话技能', 'success');
}

function togglePool(id) {
  const i = poolOrder.value.indexOf(id);
  if (i >= 0) poolOrder.value.splice(i, 1);
  else poolOrder.value.push(id);
}

function poolPos(id) {
  const i = poolOrder.value.indexOf(id);
  return i >= 0 ? i + 1 : '';
}

function applyPool() {
  store.state.pool = poolOrder.value.slice();
  store.state.autoMode = store.state.pool.length > 1;
  if (store.state.pool.length) {
    const idx = store.state.models.findIndex((m) => m.id === store.state.pool[0]);
    if (idx >= 0) store.state.modelIdx = idx;
  }
  store.state.poolPicker = false;
  toast(`模型池 ${store.state.pool.length} 个`, 'success');
}
</script>

<style scoped>
.chat-page {
  position: relative;
  display: flex;
  /* 不能用 100vh：Electron 那条自绘顶栏占掉的那一行不在「视口」之外，照 100vh 排会整页超出 34px，
     于是左栏底部「选项」、输入框、终端胶囊全被推到屏幕外。--kh-bar-h 只在无框时有值，
     浏览器里回落到 0，行为和以前完全一致。 */
  height: calc(100vh - var(--kh-bar-h, 0px));
  min-height: 0;
  background: var(--bg);
  /* 浏览器栏收起时是「滑到窗口右边界外」，仍占 420px 排版盒；
     不裁掉横向溢出的话整个页面会多出一条横向滚动条 */
  overflow-x: clip;
}
.drop-veil {
  position: absolute;
  inset: 0;
  z-index: 50;
  display: grid;
  place-items: center;
  background: var(--scrim);
  pointer-events: none;
}
.drop-card {
  background: var(--surface-pop);
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius);
  padding: 28px 36px;
  text-align: center;
  color: var(--text);
  box-shadow: var(--shadow);
}
.drop-card i {
  font-size: 28px;
  margin-bottom: 10px;
}
.resizer {
  width: 5px;
  cursor: col-resize;
  flex-shrink: 0;
  background: transparent;
  transition: background var(--dur) var(--ease);
}
.resizer:hover { background: var(--border-strong); }
.chat-page.immersive .rail,
.chat-page.immersive .dock,
.chat-page.immersive .resizer {
  display: none !important;
}
/* 窄屏专用按钮：宽屏隐藏 */
.narrow-only { display: none !important; }
.drawer-mask { display: none; }
@media (max-width: 960px) {
  .narrow-only { display: inline-flex !important; }
  .resizer { display: none; }
  /* 左右栏改成覆盖式抽屉，窄屏也能切会话 / 看面板（以前是直接隐藏，等于没法用） */
  .chat-page :deep(.rail),
  .chat-page :deep(.dock) {
    position: fixed;
    /* 顶边从自绘顶栏下面开始（--kh-bar-h 只在无框时有值），并且靠 top+bottom 定高，
       再写 height:100vh 就会把整条抽屉推到屏幕外一截 */
    top: var(--kh-bar-h, 0px);
    bottom: 0;
    z-index: 60;
    box-shadow: var(--shadow);
    transition: transform 0.18s var(--ease);
  }
  .chat-page :deep(.rail) {
    left: 0;
    width: var(--rail-w, 260px);
    transform: translateX(-105%);
  }
  .chat-page :deep(.dock) {
    right: 0;
    width: var(--dock-w, 300px);
    transform: translateX(105%);
  }
  .chat-page.rail-open :deep(.rail),
  .chat-page.dock-open :deep(.dock) { transform: none; }
  /* 窄屏左右栏本来就是抽屉，「收起成一颗把手」在这儿没意义：把手藏掉，
     否则 .rail.collapsed 的 36px 会把抽屉压成一条缝 */
  .chat-page :deep(.rail-toggle) { display: none; }
  .chat-page :deep(.rail.collapsed) { width: var(--rail-w, 260px); }
  /* 侧栏提问在窄屏也走覆盖式：它是 v-if 挂上来的，只需要浮起来不挤聊天区 */
  .chat-page :deep(.sb) {
    position: fixed;
    top: var(--kh-bar-h, 0px);
    right: 0;
    bottom: 0;
    z-index: 60;
    box-shadow: var(--shadow);
  }
  .drawer-mask {
    display: block;
    position: fixed;
    inset: 0;
    z-index: 55;
    background: var(--scrim);
  }
  .title-actions .toggle-btn span { display: none; }
}
@media (max-width: 640px) {
  .stream { padding: 8px 12px 12px; }
  .composer { padding: 8px 10px 12px; }
}
.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--bg-main);
}
.titlebar {
  height: 44px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 14px;
  border-bottom: 1px solid var(--border-soft);
  flex-shrink: 0;
}
.title {
  font-weight: 500;
  overflow: visible;
  text-overflow: ellipsis;
  white-space: nowrap;
  position: relative;
  display: flex;
  align-items: center;
}
.icon-btn.more {
  margin-left: 6px;
}
/* 弹层外观统一由 tokens.css 的 .title-menu 提供，这里只定位 */
.title-menu {
  position: absolute;
  top: 32px;
  left: 0;
  z-index: 40;
  min-width: 168px;
}
.title .cwd {
  font-family: var(--mono);
  font-size: 11px;
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: inline-block;
  vertical-align: bottom;
}
.title-actions {
  margin-left: auto;
  display: flex;
  gap: 6px;
  /* 按钮排自己不许被压扁、也不许换行：放不下时由 tight 收成纯图标 */
  flex: 0 0 auto;
  flex-wrap: nowrap;
}
.title-actions.tight .toggle-btn {
  width: 26px;
  padding: 0;
  justify-content: center;
}
.title-actions.tight .toggle-btn span {
  display: none;
}
/* 折起来的那一排：grid 的 0fr→1fr 是能动画的写法（width:auto 不行），
   里面一层 overflow:hidden 负责把没展完的部分裁掉。 */
.ta-fold {
  display: grid;
  grid-template-columns: 0fr;
  opacity: 0;
  visibility: hidden;
  transition: grid-template-columns 0.22s var(--ease, ease), opacity 0.16s ease,
    visibility 0s linear 0.22s;
}
.title-actions.expanded .ta-fold {
  grid-template-columns: 1fr;
  opacity: 1;
  visibility: visible;
  transition-delay: 0s;
}
.ta-fold-in {
  display: flex;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
}
/* 展开热区：比 ">" 大一圈（上 16 / 左右各 9 / 下 18），靠负 margin 抵掉占位，布局不动 */
.ta-hot {
  display: inline-flex;
  align-items: center;
  padding: 16px 9px 18px;
  margin: -16px -9px -18px 0;
}
/* 最右那颗「还有开关」的提示：平时静态摆着，展开后图标转 180° 表示可以收回去 */
.ta-expand {
  width: 28px;
  height: 28px;
  border-radius: var(--radius-xs);
  color: var(--text-3);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
}
.ta-expand:hover { background: var(--bg-hover); color: var(--text); }
.title-actions.expanded .ta-expand { color: var(--text); }
.ta-expand i { transition: transform 0.22s var(--ease, ease); }
.title-actions.expanded .ta-expand i { transform: rotate(180deg); }

  html[data-motion='off'] .ta-fold,

  html[data-motion='off'] .ta-expand i{ transition: none; }

.title {
  position: relative;
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  /* 这里绝不能 overflow:hidden —— 会话菜单 .title-menu 是 .title 的绝对定位子节点，
     容器一裁它就整个看不见（表现为「三点了没反应」）。长标题的省略号交给下面的
     .title > span 自己做，效果一样。 */
  overflow: visible;
}
.title > span {
  white-space: nowrap;
}
/* 标题先被省略号收，实在挤不动才轮到右侧那排按钮降级成纯图标 */
.title > span:not(.cwd) {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.icon-btn.more {
  margin-left: 4px;
}
/* 新建远端项目弹窗里的说明行 */
.hint-line {
  font-size: 11px;
  line-height: 1.6;
  display: flex;
  gap: 6px;
  align-items: flex-start;
}
.hint-line i { margin-top: 2px; }
/* 项目根目录那一行：输入框吃满宽度，「浏览…」贴在右下与输入框对齐（KInput 带标题，标题占掉一行） */
.path-row {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}
.path-row > :first-child {
  flex: 1 1 auto;
  min-width: 0;
}
.path-row .pick-dir {
  flex: 0 0 auto;
  margin-bottom: 1px;
  white-space: nowrap;
}
.toggle-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font-size: 11.5px;
  flex: 0 0 auto;
  white-space: nowrap;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease),
    border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}
.toggle-btn:hover {
  border-color: var(--border-strong);
}
/* 开着 = 白高光一点，不是整颗翻白：底色只提一档、描边亮一点、顶部一道内高光。
   （--accent 在这几套深色主题里就是纯白，用它当底会把开关条糊成一排白块） */
.toggle-btn.on {
  background: var(--bg-active);
  color: var(--text);
  border-color: var(--border-hover);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.22), 0 0 10px rgba(255, 255, 255, 0.07);
}
.icon-btn {
  width: 28px;
  height: 28px;
  border-radius: var(--radius-xs);
  color: var(--text-2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.icon-btn:hover { background: var(--bg-hover); color: var(--text); }
.icon-btn.on {
  background: var(--bg-active);
  color: var(--text);
}
.stream-wrap {
  flex: 1;
  min-height: 0;
  display: flex;
}
.stream {
  flex: 1;
  overflow: auto;
  min-height: 0;
  padding: 8px 28px 16px;
  background: var(--bg-main);
}
.stream-inner {
  max-width: var(--msg-w, 860px);
  margin: 0 auto;
}
.msg-enter-active {
  animation: msg-rise 0.22s var(--ease) both;
}
@keyframes msg-rise {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
.empty {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--text-3);
}
.empty h2 {
  margin: 0;
  font-size: 16px;
  color: var(--text-2);
}
.gen-actions {
  max-width: 860px;
  margin: 0 auto 6px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.gen-actions .cmd-hint {
  flex: 1;
  min-width: 0;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.k-btn.warn { color: var(--warn); border-color: var(--warn); }
/* 本轮出错的红条：错误不再混进正文，且给一键重发 */
.err-bar {
  max-width: 860px;
  margin: 0 auto 8px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  font-size: 12px;
  color: var(--danger);
  background: var(--danger-soft);
  border: 1px solid var(--danger-line);
  border-radius: var(--radius-sm);
}
.err-bar .err-text {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 首次启动的 Shell 选择 */
.shell-list { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; }
.shell-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 12px;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text);
  font-size: 13px;
}
.shell-item:hover:not(:disabled) { border-color: var(--accent); }
.shell-item:disabled { opacity: 0.45; cursor: not-allowed; }
/* 轨迹跳转后的高亮闪烁 */
:deep(.trace-flash), .trace-flash {
  animation: trace-flash 1.7s var(--ease);
  border-radius: var(--radius-sm);
}
@keyframes trace-flash {
  0%, 55% { background: var(--gold-soft); box-shadow: 0 0 0 2px var(--gold-line); }
  100% { background: transparent; box-shadow: none; }
}
.recycle-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
  border-bottom: 1px solid var(--border-soft);
}
.recycle-row .grow { flex: 1; min-width: 0; }
.muted { color: var(--text-3); }
.run-status {
  max-width: 860px;
  margin: 0 auto 6px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--text-3);
}
.run-status .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-3);
}
.run-status.busy .dot {
  background: var(--ok);
  animation: pulse-soft 1.2s ease-in-out infinite;
  box-shadow: 0 0 0 3px var(--ok-soft);
}
.run-status.warn .dot { background: var(--warn); }
.run-status .dim { opacity: 0.85; }
.run-status .warn { color: var(--warn); }
@keyframes pulse-soft {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
.safe-strip {
  max-width: 860px;
  margin: 0 auto 6px;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.safe-strip .chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-2);
  background: var(--bg-panel);
  border: 1px solid var(--border-soft);
  border-radius: 999px;
  padding: 3px 10px;
}
.safe-strip .x {
  margin-left: 2px;
  color: var(--text-3);
}
.muted { color: var(--text-3); }
.skill-list { display: flex; flex-direction: column; gap: 8px; }
.skill-item {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 8px;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  background: var(--bg-panel);
}
.skill-item.on { border-color: var(--accent); }
.skill-name { font-weight: 600; }
.skill-desc { color: var(--text-3); font-size: 12px; }
.pool-list { display: flex; flex-direction: column; gap: 6px; }
.pool-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-sm);
  background: var(--bg-panel);
  color: var(--text);
}
.pool-item.selected { border-color: var(--accent); }
.pool-item .idx {
  width: 20px;
  text-align: center;
  color: var(--text-3);
  font-family: var(--mono);
}
.pool-item i { margin-left: auto; color: var(--ok); }
.btn {
  border: 1px solid var(--border);
  background: var(--bg-hover);
  color: var(--text);
  border-radius: var(--radius-xs);
  padding: 6px 12px;
  font-size: 12px;
}
</style>
