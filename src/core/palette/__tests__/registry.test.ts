import { describe, expect, it } from "vitest";
import { EMPTY } from "../../pattern/types";
import { createPaletteRuntime, loadPalette, parseHex } from "../registry";

const valid = {
  id: "test",
  name: "测试色卡",
  source: "https://example.com",
  accuracy: "仅测试用",
  colors: [
    { code: "A1", name: "白", hex: "#ffffff" },
    { code: "A2", name: "黑", hex: "#000000" },
  ],
};

describe("parseHex", () => {
  it("解析 6 位十六进制", () => {
    expect(parseHex("#faf5cd")).toEqual([250, 245, 205]);
    expect(parseHex("#FFFFFF")).toEqual([255, 255, 255]);
  });

  it("拒绝非法格式", () => {
    expect(() => parseHex("faf5cd")).toThrow(/非法色值/);
    expect(() => parseHex("#fff")).toThrow(/非法色值/);
  });
});

describe("loadPalette", () => {
  it("载入合法色卡", () => {
    const p = loadPalette(valid);
    expect(p.id).toBe("test");
    expect(p.colors).toHaveLength(2);
    expect(p.colors[0]?.rgb).toEqual([255, 255, 255]);
  });

  it("name 缺失时回落为空字符串", () => {
    const p = loadPalette({
      ...valid,
      colors: [{ code: "A1", hex: "#ffffff" }],
    });
    expect(p.colors[0]?.name).toBe("");
  });

  it("name 为 null 时回落，为空串时保持为空串", () => {
    const withNull = loadPalette({
      ...valid,
      colors: [{ code: "A1", name: null, hex: "#ffffff" }],
    });
    expect(withNull.colors[0]?.name).toBe("");
    const withEmpty = loadPalette({
      ...valid,
      colors: [{ code: "A1", name: "", hex: "#ffffff" }],
    });
    expect(withEmpty.colors[0]?.name).toBe("");
  });

  it("name 存在但不是字符串时抛错", () => {
    expect(() => loadPalette({ ...valid, colors: [{ code: "A1", name: 123, hex: "#ffffff" }] })).toThrow(
      /name/,
    );
    expect(() =>
      loadPalette({ ...valid, colors: [{ code: "A1", name: ["白"], hex: "#ffffff" }] }),
    ).toThrow(/name/);
  });

  it("非法 hex 在 loadPalette 层也抛错", () => {
    expect(() => loadPalette({ ...valid, colors: [{ code: "A1", hex: "#zzzzzz" }] })).toThrow(
      /非法色值/,
    );
    expect(() => loadPalette({ ...valid, colors: [{ code: "A1", hex: "#fff" }] })).toThrow(
      /非法色值/,
    );
  });

  it("缺字段时抛错", () => {
    expect(() => loadPalette({ ...valid, source: undefined })).toThrow(/source/);
    expect(() => loadPalette({ ...valid, colors: [] })).toThrow(/没有颜色数据/);
    expect(() => loadPalette(null)).toThrow(/不是对象/);
  });

  it("色号重复时抛错", () => {
    expect(() =>
      loadPalette({
        ...valid,
        colors: [
          { code: "A1", hex: "#ffffff" },
          { code: "A1", hex: "#000000" },
        ],
      }),
    ).toThrow(/色号重复/);
  });

  /**
   * —— 最终审查 F5 追加 ——
   * 图纸的 `cells` 是 `Uint16Array`，色卡下标与空格标记 `EMPTY = 0xffff` 共用值域：
   * 色数达到 65536 时下标 `0xffff` 与空格**无法区分**，`patternStats` 会把该色当空格
   * 静默吞掉（用量表少一个色号、`total` 偏小，图纸本身看起来正常）。内置 MARD221 只有
   * 221 色无碍，但规格 §13 计划支持自定义色卡导入 → 载入处必须有闸门。
   * 边界两侧都测：恰好 `EMPTY` 色合法（下标 0…0xfffe 碰不到 0xffff），再多一色非法。
   */
  it("[追加] 色数超过 EMPTY 时抛错，恰好 EMPTY 色仍合法", () => {
    const make = (count: number) =>
      Array.from({ length: count }, (_, i) => ({ code: `C${i}`, hex: "#ffffff" }));
    expect(() => loadPalette({ ...valid, colors: make(EMPTY + 1) })).toThrow(/超过上限/);
    const atLimit = loadPalette({ ...valid, colors: make(EMPTY) });
    expect(atLimit.colors).toHaveLength(EMPTY);
    expect(atLimit.colors[EMPTY - 1]?.code).toBe(`C${EMPTY - 1}`);
  });
});

describe("createPaletteRuntime", () => {
  it("Lab 表与色号索引按颜色下标对齐", () => {
    const rt = createPaletteRuntime(loadPalette(valid));
    expect(rt.labs).toHaveLength(2);
    expect(rt.labs[0]?.[0]).toBeCloseTo(100, 3);
    expect(rt.labs[1]?.[0]).toBeCloseTo(0, 3);
    expect(rt.indexByCode.get("A2")).toBe(1);
    expect(rt.indexByCode.get("ZZ")).toBeUndefined();
  });
});
