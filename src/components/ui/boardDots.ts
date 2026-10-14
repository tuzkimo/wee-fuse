/**
 * 深色拼豆板的**板孔点阵**（`radial-gradient` + 22px 间距）。
 *
 * 设计规格里四处（`PatternCanvas` 画布、`SetupPage` 中栏、`ResultPanel` 上半屏、`SheetViewer`
 * 主体）要求的是**同一个不变式**，所以取值只有这一份：此前四个组件各写了一份逐字相同的
 * `{ backgroundImage, backgroundSize }`，改间距要动四处、漏一处就是四个「看图底」长得不一样。
 *
 * 消费方式：`import { BOARD_DOTS as boardDots } from "@/components/ui/boardDots"` —— 组件里
 * 保留原名，模板的 `:style="boardDots"` 一行都不用改。
 */
export const BOARD_DOTS = {
  backgroundImage: "radial-gradient(var(--color-bead-hole) 2px, transparent 2px)",
  backgroundSize: "22px 22px",
} as const;
