<script setup lang="ts">
// src/components/editor/PalettePanel.vue
//
// 当前画笔槽（**它同时是选择器的唯一入口**，C8 第 3 项）+ 已用色列表（实时颗数）
// + 点当前色槽展开的选择器。
// props 进、事件出，**不读 store**；自持的状态只有两件组件内状态：「选择器是否展开」与它的
// **用途**（`pickMode`，§5.3）——两者都不是会话状态，页面重新挂载就该收起（CONTRACT §5）。
// **选中集合不在这里**：画布也要读它，所以它放在 `EditorPage`（§5.6），本组件 props 进、事件出。
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
  /**
   * 选中的**全色卡下标**集合（多选，§5.1）。
   *
   * **它可以与 `usages` 不同步**：选中期间某个色号被手动涂光就从 `usages` 里消失，而集合里还留着它
   * （§5.5「选中的是该色号的所有格子」）。那种色号只是**不计数**（`selectedRows`），不是被丢掉。
   */
  selected: readonly number[];
}>();

const emit = defineEmits<{
  "update:currentColor": [number];
  /** 切换选中时发**新数组**（画布按浅比较重绘，原地改会变成「不报错、高亮就是不刷新」，§6）。 */
  "update:selected": [readonly number[]];
  /** `sources` 是**有效选中**的全色卡下标，`to` 可以是 `EMPTY`（批量擦除，§6）。 */
  recolor: [sources: readonly number[], to: number];
}>();

/**
 * 选择器是否展开。**只在这里**，父级不持有它。
 *
 * C8 第 3 项：入口是**当前色槽本身**（点它开合，`aria-expanded` 陈述这个状态）——原来那颗
 * 「添加颜色」按钮已删除（它和色槽说的是同一件事，两颗按钮让用户以为要选一个）。独立的橡皮
 * 也搬到了工具栏（`PatternToolbar`），本面板不再有第二个入口。
 */
const picking = ref(false);

/**
 * 选择器的用途（§5.3）。点当前色槽永远是 `brush`，`[换成…]` 才是 `recolor`。
 *
 * **不做「有选中就是换色」的隐式语义**（§5.4）：用户挂着选择、只想改画笔色时，一按就误改一整片。
 * 多一次点击换「不会误伤」。
 */
const pickMode = ref<"brush" | "recolor">("brush");

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

/** 选中集合。只用于 O(1) 判定与行高亮；数组顺序不参与任何语义。 */
const selectedSet = computed(() => new Set(props.selected));

/**
 * **有效选中**的行（§7 第 1 条）：集合里的色号可能在选中期间被涂光、从 `usages` 里消失，
 * 那时它仍留在集合里但**不再算数**。操作条按这里计数——否则 UI 会撒谎（说「已选 2 个」而实际只改 1 个）。
 */
const selectedRows = computed(() => rows.value.filter((row) => selectedSet.value.has(row.index)));

/** 操作条上的「共 N 颗」：有效选中的那些行自己的 `count` 之和（§5.2）。 */
const selectedCount = computed(() => selectedRows.value.reduce((sum, row) => sum + row.count, 0));

/**
 * 点行 = 切换选中（§5.1），**发新数组**（§6）：原地改是「不报错、高亮就是不刷新」那类缺陷。
 * 集合里**保留**已从 `usages` 消失的色号——它们只是不计数（`selectedRows`），不是被悄悄抹掉。
 */
function toggleRow(index: number): void {
  const next = new Set(props.selected);
  if (!next.delete(index)) next.add(index);
  emit("update:selected", [...next]);
}

/**
 * 当前色槽是「改画笔色」的入口（§5.3 第 4 条）：开合它**总是**画笔模式。
 * 挂着选中时也如此——挑完画笔色回来，选中与操作条都还在。
 */
function togglePicker(): void {
  pickMode.value = "brush";
  picking.value = !picking.value;
}

/** `[换成…]`：打开选择器，并告诉它这次是「选目标色」。 */
function beginRecolor(): void {
  pickMode.value = "recolor";
  picking.value = true;
}

/** 选择器里的两种用途（§5.3）；两条路径都必须收起选择器（「选完即收起」）。 */
function onPick(index: number): void {
  if (pickMode.value === "recolor") {
    emit(
      "recolor",
      selectedRows.value.map((row) => row.index),
      index,
    );
  } else {
    emit("update:currentColor", index);
  }
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
      读屏用户听到的就是反的。

      **`w-full` 不能省**（C8 修复 ③a）：`<button>` 是 inline-block，`display: flex` 只是把它变成
      flex **容器**、不会让它占满整行——旧注释写「`display: flex` 是块级盒子，所以按钮仍然占满
      整行」，已被真机截图推翻（当前色槽比下面的色号带窄一截）。宽度类与 `palette-row` 逐字对齐。
    -->
    <button
      type="button"
      data-testid="palette-current"
      :aria-expanded="picking"
      class="flex min-h-11 w-full items-center gap-2 rounded border border-slate-300 bg-white px-3 text-base"
      @click="togglePicker"
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

    <!--
      选择器**紧跟当前色槽**（C8 修复 ③b）：它原先在色号列表之后（`<section>` 的最后一个子元素），
      手机竖排下被整块色号带挤到**整页最底部**——用户点开当前色槽之后还得滚很远才看得到它。
      `v-if="picking"` 与 `@pick` / `@close` 的语义都不变，只换位置。
    -->
    <PalettePicker
      v-if="picking"
      :palette="palette"
      :used-indices="usedIndices"
      :mode="pickMode"
      @pick="onPick"
      @close="picking = false"
    />

    <!--
      操作条（§5.2）：**只在有效选中 ≥ 1 个色号时渲染**。全都不算数时它不渲染，也就点不到换色
      （§7 第 1 条）——把入口藏起来比让它交出一份空的 `sources` 诚实。

      **位置只能是这里**（选择器之后、色号列表之前）：C8 修复 ③b 钉的不变式是「选择器是当前色槽的
     下一个兄弟元素」，插到那两者之间会让那条（真机截图换来的）守卫转红，它是有意保留的。
    -->
    <div
      v-if="selectedRows.length > 0"
      data-testid="select-bar"
      class="flex flex-wrap items-center gap-2 rounded border border-slate-300 bg-white px-3 py-2"
    >
      <span class="text-base text-slate-700">已选 {{ selectedRows.length }} 个色号 · 共 {{ selectedCount }} 颗</span>
      <button
        data-testid="select-bar-recolor"
        class="min-h-11 rounded bg-slate-900 px-3 text-base text-white"
        @click="beginRecolor"
      >
        换成…
      </button>
      <button
        data-testid="select-bar-clear"
        class="min-h-11 rounded border border-slate-300 px-3 text-base"
        @click="emit('update:selected', [])"
      >
        取消选择
      </button>
    </div>

    <ul class="space-y-1">
      <li v-for="row in rows" :key="row.code">
        <button
          data-testid="palette-row"
          :data-code="row.code"
          :data-current="currentColor === row.index ? '1' : undefined"
          :data-selected="selectedSet.has(row.index) ? '1' : undefined"
          class="flex min-h-11 w-full items-center gap-2 rounded px-3 text-base"
          :class="selectedSet.has(row.index) ? 'border-2 border-slate-900' : 'border border-slate-200'"
          @click="toggleRow(row.index)"
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
  </section>
</template>
