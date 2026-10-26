import Fastify from "fastify";
import { ZodError } from "zod";
import type { Db } from "../db/pool.js";
import { intakeInput, supplierInvoiceInput } from "../domain/schemas.js";
import { createIntake, createSupplierInvoice, NotFoundError } from "../domain/services.js";

export function buildServer(db: Db) {
  const app = Fastify({ logger: false });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.status(400).send({ error: "validation", issues: err.issues });
    if (err instanceof NotFoundError) return reply.status(404).send({ error: err.message });
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

  app.get("/sync/status", async () => {
    const { rows } = await db.query(
      `SELECT job_type, entity_id, status, attempts, last_error, updated_at
         FROM outbox ORDER BY id DESC LIMIT 100`,
    );
    return { jobs: rows };
  });

  return app;
}
