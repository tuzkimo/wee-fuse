<script setup lang="ts">
import { ref } from "vue";
import type { DecodeRequest, Decoder } from "@/core/image/decode";
import type { RgbaImage, SampledGrid } from "@/core/image/types";
import { resampleToGrid } from "@/core/image/resample";
import { createExactDecoder, createFastDecoder, createDomBitmapPlatform } from "@/services/decoders";
import { compareGrids, VISIBLE_DELTA_RGB_THRESHOLD, type GridDelta } from "@/services/gridDelta";
import { probeImageSize } from "@/services/probe";

const fileInput = ref<HTMLInputElement | null>(null);
const sourceSize = ref<string>("—");
const gridSize = ref<string>("—");
const busy = ref(false);
const error = ref("");

const CELLS = 29;
const PIXELS_PER_CELL = 4;
/** 实验台固定裁出中间一块方形区域，便于两条路径在同一输入上对比。 */
const CROP_FRACTION = 0.5;

interface PathResult {
  name: string;
  canvasUrl: string;
  filledCount: number;
  ms: number;
  /** 该路径的解码结果重采样到 CELLS×CELLS 后的网格，用于两条路径逐格对比。 */
  grid: SampledGrid;
}

const results = ref<PathResult[]>([]);
/**
 * 两条路径各自重采样到同一个 CELLS×CELLS 网格后的逐格 ΔRGB。
 *
 * 人眼判断（R1 的最终依据）之外的一份量化记录：把这里显示的三个数字记下来，
 * 换到 Android 平板上复核时直接比对同一组数字即可，不必只凭印象。
 */
const delta = ref<GridDelta | null>(null);

function imageToCanvas(image: RgbaImage, scale: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("无法获取 2D 上下文");
  const data = ctx.createImageData(image.width, image.height);
  data.data.set(image.data);
  ctx.putImageData(data, 0, 0);

  const scaled = document.createElement("canvas");
  scaled.width = image.width * scale;
  scaled.height = image.height * scale;
  const sctx = scaled.getContext("2d");
  if (sctx === null) throw new Error("无法获取 2D 上下文");
  sctx.imageSmoothingEnabled = false;
  sctx.drawImage(canvas, 0, 0, scaled.width, scaled.height);
  return scaled.toDataURL("image/png");
}

async function run() {
  const file = fileInput.value?.files?.[0];
  if (file === undefined) {
    error.value = "先选一张图片";
    return;
  }

  busy.value = true;
  error.value = "";
  results.value = [];
  delta.value = null;

  try {
    const size = await probeImageSize(file);
    sourceSize.value = `${size.width} × ${size.height}`;

    const side = Math.max(1, Math.round(Math.min(size.width, size.height) * CROP_FRACTION));
    const crop = {
      x: Math.round((size.width - side) / 2),
      y: Math.round((size.height - side) / 2),
      width: side,
      height: side,
    };

    const request: DecodeRequest = {
      crop,
      targetWidth: CELLS * PIXELS_PER_CELL,
      targetHeight: CELLS * PIXELS_PER_CELL,
    };

    const platform = createDomBitmapPlatform();
    const decoders: Decoder[] = [createFastDecoder(platform), createExactDecoder(platform)];

    for (const decoder of decoders) {
      const started = performance.now();
      const image = await decoder.decode(file, request);
      const ms = performance.now() - started;
      // 保底路径返回原生像素，这里统一重采样到同样的 29×29，才能逐格对比
      const grid = resampleToGrid(image, CELLS, CELLS);
      gridSize.value = `${grid.width} × ${grid.height}`;
      results.value.push({
        name: decoder.name,
        canvasUrl: imageToCanvas(image, 4),
        filledCount: grid.filled.reduce((sum, v) => sum + v, 0),
        ms,
        grid,
      });
    }

    // 重采样方向（两条路径不同，报告里已算过）：
    // - 快路径的解码结果恒为 116×116（即 CELLS × PIXELS_PER_CELL），到 29×29 是 4× 收缩；
    // - 保底路径返回原生裁剪像素（边长 = round(短边 × 0.5)）：边长 ≥ 29 时收缩，
    //   边长 ≤ 28（原图短边 ≤ 56）时**放大**到 29×29，而放大在 resampleToGrid 里退化为最近邻。
    // 所以小图下这组数字同时包含「解码质量差异」与「重采样方向差异」，看图时要知道这一点。
    const [fast, exact] = results.value;
    if (fast !== undefined && exact !== undefined) {
      delta.value = compareGrids(fast.grid, exact.grid);
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main class="min-h-screen bg-slate-50 p-6">
    <h1 class="text-2xl font-bold text-slate-900">解码实验台（R1）</h1>
    <p class="mt-2 max-w-3xl text-sm text-slate-600">
      同一张图、同一个裁剪框，分别走快路径（createImageBitmap 裁剪 + resizeQuality: high）
      与保底路径（裁剪出原生像素 + 自研面积平均）。把两张图放大后对比细节：快路径若出现
      块状边缘或摩尔纹，说明平台缩放在了偷工减料，正式流水线必须改用保底路径。
    </p>

    <div class="mt-4 flex flex-wrap items-center gap-3">
      <input ref="fileInput" type="file" accept="image/*" class="text-sm" />
      <button
        class="rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50"
        :disabled="busy"
        @click="run"
      >
        {{ busy ? "处理中…" : "跑对比" }}
      </button>
      <span class="text-sm text-slate-500">原图尺寸：{{ sourceSize }}</span>
      <span class="text-sm text-slate-500">网格：{{ gridSize }}</span>
    </div>

    <p v-if="error" class="mt-3 text-sm text-red-600">{{ error }}</p>

    <div class="mt-6 grid gap-6 md:grid-cols-2">
      <section v-for="r in results" :key="r.name" class="rounded bg-white p-4 shadow">
        <h2 class="text-sm font-semibold text-slate-800">{{ r.name }}</h2>
        <p class="mt-1 text-xs text-slate-500">
          耗时 {{ r.ms.toFixed(1) }} ms · 实心格 {{ r.filledCount }}
        </p>
        <img :src="r.canvasUrl" alt="" class="mt-3 w-full [image-rendering:pixelated]" />
      </section>
    </div>

    <section v-if="delta !== null" class="mt-6 max-w-3xl rounded bg-white p-4 shadow">
      <h2 class="text-sm font-semibold text-slate-800">
        两条路径的逐格差异（各自重采样到 {{ CELLS }} × {{ CELLS }} 后比较）
      </h2>
      <p class="mt-2 font-mono text-xs text-slate-700">
        最大 ΔRGB {{ delta.maxDelta.toFixed(1) }} · 平均 ΔRGB {{ delta.meanDelta.toFixed(2) }} ·
        ΔRGB &gt; {{ VISIBLE_DELTA_RGB_THRESHOLD }} 的格子 {{ delta.visibleCells }} / {{ delta.comparedCells }}
        · 空格判定不一致 {{ delta.fillMismatchCells }} 格
      </p>
      <p class="mt-2 text-xs text-slate-500">
        ΔRGB 是 sRGB 三通道的欧氏距离 sqrt(Δr² + Δg² + Δb²)，量纲 0–441.7；只统计两条路径
        都判为实心的格子，一边实心一边空格的格子单独计为「空格判定不一致」，不参与颜色比较。
        阈值 {{ VISIBLE_DELTA_RGB_THRESHOLD }} 只是「大概能看出来」的经验参考值，不是任何标准。
        这组数字用于跨设备复核 R1：人眼判断之外留一份可比对的记录。
      </p>
    </section>
  </main>
</template>
