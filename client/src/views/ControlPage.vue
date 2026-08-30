<template>
  <div class="kh-control">
    <div class="page-header">
      <h1><i class="fas fa-sliders"></i> KHarness 控制台</h1>
      <p class="kh-sub">{{ settings.site_description || '本地 AI Harness' }} · {{ summary }}</p>
    </div>

    <div class="kh-cards">
      <div class="kh-card" v-reveal="0" @click="go('/')">
        <div class="kh-card-icon"><i class="fas fa-comments"></i></div>
        <div class="kh-card-body">
          <h3>聊天 <span class="kh-en">Playground</span></h3>
          <p>与模型对话，自动保存上下文；支持模型池、Agent 工具调用、上下文压缩</p>
        </div>
        <i class="fas fa-arrow-right kh-card-arrow"></i>
      </div>

      <div class="kh-card" v-reveal="80" @click="go('/models')">
        <div class="kh-card-icon"><i class="fas fa-list-check"></i></div>
        <div class="kh-card-body">
          <h3>模型列表 <span class="kh-en">Models</span></h3>
          <p>查看全部模型的首字延迟与可用状态，支持搜索、排序、一键复制</p>
        </div>
        <i class="fas fa-arrow-right kh-card-arrow"></i>
      </div>

      <div class="kh-card" v-reveal="160" @click="go('/admin-models')">
        <div class="kh-card-icon"><i class="fas fa-screwdriver-wrench"></i></div>
        <div class="kh-card-body">
          <h3>管理模型 <span class="kh-en">Admin</span></h3>
          <p>管理提供商与模型（增删改）、一键测试全部模型可用性</p>
        </div>
        <i class="fas fa-arrow-right kh-card-arrow"></i>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, inject } from 'vue';
import { useRouter } from 'vue-router';
import { aiApi } from '../api';

const router = useRouter();
const settings = inject('settings');

const modelCount = ref(0);
const okCount = ref(0);

const summary = computed(() => {
  if (!modelCount.value) return '暂无模型，请先到「管理模型」添加';
  return `共 ${modelCount.value} 个模型 · ${okCount.value} 个可用`;
});

const go = (path) => router.push(path);

onMounted(async () => {
  try {
    const res = await aiApi.getStatus();
    const list = res.data.list || [];
    modelCount.value = list.length;
    okCount.value = list.filter(m => m.status === 'ok').length;
  } catch (e) { /* 静默 */ }
});
</script>

<style scoped>
.kh-control {
  max-width: 900px;
  margin: 0 auto;
  width: 100%;
}

.kh-sub {
  color: var(--text-muted);
  font-size: 0.95rem;
  margin-top: 0.4rem;
}

.kh-cards {
  display: flex;
  flex-direction: column;
  gap: 1.2rem;
}

.kh-card {
  display: flex;
  align-items: center;
  gap: 1.2rem;
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-parallelogram);
  padding: 1.4rem 1.6rem;
  cursor: pointer;
  box-shadow: var(--shadow-soft);
  transition: transform var(--transition), border-color var(--transition), box-shadow var(--transition);
}

.kh-card:hover {
  transform: translateY(-3px);
  border-color: var(--primary-gold);
  box-shadow: var(--shadow-dropdown);
}

.kh-card-icon {
  flex-shrink: 0;
  width: 56px;
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 16px;
  background: var(--accent-pink);
  color: var(--primary-gold);
  font-size: 1.5rem;
  transition: transform var(--transition);
}

.kh-card:hover .kh-card-icon {
  transform: rotate(-6deg) scale(1.08);
}

.kh-card-body {
  flex: 1;
  min-width: 0;
}

.kh-card-body h3 {
  color: var(--primary-blue);
  font-size: 1.15rem;
  margin-bottom: 0.3rem;
}

.kh-en {
  color: var(--primary-gold);
  font-size: 0.8rem;
  font-weight: 500;
  margin-left: 0.4rem;
  letter-spacing: 0.5px;
}

.kh-card-body p {
  color: var(--text-muted);
  font-size: 0.88rem;
  line-height: 1.5;
}

.kh-card-arrow {
  flex-shrink: 0;
  color: var(--text-muted);
  opacity: 0.5;
  transition: opacity var(--transition), transform var(--transition);
}

.kh-card:hover .kh-card-arrow {
  opacity: 1;
  color: var(--primary-gold);
  transform: translateX(4px);
}
</style>
