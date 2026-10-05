<script setup lang="ts">
// src/components/editor/ExportPanel.vue
//
// 导出面板（B4）：把**内存里的图纸**（含未保存的涂改）渲染成三类 PNG，逐张由用户手势保存。
// props 进、`close` 出。
//
// 三条纪律（契约 §2b / 规格 §10 / 计划任务 0 的 R-4 / R-5 / R-6）：
// 1. **本组件不 import 任何 store**：它拿到什么就画什么，「图纸是哪一份」由页面（唯一装配点）决定。
//    用例全程不建 pinia——任何 store 读取都会以「no active Pinia」在挂载期抛错，那是这条纪律的
//    运行时证明。
// 2. **plan 与逐项状态都由面板自持**（R-4）：页面只做接线，一行导出逻辑都不许下沉到页面里。
// 3. **逐项导出 = 一次用户手势**（R-5）：点一次 → 渲染该张 → **画布自检** → `canvasToBlob` →
//    立刻 `downloadBlob` → 显示预览（`<img>` 指向同一颗 blob 的 object URL）→ **即时释放画布**。
//    不做连续多下载、不做 zip、不做 Web Share；任何一项失败只写该项的状态与中文原因，
//    **不影响其他项**。
//
// 与 `core/render/*` 的分工：plan 只出像素位置与尺寸，渲染器只按位置画，
// 面板只管「建画布 → 画 → 自检 → 存 → 预览 → 释放」。导出**不乘 DPR**、
// **不经过 `renderPatternThumbnail`**（R-6）。
import { computed, ref, watch } from "vue";
import type { Palette } from "@/core/palette/types";
import type { ColorUsage } from "@/core/pattern/stats";
import type { Pattern } from "@/core/pattern/types";
import {
  SHEET_LABEL_MIN_CELL_PX,
  planLegend,
  planShare,
  planSheets,
  type SheetTilePlan,
} from "@/core/render/layout";
import { drawLegend, drawSheetTile, type SheetMeta } from "@/core/render/sheet";
import { drawShare } from "@/core/render/share";
import {
  assertCanvasPainted,
  canvasToBlob,
  createCanvasStrict,
  downloadBlob,
  exportFilename,
  requireContext2D,
  type ExportItemLabel,
} from "@/services/exporter";

const props = defineProps<{
  pattern: Pattern;
  palette: Palette;
  usages: readonly ColorUsage[];
  projectName: string;
  revision: number;
}>();

const emit = defineEmits<{ close: [] }>();

/* ------------------------------------------------------------------ 计划 */

/**
 * 三个 plan。**它们不依赖 `revision`**（2026-10-05 控制者裁定，契约 §2b 已明写）：
 * `planSheets` / `planShare` 的输入只有图纸的**尺寸**与色卡，`planLegend` 的输入只有 `usages`
 * ——**三个都不读 `cells`**，所以「编辑一格」不改变其中任何一个。在这里写 `void props.revision;`
 * 是惰性代码，还会让后人误以为 plan 依赖编辑（于是把「plan 没跟着变」当成 bug、去查错地方）。
 *
 * 需要跟着编辑失效的是**逐项状态**，见下面那个 `watch`。
 * 将来若真有一个 plan 开始读格值，必须**同时**改契约与这里——那是一次有意的口径变化，
 * 不是顺手加一行能解决的。
 */
const sheetPlan = computed(() => planSheets(props.pattern, props.palette));
const legendPlan = computed(() => planLegend(props.usages));
const sharePlan = computed(() => planShare(props.pattern));

/** 结构化提示 → 中文文案（core 只出事实，规格 §5.3 的分工）。 */
const labelsOmitted = computed(
  () => sheetPlan.value.warnings.find((warning) => warning.code === "labels-omitted") ?? null,
);

/* -------------------------------------------------------------- 计划摘要 */

const sheetSummary = computed(() => {
  const plan = sheetPlan.value;
  const tail =
    labelsOmitted.value === null
      ? "含格内色号"
      : `已省略格内色号（画布上限 ${labelsOmitted.value.maxEdge} px 太小）`;
  return `共 ${plan.tiles.length} 张 · 每片最多 ${plan.tileCols}×${plan.tileRows} 格 · ${plan.cellPx} px/格 · ${tail}`;
});

const legendSummary = computed(() => {
  const plan = legendPlan.value;
  return `用量表 · ${plan.itemCols} 列 × ${plan.itemRows} 行 · ${plan.canvasWidth}×${plan.canvasHeight} px`;
});

const shareSummary = computed(() => {
  const plan = sharePlan.value;
  return `分享图 · ${plan.canvasWidth}×${plan.canvasHeight} px（纯色块，无网格无文字）`;
});

/**
 * 全图颗数与用色数由 `usages` 派生：`patternStats` 的定义就是「`usages` 恰是非空格色号的计数、
 * `colorCount === usages.length`、`total === Σ count`」，所以这两行与它逐字等价，
 * 且不必在面板里为信息条再走一次 O(格数) 遍历（页面已经算过一遍，规格 §5.4 的分工）。
 */
const totalBeads = computed(() => props.usages.reduce((sum, usage) => sum + usage.count, 0));
const colorCount = computed(() => props.usages.length);

/** 渲染器只吃字符串、不读 `Date`（规格 §9 第 1 条），所以每次生成取一次就够。 */
function makeMeta(generatedAt: string): SheetMeta {
  return {
    projectName: props.projectName,
    generatedAt,
    totalBeads: totalBeads.value,
    colorCount: colorCount.value,
    paletteName: props.palette.name,
    accuracy: props.palette.accuracy,
  };
}

/* -------------------------------------------------------------- 逐项清单 */

interface ExportItem {
  readonly id: string;
  readonly label: string;
  readonly kind: "sheet" | "legend" | "share";
  readonly tileIndex: number;
  status: "idle" | "busy" | "done" | "error";
  error: string;
  previewUrl: string;
}

/**
 * 分片栅格的行数 / 列数。**从 `plan.tiles` 派生**，不写第二份 `ceil(height / tileRows)` 除法
 * （渲染器被明令禁止反推网格形状，面板这一层也不该再长出一份分片数学）。
 */
const tileRowCount = computed(() =>
  sheetPlan.value.tiles.reduce((max, tile) => Math.max(max, tile.rowIndex + 1), 0),
);
const tileColCount = computed(() =>
  sheetPlan.value.tiles.reduce((max, tile) => Math.max(max, tile.colIndex + 1), 0),
);

/** 片标签的形状由契约 §2b 逐字给定。 */
function tileLabel(tile: SheetTilePlan): string {
  return `施工图 第 ${tile.rowIndex + 1}/${tileRowCount.value} 行 第 ${tile.colIndex + 1}/${tileColCount.value} 列`;
}

/** 渲染顺序 = 用量表 → 分享图 → 施工图各片（契约 §2b）。 */
function makeItems(): ExportItem[] {
  const items: ExportItem[] = [
    {
      id: "legend",
      label: "用量表",
      kind: "legend",
      tileIndex: -1,
      status: "idle",
      error: "",
      previewUrl: "",
    },
    {
      id: "share",
      label: "分享图",
      kind: "share",
      tileIndex: -1,
      status: "idle",
      error: "",
      previewUrl: "",
    },
  ];
  for (const tile of sheetPlan.value.tiles) {
    items.push({
      id: `tile-${tile.index}`,
      label: tileLabel(tile),
      kind: "sheet",
      tileIndex: tile.index,
      status: "idle",
      error: "",
      previewUrl: "",
    });
  }
  return items;
}

/**
 * 面板自持的逐项状态。`ref` 会把数组元素也变成响应式代理，所以就地改 `item.status` 即触发重渲染。
 * `previewUrl` 是 `<img>` 的来源，也是**唯一**需要在复位时销号的资源。
 */
const items = ref<ExportItem[]>([]);

/** 丢掉一项的预览：**先销号再清空**（只清 URL 会漏掉 object URL 的引用计数）。 */
function revokePreview(item: ExportItem): void {
  if (item.previewUrl === "") return;
  URL.revokeObjectURL(item.previewUrl);
  item.previewUrl = "";
}

/**
 * 图纸一变就重建清单：所有逐项状态回 `idle`、预览一律销号后丢弃（规格 §10.1）。
 * 它比「面板打开时禁止编辑」更硬——不依赖 UI 是否真的挡住了每一个改动入口：撤销、`Ctrl+Z`、
 * 工具栏在面板之上都能改到 `cells`。
 *
 * 源是**两个**（契约 §2b 逐字规定，缺一不可）：
 * - `revision`：`cells` 原地写，只有它能让 `markRaw` 的图纸失效；
 * - `pattern` 的**对象身份**：`beginSession` 会把 `revision` 归零——从一张 `revision = 0` 的图纸
 *   换到另一张时（`/edit/a → /edit/b` 而面板恰好开着），0 → 0 那一跳**不触发**，
 *   单靠 `revision` 时清单会停在上一张图纸的片数与标签上。
 *
 * 顺序写成 `[revision, pattern]` 或 `[pattern, revision]` 都可以，**两个都必须在**：
 * 顺手删掉 `() => props.pattern` 是一条会被 `计划摘要` 那组用例抓住的静默错误（见步骤 12 的 M-rev-B）。
 */
function rebuildItems(): void {
  for (const item of items.value) revokePreview(item);
  items.value = makeItems();
}

watch([() => props.revision, () => props.pattern], rebuildItems);
rebuildItems();

/* ---------------------------------------------------------- 逐项导出 */

function statusText(item: ExportItem): string {
  if (item.status === "idle") return "待生成";
  if (item.status === "busy") return "生成中…";
  if (item.status === "done") return "已生成";
  return `失败：${item.error}`;
}

/**
 * 落盘 + 出预览。两步共用**同一颗 blob**：预览就是刚下载的那一份字节，不是重新渲染的第二份。
 *
 * 文件名的第三个实参**只在施工图上传**：契约 §3 明写「用量表 / 分享图**不带**分片序号」，
 * 传一个显式的 `undefined` 也是在把「非分片项」这条语义赌在实现读不读 `arguments.length` 上。
 */
async function downloadAndPreview(
  item: ExportItem,
  canvas: HTMLCanvasElement,
  label: ExportItemLabel,
  tile?: SheetTilePlan,
): Promise<void> {
  const blob = await canvasToBlob(canvas);
  const filename =
    tile === undefined
      ? exportFilename(props.projectName, label)
      : exportFilename(props.projectName, label, tile);
  downloadBlob(blob, filename);
  revokePreview(item);
  item.previewUrl = URL.createObjectURL(blob);
}

/**
 * 保存一项：**渲染该张 → 自检 → 立刻下载 → 显示预览**（R-5）。
 *
 * 逐项独立：状态与原因都写在这一项上，抛错不冒泡到别的项（规格 §10.3）。
 * `busy` 期间按钮禁用（模板），函数自己再挡一次连点——手势可能比下一帧更快。
 *
 * 渲染完成后的两步都是**规格 §9 的防线**，顺序不能动：
 * 1. `assertCanvasPainted(canvas)`（自检，`@/services/exporter` 的导出，生产消费者就是本面板）——
 *    **只在施工图与用量表**上做：它们左上角的 `(2, 2)` 落在 `SHEET_MARGIN = 24` 的**边距**里，
 *    一定被整张白底覆盖、且该处永远没有文字（§9 第 5 条要求采样点与图纸内容无关）。
 *    **分享图故意不调用它**：分享图是纯色块、空格透明的产物，`(2, 2)` 落在透明像素上完全合法，
 *    那张图没有「必定不透明」的采样点——给它加自检会把一张合法的全透明分享图判成失败。
 * 2. 自检必须在 `canvasToBlob` **之前**：反过来的话，一张「看起来正常」的白图已经落盘了才被发现。
 * 3. 画布在 `finally` 里即时释放（§9 第 6 条：内存峰值 = 一张画布），且**晚于** `toBlob`
 *    （提前释放＝拿着 0×0 的画布去 toBlob，生产上就是一张空图）；失败路径同样要释放。
 */
async function saveItem(item: ExportItem): Promise<void> {
  if (item.status === "busy") return;
  item.status = "busy";
  item.error = "";
  let canvas: HTMLCanvasElement | null = null;
  try {
    const meta = makeMeta(new Date().toLocaleString("zh-CN"));
    if (item.kind === "legend") {
      const plan = legendPlan.value;
      canvas = createCanvasStrict(plan.canvasWidth, plan.canvasHeight);
      drawLegend(requireContext2D(canvas), props.palette, props.usages, plan, meta);
      assertCanvasPainted(canvas);
      await downloadAndPreview(item, canvas, "用量表");
    } else if (item.kind === "share") {
      const plan = sharePlan.value;
      canvas = createCanvasStrict(plan.canvasWidth, plan.canvasHeight);
      drawShare(requireContext2D(canvas), props.pattern, props.palette, plan);
      // **不调用 `assertCanvasPainted`**（理由见函数头）：分享图按设计是透明的。
      await downloadAndPreview(item, canvas, "分享图");
    } else {
      const plan = sheetPlan.value;
      const tile = plan.tiles[item.tileIndex];
      if (tile === undefined) {
        // 不可达：`tileIndex` 由本文件从 `plan.tiles` 里取。消息逐字照契约 §2b
        // （控制者裁定 11 定稿）。
        throw new Error(`施工图分片不存在：${item.id}`);
      }
      canvas = createCanvasStrict(tile.canvasWidth, tile.canvasHeight);
      drawSheetTile(requireContext2D(canvas), props.pattern, props.palette, plan, tile, meta);
      assertCanvasPainted(canvas);
      await downloadAndPreview(item, canvas, "施工图", tile);
    }
    item.status = "done";
  } catch (error) {
    item.status = "error";
    item.error = error instanceof Error ? error.message : String(error);
  } finally {
    // 逐张渲染、**即时释放**（规格 §9 第 6 条）：内存峰值 = 一张画布。
    // 放在 `finally`（不是 `try` 尾部）：失败路径也释放，否则一张失败的大画布会挂到下一次 GC。
    // 契约 §2 的 exporter 导出面里没有 release 函数（只有一个调用点，抽一个没人复用的函数正是
    // 本项目禁止的抽象），所以这一步落在面板里。
    if (canvas !== null) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}
</script>

<template>
  <!--
    面板是一个**覆盖层**（控制者裁定 10）。`data-testid` 全部照契约 §2b 的清单，**不许另造名字**：
    根 `export-panel`、摘要 `export-summary-sheet` / `-legend` / `-share`、琥珀提示
    `export-warning-labels`、空图纸说明 `export-empty-note`、关闭 `export-close`、
    逐项 `export-item-*` / `export-save-*` / `export-preview-*`。
  -->
  <section data-testid="export-panel" class="fixed inset-0 z-30 overflow-y-auto bg-white p-4">
    <header class="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3">
      <h2 class="text-2xl font-bold text-slate-900">导出图纸</h2>
      <button
        data-testid="export-close"
        class="min-h-11 rounded border border-slate-300 px-4 text-base"
        @click="emit('close')"
      >
        关闭
      </button>
    </header>

    <!-- 计划摘要：纯计算，不建画布（规格 §10.2） -->
    <div class="mx-auto mt-3 max-w-3xl space-y-1">
      <p data-testid="export-summary-sheet" class="text-base text-slate-700">{{ sheetSummary }}</p>
      <p v-if="labelsOmitted" data-testid="export-warning-labels" class="text-base text-amber-700">画布上限只有 {{ labelsOmitted.maxEdge }} px，格内色号画不下（每格 {{ labelsOmitted.cellPx }} px，低于 {{ SHEET_LABEL_MIN_CELL_PX }} px）；建议减少豆数或改小图纸。</p>
      <p data-testid="export-summary-legend" class="text-base text-slate-700">{{ legendSummary }}</p>
      <p data-testid="export-summary-share" class="text-base text-slate-700">{{ shareSummary }}</p>
      <p v-if="usages.length === 0" data-testid="export-empty-note" class="text-base text-amber-700">这张图纸没有可拼的像素</p>
      <p class="text-base text-slate-500">手机上也可以长按下面的预览图存进相册。</p>
    </div>

    <!-- 逐项：一项一个「保存」，互不影响 -->
    <ul class="mx-auto mt-4 max-w-3xl space-y-3">
      <li
        v-for="item in items"
        :key="item.id"
        :data-testid="`export-item-${item.id}`"
        class="rounded border border-slate-200 p-3"
      >
        <div class="flex flex-wrap items-center gap-3">
          <span class="text-base text-slate-900">{{ item.label }}</span>
          <button
            :data-testid="`export-save-${item.id}`"
            :disabled="item.status === 'busy'"
            class="min-h-11 rounded bg-slate-900 px-6 text-base text-white disabled:opacity-50"
            @click="saveItem(item)"
          >
            保存
          </button>
          <span class="text-base text-slate-600">{{ statusText(item) }}</span>
        </div>
        <img
          v-if="item.previewUrl !== ''"
          :data-testid="`export-preview-${item.id}`"
          :src="item.previewUrl"
          alt="导出预览"
          class="mt-2 max-h-64 rounded border border-slate-200"
        />
      </li>
    </ul>
  </section>
</template>
