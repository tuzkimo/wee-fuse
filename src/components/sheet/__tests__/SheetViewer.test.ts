import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { getBuiltinPalette } from "@/services/palette";
import type { SheetRenderInput } from "@/services/sheetExport";
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

  it("查看层显示色卡精度声明（C7 起图上不印了，声明搬到这里）", async () => {
    const wrapper = mountViewer();
    await flushPromises();
    const line = wrapper.get("[data-testid='sheet-accuracy']").text();
    expect(line).toBe(palette.accuracy);
    expect(line.length).toBeGreaterThan(0);
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
  it("三个按钮都在（适配 / 放大 / 缩小）", async () => {
    const wrapper = mountViewer();
    await flushPromises();
    expect(wrapper.find("[data-testid='sheet-zoom-fit']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='sheet-zoom-in']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='sheet-zoom-out']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='sheet-stage']").exists()).toBe(true);
  });

  it("视口量不到尺寸（happy-dom 返回 0）时缩放按钮不改变视图，也不抛错", async () => {
    const wrapper = mountViewer();
    await flushPromises();
    const before = wrapper.get("[data-testid='sheet-stage']").attributes("style");
    await wrapper.get("[data-testid='sheet-zoom-in']").trigger("click");
    await wrapper.get("[data-testid='sheet-zoom-out']").trigger("click");
    await wrapper.get("[data-testid='sheet-zoom-fit']").trigger("click");
    // 视口为 0 ⇒ `view` 保持 null ⇒ `<img>` 仍是「垫场/全宽」那一支（内联样式不变）
    expect(wrapper.get("[data-testid='sheet-stage']").attributes("style")).toBe(before);
    expect(wrapper.find("[data-testid='sheet-error']").exists()).toBe(false);
  });
});
