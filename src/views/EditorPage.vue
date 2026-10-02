<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { useProjectSession } from "@/stores/project";

/**
 * 编辑器（B1 只读版）。
 *
 * B1 只到「载入工程 + 显示只读参数」：画笔、框选、吸管、撤销是计划 B3。本页因此**没有任何
 * 写操作**，也不 import `indexedDB`——载入一律走 `useProjectSession().load()`。
 */
const route = useRoute();
const session = useProjectSession();
const loaded = ref(false);

onMounted(async () => {
  const id = route.params.id;
  // 路由参数可能是 `string[]`（重复参数）或 undefined，两种都不是合法 id：
  // 传空串让 `load` 走「找不到工程」那条响亮失败的路，而不是把数组塞进存储查询。
  loaded.value = await session.load(typeof id === "string" ? id : "");
});
</script>

<template>
  <main class="min-h-screen bg-slate-50 p-4 md:p-8">
    <p
      v-if="session.error"
      data-testid="editor-error"
      class="rounded bg-red-50 p-4 text-lg text-red-700"
    >
      {{ session.error }}
    </p>

    <template v-else-if="loaded && session.record">
      <h1 class="text-3xl font-bold text-slate-900">{{ session.record.meta.name }}</h1>
      <p class="mt-2 text-lg text-slate-600">
        {{ session.record.meta.width }} × {{ session.record.meta.height }} ·
        {{ session.record.meta.colorCount }} 种颜色
      </p>

      <p v-if="session.record.source" data-testid="rerun-available" class="mt-4 text-lg text-slate-600">
        原图已保存，可以改参数重新生成。
      </p>
      <p v-else data-testid="rerun-unavailable" class="mt-4 text-lg text-amber-700">
        这个工程没有保存原图，只能继续编辑或重新导出，不能改参数重新生成。
      </p>

      <p data-testid="editor-todo" class="mt-6 rounded bg-slate-100 p-4 text-lg text-slate-600">
        画笔、框选、吸管与撤销会在后续计划里加到这里。现在只能看参数。
      </p>
    </template>
  </main>
</template>
