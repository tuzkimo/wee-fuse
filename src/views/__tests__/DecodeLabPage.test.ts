import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PREVIEW_LONG_EDGE } from "@/services/preview";
import DecodeLabPage from "@/views/DecodeLabPage.vue";

/**
 * 实验台的组件用例。
 *
 * 为什么必须存在：审查 I1 的藏身处就是「页面自己零覆盖」——`imageToCanvas(image, 4)` 会把保底路径的
 * **原生裁剪像素**（1500²）放大 4 倍建 6000² 的画布，而快路径只有 116²×4 = 464²。两侧进入屏幕时的
 * 缩放比因此差一两个数量级，「哪边更糊」里掺进了与 Skia 滤波质量无关的显示假象——而 R1 的结论
 * 正是靠人眼比较两侧清晰度得出的。这条断言就是钉住这个缺陷的钉子。
 *
 * happy-dom 的 `canvas.getContext("2d")` 在没有 canvasAdapter 时返回 null，但页面用的平台 API
 * 都可以用 `vi.stubGlobal` / `vi.spyOn` 换成假实现，所以组件是可以测的（此前的报告说「测不了」不准确）。
 * 注意：这里换掉的是**假实现**，不调用任何真实平台 API。
 */

const FILE = new File([new Uint8Array([1, 2, 3])], "photo.png", { type: "image/png" });

/** 假 2D 上下文：只记录调用，`getImageData` 按请求尺寸返回可辨认的像素。 */
function makeFakeContext(pixelBytes: number) {
  return {
    imageSmoothingEnabled: false,
    imageSmoothingQuality: "low",
    createImageData: vi.fn((width: number, height: number) => ({
      width,
      height,
      data: new Uint8ClampedArray(width * height * 4).fill(pixelBytes),
    })),
    putImageData: vi.fn(),
    drawImage: vi.fn(),
    getImageData: vi.fn((_x: number, _y: number, width: number, height: number) => ({
      width,
      height,
      data: new Uint8ClampedArray(width * height * 4).fill(pixelBytes),
    })),
  };
}

type FakeContext = ReturnType<typeof makeFakeContext>;

interface FakeCanvas {
  width: number;
  height: number;
  readonly ctx: FakeContext;
  /** 被调用过就说明这张画布是**预览画布**（源画布只 putImageData，不导出）。 */
  readonly toDataURL: ReturnType<typeof vi.fn>;
  getContext(kind: string): FakeContext | null;
}

/** 把 `document.createElement("canvas")` 换成假画布，其余标签原样透传（Vue 自己要用）。 */
function stubCanvasElement(): FakeCanvas[] {
  const instances: FakeCanvas[] = [];
  class FakeCanvasElement implements FakeCanvas {
    width = 0;
    height = 0;
    readonly ctx = makeFakeContext(7);
    readonly toDataURL = vi.fn(() => "data:image/png;base64,fake");

    getContext(kind: string): FakeContext | null {
      return kind === "2d" ? this.ctx : null;
    }
  }

  const original = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((
    tag: string,
    options?: ElementCreationOptions,
  ) => {
    if (tag === "canvas") {
      const canvas = new FakeCanvasElement();
      instances.push(canvas);
      return canvas;
    }
    return original(tag, options);
  }) as typeof document.createElement);

  return instances;
}

/** readPixels 走 OffscreenCanvas，这里也换成假的。 */
function stubOffscreenCanvas(): void {
  class FakeOffscreenCanvas {
    width: number;
    height: number;
    readonly ctx: FakeContext;

    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
      this.ctx = makeFakeContext(9);
    }

    getContext(kind: string): FakeContext | null {
      return kind === "2d" ? this.ctx : null;
    }
  }
  vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
}

interface BitmapStubOptions {
  /** 第几次调用抛错（1 起数）；不传则永不抛错。 */
  readonly failOnCall?: number;
}

/**
 * 假 `createImageBitmap`：按真实语义返回带尺寸的位图——
 * 带 `options.resizeWidth` 的调用返回目标尺寸（快路径），否则返回裁剪原生尺寸（保底路径）。
 */
function stubBitmapApi(options: BitmapStubOptions = {}) {
  let calls = 0;
  const createBitmap = vi.fn(
    async (
      _source: Blob,
      _sx: number,
      _sy: number,
      sw: number,
      sh: number,
      resizeOptions?: { resizeWidth?: number; resizeHeight?: number },
    ) => {
      calls += 1;
      if (options.failOnCall === calls) throw new Error("假平台：解码失败");
      if (resizeOptions?.resizeWidth !== undefined) {
        return {
          width: resizeOptions.resizeWidth,
          height: resizeOptions.resizeHeight ?? sh,
          close: vi.fn(),
        };
      }
      return { width: sw, height: sh, close: vi.fn() };
    },
  );
  vi.stubGlobal("createImageBitmap", createBitmap);
  return createBitmap;
}

/** 探针用 `<img>` 拿尺寸；这里固定成 1500×1500（原生裁剪边长 750，快路径目标 116）。 */
function stubImage(width = 1500, height = 1500): void {
  class FakeImage {
    readonly naturalWidth = width;
    readonly naturalHeight = height;
    src = "";
    readonly decode = vi.fn(async () => {});
  }
  vi.stubGlobal("Image", FakeImage);
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => "blob:fake"),
    revokeObjectURL: vi.fn(),
  });
}

/** 把文件塞进 `<input type="file">`（happy-dom 没有 DataTransfer，直接在实例上定义 files）。 */
function attachFile(input: HTMLInputElement, file: File): void {
  Object.defineProperty(input, "files", { value: [file], configurable: true });
}

async function runLab(wrapper: ReturnType<typeof mount>): Promise<void> {
  const input = wrapper.find('input[type="file"]').element as HTMLInputElement;
  attachFile(input, FILE);
  await wrapper.find("button").trigger("click");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("DecodeLabPage 的预览归一化（审查 I1）", () => {
  it("1500×1500 输入：快路径（116²）与保底路径（750² 原生）的预览画布长边都等于 PREVIEW_LONG_EDGE", async () => {
    stubImage(1500, 1500);
    stubBitmapApi();
    stubOffscreenCanvas();
    const canvases = stubCanvasElement();

    const wrapper = mount(DecodeLabPage);
    await runLab(wrapper);
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain("最大 ΔRGB");
    });

    const previews = canvases.filter((canvas) => canvas.toDataURL.mock.calls.length > 0);
    // 两条路径各一张预览画布
    expect(previews).toHaveLength(2);
    for (const preview of previews) {
      // 旧写法下保底路径是 750 × 4 = 3000（4000×3000 照片是 1500 × 4 = 6000），这条会红
      expect(Math.max(preview.width, preview.height)).toBe(PREVIEW_LONG_EDGE);
      expect(Math.max(preview.width, preview.height)).toBeLessThanOrEqual(PREVIEW_LONG_EDGE);
    }
    // 归一化的实质：两侧预览的内禀尺寸完全一致，屏幕上的缩放比才一致
    expect(previews[0]?.width).toBe(previews[1]?.width);
    expect(previews[0]?.height).toBe(previews[1]?.height);
    // 两侧共用同一个平滑设定（不使用最近邻，避免预览自己造出摩尔纹）
    expect(previews.map((preview) => preview.ctx.imageSmoothingEnabled)).toEqual([true, true]);

    wrapper.unmount();
  });
});

describe("DecodeLabPage 的对比完整性提示（审查 I3）", () => {
  it("只有一条路径成功时显示「对比不完整」，而不是留下一张图让人误读", async () => {
    stubImage(1500, 1500);
    // 第二次 createImageBitmap 抛错 → 快路径成功、保底路径失败
    stubBitmapApi({ failOnCall: 2 });
    stubOffscreenCanvas();
    stubCanvasElement();

    const wrapper = mount(DecodeLabPage);
    await runLab(wrapper);
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain("对比不完整");
    });

    expect(wrapper.text()).toContain("假平台：解码失败");
    // 页面只剩一张图，且这张图旁边有明确标注
    expect(wrapper.findAll("section")).toHaveLength(1);

    wrapper.unmount();
  });

  it("两条路径都成功时不出现「对比不完整」", async () => {
    stubImage(1500, 1500);
    stubBitmapApi();
    stubOffscreenCanvas();
    stubCanvasElement();

    const wrapper = mount(DecodeLabPage);
    await runLab(wrapper);
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain("最大 ΔRGB");
    });

    expect(wrapper.text()).not.toContain("对比不完整");
    expect(wrapper.findAll("section")).toHaveLength(3); // 两条路径 + ΔRGB 区块

    wrapper.unmount();
  });
});

describe("DecodeLabPage 的计时口径（审查 I3）", () => {
  it("耗时标注写明包含重采样", async () => {
    stubImage(1500, 1500);
    stubBitmapApi();
    stubOffscreenCanvas();
    stubCanvasElement();

    const wrapper = mount(DecodeLabPage);
    await runLab(wrapper);
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain("最大 ΔRGB");
    });

    // 保底路径的重采样是整条链路上最贵的一步，计时只包 decode 会让耗时系统性偏向它，
    // 因此标签必须明说口径包含重采样
    expect(wrapper.text()).toContain("解码 + 重采样");

    wrapper.unmount();
  });
});
