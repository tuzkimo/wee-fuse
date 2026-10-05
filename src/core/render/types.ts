/**
 * B4 导出的纯类型：绘制目标接口 + 几何结构。
 *
 * **为什么 core 自己声明 `RenderTarget2D` 而不是用 `CanvasRenderingContext2D`**：后者在分层边界闸门
 * （`src/__tests__/coreBoundary.test.ts` 的 `FORBIDDEN_GLOBALS`）里是禁用全局——core 不得引用 DOM 全局。
 * 按 `AGENTS.md` 的口径「在 core 定义接口，在 services 注入实现」：`services/exporter.ts` 把真 ctx 传进来，
 * 测试用普通对象桩。代价如实记录：这是 core 里第一份不是纯数据的类型。
 *
 * **真实 ctx 与它并不严格结构兼容**（2026-10-05 按任务 3 的审查实测更正；原文那句「结构上满足本接口」
 * 是假的）。实测**四处**不合：`fillStyle` / `strokeStyle`（DOM 是 `string | CanvasGradient | CanvasPattern`）、
 * `textAlign`（DOM 多 `"start" | "end"`）、`textBaseline`（DOM 多 `"alphabetic" | "hanging" | "ideographic"`）。
 * 注入点 `services/exporter.ts` 的 `requireContext2D` 里做**一次具名窄化**
 * （`as unknown as RenderTarget2D`），面板与渲染器都不需要 cast。
 * **不**为了让两者结构兼容而把本接口的这四个字段放宽到 DOM 的联合类型——那等于把 `CanvasGradient` /
 * `CanvasPattern` / `"start"` / `"alphabetic"` 拖进零依赖的 core，正是本文件存在的理由所要隔离的东西。
 */
export interface PixelRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** 刻度：全局格号 + 它在**片内**的像素位置（位置由 layout 算好，渲染器不自算）。 */
export interface ColTick {
  readonly col: number;
  readonly x: number;
}
export interface RowTick {
  readonly row: number;
  readonly y: number;
}

/** 拼豆板边界：板序号（1 起）+ 全局格号 + 片内像素位置。 */
export interface ColBoardEdge {
  readonly board: number;
  readonly col: number;
  readonly x: number;
}
export interface RowBoardEdge {
  readonly board: number;
  readonly row: number;
  readonly y: number;
}

/** 网格线：像素位置 + 档位（thin = 每格、major = 每 5 格、board = 每 29 格）。 */
export interface GridLine {
  readonly at: number;
  readonly kind: "thin" | "major" | "board";
}

export interface LineWidths {
  readonly thin: number;
  readonly major: number;
  readonly board: number;
}

/**
 * 绘制目标：B4 的渲染器真正会调用的那一小撮 2D 方法。
 *
 * 属性用可写字段（而不是 setter 方法）是为了与真实 ctx 的结构对齐：`CanvasRenderingContext2D` 的
 * `fillStyle` 等是可变属性，写成只读属性会让真 ctx 不再结构兼容。
 */
export interface RenderTarget2D {
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  font: string;
  textAlign: "left" | "center" | "right";
  textBaseline: "top" | "middle" | "bottom";
  imageSmoothingEnabled: boolean;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  stroke(): void;
  fillText(text: string, x: number, y: number): void;
  save(): void;
  restore(): void;
}
