import { describe, expect, it } from "vitest";
import { loadPalette } from "../../palette/registry";
import { clustersToPaletteIndices, nearestCellColor, nearestIndexOf } from "../nearest";
import { rgbToLab } from "../../color/space";

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

const labs = palette.colors.map((c) => rgbToLab(c.rgb[0], c.rgb[1], c.rgb[2]));

describe("nearestIndexOf", () => {
  it("找到完全相同的颜色", () => {
    expect(nearestIndexOf(rgbToLab(255, 0, 0), labs, "cie2000")).toBe(2);
    expect(nearestIndexOf(rgbToLab(0, 0, 0), labs, "de76")).toBe(1);
  });

  it("在两种度量下对明显不同的颜色给出一致结果", () => {
    for (const metric of ["de76", "cie2000"] as const) {
      expect(nearestIndexOf(rgbToLab(250, 5, 5), labs, metric)).toBe(2);
      expect(nearestIndexOf(rgbToLab(5, 250, 5), labs, metric)).toBe(3);
    }
  });

  it("空表抛错", () => {
    expect(() => nearestIndexOf(rgbToLab(0, 0, 0), [], "de76")).toThrow(/为空/);
  });
});

describe("clustersToPaletteIndices", () => {
  it("把簇映射成色卡下标并升序去重", () => {
    const indices = clustersToPaletteIndices(
      [
        { rgb: [250, 2, 2], count: 10 },
        { rgb: [252, 4, 4], count: 5 },
        { rgb: [2, 2, 250], count: 8 },
      ],
      palette,
    );
    // 两个红簇落到同一个色号 A3，去重后只剩两个下标，且升序
    expect(indices).toEqual([2, 4]);
  });

  it("忽略空簇", () => {
    const indices = clustersToPaletteIndices([{ rgb: [0, 0, 0], count: 0 }], palette);
    expect(indices).toEqual([1]);
  });

  it("全是空簇时也至少返回一个色号", () => {
    expect(clustersToPaletteIndices([], palette)).toHaveLength(1);
  });
});

describe("nearestCellColor", () => {
  it("在候选下标内选最近色", () => {
    const candidates = [labs[2] as (typeof labs)[number], labs[4] as (typeof labs)[number]];
    expect(nearestCellColor(240, 10, 10, candidates)).toBe(0);
    expect(nearestCellColor(10, 10, 240, candidates)).toBe(1);
  });
});

/**
 * —— 任务 7 补充断言 ——
 * 简报给的 nearest 用例全部落在「唯一最小距离」的情形上，所以：等距时取哪个下标、
 * 逐格映射有没有读 g 通道、两个度量到底谁被用上，改坏了都不会红。下面几条补这些点。
 * 简报的断言一条未改。
 */
describe("[补充] 等距取最小下标", () => {
  it("多个候选同距离时取最小下标（判据是 < 而不是 <=）", () => {
    // 下标 0 与 2 的 Lab 完全相同，目标到两者的距离都是 0（精确相等，无浮点歧义）
    expect(nearestIndexOf([1, 2, 3], [[1, 2, 3], [9, 9, 9], [1, 2, 3]], "de76")).toBe(0);
  });
});

describe("[补充] 度量的实际使用", () => {
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
  const metricLabs = metricPalette.colors.map((c) => rgbToLab(c.rgb[0], c.rgb[1], c.rgb[2]));

  it("ΔE76 与 CIEDE2000 结论相反时，各按自己的度量给答案", () => {
    // 目标 (0,34,34)：ΔE76 到青 88.46 < 到紫 137.03；CIEDE2000 到青 81.39 > 到紫 34.58
    const target = rgbToLab(0, 34, 34);
    expect(nearestIndexOf(target, metricLabs, "de76")).toBe(0);
    expect(nearestIndexOf(target, metricLabs, "cie2000")).toBe(1);
  });

  it("簇 → 色号用 CIEDE2000（不是 ΔE76）", () => {
    expect(clustersToPaletteIndices([{ rgb: [0, 34, 34], count: 1 }], metricPalette)).toEqual([1]);
  });

  it("逐格映射用 ΔE76（不是 CIEDE2000）", () => {
    expect(nearestCellColor(0, 34, 34, metricLabs)).toBe(0);
  });
});

describe("[补充] 逐格映射读到 g 通道", () => {
  it("候选为红 / 绿时，(200,220,10) 归绿", () => {
    // ΔE76：到绿 58.79，到红 112.82。把 g 通道丢掉（当 0 处理）会翻成红。
    const candidates = [labs[2], labs[3]];
    expect(nearestCellColor(200, 220, 10, candidates)).toBe(1);
  });
});

/**
 * —— 第 2 轮修复补充断言 ——
 * 原用例的「忽略空簇」与「升序」都不具判别力：
 * - 空簇那条用的是 `rgb: [0,0,0]`，跳过它走兜底黑得 1、不跳过直接命中黑也得 1，两条路径同值；
 * - 三条升序用例的簇插入顺序恰好就是升序，删掉 `.sort` 也不会红。
 * 下面两条构造能把这两种行为改坏区分出来。上面所有断言一条未改。
 */
describe("[修复] 忽略空簇的判别性", () => {
  it("空簇的颜色不是黑时，被跳过（走兜底黑）而不是被当成有效颜色", () => {
    // 跳过 → picked 为空 → 兜底 nearestIndexOf([0,0,0]) → 黑下标 1
    // 不跳过 → 该簇直接命中红下标 2
    expect(clustersToPaletteIndices([{ rgb: [250, 2, 2], count: 0 }], palette)).toEqual([1]);
  });
});

describe("[修复] 升序契约的判别性", () => {
  it("簇的插入顺序降序时，返回值仍按色卡下标升序", () => {
    // 插入顺序：蓝(4) 在前、红(2) 在后。删掉 `.sort((a, b) => a - b)` 会得到 [4, 2]。
    expect(
      clustersToPaletteIndices(
        [
          { rgb: [2, 2, 250], count: 8 },
          { rgb: [250, 2, 2], count: 10 },
        ],
        palette,
      ),
    ).toEqual([2, 4]);
  });
});
