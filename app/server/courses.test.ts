import { describe, expect, it } from "vitest";
import { addHoliday } from "~/server/catalog";
import { createBooking, getBooking } from "~/server/bookings";
import {
  CourseError,
  createCourse,
  expandSessions,
  listCourseSessions,
  reexpandAll,
  setCourseLeave,
  type CreateCourseInput,
} from "~/server/courses";
import { findConflicts } from "~/server/availability";
import { setupWorld } from "./test-utils";

// 周五晚 18:00-19:30，8 周，2026-09-18 起；9/25 是中秋
const FRIDAY_COURSE: CreateCourseInput = {
  name: "少儿启蒙班",
  coachId: 1,
  courtId: 2,
  weekday: 5,
  startTime: "18:00",
  endTime: "19:30",
  startDate: "2026-09-18",
  weeks: 8,
  holidayPolicy: "makeup",
};

describe("班课周期占场展开（expandSessions）", () => {
  it("按周展开 N 节，日期严格相隔 7 天", () => {
    const sessions = expandSessions({ ...FRIDAY_COURSE, holidayPolicy: "postpone" }, new Set(), new Set());
    expect(sessions).toHaveLength(8);
    expect(sessions.map((s) => s.date)).toEqual([
      "2026-09-18", "2026-09-25", "2026-10-02", "2026-10-09",
      "2026-10-16", "2026-10-23", "2026-10-30", "2026-11-06",
    ]);
    expect(sessions.every((s) => s.state === "scheduled")).toBe(true);
  });

  it("起始日与星期不一致直接拒绝", () => {
    expect(() => expandSessions({ ...FRIDAY_COURSE, startDate: "2026-09-19" }, new Set(), new Set())).toThrow(CourseError);
  });

  it("顺延策略：撞法定节假日的一节顺延到之后第一个非节假日，节假日当天不占场", () => {
    const holidays = new Set(["2026-09-25"]);
    const sessions = expandSessions({ ...FRIDAY_COURSE, holidayPolicy: "postpone" }, holidays, new Set());
    expect(sessions).toHaveLength(8);
    expect(sessions.find((s) => s.date === "2026-09-25")).toBeUndefined();
    const moved = sessions.find((s) => s.seq === 2)!;
    expect(moved.date).toBe("2026-09-26");
    expect(moved.origDate).toBe("2026-09-25");
    // 后续节次照常
    expect(sessions.find((s) => s.seq === 3)!.date).toBe("2026-10-02");
  });

  it("补课策略：名义日置 leave 不占场，周期结束后同星期追加 makeup", () => {
    const holidays = new Set(["2026-09-25"]);
    const sessions = expandSessions({ ...FRIDAY_COURSE, holidayPolicy: "makeup" }, holidays, new Set());
    expect(sessions).toHaveLength(9); // 8 节名义 + 1 节补课
    const leave = sessions.find((s) => s.seq === 2 && s.state === "leave")!;
    expect(leave.date).toBe("2026-09-25");
    const makeup = sessions.find((s) => s.state === "makeup")!;
    expect(makeup.date).toBe("2026-11-13"); // 周期 11/06 结束后的第一个周五
    expect(makeup.origDate).toBe("2026-09-25");
  });

  it("连续两周撞节假日时，各自顺延到名义日的下一空档，互不重叠", () => {
    const holidays = new Set(["2026-09-25", "2026-10-02"]);
    const sessions = expandSessions({ ...FRIDAY_COURSE, holidayPolicy: "postpone" }, holidays, new Set());
    const dates = sessions.filter((s) => s.state === "scheduled").map((s) => s.date);
    expect(new Set(dates).size).toBe(dates.length); // 无重复日期
    expect(sessions.find((s) => s.seq === 2)!.date).toBe("2026-09-26"); // 9/25 周五 → 9/26 周六
    expect(sessions.find((s) => s.seq === 3)!.date).toBe("2026-10-03"); // 10/2 周五 → 10/3 周六
  });

  it("整段请假：手动请假日同样按策略顺延，撤销后恢复", () => {
    const { db } = setupWorld();
    const courseId = createCourse(db, { ...FRIDAY_COURSE, holidayPolicy: "postpone" });
    setCourseLeave(db, courseId, "2026-10-02", true);
    const after = listCourseSessions(db, courseId) as Array<{ seq: number; date: string; state: string }>;
    expect(after.find((s) => s.date === "2026-10-02")).toBeUndefined();
    expect(after.find((s) => s.seq === 3)!.date).toBe("2026-10-03");
    setCourseLeave(db, courseId, "2026-10-02", false);
    const restored = listCourseSessions(db, courseId) as Array<{ seq: number; date: string }>;
    expect(restored.find((s) => s.seq === 3)!.date).toBe("2026-10-02");
  });
});

describe("建班批量占场与节假日重排", () => {
  it("createCourse 落场次并真正占用场地，重叠班课被拒", () => {
    const { db } = setupWorld();
    const id = createCourse(db, { ...FRIDAY_COURSE, holidayPolicy: "postpone" });
    const list = listCourseSessions(db, id);
    expect(list).toHaveLength(8);
    expect(findConflicts(db, 2, "2026-09-18 18:00", "2026-09-18 19:30")).toHaveLength(1);
    expect(
      () =>
        createCourse(db, {
          ...FRIDAY_COURSE,
          name: "另一个撞场班",
          startDate: "2026-09-18",
        }),
    ).toThrow(CourseError);
  });

  it("节假日表新增后 reexpandAll：顺延班课挪日、补课班课加补课，按各自配置走", () => {
    const { db } = setupWorld();
    const postponeId = createCourse(db, { ...FRIDAY_COURSE, courtId: 2, holidayPolicy: "postpone" });
    const makeupId = createCourse(db, {
      ...FRIDAY_COURSE, name: "另一个周五班", courtId: 3, holidayPolicy: "makeup",
    });
    addHoliday(db, "2026-09-25", "中秋节");
    reexpandAll(db);

    const p = listCourseSessions(db, postponeId) as Array<{ seq: number; date: string; state: string }>;
    expect(p.find((s) => s.seq === 2)!.date).toBe("2026-09-26");
    expect(p.every((s) => s.state !== "leave")).toBe(true);

    const m = listCourseSessions(db, makeupId) as Array<{ seq: number; date: string; state: string }>;
    expect(m.find((s) => s.seq === 2 && s.state === "leave")!.date).toBe("2026-09-25");
    expect(m.find((s) => s.state === "makeup")!.date).toBe("2026-11-13");
  });
});

describe("重排冲突校验：班课重排不得压散客已订时段", () => {
  it("顺延目标日已被散客订下：登记整段请假必拦，且请假/排期/散客单全部原样", () => {
    const { db, now, cards } = setupWorld();
    const courseId = createCourse(db, { ...FRIDAY_COURSE, holidayPolicy: "postpone" });
    // 散客先订下第 2 节（9/25）的顺延目标日 9/26 同时段
    const bookingId = createBooking(db, {
      memberId: 1, cardId: cards.badminton, courtId: 2,
      startSlot: "2026-09-26 18:00", endSlot: "2026-09-26 19:30", now,
    });

    let err: unknown;
    try {
      setCourseLeave(db, courseId, "2026-09-25", true);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CourseError);
    expect((err as Error).message).toContain("2026-09-26");
    expect((err as Error).message).toContain("散客");

    // 事务整体回滚：请假没登记上，场次保持原排期，散客单不受影响
    expect(
      db.prepare("SELECT count(*) n FROM course_leaves WHERE course_id = ?").get(courseId),
    ).toMatchObject({ n: 0 });
    const sessions = listCourseSessions(db, courseId) as Array<{ seq: number; date: string }>;
    expect(sessions.find((s) => s.seq === 2)!.date).toBe("2026-09-25");
    expect(getBooking(db, bookingId)!.status).toBe("held");
  });

  it("节假日触发 reexpandAll 时撞散客单同样必拦，全班课排期不变", () => {
    const { db, now, cards } = setupWorld();
    const courseId = createCourse(db, { ...FRIDAY_COURSE, holidayPolicy: "postpone" });
    createBooking(db, {
      memberId: 1, cardId: cards.badminton, courtId: 2,
      startSlot: "2026-09-26 18:00", endSlot: "2026-09-26 19:30", now,
    });

    addHoliday(db, "2026-09-25", "中秋节");
    expect(() => reexpandAll(db)).toThrow(CourseError);
    const sessions = listCourseSessions(db, courseId) as Array<{ seq: number; date: string }>;
    expect(sessions.find((s) => s.seq === 2)!.date).toBe("2026-09-25");
  });

  it("撤销请假恢复名义日期时，撞上请假期间被散客订走的时段也必拦", () => {
    const { db, now, cards } = setupWorld();
    const courseId = createCourse(db, { ...FRIDAY_COURSE, holidayPolicy: "postpone" });
    setCourseLeave(db, courseId, "2026-09-25", true); // 第 2 节顺延到 9/26，名义日 9/25 空出
    createBooking(db, {
      memberId: 1, cardId: cards.badminton, courtId: 2,
      startSlot: "2026-09-25 18:00", endSlot: "2026-09-25 19:30", now,
    });

    expect(() => setCourseLeave(db, courseId, "2026-09-25", false)).toThrow(CourseError);
    // 回滚后仍是请假顺延状态
    const sessions = listCourseSessions(db, courseId) as Array<{ seq: number; date: string }>;
    expect(sessions.find((s) => s.seq === 2)!.date).toBe("2026-09-26");
  });
});
