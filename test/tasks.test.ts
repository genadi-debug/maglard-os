import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import { createUser } from "../src/auth.js";
import { migrate } from "../src/db/migrate.js";
import { createPool } from "../src/db/pool.js";

const url = process.env.TEST_DATABASE_URL;
const PASSWORD = "a-long-password";
const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

describe.skipIf(!url)("tasks and the work center", () => {
  const db = createPool(url ?? "");
  const app = buildServer(db);
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};
  const call = (who: string, method: "GET" | "POST", path: string, payload?: object) =>
    app.inject({ method, url: path, payload, headers: { cookie: cookies[who] } });

  beforeAll(async () => {
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
    await migrate(db);
    for (const [who, role] of [
      ["boss", "dept_manager"],
      ["dana", "operations"],
      ["avi", "operations"],
      ["ceo", "management"],
    ] as const) {
      ids[who] = await createUser(db, `${who}@example.com`, who, PASSWORD, role);
      const res = await app.inject({ method: "POST", url: "/auth/login", payload: { email: `${who}@example.com`, password: PASSWORD } });
      cookies[who] = String(res.headers["set-cookie"]).split(";")[0];
    }
  });
  afterAll(async () => {
    await app.close();
    await db.end();
  });

  it("creates tasks for myself by default and for others when assigned", async () => {
    const mine = await call("dana", "POST", "/tasks", { title: "להתקשר לדייר", dueOn: day(0) });
    expect(mine.statusCode).toBe(201);
    await call("boss", "POST", "/tasks", { title: "לבדוק מונה", assigneeId: ids.dana, dueOn: day(-2) });
    await call("boss", "POST", "/tasks", { title: "דחוף: נזילה", assigneeId: ids.avi, urgent: true });
    const list = (await call("dana", "GET", "/tasks")).json();
    expect(list.map((t: any) => [t.title, t.overdue])).toEqual([
      ["לבדוק מונה", true],
      ["להתקשר לדייר", false],
    ]);
  });

  it("shows a worker only their own tasks, a manager everyone's", async () => {
    expect((await call("dana", "GET", "/tasks?filter=all")).json()).toHaveLength(2);
    expect((await call("boss", "GET", "/tasks?filter=all")).json()).toHaveLength(3);
    const aviTask = (await call("boss", "GET", "/tasks?filter=all")).json().find((t: any) => t.assignee_id === ids.avi);
    expect((await call("dana", "GET", `/tasks/${aviTask.id}`)).statusCode).toBe(403);
    expect((await call("dana", "POST", `/tasks/${aviTask.id}`, { status: "done" })).statusCode).toBe(403);
  });

  it("records status, reassignment and notes in the task's history", async () => {
    const t = (await call("dana", "GET", "/tasks")).json()[0];
    await call("dana", "POST", `/tasks/${t.id}`, { status: "in_progress" });
    await call("dana", "POST", `/tasks/${t.id}/notes`, { body: "הדייר לא ענה, אנסה מחר" });
    await call("boss", "POST", `/tasks/${t.id}`, { assigneeId: ids.avi });
    const full = (await call("boss", "GET", `/tasks/${t.id}`)).json();
    expect(full.notes.map((n: any) => n.body)).toEqual([
      "נוצרה ושויכה לdana",
      "סטטוס: בטיפול",
      "הדייר לא ענה, אנסה מחר",
      "הועברה לavi",
    ]);
    await call("avi", "POST", `/tasks/${t.id}`, { status: "done" });
    expect((await call("boss", "GET", `/tasks/${t.id}`)).json().done_at).not.toBeNull();
  });

  it("fills the work center by role", async () => {
    const dana = (await call("dana", "GET", "/work-center")).json();
    expect(dana.counts).toMatchObject({ my_today: 1, my_open: 1 });
    expect(dana).not.toHaveProperty("workload");
    expect(dana).not.toHaveProperty("company");

    const avi = (await call("avi", "GET", "/work-center")).json();
    expect(avi.counts).toMatchObject({ my_urgent: 1, my_open: 1 });

    const boss = (await call("boss", "GET", "/work-center")).json();
    expect(boss.workload.find((w: any) => w.name === "avi")).toMatchObject({ open: 1, done_30d: 1 });
    expect(boss).not.toHaveProperty("company");

    const ceo = (await call("ceo", "GET", "/work-center")).json();
    expect(ceo.company).toMatchObject({ active_properties: 0, ending: [] });
  });
});
