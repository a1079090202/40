import type { MetaFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { Form, useLoaderData } from "@remix-run/react";
import { getDb } from "~/server/db";
import {
  coachCourseReport,
  courtUtilizationReport,
  memberConsumptionReport,
  revenueTotal,
} from "~/server/reports";
import { OPEN_FROM, OPEN_TO, COURT_TYPE_LABEL } from "~/server/config";
import { formatYuan } from "~/server/pricing";
import { fmtDate, nowLocal } from "~/server/time";

export const meta: MetaFunction = () => [{ title: "月度报表" }];

export async function loader({ request }: { request: Request }) {
  const db = getDb();
  const url = new URL(request.url);
  const ym = url.searchParams.get("ym") ?? fmtDate(nowLocal()).slice(0, 7);
  return json({
    ym,
    coach: coachCourseReport(db, ym),
    util: courtUtilizationReport(db, ym),
    members: memberConsumptionReport(db, ym),
    revenue: revenueTotal(db, ym),
  });
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

export default function ReportsPage() {
  const d = useLoaderData<typeof loader>();

  return (
    <div>
      <h1>月底报表（{d.ym}）</h1>
      <Form method="get" className="row" style={{ marginBottom: 12 }}>
        <label>统计月份 <input type="month" name="ym" defaultValue={d.ym} /></label>
        <button type="submit">出表</button>
      </Form>

      <div className="kpi" style={{ marginBottom: 16 }}>
        <div className="card"><div className="muted">场租收入</div><div className="num">¥{formatYuan(d.revenue.courtCents)}</div></div>
        <div className="card"><div className="muted">灯光费收入</div><div className="num">¥{formatYuan(d.revenue.lightCents)}</div></div>
        <div className="card">
          <div className="muted">合计</div>
          <div className="num">¥{formatYuan(d.revenue.courtCents + d.revenue.lightCents)}</div>
        </div>
      </div>

      <h2>一、教练班课占用表</h2>
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>教练</th><th>班课</th><th>场地</th><th>上课节数</th><th>其中补课</th>
              <th>请假/节假日</th><th>占用半小时格</th><th>上课日期</th>
            </tr>
          </thead>
          <tbody>
            {d.coach.length === 0 && <tr><td colSpan={8} className="muted">当月无班课</td></tr>}
            {d.coach.map((r) => (
              <tr key={r.coachName + r.courseName}>
                <td>{r.coachName}</td>
                <td>{r.courseName}</td>
                <td>{r.courtName}（{COURT_TYPE_LABEL[r.courtType as keyof typeof COURT_TYPE_LABEL]}）</td>
                <td>{r.sessionsHeld}</td>
                <td>{r.makeupCount}</td>
                <td>{r.leaveCount}</td>
                <td>{r.slotsUsed}</td>
                <td className="muted" style={{ whiteSpace: "normal" }}>{r.dates.join("、")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>二、场地利用率表</h2>
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>场地</th><th>类型</th><th>开放格数</th><th>班课占用</th><th>散客已核销</th>
              <th>爽约空耗</th><th>实际利用格</th><th>利用率</th>
            </tr>
          </thead>
          <tbody>
            {d.util.map((r) => (
              <tr key={r.courtName}>
                <td>{r.courtName}</td>
                <td>{COURT_TYPE_LABEL[r.courtType as keyof typeof COURT_TYPE_LABEL]}</td>
                <td>{r.openSlots}</td>
                <td>{r.courseSlots}</td>
                <td>{r.bookingSlots}</td>
                <td>{r.noShowSlots}</td>
                <td>{r.usedSlots}</td>
                <td><strong>{pct(r.utilization)}</strong></td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">口径：开放格数 = 每日 {OPEN_FROM}–{OPEN_TO} 的半小时格 × 当月天数；利用 = 班课 + 已核销散客；爽约已冻结扣减但不计利用。</p>
      </div>

      <h2>三、会员消费与违约表</h2>
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>会员</th><th>核销扣次</th><th>爽约扣次</th><th>储值核销消费</th>
              <th>储值爽约扣</th><th>现收灯光费</th><th>违约次数</th><th>限订状态</th>
            </tr>
          </thead>
          <tbody>
            {d.members.map((r) => (
              <tr key={r.memberId}>
                <td>{r.memberName}</td>
                <td>{r.packageTimesCharged}</td>
                <td>{r.packageTimesForfeited}</td>
                <td>¥{formatYuan(r.storedSpentCents)}</td>
                <td>¥{formatYuan(r.storedForfeitedCents)}</td>
                <td>¥{formatYuan(r.lightCashCents)}</td>
                <td>{r.violations}</td>
                <td>{r.banned ? <span className="badge banned">限订至 {r.banUntil}</span> : <span className="muted">正常</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
