<script lang="ts">
export type BeadVariant = "primary" | "secondary" | "icon" | "danger" | "go";
</script>

<script setup lang="ts">
import { computed, useSlots } from "vue";

const props = withDefaults(
  defineProps<{ variant?: BeadVariant; ariaLabel?: string; disabled?: boolean }>(),
  { variant: "primary", disabled: false },
);

const slots = useSlots();

/*
 * 变体的类名与投影色（§6.3）：硬投影必须有颜色，`--bead-pop` 是本组件唯一本地设的变量。
 * 字色成对取：亮底（accent/go）配 card 色字，card 底配 ink 色字。
 */
const VARIANTS: Record<BeadVariant, { classes: string; pop: string }> = {
  primary: {
    classes: "bg-bead-accent text-bead-card rounded-bead-md shadow-pop-md px-6 text-2xl",
    pop: "var(--color-bead-accent-dark)",
  },
  secondary: {
    classes: "bg-bead-card text-bead-ink rounded-bead-md shadow-pop-md px-6 text-2xl",
    pop: "var(--color-bead-card-shadow)",
  },
  // 圆图标按钮（§6.5）：pill + 50~56px，不带可见文字，靠 aria-label 定锚点。
  icon: {
    classes: "bg-bead-card text-bead-ink rounded-bead-pill shadow-pop-sm min-w-14",
    pop: "var(--color-bead-card-shadow)",
  },
  danger: {
    classes: "bg-bead-danger text-bead-card rounded-bead-md shadow-pop-md px-6 text-2xl",
    pop: "var(--color-bead-danger)",
  },
  go: {
    classes: "bg-bead-go text-bead-card rounded-bead-md shadow-pop-md px-6 text-2xl",
    pop: "var(--color-bead-go-dark)",
  },
};

// 只用于判断「有没有可见文字」：字符串插值与嵌套元素都算，图标 svg 不算（它 aria-hidden）。
const collectText = (nodes: unknown): string => {
  if (typeof nodes === "string") return nodes;
  if (typeof nodes === "number") return String(nodes);
  if (Array.isArray(nodes)) return nodes.map(collectText).join("");
  if (nodes && typeof nodes === "object" && "children" in nodes) return collectText(nodes.children);
  return "";
};

// 入口校验：prop validator 只会警告，非法变体与「图标按钮没锚点」都必须响亮失败。
if (!VARIANTS[props.variant]) {
  throw new Error(`BeadButton: 未知变体「${String(props.variant)}」`);
}
if (props.variant === "icon" && !collectText(slots.default?.()).trim() && !props.ariaLabel) {
  throw new Error("BeadButton: icon 变体的插槽没有可见文字，必须传 aria-label");
}

const classes = computed(() => [
  // 最小触控目标 56×56（§6.5）；按下态是 translate-y-1 + shadow-none 的组合（§6.3）。
  "inline-flex items-center justify-center gap-2 border-4 border-bead-ink min-h-14 text-center",
  "active:translate-y-1 active:shadow-none disabled:cursor-not-allowed disabled:opacity-50",
  VARIANTS[props.variant].classes,
]);

const popStyle = computed(() => ({ "--bead-pop": VARIANTS[props.variant].pop }));
</script>

<template>
  <button
    type="button"
    :class="classes"
    :style="popStyle"
    :aria-label="ariaLabel"
    :disabled="disabled"
  >
    <slot />
  </button>
</template>
