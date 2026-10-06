import { describe, expect, it } from "vitest";
import { requireSavableBlob } from "../guards";

/**
 * 守卫的直接用例。
 *
 * 为什么不把它们放进 `platformContract.ts`：契约测试是**按实现各跑一遍**的，而守卫是纯函数、
 * 与实现无关；放进去会让同一条纯函数断言跑两遍，还会把「消息逐字」与「实现语义」两件事混在一起。
 *
 * 两条消息逐字沿用 `services/exporter.ts` 里 `downloadBlob` 原有的那两条——本任务把它们
 * 收敛到一处，**消息一个字都不许改**（既有 `exporter.test.ts` 读的就是这两句）。
 */
describe("requireSavableBlob", () => {
  it("空 blob 响亮失败", () => {
    expect(() => requireSavableBlob(new Blob([]), "a.png")).toThrowError(
      "导出内容为空（blob 大小为 0）",
    );
  });

  it("不是 Blob 的输入有自己的消息（不谎称「blob 大小为 0」）", () => {
    expect(() => requireSavableBlob({ size: 12 }, "a.png")).toThrowError("导出内容必须是 Blob");
    expect(() => requireSavableBlob(null, "a.png")).toThrowError("导出内容必须是 Blob");
  });

  it("空白文件名响亮失败", () => {
    expect(() => requireSavableBlob(new Blob([new Uint8Array([1])]), "   ")).toThrowError(
      "文件名不能为空",
    );
  });

  it("非字符串文件名有自己的消息（过去是裸 TypeError）", () => {
    expect(() => requireSavableBlob(new Blob([new Uint8Array([1])]), 42)).toThrowError(
      "文件名必须是字符串",
    );
  });

  it("**判序**：内容与文件名同时非法时，抛的是内容那条（规格 §4.4「判序固定：先内容、后文件名」）", () => {
    // 上面五条各只有一个非法入参，判序在它们身上**全都是绿的**（修复轮 F5）：把
    // `guards.ts` 的 `size === 0` 那条挪到文件名判完之后，只有这一条会红。
    // 判序不是审美：`new Blob([])` + 非字符串名是真实可能同时出现的入参（强转 / JSON 回读），
    // 消息必须指最先该改的那一项，否则用户改完文件名仍存不下去、却拿不到第二条线索。
    expect(() => requireSavableBlob(new Blob([]), 42)).toThrowError(
      "导出内容为空（blob 大小为 0）",
    );
    expect(() => requireSavableBlob(new Blob([]), "   ")).toThrowError(
      "导出内容为空（blob 大小为 0）",
    );
  });

  it("合法入参返回 trim 后的文件名与同一个 blob 对象", () => {
    const blob = new Blob([new Uint8Array([1, 2])]);
    const safe = requireSavableBlob(blob, "  小猫-施工图.png  ");
    expect(safe.blob).toBe(blob);
    expect(safe.filename).toBe("小猫-施工图.png");
  });
});
