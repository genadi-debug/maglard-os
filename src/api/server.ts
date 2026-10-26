import Fastify from "fastify";
import { ZodError } from "zod";
import type { Db } from "../db/pool.js";
import { intakeInput, supplierInvoiceInput } from "../domain/schemas.js";
import * as sr from "../domain/serviceRequests.js";
import { createIntake, createSupplierInvoice, NotFoundError } from "../domain/services.js";

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

  app.get("/sync/status", async () => {
    const { rows } = await db.query(
      `SELECT job_type, entity_id, status, attempts, last_error, updated_at
         FROM outbox ORDER BY id DESC LIMIT 100`,
    );
    return { jobs: rows };
  });

  return app;
}
