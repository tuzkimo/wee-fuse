<script setup lang="ts">
// src/components/sheet/GridTilePreview.vue
//
// 网格块预览（2026-10-13，规格 §5.3）：把「施工图中间那块网格」按**宿主给的盒子短边**现画出来。
// 生图页中栏（实时预览）与结果卡片（成品）共用它——它放在 `sheet/` 下，因为它画的是施工图那一套，
// 不是编辑器那一套（编辑器是色块层 + 手势）。
//
// 三条纪律：
// 1. **不做缩放**：格像素 = `min(盒宽 / 豆数宽, 盒高 / 豆数高)`（下限 1）——「适配短边」的字面含义。
//    一张 4×4 的图在 400px 的盒子里就是 100px/格，色号 36px；「数得清第 37 颗」不是预览的用途
//    （那要看施工图）。
// 2. **不是位图 + CSS 缩放**：按盒子尺寸现画 ⇒ 线条永远是 1–2 物理像素的清晰线，而不是被
//    `object-contain` 放大糊掉的位图（那正是这次要解决的毛病）。
// 3. **props 进、不读 store**（与其它展示组件同纪律）：它不知道草稿、不知道结果是谁的。
import { ref, watch } from "vue";
import type { Palette } from "@/core/palette/types";
import type { Pattern } from "@/core/pattern/types";
import { planGridTile } from "@/core/render/layout";
import { drawGridTile } from "@/core/render/sheet";
import { useCanvasSurface } from "@/composables/useCanvasSurface";
// 真 ctx 与 `RenderTarget2D` 有**四处**类型不兼容（`fillStyle` / `strokeStyle` / `textAlign` /
// `textBaseline`），窄化点是 `services/exporter.ts` 里那个唯一的具名函数。
import { requireContext2D } from "@/services/exporter";

const props = defineProps<{
  pattern: Pattern;
  palette: Palette;
  /** 宿主要哪个 testid 就给哪个（`ResultPanel` 给 `result-preview`，生图页给 `live-preview`）。 */
  testid: string;
}>();

const container = ref<HTMLDivElement | null>(null);
const canvas = ref<HTMLCanvasElement | null>(null);

// 量**容器**而不是画布自己（画布是 `h-full w-full`，按它自己的盒子设 `width`/`height` 属性会反过来
// 撑大盒子、形成每帧放大的循环）。尺寸与 DPR 的接线三个画布共用，见 `useCanvasSurface`。
const { viewport, dpr } = useCanvasSurface({
  container,
  canvas,
  onMeasure: () => {
    draw();
  },
});

function draw(): void {
  const element = canvas.value;
  if (element === null) return;
  const ctx = element.getContext("2d");
  if (ctx === null) return;
  const size = viewport.value;
  // 盒子的任一边为 0：什么都不画（`planGridTile` 对 0 是响亮失败，而一条量测时序不该把页面炸掉）。
  if (size.width <= 0 || size.height <= 0) return;

  const tile = planGridTile(props.pattern, props.palette, size);
  // DPR 变换只能在这里对**原生 ctx** 做（`RenderTarget2D` 里没有 `setTransform` / `clearRect`）。
  const pixelRatio = dpr.value;
  ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  ctx.clearRect(0, 0, size.width, size.height);
  // 同一个画布的 `getContext("2d")` 按规范返回同一个对象，所以上面那次变换对交出去的绘制目标
  // 同样生效。经那个唯一的窄化点把 ctx 交给渲染器（core 自己不得引用 DOM 类型）。
  drawGridTile(requireContext2D(element), props.pattern, props.palette, tile);
}

// 换图纸 / 换色卡都要重画（`ResizeObserver` 只负责尺寸那一路）。
watch([() => props.pattern, () => props.palette], () => draw());
</script>

<template>
  <div ref="container" class="h-full w-full">
    <canvas ref="canvas" :data-testid="testid" class="block h-full w-full"></canvas>
  </div>
</template>
