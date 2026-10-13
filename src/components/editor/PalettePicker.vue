<script setup lang="ts">
// src/components/editor/PalettePicker.vue
//
// MARD 221 全色卡选择器：顶部一组「已用色」快捷入口（按 `usedIndices` 顺序），下面按色号首字母
// 分组、色块 + 色号、已用色加标记。
// `mode` 决定用途（§5.3）：`recolor` 时多一个橡皮项、交出的都是目标色；`brush` 时是画笔色。
// props 进、事件出，**不读 store、不 import services**（色卡由父级以 props 给进来）。
//
// **分组顺序取数据里首次出现的顺序**，不硬编码九色系表、也不按字母排序：色卡是可插拔的
// （主规格 §4.2），写死「A–H + M」等于给别的色卡套 MARD 的分组。真实 MARD221 的首次出现
// 顺序恰好就是 A–H + M，所以真实数据分不出这两种写法——用例用一份乱序夹具钉住。
//
// 色号形如 `A1` / `H1` / `M1`，首字母即色系；`Map` 按插入顺序迭代，因此天然保序。
import { computed } from "vue";
import { EMPTY } from "@/core/pattern/types";
import type { RGB } from "@/core/color/space";
import type { Palette } from "@/core/palette/types";

const props = defineProps<{
  palette: Palette;
  /** 已用色的**全色卡下标**（与 `Pattern.cells` / `currentColor` 同一口径，§9.2）。 */
  usedIndices: readonly number[];
  /** 选择器用途：`recolor` 时多给一个橡皮项（emit `EMPTY`），其余同 `brush`。 */
  mode: "brush" | "recolor";
}>();

const emit = defineEmits<{
  pick: [number];
  close: [];
}>();

interface GroupColor {
  readonly index: number;
  readonly code: string;
  /** 复用 core 的 `RGB`，不另写内联副本（`PaletteColor.rgb` 就是它）。 */
  readonly rgb: RGB;
}

interface ColorGroup {
  readonly letter: string;
  readonly colors: readonly GroupColor[];
}

const groups = computed<ColorGroup[]>(() => {
  const byLetter = new Map<string, GroupColor[]>();
  props.palette.colors.forEach((color, index) => {
    const letter = color.code.slice(0, 1);
    const item: GroupColor = { index, code: color.code, rgb: color.rgb };
    const bucket = byLetter.get(letter);
    if (bucket === undefined) byLetter.set(letter, [item]);
    else bucket.push(item);
  });
  return [...byLetter.entries()].map(([letter, colors]) => ({ letter, colors }));
});

/** 已用色集合。只用于**标记**，不参与分组。 */
const used = computed(() => new Set(props.usedIndices));

/** 顶部快捷组：按 `usedIndices` 的顺序直接取 `palette.colors[i]`，不重算色号→下标。 */
const usedItems = computed(() =>
  props.usedIndices.map((index) => ({ index, color: props.palette.colors[index] })),
);
</script>

<template>
  <section data-testid="picker" class="rounded-bead-md border-4 border-bead-ink bg-bead-card p-3 shadow-pop-lg">
    <header class="flex items-center justify-between gap-2">
      <h2 class="text-[24px] text-bead-ink">{{ palette.name }}</h2>
      <button
        data-testid="picker-close"
        aria-label="关闭"
        class="min-h-14 min-w-14 rounded-bead-sm border-4 border-bead-ink bg-bead-card px-3 text-[24px] text-bead-ink"
        @click="emit('close')"
      >
        关闭
      </button>
    </header>

    <button
      v-if="mode === 'recolor'"
      data-testid="picker-eraser"
      class="mt-3 min-h-14 min-w-14 rounded-bead-sm border-4 border-bead-ink bg-bead-card px-3 text-[24px] text-bead-ink"
      @click="emit('pick', EMPTY)"
    >
      橡皮（空格）
    </button>

    <div v-if="usedItems.length > 0" class="mt-3">
      <h3 class="text-[24px] text-bead-ink">已用色</h3>
      <!-- 平板右栏只有 250px（减卡片 4px 描边与 p-3 后 ≈ 218px 可用）：6×56px + 5×4px gap
           ≈ 356px 会重叠，§7.4 定的是 3 列（3×56 + 2×4 = 176px）；手机视口更窄、6 列同样放不下，
           但 3 列在 360px 上太浪费，故窄屏取 5 列（5×56 + 4×4 = 296px）。 -->
      <div class="mt-1 grid grid-cols-5 gap-1 md:grid-cols-3">
        <button
          v-for="item in usedItems"
          :key="item.index"
          data-testid="picker-used"
          :data-used-code="item.color.code"
          class="min-h-14 min-w-14 rounded-bead-sm border-3 border-bead-ink text-[24px] text-bead-ink"
          :style="{ backgroundColor: `rgb(${item.color.rgb[0]}, ${item.color.rgb[1]}, ${item.color.rgb[2]})` }"
          @click="emit('pick', item.index)"
        >
          {{ item.color.code }}
        </button>
      </div>
    </div>

    <div
      v-for="group in groups"
      :key="group.letter"
      data-testid="picker-group"
      :data-letter="group.letter"
      class="mt-3"
    >
      <h3 class="text-[24px] text-bead-ink">{{ group.letter }} 色系</h3>
      <div class="mt-1 grid grid-cols-5 gap-1 md:grid-cols-3">
        <button
          v-for="color in group.colors"
          :key="color.code"
          data-testid="picker-color"
          :data-code="color.code"
          :data-rgb="color.rgb.join(',')"
          :data-used="used.has(color.index) ? '1' : undefined"
          class="min-h-14 min-w-14 rounded-bead-sm border-3 border-bead-ink text-[24px] text-bead-ink"
          :style="{ backgroundColor: `rgb(${color.rgb[0]}, ${color.rgb[1]}, ${color.rgb[2]})` }"
          @click="emit('pick', color.index)"
        >
          {{ color.code }}
        </button>
      </div>
    </div>
  </section>
</template>
