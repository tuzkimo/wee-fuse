/**
 * 异常 → 可显示的文案。
 *
 * **空 `message` 是真实存在的一类**：`new Error()` 在很多库与浏览器 API 里很常见，DOMException 也
 * 常带空 message。空串渲染到提示条上就是一条没有信息的红字（看着像 bug 却指不出原因），所以回落
 * `name`（`Error` / `TypeError` / `NotAllowedError`…）。
 *
 * **为什么必须只有一份**：这段逻辑此前在本仓有 21 处内联三目，另有两处各写了一份 `errorText`
 * （当时的两个探针页各写了一份 `errorText`），而**只有那两处做了空 message 回落**——同一个问题在同一个
 * 仓里有两个答案，正是「同一口径的第二份实现」。（另有一处形状相近但不属文案提取、因而未收拢的：
 * `services/platform/hiddenFileInput.ts:103` 是把非 `Error` 包成 `Error`，不是取文案。）放在 `services/`：views / stores / components /
 * composables 本来都从 `@/services/*` 取东西，是现成的跨层共享层（本文件不碰任何平台 API）。
 */
export function messageOf(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.message === "" ? error.name : error.message;
}
