import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { ZodError } from "zod";
import type { Db } from "../db/pool.js";
import { intakeInput, supplierInvoiceInput } from "../domain/schemas.js";
import * as q from "../domain/queries.js";
import * as sr from "../domain/serviceRequests.js";
import { createIntake, createSupplierInvoice, NotFoundError } from "../domain/services.js";

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "public");
const assets: Record<string, string> = {
  "/": "index.html",
  "/app.js": "app.js",
};
const types: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

export function buildServer(db: Db) {
  const app = Fastify({ logger: false });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.status(400).send({ error: "validation", issues: err.issues });
    if (err instanceof NotFoundError) return reply.status(404).send({ error: err.message });
    if ((err as { code?: string }).code === "22P02") return reply.status(400).send({ error: "invalid id" });
    if (err instanceof sr.RuleError) return reply.status(409).send({ error: err.message });
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
  app.get("/engagements", async () => q.listEngagements(db));
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
      `SELECT job_type, entity_id, status, attempts, last_error, updated_at
         FROM outbox ORDER BY id DESC LIMIT 100`,
    );
    return { jobs: rows };
  });

  return app;
}
