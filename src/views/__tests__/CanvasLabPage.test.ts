import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import CanvasLabPage from "@/views/CanvasLabPage.vue";

/**
 * `/lab/canvas` 探针页的组件用例。
 *
 * **这一份用例只覆盖一件事**（B4 规格 §13.4）：**页面把给定的读数渲染成表格与结论文案**。
 * 真实上限、真实像素语义、真实钳制行为都测不到——happy-dom 的 canvas 是桩。
 *
 * **哪些是桩**：`document.createElement("canvas")` 整个换成 `FakeCanvas`（可配置「钳制阈值」
 * 「有没有 2D 上下文」「`getContext` 会不会抛错 / 抛空 message 的 Error / 抛非 Error 值」
 * 「读回会不会抛错」「读回一个别的颜色」「只在小档位上读回别的颜色」，并记录 `getImageData` 调用次数）；
 * `navigator.clipboard` 显式定义 / 显式置 `undefined` / 显式让它 `writeText` 抛错。
 * 桩里的「读回」是把写进去的 `fillStyle` 原样返回，**不是**真实像素语义。
 *
 * **哪些只能人工**（B4 规格 §14 清单 3，写在这里防止后来者以为 CI 覆盖了它）：
 * ① 真机上的单边 / 面积上限数值；② `getImageData` 的真实像素语义（真实平台还有预乘 alpha、色彩管理）；
 * ③ 真实浏览器对超限画布的钳制形态（置 0 / 截断 / `getContext` 返回 null / 直接崩标签页）。
 *
 * **这一份用例能证明的**：判定列把「通过 / 被钳制 / 无 2D 上下文 / 像素读不回」如实分开；
 * **判据 3 的两半各有一条「必须不通过」的用例**（读回抛错 ⇒ 不通过；读回能读、但不是写入的颜色
 * ⇒ 不通过——只判「非抛错即通过」会红）；**被钳制的档位一次 `getImageData` 都没调用**；
 * 没有区间时结论**不外推**（「上界未触及」「没有可收敛的下界」都如实写出来），且**读数非单调时
 * 结论不会写成「全部 17 档通过」**（那句话现在从同一份读数派生）；页面上**唯一的兜底路径**
 * （`run()` 的 `catch`）真的把原因显示成非空红字、而不是崩页或渲染出 `undefined`，且两个冷门分支
 * （空 message 的 `Error` 取 `name`、非 `Error` 取 `String(e)`）各有一条用例；**「复制为文本」的正文**
 * （表头 + 逐档原始读数 + 回写规程）与它的两个失败分支（没有剪贴板 API、`writeText` 抛错）都被读过。
 */

const EDGE_SHORT = 64;
/** 档位梯（与页面 / 规格 §11 逐字相同）：这里**写死**——改档位梯时它必须跟着改，否则红。 */
const LADDER = [
  1024, 1280, 1536, 1792, 2048, 2560, 3072, 3584, 4096, 5120, 6144, 8192,
  10240, 12288, 16384, 24576, 32768,
] as const;
const BISECT_STEPS = 8;
const CLAMP = 4096;
const PROBE_PIXEL = "17,99,200,255";

type Rgb = readonly [number, number, number];

interface FakeOptions {
  /** 写入超过它就被「钳制」：`canvas.width` / `height` 读回该值（模拟浏览器的静默钳制）。 */
  readonly clampAbove?: number | null;
  /** `getContext("2d")` 返回 null。 */
  readonly withoutContext?: boolean;
  /** `getContext("2d")` 直接抛错（模拟平台级失败：页面的兜底红字路径）。 */
  readonly throwOnContext?: boolean;
  /** `getContext("2d")` 抛一个 **message 为空**、`name` 为这个字符串的 `Error`（钉住 `errorText` 的「空串取 name」分支）。 */
  readonly throwEmptyMessageNamed?: string | null;
  /** `getContext("2d")` 直接抛这个**非 `Error`** 值（钉住 `errorText` 的「非 Error 取 String(e)」分支）。 */
  readonly throwValue?: unknown;
  /** `getImageData` 抛错（模拟超大画布上的读取失败）。 */
  readonly throwOnRead?: boolean;
  /**
   * 读回**这个颜色**而不是填进去的探针色（三通道都非 0 / 255）。
   * 用来钉住判据 3 的「颜色相等」半边：读到了像素、但读到的不是写入的颜色 ⇒ **必须不通过**。
   */
  readonly readbackColor?: Rgb | null;
  /**
   * 只在「请求尺寸的长边 ≤ 它」的档位上用 `readbackColor`（模拟**非单调读数**：
   * 小档读不回、大档反而通过）。用来钉住 `no-upper` 的结论必须从同一份读数派生。
   */
  readonly readbackColorMaxEdge?: number | null;
}

function parseRgb(css: string): Rgb | null {
  const match = /rgb\((\d+), (\d+), (\d+)\)/.exec(css);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

class FakeCanvas {
  /** 当前的请求宽高（会被页面在测完一档后置 0）。 */
  requestedWidth = 0;
  requestedHeight = 0;
  /**
   * **非 0 的写入值**（页面每档测完会把宽高置 0，置 0 时这里不跟着丢）。
   * 用例据此把数组里的假画布按「测的是哪一档」找回来，断言 `readCount`。
   */
  measuredWidth = 0;
  measuredHeight = 0;
  /**
   * `getImageData` 被调用的次数（F4）：用来证明「被钳制时不读像素」不是一句空话——
   * 被钳制那一档的计数必须是 0，而同一方向通过档的计数必须是 1（否则计数器本身没生效、0 就是恒真）。
   */
  readCount = 0;
  private fill = "";
  private filled: Rgb | null = null;

  constructor(private readonly options: FakeOptions) {}

  private clamp(value: number): number {
    const cap = this.options.clampAbove ?? null;
    return cap === null ? value : Math.min(value, cap);
  }

  get width(): number {
    return this.clamp(this.requestedWidth);
  }
  set width(value: number) {
    this.requestedWidth = value;
    if (value !== 0) this.measuredWidth = value;
  }
  get height(): number {
    return this.clamp(this.requestedHeight);
  }
  set height(value: number) {
    this.requestedHeight = value;
    if (value !== 0) this.measuredHeight = value;
  }

  getContext(kind: string): unknown {
    if (this.options.throwEmptyMessageNamed != null) {
      const empty = new Error("");
      empty.name = this.options.throwEmptyMessageNamed;
      throw empty;
    }
    if (this.options.throwValue !== undefined) throw this.options.throwValue;
    if (this.options.throwOnContext === true) throw new Error("假平台：无法获取上下文");
    if (kind !== "2d" || this.options.withoutContext === true) return null;
    const canvas = this;
    return {
      set fillStyle(value: string) {
        canvas.fill = value;
      },
      get fillStyle(): string {
        return canvas.fill;
      },
      /** 只有**覆盖 (0,0)** 的填色才算数：这样「忘了填色」会判成像素读不回，而不是恒真通过。 */
      fillRect(x: number, y: number, w: number, h: number): void {
        if (x <= 0 && y <= 0 && w >= 1 && h >= 1) canvas.filled = parseRgb(canvas.fill);
      },
      getImageData(): { data: Uint8ClampedArray } {
        canvas.readCount += 1;
        if (canvas.options.throwOnRead === true) throw new Error("假平台：读回失败");
        const override = canvas.options.readbackColor ?? null;
        const cap = canvas.options.readbackColorMaxEdge ?? null;
        const withinCap = cap === null || Math.max(canvas.measuredWidth, canvas.measuredHeight) <= cap;
        if (override !== null && withinCap) {
          return { data: new Uint8ClampedArray([override[0], override[1], override[2], 255]) };
        }
        const rgb = canvas.filled;
        return {
          data:
            rgb === null
              ? new Uint8ClampedArray([0, 0, 0, 0])
              : new Uint8ClampedArray([rgb[0], rgb[1], rgb[2], 255]),
        };
      },
    };
  }
}

/** 把 `document.createElement("canvas")` 换成假画布，其余标签原样透传（Vue 自己要用）。 */
function stubCanvases(options: FakeOptions): FakeCanvas[] {
  const instances: FakeCanvas[] = [];
  const original = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation(((
    tag: string,
    elementOptions?: ElementCreationOptions,
  ) => {
    if (tag === "canvas") {
      const canvas = new FakeCanvas(options);
      instances.push(canvas);
      return canvas;
    }
    return original(tag, elementOptions);
  }) as typeof document.createElement);
  return instances;
}

const originalClipboard = Object.getOwnPropertyDescriptor(window.navigator, "clipboard");

/**
 * happy-dom 下 `navigator.clipboard` 不可依赖（CONTRACT §5 第 2 条的同一口径）：显式定义，
 * 用完按原描述符还原。**若 happy-dom 的 `navigator` 被冻结**（`defineProperty` 抛错），
 * 改用 `vi.stubGlobal("navigator", Object.create(window.navigator, { clipboard: { value: … } }))`。
 *
 * 返回类型**不写死**（`vi.fn` 会从实现里推出 `(text: string) => Promise<void>`）：写
 * `ReturnType<typeof vi.fn>` 会把参数退化成 `any[]`，而 `mock.calls[0][0]` 的类型就再也拦不住
 * 「断言取错了参数」。
 */
function stubClipboard() {
  const writeText = vi.fn(async (_text: string) => {});
  Object.defineProperty(window.navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
}

function hideClipboard(): void {
  Object.defineProperty(window.navigator, "clipboard", { value: undefined, configurable: true });
}

async function runProbe(wrapper: ReturnType<typeof mount>): Promise<void> {
  await wrapper.get('[data-testid="probe-run"]').trigger("click");
  await flushPromises();
}

afterEach(() => {
  if (originalClipboard === undefined) Reflect.deleteProperty(window.navigator, "clipboard");
  else Object.defineProperty(window.navigator, "clipboard", originalClipboard);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("/lab/canvas 探针页", () => {
  it("页首自标「开发期实验台；CI 不测」并写明 CI 只测这张表，且未跑之前不渲染任何表", () => {
    const wrapper = mount(CanvasLabPage);

    const notice = wrapper.get('[data-testid="lab-notice"]').text();
    expect(notice).toContain("开发期实验台");
    expect(notice).toContain("CI 不测");
    // 规格 §11 已把「CI 不测」与 §13.4 的「CI 里只能测表格渲染」写成一句话：两半都要在页面上
    expect(notice).toContain("CI 只测");
    expect(notice).toContain("不进任何用户入口");

    // 未测量之前不渲染空表（也不显示任何「结论」）
    expect(wrapper.find('[data-testid="probe-table-edge"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="probe-table-area"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="probe-conclusion-edge"]').exists()).toBe(false);

    wrapper.unmount();
  });

  it("全部通过：两条梯各 17 行、逐行「通过」，结论如实写「上界未触及，二分未执行」", async () => {
    stubCanvases({});
    const wrapper = mount(CanvasLabPage);
    await runProbe(wrapper);

    for (const direction of ["edge", "area"] as const) {
      const rows = wrapper.findAll(`[data-testid="probe-row-${direction}"]`);
      expect(rows).toHaveLength(LADDER.length);
      for (const row of rows) {
        expect(row.get('[data-testid="cell-verdict"]').text()).toBe("通过");
      }
      // 第三判据真的被求值过：读回像素就是填进去的那个颜色（不是「跳过不算」）
      expect(rows[0]!.get('[data-testid="cell-pixel"]').text()).toBe(PROBE_PIXEL);
      expect(rows[0]!.get('[data-testid="cell-ctx"]').text()).toBe("有");
      // 判据 1 的另一半（本文件「断言覆盖自查」里的「未钳制的等值」）：未钳制时写入 == 读回。
      // 两格都读一遍：把 requested / readback 交换、或把 SHORT_EDGE 改掉，这条就会红。
      const requested =
        direction === "edge" ? `${LADDER[0]}×${EDGE_SHORT}` : `${LADDER[0]}×${LADDER[0]}`;
      expect(rows[0]!.get('[data-testid="cell-requested"]').text()).toBe(requested);
      expect(rows[0]!.get('[data-testid="cell-readback"]').text()).toBe(requested);

      const conclusion = wrapper.get(`[data-testid="probe-conclusion-${direction}"]`).text();
      // F2：`no-upper` 的结论从同一份读数派生。「全过」这一支必须逐字说出「全部 17 档均通过」，
      // 而不能只写「上界未触及」了事——后者在非单调读数下会与本页自己的表格矛盾（见下一条用例）。
      expect(conclusion).toContain(
        `末档 ${LADDER[LADDER.length - 1]} 通过、上界未触及；全部 ${LADDER.length} 档均通过，二分未执行`,
      );
      expect(conclusion).toContain("上界未触及");
      expect(conclusion).toContain("二分未执行");
      expect(conclusion).not.toContain("未通过");
      expect(conclusion).not.toContain("收敛值");
    }

    wrapper.unmount();
  });

  it("中途被钳制：下界 4096 / 上界 5120、二分 8 次收敛到 4096，钳制行不编造像素", async () => {
    const canvases = stubCanvases({ clampAbove: CLAMP });
    const wrapper = mount(CanvasLabPage);
    await runProbe(wrapper);

    for (const direction of ["edge", "area"] as const) {
      const rows = wrapper.findAll(`[data-testid="probe-row-${direction}"]`);
      // 17 档 + 8 次二分 = 25 行（档距 1024 ⇒ 8 次二分都落在区间内部）
      expect(rows).toHaveLength(LADDER.length + BISECT_STEPS);

      const clampedRow = rows.find(
        (row) => row.get('[data-testid="cell-value"]').text() === "5120",
      );
      expect(clampedRow).toBeDefined();
      const expectedReadback = `${CLAMP}×${direction === "edge" ? EDGE_SHORT : CLAMP}`;
      expect(clampedRow!.get('[data-testid="cell-readback"]').text()).toBe(expectedReadback);
      expect(clampedRow!.get('[data-testid="cell-verdict"]').text()).toBe("被钳制");
      // 被钳制的档位**不编造**读回像素
      expect(clampedRow!.get('[data-testid="cell-pixel"]').text()).toContain("未读");
      // F4：「不读像素」不能只是文案——那一档的假画布 `getImageData` 调用次数必须是 0。
      // 同时钉住同一方向的**通过档**（1024）调用次数是 1：否则计数器本身没生效，0 就是恒真。
      const canvasBySize = (edge: number) =>
        canvases.find(
          (c) =>
            c.measuredWidth === edge &&
            c.measuredHeight === (direction === "edge" ? EDGE_SHORT : edge),
        );
      expect(canvasBySize(5120)?.readCount).toBe(0);
      expect(canvasBySize(LADDER[0])?.readCount).toBe(1);

      const conclusion = wrapper.get(`[data-testid="probe-conclusion-${direction}"]`).text();
      expect(conclusion).toContain("下界 4096");
      expect(conclusion).toContain("上界 5120");
      expect(conclusion).toContain("被钳制");
      expect(conclusion).toContain(`二分 ${BISECT_STEPS} 次后收敛值 4096`);
    }

    wrapper.unmount();
  });

  it("ctx 为 null：逐行「无 2D 上下文」、结论写「没有可收敛的下界」，不外推", async () => {
    stubCanvases({ withoutContext: true });
    const wrapper = mount(CanvasLabPage);
    await runProbe(wrapper);

    for (const direction of ["edge", "area"] as const) {
      const rows = wrapper.findAll(`[data-testid="probe-row-${direction}"]`);
      expect(rows).toHaveLength(LADDER.length);
      for (const row of rows) {
        expect(row.get('[data-testid="cell-ctx"]').text()).toBe("无");
        expect(row.get('[data-testid="cell-pixel"]').text()).toContain("未测");
        // 这一条就是「不许把 getContext 返回 null 当成通过」
        expect(row.get('[data-testid="cell-verdict"]').text()).toBe("无 2D 上下文");
      }
      const conclusion = wrapper.get(`[data-testid="probe-conclusion-${direction}"]`).text();
      expect(conclusion).toContain("没有可收敛的下界");
      expect(conclusion).toContain("二分未执行");
      expect(conclusion).not.toContain("收敛值");
    }

    wrapper.unmount();
  });

  it("像素读不回（getImageData 抛错）：判定是「像素读不回」、结论仍不外推", async () => {
    stubCanvases({ throwOnRead: true });
    const wrapper = mount(CanvasLabPage);
    await runProbe(wrapper);

    const rows = wrapper.findAll('[data-testid="probe-row-edge"]');
    expect(rows).toHaveLength(LADDER.length);
    for (const row of rows) {
      // 逐字断言整句（不是只 `toContain("读取抛错")`）：把 `probeSize` 里那个模板的
      // `e instanceof Error ? e.message : String(e)` 换成 `String(e)` 时，只有整句相等会红。
      expect(row.get('[data-testid="cell-pixel"]').text()).toBe("读取抛错：假平台：读回失败");
      expect(row.get('[data-testid="cell-verdict"]').text()).toBe("像素读不回");
    }
    expect(wrapper.get('[data-testid="probe-conclusion-edge"]').text()).toContain("二分未执行");

    wrapper.unmount();
  });

  it("判据 3 的颜色半边：能读回像素、但读到的不是写入的颜色 ⇒ 必须判「像素读不回」", async () => {
    // 读回 [10,20,30,255]：非 0/255、非探针色 ⇒ 只有「读回值 === 写入色」这一条判据能拦住它。
    // 把判定放宽成「非抛错即通过」，这条会红（这是判据 3 的另一半）。
    stubCanvases({ readbackColor: [10, 20, 30] });
    const wrapper = mount(CanvasLabPage);
    await runProbe(wrapper);

    for (const direction of ["edge", "area"] as const) {
      const rows = wrapper.findAll(`[data-testid="probe-row-${direction}"]`);
      expect(rows).toHaveLength(LADDER.length);
      for (const row of rows) {
        expect(row.get('[data-testid="cell-pixel"]').text()).toBe("10,20,30,255");
        expect(row.get('[data-testid="cell-verdict"]').text()).toBe("像素读不回");
      }
      const conclusion = wrapper.get(`[data-testid="probe-conclusion-${direction}"]`).text();
      expect(conclusion).toContain("没有可收敛的下界");
      expect(conclusion).toContain("二分未执行");
      expect(conclusion).not.toContain("收敛值");
    }

    wrapper.unmount();
  });

  it("读数非单调（小档像素读不回、大档通过）：结论如实写「另有 5 档未通过」，不与表格矛盾", async () => {
    // 请求尺寸长边 ≤ 2048 的 5 档（1024 / 1280 / 1536 / 1792 / 2048）读回错误颜色、更大档位正常
    // ⇒ 末档通过，但梯上另有 5 档不过。这时写「全部 17 档通过」就是与本页自己的表格自相矛盾（F2）。
    stubCanvases({ readbackColor: [10, 20, 30], readbackColorMaxEdge: 2048 });
    const wrapper = mount(CanvasLabPage);
    await runProbe(wrapper);

    for (const direction of ["edge", "area"] as const) {
      const rows = wrapper.findAll(`[data-testid="probe-row-${direction}"]`);
      expect(rows).toHaveLength(LADDER.length);
      const failed = rows.filter(
        (row) => row.get('[data-testid="cell-verdict"]').text() !== "通过",
      );
      expect(failed).toHaveLength(5);
      expect(rows[rows.length - 1]!.get('[data-testid="cell-verdict"]').text()).toBe("通过");

      const conclusion = wrapper.get(`[data-testid="probe-conclusion-${direction}"]`).text();
      expect(conclusion).toContain(`末档 ${LADDER[LADDER.length - 1]} 通过、上界未触及`);
      expect(conclusion).toContain("本梯另有 5 档未通过");
      expect(conclusion).toContain("读数非单调，勿外推");
      expect(conclusion).toContain("二分未执行");
      // 表格里有 4 行不是「通过」，结论就绝不能写「全部 … 档均通过」
      expect(conclusion).not.toContain("档均通过");
      expect(conclusion).not.toContain("收敛值");
    }

    wrapper.unmount();
  });

  it("getContext 抛空 message 的 Error：红字取 name、非空、不含 undefined", async () => {
    stubCanvases({ throwEmptyMessageNamed: "空消息平台错误" });
    const wrapper = mount(CanvasLabPage);

    await wrapper.get('[data-testid="probe-run"]').trigger("click");
    await flushPromises();

    // 这一条钉住 `errorText` 的「空串取 name」分支：改成 `return e.message` 会让红字变成空串
    //（`v-if="error"` 不成立 ⇒ 连 probe-error 都没有），改成 `String(e)` 在这里与 name 恰好同值、拦不住它
    //——拦住 `String(e)` 的是下面那条「非 Error 值」的用例。
    const redText = wrapper.get('[data-testid="probe-error"]').text();
    expect(redText).toBe("空消息平台错误");
    expect(redText.length).toBeGreaterThan(0);
    expect(redText).not.toContain("undefined");
    expect(wrapper.find('[data-testid="probe-table-edge"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="probe-run"]').attributes("disabled")).toBeUndefined();

    wrapper.unmount();
  });

  it("getContext 抛非 Error 值：红字取 String(e)", async () => {
    stubCanvases({ throwValue: "假平台：字符串抛错" });
    const wrapper = mount(CanvasLabPage);

    await wrapper.get('[data-testid="probe-run"]').trigger("click");
    await flushPromises();

    // `errorText` 的第三个分支：非 `Error` 取 `String(e)`。改成 `e.message` 会渲染成 `undefined`。
    const redText = wrapper.get('[data-testid="probe-error"]').text();
    expect(redText).toBe("假平台：字符串抛错");
    expect(redText).not.toContain("undefined");
    expect(wrapper.find('[data-testid="probe-table-edge"]').exists()).toBe(false);

    wrapper.unmount();
  });

  it("getContext 抛错：兜底红字出现、表格不产出、页面不崩（页面上唯一的兜底路径）", async () => {
    stubCanvases({ throwOnContext: true });
    const wrapper = mount(CanvasLabPage);

    await wrapper.get('[data-testid="probe-run"]').trigger("click");
    await flushPromises();

    const redText = wrapper.get('[data-testid="probe-error"]').text();
    // 兜底文案必须非空、且带上桩抛出的原因（不是空串、更不是 "undefined"）
    expect(redText).toContain("无法获取上下文");
    // 并且是**逐字**的原因：把 `errorText` 整支换成 `String(e)` 时文本会变成
    // "Error: 假平台：无法获取上下文"（`toContain` 拦不住它，只有整句相等能拦）。
    expect(redText).toBe("假平台：无法获取上下文");
    expect(redText).not.toContain("undefined");
    // 第一档就抛 ⇒ 一张表都没有（而不是渲染一张空表 / 半张表）
    expect(wrapper.find('[data-testid="probe-table-edge"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="probe-table-area"]').exists()).toBe(false);
    // 页面不崩：按钮回到可用、页首自标仍在
    expect(wrapper.get('[data-testid="probe-run"]').attributes("disabled")).toBeUndefined();
    // `wrapper.get(...)` 的返回类型是 `Omit<DOMWrapper<Element>, "exists">`（@vue/test-utils 2.4.10），
    // 所以「还在不在」必须走 `find(...).exists()`——本文件其余同类断言也是这个写法。
    expect(wrapper.find('[data-testid="lab-notice"]').exists()).toBe(true);

    wrapper.unmount();
  });

  it("复制为文本：把同一份读数写进剪贴板；没有剪贴板 API 时给手动复制的提示", async () => {
    stubCanvases({ clampAbove: CLAMP });
    const writeText = stubClipboard();
    const wrapper = mount(CanvasLabPage);
    await runProbe(wrapper);

    await wrapper.get('[data-testid="probe-copy"]').trigger("click");
    await flushPromises();

    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = String(writeText.mock.calls[0]?.[0] ?? "");
    // F6：这份可粘贴的**逐档原始读数**就是本页对人类伙伴的核心交付物——表头 + 两个方向的逐档行
    // + 回写规程，缺一不可（原来只读结论子串，把逐档行甚至整段回写规程删掉都照样全绿）。
    expect(copied).toContain("方向\t阶段\t档位\t写入\t读回\tctx\t读回像素\t判定");
    expect(copied).toContain("edge\tladder\t1024\t1024×64\t1024×64\t有\t17,99,200,255\t通过");
    expect(copied).toContain("area\tladder\t1024\t1024×1024\t1024×1024\t有\t17,99,200,255\t通过");
    expect(copied).toContain(
      "回写规程：取两个方向收敛值里更保守的那个，向下取整到 2 的幂 ⇒ EXPORT_MAX_EDGE",
    );
    // 被钳制那一档在文本里也要如实写「被钳制」+「未读」，而不是留空
    expect(copied).toContain("edge\tladder\t5120\t5120×64\t4096×64\t有\t未读");
    expect(copied).toContain("上界 5120");
    expect(copied).toContain(`二分 ${BISECT_STEPS} 次后收敛值 4096`);
    expect(copied).toContain("被钳制");
    expect(wrapper.get('[data-testid="probe-copy-status"]').text()).toContain("已复制");

    hideClipboard();
    await wrapper.get('[data-testid="probe-copy"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-testid="probe-copy-status"]').text()).toContain("没有剪贴板 API");
    expect(writeText).toHaveBeenCalledTimes(1);

    // F5：`clipboard` 存在但 `writeText` 抛错——真机上最可能的失败形态（WebView 权限被拒）。
    // 这一支必须既说原因、又给手动复制的兜底。
    const rejecting = vi.fn(async (_text: string) => {
      throw new Error("拒绝");
    });
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText: rejecting },
      configurable: true,
    });
    await wrapper.get('[data-testid="probe-copy"]').trigger("click");
    await flushPromises();
    const failure = wrapper.get('[data-testid="probe-copy-status"]').text();
    expect(failure).toContain("复制失败：拒绝");
    expect(failure).toContain("请手动选中下面的表格复制");
    expect(rejecting).toHaveBeenCalledTimes(1);

    wrapper.unmount();
  });
});
