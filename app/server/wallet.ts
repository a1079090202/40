import type { DB } from "./db";
import { nowLocal } from "./time";

export type CardKind = "package" | "stored_value";
export type CourtType = "badminton" | "basketball";

export class WalletError extends Error {}

export interface CardRow {
  id: number;
  member_id: number;
  kind: CardKind;
  court_type: CourtType | null;
  remaining_times: number | null;
  frozen_times: number;
  balance_cents: number | null;
  frozen_cents: number;
  active: number;
}

interface HoldRow {
  id: number;
  card_id: number;
  booking_id: number;
  resource: "times" | "cash";
  amount: number;
  status: "held" | "released" | "consumed" | "forfeited";
}

export function getCard(db: DB, cardId: number): CardRow | undefined {
  return db.prepare("SELECT * FROM cards WHERE id = ?").get(cardId) as CardRow | undefined;
}

export function listMemberCards(db: DB, memberId: number): CardRow[] {
  return db
    .prepare("SELECT * FROM cards WHERE member_id = ? AND active = 1 ORDER BY id")
    .all(memberId) as CardRow[];
}

export function usableTimes(card: CardRow): number {
  return (card.remaining_times ?? 0) - card.frozen_times;
}

export function usableBalance(card: CardRow): number {
  return (card.balance_cents ?? 0) - card.frozen_cents;
}

/** 开卡 */
export function issueCard(
  db: DB,
  input:
    | { memberId: number; kind: "package"; courtType: CourtType; times: number }
    | { memberId: number; kind: "stored_value"; initialCents: number },
): number {
  const now = nowLocal().toISOString();
  if (input.kind === "package") {
    if (input.times <= 0) throw new WalletError("次卡次数必须大于 0");
    const info = db
      .prepare(
        `INSERT INTO cards (member_id, kind, court_type, remaining_times, frozen_times, balance_cents, frozen_cents, created_at)
         VALUES (?, 'package', ?, ?, 0, NULL, 0, ?)`,
      )
      .run(input.memberId, input.courtType, input.times, now);
    return Number(info.lastInsertRowid);
  }
  if (input.initialCents < 0) throw new WalletError("充值金额不能为负");
  const info = db
    .prepare(
      `INSERT INTO cards (member_id, kind, court_type, remaining_times, frozen_times, balance_cents, frozen_cents, created_at)
       VALUES (?, 'stored_value', NULL, NULL, 0, ?, 0, ?)`,
    )
    .run(input.memberId, input.initialCents, now);
  return Number(info.lastInsertRowid);
}

export function recharge(db: DB, cardId: number, cents: number): void {
  const card = getCard(db, cardId);
  if (!card || card.kind !== "stored_value") throw new WalletError("储值卡不存在");
  if (cents <= 0) throw new WalletError("充值金额必须大于 0");
  db.prepare("UPDATE cards SET balance_cents = balance_cents + ? WHERE id = ?").run(cents, cardId);
}

export interface FreezeSpec {
  cardId: number;
  bookingId: number;
  times: number; // 次卡冻结格数（一次一格）
  cents: number; // 储值卡冻结金额（场租+灯光预估，分）
}

function assertCardUsable(card: CardRow): void {
  if (!card.active) throw new WalletError("卡已停用");
}

function insertTxn(
  db: DB,
  cardId: number,
  bookingId: number | null,
  type: "freeze" | "release" | "consume",
  resource: "times" | "cash",
  category: "court" | "light" | "forfeit",
  amount: number,
  balanceAfter: number | null,
  note: string,
  at: string,
): void {
  db.prepare(
    `INSERT INTO card_txns (card_id, booking_id, type, resource, category, amount, balance_after, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(cardId, bookingId, type, resource, category, amount, balanceAfter, note, at);
}

function settleHold(db: DB, hold: HoldRow, status: HoldRow["status"], at: string): void {
  db.prepare("UPDATE card_holds SET status = ?, settled_at = ? WHERE id = ?").run(status, at, hold.id);
}

function heldHolds(db: DB, bookingId: number): HoldRow[] {
  return db
    .prepare("SELECT * FROM card_holds WHERE booking_id = ? AND status = 'held'")
    .all(bookingId) as HoldRow[];
}

/** 下单冻结：次卡冻次数，储值卡冻金额。调用方需先完成业务校验。 */
export function freeze(db: DB, spec: FreezeSpec): void {
  const card = getCard(db, spec.cardId);
  if (!card) throw new WalletError("卡不存在");
  assertCardUsable(card);
  const now = nowLocal().toISOString();

  if (card.kind === "package") {
    if (spec.times <= 0) throw new WalletError("冻结次数必须大于 0");
    if (usableTimes(card) < spec.times) {
      throw new WalletError(`次卡可用次数不足（可用 ${usableTimes(card)}，需 ${spec.times}）`);
    }
    db.prepare("UPDATE cards SET frozen_times = frozen_times + ? WHERE id = ?").run(spec.times, card.id);
    db.prepare(
      "INSERT INTO card_holds (card_id, booking_id, resource, amount, status, created_at) VALUES (?, ?, 'times', ?, 'held', ?)",
    ).run(card.id, spec.bookingId, spec.times, now);
    insertTxn(db, card.id, spec.bookingId, "freeze", "times", "court", spec.times, null, "下单冻结次数", now);
  } else {
    if (spec.cents <= 0) throw new WalletError("冻结金额必须大于 0");
    if (usableBalance(card) < spec.cents) {
      throw new WalletError(
        `储值卡余额不足（可用 ¥${(usableBalance(card) / 100).toFixed(2)}，需 ¥${(spec.cents / 100).toFixed(2)}）`,
      );
    }
    db.prepare("UPDATE cards SET frozen_cents = frozen_cents + ? WHERE id = ?").run(spec.cents, card.id);
    db.prepare(
      "INSERT INTO card_holds (card_id, booking_id, resource, amount, status, created_at) VALUES (?, ?, 'cash', ?, 'held', ?)",
    ).run(card.id, spec.bookingId, spec.cents, now);
    insertTxn(db, card.id, spec.bookingId, "freeze", "cash", "court", spec.cents, usableBalance(getCard(db, card.id)!) - spec.cents, "下单冻结金额", now);
  }
}

/** 开始前 2h 以外取消：全额释放冻结 */
export function release(db: DB, bookingId: number): void {
  const now = nowLocal().toISOString();
  for (const hold of heldHolds(db, bookingId)) {
    const card = getCard(db, hold.card_id)!;
    if (hold.resource === "times") {
      db.prepare("UPDATE cards SET frozen_times = frozen_times - ? WHERE id = ?").run(hold.amount, card.id);
    } else {
      db.prepare("UPDATE cards SET frozen_cents = frozen_cents - ? WHERE id = ?").run(hold.amount, card.id);
    }
    settleHold(db, hold, "released", now);
    const fresh = getCard(db, card.id)!;
    insertTxn(
      db,
      card.id,
      bookingId,
      "release",
      hold.resource,
      "court",
      hold.amount,
      hold.resource === "cash" ? usableBalance(fresh) : null,
      "取消释放冻结",
      now,
    );
  }
}

export interface ConsumeResult {
  cardKind: CardKind;
  timesCharged: number;
  cashChargedCents: number; // 从储值卡扣的金额
  lightCashCents: number;   // 次卡用户现收灯光费（计场馆收入，不经卡）
}

/**
 * 核销：冻结转为真实扣减。
 * - 次卡：冻结的格数扣次；灯光费现收，写场馆收入。
 * - 储值卡：冻结的金额按实际场租+灯光扣减，多冻的部分释放。
 */
export function consume(
  db: DB,
  bookingId: number,
  courtFeeCents: number,
  lightFeeCents: number,
): ConsumeResult {
  const holds = heldHolds(db, bookingId);
  if (holds.length === 0) throw new WalletError(`预订 ${bookingId} 没有可扣减的冻结`);
  const now = nowLocal().toISOString();
  const card = getCard(db, holds[0]!.card_id)!;

  if (card.kind === "package") {
    const timesHeld = holds.reduce((s, h) => s + h.amount, 0);
    db.prepare(
      "UPDATE cards SET frozen_times = frozen_times - ?, remaining_times = remaining_times - ? WHERE id = ?",
    ).run(timesHeld, timesHeld, card.id);
    for (const hold of holds) {
      settleHold(db, hold, "consumed", now);
      insertTxn(db, card.id, bookingId, "consume", "times", "court", hold.amount, null, "核销扣次", now);
    }
    if (lightFeeCents > 0) {
      db.prepare(
        "INSERT INTO revenue_entries (booking_id, category, amount_cents, source, created_at) VALUES (?, 'light', ?, 'cash', ?)",
      ).run(bookingId, lightFeeCents, now);
    }
    return { cardKind: "package", timesCharged: timesHeld, cashChargedCents: 0, lightCashCents: lightFeeCents };
  }

  // 储值卡
  const cashHeld = holds.reduce((s, h) => s + h.amount, 0);
  const actual = courtFeeCents + lightFeeCents;
  const charge = Math.min(cashHeld, actual);
  const refund = cashHeld - charge;

  db.prepare(
    "UPDATE cards SET frozen_cents = frozen_cents - ?, balance_cents = balance_cents - ? WHERE id = ?",
  ).run(cashHeld, charge, card.id);
  for (const hold of holds) {
    settleHold(db, hold, "consumed", now);
  }
  const fresh = getCard(db, card.id)!;
  insertTxn(db, card.id, bookingId, "consume", "cash", "court", charge, usableBalance(fresh), `核销扣款（场租 ${courtFeeCents} + 灯光 ${lightFeeCents}${refund ? "，差额释放 " + refund : ""}）`, now);
  if (refund > 0) {
    insertTxn(db, card.id, bookingId, "release", "cash", "court", refund, usableBalance(fresh), "实计少于冻结，差额释放", now);
  }
  if (courtFeeCents > 0) {
    db.prepare(
      "INSERT INTO revenue_entries (booking_id, category, amount_cents, source, created_at) VALUES (?, 'court', ?, 'stored_card', ?)",
    ).run(bookingId, courtFeeCents, now);
  }
  if (lightFeeCents > 0) {
    db.prepare(
      "INSERT INTO revenue_entries (booking_id, category, amount_cents, source, created_at) VALUES (?, 'light', ?, 'stored_card', ?)",
    ).run(bookingId, lightFeeCents, now);
  }
  return { cardKind: "stored_value", timesCharged: 0, cashChargedCents: charge, lightCashCents: 0 };
}

/**
 * 爽约 / 开始前 2h 内取消：不退冻结。
 * 次卡扣次数；储值卡扣冻结金额（按违约金性质，计入场馆收入）。
 */
export function forfeit(db: DB, bookingId: number, note: string): { times: number; cents: number } {
  const now = nowLocal().toISOString();
  let times = 0;
  let cents = 0;
  for (const hold of heldHolds(db, bookingId)) {
    const card = getCard(db, hold.card_id)!;
    settleHold(db, hold, "forfeited", now);
    if (hold.resource === "times") {
      db.prepare(
        "UPDATE cards SET frozen_times = frozen_times - ?, remaining_times = remaining_times - ? WHERE id = ?",
      ).run(hold.amount, hold.amount, card.id);
      insertTxn(db, card.id, bookingId, "consume", "times", "forfeit", hold.amount, null, note, now);
      times += hold.amount;
    } else {
      db.prepare(
        "UPDATE cards SET frozen_cents = frozen_cents - ?, balance_cents = balance_cents - ? WHERE id = ?",
      ).run(hold.amount, hold.amount, card.id);
      const fresh = getCard(db, card.id)!;
      insertTxn(db, card.id, bookingId, "consume", "cash", "forfeit", hold.amount, usableBalance(fresh), note, now);
      db.prepare(
        "INSERT INTO revenue_entries (booking_id, category, amount_cents, source, created_at) VALUES (?, 'court', ?, 'stored_card', ?)",
      ).run(bookingId, hold.amount, now);
      cents += hold.amount;
    }
  }
  return { times, cents };
}

export function listCardTxns(db: DB, cardId: number): Array<{
  id: number;
  card_id: number;
  booking_id: number | null;
  type: "freeze" | "release" | "consume";
  resource: "times" | "cash";
  category: "court" | "light" | "forfeit";
  amount: number;
  balance_after: number | null;
  note: string | null;
  created_at: string;
}> {
  return db
    .prepare("SELECT * FROM card_txns WHERE card_id = ? ORDER BY id")
    .all(cardId) as Array<{
      id: number;
      card_id: number;
      booking_id: number | null;
      type: "freeze" | "release" | "consume";
      resource: "times" | "cash";
      category: "court" | "light" | "forfeit";
      amount: number;
      balance_after: number | null;
      note: string | null;
      created_at: string;
    }>;
}
