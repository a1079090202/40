// 本地时间、半小时粒度工具。
// 系统内所有时段用 'YYYY-MM-DD HH:MM' 字符串作 key，金额一律在别处按分存。

export const SLOT_MINUTES = 30;
const KEY_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fmtTime(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtSlot(d: Date): string {
  return `${fmtDate(d)} ${fmtTime(d)}`;
}

/** 解析为本地时间 Date */
export function parseSlot(key: string): Date {
  const m = KEY_RE.exec(key);
  if (!m) throw new Error(`非法时段 key: ${key}`);
  const [, y, mo, da, h, mi] = m as RegExpExecArray & string[];
  const d = new Date(Number(y), Number(mo) - 1, Number(da), Number(h), Number(mi), 0, 0);
  if (Number.isNaN(d.getTime())) throw new Error(`非法日期: ${key}`);
  return d;
}

export function parseDate(key: string): Date {
  if (!DATE_RE.test(key)) throw new Error(`非法日期: ${key}`);
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y!, m! - 1, d!);
}

export function assertSlot(key: string): void {
  const d = parseSlot(key);
  if (d.getMinutes() % SLOT_MINUTES !== 0) throw new Error(`时段必须对齐到 ${SLOT_MINUTES} 分钟: ${key}`);
}

export function slotKey(date: string, time: string): string {
  const key = `${date} ${time}`;
  assertSlot(key);
  return key;
}

export function dateOf(key: string): string {
  return key.slice(0, 10);
}

export function timeOf(key: string): string {
  return key.slice(11, 16);
}

export function addMinutes(key: string, minutes: number): string {
  if (minutes % SLOT_MINUTES !== 0) throw new Error("只能按半小时步进");
  return fmtSlot(new Date(parseSlot(key).getTime() + minutes * 60_000));
}

export function addSlots(key: string, n: number): string {
  return addMinutes(key, n * SLOT_MINUTES);
}

export function addDays(date: string, n: number): string {
  const d = parseDate(date);
  d.setDate(d.getDate() + n);
  return fmtDate(d);
}

export function addWeeks(date: string, n: number): string {
  return addDays(date, n * 7);
}

/** 两个 slot 之间的半小时格数（end 不含） */
export function slotSpan(startKey: string, endKey: string): number {
  const mins = (parseSlot(endKey).getTime() - parseSlot(startKey).getTime()) / 60_000;
  if (mins <= 0) throw new Error(`时段区间非法: ${startKey} ~ ${endKey}`);
  if (mins % SLOT_MINUTES !== 0) throw new Error("时段必须对齐到半小时");
  return mins / SLOT_MINUTES;
}

/** [start, end) 内每个半小时格的起点 */
export function slotSequence(startKey: string, endKey: string): string[] {
  const n = slotSpan(startKey, endKey);
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(addSlots(startKey, i));
  return out;
}

/** 半开区间重叠判断 */
export function overlaps(
  aStart: string,
  aEnd: string,
  bStart: string,
  bEnd: string,
): boolean {
  return parseSlot(aStart) < parseSlot(bEnd) && parseSlot(bStart) < parseSlot(aEnd);
}

export function diffMinutes(aKey: string, bKey: string): number {
  return (parseSlot(aKey).getTime() - parseSlot(bKey).getTime()) / 60_000;
}

/** 生成连续日历日期（含首尾） */
export function dateRange(fromDate: string, toDate: string): string[] {
  const out: string[] = [];
  for (let d = fromDate; d <= toDate; d = addDays(d, 1)) out.push(d);
  return out;
}

export function nowLocal(): Date {
  return new Date();
}
