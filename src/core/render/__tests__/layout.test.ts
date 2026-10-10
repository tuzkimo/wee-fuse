import { describe, expect, it } from "vitest";
import { BEAD_MM, BOARD_COLS, boardCount } from "../../pattern/board";
import type { ColorUsage } from "../../pattern/stats";
import { EMPTY, type Pattern } from "../../pattern/types";
import type { Palette } from "../../palette/types";
import {
  EXPORT_CELL_MAX_PX,
  EXPORT_MAX_EDGE,
  LEGEND_CODE_GAP_RATIO,
  LEGEND_FONT_MAX_PX,
  LEGEND_FONT_MIN_PX,
  LEGEND_FONT_RATIO,
  LEGEND_ITEM_PAD_RATIO,
  LEGEND_ITEM_SAMPLE,
  LEGEND_PAD_TOP,
  LEGEND_ROW_RATIO,
  LEGEND_SWATCH_RATIO,
  PAPER_MM,
  PRINT_BEAD_PX,
  PRINT_BOARD_SIZES,
  PRINT_DPI,
  PRINT_MARGIN_MM,
  SHEET_MARGIN,
  SHEET_MIN_LABEL_FONT_PX,
  SHEET_RULER_FONT_MIN_PX,
  SHEET_RULER_LEFT,
  SHEET_RULER_TOP,
  SHEET_TITLE_FIXED_EM,
  SHEET_TITLE_FONT_MAX_PX,
  SHEET_TITLE_FONT_MIN_PX,
  SHEET_TITLE_FONT_RATIO,
  SHEET_TITLE_GAP,
  SHEET_TITLE_LINE_RATIO,
  TEXT_WIDTH_SAFETY,
  TICK_EVERY,
  TILE_STEP,
  TITLE_FONT_HARD_MIN_PX,
  cellBox,
  countTileBeads,
  estimateTextWidthPx,
  labelInk,
  legendGeometry,
  mmToPx,
  planBoardPage,
  planSheet,
  printBoardCount,
  rgbCss,
} from "../layout";
/**
 * 布局只用 `palette.id` / 色号 / rgb；不需要真色卡（真色卡在 services 层，core 测试不许 import services）。
 */
function makePalette(count = 4): Palette {
  return {
    id: "test-palette",
    name: "测试色卡",
    source: "test",
    accuracy: "屏幕色仅供参考，以实物为准",
    colors: Array.from({ length: count }, (_, i) => ({
      code: `A${i + 1}`,
      name: `色 ${i + 1}`,
      rgb: [i * 20, i * 30, i * 40] as const,
    })),
  };
}

function makePattern(width: number, height: number, fill = 0): Pattern {
  const cells = new Uint16Array(width * height);
  cells.fill(fill);
  return { width, height, paletteId: "test-palette", cells };
}

/**
 * 工程名（C8 §7.3 起 `planSheet` / `planBoardPage` 都**必须**收它：标题字号由「名字有多宽」与格像素 /
 * 纸宽共同决定）。测试里用同一个名字，是为了让「29×25 ⇒ 标题 48px」这类读数有一个固定的名字宽度前提。
 */
const PROJECT_NAME = "测试工程";

describe("布局常量（B4 + B6 + C7 + C8）", () => {
  it("常量值就是规格定的那一组（改坏即红）", () => {
    expect(EXPORT_MAX_EDGE).toBe(4096);
    expect(EXPORT_CELL_MAX_PX).toBe(96);
    expect(TICK_EVERY).toBe(5);
    // C8 §7.5：用料条与标题的**像素常量全部删除**（`LEGEND_ROW_H` / `LEGEND_ITEM_W` /
    // `LEGEND_SWATCH_SIZE` / `LEGEND_CODE_X` / `LEGEND_COUNT_RIGHT_PAD` / `SHEET_TITLE_H` /
    // `SHEET_TITLE_FONT_PX`），改成下面这一组比例值 —— 它们就是新的契约。
    expect(SHEET_TITLE_FONT_RATIO).toBe(0.5);
    expect(SHEET_TITLE_FONT_MIN_PX).toBe(24);
    expect(SHEET_TITLE_FONT_MAX_PX).toBe(56);
    expect(SHEET_TITLE_LINE_RATIO).toBe(1.3);
    expect(SHEET_TITLE_GAP).toBe(18);
    expect(TITLE_FONT_HARD_MIN_PX).toBe(16);
    expect(TEXT_WIDTH_SAFETY).toBe(1.05);
    expect(LEGEND_FONT_RATIO).toBe(0.36);
    expect(LEGEND_FONT_MIN_PX).toBe(18);
    expect(LEGEND_FONT_MAX_PX).toBe(40);
    expect(LEGEND_ROW_RATIO).toBe(1.7);
    expect(LEGEND_SWATCH_RATIO).toBe(1.25);
    expect(LEGEND_CODE_GAP_RATIO).toBe(0.5);
    expect(LEGEND_ITEM_PAD_RATIO).toBe(0.4);
    expect(LEGEND_ITEM_SAMPLE).toBe("F25 (12345)");
    expect(SHEET_MARGIN).toBe(20);
    expect(SHEET_RULER_LEFT).toBe(42);
    expect(SHEET_RULER_TOP).toBe(36);
    expect(LEGEND_PAD_TOP).toBe(24);
    expect(SHEET_RULER_FONT_MIN_PX).toBe(11);
    // 板步长必须来自 board.ts，不是另一份字面量 29
    expect(TILE_STEP).toBe(BOARD_COLS);
    expect(TILE_STEP).toBe(29);
  });

  /**
   * B6 新增常量的**逐字**断言族。
   *
   * **为什么单列一条**：这些值就是契约（规格 §13 的常量变更表 / §7.1 的纸型与版面），而它们在生产
   * 代码里大多是**互相钉住**的（`PRINT_BOARD_SIZES` ↔ `requireBoardSize`、`PRINT_BEAD_PX` 由
   * `BEAD_MM` 与 `PRINT_DPI` 推出）——守卫与它「互钉」只能证明两者一致，**改不动其中一方**这件事
   * 只有字面量断言读得到（例如把 `PRINT_BOARD_SIZES` 改成 `[29, 57]` 时两条会一起漂）。
   */
  it("打印侧常量逐字：板大小表 / 打印精度 / 页边距 / 纸型毫米 / 色号字号下限", () => {
    expect(PRINT_BOARD_SIZES).toEqual([29, 58]);
    expect(PRINT_DPI).toBe(300);
    expect(PRINT_MARGIN_MM).toBe(10);
    // 纸型毫米（A4 210×297、A3 297×420）：逐字写，不从 `mmToPx` 或画布尺寸反推
    expect(PAPER_MM.a4).toEqual({ width: 210, height: 297 });
    expect(PAPER_MM.a3).toEqual({ width: 297, height: 420 });
    // 格内色号的硬下限：低于它 `planSheet` / `planBoardPage` 必须响亮失败（规格 §6.2）
    expect(SHEET_MIN_LABEL_FONT_PX).toBe(10);
    // 「29 + A4 ⇒ 1 格恰为 `BEAD_MM`」这条关系：实物大小的格像素由实物参数推导，不是又一份字面量
    expect(PRINT_BEAD_PX).toBe(Math.round((BEAD_MM / 25.4) * PRINT_DPI));
  });
});

describe("C7：内容驱动的施工图几何", () => {
  const usages = (count: number): ColorUsage[] =>
    Array.from({ length: count }, (_, i) => ({ code: `A${i + 1}`, name: `色 ${i + 1}`, count: 10 }));

  it("用料条永远不撑宽画布：29x25 + 13 色时，用料条右沿不超过网格右沿加右刻度带", () => {
    const plan = planSheet(makePattern(29, 25), makePalette(13), usages(13), PROJECT_NAME);
    const bandRight = plan.legend.left + plan.legend.itemCols * plan.legend.itemWidth;
    const gridRight = plan.grid.x + plan.grid.width;
    expect(bandRight).toBeLessThanOrEqual(gridRight + SHEET_RULER_LEFT + 1);
  });

  it("网格占画布宽度不少于 85%（旧实现是 47%）", () => {
    const plan = planSheet(makePattern(29, 25), makePalette(13), usages(13), PROJECT_NAME);
    expect(plan.grid.width / plan.canvasWidth).toBeGreaterThanOrEqual(0.85);
  });

  it("底部刻度带与用料条不重叠：用料条顶边 ≥ 网格下沿 + 刻度带高 + 间隔", () => {
    const plan = planSheet(makePattern(29, 25), makePalette(13), usages(13), PROJECT_NAME);
    const gridBottom = plan.grid.y + plan.grid.height;
    expect(plan.ruler.bottomY).toBe(gridBottom);
    expect(plan.legendTop).toBeGreaterThanOrEqual(gridBottom + SHEET_RULER_TOP + LEGEND_PAD_TOP);
  });

  it("画布高度含标题行、上下两条刻度带与用料条（漏算底部会让用料条压住刻度数字）", () => {
    const plan = planSheet(makePattern(29, 25), makePalette(13), usages(13), PROJECT_NAME);
    // C8 §7.1 起标题行高不再是常量：`round(标题字号 × 1.3)`，且下面多了一条 `SHEET_TITLE_GAP`。
    const titleHeight = Math.round(plan.titleFontPx * SHEET_TITLE_LINE_RATIO);
    expect(plan.canvasHeight).toBe(
      SHEET_MARGIN +
        titleHeight +
        SHEET_TITLE_GAP +
        SHEET_RULER_TOP +
        plan.grid.height +
        SHEET_RULER_TOP +
        LEGEND_PAD_TOP +
        plan.legend.itemRows * plan.legend.rowHeight +
        SHEET_MARGIN,
    );
    // 逐字读数（由上面那条式子推出）：20 + 62 + 18 + 36 + 2400 + 36 + 24 + 2×60 + 20 = 2736
    expect(plan.canvasHeight).toBe(2736);
  });

  it("标题行在网格上方，且标题行底边不侵入上刻度带", () => {
    const plan = planSheet(makePattern(29, 25), makePalette(13), usages(13), PROJECT_NAME);
    expect(plan.titleY).toBe(SHEET_MARGIN);
    expect(plan.grid.y).toBe(
      SHEET_MARGIN +
        Math.round(plan.titleFontPx * SHEET_TITLE_LINE_RATIO) +
        SHEET_TITLE_GAP +
        SHEET_RULER_TOP,
    );
    expect(plan.ruler.topY).toBe(plan.grid.y - SHEET_RULER_TOP);
  });

  it("29x25 这类常用尺寸的格像素取到上限 96", () => {
    const plan = planSheet(makePattern(29, 25), makePalette(13), usages(13), PROJECT_NAME);
    expect(plan.cellPx).toBe(EXPORT_CELL_MAX_PX);
  });

  it("大图纸仍受画布上限约束，且色号字号不低于下限", () => {
    const plan = planSheet(makePattern(116, 116), makePalette(24), usages(24), PROJECT_NAME);
    expect(plan.canvasWidth).toBeLessThanOrEqual(EXPORT_MAX_EDGE);
    expect(plan.canvasHeight).toBeLessThanOrEqual(EXPORT_MAX_EDGE);
    expect(plan.labelFontPx).toBeGreaterThanOrEqual(SHEET_MIN_LABEL_FONT_PX);
  });

  it("116 宽 + maxEdge 300 放不下就响亮失败（宽度与字号两条守卫，只断言「抛」）", () => {
    expect(() => planSheet(makePattern(116, 116), makePalette(24), usages(24), PROJECT_NAME, { maxEdge: 300 })).toThrow();
  });

  it("用料条按网格宽换行：4x4 网格（格像素 96、网格宽 384、项宽 299）⇒ 列数 floor(384 / 299) = 1", () => {
    const plan = planSheet(makePattern(4, 4), makePalette(8), usages(8), PROJECT_NAME);
    expect(plan.cellPx).toBe(EXPORT_CELL_MAX_PX);
    // **判别力**：按画布宽（1202px）算会得到 4 列 —— 只有「按网格宽换行」才给 1 列
    expect(plan.legend.itemCols).toBe(1);
    expect(plan.legend.itemRows).toBe(Math.ceil(8 / 1));
  });
});

describe("cellBox：唯一映射", () => {
  const plan = planSheet(makePattern(116, 116), makePalette(), [], PROJECT_NAME);

  it("首格与末格的片内像素落位逐位正确", () => {
    // 前提（用例自己先钉住）：116×116 的格像素是 33、网格落位是 (62, 105)
    // （C8 起边距 20 / 刻度带 42 / 标题行 = round(clamp(round(33 × 0.5), 24, 56) × 1.3) = 31 / 净距 18）
    expect(plan.cellPx).toBe(33);
    expect(plan.grid.x).toBe(62);
    expect(plan.grid.y).toBe(105);
    expect(cellBox(plan, 0, 0)).toEqual({ x: 62, y: 105, width: 33, height: 33 });
    expect(cellBox(plan, 115, 115)).toEqual({
      x: 62 + 115 * 33,
      y: 105 + 115 * 33,
      width: 33,
      height: 33,
    });
  });

  it("越界与非安全整数一律抛（不静默取整、不夹取）", () => {
    expect(() => cellBox(plan, 116, 0)).toThrow("列 116 不在本片范围 0–115 内");
    expect(() => cellBox(plan, 0, 116)).toThrow("行 116 不在本片范围 0–115 内");
    expect(() => cellBox(plan, -1, 0)).toThrow("列 -1 不在本片范围 0–115 内");
    expect(() => cellBox(plan, 1.5, 0)).toThrow("格子列号必须是安全整数");
    expect(() => cellBox(plan, 0, 2 ** 53)).toThrow("格子行号必须是安全整数");
  });
});

describe("countTileBeads", () => {
  it("只数本片的实心格（空格不计）", () => {
    const pattern = makePattern(58, 58, 0);
    pattern.cells[0] = EMPTY;
    pattern.cells[1] = EMPTY;
    const plan = planSheet(pattern, makePalette(), [], PROJECT_NAME);
    expect(countTileBeads(pattern, plan)).toBe(58 * 58 - 2);
  });

  it("片范围超出图纸时响亮拒绝（否则 cellAt 会静默返回 EMPTY、数出一个偏小的数）", () => {
    const pattern = makePattern(10, 10);
    const plan = planSheet(pattern, makePalette(), [], PROJECT_NAME);
    const broken = { ...plan, cols: 20 };
    expect(() => countTileBeads(pattern, broken)).toThrow("超出图纸");
  });
});

describe("labelInk 与 rgbCss", () => {
  it("白底黑字、黑底白字（L* 距黑 / 白谁近用谁）", () => {
    expect(labelInk([255, 255, 255])).toBe("rgb(0, 0, 0)");
    expect(labelInk([0, 0, 0])).toBe("rgb(255, 255, 255)");
  });

  it("分量非有限时抛（复用 rgbToLab 的既有守卫，本函数不写第二份）", () => {
    expect(() => labelInk([Number.NaN, 0, 0])).toThrow();
  });

  it("rgbCss 是输出层唯一的颜色序列化口径", () => {
    expect(rgbCss([255, 0, 0])).toBe("rgb(255, 0, 0)");
    expect(rgbCss([0, 0, 0])).toBe("rgb(0, 0, 0)");
    // 越界的**有限**值夹到 0–255（与 rgbToLab 的既有口径一致）
    expect(rgbCss([300, -5, 12.6])).toBe("rgb(255, 0, 13)");
    // 非有限即抛，不静默产出一个 "rgb(NaN, …)"
    expect(() => rgbCss([Number.NaN, 0, 0])).toThrow("颜色分量必须是有限数字");
  });
});

describe("网格线、刻度与板边界", () => {
  const single = planSheet(makePattern(58, 58), makePalette(), [], PROJECT_NAME);

  it("线按全局坐标分档：每格细、每 5 格主、每 29 格板（board 优先）", () => {
    // 前提：58×58 的格像素是 67（上限 96，被**量出来的**画布高夹到 67：不用料 ⇒ 高度只花
    // 标题行 44 + 净距 18 + 两条刻度带 72 + 两侧边距 40，58×68 会到 4118 > 4096），
    // 网格落位是 (62, 118)（标题字号 clamp(round(67 × 0.5), 24, 56) = 34 ⇒ 行高 round(44.2) = 44）
    expect(single.cellPx).toBe(67);
    expect(single.grid.x).toBe(62);
    expect(single.grid.y).toBe(118);
    expect(single.vLines).toHaveLength(59);
    expect(single.vLines[0]).toEqual({ at: 62, kind: "board" });
    expect(single.vLines[1]).toEqual({ at: 62 + 67, kind: "thin" });
    expect(single.vLines[5]).toEqual({ at: 62 + 5 * 67, kind: "major" });
    expect(single.vLines[29]).toEqual({ at: 62 + 29 * 67, kind: "board" });
    // 行轴与列轴是 `makeGridGeometry` 里两段独立循环，不是彼此的副产品 ⇒ 逐位对称地钉一遍。
    expect(single.hLines).toHaveLength(59);
    expect(single.hLines[0]).toEqual({ at: 118, kind: "board" });
    expect(single.hLines[1]).toEqual({ at: 118 + 67, kind: "thin" });
    expect(single.hLines[5]).toEqual({ at: 118 + 5 * 67, kind: "major" });
    expect(single.hLines[29]).toEqual({ at: 118 + 29 * 67, kind: "board" });
    expect(single.lineWidths).toEqual({ thin: 1, major: 2, board: 3 });
  });

  it("刻度每 5 格一个、位置与全局列号一致；板边界带板序号", () => {
    expect(single.colTicks.map((t) => t.col)).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
    expect(single.colTicks[1]).toEqual({ col: 5, x: 62 + 5 * 67 });
    expect(single.rowTicks.map((t) => t.row)).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
    expect(single.rowTicks[1]).toEqual({ row: 5, y: 118 + 5 * 67 });
    expect(single.colBoards).toEqual([
      { board: 1, col: 0, x: 62 },
      { board: 2, col: 29, x: 62 + 29 * 67 },
    ]);
    expect(single.rowBoards).toEqual([
      { board: 1, row: 0, y: 118 },
      { board: 2, row: 29, y: 118 + 29 * 67 },
    ]);
  });

  /**
   * **原点非零的映射由板页用例承担**（规格 §10）：单张计划的 `originCol / originRow` 恒为 0，
   * 「只对原点为 0 成立」的错法（例如把片内坐标当全局坐标）在那里**对任何断言都不可见**
   * （2026-10-05 实测：把 `at` 里的 `− originCol` 删掉，原点为 0 的用例 30 passed / 0 红）。
   * 这里取 116×116 的第 6 页（index = 5 ⇒ 第 1 行第 1 列、列 29 行 29 起），两块板的原点都非零。
   * 落位是 29 板 + A4 的实测值：格像素 59、网格 (405, 210)。
   */
  it("原点非零的一页（列 29 / 行 29 起）的网格线、刻度与板边界仍取全局坐标", () => {
    const page = planBoardPage(makePattern(116, 116), makePalette(), [], {
      boardSize: 29,
      paper: "a4",
      index: 5,
      projectName: PROJECT_NAME,
    });
    // 前提：这一页真的带偏移（否则这条与上面两条等价、判别力是假的）
    expect(page.originCol).toBe(29);
    expect(page.originRow).toBe(29);
    expect(page.cellPx).toBe(59);

    // 列线的原点项：`at = grid.x + (col − originCol) × cellPx`，全局列号 29 / 30 / 31
    expect(page.vLines[0]).toEqual({ at: 405, kind: "board" });
    expect(page.vLines[1]).toEqual({ at: 405 + 59, kind: "major" });
    expect(page.vLines[2]).toEqual({ at: 405 + 2 * 59, kind: "thin" });
    // 刻度与板序号取**全局**格号（本页首刻度是第 30 列）、x 减掉本页原点
    expect(page.colTicks[0]).toEqual({ col: 30, x: 405 + (30 - 29) * 59 });
    expect(page.colBoards[0]).toEqual({ board: 2, col: 29, x: 405 });
    // 行轴逐位对称（同一页的行原点也是 29）。**网格顶边是 210**（C8 起 = 页边距 118 +
    // 标题行 round(29 × 1.3) = 38 + 净距 18 + 上刻度带 36）
    expect(page.hLines[0]).toEqual({ at: 210, kind: "board" });
    expect(page.hLines[1]).toEqual({ at: 210 + 59, kind: "major" });
    expect(page.hLines[2]).toEqual({ at: 210 + 2 * 59, kind: "thin" });
    expect(page.rowTicks[0]).toEqual({ row: 30, y: 210 + (30 - 29) * 59 });
    expect(page.rowBoards[0]).toEqual({ board: 2, row: 29, y: 210 });
  });
});

/** 221 色的色卡与用量（MARD 色卡的真实规模，用来钉住最坏情况的预算）。 */
function makeBigPalette(count = 221): Palette {
  return {
    id: "test-palette",
    name: "测试色卡",
    source: "test",
    accuracy: "屏幕色仅供参考，以实物为准",
    colors: Array.from({ length: count }, (_, i) => ({
      code: `C${i}`,
      name: `色${i}`,
      rgb: [i % 256, (i * 7) % 256, (i * 13) % 256] as const,
    })),
  };
}

function makeBigUsages(count = 221): ColorUsage[] {
  return Array.from({ length: count }, (_, i) => ({ code: `C${i}`, name: `色${i}`, count: i + 1 }));
}

/** 33 个实心格的用量（26 + 5 + 1 + 1 = 33）。**计数独立数一遍**，不用被测实现。 */
function makeUsages(): ColorUsage[] {
  return [
    { code: "A1", name: "白", count: 26 },
    { code: "A2", name: "黑", count: 5 },
    { code: "A3", name: "红", count: 1 },
    { code: "A4", name: "浅灰", count: 1 },
  ];
}

describe("planSheet（B6：单张施工图）", () => {
  it("116×116 + 221 色的最坏预算逐字钉住（31 / 11 / 3700 / 4091）", () => {
    const plan = planSheet(makePattern(116, 116), makeBigPalette(), makeBigUsages(), PROJECT_NAME);
    // **字面量**，不是松上界：只断「>= / <=」的话，实现算出 27 / 3000 / 3800 也照样绿。
    // C8 修复后这三个数由「把候选格像素真算一遍再量」定出来：格像素 31 ⇒ 网格 3596、
    // 用料字号 18（项宽 154 ⇒ 23 列 ⇒ 10 行 × 31px）、标题行高 31（字号 24）
    // ⇒ 画布 3700 × (105 + 3596 + 36 + 24 + 310 + 20) = 3700 × 4091 ≤ 4096。
    // **31 是量出来的最大可行值**：32 会到 4207 > 4096（旧预算曾给 22 而抛错，见修复报告）。
    expect(plan.cellPx).toBe(31);
    expect(plan.labelFontPx).toBe(11);
    expect(plan.canvasWidth).toBe(3700);
    expect(plan.canvasHeight).toBe(4091);
    expect(plan.canvasWidth).toBeLessThanOrEqual(EXPORT_MAX_EDGE);
    expect(plan.canvasHeight).toBeLessThanOrEqual(EXPORT_MAX_EDGE);
    // 判据与实现的守卫同源（`round(cellPx × 0.36) ≥ 10`）
    expect(Math.round(plan.cellPx * 0.36)).toBeGreaterThanOrEqual(SHEET_MIN_LABEL_FONT_PX);
  });

  it("每一项用料都落在画布内（用料条按网格宽换行，永不撑宽画布）", () => {
    const usages = makeBigUsages();
    const plan = planSheet(makePattern(116, 116), makeBigPalette(), usages, PROJECT_NAME);
    for (let i = 0; i < usages.length; i += 1) {
      const left = plan.legend.left + (i % plan.legend.itemCols) * plan.legend.itemWidth;
      // 一项的全部像素（含项内右留白）都必须落在画布内
      expect(left + plan.legend.itemWidth).toBeLessThanOrEqual(plan.canvasWidth);
    }
    // 项宽的口径（C8 §7.2：它由用料字号推出，不再有 `LEGEND_COUNT_RIGHT_PAD` 这种右内缩常量）
    expect(plan.legend.itemWidth).toBeGreaterThanOrEqual(
      plan.legend.codeX +
        estimateTextWidthPx(LEGEND_ITEM_SAMPLE, plan.legend.fontPx) +
        Math.round(plan.legend.fontPx * LEGEND_ITEM_PAD_RATIO),
    );
    // 画布宽 = max(网格右沿 + 右刻度带, 用料条右沿 + 边距, 标题上界右沿 + 边距)；用料条按网格宽换行
    // ⇒ 它通常不是上界（这正是 C7 那条纪律）
    expect(plan.canvasWidth).toBe(
      Math.max(
        plan.grid.x + plan.grid.width + SHEET_RULER_LEFT,
        plan.legend.left + plan.legend.itemCols * plan.legend.itemWidth + SHEET_MARGIN,
        SHEET_MARGIN +
          estimateTextWidthPx(PROJECT_NAME, plan.titleFontPx) +
          SHEET_TITLE_FIXED_EM * plan.titleFontPx +
          SHEET_MARGIN,
      ),
    );
    // 用料条**不得**成为画布宽度的上界：它的换行宽度就是网格宽（列数按网格宽算出来的）
    expect(plan.legend.itemCols).toBe(Math.floor(plan.grid.width / plan.legend.itemWidth));
    // 小图纸：C8 §7.3 起**标题**（身份信息）可以把画布撑宽，用料条仍然按网格宽换行
    const small = planSheet(makePattern(4, 2), makePalette(), makeUsages(), PROJECT_NAME);
    const smallBoxRight = small.grid.x + small.grid.width + SHEET_RULER_LEFT;
    expect(small.canvasWidth).toBeGreaterThan(smallBoxRight);
    expect(small.canvasWidth).toBeLessThan(EXPORT_MAX_EDGE);
    expect(small.legend.left + small.legend.itemCols * small.legend.itemWidth).toBeLessThanOrEqual(
      smallBoxRight + 1,
    );
  });

  it("小图纸取 96 px/格上限（C7 起不再锁在 40，否则网格撑不满画布）", () => {
    const plan = planSheet(makePattern(4, 2), makePalette(), makeUsages(), PROJECT_NAME);
    expect(plan.cellPx).toBe(EXPORT_CELL_MAX_PX);
    expect(plan.labelFontPx).toBe(Math.round(EXPORT_CELL_MAX_PX * 0.36));
  });

  it("画布上限太小 ⇒ 响亮失败：两种失败各有专门消息，用户可见文本里不出现负数格像素", () => {
    // ① 根本放不下（宽度先归零）：「放不下」+ 可用区域尺寸，**不许**把 `-1 px` 写进用户可见文本。
    expect(() => planSheet(makePattern(116, 116), makeBigPalette(), makeBigUsages(), PROJECT_NAME, { maxEdge: 100 })).toThrow(
      /^可用区域 100×100 px 放不下 116×116 的图纸$/,
    );
    // ② 放得下、但格子小到色号不可读：这一支报出**量出来的**最大可行格像素与字号下限
    // （两种失败不许混成同一句）。**上限 1200 在 C8 起连网格都放不下**（走 ① 那一支）；
    // 而 2400 下量出来的最大可行格像素是 12（116×116 的网格 1392 + 用料 25 行 × 31px = 2167
    // + 标题行 31 + 两条刻度带 72 + 净距 18 + 间隔 24 + 两侧边距 40 = 2352 ≤ 2400，
    // 13 会到 2468 > 2400）⇒ 色号只有 4px。
    let message = "";
    try {
      planSheet(makePattern(116, 116), makeBigPalette(), makeBigUsages(), PROJECT_NAME, { maxEdge: 2400 });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/^可用区域放不下 116×116 的图纸：每格只有 12 px、色号字号 4 px，低于下限 10 px$/);
    expect(message).not.toMatch(/扣掉用料条|没有可用高度/);
    expect(message).not.toMatch(/-\d+ px/);
  });

  it("画布上限小于两条刻度带加边距（连网格都放不下）⇒ 也是「放不下」，且排在渲染之前", () => {
    // 旧实现有一条专门的「画布上限太小」守卫；C7 起宽度守卫统一到格像素收敛里（C8 修复后是
    // `fitCellPx` 的「与工程名无关的最小几何」那一轮），
    // 所以这一支改报「放不下」——**判据是「抛且消息说清放不下」，不再要求专用文案**。
    expect(() => planSheet(makePattern(6, 6), makePalette(), makeUsages(), PROJECT_NAME, { maxEdge: 100 })).toThrow(
      /放不下 6×6 的图纸/,
    );
  });

  it("用料条列数由网格宽决定、行数随色数变化，且 top 落在下刻度带之下", () => {
    const pattern = makePattern(6, 6);
    const plan = planSheet(pattern, makePalette(), makeUsages(), PROJECT_NAME);
    // 6×6：网格宽 384px、格像素 96 ⇒ 用料字号 35、项宽 299 ⇒ 列数 floor(384 / 299) = 1
    expect(plan.legend.itemCols).toBe(1);
    expect(plan.legend.itemRows).toBe(makeUsages().length);
    expect(plan.legend.top).toBe(plan.grid.y + plan.grid.height + SHEET_RULER_TOP + LEGEND_PAD_TOP);
    expect(plan.canvasHeight).toBe(
      plan.legend.top + plan.legend.itemRows * plan.legend.rowHeight + SHEET_MARGIN,
    );
  });

  it("色号必须经 cellBox 取位：越界格抛错（计划与渲染共用的唯一映射）", () => {
    const plan = planSheet(makePattern(6, 6), makePalette(), makeUsages(), PROJECT_NAME);
    expect(() => cellBox(plan, 6, 0)).toThrow("列 6 不在本片范围 0–5 内");
  });

  /**
   * 入口守卫（图纸 / 色卡 / 画布上限）——原来挂在已删除的自动分片计划上，断言随计划函数一起搬到
   * **生产路径**上（`planSheet` 是导出面板唯一用的那个）。
   * 少了这一条，「`maxEdge` 显式传 `null` 静默回落默认上限」「坏长度的图纸先画半张产物」
   * 这类失败面就没有任何用例看得见。
   */
  it("入口守卫：画布上限非法 / 色卡不一致 / `cells` 长度不符一律抛", () => {
    for (const bad of [Number.NaN, 4096.5, 0, -1, null]) {
      expect(() =>
        planSheet(makePattern(4, 4), makePalette(), [], PROJECT_NAME, { maxEdge: bad as unknown as number }),
      ).toThrow("画布上限必须是 ≥1 的整数");
    }
    expect(() => planSheet(makePattern(4, 4), { ...makePalette(), id: "other" }, [], PROJECT_NAME)).toThrow(
      "与传入的色卡 other 不一致",
    );
    const broken = makePattern(4, 4);
    const short = { ...broken, cells: new Uint16Array(15) };
    expect(() => planSheet(short, makePalette(), [], PROJECT_NAME)).toThrow("需要 16 格，实际 15 格");
  });
});

describe("planBoardPage（B6：每块板一页）", () => {
  it("页数 = ⌈宽/板大小⌉ × ⌈高/板大小⌉（与 boardCount 不是同一个量）", () => {
    expect(printBoardCount(116, 116, 29)).toBe(16);
    expect(printBoardCount(116, 116, 58)).toBe(4);
    expect(printBoardCount(30, 1, 29)).toBe(2);
    expect(boardCount(30, 1).total).toBe(2); // 两者恰好相等的场景也要能各自成立
  });

  /**
   * 枚举 / 数值守卫的覆盖（第 2 轮审查补入；2026-10-08 复核更正了原先那句「删掉也不会红」）。
   *
   * `requireBoardSize` **一直**是被判别的：`boardSize: 30` 那条用例（文件末尾的页索引用例）
   * 走的就是它。此前真正零覆盖的是 `requirePaper` 与 `printBoardCount` 的 ≥1 —— 删掉前者会让
   * `paper: "a5"` 静默回落成 A4、删掉后者会让 `(0, 0, 29)` 静默返回 0 页，而当时**全套一条都不会红**。
   * 下面两条把这两处补上；板大小那一条也一并留着（表与守卫是两个源，改表必须同时改守卫）。
   */
  it("非法纸张 ⇒ 抛错；合法纸张逐个放行（`paper` 守卫不许可以静默回落）", () => {
    for (const paper of Object.keys(PAPER_MM)) {
      expect(() =>
        planBoardPage(makePattern(29, 29), makePalette(), makeUsages(), { boardSize: 29, paper, index: 0, projectName: PROJECT_NAME }),
      ).not.toThrow();
    }
    for (const paper of ["a5", "A4", "", "b5"]) {
      expect(() =>
        planBoardPage(makePattern(29, 29), makePalette(), makeUsages(), { boardSize: 29, paper, index: 0, projectName: PROJECT_NAME }),
      ).toThrow(/纸张/);
    }
  });

  it("`PRINT_BOARD_SIZES` 就是运行期判据：表里每个值都放行，表外一律抛 `/板大小/`", () => {
    for (const boardSize of PRINT_BOARD_SIZES) {
      expect(printBoardCount(29, 29, boardSize)).toBe(1);
    }
    // 两条来源必须一致——改 `PRINT_BOARD_SIZES` 而不同时改 `requireBoardSize` 时这条会红
    for (const boardSize of [1, 28, 30, 59, 0, -29, 29.5, Number.NaN]) {
      expect(() => printBoardCount(29, 29, boardSize)).toThrow(/板大小/);
    }
  });

  it("图纸宽高必须是 ≥1 的整数（0 / 负数 / 小数 / 非有限一律抛，不静默给出 0 页）", () => {
    expect(() => printBoardCount(0, 0, 29)).toThrow(/图纸宽度/);
    expect(() => printBoardCount(0, 5, 29)).toThrow(/图纸宽度/);
    expect(() => printBoardCount(5, 0, 29)).toThrow(/图纸高度/);
    expect(() => printBoardCount(-1, 5, 29)).toThrow(/图纸宽度/);
    expect(() => printBoardCount(5, 2.5, 29)).toThrow(/图纸高度/);
    expect(() => printBoardCount(Number.NaN, 5, 29)).toThrow(/图纸宽度/);
  });

  it("`mmToPx` 只收正的有限毫米数（打印页画布与页边距的唯一换算口径）", () => {
    expect(mmToPx(25.4)).toBe(PRINT_DPI); // 1 英寸 = 该 dpi 的像素数，换算的锚点
    expect(() => mmToPx(0)).toThrow(/毫米数/);
    expect(() => mmToPx(-1)).toThrow(/毫米数/);
    expect(() => mmToPx(Number.NaN)).toThrow(/毫米数/);
    expect(() => mmToPx(Number.POSITIVE_INFINITY)).toThrow(/毫米数/);
  });

  it("29 + A4：每格正好 5mm（实物大小），画布就是 A4 的 300dpi 像素", () => {
    const plan = planBoardPage(makePattern(58, 58), makePalette(), makeUsages(), {
      boardSize: 29,
      paper: "a4",
      index: 0,
      projectName: PROJECT_NAME,
    });
    expect(plan.canvasWidth).toBe(mmToPx(210));
    expect(plan.canvasHeight).toBe(mmToPx(297));
    expect(plan.cellPx).toBe(PRINT_BEAD_PX);
    // **不能写 `toBeCloseTo(BEAD_MM, 5)`（更不用说 6）**：`cellMm` 由**取整后的** `cellPx` 推出
    // （59 / 300 × 25.4 = 4.99533…），与 5 的差是 0.0047 = `PRINT_BEAD_PX` 的量化步长，
    // 而 `toBeCloseTo` 的第 5 位要求 |Δ| < 0.5e-5。这是像素量化的**固有**上界，不是实现误差；
    // 判据写成「差 ≤ 1/4 像素」才是既通过、又真的会因换算写错（例如除成 96dpi）而红的版本。
    expect(Math.abs(plan.cellMm - BEAD_MM)).toBeLessThanOrEqual(25.4 / PRINT_DPI / 4);
    expect(plan.cellMm).toBeCloseTo((PRINT_BEAD_PX / PRINT_DPI) * 25.4, 6);
    expect(plan.scaleRatio).toBe(1);
    expect(plan.cols).toBe(29);
    expect(plan.rows).toBe(29);
  });

  it("29 + A3：纸更大也**不许被放大**超过实物", () => {
    const plan = planBoardPage(makePattern(58, 58), makePalette(), makeUsages(), {
      boardSize: 29,
      paper: "a3",
      index: 0,
      projectName: PROJECT_NAME,
    });
    expect(plan.cellPx).toBe(PRINT_BEAD_PX);
    expect(plan.scaleRatio).toBe(1);
  });

  it("刻度带 + 网格整块落在可打印区内（左右留白 ≥ 页边距）", () => {
    // 58 板在 A3 上：把「刻度带 + 网格」当整体居中、却不把刻度带算进宽度预算时，
    // 右留白只剩 98px < 118px（10mm）——刻度/板号会落进不可打印区。
    const plan = planBoardPage(makePattern(116, 116), makePalette(), makeUsages(), {
      boardSize: 58,
      paper: "a3",
      index: 0,
      projectName: PROJECT_NAME,
    });
    const marginPx = mmToPx(PRINT_MARGIN_MM);
    expect(plan.grid.x - SHEET_RULER_LEFT).toBeGreaterThanOrEqual(marginPx);
    expect(plan.grid.x + plan.grid.width).toBeLessThanOrEqual(plan.canvasWidth - marginPx);
  });

  it("用料条也落在可打印区内（本页色多时不许越入页边距）", () => {
    // 29 板 + A4 + 221 色：条带按网格偏移落位时右沿 2552 > 可打印右界 2362（越 190px）。
    const plan = planBoardPage(makePattern(116, 116), makeBigPalette(), makeBigUsages(), {
      boardSize: 29,
      paper: "a4",
      index: 0,
      projectName: PROJECT_NAME,
    });
    const marginPx = mmToPx(PRINT_MARGIN_MM);
    const count = makeBigUsages().length;
    const bandRight =
      plan.legend.left +
      Math.min(plan.legend.itemCols, count) * plan.legend.itemWidth;
    expect(plan.legend.left).toBeGreaterThanOrEqual(marginPx);
    expect(bandRight).toBeLessThanOrEqual(plan.canvasWidth - marginPx);
  });

  it("58 + A3：每格 ≥ 实物的 90%（装不下才缩，且如实给出比例）", () => {
    const plan = planBoardPage(makePattern(116, 116), makePalette(), makeUsages(), {
      boardSize: 58,
      paper: "a3",
      index: 0,
      projectName: PROJECT_NAME,
    });
    expect(plan.cellPx).toBeLessThan(PRINT_BEAD_PX);
    expect(plan.scaleRatio).toBeGreaterThanOrEqual(0.9);
    expect(plan.cellMm).toBeCloseTo((plan.cellPx / PRINT_DPI) * 25.4, 6);
  });

  it("58 + A4：每格 < 实物的 70%（只能当读码参考图）", () => {
    const plan = planBoardPage(makePattern(116, 116), makePalette(), makeUsages(), {
      boardSize: 58,
      paper: "a4",
      index: 0,
      projectName: PROJECT_NAME,
    });
    expect(plan.scaleRatio).toBeLessThan(0.7);
  });

  it("最后一页 / 列收窄，且页与页不重叠", () => {
    const pattern = makePattern(100, 30);
    const plan = planBoardPage(pattern, makePalette(), makeUsages(), { boardSize: 29, paper: "a4", index: 3, projectName: PROJECT_NAME });
    // 100 = 29×3 + 13 ⇒ 第 3 列（index 3，0 起）覆盖列 87–99，行 0–28
    expect(plan.originCol).toBe(87);
    expect(plan.cols).toBe(13);
    expect(plan.originRow).toBe(0);
    expect(plan.rows).toBe(29);
  });

  it("页索引越界 / 枚举非法 ⇒ 抛错（不静默取模、不回落默认值）", () => {
    expect(() =>
      planBoardPage(makePattern(30, 30), makePalette(), makeUsages(), { boardSize: 29, paper: "a4", index: 4, projectName: PROJECT_NAME }),
    ).toThrow(/页索引/);
    expect(() =>
      planBoardPage(makePattern(30, 30), makePalette(), makeUsages(), {
        boardSize: 30 as unknown as 29,
        paper: "a4",
        index: 0,
        projectName: PROJECT_NAME,
      }),
    ).toThrow(/板大小/);
  });

  /**
   * 四种组合的**参数化**用例（设计规格 §14「永不放大超过实物」这条规则唯一的判别点）。
   *
   * 逐字用例已各自钉住 `cellPx` / `scaleRatio` 的部分情形；这里补上同族里剩下的量：**画布 = 纸型像素**、
   * **四边留白 ≥ `PRINT_MARGIN_MM`**（§14 明列的断言，逐字用例里没有）、以及 **`cellPx` 的逐位真值**
   * ——后者是第 2 轮补的：只断 `scaleRatio ≥ 0.9 / < 0.7` 时，修复前的 56 / 38 照样绿（0.9492 / 0.6441
   * 都落在区间里），宽度预算那处修复**没有任何断言判别**。
   *
   * `boardSize` 从 `BOARD_COLS` 取；`paper` 只能是字面量（`it.each` 的行类型需要一个具体纸型，
   * 而 `Object.keys(PAPER_MM)` 是 `string[]`），与 `PAPER_MM[paper]` 的取用同源。
   */
  it.each([
    { paper: "a4" as const, boardSize: BOARD_COLS, expectedCellPx: 59, ratioMin: 1, ratioMax: 1 },
    { paper: "a3" as const, boardSize: BOARD_COLS, expectedCellPx: 59, ratioMin: 1, ratioMax: 1 },
    { paper: "a3" as const, boardSize: BOARD_COLS * 2, expectedCellPx: 54, ratioMin: 0.9, ratioMax: 1 },
    { paper: "a4" as const, boardSize: BOARD_COLS * 2, expectedCellPx: 36, ratioMin: 0, ratioMax: 0.7 },
  ])(
    "$boardSize 格板 + $paper：画布就是纸型像素、四边留白 ≥ PRINT_MARGIN_MM，缩放比落在 [$ratioMin, $ratioMax]",
    ({ paper, boardSize, expectedCellPx, ratioMin, ratioMax }) => {
      const plan = planBoardPage(makePattern(boardSize * 2, boardSize * 2), makePalette(), makeUsages(), {
        boardSize,
        paper,
        index: 0,
        projectName: PROJECT_NAME,
      });
      const marginPx = mmToPx(PRINT_MARGIN_MM);
      expect(plan.canvasWidth).toBe(mmToPx(PAPER_MM[paper].width));
      expect(plan.canvasHeight).toBe(mmToPx(PAPER_MM[paper].height));
      // `cellPx` 的逐位真值：钉住宽度预算（C7 起左右刻度带各扣一条 ⇒ 58 板两例由 55 / 37 降到 54 / 36）
      expect(plan.cellPx).toBe(expectedCellPx);
      expect(plan.cellPx).toBeLessThanOrEqual(PRINT_BEAD_PX); // 「永不放大超过实物」在四组合下都成立
      // **逐边**断言：网格带 = 左刻度带 + 网格，两端的留白都必须 ≥ 页边距。
      expect(plan.grid.x - SHEET_RULER_LEFT).toBeGreaterThanOrEqual(marginPx);
      expect(plan.grid.x + plan.grid.width).toBeLessThanOrEqual(plan.canvasWidth - marginPx);
      expect(plan.grid.y).toBeGreaterThanOrEqual(marginPx);
      expect(plan.canvasHeight - (plan.grid.y + plan.grid.height)).toBeGreaterThanOrEqual(marginPx);
      // 标题行在最上留白之内、与网格块左沿对齐，且不压住含刻度带的网格
      // （C8 起标题行高 = `round(标题字号 × 1.3)`，不再是常量 `SHEET_TITLE_H`）
      expect(plan.titleY).toBe(marginPx);
      expect(plan.titleLeft).toBe(plan.grid.x - SHEET_RULER_LEFT);
      expect(plan.grid.y).toBeGreaterThanOrEqual(
        plan.titleY + Math.round(plan.titleFontPx * SHEET_TITLE_LINE_RATIO),
      );
      expect(plan.scaleRatio).toBeGreaterThanOrEqual(ratioMin);
      expect(plan.scaleRatio).toBeLessThanOrEqual(ratioMax);
    },
  );
});

/**
 * C8 §7：标题与用料条的字号随格像素缩放，用料条几何全部由字号推出，打印页三处左沿对齐。
 *
 * **期望值全部由规格 §7 的公式独立复算**（不抄实现）：`estimateTextWidthPx` 是
 * `ceil(Σem × fontPx × TEXT_WIDTH_SAFETY)`（CJK / 全角 1em、其余 0.55em），用料条几何是
 * §7.2 的四条比例式，标题字号是「比例值 → 逐 1px 下调 → 硬底 16px」。
 */
describe("C8：字号随格像素缩放与标题宽度", () => {
  const usages = (count: number): ColorUsage[] =>
    Array.from({ length: count }, (_, i) => ({ code: `A${i + 1}`, name: `色 ${i + 1}`, count: 10 }));

  it("估算函数：CJK 比 ASCII 宽，且带 5% 余量", () => {
    // 「a」0.55em × 100px × 1.05 = 57.75 ⇒ 58；「aa」翻倍 ⇒ 116；「中」1em × 100px × 1.05 = 105。
    // （简报原文这里写 55 / 110 —— 那是**没有乘余量**的两个读数，与同一段给的三条规格
    //   「CJK 按 1em / 其余 0.55em / 再乘 1.05」以及本用例名里的「带 5% 余量」互相矛盾；
    //   实现的公式是简报逐字给的，所以只改这两个期望值，见实现报告 D1。）
    expect(estimateTextWidthPx("a", 100)).toBe(58);
    expect(estimateTextWidthPx("aa", 100)).toBe(116);
    expect(estimateTextWidthPx("中", 100)).toBe(105);
    // 全角标点也算宽（`（` 是 U+FF08）
    expect(estimateTextWidthPx("（", 100)).toBe(105);
  });

  it("估算函数的非法输入响亮失败", () => {
    expect(() => estimateTextWidthPx(1 as never, 10)).toThrow(/字符串/);
    expect(() => estimateTextWidthPx("x", 0)).toThrow(/正的有限数字/);
    expect(() => estimateTextWidthPx("x", Number.NaN)).toThrow(/正的有限数字/);
  });

  it("用料条几何全部由字号推出，且行高放得下字号", () => {
    for (const font of [18, 24, 35, 40]) {
      const box = legendGeometry(font);
      expect(box.rowHeight).toBeGreaterThan(font);
      expect(box.itemWidth).toBeGreaterThan(box.codeX);
      expect(box.swatchSize).toBeGreaterThan(0);
    }
    expect(legendGeometry(40).rowHeight).toBeGreaterThan(legendGeometry(18).rowHeight);
    expect(legendGeometry(40).itemWidth).toBeGreaterThan(legendGeometry(18).itemWidth);
    // 逐条对上 §7.2 的比例式（18px 字号：色块 round(22.5)=23、缩进 23+round(9)=32、
    // 行高 round(30.6)=31、项宽 32 + ceil(6.05×18×1.05)=115 + round(7.2)=7 = 154）
    expect(legendGeometry(18)).toEqual({ rowHeight: 31, swatchSize: 23, codeX: 32, itemWidth: 154 });
    expect(legendGeometry(40)).toEqual({ rowHeight: 68, swatchSize: 50, codeX: 70, itemWidth: 341 });
  });

  it("29×25（格像素取上限 96）⇒ 标题 48px、用料条 35px，都随格像素走", () => {
    const plan = planSheet(makePattern(29, 25), makePalette(13), usages(13), "小猫");
    expect(plan.cellPx).toBe(EXPORT_CELL_MAX_PX);
    expect(plan.titleFontPx).toBe(48);
    expect(plan.legend.fontPx).toBe(35);
    expect(plan.labelFontPx).toBe(35);
    // 三个字号各自的来路：0.5 / 0.36 / 0.36 × 96，都夹进各自区间
    expect(plan.titleFontPx).toBe(Math.round(plan.cellPx * SHEET_TITLE_FONT_RATIO));
    expect(plan.legend.fontPx).toBe(Math.round(plan.cellPx * LEGEND_FONT_RATIO));
  });

  it("标题与上刻度带之间有净距，用料条与下刻度带之间也有（第 7 项：不紧贴）", () => {
    const plan = planSheet(makePattern(29, 25), makePalette(13), usages(13), "小猫");
    const titleHeight = Math.round(plan.titleFontPx * SHEET_TITLE_LINE_RATIO);
    expect(plan.titleY).toBe(SHEET_MARGIN);
    expect(plan.ruler.topY).toBe(SHEET_MARGIN + titleHeight + SHEET_TITLE_GAP);
    const gridBottom = plan.grid.y + plan.grid.height;
    expect(plan.ruler.bottomY).toBe(gridBottom);
    expect(plan.legendTop).toBe(gridBottom + SHEET_RULER_TOP + LEGEND_PAD_TOP);
    expect(SHEET_TITLE_GAP).toBeGreaterThanOrEqual(16);
    expect(LEGEND_PAD_TOP).toBeGreaterThanOrEqual(20);
  });

  it("画布高度含标题行、两条刻度带与用料条（漏算任一项都会叠字）", () => {
    const plan = planSheet(makePattern(29, 25), makePalette(13), usages(13), "小猫");
    const titleHeight = Math.round(plan.titleFontPx * SHEET_TITLE_LINE_RATIO);
    expect(plan.canvasHeight).toBe(
      SHEET_MARGIN +
        titleHeight +
        SHEET_TITLE_GAP +
        SHEET_RULER_TOP +
        plan.grid.height +
        SHEET_RULER_TOP +
        LEGEND_PAD_TOP +
        plan.legend.itemRows * plan.legend.rowHeight +
        SHEET_MARGIN,
    );
    // 逐字读数（由上面那条公式推出）：20 + 62 + 18 + 36 + 2400 + 36 + 24 + 2×60 + 20 = 2736
    expect(plan.canvasHeight).toBe(2736);
  });

  it("超长工程名：字号被压小、但不低于硬底，且标题上界落在画布内（不静默裁字）", () => {
    // **62 个全角字**（不是简报原文的 60）：48px 时上界 = ceil(60×1.05×48) + 20×48 = 3984 ≤ 可用宽 4056
    // ⇒ 60 个仍然放得下、字号不会变小，那条 `toBeLessThan(48)` 就成了空断言。62 个才是「刚好压小一格」
    // 的第一个长度（47px 时上界 4000 ≤ 4056），见实现报告 D2。
    const long = "阿".repeat(62);
    const plan = planSheet(makePattern(29, 25), makePalette(13), usages(13), long);
    expect(plan.titleFontPx).toBeLessThan(48);
    expect(plan.titleFontPx).toBeGreaterThanOrEqual(TITLE_FONT_HARD_MIN_PX);
    const bound =
      SHEET_MARGIN + estimateTextWidthPx(long, plan.titleFontPx) + SHEET_TITLE_FIXED_EM * plan.titleFontPx;
    expect(bound).toBeLessThanOrEqual(plan.canvasWidth);
  });

  it("名字长到硬底都放不下 ⇒ 响亮失败", () => {
    // **不加 `{ maxEdge: 400 }`**（简报原文有）：maxEdge 400 时 29×25 的网格本身就放不下
    // （高度预算 1071 > 400），先抛的是「可用区域 400×400 px 放不下 29×25 的图纸」——那条断言
    // 达不到它要守的 `planTitleFont` 分支。240 个全角字在**默认上限**下连 16px 都放不下
    // （16px 上界 = ceil(240×1.05×16) + 20×16 = 4352 > 4056），见实现报告 D3。
    expect(() =>
      planSheet(makePattern(29, 25), makePalette(13), usages(13), "阿".repeat(240)),
    ).toThrow(/工程名太长/);
  });

  it("工程名必须是非空字符串", () => {
    expect(() => planSheet(makePattern(4, 4), makePalette(4), [], 5 as never)).toThrow(/工程名/);
    expect(() => planSheet(makePattern(4, 4), makePalette(4), [], "   ")).toThrow(/工程名/);
  });

  it("小图纸的画布为标题让路（4×4 的网格块只有 384px 宽）", () => {
    const plan = planSheet(makePattern(4, 4), makePalette(8), usages(8), "小猫");
    const gridBlockRight = plan.grid.x + plan.grid.width + SHEET_RULER_LEFT;
    expect(plan.canvasWidth).toBeGreaterThan(gridBlockRight);
    expect(plan.canvasWidth).toBeLessThanOrEqual(EXPORT_MAX_EDGE);
    // 画布宽 = max(网格块右沿 488, 标题上界右沿 + SHEET_MARGIN)：20 + 101 + 20×48 + 20 = 1101
    expect(plan.canvasWidth).toBe(
      Math.max(gridBlockRight, SHEET_MARGIN + estimateTextWidthPx("小猫", plan.titleFontPx) + SHEET_TITLE_FIXED_EM * plan.titleFontPx + SHEET_MARGIN),
    );
  });

  it("打印页：标题 / 用料条 / 网格块三者左沿对齐（第 8 项）", () => {
    const plan = planBoardPage(makePattern(29, 29), makePalette(4), usages(4), {
      boardSize: 29,
      paper: "a4",
      index: 0,
      projectName: "小猫",
    });
    expect(plan.titleLeft).toBe(plan.grid.x - SHEET_RULER_LEFT);
    expect(plan.legend.left).toBe(plan.titleLeft);
    // **29 板 + A4 的左沿都是实测值**：格像素 59 ⇒ 网格 (405, 210)、块左沿 363（不是页边距 118）
    expect(plan.cellPx).toBe(PRINT_BEAD_PX);
    expect(plan.grid.x).toBe(405);
    expect(plan.titleLeft).toBe(363);
    // 打印版面规则一个字没动：29 板 + A4 仍是实物大小
    // **不能写 `toBeCloseTo(5, 5)`**（简报原文那一句）：`cellMm` 由取整后的 `cellPx` 推出
    // （59 / 300 × 25.4 = 4.9953…），与 5 差 0.0047 = 一个像素量化步长（见实现报告 D4）。
    expect(Math.abs(plan.cellMm - BEAD_MM)).toBeLessThanOrEqual(25.4 / PRINT_DPI / 4);
    expect(plan.scaleRatio).toBe(1);
  });

  it("打印页：纸越宽，长名字的标题字号只会更大或持平", () => {
    const name = "名字".repeat(20);
    const a4 = planBoardPage(makePattern(29, 29), makePalette(4), usages(4), {
      boardSize: 29, paper: "a4", index: 0, projectName: name,
    });
    const a3 = planBoardPage(makePattern(29, 29), makePalette(4), usages(4), {
      boardSize: 29, paper: "a3", index: 0, projectName: name,
    });
    expect(a3.titleFontPx).toBeGreaterThanOrEqual(a4.titleFontPx);
    // 前提：这个名字真的被纸宽压到了比例值以下（否则两者都会顶到 30px、比较是空的）
    expect(a4.titleFontPx).toBeLessThan(Math.round(PRINT_BEAD_PX * SHEET_TITLE_FONT_RATIO));
  });

  it("模板 em 上界不小于真实模板的估算宽（改了文案必须同步）", () => {
    const tpl = `小猫 · 116 × 116 格 · 221 色 · 13456 颗`;
    expect(SHEET_TITLE_FIXED_EM).toBeGreaterThanOrEqual(
      estimateTextWidthPx(tpl.replace("小猫", ""), 1),
    );
    // 上界的口径：`fontPx = 1` 时读数就是 em 数（29 个窄字符 + 3 个全角 = 18.95em × 1.05 ⇒ 20）
    expect(SHEET_TITLE_FIXED_EM).toBe(20);
  });
});

/**
 * C8 修复（2026-10-10 审查）：**判据必须是量出来的真实量，不能是任何上界**。
 *
 * 两个反例都来自审查者的逐式手算，实测读数写在下面。修的理由：旧的「按可用宽估用料条行数」的
 * 高度预算**低估**行数（真实换行宽更窄），C8 又把项宽 / 行高 / 标题行高一起放大，于是
 * ①画布会超出 `EXPORT_MAX_EDGE`；②打印页用料条会被静默画到纸外（连警告都没有）。
 */
describe("C8 修复：格像素按真实测量收敛（不超出画布上限 / 不越出纸面）", () => {
  const usages = (count: number): ColorUsage[] =>
    Array.from({ length: count }, (_, i) => ({ code: `C${i}`, name: `色${i}`, count: i + 1 }));

  it("30×92 + 221 色：画布宽高都 ≤ EXPORT_MAX_EDGE（旧预算会给到 4340 的高度）", () => {
    // 旧预算（已删的 `planGridScale`）算出的格像素是 30 ⇒ 用料条 45 行 × 31px ⇒ 4340 > 4096
    // （审查者按实现逐式手算）。修复后按真实测量收敛到 27：92 格 × 27 = 2484 + 45 行 × 31px = 1395
    // + 标题行 31 + 净距 18 + 两条刻度带 72 + 间隔 24 + 两侧边距 40 = 4064 ≤ 4096（28 会到 4156）。
    const plan = planSheet(makePattern(30, 92), makeBigPalette(), makeBigUsages(), PROJECT_NAME);
    expect(plan.cellPx).toBe(27);
    expect(plan.canvasWidth).toBe(914);
    expect(plan.canvasWidth).toBeLessThanOrEqual(EXPORT_MAX_EDGE);
    expect(plan.canvasHeight).toBe(4064);
    expect(plan.canvasHeight).toBeLessThanOrEqual(EXPORT_MAX_EDGE);
    // 用料条**真的**落在画布内（不是「算出来放得下、画出来越界」）
    expect(plan.legendTop + plan.legend.itemRows * plan.legend.rowHeight).toBeLessThanOrEqual(
      plan.canvasHeight,
    );
  });

  it("打印页：用料条底边不得越出可打印区下沿（旧实现静默画到纸外）", () => {
    // 审查者的反例：70×58 + 58 板 + A4 第 2 页（本页 12 列 × 58 行）+ 40 色。
    // 旧实现这一页的格像素是 55，用料条 5 行（行高 34px）⇒ 底边（审查者手算）约 3621 > 纸高 3508
    // —— 最后约 3 行画在纸外，无异常、无警告。修复后纵向判据进入收敛：51px/格时
    // `gridX 955`、`gridY 199`、用料条 9 列 × 5 行（行高 31px）⇒ 底边 3217 + 155 = 3372 ≤ 3390
    // （= 纸高 3508 − 页边距 118）；52px 会到 3430 > 3390，所以 51 是量出来的最大可行值。
    const page = planBoardPage(makePattern(70, 58), makeBigPalette(), usages(40), {
      boardSize: 58,
      paper: "a4",
      index: 1,
      projectName: PROJECT_NAME,
    });
    const marginPx = mmToPx(PRINT_MARGIN_MM);
    expect(page.cols).toBe(12);
    expect(page.rows).toBe(58);
    expect(page.cellPx).toBe(51);
    const legendBottom = page.legendTop + page.legend.itemRows * page.legend.rowHeight;
    expect(legendBottom).toBeLessThanOrEqual(page.canvasHeight - marginPx);
    // 逐字读数（由上面的公式复算）：3217 + 5 × 31 = 3372 ≤ 3508 − 118 = 3390
    expect(page.legendTop).toBe(3217);
    expect(page.legend.itemRows).toBe(5);
    expect(page.legend.rowHeight).toBe(31);
    expect(legendBottom).toBe(3372);
    // 横向三条判据也一并在（网格块含右序号带、用料条右沿都不越右页边距）
    expect(page.grid.x - SHEET_RULER_LEFT).toBeGreaterThanOrEqual(marginPx);
    expect(page.grid.x + page.grid.width + SHEET_RULER_LEFT).toBeLessThanOrEqual(
      page.canvasWidth - marginPx,
    );
    expect(page.legend.left + page.legend.itemCols * page.legend.itemWidth).toBeLessThanOrEqual(
      page.canvasWidth - marginPx,
    );
  });
});
