/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";

/**
 * 平台接入的四条源码级闸门（规格 §3.2）。
 *
 * **为什么要有它们**：这类缺陷在 happy-dom 里绿不绿取决于执行顺序 —— 一旦平台判断散开，
 * 某个用例会莫名其妙地去碰 Tauri 的全局对象，而它在 CI 里是绿是红要看谁先跑。闸门的对象
 * 是**结构**，不是取值：`ExportPanel` 改回直调 `downloadBlob` 时浏览器里照样能用、照样全绿
 * （G4 的靶子正是这条）。
 *
 * 与 `coreBoundary.test.ts` / `layoutGate.test.ts` 同法：`import.meta.glob` + `?raw` 读源码文本，
 * 做**词法近似**匹配；剥注释用同一套手写状态机（照 `layoutGate.test.ts` 的实现抄，不 import 它——
 * 那个文件在 `core/render/__tests__/` 下，跨层 import 会让本闸门依赖 core 的测试辅助）。
 *
 * **已知偏差（刻意接受、不许放宽规则）**：把包名拼成 `"@tauri-apps/" + name` 能绕过 G1；
 * `globalThis["is" + "Tauri"]` 能绕过 G2。两条都要求作者**主动规避**，代价大于收益。
 * **测试文件整体不在 G1 的扫描范围内**（`__tests__` 路径段 / `.test.ts` / `.spec.ts` 结尾；
 * 理由见 `isTestFile` 的注释：那里的包名是数据，而且测试里静态 import 它会在收集阶段就崩）。
 * **本文件自身不在 G1 / G2 的扫描范围内**（否则它用来描述禁令的那几个字符串与正则字面量会把
 * 自己判违规）。**另一条要注意的偏差**：`stripComments` 不认识正则字面量——`/@tauri-apps\//`
 * 这种写法里的 `\//` 会被它当成行注释的开头，把该行剩余部分吞掉（方向是漏报）。
 *
 * 转绿时点（本计划分两遍写，先记在这里）：
 * - **G2 / G3：本任务即绿**；
 * - **G1：任务 2 转绿** —— 它要求「含 `@tauri-apps/` 的文件集合**恰好**是 `tauriDriver.ts`」，
 *   而那个文件任务 2 才创建；在此之前集合是空的，闸门**故意红**（不是恒真通过：它要求那个文件存在）；
 * - **G3b：任务 2 转绿**（`main.ts` 引入 `isTauriRuntime()`）；
 * - **G4：pass 2 的「保存到相册」任务转绿**（面板改走 `album.save`）。
 */
const SOURCES: Record<string, string> = import.meta.glob<string>("../**/*.{ts,vue}", {
  eager: true,
  query: "?raw",
  import: "default",
});

const GATE_FILE = "../__tests__/platformGate.test.ts";
const DRIVER_FILE = "../services/platform/tauriDriver.ts";
const CAPABILITIES_FILE = "../services/platform/capabilities.ts";
const MAIN_FILE = "../main.ts";
const PANEL_FILE = "../components/editor/ExportPanel.vue";

/** 剥离注释（保留换行与字符串内容）。 */
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
      while (index < source.length && source[index] !== "\n") index += 1;
      result += "\n";
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        result += source[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      index += 2;
      continue;
    }
    result += char;
    index += 1;
  }
  return result;
}

/** 再剥掉字符串**内容**（保留引号）。用于「不许出现某个标识符」这类检查。 */
function stripStrings(source: string): string {
  let result = "";
  let quote: string | null = null;
  let index = 0;
  while (index < source.length) {
    const char = source[index] ?? "";
    if (quote === null) {
      if (char === '"' || char === "'" || char === "`") {
        quote = char;
        result += char;
        index += 1;
        continue;
      }
      result += char;
      index += 1;
      continue;
    }
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === quote) {
      quote = null;
      result += char;
      index += 1;
      continue;
    }
    index += 1;
  }
  return result;
}

function textOf(path: string): string {
  const source = SOURCES[path];
  if (source === undefined) throw new Error(`闸门读不到源码：${path}`);
  return source;
}

/**
 * 是否**测试文件**：路径里含 `__tests__` 路径段，或文件名以 `.test.ts` / `.spec.ts` 结尾。
 *
 * **为什么 G1 要排除它们（2026-10-06 修复轮 F1，实测踩出来的）**：
 * `src/__tests__/coreBoundary.test.ts` 把 `"@tauri-apps/api/core"` 当**数据**用（B1 的断言字符串），
 * 而 G1 的基线是「剥注释、**保留字符串**」（import 的包名就在字符串里，不能剥）⇒ 它必然命中，
 * G1 于是会因为一个与平台接线无关的原因红，任务 2 只创建 `tauriDriver.ts` 也不会转绿。
 * 这正是 `coreBoundary.test.ts` 对 core 扫描的**同一个处置**（该文件头部注释：core 的
 * `__tests__` 文件不在扫描范围内、整文件不扫）。**不是放宽规则**：测试文件里静态 import
 * `@tauri-apps/*` 会在 vitest 的**收集阶段**就崩（本仓记账过这条），它不需要这道闸门也有自证。
 * （偏差如实登记：测试文件里把包名拼进字符串不再被 G1 拦——那是数据，不是接线。）
 */
function isTestFile(path: string): boolean {
  return path.split("/").includes("__tests__") || /\.(test|spec)\.ts$/.test(path);
}

/**
 * 逐文件扫「剥注释、保留字符串」的文本（import 的包名就在字符串里，不能剥）。
 * **扫描对象是非测试文件**（见 `isTestFile`）。`GATE_FILE` 那条显式排除是冗余的（闸门自己就是
 * 测试文件），保留是因为它的注释解释了「闸门要能描述它禁的东西」。
 */
function filesWithKeptStrings(pattern: RegExp): string[] {
  const hits: string[] = [];
  for (const [path, source] of Object.entries(SOURCES)) {
    if (path === GATE_FILE) continue;
    if (isTestFile(path)) continue;
    if (pattern.test(stripComments(source))) hits.push(path);
  }
  return hits.sort();
}

describe("平台接入闸门", () => {
  it("G1：只有 tauriDriver.ts 允许出现 @tauri-apps/", () => {
    expect(filesWithKeptStrings(/@tauri-apps\//)).toEqual([DRIVER_FILE]);
  });

  it("G2：只有 capabilities.ts 允许读 isTauri", () => {
    const hits: string[] = [];
    for (const [path, source] of Object.entries(SOURCES)) {
      // **必须跳过本文件自己**（与 G1 同理，但这里是踩出来的）：下面的正则字面量 `/…\bisTauri\b/`
      // 不是字符串、`stripStrings` 剥不掉它，于是本文件会把自己判成违规、G2 永远红。
      if (path === GATE_FILE) continue;
      if (/\bisTauri\b/.test(stripStrings(stripComments(source)))) hits.push(path);
    }
    expect(hits.sort()).toEqual([CAPABILITIES_FILE]);
  });

  it("G3：main.ts 的 setPlatform 必须早于 mount", () => {
    const code = stripComments(textOf(MAIN_FILE));
    const setIndex = code.indexOf("setPlatform(");
    const mountIndex = code.indexOf("mount(");
    expect(setIndex).toBeGreaterThanOrEqual(0);
    expect(mountIndex).toBeGreaterThanOrEqual(0);
    expect(setIndex).toBeLessThan(mountIndex);
  });

  it("G3b（任务 2 转绿）：main.ts 必须按运行时选择实现", () => {
    expect(stripComments(textOf(MAIN_FILE))).toContain("isTauriRuntime()");
  });

  it("G4（pass 2 转绿）：ExportPanel 不得直调 downloadBlob，必须走 album.save", () => {
    const code = stripComments(textOf(PANEL_FILE));
    expect(code).not.toContain("downloadBlob");
    expect(code).toContain("album.save(");
  });
});
