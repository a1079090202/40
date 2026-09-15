import type { DB } from "./db";

export interface CourtRow {
  id: number;
  name: string;
  type: "badminton" | "basketball";
  sort_order: number;
  active: number;
}

export function listCourts(db: DB, activeOnly = true): CourtRow[] {
  return db
    .prepare(activeOnly ? "SELECT * FROM courts WHERE active = 1 ORDER BY sort_order, id" : "SELECT * FROM courts ORDER BY sort_order, id")
    .all() as CourtRow[];
}

export function getCourt(db: DB, courtId: number): CourtRow | undefined {
  return db.prepare("SELECT * FROM courts WHERE id = ?").get(courtId) as CourtRow | undefined;
}

export function listMembers(db: DB) {
  return db.prepare("SELECT * FROM members ORDER BY id").all() as Array<{
    id: number; name: string; phone: string | null; created_at: string;
  }>;
}

export function getMember(db: DB, memberId: number) {
  return db.prepare("SELECT * FROM members WHERE id = ?").get(memberId) as
    | { id: number; name: string; phone: string | null; created_at: string }
    | undefined;
}

export function listCoaches(db: DB) {
  return db.prepare("SELECT * FROM coaches ORDER BY id").all() as Array<{
    id: number;
    name: string;
    phone: string | null;
  }>;
}

export function listHolidays(db: DB) {
  return db.prepare("SELECT * FROM holidays ORDER BY date").all() as Array<{
    date: string;
    name: string;
  }>;
}

export function addHoliday(db: DB, date: string, name: string): void {
  db.prepare("INSERT OR REPLACE INTO holidays (date, name) VALUES (?, ?)").run(date, name);
}

export function deleteHoliday(db: DB, date: string): void {
  db.prepare("DELETE FROM holidays WHERE date = ?").run(date);
}
