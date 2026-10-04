import { describe, expect, it } from "vitest";
import type { DecodeRequest, Decoder } from "@/core/image/decode";
import type { RgbaImage, Rotation } from "@/core/image/types";
import { loadPalette } from "@/core/palette/registry";
import { EMPTY } from "@/core/pattern/types";
import {
  chooseDecoderPath,
  generatePattern,
  MAX_EXACT_CROP_EDGE,
  type GenerateDeps,
} from "../pipeline";

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

/** 造一张「左上红、右上绿、左下蓝、右下黑」的方形四象限位图。 */
function quadrants(size: number): RgbaImage {
  const data = new Uint8ClampedArray(size * size * 4);
  const half = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const left = x < half;
      const top = y < half;
      const color: [number, number, number] = top
        ? left
          ? [255, 0, 0]
          : [0, 255, 0]
        : left
          ? [0, 0, 255]
          : [0, 0, 0];
      data[i] = color[0];
      data[i + 1] = color[1];
      data[i + 2] = color[2];
      data[i + 3] = 255;
    }
  }
  return { width: size, height: size, data };
}

const image = quadrants(224);

const fakeDecoder: Decoder = {
  name: "fake",
  // 返回值是裁剪原生尺寸（这里固定为 224×224 的象限图），符合 native 口径
  outputSize: "native",
  async decode(_source: Blob, request: DecodeRequest): Promise<RgbaImage> {
    // 假解码器忽略请求尺寸，直接返回固定象限图，便于断言朝向与尺寸
    void request;
    return image;
  },
};

/**
 * 快路径桩：本 describe 里所有用例的裁剪长边都 ≤ 2048，按规格 §12.1 的择路规则
 * **必须**走保底路径。让它直接抛错——「小裁剪误走快路径」于是变成用例失败，
 * 而不是静默换成另一条解码路径。
 */
const fastMustNotBeUsed: Decoder = {
  name: "fast-should-not-be-used",
  outputSize: "target",
  async decode(): Promise<RgbaImage> {
    throw new Error("裁剪长边在预算内，不应走快路径");
  },
};

const deps: GenerateDeps = {
  exactDecoder: fakeDecoder,
  fastDecoder: fastMustNotBeUsed,
  palette,
};

const source = new Blob([new Uint8Array([1])]);
const crop = { x: 0, y: 0, width: 224, height: 224 };
/** 既有用例的裁剪框最大到 4096×1024、原点最大到 (3, 5)——取一个足够大的源图覆盖它们。 */
const sourceSize = { width: 8192, height: 8192 };

describe("generatePattern", () => {
  it("算出正确的网格尺寸", async () => {
    const pattern = await generatePattern(
      { source, sourceSize, crop, rotation: 0, longSide: 4, maxColors: 16 },
      deps,
    );
    expect(pattern.width).toBe(4);
    expect(pattern.height).toBe(4);
    expect(pattern.paletteId).toBe("fake");
  });

  it("0° 时四个象限的色号位置正确", async () => {
    const pattern = await generatePattern(
      { source, sourceSize, crop, rotation: 0, longSide: 2, maxColors: 16 },
      deps,
    );
    // 左上红(A3=2)、右上绿(A4=3)、左下蓝(A5=4)、右下黑(A2=1)
    expect(pattern.cells[0]).toBe(2);
    expect(pattern.cells[1]).toBe(3);
    expect(pattern.cells[2]).toBe(4);
    expect(pattern.cells[3]).toBe(1);
  });

  it("旋转 90° 后宽高互换且象限位置随之旋转", async () => {
    const pattern = await generatePattern(
      { source, sourceSize, crop, rotation: 1, longSide: 4, maxColors: 16 },
      deps,
    );
    // 裁剪是正方形，旋转后仍是 4×4；原左下角（蓝）顺时针转 90° 后落在左上角
    expect(pattern.width).toBe(4);
    expect(pattern.height).toBe(4);
    expect(pattern.cells[0]).toBe(4);
  });

  it("横图转 90° 后成品是竖图，长边落在高度上", async () => {
    const wide = { x: 0, y: 0, width: 400, height: 200 };
    const pattern = await generatePattern(
      { source, sourceSize, crop: wide, rotation: 1, longSide: 10, maxColors: 16 },
      deps,
    );
    // 400×200 转 90° → 200×400，长边 10 落在高度：宽 round(10×200/400)=5、高 10
    expect(pattern.width).toBe(5);
    expect(pattern.height).toBe(10);
  });

  it("空格在图纸里保持为 EMPTY", async () => {
    const transparent: RgbaImage = {
      width: 4,
      height: 4,
      data: new Uint8ClampedArray(4 * 4 * 4),
    };
    const transparentDecoder: Decoder = {
      name: "transparent",
      outputSize: "native",
      async decode(): Promise<RgbaImage> {
        return transparent;
      },
    };
    const pattern = await generatePattern(
      { source, sourceSize, crop: { x: 0, y: 0, width: 4, height: 4 }, rotation: 0, longSide: 2, maxColors: 16 },
      { exactDecoder: transparentDecoder, fastDecoder: fastMustNotBeUsed, palette },
    );
    expect([...pattern.cells]).toEqual([EMPTY, EMPTY, EMPTY, EMPTY]);
  });
});

/**
 * —— 任务 8 追加：四个旋转角全都要覆盖 ——
 * 简报只覆盖 rotation 0 与 1；2 与 3 只在 `rotate.test.ts`（任务 5，纯网格重映射）里测过，
 * 而 `pipeline.ts` 的 `rotation === 1 || rotation === 3` 朝向分支在 3 上是**无人读**的：
 * 把 `|| rotation === 3` 删掉，简报全套断言仍然全绿，但用户转 270° 会拿到转错方向的图纸。
 */
describe("generatePattern（追加：rotation 2 / 3 的象限映射与朝向分支）", () => {
  it("旋转 180°：象限整体对调，宽高不变", async () => {
    const pattern = await generatePattern(
      { source, sourceSize, crop, rotation: 2, longSide: 4, maxColors: 16 },
      deps,
    );
    expect(pattern.width).toBe(4);
    expect(pattern.height).toBe(4);
    // 180°：(sx,sy) → (3-sx, 3-sy)；右下黑(1) 落到左上
    expect([...pattern.cells]).toEqual([1, 1, 4, 4, 1, 1, 4, 4, 3, 3, 2, 2, 3, 3, 2, 2]);
  });

  it("旋转 270°：源右上（绿）落到左上，源左上（红）落到左下", async () => {
    const pattern = await generatePattern(
      { source, sourceSize, crop, rotation: 3, longSide: 4, maxColors: 16 },
      deps,
    );
    expect(pattern.width).toBe(4);
    expect(pattern.height).toBe(4);
    // 270°：(sx,sy) → (sy, 3-sx)
    expect([...pattern.cells]).toEqual([3, 3, 1, 1, 3, 3, 1, 1, 2, 2, 4, 4, 2, 2, 4, 4]);
  });

  it("横图转 270° 后成品同样是竖图，长边落在高度上", async () => {
    const exact = makeStub("exact", "native");
    const pattern = await generatePattern(
      {
        source,
        sourceSize,
        crop: { x: 0, y: 0, width: 400, height: 200 },
        rotation: 3,
        longSide: 10,
        maxColors: 16,
      },
      { exactDecoder: exact.decoder, fastDecoder: forbidden("fast", "target"), palette },
    );
    // 若朝向分支漏掉 rotation 3（只判 rotation === 1），成品会变成 10×5
    expect(pattern.width).toBe(5);
    expect(pattern.height).toBe(10);
    // 未旋转朝向是 400×200 → 网格 10×5 → target 40×20
    expect(exact.requests[0]?.targetWidth).toBe(40);
    expect(exact.requests[0]?.targetHeight).toBe(20);
  });

  it("裁剪尺寸非法时在解码之前就抛错，解码器一次都不被调用", async () => {
    const exact = makeStub("exact", "native");
    await expect(
      generatePattern(
        {
          source,
          sourceSize,
          crop: { x: 0, y: 0, width: 0, height: 10 },
          rotation: 0,
          longSide: 4,
          maxColors: 16,
        },
        { exactDecoder: exact.decoder, fastDecoder: forbidden("fast", "target"), palette },
      ),
    ).rejects.toThrow(/裁剪区域尺寸非法/);
    expect(exact.requests).toHaveLength(0);
  });

  // 标题如实写明本用例证明的范围：它在修复前后都绿（chooseDecoderPath 本轮未改，
  // 非有限尺寸在它那里就会抛错），真正判别「Infinity 曾静默算出看似正常的网格」的是
  // build.test.ts 里 `computeGridSize` 的两条用例——「裁剪尺寸非有限时抛错」与
  // 「裁剪高非法同样抛错（不只是宽）」（按标题定位，不写行号）。原标题声称
  // 「Infinity 曾能走完一次解码」，会让后人以为 build.test.ts 那条冗余而删掉它
  // ——账本「任务 8 延后 Minor」第 1 条。
  it("裁剪尺寸非有限时同样在解码之前抛错（解码器一次都不被调用）", async () => {
    const exact = makeStub("exact", "native");
    await expect(
      generatePattern(
        {
          source,
          sourceSize,
          crop: { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 10 },
          rotation: 0,
          longSide: 4,
          maxColors: 16,
        },
        { exactDecoder: exact.decoder, fastDecoder: forbidden("fast", "target"), palette },
      ),
    ).rejects.toThrow(/裁剪区域尺寸非法/);
    await expect(
      generatePattern(
        {
          source,
          sourceSize,
          crop: { x: 0, y: 0, width: Number.NaN, height: 10 },
          rotation: 0,
          longSide: 4,
          maxColors: 16,
        },
        { exactDecoder: exact.decoder, fastDecoder: forbidden("fast", "target"), palette },
      ),
    ).rejects.toThrow(/裁剪区域尺寸非法/);
    expect(exact.requests).toHaveLength(0);
  });

  it("rotation 非法时在解码之前抛错，解码器一次都不被调用", async () => {
    const exact = makeStub("exact", "native");
    // 刻意构造契约外的值：Rotation 类型只允许 0–3，但持久化参数/平台回传都可能是任意 number。
    // 不先拦下就会白跑一次原生解码 + 面积平均重采样，再由 rotateGrid 抛错。
    for (const bad of [5, -1, 1.5, Number.NaN]) {
      await expect(
        generatePattern(
          {
            source,
            sourceSize,
            crop,
            rotation: bad as unknown as Rotation,
            longSide: 4,
            maxColors: 16,
          },
          { exactDecoder: exact.decoder, fastDecoder: forbidden("fast", "target"), palette },
        ),
      ).rejects.toThrow(/旋转角度非法/);
    }
    expect(exact.requests).toHaveLength(0);
  });
});

/** 纯色位图，用于可控解码器桩。 */
function solid(width: number, height: number, rgb: readonly [number, number, number]): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

/** 记录实参的解码器桩：保底路径返回裁剪原生尺寸，快路径返回 target 尺寸。 */
function makeStub(label: string, outputSize: "target" | "native") {
  const requests: DecodeRequest[] = [];
  const sources: Blob[] = [];
  const decoder: Decoder = {
    name: label,
    outputSize,
    async decode(source: Blob, request: DecodeRequest): Promise<RgbaImage> {
      sources.push(source);
      requests.push(request);
      return outputSize === "native"
        ? solid(request.crop.width, request.crop.height, [0, 0, 255])
        : solid(request.targetWidth, request.targetHeight, [0, 0, 255]);
    },
  };
  return { decoder, requests, sources };
}

/** 断言「不该被调用」的解码器桩。 */
function forbidden(label: string, outputSize: "target" | "native"): Decoder {
  return {
    name: label,
    outputSize,
    async decode(): Promise<RgbaImage> {
      throw new Error(`${label} 不应被调用`);
    },
  };
}

describe("generatePattern：解码路径择优（规格 §12.1 的降级方案）", () => {
  it("裁剪长边恰为阈值 2048 → 保底路径，快路径零调用", async () => {
    const exact = makeStub("exact", "native");
    const pattern = await generatePattern(
      {
        source,
        sourceSize,
        crop: { x: 0, y: 0, width: 2048, height: 512 },
        rotation: 0,
        longSide: 4,
        maxColors: 16,
      },
      { exactDecoder: exact.decoder, fastDecoder: forbidden("fast", "target"), palette },
    );
    expect(exact.requests).toHaveLength(1);
    expect(exact.sources[0]).toBe(source);
    expect(exact.requests[0]?.targetWidth).toBe(16);
    expect(exact.requests[0]?.targetHeight).toBe(4);
    expect(pattern.width).toBe(4);
    expect(pattern.height).toBe(1);
    expect([...pattern.cells]).toEqual([4, 4, 4, 4]);
  });

  it("裁剪长边恰好多 1（2049）→ 快路径，保底路径零调用", async () => {
    const fast = makeStub("fast", "target");
    const pattern = await generatePattern(
      {
        source,
        sourceSize,
        crop: { x: 0, y: 0, width: 2049, height: 512 },
        rotation: 0,
        longSide: 4,
        maxColors: 16,
      },
      { exactDecoder: forbidden("exact", "native"), fastDecoder: fast.decoder, palette },
    );
    expect(fast.requests).toHaveLength(1);
    expect(fast.requests[0]?.targetWidth).toBe(16);
    expect(fast.requests[0]?.targetHeight).toBe(4);
    expect(pattern.width).toBe(4);
    expect(pattern.height).toBe(1);
  });

  it("判定依据是长边而非面积：4096×1024（面积恰为 2048²）仍走快路径", async () => {
    expect(4096 * 1024).toBe(MAX_EXACT_CROP_EDGE * MAX_EXACT_CROP_EDGE);
    const fast = makeStub("fast", "target");
    const pattern = await generatePattern(
      {
        source,
        sourceSize,
        crop: { x: 0, y: 0, width: 4096, height: 1024 },
        rotation: 0,
        longSide: 4,
        maxColors: 16,
      },
      { exactDecoder: forbidden("exact", "native"), fastDecoder: fast.decoder, palette },
    );
    // 长边 4096 > 2048 → 快路径；若按面积判定就会误走保底路径（面积 4096×1024 = 2048²）
    expect(fast.requests).toHaveLength(1);
    expect(pattern.width).toBe(4);
    expect(pattern.height).toBe(1);
  });

  it("解码在未旋转朝向下进行：90° 旋转时 target 尺寸按 rawGrid 算、裁剪框原样透传", async () => {
    const exact = makeStub("exact", "native");
    await generatePattern(
      {
        source,
        sourceSize,
        crop: { x: 3, y: 5, width: 400, height: 200 },
        rotation: 1,
        longSide: 10,
        maxColors: 16,
      },
      { exactDecoder: exact.decoder, fastDecoder: forbidden("fast", "target"), palette },
    );
    // 成品朝向 200×400 → 网格 5×10；未旋转朝向 400×200 → 网格 10×5 → target 40×20。
    // 若误用最终朝向的网格算 target 就会得到 20×40。
    expect(exact.requests[0]?.crop).toEqual({ x: 3, y: 5, width: 400, height: 200 });
    expect(exact.requests[0]?.targetWidth).toBe(40);
    expect(exact.requests[0]?.targetHeight).toBe(20);
  });

  it("不假设解码器返回 target 尺寸：按返回值实际尺寸重采样", async () => {
    const oddball: Decoder = {
      name: "oddball",
      outputSize: "native",
      async decode(): Promise<RgbaImage> {
        // 契约上应返回裁剪原生 64×32，这里刻意回一个 8×4
        return solid(8, 4, [0, 255, 0]);
      },
    };
    const pattern = await generatePattern(
      { source, sourceSize, crop: { x: 0, y: 0, width: 64, height: 32 }, rotation: 0, longSide: 2, maxColors: 16 },
      { exactDecoder: oddball, fastDecoder: forbidden("fast", "target"), palette },
    );
    // 网格尺寸由裁剪比例与长边决定，与解码返回的像素尺寸无关
    expect(pattern.width).toBe(2);
    expect(pattern.height).toBe(1);
    expect([...pattern.cells]).toEqual([3, 3]); // A4 纯绿
  });
});

describe("chooseDecoderPath", () => {
  it("长边恰好等于阈值时走保底路径（含两个方向与长条）", () => {
    expect(MAX_EXACT_CROP_EDGE).toBe(2048);
    expect(chooseDecoderPath({ width: 2048, height: 2048 })).toBe("exact");
    expect(chooseDecoderPath({ width: 2048, height: 10 })).toBe("exact");
    expect(chooseDecoderPath({ width: 10, height: 2048 })).toBe("exact");
  });

  it("长边恰好多 1 时走快路径（两个方向都要判）", () => {
    expect(chooseDecoderPath({ width: 2049, height: 2048 })).toBe("fast");
    expect(chooseDecoderPath({ width: 2048, height: 2049 })).toBe("fast");
    expect(chooseDecoderPath({ width: 2049, height: 10 })).toBe("fast");
    expect(chooseDecoderPath({ width: 10, height: 2049 })).toBe("fast");
  });

  it("判定依据是长边而不是面积（4096×1024 面积恰为 2048²，仍走快路径）", () => {
    expect(4096 * 1024).toBe(MAX_EXACT_CROP_EDGE ** 2);
    expect(chooseDecoderPath({ width: 4096, height: 1024 })).toBe("fast");
    expect(chooseDecoderPath({ width: 1024, height: 4096 })).toBe("fast");
    // 对照：长边在预算内的方形裁剪走保底
    expect(chooseDecoderPath({ width: 1024, height: 1024 })).toBe("exact");
  });

  it("阈值可注入，边界仍按长边判定", () => {
    expect(chooseDecoderPath({ width: 100, height: 100 }, 100)).toBe("exact");
    expect(chooseDecoderPath({ width: 101, height: 1 }, 100)).toBe("fast");
    expect(chooseDecoderPath({ width: 1, height: 101 }, 100)).toBe("fast");
    expect(chooseDecoderPath({ width: 100, height: 1 }, 100)).toBe("exact");
  });

  it("非法输入抛错，而不是静默走某一条路径", () => {
    expect(() => chooseDecoderPath({ width: 0, height: 10 })).toThrow(/裁剪区域尺寸非法/);
    expect(() => chooseDecoderPath({ width: 10, height: -1 })).toThrow(/裁剪区域尺寸非法/);
    expect(() => chooseDecoderPath({ width: Number.NaN, height: 10 })).toThrow(/裁剪区域尺寸非法/);
    expect(() => chooseDecoderPath({ width: 10, height: Number.POSITIVE_INFINITY })).toThrow(
      /裁剪区域尺寸非法/,
    );
    expect(() => chooseDecoderPath({ width: 10, height: 10 }, 0)).toThrow(/阈值非法/);
    expect(() => chooseDecoderPath({ width: 10, height: 10 }, Number.NaN)).toThrow(/阈值非法/);
  });
});

/**
 * —— 任务 6 追加：`sourceSize` 与「越界一律拒绝」 ——
 *
 * B1-12 / B1-13 的裁决：`generatePattern` 入口**拒绝**越界 `crop`，不静默夹取（两条理由见
 * `pipeline.ts` 里 `GenerateRequest.sourceSize` 的 JSDoc）。校验的位置是硬约束：必须在
 * `computeGridSize` / `computeDecodeSize` 之后、`chooseDecoderPath` 之前——放到最前面会换掉
 * 既有「裁剪区域尺寸非法」用例的错误消息，等于改坏既有契约。
 */
describe("generatePattern 的原图范围校验（B1-12 / B1-13：拒绝，不夹取）", () => {
  const SOURCE_SIZE = { width: 800, height: 600 };

  it("左/上越界时抛错，解码器一次都不被调用", async () => {
    for (const { crop: badCrop, message } of [
      {
        crop: { x: -1, y: 0, width: 100, height: 100 },
        message: "裁剪框超出原图范围：原图 800×600，裁剪框 x=-1 y=0 100×100",
      },
      {
        crop: { x: 0, y: -1, width: 100, height: 100 },
        message: "裁剪框超出原图范围：原图 800×600，裁剪框 x=0 y=-1 100×100",
      },
    ]) {
      const exact = makeStub("exact", "native");
      await expect(
        generatePattern(
          {
            source,
            sourceSize: SOURCE_SIZE,
            crop: badCrop,
            rotation: 0,
            longSide: 4,
            maxColors: 16,
          },
          { exactDecoder: exact.decoder, fastDecoder: forbidden("fast", "target"), palette },
        ),
      ).rejects.toThrow(message);
      expect(exact.requests).toHaveLength(0);
    }
  });

  it("右/下越界时抛错（x + width 恰好超出 1 像素也要拦）", async () => {
    for (const { crop: badCrop, message } of [
      {
        crop: { x: 701, y: 0, width: 100, height: 100 },
        message: "裁剪框超出原图范围：原图 800×600，裁剪框 x=701 y=0 100×100",
      },
      {
        crop: { x: 0, y: 501, width: 100, height: 100 },
        message: "裁剪框超出原图范围：原图 800×600，裁剪框 x=0 y=501 100×100",
      },
    ]) {
      const exact = makeStub("exact", "native");
      await expect(
        generatePattern(
          {
            source,
            sourceSize: SOURCE_SIZE,
            crop: badCrop,
            rotation: 0,
            longSide: 4,
            maxColors: 16,
          },
          { exactDecoder: exact.decoder, fastDecoder: forbidden("fast", "target"), palette },
        ),
      ).rejects.toThrow(message);
      expect(exact.requests).toHaveLength(0);
    }
  });

  // 这条是上面两条的对照：不写它的话，「凡是 crop 都拒绝」也能让上面全绿。
  it("恰好贴边不算越界（x + width == 源图宽、y + height == 源图高）", async () => {
    const exact = makeStub("exact", "native");
    const pattern = await generatePattern(
      {
        source,
        sourceSize: SOURCE_SIZE,
        crop: { x: 600, y: 500, width: 200, height: 100 },
        rotation: 0,
        longSide: 4,
        maxColors: 16,
      },
      { exactDecoder: exact.decoder, fastDecoder: forbidden("fast", "target"), palette },
    );
    // 200×100 的裁剪、长边 4 → 网格 4×2
    expect(pattern.width).toBe(4);
    expect(pattern.height).toBe(2);
    // 贴边不等于拒绝：这一次解码真的发生过（否则「凡贴边都拒绝」也能满足上面两行）
    expect(exact.requests).toHaveLength(1);
  });

  // NaN 的越界判定是「比较全为假」——四条不等式一条都拦不住它，所以必须单独查有限性。
  // x 与 y **各查一次**：只守 x 的话，`y: NaN` 仍会静默解码出一张错位图纸。
  // （±Infinity 原点不必单列：`x < 0` / `x + width > 源图宽` 已经能拦下它们。）
  it("裁剪框原点是 NaN 时抛错（四条不等式全为假，必须单独查有限性）", async () => {
    for (const { origin, message } of [
      { origin: { x: Number.NaN, y: 0 }, message: "裁剪框原点必须是有限数字（当前 x=NaN y=0）" },
      { origin: { x: 0, y: Number.NaN }, message: "裁剪框原点必须是有限数字（当前 x=0 y=NaN）" },
    ]) {
      const exact = makeStub("exact", "native");
      await expect(
        generatePattern(
          {
            source,
            sourceSize: SOURCE_SIZE,
            crop: { ...origin, width: 100, height: 100 },
            rotation: 0,
            longSide: 4,
            maxColors: 16,
          },
          { exactDecoder: exact.decoder, fastDecoder: forbidden("fast", "target"), palette },
        ),
      ).rejects.toThrow(message);
      expect(exact.requests).toHaveLength(0);
    }
  });

  // 宽、高**两条分支各查一遍**，并逐条钉住消息与回显的当前值：只测宽的话，删掉高度那条 `if`
  // 或把两条消息写反都不会有断言转红；消息不钉到值上的话，去掉 `${String(...)}` 插值也不红。
  it("源图尺寸非整数或 < 1 时抛错（宽高各一条分支，消息不能互换、当前值要回显）", async () => {
    const exact = makeStub("exact", "native");
    const validCrop = { x: 0, y: 0, width: 100, height: 100 };
    for (const { size, message } of [
      { size: { width: 1.5, height: 600 }, message: "原图宽度必须是 ≥1 的整数（当前 1.5）" },
      { size: { width: 0, height: 600 }, message: "原图宽度必须是 ≥1 的整数（当前 0）" },
      { size: { width: Number.NaN, height: 600 }, message: "原图宽度必须是 ≥1 的整数（当前 NaN）" },
      { size: { width: 800, height: 1.5 }, message: "原图高度必须是 ≥1 的整数（当前 1.5）" },
      { size: { width: 800, height: 0 }, message: "原图高度必须是 ≥1 的整数（当前 0）" },
      { size: { width: 800, height: Number.NaN }, message: "原图高度必须是 ≥1 的整数（当前 NaN）" },
    ]) {
      await expect(
        generatePattern(
          {
            source,
            sourceSize: size,
            crop: validCrop,
            rotation: 0,
            longSide: 4,
            maxColors: 16,
          },
          { exactDecoder: exact.decoder, fastDecoder: forbidden("fast", "target"), palette },
        ),
      ).rejects.toThrow(message);
    }
    expect(exact.requests).toHaveLength(0);
  });
});
