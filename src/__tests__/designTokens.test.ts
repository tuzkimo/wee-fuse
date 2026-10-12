/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import font from "../assets/fonts/fusion-pixel-12px-proportional-zh_hans.woff2?raw";
import license from "../assets/fonts/LICENSE-OFL.txt?raw";
import css from "../style.css?raw";

/**
 * 设计 token 与像素字体的**窄**闸门（规格 §6.1 / §6.2 / §6.3）：只查名字在位、字体真在仓库里。
 * 「所有 .vue 只用 token、不许 font-bold / scale() / 默认调色板」的全量扫描是任务 18 的事。
 *
 * **为什么读文本用 `?raw` 而不是 Node 的 `fs`**（计划里写的是 `readFileSync` / `statSync`）：
 * 根 `tsconfig.json` 的 `types` 只有 `["vitest/globals"]`，`src/**` 里 `import { readFileSync }
 * from "node:fs"` 会让 `vue-tsc --noEmit`（`npm run build` 的第一步）报 TS2307 「Cannot find
 * module 'node:fs'」——已实测（临时探针文件 + `npx vue-tsc --noEmit`，退出码 2）。改成
 * `?raw` 静态 import 后语义不变（拿到的是同一份源码文本），且顺带把「文件缺失」变成模块解析
 * 阶段就响亮失败。任务 18 若要沿用计划里的 `readFileSync`，会撞同一堵墙。
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
