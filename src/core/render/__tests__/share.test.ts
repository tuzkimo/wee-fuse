import { describe, expect, it } from "vitest";
import type { Palette } from "../../palette/types";
import { EMPTY, type Pattern } from "../../pattern/types";
import { planShare, planSheets, shareCellBox, type SharePlan } from "../layout";
import { drawShare } from "../share";
import { createMockTarget } from "./helpers";

/** 与 `sheet.test.ts` 同一张夹具（6×6、33 个实心格、3 个空格）：分享图与施工图的格值必须同源。 */
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

/** 独立计数（不用 `cellAt` / `countTileBeads`：期望值必须与被测实现不同源）。 */
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

describe("drawShare", () => {
  const palette = makePalette();
  const pattern = makePattern(6, 6, CELLS_6X6);
  const plan = planShare(pattern);

  it("planShare 的画布尺寸 = 格数 × 格像素（与 512 无关），并把图纸宽高记在 cols / rows 上", () => {
    expect(plan.cols).toBe(6);
    expect(plan.rows).toBe(6);
    expect(plan.cellPx).toBe(64);
    expect(plan.canvasWidth).toBe(pattern.width * plan.cellPx);
    expect(plan.canvasHeight).toBe(pattern.height * plan.cellPx);
    expect(plan.canvasWidth).toBe(384);
    const big = planShare(makePattern(500, 500));
    expect(big.cols).toBe(500);
    expect(big.rows).toBe(500);
    expect(big.cellPx).toBe(4);
    expect(big.canvasWidth).toBe(2000);
    expect(big.canvasHeight).toBe(2000);
  });

  it("四角与格子 (4,5)：fillRect 的实参与 shareCellBox 逐位一致（(4,5) 是空格 ⇒ 那里没有 fillRect）", () => {
    const { target, calls } = createMockTarget();
    drawShare(target, pattern, palette, plan);

    // **列表的第四项必须是真空格**：夹具的空格在 (2,0) / (4,2) / (4,5)，而右下角 (5,5) 是**实心格 3**
    // （本文件后面那条颜色用例断言它被填成 `rgb(200, 200, 210)`）。第一版这里写的是 (5,5)，
    // 于是「空格不填」那一路**一次都没执行**——一条死分支（2026-10-05 任务级审查抓到）。
    for (const [col, row] of [[0, 0], [5, 0], [0, 5], [4, 5]] as const) {
      const box = shareCellBox(plan, col, row);
      const fill = calls.fills.find((candidate) => candidate.x === box.x && candidate.y === box.y);
      if ((pattern.cells[row * 6 + col] as number) === EMPTY) {
        expect(fill).toBeUndefined(); // (4,5) 是空格 ⇒ 一个块都不该有
        continue;
      }
      expect(fill).toMatchObject({ w: box.width, h: box.height });
      expect(box.width).toBe(plan.cellPx);
    }
    // 映射本身逐位钉住（分享图没有边距：0 格就在 (0,0)）
    expect(shareCellBox(plan, 0, 0)).toEqual({ x: 0, y: 0, width: 64, height: 64 });
    expect(shareCellBox(plan, 5, 5)).toEqual({ x: 320, y: 320, width: 64, height: 64 });
  });

  it("shareCellBox 的守卫与 cellBox 同口径（越界列 / 越界行 / 非安全整数）", () => {
    // 与任务 1 的 `layout.test.ts` 同口径地再钉一遍：渲染器现在**依赖**这条守卫（超范围取位置
    // 会静默画到画布外），所以它也得由渲染器这一侧的用例守着。
    expect(() => shareCellBox(plan, 6, 0)).toThrow("列 6 不在分享图范围 0–5 内");
    expect(() => shareCellBox(plan, 0, 6)).toThrow("行 6 不在分享图范围 0–5 内");
    expect(() => shareCellBox(plan, -1, 0)).toThrow("列 -1 不在分享图范围 0–5 内");
    expect(() => shareCellBox(plan, 0.5, 0)).toThrow("格子列号必须是安全整数");
    expect(() => shareCellBox(plan, 0, 2 ** 53)).toThrow("格子行号必须是安全整数");
  });

  it("关插值：imageSmoothingEnabled = false，且在第一次填充之前就已关闭", () => {
    const { target, calls } = createMockTarget();
    expect(target.imageSmoothingEnabled).toBe(true); // 桩的初值：证明这条断言不是恒真
    drawShare(target, pattern, palette, plan);
    expect(target.imageSmoothingEnabled).toBe(false);
    expect(calls.fills.length).toBeGreaterThan(0);
    expect(calls.fills.every((fill) => fill.smoothing === false)).toBe(true);
  });

  it("fillRect 次数 = 实心格数；空格一次都不填（画布零初始化 ⇒ 空格全透明）", () => {
    const { target, calls } = createMockTarget();
    drawShare(target, pattern, palette, plan);

    const solid = solidInRange(pattern, 0, 0, 6, 6);
    expect(solid).toBe(33);
    expect(calls.fills).toHaveLength(solid);

    const expected = new Set<string>();
    // 期望值故意**不**用 `shareCellBox` 现算：那句是被测实现自己走的映射，用它算期望等于自证。
    // 这里直接手写「列 × 格像素」（测试里做算术没问题，闸门只扫实现文件）。
    for (let row = 0; row < 6; row += 1) {
      for (let col = 0; col < 6; col += 1) {
        if ((pattern.cells[row * 6 + col] as number) !== EMPTY) {
          expected.add(`${col * plan.cellPx},${row * plan.cellPx}`);
        }
      }
    }
    expect(new Set(calls.fills.map((fill) => `${fill.x},${fill.y}`))).toEqual(expected);
    expect(calls.fills.every((fill) => fill.w === plan.cellPx && fill.h === plan.cellPx)).toBe(true);
    // `save` / `restore` 必须配平（当前两边都是 0）：不配平会泄漏 target 的全局状态。
    expect(calls.saves).toBe(calls.restores);
  });

  it("颜色逐格取自色卡；无网格、无文字、无边距", () => {
    const { target, calls } = createMockTarget();
    drawShare(target, pattern, palette, plan);

    expect(
      calls.fills.find((fill) => fill.x === plan.cellPx && fill.y === plan.cellPx),
    ).toMatchObject({ fillStyle: "rgb(0, 0, 0)" }); // (col=1, row=1) 是 1 号色（黑）
    expect(
      calls.fills.find((fill) => fill.x === 5 * plan.cellPx && fill.y === 5 * plan.cellPx),
    ).toMatchObject({ fillStyle: "rgb(200, 200, 210)" }); // (col=5, row=5) 是 4 号色（浅灰）

    expect(calls.texts).toEqual([]);
    expect(calls.paths).toEqual([]);
    expect(calls.strokeRects).toEqual([]);

    // 无边距：第一格从 (0,0) 起，最后一格正好贴到画布右下角
    expect(calls.fills.some((fill) => fill.x === 0 && fill.y === 0)).toBe(true);
    expect(
      calls.fills.some(
        (fill) => fill.x + fill.w === plan.canvasWidth && fill.y + fill.h === plan.canvasHeight,
      ),
    ).toBe(true);
  });

  it("全空格图纸 ⇒ 一个块都不画（结果是一张全透明 PNG）", () => {
    const blank = makePattern(3, 3, [
      EMPTY, EMPTY, EMPTY,
      EMPTY, EMPTY, EMPTY,
      EMPTY, EMPTY, EMPTY,
    ]);
    const { target, calls } = createMockTarget();
    drawShare(target, blank, palette, planShare(blank));
    expect(calls.fills).toEqual([]);
    expect(calls.texts).toEqual([]);
    expect(target.imageSmoothingEnabled).toBe(false);
  });

  it("plan 与图纸不符即抛（否则会静默画出缺角 / 多空的图）", () => {
    const { target, calls } = createMockTarget();

    const narrower = makePattern(5, 6);
    expect(() => drawShare(target, narrower, palette, plan)).toThrow(
      "分享图计划与图纸不符：计划 6×6、图纸 5×6",
    );
    expect(calls.fills).toEqual([]);

    const shorter = makePattern(6, 5);
    expect(() => drawShare(target, shorter, palette, plan)).toThrow(
      "分享图计划与图纸不符：计划 6×6、图纸 6×5",
    );
    expect(calls.fills).toEqual([]);
  });

  it("plan.kind 不匹配 / 色卡不一致：写在任何写操作之前", () => {
    // 标题只声称这两项：它们各有 `calls.fills` 为空作「动笔之前」的证据。
    // 本用例末尾的第三项（坏色号）**不属于**这两项——`drawShare` 的色号解析在绘制循环里，
    // 它只保证「响亮失败」，不保证画布干净（控制者 2026-10-05 裁定记 minor，理由与升级条件见
    // `share.ts` 那段 JSDoc）。
    const { target, calls } = createMockTarget();

    const sheetPlan = planSheets(pattern, palette);
    expect(() => drawShare(target, pattern, palette, sheetPlan as unknown as SharePlan)).toThrow(
      "plan 的类型不匹配：期望 share，实际 sheet",
    );
    expect(calls.fills).toEqual([]);

    expect(() => drawShare(target, pattern, { ...palette, id: "other" }, plan)).toThrow(
      "与传入的色卡 other 不一致",
    );
    expect(calls.fills).toEqual([]);

    // 坏色号：只钉「响亮失败」（不在这里断言 `calls.fills` 为空——那会把时机问题伪装成已守）
    const broken = makePattern(6, 6);
    broken.cells[0] = 9;
    expect(() => drawShare(target, broken, palette, planShare(broken))).toThrow(
      "色卡里没有下标 9 的颜色",
    );
  });
});
