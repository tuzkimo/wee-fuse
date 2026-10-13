import { describe, expect, it } from "vitest";
import type { Palette } from "../../palette/types";
import { EMPTY, type Pattern } from "../../pattern/types";
import {
  SHEET_LINE_WIDTHS,
  SHEET_MAJOR_GUIDE_STROKE,
  SHEET_RULER_BG,
  planGridTile,
  type GridTilePlan,
} from "../layout";
import { drawGridTile, EMPTY_STROKE, TILE_PAPER } from "../sheet";
import { createMockTarget } from "./helpers";

/**
 * 网格块预览（规格 §5.3）：**只画「拼出来长什么样」**——纸底 + 逐格真色 + 空格斜线 + 整图外框。
 * 不画格内色号、每格细线、板边界、每 5 格虚线（那是施工信息，不是成品信息；2026-10-13 真机反馈）。
 *
 * 渲染器的像素观感在真机清单（规格 §8）里，这里断言的是**计划给的几何**与**渲染器画了哪几层**——
 * happy-dom 的 canvas 没有像素语义，画布用例里像素断言一律恒真。
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

function makePattern(width: number, height: number): Pattern {
  return { width, height, paletteId: "test-palette", cells: new Uint16Array(width * height) };
}

describe("planGridTile", () => {
  it("格像素取盒子的短边，网格在盒子里居中，画布就是盒子", () => {
    const tile = planGridTile(makePattern(10, 10), PALETTE, { width: 100, height: 50 });
    expect(tile.cellPx).toBe(5); // min(100/10, 50/10) = 5，取短边
    // 画布是**盒子**，不是 `豆数 × 格像素`：绘制仍在画布坐标系里做，网格层函数一行都不用改。
    expect(tile.canvasWidth).toBe(100);
    expect(tile.canvasHeight).toBe(50);
    expect(tile.grid).toEqual({ x: 25, y: 0, width: 50, height: 50 });
  });

  it("1×1 的图纸也成立（不除零、不抛）", () => {
    const tile = planGridTile(makePattern(1, 1), PALETTE, { width: 60, height: 40 });
    expect(tile.cellPx).toBe(40);
    expect(tile.grid).toEqual({ x: 10, y: 0, width: 40, height: 40 });
  });

  it("盒子有一边为 0 / 非有限时响亮失败（不是除零算出 Infinity）", () => {
    expect(() => planGridTile(makePattern(4, 4), PALETTE, { width: 0, height: 50 })).toThrow(/盒子/);
    expect(() => planGridTile(makePattern(4, 4), PALETTE, { width: 100, height: Number.NaN })).toThrow(
      /盒子/,
    );
  });
});

describe("drawGridTile", () => {
  /** 10×10、**两个**空格——空格才是「纸底 + 斜线」那条链的观测点。 */
  function mixedPattern(): Pattern {
    const pattern = makePattern(10, 10);
    pattern.cells[0] = EMPTY;
    pattern.cells[5] = 1;
    pattern.cells[99] = EMPTY;
    return pattern;
  }

  /**
   * 画布上真正出现的层：**纸底（第一条 `fillRect` 就是网格矩形）→ 逐格真色 → 空格斜线 → 外框**。
   * 盒子的尺寸取两个量级，因为「不画那两层」这条不该随格像素变化（旧实现是按格像素决定画不画的）。
   */
  for (const [label, box] of [
    ["大格子（40px/格）", 400],
    ["小格子（5px/格）", 50],
  ] as const) {
    it(`${label}：画纸底 + 真色 + 空格斜线 + 外框，不画网格线、不画色号`, () => {
      const pattern = mixedPattern();
      const tile = planGridTile(pattern, PALETTE, { width: box, height: box });
      const { target, calls } = createMockTarget();
      drawGridTile(target, pattern, PALETTE, tile);

      // 纸底：第一条填充就是网格矩形，色取 `TILE_PAPER`——**没有它空格就是一块黑格子**
      // （空格只描一条 `EMPTY_STROKE` 斜线，底下透出的就是宿主的深色板底）。
      expect(calls.fills[0]).toMatchObject({
        x: tile.grid.x,
        y: tile.grid.y,
        w: tile.grid.width,
        h: tile.grid.height,
        fillStyle: TILE_PAPER,
      });
      // 纸底 + 每个实心格一次填充（10×10 减两个空格）。
      expect(calls.fills).toHaveLength(99);

      // 空格斜线：两个空格收集在**一条**路径里（`EMPTY_STROKE`），一次 `stroke`。
      const hatch = calls.paths[0];
      expect(hatch?.strokeStyle).toBe(EMPTY_STROKE);
      expect(hatch?.ops.filter((op) => op.op === "lineTo")).toHaveLength(2);

      // **只有两条路径**：空格斜线 + 整图外框。没有每格细线 / 板边界 / 每 5 格虚线。
      expect(calls.paths).toHaveLength(2);
      expect(calls.paths.some((path) => path.strokeStyle === SHEET_MAJOR_GUIDE_STROKE)).toBe(false);
      // 板边界（3px）一条都没有。**不拿 `thin`（1px）当判据**：空格斜线的线宽也是 1，
      // 两者相撞——「细线没画」由上面那条路径条数断言管。
      expect(calls.paths.map((path) => path.lineWidth)).not.toContain(SHEET_LINE_WIDTHS.board);
      // 外框是最后一组：闭合的网格矩形（moveTo + 四条 lineTo）。
      const frame = calls.paths[calls.paths.length - 1];
      expect(frame?.ops.filter((op) => op.op === "lineTo")).toHaveLength(4);

      // 没有色号：`fillText` 一次都没有（施工图的标题 / 刻度数字也一并不存在）。
      expect(calls.texts).toEqual([]);
      // 没有刻度带底色，也没有用料条（色块外框走 `strokeRect`）。
      expect(calls.fills.some((fill) => fill.fillStyle === SHEET_RULER_BG)).toBe(false);
      expect(calls.strokeRects).toEqual([]);
      expect(calls.strayOps).toEqual([]);
    });
  }

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
