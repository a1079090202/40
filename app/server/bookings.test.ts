import { describe, expect, it } from "vitest";
import { BookingError, createBooking, recommendAlternatives } from "~/server/bookings";
import { createCourse } from "~/server/courses";
import { setupWorld } from "./test-utils";

const NOW = new Date(2026, 8, 15, 12, 0, 0); // 周二

describe("散客下单冲突拦截", () => {
  it("跟班课同时段必拦，冲突明细里是班课名", () => {
    const w = setupWorld(NOW);
    // 每周二 19:00-21:00 一号羽毛球，12 周
    createCourse(w.db, {
      name: "成人提高班", coachId: 1, courtId: 1, weekday: 2,
      startTime: "19:00", endTime: "21:00", startDate: "2026-09-15", weeks: 12,
      holidayPolicy: "postpone",
    });
    let caught: BookingError | undefined;
    try {
      createBooking(w.db, {
        memberId: 1, cardId: w.cards.badminton, courtId: 1,
        startSlot: "2026-09-22 19:00", endSlot: "2026-09-22 20:00", now: NOW,
      });
    } catch (e) {
      caught = e as BookingError;
    }
    expect(caught).toBeInstanceOf(BookingError);
    expect(caught!.conflicts).toHaveLength(1);
    expect(caught!.conflicts![0]!.label).toContain("成人提高班");
  });

  it("部分重叠也拦；非重叠时段可正常下单（先到先得）", () => {
    const w = setupWorld(NOW);
    const id = createBooking(w.db, {
      memberId: 1, cardId: w.cards.badminton, courtId: 1,
      startSlot: "2026-09-16 19:00", endSlot: "2026-09-16 20:00", now: NOW,
    });
    expect(id).toBeGreaterThan(0);

    expect(() =>
      createBooking(w.db, {
        memberId: 1, cardId: w.cards.badminton, courtId: 1,
        startSlot: "2026-09-16 19:30", endSlot: "2026-09-16 20:30", now: NOW,
      }),
    ).toThrow(BookingError);

    // 紧邻不重叠：20:00 起可订
    expect(() =>
      createBooking(w.db, {
        memberId: 1, cardId: w.cards.badminton, courtId: 1,
        startSlot: "2026-09-16 20:00", endSlot: "2026-09-16 21:00", now: NOW,
      }),
    ).not.toThrow();
  });

  it("羽毛球次卡不能订篮球场", () => {
    const w = setupWorld(NOW);
    expect(() =>
      createBooking(w.db, {
        memberId: 1, cardId: w.cards.badminton, courtId: 5,
        startSlot: "2026-09-16 19:00", endSlot: "2026-09-16 20:00", now: NOW,
      }),
    ).toThrow(/仅限/);
  });
});

describe("替代推荐", () => {
  it("tier1：一号场被班课占时，同日同时段推荐其他空闲羽毛球场，不含篮球场", () => {
    const w = setupWorld(NOW);
    createCourse(w.db, {
      name: "成人提高班", coachId: 1, courtId: 1, weekday: 2,
      startTime: "19:00", endTime: "21:00", startDate: "2026-09-15", weeks: 12,
      holidayPolicy: "postpone",
    });
    const alts = recommendAlternatives(w.db, "badminton", "2026-09-22 19:00", "2026-09-22 21:00", 1, NOW);
    expect(alts.length).toBeGreaterThan(0);
    expect(alts[0]!.tier).toBe(1);
    expect(alts[0]!.startSlot).toBe("2026-09-22 19:00");
    expect(new Set(alts.map((a) => a.courtId))).not.toContain(1);
    expect(alts.every((a) => a.courtType === "badminton")).toBe(true);
  });

  it("tier2：同日所有同类型场都占满时，给出同场相邻时段；且按距离排序", () => {
    const w = setupWorld(NOW);
    createCourse(w.db, {
      name: "晚训", coachId: 1, courtId: 1, weekday: 2,
      startTime: "19:00", endTime: "21:00", startDate: "2026-09-15", weeks: 12,
      holidayPolicy: "postpone",
    });
    // 把 2、3、4 号场 19-21 也占上（散客单）
    for (const courtId of [2, 3, 4]) {
      createBooking(w.db, {
        memberId: 1, cardId: w.cards.badminton, courtId,
        startSlot: "2026-09-22 19:00", endSlot: "2026-09-22 21:00", now: NOW,
      });
    }
    const alts = recommendAlternatives(w.db, "badminton", "2026-09-22 19:00", "2026-09-22 20:00", 1, NOW);
    const tier2 = alts.filter((a) => a.tier === 2);
    expect(tier2.length).toBeGreaterThan(0);
    // 最近的相邻是 18:00 或 21:00（差 60 分钟）
    expect(tier2[0]!.startSlot).toMatch(/(18:00|21:00)$/);
  });

  it("tier3：当天全满时推荐未来日期同时段", () => {
    const w = setupWorld(NOW);
    // 4 块羽毛球场 19-20 全占；扩大 limit 避免被同日相邻时段占满推荐位
    for (const courtId of [1, 2, 3, 4]) {
      createBooking(w.db, {
        memberId: 1, cardId: w.cards.badminton, courtId,
        startSlot: "2026-09-16 19:00", endSlot: "2026-09-16 20:00", now: NOW,
      });
    }
    const alts = recommendAlternatives(w.db, "badminton", "2026-09-16 19:00", "2026-09-16 20:00", 1, NOW, 100);
    const tier3 = alts.filter((a) => a.tier === 3);
    expect(tier3.length).toBeGreaterThan(0);
    expect(tier3[0]!.startSlot > "2026-09-16").toBe(true);
    // 最近的一天是 9/17 同时段
    expect(tier3[0]!.startSlot.startsWith("2026-09-17 19:00")).toBe(true);
  });
});
