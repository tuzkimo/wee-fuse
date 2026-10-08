import { describe, expect, it } from "vitest";
import type { Palette } from "../../palette/types";
import type { ColorUsage } from "../../pattern/stats";
import { EMPTY, type Pattern } from "../../pattern/types";
import {
  SHEET_FOOTER_H,
  SHEET_INFO_BAR_H,
  SHEET_MARGIN,
  SHEET_RULER_LEFT,
  SHEET_RULER_TOP,
  cellBox,
  planLegend,
  planSheet,
  planSheets,
  planShare,
  rgbCss,
  type LegendPlan,
  type SheetPlan,
  type SheetTilePlan,
  type TileGeometry,
} from "../layout";
import { drawLegend, drawSheet, drawSheetTile, type SheetMeta } from "../sheet";
import { createMockTarget, type MockCalls } from "./helpers";

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
    projectName: "测试工程",
    generatedAt: "2026-10-05 12:00",
    totalBeads: 33,
    colorCount: 4,
    paletteName: "测试色卡",
    accuracy: "屏幕色仅供参考，以实物为准",
    ...overrides,
  };
}

/** 独立的实心格计数（**不用** `countTileBeads` / `cellAt`：期望值必须与被测实现不同源）。 */
function solidInRange(
  pattern: Pattern,
  originCol: number,
  originRow: number,
  cols: number,
  rows: number,
): number {
  let count = 0;
  for (let row = originRow; row < originRow + rows; row += 1) {
    for (let col = originCol; col < originCol + cols; col += 1) {
      if ((pattern.cells[row * pattern.width + col] as number) !== EMPTY) count += 1;
    }
  }
  return count;
}

function solidInTile(pattern: Pattern, tile: SheetTilePlan): number {
  return solidInRange(pattern, tile.originCol, tile.originRow, tile.cols, tile.rows);
}

/**
 * 只取落在 `plan.grid` **内部**的文字。
 *
 * **这条过滤是必须的，不是洁癖**：`labels = false` 时信息条 / 刻度 / 板号 / 页脚都还在写字，
 * `expect(calls.texts).toEqual([])` 这种写法永远是假绿——它根本没读到「格区域内没有色号」
 * 这条真正要守的性质。渲染器用例里任何关于「格内色号」的断言都必须经过本函数。
 *
 * 入参只要求 `TileGeometry`（= 网格几何 + 本片格范围）：分片计划与单张计划（B6）都用它。
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

function fillAt(calls: MockCalls, x: number, y: number) {
  return calls.fills.find((fill) => fill.x === x && fill.y === y);
}

/**
 * 细线组应有的 `ops` 序列（K1）。
 *
 * **期望值只拼槽位、不重算渲染器算法**：竖线是 `(line.at, grid.y) → (line.at, grid.y + grid.height)`，
 * 横线是 `(grid.x, line.at) → (grid.x + grid.width, line.at)`，末尾一次 `stroke`。`vLines` / `hLines` /
 * `grid` 各自的**值**由 `layout.test.ts` 独立钉住，所以这一条断的是「渲染器把哪个数放进哪个槽」。
 */
function thinGridOps(tile: SheetTilePlan): readonly Record<string, unknown>[] {
  return [
    ...tile.vLines
      .filter((line) => line.kind === "thin")
      .flatMap((line) => [
        { op: "moveTo", x: line.at, y: tile.grid.y },
        { op: "lineTo", x: line.at, y: tile.grid.y + tile.grid.height },
      ]),
    ...tile.hLines
      .filter((line) => line.kind === "thin")
      .flatMap((line) => [
        { op: "moveTo", x: tile.grid.x, y: line.at },
        { op: "lineTo", x: tile.grid.x + tile.grid.width, y: line.at },
      ]),
    { op: "stroke" },
  ];
}

/** 取某张片子的细线组路径（线宽 = thin 且墨色 = 网格线色）。 */
function thinPathOf(calls: MockCalls, tile: SheetTilePlan) {
  return calls.paths.find(
    (path) => path.lineWidth === tile.lineWidths.thin && path.strokeStyle === "#0f172a",
  );
}

describe("drawSheetTile：底色、色块与文字", () => {
  const pattern = makePattern(6, 6, CELLS_6X6);
  const palette = makePalette();
  const plan = planSheets(pattern, palette);
  const tile = plan.tiles[0] as SheetTilePlan;

  it("夹具锚点：6×6 里有 33 个实心格、3 个空格（后面所有次数都由它推出）", () => {
    expect(solidInTile(pattern, tile)).toBe(33);
    expect(pattern.cells.length - solidInTile(pattern, tile)).toBe(3);
    expect(tile.grid).toEqual({ x: 88, y: 176, width: 240, height: 240 });
  });

  it("第 1 步整张底色 + 第 3 步实心格：fillRect 次数 = 1 + 实心格数", () => {
    const { target, calls } = createMockTarget();
    drawSheetTile(target, pattern, palette, plan, tile, makeMeta());
    expect(calls.fills).toHaveLength(1 + solidInTile(pattern, tile));
    expect(calls.fills[0]).toMatchObject({
      x: 0,
      y: 0,
      w: tile.canvasWidth,
      h: tile.canvasHeight,
      fillStyle: "#ffffff",
    });
    // `save` / `restore` 必须配平（当前两边都是 0）：不配平会泄漏 target 的全局状态。
    expect(calls.saves).toBe(calls.restores);
  });

  it("色块的坐标取自 cellBox、颜色取自色卡（rgbCss 口径）", () => {
    const { target, calls } = createMockTarget();
    drawSheetTile(target, pattern, palette, plan, tile, makeMeta());

    const black = cellBox(tile, 1, 1);
    expect(fillAt(calls, black.x, black.y)).toMatchObject({
      w: black.width,
      h: black.height,
      fillStyle: "rgb(0, 0, 0)",
    });
    const red = cellBox(tile, 0, 2);
    expect(fillAt(calls, red.x, red.y)).toMatchObject({ fillStyle: "rgb(255, 0, 0)" });
    const grey = cellBox(tile, 5, 5);
    expect(fillAt(calls, grey.x, grey.y)).toMatchObject({ fillStyle: "rgb(200, 200, 210)" });
  });

  it("空格不填色（MARD 有白色豆，白 ≠ 空），只在格内画一条浅灰斜线", () => {
    const { target, calls } = createMockTarget();
    drawSheetTile(target, pattern, palette, plan, tile, makeMeta());

    for (const [col, row] of [[2, 0], [4, 2], [4, 5]] as const) {
      const box = cellBox(tile, col, row);
      expect(fillAt(calls, box.x, box.y)).toBeUndefined();
    }

    const diagonal = calls.paths.find((path) => path.strokeStyle === "#cbd5e1");
    expect(diagonal).toBeDefined();
    expect(diagonal?.lineWidth).toBe(tile.lineWidths.thin);
    const first = cellBox(tile, 2, 0);
    const second = cellBox(tile, 4, 2);
    const third = cellBox(tile, 4, 5);
    // 三格斜线共用一次 beginPath / stroke，方向是左上 → 右下
    expect(diagonal?.ops).toEqual([
      { op: "moveTo", x: first.x, y: first.y },
      { op: "lineTo", x: first.x + first.width, y: first.y + first.height },
      { op: "moveTo", x: second.x, y: second.y },
      { op: "lineTo", x: second.x + second.width, y: second.y + second.height },
      { op: "moveTo", x: third.x, y: third.y },
      { op: "lineTo", x: third.x + third.width, y: third.y + third.height },
      { op: "stroke" },
    ]);
  });

  it("格内色号：每格一条、字号取 labelFontPx、墨色取 labelInk、位置是 cellBox 的中心", () => {
    const { target, calls } = createMockTarget();
    drawSheetTile(target, pattern, palette, plan, tile, makeMeta());

    expect(tile.labelFontPx).toBe(15);
    const inGrid = textsInGrid(calls, tile);
    expect(inGrid).toHaveLength(33); // 实心格数：空格没有色号
    expect(inGrid.every((text) => ["A1", "A2", "A3", "A4"].includes(text.text))).toBe(true);

    const white = cellBox(tile, 0, 0);
    expect(calls.texts.find((text) => text.text === "A1")).toMatchObject({
      x: white.x + white.width / 2,
      y: white.y + white.height / 2,
      font: "15px sans-serif",
      fillStyle: "rgb(0, 0, 0)",
      textAlign: "center",
      textBaseline: "middle",
    });
    const black = cellBox(tile, 1, 1);
    expect(calls.texts.find((text) => text.text === "A2")).toMatchObject({
      x: black.x + black.width / 2,
      y: black.y + black.height / 2,
      fillStyle: "rgb(255, 255, 255)",
    });
  });

  it("信息条两行、刻度显示全局格号 + 1、板号与页脚逐字断言（本片颗数走 countTileBeads）", () => {
    const { target, calls } = createMockTarget();
    drawSheetTile(target, pattern, palette, plan, tile, makeMeta());

    expect(calls.texts[0]).toMatchObject({
      text: "测试工程 · 6 × 6 格 · 成品 3.0 厘米",
      x: SHEET_MARGIN,
      y: SHEET_MARGIN,
      font: "18px sans-serif", // 契约 §4b：字体字符串必须带字体族
      fillStyle: "#0f172a",
      textAlign: "left",
      textBaseline: "top",
    });
    expect(calls.texts[1]).toMatchObject({
      text: "测试色卡 · 全图 33 颗（4 种色）/ 本片 33 颗 · 2026-10-05 12:00 · 屏幕色仅供参考，以实物为准",
      y: SHEET_MARGIN + Math.round(SHEET_INFO_BAR_H / 2),
      // 第二行的字体 / 对齐被单独钉住（K 家族）：两行文字共用同一段状态赋值，只断第一行时
      // 「第二行被改了字号 / 对齐」不会被发现。
      font: "18px sans-serif",
      textAlign: "left",
      textBaseline: "top",
    });

    expect(tile.colTicks.map((tick) => tick.col)).toEqual([0, 5]);
    // 上刻度带：0 列显示「1」，居中、底对齐
    expect(calls.texts.find((text) => text.text === "1" && text.textAlign === "center")).toMatchObject({
      x: tile.grid.x,
      y: tile.grid.y - 8,
      textBaseline: "bottom",
      font: "12px sans-serif",
    });
    // 左刻度带：5 行显示「6」，右对齐、垂直居中
    expect(calls.texts.find((text) => text.text === "6" && text.textBaseline === "middle")).toMatchObject({
      x: tile.grid.x - 8,
      y: tile.rowTicks[1]?.y,
      // 行刻度的对齐也必须逐条钉住（K 家族）：`textAlign` 在刻度段被显式改成 `right`，
      // 少了这一条，把它留成 `center`（或漏写）不会有任何断言变红。
      textAlign: "right",
    });

    expect(calls.texts.filter((text) => text.text === "第 1 块板")).toHaveLength(2);
    expect(
      calls.texts.find((text) => text.text === "第 1 块板" && text.textAlign === "center"),
    ).toMatchObject({
      x: tile.grid.x,
      y: tile.grid.y - SHEET_RULER_TOP + 2,
      textBaseline: "top",
      // 板号字号 = 刻度字号（`tickFontPx`，契约 §4b 的字号表）。**显式赋值**，不靠继承：
      // 靠继承时「在刻度段与板号段之间插一次 font 赋值」会静默改掉板号字号，而没有任何断言看得见。
      font: "12px sans-serif",
    });
    expect(
      calls.texts.find((text) => text.text === "第 1 块板" && text.textAlign === "left"),
    ).toMatchObject({
      x: tile.grid.x - SHEET_RULER_LEFT + 2,
      y: tile.grid.y,
      textBaseline: "middle",
      font: "12px sans-serif",
    });
    expect(tile.tickFontPx).toBe(12);
    expect(calls.texts.find((text) => text.text.startsWith("第 1/1 片"))).toMatchObject({
      text: "第 1/1 片 · 列 1–6 · 行 1–6（含）· 本片 33 颗",
      x: SHEET_MARGIN,
      y: tile.grid.y + tile.grid.height + SHEET_FOOTER_H / 2,
      // 页脚字号（K 家族）：`FOOTER_FONT_PX = 16`，与信息条的 18 不同，写错会在这里红。
      font: "16px sans-serif",
      textAlign: "left",
    });
  });
});

describe("drawSheetTile：网格线、调用顺序与降级", () => {
  const pattern = makePattern(6, 6, CELLS_6X6);
  const palette = makePalette();
  const plan = planSheets(pattern, palette);
  const tile = plan.tiles[0] as SheetTilePlan;

  it("三档网格线由细到粗、每档一次 beginPath / stroke，板边界最后画", () => {
    const { target, calls } = createMockTarget();
    drawSheetTile(target, pattern, palette, plan, tile, makeMeta());

    // 调用顺序 = [空格斜线（浅灰、细）, thin, major, board]
    expect(calls.paths.map((path) => path.lineWidth)).toEqual([1, 1, 2, 3]);
    expect(calls.paths.map((path) => path.strokeStyle)).toEqual([
      "#cbd5e1",
      "#0f172a",
      "#0f172a",
      "#0f172a",
    ]);

    const gridPaths = calls.paths.filter((path) => path.strokeStyle === "#0f172a");
    for (const kind of ["thin", "major", "board"] as const) {
      const group = gridPaths.find((path) => path.lineWidth === tile.lineWidths[kind]);
      expect(group).toBeDefined();
      const lines =
        tile.vLines.filter((line) => line.kind === kind).length +
        tile.hLines.filter((line) => line.kind === kind).length;
      expect(group?.ops.filter((op) => op.op !== "stroke")).toHaveLength(2 * lines);
      expect(group?.ops.filter((op) => op.op === "stroke")).toHaveLength(1);
    }

    // 板边界在细线**之后**（顺序反了：先画粗线会被后画的细线切断，板边界不再连续）
    const thinIndex = calls.paths.findIndex(
      (path) => path.lineWidth === tile.lineWidths.thin && path.strokeStyle === "#0f172a",
    );
    const boardIndex = calls.paths.findIndex((path) => path.lineWidth === tile.lineWidths.board);
    expect(thinIndex).toBeGreaterThanOrEqual(0);
    expect(boardIndex).toBeGreaterThan(thinIndex);
    expect(boardIndex).toBe(calls.paths.length - 1);
  });

  it("moveTo / lineTo 各 = 网格线条数 + 空格数，且没有游离的路径操作", () => {
    const { target, calls } = createMockTarget();
    drawSheetTile(target, pattern, palette, plan, tile, makeMeta());

    const ops = calls.paths.flatMap((path) => path.ops);
    const gridLines = tile.vLines.length + tile.hLines.length;
    expect(gridLines).toBe(14);
    expect(ops.filter((op) => op.op === "moveTo")).toHaveLength(gridLines + 3);
    expect(ops.filter((op) => op.op === "lineTo")).toHaveLength(gridLines + 3);
    expect(calls.strayOps).toEqual([]);
  });

  /**
   * **K1**：细线组的 `ops` 逐位断言（修复波）。上面两条只断「条数与线宽」，对三种改坏方式
   * **全都绿**（控制者 2026-10-05 实测 32 passed / 0 红）：把竖线的两轴交换、把竖线全塌到 `grid.x`、
   * 把 `lineTo` 里的 `grid.height` 去掉（线长 0）——条数一个都不变。
   * 「坐标基准不要长出第二份坐标数学」的另一半就是这一条：`layout.test.ts` 钉住了 `vLines` / `hLines`
   * 的**值**，这里钉住「渲染器把哪个数放进哪个槽」。
   */
  it("细线组逐位取自 plan 的 vLines / hLines / grid（两轴交换 / 塌到 grid.x / 去掉线长都会红）", () => {
    const { target, calls } = createMockTarget();
    drawSheetTile(target, pattern, palette, plan, tile, makeMeta());

    const thin = thinPathOf(calls, tile);
    expect(thin).toBeDefined();
    expect(thin?.ops).toEqual(thinGridOps(tile));
    // 判别力的前提：细线组两轴都非空（两轴交换后**条数不变**，所以只靠上面那条逐位断言才判得开）
    expect(tile.vLines.filter((line) => line.kind === "thin").length).toBeGreaterThan(0);
    expect(tile.hLines.filter((line) => line.kind === "thin").length).toBeGreaterThan(0);
  });

  /**
   * 同一件事在**原点非零**的片上再钉一遍：`tiles[0]` 的 `originCol / originRow` 恒为 0，
   * 「只对第一片成立」的错法（例如把片内坐标当全局坐标）在那张片上不可见（任务 1 的 F1 同款形态）。
   */
  it("原点非零的片（500×500 的 tiles[1]，originCol = 116）同样逐位对上", () => {
    const big = makePattern(500, 500);
    const bigPlan = planSheets(big, palette);
    const offsetTile = bigPlan.tiles[1] as SheetTilePlan;
    // 前提：这一片真的带偏移（否则这条与上一条等价、判别力是假的）
    expect(offsetTile.originCol).toBe(116);
    expect(offsetTile.originRow).toBe(0);

    const { target, calls } = createMockTarget();
    drawSheetTile(target, big, palette, bigPlan, offsetTile, makeMeta());

    const thin = thinPathOf(calls, offsetTile);
    expect(thin).toBeDefined();
    expect(thin?.ops).toEqual(thinGridOps(offsetTile));
    expect(thinGridOps(offsetTile).length).toBeGreaterThan(2);
  });

  it("createMockTarget 的桩自检：漏写 beginPath 记进 strayOps，stroke 之后路径结束（K 家族的仪器证明）", () => {
    // **这不是被测行为的断言，而是仪器的自检**：上面那条「没有游离的路径操作」只有在
    // 「漏写 beginPath 真的会被记下来」时才有判别力。这里逐条走一遍桩的两半行为。
    const { target, calls } = createMockTarget();

    target.moveTo(1, 2); // 没有 beginPath ⇒ 应记为游离
    expect(calls.strayOps).toEqual(["moveTo(1, 2)"]);

    target.beginPath();
    target.moveTo(3, 4);
    target.lineTo(5, 6);
    target.stroke();
    expect(calls.strayOps).toEqual(["moveTo(1, 2)"]);
    expect(calls.paths[0]?.ops).toEqual([
      { op: "moveTo", x: 3, y: 4 },
      { op: "lineTo", x: 5, y: 6 },
      { op: "stroke" },
    ]);

    // `stroke()` 复位 `hasPath`：**第二组**漏写 beginPath 也必须可观察（不复位时它会静默并进上一组）
    target.lineTo(7, 8);
    target.stroke();
    expect(calls.strayOps).toEqual(["moveTo(1, 2)", "lineTo(7, 8)", "stroke()"]);
  });

  it("某一档一条线都没有时不发空 stroke（4×4 只有板边界与细线）", () => {
    const small = makePattern(4, 4);
    const smallPlan = planSheets(small, palette);
    const smallTile = smallPlan.tiles[0] as SheetTilePlan;
    expect(smallTile.vLines.filter((line) => line.kind === "major")).toHaveLength(0);

    const { target, calls } = createMockTarget();
    drawSheetTile(target, small, palette, smallPlan, smallTile, makeMeta());
    expect(calls.paths.map((path) => path.lineWidth)).toEqual([1, 3]);
  });

  it("labels = false 时格区域内没有色号；信息条 / 刻度 / 页脚照常写字（必须按区域过滤，否则是假绿）", () => {
    const big = makePattern(500, 500);
    const noLabels = planSheets(big, palette, { maxEdge: 1143 });
    expect(noLabels.labels).toBe(false);
    const bigTile = noLabels.tiles[0] as SheetTilePlan;
    expect(solidInTile(big, bigTile)).toBe(841); // 29×29 全实心

    const { target, calls } = createMockTarget();
    drawSheetTile(target, big, palette, noLabels, bigTile, makeMeta({ totalBeads: 250000, colorCount: 1 }));

    expect(textsInGrid(calls, bigTile)).toEqual([]);
    // 假绿陷阱的反面证据：整张图上仍然有 17 条文字（信息条 2 + 刻度 12 + 板号 2 + 页脚 1）
    expect(calls.texts).toHaveLength(2 + 6 + 6 + 1 + 1 + 1);
    expect(calls.texts[1]?.text).toBe(
      "测试色卡 · 全图 250000 颗（1 种色）/ 本片 841 颗 · 2026-10-05 12:00 · 屏幕色仅供参考，以实物为准",
    );
    expect(calls.fills).toHaveLength(1 + 841);
  });
});

describe("drawSheetTile / drawLegend：入口守卫", () => {
  const palette = makePalette();
  const pattern = makePattern(6, 6, CELLS_6X6);
  const plan = planSheets(pattern, palette);
  const tile = plan.tiles[0] as SheetTilePlan;

  it("plan.kind 不匹配 / tile 不属于本 plan / 色卡不一致：写在任何写操作之前", () => {
    const { target, calls } = createMockTarget();

    const sharePlan = planShare(pattern);
    expect(() =>
      drawSheetTile(target, pattern, palette, sharePlan as unknown as SheetPlan, tile, makeMeta()),
    ).toThrow("plan 的类型不匹配：期望 sheet，实际 share");
    expect(calls.fills).toEqual([]);

    const legendPlan = planLegend([]);
    expect(() =>
      drawSheetTile(target, pattern, palette, legendPlan as unknown as SheetPlan, tile, makeMeta()),
    ).toThrow("plan 的类型不匹配：期望 sheet，实际 legend");
    expect(calls.fills).toEqual([]);

    const foreign = planSheets(makePattern(6, 6, CELLS_6X6), palette).tiles[0] as SheetTilePlan;
    expect(() => drawSheetTile(target, pattern, palette, plan, foreign, makeMeta())).toThrow(
      "传入的 tile 不属于这个 plan",
    );
    expect(calls.fills).toEqual([]);

    expect(() =>
      drawSheetTile(target, pattern, { ...palette, id: "other" }, plan, tile, makeMeta()),
    ).toThrow("与传入的色卡 other 不一致");
    expect(calls.fills).toEqual([]);
  });

  it("色号下标超出色卡时响亮失败（不静默涂成另一个色）", () => {
    const broken = makePattern(6, 6);
    broken.cells[0] = 9;
    const brokenPlan = planSheets(broken, palette);
    const { target } = createMockTarget();
    expect(() =>
      drawSheetTile(target, broken, palette, brokenPlan, brokenPlan.tiles[0] as SheetTilePlan, makeMeta()),
    ).toThrow("色卡里没有下标 9 的颜色");
  });

  it("`pattern.cells` 长度与宽高不符时在**任何写操作之前**抛（长度校验由 countTileBeads 传递）", () => {
    // `countTileBeads` → `requirePattern` 必须跑到填白之前（修复波 A-m2）：把它放回填白之后，
    // 坏长度的图纸会先留下半张「已经画过」的产物——这条断言 `fills` 为空就是那个时机的判据。
    const short = { ...makePattern(6, 6), cells: new Uint16Array(35) };
    const { target, calls } = createMockTarget();
    expect(() => drawSheetTile(target, short, palette, plan, tile, makeMeta())).toThrow(
      "图纸数据与尺寸不一致：6×6 需要 36 格，实际 35 格",
    );
    expect(calls.fills).toEqual([]);
  });

  it("drawLegend 的 plan.kind 不匹配即抛（把 sheet plan 传进去）", () => {
    const { target, calls } = createMockTarget();
    expect(() =>
      drawLegend(target, palette, [], plan as unknown as LegendPlan, makeMeta()),
    ).toThrow("plan 的类型不匹配：期望 legend，实际 sheet");
    expect(calls.fills).toEqual([]);
  });

  it("drawLegend 的 usages 不是数组即抛（消息说真原因，不是「应为 NaN 行」）", () => {
    // 缺这条守卫时，非数组会走到 `Math.ceil(undefined / itemCols)`，最终抛
    // 「用量表计划与本表不符：计划 0 行、按 undefined 项应为 **NaN** 行」——响亮但**消息失实**：
    // 真正的原因是入参根本不是数组（契约 §3 已有逐字消息）。
    const legendPlan = planLegend([]);
    const { target, calls } = createMockTarget();
    expect(() =>
      drawLegend(target, palette, "not-an-array" as unknown as readonly ColorUsage[], legendPlan, makeMeta()),
    ).toThrow("用量表必须是数组（当前 string）");
    expect(calls.fills).toEqual([]);
  });
});

/** 按色号表造一张色卡（用量表用例要把色号查回 rgb，所以色卡必须含这些色号）。 */
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

describe("drawLegend", () => {
  const palette = makePalette(); // A1 白 / A2 黑 / A3 红 / A4 浅灰
  const usages = [
    { code: "A1", name: "白", count: 12 },
    { code: "A2", name: "黑", count: 30 },
  ];
  const plan = planLegend(usages);

  it("标题行 + 表头 + 每项一行 + **色块是真色** + 合计 = 各项之和 + 精度声明 + 生成时间", () => {
    const { target, calls } = createMockTarget();
    drawLegend(target, palette, usages, plan, makeMeta());

    expect(calls.fills[0]).toMatchObject({
      x: 0,
      y: 0,
      w: plan.canvasWidth,
      h: plan.canvasHeight,
      fillStyle: "#ffffff",
    });
    // 顺序：标题 → 表头三列（表头必须在任何项行之前）
    expect(calls.texts.slice(0, 4).map((text) => text.text)).toEqual([
      "测试工程 · 用量表",
      "色号",
      "名称",
      "颗数",
    ]);
    // 标题行与表头的**位置与字号**（K 家族）：只断顺序时，`headerY` 被改成 0 或表头被挪到
    // 表格中间都不会红。表头的 y = `tableTop − rowHeight / 2`（契约 §4b 的带内落位口径）。
    expect(calls.texts[0]).toMatchObject({
      x: SHEET_MARGIN,
      y: plan.headerY,
      font: "20px sans-serif",
      textAlign: "left",
      textBaseline: "top",
    });
    const headerY = plan.tableTop - plan.rowHeight / 2;
    expect(calls.texts.find((text) => text.text === "色号")).toMatchObject({
      x: SHEET_MARGIN + 28,
      y: headerY,
      font: "14px sans-serif",
      textAlign: "left",
      textBaseline: "middle",
    });
    expect(calls.texts.find((text) => text.text === "名称")).toMatchObject({
      x: SHEET_MARGIN + 88,
      y: headerY,
    });
    expect(calls.texts.find((text) => text.text === "颗数")).toMatchObject({
      x: SHEET_MARGIN + plan.itemWidth - 8,
      y: headerY,
      textAlign: "right",
    });

    // 每项一行：第 i 项落在第 i 列（默认上限下 itemCols = 13，两项同行不同列）
    expect(plan.itemCols).toBe(13);
    const cellX = (index: number) => SHEET_MARGIN + index * plan.itemWidth;
    const centerY = plan.tableTop + plan.rowHeight / 2;
    expect(calls.texts.find((text) => text.text === "A1")).toMatchObject({
      x: cellX(0) + 28,
      y: centerY,
      textAlign: "left",
      textBaseline: "middle",
    });
    expect(calls.texts.find((text) => text.text === "A2")).toMatchObject({ x: cellX(1) + 28, y: centerY });
    expect(calls.texts.find((text) => text.text === "白")).toMatchObject({ x: cellX(0) + 88, y: centerY });
    expect(calls.texts.find((text) => text.text === "30")).toMatchObject({
      x: cellX(1) + plan.itemWidth - 8,
      y: centerY,
      textAlign: "right",
    });

    // 色块：**真是那个颜色**（2026-10-05 补 `palette` 入参后才可断言）——fillStyle 必须等于该色号的
    // `rgbCss`，而且是一次**填充**（只描边的占位框会让这条红）。外框是压在真色之上的细框。
    const swatchY = plan.tableTop + (plan.rowHeight - 20) / 2;
    expect(calls.fills).toHaveLength(1 + 2);
    expect(calls.fills[1]).toMatchObject({
      x: cellX(0),
      y: swatchY,
      w: 20,
      h: 20,
      fillStyle: "rgb(255, 255, 255)",
    });
    expect(calls.fills[2]).toMatchObject({
      x: cellX(1),
      y: swatchY,
      w: 20,
      h: 20,
      fillStyle: "rgb(0, 0, 0)",
    });
    expect(calls.strokeRects).toHaveLength(2);
    expect(calls.strokeRects[0]).toMatchObject({ x: cellX(0), y: swatchY, w: 20, h: 20 });
    // 外框的**颜色与线宽**也逐条钉住（K 家族）：只断位置时，外框画成粗黑边不会有任何断言变红
    //（而它压在真色之上，真实观感会明显不同）。
    expect(calls.strokeRects[0]).toMatchObject({ strokeStyle: "#94a3b8", lineWidth: 1 });
    // 每项行的字号（`LEGEND_FONT_PX = 14`，与表头同号但独立赋值）
    expect(calls.texts.find((text) => text.text === "A1")).toMatchObject({ font: "14px sans-serif" });

    // 合计：测试自己求和，与被测实现不同源
    const expectedTotal = usages.reduce((sum, usage) => sum + usage.count, 0);
    expect(expectedTotal).toBe(42);
    expect(calls.texts.some((text) => text.text === "合计 42 颗")).toBe(true);
    expect(calls.texts.some((text) => text.text === makeMeta().accuracy)).toBe(true);
    expect(calls.texts.some((text) => text.text === "生成时间：2026-10-05 12:00")).toBe(true);
    expect(calls.texts).toHaveLength(1 + 3 + 2 * 3 + 3);
    // `save` / `restore` 必须配平（当前两边都是 0）：不配平会泄漏 target 的全局状态。
    expect(calls.saves).toBe(calls.restores);
  });

  it("页脚三行按 totalY +2 / +16 / +30 落位，且最后一行不越出页脚块（几何不变量）", () => {
    // 任务 1 的审查正是在这一带抓到 `totalY ≡ footerY`（两个字段代数恒等，会让「合计」与「精度声明」
    // 画在同一行）。这里把三行的 y 与页脚块的下边界一起钉住，防止后人把某一行的偏移改大。
    const { target, calls } = createMockTarget();
    drawLegend(target, palette, usages, plan, makeMeta());

    const footer = (text: string) => calls.texts.find((call) => call.text === text);
    expect(footer("合计 42 颗")).toMatchObject({ y: plan.totalY + 2 });
    expect(footer("屏幕色仅供参考，以实物为准")).toMatchObject({ y: plan.totalY + 16 });
    const last = footer("生成时间：2026-10-05 12:00");
    expect(last).toMatchObject({ y: plan.totalY + 30 });
    // 页脚三行的字号与对齐（K 家族）：`LEGEND_FOOTER_FONT_PX = 12`，三行共用同一次赋值。
    expect(footer("合计 42 颗")).toMatchObject({
      x: SHEET_MARGIN,
      font: "12px sans-serif",
      textAlign: "left",
      textBaseline: "top",
    });
    expect(last).toMatchObject({ font: "12px sans-serif" });

    // 几何不变量：最后一行加上行距仍在页脚块内（30 + 14 = 44 = `SHEET_FOOTER_H`）。
    // **用实际画出的 `last.y` 而不是 `plan.totalY + 30`**：后者的比较结果只由 plan 的字段决定，
    // 抓不到「把第三行往下推」的实现改动（那样它会恒真）。
    // `LEGEND_FOOTER_LINE_H` 是 `sheet.ts` 的模块私有常量（不新增公开名字），故这里写它的值 14。
    expect((last?.y ?? Number.NaN) + 14).toBeLessThanOrEqual(plan.canvasHeight - SHEET_MARGIN);
  });

  it("多列布局：第 14 项换到第 2 行第 1 列", () => {
    const codes = Array.from({ length: 14 }, (_, index) => `B${index + 1}`);
    const manyPalette = makePaletteOf(codes);
    const many = codes.map((code, index) => ({ code, name: `色 ${index + 1}`, count: index + 1 }));
    const manyPlan = planLegend(many);
    expect(manyPlan.itemCols).toBe(13);
    expect(manyPlan.itemRows).toBe(2);

    const { target, calls } = createMockTarget();
    drawLegend(target, manyPalette, many, manyPlan, makeMeta());
    expect(calls.texts.find((text) => text.text === "B14")).toMatchObject({
      x: SHEET_MARGIN + 28,
      y: manyPlan.tableTop + manyPlan.rowHeight + manyPlan.rowHeight / 2,
    });
    expect(calls.texts.some((text) => text.text === "合计 105 颗")).toBe(true); // 1+…+14 = 105
    expect(calls.fills).toHaveLength(1 + 14);
  });

  it("空用量表：表格区只有标题与合计（不画表头、不画项、不画色块）", () => {
    const emptyPlan = planLegend([]);
    const { target, calls } = createMockTarget();
    drawLegend(target, palette, [], emptyPlan, makeMeta({ totalBeads: 0, colorCount: 0 }));

    expect(calls.texts.map((text) => text.text)).toEqual([
      "测试工程 · 用量表",
      "合计 0 颗",
      "屏幕色仅供参考，以实物为准",
      "生成时间：2026-10-05 12:00",
    ]);
    expect(calls.strokeRects).toEqual([]);
    expect(calls.fills).toHaveLength(1); // 只有整张底色
  });

  it("usages 与 plan 不同源即抛，且不留下半张表（写在任何写操作之前）", () => {
    // 14 项 ⇒ 计划是 2 行；只喂 2 项 ⇒ 应为 1 行：行数不符必须响亮失败
    const many = Array.from({ length: 14 }, (_, index) => ({
      code: `A${index + 1}`,
      name: `色 ${index + 1}`,
      count: index + 1,
    }));
    const manyPlan = planLegend(many);
    expect(manyPlan.itemRows).toBe(2);

    const { target, calls } = createMockTarget();
    expect(() => drawLegend(target, palette, usages, manyPlan, makeMeta())).toThrow(
      "用量表计划与本表不符：计划 2 行、按 2 项应为 1 行",
    );
    expect(calls.fills).toEqual([]);
  });

  it("色号不在色卡里即抛，且不留下半张表（**第二项**才是坏色号，证明校验在动笔之前）", () => {
    const stranger = [
      { code: "A1", name: "白", count: 1 },
      { code: "Z9", name: "不在色卡", count: 2 },
    ];
    const strangerPlan = planLegend(stranger);
    const { target, calls } = createMockTarget();
    expect(() => drawLegend(target, palette, stranger, strangerPlan, makeMeta())).toThrow(
      "用量表里的色号不在色卡里：Z9",
    );
    expect(calls.fills).toEqual([]);
  });

  it("plan 不自洽（列数与画布宽配错）即抛，且不留下半张表", () => {
    // 伪造一个「12 列」的计划：行数仍与 usages 相符（ceil(2/12) = 1），所以只有自洽性检查拦得住它
    const forged = { ...plan, itemCols: 12 };
    const { target, calls } = createMockTarget();
    expect(() => drawLegend(target, palette, usages, forged, makeMeta())).toThrow(
      "用量表计划不自洽：12 列 × 300 px + 边距 ≠ 画布宽 3948 px",
    );
    expect(calls.fills).toEqual([]);
  });
});

describe("§13.2 承重断言的渲染器侧", () => {
  const palette = makePalette();

  it("§13.2-2：同一格在单张计划与分片计划里落到同一个 fillRect（去掉 origin 偏移会红）", () => {
    const single = makePattern(116, 116);
    const tiled = makePattern(500, 500);
    const singlePlan = planSheets(single, palette);
    const tiledPlan = planSheets(tiled, palette);
    // 前提：两次计划的格像素相同（不同就无从比较——用例自己先钉住这个前提）
    expect(singlePlan.cellPx).toBe(33);
    expect(tiledPlan.cellPx).toBe(33);

    const singleTile = singlePlan.tiles[0] as SheetTilePlan;
    const tiledTile = tiledPlan.tiles[0] as SheetTilePlan;
    const singleRun = createMockTarget();
    drawSheetTile(singleRun.target, single, palette, singlePlan, singleTile, makeMeta());
    const tiledRun = createMockTarget();
    drawSheetTile(tiledRun.target, tiled, palette, tiledPlan, tiledTile, makeMeta());

    const boxSingle = cellBox(singleTile, 7, 13);
    const boxTiled = cellBox(tiledTile, 7, 13);
    expect(boxTiled).toEqual(boxSingle);
    const fillSingle = fillAt(singleRun.calls, boxSingle.x, boxSingle.y);
    expect(fillSingle).toBeDefined();
    expect(fillAt(tiledRun.calls, boxTiled.x, boxTiled.y)).toEqual(fillSingle);
  });

  it("§13.2-3：底色铺满 plan 给的画布，格子区宽度 = 列数 × 格像素（与缩略图 512 上限无关）", () => {
    const big = makePattern(500, 500);
    const plan = planSheets(big, palette);
    const tile = plan.tiles[0] as SheetTilePlan;
    const { target, calls } = createMockTarget();
    drawSheetTile(target, big, palette, plan, tile, makeMeta());

    expect(calls.fills[0]).toMatchObject({ x: 0, y: 0, w: tile.canvasWidth, h: tile.canvasHeight });
    expect(tile.canvasWidth).toBe(2 * SHEET_MARGIN + SHEET_RULER_LEFT + tile.cols * plan.cellPx);
    expect(tile.grid.width).toBe(tile.cols * plan.cellPx);
    // 规格 §9 第 3 条：导出不经过 renderPatternThumbnail（它的 THUMBNAIL_MAX_EDGE = 512）
    expect(tile.grid.width).toBeGreaterThan(512);
    expect(tile.grid.height).toBeGreaterThan(512);
  });
});

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
    const plan = planSheet(pattern, makePalette(), makeUsages());
    const { target, calls } = createMockTarget();
    drawSheet(target, pattern, makePalette(), makeUsages(), plan, makeMeta());
    expect(textsInGrid(calls, plan)).toHaveLength(33);
  });

  it("用料条画在网格下沿：每项一个色块 + 色号 + 数量，且数量右对齐", () => {
    const pattern = makePattern(6, 6, CELLS_6X6);
    const palette = makePalette();
    const usages = makeUsages();
    const plan = planSheet(pattern, palette, usages);
    const { target, calls } = createMockTarget();
    drawSheet(target, pattern, palette, usages, plan, makeMeta());

    // **左沿取自 `plan.legend.left`，不写 `SHEET_MARGIN`**：渲染器读的是计划给的字段，
    // 断言里写死常量的话，把渲染器改成「自己用 SHEET_MARGIN」也照样绿（打印页的 `left` 不是 SHEET_MARGIN）。
    // 单张施工图这一步顺带钉住「计划给的 left 就是 SHEET_MARGIN」——这正是「行为不变」的判据。
    expect(plan.legend.left).toBe(SHEET_MARGIN);
    // 色块：每个色号一颗 `plan.legend.swatchSize` 的方块，y = 带内该行的中线 − 半个色块
    for (let i = 0; i < usages.length; i += 1) {
      const col = i % plan.legend.itemCols;
      const row = Math.floor(i / plan.legend.itemCols);
      const centerY = plan.legend.top + row * plan.legend.rowHeight + plan.legend.rowHeight / 2;
      const swatch = fillAt(calls, plan.legend.left + col * plan.legend.itemWidth, centerY - plan.legend.swatchSize / 2);
      expect(swatch?.w).toBe(plan.legend.swatchSize);
      expect(swatch?.fillStyle).toBe(rgbCss(palette.colors[i]!.rgb));
    }
    const codes = calls.texts.filter((t) => t.text === "A1" && t.y > plan.legend.top);
    expect(codes.length).toBe(1);
    // 色号与数量（标题承诺的两样）：色号左对齐在项内偏移处，数量**右对齐**在项右端内缩处
    const firstCenterY = plan.legend.top + plan.legend.rowHeight / 2;
    expect(codes[0]).toMatchObject({
      textAlign: "left",
      x: plan.legend.left + plan.legend.codeX,
      y: firstCenterY,
    });
    const count = calls.texts.find(
      (text) => text.text === String(usages[0]?.count) && text.y === firstCenterY,
    );
    expect(count).toMatchObject({
      textAlign: "right",
      x: plan.legend.left + plan.legend.itemWidth - plan.legend.countRightPad,
    });
  });

  it("末行三行（合计 / 精度声明 / 生成时间）都在网格下方，且排在用料条之后", () => {
    const pattern = makePattern(6, 6, CELLS_6X6);
    const usages = makeUsages();
    const plan = planSheet(pattern, makePalette(), usages);
    const { target, calls } = createMockTarget();
    drawSheet(target, pattern, makePalette(), usages, plan, makeMeta({ generatedAt: "2026-10-08 10:00" }));

    const belowGrid = calls.texts.filter((t) => t.y > plan.grid.y + plan.grid.height);
    const texts = belowGrid.map((t) => t.text);
    expect(texts).toContain("屏幕色仅供参考，以实物为准");
    expect(texts).toContain("生成时间：2026-10-08 10:00");
    expect(texts.some((t) => t.includes("合计 33 颗"))).toBe(true);
    // 用料条在末行**之前**画：按 `calls.texts` 的**调用下标**比，而不是比 y 的大小——
    // 页脚三行恒在 `legend.top` 之下（`footerY > legend.top`），只比 y 的话把绘制顺序反过来照样绿。
    const bandBottom = plan.legend.top + plan.legend.itemRows * plan.legend.rowHeight;
    const bandIndices = calls.texts
      .map((text, index) => ({ text, index }))
      .filter((item) => item.text.y >= plan.legend.top && item.text.y < bandBottom)
      .map((item) => item.index);
    expect(bandIndices).toHaveLength(usages.length * 2); // 每项两条：色号 + 数量
    const totalIndex = calls.texts.findIndex((text) => text.text.includes("合计 33 颗"));
    expect(totalIndex).toBeGreaterThan(Math.max(...bandIndices));
  });

  it("save / restore 配平（不配平会泄漏 target 的全局状态）", () => {
    const pattern = makePattern(6, 6, CELLS_6X6);
    const usages = makeUsages();
    const plan = planSheet(pattern, makePalette(), usages);
    const { target, calls } = createMockTarget();
    drawSheet(target, pattern, makePalette(), usages, plan, makeMeta());
    expect(calls.saves).toBe(calls.restores);
  });

  it("usages 与 plan 不同源（用料条行数对不上）即抛，且不留下半张图（写在任何写操作之前）", () => {
    // `LegendBandPlan.itemRows` 是计划用来扣高度预算的字段，而渲染器只按 `itemCols` 排布、
    // **不读 `itemRows`** ⇒ 配错不会报错，只会让用料条压到页脚上 / 越出 `canvasHeight`，
    // 画出一张看起来正常的残缺图（`drawLegend` 的同源守卫是同一先例）。
    const pattern = makePattern(6, 6, CELLS_6X6);
    const codes = Array.from({ length: 21 }, (_, index) => `B${index + 1}`);
    const manyPalette = makePaletteOf(codes);
    const many: ColorUsage[] = codes.map((code, index) => ({
      code,
      name: `色 ${index + 1}`,
      count: index + 1,
    }));
    const manyPlan = planSheet(pattern, manyPalette, many);
    expect(manyPlan.legend.itemRows).toBe(2); // 前提：21 项在 20 列下要两行

    const { target, calls } = createMockTarget();
    expect(() =>
      drawSheet(target, pattern, manyPalette, many.slice(0, 4), manyPlan, makeMeta()),
    ).toThrow("用料条与本图不符：计划 2 行、按 4 项应为 1 行");
    expect(calls.fills).toEqual([]);
  });

  it("非数组 usages 与不在色卡里的色号都在**填白之前**抛（渲染末段才炸会留下一整张网格）", () => {
    const pattern = makePattern(6, 6, CELLS_6X6);
    const palette = makePalette();
    const plan = planSheet(pattern, palette, makeUsages());

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
