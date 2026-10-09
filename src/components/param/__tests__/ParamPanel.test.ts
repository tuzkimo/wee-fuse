import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import type { Decoder } from "@/core/image/decode";
import type { RgbaImage } from "@/core/image/types";
import { loadPalette } from "@/core/palette/registry";
import { generatePattern } from "@/services/pipeline";
import ParamPanel from "@/components/param/ParamPanel.vue";

/** 600×600 的裁剪 + 长边 58 → 58×58 颗、29.0×29.0 厘米、2×2=4 块板。 */
function mountPanel(overrides: Record<string, unknown> = {}) {
  return mount(ParamPanel, {
    props: {
      longSide: 58,
      maxColors: 24,
      customMaxColors: 32,
      paletteColorCount: 221,
      crop: { x: 0, y: 0, width: 600, height: 600 },
      rotation: 0,
      paletteName: "MARD 221 色",
      paletteAccuracy: "屏幕色仅供参考，以实物为准",
      busy: false,
      generateBlockedReason: "",
      ...overrides,
    },
  });
}

describe("尺寸摘要", () => {
  it("按裁剪与长边算出豆数 / 厘米 / 板数", () => {
    const wrapper = mountPanel();
    const text = wrapper.get("[data-testid='summary']").text();
    expect(text).toContain("58 × 58 颗");
    expect(text).toContain("约 29.0 × 29.0 厘米");
    expect(text).toContain("需要 2 × 2 = 4 块板");
  });

  // 非正方形裁剪：短边按比例四舍五入（400×200 的长边 10 → 10×5）。
  // 厘米那条同时钉住「宽在前、高在后」的顺序（正方形裁剪下两轴相等，看不出顺序）。
  it("非正方形裁剪按比例算短边", () => {
    const wrapper = mountPanel({ crop: { x: 0, y: 0, width: 400, height: 200 }, longSide: 10 });
    const text = wrapper.get("[data-testid='summary']").text();
    expect(text).toContain("10 × 5 颗");
    expect(text).toContain("约 5.0 × 2.5 厘米");
  });

  // 60 × 30 颗：宽 60 → ceil(60/29) = 3 列，高 30 → ceil(30/29) = 2 行，共 6 块。
  // 参数顺序反了会得到「2 × 3」；把 ceil 写成 round 会得到「3 × 1 = 3」——
  // 简报里那条 58×58（2×2）对这两种错误都是恒绿的。
  it("板数按「宽 → 列、高 → 行」接线，且向上取整", () => {
    const wrapper = mountPanel({ crop: { x: 0, y: 0, width: 600, height: 300 }, longSide: 60 });
    expect(wrapper.get("[data-testid='summary']").text()).toContain("需要 3 × 2 = 6 块板");
  });

  // 这条专打「摘要不传 rotation」的实现：rotation 1 下显示空间换轴，摘要必须跟着换。
  it("旋转 90° 后豆数换轴（与生成结果同一函数）", () => {
    const crop = { x: 0, y: 0, width: 400, height: 200 };
    const flat = mountPanel({ crop, longSide: 10, rotation: 0 });
    const rotated = mountPanel({ crop, longSide: 10, rotation: 1 });
    expect(flat.get("[data-testid='summary']").text()).toContain("10 × 5 颗");
    expect(rotated.get("[data-testid='summary']").text()).toContain("5 × 10 颗");
  });

  // 【修复轮 1】上面这些用例全是**重新挂载**（`mountPanel({ rotation: 1 })`）：它们证明摘要
  // 「依赖」rotation，却不证明它对 prop **变化**「响应」——把 `props.rotation` 在 setup 里
  // 提成普通常量（挂载时取一次快照）后，本文件 20 条用例全绿。
  //
  // 这个缺口之所以是承重的：设计规格 §4.5 的平板布局把本组件与 CropCanvas 并置，用户在左栏
  // 拖框 / 旋转时右栏摘要必须当场跟着变（「改参数即时看到结果」）；否则每一帧都在演示本项目
  // 点名的头号缺陷形态「UI 显示 X、生成出来 Y」。
  it("同一实例上改 rotation 时摘要立刻换轴", async () => {
    const wrapper = mountPanel({ crop: { x: 0, y: 0, width: 400, height: 200 }, longSide: 10 });
    expect(wrapper.get("[data-testid='summary']").text()).toContain("10 × 5 颗");

    await wrapper.setProps({ rotation: 1 });

    // 豆数与厘米两条都换轴：只看豆数会漏掉「只换了一处」的半响应实现。
    const text = wrapper.get("[data-testid='summary']").text();
    expect(text).toContain("5 × 10 颗");
    expect(text).toContain("约 2.5 × 5.0 厘米");
  });

  // 同一实例、同一个缺口，换 crop 走一遍。
  it("同一实例上换 crop 时摘要立刻重算（豆数 / 厘米 / 板数三处都变）", async () => {
    const wrapper = mountPanel();
    expect(wrapper.get("[data-testid='summary']").text()).toContain("58 × 58 颗");

    await wrapper.setProps({ crop: { x: 0, y: 0, width: 400, height: 200 } });

    const text = wrapper.get("[data-testid='summary']").text();
    expect(text).toContain("58 × 29 颗");
    expect(text).toContain("约 29.0 × 14.5 厘米");
    expect(text).toContain("需要 2 × 1 = 2 块板");
  });
});

describe("长边输入", () => {
  it("合法输入才 emit，并同步摘要", async () => {
    const wrapper = mountPanel();
    await wrapper.get("[data-testid='long-side']").setValue("116");

    expect(wrapper.emitted("update:longSide")?.at(-1)).toEqual([116]);
    expect(wrapper.get("[data-testid='summary']").text()).toContain("116 × 116 颗");
    // 合法输入不该挂一个空的错误框。
    expect(wrapper.find("[data-testid='blocked-reason']").exists()).toBe(false);
  });

  // 三个快捷值都是契约里的数据钩子；漏掉 58 / 116 时只点 29 是看不出来的。
  it("快捷值按钮直接 emit", async () => {
    const wrapper = mountPanel();
    for (const [testid, value] of [
      ["preset-29", 29],
      ["preset-58", 58],
      ["preset-116", 116],
    ] as const) {
      await wrapper.get(`[data-testid='${testid}']`).trigger("click");
      expect(wrapper.emitted("update:longSide")?.at(-1)).toEqual([value]);
    }
  });

  // 父级回灌（快捷值按钮在真实父级里走的是 store，或从已有工程播种）。
  it("父级改长边时输入框与摘要跟着变", async () => {
    const wrapper = mountPanel();
    await wrapper.setProps({ longSide: 29 });

    expect((wrapper.get("[data-testid='long-side']").element as HTMLInputElement).value).toBe("29");
    expect(wrapper.get("[data-testid='summary']").text()).toContain("29 × 29 颗");
  });

  // 越界探针取 **117**（上限 116 的紧邻外侧）：旧写法是 `"501"`，改常量前后它都被拒、
  // 没有任何判别力；117 才真的钉住「上限就是 116」这一条。
  it.each(["0", "117", "2.5", ""])("非法输入 %s 不 emit，给出原因并禁用生成", async (bad) => {
    const wrapper = mountPanel();
    await wrapper.get("[data-testid='long-side']").setValue(bad);

    expect(wrapper.emitted("update:longSide")).toBeUndefined();
    expect(wrapper.get("[data-testid='blocked-reason']").text()).toContain("1–116");
    expect(wrapper.get("[data-testid='generate']").attributes("disabled")).toBeDefined();
  });

  // 【修复轮 1】上面那条只断言 0 / 117 **被拒**，1 与 116 这两个边界值从未被断言「**接受**」：
  // 把 `value <= MAX_LONG_SIDE` 改成 `<`（或把 `>= MIN_LONG_SIDE` 改成 `>`）后 20 条用例全绿。
  // 边界是规格 §4.6 / 关键常量「长边豆数范围 1–116」的端点，被拒就是功能缺失。
  it.each([1, 116])("边界值 %i 被接受（emit、有摘要、可生成）", async (value) => {
    const wrapper = mountPanel();
    await wrapper.get("[data-testid='long-side']").setValue(String(value));

    expect(wrapper.emitted("update:longSide")?.at(-1)).toEqual([value]);
    expect(wrapper.get("[data-testid='summary']").text()).toContain(`${value} × ${value} 颗`);
    expect(wrapper.find("[data-testid='blocked-reason']").exists()).toBe(false);
    expect(wrapper.get("[data-testid='generate']").attributes("disabled")).toBeUndefined();
  });
});

describe("档位与色卡", () => {
  it("点「16 色」emit 的是数字 16", async () => {
    const wrapper = mountPanel();
    await wrapper.get("[data-testid='max-colors-16']").trigger("click");
    expect(wrapper.emitted("update:maxColors")?.at(-1)).toEqual([16]);
  });

  it("点「不限」emit 的是字符串 'all'（不是 null、不是空串、不是 0）", async () => {
    const wrapper = mountPanel();
    await wrapper.get("[data-testid='max-colors-all']").trigger("click");
    expect(wrapper.emitted("update:maxColors")?.at(-1)).toEqual(["all"]);
  });

  it("点「自定义」emit 'custom'，并显示自定义色数输入框", async () => {
    const wrapper = mountPanel();
    expect(wrapper.find("[data-testid='custom-max-colors']").exists()).toBe(false);
    await wrapper.get("[data-testid='max-colors-custom']").trigger("click");
    expect(wrapper.emitted("update:maxColors")?.at(-1)).toEqual(["custom"]);
    await wrapper.setProps({ maxColors: "custom" });
    expect(wrapper.find("[data-testid='custom-max-colors']").exists()).toBe(true);
  });

  it("自定义色数输入合法值时 emit 数字；非法值 emit 不出去且给出中文提示", async () => {
    const wrapper = mountPanel({ maxColors: "custom", customMaxColors: 32 });
    const input = wrapper.get("[data-testid='custom-max-colors']");
    await input.setValue("40");
    expect(wrapper.emitted("update:customMaxColors")?.at(-1)).toEqual([40]);

    await input.setValue("0");
    expect(wrapper.emitted("update:customMaxColors")).toHaveLength(1); // 只在合法那一次 emit 过
    expect(wrapper.get("[data-testid='blocked-reason']").text()).toContain(
      "色数要填 1–221 之间的整数",
    );
    await input.setValue("999");
    expect(wrapper.emitted("update:customMaxColors")).toHaveLength(1);
  });

  /**
   * 上面几条只「写」按钮，读不出它有没有显示父级当前的档位——少了 `aria-pressed` 绑定，
   * 按钮组会全都停在未选中态而所有写入型断言照样绿。
   */
  it("按钮组显示父级当前的档位（aria-pressed 精确到那一个）", () => {
    for (const [maxColors, expected] of [
      [8, "max-colors-8"],
      [16, "max-colors-16"],
      [24, "max-colors-24"],
      ["all", "max-colors-all"],
      ["custom", "max-colors-custom"],
    ] as const) {
      const wrapper = mountPanel({ maxColors });
      for (const testid of ["max-colors-8", "max-colors-16", "max-colors-24", "max-colors-all", "max-colors-custom"]) {
        const pressed = wrapper.get(`[data-testid='${testid}']`).attributes("aria-pressed");
        expect(pressed).toBe(testid === expected ? "true" : "false");
      }
    }
  });

  it("色卡卡片显示名称与精度声明（主规格 §11：声明必须出现在色卡 UI 上）", () => {
    const wrapper = mountPanel();
    const card = wrapper.get("[data-testid='palette-card']").text();
    expect(card).toContain("MARD 221 色");
    expect(card).toContain("屏幕色仅供参考，以实物为准");
  });
});

describe("生成按钮", () => {
  it("点按 emit generate", async () => {
    const wrapper = mountPanel();
    const button = wrapper.get("[data-testid='generate']");
    expect(button.text()).toContain("生成图纸");
    await button.trigger("click");
    expect(wrapper.emitted("generate")).toHaveLength(1);
  });

  it("busy 期间禁用（禁止并发生成）", () => {
    const wrapper = mountPanel({ busy: true });
    const button = wrapper.get("[data-testid='generate']");
    expect(button.attributes("disabled")).toBeDefined();
    // 长任务期间唯一的进度反馈（点按后的即时回应就是这行字）。
    expect(button.text()).toContain("正在生成");
  });

  it("父级给出的阻拦原因会显示出来并禁用生成（选区太小等）", () => {
    const wrapper = mountPanel({ generateBlockedReason: "选区 50 × 50 像素要拼 58 × 58 颗豆" });
    expect(wrapper.get("[data-testid='blocked-reason']").text()).toContain("选区 50 × 50");
    expect(wrapper.get("[data-testid='generate']").attributes("disabled")).toBeDefined();
  });

  // 【修复轮 1】`blockedReason` 的注释声明「自己的输入错误优先于父级原因」，但上面的用例
  // 各自只设一侧（要么只有本地非法输入、要么只有父级原因），把两个操作数对调后全绿——
  // 优先级这个**行为**此前零覆盖。
  //
  // 为什么本地优先才对：本地原因是从输入框**当下**的文本同步算出来的，永远不会过期；父级原因
  // 是父级拿上一次提交的 props 算出来的，用户这一拍刚打的字还没回流上去。两者同时成立时报
  // 「选区 50 × 50 像素要拼…」会把用户支去改一个他刚改对的东西，而真正要他改的是输入框。
  it("本地非法输入与父级原因同时存在时，显示本地那条", async () => {
    const wrapper = mountPanel({ generateBlockedReason: "选区 50 × 50 像素要拼 58 × 58 颗豆" });
    const input = wrapper.get("[data-testid='long-side']");
    const reason = () => wrapper.get("[data-testid='blocked-reason']").text();

    await input.setValue("0");
    expect(reason()).toContain("1–116");
    expect(reason()).not.toContain("选区 50 × 50");

    // 同一实例上把输入改回合法：父级原因全程都在，只是刚才被本地那条压住了——
    // 这一步把「父级原因真的同时存在」钉死，避免上面的断言靠一个空 props 蒙过去。
    await input.setValue("58");
    expect(reason()).toContain("选区 50 × 50");
    expect(wrapper.get("[data-testid='generate']").attributes("disabled")).toBeDefined();
  });
});

/**
 * 端到端：摘要显示的豆数**就是** `generatePattern` 产出的图纸尺寸。
 *
 * 这是本任务最承重那条接线的判别性证据：摘要与 `services/pipeline.ts` 都调
 * `computeGridSize(rotatedSize(crop.width, crop.height, rotation), longSide)`，
 * 400×300 的裁剪在 rotation 1 下是 44 × 58；把**两端中任意一端**的 rotation 去掉，
 * 就会变成一端说 44 × 58、另一端给 58 × 44（「UI 显示 58×44、生成出来 44×58」那类缺陷）。
 * 这里跑的是真实的 `generatePattern`，只把平台解码器换成桩。
 */
describe("端到端：摘要 = 流水线产出的图纸尺寸", () => {
  const palette = loadPalette({
    id: "param-panel-e2e",
    name: "测试色卡",
    source: "https://example.com",
    accuracy: "仅测试用",
    colors: [
      { code: "W", hex: "#ffffff" },
      { code: "K", hex: "#000000" },
    ],
  });

  /** 纯白不透明 8×8：保底路径（native）只要求「有一张位图」，下游按实际尺寸面积平均重采样。 */
  const solid: Decoder = {
    name: "solid",
    outputSize: "native",
    async decode(): Promise<RgbaImage> {
      const data = new Uint8ClampedArray(8 * 8 * 4).fill(255);
      return { width: 8, height: 8, data };
    },
  };

  /** 裁剪 400×300 < 2048，按择路规则必须走保底路径；被选中即用例失败。 */
  const fastForbidden: Decoder = {
    name: "fast-should-not-be-used",
    outputSize: "target",
    async decode(): Promise<RgbaImage> {
      throw new Error("裁剪长边在预算内，不应走快路径");
    },
  };

  it("400 × 300 的裁剪在 rotation 1 下两端都换轴（44 × 58）", async () => {
    const crop = { x: 0, y: 0, width: 400, height: 300 };
    const wrapper = mountPanel({ crop, rotation: 1, longSide: 58, maxColors: "all" });

    const pattern = await generatePattern(
      {
        source: new Blob([new Uint8Array([1])]),
        sourceSize: { width: 400, height: 300 },
        crop,
        rotation: 1,
        longSide: 58,
        maxColors: "all",
      },
      { exactDecoder: solid, fastDecoder: fastForbidden, palette },
    );

    expect([pattern.width, pattern.height]).toEqual([44, 58]);
    expect(wrapper.get("[data-testid='summary']").text()).toContain("44 × 58 颗");
  });
});
