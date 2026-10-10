import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getBuiltinPalette } from "@/services/palette";
import ResultPanel from "@/components/result/ResultPanel.vue";

/**
 * 结果卡片（C8 规格 §3.4）：两个宿主共用，纯展示（不 import store）。
 * 预览缩略图走替身——happy-dom 的 canvas 没有像素语义，本文件只钉按钮与文案。
 */
vi.mock("@/services/patternThumbnail", () => ({
  renderPatternThumbnail: () => "data:image/png;base64,AAAA",
  RESULT_PREVIEW_MAX_EDGE: 1600,
}));
vi.mock("@/services/sheetExport", () => ({
  renderSheetBlob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
}));

const palette = getBuiltinPalette();
const pattern = { width: 4, height: 4, paletteId: palette.id, cells: new Uint16Array(16) };

function mountPanel(overrides: Record<string, unknown> = {}) {
  return mount(ResultPanel, {
    props: { pattern, palette, isNew: true, canRerun: true, ...overrides },
  });
}

beforeEach(() => {
  setActivePinia(createPinia());
  URL.createObjectURL = vi.fn(() => "blob:result-1") as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
});

describe("ResultPanel（C8：四颗按钮、没有打印）", () => {
  it("四颗按钮的顺序与文案：重做 / 查看 / 编辑 / OK", () => {
    const texts = mountPanel().findAll("button").map((button) => button.text());
    expect(texts).toEqual(["重做", "查看", "编辑", "OK"]);
  });

  it("编辑是白底、OK 是黑底（主操作是「结束回家」）", () => {
    const wrapper = mountPanel();
    const edit = wrapper.get("[data-testid='open-editor']");
    const ok = wrapper.get("[data-testid='result-ok']");
    expect(edit.classes()).not.toContain("bg-slate-900");
    expect(edit.classes()).toContain("border-slate-300");
    expect(ok.classes()).toContain("bg-slate-900");
  });

  it("没有「打印」按钮（打印从查看层里进）", () => {
    expect(mountPanel().find("[data-testid='result-print']").exists()).toBe(false);
  });

  it("canRerun 为假时不渲染「重做」", () => {
    expect(mountPanel({ canRerun: false }).find("[data-testid='result-rerun']").exists()).toBe(false);
  });

  it("三颗按钮各 emit 自己那一个事件", async () => {
    const wrapper = mountPanel();
    await wrapper.get("[data-testid='result-rerun']").trigger("click");
    await wrapper.get("[data-testid='open-editor']").trigger("click");
    await wrapper.get("[data-testid='result-ok']").trigger("click");
    expect(wrapper.emitted("rerun")).toHaveLength(1);
    expect(wrapper.emitted("edit")).toHaveLength(1);
    expect(wrapper.emitted("ok")).toHaveLength(1);
  });

  it("「查看」打开查看层（本组件自带它，宿主不必知道）", async () => {
    const wrapper = mountPanel();
    expect(wrapper.find("[data-testid='sheet-viewer']").exists()).toBe(false);
    await wrapper.get("[data-testid='result-view-sheet']").trigger("click");
    expect(wrapper.find("[data-testid='sheet-viewer']").exists()).toBe(true);
  });

  it("保存文案按 isNew 分叉", () => {
    expect(mountPanel({ isNew: true }).get("[data-testid='result-save-state']").text()).toBe("已保存到图纸库");
    expect(mountPanel({ isNew: false }).get("[data-testid='result-save-state']").text()).toBe("已更新这张图纸");
  });
});
