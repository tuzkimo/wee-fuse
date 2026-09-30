import { afterEach, describe, expect, it, vi } from "vitest";
import { probeImageSize } from "../probe";

/**
 * `probeImageSize` 的平台依赖只有 `URL.createObjectURL/revokeObjectURL` 与 `Image`，
 * 三者都换成假实现即可在 happy-dom 里完整覆盖（happy-dom 的 `<img>` 不会真的解码 Blob）。
 *
 * 这份用例存在的理由：`probeImageSize` 唯一的资源生命周期风险是 blob URL 泄漏，
 * 而泄漏恰好发生在**出错路径**（解码失败 / 尺寸为 0）——那两条路径没有任何其他覆盖。
 */

const source = new Blob([new Uint8Array([1, 2, 3])]);

const OBJECT_URL = "blob:wee-fuse-fake-url";

function stubUrlApi() {
  const api = {
    createObjectURL: vi.fn(() => OBJECT_URL),
    revokeObjectURL: vi.fn(),
  };
  vi.stubGlobal("URL", api);
  return api;
}

interface FakeImageOptions {
  readonly width: number;
  readonly height: number;
  /** 传了就让 `decode()` 拒绝。 */
  readonly decodeError?: Error;
}

function stubImage(options: FakeImageOptions) {
  let assignedSrc = "";
  const decode = vi.fn(async () => {
    if (options.decodeError !== undefined) throw options.decodeError;
  });

  class FakeImage {
    readonly naturalWidth = options.width;
    readonly naturalHeight = options.height;
    readonly decode = decode;

    get src(): string {
      return assignedSrc;
    }

    set src(value: string) {
      assignedSrc = value;
    }
  }

  vi.stubGlobal("Image", FakeImage);
  return { decode, readSrc: () => assignedSrc };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("probeImageSize", () => {
  it("用 object URL 解码一次，返回自然尺寸并回收 URL", async () => {
    const url = stubUrlApi();
    const image = stubImage({ width: 4000, height: 3000 });

    await expect(probeImageSize(source)).resolves.toEqual({ width: 4000, height: 3000 });

    expect(url.createObjectURL.mock.calls).toEqual([[source]]);
    expect(image.readSrc()).toBe(OBJECT_URL);
    expect(image.decode).toHaveBeenCalledTimes(1);
    expect(url.revokeObjectURL.mock.calls).toEqual([[OBJECT_URL]]);
  });

  it("解码失败时抛出该错误，并照样回收 object URL", async () => {
    const url = stubUrlApi();
    stubImage({ width: 0, height: 0, decodeError: new Error("解码失败") });

    await expect(probeImageSize(source)).rejects.toThrow("解码失败");

    expect(url.revokeObjectURL.mock.calls).toEqual([[OBJECT_URL]]);
  });

  it("自然尺寸为 0 时抛错（不支持的格式或文件损坏），并照样回收 object URL", async () => {
    const url = stubUrlApi();
    stubImage({ width: 0, height: 3000 });

    await expect(probeImageSize(source)).rejects.toThrow("图片尺寸为 0");

    expect(url.revokeObjectURL.mock.calls).toEqual([[OBJECT_URL]]);
  });
});
