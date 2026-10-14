import { DOMWrapper, flushPromises, mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { closeTopOverlay } from "@/composables/useOverlayBack";
import { unlockBodyScroll } from "@/composables/useBodyScrollLock";
import type { Palette } from "@/core/palette/types";
import type { ColorUsage } from "@/core/pattern/stats";
import type { Pattern } from "@/core/pattern/types";
import { maxCellScale, minCellScale } from "@/core/pattern/view";
import { planSheet, type SheetPlan } from "@/core/render/layout";
import { getBuiltinPalette } from "@/services/palette";
import type { SheetRenderInput, SheetRenderResult } from "@/services/sheetExport";
import ExportPanel from "@/components/editor/ExportPanel.vue";
import SheetViewer from "@/components/sheet/SheetViewer.vue";

/**
 * 能力层替身：本组件只碰 `album.save`。
 *
 * **`kind` 做成可变的一个格子**（不是写死的 `"album"`）：成功文案按落点分叉，写死的替身让
 * `download` 那一支零覆盖，把文案改成常量也全绿。`getPlatform` 每次调用现读 `albumKind.value`。
 */
const albumSave = vi.hoisted(() => vi.fn());
const albumKind = vi.hoisted(() => ({ value: "album" }));
vi.mock("@/services/platform/capabilities", () => ({
  getPlatform: () => ({ album: { kind: albumKind.value, save: albumSave } }),
}));

/**
 * 渲染通道替身：默认给一颗非空 blob + 一份**真几何**的施工图计划。
 *
 * **做成 `vi.fn()` 而不是写死的箭头函数**：失败路径（渲染抛错）必须能被驱动。
 *
 * **为什么连计划一起替**（C8 修复 ②）：通道的返回值是 `{ blob, plan }`，查看层要用 `plan` 把
 * `<img>` 的画布像素换算回「格」——旧的替身只给一颗 blob，查看层就永远进不了可缩放视图。
 * 计划用真 `planSheet` 现算（不是手写的残缺对象）：几何（画布像素 / 格像素）正是本文件最重要的
 * 那条不变量所依赖的东西，替身伪造它等于把判据架空。
 */
const renderSheetBlob = vi.hoisted(() => vi.fn());
vi.mock("@/services/sheetExport", () => ({ renderSheetBlob }));

const palette = getBuiltinPalette();

/**
 * 替身最近交出来的那份计划。
 *
 * **为什么留这个口**：若干条期望值必须**按几何现算**（默认视图 = 整张图的适配比例等），硬写一个
 * 数字（旧文件里的 `toBe(6)`）既会在布局常量变化时无意义地红，也钉不住「适配的是哪张图」。
 * 每个用例挂载时由替身重写；没走到现算那一步的用例里它是 `null`（`requireRenderedPlan` 会响亮失败）。
 */
let renderedPlan: SheetPlan | null = null;

/** 整张图的格尺寸。**与组件同一条口径**：画布像素 ÷ 格像素、向上取整（core 的图像尺寸守卫只收整数）。 */
function sheetCellsOf(plan: SheetPlan): { readonly width: number; readonly height: number } {
  return {
    width: Math.ceil(plan.canvasWidth / plan.cellPx),
    height: Math.ceil(plan.canvasHeight / plan.cellPx),
  };
}

/** 替身交给查看层的那份计划；没现算过就响亮失败（而不是拿 `null` 硬算出一个假期望值）。 */
function requireRenderedPlan(): SheetPlan {
  if (renderedPlan === null) throw new Error("本用例还没走到现算那一步：替身没返回过计划");
  return renderedPlan;
}

/** `withViewport()` 的默认视口（CSS px）：凡是要对着 core 现算期望值的地方都用它。 */
const VIEWPORT = { width: 800, height: 600 } as const;

/**
 * object URL 的两个替身**留具名引用**：本组件最承重的一条纪律是「预览用的与落盘的**是同一颗
 * blob**」——只记返回串时，`createObjectURL(别的 blob)` 照样绿。
 */
let createObjectUrl: Mock<(blob: Blob) => string>;
let revokeObjectUrl: Mock<(url: string) => void>;

/**
 * 被查看的图纸（**C7 起由调用方给**，组件不再回库读）：2×1、两格都是色卡第 0 色。
 *
 * 用真实的 `getBuiltinPalette()` 与合法的 `paletteId`：入参最终要喂给真正的渲染链，
 * 色卡与图纸对不上会在那一步响亮失败。
 */
function makePattern(width = 2, height = 1) {
  return {
    width,
    height,
    paletteId: palette.id,
    cells: new Uint16Array(width * height),
  };
}

beforeEach(() => {
  albumSave.mockReset();
  albumKind.value = "album";
  renderedPlan = null;
  renderSheetBlob.mockReset().mockImplementation(async (input: SheetRenderInput) => {
    const plan = planSheet(input.pattern, input.palette, input.usages, input.projectName);
    renderedPlan = plan;
    return { blob: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), plan };
  });
  // happy-dom 下这两个方法可能不存在，所以直接赋值
  createObjectUrl = vi.fn<(blob: Blob) => string>(() => "blob:test-1");
  revokeObjectUrl = vi.fn<(url: string) => void>();
  URL.createObjectURL = createObjectUrl as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = revokeObjectUrl as unknown as typeof URL.revokeObjectURL;
});

/**
 * 挂载查看层。
 *
 * **`stubs: { teleport: true }` 是必需的**（T1 起查看层与打印面板都 `Teleport to="body"`）：
 * VTU 的 `wrapper.find` 只在自己这棵子树里找（`vm.$el.querySelectorAll`），传送到 body 的节点它
 * 看不见——本文件绝大多数用例钉的是查看层**内部**的行为，与「挂在哪一层」无关。不 stub 它们全红。
 * 「真的被传送到 body 顶层」由本文件末尾那条**不 stub** 的用例单独钉。
 */
function mountViewer(overrides: Partial<{ name: string; thumbnail: string }> = {}) {
  return mount(SheetViewer, {
    props: {
      pattern: makePattern(),
      palette,
      name: overrides.name ?? "测试工程",
      thumbnail: overrides.thumbnail ?? "",
    },
    global: { stubs: { teleport: true } },
  });
}

describe("SheetViewer（C7：吃 pattern 入参 + 可缩放）", () => {
  it("先用缩略图垫场，现算完成后换成施工图", async () => {
    const wrapper = mountViewer({ thumbnail: "data:image/png;base64,AAAA" });
    expect(wrapper.get("[data-testid='sheet-preview']").attributes("src")).toBe("data:image/png;base64,AAAA");
    // 垫场期间：加载提示在、保存按钮**不可点**（还没有 blob 可存）
    expect(wrapper.find("[data-testid='sheet-loading']").exists()).toBe(true);
    expect((wrapper.get("[data-testid='sheet-save']").element as HTMLButtonElement).disabled).toBe(true);
    await flushPromises();
    expect(wrapper.get("[data-testid='sheet-preview']").attributes("src")).toBe("blob:test-1");
    expect(wrapper.find("[data-testid='sheet-loading']").exists()).toBe(false);
    expect((wrapper.get("[data-testid='sheet-save']").element as HTMLButtonElement).disabled).toBe(false);
    const title = wrapper.get("[data-testid='sheet-title']");
    expect(title.classes()).toContain("project-name");
    expect(title.text()).toBe("测试工程 · 施工图");
  });

  it("入参的图纸与色卡原样喂给渲染通道（不再经工程存储）", async () => {
    const wrapper = mountViewer({ name: "小猫" });
    await flushPromises();
    expect(renderSheetBlob).toHaveBeenCalledTimes(1);
    const input = renderSheetBlob.mock.calls[0]?.[0] as SheetRenderInput;
    expect(input.pattern.width).toBe(2);
    expect(input.pattern.height).toBe(1);
    expect(input.palette.id).toBe(palette.id);
    expect(input.projectName).toBe("小猫");
    // 全图用量由 `patternStats` 从 pattern 现算：两格都是色卡第 0 色 ⇒ 一行、2 颗
    expect(input.usages).toHaveLength(1);
    expect(input.usages[0]?.count).toBe(2);
    expect(wrapper.find("[data-testid='sheet-error']").exists()).toBe(false);
  });

  it("保存经能力层落盘，文件名是「工程名-施工图.png」（不带分片序号）", async () => {
    const wrapper = mountViewer({ name: "小猫" });
    await flushPromises();
    await wrapper.get("[data-testid='sheet-save']").trigger("click");
    await flushPromises();
    expect(albumSave).toHaveBeenCalledTimes(1);
    const [blob, filename] = albumSave.mock.calls[0] as [Blob, string];
    expect(blob.size).toBeGreaterThan(0);
    expect(filename).toBe("小猫-施工图.png");
    // **预览 URL 与落盘用的是同一颗 blob**（不许 `fetch(objectUrl)` 再取一遍：那会白复制一份位图）
    expect(createObjectUrl.mock.calls[0]?.[0]).toBe(blob);
    expect(wrapper.get("[data-testid='sheet-save-state']").text()).toBe("已保存到相册");
  });

  it("关闭 emit close；卸载时释放 object URL（恰好一次）", async () => {
    const wrapper = mountViewer();
    await flushPromises();
    await wrapper.get("[data-testid='sheet-close']").trigger("click");
    expect(wrapper.emitted("close")).toEqual([[]]);
    wrapper.unmount();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:test-1");
    expect(revokeObjectUrl).toHaveBeenCalledTimes(1);
  });

  it("现算失败时显示中文原因，不静默也不留白屏", async () => {
    renderSheetBlob.mockRejectedValueOnce(new Error("画布尺寸被浏览器钳制：期望 8000×12000，实际 0×0"));
    const wrapper = mountViewer();
    await flushPromises();
    expect(wrapper.get("[data-testid='sheet-error']").text()).toBe(
      "图纸生成失败：画布尺寸被浏览器钳制：期望 8000×12000，实际 0×0",
    );
    expect(wrapper.find("[data-testid='sheet-loading']").exists()).toBe(false);
    expect((wrapper.get("[data-testid='sheet-save']").element as HTMLButtonElement).disabled).toBe(true);
  });

  it("非 Error 来源（如 DOMException）也译成中文，不露裸英文", async () => {
    renderSheetBlob.mockRejectedValueOnce({ name: "UnknownError", message: "An unknown error occurred" });
    const wrapper = mountViewer();
    await flushPromises();
    expect(wrapper.get("[data-testid='sheet-error']").text().startsWith("图纸生成失败：")).toBe(true);
  });

  it("保存失败时显示中文原因，不冒充「已保存到相册」", async () => {
    albumSave.mockRejectedValueOnce(new Error("相册写入被拒绝"));
    const wrapper = mountViewer({ name: "小猫" });
    await flushPromises();
    await wrapper.get("[data-testid='sheet-save']").trigger("click");
    await flushPromises();
    const text = wrapper.get("[data-testid='sheet-save-state']").text();
    expect(text).toContain("保存失败：相册写入被拒绝");
    expect(text).not.toContain("已保存到相册");
    // 保存失败不是「图纸生成失败」：两件事的原因不同，不该同时亮红字
    expect(wrapper.find("[data-testid='sheet-error']").exists()).toBe(false);
  });

  it("成功文案按落点分叉：浏览器落点（download）说「已生成」，不冒充相册", async () => {
    albumKind.value = "download";
    const wrapper = mountViewer({ name: "小猫" });
    await flushPromises();
    await wrapper.get("[data-testid='sheet-save']").trigger("click");
    await flushPromises();
    const text = wrapper.get("[data-testid='sheet-save-state']").text();
    expect(text).toBe("已生成");
    expect(text).not.toContain("已保存到相册");
    expect(text).not.toContain("已开始下载");
  });

  it("预览 URL 造不出来 ≠ 图纸生成失败：blob 仍可保存，可点性判的是 sheetBlob", async () => {
    createObjectUrl.mockImplementationOnce(() => {
      throw new Error("object URL 被拒");
    });
    const wrapper = mountViewer({ name: "小猫" });
    await flushPromises();
    expect(wrapper.get("[data-testid='sheet-error']").text()).toBe("预览生成失败：object URL 被拒");
    const button = wrapper.get("[data-testid='sheet-save']");
    expect((button.element as HTMLButtonElement).disabled).toBe(false);
    await button.trigger("click");
    await flushPromises();
    expect(albumSave).toHaveBeenCalledTimes(1);
  });

  it("保存进行中时按钮禁用，同一 tick 连点两次只落盘一次", async () => {
    let release: () => void = () => undefined;
    albumSave.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const wrapper = mountViewer({ name: "小猫" });
    await flushPromises();

    const button = wrapper.get("[data-testid='sheet-save']");
    // 第一次用 `trigger`；**第二次直接 `dispatchEvent`**：`trigger` 对 `disabled` 元素会静默跳过，
    // 而这一 tick 里 `disabled` 还没生效 ⇒ 第二次真的会进 handler，只有入口早退能挡住。
    const first = button.trigger("click");
    button.element.dispatchEvent(new MouseEvent("click"));
    await first;

    expect(albumSave).toHaveBeenCalledTimes(1);
    // **两条 `disabled` 断言都现查按钮**（T1）：teleport 的桩在重渲染时会重建被传送的节点，
    // 上面缓存的 `button.element` 已成游离节点（`disabled` 永远停在旧值）。现查读的是文档里那一颗，
    // 判据与改动前逐字相同；上面那次 `dispatchEvent`（在重渲染之前、同一 tick 内）打的是活节点，不变。
    expect((wrapper.get("[data-testid='sheet-save']").element as HTMLButtonElement).disabled).toBe(true);
    release();
    await flushPromises();
    expect(albumSave).toHaveBeenCalledTimes(1);
    expect((wrapper.get("[data-testid='sheet-save']").element as HTMLButtonElement).disabled).toBe(false);
  });

  it("重试保存时会先清掉上一轮的结果（飞行中不挂着旧的「保存失败」）", async () => {
    albumSave.mockRejectedValueOnce(new Error("相册写入被拒绝"));
    let settle: () => void = () => undefined;
    albumSave.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    const wrapper = mountViewer({ name: "小猫" });
    await flushPromises();
    const button = wrapper.get("[data-testid='sheet-save']");

    await button.trigger("click");
    await flushPromises();
    expect(wrapper.get("[data-testid='sheet-save-state']").text()).toContain("保存失败：相册写入被拒绝");

    await button.trigger("click");
    expect(wrapper.find("[data-testid='sheet-save-state']").exists()).toBe(false);
    settle();
    await flushPromises();
    expect(wrapper.get("[data-testid='sheet-save-state']").text()).toBe("已保存到相册");
  });

  it("卸载发生在现算结算之前时不再建 object URL（否则整颗位图钉到页面生命周期结束）", async () => {
    let settle: (result: SheetRenderResult) => void = () => undefined;
    renderSheetBlob.mockImplementationOnce(
      () => new Promise<SheetRenderResult>((resolve) => {
        settle = resolve;
      }),
    );
    const wrapper = mountViewer({ thumbnail: "data:image/png;base64,AAAA" });
    await flushPromises();
    expect(renderSheetBlob).toHaveBeenCalledTimes(1);
    expect(createObjectUrl).not.toHaveBeenCalled();

    wrapper.unmount(); // 用户在现算结算前点了「关闭」
    settle({
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
      plan: planSheet(makePattern(), palette, [], "测试工程"),
    });
    await flushPromises();
    expect(createObjectUrl).not.toHaveBeenCalled();
    expect(revokeObjectUrl).not.toHaveBeenCalled();
  });
});

/**
 * 缩放（C7 新增）：视图数学本身（上下界、夹取、锚点）的判别力在 core 的纯函数用例里
 * （`core/pattern/view.test.ts`），这一组只证明「按钮接上了 core 的视图数学」。
 *
 * **下面这一组是唯一不需要假造视口的**：`getBoundingClientRect()` 在 happy-dom 里恒为 0，
 * 视口为 0 ⇒ `view` 保持 `null` ⇒ 按钮什么都不该做。其余各组用 `withViewport()` 假造尺寸。
 */
describe("SheetViewer 的缩放接线", () => {
  it("视口量不到尺寸（happy-dom 返回 0）时缩放按钮不改变视图，也不抛错", async () => {
    const wrapper = mountViewer();
    await flushPromises();
    const before = wrapper.get("[data-testid='sheet-stage']").attributes("style");
    await wrapper.get("[data-testid='sheet-zoom-in']").trigger("click");
    await wrapper.get("[data-testid='sheet-zoom-out']").trigger("click");
    // 视口为 0 ⇒ `view` 保持 null ⇒ `<img>` 仍是「垫场/全宽」那一支（内联样式不变）
    expect(wrapper.get("[data-testid='sheet-stage']").attributes("style")).toBe(before);
    expect(wrapper.find("[data-testid='sheet-error']").exists()).toBe(false);
  });
});

/**
 * 让舞台量到一个非零视口：happy-dom 的 `getBoundingClientRect()` 恒为 0，视图数学因此不可达。
 *
 * **这里比简报多了一条 `await nextTick()`（如实记录）**：`resize` 里 `measure()` 改的是响应式状态，
 * DOM 补丁排在**微任务**里；同步紧跟着读 `attributes("style")` 拿到的是**旧**样式 ⇒ `fit` 恒为 0，
 * 于是「默认整图适配」那条的 `expect(fit).toBeGreaterThan(0)` 永远红、双击那条的
 * `expect(zoomed).toBeGreaterThan(fit)` 又成了恒真（假绿）。只补等待，**断言一条都没改**。
 */
async function withViewport(wrapper: ReturnType<typeof mountViewer>, width = 800, height = 600): Promise<void> {
  const stage = wrapper.get("[data-testid='sheet-stage']").element as HTMLElement;
  stage.getBoundingClientRect = () =>
    ({
      x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height,
      toJSON: () => ({}),
    }) as DOMRect;
  window.dispatchEvent(new Event("resize"));
  await nextTick();
}

/** 从 `<img>` 的内联 transform 里读当前比例（视图为 null 时返回 0）。 */
function scaleOf(wrapper: ReturnType<typeof mountViewer>): number {
  const style = wrapper.get("[data-testid='sheet-preview']").attributes("style") ?? "";
  const match = /scale\(([\d.]+)\)/.exec(style);
  return match === null ? 0 : Number(match[1]);
}

describe("SheetViewer 的看图手势（C8 第 2 项）", () => {
  it("底部操作条是四颗按钮：放大 / 缩小 / 打印 / 保存；「适配」按钮与精度声明都没了", async () => {
    const wrapper = mountViewer();
    await flushPromises();
    expect(wrapper.find("[data-testid='sheet-zoom-in']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='sheet-zoom-out']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='sheet-print']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='sheet-save']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='sheet-zoom-fit']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='sheet-accuracy']").exists()).toBe(false);
  });

  it("量到视口后：默认是整图适配，点放大比例变大、点缩小比例回落", async () => {
    const wrapper = mountViewer();
    await flushPromises();
    await withViewport(wrapper);
    const fit = scaleOf(wrapper);
    expect(fit).toBeGreaterThan(0);

    await wrapper.get("[data-testid='sheet-zoom-in']").trigger("click");
    const zoomed = scaleOf(wrapper);
    expect(zoomed).toBeGreaterThan(fit);

    await wrapper.get("[data-testid='sheet-zoom-out']").trigger("click");
    expect(scaleOf(wrapper)).toBeLessThan(zoomed);
  });

  it("双击在「放大到上限」与「整图适配」之间切换", async () => {
    const wrapper = mountViewer();
    await flushPromises();
    await withViewport(wrapper);
    const fit = scaleOf(wrapper);
    const stage = wrapper.get("[data-testid='sheet-stage']");

    await stage.trigger("pointerdown", { pointerId: 1, clientX: 400, clientY: 300 });
    await stage.trigger("pointerup", { pointerId: 1, clientX: 400, clientY: 300 });
    await stage.trigger("pointerdown", { pointerId: 1, clientX: 400, clientY: 300 });
    await stage.trigger("pointerup", { pointerId: 1, clientX: 400, clientY: 300 });
    const zoomed = scaleOf(wrapper);
    expect(zoomed).toBeGreaterThan(fit);

    await stage.trigger("pointerdown", { pointerId: 1, clientX: 400, clientY: 300 });
    await stage.trigger("pointerup", { pointerId: 1, clientX: 400, clientY: 300 });
    await stage.trigger("pointerdown", { pointerId: 1, clientX: 400, clientY: 300 });
    await stage.trigger("pointerup", { pointerId: 1, clientX: 400, clientY: 300 });
    expect(scaleOf(wrapper)).toBeCloseTo(fit, 5);
  });

  it("鼠标的一次双击只算一次：指针序列 + 浏览器随后派发的 dblclick 不会一来一回抵消", async () => {
    // **判死什么**：舞台把 `@dblclick="onDoubleTap"` 加回来时这条立刻红——真机鼠标在一次双击里
    // 会先派发两轮 `pointerdown` / `pointerup`（指针路径放大到上限）、**紧接着**再派发一个
    // `dblclick`（同一个处理器又判「已经放大了」⇒ 弹回适配），净效果是双击没反应。
    // 所以这里如实复现浏览器的完整序列：两轮指针 + 一个 dblclick。
    const wrapper = mountViewer();
    await flushPromises();
    await withViewport(wrapper);
    const fit = scaleOf(wrapper);
    const stage = wrapper.get("[data-testid='sheet-stage']");

    for (let i = 0; i < 2; i += 1) {
      await stage.trigger("pointerdown", { pointerId: 1, pointerType: "mouse", clientX: 400, clientY: 300 });
      await stage.trigger("pointerup", { pointerId: 1, pointerType: "mouse", clientX: 400, clientY: 300 });
    }
    (stage.element as HTMLElement).dispatchEvent(
      new MouseEvent("dblclick", { bubbles: true, clientX: 400, clientY: 300 }),
    );
    // **必须等一帧**：`dispatchEvent` 是同步的，但它触发的 `view` 变更要等 Vue 的微任务补丁，
    // 紧跟其后同步读 `style` 会拿到**旧**样式——那样这条用例在变异下也是绿的（假绿，实测过）。
    await nextTick();

    const zoomed = scaleOf(wrapper);
    // 净效果停在**放大那一侧**，且明显大于适配（若被 dblclick 弹回去，这里会等于 fit）。
    // **C8 修复 ② 改判据**：双击的目标是缩放的**上界**，而它按定义是 `max(64, 适配 × 2)`——
    // 2×1 的整图适配比例（≈61.5 > 32）下上界恰好 = 适配 × 2，旧的 `> fit * 2` 因此**恰好不成立**
    // （浮点相等）。这里不放松，改成对着 core 现算的上界做精确断言（比原来更紧）。
    expect(zoomed).toBeGreaterThan(fit);
    const plan = requireRenderedPlan();
    expect(zoomed).toBeCloseTo(maxCellScale(VIEWPORT, sheetCellsOf(plan)) / plan.cellPx, 6);
  });

  it("单指拖动会平移视图（transform 的 translate 变化）", async () => {
    // **用 100×100 的图纸**：2×1 的整图适配比例会落在 `minCellScale` 的上限 64px/格上，图像只有
    // 几百 px 宽 < 视口 ⇒ `clampView` 把它按居中夹住，拖动**什么都不会变**（假绿）。
    // 100×100 的整图适配比例远小于 64（整张画布在 800×600 里），连点 12 次放大后横向 / 纵向都远大于视口。
    const wrapper = mount(SheetViewer, {
      props: { pattern: makePattern(100, 100), palette, name: "测试工程", thumbnail: "" },
      global: { stubs: { teleport: true } },
    });
    await flushPromises();
    await withViewport(wrapper);
    for (let i = 0; i < 12; i += 1) {
      await wrapper.get("[data-testid='sheet-zoom-in']").trigger("click");
    }
    // **前提检查**（用例自己钉住）：图像必须真的比视口大，否则「拖动什么都不变」是假绿而不是接线错。
    // 渲染出来的 CSS 宽度 = `<img>` 的固有宽度（= 画布像素）× 样式里的 scale。
    expect(scaleOf(wrapper) * requireRenderedPlan().canvasWidth).toBeGreaterThan(VIEWPORT.width);
    const before = wrapper.get("[data-testid='sheet-preview']").attributes("style");
    const stage = wrapper.get("[data-testid='sheet-stage']");
    await stage.trigger("pointerdown", { pointerId: 1, button: 0, buttons: 1, clientX: 400, clientY: 300 });
    // `buttons: 1`：**拖动中的 `pointermove` 本来就带着按下的键**（真机如此），而组件现在会读它
    // 把「没按键的移动」当陈旧指针清掉（见「松手点落在舞台之外」那条用例）。不显式给，
    // happy-dom 造出来的事件 `buttons` 恒为 0，拖动会被当成悬停。
    await stage.trigger("pointermove", { pointerId: 1, buttons: 1, clientX: 430, clientY: 310 });
    await stage.trigger("pointerup", { pointerId: 1, clientX: 430, clientY: 310 });
    expect(wrapper.get("[data-testid='sheet-preview']").attributes("style")).not.toBe(before);
  });

  it("双指捏合按两指间距改比例：分开变大、靠拢变小", async () => {
    // 期望值**按整张图的适配比例现算**（C8 修复 ② 的新口径：适配的对象是整张图，不是格数）：
    // 100×100 的整图在 800×600 里适配远小于上界 64 ⇒ 2 倍 / 0.75 倍都落在可缩放区间内，
    // 不会被 `zoomCellView` 的夹取掩盖（夹住了就分辨不出「比例真的按间距算」还是「没动」）。
    // **判别力**：把捏合分支删掉、只留单指平移，这里的比例会停在默认值 ⇒ 三条断言全红。
    const wrapper = mount(SheetViewer, {
      props: { pattern: makePattern(100, 100), palette, name: "测试工程", thumbnail: "" },
      global: { stubs: { teleport: true } },
    });
    await flushPromises();
    await withViewport(wrapper);
    const plan = requireRenderedPlan();
    const fit = minCellScale(VIEWPORT, sheetCellsOf(plan)) / plan.cellPx;
    expect(scaleOf(wrapper)).toBeCloseTo(fit, 6);
    const stage = wrapper.get("[data-testid='sheet-stage']");

    await stage.trigger("pointerdown", { pointerId: 1, button: 0, buttons: 1, clientX: 300, clientY: 300 });
    await stage.trigger("pointerdown", { pointerId: 2, button: 0, buttons: 1, clientX: 400, clientY: 300 });
    // 两指间距 100 → 200：比例 ×2（`buttons: 1`：两指都还按在屏幕上，理由同拖动那条）
    await stage.trigger("pointermove", { pointerId: 2, buttons: 1, clientX: 500, clientY: 300 });
    expect(scaleOf(wrapper)).toBeCloseTo(fit * 2, 5);

    // 间距 200 → 150：比例 ×0.75（增量口径：比值是 150/200）
    await stage.trigger("pointermove", { pointerId: 2, buttons: 1, clientX: 450, clientY: 300 });
    expect(scaleOf(wrapper)).toBeCloseTo(fit * 1.5, 5);

    await stage.trigger("pointerup", { pointerId: 1, clientX: 300, clientY: 300 });
    await stage.trigger("pointerup", { pointerId: 2, clientX: 450, clientY: 300 });
  });

  it("松手点落在舞台之外（舞台收不到 pointerup）后，仅仅悬停不再平移，且下一次正常拖动仍然生效", async () => {
    // **判死什么**（C8 任务 6 第 1 轮审查的「重要 2」）：舞台内按下 → 在舞台外松手（松手点常常落在
    // 底部操作条上，它是舞台的**兄弟**、不是后代 ⇒ 舞台收不到 `pointerup`）之后，`pointers` 里那条
    // 陈旧指针若还在，用户只是把鼠标移回舞台，图就会跟着跑。这里用 `document.body` 上派发 `pointerup`
    // 复现这条路径（body 是舞台的**祖先**，所以这个事件不会落到舞台的处理器上）。
    const wrapper = mount(SheetViewer, {
      props: { pattern: makePattern(100, 100), palette, name: "测试工程", thumbnail: "" },
      global: { stubs: { teleport: true } },
    });
    await flushPromises();
    await withViewport(wrapper);
    for (let i = 0; i < 12; i += 1) {
      await wrapper.get("[data-testid='sheet-zoom-in']").trigger("click");
    }
    // **前提检查**（同拖动那条）：图像必须真的比视口大，否则「拖动仍然生效」测不到平移。
    expect(scaleOf(wrapper) * requireRenderedPlan().canvasWidth).toBeGreaterThan(VIEWPORT.width);
    const stage = wrapper.get("[data-testid='sheet-stage']");
    const preview = () => wrapper.get("[data-testid='sheet-preview']").attributes("style");
    const before = preview();

    await stage.trigger("pointerdown", { pointerId: 1, button: 0, buttons: 1, clientX: 400, clientY: 300 });
    document.body.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 430, clientY: 310 }));
    // 之后仅仅悬停（**没有按键**）：旧实现会在这一步继续平移
    await stage.trigger("pointermove", { pointerId: 1, buttons: 0, clientX: 430, clientY: 310 });
    expect(preview()).toBe(before);

    // 清干净之后，正常的一次拖动仍然生效（守卫没有把手势状态机弄坏）
    await stage.trigger("pointerdown", { pointerId: 1, button: 0, buttons: 1, clientX: 400, clientY: 300 });
    await stage.trigger("pointermove", { pointerId: 1, buttons: 1, clientX: 470, clientY: 300 });
    await stage.trigger("pointerup", { pointerId: 1, clientX: 470, clientY: 300 });
    expect(preview()).not.toBe(before);
  });

  it("指针捕获被系统丢掉后，紧接落下的第二指不得被当成捏合（幽灵指针）", async () => {
    // **判死什么**：`setPointerCapture` 的捕获也会被系统无声丢掉（切窗口、手势被浏览器接管），此时
    // 舞台收不到 `pointerup`，`pointers` 里留下一条幽灵 id。`onPointerMove` 的 `buttons === 0` 那条
    // 兜底**必须先来一次 move** 才清得掉；用户直接落下第二指时 `pointers.size` 就成了 2 ⇒ 旧实现拿
    // 幽灵坐标起捏合，视图当场跳一下。同构的 `PatternCanvas.vue` 绑了 `@lostpointercapture`（并注明
    // 「否则画布会永久卡死」），本组件此前只绑了 `pointerup` / `pointercancel`。
    // 刻意**不预放大**（与捏合那条同一档 `fit`）：若先按 12 下放大到 `maxCellScale`，捏合会被夹住、
    // 比例不变量照样成立 —— 那样这条用例就算有幽灵也绿，等于没断言。
    const wrapper = mount(SheetViewer, {
      props: { pattern: makePattern(100, 100), palette, name: "测试工程", thumbnail: "" },
      global: { stubs: { teleport: true } },
    });
    await flushPromises();
    await withViewport(wrapper);
    const plan = requireRenderedPlan();
    const fit = minCellScale(VIEWPORT, sheetCellsOf(plan)) / plan.cellPx;
    // 前提检查：这一档必须真的还能再放大一倍，否则「没捏合」与「捏合了但被夹住」分不开
    expect(fit * 2).toBeLessThanOrEqual(maxCellScale(VIEWPORT, sheetCellsOf(plan)));
    const stage = wrapper.get("[data-testid='sheet-stage']");

    await stage.trigger("pointerdown", { pointerId: 1, button: 0, buttons: 1, clientX: 300, clientY: 300 });
    // 捕获被丢掉：**中间刻意没有 move**，所以 `buttons === 0` 那条兜底没有机会执行
    await stage.trigger("lostpointercapture", { pointerId: 1 });
    // 第二指落下并按到位：幽灵还在的话，这里就凑成了「两指捏合」（间距 100 → 200，比例 ×2）
    await stage.trigger("pointerdown", { pointerId: 2, button: 0, buttons: 1, clientX: 400, clientY: 300 });
    await stage.trigger("pointermove", { pointerId: 2, buttons: 1, clientX: 500, clientY: 300 });
    expect(scaleOf(wrapper)).toBeCloseTo(fit, 6);
  });

  it("捏合收拢后的最后一抬不算轻点：紧接着的一次轻点不会被误判成双击", async () => {
    // **判死什么**（C8 任务 6 第 1 轮审查的「次要 4」）：第二指落下时若不清 `pressOrigin`，
    // 两指落回第一指落点 12px 内时，最后一抬会被记成一次轻点 ⇒ 紧接着的一次真轻点就成了双击。
    const wrapper = mountViewer();
    await flushPromises();
    await withViewport(wrapper);
    const fit = scaleOf(wrapper);
    const stage = wrapper.get("[data-testid='sheet-stage']");

    await stage.trigger("pointerdown", { pointerId: 1, button: 0, buttons: 1, clientX: 400, clientY: 300 });
    await stage.trigger("pointerdown", { pointerId: 2, button: 0, buttons: 1, clientX: 600, clientY: 300 });
    await stage.trigger("pointerup", { pointerId: 2, clientX: 600, clientY: 300 });
    await stage.trigger("pointerup", { pointerId: 1, clientX: 400, clientY: 300 });
    // 紧接着一次轻点：若上一抬被记成 lastTap，这里就是「双击」⇒ 比例会跳到上限
    await stage.trigger("pointerdown", { pointerId: 1, button: 0, buttons: 1, clientX: 400, clientY: 300 });
    await stage.trigger("pointerup", { pointerId: 1, clientX: 400, clientY: 300 });
    expect(scaleOf(wrapper)).toBeCloseTo(fit, 5);
  });

  it("「打印」在查看层里打开打印页，关掉它回到查看层", async () => {
    const wrapper = mountViewer();
    await flushPromises();
    expect(wrapper.find("[data-testid='export-panel']").exists()).toBe(false);
    await wrapper.get("[data-testid='sheet-print']").trigger("click");
    expect(wrapper.find("[data-testid='export-panel']").exists()).toBe(true);
    await wrapper.get("[data-testid='export-close']").trigger("click");
    expect(wrapper.find("[data-testid='export-panel']").exists()).toBe(false);
    // 打印页用的是**同一份**用量（不重算第二遍统计）
    expect(wrapper.find("[data-testid='sheet-viewer']").exists()).toBe(true);
  });

  it("打印页的接线：pattern / palette / usages / project-name 四项都读过，且不是空数组、不是别的名字", async () => {
    // 名字与图纸都用**可辨识**的值：
    // - 名字取「另一个名字」而不是 fixture 默认的「测试工程」⇒ 组件里**写死常量**也会红；
    // - 图纸 2×2、格子值 `[0, 2, 2, 2]`（与 `makePattern()` 那份全 0 的同尺寸图纸不同）⇒
    //   把 `:pattern` 接成另一份**同尺寸**图纸也会红（同尺寸是为了排除「尺寸对不上才红」的假判据）。
    const sheet = {
      width: 2,
      height: 2,
      paletteId: palette.id,
      cells: new Uint16Array([0, 2, 2, 2]),
    };
    const wrapper = mount(SheetViewer, {
      props: { pattern: sheet, palette, name: "另一个名字", thumbnail: "" },
      global: { stubs: { teleport: true } },
    });
    await flushPromises();
    await wrapper.get("[data-testid='sheet-print']").trigger("click");

    const input = renderSheetBlob.mock.calls[0]?.[0] as SheetRenderInput;
    const panel = wrapper.findComponent(ExportPanel);
    // ① pattern：逐格取值 + 尺寸。**不用** `toBe(wrapper.props("pattern"))`：VTU 的 `mount` 把 props
    //    塞进 `reactive({})`，身份断言恒红（同一处记录见 `ResultPanel.test.ts` 的端到端用例）。
    const passedPattern = panel.props("pattern") as Pattern;
    expect(passedPattern.width).toBe(2);
    expect(passedPattern.height).toBe(2);
    expect(Array.from(passedPattern.cells)).toEqual([0, 2, 2, 2]);
    // ② palette：必须是查看层自己那一份色卡（漏传 / 接成 pattern 都会红）
    expect((panel.props("palette") as Palette).id).toBe(palette.id);
    // ③ project-name：字面量 + 与查看层自己的 props 同源（接成常量 / 别的字段都会红）
    expect(wrapper.props("name")).toBe("另一个名字");
    expect(panel.props("projectName")).toBe("另一个名字");
    expect(panel.props("projectName")).toBe(wrapper.props("name"));
    // ④ usages：**同一份对象**（重算一遍统计、或传空数组都会红），且不是空表：
    //    2×2 里 3 格第 2 色 + 1 格第 0 色
    const usages = panel.props("usages") as readonly ColorUsage[];
    expect(usages).toBe(input.usages);
    expect(usages).toHaveLength(2);
    expect(usages.map((usage) => usage.count).sort((a, b) => a - b)).toEqual([1, 3]);
  });

  it("接进覆盖层返回栈：closeTopOverlay() 关掉查看层", async () => {
    const wrapper = mountViewer();
    await flushPromises();
    expect(closeTopOverlay()).toBe(true);
    expect(wrapper.emitted("close")).toEqual([[]]);
    wrapper.unmount();
  });
});

/**
 * 「已知尺寸」的计划夹具：一组**真实量级**的数字——29×25 那条施工图的画布是
 * **2888×2736 画布像素**、每格 **96 画布像素**（网格 2784×2400 = 29×96 宽 × 25×96 高）。
 *
 * 其余字段（刻度带 / 用料条 / 标题…）用真 `planSheet` 的产物补齐，替身不该是残缺对象；
 * **本用例只读三个几何量**（`cellPx` / `canvasWidth` / `canvasHeight`），覆写它们是为了让判据不随
 * `core/render/layout.ts` 的版面常量漂移——这里要钉的是**「画布像素 ↔ 格」的换算**，不是某个具体常量；
 * `grid` 一并同步覆写，只为夹具自洽（29×96 = 2784、25×96 = 2400）。
 */
const KNOWN_PLAN: SheetPlan = {
  ...planSheet(makePattern(29, 25), palette, [], "已知尺寸"),
  cellPx: 96,
  canvasWidth: 2888,
  canvasHeight: 2736,
  grid: { x: 52, y: 136, width: 2784, height: 2400 },
};

/**
 * **C8 修复 ② 的承重判据**（真机 bug：查看页只显示左上角一条刻度带、只能放大不能缩小）。
 *
 * **为什么必须有这一组**：上一轮的全部断言都只对着 `view.scale` 自己（「点放大比例变大」），
 * 而缺陷恰恰是「`view.scale` 的语义（每格 CSS px）与被变换的 `<img>` 的坐标系（画布像素）不是
 * 同一个」——两条各自正确的量接在一起才出错，只读其中一条的断言在变异下全绿。这里的判据把
 * **两端钉在一起**：`<img>` 的固有尺寸（画布像素）× 样式里的 scale 必须等于「整张图的格宽 ×
 * 视图比例」，并且真的落在视口内。
 */
describe("SheetViewer 的画布像素 → 格 映射（C8 修复 ②）", () => {
  it("scale 除以 cellPx；默认视图整图可见；放大后能缩回整图", async () => {
    renderSheetBlob.mockResolvedValueOnce({
      blob: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
      plan: KNOWN_PLAN,
    });
    const wrapper = mountViewer();
    await flushPromises();
    await withViewport(wrapper, VIEWPORT.width, VIEWPORT.height);

    const plan = KNOWN_PLAN;
    const cells = sheetCellsOf(plan);
    /** 组件该用的**整图适配**比例（格单位）：core 的 `minCellScale` 对着整张图的格尺寸算。 */
    const viewScale = minCellScale(VIEWPORT, cells);
    const scale = scaleOf(wrapper);

    // ① `<img>` 的 CSS scale = view.scale / cellPx（画布像素 → 格）。少了这一除，一个画布像素被
    //    放大 view.scale 倍（2888 × 20.7 ≈ 59,700 CSS px），屏幕上只剩左上角。
    expect(scale).toBeCloseTo(viewScale / plan.cellPx, 6);

    // ② **两端钉在一起**：渲染出来的 CSS 宽度（画布像素 × scale）= 整张图的格宽 × view.scale。
    expect(scale * plan.canvasWidth).toBeCloseTo((plan.canvasWidth / plan.cellPx) * viewScale, 6);

    // ③ 默认视图**整图可见**（1px 容差）：这里量的是**真实画布**，不是格数。
    expect(scale * plan.canvasWidth).toBeLessThanOrEqual(VIEWPORT.width + 0.5);
    expect(scale * plan.canvasHeight).toBeLessThanOrEqual(VIEWPORT.height + 0.5);

    // ④ 坐标口径的**夹具说明**（如实标注：这几条不是对组件的判据）：整张图的格尺寸严格大于网格
    //    本身（2888/96 = 30.1 ⇒ 31 > 29；2736/96 = 28.5 ⇒ 29 > 25），且它在适配比例下也落在视口内
    //    （contain 口径的复述）。钉住的是**测试侧**的 `sheetCellsOf` 不被「简化」成
    //    `pattern.width/height`——那样 ① 的期望值会跟着一起漂，判据就自洽地错了。
    //    **组件**用错坐标系（拿格数当整图）由 ① 直接抓住：实测把 `sheetGrid` 改回
    //    `pattern.width/height` ⇒ ① 报 `expected 0.6667 to be close to 0.2155`。
    expect(cells.width).toBeGreaterThan(29);
    expect(cells.height).toBeGreaterThan(25);
    expect(cells.width * viewScale).toBeLessThanOrEqual(VIEWPORT.width + 0.5);
    expect(cells.height * viewScale).toBeLessThanOrEqual(VIEWPORT.height + 0.5);

    // ⑤ 能缩回来：默认视图就是缩放下限（`core/pattern/view.ts` 的 `defaultCellView` 取
    //    `minCellScale`），所以从放大态连点「缩小」必须**严格回落**并停在整图贴合；
    //    停在整图贴合时整张图仍然可见——这正是旧实现缺的那一半（缩不回整图）。
    //    **如实记录**：字面上的「点缩小后比例**小于**默认比例」在本仓库不可能成立
    //    （默认 ≡ 下限），见 `fix-realia-report.md` 的规格冲突登记。
    for (let i = 0; i < 4; i += 1) {
      await wrapper.get("[data-testid='sheet-zoom-in']").trigger("click");
    }
    const zoomed = scaleOf(wrapper);
    expect(zoomed).toBeGreaterThan(scale);

    for (let i = 0; i < 8; i += 1) {
      await wrapper.get("[data-testid='sheet-zoom-out']").trigger("click");
    }
    const shrunk = scaleOf(wrapper);
    expect(shrunk).toBeLessThan(zoomed);
    expect(shrunk).toBeCloseTo(scale, 6);
    expect(shrunk * plan.canvasWidth).toBeLessThanOrEqual(VIEWPORT.width + 0.5);
    expect(shrunk * plan.canvasHeight).toBeLessThanOrEqual(VIEWPORT.height + 0.5);
  });
});

/**
 * 任务 16：像素风换皮（§7.6）。这一组只钉「换皮没有动到既有锚点」与「新外观真的落地」——
 * 缩放数学、手势、保存路径的判别力在文件前面的各组里，这里一条都不重复。
 *
 * **testid 是封闭清单（§11.1）**：施工图是单张图，分页在 `ExportPanel`。这里同时钉住
 * `page-prev` / `page-next` **不存在**——防止后来者照着已被推翻的头脑风暴屏稿加回多页模型。
 */
describe("SheetViewer 的像素风换皮（任务 16）", () => {
  it("12 个既有 testid 一个不少（条件分支的三个也各挂一次）", async () => {
    const ok = mountViewer();
    // `sheet-loading` 只在现算结算前出现，先钉它；结算后它必须消失（不受本次换皮影响）
    expect(ok.find("[data-testid='sheet-loading']").exists()).toBe(true);
    await flushPromises();
    for (const id of [
      "sheet-viewer", "sheet-close", "sheet-title", "sheet-stage", "sheet-preview",
      "sheet-zoom-in", "sheet-zoom-out", "sheet-print", "sheet-save",
    ]) {
      expect(ok.find(`[data-testid='${id}']`).exists(), id).toBe(true);
    }
    expect(ok.find("[data-testid='sheet-loading']").exists()).toBe(false);

    // 剩下两个是条件分支：失败支的 `sheet-error`、保存后的 `sheet-save-state`
    renderSheetBlob.mockRejectedValueOnce(new Error("渲染失败"));
    const bad = mountViewer();
    await flushPromises();
    expect(bad.find("[data-testid='sheet-error']").exists()).toBe(true);

    await ok.get("[data-testid='sheet-save']").trigger("click");
    await flushPromises();
    expect(ok.find("[data-testid='sheet-save-state']").exists()).toBe(true);
  });

  it("没有分页元素（施工图是单张，分页在打印面板）", async () => {
    const wrapper = mountViewer();
    await flushPromises();
    expect(wrapper.find("[data-testid='page-prev']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='page-next']").exists()).toBe(false);
    // 不新增「适配窗口」（现在没有，规格 §7.6 明说不要）
    expect(wrapper.find("[data-testid='sheet-zoom-fit']").exists()).toBe(false);
  });

  it("五颗图标按钮都带中文 aria-label（图标是它们唯一的可见内容）", async () => {
    const wrapper = mountViewer();
    await flushPromises();
    expect(wrapper.get("[data-testid='sheet-close']").attributes("aria-label")).toBe("关闭");
    expect(wrapper.get("[data-testid='sheet-print']").attributes("aria-label")).toBe("打印");
    expect(wrapper.get("[data-testid='sheet-save']").attributes("aria-label")).toBe("保存");
    expect(wrapper.get("[data-testid='sheet-zoom-in']").attributes("aria-label")).toBe("放大");
    expect(wrapper.get("[data-testid='sheet-zoom-out']").attributes("aria-label")).toBe("缩小");
  });

  it("深色底用的是 bead-board，且点阵真的落在行内样式上（Review Focus 3）", async () => {
    const wrapper = mountViewer();
    await flushPromises();
    const stage = wrapper.get("[data-testid='sheet-stage']");
    expect(stage.classes().join(" ")).toContain("bg-bead-board");
    expect(stage.attributes("style")).toContain("radial-gradient");
  });

  it("五颗按钮都满足 56px 硬下界（R35：旧的 44px 已作废）", async () => {
    const wrapper = mountViewer();
    await flushPromises();
    // 顶栏三颗圆按钮走 `BeadButton` 的 icon 变体（min-h-14 / min-w-14）
    for (const id of ["sheet-close", "sheet-print", "sheet-save"]) {
      const classes = wrapper.get(`[data-testid='${id}']`).classes().join(" ");
      expect(classes, id).toContain("min-h-14");
      expect(classes, id).toContain("min-w-14");
    }
    // 底栏两颗方按钮是手写的原生 button（R9：不为 BeadButton 加 size/square 开关）
    for (const id of ["sheet-zoom-in", "sheet-zoom-out"]) {
      const classes = wrapper.get(`[data-testid='${id}']`).classes().join(" ");
      expect(classes, id).toContain("h-14");
      expect(classes, id).toContain("w-14");
      expect(classes, id).toContain("border-4");
    }
  });

  it("loading / error 换成本文提示条样式，文案一字未动", async () => {
    const wrapper = mountViewer();
    const loading = wrapper.get("[data-testid='sheet-loading']");
    expect(loading.text()).toBe("正在生成施工图…");
    const loadingClasses = loading.classes().join(" ");
    expect(loadingClasses).toContain("bg-bead-warn-bg");
    expect(loadingClasses).toContain("text-bead-warn-ink");
    expect(loadingClasses).toContain("border-bead-ink");

    renderSheetBlob.mockRejectedValueOnce(new Error("画布尺寸被浏览器钳制"));
    const bad = mountViewer();
    await flushPromises();
    const error = bad.get("[data-testid='sheet-error']");
    expect(error.text()).toBe("图纸生成失败：画布尺寸被浏览器钳制");
    const errorClasses = error.classes().join(" ");
    expect(errorClasses).toContain("bg-bead-warn-bg");
    expect(errorClasses).toContain("text-bead-warn-ink");
    expect(errorClasses).toContain("border-bead-ink");
  });
});

/**
 * T1：覆盖层挂到 **body 顶层** + 打开时锁页面滚动（实机反馈 4 的两个根因）。
 *
 * **本组刻意不 stub `Teleport`**：它们钉的正是「真的被传送到 body 去了」，stub 掉等于把被测对象
 * 删掉（而这正是前面每一条都必须 stub 的原因——VTU 的 `wrapper.find` 看不到传送出去的节点）。
 * 代价：这里的查询自己从 `document.body` 来。
 *
 * **为什么开头要把残留的锁放干净**：锁是**模块级计数**，而本文件早先很多用例挂了就不卸载
 * （历史如此，不在本次改动范围）⇒ 计数已被它们留在非 0。用公开 API 放干净之后再把基线钉住，
 * 否则「卸载后滚动还原」那句会读到别人留下的计数（假红）。
 */
describe("SheetViewer 的覆盖层层级与滚动锁（T1）", () => {
  beforeEach(() => {
    while (true) {
      try {
        unlockBodyScroll();
      } catch {
        break;
      }
    }
    expect(document.body.style.overflow).toBe("");
  });

  /** 传送出去的节点要从 `document.body` 查（`wrapper.find` 看不到它们）。 */
  const inBody = (): DOMWrapper<Element> => new DOMWrapper(document.body);

  it("查看层是 body 的直接子节点（z-50），打开时锁住 body 滚动，卸载后节点收走、滚动还原", async () => {
    // 基线：没有残留的覆盖层与锁
    expect(document.body.querySelector("[data-testid='sheet-viewer']")).toBeNull();
    expect(document.body.style.overflow).toBe("");

    const wrapper = mount(SheetViewer, {
      props: { pattern: makePattern(), palette, name: "测试工程", thumbnail: "" },
    });
    await flushPromises();
    const node = document.body.querySelector("[data-testid='sheet-viewer']");

    // ① **传送到 body**：它是 `document.body` 的**直接子节点**。挂在中栏（`position: sticky` +
    //    `overflow-y-auto`）里时，祖先建不出让后代的 z-index 参与根层级比较的上下文 ⇒ 生图页那条
    //    `z-10` 底栏会画在覆盖层之上（实机反馈 4）。这一条断言在「没传送」时直接红（节点为 null）。
    expect(node).not.toBeNull();
    expect(node?.parentElement).toBe(document.body);
    // ② `z-50`：高于生图页底栏 `z-10`、离开确认条 `z-40`；`overscroll-contain` 挡住滚动链。
    expect(node?.classList.contains("z-50"), "施工图应为 z-50").toBe(true);
    expect(node?.classList.contains("overscroll-contain")).toBe(true);
    // ③ 开着时页面锁住（实机反馈 4：滑动覆盖层外部能感到生图页上下滑）
    expect(document.body.style.overflow).toBe("hidden");

    // ④ 卸载 = 关闭：节点被收走、滚动还原
    wrapper.unmount();
    expect(document.body.querySelector("[data-testid='sheet-viewer']")).toBeNull();
    expect(document.body.style.overflow).toBe("");
  });

  it("打印面板也是 body 的直接子节点且 z 序更高；先关打印不解锁，关掉查看层才解锁", async () => {
    expect(document.body.querySelector("[data-testid='sheet-viewer']")).toBeNull();
    expect(document.body.style.overflow).toBe("");

    const wrapper = mount(SheetViewer, {
      props: { pattern: makePattern(), palette, name: "测试工程", thumbnail: "" },
    });
    await flushPromises();
    // 查看层的按钮也挂在 body 里，所以这里同样要从 body 上点。
    await inBody().get("[data-testid='sheet-print']").trigger("click");

    const sheet = document.body.querySelector("[data-testid='sheet-viewer']");
    const panel = document.body.querySelector("[data-testid='export-panel']");
    // ① 打印面板**不在**查看层section 里（否则它仍会被查看层那个层叠上下文 / 裁剪框住），
    //    而是 body 的另一个直接子节点 ⇒ 「面板压在查看层之上」由 z 序决定，不靠「是最后一个子元素」。
    expect(panel?.parentElement).toBe(document.body);
    expect(sheet?.parentElement).toBe(document.body);
    expect(sheet?.contains(panel ?? null)).toBe(false);
    expect(sheet?.classList.contains("z-50")).toBe(true);
    expect(panel?.classList.contains("z-60"), "打印面板应为 z-60").toBe(true);

    // ② **先关打印**（嵌套锁的那一半）：面板收走，但查看层还开着 ⇒ body **仍被锁着**。
    //    这正是「各写各的 `document.body.style.overflow`」会错的地方：打印先关时若直接写回空串，
    //    还开着的查看层就漏了（实机反馈 4 的穿透）。
    await inBody().get("[data-testid='export-close']").trigger("click");
    expect(document.body.querySelector("[data-testid='export-panel']")).toBeNull();
    expect(document.body.querySelector("[data-testid='sheet-viewer']")).not.toBeNull();
    expect(document.body.style.overflow).toBe("hidden");

    // ③ 再关查看层：计数归零，滚动还原
    wrapper.unmount();
    expect(document.body.querySelector("[data-testid='sheet-viewer']")).toBeNull();
    expect(document.body.style.overflow).toBe("");
  });
});
