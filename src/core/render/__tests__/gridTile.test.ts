import { describe, expect, it } from "vitest";
import type { Palette } from "../../palette/types";
import { EMPTY, type Pattern } from "../../pattern/types";
import {
  SHEET_LINE_WIDTHS,
  SHEET_MAJOR_GUIDE_STROKE,
  SHEET_MIN_LABEL_FONT_PX,
  SHEET_RULER_BG,
  planGridTile,
  planSheet,
  type GridTilePlan,
} from "../layout";
import { drawGridTile } from "../sheet";
import { createMockTarget } from "./helpers";

/**
 * 网格块预览（2026-10-13，规格 §5.3）：**只画施工图里网格那一组层**，按预览盒子的短边定格像素、
 * 网格在盒子里居中。渲染器的像素观感在真机清单（规格 §8）里，这里断言的是**计划给的几何**与
 * **渲染器调了哪些层**——happy-dom 的 canvas 没有像素语义，画布用例里像素断言一律恒真。
 */

const PALETTE: Palette = {
  id: "test-palette",
  name: "测试色卡",
  source: "test",
  accuracy: "屏幕色仅供参考，以实物为准",
  colors: [
    { code: "A1", name: "白", rgb: [255, 255, 255] },
    { code: "A2", name: "黑", rgb: [0, 0, 0] },
  ],
};

function makePattern(width: number, height: number, values?: readonly number[]): Pattern {
  const cells = new Uint16Array(width * height);
  if (values !== undefined) cells.set(values);
  return { width, height, paletteId: "test-palette", cells };
}

describe("planGridTile", () => {
  it("格像素取盒子的短边，网格在盒子里居中，画布就是盒子", () => {
    const tile = planGridTile(makePattern(10, 10), PALETTE, { width: 100, height: 50 });
    expect(tile.cellPx).toBe(5); // min(100/10, 50/10) = 5，取短边
    // 画布是**盒子**，不是 `豆数 × 格像素`：绘制仍在画布坐标系里做，所以五个网格层函数一行都不用改。
    expect(tile.canvasWidth).toBe(100);
    expect(tile.canvasHeight).toBe(50);
    expect(tile.grid).toEqual({ x: 25, y: 0, width: 50, height: 50 });
  });

  it("1×1 的图纸也成立（不除零、不抛）", () => {
    const tile = planGridTile(makePattern(1, 1), PALETTE, { width: 60, height: 40 });
    expect(tile.cellPx).toBe(40);
    expect(tile.grid).toEqual({ x: 10, y: 0, width: 40, height: 40 });
  });

  it("色号只剩「画 / 不画」两档：下限之下 labelFontPx = 0 而**不抛错**", () => {
    const at = (cell: number) => planGridTile(makePattern(1, 1), PALETTE, { width: cell, height: cell });
    // 判据是**字号**（规格 §5.3 的原话），字号口径就是施工图的 `labelFontAt`（round(cellPx × 0.36)）：
    // 28 × 0.36 = 10.08 ⇒ 10（≥ 下限）；27 × 0.36 = 9.72 ⇒ round 也是 10，**同样画**。
    // 真正的分界在 26（round(9.36) = 9 < 10）。计划原文把分界写成 27/28，那是漏算了 round——
    // 这里按同一个 `labelFontAt` 断，不另立一套「28 才画」的口径。
    expect(at(28).labelFontPx).toBeGreaterThanOrEqual(SHEET_MIN_LABEL_FONT_PX);
    expect(at(27).labelFontPx).toBe(SHEET_MIN_LABEL_FONT_PX);
    expect(at(26).labelFontPx).toBe(0);
    // **对照**：同一份图纸在施工图计划里是响亮失败（放不下就抛），预览这里只降级——
    // 这条对照就是「降级是刻意决定、不是漏了守卫」的判别力。
    expect(() => planSheet(makePattern(116, 116), PALETTE, [], "测试工程", { maxEdge: 100 })).toThrow();
  });

  it("网格线的两档：6 画、5 不画（线距小于线宽时网格会糊成一层灰）", () => {
    const at = (cell: number) => planGridTile(makePattern(1, 1), PALETTE, { width: cell, height: cell });
    expect(at(6).showGridLines).toBe(true);
    expect(at(5).showGridLines).toBe(false);
    expect(at(5).labelFontPx).toBe(0);
  });

  it("盒子有一边为 0 / 非有限时响亮失败（不是除零算出 Infinity）", () => {
    expect(() => planGridTile(makePattern(4, 4), PALETTE, { width: 0, height: 50 })).toThrow(/盒子/);
    expect(() => planGridTile(makePattern(4, 4), PALETTE, { width: 100, height: Number.NaN })).toThrow(
      /盒子/,
    );
  });
});

describe("drawGridTile", () => {
  it("画网格那一组层，且不画标题 / 刻度带 / 用料条", () => {
    // 10×10 ⇒ 每 5 格有虚线；留一个空格（空格只进斜线路径，不填充）。
    const pattern = makePattern(10, 10);
    pattern.cells[0] = EMPTY;
    pattern.cells[5] = 1;
    pattern.cells[99] = 1;
    const tile = planGridTile(pattern, PALETTE, { width: 400, height: 400 });
    expect(tile.cellPx).toBe(40); // 六层全画的尺寸前提
    const { target, calls } = createMockTarget();
    drawGridTile(target, pattern, PALETTE, tile);

    // 逐格真色：99 个实心格各一次 `fillRect`。
    expect(calls.fills).toHaveLength(99);
    // 格内色号：每颗实心格一条，且**只有色号**（没有标题 / 刻度数字）。
    expect(calls.texts).toHaveLength(99);
    for (const text of calls.texts) expect(text.text).toMatch(/^A[12]$/);
    expect(calls.texts.map((text) => text.text).join("")).not.toContain("测试工程");
    // 没有用料条：色块外框走 `strokeRect`，一次都没有。
    expect(calls.strokeRects).toEqual([]);
    // 没有刻度带：带底色一次都不出现。
    expect(calls.fills.some((fill) => fill.fillStyle === SHEET_RULER_BG)).toBe(false);
    // 没有整张画布填白（施工图的第一步）：留白留给宿主组件的深色板底。
    expect(
      calls.fills.some(
        (fill) => fill.x === 0 && fill.y === 0 && fill.w === tile.canvasWidth && fill.h === tile.canvasHeight,
      ),
    ).toBe(false);

    // 细线与板边界各一组；每 5 格橙色虚线四条（10 格的两轴各 index 5 与 10）。
    const widths = calls.paths.map((path) => path.lineWidth);
    expect(widths).toContain(SHEET_LINE_WIDTHS.thin);
    expect(widths).toContain(SHEET_LINE_WIDTHS.board);
    expect(calls.paths.filter((path) => path.strokeStyle === SHEET_MAJOR_GUIDE_STROKE)).toHaveLength(4);
    // 外框是最后一组：闭合的网格矩形（moveTo + 四条 lineTo）。
    const frame = calls.paths[calls.paths.length - 1];
    expect(frame?.ops.filter((op) => op.op === "lineTo")).toHaveLength(4);
    expect(calls.strayOps).toEqual([]);
  });

  it("盒子小到阈值以下：不画线、不画色号，但真色与外框照画（降级不是不画图）", () => {
    const pattern = makePattern(10, 10);
    const tile = planGridTile(pattern, PALETTE, { width: 50, height: 50 }); // 5px/格
    expect(tile.showGridLines).toBe(false);
    expect(tile.labelFontPx).toBe(0);
    const { target, calls } = createMockTarget();
    drawGridTile(target, pattern, PALETTE, tile);

    expect(calls.fills).toHaveLength(100); // 逐格真色照画
    expect(calls.texts).toEqual([]); // 色号不画
    expect(calls.paths).toHaveLength(1); // 只剩外框：把网格边界从深色底上标出来
  });

  it("入口守卫：kind 不对 / 色卡不一致 / 图纸数据与尺寸不同源，都在任何写操作之前抛", () => {
    const pattern = makePattern(4, 4);
    const tile = planGridTile(pattern, PALETTE, { width: 40, height: 40 });
    const { target, calls } = createMockTarget();
    expect(() => drawGridTile(target, pattern, { ...PALETTE, id: "other" }, tile)).toThrow(/色卡/);
    expect(() =>
      drawGridTile(target, pattern, PALETTE, { ...tile, kind: "sheet" } as unknown as GridTilePlan),
    ).toThrow(/tile/);
    const broken: Pattern = { ...pattern, cells: new Uint16Array(3) };
    expect(() => drawGridTile(target, broken, PALETTE, tile)).toThrow(/图纸数据与尺寸不一致/);
    // 「写在任何写操作之前」：守卫拦下时一个像素都没画。
    expect(calls.fills).toEqual([]);
    expect(calls.paths).toEqual([]);
  });
});
