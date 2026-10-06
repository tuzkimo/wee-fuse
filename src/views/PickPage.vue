<script setup lang="ts">
// src/views/PickPage.vue
//
// `/new`：向导第一步——选图。B2 只做浏览器文件选择；相机 / 系统相册 / 系统分享 target 是
// 真机能力（浏览器里无法验证），按 B1 规格 §2 的约定留到引入 Tauri 壳的那一轮。
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { getPlatform } from "@/services/platform/capabilities";
import { fileFromInput, loadImageSource } from "@/services/imageSource";
import { useDraft } from "@/stores/draft";

const router = useRouter();
const draft = useDraft();
const fileInput = ref<HTMLInputElement | null>(null);
const error = ref("");
const busy = ref(false);

/**
 * 平台决定的入口形态（规格 §5.1）：浏览器 = 页面里那个可见 input（老路，一行不动）；
 * 壳里 = 两个按钮（`native-picker`）。**判断只读一次**：`kind` / `canCapture` 都是同步字段
 * （规格 §4.1），装配期读出来存进常量，避免模板里反复调 `getPlatform()`。
 */
const platform = getPlatform();
const useNativePicker = platform.imagePicking.kind === "native-picker";
const canCapture = platform.imagePicking.canCapture;

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

/**
 * 壳里的一条路：取图（相册或拍照）→ 解码 → 落草稿 → 进选区页。
 *
 * **与 `pick()` 共用同一条后续**（`loadImageSource` → `adoptImage` → `push setup`）：两条入口的差别
 * 只在「怎么拿到 `File`」，**解码与草稿语义必须完全一致**——这正是本任务存在的理由。
 * **取消是正常操作**（`null`）⇒ 静默返回，不写 `error`；**抛错才提示**，且不留半截草稿。
 * `busy` 闸门与 `pick()` 同源（同一 tick 连点两次只处理一次）。
 */
async function pickNative(source: "album" | "camera"): Promise<void> {
  // 重入闸门与 `pick()` 同源：`disabled` 要等 Vue patch 完 DOM 才生效，而壳里的选择器是异步的
  // （用户可能在系统界面里停留很久），没有这道闸门就会解码两遍、跳转两次。
  if (busy.value) return;
  error.value = "";

  busy.value = true;
  try {
    const file =
      source === "album"
        ? await platform.imagePicking.pickFromAlbum()
        : await platform.imagePicking.capturePhoto();
    // 取消（`null`）不是失败：不报错、不跳转、不动草稿。
    if (file === null) return;

    const loaded = await loadImageSource(file);
    draft.adoptImage({
      source: { blob: loaded.blob, type: loaded.type, name: loaded.name },
      sourceSize: loaded.sourceSize,
      preview: loaded.preview,
    });
    await router.push({ name: "setup" });
  } catch (e) {
    // 与 `pick()` 同一口径：失败时不落任何草稿，只把中文原因显示出来。
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main class="min-h-screen bg-slate-50 p-4 md:p-8">
    <h1 class="text-3xl font-bold text-slate-900">新建图纸</h1>
    <p class="mt-2 text-lg text-slate-600">先选一张照片，下一步框出想拼的那块。</p>

    <section class="mt-6 space-y-6">
      <template v-if="useNativePicker">
        <!-- 壳里：入口由系统选择器 / 相机提供，页面里不放可见 input（规格 §7.1）。 -->
        <button
          data-testid="pick-album"
          class="block min-h-14 w-full rounded bg-slate-900 px-8 text-lg text-white disabled:opacity-50"
          :disabled="busy"
          @click="pickNative('album')"
        >
          {{ busy ? "正在读取…" : "从相册选一张" }}
        </button>
        <button
          v-if="canCapture"
          data-testid="pick-camera"
          class="mt-3 block min-h-14 w-full rounded border border-slate-300 px-8 text-lg disabled:opacity-50"
          :disabled="busy"
          @click="pickNative('camera')"
        >
          拍一张
        </button>
      </template>
      <template v-else>
        <!-- 浏览器那条老路：可见 input + 下一步。**一个字都不改**（既有 8 条用例钉着它）。 -->
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
      </template>

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
