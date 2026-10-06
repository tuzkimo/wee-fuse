import type { RenderTarget2D } from "../types";

/**
 * 三个渲染器用例共用的**普通对象桩** + 调用记录。
 *
 * **为什么不用 `document.createElement("canvas")`**：happy-dom 的 canvas 是无像素语义的桩
 * （`getContext("2d")` 在本仓返回 null，见 `services/__tests__/patternThumbnail.test.ts` 的实测），
 * 拿它当目标只能写出恒真断言。这里改成记录「渲染器到底调了什么」——线宽 / 颜色 / 坐标 / 顺序
 * 全都在 Node 里可断言。真实像素的观感验证在规格 §14 的人工清单里，不做成断言（§13.4）。
 *
 * **与真实 ctx 的两处刻意对齐**（否则正确实现会假红）：
 * 1. `fillRect` 记下**调用当刻**的 `imageSmoothingEnabled`（分享图要求画之前就已关插值）；
 * 2. 路径的 `lineWidth` / `strokeStyle` 在 **`stroke()` 那一刻**刷新——真实 canvas 也是在 stroke
 *    时读这两个属性，所以「先 beginPath 再设线宽」这种合法写法不会被记成错的值。
 */

/** 一次 `fillRect`：实参 + 调用当刻的 2D 状态快照。 */
export interface FillCall {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly fillStyle: string;
  /** 调用当刻的 `imageSmoothingEnabled`（分享图要求「画之前」就已关闭插值）。 */
  readonly smoothing: boolean;
}

/** 一次 `fillText`：文本 + 实参 + 调用当刻的 2D 状态快照。 */
export interface TextCall {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly font: string;
  readonly fillStyle: string;
  readonly textAlign: RenderTarget2D["textAlign"];
  readonly textBaseline: RenderTarget2D["textBaseline"];
}

export type PathOp =
  | { readonly op: "moveTo"; readonly x: number; readonly y: number }
  | { readonly op: "lineTo"; readonly x: number; readonly y: number }
  | { readonly op: "stroke" };

/**
 * 一次 `beginPath` 起、到下一个 `beginPath` 前的全部路径操作。
 * `lineWidth` / `strokeStyle` 是 **`stroke()` 时刻**的值（真实 canvas 的读取时机）。
 */
export interface PathCall {
  lineWidth: number;
  strokeStyle: string;
  readonly ops: PathOp[];
}

/** 一次 `strokeRect`（用量表色块的外框走这里：真色填充之上压一道细框）。 */
export interface StrokeRectCall {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly strokeStyle: string;
  readonly lineWidth: number;
}

export interface MockCalls {
  readonly fills: FillCall[];
  readonly texts: TextCall[];
  readonly paths: PathCall[];
  readonly strokeRects: StrokeRectCall[];
  /**
   * 没有 `beginPath` 就打头的路径操作。**`stroke()` 之后 `hasPath` 复位**，所以「漏写 `beginPath`」
   * 在**每一组**路径上都会被记到这里（不复位时只有第一组可观察，后几组会静默并入上一组）。
   */
  readonly strayOps: string[];
  /**
   * `save()` / `restore()` 的调用次数。当前两个渲染器一次都不调（都是 0），但**配平是必须保持的
   * 不变量**（不配平会泄漏 target 的全局状态），由三个 `draw*` 用例各一条 `saves === restores` 守着。
   * 计数成对增长是有意的：只记一个数就判不出「多了一次 save」，也无法允许将来正当的成对使用。
   */
  saves: number;
  restores: number;
}

/** 造一个普通对象绘制目标 + 它的调用记录（`calls` 与 `target` 同源，边画边记）。 */
export function createMockTarget(): { readonly target: RenderTarget2D; readonly calls: MockCalls } {
  const calls: MockCalls = {
    fills: [],
    texts: [],
    paths: [],
    strokeRects: [],
    strayOps: [],
    saves: 0,
    restores: 0,
  };
  let ops: PathOp[] = [];
  let hasPath = false;

  const target: RenderTarget2D = {
    fillStyle: "#000000",
    strokeStyle: "#000000",
    lineWidth: 1,
    font: "10px sans-serif",
    textAlign: "left",
    textBaseline: "top",
    imageSmoothingEnabled: true,
    fillRect(x, y, w, h) {
      calls.fills.push({
        x,
        y,
        w,
        h,
        fillStyle: target.fillStyle,
        smoothing: target.imageSmoothingEnabled,
      });
    },
    strokeRect(x, y, w, h) {
      calls.strokeRects.push({
        x,
        y,
        w,
        h,
        strokeStyle: target.strokeStyle,
        lineWidth: target.lineWidth,
      });
    },
    beginPath() {
      ops = [];
      hasPath = true;
      calls.paths.push({ lineWidth: target.lineWidth, strokeStyle: target.strokeStyle, ops });
    },
    moveTo(x, y) {
      if (!hasPath) {
        calls.strayOps.push(`moveTo(${x}, ${y})`);
        return;
      }
      ops.push({ op: "moveTo", x, y });
    },
    lineTo(x, y) {
      if (!hasPath) {
        calls.strayOps.push(`lineTo(${x}, ${y})`);
        return;
      }
      ops.push({ op: "lineTo", x, y });
    },
    stroke() {
      if (!hasPath) {
        calls.strayOps.push("stroke()");
        return;
      }
      const current = calls.paths[calls.paths.length - 1];
      if (current !== undefined) {
        // stroke 时刻读属性（与真实 canvas 一致）
        current.lineWidth = target.lineWidth;
        current.strokeStyle = target.strokeStyle;
      }
      ops.push({ op: "stroke" });
      // `stroke()` 之后路径就结束了：`hasPath` 必须复位，否则**第二、三组**漏写 `beginPath` 会被
      // 静默并进上一组（`strayOps` 永远为空），「漏写 beginPath 必须可观察」就只对第一组成立。
      // （2026-10-05 任务级审查抓到；两个渲染器的每条路径都以 `beginPath` 开头，故复位是安全的。）
      hasPath = false;
    },
    fillText(text, x, y) {
      calls.texts.push({
        text,
        x,
        y,
        font: target.font,
        fillStyle: target.fillStyle,
        textAlign: target.textAlign,
        textBaseline: target.textBaseline,
      });
    },
    save() {
      calls.saves += 1;
    },
    restore() {
      calls.restores += 1;
    },
  };

  return { target, calls };
}
