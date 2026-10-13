import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { EMPTY } from "@/core/pattern/types";
import { loadPalette } from "@/core/palette/registry";
import type { Palette } from "@/core/palette/types";
import { getBuiltinPalette } from "@/services/palette";
import PalettePicker from "@/components/editor/PalettePicker.vue";

/** 真实内置色卡：221 色（A26 + B32 + C29 + D26 + E24 + F25 + G21 + H23 + M15）。 */
const palette: Palette = getBuiltinPalette();

/**
 * 乱序夹具：色号首字母的顺序是 **B → A → M**，既不是字母序、也不是 MARD 的九色系表。
 *
 * 为什么必须有它：真实 MARD221 的「首次出现顺序」**恰好等于**字母序（A–H、M），所以真实数据
 * 分不出「按数据分组」与「硬编码九色系表 + 按字母排序」——后者在真实数据上**全绿**。
 * 夹具还让「色卡下标」与「组内位置」错开（M1 是下标 2、组内位置 0），这是点选载荷判别的另一半。
 */
const SCRAMBLED: Palette = loadPalette({
  id: "picker-fixture",
  name: "乱序夹具色卡",
  source: "https://example.com",
  accuracy: "仅测试用",
  colors: [
    { code: "B1", hex: "#00ff00" },
    { code: "A1", hex: "#ffff00" },
    { code: "M1", hex: "#cccccc" },
  ],
});

function mountPicker(overrides: Record<string, unknown> = {}) {
  return mount(PalettePicker, {
    props: { palette, usedIndices: [], ...overrides },
  });
}

describe("分组", () => {
  // 一条断言同时钉住「数量」「顺序」「色号取自 `Palette.colors[i].code`」：漏渲染、重复渲染、
  // 顺序错、色号串位都会红。221 是回原始色卡重数的（不是引用任何汇总行）。
  it("真实色卡渲染 221 个色块，色号顺序与色卡逐一对齐", () => {
    const wrapper = mountPicker();
    const blocks = wrapper.findAll("[data-testid='picker-color']");
    expect(blocks).toHaveLength(221);
    expect(blocks.map((block) => block.attributes("data-code"))).toEqual(
      palette.colors.map((color) => color.code),
    );
  });

  it("真实色卡按色号首字母分成 A–H、M 九个分组，分组标题带色系字母", () => {
    const groups = mountPicker().findAll("[data-testid='picker-group']");
    expect(groups.map((group) => group.attributes("data-letter"))).toEqual([
      "A",
      "B",
      "C",
      "D",
      "E",
      "F",
      "G",
      "H",
      "M",
    ]);
    // CONTRACT §8 的逐字口径：分组节点文本含色系字母。只看 data-letter 时，
    // 「分组框在、但没告诉用户这是哪个色系」这种半成品照样绿。
    expect(groups[0].text()).toContain("A 色系");
    expect(groups[8].text()).toContain("M 色系");
  });

  // 每组色块数（回原始 JSON 重数）：A26 B32 C29 D26 E24 F25 G21 H23 M15。
  // 这条同时排掉「按色号前两位分组」「按色号整串分组」这类写法——它们的每组色数全是 1。
  it("每个分组的色块数与该色系的真实色数一致（26/32/29/26/24/25/21/23/15）", () => {
    const groups = mountPicker().findAll("[data-testid='picker-group']");
    expect(groups.map((group) => group.findAll("[data-testid='picker-color']").length)).toEqual([
      26, 32, 29, 26, 24, 25, 21, 23, 15,
    ]);
  });

  // 【本文件唯一能抓住硬编码九色系表的用例】真实数据下 A–H、M 与「按字母排序」完全一致，
  // 硬编码表 + 字母序在真实数据上全绿；乱序夹具把两种写法同时钉死。
  it("分组顺序取数据里首次出现的顺序：乱序夹具得到 B → A → M", () => {
    const groups = mountPicker({ palette: SCRAMBLED }).findAll("[data-testid='picker-group']");
    expect(groups).toHaveLength(3);
    expect(groups.map((group) => group.attributes("data-letter"))).toEqual(["B", "A", "M"]);
  });

  it("每个色块落在自己首字母的那个分组里", () => {
    const groups = mountPicker({ palette: SCRAMBLED }).findAll("[data-testid='picker-group']");
    const codesIn = (index: number): (string | undefined)[] =>
      groups[index].findAll("[data-testid='picker-color']").map((block) => block.attributes("data-code"));

    expect(codesIn(0)).toEqual(["B1"]);
    expect(codesIn(1)).toEqual(["A1"]);
    expect(codesIn(2)).toEqual(["M1"]);
  });
});

describe("选中", () => {
  // 「emit 的是数组下标而不是色号」这条变异就死在这里：M1 在夹具里是**下标 2 / 组内位置 0**，
  // emit 色号 "M1"、emit 组内位置 0、emit 它在 usages 里的位置都拿不到 2。
  it("点色块 emit 的是色卡下标（乱序夹具上点 M1 得到 2），且只 emit 一次", async () => {
    const wrapper = mountPicker({ palette: SCRAMBLED });
    await wrapper.get("[data-code='M1']").trigger("click");
    expect(wrapper.emitted("pick")).toHaveLength(1);
    expect(wrapper.emitted("pick")?.at(-1)).toEqual([2]);
  });

  // 真实色卡上再走一遍：206 = A26 + B32 + C29 + D26 + E24 + F25 + G21 + H23（回原始清单重数）。
  // 同时与 `palette` 自己的 findIndex 对齐——「夹具里的下标」与「色卡里的下标」是同一个口径，
  // 两边对不上说明有人在某一侧做了子集映射（B1 规格 §5.2 记的静默错位）。
  it("真实色卡上点 M1 emit 的是它在全色卡里的下标 206", async () => {
    const expected = palette.colors.findIndex((color) => color.code === "M1");
    expect(expected).toBe(206);

    const wrapper = mountPicker();
    await wrapper.get("[data-code='M1']").trigger("click");
    expect(wrapper.emitted("pick")?.at(-1)).toEqual([206]);
  });
});

describe("已用色标记", () => {
  // 标记必须按 `usedIndices` 的**值**命中：只断言「有标记」时，「把前 N 个色块都标上」
  // 或「全标上」都绿。这里同时断言命中项、未命中项与标记总数。
  it("已用色加标记、未用色不加，标记数 = usedIndices 的长度", () => {
    const wrapper = mountPicker({ palette: SCRAMBLED, usedIndices: [0, 2] });
    expect(wrapper.get("[data-code='B1']").attributes("data-used")).toBe("1");
    expect(wrapper.get("[data-code='M1']").attributes("data-used")).toBe("1");
    expect(wrapper.get("[data-code='A1']").attributes("data-used")).toBeUndefined();
    expect(wrapper.findAll("[data-used='1']")).toHaveLength(2);
  });

  it("usedIndices 为空数组时一个标记都没有", () => {
    const wrapper = mountPicker({ palette: SCRAMBLED, usedIndices: [] });
    expect(wrapper.findAll("[data-used='1']")).toHaveLength(0);
  });
});

describe("顶部「已用色」组", () => {
  it("按 usedIndices 的顺序列出色号，点一下 emit 该色的全色卡下标", async () => {
    const wrapper = mountPicker({ palette: SCRAMBLED, usedIndices: [2, 0] });
    const items = wrapper.findAll("[data-testid='picker-used']");
    expect(items.map((el) => el.attributes("data-used-code"))).toEqual(["M1", "B1"]); // 顺序 = usedIndices，不是色卡顺序
    await items[0].trigger("click");
    expect(wrapper.emitted("pick")?.at(-1)).toEqual([2]);
  });

  it("usedIndices 为空时这一组不渲染", () => {
    expect(mountPicker({ palette: SCRAMBLED, usedIndices: [] }).find("[data-testid='picker-used']").exists()).toBe(false);
  });

  it("[判别核心] 顶部组不占用色卡网格的 data-code / data-used 钩子", () => {
    const wrapper = mountPicker({ palette: SCRAMBLED, usedIndices: [0, 2] });
    expect(wrapper.findAll("[data-code='M1']")).toHaveLength(1); // 网格里那一个
    expect(wrapper.findAll("[data-used='1']")).toHaveLength(2);  // 既有的标记数口径不变
  });
});

describe("橡皮项（两种用途下都在）", () => {
  // 2026-10-13 起橡皮从工具栏搬进了这里（规格 §5.2），画笔与换色两种用途下都渲染。
  // 原来那个 `mode` prop 唯一的消费者就是这个 v-if——两模式行为一致后连同 prop 一起删掉了。
  it("渲染橡皮项，点它 emit EMPTY（空格）", async () => {
    const wrapper = mountPicker();
    expect(wrapper.find("[data-testid='picker-eraser']").exists()).toBe(true);
    await wrapper.get("[data-testid='picker-eraser']").trigger("click");
    expect(wrapper.emitted("pick")?.at(-1)).toEqual([EMPTY]);
  });
});

describe("色值与关闭", () => {
  // §9.2：色号 → 颜色的对应关系不许在本层重算，色块只读 `Palette.colors[i].rgb`。
  // 用 `data-rgb` 断言而不是查 `style`：happy-dom 对 CSS 的序列化是实现细节，
  // 而色值的来源是规格要求。夹具的两个色值不同，写死一个常量必红。
  it("色块的色值取自 Palette.colors[i].rgb（本层不重算色号 → 颜色）", () => {
    const wrapper = mountPicker({ palette: SCRAMBLED });
    expect(wrapper.get("[data-code='B1']").attributes("data-rgb")).toBe("0,255,0");
    expect(wrapper.get("[data-code='M1']").attributes("data-rgb")).toBe("204,204,204");
  });

  it("点关闭 emit 一次空载荷的 close，且不 emit pick", async () => {
    const wrapper = mountPicker({ palette: SCRAMBLED });
    await wrapper.get("[data-testid='picker-close']").trigger("click");
    expect(wrapper.emitted("close")).toEqual([[]]);
    expect(wrapper.emitted("pick")).toBeUndefined();
  });

  // 主规格 §6.5：触控目标硬下界 56px。**R35 授权改写**：原来是 44px / `text-base`，与 §6.5 的
  // 56×56 直接冲突，且 `text-base` 被 R22 禁用（Tailwind 默认字号类）。同一 matcher、同一节点，
  // 值改严：44→56px、16→24px。happy-dom 无布局，只能断言类名（同 PatternToolbar 的代理断言口径）。
  it("色块触控目标 ≥56px、字号 ≥24px", () => {
    const classes = mountPicker({ palette: SCRAMBLED })
      .get("[data-testid='picker-color']")
      .classes();
    expect(classes).toContain("min-h-14"); // 3.5rem = 56px
    expect(classes).toContain("min-w-14");
    expect(classes).toContain("text-[24px]"); // 1.5rem = 24px
  });

  // 【修复轮 1】§7.4：选择器是 3 列。平板右栏只有 250px（减卡片 4px 描边与 p-3 后 ≈ 218px 可用），
  // 6×56px + 5×4px gap ≈ 356px 会**重叠**；3 列（3×56 + 2×4 = 176px）才放得下。
  // 手机视口更窄、6 列同样放不下，但 250px 的 3 列在 360px 上又太浪费，故窄屏取 5 列。
  it("平板 3 列、手机 5 列，两个网格都是（§7.4）", () => {
    const wrapper = mountPicker({ palette: SCRAMBLED, usedIndices: [0, 2] });
    const grids = wrapper.findAll(".grid");
    expect(grids.length).toBeGreaterThan(0);
    for (const grid of grids) {
      expect(grid.classes()).toContain("grid-cols-5");
      expect(grid.classes()).toContain("md:grid-cols-3");
    }
  });

  // 【任务 14 新增】§7.4：选择器是像素覆盖层卡片（`bead-card` 底 + 4px `bead-ink` 描边 +
  // 零模糊大投影）。四条缺一不可：只断言背景时，「卡片没有描边/投影」照样绿。
  it("选择器是像素覆盖层卡片（bg-bead-card + border-4 border-bead-ink + shadow-pop-lg）", () => {
    const classes = mountPicker({ palette: SCRAMBLED }).get("[data-testid='picker']").classes();
    expect(classes).toContain("bg-bead-card");
    expect(classes).toContain("border-4");
    expect(classes).toContain("border-bead-ink");
    expect(classes).toContain("shadow-pop-lg");
  });
});
