import type { DB } from "./db";
import { addSlots, dateOf, overlaps, slotSequence } from "./time";

export interface Occupancy {
  kind: "course" | "booking";
  id: number;
  courseSessionId?: number;
  courtId: number;
  startSlot: string;
  endSlot: string;
  label: string;
  status?: string; // 散客单状态
  sessionState?: "scheduled" | "leave" | "makeup";
}

export type Conflict = Occupancy;

const ACTIVE_BOOKING = "status IN ('held','checked_in')";

/**
 * 某场地某日的全部有效占用：班课（scheduled/makeup）+ 散客有效单。
 * leave 状态的班课不占场。
 */
export function occupancyOnCourtDate(db: DB, courtId: number, date: string): Occupancy[] {
  const sessions = db
    .prepare(
      `SELECT cs.id AS sid, cs.court_id AS court_id, cs.date AS date,
              cs.start_time AS st, cs.end_time AS et, c.name AS cname, cs.state AS state
         FROM course_sessions cs JOIN courses c ON c.id = cs.course_id
        WHERE cs.court_id = ? AND cs.date = ? AND cs.state != 'leave' AND c.active = 1`,
    )
    .all(courtId, date) as Array<{
      sid: number; court_id: number; date: string; st: string; et: string; cname: string;
      state: "scheduled" | "makeup";
    }>;

  const bookings = db
    .prepare(
      `SELECT b.id AS bid, b.court_id AS court_id, b.start_slot AS s, b.end_slot AS e,
              m.name AS mname, b.status AS status
         FROM bookings b JOIN members m ON m.id = b.member_id
        WHERE b.court_id = ? AND substr(b.start_slot,1,10) = ? AND ${ACTIVE_BOOKING}`,
    )
    .all(courtId, date) as Array<{
      bid: number; court_id: number; s: string; e: string; mname: string; status: string;
    }>;

  return [
    ...sessions.map((s) => ({
      kind: "course" as const,
      id: s.sid,
      courseSessionId: s.sid,
      courtId: s.court_id,
      startSlot: `${s.date} ${s.st}`,
      endSlot: `${s.date} ${s.et}`,
      label: `班课：${s.cname}`,
      sessionState: s.state,
    })),
    ...bookings.map((b) => ({
      kind: "booking" as const,
      id: b.bid,
      courtId: b.court_id,
      startSlot: b.s,
      endSlot: b.e,
      label: `散客：${b.mname}`,
      status: b.status,
    })),
  ];
}

/** 冲突检测：给定场地时段，返回重叠占用 */
export function findConflicts(
  db: DB,
  courtId: number,
  startSlot: string,
  endSlot: string,
  opts: { excludeBookingId?: number } = {},
): Conflict[] {
  const date = dateOf(startSlot);
  return occupancyOnCourtDate(db, courtId, date).filter(
    (o) =>
      overlaps(startSlot, endSlot, o.startSlot, o.endSlot) &&
      !(opts.excludeBookingId != null && o.kind === "booking" && o.id === opts.excludeBookingId),
  );
}

/** 某场地某日开放时段内各半小时格是否空闲，返回空闲格起点 */
export function freeSlotsOnCourtDate(
  db: DB,
  courtId: number,
  date: string,
  openFrom: string,
  openTo: string,
): string[] {
  const all = slotSequence(`${date} ${openFrom}`, `${date} ${openTo}`);
  const occ = occupancyOnCourtDate(db, courtId, date);
  return all.filter((slot) => {
    const slotEnd = addSlots(slot, 1);
    return !occ.some((o) => overlaps(slot, slotEnd, o.startSlot, o.endSlot));
  });
}
