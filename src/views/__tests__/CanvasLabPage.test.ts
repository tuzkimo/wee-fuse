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
 * 「有没有 2D 上下文」「`getContext` 会不会抛错」「读回会不会抛错」）；`navigator.clipboard` 显式定义 /
 * 显式置 `undefined`。桩里的「读回」是把写进去的 `fillStyle` 原样返回，**不是**真实像素语义。
 *
 * **哪些只能人工**（B4 规格 §14 清单 3，写在这里防止后来者以为 CI 覆盖了它）：
 * ① 真机上的单边 / 面积上限数值；② `getImageData` 的真实像素语义（真实平台还有预乘 alpha、色彩管理）；
 * ③ 真实浏览器对超限画布的钳制形态（置 0 / 截断 / `getContext` 返回 null / 直接崩标签页）。
 *
 * **这一份用例能证明的**：判定列把「通过 / 被钳制 / 无 2D 上下文 / 像素读不回」如实分开；
 * 没有区间时结论**不外推**（「上界未触及」「没有可收敛的下界」都如实写出来）；页面上**唯一的兜底路径**
 * （`run()` 的 `catch`）真的把原因显示成非空红字、而不是崩页或渲染出 `undefined`。
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
  /** `getImageData` 抛错（模拟超大画布上的读取失败）。 */
  readonly throwOnRead?: boolean;
}

function parseRgb(css: string): Rgb | null {
  const match = /rgb\((\d+), (\d+), (\d+)\)/.exec(css);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

class FakeCanvas {
  private requestedWidth = 0;
  private requestedHeight = 0;
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
  }
  get height(): number {
    return this.clamp(this.requestedHeight);
  }
  set height(value: number) {
    this.requestedHeight = value;
  }

  getContext(kind: string): unknown {
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
        if (canvas.options.throwOnRead === true) throw new Error("假平台：读回失败");
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
      expect(conclusion).toContain(`档位梯全部 ${LADDER.length} 档通过`);
      expect(conclusion).toContain("上界未触及");
      expect(conclusion).toContain("二分未执行");
      expect(conclusion).not.toContain("收敛值");
    }

    wrapper.unmount();
  });

  it("中途被钳制：下界 4096 / 上界 5120、二分 8 次收敛到 4096，钳制行不编造像素", async () => {
    stubCanvases({ clampAbove: CLAMP });
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
      expect(row.get('[data-testid="cell-pixel"]').text()).toContain("读取抛错");
      expect(row.get('[data-testid="cell-verdict"]').text()).toBe("像素读不回");
    }
    expect(wrapper.get('[data-testid="probe-conclusion-edge"]').text()).toContain("二分未执行");

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
    expect(copied).toContain("上界 5120");
    expect(copied).toContain(`二分 ${BISECT_STEPS} 次后收敛值 4096`);
    expect(copied).toContain("被钳制");
    expect(wrapper.get('[data-testid="probe-copy-status"]').text()).toContain("已复制");

    hideClipboard();
    await wrapper.get('[data-testid="probe-copy"]').trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-testid="probe-copy-status"]').text()).toContain("没有剪贴板 API");
    expect(writeText).toHaveBeenCalledTimes(1);

    wrapper.unmount();
  });
});
