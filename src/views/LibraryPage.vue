<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import SheetViewer from "@/components/sheet/SheetViewer.vue";
import BeadButton from "@/components/ui/BeadButton.vue";
import PixelIcon from "@/components/ui/PixelIcon.vue";
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
    return `本地图纸库现在打不开（${error.value}）。在它恢复之前，新建也没法保存，先别开工。`;
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
 * gear 展开的那张卡（§7.1：改名 / 删除 / 看施工图收进 gear）。存整条 `meta` 而不是 id：
 * 覆盖层里三个动作都要整条 meta，只存 id 就得再回列表查一次。同时只展开一张卡——第二次点
 * 别的 gear 自然顶掉前一张，不必额外维护一个集合。
 */
const menuTarget = ref<ProjectMeta | null>(null);

function toggleMenu(meta: ProjectMeta): void {
  menuTarget.value = menuTarget.value?.id === meta.id ? null : meta;
}

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
  menuTarget.value = null;
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
  menuTarget.value = null;
  renamingId.value = meta.id;
  renameDraft.value = meta.name;
}

/** 删除也先收起 gear 覆盖层：不关的话取消对话框后那张卡的覆盖层还开着。 */
function askDelete(meta: ProjectMeta): void {
  menuTarget.value = null;
  pendingDelete.value = meta;
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
  <main class="min-h-screen bg-bead-sand">
    <!-- 顶栏：手机 64px / 平板 80px，`bead-sand-2` 底 + 4px `bead-line` 底边（§7 共用口径） -->
    <header
      class="flex h-16 items-center justify-between gap-4 border-b-4 border-bead-line bg-bead-sand-2 px-4 md:h-20 md:px-8"
    >
      <h1 class="text-2xl text-bead-ink md:text-4xl">我的图纸</h1>
      <BeadButton
        data-testid="new-project"
        variant="go"
        aria-label="新建图纸"
        :disabled="storeUnavailable"
        @click="router.push({ name: 'pick' })"
      >
        <PixelIcon name="plus" :size="24" />
      </BeadButton>
    </header>

    <div class="p-4 md:p-8">
      <p
        v-if="storeUnavailable"
        data-testid="store-unavailable"
        class="rounded-bead-sm border-4 border-bead-ink bg-bead-warn-bg p-4 text-2xl text-bead-warn-ink"
      >
        {{ storeFailureText }}
      </p>
      <p
        v-if="error && !storeUnavailable"
        data-testid="error-hint"
        class="mt-4 rounded-bead-sm border-4 border-bead-ink bg-bead-warn-bg p-4 text-2xl text-bead-warn-ink"
      >
        {{ error }}
      </p>

      <ul data-testid="project-list" class="mt-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <li
          v-for="meta in projects"
          :key="meta.id"
          data-testid="project-card"
          class="relative min-w-0 rounded-bead-md border-4 border-bead-ink bg-bead-card shadow-pop-sm"
        >
          <div v-if="renamingId === meta.id" class="flex flex-col gap-3 p-3">
            <input
              v-model="renameDraft"
              data-testid="rename-input"
              :maxlength="PROJECT_NAME_MAX"
              class="min-h-14 w-full min-w-0 rounded-bead-sm border-4 border-bead-line bg-bead-card px-2 text-2xl text-bead-ink"
            />
            <BeadButton data-testid="rename-confirm" variant="primary" @click="confirmRename">好</BeadButton>
            <BeadButton variant="secondary" @click="renamingId = null">算了</BeadButton>
          </div>

          <template v-else>
            <!-- 卡片主体就是「打开工程」（§11.1）：整张卡是唯一的大动作，锚点在 button 上。
                 里面一律用 span + block，不用 p：button 的内容模型只收 phrasing content。 -->
            <button
              data-testid="open-project"
              type="button"
              class="block w-full text-left"
              @click="open(meta.id)"
            >
              <span class="flex h-32 w-full items-center justify-center overflow-hidden rounded-t-bead-sm bg-bead-board">
                <img v-if="meta.thumbnail" :src="meta.thumbnail" alt="" class="h-full w-full object-contain" />
                <span v-else class="text-xs text-bead-line-2">没有封面</span>
              </span>
              <span class="block p-3">
                <span data-testid="project-name" class="project-name text-2xl text-bead-ink">
                  {{ meta.name }}
                </span>
                <!-- 尺寸行与相对时间合成一行 12px 辅助信息（§7.1），`project-updated-at` 节点保留 -->
                <span data-testid="project-updated-at" class="block text-xs text-bead-line-2">
                  {{ meta.width }} × {{ meta.height }} · {{ meta.colorCount }} 色 ·
                  {{ formatRelativeTime(meta.updatedAt, new Date()) }}
                </span>
              </span>
            </button>

            <BeadButton
              data-testid="card-menu"
              variant="icon"
              class="absolute top-1 right-1"
              aria-label="图纸操作"
              @click="toggleMenu(meta)"
            >
              <PixelIcon name="gear" :size="24" />
            </BeadButton>
          </template>

          <!-- gear 展开的覆盖层（§7.1）：三个 56px 动作 + 关闭。点底片也能收起。 -->
          <div
            v-if="menuTarget?.id === meta.id"
            data-testid="card-menu-panel"
            class="fixed inset-0 z-10 flex items-center justify-center bg-bead-ink/40 p-4"
            @click.self="menuTarget = null"
          >
            <div
              class="flex w-full max-w-xs flex-col gap-3 rounded-bead-md border-4 border-bead-ink bg-bead-card p-4 shadow-pop-lg"
            >
              <div class="flex justify-end">
                <BeadButton variant="icon" aria-label="关闭" @click="menuTarget = null">
                  <PixelIcon name="close" :size="24" />
                </BeadButton>
              </div>
              <BeadButton data-testid="view-sheet" variant="primary" @click="openSheet(meta)">查看</BeadButton>
              <BeadButton data-testid="rename-project" variant="secondary" @click="startRename(meta)">
                改名
              </BeadButton>
              <BeadButton data-testid="delete-project" variant="danger" @click="askDelete(meta)">删除</BeadButton>
            </div>
          </div>
        </li>

        <!-- 空态：网格末位一张虚线卡片（§7.1），它自己就是新建入口 -->
        <li v-if="!error && !storeUnavailable && !hasProjects">
          <button
            data-testid="empty-hint"
            type="button"
            class="flex min-h-14 w-full flex-col items-center justify-center gap-2 rounded-bead-md border-4 border-dashed border-bead-line bg-bead-card p-4 text-bead-ink"
            @click="router.push({ name: 'pick' })"
          >
            <PixelIcon name="plus" :size="24" />
            <span class="text-2xl">新图纸</span>
          </button>
        </li>
      </ul>
    </div>

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
      class="fixed inset-0 z-20 flex items-center justify-center bg-bead-ink/40 p-4"
    >
      <div class="w-full max-w-md rounded-bead-md border-4 border-bead-ink bg-bead-card p-6 shadow-pop-lg">
        <p class="text-2xl text-bead-ink">确定删掉「{{ pendingDelete.name }}」吗？删了就找不回来了。</p>
        <div class="mt-6 flex gap-4">
          <BeadButton data-testid="delete-confirm" variant="danger" class="flex-1" @click="confirmDelete">
            删掉
          </BeadButton>
          <BeadButton
            data-testid="delete-cancel"
            variant="secondary"
            class="flex-1"
            @click="pendingDelete = null"
          >
            不删
          </BeadButton>
        </div>
      </div>
    </div>
  </main>
</template>
