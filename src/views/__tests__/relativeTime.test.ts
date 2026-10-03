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

    // **注意这条用例对「本地日 vs UTC 日」没有判别力**：它的期望值是用同一套本地 getter 现算的
    // （不硬编码是刻意的——输出按定义就是**运行机器的本地日**，硬编码等于拿某一台机器的时区当契约），
    // 所以在偏移 0 的机器（本仓库 CI 的 `ubuntu-latest`）上它无法区分两种实现。真正的判别力由下面
    // 两条**钉住时区**的用例承担，见它们的注释。
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

  /**
   * 日期分支用的是**本地日**还是 **UTC 日**？（正偏移：UTC 22:00Z 在 UTC+8 已是次日）
   *
   * **为什么必须钉时区**：这条实现选择只在「本地日 ≠ UTC 日」的时区才能被观察到，而在偏移 0 的
   * 机器（本仓库 CI 是 `ubuntu-latest`）上两种实现输出**逐字节相同**——信息不存在，任何同进程断言
   * 都抓不到。曾经的做法是写一条「断言本地日 ≠ UTC 日」的自证断言来充当守门，但它的判别力为零、
   * 却只在偏移 ≥ +2h 成立，于是 UTC、西半球、UTC+1 下**必红**（先用 `getTimezoneOffset() !== 0`
   * 守卫是「必要但不充分」，实测 `America/New_York` / `Europe/London` / `Etc/GMT-1` 均 1 failed）。
   *
   * 正确做法照**同组织 WeeCount 的仓内先例**（`src/utils/__tests__/datetime.test.ts` 的
   * `should roll to next local day for early-morning UTC times in positive offset zones`）：
   * 在用例内 `process.env.TZ = …` 钉住时区、`try/finally` 逐字还原。这样断言**与运行机器的时区
   * 无关**（在 UTC runner 上也成立），同时**恢复了判别力**——不需要改 `.github/`。
   *
   * 实测运行期切换确实生效：`22:00Z` 在 `Asia/Shanghai` 下是 `2026-09-25`、在 `America/New_York`
   * 下是 `2026-09-24`，且 `finally` 还原后本地 getter 回到原值。
   *
   * **为什么经 `globalThis` 取 `process.env` 而不是直接写 `process.env`**：本仓库 `tsconfig.json`
   * 的 `types` 只有 `["vitest/globals"]`，直接写 `process` 会以 `TS2591` 卡住 `npm run build`；
   * 而补一个文件级 `/// <reference types="node" />` 是 `AGENTS.md` **明令禁止**的——它会把
   * `@types/node` 拉进整个 `vue-tsc` 程序，从而**削弱 `src/core/**` 那道 Node 全局闸门**
   * （`src/__tests__/coreBoundary.test.ts` 头部记载了实测）。经 `globalThis` 取用两者都避开。
   */
  const withPinnedTimezone = (tz: string, body: () => void): void => {
    const globals = globalThis as { process?: { env: Record<string, string | undefined> } };
    const env = globals.process?.env;
    const prevTZ = env?.TZ;
    if (env !== undefined) env.TZ = tz;
    try {
      body();
    } finally {
      if (env !== undefined) {
        if (prevTZ === undefined) delete env.TZ;
        else env.TZ = prevTZ;
      }
    }
  };

  it("固定 Asia/Shanghai（UTC+8）时日期分支给当地次日，不是 UTC 日（抓 toISOString() 实现）", () => {
    withPinnedTimezone("Asia/Shanghai", () => {
      // 夹具：NOW 之前 14 天 14 小时 → 本地日必然是当地日期，与 UTC 日相差一天
      const timestamp = ago(14 * DAY + 14 * HOUR);
      const moment = new Date(timestamp);
      const localDay = localDateString(moment);
      const utcDay = utcDateString(moment);
      // 先确认这条夹具在钉住的时区下**真的**能区分两种实现（否则下面的断言是空的）
      expect(localDay).not.toBe(utcDay);

      const result = formatRelativeTime(timestamp, NOW);
      expect(result).toBe(localDay);
      // 再明确排除 UTC 日：改成 `toISOString().slice(0, 10)` 会让上面这行拿到 utcDay 而转红
      expect(result).not.toBe(utcDay);
    });
  });

  it("固定 America/New_York（UTC−4）时同样给当地日期（负偏移方向也钉住）", () => {
    withPinnedTimezone("America/New_York", () => {
      // 夹具设计：NY 在 9 月是 UTC−4，所以取一个**当地是前一天**的时刻 ——
      // `ago(15 * DAY + 12 * HOUR)` 落在当地 20:00 左右（其 UTC 日已翻到次日）。
      // 下面那条 `not.toBe` 是**前置自证**：它确认该时刻在当地与 UTC 下确实跨日，
      // 从而保证紧随其后的断言真的在区分两种实现（第一次写的 15 天整夹具两侧同日，
      // 正是被这条前置断言抓出来的）。
      const timestamp = ago(15 * DAY + 12 * HOUR);
      const moment = new Date(timestamp);
      const localDay = localDateString(moment);
      const utcDay = utcDateString(moment);
      expect(localDay).not.toBe(utcDay);

      const result = formatRelativeTime(timestamp, NOW);
      expect(result).toBe(localDay);
      expect(result).not.toBe(utcDay);
    });
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
