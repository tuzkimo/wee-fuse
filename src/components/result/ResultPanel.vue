<script setup lang="ts">
// src/components/result/ResultPanel.vue
//
// 结果卡片（C8 规格 §3.4）：**两个宿主共用的纯展示组件**——`SetupPage`（生成结果）与
// `EditResultPage`（编辑保存成功）。
//
// 三条纪律：
// 1. **不 import store**（`useProjectSession` / `useDraft` 都不许读）：宿主负责接线，本组件只
//    props 进、事件出。它因此能被两个来源完全不同的页面复用，也不会在两处各写一份「结果阶段该
//    显示什么」。
// 2. **查看施工图是本组件自带的**（不是宿主的事）：结果页只有图纸与用量，跳去编辑器再打开查看层
//    反而打断「改参数再生成」这条路；「重做」那颗按钮才是离开本页面的动作（C8 §3.4 的按钮改版）。
// 3. 根节点是**单根** `<section>`：`SetupPage` 的 `<section data-testid="result-pane">` 包着它，
//    多根会让宿主传下来的属性落不到任何元素上。查看层因此放在根 section 的**最后一行**。
import { computed, ref } from "vue";
import type { Palette } from "@/core/palette/types";
import { boardCount, beadsToCm, formatCm } from "@/core/pattern/board";
import { patternStats } from "@/core/pattern/stats";
import type { Pattern } from "@/core/pattern/types";
import SheetViewer from "@/components/sheet/SheetViewer.vue";
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
  }>(),
  { name: "图纸" },
);
const emit = defineEmits<{ rerun: []; edit: []; ok: [] }>();

/** 查看施工图是否打开。**就地打开，不跳编辑器**：本页已经有图纸与用量。 */
const sheetOpen = ref(false);

/** 结果预览缩略图（结果面板的那张小图，也是查看施工图现算完成前的垫场图）。 */
const preview = computed(() => renderPatternThumbnail(props.pattern, props.palette, RESULT_PREVIEW_MAX_EDGE));

const stats = computed(() => patternStats(props.pattern, props.palette));

/**
 * 结果阶段的尺寸三行（规格 §6.3）。
 *
 * **口径是产物自身**（`props.pattern.width/height`），不是「裁剪 + 长边 → 预测网格」那套重算
 * ——后者是 `ParamPanel` 的来源，两者互为校验（规格 §6.3 的 2026-10-03 修正）。
 *
 * **修复轮 1 的注释更正**：那句依据原先写的是「生成之后用户还能在右栏改长边（平板两栏常驻）」。
 * C8 第 4 项单页化之后这条路径**不存在了**（结果阶段整页只有结果卡片，参数面板不渲染），
 * 但结论不变、而且更强：本组件的 props 里**根本没有参数**（`pattern` / `palette` / `isNew` /
 * `canRerun` / `name` / `thumbnail`，且不 import store），所以「用参数重算预测值」在结构上
 * 写不出来——它只能报手上这一份产物。
 *
 * 厘米与板数复用 `core/pattern/board.ts` 的 `beadsToCm` / `formatCm` / `boardCount`，与参数面板
 * 同一组换算、不写第二份。
 */
const size = computed(() => {
  const { width, height } = props.pattern;
  const boards = boardCount(width, height);
  return {
    size: `成品 ${width} × ${height} 颗`,
    cm: `约 ${formatCm(beadsToCm(width))} × ${formatCm(beadsToCm(height))} 厘米`,
    boards: `需要 ${boards.cols} × ${boards.rows} = ${boards.total} 块板`,
  };
});
</script>

<template>
  <section class="rounded bg-white p-4 shadow">
    <img
      data-testid="result-preview"
      :src="preview"
      alt=""
      class="w-full rounded bg-slate-100"
    />
    <p data-testid="result-save-state" class="mt-3 text-lg font-semibold text-slate-900">
      {{ isNew ? "已保存到图纸库" : "已更新这张图纸" }}
    </p>
    <p data-testid="result-stats" class="mt-1 text-base text-slate-600">
      实际用了 {{ stats.colorCount }} 种颜色，共 {{ stats.total }} 颗豆
    </p>
    <p data-testid="result-size" class="mt-1 text-base text-slate-600">
      {{ size.size }}，{{ size.cm }}，{{ size.boards }}
    </p>

    <!--
      结果页的四颗按钮（C8 规格 §3.4 的改版）：**没有「打印」**——打印从查看层里进，两者是同一张
      施工图的两个出口，摆在结果页上只会让人以为它们是两件事。主操作是「OK」（结束回家）。
    -->
    <div class="mt-4 flex flex-wrap gap-3">
      <button
        v-if="canRerun"
        data-testid="result-rerun"
        class="min-h-12 rounded border border-slate-300 px-4 text-base"
        @click="emit('rerun')"
      >
        重做
      </button>
      <button
        data-testid="result-view-sheet"
        class="min-h-12 rounded border border-slate-300 px-4 text-base"
        @click="sheetOpen = true"
      >
        查看
      </button>
      <button
        data-testid="open-editor"
        class="min-h-12 rounded border border-slate-300 px-4 text-base"
        @click="emit('edit')"
      >
        编辑
      </button>
      <button
        data-testid="result-ok"
        class="min-h-12 rounded bg-slate-900 px-4 text-base text-white"
        @click="emit('ok')"
      >
        OK
      </button>
    </div>

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
