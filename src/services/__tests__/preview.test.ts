import { afterEach, describe, expect, it, vi } from "vitest";
import type { RgbaImage, SampledGrid } from "@/core/image/types";
import { GRID_CELL_PREVIEW_PX, RAW_PREVIEW_MAX_EDGE, renderGridPreview, renderRawPreview } from "@/services/preview";

/**
 * `preview.ts` 的**直接**单元测试。
 *
 * 为什么必须存在（账本「任务 6 延后 Minor」第 1 条）：组件用例（`DecodeLabPage.test.ts`）
 * 里的假 2D 上下文把 `putImageData` 写成空 mock、`createImageData` 返回全零缓冲，用例只断言
 * 调用次数与来源画布尺寸。于是 preview.ts 里三种写错方式**全都不会红**：
 *   ① 通道次序写错（R/B 互换）；
 *   ② `filled === 1 ? 255 : 0` 取反（主对比图整幅变成负片 alpha）；
 *   ③ `drawImage` 丢掉后两个实参（29² 只画在 464² 画布的左上角，其余留白）。
 * 而这三者都会让人眼看到的图与 ΔRGB 数字互相矛盾。这里直接读 `putImageData` 收到的
 * ImageData 缓冲与 `drawImage` 的实参，把三者逐条钉住。
 */

interface FakeContext {
  imageSmoothingEnabled: boolean;
  createImageData: (width: number, height: number) => ImageData;
  putImageData: ReturnType<typeof vi.fn>;
  drawImage: ReturnType<typeof vi.fn>;
}

interface FakeCanvas {
  readonly id: number;
  width: number;
  height: number;
  readonly ctx: FakeContext;
  readonly drawnFrom: FakeCanvas[];
  readonly toDataURL: ReturnType<typeof vi.fn>;
  getContext(kind: string): FakeContext | null;
}

let seq = 0;

/** 假 `document.createElement("canvas")`：真分配 ImageData 缓冲，其余标签透传。 */
function stubCanvasElement(): FakeCanvas[] {
  const instances: FakeCanvas[] = [];
  class Canvas implements FakeCanvas {
    readonly id = (seq += 1);
    width = 0;
    height = 0;
    readonly drawnFrom: FakeCanvas[] = [];
    readonly toDataURL = vi.fn(() => `data:image/png;base64,canvas-${this.id}`);
    readonly ctx: FakeContext = {
      imageSmoothingEnabled: true,
      createImageData: (width: number, height: number) =>
        ({
          width,
          height,
          // happy-dom 有 ImageData，这里直接用真构造器，data 是真实可读的缓冲
          data: new Uint8ClampedArray(width * height * 4),
        }) as unknown as ImageData,
      putImageData: vi.fn(),
      drawImage: vi.fn((source: FakeCanvas, ...rest: number[]) => {
        this.drawnFrom.push(source);
        void rest;
      }),
    };

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
      const canvas = new Canvas();
      instances.push(canvas);
      return canvas;
    }
    return original(tag, options);
  }) as typeof document.createElement);

  return instances;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 2×1 网格：红实心 + 绿空格。刻意选不对称的通道值，R/B 互换会立刻显形。 */
function twoCellGrid(): SampledGrid {
  return {
    width: 2,
    height: 1,
    rgb: new Float32Array([10, 20, 30, 200, 100, 50]),
    filled: new Uint8Array([1, 0]),
  };
}

describe("renderGridPreview", () => {
  it("写入格画布的 RGBA 逐格精确：通道次序、取整、空格 alpha=0", () => {
    const canvases = stubCanvasElement();
    const url = renderGridPreview(twoCellGrid());

    // 第 1 张画布是格画布（每格 1 px），第 2 张是放大后的预览
    const cellCanvas = canvases[0];
    expect(cellCanvas?.width).toBe(2);
    expect(cellCanvas?.height).toBe(1);
    expect(cellCanvas?.ctx.putImageData).toHaveBeenCalledTimes(1);

    const written = cellCanvas?.ctx.putImageData.mock.calls[0]?.[0] as { data: Uint8ClampedArray };
    // 逐格期望写死为字面量：R=10 G=20 B=30 A=255（实心）、R=200 G=100 B=50 A=0（空格）。
    // R/B 互换 → [30,20,10] 与前两个数对不上；alpha 规则取反 → 第一格 0、第二格 255。
    expect(Array.from(written.data)).toEqual([10, 20, 30, 255, 200, 100, 50, 0]);
    // 取整语义：1.6 → 2（不是截断成 1）
    const rounding = stubCanvasElement();
    renderGridPreview({ width: 1, height: 1, rgb: new Float32Array([1.6, 2.4, 3.5]), filled: new Uint8Array([1]) });
    const cell2 = rounding[0]?.ctx.putImageData.mock.calls[0]?.[0] as { data: Uint8ClampedArray };
    expect(Array.from(cell2.data)).toEqual([2, 2, 4, 255]);
    expect(url).toBe(`data:image/png;base64,canvas-${canvases[1]?.id}`);
  });

  it("预览画布 = 格数 × 每格像素，最近邻放大，drawImage 收到完整目标矩形", () => {
    const canvases = stubCanvasElement();
    renderGridPreview(twoCellGrid());

    const preview = canvases[1];
    expect(preview?.width).toBe(2 * GRID_CELL_PREVIEW_PX);
    expect(preview?.height).toBe(1 * GRID_CELL_PREVIEW_PX);
    expect(preview?.ctx.imageSmoothingEnabled).toBe(false);
    // 丢掉后两个实参时这里收到的就是 2 个参数（账本点名的那种静默降级）
    expect(preview?.ctx.drawImage.mock.calls[0]).toEqual([
      canvases[0],
      0,
      0,
      2 * GRID_CELL_PREVIEW_PX,
      1 * GRID_CELL_PREVIEW_PX,
    ]);
  });

  it("自定义每格像素数同样传到画布尺寸与 drawImage", () => {
    const canvases = stubCanvasElement();
    renderGridPreview(twoCellGrid(), 8);
    const preview = canvases[1];
    expect([preview?.width, preview?.height]).toEqual([16, 8]);
    expect(preview?.ctx.drawImage.mock.calls[0]).toEqual([canvases[0], 0, 0, 16, 8]);
  });
});

describe("renderRawPreview", () => {
  it("按原生像素 1:1 建画布，把位图字节原样拷进 ImageData（不缩放、不重排）", () => {
    const canvases = stubCanvasElement();
    const image: RgbaImage = {
      width: 2,
      height: 2,
      data: new Uint8ClampedArray([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]),
    };
    const url = renderRawPreview(image);

    const canvas = canvases[0];
    expect([canvas?.width, canvas?.height]).toEqual([2, 2]);
    expect(canvas?.ctx.drawImage).not.toHaveBeenCalled();
    const written = canvas?.ctx.putImageData.mock.calls[0]?.[0] as { data: Uint8ClampedArray };
    expect(Array.from(written.data)).toEqual(Array.from(image.data));
    expect(url).toBe(`data:image/png;base64,canvas-${canvas?.id}`);
  });
});

describe("上限常量与页面共用", () => {
  it("RAW_PREVIEW_MAX_EDGE 是 1600，与全局约束「预览解码位图长边 ≤ 1600」一致", () => {
    expect(RAW_PREVIEW_MAX_EDGE).toBe(1600);
    expect(GRID_CELL_PREVIEW_PX).toBe(16);
  });
});
