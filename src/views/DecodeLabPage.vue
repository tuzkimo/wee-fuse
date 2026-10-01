<script setup lang="ts">
import { computed, ref } from "vue";
import type { DecodeRequest, Decoder } from "@/core/image/decode";
import type { SampledGrid } from "@/core/image/types";
import { resampleToGrid } from "@/core/image/resample";
import { createExactDecoder, createFastDecoder, createDomBitmapPlatform } from "@/services/decoders";
import { compareGrids, VISIBLE_DELTA_RGB_THRESHOLD, type GridDelta } from "@/services/gridDelta";
import {
  GRID_CELL_PREVIEW_PX,
  RAW_PREVIEW_MAX_EDGE,
  renderGridPreview,
  renderRawPreview,
} from "@/services/preview";
import { probeImageSize } from "@/services/probe";

const fileInput = ref<HTMLInputElement | null>(null);
const sourceSize = ref<string>("—");
const gridSize = ref<string>("—");
const busy = ref(false);
const error = ref("");

const CELLS = 29;
const PIXELS_PER_CELL = 4;
/** 首段滤波度量的网格边长：与快路径的解码目标一致（29 × 4 = 116）。 */
const STAGE_CELLS = CELLS * PIXELS_PER_CELL;
/** 成品对比视图的长边（像素）：29 格 × 每格像素数。 */
const COMPARISON_LONG_EDGE = CELLS * GRID_CELL_PREVIEW_PX;
/** 实验台固定裁出中间一块方形区域，便于两条路径在同一输入上对比。 */
const CROP_FRACTION = 0.5;

interface PathResult {
  name: string;
  /** 原生解码输出的像素尺寸（快路径 116²，保底路径 `side²`）。 */
  nativeWidth: number;
  nativeHeight: number;
  /** 成品对比视图：29×29 豆格、每格 GRID_CELL_PREVIEW_PX px。 */
  comparisonUrl: string;
  /** 原始解码输出诊断视图（原生像素 1:1）；超过 RAW_PREVIEW_MAX_EDGE 时为 null。 */
  rawUrl: string | null;
  filledCount: number;
  /** 解码 + 成品重采样（29×29）耗时（毫秒）。不含首段度量与预览渲染。 */
  decodeAndResampleMs: number;
  /** 成品网格（29×29）。 */
  grid: SampledGrid;
  /** 首段网格（116×116）：原生像素用 resampleToGrid 归一到快路径的解码目标。 */
  stageGrid: SampledGrid;
}

const results = ref<PathResult[]>([]);
/**
 * **首段滤波差异（回答 R1）**：快路径的 116² 解码输出 vs 保底路径原生像素归一到 116²。
 * 只反映「Skia 的 resizeWidth 是不是合格的重采样滤波器」。
 */
const stageDelta = ref<GridDelta | null>(null);
/**
 * **成品差异**：两条路径各自归到 29×29 后的逐格差异。它是「两段式 vs 一段式」的总代价，
 * 同时混入首段滤波质量与两段式降采样本身的固有信息损失，不能单独回答 R1。
 */
const productDelta = ref<GridDelta | null>(null);

/**
 * 只有一条路径成功时，页面上会剩下一张图 + 一行错误，很容易被当成有效对比读。
 * 这种情况必须显式标注；`results.length === 0`（两条都失败）由 error 行覆盖，不必重复提示。
 */
const comparisonIncomplete = computed(() => !busy.value && results.value.length === 1);

async function run() {
  const file = fileInput.value?.files?.[0];
  if (file === undefined) {
    error.value = "先选一张图片";
    return;
  }

  busy.value = true;
  error.value = "";
  results.value = [];
  stageDelta.value = null;
  productDelta.value = null;

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
      targetWidth: STAGE_CELLS,
      targetHeight: STAGE_CELLS,
    };

    const platform = createDomBitmapPlatform();
    const decoders: Decoder[] = [createFastDecoder(platform), createExactDecoder(platform)];

    for (const decoder of decoders) {
      // 计时覆盖「解码 + 成品重采样」：保底路径的重采样是整条产品链路上最贵的一步
      // （对最多 1500² 像素做面积平均），只包住 decode 会让展示的耗时系统性偏向保底路径。
      // 首段度量的 116² 重采样与预览渲染都是仪表开销，不计入。
      const started = performance.now();
      const image = await decoder.decode(file, request);
      // 保底路径返回原生像素，这里统一重采样到同样的 29×29，才能逐格对比
      const grid = resampleToGrid(image, CELLS, CELLS);
      const decodeAndResampleMs = performance.now() - started;

      // 首段度量：把原生像素归一到快路径的解码目标 116²。源宽 == 目标宽时 resampleToGrid
      // 是 1:1 精确复制，所以对快路径是恒等变换，不额外引入插值。
      const stageGrid = resampleToGrid(image, STAGE_CELLS, STAGE_CELLS);

      gridSize.value = `${grid.width} × ${grid.height}`;
      const nativeLongEdge = Math.max(image.width, image.height);
      results.value.push({
        name: decoder.name,
        nativeWidth: image.width,
        nativeHeight: image.height,
        comparisonUrl: renderGridPreview(grid),
        rawUrl: nativeLongEdge <= RAW_PREVIEW_MAX_EDGE ? renderRawPreview(image) : null,
        filledCount: grid.filled.reduce((sum, v) => sum + v, 0),
        decodeAndResampleMs,
        grid,
        stageGrid,
      });
    }

    // 重采样方向（两条路径不同）：
    // - 快路径的解码结果恒为 116×116（即 CELLS × PIXELS_PER_CELL），到 29×29 是 4× 收缩；
    // - 保底路径返回原生裁剪像素（边长 = max(1, round(原图短边 × 0.5))）：边长 > 29 时收缩、
    //   边长 = 29 时是恒等映射（每格取 1 个原像素）、边长 ≤ 28（原图短边 ≤ 56）时**放大**
    //   到 29×29，而放大在 resampleToGrid 里退化为最近邻。
    // 116² 那一层同理：快路径是恒等，保底路径是收缩（或极小图下的放大）。
    const [fast, exact] = results.value;
    if (fast !== undefined && exact !== undefined) {
      stageDelta.value = compareGrids(fast.stageGrid, exact.stageGrid);
      productDelta.value = compareGrids(fast.grid, exact.grid);
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
      与保底路径（裁剪出原生像素 + 自研面积平均）。主对比看的是 <b>29×29 成品</b>：两侧都由各自的
      豆格渲染、每格 {{ GRID_CELL_PREVIEW_PX }} px、同一最近邻设定，信息量完全相同，所以差别只有格子颜色。
      原始解码输出另有一块 1:1 诊断视图，只用于看首段滤波干了什么，<b>不要用它比清晰度</b>。
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
      <span class="text-sm text-slate-500">成品网格：{{ gridSize }}</span>
      <span class="text-sm text-slate-500">成品对比视图：{{ COMPARISON_LONG_EDGE }} px</span>
    </div>

    <p v-if="error" class="mt-3 text-sm text-red-600">{{ error }}</p>

    <p
      v-if="comparisonIncomplete"
      data-testid="incomplete-note"
      class="mt-3 rounded bg-amber-50 p-3 text-sm font-semibold text-amber-800"
    >
      对比不完整：两条路径只有一条成功，下面这张图不能与另一条路径对比，请不要据此判断解码质量。
    </p>

    <div class="mt-6 grid gap-6 md:grid-cols-2">
      <section
        v-for="r in results"
        :key="r.name"
        data-testid="path-result"
        class="rounded bg-white p-4 shadow"
      >
        <h2 class="text-sm font-semibold text-slate-800">{{ r.name }}</h2>
        <p class="mt-1 text-xs text-slate-500">
          解码 + 成品重采样 {{ r.decodeAndResampleMs.toFixed(1) }} ms · 实心格 {{ r.filledCount }} ·
          原生输出 {{ r.nativeWidth }} × {{ r.nativeHeight }}
        </p>

        <div data-testid="comparison-view" class="mt-3 rounded bg-slate-50 p-2">
          <h3 class="text-xs font-semibold text-slate-700">
            成品对比（信息对等）：{{ CELLS }} × {{ CELLS }} 豆格 → 每格 {{ GRID_CELL_PREVIEW_PX }} px
          </h3>
          <p class="mt-1 text-xs text-slate-500">
            两侧都由各自的豆格渲染、同一倍率、同一最近邻设定，且空格都画成透明。
            唯一的差别是格子颜色——这正是「29×29 成品差异」那组数字比的东西。
          </p>
          <img :src="r.comparisonUrl" alt="" class="mt-2 w-full" />
        </div>

        <div data-testid="raw-view" class="mt-3 border-t border-slate-100 pt-3">
          <h3 class="text-xs font-semibold text-slate-700">
            原始解码输出（仅诊断，不用于对比）
          </h3>
          <template v-if="r.rawUrl !== null">
            <p class="mt-1 text-xs text-slate-500">
              原生像素 1:1（{{ r.nativeWidth }} × {{ r.nativeHeight }}），没有重采样。
              两条路径的原生尺寸本来就不同，这一块只为看首段滤波把像素变成了什么样，
              倍率不一样是预期的，别拿它比较清晰度。
              <b>显示级提示：</b>这一块用 <code>image-rendering: pixelated</code> 且宽度撑满列，
              原生边长大于列宽的（保底路径的 750² / 1500²）实际是被浏览器**最近邻缩小**，
              会凭空出现摩尔纹与块状边缘——那是显示伪影，不是解码结果，更不是质量指标。
            </p>
            <img
              :src="r.rawUrl"
              alt=""
              class="mt-2 max-w-full [image-rendering:pixelated]"
            />
          </template>
          <p v-else class="mt-1 text-xs text-amber-700">
            原生输出 {{ r.nativeWidth }} × {{ r.nativeHeight }} 的长边超过诊断视图上限
            {{ RAW_PREVIEW_MAX_EDGE }} px，未渲染 1:1 位图——否则实验台自己的预览内存（画布 + PNG 编码）
            会重新变成 OOM 归因里那个说不清的变量。差异数字仍然照常计算。
          </p>
        </div>
      </section>
    </div>

    <section
      v-if="stageDelta !== null"
      data-testid="stage-delta"
      class="mt-6 max-w-3xl rounded bg-white p-4 shadow"
    >
      <h2 class="text-sm font-semibold text-slate-800">
        116² 首段滤波差异（回答 R1）
      </h2>
      <p class="mt-2 font-mono text-xs text-slate-700">
        最大 ΔRGB {{ stageDelta.maxDelta.toFixed(2) }} · 平均 ΔRGB {{ stageDelta.meanDelta.toFixed(3) }} ·
        ΔRGB &gt; {{ VISIBLE_DELTA_RGB_THRESHOLD }} 的格子 {{ stageDelta.visibleCells }} / {{ stageDelta.comparedCells }}
        · 空格判定不一致 {{ stageDelta.fillMismatchCells }} 格
      </p>
      <p class="mt-2 text-xs text-slate-500">
        口径：把快路径的 {{ STAGE_CELLS }}² 解码输出（Skia 的裁剪 + 缩放结果）与「保底路径的原生像素用
        resampleToGrid 缩到 {{ STAGE_CELLS }}²」逐格比较。两组都归到 {{ STAGE_CELLS }}²，
        源宽 == 目标宽时 resampleToGrid 是 1:1 精确复制，所以这一步对快路径是恒等变换、
        不额外引入插值。<b>这组数字只反映首段滤波质量</b>，与下面那组成品差异含义不同，不要混看。
      </p>
      <p class="mt-2 text-xs text-slate-500">
        判定口径：这组数字<b>明显小</b>（与成品差异同量级或更小）→ Skia 的首段缩放是合格的面积类滤波
        → 快路径安全；<b>显著偏大</b>（平均 ΔRGB 远高于成品差异，或大量格子超阈值）→ 首段滤波有信息损失
        → 应走保底路径。阈值 {{ VISIBLE_DELTA_RGB_THRESHOLD }} 仍是经验参考值，不是标准。
        同一行里的「空格判定不一致 {{ stageDelta.fillMismatchCells }} 格」是**同源的第二路不一致信号**：
        它统计的是两条路径对同一格判「实心 / 空格」结论相反的格子数，量级大意味着有大量格子落在
        alpha 覆盖率阈值附近被两侧判反——它不进颜色比较，所以必须与 ΔRGB 一起读，不能只看其中一个。
      </p>
    </section>

    <section
      v-if="productDelta !== null"
      data-testid="product-delta"
      class="mt-6 max-w-3xl rounded bg-white p-4 shadow"
    >
      <h2 class="text-sm font-semibold text-slate-800">
        29×29 成品差异（两段式 vs 一段式的总代价）
      </h2>
      <p class="mt-2 font-mono text-xs text-slate-700">
        最大 ΔRGB {{ productDelta.maxDelta.toFixed(2) }} · 平均 ΔRGB {{ productDelta.meanDelta.toFixed(3) }} ·
        ΔRGB &gt; {{ VISIBLE_DELTA_RGB_THRESHOLD }} 的格子 {{ productDelta.visibleCells }} / {{ productDelta.comparedCells }}
        · 空格判定不一致 {{ productDelta.fillMismatchCells }} 格
      </p>
      <p class="mt-2 text-xs text-slate-500">
        口径：两条路径各自重采样到 {{ CELLS }} × {{ CELLS }} 后逐格比较。这组数字同时包含
        「Skia 首段滤波质量」与「两段式降采样相对一段式的固有信息损失」——即使 Skia 是完美的面积平均
        滤波器，Box(4) 之后再做一次降采样与直接一次降采样也不可能完全相同（高对比边缘处尤甚）。
        所以<b>它不能单独回答 R1</b>，回答 R1 的是上面那组 116² 首段差异。
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
