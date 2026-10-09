import { mount, flushPromises } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { toProjectDocument } from "@/core/project/file";
import { createMemoryProjectStore } from "@/services/memoryProjectStore";
import { getBuiltinPalette } from "@/services/palette";
import { setProjectStore } from "@/services/projectStore";
import { makeRecord } from "@/services/__tests__/projectStoreContract";
import LibraryPage from "@/views/LibraryPage.vue";

const push = vi.fn();
vi.mock("vue-router", () => ({
  useRouter: () => ({ push }),
  RouterLink: { template: "<a><slot /></a>" },
}));

/**
 * 渲染通道替身（B6 任务 14）：下面的「施工图」用例会挂上真的 `SheetViewer`，而它**真的**去
 * `renderSheetBlob`。不替的话 happy-dom 里会为它建一张真画布（`getContext("2d")` 返回 `null`
 * ⇒ 组件以「无法获取 2D 上下文」告警/失败），成为一条与列表页无关的假红。
 * 本文件只断言「点开就挂上查看层」；查看层内部行为由 `SheetViewer.test.ts` 覆盖。
 */
vi.mock("@/services/sheetExport", () => ({
  renderSheetBlob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
}));

/** `URL.createObjectURL` 的序号（见 `beforeEach` 里的桩：每次调用给一个**不同**的串）。 */
let createObjectUrlSeq = 0;

describe("LibraryPage", () => {
  beforeEach(async () => {
    push.mockClear();
    setActivePinia(createPinia());
    const store = await createMemoryProjectStore();
    await store.put(makeRecord("a", "小猫", "2026-10-03T01:00:00.000Z"));
    await store.put(makeRecord("b", "小狗", "2026-10-03T05:00:00.000Z"));
    setProjectStore(store);
    // object URL 桩：`SheetViewer` 会为现算出来的 blob 建 URL，而 happy-dom 下这两个方法可能
    // 不存在（手法同 `exportTestKit.stubObjectUrl`）。**按调用序号给不同的串**：下面「换工程要重挂」
    // 那条用例靠「src 从 `blob:sheet-1` 变成 `blob:sheet-2`」读「`onMounted` 又真的跑了一次」。
    createObjectUrlSeq = 0;
    URL.createObjectURL = vi.fn(
      () => `blob:sheet-${(createObjectUrlSeq += 1)}`,
    ) as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
  });

  it("列出全部工程，按 updatedAt 倒序", async () => {
    const wrapper = mount(LibraryPage);
    await flushPromises();
    const names = wrapper.findAll("[data-testid='project-name']").map((n) => n.text());
    expect(names).toEqual(["小狗", "小猫"]);
    // 有工程时不得出现空列表提示（`!hasProjects` 这一半原先没有任何断言在读：
    // 把 v-if 改成只看 storeUnavailable，简报原句照样全绿）
    expect(wrapper.find("[data-testid='empty-hint']").exists()).toBe(false);
  });

  it("每行显示豆数与用色数", async () => {
    const wrapper = mount(LibraryPage);
    await flushPromises();
    const first = wrapper.findAll("[data-testid='project-card']")[0];
    expect(first?.text()).toContain("2 × 1");
    expect(first?.text()).toContain("1");
    // 上面那句 `toContain("1")` 弱到被 "2 × 1" 自己就满足了——把用色数改坏它也绿。
    // 这里补上真正钉住「用色数」半句的断言（用色数 1 是 put 从 doc 派生的）。
    expect(first?.text()).toContain("· 1 种颜色");
  });

  it("空列表给出提示而不是一片空白", async () => {
    setProjectStore(await createMemoryProjectStore());
    const wrapper = mount(LibraryPage);
    await flushPromises();
    expect(wrapper.find("[data-testid='empty-hint']").exists()).toBe(true);
  });

  it("点「新建」跳到选图页", async () => {
    const wrapper = mount(LibraryPage);
    await flushPromises();
    await wrapper.find("[data-testid='new-project']").trigger("click");
    // B2：向导第一步由 B1 的临时生成页 `generate` 换成选图页 `pick`（断言语义不变，只换目标路由名）。
    expect(push).toHaveBeenCalledWith({ name: "pick" });
  });

  it("点卡片打开编辑器", async () => {
    const wrapper = mount(LibraryPage);
    await flushPromises();
    await wrapper.findAll("[data-testid='open-project']")[0]?.trigger("click");
    expect(push).toHaveBeenCalledWith({ name: "editor", params: { id: "b" } });
  });

  it("重命名后列表显示新名字", async () => {
    const wrapper = mount(LibraryPage);
    await flushPromises();
    await wrapper.findAll("[data-testid='rename-project']")[0]?.trigger("click");
    const input = wrapper.find("[data-testid='rename-input']");
    // 名称上限由输入框自己挡住（PROJECT_NAME_MAX = 100），不是等点「好」之后由 store 抛错。
    // 这里写**字面量 100**：若改成 `String(PROJECT_NAME_MAX)`，常量被改坏时两边一起变、断言恒绿。
    expect(input.attributes("maxlength")).toBe("100");
    await input.setValue("新名字");
    await wrapper.find("[data-testid='rename-confirm']").trigger("click");
    await flushPromises();
    // **本用例不依赖机器时钟**（控制者修订 R17）：`rename` 把 `updatedAt` 写成 `new Date()`，
    // 本机时钟（2026-10-02）**早于**夹具里的 2026-10-03，所以改名后的那条会排到「小猫」**后面**。
    // 简报原文的 `[0]?.text()` 会因此假红；这里改成与顺序无关的断言：列表里出现新名字、
    // 旧名字消失。（排序本身由上面「按 updatedAt 倒序」那条用例用显式注入的时间戳守住。）
    const names = wrapper.findAll("[data-testid='project-name']").map((n) => n.text());
    expect(names).toContain("新名字");
    expect(names).not.toContain("小狗");
  });

  it("删除必须二次确认，确认后该条消失", async () => {
    const wrapper = mount(LibraryPage);
    await flushPromises();
    await wrapper.findAll("[data-testid='delete-project']")[0]?.trigger("click");
    // 未确认前不能删
    expect(wrapper.findAll("[data-testid='project-card']")).toHaveLength(2);
    // 确认框里要出现工程名，防误删
    expect(wrapper.find("[data-testid='confirm-dialog']").text()).toContain("小狗");
    await wrapper.find("[data-testid='delete-confirm']").trigger("click");
    await flushPromises();
    const names = wrapper.findAll("[data-testid='project-name']").map((n) => n.text());
    expect(names).toEqual(["小猫"]);
  });

  it("取消删除后该条还在", async () => {
    const wrapper = mount(LibraryPage);
    await flushPromises();
    await wrapper.findAll("[data-testid='delete-project']")[0]?.trigger("click");
    await wrapper.find("[data-testid='delete-cancel']").trigger("click");
    await flushPromises();
    expect(wrapper.findAll("[data-testid='project-card']")).toHaveLength(2);
    // 「取消」必须真的关掉对话框：只断言卡片还在的话，把 `pendingDelete = null` 删掉也照样绿
    expect(wrapper.find("[data-testid='confirm-dialog']").exists()).toBe(false);
  });

  it("存储不可用时给出提示并禁用新建，不静默失败", async () => {
    setProjectStore(null);
    const wrapper = mount(LibraryPage);
    await flushPromises();
    expect(wrapper.find("[data-testid='store-unavailable']").exists()).toBe(true);
    expect(
      (wrapper.find("[data-testid='new-project']").element as HTMLButtonElement).disabled,
    ).toBe(true);
    // 红字提示已经把原因说清楚了：不能再叠一条琥珀错误条（`v-if="error && !storeUnavailable"`
    // 里的合取项原先没有任何断言在读）。`error` 此时就是「存储尚未初始化」那句话。
    expect(wrapper.text()).not.toContain("工程存储尚未初始化");
    expect(wrapper.find("[data-testid='error-hint']").exists()).toBe(false);
    // 也不该同时说「还没有图纸」（`!storeUnavailable` 的另一个合取项）
    expect(wrapper.find("[data-testid='empty-hint']").exists()).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 以下两条是**实现者自审时补的**（简报原文没有）。理由：简报的 9 条断言没有读过
  // `estimateUsage` 那条分支（内存实现恒返回 null，占用行永远不渲染），也没有读过
  // 「有 / 无封面」这一对分支——即两个从未被任何断言读过的输出。两条都与机器时钟无关。
  // -------------------------------------------------------------------------

  it("占用与配额：有数字时按 MB 显示，返回 null（浏览器不支持）时整行不出现", async () => {
    const base = await createMemoryProjectStore();
    await base.put(makeRecord("a", "小猫", "2026-10-03T01:00:00.000Z"));

    setProjectStore({
      ...base,
      estimateUsage: async () => ({ usage: 3 * 1024 * 1024, quota: 128 * 1024 * 1024 }),
    });
    const shown = mount(LibraryPage);
    await flushPromises();
    // 恰好 3 MiB / 128 MiB，页面按 MB 保留一位小数。数字互换或漏乘除都会红。
    expect(shown.text()).toContain("已用 3.0 MB / 可用约 128.0 MB");

    setProjectStore({ ...base, estimateUsage: async () => null });
    const hidden = mount(LibraryPage);
    await flushPromises();
    expect(hidden.text()).not.toContain("已用");
  });

  // -------------------------------------------------------------------------
  // `updatedAt` 相对时间（规格 B1 §7.1）。口径本身由 `src/views/__tests__/relativeTime.test.ts`
  // 逐档钉死（那组用例给的是**固定 `now`**，不看机器时钟）；这里只钉**接线**：
  // 卡片上真的有这一行、且读的是 `meta.updatedAt`。
  //
  // 模板里调用的是 `formatRelativeTime(meta.updatedAt, new Date())`，所以这两条的夹具刻意取
  // **相对当前时钟**的位置（30 天前 / 2030 年），而期望值要么是稳定的常量（「刚刚」），要么
  // 由夹具用**本地 getter** 现算——不硬编码日期串，也不假设本机时区。
  // -------------------------------------------------------------------------

  it("每张卡片显示 updatedAt 的相对时间（过去 → 日期串）", async () => {
    const store = await createMemoryProjectStore();
    // 30 天前（`setDate` 做本地日历日减法，跨月由 Date 自己进位）。刻意**不硬编码时间戳**：
    // 写死的时刻在偏移 ≤ −3:04 的机器上（美洲）本地日会差一天，那是会咬到真人开发机的假红
    // （本轮复审指出：旧版写死 `2020-01-02T03:04:05Z` → 期望 `"2020-01-02"`）。
    // 「30 天前」在 −12…+14 的任何偏移下都远在 7 天之外，必然落进日期串那一档。
    const old = new Date();
    old.setDate(old.getDate() - 30);
    await store.put(makeRecord("old", "老图纸", old.toISOString()));
    setProjectStore(store);

    const wrapper = mount(LibraryPage);
    await flushPromises();

    const line = wrapper.find("[data-testid='project-updated-at']");
    expect(line.exists()).toBe(true);
    // 期望值用**本地 getter** 现算（不硬编码某个时区的日期，也不调被测函数自比）：去掉模板里
    // 那一行、或把相对时间写死成「刚刚」，都会红。
    const expected = [
      old.getFullYear(),
      String(old.getMonth() + 1).padStart(2, "0"),
      String(old.getDate()).padStart(2, "0"),
    ].join("-");
    expect(line.text()).toBe(expected);
  });

  it("未来的 updatedAt 显示「刚刚」，不渲染负的时长（本机时钟早于夹具时最容易出的一支）", async () => {
    const store = await createMemoryProjectStore();
    await store.put(makeRecord("future", "未来图纸", "2030-01-01T00:00:00.000Z"));
    setProjectStore(store);

    const wrapper = mount(LibraryPage);
    await flushPromises();

    const line = wrapper.find("[data-testid='project-updated-at']");
    expect(line.text()).toBe("刚刚");
  });

  it("存储存在但读取失败时把原因显示出来，而不是留一片空白", async () => {
    // 「注入了存储」不等于「读得出来」：`getProjectStore()` 成功、`list()` 抛错（配额用尽 /
    // 隐私模式）是真实会发生的一支。没有这条断言时，去掉 refresh 里包住 list 的 try/catch
    // 不会有任何用例转红——页面只是静默空白。
    const base = await createMemoryProjectStore();
    setProjectStore({
      ...base,
      list: async () => {
        throw new Error("读库失败：配额用尽");
      },
    });
    const wrapper = mount(LibraryPage);
    await flushPromises();
    expect(wrapper.text()).toContain("读库失败：配额用尽");
    // 读失败时不能同时说「还没有图纸」——两句自相矛盾（原先 `!error` 这个合取项没人守）
    expect(wrapper.find("[data-testid='empty-hint']").exists()).toBe(false);
    // **装配性同步（B2 §8，唯一一处改到既有断言）**：B1 时这条分支只置一条琥珀错误条、
    // 且**不禁用新建**——正是 B1-7 记的实测教训（用户白走一遍选图 + 选区 + 生成，到 `put` 才炸）。
    // 现在它和「未注入」共用同一块红字并一起禁用新建（由本文件新增的 §8 两条用例钉住）。
    // 原先第三句断言的判别力是「存储是存在的，只是读失败：不该冒充『浏览器不支持本地保存』」，
    // 这里**不改判别力**，只把它从「这块红字不许出现」换成「这块红字里不许出现那句话」——
    // 因为「出现」现在是对的行为，而「冒充浏览器能力问题」仍然必须是错的。
    const notice = wrapper.get("[data-testid='store-unavailable']");
    expect(notice.text()).toContain("读库失败：配额用尽");
    expect(notice.text()).not.toContain("不允许本地保存");
    expect(
      (wrapper.get("[data-testid='new-project']").element as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("有封面时渲染缩略图，无封面时给占位文字（而不是一张空 img）", async () => {
    const withThumbnail = await createMemoryProjectStore();
    await withThumbnail.put(
      makeRecord("a", "小猫", "2026-10-03T01:00:00.000Z", {
        thumbnail: "data:image/png;base64,AA",
      }),
    );
    setProjectStore(withThumbnail);
    const first = mount(LibraryPage);
    await flushPromises();
    expect(first.find("[data-testid='project-card'] img").attributes("src")).toBe(
      "data:image/png;base64,AA",
    );

    const withoutThumbnail = await createMemoryProjectStore();
    await withoutThumbnail.put(makeRecord("b", "小狗", "2026-10-03T01:00:00.000Z"));
    setProjectStore(withoutThumbnail);
    const second = mount(LibraryPage);
    await flushPromises();
    expect(second.find("[data-testid='project-card'] img").exists()).toBe(false);
    expect(second.find("[data-testid='project-card']").text()).toContain("没有封面");
  });

  // -------------------------------------------------------------------------
  // 长工程名不撑宽页面（B6 任务 2）。**弱断言**：只挡「类名被删」，挡不住「CSS 写错」
  // （happy-dom 没有布局语义）——真布局判别力在规格 §15 的人工清单里。
  // 这里断言的是根因的**两处**：手机断点下 `ul` 缺显式列模板 ⇒ 隐式 `auto` 轨道按 max-content
  // 定尺；卡片 `li` 缺 `min-w-0` ⇒ 轨道里的卡片不肯收缩；名字用 `truncate`（`nowrap`）⇒ 只能
  // 裁自己、拦不住轨道被撑开。
  // -------------------------------------------------------------------------

  it("长工程名不撑宽卡片：名字用 .project-name，列表与卡片允许收缩", async () => {
    // 与 `beforeEach` 同一套写法（`createMemoryProjectStore` + `makeRecord`）：手搓的六方法桩
    // 会随 `ProjectStore` 增删成员而悄悄失同步，而这两个助手本来就在本文件里用着。
    const store = await createMemoryProjectStore();
    await store.put(
      makeRecord("p1", "IMG_20240101_1234567890_edited_edited_edited_final_version", "2026-10-08T00:00:00.000Z"),
    );
    setProjectStore(store);
    const wrapper = mount(LibraryPage);
    await flushPromises();

    const list = wrapper.get("[data-testid='project-list']");
    expect(list.classes()).toContain("grid-cols-1");
    const card = wrapper.get("[data-testid='project-card']");
    expect(card.classes()).toContain("min-w-0");
    const name = wrapper.get("[data-testid='project-name']");
    expect(name.classes()).toContain("project-name");
    // 旧的 truncate（nowrap）正是撑宽隐式 auto 轨道的根因，不许留
    expect(name.classes()).not.toContain("truncate");
  });

  // -------------------------------------------------------------------------
  // 首页「查看施工图」的接线（B6 任务 14）。只钉一件事：卡片上有这个按钮、点了会挂上查看层、
  // 关掉会摘掉。**查看层内部**（垫场、保存、失败文案、object URL 释放）由
  // `src/components/sheet/__tests__/SheetViewer.test.ts` 覆盖，这里不重复。
  // -------------------------------------------------------------------------

  it("卡片有「施工图」按钮，点开查看层", async () => {
    const store = await createMemoryProjectStore();
    await store.put({
      meta: {
        id: "p1", name: "小猫",
        createdAt: "2026-10-08T00:00:00.000Z", updatedAt: "2026-10-08T00:00:00.000Z",
        thumbnail: "", width: 58, height: 58, colorCount: 12,
      },
      doc: toProjectDocument(
        { width: 2, height: 1, paletteId: getBuiltinPalette().id, cells: new Uint16Array([0, 0]) },
        getBuiltinPalette(),
        { longSide: 58, maxColors: "all", crop: { x: 0, y: 0, w: 2, h: 1, rotate: 0 } },
      ),
      source: null,
    });
    setProjectStore(store);
    const wrapper = mount(LibraryPage);
    await flushPromises();

    expect(wrapper.find("[data-testid='sheet-viewer']").exists()).toBe(false);
    await wrapper.get("[data-testid='view-sheet']").trigger("click");
    // 简报原文这里是 `wrapper.get(...).exists()).toBe(true)`——**编译不过**：`get()` 的返回类型是
    // `Omit<DOMWrapper, "exists">`（它保证找得到，故刻意不给 `exists`），`vue-tsc` 报 TS2339。
    // 语意不变，只把 `get` 换成 `find`。
    expect(wrapper.find("[data-testid='sheet-viewer']").exists()).toBe(true);

    // 「关闭」必须真的摘掉查看层（只断言「开得出来」时，把 `@close` 那根线删掉照样绿）。
    await flushPromises();
    await wrapper.get("[data-testid='sheet-close']").trigger("click");
    expect(wrapper.find("[data-testid='sheet-viewer']").exists()).toBe(false);
  });

  it("查看层开着时点另一条工程的「施工图」，查看层按新工程**重新挂载**（`:key` 焊住的不变量）", async () => {
    // 两个工程都用**内置色卡**造 doc：`SheetViewer` 用 `getBuiltinPalette()` 解析记录，
    // 而 `makeRecord` 那份 "fake" 色卡的 doc 会被 `fromProjectDocument` 拒绝（色卡 id 不一致）。
    const store = await createMemoryProjectStore();
    for (const [id, name, updatedAt] of [
      ["p1", "小猫", "2026-10-08T05:00:00.000Z"],
      ["p2", "小狗", "2026-10-08T01:00:00.000Z"],
    ] as const) {
      await store.put({
        meta: {
          id, name,
          createdAt: "2026-10-08T00:00:00.000Z", updatedAt,
          thumbnail: "", width: 58, height: 58, colorCount: 12,
        },
        doc: toProjectDocument(
          { width: 2, height: 1, paletteId: getBuiltinPalette().id, cells: new Uint16Array([0, 0]) },
          getBuiltinPalette(),
          { longSide: 58, maxColors: "all", crop: { x: 0, y: 0, w: 2, h: 1, rotate: 0 } },
        ),
        source: null,
      });
    }
    setProjectStore(store);
    const wrapper = mount(LibraryPage);
    await flushPromises();

    // 列表按 updatedAt 倒序 ⇒ [0] 是「小猫」（05:00），[1] 是「小狗」（01:00）
    const buttons = wrapper.findAll("[data-testid='view-sheet']");
    await buttons[0]?.trigger("click");
    await flushPromises();
    expect(wrapper.get("[data-testid='sheet-title']").text()).toBe("小猫 · 施工图");
    expect(wrapper.get("[data-testid='sheet-preview']").attributes("src")).toBe("blob:sheet-1");

    // 查看层是 `fixed inset-0`，视觉上盖住了列表，但事件仍可派发——这正是「今天不可达、明天多一个
    // 入口就漏」的那条缝：没有 `:key` 时 Vue 复用同一实例、`onMounted` 不再跑，屏幕上会**留着上一条
    // 工程的施工图**（预览还是 `blob:sheet-1`）。
    await buttons[1]?.trigger("click");
    await flushPromises();
    expect(wrapper.get("[data-testid='sheet-title']").text()).toBe("小狗 · 施工图");
    expect(wrapper.get("[data-testid='sheet-preview']").attributes("src")).toBe("blob:sheet-2");
  });
});

describe("存储失败的两种语义（B2 规格 §8）", () => {
  it("未注入存储：给出「不允许本地保存」并禁用新建", async () => {
    setProjectStore(null);
    const wrapper = mount(LibraryPage);
    await flushPromises();

    expect(wrapper.get("[data-testid='store-unavailable']").text()).toContain("不允许本地保存");
    expect(wrapper.get("[data-testid='new-project']").attributes("disabled")).toBeDefined();
  });

  it("库打不开（list 抛错）：显示原因并**禁用新建**——否则用户会白走一遍选图与生成", async () => {
    setProjectStore({
      list: async () => {
        throw new Error("库打不开");
      },
      get: async () => null,
      put: async () => {},
      remove: async () => {},
      rename: async () => {
        throw new Error("unused");
      },
      estimateUsage: async () => null,
    });

    const wrapper = mount(LibraryPage);
    await flushPromises();

    expect(wrapper.get("[data-testid='store-unavailable']").text()).toContain("库打不开");
    expect(wrapper.get("[data-testid='new-project']").attributes("disabled")).toBeDefined();
  });

  // 这条正是 B1-17：只有占用读不出来时，列表与新建都必须照常。
  it("只有 estimateUsage 失败：列表正常、占用行消失、新建**不**禁用", async () => {
    const store = await createMemoryProjectStore();
    // `updatedAt` 是 `makeRecord` 的**必填**第三参（简报原文只传了两个；`npm run build` 的
    // vue-tsc 会按 `src/**/*.ts` 类型检查测试文件，漏参直接编译不过）。
    await store.put(makeRecord("p1", "小猫", "2026-10-03T01:00:00.000Z"));
    setProjectStore({
      ...store,
      // 逐个 `bind` 再展开，而不是只写 `...store`：`store` 将来若换成 class 实现，原型上的方法
      // 不会出现在展开里，这几行能让桩仍然是一个完整的 `ProjectStore`。
      list: store.list.bind(store),
      get: store.get.bind(store),
      put: store.put.bind(store),
      remove: store.remove.bind(store),
      rename: store.rename.bind(store),
      estimateUsage: async () => {
        throw new Error("读不到占用");
      },
    });

    const wrapper = mount(LibraryPage);
    await flushPromises();

    expect(wrapper.findAll("[data-testid='project-card']")).toHaveLength(1);
    expect(wrapper.text()).not.toContain("已用");
    expect(wrapper.get("[data-testid='new-project']").attributes("disabled")).toBeUndefined();
    // 简报原文没有这一句——实测：**不加它，这条用例在旧实现上照样全绿**（跑 RED 时亲眼见到
    // 16 passed / 1 failed）。旧代码里 `estimateUsage` 抛错走的是共享 try 的 catch，只置了一条
    // 琥珀错误条，列表与新建本来就没被拖累，所以上面三句都读不到 B1-17。B1-17 的原话正是
    // 「只 `estimateUsage` 失败**也会置错误条**」，故必须把「不置错误条」也断言上。
    expect(wrapper.find("[data-testid='error-hint']").exists()).toBe(false);
  });

  it("失败态不是粘死的：库坏掉再恢复，红字与「新建禁用」都要跟着撤销", async () => {
    // 这条不是简报原文。理由（变异实测）：`refresh()` 开头那句 `storeFailure.value = null`
    // 原先**没有任何断言在读**——把它删掉，当时本文件 17 条用例全绿（M5）。可它是承重的：库先失败、
    // 后恢复时不清失败态，红字与「新建禁用」会永久粘在页面上，哪怕库已经好了。
    // 触发 refresh 的活口只有卡片上的改名 / 删除，所以这里用「删除」把 refresh 再走两次。
    const base = await createMemoryProjectStore();
    await base.put(makeRecord("a", "小猫", "2026-10-03T01:00:00.000Z"));
    let broken = false;
    setProjectStore({
      ...base,
      list: async () => {
        if (broken) throw new Error("库打不开");
        return base.list();
      },
    });

    const wrapper = mount(LibraryPage);
    await flushPromises();
    expect(wrapper.findAll("[data-testid='project-card']")).toHaveLength(1);

    // 库坏掉：下一次 refresh（点「删除」→ 确认）才会看到。列表是**上一次成功**的那份，
    // 所以卡片还在（refresh 失败时不清空列表），用户仍有活口。
    broken = true;
    await wrapper.find("[data-testid='delete-project']").trigger("click");
    await wrapper.find("[data-testid='delete-confirm']").trigger("click");
    await flushPromises();
    expect(wrapper.get("[data-testid='store-unavailable']").text()).toContain("库打不开");
    expect(wrapper.get("[data-testid='new-project']").attributes("disabled")).toBeDefined();

    // 库恢复：再走一次 refresh，失败态必须撤销，页面回到正常（列表空 → 空提示）。
    broken = false;
    await wrapper.find("[data-testid='delete-project']").trigger("click");
    await wrapper.find("[data-testid='delete-confirm']").trigger("click");
    await flushPromises();
    expect(wrapper.find("[data-testid='store-unavailable']").exists()).toBe(false);
    expect(wrapper.get("[data-testid='new-project']").attributes("disabled")).toBeUndefined();
    expect(wrapper.find("[data-testid='empty-hint']").exists()).toBe(true);
  });

  it("占用读不到时，原先显示的那一行要撤掉（§8 说的是「占用行消失」，不是「从没显示过」）", async () => {
    // 这条不是简报原文。简报那条「只有 estimateUsage 失败」里的 `not.toContain("已用")` 是在
    // **占用从未显示过**的前提下成立的，读不到 ③ 的 `usage.value = null`——实测把它删掉，
    // 当时本文件 18 条全绿（M6）。可它的作用是清掉**上一次成功读到的旧数字**：不清就是一行过期的
    // 占用 / 配额挂在页面上，用户不会知道那是旧的。
    const base = await createMemoryProjectStore();
    await base.put(makeRecord("a", "小猫", "2026-10-03T01:00:00.000Z"));
    let usageBroken = false;
    setProjectStore({
      ...base,
      estimateUsage: async () => {
        if (usageBroken) throw new Error("读不到占用");
        return { usage: 1024 * 1024, quota: 2 * 1024 * 1024 };
      },
    });

    const wrapper = mount(LibraryPage);
    await flushPromises();
    expect(wrapper.text()).toContain("已用 1.0 MB / 可用约 2.0 MB");

    // 让占用开始读不出来，再走一次 refresh（删除本身是成功的，卡住的是占用那一步）。
    usageBroken = true;
    await wrapper.find("[data-testid='delete-project']").trigger("click");
    await wrapper.find("[data-testid='delete-confirm']").trigger("click");
    await flushPromises();

    expect(wrapper.text()).not.toContain("已用");
    // 列表该刷的照刷（那一条确实被删了），且不置错误条——占用读不到只是少一行字。
    expect(wrapper.findAll("[data-testid='project-card']")).toHaveLength(0);
    expect(wrapper.find("[data-testid='error-hint']").exists()).toBe(false);
  });
});
