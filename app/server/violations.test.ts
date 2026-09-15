import { describe, expect, it } from "vitest";
import { BookingError, cancelBooking, checkIn, createBooking } from "~/server/bookings";
import { issueCard } from "~/server/wallet";
import { banStatusAt, sweepNoShows, ViolationError } from "~/server/violations";
import { addMember, cardOf, setupWorld } from "./test-utils";

const NOW = new Date(2026, 8, 15, 12, 0, 0);

function book(db: ReturnType<typeof setupWorld>["db"], memberId: number, cardId: number, slot: string, now = NOW) {
  return createBooking(db, {
    memberId, cardId, courtId: 1,
    startSlot: `${slot} 10:00`, endSlot: `${slot} 11:00`, now,
  });
}

describe("爽约扫表与扣减", () => {
  it("开始后 30 分钟未核销：冻次扣没、订单 no_show、记一次违约", () => {
    const w = setupWorld(NOW);
    const id = book(w.db, 1, w.cards.badminton, "2026-09-16");
    // 开始时间 10:00，宽限到 10:30
    const at1025 = new Date(2026, 8, 16, 10, 25);
    expect(sweepNoShows(w.db, at1025)).toHaveLength(0);

    const results = sweepNoShows(w.db, new Date(2026, 8, 16, 10, 30));
    expect(results).toHaveLength(1);
    expect(results[0]!.timesForfeited).toBe(2);
    const c = cardOf(w.db, w.cards.badminton);
    expect(c.remaining_times).toBe(18);
    expect(c.frozen_times).toBe(0);
    expect(
      (w.db.prepare("SELECT status FROM bookings WHERE id=?").get(id) as { status: string }).status,
    ).toBe("no_show");
    expect(
      (w.db.prepare("SELECT count(*) n FROM violations WHERE member_id=1").get() as { n: number }).n,
    ).toBe(1);
  });

  it("已核销 / 已取消的单不会被扫成爽约", () => {
    const w = setupWorld(NOW);
    const id = book(w.db, 1, w.cards.badminton, "2026-09-16");
    checkIn(w.db, id, new Date(2026, 8, 16, 9, 55));
    const id2 = book(w.db, 1, w.cards.badminton, "2026-09-17");
    cancelBooking(w.db, id2, NOW);
    const results = sweepNoShows(w.db, new Date(2026, 8, 18, 12, 0));
    expect(results).toHaveLength(0);
  });
});

describe("月违约 3 次限订一周", () => {
  it("前两次违约不影响下单；第 3 次后限订 7 天，第 8 天恢复", () => {
    const w = setupWorld(NOW);
    addMember(w.db, 2, "老爽约");
    const card = issueCard(w.db, { memberId: 2, kind: "package", courtType: "badminton", times: 50 });

    // 9/16、9/17、9/18 连续三天 10:00 爽约
    for (let day = 16; day <= 18; day++) {
      book(w.db, 2, card, `2026-09-${day}`);
    }
    sweepNoShows(w.db, new Date(2026, 8, 18, 11, 0));
    expect(
      (w.db.prepare("SELECT count(*) n FROM violations WHERE member_id=2").get() as { n: number }).n,
    ).toBe(3);

    // 第 3 次发生日 9/18，限订至 9/25（不含）
    expect(banStatusAt(w.db, 2, new Date(2026, 8, 18, 11, 0)).banned).toBe(true);
    expect(banStatusAt(w.db, 2, new Date(2026, 8, 24, 23, 59)).banned).toBe(true);
    expect(banStatusAt(w.db, 2, new Date(2026, 8, 25, 0, 0)).banned).toBe(false);

    // 限订期内下单被拦
    expect(() =>
      createBooking(w.db, {
        memberId: 2, cardId: card, courtId: 2,
        startSlot: "2026-09-19 15:00", endSlot: "2026-09-19 16:00",
        now: new Date(2026, 8, 18, 12, 0),
      }),
    ).toThrow(ViolationError);

    // 9/25 恢复后可订
    expect(() =>
      createBooking(w.db, {
        memberId: 2, cardId: card, courtId: 2,
        startSlot: "2026-09-25 15:00", endSlot: "2026-09-25 16:00",
        now: new Date(2026, 8, 25, 9, 0),
      }),
    ).not.toThrow();
  });

  it("违约按自然月计数：跨月重新起算", () => {
    const w = setupWorld(NOW);
    addMember(w.db, 2, "跨月");
    const card = issueCard(w.db, { memberId: 2, kind: "package", courtType: "badminton", times: 50 });
    // 9 月造 2 次
    for (const day of [16, 17]) {
      book(w.db, 2, card, `2026-09-${day}`);
    }
    sweepNoShows(w.db, new Date(2026, 8, 18, 11, 0));
    const ban = banStatusAt(w.db, 2, new Date(2026, 8, 18, 11, 0));
    expect(ban.countInMonth).toBe(2);
    expect(ban.banned).toBe(false);
    // 10 月计数从 0 开始
    expect(banStatusAt(w.db, 2, new Date(2026, 9, 1, 12, 0)).countInMonth).toBe(0);
  });
});
