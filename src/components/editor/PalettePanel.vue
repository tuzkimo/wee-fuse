<script setup lang="ts">
// src/components/editor/PalettePanel.vue
//
// 当前画笔槽（**它同时是选择器的唯一入口**，C8 第 3 项）+ 已用色列表（实时颗数）
// + 点当前色槽展开的选择器。
// props 进、事件出，**不读 store**；唯一自持的状态是「选择器是否展开」——展开与否不是会话状态，
// 页面重新挂载就该收起（CONTRACT §5）。
//
// **色号 → 全色卡下标这一层复用 core 的权威映射**（规格 §9.2）：`usages` 里只有
// `code` / `name` / `count`、**没有下标**，自己再写一份 `code → index` 表就是本仓库第 3 份同源
// 副本，而「按下标直接搬」会把每个色号静默标成另一个名字（`core/project/file.ts` 的 JSDoc
// 记的正是这一类：B1 规格 §5.2 的静默错位风险点）。这里用既有的
// `createPaletteRuntime(palette).indexByCode`，并在查不到时**响亮失败**——口径与
// `file.ts:139` 的 `色卡里找不到色号 ${code}` 一致，不用 `?? 0` 那种静默回落。
import { computed, ref } from "vue";
import { createPaletteRuntime } from "@/core/palette/registry";
import type { Palette, PaletteColor } from "@/core/palette/types";
import type { ColorUsage } from "@/core/pattern/stats";
import { EMPTY } from "@/core/pattern/types";
import type { RGB } from "@/core/color/space";
import PalettePicker from "./PalettePicker.vue";

const props = defineProps<{
  palette: Palette;
  /** 来自 `patternStats(pattern, palette).usages`：用量降序、同量按色号升序。 */
  usages: readonly ColorUsage[];
  /** `0..palette.colors.length-1` 或 `EMPTY`（橡皮）。 */
  currentColor: number;
}>();

const emit = defineEmits<{
  "update:currentColor": [number];
}>();

/**
 * 选择器是否展开。**只在这里**，父级不持有它。
 *
 * C8 第 3 项：入口是**当前色槽本身**（点它开合，`aria-expanded` 陈述这个状态）——原来那颗
 * 「添加颜色」按钮已删除（它和色槽说的是同一件事，两颗按钮让用户以为要选一个）。独立的橡皮
 * 也搬到了工具栏（`PatternToolbar`），本面板不再有第二个入口。
 */
const picking = ref(false);

/** 那张权威的 `code → 全色卡下标` 表（`createPaletteRuntime` 是既有导出）。 */
const indexByCode = computed(() => createPaletteRuntime(props.palette).indexByCode);

/** 已用色列表的一行。`index` 是**全色卡下标**，不是它在 `usages` 里的位置。 */
interface UsageRow {
  readonly index: number;
  readonly code: string;
  readonly count: number;
  readonly rgb: RGB;
}

/**
 * 行序 = `usages` 自己的顺序（`patternStats` 已按用量降序、同量按色号升序排好），
 * 本层**不再排序**：再排一次就会与用量表的口径不一致。
 *
 * **色号查不到时为何是抛错而不是跳过那一行**（控制者裁决 3）：`patternStats` 对色卡外的下标
 * 会兜底成 `#N` 这种色号，而 `#N` 在本面板上**没有可点的全色卡下标**。跳过该行的写法会让
 * 一行用量凭空消失，而 `total` / `colorCount` 仍然把它算在内——用户看到的总颗数与清单从此
 * 对不上，且没有任何信号；emit 一个凭空造的下标更糟，那是静默涂错色。响亮失败是本仓库的既有
 * 口径（`core/project/file.ts:139`「避免 `?? 0` 那种静默回落」）。这条分支在生产路径上不可达
 * （`setCurrentColor` / `beginSession` 守了色数上界，`fromProjectDocument` 读文件时就会抛错），
 * 它是防御而不是功能。
 */
const rows = computed<UsageRow[]>(() =>
  props.usages.map((item) => {
    const index = indexByCode.value.get(item.code);
    if (index === undefined) {
      throw new Error(`色卡里找不到色号 ${item.code}`);
    }
    const color = props.palette.colors[index];
    return { index, code: color.code, count: item.count, rgb: color.rgb };
  }),
);

/**
 * 当前画笔槽的颜色。`currentColor` 是 `EMPTY`（橡皮）时没有颜色可显示。
 *
 * **越界（`>= colors.length` 且 `!== EMPTY`）时渲染期抛错，不回落成「橡皮」。**
 * 这条与 `rows` 那条守卫同源：把越界值显示成「橡皮」是在**谎报状态**——
 * 画面上完全看不出错，用户以为自己在涂空格，而画笔实际握着一个色卡外的下标；
 * 一旦落笔，`core/pattern/edit.ts` 只守 `0..EMPTY`（不守色数上界），那个值就被**静默涂开**。
 * 与裁决 3 的口径一致（`core/project/file.ts`：查不到就响亮失败），故不静默回落。
 *
 * 这是**防御性分支，生产路径不可达**——三处写入者都收了口：
 * `editor.setCurrentColor`（`src/stores/editor.ts:283-288`，越界即抛）、
 * `editor.beginSession` 的播种（`:217`，色卡外回落 0）、
 * `editor.pickFromCell`（`:356-362`，经 `setCurrentColor` 的同一份守卫）。
 * 组件是纯展示组件，props 可以被喂任何值，所以这条分支仍然要拦。
 *
 * `EMPTY` 是「橡皮」这个**合法状态**的取值，必须放行。
 */
const current = computed<PaletteColor | null>(() => {
  const value = props.currentColor;
  if (value === EMPTY) return null;
  const color = props.palette.colors[value];
  if (color === undefined) {
    const reason = `当前色号越界：${String(value)}（色卡 ${props.palette.id} 只有 ${String(props.palette.colors.length)} 色，合法值是 0–${String(props.palette.colors.length - 1)}，或 ${String(EMPTY)} 表示橡皮）`;
    // 直接抛 `Error`（不是把原因拼成字符串、让这个 computed 返回 `undefined`）：这个 computed 也
    // 可能被非模板代码读出，而异常会在**渲染期**把原因抛给调用方（@vue/test-utils 的挂载期断言就靠这条）。
    throw new Error(reason);
  }
  return color;
});

/** 喂给选择器的已用色下标——它就是 `rows` 的下标，来源仍是那一处权威映射。 */
const usedIndices = computed(() => rows.value.map((row) => row.index));

/** 「选中即设为当前色并关闭」（§9.1 第 3 条）：两件事必须一起做。 */
function onPick(index: number): void {
  emit("update:currentColor", index);
  picking.value = false;
}
</script>

<template>
  <section class="space-y-4">
    <!--
      当前画笔槽：**不随已用色列表变化**（§9.1 第 1 条）。它必须固定，因为从选择器里选中的色
      很可能用了 0 颗、不在列表里（裁决 3 的直接后果）。

      C8 第 3 项起它还是**选择器的唯一入口**：原来那颗「添加颜色」按钮删除，改成点色槽本身开合
      （`picking = !picking`）。`aria-expanded` 是它对辅助技术的状态陈述——绑错或恒为某一个值，
      读屏用户听到的就是反的。`display: flex` 是块级盒子，所以按钮仍然占满整行（与原来的 `div` 同宽）。
    -->
    <button
      type="button"
      data-testid="palette-current"
      :aria-expanded="picking"
      class="flex min-h-11 items-center gap-2 rounded border border-slate-300 bg-white px-3 text-base"
      @click="picking = !picking"
    >
      <template v-if="current">
        <span
          class="inline-block h-6 w-6 rounded border border-slate-300"
          :style="{ backgroundColor: `rgb(${current.rgb[0]}, ${current.rgb[1]}, ${current.rgb[2]})` }"
        />
        <span class="font-semibold">{{ current.code }}</span>
        <span v-if="current.name" class="text-slate-500">{{ current.name }}</span>
      </template>
      <!-- 橡皮态只在这儿显示「橡皮」：独立的橡皮按钮在工具栏上（C8 第 3 项） -->
      <span v-else class="font-semibold">橡皮</span>
    </button>

    <ul class="space-y-1">
      <li v-for="row in rows" :key="row.code">
        <button
          data-testid="palette-row"
          :data-code="row.code"
          :data-current="currentColor === row.index ? '1' : undefined"
          class="flex min-h-11 w-full items-center gap-2 rounded border border-slate-200 px-3 text-base"
          @click="emit('update:currentColor', row.index)"
        >
          <span
            class="inline-block h-6 w-6 rounded border border-slate-300"
            :style="{ backgroundColor: `rgb(${row.rgb[0]}, ${row.rgb[1]}, ${row.rgb[2]})` }"
          />
          <span class="font-semibold">{{ row.code }}</span>
          <span class="text-slate-500">{{ row.count }} 颗</span>
        </button>
      </li>
    </ul>

    <PalettePicker
      v-if="picking"
      :palette="palette"
      :used-indices="usedIndices"
      @pick="onPick"
      @close="picking = false"
    />
  </section>
</template>
