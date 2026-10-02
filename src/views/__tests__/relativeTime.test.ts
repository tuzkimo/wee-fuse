import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "@/views/relativeTime";

/**
 * `formatRelativeTime` 的口径用例（规格 B1 §7.1：图纸库每条显示 `updatedAt` 的相对时间）。
 *
 * **关键纪律：`now` 一律显式传入，不用 `new Date()`。** 本项目的夹具时间戳（2026-10-03）在
 * 开发机上位于「未来」（机器时钟 2026-10-02），任何拿机器时钟当期望值的断言都会产生
 * 与代码正确性无关的假红（构建记录 §6 / R17；`LibraryPage.test.ts` 的重命名用例也被这条
 * 坑过一次）。这组用例因此与机器时钟**完全无关**：换一台时钟偏差几个月的机器也照样全绿。
 */

/** 固定基准时刻（UTC）。所有期望值都由它 + 明确偏移量算出，不看真实时间。 */
const NOW = new Date("2026-10-03T12:00:00.000Z");

/** 从基准时刻往前推 `ms` 毫秒，得到被测的 ISO 串。 */
function ago(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 本地日期串。用来把「与运行时刻的时区无关」这件事写进断言，而不是硬编码某个时区的日期。 */
function localDateString(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

describe("formatRelativeTime（固定 now，不依赖机器时钟）", () => {
  it("同一时刻 → 刚刚", () => {
    expect(formatRelativeTime(ago(0), NOW)).toBe("刚刚");
  });

  it("不到 1 分钟 → 刚刚", () => {
    expect(formatRelativeTime(ago(59_000), NOW)).toBe("刚刚");
    // 1 毫秒前也必须走「刚刚」分支：只测 59 秒的话，把 `diff < MINUTE` 误写成 `diff < 1`
    // 全绿，而 1 毫秒前的记录会渲染成「0 分钟前」。
    expect(formatRelativeTime(ago(1), NOW)).toBe("刚刚");
  });

  it("恰 1 分钟 → 「1 分钟前」（分钟档的下边界是闭区间）", () => {
    expect(formatRelativeTime(ago(MINUTE), NOW)).toBe("1 分钟前");
  });

  it("59 分钟 → 「59 分钟前」；取整是向下取整，不是四舍五入", () => {
    // 59.9 分钟必须显示 59（向下取整）。改成 Math.round 会得到「60 分钟前」→ 这条转红。
    expect(formatRelativeTime(ago(59 * MINUTE + 54_000), NOW)).toBe("59 分钟前");
  });

  it("1 小时 → 「1 小时前」，且在小时档里不再显示分钟", () => {
    expect(formatRelativeTime(ago(HOUR), NOW)).toBe("1 小时前");
    expect(formatRelativeTime(ago(HOUR + 30 * MINUTE), NOW)).toBe("1 小时前");
  });

  it("23 小时 → 「23 小时前」（小时档的上边界）", () => {
    expect(formatRelativeTime(ago(23 * HOUR), NOW)).toBe("23 小时前");
  });

  it("24 小时 → 「昨天」（满一天后不再按小时数显示）", () => {
    expect(formatRelativeTime(ago(DAY), NOW)).toBe("昨天");
    expect(formatRelativeTime(ago(DAY + 12 * HOUR), NOW)).toBe("昨天");
  });

  it("「昨天」按 24 小时时长判，不按日历日（16 小时前仍是「16 小时前」）", () => {
    // 若改成「日期不同就显示昨天」，本条会红：基准 NOW 是本地 20:00，16 小时前是当天 04:00
    // 同一天——真的按日历日判就会输出「昨天」。
    expect(formatRelativeTime(ago(16 * HOUR), NOW)).toBe("16 小时前");
  });

  it("2 天 / 6 天 → 「2 天前」/「6 天前」（天数按 24 小时时长向下取整）", () => {
    expect(formatRelativeTime(ago(2 * DAY), NOW)).toBe("2 天前");
    expect(formatRelativeTime(ago(6 * DAY), NOW)).toBe("6 天前");
    // 3 天这条也留着：把 `dayDiff === 1` 误写成 `dayDiff >= 1` 时它会得到「昨天」而转红。
    expect(formatRelativeTime(ago(3 * DAY), NOW)).toBe("3 天前");
    // 贴着一周下边界：把「超过一周」的阈值写成 `<= 7` 时，这条会得到「6 天前」而转红。
    expect(formatRelativeTime(ago(6 * DAY + 23 * HOUR), NOW)).toBe("6 天前");
  });

  it("超过一周 → 本地日期串 YYYY-MM-DD（不是 ISO 串、不是 UTC 日期）", () => {
    const timestamp = ago(8 * DAY);
    const result = formatRelativeTime(timestamp, NOW);
    // 形状：是一段 `YYYY-MM-DD`，不是原始 ISO 串（`2026-09-25T04:00:00.000Z`）
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // 值是**本地**日期：本机时区是 UTC+8（+8 小时），基准 NOW = 2026-10-03T12:00Z 的本地日期
    // 是 2026-10-03，8 天前是本地 2026-09-25。若实现改用 `toISOString().slice(0, 10)`（UTC 日期），
    // 在 UTC 为正偏移的时区上会差一天 → 转红。
    expect(result).toBe(localDateString(new Date(NOW.getTime() - 8 * DAY)));
  });

  it("未来时间戳 → 刚刚，不渲染负的时长（本机时钟早于夹具时常踩的一支）", () => {
    expect(formatRelativeTime(new Date(NOW.getTime() + DAY).toISOString(), NOW)).toBe("刚刚");
    expect(formatRelativeTime(new Date(NOW.getTime() + 365 * DAY).toISOString(), NOW)).toBe("刚刚");
  });

  it("非法时间串 → 原样返回，不抛错（一行坏时间戳不该炸掉整个列表）", () => {
    expect(formatRelativeTime("", NOW)).toBe("");
    expect(formatRelativeTime("不是时间", NOW)).toBe("不是时间");
  });
});
