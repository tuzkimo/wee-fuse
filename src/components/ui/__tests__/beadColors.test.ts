/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import { GRID_ON_DARK, LABEL_ON_DARK } from "@/components/ui/beadColors";
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
  it("GRID_ON_DARK / LABEL_ON_DARK 与 style.css 的同名 token 逐字一致", () => {
    expect(css).toContain(`--color-bead-grid: ${GRID_ON_DARK}`);
    expect(css).toContain(`--color-bead-label-on-dark: ${LABEL_ON_DARK}`);
  });

  it("格内色号不是 ink（#3D3226 在深色底上看不见）", () => {
    expect(LABEL_ON_DARK.toLowerCase()).not.toBe("#3d3226");
  });
});
