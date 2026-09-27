// 简短提示音（Web Audio 合成，无外部资源）
let ctx = null;

// 总闸与音量由「设置 → 常规」下发（音色各自保留，不动）
const audio = { enabled: true, volume: 0.6 };

export function configureSound({ enabled, volume } = {}) {
  if (enabled !== undefined) audio.enabled = !!enabled;
  if (volume !== undefined) {
    const v = Number(volume);
    if (Number.isFinite(v)) audio.volume = Math.min(1, Math.max(0, v));
  }
}

export function soundState() {
  return { ...audio };
}

function ac() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  return ctx;
}

function beep({ freq = 660, dur = 0.08, type = 'sine', gain = 0.04, slide = 0 }) {
  if (!audio.enabled || audio.volume <= 0) return;
  try {
    const a = ac();
    if (a.state === 'suspended') a.resume();
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = type;
    o.frequency.value = freq;
    if (slide) o.frequency.linearRampToValueAtTime(freq + slide, a.currentTime + dur);
    // 音量是线性乘上去的：0.6 就是原来音量的六成，0 直接不响（上面已经拦过一次）
    g.gain.value = gain * audio.volume;
    g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur);
    o.connect(g);
    g.connect(a.destination);
    o.start();
    o.stop(a.currentTime + dur);
  } catch { /* ignore */ }
}

export function soundDone() {
  beep({ freq: 784, dur: 0.12 });
  setTimeout(() => beep({ freq: 1046, dur: 0.14 }), 90);
}

export function soundError() {
  beep({ freq: 220, dur: 0.18, type: 'triangle', slide: -40 });
}

export function soundApproval() {
  beep({ freq: 523, dur: 0.07, type: 'square', gain: 0.03 });
  setTimeout(() => beep({ freq: 659, dur: 0.07, type: 'square', gain: 0.03 }), 80);
}

export function soundQuestion() {
  beep({ freq: 880, dur: 0.1, slide: 120 });
}
