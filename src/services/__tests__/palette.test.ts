import { describe, expect, it } from "vitest";
import { getBuiltinPalette } from "@/services/palette";

describe("内置色卡入口", () => {
  it("返回 MARD 221 色卡，且 id / 色数正确", () => {
    const palette = getBuiltinPalette();
    expect(palette.id).toBe("mard221");
    expect(palette.colors).toHaveLength(221);
  });

  it("重复调用返回同一对象（不在每次渲染里重新解析 JSON）", () => {
    expect(getBuiltinPalette()).toBe(getBuiltinPalette());
  });

  it("包含色号 A1 与 H1（能对上真实可采购色号）", () => {
    const codes = new Set(getBuiltinPalette().colors.map((c) => c.code));
    expect(codes.has("A1")).toBe(true);
    expect(codes.has("H1")).toBe(true);
  });

  // 上面三条都是「不看形状」的断言：把实现换成 `return builtinMard221 as Palette`（绕过
  // loadPalette 的逐字段重建）它们照样全绿——原始 JSON 里同样有 id 与 221 个带 code 的元素。
  // 下面这条钉住「返回值确实经过校验重建」：原始 JSON 的颜色是 `{ code, name, hex }`，
  // 重建后是 `{ code, name, rgb }`，键集与值都不同，绕过去就红。
  it("返回经过校验重建的 Palette（颜色是 rgb 三元组，不是原始 JSON 的 hex 串）", () => {
    const colors = getBuiltinPalette().colors;
    expect(colors[0]).toEqual({ code: "A1", name: "", rgb: [250, 245, 205] });
    expect(Object.keys(colors[0] ?? {}).sort()).toEqual(["code", "name", "rgb"]);
  });
});
