import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { resampleToGrid } from "@/core/image/resample";
import type { RgbaImage, SampledGrid } from "@/core/image/types";
import { GRID_CELL_PREVIEW_PX, RAW_PREVIEW_MAX_EDGE } from "@/services/preview";
import DecodeLabPage from "@/views/DecodeLabPage.vue";

/**
 * 实验台的组件用例。
 *
 * 为什么必须存在：审查 I1 的藏身处就是「页面自己零覆盖」，而第 2 轮又把主对比从**中间位图**
 * 换成了**29×29 豆格**（信息对等），并新增了「116² 首段滤波差异」这组回答 R1 的数字——
 * 这些都是决定 R1 怎么判的逻辑，必须有断言钉住。
 *
 * 平台 API（`createImageBitmap` / `OffscreenCanvas` / `Image` / `URL` / `document.createElement("canvas")`）
 * 全部换成**假实现**驱动页面，没有调用任何真实平台 API。
 */

const FILE = new File([new Uint8Array([1, 2, 3])], "photo.png", { type: "image/png" });

const CELLS = 29;
const STAGE_CELLS = 116;
const COMPARISON_LONG_EDGE = CELLS * GRID_CELL_PREVIEW_PX; // 464

// ---------------------------------------------------------------------------
// 合成测试图与「平台缩放」仿真
// ---------------------------------------------------------------------------

/**
 * 造一张高对比度合成图：左半 4px 棋盘格（细结构，最容易被滤波器吃掉）、
 * 右半渐变 + 每 37 px 一条 3 px 硬竖边（宽硬边，两段式与一段式的差异在这里最明显）。
 * 组件用例只需要「有硬边和细结构」，具体形状不影响断言。
 */
function makeSyntheticSource(width: number, height: number): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      let r: number;
      let g: number;
      let b: number;
      if (x < width / 2) {
        const on = (Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 0;
        r = on ? 255 : 0;
        g = on ? 255 : 0;
        b = on ? 255 : 0;
      } else if (x % 37 < 3) {
        r = 255;
        g = 0;
        b = 0;
      } else {
        const v = Math.round(((x - width / 2) / (width / 2)) * 255);
        r = v;
        g = 255 - v;
        b = 128;
      }
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

function cropImage(image: RgbaImage, sx: number, sy: number, sw: number, sh: number): RgbaImage {
  const data = new Uint8ClampedArray(sw * sh * 4);
  for (let y = 0; y < sh; y += 1) {
    const from = ((sy + y) * image.width + sx) * 4;
    data.set(image.data.subarray(from, from + sw * 4), y * sw * 4);
  }
  return { width: sw, height: sh, data };
}

/** 网格 → 位图（8 位量化，空格透明），与 preview.ts 的取整规则一致。 */
function gridToImage(grid: SampledGrid): RgbaImage {
  const data = new Uint8ClampedArray(grid.width * grid.height * 4);
  for (let i = 0; i < grid.width * grid.height; i += 1) {
    data[i * 4] = Math.round(grid.rgb[i * 3]);
    data[i * 4 + 1] = Math.round(grid.rgb[i * 3 + 1]);
    data[i * 4 + 2] = Math.round(grid.rgb[i * 3 + 2]);
    data[i * 4 + 3] = grid.filled[i] === 1 ? 255 : 0;
  }
  return { width: grid.width, height: grid.height, data };
}

/**
 * 仿真平台缩放。`"box"` = 理想的面积平均滤波器（Skia 做对了的样子，用 core 的
 * `resampleToGrid` 实现）；`"nearest"` = 偷工减料的最近邻抽点。
 */
function resizeImage(
  image: RgbaImage,
  width: number,
  height: number,
  mode: "box" | "nearest",
): RgbaImage {
  if (mode === "box") return gridToImage(resampleToGrid(image, width, height));
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(image.width - 1, Math.floor((x * image.width) / width));
      const sy = Math.min(image.height - 1, Math.floor((y * image.height) / height));
      const from = (sy * image.width + sx) * 4;
      data.set(image.data.subarray(from, from + 4), (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

// ---------------------------------------------------------------------------
// 假平台
// ---------------------------------------------------------------------------

interface FakeElementContext {
  imageSmoothingEnabled: boolean;
  createImageData: ReturnType<typeof vi.fn>;
  putImageData: ReturnType<typeof vi.fn>;
  drawImage: ReturnType<typeof vi.fn>;
}

interface FakeCanvasElement {
  readonly id: number;
  width: number;
  height: number;
  readonly ctx: FakeElementContext;
  /** 被 drawImage 画进来的来源画布（用来证明「对比视图来自 29×29 格画布」）。 */
  readonly drawnFrom: FakeCanvasElement[];
  /** 返回值是这张画布的专属 data URL，用例据此把 DOM 里的 `<img>` 映射回画布实例。 */
  readonly toDataURL: Mock<() => string>;
  getContext(kind: string): FakeElementContext | null;
}

let canvasSeq = 0;

/** 把 `document.createElement("canvas")` 换成假画布，其余标签原样透传（Vue 自己要用）。 */
function stubCanvasElement(): FakeCanvasElement[] {
  const instances: FakeCanvasElement[] = [];
  class FakeCanvas implements FakeCanvasElement {
    readonly id = (canvasSeq += 1);
    width = 0;
    height = 0;
    readonly drawnFrom: FakeCanvasElement[] = [];
    readonly toDataURL = vi.fn(() => `data:image/png;base64,canvas-${this.id}`);
    readonly ctx: FakeElementContext = {
      imageSmoothingEnabled: true,
      createImageData: vi.fn((width: number, height: number) => ({
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4),
      })),
      putImageData: vi.fn(),
      drawImage: vi.fn((source: FakeCanvasElement) => {
        this.drawnFrom.push(source);
      }),
    };

    getContext(kind: string): FakeElementContext | null {
      return kind === "2d" ? this.ctx : null;
    }
  }

  const original = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((
    tag: string,
    options?: ElementCreationOptions,
  ) => {
    if (tag === "canvas") {
      const canvas = new FakeCanvas();
      instances.push(canvas);
      return canvas;
    }
    return original(tag, options);
  }) as typeof document.createElement);

  return instances;
}

/** readPixels 走 OffscreenCanvas：把 drawImage 进来的位图像素原样交给 getImageData。 */
function stubOffscreenCanvas(): void {
  class FakeOffscreenCanvas {
    readonly width: number;
    readonly height: number;
    private drawn: Uint8ClampedArray | null = null;
    readonly ctx = {
      imageSmoothingEnabled: false,
      drawImage: vi.fn((source: { pixels?: Uint8ClampedArray }) => {
        this.drawn = source.pixels ?? null;
      }),
      getImageData: vi.fn((_x: number, _y: number, width: number, height: number) => {
        const expected = width * height * 4;
        return {
          width,
          height,
          data:
            this.drawn !== null && this.drawn.length === expected
              ? this.drawn
              : new Uint8ClampedArray(expected),
        };
      }),
    };

    constructor(width: number, height: number) {
      this.width = width;
      this.height = height;
    }

    getContext(kind: string): typeof this.ctx | null {
      return kind === "2d" ? this.ctx : null;
    }
  }
  vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
}

interface BitmapStubOptions {
  readonly source: RgbaImage;
  /** 平台缩放仿真的模式：理想面积平均 or 最近邻抽点。 */
  readonly mode: "box" | "nearest";
  /** 第几次调用抛错（1 起数）；不传则永不抛错。 */
  readonly failOnCall?: number;
}

/** 假 `createImageBitmap`：真裁剪、按 `resizeWidth` 真缩放，像素来自合成图。 */
function stubBitmapApi(options: BitmapStubOptions) {
  let calls = 0;
  const createBitmap = vi.fn(
    async (
      _source: Blob,
      sx: number,
      sy: number,
      sw: number,
      sh: number,
      resizeOptions?: { resizeWidth?: number; resizeHeight?: number },
    ) => {
      calls += 1;
      if (options.failOnCall === calls) throw new Error("假平台：解码失败");
      const cropped = cropImage(options.source, sx, sy, sw, sh);
      const target =
        resizeOptions?.resizeWidth !== undefined
          ? resizeImage(
              cropped,
              resizeOptions.resizeWidth,
              resizeOptions.resizeHeight ?? sh,
              options.mode,
            )
          : cropped;
      return {
        width: target.width,
        height: target.height,
        pixels: target.data,
        close: vi.fn(),
      };
    },
  );
  vi.stubGlobal("createImageBitmap", createBitmap);
  return createBitmap;
}

/** 探针用 `<img>` 拿尺寸；默认 1500×1500 → 裁剪边长 750、快路径目标 116。 */
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

async function waitForText(wrapper: ReturnType<typeof mount>, text: string): Promise<void> {
  await vi.waitFor(() => {
    expect(wrapper.text()).toContain(text);
  });
}

function canvasByUrl(canvases: FakeCanvasElement[], url: string | undefined) {
  return canvases.find((canvas) => canvas.toDataURL() === url);
}

/** 从「最大 ΔRGB 12.34」这类展示文本里取数字（页面格式是 toFixed(2)）。 */
function readMaxDelta(text: string): number {
  const match = /最大 ΔRGB ([\d.]+)/.exec(text);
  if (match === null) throw new Error(`展示文本里找不到「最大 ΔRGB」：${text}`);
  return Number(match[1]);
}

/** 一个完整的实验台运行环境（合成图 + 假平台 + 假画布）。 */
function setupLab(options: { mode?: "box" | "nearest"; failOnCall?: number } = {}) {
  const source = makeSyntheticSource(1500, 1500);
  stubImage(1500, 1500);
  stubBitmapApi({ source, mode: options.mode ?? "box", failOnCall: options.failOnCall });
  stubOffscreenCanvas();
  return { canvases: stubCanvasElement(), source };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("主对比视图来自 29×29 豆格（第 2 轮 I1）", () => {
  it("两侧对比视图都是 464²，且由各自的 29×29 格画布按同一倍率最近邻放大", async () => {
    const { canvases } = setupLab();
    const wrapper = mount(DecodeLabPage);
    await runLab(wrapper);
    await waitForText(wrapper, "116² 首段滤波差异");

    const comparisonViews = wrapper.findAll('[data-testid="comparison-view"] img');
    expect(comparisonViews).toHaveLength(2);

    for (const view of comparisonViews) {
      const canvas = canvasByUrl(canvases, view.attributes("src"));
      expect(canvas).toBeDefined();
      // 对比视图长边 = 29 格 × 16 px
      expect(canvas?.width).toBe(COMPARISON_LONG_EDGE);
      expect(canvas?.height).toBe(COMPARISON_LONG_EDGE);
      // 它的数据来源必须是一张 29×29 的格画布（而不是 116² / 750² 的中间位图）
      expect(canvas?.drawnFrom).toHaveLength(1);
      const cellCanvas = canvas?.drawnFrom[0];
      expect([cellCanvas?.width, cellCanvas?.height]).toEqual([CELLS, CELLS]);
      expect(cellCanvas?.ctx.putImageData).toHaveBeenCalledTimes(1);
      // 放大必须用最近邻，否则格子边界会糊
      expect(canvas?.ctx.imageSmoothingEnabled).toBe(false);
    }

    // 两侧倍率完全相同
    const [left, right] = comparisonViews;
    expect(canvasByUrl(canvases, left?.attributes("src"))?.width).toBe(
      canvasByUrl(canvases, right?.attributes("src"))?.width,
    );
    expect(canvasByUrl(canvases, left?.attributes("src"))?.height).toBe(
      canvasByUrl(canvases, right?.attributes("src"))?.height,
    );

    wrapper.unmount();
  });

  it("原始解码输出视图按各自原生像素 1:1 渲染，不做归一化", async () => {
    const { canvases } = setupLab();
    const wrapper = mount(DecodeLabPage);
    await runLab(wrapper);
    await waitForText(wrapper, "116² 首段滤波差异");

    const rawViews = wrapper.findAll('[data-testid="raw-view"] img');
    expect(rawViews).toHaveLength(2);

    const sizes = rawViews.map((view) => {
      const canvas = canvasByUrl(canvases, view.attributes("src"));
      return [canvas?.width, canvas?.height];
    });
    // 快路径 116²（Skia 的目标尺寸）、保底路径 750²（裁剪原生尺寸），都不等于对比视图长边
    expect(sizes).toEqual([
      [STAGE_CELLS, STAGE_CELLS],
      [750, 750],
    ]);
    for (const view of rawViews) {
      const canvas = canvasByUrl(canvases, view.attributes("src"));
      // 诊断视图不缩放：没有 drawImage 出来的来源画布
      expect(canvas?.drawnFrom).toEqual([]);
    }

    wrapper.unmount();
  });
});

describe("116² 首段滤波差异（第 2 轮 I2）", () => {
  it("理想面积平均的平台缩放：首段差异只剩 8 位量化，而成品差异明显更大", async () => {
    setupLab({ mode: "box" });
    const wrapper = mount(DecodeLabPage);
    await runLab(wrapper);
    await waitForText(wrapper, "116² 首段滤波差异");

    const stageText = wrapper.find('[data-testid="stage-delta"]').text();
    const productText = wrapper.find('[data-testid="product-delta"]').text();
    const stageMax = readMaxDelta(stageText);
    const productMax = readMaxDelta(productText);

    // 快路径的 116² 就是用同一个面积平均算的（再量化到 8 位），所以首段差异只在量化误差量级
    expect(stageMax).toBeLessThanOrEqual(1);
    // 两段式 Box(4) 后再降采样 ≠ 一次直接降采样，成品差异是真实存在的
    expect(productMax).toBeGreaterThan(1);
    expect(stageMax).toBeLessThan(productMax);

    // 两组数字必须分别标注，不能混在一起
    expect(stageText).toContain("回答 R1");
    expect(productText).toContain("两段式 vs 一段式");

    wrapper.unmount();
  });

  it("最近邻抽点的平台缩放：首段差异立刻跳到阈值量级（仪器能分辨坏滤波）", async () => {
    setupLab({ mode: "nearest" });
    const wrapper = mount(DecodeLabPage);
    await runLab(wrapper);
    await waitForText(wrapper, "116² 首段滤波差异");

    const stageText = wrapper.find('[data-testid="stage-delta"]').text();
    expect(readMaxDelta(stageText)).toBeGreaterThan(10);

    wrapper.unmount();
  });

  it("只有一条路径成功时两组差异都不显示（而不是显示 0）", async () => {
    setupLab({ failOnCall: 2 });
    const wrapper = mount(DecodeLabPage);
    await runLab(wrapper);
    await waitForText(wrapper, "对比不完整");

    expect(wrapper.find('[data-testid="stage-delta"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="product-delta"]').exists()).toBe(false);
    // 页面上不应出现任何 0 值的差异数字
    expect(wrapper.text()).not.toContain("最大 ΔRGB");

    wrapper.unmount();
  });
});

describe("实验台的其它行为", () => {
  it("超大原生输出不渲染 1:1 诊断视图（避免预览内存污染 OOM 归因）", async () => {
    // 3240×3240 → 裁剪边长 1620 > RAW_PREVIEW_MAX_EDGE
    const big: RgbaImage = {
      width: 3240,
      height: 3240,
      data: new Uint8ClampedArray(3240 * 3240 * 4),
    };
    big.data.fill(128);
    stubImage(3240, 3240);
    stubBitmapApi({ source: big, mode: "box" });
    stubOffscreenCanvas();
    const canvases = stubCanvasElement();

    const wrapper = mount(DecodeLabPage);
    await runLab(wrapper);
    await waitForText(wrapper, "116² 首段滤波差异");

    const rawViews = wrapper.findAll('[data-testid="raw-view"]');
    expect(rawViews).toHaveLength(2);
    // 快路径的原生输出只有 116²，照常渲染；保底路径的 1620² 超过上限，不渲染
    expect(wrapper.findAll('[data-testid="raw-view"] img')).toHaveLength(1);
    const capped = rawViews.filter((view) => !view.find("img").exists());
    expect(capped).toHaveLength(1);
    expect(capped[0]?.text()).toContain(String(RAW_PREVIEW_MAX_EDGE));
    // 那张 1620² 的巨画布从未被创建
    expect(
      canvases.every((canvas) => Math.max(canvas.width, canvas.height) <= RAW_PREVIEW_MAX_EDGE),
    ).toBe(true);
    // 对比视图与差异数字不受影响
    expect(wrapper.findAll('[data-testid="comparison-view"] img')).toHaveLength(2);
    const comparisonCanvases = canvases.filter((canvas) => canvas.drawnFrom.length === 1);
    expect(comparisonCanvases).toHaveLength(2);
    for (const canvas of comparisonCanvases) {
      expect(Math.max(canvas.width, canvas.height)).toBe(COMPARISON_LONG_EDGE);
    }

    wrapper.unmount();
  });

  it("两条路径都成功时不出现「对比不完整」，且耗时写明包含成品重采样", async () => {
    setupLab();
    const wrapper = mount(DecodeLabPage);
    await runLab(wrapper);
    await waitForText(wrapper, "116² 首段滤波差异");

    expect(wrapper.find('[data-testid="incomplete-note"]').exists()).toBe(false);
    expect(wrapper.findAll('[data-testid="path-result"]')).toHaveLength(2);
    expect(wrapper.text()).toContain("解码 + 成品重采样");

    wrapper.unmount();
  });

  it("原生长边恰等于 RAW_PREVIEW_MAX_EDGE 时照常渲染（上限是闭区间）", async () => {
    // 3200×3200 → 裁剪边长 round(3200 × 0.5) = 1600，**恰好压在上限上**。
    // 账本「任务 6 延后 Minor」第 3 条：原来的用例只覆盖了 1620 > 1600 那一侧，
    // 判据若被写成 `<`（开区间），这张 1600² 的 1:1 诊断视图会静默消失、而所有既有断言
    // 仍然全绿。这条钉住 `<=` 的闭区间语义（改成 `<` 时它会红）。
    const side = RAW_PREVIEW_MAX_EDGE;
    const big: RgbaImage = {
      width: side * 2,
      height: side * 2,
      data: new Uint8ClampedArray(side * 2 * side * 2 * 4),
    };
    big.data.fill(128);
    stubImage(side * 2, side * 2);
    stubBitmapApi({ source: big, mode: "box" });
    stubOffscreenCanvas();
    const canvases = stubCanvasElement();

    const wrapper = mount(DecodeLabPage);
    await runLab(wrapper);
    await waitForText(wrapper, "116² 首段滤波差异");

    // 快路径 116²、保底路径 1600²（== 上限），两侧都渲染
    const rawViews = wrapper.findAll('[data-testid="raw-view"]');
    expect(rawViews).toHaveLength(2);
    expect(wrapper.findAll('[data-testid="raw-view"] img')).toHaveLength(2);
    expect(rawViews.filter((view) => !view.find("img").exists())).toHaveLength(0);
    const sizes = wrapper
      .findAll('[data-testid="raw-view"] img')
      .map((view) => {
        const canvas = canvasByUrl(canvases, view.attributes("src"));
        return [canvas?.width, canvas?.height];
      });
    expect(sizes).toEqual([
      [STAGE_CELLS, STAGE_CELLS],
      [side, side],
    ]);
    // 那张 1600² 的原生画布确实被创建了（不是被上限拦掉后从别处凑出来的尺寸）
    expect(canvases.some((canvas) => canvas.width === side && canvas.height === side)).toBe(true);

    wrapper.unmount();
  });
});
