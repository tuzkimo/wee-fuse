import { describe, expect, it } from "vitest";
import { rotateGrid, rotatedSize, rotationSwapsAxes } from "../rotate";
import type { Rotation, SampledGrid } from "../types";

/** 造一个 2×3（宽 2、高 3）的网格，红分量编码格子序号，便于断言映射。 */
function makeGrid(): SampledGrid {
  const width = 2;
  const height = 3;
  const rgb = new Float32Array(width * height * 3);
  const filled = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    rgb[i * 3] = i * 10;
    rgb[i * 3 + 1] = 0;
    rgb[i * 3 + 2] = 0;
    filled[i] = i === 5 ? 0 : 1;
  }
  return { width, height, rgb, filled };
}

/** 把网格的每格红分量读成二维数组，方便肉眼看映射结果。 */
function redRows(grid: SampledGrid): number[][] {
  const rows: number[][] = [];
  for (let y = 0; y < grid.height; y++) {
    const row: number[] = [];
    for (let x = 0; x < grid.width; x++) row.push(grid.rgb[(y * grid.width + x) * 3] as number);
    rows.push(row);
  }
  return rows;
}

describe("rotationSwapsAxes", () => {
  it("只有 90° 与 270° 互换宽高", () => {
    expect(rotationSwapsAxes(0)).toBe(false);
    expect(rotationSwapsAxes(1)).toBe(true);
    expect(rotationSwapsAxes(2)).toBe(false);
    expect(rotationSwapsAxes(3)).toBe(true);
  });
});

describe("rotatedSize", () => {
  it("90° 与 270° 互换宽高，0° 与 180° 保持不变", () => {
    expect(rotatedSize(2, 3, 0)).toEqual({ width: 2, height: 3 });
    expect(rotatedSize(2, 3, 1)).toEqual({ width: 3, height: 2 });
    expect(rotatedSize(2, 3, 2)).toEqual({ width: 2, height: 3 });
    expect(rotatedSize(2, 3, 3)).toEqual({ width: 3, height: 2 });
  });
});

describe("rotateGrid", () => {
  const original = makeGrid();
  // 原始布局（红分量）：
  //   0  10
  //  20  30
  //  40  50(空)

  it("0° 原样返回", () => {
    expect(rotateGrid(original, 0)).toBe(original);
  });

  it("顺时针 90°", () => {
    const r = rotateGrid(original, 1);
    expect(r.width).toBe(3);
    expect(r.height).toBe(2);
    expect(redRows(r)).toEqual([
      [40, 20, 0],
      [50, 30, 10],
    ]);
  });

  it("180°", () => {
    const r = rotateGrid(original, 2);
    expect(r.width).toBe(2);
    expect(r.height).toBe(3);
    expect(redRows(r)).toEqual([
      [50, 40],
      [30, 20],
      [10, 0],
    ]);
  });

  it("顺时针 270°", () => {
    const r = rotateGrid(original, 3);
    expect(r.width).toBe(3);
    expect(r.height).toBe(2);
    expect(redRows(r)).toEqual([
      [10, 30, 50],
      [0, 20, 40],
    ]);
  });

  it("空格标记跟着一起搬", () => {
    const r = rotateGrid(original, 1);
    // 原格序号 5 是空格，落在旋转后的 (0, 1)
    expect(r.filled[1 * r.width + 0]).toBe(0);
    expect(r.filled.reduce((s, v) => s + v, 0)).toBe(original.filled.reduce((s, v) => s + v, 0));
  });

  it("转四次回到原状", () => {
    let g = original;
    for (let i = 0; i < 4; i++) g = rotateGrid(g, 1);
    expect(g.width).toBe(original.width);
    expect(g.height).toBe(original.height);
    expect(redRows(g)).toEqual(redRows(original));
    expect(Array.from(g.filled)).toEqual(Array.from(original.filled));
  });

  it("对每个旋转角度，宽高都与 rotatedSize 一致", () => {
    for (const rotation of [0, 1, 2, 3] as Rotation[]) {
      const r = rotateGrid(original, rotation);
      expect({ width: r.width, height: r.height }).toEqual(rotatedSize(2, 3, rotation));
    }
  });
});
