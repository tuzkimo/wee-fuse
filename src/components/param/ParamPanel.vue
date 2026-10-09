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
 * 用色档位的五个选项（C7 规格 §6.3：从 `<select>` 改成按钮组）。
 *
 * 人类伙伴的口径：8 / 16 / 24 三档够用；「自定义」应付个别情况；「不限」保留。
 * 旧的三档（16 / 32 / 不限）在 core 里已经作废（`MaxColors` 只认新枚举），所以界面这层
 * 不再有「32 色」这个说法。
 */
const MAX_COLOR_CHOICES = [
  { value: 8, label: "8 色" },
  { value: 16, label: "16 色" },
  { value: 24, label: "24 色" },
  { value: "all", label: "不限" },
  { value: "custom", label: "自定义" },
] as const;

const props = defineProps<{
  longSide: number;
  maxColors: MaxColors;
  /** `maxColors === "custom"` 时的具体色数（由父级的 store 持有）。 */
  customMaxColors: number;
  /** 内置色卡的色数：自定义输入框的上界（第 3 处「色数上限」，与 core / store 的两处同源）。 */
  paletteColorCount: number;
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
  "update:customMaxColors": [number];
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

/**
 * 自己的输入错误优先，其次是父级的原因。
 *
 * 本地原因是从输入框**当下**的文本同步算出来的，永远不过期；父级原因用的是上一次提交上去的
 * props，用户这一拍刚打的字还没回流上去。两者同时成立时报「选区太小」之类的父级文案，会把用户
 * 支去改一个他刚改对的东西，而真正要他改的是输入框——所以先报本地那条。
 * （用例「本地非法输入与父级原因同时存在时，显示本地那条」钉住这个顺序，含操作数对调的变异。）
 */
const blockedReason = computed(
  () => longSideError.value || customError.value || props.generateBlockedReason,
);
const disabled = computed(() => props.busy || blockedReason.value !== "");

/**
 * 自定义色数输入框自己持有的文本（与 `longSide` 同一套手法：**只有一个写入者**，
 * 父级的值只在它**变化**时覆盖草稿）。
 */
const customDraft = ref(String(props.customMaxColors));
watch(
  () => props.customMaxColors,
  (next) => {
    customDraft.value = String(next);
  },
);

/** 解析出的合法自定义色数；非法（空串、小数、越界）为 `null`。 */
const parsedCustom = computed<number | null>(() => {
  const value = Number(customDraft.value);
  return Number.isInteger(value) && value >= 1 && value <= props.paletteColorCount ? value : null;
});

/**
 * 自定义那条**本地错误**。它与 `longSideError` 同级：本地错优先于父级原因——用户这一拍刚打的字
 * 还没回流上去，先报父级的「选区太小」会把他支去改一个刚改对的东西。
 */
const customError = computed(() =>
  props.maxColors === "custom" && parsedCustom.value === null
    ? `色数要填 1–${props.paletteColorCount} 之间的整数`
    : "",
);

function onCustomMaxColorsInput(event: Event): void {
  customDraft.value = (event.target as HTMLInputElement).value;
  const value = parsedCustom.value;
  if (value !== null) emit("update:customMaxColors", value);
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

    <div class="block text-lg text-slate-800">
      用几种颜色
      <!--
        C7 起是**按钮组**（不是 `<select>`）：档位只有五个，按钮组少一次展开、也不用处理
        「`<select>` 的值恒为字符串」那层转换（旧实现里 `"32" → 32`、`"" → null` 的映射就是一处
        静默失败的温床）。`data-tier` 承载真实档位值，事件处理里按它取回。
      -->
      <div data-testid="max-colors" class="mt-2 flex flex-wrap gap-2">
        <button
          v-for="choice in MAX_COLOR_CHOICES"
          :key="String(choice.value)"
          :data-testid="`max-colors-${choice.value}`"
          :aria-pressed="maxColors === choice.value"
          class="min-h-12 rounded border border-slate-300 px-4 text-base"
          :class="maxColors === choice.value ? 'bg-slate-900 text-white' : ''"
          @click="emit('update:maxColors', choice.value)"
        >
          {{ choice.label }}
        </button>
      </div>
    </div>

    <label v-if="maxColors === 'custom'" class="block text-lg text-slate-800">
      自定义色数
      <input
        :value="customDraft"
        data-testid="custom-max-colors"
        type="number"
        inputmode="numeric"
        :min="1"
        :max="paletteColorCount"
        class="mt-2 block min-h-12 w-full rounded border border-slate-300 px-3 text-lg"
        @input="onCustomMaxColorsInput"
      />
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
