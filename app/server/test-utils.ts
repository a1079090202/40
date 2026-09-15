import { createDb, migrate, type DB } from "./db";
import { issueCard } from "./wallet";

export interface World {
  db: DB;
  now: Date;
  coach: number;
  members: number[];
  cards: { badminton: number; basketball: number; cash: number };
}

/** 固定时钟的内存库：4 羽毛球场 + 2 篮球半场，1 教练，1 会员（三类卡各备一张） */
export function setupWorld(now = new Date(2026, 8, 15, 12, 0, 0)): World {
  const db = createDb(":memory:");
  migrate(db);
  const insCourt = db.prepare("INSERT INTO courts (id, name, type, sort_order) VALUES (?, ?, ?, ?)");
  [
    [1, "羽毛球一号场", "badminton", 1],
    [2, "羽毛球二号场", "badminton", 2],
    [3, "羽毛球三号场", "badminton", 3],
    [4, "羽毛球四号场", "badminton", 4],
    [5, "篮球半场·东", "basketball", 5],
    [6, "篮球半场·西", "basketball", 6],
  ].forEach((r) => insCourt.run(...(r as [number, string, string, number])));
  const coach = Number(
    db.prepare("INSERT INTO coaches (id, name, phone) VALUES (1, '陈静', '13800000001')").run()
      .lastInsertRowid,
  );
  const memberId = Number(
    db
      .prepare("INSERT INTO members (id, name, phone, created_at) VALUES (1, '刘洋', '13900000001', ?)")
      .run(now.toISOString()).lastInsertRowid,
  );
  const badmintonCard = issueCard(db, { memberId, kind: "package", courtType: "badminton", times: 20 });
  const basketballCard = issueCard(db, { memberId, kind: "package", courtType: "basketball", times: 10 });
  const cashCard = issueCard(db, { memberId, kind: "stored_value", initialCents: 50000 });
  return {
    db,
    now,
    coach,
    members: [memberId],
    cards: { badminton: badmintonCard, basketball: basketballCard, cash: cashCard },
  };
}

export function addMember(db: DB, id: number, name = `会员${id}`): number {
  db.prepare("INSERT INTO members (id, name, phone, created_at) VALUES (?, ?, '13900000000', '2026-08-01')").run(id, name);
  return id;
}

export function cardOf(db: DB, cardId: number) {
  return db.prepare("SELECT * FROM cards WHERE id = ?").get(cardId) as {
    remaining_times: number | null;
    frozen_times: number;
    balance_cents: number | null;
    frozen_cents: number;
  };
}
