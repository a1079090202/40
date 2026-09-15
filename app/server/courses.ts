import type { DB } from "./db";
import { findConflicts } from "./availability";
import { OPEN_FROM, OPEN_TO } from "./config";
import {
  addDays,
  assertSlot,
  fmtDate,
  nowLocal,
  parseDate,
  slotKey,
} from "./time";

export type HolidayPolicy = "postpone" | "makeup";

export interface CreateCourseInput {
  name: string;
  coachId: number;
  courtId: number;
  weekday: number; // 0=周日 … 6=周六
  startTime: string; // 'HH:MM'
  endTime: string;
  startDate: string; // 'YYYY-MM-DD'
  weeks: number;
  holidayPolicy: HolidayPolicy;
}

export interface SessionSpec {
  seq: number; // 对应第几节名义课（1..weeks）
  courtId: number;
  date: string;
  startTime: string;
  endTime: string;
  state: "scheduled" | "leave" | "makeup";
  origDate?: string; // 被节假日/请假冲掉的名义日期
  note?: string;
}

export class CourseError extends Error {}

function loadHolidaySet(db: DB): Set<string> {
  return new Set(
    (db.prepare("SELECT date FROM holidays").all() as Array<{ date: string }>).map((r) => r.date),
  );
}

function loadLeaveSet(db: DB, courseId: number): Set<string> {
  return new Set(
    (
      db.prepare("SELECT date FROM course_leaves WHERE course_id = ?").all(courseId) as Array<{
        date: string;
      }>
    ).map((r) => r.date),
  );
}

/** 名义上第 i 周（0 基）的上课日 */
export function nominalDate(startDate: string, weekIndex: number): string {
  const d = parseDate(startDate);
  d.setDate(d.getDate() + weekIndex * 7);
  return fmtDate(d);
}

/**
 * 把一个周期班课展开成具体场次。
 *
 * 命中节假日或手动请假的名义场次：
 * - postpone（顺延）：顺延到之后第一个既不是节假日也没有请假的日期，场次仍记 scheduled，
 *   origDate 记录原日期。
 * - makeup（补课）：名义日期置 leave 不占场，并在整个周期结束后的同星期追加一节 makeup。
 */
export function expandSessions(
  input: CreateCourseInput,
  holidays: Set<string>,
  leaves: Set<string>,
): SessionSpec[] {
  validateTimeWindow(input.startTime, input.endTime);
  if (!Number.isInteger(input.weeks) || input.weeks <= 0) {
    throw new CourseError("周数必须为正整数");
  }
  const first = parseDate(input.startDate);
  if (first.getDay() !== input.weekday) {
    throw new CourseError(`起始日 ${input.startDate} 不是星期 ${input.weekday}`);
  }

  const out: SessionSpec[] = [];
  const usedDates = new Set<string>();

  // 节假日、请假、以及前序顺延已占用的日期，都不能再排
  const blocked = (date: string): boolean =>
    holidays.has(date) || leaves.has(date) || usedDates.has(date);

  for (let i = 0; i < input.weeks; i++) {
    const seq = i + 1;
    const nominal = nominalDate(input.startDate, i);
    if (!blocked(nominal)) {
      out.push({
        seq,
        courtId: input.courtId,
        date: nominal,
        startTime: input.startTime,
        endTime: input.endTime,
        state: "scheduled",
      });
      usedDates.add(nominal);
      continue;
    }

    const reason = holidays.has(nominal) ? "法定节假日" : leaves.has(nominal) ? "整段请假" : "顺延占用";

    if (input.holidayPolicy === "postpone") {
      // 逐日向后找第一个空档，必要时可越过周期结束日
      let d = addDays(nominal, 1);
      while (blocked(d)) d = addDays(d, 1);
      out.push({
        seq,
        courtId: input.courtId,
        date: d,
        startTime: input.startTime,
        endTime: input.endTime,
        state: "scheduled",
        origDate: nominal,
        note: `${reason}顺延`,
      });
      usedDates.add(d);
    } else {
      out.push({
        seq,
        courtId: input.courtId,
        date: nominal,
        startTime: input.startTime,
        endTime: input.endTime,
        state: "leave",
        origDate: nominal,
        note: `${reason}，安排补课`,
      });
      usedDates.add(nominal);
    }
  }

  if (input.holidayPolicy === "makeup") {
    const missed = out.filter((s) => s.state === "leave");
    // 补课排在整个周期结束之后的同星期，一节一周，撞节假日或另一节补课时再跳一周
    for (const m of missed) {
      let d = nominalDate(input.startDate, input.weeks);
      while (holidays.has(d) || usedDates.has(d)) d = addDays(d, 7);
      out.push({
        seq: m.seq,
        courtId: input.courtId,
        date: d,
        startTime: input.startTime,
        endTime: input.endTime,
        state: "makeup",
        origDate: m.date,
        note: `补课（原 ${m.date}）`,
      });
      usedDates.add(d);
    }
  }

  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.startTime.localeCompare(b.startTime)));
}

function validateTimeWindow(startTime: string, endTime: string): void {
  assertSlot(`2000-01-01 ${startTime}`);
  assertSlot(`2000-01-01 ${endTime}`);
  if (!(startTime >= OPEN_FROM && endTime <= OPEN_TO && startTime < endTime)) {
    throw new CourseError(`上课时段必须落在 ${OPEN_FROM}–${OPEN_TO} 内`);
  }
}

function insertSessions(db: DB, courseId: number, sessions: SessionSpec[]): void {
  const stmt = db.prepare(
    `INSERT INTO course_sessions (course_id, seq, court_id, date, start_time, end_time, state, orig_date, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const s of sessions) {
    stmt.run(
      courseId,
      s.seq,
      s.courtId,
      s.date,
      s.startTime,
      s.endTime,
      s.state,
      s.origDate ?? null,
      s.note ?? null,
    );
  }
}

/** 建周期班课：展开、与现有班课/散客单做冲突校验、批量落场。整事务。 */
export function createCourse(db: DB, input: CreateCourseInput): number {
  const holidays = loadHolidaySet(db);
  const leaves = new Set<string>();
  const specs = expandSessions(input, holidays, leaves);

  const tx = db.transaction(() => {
    // 与既有用场冲突则拒绝（教练班课之间、班课与散客单都不许撞）
    for (const s of specs.filter((x) => x.state !== "leave")) {
      const conflicts = findConflicts(
        db,
        s.courtId,
        slotKey(s.date, s.startTime),
        slotKey(s.date, s.endTime),
      );
      if (conflicts.length > 0) {
        throw new CourseError(
          `${s.date} ${s.startTime}-${s.endTime} 与已有占用冲突：${conflicts[0]!.label}`,
        );
      }
    }

    const info = db
      .prepare(
        `INSERT INTO courses (name, coach_id, court_id, weekday, start_time, end_time, start_date, weeks, holiday_policy, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.name,
        input.coachId,
        input.courtId,
        input.weekday,
        input.startTime,
        input.endTime,
        input.startDate,
        input.weeks,
        input.holidayPolicy,
        nowLocal().toISOString(),
      );
    const courseId = Number(info.lastInsertRowid);
    insertSessions(db, courseId, specs);
    return courseId;
  });

  return tx();
}

/**
 * 登记 / 取消整段请假，随后按当前节假日与请假表重建整个班课的场次。
 * date 传「当前排课日期」：顺延场次会映射回它的名义日期登记。
 */
export function setCourseLeave(db: DB, courseId: number, date: string, on: boolean): void {
  const course = getCourse(db, courseId);
  if (!course) throw new CourseError("班课不存在");
  const tx = db.transaction(() => {
    let nominalDate = date;
    if (on) {
      const session = db
        .prepare("SELECT orig_date FROM course_sessions WHERE course_id = ? AND date = ? AND state != 'leave' LIMIT 1")
        .get(courseId, date) as { orig_date: string | null } | undefined;
      if (session?.orig_date) nominalDate = session.orig_date;
      db.prepare("INSERT OR IGNORE INTO course_leaves (course_id, date) VALUES (?, ?)").run(
        courseId,
        nominalDate,
      );
    } else {
      db.prepare("DELETE FROM course_leaves WHERE course_id = ? AND date = ?").run(courseId, date);
    }
    reexpand(db, course);
  });
  tx();
}

/** 节假日表变动后对全班课生效：重建所有班课场次。 */
export function reexpandAll(db: DB): void {
  const courses = db
    .prepare("SELECT * FROM courses WHERE active = 1 ORDER BY id")
    .all() as CourseRow[];
  const tx = db.transaction(() => {
    for (const c of courses) reexpand(db, c);
  });
  tx();
}

interface CourseRow {
  id: number;
  name: string;
  coach_id: number;
  court_id: number;
  weekday: number;
  start_time: string;
  end_time: string;
  start_date: string;
  weeks: number;
  holiday_policy: HolidayPolicy;
}

function reexpand(db: DB, c: CourseRow): void {
  const specs = expandSessions(
    {
      name: c.name,
      coachId: c.coach_id,
      courtId: c.court_id,
      weekday: c.weekday,
      startTime: c.start_time,
      endTime: c.end_time,
      startDate: c.start_date,
      weeks: c.weeks,
      holidayPolicy: c.holiday_policy,
    },
    loadHolidaySet(db),
    loadLeaveSet(db, c.id),
  );
  db.prepare("DELETE FROM course_sessions WHERE course_id = ?").run(c.id);
  insertSessions(db, c.id, specs);
}

export function getCourse(db: DB, courseId: number): (CourseRow & { coach_name: string; court_name: string }) | undefined {
  return db
    .prepare(
      `SELECT c.*, co.name AS coach_name, cu.name AS court_name
         FROM courses c JOIN coaches co ON co.id = c.coach_id
                        JOIN courts cu ON cu.id = c.court_id
        WHERE c.id = ?`,
    )
    .get(courseId) as (CourseRow & { coach_name: string; court_name: string }) | undefined;
}

export function listCourses(db: DB) {
  return db
    .prepare(
      `SELECT c.*, co.name AS coach_name, cu.name AS court_name
         FROM courses c JOIN coaches co ON co.id = c.coach_id
                        JOIN courts cu ON cu.id = c.court_id
        WHERE c.active = 1 ORDER BY c.id`,
    )
    .all();
}

export function listCourseSessions(db: DB, courseId: number) {
  return db
    .prepare("SELECT * FROM course_sessions WHERE course_id = ? ORDER BY date, start_time")
    .all(courseId);
}
