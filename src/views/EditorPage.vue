<script setup lang="ts">
import { onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useDraft } from "@/stores/draft";
import { useProjectSession } from "@/stores/project";

/**
 * 编辑器（B1 只读版 + B2 任务 12 的重跑入口）。
 *
 * B1 只到「载入工程 + 显示只读参数」：画笔、框选、吸管、撤销是计划 B3。本页因此**没有任何
 * 落盘写操作**，也不 import `indexedDB`——载入一律走 `useProjectSession().load()`。B2 任务 12
 * 加的那一个入口只写**内存里的向导草稿**（`useDraft().adoptProject`）然后跳 `SetupPage`；
 * 落盘与解码都在那一页。
 *
 * 这里**不**保留一个本地 `loaded` 标志：`load()` 返回 false 的每一条路径都会同时把原因写进
 * `session.error`（`找不到工程` 与 `catch` 两支），而模板里 `v-if="session.error"` 排在前面，
 * 所以「有没有载入成功」与「`session.record` 是不是 null」在现有实现下完全等价——多一个 ref
 * 只会多一份可能漂移的状态（也没有任何断言能观测到它）。将来 B3 若需要「载入中」态，再加一个
 * 语义明确的字段，而不是靠这个与 `record` 同真假的布尔。
 */
const route = useRoute();
const router = useRouter();
const draft = useDraft();
const session = useProjectSession();

onMounted(async () => {
  const id = route.params.id;
  // 路由参数可能是 `string[]`（重复参数）或 undefined，两种都不是合法 id：
  // 传空串让 `load` 走「找不到工程」那条响亮失败的路，而不是把数组塞进存储查询。
  await session.load(typeof id === "string" ? id : "");
});

/**
 * 把当前工程的原图与参数播种进向导草稿，然后交给 `SetupPage`（规格 §7）。
 *
 * **只播种、不解码**：原图尺寸与预览位图在 `SetupPage` 挂载时统一解码——同一段解码逻辑出现在
 * 两处正是本项目最贵的缺陷形态（「两端各自正确、错在接线」）。所以这里刻意**不**调用
 * `adoptImage`（它要尺寸与预览画布），也不碰 `setSourceSize`：那两样在编辑器里拿不到，
 * 硬凑一份只会造出第二个解码口径。
 *
 * 三个入参各自的来源与取舍：
 * - `source.blob` / `type` 直接取自记录；记录里**没有**原始文件名（`ProjectSource` 只有这两个
 *   字段），`DraftSource.name` 只能填工程名——重跑路径上这个名字也不会被用来命名（`SetupPage`
 *   的 `draft.rerunOf ?? savedTarget` 优先，`defaultProjectName(source.name)` 只是新建路径的回落）。
 * - `params` 取自 `session.params`（`fromProjectDocument` 已经把落盘的 `crop.w/h/rotate` 映射成
 *   运行期的 `crop.width/height` + 独立 `rotation`，这里不许再映射一遍）。`crop` **拷一份**再传：
 *   草稿会把它当 `pendingCrop` 留着直到解码完成，共享引用等于让草稿与工程会话互相牵连。
 * - `meta` 原样沿用 `id` / `name` / `createdAt`：重跑要覆盖同一条记录（`updatedAt` 由 `save()` 刷新）。
 *
 * 守卫与模板的 `v-if` 同源（`source !== null`）：本函数不是「只有 `source` 才可能为空」的假设——
 * `params` 是另一个 ref，理论上可以各自为空，缺一个就静默返回，绝不播种半份草稿。
 */
function rerun(): void {
  const record = session.record;
  const params = session.params;
  if (record === null || record.source === null || params === null) return;

  draft.adoptProject({
    source: { blob: record.source.blob, type: record.source.type, name: record.meta.name },
    params: {
      longSide: params.longSide,
      maxColors: params.maxColors,
      crop: {
        x: params.crop.x,
        y: params.crop.y,
        width: params.crop.width,
        height: params.crop.height,
      },
      rotation: params.rotation,
    },
    meta: { id: record.meta.id, name: record.meta.name, createdAt: record.meta.createdAt },
  });
  void router.push({ name: "setup" });
}
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

    <template v-else-if="session.record">
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

      <button
        v-if="session.record.source"
        data-testid="rerun"
        class="mt-3 min-h-14 rounded bg-slate-900 px-6 text-lg text-white"
        @click="rerun"
      >
        改参数重新生成
      </button>

      <p data-testid="editor-todo" class="mt-6 rounded bg-slate-100 p-4 text-lg text-slate-600">
        画笔、框选、吸管与撤销会在后续计划里加到这里。现在只能看参数，或改参数重新生成。
      </p>
    </template>
  </main>
</template>
