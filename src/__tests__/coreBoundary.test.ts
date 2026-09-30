/// <reference types="vite/client" />
/**
 * 分层边界闸门：`src/core/**` 必须是零依赖、与框架无关的纯计算层。
 *
 * 为什么需要这个测试：根 `tsconfig.json` 的 `types` 只放 `["vitest/globals"]`，能拦住
 * Node 全局（`process`、`Buffer`），但 `lib` 必须包含 `DOM`（Vue 应用需要），所以
 * DOM 全局拦不住。这条测试补上另外半道闸门，随全量 `npm run test` 自动执行。
 *
 * 为什么扫文件用 `import.meta.glob` 而不是 Node 的 `fs`：**文件级
 * `/// <reference types="node" />` 不是文件私有的**。它会把 @types/node 拉进整个
 * `vue-tsc` 程序，而 @types/node 的全局声明（`process`、`Buffer`…）是程序级的，于是
 * `src/**` 里所有文件的 Node 全局重新变得合法，`tsconfig.json` 中
 * `types: ["vitest/globals"]` 那道闸门被悄悄削弱。实测（`src/__nodeGateProbe.ts`
 * 内容为 `export const nodeGateProbe = process.pid;`）：
 *   - 程序里有带该引用的文件时：`vue-tsc --noEmit` 退出码 0，`process` 不报错；
 *   - 把该文件移出 `include` 后：报 `TS2591 Cannot find name 'process'`，闸门恢复。
 * `vite/client` 只声明 `import.meta.glob` / `import.meta.env` 与 CSS module 类型，不涉及
 * 任何 Node 全局（已核对其 d.ts，只引用 `types/importMeta.d.ts` → `hot.d.ts` /
 * `importGlob.d.ts`），因此闸门保持不变。用 `import.meta.glob` 的 `?raw` + `eager`
 * 读取源码，语义与递归 `fs` 一致：覆盖 `src/core/**` 下全部 `.ts`（含任意层子目录），
 * 目录不存在或为空时得到空集合、直接通过。
 *
 * 匹配规则（宁可漏报变体，也不制造误报，误报会卡死后续所有任务）：
 * 1. 扫描分两份文本：
 *    - **import 检测**用「只剥注释、保留字符串内容」的文本——module specifier 本身就在
 *      字符串里，剥掉就读不出来了；
 *    - **全局检测**用「再连字符串内容一起剥掉、只保留引号与换行」的文本——否则
 *      `throw new Error("Image 尺寸非法")` 这类正常文案会被判违规。
 * 2. 所有 DOM/BOM 全局标识符一律**全词匹配**（`/\b名字\b/`）。因此 `Image` 不会命中
 *    `ImageData`，`OffscreenCanvas` 不会命中 `OffscreenCanvasRenderingContext2D`。
 *    两个名字是彼此独立的标识符，`ImageData` 已单独列入清单。
 * 3. 本地同名声明视为遮蔽（shadowing）：文件里出现过 `const window = 3;`（或
 *    let / var / function / class / type / interface / enum / 解构 形态）时，该文件里的
 *    `window` 一律不再报——`const w = window + 1;` 里的 `window` 指本地绑定，不是 DOM
 *    全局，报出来就是误报。不做作用域分析（保守近似）：只要文件里存在同名声明，整篇
 *    都不报；代价是同一文件的另一个作用域里真正引用 `window` 会漏掉，方向仍是宁漏不误。
 * 4. `OffscreenCanvasRenderingContext2D` 目前**故意不拦截**：它几乎不可能脱离
 *    `OffscreenCanvas` 独立出现（写它基本要先写 `getContext`），届时 `OffscreenCanvas`
 *    会被拦下；换成前缀匹配则有误伤自建类型（例如 `ImageMatrix`）的风险。
 * 5. import 来源走**白名单**：`src/core/**` 里任何不以 `./` 或 `../` 开头的 module
 *    specifier 一律违规（裸包名、`node:`、绝对路径、`@/` 别名都算）。黑名单必然漏——
 *    `@vue/reactivity`、`lodash` 都能静默通过；白名单只可能漏「相对路径背后的东西」，
 *    而相对路径走不进 `node_modules`。静态 `import … from`、副作用 `import "x"`、
 *    动态 `import("x")`、`require("x")` 四种写法都识别。
 * 6. 先剥离注释（`//`、`/* *\/`、`/** *\/`）再扫描，否则「这里不能出现 document」这类
 *    正常中文注释会误报；剥离时保留换行，行号与原文件一致。
 *
 * 已知限制（刻意接受，方向都是宁漏不误）：
 * - **不支持正则字面量**（本次不实现正则识别）。扫描器只认字符串，不区分 `/` 是除号、
 *   正则起始还是注释起始，两个方向的后果都存在：
 *   - 含引号的正则（例如 `/['"]/`）会让扫描器误入字符串状态且再无闭合引号，其后所有
 *     `//` 注释都不再被剥离 → 注释里出现 `document` 之类会**误报**（唯一的误报方向）；
 *   - 反向地，`/[//]/` 里的 `//` 会被当成行注释，把该行后续代码整段丢弃 → **漏报**。
 *   区分正则与除法只在语法层可行，识别代价高于收益。
 * - 全局检测剥掉字符串内容，因此 `globalThis["window"]`、模板字面量插值
 *   （`` `${document.title}` ``）里的引用会漏掉。
 * - 只扫 `.ts`，不扫 `.vue` / `.js`；不做作用域分析（见规则 3）。
 */
import { describe, expect, it } from "vitest";

/** 禁止在 `src/core/**` 出现的 DOM/BOM 全局标识符。 */
const FORBIDDEN_GLOBALS: readonly string[] = [
  // 文档、窗口与浏览器存储
  "document",
  "window",
  "navigator",
  "localStorage",
  "sessionStorage",
  // 网络、线程与帧调度
  "fetch",
  "XMLHttpRequest",
  "Worker",
  "requestAnimationFrame",
  // 位图、Canvas 与图片
  "createImageBitmap",
  "ImageBitmap",
  "OffscreenCanvas",
  "Image",
  "ImageData",
  "HTMLImageElement",
  "HTMLCanvasElement",
  "CanvasRenderingContext2D",
];

type ViolationKind = "dom-global" | "import-source";

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly kind: ViolationKind;
  readonly token: string;
}

/** 递归收集 `src/core/**` 下的 `.ts` 源码（含子目录；目录不存在即空对象，不报错）。 */
const RAW_SOURCES: Record<string, string> = import.meta.glob<string>("../core/**/*.ts", {
  eager: true,
  query: "?raw",
  import: "default",
});

/**
 * 扫描机制自检用的第二组 glob。glob 的 key 相对**本文件所在目录**，所以要取到
 * `src/core/x.ts` 这种零层文件用 `../`，`src/core/a/x.ts` 这种子目录文件用 `../a/`。
 *
 * `OWN_DIR_SOURCES` 只覆盖本文件所在目录：这个目录里一定有 `.ts`（就是本文件），
 * 因此它能稳定地证明「`**` 匹配零层目录」且「`?raw` 返回真实源码」，而不必
 * 绑定 `src/main.ts` 之类的具体文件名或内容（那些会随启动逻辑、路由布局变动而失效）。
 */
const OWN_DIR_SOURCES: Record<string, string> = import.meta.glob<string>("./**/*.ts", {
  eager: true,
  query: "?raw",
  import: "default",
});

const SELF_CHECK_SOURCES: Record<string, string> = import.meta.glob<string>("../**/*.ts", {
  eager: true,
  query: "?raw",
  import: "default",
});

/** 确定不存在的目录：用来证明 glob 零匹配时返回空对象，而不是抛错。 */
const MISSING_DIR_SOURCES: Record<string, string> = import.meta.glob<string>(
  "../__no_such_dir__/**/*.ts",
  {
    eager: true,
    query: "?raw",
    import: "default",
  },
);

/**
 * 扫描器核心，一遍走完，按状态决定哪些字符进入结果：
 * - `keepStringContents === true`：只剥注释（`//`、`/* *\/`），字符串内容原样保留，
 *   供 import 检测使用；
 * - `keepStringContents === false`：连字符串内容一起剥掉，只保留引号本身与换行，
 *   供全局检测使用（字符串里的 `"document"` 不是引用）。
 * 两种模式都保留换行，因此结果的行号与原文件一致。
 */
function stripSource(source: string, keepStringContents: boolean): string {
  let result = "";
  let quote: string | null = null;
  let index = 0;

  while (index < source.length) {
    const char = source[index] ?? "";

    if (quote !== null) {
      if (char === "\\") {
        const escaped = source[index + 1] ?? "";
        if (keepStringContents) {
          result += char + escaped;
        } else if (escaped === "\n") {
          result += "\n";
        }
        index += 2;
        continue;
      }
      if (char === quote) {
        quote = null;
        result += char;
        index += 1;
        continue;
      }
      if (keepStringContents || char === "\n") {
        result += char;
      }
      index += 1;
      continue;
    }

    if (char === "/" && source[index + 1] === "/") {
      const newline = source.indexOf("\n", index);
      if (newline === -1) break;
      index = newline;
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

/** 剥离注释，保留字符串内容（import 检测用）。 */
function stripComments(source: string): string {
  return stripSource(source, true);
}

/** 剥离注释 + 字符串内容，只留引号与换行（全局检测用）。 */
function stripStringContents(source: string): string {
  return stripSource(source, false);
}

const GLOBAL_PATTERNS = FORBIDDEN_GLOBALS.map((name) => ({
  name,
  pattern: new RegExp(`\\b${name}\\b`),
}));

/** 判定「该名字在本文件里被本地声明遮蔽」用的声明形态（保守近似，不做作用域分析）。 */
const DECLARATION_PATTERNS = FORBIDDEN_GLOBALS.map((name) => ({
  name,
  patterns: [
    new RegExp(`\\b(?:const|let|var|function|class|type|interface|enum|namespace)\\s+${name}\\b`),
    new RegExp(`\\b(?:const|let|var)\\s*\\{[^{}]*\\b${name}\\b[^{}]*\\}`),
    new RegExp(`\\b(?:const|let|var)\\s*\\[[^\\[\\]]*\\b${name}\\b[^\\[\\]]*\\]`),
  ],
}));

/** 返回本文件里被本地同名声明遮蔽的禁止全局名。 */
function locallyDeclaredNames(code: string): Set<string> {
  const shadowed = new Set<string>();
  for (const { name, patterns } of DECLARATION_PATTERNS) {
    if (patterns.some((pattern) => pattern.test(code))) shadowed.add(name);
  }
  return shadowed;
}

const IMPORT_PATTERNS: readonly RegExp[] = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']/g,
  /\bimport\s+["']([^"']+)["']/g,
  /\brequire\s*\(\s*["']([^"']+)["']/g,
];

/**
 * import 白名单：`src/core/**` 只允许相对路径（`./`、`../` 及其子路径）。
 * 裸包名、`node:` 内建、绝对路径、`@/` 别名一律违规。
 */
function isAllowedImportSource(specifier: string): boolean {
  return /^\.\.?(\/|$)/.test(specifier);
}

function lineOf(code: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < code.length; index += 1) {
    if (code[index] === "\n") line += 1;
  }
  return line;
}

function findViolations(code: string, file: string): Violation[] {
  const importText = stripComments(code);
  const globalText = stripStringContents(importText);
  const shadowed = locallyDeclaredNames(globalText);
  const violations: Violation[] = [];

  globalText.split("\n").forEach((text, index) => {
    for (const { name, pattern } of GLOBAL_PATTERNS) {
      if (shadowed.has(name)) continue;
      if (pattern.test(text)) {
        violations.push({ file, line: index + 1, kind: "dom-global", token: name });
      }
    }
  });

  for (const pattern of IMPORT_PATTERNS) {
    for (const match of importText.matchAll(pattern)) {
      const source = match[1];
      if (source !== undefined && !isAllowedImportSource(source)) {
        violations.push({
          file,
          line: lineOf(importText, match.index ?? 0),
          kind: "import-source",
          token: source,
        });
      }
    }
  }

  return violations.sort(
    (left, right) => left.line - right.line || left.token.localeCompare(right.token),
  );
}

/** 把 glob 的 key（相对本文件）转成项目根相对路径，例如 `../core/a/b.ts` → `src/core/a/b.ts`。 */
function toProjectPath(globKey: string): string {
  const normalized = globKey.replace(/\\/g, "/");
  return normalized.startsWith("../") ? `src/${normalized.slice(3)}` : normalized;
}

function describeViolation(violation: Violation): string {
  return violation.kind === "dom-global"
    ? `${violation.file}:${violation.line} 引用了 DOM/BOM 全局 ${violation.token}`
    : `${violation.file}:${violation.line} import 了非相对来源 ${violation.token}（src/core 只允许 ./ 或 ../）`;
}

/** 扫描一组源码，返回每条违规的一行描述（`文件:行号 …`）。 */
function findViolationMessages(sources: Record<string, string>): string[] {
  return Object.keys(sources)
    .sort()
    .flatMap((key) =>
      findViolations(sources[key] ?? "", toProjectPath(key)).map(describeViolation),
    );
}

describe("src/core 分层边界（闸门）", () => {
  it("src/core 下没有 .ts 时得到空集合并通过，而不是报错", () => {
    // 零匹配必须是空对象（不是 undefined、不抛错）——引擎任务开工前 `src/core/` 就是空的
    expect(Object.keys(MISSING_DIR_SOURCES)).toEqual([]);
    expect(findViolationMessages(MISSING_DIR_SOURCES)).toEqual([]);
    // 真实扫描目标必须恰好是 src/core/** 下的 .ts，扫错地方等于闸门形同虚设
    const keys = Object.keys(RAW_SOURCES);
    expect(keys.every((key) => /^\.\.\/core\/.+\.ts$/.test(key))).toBe(true);
  });

  it("src/core/** 不引用 DOM/BOM 全局，也不 import 非相对来源", () => {
    // 失败时每一行形如：src/core/xxx.ts:12 引用了 DOM/BOM 全局 document
    //               或：src/core/xxx.ts:2 import 了非相对来源 @vue/reactivity（…）
    expect(findViolationMessages(RAW_SOURCES)).toEqual([]);
  });

  it("扫描机制自检：递归通配符覆盖零层 .ts，且 ?raw 返回非空源码", () => {
    // 零层：`**` 必须能匹配「零层目录」。样本取本文件所在目录（里面一定有本文件），
    // 不绑定 src/main.ts 之类的具体文件名或内容。
    const ownKeys = Object.keys(OWN_DIR_SOURCES);
    expect(ownKeys.length).toBeGreaterThan(0);
    expect(ownKeys.every((key) => /^\.\/[^/]+\.ts$/.test(key))).toBe(true);
    expect(ownKeys.every((key) => (OWN_DIR_SOURCES[key] ?? "").length > 0)).toBe(true);

    // 递归：`**` 也必须能进子目录，且 ?raw 返回的是真实源码而不是空串
    const nestedKeys = Object.keys(SELF_CHECK_SOURCES).filter((key) =>
      /^\.\.\/[^/]+\/.+\.ts$/.test(key),
    );
    expect(nestedKeys.length).toBeGreaterThan(0);
    expect(nestedKeys.every((key) => (SELF_CHECK_SOURCES[key] ?? "").length > 0)).toBe(true);
  });
});

describe("边界扫描器自身的规则", () => {
  it("剥离注释：注释里出现 document / window 不算违规，代码里的仍被拦下", () => {
    const code = [
      "// 这里不能出现 document，也不能用 window",
      "/* document */",
      "/** window 与 new Image() 都不行 */",
      "const ok = 1;",
      "const bad = sessionStorage;",
    ].join("\n");
    const stripped = stripComments(code);

    expect(stripped).not.toContain("document");
    expect(stripped).not.toContain("window");
    expect(findViolationMessages({ "../core/probe.ts": code })).toEqual([
      "src/core/probe.ts:5 引用了 DOM/BOM 全局 sessionStorage",
    ]);
  });

  it("字符串字面量不参与全局扫描，代码里的 document 仍被拦下", () => {
    const code = [
      'const url = "https://example.com/a";',
      'throw new Error("Image 尺寸非法");',
      "const window = 3;",
      "const w = window + 1;",
      "const bad = document;",
    ].join("\n");
    const globalText = stripStringContents(stripComments(code));

    // 字符串内容被剥掉（保留引号与换行），字符串里的全局名不再参与匹配
    expect(globalText).not.toContain("Image");
    expect(globalText).not.toContain("尺寸非法");
    expect(globalText).toContain('""');
    // 第一行字符串里的 `//` 不被当成行注释（第 5 行仍然被扫到），第 5 行的 document 仍算违规
    expect(findViolationMessages({ "../core/probe.ts": code })).toEqual([
      "src/core/probe.ts:5 引用了 DOM/BOM 全局 document",
    ]);
  });

  it("本地同名声明（采样窗口 window）不误报，未声明的 window 仍算违规", () => {
    const shadowed = [
      "export const window = 3;",
      "export const w = window + 1;",
      "for (const window of [1, 2]) {",
      "  void window;",
      "}",
    ].join("\n");
    expect(findViolationMessages({ "../core/probe.ts": shadowed })).toEqual([]);

    const notShadowed = ['const w = window.innerWidth;', 'const s = "window";'].join("\n");
    expect(findViolationMessages({ "../core/probe.ts": notShadowed })).toEqual([
      "src/core/probe.ts:1 引用了 DOM/BOM 全局 window",
    ]);
  });

  it("本地声明只遮蔽本文件，另一个文件里的 window 照样报", () => {
    expect(
      findViolationMessages({
        "../core/a.ts": "const window = 3;\nexport const w = window + 1;",
        "../core/b.ts": "export const w = window.innerWidth;",
      }),
    ).toEqual(["src/core/b.ts:1 引用了 DOM/BOM 全局 window"]);
  });

  it("全词匹配：Image 不误伤 ImageData，两者各自按名字精确命中", () => {
    const code = [
      "const a: ImageData | null = null;",
      "const b = new Image();",
    ].join("\n");

    expect(findViolations(code, "probe.ts").map((v) => `${v.line}:${v.token}`)).toEqual([
      "1:ImageData",
      "2:Image",
    ]);
  });

  it("全词匹配：OffscreenCanvas 不命中 OffscreenCanvasRenderingContext2D（刻意接受的漏报）", () => {
    const code =
      "declare const ctx: OffscreenCanvasRenderingContext2D;\nconst c = new OffscreenCanvas(1, 1);";

    expect(findViolations(code, "probe.ts").map((v) => `${v.line}:${v.token}`)).toEqual([
      "2:OffscreenCanvas",
    ]);
  });

  it("自建的同前缀类型名不误报", () => {
    const code = [
      "export interface ImageMatrix { readonly width: number; }",
      "const windowSize = 3;",
      "function documentation(): void {}",
    ].join("\n");

    expect(findViolations(code, "probe.ts")).toEqual([]);
  });

  it("补充进清单的全局（fetch / Worker / XMLHttpRequest / ImageBitmap / HTMLImageElement / requestAnimationFrame）都被拦下", () => {
    const code = [
      'const a = fetch("/a");',
      'const b = new Worker("w.js");',
      "const c = new XMLHttpRequest();",
      "const d: ImageBitmap | null = null;",
      "const e: HTMLImageElement | null = null;",
      "const f = requestAnimationFrame(() => {});",
    ].join("\n");

    expect(findViolations(code, "probe.ts").map((v) => `${v.line}:${v.token}`)).toEqual([
      "1:fetch",
      "2:Worker",
      "3:XMLHttpRequest",
      "4:ImageBitmap",
      "5:HTMLImageElement",
      "6:requestAnimationFrame",
    ]);
  });

  it("import 白名单：相对路径放行，裸包名 / node: / 绝对路径 / @ 别名一律违规", () => {
    const code = [
      'import { ref } from "vue";',
      'import { effect } from "@vue/reactivity";',
      'import { invoke } from "@tauri-apps/api/core";',
      'import _ from "lodash";',
      'import { readFile } from "node:fs/promises";',
      'import util from "/abs/path";',
      'import { RGB } from "@/color/space";',
      'const router = await import("vue-router");',
      'const utils = require("vue/dist/vue.esm-bundler.js");',
      'import "./style.css";',
      'import type { RGB } from "../color/space";',
      'import { lab } from "./lab";',
    ].join("\n");

    expect(findViolations(code, "probe.ts").map((v) => `${v.line}:${v.token}`)).toEqual([
      "1:vue",
      "2:@vue/reactivity",
      "3:@tauri-apps/api/core",
      "4:lodash",
      "5:node:fs/promises",
      "6:/abs/path",
      "7:@/color/space",
      "8:vue-router",
      "9:vue/dist/vue.esm-bundler.js",
    ]);
  });

  it("白名单边界：相邻包名（vue-utils、@tauri-apps-extra）不再有任何豁免", () => {
    const allowed = [
      'import "./sibling";',
      'import "./nested/deep";',
      'import "../parent";',
      'import "../nested/deep";',
      'import type { RGB } from "../color/space";',
    ].join("\n");
    expect(findViolations(allowed, "probe.ts")).toEqual([]);

    const rejected = [
      'import "vue-utils";',
      'import "pinia-plugin";',
      'import "@tauri-apps-extra/x";',
      'import "my-vue";',
    ].join("\n");
    expect(findViolations(rejected, "probe.ts").map((v) => v.token)).toEqual([
      "vue-utils",
      "pinia-plugin",
      "@tauri-apps-extra/x",
      "my-vue",
    ]);
  });
});
