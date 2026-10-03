/**
 * 列表用「相对时间」格式化（规格 B1 §7.1：图纸库每条要显示 `updatedAt` 的相对时间）。
 *
 * **为什么放在 `src/views/` 而不是 `src/services/`**：`AGENTS.md` 把 `src/services/**` 定为
 * 「唯一接触平台 API 的层」，而这个模块是**纯字符串计算**——不 import 任何东西、不碰任何平台
 * 能力。它也不属于 `src/core/**`（那是与框架无关的引擎，且闸门要扫它，没必要为一行 UI 文案
 * 往引擎层塞展示逻辑）。放在唯一的消费者（`LibraryPage.vue`）旁边的独立文件里，既落在页面层，
 * 又能被单测直接 import——不必为了拿到这个函数去 mount 一个组件。
 *
 * **`now` 必须是参数，不能读机器时钟**：本项目的夹具时间戳（2026-10-03）在开发机上位于
 * 「未来」（机器时钟 2026-10-02），任何与被测数据比较的 `new Date()` 都会得到**负数时长**，
 * 从而产生与代码正确性无关的假红（构建记录 §6 / R17）。把 `now` 收成入参后，单测可以给一个
 * 固定时刻，日夜与时钟漂移都不影响结果。
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 本地日期串 `YYYY-MM-DD`。用本地时间而不是 `toISOString()`：用户看到的日期应当是他所在时区的。 */
function toLocalDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * 把 ISO 时间串格式化成列表里的相对时间。
 *
 * 口径（从近到远，遇到第一个命中的返回）：
 * - 非法的 `iso`（含空串）→ 原样返回，不抛错：这是纯展示，不该让一行坏时间戳炸掉整个页面；
 * - 时长为负（`iso` 在未来）→ `"刚刚"`。本机时钟早于夹具时间戳（见文件头）时正需要这条，
 *   否则「未来」会被算成负的分钟 / 小时数并渲染出 `-1 分钟前`；
 * - < 1 分钟 → `"刚刚"`；
 * - < 1 小时 → `"N 分钟前"`；
 * - < 1 天 → `"N 小时前"`；
 * - 时长为 1–2 天（`dayDiff === 1`）→ `"昨天"`。**「昨天」按 24 小时时长判，不按日历日**：
 *   16 小时前的记录显示「16 小时前」而不是「昨天」——那种口径更反直觉；
 * - 2–6 天 → `"N 天前"`；
 * - ≥ 7 天 → `"YYYY-MM-DD"`（本地日期）。
 */
export function formatRelativeTime(iso: string, now: Date): string {
  const then = new Date(iso);
  const timestamp = then.getTime();
  if (!Number.isFinite(timestamp)) return iso;

  const diff = now.getTime() - timestamp;
  if (diff < MINUTE) return "刚刚";
  if (diff < HOUR) return `${String(Math.floor(diff / MINUTE))} 分钟前`;
  if (diff < DAY) return `${String(Math.floor(diff / HOUR))} 小时前`;

  const dayDiff = Math.floor(diff / DAY);
  if (dayDiff === 1) return "昨天";
  if (dayDiff < 7) return `${String(dayDiff)} 天前`;
  return toLocalDateString(then);
}
