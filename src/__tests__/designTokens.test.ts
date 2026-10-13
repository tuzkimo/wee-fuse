/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import font from "../assets/fonts/fusion-pixel-12px-proportional-zh_hans.woff2?raw";
import license from "../assets/fonts/LICENSE-OFL.txt?raw";
import css from "../style.css?raw";

/**
 * 设计 token 与像素字体的**唯一**闸门：既查 `src/style.css` 里 token 名与值逐字在位，
 * 也全量扫 `src/**\/*.vue`，不许设计语言漂回 Tailwind 默认调色板 / 默认字号 / 粗体 / scale()。
 * 规格 §10 的边界与 §11 的测试要求。除了下面这三个 DEV-only 探针页，**没有别的例外**。
 *
 * **为什么读文本用 `?raw` 而不是 Node 的 `fs`**（计划里写的是 `readFileSync` / `statSync`）：
 * 根 `tsconfig.json` 的 `types` 只有 `["vitest/globals"]`，`src/**` 里 `import { readFileSync }
 * from "node:fs"` 会让 `vue-tsc --noEmit`（`npm run build` 的第一步）报 TS2307 「Cannot find
 * module 'node:fs'」——已实测（临时探针文件 + `npx vue-tsc --noEmit`，退出码 2）。改成
 * `?raw` 静态 import 后语义不变（拿到的是同一份源码文本），且顺带把「文件缺失」变成模块解析
 * 阶段就响亮失败。文件级 `/// <reference types="node" />` 也不行：它不是文件私有的，会把
 * @types/node 的全局声明（`process`、`Buffer`…）拉进整个 `vue-tsc` 程序，悄悄削弱
 * `tsconfig.json` 里 `types: ["vitest/globals"]` 那道闸门（`coreBoundary.test.ts` 记了实测过程）。
 * `vite/client` 只声明 `import.meta.glob` / `import.meta.env`，不涉及任何 Node 全局。
 */
describe("设计 token（§6.1 / §6.3）", () => {
  it("§6.1 的 20 个 bead 调色 token + 任务 13 补的 label-on-dark 逐字在位", () => {
    for (const name of [
      "bead-sand",
      "bead-sand-2",
      "bead-sand-3",
      "bead-card",
      "bead-ink",
      "bead-line",
      "bead-line-2",
      "bead-accent",
      "bead-accent-dark",
      "bead-warm",
      "bead-warm-dark",
      "bead-go",
      "bead-go-dark",
      "bead-card-shadow",
      "bead-board",
      "bead-hole",
      "bead-grid",
      "bead-label-on-dark",
      "bead-danger",
      "bead-warn-bg",
      "bead-warn-ink",
    ]) {
      expect(css).toContain(`--color-${name}:`);
    }
  });

  it("投影 token 走 --shadow-* namespace（v4 只在这个前缀下生成工具类）", () => {
    expect(css).toMatch(/--shadow-pop-sm:/);
    expect(css).toMatch(/--shadow-pop-md:/);
    expect(css).toMatch(/--shadow-pop-lg:/);
    expect(css).not.toMatch(/--pop-(sm|md|lg):/);
  });
});

describe("像素字体（§6.2）", () => {
  it("字体文件与许可证都在仓库里且不是空文件", () => {
    // `?raw` 会把二进制按 utf-8 解码，长度与字节数不严格相等（阈值差着 6 倍，够用）；
    // 再认 woff2 的魔数 `wOF2`，挡住「落了个 HTML 错误页 / LFS 指针」这类非字体文件。
    expect(font.length).toBeGreaterThan(100_000);
    expect(font.startsWith("wOF2")).toBe(true);
    expect(license).toContain("SIL OPEN FONT LICENSE");
  });
});

/* ------------------------------------------------------------------------------------------------
 * 全量扫描守卫（§10 / §11）：唯一能防「新页面又写歪」的机制。
 * ---------------------------------------------------------------------------------------------- */

/** glob 的 key 相对本文件所在目录（`src/__tests__/`），`../` 换算回仓库根的 `src/`。 */
const VUE_SOURCES: Record<string, string> = import.meta.glob<string>("../**/*.vue", {
  eager: true,
  query: "?raw",
  import: "default",
});

/**
 * 唯一的排除名单：三个 DEV-only 探针页（`/lab/canvas`、`/lab/decode`、`/lab/shell`）。
 * 规格 §5 明确本次不改它们，而它们实打实在用 `slate-*` / `amber-*` / `text-sm` / `font-bold`，
 * 按字面扫这条守卫必然红。它们是开发调试工具，不是产品界面，不参与设计语言。
 */
const DEV_PROBE_PAGES = /^src\/views\/(CanvasLabPage|DecodeLabPage|ShellProbePage)\.vue$/;

const MIGRATED = Object.entries(VUE_SOURCES)
  .map(([key, source]) => ({ file: `src/${key.slice(3)}`, source }))
  .filter(({ file }) => !DEV_PROBE_PAGES.test(file));

/**
 * `bead-board`（看图的深色衬底）只允许出现在五个文件：
 * PatternCanvas / ResultPanel / SheetViewer / SetupPage 的预览区（§10.6），
 * 外加 **LibraryPage**——它的卡片缩略图就是一张「看图」表面，规格 §7.1 逐字要求。
 */
const BOARD_ALLOWED =
  /(PatternCanvas|ResultPanel|SheetViewer|SetupPage|LibraryPage)\.vue$/;

/** 取出 `<style>` 块的内容；`scale(` 只在这个作用域里判（见 (c) 的注释）。 */
function styleBlocks(source: string): string[] {
  return [...source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1] ?? "");
}

describe("设计语言全量守卫（§10 / §11）", () => {
  it("扫描机制自检：真的读到了 .vue，且排除名单恰好是那三个探针页", () => {
    // 没有这条，glob 写错（零匹配）会让下面每一条都「空转绿」——守卫形同不存在。
    expect(MIGRATED.length).toBeGreaterThan(0);
    const excluded = Object.keys(VUE_SOURCES).filter((key) =>
      DEV_PROBE_PAGES.test(`src/${key.slice(3)}`),
    );
    expect(excluded.map((key) => key.replace(/^\.\.\//, ""))).toEqual([
      "views/CanvasLabPage.vue",
      "views/DecodeLabPage.vue",
      "views/ShellProbePage.vue",
    ]);
  });

  it("(a) 不许再用 Tailwind 默认调色板（含 white / black）", () => {
    for (const { file, source } of MIGRATED) {
      expect(source, file).not.toMatch(/-(slate|gray|zinc|amber|red|blue|green)-\d/);
      expect(source, file).not.toMatch(/\b(bg|text|border)-white\b/);
      expect(source, file).not.toMatch(/\b(bg|text|border)-black\b/);
    }
  });

  it("(b) 不许用 font-weight（像素字体没有真粗体），也不许换成别的字体族", () => {
    for (const { file, source } of MIGRATED) {
      // 多带一个 `mono`：`font-mono` 会把整块文字踢出像素字体（不是粗体，但同样让字形糊掉）。
      expect(source, file).not.toMatch(
        /\bfont-(thin|extralight|light|medium|semibold|bold|extrabold|black|mono)\b/,
      );
    }
  });

  it("(c) 不许 transform: scale（会破坏像素字体的整数倍栅格）", () => {
    for (const { file, source } of MIGRATED) {
      // 只扫 `<style>` 块（规格 §10.5 的措辞）：`SheetViewer.vue` 的 `<script>` 里那处
      // `scale(${view.scale / sheetPlan.cellPx})` 是修复轮留下的合法写法，不能连它一起判红。
      for (const block of styleBlocks(source)) {
        expect(block, file).not.toMatch(/\bscale\(/);
      }
      // 另一条独立的路：Tailwind 的 `scale-<n>` / `scale-x-<n>` 工具类。
      expect(source, file).not.toMatch(/\bscale-(x-|y-)?\d/);
    }
  });

  it("(d) 描边只有 4px 与 3px（§6.4）", () => {
    for (const { file, source } of MIGRATED) {
      expect(source, file).not.toMatch(/[12]px solid/);
      // 侧边变体（`border-t-2`）同样算 2px 描边，一并拦下。
      expect(source, file).not.toMatch(/\bborder(-[xytrbl])?-(1|2)\b/);
    }
  });

  it("(e) 深色底 bead-board 只出现在 §10.6 的四处 + 图纸库缩略图（§7.1）", () => {
    for (const { file, source } of MIGRATED) {
      if (BOARD_ALLOWED.test(file)) continue;
      expect(source, file).not.toContain("bead-board");
    }
  });

  it("(f) 字号只有 12 / 24 / 36（不许 Tailwind 默认字号类）", () => {
    for (const { file, source } of MIGRATED) {
      // Tailwind 的 text-xs/sm/… 会给出非 12 倍数的字号，一概不许。
      expect(source, file).not.toMatch(/\btext-(xs|sm|base|lg|xl|2xl|3xl|4xl|5xl)\b/);
    }
  });

  it("(g) 任意字号 text-[Npx] 的 N 必须是 12 的倍数（§6.2；写错不是编译错误）", () => {
    for (const { file, source } of MIGRATED) {
      for (const match of source.matchAll(/text-\[(\d+)px\]/g)) {
        expect(Number(match[1]) % 12, `${file}: ${match[0]}`).toBe(0);
      }
    }
  });
});

describe("style.css 基样式逐字在位（§6.1 / §6.2 / §6.3）", () => {
  /**
   * §6.1 表的 20 行，逐字抄写（含任务 13 补的 `--color-bead-label-on-dark`）。
   * 这份表是**值的唯一真源**：改 token 必须先改规格 §6.1，再改这里，最后改 `style.css`。
   */
  const BEAD_HEX: Record<string, string> = {
    sand: "#F5EDDF",
    "sand-2": "#EFE4D0",
    "sand-3": "#E9DFC9",
    card: "#FFF9EE",
    ink: "#3D3226",
    line: "#C9B79A",
    "line-2": "#B9A585",
    accent: "#E4572E",
    "accent-dark": "#A83A18",
    warm: "#FFB56B",
    "warm-dark": "#C98A4A",
    go: "#17A398",
    "go-dark": "#0E6E66",
    "card-shadow": "#D8C9AC",
    board: "#332B26",
    hole: "#463A32",
    grid: "#4A4038",
    "label-on-dark": "#FFF4E4",
    danger: "#B3392B",
    "warn-bg": "#FCEBC8",
    "warn-ink": "#8A5A1A",
  };

  it("(h1) 每个 --color-bead-* 的值都与 §6.1 表逐字一致，且没有表外的私加 token", () => {
    const actual = new Map<string, string>();
    for (const match of css.matchAll(/--color-bead-([a-z0-9-]+):\s*([^;]+);/g)) {
      actual.set(match[1]!, match[2]!.trim().toUpperCase());
    }
    // token 集合也要相等：新加一个 token 就必须先落进 §6.1 的表里（先改文档再改实践）。
    expect([...actual.keys()].sort()).toEqual(Object.keys(BEAD_HEX).sort());
    for (const [name, hex] of Object.entries(BEAD_HEX)) {
      expect(actual.get(name), `--color-bead-${name}`).toBe(hex);
    }
  });

  it("(h2) 六条「少一条就糊」的全局基样式都在（§6.2）", () => {
    for (const declaration of [
      "font-family: var(--font-pixel)",
      "font-weight: normal",
      "letter-spacing: normal",
      "-webkit-font-smoothing: none",
      "font-smooth: never",
      "text-rendering: geometricPrecision",
    ]) {
      expect(css, declaration).toContain(declaration);
    }
  });

  it("(h3) 三档 --shadow-pop-* 都是零模糊（§6.3）", () => {
    for (const tier of ["sm", "md", "lg"]) {
      expect(css, `--shadow-pop-${tier}`).toMatch(
        new RegExp(`--shadow-pop-${tier}:\\s*0 \\d+px 0 `),
      );
    }
  });
});
