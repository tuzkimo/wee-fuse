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
      ...overrides,
    },
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
   * 触控目标（主规格 §6.4 / 本任务约束：轨道 ≥44px）。
   *
   * happy-dom 没有布局，`getBoundingClientRect` 恒 0——与仓里既有那批用例同一条纪律：
   * 「≥44px」**唯一可观察的形式就是类名**（`h-11` = 2.75rem = 44px），所以这里钉类名。
   * 拇指高度由浏览器决定（原生滑条），不在本组件的控制面上、也无法在 happy-dom 里读。
   */
  it("触控目标：轨道 h-11（44px）、数字输入框 min-h-12", () => {
    const wrapper = mountSlider();
    expect(wrapper.get("[data-testid='long-side-slider']").classes()).toContain("h-11");
    expect(wrapper.get("[data-testid='long-side']").classes()).toContain("min-h-12");
  });
});
