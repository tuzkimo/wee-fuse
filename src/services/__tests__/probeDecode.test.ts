import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeImageElement } from "@/services/probe";

/**
 * `decodeImageElement` 是 `probe.ts` 里那段解码逻辑的**唯一实体**：`probeImageSize` 与
 * `services/imageSource.ts` 的 `loadImageSource` 都是它的消费者。`probe.test.ts` 只从
 * `probeImageSize` 的视角间接覆盖它，因此这里补的是**它自己的契约**——尤其是「成功路径不
 * 替调用方回收 object URL」这一条：`loadImageSource` 要拿着元素去 `drawImage`，URL 必须先
 * 活着；而失败路径调用方拿不到 `release`，必须自己回收，否则每次选到损坏文件就泄一个 URL。
 *
 * 平台依赖同样只有 `URL.createObjectURL/revokeObjectURL` 与 `Image`，全部换成假实现。
 */

const source = new Blob([new Uint8Array([1, 2, 3])]);

const OBJECT_URL = "blob:wee-fuse-decode-fake-url";

function stubUrlApi() {
  const api = {
    createObjectURL: vi.fn(() => OBJECT_URL),
    revokeObjectURL: vi.fn(),
  };
  vi.stubGlobal("URL", api);
  return api;
}

function stubImage(width: number, height: number, decodeError?: Error) {
  const decode = vi.fn(async () => {
    if (decodeError !== undefined) throw decodeError;
  });

  class FakeImage {
    readonly naturalWidth = width;
    readonly naturalHeight = height;
    src = "";
    readonly decode = decode;
  }

  vi.stubGlobal("Image", FakeImage);
  return { decode };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("decodeImageElement", () => {
  it("成功时不回收 URL，交给调用方 release()，并交出解码出的元素与尺寸", async () => {
    const url = stubUrlApi();
    const image = stubImage(4000, 3000);

    const decoded = await decodeImageElement(source);

    expect(decoded.width).toBe(4000);
    expect(decoded.height).toBe(3000);
    expect(decoded.element.naturalWidth).toBe(4000);
    expect(image.decode).toHaveBeenCalledTimes(1);
    // 调用方还要拿 element 去 drawImage；此时 URL 必须仍然有效。
    expect(url.revokeObjectURL).not.toHaveBeenCalled();

    decoded.release();

    expect(url.revokeObjectURL.mock.calls).toEqual([[OBJECT_URL]]);
  });

  it("release() 可重复调用，URL 只回收一次", async () => {
    const url = stubUrlApi();
    stubImage(800, 600);

    const decoded = await decodeImageElement(source);
    decoded.release();
    decoded.release();

    expect(url.revokeObjectURL.mock.calls).toEqual([[OBJECT_URL]]);
  });

  it("解码失败时自己回收 URL（调用方拿不到 release）并抛中文前缀错误", async () => {
    const url = stubUrlApi();
    stubImage(0, 0, new Error("EncodingError: 解码失败"));

    await expect(decodeImageElement(source)).rejects.toThrow(/图片解码失败（EncodingError: 解码失败）/);

    expect(url.revokeObjectURL.mock.calls).toEqual([[OBJECT_URL]]);
  });

  it("尺寸为 0 时自己回收 URL 并抛错（不把 0×0 交给调用方）", async () => {
    const url = stubUrlApi();
    stubImage(0, 3000);

    await expect(decodeImageElement(source)).rejects.toThrow("图片尺寸为 0，可能是不支持的格式或文件已损坏");

    expect(url.revokeObjectURL.mock.calls).toEqual([[OBJECT_URL]]);
  });
});
