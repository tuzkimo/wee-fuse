<script setup lang="ts">
// src/components/param/ParamPanel.vue
//
// 参数面板：长边 / 档位 / 色卡卡片 / 尺寸摘要 / 生成按钮。props 进、事件出，
// 不读 store、不 import services（本组件是纯展示层）。
//
// **摘要的豆数用 `computeGridSize`**——与 `services/pipeline.ts` 是**同一个函数**，
// 不是同一份算法抄两遍：本项目最贵的缺陷形态是「两端各自正确、错在接线」，
// UI 显示 58×44 而生成出来 44×58 正是它；同函数 + 传 `rotatedSize` 的换轴结果是组件侧的守卫。
import { computed, ref, watch } from "vue";
import { rotatedSize } from "@/core/image/rotate";
import type { Rect, Rotation } from "@/core/image/types";
import { boardCount, beadsToCm, formatCm } from "@/core/pattern/board";
import { computeGridSize } from "@/core/pattern/build";
import { MAX_LONG_SIDE, MIN_LONG_SIDE, type MaxColors } from "@/core/pattern/types";

/** 常用长边快捷值（设计规格 §4.6；B1 的临时入口用的就是 58 / 116）。 */
const LONG_SIDE_PRESETS = [29, 58, 116] as const;
/**
 * 超过这个豆数只提示「导出会分片」，不阻止生成（设计规格 §4.6 / 主规格 §8）。
 * 触发条件是**严格大于**：300 本身不提示。
 */
const SPLIT_HINT_LONG_SIDE = 300;

/**
 * 用色档位的三个选项。`<select>` 的 value 恒为**字符串**，所以「不限」（`MaxColors` 的 `null`）
 * 对应空串。模板里的 `:value` 显式做了 `null → ""` 的映射——Vue 自己也会把 `null`
 * 写成空串（runtime-dom 的 `patchDOMProp`，#11647），但不靠那条隐式行为更不容易读错。
 */
const MAX_COLOR_CHOICES = [
  { value: "16", label: "简单（16 色）" },
  { value: "32", label: "标准（32 色）" },
  { value: "", label: "精细（颜色不限）" },
] as const;

const props = defineProps<{
  longSide: number;
  maxColors: MaxColors;
  /** 非空由父级保证（设计规格 §4.1 的可空契约只在页面级）。 */
  crop: Rect;
  rotation: Rotation;
  paletteName: string;
  paletteAccuracy: string;
  busy: boolean;
  /** 父级给出的额外阻拦原因（选区太小、存储不可用…）；空串表示没有。 */
  generateBlockedReason: string;
}>();

const emit = defineEmits<{
  "update:longSide": [number];
  "update:maxColors": [MaxColors];
  generate: [];
}>();

/**
 * 输入框自己持有的文本。用户可以随便打字，父级的 `longSide` 只在它**变化**时覆盖它。
 *
 * 不用 `v-model`：那会由 `vModelText` 指令自己去监听 `input`，于是同一个输入框有两个写入者
 * （指令 + 本文件的事件处理函数），而「谁先更新 `draft`」只由 `mountElement` 里
 * 「指令 `created` 先于 props 补丁」这条实现细节保证——换个版本或换成 `v-model` 的写法，
 * 处理函数就可能读到上一拍的 `draft` 而 emit 出一个用户没输入过的值。这里只留一个写入者。
 * （另外 `v-model` 对 `type="number"` 会隐式 `castToNumber`，`draft` 会在 string / number 之间跳。）
 */
const draft = ref(String(props.longSide));

// 父级改值（快捷值按钮、从已有工程播种、store 夹取）时同步回输入框。
watch(
  () => props.longSide,
  (next) => {
    draft.value = String(next);
  },
);

/** 解析出的合法长边豆数；非法（含空串、小数、越界）为 `null`。 */
const parsed = computed<number | null>(() => {
  const value = Number(draft.value);
  // `Number("")` 是 0，`Number.isInteger` 同时挡下小数与非有限值（超长数字串会变成 Infinity）。
  return Number.isInteger(value) && value >= MIN_LONG_SIDE && value <= MAX_LONG_SIDE ? value : null;
});

const longSideError = computed(() =>
  parsed.value === null ? `长边豆数要填 ${MIN_LONG_SIDE}–${MAX_LONG_SIDE} 之间的整数` : "",
);

function onLongSideInput(event: Event): void {
  draft.value = (event.target as HTMLInputElement).value;
  const value = parsed.value;
  if (value !== null) emit("update:longSide", value);
}

function pickPreset(value: number): void {
  draft.value = String(value);
  emit("update:longSide", value);
}

/**
 * 尺寸摘要。豆数走 `computeGridSize`（与流水线同一个函数），厘米走 `beadsToCm` / `formatCm`，
 * 板数走 `boardCount`——三处都复用 core，组件里不出现第二份换算。
 *
 * 用**输入框当前文本**（`parsed`）而不是 `props.longSide`：用户改完要立刻看到新尺寸，
 * 不能等父级回灌。非法输入时整块摘要隐藏，由 `blocked-reason` 说明原因。
 */
const summary = computed(() => {
  const value = parsed.value;
  if (value === null) return null;
  const oriented = rotatedSize(props.crop.width, props.crop.height, props.rotation);
  const grid = computeGridSize(oriented.width, oriented.height, value);
  const boards = boardCount(grid.width, grid.height);
  return {
    size: `成品 ${grid.width} × ${grid.height} 颗`,
    cm: `约 ${formatCm(beadsToCm(grid.width))} × ${formatCm(beadsToCm(grid.height))} 厘米`,
    boards: `需要 ${boards.cols} × ${boards.rows} = ${boards.total} 块板`,
  };
});

/** 分片提示：只提示、不阻止（`disabled` 不看它）。 */
const splitHint = computed(() =>
  parsed.value !== null && parsed.value > SPLIT_HINT_LONG_SIDE
    ? `长边超过 ${SPLIT_HINT_LONG_SIDE} 颗，导出时会分片成多张图。`
    : "",
);

/** 自己的输入错误优先（更贴近用户刚做的动作），其次是父级的原因。 */
const blockedReason = computed(() => longSideError.value || props.generateBlockedReason);
const disabled = computed(() => props.busy || blockedReason.value !== "");

function onMaxColorsChange(event: Event): void {
  const raw = (event.target as HTMLSelectElement).value;
  // 只认模板里那三个 option 的值；空串（不限）必须落到 `null`，不能落到 0——`0` 在
  // `buildPattern` 里是「响亮失败」，在别处则是「静默等价不限」，两种语义都不是这里的意图。
  emit("update:maxColors", raw === "16" ? 16 : raw === "32" ? 32 : null);
}
</script>

<template>
  <section class="space-y-6">
    <label class="block text-lg text-slate-800">
      长边豆数
      <input
        :value="draft"
        data-testid="long-side"
        type="number"
        inputmode="numeric"
        :min="MIN_LONG_SIDE"
        :max="MAX_LONG_SIDE"
        class="mt-2 block min-h-12 w-full rounded border border-slate-300 px-3 text-lg"
        @input="onLongSideInput"
      />
    </label>

    <div class="flex flex-wrap gap-3">
      <button
        v-for="n in LONG_SIDE_PRESETS"
        :key="n"
        :data-testid="`preset-${n}`"
        class="min-h-12 rounded border border-slate-300 px-4 text-base"
        @click="pickPreset(n)"
      >
        {{ n }} 颗
      </button>
    </div>

    <p v-if="splitHint" data-testid="split-hint" class="rounded bg-amber-50 p-3 text-base text-amber-800">
      {{ splitHint }}
    </p>

    <label class="block text-lg text-slate-800">
      用几种颜色
      <select
        data-testid="max-colors"
        class="mt-2 block min-h-12 w-full rounded border border-slate-300 px-3 text-lg"
        :value="maxColors === null ? '' : String(maxColors)"
        @change="onMaxColorsChange"
      >
        <option v-for="choice in MAX_COLOR_CHOICES" :key="choice.value" :value="choice.value">
          {{ choice.label }}
        </option>
      </select>
    </label>

    <div data-testid="palette-card" class="rounded border border-slate-200 bg-white p-4">
      <p class="text-lg font-semibold text-slate-900">{{ paletteName }}</p>
      <p class="mt-1 text-base text-slate-500">{{ paletteAccuracy }}</p>
    </div>

    <dl v-if="summary" data-testid="summary" class="space-y-1 rounded bg-slate-100 p-4 text-lg text-slate-800">
      <div>{{ summary.size }}</div>
      <div>{{ summary.cm }}</div>
      <div>{{ summary.boards }}</div>
    </dl>

    <button
      data-testid="generate"
      class="min-h-14 w-full rounded bg-slate-900 px-8 text-lg text-white disabled:opacity-50"
      :disabled="disabled"
      @click="emit('generate')"
    >
      {{ busy ? "正在生成…" : "生成图纸" }}
    </button>

    <p v-if="blockedReason" data-testid="blocked-reason" class="rounded bg-amber-50 p-3 text-base text-amber-800">
      {{ blockedReason }}
    </p>
  </section>
</template>
