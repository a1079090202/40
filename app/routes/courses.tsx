import type { ActionFunctionArgs, MetaFunction } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, useActionData, useLoaderData } from "@remix-run/react";
import { getDb } from "~/server/db";
import { listCoaches, listCourts } from "~/server/catalog";
import {
  CourseError,
  createCourse,
  listCourseSessions,
  listCourses,
  setCourseLeave,
} from "~/server/courses";
import { COURT_TYPE_LABEL } from "~/server/config";

export const meta: MetaFunction = () => [{ title: "教练班课" }];

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export async function loader() {
  const db = getDb();
  const courses = listCourses(db) as Array<{
    id: number; name: string; coach_name: string; court_name: string; court_id: number;
    weekday: number; start_time: string; end_time: string; start_date: string; weeks: number;
    holiday_policy: string;
  }>;
  const sessions = courses.map((c) => ({
    courseId: c.id,
    list: listCourseSessions(db, c.id) as Array<{
      id: number; seq: number; date: string; start_time: string; end_time: string;
      state: string; orig_date: string | null; note: string | null;
    }>,
  }));
  return json({
    courses,
    sessions,
    coaches: listCoaches(db),
    courts: listCourts(db),
    weekdays: WEEKDAYS,
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const db = getDb();
  const form = await request.formData();
  try {
    if (form.get("kind") === "create") {
      createCourse(db, {
        name: String(form.get("name")),
        coachId: Number(form.get("coachId")),
        courtId: Number(form.get("courtId")),
        weekday: Number(form.get("weekday")),
        startTime: String(form.get("startTime")),
        endTime: String(form.get("endTime")),
        startDate: String(form.get("startDate")),
        weeks: Number(form.get("weeks")),
        holidayPolicy: String(form.get("holidayPolicy")) as "postpone" | "makeup",
      });
      return redirect("/courses?msg=" + encodeURIComponent("周期班课已创建，场次已批量排入"));
    }
    if (form.get("kind") === "leave") {
      setCourseLeave(db, Number(form.get("courseId")), String(form.get("date")), true);
      return redirect("/courses?msg=" + encodeURIComponent("已登记整段请假并重新排班"));
    }
    if (form.get("kind") === "unleave") {
      setCourseLeave(db, Number(form.get("courseId")), String(form.get("date")), false);
      return redirect("/courses?msg=" + encodeURIComponent("已取消请假并重新排班"));
    }
  } catch (e) {
    return json({ error: (e as CourseError).message });
  }
  return json({ error: "未知操作" });
}

export default function CoursesPage() {
  const data = useLoaderData<typeof loader>();
  const resp = useActionData<typeof action>();
  const params = new URLSearchParams(
    typeof window !== "undefined" ? window.location.search : "",
  );

  return (
    <div>
      <h1>教练班课</h1>
      {params.get("msg") && <div className="flash-ok">{params.get("msg")}</div>}
      {resp && "error" in resp && resp.error && (
        <div className="flash-error">{resp.error}</div>
      )}

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>新建周期班课（批量占场）</h2>
        <Form method="post" className="row">
          <input type="hidden" name="kind" value="create" />
          <label>班名 <input name="name" required placeholder="如：周末羽毛球基础班" /></label>
          <label>教练
            <select name="coachId">
              {data.coaches.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label>场地
            <select name="courtId">
              {data.courts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}（{COURT_TYPE_LABEL[c.type as keyof typeof COURT_TYPE_LABEL]}）
                </option>
              ))}
            </select>
          </label>
          <label>星期
            <select name="weekday" defaultValue={2}>
              {WEEKDAYS.map((w, i) => <option key={w} value={i}>{w}</option>)}
            </select>
          </label>
          <label>起 <input type="time" name="startTime" step={1800} defaultValue="19:00" /></label>
          <label>止 <input type="time" name="endTime" step={1800} defaultValue="21:00" /></label>
          <label>首次课日期 <input type="date" name="startDate" defaultValue="2026-09-15" /></label>
          <label>周数 <input type="number" name="weeks" min={1} defaultValue={12} style={{ width: 70 }} /></label>
          <label>遇节假日
            <select name="holidayPolicy">
              <option value="postpone">顺延（之后第一个空档）</option>
              <option value="makeup">补课（周期结束后同星期补）</option>
            </select>
          </label>
          <button type="submit">建班并占场</button>
        </Form>
      </div>

      {data.courses.map((c, idx) => {
        const s = data.sessions[idx]!.list;
        return (
          <div className="panel" key={c.id}>
            <h2 style={{ marginTop: 0 }}>
              {c.name}{" "}
              <span className="muted">
                — {c.coach_name} · {c.court_name} · 每周{WEEKDAYS[c.weekday]} {c.start_time}–{c.end_time} ·{" "}
                {c.weeks} 周 · {c.holiday_policy === "postpone" ? "顺延" : "补课"} · 起 {c.start_date}
              </span>
            </h2>
            <table>
              <thead>
                <tr><th>节</th><th>日期</th><th>星期</th><th>时段</th><th>状态</th><th>说明</th><th>请假</th></tr>
              </thead>
              <tbody>
                {s.map((x) => (
                  <tr key={x.id}>
                    <td>第 {x.seq} 节</td>
                    <td>{x.date}</td>
                    <td>{WEEKDAYS[new Date(x.date + "T00:00:00").getDay()]}</td>
                    <td>{x.start_time}–{x.end_time}</td>
                    <td>
                      <span className={`badge ${x.state}`}>
                        {x.state === "scheduled" ? "正常/顺延" : x.state === "makeup" ? "补课" : "请假"}
                      </span>
                    </td>
                    <td className="muted">{x.note ?? (x.orig_date && x.state === "scheduled" ? `原 ${x.orig_date}` : "")}</td>
                    <td>
                      {x.state !== "leave" ? (
                        <Form method="post" className="inline">
                          <input type="hidden" name="kind" value="leave" />
                          <input type="hidden" name="courseId" value={c.id} />
                          <input type="hidden" name="date" value={x.date} />
                          <button className="ghost" type="submit">整段请假</button>
                        </Form>
                      ) : (
                        <Form method="post" className="inline">
                          <input type="hidden" name="kind" value="unleave" />
                          <input type="hidden" name="courseId" value={c.id} />
                          <input type="hidden" name="date" value={x.date} />
                          <button className="ghost" type="submit">撤销请假</button>
                        </Form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}
