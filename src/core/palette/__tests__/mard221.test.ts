import { describe, expect, it } from "vitest";
import raw from "../builtin/mard221.json";
import { createPaletteRuntime, loadPalette } from "../registry";

/** 九个色系各自的色号数量，与抓取时实测一致。 */
const SERIES_SIZES: Record<string, number> = {
  A: 26,
  B: 32,
  C: 29,
  D: 26,
  E: 24,
  F: 25,
  G: 21,
  H: 23,
  M: 15,
};

describe("MARD 221 内置色卡", () => {
  const palette = loadPalette(raw);
  const runtime = createPaletteRuntime(palette);

  it("色号数量为 221", () => {
    expect(palette.colors).toHaveLength(221);
  });

  it("色号与期望全集完全相等（缺号与多余色号都算失败）", () => {
    const expected = new Set<string>();
    for (const [series, size] of Object.entries(SERIES_SIZES)) {
      for (let i = 1; i <= size; i += 1) expected.add(`${series}${i}`);
    }
    expect(expected.size).toBe(221);

    const actual = new Set(palette.colors.map((c) => c.code));
    const missing = [...expected].filter((code) => !actual.has(code));
    const extra = [...actual].filter((code) => !expected.has(code));
    expect(missing, `缺少色号：${missing.join(" ")}`).toEqual([]);
    expect(extra, `多余色号：${extra.join(" ")}`).toEqual([]);
  });

  it("原始 JSON 里每个色号的 hex 都是 6 位十六进制", () => {
    for (const c of raw.colors) {
      expect(c.hex, `色号 ${c.code} 的 hex 非法`).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("色号与抓取时人工核对的锚点一致", () => {
    const expectHex: Record<string, string> = {
      A1: "#faf5cd",
      B3: "#a1f586",
      F2: "#f63d4b",
      H1: "#ffffff",
      M1: "#bbc6b6",
    };
    for (const [code, hex] of Object.entries(expectHex)) {
      const index = runtime.indexByCode.get(code);
      expect(index, `缺少色号 ${code}`).toBeDefined();
      const c = palette.colors[index as number];
      const actual = `#${c.rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
      expect(actual, `色号 ${code} 色值不符`).toBe(hex);
    }
  });

  it("九大色系都存在", () => {
    const series = new Set(palette.colors.map((c) => c.code[0]));
    for (const s of ["A", "B", "C", "D", "E", "F", "G", "H", "M"]) {
      expect(series.has(s), `缺少 ${s} 色系`).toBe(true);
    }
  });

  it("声明了数据来源与精度说明", () => {
    expect(palette.source).toMatch(/^https:\/\//);
    expect(palette.accuracy).toMatch(/第三方/);
    expect(palette.accuracy).toMatch(/实物/);
    expect(palette.accuracy).toMatch(/不同公开来源/);
  });
});
