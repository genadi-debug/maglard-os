import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { z, ZodError } from "zod";
import * as auth from "../auth.js";
import { compressJson, serveAssets } from "./delivery.js";
import * as archive from "../domain/archive.js";
import * as files from "../domain/attachments.js";
import * as billing from "../domain/billing.js";
import * as expense from "../domain/expenseCharge.js";
import * as edit from "../domain/propertyEdit.js";
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
import { engagementFixInput, fixSkippedEngagement, importFromCrm } from "../sync/importer.js";
import { importSheet, readSheet, sheetImportInput, type FetchText } from "../sync/sheetImport.js";
import { refreshPlanfixBilling } from "../sync/planfixBilling.js";
import { refreshPlanfixInvoices } from "../sync/planfixInvoices.js";
import * as readback from "../sync/readback.js";
import * as ops from "../sync/operations.js";
import { PlanfixError } from "../planfix/client.js";
import * as access from "../domain/access.js";
import { serviceFile } from "../domain/serviceFile.js";
import { assertEntity, assertRecord, assertSees, idsOf, OUT_OF_SCOPE, scopeOf, type Scope } from "../domain/scope.js";

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "public");
const assets: Record<string, string> = {
  "/": "index.html",
  "/app.js": "app.js",
};

// Reachable without a session: the app shell (it shows the login form), health and login.
const PUBLIC = new Set(["GET /", "GET /app.js", "GET /health", "POST /auth/login"]);

// What each route needs. `null` = any signed-in user. A route missing here is
// refused, so a new route stays closed until it is given a permission.
export const ROUTES: Record<string, Permission | null> = {
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
  "GET /service-requests/:id/file": "invoices.view",
  "POST /service-requests": "requests.manage",
  "POST /service-requests/:id/assign": "requests.manage",
  "POST /service-requests/:id/client-approval": "requests.manage",
  "POST /service-requests/:id/close": "requests.manage",
  "POST /service-requests/:id/invoice": "invoices.create",
  "POST /service-requests/:id/invoice-review": "requests.manage",
  "GET /supplier-invoices": "invoices.view",
  "POST /supplier-invoices": "invoices.create",
  "POST /supplier-invoices/refresh": "invoices.view",
  "GET /suppliers/:id/statement": "invoices.view",
  "GET /clients/:id/billing": "billing.view",
  "POST /billing/refresh": "billing.view",
  "POST /clients/:id/charges": "billing.manage",
  "GET /supplier-invoices/:ref/charge": "billing.manage",
  "POST /supplier-invoices/:ref/charge": "billing.manage",
  "POST /clients/:id/bills": "billing.manage",
  "GET /clients/:id/rent-charges": "billing.manage",
  "POST /clients/:id/rent-charges": "billing.manage",
  "GET /clients/:id/rent-bill": "billing.manage",
  "POST /clients/:id/rent-bill": "billing.manage",
  "POST /clients/:id/charges/:chargeId/amount": "billing.manage",
  "POST /clients/:id/contracts/:contractId/price": "billing.manage",
  "POST /clients/:id/credits/:creditId/refunds": "billing.manage",
  "GET /clients/:id/bills/:billId": "billing.view",
  "POST /clients/:id/bills/:billId/cancel": "billing.manage",
  "GET /sync/status": "sync.view",
  "GET /sync/operations": "sync.view",
  "POST /sync/operations/:id/lookup": "sync.resolve",
  "POST /sync/operations/:id/decide": "sync.resolve",
  "POST /sync/:id/retry": "sync.retry",
  "GET /users": "users.manage",
  "POST /users": "users.manage",
  "POST /users/:id": "users.manage",
  "GET /audit": "audit.view",
  "POST /import/planfix": "import.run",
  "POST /import/engagements/:taskId": "import.run",
  "POST /import/contacts/sheet": "import.run",
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
  "POST /properties/:id": "apartments.create",
  "POST /engagements/:id": "apartments.create",
  "POST /properties/:id/archive": "records.archive",
  "POST /properties/:id/delete": "records.delete",
  "POST /bulk/archive": "records.archive",
  "POST /bulk/delete": "records.delete",
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
  "GET /access": "users.manage",
  "GET /access/users/:id": "users.manage",
  "POST /access/users/:id": "users.manage",
  "POST /access/grants": "users.manage",
  "POST /access/grants/:id/remove": "users.manage",
  "POST /departments": "users.manage",
  "POST /departments/:id": "users.manage",
};

// How each route is held to a scoped user's access scope (domain/scope.ts),
// on top of the role's permission above. A route missing here is refused to
// scoped users, so a new route stays closed to them until it is placed.
//   "free"     - not about scoped records (the session, settings, notifications);
//   "company"  - a company-wide screen: refused to scoped users;
//   "filtered" - the handler lists only what is in scope;
//   "body"     - the handler checks the records named in the body;
//   a function - checks the record named in the path before the handler runs.
type Params = Record<string, string>;
type Guard = "free" | "company" | "filtered" | "body" | ((db: Db, scope: Scope, p: Params) => Promise<void>);
const byId =
  (kind: Parameters<typeof assertRecord>[2], param = "id"): Guard =>
  (db, scope, p) =>
    assertRecord(db, scope, kind, p[param]);
// Charging a supplier invoice on to its client is client-wide money: the
// client must be granted as a whole.
const chargeGuard: Guard = async (db, scope, p) => {
  await assertRecord(db, scope, "invoice_ref", p.ref);
  const { rows } = await db.query(
    p.ref.startsWith("planfix:")
      ? "SELECT e.client_id FROM planfix_invoices f JOIN engagements e ON e.planfix_task_id = f.engagement_task_id WHERE f.planfix_task_id = $1"
      : "SELECT e.client_id FROM supplier_invoices i JOIN engagements e ON e.id = i.engagement_id WHERE i.id = $1",
    [p.ref.startsWith("planfix:") ? Number(p.ref.slice(8)) : p.ref],
  );
  assertSees(scope, "fullClients", rows[0]?.client_id);
};
const clientFull = byId("client_full");

export const SCOPE: Record<string, Guard> = {
  "POST /auth/logout": "free",
  "GET /auth/me": "free",
  "GET /contacts": "filtered",
  "GET /work-center": "filtered",
  "GET /engagements": "filtered",
  "GET /clients": "filtered",
  "GET /clients/:id": byId("client"),
  "GET /properties/:id": byId("property"),
  "GET /search": "filtered",
  "GET /tasks": "filtered",
  "GET /tasks/:id": byId("task"),
  "POST /tasks": "body",
  "POST /tasks/:id": byId("task"),
  "POST /tasks/:id/notes": byId("task"),
  "GET /team": "free",
  "POST /intakes": "body",
  "GET /service-requests": "filtered",
  "GET /service-requests/:id": byId("request"),
  "GET /service-requests/:id/file": byId("request"),
  "POST /service-requests": "body",
  "POST /service-requests/:id/assign": byId("request"),
  "POST /service-requests/:id/client-approval": byId("request"),
  "POST /service-requests/:id/close": byId("request"),
  "POST /service-requests/:id/invoice": byId("request"),
  "POST /service-requests/:id/invoice-review": byId("request"),
  "GET /supplier-invoices": "filtered",
  "POST /supplier-invoices": "body",
  "POST /supplier-invoices/refresh": "company",
  "GET /suppliers/:id/statement": "filtered",
  "GET /clients/:id/billing": clientFull,
  "POST /billing/refresh": "company",
  "POST /clients/:id/charges": clientFull,
  "GET /supplier-invoices/:ref/charge": chargeGuard,
  "POST /supplier-invoices/:ref/charge": chargeGuard,
  "POST /clients/:id/bills": clientFull,
  "GET /clients/:id/rent-charges": clientFull,
  "POST /clients/:id/rent-charges": clientFull,
  "GET /clients/:id/rent-bill": clientFull,
  "POST /clients/:id/rent-bill": clientFull,
  "POST /clients/:id/charges/:chargeId/amount": clientFull,
  "POST /clients/:id/contracts/:contractId/price": clientFull,
  "POST /clients/:id/credits/:creditId/refunds": clientFull,
  "GET /clients/:id/bills/:billId": clientFull,
  "POST /clients/:id/bills/:billId/cancel": clientFull,
  "GET /sync/status": "company",
  "GET /sync/operations": "company",
  "POST /sync/operations/:id/lookup": "company",
  "POST /sync/operations/:id/decide": "company",
  "POST /sync/:id/retry": "company",
  "GET /users": "company",
  "POST /users": "company",
  "POST /users/:id": "company",
  "GET /audit": "company",
  "POST /import/planfix": "company",
  "POST /import/engagements/:taskId": "company",
  "POST /import/contacts/sheet": "company",
  "GET /readback": "company",
  "POST /readback/run": "company",
  "POST /readback/changes/:id": "company",
  "POST /contacts": "body",
  "GET /contacts/:id": byId("contact"),
  "POST /contacts/:id": byId("contact"),
  "POST /contacts/:id/people": byId("contact"),
  "POST /contacts/:id/people/:personId/remove": byId("contact"),
  "POST /contacts/:id/archive": byId("contact"),
  "POST /contacts/:id/delete": byId("contact"),
  "POST /properties/:id": byId("property"),
  "POST /engagements/:id": byId("engagement"),
  "POST /properties/:id/archive": byId("property"),
  "POST /properties/:id/delete": byId("property"),
  "POST /bulk/archive": "body",
  "POST /bulk/delete": "body",
  "GET /owners": "filtered",
  "GET /owners/:id": byId("owner"),
  "GET /suppliers": "filtered",
  "GET /suppliers/:id": "filtered",
  "GET /approvals": "filtered",
  "POST /approvals/:id": byId("approval"),
  "GET /settings": "free",
  "POST /settings": "company",
  "GET /notifications": "free",
  "POST /notifications/read": "free",
  "GET /files/:type/:id": (db, scope, p) => assertEntity(db, scope, p.type, p.id),
  "POST /files/:type/:id": (db, scope, p) => assertEntity(db, scope, p.type, p.id),
  "GET /files/:id": byId("attachment"),
  "GET /access": "company",
  "GET /access/users/:id": "company",
  "POST /access/users/:id": "company",
  "POST /access/grants": "company",
  "POST /access/grants/:id/remove": "company",
  "POST /departments": "company",
  "POST /departments/:id": "company",
};
const COMPANY_ONLY = "המסך הזה כולל נתונים של כל החברה, ולכן הוא לא זמין למשתמש עם תחום אחריות מוגדר";

// Used when auth is switched off (tests of the screens and flows).
const SYSTEM_USER: auth.User = { id: "", email: "system", name: "system", role: "admin" };

declare module "fastify" {
  interface FastifyRequest {
    user: auth.User | null;
    // The user's access scope, loaded with the session (domain/scope.ts).
    scope: Scope;
    auditEntity?: string;
  }
}

const decideInput = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("found"), planfixId: z.number().int().positive(), note: z.string().trim().min(2, "צריך לכתוב מה נבדק") }),
  z.object({ decision: z.literal("not_created"), note: z.string().trim().min(2, "צריך לכתוב מה נבדק") }),
]);

export function buildServer(
  db: Db,
  opts: {
    requireAuth?: boolean;
    secureCookie?: boolean;
    crm?: CrmAdapter;
    fetchSheet?: FetchText;
    // For links to Planfix, from the sync's own setting (see config.ts).
    planfixWebUrl?: string | null;
  } = {},
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
  app.decorateRequest("scope", null as unknown as { all: true });

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
    // Then the scope: which records, for a user limited to some of them.
    req.scope = await scopeOf(db, req.user);
    if (!req.scope.all) {
      const guard = SCOPE[route];
      if (guard === undefined || guard === "company") return reply.status(403).send({ error: COMPANY_ONLY });
      if (typeof guard === "function") await guard(db, req.scope, req.params as Params);
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
    return { ...user, roleLabel: ROLES[user.role], permissions: permissionsOf(user.role), planfixUrl: opts.planfixWebUrl ?? null };
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) return reply.status(400).send({ error: "validation", issues: err.issues });
    // To a scoped user, a record that is not there and one outside the scope
    // look the same.
    if (err instanceof NotFoundError) {
      return reply.status(404).send({ error: req.scope && !req.scope.all ? OUT_OF_SCOPE : err.message });
    }
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
    if (err instanceof PlanfixError) {
      const text: Record<string, string> = {
        auth: "Planfix סירב לגישה (הרשאה או מפתח). צריך לבדוק את הגדרות החיבור.",
        rate_limit: "Planfix עמוס כרגע. כדאי לנסות שוב בעוד דקה.",
        validation: `Planfix לא קיבל את הבקשה: ${err.message}`,
      };
      const message =
        text[err.kind] ??
        (err.outcome === "unknown"
          ? "לא ידוע אם הפעולה בוצעה ב־Planfix. כדאי לבדוק במסך הסנכרון או ב־Planfix לפני ששולחים שוב."
          : "אין חיבור ל־Planfix כרגע. שום דבר לא נשלח; אפשר לנסות שוב.");
      return reply.status(502).send({ error: message, outcome: err.outcome });
    }
    if ((err as { code?: string }).code === "23505") return reply.status(409).send({ error: "already exists" });
    reply.log.error(err);
    return reply.status(500).send({ error: "internal" });
  });

  app.get("/health", async () => ({ ok: true }));

  app.register(async (shell) => serveAssets(shell, publicDir, assets));
  compressJson(app);

  // Read models for the screens.
  app.get<{ Querystring: { kind?: string } }>("/contacts", async (req) => q.listContacts(db, req.query.kind, req.scope));
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
    hideAmounts(req.user!.role, await q.listEngagements(db, archivedOf(req), req.scope)),
  );

  app.get<ListQuery>("/clients", async (req) => cards.listClients(db, archivedOf(req), req.scope));

  // Cards: everything about one client or one property on a single screen.
  // Supplier invoices appear only for roles that see invoices.
  const cardFor = <T extends { engagements: object[]; invoices: object[] }>(role: auth.User["role"], card: T): T => ({
    ...card,
    engagements: hideAmounts(role, card.engagements),
    invoices: can(role, "invoices.view") ? hideAmounts(role, card.invoices) : [],
  });
  app.get<IdParams>("/clients/:id", async (req) => cardFor(req.user!.role, await cards.clientCard(db, req.params.id, req.scope)));
  app.get<IdParams>("/properties/:id", async (req) => ({
    ...cardFor(req.user!.role, await cards.propertyCard(db, req.params.id, req.scope)),
    deletable: await archive.canDelete(db, "property", req.params.id),
  }));

  app.get<{ Querystring: { q?: string } }>("/search", async (req) => ({
    hits: await cards.search(db, req.query.q ?? "", { invoices: can(req.user!.role, "invoices.view") }, req.scope),
  }));
  app.get("/service-requests", async (req) => q.listServiceRequests(db, req.scope));
  app.get<ListQuery>("/suppliers", async (req) => cards.listSuppliers(db, archivedOf(req), req.scope));

  // Client, owner and supplier cards: details, contact people, what is missing.
  const bankOf = (req: { user: auth.User | null }) => ({ bank: can(req.user!.role, "bank.view") });
  app.post("/contacts", async (req, reply) => {
    const input = contacts.newContactInput.parse(req.body);
    if (!bankOf(req).bank) for (const k of ["bankName", "bankBranch", "bankAccount"] as const) delete input[k];
    // An owner is reached through a property; a scoped user opens one in the
    // apartment intake, where the property is granted to them with it.
    if (!req.scope.all && input.kind === "owner") {
      return reply.status(403).send({ error: "בעל דירה חדש נפתח בקליטת דירה, יחד עם הדירה שלו" });
    }
    const created = await contacts.createContact(db, input);
    if (input.kind === "client") await access.grantToCreator(db, req.scope, { clientId: created.id });
    return reply.status(201).send(created);
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
  // The same, for many records picked in a list. Each one follows its own
  // rules: what cannot be archived or deleted is reported, the rest is done.
  const bulkInput = z.object({ ids: z.array(z.string().uuid()).min(1).max(500) });
  const each = async (ids: string[], one: (id: string) => Promise<unknown>) => {
    const done: string[] = [];
    const failed: { id: string; error: string }[] = [];
    for (const id of new Set(ids)) {
      try {
        await one(id);
        done.push(id);
      } catch (err) {
        failed.push({ id, error: (err as Error).message });
      }
    }
    return { done, failed };
  };
  app.post("/bulk/archive", async (req) => {
    const input = bulkInput.extend({ type: z.enum(["contact", "property"]), archived: z.boolean() }).parse(req.body);
    const result = await each(input.ids, async (id) => {
      await assertRecord(db, req.scope, input.type, id);
      return archive.setArchived(db, req.user!.id, input.type, id, input.archived);
    });
    await audit(req.user?.id || null, input.archived ? "bulk.archived" : "bulk.restored", true, undefined, { type: input.type, ...result });
    return result;
  });
  app.post("/bulk/delete", async (req) => {
    const input = bulkInput.extend({ type: z.enum(["contact", "property", "invoice"]) }).parse(req.body);
    return each(input.ids, async (id) => {
      await assertRecord(db, req.scope, input.type, id);
      return input.type === "invoice" ? invoices.deleteInvoice(db, req.user!.id, id) : archive.deleteRecord(db, req.user!.id, input.type, id);
    });
  });
  app.get<ListQuery>("/owners", async (req) => {
    const owners = await contacts.listByKind(db, "owner", archivedOf(req), req.scope);
    const { rows } = await db.query(
      "SELECT owner_id, count(*)::int AS n FROM properties WHERE $1::uuid[] IS NULL OR id = ANY($1) GROUP BY owner_id",
      [idsOf(req.scope, "properties")],
    );
    const props = new Map(rows.map((r) => [r.owner_id, r.n]));
    return owners.map((o) => ({ ...o, properties: props.get(o.id) ?? 0 }));
  });
  app.get<IdParams>("/owners/:id", async (req) => {
    const { rows } = await db.query(
      `SELECT p.id, p.base_number, p.address,
              (SELECT c.name FROM engagements e JOIN contacts c ON c.id = e.client_id
                WHERE e.property_id = p.id ORDER BY e.starts_on DESC LIMIT 1) AS client_name
         FROM properties p WHERE p.owner_id = $1 AND ($2::uuid[] IS NULL OR p.id = ANY($2)) ORDER BY p.base_number`,
      [req.params.id, idsOf(req.scope, "properties")],
    );
    return { properties: rows };
  });
  app.get<IdParams>("/suppliers/:id", async (req) => {
    const card = await cards.supplierCard(db, req.params.id, req.scope);
    const role = req.user!.role;
    return { ...card, invoices: can(role, "invoices.view") ? hideAmounts(role, card.invoices) : [] };
  });
  app.get("/supplier-invoices", async (req) => invoices.listSupplierInvoices(db, req.scope));
  // Read the invoices entered in Planfix now, instead of at the next readback.
  app.post("/supplier-invoices/refresh", async (_req, reply) => {
    if (!opts.crm) return reply.status(503).send({ error: "Planfix is not configured" });
    return refreshPlanfixInvoices(db, opts.crm);
  });
  app.get<{ Params: { id: string }; Querystring: { month?: string } }>("/suppliers/:id/statement", async (req) => {
    const month = z.string().regex(/^\d{4}-\d{2}$/, "חודש בפורמט YYYY-MM").parse(req.query.month ?? new Date().toISOString().slice(0, 7));
    return invoices.supplierStatement(db, req.params.id, month, req.scope);
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
      .send(await billing.once(db, input.requestKey, { client: req.params.id, ...input }, () => billing.createCharge(db, crm, req.user?.id || null, req.params.id, input)));
  });
  // A supplier invoice charged on to the client, by the client's expense VAT basis.
  type RefParams = { Params: { ref: string } };
  app.get<RefParams>("/supplier-invoices/:ref/charge", async (req) => expense.expenseChargePreview(db, req.params.ref));
  app.post<RefParams>("/supplier-invoices/:ref/charge", async (req, reply) => {
    if (!opts.crm) return reply.status(503).send({ error: "Planfix is not configured" });
    const input = expense.expenseChargeInput.parse(req.body);
    return reply.status(201).send(await expense.chargeExpense(db, opts.crm, req.user?.id || null, req.params.ref, input));
  });
  app.post<IdParams>("/clients/:id/bills", async (req, reply) => {
    if (!opts.crm) return reply.status(503).send({ error: "Planfix is not configured" });
    const input = billing.billInput.parse(req.body);
    const crm = opts.crm;
    return reply
      .status(201)
      .send(await billing.once(db, input.requestKey, { client: req.params.id, ...input }, () => billing.issueBill(db, crm, req.user?.id || null, req.params.id, input)));
  });
  app.get<{ Params: { id: string; billId: string } }>("/clients/:id/bills/:billId", async (req) =>
    billing.getBill(db, req.params.id, Number(req.params.billId)),
  );
  // The month's rent per contract, then opening the missing rent charges.
  app.get<{ Params: { id: string }; Querystring: { month?: string; from?: string; to?: string } }>("/clients/:id/rent-charges", async (req) => {
    const q = req.query;
    const range = billing.rentRange.parse(q.from || q.to ? { from: q.from, to: q.to } : { month: q.month ?? new Date().toISOString().slice(0, 7) });
    return billing.rentPlan(db, req.params.id, range);
  });
  app.post<IdParams>("/clients/:id/rent-charges", async (req, reply) => {
    if (!opts.crm) return reply.status(503).send({ error: "Planfix is not configured" });
    const { from, to, requestKey } = billing.rentInput.parse(req.body);
    const crm = opts.crm;
    return reply
      .status(201)
      .send(await billing.once(db, requestKey, { client: req.params.id, from, to }, () => billing.createRentCharges(db, crm, req.user?.id || null, req.params.id, { from, to })));
  });
  app.get<{ Params: { id: string }; Querystring: { month?: string } }>("/clients/:id/rent-bill", async (req) =>
    billing.rentBillPlan(db, req.params.id, req.query.month ?? new Date().toISOString().slice(0, 7)),
  );
  app.post<IdParams>("/clients/:id/rent-bill", async (req, reply) => {
    if (!opts.crm) return reply.status(503).send({ error: "Planfix is not configured" });
    const { month, pieces, requestKey } = billing.rentBillInput.parse(req.body);
    const crm = opts.crm;
    return reply
      .status(201)
      .send(await billing.once(db, requestKey, { client: req.params.id, month, pieces }, () => billing.issueRentBill(db, crm, req.user?.id || null, req.params.id, month, pieces)));
  });
  // Completing or correcting an apartment from its card.
  app.post<IdParams>("/properties/:id", async (req) =>
    edit.editProperty(db, req.user?.id || null, req.params.id, edit.propertyEditInput.parse(req.body)),
  );
  app.post<IdParams>("/engagements/:id", async (req) =>
    edit.editEngagement(db, req.user?.id || null, req.params.id, edit.engagementEditInput.parse(req.body)),
  );
  app.post<{ Params: { id: string; billId: string } }>("/clients/:id/bills/:billId/cancel", async (req, reply) => {
    if (!opts.crm) return reply.status(503).send({ error: "Planfix is not configured" });
    const input = billing.cancelBillInput.parse(req.body);
    const crm = opts.crm;
    return billing.once(db, input.requestKey, { client: req.params.id, bill: req.params.billId, ...input }, () =>
      billing.cancelBill(db, crm, req.user?.id || null, req.params.id, Number(req.params.billId), input),
    );
  });
  app.post<{ Params: { id: string; chargeId: string } }>("/clients/:id/charges/:chargeId/amount", async (req, reply) => {
    if (!opts.crm) return reply.status(503).send({ error: "Planfix is not configured" });
    const input = billing.amountInput.parse(req.body);
    return billing.correctChargeAmount(db, opts.crm, req.user?.id || null, req.params.id, Number(req.params.chargeId), input);
  });
  app.post<{ Params: { id: string; contractId: string } }>("/clients/:id/contracts/:contractId/price", async (req, reply) => {
    if (!opts.crm) return reply.status(503).send({ error: "Planfix is not configured" });
    const input = billing.contractPriceInput.parse(req.body);
    return billing.setContractPrice(db, opts.crm, req.user?.id || null, req.params.id, Number(req.params.contractId), input);
  });
  app.post<{ Params: { id: string; creditId: string } }>("/clients/:id/credits/:creditId/refunds", async (req, reply) => {
    if (!opts.crm) return reply.status(503).send({ error: "Planfix is not configured" });
    const input = billing.refundInput.parse(req.body);
    const crm = opts.crm;
    const done = await billing.once(db, input.requestKey, { client: req.params.id, credit: req.params.creditId, ...input }, () =>
      billing.recordRefund(db, crm, req.user?.id || null, req.params.id, Number(req.params.creditId), input),
    );
    return reply.status(201).send(done);
  });
  app.get("/work-center", async (req) => q.workCenter(db, req.user!, req.scope));

  // Saved locally first; Planfix sync happens in the background ("saved, waiting for sync").
  // A scoped user may link only an owner and client they see; the new
  // property is then granted to them.
  app.post("/intakes", async (req, reply) => {
    const input = intakeInput.parse(req.body);
    if ("id" in input.owner) await assertRecord(db, req.scope, "owner", input.owner.id);
    if ("id" in input.client) await assertRecord(db, req.scope, "client", input.client.id);
    const result = await createIntake(db, input);
    await access.grantToCreator(db, req.scope, { propertyId: result.propertyId });
    return reply.status(201).send({ ...result, sync: "pending" });
  });

  app.post("/supplier-invoices", async (req, reply) => {
    const input = supplierInvoiceInput.parse(req.body);
    await assertRecord(db, req.scope, "engagement", input.engagementId);
    const result = await createSupplierInvoice(db, input);
    return reply.status(201).send({ ...result, sync: "pending" });
  });

  // Paid service request: open -> assign supplier (and who pays) -> client approval
  // when the client pays -> supplier invoice -> close.
  type IdParams = { Params: { id: string } };

  app.post("/service-requests", async (req, reply) => {
    const input = sr.openInput.parse(req.body);
    await assertRecord(db, req.scope, "engagement", input.engagementId);
    return reply.status(201).send(await sr.openRequest(db, req.user!, input));
  });
  app.get<IdParams>("/service-requests/:id", async (req) => sr.getRequest(db, req.params.id));
  // The service file for finance, printable.
  app.get<IdParams>("/service-requests/:id/file", async (req) =>
    serviceFile(db, req.params.id, { bank: can(req.user!.role, "bank.view"), amounts: can(req.user!.role, "amounts.view") }),
  );
  app.post<IdParams>("/service-requests/:id/assign", async (req) =>
    sr.assignSupplier(db, req.user!, req.params.id, sr.assignInput.parse(req.body)),
  );
  app.post<IdParams>("/service-requests/:id/client-approval", async (req) =>
    sr.recordClientApproval(db, req.user!, req.params.id, sr.approvalInput.parse(req.body)),
  );
  app.post<IdParams>("/service-requests/:id/invoice", async (req, reply) =>
    reply.status(201).send(await sr.addSupplierInvoice(db, req.user!, req.params.id, sr.invoiceInput.parse(req.body))),
  );
  app.post<IdParams>("/service-requests/:id/invoice-review", async (req) =>
    sr.reviewInvoice(db, req.user!, req.params.id, sr.reviewInput.parse(req.body ?? {})),
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

  // Writes to Planfix and the ones whose outcome is unknown, with their history.
  app.get("/sync/operations", async () => ops.listOperations(db));
  app.post<IdParams>("/sync/operations/:id/lookup", async (req, reply) => {
    if (!opts.crm) return reply.status(503).send({ error: "Planfix is not configured" });
    return ops.lookUp(db, opts.crm, req.params.id, req.user?.id || null);
  });
  app.post<IdParams>("/sync/operations/:id/decide", async (req) => {
    const input = decideInput.parse(req.body);
    return ops.decide(db, req.params.id, req.user!.id, input);
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
    tasks.listTasks(db, req.user!, req.query.filter ?? "mine", req.scope),
  );
  app.get<IdParams>("/tasks/:id", async (req) => tasks.getTask(db, req.user!, req.params.id));
  app.post("/tasks", async (req, reply) =>
    reply.status(201).send(await tasks.createTask(db, req.user!, tasks.taskInput.parse(req.body), req.scope)),
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
    sr.listApprovals(db, req.query.which === "decided" ? "decided" : "pending", req.scope),
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
    if (role !== undefined && !access.scopable(role)) {
      const { rows } = await db.query("SELECT scope_mode FROM users WHERE id = $1", [req.params.id]);
      if (rows[0]?.scope_mode === "scoped") {
        return reply.status(409).send({ error: "לתפקיד הזה יש פעולות על כל החברה. קודם צריך להחזיר את המשתמש לגישה לכל החברה" });
      }
    }
    const found = await auth.updateUser(db, req.params.id, { role, active, password });
    if (!found) return reply.status(404).send({ error: "user not found" });
    return { ok: true };
  });

  // Access scopes: departments, grants and a user's scope mode (admin).
  app.get("/access", async () => access.overview(db));
  app.get<IdParams>("/access/users/:id", async (req) => access.preview(db, req.params.id));
  app.post<IdParams>("/access/users/:id", async (req) => access.setUserScope(db, req.user!.id, req.params.id, access.userScopeInput.parse(req.body)));
  app.post("/access/grants", async (req, reply) => reply.status(201).send(await access.addGrant(db, req.user!.id, access.grantInput.parse(req.body))));
  app.post<IdParams>("/access/grants/:id/remove", async (req) => access.removeGrant(db, req.user!.id, req.params.id));
  app.post("/departments", async (req, reply) => reply.status(201).send(await access.createDepartment(db, req.user!.id, access.departmentInput.parse(req.body))));
  app.post<IdParams>("/departments/:id", async (req) => access.renameDepartment(db, req.user!.id, req.params.id, access.departmentInput.parse(req.body)));

  // Import of existing apartments from Planfix. A dry run reports what would
  // change and writes nothing.
  app.post("/import/planfix", async (req, reply) => {
    if (!opts.crm) return reply.status(503).send({ error: "Planfix is not configured" });
    const { dryRun } = (req.body ?? {}) as { dryRun?: boolean };
    return importFromCrm(db, opts.crm, { dryRun: dryRun !== false });
  });

  app.post<{ Params: { taskId: string } }>("/import/engagements/:taskId", async (req, reply) => {
    if (!opts.crm) return reply.status(503).send({ error: "Planfix is not configured" });
    const input = engagementFixInput.parse(req.body);
    return fixSkippedEngagement(db, opts.crm, req.user?.id || null, Number(req.params.taskId), input);
  });

  // Contacts from a Google Sheets link or a CSV file. A dry run unless told otherwise.
  app.post("/import/contacts/sheet", { bodyLimit: 3 * 1024 * 1024 }, async (req) => {
    const input = sheetImportInput.parse(req.body ?? {});
    const report = await importSheet(db, await readSheet(input, opts.fetchSheet), input);
    if (!report.dryRun) {
      await audit(req.user?.id || null, "import.contacts_sheet", true, undefined, {
        source: input.url ? "google_sheets" : "csv",
        created: report.created.length,
        updated: report.updated.length,
        skipped: report.skipped.length,
      });
    }
    return report;
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
