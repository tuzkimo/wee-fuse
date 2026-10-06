<script setup lang="ts">
// src/components/editor/PatternToolbar.vue
//
// 编辑器工具栏：工具切换 / 撤销重做 / 网格线与格内色号开关 / 适配与 ± 缩放 / 保存与未保存指示。
// props 进、事件出，**不读 store**（`dirty` 的唯一来源是 `session.dirty`，由页面传进来）。
//
// 三个开关类按钮 emit 的是**翻转后的值**而不是当前值：本组件不持有开关状态，
// emit 当前值等于「父级收到和自己一样的状态」——点击看着没反应，还不报错。
//
// `disabled` **逐字**读 `canUndo` / `canRedo`（规格 §6.6）：能不能撤只有 `EditHistory` 知道，
// 组件里再算一次「有没有东西可撤」就是第二份真相，漂移的那天没有任何信号。
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
  export: [];
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
  <section class="flex flex-wrap items-center gap-2">
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
      重做
    </button>

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

    <button
      data-testid="zoom-fit"
      class="min-h-11 rounded border border-slate-300 px-4 text-base"
      @click="emit('fit')"
    >
      适配
    </button>
    <button
      data-testid="zoom-in"
      class="min-h-11 rounded border border-slate-300 px-4 text-base"
      @click="emit('zoom-in')"
    >
      放大
    </button>
    <button
      data-testid="zoom-out"
      class="min-h-11 rounded border border-slate-300 px-4 text-base"
      @click="emit('zoom-out')"
    >
      缩小
    </button>

    <!-- 未保存指示：干净时不渲染（CONTRACT §8 的逐字口径）。 -->
    <span v-if="dirty" data-testid="editor-dirty" class="text-base text-amber-700">未保存</span>

    <!--
      导出入口（B4）：**只加这一个按钮与一个 `export` 事件**——既有 props / 事件的语义一行不动。
      面板由 `EditorPage` 渲染（唯一装配点），本组件只知道「用户点了导出」。
      文案与类名照契约 §2b：`min-h-11`（= 44px，与工具栏其余按钮同口径）、`text-base`（= 16px）。
    -->
    <button
      data-testid="export"
      class="min-h-11 rounded border border-slate-300 px-4 text-base"
      @click="emit('export')"
    >
      导出
    </button>

    <button
      data-testid="editor-save"
      :disabled="saving"
      class="min-h-11 rounded bg-slate-900 px-6 text-base text-white disabled:opacity-50"
      @click="emit('save')"
    >
      {{ saveLabel }}
    </button>
  </section>
</template>
