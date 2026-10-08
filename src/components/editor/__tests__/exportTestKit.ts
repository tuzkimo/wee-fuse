import type { Mock } from "vitest";
import type { RenderTarget2D } from "@/core/render/types";
import type * as exporterModule from "@/services/exporter";

/**
 * 导出面板两处用例（`src/components/editor/__tests__/ExportPanel.test.ts` 与
 * `src/views/__tests__/EditorPage.test.ts`）共用的**测试桩**（任务 4 修复轮 F2）。
 *
 * **为什么它必须存在**：这两份桩原来逐字重复了约 65 行——`@/services/exporter` 的五个函数替身、
 * `RenderTarget2D` 的记录型普通对象桩、object URL 的桩、假画布与顺序表。重复的两份桩不是
 * 「无害的样板」：`RenderTarget2D` 增删一个成员、或 `fillText` 的记录口径改了，只改一处时另一处会以
 * **假绿**的形式沉默（一端记了、另一端没记）——这正是本项目记过账的缺陷形态
 * （「两端各自正确、错在接线」）。
 *
 * **本文件不是交付代码**：它在测试目录里、**不新增生产消费者**，只有上面那两个用例文件 import 它。
 * 文件名不叫 `*.test.ts` / `*.spec.ts`，所以不会被 vitest 收集成用例——与
 * `src/services/__tests__/projectStoreContract.ts`（同款先例）一致。
 *
 * **什么放这里、什么不放**（实测教训）：`vi.mock(...)` 的工厂被提升到所有 import 之前，工厂里引用
 * 本模块的顶层导出会在**模块初始化之前**取值，实测崩在
 * `ReferenceError: Cannot access 'exporter' before initialization`（`ExportPanel.vue` 的 import 那一行）。
 * 所以**替身对象（`vi.fn()` 本身）由各用例文件用 `vi.hoisted` 自己声明**，本模块只提供
 * **不参与 `vi.mock`** 的东西：`MockExporter` 类型、记录型 target、假画布、object URL 桩、
 * 以及给替身装默认实现的 `resetExporterMock`。
 *
 * **本模块不碰真画布**：happy-dom 的 2D 上下文没有像素语义（`getContext("2d")` 默认返回 `null`、
 * `getImageData` 不可信、`toBlob` 给 size 0 的 Blob），所以渲染一律跑在下面的普通对象桩上。
 */

/* ------------------------------------------------------- exporter 替身的形状 */

/**
 * `@/services/exporter` 里**五个碰平台**的函数的替身形状（`exportFilename` 刻意不在其中：
 * 它用真实现，文件名的逐字格式是 `services/__tests__/exporter.test.ts` 的事）。
 *
 * 用例侧的声明方式（`vi.hoisted` 是必须的，理由见文件头）：
 *
 * ```ts
 * const exporter = vi.hoisted(
 *   () =>
 *     ({
 *       createCanvasStrict: vi.fn(),
 *       requireContext2D: vi.fn(),
 *       assertCanvasPainted: vi.fn(),
 *       canvasToBlob: vi.fn(),
 *       downloadBlob: vi.fn(),
 *     }) satisfies MockExporter,
 * );
 * ```
 *
 * **五个成员的类型都由真模块派生**（`Mock<typeof exporterModule.x>`，修复轮 F7），不是手抄一遍签名：
 * 手写接口时，真 `@/services/exporter` 改签名（例如 `requireContext2D` 的返回类型变了）**不会**让
 * 这两个用例文件编译失败——`vi.mock` 的字符串重载对工厂返回值零约束（`M = unknown`）。派生之后
 * 「谁改签名谁立刻在 `vue-tsc` 上看到两处红」这句话才**成真**：`satisfies` 会对着真签名校验
 * `vi.fn()` 的结构，而 `resetExporterMock(exporter, …)` 也因为参数类型是它而一起被校验。
 *
 * **为什么 `vi.fn()`（返回类型是 `unknown`）也拦得住**（实测，不是推测）：`Mock<T>` 的调用签名是
 * `(...args: Parameters<T>) => ReturnType<T>`（`@vitest/spy/dist/index.d.ts:341`），返回类型进得去
 * 这个类型。把真 `requireContext2D` 的返回类型改成 `number` 后，`vue-tsc` 实测报
 * `exportTestKit.ts(258,66): error TS2322: Type 'RenderTarget2D' is not assignable to type 'number'`
 * 以及生产代码里那几处 `TS2345` —— 类型耦合是**实的**。
 *
 * **刻意不用 `as`**：`satisfies` 保留对象字面量的 Mock 类型（`.mockImplementation` / `.mock` 都能直接用），
 * 而 `as` 会把它擦成接口本身、丢掉 Mock 的方法。
 */
export interface MockExporter {
  createCanvasStrict: Mock<typeof exporterModule.createCanvasStrict>;
  requireContext2D: Mock<typeof exporterModule.requireContext2D>;
  /** 画布自检（契约 §2 的第 6 个导出）：生产消费者**就是导出面板**。 */
  assertCanvasPainted: Mock<typeof exporterModule.assertCanvasPainted>;
  canvasToBlob: Mock<typeof exporterModule.canvasToBlob>;
  downloadBlob: Mock<typeof exporterModule.downloadBlob>;
}

/* ------------------------------------------------------------- 记录型绘制目标 */

/** 一次 `fillRect`：位置、尺寸与**当时**的 `fillStyle`。 */
export interface FillCall {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly fillStyle: string;
}

/** 一次 `fillText`：内容、位置与**当时**的字体 / 墨色 / 对齐。 */
export interface TextCall {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly fillStyle: string;
  readonly font: string;
  readonly textAlign: "left" | "center" | "right";
  readonly textBaseline: "top" | "middle" | "bottom";
}

export interface RecordingTarget {
  readonly target: RenderTarget2D;
  readonly fills: readonly FillCall[];
  /**
   * 图上文字。**`SheetMeta` 只能经这条路被观察到**（信息条两行、页脚、刻度、用量表标题与合计
   * 都是 `fillText`）：`fillText` 写成空实现时，`generatedAt` / `totalBeads` / `colorCount` /
   * `projectName` / `paletteName` / `accuracy` 六个字段在整任务里**零断言**——传空串、传 0、
   * 传错名字全都绿（修复轮 F1 的靶点）。
   */
  readonly texts: readonly TextCall[];
}

/**
 * `RenderTarget2D` 的普通对象桩 + `fillRect` / `fillText` 记录。
 * **不碰 `document.createElement("canvas")`**：happy-dom 的 ctx 没有像素语义。
 */
export function createRecordingTarget(): RecordingTarget {
  const fills: FillCall[] = [];
  const texts: TextCall[] = [];
  const target: RenderTarget2D = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    font: "",
    textAlign: "center",
    textBaseline: "middle",
    // **与真实 ctx 的默认值一致（`true`）**，也与 `core/render/__tests__/helpers.ts` 的桩一致
    // （修复波 C-m4）：两个共享桩的初值不一致时，任何「渲染器把插值关掉了」的面板侧断言都会变成
    // **恒真**（桩自己给的 `false`），而不是被测行为。
    imageSmoothingEnabled: true,
    fillRect: (x, y, w, h) => {
      fills.push({ x, y, w, h, fillStyle: target.fillStyle });
    },
    strokeRect: () => undefined,
    beginPath: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    stroke: () => undefined,
    fillText: (text, x, y) => {
      texts.push({
        text,
        x,
        y,
        fillStyle: target.fillStyle,
        font: target.font,
        textAlign: target.textAlign,
        textBaseline: target.textBaseline,
      });
    },
    save: () => undefined,
    restore: () => undefined,
  };
  return { target, fills, texts };
}

/* ------------------------------------------------------------------ 假画布 */

/**
 * `createCanvasStrict` 的替身：宽高**可写且记录每一次写入**。
 *
 * 面板从不读画布的宽高（尺寸只在 `createCanvasStrict` 的入参里用），所以「渲染完是否即时释放」
 * 在 CI 里唯一可观察的形式就是**有没有写回 0**（规格 §9 第 6 条）。用普通对象 + getter/setter，
 * 不碰 happy-dom 的 canvas。
 *
 * `onWrite` 把「谁先谁后」也记进用例的顺序表——只断言「写没写过 0」是证不出「释放发生在 `toBlob`
 * **之后**」的，而提前释放（拿着 0×0 的画布去 `toBlob`）在生产路径上就是一张空图。
 */
export interface FakeCanvas {
  readonly canvas: HTMLCanvasElement;
  /** 每一次 `width` / `height` 赋值都被记下来（`[属性, 值]`）。 */
  readonly writes: readonly (readonly [string, number])[];
}

export function createFakeCanvas(
  width: number,
  height: number,
  onWrite: (what: string) => void,
): FakeCanvas {
  const writes: (readonly [string, number])[] = [];
  const current: { width: number; height: number } = { width, height };
  const canvas = {
    get width(): number {
      return current.width;
    },
    set width(value: number) {
      writes.push(["width", value]);
      onWrite("release:width");
      current.width = value;
    },
    get height(): number {
      return current.height;
    },
    set height(value: number) {
      writes.push(["height", value]);
      onWrite("release:height");
      current.height = value;
    },
  } as unknown as HTMLCanvasElement;
  return { canvas, writes };
}

/* ------------------------------------------------------------------ object URL */

/** `URL.createObjectURL` 造出来的串，按调用顺序；由 `stubObjectUrl` 每次重置。 */
export const createdUrls: string[] = [];
/**
 * `URL.createObjectURL` **收到的 blob**，按调用顺序（与 `createdUrls` 同序）。
 *
 * **为什么必须记实参**（修复波 C-M4）：只记返回串时，「预览指向同一颗 blob」这句话**比断言更强**
 * ——把 `<img src>` 指向另一次 `createObjectURL(new Blob())` 的产物照样绿。记下实参之后，
 * 用例才能像 `downloadBlob` 那条恒等断言一样问「预览用的就是落盘的那**一颗**对象吗」。
 */
export const createdBlobs: Blob[] = [];
/** `URL.revokeObjectURL` 收到的串，按调用顺序（用来证明预览**销号后**才丢弃）。 */
export const revokedUrls: string[] = [];

/**
 * object URL 的桩：happy-dom 下这两个方法**可能不存在**（CONTRACT §5.2），所以不用 `vi.spyOn`；
 * 也**不整替 `URL` 全局**（它的构造函数还有别的用途）。
 *
 * 两个数组是**导出后原地更新**（不是每次返回新数组）：用例在 `beforeEach` 里调一次本函数，
 * 之后直接读这两个常量即可。
 */
export function stubObjectUrl(): void {
  const target = URL as unknown as {
    createObjectURL: (blob: Blob) => string;
    revokeObjectURL: (url: string) => void;
  };
  createdUrls.length = 0;
  createdBlobs.length = 0;
  revokedUrls.length = 0;
  let seq = 0;
  target.createObjectURL = (blob: Blob) => {
    seq += 1;
    const url = `blob:test-${seq}`;
    createdUrls.push(url);
    createdBlobs.push(blob);
    return url;
  };
  target.revokeObjectURL = (url: string) => {
    revokedUrls.push(url);
  };
}

/* --------------------------------------------------------- 替身的默认实现 */

/** `resetExporterMock` 的钩子。 */
export interface ResetExporterHooks {
  /** 每次建画布时收到的那张假画布（顺序表 / 释放断言需要时传）。 */
  readonly onCanvas?: (fake: FakeCanvas) => void;
  /** 顺序表的记录口：`selfcheck` / `toBlob` / `release:*` 都推进这里。 */
  readonly onStep?: (what: string) => void;
}

/**
 * 给五个替身逐项 `mockReset()` 并装上**默认实现**。两个用例文件在各自的 `beforeEach` 里调用它，
 * 于是「默认实现」也只有一份。
 *
 * 默认实现的形状是承重的：
 * 1. `createCanvasStrict` 造**记录型假画布**（把 `release:*` 推进顺序表，供「释放晚于 toBlob」用）；
 * 2. `requireContext2D` 返回记录型 target（**不 mock `@/core/render/*`**：真渲染器必须真的跑）；
 * 3. `assertCanvasPainted` 把 `selfcheck` 推进顺序表（默认实现就是「通过」）；
 * 4. `canvasToBlob` 把 `toBlob` 推进顺序表并给一颗**非空** blob（`downloadBlob` 的真实现拦 size 0）；
 * 5. `downloadBlob` **不装实现**：它的调用次数与实参就是断言对象，`mockReset()` 后的默认 `undefined`
 *    正合适。
 *
 * **`onCanvas` 缺省不记录**：传入的钩子决定要不要按调用顺序收集画布（不需要的用例少一份状态）。
 */
export function resetExporterMock(
  exporter: MockExporter,
  target: RenderTarget2D,
  hooks: ResetExporterHooks = {},
): void {
  const onStep = hooks.onStep ?? ((): void => undefined);

  exporter.createCanvasStrict.mockReset().mockImplementation((width, height) => {
    const fake = createFakeCanvas(width, height, onStep);
    hooks.onCanvas?.(fake);
    return fake.canvas;
  });
  exporter.requireContext2D.mockReset().mockImplementation(() => target);
  exporter.assertCanvasPainted.mockReset().mockImplementation(() => {
    onStep("selfcheck");
  });
  exporter.canvasToBlob.mockReset().mockImplementation(async () => {
    onStep("toBlob");
    return new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
  });
  exporter.downloadBlob.mockReset();
}
