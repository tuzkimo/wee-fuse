import { mount, flushPromises } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { EMPTY } from "@/core/pattern/types";
import { toProjectDocument } from "@/core/project/file";
import type { ProjectParams } from "@/core/project/types";
import { createMemoryProjectStore } from "@/services/memoryProjectStore";
import { getBuiltinPalette } from "@/services/palette";
import {
  setProjectStore,
  type ProjectMeta,
  type ProjectRecord,
} from "@/services/projectStore";
import { makeRecord } from "@/services/__tests__/projectStoreContract";
import { useDraft } from "@/stores/draft";
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

/**
 * `useRouter().push` 的**稳定**替身。
 *
 * 原来是 `useRouter: () => ({ push: vi.fn() })`——每次调用 `useRouter()` 都新建一个 spy，
 * 用例因此**拿不到**组件真正调用的那个函数，「点了按钮有没有跳转到 setup」无法断言。
 * 改为 `vi.hoisted` 出来的同一个 spy（提升后可被 `vi.mock` 工厂引用）。既有用例不读 `push`，
 * 所以这条替换不改变任何既有断言的结果。
 */
const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }));

vi.mock("vue-router", () => ({
  useRoute: () => ({ params: { id: "a" } }),
  useRouter: () => ({ push: pushMock }),
  RouterLink: { template: "<a><slot /></a>" },
}));

const palette = getBuiltinPalette();

/**
 * 2×1 的图纸、色卡自洽（用内置色卡的第 0 号色，另有一格是空格）。
 *
 * `params` 默认是原有的那组值（长边 2 / 档位 16 / 8×8 未旋转）；重跑用例传一组**非默认**值，
 * 否则「参数有没有真的被播种」无法与草稿的默认值区分（默认旋转是 0，把 rotation 写成 0 也不会红）。
 */
function makeEditorRecord(
  options: { withSource?: boolean; params?: ProjectParams } = {},
): ProjectRecord {
  const doc = toProjectDocument(
    { width: 2, height: 1, paletteId: palette.id, cells: Uint16Array.from([0, EMPTY]) },
    palette,
    options.params ?? { longSide: 2, maxColors: 16, crop: { x: 0, y: 0, w: 8, h: 8, rotate: 0 } },
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

/**
 * 编辑器里的「改参数重新生成」入口（B2 规格 §7）。
 *
 * 与上面那组用例共用夹具工厂，但**参数刻意取非默认值**：长边 37（草稿默认 58）、档位 16
 * （草稿默认 32）、旋转 1（草稿默认 0）。否则「参数有没有真的从落盘记录播种进草稿」与
 * 「草稿本来就是默认值」不可区分——把播种删掉照样绿，这是本项目反复踩过的
 * 「断言存在 ≠ 断言有效」。
 */
describe("改参数重新生成（B2 规格 §7）", () => {
  const RERUN_PARAMS: ProjectParams = {
    longSide: 37,
    maxColors: 16,
    crop: { x: 2, y: 3, w: 8, h: 8, rotate: 1 },
  };

  beforeEach(async () => {
    setActivePinia(createPinia());
    pushMock.mockClear();
    const store = await createMemoryProjectStore();
    await store.put(makeEditorRecord({ withSource: true, params: RERUN_PARAMS }));
    setProjectStore(store);
  });

  it("原图已保存时给出入口，点它把参数播种进草稿并跳到选区页", async () => {
    // 简报写的是 `mount(EditorPage, { global: { plugins: [router] } })`，但本文件的
    // `vue-router` 整个被 `vi.mock` 掉了，没有真 router 可注入——`useRouter()` 已经是替身，
    // 组件不装插件也能拿到它（上面 5 条既有用例就是这么挂的）。
    const wrapper = mount(EditorPage);
    await flushPromises();

    // 入口的名字是给用户看的：只有按钮没有标签、或标签写错，用户不知道这一下会发生什么
    expect(wrapper.get("[data-testid='rerun']").text()).toContain("改参数重新生成");

    const draft = useDraft();
    // 点之前草稿必须是干净的：否则下面的断言分不清「这一点点出来的」还是「本来就有的」。
    expect(draft.source).toBeNull();
    expect(draft.rerunOf).toBeNull();

    await wrapper.get("[data-testid='rerun']").trigger("click");

    // 只跳一次、而且只跳选区页（不是 pick，也不是 editor）
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledWith({ name: "setup" });

    // 身份：id / 名称 / createdAt 原样沿用，重跑才会覆盖同一条记录（规格 §7）
    expect(draft.rerunOf).toEqual({
      id: "a",
      name: "小猫",
      createdAt: "2026-10-03T00:00:00.000Z",
    });
    expect(draft.longSide).toBe(37);
    expect(draft.maxColors).toBe(16);
    // 旋转取自**落盘参数**的 `crop.rotate`（=1），不是运行期草稿的默认 0
    expect(draft.rotation).toBe(1);

    // 「不解码」：尺寸、选区、预览都要等 `SetupPage`（原图尺寸没解码出来时不该有选区）
    expect(draft.sourceSize).toBeNull();
    expect(draft.crop).toBeNull();
    expect(draft.preview).toBeNull();

    // 原图带着字节进了草稿——`SetupPage` 的解码入口就是它
    if (draft.source === null) throw new Error("重跑入口没有把原图播种进草稿");
    expect(draft.source.type).toBe("image/png");
    expect(draft.source.name).toBe("小猫");
    expect([...new Uint8Array(await draft.source.blob.arrayBuffer())]).toEqual([7, 8]);

    // 选区这一项**只能这样观测**：`adoptProject` 把 crop 存进不公开的 `pendingCrop`，
    // `crop` 此刻按设计是 null。`setSourceSize` 正是 `SetupPage` 解码后的那一步，
    // 走到它才能看出编辑器有没有把 crop 真的传过去（漏传会让 `crop` 落成居中正方 100×100）。
    draft.setSourceSize({ width: 100, height: 100 });
    expect(draft.crop).toEqual({ x: 2, y: 3, width: 8, height: 8 });
  });

  it("没有保存原图的工程不给出入口（维持既有的琥珀提示）", async () => {
    const noSource = await createMemoryProjectStore();
    await noSource.put(makeEditorRecord({ params: RERUN_PARAMS }));
    setProjectStore(noSource);
    const wrapper = mount(EditorPage);
    await flushPromises();

    expect(wrapper.find("[data-testid='rerun']").exists()).toBe(false);
    expect(wrapper.get("[data-testid='rerun-unavailable']").text()).toContain("没有保存原图");
    // 两条分支互斥，而且没有原图只是「不能重跑」，不是「打不开」：点不了也不该点错
    expect(wrapper.find("[data-testid='rerun-available']").exists()).toBe(false);
    expect(wrapper.text()).toContain("小猫");
    expect(pushMock).not.toHaveBeenCalled();
  });
});
