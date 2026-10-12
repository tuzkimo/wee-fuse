<script setup lang="ts">
// src/components/result/ResultPanel.vue
//
// 结果卡片（D1 §7.5）：**两个宿主共用的纯展示组件**——`SetupPage`（生成结果）与
// `EditResultPage`（编辑保存成功）。
//
// 三条纪律：
// 1. **不 import store**（`useProjectSession` / `useDraft` 都不许读）：宿主负责接线，本组件只
//    props 进、事件出。它因此能被两个来源完全不同的页面复用，也不会在两处各写一份「结果阶段该
//    显示什么」。
// 2. **查看施工图是本组件自带的**（不是宿主的事）：结果页只有成品与三颗动作，跳去编辑器再打开
//    查看层反而打断「改参数再生成」这条路；「重做」那颗按钮才是离开本页面的动作。
// 3. 根节点是**单根** `<section>`：`SetupPage` 的 `<section data-testid="result-pane">` 包着它，
//    多根会让宿主传下来的属性落不到任何元素上。查看层因此放在根 section 的**最后一行**。
import { computed, ref } from "vue";
import type { Palette } from "@/core/palette/types";
import type { Pattern } from "@/core/pattern/types";
import SheetViewer from "@/components/sheet/SheetViewer.vue";
import BeadButton from "@/components/ui/BeadButton.vue";
import PixelIcon from "@/components/ui/PixelIcon.vue";
import { RESULT_PREVIEW_MAX_EDGE, renderPatternThumbnail } from "@/services/patternThumbnail";

const props = withDefaults(
  defineProps<{
    pattern: Pattern;
    palette: Palette;
    /** 本次是新建（`true`）还是覆盖（`false`）一条记录——只影响保存文案。 */
    isNew: boolean;
    /** 有没有原图可以重跑（宿主从记录的 `source` 判断）。 */
    canRerun: boolean;
    /**
     * 查看层的标题与保存文件名用的工程名（宿主从记录里取；本组件不读 store）。
     *
     * **给默认值而不是必填**：保存失败的工程还没进库、拿不到名字，而结果卡片照常显示
     * （规格 §8 的「保存失败不丢态」）。缺名字时查看层退化成通用标题，而不是渲染出
     * 「undefined · 施工图」。本组件的用例也只传四个必填 props（简报的挂载手法）。
     */
    name?: string;
    /** 查看层的垫场缩略图（可能没有：编辑器来源的结果页没有现算好的封面）。 */
    thumbnail?: string;
    /**
     * 是否渲染底部那颗通栏「完成」（`result-ok`）。
     *
     * `SetupPage` 的中栏宿主传 `false`——顶栏已经有「完成 ✓」了，同一页里两颗同名按钮会让
     * 8 岁用户分不清哪颗是收尾动作（§7.3）。全屏宿主 `EditResultPage` 不传，保持默认 `true`
     * （通栏「完成」也渲染，§7.5）。
     */
    showDone?: boolean;
  }>(),
  { name: "图纸", showDone: true },
);
const emit = defineEmits<{ rerun: []; edit: []; ok: [] }>();

/** 查看施工图是否打开。**就地打开，不跳编辑器**：本页已经有图纸与用量。 */
const sheetOpen = ref(false);

/** 结果预览缩略图（结果面板的那张小图，也是查看施工图现算完成前的垫场图）。 */
const preview = computed(() => renderPatternThumbnail(props.pattern, props.palette, RESULT_PREVIEW_MAX_EDGE));

/** 上半屏的板孔点阵（§7.5：`radial-gradient`，间距 22px；与 `SetupPage` 中栏 / `PatternCanvas` 同写法）。 */
const boardDots = {
  backgroundImage: "radial-gradient(var(--color-bead-hole) 2px, transparent 2px)",
  backgroundSize: "22px 22px",
};
</script>

<template>
  <section class="flex flex-col gap-4">
    <!--
      上半屏（约 55%）：成品预览在深色板底 + 板孔点阵上居中（§7.5）。深色底是本组件被允许的
      四处看图底之一（§10.6 白名单）。`max-h-full` + `object-contain`：缩略图按原比例缩到盒内，
      不裁切、不拉伸（像素风不重采样）。
    -->
    <div
      class="flex h-[55vh] items-center justify-center rounded-bead-md border-4 border-bead-ink bg-bead-board p-4"
      :style="boardDots"
    >
      <img
        data-testid="result-preview"
        :src="preview"
        alt=""
        class="max-h-full max-w-full object-contain"
      />
    </div>
    <p data-testid="result-save-state" class="text-[24px] text-bead-ink">
      {{ isNew ? "已保存到图纸库" : "已更新这张图纸" }}
    </p>

    <!--
      三颗并列动作按钮（§7.5：`bead-card` 底、64px 高）：全部映射到现有动作（继续涂 / 看施工图 /
      重做），不新增功能。**图形按钮**：可见内容只有像素图标，动作名走 `aria-label`（读屏用户的
      唯一名字；8 岁识别率测试见规格 §13 的延后项）。
    -->
    <div class="flex gap-3">
      <BeadButton
        data-testid="open-editor"
        variant="secondary"
        aria-label="继续涂"
        class="h-16 flex-1 p-0!"
        @click="emit('edit')"
      >
        <PixelIcon name="edit" :size="36" />
      </BeadButton>
      <BeadButton
        data-testid="result-view-sheet"
        variant="secondary"
        aria-label="看施工图"
        class="h-16 flex-1 p-0!"
        @click="sheetOpen = true"
      >
        <PixelIcon name="sheet" :size="36" />
      </BeadButton>
      <BeadButton
        v-if="canRerun"
        data-testid="result-rerun"
        variant="secondary"
        aria-label="重做"
        class="h-16 flex-1 p-0!"
        @click="emit('rerun')"
      >
        <!-- R10：`ICON_NAMES` 里没有 `rerun`，复用 `undo`。 -->
        <PixelIcon name="undo" :size="36" />
      </BeadButton>
    </div>

    <!--
      通栏大按钮（§7.5：36px 字 + `check` 图标 + `shadow-pop-lg`）。只在全屏宿主渲染。
      `shadow-pop-lg!` 的 `!` 是必须的：`primary` 变体自带 `shadow-pop-md`，两个工具类同特异性、
      `md` 在产物 CSS 里排在 `lg` 之后，不加 `!` 压不过去（同 `PickPage` 的处置）。
    -->
    <BeadButton
      v-if="showDone"
      data-testid="result-ok"
      variant="primary"
      aria-label="完成"
      class="w-full shadow-pop-lg!"
      @click="emit('ok')"
    >
      <PixelIcon name="check" :size="36" />
      <!-- 36px 写在内层节点上：`primary` 自带 24px，靠同名工具类的生成顺序盖不住。 -->
      <span class="text-[36px]">完成</span>
    </BeadButton>

    <!--
      查看施工图（C7 起是单张施工图的唯一出口）。吃 props 进来的那张图纸——宿主刚生成 / 刚保存的
      那一份，不是回库读的。
    -->
    <SheetViewer
      v-if="sheetOpen"
      :pattern="pattern"
      :palette="palette"
      :name="name"
      :thumbnail="thumbnail ?? preview"
      @close="sheetOpen = false"
    />
  </section>
</template>
