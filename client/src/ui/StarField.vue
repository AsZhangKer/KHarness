<template>
  <canvas ref="canvasRef" class="starfield"></canvas>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';

const canvasRef = ref(null);
const LINK_DIST = 110;
const MOUSE_DIST = 170;
const MAX_STARS = 170;

let ctx = null;
let width = 0;
let height = 0;
let rafId = 0;
let stars = [];
let mouse = { x: -9999, y: -9999 };
let dpr = 1;

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function themeColors() {
  // 颜色来自 themes.css 的 --star-* 令牌，换主题时星空跟着变
  const cs = getComputedStyle(document.documentElement);
  const rgb = (name, fallback) => {
    const m = String(cs.getPropertyValue(name) || '').match(/[\d.]+/g);
    return m && m.length >= 3 ? m.slice(0, 3).map(Number) : fallback;
  };
  const alpha = parseFloat(cs.getPropertyValue('--star-alpha'));
  return {
    star: rgb('--star-color', [225, 227, 232]),
    line: rgb('--star-line', [140, 143, 150]),
    mouse: rgb('--star-accent', [228, 184, 92]),
    starAlpha: Number.isFinite(alpha) ? alpha : 0.85,
  };
}

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  width = window.innerWidth;
  height = window.innerHeight;
  canvasRef.value.width = width * dpr;
  canvasRef.value.height = height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  initStars();
}

function initStars() {
  const count = Math.min(MAX_STARS, Math.floor(width * height / 9000));
  stars = Array.from({ length: count }, () => ({
    x: Math.random() * width,
    y: Math.random() * height,
    vx: (Math.random() - 0.5) * 0.3,
    vy: (Math.random() - 0.5) * 0.3,
    r: 0.6 + Math.random() * 1.3,
    tw: Math.random() * Math.PI * 2,
    twSpeed: 0.008 + Math.random() * 0.02
  }));
}

function drawLinks(colors) {
  for (let i = 0; i < stars.length; i++) {
    const s1 = stars[i];
    for (let j = i + 1; j < stars.length; j++) {
      const s2 = stars[j];
      const dx = s1.x - s2.x;
      const dy = s1.y - s2.y;
      const distSq = dx * dx + dy * dy;
      if (distSq < LINK_DIST * LINK_DIST) {
        const alpha = (1 - Math.sqrt(distSq) / LINK_DIST) * 0.18;
        ctx.strokeStyle = `rgba(${colors.line[0]},${colors.line[1]},${colors.line[2]},${alpha.toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(s1.x, s1.y);
        ctx.lineTo(s2.x, s2.y);
        ctx.stroke();
      }
    }
    const mdx = s1.x - mouse.x;
    const mdy = s1.y - mouse.y;
    const mdistSq = mdx * mdx + mdy * mdy;
    if (mdistSq < MOUSE_DIST * MOUSE_DIST) {
      const alpha = (1 - Math.sqrt(mdistSq) / MOUSE_DIST) * 0.45;
      ctx.strokeStyle = `rgba(${colors.mouse[0]},${colors.mouse[1]},${colors.mouse[2]},${alpha.toFixed(3)})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(s1.x, s1.y);
      ctx.lineTo(mouse.x, mouse.y);
      ctx.stroke();
    }
  }
  ctx.lineWidth = 1;
}

function drawStars(colors) {
  for (const s of stars) {
    const tw = 0.6 + Math.sin(s.tw) * 0.4;
    ctx.fillStyle = `rgba(${colors.star[0]},${colors.star[1]},${colors.star[2]},${(colors.starAlpha * tw).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function frame() {
  ctx.clearRect(0, 0, width, height);
  const colors = themeColors();
  for (const s of stars) {
    s.x += s.vx;
    s.y += s.vy;
    s.tw += s.twSpeed;
    if (s.x < -10) s.x = width + 10;
    if (s.x > width + 10) s.x = -10;
    if (s.y < -10) s.y = height + 10;
    if (s.y > height + 10) s.y = -10;
  }
  drawLinks(colors);
  drawStars(colors);
  rafId = requestAnimationFrame(frame);
}

function renderStatic() {
  ctx.clearRect(0, 0, width, height);
  drawStars(themeColors());
}

function onResize() {
  resize();
  if (reducedMotion) renderStatic();
}

function onMouseMove(e) {
  mouse.x = e.clientX;
  mouse.y = e.clientY;
}

function onMouseLeave() {
  mouse.x = -9999;
  mouse.y = -9999;
}

function onVisibility() {
  if (reducedMotion) return;
  if (document.hidden) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  } else if (!rafId) {
    rafId = requestAnimationFrame(frame);
  }
}

onMounted(() => {
  const canvas = canvasRef.value;
  ctx = canvas.getContext('2d');
  resize();
  if (reducedMotion) {
    renderStatic();
  } else {
    window.addEventListener('mousemove', onMouseMove, { passive: true });
    document.documentElement.addEventListener('mouseleave', onMouseLeave);
    document.addEventListener('visibilitychange', onVisibility);
    rafId = requestAnimationFrame(frame);
  }
  window.addEventListener('resize', onResize);
});

onUnmounted(() => {
  cancelAnimationFrame(rafId);
  window.removeEventListener('resize', onResize);
  window.removeEventListener('mousemove', onMouseMove);
  document.documentElement.removeEventListener('mouseleave', onMouseLeave);
  document.removeEventListener('visibilitychange', onVisibility);
});
</script>

<style scoped>
.starfield {
  z-index: -2;
  pointer-events: none;
  position: fixed;
  inset: 0;
}
</style>
