import { onUnmounted, ref, shallowRef, type Ref } from "vue";
import { useRouter } from "vue-router";
import { loadImageSource } from "@/services/imageSource";
import { getPlatform } from "@/services/platform/capabilities";
import { useDraft } from "@/stores/draft";
import { useProjectSession } from "@/stores/project";

/** 提示条要用的状态。**页面只读它、调 `retry` / `dismiss`**，摄入逻辑全在本文件里。 */
export interface ShareIntake {
  /** 空串 = 不显示提示条。 */
  readonly message: Ref<string>;
  /** 编辑器有未保存改动时暂存的那一份分享（非空时提示条给「继续」按钮）。 */
  readonly pending: Ref<File | null>;
  /** 「继续」：重试摄入暂存的那一份。 */
  retry(): Promise<void>;
  /** 「知道了」：丢弃暂存并清空提示（**释放那张原图的引用**）。 */
  dismiss(): void;
}
/**
 * 分享进入的摄入链（规格 §5.3.6）。**在 `App.vue` 的 setup 顶层调用一次。**
 *
 * **为什么挂在 App 而不是某个页面**：分享进来时 App 可能停在任意页面（甚至刚被拉起）；
 * 摄入链要在**任何页面**都接得住，成功后统一跳 `/new/setup`。
 *
 * **两个入口一条链**：冷启动（`takeSharedImage`，取走即清）与热启动（`onSharedImage`）都进 `intake()`。
 *
 * **失败一律不落草稿**：与 `PickPage` 的既有纪律同源——留一个「有 source 没 preview」的半截状态，
 * 选区页会拿到空画布。
 *
 * **编辑器 dirty 时先不 adopt**：直接改草稿 + 跳路由会被编辑器守卫拦下，留下「草稿里有图、页面没动」
 * 的半截状态。所以暂存 + 提示条 + 「继续」；**代价是内存里留一张原图**，直到用户处理。
 *
 * **「只摄取一次」落在哪一层（裁量口径，写清选了哪条）**：冷启动那一份的「取走即清」由平台层保证
 * （Rust `std::mem::take` ↔ `tauriPlatform.takeSharedImage` 消费掉 URI 数组），本文件在 setup 里
 * **恰好取一次**——于是重挂载（热重载、`/new` 来回切）拿到 `null`，草稿与路由都不再被碰。
 * **热启动刻意不去重**：一次事件 = 用户的一次新分享，去重会静默吞掉他真想转换的第二张图；
 * 「同一份事件只摄入一次」由**订阅面只有一处**保证（本 composable 只被装配一次）。
 *
 * **消费者 = `views/ShellProbePage.vue` 之外的唯一生产装配点 `src/App.vue`**（`const share = useShareIntake()`，
 * 提示条读 `share.message` / `share.pending` 并调 `retry` / `dismiss`）。判别力在
 * `__tests__/useShareIntake.test.ts`：内联宿主直持返回值（`pending` 的释放不在 DOM 上）+ 真 `App.vue`
 * （提示条模板与装配）。**真机那一半**（系统分享真的唤得起来、URI 真的可读、取走即清）不在 CI 里，
 * 见规格 §9.4 与人工清单 4–6。
 */
export function useShareIntake(): ShareIntake {
  const router = useRouter();
  const draft = useDraft();
  const session = useProjectSession();
  const platform = getPlatform();

  const message = ref("");
  /**
   * 暂存的那份 `File`。**`shallowRef` 而不是 `ref`**（与计划正文的一处刻意偏差，见报告）：
   * `ref` 会把 `File` 深代理，于是 `retry()` 交给 `loadImageSource` 的是**另一个对象**
   * （Vue 的 `reactive` 代理，`pending.value !== file`），而它下一步就进 `URL.createObjectURL`。
   * 实测（本任务用例）`ref` 版下「`createObjectURL` 收到的是那颗原样的 `File`」这条断言红。
   * **未验的部分如实登记**：WebView 对这些平台对象是否做 brand check（Node 的
   * `URL.createObjectURL` 接受代理）本轮没有读数，已记入报告的人工清单待办。
   * `shallowRef` 与 `Ref<File | null>` 兼容，且不影响提示条的 `v-if`（赋值一样触发更新）。
   */
  const pending = shallowRef<File | null>(null);

  async function intake(file: File): Promise<void> {
    // 上一轮的提示先清掉：重试成功之后还留着「编辑还没保存」是最容易被漏掉的观感缺陷。
    message.value = "";
    try {
      const loaded = await loadImageSource(file);
      draft.adoptImage({
        source: { blob: loaded.blob, type: loaded.type, name: loaded.name },
        sourceSize: loaded.sourceSize,
        preview: loaded.preview,
      });
      await router.push({ name: "setup" });
      pending.value = null;
    } catch (error) {
      // **不落草稿**：失败时草稿必须与「什么都没发生过」一致。
      message.value = `分享的图片没能处理：${error instanceof Error ? error.message : String(error)}`;
      pending.value = null;
    }
  }

  /** 摄入前先看「编辑器里有没有未保存的改动」——有就暂存，别把用户带走。 */
  async function intakeOrPark(file: File): Promise<void> {
    if (router.currentRoute.value.name === "editor" && session.dirty) {
      pending.value = file;
      message.value = "收到一张分享的图片；当前编辑还没保存，处理完再点「继续」。";
      return;
    }
    await intake(file);
  }

  let offShared: (() => void) | null = null;

  if (platform.shareInbox.supported) {
    // 热启动：**越早订阅越好**（App 启动时就订好），否则人在相册 App 里分享时接不住。
    offShared = platform.shareInbox.onSharedImage((file) => {
      void intakeOrPark(file);
    });

    // 冷启动：那一份可能已经在 Rust 状态里等着了。**恰好一次**——「取走即清」是平台层的契约，
    // 本文件不自己记「我处理过没有」（那样会多出一份与平台层状态不同步的账）。
    void (async () => {
      try {
        const file = await platform.shareInbox.takeSharedImage();
        if (file !== null) await intakeOrPark(file);
      } catch (error) {
        message.value = `分享的图片没能读取：${error instanceof Error ? error.message : String(error)}`;
      }
    })();
  }

  // **必须在 setup 同步执行期被收集**（`App.vue` 顶层调用本函数），否则这个解绑永远不跑。
  onUnmounted(() => {
    offShared?.();
  });

  return {
    message,
    pending,
    async retry(): Promise<void> {
      const file = pending.value;
      if (file === null) return;
      await intake(file);
    },
    dismiss(): void {
      pending.value = null;
      message.value = "";
    },
  };
}
