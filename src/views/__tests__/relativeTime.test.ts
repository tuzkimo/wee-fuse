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
    // 这个夹具刻意选在**本地日期与 UTC 日期不同**的时刻：2026-09-24T22:00Z 在 UTC+8 下是
    // 本地 2026-09-25 06:00。若实现改用 `toISOString().slice(0, 10)`（UTC 日期），本机时区上
    // 就会给出 2026-09-24 → 第 94 行的相等断言转红。
    // （最初选的 8 天整 = 2026-09-25T12:00Z 在 UTC+8 下是本地 09-25 20:00，两侧**日期相同**，
    // 于是那条断言对「本地 vs UTC」零判别力——变异实测（M3f 第一次跑）发现，已修。）
    const timestamp = ago(8 * DAY + 14 * HOUR);
    const result = formatRelativeTime(timestamp, NOW);
    // 形状：是一段 `YYYY-MM-DD`，不是原始 ISO 串
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result).toBe(localDateString(new Date(timestamp)));
    // 显式证明这个夹具本身有判别力：运行时刻两侧的日期真的不同（UTC 日 ≠ 本地日）
    expect(timestamp.slice(0, 10)).not.toBe(localDateString(new Date(timestamp)));

    // 恰 7 天（下限闭区间）：把「超过一周」的阈值写成 `dayDiff <= 7` 时，这里会得到「7 天前」
    // 而不是日期串 → 转红。（上面那条 8 天整的用例对 `<= 7` 零判别力，变异实测 M3i 证明过。）
    // 这一条只钉「7 天该走日期分支」，不重复钉本地 / UTC 之差（那是上面那个夹具的职责：
    // `ago(7 * DAY)` = 2026-09-26T12:00Z 在 UTC+8 下是本地 09-26 20:00，两侧日期恰好相同）。
    const sevenDays = ago(7 * DAY);
    expect(formatRelativeTime(sevenDays, NOW)).toBe(localDateString(new Date(sevenDays)));
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
