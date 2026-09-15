import type { DB } from "./db";
import { OPEN_FROM, OPEN_TO } from "./config";
import { addDays, fmtDate, parseDate, slotKey, slotSpan } from "./time";

/** 'YYYY-MM' 的首日/次月首日 */
function monthBounds(ym: string): { first: string; after: string; days: number } {
  const [y, m] = ym.split("-").map(Number);
  const first = `${ym}-01`;
  const d = new Date(y!, m! - 1, 1);
  const afterDate = new Date(y!, m!, 1);
  return { first, after: fmtDate(afterDate), days: new Date(y!, m!, 0).getDate() };
}

export function monthDates(ym: string): string[] {
  const { first, days } = monthBounds(ym);
  return Array.from({ length: days }, (_, i) => addDays(first, i));
}

// ---------- 报表一：教练班课占用表 ----------

export interface CoachCourseRow {
  coachName: string;
  courseName: string;
  courtName: string;
  courtType: string;
  sessionsHeld: number;   // 当月实际上课节数（含补课）
  makeupCount: number;
  leaveCount: number;     // 当月落在节假日/请假未上的节数
  slotsUsed: number;      // 占用半小时格数
  dates: string[];
}

export function coachCourseReport(db: DB, ym: string): CoachCourseRow[] {
  const { first, after } = monthBounds(ym);
  const rows = db
    .prepare(
      `SELECT co.name AS coach_name, c.name AS course_name, cu.name AS court_name, cu.type AS court_type,
              cs.state AS state, cs.date AS date, cs.start_time AS st, cs.end_time AS et
         FROM course_sessions cs
         JOIN courses c ON c.id = cs.course_id
         JOIN coaches co ON co.id = c.coach_id
         JOIN courts cu ON cu.id = cs.court_id
        WHERE cs.date >= ? AND cs.date < ?
        ORDER BY co.id, c.id, cs.date`,
    )
    .all(first, after) as Array<{
      coach_name: string; course_name: string; court_name: string; court_type: string;
      state: string; date: string; st: string; et: string;
    }>;

  const map = new Map<string, CoachCourseRow>();
  for (const r of rows) {
    const key = `${r.coach_name}|${r.course_name}`;
    let row = map.get(key);
    if (!row) {
      row = {
        coachName: r.coach_name,
        courseName: r.course_name,
        courtName: r.court_name,
        courtType: r.court_type,
        sessionsHeld: 0,
        makeupCount: 0,
        leaveCount: 0,
        slotsUsed: 0,
        dates: [],
      };
      map.set(key, row);
    }
    if (r.state === "leave") {
      row.leaveCount += 1;
      continue;
    }
    row.sessionsHeld += 1;
    if (r.state === "makeup") row.makeupCount += 1;
    row.slotsUsed += slotSpan(slotKey(r.date, r.st), slotKey(r.date, r.et));
    row.dates.push(`${r.date}${r.state === "makeup" ? "(补)" : ""}`);
  }
  return [...map.values()];
}

// ---------- 报表二：场地利用率表 ----------

export interface CourtUtilRow {
  courtName: string;
  courtType: string;
  openSlots: number;
  courseSlots: number;
  bookingSlots: number; // 已核销散客
  noShowSlots: number;  // 爽约未实际使用
  usedSlots: number;
  utilization: number;  // 0~1
}

export function courtUtilizationReport(db: DB, ym: string): CourtUtilRow[] {
  const { first, after, days } = monthBounds(ym);
  const openSlotsPerDay = slotSpan(`${first} ${OPEN_FROM}`, `${first} ${OPEN_TO}`);

  const courses = db
    .prepare(
      `SELECT cs.court_id AS court_id,
              sum((CAST(substr(cs.end_time,1,2) AS INTEGER)*60 + CAST(substr(cs.end_time,4,2) AS INTEGER)
                 - (CAST(substr(cs.start_time,1,2) AS INTEGER)*60 + CAST(substr(cs.start_time,4,2) AS INTEGER)))/30) AS slots
         FROM course_sessions cs
        WHERE cs.date >= ? AND cs.date < ? AND cs.state != 'leave'
        GROUP BY cs.court_id`,
    )
    .all(first, after) as Array<{ court_id: number; slots: number | null }>;
  const courseMap = new Map(courses.map((r) => [r.court_id, r.slots ?? 0]));

  const bookings = db
    .prepare(
      `SELECT court_id AS court_id, status AS status, sum(slot_count) AS slots
         FROM bookings
        WHERE start_slot >= ? AND start_slot < ?
        GROUP BY court_id, status`,
    )
    .all(`${first} 00:00`, `${after} 00:00`) as Array<{ court_id: number; status: string; slots: number | null }>;

  const courts = db.prepare("SELECT * FROM courts ORDER BY sort_order, id").all() as Array<{
    id: number; name: string; type: string;
  }>;

  return courts.map((c) => {
    let checkedIn = 0;
    let noShow = 0;
    for (const b of bookings) {
      if (b.court_id !== c.id) continue;
      if (b.status === "checked_in") checkedIn += b.slots ?? 0;
      if (b.status === "no_show") noShow += b.slots ?? 0;
    }
    const courseSlots = courseMap.get(c.id) ?? 0;
    const used = courseSlots + checkedIn;
    const openSlots = openSlotsPerDay * days;
    return {
      courtName: c.name,
      courtType: c.type,
      openSlots,
      courseSlots,
      bookingSlots: checkedIn,
      noShowSlots: noShow,
      usedSlots: used,
      utilization: openSlots === 0 ? 0 : used / openSlots,
    };
  });
}

// ---------- 报表三：会员消费与违约表 ----------

export interface MemberConsumptionRow {
  memberId: number;
  memberName: string;
  packageTimesCharged: number; // 核销扣次
  packageTimesForfeited: number; // 爽约/迟到取消扣次
  storedSpentCents: number;    // 核销储值消费（场租+灯光）
  storedForfeitedCents: number; // 爽约扣的储值
  lightCashCents: number;      // 次卡现收灯光
  violations: number;          // 当月违约次数
  banned: boolean;
  banUntil?: string;
}

export function memberConsumptionReport(db: DB, ym: string): MemberConsumptionRow[] {
  const { first, after } = monthBounds(ym);

  const cardAgg = db
    .prepare(
      `SELECT m.id AS member_id, m.name AS member_name,
              sum(CASE WHEN t.resource='times' AND t.category='court'   THEN t.amount ELSE 0 END) AS times_charged,
              sum(CASE WHEN t.resource='times' AND t.category='forfeit' THEN t.amount ELSE 0 END) AS times_forfeit,
              sum(CASE WHEN t.resource='cash'  AND t.category='court'   THEN t.amount ELSE 0 END) AS cash_spent,
              sum(CASE WHEN t.resource='cash'  AND t.category='forfeit' THEN t.amount ELSE 0 END) AS cash_forfeit
         FROM members m
         LEFT JOIN cards cd ON cd.member_id = m.id
         LEFT JOIN card_txns t ON t.card_id = cd.id
              AND t.type = 'consume' AND t.created_at >= ? AND t.created_at < ?
        GROUP BY m.id
        ORDER BY m.id`,
    )
    .all(first, after) as Array<{
      member_id: number; member_name: string;
      times_charged: number | null; times_forfeit: number | null;
      cash_spent: number | null; cash_forfeit: number | null;
    }>;

  // 次卡核销的灯光费走 revenue_entries 现收
  const lightAgg = db
    .prepare(
      `SELECT b.member_id AS member_id, sum(r.amount_cents) AS cents
         FROM revenue_entries r JOIN bookings b ON b.id = r.booking_id
        WHERE r.category = 'light' AND r.source = 'cash'
          AND r.created_at >= ? AND r.created_at < ?
        GROUP BY b.member_id`,
    )
    .all(first, after) as Array<{ member_id: number; cents: number | null }>;
  const lightMap = new Map(lightAgg.map((r) => [r.member_id, r.cents ?? 0]));

  const vioAgg = db
    .prepare(
      `SELECT member_id AS member_id, count(*) AS n
         FROM violations WHERE date >= ? AND date < ? GROUP BY member_id`,
    )
    .all(first, after) as Array<{ member_id: number; n: number }>;
  const vioMap = new Map(vioAgg.map((r) => [r.member_id, r.n]));

  // 统计口径用自然月，但限订状态按“今天”算
  const today = fmtDate(new Date());

  return cardAgg.map((r) => {
    const violations = vioMap.get(r.member_id) ?? 0;
    let banned = false;
    let banUntil: string | undefined;
    if (violations > 0) {
      const third = db
        .prepare(
          "SELECT date FROM violations WHERE member_id = ? AND substr(date,1,7) = ? ORDER BY date, id LIMIT 1 OFFSET 2",
        )
        .get(r.member_id, ym) as { date: string } | undefined;
      if (third) {
        banUntil = addDays(third.date, 7);
        banned = today < banUntil;
      }
    }
    return {
      memberId: r.member_id,
      memberName: r.member_name,
      packageTimesCharged: r.times_charged ?? 0,
      packageTimesForfeited: r.times_forfeit ?? 0,
      storedSpentCents: r.cash_spent ?? 0,
      storedForfeitedCents: r.cash_forfeit ?? 0,
      lightCashCents: lightMap.get(r.member_id) ?? 0,
      violations,
      banned,
      banUntil,
    };
  });
}

/** 当月场馆收入合计（灯光+场租，含储值与现收） */
export function revenueTotal(db: DB, ym: string): { courtCents: number; lightCents: number } {
  const { first, after } = monthBounds(ym);
  const row = db
    .prepare(
      `SELECT sum(CASE WHEN category='court' THEN amount_cents ELSE 0 END) AS court_cents,
              sum(CASE WHEN category='light' THEN amount_cents ELSE 0 END) AS light_cents
         FROM revenue_entries
        WHERE created_at >= ? AND created_at < ?`,
    )
    .get(first, after) as { court_cents: number | null; light_cents: number | null };
  return { courtCents: row.court_cents ?? 0, lightCents: row.light_cents ?? 0 };
}

export { parseDate };
