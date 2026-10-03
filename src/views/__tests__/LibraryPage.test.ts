import { mount, flushPromises } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createMemoryProjectStore } from "@/services/memoryProjectStore";
import { setProjectStore } from "@/services/projectStore";
import { makeRecord } from "@/services/__tests__/projectStoreContract";
import LibraryPage from "@/views/LibraryPage.vue";

const push = vi.fn();
vi.mock("vue-router", () => ({
  useRouter: () => ({ push }),
  RouterLink: { template: "<a><slot /></a>" },
}));

describe("LibraryPage", () => {
  beforeEach(async () => {
    push.mockClear();
    setActivePinia(createPinia());
    const store = await createMemoryProjectStore();
    await store.put(makeRecord("a", "小猫", "2026-10-03T01:00:00.000Z"));
    await store.put(makeRecord("b", "小狗", "2026-10-03T05:00:00.000Z"));
    setProjectStore(store);
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

  it("点「新建」跳到生成页", async () => {
    const wrapper = mount(LibraryPage);
    await flushPromises();
    await wrapper.find("[data-testid='new-project']").trigger("click");
    expect(push).toHaveBeenCalledWith({ name: "generate" });
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
    // 存储是存在的，只是读失败：不该冒充「浏览器不支持本地保存」
    expect(wrapper.find("[data-testid='store-unavailable']").exists()).toBe(false);
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
});
