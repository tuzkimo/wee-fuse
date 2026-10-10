<script setup lang="ts">
// src/components/param/TierSlider.vue
//
// 档位滑动条 + 数字输入框（C8 第 4 项）。**纯展示**：props 进、事件出，不 import store，
// 也不知道「长边」或「用色数」是什么——档位节点由调用方给。
//
// 两个写入者会漂移：所以输入框的文本只由本组件持有（`draft`），父级的 `value` 只在**变化**时覆盖它
// （与既有 `longSide` 输入框同一套手法：不用 `v-model`，否则指令与处理函数同时写 `draft`，
// 谁先更新只由挂载顺序保证）。
//
// **触控目标**（规格 §6.4）：轨道用 `h-11`（44px，含原生滑条的命中区），数字输入框 `min-h-12`。
// 拇指高度由浏览器决定，`accent-slate-900` 只是配色；这里不做自绘拇指——原生滑条在
// Android WebView 上的触控与无障碍（方向键 / 读屏）行为都比自绘的好，而自绘正是「引第三方库」
// 之外的另一种复杂度来源。
import { computed, ref, watch } from "vue";

export interface TierNode {
  readonly value: number;
  readonly label: string;
}

const props = defineProps<{
  label: string;
  min: number;
  max: number;
  /** 当前生效值（父级权威）。 */
  value: number;
  nodes: readonly TierNode[];
  inputTestId: string;
  sliderTestId: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  /** 每敲一次都会 emit：非法时 `value` 为 `null`、`error` 是中文原因。 */
  input: [{ readonly value: number | null; readonly error: string }];
}>();

const draft = ref(String(props.value));
watch(
  () => props.value,
  (next) => {
    draft.value = String(next);
  },
);

/** 解析出的合法值；非法（空串、小数、越界、非有限）为 `null`。 */
const parsed = computed<number | null>(() => {
  const value = Number(draft.value);
  // `Number("")` 是 0，`Number.isInteger` 同时挡下小数与非有限值（超长数字串会变成 Infinity）。
  return Number.isInteger(value) && value >= props.min && value <= props.max ? value : null;
});

const error = computed(() =>
  parsed.value === null ? `要填 ${props.min}–${props.max} 之间的整数` : "",
);

function report(text: string): void {
  draft.value = text;
  emit("input", { value: parsed.value, error: error.value });
}

/** 节点在轨道上的位置（**近似**：原生拇指会把行程两端各内缩约半个拇指宽，
 *  但它是档位提示、精确值看输入框，不值得为它自绘轨道）。 */
function nodeLeft(value: number): string {
  return `${((value - props.min) / (props.max - props.min)) * 100}%`;
}
</script>

<template>
  <label class="block text-lg text-slate-800">
    {{ label }}
    <div class="mt-2 flex items-center gap-3">
      <div class="min-w-0 flex-1">
        <input
          :data-testid="sliderTestId"
          type="range"
          :min="min"
          :max="max"
          :value="value"
          :disabled="disabled"
          class="h-11 w-full accent-slate-900 disabled:opacity-50"
          @input="report(($event.target as HTMLInputElement).value)"
        />
        <div class="relative h-5">
          <span
            v-for="node in nodes"
            :key="node.value"
            data-node
            class="absolute -translate-x-1/2 text-xs text-slate-500"
            :style="{ left: nodeLeft(node.value) }"
          >
            {{ node.label }}
          </span>
        </div>
      </div>
      <input
        :data-testid="inputTestId"
        :value="draft"
        type="number"
        inputmode="numeric"
        :min="min"
        :max="max"
        :disabled="disabled"
        class="min-h-12 w-24 rounded border border-slate-300 px-3 text-lg disabled:opacity-50"
        @input="report(($event.target as HTMLInputElement).value)"
      />
    </div>
  </label>
</template>
