import { afterEach, describe, expect, it } from "vitest";
import { createMemoryProjectStore } from "@/services/memoryProjectStore";
import {
  defaultProjectName,
  getProjectStore,
  normalizeProjectName,
  setProjectStore,
} from "@/services/projectStore";

/**
 * 这份用例覆盖 `services/projectStore.ts` **自己**的两个契约面：
 * ① 模块级单例适配器（B1-4 明确推后到 B2 —— 现在生成流程会真实消费它们）；
 * ② `defaultProjectName`（B1 时叫 `GeneratePage.defaultName`；B2 期间把这份逻辑迁到本模块以消除
 *    两份会漂的副本，原用例在 `GeneratePage.test.ts` 里——那一页与它的用例已在 B2 任务 14 删除，
 *    见计划开头的「既有测试的处置」）。
 */

afterEach(() => {
  setProjectStore(null);
});

describe("setProjectStore / getProjectStore", () => {
  it("未注入时抛错，而不是静默返回一个假实现", () => {
    setProjectStore(null);
    expect(() => getProjectStore()).toThrow(/尚未初始化/);
  });

  it("注入后拿到的是同一个实例", async () => {
    const store = await createMemoryProjectStore();
    setProjectStore(store);
    expect(getProjectStore()).toBe(store);
  });

  it("setProjectStore(null) 能复位（测试之间不串味）", async () => {
    setProjectStore(await createMemoryProjectStore());
    setProjectStore(null);
    expect(() => getProjectStore()).toThrow(/尚未初始化/);
  });
});

describe("defaultProjectName", () => {
  it("去掉扩展名", () => {
    expect(defaultProjectName("小猫照片.png")).toBe("小猫照片");
    expect(defaultProjectName("a.b.jpg")).toBe("a.b");
  });

  it("没有扩展名时原样返回", () => {
    expect(defaultProjectName("小猫照片")).toBe("小猫照片");
  });

  it("只有扩展名、空串、纯空白都回落到中性名", () => {
    expect(defaultProjectName(".png")).toBe("新图纸");
    expect(defaultProjectName("")).toBe("新图纸");
    expect(defaultProjectName("   ")).toBe("新图纸");
  });

  // 上面那条只断言「纯空白 → 新图纸」，它区分不出「两端都裁」与「只裁一端」：
  // `"   ".trimStart()` 与 `"   ".trimEnd()` 都仍是空串、照样回落（实测：把 `.trim()` 改成
  // `.trimStart()`，简报原有的 9 条全绿）。所以这里对**首尾各带空白**的输入断言返回值——
  // 注意「去扩展名」那步会吃掉 `.png` 后的空格，故两个用例分别对准首、尾。
  it("文件名两端的空白一并裁掉", () => {
    expect(defaultProjectName(" 小猫照片.png ")).toBe("小猫照片");
    expect(defaultProjectName("  a  ")).toBe("a");
  });

  // 长度断言用**字面量 100**：写成 `PROJECT_NAME_MAX` 的话，常量被改坏时两边一起变、断言恒绿。
  it("超长文件名夹到 100 字（否则 put 抛错，而那条记录根本没进库、用户无出路）", () => {
    const name = defaultProjectName(`${"あ".repeat(150)}.png`);
    expect(name).toHaveLength(100);
    // 只断言长度是不够的：`"あ".repeat(150)` 是**全同字符**，`slice(-100)`、`slice(1, 101)`
    // 的长度同样是 100（实测：把 `slice(0, MAX)` 改成 `slice(-MAX)`，简报那几条全绿）。
    // 所以这里用一个首字不同的串，把「留的是前 100 字」也钉住——与 B1 的 `GeneratePage.defaultName`
    // （那一页已在 B2 任务 14 删除，本函数是它唯一的后继）逐字迁移过来的行为一致。
    expect(defaultProjectName(`首${"あ".repeat(149)}.png`)).toBe(`首${"あ".repeat(99)}`);
  });

  it("派生的名字必定能过 normalizeProjectName（不抛）", () => {
    const raw = ["小猫照片.png", "", "   ", ".png", `${"x".repeat(200)}.jpg`, "  a  "];
    for (const fileName of raw) {
      expect(() => normalizeProjectName(defaultProjectName(fileName))).not.toThrow();
    }
  });

  it("非字符串抛错，不猜", () => {
    expect(() => defaultProjectName(undefined)).toThrow(/文件名/);
    expect(() => defaultProjectName(42)).toThrow(/文件名/);
  });
});
