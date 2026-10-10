import { describe, expect, it } from "vitest";
import { loadPalette } from "../../palette/registry";
import { EMPTY, type MaxColors, type Pattern } from "../../pattern/types";
import { fromProjectDocument, toProjectDocument } from "../file";
import { validateProjectDocument, type ProjectParams } from "../types";

/**
 * 测试色卡：**221 色**（与内置 MARD 同数），前五色是 A1–A5（下标 0–4，既有断言依赖这组下标）。
 *
 * **为什么不是 5 色**：2026-10-10 起 `maxColors` 的口径是「1..色卡色数 的整数」，上界**就是
 * 色卡色数**。夹具只有 5 色时，本文件既有的 `maxColors: 16` / `24`（以及新加的 220 / 221
 * 边界值）会当场变成非法值——那等于用夹具的尺寸去测规格。其余 216 个只是占位色号。
 */
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
    ...Array.from({ length: 216 }, (_, i) => ({
      code: `X${i}`,
      hex: `#${(1 + i).toString(16).padStart(2, "0")}0000`,
    })),
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

  it("同一组颜色、首次出现顺序相反时，codes 逐位相同（子集顺序不由涂画顺序决定）", () => {
    // 「涂画顺序」只影响 cells 里各色**首次出现**的先后。p1 先遇到 A5(4)、p2 先遇到 A3(2)，
    // 两者用的颜色集合相同。若实现拿 Set 的首现顺序当子集顺序（丢掉升序 sort），两条 codes
    // 会互为反序——这正是「子集恒为升序」要挡住的。
    //
    // 注意这里能断言「逐位相同」的只有 codes，**不能是整个 doc 的 JSON**：两张图排布不同，
    // grid 是 cells 在子集里的像（给定 codes 是单射），所以 grid 必然不同。要求两张不同的图
    // 落盘字节相同在数学上不可能，除非它们本来就是同一张图（那样断言就退化成 f(x) === f(x)）。
    const p1: Pattern = {
      width: 3,
      height: 1,
      paletteId: "fake",
      cells: Uint16Array.from([4, EMPTY, 2]),
    };
    const p2: Pattern = {
      width: 3,
      height: 1,
      paletteId: "fake",
      cells: Uint16Array.from([2, EMPTY, 4]),
    };
    const d1 = toProjectDocument(p1, palette, params);
    const d2 = toProjectDocument(p2, palette, params);
    expect(JSON.stringify(d1.palette.codes)).toBe(JSON.stringify(d2.palette.codes));
    expect(d1.palette.codes).toEqual(["A3", "A5"]);
    expect(d2.palette.codes).toEqual(["A3", "A5"]);
    // 两张图各自的 grid 按子集下标对位，且各自忠实往返。
    expect(d1.grid).toEqual([1, EMPTY, 0]);
    expect(d2.grid).toEqual([0, EMPTY, 1]);
    expect([...roundTrip(p1).cells]).toEqual([...p1.cells]);
    expect([...roundTrip(p2).cells]).toEqual([...p2.cells]);
  });

  it("高下标先出现时，codes 仍按升序、grid 的下标随之对位", () => {
    // 全套夹具里出现过 ≥2 个色的图，首现顺序恰好都是升序（2 先于 4），所以「升序」这条
    // 规格要求此前没有任何判别力：把 `sort((a,b) => a-b)` 删掉、改用 Set 的首现顺序，
    // 所有用例照样全绿。这条夹具让 A5(4) 先于 A3(2) 出现。
    const p: Pattern = {
      width: 3,
      height: 1,
      paletteId: "fake",
      cells: Uint16Array.from([4, EMPTY, 2]),
    };
    const doc = toProjectDocument(p, palette, params);
    expect(doc.palette.codes).toEqual(["A3", "A5"]); // 升序，不是首现顺序
    expect(doc.grid).toEqual([1, EMPTY, 0]); // A5 落到子集下标 1
    expect([...roundTrip(p).cells]).toEqual([...p.cells]);
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
    // 探针取 999：夹具色卡改成 221 色之后，原来那个 99 已经落在合法下标范围里
    // （值本身没变，是夹具变大了），换一个仍然越界的值才继续钉住这条守卫。
    const bad: Pattern = {
      width: 1,
      height: 1,
      paletteId: "fake",
      cells: Uint16Array.from([999]),
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

  it("非法参数抛错（长边越界 / 用色数非法 / 旋转非法）", () => {
    const p = pattern3x3();
    expect(() => toProjectDocument(p, palette, { ...params, longSide: 117 })).toThrow(/长边/);
    /*
     * **2026-10-10 口径简化**：用色数从 5 值枚举改成「1..色卡色数 的整数」。旧断言里
     * `32` 与 `null` 是「旧枚举值 ⇒ 非法」，现在 `32` **是合法数字**（32 种色）——
     * 所以它从这条 bad 列表里移出，移到下面「合法数字原样落盘」的断言里；
     * `"16"` / `"custom"` / `"all"` / `null` 仍是非法值（字符串与 null 都不再是任何档位的表示）。
     */
    for (const bad of [0, -1, 1.5, Number.NaN, 222, "16", "custom", "all", null]) {
      expect(() =>
        toProjectDocument(p, palette, { ...params, maxColors: bad as unknown as MaxColors }),
      ).toThrow(/档位/);
    }
    for (const good of [1, 8, 16, 24, 32, 220, 221]) {
      const doc = toProjectDocument(p, palette, { ...params, maxColors: good });
      expect(doc.params.maxColors).toBe(good);
    }
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
    // 只比对 a 与 b 还不够：若实现把子集顺序**整体翻了个面**（codes 与 grid 一致地换序），
    // a 与 b 会「一致地错」——两者相等但这张图的色号全错。实测：子集降序变异下这一条仍然绿。
    // 所以必须再钉住它们等于原始图纸，否则这条用例只能判别「按下标直接搬」，判别不了顺序翻转。
    expect([...a.cells]).toEqual([...p.cells]);
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
    // longSide 刻意取 8：既不等于宽 3 也不等于高 2，写死或与尺寸互换都读得出来。
    // 顺带钉住 `maxColors` / `longSide` 这两个**此前没有任何断言读过**的回读字段。
    const asymmetric: ProjectParams = {
      longSide: 8,
      maxColors: 24,
      crop: { x: 3, y: 5, w: 12, h: 7, rotate: 2 },
    };
    const doc = toProjectDocument(p, palette, asymmetric);
    expect(doc.width).toBe(3);
    expect(doc.height).toBe(2);
    expect(doc.params.longSide).toBe(8);
    expect(doc.params.maxColors).toBe(24);
    const reparsed: unknown = JSON.parse(JSON.stringify(doc));
    const back = fromProjectDocument(reparsed, palette);
    expect(back.pattern.width).toBe(3);
    expect(back.pattern.height).toBe(2);
    expect(back.params.longSide).toBe(8);
    expect(back.params.maxColors).toBe(24);
    expect(back.params.crop).toEqual({ x: 3, y: 5, width: 12, height: 7 });
    expect(back.params.rotation).toBe(2);
    expect([...back.pattern.cells]).toEqual([...p.cells]);
  });

  it("R9：crop.x = -8.5（非整数负值）原样保留，不被取整或夹取静默收敛", () => {
    // R9 口径二选一：抛明确错误，或原样保留负值。这里选**原样保留**，理由：
    // 负原点在 §5.4 口径下是合法输入（x/y 只要求有限），而「裁剪框是否越出原图」的判定
    // 需要原图尺寸，`file.ts` 拿不到，也不该在这里替 pipeline 猜。file.ts 的职责只是字段搬位，
    // 一旦它在映射途中做夹取或取整，越界 / 带小数的裁剪就会变成「合法但错误」的网格。
    //
    // 取值刻意用**非整数**的 -8.5：-8 是 Math.round / Math.floor / Math.trunc 的不动点，
    // 只有 Math.max(0, x) 这类夹取会被它抓到；-8.5 才能同时钉住「取整」与「夹取」两种收敛。
    const doc = toProjectDocument(pattern3x3(), palette, {
      ...params,
      crop: { ...params.crop, x: -8.5 },
    });
    // 落盘方向也不得悄悄把它改成 0。
    expect(doc.params.crop.x).toBe(-8.5);
    const reparsed: unknown = JSON.parse(JSON.stringify(doc));
    const loaded = fromProjectDocument(reparsed, palette).params.crop;
    expect(loaded.x).toBe(-8.5);
    expect(loaded).toEqual({ x: -8.5, y: 0, width: 12, height: 12 });
  });

  /**
   * 用色数的上下界都要**逐位往返**：上界 = 色卡色数（= 「不限」，跳过分簇）。
   * 此前只断言过 16 与 32：`checked.params.maxColors ?? 16` 这类静默回落会全绿。
   * 旧的「不限」表示是字符串 `"all"`，2026-10-10 的口径简化后就是**这个数字本身**。
   */
  it("用色数 = 色卡色数（221，即「不限」）往返后仍是 221，不静默回落成 16", () => {
    const p = pattern3x3();
    const doc = toProjectDocument(p, palette, { ...params, maxColors: 221 });
    expect(doc.params.maxColors).toBe(221);
    const reparsed: unknown = JSON.parse(JSON.stringify(doc));
    const back = fromProjectDocument(reparsed, palette);
    expect(back.params.maxColors).toBe(221);
    expect([...back.pattern.cells]).toEqual([...p.cells]);
  });

  it("旧记录（'custom' / 'all' / null）读盘响亮失败，不做映射", () => {
    // 人类伙伴裁定 A1：旧记录不兼容，一律按「用色档位非法」响亮失败（清库测试的先例）。
    const p = pattern3x3();
    const base = toProjectDocument(p, palette, params);
    for (const legacy of ["custom", "all", null]) {
      expect(() =>
        fromProjectDocument(
          { ...base, params: { ...base.params, maxColors: legacy } },
          palette,
        ),
      ).toThrow(/用色档位非法/);
    }
  });

  it("写出物里不再有 customMaxColors 字段（口径简化后只有一个数字）", () => {
    const doc = toProjectDocument(pattern3x3(), palette, params);
    expect(doc.params).not.toHaveProperty("customMaxColors");
    expect(Object.keys(doc.params).sort()).toEqual(["crop", "longSide", "maxColors"]);
    // 回读方向也只有一个数字：返回的 params 里不存在第二个用色字段。
    const back = fromProjectDocument(JSON.parse(JSON.stringify(doc)), palette);
    expect(back.params).not.toHaveProperty("customMaxColors");
  });

  it("用到全色卡下标 0（A1）时往返仍忠实，不被 falsy 判断当成空格跳过", () => {
    // 全集只出现过 2/3/4，从未出现过下标 0。把复制循环写成 `if (!value) continue` 时，
    // 0 会被跳过 → grid 落进 undefined（JSON 后是 null），要到载入才响亮失败。
    const p: Pattern = {
      width: 2,
      height: 2,
      paletteId: "fake",
      cells: Uint16Array.from([0, EMPTY, 4, 0]),
    };
    const doc = toProjectDocument(p, palette, params);
    expect(doc.palette.codes).toEqual(["A1", "A5"]);
    expect(doc.grid).toEqual([0, EMPTY, 1, 0]);
    const back = roundTrip(p);
    expect([...back.cells]).toEqual([...p.cells]);
  });
});
