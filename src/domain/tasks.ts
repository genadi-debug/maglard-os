import { z } from "zod";
import { withTx, type Db } from "../db/pool.js";
import { can, type Role } from "../permissions.js";
import { ForbiddenError, isoDate, NotFoundError } from "./common.js";
import { notify } from "./notifications.js";
import { RuleError } from "./serviceRequests.js";
import { ALL, assertRecord, idsOf, TASK_SCOPE_SQL, type Scope } from "./scope.js";

export const taskInput = z.object({
  title: z.string().trim().min(1),
  description: z.string().trim().optional(),
  assigneeId: z.string().uuid().optional(), // defaults to the creator
  dueOn: isoDate.optional(),
  urgent: z.boolean().default(false),
  engagementId: z.string().uuid().optional(),
  serviceRequestId: z.string().uuid().optional(),
});

export const taskChange = z.object({
  status: z.enum(["open", "in_progress", "done"]).optional(),
  assigneeId: z.string().uuid().optional(),
  dueOn: isoDate.nullable().optional(),
  urgent: z.boolean().optional(),
});

export const noteInput = z.object({ body: z.string().trim().min(1) });

const STATUS_LABEL = { open: "פתוחה", in_progress: "בטיפול", done: "הושלמה" } as const;

type Actor = { id: string; role: Role };

export async function createTask(db: Db, actor: Actor, input: z.infer<typeof taskInput>, scope: Scope = ALL) {
  // A task can be linked only to records the person may see.
  if (input.engagementId) await assertRecord(db, scope, "engagement", input.engagementId);
  if (input.serviceRequestId) await assertRecord(db, scope, "request", input.serviceRequestId);
  return withTx(db, async (tx) => {
    const assignee = input.assigneeId ?? actor.id;
    const user = await tx.query("SELECT name FROM users WHERE id = $1 AND active", [assignee]);
    if (!user.rows[0]) throw new NotFoundError("assignee not found");
    const { rows } = await tx.query(
      `INSERT INTO tasks (title, description, assignee_id, created_by, due_on, urgent, engagement_id, service_request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        input.title,
        input.description ?? null,
        assignee,
        actor.id || null,
        input.dueOn ?? null,
        input.urgent,
        input.engagementId ?? null,
        input.serviceRequestId ?? null,
      ],
    );
    await tx.query("INSERT INTO task_notes (task_id, user_id, body, system) VALUES ($1, $2, $3, true)", [
      rows[0].id,
      actor.id || null,
      `נוצרה ושויכה ל${user.rows[0].name}`,
    ]);
    if (assignee !== actor.id) await notify(tx, [assignee], `משימה חדשה: ${input.title}`, `#/tasks/${rows[0].id}`);
    return { id: rows[0].id as string };
  });
}

// A task's assignee and creator may work on it; managers may work on any.
const mayEdit = (actor: Actor, task: { assignee_id: string; created_by: string | null }) =>
  task.assignee_id === actor.id || task.created_by === actor.id || can(actor.role, "tasks.manage_all");

export async function updateTask(db: Db, actor: Actor, id: string, change: z.infer<typeof taskChange>) {
  return withTx(db, async (tx) => {
    const { rows } = await tx.query("SELECT * FROM tasks WHERE id = $1 FOR UPDATE", [id]);
    const task = rows[0];
    if (!task) throw new NotFoundError(`task ${id} not found`);
    if (!mayEdit(actor, task)) throw new ForbiddenError("רק האחראי, מי שפתח את המשימה או מנהל יכולים לעדכן אותה");
    const notes: string[] = [];
    if (change.status && change.status !== task.status) notes.push(`סטטוס: ${STATUS_LABEL[change.status]}`);
    if (change.assigneeId && change.assigneeId !== task.assignee_id) {
      const user = await tx.query("SELECT name FROM users WHERE id = $1 AND active", [change.assigneeId]);
      if (!user.rows[0]) throw new NotFoundError("assignee not found");
      notes.push(`הועברה ל${user.rows[0].name}`);
      if (change.assigneeId !== actor.id) await notify(tx, [change.assigneeId], `הועברה אליך משימה: ${task.title}`, `#/tasks/${id}`);
    }
    if (change.dueOn !== undefined && change.dueOn !== task.due_on) notes.push(`מועד יעד: ${change.dueOn ?? "ללא"}`);
    if (change.urgent !== undefined && change.urgent !== task.urgent) notes.push(change.urgent ? "סומנה דחופה" : "לא דחופה");
    await tx.query(
      `UPDATE tasks SET status = coalesce($2, status), assignee_id = coalesce($3, assignee_id),
              due_on = CASE WHEN $4 THEN $5::date ELSE due_on END, urgent = coalesce($6, urgent),
              done_at = CASE WHEN coalesce($2, status) = 'done' THEN coalesce(done_at, now()) ELSE NULL END,
              updated_at = now()
        WHERE id = $1`,
      [id, change.status ?? null, change.assigneeId ?? null, change.dueOn !== undefined, change.dueOn ?? null, change.urgent ?? null],
    );
    for (const body of notes) {
      await tx.query("INSERT INTO task_notes (task_id, user_id, body, system) VALUES ($1, $2, $3, true)", [
        id,
        actor.id || null,
        body,
      ]);
    }
    return { ok: true };
  });
}

export async function addNote(db: Db, actor: Actor, id: string, body: string) {
  const { rows } = await db.query("SELECT assignee_id, created_by FROM tasks WHERE id = $1", [id]);
  if (!rows[0]) throw new NotFoundError(`task ${id} not found`);
  if (!mayEdit(actor, rows[0])) throw new ForbiddenError("רק האחראי, מי שפתח את המשימה או מנהל יכולים להוסיף הערה");
  await db.query("INSERT INTO task_notes (task_id, user_id, body) VALUES ($1, $2, $3)", [id, actor.id || null, body]);
  return { ok: true };
}

const TASKS = `
  SELECT t.id, t.title, t.status, t.urgent, t.due_on, t.created_at, t.done_at, t.assignee_id,
         a.name AS assignee_name, t.engagement_id, e.apartment_code, e.property_id, t.service_request_id,
         (t.status <> 'done' AND t.due_on < current_date) AS overdue
    FROM tasks t
    JOIN users a ON a.id = t.assignee_id
    LEFT JOIN engagements e ON e.id = t.engagement_id
    LEFT JOIN service_requests tr ON tr.id = t.service_request_id`;

// filter: mine | all | overdue | urgent | done. Without tasks.manage_all a
// person only ever sees their own tasks; a scoped manager sees the tasks of
// their scope and their department (domain/scope.ts).
export async function listTasks(db: Db, actor: Actor, filter: string, scope: Scope = ALL) {
  const mineOnly = filter === "mine" || !can(actor.role, "tasks.manage_all");
  const where = [
    filter === "done" ? "t.status = 'done'" : "t.status <> 'done'",
    filter === "overdue" ? "t.due_on < current_date" : "true",
    filter === "urgent" ? "(t.urgent OR t.due_on < current_date)" : "true",
  ];
  const params: unknown[] = [];
  if (mineOnly) {
    params.push(actor.id || null);
    where.push(`t.assignee_id = $${params.length}`);
  } else if (!scope.all) {
    params.push(scope.userId, idsOf(scope, "engagements"), idsOf(scope, "team"));
    const n = params.length;
    where.push(TASK_SCOPE_SQL(`$${n - 2}::uuid`, `$${n - 1}`, `$${n}::uuid[]`));
  }
  const { rows } = await db.query(
    `${TASKS} WHERE ${where.join(" AND ")} ORDER BY t.due_on NULLS LAST, t.urgent DESC, t.created_at`,
    params,
  );
  return rows;
}

export async function getTask(db: Db, actor: Actor, id: string) {
  const { rows } = await db.query(`${TASKS} WHERE t.id = $1`, [id]);
  if (!rows[0]) throw new NotFoundError(`task ${id} not found`);
  const owner = await db.query("SELECT created_by FROM tasks WHERE id = $1", [id]);
  if (!mayEdit(actor, { assignee_id: rows[0].assignee_id, created_by: owner.rows[0].created_by })) {
    throw new ForbiddenError("המשימה הזו לא שלך");
  }
  const notes = await db.query(
    `SELECT n.body, n.system, n.created_at, u.name AS user_name
       FROM task_notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.task_id = $1 ORDER BY n.id`,
    [id],
  );
  const desc = await db.query("SELECT description, created_by FROM tasks WHERE id = $1", [id]);
  return { ...rows[0], ...desc.rows[0], notes: notes.rows };
}

export { ForbiddenError, RuleError };
