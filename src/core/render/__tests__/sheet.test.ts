import { describe, expect, it } from "vitest";
import type { Palette } from "../../palette/types";
import type { ColorUsage } from "../../pattern/stats";
import { EMPTY, type Pattern } from "../../pattern/types";
import {
  PRINT_MARGIN_MM,
  SHEET_MAJOR_GUIDE_STROKE,
  SHEET_MARGIN,
  SHEET_MIN_LABEL_FONT_PX,
  SHEET_RULER_LEFT,
  cellBox,
  labelInk,
  mmToPx,
  planBoardPage,
  planSheet,
  rgbCss,
  type BoardPagePlan,
  type SheetPlan,
  type TileGeometry,
} from "../layout";
import { drawBoardPage, drawSheet, type SheetMeta } from "../sheet";
import { createMockTarget, type MockCalls, type PathOp } from "./helpers";

/**
 * 夹具：6×6、33 个实心格、3 个空格（(2,0) / (4,2) / (4,5)）、4 种颜色。
 * 颜色刻意含**纯白与纯黑**：格内色号的墨色（`labelInk`）只有这两端能被无歧义断言。
 */
const CELLS_6X6: readonly number[] = [
  0, 0, EMPTY, 0, 0, 0,
  0, 1, 1, 1, 1, 1,
  2, 0, 0, 0, EMPTY, 0,
  0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, EMPTY, 3,
];

/**
 * 工程名（C8 §7.3 起 `planSheet` / `planBoardPage` **必须**收它：标题字号由「名字有多宽」决定）。
 *
 * 计划与渲染器拿到的是**同一个名字**（`makeMeta` 默认用它）——图上的标题文案与计划据以排版的名字
 * 不同源时，那是一条看不出来的静默偏差。
 */
const PROJECT_NAME = "测试工程";

function makePalette(): Palette {
  return {
    id: "test-palette",
    name: "测试色卡",
    source: "test",
    accuracy: "屏幕色仅供参考，以实物为准",
    colors: [
      { code: "A1", name: "白", rgb: [255, 255, 255] },
      { code: "A2", name: "黑", rgb: [0, 0, 0] },
      { code: "A3", name: "红", rgb: [255, 0, 0] },
      { code: "A4", name: "浅灰", rgb: [200, 200, 210] },
    ],
  };
}

function makePattern(width: number, height: number, values?: readonly number[]): Pattern {
  const cells = new Uint16Array(width * height);
  if (values !== undefined) cells.set(values);
  return { width, height, paletteId: "test-palette", cells };
}

function makeMeta(overrides: Partial<SheetMeta> = {}): SheetMeta {
  return {
    projectName: PROJECT_NAME,
    totalBeads: 33,
    colorCount: 4,
    ...overrides,
  };
}

/**
 * 只取落在 `plan.grid` **内部**的文字。
 *
 * **这条过滤是必须的，不是洁癖**：标题行 / 四边刻度带 / 用料条都在网格之外写字，
 * `expect(calls.texts).toEqual([])` 这种写法永远是假绿——它根本没读到「格区域内到底有没有色号」
 * 这条真正要守的性质。渲染器用例里任何关于「格内色号」的断言都必须经过本函数。
 *
 * 入参只要求 `TileGeometry`（= 网格几何 + 本片格范围）：单张计划与打印页计划都满足它。
 */
function textsInGrid(calls: MockCalls, tile: TileGeometry): MockCalls["texts"] {
  return calls.texts.filter(
    (text) =>
      text.x > tile.grid.x &&
      text.x < tile.grid.x + tile.grid.width &&
      text.y > tile.grid.y &&
      text.y < tile.grid.y + tile.grid.height,
  );
}

/** 找某个 (x, y) 处的填充调用（色块断言用：坐标取自计划，颜色取自色卡）。 */
function fillAt(calls: MockCalls, x: number, y: number) {
  return calls.fills.find((fill) => fill.x === x && fill.y === y);
}

/** 按色号表造一张色卡（打印页用例要把用料条的色号查回 rgb，所以色卡必须含这些色号）。 */
function makePaletteOf(codes: readonly string[]): Palette {
  return {
    id: "test-palette",
    name: "测试色卡",
    source: "test",
    accuracy: "屏幕色仅供参考，以实物为准",
    colors: codes.map((code, index) => ({
      code,
      name: `色 ${index + 1}`,
      rgb: [index * 10, index * 5, 0] as const,
    })),
  };
}

/**
 * 33 个实心格的用量（26 + 5 + 1 + 1 = 33），与 `CELLS_6X6` 的用色一一对应（下标顺序 = 色卡下标顺序，
 * 所以第 i 项的色块真色就是 `palette.colors[i]`）。**计数独立数一遍**，不与被测实现同源。
 *
 * `layout.test.ts` 里有一个同名同值的夹具；两个测试文件不共享私有夹具，故这里照抄一份。
 */
function makeUsages(): ColorUsage[] {
  return [
    { code: "A1", name: "白", count: 26 },
    { code: "A2", name: "黑", count: 5 },
    { code: "A3", name: "红", count: 1 },
    { code: "A4", name: "浅灰", count: 1 },
  ];
}

describe("drawSheet（B6：单张 + 底部用料条）", () => {
  it("网格内每颗实心格都画了色号（33 颗实心格 ⇒ 33 条格内文字）", () => {
    const pattern = makePattern(6, 6, CELLS_6X6);
    const plan = planSheet(pattern, makePalette(), makeUsages(), PROJECT_NAME);
    const { target, calls } = createMockTarget();
    drawSheet(target, pattern, makePalette(), makeUsages(), plan, makeMeta());
    expect(textsInGrid(calls, plan)).toHaveLength(33);
  });

  it("用料条画在网格下沿：每项一个色块 + 色号 + 数量，且数量右对齐", () => {
    const pattern = makePattern(6, 6, CELLS_6X6);
    const palette = makePalette();
    const usages = makeUsages();
    const plan = planSheet(pattern, palette, usages, PROJECT_NAME);
    const { target, calls } = createMockTarget();
    drawSheet(target, pattern, palette, usages, plan, makeMeta());

    // **左沿取自 `plan.legend.left`，不写 `SHEET_MARGIN`**：渲染器读的是计划给的字段，
    // 断言里写死常量的话，把渲染器改成「自己用 SHEET_MARGIN」也照样绿（打印页的 `left` 不是 SHEET_MARGIN）。
    // C7 起 `left` 是「网格左沿 + 条带在网格宽内居中」算出来的，所以不再等于 `SHEET_MARGIN`——
    // 判据改成「条带右沿不越过画布」与「左沿 ≥ 网格左沿」。
    expect(plan.legend.left).toBeGreaterThanOrEqual(plan.grid.x);
    expect(plan.legend.left + plan.legend.itemCols * plan.legend.itemWidth).toBeLessThanOrEqual(
      plan.canvasWidth,
    );
    // 色块：每个色号一颗 `plan.legend.swatchSize` 的方块，y = 带内该行的中线 − 半个色块
    for (let i = 0; i < usages.length; i += 1) {
      const col = i % plan.legend.itemCols;
      const row = Math.floor(i / plan.legend.itemCols);
      const centerY = plan.legend.top + row * plan.legend.rowHeight + plan.legend.rowHeight / 2;
      const swatch = fillAt(calls, plan.legend.left + col * plan.legend.itemWidth, centerY - plan.legend.swatchSize / 2);
      expect(swatch?.w).toBe(plan.legend.swatchSize);
      expect(swatch?.fillStyle).toBe(rgbCss(palette.colors[i]!.rgb));
    }
    // 色号与数量（标题承诺的两样）合成**一条**文本：`A1 (26)`，左对齐在项内偏移处。
    // （C7 起色号与颗数不再分列排布：120px 项宽里分列会把两者挤到一起。）
    const firstCenterY = plan.legend.top + plan.legend.rowHeight / 2;
    const first = calls.texts.find((text) => text.y === firstCenterY && text.x === plan.legend.left + plan.legend.codeX);
    expect(first?.text).toBe(`${usages[0]?.code} (${usages[0]?.count})`);
    expect(first?.textAlign).toBe("left");
  });

  it("图上不再有末行三行（合计 / 精度声明 / 生成时间）：C7 把它们整块删掉，声明搬到 UI", () => {
    const pattern = makePattern(6, 6, CELLS_6X6);
    const usages = makeUsages();
    const plan = planSheet(pattern, makePalette(), usages, PROJECT_NAME);
    const { target, calls } = createMockTarget();
    drawSheet(target, pattern, makePalette(), usages, plan, makeMeta());

    const all = calls.texts.map((text) => text.text).join("\n");
    expect(all).not.toContain("屏幕色仅供参考");
    expect(all).not.toContain("生成时间");
    expect(all).not.toContain("合计");
    // 网格之下只剩用料条（每项一条 `色号 (颗数)`）：底部刻度带的数字也在网格下沿之下，
    // 所以判据按**文本形状**收窄到用料条那一条。
    const bandBottom = plan.legend.top + plan.legend.itemRows * plan.legend.rowHeight;
    const band = calls.texts.filter((text) => text.y >= plan.legend.top && text.y < bandBottom);
    expect(band).toHaveLength(usages.length);
    for (const text of band) expect(text.text).toMatch(/^A\d+ \(\d+\)$/);
  });

  it("save / restore 配平（不配平会泄漏 target 的全局状态）", () => {
    const pattern = makePattern(6, 6, CELLS_6X6);
    const usages = makeUsages();
    const plan = planSheet(pattern, makePalette(), usages, PROJECT_NAME);
    const { target, calls } = createMockTarget();
    drawSheet(target, pattern, makePalette(), usages, plan, makeMeta());
    expect(calls.saves).toBe(calls.restores);
  });

  it("usages 与 plan 不同源（用料条行数对不上）即抛，且不留下半张图（写在任何写操作之前）", () => {
    // `LegendBandPlan.itemRows` 是计划用来扣高度预算的字段，而渲染器只按 `itemCols` 排布、
    // **不读 `itemRows`** ⇒ 配错不会报错，只会让用料条压到页脚上 / 越出 `canvasHeight`，
    // 画出一张看起来正常的残缺图（打印页的 `drawBoardPage` 有同一条守卫）。
    const pattern = makePattern(6, 6, CELLS_6X6);
    const codes = Array.from({ length: 21 }, (_, index) => `B${index + 1}`);
    const manyPalette = makePaletteOf(codes);
    const many: ColorUsage[] = codes.map((code, index) => ({
      code,
      name: `色 ${index + 1}`,
      count: index + 1,
    }));
    const manyPlan = planSheet(pattern, manyPalette, many, PROJECT_NAME);
    // 前提（**用公式算出来的字面量，不是把 plan 的字段抄回来**）：6×6 的网格宽 384px、格像素 96
    // ⇒ 用料字号 35、项宽 299 ⇒ 列数 floor(384 / 299) = 1 ⇒ 21 项要 21 行（行数 > 1，下面那条同源守卫才可判）
    expect(manyPlan.legend.itemCols).toBe(1);
    expect(manyPlan.legend.itemRows).toBe(21);
    // C7 起 `left` = 网格左沿 + 条带在网格宽内居中（不再等于 `SHEET_MARGIN`）
    expect(manyPlan.legend.left).toBeGreaterThanOrEqual(manyPlan.grid.x);

    const { target, calls } = createMockTarget();
    expect(() =>
      drawSheet(target, pattern, manyPalette, many.slice(0, 4), manyPlan, makeMeta()),
    ).toThrow(/用料条与本图不符：计划 \d+ 行、按 4 项应为 \d+ 行/);
    expect(calls.fills).toEqual([]);
  });

  it("非数组 usages 与不在色卡里的色号都在**填白之前**抛（渲染末段才炸会留下一整张网格）", () => {
    const pattern = makePattern(6, 6, CELLS_6X6);
    const palette = makePalette();
    const plan = planSheet(pattern, palette, makeUsages(), PROJECT_NAME);

    const { target, calls } = createMockTarget();
    expect(() =>
      drawSheet(
        target,
        pattern,
        palette,
        "not-an-array" as unknown as readonly ColorUsage[],
        plan,
        makeMeta(),
      ),
    ).toThrow("用量表必须是数组（当前 string）");
    expect(calls.fills).toEqual([]);

    // 坏色号在**第二项**：校验若发生在动笔之后，画布上会先出现底 + 33 个色块（这正是修复前的形态）
    const stranger: ColorUsage[] = [
      { code: "A1", name: "白", count: 1 },
      { code: "Z9", name: "不在色卡", count: 2 },
    ];
    expect(() => drawSheet(target, pattern, palette, stranger, plan, makeMeta())).toThrow(
      "用量表里的色号不在色卡里：Z9",
    );
    expect(calls.fills).toEqual([]);
  });
});

/**
 * `drawSheet` 的**共用步骤函数**回补覆盖（2026-10-08）。
 *
 * 任务 11 按「`sheet.test.ts` 只保留任务 6/9 两组」删掉旧用例时，有一部分守的是**仍然存活**的行为
 * （`paintCells` / `drawGridLines` / `drawRulers` / `drawBoardLabels` / `drawLegendBand` 都没删），
 * 判别力不该跟着用例一起消失。这里以 `drawSheet` 为对象逐类补回（夹具沿用上面的 6×6：33 实心格 /
 * 3 空格 / 4 色）。
 *
 * **判据是「对已删用例所守的行为有等价判别力」**，不是「加了几条」：把 `sheet.ts` 对应的那一步改坏，
 * 下面每一条都会变红（其中至少 3 条做过变异实测，见 `task-15b-report.md`）。⑤ 的 `save` / `restore`
 * 配平由上面那条保留用例守着，不重复。
 */
describe("drawSheet 的共用步骤函数（回补覆盖）", () => {
  /** `CELLS_6X6` 里三个空格的格坐标（顺序无关，下面只用集合语义）。 */
  const EMPTY_CELLS: readonly (readonly [number, number])[] = [
    [2, 0],
    [4, 2],
    [4, 5],
  ];

  /** 3×3 之外的实心格坐标 → 期望的色号与墨色（两端的墨色是**字面量**，不靠 `labelInk` 自证）。 */
  const LABEL_CASES: readonly {
    readonly col: number;
    readonly row: number;
    readonly code: string;
    readonly ink: string;
  }[] = [
    { col: 0, row: 0, code: "A1", ink: "rgb(0, 0, 0)" }, // A1 白 → 黑字
    { col: 1, row: 1, code: "A2", ink: "rgb(255, 255, 255)" }, // A2 黑 → 白字
    { col: 0, row: 2, code: "A3", ink: "rgb(0, 0, 0)" }, // A3 红（L* ≈ 53）
    { col: 5, row: 5, code: "A4", ink: "rgb(0, 0, 0)" }, // A4 浅灰（L* ≈ 80）
  ];

  /** 某一档网格线**逐位落位**的期望操作序列（坐标全部取自 plan，期望值这边不写算术）。 */
  function gridOps(plan: SheetPlan, kind: "thin" | "major" | "board"): PathOp[] {
    const ops: PathOp[] = [];
    for (const line of plan.vLines.filter((line) => line.kind === kind)) {
      ops.push({ op: "moveTo", x: line.at, y: plan.grid.y });
      ops.push({ op: "lineTo", x: line.at, y: plan.grid.y + plan.grid.height });
    }
    for (const line of plan.hLines.filter((line) => line.kind === kind)) {
      ops.push({ op: "moveTo", x: plan.grid.x, y: line.at });
      ops.push({ op: "lineTo", x: plan.grid.x + plan.grid.width, y: line.at });
    }
    ops.push({ op: "stroke" });
    return ops;
  }

  /** 跑一次 `drawSheet`（6×6 夹具 + 4 色色卡），返回目标桩的调用记录与那份计划。 */
  function drawFixture(): { readonly calls: MockCalls; readonly plan: SheetPlan } {
    const pattern = makePattern(6, 6, CELLS_6X6);
    const palette = makePalette();
    const usages = makeUsages();
    const plan = planSheet(pattern, palette, usages, PROJECT_NAME);
    const { target, calls } = createMockTarget();
    drawSheet(target, pattern, palette, usages, plan, makeMeta());
    return { calls, plan };
  }

  it("① 空格斜线：三个空格各一条左上→右下的对角线，收集在一条路径里、只 stroke 一次", () => {
    const { calls, plan } = drawFixture();
    // 斜线路径 = 恰好 3 对 moveTo/lineTo（网格三档的线数是 10 / 2 / 2 个 moveTo，不会撞上这个形状）
    const diagonal = calls.paths.filter(
      (path) => path.ops.filter((op) => op.op === "moveTo").length === EMPTY_CELLS.length,
    );
    expect(diagonal).toHaveLength(1);
    const ops = diagonal[0]?.ops ?? [];
    // **只 stroke 一次**：三条斜线共用一条路径（逐格 beginPath/stroke 会让这里数到 3）
    expect(ops.filter((op) => op.op === "stroke")).toHaveLength(1);
    expect(ops).toHaveLength(EMPTY_CELLS.length * 2 + 1);
    for (const [col, row] of EMPTY_CELLS) {
      const box = cellBox(plan, col, row);
      expect(ops).toContainEqual({ op: "moveTo", x: box.x, y: box.y });
      expect(ops).toContainEqual({ op: "lineTo", x: box.x + box.width, y: box.y + box.height });
    }
  });

  it("② 网格线：逐位落位取自 plan 的 vLines/hLines，细线与板边界各画一次（每 5 格改用橙色虚线）", () => {
    const pattern = makePattern(6, 6, CELLS_6X6);
    const plan = planSheet(pattern, makePalette(), makeUsages(), PROJECT_NAME);
    const { target, calls } = createMockTarget();
    drawSheet(target, pattern, makePalette(), makeUsages(), plan, makeMeta());

    // 路径顺序 = 空格斜线 → 细线 → 板边界 → 每 5 格虚线 → 外框（C7 起每 5 格不是加粗实线）。
    // **按内容找路径**（不按固定下标）：刻度带的分隔线也是 lineWidth 1，按下标找会抓错。
    const expectedThin = gridOps(plan, "thin");
    const expectedBoard = gridOps(plan, "board");
    const thin = calls.paths.find((path) => JSON.stringify(path.ops) === JSON.stringify(expectedThin));
    const board = calls.paths.find((path) => JSON.stringify(path.ops) === JSON.stringify(expectedBoard));
    expect(thin).toBeDefined();
    expect(board).toBeDefined();
    expect(thin?.lineWidth).toBe(1);
    expect(board?.lineWidth).toBe(3);
    // **板边界优先于 5 格主刻度**（0 处两者重叠）：那一条只能算板边界
    expect(plan.vLines[0]).toEqual({ at: plan.grid.x, kind: "board" });
    expect(plan.vLines.filter((line) => line.kind === "major").map((line) => line.at)).not.toContain(
      plan.grid.x,
    );
  });

  it("③ 每 5 格画橙色虚线：颜色与线宽逐位来自常量，且每个 5 的倍数各一条路径", () => {
    const pattern = makePattern(6, 6, CELLS_6X6);
    const plan = planSheet(pattern, makePalette(), makeUsages(), PROJECT_NAME);
    const { target, calls } = createMockTarget();
    drawSheet(target, pattern, makePalette(), makeUsages(), plan, makeMeta());

    const guides = calls.paths.filter((path) => path.strokeStyle === SHEET_MAJOR_GUIDE_STROKE);
    // 网格 6×6、原点 0 ⇒ 每轴各一条（只有 index 5，跳过 0）：竖直 + 水平 = 2
    const vertical = guides.filter((path) => {
      const move = path.ops.find((op) => op.op === "moveTo");
      const line = path.ops.find((op) => op.op === "lineTo");
      return move !== undefined && line !== undefined && move.x === line.x;
    });
    expect(guides).toHaveLength(2);
    expect(vertical).toHaveLength(1);
    for (const guide of guides) expect(guide.lineWidth).toBe(2);
    // 划长 18 / 周期 30：网格高 = 6 × cellPx ⇒ ceil(网格高 / 30) 段
    const moves = vertical[0]?.ops.filter((op) => op.op === "moveTo") ?? [];
    expect(moves).toHaveLength(Math.ceil((6 * plan.cellPx) / 30));
  });

  it("④ `strayOps` 为空：每条路径都以 `beginPath` 开头", () => {
    const { calls } = drawFixture();
    // 桩在 `stroke()` 之后复位 `hasPath`，所以**每一组**漏写 `beginPath` 都会被记下来
    expect(calls.strayOps).toEqual([]);
    // 前提：这条路径真的画过东西（一条路径都没有时上面那句恒真）
    expect(calls.paths.length).toBeGreaterThanOrEqual(4);
  });

  it("⑥ 格内色块：坐标取自 `cellBox`、颜色取自色卡（背景白与邻近格都不许串色）", () => {
    const pattern = makePattern(6, 6, CELLS_6X6);
    const palette = makePalette();
    const plan = planSheet(pattern, palette, makeUsages(), PROJECT_NAME);
    const { target, calls } = createMockTarget();
    drawSheet(target, pattern, palette, makeUsages(), plan, makeMeta());

    // 三种不同的真色、三个不同的落位：(0,0) 白、(1,1) 黑、(0,2) 红
    const cases = [
      { col: 0, row: 0, index: 0 },
      { col: 1, row: 1, index: 1 },
      { col: 0, row: 2, index: 2 },
    ];
    for (const item of cases) {
      const box = cellBox(plan, item.col, item.row);
      const fill = fillAt(calls, box.x, box.y);
      expect(fill?.fillStyle).toBe(rgbCss(palette.colors[item.index]?.rgb ?? [0, 0, 0]));
      expect([fill?.w, fill?.h]).toEqual([box.width, box.height]);
    }
    // 格内色块**不描边**（格线统一在第 5 步画）：`strokeRect` 只属于用料条色块
    expect(calls.strokeRects).toHaveLength(makeUsages().length);
    expect(
      calls.strokeRects.every(
        (rect) => rect.w === plan.legend.swatchSize && rect.h === plan.legend.swatchSize,
      ),
    ).toBe(true);
  });

  it("⑦ 格内色号：字号取 `labelFontPx`、墨色取 `labelInk`、位置取 `cellBox` 中心", () => {
    const pattern = makePattern(6, 6, CELLS_6X6);
    const palette = makePalette();
    const plan = planSheet(pattern, palette, makeUsages(), PROJECT_NAME);
    const { target, calls } = createMockTarget();
    drawSheet(target, pattern, palette, makeUsages(), plan, makeMeta());

    // 前提：格内字号与标题行（0.5 × 格像素 ⇒ 48）/ 刻度（0.42 × 格像素 ⇒ 30）都不同——靠继承前一处
    // 的 font 会在这里红。**用料条字号不能当反面判据**：C8 起它与格内色号同一比例（0.36），
    // 6×6 夹具下两者恰好同为 35px（这是规格定的口径，不是巧合可以拿来判别的东西）。
    expect(plan.labelFontPx).toBe(Math.round(plan.cellPx * 0.36));
    expect([plan.titleFontPx, plan.ruler.fontPx]).not.toContain(plan.labelFontPx);
    for (const item of LABEL_CASES) {
      const box = cellBox(plan, item.col, item.row);
      const label = calls.texts.find(
        (text) => text.x === box.x + box.width / 2 && text.y === box.y + box.height / 2,
      );
      expect(label?.text).toBe(item.code);
      expect(label).toMatchObject({
        font: `${plan.labelFontPx}px sans-serif`,
        fillStyle: item.ink,
        textAlign: "center",
        textBaseline: "middle",
      });
    }
    // 两端墨色**确实不同**（相同的话「墨色取 labelInk」这条断言没有判别力）
    expect(labelInk(palette.colors[0]?.rgb ?? [0, 0, 0])).not.toBe(
      labelInk(palette.colors[1]?.rgb ?? [0, 0, 0]),
    );
  });

  it("⑧ 第一步：整张画布先填白（`fills[0]` 从 (0,0) 铺满 `canvasWidth` × `canvasHeight`）", () => {
    const pattern = makePattern(6, 6, CELLS_6X6);
    const plan = planSheet(pattern, makePalette(), makeUsages(), PROJECT_NAME);
    const { target, calls } = createMockTarget();
    drawSheet(target, pattern, makePalette(), makeUsages(), plan, makeMeta());

    expect(calls.fills[0]).toEqual({
      x: 0,
      y: 0,
      w: plan.canvasWidth,
      h: plan.canvasHeight,
      fillStyle: "#ffffff",
      smoothing: true,
    });
    // 前提：画布真的比网格大（否则「铺满画布」与「铺满网格」判不开）
    expect(plan.canvasWidth).toBeGreaterThan(plan.grid.x + plan.grid.width);
    expect(plan.canvasHeight).toBeGreaterThan(plan.grid.y + plan.grid.height);
  });

  it("⑨ 字号在小尺寸下仍然画满格内色号；低于下限则计划阶段就抛（不静默省略）", () => {
    const pattern = makePattern(6, 6, CELLS_6X6);
    const palette = makePalette();
    const usages = makeUsages();
    // 夹具里含一个「色号很小但仍可读」的尺寸（规格 §14 的要求）：`maxEdge = 500` 时每格 32px、
    // 字号 12px。旧口径的降级链会在这一档判「不画色号」；用例钉住「色号恒画」。
    // （C8 修复后这个尺寸是 500：上限 400 时**量出来的**最大可行格像素只剩 25、字号 9px ⇒ 已低于
    //   下限；而上限 500 下 32 是量出来的最大可行值 —— 33 时画布高 501 > 500，差 1px。）
    const plan = planSheet(pattern, palette, usages, PROJECT_NAME, { maxEdge: 500 });
    expect(plan.cellPx).toBe(32);
    expect(plan.labelFontPx).toBe(12);
    expect(plan.labelFontPx).toBeGreaterThanOrEqual(SHEET_MIN_LABEL_FONT_PX);

    const { target, calls } = createMockTarget();
    drawSheet(target, pattern, palette, usages, plan, makeMeta());
    // 实心格数**独立数一遍**（36 − 3 个空格），不与渲染器的自报数同源
    const solidCount = CELLS_6X6.filter((value) => value !== EMPTY).length;
    expect(solidCount).toBe(33);
    expect(textsInGrid(calls, plan)).toHaveLength(solidCount);

    // 再小就**响亮失败**（而不是画一张看不清的图）：同一个夹具把上限压到 450 ⇒ 每格 26px、字号 9px
    expect(() => planSheet(pattern, palette, usages, PROJECT_NAME, { maxEdge: 450 })).toThrow(
      /低于下限 10 px/,
    );
  });
});

describe("drawBoardPage（B6：每块板一页）", () => {
  it("页眉写出板大小、纸型、页码、本页格范围与「1 格 = X mm（实物的 Y%）」", () => {
    const pattern = makePattern(116, 116, undefined);
    const palette = makePalette();
    const usages = [{ code: "A1", name: "白", count: 10 }];
    const plan = planBoardPage(pattern, palette, usages, { boardSize: 58, paper: "a3", index: 0, projectName: PROJECT_NAME });
    const { target, calls } = createMockTarget();
    drawBoardPage(target, pattern, palette, usages, plan, makeMeta());
    const texts = calls.texts.map((t) => t.text);
    expect(texts.some((t) => t.includes("58") && t.includes("A3"))).toBe(true);
    expect(texts.some((t) => t.includes("第 1/4 块板"))).toBe(true);
    expect(texts.some((t) => t.includes("列 1–58") && t.includes("行 1–58"))).toBe(true);
    // 标题行里的实际毫米与缩放比是「无空格」写法（与实现逐字一致：`4.7mm`，不是 `4.7 mm`）；
    // C7 起 58+A3 的比率是 **92%**（左右刻度带各扣一条之后 cellPx = 54 / 59 = 0.9153）
    expect(texts.some((t) => /1 格 = 4\.6mm（实物的 92%）/.test(t))).toBe(true);
  });

  it("页身份按 index 分行列（index 1 ⇒ 第 1 行 第 2 列、本页列 30–58；行/列对调即红）", () => {
    // **为什么必须有这条**：上面那条只造 `index: 0`，而 0 的 `boardRow` 与 `boardCol` **都是 0** ⇒
    // 把页眉里的「第 N 行 第 M 列」两个取值写反也照样绿。这里用 index 1 把两者判开。
    const pattern = makePattern(116, 116, undefined);
    const palette = makePalette();
    const usages = [{ code: "A1", name: "白", count: 10 }];
    const plan = planBoardPage(pattern, palette, usages, { boardSize: 29, paper: "a4", index: 1, projectName: PROJECT_NAME });
    // 前提：116 格 + 29 板 ⇒ 每行 4 块板 ⇒ index 1 是第 1 行第 2 列，覆盖列 30–58
    expect(plan.boardRow).toBe(0);
    expect(plan.boardCol).toBe(1);
    expect(plan.originCol).toBe(29);
    expect(plan.originRow).toBe(0);

    const { target, calls } = createMockTarget();
    drawBoardPage(target, pattern, palette, usages, plan, makeMeta());
    const texts = calls.texts.map((t) => t.text);
    expect(texts.some((t) => t.includes("第 1 行 第 2 列"))).toBe(true);
    expect(texts.some((t) => t.includes("第 2/16 块板"))).toBe(true);
    // 本页格范围取的是**本页原点**（第 2 块板 ⇒ 列 30–58），不是 1–29
    expect(texts.some((t) => t.includes("列 30–58") && t.includes("行 1–29"))).toBe(true);
    // 顺带覆盖 `percent === 100` 那一支（上面那条是 93% 那支）：29 板 + A4 就是实物大小
    expect(texts.some((t) => t.includes("1 格 = 5.0mm（实物大小）"))).toBe(true);
  });

  it("用料条只画本页用到的色（传进来的 usages 就是本页那一份）", () => {
    const pattern = makePattern(58, 58);
    const palette = makePalette();
    const pageUsages = [{ code: "A2", name: "黑", count: 7 }];
    const plan = planBoardPage(pattern, palette, pageUsages, { boardSize: 29, paper: "a4", index: 0, projectName: PROJECT_NAME });
    const { target, calls } = createMockTarget();
    drawBoardPage(target, pattern, palette, pageUsages, plan, makeMeta());
    // 只取**用料条带内**的文字（C7 起网格之下只剩用料条，不再有页脚）
    const bandBottom = plan.legend.top + plan.legend.itemRows * plan.legend.rowHeight;
    const codes = calls.texts.filter((t) => t.y > plan.legend.top && t.y < bandBottom);
    expect(codes.map((t) => t.text)).toEqual(["A2 (7)"]);
  });

  it("标题行左沿 = 网格块左沿（C8 §7.4：三者对齐，不再贴可打印区左沿）", () => {
    const pattern = makePattern(58, 58);
    const palette = makePalette();
    const pageUsages = [{ code: "A2", name: "黑", count: 7 }];
    const plan = planBoardPage(pattern, palette, pageUsages, { boardSize: 29, paper: "a4", index: 0, projectName: PROJECT_NAME });
    // **前提：三种左沿真的互不相同**（相同的话，这条用例对「用 SHEET_MARGIN 或 marginPx」的变异
    // 没有判别力）：网格块左沿 363px（29 板 + A4 实测）、页边距 118px、`SHEET_MARGIN` 20px。
    expect(plan.titleLeft).toBe(plan.grid.x - SHEET_RULER_LEFT);
    expect(plan.titleLeft).toBe(363);
    expect(plan.titleLeft).toBeGreaterThan(mmToPx(PRINT_MARGIN_MM));
    expect(plan.titleLeft).toBeGreaterThan(SHEET_MARGIN);
    // 三者同一条左沿（第 8 项的全部内容）
    expect(plan.legend.left).toBe(plan.titleLeft);

    const { target, calls } = createMockTarget();
    drawBoardPage(target, pattern, palette, pageUsages, plan, makeMeta());

    // ① 全部文字——标题行 / 格内色号 / 刻度 / 用料条——的 x 都不得落进不可打印区。
    for (const text of calls.texts) {
      expect(text.x).toBeGreaterThanOrEqual(mmToPx(PRINT_MARGIN_MM));
    }

    // ② 标题行**恰好一条**，且落在 titleLeft（按 y 定位，不拿实现自己拼的字符串当期望值）
    const titleCalls = calls.texts.filter((text) => text.y === plan.titleY);
    expect(titleCalls).toHaveLength(1);
    expect(titleCalls[0]?.x).toBe(plan.titleLeft);
  });

  it("usages 与 plan 不同源（用料条行数对不上）即抛，且不留下半张图（写在任何写操作之前）", () => {
    // 与 `drawSheet` 的同源守卫同因：`LegendBandPlan.itemRows` 是计划用来扣高度预算的字段，而
    // `drawLegendBand` 只按 `itemCols` 排布、**不读 `itemRows`** ⇒ 配错不会报错，只会让用料条压到
    // 别的带上 / 越出 `canvasHeight`，画出一张看起来正常的残缺图。
    const pattern = makePattern(58, 58);
    const codes = Array.from({ length: 40 }, (_, index) => `B${index + 1}`);
    const palette = makePaletteOf(codes);
    const many = codes.map((code, index) => ({ code, name: `色 ${index + 1}`, count: index + 1 }));
    const manyPlan = planBoardPage(pattern, palette, many, { boardSize: 29, paper: "a4", index: 0, projectName: PROJECT_NAME });
    // 前提（**公式算出的字面量**）：换行宽 = 画布 2480 − 页边距 118 − 块左沿 363 = 1999px，
    // 用料字号 21 ⇒ 项宽 179 ⇒ 列数 floor(1999 / 179) = 11 ⇒ 40 项要 4 行
    expect(manyPlan.legend.itemCols).toBe(11);
    expect(manyPlan.legend.itemRows).toBe(4);

    const { target, calls } = createMockTarget();
    expect(() =>
      drawBoardPage(target, pattern, palette, many.slice(0, 4), manyPlan, makeMeta()),
    ).toThrow(/用料条与本图不符：计划 \d+ 行、按 4 项应为 \d+ 行/);
    expect(calls.fills).toEqual([]);
  });

  it("色号不在色卡里、usages 不是数组都在**填白之前**抛（渲染末段才炸会画掉一整块板）", () => {
    const pattern = makePattern(58, 58);
    const palette = makePalette();
    const one = [{ code: "A1", name: "白", count: 3 }];
    // 计划按 1 项造（11 列下是 1 行），所以下面两次调用的行数守卫都放行，抛的必然是那两条守卫本身
    const plan = planBoardPage(pattern, palette, one, { boardSize: 29, paper: "a4", index: 0, projectName: PROJECT_NAME });
    expect(plan.legend.itemRows).toBe(1);

    const { target, calls } = createMockTarget();
    expect(() =>
      drawBoardPage(target, pattern, palette, [{ code: "Z9", name: "不在色卡", count: 1 }], plan, makeMeta()),
    ).toThrow("用量表里的色号不在色卡里：Z9");
    expect(calls.fills).toEqual([]);

    // 非数组 `usages`：抛的必须是**数组守卫**的消息，而不是用料条同源校验的「按 N 项应为 M 行」。
    // 顺序反过来时，字符串的 `.length` 会让后者报出**失实的项数**（`"not-an-array".length === 12` ⇒
    // 「按 12 项应为 2 行」，可这里根本没有 12 项），`null` 更是直接 TypeError（读 `.length`）——
    // 所以色号 / 数组守卫必须排在同源校验**之前**（控制者 2026-10-08 裁决，与 `drawSheet` 的落地顺序同口径）。
    expect(() =>
      drawBoardPage(
        target,
        pattern,
        palette,
        "not-an-array" as unknown as readonly ColorUsage[],
        plan,
        makeMeta(),
      ),
    ).toThrow("用量表必须是数组（当前 string）");
    expect(calls.fills).toEqual([]);
  });

  it("save / restore 配平（规格 §14 把该不变量也列在打印页名下，此前只有 `drawSheet` 一条）", () => {
    const pattern = makePattern(58, 58);
    const palette = makePalette();
    const usages = [{ code: "A1", name: "白", count: 10 }];
    const plan = planBoardPage(pattern, palette, usages, { boardSize: 29, paper: "a4", index: 0, projectName: PROJECT_NAME });
    const { target, calls } = createMockTarget();
    drawBoardPage(target, pattern, palette, usages, plan, makeMeta());
    expect(calls.saves).toBe(calls.restores);
  });
});

/**
 * 入口守卫的**前两步**（契约 §4b 逐字列出的顺序：`kind` → 色卡一致性 → 色号 → 用料条同源 → 颗数）。
 *
 * **为什么单列一组**（2026-10-08 终审发现）：这两步此前**全仓零用例**——把 `drawSheet` /
 * `drawBoardPage` 里那四条 `if` 一起删掉，全套仍然绿。两个渲染器的守卫逐字相同，所以两个都断：
 * 只覆盖一个的话，另一个的守卫照旧可以被删掉而不红（第 2–4 步已各有用例，这组补上后五步都可判）。
 */
describe("入口守卫的前两步：kind 与色卡一致性", () => {
  it("`kind` 不匹配的伪计划 ⇒ 在任何写操作之前抛（期望值与实际值都逐字钉住）", () => {
    const pattern = makePattern(6, 6, CELLS_6X6);
    const palette = makePalette();
    const usages = makeUsages();
    const { target, calls } = createMockTarget();
    const fakeSheet = { ...planSheet(pattern, palette, usages, PROJECT_NAME), kind: "board-page" } as unknown as SheetPlan;
    expect(() => drawSheet(target, pattern, palette, usages, fakeSheet, makeMeta())).toThrow(
      "plan 的类型不匹配：期望 sheet，实际 board-page",
    );
    const fakeBoard = {
      ...planBoardPage(pattern, palette, usages, { boardSize: 29, paper: "a4", index: 0, projectName: PROJECT_NAME }),
      kind: "sheet",
    } as unknown as BoardPagePlan;
    expect(() => drawBoardPage(target, pattern, palette, usages, fakeBoard, makeMeta())).toThrow(
      "plan 的类型不匹配：期望 board-page，实际 sheet",
    );
    expect(calls.fills).toEqual([]);
  });

  it("色卡不一致（伪色卡只换了 id）⇒ 在任何写操作之前抛", () => {
    const pattern = makePattern(6, 6, CELLS_6X6);
    const palette = makePalette();
    const usages = makeUsages();
    const other: Palette = { ...palette, id: "other-palette" };
    const { target, calls } = createMockTarget();
    const message = "图纸的色卡是 test-palette，与传入的色卡 other-palette 不一致";
    const sheetPlan = planSheet(pattern, palette, usages, PROJECT_NAME);
    const boardPlan = planBoardPage(pattern, palette, usages, { boardSize: 29, paper: "a4", index: 0, projectName: PROJECT_NAME });
    expect(() => drawSheet(target, pattern, other, usages, sheetPlan, makeMeta())).toThrow(message);
    expect(() => drawBoardPage(target, pattern, other, usages, boardPlan, makeMeta())).toThrow(message);
    expect(calls.fills).toEqual([]);
  });
});

/**
 * C8 §7：两个字号都从计划里读（渲染器不再有「用料条 14px」这种私有常量）。
 *
 * **判据是「渲染器画的字号 == 计划给的字号」**：把 `sheet.ts` 里任一处的 `plan.*FontPx` 换回字面量
 * （22 / 14）都会在这里红。
 */
describe("C8：标题与用料条的字号随格像素", () => {
  /** 跑一次 `drawSheet`（6×6 夹具 + 4 色色卡），返回目标桩的调用记录与那份计划。 */
  function renderSheetFixture(options: {
    readonly projectName: string;
  }): { readonly calls: MockCalls; readonly plan: SheetPlan } {
    const pattern = makePattern(6, 6, CELLS_6X6);
    const palette = makePalette();
    const usages = makeUsages();
    const plan = planSheet(pattern, palette, usages, options.projectName);
    const { target, calls } = createMockTarget();
    drawSheet(target, pattern, palette, usages, plan, makeMeta({ projectName: options.projectName }));
    return { calls, plan };
  }

  it("用料条用计划给的字号画，不再是写死的 14px", () => {
    const { calls, plan } = renderSheetFixture({ projectName: "小猫" });
    const legendTexts = calls.texts.filter((text) => text.text.includes("("));
    expect(legendTexts.length).toBeGreaterThan(0);
    for (const text of legendTexts) {
      expect(text.font).toBe(`${plan.legend.fontPx}px sans-serif`);
    }
    // 前提：这个字号真的比旧常量（14）大（否则「不再是 14」这条判不开）
    expect(plan.legend.fontPx).toBeGreaterThan(14);
    expect(plan.legend.fontPx).toBe(Math.round(plan.cellPx * 0.36));
  });

  it("标题用计划给的字号画（48px，不再是 22px）", () => {
    const { calls, plan } = renderSheetFixture({ projectName: "小猫" });
    const title = calls.texts.find((text) => text.y === SHEET_MARGIN);
    expect(title?.font).toBe(`${plan.titleFontPx}px sans-serif`);
    expect(plan.titleFontPx).toBeGreaterThan(22);
    // 标题行只有一条（按 y 定位，不拿实现自己拼的字符串当期望值）
    expect(calls.texts.filter((text) => text.y === plan.titleY)).toHaveLength(1);
  });
});
