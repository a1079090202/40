import { describe, expect, it } from "vitest";
import { BookingError, cancelBooking, checkIn, createBooking, getBooking } from "~/server/bookings";
import { issueCard, listCardTxns } from "~/server/wallet";
import { setupWorld, cardOf, addMember } from "./test-utils";

const NOW = new Date(2026, 8, 15, 12, 0, 0); // 周二 12:00

describe("冻结：下单先冻结额度", () => {
  it("次卡下单冻次数，不扣减剩余总数；可用次数下降", () => {
    const w = setupWorld(NOW);
    const before = cardOf(w.db, w.cards.badminton);
    expect(before.remaining_times).toBe(20);
    expect(before.frozen_times).toBe(0);

    // 周三 19:00-20:30 = 3 格
    createBooking(w.db, {
      memberId: 1, cardId: w.cards.badminton, courtId: 1,
      startSlot: "2026-09-16 19:00", endSlot: "2026-09-16 20:30", now: NOW,
    });
    const after = cardOf(w.db, w.cards.badminton);
    expect(after.remaining_times).toBe(20); // 总数未扣
    expect(after.frozen_times).toBe(3);
    const txns = listCardTxns(w.db, w.cards.badminton);
    expect(txns).toHaveLength(1);
    expect(txns[0]!.type).toBe("freeze");
  });

  it("储值卡下单冻金额（场租+晚场灯光），余额不变、可用减少", () => {
    const w = setupWorld(NOW);
    // 19:00-20:00 羽毛球 2 格：场租 2×1500=3000，灯光 2×200=400，冻 3400
    createBooking(w.db, {
      memberId: 1, cardId: w.cards.cash, courtId: 1,
      startSlot: "2026-09-16 19:00", endSlot: "2026-09-16 20:00", now: NOW,
    });
    const c = cardOf(w.db, w.cards.cash);
    expect(c.balance_cents).toBe(50000);
    expect(c.frozen_cents).toBe(3400);
  });

  it("白场无灯光费：10:00-11:00 只冻场租", () => {
    const w = setupWorld(NOW);
    createBooking(w.db, {
      memberId: 1, cardId: w.cards.cash, courtId: 1,
      startSlot: "2026-09-16 10:00", endSlot: "2026-09-16 11:00", now: NOW,
    });
    expect(cardOf(w.db, w.cards.cash).frozen_cents).toBe(3000);
  });

  it("可用额度不足直接拒绝，不产生任何冻结", () => {
    const w = setupWorld(NOW);
    addMember(w.db, 2, "钱少");
    const poor = issueCard(w.db, { memberId: 2, kind: "stored_value", initialCents: 100 });
    // 一个晚场格需 1700（场租 1500 + 灯光 200），卡内仅 100 分
    expect(() =>
      createBooking(w.db, {
        memberId: 2, cardId: poor, courtId: 1,
        startSlot: "2026-09-16 19:00", endSlot: "2026-09-16 19:30", now: NOW,
      }),
    ).toThrow(/余额不足/);
    const c = cardOf(w.db, poor);
    expect(c.frozen_cents).toBe(0);
    expect(c.balance_cents).toBe(100);
    // 没有生成预订
    expect((w.db.prepare("SELECT count(*) n FROM bookings").get() as { n: number }).n).toBe(0);
  });

  it("次卡次数不足同样拒绝", () => {
    const w = setupWorld(NOW);
    addMember(w.db, 2, "次少");
    const poor = issueCard(w.db, { memberId: 2, kind: "package", courtType: "badminton", times: 1 });
    expect(() =>
      createBooking(w.db, {
        memberId: 2, cardId: poor, courtId: 1,
        startSlot: "2026-09-16 19:00", endSlot: "2026-09-16 20:00", now: NOW, // 2 格
      }),
    ).toThrow(/次数不足/);
    expect(cardOf(w.db, poor).frozen_times).toBe(0);
  });
});

describe("核销：冻结转真实扣减，灯光费一并入账", () => {
  it("次卡核销：冻结次数转扣减（总次数减少），晚场灯光费现收计入收入", () => {
    const w = setupWorld(NOW);
    const id = createBooking(w.db, {
      memberId: 1, cardId: w.cards.badminton, courtId: 1,
      startSlot: "2026-09-16 19:00", endSlot: "2026-09-16 20:00", now: NOW,
    });
    const r = checkIn(w.db, id, new Date(2026, 8, 16, 19, 0));
    expect(r.timesCharged).toBe(2);
    expect(r.lightCashCents).toBe(400); // 2 格 × 200
    const c = cardOf(w.db, w.cards.badminton);
    expect(c.remaining_times).toBe(18);
    expect(c.frozen_times).toBe(0);

    const revenue = w.db
      .prepare("SELECT category, sum(amount_cents) cents FROM revenue_entries GROUP BY category")
      .all() as Array<{ category: string; cents: number }>;
    const light = revenue.find((x) => x.category === "light")!;
    expect(light.cents).toBe(400);
    // 次卡扣的是次数，不产生场租现金收入
    expect(revenue.find((x) => x.category === "court")).toBeUndefined();
  });

  it("储值卡核销：按场租+灯光实扣，订单状态变 checked_in", () => {
    const w = setupWorld(NOW);
    const id = createBooking(w.db, {
      memberId: 1, cardId: w.cards.cash, courtId: 1,
      startSlot: "2026-09-16 19:00", endSlot: "2026-09-16 20:00", now: NOW,
    });
    const r = checkIn(w.db, id, new Date(2026, 8, 16, 19, 0));
    expect(r.cashChargedCents).toBe(3400);
    const c = cardOf(w.db, w.cards.cash);
    expect(c.balance_cents).toBe(46600);
    expect(c.frozen_cents).toBe(0);
    expect(getBooking(w.db, id)!.status).toBe("checked_in");
  });
});

describe("取消：2 小时界限", () => {
  it("开始前 >2h 取消：全额释放冻结，订单 cancelled，可再订", () => {
    const w = setupWorld(NOW);
    const id = createBooking(w.db, {
      memberId: 1, cardId: w.cards.cash, courtId: 1,
      startSlot: "2026-09-16 19:00", endSlot: "2026-09-16 20:00", now: NOW,
    });
    const status = cancelBooking(w.db, id, NOW); // 距开始 31h
    expect(status).toBe("cancelled");
    const c = cardOf(w.db, w.cards.cash);
    expect(c.frozen_cents).toBe(0);
    expect(c.balance_cents).toBe(50000);
  });

  it("开始前 2h 内取消：不退冻结（late_cancelled）", () => {
    const w = setupWorld(NOW);
    const id = createBooking(w.db, {
      memberId: 1, cardId: w.cards.badminton, courtId: 1,
      startSlot: "2026-09-16 19:00", endSlot: "2026-09-16 20:00", now: NOW,
    });
    const status = cancelBooking(w.db, id, new Date(2026, 8, 16, 17, 30)); // 距开始 1.5h
    expect(status).toBe("late_cancelled");
    const c = cardOf(w.db, w.cards.badminton);
    expect(c.frozen_times).toBe(0);
    expect(c.remaining_times).toBe(18); // 2 次照扣
  });

  it("已过开始时间不能取消", () => {
    const w = setupWorld(NOW);
    const id = createBooking(w.db, {
      memberId: 1, cardId: w.cards.badminton, courtId: 1,
      startSlot: "2026-09-16 19:00", endSlot: "2026-09-16 20:00", now: NOW,
    });
    expect(() => cancelBooking(w.db, id, new Date(2026, 8, 16, 19, 10))).toThrow(BookingError);
  });
});
