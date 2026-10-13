/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { FRAME_ON_DARK, GRID_ON_DARK, LABEL_ON_DARK, LABEL_ON_LIGHT, PAPER_ON_DARK } from "@/components/ui/beadColors";
import { TILE_PAPER } from "@/core/render/sheet";
import css from "../../../style.css?raw";

/**
 * 画布绘制用的 JS 颜色常量与 `@theme` token 的**同源闸门**（§9 / Review Focus 3）：
 * Canvas 2D 不解析 `var()`，所以这两个值只能以字面量写进 `beadColors.ts`；本用例挡住
 * 「改了 CSS token、忘了改 JS 常量」（或反过来）这种静默漂移。
 *
 * **为什么读文本用 `?raw` 而不是 Node 的 `fs`**：根 `tsconfig.json` 的 `types` 只有
 * `["vitest/globals"]`，`src/**` 里 import `node:fs` 会让 `vue-tsc --noEmit`（`npm run build`
 * 的第一步）报 TS2307。与 `src/__tests__/designTokens.test.ts` 同一口径。
 */
describe("深色底画布颜色常量（§9 / Review Focus 3）", () => {
  it("GRID_ON_DARK / LABEL_ON_DARK / LABEL_ON_LIGHT 与 style.css 的同名 token 逐字一致", () => {
    expect(css).toContain(`--color-bead-grid: ${GRID_ON_DARK}`);
    expect(css).toContain(`--color-bead-label-on-dark: ${LABEL_ON_DARK}`);
    // 浅豆上的色号借的是 ink——它本就是设计系统里「浅底上的字」那一档。
    expect(css).toContain(`--color-bead-ink: ${LABEL_ON_LIGHT}`);
  });

  it("格内色号不是 ink（#3D3226 在深色底上看不见）", () => {
    expect(LABEL_ON_DARK.toLowerCase()).not.toBe("#3d3226");
  });

  it("FRAME_ON_DARK（图纸外框）与 --color-bead-line 同源", () => {
    // 外框借的是「容器外框」那一档（§6.1 的更正注记 / R57）：没有同名 token，同源对象是 bead-line。
    expect(css).toContain(`--color-bead-line: ${FRAME_ON_DARK}`);
  });

  it("PAPER_ON_DARK（图纸纸底）与 --color-bead-card 同源", () => {
    // 纸底借的是设计系统里「纸」那一档（§5.4）：没有同名 token，同源对象是 bead-card。
    expect(css).toContain(`--color-bead-card: ${PAPER_ON_DARK}`);
  });

  it("网格块预览的纸底与编辑页的纸底同色（两处都在深色板底上，空格不能一个是纸、一个是黑格）", () => {
    // `TILE_PAPER` 住在 core（core 不得 import 组件），两张纸的同源关系只能在这里钉：
    // 改了 `PAPER_ON_DARK` / `--color-bead-card` 而没改 `TILE_PAPER`（或反过来）时这条红。
    expect(TILE_PAPER).toBe(PAPER_ON_DARK);
  });
});
