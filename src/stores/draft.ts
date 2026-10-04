import { defineStore } from "pinia";
import { markRaw, ref } from "vue";
import { centerSquare, clampRectToSource, type AspectLock } from "@/core/crop/rect";
import type { Size, ZoomLevel } from "@/core/crop/view";
import type { Rect, Rotation } from "@/core/image/types";
import { MAX_LONG_SIDE, MIN_LONG_SIDE, type MaxColors } from "@/core/pattern/types";

/**
 * 向导草稿与阶段机（`/new` → 选区 → 参数 → 结果）。
 *
 * 它只回答两件事：用户现在走到哪一步，以及手上这份选区与参数是什么。**不 import 解码器、
 * 不 import `indexedDB`**——解码在 `services/`，落盘在 `useProjectSession`。
 *
 * `generated` 的语义是「本次生成成功、且此后没有改过**会影响产物**的东西」：改选区 / 旋转 /
 * 比例 / 长边 / 档位都让它回落到 false，而**改缩放档位与平移不回落**（视图不改变产物）。
 * 这条规则有用例钉住，别顺手统一处理。
 *
 * **为何公开**（`AGENTS.md`「公开 API ≠ 被使用的 API」）：本文件的一切导出都是任务 10
 * （`PickPage`：`adoptImage` / `source` / `sourceSize` / `preview` / `rerunOf`）、任务 11
 * （`SetupPage`）与任务 12（`EditorPage` 重跑入口：`adoptProject` / `DraftParams` /
 * `RerunTarget`）的接口面。**它们现在都在生产路径上被消费**——`PickPage.vue` / `SetupPage.vue` /
 * `EditorPage.vue` 三个页面各有一处 `useDraft()`，不是「只被用例消费」（`reset` 没有独立调用点，
 * 经 `onLeaveSetup` 到达）。
 *
 * 任务 11 的接口面**不只是 setter**，它同时**读** `source` / `sourceSize` / `preview` / `crop` /
 * `rotation` / `aspect` / `zoom` / `pan` / `longSide` / `maxColors` / `stage` / `busy` / `error` /
 * `rerunOf`（`task-11-brief.md` 逐项出现），并**写** `setSourceSize` / `setPreview` / `setCrop` /
 * `setRotation` / `setAspect` / `setLongSide` / `setMaxColors` / `setZoom` / `setPan` / `setStage` /
 * `setBusy` / `setError` / `markGenerated` / `onLeaveSetup` / `setRerunOf`。`releasePreview` 除了
 * `onLeaveSetup` 里那一支（规格 §9 的「总是释放预览」）之外，还被 `SetupPage` 的「保存失败 →
 * 离开」分支直接调用；`reset` 没有独立调用点，它是 `onLeaveSetup` 的另一个出口（§9 的
 * 「已生成且无改动 → 清空草稿」）。两者同样归任务 11 的离开路径。
 */

/** 向导的三个阶段：选区 → 参数 → 结果。 */
export type Stage = "crop" | "params" | "result";

/** 用户选中的那张原图（`blob` 是原始字节，尺寸要解码后才知道，见 `setSourceSize`）。 */
export interface DraftSource {
  readonly blob: Blob;
  readonly type: string;
  readonly name: string;
}

/** 就地重跑时要沿用的那条记录（`id` / 名称 / `createdAt` 不变，`updatedAt` 由 save 刷新）。 */
export interface RerunTarget {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

/** 一张图纸的全部输入参数（`crop` 是**原图未旋转坐标**上的选区）。 */
export interface DraftParams {
  readonly longSide: number;
  readonly maxColors: MaxColors;
  readonly crop: Rect;
  readonly rotation: Rotation;
}

const DEFAULT_LONG_SIDE = 58;
const DEFAULT_MAX_COLORS: MaxColors = 32;

// ---------------------------------------------------------------------------
// 入口校验（规格 §12）
//
// 本文件是这份校验的**第三处副本**（第一处 `core/crop/view.ts`、第二处 `core/crop/rect.ts`），
// 但**不是最后一处**：`core/project/types.ts` 里还有**第四处**内联的长边 / 档位 / 旋转守卫
// （它守的是从磁盘 / 本地存储读回来的 JSON，是另一条外部输入路径），`core/pattern/build.ts`
// 是**第五处**（`computeGridSize` 的长边守卫 + `buildPattern` 的档位守卫——先前只记到第四处，
// 漏计了它，见 README 的 B2-27）。照规格 §13 第 8 条「共享校验模块不修，保持内联就地校验」
// 执行，现在不抽模块。
//
// **如实记录**：这份决定要付的代价——「错误信息口径漂移」——**已经实际发生**：
// `core/project/types.ts` 的档位措辞（`用色档位非法：…（只允许 16 / 32 / null）`）与旋转措辞
// （`旋转角度非法：…（必须是 0–3 的整数）`）与本文件**逐字相同**（`core/pattern/build.ts` 的档位
// 也是同一句），而长边措辞已经分叉：`core/project/types.ts` 与 `core/pattern/build.ts` 写
// 「长边豆数必须在 1–500 之间」，本文件写「长边豆数必须是 1–500 的整数」。
//
// 因此「统一口径留到第五处消费者出现时再评估」这个条件**已经到达**（第五处就是 `build.ts`）：
// 按规格 §13 第 8 条与 `AGENTS.md` 的口径仍维持内联就地校验，本轮**不动代码**——改的是账目，
// 不是行为。下次再有人想抽共享模块时，从这份账目出发，别再当成「还没到第五处」。
//
// 与那两处 core 副本的**实质差异**：这里的守卫要挂在「任何写操作之前」（`AGENTS.md` 入口校验
// 硬约束），而 core 的守卫是「夹取 / 映射之前的最后一道」。两者的触发时机不同，抽成一个模块会把
// 「校验发生在状态被改之前」这层语义变成隐式的。
// ---------------------------------------------------------------------------

function requireLongSide(next: number): number {
  if (!Number.isInteger(next) || next < MIN_LONG_SIDE || next > MAX_LONG_SIDE) {
    throw new Error(`长边豆数必须是 ${MIN_LONG_SIDE}–${MAX_LONG_SIDE} 的整数（当前 ${String(next)}）`);
  }
  return next;
}

function requireMaxColors(next: MaxColors): MaxColors {
  if (next !== 16 && next !== 32 && next !== null) {
    throw new Error(`用色档位非法：${String(next)}（只允许 16 / 32 / null）`);
  }
  return next;
}

function requireRotation(next: Rotation): Rotation {
  if (next !== 0 && next !== 1 && next !== 2 && next !== 3) {
    throw new Error(`旋转角度非法：${String(next)}（必须是 0–3 的整数）`);
  }
  return next;
}

function requireAspect(next: AspectLock): AspectLock {
  if (next !== "free" && next !== "1:1" && next !== "4:3" && next !== "9:16") {
    throw new Error(`比例锁非法：${String(next)}（只允许 "free" / "1:1" / "4:3" / "9:16"）`);
  }
  return next;
}

function requireZoom(next: ZoomLevel): ZoomLevel {
  if (next !== "fit" && next !== 2 && next !== 4) {
    throw new Error(`缩放档位非法：${String(next)}（只允许 "fit" / 2 / 4）`);
  }
  return next;
}

function requireStage(next: Stage): Stage {
  if (next !== "crop" && next !== "params" && next !== "result") {
    throw new Error(`阶段非法：${String(next)}（只允许 "crop" / "params" / "result"）`);
  }
  return next;
}

/**
 * 重跑目标（身份）的三个字段都是**字符串**，`id` 还必须**非空**。
 *
 * 为什么运行期要查：这三个字段会被 `save()` 写进存储再回读（`id` 决定 `put` 的键），而类型
 * 挡不住 `JSON.parse` + 强转。`id` 为空串时 `put` 会造出一条谁也打不开的记录，属静默数据损坏。
 */
function requireRerunTarget(target: RerunTarget): RerunTarget {
  if (typeof target.id !== "string" || target.id === "") {
    throw new Error(`重跑目标的 id 必须是非空字符串（当前 ${String(target.id)}）`);
  }
  if (typeof target.name !== "string") {
    throw new Error(`重跑目标的名称必须是字符串（当前 ${String(target.name)}）`);
  }
  if (typeof target.createdAt !== "string") {
    throw new Error(`重跑目标的 createdAt 必须是字符串（当前 ${String(target.createdAt)}）`);
  }
  return target;
}

/** 原图尺寸必须**整数且 ≥1**（`AGENTS.md`「入口校验」的网格 / 尺寸类口径）。 */
function requireSourceSizeInput(size: Size): Size {
  if (!Number.isInteger(size.width) || size.width < 1) {
    throw new Error(`原图宽度必须是 ≥1 的整数（当前 ${String(size.width)}）`);
  }
  if (!Number.isInteger(size.height) || size.height < 1) {
    throw new Error(`原图高度必须是 ≥1 的整数（当前 ${String(size.height)}）`);
  }
  return size;
}

/**
 * 选区：分量必须**有限**、宽高必须 **≥1**。
 *
 * **越界不是错误**——那是 `clampRectToSource` 的职责（原图尺寸不在手上时也算不出边界）。
 * 这里只拒绝退化与非有限的矩形：`NaN` 会被 `Math.min` / `Math.max` 一路透传成 `NaN` 选区，
 * 最后喂进流水线产出带透明边的图纸，属于本项目点名要消灭的「不报错、只产出错误结果」。
 */
function requireCropInput(rect: Rect): Rect {
  if (!Number.isFinite(rect.x)) throw new Error(`选区 x 必须是有限数字（当前 ${String(rect.x)}）`);
  if (!Number.isFinite(rect.y)) throw new Error(`选区 y 必须是有限数字（当前 ${String(rect.y)}）`);
  if (!Number.isFinite(rect.width) || rect.width < 1) {
    throw new Error(`选区宽度必须 ≥1 的有限数字（当前 ${String(rect.width)}）`);
  }
  if (!Number.isFinite(rect.height) || rect.height < 1) {
    throw new Error(`选区高度必须 ≥1 的有限数字（当前 ${String(rect.height)}）`);
  }
  return rect;
}

export const useDraft = defineStore("draft", () => {
  const source = ref<DraftSource | null>(null);
  const sourceSize = ref<Size | null>(null);
  // `markRaw`：canvas 是 DOM 节点，被 Vue 深度代理既没有收益也有开销。它在用例里也**不是**
  // 恒真的装饰——桩画布是普通对象，去掉 `markRaw` 后 `setPreview` 的同一性断言会红。
  // 但不会为它单独写一条用例（「DOM 节点不会被代理」那类断言在本环境里恒真）。
  const preview = ref<HTMLCanvasElement | null>(null);
  const rerunOf = ref<RerunTarget | null>(null);

  /**
   * 当前选区（**原图未旋转坐标**；`crop: Rect | null`，规格 §9）。
   *
   * **何时为 null**：`adoptProject` 之后、`setSourceSize` 之前——原图尺寸还没解码出来，算不出
   * 边界，所以此刻**没有**选区，而不是一个用 `NaN` 算出来的选区。`adoptImage` 与
   * `setSourceSize` 都会把它落定，`reset()` 会把它清回 null。
   *
   * **消费方必须 null 检查**（任务 8 的 `CropCanvas`、任务 11 的 `SetupPage`、任务 12 的重跑入口
   * 都按名读它）：拿 `null` 去算几何正是本项目要消灭的「不报错、只产出错误结果」。
   */
  const crop = ref<Rect | null>(null);
  /** `adoptProject` 带来的裁剪框：原图尺寸还没解码出来，先存着，`setSourceSize` 到时再夹取。 */
  const pendingCrop = ref<Rect | null>(null);
  const rotation = ref<Rotation>(0);
  const aspect = ref<AspectLock>("free");
  const zoom = ref<ZoomLevel>("fit");
  const pan = ref<{ x: number; y: number }>({ x: 0, y: 0 });

  const longSide = ref(DEFAULT_LONG_SIDE);
  const maxColors = ref<MaxColors>(DEFAULT_MAX_COLORS);

  const stage = ref<Stage>("crop");
  const generated = ref(false);
  const busy = ref(false);
  const error = ref("");

  /**
   * 当前原图尺寸（夹取选区的边界来源）。
   *
   * 尺寸还没就位时抛错而不是返回 null：让调用方拿 `null` 去算几何正是本项目要消灭的静默失败，
   * 而 `setCrop` 的消费方（任务 8 的 `CropCanvas`）只可能挂在已经解码之后。
   */
  function currentSourceSize(): Size {
    if (sourceSize.value === null) throw new Error("还没有选图，拿不到原图尺寸");
    return sourceSize.value;
  }

  /** 视图三段（比例锁 / 缩放档位 / 平移）回到刚进向导时的初始态。它们都不是图纸参数。 */
  function resetView(): void {
    aspect.value = "free";
    zoom.value = "fit";
    pan.value = { x: 0, y: 0 };
  }

  /**
   * 选了一张新图：选区回到居中正方（与 B1 临时入口逐位等价），参数与视图回落默认值。
   *
   * 尺寸校验在**任何写操作之前**：否则一个非法尺寸会先落进 `sourceSize`、再由 `centerSquare`
   * 抛错，留下「尺寸是新的、选区还是上一张图的」半截草稿——而调用方只看到一句抛错。
   */
  function adoptImage(input: {
    readonly source: DraftSource;
    readonly sourceSize: Size;
    readonly preview: HTMLCanvasElement;
  }): void {
    const nextSize = requireSourceSizeInput(input.sourceSize);

    source.value = input.source;
    sourceSize.value = nextSize;
    preview.value = markRaw(input.preview);
    rerunOf.value = null;
    pendingCrop.value = null;
    crop.value = centerSquare(nextSize);
    rotation.value = 0;
    resetView();
    longSide.value = DEFAULT_LONG_SIDE;
    maxColors.value = DEFAULT_MAX_COLORS;
    stage.value = "crop";
    generated.value = false;
    busy.value = false;
    error.value = "";
  }

  /**
   * 从已有工程进来（规格 §7）：参数原样播种，**原图尺寸与预览留空**——它们要等 `SetupPage`
   * 把 `source.blob` 解码出来才知道（本方法的调用方是编辑器，手里只有 `Blob`）。
   * 解码只发生在 `SetupPage` 一处，不在编辑器里再来一份（本项目的头号缺陷形态就是
   * 「两端各自正确、错在接线」）。
   *
   * 因此这里的 `crop` 先存进 `pendingCrop`，等 `setSourceSize` 到了再夹取——**顺序不能反**：
   * 没有原图尺寸时算不出边界，`Math.min(NaN, ...)` 只会得到 `NaN`。
   *
   * 四处校验同样落在**写操作之前**：一个非法的 `rotation` 若在写完之后才抛，store 会停在
   * 「新 source + 空 crop + 旧 rotation」的半截态（`AGENTS.md`：校验写在任何写操作之前）。
   */
  function adoptProject(input: {
    readonly source: DraftSource;
    readonly params: DraftParams;
    readonly meta: RerunTarget;
  }): void {
    const nextRotation = requireRotation(input.params.rotation);
    const nextLongSide = requireLongSide(input.params.longSide);
    const nextMaxColors = requireMaxColors(input.params.maxColors);
    const nextCrop = requireCropInput(input.params.crop);

    source.value = input.source;
    sourceSize.value = null;
    preview.value = null;
    rerunOf.value = { id: input.meta.id, name: input.meta.name, createdAt: input.meta.createdAt };
    pendingCrop.value = nextCrop;
    crop.value = null;
    rotation.value = nextRotation;
    resetView();
    longSide.value = nextLongSide;
    maxColors.value = nextMaxColors;
    stage.value = "crop";
    generated.value = false;
    busy.value = false;
    error.value = "";
  }

  /**
   * 记下「本草稿指向的落盘记录」，`null` 表示还没有落过盘——**身份的唯一写入口**。
   *
   * **为什么身份必须住在 store 里**：它决定下一次生成是**新建**还是**覆盖同一条**。`SetupPage`
   * 原先把它放在页面级 `ref` 里，组件一销毁就丢——「生成成功 → 改任意参数（`generated` 落回
   * false）→ 用硬件返回键离开（规格 §9）→ 从 `/new` 的『继续上次的选区』回来 → 再生成」这条
   * **可达主流程**上，页面级身份与 `rerunOf` 同时为 null，于是库里多出**第二条同名记录**，
   * 而界面还写着「已更新这张图纸」。现在：`adoptProject`（编辑器重跑入口）种下它、
   * `SetupPage` 在生成并保存成功后写回它、`adoptImage` / `reset` 清掉它。
   *
   * **校验写在任何写操作之前**（`AGENTS.md`「入口校验」）：`id` 必须非空字符串、`name` 与
   * `createdAt` 必须是字符串，非法抛中文错误——非法输入不会留下「身份是新的、其余状态是旧的」
   * 半截草稿。
   */
  function setRerunOf(target: RerunTarget | null): void {
    if (target === null) {
      rerunOf.value = null;
      return;
    }
    const next = requireRerunTarget(target);
    // 拷一份而不是存引用：调用方（`SetupPage`）手里的 `meta` 是 `ProjectMeta`，原地改它不该
    // 悄悄改掉这里的身份。
    rerunOf.value = { id: next.id, name: next.name, createdAt: next.createdAt };
  }

  /**
   * 原图尺寸就位（新图来自 `loadImageSource` 的返回值；重跑来自 `SetupPage` 的解码）。
   *
   * 这是**唯一**落下初始选区的时机：新图用居中正方，重跑用 `pendingCrop`（经夹取）。
   * 已经有选区时**不重建**（用户在选区页上的改动不该被一次尺寸刷新重置），但仍要重新夹取：
   * 换到更小的原图时旧选区会越界，而「`crop` 合法且不越界」是喂给流水线的前提。
   * 夹取是幂等的，所以尺寸没变时这一步是空操作。
   */
  function setSourceSize(input: Size): void {
    const next = requireSourceSizeInput(input);
    sourceSize.value = next;
    crop.value = clampRectToSource(crop.value ?? pendingCrop.value ?? centerSquare(next), next);
    pendingCrop.value = null;
  }

  /**
   * 挂上预览画布（重跑路径由 `SetupPage` 解码后调用，规格 §7）。
   *
   * 运行期拒绝 `null` / `undefined` 与非对象。两类坏输入各有各的坏法（实测 Vue 3.5.43 的
   * `markRaw`，见 `task-7-report.md`「修复轮 1」）：`null` / `undefined` 会在 `markRaw` 里抛英文
   * `TypeError`（`Cannot convert undefined or null to object`）——响亮，但不是领域错误、也说不清
   * 是哪个字段；而 `7` / `true` 这类**其他原始值**会被 `markRaw` 原样返回并**静默**写进
   * `preview`，让下游把非画布当画布用，正是本项目点名的「不报错、只产出错误结果」。清预览的
   * 唯一入口是 `releasePreview()`，所以这里不需要接受 `null`。
   *
   * 判据刻意**不是** `instanceof HTMLCanvasElement`：用例里的桩画布是普通对象（那样写会让既有
   * 用例全红），而真实的 `OffscreenCanvas` 也不是 `HTMLCanvasElement`。
   */
  function setPreview(next: HTMLCanvasElement): void {
    if (next === null || typeof next !== "object") {
      throw new Error(`预览画布必须是非 null 的对象（当前 ${String(next)}）`);
    }
    preview.value = markRaw(next);
  }

  /** 改选区（源坐标，越界被夹回来，守住「`crop` 合法且不越界」）。 */
  function setCrop(next: Rect): void {
    crop.value = clampRectToSource(next, currentSourceSize());
    generated.value = false;
  }

  function setRotation(next: Rotation): void {
    rotation.value = requireRotation(next);
    generated.value = false;
  }

  /** 改比例锁。注意它只影响**选区形状的来源**；`crop` 本身由任务 8 的 `CropCanvas` 收进新比例。 */
  function setAspect(next: AspectLock): void {
    aspect.value = requireAspect(next);
    generated.value = false;
  }

  function setLongSide(next: number): void {
    longSide.value = requireLongSide(next);
    generated.value = false;
  }

  function setMaxColors(next: MaxColors): void {
    maxColors.value = requireMaxColors(next);
    generated.value = false;
  }

  /** 改缩放档位。**视图改动不影响产物，所以不让 `generated` 失效。** */
  function setZoom(next: ZoomLevel): void {
    zoom.value = requireZoom(next);
  }

  /** 改平移。**视图改动不影响产物，所以不让 `generated` 失效。** */
  function setPan(next: { x: number; y: number }): void {
    if (!Number.isFinite(next.x) || !Number.isFinite(next.y)) {
      throw new Error(`视图平移必须是有限数字（当前 ${String(next.x)}, ${String(next.y)}）`);
    }
    pan.value = { x: next.x, y: next.y };
  }

  function setStage(next: Stage): void {
    stage.value = requireStage(next);
  }

  function setBusy(next: boolean): void {
    busy.value = next;
  }

  function setError(message: string): void {
    error.value = message;
  }

  /** 生成成功：进入结果阶段。**不**清 `error`——保存失败的提示要在生成之后才写进来。 */
  function markGenerated(): void {
    generated.value = true;
    stage.value = "result";
  }

  /** 释放预览画布（长边 ≤1600 的位图，长期挂着不值），其余状态一个不动。 */
  function releasePreview(): void {
    preview.value = null;
  }

  /**
   * 离开 `SetupPage` 时的生死规则（规格 §9）：已生成且此后无改动 → 整份草稿作废
   * （图纸已在库里，重跑走编辑器的入口）；中途退出 → 只释放预览，选区与参数留着，
   * 于是 `/new` 上的「继续上次的选区」还能用。
   */
  function onLeaveSetup(): void {
    if (generated.value) {
      reset();
      return;
    }
    releasePreview();
  }

  /** 把草稿清成「还没选图」的初始态（`onLeaveSetup` 的作废分支与用户主动放弃共用）。 */
  function reset(): void {
    source.value = null;
    sourceSize.value = null;
    preview.value = null;
    rerunOf.value = null;
    pendingCrop.value = null;
    crop.value = null;
    rotation.value = 0;
    resetView();
    longSide.value = DEFAULT_LONG_SIDE;
    maxColors.value = DEFAULT_MAX_COLORS;
    stage.value = "crop";
    generated.value = false;
    busy.value = false;
    error.value = "";
  }

  return {
    source,
    sourceSize,
    preview,
    rerunOf,
    crop,
    rotation,
    aspect,
    zoom,
    pan,
    longSide,
    maxColors,
    stage,
    generated,
    busy,
    error,
    adoptImage,
    adoptProject,
    setRerunOf,
    setSourceSize,
    setPreview,
    setCrop,
    setRotation,
    setAspect,
    setLongSide,
    setMaxColors,
    setZoom,
    setPan,
    setStage,
    setBusy,
    setError,
    markGenerated,
    releasePreview,
    onLeaveSetup,
    reset,
  };
});
