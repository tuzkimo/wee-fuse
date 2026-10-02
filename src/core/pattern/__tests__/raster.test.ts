import { describe, expect, it } from "vitest";
import { loadPalette } from "../../palette/registry";
import { patternToRgbaImage } from "../raster";
import { EMPTY } from "../types";

const palette = loadPalette({
  id: "fake",
  name: "测试色卡",
  source: "https://example.com",
  accuracy: "仅测试用",
  colors: [
    { code: "A1", hex: "#ffffff" },
    { code: "A2", hex: "#000000" },
    { code: "A3", hex: "#ff0000" },
  ],
});

describe("patternToRgbaImage", () => {
  it("每个色号映射成对应 RGB，alpha 为 255", () => {
    const image = patternToRgbaImage(
      { width: 2, height: 1, paletteId: "fake", cells: Uint16Array.from([0, 2]) },
      palette,
    );
    expect(image.width).toBe(2);
    expect(image.height).toBe(1);
    // 只读 R 通道会漏掉「绿蓝写错」，故三通道都断言
    expect([...image.data.slice(0, 4)]).toEqual([255, 255, 255, 255]);
    expect([...image.data.slice(4, 8)]).toEqual([255, 0, 0, 255]);
  });

  it("空格映射成完全透明，且 RGB 清零（不是黑色不透明）", () => {
    const image = patternToRgbaImage(
      { width: 1, height: 1, paletteId: "fake", cells: Uint16Array.from([EMPTY]) },
      palette,
    );
    expect([...image.data]).toEqual([0, 0, 0, 0]);
  });

  it("paletteId 不符时抛错", () => {
    expect(() =>
      patternToRgbaImage(
        { width: 1, height: 1, paletteId: "other", cells: Uint16Array.from([0]) },
        palette,
      ),
    ).toThrow(/色卡/);
  });

  it("色号下标越界时抛错，不静默取 0 号色", () => {
    expect(() =>
      patternToRgbaImage(
        { width: 1, height: 1, paletteId: "fake", cells: Uint16Array.from([9]) },
        palette,
      ),
    ).toThrow(/越界/);
  });

  it("宽高不是 ≥1 的整数时抛错（小数宽高会被 cells 长度校验放过）", () => {
    // 2.5 × 2 = 5，与 5 格 cells「自洽」——不加这条守卫就会静默返回 width: 2.5 的畸形位图
    expect(() =>
      patternToRgbaImage(
        { width: 2.5, height: 2, paletteId: "fake", cells: new Uint16Array(5) },
        palette,
      ),
    ).toThrow(/图纸宽度非法/);
    // 0×0 与 0 长度的 cells 也「自洽」（本函数不接受空图纸；patternStats 才是那个例外）
    expect(() =>
      patternToRgbaImage(
        { width: 0, height: 1, paletteId: "fake", cells: new Uint16Array(0) },
        palette,
      ),
    ).toThrow(/图纸宽度非法/);
    // NaN 若只靠长度校验兜底，报错文案会变成「1×NaN 不自洽」而不是指出高度非法
    expect(() =>
      patternToRgbaImage(
        { width: 1, height: Number.NaN, paletteId: "fake", cells: new Uint16Array(1) },
        palette,
      ),
    ).toThrow(/图纸高度非法/);
  });

  it("cells 长度与宽高不符时抛错", () => {
    expect(() =>
      patternToRgbaImage(
        { width: 2, height: 2, paletteId: "fake", cells: Uint16Array.from([0]) },
        palette,
      ),
    ).toThrow(/长度/);
  });
});
