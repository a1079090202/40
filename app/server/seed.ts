import { createCourse, type CreateCourseInput } from "./courses";
import { createBooking, checkIn, cancelBooking } from "./bookings";
import { issueCard } from "./wallet";
import type { DB } from "./db";

/**
 * 样例数据（基准「现在」= 2026-09-15 12:00 本地）：
 * 6 块场地、3 教练、4 班课（含跨中秋/国庆的）、10 会员三类卡、两周日历。
 * 幂等：先清业务表。
 */
export function seed(db: DB, now = new Date(2026, 8, 15, 12, 0, 0)): void {
  db.pragma("foreign_keys = OFF");
  const tables = [
    "revenue_entries", "card_holds", "card_txns", "violations",
    "bookings", "course_leaves", "course_sessions", "courses",
    "cards", "members", "coaches", "holidays", "courts",
  ];
  for (const t of tables) db.prepare(`DELETE FROM ${t}`).run();
  db.pragma("foreign_keys = ON");

  // ---- 场地：4 羽毛球 + 2 篮球半场 ----
  const insCourt = db.prepare("INSERT INTO courts (id, name, type, sort_order) VALUES (?, ?, ?, ?)");
  [
    [1, "羽毛球一号场", "badminton", 1],
    [2, "羽毛球二号场", "badminton", 2],
    [3, "羽毛球三号场", "badminton", 3],
    [4, "羽毛球四号场", "badminton", 4],
    [5, "篮球半场·东", "basketball", 5],
    [6, "篮球半场·西", "basketball", 6],
  ].forEach((r) => insCourt.run(...r));

  // ---- 教练 ----
  const insCoach = db.prepare("INSERT INTO coaches (id, name, phone) VALUES (?, ?, ?)");
  [
    [1, "陈静", "13800000001"],
    [2, "李涛", "13800000002"],
    [3, "王芳", "13800000003"],
  ].forEach((r) => insCoach.run(...r));

  // ---- 法定节假日（落在两周以后、仍在班课周期内）----
  db.prepare("INSERT INTO holidays (date, name) VALUES (?, ?)").run("2026-09-25", "中秋节");
  db.prepare("INSERT INTO holidays (date, name) VALUES (?, ?)").run("2026-10-01", "国庆节");

  // ---- 班课 4 个 ----
  const courses: CreateCourseInput[] = [
    // 周二晚 19-21 一号羽毛球，12 周，顺延
    {
      name: "成人羽毛球提高班", coachId: 1, courtId: 1, weekday: 2,
      startTime: "19:00", endTime: "21:00", startDate: "2026-09-15", weeks: 12,
      holidayPolicy: "postpone",
    },
    // 周四晚 19:30-21 东篮球半场，10 周，顺延；10/1 国庆撞期 → 顺延到 10/2
    {
      name: "青少年篮球班", coachId: 2, courtId: 5, weekday: 4,
      startTime: "19:30", endTime: "21:00", startDate: "2026-09-17", weeks: 10,
      holidayPolicy: "postpone",
    },
    // 周五 18-19:30 二号羽毛球，8 周，补课；9/25 中秋撞期 → 9/25 请假，周期后补课
    {
      name: "少儿羽毛球启蒙班", coachId: 3, courtId: 2, weekday: 5,
      startTime: "18:00", endTime: "19:30", startDate: "2026-09-18", weeks: 8,
      holidayPolicy: "makeup",
    },
    // 周三晚 20-22 三号羽毛球，6 周，顺延
    {
      name: "羽毛球双打班", coachId: 1, courtId: 3, weekday: 3,
      startTime: "20:00", endTime: "22:00", startDate: "2026-09-16", weeks: 6,
      holidayPolicy: "postpone",
    },
  ];
  for (const c of courses) createCourse(db, c);

  // ---- 会员 10 名 + 三类卡 ----
  const insMember = db.prepare("INSERT INTO members (id, name, phone, created_at) VALUES (?, ?, ?, ?)");
  const names = ["刘洋", "陈磊", "杨帆", "赵敏", "孙悦", "周琦", "吴迪", "郑爽", "冯鑫", "褚岩"];
  names.forEach((n, i) => insMember.run(i + 1, n, `139000000${String(i + 1).padStart(2, "0")}`, "2026-08-01T00:00:00.000Z"));

  const cardIds: Record<number, number> = {};
  const mkCard = (memberId: number, spec: Parameters<typeof issueCard>[1]) => {
    cardIds[memberId] = issueCard(db, spec);
  };
  // 羽毛球次卡 ×4
  mkCard(1, { memberId: 1, kind: "package", courtType: "badminton", times: 20 });
  mkCard(2, { memberId: 2, kind: "package", courtType: "badminton", times: 12 });
  mkCard(3, { memberId: 3, kind: "package", courtType: "badminton", times: 8 });
  mkCard(4, { memberId: 4, kind: "package", courtType: "badminton", times: 30 });
  // 篮球次卡 ×2
  mkCard(5, { memberId: 5, kind: "package", courtType: "basketball", times: 10 });
  mkCard(6, { memberId: 6, kind: "package", courtType: "basketball", times: 16 });
  // 储值卡 ×4（分）
  mkCard(7, { memberId: 7, kind: "stored_value", initialCents: 50000 });
  mkCard(8, { memberId: 8, kind: "stored_value", initialCents: 30000 });
  mkCard(9, { memberId: 9, kind: "stored_value", initialCents: 10000 });
  mkCard(10, { memberId: 10, kind: "stored_value", initialCents: 80000 });

  // ---- 散客预订：两周日历 ----
  const book = (memberId: number, courtId: number, s: string, e: string, at: Date = now) =>
    createBooking(db, { memberId, cardId: cardIds[memberId]!, courtId, startSlot: s, endSlot: e, now: at });

  book(1, 4, "2026-09-16 19:00", "2026-09-16 20:30");
  book(2, 2, "2026-09-16 20:00", "2026-09-16 21:00");
  book(7, 4, "2026-09-17 19:30", "2026-09-17 21:00");
  book(8, 1, "2026-09-18 18:00", "2026-09-18 19:00");
  book(3, 3, "2026-09-19 10:00", "2026-09-19 11:30");
  book(5, 6, "2026-09-19 15:00", "2026-09-19 16:30");
  book(9, 4, "2026-09-21 19:00", "2026-09-21 20:00");
  book(4, 2, "2026-09-22 19:00", "2026-09-22 20:00");
  book(10, 5, "2026-09-23 19:00", "2026-09-23 20:30");
  book(2, 1, "2026-09-24 18:00", "2026-09-24 19:00");

  // 一单已核销（当天上午，9/15 10:00 场，10:05 核销）：让本月报表有消费数据
  const pastId = book(3, 4, "2026-09-15 10:00", "2026-09-15 11:00", new Date(2026, 8, 14, 9, 0));
  checkIn(db, pastId, new Date(2026, 8, 15, 10, 5));

  // 一单提前取消：演示冻结释放
  const cancelId = book(7, 4, "2026-09-16 10:00", "2026-09-16 11:00");
  cancelBooking(db, cancelId, now);
}
