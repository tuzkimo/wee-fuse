import { defineStore } from "pinia";
import { computed, markRaw, ref } from "vue";
import { clampView, type Size, type ViewTransform } from "@/core/crop/view";
import type { Rect } from "@/core/image/types";
import { buildPaintCommand, buildRectPaintCommand, cellAt } from "@/core/pattern/edit";
import { EditHistory } from "@/core/pattern/history";
import { EMPTY, type Pattern } from "@/core/pattern/types";
import { defaultCellView } from "@/core/pattern/view";
import { useProjectSession } from "@/stores/project";

/**
 * 编辑器状态机与命令提交。
 *
 * 它只回答四件事：**现在编的是哪张图纸**（`pattern` / `colorCount`）、**用户手上是什么工具与颜色**
 * （`tool` / `currentColor`）、**图纸改过之后画布凭什么重绘**（`revision` / `lastDirty`）、
 * **视图与显示开关**（`view` / `viewInitialized` / `showGrid` / `showLabels` / `saving` / `error`）。
 *
 * 三条不许「顺手统一处理」的规则：
 *
 * 1. **`pattern` 与 `session.pattern` 是同一个对象。** `EditHistory.commit` 就地改 `cells`，
 *    `session.save()` 从 `session.pattern` 派生 doc；两边各持一份拷贝等于「编辑器改了、保存写的是
 *    旧的」——本项目最贵的缺陷形态。所以这里**只存引用、不克隆**，`markRaw` 保证它不被 Vue 包成
 *    响应式代理（`ref(obj)` 默认会走一层 `reactive()`，对 TypedArray 的原地写没有任何帮助）。
 * 2. **`cells` 的原地写 Vue 追不到。** 刷新是一条**显式通道**：`revision` 自增 + `lastDirty` 清单，
 *    画布 `watch(revision)` 后据此决定「只刷这几个像素」还是「整体重建层」（`lastDirty === null`
 *    就是整体重建）。不要为了「看起来更响应式」把 cells 换成响应式数组——那会在每次拖动采样时
 *    复制整张图。
 * 3. **与 `session` 的耦合点只有 `markDirty()` 一处**（在 `publishChange` 里）。`dirty` 不在这里存
 *    第二份：两个标志迟早会出现「一个真一个假」，而路由守卫只看其中一个（规格 §8.1）。
 *
 * 不持有的东西：`Palette` 本体（面板的 props 由页面从 `getBuiltinPalette()` 取；本 store 只要一个
 * 色数上界来守 `currentColor`，否则 `EMPTY` 与越界下标共用 `Uint16` 值域、会静默涂出另一个色号）、
 * `viewport`（只有 `onViewport` 那一刻需要它）、`selection`（框选高亮是拖动期间组件内的预览，
 * 控制者已裁决不落 store）。
 *
 * **为何公开**（`AGENTS.md`「公开 API ≠ 被使用的 API」）：`useEditor` 的 13 个状态字段与 15 个动作
 * 是任务 5（`PatternCanvas` / `PatternToolbar` / `PalettePanel` / `PalettePicker` 全部经 `EditorPage`
 * 以 props 拿值、以事件回调写值）与任务 6（`EditorPage` 的装配：载入成功 → `beginSession`、
 * 量到尺寸 → `onViewport`、保存 → `session.save()`）的接口面；`EditorTool` 同时是
 * `PatternCanvas` / `PatternToolbar` 的 prop 类型。四个组件自身**不 import 本文件**（props 进、
 * 事件出），页面是唯一装配点。
 */

/** 编辑器工具：画笔 / 框选 / 吸管（单指分工，规格 §6.1）。 */
export type EditorTool = "brush" | "select" | "pick";

const DEFAULT_TOOL: EditorTool = "brush";

// ---------------------------------------------------------------------------
// 入口校验（规格 §12）
//
// 全部**内联在本文件**、写在任何写操作之前，不抽共享模块（规格 §12 与 `AGENTS.md` 的既定语）。
// 与 `stores/draft.ts` 的第三份副本同一风格；代价（错误信息口径漂移）已经如实记在那里。
//
// 刻意**不做**的事：不复刻视口 / 网格的守卫。`onViewport` 的两支分别调用 `defaultCellView` 与
// `clampView`，它们内部已有视口（有限且 > 0）与网格（整数 ≥1）的守卫——再写一份就是第六份副本
// （规格 §12 明写不要）。
// ---------------------------------------------------------------------------

/** 图纸：宽高**整数且 ≥1**、`cells` 长度与尺寸自洽（`AGENTS.md` 网格类数据的口径）。 */
function requirePattern(input: Pattern): Pattern {
  if (!Number.isInteger(input.width) || input.width < 1) {
    throw new Error(`图纸宽度必须是 ≥1 的整数（当前 ${String(input.width)}）`);
  }
  if (!Number.isInteger(input.height) || input.height < 1) {
    throw new Error(`图纸高度必须是 ≥1 的整数（当前 ${String(input.height)}）`);
  }
  // 长度不符时遍历仍会走完整个缓冲区，派生量（豆子总数）会静默算成**缓冲区长度**。措辞与
  // `core/pattern/stats.ts` 的同一处校验保持一致，避免同一件事出现两种说法。
  if (input.cells.length !== input.width * input.height) {
    throw new Error(
      `图纸数据与尺寸不一致：${input.width}×${input.height} 需要 ${input.width * input.height} 格，实际 ${input.cells.length} 格`,
    );
  }
  return input;
}

/** 色卡**色数**：`1..EMPTY` 的整数。上界就是 `EMPTY`——色号与空格标记共用 `Uint16` 值域。 */
function requireColorCount(next: number): number {
  if (!Number.isInteger(next) || next < 1 || next > EMPTY) {
    throw new Error(`色卡色数必须是 1–${EMPTY} 的整数（当前 ${String(next)}）`);
  }
  return next;
}

/**
 * 框选矩形：分量必须**有限**、宽高必须 **≥1**。
 *
 * **越界不是错误**——`buildRectPaintCommand` 自己把超界部分裁掉，而框选拖动**经常**拖出图纸边界
 * （想框到最后一列就会拖过头）。这里只拒绝退化与非有限的矩形：`NaN` 会被 `Math.max` / `Math.min`
 * 一路透传成一个空矩形，点击看起来「没反应」，属于不报错、只产出错误结果的路径。
 */
function requireRect(rect: Rect): Rect {
  if (!Number.isFinite(rect.x)) throw new Error(`框选矩形 x 必须是有限数字（当前 ${String(rect.x)}）`);
  if (!Number.isFinite(rect.y)) throw new Error(`框选矩形 y 必须是有限数字（当前 ${String(rect.y)}）`);
  if (!Number.isFinite(rect.width) || rect.width < 1) {
    throw new Error(`框选矩形宽度必须是 ≥1 的有限数字（当前 ${String(rect.width)}）`);
  }
  if (!Number.isFinite(rect.height) || rect.height < 1) {
    throw new Error(`框选矩形高度必须是 ≥1 的有限数字（当前 ${String(rect.height)}）`);
  }
  return rect;
}

/**
 * 图纸用到的**第一个色号**：行优先第一个非 `EMPTY` 的值；全为空格时 0。
 *
 * 不用 `patternStats().usages[0]`——那是「用得最多的色」（按用量降序），语义不同：一张图纸里
 * 用得最多的色可能出现在最后一格。播种当前色的目的是「用户一进来就有个能画的颜色」。
 */
function firstUsedColor(pattern: Pattern): number {
  for (const value of pattern.cells) {
    if (value !== EMPTY) return value;
  }
  return 0;
}

/** 还没量到视口尺寸时的占位视图。`viewInitialized === false` 期间它只存在一两帧。 */
function placeholderView(): ViewTransform {
  return { scale: 1, offsetX: 0, offsetY: 0 };
}

export const useEditor = defineStore("editor", () => {
  // 会话。`markRaw` 的理由见文件头第 1 条：TypedArray 的原地写不会被代理，包一层只有开销。
  const pattern = ref<Pattern | null>(null);
  /**
   * 色卡**色数**（`palette.colors.length`），只用来守 `currentColor`；本 store 不持有色卡本体。
   *
   * **逐字口径**：它是**色卡色数**，不是 `patternStats().colorCount`（图纸实际用到的色数），
   * 也不是 `record.meta.colorCount`（上次保存时的冗余值）。三个同名量传错**不会报错**，只会在
   * 「图纸用色比色卡少」时让 `setCurrentColor` / `pickFromCell` 抛出难归因的错误。
   *
   * 这里**不做**「每格值必须 < colorCount 或 = EMPTY」的 O(n) 扫描：`Pattern` 只有 `buildPattern`
   * 与 `fromProjectDocument` 两个来源，两者都已保证值域；在 store 里再扫一遍整张图纸（116×116
   * 上限下是 1.3 万格）是每次载入的固定开销，而它挡不住任何已知路径（坏数据由 `pickFromCell`
   * 那一处的值域守卫响亮拦下）。
   */
  const colorCount = ref(0);
  /** 每次 `cells` 变更自增。画布 `watch` 它来决定重绘（见 `lastDirty`）。 */
  const revision = ref(0);
  /** 最近一次变更的脏下标；`null` = 没有可复用的增量信息，画布必须整体重建色块层。 */
  const lastDirty = ref<readonly number[] | null>(null);
  // 编辑态。
  const tool = ref<EditorTool>(DEFAULT_TOOL);
  /** 当前画笔值：`0..colorCount-1`，或 `EMPTY`（橡皮 / 不拼豆）。 */
  const currentColor = ref(0);
  /**
   * 编辑历史（上限 `HISTORY_LIMIT = 50`）。
   *
   * `markRaw` 让这个类实例**不进 Vue 的响应式系统**：它是纯数据结构，没有任何模板直接读它的
   * 字段，深代理只会带来开销。**代价必须记住**：是 `markRaw` 掐掉了响应式这条路——**不是**
   * 「私有字段本来就追踪不到」。不 markRaw 时 `ref()` 会深代理这个实例，`this.undoStack` 经
   * getter 变成响应式数组、`.length` 反而**会**被追踪。所以这里只写 `markRaw` 一句，而
   * `canUndo` / `canRedo` 的响应式来源只能由 `revision` 提供：读 `history.canUndo` /
   * `history.canRedo` **不建立任何响应式依赖**，页面与组件必须读本 store 的这两个 computed
   * （见 return 之前那两段），直接读这个类实例的 getter 会让撤销按钮永久停在初始状态。
   */
  const history = ref<EditHistory>(markRaw(new EditHistory()));
  // 视图与显示。
  const view = ref<ViewTransform>(placeholderView());
  /** 是否已按容器尺寸落过默认缩放（规格 §4.2）。**判断属于状态，不属于绘制。** */
  const viewInitialized = ref(false);
  const showGrid = ref(true);
  const showLabels = ref(true);
  // 保存。
  const saving = ref(false);
  const error = ref("");

  /** 当前图纸；没载入时抛错。四个需要图纸的动作共用这一句前置条件。 */
  function requireLoadedPattern(): Pattern {
    if (pattern.value === null) throw new Error("还没有载入图纸");
    return pattern.value;
  }

  /**
   * 把一次 `cells` 变更的结果发出去：脏下标 → 刷新信号 → 未保存标记。
   *
   * `null`（没有可撤销 / 可重做的命令，或命令为空）时**什么都不做**：revision 不动、`lastDirty`
   * 不动、`session.dirty` 不动。否则「点一个已经是当前色的格子」会让画布白重绘一次，并且把一个
   * 什么都没改的图纸标成未保存。
   *
   * 这是本 store 与 `useProjectSession` 的**唯一**耦合点（规格 §7 要点 0）。
   */
  function publishChange(dirty: number[] | null): void {
    if (dirty === null) return;
    lastDirty.value = dirty;
    revision.value += 1;
    useProjectSession().markDirty();
  }

  /**
   * 开启一份新会话（`EditorPage` 载入成功后调用）。
   *
   * 播种规则：`currentColor` 落在图纸用到的第一个色号（全为空格则 0）、历史清空（栈不跨会话）、
   * `viewInitialized` 置 false（下一帧的 `onViewport` 才会落下默认缩放）、revision / lastDirty
   * 归零、工具与显示开关回默认、`saving` / `error` 清空。
   *
   * **它不是一次「改动」**：不调 `markDirty()`，否则打开工程的瞬间就提示「未保存」。
   *
   * 两处校验（图纸、色数）在**任何写操作之前**：否则非法色数会先落进 `colorCount`、再在守卫处抛错，
   * 留下「图纸是新的、色数是旧的」半截会话，而调用方只看到一句抛错。
   */
  function beginSession(input: Pattern, colors: number): void {
    const nextPattern = requirePattern(input);
    const nextColorCount = requireColorCount(colors);

    pattern.value = markRaw(nextPattern);
    colorCount.value = nextColorCount;
    revision.value = 0;
    lastDirty.value = null;
    tool.value = DEFAULT_TOOL;
    // 播种也**必须收口值域**：`requirePattern` 按控制者裁决不扫每格的值域（O(n) 扫描挡不住任何
    // 已知路径），所以色卡外的坏值可能就躺在第一格里。照搬进 `currentColor` 会让画笔握着一个
    // 非色卡色号，而 `buildPaintCommand` 只守 `0..EMPTY`（`core/pattern/edit.ts:44`）——于是它被
    // **静默涂开**（不报错、只产出错误结果）。落在色卡外时回落到 0，「一进来就有个能画的颜色」
    // 这条目的不变。`firstUsedColor` 只会返回 `Uint16Array` 里的值，下界天然成立。
    const seedColor = firstUsedColor(nextPattern);
    currentColor.value = seedColor < nextColorCount ? seedColor : 0;
    history.value.clear();
    view.value = placeholderView();
    viewInitialized.value = false;
    showGrid.value = true;
    showLabels.value = true;
    saving.value = false;
    error.value = "";
  }

  /**
   * 清空会话（重载 `/edit/:id` 换 id、页面卸载时调用）。**不碰 `session`**：会话的载入 / 清空由
   * 页面按自己的顺序做（载入失败时 `session.load` 已经把会话清干净了）。
   */
  function reset(): void {
    pattern.value = null;
    colorCount.value = 0;
    revision.value = 0;
    lastDirty.value = null;
    tool.value = DEFAULT_TOOL;
    currentColor.value = 0;
    history.value.clear();
    view.value = placeholderView();
    viewInitialized.value = false;
    showGrid.value = true;
    showLabels.value = true;
    saving.value = false;
    error.value = "";
  }

  /**
   * 量到容器尺寸（`PatternCanvas` 的 `measure` 事件，经页面转发）。
   *
   * **第一次落 `defaultCellView`，其后只 `clampView`**（规格 §4.2）：横竖屏切换、断点变化、窗口拖动
   * 都会让容器尺寸变，每次都重落默认缩放会把用户刚调好的比例与位置重置掉，而主规格要求「旋转时
   * 工程状态不得丢失」。
   *
   * 图纸还没载入时**安静返回**：`useCanvasSurface` 在挂载期就会量一次，而它可能早于载入完成
   * （规格 §12 对「安静返回」的同一口径）。非法视口由 core 响亮拒绝，且因为赋值在最后，
   * `viewInitialized` 与 `view` 都不会被写坏。
   */
  function onViewport(viewport: Size): void {
    if (pattern.value === null) return;
    const grid: Size = { width: pattern.value.width, height: pattern.value.height };
    const nextView = viewInitialized.value
      ? clampView(view.value, viewport, grid)
      : defaultCellView(viewport, grid);
    view.value = nextView;
    viewInitialized.value = true;
  }

  /** 切工具。运行期查非法枚举：TS 挡不住 `JSON.parse` + 强转，拼错的工具会静默留在状态机里。 */
  function setTool(next: EditorTool): void {
    if (next !== "brush" && next !== "select" && next !== "pick") {
      throw new Error(`编辑器工具非法：${String(next)}（只允许 "brush" / "select" / "pick"）`);
    }
    tool.value = next;
  }

  /**
   * 设当前画笔值：`0..colorCount-1` 的整数，或 `EMPTY`（橡皮）。
   *
   * 为什么必须守：`Uint16Array` 会**静默截断**越界值（`-1` → `0xffff` = EMPTY，`70000` → 4464），
   * 于是「擦除」悄悄变成空格、或涂出另一个色号（`core/pattern/edit.ts` 的 `buildPaintCommand`
   * 记的正是这一类）。`NaN` 只比较上下界拦不住（两个比较同时为假），所以判据是 `Number.isInteger`。
   */
  function setCurrentColor(value: number): void {
    requireLoadedPattern(); // 没有图纸时 `colorCount` 为 0，值域检查的报错会变成「0–-1」这种误导性措辞
    const limit = colorCount.value;
    const inPalette = Number.isInteger(value) && value >= 0 && value < limit;
    if (!inPalette && value !== EMPTY) {
      throw new Error(`当前色号非法：${String(value)}（必须是 0–${limit - 1} 的整数，或 ${EMPTY} 表示橡皮）`);
    }
    currentColor.value = value;
  }

  /**
   * 直接写视图（画布的 `update:view` 事件：双指平移 / 捏合、工具栏的适配与 ± 按钮）。
   *
   * **只校验形状、不夹取**：夹取必须知道视口，而本 store 的状态面里没有视口字段；画布发来的视图
   * 已经过 `zoomCellView` / `panCellView` 的 `clampView`（规格 §4.3 / §4.4）。存副本而不是存引用：
   * 调用方手里的对象不该与本 store 共享可变状态（与 `draft.setPan` 同一口径）。
   */
  function setView(next: ViewTransform): void {
    if (!Number.isFinite(next.scale) || next.scale <= 0) {
      throw new Error(`视图比例必须是正数（当前 ${String(next.scale)}）`);
    }
    if (!Number.isFinite(next.offsetX) || !Number.isFinite(next.offsetY)) {
      throw new Error(`视图偏移必须是有限数字（当前 ${String(next.offsetX)}, ${String(next.offsetY)}）`);
    }
    view.value = { scale: next.scale, offsetX: next.offsetX, offsetY: next.offsetY };
  }

  /**
   * 画笔：把一批格子设成当前色，**一次手势一条命令**（规格 §6.2）。
   *
   * 下标是画布在 `pointerup` 时一次性 emit 的（拖动补格由任务 5 的 `cellsAlongLine` 完成，不在这里）。
   * 元素级的非整数 / 越界由 `buildPaintCommand` 按既有契约**忽略**（它有自己的 JSDoc 与用例），
   * 这里只守形态错误：传进来的不是数组说明接线错了，必须响亮失败。
   *
   * 命令为 `null`（整批都是同色格、越界、或空数组）时什么都不做：不入栈、不动 revision、不置脏。
   */
  function paint(indices: readonly number[]): void {
    const current = requireLoadedPattern();
    if (!Array.isArray(indices)) {
      throw new Error(`画笔下标必须是数组（当前 ${typeof indices}）`);
    }
    // `Array.isArray` 的签名是 `arg is any[]`：**它会把这个参数的元素类型静默放宽成 `any`**
    // （于是本函数体**内**对元素的类型检查会被关掉；调用点仍由 `paint` 自己的签名把关）。显式类型的
    // 局部量把元素类型收回来：运行期的形态守卫一个不少，类型面的检查也一件不少。
    const safeIndices: readonly number[] = indices;
    const command = buildPaintCommand(current.cells, safeIndices, currentColor.value, "画笔");
    if (command === null) return;
    publishChange(history.value.commit(current.cells, command));
  }

  /**
   * 框选：把矩形区域设成当前色，同样一条命令、一次撤销（规格 §6.4）。
   *
   * 当前色为 `EMPTY` 时等价于「整块抠掉」。**工具与当前色都不变**（用户常要连框几块）。
   * 起止点落在同一格（1×1）是合法操作，等同于点一格。
   */
  function applyRect(rect: Rect): void {
    const current = requireLoadedPattern();
    const next = requireRect(rect);
    const command = buildRectPaintCommand(current, next, currentColor.value, "框选");
    if (command === null) return;
    publishChange(history.value.commit(current.cells, command));
  }

  /**
   * 吸管：取该格色号（含 `EMPTY`）设为当前色，并**自动切回画笔**（吸完就能画）。
   *
   * 落在图纸外时**不改当前色、也不切工具**：`cellAt` 对越界返回 `EMPTY`，照搬就会把「点空处」
   * 变成「选了橡皮」——用户以为自己选中了橡皮，下一次拖动的结果完全不同。所以边界自己先判。
   *
   * 写入走 `setCurrentColor` 的同一份值域守卫：格子里躺着越界色号（图纸与色卡不匹配的坏数据）时
   * 响亮失败，而不是静默把它设成当前色、再涂出另一个色号。
   */
  function pickFromCell(x: number, y: number): void {
    const current = requireLoadedPattern();
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      throw new Error(`吸管的格子坐标必须是整数（当前 ${String(x)}, ${String(y)}）`);
    }
    if (x < 0 || y < 0 || x >= current.width || y >= current.height) return;
    setCurrentColor(cellAt(current, x, y));
    tool.value = "brush";
  }

  /** 撤销一步：返回的脏下标照常刷 `lastDirty` / `revision` / `dirty`；无可撤销时什么都不做。 */
  function undo(): void {
    if (pattern.value === null) return;
    publishChange(history.value.undo(pattern.value.cells));
  }

  /** 重做一步。语义与 `undo` 对称。 */
  function redo(): void {
    if (pattern.value === null) return;
    publishChange(history.value.redo(pattern.value.cells));
  }

  function setShowGrid(next: boolean): void {
    showGrid.value = next;
  }

  function setShowLabels(next: boolean): void {
    showLabels.value = next;
  }

  function setSaving(next: boolean): void {
    saving.value = next;
  }

  /** 写保存失败的提示（`EditorPage` 的琥珀条读它）。纯 setter：不改图纸、不置脏。 */
  function setError(message: string): void {
    error.value = message;
  }

  /**
   * 撤销 / 重做**能不能点**——控制者裁决 R-4 新增的两个 computed。
   *
   * **为什么必须有它们，而不是让页面读 `editor.history.canUndo`**：`history` 是
   * `ref(markRaw(new EditHistory()))`，读那个类实例的 getter **不建立任何响应式依赖**——
   * 页面模板里写 `:can-undo="editor.history.canUndo"` 会在首次渲染时求值一次然后**永久缓存**，
   * 撤销按钮从此永远停在初始的 `false`（点了撤销、格子确实回退了，按钮却一直是灰的）。
   * 这是一个**不报错的界面错误**，只有真机点一下才看得出来。
   *
   * `void revision.value` 就是这个依赖：四个变更 `cells` 的动作、以及 `beginSession` / `reset`
   * 都会动 `revision`，所以历史栈一变，这两个 computed 一定失效重算。
   *
   * **为何公开**（`AGENTS.md`「公开 API ≠ 被使用的 API」）：任务 5 的 `PatternToolbar` 以
   * `canUndo` / `canRedo` 两个 prop 消费它们，任务 6 的 `EditorPage` 是唯一的取值点。
   */
  const canUndo = computed(() => {
    void revision.value;
    return history.value.canUndo;
  });

  const canRedo = computed(() => {
    void revision.value;
    return history.value.canRedo;
  });

  return {
    // 状态
    pattern,
    colorCount,
    revision,
    lastDirty,
    tool,
    currentColor,
    history,
    canUndo,
    canRedo,
    view,
    viewInitialized,
    showGrid,
    showLabels,
    saving,
    error,
    // 动作
    beginSession,
    reset,
    onViewport,
    setTool,
    setCurrentColor,
    setView,
    paint,
    applyRect,
    pickFromCell,
    undo,
    redo,
    setShowGrid,
    setShowLabels,
    setSaving,
    setError,
  };
});
