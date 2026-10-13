/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { FRAME_ON_DARK, GRID_ON_DARK, LABEL_ON_DARK, LABEL_ON_LIGHT } from "@/components/ui/beadColors";
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
});
