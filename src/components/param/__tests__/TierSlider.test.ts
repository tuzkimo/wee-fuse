import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import TierSlider from "@/components/param/TierSlider.vue";

/**
 * 档位滑动条 + 数字输入框（C8 第 4 项）。
 *
 * 它替换掉了 C7 的两组「按钮组」：长边三个预设按钮、用色五个档位按钮。滑条是**原生**
 * `<input type="range">`（不引第三方库），档位节点由调用方以 `nodes` 给出——本组件不知道
 * 「长边」或「用色数」是什么，因此这两条业务语义留在 `ParamPanel` 的用例里。
 *
 * 组件是**纯展示**：props 进、`input` 事件出（`{ value, error }`），不读 store。
 *
 * **2026-10-10 起两处变化**（档位口径简化的 UI 面）：
 * ① 新增**必填** prop `labels: "track" | "below"`（不给默认值，两处调用都显式写）；
 * ② 从滑条来的值会对**靠近的档位节点**吸附，阈值 `max(1, round((max − min) × 0.02))`；
 *    数字输入框**不吸附**（用户填多少就是多少）。
 */
function mountSlider(overrides: Record<string, unknown> = {}) {
  return mount(TierSlider, {
    props: {
      label: "长边豆数",
      min: 1,
      max: 116,
      value: 58,
      nodes: [
        { value: 29, label: "29" },
        { value: 58, label: "58" },
        { value: 116, label: "116" },
      ],
      inputTestId: "long-side",
      sliderTestId: "long-side-slider",
      /** 长边那条：节点间距 24% / 50% / 100%，数字画在轨道上不会重叠。 */
      labels: "track",
      ...overrides,
    },
  });
}

/**
 * 用色那条的夹具形状：`min 1 / max 221`、节点 8 / 16 / 24。
 *
 * 吸附阈值 = `max(1, round((221 − 1) × 0.02))` = **4**——与 `ParamPanel` 的真实调用同形。
 */
function mountColorSlider(overrides: Record<string, unknown> = {}) {
  return mountSlider({
    label: "用几种颜色",
    min: 1,
    max: 221,
    value: 16,
    nodes: [
      { value: 8, label: "8" },
      { value: 16, label: "16" },
      { value: 24, label: "24" },
    ],
    inputTestId: "max-colors",
    sliderTestId: "max-colors-slider",
    labels: "below",
    ...overrides,
  });
}

describe("TierSlider（C8 第 4 项）", () => {
  it("滑条与数字输入框都在，且输入框的回显是当前值", () => {
    const wrapper = mountSlider();
    expect(wrapper.get("[data-testid='long-side-slider']").attributes("type")).toBe("range");
    const input = wrapper.get("[data-testid='long-side']");
    expect(input.attributes("type")).toBe("number");
    expect((input.element as HTMLInputElement).value).toBe("58");
  });

  it("每个节点都画出了标签（档位用滑条上的节点表示）", () => {
    const wrapper = mountSlider();
    const marks = wrapper.findAll("[data-node]").map((mark) => mark.text());
    expect(marks).toEqual(["29", "58", "116"]);
  });

  it("拖滑条 ⇒ emit 合法值与空错误", async () => {
    const wrapper = mountSlider();
    await wrapper.get("[data-testid='long-side-slider']").setValue("100");
    expect(wrapper.emitted("input")).toEqual([[{ value: 100, error: "" }]]);
  });

  it("输入框填非法值 ⇒ emit value: null + 中文原因（父级据此禁用生成）", async () => {
    const wrapper = mountSlider();
    await wrapper.get("[data-testid='long-side']").setValue("1.5");
    expect(wrapper.emitted("input")?.at(-1)).toEqual([{ value: null, error: "要填 1–116 之间的整数" }]);
    await wrapper.get("[data-testid='long-side']").setValue("");
    expect(wrapper.emitted("input")?.at(-1)).toEqual([{ value: null, error: "要填 1–116 之间的整数" }]);
  });

  it("父级改值 ⇒ 输入框回显跟着走（只有一个写入者）", async () => {
    const wrapper = mountSlider();
    await wrapper.setProps({ value: 29 });
    expect((wrapper.get("[data-testid='long-side']").element as HTMLInputElement).value).toBe("29");
  });

  /**
   * 边界值必须**被接受**：把 `value >= props.min` 写成 `>`（或 `<= props.max` 写成 `<`）时，
   * 上面四条（打的都是区间内部的值与区间外的值）全都照绿——端点被拒是功能缺失。
   * 上下界取 slider 自己的 `max`（116）：`1` / `116` 分别是最小值与最大值。
   */
  it.each([1, 116])("边界值 %i 被接受（emit 合法值、无错误）", async (value) => {
    const wrapper = mountSlider();
    await wrapper.get("[data-testid='long-side']").setValue(String(value));
    expect(wrapper.emitted("input")?.at(-1)).toEqual([{ value, error: "" }]);
  });

  /**
   * 滑条本身的值也要随父级走（`value` → `:value`）：只绑输入框的话，父级回灌后
   * 数字变了、滑条拇指还停在旧位置，用户看到两个互相矛盾的读数。
   */
  it("父级改值时滑条本身的 value 也跟着走", async () => {
    const wrapper = mountSlider();
    expect(wrapper.get("[data-testid='long-side-slider']").attributes("value")).toBe("58");
    await wrapper.setProps({ value: 116 });
    expect(wrapper.get("[data-testid='long-side-slider']").attributes("value")).toBe("116");
  });

  /** 节点位置按 `(value - min) / (max - min)` 算：写死百分比时这条会红。 */
  it("节点按取值落在轨道上的比例定位（29 / 58 / 116 在 1–116 上）", () => {
    const wrapper = mountSlider();
    const lefts = wrapper.findAll("[data-node]").map((mark) => {
      const match = /([\d.]+)%/.exec(mark.attributes("style") ?? "");
      return match?.[1] === undefined ? Number.NaN : Number(match[1]);
    });
    // 期望值现算：`(value - min) / (max - min)` 就是节点的口径，写死一个百分比数字反而是自证。
    const at = (value: number): number => ((value - 1) / (116 - 1)) * 100;
    expect(lefts[0]).toBeCloseTo(at(29), 6);
    expect(lefts[1]).toBeCloseTo(at(58), 6);
    expect(lefts[2]).toBeCloseTo(at(116), 6);
    expect(lefts[2]).toBe(100);
  });

  /**
   * 触控目标（规格 §6.5 / 本任务约束 R35：最小 56×56，44px 是 Material 的口径）。
   *
   * happy-dom 没有布局，`getBoundingClientRect` 恒 0——与仓里既有那批用例同一条纪律：
   * 「≥56px」**唯一可观察的形式就是类名**（`h-14` = 3.5rem = 56px），所以这里钉类名。
   * 旋钮的视觉尺寸（一个 34px 的圆）由伪元素定，手感仍由浏览器给的原生滑条承担。
   */
  it("触控目标：轨道 h-14（56px）、数字输入框 min-h-14（56px）", () => {
    const wrapper = mountSlider();
    // R35：`h-11`（44px）→ `h-14`（56px）。同一节点、同一个 `toContain` 匹配器，值更严。
    expect(wrapper.get("[data-testid='long-side-slider']").classes()).toContain("h-14");
    // R46：数字输入框原为 `min-h-12`（48px）——48 是 Material 口径，§6.5 的硬下界也是 56。
    expect(wrapper.get("[data-testid='long-side']").classes()).toContain("min-h-14");
    expect(wrapper.get("[data-testid='long-side']").classes()).not.toContain("min-h-12");
  });
});

/**
 * 吸附（2026-10-10 新增）：「滑动靠近时自动吸附到对应档位数量」。
 *
 * 阈值 `max(1, round((max − min) × 0.02))`：长边那条（1–116）是 **2**、用色那条（1–221）是 **4**。
 * 两条滑条同一条公式，手感一致。
 *
 * 判据刻意取**两侧都读**：只断言「9 ⇒ 8」时，把所有值都吸到下界也能全绿；所以每个阈值都配一条
 * 「离节点足够远 ⇒ 原样 emit」。
 */
describe("TierSlider 吸附（滑动靠近档位就取值，远离则原样）", () => {
  it.each([
    ["30", 29],
    ["60", 58],
    ["57", 58],
    ["115", 116],
  ] as const)("长边滑条拖到 %s ⇒ emit 档位值 %i（阈值 2）", async (raw, expected) => {
    const wrapper = mountSlider();
    await wrapper.get("[data-testid='long-side-slider']").setValue(raw);
    expect(wrapper.emitted("input")?.at(-1)).toEqual([{ value: expected, error: "" }]);
  });

  it("长边滑条拖到远离任何节点的 45 ⇒ 原样 emit 45（吸附不是把所有值都吸到最近节点）", async () => {
    const wrapper = mountSlider();
    await wrapper.get("[data-testid='long-side-slider']").setValue("45");
    expect(wrapper.emitted("input")?.at(-1)).toEqual([{ value: 45, error: "" }]);
  });

  it.each([
    ["9", 8],
    ["17", 16],
    ["25", 24],
    ["20", 16],
    ["4", 8],
  ] as const)("用色滑条拖到 %s ⇒ emit 档位值 %i（阈值 4，含阈值边界）", async (raw, expected) => {
    const wrapper = mountColorSlider();
    await wrapper.get("[data-testid='max-colors-slider']").setValue(raw);
    expect(wrapper.emitted("input")?.at(-1)).toEqual([{ value: expected, error: "" }]);
  });

  it.each(["3", "30", "40", "221"])(
    "用色滑条拖到 %s ⇒ 原样 emit（离任何节点都超过阈值 4）",
    async (raw) => {
      const wrapper = mountColorSlider();
      await wrapper.get("[data-testid='max-colors-slider']").setValue(raw);
      expect(wrapper.emitted("input")?.at(-1)).toEqual([{ value: Number(raw), error: "" }]);
    },
  );

  /**
   * 吸附必须**看得见**：只 emit 而不回写时，用户把拇指放在 9、面板却按 8 生成，拇指停在旧位置
   * ——屏幕与产物对不上（本项目点名的头号缺陷形态）。
   *
   * 这一拍由**父级回灌**完成（就是 `SetupPage` 的真实动作：写 store 再回流）：父级的 `value`
   * 变成 8 之后，Vue 打 `value` 这个动态 prop 时会发现 DOM 里还是 9，把拇指拨到吸附点。
   * 组件自己不抢着写 DOM——那是同一份状态的第二套写法。
   */
  it("吸附结果回灌后滑条停在吸附点（9 ⇒ 上报 8 ⇒ 父级采纳 ⇒ 拇指在 8）", async () => {
    const wrapper = mountColorSlider();
    const slider = wrapper.get("[data-testid='max-colors-slider']");
    await slider.setValue("9");
    expect(wrapper.emitted("input")?.at(-1)).toEqual([{ value: 8, error: "" }]);

    await wrapper.setProps({ value: 8 });
    expect((slider.element as HTMLInputElement).value).toBe("8");
  });

  /** 数字输入框**不吸附**：用户填多少就多少（「直接数字是多少就多少」这条口径只由它承载）。 */
  it("数字输入框不吸附：填 9 就 emit 9", async () => {
    const wrapper = mountColorSlider();
    await wrapper.get("[data-testid='max-colors']").setValue("9");
    expect(wrapper.emitted("input")?.at(-1)).toEqual([{ value: 9, error: "" }]);
  });
});

/**
 * `labels` 的两种画法（2026-10-10 新增）。
 *
 * `"below"`：轨道上只画**刻度线**（1px 竖线按真实百分比定位——线不会互相撞），数字改到滑条
 * 下方一行。用色那条的 8 / 16 / 24 在 1–221 上分别落在 3.18% / 6.82% / 10.45%，220px 轨道上
 * 标签中心只隔 8px 而标签本身 30–36px 宽 ⇒ 绝对定位的数字**必然重叠**（几何事实，不是样式
 * 没调好）；`left: 100%` 的「不限」更因为绝对定位盒可用宽为 0 而退化成竖排。
 */
describe("TierSlider 的 labels 两种画法", () => {
  it('labels="below"：刻度线数量 = 节点数，且位置按真实百分比', () => {
    const wrapper = mountColorSlider();
    const ticks = wrapper.findAll("[data-tick]");
    expect(ticks).toHaveLength(3);
    const at = (value: number): number => ((value - 1) / (221 - 1)) * 100;
    const lefts = ticks.map((tick) => {
      const match = /([\d.]+)%/.exec(tick.attributes("style") ?? "");
      return match?.[1] === undefined ? Number.NaN : Number(match[1]);
    });
    expect(lefts[0]).toBeCloseTo(at(8), 6);
    expect(lefts[1]).toBeCloseTo(at(16), 6);
    expect(lefts[2]).toBeCloseTo(at(24), 6);
    // 刻度线只是装饰：不吃指针事件（否则会挡住原生滑条的命中区）。
    expect(ticks[0]!.classes()).toContain("pointer-events-none");
  });

  it('labels="below"：档位数字渲染在滑条下方一行，且**没有**绝对定位的数字标签', () => {
    const wrapper = mountColorSlider();
    const line = wrapper.get("[data-node-line]").text();
    expect(line).toContain("8 / 16 / 24");
    expect(line).toContain("221");
    // 数字若仍画在轨道上（变异：把刻度线换回绝对定位的标签），这条立刻红。
    expect(wrapper.find("[data-node]").exists()).toBe(false);
  });

  it('labels="track"：数字仍绝对定位在轨道上，并带 whitespace-nowrap（「不限」曾被压成竖排）', () => {
    const wrapper = mountSlider();
    const marks = wrapper.findAll("[data-node]");
    expect(marks).toHaveLength(3);
    expect(marks[0]!.classes()).toContain("absolute");
    expect(marks[0]!.classes()).toContain("-translate-x-1/2");
    expect(marks[0]!.classes()).toContain("whitespace-nowrap");
    // 这条画法不画刻度线、也没有下方数字行。
    expect(wrapper.findAll("[data-tick]")).toHaveLength(0);
    expect(wrapper.find("[data-node-line]").exists()).toBe(false);
  });
});

/**
 * 像素风外观（§7.3）：轨道 / 旋钮换皮，**吸附与档位语义一个字不动**（本组一条都不碰它们）。
 *
 * 原生滑条的轨道与旋钮只能在厂商伪元素上画，`[&::-webkit-slider-…]` 任意变体是唯一不经
 * `<style>` 块的写法。happy-dom 不解析 CSS，所以这里钉的是**类名**——与触控目标那条同一口径。
 */
describe("TierSlider 的像素风外观（§7.3）", () => {
  it("轨道 = 3px ink 描边的沙色圆条，旋钮 = 34px 的 go 圆，都在 56px 的触控区里", () => {
    const slider = mountSlider().get("[data-testid='long-side-slider']");
    const classes = slider.classes().join(" ");
    expect(classes).toContain("h-14"); // 触控区（R35）
    expect(classes).toContain("[&::-webkit-slider-runnable-track]:box-border");
    expect(classes).toContain("[&::-webkit-slider-runnable-track]:h-3");
    expect(classes).toContain("[&::-webkit-slider-runnable-track]:rounded-full");
    expect(classes).toContain("[&::-webkit-slider-runnable-track]:border-bead-ink");
    expect(classes).toContain("[&::-webkit-slider-runnable-track]:bg-bead-sand-3");
    expect(classes).toContain("[&::-webkit-slider-thumb]:box-border");
    expect(classes).toContain("[&::-webkit-slider-thumb]:h-[34px]");
    expect(classes).toContain("[&::-webkit-slider-thumb]:w-[34px]");
    expect(classes).toContain("[&::-webkit-slider-thumb]:rounded-full");
    expect(classes).toContain("[&::-webkit-slider-thumb]:border-4");
    expect(classes).toContain("[&::-webkit-slider-thumb]:bg-bead-go");
    // 默认调色板与默认字号都不许再出现在这条滑条上（任务 19 的守卫 (a) / (f) 在文件层再扫一遍）。
    expect(classes).not.toContain("accent-slate-900");
    expect(classes).not.toContain("text-lg");
  });

  /**
   * `labels` 的两种画法是**对外契约**（`ParamPanel` 的用色那条必须 `below`：8 / 16 / 24 在 220px
   * 轨道上会重叠；长边那条必须 `track`）。这里用真实的 `data-*` 钩子（仓里没有 `tier-labels-*`
   * 这种 testid）钉住「两种画法各自出哪些节点」，防止换皮时把某一支的节点删掉。
   */
  it("两套标签位置没被改（用色数 below 画刻度线、长边 track 画轨道数字）", () => {
    const below = mountSlider({ labels: "below" });
    expect(below.find("[data-tick]").exists()).toBe(true);
    expect(below.find("[data-node-line]").exists()).toBe(true);
    expect(below.find("[data-node]").exists()).toBe(false);

    const track = mountSlider({ labels: "track" });
    expect(track.find("[data-node]").exists()).toBe(true);
    expect(track.find("[data-tick]").exists()).toBe(false);
    expect(track.find("[data-node-line]").exists()).toBe(false);
  });
});
