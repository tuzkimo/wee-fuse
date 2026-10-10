<script setup lang="ts">
// src/components/editor/ExportPanel.vue
//
// 打印面板（C7 起只剩**打印页**一种模式）：每页一块 29 / 58 板，A4 / A3。
// **C8 第 7 项改版**：从「一页一项 + 每项一个保存按钮 + 保存之后才看得到预览」改成
// 「**多页预览条 + 一个保存按钮**」——横向滑动看每一页，一键**顺序**存满全部分页并显示进度。
//
// **为什么删掉 `mode="sheet"`**（人类伙伴 2026-10-09 裁定）：单张施工图原本有两个出口——
// 本面板的 sheet 模式（点「导出」打开）与首页/编辑器的「查看施工图」（`SheetViewer`）。
// 两者是同一张图，一个有保存、一个有落盘，用户分不清该点哪个。现在**只有一个出口**：
// 查看施工图（它自带保存）。本面板只服务打印页——那件事 `SheetViewer` 做不了。
//
// 四条纪律（契约 §2b / 规格 §10 / 计划任务 0 的 R-4 / R-5 / R-6）：
// 1. **本组件不 import 任何 store**：它拿到什么就画什么，「图纸是哪一份」由页面（唯一装配点）决定。
//    用例全程不建 pinia——任何 store 读取都会以「no active Pinia」在挂载期抛错，那是这条纪律的
//    运行时证明。
// 2. **预览与保存状态都由面板自持**（R-4）：页面只做接线，一行导出逻辑都不许下沉到页面里。
// 3. **落盘只经能力层**（`getPlatform().album.save`）：面板不知道具体落点，也不自己拼第二份命名
//    逻辑（名字走 `exportFilename`，页身份走 `boardPageTile`）。
//    浏览器端「一键保存会连发 N 次下载」是**明确推翻** B4 那条「不做连续多下载」纪律的结果
//    （人类伙伴裁定 A，交付面是 Android 壳：壳里是 N 次相册写入，不是 N 次下载）。
// 4. **只有当前页渲染成位图**：116×116 + 29 板是 16 页，全量驻留会把十几张全分辨率位图钉在内存里。
//    预览条是一格一页的占位，当前格才放 `<img>`。
//
// 分页数学**只此一份**：页数取 `printBoardCount`、页身份（`boardRow` / `boardCol`）取
// `boardPageTile`（内部走 `planBoardPage`）、本页用量取 `usagesInRange`——面板自己**不写除法**。
// 导出**不乘 DPR**、**不经过 `renderPatternThumbnail`**（R-6）。
import { computed, onUnmounted, ref, watch } from "vue";
import { useOverlayBack } from "@/composables/useOverlayBack";
import type { Palette } from "@/core/palette/types";
import type { ColorUsage } from "@/core/pattern/stats";
import type { Pattern } from "@/core/pattern/types";
import { planBoardPage, printBoardCount } from "@/core/render/layout";
import { exportFilename } from "@/services/exporter";
import { getPlatform } from "@/services/platform/capabilities";
import {
  boardPageTile,
  renderBoardPageBlob,
  usagesInRange,
  type BoardPageRenderInput,
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

/**
 * 接进**覆盖层返回栈**（C8 规格 §3.6.2：Android 返回键「一层一层关」）。
 *
 * 查看层自己也注册了一项，而打印页是它上面的第二层 ⇒ 返回键**先关打印页**、再关查看层。
 * **必须在 setup 的同步执行期调用**（`useOverlayBack` 内部用 `watch` 与 `onUnmounted`）。
 * `emit("close")` 由宿主（`SheetViewer` 的 `@close="printing = false"`）收掉，两者共存。
 */
useOverlayBack(() => emit("close"));

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

/* ------------------------------------------------------------ 面板自持状态 */

/**
 * **一键保存的账本**（声明在预览那一段之前：下面的重建侦听器要清它——`let` / `ref` 的 TDZ
 * 是**运行期**的，而侦听器回调虽然是异步的，把它写成「依赖后面才声明的 ref」仍是给后人埋坑）。
 */
/** 保存状态：`saved` 是**已经成功落盘**的页索引集合，失败后重试只补没成功的。 */
const saved = ref<ReadonlySet<number>>(new Set());
/** 一键保存进行中（模板据此禁用保存按钮与四个选项）。 */
const savingAll = ref(false);
/** 一键保存的**阶段**：`idle`（没存过）/ `saving` / `error` / `done`。见 `saveStateText` 的分支。 */
const savePhase = ref<"idle" | "saving" | "error" | "done">("idle");
/** 最近一次失败的中文原因（原样进状态文案）。 */
const saveError = ref("");
/** 失败发生在**第几张**（1 起）。显式记下来，不从 `saved.size` 反推（见 `saveStateText`）。 */
const failedCount = ref(0);
/** 本轮进度：已经发到第几张（1 起）与本轮总张数（重试时总张数是剩余页数）。 */
const savingDone = ref(0);
const savingTotal = ref(0);

/* -------------------------------------------------------- 预览（只有当前页） */

/** 当前预览到第几页（0 起）。预览条左右滑动与 ◀/▶ 都写它。 */
const currentPage = ref(0);
/** 当前页的预览 URL。**只有当前页**——16 页全量驻留会把十几张位图钉在内存里。 */
const previewUrl = ref("");
/** 预览渲染失败的**中文原因**（如「画布尺寸被浏览器钳制」）；空串表示没有失败。 */
const previewError = ref("");

/** 预览条元素（滑动求当前页要用它的 `scrollLeft` / `clientWidth`）。 */
const strip = ref<HTMLElement | null>(null);

/**
 * 释放当前预览 URL（换页与卸载都走它，销号语义只有一份）。
 *
 * 只清 `previewUrl` 而不销号会把每一张全分辨率 PNG 的 object URL 一直钉在内存里
 * （该 URL 在页面生命周期内永不释放，blob 也无法被回收）——这是一个**真实的泄漏**。
 */
function revokePreview(): void {
  if (previewUrl.value === "") return;
  URL.revokeObjectURL(previewUrl.value);
  previewUrl.value = "";
}

/* ------------------------------------------------------------- 落盘快照 */

/**
 * 落盘路径的一份**快照**（B6 任务 10 第 1 轮审查的关键修复，C8 逐字沿用）。
 *
 * **为什么必须整体快照、而不是逐个「记得早点取」**：名字与字节必须出自**同一次取用**。这份路径上有
 * 两个 `await`（渲染通道里的 `canvasToBlob`、以及能力层的 `album.save`），而期间用户可以改板大小 /
 * 纸张（那正是预览与账本重建的入口）。任何一处「`await` 之后再读 `props` / `ref`」都会产出
 * **名与字节不同源**的静默错产物：29 板的第 3 页渲染完，名字却按 58 板写成 `r2c1`；页索引在新选项下
 * 不存在时更会直接抛「页索引越界」，用户无过错却保存失败。
 *
 * **一键保存是长流程（16 次 `await`）**：每一次拿到的入参可以是不同的快照，也正因为如此，
 * `generation` 那一条判据每页都要在 `await` 之后查一次（见 `saveAll`）。
 */
interface SaveSnapshot {
  readonly pattern: Pattern;
  readonly palette: Palette;
  readonly usages: readonly ColorUsage[];
  readonly projectName: string;
  readonly boardSize: 29 | 58;
  readonly paper: "a4" | "a3";
}

/** 取一份快照：**只此一处**，预览与落盘共用（两者必须读同一批入参）。 */
function takeSnapshot(): SaveSnapshot {
  return {
    pattern: props.pattern,
    palette: props.palette,
    usages: props.usages,
    projectName: props.projectName,
    boardSize: boardSize.value,
    paper: paper.value,
  };
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
 * 某页的落盘身份：**文件名在第一个 `await` 之前算好**（它不依赖 blob）。
 *
 * 页身份只经 `boardPageTile`（→ `planBoardPage`）取用，所以「名字里是哪一页」与「画布上是哪一页」
 * 同源；同时它也用掉**同一份快照**（飞行中改选项既不会写错页身份、也不会用越界的页索引去算名字）。
 */
function pageFilename(snapshot: SaveSnapshot, index: number): string {
  return exportFilename(
    snapshot.projectName,
    "打印",
    boardPageTile(
      snapshot.pattern,
      snapshot.palette,
      snapshot.usages,
      snapshot.projectName,
      snapshot.boardSize,
      snapshot.paper,
      index,
    ),
  );
}

/** 渲染通道的入参（与 `pageUsages` / `pageFilename` 同源的快照拼出来）。 */
function boardRenderInput(snapshot: SaveSnapshot, index: number): BoardPageRenderInput {
  const sheetInput: SheetRenderInput = {
    pattern: snapshot.pattern,
    palette: snapshot.palette,
    usages: snapshot.usages,
    projectName: snapshot.projectName,
  };
  return {
    ...sheetInput,
    boardSize: snapshot.boardSize,
    paper: snapshot.paper,
    pageIndex: index,
  };
}

/* ------------------------------------------------------------- 预览代数 */

/**
 * **面板代数**：落盘路径的每一项入参（图纸 / 板大小 / 纸张）变化、以及 `onUnmounted` 各 +1。
 *
 * 为什么需要它而不只是 `unmounted`（修复波 B-3）：渲染路径上有一个 `await`（`canvasToBlob`）、
 * 落盘路径上还有第二个（`album.save`），而 `await` 期间 `props` / `ref` 可能整体变化
 * （撤销 / 切换工程 / 换纸张），**面板却没有卸载**——此时手里那份快照已经被丢弃，
 * 把新诞生的 object URL 写上去等于**永远没人回收**；更糟的是状态若在 `await` **之后**
 * 读 `props`，就会产出「状态说 16 张、实际按新图纸存了 4 张」这种静默错产物。
 *
 * **声明必须在任何读取它的函数之前**（`let` 的 TDZ）。
 */
let generation = 0;

/**
 * **已经卸载**（修复轮 F6）。它必须早于 `onUnmounted` 注册、且用 `let` 而不是 `ref`：
 * `onUnmounted` 只扫**当时**的 `previewUrl`，而一次渲染可能在异步之间被关掉（返回箭头没有
 * `disabled`）——那个 object URL 是在面板被丢弃**之后**才可能诞生的，`onUnmounted` 永远扫不到。
 * 用一个普通布尔量当下「是否已卸载」的判据，`showPreview` 在**创建 URL 之前**立刻查它。
 *
 * **如实记录它与代数判据的关系**：`onUnmounted` 同时把 `generation` +1，所以严格说
 * `token !== generation` 已经覆盖了「面板已卸载」这一支；保留显式的 `unmounted` 是因为
 * 「面板已经卸载」在判据处读起来比「代数变了」直白，而这条语义正是一次真实泄漏的名字
 * （B4 的既有防线，逐字保留）。**别把它的存在当成一条独立覆盖**。
 */
let unmounted = false;

/** 代数 / 卸载判据：**排在 `createObjectURL` 之前** ⇒ URL 根本不诞生，就没有「诞生在被丢弃之后」这一形态。 */
function stale(token: number): boolean {
  return unmounted || token !== generation;
}

/**
 * 渲染并显示第 `index` 页的预览：先取快照（与落盘同一份），渲染，再把 `<img>` 指到新 URL。
 *
 * **代数 / 卸载判据排在 `createObjectURL` 之前**——URL 根本不诞生，就没有「诞生在面板被丢弃之后」
 * 这一形态（比「诞生了再销号」更强）。
 *
 * **`revokePreview` 与「换上新的 URL」在同一个同步块里**（判据之后）：中间没有 `await`，
 * 于是不会出现「旧图已销号、新图还没到」的空窗，也不会把**正在显示**的那张误销号
 * （销号排在判据之前时，一次被丢弃的渲染会顺手把当前页的图撤掉）。
 *
 * 渲染失败只写中文原因：预览失败是一件事，**落盘失败是另一件事**——两者不共用一个状态，
 * 预览失败也不许把面板卡住（「一键保存」自己渲染、自己报错）。
 */
async function showPreview(index: number): Promise<void> {
  const token = generation;
  const snapshot = takeSnapshot();
  previewError.value = "";
  let blob: Blob;
  try {
    blob = await renderBoardPageBlob(boardRenderInput(snapshot, index), pageUsages(snapshot, index));
  } catch (error) {
    if (stale(token)) return;
    previewError.value = `预览生成失败：${error instanceof Error ? error.message : String(error)}`;
    return;
  }
  if (stale(token) || index !== currentPage.value) return;
  revokePreview();
  previewUrl.value = URL.createObjectURL(blob);
}

/** 换到第 `index` 页（越界夹取；`showPreview` 里还有一道代数判据兜住飞行中的换页）。 */
function goToPage(index: number): void {
  const clamped = Math.min(Math.max(index, 0), Math.max(pageCount.value - 1, 0));
  if (clamped === currentPage.value) return;
  currentPage.value = clamped;
}

/**
 * 预览条横向滑动 ⇒ 当前页。`scroll-snap-type: x mandatory` 保证它总是整页对齐，
 * 所以「第几页」就是 `Math.round(scrollLeft / clientWidth)`（不写第二份翻页数学）。
 */
function onStripScroll(): void {
  const element = strip.value;
  if (element === null || element.clientWidth === 0) return;
  goToPage(Math.round(element.scrollLeft / element.clientWidth));
}

// 换页（含滑动）就重渲染那一页的预览。
watch(currentPage, (index) => {
  void showPreview(index);
});

/**
 * 重建（**四个源**，缺一不可）：
 * - `revision`：编辑页的 `cells` 原地写，只有它能让 `markRaw` 的图纸失效；
 * - `pattern` 的**对象身份**：`beginSession` 会把 `revision` 归零——从一张 `revision = 0` 的图纸
 *   换到另一张时（`/edit/a → /edit/b` 而面板恰好开着），0 → 0 那一跳**不触发**，预览会停在
 *   上一张图纸上；结果页更是**只有**这一条失效通道（它没有 `revision`）；
 * - `boardSize` / `paper`：页身份与页数由它们决定（29 板 16 页 ↔ 58 板 4 页）——换选项而不重建时，
 *   摘要会说 4 页、预览条却仍是 16 格，且第 5 格之后会拿越界的页索引去算名字抛错。
 * - `pageCount`：上面四源的**导出量**，单独听它才让「页数真的变了」这件事成为判据
 *   （同时也让本侦听器顺带读到 `pattern` / 板大小，语义上不至于只看一个数）。
 *
 * **重建即丢掉旧账本**：`saved` 记的是「在**旧**选项下第几页已经落盘」，换选项后那些下标指向
 * 另一页 ⇒ 必须清空（否则「已生成 16 张」会变成幻觉）。用户改完选项再点一次即可。
 *
 * **`currentPage` 越界要夹回 0 并重渲染**：58 板下停在第 16 页、切回 29 板（或图纸变小）会让
 * 当前页超出新页数，那一页的渲染会以「页索引越界」响亮失败——它不是用户的错。
 */
watch(
  [() => props.revision, () => props.pattern, boardSize, paper, pageCount],
  () => {
    generation += 1;
    revokePreview();
    previewError.value = "";
    saved.value = new Set();
    savePhase.value = "idle";
    saveError.value = "";
    failedCount.value = 0;
    if (currentPage.value > pageCount.value - 1) {
      // 越界：夹回第 1 页。改 `currentPage` 会触发上面那个侦听器去渲染，所以这里不重复请求
      // （两处都发请求的话，被丢弃的那一次会白渲染一整页）。
      currentPage.value = 0;
      return;
    }
    void showPreview(currentPage.value);
  },
);

// 首帧就渲染第 1 页（挂载期的 `showPreview`；它自己带代数 / 卸载判据）。
void showPreview(0);

/* ---------------------------------------------------------- 一键顺序保存 */

/**
 * 还有几页没落盘。
 * 顺序**升序**，因为一键保存必须按 `r1c1`、`r1c2`… 的顺序存（用户按页码核对相册里的图）。
 */
const pendingPages = computed(() =>
  Array.from({ length: pageCount.value }, (_, index) => index).filter(
    (index) => !saved.value.has(index),
  ),
);

/**
 * 保存按钮文案：**出过失败**时是「继续保存剩余 N 张」（N = 还没成功的那几页），
 * 其余时候是「保存全部（M 张）」（M = 本次会存几张；一张都没成功时就是全部页数）。
 *
 * 判据是 `savePhase === "error"` 而**不是** `saved.size > 0`：第 1 张就失败时一张都没存下，
 * 而那时按钮必须是「继续保存剩余 16 张」——按 `saved.size` 判会让它退回「保存全部（16 张）」，
 * 把「重试」说成「从头来」。反过来，全存完之后 `remaining` 是 0，按钮要回到
 * 「保存全部（16 张）」而不是「保存全部（0 张）」（后者是一句错的文案）。
 */
const saveLabel = computed(() => {
  const remaining = pendingPages.value.length;
  if (savePhase.value === "error" && remaining > 0) return `继续保存剩余 ${remaining} 张`;
  return `保存全部（${remaining > 0 ? remaining : pageCount.value} 张）`;
});

/** 成功文案（按**落点**分叉，规格 §5.4.3 / §7.3）：壳里进系统相册、浏览器里是下载。 */
function successText(): string {
  const count = pageCount.value;
  return getPlatform().album.kind === "album" ? `已保存到相册 ${count} 张` : `已生成 ${count} 张`;
}

/**
 * 进度 / 结果文案（模板里 `print-save-state`）。
 *
 * 四支状态各有各的话，**不共用一个「存过几张」的数字**：
 * - `saving` ⇒「正在保存 第 i/N 页」（N = **本轮**剩余页数，重试时是 14 而不是 16）；
 * - `error`  ⇒「已存 N 张 · 第 M 张失败：<原样原因>」（M 取 `failedCount`，不从 `saved.size` 反推）；
 * - `done`   ⇒ 按落点分叉的成功文案（`已生成 16 张` / `已保存到相册 16 张`）；
 * - `idle`   ⇒ 什么都不说（`print-save-state` 整块不存在）。
 */
const saveStateText = computed(() => {
  if (savePhase.value === "saving") {
    return `正在保存 第 ${savingDone.value}/${savingTotal.value} 页`;
  }
  if (savePhase.value === "error") {
    return `已存 ${saved.value.size} 张 · 第 ${failedCount.value} 张失败：${saveError.value}`;
  }
  if (savePhase.value === "done") return successText();
  return "";
});

/**
 * 一键保存：**顺序**逐页渲染 + 落盘，逐页更新进度；失败即停并如实报数。
 *
 * 三件逐字沿用 B6 的事：
 * 1. **入口早退**（手势可能比下一帧更快）：`savingAll` 挡住连点；
 * 2. **逐页快照 + 代数判据**：每一页在**自己的第一个 `await` 之前**取快照（名字与字节同源），
 *    落盘之后查一次代数 / 卸载——被丢弃的那一轮**立刻停下**，也不把状态写回新清单；
 * 3. **失败即停、如实报数**：`已存 N 张`、`第 M 张失败：<原因>`，**不接着往下存**，
 *    按钮变成「继续保存剩余 K 张」，重试只补没成功的那几页（已经进相册的绝不重存）。
 *
 * 进度里的「第 i/N 页」数的是**本轮**（重试时 N 是 14）：用户看到的是「这一轮还剩几页」。
 */
async function saveAll(): Promise<void> {
  if (savingAll.value) return;
  const batch = pendingPages.value;
  if (batch.length === 0) return;
  savingAll.value = true;
  saveError.value = "";
  savePhase.value = "saving";
  savingDone.value = 0;
  savingTotal.value = batch.length;
  try {
    for (const index of batch) {
      const token = generation;
      const snapshot = takeSnapshot();
      const filename = pageFilename(snapshot, index);
      savingDone.value += 1;
      try {
        const blob = await renderBoardPageBlob(
          boardRenderInput(snapshot, index),
          pageUsages(snapshot, index),
        );
        await getPlatform().album.save(blob, filename);
      } catch (error) {
        // 代数判据：这一轮（以及它用的选项 / 页索引）已经被丢弃 ⇒ 不写状态、也不再往下存。
        if (stale(token)) return;
        saveError.value = error instanceof Error ? error.message : String(error);
        failedCount.value = index + 1;
        savePhase.value = "error";
        // 落盘本身**照常发生 / 照常失败**——用户那一次手势不该因为面板被关掉而白点。
        return;
      }
      if (stale(token)) return;
      const next = new Set(saved.value);
      next.add(index);
      saved.value = next;
    }
    savePhase.value = "done";
  } finally {
    savingAll.value = false;
  }
}

/**
 * 那句「手机上也可以长按下面的预览图存进相册」**只对浏览器成立**：壳里点「保存」就直接进系统相册 ✓，
 * 长按是多余提示（`B5-25`）。判据用渲染期读到的落点。
 * **消费者 = 模板里那句话的 `v-if`**；判别力在 `ExportPanel.test.ts`（浏览器默认落点 ⇒ 在；壳假平台 ⇒ 不在）。
 */
const showsLongPressHint = computed(() => getPlatform().album.kind === "download");

/**
 * 关闭面板 = **卸载**，所以重建那一条销号路径**不会**在关闭时跑到：不在这里回收的话，
 * 用户反复「预览 → 返回」会把每一张全分辨率 PNG 的 object URL 一直钉在内存里。
 *
 * **复用 `revokePreview`、不新增实现**：销号的语义只有一份。它与 `showPreview` 里那一条是
 * **两条互补的路径**：这一条挡「卸载发生在 URL 已经存在之后」，那一条挡「卸载发生在 URL 诞生之前」。
 */
onUnmounted(() => {
  unmounted = true;
  // 卸载也算一次代数变化：`saveAll` 因此不必在两条判据里挑一条。
  generation += 1;
  revokePreview();
});
</script>

<template>
  <!--
    面板是一个**覆盖层**。`data-testid` 全部照契约的清单，**不许另造名字**：
    根 `export-panel`、摘要 `export-summary-print`、空图纸说明 `export-empty-note`、返回 `export-close`、
    打印选项 `print-board-29` / `print-board-58` / `print-paper-a4` / `print-paper-a3`、
    预览 `print-preview-strip` / `print-preview-page-<i>` / `print-preview-img-<i>`、
    页码 `print-page-indicator` / `print-page-prev` / `print-page-next`、
    保存 `print-save-all` / `print-save-state`。

    **C8 起删掉了 `export-item-*` / `export-save-*` / `export-preview-*`**：被测对象（逐项保存）
    按规格删除，那几十条逐项用例随之删除。
    **C7 起只剩打印这一种形态**：单张施工图走「查看施工图」（`SheetViewer`），不再有
    `export-summary-sheet` 与 sheet 模式的清单。
  -->
  <section data-testid="export-panel" class="fixed inset-0 z-30 flex flex-col overflow-y-auto bg-white p-4">
    <!-- 标题行 = 返回箭头 + 标题。**`export-close` 这个 id 沿用**：按钮的形态从「关闭」变成返回箭头。 -->
    <header class="mx-auto flex w-full max-w-3xl items-center gap-3">
      <button
        data-testid="export-close"
        aria-label="返回"
        class="min-h-11 min-w-11 shrink-0 rounded border border-slate-300 text-xl leading-none"
        @click="emit('close')"
      >
        ←
      </button>
      <h2 class="text-2xl font-bold text-slate-900">打印</h2>
    </header>

    <!-- 摘要与选项：纯计算，不建画布（规格 §10.2） -->
    <div class="mx-auto mt-3 w-full max-w-3xl space-y-1">
      <p data-testid="export-summary-print" class="text-base text-slate-700">
        共 {{ pageCount }} 页（每页一块 {{ boardSize }}×{{ boardSize }} 板 · {{ paper.toUpperCase() }}）· 打印时选「适合页面」，标题行写明了每格实际毫米。
      </p>
      <!-- 选项按钮在**保存中**禁用：改选项会重建预览与账本（时序与可达性是一对）。 -->
      <div class="flex flex-wrap gap-2 pt-2">
        <button data-testid="print-board-29" :aria-pressed="boardSize === 29" :disabled="savingAll" class="min-h-11 rounded border border-slate-300 px-4 text-base disabled:opacity-50" @click="boardSize = 29">29 标准板</button>
        <button data-testid="print-board-58" :aria-pressed="boardSize === 58" :disabled="savingAll" class="min-h-11 rounded border border-slate-300 px-4 text-base disabled:opacity-50" @click="boardSize = 58">58 大板</button>
        <button data-testid="print-paper-a4" :aria-pressed="paper === 'a4'" :disabled="savingAll" class="min-h-11 rounded border border-slate-300 px-4 text-base disabled:opacity-50" @click="paper = 'a4'">A4</button>
        <button data-testid="print-paper-a3" :aria-pressed="paper === 'a3'" :disabled="savingAll" class="min-h-11 rounded border border-slate-300 px-4 text-base disabled:opacity-50" @click="paper = 'a3'">A3</button>
      </div>
      <p v-if="usages.length === 0" data-testid="export-empty-note" class="text-base text-amber-700">这张图纸没有可拼的像素</p>
      <p v-if="showsLongPressHint" class="text-base text-slate-500">手机上也可以长按下面的预览图存进相册。</p>
    </div>

    <!-- 页码指示：◀ 第 N / M 页 ▶（滑动与这两颗按钮写的是同一个 `currentPage`） -->
    <div class="mx-auto mt-4 flex w-full max-w-3xl items-center gap-3">
      <button data-testid="print-page-prev" :disabled="currentPage <= 0" class="min-h-11 min-w-11 rounded border border-slate-300 text-base disabled:opacity-50" @click="goToPage(currentPage - 1)">◀</button>
      <span data-testid="print-page-indicator" class="text-base text-slate-700">第 {{ currentPage + 1 }} / {{ pageCount }} 页</span>
      <button data-testid="print-page-next" :disabled="currentPage >= pageCount - 1" class="min-h-11 min-w-11 rounded border border-slate-300 text-base disabled:opacity-50" @click="goToPage(currentPage + 1)">▶</button>
    </div>

    <!--
      横向预览条：`overflow-x-auto snap-x snap-mandatory` ⇒ 总是整页对齐。
      一页一格，**只有当前页真的渲染出图**（16 页全量驻留会把十几张全分辨率位图钉在内存里）：
      其余格只是一句「第 N 页」的占位。
    -->
    <div
      ref="strip"
      data-testid="print-preview-strip"
      class="mx-auto mt-3 flex w-full max-w-3xl snap-x snap-mandatory overflow-x-auto"
      @scroll="onStripScroll"
    >
      <div
        v-for="index in pageCount"
        :key="index - 1"
        :data-testid="`print-preview-page-${index - 1}`"
        class="w-full shrink-0 snap-center p-1"
      >
        <img
          v-if="index - 1 === currentPage && previewUrl !== ''"
          :data-testid="`print-preview-img-${index - 1}`"
          :src="previewUrl"
          alt="打印页预览"
          class="mx-auto max-h-72 rounded border border-slate-200"
        />
        <p v-else class="py-8 text-center text-base text-slate-400">第 {{ index }} 页</p>
      </div>
    </div>

    <p v-if="previewError !== ''" data-testid="print-preview-error" class="mx-auto mt-2 w-full max-w-3xl rounded bg-amber-50 p-3 text-base text-amber-800">{{ previewError }}</p>

    <!-- 一键顺序保存：一颗按钮存满全部页（失败后变成「继续保存剩余 N 张」）。 -->
    <div class="mx-auto mt-3 flex w-full max-w-3xl flex-wrap items-center gap-3">
      <button
        data-testid="print-save-all"
        :disabled="savingAll || pageCount === 0"
        class="min-h-11 rounded bg-slate-900 px-6 text-base text-white disabled:opacity-50"
        @click="saveAll"
      >
        {{ saveLabel }}
      </button>
      <span v-if="saveStateText !== ''" data-testid="print-save-state" class="text-base text-slate-600">{{ saveStateText }}</span>
    </div>
  </section>
</template>
