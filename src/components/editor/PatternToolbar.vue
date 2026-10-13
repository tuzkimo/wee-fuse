<script setup lang="ts">
// src/components/editor/PatternToolbar.vue
//
// 编辑器工具条（§7.4）：**十一颗图标按钮**（撤销/恢复 + 三个主工具 + 五个「看的方式」）。
// props 进、事件出，**不读 store**；保存按钮与未保存圆点已搬进 `EditorPage` 的顶栏，不在本组件。
//
// 三个开关类按钮 emit 的是**翻转后的值**而不是当前值：本组件不持有开关状态，
// emit 当前值等于「父级收到和自己一样的状态」——点击看着没反应，还不报错。
//
// `disabled` **逐字**读 `canUndo` / `canRedo`（规格 §6.6）：能不能撤只有 `EditHistory` 知道，
// 组件里再算一次「有没有东西可撤」就是第二份真相，漂移的那天没有任何信号。
//
// **两套排法靠类分叉、不靠 `v-if`（R3）**：十一颗按钮各自只有一个 DOM 节点，手机与平板的分歧
// 全在 `max-md:` / `md:` 类上。用 `v-if` 按断点删按钮会让手机端真缺功能，jsdom（宽 1024）里
// 也根本验不到手机那一套。手机上左组一行、右组一行（两组都可横滑，`overflow-x-auto`），
// 平板上两组用 `md:contents` 摊平进同一条 flex 行。
//
// 橡皮从调色板搬进工具条（C8 第 3 项），**2026-10-13 又搬回了选色区**（规格 §5.2）——它不是工具，
// 而是「当前色 = `EMPTY`」，与画笔 / 填充正交，放在工具条上与它们并排会让用户以为它们是三选一。
// 它现在的位置是 `PalettePicker` 的橡皮项，本组件不再有 `eraser` emit 与 `eraserActive` prop。
// 第三个主工具是「拖动」：单指平移视图，因此**它也是新会话的默认工具**（见 `store` 的 `DEFAULT_TOOL`）。
// 「重做」（改参数重新生成）**不在这里**：T5 起它搬进了 `EditorPage` 的顶栏、与「保存」同级
// （实机反馈 6：「重做」与工具按钮放一起不合逻辑）。本组件因此也不再声明 `rerun` emit 与
// `canRerun` prop——那两颗只会在页面里接线，多一份接口就是多一份可能漂移的真相。
//
// `aria-pressed` 仍直接绑**布尔值**而不是 `String(...)`：这个属性的类型是 `Booleanish`
// (`boolean | "true" | "false"`)，`String()` 返回的宽 `string` 过不了 `vue-tsc` 的严格检查，
// 而 DOM 序列化出来仍是 `"true"` / `"false"`（与用例断言的字符串一致）。
import type { EditorTool } from "@/stores/editor";
import BeadButton from "@/components/ui/BeadButton.vue";
import PixelIcon from "@/components/ui/PixelIcon.vue";

defineProps<{
  canUndo: boolean;
  canRedo: boolean;
  tool: EditorTool;
  showGrid: boolean;
  showLabels: boolean;
  /** 当前色槽是不是橡皮（`EMPTY`）——「橡皮」按钮的按下态。 */
  eraserActive: boolean;
}>();

const emit = defineEmits<{
  "update:tool": [EditorTool];
  undo: [];
  redo: [];
  "update:showGrid": [boolean];
  "update:showLabels": [boolean];
  fit: [];
  "zoom-in": [];
  "zoom-out": [];
  /** 把当前色槽设为橡皮（`EMPTY`）**并切回画笔**——见 `EditorPage.onEraser`。 */
  eraser: [];
}>();

/** 三个主工具：testid 固定为 `tool-<工具名>`（CONTRACT §8），不许另起名字。 */
const TOOLS: readonly { readonly tool: EditorTool; readonly label: string }[] = [
  { tool: "brush", label: "画笔" },
  { tool: "fill", label: "填充" },
  { tool: "pan", label: "拖动" },
];

/**
 * 十一颗图标按钮共用的尺寸类。
 *
 * `p-0!`：主/次按钮变体自带 `px-6`（给文字按钮的），图标按钮必须显式清掉——否则 64px 的方框里
 * 左右各 24px 内边距把内容挤成 0 宽，图标会偏出中心。
 * `min-h-[52px]! / min-w-[52px]!`：`BeadButton` 的基准是 `min-h-14` / `min-w-14`（56px），
 * 52px 的「看的方式」必须显式盖掉它（`!` 是为了不跟工具类的生成顺序打赌）。
 * `shrink-0`：flex 子项默认 `flex-shrink: 1`，不加这一条时窄屏会把按钮**压扁**而不是横滑
 * （360px 实测：64px 的主工具变 53px、56px 的历史按钮变 47px，且容器不再滚动）——
 * 规格 §7.4 逐字要求「不许缩按钮尺寸」，溢出交给容器的 `overflow-x-auto`。
 */
const TOOL_SIZE = "h-16 w-16 shrink-0 p-0!";
const HISTORY_SIZE = "h-14 w-14 shrink-0 p-0!";
const VIEW_SIZE = "min-h-[52px]! min-w-[52px]! shrink-0 rounded-bead-md!";
</script>

<template>
  <div class="max-md:space-y-3 md:flex md:flex-wrap md:items-center md:gap-2">
    <!-- 平板上十一颗（≈700px）要排成一条：`gap-2` 是 768px 下能容下的最大同层间距。 -->
    <!-- 左组：撤销 / 恢复 + 三个主工具（手机上占第一行，可横滑）。 -->
    <div
      class="max-md:flex max-md:flex-nowrap max-md:items-center max-md:gap-3 max-md:overflow-x-auto md:contents"
    >
      <BeadButton
        data-testid="undo"
        variant="secondary"
        aria-label="撤销"
        :disabled="!canUndo"
        :class="HISTORY_SIZE"
        @click="emit('undo')"
      >
        <PixelIcon name="undo" :size="24" />
      </BeadButton>
      <BeadButton
        data-testid="redo"
        variant="secondary"
        aria-label="恢复"
        :disabled="!canRedo"
        :class="HISTORY_SIZE"
        @click="emit('redo')"
      >
        <PixelIcon name="redo" :size="24" />
      </BeadButton>
      <!-- 三个主工具 64×64（§6.5）：按下态读 `tool === item.tool`；橡皮读 `eraserActive`。 -->
      <BeadButton
        v-for="item in TOOLS"
        :key="item.tool"
        :data-testid="`tool-${item.tool}`"
        :variant="tool === item.tool ? 'primary' : 'secondary'"
        :aria-label="item.label"
        :aria-pressed="tool === item.tool"
        :class="TOOL_SIZE"
        @click="emit('update:tool', item.tool)"
      >
        <PixelIcon :name="item.tool" :size="36" />
      </BeadButton>
      <BeadButton
        data-testid="eraser"
        :variant="eraserActive ? 'primary' : 'secondary'"
        aria-label="橡皮"
        :aria-pressed="eraserActive"
        :class="TOOL_SIZE"
        @click="emit('eraser')"
      >
        <PixelIcon name="eraser" :size="36" />
      </BeadButton>
    </div>

    <!-- 右组：五个「看的方式」，小一号的方按钮（52px），与 64px 的主工具分主次（手机上占第二行）。 -->
    <div
      class="max-md:flex max-md:flex-nowrap max-md:items-center max-md:gap-3 max-md:overflow-x-auto md:contents"
    >
      <BeadButton
        data-testid="toggle-grid"
        variant="icon"
        aria-label="网格线"
        :aria-pressed="showGrid"
        :class="VIEW_SIZE"
        @click="emit('update:showGrid', !showGrid)"
      >
        <PixelIcon name="grid" :size="24" />
      </BeadButton>
      <BeadButton
        data-testid="toggle-labels"
        variant="icon"
        aria-label="格内色号"
        :aria-pressed="showLabels"
        :class="VIEW_SIZE"
        @click="emit('update:showLabels', !showLabels)"
      >
        <PixelIcon name="labels" :size="24" />
      </BeadButton>
      <BeadButton
        data-testid="zoom-in"
        variant="icon"
        aria-label="放大"
        :class="VIEW_SIZE"
        @click="emit('zoom-in')"
      >
        <PixelIcon name="zoom-in" :size="24" />
      </BeadButton>
      <BeadButton
        data-testid="zoom-out"
        variant="icon"
        aria-label="缩小"
        :class="VIEW_SIZE"
        @click="emit('zoom-out')"
      >
        <PixelIcon name="zoom-out" :size="24" />
      </BeadButton>
      <BeadButton
        data-testid="zoom-fit"
        variant="icon"
        aria-label="适配"
        :class="VIEW_SIZE"
        @click="emit('fit')"
      >
        <PixelIcon name="fit" :size="24" />
      </BeadButton>
    </div>
  </div>
</template>
