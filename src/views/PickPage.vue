<script setup lang="ts">
// src/views/PickPage.vue
//
// `/new`：向导第一步——选图。B2 只做浏览器文件选择；相机 / 系统相册 / 系统分享 target 是
// 真机能力（浏览器里无法验证），按 B1 规格 §2 的约定留到引入 Tauri 壳的那一轮。
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { fileFromInput, loadImageSource } from "@/services/imageSource";
import { useDraft } from "@/stores/draft";

const router = useRouter();
const draft = useDraft();
const fileInput = ref<HTMLInputElement | null>(null);
const error = ref("");
const busy = ref(false);

/** 草稿里还留着上次中途退出的图（选区页的 `onLeaveSetup` 只释放预览、保留 source）。 */
const canResume = computed(() => draft.source !== null);

async function pick(): Promise<void> {
  // 重入闸门：`disabled` 要等 Vue patch 完 DOM（微任务）才生效，同一 tick 内的第二次派发看到的
  // 按钮仍是可用的——没有这道闸门就会解码两遍、`adoptImage` 两次、跳转两次。
  if (busy.value) return;
  error.value = "";

  const picked = fileFromInput(fileInput.value);
  if (!picked.ok) {
    // 快校验挡在解码之前：空文件不该先建一个 object URL、再解码失败才报错。
    error.value = picked.reason;
    return;
  }

  busy.value = true;
  try {
    const loaded = await loadImageSource(picked.file);
    draft.adoptImage({
      source: { blob: loaded.blob, type: loaded.type, name: loaded.name },
      sourceSize: loaded.sourceSize,
      preview: loaded.preview,
    });
    await router.push({ name: "setup" });
  } catch (e) {
    // 失败时不落任何草稿：留下「有 source 没 preview」的半截状态会让选区页拿到空画布。
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

function resume(): void {
  void router.push({ name: "setup" });
}
</script>

<template>
  <main class="min-h-screen bg-slate-50 p-4 md:p-8">
    <h1 class="text-3xl font-bold text-slate-900">新建图纸</h1>
    <p class="mt-2 text-lg text-slate-600">先选一张照片，下一步框出想拼的那块。</p>

    <section class="mt-6 space-y-6">
      <label class="block text-lg text-slate-800">
        选一张图片
        <input
          ref="fileInput"
          data-testid="file-input"
          type="file"
          accept="image/*"
          class="mt-2 block text-base"
        />
      </label>

      <button
        data-testid="pick-file"
        class="min-h-14 rounded bg-slate-900 px-8 text-lg text-white disabled:opacity-50"
        :disabled="busy"
        @click="pick"
      >
        {{ busy ? "正在读取…" : "下一步" }}
      </button>

      <button
        v-if="canResume"
        data-testid="resume-draft"
        class="ml-4 min-h-14 rounded border border-slate-300 px-8 text-lg"
        @click="resume"
      >
        继续上次的选区
      </button>
    </section>

    <!-- role="alert"：失败原因要立刻被读屏念出来，而不是等用户摸到那一行才知道。 -->
    <p
      v-if="error"
      data-testid="pick-error"
      role="alert"
      class="mt-4 rounded bg-amber-50 p-4 text-lg text-amber-800"
    >
      {{ error }}
    </p>
  </main>
</template>
