import { describe, expect, it } from "vitest";
import { BEAD_MM, BOARD_COLS, boardCount } from "../../pattern/board";
import type { ColorUsage } from "../../pattern/stats";
import { EMPTY, type Pattern } from "../../pattern/types";
import type { Palette } from "../../palette/types";
import {
  EXPORT_CELL_PX_TARGET,
  EXPORT_MAX_EDGE,
  LEGEND_ITEM_W,
  LEGEND_PAD_TOP,
  LEGEND_ROW_H,
  PAGE_HEADER_H,
  PAPER_MM,
  PRINT_BEAD_PX,
  PRINT_BOARD_SIZES,
  PRINT_DPI,
  PRINT_MARGIN_MM,
  SHEET_FOOTER_H,
  SHEET_INFO_BAR_H,
  SHEET_MARGIN,
  SHEET_MIN_LABEL_FONT_PX,
  SHEET_RULER_LEFT,
  SHEET_RULER_TOP,
  SHEET_TICK_FONT_MIN,
  TICK_EVERY,
  TILE_STEP,
  cellBox,
  countTileBeads,
  labelInk,
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

describe("布局常量（B4 + B6）", () => {
  it("常量值就是规格 §5.1 定的那一组（改坏即红）", () => {
    expect(EXPORT_MAX_EDGE).toBe(4096);
    expect(EXPORT_CELL_PX_TARGET).toBe(40);
    expect(TICK_EVERY).toBe(5);
    expect(LEGEND_ROW_H).toBe(22);
    expect(SHEET_MARGIN).toBe(24);
    expect(SHEET_RULER_LEFT).toBe(64);
    expect(SHEET_RULER_TOP).toBe(44);
    expect(SHEET_INFO_BAR_H).toBe(108);
    expect(SHEET_FOOTER_H).toBe(44);
    expect(LEGEND_ITEM_W).toBe(200);
    expect(SHEET_TICK_FONT_MIN).toBe(12);
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
  it("B6 新增常量逐字：板大小表 / 打印精度 / 页边距 / 纸型毫米 / 色号字号下限 / 用料条 / 页眉高", () => {
    expect(PRINT_BOARD_SIZES).toEqual([29, 58]);
    expect(PRINT_DPI).toBe(300);
    expect(PRINT_MARGIN_MM).toBe(10);
    // 纸型毫米（A4 210×297、A3 297×420）：逐字写，不从 `mmToPx` 或画布尺寸反推
    expect(PAPER_MM.a4).toEqual({ width: 210, height: 297 });
    expect(PAPER_MM.a3).toEqual({ width: 297, height: 420 });
    // 格内色号的硬下限：低于它 `planSheet` / `planBoardPage` 必须响亮失败（规格 §6.2）
    expect(SHEET_MIN_LABEL_FONT_PX).toBe(10);
    // 用料条：压缩后的项宽 / 行高（规格 §13 的常量迁移表：旧的 300 / 30 随独立用量表一起删除）
    expect(LEGEND_ITEM_W).toBe(200);
    expect(LEGEND_ROW_H).toBe(22);
    expect(PAGE_HEADER_H).toBe(72);
    // 「29 + A4 ⇒ 1 格恰为 `BEAD_MM`」这条关系：实物大小的格像素由实物参数推导，不是又一份字面量
    expect(PRINT_BEAD_PX).toBe(Math.round((BEAD_MM / 25.4) * PRINT_DPI));
  });
});

describe("cellBox：唯一映射", () => {
  const plan = planSheet(makePattern(116, 116), makePalette(), []);

  it("首格与末格的片内像素落位逐位正确", () => {
    // 前提（用例自己先钉住）：116×116 的格像素是 33，所以下面两个期望值不是「跟着实现走」的
    expect(plan.cellPx).toBe(33);
    expect(cellBox(plan, 0, 0)).toEqual({ x: 88, y: 176, width: 33, height: 33 });
    expect(cellBox(plan, 115, 115)).toEqual({
      x: 88 + 115 * 33,
      y: 176 + 115 * 33,
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
    const plan = planSheet(pattern, makePalette(), []);
    expect(countTileBeads(pattern, plan)).toBe(58 * 58 - 2);
  });

  it("片范围超出图纸时响亮拒绝（否则 cellAt 会静默返回 EMPTY、数出一个偏小的数）", () => {
    const pattern = makePattern(10, 10);
    const plan = planSheet(pattern, makePalette(), []);
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
  const single = planSheet(makePattern(58, 58), makePalette(), []);

  it("线按全局坐标分档：每格细、每 5 格主、每 29 格板（board 优先）", () => {
    // 前提：58×58 的格像素是 40（`EXPORT_CELL_PX_TARGET`），落位是 (88, 176)
    expect(single.cellPx).toBe(40);
    expect(single.vLines).toHaveLength(59);
    expect(single.vLines[0]).toEqual({ at: 88, kind: "board" });
    expect(single.vLines[1]).toEqual({ at: 88 + 40, kind: "thin" });
    expect(single.vLines[5]).toEqual({ at: 88 + 5 * 40, kind: "major" });
    expect(single.vLines[29]).toEqual({ at: 88 + 29 * 40, kind: "board" });
    // 行轴与列轴是 `makeGridGeometry` 里两段独立循环，不是彼此的副产品 ⇒ 逐位对称地钉一遍。
    expect(single.hLines).toHaveLength(59);
    expect(single.hLines[0]).toEqual({ at: 176, kind: "board" });
    expect(single.hLines[1]).toEqual({ at: 176 + 40, kind: "thin" });
    expect(single.hLines[5]).toEqual({ at: 176 + 5 * 40, kind: "major" });
    expect(single.hLines[29]).toEqual({ at: 176 + 29 * 40, kind: "board" });
    expect(single.lineWidths).toEqual({ thin: 1, major: 2, board: 3 });
  });

  it("刻度每 5 格一个、位置与全局列号一致；板边界带板序号", () => {
    expect(single.colTicks.map((t) => t.col)).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
    expect(single.colTicks[1]).toEqual({ col: 5, x: 88 + 5 * 40 });
    expect(single.rowTicks.map((t) => t.row)).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
    expect(single.rowTicks[1]).toEqual({ row: 5, y: 176 + 5 * 40 });
    expect(single.colBoards).toEqual([
      { board: 1, col: 0, x: 88 },
      { board: 2, col: 29, x: 88 + 29 * 40 },
    ]);
    expect(single.rowBoards).toEqual([
      { board: 1, row: 0, y: 176 },
      { board: 2, row: 29, y: 176 + 29 * 40 },
    ]);
  });

  /**
   * **原点非零的映射由板页用例承担**（规格 §10）：单张计划的 `originCol / originRow` 恒为 0，
   * 「只对原点为 0 成立」的错法（例如把片内坐标当全局坐标）在那里**对任何断言都不可见**
   * （2026-10-05 实测：把 `at` 里的 `− originCol` 删掉，原点为 0 的用例 30 passed / 0 红）。
   * 这里取 116×116 的第 6 页（index = 5 ⇒ 第 1 行第 1 列、列 29 行 29 起），两块板的原点都非零。
   * 落位是 29 板 + A4 的实测值：格像素 59、网格 (416, 234)。
   */
  it("原点非零的一页（列 29 / 行 29 起）的网格线、刻度与板边界仍取全局坐标", () => {
    const page = planBoardPage(makePattern(116, 116), makePalette(), [], {
      boardSize: 29,
      paper: "a4",
      index: 5,
    });
    // 前提：这一页真的带偏移（否则这条与上面两条等价、判别力是假的）
    expect(page.originCol).toBe(29);
    expect(page.originRow).toBe(29);
    expect(page.cellPx).toBe(59);

    // 列线的原点项：`at = grid.x + (col − originCol) × cellPx`，全局列号 29 / 30 / 31
    expect(page.vLines[0]).toEqual({ at: 416, kind: "board" });
    expect(page.vLines[1]).toEqual({ at: 416 + 59, kind: "major" });
    expect(page.vLines[2]).toEqual({ at: 416 + 2 * 59, kind: "thin" });
    // 刻度与板序号取**全局**格号（本页首刻度是第 30 列）、x 减掉本页原点
    expect(page.colTicks[0]).toEqual({ col: 30, x: 416 + (30 - 29) * 59 });
    expect(page.colBoards[0]).toEqual({ board: 2, col: 29, x: 416 });
    // 行轴逐位对称（同一页的行原点也是 29）
    expect(page.hLines[0]).toEqual({ at: 234, kind: "board" });
    expect(page.hLines[1]).toEqual({ at: 234 + 59, kind: "major" });
    expect(page.hLines[2]).toEqual({ at: 234 + 2 * 59, kind: "thin" });
    expect(page.rowTicks[0]).toEqual({ row: 30, y: 234 + (30 - 29) * 59 });
    expect(page.rowBoards[0]).toEqual({ board: 2, row: 29, y: 234 });
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
  it("116×116 + 221 色的最坏预算逐字钉住（30 / 11 / 4048 / 3996）", () => {
    const plan = planSheet(makePattern(116, 116), makeBigPalette(), makeBigUsages());
    // **字面量**，不是松上界：只断「>= / <=」的话，实现算出 27 / 3480 / 3800 也照样绿
    expect(plan.cellPx).toBe(30);
    expect(plan.labelFontPx).toBe(11);
    expect(plan.canvasWidth).toBe(4048);
    expect(plan.canvasHeight).toBe(3996);
    expect(plan.canvasWidth).toBeLessThanOrEqual(EXPORT_MAX_EDGE);
    expect(plan.canvasHeight).toBeLessThanOrEqual(EXPORT_MAX_EDGE);
    // 判据与实现的守卫同源（`round(cellPx × 0.38) ≥ 10`）；写成 `cellPx ≥ ceil(10/0.38)` 是更强但碰巧成立的伪关系
    expect(Math.round(plan.cellPx * 0.38)).toBeGreaterThanOrEqual(SHEET_MIN_LABEL_FONT_PX);
  });

  it("每一项用料都落在画布内（画布宽必须取「网格」与「用料条」的较大者）", () => {
    const usages = makeBigUsages();
    const plan = planSheet(makePattern(116, 116), makeBigPalette(), usages);
    for (let i = 0; i < usages.length; i += 1) {
      const left = SHEET_MARGIN + (i % plan.legend.itemCols) * plan.legend.itemWidth;
      // 数量是右对齐的：右端 = 项左沿 + 项宽 − 右内缩
      expect(left + plan.legend.itemWidth - plan.legend.countRightPad).toBeLessThanOrEqual(
        plan.canvasWidth,
      );
    }
    expect(plan.canvasWidth).toBe(
      Math.max(
        SHEET_MARGIN + SHEET_RULER_LEFT + 116 * plan.cellPx + SHEET_MARGIN,
        SHEET_MARGIN + Math.min(plan.legend.itemCols, usages.length) * plan.legend.itemWidth + SHEET_MARGIN,
      ),
    );
    // 小图纸不许被用料条无谓撑宽：4 色 1 行 ⇒ 只按用到的 4 列算
    const small = planSheet(makePattern(4, 2), makePalette(), makeUsages());
    expect(small.canvasWidth).toBe(
      Math.max(
        SHEET_MARGIN + SHEET_RULER_LEFT + 4 * small.cellPx + SHEET_MARGIN,
        SHEET_MARGIN + Math.min(small.legend.itemCols, 4) * small.legend.itemWidth + SHEET_MARGIN,
      ),
    );
    expect(small.canvasWidth).toBeLessThan(1000);
  });

  it("小图纸取 40 px/格上限（不会被放大到画布上限）", () => {
    const plan = planSheet(makePattern(4, 2), makePalette(), makeUsages());
    expect(plan.cellPx).toBe(EXPORT_CELL_PX_TARGET);
    expect(plan.labelFontPx).toBe(Math.round(EXPORT_CELL_PX_TARGET * 0.38));
  });

  it("画布上限太小 ⇒ 响亮失败：两种失败各有专门消息，用户可见文本里不出现负数格像素", () => {
    // ① `cellPx < 1`（本用例走的是「用料条把可用高度吃光 ⇒ `innerH` 为负」那一支）：消息必须直接说
    //    「放不下」，**不许**把 `-1 px` 这种噪声写进用户可见文本（2026-10-08 修）。
    //    **括注只许中性**（2026-10-08 收口）：同一分支还有「高度够但装不下这么多行」的入口
    //    （116×116 + `maxEdge: 300` ⇒ `innerH = 26 > 0`），写死一种原因会失实 ⇒ 判据收在中性措辞上。
    let message = "";
    try {
      planSheet(makePattern(116, 116), makeBigPalette(), makeBigUsages(), { maxEdge: 1200 });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/^画布上限 1200 px 的可用区域放不下 116×116 的图纸$/);
    expect(message).not.toMatch(/扣掉用料条|没有可用高度/);
    expect(message).not.toMatch(/-\d+ px/);
    // ② 放得下、但格子小到色号不可读：这一支仍然报出格像素与字号下限（两种失败不许混成同一句）
    expect(() =>
      planSheet(makePattern(116, 116), makePalette(), makeUsages(), { maxEdge: 3100 }),
    ).toThrow(/每格只有 24 px、色号字号 9 px，低于下限 10 px/);
  });

  it("画布上限连网格的横向起点都放不下（`innerW < 1`）⇒ 专门消息，且排在其他守卫之前", () => {
    // `innerW = maxEdge − 2 × SHEET_MARGIN − SHEET_RULER_LEFT = maxEdge − 112`：112 是它的零点，
    // 取 100 就是负数。这一支此前零用例（终审发现）——删掉那三行后，同样的输入会改报
    // 「可用区域放不下 6×6 的图纸」（`cellPx < 1` 那条），即消息失实而全套仍绿。
    expect(() => planSheet(makePattern(6, 6), makePalette(), makeUsages(), { maxEdge: 100 })).toThrow(
      "画布上限 100 px 太小，无法生成施工图",
    );
  });

  it("用料条的列数随可用宽变化、行数随色数变化，且 top 落在网格下沿", () => {
    const pattern = makePattern(6, 6);
    const plan = planSheet(pattern, makePalette(), makeUsages());
    expect(plan.legend.itemCols).toBe(Math.floor((EXPORT_MAX_EDGE - 2 * SHEET_MARGIN) / LEGEND_ITEM_W));
    expect(plan.legend.itemRows).toBe(Math.ceil(makeUsages().length / plan.legend.itemCols));
    expect(plan.legend.top).toBe(plan.grid.y + plan.grid.height + LEGEND_PAD_TOP);
    expect(plan.canvasHeight).toBe(
      plan.legend.top + plan.legend.itemRows * LEGEND_ROW_H + SHEET_FOOTER_H + SHEET_MARGIN,
    );
  });

  it("色号必须经 cellBox 取位：越界格抛错（计划与渲染共用的唯一映射）", () => {
    const plan = planSheet(makePattern(6, 6), makePalette(), makeUsages());
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
        planSheet(makePattern(4, 4), makePalette(), [], { maxEdge: bad as unknown as number }),
      ).toThrow("画布上限必须是 ≥1 的整数");
    }
    expect(() => planSheet(makePattern(4, 4), { ...makePalette(), id: "other" }, [])).toThrow(
      "与传入的色卡 other 不一致",
    );
    const broken = makePattern(4, 4);
    const short = { ...broken, cells: new Uint16Array(15) };
    expect(() => planSheet(short, makePalette(), [])).toThrow("需要 16 格，实际 15 格");
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
        planBoardPage(makePattern(29, 29), makePalette(), makeUsages(), { boardSize: 29, paper, index: 0 }),
      ).not.toThrow();
    }
    for (const paper of ["a5", "A4", "", "b5"]) {
      expect(() =>
        planBoardPage(makePattern(29, 29), makePalette(), makeUsages(), { boardSize: 29, paper, index: 0 }),
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
    });
    expect(plan.scaleRatio).toBeLessThan(0.7);
  });

  it("最后一页 / 列收窄，且页与页不重叠", () => {
    const pattern = makePattern(100, 30);
    const plan = planBoardPage(pattern, makePalette(), makeUsages(), { boardSize: 29, paper: "a4", index: 3 });
    // 100 = 29×3 + 13 ⇒ 第 3 列（index 3，0 起）覆盖列 87–99，行 0–28
    expect(plan.originCol).toBe(87);
    expect(plan.cols).toBe(13);
    expect(plan.originRow).toBe(0);
    expect(plan.rows).toBe(29);
  });

  it("页索引越界 / 枚举非法 ⇒ 抛错（不静默取模、不回落默认值）", () => {
    expect(() =>
      planBoardPage(makePattern(30, 30), makePalette(), makeUsages(), { boardSize: 29, paper: "a4", index: 4 }),
    ).toThrow(/页索引/);
    expect(() =>
      planBoardPage(makePattern(30, 30), makePalette(), makeUsages(), {
        boardSize: 30 as unknown as 29,
        paper: "a4",
        index: 0,
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
    { paper: "a3" as const, boardSize: BOARD_COLS * 2, expectedCellPx: 55, ratioMin: 0.9, ratioMax: 1 },
    { paper: "a4" as const, boardSize: BOARD_COLS * 2, expectedCellPx: 37, ratioMin: 0, ratioMax: 0.7 },
  ])(
    "$boardSize 格板 + $paper：画布就是纸型像素、四边留白 ≥ PRINT_MARGIN_MM，缩放比落在 [$ratioMin, $ratioMax]",
    ({ paper, boardSize, expectedCellPx, ratioMin, ratioMax }) => {
      const plan = planBoardPage(makePattern(boardSize * 2, boardSize * 2), makePalette(), makeUsages(), {
        boardSize,
        paper,
        index: 0,
      });
      const marginPx = mmToPx(PRINT_MARGIN_MM);
      expect(plan.canvasWidth).toBe(mmToPx(PAPER_MM[paper].width));
      expect(plan.canvasHeight).toBe(mmToPx(PAPER_MM[paper].height));
      // `cellPx` 的逐位真值：钉住宽度预算那处修复（29 板两例仍是实物大小的 59、58 板两例是 55 / 37）
      expect(plan.cellPx).toBe(expectedCellPx);
      expect(plan.cellPx).toBeLessThanOrEqual(PRINT_BEAD_PX); // 「永不放大超过实物」在四组合下都成立
      // **逐边**断言（第 2 轮修正）：网格带 = 左刻度带 + 网格，两端的留白都必须 ≥ 页边距。
      // 修复前 58 板两例的右侧只有 98 / 106 px（刻度与板号落进不可打印区）——那时这两条会红。
      expect(plan.grid.x - SHEET_RULER_LEFT).toBeGreaterThanOrEqual(marginPx);
      expect(plan.grid.x + plan.grid.width).toBeLessThanOrEqual(plan.canvasWidth - marginPx);
      expect(plan.grid.y).toBeGreaterThanOrEqual(marginPx);
      expect(plan.canvasHeight - (plan.grid.y + plan.grid.height)).toBeGreaterThanOrEqual(marginPx);
      // 页眉在最上留白之内，且不压住含刻度带的网格（`PAGE_HEADER_H` 必须真的被预算用上）
      expect(plan.infoBar.lineOneY).toBe(marginPx);
      expect(plan.grid.y).toBeGreaterThanOrEqual(plan.infoBar.lineOneY + PAGE_HEADER_H);
      expect(plan.scaleRatio).toBeGreaterThanOrEqual(ratioMin);
      expect(plan.scaleRatio).toBeLessThanOrEqual(ratioMax);
    },
  );
});
