import { describe, expect, it, vi } from "vitest";
import { loadPalette } from "@/core/palette/registry";
import {
  LIVE_PREVIEW_MAX_LONG_SIDE,
  renderLivePreview,
  type LivePreviewRequest,
} from "../livePreview";

/**
 * 实时预览的输入侧（规格 §5.4）：把「原图坐标上的裁剪框 + 一张已解码的预览位图」换成一张**小网格**
 * 图纸。这里断言的是**裁对了哪块像素 / 网格多大 / 什么时候安静地画不出来**——量化本身的用例在
 * `pipeline.test.ts`（两条路共用 `patternFromPixels`）。
 */

const PALETTE = loadPalette({
  id: "fake",
  name: "测试色卡",
  source: "https://example.com",
  accuracy: "仅测试用",
  colors: [
    { code: "A1", hex: "#ff0000" },
    { code: "A2", hex: "#0000ff" },
  ],
});

interface FakePreview {
  readonly canvas: HTMLCanvasElement;
  readonly getImageData: ReturnType<typeof vi.fn>;
}

/**
 * 假预览画布：`getImageData(0, 0, w, h)` 交回一张**按列着色**的位图——前 `leftColumns` 列红、
 * 其余蓝。列着色是为了让「裁错了哪一列」可观测：越界读一个像素在行优先的平坦缓冲里会读到
 * **下一行第一列**，颜色当场不同（`getImageData` 越界不抛错，只静默产出错位的预览）。
 */
function fakePreview(width: number, height: number, leftColumns: number): FakePreview {
  const getImageData = vi.fn((_x: number, _y: number, w: number, h: number) => {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const index = (y * w + x) * 4;
        const red = x < leftColumns;
        data[index] = red ? 255 : 0;
        data[index + 1] = 0;
        data[index + 2] = red ? 0 : 255;
        data[index + 3] = 255;
      }
    }
    return { width: w, height: h, data } as ImageData;
  });
  const canvas = {
    width,
    height,
    getContext: (kind: string) => (kind === "2d" ? { getImageData } : null),
  } as unknown as HTMLCanvasElement;
  return { canvas, getImageData };
}

function request(overrides: Partial<LivePreviewRequest> = {}): LivePreviewRequest {
  const { canvas } = fakePreview(50, 50, 25);
  return {
    preview: canvas,
    sourceSize: { width: 100, height: 100 },
    crop: { x: 0, y: 0, width: 100, height: 100 },
    rotation: 0,
    longSide: 50,
    maxColors: 2,
    removeBackground: false,
    ...overrides,
  };
}

describe("renderLivePreview", () => {
  it("裁剪框贴到原图右/下边界时不越界取像素（越界不抛错，只会静默产出错位的预览）", () => {
    // 原图 100×100、预览 50×50（比例 0.5）；预览左 25 列红、右 25 列蓝。
    const { canvas } = fakePreview(50, 50, 25);
    const pattern = renderLivePreview(
      request({
        preview: canvas,
        // crop 贴右边界：x=50、宽=50 ⇒ 换算到预览是 x=25、宽=25，右沿正好落在 50。
        crop: { x: 50, y: 0, width: 50, height: 100 },
      }),
      PALETTE,
    );

    expect(pattern).not.toBeNull();
    // 25×50 的裁剪配 longSide 50 ⇒ 网格 25×50，一格一像素。
    expect(pattern?.width).toBe(25);
    expect(pattern?.height).toBe(50);
    // 裁到的整块都是蓝（色卡下标 1）。若宽取成 26，每行最后一格会读到**下一行第一列**的红。
    expect([...(pattern?.cells ?? [])]).toEqual(new Array(25 * 50).fill(1));
  });

  it("目标网格长边 = min(longSide, 64)（长边设 20 就按 20 颗豆算，不是固定 64）", () => {
    const square = (): HTMLCanvasElement => fakePreview(64, 64, 64).canvas;
    const small = renderLivePreview(
      request({ preview: square(), sourceSize: { width: 64, height: 64 }, crop: { x: 0, y: 0, width: 64, height: 64 }, longSide: 20 }),
      PALETTE,
    );
    expect(small?.width).toBe(20);

    const big = renderLivePreview(
      request({ preview: square(), sourceSize: { width: 64, height: 64 }, crop: { x: 0, y: 0, width: 64, height: 64 }, longSide: 116 }),
      PALETTE,
    );
    expect(big?.width).toBe(LIVE_PREVIEW_MAX_LONG_SIDE);
  });

  it("同一张 preview 只读一次像素（第二次调用不再 getImageData）", () => {
    const { canvas, getImageData } = fakePreview(50, 50, 50);
    const base = request({ preview: canvas });
    renderLivePreview(base, PALETTE);
    renderLivePreview(base, PALETTE);
    expect(getImageData).toHaveBeenCalledTimes(1);
  });

  it("画不出来的时候安静返回 null（不抛）：拿不到上下文 / 尺寸非法 / 裁剪换算后一格都不剩", () => {
    // 拿不到 2D 上下文（本仓 happy-dom 的真实情况）。
    const noContext = { width: 50, height: 50, getContext: () => null } as unknown as HTMLCanvasElement;
    expect(renderLivePreview(request({ preview: noContext }), PALETTE)).toBeNull();

    const { canvas } = fakePreview(50, 50, 50);
    // 源图尺寸非法 ⇒ 比例为 Infinity（不是除零算出 Infinity 一路画下去）。
    expect(
      renderLivePreview(request({ preview: canvas, sourceSize: { width: 0, height: 100 } }), PALETTE),
    ).toBeNull();
    // 裁剪框落在原图右沿之外（`draft.crop` 由左栏夹取，这里仍是公开 API）：换算到预览后
    // x = 50 = 预览宽，一格都不剩。
    expect(
      renderLivePreview(
        request({ preview: canvas, crop: { x: 100, y: 0, width: 1, height: 100 } }),
        PALETTE,
      ),
    ).toBeNull();
  });
});
