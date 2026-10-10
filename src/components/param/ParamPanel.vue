<script setup lang="ts">
// src/components/param/ParamPanel.vue
//
// 参数面板：工程名 / 长边 / 用色档位 / 色卡卡片 / 尺寸摘要 / 生成按钮。props 进、事件出，
// 不读 store（本组件是纯展示层）。
//
// **唯一的 services 依赖是 `PROJECT_NAME_MAX` 这个纯常量**（`@/services/projectStore`，第 22 行）：
// 名字长度上限必须与存储层的 `normalizeProjectName` 同源，不能在这里另抄一个 100。
// （文件头这句原先写的是「不 import services」，C8 第 4 项起已不成立——修复轮 1 更正。）
//
// **摘要的豆数用 `computeGridSize`**——与 `services/pipeline.ts` 是**同一个函数**，
// 不是同一份算法抄两遍：本项目最贵的缺陷形态是「两端各自正确、错在接线」，
// UI 显示 58×44 而生成出来 44×58 正是它；同函数 + 传 `rotatedSize` 的换轴结果是组件侧的守卫。
//
// **C8 第 4 项**：长边与用色数都换成 `TierSlider`（滑条 + 数字输入框），原来的两个按钮组
// （`preset-*` / `max-colors-*`）与独立的 `custom-max-colors` 输入框整块删除——档位现在由
// 滑条上的节点表示，滑条的上界就是该参数的上界（用色数那条的上界**就是「不限」**）。
// 工程名输入框加在最上面（§3.7：名字在这里就能改，不用等生成完去图纸库）。
//
// **2026-10-10 口径简化**：用色数只剩一个**数字**（没有档位枚举、没有 `customMaxColors`）。
// 用色条上只有 8 / 16 / 24 三个纯数字档位，`labels="below"`——它们在 1–221 上只隔 3.18% /
// 6.82% / 10.45%，画在 220px 轨道上必然重叠，所以改成刻度线 + 滑条下方一行数字。
// 长边那条（29 / 58 / 116 落在 24% / 50% / 100%）不重叠，保持 `labels="track"`。
// 两条滑条都**吸附**（阈值在 `TierSlider` 里：行程的 2%、至少 1）。
import { computed, ref, watch } from "vue";
import { rotatedSize } from "@/core/image/rotate";
import type { Rect, Rotation } from "@/core/image/types";
import { boardCount, beadsToCm, formatCm } from "@/core/pattern/board";
import { computeGridSize } from "@/core/pattern/build";
import { MAX_LONG_SIDE, MIN_LONG_SIDE } from "@/core/pattern/types";
import TierSlider, { type TierNode } from "@/components/param/TierSlider.vue";
import { PROJECT_NAME_MAX } from "@/services/projectStore";

/** 长边滑条上的三个档位（原 `LONG_SIDE_PRESETS` 的三个值，1 / 2 / 4 块板）。 */
const LONG_SIDE_NODES: readonly TierNode[] = [
  { value: 29, label: "29" },
  { value: 58, label: "58" },
  { value: 116, label: "116" },
];

const props = defineProps<{
  /** 工程名（父级持有真相；本组件只回显与上报）。 */
  name: string;
  longSide: number;
  /** 用色数：1..色卡色数 的整数，等于色卡色数即「不限」（2026-10-10 口径简化后只剩这一个数字）。 */
  maxColors: number;
  /** 内置色卡的色数：用色滑条的上界（也就是「不限」那一档）。 */
  paletteColorCount: number;
  /** 非空由父级保证（设计规格 §4.1 的可空契约只在页面级）。 */
  crop: Rect;
  rotation: Rotation;
  paletteName: string;
  busy: boolean;
  /** 父级给出的额外阻拦原因（选区太小、存储不可用…）；空串表示没有。 */
  generateBlockedReason: string;
}>();

const emit = defineEmits<{
  "update:name": [string];
  "update:longSide": [number];
  "update:maxColors": [number];
  generate: [];
}>();

// ---------------------------------------------------------------------------
// 工程名（C8 §3.7）
// ---------------------------------------------------------------------------

/**
 * 名字输入框自己持有的文本（与长边同一套手法：**只有一个写入者**，父级的值只在它**变化**时
 * 覆盖草稿）。不回传 trim 后的结果：清洗是 store 的 `setName`（`normalizeProjectName`）的职责，
 * 在这里再 trim 一次就是第二份口径，而用户在中间打空格时输入框会当场跳字。
 */
const nameDraft = ref(props.name);
watch(
  () => props.name,
  (next) => {
    nameDraft.value = next;
  },
);

/**
 * 空名字的**本地错误**：名字会印在图纸标题与导出文件名上，空名字在 `put` / `rename` 里会被
 * `normalizeProjectName` 响亮拒绝——与其让用户白跑一遍流水线再看到「保存失败」，
 * 不如在这里就禁用生成并说明原因。
 */
const nameError = computed(() => (nameDraft.value.trim().length === 0 ? "工程名称不能为空" : ""));

function onNameInput(event: Event): void {
  nameDraft.value = (event.target as HTMLInputElement).value;
  if (nameError.value === "") emit("update:name", nameDraft.value);
}

// ---------------------------------------------------------------------------
// 长边
// ---------------------------------------------------------------------------

const longSideError = ref("");
/**
 * 长边的**当前生效值**（本地草稿）。
 *
 * 为什么不直接用 `props.longSide` 算摘要：父级（`SetupPage`）是在 `@update:longSide` 里写 store 的，
 * props 要等下一拍才回流——用户拖完滑条得立刻看到新尺寸，不能等回灌。`TierSlider` 里的文本
 * 同理，所以它的 `value` 只在**变化**时覆盖自己的草稿。
 */
const longSideDraft = ref<number | null>(props.longSide);
watch(
  () => props.longSide,
  (next) => {
    longSideDraft.value = next;
    // 父级改了值（重跑播种 / 别处的写入）⇒ 上一次的本地非法输入已经不作数了。
    longSideError.value = "";
  },
);

function onLongSideInput(state: { readonly value: number | null; readonly error: string }): void {
  longSideError.value = state.error === "" ? "" : `长边豆数${state.error}`;
  longSideDraft.value = state.value;
  if (state.value !== null) emit("update:longSide", state.value);
}

// ---------------------------------------------------------------------------
// 用色数（2026-10-10 口径简化：就是一个数字，没有档位枚举、没有第二个字段）
// ---------------------------------------------------------------------------

const colorError = ref("");

/**
 * 用色滑条上的三个**纯数字档位**（会画成刻度线、也是吸附点）。
 *
 * 「不限」不再单列一档：**拉满滑条（= 色卡色数）就是它**，所以这里只有 8 / 16 / 24 三个数字。
 * 标签就是数字本身（人类伙伴原话：「每个档位就显示 8/16/24 的数字就行」）。
 */
const COLOR_NODES: readonly TierNode[] = [
  { value: 8, label: "8" },
  { value: 16, label: "16" },
  { value: 24, label: "24" },
];

/**
 * 用色数：**滑条/输入框上是什么数字就 emit 什么数字**（不再有 `"all"` / `"custom"` 分支，
 * 也不再往第二个字段里写值）。上界是色卡色数，「拉满」由调用方（父级）与 `buildPattern` 的
 * `maxColors >= palette.colors.length` 同一判据解释成「不限」，组件不需要知道这件事。
 */
function onMaxColorsInput(state: { readonly value: number | null; readonly error: string }): void {
  colorError.value = state.error === "" ? "" : `色数${state.error}`;
  if (state.value === null) return;
  emit("update:maxColors", state.value);
}

/**
 * 读数：`maxColors >= 色卡色数` 时写「不限」——与 `core/pattern/build.ts` 里
 * 「`maxColors >= palette.colors.length` ⇒ 跳过分簇」是**同一条判据**，界面不会与产物说两套。
 */
const colorReadout = computed(() =>
  props.maxColors >= props.paletteColorCount ? "不限" : `${props.maxColors} 种`,
);

// ---------------------------------------------------------------------------
// 摘要 / 生成闸门
// ---------------------------------------------------------------------------

/**
 * 尺寸摘要。豆数走 `computeGridSize`（与流水线同一个函数），厘米走 `beadsToCm` / `formatCm`，
 * 板数走 `boardCount`——三处都复用 core，组件里不出现第二份换算。
 *
 * 用**滑条的当前值**（`longSideDraft`）而不是 `props.longSide`：用户改完要立刻看到新尺寸，
 * 不能等父级回灌。非法输入时整块摘要隐藏，由 `blocked-reason` 说明原因。
 */
const summary = computed(() => {
  const value = longSideDraft.value;
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
  () =>
    longSideError.value ||
    colorError.value ||
    nameError.value ||
    props.generateBlockedReason,
);
const disabled = computed(() => props.busy || blockedReason.value !== "");
</script>

<template>
  <section class="space-y-6">
    <div class="block text-lg text-slate-800">
      图纸名字
      <input
        :value="nameDraft"
        data-testid="project-name-input"
        type="text"
        :maxlength="PROJECT_NAME_MAX"
        class="mt-2 block min-h-12 w-full rounded border border-slate-300 px-3 text-lg"
        @input="onNameInput"
      />
      <p data-testid="project-name-counter" class="mt-1 text-base text-slate-500">
        {{ nameDraft.trim().length }} / {{ PROJECT_NAME_MAX }} · 这个名字会印在图纸标题与文件名上
      </p>
    </div>

    <TierSlider
      label="长边豆数"
      :min="MIN_LONG_SIDE"
      :max="MAX_LONG_SIDE"
      :value="longSide"
      :nodes="LONG_SIDE_NODES"
      labels="track"
      :disabled="busy"
      input-test-id="long-side"
      slider-test-id="long-side-slider"
      @input="onLongSideInput"
    />

    <div class="block text-lg text-slate-800">
      <TierSlider
        label="用几种颜色"
        :min="1"
        :max="paletteColorCount"
        :value="maxColors"
        :nodes="COLOR_NODES"
        labels="below"
        :disabled="busy"
        input-test-id="max-colors"
        slider-test-id="max-colors-slider"
        @input="onMaxColorsInput"
      />
      <!--
        读数**只有一行**：`max-colors-value` 写「N 种」或「不限」。
        `max-colors-tier`（档位文字）已随「档位」这个概念一起删除——它承载的东西不存在了。
      -->
      <p class="text-base text-slate-500">
        生成时用色上限：<span data-testid="max-colors-value">{{ colorReadout }}</span>
      </p>
    </div>

    <div data-testid="palette-card" class="rounded border border-slate-200 bg-white p-4">
      <p class="text-lg font-semibold text-slate-900">{{ paletteName }}</p>
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
