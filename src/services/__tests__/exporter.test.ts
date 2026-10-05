import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertCanvasPainted,
  canvasToBlob,
  createCanvasStrict,
  downloadBlob,
  exportFilename,
  requireContext2D,
  type ExportItemLabel,
} from "../exporter";

/**
 * 这个文件测的是**平台边界**，不是像素。happy-dom 20.14.5 的四条环境事实（本机实测，
 * 见计划片段 task-03 的环境事实表）：
 *
 * 1. `HTMLCanvasElement.prototype.getContext("2d")` **返回 `null`**：本仓没有装 `@happy-dom/canvas`，
 *    `settings.canvasAdapter` 是 `undefined`。所以真画布上「拿不到上下文」是**默认状态**，
 *    「拿到上下文」只能靠桩。这也意味着任何依赖真实 `getImageData` / `toDataURL` 的断言都是假绿。
 * 2. 真画布的 `width` / `height` **永不钳制**（写 8192 读回 8192）⇒ `createCanvasStrict` 的
 *    「回读不一致」这条守卫在真元素上**永远走不到**，必须自造一个会钳制的画布替身（`makeCanvasStub`）。
 *    这是本文件唯一能测到规格 §8 那条守卫的办法。
 * 3. `toBlob` **存在**，但没有 adapter 时它走 `requestAnimationFrame(() => callback(new Blob([])))`
 *    ——给的是**大小 0 的 Blob，永远不是 `null`**。拿真画布跑 `canvasToBlob` 只会 resolve 一个空 blob
 *    （随后被 `downloadBlob` 以「导出内容为空」拒绝），`null` 分支根本走不到 ⇒ 用 `makeToBlobCanvas`。
 * 4. `URL.createObjectURL` / `revokeObjectURL` **存在**（返回 `blob:nodedata:<uuid>`），但返回值不可预测、
 *    断言不了「传进去的是哪个 blob」⇒ 一律 `vi.stubGlobal("URL", …)` 换掉，使实参可逐位断言。
 *
 * 真实像素的观感（色号可读、接缝不错行、信息条真的被画过）在规格 §14 的人工清单里，本文件
 * **不**把它写成断言（那会是恒真断言，规格 §13.4）。
 */

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface CreateElementStub {
  /** 每次 `document.createElement("canvas")` 交出的元素（长度即创建次数）。 */
  readonly canvases: HTMLCanvasElement[];
  /** 每次 `document.createElement("a")` 交出的元素（长度即创建次数）。 */
  readonly anchors: HTMLAnchorElement[];
}

/**
 * 换掉 `document.createElement`，只拦 `"canvas"` 与 `"a"`，其余标签原样透传
 * （`@vue/test-utils` / happy-dom 自己都要用真 `createElement`，账本 B2 记过这条）。
 *
 * `onCreateAnchor` 让用例在**元素一被创建**时就替换它的 `click`：happy-dom 里点一个
 * `href="blob:…"` 的锚点会走它自己的导航逻辑（`window.open`），那不是本文件要测的东西；
 * 在实例上换掉 `click` 之后，「实现调用过 `link.click()`」仍然被钉死。
 */
function stubCreateElement(
  makeCanvas: () => HTMLCanvasElement,
  onCreateAnchor?: (anchor: HTMLAnchorElement) => void,
): CreateElementStub {
  const canvases: HTMLCanvasElement[] = [];
  const anchors: HTMLAnchorElement[] = [];
  const original = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((
    tag: string,
    options?: ElementCreationOptions,
  ) => {
    if (tag === "canvas") {
      const canvas = makeCanvas();
      canvases.push(canvas);
      return canvas;
    }
    if (tag === "a") {
      const anchor = original("a", options) as HTMLAnchorElement;
      onCreateAnchor?.(anchor);
      anchors.push(anchor);
      return anchor;
    }
    return original(tag, options);
  }) as typeof document.createElement);
  return { canvases, anchors };
}

interface CanvasStubOptions {
  /** 写入 `width` 之后浏览器**实际留下**的值（模拟超限钳制）。缺省 = 原样留下。 */
  readonly clampWidthTo?: number;
  readonly clampHeightTo?: number;
  /** `getContext("2d")` 的返回值；缺省 `null`（happy-dom 无 canvas adapter 时的真实行为）。 */
  readonly context?: CanvasRenderingContext2D | null;
}

interface CanvasStub {
  readonly canvas: HTMLCanvasElement;
  /** 每次写 `width` 的实参（证明尺寸确实被写下去过）。 */
  readonly widthWrites: number[];
  readonly heightWrites: number[];
  /** 每次 `getContext` 的实参（证明问的是 `"2d"`）。 */
  readonly contextCalls: string[];
}

/**
 * **会钳制的画布替身**：这是本文件唯一能打中 `createCanvasStrict` 回读校验的办法，因为 happy-dom 的
 * 真 `HTMLCanvasElement` 写什么读什么（环境事实第 2 条），那条守卫在真元素上永远走不到。
 */
function makeCanvasStub(options: CanvasStubOptions = {}): CanvasStub {
  const widthWrites: number[] = [];
  const heightWrites: number[] = [];
  const contextCalls: string[] = [];
  const state = { width: 0, height: 0 };
  const stub = {
    get width(): number {
      return state.width;
    },
    set width(value: number) {
      widthWrites.push(value);
      state.width = options.clampWidthTo === undefined ? value : Math.min(value, options.clampWidthTo);
    },
    get height(): number {
      return state.height;
    },
    set height(value: number) {
      heightWrites.push(value);
      state.height =
        options.clampHeightTo === undefined ? value : Math.min(value, options.clampHeightTo);
    },
    getContext(kind: string): CanvasRenderingContext2D | null {
      contextCalls.push(kind);
      return kind === "2d" ? (options.context ?? null) : null;
    },
  };
  return { canvas: stub as unknown as HTMLCanvasElement, widthWrites, heightWrites, contextCalls };
}

interface ToBlobStub {
  readonly canvas: HTMLCanvasElement;
  /** 每次 `toBlob` 请求的 MIME（长度即调用次数）。 */
  readonly requestedTypes: (string | undefined)[];
  /** 由用例自己把回调结果喂回去 ⇒ 分别造「给 blob」与「给 null」两种情形。 */
  fire(blob: Blob | null): void;
}

/**
 * 只实现 `toBlob` 的画布替身。**不能用真画布**：happy-dom 的 `toBlob` 没有 adapter 时给的是
 * 大小 0 的 Blob（环境事实第 3 条），`null` 分支根本走不到。
 */
function makeToBlobCanvas(): ToBlobStub {
  let callback: BlobCallback | null = null;
  const requestedTypes: (string | undefined)[] = [];
  const canvas = {
    toBlob(cb: BlobCallback, type?: string): void {
      requestedTypes.push(type);
      callback = cb;
    },
  } as unknown as HTMLCanvasElement;
  return {
    canvas,
    requestedTypes,
    fire(blob: Blob | null): void {
      const take = callback;
      if (take === null) {
        throw new Error("toBlob 还没被调用：用例要先调 canvasToBlob(canvas)");
      }
      take(blob);
    },
  };
}

const OBJECT_URL = "blob:weefuse-fake-url";

/** 换掉全局 `URL`（契约 §5 第 2 条：不要依赖它存在，也不要依赖它的返回值）。 */
function stubUrlApi() {
  const createObjectURL = vi.fn((_blob: Blob) => OBJECT_URL);
  const revokeObjectURL = vi.fn((_url: string) => undefined);
  vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
  return { createObjectURL, revokeObjectURL };
}

/** 2D 上下文替身：只实现自检真正调用的那一个方法，并记录被读的像素坐标。 */
function stubPainted(pixel: readonly [number, number, number, number]): {
  readonly canvas: HTMLCanvasElement;
  readonly sampleCalls: number[][];
} {
  const sampleCalls: number[][] = [];
  const ctx = {
    getImageData: (x: number, y: number, width: number, height: number) => {
      sampleCalls.push([x, y, width, height]);
      return { width, height, data: new Uint8ClampedArray(pixel) } as unknown as ImageData;
    },
  } as unknown as CanvasRenderingContext2D;
  // happy-dom 默认 `getContext("2d") === null`（环境事实第 1 条），所以这里必须装替身。
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
    this: HTMLCanvasElement,
    ...args: unknown[]
  ) {
    return args[0] === "2d" ? ctx : null;
  });
  return { canvas: document.createElement("canvas"), sampleCalls };
}

describe("createCanvasStrict", () => {
  it("正常尺寸：建的就是 canvas、宽高被写下去、原样返回该元素", () => {
    const stub = makeCanvasStub();
    const created = stubCreateElement(() => stub.canvas);

    const canvas = createCanvasStrict(2432, 2564);

    expect(canvas).toBe(stub.canvas);
    expect(stub.widthWrites).toEqual([2432]);
    expect(stub.heightWrites).toEqual([2564]);
    expect(canvas.width).toBe(2432);
    expect(canvas.height).toBe(2564);
    expect(created.canvases).toHaveLength(1);
  });

  it("宽高非法 ⇒ 抛，且在任何建画布 / 写宽高之前（入口校验先于写操作）", () => {
    const stub = makeCanvasStub();
    const created = stubCreateElement(() => stub.canvas);

    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createCanvasStrict(bad, 16)).toThrow("画布宽高必须是 ≥1 的整数");
      expect(() => createCanvasStrict(16, bad)).toThrow("画布宽高必须是 ≥1 的整数");
    }

    // 拷问「守卫是不是真的写在了写操作之前」：把守卫挪到 createElement 之后，这两条会红。
    expect(created.canvases).toEqual([]);
    expect(stub.widthWrites).toEqual([]);
    expect(stub.heightWrites).toEqual([]);
  });
});

describe("requireContext2D", () => {
  it('拿到上下文就原样返回，问的是 "2d"', () => {
    const ctx = { fillStyle: "" } as unknown as CanvasRenderingContext2D;
    const stub = makeCanvasStub({ context: ctx });

    expect(requireContext2D(stub.canvas)).toBe(ctx);
    expect(stub.contextCalls).toEqual(["2d"]);
  });

  it("getContext 返回 null ⇒ 抛（happy-dom 无 canvas adapter 时的真实情形）", () => {
    const stub = makeCanvasStub();
    expect(() => requireContext2D(stub.canvas)).toThrow("无法获取 2D 上下文");
  });
});

describe("canvasToBlob", () => {
  it("Promise 化 toBlob：请求 image/png，回调给的 blob 原样 resolve", async () => {
    const stub = makeToBlobCanvas();
    const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });

    const promise = canvasToBlob(stub.canvas);
    expect(stub.requestedTypes).toEqual(["image/png"]);
    stub.fire(png);

    await expect(promise).resolves.toBe(png);
  });

  it("回调给 null ⇒ reject（不静默 resolve 一个空结果）", async () => {
    const stub = makeToBlobCanvas();

    const promise = canvasToBlob(stub.canvas);
    stub.fire(null);

    await expect(promise).rejects.toThrow("导出 PNG 失败：toBlob 返回了 null");
  });
});

describe("downloadBlob", () => {
  it("恰好建一个 <a>、点一次、建与回收各一次 object URL；属性与顺序都对", () => {
    const url = stubUrlApi();
    const clickSpies: ReturnType<typeof vi.fn>[] = [];
    const created = stubCreateElement(
      () => {
        throw new Error("downloadBlob 不该创建画布");
      },
      (anchor) => {
        const click = vi.fn();
        clickSpies.push(click);
        anchor.click = click;
      },
    );
    const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });

    downloadBlob(png, "图纸-施工图-r1c1.png");

    expect(created.anchors).toHaveLength(1);
    expect(created.canvases).toEqual([]);
    const anchor = created.anchors[0]!;
    expect(anchor.getAttribute("href")).toBe(OBJECT_URL);
    expect(anchor.getAttribute("download")).toBe("图纸-施工图-r1c1.png");
    // 实现的 JSDoc 声明「不挂进 DOM」：挂进去就必须配一次 remove()，而 `remove()` 位于 `click()` 之后，
    // 那条清理会在 click 抛错时漏掉（object URL 则由 `finally` 兜住——见本 describe 的 F4 那条用例）。
    expect(anchor.parentNode).toBeNull();
    expect(clickSpies).toHaveLength(1);
    expect(clickSpies[0]).toHaveBeenCalledTimes(1);
    expect(url.createObjectURL.mock.calls).toEqual([[png]]);
    expect(url.revokeObjectURL.mock.calls).toEqual([[OBJECT_URL]]);
    // 顺序：先 click 后 revoke。反过来的话部分浏览器会在数据被读走之前把它释放掉。
    expect(clickSpies[0]!.mock.invocationCallOrder[0]!).toBeLessThan(
      url.revokeObjectURL.mock.invocationCallOrder[0]!,
    );
  });

  it("blob 大小为 0 ⇒ 抛（不产出一个 0 字节的 png）", () => {
    stubUrlApi();
    stubCreateElement(() => makeCanvasStub().canvas);

    expect(() => downloadBlob(new Blob([]), "图纸-分享图.png")).toThrow(
      "导出内容为空（blob 大小为 0）",
    );
  });

  it("click 抛错 ⇒ 异常照常上抛，但 object URL 仍被恰好回收一次（F4 的靶子）", () => {
    const url = stubUrlApi();
    const boom = new Error("下载被拒绝");
    stubCreateElement(
      () => {
        throw new Error("downloadBlob 不该创建画布");
      },
      (anchor) => {
        anchor.click = () => {
          throw boom;
        };
      },
    );
    const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });

    // 不吞异常：失败要能被面板看见（面板把它渲染成「失败：原因」）。
    expect(() => downloadBlob(png, "图纸-施工图-r1c1.png")).toThrow(boom);
    // 但回收必须照做，且只做一次：写在 click 之后的顺序语句会在这一路径上漏掉回收（blob URL 泄漏）。
    expect(url.revokeObjectURL.mock.calls).toEqual([[OBJECT_URL]]);
  });

  it("写进 download 属性的是去空白后的名字（F5 的靶子）", () => {
    stubUrlApi();
    const created = stubCreateElement(
      () => {
        throw new Error("downloadBlob 不该创建画布");
      },
      (anchor) => {
        anchor.click = vi.fn();
      },
    );
    const png = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });

    downloadBlob(png, "  图纸-施工图-r1c1.png  ");

    // trim 之后的 `safeName` 才写进属性；写成未 trim 的原始实参会让下载文件名带前后空格。
    expect(created.anchors[0]!.getAttribute("download")).toBe("图纸-施工图-r1c1.png");
  });
});

describe("exportFilename", () => {
  it("施工图带 r{行}c{列}（1 起），用量表 / 分享图不带序号", () => {
    expect(exportFilename("小猫", "施工图", { rowIndex: 0, colIndex: 0 })).toBe("小猫-施工图-r1c1.png");
    expect(exportFilename("小猫", "施工图", { rowIndex: 2, colIndex: 4 })).toBe("小猫-施工图-r3c5.png");
    expect(exportFilename("小猫", "用量表")).toBe("小猫-用量表.png");
    expect(exportFilename("小猫", "分享图")).toBe("小猫-分享图.png");
  });
});

describe("assertCanvasPainted（§9 第 5 条）", () => {
  it("读回白色即通过，且采样点就是 (2, 2, 1, 1)", () => {
    const { canvas, sampleCalls } = stubPainted([255, 255, 255, 255]);

    expect(() => assertCanvasPainted(canvas)).not.toThrow();
    // 采样点必须是 (2, 2)：它在左上角边距里，始终被白底覆盖且不放任何文字，对合法图纸不可能误报。
    // 挪到「最后一格」会落到空格上、对合法图纸误报；挪到任何别处都会被这条断言抓住
    // （判别力来自坐标被钉住，不是来自 happy-dom 的像素——它没有真实像素语义）。
    expect(sampleCalls).toEqual([[2, 2, 1, 1]]);
  });

  it("读回全 0 ⇒ 抛契约 §3 的那条消息（带读回值）", () => {
    const { canvas } = stubPainted([0, 0, 0, 0]);

    expect(() => assertCanvasPainted(canvas)).toThrow(
      "画布内容自检失败：(2, 2) 读回 0,0,0,0（期望 255,255,255,255）",
    );
  });
});

describe("createCanvasStrict：回读校验（M8 的靶子）", () => {
  it("超限被静默钳制 ⇒ 抛，消息带期望与实际", () => {
    const stub = makeCanvasStub({ clampWidthTo: 4096, clampHeightTo: 4096 });
    stubCreateElement(() => stub.canvas);

    expect(() => createCanvasStrict(8192, 8192)).toThrow(
      "画布尺寸被浏览器钳制：期望 8192×8192，实际 4096×4096",
    );
  });

  it("被置 0 同样被抓（另一种真实的钳制形态）", () => {
    const stub = makeCanvasStub({ clampWidthTo: 0, clampHeightTo: 0 });
    stubCreateElement(() => stub.canvas);

    expect(() => createCanvasStrict(8192, 8192)).toThrow(
      "画布尺寸被浏览器钳制：期望 8192×8192，实际 0×0",
    );
  });

  it("只差一轴也算钳制（不能被「另一轴相等」骗过去）", () => {
    const stub = makeCanvasStub({ clampHeightTo: 4096 });
    stubCreateElement(() => stub.canvas);

    expect(() => createCanvasStrict(8192, 8192)).toThrow("画布尺寸被浏览器钳制");
  });
});

describe("downloadBlob：守卫先于副作用", () => {
  it("文件名清洗后为空 ⇒ 抛，且没有建 object URL、没有建元素", () => {
    const url = stubUrlApi();
    const created = stubCreateElement(() => makeCanvasStub().canvas);

    expect(() => downloadBlob(new Blob([new Uint8Array([1])]), "  \t ")).toThrow("文件名不能为空");

    expect(url.createObjectURL).not.toHaveBeenCalled();
    expect(created.anchors).toEqual([]);
  });

  it("blob 大小为 0 ⇒ 抛，同样在任何副作用之前（不留悬挂的 blob URL）", () => {
    const url = stubUrlApi();
    const created = stubCreateElement(() => makeCanvasStub().canvas);

    expect(() => downloadBlob(new Blob([]), "图纸-分享图.png")).toThrow(
      "导出内容为空（blob 大小为 0）",
    );

    expect(url.createObjectURL).not.toHaveBeenCalled();
    expect(created.anchors).toEqual([]);
  });
});

describe("exportFilename：清洗与序号守卫（M13 的靶子）", () => {
  it("复用 normalizeProjectName：前后空白被清掉（不写第二份清洗）", () => {
    expect(exportFilename("  小猫  ", "分享图")).toBe("小猫-分享图.png");
  });

  it("名字清洗后为空 ⇒ 抛 normalizeProjectName 的原消息（不吞、不改写）", () => {
    expect(() => exportFilename("   ", "分享图")).toThrow("工程名称不能为空");
  });

  it("100 字合法、101 字抛（长度上限来自 normalizeProjectName，不在这里重写）", () => {
    const longest = "图".repeat(100);
    expect(exportFilename(longest, "用量表")).toBe(`${longest}-用量表.png`);
    expect(() => exportFilename("图".repeat(101), "分享图")).toThrow("工程名称不能超过 100 个字符");
  });

  it("非字符串名字 ⇒ 抛（TS 类型挡不住运行期输入）", () => {
    expect(() => exportFilename(42 as unknown as string, "分享图")).toThrow("工程名称必须是字符串");
  });

  it("施工图缺分片序号 ⇒ 抛", () => {
    expect(() => exportFilename("小猫", "施工图")).toThrow("施工图的分片序号缺失");
  });

  it("用量表 / 分享图带了 tile ⇒ 抛（静默忽略会让调用方以为自己传对了）", () => {
    expect(() => exportFilename("小猫", "用量表", { rowIndex: 0, colIndex: 0 })).toThrow(
      "用量表 / 分享图不带分片序号",
    );
    expect(() => exportFilename("小猫", "分享图", { rowIndex: 3, colIndex: 4 })).toThrow(
      "用量表 / 分享图不带分片序号",
    );
  });

  it("分片序号必须是 ≥0 的安全整数 ⇒ 否则抛（负数会静默产出 r0c0）", () => {
    expect(() => exportFilename("小猫", "施工图", { rowIndex: -1, colIndex: 0 })).toThrow(
      "分片序号非法：-1, 0（必须是 ≥0 的安全整数）",
    );
    expect(() => exportFilename("小猫", "施工图", { rowIndex: 0, colIndex: 1.5 })).toThrow(
      "分片序号非法：0, 1.5（必须是 ≥0 的安全整数）",
    );
  });

  it("非安全整数同样抛：1e21 是「≥0 的整数」但 1e21 + 1 === 1e21（F2 的靶子）", () => {
    // 判据是 Number.isSafeInteger（不是 isInteger）：片号加一之后必须真的变成另一个片号。
    // 消息里的数字是 JS 自己的 String(1e21) = "1e+21"，据实断言，不美化。
    expect(() => exportFilename("小猫", "施工图", { rowIndex: 1e21, colIndex: 0 })).toThrow(
      "分片序号非法：1e+21, 0（必须是 ≥0 的安全整数）",
    );
    // 最小的非安全整数（2^53）用干净的十进制写出来，免得这条覆盖吊在指数记法上。
    expect(() => exportFilename("小猫", "施工图", { rowIndex: 0, colIndex: 2 ** 53 })).toThrow(
      "分片序号非法：0, 9007199254740992（必须是 ≥0 的安全整数）",
    );
  });

  it("内容标签非法 ⇒ 抛（运行期不认 TS 类型）", () => {
    expect(() => exportFilename("小猫", "海报" as unknown as ExportItemLabel)).toThrow(
      "导出内容标签非法：海报",
    );
  });
});

describe("assertCanvasPainted：判据与守卫的接线", () => {
  it("只差一个通道也要红（半透明 / 偏色不能被当成「画过了」）", () => {
    // 四个像素各差一个通道（A / R / G / B）：删掉判据里任何一个 `data[i] !== 255` 都必须有且只有一条红，
    // 否则那个通道就是「只被间接覆盖」——审查实测：删 `data[1] !== 255 ||` 时 26 条全绿（F3）。
    for (const pixel of [
      [255, 255, 255, 254],
      [254, 255, 255, 255],
      [255, 0, 255, 255],
      [255, 255, 0, 255],
    ] as const) {
      const { canvas } = stubPainted(pixel);
      expect(() => assertCanvasPainted(canvas)).toThrow("画布内容自检失败：(2, 2) 读回");
    }
  });

  it("拿不到 2D 上下文时复用同一处 null 守卫（不写第二份检查）", () => {
    // 不装任何桩：happy-dom 无 canvas adapter ⇒ 真元素上 getContext("2d") 就是 null。
    const canvas = document.createElement("canvas");
    expect(() => assertCanvasPainted(canvas)).toThrow("无法获取 2D 上下文");
  });
});
