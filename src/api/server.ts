import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { ZodError } from "zod";
import * as auth from "../auth.js";
import type { Db } from "../db/pool.js";
import { can, isRole, permissionsOf, ROLES, type Permission } from "../permissions.js";
import { intakeInput, supplierInvoiceInput } from "../domain/schemas.js";
import * as cards from "../domain/cards.js";
import * as q from "../domain/queries.js";
import * as sr from "../domain/serviceRequests.js";
import { createIntake, createSupplierInvoice, NotFoundError } from "../domain/services.js";
import type { CrmAdapter } from "../planfix/adapter.js";
import { importFromCrm } from "../sync/importer.js";

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "public");
const assets: Record<string, string> = {
  "/": "index.html",
  "/app.js": "app.js",
};
const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

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
  "GET /sync/status": "sync.view",
  "POST /sync/:id/retry": "sync.retry",
  "GET /users": "users.manage",
  "POST /users": "users.manage",
  "POST /users/:id": "users.manage",
  "GET /audit": "audit.view",
  "POST /import/planfix": "import.run",
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
    if (err instanceof auth.AuthError) return reply.status(400).send({ error: err.message });
    if ((err as { code?: string }).code === "23505") return reply.status(409).send({ error: "already exists" });
    reply.log.error(err);
    return reply.status(500).send({ error: "internal" });
  });

  app.get("/health", async () => ({ ok: true }));

  for (const [route, file] of Object.entries(assets)) {
    app.get(route, async (_req, reply) =>
      reply.type(types[path.extname(file)]).send(await readFile(path.join(publicDir, file), "utf8")),
    );
  }

  // Read models for the screens.
  app.get<{ Querystring: { kind?: string } }>("/contacts", async (req) => q.listContacts(db, req.query.kind));
  // Rent and invoice amounts, removed for roles that may not see them.
  const AMOUNTS = ["monthly_rent", "amount_total", "amount_net", "amount_vat"];
  const hideAmounts = <T extends object>(role: auth.User["role"], rows: T[]): T[] =>
    can(role, "amounts.view")
      ? rows
      : rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !AMOUNTS.includes(k))) as T);

  app.get("/engagements", async (req) => hideAmounts(req.user!.role, await q.listEngagements(db)));

  app.get("/clients", async () => cards.listClients(db));

  // Cards: everything about one client or one property on a single screen.
  // Supplier invoices appear only for roles that see invoices.
  const cardFor = <T extends { engagements: object[]; invoices: object[] }>(role: auth.User["role"], card: T): T => ({
    ...card,
    engagements: hideAmounts(role, card.engagements),
    invoices: can(role, "invoices.view") ? hideAmounts(role, card.invoices) : [],
  });
  app.get<IdParams>("/clients/:id", async (req) => cardFor(req.user!.role, await cards.clientCard(db, req.params.id)));
  app.get<IdParams>("/properties/:id", async (req) =>
    cardFor(req.user!.role, await cards.propertyCard(db, req.params.id)),
  );

  app.get<{ Querystring: { q?: string } }>("/search", async (req) => ({
    hits: await cards.search(db, req.query.q ?? "", { invoices: can(req.user!.role, "invoices.view") }),
  }));
  app.get("/service-requests", async () => q.listServiceRequests(db));
  app.get("/supplier-invoices", async () => q.listSupplierInvoices(db));
  app.get("/work-center", async () => q.workCenter(db));

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
    return reply.status(201).send(await sr.openRequest(db, sr.openInput.parse(req.body)));
  });
  app.get<IdParams>("/service-requests/:id", async (req) => sr.getRequest(db, req.params.id));
  app.post<IdParams>("/service-requests/:id/assign", async (req) =>
    sr.assignSupplier(db, req.params.id, sr.assignInput.parse(req.body)),
  );
  app.post<IdParams>("/service-requests/:id/client-approval", async (req) =>
    sr.recordClientApproval(db, req.params.id, sr.approvalInput.parse(req.body)),
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
