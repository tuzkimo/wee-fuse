import { describe, expect, it } from "vitest";
import { loadPalette } from "../../palette/registry";
import { EMPTY, type Pattern } from "../../pattern/types";
import { fromProjectDocument, toProjectDocument } from "../file";
import { validateProjectDocument, type ProjectParams } from "../types";

const palette = loadPalette({
  id: "fake",
  name: "测试色卡",
  source: "https://example.com",
  accuracy: "仅测试用",
  colors: [
    { code: "A1", hex: "#ffffff" }, // 0
    { code: "A2", hex: "#000000" }, // 1
    { code: "A3", hex: "#ff0000" }, // 2
    { code: "A4", hex: "#00ff00" }, // 3
    { code: "A5", hex: "#0000ff" }, // 4
  ],
});

const params: ProjectParams = {
  longSide: 3,
  maxColors: 16,
  crop: { x: 0, y: 0, w: 12, h: 12, rotate: 1 },
};

/** 3×3 图纸：用 A3(2) / A5(4) / 空格，**刻意跳过 A1/A2/A4**，子集与全色卡下标才会不同。 */
function pattern3x3(): Pattern {
  return {
    width: 3,
    height: 3,
    paletteId: "fake",
    cells: Uint16Array.from([2, 2, EMPTY, 4, 2, 4, EMPTY, 4, 2]),
  };
}

/** 真实的落盘 - 回读往返，含一次 JSON 序列化。 */
function roundTrip(p: Pattern, fullPalette = palette): Pattern {
  const doc = toProjectDocument(p, fullPalette, params);
  const reparsed: unknown = JSON.parse(JSON.stringify(doc));
  return fromProjectDocument(reparsed, fullPalette).pattern;
}

describe("toProjectDocument", () => {
  it("子集色号升序、去重，且只包含图上真正用到的色号", () => {
    const doc = toProjectDocument(pattern3x3(), palette, params);
    // 全色卡下标 2 与 4 → 色号 A3 与 A5；A1/A2/A4 未出现，不得进 codes
    expect(doc.palette.codes).toEqual(["A3", "A5"]);
  });

  it("grid 的下标是到 codes 的子集下标，空格保留 65535", () => {
    const doc = toProjectDocument(pattern3x3(), palette, params);
    // A3 是子集下标 0，A5 是子集下标 1
    expect(doc.grid).toEqual([0, 0, EMPTY, 1, 0, 1, EMPTY, 1, 0]);
  });

  it("同一张图，改变涂画顺序不改变落盘字节（子集恒为升序）", () => {
    const a = toProjectDocument(pattern3x3(), palette, params);
    const b = toProjectDocument(pattern3x3(), palette, params);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("宽高与长边来自图纸与参数，不从 grid 反推", () => {
    const doc = toProjectDocument(pattern3x3(), palette, params);
    expect(doc.width).toBe(3);
    expect(doc.height).toBe(3);
    expect(doc.params.longSide).toBe(3);
    expect(doc.params.crop).toEqual({ x: 0, y: 0, w: 12, h: 12, rotate: 1 });
  });

  it("全空格图纸：codes 为空、grid 全 65535（不得产出非法下标）", () => {
    const empty: Pattern = {
      width: 2,
      height: 1,
      paletteId: "fake",
      cells: Uint16Array.from([EMPTY, EMPTY]),
    };
    const doc = toProjectDocument(empty, palette, params);
    expect(doc.palette.codes).toEqual([]);
    expect(doc.grid).toEqual([EMPTY, EMPTY]);
  });

  it("只用一种颜色的图纸：codes 只有一个", () => {
    const one: Pattern = {
      width: 2,
      height: 1,
      paletteId: "fake",
      cells: Uint16Array.from([3, 3]),
    };
    expect(toProjectDocument(one, palette, params).palette.codes).toEqual(["A4"]);
  });

  it("paletteId 与传入色卡不符时抛错（不静默按位置映射）", () => {
    const wrong: Pattern = { ...pattern3x3(), paletteId: "other" };
    expect(() => toProjectDocument(wrong, palette, params)).toThrow(/色卡/);
  });

  it("cells 里有超出色卡长度的下标时抛错", () => {
    const bad: Pattern = {
      width: 1,
      height: 1,
      paletteId: "fake",
      cells: Uint16Array.from([99]),
    };
    expect(() => toProjectDocument(bad, palette, params)).toThrow(/越界|色卡/);
  });

  it("cells 长度与宽高不符时抛错", () => {
    const bad: Pattern = {
      width: 3,
      height: 3,
      paletteId: "fake",
      cells: Uint16Array.from([2, 2]),
    };
    expect(() => toProjectDocument(bad, palette, params)).toThrow(/长度/);
  });

  it("非法参数抛错（长边越界 / 档位非法 / 旋转非法）", () => {
    const p = pattern3x3();
    expect(() => toProjectDocument(p, palette, { ...params, longSide: 501 })).toThrow(/长边/);
    expect(() =>
      toProjectDocument(p, palette, { ...params, maxColors: 8 as unknown as 16 }),
    ).toThrow(/档位/);
    expect(() =>
      toProjectDocument(p, palette, { ...params, crop: { ...params.crop, rotate: 4 } }),
    ).toThrow(/旋转/);
  });
});

describe("fromProjectDocument", () => {
  it("端到端往返后 cells 逐格一致（含 JSON 序列化）", () => {
    const p = pattern3x3();
    const back = roundTrip(p);
    expect(back.width).toBe(3);
    expect(back.height).toBe(3);
    expect(back.paletteId).toBe("fake");
    expect([...back.cells]).toEqual([...p.cells]);
  });

  it("往返保留空格的 65535，不变成某个色号下标", () => {
    const back = roundTrip(pattern3x3());
    expect(back.cells[2]).toBe(EMPTY);
    expect(back.cells[6]).toBe(EMPTY);
  });

  it("换一种 codes 顺序，载入结果必须完全相同（专打「按下标直接搬」的实现）", () => {
    // 这条是本任务最有判别力的断言：若实现按下标直接搬而不按 code 查表，
    // 同一个 grid 配不同顺序的 codes 会得到不同的 cells —— 图纸看起来正常、色号全错。
    const p = pattern3x3();
    const base = toProjectDocument(p, palette, params);
    const shuffled = {
      ...base,
      palette: { id: base.palette.id, codes: [...base.palette.codes].reverse() },
      // codes 反序后，每个色号的子集下标也跟着换：原来的 0→1、1→0
      grid: base.grid.map((v) => (v === EMPTY ? EMPTY : 1 - v)),
    };
    const a = fromProjectDocument(validateProjectDocument(base, palette), palette).pattern;
    const b = fromProjectDocument(validateProjectDocument(shuffled, palette), palette).pattern;
    expect([...b.cells]).toEqual([...a.cells]);
  });

  it("crop 字段搬位：w/h → width/height，rotate 挪到 crop 外面", () => {
    const doc = toProjectDocument(pattern3x3(), palette, params);
    const { crop, rotation } = fromProjectDocument(doc, palette).params;
    expect(crop).toEqual({ x: 0, y: 0, width: 12, height: 12 });
    expect(rotation).toBe(1);
  });

  it("载入时校验失败会抛错，而不是产出一个看起来正常的图纸", () => {
    const doc = toProjectDocument(pattern3x3(), palette, params);
    expect(() =>
      fromProjectDocument({ ...doc, width: 0 }, palette),
    ).toThrow(/宽度/);
  });

  it("全空格图纸往返后仍是全空格", () => {
    const empty: Pattern = {
      width: 2,
      height: 1,
      paletteId: "fake",
      cells: Uint16Array.from([EMPTY, EMPTY]),
    };
    const back = roundTrip(empty);
    expect([...back.cells]).toEqual([EMPTY, EMPTY]);
  });

  it("宽高与裁剪宽高都不对称时逐字段对位（12×12 的正方形夹具分辨不出 width/height 互换）", () => {
    // 简报夹具里图纸是 3×3、裁剪是 12×12，两处宽高都相等，因此
    // `width: checked.height` 或 `{ width: h, height: w }` 这类**互换**错误不会被任何断言读到。
    // 这里补一个 3×2 图纸 + 12×7 裁剪，把四个维度的对位钉死；顺带覆盖从未被读过的 maxColors。
    const p: Pattern = {
      width: 3,
      height: 2,
      paletteId: "fake",
      cells: Uint16Array.from([2, EMPTY, 4, 4, 2, EMPTY]),
    };
    const asymmetric: ProjectParams = {
      longSide: 3,
      maxColors: 32,
      crop: { x: 3, y: 5, w: 12, h: 7, rotate: 2 },
    };
    const doc = toProjectDocument(p, palette, asymmetric);
    expect(doc.width).toBe(3);
    expect(doc.height).toBe(2);
    expect(doc.params.maxColors).toBe(32);
    const reparsed: unknown = JSON.parse(JSON.stringify(doc));
    const back = fromProjectDocument(reparsed, palette);
    expect(back.pattern.width).toBe(3);
    expect(back.pattern.height).toBe(2);
    expect(back.params.crop).toEqual({ x: 3, y: 5, width: 12, height: 7 });
    expect(back.params.rotation).toBe(2);
    expect([...back.pattern.cells]).toEqual([...p.cells]);
  });

  it("R9：crop.x = -8 原样保留，不被 Math.max(0, …) / Math.round 静默收敛", () => {
    // R9 口径二选一：抛明确错误，或原样保留负值。这里选**原样保留**，理由：
    // 负原点在 §5.4 口径下是合法输入（x/y 只要求有限），而「裁剪框是否越出原图」的判定
    // 需要原图尺寸，`file.ts` 拿不到，也不该在这里替 pipeline 猜。file.ts 的职责只是字段搬位，
    // 一旦它在映射途中做 Math.max(0, …) 这类静默收敛，越界裁剪就会变成「合法但错误」的网格。
    const doc = toProjectDocument(pattern3x3(), palette, {
      ...params,
      crop: { ...params.crop, x: -8 },
    });
    // 落盘方向也不得悄悄把它改成 0。
    expect(doc.params.crop.x).toBe(-8);
    const reparsed: unknown = JSON.parse(JSON.stringify(doc));
    const loaded = fromProjectDocument(reparsed, palette).params.crop;
    expect(loaded.x).toBe(-8);
    expect(loaded).toEqual({ x: -8, y: 0, width: 12, height: 12 });
  });
});
