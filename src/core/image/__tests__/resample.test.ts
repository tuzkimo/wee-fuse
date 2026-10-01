import { describe, expect, it } from "vitest";
import { resampleToGrid } from "../resample";
import type { RgbaImage } from "../types";

/** 用 4 元组数组造一张位图，便于在用例里直观看清像素。 */
function makeImage(width: number, height: number, pixels: ReadonlyArray<readonly [number, number, number, number]>): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  pixels.forEach((p, i) => {
    data[i * 4] = p[0];
    data[i * 4 + 1] = p[1];
    data[i * 4 + 2] = p[2];
    data[i * 4 + 3] = p[3];
  });
  return { width, height, data };
}

/**
 * 按规格给定的像素分配规则算出期望的整数区间 [x0, x1)。
 * 用整数分子（`g * srcSize`）而不是浮点 scale 计算，避免把被修掉的浮点误差写进期望值。
 */
function expectedRange(g: number, cellCount: number, srcSize: number): { x0: number; x1: number } {
  const x0 = Math.floor((g * srcSize) / cellCount);
  const x1 = Math.max(x0 + 1, Math.floor(((g + 1) * srcSize) / cellCount));
  return { x0: Math.min(x0, srcSize - 1), x1: Math.min(x1, srcSize) };
}

/**
 * 一维轴的描述子：把「沿某条轴的一维长度」映射成 `width × height` 的调用参数，
 * 并说明该轴的坐标写在哪个颜色通道上。`toSize` 由调用方（源图各用例）在适当的
 * 位置换轴——例如源体为 `1 × 15` 时用 `(size) => [1, size]`。
 */
const AXES = {
  x: {
    /** x 轴的坐标写在 R 通道（下标 0）。 */
    channel: 0,
    /** 第 x 列取 R = x。 */
    pixelAt: (lineSize: number): readonly [number, number, number, number] => [
      lineSize,
      0,
      0,
      255,
    ],
    /** 沿 x 的长度放到宽上。 */
    toSize: (lineSize: number): readonly [number, number] => [lineSize, 1],
    key: (srcSize: number, cellCount: number): string => `S=${srcSize},G=${cellCount}`,
  },
  y: {
    /** y 轴的坐标写在 G 通道（下标 1）。 */
    channel: 1,
    /** 第 y 行取 G = y。 */
    pixelAt: (lineSize: number): readonly [number, number, number, number] => [
      0,
      lineSize,
      0,
      255,
    ],
    /** 沿 y 的长度放到高上。 */
    toSize: (lineSize: number): readonly [number, number] => [1, lineSize],
    key: (srcSize: number, cellCount: number): string => `H=${srcSize},G=${cellCount}`,
  },
} as const;

type Axis = (typeof AXES)[keyof typeof AXES];

/** 造一张「沿 `axis` 的坐标写进该轴通道」的源图。 */
function makeAxisImage(srcSize: number, axis: Axis): RgbaImage {
  const [width, height] = axis.toSize(srcSize);
  const pixels = Array.from({ length: srcSize }, (_, k) => axis.pixelAt(k));
  return makeImage(width, height, pixels);
}

/** 读第 `g` 格在该轴通道上的值。 */
function readAxisChannel(rgb: Float32Array, channel: number, g: number): number {
  return rgb[g * 3 + channel] ?? Number.NaN;
}


describe("resampleToGrid", () => {
  it("纯色图：平均值就是该色，全部实心", () => {
    const img = makeImage(2, 2, Array.from({ length: 4 }, () => [10, 20, 30, 255] as const));
    const grid = resampleToGrid(img, 1, 1);
    expect(grid.width).toBe(1);
    expect(grid.height).toBe(1);
    expect(grid.filled[0]).toBe(1);
    expect(grid.rgb[0]).toBeCloseTo(10, 6);
    expect(grid.rgb[1]).toBeCloseTo(20, 6);
    expect(grid.rgb[2]).toBeCloseTo(30, 6);
  });

  it("2×2 四色图降到 1×1 得到四像素平均", () => {
    const img = makeImage(2, 2, [
      [0, 0, 0, 255],
      [100, 0, 0, 255],
      [0, 200, 0, 255],
      [0, 0, 40, 255],
    ]);
    const grid = resampleToGrid(img, 1, 1);
    expect(grid.rgb[0]).toBeCloseTo(25, 6);
    expect(grid.rgb[1]).toBeCloseTo(50, 6);
    expect(grid.rgb[2]).toBeCloseTo(10, 6);
  });

  it("透明像素不参与平均", () => {
    const img = makeImage(2, 1, [
      [255, 0, 0, 0],
      [0, 0, 255, 255],
    ]);
    const grid = resampleToGrid(img, 1, 1);
    expect(grid.filled[0]).toBe(1);
    expect(grid.rgb[0]).toBeCloseTo(0, 6);
    expect(grid.rgb[1]).toBeCloseTo(0, 6);
    expect(grid.rgb[2]).toBeCloseTo(255, 6);
  });

  it("半透明像素按 alpha 加权", () => {
    const img = makeImage(2, 1, [
      [0, 0, 0, 64],
      [255, 255, 255, 255],
    ]);
    const grid = resampleToGrid(img, 1, 1);
    // 权重为 64/255 与 1，白色占比 1 / (1 + 64/255) = 255/319 → 255 × 255/319 ≈ 203.8401
    expect(grid.filled[0]).toBe(1);
    expect(grid.rgb[0]).toBeCloseTo(203.8401, 2);
  });

  it("整格全透明判为空格", () => {
    const img = makeImage(2, 2, Array.from({ length: 4 }, () => [200, 100, 50, 0] as const));
    const grid = resampleToGrid(img, 1, 1);
    expect(grid.filled[0]).toBe(0);
    expect(grid.rgb[0]).toBe(0);
  });

  it("覆盖率低于阈值判为空格", () => {
    // 4×4 里只有 1 个不透明像素，覆盖率 1/16 = 0.0625 < 0.25
    const pixels = Array.from({ length: 16 }, (_, i) =>
      i === 0 ? ([255, 0, 0, 255] as const) : ([255, 0, 0, 0] as const),
    );
    const img = makeImage(4, 4, pixels);
    const grid = resampleToGrid(img, 1, 1);
    expect(grid.filled[0]).toBe(0);
  });

  it("覆盖率恰好达到阈值判为实心", () => {
    // 4×4 里 4 个不透明像素，覆盖率 4/16 = 0.25，等于阈值
    const pixels = Array.from({ length: 16 }, (_, i) =>
      i < 4 ? ([0, 255, 0, 255] as const) : ([0, 255, 0, 0] as const),
    );
    const img = makeImage(4, 4, pixels);
    const grid = resampleToGrid(img, 1, 1);
    expect(grid.filled[0]).toBe(1);
    expect(grid.rgb[1]).toBeCloseTo(255, 6);
  });

  it("逐格区分实心与空格", () => {
    const img = makeImage(2, 1, [
      [255, 255, 255, 255],
      [0, 0, 0, 0],
    ]);
    const grid = resampleToGrid(img, 2, 1);
    expect(Array.from(grid.filled)).toEqual([1, 0]);
  });

  it("非整数缩放不重不漏地分配像素", () => {
    // 3 像素宽 → 2 格：第 0 格拿像素 0，第 1 格拿像素 1、2
    const img = makeImage(3, 1, [
      [10, 0, 0, 255],
      [20, 0, 0, 255],
      [40, 0, 0, 255],
    ]);
    const grid = resampleToGrid(img, 2, 1);
    expect(grid.rgb[0]).toBeCloseTo(10, 6);
    expect(grid.rgb[3]).toBeCloseTo(30, 6);
  });

  it("放大时退化为最近邻", () => {
    const img = makeImage(2, 1, [
      [10, 0, 0, 255],
      [200, 0, 0, 255],
    ]);
    const grid = resampleToGrid(img, 4, 1);
    expect(Array.from(grid.rgb.filter((_, i) => i % 3 === 0))).toEqual([10, 10, 200, 200]);
  });

  it("输出尺寸非法时抛错", () => {
    const img = makeImage(1, 1, [[0, 0, 0, 255]]);
    expect(() => resampleToGrid(img, 0, 1)).toThrow(/目标网格尺寸非法/);
    expect(() => resampleToGrid(img, 1, -1)).toThrow(/目标网格尺寸非法/);
  });

  /**
   * —— 最终审查 F1 追加 ——
   * 上一条只覆盖 `0` 与 `-1`，而修复前的守卫是 `width < 1 || height < 1`：
   * - `NaN < 1` 为假 → `resampleToGrid(src, NaN, 1)` **不抛错**，返回
   *   `{ width: NaN, height: 1, rgb: length 0, filled: length 0 }`；
   * - `2.5` 也过闸，缓冲区按 `2.5 × 1` 截断成 2 格，而循环跑到第 3 格，
   *   越界写被 TypedArray **静默丢弃**（`filled` 长 2、`rgb` 长 7）。
   * 两个方向的每个非法值都要测：只测宽度会漏掉 `height` 上同一段代码的复制粘贴错误。
   * 简报原文的断言一条未改。
   */
  it("[追加] 目标尺寸必须为整数且 >= 1：NaN / 小数 / 0 / 负数在宽高两个方向都抛错", () => {
    const img = makeImage(1, 1, [[0, 0, 0, 255]]);
    const bad: number[] = [Number.NaN, 2.5, 0, -1, Number.POSITIVE_INFINITY];
    for (const value of bad) {
      expect(() => resampleToGrid(img, value, 1)).toThrow(/目标网格尺寸非法/);
      expect(() => resampleToGrid(img, 1, value)).toThrow(/目标网格尺寸非法/);
    }
  });

  it("源数据长度与尺寸不符时抛错", () => {
    const bad: RgbaImage = { width: 2, height: 2, data: new Uint8ClampedArray(4) };
    expect(() => resampleToGrid(bad, 1, 1)).toThrow(/长度与尺寸不一致/);
  });

  it("末格必须覆盖到最后一列像素（源宽 15 → 11 格）", () => {
    // 回归用例：15/11 的浮点 scale 会让末格右界掉到 14，像素 14 被整列跳过。
    // 全白、只把第 14 号像素改成黑：漏采时末格均值仍是 255（看不出漏了黑像素），
    // 正确覆盖 [13,15) 时均值为 (255 + 0) / 2 = 127.5。
    const pixels = Array.from({ length: 15 }, (_, i) =>
      i === 14 ? ([0, 0, 0, 255] as const) : ([255, 255, 255, 255] as const),
    );
    const img = makeImage(15, 1, pixels);
    const grid = resampleToGrid(img, 11, 1);
    expect(grid.width).toBe(11);
    expect(grid.rgb[10 * 3]).toBeCloseTo(127.5, 6);
  });

  it("缩小时每格的平均值等于该格真实整数区间内下标（逐轴：x 与 y）的算术平均", () => {
    // 属性用例：沿该轴的源坐标 k 写进该轴通道，于是每格该通道必然是
    // 该格真实覆盖下标 [p0, p1) 的算术平均 (p0 + p1 - 1) / 2。
    // **逐轴参数化**：x（列 → R）与 y（行 → G）是同一段逻辑的两个实例，
    // 各自穷举源尺寸 ≤ 40 的全部缩小/等尺寸组合（格数 ≤ 源尺寸）。
    // 把两条轴放进同一次执行，避免为 y 轴再复制一份循环体（上一轮留下的债务）。
    // 每个组合只做一次序列比较（逐格断言会让两万多个格子拖慢全量测试）。
    let combinations = 0;
    let checked = 0;
    const bad: string[] = [];

    for (const axis of [AXES.x, AXES.y]) {
      for (let srcSize = 1; srcSize <= 40; srcSize++) {
        const img = makeAxisImage(srcSize, axis);
        for (let cellCount = 1; cellCount <= srcSize; cellCount++) {
          const [width, height] = axis.toSize(cellCount);
          const grid = resampleToGrid(img, width, height);
          const expected: number[] = [];
          for (let g = 0; g < cellCount; g++) {
            const { x0, x1 } = expectedRange(g, cellCount, srcSize);
            expected.push((x0 + x1 - 1) / 2);
          }
          const actual: number[] = [];
          for (let g = 0; g < cellCount; g++) {
            actual.push(readAxisChannel(grid.rgb, axis.channel, g));
          }
          const filledAll = grid.filled.every((value) => value === 1);
          if (!filledAll || actual.some((value, i) => Math.abs(value - expected[i]) > 1e-6)) {
            bad.push(axis.key(srcSize, cellCount));
          }
          combinations += 1;
          checked += cellCount;
        }
      }
    }

    // 两条轴 × 820 个缩小组合 = 1640、合计 22960 个格子，一个都不许漏
    expect({ combinations, checked, badCombos: bad.length, bad }).toEqual({
      combinations: 1640,
      checked: 22960,
      badCombos: 0,
      bad: [],
    });
  });

  it("缩小时输出尺寸必须等于请求尺寸，且缓冲区长度自洽（NaN 吞不掉尺寸回归）", () => {
    // 账本「任务 4 延后 Minor」第 1 条：上面那条收缩属性用例只读通道值，而
    // `readAxisChannel` 对越界下标返回 NaN、`Math.abs(NaN - expected) > 1e-6` 恒为 false，
    // 因此「输出网格比请求的小」这类回归会被静默吞掉（假绿路径）。这条与它互补：
    // 不看颜色，只钉尺寸与缓冲区长度，任一处缩水都会响亮转红。
    let mismatches = 0;
    let combinations = 0;
    for (const axis of [AXES.x, AXES.y]) {
      for (let srcSize = 1; srcSize <= 40; srcSize++) {
        const img = makeAxisImage(srcSize, axis);
        for (let cellCount = 1; cellCount <= srcSize; cellCount++) {
          const [width, height] = axis.toSize(cellCount);
          const grid = resampleToGrid(img, width, height);
          if (
            grid.width !== width ||
            grid.height !== height ||
            grid.rgb.length !== width * height * 3 ||
            grid.filled.length !== width * height
          ) {
            mismatches += 1;
          }
          combinations += 1;
        }
      }
    }
    expect({ combinations, mismatches }).toEqual({ combinations: 1640, mismatches: 0 });
  });

  it("放大时每格恰好取 1 个源像素（逐轴，含补洞分支）", () => {
    // 沿该轴的源下标写进该轴通道，于是每格该通道精确指出它取了哪个源像素。
    // 放大路径每格的原始区间**至多含 1 个像素**：非空者直接用，空者被
    // `if (x1 <= x0) x1 = x0 + 1;` / `if (y1 <= y0) y1 = y0 + 1;` 这个补洞分支补成 1 像素。
    // 因此每格只取一个源像素、无混色，取值随格号单调不减。
    // **逐轴参数化**：x 轴与 y 轴各跑一份，y 轴的补洞分支（`resample.ts` 的 `if (y1 <= y0)`）
    // 在 `G ≤ S` 时恒不触发，只有这条用例能覆盖到它。
    let combinations = 0;
    let checked = 0;
    let rawSinglePixel = 0; // 原始区间非空且恰 1 像素
    let rawEmptyHole = 0; // 原始区间为空 → 必须靠补洞分支
    let rawTooLong = 0; // 原始区间 > 1 像素（放大时不应出现）
    const bad: string[] = [];

    for (const axis of [AXES.x, AXES.y]) {
      for (let srcSize = 1; srcSize <= 20; srcSize++) {
        const img = makeAxisImage(srcSize, axis);
        for (let cellCount = srcSize + 1; cellCount <= srcSize * 4; cellCount++) {
          const [width, height] = axis.toSize(cellCount);
          const grid = resampleToGrid(img, width, height);
          const actual: number[] = [];
          const expected: number[] = [];
          for (let g = 0; g < cellCount; g++) {
            actual.push(readAxisChannel(grid.rgb, axis.channel, g));
            // 期望用整数分子独立推导：格 g 取唯一的源下标
            expected.push(Math.min(srcSize - 1, Math.floor((g * srcSize) / cellCount)));
          }
          // 直接按规格数一遍原始区间，证明「非空单像素」与「空 → 补洞」两种格子都真实出现；
          // 同时把原始区间 > 1 的格子计入 rawTooLong，聚合断言为 0——
          // 这正是「原始区间至多含 1 个像素」这条注释的不变式（逐格 expect 会拖慢全量测试）。
          for (let g = 0; g < cellCount; g++) {
            const rawLength =
              Math.floor(((g + 1) * srcSize) / cellCount) - Math.floor((g * srcSize) / cellCount);
            if (rawLength === 1) rawSinglePixel += 1;
            else if (rawLength <= 0) rawEmptyHole += 1;
            else rawTooLong += 1;
          }
          const filledAll = grid.filled.every((value) => value === 1);
          const monotonic = actual.every((value, i) => i === 0 || value >= (actual[i - 1] ?? 0));
          if (!filledAll || !monotonic || JSON.stringify(actual) !== JSON.stringify(expected)) {
            bad.push(axis.key(srcSize, cellCount));
          }
          combinations += 1;
          checked += cellCount;
        }
      }
    }

    // 两条轴 × 630 个放大组合 = 1260、合计 43680 个格子
    expect({
      combinations,
      checked,
      rawSinglePixel,
      rawEmptyHole,
      rawTooLong,
      badCombos: bad.length,
      bad,
    }).toEqual({
      combinations: 1260,
      checked: 43680,
      // 两条轴各自 8610 / 13230；两轴合计即下面两个数。两者都 > 0，
      // 说明「非空单像素」与「空 → 补洞」两种分支都被真实执行到。
      rawSinglePixel: 17220,
      rawEmptyHole: 26460,
      rawTooLong: 0,
      badCombos: 0,
      bad: [],
    });
  });

  it("放大 2 → 4 仍是 [10, 10, 200, 200]（既有行为逐格未变）", () => {
    const img = makeImage(2, 1, [
      [10, 0, 0, 255],
      [200, 0, 0, 255],
    ]);
    const grid = resampleToGrid(img, 4, 1);
    // 每格恰好 1 个源像素 → 每格都是源色本身，绝不出现混色中间值
    expect(Array.from(grid.rgb.filter((_, i) => i % 3 === 0))).toEqual([10, 10, 200, 200]);
    expect(Array.from(grid.filled)).toEqual([1, 1, 1, 1]);
  });

  it("末格必须覆盖到最后一行像素（源高 15 → 11 格，转置定点）", () => {
    // 上一条定点用例是「宽 15 → 11 列」，这条是它的转置（高 15 → 11 行）。
    // 必要性：其余用例的 height 要么是 1（y 路径退化为恒等映射），要么缩放比是精确整数
    // （2×2 / 4×4，新旧公式逐格相同），所以 y 方向（resample.ts 的 y0/y1 两行）
    // 原先没有任何回归覆盖——把 `src.height` 误写成 `src.width`，或在两者恰好相等的
    // 2×2 / 4×4 场合改回浮点，旧用例都会全绿而末行 bug 复活。
    // 第 14 行取黑、其余全白：漏采时末格 G 仍是 255，正确覆盖 [13,15) 时是 (255+0)/2 = 127.5。
    const rows: Array<readonly [number, number, number, number]> = [];
    for (let y = 0; y < 15; y++) {
      rows.push(y === 14 ? ([0, 0, 0, 255] as const) : ([255, 255, 255, 255] as const));
    }
    const img = makeImage(1, 15, rows);
    const grid = resampleToGrid(img, 1, 11);
    expect(grid.width).toBe(1);
    expect(grid.height).toBe(11);
    // 末行（第 10 格）的 G 通道
    expect(grid.rgb[10 * 3 + 1]).toBeCloseTo(127.5, 6);
  });
});
