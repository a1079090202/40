import { findConflicts, freeSlotsOnCourtDate, type Conflict } from "./availability";
import {
  BOOK_AHEAD_DAYS,
  CANCEL_FREE_MINUTES,
  MAX_SLOTS_PER_BOOKING,
  OPEN_FROM,
  OPEN_TO,
} from "./config";
import type { DB } from "./db";
import { priceSlots } from "./pricing";
import {
  addDays,
  addSlots,
  dateOf,
  diffMinutes,
  fmtSlot,
  nowLocal,
  parseSlot,
  slotKey,
  slotSequence,
  slotSpan,
} from "./time";
import { assertNotBanned } from "./violations";
import { consume, forfeit, freeze, getCard, release } from "./wallet";
import { getCourt, listCourts } from "./catalog";

export class BookingError extends Error {
  conflicts?: Conflict[];
  alternatives?: Alternative[];
  constructor(message: string, conflicts?: Conflict[], alternatives?: Alternative[]) {
    super(message);
    this.conflicts = conflicts;
    this.alternatives = alternatives;
  }
}

export interface Alternative {
  courtId: number;
  courtName: string;
  courtType: string;
  startSlot: string;
  endSlot: string;
  tier: number; // 1=同时段其他场地 2=同场同日相邻时段 3=同场他日同时段
  reason: string;
}

export interface CreateBookingInput {
  memberId: number;
  cardId: number;
  courtId: number;
  startSlot: string;
  endSlot: string;
  now?: Date;
}

const ACTIVE = "status IN ('held','checked_in')";

/**
 * 散客下单。校验顺序：时段合法 → 违约限订 → 卡匹配且额度够 → 场地冲突。
 * 冲突必拦，并给出最近可用替代场地/时段。
 * 同一时段先到先得：DB 写入顺序即排队顺序，后下者必撞先下者。
 */
export function createBooking(db: DB, input: CreateBookingInput): number {
  const now = input.now ?? nowLocal();
  const court = getCourt(db, input.courtId);
  if (!court) throw new BookingError("场地不存在");

  const start = parseSlot(input.startSlot);
  const end = parseSlot(input.endSlot);
  if (start.getMinutes() % 30 !== 0 || end.getMinutes() % 30 !== 0) {
    throw new BookingError("时段必须对齐到半小时");
  }
  if (!(input.startSlot.slice(11) >= OPEN_FROM && input.endSlot.slice(11) <= OPEN_TO && start < end)) {
    throw new BookingError(`时段必须落在开放时间 ${OPEN_FROM}–${OPEN_TO} 内`);
  }
  const span = slotSpan(input.startSlot, input.endSlot);
  if (span > MAX_SLOTS_PER_BOOKING) {
    throw new BookingError(`单次预订不能超过 ${MAX_SLOTS_PER_BOOKING / 2} 小时`);
  }
  if (start.getTime() <= now.getTime()) {
    throw new BookingError("开始时间必须晚于当前时间");
  }
  if (diffMinutes(input.startSlot, fmtSlot(now)) > BOOK_AHEAD_DAYS * 24 * 60) {
    throw new BookingError(`最多提前 ${BOOK_AHEAD_DAYS} 天预订`);
  }

  assertNotBanned(db, input.memberId, now);

  const card = getCard(db, input.cardId);
  if (!card || !card.active || card.member_id !== input.memberId) {
    throw new BookingError("支付卡不可用或不属于该会员");
  }
  if (card.kind === "package") {
    if (card.court_type !== court.type) {
      throw new BookingError(`该次卡仅限 ${card.court_type === "badminton" ? "羽毛球" : "篮球"} 场地`);
    }
  }

  const conflicts = findConflicts(db, input.courtId, input.startSlot, input.endSlot);
  if (conflicts.length > 0) {
    const alternatives = recommendAlternatives(db, court.type, input.startSlot, input.endSlot, input.courtId, now);
    throw new BookingError("该时段已被占用", conflicts, alternatives);
  }

  const slots = slotSequence(input.startSlot, input.endSlot);
  const price = priceSlots(court.type, slots);

  return db.transaction(() => {
    // 事务内复查，防并发下两个单同时穿过首次检查
    const again = findConflicts(db, input.courtId, input.startSlot, input.endSlot);
    if (again.length > 0) {
      throw new BookingError("该时段已被占用", again, recommendAlternatives(db, court.type, input.startSlot, input.endSlot, input.courtId, now));
    }

    const info = db
      .prepare(
        `INSERT INTO bookings (member_id, card_id, court_id, start_slot, end_slot, slot_count,
                                status, court_fee_cents, light_fee_cents, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'held', ?, ?, ?)`,
      )
      .run(
        input.memberId,
        input.cardId,
        input.courtId,
        input.startSlot,
        input.endSlot,
        span,
        price.courtFeeCents,
        price.lightFeeCents,
        now.toISOString(),
      );
    const bookingId = Number(info.lastInsertRowid);

    try {
      freeze(
        db,
        card.kind === "package"
          ? { cardId: card.id, bookingId, times: span, cents: 0 }
          : { cardId: card.id, bookingId, times: 0, cents: price.totalCents },
      );
    } catch (e) {
      throw new BookingError((e as Error).message);
    }
    return bookingId;
  })();
}

/**
 * 替代推荐：
 * 1) 同日同时段的其他同类型场地（按场地序号）
 * 2) 同场（优先）/同日相邻的最近时段（整段平移，半小时步进）
 * 3) 未来 14 天内同时段
 * 结果按层级、距请求时刻的分钟差、是否同场排序。
 */
export function recommendAlternatives(
  db: DB,
  courtType: string,
  startSlot: string,
  endSlot: string,
  preferredCourtId?: number,
  now: Date = nowLocal(),
  limit = 6,
): Alternative[] {
  const span = slotSpan(startSlot, endSlot);
  const date = dateOf(startSlot);
  const courts = listCourts(db).filter((c) => c.type === courtType);
  const scored: Array<{ alt: Alternative; distanceMin: number; sameCourt: boolean }> = [];  const seen = new Set<string>();

  const windowFree = (courtId: number, s: string, e: string): boolean => {
    if (parseSlot(s).getTime() <= now.getTime()) return false;
    if (s.slice(11) < OPEN_FROM || e.slice(11) > OPEN_TO) return false;
    return findConflicts(db, courtId, s, e).length === 0;
  };

  const push = (alt: Alternative, distanceMin: number) => {
    const key = `${alt.courtId}|${alt.startSlot}`;
    if (seen.has(key)) return;
    seen.add(key);
    scored.push({ alt, distanceMin, sameCourt: alt.courtId === preferredCourtId });
  };

  // tier 1：换场不换时间
  for (const c of courts) {
    if (c.id === preferredCourtId) continue;
    if (windowFree(c.id, startSlot, endSlot)) {
      push(
        {
          courtId: c.id,
          courtName: c.name,
          courtType: c.type,
          startSlot,
          endSlot,
          tier: 1,
          reason: `同日同时段 ${c.name} 空闲`,
        },
        0,
      );
    }
  }

  // tier 2：同日整段平移（向前优先、半小时步进），优先原场地
  for (const delta of [1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6]) {
    const s = addSlots(startSlot, delta);
    if (dateOf(s) !== date) continue;
    const e = addSlots(s, span);
    for (const c of courts) {
      if (windowFree(c.id, s, e)) {
        push(
          {
            courtId: c.id,
            courtName: c.name,
            courtType: c.type,
            startSlot: s,
            endSlot: e,
            tier: 2,
            reason: `${c.name} 同日相邻时段`,
          },
          Math.abs(diffMinutes(s, startSlot)),
        );
      }
    }
  }

  // tier 3：未来两周同时段
  for (let day = 1; day <= BOOK_AHEAD_DAYS; day++) {
    const d = addDays(date, day);
    const s = slotKey(d, startSlot.slice(11));
    const e = slotKey(d, endSlot.slice(11));
    for (const c of courts) {
      if (windowFree(c.id, s, e)) {
        push(
          {
            courtId: c.id,
            courtName: c.name,
            courtType: c.type,
            startSlot: s,
            endSlot: e,
            tier: 3,
            reason: `${c.name} 最近同时段空档`,
          },
          day * 24 * 60,
        );
      }
    }
  }

  return scored
    .sort((a, b) => a.alt.tier - b.alt.tier || a.distanceMin - b.distanceMin || Number(b.sameCourt) - Number(a.sameCourt))
    .slice(0, limit)
    .map((x) => x.alt);
}

export interface BookingRow {
  id: number;
  member_id: number;
  card_id: number;
  court_id: number;
  start_slot: string;
  end_slot: string;
  slot_count: number;
  status: string;
  court_fee_cents: number;
  light_fee_cents: number;
  created_at: string;
  checked_in_at: string | null;
  cancelled_at: string | null;
  finalized_at: string | null;
}

export function getBooking(db: DB, bookingId: number): BookingRow | undefined {
  return db.prepare("SELECT * FROM bookings WHERE id = ?").get(bookingId) as BookingRow | undefined;
}

/** 到场核销：冻结转真实扣减，灯光费一并入账 */
export function checkIn(db: DB, bookingId: number, now: Date = nowLocal()) {
  const b = mustGetHeld(db, bookingId);
  const court = getCourt(db, b.court_id)!;
  const actual = priceSlots(court.type, slotSequence(b.start_slot, b.end_slot));
  return db.transaction(() => {
    const result = consume(db, bookingId, actual.courtFeeCents, actual.lightFeeCents);
    db.prepare(
      "UPDATE bookings SET status = 'checked_in', checked_in_at = ?, finalized_at = ?, court_fee_cents = ?, light_fee_cents = ? WHERE id = ?",
    ).run(now.toISOString(), now.toISOString(), actual.courtFeeCents, actual.lightFeeCents, bookingId);
    return result;
  })();
}

/**
 * 取消：开始前 >2h 全额退冻结；2h 内不退（late_cancelled）。
 * 开始后不允许取消，等爽约扫表。
 */
export function cancelBooking(db: DB, bookingId: number, now: Date = nowLocal()): "cancelled" | "late_cancelled" {
  const b = mustGetHeld(db, bookingId);
  const start = parseSlot(b.start_slot);
  if (start.getTime() <= now.getTime()) {
    throw new BookingError("已过开始时间，不能取消，请核销或等待爽约处理");
  }
  const mins = (start.getTime() - now.getTime()) / 60_000;
  return db.transaction(() => {
    if (mins > CANCEL_FREE_MINUTES) {
      release(db, bookingId);
      db.prepare("UPDATE bookings SET status = 'cancelled', cancelled_at = ?, finalized_at = ? WHERE id = ?").run(
        now.toISOString(),
        now.toISOString(),
        bookingId,
      );
      return "cancelled" as const;
    }
    forfeit(db, bookingId, "开始前 2 小时内取消，不退冻结");
    db.prepare("UPDATE bookings SET status = 'late_cancelled', cancelled_at = ?, finalized_at = ? WHERE id = ?").run(
      now.toISOString(),
      now.toISOString(),
      bookingId,
    );
    return "late_cancelled" as const;
  })();
}

function mustGetHeld(db: DB, bookingId: number): BookingRow {
  const b = getBooking(db, bookingId);
  if (!b) throw new BookingError("预订不存在");
  if (b.status !== "held") throw new BookingError(`预订当前状态为 ${b.status}，不能操作`);
  return b;
}

export function listBookingsOnDate(db: DB, date: string): BookingWithNames[] {
  return db
    .prepare(
      `SELECT b.*, m.name AS member_name, c.name AS court_name
         FROM bookings b JOIN members m ON m.id = b.member_id
                        JOIN courts c ON c.id = b.court_id
        WHERE substr(b.start_slot,1,10) = ? ORDER BY b.start_slot, b.id`,
    )
    .all(date) as BookingWithNames[];
}

export interface BookingWithNames extends BookingRow {
  member_name: string;
  court_name: string;
}

export function listBookingsByMember(db: DB, memberId: number) {
  return db
    .prepare(
      `SELECT b.*, c.name AS court_name
         FROM bookings b JOIN courts c ON c.id = b.court_id
        WHERE b.member_id = ? ORDER BY b.start_slot DESC, b.id DESC`,
    )
    .all(memberId);
}

export { freeSlotsOnCourtDate, ACTIVE };
