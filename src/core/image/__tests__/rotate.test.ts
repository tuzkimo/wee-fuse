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

/**
 * 造一个 width × height 的网格，**三个颜色通道各自编码不同信息**：
 * R = i、G = 100 + i、B = 200 + i（i 为行优先格子序号），filled = i % 2。
 *
 * 简报原来的 fixture 只把序号写进 R 通道、G 与 B 恒为 0，因此删除 G/B 的搬运
 * 也不会让任何断言转红。这个 fixture 让 R/G/B/filled 四路各自可判别：
 * 任意一路漏搬或搬错，下面的断言都会转红。
 */
function makeChannelGrid(width = 3, height = 2): SampledGrid {
  const count = width * height;
  const rgb = new Float32Array(count * 3);
  const filled = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    rgb[i * 3] = i;
    rgb[i * 3 + 1] = 100 + i;
    rgb[i * 3 + 2] = 200 + i;
    filled[i] = i % 2;
  }
  return { width, height, rgb, filled };
}

/** 目的网格的行跨度（= 目的宽）。rotation 1/3 互换宽高，0/2 不变。 */
function destStride(source: SampledGrid, rotation: Rotation): number {
  return rotation === 1 || rotation === 3 ? source.height : source.width;
}

/** 一个行列坐标在网格里的全局序号（行优先）。与 rotate.ts 无关。 */
function indexOf(x: number, y: number, width: number): number {
  return y * width + x;
}

/**
 * 独立算出「**目的**格 (dx, dy) 应当从**源**格 (sx, sy) 取色」的那个源坐标。
 * 这是简报映射公式的逆（对每个角度把 dx/dy 反解回 sx/sy），
 * 与 `rotate.ts` 里 rotateGrid 的代码**无共享实现**，是一把独立的尺子。
 */
function sourceForDest(
  dx: number,
  dy: number,
  sourceWidth: number,
  sourceHeight: number,
  rotation: Rotation,
): { x: number; y: number } {
  if (rotation === 0) return { x: dx, y: dy };
  if (rotation === 1) return { x: dy, y: sourceHeight - 1 - dx };
  if (rotation === 2) return { x: sourceWidth - 1 - dx, y: sourceHeight - 1 - dy };
  return { x: sourceWidth - 1 - dy, y: dx };
}

/** 读输出网格的每格 `[R, G, B, filled]`，行优先排列。 */
function readChannels(grid: SampledGrid): ReadonlyArray<readonly [number, number, number, number]> {
  const cells: Array<[number, number, number, number]> = [];
  for (let i = 0; i < grid.width * grid.height; i++) {
    cells.push([
      grid.rgb[i * 3] as number,
      grid.rgb[i * 3 + 1] as number,
      grid.rgb[i * 3 + 2] as number,
      grid.filled[i] as number,
    ]);
  }
  return cells;
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

  it("三个颜色通道与 filled 分别按角度和尺寸逐格搬运", () => {
    const sources: readonly SampledGrid[] = [
      makeChannelGrid(3, 2), // 宽高互换，覆盖 rotation 1/3 的换轴
      makeChannelGrid(2, 3), // 与简报 fixture 同尺寸
    ];

    for (const source of sources) {
      for (const rotation of [0, 1, 2, 3] as Rotation[]) {
        const label = `源 ${source.width}×${source.height}、rotation=${rotation}`;
        const r = rotateGrid(source, rotation);
        const dw = destStride(source, rotation);
        const dh = (source.width * source.height) / dw;

        // 期望值按「目的格 (dx, dy) ← 源格 sourceForDest(...)」逐格独立算出。
        const expected: number[][] = [];
        for (let dy = 0; dy < dh; dy++) {
          for (let dx = 0; dx < dw; dx++) {
            const s = sourceForDest(dx, dy, source.width, source.height, rotation);
            const si = indexOf(s.x, s.y, source.width);
            expected.push([
              source.rgb[si * 3] as number,
              source.rgb[si * 3 + 1] as number, // G 通道：简报 fixture 恒为 0，此处必须被打红
              source.rgb[si * 3 + 2] as number, // B 通道：同上
              source.filled[si] as number,
            ]);
          }
        }

        // soft：一个组合失败不遮蔽其余组合，且报错里带上 label 便于定位。
        expect.soft({ width: r.width, height: r.height }, label).toEqual({ width: dw, height: dh });
        expect.soft(readChannels(r), label).toEqual(expected);
      }
    }
  });

  it("顺时针 90° 的 R/G/B/filled 逐格等于字面期望矩阵", () => {
    // 与简报原 fixture 同尺寸（源 2×3，输出宽高互换为 2 行 × 3 列）。
    const source = makeChannelGrid(2, 3);
    const r = rotateGrid(source, 1);
    // 源布局（每格 [R, G, B, filled]），行优先：
    //   [0,100,200,0]  [1,101,201,1]
    //   [2,102,202,0]  [3,103,203,1]
    //   [4,104,204,0]  [5,105,205,1]
    //
    // 期望矩阵按「行 × 列」写成二维，避免任何手算的 stride。每格红分量除以 10 后
    // 正好逐格复现简报步骤 2「顺时针 90°」期望矩阵 [[40,20,0],[50,30,10]] 的 R 通道；
    // 本用例只是额外把 G、B、filled 三路也钉住。
    const expectedRows = [
      [
        [4, 104, 204, 0],
        [2, 102, 202, 0],
        [0, 100, 200, 0],
      ],
      [
        [5, 105, 205, 1],
        [3, 103, 203, 1],
        [1, 101, 201, 1],
      ],
    ];

    expect({ width: r.width, height: r.height }).toEqual({ width: 3, height: 2 });
    const cells = readChannels(r);
    // 宽高必须与期望矩阵形状一致，下面的展平比较才有意义。
    expect(r.width).toBe(expectedRows[0].length);
    expect(r.height).toBe(expectedRows.length);
    expect(cells).toEqual(expectedRows.flat());
    expect(cells.map((c) => c[0])).toEqual([4, 2, 0, 5, 3, 1]);

    // 角点点名（四个通道一起校验），下标全部经 cellsAt 从期望矩阵反查，杜绝手算 stride：
    // 目的左上角 ← 源序号 4（源左下角）；目的右下角 ← 源序号 1；目的右上角 ← 源序号 5。
    const cellsAt = (srcIndex: number): readonly [number, number, number, number] => {
      for (const [y, row] of expectedRows.entries()) {
        for (const [x, cell] of row.entries()) {
          if (cell[0] === srcIndex) return cells[y * r.width + x] as [number, number, number, number];
        }
      }
      throw new Error(`期望矩阵里找不到源序号 ${srcIndex}`);
    };
    expect(cellsAt(0)).toEqual([0, 100, 200, 0]);
    expect(cellsAt(1)).toEqual([1, 101, 201, 1]);
    expect(cellsAt(4)).toEqual([4, 104, 204, 0]);
    // filled 与 R/G/B 同路搬运：源里唯一 filled=0 的是源序号 5，
    // 它落在目的右上角——若漏搬 filled，这一格会变成 1 而把上面整条断言打红。
    expect(cellsAt(5)).toEqual([5, 105, 205, 1]);
    // 必须用 cells 取整格：写成 `[r.rgb[i], r.rgb[j], r.filled[k]]` 会被 JS 当成
    // 逗号运算符（表达式整体只取最后一个值），断言会静默失去判别力。
  });

  it("非法 rotation 抛错，不静默按 270° 处理", () => {
    for (const bad of [4, -1, 1.5, Number.NaN]) {
      expect(() => rotateGrid(original, bad as unknown as Rotation)).toThrow(/旋转角度非法/);
    }
    // 合法值不受影响
    expect(() => rotateGrid(original, 3)).not.toThrow();
  });
});
