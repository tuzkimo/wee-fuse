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
import { ref } from "vue";
import type { Palette } from "@/core/palette/types";
import type { Pattern } from "@/core/pattern/types";
import GridTilePreview from "@/components/sheet/GridTilePreview.vue";
import SheetViewer from "@/components/sheet/SheetViewer.vue";
import BeadButton from "@/components/ui/BeadButton.vue";
import PixelIcon from "@/components/ui/PixelIcon.vue";

withDefaults(
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

/** 上半屏的板孔点阵（§7.5：`radial-gradient`，间距 22px；与 `SetupPage` 中栏 / `PatternCanvas` 同写法）。 */
const boardDots = {
  backgroundImage: "radial-gradient(var(--color-bead-hole) 2px, transparent 2px)",
  backgroundSize: "22px 22px",
};
</script>

<template>
  <section class="flex h-full min-h-0 flex-col gap-2 md:gap-4">
    <!--
      上半屏（约 55%）：成品预览在深色板底 + 板孔点阵上居中（§7.5）。深色底是本组件被允许的
      四处看图底之一（§10.6 白名单）。

      预览从 2026-10-13 起是**网格块**（`GridTilePreview`，规格 §5.3）：按这个盒子的**短边**
      定格像素现画**四层**——纸底 → 逐格真色 → 空格斜线 → 整图外框。**不画**色号与网格线
      （真机反馈第 2 轮：那四样是施工信息，它们的入口是「看施工图」），也不靠 `object-contain`
      缩放一张糊图（改造前每格只有 1 像素）。

      > 这里曾写着「逐格真色 + 色号 + 网格线 + 板边界 + 每 5 格虚线 + 外框」——那套已作废，
      > 详见规格 §5.3 的更正注记。

      高度**跟随宿主**（R41 修复 2）：`basis-[55vh]` 是基准（宿主高度 auto 时它就是 55vh，
      全屏 `EditResultPage` 因此不变），`grow` + `min-h-0` 让它在**有定高**的宿主里被压进剩余
      空间——手机中栏那个吸顶盒（R42 起 48vh）里就不会再把三颗动作按钮顶进内滚区。
      **不用 `flex-1`**：它是 `flex 1 1 0%` 简写，会按工具类生成顺序盖掉 `basis-[55vh]`。
      `max-md:p-2!` 与 `gap-2` 是同一笔账：手机那个吸顶盒（R42 起 48vh）里“板框 + 保存文案 +
      三颗动作 + chip”的总高很紧，板上那 32px 内边距缩到 16px 才装得下（真窗口逐尺寸实测见
      任务 15 报告 §F/§G）。
    -->
    <div
      class="flex min-h-0 grow basis-[55vh] max-md:p-2! items-center justify-center rounded-bead-md border-4 border-bead-ink bg-bead-board p-4"
      :style="boardDots"
    >
      <GridTilePreview :pattern="pattern" :palette="palette" testid="result-preview" />
    </div>
    <p data-testid="result-save-state" class="text-[24px] text-bead-ink">
      {{ isNew ? "已保存到图纸库" : "已更新这张图纸" }}
    </p>

    <!--
      三颗并列动作按钮（§7.5：`bead-card` 底、64px 高）：全部映射到现有动作（继续涂 / 看施工图 /
      重做），不新增功能。图形按钮**必须配 2~4 字短中文兜底**（§1 事实 1：纯图标对抽象动作无法
      消歧），文字 12px、图标降为 24px。
      `aria-label` 同时保留：可见文字与无障碍名字同字〔WCAG 2.5.3〕。
    -->
    <div class="flex gap-3">
      <BeadButton
        data-testid="open-editor"
        variant="secondary"
        aria-label="继续涂"
        class="h-16 flex-1 flex-col p-0!"
        @click="emit('edit')"
      >
        <PixelIcon name="edit" :size="24" />
        <span class="text-[12px]">继续涂</span>
      </BeadButton>
      <BeadButton
        data-testid="result-view-sheet"
        variant="secondary"
        aria-label="看施工图"
        class="h-16 flex-1 flex-col p-0!"
        @click="sheetOpen = true"
      >
        <PixelIcon name="sheet" :size="24" />
        <span class="text-[12px]">看施工图</span>
      </BeadButton>
      <BeadButton
        v-if="canRerun"
        data-testid="result-rerun"
        variant="secondary"
        aria-label="重做"
        class="h-16 flex-1 flex-col p-0!"
        @click="emit('rerun')"
      >
        <!-- R56：用真正的 `rerun` 图形（循环箭头），与编辑页顶栏那颗同形——同一件事在两个入口
             不能是两个图形。 -->
        <PixelIcon name="rerun" :size="24" />
        <span class="text-[12px]">重做</span>
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
      那一份，不是回库读的。垫场图用宿主的 `thumbnail`（可能没有：编辑器来源的结果页没有现算好的
      封面）——缺省时 `SheetViewer` 自己的 `previewSrc` 会退化为空串，而不是渲染一张废图。
    -->
    <SheetViewer
      v-if="sheetOpen"
      :pattern="pattern"
      :palette="palette"
      :name="name"
      :thumbnail="thumbnail"
      @close="sheetOpen = false"
    />
  </section>
</template>
