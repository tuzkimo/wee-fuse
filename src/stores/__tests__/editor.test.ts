import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { isReactive } from "vue";
import { toProjectDocument } from "@/core/project/file";
import type { ProjectParams } from "@/core/project/types";
import { EMPTY, type Pattern } from "@/core/pattern/types";
import { createMemoryProjectStore } from "@/services/memoryProjectStore";
import { getBuiltinPalette } from "@/services/palette";
import { setProjectStore, type ProjectMeta } from "@/services/projectStore";
import { useEditor, type EditorTool } from "@/stores/editor";
import { useProjectSession } from "@/stores/project";

/**
 * 编辑器 store 的用例。
 *
 * 这个文件要证明的三件**承重**的事，都不是「对象存在」那类恒真断言：
 *
 * 1. **`cells` 的原地变更确实改到了 `session.pattern` 那一份**（端到端用例），而 Vue 看不见它——
 *    所以刷新只能走 `revision` + `lastDirty`，两条都必须被断言读到（否则 store 可以「静默刷新失败」）。
 * 2. **`onViewport` 的两支有判别力**：第二次尺寸变化时缩放与偏移必须**逐字保持**，而夹取该生效时
 *    又必须真的生效（否则「什么都不做」也能过前一条）。
 * 3. **只有 `paint` / `applyRect` / `undo` / `redo` 会置脏**：切工具、改视图、开关网格线、吸管
 *    都不影响「内存与存储是否一致」。
 *
 * 夹具口径沿用 `project.test.ts` / `EditorPage.test.ts`：色卡用生产口径的 `getBuiltinPalette()`，
 * 端到端那条用 `toProjectDocument` 造一份色卡自洽的真记录再走 `session.load()`。
 */

const PALETTE = getBuiltinPalette();
/** 色卡**色数**（不是「实际用到的色数」）：`currentColor` 的取值上界就是它。 */
const COLOR_COUNT = PALETTE.colors.length;

/** 4×3 = 12 格。行优先，下标 = y * 4 + x。[0] 是 7 号色，其余空格。 */
const BASE: readonly number[] = [
  7, EMPTY, EMPTY, EMPTY,
  EMPTY, EMPTY, EMPTY, EMPTY,
  EMPTY, EMPTY, EMPTY, EMPTY,
];

/** 全空格：`beginSession` 的「图纸用到的第一个色号」那一支要拿它证明落到 0。 */
const ALL_EMPTY: readonly number[] = BASE.map(() => EMPTY);

function makePattern(cells: readonly number[] = BASE): Pattern {
  return { width: 4, height: 3, paletteId: PALETTE.id, cells: Uint16Array.from(cells) };
}

/** 40×30 的大图纸：适配比例落在 `MIN_CELL_PX`（24）之下，用来验 `onViewport` 的第一支。 */
function makeBigPattern(): Pattern {
  return { width: 40, height: 30, paletteId: PALETTE.id, cells: new Uint16Array(1200) };
}

/** 开一份会话（`currentColor` 会被播种成图纸里第一个用到的色号）。 */
function seedEditor(cells: readonly number[] = BASE) {
  const session = useProjectSession();
  const editor = useEditor();
  const pattern = makePattern(cells);
  editor.beginSession(pattern, COLOR_COUNT);
  return { editor, session, pattern };
}

beforeEach(() => {
  setActivePinia(createPinia());
});

describe("beginSession：会话播种", () => {
  it("currentColor 落在图纸用到的第一个色号（不是 0，也不是用得最多的那个）", () => {
    // 用得最多的是 9（3 格），行优先第一个非空格是 5。`patternStats().usages[0].code` 是「用得最多」，
    // 拿它当「第一个色」会在这里红。
    const { editor } = seedEditor([EMPTY, 5, 9, 9, 9, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY]);

    expect(editor.currentColor).toBe(5);
  });

  it("全为空格时 currentColor 落在 0（不是 EMPTY）", () => {
    const { editor } = seedEditor(ALL_EMPTY);

    expect(editor.currentColor).toBe(0);
  });

  it("清空历史（栈不跨会话：载入 / 重载 / 改参数重跑回来都走这条）", () => {
    const { editor } = seedEditor();
    editor.paint([1]);
    expect(editor.history.undoDepth).toBe(1);

    editor.beginSession(makePattern(), COLOR_COUNT);

    expect(editor.history.undoDepth).toBe(0);
    expect(editor.history.canUndo).toBe(false);
    expect(editor.history.canRedo).toBe(false);
  });

  it("canUndo / canRedo 跟着历史变：beginSession / reset 清空后必须回到 false", () => {
    // `history` 是 `ref(markRaw(new EditHistory()))`——读它的 getter **不建立响应式依赖**，
    // 页面直接写 `editor.history.canUndo` 会永久缓存第一次的值（撤销按钮一直是灰的，且不报错）。
    // 只断言初始的 `false` 抓不到这个 bug：必须**先读一次填上缓存、改历史、再读**才有判别力。
    const { editor } = seedEditor();
    expect(editor.canUndo).toBe(false);
    expect(editor.canRedo).toBe(false);

    editor.paint([1]);
    expect(editor.canUndo).toBe(true);
    editor.undo();
    expect(editor.canRedo).toBe(true);

    // beginSession 会 clear() 历史（revision 归 0 就是那个响应式来源）
    editor.beginSession(makePattern(), COLOR_COUNT);
    expect(editor.canUndo).toBe(false);
    expect(editor.canRedo).toBe(false);

    editor.paint([1]);
    editor.undo();
    expect(editor.canRedo).toBe(true);

    // reset 同样 clear() 历史
    editor.reset();
    expect(editor.canUndo).toBe(false);
    expect(editor.canRedo).toBe(false);
  });

  it("revision / lastDirty 归零、viewInitialized 置 false，且载入本身不算未保存", () => {
    const { editor, session } = seedEditor();
    editor.onViewport({ width: 800, height: 600 });
    expect(editor.viewInitialized).toBe(true);
    editor.paint([1]);
    expect(editor.revision).toBe(1);
    // 模拟「刚保存完」：Pinia setup store 上 `session.dirty.value = …` 是空写，绕过 setter 只能走 $patch
    // （环境事实 3）。
    session.$patch({ dirty: false });

    const next = makePattern();
    editor.beginSession(next, COLOR_COUNT);

    expect(editor.pattern).toBe(next);
    expect(editor.revision).toBe(0);
    expect(editor.lastDirty).toBeNull();
    expect(editor.viewInitialized).toBe(false);
    // 视图也必须回到占位值：只断言 `viewInitialized === false` 钉不住这行写入——下一次
    // `onViewport` 反正会重落默认缩放，于是「新会话沿用上一份的 view」在屏幕上**看不出来**
    // （删掉 `beginSession` 里那行 `view.value = placeholderView()` 时，45 条用例全绿）。
    expect(editor.view).toEqual({ scale: 1, offsetX: 0, offsetY: 0 });
    // 载入不是改动：`beginSession` 不调 `markDirty`，否则打开工程的瞬间就提示「未保存」
    expect(session.dirty).toBe(false);
  });

  it("上一份会话的编辑态与提示不留给新会话（工具 / 显示开关 / saving / error 回默认）", () => {
    const { editor } = seedEditor();
    editor.setTool("pick");
    editor.setShowGrid(false);
    editor.setShowLabels(false);
    editor.setSaving(true);
    editor.setError("保存失败");

    editor.beginSession(makePattern(), COLOR_COUNT);

    expect(editor.tool).toBe("brush");
    expect(editor.showGrid).toBe(true);
    expect(editor.showLabels).toBe(true);
    expect(editor.saving).toBe(false);
    expect(editor.error).toBe("");
  });

  it("非法图纸 / 非法色数在写操作之前抛中文错误，既有会话一个字段不动", () => {
    const { editor, pattern } = seedEditor();

    expect(() => editor.beginSession({ ...pattern, width: 0 }, COLOR_COUNT)).toThrow(/图纸宽度/);
    expect(() => editor.beginSession({ ...pattern, width: 2.5 }, COLOR_COUNT)).toThrow(/图纸宽度/);
    expect(() => editor.beginSession({ ...pattern, height: Number.NaN }, COLOR_COUNT)).toThrow(/图纸高度/);
    expect(() =>
      editor.beginSession({ ...pattern, cells: Uint16Array.from([7, EMPTY]) }, COLOR_COUNT),
    ).toThrow(/不一致/);
    expect(() => editor.beginSession(pattern, 0)).toThrow(/色数/);
    expect(() => editor.beginSession(pattern, 1.5)).toThrow(/色数/);
    expect(() => editor.beginSession(pattern, Number.NaN)).toThrow(/色数/);
    expect(() => editor.beginSession(pattern, "221" as unknown as number)).toThrow(/色数/);
    expect(() => editor.beginSession(pattern, EMPTY + 1)).toThrow(/色数/);

    // 校验在任何写操作之前：先前的九次抛错没有留下「新图纸 + 旧色数」这类半截态
    expect(editor.pattern).toBe(pattern);
    expect(editor.colorCount).toBe(COLOR_COUNT);

    // 上界 EMPTY 本身合法（色卡色数的定义域是 1..EMPTY，不是 1..EMPTY-1）
    expect(() => editor.beginSession(pattern, EMPTY)).not.toThrow();
    expect(editor.colorCount).toBe(EMPTY);
  });
});

describe("reset：把会话清回初始态", () => {
  it("13 个字段逐一回默认，且**不碰 session**（`dirty` 留给保存流程）", () => {
    // 简报的 43 条用例里 `reset` 一次都没被调用过——而它是 15 个动作之一、页面卸载 / 换工程时
    // 会走到。少了这条，「reset 漏清 viewInitialized」这类错误在屏幕上是「换工程后视图还是旧的」，
    // 不报错、只有真机看得出来。
    const { editor, session } = seedEditor();
    editor.onViewport({ width: 800, height: 600 });
    editor.paint([1]);
    editor.setTool("pick");
    editor.setView({ scale: 2, offsetX: 10, offsetY: 20 });
    editor.setShowGrid(false);
    editor.setShowLabels(false);
    editor.setSaving(true);
    editor.setError("保存失败");
    // 前置：确实有一份「非初始」的会话要清（否则下面全是对默认值的恒真断言）
    expect(editor.revision).toBe(1);
    expect(editor.lastDirty).toEqual([1]);
    expect(session.dirty).toBe(true);

    editor.reset();

    expect(editor.pattern).toBeNull();
    expect(editor.colorCount).toBe(0);
    expect(editor.revision).toBe(0);
    expect(editor.lastDirty).toBeNull();
    expect(editor.tool).toBe("brush");
    expect(editor.currentColor).toBe(0);
    expect(editor.history.undoDepth).toBe(0);
    expect(editor.history.canUndo).toBe(false);
    expect(editor.history.canRedo).toBe(false);
    expect(editor.view).toEqual({ scale: 1, offsetX: 0, offsetY: 0 });
    expect(editor.viewInitialized).toBe(false);
    expect(editor.showGrid).toBe(true);
    expect(editor.showLabels).toBe(true);
    expect(editor.saving).toBe(false);
    expect(editor.error).toBe("");
    // 与 `dirty` 的分工：`reset` 不清 `session`（会话的载入 / 清空由页面的顺序决定）
    expect(session.dirty).toBe(true);
  });
});

describe("onViewport：首次落默认缩放，其后只夹取（规格 §4.2）", () => {
  it("第一次量到尺寸落 defaultCellView：比例抬到 MIN_CELL_PX，偏移居中后过夹取", () => {
    const { editor, session } = seedEditor();
    editor.beginSession(makeBigPattern(), COLOR_COUNT);

    editor.onViewport({ width: 800, height: 600 });

    // 适配比例 = min(800/40, 600/30) = 20 < 24 ⇒ 抬到 24；偏移 (800-960)/2、(600-720)/2；
    // 40*24=960 > 800 与 30*24=720 > 600，夹取是空操作。
    expect(editor.view).toEqual({ scale: 24, offsetX: -80, offsetY: -60 });
    expect(editor.viewInitialized).toBe(true);
    // 视图不是图纸参数：不刷 revision / lastDirty，也不置脏
    expect(editor.revision).toBe(0);
    expect(editor.lastDirty).toBeNull();
    expect(session.dirty).toBe(false);
  });

  it("其后尺寸变化只夹取：夹取是空操作时，缩放与偏移逐字保持（不是重落默认缩放）", () => {
    const { editor } = seedEditor();
    editor.beginSession(makeBigPattern(), COLOR_COUNT);
    editor.onViewport({ width: 800, height: 600 });
    expect(editor.view).toEqual({ scale: 24, offsetX: -80, offsetY: -60 });

    // 860×640 下 960×720 的图仍大于视口、且旧偏移仍在合法区间内 ⇒ clampView 是空操作。
    // 丢掉 `viewInitialized`、再落一次 defaultCellView 会得到 { 24, -50, -40 }：这条断言必红。
    editor.onViewport({ width: 860, height: 640 });

    expect(editor.view).toEqual({ scale: 24, offsetX: -80, offsetY: -60 });
  });

  it("其后尺寸变化只夹取：缩放也必须保持（适配比例高于 MIN_CELL_PX 的那一支）", () => {
    const { editor } = seedEditor();
    editor.beginSession(makeBigPattern(), COLOR_COUNT);
    // 1000×750 恰好是图纸比例：适配 25 > 24，取 25，偏移 0、0
    editor.onViewport({ width: 1000, height: 750 });
    expect(editor.view).toEqual({ scale: 25, offsetX: 0, offsetY: 0 });

    editor.onViewport({ width: 600, height: 450 });

    // 重落默认缩放会得到 { 24, -180, -135 }（适配 15 被抬到 24）：比例与偏移两条都红。
    expect(editor.view).toEqual({ scale: 25, offsetX: 0, offsetY: 0 });
  });

  it("其后尺寸变化确实走了夹取（尺寸变大后图像重新居中，不是「什么都不做」）", () => {
    const { editor } = seedEditor();
    editor.beginSession(makeBigPattern(), COLOR_COUNT);
    editor.onViewport({ width: 800, height: 600 });

    editor.onViewport({ width: 2000, height: 1500 });

    // 960×720 的图小于新视口 ⇒ clampView 把它居中：(2000-960)/2、(1500-720)/2
    expect(editor.view).toEqual({ scale: 24, offsetX: 520, offsetY: 390 });
  });

  it("还没载入图纸时安静返回（`useCanvasSurface` 挂载期先 measure 一次是常态，规格 §12）", () => {
    const editor = useEditor();
    expect(editor.pattern).toBeNull();

    expect(() => editor.onViewport({ width: 800, height: 600 })).not.toThrow();

    expect(editor.viewInitialized).toBe(false);
    // 占位视图：第一次 measure 之前只存在一两帧，`viewInitialized === false` 时下游不该拿它当有效视图
    expect(editor.view).toEqual({ scale: 1, offsetX: 0, offsetY: 0 });
  });

  it("非法视口由 core 响亮拒绝，且不会置 viewInitialized / 不会改视图（校验在任何写操作之前）", () => {
    const { editor } = seedEditor();
    editor.beginSession(makeBigPattern(), COLOR_COUNT);

    expect(() => editor.onViewport({ width: 0, height: 600 })).toThrow(/视口宽度/);
    expect(editor.viewInitialized).toBe(false);
    expect(editor.view).toEqual({ scale: 1, offsetX: 0, offsetY: 0 });

    editor.onViewport({ width: 800, height: 600 });
    expect(() => editor.onViewport({ width: Number.NaN, height: 600 })).toThrow(/视口宽度/);
    expect(editor.view).toEqual({ scale: 24, offsetX: -80, offsetY: -60 });
  });
});

describe("工具 / 当前色 / 视图 / 显示开关", () => {
  it("setTool 写入非默认工具；非法工具抛错且不改状态", () => {
    const { editor } = seedEditor();
    expect(editor.tool).toBe("brush");

    editor.setTool("pick");
    expect(editor.tool).toBe("pick");

    expect(() => editor.setTool("erase" as unknown as EditorTool)).toThrow(/工具/);
    expect(editor.tool).toBe("pick");
  });

  it("setCurrentColor 接受 0..colorCount-1 与 EMPTY，拒绝越界 / 非整数 / NaN", () => {
    const { editor } = seedEditor();

    editor.setCurrentColor(COLOR_COUNT - 1);
    expect(editor.currentColor).toBe(COLOR_COUNT - 1);

    editor.setCurrentColor(EMPTY);
    expect(editor.currentColor).toBe(EMPTY);

    editor.setCurrentColor(3);
    expect(editor.currentColor).toBe(3);

    // `NaN < limit` 与 `NaN >= 0` 同时为假，只比较上下界拦不住它；`EMPTY + 1` 是另一个越界形态。
    expect(() => editor.setCurrentColor(COLOR_COUNT)).toThrow(/当前色号/);
    expect(() => editor.setCurrentColor(-1)).toThrow(/当前色号/);
    expect(() => editor.setCurrentColor(1.5)).toThrow(/当前色号/);
    expect(() => editor.setCurrentColor(Number.NaN)).toThrow(/当前色号/);
    expect(() => editor.setCurrentColor(EMPTY + 1)).toThrow(/当前色号/);
    expect(() => editor.setCurrentColor("3" as unknown as number)).toThrow(/当前色号/);

    // 校验在任何写操作之前
    expect(editor.currentColor).toBe(3);
  });

  it("还没载入图纸时 setCurrentColor / paint / applyRect / pickFromCell 响亮拒绝", () => {
    // 静默返回会把「页面忘了 beginSession」变成「点了没反应」——本项目点名要消灭的静默失败形态。
    const editor = useEditor();

    expect(() => editor.setCurrentColor(0)).toThrow(/还没有载入图纸/);
    expect(() => editor.paint([0])).toThrow(/还没有载入图纸/);
    expect(() => editor.applyRect({ x: 0, y: 0, width: 1, height: 1 })).toThrow(/还没有载入图纸/);
    expect(() => editor.pickFromCell(0, 0)).toThrow(/还没有载入图纸/);

    expect(editor.pattern).toBeNull();
    expect(editor.colorCount).toBe(0);
    expect(editor.history.undoDepth).toBe(0);
  });

  it("setView 只校验形状、不夹取（夹取需要视口，而状态面里没有视口字段）", () => {
    const { editor } = seedEditor();

    editor.setView({ scale: 0.5, offsetX: 9999, offsetY: -9999 });

    // 这个视图若被 clampView 夹过就不是这三个数了。画布发来的视图已由 `zoomCellView` / `panCellView`
    // 夹过（规格 §4.3 / §4.4）；这里再夹一次需要视口，而 store 不持有它。
    expect(editor.view).toEqual({ scale: 0.5, offsetX: 9999, offsetY: -9999 });
  });

  it("setView 拒绝非正比例与非有限偏移，且不改旧值", () => {
    const { editor } = seedEditor();
    editor.setView({ scale: 2, offsetX: 1, offsetY: 2 });

    expect(() => editor.setView({ scale: 0, offsetX: 0, offsetY: 0 })).toThrow(/视图比例/);
    expect(() => editor.setView({ scale: Number.NaN, offsetX: 0, offsetY: 0 })).toThrow(/视图比例/);
    expect(() => editor.setView({ scale: -1, offsetX: 0, offsetY: 0 })).toThrow(/视图比例/);
    expect(() =>
      editor.setView({ scale: 2, offsetX: Number.POSITIVE_INFINITY, offsetY: 0 }),
    ).toThrow(/视图偏移/);

    expect(editor.view).toEqual({ scale: 2, offsetX: 1, offsetY: 2 });
  });

  it("setShowGrid / setShowLabels / setSaving / setError 是纯 setter（写入非默认值、不动图纸）", () => {
    const { editor, session } = seedEditor();

    editor.setShowGrid(false);
    editor.setShowLabels(false);
    editor.setSaving(true);
    editor.setError("保存失败");

    expect(editor.showGrid).toBe(false);
    expect(editor.showLabels).toBe(false);
    expect(editor.saving).toBe(true);
    expect(editor.error).toBe("保存失败");
    expect(editor.revision).toBe(0);
    expect(editor.lastDirty).toBeNull();
    expect(session.dirty).toBe(false);
  });
});

describe("paint：一次手势一条命令（规格 §6.2）", () => {
  it("一次手势一条命令：同批多个下标只入栈一条，撤销一次整笔退回", () => {
    const { editor, pattern, session } = seedEditor();
    expect(editor.currentColor).toBe(7);

    editor.paint([4, 5, 6]);

    expect([...pattern.cells]).toEqual([
      7, EMPTY, EMPTY, EMPTY,
      7, 7, 7, EMPTY,
      EMPTY, EMPTY, EMPTY, EMPTY,
    ]);
    expect(editor.history.undoDepth).toBe(1);
    expect(session.dirty).toBe(true);

    editor.undo();

    expect([...pattern.cells]).toEqual([...BASE]);
  });

  it("同一批里的重复下标只入账一次（一条命令、lastDirty 去重）", () => {
    const { editor, pattern } = seedEditor();

    editor.paint([2, 2, 2]);

    expect(pattern.cells[2]).toBe(7);
    expect(editor.history.undoDepth).toBe(1);
    expect(editor.lastDirty).toEqual([2]);
  });

  it("整笔都是同色格时不产生命令：不入栈、不消耗撤销额度、revision / lastDirty / dirty 都不动", () => {
    const { editor, session } = seedEditor();
    // cells[0] 已经是当前色 7：`buildPaintCommand` 对它返回 null（点同色格不该看起来「撤销了一次」）
    expect(editor.currentColor).toBe(7);
    expect(session.dirty).toBe(false);

    editor.paint([0]);

    expect(editor.history.undoDepth).toBe(0);
    expect(editor.history.canUndo).toBe(false);
    expect(editor.revision).toBe(0);
    expect(editor.lastDirty).toBeNull();
    expect(session.dirty).toBe(false);
  });

  it("空下标数组什么都不做（手势落在图纸外时的正常输入）", () => {
    const { editor, session } = seedEditor();

    editor.paint([]);

    expect(editor.revision).toBe(0);
    expect(editor.lastDirty).toBeNull();
    expect(editor.history.undoDepth).toBe(0);
    expect(session.dirty).toBe(false);
  });

  it("空命令不清重做链（刚撤销完再划过一个同色格，重做不能凭空消失）", () => {
    const { editor } = seedEditor();
    editor.paint([1]);
    editor.undo();
    expect(editor.history.canRedo).toBe(true);
    const revisionAfterUndo = editor.revision;

    editor.paint([0]); // cells[0] 已是当前色 ⇒ 空命令

    expect(editor.history.canRedo).toBe(true);
    expect(editor.revision).toBe(revisionAfterUndo);
  });

  it("非数组的下标响亮拒绝（形态错误自己守）", () => {
    const { editor, session } = seedEditor();

    expect(() => editor.paint("1,2" as unknown as number[])).toThrow(/下标/);
    expect(() => editor.paint(null as unknown as number[])).toThrow(/下标/);
    expect(() => editor.paint(undefined as unknown as number[])).toThrow(/下标/);

    expect(editor.revision).toBe(0);
    expect(session.dirty).toBe(false);
  });

  it("非整数与越界下标交给 buildPaintCommand 的既有口径忽略，同批里的合法下标照常入账", () => {
    const { editor } = seedEditor();

    editor.paint([1.5, -1, 9999]);
    expect(editor.lastDirty).toBeNull();
    expect(editor.history.undoDepth).toBe(0);

    editor.paint([1.5, -1, 3]);
    expect(editor.lastDirty).toEqual([3]);
    expect(editor.history.undoDepth).toBe(1);
  });
});

describe("applyRect：框选一条命令（规格 §6.4）", () => {
  it("框选一条命令：区域内格子一次到位，lastDirty 是格子下标（行优先）", () => {
    const { editor, pattern, session } = seedEditor();

    editor.applyRect({ x: 1, y: 0, width: 2, height: 2 });

    // 下标 = y * 4 + x：第 0 行 1..2 → 1、2；第 1 行 1..2 → 5、6
    expect(editor.lastDirty).toEqual([1, 2, 5, 6]);
    expect([...pattern.cells]).toEqual([
      7, 7, 7, EMPTY,
      EMPTY, 7, 7, EMPTY,
      EMPTY, EMPTY, EMPTY, EMPTY,
    ]);
    expect(editor.history.undoDepth).toBe(1);
    expect(editor.revision).toBe(1);
    expect(session.dirty).toBe(true);
  });

  it("越界矩形被裁剪（core 的既有口径：框选经常拖出图纸边界，越界不是错误）", () => {
    const { editor, pattern } = seedEditor();

    editor.applyRect({ x: 3, y: 2, width: 10, height: 10 });

    expect(editor.lastDirty).toEqual([11]);
    expect(pattern.cells[11]).toBe(7);
  });

  it("当前色是 EMPTY 时等价于整块抠掉", () => {
    const { editor, pattern } = seedEditor([7, 7, 7, 7, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY]);
    editor.setCurrentColor(EMPTY);

    editor.applyRect({ x: 0, y: 0, width: 2, height: 1 });

    expect([...pattern.cells].slice(0, 2)).toEqual([EMPTY, EMPTY]);
    expect(editor.lastDirty).toEqual([0, 1]);
  });

  it("整块已是当前色时不产生命令（什么也不做）", () => {
    const { editor, pattern, session } = seedEditor();

    editor.applyRect({ x: 0, y: 0, width: 1, height: 1 }); // 只盖住 cells[0] = 7 = 当前色

    expect(editor.revision).toBe(0);
    expect(editor.lastDirty).toBeNull();
    expect(editor.history.undoDepth).toBe(0);
    expect(session.dirty).toBe(false);
    expect([...pattern.cells]).toEqual([...BASE]);
  });

  it("工具保持框选、当前色不变（用户常要连框几块）", () => {
    const { editor } = seedEditor();
    editor.setTool("select");
    editor.setCurrentColor(3);

    editor.applyRect({ x: 0, y: 0, width: 2, height: 2 });

    expect(editor.tool).toBe("select");
    expect(editor.currentColor).toBe(3);
  });

  it("非法矩形在写操作之前抛错（分量非有限 / 宽高 < 1）", () => {
    const { editor, pattern } = seedEditor();

    expect(() => editor.applyRect({ x: Number.NaN, y: 0, width: 1, height: 1 })).toThrow(/框选矩形 x/);
    expect(() =>
      editor.applyRect({ x: 0, y: Number.POSITIVE_INFINITY, width: 1, height: 1 }),
    ).toThrow(/框选矩形 y/);
    expect(() => editor.applyRect({ x: 0, y: 0, width: 0, height: 1 })).toThrow(/框选矩形宽度/);
    expect(() => editor.applyRect({ x: 0, y: 0, width: 1, height: Number.NaN })).toThrow(/框选矩形高度/);
    expect(() => editor.applyRect({ x: 0, y: 0, width: 1, height: -3 })).toThrow(/框选矩形高度/);

    expect(editor.revision).toBe(0);
    expect(editor.lastDirty).toBeNull();
    expect([...pattern.cells]).toEqual([...BASE]);
  });
});

describe("pickFromCell：吸管（规格 §6.5）", () => {
  it("吸到某格的色号并把工具切回画笔（吸完就能画）", () => {
    const { editor } = seedEditor([7, EMPTY, EMPTY, EMPTY, EMPTY, 3, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY, EMPTY]);
    editor.setTool("pick");

    editor.pickFromCell(1, 1); // 下标 = 1 * 4 + 1 = 5

    expect(editor.currentColor).toBe(3);
    expect(editor.tool).toBe("brush");
  });

  it("吸到空格时当前色是 EMPTY（橡皮）", () => {
    const { editor } = seedEditor();
    editor.setTool("pick");

    editor.pickFromCell(2, 0); // 下标 2 = EMPTY

    expect(editor.currentColor).toBe(EMPTY);
    expect(editor.tool).toBe("brush");
  });

  it("落在图纸外时不改当前色、也不切工具（`cellAt` 对越界返回 EMPTY，那不是「吸到了橡皮」）", () => {
    const { editor } = seedEditor();
    editor.setTool("pick");
    editor.setCurrentColor(5);

    editor.pickFromCell(-1, 0);
    editor.pickFromCell(0, 3);
    editor.pickFromCell(4, 0);

    expect(editor.currentColor).toBe(5);
    expect(editor.tool).toBe("pick");
  });

  it("非整数的格子坐标抛错（不许静默取整到相邻格）", () => {
    const { editor } = seedEditor();
    editor.setTool("pick");
    const before = editor.currentColor;

    expect(() => editor.pickFromCell(0.5, 0)).toThrow(/格子坐标/);
    expect(() => editor.pickFromCell(0, Number.NaN)).toThrow(/格子坐标/);

    expect(editor.currentColor).toBe(before);
    expect(editor.tool).toBe("pick");
  });

  it("格子里的色号越出色卡时响亮失败（不静默把非法色号设成当前色、再涂出另一个色号）", () => {
    const { editor, pattern } = seedEditor();
    // 先开一份**合法**会话，再让某一格变成越界色号：模拟坏数据（旧版本文件、被改坏的备份、
    // 将来的导入路径）。`beginSession` 的守卫不扫每个格子的值域——越界值在这里被挡住。
    pattern.cells[5] = EMPTY - 1;
    editor.setTool("pick");
    const before = editor.currentColor;

    expect(() => editor.pickFromCell(1, 1)).toThrow(/当前色号/);

    expect(editor.currentColor).toBe(before);
    expect(editor.tool).toBe("pick");
  });
});

describe("undo / redo（规格 §6.6）", () => {
  it("撤销返回脏下标：cells 逐格还原、lastDirty 刷新、revision 自增、仍是未保存", () => {
    const { editor, pattern, session } = seedEditor();
    editor.paint([4, 5, 6]);
    expect(editor.revision).toBe(1);
    expect(editor.lastDirty).toEqual([4, 5, 6]);

    editor.undo();

    expect([...pattern.cells]).toEqual([...BASE]);
    expect(editor.revision).toBe(2);
    expect(editor.lastDirty).toEqual([4, 5, 6]);
    expect(editor.history.canRedo).toBe(true);
    expect(session.dirty).toBe(true);
  });

  it("重做把命令再应用一遍，并把 lastDirty / revision 再刷一次", () => {
    const { editor, pattern, session } = seedEditor();
    editor.paint([4, 5, 6]);
    editor.undo();
    expect(editor.revision).toBe(2);

    editor.redo();

    expect([...pattern.cells]).toEqual([
      7, EMPTY, EMPTY, EMPTY,
      7, 7, 7, EMPTY,
      EMPTY, EMPTY, EMPTY, EMPTY,
    ]);
    expect(editor.revision).toBe(3);
    expect(editor.lastDirty).toEqual([4, 5, 6]);
    expect(editor.history.canRedo).toBe(false);
    expect(session.dirty).toBe(true);
  });

  it("无可撤销 / 无可重做时什么都不做", () => {
    const { editor, session } = seedEditor();
    expect(session.dirty).toBe(false);

    editor.undo();
    editor.redo();

    expect(editor.revision).toBe(0);
    expect(editor.lastDirty).toBeNull();
    expect(session.dirty).toBe(false);
    expect(editor.history.undoDepth).toBe(0);
    expect(editor.history.redoDepth).toBe(0);
  });

  it("撤销与重做各自都会重新置脏（保存之后撤销，又变回未保存）", () => {
    const { editor, session } = seedEditor();
    editor.paint([1]);
    // 模拟一次成功保存：绕过 setup store 的 setter 只能走 $patch（环境事实 3）
    session.$patch({ dirty: false });

    editor.undo();
    expect(session.dirty).toBe(true);

    session.$patch({ dirty: false });
    editor.redo();
    expect(session.dirty).toBe(true);
  });

  it("撤销后再涂一笔会清掉重做链（core 的既有语义，store 原样透传）", () => {
    const { editor } = seedEditor();
    editor.paint([1]);
    editor.undo();
    expect(editor.history.canRedo).toBe(true);

    editor.paint([2]);

    expect(editor.history.canRedo).toBe(false);
    expect(editor.history.undoDepth).toBe(1);
  });
});

describe("只有改 cells 的四个动作会置脏", () => {
  it("beginSession / setTool / setView / setShowGrid / setShowLabels / setCurrentColor / pickFromCell / onViewport 都不置脏", () => {
    const { editor, session } = seedEditor();

    editor.beginSession(makePattern(), COLOR_COUNT);
    editor.setTool("pick");
    editor.setView({ scale: 2, offsetX: 0, offsetY: 0 });
    editor.setShowGrid(false);
    editor.setShowLabels(false);
    editor.setCurrentColor(3);
    editor.pickFromCell(1, 0); // 空格 → EMPTY
    editor.onViewport({ width: 800, height: 600 });
    editor.setSaving(true);
    editor.setError("保存失败");

    expect(session.dirty).toBe(false);
    expect(editor.revision).toBe(0);
    expect(editor.lastDirty).toBeNull();
  });
});

describe("端到端：载入一份真记录 → 涂抹 → 撤销", () => {
  const RECORD_PARAMS: ProjectParams = {
    longSide: 4,
    maxColors: 16,
    crop: { x: 0, y: 0, w: 8, h: 8, rotate: 0 },
  };
  const RECORD_META: ProjectMeta = {
    id: "a",
    name: "小猫",
    createdAt: "2026-10-04T00:00:00.000Z",
    updatedAt: "2026-10-04T01:00:00.000Z",
    thumbnail: "",
    // 故意的错误值：`put` 必须从 doc 覆盖这三项（不影响本用例，只为对齐夹具口径）
    width: 999,
    height: 999,
    colorCount: 999,
  };

  it("编辑器与 session 共用同一份 cells：就地改、revision / lastDirty 是唯一刷新链", async () => {
    const store = await createMemoryProjectStore();
    await store.put({
      meta: RECORD_META,
      doc: toProjectDocument(makePattern(), PALETTE, RECORD_PARAMS),
      source: null,
    });
    setProjectStore(store);

    const session = useProjectSession();
    const editor = useEditor();
    await expect(session.load("a")).resolves.toBe(true);
    const pattern = session.pattern;
    if (pattern === null) throw new Error("夹具载入失败：session.pattern 为 null");
    expect(session.dirty).toBe(false);

    editor.beginSession(pattern, COLOR_COUNT);

    // 同一份对象、同一份 cells：两边各持一份拷贝就是「编辑器改了、保存写的是旧的」（规格 §7 要点 2）
    expect(editor.pattern).toBe(pattern);
    expect(editor.pattern?.cells).toBe(pattern.cells);
    // markRaw：TypedArray 的原地写 Vue 追不到，所以刷新只能走 revision（这里把「不代理」钉住）
    expect(isReactive(editor.pattern)).toBe(false);
    expect(editor.currentColor).toBe(7); // 行优先第一个非空格，夹具里是 7 号色
    expect(session.dirty).toBe(false); // 载入不是改动

    const before = [...pattern.cells];
    expect(before).toEqual([...BASE]);

    editor.paint([4, 5, 6]);

    // 从 session 那一侧读：改的确实是同一份 TypedArray，中间没有拷贝
    expect([...pattern.cells]).toEqual([
      7, EMPTY, EMPTY, EMPTY,
      7, 7, 7, EMPTY,
      EMPTY, EMPTY, EMPTY, EMPTY,
    ]);
    expect(editor.revision).toBe(1);
    expect(editor.lastDirty).toEqual([4, 5, 6]);
    expect(session.dirty).toBe(true);

    editor.undo();

    expect([...pattern.cells]).toEqual(before);
    expect(editor.revision).toBe(2);
    expect(editor.lastDirty).toEqual([4, 5, 6]);
    expect(session.dirty).toBe(true); // 撤销也是「内存与存储不一致」
  });
});
