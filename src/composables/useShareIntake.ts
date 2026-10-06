import { onUnmounted, ref, shallowRef, type Ref } from "vue";
import { NavigationFailureType, useRouter } from "vue-router";
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

/** 异常 → 提示条文案（`cause.message` 通常是中文前缀之下的英文细节，与 `probe.ts` 同口径）。 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 这次 `router.push` 是不是**被取消**（而不是成功、也不是「已经在目标页上」）。
 *
 * `push` 成功时 resolve `undefined`；被守卫拦下（`aborted`）或被新导航替换（`cancelled`）时 resolve
 * 一个 `NavigationFailure`；**用户已经在目标页上**时 resolve 的是 `duplicated`——那**不是**失败
 * （人在 `/new/setup` 上又分享一张，草稿要照改、页面不用动）⇒ 必须放行，否则会把刚落的草稿又回滚掉。
 *
 * **为什么不用 `isNavigationFailure`**：它要求 `error` 带 vue-router 内部的 `NavigationFailureSymbol`
 * （不在公开导出里，`node_modules/vue-router/dist/devtools-*.mjs` 的实现逐行如此）⇒ 用例里**造不出**
 * 一个能通过它的值，这一支会变成不可判别。这里按公开的 `NavigationFailureType` 数值判，判别力由用例
 * 给出（桩 `push` 分别 resolve `aborted` 与 `duplicated` 各一次）。
 */
function isNavigationCancelled(failure: unknown): boolean {
  const type = (failure as { readonly type?: unknown } | null | undefined)?.type;
  if (typeof type !== "number") return false;
  return (type & (NavigationFailureType.aborted | NavigationFailureType.cancelled)) !== 0;
}

/**
 * 分享进入的摄入链（规格 §5.3.6）。**在 `App.vue` 的 setup 顶层调用一次。**
 *
 * **为什么挂在 App 而不是某个页面**：分享进来时 App 可能停在任意页面（甚至刚被拉起）；
 * 摄入链要在**任何页面**都接得住，成功后统一跳 `/new/setup`。
 *
 * **两个入口一条链**：冷启动（`takeSharedImage`，取走即清）与热启动（`onSharedImage`）都进同一个
 * 同一 tick 缓冲（`batch` 的 JSDoc 写清了为什么必须归一）。
 *
 * **失败一律不落草稿**：与 `PickPage` 的既有纪律同源——留一个「有 source 没 preview」的半截状态，
 * 选区页会拿到空画布。
 *
 * **编辑器 dirty 时先不 adopt**：直接改草稿 + 跳路由会被编辑器守卫拦下，留下「草稿里有图、页面没动」
 * 的半截状态。所以暂存 + 提示条 + 「继续」；**代价是内存里留一张原图**，直到用户处理。
 * 解码要几秒、而 dirty 判定发生在解码**之前** ⇒ 解码期间用户可能刚把编辑器改脏、导航仍会被守卫拦下
 * ⇒ `push` 的返回值必须看（见 `isNavigationCancelled`），取消时回滚而不是留半截态。
 *
 * **「只摄取一次」落在哪一层（裁量口径，写清选了哪条）**：冷启动那一份的「取走即清」由平台层保证
 * （Rust `std::mem::take` ↔ `tauriPlatform.takeSharedImage` 消费掉 URI 数组），本文件在 setup 里
 * **恰好取一次**——于是重挂载（热重载、`/new` 来回切）拿到 `null`，草稿与路由都不再被碰。
 * **热启动刻意不去重**：一次事件 = 用户的一次新分享，去重会静默吞掉他真想转换的第二张图；
 * 「同一份事件只摄入一次」由**订阅面只有一处**保证（本 composable 只被装配一次）。
 *
 * **消费者 = 唯一生产装配点 `src/App.vue`**（`const share = useShareIntake()`，提示条读 `share.message` /
 * `share.pending` 并调 `retry` / `dismiss`）。判别力在 `__tests__/useShareIntake.test.ts`：内联宿主直持
 * 返回值（`pending` 的释放不在 DOM 上）+ 真 `App.vue`（提示条模板与装配）。**真机那一半**（系统分享真的
 * 唤得起来、URI 真的可读、取走即清、多图真的只给第一张）不在 CI 里，见规格 §9.4 与人工清单 4–6。
 */
export function useShareIntake(): ShareIntake {
  const router = useRouter();
  const draft = useDraft();
  const session = useProjectSession();
  const platform = getPlatform();

  const message = ref("");
  /**
   * 暂存的那份 `File`。**`shallowRef` 而不是 `ref`**——不是因为它今天会坏，而是因为「不透明的平台对象
   * 不该过响应式代理」这条口径不该依赖宿主实现：
   * Vue 的 `reactive()` 只深代理 `Object` / `Array`（`@vue/reactivity` 的 `targetTypeMap`，其余
   * `INVALID` 时原样返回），判定用 `Object.prototype.toString`；而 WebIDL 给**每个**接口都生成
   * `@@toStringTag` ⇒ 真机上 `File` 是 `[object File]`、**不**被代理。**happy-dom 的 `File` 没有这个
   * 标记**（实测 `[object Object]`）⇒ 只在用例环境里 `ref` 会把它代理掉，`pending.value !== file`
   * （变异 S1 实测 3 条断言红）。`shallowRef` 与 `Ref<File | null>` 兼容，且不影响提示条的 `v-if`。
   */
  const pending = shallowRef<File | null>(null);
  /** 与 `pending` 同行的那一份「还有几张没处理」（K2）：点「继续」之后仍要报出来。 */
  let pendingExtra = 0;

  /**
   * 「这一份**明确**不是图片」的判据（规格 §5.3.4 第 3 行：非图片 ⇒ 不摄入、草稿不动、提示条写明
   * 「只支持图片」）。
   *
   * **`application/octet-stream` 与空 type 必须放行**：`sniffImageType` 只认 PNG / JPEG / WEBP / HEIC，
   * GIF / BMP / AVIF 这些**本来能解码**的格式全部回落到 `application/octet-stream`
   * （`services/platform/sniffImageType.ts` 的签名表）——拒了就是把能用的图判成「不是图片」；
   * 空 type 同理（无信息 ≠ 不是图片）。
   *
   * **如实登记（这道闸门的射程；含 2026-10-06 控制者读生成的 `AndroidManifest.xml` 的核实）**：
   * ① 正常分享面板上**非图片根本不会把本 App 列为目标**（生成的三个 intent-filter 只覆盖
   * `image/png` / `image/jpeg` / `image/webp`，既没有 `image/*` 也没有 `*/*`）⇒ 这一支今天只在
   * **显式 intent** 或被 provider 谎报 MIME 的情况下可达；真到了这里，给出的正是规格那句
   * 「只支持图片」（在此之前它会落到解码失败，文案是「图片解码失败」，草稿一样不动、一样不跳转）。
   * ② 壳里 `File.type` 是嗅探结果（`tauriPlatform.ts` 的 `fileFromUri`），而嗅探对「一段纯文本」与
   * 「一张 GIF」给出**同一个**回落值 `application/octet-stream` ⇒ 若某条路把纯文本以 null-MIME 递进来，
   * 这里按上面的口径放行、由解码那一步失败并给出中文原因。
   */
  function isClearlyNotImage(type: string): boolean {
    if (type === "" || type === "application/octet-stream") return false;
    return !type.startsWith("image/");
  }

  /**
   * 「同一张图」的**近似**判据（同一 tick 归一与 state 排空后的去重都用它）。
   *
   * 依据：同一条 URI 会走两条道（冷取的 `takeSharedImage` 与热启动的 `opened` 事件），两条道各自
   * `readFileAsBytes` 一次并**各自 `new` 一个 `File`** ⇒ 对象身份永远不同，只能按指纹比：
   * 名字（URI 末段 + 嗅探扩展名）、字节数、MIME。三者全同而内容不同的概率可忽略；真撞上也无害——
   * 那一份本来就不会被摄入（多图只取第一张）。
   */
  function isSameImage(a: File, b: File): boolean {
    return a.name === b.name && a.size === b.size && a.type === b.type;
  }

  /**
   * 同一 tick 的归一缓冲。**为什么必须归一**（K2 / K3，Rust 侧「双道」）：
   * 1. 一次 `ACTION_SEND_MULTIPLE` 分享 N 张 ⇒ Rust 对**每个** URI 各 `emit("opened", …)`
   *    （`src-tauri/src/lib.rs` 收 intent 那一段）⇒ 热路径会收到 N 次回调；逐个摄入就是
   *    「N 次 adopt + N 次跳转、最后停在最后一张」✗，而规格要的是「只取第一张 + 提示条告知」。
   * 2. 同一段代码还把 URI push 进 `OpenedUris`（含热启动）⇒ **同一条 URI 可能既被冷取的
   *    `takeSharedImage` 拿到、又作为事件到达**（取决于 OS 交付与订阅的先后）⇒ 会摄入两次 ✗。
   * 所以两个入口（冷取的文件 + 热事件的文件）都进这一个缓冲，按 tick 归一后再处理。
   *
   * **为什么是微任务**：JS 里能看见的最小「同一批」单位就是**同一个任务**，而微任务检查点在该任务
   * 结束时必定执行 ⇒ 同批回调被合并，且**不会拖到下一次用户操作**。用户两次真正独立的分享之间必然
   * 隔着事件循环（分享面板 → IPC → 回调是另一个任务）⇒ 跨 tick 的两次分享**不会**被合并
   * （用例钉住：跨 tick 两次事件 = 两次摄入）。备选是 `setTimeout(…, 0)`，但那是宏任务、会被先排上的
   * 其它宏任务插队，测试里也因此要真等一个定时器（本仓禁用假定时器）⇒ 选微任务。
   * **如实登记**：若某个 WebView 把同一批 N 条 emit 拆到 N 个任务里交付，这一层就合不上，会退回
   * 「事件各自摄入」的老行为。备选方案（热事件只当信号、实体一律从 `takeSharedImage` 取）对多图免疫，
   * 但**依赖 Rust 侧 push 一定先于 emit 到达**，一旦时序变了就会**整份分享都丢**；两害相权取了
   * 「可能取到后一张」而不是「可能什么都不取」。
   */
  const batch: File[] = [];
  let batchExtra = 0;
  let batchFromHot = false;
  let scheduled = false;

  function enqueue(file: File, extraCount: number, fromHot: boolean): void {
    batchExtra += extraCount;
    batchFromHot = batchFromHot || fromHot;
    if (!batch.some((candidate) => isSameImage(candidate, file))) batch.push(file);
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      void flushBatch();
    });
  }

  async function flushBatch(): Promise<void> {
    const files = batch.splice(0, batch.length);
    const fromHot = batchFromHot;
    const dropped = batchExtra + Math.max(0, files.length - 1);
    batchExtra = 0;
    batchFromHot = false;
    const first = files[0];
    if (first === undefined) return;
    await intakeOrPark(first, dropped);
    // **K3：热路径处理完顺手把 state 排空。** Rust 对**每次** `RunEvent::Opened`（含热启动）都 push 进
    // `OpenedUris`，而本文件只在 setup 取一次 ⇒ 不排空的话，下一次 setup（WebView 重载 / Activity
    // 重建 / 热重载）会把它当冷启动**再摄一遍**，正是规格 §5.3.2 要消灭的「莫名其妙回到选区页」。
    // 排空拿到的通常就是刚处理过的那一张（同一条 URI 的第二条道）⇒ 按指纹跳过；不是同一张
    // （更早的一次分享还压在 state 里）⇒ 它才该被摄入。
    if (fromHot) await drainSharedState(files);
  }

  async function drainSharedState(handled: readonly File[]): Promise<void> {
    try {
      const taken = await platform.shareInbox.takeSharedImage();
      if (taken === null) return;
      if (handled.some((file) => isSameImage(file, taken.file))) return;
      await intakeOrPark(taken.file, taken.extraCount);
    } catch (error) {
      message.value = `分享的图片没能读取：${errorText(error)}`;
    }
  }

  async function intake(file: File, extraCount: number): Promise<void> {
    // 上一轮的提示先清掉：重试成功之后还留着「编辑还没保存」是最容易被漏掉的观感缺陷。
    message.value = "";
    if (isClearlyNotImage(file.type)) {
      message.value = "只支持图片";
      pending.value = null;
      pendingExtra = 0;
      return;
    }
    try {
      const loaded = await loadImageSource(file);
      draft.adoptImage({
        source: { blob: loaded.blob, type: loaded.type, name: loaded.name },
        sourceSize: loaded.sourceSize,
        preview: loaded.preview,
      });
      const failure = await router.push({ name: "setup" });
      if (isNavigationCancelled(failure)) {
        // **I1：导航被守卫拦下**（dirty 判定在数秒解码之前 ⇒ 这几秒里用户可能刚把编辑器改脏）。
        // 不回滚就是「已 adopt、没跳转、没提示」的半截状态——那正是「先不 adopt」要消灭的形态。
        // 回滚用 store 公开的 `reset()`：草稿此刻装的是这张分享图，还原成「还没选图」，
        // 并把这一份转成「继续」入口（用户处理完当前编辑就能再来一次）。
        draft.reset();
        pending.value = file;
        pendingExtra = extraCount;
        message.value = "分享的图片没能进入选区页（当前编辑还有未保存的改动）；草稿已还原，处理完再点「继续」。";
        return;
      }
      if (extraCount > 0) {
        // 规格 §5.3.4 第 2 行：多图**只取第一张**，且**告知**（其余不摄入、也不静默丢）。
        message.value = `已取第一张；这次分享里还有 ${extraCount} 张没有处理。`;
      }
    } catch (error) {
      // **不落草稿**：失败时草稿必须与「什么都没发生过」一致。
      message.value = `分享的图片没能处理：${errorText(error)}`;
    }
  }

  /** 摄入前先看「编辑器里有没有未保存的改动」——有就暂存，别把用户带走。 */
  async function intakeOrPark(file: File, extraCount: number): Promise<void> {
    if (router.currentRoute.value.name === "editor" && session.dirty) {
      pending.value = file;
      pendingExtra = extraCount;
      message.value = "收到一张分享的图片；当前编辑还没保存，处理完再点「继续」。";
      return;
    }
    await intake(file, extraCount);
  }

  let offShared: (() => void) | null = null;

  if (platform.shareInbox.supported) {
    // 热启动：**越早订阅越好**（App 启动时就订好），否则人在相册 App 里分享时接不住。
    offShared = platform.shareInbox.onSharedImage((file) => {
      enqueue(file, 0, true);
    });

    // 冷启动：那一份可能已经在 Rust 状态里等着了。**恰好一次**（「取走即清」是平台层的契约，
    // 本文件不自己记「我处理过没有」——那样会多出一份与平台层状态不同步的账）。
    // 它进的是同一个 tick 缓冲：同一次 intent 在 Rust 侧既 push state 又 emit ⇒ 冷取的这一份与
    // 同 tick 到达的事件可能是**同一条 URI**，归一到一起之后只摄入一次。
    void (async () => {
      try {
        const taken = await platform.shareInbox.takeSharedImage();
        if (taken !== null) enqueue(taken.file, taken.extraCount, false);
      } catch (error) {
        message.value = `分享的图片没能读取：${errorText(error)}`;
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
      // **I2：先消费再 await**。写成「先 await 再清」时连点两次会各自读到同一个 `pending`
      // ⇒ 解码两遍、跳转两次；消费在前也与「失败即释放」的口径自洽。
      const file = pending.value;
      const extra = pendingExtra;
      pending.value = null;
      pendingExtra = 0;
      if (file === null) return;
      await intake(file, extra);
    },
    dismiss(): void {
      pending.value = null;
      pendingExtra = 0;
      message.value = "";
    },
  };
}
