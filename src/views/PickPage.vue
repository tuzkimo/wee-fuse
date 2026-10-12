<script setup lang="ts">
// src/views/PickPage.vue
//
// `/new`：向导第一步——选图。B2 只做浏览器文件选择；相机 / 系统相册 / 系统分享 target 是
// 真机能力（浏览器里无法验证），按 B1 规格 §2 的约定留到引入 Tauri 壳的那一轮。
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import BeadButton from "@/components/ui/BeadButton.vue";
import PixelIcon from "@/components/ui/PixelIcon.vue";
import { getPlatform } from "@/services/platform/capabilities";
import { fileFromInput, loadImageSource } from "@/services/imageSource";
import { useDraft } from "@/stores/draft";
import { backOrHome } from "@/views/backOrHome";

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
  <main class="min-h-screen bg-bead-sand">
    <!-- 顶栏：与图纸库同一口径（手机 64px / 平板 80px，`bead-sand-2` 底 + 4px `bead-line` 底边）。
         返回箭头走 `backOrHome`：选图页是流程第一页，上一页若是一条已作废的流程条目就该回图纸库。 -->
    <header
      class="flex h-16 items-center gap-4 border-b-4 border-bead-line bg-bead-sand-2 px-4 md:h-20 md:px-8"
    >
      <BeadButton data-testid="pick-back" variant="icon" aria-label="返回" @click="backOrHome(router)">
        <PixelIcon name="back" :size="24" />
      </BeadButton>
      <h1 class="text-[24px] text-bead-ink md:text-[36px]">选照片</h1>
    </header>

    <div class="space-y-6 p-4 md:p-8">
      <section class="space-y-4">
        <template v-if="useNativePicker">
          <!-- 壳里：入口由系统选择器 / 相机提供，页面里不放可见 input（规格 §7.1）。 -->
          <!-- `shadow-pop-lg!` 的 `!` 是必须的：BeadButton 的 primary 变体自带 `shadow-pop-md`，
               两个工具类同特异性、`md` 在产物 CSS 里排在 `lg` 之后，不加 `!` 压不过去。 -->
          <BeadButton
            data-testid="pick-album"
            variant="primary"
            aria-label="从相册选一张"
            :disabled="busy"
            class="w-full shadow-pop-lg!"
            @click="pickNative('album')"
          >
            <PixelIcon name="photos" :size="36" />
            <!-- 36px 写在内层节点上：BeadButton 的 primary 自带 24px，靠同名工具类的生成顺序盖不住。 -->
            <span class="text-[36px]">{{ busy ? "正在读取…" : "从相册选一张" }}</span>
          </BeadButton>
          <BeadButton
            v-if="canCapture"
            data-testid="pick-camera"
            variant="secondary"
            :disabled="busy"
            class="w-full"
            @click="pickNative('camera')"
          >
            拍一张
          </BeadButton>
        </template>
        <template v-else>
          <!-- 浏览器那条老路：可见 input + 下一步。**一个字都不改**（既有 8 条用例钉着它）。 -->
          <label
            class="block rounded-bead-sm border-4 border-bead-ink bg-bead-card p-4 text-[24px] text-bead-ink"
          >
            选一张图片
            <input
              ref="fileInput"
              data-testid="file-input"
              type="file"
              accept="image/*"
              class="mt-2 block w-full text-[12px] text-bead-ink"
            />
          </label>

          <BeadButton
            data-testid="pick-file"
            variant="primary"
            aria-label="下一步"
            :disabled="busy"
            class="w-full shadow-pop-lg!"
            @click="pick"
          >
            <PixelIcon name="photos" :size="36" />
            <span class="text-[36px]">{{ busy ? "正在读取…" : "下一步" }}</span>
          </BeadButton>
        </template>

        <BeadButton
          v-if="canResume"
          data-testid="resume-draft"
          variant="secondary"
          class="w-full"
          @click="resume"
        >
          继续上次的选区
        </BeadButton>
      </section>

      <!--
        下半屏照片网格（§7.2）。**目前恒为空态**：平台接口只有 `pickFromAlbum` / `capturePhoto`，
        没有枚举最近照片的能力（规格 §4.1），所以没有可 v-for 的数据源——只有那张虚线占位格。
        将来接上相册枚举时，在这里渲染 <li> 格子（每格 `border-4 border-bead-ink` + `rounded-bead-sm`）。
      -->
      <ul data-testid="pick-grid" class="grid grid-cols-2 gap-4 md:grid-cols-4">
        <li
          data-testid="pick-empty"
          class="flex aspect-square flex-col items-center justify-center gap-2 rounded-bead-sm border-4 border-dashed border-bead-ink text-bead-line-2"
        >
          <PixelIcon name="photos" :size="36" />
          <span class="text-[12px]">还没有照片</span>
        </li>
      </ul>

      <!-- role="alert"：失败原因要立刻被读屏念出来，而不是等用户摸到那一行才知道。 -->
      <p
        v-if="error"
        data-testid="pick-error"
        role="alert"
        class="rounded-bead-sm border-4 border-bead-ink bg-bead-warn-bg p-4 text-[24px] text-bead-warn-ink"
      >
        {{ error }}
      </p>
    </div>
  </main>
</template>
