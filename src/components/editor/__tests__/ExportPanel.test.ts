import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPalette } from "@/core/palette/registry";
import type { Palette } from "@/core/palette/types";
import { patternStats } from "@/core/pattern/stats";
import { EMPTY, type Pattern } from "@/core/pattern/types";
import * as layout from "@/core/render/layout";
import type { RenderTarget2D } from "@/core/render/types";
import ExportPanel from "@/components/editor/ExportPanel.vue";

/**
 * 导出面板用例：**只给 props 就能完整工作**（契约 §2b）。
 *
 * 本文件**全程不建 pinia**：面板一旦 import 任何 store 并在 setup / 渲染里读它，挂载期就会以
 * 「no active Pinia」抛错，每一条用例都会红——这就是「面板不许 import `@/stores/*`」这条纪律的
 * 运行时证明（`只给 props 就能完整工作` 那一条另外补一条源码级词法闸门）。
 *
 * 平台边界只有一处桩：`@/services/exporter` 的五个碰平台的函数
 * （建画布 / ctx / **画布自检** / toBlob / 下载），`exportFilename` 用**真实现**
 * （文件名的逐字格式由任务 3 的用例负责，这里只钉「工程名 + 中文标签」这两件事被接上了）。
 * **不 mock `@/core/render/*`**：让真渲染器跑在下面的记录型 target 上，
 * 「props → plan → 渲染器」这条链才是真的被走过（happy-dom 的 canvas 没有像素语义，CONTRACT §5.1）。
 *
 * 与「面板的状态机」有关的三件事（逐项四态 / `revision` 失效 / **画布自检 + 即时释放**）都在
 * 下面同一组 `describe` 里：它们都是同一条渲染路径上的顺序约束，拆开就会各自假绿。
 */

/* ---------------- 桩 1：平台边界（exporter 的五个函数） ---------------- */

const exporter = vi.hoisted(() => ({
  createCanvasStrict: vi.fn<(width: number, height: number) => HTMLCanvasElement>(),
  requireContext2D: vi.fn<(canvas: HTMLCanvasElement) => RenderTarget2D>(),
  // 画布自检（契约 §2 的第 6 个导出）：生产消费者**就是本面板**——面板不调用它，它就是零消费者导出。
  assertCanvasPainted: vi.fn<(canvas: HTMLCanvasElement) => void>(),
  canvasToBlob: vi.fn<(canvas: HTMLCanvasElement) => Promise<Blob>>(),
  downloadBlob: vi.fn<(blob: Blob, filename: string) => void>(),
}));

vi.mock("@/services/exporter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/exporter")>();
  return { ...actual, ...exporter };
});

/* ---------------- 桩 2：labels-omitted 的定向桩（默认 null = 真实现） ---------------- */

/**
 * 为什么需要它：默认 `EXPORT_MAX_EDGE = 4096` 时 `kc = kr = 4 ≥ 1` ⇒ **`labels` 恒为真**，
 * 「省略色号」这条提示不可能由真 plan 产生；而契约 §2b 的 props 里没有 `maxEdge`，
 * 面板也无法被喂进一个更小的上限。要让那段琥珀文案进入被测路径，只能把 `planSheets` 定向替换一次
 * （控制者裁定 1：**不加 `maxEdge` prop**——它是平台事实、不是每张图的输入；本桩即采纳的处置）。
 */
const layoutStub = vi.hoisted(() => ({
  planSheets: null as null | typeof import("@/core/render/layout").planSheets,
}));

vi.mock("@/core/render/layout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/core/render/layout")>();
  return {
    ...actual,
    planSheets: (
      pattern: Parameters<typeof actual.planSheets>[0],
      palette: Parameters<typeof actual.planSheets>[1],
      options?: Parameters<typeof actual.planSheets>[2],
    ): ReturnType<typeof actual.planSheets> =>
      (layoutStub.planSheets ?? actual.planSheets)(pattern, palette, options),
  };
});

/* ---------------- 记录型绘制目标 ---------------- */

interface FillCall {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly fillStyle: string;
}

interface RecordingTarget {
  readonly target: RenderTarget2D;
  readonly fills: readonly FillCall[];
}

/**
 * `RenderTarget2D` 的普通对象桩 + `fillRect` 记录。**不碰 `document.createElement("canvas")`**：
 * happy-dom 的 ctx 没有像素语义，`getImageData` / `toDataURL` 都不可信（CONTRACT §5.1）。
 */
function createRecordingTarget(): RecordingTarget {
  const fills: FillCall[] = [];
  const target: RenderTarget2D = {
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    font: "",
    textAlign: "center",
    textBaseline: "middle",
    imageSmoothingEnabled: false,
    fillRect: (x, y, w, h) => {
      fills.push({ x, y, w, h, fillStyle: target.fillStyle });
    },
    strokeRect: () => undefined,
    beginPath: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    stroke: () => undefined,
    fillText: () => undefined,
    save: () => undefined,
    restore: () => undefined,
  };
  return { target, fills };
}

/* ---------------- 假画布（即时释放那一条靠它才可观察） ---------------- */

interface FakeCanvas {
  readonly canvas: HTMLCanvasElement;
  /** 每一次 `width` / `height` 赋值都被记下来（`[属性, 值]`）。 */
  readonly writes: readonly (readonly [string, number])[];
}

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
function createFakeCanvas(
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

/* ---------------- object URL 的桩 ---------------- */

let createdUrls: string[] = [];
let revokedUrls: string[] = [];

/**
 * happy-dom 下 `URL.createObjectURL` / `revokeObjectURL` **可能不存在**（CONTRACT §5.2），
 * 所以不用 `vi.spyOn`；也**不整替 `URL` 全局**（它的构造函数还有别的用途）。
 */
function stubObjectUrl(): void {
  const target = URL as unknown as {
    createObjectURL: (blob: Blob) => string;
    revokeObjectURL: (url: string) => void;
  };
  let seq = 0;
  createdUrls = [];
  revokedUrls = [];
  target.createObjectURL = () => {
    seq += 1;
    const url = `blob:panel-${seq}`;
    createdUrls.push(url);
    return url;
  };
  target.revokeObjectURL = (url: string) => {
    revokedUrls.push(url);
  };
}

/* ---------------- 夹具 ---------------- */

/** 夹具色卡：16 色（让 200×200 的夹具把用量表排到 2 行，摘要才真的「随 plan 变」）。 */
const palette: Palette = loadPalette({
  id: "panel-fixture",
  name: "夹具色卡",
  source: "https://example.com",
  accuracy: "屏幕色仅供参考，以实物为准",
  colors: Array.from({ length: 16 }, (_, i) => ({
    code: `A${i + 1}`,
    name: `色 ${i + 1}`,
    hex: `#${(i + 1).toString(16).padStart(2, "0")}0000`,
  })),
});

/** 4×2：1 张施工图、40 px/格、含色号；用到 3 个色号（用量表 1 行、分享图 256×128）。 */
function makeSmallPattern(): Pattern {
  return {
    width: 4,
    height: 2,
    paletteId: palette.id,
    cells: Uint16Array.from([0, 1, 2, EMPTY, 2, 2, 2, 2]),
  };
}

/** 200×200：4 张（2×2 片，每片 116 格、33 px/格）；用到 15 个色号（用量表 2 行、分享图 2000×2000）。 */
function makeLargePattern(): Pattern {
  const cells = new Uint16Array(200 * 200);
  for (let i = 0; i < cells.length; i += 1) cells[i] = i % 15;
  return { width: 200, height: 200, paletteId: palette.id, cells };
}

function mountPanel(pattern: Pattern, overrides: Record<string, unknown> = {}) {
  return mount(ExportPanel, {
    props: {
      pattern,
      palette,
      usages: patternStats(pattern, palette).usages,
      projectName: "小猫",
      revision: 0,
      ...overrides,
    },
  });
}

async function saveAndSettle(wrapper: ReturnType<typeof mount>, id: string): Promise<void> {
  await wrapper.get(`[data-testid='export-save-${id}']`).trigger("click");
  await flushPromises();
}

/** 面板源码：词法闸门用（`from "…/stores/…"` 一次都不许出现）。 */
const PANEL_SOURCES: Record<string, string> = import.meta.glob<string>("../ExportPanel.vue", {
  eager: true,
  query: "?raw",
  import: "default",
});

let recording: RecordingTarget;
/** 每一次 `createCanvasStrict` 造出来的假画布，按调用顺序（一次导出 = 一张画布）。 */
let canvases: FakeCanvas[];
/** 渲染路径上的**顺序**：自检必须早于 `toBlob`，释放必须晚于 `toBlob`。 */
let steps: string[] = [];

beforeEach(() => {
  recording = createRecordingTarget();
  canvases = [];
  steps = [];
  exporter.createCanvasStrict.mockReset().mockImplementation((width, height) => {
    const fake = createFakeCanvas(width, height, (what) => {
      steps.push(what);
    });
    canvases.push(fake);
    return fake.canvas;
  });
  exporter.requireContext2D.mockReset().mockImplementation(() => recording.target);
  exporter.assertCanvasPainted.mockReset().mockImplementation(() => {
    steps.push("selfcheck");
  });
  exporter.canvasToBlob.mockReset().mockImplementation(async () => {
    steps.push("toBlob");
    return new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
  });
  exporter.downloadBlob.mockReset();
  stubObjectUrl();
});

afterEach(() => {
  layoutStub.planSheets = null;
});

/* ---------------- 用例 ---------------- */

describe("计划摘要（规格 §10.2 / 契约 §4）", () => {
  it("三行摘要按契约 §4 逐字渲染，并随 plan 变（含片标签的总行 / 总列）", () => {
    const wrapper = mountPanel(makeSmallPattern());
    // 用 testid 定位 + `toBe`（不是整页 `text()` + `toContain`）：三行摘要都是单个插值，逐字相等
    // 是本环境里能断的最强形式；而整页文本里「用量表」既在摘要里、也在逐项标签里——那种定位
    // 既可能假绿（摘要写错、标签碰巧带上）也可能假红。
    expect(wrapper.get("[data-testid='export-summary-sheet']").text()).toBe(
      "共 1 张 · 每片最多 4×2 格 · 40 px/格 · 含格内色号",
    );
    expect(wrapper.get("[data-testid='export-summary-legend']").text()).toBe(
      "用量表 · 13 列 × 1 行 · 3948×230 px",
    );
    expect(wrapper.get("[data-testid='export-summary-share']").text()).toBe(
      "分享图 · 256×128 px（纯色块，无网格无文字）",
    );
    // 含色号这一档**不渲染**琥珀提示（契约 §4：它是「省略时另起一行」）
    expect(wrapper.find("[data-testid='export-warning-labels']").exists()).toBe(false);
    // 1 张时片标签是 1/1——它是**算出来的**，不是常量
    expect(wrapper.get("[data-testid='export-item-tile-0']").text()).toContain(
      "施工图 第 1/1 行 第 1/1 列",
    );
  });

  it("换 plan（同一个实例）后摘要与逐项清单都跟着走，片标签是 2/2", async () => {
    const wrapper = mountPanel(makeSmallPattern());
    const large = makeLargePattern();

    // **只换 pattern（`revision` 刻意不动）**：`beginSession` 会把 `revision` 归零，所以
    // 「从一张 revision = 0 的图纸换到另一张」时 revision 这一路根本不会触发——`watch` 若不看
    // `pattern` 的对象身份，清单就会停在上一张图纸的片数与标签上（契约 §2b 明文要求两个源都在，
    // 见步骤 12 的 M-rev-B）。
    await wrapper.setProps({ pattern: large, usages: patternStats(large, palette).usages });
    await flushPromises();

    expect(wrapper.get("[data-testid='export-summary-sheet']").text()).toBe(
      "共 4 张 · 每片最多 116×116 格 · 33 px/格 · 含格内色号",
    );
    expect(wrapper.get("[data-testid='export-summary-legend']").text()).toBe(
      "用量表 · 13 列 × 2 行 · 3948×260 px",
    );
    expect(wrapper.get("[data-testid='export-summary-share']").text()).toBe(
      "分享图 · 2000×2000 px（纯色块，无网格无文字）",
    );
    expect(wrapper.get("[data-testid='export-item-tile-0']").text()).toContain(
      "施工图 第 1/2 行 第 1/2 列",
    );
    expect(wrapper.get("[data-testid='export-item-tile-3']").text()).toContain(
      "施工图 第 2/2 行 第 2/2 列",
    );
    expect(wrapper.find("[data-testid='export-item-tile-4']").exists()).toBe(false);
  });

  it("labels-omitted：摘要尾注与琥珀提示按契约 §4 逐字（定向桩，见文件头的说明）", () => {
    const small = makeSmallPattern();
    // **前提断言**：默认上限下真 plan 一定是含色号的。这一句同时是「桩不是可有可无」的证据——
    // 哪天常量下调到真能走到这一档，这条前提会红，那时应当把桩删掉、改用真 plan。
    const realPlan = layout.planSheets(small, palette);
    expect(realPlan.labels).toBe(true);

    // 桩必须**连 `cellPx` 一起改**：真核心在降级时会把格像素压到 `SHEET_LABEL_MIN_CELL_PX - 1`
    // 以下，只翻 `labels` 会造出一个 plan 不可能产生的组合（摘要里的 px/格 与提示里的 px/格
    // 不一致），于是这条用例连摘要尾注都测不到（实跑时它红在「期望 31、得到 40」）。
    layoutStub.planSheets = () => ({
      ...realPlan,
      cellPx: 31,
      labels: false,
      warnings: [{ code: "labels-omitted", maxEdge: 1143, cellPx: 31 }],
    });

    const wrapper = mountPanel(small);
    expect(wrapper.get("[data-testid='export-summary-sheet']").text()).toBe(
      "共 1 张 · 每片最多 4×2 格 · 31 px/格 · 已省略格内色号（画布上限 1143 px 太小）",
    );
    const warning = wrapper.get("[data-testid='export-warning-labels']");
    expect(warning.text()).toBe(
      "画布上限只有 1143 px，格内色号画不下（每格 31 px，低于 32 px）；建议减少豆数或改小图纸。",
    );
    // 「琥珀」不是形容词：它必须落在本仓库既有的「要用户注意、但不拦」配色上
    expect(warning.classes()).toContain("text-amber-700");
  });
});

describe("逐项导出：一次手势一张（规格 §10.3 / R-5）", () => {
  it("待生成 → 生成中… → 已生成：期间按钮禁用，画布尺寸取自 plan，预览指向同一颗 blob", async () => {
    const wrapper = mountPanel(makeSmallPattern());
    const item = () => wrapper.get("[data-testid='export-item-legend']");
    expect(item().text()).toContain("待生成");
    expect(wrapper.get("[data-testid='export-save-legend']").attributes("disabled")).toBeUndefined();
    expect(wrapper.find("[data-testid='export-preview-legend']").exists()).toBe(false);

    // 卡住 `canvasToBlob`，让「生成中」成为可观察状态（它本来只存在于两个微任务之间）
    let release = (): void => {};
    exporter.canvasToBlob.mockImplementationOnce(
      () =>
        new Promise<Blob>((resolve) => {
          release = () => {
            resolve(new Blob([new Uint8Array([1])], { type: "image/png" }));
          };
        }),
    );

    await wrapper.get("[data-testid='export-save-legend']").trigger("click");
    expect(item().text()).toContain("生成中…");
    expect(wrapper.get("[data-testid='export-save-legend']").attributes("disabled")).toBeDefined();

    release();
    await flushPromises();

    expect(item().text()).toContain("已生成");
    expect(wrapper.get("[data-testid='export-save-legend']").attributes("disabled")).toBeUndefined();
    // 预览就是刚下载的那一颗字节：`<img src>` = 那次 `createObjectURL` 的返回值
    expect(wrapper.get("[data-testid='export-preview-legend']").attributes("src")).toBe(
      createdUrls[0],
    );
    // **画布尺寸取自 plan**：用量表计划的 3948×230（不是别处的常量、不是缩略图的 512 上限）
    expect(exporter.createCanvasStrict).toHaveBeenCalledWith(3948, 230);
    // 面板确实把**真渲染器**跑在它自己那份 plan 上（尺寸那条钉的是尺寸，这条钉的是真的画了）
    expect(recording.fills.length).toBeGreaterThan(0);

    // 落盘的名字带着工程名与这一类产物的中文标签（逐字格式由任务 3 的用例负责）
    expect(exporter.downloadBlob).toHaveBeenCalledTimes(1);
    const [blobArg, filenameArg] = exporter.downloadBlob.mock.calls[0];
    expect(blobArg.size).toBeGreaterThan(0);
    expect(filenameArg).toContain("小猫");
    expect(filenameArg).toContain("用量表");
    expect(filenameArg.endsWith(".png")).toBe(true);
  });

  it("一项失败不影响其他项：失败只写该项的状态与中文原因，重试仍可成功", async () => {
    const wrapper = mountPanel(makeSmallPattern());
    // 契约 §3 的逐字消息：`toBlob` 给 null 时 `canvasToBlob` 的 reject 原因
    exporter.canvasToBlob.mockRejectedValueOnce(new Error("导出 PNG 失败：toBlob 返回了 null"));

    await saveAndSettle(wrapper, "legend");
    expect(wrapper.get("[data-testid='export-item-legend']").text()).toContain(
      "失败：导出 PNG 失败：toBlob 返回了 null",
    );
    // 其他项**一个都没被带下水**：状态仍是「待生成」、没有预览、按钮仍可点
    expect(wrapper.get("[data-testid='export-item-share']").text()).toContain("待生成");
    expect(wrapper.get("[data-testid='export-item-tile-0']").text()).toContain("待生成");
    expect(wrapper.find("[data-testid='export-preview-legend']").exists()).toBe(false);
    expect(exporter.downloadBlob).not.toHaveBeenCalled();

    // 失败不是终态：这一项自己重试成功
    await saveAndSettle(wrapper, "legend");
    expect(wrapper.get("[data-testid='export-item-legend']").text()).toContain("已生成");

    // 另一项独立走通（下载与预览都发生）
    await saveAndSettle(wrapper, "share");
    expect(wrapper.get("[data-testid='export-item-share']").text()).toContain("已生成");
    expect(exporter.downloadBlob).toHaveBeenCalledTimes(2);
  });

  it("改一格（revision 变）⇒ 所有「已生成」复位为「待生成」，预览销号后丢弃", async () => {
    const wrapper = mountPanel(makeSmallPattern());
    await saveAndSettle(wrapper, "legend");
    await saveAndSettle(wrapper, "share");
    expect(wrapper.get("[data-testid='export-item-legend']").text()).toContain("已生成");
    expect(wrapper.get("[data-testid='export-item-share']").text()).toContain("已生成");
    expect(wrapper.find("[data-testid='export-preview-legend']").exists()).toBe(true);
    expect(createdUrls).toHaveLength(2);

    await wrapper.setProps({ revision: 1 });
    await flushPromises();

    // ① **所有**项回「待生成」（只复位被点过的那一两项会在这里红）
    for (const id of ["legend", "share", "tile-0"]) {
      const text = wrapper.get(`[data-testid='export-item-${id}']`).text();
      expect(text).toContain("待生成");
      expect(text).not.toContain("已生成");
    }
    // ② 预览**销号后**丢弃：`<img>` 消失，且两个 object URL 都被 revoke
    //    （只清 `previewUrl`、不调 `revokeObjectURL` 的写法在最后一条上红——那是一处真实的泄漏）
    expect(wrapper.find("[data-testid='export-preview-legend']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='export-preview-share']").exists()).toBe(false);
    expect(revokedUrls).toEqual(createdUrls);
  });

  it("渲染完先自检、再 toBlob；分享图**故意不**自检（它按设计是透明的）", async () => {
    const wrapper = mountPanel(makeSmallPattern());

    await saveAndSettle(wrapper, "legend");
    // 顺序断言（`steps` 由假画布与两个桩按真实发生顺序记下）：自检必须**早于** toBlob——
    // 反过来的话，一张「看起来正常」的白图已经落盘了才被发现（规格 §9 第 5 条的整条目的）。
    expect(steps).toEqual(["selfcheck", "toBlob", "release:width", "release:height"]);
    expect(exporter.assertCanvasPainted).toHaveBeenCalledTimes(1);
    expect(exporter.assertCanvasPainted).toHaveBeenCalledWith(canvases[0]?.canvas);

    // 施工图那一项同样要自检（用量表与施工图**都**有「必定不透明」的左上角边距采样点 `(2, 2)`）
    steps = [];
    await saveAndSettle(wrapper, "tile-0");
    expect(exporter.assertCanvasPainted).toHaveBeenCalledTimes(2);
    expect(steps).toEqual(["selfcheck", "toBlob", "release:width", "release:height"]);

    // 分享图是**纯色块、空格透明**的产物：`(2, 2)` 这类采样点落在透明像素上是完全合法的，
    // 所以它没有「必定不透明」的位置可采（§9 第 5 条要求采样点与图纸内容无关）⇒ **故意不调**。
    // 少了这条反向断言，后人会以为是漏了、然后顺手补上——于是一张合法的全透明分享图会被自检
    // 判成失败。
    steps = [];
    await saveAndSettle(wrapper, "share");
    expect(exporter.assertCanvasPainted).toHaveBeenCalledTimes(2);
    expect(steps).toEqual(["toBlob", "release:width", "release:height"]);
  });

  it("逐张渲染后即时释放画布：成功与失败两条路径都写回 0，且释放晚于 toBlob", async () => {
    const wrapper = mountPanel(makeSmallPattern());
    await saveAndSettle(wrapper, "tile-0");
    expect(canvases).toHaveLength(1);
    // 顺序与内容一起断：**toBlob 之后**才释放（提前释放＝拿着 0×0 的画布去 toBlob，生产上就是空图）
    expect(steps).toEqual(["selfcheck", "toBlob", "release:width", "release:height"]);
    expect(canvases[0]?.writes).toEqual([
      ["width", 0],
      ["height", 0],
    ]);
    expect(wrapper.get("[data-testid='export-item-tile-0']").text()).toContain("已生成");

    // 失败分支：`canvasToBlob` reject（契约 §3 的逐字原因）时**照样释放**——所以它在 `finally` 里。
    // 少了这一条，`try` 里直接释放的写法会在失败路径上把画布留到下一次 GC（内存峰值不再是一张）。
    canvases = [];
    steps = [];
    exporter.canvasToBlob.mockRejectedValueOnce(new Error("导出 PNG 失败：toBlob 返回了 null"));
    await saveAndSettle(wrapper, "share");

    expect(canvases).toHaveLength(1);
    expect(canvases[0]?.writes).toEqual([
      ["width", 0],
      ["height", 0],
    ]);
    expect(wrapper.get("[data-testid='export-item-share']").text()).toContain(
      "失败：导出 PNG 失败：toBlob 返回了 null",
    );
  });
});

describe("空图纸与 props 驱动（规格 §10.4 / 契约 §2b）", () => {
  it("用量表为空时给一行如实说明，不拦也不假装成功", () => {
    const wrapper = mountPanel(makeSmallPattern(), { usages: [] });
    expect(wrapper.get("[data-testid='export-empty-note']").text()).toBe("这张图纸没有可拼的像素");
    // 说明是**信息**，不是禁用：这一项照样可以保存（规格 §10.4：用户可能就是想导出这张空图）
    expect(wrapper.get("[data-testid='export-save-legend']").attributes("disabled")).toBeUndefined();
    expect(wrapper.get("[data-testid='export-item-legend']").text()).toContain("待生成");
  });

  it("只给 props 就能完整工作：本文件全程不建 pinia，源码里也没有任何 store 的 import", async () => {
    // 运行时证明：挂载 + 真的生成一项，全程没有任何 pinia 实例
    const wrapper = mountPanel(makeSmallPattern());
    await saveAndSettle(wrapper, "tile-0");
    expect(wrapper.get("[data-testid='export-item-tile-0']").text()).toContain("已生成");

    // 源码级证明（词法近似，与 `coreBoundary` 同一口径）：`from "…/stores/…"` 一次都不许出现。
    // 已知偏差：`require("@/stores/editor")` 或动态 import 里的字符串绕得过这道闸门——它挡的是
    // 「后人顺手加一个 store 依赖」，不是刻意规避。
    const source = PANEL_SOURCES["../ExportPanel.vue"] ?? "";
    expect(source.length).toBeGreaterThan(0);
    expect(/from\s+["'][^"']*\/stores\//.test(source)).toBe(false);
  });
});
