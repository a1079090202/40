import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useSearchParams } from "@remix-run/react";
import { useMemo } from "react";
import { getDb } from "~/server/db";
import { listCourts, listMembers, getCourt } from "~/server/catalog";
import { occupancyOnCourtDate } from "~/server/availability";
import {
  BookingError,
  cancelBooking,
  checkIn,
  createBooking,
  listBookingsOnDate,
} from "~/server/bookings";
import { listMemberCards, usableBalance, usableTimes } from "~/server/wallet";
import { OPEN_FROM, OPEN_TO, COURT_TYPE_LABEL } from "~/server/config";
import { addDays, addSlots, dateRange, fmtDate, nowLocal, slotSequence } from "~/server/time";
import { formatYuan } from "~/server/pricing";
import { banStatusAt } from "~/server/violations";

export const meta: MetaFunction = () => [{ title: "场地日历" }];

const STATUS_LABEL: Record<string, string> = {
  held: "待核销",
  checked_in: "已核销",
  cancelled: "已取消",
  late_cancelled: "迟取消",
  no_show: "爽约",
};

export async function loader({ request }: LoaderFunctionArgs) {
  const db = getDb();
  const url = new URL(request.url);
  const today = fmtDate(nowLocal());
  const date = url.searchParams.get("date") ?? today;
  const courts = listCourts(db);
  const slots = slotSequence(`${date} ${OPEN_FROM}`, `${date} ${OPEN_TO}`);

  const grid = courts.map((c) => {
    const occ = occupancyOnCourtDate(db, c.id, date);
    return {
      courtId: c.id,
      courtName: c.name,
      courtType: c.type,
      cells: slots.map((s) => {
        const hit = occ.find((o) => s >= o.startSlot && s < o.endSlot);
        return { slot: s, occ: hit ?? null };
      }),
    };
  });

  const members = listMembers(db).map((m) => ({
    ...m,
    cards: listMemberCards(db, m.id).map((c) => ({
      id: c.id,
      kind: c.kind,
      courtType: c.court_type,
      usableTimes: usableTimes(c),
      usableBalance: usableBalance(c),
    })),
    ban: banStatusAt(db, m.id, nowLocal()),
  }));

  const bookings = listBookingsOnDate(db, date);
  return json({
    date,
    today,
    courts,
    slots,
    grid,
    members,
    bookings,
    prefill: {
      courtId: url.searchParams.get("courtId"),
      start: url.searchParams.get("start"),
      end: url.searchParams.get("end"),
      memberId: url.searchParams.get("memberId"),
    },
    msg: url.searchParams.get("msg"),
  });
}

interface ActionResult {
  error?: string;
  conflicts?: string[];
  alternatives?: Array<{
    courtId: number; courtName: string; courtType: string;
    startSlot: string; endSlot: string; tier: number; reason: string;
  }>;
  form?: Record<string, FormDataEntryValue>;
}

export async function action({ request }: ActionFunctionArgs) {
  const db = getDb();
  const form = await request.formData();
  const kind = String(form.get("kind") ?? "");
  try {
    if (kind === "book") {
      const date = String(form.get("date"));
      const memberId = Number(form.get("memberId"));
      const cardId = Number(form.get("cardId"));
      const courtId = Number(form.get("courtId"));
      const startSlot = `${date} ${String(form.get("startTime"))}`;
      const duration = Number(form.get("duration"));
      const endSlot = addSlots(startSlot, duration * 2);
      const id = createBooking(db, { memberId, cardId, courtId, startSlot, endSlot });
      const court = getCourt(db, courtId);
      return redirect(
        `/calendar?date=${date}&msg=${encodeURIComponent(`下单成功 #${id}：${court?.name} ${startSlot.slice(11)}–${endSlot.slice(11)}，额度已冻结`)}`,
      );
    }
    if (kind === "checkin") {
      const id = Number(form.get("bookingId"));
      const date = String(form.get("date"));
      const r = checkIn(db, id);
      const detail =
        r.cardKind === "package"
          ? `扣 ${r.timesCharged} 次` + (r.lightCashCents ? `，现收灯光费 ¥${formatYuan(r.lightCashCents)}` : "")
          : `卡扣 ¥${formatYuan(r.cashChargedCents)}`;
      return redirect(`/calendar?date=${date}&msg=${encodeURIComponent(`#${id} 核销完成：${detail}`)}`);
    }
    if (kind === "cancel") {
      const id = Number(form.get("bookingId"));
      const date = String(form.get("date"));
      const status = cancelBooking(db, id);
      return redirect(
        `/calendar?date=${date}&msg=${encodeURIComponent(
          status === "cancelled" ? `#${id} 已取消，冻结全额退回` : `#${id} 距开始不足 2 小时，冻结不退`,
        )}`,
      );
    }
  } catch (e) {
    const err = e as BookingError;
    const result: ActionResult = {
      error: err.message,
      conflicts: (err.conflicts ?? []).map((c) => c.label),
      alternatives: err.alternatives ?? [],
      form: Object.fromEntries(form),
    };
    return json(result);
  }
  return json<ActionResult>({ error: "未知操作" });
}

export default function CalendarPage() {
  const data = useLoaderData<typeof loader>();
  const resp = useActionData<typeof action>();
  const [params] = useSearchParams();

  const initialStart = data.prefill.start?.slice(11, 16) ?? "19:00";
  const initialCourt = data.prefill.courtId ?? String(data.courts[0]?.id ?? "");

  const memberCards = useMemo(() => {
    const m = new Map<number, (typeof data.members)[number]["cards"]>();
    for (const mem of data.members) m.set(mem.id, mem.cards);
    return m;
  }, [data.members]);

  return (
    <div>
      <h1>场地日历</h1>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <Form method="get" className="row">
          <a className="btn ghost" href={`/calendar?date=${addDays(data.date, -1)}`}>← 前一天</a>
          <input type="date" name="date" defaultValue={data.date} />
          <button type="submit">跳转</button>
          <a className="btn ghost" href={`/calendar?date=${addDays(data.date, 1)}`}>后一天 →</a>
          <a className="btn ghost" href={`/calendar?date=${data.today}`}>今天</a>
        </Form>
        <span className="muted">
          开放 {OPEN_FROM}–{OPEN_TO}，蓝=班课，绿=散客占用，红=爽约
        </span>
      </div>

      {data.msg && <div className="flash-ok" style={{ marginTop: 12 }}>{data.msg}</div>}
      {resp && "error" in resp && resp.error && (
        <div className="flash-error" style={{ marginTop: 12 }}>
          <div><strong>下单被拦：{resp.error}</strong></div>
          {resp.conflicts && resp.conflicts.length > 0 && (
            <div>冲突占用：{resp.conflicts.join("、")}</div>
          )}
          {resp.alternatives && resp.alternatives.length > 0 && (
            <div>
              最近可用替代：
              <ul className="alts">
                {resp.alternatives.map((a) => (
                  <li key={`${a.courtId}-${a.startSlot}`}>
                    <Form method="post" style={{ display: "inline" }}>
                      <input type="hidden" name="kind" value="book" />
                      <input type="hidden" name="date" value={a.startSlot.slice(0, 10)} />
                      <input type="hidden" name="memberId" value={String(resp.form?.memberId ?? "")} />
                      <input type="hidden" name="cardId" value={String(resp.form?.cardId ?? "")} />
                      <input type="hidden" name="courtId" value={a.courtId} />
                      <input type="hidden" name="startTime" value={a.startSlot.slice(11, 16)} />
                      <input type="hidden" name="duration" value="1" />
                      <button type="submit">
                        {a.courtName} {a.startSlot.slice(5).replace(" ", " ")}–{a.endSlot.slice(11, 16)}
                      </button>
                    </Form>
                    <span className="muted">（{a.reason}）</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="panel" style={{ overflowX: "auto", marginTop: 12 }}>
        <table className="grid-table">
          <thead>
            <tr>
              <th style={{ width: 60 }}>时间</th>
              {data.grid.map((c) => (
                <th key={c.courtId}>
                  {c.courtName}
                  <div className="muted">{COURT_TYPE_LABEL[c.courtType as keyof typeof COURT_TYPE_LABEL]}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.slots.map((slot, i) => (
              <tr key={slot}>
                <td className="muted">{slot.slice(11, 16)}</td>
                {data.grid.map((c) => {
                  const cell = c.cells[i]!;
                  const occ = cell.occ;
                  if (!occ) {
                    return (
                      <td key={c.courtId} className="muted">
                        <a
                          className="celllink"
                          href={`/calendar?date=${data.date}&courtId=${c.courtId}&start=${slot}&end=${addSlots(slot, 1)}`}
                        >
                          ＋
                        </a>
                      </td>
                    );
                  }
                  // 只在占用起始格显示文字，其余格保持同色
                  const isStart = occ.startSlot === slot;
                  const cls =
                    occ.kind === "course"
                      ? occ.sessionState === "makeup"
                        ? "cell-makeup"
                        : "cell-course"
                      : `cell-${occ.status ?? "held"}`;
                  return (
                    <td key={c.courtId} className={cls} title={occ.label}>
                      {isStart ? occ.label : ""}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>散客下单（先到先得，跟班课冲突必拦）</h2>
        <Form method="post" className="row" id="bookform">
          <input type="hidden" name="kind" value="book" />
          <input type="hidden" name="date" value={data.date} />
          <label>
            会员
            <select
              name="memberId"
              defaultValue={data.prefill.memberId ?? String(data.members[0]?.id ?? "")}
              onChange={(e) => {
                const sel = e.currentTarget.form?.querySelector("select[name=cardId]") as HTMLSelectElement | null;
                const cards = memberCards.get(Number(e.currentTarget.value)) ?? [];
                if (sel && cards[0]) sel.value = String(cards[0].id);
              }}
            >
              {data.members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                  {m.ban.banned ? `（限订至 ${m.ban.until}）` : ` 本月违约${m.ban.countInMonth}次`}
                </option>
              ))}
            </select>
          </label>
          <label>
            用卡
            <select name="cardId" defaultValue="">
              <option value="" disabled>选择卡…</option>
              {data.members.flatMap((m) =>
                m.cards.map((c) => (
                  <option key={c.id} value={c.id}>
                    {m.name} ·{" "}
                    {c.kind === "package"
                      ? `${COURT_TYPE_LABEL[c.courtType as keyof typeof COURT_TYPE_LABEL]}次卡 剩${c.usableTimes}次`
                      : `储值卡 余¥${formatYuan(c.usableBalance)}`}
                  </option>
                )),
              )}
            </select>
          </label>
          <label>
            场地
            <select name="courtId" defaultValue={initialCourt}>
              {data.courts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}（{COURT_TYPE_LABEL[c.type as keyof typeof COURT_TYPE_LABEL]}）
                </option>
              ))}
            </select>
          </label>
          <label>
            开始
            <input type="time" name="startTime" step={1800} defaultValue={initialStart} />
          </label>
          <label>
            时长
            <select name="duration" defaultValue={params.get("end") ? "0.5" : "1"}>
              <option value={0.5}>0.5 小时</option>
              <option value={1}>1 小时</option>
              <option value={1.5}>1.5 小时</option>
              <option value={2}>2 小时</option>
              <option value={3}>3 小时</option>
            </select>
          </label>
          <button type="submit">预订并冻结</button>
        </Form>
        <p className="muted" style={{ marginBottom: 0 }}>
          次卡按半小时一格冻结次数；储值卡按「场租 + 晚场灯光费」冻结金额。开始前 2 小时外取消全额退回，2 小时内不退；开始后 30 分钟未核销记爽约。
        </p>
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>当日散客单（{data.date}）</h2>
        <table>
          <thead>
            <tr>
              <th>#</th><th>会员</th><th>场地</th><th>时段</th><th>状态</th>
              <th>冻结/场租</th><th>灯光费</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            {data.bookings.length === 0 && (
              <tr><td colSpan={8} className="muted">当日无散客单</td></tr>
            )}
            {data.bookings.map((b) => (
              <tr key={b.id}>
                <td>#{b.id}</td>
                <td>{b.member_name}</td>
                <td>{b.court_name}</td>
                <td>{b.start_slot.slice(11)}–{b.end_slot.slice(11)}</td>
                <td><span className={`badge ${b.status}`}>{STATUS_LABEL[b.status] ?? b.status}</span></td>
                <td>¥{formatYuan(b.court_fee_cents)}</td>
                <td>¥{formatYuan(b.light_fee_cents)}</td>
                <td>
                  {b.status === "held" && (
                    <span className="row" style={{ gap: 6 }}>
                      <Form method="post" className="inline">
                        <input type="hidden" name="kind" value="checkin" />
                        <input type="hidden" name="bookingId" value={b.id} />
                        <input type="hidden" name="date" value={data.date} />
                        <button className="green" type="submit">核销</button>
                      </Form>
                      <Form method="post" className="inline">
                        <input type="hidden" name="kind" value="cancel" />
                        <input type="hidden" name="bookingId" value={b.id} />
                        <input type="hidden" name="date" value={data.date} />
                        <button className="ghost" type="submit">取消</button>
                      </Form>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
