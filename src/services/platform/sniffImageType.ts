/**
 * 从字节里嗅出图片类型；从 URI 里取一个能当工程名用的文件名。
 *
 * **为什么要有这一层**（规格 §5.3.5）：Android 交回来的 `content://…` 不带 MIME、末段常常没有
 * 扩展名（形如 `image%3A1234`），而它最终会经 `defaultProjectName` 变成**默认工程名**——
 * 不允许出现「image:1234」这种工程名。规则必须只有一份：分享摄入那条链
 * （`tauriPlatform.fileFromUri`，任务 5 的 `useShareIntake` 用的就是它建出来的 `File`）是**唯一**
 * 生产消费者。**2026-10-06 任务 3 的更正**：驱动侧的 dialog 分支已随
 * `@tauri-apps/plugin-dialog` 一起删除（判据 A 通过 ⇒ 相册选图改走隐藏 `<input type=file>`，
 * 那条路拿到的是真 `File`、不经本文件）——本段此前把那个已删分支写成共用方。
 *
 * **为什么用魔数而不是信任调用方给的 MIME**：解码路径根本不看 `File.type`
 * （`decodeImageElement` 走 object URL + `<img>.decode()`，由 WebView 嗅探真实字节），`type`
 * 只影响我们自己的记录、显示与默认工程名 ⇒ 魔数足够，而它**是纯函数、能在 CI 里逐字节断言**。
 *
 * **已知边界（如实登记）**：只认四种常见格式（PNG / JPEG / WEBP / HEIC）。其余一律回落
 * `application/octet-stream` —— 回落不是失败：真正的格式判定在解码那一步，这里错了会以
 * 「解码失败」的形式响亮暴露。
 */

/**
 * `sniffImageType` 的值域（四种魔数 + 回落）。
 *
 * **为什么是一个具名联合而不是 `string`**：消费者 `views/ShellProbePage.vue` 的读数结构
 * `FileInputProbeReading.mimeSniffed` 是**要逐字段被断言**的字段（规格 §13 判据 A / B 的前 16 字节
 * 与嗅探结果就是读数本身），`string` 会让「回落值写错」这类错误在类型上完全不可见。零运行期成本。
 */
export type SniffedImageType =
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "image/heic"
  | "application/octet-stream";

/** 魔数表。**顺序无关**（每种格式的前缀互不前缀包含）。 */
const SIGNATURES: readonly {
  readonly type: SniffedImageType;
  readonly bytes: readonly number[];
  readonly offset: number;
}[] = [
  { type: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47], offset: 0 },
  { type: "image/jpeg", bytes: [0xff, 0xd8, 0xff], offset: 0 },
  { type: "image/webp", bytes: [0x52, 0x49, 0x46, 0x46], offset: 0 }, // "RIFF"；完整判据还要看 8..12 处的 "WEBP"
  { type: "image/heic", bytes: [0x66, 0x74, 0x79, 0x70], offset: 4 }, // "ftyp" 在第 4 字节起
];

const WEBP_TAG = [0x57, 0x45, 0x42, 0x50]; // "WEBP"

/**
 * 嗅图片类型。**长度不足时直接回落**（不许越界读：`bytes[3]` 在长度 1 的数组上拿到 `undefined`，
 * 与 `0x89` 比较恒不相等，所以越界本身不会崩——但那是**靠运气**，不是靠判据）。
 *
 * **长度检查的判别力如实登记**（2026-10-06 任务 2 实跑变异 V5）：删掉 `if (bytes.length < end) continue;`
 * 之后 `npm run test` **一条都不红**——`Uint8Array` 的越界读恒为 `undefined`，而 `undefined` 与任何
 * 魔数字节都不相等，于是循环自己收敛到「不匹配」。这不是「断言无效」（断言读的是可观测行为，
 * 行为确实正确），而是**这道守卫在当前载体上不承重**：它防的是「越界读会崩 / 会读到别的内存」，
 * 而 JS 的 `Uint8Array` 不提供那种语义。保留它的理由：它把「长度必须够」写成显式判据（读者不必
 * 自己推 `undefined` 的比较结果），且换载体（`ArrayBuffer` 视图切片、WASM 侧）时行为不会变。
 *
 * **消费者**（2026-10-06 任务 3 后核实）：`tauriPlatform.ts`（`fileFromUri` 决定 `File.type` 与名字
 * ——分享摄入那条链，任务 5 的 `useShareIntake` 就吃这条链建出来的 `File`）、
 * `views/ShellProbePage.vue`（判据 A / B 的读数）、以及本文件的 `imageFileName`。
 * **旧的 `tauriDriver.ts`（dialog 分支）已不是消费者**：那个分支随 `@tauri-apps/plugin-dialog` 删除，
 * 隐藏 `<input type=file>` 交回的是真 `File`、不经本文件。
 */
export function sniffImageType(bytes: Uint8Array): SniffedImageType {
  for (const signature of SIGNATURES) {
    const end = signature.offset + signature.bytes.length;
    if (bytes.length < end) continue;
    let matched = true;
    for (let i = 0; i < signature.bytes.length; i += 1) {
      if (bytes[signature.offset + i] !== signature.bytes[i]) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    if (signature.type === "image/webp") {
      // RIFF 是容器前缀（WAV / AVI 同前缀）⇒ 必须再看 8..12 的 "WEBP" 才算数。
      if (bytes.length < 12) continue;
      let isWebp = true;
      for (let i = 0; i < WEBP_TAG.length; i += 1) {
        if (bytes[8 + i] !== WEBP_TAG[i]) {
          isWebp = false;
          break;
        }
      }
      if (!isWebp) continue;
    }
    return signature.type;
  }
  return "application/octet-stream";
}

/** 扩展名 → 类型（用于「URI 末段有扩展名」时先按扩展名判，再回落魔数）。 */
const EXTENSION_TYPES: Readonly<Record<string, SniffedImageType>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  heic: "image/heic",
};

/** 默认文件名的词干。**与扩展名分开**：工程名由 `defaultProjectName` 去扩展名而来。 */
const FALLBACK_STEM = "相册图片";

/**
 * 从一个 URI / 路径里取一个能当工程名的文件名。第二参是 `sniffImageType` 的结果
 * （**不由本函数自己嗅**：URI 的阶段还读不到字节，两件事分开才可能各自被断言）。
 *
 * 规则（规格 §5.1 末段）：
 * 1. 末段（`/` 分隔）做一次最小百分号解码；
 * 2. 末段含 `.` 且扩展名在白名单里 ⇒ 原样用它；
 * 3. 否则 ⇒ `` `${FALLBACK_STEM}.${扩展名}` ``，扩展名由 `sniffedType` 反查（`image/jpeg` → `jpg`），
 *    查不到用 `bin`。
 *
 * **不返回空串**：空串会让 `defaultProjectName("")` 回落「新图纸」——那是把「名字丢了」藏起来。
 */
export function imageNameFromUri(uri: string, sniffedType: string): string {
  const decoded = decodeURIComponent(uri);
  const tail = decoded.split("/").pop() ?? "";
  const dot = tail.lastIndexOf(".");
  if (dot > 0 && dot < tail.length - 1) {
    const ext = tail.slice(dot + 1).toLowerCase();
    if (EXTENSION_TYPES[ext] !== undefined) return tail;
  }
  const sniffedExt = Object.entries(EXTENSION_TYPES).find(([, type]) => type === sniffedType)?.[0] ?? "bin";
  return `${FALLBACK_STEM}.${sniffedExt}`;
}

/**
 * 「URI + 它的字节 ⇒ 文件名」——**唯一生产调用点真正用的那一个**（`tauriPlatform.fileFromUri`）。
 * 它只是把 `sniffImageType` 与 `imageNameFromUri` 接起来，**不写第二份规则**。
 *
 * （2026-10-06 任务 3 更正：此处原先还列着 `tauriDriver.pickImageFile` 的 **dialog 分支**，
 * 那个分支已随 `@tauri-apps/plugin-dialog` 删除 ⇒ 调用点从两个变成一个。）
 *
 * **为什么它必须存在**（2026-10-06 任务 2 实跑发现的计划缺口，如实登记）：计划正文里
 * `tauriDriver.ts` 与 `tauriPlatform.ts` 两处都写的是 `imageFileName(uri, bytes)`（两参：URI + 字节），
 * 而计划给出的 `sniffImageType.ts` 里只有 `imageNameFromUri(uri, sniffedType)`（两参：URI + **类型**）。
 * 两边对不上，照抄编译不过。处置：**两个都留**——`imageNameFromUri` 是规则本体（计划给的三条用例
 * 逐字断言的就是它），`imageFileName` 是同一份规则的便捷入口。**没有第二份命名逻辑**：
 * 本函数体只有一行转发。
 *
 * **消费者**：`tauriPlatform.ts`（分享摄入那条链；任务 5 的 `useShareIntake` 通过它拿到带名字与
 * MIME 的 `File`）。`tauriDriver.ts` 已不再是消费者（见上）。
 */
export function imageFileName(uri: string, bytes: Uint8Array): string {
  return imageNameFromUri(uri, sniffImageType(bytes));
}
