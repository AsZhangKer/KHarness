// 小鲸鱼互动挂件 —— 移植自 DeepSeek-Balance-Whale-Widget（DSH 插件）
// 纯互动玩具：无余额/计费/用量功能。点击鲸鱼弹出一条随机台词，再点关闭，5 秒自动收起。
// 保留：拖拽 + 四边吸附、左侧镜像、按压 Q 弹 + 音效、随机台词、外观菜单（大小/音效/音量/气泡/避让滚动条）。
// 用法：mountWhaleWidget() 返回 { destroy, setVisible }；全局单例。

let instance = null;

export function mountWhaleWidget() {
  if (instance) return instance;
  instance = createWidget();
  return instance;
}

function createWidget() {
  var MIN_SCALE = 0.6;
  var MAX_SCALE = 2.5;
  var CLICK_SQ = 9;
  var BUBBLE_MS = 5000;
  // 锚点存储版本：默认停靠边改过一次（左 → 右），旧记录里的 hAnchor:'left' 会被当成「没存过」，
  // 这样这次改默认值才真的能生效；用户之后自己拖去左边会重新写回新格式。
  var ANCHOR_VERSION = 3;
  var SIZE_URL = '/api/ai/whale/config';
  var IMG_URL = '/whale/DSniang1.png?v=2';
  var GIF_URL = '/whale/rua.gif';

  var css = [
    '.dshwv-root{position:fixed;left:0;bottom:0;--dshw-scale:1;--dshw-base:clamp(122px,calc(min(250px,min(100vw,100vh) * 0.28) * var(--dshw-scale)),625px);width:var(--dshw-base);height:var(--dshw-base);pointer-events:none;user-select:none;-webkit-user-select:none;z-index:9999;font-family:inherit;transition:left .16s ease,top .16s ease,transform .3s ease}',
    '.dshwv-root.dshwv-left{transform:scaleX(-1)}',
    '.dshwv-root.dshwv-dragging{cursor:grabbing;transition:none}',
    '.dshwv-body{position:absolute;left:0;top:0;width:100%;height:100%;transform-origin:50% 100%;transition:transform .22s cubic-bezier(.34,1.56,.64,1)}',
    '.dshwv-img{position:absolute;right:0;bottom:0;width:59.45%;height:59.45%;display:block;pointer-events:none;-webkit-user-drag:none;user-select:none}',
    '.dshwv-bubble{position:absolute;left:0;top:0;width:100%;aspect-ratio:1026/700;pointer-events:none;z-index:1;--dshw-u:calc(var(--dshw-base) / 1026)}',
    '.dshwv-bubble svg{display:block;width:100%;height:100%;pointer-events:none}',
    '.dshwv-bubble svg path,.dshwv-bubble svg ellipse{pointer-events:none;cursor:pointer}',
    '.dshwv-bubble.dshwv-bubble-open svg path,.dshwv-bubble.dshwv-bubble-open svg ellipse{pointer-events:visiblePainted}',
    '.dshwv-bubble .dshwv-bshape,.dshwv-bubble .dshwv-b1,.dshwv-bubble .dshwv-b2{opacity:0;transform:scale(.7);transform-box:fill-box;transform-origin:50% 50%;transition:opacity .2s ease,transform .2s ease}',
    '.dshwv-bubble.dshwv-bubble-open .dshwv-bshape,.dshwv-bubble.dshwv-bubble-open .dshwv-b1,.dshwv-bubble.dshwv-bubble-open .dshwv-b2{opacity:1;transform:none}',
    '.dshwv-gif{position:absolute;left:44.25%;top:38%;transform:translate(-50%,-50%);max-width:calc(var(--dshw-u) * 560);max-height:calc(var(--dshw-u) * 400);display:none;opacity:0;transition:opacity .2s ease;pointer-events:none;-webkit-user-drag:none;user-select:none;object-fit:contain}',
    '.dshwv-root.dshwv-left .dshwv-gif{transform:translate(-50%,-50%) scaleX(-1)}',
    '.dshwv-bubble.dshwv-bubble-open .dshwv-gif{opacity:1}',
    '.dshwv-text{position:absolute;left:44.25%;top:38%;transform:translate(-50%,-50%);text-align:center;color:#536ba9;line-height:1.2;white-space:normal;max-width:calc(var(--dshw-u) * 560);pointer-events:none;opacity:0;transition:opacity .16s ease,transform .3s ease}',
    '.dshwv-bubble.dshwv-bubble-open .dshwv-text{opacity:1;transition:opacity .16s ease .3s,transform .3s ease}',
    '.dshwv-root.dshwv-left .dshwv-text{transform:translate(-50%,-50%) scaleX(-1)}',
    '.dshwv-line{font-size:calc(var(--dshw-u) * 64);font-weight:600;letter-spacing:.04em}',
    '.dshwv-menu-btn{position:absolute;top:calc(40.55% + 4px);right:4px;width:26px;height:26px;border:none;border-radius:6px;background:rgba(32,49,112,.85);cursor:pointer;pointer-events:auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;padding:0;z-index:2;opacity:0;transition:opacity .15s ease}',
    '.dshwv-menu-btn.dshwv-menu-btn-visible{opacity:1}',
    '.dshwv-menu-btn span{display:block;width:14px;height:2px;background:#fff;border-radius:1px}',
    '.dshwv-menu-btn:hover{background:#203170}',
    '.dshwv-menu{position:fixed;min-width:196px;background:rgba(255,255,255,.92);border:1px solid rgba(32,49,112,.35);border-radius:10px;padding:10px 12px;opacity:0;transform:scale(.92) translateY(-4px);transform-origin:top right;transition:opacity .18s ease,transform .2s cubic-bezier(.34,1.56,.64,1);pointer-events:none;z-index:10000;box-shadow:0 6px 18px rgba(0,0,0,.18);color-scheme:light}',
    '.dshwv-menu.dshwv-menu-open{opacity:1;transform:scale(1) translateY(0);pointer-events:auto}',
    '.dshwv-menu-row{display:flex;align-items:center;gap:8px;margin:5px 0;color:#203170;font-size:12px;white-space:nowrap}',
    '.dshwv-range{flex:1;min-width:0;accent-color:#203170}',
    '.dshwv-number{width:44px;border:1px solid rgba(32,49,112,.4);border-radius:6px;padding:2px 4px;font-size:12px;color:#203170;background:#fff;box-sizing:border-box}',
    '.dshwv-number:disabled{opacity:.4;background:rgba(32,49,112,.06);cursor:not-allowed}',
    '.dshwv-sound{flex:1;border:1px solid rgba(32,49,112,.4);border-radius:6px;background:rgba(32,49,112,.08);color:#203170;font-size:12px;padding:3px 0;cursor:pointer}',
    '.dshwv-sound:hover{background:rgba(32,49,112,.16)}',
    '.dshwv-check{width:16px;height:16px;accent-color:#203170;cursor:pointer;flex:0 0 auto}',
    '.dshwv-menu-sep{height:1px;background:rgba(32,49,112,.25);margin:6px 0}',
    '.dshwv-volpct{width:44px;text-align:right;color:#203170;font-size:12px}'
  ].join('\n');

  var styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  var root = document.createElement('div');
  // 默认停靠在右侧（素材原朝向就是往左看），左侧才需要镜像
  root.className = 'dshwv-root';

  var img = document.createElement('img');
  img.className = 'dshwv-img';
  img.src = IMG_URL;
  img.alt = '小鲸鱼';
  img.draggable = false;

  var menuBtn = document.createElement('button');
  menuBtn.type = 'button';
  menuBtn.className = 'dshwv-menu-btn';
  menuBtn.title = '菜单';
  menuBtn.innerHTML = '<span></span><span></span><span></span>';
  menuBtn.addEventListener('click', function (e) { e.stopPropagation(); toggleMenu() });

  var menuBox = document.createElement('div');
  menuBox.className = 'dshwv-menu';
  function menuLabel(text) {
    var s = document.createElement('span');
    s.textContent = text;
    return s;
  }
  function menuRow() {
    var r = document.createElement('div');
    r.className = 'dshwv-menu-row';
    return r;
  }
  var scaleInput = document.createElement('input');
  scaleInput.type = 'range';
  scaleInput.min = String(MIN_SCALE);
  scaleInput.max = String(MAX_SCALE);
  scaleInput.step = '0.1';
  scaleInput.className = 'dshwv-range';
  scaleInput.value = '1.5';
  var scaleNumber = document.createElement('input');
  scaleNumber.type = 'number';
  scaleNumber.min = '1';
  scaleNumber.max = '20';
  scaleNumber.step = '1';
  scaleNumber.className = 'dshwv-number';
  scaleNumber.value = '10';
  scaleInput.addEventListener('pointerdown', function () { root.style.transition = 'none' });
  scaleInput.addEventListener('input', function () { setScale(scaleInput.value) });
  scaleInput.addEventListener('change', function () { root.style.transition = '' });
  scaleNumber.addEventListener('focus', function () { root.style.transition = 'none' });
  scaleNumber.addEventListener('blur', function () { root.style.transition = '' });
  scaleNumber.addEventListener('input', function () {
    var v = Math.round(Number(scaleNumber.value));
    var s = MIN_SCALE + Math.max(0, Math.min(20, v) - 1) * (MAX_SCALE - MIN_SCALE) / 19;
    setScale(s);
  });
  scaleNumber.addEventListener('change', function () {
    var v = Math.round(Number(scaleNumber.value));
    var s = MIN_SCALE + Math.max(0, Math.min(20, v) - 1) * (MAX_SCALE - MIN_SCALE) / 19;
    setScale(s);
    root.style.transition = '';
  });
  var soundSelect = document.createElement('select');
  soundSelect.className = 'dshwv-sound';
  function soundOpt(value, label) {
    var o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    return o;
  }
  soundSelect.appendChild(soundOpt('duck', '小黄鸭'));
  soundSelect.appendChild(soundOpt('fx1', '音效1'));
  soundSelect.addEventListener('change', function () { setSoundSet(soundSelect.value) });
  var bubbleToggle = document.createElement('input');
  bubbleToggle.type = 'checkbox';
  bubbleToggle.className = 'dshwv-check';
  bubbleToggle.checked = true;
  bubbleToggle.title = '开启/关闭台词气泡';
  bubbleToggle.addEventListener('change', function () { setBubbleOn(bubbleToggle.checked) });
  var scrollGapToggle = document.createElement('input');
  scrollGapToggle.type = 'checkbox';
  scrollGapToggle.className = 'dshwv-check';
  scrollGapToggle.checked = false;
  scrollGapToggle.title = '开启后挂件右侧按设定像素避开滚动条；关闭则贴边（盖住滚动条）';
  scrollGapToggle.addEventListener('change', function () { setScrollGapOn(scrollGapToggle.checked) });
  var scrollGapInput = document.createElement('input');
  scrollGapInput.type = 'number';
  scrollGapInput.min = '0';
  scrollGapInput.step = '1';
  scrollGapInput.className = 'dshwv-number';
  scrollGapInput.value = '17';
  scrollGapInput.disabled = true; // 默认避让关 → 宽度不可修改，勾选后启用
  scrollGapInput.title = '避让滚动条的像素宽度，填 0 表示贴边';
  scrollGapInput.addEventListener('input', function () { setScrollGapPx(scrollGapInput.value) });
  scrollGapInput.addEventListener('change', function () { setScrollGapPx(scrollGapInput.value) });
  var row1 = menuRow();
  row1.appendChild(menuLabel('大小'));
  row1.appendChild(scaleInput);
  row1.appendChild(scaleNumber);
  var row2 = menuRow();
  row2.appendChild(menuLabel('音效'));
  row2.appendChild(soundSelect);
  var volInput = document.createElement('input');
  volInput.type = 'range';
  volInput.min = '0';
  volInput.max = '1';
  volInput.step = '0.05';
  volInput.className = 'dshwv-range';
  volInput.value = '0.9';
  var volPct = document.createElement('span');
  volPct.className = 'dshwv-volpct';
  volPct.textContent = '90%';
  volInput.addEventListener('input', function () { setVol(volInput.value) });
  var row3 = menuRow();
  row3.appendChild(menuLabel('音量'));
  row3.appendChild(volInput);
  row3.appendChild(volPct);
  var row4 = menuRow();
  row4.appendChild(menuLabel('气泡'));
  row4.appendChild(bubbleToggle);
  var menuSep = document.createElement('div');
  menuSep.className = 'dshwv-menu-sep';
  var row5 = menuRow();
  row5.appendChild(menuLabel('避让滚动条'));
  row5.appendChild(scrollGapToggle);
  row5.appendChild(menuLabel('宽度'));
  row5.appendChild(scrollGapInput);
  row5.appendChild(menuLabel('px'));
  menuBox.appendChild(row1);
  menuBox.appendChild(row2);
  menuBox.appendChild(row3);
  menuBox.appendChild(row4);
  menuBox.appendChild(menuSep);
  menuBox.appendChild(row5);

  var textBox = document.createElement('div');
  textBox.className = 'dshwv-text';
  var lineEl = document.createElement('div');
  lineEl.className = 'dshwv-line';
  textBox.appendChild(lineEl);

  var bubbleBox = document.createElement('div');
  bubbleBox.className = 'dshwv-bubble';
  bubbleBox.innerHTML = '<svg viewBox="0 0 1026 700" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">' +
    '<path class="dshwv-bshape" fill="#FFFFFF" stroke="#203170" stroke-width="18" stroke-linejoin="round" stroke-linecap="round" d="M 827 248 A 373 232 0 1 0 81 246 A 373 232 0 0 0 301 465 A 57 32 10 0 0 413 484 A 373 232 0 0 0 827 248 Z"/>' +
    '<ellipse class="dshwv-b1" cx="352" cy="561" rx="37.5" ry="26" fill="#FFFFFF" stroke="#203170" stroke-width="18"/>' +
    '<ellipse class="dshwv-b2" cx="442" cy="646" rx="24.5" ry="18" fill="#FFFFFF" stroke="#203170" stroke-width="18"/>' +
    '</svg>';
  var gifEl = document.createElement('img');
  gifEl.className = 'dshwv-gif';
  gifEl.src = GIF_URL;
  gifEl.alt = '';
  gifEl.draggable = false;
  bubbleBox.appendChild(gifEl);
  var gifFailed = false;
  gifEl.onerror = function () { gifFailed = true };
  bubbleBox.appendChild(textBox);
  bubbleBox.addEventListener('click', function (e) {
    e.stopPropagation();
    if (!bubbleShown) return;
    // 再点一次：关闭
    hideBubble();
  });

  var body = document.createElement('div');
  body.className = 'dshwv-body';
  body.appendChild(img);
  body.appendChild(bubbleBox);
  root.appendChild(body);
  root.appendChild(menuBtn);
  document.body.appendChild(root);
  document.body.appendChild(menuBox);

  // 位置模型：始终用 left/top 表达（贴边吸附靠 CSS 过渡平滑动画）；默认停靠在右下角
  var state = {
    scale: 1.5,
    h: 'right',
    hOff: 0,
    v: 'bottom',
    vOff: 0,
    left: 0,
    top: 0
  };
  var settleTimer = null;
  var drag = null;
  var bubbleShown = false;
  var bubbleTimer = null;
  var gifFadeTimer = null;

  // 随机台词（加权随机；含 gif 段）
  function pickOne(arr) { return arr[Math.floor(Math.random() * arr.length)] }
  function singleLine(text, wrap) { return { t: text, w: !!wrap, gif: false } }
  var RANDOM_GROUPS = [
    { w: 10, lines: function () { return { gif: true } } },
    { w: 7, lines: function () { return singleLine(pickOne(['好模型... ↓', '好女孩...↓'])) } },
    { w: 7, lines: function () { return singleLine(pickOne(['不知道用户有什么用，先赶走吧~', '我...我...我也要挣钱吗？', '我去吃饭啦，测完叫我', '压力一只蓝色大肥鱼？！', 'DeepSleep...', '坏了...用户彻底怒了！']), true) } },
    { w: 3, lines: function () { return singleLine(pickOne(['你目录里的dsh是什么...大烧货吗...?', '恭喜你实现token自由！token全跑了！', '真当我是便宜货啊...']), true) } },
    { w: 1, lines: function () { return singleLine('哦鲸鲸... ') } }
  ];
  function pickRandomLine() {
    var total = 0;
    for (var i = 0; i < RANDOM_GROUPS.length; i++) total += RANDOM_GROUPS[i].w;
    var r = Math.random() * total;
    for (var i = 0; i < RANDOM_GROUPS.length; i++) {
      r -= RANDOM_GROUPS[i].w;
      if (r < 0) return RANDOM_GROUPS[i].lines();
    }
    return RANDOM_GROUPS[RANDOM_GROUPS.length - 1].lines();
  }
  function applyLine(line) {
    if (line && line.gif) {
      // gif 段：只显示 gif，隐藏文字
      if (gifFailed) {
        line = singleLine(pickOne(['gif 加载失败了...', '今天没有动图给你看~', '呜呜 动图不见了...']), true);
      } else {
        if (gifFadeTimer) { clearTimeout(gifFadeTimer); gifFadeTimer = null }
        gifEl.style.display = 'block';
        gifEl.style.opacity = '';
        lineEl.style.display = 'none';
        return;
      }
    }
    if (gifFadeTimer) { clearTimeout(gifFadeTimer); gifFadeTimer = null }
    gifEl.style.display = 'none';
    gifEl.style.opacity = '';
    lineEl.style.display = '';
    lineEl.textContent = line.t;
  }
  function showBubble() {
    if (!bubbleOn) return;
    if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null }
    if (gifFadeTimer) { clearTimeout(gifFadeTimer); gifFadeTimer = null }
    bubbleShown = true;
    // 点击直接弹随机一条文本
    applyLine(pickRandomLine());
    bubbleBox.classList.add('dshwv-bubble-open');
    bubbleTimer = setTimeout(hideBubble, BUBBLE_MS);
  }
  function hideBubble() {
    if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null }
    bubbleShown = false;
    bubbleBox.classList.remove('dshwv-bubble-open');
    // gif 靠 CSS opacity 过渡淡出；等淡出完成再隐藏
    gifFadeTimer = setTimeout(function () {
      gifFadeTimer = null;
      gifEl.style.display = 'none';
    }, 240);
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v) }
  function viewport() {
    return {
      w: window.innerWidth || document.documentElement.clientWidth || 1280,
      h: window.innerHeight || document.documentElement.clientHeight || 800
    };
  }
  function rightGap() {
    // 开关关闭：贴边（不避让滚动条）；开启：用用户填写的像素，填 0 也贴边
    if (!scrollGapOn) return 0;
    return scrollGapPx > 0 ? scrollGapPx : 0;
  }
  function express() {
    root.style.right = 'auto';
    root.style.bottom = 'auto';
    root.style.left = state.left + 'px';
    root.style.top = state.top + 'px';
    root.classList.toggle('dshwv-left', state.h === 'left');
  }
  function settle() {
    var vp = viewport();
    var w = root.offsetWidth || root.getBoundingClientRect().width || 0;
    var h = root.offsetHeight || root.getBoundingClientRect().height || 0;
    if (drag && drag.active) {
      // mid-drag resize: keep the pointer-follow position, just clamp into view
      state.left = clamp(state.left, 0, Math.max(0, vp.w - w - rightGap()));
      state.top = clamp(state.top, 0, Math.max(0, vp.h - h));
      express();
      return;
    }
    if (state.h === 'right') {
      state.left = Math.max(0, vp.w - w - state.hOff - rightGap());
    } else if (state.h === 'left') {
      state.left = state.hOff;
    } else {
      state.left = clamp(state.left, 0, Math.max(0, vp.w - w - rightGap()));
    }
    if (state.v === 'bottom') {
      state.top = Math.max(0, vp.h - h - state.vOff);
    } else if (state.v === 'top') {
      state.top = state.vOff;
    } else {
      state.top = clamp(state.top, 0, Math.max(0, vp.h - h));
    }
    express();
  }
  var soundOn = true;
  var soundVol = 0.9;
  var soundSet = 'duck';
  var bubbleOn = true;
  var scrollGapOn = false;
  var scrollGapPx = 17;
  function saveConfig() {
    try {
      fetch(SIZE_URL, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scale: state.scale, sound: soundOn, vol: soundVol, soundSet: soundSet, bubbleOn: bubbleOn, scrollGapOn: scrollGapOn, scrollGapPx: scrollGapPx }) });
      // 锚点位置记忆：记录相对边框的离边距离，窗口 resize 后保持（localStorage）
      var vp = viewport();
      var w = root.offsetWidth || root.getBoundingClientRect().width || 0;
      var h = root.offsetHeight || root.getBoundingClientRect().height || 0;
      var leftDist = state.left;
      var rightDist = vp.w - state.left - w;
      var topDist = state.top;
      var bottomDist = vp.h - state.top - h;
      var hAnchor = leftDist <= rightDist ? 'left' : 'right';
      var hDistRaw = Math.round(Math.min(leftDist, rightDist));
      var hDist = hAnchor === 'right' && scrollGapOn ? Math.max(0, hDistRaw - rightGap()) : hDistRaw;
      localStorage.setItem('kh_whale_pos', JSON.stringify({
        v: ANCHOR_VERSION,
        hAnchor: hAnchor,
        hDist: hDist,
        vAnchor: topDist <= bottomDist ? 'top' : 'bottom',
        vDist: Math.round(Math.min(topDist, bottomDist))
      }));
    } catch (err) {}
  }
  function setBubbleOn(v) {
    bubbleOn = !!v;
    bubbleToggle.checked = bubbleOn;
    saveConfig();
    if (!bubbleOn) hideBubble();
  }
  function setScrollGapOn(v) {
    scrollGapOn = !!v;
    scrollGapToggle.checked = scrollGapOn;
    scrollGapInput.disabled = !scrollGapOn;
    saveConfig();
    settle();
  }
  function setScrollGapPx(v) {
    if (!scrollGapOn) return;
    var n = Math.max(0, Math.round(Number(v) || 0));
    scrollGapPx = n;
    scrollGapInput.value = String(n);
    saveConfig();
    settle();
  }
  function scaleToDisplay(s) {
    return Math.round((s - MIN_SCALE) / ((MAX_SCALE - MIN_SCALE) / 19)) + 1;
  }
  function setScale(v) {
    var next = Math.round(Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(v))) * 10) / 10;
    // 缩放测量需要 left/top 立即到位：临时禁用过渡
    var prevTrans = root.style.transition;
    root.style.transition = 'none';
    var rect = root.getBoundingClientRect();
    // fixed point: the whale's corner — bottom-right when unflipped, bottom-left when flipped
    var fx = state.h === 'left' ? rect.left : rect.right;
    var fy = rect.bottom;
    state.scale = next;
    root.style.setProperty('--dshw-scale', String(next));
    scaleInput.value = String(next);
    scaleNumber.value = String(scaleToDisplay(next));
    saveConfig();
    var r2 = root.getBoundingClientRect();
    var vp = viewport();
    if (state.h === 'left') {
      state.left = Math.min(Math.max(fx, 0), Math.max(0, vp.w - r2.width));
    } else {
      state.left = Math.min(Math.max(fx - r2.width, 0), Math.max(0, vp.w - r2.width));
    }
    state.top = Math.min(Math.max(fy - r2.height, 0), Math.max(0, vp.h - r2.height));
    express();
    // 恢复过渡必须延迟到下一帧（否则会对刚改过的 left/top 重放过渡，表现为抽搐）
    requestAnimationFrame(function () {
      root.style.transition = prevTrans;
    });
  }
  function setVol(v) {
    var next = Math.round(Math.min(1, Math.max(0, Number(v))) * 100) / 100;
    soundVol = next;
    soundOn = next > 0;
    volInput.value = String(next);
    volPct.textContent = Math.round(next * 100) + '%';
    try {
      if (pressAudio) pressAudio.volume = next;
      if (releaseAudio) releaseAudio.volume = next;
    } catch (err) {}
    saveConfig();
  }
  function setSoundSet(v) {
    soundSet = v === 'fx1' ? 'fx1' : 'duck';
    soundSelect.value = soundSet;
    applySoundSet();
    saveConfig();
  }
  var SQUISH = 'scaleY(0.88) scaleX(1.05)';
  var SOUND_FILES = {
    duck: { press: '/whale/Ya1.mp3', release: '/whale/Ya2.mp3' },
    fx1: { press: '/whale/D1.mp3', release: '/whale/D2.mp3' }
  };
  var pressAudio = null;
  var releaseAudio = null;
  var pressing = false;
  var pressEnded = false;
  var releasePlayed = false;
  var releaseTimer = null;
  function applySoundSet() {
    try {
      var files = SOUND_FILES[soundSet] || SOUND_FILES.duck;
      pressAudio = new Audio(files.press);
      pressAudio.preload = 'auto';
      pressAudio.volume = soundVol;
      releaseAudio = new Audio(files.release);
      releaseAudio.preload = 'auto';
      releaseAudio.volume = soundVol;
    } catch (err) {}
  }
  function playPress() {
    if (!pressAudio || !soundOn) return;
    try {
      if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = null }
      if (releaseAudio) {
        releaseAudio.pause();
        releaseAudio.currentTime = 0;
      }
      pressEnded = false;
      releasePlayed = false;
      pressAudio.onended = function () {
        pressEnded = true;
        // fallback（时长未知）：点击 → 松手音紧跟着按压音播放
        if (!pressing && !releasePlayed) playRelease();
      };
      pressAudio.currentTime = 0;
      var p = pressAudio.play();
      if (p && typeof p.catch === 'function') p.catch(function () {});
    } catch (err) {}
  }
  function playRelease() {
    if (releasePlayed || !releaseAudio || !soundOn) return;
    releasePlayed = true;
    try {
      releaseAudio.currentTime = 0;
      var p = releaseAudio.play();
      if (p && typeof p.catch === 'function') p.catch(function () {});
    } catch (err) {}
  }
  function pressDown() {
    body.style.transform = SQUISH;
    pressing = true;
    playPress();
  }
  function pressUp() {
    body.style.transform = 'scaleY(1) scaleX(1)';
    pressing = false;
    if (pressEnded) {
      playRelease();
      return;
    }
    // 点击：在按压音最后 100ms 开始放松手音
    var durKnown = false;
    var remainMs = 0;
    try {
      var dur = pressAudio ? pressAudio.duration : 0;
      if (isFinite(dur) && dur > 0) {
        durKnown = true;
        remainMs = (dur - pressAudio.currentTime) * 1000;
      }
    } catch (err) {}
    if (durKnown) {
      releaseTimer = setTimeout(function () {
        releaseTimer = null;
        playRelease();
      }, Math.max(0, remainMs - 100));
    }
  }
  var menuOpen = false;
  function toggleMenu() {
    menuOpen = !menuOpen;
    if (menuOpen) positionMenu();
    menuBox.classList.toggle('dshwv-menu-open', menuOpen);
    if (menuOpen) menuBtn.classList.add('dshwv-menu-btn-visible');
  }
  function closeMenu() {
    menuOpen = false;
    menuBox.classList.remove('dshwv-menu-open');
    root.style.transition = '';
    snapCheck();
  }
  function snapCheck() {
    var rect = root.getBoundingClientRect();
    var vp = viewport();
    var w = rect.width, h = rect.height;
    var left = rect.left, top = rect.top;
    var centerX = left + w / 2;
    var centerY = top + h / 2;
    var moved = false;
    if (centerX < vp.w / 4) {
      state.h = 'left';
      state.hOff = 0;
      left = 0;
      moved = true;
    } else if (centerX > vp.w * 3 / 4) {
      state.h = 'right';
      state.hOff = 0;
      left = vp.w - w - rightGap();
      moved = true;
    } else {
      state.h = null;
      state.hOff = left;
    }
    if (centerY < vp.h / 4) {
      state.v = 'top';
      state.vOff = 0;
      top = 0;
      moved = true;
    } else {
      state.v = 'bottom';
      state.vOff = Math.max(0, vp.h - top - h);
    }
    if (moved) {
      state.left = left;
      state.top = top;
      settle();
    }
  }
  function positionMenu() {
    try {
      var r = root.getBoundingClientRect();
      var b = menuBtn.getBoundingClientRect();
      var vp = viewport();
      var onLeft = r.left + r.width / 2 < vp.w / 2;
      // 菜单出现在按钮上方，锚定按钮一侧
      if (onLeft) {
        menuBox.style.left = b.left + 'px';
        menuBox.style.right = 'auto';
        menuBox.style.transformOrigin = 'bottom left';
      } else {
        menuBox.style.right = (vp.w - b.right) + 'px';
        menuBox.style.left = 'auto';
        menuBox.style.transformOrigin = 'bottom right';
      }
      menuBox.style.bottom = (vp.h - b.top) + 'px';
      menuBox.style.top = 'auto';
    } catch (err) {}
  }

  var hitCanvas = null;
  var hitReady = false;
  function setupHitTest() {
    try {
      hitCanvas = document.createElement('canvas');
      hitCanvas.width = 610;
      hitCanvas.height = 610;
      var probe = new Image();
      probe.onload = function () {
        try {
          // 拉伸到 610×610 与 isWhaleHit 的坐标映射对齐
          hitCanvas.getContext('2d').drawImage(probe, 0, 0, 610, 610);
          hitReady = true;
        } catch (err) {}
      };
      probe.onerror = function () {};
      probe.src = IMG_URL;
    } catch (err) {}
  }
  function isWhaleHit(e) {
    if (!hitCanvas || !hitReady) return true;
    try {
      var r = img.getBoundingClientRect();
      if (!r || r.width <= 0 || r.height <= 0) return false;
      var lx = (e.clientX - r.left) / r.width * 610;
      var ly = (e.clientY - r.top) / r.height * 610;
      if (lx < 0 || ly < 0 || lx >= 610 || ly >= 610) return false;
      if (state.h === 'left') lx = 610 - lx;
      var data = hitCanvas.getContext('2d').getImageData(Math.floor(lx), Math.floor(ly), 1, 1).data;
      return data[3] > 10;
    } catch (err) {
      return true;
    }
  }
  function onDocPointerDown(e) {
    if (e.target && e.target.closest) {
      if (e.target.closest('.dshwv-bubble') || e.target.closest('.dshwv-menu') || e.target.closest('.dshwv-menu-btn')) return;
    }
    if (menuOpen) {
      closeMenu();
      return;
    }
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (!isWhaleHit(e)) return;
    try { e.preventDefault(); e.stopPropagation() } catch (err) {}
    var vp = viewport();
    var rect = root.getBoundingClientRect();
    drag = { active: true, startX: e.clientX, startY: e.clientY, origLeft: rect.left, origTop: rect.top, w: rect.width, h: rect.height, moved: false, vp: vp };
    root.classList.add('dshwv-dragging');
    pressDown();
    setWidgetCursor('grabbing');
    document.addEventListener('pointermove', onDocPointerMove, true);
    document.addEventListener('pointerup', onDocPointerUp, true);
    document.addEventListener('pointercancel', onDocPointerCancel, true);
  }
  function onDocPointerMove(e) {
    if (!drag || !drag.active) return;
    var dx = e.clientX - drag.startX;
    var dy = e.clientY - drag.startY;
    if (dx * dx + dy * dy >= CLICK_SQ) drag.moved = true;
    // 拖拽期间保持拖拽前的翻转朝向；松手时 endDrag() 重算锚点并由 settle() 平滑翻转
    state.left = clamp(drag.origLeft + dx, 0, Math.max(0, drag.vp.w - drag.w));
    state.top = clamp(drag.origTop + dy, 0, Math.max(0, drag.vp.h - drag.h));
    express();
  }
  function onDocPointerUp(e) {
    // 拦截鲸鱼区域内的 pointerup：防止下方元素监听 pointerup 穿透误触发
    try { if (isWhaleHit(e)) { e.preventDefault(); e.stopPropagation() } } catch (err) {}
    endDrag(e, true);
  }
  function onDocPointerCancel(e) { endDrag(e, false) }
  function onDocClickStopper(e) {
    // 只在鲸鱼命中区域拦截 click（保持透明区 pass-through）
    if (!isWhaleHit(e)) return;
    try { e.preventDefault(); e.stopPropagation() } catch (err) {}
  }
  document.addEventListener('pointerdown', onDocPointerDown, true);
  document.addEventListener('click', onDocClickStopper, true);

  var widgetCursor = '';
  function setWidgetCursor(v) {
    if (v !== widgetCursor) {
      widgetCursor = v;
      try { document.body.style.cursor = v } catch (err) {}
    }
  }
  function onDocPointerMoveCursor(e) {
    if (drag && drag.active) { setWidgetCursor('grabbing'); return }
    var el = null;
    try { el = document.elementFromPoint(e.clientX, e.clientY) } catch (err) {}
    if (el && el.closest && (el.closest('.dshwv-bubble') || el.closest('.dshwv-menu') || el.closest('.dshwv-menu-btn'))) {
      setWidgetCursor('');
      menuBtn.classList.add('dshwv-menu-btn-visible');
      return;
    }
    var over = isWhaleHit(e);
    setWidgetCursor(over ? 'grab' : '');
    menuBtn.classList.toggle('dshwv-menu-btn-visible', over || menuOpen);
  }
  document.addEventListener('pointermove', onDocPointerMoveCursor, true);

  function endDrag(e, clickAllowed) {
    if (!drag || !drag.active) return;
    drag.active = false;
    document.removeEventListener('pointermove', onDocPointerMove, true);
    document.removeEventListener('pointerup', onDocPointerUp, true);
    document.removeEventListener('pointercancel', onDocPointerCancel, true);
    pressUp();
    root.classList.remove('dshwv-dragging');
    setWidgetCursor(isWhaleHit(e) ? 'grab' : '');
    if (clickAllowed && !drag.moved) { showBubble(); return }
    var dx = e.clientX - drag.startX;
    var dy = e.clientY - drag.startY;
    var left = clamp(drag.origLeft + dx, 0, Math.max(0, drag.vp.w - drag.w));
    var top = clamp(drag.origTop + dy, 0, Math.max(0, drag.vp.h - drag.h));
    var centerX = left + drag.w / 2;
    var centerY = top + drag.h / 2;
    if (centerX < drag.vp.w / 4) {
      state.h = 'left';
      state.hOff = 0;
    } else if (centerX > drag.vp.w * 3 / 4) {
      state.h = 'right';
      state.hOff = 0;
    } else {
      state.h = null;
      state.hOff = left;
    }
    if (centerY < drag.vp.h / 4) {
      state.v = 'top';
      state.vOff = 0;
    } else if (centerY > drag.vp.h * 3 / 4) {
      state.v = 'bottom';
      state.vOff = 0;
    } else {
      state.v = null;
      state.vOff = top;
    }
    state.left = left;
    state.top = top;
    settle();
    // 拖拽结束立即保存锚点位置（否则刷新/关闭后位置回退到上次改菜单时）
    saveConfig();
  }
  // 窗口尺寸变化：自由位置按相对边框锚点重算；贴边吸附走 settle()
  function applyAnchorPos() {
    try {
      var a = JSON.parse(localStorage.getItem('kh_whale_pos') || 'null');
      if (!a || a.v !== ANCHOR_VERSION || (a.hAnchor !== 'left' && a.hAnchor !== 'right') || typeof a.hDist !== 'number' ||
          (a.vAnchor !== 'top' && a.vAnchor !== 'bottom') || typeof a.vDist !== 'number') return false;
      var vp = viewport();
      var w = root.offsetWidth || root.getBoundingClientRect().width || 0;
      var h = root.offsetHeight || root.getBoundingClientRect().height || 0;
      var effectiveRightDist = a.hAnchor === 'right' ? a.hDist + (scrollGapOn ? rightGap() : 0) : a.hDist;
      var l = a.hAnchor === 'left' ? a.hDist : vp.w - effectiveRightDist - w;
      var t = a.vAnchor === 'top' ? a.vDist : vp.h - a.vDist - h;
      state.left = clamp(l, 0, Math.max(0, vp.w - w));
      state.top = clamp(t, 0, Math.max(0, vp.h - h));
      state.h = a.hAnchor;
      state.hOff = 0;
      state.v = a.vAnchor;
      state.vOff = 0;
      express();
      return true;
    } catch (err) { return false }
  }
  function onWinResize() {
    if (state.h === null && state.v === null && applyAnchorPos()) return;
    settle();
  }
  window.addEventListener('resize', onWinResize);

  var rect0 = root.getBoundingClientRect();
  state.left = rect0.left;
  state.top = rect0.top;
  // 归位：CSS 的初值是 left:0，默认锚点在右边，所以必须先按锚点算一遍再显示，
  // 否则会出现「先闪现在左下角、再飞到右下」的一帧跳位。
  if (!applyAnchorPos()) settle();
  express();
  applySoundSet();
  setupHitTest();
  fetch(SIZE_URL, { cache: 'no-store' })
    .then(function (r) { return r.json() })
    .then(function (d) {
      if (d && typeof d.scale === 'number' && d.scale >= MIN_SCALE - 0.1 && d.scale <= MAX_SCALE + 0.1) {
        state.scale = d.scale;
        root.style.setProperty('--dshw-scale', String(d.scale));
        scaleInput.value = String(d.scale);
        scaleNumber.value = String(scaleToDisplay(d.scale));
        settle();
      }
      if (d && typeof d.vol === 'number') {
        soundVol = d.vol;
        soundOn = soundVol > 0;
        volInput.value = String(soundVol);
        volPct.textContent = Math.round(soundVol * 100) + '%';
        try {
          if (pressAudio) pressAudio.volume = soundVol;
          if (releaseAudio) releaseAudio.volume = soundVol;
        } catch (err) {}
      }
      if (d && typeof d.soundSet === 'string') {
        soundSet = d.soundSet === 'fx1' ? 'fx1' : 'duck';
        soundSelect.value = soundSet;
        applySoundSet();
      }
      if (d && typeof d.bubbleOn === 'boolean') {
        bubbleOn = d.bubbleOn;
        bubbleToggle.checked = bubbleOn;
      }
      if (d && typeof d.scrollGapOn === 'boolean') {
        scrollGapOn = d.scrollGapOn;
        scrollGapToggle.checked = scrollGapOn;
        scrollGapInput.disabled = !scrollGapOn;
      }
      if (d && typeof d.scrollGapPx === 'number') {
        scrollGapPx = d.scrollGapPx > 0 ? Math.round(d.scrollGapPx) : 0;
        scrollGapInput.value = String(scrollGapPx);
      }
      // 相对边框恢复（localStorage 锚点）；恢复时还原吸附状态
      try {
        var a = JSON.parse(localStorage.getItem('kh_whale_pos') || 'null');
        if (a && a.v === ANCHOR_VERSION && (a.hAnchor === 'left' || a.hAnchor === 'right') && typeof a.hDist === 'number' &&
            (a.vAnchor === 'top' || a.vAnchor === 'bottom') && typeof a.vDist === 'number') {
          var vpA = viewport();
          var wA = root.offsetWidth || root.getBoundingClientRect().width || 0;
          var hA = root.offsetHeight || root.getBoundingClientRect().height || 0;
          var effectiveRightDist = a.hAnchor === 'right' ? a.hDist + (scrollGapOn ? rightGap() : 0) : a.hDist;
          var lA = a.hAnchor === 'left' ? a.hDist : vpA.w - effectiveRightDist - wA;
          var tA = a.vAnchor === 'top' ? a.vDist : vpA.h - a.vDist - hA;
          state.left = clamp(lA, 0, Math.max(0, vpA.w - wA));
          state.top = clamp(tA, 0, Math.max(0, vpA.h - hA));
          state.h = a.hAnchor;
          state.hOff = 0;
          state.v = a.vAnchor;
          state.vOff = 0;
          settle();
        }
      } catch (err) {}
    })
    .catch(function () { /* 配置读取失败按默认处理 */ });

  // 切页显隐（KeepAlive 失活时隐藏，不销毁）
  function setVisible(v) {
    root.style.display = v ? '' : 'none';
    menuBox.style.display = v ? '' : 'none';
    if (!v && menuOpen) closeMenu();
  }

  function destroy() {
    var timers = [settleTimer, bubbleTimer, gifFadeTimer, releaseTimer];
    for (var i = 0; i < timers.length; i++) { if (timers[i]) clearTimeout(timers[i]) }
    document.removeEventListener('pointerdown', onDocPointerDown, true);
    document.removeEventListener('click', onDocClickStopper, true);
    document.removeEventListener('pointermove', onDocPointerMoveCursor, true);
    document.removeEventListener('pointermove', onDocPointerMove, true);
    document.removeEventListener('pointerup', onDocPointerUp, true);
    document.removeEventListener('pointercancel', onDocPointerCancel, true);
    window.removeEventListener('resize', onWinResize);
    setWidgetCursor('');
    try { if (pressAudio) { pressAudio.pause(); pressAudio.src = '' } } catch (err) {}
    try { if (releaseAudio) { releaseAudio.pause(); releaseAudio.src = '' } } catch (err) {}
    root.remove();
    menuBox.remove();
    styleEl.remove();
    instance = null;
  }

  return { destroy: destroy, setVisible: setVisible };
}
