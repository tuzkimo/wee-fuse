<script setup lang="ts">
// src/components/editor/PatternToolbar.vue
//
// 编辑器工具栏：工具切换（含橡皮）/ 撤销重做 / 网格线与格内色号开关 / 适配与 ± 缩放 /
// 「重做」（改参数重新生成）与保存 + 未保存指示。
// props 进、事件出，**不读 store**（`dirty` 的唯一来源是 `session.dirty`，由页面传进来）。
//
// 三个开关类按钮 emit 的是**翻转后的值**而不是当前值：本组件不持有开关状态，
// emit 当前值等于「父级收到和自己一样的状态」——点击看着没反应，还不报错。
//
// `disabled` **逐字**读 `canUndo` / `canRedo`（规格 §6.6）：能不能撤只有 `EditHistory` 知道，
// 组件里再算一次「有没有东西可撤」就是第二份真相，漂移的那天没有任何信号。
//
// **C8 第 3 项起本组件是页面唯一的外部出口**：查看施工图 / 打印两颗按钮已删除（单张施工图的出口
// 收敛到「保存 → 修改成功结果页 → 查看」），改参数重新生成从页面中部搬进输出行并改名「重做」，
// 橡皮从调色板搬进工具行。本组件仍然只**报告**用户点了什么：`eraser` 的接收方（`EditorPage.onEraser`）
// 除了把当前色设成橡皮，还要顺手切回画笔——那是页面的事，不在这里替它决定。
//
// `aria-pressed` 直接绑**布尔值**而不是 `String(...)`：这个属性的类型是 `Booleanish`
// (`boolean | "true" | "false"`)，`String()` 返回的宽 `string` 过不了 `vue-tsc` 的严格检查
// （简报草稿里的 `String(...)` 是三处 TS2322）；而 DOM 序列化出来仍是 `"true"` / `"false"`
// （`patchAttr` 对非 special-boolean 属性直接 `setAttribute`，与用例断言的字符串一致）。
import { computed } from "vue";
import type { EditorTool } from "@/stores/editor";

const props = defineProps<{
  canUndo: boolean;
  canRedo: boolean;
  tool: EditorTool;
  showGrid: boolean;
  showLabels: boolean;
  saving: boolean;
  /** 未保存状态：唯一来源是 `session.dirty`（规格 §7 要点 4），本组件只负责显示。 */
  dirty: boolean;
  /** 「重做」（改参数重新生成）是否可用：没有保存原图的工程没有这一项。 */
  canRerun: boolean;
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
  save: [];
  /** 改参数重新生成（C8 从页面上那颗大按钮搬进来）。 */
  rerun: [];
  /** 把当前色槽设为橡皮（`EMPTY`）**并切回画笔**——见 `EditorPage.onEraser`。 */
  eraser: [];
}>();

/** 三个工具按钮：testid 固定为 `tool-<工具名>`（CONTRACT §8），不许另起名字。 */
const TOOLS: readonly { readonly tool: EditorTool; readonly label: string }[] = [
  { tool: "brush", label: "画笔" },
  { tool: "select", label: "框选" },
  { tool: "pick", label: "吸管" },
];

/**
 * 保存按钮的文案。长任务期间唯一的进度反馈就是这行字（与 `ParamPanel` 的
 * 「正在生成…」同一口径）；`saving` 期间按钮同时 `disabled`，防并发保存。
 */
const saveLabel = computed(() => (props.saving ? "正在保存…" : "保存"));
</script>

<template>
  <section class="space-y-3">
    <!-- 五行的划分是产品口径（规格 §5.1）：同类操作挨着，用户找按钮靠位置而不是靠读字。
         行内仍 flex-wrap：窄屏下同一行的按钮可以继续折行，不会横向溢出。 -->
    <div data-testid="toolbar-row-tools" class="flex flex-wrap gap-2">
      <button
        v-for="item in TOOLS"
        :key="item.tool"
        :data-testid="`tool-${item.tool}`"
        :aria-pressed="tool === item.tool"
        class="min-h-11 rounded border border-slate-300 px-4 text-base"
        @click="emit('update:tool', item.tool)"
      >
        {{ item.label }}
      </button>
      <!-- 橡皮（C8 第 3 项：从调色板搬进工具行、跟在三个工具之后）。按下态读 `eraserActive`
           （= 当前色是 `EMPTY`）：用户切到橡皮之后必须看得出来自己握着的不是某个色。
           点它 emit `eraser`——**「顺带切回画笔」在页面那一层做**（`EditorPage.onEraser`），
           本组件不替父级决定工具状态。 -->
      <button
        data-testid="eraser"
        :aria-pressed="eraserActive"
        class="min-h-11 rounded border border-slate-300 px-4 text-base"
        @click="emit('eraser')"
      >
        橡皮
      </button>
    </div>

    <div data-testid="toolbar-row-history" class="flex flex-wrap gap-2 border-t border-slate-200 pt-3">
      <button
        data-testid="undo"
        :disabled="!canUndo"
        class="min-h-11 rounded border border-slate-300 px-4 text-base disabled:opacity-50"
        @click="emit('undo')"
      >
        撤销
      </button>
      <button
        data-testid="redo"
        :disabled="!canRedo"
        class="min-h-11 rounded border border-slate-300 px-4 text-base disabled:opacity-50"
        @click="emit('redo')"
      >
        恢复
      </button>
    </div>

    <div data-testid="toolbar-row-display" class="flex flex-wrap gap-2 border-t border-slate-200 pt-3">
      <button
        data-testid="toggle-grid"
        :aria-pressed="showGrid"
        class="min-h-11 rounded border border-slate-300 px-4 text-base"
        @click="emit('update:showGrid', !showGrid)"
      >
        网格线
      </button>
      <button
        data-testid="toggle-labels"
        :aria-pressed="showLabels"
        class="min-h-11 rounded border border-slate-300 px-4 text-base"
        @click="emit('update:showLabels', !showLabels)"
      >
        格内色号
      </button>
    </div>

    <div data-testid="toolbar-row-view" class="flex flex-wrap gap-2 border-t border-slate-200 pt-3">
      <button data-testid="zoom-fit" class="min-h-11 rounded border border-slate-300 px-4 text-base" @click="emit('fit')">
        适配
      </button>
      <button data-testid="zoom-in" class="min-h-11 rounded border border-slate-300 px-4 text-base" @click="emit('zoom-in')">
        放大
      </button>
      <button data-testid="zoom-out" class="min-h-11 rounded border border-slate-300 px-4 text-base" @click="emit('zoom-out')">
        缩小
      </button>
    </div>

    <div data-testid="toolbar-row-output" class="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-3">
      <!--
        C8 第 3 项：这一行是编辑器**唯一的出口行**——「重做」（改参数重新生成，从页面中部搬进来）
        与「保存」。查看施工图 / 打印两颗按钮已删除：单张施工图的出口收敛成「保存 → 修改成功结果页
        → 查看」，本组件不再持有那两个面板的任何知识（`data-testid` 的删除清单见任务 5 简报）。

        「重做」是**白底次要按钮**（`border-slate-300`、无底色），保存仍是黑底主操作：重做会丢掉
        手工涂改，视觉权重不能压过保存。`canRerun` 为假（工程没有保存原图）时**不渲染它**——
        没有原图就无从「按原图重新生成」，留一颗点了没反应的按钮比没有按钮更糟。
      -->
      <button
        v-if="canRerun"
        data-testid="rerun"
        class="min-h-11 rounded border border-slate-300 px-4 text-base"
        @click="emit('rerun')"
      >
        重做
      </button>
      <button
        data-testid="editor-save"
        :disabled="saving"
        class="min-h-11 rounded bg-slate-900 px-6 text-base text-white disabled:opacity-50"
        @click="emit('save')"
      >
        {{ saveLabel }}
      </button>
      <!-- 未保存指示：干净时不渲染（CONTRACT §8 的逐字口径）。 -->
      <span v-if="dirty" data-testid="editor-dirty" class="text-base text-amber-700">未保存</span>
    </div>
  </section>
</template>
