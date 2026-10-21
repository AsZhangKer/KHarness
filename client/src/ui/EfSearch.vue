<template>
  <div class="efs-wrap" :style="style">
    <label v-if="ef" class="ef-search" :class="{ 'has-submit': submit }">
      <svg class="ef-search__ico" viewBox="0 0 25 25" aria-hidden="true">
        <circle cx="10" cy="10" r="7.6" />
        <path d="M15.8 15.8L22.6 22.6" stroke-width="4.2" />
      </svg>
      <input
        class="ef-search__input"
        type="text"
        :value="modelValue"
        :placeholder="placeholder"
        autocomplete="off"
        @input="onInput"
        @keydown.enter="$emit('search', modelValue)"
        @keydown.esc="onEsc"
      />
      <button v-if="submit" class="ef-search__btn" type="button" @click="$emit('search', modelValue)">搜索</button>
    </label>
    <!-- 其它六套主题保持原样：各自传自己的 class（.input / .nu-input / .k-input） -->
    <input
      v-else
      :class="fallbackClass"
      type="search"
      :value="modelValue"
      :placeholder="placeholder"
      @input="onInput"
      @keydown.esc="onEsc"
    />
  </div>
</template>

<script setup>
/**
 * 搜索框（终末地）：照搬 INPUTBOX/搜索框.html 的 .ef-search。
 *
 * 母本读数（1u = 1920 设计稿 1px，这里随视口缩到 0.72）：
 *   高 39u / 2u 描边 #939292 / 圆角 5u / 面 #c0bfbf / 内阴影
 *   放大镜 25u（stroke 3.4，圆 + 斜柄）/ 文字 21u / 占位 #959494
 *   右侧「搜索」钮 69×27u、#6b6b6b、白字 18.5u、圆角 3.5u
 *   focus-within 追加 2.5u 亮黄外环；按钮 hover brightness(1.18)、按下下沉 1u
 * 这个页面里搜索是实时过滤，所以「搜索」按钮只做一次失焦 + 抛 search 事件，
 * 不改变「边打边筛」的行为。
 */
import { computed } from 'vue';
import { themeState } from '../stores/theme';

const props = defineProps({
  modelValue: { type: String, default: '' },
  placeholder: { type: String, default: '搜索…' },
  /** 非终末地主题回落用的 class（各处原本的输入框类名） */
  fallbackClass: { type: String, default: 'k-input' },
  /** 是否渲染右侧那颗「搜索」按钮。这些页面都是边打边筛（实时过滤），按钮点了也没额外动作，
      所以默认关掉；只有「按下才查」的场合才传 true。 */
  submit: { type: Boolean, default: false },
  /** 宽度由调用点决定；母本默认 397u，这里默认撑满父容器 */
  style: { type: [String, Object], default: '' },
});
const emit = defineEmits(['update:modelValue', 'search', 'clear']);
const ef = computed(() => themeState.id === 'endfield');

function onInput(e) {
  emit('update:modelValue', e.target.value);
}
function onEsc() {
  emit('update:modelValue', '');
  emit('clear');
}
</script>

<style scoped>
.efs-wrap { display: flex; align-items: center; min-width: 0; }
.ef-search {
  --u: clamp(0.68px, calc(100vw / 2100), 0.9px);
  position: relative;
  display: flex;
  align-items: center;
  width: 100%;
  max-width: 100%;
  height: calc(var(--u) * 39);
  padding: 0 calc(var(--u) * 12) 0 calc(var(--u) * 10);
  border: calc(var(--u) * 2) solid #939292;
  border-radius: calc(var(--u) * 5);
  background: #c0bfbf;
  box-shadow: inset 0 calc(var(--u) * 1) calc(var(--u) * 2) rgba(0, 0, 0, 0.08);
  font-family: var(--font);
  color: #393838;
  transition: box-shadow 0.12s linear;
}
.ef-search:focus-within {
  box-shadow: inset 0 calc(var(--u) * 1) calc(var(--u) * 2) rgba(0, 0, 0, 0.08), 0 0 0 calc(var(--u) * 2.5) #ffe61a;
}
.ef-search.has-submit { padding-right: calc(var(--u) * 4); }
.ef-search__ico {
  flex: none;
  width: calc(var(--u) * 25);
  height: calc(var(--u) * 25);
  fill: none;
  stroke: #393838;
  stroke-width: 3.4;
  stroke-linecap: round;
}
/* 全局 input[type=text] 在终末地下是「白面 + 2px 中灰 + 5px 圆角」，
   这里必须把那些整套压掉（用 :root 前缀把特异性提到 0,3,0），否则灰面上会再套一个白框。 */
.ef-search .ef-search__input {
  flex: 1;
  min-width: 0;
  height: 100%;
  margin: 0 0 0 calc(var(--u) * 17);
  padding: 0;
  border: 0;
  border-radius: 0;
  outline: 0;
  background: none;
  box-shadow: none;
  color: #393838;
  font: 500 calc(var(--u) * 21) / 1 var(--font);
  caret-color: #393838;
}
:root[data-theme='endfield'] .ef-search .ef-search__input {
  height: 100%;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: none;
  box-shadow: none;
  color: #393838;
}
.ef-search__input::placeholder { color: #959494; opacity: 1; }
.ef-search__btn {
  appearance: none;
  flex: none;
  width: calc(var(--u) * 69);
  min-width: calc(var(--u) * 69);
  height: calc(var(--u) * 27);
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: calc(var(--u) * 3.5);
  background: #6b6b6b;
  color: #ffffff;
  font: 500 calc(var(--u) * 18.5) / 1 var(--font);
  letter-spacing: 0.02em;
  white-space: nowrap;
  cursor: pointer;
  transition: filter 0.12s, transform 0.06s;
}
.ef-search__btn:hover { filter: brightness(1.18); }
.ef-search__btn:active { transform: translateY(calc(var(--u) * 1)); filter: brightness(0.92); }
.ef-search__btn:focus-visible { outline: calc(var(--u) * 2) solid #ffffff; outline-offset: calc(var(--u) * -3); }
</style>
