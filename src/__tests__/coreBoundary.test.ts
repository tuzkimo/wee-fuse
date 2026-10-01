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
 * 2a. **跳过成员访问**：标识符紧邻的**前一个**非空白字符是 `.` 时不算违规（`?.` 的末位
 *    字符也是 `.`，所以 `opts?.window` 一并跳过）。`options.window`（采样窗口）是最容易
 *    踩坑的命名形态，那里它只是属性名。漏报方向：`globalThis.window`、`self.document`
 *    这类经对象间接取到的全局不再被拦下；展开运算符的末位字符同样是 `.`，所以
 *    `[...window]`、`{ ...window }` 也会被静默跳过。这些都是「前邻是 `.`」这个位置
 *    谓词强制的行为（非刻意设计），正常代码不这么写，故接受。
 * 2b. **跳过属性键与带类型标注的参数**：标识符紧邻的**后一个**非空白字符是 `:`（含
 *    `window?: number` 的 `?:`）时不算违规，覆盖 `interface ResampleOptions { window:
 *    number }`、`{ window: 3 }`、`declare function f(window: number)`、
 *    `(window: number) => …`。判定只看右侧，因此 `{ window: window.innerWidth }` 里
 *    **值位置**的 `window`（后面紧邻 `.`）仍被拦下。漏报方向：三元表达式
 *    `flag ? window : fallback` 中间的 `window` 后面紧邻 `:`，会被误当成属性键而漏掉。
 * 3. 本地同名声明视为遮蔽（shadowing）：文件里出现过 `const window = 3;`（或
 *    let / var / function / class / type / interface / enum / namespace 形态）时，该文件里的
 *    `window` 一律不再报——`const w = window + 1;` 里的 `window` 指本地绑定，不是 DOM
 *    全局，报出来就是误报。解构**只认简写绑定**：标识符紧邻前一个非空白字符是 `{`、`[`
 *    或 `,`，且紧邻后一个非空白字符是 `,`、`}`、`]` 或 `=`——`const { window } = opts;`、
 *    `const { window, a } = opts;`、`const { a, window } = opts;`、
 *    `const { window = 1 } = opts;`、`const [window] = arr;` 算同名声明；
 *    `const { window: winSize } = opts;` 绑的是 `winSize`，不算；
 *    `const { a = window } = opts;` 里的 `window` 是读取，也不算。不做作用域分析（保守
 *    近似）：只要文件里存在同名声明，整篇都不报；代价是同一文件的另一个作用域里真正引用
 *    `window` 会漏掉，方向仍是宁漏不误。
 *    已知偏差（都源于规则 3 只做**位置谓词**、不判断语法形态）：只要某个 `window` token 的
 *    前邻非空白字符是 `{`、`[`、`,` 之一，且后邻非空白字符是 `,`、`}`、`]`、`=` 之一，
 *    就当成同名声明，于是普通文本也会命中——对象字面量简写属性 `f({ window })`、类字段
 *    `class C { window = 3 }`、**实参** `fn(a, window, b)`、**数组元素**
 *    `const arr = [x, window, y]`，跨行写法 `log(\n a,\n window,\n b,\n)` 同样命中；
 *    由于遮蔽按名字对整文件生效，**一个这样的 token 就会让该文件的 `window` 闸门全线失效**
 *    （漏报）。反向地，**带类型标注**的参数在**声明位置**被规则 2b 跳过，但函数体里
 *    `return window;` 仍会被报（误报）；**无类型标注**的形参在**声明位置**规则 2b 也不跳过
 *    （它只看右侧是不是 `:`）。注意后面这半句只对「规则 2b 的谓词」成立，**不能**读成
 *    「无类型标注的形参一律被报」：尾随标点恰好落进上面 AFTER 集合的形参会反过来整篇遮蔽——
 *    `function h(a, window, b) {}` 的中间位形参后邻是 `,`、前邻也是 `,`，于是被判成同名
 *    声明、该文件 0 违规；只有尾随 `)`（前邻 `(`）的 `function f(window, b) {}` 才报 1 条。
 *    同一角色因尾随标点不同而结论相反，是最直观的自相矛盾证据：
 *    `function h(a, window) { return window + 1; }` 报 1 条（假阳性），把同一个形参挪到
 *    中间写成 `fn(a, window, b)` 却变成整文件遮蔽（漏报）——差别只在尾随的是 `)` 还是 `,`。
 * 4. `OffscreenCanvasRenderingContext2D` 目前**故意不拦截**：它几乎不可能脱离
 *    `OffscreenCanvas` 独立出现（写它基本要先写 `getContext`），届时 `OffscreenCanvas`
 *    会被拦下；换成前缀匹配则有误伤自建类型（例如 `ImageMatrix`）的风险。
 * 5. import 来源走**白名单**：`src/core/**` 里任何不以 `./` 或 `../` 开头的 module
 *    specifier 一律违规（裸包名、`node:`、绝对路径、`@/` 别名都算）。黑名单必然漏——
 *    `@vue/reactivity`、`lodash` 都能静默通过。静态 `import … from`、副作用 `import "x"`、
 *    动态 `import("x")`、`require("x")` 四种写法都识别。
 *    **与规则 7 联合阅读**：本条的扫描面只覆盖规则 7 认定的**非测试**文件，所以
 *    `__tests__` 子目录里的 `.test.ts`（例如 core 下那些文件的 `import … from "vitest"`，
 *    非相对来源）不会被本条命中，整份文件根本不进扫描。单读规则 5 会得出「闸门在拒绝计划
 *    自己的测试文件」这种与规则 7 相反的结论——两者不是矛盾，是分工：规则 5 定「什么算违规」，
 *    规则 7 定「扫谁」。
 *    白名单按「前缀是不是相对路径」判定，不看它最终解析到哪里，所以 `../../node_modules/x`
 *    这种同样是相对路径的 specifier 会被放行——闸门挡的是「第三方依赖与平台 API」，
 *    不是「解析后的物理位置」。同理，闸门只看 `src/core/**` **自身的文本**，
 *    `../services/**` 这种向上跨层的相对 import 是放行的：分层方向由 code review 与
 *    `AGENTS.md` 约束，不由这条机检约束（它管的是依赖与平台 API，不是模块方向）。
 * 6. 先剥离注释（`//`、`/* *\/`、`/** *\/`）再扫描，否则「这里不能出现 document」这类
 *    正常中文注释会误报；剥离时保留换行，行号与原文件一致。
 * 7. **测试文件不在扫描范围内**：项目根相对路径含 `/__tests__/` 路径段，或文件名以
 *    `.test.ts` / `.spec.ts` 结尾的文件**整文件跳过**（不是只放行 import）。理由是闸门
 *    守的是「要交付的 core 代码」必须零依赖、与平台无关，而 `__tests__/` 下的文件是开发期
 *    产物：计划为任务 2/3/4/5/7/8 规定的测试全部落在 `src/core/**` 的 `__tests__/` 子目录
 *    下，且必须 `import … from "vitest"`，规则 5 的相对路径白名单会命中它们——不排除就等于
 *    闸门在拒绝计划自己的文件（这是本条规则存在的唯一原因）。
 *    取舍（刻意接受，不粉饰）：排除之后，若有人在 core 的测试文件里用 DOM 全局（例如
 *    `document`），这道闸门不会拦。判定为可接受——那不影响交付代码的纯度，测试本来就跑在
 *    happy-dom 环境里，真出问题会以测试失败的形式暴露。
 *    漏报方向：目录名必须恰好是 `__tests__` 这个路径段，`my__tests__`、`__tests__backup`
 *    这类形近目录名不排除；`.test.ts` / `.spec.ts` 是后缀匹配，`x.test.util.ts` 不算测试文件。
 *
 * 已知限制（刻意接受，方向都是宁漏不误）：
 * - **不支持正则字面量**（本次不实现正则识别）。扫描器只认字符串，不区分 `/` 是除号、
 *   正则起始还是注释起始，两个方向的后果都存在，但**主效果是漏报**：遇到 `/['"]/` 这类
 *   含引号的正则时，第一遍把引号当成字符串起始，打开的是一段在本处永无闭合引号的幽灵
 *   字符串；第二遍（剥字符串内容的那份文本）便从该处起把其后内容——真实代码与注释一并
 *   ——整段剥掉，直到文件里再出现同种引号为止。于是 `/['"]/` 之后的 `document` 不再被拦
 *   （旧版本此处描述反了：误报不是主效果）。误报只在更窄的条件下才复现：被幽灵字符串吞掉
 *   的区段里恰好有一条注释含同种引号（例如 `// 别用 'document'`），使字符串状态提前闭合、
 *   其后注释文本重新进入扫描范围；第一遍（保留字符串内容的那份文本）同样是「幽灵字符串
 *   期间不剥注释」，所以注释里写成 `// 参考 from "vue"` 也会被 import 检测误报。
 *   反向地，`/[//]/` 里的 `//` 会被当成行注释，把该行后续代码整段丢弃 → 漏报。
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

/** 返回 `offset` 之前最近的非空白字符（`offset` 之前全是空白则返回 null）。 */
function previousNonWhitespace(text: string, offset: number): string | null {
  for (let index = offset - 1; index >= 0; index -= 1) {
    const char = text[index] ?? "";
    if (!/\s/.test(char)) return char;
  }
  return null;
}

/** 返回自 `offset` 起最近的非空白字符（其后再无内容则返回 null）。 */
function nextNonWhitespace(text: string, offset: number): string | null {
  const index = nextNonWhitespaceIndex(text, offset);
  return index === text.length ? null : (text[index] ?? null);
}

/** 返回自 `offset` 起第一个非空白字符的下标（找不到则返回 `text.length`）。 */
function nextNonWhitespaceIndex(text: string, offset: number): number {
  for (let index = offset; index < text.length; index += 1) {
    if (!/\s/.test(text[index] ?? "")) return index;
  }
  return text.length;
}

/**
 * 规则 2a：标识符紧邻的前一个非空白字符是 `.` → 它是属性名，不是全局引用。
 * `?.` 的末位字符同样是 `.`，所以 `opts?.window` 一并跳过。
 * 漏报方向：`globalThis.window`、`self.document` 这类经对象间接取到的全局不再被拦下。
 */
function isMemberAccess(text: string, offset: number): boolean {
  return previousNonWhitespace(text, offset) === ".";
}

/**
 * 规则 2b：标识符紧邻的后一个非空白字符是 `:`（含 `?:` 里的 `:`）→ 它是属性键或带类型
 * 标注的参数名，不是全局引用。判定只看右侧，所以 `{ window: window.innerWidth }` 里值位置
 * 的 `window`（后面紧邻 `.`）照常被拦下。
 * 漏报方向：三元表达式 `flag ? window : fallback` 中间的 `window` 后面紧邻 `:`，漏掉。
 */
function isPropertyKeyOrTypedParameter(text: string, offset: number, nameLength: number): boolean {
  const after = offset + nameLength;
  const nextIndex = nextNonWhitespaceIndex(text, after);
  const next = nextIndex === text.length ? null : (text[nextIndex] ?? null);
  if (next === ":") return true;
  if (next === "?") return nextNonWhitespace(text, nextIndex + 1) === ":";
  return false;
}

/** 规则 3 的简写绑定：前 / 后紧邻的非空白字符分别落在这两个集合内。 */
const SHORTHAND_BINDING_BEFORE: ReadonlySet<string> = new Set(["{", "[", ","]);
const SHORTHAND_BINDING_AFTER: ReadonlySet<string> = new Set([",", "}", "]", "="]);

/**
 * 规则 3：只有简写绑定才算同名声明——`{ window }`、`[window]`、`{ a, window }`、
 * `{ window = 1 }` 是；`{ window: winSize }`（改名绑定，后紧邻 `:`）与
 * `{ a = window }`（默认值，前紧邻 `=`，此处是读取）不是。
 * 漏报方向：对象字面量简写属性 `f({ window })`、类字段 `class C { window = 3 }`
 * 都与解构简写同形，会被当成声明。
 */
function isShorthandBinding(text: string, offset: number, nameLength: number): boolean {
  const before = previousNonWhitespace(text, offset);
  if (before === null || !SHORTHAND_BINDING_BEFORE.has(before)) return false;
  const after = nextNonWhitespace(text, offset + nameLength);
  return after !== null && SHORTHAND_BINDING_AFTER.has(after);
}

const GLOBAL_PATTERNS = FORBIDDEN_GLOBALS.map((name) => ({
  name,
  pattern: new RegExp(`\\b${name}\\b`, "g"),
}));

/** 直接声明形态（`const window = …`、`interface window` 等）的判定正则。 */
const DECLARATION_PATTERNS = FORBIDDEN_GLOBALS.map((name) => ({
  name,
  pattern: new RegExp(
    `\\b(?:const|let|var|function|class|type|interface|enum|namespace)\\s+${name}\\b`,
  ),
}));

/** 返回本文件里被本地同名声明遮蔽的禁止全局名。 */
function locallyDeclaredNames(code: string): Set<string> {
  const shadowed = new Set<string>();
  for (const { name, pattern } of DECLARATION_PATTERNS) {
    if (pattern.test(code)) {
      shadowed.add(name);
      continue;
    }
    for (const match of code.matchAll(new RegExp(`\\b${name}\\b`, "g"))) {
      if (isShorthandBinding(code, match.index ?? 0, name.length)) {
        shadowed.add(name);
        break;
      }
    }
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
  /** 同一行同一个名字只报一次，与旧版「按行匹配」的粒度保持一致。 */
  const reported = new Set<string>();

  for (const { name, pattern } of GLOBAL_PATTERNS) {
    if (shadowed.has(name)) continue;
    for (const match of globalText.matchAll(pattern)) {
      const offset = match.index ?? 0;
      if (isMemberAccess(globalText, offset)) continue;
      if (isPropertyKeyOrTypedParameter(globalText, offset, name.length)) continue;
      const line = lineOf(globalText, offset);
      const key = `${line}:${name}`;
      if (reported.has(key)) continue;
      reported.add(key);
      violations.push({ file, line, kind: "dom-global", token: name });
    }
  }

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

/**
 * 规则 7：测试文件不参与扫描——项目根相对路径含 `/__tests__/` 路径段，或文件名以
 * `.test.ts` / `.spec.ts` 结尾。闸门守的是「要交付的 core 代码」，而计划规定的 core 测试
 * 全部位于 `src/core/**` 的 `__tests__/` 子目录且必须 import `vitest`（规则 5 会判它违规）。
 * 是整文件从扫描集合里剔除，不是只放行 import。
 */
function isTestFile(projectPath: string): boolean {
  const fileName = projectPath.slice(projectPath.lastIndexOf("/") + 1);
  return projectPath.includes("/__tests__/") || /\.(?:test|spec)\.ts$/.test(fileName);
}

function describeViolation(violation: Violation): string {
  return violation.kind === "dom-global"
    ? `${violation.file}:${violation.line} 引用了 DOM/BOM 全局 ${violation.token}`
    : `${violation.file}:${violation.line} import 了非相对来源 ${violation.token}（src/core 只允许 ./ 或 ../）`;
}

/** 扫描一组源码，返回每条违规的一行描述（`文件:行号 …`）；测试文件按规则 7 剔除。 */
function findViolationMessages(sources: Record<string, string>): string[] {
  return Object.keys(sources)
    .sort()
    .flatMap((key) => {
      const file = toProjectPath(key);
      if (isTestFile(file)) return [];
      return findViolations(sources[key] ?? "", file).map(describeViolation);
    });
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

  it("规则 2a：成员访问形态不算引用（options.window / opts?.window），真正的 window 仍被拦下", () => {
    const memberAccess = [
      "const a = options.window;",
      "const b = options?.window;",
      "const c = options.sample.window;",
    ].join("\n");
    expect(findViolationMessages({ "../core/probe.ts": memberAccess })).toEqual([]);

    const realGlobals = [
      "const d = window.location;",
      "const e = window;",
      'const f = window["a"];',
      "const g = window?.title;",
      "const h = document.title;",
    ].join("\n");
    expect(findViolationMessages({ "../core/probe.ts": realGlobals })).toEqual([
      "src/core/probe.ts:1 引用了 DOM/BOM 全局 window",
      "src/core/probe.ts:2 引用了 DOM/BOM 全局 window",
      "src/core/probe.ts:3 引用了 DOM/BOM 全局 window",
      "src/core/probe.ts:4 引用了 DOM/BOM 全局 window",
      "src/core/probe.ts:5 引用了 DOM/BOM 全局 document",
    ]);
  });

  it("规则 2b：属性键与带类型标注的形参不算引用，值位置的 window 仍被拦下", () => {
    const keysAndParameters = [
      "interface ResampleOptions { window: number }",
      "const o = { window: 3 };",
      "declare function f(window: number): void;",
      "declare function g(window?: number): void;",
      "const h = (window: number): number => 0;",
    ].join("\n");
    expect(findViolationMessages({ "../core/probe.ts": keysAndParameters })).toEqual([]);

    // 值位置的 window 后面紧邻 `.`（不是 `:`），必须照样报
    const valuePosition = "const c = { window: window.innerWidth };";
    expect(findViolationMessages({ "../core/probe.ts": valuePosition })).toEqual([
      "src/core/probe.ts:1 引用了 DOM/BOM 全局 window",
    ]);
  });

  /** 解构声明后跟一行真实 `window` 使用：被遮蔽则无违规，未遮蔽则第 2 行报错。 */
  const destructuredThenUsed = (declaration: string): string[] =>
    findViolationMessages({
      "../core/probe.ts": `${declaration}\nexport const z = window.innerWidth;`,
    });

  it("规则 3：const { window } = opts;（后紧邻 }）算同名声明", () => {
    expect(destructuredThenUsed("const { window } = opts;")).toEqual([]);
  });

  it("规则 3：const { window, a } = opts;（后紧邻 ,）算同名声明", () => {
    expect(destructuredThenUsed("const { window, a } = opts;")).toEqual([]);
  });

  it("规则 3：const { a, window } = opts;（前紧邻 ,）算同名声明", () => {
    expect(destructuredThenUsed("const { a, window } = opts;")).toEqual([]);
  });

  it("规则 3：const { window = 1 } = opts;（后紧邻 =）算同名声明", () => {
    expect(destructuredThenUsed("const { window = 1 } = opts;")).toEqual([]);
  });

  it("规则 3：const [window] = arr;（前 [ 后 ]）算同名声明", () => {
    expect(destructuredThenUsed("const [window] = arr;")).toEqual([]);
  });

  it("规则 3：const { window: winSize } = opts; 绑的是 winSize，不遮蔽真正的 window", () => {
    expect(destructuredThenUsed("const { window: winSize } = opts;")).toEqual([
      "src/core/probe.ts:2 引用了 DOM/BOM 全局 window",
    ]);
  });

  it("规则 3：const { a = window } = opts; 里的 window 是读取，不遮蔽", () => {
    expect(destructuredThenUsed("const { a = window } = opts;")).toEqual([
      "src/core/probe.ts:1 引用了 DOM/BOM 全局 window",
      "src/core/probe.ts:2 引用了 DOM/BOM 全局 window",
    ]);
  });

  it("已知漏报（刻意接受）：位置谓词让普通实参 / 数组元素也触发整篇遮蔽", () => {
    // 前邻是 `,`、后邻也是 `,` —— 与解构简写同形，于是整文件的 window 闸门失效。
    const callArgument = ["fn(a, window, b);", "export const z = window.location;"].join("\n");
    expect(findViolationMessages({ "../core/probe.ts": callArgument })).toEqual([]);

    const arrayElement = [
      "const arr = [x, window, y];",
      "export const z = window.location;",
    ].join("\n");
    expect(findViolationMessages({ "../core/probe.ts": arrayElement })).toEqual([]);

    const multiLineCall = [
      "log(",
      "  a,",
      "  window,",
      "  b,",
      ");",
      "export const z = window.location;",
    ].join("\n");
    expect(findViolationMessages({ "../core/probe.ts": multiLineCall })).toEqual([]);
  });

  it("已知误报（刻意接受）：尾随 `)` 的形参不触发遮蔽，函数体内的引用被报", () => {
    // 与上一条同根因：`window` 后邻是 `)`（不在 {`,`、`}`、`]`、`=`} 内）→ 不算声明，
    // 函数体里的 `window` 于是被当成 DOM 全局。同一个形参挪到中间就反过来触发整篇遮蔽。
    const code = "function h(a, window) { return window + 1; }";
    expect(findViolationMessages({ "../core/probe.ts": code })).toEqual([
      "src/core/probe.ts:1 引用了 DOM/BOM 全局 window",
    ]);
  });

  it("已知漏报（刻意接受）：含引号的正则字面量会把其后代码整段剥掉", () => {
    const code = ["const re = /['\"]/;", "const bad = document.title;"].join("\n");

    // 幽灵字符串从 `/['"]/` 的引号开始吞掉其后所有内容，第 2 行的 document 静默漏报。
    // 这是文件头「已知限制」里描述的真实后果，本任务不实现正则识别。
    expect(findViolationMessages({ "../core/probe.ts": code })).toEqual([]);
  });

  it("已知误报（刻意接受）：幽灵字符串被注释里的同种引号提前闭合时，注释文本重新入扫描范围", () => {
    const code = ["const re = /['\"]/;", "// 别用 'document'", "const a = 1;"].join("\n");

    // 误报只在「被吞掉的区段里恰好有一条含同种引号的注释」这个窄条件下复现：
    // 注释里那个 `'` 提前闭合幽灵字符串，其后的 `document` 于是重新参与匹配。
    expect(findViolationMessages({ "../core/probe.ts": code })).toEqual([
      "src/core/probe.ts:2 引用了 DOM/BOM 全局 document",
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
      // 文件头第 5 条点名的例子：同样是相对路径，会被放行（闸门挡的是依赖与平台 API，
      // 不是「解析后的物理位置」）——写成断言，防止后人误以为这里被拦下。
      'import "../../node_modules/x";',
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

  it("规则 7：core 的 __tests__ 文件不在扫描范围内（import vitest、用 document 都不报）", () => {
    const code = [
      'import { describe, expect, it } from "vitest";',
      "const title = document.title;",
    ].join("\n");

    // 计划为任务 2/3/4/5/7/8 规定的测试都放在 src/core/**/__tests__/ 下，且必须
    // import 测试框架；闸门若扫它们，就会拒绝计划自己的文件。
    expect(findViolationMessages({ "../core/color/__tests__/space.test.ts": code })).toEqual([]);
    // 文件名形态同样排除：`.test.ts` / `.spec.ts` 不必待在 `__tests__` 目录里
    expect(findViolationMessages({ "../core/color/space.spec.ts": code })).toEqual([]);
    // `__tests__` 目录下的任意层、任意文件名的文件都排除（测试辅助模块也常在里边）
    expect(
      findViolationMessages({ "../core/color/__tests__/helpers/load.ts": code }),
    ).toEqual([]);
  });

  it("规则 7 不是整层放行：同内容的非测试文件照样两条都报", () => {
    const code = [
      'import { describe, expect, it } from "vitest";',
      "const title = document.title;",
    ].join("\n");

    expect(findViolationMessages({ "../core/color/space.ts": code })).toEqual([
      "src/core/color/space.ts:1 import 了非相对来源 vitest（src/core 只允许 ./ 或 ../）",
      "src/core/color/space.ts:2 引用了 DOM/BOM 全局 document",
    ]);
  });

  it("规则 7 的排除按完整路径段与后缀匹配，形近名字不被误排除", () => {
    const code = "const title = document.title;";

    // `my__tests__` 里的 `__tests__` 前面不是 `/`，不是 `__tests__` 路径段
    expect(findViolationMessages({ "../core/my__tests__/x.ts": code })).toEqual([
      "src/core/my__tests__/x.ts:1 引用了 DOM/BOM 全局 document",
    ]);
    // `__tests__backup` 同理，是另一个目录名
    expect(findViolationMessages({ "../core/__tests__backup/x.ts": code })).toEqual([
      "src/core/__tests__backup/x.ts:1 引用了 DOM/BOM 全局 document",
    ]);
    // `.test.ts` / `.spec.ts` 是后缀，`x.test.util.ts` 不是测试文件
    expect(findViolationMessages({ "../core/x.test.util.ts": code })).toEqual([
      "src/core/x.test.util.ts:1 引用了 DOM/BOM 全局 document",
    ]);
  });
});
