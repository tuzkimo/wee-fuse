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
 * 1. 所有 DOM/BOM 全局标识符一律**全词匹配**（`/\b名字\b/`）。因此 `Image` 不会命中
 *    `ImageData`，`OffscreenCanvas` 不会命中 `OffscreenCanvasRenderingContext2D`。
 *    两个名字是彼此独立的标识符，`ImageData` 已单独列入清单。
 * 2. `OffscreenCanvasRenderingContext2D` 目前**故意不拦截**：它几乎不可能脱离
 *    `OffscreenCanvas` 独立出现（写它基本要先写 `getContext`），届时 `OffscreenCanvas`
 *    会被拦下；换成前缀匹配则有误伤自建类型（例如 `ImageMatrix`）的风险。
 * 3. import 来源：`vue` / `vue-router` / `pinia` 精确匹配（含其子路径），
 *    `@tauri-apps/` 前缀匹配（覆盖 `@tauri-apps/api`、`@tauri-apps/plugin-fs` 等）。
 * 4. 先剥离注释（`//`、`/* *\/`、`/** *\/`）再扫描，否则「这里不能出现 document」这类
 *    正常中文注释会误报；剥离时保留换行，行号与原文件一致。
 */
import { describe, expect, it } from "vitest";

/** 禁止在 `src/core/**` 出现的 DOM/BOM 全局标识符。 */
const FORBIDDEN_GLOBALS: readonly string[] = [
  "document",
  "window",
  "navigator",
  "localStorage",
  "sessionStorage",
  "createImageBitmap",
  "OffscreenCanvas",
  "Image",
  "ImageData",
  "HTMLCanvasElement",
  "CanvasRenderingContext2D",
];

/** 禁止在 `src/core/**` 出现的 import 来源。 */
const FORBIDDEN_IMPORT_SOURCES: readonly string[] = [
  "vue",
  "vue-router",
  "pinia",
  "@tauri-apps/",
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
 * `src/main.ts` 这种零层文件、以及 `src/router/index.ts` 这种子目录文件，用 `../` 起头。
 */
const SELF_CHECK_SOURCES: Record<string, string> = import.meta.glob<string>("../**/*.ts", {
  eager: true,
  query: "?raw",
  import: "default",
});

/**
 * 剥离注释，保留换行以便行号对齐。字符串字面量原样保留（不解析其内容），
 * 单双引号与反引号内的 `//`、`/*` 不会被误判为注释。
 */
function stripComments(source: string): string {
  let result = "";
  let quote: string | null = null;
  let index = 0;

  while (index < source.length) {
    const char = source[index];

    if (quote !== null) {
      result += char;
      if (char === "\\") {
        result += source[index + 1] ?? "";
        index += 2;
        continue;
      }
      if (char === quote) {
        quote = null;
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

const GLOBAL_PATTERNS = FORBIDDEN_GLOBALS.map((name) => ({
  name,
  pattern: new RegExp(`\\b${name}\\b`),
}));

const IMPORT_PATTERNS: readonly RegExp[] = [
  /\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']/g,
  /\bimport\s+["']([^"']+)["']/g,
  /\brequire\s*\(\s*["']([^"']+)["']/g,
];

function isForbiddenImportSource(source: string): boolean {
  return FORBIDDEN_IMPORT_SOURCES.some((banned) => {
    const prefix = banned.endsWith("/") ? banned.slice(0, -1) : banned;
    return source === prefix || source.startsWith(`${prefix}/`);
  });
}

function lineOf(code: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < code.length; index += 1) {
    if (code[index] === "\n") line += 1;
  }
  return line;
}

function findViolations(code: string, file: string): Violation[] {
  const stripped = stripComments(code);
  const violations: Violation[] = [];

  stripped.split("\n").forEach((text, index) => {
    for (const { name, pattern } of GLOBAL_PATTERNS) {
      if (pattern.test(text)) {
        violations.push({ file, line: index + 1, kind: "dom-global", token: name });
      }
    }
  });

  for (const pattern of IMPORT_PATTERNS) {
    for (const match of stripped.matchAll(pattern)) {
      const source = match[1];
      if (source !== undefined && isForbiddenImportSource(source)) {
        violations.push({
          file,
          line: lineOf(stripped, match.index ?? 0),
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
    : `${violation.file}:${violation.line} import 了禁止的来源 ${violation.token}`;
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
  it("src/core 不存在或里面没有 .ts 文件时通过，而不是报错", () => {
    expect(findViolationMessages({})).toEqual([]);
  });

  it("src/core/** 不引用 DOM/BOM 全局，也不 import Vue/Tauri 生态", () => {
    // 失败时每一行形如：src/core/xxx.ts:12 引用了 DOM/BOM 全局 document
    expect(findViolationMessages(RAW_SOURCES)).toEqual([]);
  });

  it("扫描机制自检：递归通配符覆盖零层子目录，且 ?raw 返回真实源码", () => {
    // `**` 必须能匹配零层目录，否则 `src/core/xxx.ts` 这种顶层文件会被整片漏扫
    expect(SELF_CHECK_SOURCES["../main.ts"] ?? "").toContain("createApp");
    // `**` 也必须递归进子目录
    expect(Object.keys(SELF_CHECK_SOURCES).map(toProjectPath)).toContain(
      "src/router/index.ts",
    );
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

  it("识别被禁止的 import 来源，含 @tauri-apps 子路径与动态 import", () => {
    const code = [
      'import { ref } from "vue";',
      'import { invoke } from "@tauri-apps/api/core";',
      'import "./side-effect";',
      'import { createPinia } from "pinia";',
      'const router = await import("vue-router");',
      'const utils = require("vue/dist/vue.esm-bundler.js");',
    ].join("\n");

    expect(findViolations(code, "probe.ts").map((v) => `${v.line}:${v.token}`)).toEqual([
      "1:vue",
      "2:@tauri-apps/api/core",
      "4:pinia",
      "5:vue-router",
      "6:vue/dist/vue.esm-bundler.js",
    ]);
  });

  it("相邻但不相同的包名不误报", () => {
    const code = [
      'import "vue-utils";',
      'import "pinia-plugin";',
      'import "@tauri-apps-extra/x";',
      'import "my-vue";',
    ].join("\n");

    expect(findViolations(code, "probe.ts")).toEqual([]);
  });

  it("字符串里的 // 不被当成行注释，其后的代码仍然被扫描", () => {
    const code = [
      'const url = "https://example.com/a";',
      "const bad = localStorage;",
    ].join("\n");

    expect(findViolationMessages({ "../core/probe.ts": code })).toEqual([
      "src/core/probe.ts:2 引用了 DOM/BOM 全局 localStorage",
    ]);
  });
});
