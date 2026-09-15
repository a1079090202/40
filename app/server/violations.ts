import type { DB } from "./db";
import { BOOK_BAN_DAYS, NO_SHOW_GRACE_MINUTES, VIOLATION_LIMIT_PER_MONTH } from "./config";
import { addDays, dateOf, fmtDate, nowLocal, parseSlot } from "./time";
import { forfeit } from "./wallet";

export class ViolationError extends Error {}

/** 某自然月违约次数，ym 形如 'YYYY-MM' */
export function violationsInMonth(db: DB, memberId: number, ym: string) {
  return db
    .prepare(
      "SELECT * FROM violations WHERE member_id = ? AND substr(date,1,7) = ? ORDER BY date, id",
    )
    .all(memberId, ym) as Array<{
      id: number;
      member_id: number;
      booking_id: number;
      date: string;
      created_at: string;
    }>;
}

export interface BanStatus {
  banned: boolean;
  countInMonth: number;
  until?: string; // 'YYYY-MM-DD'
}

/**
 * 月违约 3 次限订一周：
 * 看 at 所在自然月，第 3 次违约发生日 +7 天仍覆盖 at，则限订。
 */
export function banStatusAt(db: DB, memberId: number, at: Date): BanStatus {
  const ym = fmtDate(at).slice(0, 7);
  const list = violationsInMonth(db, memberId, ym);
  if (list.length < VIOLATION_LIMIT_PER_MONTH) {
    return { banned: false, countInMonth: list.length };
  }
  const third = list[VIOLATION_LIMIT_PER_MONTH - 1]!;
  const until = addDays(third.date, BOOK_BAN_DAYS); // 限订至该日（不含）
  const today = fmtDate(at);
  return { banned: today < until, countInMonth: list.length, until };
}

export function assertNotBanned(db: DB, memberId: number, at: Date): void {
  const s = banStatusAt(db, memberId, at);
  if (s.banned) {
    throw new ViolationError(`本月已违约 ${s.countInMonth} 次，限制订场至 ${s.until}`);
  }
}

export interface NoShowResult {
  bookingId: number;
  memberId: number;
  timesForfeited: number;
  centsForfeited: number;
}

/**
 * 爽约扫表：所有 held 单，开始时间 + 宽限（30 分钟）已过仍未核销的，
 * 冻结不退（扣次/扣钱）、置 no_show、记一次违约。
 */
export function sweepNoShows(db: DB, now: Date = nowLocal()): NoShowResult[] {
  const rows = db
    .prepare("SELECT * FROM bookings WHERE status = 'held' ORDER BY start_slot")
    .all() as Array<{
      id: number;
      member_id: number;
      start_slot: string;
    }>;

  const results: NoShowResult[] = [];
  const mark = db.transaction((b: (typeof rows)[number]) => {
    const deadline = new Date(parseSlot(b.start_slot).getTime() + NO_SHOW_GRACE_MINUTES * 60_000);
    if (deadline.getTime() > now.getTime()) return;

    const f = forfeit(db, b.id, "爽约不退冻结");
    db.prepare(
      "UPDATE bookings SET status = 'no_show', finalized_at = ? WHERE id = ?",
    ).run(now.toISOString(), b.id);
    db.prepare(
      "INSERT INTO violations (member_id, booking_id, type, date, created_at) VALUES (?, ?, 'no_show', ?, ?)",
    ).run(b.member_id, b.id, dateOf(b.start_slot), now.toISOString());
    results.push({ bookingId: b.id, memberId: b.member_id, timesForfeited: f.times, centsForfeited: f.cents });
  });

  for (const row of rows) mark(row);
  return results;
}
