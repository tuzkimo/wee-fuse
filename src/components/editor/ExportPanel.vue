<script setup lang="ts">
// src/components/editor/ExportPanel.vue
//
// 打印面板（C7 起只剩**打印页**一种模式）：每页一块 29 / 58 板，A4 / A3。props 进、`close` 出。
//
// **为什么删掉 `mode="sheet"`**（人类伙伴 2026-10-09 裁定）：单张施工图原本有两个出口——
// 本面板的 sheet 模式（点「导出」打开）与首页/编辑器的「查看施工图」（`SheetViewer`）。
// 两者是同一张图，一个有保存、一个有落盘，用户分不清该点哪个。现在**只有一个出口**：
// 查看施工图（它自带保存）。本面板只服务打印页——那件事 `SheetViewer` 做不了。
//
// 三条纪律（契约 §2b / 规格 §10 / 计划任务 0 的 R-4 / R-5 / R-6）：
// 1. **本组件不 import 任何 store**：它拿到什么就画什么，「图纸是哪一份」由页面（唯一装配点）决定。
//    用例全程不建 pinia——任何 store 读取都会以「no active Pinia」在挂载期抛错，那是这条纪律的
//    运行时证明。
// 2. **清单与逐项状态都由面板自持**（R-4）：页面只做接线，一行导出逻辑都不许下沉到页面里。
// 3. **逐项导出 = 一次用户手势**（R-5）：点一次 → 渲染该页（`services/sheetExport.ts` 的 Blob 通道：
//    建画布 → 渲染 → **画布自检** → `toBlob` → 释放画布）→ **立刻经能力层落盘**
//    （`getPlatform().album.save`）→ 显示预览（`<img>` 指向同一颗 blob 的 object URL）。
//    不做连续多下载、不做 zip、不做 Web Share；任何一项失败只写该项的状态与中文原因，
//    **不影响其他项**。
//
// 分页数学**只此一份**：页身份（`boardRow` / `boardCol`）取 `boardPageTile`（内部走 `planBoardPage`）、
// 本页用量取 `usagesInRange`、页数取 `printBoardCount`、页标签的列数取 `printBoardCols`——面板自己
// **不写除法**。
// 导出**不乘 DPR**、**不经过 `renderPatternThumbnail`**（R-6）。
import { computed, onUnmounted, ref, watch } from "vue";
import type { Palette } from "@/core/palette/types";
import type { ColorUsage } from "@/core/pattern/stats";
import type { Pattern } from "@/core/pattern/types";
import { planBoardPage, printBoardCols, printBoardCount } from "@/core/render/layout";
import { exportFilename } from "@/services/exporter";
import { getPlatform } from "@/services/platform/capabilities";
import {
  boardPageTile,
  renderBoardPageBlob,
  usagesInRange,
  type SheetRenderInput,
} from "@/services/sheetExport";

const props = defineProps<{
  pattern: Pattern;
  palette: Palette;
  usages: readonly ColorUsage[];
  projectName: string;
  /** 编辑页传 `editor.revision`；结果页没有编辑通道，默认 0（「图纸换了」由 `pattern` 身份变化触发）。 */
  revision?: number;
}>();

const emit = defineEmits<{ close: [] }>();

/* ------------------------------------------------------------------ 计划 */

/**
 * 打印选项：板大小与纸张。
 *
 * **单张施工图不再有选项**——它的画布与格像素由 `planSheet` 从画布上限推出（C7 规格 §3.4），
 * 与纸张 / 板大小无关；那张图现在只在「查看施工图」里出现。
 */
const boardSize = ref<29 | 58>(29);
const paper = ref<"a4" | "a3">("a4");

/** 页数：**只问 `printBoardCount`**（它与 `planBoardPage` 是同一份分页数学的两个出口）。 */
const pageCount = computed(() =>
  printBoardCount(props.pattern.width, props.pattern.height, boardSize.value),
);

/* -------------------------------------------------------------- 逐项清单 */

interface ExportItem {
  readonly id: string;
  readonly label: string;
  /** 该页的页索引（**唯一**的页码来源，不在别处再算一遍）。 */
  readonly pageIndex: number;
  status: "idle" | "busy" | "done" | "error";
  error: string;
  previewUrl: string;
}

/**
 * 清单一页一项（`id` = `page-<页索引>`，与 `pageIndex` 同源）。
 *
 * **页标签的文案**用 `printBoardCols` 给出的列数换算行列（`第 r 行 第 c 列`），而**真正的页身份**
 * （`boardRow` / `boardCol`）由 `planBoardPage` 给出、落盘文件名取的就是它（`boardPageTile`）
 * ——两处口径同源（面板自己**不写除法**），但标签只是文案，不参与任何落盘决定。
 */
function makeItems(): ExportItem[] {
  const boardCols = printBoardCols(props.pattern.width, boardSize.value);
  return Array.from({ length: pageCount.value }, (_, index) => ({
    id: `page-${index}`,
    label: `打印页 第 ${Math.floor(index / boardCols) + 1} 行 第 ${(index % boardCols) + 1} 列（第 ${index + 1}/${pageCount.value} 页）`,
    pageIndex: index,
    status: "idle" as const,
    error: "",
    previewUrl: "",
  }));
}

/**
 * 是否有任何一项正在生成。
 *
 * **四个打印选项按钮在 `busy` 期间禁用**（第 1 轮审查要求的第 3 条）：改板大小 / 纸张会**重建清单**、
 * 把飞行中那一项丢掉。名字与字节的同源由 `SaveSnapshot` 保证（那条修复本身是硬的），禁用是**可达性**
 * 层面的第二道：不让用户走进那个窗口，也不给将来重写时序的人留下入口。
 */
const busy = computed(() => items.value.some((item) => item.status === "busy"));

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
 * **清单代数**：`rebuildItems`（图纸变了 / 打印选项变了）与 `onUnmounted` 各 +1。
 *
 * 为什么需要它而不只是 `unmounted`（修复波 B-3）：一次导出唯一的异步点是两个 `await`（渲染通道里
 * 的 `canvasToBlob`、以及经能力层落盘的 `album.save`），而 `await` 期间 `items` 可能被整体重建
 * （撤销 / 切换工程 / 换纸张），**面板却没有卸载**——此时手里那个 `item` 已经被丢弃，把新诞生的
 * object URL 写到它上面等于**永远没人回收**；更糟的是文件名若在 `await` **之后**读
 * `props.projectName`，就会产出「文件名的工程名是新的、字节是旧图纸的」这种静默错产物。
 * 代数 + 「工程名在第一个 `await` 之前取」两条一起把这两种形态堵住。
 *
 * **声明必须在 `rebuildItems()` 首次调用之前**（`let` 的 TDZ：下面那一次调用就会读它）。
 */
let generation = 0;

function rebuildItems(): void {
  // **代数自增**：飞行中的导出在 `await` 之后靠它判「我这一项（以及它用的计划 / 页索引）还在不在」。
  generation += 1;
  for (const item of items.value) revokePreview(item);
  items.value = makeItems();
}

/**
 * 重建清单的**四个源**（缺一不可）：
 * - `revision`：编辑页的 `cells` 原地写，只有它能让 `markRaw` 的图纸失效；
 * - `pattern` 的**对象身份**：`beginSession` 会把 `revision` 归零——从一张 `revision = 0` 的图纸
 *   换到另一张时（`/edit/a → /edit/b` 而面板恰好开着），0 → 0 那一跳**不触发**，清单会停在
 *   上一张图纸上；结果页更是**只有**这一条失效通道（它没有 `revision`）；
 * - `boardSize` / `paper`：页身份与页数由它们决定（29 板 16 页 ↔ 58 板 4 页）——换选项而
 *   不重建清单时，摘要会说 4 页、清单却仍是 16 项，且第 5 项之后点「保存」会用越界的页索引抛错。
 *
 * **C7 起删掉了 `mode` 那个源**：面板只剩打印一种形态，清单形状不再由 prop 决定。
 */
watch([() => props.revision, () => props.pattern, boardSize, paper], rebuildItems);
rebuildItems();

/**
 * **已经卸载**（修复轮 F6）。它必须早于 `onUnmounted` 注册、且用 `let` 而不是 `ref`：
 * `onUnmounted` 只扫**当时**的 `items.value`，而一次导出可能在异步之间被关掉
 * （关闭按钮**没有** `disabled`，用户在导出 2000×2000 那张时点「关闭」就能触发）——那个 object URL
 * 是在面板被丢弃**之后**才可能诞生的，`onUnmounted` 永远扫不到。用一个普通布尔量当下「是否已卸载」
 * 的判据，`saveItem` 在**创建 URL 之前**立刻查它。
 *
 * **如实记录它与代数判据的关系**：`onUnmounted` 同时把 `generation` +1，所以严格说
 * `generationAtStart !== generation` 已经覆盖了「面板已卸载」这一支；保留显式的 `unmounted` 是因为
 * 「面板已经卸载」在判据处读起来比「代数变了」直白，而这条语义正是一次真实泄漏的名字（B4 的既有
 * 防线，逐字保留）。**别把它的存在当成一条独立覆盖**（本项目记过账：断言存在 ≠ 断言有效）。
 */
let unmounted = false;

/**
 * 关闭面板 = **卸载**，所以 `rebuildItems` 与「重存同一项」这两条销号路径都**不会**在关闭时跑到：
 * 不在这里回收的话，用户反复「导出 → 关闭」会把每一张全分辨率 PNG 的 object URL 一直钉在内存里
 * （该 URL 在页面生命周期内永不释放，blob 也无法被回收）。这是一个**真实的泄漏**（修复轮 F3）。
 *
 * **复用 `revokePreview`、不新增实现**：销号的语义只有一份（「先 `revokeObjectURL` 再清空」）。
 * 它与 `unmounted` 是**两条互补的路径**：这一条挡「卸载发生在 URL 已经存在之后」，
 * `saveItem` 里那一条挡「卸载发生在 URL 诞生之前」。
 */
onUnmounted(() => {
  unmounted = true;
  // 卸载也算一次代数变化：`saveItem` 因此不必在两条判据里挑一条。
  generation += 1;
  for (const item of items.value) revokePreview(item);
});

/* ---------------------------------------------------------- 逐项导出 */

function statusText(item: ExportItem): string {
  if (item.status === "idle") return "待生成";
  if (item.status === "busy") return "生成中…";
  if (item.status === "done") {
    // 成功文案按**落点**分叉（规格 §5.4.3 / §7.3）：壳里进系统相册、浏览器里是下载。
    // **浏览器那一支必须逐字保持原文案**（既有用例对「已生成」有断言）。
    return getPlatform().album.kind === "album" ? "已保存到相册" : "已生成";
  }
  return `失败：${item.error}`;
}

/**
 * 落盘路径的一份**快照**（B6 任务 10 第 1 轮审查的关键修复）。
 *
 * **为什么必须整体快照、而不是逐个「记得早点取」**：名字与字节必须出自**同一次取用**。这份路径上有
 * 两个 `await`（渲染通道里的 `canvasToBlob`、以及能力层的 `album.save`），而期间用户可以改板大小 /
 * 纸张（那正是清单重建的入口）。任何一处「`await` 之后再读 `props` / `ref`」都会产出**名与字节
 * 不同源**的静默错产物：29 板的第 3 页渲染完，名字却按 58 板写成 `r2c1`；页索引在新选项下不存在时
 * 更会直接抛「页索引越界」，用户无过错却保存失败。
 *
 * 旧实现（分片时代）在 `await` 之前就把 `tile` 取好了 ⇒ 本快照是把那条纪律**恢复到**选项上
 * （工程名那条纪律由 B-3 立下，这里只是把它推广到全部入参）。
 */
interface SaveSnapshot {
  readonly pattern: Pattern;
  readonly palette: Palette;
  readonly usages: readonly ColorUsage[];
  readonly projectName: string;
  readonly boardSize: 29 | 58;
  readonly paper: "a4" | "a3";
}

/**
 * 本页用量（打印模式）：按页格范围独立统计（**不是全图用量**），打印时拿着那一页备料。
 *
 * **只吃快照**（不读 `props` / `ref`）：调用方必须拿**同一份快照**去算本页用量、渲染与命名——
 * 否则飞行中改板大小 / 纸张时，「用料条列的那一页」可能不是「画布上那一页」，而这不会有任何报错。
 */
function pageUsages(snapshot: SaveSnapshot, index: number): readonly ColorUsage[] {
  const plan = planBoardPage(snapshot.pattern, snapshot.palette, snapshot.usages, {
    boardSize: snapshot.boardSize,
    paper: snapshot.paper,
    index,
    projectName: snapshot.projectName,
  });
  return usagesInRange(snapshot.pattern, snapshot.palette, plan);
}

/**
 * 保存一项：**渲染该张 → 经能力层落盘 → 显示预览**（R-5）。
 *
 * 逐项独立：状态与原因都写在这一项上，抛错不冒泡到别的项（规格 §10.3）。
 * `busy` 期间按钮禁用（模板与四个选项按钮），函数自己再挡一次连点——手势可能比下一帧更快。
 *
 * **开头那一段快照之后，落盘路径只读局部量**（见 `SaveSnapshot` 的 JSDoc）：
 * 1. **快照与代数都在第一个 `await` 之前取**：`generationAtStart` 判「这一项还在不在」，
 *    快照保证「文件名」与「画布上那批字节」出自同一次取用；
 * 2. **文件名也在第一个 `await` 之前算好**（它不依赖 blob）：`boardPageTile` 读的是快照里的
 *    板大小 / 纸张，所以飞行中改选项既不会写错页身份、也不会用越界的页索引去算名字；
 * 3. 落盘之后若代数变了或已卸载 ⇒ **直接 return**：**连 object URL 都不创建**（创建了就是一个挂在
 *    被丢弃项上、`onUnmounted` 永远扫不到的引用），也不把状态改成「已保存到相册」（那个 UI 已经
 *    不存在了）。落盘本身**照常完成**——用户那一次手势已经点了，不该因为面板被关掉而白点。
 *
 * 落盘**必须经能力层**（规格 §5.4.3）：面板不知道具体落点，也不自己拼第二份命名逻辑
 * （名字走 `exportFilename`）。失败**照旧抛** ⇒ 冒到下面的 `catch`，只写该项的状态与中文原因。
 */
async function saveItem(item: ExportItem): Promise<void> {
  if (item.status === "busy") return;
  item.status = "busy";
  item.error = "";
  // ---- 快照：这一行之后，落盘路径**不再读 `props` / `ref`** -------------------------------
  const generationAtStart = generation;
  const snapshot: SaveSnapshot = {
    pattern: props.pattern,
    palette: props.palette,
    usages: props.usages,
    projectName: props.projectName,
    boardSize: boardSize.value,
    paper: paper.value,
  };
  const sheetInput: SheetRenderInput = {
    pattern: snapshot.pattern,
    palette: snapshot.palette,
    usages: snapshot.usages,
    projectName: snapshot.projectName,
  };
  try {
    // 名字**先算**（不依赖 blob）：它读的每一个量都来自上面那份快照。
    const filename = exportFilename(
      snapshot.projectName,
      "打印",
      boardPageTile(
        snapshot.pattern,
        snapshot.palette,
        snapshot.usages,
        snapshot.projectName,
        snapshot.boardSize,
        snapshot.paper,
        item.pageIndex,
      ),
    );
    const blob = await renderBoardPageBlob(
      {
        ...sheetInput,
        boardSize: snapshot.boardSize,
        paper: snapshot.paper,
        pageIndex: item.pageIndex,
      },
      pageUsages(snapshot, item.pageIndex),
    );
    await getPlatform().album.save(blob, filename);
    // 代数 + 卸载双判据（B4 的既有防线），**排在 `createObjectURL` 之前**：URL 根本不诞生，
    // 就没有「诞生在面板被丢弃之后、谁也回收不到」这一形态。
    if (unmounted || generationAtStart !== generation) return;
    revokePreview(item);
    item.previewUrl = URL.createObjectURL(blob);
    item.status = "done";
  } catch (error) {
    item.status = "error";
    item.error = error instanceof Error ? error.message : String(error);
  }
}

/**
 * 那句「手机上也可以长按下面的预览图存进相册」**只对浏览器成立**：壳里点「保存」就直接进系统相册 ✓，
 * 长按是多余提示（`B5-25`）。判据用渲染期读到的落点（与 `statusText` 同源 ✓）。
 * **消费者 = 模板里那句话的 `v-if`**；判别力在 `ExportPanel.test.ts`（浏览器默认落点 ⇒ 在；壳假平台 ⇒ 不在）。
 */
const showsLongPressHint = computed(() => getPlatform().album.kind === "download");
</script>

<template>
  <!--
    面板是一个**覆盖层**。`data-testid` 全部照契约的清单，**不许另造名字**：
    根 `export-panel`、摘要 `export-summary-print`、空图纸说明 `export-empty-note`、关闭 `export-close`、
    打印选项 `print-board-29` / `print-board-58` / `print-paper-a4` / `print-paper-a3`、
    逐项 `export-item-*` / `export-save-*` / `export-preview-*`。

    **C7 起只剩打印这一种形态**：单张施工图走「查看施工图」（`SheetViewer`），不再有
    `export-summary-sheet` 与 sheet 模式的清单。
  -->
  <section data-testid="export-panel" class="fixed inset-0 z-30 overflow-y-auto bg-white p-4">
    <header class="mx-auto flex max-w-3xl flex-wrap items-center justify-between gap-3">
      <h2 class="text-2xl font-bold text-slate-900">打印</h2>
      <button data-testid="export-close" class="min-h-11 rounded border border-slate-300 px-4 text-base" @click="emit('close')">关闭</button>
    </header>

    <!-- 摘要与选项：纯计算，不建画布（规格 §10.2） -->
    <div class="mx-auto mt-3 max-w-3xl space-y-1">
      <p data-testid="export-summary-print" class="text-base text-slate-700">
        共 {{ pageCount }} 页（每页一块 {{ boardSize }}×{{ boardSize }} 板 · {{ paper.toUpperCase() }}）· 打印时选「适合页面」，标题行写明了每格实际毫米。
      </p>
      <!-- 选项按钮在**任一项生成中**禁用：改选项会重建清单、把飞行中那一项丢掉（时序与可达性是一对）。 -->
      <div class="flex flex-wrap gap-2 pt-2">
        <button data-testid="print-board-29" :aria-pressed="boardSize === 29" :disabled="busy" class="min-h-11 rounded border border-slate-300 px-4 text-base disabled:opacity-50" @click="boardSize = 29">29 标准板</button>
        <button data-testid="print-board-58" :aria-pressed="boardSize === 58" :disabled="busy" class="min-h-11 rounded border border-slate-300 px-4 text-base disabled:opacity-50" @click="boardSize = 58">58 大板</button>
        <button data-testid="print-paper-a4" :aria-pressed="paper === 'a4'" :disabled="busy" class="min-h-11 rounded border border-slate-300 px-4 text-base disabled:opacity-50" @click="paper = 'a4'">A4</button>
        <button data-testid="print-paper-a3" :aria-pressed="paper === 'a3'" :disabled="busy" class="min-h-11 rounded border border-slate-300 px-4 text-base disabled:opacity-50" @click="paper = 'a3'">A3</button>
      </div>
      <p v-if="usages.length === 0" data-testid="export-empty-note" class="text-base text-amber-700">这张图纸没有可拼的像素</p>
      <p v-if="showsLongPressHint" class="text-base text-slate-500">手机上也可以长按下面的预览图存进相册。</p>
    </div>

    <!-- 逐项：一项一个「保存」，互不影响 -->
    <ul class="mx-auto mt-4 max-w-3xl space-y-3">
      <li v-for="item in items" :key="item.id" :data-testid="`export-item-${item.id}`" class="rounded border border-slate-200 p-3">
        <div class="flex flex-wrap items-center gap-3">
          <span class="text-base text-slate-900">{{ item.label }}</span>
          <button :data-testid="`export-save-${item.id}`" :disabled="item.status === 'busy'" class="min-h-11 rounded bg-slate-900 px-6 text-base text-white disabled:opacity-50" @click="saveItem(item)">保存</button>
          <span class="text-base text-slate-600">{{ statusText(item) }}</span>
        </div>
        <img v-if="item.previewUrl !== ''" :data-testid="`export-preview-${item.id}`" :src="item.previewUrl" alt="导出预览" class="mt-2 max-h-64 rounded border border-slate-200" />
      </li>
    </ul>
  </section>
</template>
