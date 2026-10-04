import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { loadPalette } from "@/core/palette/registry";
import type { Palette } from "@/core/palette/types";
import { patternStats, type ColorUsage } from "@/core/pattern/stats";
import { EMPTY, type Pattern } from "@/core/pattern/types";
import { getBuiltinPalette } from "@/services/palette";
import PalettePanel from "@/components/editor/PalettePanel.vue";

/** 真实内置色卡：面板与选择器共用同一个对象（services 侧是单例）。 */
const palette: Palette = getBuiltinPalette();

/** 带颜色名的夹具：真实 MARD221 的 `name` 全是空串，用真实色卡断言不出「名称」这一栏。 */
const NAMED: Palette = loadPalette({
  id: "panel-fixture",
  name: "夹具色卡",
  source: "https://example.com",
  accuracy: "仅测试用",
  colors: [
    { code: "B1", name: "草绿", hex: "#00ff00" },
    { code: "A1", name: "柠黄", hex: "#ffff00" },
    { code: "M1", name: "灰米", hex: "#cccccc" },
  ],
});

/** 色号 → 全色卡下标。查不到就直接让用例红（这个夹具本身是承重的）。 */
function indexOf(target: Palette, code: string): number {
  const index = target.colors.findIndex((color) => color.code === code);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

const usage = (code: string, count: number): ColorUsage => ({ code, name: "", count });

/**
 * 默认用量清单**故意让「usages 里的位置」与「全色卡下标」错开**：
 * M1 在色卡里是下标 206、在这里是位置 0；A1 在色卡里是下标 0、在这里是位置 1。
 * 任何「按下标直接搬」的实现在这份夹具上必红（`stats.ts` 的排序契约是「用量降序」，
 * 所以真实用法里这种错位是常态，不是人为构造）。
 */
const DEFAULT_USAGES: readonly ColorUsage[] = [usage("M1", 9), usage("A1", 2)];

function mountPanel(overrides: Record<string, unknown> = {}) {
  return mount(PalettePanel, {
    props: { palette, usages: DEFAULT_USAGES, currentColor: indexOf(palette, "A1"), ...overrides },
  });
}

describe("当前画笔槽（§9.1 第 1 条）", () => {
  it("显示当前色的色号与名称", () => {
    const wrapper = mountPanel({
      palette: NAMED,
      usages: [usage("A1", 3)],
      currentColor: indexOf(NAMED, "A1"),
    });
    const slot = wrapper.get("[data-testid='palette-current']").text();
    expect(slot).toContain("A1");
    expect(slot).toContain("柠黄");
  });

  // 橡皮态必须看得见：当前色是 EMPTY 时显示「不拼豆（橡皮）」（§9.1 第 1 条 + §6.3）。
  it("当前色是 EMPTY 时显示「不拼豆（橡皮）」", () => {
    const wrapper = mountPanel({ currentColor: EMPTY });
    expect(wrapper.get("[data-testid='palette-current']").text()).toContain("不拼豆（橡皮）");
  });

  // 【裁决 3 的直接后果，本任务最承重的一条】画笔色清单 = **当前图纸用到的色号**，
  // 于是「用「添加颜色」选中一个用了 0 颗的色」是常态——那时当前画笔槽必须还在，
  // 否则用户刚选完色，界面就把他选的色藏了，接着画下去只能靠记忆。
  it("当前色不在已用色列表里时当前画笔槽仍然渲染（裁决 3 的直接后果）", () => {
    const usages = [usage("M1", 9)];
    expect(usages.some((item) => item.code === "A1")).toBe(false); // 前提：A1 确实不在列表里

    const wrapper = mountPanel({ usages, currentColor: indexOf(palette, "A1") });
    expect(wrapper.findAll("[data-testid='palette-row']")).toHaveLength(1);
    expect(wrapper.get("[data-testid='palette-current']").text()).toContain("A1");
  });

  // 同一实例上把当前色涂光（§9.1「某个色被涂光的后果」）：那一行消失、当前槽仍在。
  // 分开挂载只能证明「依赖 usages」，证不出「对 usages 变化响应」——而「涂完最后一颗、
  // 列表少一行、当前槽还在」正是编辑过程中每几秒就会发生一次的路径。
  it("同一实例上把当前色涂光后：那一行消失，当前画笔槽仍在", async () => {
    const wrapper = mountPanel({ currentColor: indexOf(palette, "A1") });
    expect(wrapper.findAll("[data-testid='palette-row']")).toHaveLength(2);
    expect(wrapper.get("[data-testid='palette-current']").text()).toContain("A1");

    await wrapper.setProps({ usages: [usage("M1", 9)] });

    expect(wrapper.findAll("[data-testid='palette-row']")).toHaveLength(1);
    expect(wrapper.get("[data-testid='palette-current']").text()).toContain("A1");
  });
});

describe("已用色列表（§9.1 第 2 条）", () => {
  it("每一行显示色号与「N 颗」", () => {
    const rows = mountPanel().findAll("[data-testid='palette-row']");
    expect(rows).toHaveLength(2);
    expect(rows[0].text()).toContain("M1");
    expect(rows[0].text()).toContain("9 颗");
    expect(rows[1].text()).toContain("A1");
    expect(rows[1].text()).toContain("2 颗");
  });

  // 行序 = `usages` 自己的顺序（`stats.ts` 已经按用量降序排好），本层**不再排序**。
  // 默认清单里「M1 用量大排在前面」与「A1 色号小」是相反的，再排一次必红。
  it("行序 = usages 自己的顺序（本层不再排序）", () => {
    const rows = mountPanel().findAll("[data-testid='palette-row']");
    expect(rows.map((row) => row.attributes("data-code"))).toEqual(["M1", "A1"]);
  });

  // 点选 emit 的必须是**全色卡下标**（§9.2：`currentColor` 与 `Pattern.cells` 同一口径）。
  // A1 是「位置 1 / 下标 0」，M1 是「位置 0 / 下标 206」——两个方向都点一次，
  // 「emit usages 里的位置」与「emit 色号」两种错法都拿不到这两个数。
  it("点某一行 emit 的是全色卡下标（不是它在 usages 里的位置、也不是色号）", async () => {
    const wrapper = mountPanel();
    await wrapper.findAll("[data-testid='palette-row']")[1].trigger("click");
    expect(wrapper.emitted("update:currentColor")?.at(-1)).toEqual([0]);

    expect(indexOf(palette, "M1")).toBe(206);
    await wrapper.findAll("[data-testid='palette-row']")[0].trigger("click");
    expect(wrapper.emitted("update:currentColor")?.at(-1)).toEqual([206]);
  });

  // 当前色那行有高亮（§9.1 第 2 条）。同一实例上换一次当前色：高亮要跟着走。
  // 只挂载一次时，「高亮恒亮在第一行」这种写法在 currentColor=M1 那一组上恰好正确。
  it("当前色那一行有高亮，其余行没有（同一实例上换当前色）", async () => {
    const wrapper = mountPanel({ currentColor: indexOf(palette, "M1") });
    const marked = (): (string | undefined)[] =>
      wrapper.findAll("[data-testid='palette-row']").map((row) => row.attributes("data-current"));
    expect(marked()).toEqual(["1", undefined]);

    await wrapper.setProps({ currentColor: indexOf(palette, "A1") });
    expect(marked()).toEqual([undefined, "1"]);
  });
});

describe("橡皮与「添加颜色」（§9.1 第 3、4 条）", () => {
  // 橡皮 emit 的是 `EMPTY`（0xffff，图纸里「不拼豆」的唯一表示），不是 -1、不是 0——
  // 0 是合法色号（A1），emit 0 会让用户以为自己在用 A1 画画。
  it("点橡皮 emit EMPTY（不是 -1、不是 0）", async () => {
    const wrapper = mountPanel();
    await wrapper.get("[data-testid='palette-eraser']").trigger("click");
    expect(wrapper.emitted("update:currentColor")?.at(-1)).toEqual([EMPTY]);
    expect(EMPTY).toBe(0xffff); // 契约常量，逐字
  });

  it("「添加颜色」打开选择器；点关闭收起，且不改当前色", async () => {
    const wrapper = mountPanel();
    expect(wrapper.find("[data-testid='picker']").exists()).toBe(false);

    await wrapper.get("[data-testid='palette-add']").trigger("click");
    expect(wrapper.find("[data-testid='picker']").exists()).toBe(true);

    await wrapper.get("[data-testid='picker-close']").trigger("click");
    expect(wrapper.find("[data-testid='picker']").exists()).toBe(false);
    expect(wrapper.emitted("update:currentColor")).toBeUndefined();
  });

  // 「选中即设为当前色并关闭」（§9.1 第 3 条）。两件事必须一起断言：
  // 只断言 emit 时，「选完不关闭」会让选择器继续盖住面板；只断言关闭时，
  // 「关掉了但没设色」会让用户白点一次。
  it("在选择器里选中某色 → emit 该色的全色卡下标并自动收起选择器", async () => {
    const wrapper = mountPanel();
    await wrapper.get("[data-testid='palette-add']").trigger("click");

    // 选择器块与列表行都带 `data-code`，所以这里必须限定在 picker 之内。
    await wrapper.get("[data-testid='picker'] [data-code='M1']").trigger("click");

    expect(wrapper.emitted("update:currentColor")?.at(-1)).toEqual([206]);
    expect(wrapper.find("[data-testid='picker']").exists()).toBe(false);
  });
});

/**
 * 端到端：`patternStats` 的输出 → 面板 → 选择器里的已用色标记。
 *
 * 这是本任务唯一的跨组件接缝，也是本项目最贵的缺陷形态（「两端各自正确、错在接线」）：
 * `usages` 里只有 `code` / `name` / `count`，**没有下标**，而 `usedIndices` 要的是全色卡下标。
 * 中间那一步映射 `code → 全色卡下标` 一旦写成「按下标直接搬」，两端都各自正确、
 * 名单也看不出错——只有把真实的 `patternStats` 输出喂进真实的面板、再读选择器上的标记，
 * 才会暴露（那一格会被标成 A1 旁边的 A2）。
 */
describe("端到端：真实 patternStats 的用量 → 面板 → 选择器标记", () => {
  /** 4×2 的图纸：3 颗 M1（下标 206）+ 1 颗 A1（下标 0）+ 4 个空格。 */
  const pattern: Pattern = {
    width: 4,
    height: 2,
    paletteId: "mard221",
    cells: Uint16Array.from([206, 206, 206, 0, EMPTY, EMPTY, EMPTY, EMPTY]),
  };

  it("标记落在图纸真正用到的色号上，而不是 usages 的位置上", async () => {
    const stats = patternStats(pattern, palette);
    // `usages` 的既有排序契约：用量降序。于是第一条（M1，3 颗）的**位置是 0、
    // 色卡下标是 206**——「按位置当下标」在这里就已经错开了。
    expect(stats.usages.map((item) => [item.code, item.count])).toEqual([
      ["M1", 3],
      ["A1", 1],
    ]);

    const wrapper = mountPanel({ usages: stats.usages, currentColor: indexOf(palette, "M1") });

    // 列表侧：色号与颗数都来自端到端算出来的统计。
    const rows = wrapper.findAll("[data-testid='palette-row']");
    expect(rows).toHaveLength(2);
    expect(rows[0].text()).toContain("M1");
    expect(rows[0].text()).toContain("3 颗");
    expect(rows[1].text()).toContain("A1");
    expect(rows[1].text()).toContain("1 颗");
    expect(wrapper.get("[data-testid='palette-current']").text()).toContain("M1");

    // 选择器侧：被标记的正是那两颗。DOM 顺序是色卡顺序（A1 在下标 0、M1 在下标 206）。
    await wrapper.get("[data-testid='palette-add']").trigger("click");
    const marked = wrapper.findAll("[data-used='1']").map((block) => block.attributes("data-code"));
    expect(marked).toEqual(["A1", "M1"]);
    // A2 是下标 1：任何「按 usages 位置当下标」的实现都会把 A1 标成下标 0、把 A2 标成下标 1，
    // 并且漏标 M1。这一行是整个用例的判别核心。
    expect(wrapper.get("[data-code='A2']").attributes("data-used")).toBeUndefined();
  });
});

describe("非法输入", () => {
  // `patternStats` 对色卡外的下标会兜底成 `#N` 这种色号；渲染它没有可点的下标，
  // emit 一个凭空造的下标则是**静默涂错色**。口径与 `core/project/file.ts:139` 一致：响亮失败。
  // 注意：必须在**挂载时**就带上这条 props——@vue/test-utils 只把挂载期的渲染错误抛出来。
  it("usages 里有色卡里不存在的色号时响亮失败", () => {
    expect(() => mountPanel({ usages: [usage("#99", 4)] })).toThrow("色卡里找不到色号 #99");
  });
});
