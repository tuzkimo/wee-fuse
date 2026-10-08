import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { toProjectDocument } from "@/core/project/file";
import { getBuiltinPalette } from "@/services/palette";
import { createMemoryProjectStore } from "@/services/memoryProjectStore";
import { setProjectStore } from "@/services/projectStore";
import type { SheetRenderInput } from "@/services/sheetExport";
import SheetViewer from "@/components/sheet/SheetViewer.vue";

/**
 * 能力层替身：本组件只碰 `album.save`。
 *
 * **`kind` 做成可变的一个格子**（不是简报原文的写死 `"album"`）：成功文案按落点分叉，而简报的
 * 四条用例**只走过 `album` 这一支**——写死的替身让 `download` 那一支零覆盖，
 * 把文案改成常量也全绿。`getPlatform` 每次调用现读 `albumKind.value`，用例里改一格即可切支。
 */
const albumSave = vi.hoisted(() => vi.fn());
const albumKind = vi.hoisted(() => ({ value: "album" }));
vi.mock("@/services/platform/capabilities", () => ({
  getPlatform: () => ({ album: { kind: albumKind.value, save: albumSave } }),
}));

/**
 * 渲染通道替身：默认给一颗非空 blob（真画布与自检不在这里测）。
 *
 * **做成 `vi.fn()` 而不是简报原文那颗写死的箭头函数**：失败路径（渲染抛错）必须能被驱动，
 * 而写死的实现没有任何注入点。默认实现与简报那颗**逐字同值**，在 `beforeEach` 里重装。
 */
const renderSheetBlob = vi.hoisted(() => vi.fn());
vi.mock("@/services/sheetExport", () => ({ renderSheetBlob }));

const palette = getBuiltinPalette();

/**
 * object URL 的两个替身**留具名引用**（简报原文直接赋值 `URL.createObjectURL = vi.fn(...)`，
 * 只留返回串、读不到实参）。留引用的理由：本组件最承重的一条纪律是「预览用的与落盘的**是同一颗
 * blob**」——只记返回串时，`createObjectURL(别的 blob)` 照样绿（`exportTestKit.createdBlobs`
 * 记实参是同一条理由）。
 */
let createObjectUrl: Mock<(blob: Blob) => string>;
let revokeObjectUrl: Mock<(url: string) => void>;

/** 往内存库里塞一条可解析的工程（doc 由 `toProjectDocument` 造，保证能过 `fromProjectDocument` 的校验）。 */
async function seedRecord(name = "测试工程"): Promise<void> {
  const store = await createMemoryProjectStore();
  const pattern = { width: 2, height: 1, paletteId: palette.id, cells: new Uint16Array([0, 0]) };
  await store.put({
    meta: {
      id: "p1",
      name,
      createdAt: "2026-10-08T00:00:00.000Z",
      updatedAt: "2026-10-08T00:00:00.000Z",
      thumbnail: "data:image/png;base64,AAAA",
      width: 0,
      height: 0,
      colorCount: 0,
    },
    doc: toProjectDocument(pattern, palette, {
      longSide: 58,
      maxColors: null,
      crop: { x: 0, y: 0, w: 2, h: 1, rotate: 0 },
    }),
    source: null,
  });
  setProjectStore(store);
}

beforeEach(() => {
  albumSave.mockReset();
  albumKind.value = "album";
  renderSheetBlob
    .mockReset()
    .mockImplementation(async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));
  // happy-dom 下这两个方法可能不存在，所以直接赋值（与 `exportTestKit.stubObjectUrl` 同一手法）
  createObjectUrl = vi.fn<(blob: Blob) => string>(() => "blob:test-1");
  revokeObjectUrl = vi.fn<(url: string) => void>();
  URL.createObjectURL = createObjectUrl as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = revokeObjectUrl as unknown as typeof URL.revokeObjectURL;
});

describe("SheetViewer", () => {
  it("先用列表缩略图垫场，现算完成后换成施工图", async () => {
    await seedRecord();
    const wrapper = mount(SheetViewer, {
      props: { projectId: "p1", name: "测试工程", thumbnail: "data:image/png;base64,AAAA" },
    });
    expect(wrapper.get("[data-testid='sheet-preview']").attributes("src")).toBe("data:image/png;base64,AAAA");
    // 垫场期间：加载提示在、保存按钮**不可点**（还没有 blob 可存）。简报原文没有这两句——
    // 没有它们时，「加载提示被删掉」与「保存按钮恒可点」都不会有任何用例转红。
    expect(wrapper.find("[data-testid='sheet-loading']").exists()).toBe(true);
    expect((wrapper.get("[data-testid='sheet-save']").element as HTMLButtonElement).disabled).toBe(true);
    await flushPromises();
    expect(wrapper.get("[data-testid='sheet-preview']").attributes("src")).toBe("blob:test-1");
    // 简报原文这里是 `wrapper.get("[data-testid='sheet-loading']").exists()).toBe(false)`——**写错了**：
    // `get()` 在元素不存在时**抛错**（`Unable to get … within:`），所以那句话永远过不去
    // （实测：RED 转 GREEN 时它把唯一一条本已正确的实现打成红）。语意不变，只把 `get` 换成 `find`。
    expect(wrapper.find("[data-testid='sheet-loading']").exists()).toBe(false);
    expect((wrapper.get("[data-testid='sheet-save']").element as HTMLButtonElement).disabled).toBe(false);
    // 标题用 `.project-name`（工程名的统一口径，`style.css` 的第三处引用）
    const title = wrapper.get("[data-testid='sheet-title']");
    expect(title.classes()).toContain("project-name");
    expect(title.text()).toBe("测试工程 · 施工图");
  });

  it("保存经能力层落盘，文件名是「工程名-施工图.png」（不带分片序号）", async () => {
    await seedRecord();
    const wrapper = mount(SheetViewer, {
      props: { projectId: "p1", name: "小猫", thumbnail: "" },
    });
    await flushPromises();
    await wrapper.get("[data-testid='sheet-save']").trigger("click");
    await flushPromises();
    expect(albumSave).toHaveBeenCalledTimes(1);
    const [blob, filename] = albumSave.mock.calls[0] as [Blob, string];
    expect(blob.size).toBeGreaterThan(0);
    expect(filename).toBe("小猫-施工图.png");
    // **预览 URL 与落盘用的是同一颗 blob**（规格纪律：留住 blob 本体，不许 `fetch(objectUrl)` 再取
    // 一遍——那会白复制一份全分辨率位图）。这是本组件唯一一条「不复制」的机检。
    expect(createObjectUrl.mock.calls[0]?.[0]).toBe(blob);
    expect(wrapper.get("[data-testid='sheet-save-state']").text()).toBe("已保存到相册");
  });

  it("工程读不出来时显示原因，不留白屏", async () => {
    setProjectStore(await createMemoryProjectStore()); // 空库 ⇒ get() 返回 null
    const wrapper = mount(SheetViewer, { props: { projectId: "missing", name: "x", thumbnail: "" } });
    await flushPromises();
    expect(wrapper.get("[data-testid='sheet-error']").text()).toContain("找不到工程");
  });

  it("关闭 emit close；卸载时释放 object URL", async () => {
    await seedRecord();
    const wrapper = mount(SheetViewer, { props: { projectId: "p1", name: "测试工程", thumbnail: "" } });
    await flushPromises();
    await wrapper.get("[data-testid='sheet-close']").trigger("click");
    expect(wrapper.emitted("close")).toEqual([[]]);
    wrapper.unmount();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:test-1");
    // **恰好一次**（`URL.revokeObjectURL` 被调两次不会报错，但两次意味着有第二条销号路径）
    expect(revokeObjectUrl).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 以下四条**不是简报原文**，是自审时补的（理由逐条写在各自注释里）。共同点：简报的四条用例
  // 对它们所覆盖的那段代码**零判别力**——删掉对应的 catch / 分支 / 接线，四条用例照样全绿。
  // -------------------------------------------------------------------------

  it("现算的入参来自记录里的 doc：图纸 / 色卡 / 全图用量都按记录算", async () => {
    await seedRecord();
    mount(SheetViewer, { props: { projectId: "p1", name: "测试工程", thumbnail: "" } });
    await flushPromises();
    expect(renderSheetBlob).toHaveBeenCalledTimes(1);
    // 渲染通道是替身 ⇒ 「记录 → `fromProjectDocument` → `patternStats` → 入参」这条链在
    // 简报的四条用例里**一步都没被读到**（喂空图纸、喂错色卡、把 usages 写成 `[]` 都绿）。
    const input = renderSheetBlob.mock.calls[0]?.[0] as SheetRenderInput;
    expect(input.pattern.width).toBe(2);
    expect(input.pattern.height).toBe(1);
    expect(input.pattern.cells.length).toBe(2);
    expect(input.palette.id).toBe(palette.id);
    // `seedRecord` 的两格都是色卡第 0 色 ⇒ 全图用量恰好一行、2 颗
    expect(input.usages).toHaveLength(1);
    expect(input.usages[0]?.count).toBe(2);
    expect(input.projectName).toBe("测试工程");
  });

  it("现算失败时显示中文原因，不静默也不留白屏", async () => {
    await seedRecord();
    // 真实形态：旧工程超出当前上限时，渲染通道（`planSheet`）抛的就是这句
    renderSheetBlob.mockRejectedValueOnce(new Error("图纸宽度必须在 1–116 之间"));
    const wrapper = mount(SheetViewer, { props: { projectId: "p1", name: "测试工程", thumbnail: "" } });
    await flushPromises();
    expect(wrapper.get("[data-testid='sheet-error']").text()).toContain("图纸宽度必须在 1–116 之间");
    // 失败后不能还挂着「正在生成施工图…」（`finally` 里那句 `busy = false` 此前无人读）
    expect(wrapper.find("[data-testid='sheet-loading']").exists()).toBe(false);
    // 没有 blob ⇒ 保存按钮不可点（否则用户点一下、什么也没发生、也没有解释）
    expect((wrapper.get("[data-testid='sheet-save']").element as HTMLButtonElement).disabled).toBe(true);
  });

  it("保存失败时显示中文原因，不冒充「已保存到相册」", async () => {
    await seedRecord();
    albumSave.mockRejectedValueOnce(new Error("相册写入被拒绝"));
    const wrapper = mount(SheetViewer, { props: { projectId: "p1", name: "小猫", thumbnail: "" } });
    await flushPromises();
    await wrapper.get("[data-testid='sheet-save']").trigger("click");
    await flushPromises();
    const text = wrapper.get("[data-testid='sheet-save-state']").text();
    expect(text).toContain("保存失败：相册写入被拒绝");
    expect(text).not.toContain("已保存到相册");
    // 保存失败不是「工程读不出来」：不该同时亮那条红字（两件事的原因不同）
    expect(wrapper.find("[data-testid='sheet-error']").exists()).toBe(false);
  });

  it("成功文案按落点分叉：浏览器落点（download）说「已开始下载」，不冒充相册", async () => {
    await seedRecord();
    albumKind.value = "download";
    const wrapper = mount(SheetViewer, { props: { projectId: "p1", name: "小猫", thumbnail: "" } });
    await flushPromises();
    await wrapper.get("[data-testid='sheet-save']").trigger("click");
    await flushPromises();
    const text = wrapper.get("[data-testid='sheet-save-state']").text();
    expect(text).toBe("已开始下载");
    expect(text).not.toContain("已保存到相册");
  });

  it("保存进行中时按钮禁用，同一 tick 连点两次只落盘一次", async () => {
    await seedRecord();
    // 把第一次保存**挂在飞行中**：能力层替身返回一颗由用例控制何时 resolve 的 promise，
    // 这样「进行中」这个状态在用例里是**可观察、可停留**的（真实现里它只存在几毫秒）。
    let release: () => void = () => undefined;
    albumSave.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const wrapper = mount(SheetViewer, { props: { projectId: "p1", name: "小猫", thumbnail: "" } });
    await flushPromises();

    const button = wrapper.get("[data-testid='sheet-save']");
    // **两次派发之间不 await**：`trigger` 内部是「同步 `dispatchEvent` + 返回 `nextTick()`」，
    // 不等就派第二次时 DOM 上的 `disabled` 还没被渲染刷新，所以第二次点击**真的会进 handler**
    // ——这正是「防连点」必须写在 `save()` 里的原因（只靠 `:disabled` 挡不住同一 tick 的第二次）。
    await Promise.all([button.trigger("click"), button.trigger("click")]);

    expect(albumSave).toHaveBeenCalledTimes(1);
    // 飞行中：按钮禁用（否则用户以为没反应，会一直点）
    expect((button.element as HTMLButtonElement).disabled).toBe(true);

    release();
    await flushPromises();
    expect(albumSave).toHaveBeenCalledTimes(1);
    expect(wrapper.get("[data-testid='sheet-save-state']").text()).toBe("已保存到相册");
    // 落地后必须**放行**（卡死成永久禁用的话，失败一次就再也存不了）
    expect((button.element as HTMLButtonElement).disabled).toBe(false);
  });
});
