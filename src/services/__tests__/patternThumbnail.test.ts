import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPalette } from "@/core/palette/registry";
import { EMPTY } from "@/core/pattern/types";
import { renderPatternThumbnail, THUMBNAIL_MAX_EDGE } from "@/services/patternThumbnail";

const palette = loadPalette({
  id: "fake",
  name: "测试色卡",
  source: "https://example.com",
  accuracy: "仅测试用",
  colors: [
    { code: "A1", hex: "#ffffff" },
    { code: "A2", hex: "#000000" },
  ],
});

/**
 * happy-dom 的 canvas 是桩实现，`toDataURL` 返回固定占位串、不反映像素，故这里**不**断言
 * 编码后的 PNG 内容（那会变成恒真断言）。这里断言的是契约：调用了哪些平台 API、画布尺寸
 * 怎么算、交给 `putImageData` 的 4 通道字节与坐标、全空格图纸照常渲染、非法上限是否被拒绝。
 * 真实像素的观感验证在任务 9 的人工流程里做。
 *
 * **本环境的额外事实（实现者实测，见 task-4-report.md 偏差 D1）**：happy-dom 20.14.5
 * 在未注册 canvas adapter 时 `getContext("2d")` **返回 `null`**
 * （`canvasAdapter` 默认 `null`，且本仓库没有 `@happy-dom/canvas` 依赖），
 * 而 `document.createElement("canvas")` / `toDataURL` 是真实实现。简报原写法直接
 * `originalGetContext.apply(...)` 拿到 `null`，于是被测实现的 `getContext === null` 守卫
 * 抛错、或 spy 自己在 `ctx.drawImage` 上抛 TypeError。故这里给
 * `HTMLCanvasElement.prototype.getContext` 装一个**最小 2D 上下文替身**：
 * 只实现被测代码真正用到的四个成员（`imageSmoothingEnabled` / `createImageData` /
 * `putImageData` / `drawImage`），并记录每次 `drawImage` 的实参与目标画布尺寸。
 *
 * 断言仍钉在**真实画布元素**上：`target.w/h` 读的是真 `HTMLCanvasElement` 的
 * `width`/`height`（即「缩略图画布开多大」），URL 也来自真的 `toDataURL`。
 * 替身对 `"2d"` 以外的 contextId 返回 `null`，因此「用了哪种上下文」也被钉住。
 *
 * 与简报原写法的第二处差别（同样是为了判别力而非放宽）：spy 由文件级
 * `beforeEach` 安装、`afterEach` 统一 `restoreAllMocks`。简报的「用例内创建 spy +
 * 手工 `spy.mockRestore()`」在断言失败时会**漏还原**——实测第 2 条用例失败后，第 3 条
 * 用例的 `originalGetContext` 抓到的是已被 mock 的函数，直接
 * `RangeError: Maximum call stack size exceeded`（见报告 D1 的原始输出），
 * 失败原因被伪装成无关的栈溢出。
 */
interface RecordedDraw {
  /** 调用 `getContext("2d")` 那一刻，该上下文所属画布的尺寸（真画布的 width/height）。 */
  readonly target: { w: number; h: number };
  /** 该次 `drawImage` 发生时，上下文是否仍开着插值（缩略图要求关掉 = 最近邻）。 */
  readonly smoothing: boolean;
  /** `drawImage` 的第 4、5 个实参（目标宽高）。 */
  readonly dw: number;
  readonly dh: number;
}

let draws: RecordedDraw[] = [];

/** 每次 `putImageData` 收到的字节与坐标（格画布那一层）。 */
interface RecordedPut {
  /** 调用 `getContext("2d")` 那一刻，该上下文所属画布的尺寸。 */
  readonly target: { w: number; h: number };
  readonly x: number;
  readonly y: number;
  /** 直接持有替身缓冲的引用（不展开：大图纸下展开会多出上千万个元素）。 */
  readonly bytes: Uint8ClampedArray;
}

let puts: RecordedPut[] = [];

/** 最小 2D 上下文替身：只实现被测代码用到的成员。 */
function createStubContext2D(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const target = { w: canvas.width, h: canvas.height };
  const ctx = {
    imageSmoothingEnabled: true,
    createImageData: (width: number, height: number) => ({
      width,
      height,
      data: new Uint8ClampedArray(width * height * 4),
    }),
    putImageData: (data: { data: Uint8ClampedArray }, x: number, y: number) => {
      puts.push({ target, x, y, bytes: data.data });
    },
    drawImage: (...drawArgs: unknown[]) => {
      draws.push({
        target,
        // 在 drawImage 发生的当刻读，才能证明「关插值」发生在画之前
        smoothing: ctx.imageSmoothingEnabled,
        dw: drawArgs[3] as number,
        dh: drawArgs[4] as number,
      });
    },
  };
  return ctx as unknown as CanvasRenderingContext2D;
}

beforeEach(() => {
  draws = [];
  puts = [];
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
    this: HTMLCanvasElement,
    ...args: unknown[]
  ) {
    return args[0] === "2d" ? createStubContext2D(this) : null;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("renderPatternThumbnail", () => {
  it("返回带 png 前缀的 data URL", () => {
    const url = renderPatternThumbnail(
      { width: 2, height: 2, paletteId: "fake", cells: Uint16Array.from([0, 1, 1, 0]) },
      palette,
    );
    expect(url.startsWith("data:image/png")).toBe(true);
  });

  it("长边超过上限时按比例缩小，且不放大（缩略图直径 = 512×256）", () => {
    // 只断言「返回了字符串」抓不到尺寸算错，所以要把**缩放后那次 drawImage 的尺寸**记下来。
    renderPatternThumbnail(
      {
        width: THUMBNAIL_MAX_EDGE * 8,
        height: THUMBNAIL_MAX_EDGE * 4,
        paletteId: "fake",
        cells: new Uint16Array(THUMBNAIL_MAX_EDGE * 8 * THUMBNAIL_MAX_EDGE * 4),
      },
      palette,
    );

    // 只有一次 drawImage（色块画布 → 输出画布），它的目标尺寸就是缩略图尺寸
    expect(draws).toHaveLength(1);
    expect(draws[0]?.dw).toBe(THUMBNAIL_MAX_EDGE);
    expect(draws[0]?.dh).toBe(THUMBNAIL_MAX_EDGE / 2);
    expect([draws[0]?.target.w, draws[0]?.target.h]).toEqual([
      THUMBNAIL_MAX_EDGE,
      THUMBNAIL_MAX_EDGE / 2,
    ]);
    // 最近邻：画之前必须已关闭插值，否则缩略图会出现图纸里根本没有的中间色
    expect(draws[0]?.smoothing).toBe(false);
  });

  it("小图纸不放大：8×4 的图纸缩略图仍是 8×4（不是被拉到 512）", () => {
    // 与上一条相对：缩放系数必须**只缩不放**。少了这条，把 `scale` 写成恒 `maxEdge / longEdge`
    // 也能全绿——而那会把一张 8×4 的图纸放大成 512×256 的糊图。
    renderPatternThumbnail(
      { width: 8, height: 4, paletteId: "fake", cells: new Uint16Array(32) },
      palette,
    );

    expect(draws).toHaveLength(1);
    expect([draws[0]?.dw, draws[0]?.dh]).toEqual([8, 4]);
  });

  it("全空格图纸也返回合法 data URL（不抛错）", () => {
    const url = renderPatternThumbnail(
      { width: 1, height: 1, paletteId: "fake", cells: Uint16Array.from([EMPTY]) },
      palette,
    );
    expect(url.startsWith("data:image/png")).toBe(true);
  });

  it("极端长宽比 + 极小上限时也不会开出 0 宽/0 高的画布（0 尺寸画布的 toDataURL 是 \"data:,\"）", () => {
    // `Math.max(1, Math.round(...))` 这个夹取在 1×500 的图纸 + maxEdge=1 时才生效：
    // 去掉它，输出画布宽度就是 round(1 × 1/500) = 0。真浏览器对 0 尺寸画布返回 "data:,"，
    // 而任务 3 的 `meta.thumbnail` 校验要求 `data:image/` 前缀 —— 于是「保存工程」会以一个
    // 与缩略图毫无关系的文案失败。
    renderPatternThumbnail(
      { width: 1, height: 500, paletteId: "fake", cells: new Uint16Array(500) },
      palette,
      1,
    );

    expect(draws).toHaveLength(1);
    expect([draws[0]?.target.w, draws[0]?.target.h]).toEqual([1, 1]);
    expect([draws[0]?.dw, draws[0]?.dh]).toEqual([1, 1]);
  });

  it("把栅格化结果逐字节交给 putImageData（漏掉这一步缩略图就是一张全透明图）", () => {
    // 与 raster.test.ts 的分工：那里钉 patternToRgbaImage 自己的输出，这里钉**接线**
    // ——4 通道字节必须原样进格画布、且落在 (0,0)。两端各自正确、错在接线的缺陷
    // （本项目 D1 的形态）只有这一层能抓：删掉 putImageData 或改错坐标，drawImage 的
    // 实参与 toDataURL 都不变，上面五条断言全绿。
    renderPatternThumbnail(
      { width: 2, height: 2, paletteId: "fake", cells: Uint16Array.from([0, 1, 1, 0]) },
      palette,
    );

    expect(puts).toHaveLength(1);
    expect([puts[0]?.target.w, puts[0]?.target.h]).toEqual([2, 2]);
    expect([puts[0]?.x, puts[0]?.y]).toEqual([0, 0]);
    // A1 白 / A2 黑 / A2 黑 / A1 白，逐字节（R、G、B、A 四通道都读）
    expect([...(puts[0]?.bytes ?? [])]).toEqual([
      255, 255, 255, 255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255,
    ]);
  });

  it("长边上限就是规格的 512；非法上限响亮失败，且守卫在任何画布写操作之前", () => {
    // 上一条用例把 THUMBNAIL_MAX_EDGE 同时用在输入构造与期望值上，改常量照样全绿，
    // 故这里钉住规格 §3 的「≤512px」字面量（与 preview.test.ts 钉 1600 同一形态）。
    expect(THUMBNAIL_MAX_EDGE).toBe(512);

    const pattern = { width: 2, height: 2, paletteId: "fake", cells: new Uint16Array(4) };
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => renderPatternThumbnail(pattern, palette, bad)).toThrow(/缩略图长边上限非法/);
    }
    // AGENTS.md「入口校验」：校验写在**任何写操作之前**。删掉守卫或把它挪到画布之后，
    // 这里就会记录到 drawImage（`draws` 非空）。
    expect(draws).toEqual([]);
  });
});
