<script setup lang="ts">
// 查看施工图的全屏层：**现算**，不落盘（blob 只留在内存里，用户点「保存」才写）。
//
// **2026-10-09（C7）改了两件事**（人类伙伴裁定）：
// 1. **吃 `pattern` 入参，不再读工程存储**：原先它按 `projectId` 自己去 `getProjectStore().get()`，
//    于是只有「库里存过的工程」能看施工图——编辑器里那份**内存态**图纸（含未保存改动）与首页结果页
//    刚生成的图纸都进不来。改为入参之后，三个入口（库 / 编辑器 / 结果页）共用它。
// 2. **可放大**：原先 `<img class="w-full max-w-4xl">` 是只读缩放，29 格图纸在手机上 1 CSS px ≈ 0.19 格、
//    15px 的格内色号落到约 3 CSS px，**不可能读出**。现在接 `core/pattern/view.ts` 的既有缩放数学
//    （`defaultCellView` / `zoomCellView` / `panCellView`），与编辑器共用同一套上下界，
//    **不在组件里写第二份坐标数学**。
//
// **2026-10-10（C8 §4）把它做成一台看图 app**：默认整图适配（双击在适配与放大上限之间切换）、
// 双指捏合、放大后单指平移；底部**固定操作条**（放大 / 缩小 / 打印 / 保存）；标题行前加返回箭头
// （`sheet-close` 这个 id **不变**——四个测试文件在读它），并接进覆盖层返回栈。
// 三颗旧按钮里的「适配」与那行色卡精度声明按规格删掉；手势改用 `pointers` Map + 增量捏合
// （**结构照搬 `PatternCanvas.vue`**，但不合并抽象——那个组件要区分工具手势与视图手势，这里只有
// 视图手势，硬合并会造出一个谁都不像的中间层）。
//
// **2026-10-10（C8 修复 ②，承重）三处坐标系修正**（真机症状：只显示左上角一条刻度带、且缩不回整图）：
// 原先把 `view.scale`（语义是**每格多少 CSS px**）直接当 `scale()` 乘在 `<img>` 上，而 `<img>` 的
// **固有尺寸是整张施工图的画布像素**——29×25 那条图是 2888×2736 画布像素（每格 96），而视图数学
// 又按 `pattern.width/height`（29×25 格）算，于是默认比例是 24「px/格」却被当成 24「px/画布像素」用：
// 渲染出来是 2888 × 24 ≈ **69,000 CSS px**（视口只有 800），屏幕上只剩左上角；`minCellScale` 用的
// 又是同一把错比例尺，所以缩不回去。现在：
// ① 渲染通道把计划一起交出来（`renderSheetBlob` → `{ blob, plan }`）——「画布像素 ↔ 格」的换算
//    只算一次，查看层不重算第二遍 `planSheet`；
// ② 视图数学的坐标系 = **整张图的格尺寸**（`sheetGrid`，含标题行 / 上下刻度带 / 用料条）；
// ③ `<img>` 的变换除以 `plan.cellPx`（画布像素 → 格）。`origin-top-left` 已经让 img 原点落在
//    画布原点，所以**不需要**额外 `translate`。
//
// 三条纪律：
// 1. 打开瞬间用调用方给的缩略图垫场（可能没有），现算完成后换成真正的施工图；
// 2. 渲染只经 `renderSheetBlob`（与打印面板同一条通道），本组件不建画布、不调 core 渲染器；
// 3. 落盘经能力层（`getPlatform().album.save`），文件名走 `exportFilename`——不在这里拼第二份命名。
import { computed, onMounted, onUnmounted, ref, shallowRef } from "vue";
import type { Palette } from "@/core/palette/types";
import { patternStats, type ColorUsage } from "@/core/pattern/stats";
import type { Pattern } from "@/core/pattern/types";
import {
  clampView,
  type Size,
  type ViewTransform,
} from "@/core/crop/view";
import {
  defaultCellView,
  maxCellScale,
  panCellView,
  zoomCellView,
} from "@/core/pattern/view";
import type { SheetPlan } from "@/core/render/layout";
import ExportPanel from "@/components/editor/ExportPanel.vue";
import { useOverlayBack } from "@/composables/useOverlayBack";
import { getPlatform } from "@/services/platform/capabilities";
import { exportFilename } from "@/services/exporter";
import { renderSheetBlob } from "@/services/sheetExport";

const props = defineProps<{
  pattern: Pattern;
  palette: Palette;
  name: string;
  /** 现算完成前垫场用的缩略图（首页列表里有；编辑器与结果页没有，就不垫）。 */
  thumbnail?: string;
}>();
const emit = defineEmits<{ close: [] }>();

/** 覆盖层返回栈（C8 规格 §3.6.2）：Android 返回键先关查看层，而不是离开页面。 */
useOverlayBack(() => emit("close"));

/** 打印面板是否打开。**在查看层内部打开**（它是根 `section` 的最后一个子元素，且自身 `z-40` 在
 *  同一层叠上下文里高于查看层其余各块），于是宿主页面都不必知道打印页存在（C8 规格 §4.3）。 */
const printing = ref(false);
/** 喂给打印页的用量与喂给渲染通道的是**同一份**（不重算第二遍 O(格数) 的统计）。 */
const usages = ref<readonly ColorUsage[]>([]);

/**
 * 现算出来的 blob **本体**留着（`shallowRef`：它是大对象，不需要也不该被深代理），
 * `<img>` 用它的 object URL。保存时直接落盘这颗 blob——**不要**用 `fetch(objectUrl)` 再取一遍，
 * 那会在内存里多复制一份全分辨率位图（29 格的单张施工图约 30MB）。
 */
const sheetBlob = shallowRef<Blob | null>(null);
/**
 * 现算返回的**施工图计划**（C8 修复 ②）。它是「画布像素 ↔ 格」的**唯一**换算来源
 * （`plan.cellPx` / `plan.canvasWidth` / `plan.canvasHeight`），也是「视图数学的坐标系是格」这件事
 * 与「被变换的 `<img>` 是画布像素」这件事之间的那座桥。
 *
 * `shallowRef`：它是个大对象（刻度带 / 用料条计划都在里面），不需要也不该被深代理。
 */
const sheetPlan = shallowRef<SheetPlan | null>(null);
const blobUrl = ref("");
const error = ref("");
const busy = ref(true);
const saveState = ref("");
/**
 * 有保存挂在飞行中。判据写在 `save()` 的**入口**（而不是只靠按钮的 `:disabled`）：同一 tick 里的两次
 * `click`（真机双击、或测试里连着两次派发）都会进 handler——那一刻 `:disabled` 还没被渲染刷新，
 * 于是往相册写两份 / 浏览器触发两次下载。
 */
const saving = ref(false);
/**
 * 实例已卸载。「关闭」按钮没有 `disabled`：用户完全可以在现算结算**之前**就关掉（换工程重挂时，
 * 旧实例同理）。那种情况下 `onUnmounted` 已经跑过（当时 `blobUrl` 还是 `""`，没有东西可 revoke），
 * 之后那颗 blob 才 resolve——若不拦，`URL.createObjectURL` 会在**已死实例**上诞生一个
 * **永远不会被回收**的 object URL，把整颗全分辨率位图钉到页面生命周期结束。
 * 判据必须排在 `createObjectURL` **之前**。
 */
let disposed = false;

/* ---------------------------------------------------------------- 缩放平移 */

/**
 * 视图数学的坐标系 = **整张施工图的格尺寸**（含标题行、上下刻度带与用料条），单位是**格**。
 *
 * **为什么不是 `pattern.width/height`（C8 修复 ② 的承重点）**：被变换的 `<img>` 的固有尺寸是
 * **画布像素**（`plan.canvasWidth × plan.canvasHeight`），它比网格本身大一圈（刻度带 / 标题 / 用料条），
 * 且与「格数」根本不是同一个量。把 `pattern.width/height` 喂给 `defaultCellView` / `minCellScale` /
 * `clampView`，夹的就是 29×29 格（≈2800 CSS px），而屏幕上被撑开的是 2888×2736 画布像素——
 * 真机症状正是「只剩左上角、且怎么缩都回不到整图」。视图数学与 `<img>` 必须对着**同一张图**算。
 *
 * **`Math.ceil` 是必须的、且方向是安全的**：`core/crop/view.ts` 的 `requireImageSize`（经
 * `fitTransform` / `clampView` 进来）只收**整数**尺寸，而画布像素除以格像素一般带小数
 * （2888 / 96 = 30.08）——那条守卫是 B2 的既有口径，**不放宽**。上取整让夹取盒子 ≥ 真实画布，
 * 于是 `scale × 真实画布 ≤ 视口`：默认视图与缩放下限都**保证整图可见**（代价是全图最多空出半格，
 * 如实记录）。
 *
 * `pattern.width/height` 的「格」语义**不变**，它继续用于统计与渲染入参；换掉的只有视图数学的
 * 这个 `oriented` 参数。计划到手之前它是 `null`（视图保持 `null`，渲染走 `maxWidth: 100%` 兜底）。
 */
const sheetGrid = computed<Size | null>(() => {
  const plan = sheetPlan.value;
  if (plan === null) return null;
  return {
    width: Math.ceil(plan.canvasWidth / plan.cellPx),
    height: Math.ceil(plan.canvasHeight / plan.cellPx),
  };
});
/** 视口尺寸（CSS px）。happy-dom 下 `getBoundingClientRect()` 返回全 0 ⇒ 用例用 `withViewport()` 覆写。 */
const viewport = ref<Size>({ width: 0, height: 0 });
const view = ref<ViewTransform | null>(null);
/** 已量到过视口尺寸：**只有第一次**调 `defaultCellView`，之后只 `clampView`（否则横竖屏切换会重置）。 */
let sized = false;
const stage = ref<HTMLElement | null>(null);

/**
 * 看图手势（C8 规格 §4.2）。**结构照搬 `PatternCanvas` 的 `pointerdown/move/up`**（同一套
 * `pointers` Map + 两指手势），但**不合并成一个抽象**：那个组件要区分「工具手势」与「视图手势」，
 * 这里只有视图手势，硬合并会造出一个谁都不像的中间层。
 */
const pointers = new Map<number, { readonly x: number; readonly y: number }>();
interface PinchState {
  readonly ids: readonly [number, number];
  lastDistance: number;
  lastCentre: { x: number; y: number };
}
let pinch: PinchState | null = null;
/** 单指按下时的落点：抬手时用它判「这是一次轻点还是一次拖动」。 */
let pressOrigin: { readonly x: number; readonly y: number } | null = null;
/**
 * 上一次轻点（双击判定用）。
 *
 * **双击只由指针序列判定，舞台不绑 `dblclick`**（2026-10-10 人类伙伴裁定）：指针事件是统一模型，
 * 鼠标点击同样会派发 `pointerdown` / `pointerup`，所以下面这套「两次轻点 + 位移容差 + 300ms」
 * 在鼠标与触摸两种输入上都成立；而两条入口绑同一个处理器时，一次**鼠标**双击会跑两遍
 * （先放大到上限、紧接着 `dblclick` 又弹回适配），净效果是双击没反应。
 * `dblclick` 没有任何一种输入形态是它独有的（Android WebView 反而不保证派发它）。
 */
let lastTap: { readonly at: number; readonly x: number; readonly y: number } | null = null;
const DOUBLE_TAP_MS = 300;
const TAP_SLOP_PX = 12;

/** 单指拖动时的上一次屏幕坐标（本地坐标）；双指进来时置空（捏合期间不平移单指）。 */
let dragging: { x: number; y: number } | null = null;

function measure(): void {
  const element = stage.value;
  if (element === null) return;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  viewport.value = { width: rect.width, height: rect.height };
  const grid = sheetGrid.value;
  /**
   * 计划还没到手 ⇒ 视图保持 `null`（渲染走 `maxWidth: 100%` 兜底那一支）。
   *
   * **为什么不能拿 `pattern` 先顶一会儿**（C8 修复 ②）：视图数学的坐标系必须是**整张图**；用格数
   * 先算一次、等计划到手再换，等于让用户在「只剩左上角」的视图上停留一瞬，而且 `sized` 已经被置位，
   * 第二次不会再算默认视图。计划到手后 `onMounted` 会再量一次（那时 `sized` 仍是 false）。
   */
  if (grid === null) return;
  if (!sized) {
    view.value = defaultCellView(viewport.value, grid);
    sized = true;
    return;
  }
  if (view.value !== null) view.value = clampView(view.value, viewport.value, grid);
}

/**
 * 视口是否已量到**可用尺寸**。
 *
 * **为什么必须有这道门**：core 的 `defaultCellView` / `zoomCellView` 对 `viewport ≤ 0` 是**响亮失败**
 * （`requireViewport`）——那是它们该有的防线。而组件这一侧，`getBoundingClientRect()` 在
 * （a）DOM 还没布局、（b）元素 `display:none`、（c）happy-dom 测试环境下都会返回 0。
 * 少了这道门，「放大 / 缩小」按钮与双击会把一条内部守卫错误暴露给用户（实测：`视口宽度必须大于 0（当前 0）`）。
 */
const canTransform = computed(
  () => viewport.value.width > 0 && viewport.value.height > 0,
);

function localPoint(event: PointerEvent, element: HTMLElement): { x: number; y: number } {
  const rect = element.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function onPointerDown(event: PointerEvent): void {
  const element = stage.value;
  if (element === null) return;
  // 只认主键（与 `PatternCanvas.vue` 同一条守卫）：右键 / 中键不该平移。
  if (event.button !== 0) return;
  const point = localPoint(event, element);
  pointers.set(event.pointerId, point);
  /**
   * 捕获指针（与 `PatternCanvas.vue` 同构）：在舞台内按下、拖到**舞台之外**再松手时，
   * 松手那一下以及之后的移动都会回到捕获元素上。少了它，舞台收不到 `pointerup`，
   * `pointers` / `dragging` 会留在原地——用户只是把鼠标移回舞台，图就跟着跑
   * （C8 任务 6 第 1 轮审查的「重要 2」）。可选调用：happy-dom 有这个方法但是空转
   * （不重定向事件），`?.` 也让没有它的环境不炸。
   */
  (event.target as Element | null)?.setPointerCapture?.(event.pointerId);
  if (pointers.size === 1) {
    pressOrigin = point;
    dragging = point;
  }
  if (pointers.size === 2) {
    const ids = [...pointers.keys()] as [number, number];
    const a = pointers.get(ids[0]);
    const b = pointers.get(ids[1]);
    if (a !== undefined && b !== undefined) {
      pinch = {
        ids,
        lastDistance: Math.hypot(a.x - b.x, a.y - b.y),
        lastCentre: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      };
    }
    // **第二指落下就不再有「单指轻点」这回事**：不清 `pressOrigin` 的话，捏合收拢后最后一抬
    // 只要落回第一指落点 12px 内就会被记成一次轻点，紧接着的一次轻点于是被误判成双击
    // （与 `onPointerUp` 里「多指不算」的注释是同一件事）。
    pressOrigin = null;
    dragging = null;
  }
}

function onPointerMove(event: PointerEvent): void {
  const element = stage.value;
  const current = view.value;
  const grid = sheetGrid.value;
  if (element === null || current === null || grid === null || !canTransform.value) return;
  if (!pointers.has(event.pointerId)) return;
  /**
   * **按键已经松开 ⇒ 这条指针是陈旧的，清干净再早退**。
   *
   * 来路：真机鼠标在舞台内按下、到舞台外松手（松手点常常落在底部操作条上——它是舞台的**兄弟**、
   * 不是后代），舞台收不到 `pointerup`。上面的 `setPointerCapture` 能救回绝大多数情况，但捕获
   * 也可能被系统丢掉（切窗口 / 手势被浏览器接管），所以这里再按**事件自身的按键状态**兜底：
   * 一次没有按键的 `pointermove` 只可能是悬停，不该平移。
   * 少了它，用户把鼠标移回舞台，图就会自己跑（C8 任务 6 第 1 轮审查的「重要 2」）。
   */
  if (event.buttons === 0) {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) {
      dragging = null;
      pressOrigin = null;
    }
    return;
  }
  const previous = pointers.get(event.pointerId) as { x: number; y: number };
  const point = localPoint(event, element);
  pointers.set(event.pointerId, point);

  if (pinch !== null) {
    const a = pointers.get(pinch.ids[0]);
    const b = pointers.get(pinch.ids[1]);
    if (a === undefined || b === undefined) return;
    const distance = Math.hypot(a.x - b.x, a.y - b.y);
    const centre = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    // 退化输入（两指重合 / 还没分开）由**手势层**拦下：core 的守卫不该为一种正常动作放宽。
    if (pinch.lastDistance > 0 && distance > 0) {
      const scaled = zoomCellView(
        current,
        viewport.value,
        grid,
        current.scale * (distance / pinch.lastDistance),
        centre,
      );
      view.value = panCellView(
        scaled,
        viewport.value,
        grid,
        centre.x - pinch.lastCentre.x,
        centre.y - pinch.lastCentre.y,
      );
    }
    pinch.lastDistance = distance;
    pinch.lastCentre = centre;
    return;
  }

  if (dragging !== null && pointers.size === 1) {
    view.value = panCellView(
      current,
      viewport.value,
      grid,
      point.x - previous.x,
      point.y - previous.y,
    );
    dragging = point;
  }
}

function onPointerUp(event: PointerEvent): void {
  const element = stage.value;
  const point = element === null ? null : localPoint(event, element);
  pointers.delete(event.pointerId);
  if (pointers.size < 2) pinch = null;
  const origin = pressOrigin;
  if (pointers.size === 0) {
    dragging = null;
    pressOrigin = null;
  }
  if (point === null || origin === null || !canTransform.value) return;
  // 双击判定：**单指**、位移在容差内、两次轻点间隔 < 300ms。多指（捏合结束那一抬）不算。
  if (pointers.size > 0) return;
  if (Math.hypot(point.x - origin.x, point.y - origin.y) > TAP_SLOP_PX) {
    lastTap = null;
    return;
  }
  const now = Date.now();
  if (
    lastTap !== null &&
    now - lastTap.at < DOUBLE_TAP_MS &&
    Math.hypot(point.x - lastTap.x, point.y - lastTap.y) < TAP_SLOP_PX
  ) {
    lastTap = null;
    onDoubleTap();
    return;
  }
  lastTap = { at: now, x: point.x, y: point.y };
}

/** 双击：在「整图适配」与「放大到上限」之间切换（看图 app 的通用动作）。 */
function onDoubleTap(): void {
  const current = view.value;
  const grid = sheetGrid.value;
  if (current === null || grid === null || !canTransform.value) return;
  const fit = defaultCellView(viewport.value, grid);
  if (current.scale > fit.scale * 1.01) {
    zoomFit();
    return;
  }
  zoomAt(maxCellScale(viewport.value, grid), {
    x: viewport.value.width / 2,
    y: viewport.value.height / 2,
  });
}

function zoomAt(nextScale: number, anchor: { x: number; y: number }): void {
  const current = view.value;
  const grid = sheetGrid.value;
  if (current === null || grid === null || !canTransform.value) return;
  view.value = zoomCellView(current, viewport.value, grid, nextScale, anchor);
}

/** 底部操作条：以视口中心为锚点放大 / 缩小（与编辑器工具栏同一口径）。 */
function zoomBy(factor: number): void {
  const current = view.value;
  if (current === null || !canTransform.value) return;
  const centre = { x: viewport.value.width / 2, y: viewport.value.height / 2 };
  zoomAt(current.scale * factor, centre);
}

/** 整图适配：现在**只给双击用**（「适配」那颗按钮按 C8 规格删掉了）。 */
function zoomFit(): void {
  const grid = sheetGrid.value;
  if (grid === null || !canTransform.value) return;
  view.value = defaultCellView(viewport.value, grid);
}

/** 滚轮缩放（桌面调试）；锚点取指针位置。 */
function onWheel(event: WheelEvent): void {
  const current = view.value;
  const element = stage.value;
  if (current === null || element === null || !canTransform.value) return;
  event.preventDefault();
  const rect = element.getBoundingClientRect();
  const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
  zoomAt(current.scale * factor, { x: event.clientX - rect.left, y: event.clientY - rect.top });
}

/** 现算完成前用缩略图垫场；算完换成施工图。 */
const previewSrc = computed(() => blobUrl.value || props.thumbnail || "");

onMounted(async () => {
  measure();
  window.addEventListener("resize", measure);
  try {
    const stats = patternStats(props.pattern, props.palette);
    // 这一份用量同时喂渲染通道与打印页（不重算第二遍统计）。
    usages.value = stats.usages;
    // 通道把 blob 与**计划**一起交出来（C8 修复 ②）：计划是「画布像素 ↔ 格」的唯一换算来源。
    const { blob, plan } = await renderSheetBlob({
      pattern: props.pattern,
      palette: props.palette,
      usages: usages.value,
      projectName: props.name,
    });
    // **卸载判据排在任何副作用之前**：这里是这颗 blob 唯一的注册点，一旦放过，已死实例上生出来的
    // object URL 再没有人能销号。
    if (disposed) return;
    sheetBlob.value = blob;
    sheetPlan.value = plan;
    // **计划到手后补量一次**：`onMounted` 开头那次 `measure()` 可能已经量到视口尺寸，但那时还没有
    // 坐标系（`sheetGrid` 是 null）⇒ 视图仍是 null。不补这一次的话，真机上「尺寸早就量到了」的
    // 常见路径会永远停在 `maxWidth: 100%` 兜底那一支（计划到了却永远不进入可缩放视图）。
    measure();
    // **预览 URL 单独兜错**：它与「图纸生成」是两件事——URL 造不出来时图纸**已经算完了**
    // （保存按钮因此可点），报成「图纸生成失败」是失实；也不该落进下面那个 catch 把一颗已生成的
    // blob 说成失败。预览失败只影响垫场图，保存路径不受影响。
    try {
      blobUrl.value = URL.createObjectURL(blob);
    } catch (e) {
      error.value = `预览生成失败：${e instanceof Error ? e.message : String(e)}`;
    }
  } catch (e) {
    // 中文包裹：`String(e)` 对非 Error 来源（IDB 的 `DOMException`、被抛出的字符串）会露出裸英文。
    error.value = `图纸生成失败：${e instanceof Error ? e.message : String(e)}`;
  } finally {
    busy.value = false;
  }
});

onUnmounted(() => {
  disposed = true;
  window.removeEventListener("resize", measure);
  if (blobUrl.value !== "") URL.revokeObjectURL(blobUrl.value);
  blobUrl.value = "";
  sheetBlob.value = null;
  sheetPlan.value = null;
});

async function save(): Promise<void> {
  const blob = sheetBlob.value;
  // `saving` 早退是**判据**，`:disabled` 只是视觉（见 `saving` 的 JSDoc）。可点性判的是 `sheetBlob`
  // （而不是 `blobUrl`）：blob 在 URL 之前就绪，URL 造不出来不该让一颗**已经生成好**的 blob 存不了。
  if (blob === null || saving.value) return;
  saving.value = true;
  // **入口清空**：不清的话，重试期间屏幕上还挂着上一轮的「保存失败：…」，用户会以为这次也失败了。
  saveState.value = "";
  try {
    await getPlatform().album.save(blob, exportFilename(props.name, "施工图"));
    saveState.value = getPlatform().album.kind === "album" ? "已保存到相册" : "已生成";
  } catch (e) {
    saveState.value = `保存失败：${e instanceof Error ? e.message : String(e)}`;
  } finally {
    // **失败也要放行**：卡在 `saving = true` 等于「错一次就再也存不了」，而失败原因已经显示出来了。
    saving.value = false;
  }
}
</script>

<template>
  <section data-testid="sheet-viewer" class="fixed inset-0 z-30 flex flex-col bg-white p-4">
    <!-- 标题行 = 返回箭头 + 标题。**`sheet-close` 这个 id 沿用**（四个测试文件在读它），
         按钮的形态从「关闭」变成看图 app 的返回箭头。 -->
    <header class="mx-auto flex w-full max-w-6xl items-center gap-3">
      <button
        data-testid="sheet-close"
        aria-label="返回"
        class="min-h-11 min-w-11 shrink-0 rounded border border-slate-300 text-xl leading-none"
        @click="emit('close')"
      >
        ←
      </button>
      <h2 data-testid="sheet-title" class="project-name min-w-0 truncate text-2xl font-bold text-slate-900">
        {{ name }} · 施工图
      </h2>
    </header>

    <p v-if="busy" data-testid="sheet-loading" class="mx-auto mt-3 w-full max-w-6xl text-base text-slate-500">正在生成施工图…</p>
    <p v-if="error" data-testid="sheet-error" class="mx-auto mt-3 w-full max-w-6xl rounded bg-amber-50 p-4 text-lg text-amber-800">{{ error }}</p>

    <!--
      图纸舞台：`overflow-hidden` + `flex-1` ⇒ 放大后拖动看局部。`<img>` 的 transform 由 `view` 给，
      **组件不自己算坐标**（`offsetX/offsetY/scale` 全部来自 `core/pattern/view.ts`）。
      `touch-none`（Tailwind 的 `touch-action: none`）把手势从浏览器的滚动 / 双击缩放手里拿回来，
      否则真机上双指捏合会被页面的滚动接管。
      **舞台刻意不绑 `@dblclick`**：双击只由指针序列判定（见 `lastTap` 的 JSDoc）——两条入口并存时，
      一次鼠标双击会跑两遍处理器、一来一回互相抵消。
      **也**不绑 `@pointerleave`（与 `PatternCanvas.vue` 同构）：拖出舞台就中止平移不是想要的行为；
      「松手点落在舞台之外」那一条由 `onPointerDown` 的 `setPointerCapture` + `onPointerMove` 的
      `buttons === 0` 兜底来收尾（两者都保证 `pointers` / `dragging` 被清干净）。

      **`scale()` 必须除以 `plan.cellPx`（C8 修复 ②）**：`view.scale` 的语义是**每格多少 CSS px**
      （`screen = offset + cell × cellPx`），而 `<img>` 的固有尺寸是**画布像素**——变换乘在画布像素上，
      所以要先把画布像素换算成格（÷ `cellPx`）。少了这一除，整张图会被放大 `cellPx` 倍左右
      （29×25 那条图：2888 × 20.69 ≈ 59,700 CSS px，屏幕只有 800 px）⇒ 只剩左上角。
      `origin-top-left` 已经让 img 原点落在画布原点，
      因此**不需要**额外的 `translate`。计划未到手（`sheetPlan === null`）时仍是 `maxWidth: 100%` 兜底。
    -->
    <div
      ref="stage"
      data-testid="sheet-stage"
      class="mx-auto mt-3 w-full max-w-6xl flex-1 touch-none overflow-hidden rounded bg-slate-100"
      @wheel="onWheel"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
    >
      <img
        v-if="previewSrc !== ''"
        data-testid="sheet-preview"
        :src="previewSrc"
        alt="施工图"
        class="origin-top-left select-none"
        :style="
          view === null || sheetPlan === null
            ? { maxWidth: '100%' }
            : {
                transform: `translate(${view.offsetX}px, ${view.offsetY}px) scale(${view.scale / sheetPlan.cellPx})`,
                maxWidth: 'none',
                imageRendering: 'auto',
              }
        "
        draggable="false"
      />
    </div>

    <!-- 底部固定操作条（C8 规格 §4.3）：放大 / 缩小 / 打印 / 保存。「适配」按钮删掉了——双击即适配。 -->
    <div class="mx-auto mt-3 flex w-full max-w-6xl flex-wrap items-center gap-3">
      <button data-testid="sheet-zoom-in" class="min-h-11 rounded border border-slate-300 px-4 text-base" @click="zoomBy(1.25)">
        放大
      </button>
      <button data-testid="sheet-zoom-out" class="min-h-11 rounded border border-slate-300 px-4 text-base" @click="zoomBy(1 / 1.25)">
        缩小
      </button>
      <button data-testid="sheet-print" class="min-h-11 rounded border border-slate-300 px-4 text-base" @click="printing = true">
        打印
      </button>
      <button
        data-testid="sheet-save"
        :disabled="sheetBlob === null || saving"
        class="min-h-11 rounded bg-slate-900 px-6 text-base text-white disabled:opacity-50"
        @click="save"
      >
        保存
      </button>
      <span v-if="saveState" data-testid="sheet-save-state" class="text-base text-slate-600">{{ saveState }}</span>
    </div>

    <!--
      打印页（C8 规格 §4.3）：**查看层自己渲染**它，宿主页面都不必知道打印页存在。它拿到的
      `pattern` / `palette` / `usages` / `project-name` 与喂渲染通道的是同一份。
      作为根 section 里的**最后一个元素**：单根不变，`@close` 由这里收掉面板（查看层本身不动）。
    -->
    <ExportPanel
      v-if="printing"
      :pattern="pattern"
      :palette="palette"
      :usages="usages"
      :project-name="name"
      @close="printing = false"
    />
  </section>
</template>
