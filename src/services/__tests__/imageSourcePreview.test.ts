import { afterEach, describe, expect, it, vi } from "vitest";
import { PREVIEW_MAX_EDGE, loadImageSource } from "@/services/imageSource";

/**
 * 预览解码的成功路径在 happy-dom 里**不可能达成**（`fetch` 拒绝 `blob:`，`<img>` 永不 load、
 * `naturalWidth` 恒 0，见 B1 构建记录 §4 第 4 条），所以这里只替换**平台边界**
 * （`Image` / `URL` / `document`），断言落在外部可观察量上：
 * 原图尺寸的读数、预览画布的尺寸、交给 `drawImage` 的参数、以及 object URL 是否回收。
 * 真实解码由浏览器人工流程覆盖（规格 §10.2）。
 *
 * 本文件不挂载 Vue 组件，因此可以整体替换 `document`；挂载类用例（任务 10/11）只能 spy
 * `document.createElement`，否则 `@vue/test-utils` 会崩（账本 B2）。
 */

interface FakeCanvas {
  width: number;
  height: number;
  readonly ctx: {
    drawImage: ReturnType<typeof vi.fn>;
    imageSmoothingEnabled: boolean;
    imageSmoothingQuality: string;
  };
}

function stubCanvas(contextAvailable = true): FakeCanvas[] {
  const canvases: FakeCanvas[] = [];
  class FakeCanvasImpl implements FakeCanvas {
    width = 0;
    height = 0;
    readonly ctx = {
      drawImage: vi.fn(),
      imageSmoothingEnabled: false,
      imageSmoothingQuality: "low",
    };
    getContext(kind: string): FakeCanvas["ctx"] | null {
      return kind === "2d" && contextAvailable ? this.ctx : null;
    }
  }
  vi.stubGlobal("document", {
    createElement: (tag: string) => {
      expect(tag).toBe("canvas");
      const canvas = new FakeCanvasImpl();
      canvases.push(canvas);
      return canvas;
    },
  });
  return canvases;
}

function stubImage(naturalWidth: number, naturalHeight: number, decodeError?: string): void {
  const decode = vi.fn(async () => {
    if (decodeError !== undefined) throw new Error(decodeError);
  });
  class FakeImage {
    readonly naturalWidth = naturalWidth;
    readonly naturalHeight = naturalHeight;
    src = "";
    readonly decode = decode;
  }
  vi.stubGlobal("Image", FakeImage);
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => "blob:fake"),
    revokeObjectURL: vi.fn(),
  });
}

const FILE = new File([new Uint8Array([1, 2, 3, 4])], "小猫照片.png", { type: "image/png" });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("loadImageSource", () => {
  it("4000×3000 的原图缩到长边 1600，并交出原图尺寸与来源信息", async () => {
    stubImage(4000, 3000);
    const canvases = stubCanvas();

    const loaded = await loadImageSource(FILE);

    expect(loaded.sourceSize).toEqual({ width: 4000, height: 3000 });
    expect(loaded.blob).toBe(FILE);
    expect(loaded.type).toBe("image/png");
    expect(loaded.name).toBe("小猫照片.png");
    expect(canvases).toHaveLength(1);
    expect(canvases[0]?.width).toBe(1600);
    expect(canvases[0]?.height).toBe(1200);
    // 参数顺序写全：把 (0,0) 或目标尺寸写错都会红。
    expect(canvases[0]?.ctx.drawImage.mock.calls[0]?.slice(1)).toEqual([0, 0, 1600, 1200]);
    // 平滑开关为 false 时 `imageSmoothingQuality = "high"` 是死代码，预览会退化成最近邻。
    expect(canvases[0]?.ctx.imageSmoothingEnabled).toBe(true);
    expect(canvases[0]?.ctx.imageSmoothingQuality).toBe("high");
    expect(loaded.preview).toBe(canvases[0]);
  });

  // 这条专打「无条件按 PREVIEW_MAX_EDGE 缩放」的实现：800×600 被"放大"到 1600×1200
  // 会白烧内存，还引入一次没有任何信息的重采样。
  it("原图长边小于上限时只缩不放", async () => {
    stubImage(800, 600);
    const canvases = stubCanvas();

    const loaded = await loadImageSource(FILE);

    expect(canvases[0]?.width).toBe(800);
    expect(canvases[0]?.height).toBe(600);
    expect(canvases[0]?.ctx.drawImage.mock.calls[0]?.slice(1)).toEqual([0, 0, 800, 600]);
    expect(loaded.sourceSize).toEqual({ width: 800, height: 600 });
  });

  it("长边恰好等于上限时不缩放", async () => {
    stubImage(PREVIEW_MAX_EDGE, 800);
    const canvases = stubCanvas();

    await loadImageSource(FILE);

    expect(canvases[0]?.width).toBe(PREVIEW_MAX_EDGE);
    expect(canvases[0]?.height).toBe(800);
  });

  it("长边超过上限 1 像素时缩到上限", async () => {
    stubImage(PREVIEW_MAX_EDGE + 1, 800);
    const canvases = stubCanvas();

    await loadImageSource(FILE);

    expect(canvases[0]?.width).toBe(PREVIEW_MAX_EDGE);
    expect(canvases[0]?.height).toBe(800);
  });

  it("竖构图（高为长边）同样按长边缩放，不出现宽高对调", async () => {
    stubImage(600, 4000);
    const canvases = stubCanvas();

    await loadImageSource(FILE);

    // 600×4000：长边是高轴 → 0.4 倍 → 240×1600（写死数值，免得跟随实现的算式变成同义反复）。
    expect(canvases[0]?.width).toBe(240);
    expect(canvases[0]?.height).toBe(1600);
    expect(canvases[0]?.ctx.drawImage.mock.calls[0]?.slice(1)).toEqual([0, 0, 240, 1600]);
  });

  it("极窄原图（1×4000）不会产出 0 宽的画布", async () => {
    stubImage(1, 4000);
    const canvases = stubCanvas();

    await loadImageSource(FILE);

    // round(1 × 0.4) = 0：少了 Math.max(1, …) 就会拿到一张 0 宽的画布（画不出任何东西）。
    expect(canvases[0]?.width).toBe(1);
    expect(canvases[0]?.height).toBe(1600);
    expect(canvases[0]?.ctx.drawImage.mock.calls[0]?.slice(1)).toEqual([0, 0, 1, 1600]);
  });

  it("解码失败时抛出带中文前缀的原因，不静默返回空预览", async () => {
    stubImage(0, 0, "unsupported");
    stubCanvas();

    await expect(loadImageSource(FILE)).rejects.toThrow(/图片解码失败（unsupported）/);
  });

  it("解码成功但尺寸为 0（happy-dom 的典型症状）时明确报错", async () => {
    stubImage(0, 0);
    stubCanvas();

    await expect(loadImageSource(FILE)).rejects.toThrow(/图片尺寸为 0/);
  });

  it("拿不到 2D 上下文时抛错（没有预览就没法选选区）", async () => {
    stubImage(800, 600);
    stubCanvas(false);

    await expect(loadImageSource(FILE)).rejects.toThrow(/2D 绘图上下文/);
  });

  it("空文件直接拒绝（与 fileFromInput 同口径，不等到解码）", async () => {
    stubImage(800, 600);
    const canvases = stubCanvas();

    await expect(loadImageSource(new File([], "empty.png", { type: "image/png" }))).rejects.toThrow(
      /这个文件是空的/,
    );
    // 校验必须发生在任何写操作之前：连预览画布都不该建出来。
    expect(canvases).toHaveLength(0);
  });

  it("拿不到 File 时立即拒绝（入口校验，不去碰解码）", async () => {
    stubImage(800, 600);
    const canvases = stubCanvas();

    await expect(loadImageSource(null as unknown as File)).rejects.toThrow(/需要一个图片文件/);
    expect(canvases).toHaveLength(0);
  });

  it("用完即释放 object URL（否则每选一张图就泄一个 blob URL）", async () => {
    stubImage(800, 600);
    stubCanvas();
    const revoke = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:fake"), revokeObjectURL: revoke });

    await loadImageSource(FILE);

    // 调用清单而非「被调用过」：多回收一次（双重 revoke）也要抓出来。
    expect(revoke.mock.calls).toEqual([["blob:fake"]]);
  });

  // 解码失败时 `decodeImageElement` 自己回收 URL，这层包装不该把它漏掉；同时页面上必须
  // 读得懂失败原因（与 probeImageSize 同一口径，两条路径共用同一份实现）。
  it("解码失败时同样不泄漏 object URL", async () => {
    stubImage(0, 0, "unsupported");
    stubCanvas();
    const revoke = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:fake"), revokeObjectURL: revoke });

    await expect(loadImageSource(FILE)).rejects.toThrow(/图片解码失败/);

    expect(revoke.mock.calls).toEqual([["blob:fake"]]);
  });
});
