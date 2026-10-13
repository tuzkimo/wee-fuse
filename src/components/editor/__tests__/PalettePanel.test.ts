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
    props: {
      palette,
      usages: DEFAULT_USAGES,
      currentColor: indexOf(palette, "A1"),
      selected: [],
      ...overrides,
    },
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

  // 橡皮态必须看得见：当前色是 EMPTY 时槽位文案是「橡皮」（§9.1 第 1 条 + §6.3）。
  // **C8 第 3 项改口径**：原来是「不拼豆（橡皮）」，现在就是「橡皮」——独立的橡皮按钮已经搬进
  // 工具栏（`PatternToolbar` 的 `eraser`），槽位不再兼任那个入口。
  it("当前色是 EMPTY 时槽位文案是「橡皮」", () => {
    const wrapper = mountPanel({ currentColor: EMPTY });
    expect(wrapper.get("[data-testid='palette-current']").text()).toBe("橡皮");
  });

  // 当前色槽同时是选择器的**唯一入口**（C8 第 3 项删掉了「添加颜色」那颗按钮）：
  // `aria-expanded` 是它对辅助技术的状态陈述，点第二下要收回去（`picking = !picking`）。
  // 同一实例上两个方向都走一遍——只断言「点一下会展开」时，绑成常量 `true` 也绿。
  it("当前色槽的 aria-expanded 跟随选择器的开合（同一实例两个方向）", async () => {
    const wrapper = mountPanel();
    const slot = wrapper.get("[data-testid='palette-current']");

    expect(slot.attributes("aria-expanded")).toBe("false");
    await slot.trigger("click");
    expect(slot.attributes("aria-expanded")).toBe("true");
    expect(wrapper.find("[data-testid='picker']").exists()).toBe(true);

    await slot.trigger("click");
    expect(slot.attributes("aria-expanded")).toBe("false");
    expect(wrapper.find("[data-testid='picker']").exists()).toBe(false);
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

  /**
   * 【C8 修复 ③a，真机截图】当前色槽**必须与一行色号带同宽**。
   *
   * **判死什么**：`<button>` 是 inline-block，`display: flex` 只让它成为 flex 容器、不会让它占满
   * 整行——少了 `w-full`，当前色槽就比下面的色号带窄一截（真机截图里就是这样）。所以这里**逐类**
   * 断言宽度类的每一项：只断言「色槽有 `w-full`」时，把色号带的 `w-full` 删掉（于是两边又不等宽）
   * 照样绿。
   *
   * **改写（任务 14，相位 II 规格）**：类名从默认调色板/默认字号（`min-h-11` 44px、`text-base`、
   * `rounded`）换成像素风 token（`min-h-14` 56px、`text-[12px]`、`rounded-bead-sm`）。判别核心
   * ——「两项必须带同一组宽度类（含 `w-full`）」——逐字保留；每一项都是**更严**或等价的值
   * （44→56px、16→12px 是 §7.4 逐字要求的色号字号，且 `text-base` 被 R22 禁用）。
   */
  it("当前色槽与一行色号带同一组宽度类（含 w-full）", () => {
    const wrapper = mountPanel();
    const slot = wrapper.get("[data-testid='palette-current']");
    const row = wrapper.findAll("[data-testid='palette-row']")[0];
    expect(row).toBeDefined();
    for (const className of ["w-full", "flex", "min-h-14", "items-center", "gap-2", "px-3", "text-[12px]", "rounded-bead-sm"]) {
      expect(slot.classes()).toContain(className);
      expect(row?.classes()).toContain(className);
    }
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

  // 点行 emit 的必须是**全色卡下标**（§9.2：`selected` 与 `currentColor` / `Pattern.cells` 同一口径）。
  // **改写（规格 §8，人类伙伴确认）**：新规格里点行是**切换选中**（§5.1），载荷从
  // `update:currentColor` 换到 `update:selected`；判别核心逐字保留——A1 是「位置 1 / 下标 0」，
  // M1 是「位置 0 / 下标 206」，两个方向都点一次，
  // 「emit usages 里的位置」与「emit 色号」两种错法都拿不到这两个数。
  it("点行 emit 的选中集合是全色卡下标（不是它在 usages 里的位置、也不是色号）", async () => {
    const wrapper = mountPanel();
    await wrapper.findAll("[data-testid='palette-row']")[1].trigger("click");
    expect(wrapper.emitted("update:selected")?.at(-1)).toEqual([[0]]);

    expect(indexOf(palette, "M1")).toBe(206);
    await wrapper.findAll("[data-testid='palette-row']")[0].trigger("click");
    expect(wrapper.emitted("update:selected")?.at(-1)).toEqual([[206]]);
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

  // **改写（规格 §8，人类伙伴确认）**：点行只该**切换选中**——不该改当前色，也不该把选择器掀开。
  // 后者是【修复轮 1，控制者裁决补】留下的反向不变式：在点行处理里顺手加一句 `picking = true`，
  // 全量用例曾经全绿。它是用户可见的分支（点一行色块，整块 221 色选择器盖上来），不是实现细节。
  //
  // 三件事一起断言、缺一不可：只断言「picker 不存在」时，把点行的 emit 一起删掉也绿；只断言 emit
  // 时，「顺手掀开选择器」或「顺手改当前色」都绿。
  it("点行只切换选中：不改当前色、不展开选择器", async () => {
    const wrapper = mountPanel();
    expect(wrapper.find("[data-testid='picker']").exists()).toBe(false);

    await wrapper.findAll("[data-testid='palette-row']")[0].trigger("click");

    expect(wrapper.emitted("update:selected")?.at(-1)).toEqual([[206]]); // M1 在位置 0 / 下标 206
    expect(wrapper.emitted("update:currentColor")).toBeUndefined();
    expect(wrapper.find("[data-testid='picker']").exists()).toBe(false);
  });
});

describe("当前色槽即入口（§9.1 第 3 条）", () => {
  // C8 第 3 项：入口从「添加颜色」那颗按钮换成**当前色槽本身**。
  // 断言拆成三件：它真的是按钮（`div` 点不动）、初始不展开、点一下展开。
  it("当前色槽是一颗按钮，点它展开选色（C8 第 3 项：删掉「添加颜色」入口）", async () => {
    const wrapper = mountPanel();
    const slot = wrapper.get("[data-testid='palette-current']");
    expect(slot.element.tagName).toBe("BUTTON");
    expect(wrapper.find("[data-testid='picker']").exists()).toBe(false);
    await slot.trigger("click");
    expect(wrapper.find("[data-testid='picker']").exists()).toBe(true);
  });

  /**
   * 【C8 修复 ③b，真机截图】选择器必须在 DOM 里**紧跟在当前色槽之后**。
   *
   * **判死什么**：它原先是 `<section>` 的最后一个子元素（排在色号列表之后），手机竖排下被整块色号带
   * 挤到**整页最底部**——用户点开当前色槽后还得滚很远才看得到选择器。只断言「picker 存在」时，
   * 它挪到哪里都绿；所以这里断言的是**兄弟顺序**：`palette-current` 的下一个元素就是 picker 本尊，
   * 并且色号带确实排在 picker **之后**（反向前提，缺了它「picker 挪回列表后面」也可能绿）。
   */
  it("选择器紧跟在当前色槽之后（下一个兄弟），不在色号列表下面", async () => {
    const wrapper = mountPanel();
    await wrapper.get("[data-testid='palette-current']").trigger("click");

    const slot = wrapper.get("[data-testid='palette-current']");
    const picker = wrapper.get("[data-testid='picker']");
    expect(slot.element.nextElementSibling).toBe(picker.element);

    const row = wrapper.get("[data-testid='palette-row']").element;
    const follows = picker.element.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING;
    expect(follows).toBeTruthy();
  });

  // 两颗按钮都不许留个壳：`palette-add` 的入口功能已并入当前色槽，
  // `palette-eraser` 搬到了工具栏（`PatternToolbar` 的 `eraser`）。
  it("没有「添加颜色」按钮，也没有橡皮按钮（橡皮搬到工具栏）", () => {
    const wrapper = mountPanel();
    expect(wrapper.find("[data-testid='palette-add']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='palette-eraser']").exists()).toBe(false);
  });

  it("点选择器的关闭：收起且不改当前色", async () => {
    const wrapper = mountPanel();
    expect(wrapper.find("[data-testid='picker']").exists()).toBe(false);

    await wrapper.get("[data-testid='palette-current']").trigger("click");
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
    await wrapper.get("[data-testid='palette-current']").trigger("click");

    // 选择器块与列表行都带 `data-code`，所以这里必须限定在 picker 之内。
    await wrapper.get("[data-testid='picker'] [data-code='M1']").trigger("click");

    expect(wrapper.emitted("update:currentColor")?.at(-1)).toEqual([206]);
    expect(wrapper.find("[data-testid='picker']").exists()).toBe(false);
  });
});

/**
 * 选中与操作条（§5.1–§5.4、§7 第 1 条）。
 *
 * 面板在这里第一次同时持两件 UI 状态：**选中集合**（父级 props 进 / 事件出）与
 * **选择器的用途**（`pickMode`，组件内）。两者各有一组反向守卫：用途被接成同一条路
 * （色槽也去换色 / `[换成…]` 也改画笔）时，判别用例必红。
 */
describe("选中与操作条", () => {
  it("已选中的行带 data-selected，未选中的不带", () => {
    const wrapper = mountPanel({ selected: [indexOf(palette, "M1")] });
    const rows = wrapper.findAll("[data-testid='palette-row']");
    expect(rows.map((row) => row.attributes("data-selected"))).toEqual(["1", undefined]);
    // 点行的语义是「切换选中」，读屏软件不认 `data-selected`。`aria-pressed` 必须**两个方向**
    // 都断言（同一实例）：只断言选中行是 `true` 时，绑成常量 `true` 也绿。
    expect(rows.map((row) => row.attributes("aria-pressed"))).toEqual(["true", "false"]);
  });

  // 【接受的偏差】`toggleRow` 从 props.selected 复制后增删，**从不按 usages 过滤**：选中期间被
  // 涂光、从 usages 消失的色号仍留在集合里（§5.5「选中的是该色号的所有格子」）。它只是不计数
  // （`selectedRows`），不是被悄悄抹掉。反向守卫：顺手 `filter` 成有效选中时，这条必红。
  it("切换选中时保留已从 usages 消失的色号", async () => {
    const wrapper = mountPanel({
      usages: [usage("M1", 9)],
      selected: [indexOf(palette, "M1"), indexOf(palette, "A1")],
    });
    await wrapper.findAll("[data-testid='palette-row']")[0].trigger("click");
    expect(wrapper.emitted("update:selected")?.at(-1)).toEqual([[indexOf(palette, "A1")]]);
  });

  it("再点一次取消选中（载荷里去掉它）", async () => {
    const selected = [indexOf(palette, "M1")];
    const wrapper = mountPanel({ selected });
    await wrapper.findAll("[data-testid='palette-row']")[0].trigger("click");
    expect(wrapper.emitted("update:selected")?.at(-1)).toEqual([[]]);
    // §6：集合**每次都是新数组、绝不原地改**。原地 `delete` / `push` 会把父级那份也改掉——
    // 那是「不报错、高亮就是不刷新」的同族缺陷，这里直接拿父级数组当判据。
    expect(selected).toEqual([206]);
  });

  it("没有有效选中时操作条不渲染", () => {
    // 两种都不渲染：空集合，以及「集合里那个色号面板上根本没在用」。
    expect(mountPanel({ selected: [] }).find("[data-testid='select-bar']").exists()).toBe(false);
    expect(
      mountPanel({ selected: [indexOf(palette, "A2")] })
        .find("[data-testid='select-bar']")
        .exists(),
    ).toBe(false);
  });

  // 【Review Focus 1】操作条按**有效选中**计数（§7 第 1 条）：选中期间某个色号被手动涂光，
  // 那一行从 `usages` 里消失、集合里还留着它。若按集合长度算，UI 就撒谎（说「已选 2 个」
  // 而实际只改 1 个）。A1（下标 0）就是那个已消失的色号。
  it("操作条按有效选中计数：选中集合里混着一个已从 usages 消失的色号", () => {
    const wrapper = mountPanel({
      usages: [usage("M1", 9)],
      selected: [indexOf(palette, "M1"), indexOf(palette, "A1")],
    });
    const bar = wrapper.get("[data-testid='select-bar']").text();
    expect(bar).toContain("已选 1 个色号");
    expect(bar).toContain("共 9 颗");
    expect(bar).not.toContain("2 个色号");
  });

  // 【Review Focus 2】全是已消失的色号 ⇒ 操作条不渲染，换色入口点不到（§7 第 1 条末句）。
  it("选中集合里全是已消失的色号 ⇒ 操作条不渲染（点不到换色）", () => {
    const wrapper = mountPanel({ usages: [usage("M1", 9)], selected: [indexOf(palette, "A1")] });
    expect(wrapper.find("[data-testid='select-bar']").exists()).toBe(false);
  });

  // 【任务 14 新增】§8 末尾：批量换色那套交互一字不改。三个锚点在一次真实点击之后必须都在 DOM 里。
  // 本组件是**受控**的（props 进 / 事件出）：点行只 emit 新集合，操作条要等父级写回 props 后才出现，
  // 所以这里显式走一遍父级的回路——这正是 §8 末尾那条「行为不变」的真实路径。
  it("多选换色的三个锚点仍在且行为不变（§8 末尾）", async () => {
    const wrapper = mountPanel();
    await wrapper.findAll("[data-testid='palette-row']")[0].trigger("click");
    const emitted = wrapper.emitted("update:selected")?.at(-1)?.[0] as readonly number[] | undefined;
    await wrapper.setProps({ selected: emitted });

    expect(wrapper.find("[data-testid='select-bar']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='select-bar-recolor']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='select-bar-clear']").exists()).toBe(true);
  });

  it("[取消选择] emit 空数组", async () => {
    const wrapper = mountPanel({ selected: [indexOf(palette, "M1")] });
    await wrapper.get("[data-testid='select-bar-clear']").trigger("click");
    expect(wrapper.emitted("update:selected")?.at(-1)).toEqual([[]]);
  });

  // 换色路径的判别核心：`sources` 是**有效选中**的全色卡下标，`to` 是刚点的那个下标。
  // A1 同时是「usages 位置 1 / 全色卡下标 0」，两个数都在断言里，按位置搬的写法拿不到。
  it("[换成…] 打开选择器且是换色模式（橡皮项在），点目标色 emit 有效源集合 + 目标值并收起", async () => {
    const wrapper = mountPanel({ selected: [indexOf(palette, "M1")] });
    await wrapper.get("[data-testid='select-bar-recolor']").trigger("click");
    expect(wrapper.find("[data-testid='picker']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='picker-eraser']").exists()).toBe(true);

    await wrapper.get("[data-testid='picker'] [data-code='A1']").trigger("click");
    expect(wrapper.emitted("recolor")?.at(-1)).toEqual([[206], 0]);
    expect(wrapper.find("[data-testid='picker']").exists()).toBe(false);
  });

  it("[换成…] 后点橡皮 ⇒ recolor 的目标是 EMPTY", async () => {
    const wrapper = mountPanel({ selected: [indexOf(palette, "M1")] });
    await wrapper.get("[data-testid='select-bar-recolor']").trigger("click");
    await wrapper.get("[data-testid='picker-eraser']").trigger("click");
    expect(wrapper.emitted("recolor")?.at(-1)).toEqual([[206], EMPTY]);
  });

  // 顶部「已用色」组与色卡网格**服从同一条规则**（§5.3）：换色模式下它交出的也是目标色，
  // 不是画笔色。反向守卫：这一组若写死成画笔色，这条必红。
  it("[换成…] 后点顶部已用色组 ⇒ 目标就是那个色号，不是 update:currentColor", async () => {
    const wrapper = mountPanel({ selected: [indexOf(palette, "A1")] });
    await wrapper.get("[data-testid='select-bar-recolor']").trigger("click");
    await wrapper.get("[data-testid='picker-used'][data-used-code='M1']").trigger("click");

    expect(wrapper.emitted("recolor")?.at(-1)).toEqual([[0], 206]);
    expect(wrapper.emitted("update:currentColor")).toBeUndefined();
  });

  // §5.3 第 4 条 + §5.4：色槽**永远**是「改画笔色」的入口——挂着选中时点它进的是画笔模式，
  // 挑完画笔色回来选中与操作条都还在。反向守卫：色槽被接成换色入口、或选完把选中清掉，这条必红。
  //
  // 2026-10-13：橡皮项不再是「换色模式」的判别标——它在两种用途下都渲染（规格 §5.2），
  // 所以本用例不再拿它当画笔模式的代理，改由下面那条专门的跨组件用例钉「拿到的是 EMPTY」。
  it("有选中时点当前色槽进的仍是画笔模式：点目标色只 emit update:currentColor，选中与操作条都保留", async () => {
    const wrapper = mountPanel({ selected: [indexOf(palette, "M1")] });
    await wrapper.get("[data-testid='palette-current']").trigger("click");

    await wrapper.get("[data-testid='picker'] [data-code='A1']").trigger("click");
    expect(wrapper.emitted("update:currentColor")?.at(-1)).toEqual([0]);
    expect(wrapper.emitted("recolor")).toBeUndefined();
    expect(wrapper.find("[data-testid='select-bar']").exists()).toBe(true);
  });

  // 入口搬家的跨组件判据（规格 §7）：编辑器不再有工具栏橡皮按钮，橡皮只能从选色区拿到。
  // 「面板渲染了橡皮项」与「页面收到 EMPTY」两件事分开才看得出来——接线断了只有这条会红。
  it("[入口搬家] 点当前色槽 → 点橡皮：交出的当前色是 EMPTY", async () => {
    const wrapper = mountPanel();
    await wrapper.get("[data-testid='palette-current']").trigger("click");
    expect(wrapper.find("[data-testid='picker-eraser']").exists()).toBe(true);

    await wrapper.get("[data-testid='picker-eraser']").trigger("click");
    expect(wrapper.emitted("update:currentColor")?.at(-1)).toEqual([EMPTY]);
    expect(wrapper.emitted("recolor")).toBeUndefined();
  });

  it("进入换色模式后点关闭：既不 emit recolor 也不 emit update:currentColor", async () => {
    const wrapper = mountPanel({ selected: [indexOf(palette, "M1")] });
    await wrapper.get("[data-testid='select-bar-recolor']").trigger("click");
    await wrapper.get("[data-testid='picker-close']").trigger("click");

    expect(wrapper.find("[data-testid='picker']").exists()).toBe(false);
    expect(wrapper.emitted("recolor")).toBeUndefined();
    expect(wrapper.emitted("update:currentColor")).toBeUndefined();
  });

  // 反向守卫：把两种用途接成同一条路（画笔模式也走 recolor）时这条必红。
  it("画笔模式（点当前色槽）下点目标色仍只 emit update:currentColor", async () => {
    const wrapper = mountPanel();
    await wrapper.get("[data-testid='palette-current']").trigger("click");
    await wrapper.get("[data-testid='picker'] [data-code='M1']").trigger("click");

    expect(wrapper.emitted("update:currentColor")?.at(-1)).toEqual([206]);
    expect(wrapper.emitted("recolor")).toBeUndefined();
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
    await wrapper.get("[data-testid='palette-current']").trigger("click");
    const marked = wrapper.findAll("[data-used='1']").map((block) => block.attributes("data-code"));
    expect(marked).toEqual(["A1", "M1"]);
    // A2 是下标 1：任何「按 usages 位置当下标」的实现都会把 A1 标成下标 0、把 A2 标成下标 1，
    // 并且漏标 M1。这一行是整个用例的判别核心。
    expect(wrapper.get("[data-code='A2']").attributes("data-used")).toBeUndefined();
  });
});

/**
 * §7.4：调色板在平板是右栏、在手机是底部横滑色豆条。
 *
 * **两套排法靠类分叉、不靠 `v-if`（R3）**：同一批 testid 在 DOM 里只出现一次（`get` 遇到重复会抛），
 * 两个断点的类因此都挂在同一个节点上——手机那一套是基础类，平板那一套是 `md:` 类。
 */
describe("两套排法（§7.4）", () => {
  it("手机端色豆条可横滑、色豆不小于 56px", () => {
    const wrapper = mountPanel();
    const strip = wrapper.get("[data-testid='palette-strip-mobile']");
    expect(strip.classes()).toContain("overflow-x-auto");
    expect(strip.get("[data-testid='palette-bead']").classes()).toContain("h-14");
  });

  it("平板右栏宽 250px（md:w-[250px]）", () => {
    expect(mountPanel().classes()).toContain("md:w-[250px]");
  });
});

/**
 * 像素风硬约束：R22（禁 Tailwind 默认字号类）与「只准用 `bead-*` token / `rounded-bead-*` /
 * `border-4`/`border-3` / `shadow-pop-*`」。默认调色板类（`slate-*`、`white`、`bg-slate-900`）、
 * 1px/2px 边框、默认字号与模糊投影都属于**会静默回潮**的一类：它们不影响任何行为断言，
 * 只让画面慢慢变回 Material 风。这里逐个元素按**整词**检查，`border-4` 与 `border` 是两个词，
 * 所以不会误伤 token 类。
 */
const FORBIDDEN_CLASSES = [
  "bg-white",
  "bg-slate-900",
  "text-white",
  "text-slate-500",
  "text-slate-700",
  "border-slate-200",
  "border-slate-300",
  "border",
  "border-2",
  "rounded",
  "text-xs",
  "text-sm",
  "text-base",
  "font-semibold",
  "shadow-sm",
  "shadow-md",
  "shadow-lg",
];

function expectNoDefaultPalette(wrapper: ReturnType<typeof mountPanel>): void {
  for (const element of wrapper.findAll("*")) {
    for (const banned of FORBIDDEN_CLASSES) {
      expect(element.classes()).not.toContain(banned);
    }
  }
}

describe("像素风约束（R22 + token 白名单）", () => {
  it("面板与展开的选择器都不带默认调色板 / 默认字号 / 1–2px 边框 / 模糊投影", async () => {
    const wrapper = mountPanel();
    expectNoDefaultPalette(wrapper);
    await wrapper.get("[data-testid='palette-current']").trigger("click");
    expectNoDefaultPalette(wrapper);
  });
});

describe("非法输入", () => {
  // `patternStats` 对色卡外的下标会兜底成 `#N` 这种色号；渲染它没有可点的下标，
  // emit 一个凭空造的下标则是**静默涂错色**。口径与 `core/project/file.ts:139` 一致：响亮失败。
  // 注意：必须在**挂载时**就带上这条 props——@vue/test-utils 只把挂载期的渲染错误抛出来。
  it("usages 里有色卡里不存在的色号时响亮失败", () => {
    expect(() => mountPanel({ usages: [usage("#99", 4)] })).toThrow("色卡里找不到色号 #99");
  });

  // 【修复轮 1，控制者裁决补】上一条的同源守卫，落在当前画笔值上：`currentColor` 越界
  // （`>= colors.length` 且 `!== EMPTY`）此前被静默显示成「橡皮」——画面上完全看不出错，
  // 用户以为自己在涂空格，而画笔实际握着色卡外的下标；一旦落笔，`core/pattern/edit.ts` 只守
  // `0..EMPTY`、不守色数上界，那个值就被**静默涂开**。谎报状态 + 静默涂错色，两条都踩了
  // 裁决 3 的口径（`core/project/file.ts`：查不到就响亮失败），故改为渲染期抛错。
  //
  // 999 是**色卡外但仍在 `Uint16` 值域内**的值：它同时也是「最容易顺手 `?? 0` 掉」的那种输入，
  // 且与 `EMPTY`（0xffff）不同——`EMPTY` 是「橡皮」这个合法状态的取值，必须继续放行
  // （「当前色是 EMPTY 时槽位文案是「橡皮」」那条钉着放行方向）。
  // 消息里带上**实际值**，否则「越界了、但越到哪去了」在日志里看不出来。
  it("currentColor 越界（色卡外且不是 EMPTY）时响亮失败，消息带实际值", () => {
    expect(() => mountPanel({ currentColor: 999 })).toThrow("999");
    expect(() => mountPanel({ currentColor: 999 })).toThrow("当前色号越界");
    // 裁决要求的**另一半**同样要断言：消息里必须有「色卡 … 只有 N 色」。缺了它，用户只看得到
    // 「越界了」而看不到越到哪、合法上界是多少；把 `色卡 … 只有 N 色` 整段删掉时，上面两条照样绿
    // （999 与「当前色号越界」都还在），所以这一句是那半段消息的唯一守卫。
    expect(() => mountPanel({ currentColor: 999 })).toThrow(
      `只有 ${String(palette.colors.length)} 色`,
    );
  });
});
