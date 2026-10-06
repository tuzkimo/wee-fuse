import { describe, expect, it } from "vitest";
import { BOARD_COLS } from "../../pattern/board";
import type { ColorUsage } from "../../pattern/stats";
import { EMPTY, type Pattern } from "../../pattern/types";
import type { Palette } from "../../palette/types";
import {
  EXPORT_CELL_PX_FLOOR,
  EXPORT_CELL_PX_TARGET,
  EXPORT_MAX_EDGE,
  LEGEND_COLS_MAX,
  LEGEND_ITEM_W,
  LEGEND_ROW_H,
  SHEET_FOOTER_H,
  SHEET_INFO_BAR_H,
  SHEET_LABEL_MIN_CELL_PX,
  SHEET_MARGIN,
  SHEET_RULER_LEFT,
  SHEET_RULER_TOP,
  SHEET_TICK_FONT_MIN,
  SHARE_CELL_PX_MAX,
  SHARE_CELL_PX_MIN,
  SHARE_MAX_EDGE,
  TICK_EVERY,
  TILE_STEP,
  cellBox,
  countTileBeads,
  labelInk,
  planLegend,
  planShare,
  planSheets,
  rgbCss,
  shareCellBox,
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

describe("B4 布局常量", () => {
  it("常量值就是规格 §5.1 定的那一组（改坏即红）", () => {
    expect(EXPORT_MAX_EDGE).toBe(4096);
    expect(EXPORT_CELL_PX_TARGET).toBe(40);
    expect(SHEET_LABEL_MIN_CELL_PX).toBe(32);
    expect(EXPORT_CELL_PX_FLOOR).toBe(8);
    expect(SHARE_MAX_EDGE).toBe(2048);
    expect(SHARE_CELL_PX_MIN).toBe(4);
    expect(SHARE_CELL_PX_MAX).toBe(64);
    expect(TICK_EVERY).toBe(5);
    expect(LEGEND_ROW_H).toBe(30);
    expect(SHEET_MARGIN).toBe(24);
    expect(SHEET_RULER_LEFT).toBe(64);
    expect(SHEET_RULER_TOP).toBe(44);
    expect(SHEET_INFO_BAR_H).toBe(108);
    expect(SHEET_FOOTER_H).toBe(44);
    expect(LEGEND_ITEM_W).toBe(300);
    expect(LEGEND_COLS_MAX).toBe(15);
    expect(SHEET_TICK_FONT_MIN).toBe(12);
    // 分片步长必须来自 board.ts，不是另一份字面量 29
    expect(TILE_STEP).toBe(BOARD_COLS);
    expect(TILE_STEP).toBe(29);
    // **常量关系**（修复波 A-m1）：`planSheets` 的 `labels` 判据用的是 `SHEET_LABEL_MIN_CELL_PX`，
    // 而最终格像素是 `min(rawCellPx, EXPORT_CELL_PX_TARGET)` ⇒ 目标格像素**必须不低于**色号阈值，
    // 否则「含格内色号」这句话会在低于可读阈值的格像素上说出来（`labels` 为真、实际画不下）。
    expect(EXPORT_CELL_PX_TARGET).toBeGreaterThanOrEqual(SHEET_LABEL_MIN_CELL_PX);
    expect(EXPORT_CELL_PX_FLOOR).toBeLessThanOrEqual(SHEET_LABEL_MIN_CELL_PX);
  });
});

describe("planSheets：单张", () => {
  it("58×58 是 1 张、40 px/格、含色号", () => {
    const plan = planSheets(makePattern(58, 58), makePalette());
    expect(plan.kind).toBe("sheet");
    expect(plan.tiles).toHaveLength(1);
    expect(plan.cellPx).toBe(40);
    expect(plan.labels).toBe(true);
    expect(plan.tileCols).toBe(58);
    expect(plan.tileRows).toBe(58);
    expect(plan.warnings).toEqual([]);
    const tile = plan.tiles[0]!;
    expect(tile.canvasWidth).toBe(2432);
    expect(tile.canvasHeight).toBe(2564);
    expect(tile.grid).toEqual({ x: 88, y: 176, width: 2320, height: 2320 });
    expect(tile.index).toBe(0);
    expect(tile.rowIndex).toBe(0);
    expect(tile.colIndex).toBe(0);
    // 派生字号（渲染器只许读它们、不许自己乘格像素）：40 × 0.38 = 15.2 → 15；
    // 40 × 0.3 = 12，恰好等于 SHEET_TICK_FONT_MIN 的下限。
    expect(tile.labelFontPx).toBe(15);
    expect(tile.tickFontPx).toBe(SHEET_TICK_FONT_MIN);
  });

  it("116×116 仍是 1 张，格像素被两轴取小压到 33", () => {
    const plan = planSheets(makePattern(116, 116), makePalette());
    expect(plan.tiles).toHaveLength(1);
    expect(plan.cellPx).toBe(33);
    expect(plan.labels).toBe(true);
    expect(plan.tiles[0]!.canvasWidth).toBe(3940);
    expect(plan.tiles[0]!.canvasHeight).toBe(4072);
    // 33 × 0.38 = 12.54 → 13；33 × 0.3 = 9.9 → 10，被 SHEET_TICK_FONT_MIN 抬到 12
    //（这一条与上一条合起来证明下限真的生效，而不是恰好等于比例值）。
    expect(plan.tiles[0]!.labelFontPx).toBe(13);
    expect(plan.tiles[0]!.tickFontPx).toBe(SHEET_TICK_FONT_MIN);
  });
});

describe("planSheets：分片", () => {
  it("200×200 分成 4 张，逐格恰好被一片覆盖（无重叠无缺口）", () => {
    const plan = planSheets(makePattern(200, 200), makePalette());
    expect(plan.tiles).toHaveLength(4);
    for (const tile of plan.tiles) {
      expect(tile.cols).toBeLessThanOrEqual(plan.tileCols);
      expect(tile.rows).toBeLessThanOrEqual(plan.tileRows);
      expect(tile.originCol % TILE_STEP).toBe(0);
      expect(tile.originRow % TILE_STEP).toBe(0);
    }
    // **普通数组，不是 `Uint8Array`**（修复波 C-M3）：`Uint8Array` 的越界写会被**静默丢弃**，
    // 于是「`Math.min(tileCols, pattern.width - originCol)` 被删掉」这类越界覆盖在旧写法下全绿。
    // 普通数组会因越界写把长度撑大、把洞留成 0 / `NaN`，两种都会被下面两条抓住。
    const coverage: number[] = Array.from({ length: 200 * 200 }, () => 0);
    for (const tile of plan.tiles) {
      for (let row = tile.originRow; row < tile.originRow + tile.rows; row += 1) {
        for (let col = tile.originCol; col < tile.originCol + tile.cols; col += 1) {
          coverage[row * 200 + col] += 1;
        }
      }
    }
    expect(coverage).toHaveLength(200 * 200);
    expect(coverage.every((n) => n === 1)).toBe(true);
  });

  it("500×500 分成 25 张、每片 116 格、33 px/格", () => {
    const plan = planSheets(makePattern(500, 500), makePalette());
    expect(plan.tiles).toHaveLength(25);
    expect(plan.tileCols).toBe(116);
    expect(plan.tileRows).toBe(116);
    expect(plan.cellPx).toBe(33);
    expect(plan.tiles.map((t) => t.index)).toEqual(Array.from({ length: 25 }, (_, i) => i));
    expect(plan.tiles[5]!.rowIndex).toBe(1);
    expect(plan.tiles[5]!.colIndex).toBe(0);
    expect(plan.tiles[24]!.rowIndex).toBe(4);
    expect(plan.tiles[24]!.colIndex).toBe(4);
  });

  it("末片取剩余格数（200 的第二列片是 84 格，两轴各钉一遍）", () => {
    const plan = planSheets(makePattern(200, 200), makePalette());
    const right = plan.tiles[1]!;
    expect(right.originCol).toBe(116);
    expect(right.cols).toBe(84);
    expect(right.canvasWidth).toBe(2 * SHEET_MARGIN + SHEET_RULER_LEFT + 84 * plan.cellPx);
    // **行轴同样要等值断言**（修复波 C-M3）：只断列轴时，`rows` 上少写
    // `Math.min(tileRows, pattern.height - originRow)` 不会有任何用例变红（200 − 116 ≠ tileRows）。
    const last = plan.tiles[3]!;
    expect(last.originRow).toBe(116);
    expect(last.rows).toBe(84);
    expect(last.canvasHeight).toBe(
      2 * SHEET_MARGIN + SHEET_INFO_BAR_H + SHEET_RULER_TOP + 84 * plan.cellPx + SHEET_FOOTER_H,
    );
    // 行轴的「剩余格数」真的不等于整片行数（否则上面那条与「rows = tileRows」不可区分）
    expect(last.rows).toBeLessThan(plan.tileRows);
  });
});

describe("planSheets：色号阈值与降级链", () => {
  it("maxEdge = 1200 时 cellPx 恰好 32 且仍画色号", () => {
    const plan = planSheets(makePattern(500, 500), makePalette(), { maxEdge: 1200 });
    expect(plan.cellPx).toBe(32);
    expect(plan.labels).toBe(true);
    expect(plan.tiles).toHaveLength(324);
  });

  it("maxEdge = 1143 时 cellPx = 31、省略色号、给出结构化 warning", () => {
    const plan = planSheets(makePattern(500, 500), makePalette(), { maxEdge: 1143 });
    expect(plan.cellPx).toBe(31);
    expect(plan.labels).toBe(false);
    expect(plan.warnings).toEqual([{ code: "labels-omitted", maxEdge: 1143, cellPx: 31 }]);
  });

  it("20×20、maxEdge = 1040：labels 按实际片格数判，不因整板粒度误降级", () => {
    // innerW = 1040 − 2×24 − 64 = 928；innerH = 1040 − 48 − 108 − 44 − 44 = 796。
    // 旧判据（`kc ≥ 1 && kr ≥ 1`，整板粒度）算出 `kr = floor(796/928) = 0` ⇒ 误判 labels = false、
    // cellPx 被 `hi = 31` 压到 27（丢色号）；实际片宽只要 `20 × 32 = 640 ≤ 928` 且 `≤ 796`。
    // 新判据按实际片格数 ⇒ labels = true，cellPx = min(floor(928/20)=46, floor(796/20)=39) = 39。
    const plan = planSheets(makePattern(20, 20), makePalette(), { maxEdge: 1040 });
    expect(plan.tileCols).toBe(20);
    expect(plan.tileRows).toBe(20);
    expect(plan.labels).toBe(true);
    expect(plan.cellPx).toBe(39);
    expect(plan.warnings).toEqual([]);
  });

  it("maxEdge 显式传 null 不算「没传」：响亮失败，而不是静默回落默认上限", () => {
    expect(() =>
      planSheets(makePattern(4, 4), makePalette(), { maxEdge: null as unknown as number }),
    ).toThrow("画布上限必须是 ≥1 的整数");
  });

  it("降级链全部失败时响亮拒绝（maxEdge = 320）", () => {
    expect(() => planSheets(makePattern(500, 500), makePalette(), { maxEdge: 320 })).toThrow(
      "连 8 px/格 都放不下",
    );
  });

  it("maxEdge 非法（NaN / 小数 / 0 / 负数）一律抛", () => {
    for (const bad of [Number.NaN, 4096.5, 0, -1]) {
      expect(() => planSheets(makePattern(4, 4), makePalette(), { maxEdge: bad })).toThrow(
        "画布上限必须是 ≥1 的整数",
      );
    }
  });

  it("图纸 / 色卡的入口守卫", () => {
    expect(() => planSheets(makePattern(4, 4), { ...makePalette(), id: "other" })).toThrow(
      "与传入的色卡 other 不一致",
    );
    const broken = makePattern(4, 4);
    const short = { ...broken, cells: new Uint16Array(15) };
    expect(() => planSheets(short, makePalette())).toThrow("需要 16 格，实际 15 格");
  });
});

describe("cellBox：唯一映射", () => {
  const plan = planSheets(makePattern(200, 200), makePalette());
  const first = plan.tiles[0]!;
  const fourth = plan.tiles[3]!;

  it("片内四角逐位正确", () => {
    expect(cellBox(first, 0, 0)).toEqual({ x: 88, y: 176, width: 33, height: 33 });
    expect(cellBox(first, 115, 115)).toEqual({ x: 88 + 115 * 33, y: 176 + 115 * 33, width: 33, height: 33 });
    expect(cellBox(fourth, 116, 116)).toEqual({ x: 88, y: 176, width: 33, height: 33 });
    expect(cellBox(fourth, 199, 199)).toEqual({ x: 88 + 83 * 33, y: 176 + 83 * 33, width: 33, height: 33 });
  });

  it("跨计划不变量：同一格在单张与分片计划里落到同一片内像素", () => {
    const single = planSheets(makePattern(116, 116), makePalette());
    const tiled = planSheets(makePattern(500, 500), makePalette());
    // 前提：两次计划的 cellPx 相同（不同就无从比较——测试自己先钉住这个前提）
    expect(single.cellPx).toBe(33);
    expect(tiled.cellPx).toBe(33);
    for (const [col, row] of [[0, 0], [7, 13], [115, 115]] as const) {
      expect(cellBox(tiled.tiles[0]!, col, row)).toEqual(cellBox(single.tiles[0]!, col, row));
    }
    // **原点非零的片才是这条不变量的判别力所在**（2026-10-05 实测）：`tiles[0]` 的
    // `originCol/originRow` 恒为 0，两边去掉 `− originCol` / `− originRow` 后表达式仍相同 ⇒
    // M1 变异下上面那个循环**全绿**。所以要拿一片真正带偏移的片（第 1 行第 1 列片，原点 116）比对：
    // 它落在同一片内像素（88, 176）——分片只是「换个原点」，不是另一套数学。
    expect(cellBox(tiled.tiles[6]!, 116, 116)).toEqual({ x: 88, y: 176, width: 33, height: 33 });
    expect(cellBox(tiled.tiles[6]!, 199, 199)).toEqual({
      x: 88 + 83 * 33,
      y: 176 + 83 * 33,
      width: 33,
      height: 33,
    });
  });

  it("越界与非安全整数一律抛（不静默取整、不夹取）", () => {
    expect(() => cellBox(first, 116, 0)).toThrow("列 116 不在本片范围 0–115 内");
    expect(() => cellBox(first, 0, 116)).toThrow("行 116 不在本片范围 0–115 内");
    expect(() => cellBox(first, -1, 0)).toThrow("列 -1 不在本片范围 0–115 内");
    expect(() => cellBox(first, 1.5, 0)).toThrow("格子列号必须是安全整数");
    expect(() => cellBox(first, 0, 2 ** 53)).toThrow("格子行号必须是安全整数");
  });
});

describe("countTileBeads", () => {
  it("只数本片的实心格（空格不计）", () => {
    const pattern = makePattern(58, 58, 0);
    pattern.cells[0] = EMPTY;
    pattern.cells[1] = EMPTY;
    const plan = planSheets(pattern, makePalette());
    expect(countTileBeads(pattern, plan.tiles[0]!)).toBe(58 * 58 - 2);
  });

  it("片范围超出图纸时响亮拒绝（否则 cellAt 会静默返回 EMPTY、数出一个偏小的数）", () => {
    const pattern = makePattern(10, 10);
    const plan = planSheets(pattern, makePalette());
    const broken = { ...plan.tiles[0]!, cols: 20 };
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
  it("线按全局坐标分档：每格细、每 5 格主、每 29 格板（board 优先）", () => {
    const tile = planSheets(makePattern(58, 58), makePalette()).tiles[0]!;
    expect(tile.vLines).toHaveLength(59);
    expect(tile.vLines[0]).toEqual({ at: 88, kind: "board" });
    expect(tile.vLines[1]).toEqual({ at: 88 + 40, kind: "thin" });
    expect(tile.vLines[5]).toEqual({ at: 88 + 5 * 40, kind: "major" });
    expect(tile.vLines[29]).toEqual({ at: 88 + 29 * 40, kind: "board" });
    // 行轴与列轴是 `makeTile` 里两段独立循环，不是彼此的副产品 ⇒ 逐位对称地钉一遍。
    expect(tile.hLines).toHaveLength(59);
    expect(tile.hLines[0]).toEqual({ at: 176, kind: "board" });
    expect(tile.hLines[1]).toEqual({ at: 176 + 40, kind: "thin" });
    expect(tile.hLines[5]).toEqual({ at: 176 + 5 * 40, kind: "major" });
    expect(tile.hLines[29]).toEqual({ at: 176 + 29 * 40, kind: "board" });
    expect(tile.lineWidths).toEqual({ thin: 1, major: 2, board: 3 });
  });

  it("刻度每 5 格一个、位置与全局列号一致；板边界带板序号", () => {
    const tile = planSheets(makePattern(58, 58), makePalette()).tiles[0]!;
    expect(tile.colTicks.map((t) => t.col)).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
    expect(tile.colTicks[1]).toEqual({ col: 5, x: 88 + 5 * 40 });
    expect(tile.rowTicks.map((t) => t.row)).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
    expect(tile.rowTicks[1]).toEqual({ row: 5, y: 176 + 5 * 40 });
    expect(tile.colBoards).toEqual([
      { board: 1, col: 0, x: 88 },
      { board: 2, col: 29, x: 88 + 29 * 40 },
    ]);
    expect(tile.rowBoards).toEqual([
      { board: 1, row: 0, y: 176 },
      { board: 2, row: 29, y: 176 + 29 * 40 },
    ]);
  });

  it("分片时刻度与板边界仍取全局坐标，不是片内相对坐标", () => {
    const plan = planSheets(makePattern(500, 500), makePalette());
    const second = plan.tiles[1]!; // 第 0 行第 1 列片：列 116–231
    expect(second.originCol).toBe(116);
    // 列线的原点项（F1）：只断言原点为 0 的片时，`at` 里那个 `− originCol` 对**任何断言都不可见**
    // （实测：把它改成 `grid.x + col * cellPx` 在补这两条之前是 30 passed / 0 红）。
    expect(second.vLines[0]).toEqual({ at: 88, kind: "board" });
    expect(second.vLines[1]).toEqual({ at: 88 + 33, kind: "thin" });
    expect(second.colTicks[0]).toEqual({ col: 120, x: 88 + (120 - 116) * 33 });
    expect(second.colBoards[0]).toEqual({ board: 5, col: 116, x: 88 });
    // 行轴另取一片（第 1 行第 0 列片：行 116–231）——行轴的板序号 / 刻度同样按全局行号取，
    // 且同样要减掉本片原点行号。
    const below = plan.tiles[5]!;
    expect(below.originRow).toBe(116);
    expect(below.rowTicks[0]).toEqual({ row: 120, y: 176 + (120 - 116) * 33 });
    expect(below.rowBoards[0]).toEqual({ board: 5, row: 116, y: 176 });
    // 行线的像素位置同样要减掉本片原点行号（只断言原点为 0 的那张是判不开 `− originRow` 的）。
    expect(below.hLines[0]).toEqual({ at: 176, kind: "board" });
    expect(below.hLines[1]).toEqual({ at: 176 + 33, kind: "thin" });
  });
});

describe("planLegend", () => {
  const usages = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ code: `A${i + 1}`, name: `色 ${i + 1}`, count: i + 1 }));

  it("221 色在 4096 上限下排成 13 列 17 行", () => {
    const plan = planLegend(usages(221));
    expect(plan.kind).toBe("legend");
    expect(plan.itemCols).toBe(13);
    expect(plan.itemRows).toBe(17);
    expect(plan.canvasWidth).toBe(2 * SHEET_MARGIN + 13 * 300);
    expect(plan.canvasHeight).toBe(2 * SHEET_MARGIN + SHEET_INFO_BAR_H + 17 * LEGEND_ROW_H + 44);
  });

  it("空用量表只有信息条与合计（0 行）", () => {
    const plan = planLegend([]);
    expect(plan.itemRows).toBe(0);
    expect(plan.canvasHeight).toBe(2 * SHEET_MARGIN + SHEET_INFO_BAR_H + 44);
  });

  it("项非法或色号重复一律抛", () => {
    expect(() => planLegend([{ code: "", name: "x", count: 1 }])).toThrow("用量表第 0 项的 code 非法");
    expect(() => planLegend([{ code: "A1", name: "x", count: -1 }])).toThrow("用量表第 0 项的 count 非法");
    expect(() =>
      planLegend([
        { code: "A1", name: "x", count: 1 },
        { code: "A1", name: "y", count: 2 },
      ]),
    ).toThrow("用量表里的色号重复：A1");
    // 非数组：`usages` 是外部输入（如 `JSON.parse` 的结果），TS 类型挡不住它；
    // 这是 `requireUsages` 的第一道守卫，消息逐字见契约 §3。
    expect(() => planLegend(null as unknown as ColorUsage[])).toThrow("用量表必须是数组");
    expect(() => planLegend({ length: 1 } as unknown as ColorUsage[])).toThrow("用量表必须是数组");
  });

  it("上限太小放不下时响亮拒绝", () => {
    expect(() => planLegend(usages(221), { maxEdge: 256 })).toThrow("太小，无法生成用量表");
  });
});

describe("planShare 与 shareCellBox", () => {
  it("长边夹到上限；小图纸不放大超过 64 px/格", () => {
    const big = planShare(makePattern(500, 500));
    expect(big.kind).toBe("share");
    expect(big.cellPx).toBe(4);
    expect(big.cols).toBe(500);
    expect(big.rows).toBe(500);
    expect(big.canvasWidth).toBe(2000);
    expect(big.canvasHeight).toBe(2000);
    expect(planShare(makePattern(58, 44)).cellPx).toBe(35);
    expect(planShare(makePattern(58, 44)).canvasWidth).toBe(58 * 35);
    expect(planShare(makePattern(58, 44)).canvasHeight).toBe(44 * 35);
    expect(planShare(makePattern(8, 8)).cellPx).toBe(SHARE_CELL_PX_MAX);
    expect(planShare(makePattern(8, 8)).canvasWidth).toBe(512);
  });

  it("shareCellBox 是分享图格像素的唯一来源（无条件边距）", () => {
    const plan = planShare(makePattern(500, 500));
    expect(shareCellBox(plan, 0, 0)).toEqual({ x: 0, y: 0, width: 4, height: 4 });
    expect(shareCellBox(plan, 499, 499)).toEqual({ x: 1996, y: 1996, width: 4, height: 4 });
    expect(shareCellBox(plan, 7, 3)).toEqual({ x: 28, y: 12, width: 4, height: 4 });
  });

  it("shareCellBox 的守卫与 cellBox 同口径", () => {
    const plan = planShare(makePattern(8, 8));
    expect(() => shareCellBox(plan, 8, 0)).toThrow("列 8 不在分享图范围 0–7 内");
    expect(() => shareCellBox(plan, 0, 8)).toThrow("行 8 不在分享图范围 0–7 内");
    expect(() => shareCellBox(plan, -1, 0)).toThrow("列 -1 不在分享图范围 0–7 内");
    expect(() => shareCellBox(plan, 0.5, 0)).toThrow("格子列号必须是安全整数");
    expect(() => shareCellBox(plan, 0, 2 ** 53)).toThrow("格子行号必须是安全整数");
    // 计划的格像素同样在这里守（修复波 A-m11）：`drawShare` 靠动笔前的这一次调用拿到这条校验，
    // 而渲染器自己按闸门第 1 条不许读 `cellPx`。
    for (const bad of [0, -3, 1.5, Number.NaN]) {
      expect(() => shareCellBox({ ...plan, cellPx: bad }, 0, 0)).toThrow(
        `分享图计划的格像素非法：${String(bad)}（必须是 ≥1 的安全整数）`,
      );
    }
  });

  it("上限连 4 px/格 都放不下时抛", () => {
    expect(() => planShare(makePattern(500, 500), { maxEdge: 64 })).toThrow("太小，无法生成分享图");
  });
});
