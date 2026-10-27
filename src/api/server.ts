import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { z, ZodError } from "zod";
import * as auth from "../auth.js";
import { compressJson, serveAssets } from "./delivery.js";
import * as archive from "../domain/archive.js";
import * as files from "../domain/attachments.js";
import * as billing from "../domain/billing.js";
import * as invoices from "../domain/invoices.js";
import * as contacts from "../domain/contacts.js";
import { ForbiddenError } from "../domain/common.js";
import * as notifications from "../domain/notifications.js";
import type { Db } from "../db/pool.js";
import { can, isRole, permissionsOf, ROLES, type Permission } from "../permissions.js";
import { intakeInput, supplierInvoiceInput } from "../domain/schemas.js";
import * as cards from "../domain/cards.js";
import * as q from "../domain/queries.js";
import * as sr from "../domain/serviceRequests.js";
import * as tasks from "../domain/tasks.js";
import { createIntake, createSupplierInvoice, NotFoundError } from "../domain/services.js";
import type { CrmAdapter } from "../planfix/adapter.js";
import { importFromCrm } from "../sync/importer.js";
import { refreshPlanfixBilling } from "../sync/planfixBilling.js";
import { refreshPlanfixInvoices } from "../sync/planfixInvoices.js";
import * as readback from "../sync/readback.js";

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "public");
const assets: Record<string, string> = {
  "/": "index.html",
  "/app.js": "app.js",
};

// Reachable without a session: the app shell (it shows the login form), health and login.
const PUBLIC = new Set(["GET /", "GET /app.js", "GET /health", "POST /auth/login"]);

// What each route needs. `null` = any signed-in user. A route missing here is
// refused, so a new route stays closed until it is given a permission.
const ROUTES: Record<string, Permission | null> = {
  "POST /auth/logout": null,
  "GET /auth/me": null,
  "GET /contacts": null,
  "GET /work-center": null,
  "GET /engagements": "apartments.view",
  "GET /clients": "apartments.view",
  "GET /clients/:id": "apartments.view",
  "GET /properties/:id": "apartments.view",
  "GET /search": null,
  "GET /tasks": "tasks.use",
  "GET /tasks/:id": "tasks.use",
  "POST /tasks": "tasks.use",
  "POST /tasks/:id": "tasks.use",
  "POST /tasks/:id/notes": "tasks.use",
  "GET /team": "tasks.use",
  "POST /intakes": "apartments.create",
  "GET /service-requests": "requests.view",
  "GET /service-requests/:id": "requests.view",
  "POST /service-requests": "requests.manage",
  "POST /service-requests/:id/assign": "requests.manage",
  "POST /service-requests/:id/client-approval": "requests.manage",
  "POST /service-requests/:id/close": "requests.manage",
  "POST /service-requests/:id/invoice": "invoices.create",
  "GET /supplier-invoices": "invoices.view",
  "POST /supplier-invoices": "invoices.create",
  "POST /supplier-invoices/refresh": "invoices.view",
  "GET /suppliers/:id/statement": "invoices.view",
  "GET /clients/:id/billing": "billing.view",
  "POST /billing/refresh": "billing.view",
  "POST /clients/:id/charges": "billing.manage",
  "POST /clients/:id/bills": "billing.manage",
  "GET /clients/:id/rent-charges": "billing.manage",
  "POST /clients/:id/rent-charges": "billing.manage",
  "POST /clients/:id/charges/:chargeId/amount": "billing.manage",
  "POST /clients/:id/credits/:creditId/refunds": "billing.manage",
  "GET /clients/:id/bills/:billId": "billing.view",
  "GET /sync/status": "sync.view",
  "POST /sync/:id/retry": "sync.retry",
  "GET /users": "users.manage",
  "POST /users": "users.manage",
  "POST /users/:id": "users.manage",
  "GET /audit": "audit.view",
  "POST /import/planfix": "import.run",
  "GET /readback": "sync.view",
  "POST /readback/run": "sync.retry",
  "POST /readback/changes/:id": "sync.resolve",
  "POST /contacts": "contacts.manage",
  "GET /contacts/:id": "apartments.view",
  "POST /contacts/:id": "contacts.manage",
  "POST /contacts/:id/people": "contacts.manage",
  "POST /contacts/:id/people/:personId/remove": "contacts.manage",
  "POST /contacts/:id/archive": "records.archive",
  "POST /contacts/:id/delete": "records.delete",
  "POST /properties/:id/archive": "records.archive",
  "POST /properties/:id/delete": "records.delete",
  "GET /owners": "apartments.view",
  "GET /owners/:id": "apartments.view",
  "GET /suppliers": "requests.view",
  "GET /suppliers/:id": "requests.view",
  "GET /approvals": "approvals.decide",
  "POST /approvals/:id": "approvals.decide",
  "GET /settings": null,
  "POST /settings": "settings.manage",
  "GET /notifications": null,
  "POST /notifications/read": null,
  // Access to files follows the record they belong to (domain/attachments.ts).
  "GET /files/:type/:id": null,
  "POST /files/:type/:id": null,
  "GET /files/:id": null,
};

// Used when auth is switched off (tests of the screens and flows).
const SYSTEM_USER: auth.User = { id: "", email: "system", name: "system", role: "admin" };

declare module "fastify" {
  interface FastifyRequest {
    user: auth.User | null;
    auditEntity?: string;
  }
}

export function buildServer(
  db: Db,
  opts: { requireAuth?: boolean; secureCookie?: boolean; crm?: CrmAdapter } = {},
) {
  const app = Fastify({ logger: false });
  const requireAuth = opts.requireAuth ?? true;
  const cookie = (value: string, maxAge: number) =>
    `${auth.SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}` +
    (opts.secureCookie ?? true ? "; Secure" : "");

  const audit = (userId: string | null, action: string, ok: boolean, entityId?: string, detail?: object) =>
    db.query("INSERT INTO audit_log (user_id, action, entity_id, ok, detail) VALUES ($1, $2, $3, $4, $5)", [
      userId || null,
      action,
      entityId ?? null,
      ok,
      detail ?? null,
    ]);

  app.decorateRequest("user", null);

  app.addHook("onRequest", async (req, reply) => {
    if (!req.routeOptions.url) return; // unknown path: Fastify answers 404
    const route = `${req.method} ${req.routeOptions.url}`;
    if (PUBLIC.has(route)) return;
    req.user = requireAuth
      ? await auth.userForToken(db, auth.readCookie(req.headers.cookie, auth.SESSION_COOKIE))
      : SYSTEM_USER;
    if (!req.user) return reply.status(401).send({ error: "login required" });
    const needs = ROUTES[route];
    if (needs === undefined || (needs && !can(req.user.role, needs))) {
      return reply.status(403).send({ error: "אין לך הרשאה לפעולה הזו" });
    }
  });

  // The id a create returned, so the audit log can point at the new record.
  app.addHook("onSend", async (req, _reply, payload) => {
    if (req.method === "POST" && typeof payload === "string" && payload.startsWith("{")) {
      try {
        const body = JSON.parse(payload);
        req.auditEntity = body.id ?? body.engagementId ?? undefined;
      } catch {
        // not JSON; nothing to record
      }
    }
    return payload;
  });

  // Every change made through the API, allowed or refused. Bodies are not
  // stored: they can hold passwords and personal details.
  app.addHook("onResponse", async (req, reply) => {
    if (req.method === "GET" || !req.user || req.routeOptions.url === "/auth/login") return;
    const params = req.params as { id?: string };
    await audit(req.user.id, `${req.method} ${req.routeOptions.url}`, reply.statusCode < 400, params.id ?? req.auditEntity, {
      status: reply.statusCode,
    });
  });

  app.post("/auth/login", async (req, reply) => {
    const { email, password } = (req.body ?? {}) as { email?: string; password?: string };
    const session = email && password ? await auth.login(db, email, password) : null;
    await audit(session?.userId ?? null, "login", Boolean(session), undefined, { email: String(email ?? "") });
    if (!session) return reply.status(401).send({ error: "אימייל או סיסמה שגויים" });
    return reply.header("Set-Cookie", cookie(session.token, auth.SESSION_DAYS * 86400)).send({ ok: true });
  });

  app.post("/auth/logout", async (req, reply) => {
    await auth.logout(db, auth.readCookie(req.headers.cookie, auth.SESSION_COOKIE));
    return reply.header("Set-Cookie", cookie("", 0)).send({ ok: true });
  });

  app.get("/auth/me", async (req) => {
    const user = req.user!;
    return { ...user, roleLabel: ROLES[user.role], permissions: permissionsOf(user.role) };
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.status(400).send({ error: "validation", issues: err.issues });
    if (err instanceof NotFoundError) return reply.status(404).send({ error: err.message });
    if ((err as { code?: string }).code === "22P02") return reply.status(400).send({ error: "invalid id" });
    if (err instanceof sr.RuleError) return reply.status(409).send({ error: err.message });
    if (err instanceof ForbiddenError) return reply.status(403).send({ error: err.message });
    if ((err as { code?: string }).code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return reply.status(413).send({ error: "הקובץ גדול מדי (עד 10MB)" });
    }
    if ((err as { code?: string }).code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
      return reply.status(415).send({ error: "סוג קובץ לא נתמך: תמונה, PDF, Word או Excel" });
    }
    if (err instanceof auth.AuthError) return reply.status(400).send({ error: err.message });
    if ((err as { code?: string }).code === "23505") return reply.status(409).send({ error: "already exists" });
    reply.log.error(err);
    return reply.status(500).send({ error: "internal" });
  });

  app.get("/health", async () => ({ ok: true }));

  app.register(async (shell) => serveAssets(shell, publicDir, assets));
  compressJson(app);

  // Read models for the screens.
  app.get<{ Querystring: { kind?: string } }>("/contacts", async (req) => q.listContacts(db, req.query.kind));
  // Rent and invoice amounts, removed for roles that may not see them.
  const AMOUNTS = ["monthly_rent", "amount_total", "amount_net", "amount_vat"];
  const hideAmounts = <T extends object>(role: auth.User["role"], rows: T[]): T[] =>
    can(role, "amounts.view")
      ? rows
      : rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !AMOUNTS.includes(k))) as T);

  // Lists show active cards; ?archived=1 shows the archive instead.
  type ListQuery = { Querystring: { archived?: string } };
  const archivedOf = (req: { query: { archived?: string } }) => req.query.archived === "1";
  app.get<ListQuery>("/engagements", async (req) =>
    hideAmounts(req.user!.role, await q.listEngagements(db, archivedOf(req))),
  );

  app.get<ListQuery>("/clients", async (req) => cards.listClients(db, archivedOf(req)));

  // Cards: everything about one client or one property on a single screen.
  // Supplier invoices appear only for roles that see invoices.
  const cardFor = <T extends { engagements: object[]; invoices: object[] }>(role: auth.User["role"], card: T): T => ({
    ...card,
    engagements: hideAmounts(role, card.engagements),
    invoices: can(role, "invoices.view") ? hideAmounts(role, card.invoices) : [],
  });
  app.get<IdParams>("/clients/:id", async (req) => cardFor(req.user!.role, await cards.clientCard(db, req.params.id)));
  app.get<IdParams>("/properties/:id", async (req) => ({
    ...cardFor(req.user!.role, await cards.propertyCard(db, req.params.id)),
    deletable: await archive.canDelete(db, "property", req.params.id),
  }));

  app.get<{ Querystring: { q?: string } }>("/search", async (req) => ({
    hits: await cards.search(db, req.query.q ?? "", { invoices: can(req.user!.role, "invoices.view") }),
  }));
  app.get("/service-requests", async () => q.listServiceRequests(db));
  app.get<ListQuery>("/suppliers", async (req) => cards.listSuppliers(db, archivedOf(req)));

  // Client, owner and supplier cards: details, contact people, what is missing.
  const bankOf = (req: { user: auth.User | null }) => ({ bank: can(req.user!.role, "bank.view") });
  app.post("/contacts", async (req, reply) => {
    const input = contacts.newContactInput.parse(req.body);
    if (!bankOf(req).bank) for (const k of ["bankName", "bankBranch", "bankAccount"] as const) delete input[k];
    return reply.status(201).send(await contacts.createContact(db, input));
  });
  app.get<IdParams>("/contacts/:id", async (req) => ({
    ...(await contacts.getContact(db, req.params.id, bankOf(req))),
    deletable: await archive.canDelete(db, "contact", req.params.id),
  }));
  app.post<IdParams>("/contacts/:id", async (req) =>
    contacts.updateContact(db, req.params.id, contacts.contactInput.parse(req.body), bankOf(req)),
  );
  app.post<IdParams>("/contacts/:id/people", async (req, reply) =>
    reply.status(201).send(await contacts.addPerson(db, req.params.id, contacts.personInput.parse(req.body))),
  );
  app.post<{ Params: { id: string; personId: string } }>("/contacts/:id/people/:personId/remove", async (req) =>
    contacts.removePerson(db, req.params.id, req.params.personId),
  );
  // Archive and restore; delete only what was opened by mistake.
  const archiveInput = z.object({ archived: z.boolean() });
  for (const type of ["contact", "property"] as const) {
    const base = type === "contact" ? "/contacts" : "/properties";
    app.post<IdParams>(`${base}/:id/archive`, async (req) =>
      archive.setArchived(db, req.user!.id, type, req.params.id, archiveInput.parse(req.body).archived),
    );
    app.post<IdParams>(`${base}/:id/delete`, async (req) => archive.deleteRecord(db, req.user!.id, type, req.params.id));
  }
  app.get<ListQuery>("/owners", async (req) => {
    const owners = await contacts.listByKind(db, "owner", archivedOf(req));
    const { rows } = await db.query("SELECT owner_id, count(*)::int AS n FROM properties GROUP BY owner_id");
    const props = new Map(rows.map((r) => [r.owner_id, r.n]));
    return owners.map((o) => ({ ...o, properties: props.get(o.id) ?? 0 }));
  });
  app.get<IdParams>("/owners/:id", async (req) => {
    const { rows } = await db.query(
      `SELECT p.id, p.base_number, p.address,
              (SELECT c.name FROM engagements e JOIN contacts c ON c.id = e.client_id
                WHERE e.property_id = p.id ORDER BY e.starts_on DESC LIMIT 1) AS client_name
         FROM properties p WHERE p.owner_id = $1 ORDER BY p.base_number`,
      [req.params.id],
    );
    return { properties: rows };
  });
  app.get<IdParams>("/suppliers/:id", async (req) => {
    const card = await cards.supplierCard(db, req.params.id);
    const role = req.user!.role;
    return { ...card, invoices: can(role, "invoices.view") ? hideAmounts(role, card.invoices) : [] };
  });
  app.get("/supplier-invoices", async () => invoices.listSupplierInvoices(db));
  // Read the invoices entered in Planfix now, instead of at the next readback.
  app.post("/supplier-invoices/refresh", async (_req, reply) => {
    if (!opts.crm) return reply.status(503).send({ error: "Planfix is not configured" });
    return refreshPlanfixInvoices(db, opts.crm);
  });
  app.get<{ Params: { id: string }; Querystring: { month?: string } }>("/suppliers/:id/statement", async (req) => {
    const month = z.string().regex(/^\d{4}-\d{2}$/, "חודש בפורמט YYYY-MM").parse(req.query.month ?? new Date().toISOString().slice(0, 7));
    return invoices.supplierStatement(db, req.params.id, month);
  });
  // The client's billing as Planfix computes it, and a read now instead of at
  // the next readback.
  app.get<IdParams>("/clients/:id/billing", async (req) => billing.clientBilling(db, req.params.id));
  app.post("/billing/refresh", async (_req, reply) => {
    if (!opts.crm) return reply.status(503).send({ error: "Planfix is not configured" });
    return refreshPlanfixBilling(db, opts.crm);
  });
  app.post<IdParams>("/clients/:id/charges", async (req, reply) => {
    if (!opts.crm) return reply.status(503).send({ error: "Planfix is not configured" });
    const input = billing.chargeInput.parse(req.body);
    const crm = opts.crm;
    return reply
      .status(201)
      .send(await billing.once(db, input.requestKey, () => billing.createCharge(db, crm, req.user?.id || null, req.params.id, input)));
  });
  app.post<IdParams>("/clients/:id/bills", async (req, reply) => {
    if (!opts.crm) return reply.status(503).send({ error: "Planfix is not configured" });
    const input = billing.billInput.parse(req.body);
    const crm = opts.crm;
    return reply
      .status(201)
      .send(await billing.once(db, input.requestKey, () => billing.issueBill(db, crm, req.user?.id || null, req.params.id, input)));
  });
  app.get<{ Params: { id: string; billId: string } }>("/clients/:id/bills/:billId", async (req) =>
    billing.getBill(db, req.params.id, Number(req.params.billId)),
  );
  // The month's rent per contract, then opening the missing rent charges.
  app.get<{ Params: { id: string }; Querystring: { month?: string } }>("/clients/:id/rent-charges", async (req) =>
    billing.rentPlan(db, req.params.id, req.query.month ?? new Date().toISOString().slice(0, 7)),
  );
  app.post<IdParams>("/clients/:id/rent-charges", async (req, reply) => {
    if (!opts.crm) return reply.status(503).send({ error: "Planfix is not configured" });
    const { month, requestKey } = billing.rentInput.parse(req.body);
    const crm = opts.crm;
    return reply
      .status(201)
      .send(await billing.once(db, requestKey, () => billing.createRentCharges(db, crm, req.user?.id || null, req.params.id, month)));
  });
  app.post<{ Params: { id: string; chargeId: string } }>("/clients/:id/charges/:chargeId/amount", async (req, reply) => {
    if (!opts.crm) return reply.status(503).send({ error: "Planfix is not configured" });
    const input = billing.amountInput.parse(req.body);
    return billing.correctChargeAmount(db, opts.crm, req.user?.id || null, req.params.id, Number(req.params.chargeId), input);
  });
  app.post<{ Params: { id: string; creditId: string } }>("/clients/:id/credits/:creditId/refunds", async (req, reply) => {
    if (!opts.crm) return reply.status(503).send({ error: "Planfix is not configured" });
    const input = billing.refundInput.parse(req.body);
    const crm = opts.crm;
    const done = await billing.once(db, input.requestKey, () =>
      billing.recordRefund(db, crm, req.user?.id || null, req.params.id, Number(req.params.creditId), input),
    );
    return reply.status(201).send(done);
  });
  app.get("/work-center", async (req) => q.workCenter(db, req.user!));

  // Saved locally first; Planfix sync happens in the background ("saved, waiting for sync").
  app.post("/intakes", async (req, reply) => {
    const result = await createIntake(db, intakeInput.parse(req.body));
    return reply.status(201).send({ ...result, sync: "pending" });
  });

  app.post("/supplier-invoices", async (req, reply) => {
    const result = await createSupplierInvoice(db, supplierInvoiceInput.parse(req.body));
    return reply.status(201).send({ ...result, sync: "pending" });
  });

  // Paid service request: open -> assign supplier (and who pays) -> client approval
  // when the client pays -> supplier invoice -> close.
  type IdParams = { Params: { id: string } };

  app.post("/service-requests", async (req, reply) => {
    return reply.status(201).send(await sr.openRequest(db, req.user!, sr.openInput.parse(req.body)));
  });
  app.get<IdParams>("/service-requests/:id", async (req) => sr.getRequest(db, req.params.id));
  app.post<IdParams>("/service-requests/:id/assign", async (req) =>
    sr.assignSupplier(db, req.user!, req.params.id, sr.assignInput.parse(req.body)),
  );
  app.post<IdParams>("/service-requests/:id/client-approval", async (req) =>
    sr.recordClientApproval(db, req.user!, req.params.id, sr.approvalInput.parse(req.body)),
  );
  app.post<IdParams>("/service-requests/:id/invoice", async (req, reply) =>
    reply.status(201).send(await sr.addSupplierInvoice(db, req.params.id, sr.invoiceInput.parse(req.body))),
  );
  app.post<IdParams>("/service-requests/:id/close", async (req) => sr.closeRequest(db, req.params.id));

  app.post<{ Params: { id: string } }>("/sync/:id/retry", async (req, reply) => {
    const { rowCount } = await db.query(
      `UPDATE outbox SET status = 'pending', attempts = 0, run_after = now(), last_error = NULL, updated_at = now()
        WHERE id = $1 AND status = 'failed'`,
      [Number(req.params.id) || 0],
    );
    if (!rowCount) return reply.status(404).send({ error: "no failed job with that id" });
    return { status: "pending" };
  });

  app.get("/sync/status", async () => {
    const { rows } = await db.query(
      `SELECT id, job_type, entity_id, status, attempts, last_error, updated_at
         FROM outbox ORDER BY id DESC LIMIT 100`,
    );
    return { jobs: rows };
  });

  // Tasks. Everyone has their own; managers see and reassign everyone's.
  app.get<{ Querystring: { filter?: string } }>("/tasks", async (req) =>
    tasks.listTasks(db, req.user!, req.query.filter ?? "mine"),
  );
  app.get<IdParams>("/tasks/:id", async (req) => tasks.getTask(db, req.user!, req.params.id));
  app.post("/tasks", async (req, reply) =>
    reply.status(201).send(await tasks.createTask(db, req.user!, tasks.taskInput.parse(req.body))),
  );
  app.post<IdParams>("/tasks/:id", async (req) =>
    tasks.updateTask(db, req.user!, req.params.id, tasks.taskChange.parse(req.body)),
  );
  app.post<IdParams>("/tasks/:id/notes", async (req, reply) =>
    reply.status(201).send(await tasks.addNote(db, req.user!, req.params.id, tasks.noteInput.parse(req.body).body)),
  );
  // Who a task can be given to.
  app.get("/team", async () => {
    const { rows } = await db.query("SELECT id, name FROM users WHERE active ORDER BY name");
    return rows;
  });

  // Costs above the threshold, waiting for a manager.
  app.get<{ Querystring: { which?: string } }>("/approvals", async (req) =>
    sr.listApprovals(db, req.query.which === "decided" ? "decided" : "pending"),
  );
  app.post<IdParams>("/approvals/:id", async (req) =>
    sr.decideApproval(db, req.user!, req.params.id, sr.decisionInput.parse(req.body)),
  );

  app.get("/settings", async () => ({ approvalThreshold: await sr.approvalThreshold(db), vatRate: await billing.vatRate(db) }));
  // Either setting, or both.
  app.post("/settings", async (req, reply) => {
    const body = (req.body ?? {}) as { approvalThreshold?: unknown; vatRate?: unknown };
    const checks = [
      ["approvalThreshold", "approval_threshold", "סף האישור צריך להיות מספר", (n: number) => n >= 0],
      ["vatRate", "vat_rate", "שיעור המע״מ צריך להיות בין 0 ל־100", (n: number) => n >= 0 && n <= 100],
    ] as const;
    const given = checks.filter(([k]) => body[k] !== undefined);
    if (!given.length) return reply.status(400).send({ error: "אין מה לשמור" });
    for (const [k, , error, ok] of given) {
      const v = body[k];
      if (typeof v !== "number" || !ok(v)) return reply.status(400).send({ error });
    }
    for (const [k, key] of given) {
      await db.query(
        `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_by = $3, updated_at = now()`,
        [key, JSON.stringify(body[k]), req.user!.id || null],
      );
    }
    return Object.fromEntries(given.map(([k]) => [k, body[k]]));
  });

  app.get("/notifications", async (req) => notifications.listNotifications(db, req.user!.id));
  app.post("/notifications/read", async (req) => {
    const { id } = (req.body ?? {}) as { id?: number };
    await notifications.markRead(db, req.user!.id, typeof id === "number" ? id : undefined);
    return { ok: true };
  });

  // Files. The body is the file itself; its name travels in X-Filename.
  app.addContentTypeParser([...files.MIME_TYPES], { parseAs: "buffer", bodyLimit: files.MAX_BYTES }, (_req, body, done) =>
    done(null, body),
  );
  type FileParams = { Params: { type: string; id: string } };
  const entityType = (type: string) => {
    if (!files.isEntityType(type)) throw new NotFoundError(`no files for ${type}`);
    return type;
  };
  app.get<FileParams>("/files/:type/:id", async (req) =>
    files.listAttachments(db, req.user!, entityType(req.params.type), req.params.id),
  );
  app.post<FileParams>("/files/:type/:id", async (req, reply) => {
    const mime = String(req.headers["content-type"] ?? "").split(";")[0].trim();
    if (!Buffer.isBuffer(req.body) || !(files.MIME_TYPES as readonly string[]).includes(mime)) {
      return reply.status(415).send({ error: "סוג קובץ לא נתמך: תמונה, PDF, Word או Excel" });
    }
    if (!req.body.length) return reply.status(400).send({ error: "הקובץ ריק" });
    const raw = String(req.headers["x-filename"] ?? "file");
    let filename: string;
    try {
      filename = decodeURIComponent(raw);
    } catch {
      filename = raw;
    }
    filename = filename.replace(/[\\/\r\n"]/g, "_").slice(0, 200) || "file";
    const type = entityType(req.params.type);
    return reply.status(201).send(await files.addAttachment(db, req.user!, type, req.params.id, { filename, mime, data: req.body }));
  });
  app.get<IdParams>("/files/:id", async (req, reply) => {
    const f = await files.readAttachment(db, req.user!, req.params.id);
    // Photos and PDFs open in the browser; other documents download.
    const image = f.mime.startsWith("image/");
    const inline = image || f.mime === "application/pdf";
    if (image) reply.header("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self'");
    return reply
      .type(f.mime)
      .header("X-Content-Type-Options", "nosniff")
      .header("Cache-Control", "private, max-age=3600")
      .header(
        "Content-Disposition",
        `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(f.filename)}`,
      )
      .send(f.data);
  });

  // Users and roles (admin only).
  app.get("/users", async () => ({ users: await auth.listUsers(db), roles: ROLES }));

  app.post("/users", async (req, reply) => {
    const { email, name, password, role } = (req.body ?? {}) as Record<string, string>;
    if (!email || !name || !password || !isRole(role)) {
      return reply.status(400).send({ error: "צריך אימייל, שם, סיסמה ותפקיד" });
    }
    return reply.status(201).send({ id: await auth.createUser(db, email, name, password, role) });
  });

  app.post<IdParams>("/users/:id", async (req, reply) => {
    const { role, active, password } = (req.body ?? {}) as { role?: string; active?: boolean; password?: string };
    // An admin cannot lock themselves out.
    if (req.params.id === req.user!.id && (active === false || (role !== undefined && role !== "admin"))) {
      return reply.status(409).send({ error: "אי אפשר להוריד לעצמך הרשאת מנהל או לחסום את עצמך" });
    }
    if (role !== undefined && !isRole(role)) return reply.status(400).send({ error: "תפקיד לא מוכר" });
    const found = await auth.updateUser(db, req.params.id, { role, active, password });
    if (!found) return reply.status(404).send({ error: "user not found" });
    return { ok: true };
  });

  // Import of existing apartments from Planfix. A dry run reports what would
  // change and writes nothing.
  app.post("/import/planfix", async (req, reply) => {
    if (!opts.crm) return reply.status(503).send({ error: "Planfix is not configured" });
    const { dryRun } = (req.body ?? {}) as { dryRun?: boolean };
    return importFromCrm(db, opts.crm, { dryRun: dryRun !== false });
  });

  // Changes made directly in Planfix: what was applied, and what waits for a person.
  app.get("/readback", async () => readback.readbackStatus(db));
  app.post("/readback/run", async (_req, reply) => {
    if (!opts.crm) return reply.status(503).send({ error: "Planfix is not configured" });
    return readback.runReadback(db, opts.crm);
  });
  app.post<IdParams>("/readback/changes/:id", async (req, reply) => {
    const { choice } = (req.body ?? {}) as { choice?: string };
    if (choice !== "remote" && choice !== "local") return reply.status(400).send({ error: "choice must be remote or local" });
    return readback.resolveChange(db, req.user!.id, Number(req.params.id) || 0, choice);
  });

  app.get<{ Querystring: { limit?: string } }>("/audit", async (req) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const { rows } = await db.query(
      `SELECT a.id, a.action, a.entity_id, a.ok, a.detail, a.created_at, u.name AS user_name
         FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
        ORDER BY a.id DESC LIMIT $1`,
      [limit],
    );
    return { entries: rows };
  });

  return app;
}
