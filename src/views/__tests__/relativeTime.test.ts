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

/** 同一时刻的 UTC 日期串（`toISOString().slice(0, 10)`），用来判断夹具在**本机时区**下能不能区分两种实现。 */
function utcDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

describe("formatRelativeTime（固定 now，不依赖机器时钟）", () => {
  it("同一时刻 → 刚刚", () => {
    expect(formatRelativeTime(ago(0), NOW)).toBe("刚刚");
  });

  it("不到 1 分钟 → 刚刚", () => {
    // 59 秒：钉「分钟档的上界」——把 `diff < MINUTE` 改成 `diff < 30_000` 时这条会红。
    expect(formatRelativeTime(ago(59_000), NOW)).toBe("刚刚");
    // 1 毫秒：钉「刚刚」这一档的**下界**。只有 59 秒那条时，把 `diff < MINUTE` 误写成
    // `diff < 1` 不会有任何断言在 1 毫秒这个点转红（59 秒会落进分钟档输出「0 分钟前」，
    // 但那是 59 秒那条自己先红，管不到 1 毫秒附近）。
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

  it("「昨天」按 24 小时时长判，不按日历日", () => {
    // 24 小时整：本机时区无论偏移多少，24 小时前的**本地日期**都是前一天（偏移 > 0 时跨到 D+1；
    // 偏移 = 0 时是 D−1；偏移 < 0 时是 D−2 —— 日期不同，但时长恒为 24h），所以「昨天」这个
    // 期望值在所有时区都成立。把实现改成「本地日历日不同就显示昨天」时本条照样绿（它也判本地日），
    // 但它把「按 24 小时时长分档」这条钉住了：`< 1 天` 那一档的上边界就在 24h。
    expect(formatRelativeTime(ago(DAY), NOW)).toBe("昨天");
    // 36 小时同样落在「昨天」这一档（1 ≤ diff/24h < 2）。
    expect(formatRelativeTime(ago(DAY + 12 * HOUR), NOW)).toBe("昨天");
    // 上边界（2 天整）由下面那条 `ago(2 * DAY) → "2 天前"` 钉住。
    // 这里刻意**不**再加一条贴着 2 天的断言：本轮实测把 `dayDiff === 1` 写成 `dayDiff < 2`
    // 时全绿 —— 在 `< DAY` 已经把 dayDiff = 0 拦掉的前提下，`< 2` 与 `=== 1` 在本函数的
    // 可观测范围内等价（等价变异体），多写一条也证不出判别力，不如不写。
  });

  it("16 小时前走小时档，不因为「本地日期不同」被提前判成昨天", () => {
    // 本用例的期望值「16 小时前」在偏移 −12…+11 内都成立：16 小时前那一瞬（20:00Z 的**前一天**，
    // 即 2026-10-02T20:00Z）与基准 NOW 落在**同一个本地日**（偏移 ≥ +5 时它是 10-03 的凌晨，
    // 偏移 ≤ +4 时是 10-02 的下午到晚上）。也就是说，一个「本地日历日不同就显示昨天」的实现在
    // 这个区间里**不会**被这条钉到——被钉到的是「按 24 小时时长分档」这件事本身
    // （`< 1 天` 那一档不该在 16 小时处被截断）。
    // 偏移 ≥ +12（如 Pacific/Kiritimati）时 16 小时前确实跨到前一天，本条会随实现语义一起变，
    // 属已知边界（本轮取证只覆盖 TZ=UTC 与 TZ=UTC+8，见报告）。
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
    // **不硬编码日期**：这个分支的输出按定义是**运行机器的本地日**，所以期望值必须用同一套本地
    // getter 从同一时刻现算，否则就是拿某一台机器（UTC+8）的时区当契约——在 TZ=UTC 的 CI 上必红
    // （本轮复审独立复现过；上一版这里硬编码 "2026-09-24"，是错的）。
    const timestamp = ago(8 * DAY + 14 * HOUR);
    const moment = new Date(timestamp);
    const result = formatRelativeTime(timestamp, NOW);
    // 形状：是一段 `YYYY-MM-DD`，不是原始 ISO 串
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result).toBe(localDateString(moment));

    // **自证断言已删除（合并前复审的阻断项）**：它曾写成「断言本地日 ≠ UTC 日」，用来证明这个
    // 夹具能区分「本地日实现」与 `toISOString()` 实现。但那不是在证明实现正确，而是在断言**运行
    // 环境的时区偏移**：夹具时刻固定 `22:00Z`，本地日 ≠ UTC 日**当且仅当偏移 ≥ +2h**。所以它在
    // UTC+8 绿、在 UTC 与 UTC−5 红——一条对被测实现**零判别力**、却会在真实开发机与 CI 上假红的
    // 断言（正违「断言存在 ≠ 断言有效」）。
    // 曾用 `getTimezoneOffset() !== 0` 守卫它，那是**必要但不充分**：只排除了偏移 0，其余不跨日的
    // 偏移照旧假红（实测 `America/New_York` / `Europe/London` / `Etc/GMT-1` 均 1 failed）。
    //
    // 真正的判别力在**上面 `expect(result).toBe(localDateString(moment))` 那一行**：把实现从
    // 「本地日」改成 `toISOString().slice(0, 10)`，在**偏移 ≥ +2h 的时区**（如 UTC+8）会被它抓到；
    // 在偏移 0 的时区则**任何同进程断言都不可能抓到**——两种实现在那里输出逐字节相同，信息不存在，
    // 不是写法问题。本仓库 CI 是 `ubuntu-latest`（UTC），故 CI 对这条实现选择**没有**判别力，
    // 该缺口记为延后项（要补只能给 CI 一个非零 TZ，属 `.github/` 变更）。
    const utcDay = utcDateString(moment);
    // 与偏移无关的夹具性质：这个时刻的 **UTC 日**恒为 2026-09-24（所有时区都成立），
    // 保证夹具确实落在日期边界附近，而不是随便取了一个时刻。
    expect(utcDay).toBe("2026-09-24");

    // 恰 7 天（下限闭区间）：把「超过一周」的阈值写成 `dayDiff <= 7` 时，这里会得到「7 天前」
    // 而不是日期串 → 转红。（上面那条 8 天整的用例对 `<= 7` 零判别力，变异实测 M3i 证明过。）
    // 这一条只钉「7 天该走日期分支」，不重复钉本地 / UTC 之差。（`ago(7 * DAY)` 在 UTC+8 下
    // 本地日与 UTC 日恰好相同，所以它从来不是本地 / UTC 的判别式。）
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
