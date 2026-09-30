import { describe, expect, it, vi } from "vitest";
import type { DecodeRequest } from "@/core/image/decode";
import type { RgbaImage } from "@/core/image/types";
import { createExactDecoder, createFastDecoder, type BitmapLike, type BitmapPlatform } from "../decoders";

const source = new Blob([new Uint8Array([1, 2, 3])]);

const request: DecodeRequest = {
  crop: { x: 10, y: 20, width: 100, height: 50 },
  targetWidth: 232,
  targetHeight: 116,
};

function makePlatform(pixels: RgbaImage) {
  const bitmap: BitmapLike = { width: pixels.width, height: pixels.height, close: vi.fn() };
  const platform: BitmapPlatform = {
    createRegion: vi.fn(async () => bitmap),
    createRegionResized: vi.fn(async () => bitmap),
    readPixels: vi.fn(() => pixels),
  };
  return { bitmap, platform };
}

const pixels: RgbaImage = {
  width: 2,
  height: 1,
  data: new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255]),
};

describe("createFastDecoder", () => {
  it("用裁剪框与目标尺寸调用一次带缩放的解码", async () => {
    const { platform } = makePlatform(pixels);
    const decoder = createFastDecoder(platform);
    const result = await decoder.decode(source, request);

    expect(platform.createRegionResized).toHaveBeenCalledTimes(1);
    expect(platform.createRegionResized).toHaveBeenCalledWith(source, 10, 20, 100, 50, 232, 116);
    expect(platform.createRegion).not.toHaveBeenCalled();
    expect(result).toBe(pixels);
  });

  it("始终释放位图，即使读像素抛错", async () => {
    const { bitmap, platform } = makePlatform(pixels);
    platform.readPixels = vi.fn(() => {
      throw new Error("读像素失败");
    });
    const decoder = createFastDecoder(platform);

    await expect(decoder.decode(source, request)).rejects.toThrow("读像素失败");
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });
});

describe("createExactDecoder", () => {
  it("用裁剪框调用不带缩放的解码", async () => {
    const { platform } = makePlatform(pixels);
    const decoder = createExactDecoder(platform);
    const result = await decoder.decode(source, request);

    expect(platform.createRegion).toHaveBeenCalledTimes(1);
    expect(platform.createRegion).toHaveBeenCalledWith(source, 10, 20, 100, 50);
    expect(platform.createRegionResized).not.toHaveBeenCalled();
    expect(result).toBe(pixels);
  });

  it("释放位图", async () => {
    const { bitmap, platform } = makePlatform(pixels);
    await createExactDecoder(platform).decode(source, request);
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });
});

describe("两个解码器", () => {
  it("名字不同，便于实验台区分", () => {
    const { platform } = makePlatform(pixels);
    expect(createFastDecoder(platform).name).not.toBe(createExactDecoder(platform).name);
  });
});

/**
 * 以下用例是简报之外**追加**的，简报给的 5 条一字未改。
 *
 * 追加的原因（对「断言可证伪性」的排查结果）：简报只断言 `close` 被调用过 1 次，
 * 因此在 `finally` 里把 `close()` 挪到 `readPixels` **之前**——真实平台上会读到已释放的
 * 位图——5 条用例照样全绿（读像素抛错的那条也只数次数，顺序错了它还是 1 次）。
 * 顺序在这里是行为契约的一部分（`ImageBitmap.close()` 之后再读像素没有定义），
 * 所以补一条按调用顺序断言的用例。
 */
describe("读像素必须在释放位图之前（简报外补充）", () => {
  const cases = [
    { label: "快路径", create: createFastDecoder },
    { label: "保底路径", create: createExactDecoder },
  ] as const;

  for (const { label, create } of cases) {
    it(`${label}：readPixels 先于 close，且两步各只发生一次`, async () => {
      const order: string[] = [];
      const owned: RgbaImage = {
        width: 1,
        height: 1,
        data: new Uint8ClampedArray([1, 2, 3, 255]),
      };
      const bitmap: BitmapLike = {
        width: 1,
        height: 1,
        close: () => {
          order.push("close");
        },
      };
      const platform: BitmapPlatform = {
        createRegion: vi.fn(async () => bitmap),
        createRegionResized: vi.fn(async () => bitmap),
        readPixels: vi.fn(() => {
          order.push("readPixels");
          return owned;
        }),
      };

      const result = await create(platform).decode(source, request);

      expect(result).toBe(owned);
      expect(order).toEqual(["readPixels", "close"]);
    });
  }
});
