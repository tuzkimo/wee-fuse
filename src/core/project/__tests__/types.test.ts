import { describe, expect, it } from "vitest";
import { EMPTY } from "../../pattern/types";
import { loadPalette } from "../../palette/registry";
import type { Palette, PaletteColor } from "../../palette/types";
import mardRaw from "../../palette/builtin/mard221.json";
import { validateProjectDocument } from "../types";

/** 造一个长度为 `length` 的真实颜色数组（循环复用 `base` 的颜色值，只改色号）。 */
function makeColors(base: PaletteColor, length: number): readonly PaletteColor[] {
  const colors: PaletteColor[] = [];
  for (let i = 0; i < length; i++) {
    colors.push({ code: `C${i}`, name: "", rgb: base.rgb });
  }
  return colors;
}

/**
 * 测试色卡：**221 色**（与内置 MARD 同数），前五色是 A1–A5（下标 0–4）。
 *
 * **为什么不是 5 色**：2026-10-10 起 `maxColors` 的口径是「1..色卡色数 的整数」，上界**就是
 * 色卡色数**。夹具只有 5 色时，`validDoc()` 里既有的 `maxColors: 16` 会当场变成非法值——
 * 那等于用夹具的尺寸去测规格；而 221 色才让「220 / 221 / 222」这三个边界值测得到。
 * 其余的 216 个只是占位色号（本文件的校验只读 `colors.length` 与色号集合，不读色值）。
 */
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
    ...Array.from({ length: 216 }, (_, i) => ({
      code: `X${i}`,
      hex: `#${(1 + i).toString(16).padStart(2, "0")}0000`,
    })),
  ],
});

/** 内置 MARD221 色卡里的一个真实颜色，供上界测试色卡复用（不是手搓的假颜色对象）。 */
const realBase = loadPalette(mardRaw).colors[0] as PaletteColor;

/** 一份合法文档。各条非法用例都从它派生，保证「只有被测字段不同」。 */
function validDoc(): Record<string, unknown> {
  return {
    format: "weefuse-project",
    version: 1,
    width: 2,
    height: 2,
    palette: { id: "fake", codes: ["A3", "A4"] },
    grid: [0, 1, 0, 1],
    params: { longSide: 2, maxColors: 16, crop: { x: 0, y: 0, w: 8, h: 8, rotate: 0 } },
  };
}

describe("validateProjectDocument", () => {
  it("合法文档原样通过，并保留全部字段", () => {
    const doc = validateProjectDocument(validDoc(), palette);
    expect(doc.width).toBe(2);
    expect(doc.height).toBe(2);
    expect(doc.palette.codes).toEqual(["A3", "A4"]);
    expect(doc.grid).toEqual([0, 1, 0, 1]);
    expect(doc.params.crop).toEqual({ x: 0, y: 0, w: 8, h: 8, rotate: 0 });
    // 本任务钉死的两个常量也要原样落到返回值上，且 params 的另外两个字段不能丢。
    expect(doc.format).toBe("weefuse-project");
    expect(doc.version).toBe(1);
    expect(doc.palette.id).toBe("fake");
    expect(doc.params.longSide).toBe(2);
    expect(doc.params.maxColors).toBe(16);
  });

  it("非对象 / null 直接报错", () => {
    expect(() => validateProjectDocument(null, palette)).toThrow(/不是对象/);
    expect(() => validateProjectDocument("x", palette)).toThrow(/不是对象/);
    expect(() => validateProjectDocument([], palette)).toThrow(/不是对象/);
    // 数组是对象、typeof 也是 "object"，只查 typeof 拦不住它——上面那条 [] 用例就是为此存在的。
    // 补两个同族形态：undefined 与非空数组。
    expect(() => validateProjectDocument(undefined, palette)).toThrow(/不是对象/);
    expect(() => validateProjectDocument([validDoc()], palette)).toThrow(/不是对象/);
  });

  it("format 不符时报「不是 WeeFuse 工程文件」", () => {
    expect(() => validateProjectDocument({ ...validDoc(), format: "other" }, palette)).toThrow(
      /不是 WeeFuse 工程文件/,
    );
    // 空串 / 大小写变体 / 数字都不算合法 format
    expect(() => validateProjectDocument({ ...validDoc(), format: "" }, palette)).toThrow(
      /不是 WeeFuse 工程文件/,
    );
    expect(() => validateProjectDocument({ ...validDoc(), format: 1 }, palette)).toThrow(
      /不是 WeeFuse 工程文件/,
    );
  });

  it("version 不认识时报错并带上版本号", () => {
    expect(() => validateProjectDocument({ ...validDoc(), version: 2 }, palette)).toThrow(
      /版本 2/,
    );
    expect(() => validateProjectDocument({ ...validDoc(), version: "1" }, palette)).toThrow(
      /版本/,
    );
    // 字符串 "1" 与数字 1 必须被区分开：TS 类型挡不住 JSON.parse 之后的强转。
    expect(() => validateProjectDocument({ ...validDoc(), version: 0 }, palette)).toThrow(/版本/);
    expect(() => validateProjectDocument({ ...validDoc(), version: null }, palette)).toThrow(
      /版本/,
    );
  });

  it("width / height 必须是 ≥1 的整数", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "2"]) {
      expect(() => validateProjectDocument({ ...validDoc(), width: bad }, palette)).toThrow(
        /宽度/,
      );
      expect(() => validateProjectDocument({ ...validDoc(), height: bad }, palette)).toThrow(
        /高度/,
      );
    }
    // 上面那 6 个值里 NaN / Infinity / "2" 只能靠「整数 + 有限」拦住（`< 1` 对前两者为假）。
    // 再补上界同族与缺失字段：undefined 缺字段不得被当成合法。
    expect(() => validateProjectDocument({ ...validDoc(), width: undefined }, palette)).toThrow(
      /宽度/,
    );
    expect(() => validateProjectDocument({ ...validDoc(), height: undefined }, palette)).toThrow(
      /高度/,
    );
    expect(() =>
      validateProjectDocument({ ...validDoc(), width: Number.NEGATIVE_INFINITY }, palette),
    ).toThrow(/宽度/);
  });

  it("width / height 不得超过 116（与长边豆数上限同口径，同时挡住宽高相乘溢出成 Infinity）", () => {
    expect(() => validateProjectDocument({ ...validDoc(), width: 117 }, palette)).toThrow(/宽度/);
    expect(() => validateProjectDocument({ ...validDoc(), height: 117 }, palette)).toThrow(/高度/);
    // 边界值本身必须放行（否则「1–116」被实现成了「1–115」也不会有人发现）。
    const atLimit = validateProjectDocument(
      {
        ...validDoc(),
        width: 116,
        height: 116,
        grid: new Array<number>(116 * 116).fill(0),
      },
      palette,
    );
    expect(atLimit.width).toBe(116);
    expect(atLimit.height).toBe(116);
    expect(atLimit.grid.length).toBe(13456);
  });

  it("grid 长度必须等于 width*height", () => {
    expect(() => validateProjectDocument({ ...validDoc(), grid: [0, 1, 0] }, palette)).toThrow(
      /长度/,
    );
    // 多一格同样不自洽（只查「至少」的实现会漏掉这一半）
    expect(() =>
      validateProjectDocument({ ...validDoc(), grid: [0, 1, 0, 1, 0] }, palette),
    ).toThrow(/长度/);
    expect(() => validateProjectDocument({ ...validDoc(), grid: [] }, palette)).toThrow(/长度/);
    expect(() => validateProjectDocument({ ...validDoc(), grid: "0101" }, palette)).toThrow();
    expect(() => validateProjectDocument({ ...validDoc(), grid: undefined }, palette)).toThrow();
  });

  it("grid 每格必须是 65535 或小于 codes.length 的整数", () => {
    expect(() => validateProjectDocument({ ...validDoc(), grid: [0, 2, 0, 1] }, palette)).toThrow(
      /色号下标/,
    );
    expect(() =>
      validateProjectDocument({ ...validDoc(), grid: [0, 65535, 0, 1] }, palette),
    ).not.toThrow();
    expect(() => validateProjectDocument({ ...validDoc(), grid: [0, 1.5, 0, 1] }, palette)).toThrow(
      /色号下标/,
    );
    // 负数、非有限值、字符串：`typeof !== "number"` 与 `Number.isInteger` 各自负责一部分
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "1"]) {
      expect(() => validateProjectDocument({ ...validDoc(), grid: [0, bad, 0, 1] }, palette)).toThrow(
        /色号下标/,
      );
    }
    // 65535 之外的越界值都不得被当成空格放过
    expect(() =>
      validateProjectDocument({ ...validDoc(), grid: [0, 65534, 0, 1] }, palette),
    ).toThrow(/色号下标/);
    expect(() => validateProjectDocument({ ...validDoc(), grid: [0, -1, 0, 1] }, palette)).toThrow(
      /色号下标/,
    );
  });

  it("每个 code 都必须存在于全色卡", () => {
    expect(() =>
      validateProjectDocument(
        { ...validDoc(), palette: { id: "fake", codes: ["A3", "ZZ9"] } },
        palette,
      ),
    ).toThrow(/ZZ9/);
    // 非字符串色号同样要在查表前就报错（否则 Set.has 会静默返回 false，报成「不存在」）
    expect(() =>
      validateProjectDocument(
        { ...validDoc(), palette: { id: "fake", codes: ["A3", 3] } },
        palette,
      ),
    ).toThrow(/非字符串色号/);
    expect(() =>
      validateProjectDocument({ ...validDoc(), palette: { id: "fake", codes: "A3" } }, palette),
    ).toThrow(/codes 不是数组/);
    expect(() =>
      validateProjectDocument({ ...validDoc(), palette: { codes: ["A3", "A4"] } }, palette),
    ).toThrow(/色卡/);
  });

  it("code 不得重复（重复会让重映射依赖顺序）", () => {
    expect(() =>
      validateProjectDocument(
        { ...validDoc(), palette: { id: "fake", codes: ["A3", "A3"] } },
        palette,
      ),
    ).toThrow(/重复/);
    // 空格图纸：codes 为空、grid 全 65535，必须合法（规格 §10 明确列了这个用例）
    const empty = validateProjectDocument(
      {
        ...validDoc(),
        palette: { id: "fake", codes: [] },
        grid: [65535, 65535, 65535, 65535],
      },
      palette,
    );
    expect(empty.palette.codes).toEqual([]);
    expect(empty.grid).toEqual([65535, 65535, 65535, 65535]);
  });

  it("palette.codes 长度不得超过 EMPTY（65535）", () => {
    // 色号数达到 EMPTY 时，该色下标与空格标记撞在同一个值上，`patternStats` 会把它当空格
    // 静默吞掉。而 `loadPalette` 自己不许色数 > EMPTY，所以**没法用 loadPalette 造出越界
    // 色卡**——这里的色卡在内存里拼：颜色对象取自真实的内置色卡（已经过 loadPalette 校验，
    // 不是手搓的假对象），只是把数组长度拉到上界两侧，用来钉死这条长度检查本身。
    const real = loadPalette(mardRaw);
    const oversized: Palette = { ...real, colors: makeColors(realBase, EMPTY + 1) };
    const atLimit: Palette = { ...real, colors: makeColors(realBase, EMPTY) };

    const codesAtLimit = atLimit.colors.map((color) => color.code);
    expect(codesAtLimit.length).toBe(EMPTY);
    expect(() =>
      validateProjectDocument(
        { ...validDoc(), palette: { id: atLimit.id, codes: codesAtLimit }, grid: [0, 1, 0, 1] },
        atLimit,
      ),
    ).not.toThrow();

    // 越界色号表每个元素都是合法色号，所以唯一能拦下它的就是长度上限本身
    // （把上限检查删掉时这条必须转红 —— 实测过，见报告 M6）。
    const codesOverLimit = oversized.colors.map((color) => color.code);
    expect(() =>
      validateProjectDocument(
        { ...validDoc(), palette: { id: oversized.id, codes: codesOverLimit }, grid: [0, 1, 0, 1] },
        oversized,
      ),
    ).toThrow(/超过上限/);
  });

  it("palette.id 必须与传入色卡一致", () => {
    expect(() =>
      validateProjectDocument(
        { ...validDoc(), palette: { id: "other", codes: ["A3", "A4"] } },
        palette,
      ),
    ).toThrow(/色卡/);
    // 同 id 但 code 集合不同（子集色卡）必须靠逐 code 查表拦下，不能只比 id
    expect(() =>
      validateProjectDocument(
        { ...validDoc(), palette: { id: "fake", codes: ["A1", "A2"] } },
        palette,
      ),
    ).not.toThrow();
  });

  it("params.longSide 必须是 1–116 的整数", () => {
    for (const bad of [0, -1, 117, 1.5, Number.NaN]) {
      expect(() =>
        validateProjectDocument(
          { ...validDoc(), params: { ...(validDoc().params as object), longSide: bad } },
          palette,
        ),
      ).toThrow(/长边/);
    }
    // NaN 之外的非有限值、字符串与缺失字段
    for (const bad of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "2", undefined]) {
      expect(() =>
        validateProjectDocument(
          { ...validDoc(), params: { ...(validDoc().params as object), longSide: bad } },
          palette,
        ),
      ).toThrow(/长边/);
    }
    // 两端边界本身必须放行
    for (const good of [1, 116]) {
      expect(() =>
        validateProjectDocument(
          { ...validDoc(), params: { ...(validDoc().params as object), longSide: good } },
          palette,
        ),
      ).not.toThrow();
    }
  });

  /**
   * **2026-10-10 口径简化**：用色档位从 5 值枚举改成「1..色卡色数 的整数」，
   * **等于色卡色数即「不限」**。
   *
   * 语义变化逐条说清：
   * - `32` 旧枚举里是合法值、C7 起是非法值，**现在又是合法值**——它就是一个数字（32 种色），
   *   只要不超过色卡色数（本文夹具 221）。
   * - `"custom"` / `"all"` 是旧记录里的字符串，**不做兼容**，一律按「用色档位非法」响亮失败
   *   （人类伙伴裁定 A1，与 C7「旧枚举不做兼容」同一先例）。
   * - `null`（C7 之前的「不限」）同样响亮失败；新的「不限」表示是那个数字本身。
   */
  it("params.maxColors 只允许 1..色卡色数 的整数（= 色卡色数即「不限」；旧字符串一律拒）", () => {
    const withMax = (maxColors: unknown) =>
      validateProjectDocument(
        { ...validDoc(), params: { ...(validDoc().params as object), maxColors } },
        palette,
      );

    expect(palette.colors.length).toBe(221);
    // 每个合法值都要真落到返回值上（只断言 not.toThrow 会漏掉「被换成 16」这类静默改写）
    for (const good of [1, 8, 16, 24, 32, 220, 221]) {
      expect(withMax(good).params.maxColors).toBe(good);
    }
    // 222 是上界紧邻外侧的探针；字符串与 null 是旧记录的表示，一律不做兼容。
    for (const bad of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      222,
      "16",
      "custom",
      "all",
      null,
      undefined,
    ]) {
      expect(() => withMax(bad)).toThrow(/档位/);
    }
  });

  it("params.customMaxColors 已删除：带上它的旧文档不再有第二个字段，返回值里也不存在", () => {
    // 口径简化把「档位 + 自定义数值」两个字段并成了一个数字：读旧文档时 `customMaxColors`
    // 只是一个多余的未知字段，**不被搬进返回值**（照 `file.ts` 白名单式重建的口径）。
    const checked = validateProjectDocument(
      {
        ...validDoc(),
        params: { ...(validDoc().params as object), maxColors: 16, customMaxColors: 3 },
      },
      palette,
    );
    expect(checked.params).not.toHaveProperty("customMaxColors");
    expect(Object.keys(checked.params).sort()).toEqual(["crop", "longSide", "maxColors"]);
  });

  it("params.crop 的 x/y 必须有限，w/h 必须有限且 ≥1，rotate 必须是 0–3 的整数", () => {
    const withCrop = (crop: unknown) =>
      validateProjectDocument(
        { ...validDoc(), params: { ...(validDoc().params as object), crop } },
        palette,
      );
    expect(() => withCrop({ x: Number.NaN, y: 0, w: 8, h: 8, rotate: 0 })).toThrow(/裁剪/);
    expect(() => withCrop({ x: 0, y: Number.POSITIVE_INFINITY, w: 8, h: 8, rotate: 0 })).toThrow(
      /裁剪/,
    );
    expect(() => withCrop({ x: 0, y: 0, w: 0, h: 8, rotate: 0 })).toThrow(/裁剪/);
    expect(() => withCrop({ x: 0, y: 0, w: 8, h: Number.NaN, rotate: 0 })).toThrow(/裁剪/);
    expect(() => withCrop({ x: 0, y: 0, w: 8, h: 8, rotate: 4 })).toThrow(/旋转/);
    expect(() => withCrop({ x: 0, y: 0, w: 8, h: 8, rotate: 1.5 })).toThrow(/旋转/);
    expect(() => withCrop({ x: 0, y: 0, w: 8, h: 8, rotate: -1 })).toThrow(/旋转/);
    expect(() => withCrop(undefined)).toThrow(/裁剪/);
    // 坐标与尺寸的口径**不同**（规格 §5.4）：x/y 只要求有限（负数、小数都合法），
    // w/h 还要求 ≥1。缺字段则 `Number.isFinite(undefined)` 为假，照样拦下。
    expect(() => withCrop({ y: 0, w: 8, h: 8, rotate: 0 })).toThrow(/裁剪/);
    expect(() => withCrop({ x: 0, y: "0", w: 8, h: 8, rotate: 0 })).toThrow(/裁剪/);
    expect(() => withCrop({ x: 0, y: 0, w: 8, h: 8 })).toThrow(/旋转/);
    expect(() => withCrop({ x: 0, y: 0, w: -8, h: 8, rotate: 0 })).toThrow(/裁剪/);
    expect(() => withCrop({ x: 0, y: 0, w: 0.999, h: 8, rotate: 0 })).toThrow(/裁剪/);
    expect(() => withCrop({ x: 0, y: 0, w: 8, h: 0.999, rotate: 0 })).toThrow(/裁剪/);
    expect(() => withCrop(null)).toThrow(/裁剪/);
    for (const bad of [Number.NaN, "0", undefined]) {
      expect(() => withCrop({ x: 0, y: 0, w: 8, h: 8, rotate: bad })).toThrow(/旋转/);
    }
    // 四档 rotate 全部放行，且原样落进返回值
    for (const rotate of [0, 1, 2, 3]) {
      const doc = withCrop({ x: 1, y: 2, w: 8, h: 9, rotate });
      expect(doc.params.crop).toEqual({ x: 1, y: 2, w: 8, h: 9, rotate });
    }
    // 小数坐标是合法的（坐标是像素量，未要求整数）；只有 w/h 的下界 1 是硬约束。
    // 负数 x/y 也放行——口径是「有限」，不是「非负」；w/h 的小数只要 ≥1 同样放行。
    expect(withCrop({ x: -0.5, y: -1.25, w: 1, h: 8, rotate: 0 }).params.crop).toEqual({
      x: -0.5,
      y: -1.25,
      w: 1,
      h: 8,
      rotate: 0,
    });
    expect(withCrop({ x: 0.5, y: 1.25, w: 1.5, h: 2.5, rotate: 0 }).params.crop).toEqual({
      x: 0.5,
      y: 1.25,
      w: 1.5,
      h: 2.5,
      rotate: 0,
    });
  });

  it("非法文档抛的是错误，不是一个「看起来正常」的对象", () => {
    // 这条断言的方向：坏输入必须**响亮失败**，而不是被补齐成默认值。
    let caught: unknown = null;
    try {
      validateProjectDocument({ ...validDoc(), width: 0 }, palette);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
  });

  it("返回值与输入不共享引用（改了输入不会污染已校验的文档）", () => {
    const raw = validDoc();
    const doc = validateProjectDocument(raw, palette);
    (raw.grid as number[])[0] = 1;
    expect(doc.grid).toEqual([0, 1, 0, 1]);
  });
});
