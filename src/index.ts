import { buildServer } from "./api/server.js";
import { config, planfixWebUrl } from "./config.js";
import { migrate } from "./db/migrate.js";
import { createPool } from "./db/pool.js";
import { PlanfixAdapter } from "./planfix/adapter.js";
import { PlanfixClient } from "./planfix/client.js";
import { startReadback } from "./sync/readback.js";
import { startWorker } from "./sync/worker.js";

const db = createPool(config.databaseUrl());
await migrate(db);

const crm = new PlanfixAdapter(new PlanfixClient(config.planfixBaseUrl(), config.planfixToken(), fetch, config.planfixTimeoutMs()));
const stopWorker = startWorker(db, crm, config.syncPollMs());
const stopReadback = startReadback(db, crm, config.readbackMinutes());

const app = buildServer(db, { secureCookie: config.secureCookie(), crm, planfixWebUrl: planfixWebUrl(config.planfixBaseUrl()) });
await app.listen({ port: config.port(), host: "0.0.0.0" });
console.log(`MAGLARD OS API on :${config.port()}`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    stopWorker();
    stopReadback();
    await app.close();
    await db.end();
    process.exit(0);
  });
}
