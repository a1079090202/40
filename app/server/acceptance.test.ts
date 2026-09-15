import { describe, expect, it } from "vitest";
import { findConflicts } from "~/server/availability";
import { addHoliday } from "~/server/catalog";
import { BookingError, checkIn, createBooking, getBooking, recommendAlternatives } from "~/server/bookings";
import { createCourse, listCourseSessions, reexpandAll } from "~/server/courses";
import {
  coachCourseReport,
  courtUtilizationReport,
  memberConsumptionReport,
  revenueTotal,
} from "~/server/reports";
import { issueCard, getCard } from "~/server/wallet";
import { sweepNoShows } from "~/server/violations";
import { addMember, cardOf, setupWorld } from "./test-utils";

const NOW = new Date(2026, 8, 15, 12, 0, 0);

/**
 * 验收五步端到端：
 * 1. 建周期班课看批量占场
 * 2. 跟班课同时段下散客单看拦截 + 替代
 * 3. 储值卡预订看冻结，再核销看扣减
 * 4. 开始后 30 分钟不核销看爽约扣次
 * 5. 法定节假日叠进班课周，顺延 / 补课按配置走
 */
describe("验收五步端到端", () => {
  it("第一步：周二晚 19-21 一号羽毛球 12 周 → 批量生成 12 场且占场", () => {
    const w = setupWorld(NOW);
    const id = createCourse(w.db, {
      name: "成人羽毛球提高班", coachId: 1, courtId: 1, weekday: 2,
      startTime: "19:00", endTime: "21:00", startDate: "2026-09-15", weeks: 12,
      holidayPolicy: "postpone",
    });
    const sessions = listCourseSessions(w.db, id) as Array<{ seq: number; date: string; state: string }>;
    expect(sessions).toHaveLength(12);
    expect(sessions[0]!.date).toBe("2026-09-15");
    expect(sessions[11]!.date).toBe("2026-12-01");
    // 一号场每个周二 19:00 都被占
    expect(
      w.db
        .prepare(
          "SELECT count(*) n FROM course_sessions WHERE course_id=? AND start_time='19:00' AND end_time='21:00' AND state!='leave'",
        )
        .get(id),
    ).toMatchObject({ n: 12 });
  });

  it("第二步：同时段散客单被拦，并给出最近可用替代场地/时段", () => {
    const w = setupWorld(NOW);
    createCourse(w.db, {
      name: "成人羽毛球提高班", coachId: 1, courtId: 1, weekday: 2,
      startTime: "19:00", endTime: "21:00", startDate: "2026-09-15", weeks: 12,
      holidayPolicy: "postpone",
    });
    let err: BookingError | undefined;
    try {
      createBooking(w.db, {
        memberId: 1, cardId: w.cards.badminton, courtId: 1,
        startSlot: "2026-09-22 19:00", endSlot: "2026-09-22 20:00", now: NOW,
      });
    } catch (e) {
      err = e as BookingError;
    }
    expect(err).toBeInstanceOf(BookingError);
    expect(err!.conflicts![0]!.label).toContain("成人羽毛球提高班");
    const alts = err!.alternatives!;
    expect(alts.length).toBeGreaterThan(0);
    // 首选是同日同时段的其他羽毛球场（二/三/四号场之一）
    expect(alts[0]!.tier).toBe(1);
    expect(alts[0]!.startSlot).toBe("2026-09-22 19:00");
    expect([2, 3, 4]).toContain(alts[0]!.courtId);

    // 替代推荐 API 独立调用一致
    const direct = recommendAlternatives(w.db, "badminton", "2026-09-22 19:00", "2026-09-22 20:00", 1, NOW);
    expect(direct[0]!.courtId).toBe(alts[0]!.courtId);
  });

  it("第三步：储值卡预订先冻结（余额不动），到场核销才真正扣减并入灯光费", () => {
    const w = setupWorld(NOW);
    // 晚场 19:00-20:00：场租 2×1500=3000 + 灯光 2×200=400 = 3400
    const id = createBooking(w.db, {
      memberId: 1, cardId: w.cards.cash, courtId: 1,
      startSlot: "2026-09-16 19:00", endSlot: "2026-09-16 20:00", now: NOW,
    });
    let card = getCard(w.db, w.cards.cash)!;
    expect(card.balance_cents).toBe(50000);       // 余额还没扣
    expect(card.frozen_cents).toBe(3400);        // 冻结 34 元
    expect(getBooking(w.db, id)!.status).toBe("held");

    const r = checkIn(w.db, id, new Date(2026, 8, 16, 19, 2));
    expect(r.cashChargedCents).toBe(3400);
    card = getCard(w.db, w.cards.cash)!;
    expect(card.balance_cents).toBe(46600);      // 核销后真正扣减
    expect(card.frozen_cents).toBe(0);
    expect(getBooking(w.db, id)!.status).toBe("checked_in");

    // 月底收入：场租 3000 + 灯光 400
    const rev = revenueTotal(w.db, "2026-09");
    expect(rev.courtCents).toBe(3000);
    expect(rev.lightCents).toBe(400);
  });

  it("第四步：开始后 30 分钟未核销 → 爽约，扣 1 单对应次数并记违约", () => {
    const w = setupWorld(NOW);
    // 9/16 10:00-11:00 白场，2 格次卡
    const id = createBooking(w.db, {
      memberId: 1, cardId: w.cards.badminton, courtId: 1,
      startSlot: "2026-09-16 10:00", endSlot: "2026-09-16 11:00", now: NOW,
    });
    expect(cardOf(w.db, w.cards.badminton).frozen_times).toBe(2);

    // 10:30 扫表：爽约
    const results = sweepNoShows(w.db, new Date(2026, 8, 16, 10, 30));
    expect(results).toHaveLength(1);
    expect(results[0]!.bookingId).toBe(id);
    expect(results[0]!.timesForfeited).toBe(2);
    const c = cardOf(w.db, w.cards.badminton);
    expect(c.remaining_times).toBe(18);
    expect(c.frozen_times).toBe(0);
    expect(getBooking(w.db, id)!.status).toBe("no_show");

    const vio = w.db
      .prepare("SELECT count(*) n FROM violations WHERE member_id=1 AND date='2026-09-16'")
      .get() as { n: number };
    expect(vio.n).toBe(1);
  });

  it("第五步：节假日叠进班课周——顺延班课挪到下一空档，补课班课置 leave 并在周期后补", () => {
    const w = setupWorld(NOW);
    // 顺延班：周五 19-21 一号场，6 周，9/18 起（9/25 中秋）
    const postponeId = createCourse(w.db, {
      name: "周五顺延班", coachId: 1, courtId: 1, weekday: 5,
      startTime: "19:00", endTime: "21:00", startDate: "2026-09-18", weeks: 6,
      holidayPolicy: "postpone",
    });
    // 补课班：周五 18-19:30 二号场，6 周
    const makeupId = createCourse(w.db, {
      name: "周五补课班", coachId: 1, courtId: 2, weekday: 5,
      startTime: "18:00", endTime: "19:30", startDate: "2026-09-18", weeks: 6,
      holidayPolicy: "makeup",
    });

    // 叠进法定节假日，触发与 /admin「加入并重排」相同的入口
    addHoliday(w.db, "2026-09-25", "中秋节");
    reexpandAll(w.db);

    const p = listCourseSessions(w.db, postponeId) as Array<{ seq: number; date: string; state: string; orig_date: string | null }>;
    expect(p.find((s) => s.date === "2026-09-25")).toBeUndefined();
    const moved = p.find((s) => s.seq === 2)!;
    expect(moved.date).toBe("2026-09-26");
    expect(moved.orig_date).toBe("2026-09-25");
    expect(p.filter((s) => s.state !== "leave")).toHaveLength(6);

    const m = listCourseSessions(w.db, makeupId) as Array<{ seq: number; date: string; state: string; orig_date: string | null }>;
    expect(m.find((s) => s.seq === 2 && s.state === "leave")!.date).toBe("2026-09-25");
    const makeup = m.find((s) => s.state === "makeup")!;
    expect(makeup.date).toBe("2026-10-30"); // 9/18 + 6 周 = 10/30 周五
    expect(makeup.orig_date).toBe("2026-09-25");
    // 节假日当天不占场：9/25 二号场 18-19:30 无冲突
    expect(findConflicts(w.db, 2, "2026-09-25 18:00", "2026-09-25 19:30")).toHaveLength(0);
  });

  it("三张月表都能出数，违约限订在会员表上体现", () => {
    const w = setupWorld(NOW);
    createCourse(w.db, {
      name: "成人班", coachId: 1, courtId: 1, weekday: 2,
      startTime: "19:00", endTime: "21:00", startDate: "2026-09-15", weeks: 4,
      holidayPolicy: "postpone",
    });
    const id = createBooking(w.db, {
      memberId: 1, cardId: w.cards.cash, courtId: 4,
      startSlot: "2026-09-16 19:00", endSlot: "2026-09-16 20:00", now: NOW,
    });
    checkIn(w.db, id, new Date(2026, 8, 16, 19, 0));

    // 另一个会员爽约 3 次
    addMember(w.db, 2, "老爽");
    const card = issueCard(w.db, { memberId: 2, kind: "package", courtType: "badminton", times: 30 });
    for (const day of [16, 17, 18]) {
      createBooking(w.db, {
        memberId: 2, cardId: card, courtId: 3,
        startSlot: `2026-09-${day} 10:00`, endSlot: `2026-09-${day} 11:00`, now: NOW,
      });
    }
    sweepNoShows(w.db, new Date(2026, 8, 18, 11, 0));

    const coach = coachCourseReport(w.db, "2026-09");
    expect(coach[0]!.coachName).toBe("陈静");
    expect(coach[0]!.slotsUsed).toBeGreaterThan(0);

    const util = courtUtilizationReport(w.db, "2026-09");
    expect(util).toHaveLength(6);
    const court1 = util.find((u) => u.courtName.includes("一号"))!;
    expect(court1.courseSlots).toBeGreaterThan(0);

    const members = memberConsumptionReport(w.db, "2026-09");
    const lao = members.find((m) => m.memberId === 2)!;
    expect(lao.violations).toBe(3);
    expect(lao.packageTimesForfeited).toBe(6);
    expect(lao.banned).toBe(true);
    const liu = members.find((m) => m.memberId === 1)!;
    expect(liu.storedSpentCents).toBe(3400);
  });
});
