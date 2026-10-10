<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import SheetViewer from "@/components/sheet/SheetViewer.vue";
import { useOverlayBack } from "@/composables/useOverlayBack";
import { fromProjectDocument } from "@/core/project/file";
import type { Palette } from "@/core/palette/types";
import type { Pattern } from "@/core/pattern/types";
import { getBuiltinPalette } from "@/services/palette";
import {
  getProjectStore,
  PROJECT_NAME_MAX,
  type ProjectMeta,
  type ProjectStore,
} from "@/services/projectStore";
import { formatRelativeTime } from "@/views/relativeTime";

const router = useRouter();
const projects = ref<ProjectMeta[]>([]);
const error = ref("");

/**
 * 存储失败的两支语义（B2 规格 §8）。**两支都要禁用新建**：「打不开的库」写不进去，
 * 让用户先走完选图 + 选区 + 生成、到 `put` 才撞墙是白跑一遍（B1-7 的实测教训）。
 * 但文案不同——`uninjected` 是浏览器能力问题，`unreadable` 是这一份库当下读不出来。
 *
 * 用一支判别式状态而不是两个布尔：两个布尔能表示「同时未注入又读不出来」这种不存在的状态。
 */
type StoreFailure = "uninjected" | "unreadable";

const storeFailure = ref<StoreFailure | null>(null);
const storeUnavailable = computed(() => storeFailure.value !== null);

const storeFailureText = computed(() => {
  if (storeFailure.value === "uninjected") {
    // 刻意**不**贴 `getProjectStore()` 的原始文案（「工程存储尚未初始化…」）：那是给开发者的
    // 内部话术，用户看不懂、也没有出路。既有断言（「存储不可用时给出提示并禁用新建」）在守这一点。
    return "这个浏览器不允许本地保存（可能是隐私模式），所以暂时不能新建或打开图纸。";
  }
  if (storeFailure.value === "unreadable") {
    // **必须带上原始原因**：只写「打不开」，用户拿不到任何可操作的信息。
    return `本地图纸库现在打不开（${error.value}）。在它恢复之前，新建图纸也没法保存，先别开工。`;
  }
  return "";
});

const renamingId = ref<string | null>(null);
const renameDraft = ref("");
const pendingDelete = ref<ProjectMeta | null>(null);
/**
 * 删除确认框是「临时界面」：Android 返回键先取消它，而不是离开页面（C8 规格 §3.6.2）。
 * 判据用 `pendingDelete !== null`——对话框由 `ref` 控制显隐，不重新挂载组件。
 */
useOverlayBack(
  () => {
    pendingDelete.value = null;
  },
  () => pendingDelete.value !== null,
);
/**
 * 正在「查看施工图」的那一条（B6 任务 14）。整条 `meta` 而不是只存 id：查看层要的三样
 * （id / name / thumbnail）在这一刻全在手上，只存 id 就得再回库查一次——而查看层自己
 * **还要**回库拿 `doc`，那会变成同一份记录查两遍。
 *
 * 挂载处给了 `:key="sheetTarget.id"`（修复轮，控制者裁定）：查看层是 `fixed inset-0` 盖住列表，
 * 所以「开着的时候换一条工程」今天**不可达**；但只有 `v-if` 时 Vue 会复用实例、`onMounted`
 * 不再跑，屏幕上会**留着上一条工程的施工图**（预览还是旧的 object URL）——`:key` 把这条不变量
 * 焊死，不必指望「唯一的出口是关闭」。用例：`查看层开着时点另一条工程的「查看」…`。
 */
const sheetTarget = ref<ProjectMeta | null>(null);
/**
 * 查看层要的图纸与色卡：**由本页从记录里读出来**（C7 起 `SheetViewer` 吃 `pattern` 入参，
 * 不再自己回库读——那条路径会让编辑器与结果页的**内存态**图纸进不来）。
 *
 * 与 `sheetTarget` 同步读：打开那一刻读一次记录（`get`），拿到 `doc` 之后经
 * `fromProjectDocument` 还原成 `pattern`。读不到就把 `sheetPattern` 留在 `null`，模板自然不挂查看层。
 */
const sheetPattern = ref<Pattern | null>(null);
const palette: Palette = getBuiltinPalette();

async function openSheet(meta: ProjectMeta): Promise<void> {
  sheetTarget.value = meta;
  sheetPattern.value = null;
  try {
    const record = await getProjectStore().get(meta.id);
    if (record === null) return;
    sheetPattern.value = fromProjectDocument(record.doc, palette).pattern;
  } catch (cause) {
    error.value = `打不开这条工程（${cause instanceof Error ? cause.message : String(cause)}）`;
  }
}

const hasProjects = computed(() => projects.value.length > 0);

async function refresh(): Promise<void> {
  error.value = "";
  storeFailure.value = null;

  // ① 未注入：装配错误（`main.ts` 在挂载前注入，生产不可达）。真实失败都发生在首次使用。
  //    这里仍然把原始文案写进 `error`，尽管当前模板**不**渲染它（见 `storeFailureText` 的
  //    第一支）：正是「`error` 里确实有那句内部话术」才让既有断言 `not.toContain("工程存储尚未
  //    初始化")` 有牙——哪天真把 `{{ error }}` 贴进红字，它会转红；而如果这里不写，`{{ error }}`
  //    只会渲染空串，那条断言就废了。
  let store: ProjectStore;
  try {
    store = getProjectStore();
  } catch (e) {
    storeFailure.value = "uninjected";
    error.value = e instanceof Error ? e.message : String(e);
    return;
  }

  // ② 库打不开（隐私模式 / 配额用尽 / 陈旧库缺 object store）。**也禁用新建**：不禁用的话
  //    用户会一路走到生成页的 `put` 才看到原始报错，白跑一遍选图 + 选区 + 生成（B1-7 的实测教训）。
  try {
    projects.value = await store.list();
  } catch (e) {
    storeFailure.value = "unreadable";
    error.value = e instanceof Error ? e.message : String(e);
    return;
  }
}

onMounted(refresh);

function startRename(meta: ProjectMeta): void {
  renamingId.value = meta.id;
  renameDraft.value = meta.name;
}

async function confirmRename(): Promise<void> {
  const id = renamingId.value;
  if (id === null) return;
  try {
    await getProjectStore().rename(id, renameDraft.value);
    renamingId.value = null;
    await refresh();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function confirmDelete(): Promise<void> {
  const target = pendingDelete.value;
  if (target === null) return;
  try {
    await getProjectStore().remove(target.id);
    pendingDelete.value = null;
    await refresh();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

function open(id: string): void {
  void router.push({ name: "editor", params: { id } });
}
</script>

<template>
  <main class="min-h-screen bg-slate-50 p-4 md:p-8">
    <header class="flex flex-wrap items-center justify-between gap-4">
      <h1 class="text-3xl font-bold text-slate-900">我的图纸</h1>
      <button
        data-testid="new-project"
        class="min-h-12 rounded bg-slate-900 px-6 text-lg text-white disabled:opacity-50"
        :disabled="storeUnavailable"
        @click="router.push({ name: 'pick' })"
      >
        新建
      </button>
    </header>

    <p v-if="storeUnavailable" data-testid="store-unavailable" class="mt-4 rounded bg-red-50 p-4 text-lg text-red-700">
      {{ storeFailureText }}
    </p>
    <p v-if="error && !storeUnavailable" data-testid="error-hint" class="mt-4 rounded bg-amber-50 p-4 text-lg text-amber-800">
      {{ error }}
    </p>

    <p v-if="!error && !storeUnavailable && !hasProjects" data-testid="empty-hint" class="mt-8 text-lg text-slate-500">
      还没有图纸。点右上角「新建」选一张图片开始吧。
    </p>

    <ul data-testid="project-list" class="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <li
        v-for="meta in projects"
        :key="meta.id"
        data-testid="project-card"
        class="min-w-0 rounded-lg bg-white p-4 shadow"
      >
        <img
          v-if="meta.thumbnail"
          :src="meta.thumbnail"
          alt=""
          class="mb-3 h-32 w-full rounded bg-slate-100 object-contain"
        />
        <div v-else class="mb-3 flex h-32 w-full items-center justify-center rounded bg-slate-100 text-slate-400">
          没有封面
        </div>

        <template v-if="renamingId === meta.id">
          <input
            v-model="renameDraft"
            data-testid="rename-input"
            :maxlength="PROJECT_NAME_MAX"
            class="min-h-12 w-full rounded border border-slate-300 px-3 text-lg"
          />
          <div class="mt-2 flex gap-3">
            <button data-testid="rename-confirm" class="min-h-12 flex-1 rounded bg-slate-900 text-white" @click="confirmRename">
              好
            </button>
            <button class="min-h-12 flex-1 rounded border border-slate-300" @click="renamingId = null">
              算了
            </button>
          </div>
        </template>

        <template v-else>
          <p data-testid="project-name" class="project-name text-lg font-semibold text-slate-900">
            {{ meta.name }}
          </p>
          <p class="mt-1 text-base text-slate-500">{{ meta.width }} × {{ meta.height }} · {{ meta.colorCount }} 种颜色</p>
          <p data-testid="project-updated-at" class="mt-1 text-base text-slate-400">
            {{ formatRelativeTime(meta.updatedAt, new Date()) }}
          </p>
          <div class="mt-3 flex flex-wrap gap-3">
            <button
              data-testid="view-sheet"
              class="min-h-12 flex-1 rounded bg-slate-900 px-4 text-white"
              @click="openSheet(meta)"
            >
              查看
            </button>
            <button
              data-testid="open-project"
              class="min-h-12 rounded border border-slate-300 px-4"
              @click="open(meta.id)"
            >
              编辑
            </button>
            <button data-testid="rename-project" class="min-h-12 rounded border border-slate-300 px-4" @click="startRename(meta)">
              改名
            </button>
            <button data-testid="delete-project" class="min-h-12 rounded border border-red-300 px-4 text-red-700" @click="pendingDelete = meta">
              删除
            </button>
          </div>
        </template>
      </li>
    </ul>

    <SheetViewer
      v-if="sheetTarget !== null && sheetPattern !== null"
      :key="sheetTarget.id"
      :pattern="sheetPattern"
      :palette="palette"
      :name="sheetTarget.name"
      :thumbnail="sheetTarget.thumbnail"
      @close="
        sheetTarget = null;
        sheetPattern = null;
      "
    />

    <div
      v-if="pendingDelete"
      data-testid="confirm-dialog"
      class="fixed inset-0 flex items-center justify-center bg-black/40 p-4"
    >
      <div class="w-full max-w-md rounded-lg bg-white p-6">
        <p class="text-xl text-slate-900">确定删掉「{{ pendingDelete.name }}」吗？删了就找不回来了。</p>
        <div class="mt-6 flex gap-4">
          <button data-testid="delete-confirm" class="min-h-14 flex-1 rounded bg-red-600 text-lg text-white" @click="confirmDelete">
            删掉
          </button>
          <button data-testid="delete-cancel" class="min-h-14 flex-1 rounded border border-slate-300 text-lg" @click="pendingDelete = null">
            不删
          </button>
        </div>
      </div>
    </div>
  </main>
</template>
