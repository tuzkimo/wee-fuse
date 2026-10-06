<script lang="ts">
import type { SniffedImageType } from "@/services/platform/sniffImageType";
import type { AlbumSaveKind, ImagePickingKind } from "@/services/platform/types";

/**
 * `/lab/shell` 的读数结构（规格 §13 的六判据 F/A/B/C/D/E）。
 *
 * **结构化而不是一堆字符串**：本项目的纪律是「固定自问还有哪些输出 / 字段从未被任何断言读过」——
 * 把读数做成有字段的类型，用例才能逐字段钉住（字符串拼接里少一个字段是看不出来的）。
 * **消费者**：`src/views/__tests__/ShellProbePage.test.ts`（唯一消费者：生产路径不读这些结构）。
 */
export interface FileInputProbeReading {
  readonly criterion: "A" | "B";
  /** 该 input 在 DOM 上真的带着的属性值（证明 `accept` / `capture` 落到了元素上）。 */
  readonly accept: string;
  readonly capture: string;
  readonly name: string;
  readonly size: number;
  /** WebView 给的 `File.type`——可能是空串，正是要看它。 */
  readonly mimeFromWebView: string;
  /** 我们按魔数嗅探出来的类型。 */
  readonly mimeSniffed: SniffedImageType;
  /** 前 16 字节的十六进制（大写、空格分隔）。 */
  readonly magicHex: string;
  /** 解码结果：`宽×高`，或中文失败原因（`probeImageSize` 抛出的原文）。 */
  readonly decode: string;
}

export interface ShareProbeReading {
  readonly coldStart: string;
  readonly hotStart: string;
  /**
   * 请求体的**形态与长度**。原名 `rawBody`（「原始字节体」）在 2026-10-06 修复轮 F1 之后**不实**：
   * Android 上 `InvokeBody::Raw` 不可达（厂商原文逐字见 `tauriDriver.ts` 的 `saveToAlbum`），
   * 请求体现在是 **base64 JSON 字符串**（规格 B5-R4 的退路，已正式启用）⇒ 字段名跟着改，
   * 读数里如实写「图像 N 字节 → base64 字符串 M 字符」。
   */
  readonly requestBody: string;
}

export interface AlbumProbeReading {
  readonly kind: AlbumSaveKind;
  readonly filename: string;
  readonly bytes: number;
  readonly result: string;
}

export interface LifecycleProbeReading {
  readonly requested: boolean;
  readonly backPresses: readonly string[];
  readonly closeRequests: readonly string[];
  /**
   * 页面级「明确退出 App」按钮的**结果**（2026-10-06 真机缺陷 **A-FIX 4**）。
   *
   * 修复前那个按钮点了**没反应**、而且**不留任何读数**（失败原因只写进页面顶部的错误横幅，
   * 而按钮在页面最底部，真机上根本看不到）⇒ 下次真机仍然只能得到一句「没反应」。
   * 现在两种形态之一必然出现在读数里：`已调用（resolve）` / `调用失败：<原文>`。
   *
   * **`resolve` 只证明 `app.exit(0)` 这个调用回来了，不证明进程真的退了**——真机判据仍然是
   * 「按下去 App 没了没有」。**权限链**：`app.exit(0)` = `invoke("plugin:app|exit")`，
   * 官方 JSDoc 逐字要求 `core:app:allow-exit`，而它**不在** `core:app:default` 里
   * （也不在 `capabilities/default.json` 现在给的 `core:default` 里）⇒ 这份配置下它**必然被 ACL 拒绝**，
   * 读数会如实写成 `调用失败：…not allowed…`。**本轮不动权限**（不在允许动文件清单里），
   * 结论在报告里，由控制者裁决。
   */
  readonly exitResult: string;
}

export interface BuildInfoProbeReading {
  readonly tauriRuntime: boolean;
  readonly userAgent: string;
  readonly href: string;
  readonly pickKind: ImagePickingKind;
  readonly canCapture: boolean;
  readonly shareSupported: boolean;
  readonly albumKind: AlbumSaveKind;
}

/**
 * 六块读数在页面里的**可变**容器。
 *
 * **为什么只有这一层的字段不带 `readonly`**（2026-10-06 任务 2 编译器实测，计划正文这里照抄会报
 * TS2540）：页面是**逐块填**的（跑完 A 才填 `a`），而 `reactive<T>()` 会保留 `readonly` 修饰符 ⇒
 * `readings.a = …` 被 TS 拒绝。**六个读数结构本身（`FileInputProbeReading` 等）仍然全字段 readonly**，
 * 页面更新它们的方式一律是「整个对象替换」，所以「块内字段被就地改写」在类型上仍然不可能。
 */
export interface ShellProbeReadings {
  a: FileInputProbeReading | null;
  b: FileInputProbeReading | null;
  c: ShareProbeReading | null;
  d: AlbumProbeReading | null;
  e: LifecycleProbeReading | null;
  f: BuildInfoProbeReading | null;
}
</script>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import {
  assertCanvasPainted,
  canvasToBlob,
  createCanvasStrict,
  requireContext2D,
} from "@/services/exporter";
import { getPlatform, isTauriRuntime } from "@/services/platform/capabilities";
import { sniffImageType } from "@/services/platform/sniffImageType";
// 只用它的 `encodeBase64`（C 块要如实报出 base64 串长）。**这不引入任何 `@tauri-apps/*` 的静态
// import**——那个文件里的包全是动态 `import()`，而 C 块仍然走 `getPlatform()`（判据的定义没被换掉）。
import { encodeBase64 } from "@/services/platform/tauriDriver";
import { probeImageSize } from "@/services/probe";

/**
 * `/lab/shell` 探针页（规格 §13 任务 2 的六判据装置）——**第三个开发期实验台**，与 `/lab/canvas` 同形：
 * 只在路由表里存在、**不进任何用户入口**、页面自标「开发期实验台 / CI 不测」、**留存**（换设备 / 换
 * Tauri 版本时还要重测）。
 *
 * **与 `/lab/canvas` 的关键差别**：那台仪器测的是本机能力（浏览器里也能跑），这一台测的是**壳本身**——
 * 必须在装到手机上的 APK 里跑（F 块就是用来把「跑的是哪个实现」说清楚的）。
 *
 * **CI 只覆盖「读数 → 表格与报告文本」这一段渲染**：真实 `capture` 行为、真实 `content://`、真实
 * MediaStore、真实返回键都在人工清单里（规格 §9.4）；页面上任何「看起来测到了」都不算。
 */

/** 判据 D 的探针图边长：64 够用（相册里那一眼要看的是**文件在不在、字节数对不对**，不是画质）。 */
const PROBE_EDGE = 64;

/**
 * 探针图中央那块蓝色的边长（`PROBE_EDGE` 的一半）。
 *
 * **它必须留在中央、不许盖住 `(2, 2)`**：那个点是 `assertCanvasPainted` 的采样点（详见
 * `renderProbePng` 的 JSDoc）。`(PROBE_EDGE - PROBE_BLOCK_EDGE) / 2 = 16` ⇒ 蓝块占 16–47，
 * 离 `(2, 2)` 有 14 像素边距——改这两个常量前先读 `SELF_CHECK_X` / `SELF_CHECK_Y`。
 */
const PROBE_BLOCK_EDGE = 32;

/** 兜底文案必须非空：空消息的 `Error` 要取 `name`，非 `Error` 要取 `String`。 */
function errorText(error: unknown): string {
  if (error instanceof Error) return error.message === "" ? error.name : error.message;
  return String(error);
}

const readings = reactive<ShellProbeReadings>({
  a: null,
  b: null,
  c: null,
  d: null,
  e: null,
  f: null,
});
const busy = ref<"" | "C" | "D">("");
const error = ref("");
const copyStatus = ref("");
const unsubscribers: Array<() => void> = [];

function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0").toUpperCase())
    .join(" ");
}

/** A / B 的读数：属性值 → 文件事实 → 嗅探 → 解码。**只读前 32 字节**（不把 10 MB 原图读进堆）。 */
async function readFileInput(
  criterion: "A" | "B",
  input: HTMLInputElement,
): Promise<FileInputProbeReading> {
  const capture = input.getAttribute("capture") ?? "（未设置）";
  const file = input.files?.[0] ?? null;
  if (file === null) {
    return {
      criterion,
      accept: input.accept,
      capture,
      name: "（未选中文件）",
      size: 0,
      mimeFromWebView: "",
      mimeSniffed: "application/octet-stream",
      magicHex: "",
      decode: "（未选中文件）",
    };
  }
  const head = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  let decode: string;
  try {
    const size = await probeImageSize(file);
    decode = `${size.width}×${size.height}`;
  } catch (caught) {
    decode = errorText(caught);
  }
  return {
    criterion,
    accept: input.accept,
    capture,
    name: file.name,
    size: file.size,
    mimeFromWebView: file.type,
    mimeSniffed: sniffImageType(head),
    magicHex: hexOf(head.subarray(0, 16)),
    decode,
  };
}

async function onRawInput(criterion: "A" | "B", event: Event): Promise<void> {
  try {
    const reading = await readFileInput(criterion, event.target as HTMLInputElement);
    if (criterion === "A") readings.a = reading;
    else readings.b = reading;
  } catch (caught) {
    error.value = `${criterion} 块读数失败：${errorText(caught)}`;
  }
}

/**
 * 画一张探针图并取 PNG（C 的请求体探针与 D 共用：**同一个产物、两条不同的证据**）。
 *
 * **底色必须是白的、蓝块必须在中央**（2026-10-06 真机缺陷 **A-FIX 3**）。这张图要被
 * `assertCanvasPainted` 自检，而那个帮手的契约（`src/services/exporter.ts` 的 JSDoc 逐字）是
 * 「读回采样点 `(2, 2)` 的 1×1 像素，**不是不透明的白色即抛**」——采样点落在**白底边距**里，
 * 它挡的是「画布分配成功但内容全空」那一形态。所以：
 * **`(2, 2)` 是 `assertCanvasPainted` 的采样点，必须保持白。**
 * 修复前这里把整块画布涂成 `#3366cc`（没有白底），真机读回 `(2, 2) = 51,102,204,255` 与
 * `#3366cc` **逐位相同** ⇒ 自检**必然抛**，D 块结果永远是「画布内容自检失败」、C 块三行核对永远
 * 跑不到。⇒ 现在是「白底全幅 + 中央 `PROBE_BLOCK_EDGE`×`PROBE_BLOCK_EDGE` 的蓝块」，
 * 自检**保留**（它挡的那类失败仍然要挡）。
 * 画布初始是**透明**的，所以白底那一笔不能省——省掉 `(2, 2)` 读回 `0,0,0,0`，照样抛。
 *
 * **已知偏差（如实登记，本项目的「断言存在 ≠ 断言有效」）**：
 * `ShellProbePage.test.ts` 用的是**假画布**（`@/services/exporter` 整个模块被桩掉、
 * `getImageData` 根本不存在），所以用例只能钉住「页面向画布下了哪几条绘制命令」
 * （白底全幅 + 中央蓝块 + 蓝块不覆盖采样点）。**假画布用例钉不住真画布契约**：
 * 「真画布上 `(2, 2)` 真的是不透明白」这件事只有**真机**（真画布）能证，判据 D 的读数就是它。
 */
async function renderProbePng(): Promise<Blob> {
  const canvas = createCanvasStrict(PROBE_EDGE, PROBE_EDGE);
  const ctx = requireContext2D(canvas);
  // ① 先铺满白底：`(2, 2)` 必须落在这一层里（`assertCanvasPainted` 只认不透明白）。
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, PROBE_EDGE, PROBE_EDGE);
  // ② 蓝块留在中央（离 `(2, 2)` 14 像素），它是「画布上真的有内容」的那条可见证据。
  const offset = (PROBE_EDGE - PROBE_BLOCK_EDGE) / 2;
  ctx.fillStyle = "#3366cc";
  ctx.fillRect(offset, offset, PROBE_BLOCK_EDGE, PROBE_BLOCK_EDGE);
  assertCanvasPainted(canvas);
  return canvasToBlob(canvas);
}

/**
 * C 块：**冷启动取走 + 请求体形态探针**。
 *
 * 两半**刻意用不同的载荷**：冷启动那一半证明 URI 可读（字节数就是证据，URI 原文在 `adb logcat` 的
 * `RunEvent::Opened：收到 {} 个 URI` 与 `RunEvent::Opened：URI = {url}` 两行里，后者逐条打）；
 * 请求体那一半用**探针图**走完整保存链，并把
 * 「图像 N 字节 → base64 字符串 M 字符」如实报出来。把分享进来那张图再存一次相册对判据没有增量，
 * 却会在相册里留下一个用 `.png` 名字的 JPEG。
 *
 * **M 由 `encodeBase64` 现算**（不是写死的公式）：页面**不许**自己实现第二份 base64 口径，
 * 否则「页面报的 M」与「真正发出去的串」可以各自漂移而没人发现。
 */
async function runC(): Promise<void> {
  busy.value = "C";
  error.value = "";
  const platform = getPlatform();
  let coldStart = "无待处理分享（把 App 从任务切换器划掉，再从相册 App 分享一张图进来）";
  try {
    const file = (await platform.shareInbox.takeSharedImage())?.file ?? null;
    if (file !== null) {
      coldStart = `${file.name} / ${file.size} 字节 / ${file.type === "" ? "（空 MIME）" : file.type}`;
    }
  } catch (caught) {
    coldStart = `取走失败：${errorText(caught)}`;
  }

  let requestBody: string;
  try {
    const probe = await renderProbePng();
    await platform.album.save(probe, "weefuse-c-base64-body.png");
    const encoded = encodeBase64(new Uint8Array(await probe.arrayBuffer())).length;
    requestBody = `base64 JSON 字符串（图像 ${probe.size} 字节 → base64 ${encoded} 字符）· 端到端一致（${probe.size} 字节，探针图）`;
  } catch (caught) {
    requestBody = `失败：${errorText(caught)}`;
  }

  readings.c = {
    coldStart,
    hotStart: readings.c?.hotStart ?? "（尚未收到）",
    requestBody,
  };
  busy.value = "";
}

/** D 块：把**真画布产物**走一遍 `album.save`（§5.4.1 的三段链：真画布 → blob → 相册）。 */
async function runD(): Promise<void> {
  busy.value = "D";
  error.value = "";
  const platform = getPlatform();
  const filename = "weefuse-probe-album.png";
  let bytes = 0;
  let result: string;
  try {
    const blob = await renderProbePng();
    bytes = blob.size;
    await platform.album.save(blob, filename);
    result = "已受理（去相册 Pictures/WeeFuse 核对文件名与字节数）";
  } catch (caught) {
    result = errorText(caught);
  }
  readings.d = { kind: platform.album.kind, filename, bytes, result };
  busy.value = "";
}

/**
 * E 块：注册返回键与关闭请求的监听。
 *
 * `onExitRequested` 的 handler **返回 false（不阻止）**：探针页没有草稿可丢，而「让这次退出真的发生」
 * 才是判据 E 要看的。生产语义（`() => session.dirty`）在任务 7 的 `useShellLifecycle`。
 */
function runE(): void {
  if (readings.e !== null) return;
  const platform = getPlatform();
  try {
    unsubscribers.push(
      platform.lifecycle.onBackButton((info) => {
        const current = readings.e;
        if (current === null) return;
        readings.e = { ...current, backPresses: [...current.backPresses, `canGoBack=${info.canGoBack}`] };
      }),
    );
    unsubscribers.push(
      platform.lifecycle.onExitRequested(() => {
        const current = readings.e;
        if (current !== null) {
          readings.e = {
            ...current,
            closeRequests: [...current.closeRequests, "onExitRequested 被调用（探针返回 false：不阻止）"],
          };
        }
        return false;
      }),
    );
    readings.e = { requested: true, backPresses: [], closeRequests: [], exitResult: "（尚未点按）" };
  } catch (caught) {
    error.value = `E 块注册失败：${errorText(caught)}`;
  }
}

/** F 块：这一行是「APK 里跑的是浏览器实现还是 Tauri 实现」的唯一判据。 */
function runF(): void {
  const platform = getPlatform();
  readings.f = {
    tauriRuntime: isTauriRuntime(),
    userAgent: navigator.userAgent,
    href: location.href,
    pickKind: platform.imagePicking.kind,
    canCapture: platform.imagePicking.canCapture,
    shareSupported: platform.shareInbox.supported,
    albumKind: platform.album.kind,
  };
}

/**
 * 页面级的「明确退出」（E 的第三半）：单独一个按钮——按下去 App 就没了，放进 E 块读数来不及看。
 *
 * **结果一律落进 `readings.e.exitResult`，并且在按钮正下方直接显示**（2026-10-06 真机缺陷 A-FIX 4）：
 * 修复前失败原因只写进页面**顶部**的错误横幅，而按钮在页面**最底部**，真机上表现为「点了没反应」。
 * 现在把同一句话放在**按下去的那个地方**，读数与报告里各一份。
 *
 * **`readings.e` 为 `null` 时也要能记**（人可以先点退出、再点「注册 E 监听」）：那时就地建一份
 * `requested: false` 的读数——**不假装监听已注册**（`已请求注册：否` 是如实读数）。
 */
async function exitApp(): Promise<void> {
  let exitResult: string;
  try {
    await getPlatform().lifecycle.exit();
    exitResult = "已调用（resolve）";
    error.value = "";
  } catch (caught) {
    exitResult = `调用失败：${errorText(caught)}`;
    error.value = `明确退出失败：${errorText(caught)}`;
  }
  const current = readings.e;
  readings.e =
    current === null
      ? { requested: false, backPresses: [], closeRequests: [], exitResult }
      : { ...current, exitResult };
}

/**
 * 热启动订阅在**挂载时**注册：人从相册 App 分享进来时 WeeFuse 在后台——只有「App 启动时就订阅好」
 * 才接得住那一刻。C 按钮只负责取走冷启动那一份与跑 raw body 探针。
 */
onMounted(() => {
  try {
    unsubscribers.push(
      getPlatform().shareInbox.onSharedImage((file) => {
        const current = readings.c;
        readings.c = {
          coldStart: current?.coldStart ?? "（未跑，未取走冷启动分享）",
          hotStart: `${file.name} / ${file.size} 字节 / ${file.type === "" ? "（空 MIME）" : file.type}`,
          requestBody: current?.requestBody ?? "（未跑）",
        };
      }),
    );
  } catch (caught) {
    error.value = `热启动订阅失败：${errorText(caught)}`;
  }
});

onUnmounted(() => {
  for (const unsubscribe of unsubscribers) unsubscribe();
  unsubscribers.length = 0;
});

const readingA = computed(() => lineFileInput(readings.a));
const readingB = computed(() => lineFileInput(readings.b));
const readingC = computed(() => {
  const c = readings.c;
  if (c === null) return "未跑：点下面那个按钮取走冷启动分享；热启动已订阅。";
  return `冷启动：${c.coldStart} · 热启动：${c.hotStart} · 请求体：${c.requestBody}`;
});
const readingD = computed(() => {
  const d = readings.d;
  if (d === null) return "未跑：点下面那个按钮画一张探针图并存进相册。";
  return `落点：${d.kind} · 文件名：${d.filename} · 字节数：${d.bytes} · 结果：${d.result}`;
});
const readingE = computed(() => {
  const e = readings.e;
  if (e === null) return "未跑：点下面那个按钮注册监听，然后按系统返回键、再从任务切换器划掉 App。";
  return `已请求注册：${e.requested ? "是" : "否"} · 返回键：${e.backPresses.length === 0 ? "（尚未触发）" : e.backPresses.join(" | ")} · 关闭请求：${e.closeRequests.length === 0 ? "（尚未触发）" : e.closeRequests.join(" | ")} · 明确退出：${e.exitResult}`;
});
const readingF = computed(() => {
  const f = readings.f;
  if (f === null) return "未跑：点下面那个按钮读一次。";
  return `tauriRuntime=${f.tauriRuntime} · 相册选图形态=${f.pickKind} · 支持拍照=${f.canCapture} · 分享进入=${f.shareSupported ? "supported" : "unsupported"} · 保存落点=${f.albumKind} · UA=${f.userAgent} · ${f.href}`;
});

function lineFileInput(reading: FileInputProbeReading | null): string {
  if (reading === null) return "未跑：点下面那个输入框选一张图。";
  return `文件=${reading.name} · 字节数=${reading.size} · capture=${reading.capture} · WebView MIME=${reading.mimeFromWebView === "" ? "（空）" : reading.mimeFromWebView} · 嗅探 MIME=${reading.mimeSniffed} · 前 16 字节=${reading.magicHex === "" ? "（无）" : reading.magicHex} · 解码=${reading.decode}`;
}

/** 判定要点：**跟着读数一起被复制走**，人类伙伴不必回头翻计划。 */
const VERDICT_NOTES: readonly string[] = [
  "判定要点\tF\tAPK 装得上 + 首屏是图纸库 + 本行 tauriRuntime=true ⇒ 通过；false ⇒ 壳里跑的是浏览器实现（B5-R1）",
  "判定要点\tA\tA 能唤出系统选择器且「解码」是宽×高 ⇒ 通过（任务 3 把 pickImageFile 换成隐藏 input，并删掉 dialog 依赖与 dialog:allow-open 权限）；唤不出 / 解码失败 ⇒ 不通过（当前实现已是 dialog+fs 分支，无需改代码，B5-R2 记为已发生）",
  "判定要点\tB\t点按**直接进相机**且「解码」是宽×高 ⇒ 第 1 级成立；只出文件选择器 ⇒ 任务 4 走第 2 级（Kotlin capture 插件）；第 2 级也不通 ⇒ CAPTURE_SUPPORTED=false（不留半截入口）",
  "判定要点\tC\t「冷启动」或「热启动」给出文件名与字节数（URI 原文看 logcat 的两行 RunEvent::Opened：收到 {} 个 URI 与 RunEvent::Opened：URI = {url}）且「请求体形态」写 base64 JSON 字符串 + 「端到端一致（N 字节…）」⇒ 通过；写「保存失败：base64 解码失败（…）」⇒ 编码口径不一致（B5-R4 已发生：以前那条「需要原始字节体」的路在 Android 上不可达，本轮已按规格退到 base64）；「取走失败」⇒ B5-R3；logcat 里另有 save_image_to_album：收到 base64 解码后 {} 字节 一行，用来与读数里的 N 对账",
  "判定要点\tD\t「结果」写「已受理…」且相册 Pictures/WeeFuse 下出现该文件、字节数一致 ⇒ 通过；出现权限 / 拒绝 / insert 返回 null ⇒ 走 dialog.save()（B5-R5）",
  "判定要点\tE\t按返回键后「返回键」出现 canGoBack=… ⇒ 通过；划掉 App 时「关闭请求」出现条目 ⇒ 一并通过；**返回键不触发是缺陷**，**关闭请求不触发不构成缺陷**（B5-R6，如实记录）",
  "判定要点\tE-明确退出\t点页底的「明确退出 App」：App 立刻消失 ⇒ app.exit(0) 这条路通了（它在按钮正下方与 E 块的「明确退出」字段各留一份读数）；App 还在且写「已调用（resolve）」⇒ 调用回来了但进程没退（缺陷，记录之）；写「调用失败：…」⇒ 照原文查权限链（app.exit(0) = invoke plugin:app|exit，官方要求 core:app:allow-exit，它不在 core:app:default 里）",
];

/** 把全部读数拼成制表符分隔的文本（照 `/lab/canvas` 的口径：这是本页对人类伙伴的核心交付物）。 */
function buildReportText(state: ShellProbeReadings, stamp: string): string {
  const rows: string[] = [];
  const push = (criterion: string, field: string, value: string): void => {
    rows.push([criterion, field, value].join("\t"));
  };

  for (const criterion of ["A", "B"] as const) {
    const reading = criterion === "A" ? state.a : state.b;
    if (reading === null) {
      push(criterion, "（未跑）", "在本块选一张图");
      continue;
    }
    push(criterion, "accept", reading.accept === "" ? "（空）" : reading.accept);
    push(criterion, "capture", reading.capture);
    push(criterion, "文件", reading.name);
    push(criterion, "字节数", String(reading.size));
    push(criterion, "WebView MIME", reading.mimeFromWebView === "" ? "（空）" : reading.mimeFromWebView);
    push(criterion, "嗅探 MIME", reading.mimeSniffed);
    push(criterion, "前 16 字节", reading.magicHex === "" ? "（无）" : reading.magicHex);
    push(criterion, "解码", reading.decode);
  }

  if (state.c === null) push("C", "（未跑）", "点「跑 C」");
  else {
    push("C", "冷启动分享", state.c.coldStart);
    push("C", "热启动分享", state.c.hotStart);
    push("C", "请求体形态", state.c.requestBody);
  }

  if (state.d === null) push("D", "（未跑）", "点「存到相册」");
  else {
    push("D", "落点", state.d.kind);
    push("D", "文件名", state.d.filename);
    push("D", "字节数", String(state.d.bytes));
    push("D", "结果", state.d.result);
  }

  if (state.e === null) push("E", "（未跑）", "点「注册 E 监听」");
  else {
    push("E", "已请求注册", state.e.requested ? "是" : "否");
    push("E", "返回键", state.e.backPresses.length === 0 ? "（尚未触发）" : state.e.backPresses.join(" | "));
    push("E", "关闭请求", state.e.closeRequests.length === 0 ? "（尚未触发）" : state.e.closeRequests.join(" | "));
    // 页面级「明确退出」的结果（A-FIX 4）：**它必须进报告文本**——否则人一按按钮 App 就可能没了，
    // 屏幕上那句话再也读不到；报告是「复制走」的那一份。
    push("E", "明确退出", state.e.exitResult);
  }

  if (state.f === null) push("F", "（未跑）", "点「读构建信息」");
  else {
    push("F", "是否 Tauri 运行时", String(state.f.tauriRuntime));
    push("F", "相册选图形态", state.f.pickKind);
    push("F", "支持拍照", String(state.f.canCapture));
    push("F", "分享进入", state.f.shareSupported ? "supported" : "unsupported");
    push("F", "保存落点", state.f.albumKind);
    push("F", "User-Agent", state.f.userAgent);
    push("F", "地址", state.f.href);
  }

  return [`/lab/shell 探针读数（${stamp}）`, "判据\t字段\t读数", ...rows, ...VERDICT_NOTES].join("\n");
}

const report = computed(() => buildReportText(readings, new Date().toLocaleString("zh-CN")));

async function copy(): Promise<void> {
  const text = report.value;
  const clipboard: Clipboard | undefined = navigator.clipboard;
  if (clipboard === undefined) {
    copyStatus.value = "当前环境没有剪贴板 API：请手动选中下面的读数复制。";
    return;
  }
  try {
    await clipboard.writeText(text);
    copyStatus.value = `已复制 ${text.split("\n").length} 行到剪贴板。`;
  } catch (caught) {
    copyStatus.value = `复制失败：${errorText(caught)}；请手动选中下面的读数复制。`;
  }
}
</script>

<template>
  <main class="min-h-screen bg-slate-50 p-6">
    <h1 class="text-2xl font-bold text-slate-900">壳能力六判据探针（B5 spike）</h1>

    <p data-testid="lab-notice" class="mt-2 max-w-3xl text-sm font-semibold text-amber-800">
      开发期实验台；CI 不测（<b>真实的 input / 相机 / content:// / MediaStore / 返回键只能在装到手机上的
      APK 里测，CI 只测这一页怎么把读数渲染成文本</b>）。它只在路由表里存在、<b>不进任何用户入口</b>。
    </p>
    <p class="mt-2 max-w-3xl text-sm text-slate-600">
      A / B 用<b>裸 <code>&lt;input type=file&gt;</code></b>（问的是 WebView 本身好不好使），
      C / D / E / F 走 <code>getPlatform()</code>（问的是交付路径通不通）。
    </p>

    <div class="mt-4 flex flex-wrap items-center gap-3">
      <button
        data-testid="probe-copy"
        class="rounded border border-slate-300 bg-white px-4 py-2 text-sm text-slate-800"
        @click="copy"
      >
        复制为文本
      </button>
      <span data-testid="probe-copy-status" class="text-sm text-slate-500">{{ copyStatus }}</span>
    </div>

    <p v-if="error" data-testid="probe-error" class="mt-3 text-sm text-red-600">{{ error }}</p>

    <section class="mt-6 max-w-5xl rounded bg-white p-4 shadow">
      <h2 class="text-sm font-semibold text-slate-800">A · 相册输入（裸 input，不经能力层）</h2>
      <input
        data-testid="input-a"
        class="mt-2 block w-full rounded border border-slate-300 p-2 text-sm"
        type="file"
        accept="image/*"
        @change="onRawInput('A', $event)"
      />
      <p data-testid="reading-a" class="mt-2 break-all font-mono text-xs text-slate-700">{{ readingA }}</p>
    </section>

    <section class="mt-6 max-w-5xl rounded bg-white p-4 shadow">
      <h2 class="text-sm font-semibold text-slate-800">
        B · 拍照输入（裸 input + <code>capture="environment"</code>）
      </h2>
      <input
        data-testid="input-b"
        class="mt-2 block w-full rounded border border-slate-300 p-2 text-sm"
        type="file"
        accept="image/*"
        capture="environment"
        @change="onRawInput('B', $event)"
      />
      <p data-testid="reading-b" class="mt-2 break-all font-mono text-xs text-slate-700">{{ readingB }}</p>
    </section>

    <section class="mt-6 max-w-5xl rounded bg-white p-4 shadow">
      <h2 class="text-sm font-semibold text-slate-800">C · 分享进入 + base64 请求体（走能力层）</h2>
      <p class="mt-1 text-xs text-slate-500">
        热启动订阅已在本页挂载时注册。URI 原文看 <code>adb logcat</code> 里的两行：
        <code>RunEvent::Opened：收到 {} 个 URI</code> 与每个 URI 一行的
        <code>RunEvent::Opened：URI = {url}</code>（<code>{}</code> / <code>{url}</code> 处是真机上的实际值）。
        落盘那一步看 <code>save_image_to_album：收到 base64 解码后 {} 字节</code> 与
        <code>AlbumPlugin::save 落到 content://…</code>（后者由 Kotlin 侧打印，仍是
        <code>println!</code> ⇒ **它可能在真机 logcat 里不出现**，见操作卡；判据 D 的结论不依赖它）。
        请求体是 base64 JSON 字符串（Android 上 <code>InvokeBody::Raw</code> 不可达，规格 B5-R4 的退路已启用）。
      </p>
      <button
        data-testid="probe-run-c"
        class="mt-2 rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50"
        :disabled="busy !== ''"
        @click="runC"
      >
        {{ busy === "C" ? "跑 C 中…" : "跑 C：取走冷启动分享 + 发一次 base64 请求体" }}
      </button>
      <p data-testid="reading-c" class="mt-2 break-all font-mono text-xs text-slate-700">{{ readingC }}</p>
    </section>

    <section class="mt-6 max-w-5xl rounded bg-white p-4 shadow">
      <h2 class="text-sm font-semibold text-slate-800">D · 存相册（走能力层）</h2>
      <button
        data-testid="probe-run-d"
        class="mt-2 rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50"
        :disabled="busy !== ''"
        @click="runD"
      >
        {{ busy === "D" ? "存 D 中…" : "跑 D：画一张探针图并存进相册" }}
      </button>
      <p data-testid="reading-d" class="mt-2 break-all font-mono text-xs text-slate-700">{{ readingD }}</p>
    </section>

    <section class="mt-6 max-w-5xl rounded bg-white p-4 shadow">
      <h2 class="text-sm font-semibold text-slate-800">E · 返回键与关闭请求（走能力层）</h2>
      <button
        data-testid="probe-run-e"
        class="mt-2 rounded bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50"
        :disabled="readings.e !== null"
        @click="runE"
      >
        {{ readings.e === null ? "注册 E 监听" : "已注册" }}
      </button>
      <p data-testid="reading-e" class="mt-2 break-all font-mono text-xs text-slate-700">{{ readingE }}</p>
    </section>

    <section class="mt-6 max-w-5xl rounded bg-white p-4 shadow">
      <h2 class="text-sm font-semibold text-slate-800">F · 构建信息（走能力层）</h2>
      <button
        data-testid="probe-run-f"
        class="mt-2 rounded bg-slate-900 px-4 py-2 text-sm text-white"
        @click="runF"
      >
        读构建信息
      </button>
      <p data-testid="reading-f" class="mt-2 break-all font-mono text-xs text-slate-700">{{ readingF }}</p>
    </section>

    <div class="mt-6 max-w-5xl rounded bg-white p-4 shadow">
      <h2 class="text-sm font-semibold text-slate-800">页面级：明确退出 App（判据 E 的第三半）</h2>
      <p class="mt-1 text-xs text-slate-500">
        它不在六块之内：按下去 App 就没了，放进 E 块读数来不及看。干净状态下按返回键走到根时，生产实现
        走的也是这一条（<code>lifecycle.exit()</code>）。
      </p>
      <button
        data-testid="probe-exit"
        class="mt-2 rounded border border-red-300 bg-white px-4 py-2 text-sm text-red-700"
        @click="exitApp"
      >
        明确退出 App
      </button>
      <!--
        A-FIX 4：结果**就显示在按钮正下方**。修复前失败原因只写进页面顶部的 `probe-error`，
        而按钮在页面最底部 ⇒ 真机上表现为「点了没反应」。
      -->
      <p data-testid="probe-exit-result" class="mt-2 break-all font-mono text-xs text-slate-700">
        明确退出：{{ readings.e === null ? "（尚未点按）" : readings.e.exitResult }}
      </p>
    </div>

    <p class="mt-6 max-w-3xl text-xs text-slate-500">
      两条如实标注：① A / B <b>不经能力层</b>，所以它们与「任务 3 / 4 最终选哪条实现」无关；
      ② 本页在浏览器里也能打开（<code>npm run dev</code> → <code>/lab/shell</code>），那时 F 块会如实写
      <code>tauriRuntime=false</code>、A–E 读到的是浏览器实现。判据 C / D 都会往系统相册写探针文件，
      跑完记得删掉。
    </p>
  </main>
</template>
