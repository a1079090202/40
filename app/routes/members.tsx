import type { ActionFunctionArgs, MetaFunction } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, useLoaderData } from "@remix-run/react";
import { getDb } from "~/server/db";
import { listMembers } from "~/server/catalog";
import {
  getCard,
  issueCard,
  listCardTxns,
  listMemberCards,
  recharge,
  usableBalance,
  usableTimes,
} from "~/server/wallet";
import { listBookingsByMember } from "~/server/bookings";
import { banStatusAt } from "~/server/violations";
import { COURT_TYPE_LABEL } from "~/server/config";
import { formatYuan } from "~/server/pricing";
import { nowLocal } from "~/server/time";

export const meta: MetaFunction = () => [{ title: "会员卡" }];

const STATUS_LABEL: Record<string, string> = {
  held: "待核销",
  checked_in: "已核销",
  cancelled: "已取消",
  late_cancelled: "2h内取消",
  no_show: "爽约",
};

export async function loader() {
  const db = getDb();
  const members = listMembers(db).map((m) => ({
    ...m,
    ban: banStatusAt(db, m.id, nowLocal()),
    cards: listMemberCards(db, m.id).map((c) => ({
      id: c.id,
      kind: c.kind,
      courtType: c.court_type,
      remaining: c.kind === "package" ? c.remaining_times : c.balance_cents,
      frozen: c.kind === "package" ? c.frozen_times : c.frozen_cents,
      usable: c.kind === "package" ? usableTimes(c) : usableBalance(c),
    })),
    bookings: (listBookingsByMember(db, m.id) as Array<Record<string, unknown>>).slice(0, 8),
  }));
  return json({ members });
}

export async function action({ request }: ActionFunctionArgs) {
  const db = getDb();
  const form = await request.formData();
  if (form.get("kind") === "issue") {
    const memberId = Number(form.get("memberId"));
    if (form.get("cardKind") === "package") {
      issueCard(db, {
        memberId,
        kind: "package",
        courtType: String(form.get("courtType")) as "badminton" | "basketball",
        times: Number(form.get("times")),
      });
    } else {
      issueCard(db, {
        memberId,
        kind: "stored_value",
        initialCents: Math.round(Number(form.get("amountYuan")) * 100),
      });
    }
    return redirect("/members?msg=" + encodeURIComponent("开卡成功"));
  }
  if (form.get("kind") === "recharge") {
    const cardId = Number(form.get("cardId"));
    recharge(db, cardId, Math.round(Number(form.get("amountYuan")) * 100));
    const card = getCard(db, cardId)!;
    return redirect("/members?msg=" + encodeURIComponent(`#${cardId} 已充值，余额 ¥${formatYuan(card.balance_cents ?? 0)}`));
  }
  return json({ error: "未知操作" });
}

export default function MembersPage() {
  const data = useLoaderData<typeof loader>();
  const params = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");

  return (
    <div>
      <h1>会员卡与会员</h1>
      {params.get("msg") && <div className="flash-ok">{params.get("msg")}</div>}

      {data.members.map((m) => (
        <div className="panel" key={m.id}>
          <h2 style={{ marginTop: 0 }}>
            {m.id}. {m.name} <span className="muted">{m.phone}</span>{" "}
            {m.ban.banned ? (
              <span className="badge banned">限订中（至 {m.ban.until}）</span>
            ) : (
              <span className="muted">本月违约 {m.ban.countInMonth} 次</span>
            )}
          </h2>

          <table>
            <thead>
              <tr><th>卡号</th><th>类型</th><th>总额/总次</th><th>冻结中</th><th>可用</th><th>充值</th></tr>
            </thead>
            <tbody>
              {m.cards.length === 0 && <tr><td colSpan={6} className="muted">无卡</td></tr>}
              {m.cards.map((c) => (
                <tr key={c.id}>
                  <td>#{c.id}</td>
                  <td>
                    {c.kind === "package"
                      ? `${COURT_TYPE_LABEL[c.courtType as keyof typeof COURT_TYPE_LABEL]}次卡`
                      : "储值卡"}
                  </td>
                  <td>{c.kind === "package" ? `${c.remaining} 次` : `¥${formatYuan(c.remaining ?? 0)}`}</td>
                  <td>{c.kind === "package" ? `${c.frozen} 次` : `¥${formatYuan(c.frozen ?? 0)}`}</td>
                  <td><strong>{c.kind === "package" ? `${c.usable} 次` : `¥${formatYuan(c.usable)}`}</strong></td>
                  <td>
                    {c.kind === "stored_value" && (
                      <Form method="post" className="inline row" style={{ gap: 6 }}>
                        <input type="hidden" name="kind" value="recharge" />
                        <input type="hidden" name="cardId" value={c.id} />
                        <input name="amountYuan" type="number" min={1} step="0.01" placeholder="元" style={{ width: 90 }} />
                        <button type="submit">充值</button>
                      </Form>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <details style={{ marginTop: 10 }}>
            <summary className="muted">开新卡 / 查看最近 8 条预订</summary>
            <Form method="post" className="row" style={{ margin: "10px 0" }}>
              <input type="hidden" name="kind" value="issue" />
              <input type="hidden" name="memberId" value={m.id} />
              <label>卡种
                <select name="cardKind">
                  <option value="package">次卡</option>
                  <option value="stored_value">储值卡</option>
                </select>
              </label>
              <label>场地类型
                <select name="courtType">
                  <option value="badminton">羽毛球</option>
                  <option value="basketball">篮球</option>
                </select>
              </label>
              <label>次数 <input name="times" type="number" min={1} defaultValue={10} style={{ width: 80 }} /></label>
              <label>或充值金额（元） <input name="amountYuan" type="number" min={0} step="0.01" defaultValue={500} style={{ width: 100 }} /></label>
              <button type="submit">开卡</button>
            </Form>
            <table>
              <thead>
                <tr><th>#</th><th>场地</th><th>时段</th><th>状态</th><th>场租</th><th>灯光</th></tr>
              </thead>
              <tbody>
                {m.bookings.length === 0 && <tr><td colSpan={6} className="muted">暂无预订</td></tr>}
                {m.bookings.map((b) => (
                  <tr key={String(b.id)}>
                    <td>#{String(b.id)}</td>
                    <td>{String(b.court_name)}</td>
                    <td>{String(b.start_slot)}–{String(b.end_slot).slice(11)}</td>
                    <td><span className={`badge ${String(b.status)}`}>{STATUS_LABEL[String(b.status)] ?? String(b.status)}</span></td>
                    <td>¥{formatYuan(Number(b.court_fee_cents))}</td>
                    <td>¥{formatYuan(Number(b.light_fee_cents))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </div>
      ))}
    </div>
  );
}
