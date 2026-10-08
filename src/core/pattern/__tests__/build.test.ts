import { describe, expect, it } from "vitest";
import { loadPalette } from "../../palette/registry";
import { BOARD_COLS } from "../board";
import {
  buildPattern,
  buildPatternFromImage,
  computeDecodeSize,
  computeGridSize,
  PIXELS_PER_CELL,
} from "../build";
import { EMPTY, MAX_LONG_SIDE, MIN_LONG_SIDE, type MaxColors, type Pattern } from "../types";
import type { RgbaImage, SampledGrid } from "../../image/types";

const palette = loadPalette({
  id: "fake",
  name: "测试色卡",
  source: "https://example.com",
  accuracy: "仅测试用",
  colors: [
    { code: "A1", hex: "#ffffff" },
    { code: "A2", hex: "#000000" },
    { code: "A3", hex: "#ff0000" },
    { code: "A4", hex: "#00ff00" },
    { code: "A5", hex: "#0000ff" },
  ],
});

function grid(width: number, height: number, cells: ReadonlyArray<readonly [number, number, number] | null>): SampledGrid {
  const rgb = new Float32Array(width * height * 3);
  const filled = new Uint8Array(width * height);
  cells.forEach((c, i) => {
    if (c === null) return;
    filled[i] = 1;
    rgb[i * 3] = c[0];
    rgb[i * 3 + 1] = c[1];
    rgb[i * 3 + 2] = c[2];
  });
  return { width, height, rgb, filled };
}

const codeAt = (p: { cells: Uint16Array }, paletteCodes: string[], i: number): string => {
  const v = p.cells[i] as number;
  return v === EMPTY ? "EMPTY" : (paletteCodes[v] as string);
};

const codes = palette.colors.map((c) => c.code);

describe("computeGridSize", () => {
  it("横图：宽等于长边，高按比例", () => {
    expect(computeGridSize(400, 200, 58)).toEqual({ width: 58, height: 29 });
  });

  it("竖图：高等于长边，宽按比例", () => {
    expect(computeGridSize(200, 400, 58)).toEqual({ width: 29, height: 58 });
  });

  it("正方形：两边都等于长边", () => {
    expect(computeGridSize(300, 300, 29)).toEqual({ width: 29, height: 29 });
  });

  it("极端细长图短边至少为 1", () => {
    expect(computeGridSize(1000, 4, 58)).toEqual({ width: 58, height: 1 });
  });

  it("长边越界抛错", () => {
    expect(() => computeGridSize(100, 100, 0)).toThrow(/长边豆数/);
    expect(() => computeGridSize(100, 100, 501)).toThrow(/长边豆数/);
    expect(() => computeGridSize(100, 100, 2.5)).toThrow(/长边豆数/);
  });

  it("裁剪尺寸非法抛错", () => {
    expect(() => computeGridSize(0, 100, 29)).toThrow(/裁剪区域尺寸非法/);
  });
});

describe("computeGridSize（追加：长边落在哪一维、四舍五入方向、边界合法性）", () => {
  it("竖图的短边按比例四舍五入，落点是 round 而不是 floor/ceil", () => {
    // 58 × 200 / 1000 = 11.6 → round 12（floor 得 11、ceil 得 12）
    expect(computeGridSize(200, 1000, 58)).toEqual({ width: 12, height: 58 });
    // 60 × 30 / 1000 = 1.8 → 2（floor 会得 1）
    expect(computeGridSize(1000, 30, 60)).toEqual({ width: 60, height: 2 });
  });

  it("恰好 .5 时向上取整（Math.round 的半程方向）", () => {
    // 58 × 200 / 800 = 14.5 → 15；若实现用 floor 得 14、用「四舍六入五成双」得 14
    expect(computeGridSize(200, 800, 58)).toEqual({ width: 15, height: 58 });
    // 100 × 15 / 200 = 7.5 → 8（floor 得 7）
    expect(computeGridSize(200, 15, 100)).toEqual({ width: 100, height: 8 });
  });

  it("短边四舍五入到 0 时夹到 1（两端都要夹）", () => {
    expect(computeGridSize(1000, 4, 58)).toEqual({ width: 58, height: 1 });
    expect(computeGridSize(4, 1000, 58)).toEqual({ width: 1, height: 58 });
  });

  it("长边恰为 MIN/MAX 时合法，越界一律抛错（含负值与 NaN）", () => {
    expect(computeGridSize(10, 10, MIN_LONG_SIDE)).toEqual({ width: 1, height: 1 });
    expect(computeGridSize(10, 10, MAX_LONG_SIDE)).toEqual({ width: 116, height: 116 });
    expect(() => computeGridSize(10, 10, -1)).toThrow(/长边豆数/);
    expect(() => computeGridSize(10, 10, 116.5)).toThrow(/长边豆数/);
    expect(() => computeGridSize(10, 10, Number.NaN)).toThrow(/长边豆数/);
  });

  it("裁剪高非法同样抛错（不只是宽）", () => {
    expect(() => computeGridSize(100, 0, 29)).toThrow(/裁剪区域尺寸非法/);
    expect(() => computeGridSize(100, -3, 29)).toThrow(/裁剪区域尺寸非法/);
  });

  it("裁剪尺寸非有限时抛错（NaN / Infinity 曾静默算出 NaN 网格或看似正常的网格）", () => {
    // 修复前只查 `< 1`：`Infinity < 1` 为假 → 算出看似正常的 {4,1}；`NaN < 1` 为假 →
    // 一路算出 NaN 网格，直到下游才以别的形式炸开（真正的拒绝发生在 chooseDecoderPath）。
    expect(() => computeGridSize(Number.NaN, 100, 29)).toThrow(/裁剪区域尺寸非法/);
    expect(() => computeGridSize(100, Number.NaN, 29)).toThrow(/裁剪区域尺寸非法/);
    expect(() => computeGridSize(Number.POSITIVE_INFINITY, 100, 29)).toThrow(/裁剪区域尺寸非法/);
    expect(() => computeGridSize(100, Number.NEGATIVE_INFINITY, 29)).toThrow(/裁剪区域尺寸非法/);
    expect(() => computeGridSize(Number.POSITIVE_INFINITY, Number.NaN, 29)).toThrow(
      /裁剪区域尺寸非法/,
    );
  });
});

describe("computeDecodeSize", () => {
  it("是网格尺寸的 4 倍", () => {
    expect(computeDecodeSize(58, 29)).toEqual({ targetWidth: 232, targetHeight: 116 });
  });
});

describe("computeDecodeSize（追加：入口整数校验与常量锁定）", () => {
  /**
   * **本用例在最终审查 F1 轮被改写（原断言「网格尺寸为 0 时每边至少 1 像素」已删）**：
   * 原断言钉的是 `Math.max(1, v)` 的静默夹取（`computeDecodeSize(0, 0)` → `{1, 1}`），
   * 而 F1/F12 确立的口径是「网格/尺寸类入口必须整数且 >= 1，非法输入响亮失败」——
   * 0 正是非法网格尺寸，静默抬成 1 像素会掩盖上游算错。`Math.max(1, …)` 作为函数内部
   * 下界防御仍在，但不再对非法入口生效。这是**既有追加用例的契约变更**，非简报原文
   * （简报原文的 `computeDecodeSize` 用例只有「是网格尺寸的 4 倍」一条，见本文件上文）。
   */
  it("[F1 改写] 网格尺寸必须为整数且 >= 1：0 / 负数 / 小数 / 非有限在宽高两个方向都抛错", () => {
    const bad: number[] = [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY];
    for (const value of bad) {
      expect(() => computeDecodeSize(value, 1)).toThrow(/网格尺寸非法/);
      expect(() => computeDecodeSize(1, value)).toThrow(/网格尺寸非法/);
    }
    expect(() => computeDecodeSize(0, 0)).toThrow(/网格尺寸非法/);
  });

  it("PIXELS_PER_CELL 锁定为 4（规格 §12.1 的 116 = 29×4 绑在它上面）", () => {
    expect(PIXELS_PER_CELL).toBe(4);
    expect(computeDecodeSize(1, 1)).toEqual({ targetWidth: 4, targetHeight: 4 });
  });
});

describe("关键常量", () => {
  it("EMPTY 是 Uint16 最大值，任何色卡下标都不可能撞上", () => {
    expect(EMPTY).toBe(0xffff);
    expect(EMPTY).toBeGreaterThan(220); // MARD221 的最大下标 220
  });

  it("长边豆数范围是 1–116（= 4 × 29，四块板）", () => {
    expect(MIN_LONG_SIDE).toBe(1);
    expect(MAX_LONG_SIDE).toBe(116);
    // 与 board.ts 同源：不写字面量 116 的第二份解释
    expect(MAX_LONG_SIDE).toBe(4 * BOARD_COLS);
    expect(computeGridSize(10, 10, MAX_LONG_SIDE)).toEqual({ width: 116, height: 116 });
    expect(() => computeGridSize(10, 10, 117)).toThrow(/长边豆数/);
  });
});

describe("buildPattern", () => {
  it("纯色图整格都是同一个色号", () => {
    const g = grid(2, 2, [
      [255, 0, 0],
      [255, 0, 0],
      [255, 0, 0],
      [255, 0, 0],
    ]);
    const pattern = buildPattern(g, palette, { maxColors: 16 });
    expect(pattern.width).toBe(2);
    expect(pattern.height).toBe(2);
    expect([...pattern.cells]).toEqual([2, 2, 2, 2]);
    expect(pattern.paletteId).toBe("fake");
  });

  it("空格保持为 EMPTY，不会被映射成颜色", () => {
    const g = grid(2, 1, [[0, 0, 255], null]);
    const pattern = buildPattern(g, palette, { maxColors: 16 });
    expect(codeAt(pattern, codes, 0)).toBe("A5");
    expect(pattern.cells[1]).toBe(EMPTY);
  });

  it("全空格时不抛错，整图都是 EMPTY", () => {
    const g = grid(2, 2, [null, null, null, null]);
    const pattern = buildPattern(g, palette, { maxColors: 16 });
    expect([...pattern.cells]).toEqual([EMPTY, EMPTY, EMPTY, EMPTY]);
  });

  it("用色档位为 16 时实际用色不超过总色卡数", () => {
    const cells: Array<readonly [number, number, number]> = [];
    for (let i = 0; i < 64; i++) cells.push([(i * 4) % 256, (i * 3) % 256, (i * 7) % 256]);
    const g = grid(8, 8, cells);
    const pattern = buildPattern(g, palette, { maxColors: 16 });
    const used = new Set([...pattern.cells].filter((v) => v !== EMPTY));
    expect(used.size).toBeLessThanOrEqual(palette.colors.length);
    expect(used.size).toBeGreaterThanOrEqual(1);

    /**
     * **最终审查 F7 追加**：上面两条是**简报原文**（一字未改），但它们用的是 5 色色卡，
     * 所以 `used.size <= palette.colors.length` 是**构造性恒真**——审查者实测：把
     * `buildPattern` 的档位分支改成永远「不限」，这两条仍然全绿。
     * 下面这条在同一处补上有判别力的性质：换一张 24 色色卡（远多于 16 档），
     * 「限制到 16 档」必须真的把用色压到 ≤ 16；改成「不限」会用到全部 24 → 转红。
     */
    const wide = buildPattern(grid(24, 1, WIDE_RGB), widePalette, { maxColors: 16 });
    const wideUsed = new Set([...wide.cells].filter((v) => v !== EMPTY));
    expect(wideUsed.size).toBeLessThanOrEqual(16);
    expect(wideUsed.size).toBeGreaterThan(0);
  });

  it("不限档位时每个格子仍然映射到某个色号", () => {
    const g = grid(3, 1, [
      [250, 0, 0],
      [0, 250, 0],
      [0, 0, 250],
    ]);
    const pattern = buildPattern(g, palette, { maxColors: null });
    expect(codeAt(pattern, codes, 0)).toBe("A3");
    expect(codeAt(pattern, codes, 1)).toBe("A4");
    expect(codeAt(pattern, codes, 2)).toBe("A5");
  });

  it("结果确定：同样输入两次调用得到同样图纸", () => {
    const cells: Array<readonly [number, number, number]> = [];
    for (let i = 0; i < 36; i++) cells.push([(i * 9) % 256, (i * 5) % 256, (i * 13) % 256]);
    const g = grid(6, 6, cells);
    expect([...buildPattern(g, palette, { maxColors: 16 }).cells]).toEqual([
      ...buildPattern(g, palette, { maxColors: 16 }).cells,
    ]);
  });
});

/** 每通道取 0 / 128 / 255 的 3×3×3 组合里的前 24 个：彼此远离，最近色不会被别的色号抢走。 */
const WIDE_RGB: ReadonlyArray<readonly [number, number, number]> = [0, 128, 255].flatMap((r) =>
  [0, 128, 255].flatMap((g) => [0, 128, 255].map((b) => [r, g, b] as const)),
).slice(0, 24);

const hex2 = (value: number): string => `0${value.toString(16)}`.slice(-2);

const widePalette = loadPalette({
  id: "wide",
  name: "24 色测试色卡",
  source: "https://example.com",
  accuracy: "仅测试用",
  colors: WIDE_RGB.map(([r, g, b], i) => ({ code: `C${i}`, hex: `#${hex2(r)}${hex2(g)}${hex2(b)}` })),
});

describe("buildPattern（追加：maxColors=null 必须真的跳过聚类）", () => {
  const usedOf = (pattern: Pattern): Set<number> =>
    new Set([...pattern.cells].filter((value) => value !== EMPTY));

  it("不限档位时 24 个色号全部保留，逐格精确命中自己的色号", () => {
    const g = grid(24, 1, WIDE_RGB);

    // 「不限」的正确语义是跳过 medianCut、在全色卡里取最近色。
    // 若把 null 当成 16 档位走聚类，这条会红：用色被压到 ≤16。
    const unlimited = buildPattern(g, widePalette, { maxColors: null });
    expect([...unlimited.cells]).toEqual(WIDE_RGB.map((_, i) => i));
    expect(usedOf(unlimited).size).toBe(24);

    // 同一份输入走 16 档位：档位是上限，聚类后实际用色不可能超过 16
    const limited = buildPattern(g, widePalette, { maxColors: 16 });
    expect(usedOf(limited).size).toBeLessThanOrEqual(16);
    expect(usedOf(limited).size).toBeGreaterThan(0);
    expect(usedOf(limited).size).toBeLessThan(usedOf(unlimited).size);
  });

  it("32 档位同样把 24 个色号原样保留（桶数少于档位时不切割）", () => {
    const g = grid(24, 1, WIDE_RGB);
    const pattern = buildPattern(g, widePalette, { maxColors: 32 });
    expect([...pattern.cells]).toEqual(WIDE_RGB.map((_, i) => i));
  });

  it("emoji 之外的边界：单格网格与 1×N 网格都能建出正确尺寸", () => {
    const single = buildPattern(grid(1, 1, [[255, 0, 0]]), palette, { maxColors: 16 });
    expect(single.width).toBe(1);
    expect(single.height).toBe(1);
    expect(single.cells[0]).toBe(2);

    const column = buildPattern(
      grid(1, 3, [
        [255, 0, 0],
        [0, 255, 0],
        [0, 0, 255],
      ]),
      palette,
      { maxColors: 16 },
    );
    // 行优先：1 宽 3 高 → 下标 0/1/2 就是上/中/下
    expect([...column.cells]).toEqual([2, 3, 4]);
  });
});

/**
 * ΔE76 与 CIEDE2000 给出**相反**结论的一对颜色（数字与推导见任务 7 的 nearest.test.ts：
 * 目标 (0,34,34) 到青 ΔE76 88.46 < 到紫 137.03，而 CIEDE2000 到青 81.39 > 到紫 34.58）。
 */
const metricPalette = loadPalette({
  id: "metric",
  name: "度量判别色卡",
  source: "https://example.com",
  accuracy: "仅测试用",
  colors: [
    { code: "M1", hex: "#00ffff" },
    { code: "M2", hex: "#5500ff" },
  ],
});

describe("buildPattern（追加：逐格阶段必须用 ΔE76，不是 CIEDE2000）", () => {
  it("两种度量结论相反时，逐格取色按 ΔE76 走", () => {
    // maxColors=null → 两个色号都是候选。ΔE76 取青（色卡下标 0）；
    // 若把 build.ts 里的度量换成 cie2000，会取紫（下标 1）→ 断言转红。
    const g = grid(1, 1, [[0, 34, 34]]);
    expect([...buildPattern(g, metricPalette, { maxColors: null }).cells]).toEqual([0]);
  });
});

/**
 * —— 最终审查 F2 追加 ——
 * `maxColors` 是规格 §4.4 里**要落盘并回读**的 `params.maxColors`，属外部输入；类型
 * `16 | 32 | null` 只挡得住 TS 调用方，挡不住 `JSON.parse` + 强转。修复前实测：
 * `NaN` → `medianCut` 的 `while (boxes.length < NaN)` 一次都不进入，全部桶当一个盒子 →
 * **静默产出「整图仅 1 色」的图纸**；`0` / `-1` → 走 `maxColors <= 0` 早退 → 静默等价
 * 「不限」，与 `16 | 32` 的档位语义冲突；`16.5` → 可切出 17 个簇，超出档位；
 * `Infinity` → 每桶各自成簇（计划「任务 8 使用 medianCut 时的注意事项」里 7k → 7.2M
 * 的 CIEDE2000 悬崖），此前没有任何运行时防线。
 */
describe("buildPattern（追加：用色档位入口校验）", () => {
  it("非 16 / 32 / null 的档位一律抛错，而不是静默产出单色图纸或静默「不限」", () => {
    const g = grid(2, 1, [
      [250, 0, 0],
      [0, 0, 250],
    ]);
    const bads: number[] = [Number.NaN, 0, -1, 16.5, Number.POSITIVE_INFINITY, 8];
    for (const bad of bads) {
      expect(() => buildPattern(g, palette, { maxColors: bad as MaxColors })).toThrow(/用色档位非法/);
    }
  });

  it("三个合法档位照常通过（16 / 32 / null 各自的语义不变）", () => {
    const g = grid(3, 1, [
      [250, 0, 0],
      [0, 250, 0],
      [0, 0, 250],
    ]);
    expect([...buildPattern(g, palette, { maxColors: 16 }).cells]).toEqual([2, 3, 4]);
    expect([...buildPattern(g, palette, { maxColors: 32 }).cells]).toEqual([2, 3, 4]);
    expect([...buildPattern(g, palette, { maxColors: null }).cells]).toEqual([2, 3, 4]);
  });
});

describe("buildPatternFromImage", () => {
  it("按原分辨率逐像素转成图纸（源宽 == 目标宽时是 1:1 精确复制）", () => {
    // 2×1 位图：左红、右全透明。透明格按 FILL_COVERAGE_THRESHOLD 判为空格。
    const data = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 0]);
    const image: RgbaImage = { width: 2, height: 1, data };
    const pattern = buildPatternFromImage(image, palette, { maxColors: 16 });
    expect(pattern.width).toBe(2);
    expect(pattern.height).toBe(1);
    expect(pattern.paletteId).toBe("fake");
    expect(codeAt(pattern, codes, 0)).toBe("A3");
    expect(pattern.cells[1]).toBe(EMPTY);
  });

  it("alpha 覆盖率不足的格子判为空格，而不是当成黑色实心格", () => {
    // 1×2 位图：上格不透明黑、下格 α=26/255≈0.102（低于 0.25 的覆盖率阈值）。
    // 若实现忽略 alpha 的覆盖率语义，下格会变成黑色实心格 → A2，断言转红。
    const data = new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 26]);
    const image: RgbaImage = { width: 1, height: 2, data };
    const pattern = buildPatternFromImage(image, palette, { maxColors: 16 });
    expect([...pattern.cells]).toEqual([1, EMPTY]);
  });
});
