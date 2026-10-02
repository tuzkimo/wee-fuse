<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { getProjectStore, type ProjectMeta, type ProjectStore } from "@/services/projectStore";

const router = useRouter();
const projects = ref<ProjectMeta[]>([]);
const usage = ref<{ usage: number; quota: number } | null>(null);
const storeUnavailable = ref(false);
const error = ref("");
const renamingId = ref<string | null>(null);
const renameDraft = ref("");
const pendingDelete = ref<ProjectMeta | null>(null);

const hasProjects = computed(() => projects.value.length > 0);

function formatMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function refresh(): Promise<void> {
  error.value = "";
  let store: ProjectStore;
  try {
    store = getProjectStore();
  } catch (e) {
    storeUnavailable.value = true;
    error.value = e instanceof Error ? e.message : String(e);
    return;
  }
  storeUnavailable.value = false;
  // 存储「注入了」不等于「读得出来」：隐私模式 / 配额用尽会在 `list` / `estimateUsage`
  // 里抛错。不接住就会变成一条未处理的 rejection + 一片空白的列表——正是「静默失败」。
  try {
    projects.value = await store.list();
    usage.value = await store.estimateUsage();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
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
        @click="router.push({ name: 'generate' })"
      >
        新建图纸
      </button>
    </header>

    <p v-if="storeUnavailable" data-testid="store-unavailable" class="mt-4 rounded bg-red-50 p-4 text-lg text-red-700">
      这个浏览器不允许本地保存（可能是隐私模式），所以暂时不能新建或打开图纸。
    </p>
    <p v-if="error && !storeUnavailable" class="mt-4 rounded bg-amber-50 p-4 text-lg text-amber-800">
      {{ error }}
    </p>

    <p v-if="!storeUnavailable && !hasProjects" data-testid="empty-hint" class="mt-8 text-lg text-slate-500">
      还没有图纸。点右上角「新建图纸」选一张图片开始吧。
    </p>

    <ul class="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <li
        v-for="meta in projects"
        :key="meta.id"
        data-testid="project-card"
        class="rounded-lg bg-white p-4 shadow"
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
          <p data-testid="project-name" class="truncate text-lg font-semibold text-slate-900">
            {{ meta.name }}
          </p>
          <p class="mt-1 text-base text-slate-500">{{ meta.width }} × {{ meta.height }} · {{ meta.colorCount }} 种颜色</p>
          <div class="mt-3 flex flex-wrap gap-3">
            <button data-testid="open-project" class="min-h-12 flex-1 rounded bg-slate-900 px-4 text-white" @click="open(meta.id)">
              打开
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

    <p v-if="usage" class="mt-8 text-base text-slate-500">
      已用 {{ formatMb(usage.usage) }} / 可用约 {{ formatMb(usage.quota) }}
    </p>

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
