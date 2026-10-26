# MAGLARD OS

The working system for MAGLARD's apartment, intake and finance operations. Staff
work in MAGLARD OS, and Planfix runs behind it as the process engine.
Every action is saved in MAGLARD OS first. A background worker then pushes it
to Planfix through a transactional outbox.

This first slice covers two flows end to end:

- **Apartment intake** (`POST /intakes`) creates the owner and client contacts
  when needed, then the physical property (Planfix template 11) and the
  engagement under it (template 12).
- **Supplier invoice** (`POST /supplier-invoices`) creates the supplier when
  needed and an invoice (template 22) linked to the engagement.

- **Paid service request** (`/service-requests`) moves through the Planfix
  "מוקד" statuses: new → triage → with supplier → awaiting resolution → closed.
  When a request is assigned, staff choose the supplier and who pays: the
  owner, MAGLARD or the client. Work the client pays for stays in triage until
  the client's approval is recorded. The supplier invoice is attached to the
  request and queued for Planfix. Its handling is set from who pays: לחיוב,
  בעלים or נספג.

`GET /sync/status` shows the sync queue.

## Screens

`npm run dev` serves the Hebrew, right-to-left app at `http://localhost:3000/`.
It is plain HTML and an ES module in `public/`, with no build step. It has
five screens:

- **Work center:** open service requests with their next step, plus sync failures.
- **Apartments:** the apartment list, each with its Planfix sync state, and an intake form.
- **Service requests:** a list, and a detail page with one next-action button and the request's history.
- **Supplier invoices:** amounts, handling and sync state.
- **Planfix sync:** the queue, with a resend button on failed jobs.

## Running

```bash
cp .env.example .env          # fill PLANFIX_TOKEN; keep it server-side only
docker compose up -d db
npm install
npm run migrate
npm run dev
```

Tests need a Postgres database they may wipe:

```bash
TEST_DATABASE_URL=postgres://maglard:maglard@localhost:5432/maglard_test npm test
```

## Layout

| Path | What it is |
|---|---|
| `src/db/migrations` | SQL schema: contacts, properties, engagements, supplier invoices, outbox, sync log |
| `src/domain` | Input validation and the services that write records and queue sync jobs |
| `src/planfix/fields.ts` | Planfix template and custom field ids, verified in maglardsand |
| `src/planfix/adapter.ts` | `CrmAdapter` interface and its Planfix implementation |
| `src/sync/worker.ts` | Outbox worker: retries, backoff, sync log |
| `src/api/server.ts` | HTTP API |

## Sync rules

- Each record is pushed once. Its Planfix id is stored in its own transaction
  right after Planfix creates it, under a row lock. This way a later failure
  never loses the id, and two jobs never create the same record.
- Upstream records (contacts, property, engagement) are pushed by whichever job
  needs them first.
- Rate limits, network errors and 5xx responses retry with backoff (30s, 2m,
  8m, 32m), up to 5 attempts. Planfix validation errors, such as a missing
  required field, fail the job immediately.
- Every attempt is written to `sync_log`.

## Planfix behaviour to know

- A Planfix scenario opens an intake task (template 12) under every new
  property. The worker waits briefly for that task (filter type 73 = parent
  task) and fills it, instead of creating a second intake. It falls back to
  creating one only if none appears.
- Service requests use template 20 ("מגלארד — מוקד תקלות"). Each change in
  MAGLARD OS re-syncs the task's status (113–117), supplier, and its "last
  update" field, which records who pays. Field 10280 (who pays) is not on
  template 20. The payer instead travels with the supplier invoice's handling
  (9978): לחיוב = client, בעלים = owner, נספג = MAGLARD (confirmed).
- If a record changes while its sync job is running, the job runs again
  (`request_seq`), so Planfix always ends on the latest state.

## Known gaps

- Suppose the process dies after Planfix created a task but before its id was
  stored. The retry would then create a duplicate. The fix is to look up the
  `MAGLARD OS (<ref>)` marker in the task description before creating, and it
  waits on confirming a supported Planfix search filter.
- Contact creation (`POST contact/`) has not been run against Planfix yet.
- Only the value `לחיוב` of field 9978 is verified.
- So far sync runs one way only, MAGLARD OS to Planfix. Reading changes back
  and handling conflicts come next.
- There is no authentication or permission layer yet.
- While a record is being created in Planfix, its row stays locked. Staff
  edits to that same record wait for the Planfix call to finish, which takes
  up to a few seconds.
