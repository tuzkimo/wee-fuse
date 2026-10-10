import { flushPromises, mount } from "@vue/test-utils";
import { nextTick } from "vue";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { closeTopOverlay } from "@/composables/useOverlayBack";
import type { Palette } from "@/core/palette/types";
import type { ColorUsage } from "@/core/pattern/stats";
import type { Pattern } from "@/core/pattern/types";
import { getBuiltinPalette } from "@/services/palette";
import type { SheetRenderInput } from "@/services/sheetExport";
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
 * 渲染通道替身：默认给一颗非空 blob（真画布与自检不在组件用例里测）。
 *
 * **做成 `vi.fn()` 而不是写死的箭头函数**：失败路径（渲染抛错）必须能被驱动。
 */
const renderSheetBlob = vi.hoisted(() => vi.fn());
vi.mock("@/services/sheetExport", () => ({ renderSheetBlob }));

const palette = getBuiltinPalette();

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
  renderSheetBlob
    .mockReset()
    .mockImplementation(async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));
  // happy-dom 下这两个方法可能不存在，所以直接赋值
  createObjectUrl = vi.fn<(blob: Blob) => string>(() => "blob:test-1");
  revokeObjectUrl = vi.fn<(url: string) => void>();
  URL.createObjectURL = createObjectUrl as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = revokeObjectUrl as unknown as typeof URL.revokeObjectURL;
});

/** 现算入参：一次挂载 + 结算。 */
function mountViewer(overrides: Partial<{ name: string; thumbnail: string }> = {}) {
  return mount(SheetViewer, {
    props: {
      pattern: makePattern(),
      palette,
      name: overrides.name ?? "测试工程",
      thumbnail: overrides.thumbnail ?? "",
    },
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
    expect((button.element as HTMLButtonElement).disabled).toBe(true);
    release();
    await flushPromises();
    expect(albumSave).toHaveBeenCalledTimes(1);
    expect((button.element as HTMLButtonElement).disabled).toBe(false);
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
    let settle: (blob: Blob) => void = () => undefined;
    renderSheetBlob.mockImplementationOnce(
      () => new Promise<Blob>((resolve) => {
        settle = resolve;
      }),
    );
    const wrapper = mountViewer({ thumbnail: "data:image/png;base64,AAAA" });
    await flushPromises();
    expect(renderSheetBlob).toHaveBeenCalledTimes(1);
    expect(createObjectUrl).not.toHaveBeenCalled();

    wrapper.unmount(); // 用户在现算结算前点了「关闭」
    settle(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));
    await flushPromises();
    expect(createObjectUrl).not.toHaveBeenCalled();
    expect(revokeObjectUrl).not.toHaveBeenCalled();
  });
});

/**
 * 缩放（C7 新增）：**判别力在 core 的纯函数用例里**（`core/pattern/view.test.ts`），
 * 这一组只证明「按钮接上了 core 的视图数学」——happy-dom 的 `getBoundingClientRect()` 返回全 0，
 * 视口尺寸在 CI 里恒为 0，任何「缩放到某个具体比例」的断言在这里都是假的。
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
    // 净效果停在**放大那一侧**，且明显大于适配（若被 dblclick 弹回去，这里会等于 fit）
    expect(zoomed).toBeGreaterThan(fit);
    expect(zoomed).toBeGreaterThan(fit * 2);
  });

  it("单指拖动会平移视图（transform 的 translate 变化）", async () => {
    // **用 100×100 的图纸**：2×1 在 800×600 里默认视图是 64px/格（`minCellScale` 的上限），
    // 图像只有 128px 宽 < 视口 ⇒ `clampView` 把它按居中夹住，拖动**什么都不会变**（假绿）。
    // 100×100 的适配比例是 6px/格，连点 8 次放大后 6×1.25⁸ ≈ 35 → 图像 3500px，横向真的可拖。
    const wrapper = mount(SheetViewer, {
      props: { pattern: makePattern(100, 100), palette, name: "测试工程", thumbnail: "" },
    });
    await flushPromises();
    await withViewport(wrapper);
    for (let i = 0; i < 8; i += 1) {
      await wrapper.get("[data-testid='sheet-zoom-in']").trigger("click");
    }
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
    // 100×100 在 800×600 里适配恰好 6px/格（上界 64）⇒ 2 倍 / 0.75 倍都落在可缩放区间内，
    // 不会被 `zoomCellView` 的夹取掩盖（夹住了就分辨不出「比例真的按间距算」还是「没动」）。
    // **判别力**：把捏合分支删掉、只留单指平移，这里的比例会停在 6 ⇒ 三条断言全红。
    const wrapper = mount(SheetViewer, {
      props: { pattern: makePattern(100, 100), palette, name: "测试工程", thumbnail: "" },
    });
    await flushPromises();
    await withViewport(wrapper);
    expect(scaleOf(wrapper)).toBe(6);
    const stage = wrapper.get("[data-testid='sheet-stage']");

    await stage.trigger("pointerdown", { pointerId: 1, button: 0, buttons: 1, clientX: 300, clientY: 300 });
    await stage.trigger("pointerdown", { pointerId: 2, button: 0, buttons: 1, clientX: 400, clientY: 300 });
    // 两指间距 100 → 200：比例 ×2（`buttons: 1`：两指都还按在屏幕上，理由同拖动那条）
    await stage.trigger("pointermove", { pointerId: 2, buttons: 1, clientX: 500, clientY: 300 });
    expect(scaleOf(wrapper)).toBeCloseTo(12, 5);

    // 间距 200 → 150：比例 ×0.75（增量口径：比值是 150/200）
    await stage.trigger("pointermove", { pointerId: 2, buttons: 1, clientX: 450, clientY: 300 });
    expect(scaleOf(wrapper)).toBeCloseTo(9, 5);

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
    });
    await flushPromises();
    await withViewport(wrapper);
    for (let i = 0; i < 8; i += 1) {
      await wrapper.get("[data-testid='sheet-zoom-in']").trigger("click");
    }
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
