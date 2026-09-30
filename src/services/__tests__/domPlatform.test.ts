import { afterEach, describe, expect, it, vi } from "vitest";
import { createDomBitmapPlatform, type BitmapLike } from "../decoders";

/**
 * `createDomBitmapPlatform` 是本任务唯一真正接触平台 API 的代码，却没有被简报给的
 * 解码器用例覆盖（那些用例注入的是假 `BitmapPlatform`，平台实现整体不参与）。这份补充
 * 用例用 `vi.stubGlobal` 换掉 `createImageBitmap` / `OffscreenCanvas` / `document`，
 * 把「区域参数顺序」「resizeQuality 是否真的传下去」「画布尺寸与读像素坐标」「回落分支」
 * 这几处证据钉死——它们对应的变异（例如删掉 resizeQuality）在只有假平台用例时**全绿**。
 *
 * 注意：这里换掉的是全局上的**假实现**，没有调用任何真实平台 API，与简报「测试环境
 * 没有 createImageBitmap/OffscreenCanvas，解码器单测必须走注入的假平台」并不冲突。
 */

const source = new Blob([new Uint8Array([1, 2, 3])]);

/** 假的位图：宽高故意不等（4×2），这样把宽高写反、轴写反都能被断言抓住。 */
function makeBitmap(): BitmapLike {
  return { width: 4, height: 2, close: vi.fn() };
}

/** 假的 2D 上下文：只记录调用，按调用方给的像素返回。 */
function makeFakeContext(pixels: Uint8ClampedArray) {
  return {
    drawImage: vi.fn(),
    getImageData: vi.fn(() => ({ data: pixels })),
  };
}

type FakeContext = ReturnType<typeof makeFakeContext>;

interface FakeCanvas {
  width: number;
  height: number;
  readonly ctx: FakeContext;
}

/** 每次 `readPixels` 都会新建一个画布，这里把建过的实例都记下来供断言检查。 */
function stubOffscreenCanvas(elementBytes: number): FakeCanvas[] {
  const instances: FakeCanvas[] = [];
  class FakeOffscreenCanvas implements FakeCanvas {
    width: number;
    height: number;
    readonly ctx: FakeContext;

    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
      this.ctx = makeFakeContext(
        new Uint8ClampedArray(width * height * 4).fill(elementBytes),
      );
      instances.push(this);
    }

    getContext(kind: string): FakeContext | null {
      return kind === "2d" ? this.ctx : null;
    }
  }
  vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
  return instances;
}

function stubCreateBitmap(bitmap: BitmapLike) {
  // 形参名带下划线前缀：只用于断言 `mock.calls` 的形状，函数体不读它
  const createBitmap = vi.fn(async (..._args: unknown[]) => bitmap);
  vi.stubGlobal("createImageBitmap", createBitmap);
  return createBitmap;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("createDomBitmapPlatform 的裁剪调用", () => {
  it("createRegion 按 (source, sx, sy, sw, sh) 原样透传，且不带第 6 个参数", async () => {
    const bitmap = makeBitmap();
    const createBitmap = stubCreateBitmap(bitmap);
    const platform = createDomBitmapPlatform();

    const result = await platform.createRegion(source, 10, 20, 100, 50);

    expect(result).toBe(bitmap);
    // 用整份 calls 比较（而不是 toHaveBeenCalledWith）：多传/少传参数、参数错位都会红
    expect(createBitmap.mock.calls).toEqual([[source, 10, 20, 100, 50]]);
  });

  it("createRegionResized 透传裁剪框，并把 resizeWidth/resizeHeight/resizeQuality: high 一起传下去", async () => {
    const bitmap = makeBitmap();
    const createBitmap = stubCreateBitmap(bitmap);
    const platform = createDomBitmapPlatform();

    await platform.createRegionResized(source, 10, 20, 100, 50, 232, 116);

    expect(createBitmap.mock.calls).toEqual([
      [
        source,
        10,
        20,
        100,
        50,
        { resizeWidth: 232, resizeHeight: 116, resizeQuality: "high" },
      ],
    ]);
  });

  it("createImageBitmap 不可用时，构造平台就抛错", () => {
    vi.stubGlobal("createImageBitmap", undefined);
    expect(() => createDomBitmapPlatform()).toThrow(/createImageBitmap/);
  });
});

describe("createDomBitmapPlatform 的读像素", () => {
  it("建同尺寸 OffscreenCanvas、(0,0) 绘制、按 (0,0,w,h) 读像素，并返回画布上的数据", () => {
    const bitmap = makeBitmap();
    const createBitmap = stubCreateBitmap(bitmap);
    const instances = stubOffscreenCanvas(7);
    const platform = createDomBitmapPlatform();

    const image = platform.readPixels(bitmap);

    // 读像素不该重新解码一次图片
    expect(createBitmap).not.toHaveBeenCalled();
    expect(instances).toHaveLength(1);
    const canvas = instances[0];
    expect(canvas.width).toBe(4);
    expect(canvas.height).toBe(2);
    expect(canvas.ctx.drawImage.mock.calls).toEqual([[bitmap, 0, 0]]);
    expect(canvas.ctx.getImageData.mock.calls).toEqual([[0, 0, 4, 2]]);
    expect(image.width).toBe(4);
    expect(image.height).toBe(2);
    // 返回的必须是 `getImageData` 读出来的那份像素（每字节 7），
    // 而不是新分配的空缓冲——「读错画布/忘了用读出的数据」这类变异靠这条抓住
    expect(image.data).toHaveLength(32);
    expect(Array.from(image.data)).toEqual(new Array<number>(32).fill(7));
  });

  it("没有 OffscreenCanvas 时回落到 document.createElement('canvas')，尺寸与像素一致", () => {
    const bitmap = makeBitmap();
    stubCreateBitmap(bitmap);
    vi.stubGlobal("OffscreenCanvas", undefined);

    const pixels = new Uint8ClampedArray(4 * 2 * 4).fill(9);
    const ctx = makeFakeContext(pixels);
    const canvas = { width: 0, height: 0, getContext: vi.fn(() => ctx) };
    const createElement = vi.fn(() => canvas);
    vi.stubGlobal("document", { createElement });

    const platform = createDomBitmapPlatform();
    const image = platform.readPixels(bitmap);

    expect(createElement.mock.calls).toEqual([["canvas"]]);
    expect(canvas.width).toBe(4);
    expect(canvas.height).toBe(2);
    expect(ctx.drawImage.mock.calls).toEqual([[bitmap, 0, 0]]);
    expect(ctx.getImageData.mock.calls).toEqual([[0, 0, 4, 2]]);
    expect(Array.from(image.data)).toEqual(new Array<number>(32).fill(9));
  });

  it("拿不到 2D 上下文时抛错，而不是静默返回空位图", () => {
    const bitmap = makeBitmap();
    stubCreateBitmap(bitmap);
    vi.stubGlobal("OffscreenCanvas", undefined);
    vi.stubGlobal("document", {
      createElement: vi.fn(() => ({ width: 0, height: 0, getContext: vi.fn(() => null) })),
    });

    const platform = createDomBitmapPlatform();
    expect(() => platform.readPixels(bitmap)).toThrow(/2D 绘图上下文/);
  });
});
