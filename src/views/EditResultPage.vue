<script setup lang="ts">
// src/views/EditResultPage.vue
//
// `/edit/:id/result`：编辑保存成功后的结果页（C8 规格 §3.4）。标题行「修改成功」+ 共用结果卡片。
// 正常路径下 `session.pattern` 就是刚保存的那份（内存态，不重新读库）；刷新 / 直链进来时它为空，
// 这时按 id 补一次 `load`，仍取不到就回首页。
//
// **返回箭头恒 `push({ name: "home" })`，不走 `backOrHome`**（C8 规格 §3.4 的 `result-back`）：
// 这一页的正常入口是「编辑器保存成功」，历史非空 ⇒ `back()` 会退回**刚保存完的编辑器**，那是错的
// 方向（用户按的是「结束」而不是「继续改」）。统一口径：**生图页 / 编辑页的返回箭头 = `backOrHome`
// （真正意义上的「上一页」）；两个结果页（含生图页的 result 阶段）= 恒回图纸库**。
// （`task-4-brief.md` 的骨架在这里用了 `backOrHome(router)`，与本条规格冲突——按规格落地。）
import { computed, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import ResultPanel from "@/components/result/ResultPanel.vue";
import { seedRerunDraft } from "@/services/rerunDraft";
import { getBuiltinPalette } from "@/services/palette";
import { useDraft } from "@/stores/draft";
import { useProjectSession } from "@/stores/project";

const route = useRoute();
const router = useRouter();
const draft = useDraft();
const session = useProjectSession();
const palette = getBuiltinPalette();

const pattern = computed(() => session.pattern);
/** 有没有原图可以「重做」（重跑要拿原图重新走一遍流水线）。 */
const canRerun = computed(() => session.record?.source != null);

onMounted(async () => {
  // 正常路径：编辑器刚保存完，图纸就在内存里，**不重新读库**（重读会把用户的当前态换成库里那份，
  // 而这个页面本来要显示的就是刚刚保存的那一份）。
  if (session.pattern !== null) return;
  // 刷新 / 直链：内存态没有，按路由参数补一次。取不到就回首页——留在这里会渲染一张空卡片。
  const id = typeof route.params.id === "string" ? route.params.id : "";
  const loaded = await session.load(id);
  if (!loaded || session.pattern === null) await router.push({ name: "home" });
});

/** 「重做」= 改参数重新生成：播种草稿后回生图页（与编辑器里那颗「重做」同一个动作）。 */
function rerun(): void {
  if (seedRerunDraft(draft, session)) void router.push({ name: "setup" });
}
</script>

<template>
  <main class="min-h-screen bg-slate-50 p-4 md:p-8">
    <header class="flex flex-wrap items-center gap-3">
      <button
        data-testid="result-back"
        aria-label="返回"
        class="inline-flex min-h-11 min-w-11 items-center justify-center rounded border border-slate-300 text-xl text-slate-700"
        @click="router.push({ name: 'home' })"
      >
        ←
      </button>
      <h1 class="text-2xl font-bold text-slate-900">修改成功</h1>
    </header>

    <!--
      `result-pane` 这个 testid 归**宿主**（与 `SetupPage` 同口径）：卡片本体是共用组件。

      `:thumbnail` 用 `|| undefined` 而不是 `?? ''`：`ProjectMeta.thumbnail` 的契约**允许空串**
      （= 无封面），而空串不算 nullish ⇒ 传下去之后 `ResultPanel` 里 `thumbnail ?? preview` 的
      兜底会变成死代码，没有封面的记录进查看层时连垫场图都拿不到。空串在这里的语义就是「没有」。
    -->
    <div v-if="pattern !== null" data-testid="result-pane" class="mt-6">
      <ResultPanel
        :pattern="pattern"
        :palette="palette"
        :is-new="false"
        :can-rerun="canRerun"
        :name="session.record?.meta.name ?? '图纸'"
        :thumbnail="session.record?.meta.thumbnail || undefined"
        @rerun="rerun"
        @edit="router.push({ name: 'editor', params: { id: route.params.id } })"
        @ok="router.push({ name: 'home' })"
      />
    </div>
  </main>
</template>
