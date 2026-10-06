import { normalizeProjectName } from "./projectStore";
import { requireSavableBlob } from "./platform/guards";
import type { RenderTarget2D } from "@/core/render/types";

/**
 * B4 导出的**唯一接触平台落盘 API 的文件**（规格 §3）：建画布、取 2D 上下文、`toBlob`、下载、文件名。
 *
 * 为什么这一层必须存在：`core/render/**` 是零依赖纯计算层，不得引用 DOM 全局
 * （`src/__tests__/coreBoundary.test.ts` 的 `FORBIDDEN_GLOBALS`，`CanvasRenderingContext2D` 在其中）。
 * core 的渲染器吃的是自己声明的 `RenderTarget2D`（`core/render/types.ts`），真 ctx 由本文件注入——
 * 于是布局与绘制能在 Node 里被断言，平台能力只堆在这几个函数里。
 *
 * **本文件承担的两条「不静默」防线**（规格 §9 第 4/5 条、§16 的 B4-R2）：画布尺寸回读不一致即抛
 * （浏览器对超限画布会静默钳制或置 0）；渲染完成后在固定位置读回 1×1 像素自检
 * （`assertCanvasPainted`）——「分配成功但内容全空」是本平台真实存在的失败形态，它在 UI 上表现为
 * 一张白图，用户会以为图纸本来就这样。
 *
 * **如实记录**：真实像素的判别力在本环境（happy-dom）不存在——`getContext("2d")` 返回 `null`、
 * `getImageData` 没有语义。`assertCanvasPainted` 在 CI 里只被证明「接线正确」（采样坐标、比较、消息），
 * 真实判别力在规格 §14 的人工清单。
 */

/** 导出的内容标签；就是文件名中段那三个词（规格 §8 / 契约 §2）。 */
export type ExportItemLabel = "施工图" | "用量表" | "分享图";

/**
 * 自检采样点的 x / y。
 *
 * **取值理由**（控制者裁定 2026-10-05）：施工图渲染的第一步是整张画布填 `#ffffff`，而 (2, 2) 落在
 * `SHEET_MARGIN`(=24) 的**左上角边距**里——始终被白底覆盖、**不放任何文字**，比信息条里的点更稳
 * （信息条里有字，可能正好压在探针点上），且与图纸内容、格像素、用色数**全都无关**，所以它对一张
 * 合法图纸不可能误报；反过来「分配成功但内容全空」会让它读回 0，正是要抓的形态。选「最后一格」会
 * 选到空格上，那条自检就会对合法图纸误报（规格 §9 第 5 条点名了这条）。
 *
 * **分享图不调用自检**：它按设计是透明的，没有「必定不透明」的点（同一裁定）。
 */
const SELF_CHECK_X = 2;
const SELF_CHECK_Y = 2;

/**
 * 建一张**尺寸被验证过**的画布：`width` / `height` 必须是整数且 ≥1；写完之后回读，不一致即抛。
 *
 * **为什么必须回读**：浏览器对超过平台上限的画布不报错，而是静默钳制尺寸（有的实现直接置 0）
 * ⇒ 调用方拿到一张「看起来正常」的空白画布，用户拿到一张白图。这一层把那个静默失败变成抛错，
 * 由上层决定怎么办（`ExportPanel` 显示失败原因；上限的真值由 `/lab/canvas` 实测后回写
 * `EXPORT_MAX_EDGE`）。校验写在**任何写操作之前**（`AGENTS.md`「入口校验」）。
 *
 * **消费者**：`ExportPanel.vue`（每张产物渲染前建画布）。
 */
export function createCanvasStrict(width: number, height: number): HTMLCanvasElement {
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
    throw new Error(`画布宽高必须是 ≥1 的整数（当前 ${width}×${height}）`);
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  if (canvas.width !== width || canvas.height !== height) {
    throw new Error(
      `画布尺寸被浏览器钳制：期望 ${width}×${height}，实际 ${canvas.width}×${canvas.height}`,
    );
  }
  return canvas;
}

/**
 * 取 2D 上下文，返回 core 渲染器要的 `RenderTarget2D`；拿不到即抛（不静默返回 `null`，
 * 让调用方在别处裸崩成 `TypeError`）。
 *
 * **消费者**：`ExportPanel.vue` 把返回值直接传给 `core/render/sheet.ts` / `share.ts`——
 * 返回类型**就是** `RenderTarget2D`，所以 `drawSheetTile(requireContext2D(canvas), …)` 原样可编译，
 * 面板里**不散落 cast**。
 *
 * **为什么这里必须有一次具名窄化**（2026-10-05 由任务 3 的审查用编译器实测、控制者裁定）：
 * `CanvasRenderingContext2D` 与 `RenderTarget2D` **并不严格结构兼容**，实测**四处**不合：
 *
 * 1. `fillStyle`：DOM 是 `string | CanvasGradient | CanvasPattern`，core 只收 `string`；
 * 2. `strokeStyle`：同上（也是 `string | CanvasGradient | CanvasPattern`）；
 * 3. `textAlign`：DOM 的 `CanvasTextAlign` 多出 `"start" | "end"`；
 * 4. `textBaseline`：DOM 的 `CanvasTextBaseline` 多出 `"alphabetic" | "hanging" | "ideographic"`。
 *
 * （TS 一次只报第一个不合的属性，所以 `vue-tsc` 在返回处只列 `fillStyle` + 一条 `getImageData` 不存在；
 * 「四处」是逐字段 `Omit` 逼出来的**实测集合**——去掉这四个字段后 `ctx` 可赋值、无报错；
 * 原文见任务 3 报告的 F1 编译证据。）
 *
 * **为什么不在 core 里放宽那四个字段**：DOM 的联合类型属于平台层，放宽等于把 `CanvasGradient` /
 * `CanvasPattern` / `"start"` / `"alphabetic"` 拖进零依赖的 core——`core/render/types.ts` 存在的理由
 * 正是隔离它们（core 不得引用 DOM 全局）；而且渲染器只会写 `rgbCss(...)` 出来的字符串与
 * `"left" | "center" | "right"` / `"top" | "middle"`，永远不会写那些值。窄化只在**这一个具名点**发生。
 */
export function requireContext2D(canvas: HTMLCanvasElement): RenderTarget2D {
  return requireRawContext2D(canvas) as unknown as RenderTarget2D;
}

/**
 * 真 DOM 类型的 2D 上下文。
 *
 * **为什么还要一个不导出的兄弟函数**（2026-10-05 由任务 3 的实现者在 F1 修复时发现）：`assertCanvasPainted`
 * 要调 `getImageData`，而它**不在** `RenderTarget2D` 里（渲染器用不到读像素，把它加进 core 的接口等于
 * 让 core 引用 DOM 的 `ImageData`）。所以自检拿的是真 DOM 接口，渲染器拿的是 `RenderTarget2D`。
 *
 * **null 守卫只此一份**：`requireContext2D` 与 `assertCanvasPainted` 都走这里 ⇒ 「拿不到上下文」
 * 在两条路径上是同一处判断、同一条消息，不会各自漂移。
 *
 * **不导出**：它不是契约 §2 的 API（导出即承诺），只服务于本文件内的两条路径。
 */
function requireRawContext2D(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    throw new Error("无法获取 2D 上下文");
  }
  return ctx;
}

/**
 * Promise 化 `HTMLCanvasElement.toBlob`，固定请求 `"image/png"`。
 *
 * 回调给 `null`（编码失败）即 **reject**——规格 §8 明写「不静默返回空串」：静默成功会让用户以为
 * 自己保存了一张图。注意 happy-dom 的 `toBlob` 给的是**大小 0 的 Blob**（不是 `null`），
 * 那条路径由 `downloadBlob` 的「blob 大小为 0」守卫兜住。
 *
 * **消费者**：`ExportPanel.vue`（渲染完成后取 PNG）。
 */
export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) {
        reject(new Error("导出 PNG 失败：toBlob 返回了 null"));
        return;
      }
      resolve(blob);
    }, "image/png");
  });
}

/**
 * 下载时 object URL 的**延后释放延时**（ms）。
 *
 * **为什么不能同步释放**（这是真实理由，不是防御性洁癖）：`link.click()` 只是把下载**排进**浏览器的
 * 取数流程，真正的字节是**之后**由浏览器异步从 blob URL 读走的；同一任务里立刻
 * `URL.revokeObjectURL(url)` 会在部分浏览器上让这次下载**什么都没下下来**（静默失败：没有报错、
 * 没有文件，用户以为存过了）。这正是 FileSaver.js 把 revoke 放进 `setTimeout(…, 4e4)` 的原因。
 * **取舍**：FileSaver 用 40 s（够慢网取用，但把一个全分辨率 blob 钉住 40 s）；本功能一张产物最大
 * ≈64 MB RGBA，取 1 s——足够浏览器启动取数（`click()` 之后取数是立刻开始的），又不长期钉住大 blob。
 * **恰好一次**：这次延后释放写在 `finally` 里，成功与失败两条路径都只安排一次。
 */
const REVOKE_DELAY_MS = 1000;

/**
 * 触发一次下载：`URL.createObjectURL` → 临时 `<a download>` → `click()` → **延后** `revokeObjectURL`。
 *
 * **两条守卫都写在任何副作用之前**（`AGENTS.md`「入口校验」）：`blob.size === 0` 即抛（空文件是
 * 真实存在的失败形态，见 `canvasToBlob`）；文件名去空白后为空即抛。顺序上**先 `click()` 后
 * `revokeObjectURL`**：反过来会在部分浏览器上让下载拿不到数据。
 *
 * **`revokeObjectURL` 延后到 `setTimeout(…, REVOKE_DELAY_MS)`**（2026-10-05 修复波 A-1）：
 * 同步释放是**错误**的——浏览器是异步从 blob URL 取字节的，同一任务里释放可能让下载静默不落地
 * （理由与 40 s / 1 s 的取舍见 `REVOKE_DELAY_MS` 的 JSDoc）。这一点在本层尤其承重：这是本功能
 * **唯一**的落盘路径，它静默失败就等于「保存」按钮什么都没做。
 *
 * **它仍然放在 `finally` 里**（2026-10-05 任务 3 审查的 F4 裁定）：`click()` 是这一步里唯一现实会
 * 抛错的一步（例如被下载拦截器 / 受限环境拒绝），而 object URL 一旦创建就必须回收——写成顺序语句
 * （`link.click(); setTimeout(…)`）会让「抛错那一次」漏掉回收、在页面生命周期内泄漏一个 blob URL。
 * `try / finally` 让回收在成功与失败两条路径上都是**恰好一次**；异常照常上抛，不吞。
 *
 * **这个 `文件名不能为空` 守卫不是 `normalizeProjectName` 的副本**（控制者裁定 2026-10-05）：两者校验的
 * 是**不同的对象**——`normalizeProjectName` 校验「工程名」（trim、非空、≤ `PROJECT_NAME_MAX`，属调用方
 * 的命名契约，`exportFilename` 已经用过它）；本函数校验的是**最终文件名**，它是 DOM 边界的最后一站，
 * 只判「去空白后非空」，不管长度、也不管名字从哪来。职责不同，所以这里**不许**从工程名再推导一次
 * 文件名（那是第二份命名逻辑）。
 *
 * **刻意不把 `<a>` 挂进 DOM**：现代浏览器对未挂载的 `<a download>` 调 `click()` 即可触发下载；
 * 挂进去就必须配一次 `remove()`，而 `remove()` 与 `click()` 之间有第二条可能抛错的路径（清不掉就留下
 * 一个永不回收的节点）。不挂载 ⇒ 没有需要清理的节点，需要 `finally` 兜住的只剩 object URL 这一项。
 * 用例用 `anchor.parentNode === null` 钉住这条决定。
 *
 * **消费者**：`ExportPanel.vue`（用户点「保存」后）。
 */
export function downloadBlob(blob: Blob, filename: string): void {
  // 两条守卫收敛到 `services/platform/guards.ts` 的 `requireSavableBlob`（规格 §4.4「守卫」）：
  // 壳里的相册实现要判同样两件事，各写一份必然漂移。**消息逐字未变**，既有用例读的就是它们。
  const safe = requireSavableBlob(blob, filename);
  const url = URL.createObjectURL(safe.blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = safe.filename;
  try {
    link.click();
  } finally {
    // 延后释放：浏览器此刻才真正开始从 `url` 取字节（理由见 `REVOKE_DELAY_MS`）。
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
  }
}

/**
 * §9 第 5 条的**生成后自检**：读回采样点 `(SELF_CHECK_X, SELF_CHECK_Y)` 的 1×1 像素，不是不透明的
 * 白色即抛。
 *
 * 它挡的是「分配成功、内容全空 / 读回全 0」这一形态（规格 §16 的 B4-R2）：没有它，失败会以
 * 「一张白图」的形式成功交付。上下文获取复用**同一处** null 守卫 `requireRawContext2D`
 * （不写第二份 `null` 检查——它返回真 DOM 接口，因为自检要调 `getImageData`，而它不在 `RenderTarget2D` 里）。
 * 消息里的坐标由这两个常量插值而来，所以**坐标与文案不会漂移**（改坐标会同时改掉消息与用例）。
 *
 * **采样点为什么是 (2, 2)**：见 `SELF_CHECK_X` 的注释——它在左上角边距里，始终白底、不放任何文字。
 *
 * **消费者 = `ExportPanel.vue`（生产消费者，契约 §2b 已补）**：每张渲染完成之后、`canvasToBlob` 之前
 * 调用它；**面板若不调用它，它就是零消费者，属缺陷**（`AGENTS.md`「公开 API ≠ 被使用的 API」）。
 * **分享图不调用自检**——它按设计是透明的，没有「必定不透明」的点（控制者裁定 2026-10-05）。
 */
export function assertCanvasPainted(canvas: HTMLCanvasElement): void {
  const ctx = requireRawContext2D(canvas);
  const { data } = ctx.getImageData(SELF_CHECK_X, SELF_CHECK_Y, 1, 1);
  const rgba = `${data[0]},${data[1]},${data[2]},${data[3]}`;
  if (data[0] !== 255 || data[1] !== 255 || data[2] !== 255 || data[3] !== 255) {
    throw new Error(
      `画布内容自检失败：(${SELF_CHECK_X}, ${SELF_CHECK_Y}) 读回 ${rgba}（期望 255,255,255,255）`,
    );
  }
}

/**
 * 产物文件名（模板已并入契约 §2）：`<清洗后的工程名>-施工图-r{行}c{列}.png` /
 * `<清洗后的工程名>-用量表.png` / `<清洗后的工程名>-分享图.png`——**非分片项不带序号**。
 * 分片序号 **1 起**（`rowIndex + 1`），与施工图页脚「第 r/c 片」同一口径。
 *
 * **清洗复用 `normalizeProjectName`，不写第二份**（规格 §8 明写）：它同时给出「非空」与
 * 「≤ `PROJECT_NAME_MAX` 字」两条约束，并在非法时抛它自己的中文消息——本函数**不吞、不改写**，
 * 让「名字非法」在导出这一步与在保存工程那一步是同一句话。
 *
 * 四个运行期守卫（TS 类型挡不住 `JSON.parse` / 强转 / 运行期拼接）：内容标签必须是三值之一
 * （否则会静默产出一个 `X-海报.png`）；`用量表` / `分享图` 带了 `tile` 即抛（静默忽略会让调用方
 * 以为自己传对了）；施工图必须有分片序号；序号必须是 **≥0 的安全整数**（负数或小数会静默产出 `r0c0`
 * 或 `r1c2.5`，看起来完全正常；判据用 `Number.isSafeInteger` 而不是 `Number.isInteger`——`1e21` 是
 * 「≥0 的整数」但 `1e21 + 1 === 1e21`，加一之后仍是同一张片号，消息因此也逐字写「安全整数」，
 * 2026-10-05 按任务 3 审查的 F2 更正）。
 *
 * **消费者**：`ExportPanel.vue`（生成每个产物的下载文件名）。
 */
export function exportFilename(
  projectName: string,
  item: ExportItemLabel,
  tile?: { rowIndex: number; colIndex: number },
): string {
  const safeName = normalizeProjectName(projectName);
  if (item !== "施工图" && item !== "用量表" && item !== "分享图") {
    throw new Error(`导出内容标签非法：${item}`);
  }
  if (item !== "施工图") {
    // 「没传」只认 `undefined`；显式传进来的 `null`（`JSON.parse` / 强转都能给）同样算「带了序号」
    // 这条语义非法——与 `requireMaxEdge` 里「显式 `null` 不算没传」同源（2026-10-05 修复波 A-m10）。
    if (tile !== undefined) {
      throw new Error("用量表 / 分享图不带分片序号");
    }
    return `${safeName}-${item}.png`;
  }
  // **`null` 也要挡**（2026-10-05 修复波 A-m10）：`tile === undefined` 判不出显式传进来的 `null`
  // （`JSON.parse` / 强转都能给），下一步 `tile.rowIndex` 会落成一句**裸 TypeError**
  //（`Cannot read properties of null`）——那是没有契约口径的失败。这里按契约消息响亮拒绝。
  if (tile === undefined || tile === null) {
    throw new Error("施工图的分片序号缺失");
  }
  if (
    !Number.isSafeInteger(tile.rowIndex) ||
    tile.rowIndex < 0 ||
    !Number.isSafeInteger(tile.colIndex) ||
    tile.colIndex < 0
  ) {
    throw new Error(`分片序号非法：${tile.rowIndex}, ${tile.colIndex}（必须是 ≥0 的安全整数）`);
  }
  return `${safeName}-${item}-r${tile.rowIndex + 1}c${tile.colIndex + 1}.png`;
}
