import type { ActionFunctionArgs, MetaFunction } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, useActionData, useLoaderData } from "@remix-run/react";
import { getDb } from "~/server/db";
import { addHoliday, deleteHoliday, listHolidays } from "~/server/catalog";
import { reexpandAll } from "~/server/courses";
import { sweepNoShows } from "~/server/violations";
import { nowLocal } from "~/server/time";

export const meta: MetaFunction = () => [{ title: "节假日与爽约" }];

export async function loader() {
  const db = getDb();
  return json({
    holidays: listHolidays(db),
    now: nowLocal().toISOString(),
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const db = getDb();
  const form = await request.formData();
  const kind = String(form.get("kind"));
  if (kind === "add-holiday") {
    // 节假日落库与全班课重排同一事务：重排撞散客单/班课时整体回滚，不留半截状态
    try {
      db.transaction(() => {
        addHoliday(db, String(form.get("date")), String(form.get("name")));
        reexpandAll(db);
      })();
    } catch (e) {
      return json({ error: `节假日未加入：${(e as Error).message}` });
    }
    return redirect("/admin?msg=" + encodeURIComponent("节假日已加入，全班课已按各自配置（顺延/补课）重排"));
  }
  if (kind === "del-holiday") {
    try {
      db.transaction(() => {
        deleteHoliday(db, String(form.get("date")));
        reexpandAll(db);
      })();
    } catch (e) {
      return json({ error: `节假日未删除：${(e as Error).message}` });
    }
    return redirect("/admin?msg=" + encodeURIComponent("节假日已删除，班课已重排"));
  }
  if (kind === "sweep") {
    const results = sweepNoShows(db);
    return redirect(
      "/admin?msg=" +
        encodeURIComponent(
          results.length === 0
            ? "爽约扫表完成：没有新爽约"
            : `爽约扫表完成：处理 ${results.length} 单（冻结不退并各记违约 1 次）：#${results.map((r) => r.bookingId).join("、#")}`,
        ),
    );
  }
  return json({ error: "未知操作" });
}

export default function AdminPage() {
  const d = useLoaderData<typeof loader>();
  const resp = useActionData<typeof action>();
  const params = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");

  return (
    <div>
      <h1>节假日 / 爽约处理</h1>
      {params.get("msg") && <div className="flash-ok">{params.get("msg")}</div>}
      {resp && "error" in resp && resp.error && (
        <div className="flash-error">{resp.error}</div>
      )}

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>法定节假日（加入后全班课自动重排：顺延班课找最近空档，补课班课周期后补）</h2>
        <Form method="post" className="row">
          <input type="hidden" name="kind" value="add-holiday" />
          <label>日期 <input type="date" name="date" required /></label>
          <label>名称 <input name="name" placeholder="如：国庆节" required /></label>
          <button type="submit">加入并重排</button>
        </Form>
        <table style={{ marginTop: 12 }}>
          <thead><tr><th>日期</th><th>名称</th><th></th></tr></thead>
          <tbody>
            {d.holidays.map((h) => (
              <tr key={h.date}>
                <td>{h.date}</td>
                <td>{h.name}</td>
                <td>
                  <Form method="post" className="inline">
                    <input type="hidden" name="kind" value="del-holiday" />
                    <input type="hidden" name="date" value={h.date} />
                    <button className="danger" type="submit">删除</button>
                  </Form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>爽约扫表</h2>
        <p className="muted">
          扫全部「待核销」单：开始时间已过 30 分钟仍未核销的，按爽约处理——次卡扣次数、储值卡扣冻结金额，记违约 1 次；自然月累计 3 次限订一周。
        </p>
        <Form method="post">
          <input type="hidden" name="kind" value="sweep" />
          <button className="danger" type="submit">立即扫表</button>
        </Form>
      </div>
    </div>
  );
}
