/**
 * 隐藏 `<input type=file>` 取图 —— **浏览器实现与壳实现共用的唯一一份**。
 *
 * **为什么抽出来**（2026-10-11 审计）：同一件 DOM 机制原先在两处各写一遍
 * （`browserPlatform.ts` 的 `pickFromAlbum` 与 `tauriDriver.ts` 的 `pickImageFile` / `captureImageFile`），
 * 两边的出口语义已经漂移（浏览器版只认 `cancel`、壳版另有焦点兜底）——同一份能力两份语义，
 * 没人能说清「浏览器里取消后按钮永久卡住」到底算不算 bug。现在只有这一份。
 *
 * **零框架依赖**：只用 DOM（`document` / `window` / `setTimeout`），不 import `vue` / `pinia` /
 * `@tauri-apps/*`。本文件与 Tauri 无关，`tauriDriver.ts` 只是把它转发出去（那里才是全仓唯一
 * 接触 `@tauri-apps/*` 的文件）。
 */

/**
 * 非 `File` 的契约违反消息（逐字钉在 `__tests__/browserPlatform.test.ts` 与
 * `__tests__/platformContract.ts` 里）。**不导出**：没有任何模块级消费者——两处用例断的是字面量。
 */
const PICKER_NOT_A_FILE_MESSAGE = "图片选择器返回了非文件对象";

/**
 * `cancel` / `change` 都没有来时，等焦点回到窗口之后**再看这一拍**才判「用户取消」。
 *
 * 取值理由：`change` 是对话框关闭的**同一批次**里派发的，1 s 远超它需要的传递时间；而它又是人能察觉的
 * 「按钮怎么还卡着」之下限以下。再长没有收益（只是把卡住的观感拖长），再短则可能抢在 `change` 之前结算
 * ⇒ 把用户刚选好的文件静默丢掉。
 *
 * **为什么公开**（`AGENTS.md`「公开 API ≠ 被使用的 API」）：生产消费者只有下方的 `pickWithHiddenInput`；
 * `__tests__/tauriDriver.test.ts` 与 `__tests__/browserPlatform.test.ts` 需要它来断言**排上去的延迟
 * 就是它**（测试里写死 `1000` 就是本项目记账过的「第二份字面量」形态——改实现后用例仍压在旧值上，
 * 边界用例悄悄退化成非边界用例）。同 `tauriDriver.ts` 的 `BASE64_CHUNK_BYTES` 的理由。
 */
export const PICKER_RETURN_GRACE_MS = 1000;

/**
 * 用隐藏 `<input type=file>` 取图；`capture` 非空时带上 `capture` 属性（拍照那一条路）。
 *
 * **取消 = `null`**（正常操作，不许抛错）。**判据 A 通过后 dialog 分支已删**（规格 §5.1 只保留 spike
 * 选中的那一条），所以「改走 dialog 分支」不再是一条现成的退路——真要走它得先把依赖与权限加回来。
 *
 * **结算兜底（2026-10-06 任务级审查 F1）**：`cancel` 事件只有 Chrome 113+ 才有，老 WebView 上
 * 「用户取消」不会有任何事件 ⇒ promise 永不结算 ⇒ 按钮永久 `disabled`、input 节点永久留在 body。
 * 这是壳的**主链路**，且只有真机能暴露，所以这里自己兜底，不再指望调用方。
 *
 * - **为什么用焦点信号**：选择器 / 相机是另一个 Activity，关掉时焦点回到 WebView——这是 `cancel`
 *   之前通行的「对话框已关」信号（input 自己是 `display:none`，收不到 `focus`）。
 * - **为什么必须先见过一次 `blur`**：有的 WebView 在打开瞬间会补发一次 `focus`，只认 `focus` 会在
 *   用户还没挑完时就判成取消。
 * - **为什么还要 `PICKER_RETURN_GRACE_MS` 这一拍**：焦点先回来、`change` 后到是可能的；直接结算会把
 *   用户刚选好的文件静默丢掉。等这一拍让正常的 `change` 先赢。
 * - **已知代价（如实登记）**：不支持 `cancel` 的 WebView 上，取消后要等这个宽限期按钮才恢复可用；
 *   而若用户在系统相册里停很久再回来（焦点信号早于选择），仍会被判成取消——在「永久卡死」与
 *   「偶尔要重来一次」之间选了后者。
 *
 * **出口共六个**（每个都要摘节点 + 摘窗口监听 + 清定时器）：`change` 选中 `File` ⇒ resolve 它；
 * `change` 空列表 / `cancel` / 焦点宽限期到期 ⇒ resolve `null`；`change` 拿到非 `File` ⇒ reject
 * `PICKER_NOT_A_FILE_MESSAGE`；`click()` 抛错 ⇒ reject 原错误。（「非 File 响亮失败」原先只有浏览器侧
 * 有，抽共享时成为两条入口的共同契约——静默当取消等于把契约违反伪装成用户行为。）
 *
 * **为什么公开**（`AGENTS.md`「公开 API ≠ 被使用的 API」）：生产消费者是 `browserPlatform.ts`
 * （传 `null`）与 `tauriDriver.ts` 的 `pickImageFile` / `captureImageFile`（`null` / `"environment"`）；
 * 公开是为了让**六个出口**与**属性装配**在 CI 里可判别——都能在 happy-dom 下读到
 * （`__tests__/tauriDriver.test.ts`：手工派发事件 + 把 `setTimeout` 换成只记录不等待的桩、再手工触发）。
 * 它是一个真的 DOM 机制，不是 `xxxForTests` 那种测试钩子：真机上才有的判别力（选择器 / 相机真的被唤出）
 * 仍不在 CI 里。
 */
export function pickWithHiddenInput(capture: "environment" | null): Promise<File | null> {
  return new Promise<File | null>((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    if (capture !== null) input.setAttribute("capture", capture);
    input.style.display = "none";
    // 先挂进 body 再 click：部分 WebKit 版本对未挂载的 file input 调 click 不唤起选择器。
    document.body.append(input);

    let settled = false;
    let everBlurred = false;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;

    /** 每个出口都要拆掉窗口监听与兜底定时器，否则会跨次泄漏。 */
    const detach = (): void => {
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      if (graceTimer !== null) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
    };

    const finish = (value: File | null): void => {
      if (settled) return;
      settled = true;
      detach();
      input.remove();
      resolve(value);
    };

    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      detach();
      input.remove();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const onBlur = (): void => {
      everBlurred = true;
    };

    const onFocus = (): void => {
      // 没见过 blur 的 focus 是「打开瞬间的补发」，不是「对话框关掉」；已经在等宽限期也不重复排。
      if (!everBlurred || settled || graceTimer !== null) return;
      graceTimer = setTimeout(() => finish(null), PICKER_RETURN_GRACE_MS);
    };

    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    input.addEventListener("change", () => {
      const picked: unknown = input.files?.[0] ?? null;
      if (picked === null) {
        // 老浏览器上「没选任何文件就关掉」会以 `change` + 空 FileList 到达 ⇒ **按取消处理**：
        // 用户清空选择本来就是取消，判成失败会给他弹一条看不懂的红条。
        finish(null);
        return;
      }
      if (!(picked instanceof File)) {
        // 而「拿回来的不是 File」是**契约违反**，必须响亮失败（不许静默当取消）。
        fail(new Error(PICKER_NOT_A_FILE_MESSAGE));
        return;
      }
      finish(picked);
    });
    input.addEventListener("cancel", () => finish(null));

    try {
      input.click();
    } catch (error) {
      fail(error);
    }
  });
}
