import { describe, expect, it } from "vitest";
import raw from "../builtin/mard221.json";
import { createPaletteRuntime, loadPalette } from "../registry";

describe("MARD 221 内置色卡", () => {
  const palette = loadPalette(raw);
  const runtime = createPaletteRuntime(palette);

  it("色号数量为 221", () => {
    expect(palette.colors).toHaveLength(221);
  });

  it("色号唯一", () => {
    const codes = palette.colors.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("每个色号的 rgb 都在合法范围", () => {
    for (const c of palette.colors) {
      for (const v of c.rgb) {
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(255);
      }
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
    expect(palette.accuracy.length).toBeGreaterThan(10);
  });
});
