import { mount, flushPromises } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { EMPTY } from "@/core/pattern/types";
import { toProjectDocument } from "@/core/project/file";
import { createMemoryProjectStore } from "@/services/memoryProjectStore";
import { getBuiltinPalette } from "@/services/palette";
import {
  setProjectStore,
  type ProjectMeta,
  type ProjectRecord,
} from "@/services/projectStore";
import { makeRecord } from "@/services/__tests__/projectStoreContract";
import EditorPage from "@/views/EditorPage.vue";

/**
 * 编辑器只读页（B1 边界）的组件用例。
 *
 * **夹具自己造，不用 `makeRecord`**：编辑器走的是 `useProjectSession().load()` →
 * `fromProjectDocument(doc, getBuiltinPalette())`，而 `validateProjectDocument` 要求
 * `doc.palette.id` 与**当前载入的色卡**一致、且每个色号都能在它里面查到。
 * `projectStoreContract` 的 `makeRecord` 用的是 id 为 `"fake"` 的三色测试色卡，
 * 所以它造出来的记录在这条路径上必然抛「色卡不一致」——这正是简报 EditorPage 用例的缺陷
 * （见任务 7 报告「从简报代码块里改掉的缺陷」）。用 `"fake"` 夹具的那条路径单独有一条用例守着
 * （「引用了别的色卡」），这里造的是色卡自洽的夹具。
 */

vi.mock("vue-router", () => ({
  useRoute: () => ({ params: { id: "a" } }),
  useRouter: () => ({ push: vi.fn() }),
  RouterLink: { template: "<a><slot /></a>" },
}));

const palette = getBuiltinPalette();

/** 2×1 的图纸、色卡自洽（用内置色卡的第 0 号色，另有一格是空格）。 */
function makeEditorRecord(options: { withSource?: boolean } = {}): ProjectRecord {
  const doc = toProjectDocument(
    { width: 2, height: 1, paletteId: palette.id, cells: Uint16Array.from([0, EMPTY]) },
    palette,
    { longSide: 2, maxColors: 16, crop: { x: 0, y: 0, w: 8, h: 8, rotate: 0 } },
  );
  const meta: ProjectMeta = {
    id: "a",
    name: "小猫",
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T01:00:00.000Z",
    thumbnail: "",
    // 故意的错误值：`put` 必须从 doc 覆盖这三项（列表与详情看到的是同一份派生值）
    width: 999,
    height: 999,
    colorCount: 999,
  };
  return {
    meta,
    doc,
    source:
      options.withSource === true
        ? { blob: new Blob([new Uint8Array([7, 8])]), type: "image/png" }
        : null,
  };
}

describe("EditorPage（B1 只读版）", () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    const store = await createMemoryProjectStore();
    await store.put(makeEditorRecord({ withSource: true }));
    setProjectStore(store);
  });

  it("载入工程并显示名称与尺寸", async () => {
    const wrapper = mount(EditorPage);
    await flushPromises();
    expect(wrapper.text()).toContain("小猫");
    // 尺寸与用色数来自 `put` 从 doc 派生的冗余字段（夹具入参是 999，必须被覆盖）
    expect(wrapper.text()).toContain("2 × 1");
    expect(wrapper.text()).toContain("1 种颜色");
    expect(wrapper.find("[data-testid='editor-error']").exists()).toBe(false);
  });

  it("有原图时显示「可以改参数重跑」，没有时明确禁用并给原因", async () => {
    const wrapper = mount(EditorPage);
    await flushPromises();
    expect(wrapper.find("[data-testid='rerun-available']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='rerun-unavailable']").exists()).toBe(false);

    const noSource = await createMemoryProjectStore();
    await noSource.put(makeEditorRecord());
    setProjectStore(noSource);
    const second = mount(EditorPage);
    await flushPromises();
    expect(second.find("[data-testid='rerun-unavailable']").text()).toContain("原图");
    // 两条分支互斥：没有原图时不能同时说「原图已保存」
    expect(second.find("[data-testid='rerun-available']").exists()).toBe(false);
    // 名称与尺寸照常显示：没有原图只是「不能改参数重跑」，不是「打不开」
    expect(second.text()).toContain("小猫");
  });

  it("找不到工程时显示错误，不白屏", async () => {
    setProjectStore(await createMemoryProjectStore());
    const wrapper = mount(EditorPage);
    await flushPromises();
    expect(wrapper.find("[data-testid='editor-error']").text()).toContain("找不到");
  });

  it("工程引用了别的色卡时把原因显示出来，而不是拿当前色卡硬套", async () => {
    // 这是简报 EditorPage 用例的夹具**实际**走到的分支（`makeRecord` 的色卡 id 是 `"fake"`）：
    // 旧版本 / 换过色卡的工程必须响亮失败，否则每个色号都会被静默标成别的颜色。
    const store = await createMemoryProjectStore();
    await store.put(makeRecord("a", "小猫", "2026-10-03T01:00:00.000Z"));
    setProjectStore(store);
    const wrapper = mount(EditorPage);
    await flushPromises();
    expect(wrapper.find("[data-testid='editor-error']").text()).toContain("色卡");
  });

  it("标注了「编辑器将在后续计划提供」这一 B1 边界", async () => {
    const wrapper = mount(EditorPage);
    await flushPromises();
    expect(wrapper.find("[data-testid='editor-todo']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='editor-todo']").text()).toContain("后续计划");
  });
});
