/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";

/**
 * 「不许长出第二份坐标数学」的词法闸门（规格 §4.4）。
 *
 * **第一行的 `/// <reference types="vite/client" />` 不是装饰**（2026-10-05 由任务 2 起草者实测发现）：
 * 本仓没有任何 `*.d.ts` 入口把 `import.meta.glob` 的类型带进来，缺了它 `npm run build` 会报
 * `TS2339: Property 'glob' does not exist on type 'ImportMeta'`。`src/__tests__/coreBoundary.test.ts`
 * 的第一行就是同一句，且它的文件头解释了为什么用 `vite/client` 而不是 `@types/node`
 * （后者会把 Node 全局拉进整个程序、削弱 `tsconfig.json` 的 `types` 闸门）。**照着它写。**
 *
 * 与 `src/__tests__/coreBoundary.test.ts` 同法：`import.meta.glob` + `?raw` 读源码文本，做**词法近似**匹配。
 * 宁可漏报变体，也不制造误报——误报会卡死后续所有任务。
 *
 * 五条检查，**两条基线**：
 * - **禁止类**（第 1 / 2 / 3 条）用 `stripComments(...)`：**保留字符串内容**（只会更严，方向安全），
 *   剥注释是因为「渲染器不许读 cellPx」这类诚实的注释不该被自己的闸门判违规。
 * - **正向类**（第 4 / 5 条）用 `stripCommentsAndStrings(...)`：还必须剥掉**字符串内容**，否则
 *   一句 `void "shareCellBox(";` 就能让 `toContain` 永远绿（2026-10-05 任务级审查抓到；实测：
 *   修复前该变异 = 闸门 7 passed）。
 *
 * 两条正向检查的判别力演进（都有实测）：
 * - 2026-10-05 修复轮 1 之前读**原始源码**：注释里留一句 `cellAt(` / `shareCellBox(` 就能骗过它们
 *   （把 `share.ts` 的 `shareCellBox` 调用换成字面量 box、只保留 import 与注释字样时，整套用例曾是
 *   **全绿**：闸门 7 passed / share.test.ts 9 passed）；
 * - 修复轮 1 改成剥注释后仍有字符串这一层，本轮补上。
 *
 * 1. `sheet.ts` / `share.ts` 里不出现标识符 `cellPx`。渲染器要线宽 / 字号只能读 plan 的派生字段
 *    （`lineWidths` / `labelFontPx` / `tickFontPx`），格子的像素位置只能经 `cellBox` / `shareCellBox` 取得。
 * 2. 两个渲染器都不直接读 `pattern.cells`——格值一律经 `cellAt(pattern, col, row)`（行优先 stride 属于它的职责）。
 * 3. 不得出现 `canvasWidth /` / `canvasHeight /` 这类除法。
 *    **第 3 条不是洁癖**：`canvasWidth / pattern.width` 与 `shareCellBox` 数值逐位相同，把前者换上去的变异
 *    实测 **0 红**——两条数学等价的实现只能靠结构约束判别（详见该用例里的注释）。
 * 4. （正向）两个渲染器都必须出现 `cellAt(`：第 2 条的反面口径。
 * 5. （正向）`share.ts` 必须出现 `shareCellBox(`：与第 3 条配对。
 *
 * 已知偏差（刻意接受）：换名（`const c = tile.cellPx`）能绕过第 1 条；把 stride 拆成两步赋值能绕过第 2 条；
 * 把调用写进模板字面量的 `${...}` 里能绕过第 4 / 5 条。
 * 它挡的是「后人顺手再写一份」，不是刻意规避；判别力由变异实测证明（把 `cellPx` 写回 `sheet.ts` ⇒ 恰好 1 红）。
 */
const RENDER_SOURCES: Record<string, string> = import.meta.glob<string>("../{sheet,share}.ts", {
  eager: true,
  query: "?raw",
  import: "default",
});

/** 剥离注释（保留换行与字符串内容），避免注释文本参与匹配。 */
function stripComments(source: string): string {
  let result = "";
  let quote: string | null = null;
  let index = 0;
  while (index < source.length) {
    const char = source[index] ?? "";
    if (quote !== null) {
      result += char;
      if (char === "\\") {
        result += source[index + 1] ?? "";
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      result += char;
      index += 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      const newline = source.indexOf("\n", index);
      if (newline === -1) break;
      result += "\n";
      index = newline + 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      for (let cursor = index; cursor < stop; cursor += 1) {
        if (source[cursor] === "\n") result += "\n";
      }
      index = stop;
      continue;
    }
    result += char;
    index += 1;
  }
  return result;
}

/**
 * 在 `stripComments` 之上再剥一层**字符串 / 模板字面量的内容**（保留定界符）。
 *
 * **为什么两条「正向」检查必须用这一版**：`stripComments` 刻意**保留字符串内容**（禁止类规则靠它
 * 更严，方向安全），但正向检查问的是「源码里到底有没有调用这个函数」——一句
 * `void "shareCellBox(";` 就能让 `toContain("shareCellBox(")` 永远绿（2026-10-05 任务级审查抓到；
 * 实测：修复前该变异 = 闸门 7 passed）。剥掉字符串内容后，只有真正的调用点算数。
 *
 * 已知偏差（刻意接受，与第 1 条同一量级）：把调用写进模板字面量的 `${...}` 里也会被剥掉。
 */
function stripStrings(source: string): string {
  let result = "";
  let quote: string | null = null;
  let index = 0;
  while (index < source.length) {
    const char = source[index] ?? "";
    if (quote !== null) {
      if (char === "\\") {
        index += 2; // 转义对：连反斜杠带被转义的字符一起丢
        continue;
      }
      if (char === quote) {
        quote = null;
        result += char;
      }
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      result += char;
      index += 1;
      continue;
    }
    result += char;
    index += 1;
  }
  return result;
}

/** 正向检查的基线：注释与字符串内容都不参与匹配。 */
function stripCommentsAndStrings(source: string): string {
  return stripStrings(stripComments(source));
}

describe("渲染器的词法闸门", () => {
  it("扫描目标就是那两个渲染器文件（扫错地方等于闸门形同虚设）", () => {
    const keys = Object.keys(RENDER_SOURCES).sort();
    expect(keys).toEqual(["../share.ts", "../sheet.ts"]);
    expect(keys.every((key) => (RENDER_SOURCES[key] ?? "").length > 0)).toBe(true);
  });

  it("渲染器里不出现 cellPx（坐标只能经 cellBox 取）", () => {
    const offenders = Object.keys(RENDER_SOURCES)
      .sort()
      .filter((key) => /\bcellPx\b/.test(stripComments(RENDER_SOURCES[key] ?? "")));
    expect(offenders).toEqual([]);
  });

  it("渲染器里不直接读 pattern.cells（格值只能经 cellAt 取）", () => {
    const offenders = Object.keys(RENDER_SOURCES)
      .sort()
      .filter((key) => /\bpattern\.cells\b/.test(stripComments(RENDER_SOURCES[key] ?? "")));
    expect(offenders).toEqual([]);
  });

  it("两个渲染器都经 cellAt 读格值（正向口径，注释与字符串里提到都不算）", () => {
    for (const key of Object.keys(RENDER_SOURCES).sort()) {
      expect(
        stripCommentsAndStrings(RENDER_SOURCES[key] ?? ""),
        `${key} 应经 cellAt 读格值`,
      ).toContain("cellAt(");
    }
  });

  it("渲染器里不得出现 canvasWidth / canvasHeight 参与的除法", () => {
    // **这条规则的由来（2026-10-05，任务 2 起草者实测）**：`share.ts` 原本用
    // `plan.canvasWidth / pattern.width` 反推格像素——它与 `shareCellBox` 在数值上**逐位相同**，
    // 把 `shareCellBox` 换回那条反推的变异实测 **0 红**：任何取值断言都判不开这两者。
    // 也就是说，**当两条实现在数学上等价时，唯一能判别的只有结构（源码）约束**。
    // 所以「分享图格像素只能来自 `shareCellBox`」必须由这条词法规则守住，而不是靠某条断言。
    const offenders = Object.keys(RENDER_SOURCES)
      .sort()
      .filter((key) => /\bcanvas(Width|Height)\s*\//.test(stripComments(RENDER_SOURCES[key] ?? "")));
    expect(offenders).toEqual([]);
  });

  it("share.ts 经 shareCellBox 取格位置（正向口径，与上一条配对；注释与字符串里提到都不算）", () => {
    // **这条的判别力靠 `stripCommentsAndStrings`**：
    // - 读**原始**源码时，注释里的一句 `shareCellBox(plan, col, row)` 就足以让「调用点被换成字面量
    //   box」的实现保持全绿（2026-10-05 修复轮 1 实测：闸门 7 passed / share.test.ts 9 passed）；
    // - 只剥注释时，一句 `void "shareCellBox(";` 同样能骗过它（2026-10-05 任务级审查抓到；
    //   实测：修复前该变异 = 闸门 7 passed）。
    expect(
      stripCommentsAndStrings(RENDER_SOURCES["../share.ts"] ?? ""),
      "../share.ts 应经 shareCellBox 取位置",
    ).toContain("shareCellBox(");
  });

  it("剥离注释：注释里提到 cellPx 不算违规，代码里的算", () => {
    const commented = `// 渲染器不许读 cellPx\nconst a = 1;`;
    expect(/\bcellPx\b/.test(stripComments(commented))).toBe(false);
    const real = `// 注释\nconst c = tile.cellPx;`;
    expect(/\bcellPx\b/.test(stripComments(real))).toBe(true);
  });
});
