<script setup lang="ts">
// src/components/editor/PalettePicker.vue
//
// MARD 221 全色卡选择器：按色号首字母分组、色块 + 色号、已用色加标记。
// props 进、事件出，**不读 store、不 import services**（色卡由父级以 props 给进来）。
//
// **分组顺序取数据里首次出现的顺序**，不硬编码九色系表、也不按字母排序：色卡是可插拔的
// （主规格 §4.2），写死「A–H + M」等于给别的色卡套 MARD 的分组。真实 MARD221 的首次出现
// 顺序恰好就是 A–H + M，所以真实数据分不出这两种写法——用例用一份乱序夹具钉住。
//
// 色号形如 `A1` / `H1` / `M1`，首字母即色系；`Map` 按插入顺序迭代，因此天然保序。
import { computed } from "vue";
import type { RGB } from "@/core/color/space";
import type { Palette } from "@/core/palette/types";

const props = defineProps<{
  palette: Palette;
  /** 已用色的**全色卡下标**（与 `Pattern.cells` / `currentColor` 同一口径，§9.2）。 */
  usedIndices: readonly number[];
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
</script>

<template>
  <section data-testid="picker" class="rounded border border-slate-300 bg-white p-3">
    <header class="flex items-center justify-between gap-2">
      <h2 class="text-base font-semibold text-slate-900">{{ palette.name }}</h2>
      <button
        data-testid="picker-close"
        class="min-h-11 min-w-11 rounded border border-slate-300 px-3 text-base"
        @click="emit('close')"
      >
        关闭
      </button>
    </header>

    <div
      v-for="group in groups"
      :key="group.letter"
      data-testid="picker-group"
      :data-letter="group.letter"
      class="mt-3"
    >
      <h3 class="text-base text-slate-600">{{ group.letter }} 色系</h3>
      <div class="mt-1 grid grid-cols-6 gap-1">
        <button
          v-for="color in group.colors"
          :key="color.code"
          data-testid="picker-color"
          :data-code="color.code"
          :data-rgb="color.rgb.join(',')"
          :data-used="used.has(color.index) ? '1' : undefined"
          class="min-h-11 min-w-11 rounded border border-slate-200 text-base text-slate-700"
          :style="{ backgroundColor: `rgb(${color.rgb[0]}, ${color.rgb[1]}, ${color.rgb[2]})` }"
          @click="emit('pick', color.index)"
        >
          {{ color.code }}
        </button>
      </div>
    </div>
  </section>
</template>
