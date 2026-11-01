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
It is plain HTML and an ES module in `public/`, with no build step. Each user
sees only the screens and buttons their role allows. The screens are:

- **Work center:** the user's tasks for today, overdue and urgent, open service requests with their next step, and sync failures. Managers also see each person's workload and requests that have not moved in 3 days. Admin and management also see company figures: active properties and clients, and contracts ending within 90 days.
- **Tasks:** tasks of my own, overdue, urgent, all and done. A task can be linked to an apartment or a service request, and it has an assignee, a due date and a notes thread. Each status change or handover writes a note. A user sees only tasks assigned to or created by them, unless they are a manager.
- **Search** (top of every screen, Ctrl+K): clients, owners, suppliers, addresses, base numbers, apartment codes, service requests and invoice numbers.
- **Apartments:** the apartment list, each with its Planfix sync state, and an intake form. Each address opens the property card: owner, client, contract period, what is missing, service requests, invoices and suppliers who worked there.
- **Clients, owners and suppliers:** lists, a "new" form for each (spec process 1), and cards with the details finance needs, contact people, and an edit button. A card misses fields until each required field of its kind is filled in: the ID or company number (with check digit), and also:
  - client: VAT on rent, withholding tax and its rate, ledger card number
  - owner: licensed dealer, withholding certificate expiry, bank details, ledger card number
  - supplier: type, service areas, withholding certificate expiry, bank details, payment terms

  Bank details are shown and changed only by admin, management and finance. The client card also lists its apartments (active and past), open requests and invoices.
- **Service requests:** a list, and a detail page with one next-action button, photos and documents, and the request's history. Each request has a fault type and an urgency; emergencies come first and notify the managers.
- **Approvals** (admin, management, department manager): service requests whose estimated cost is above the approval threshold. The supplier starts only after a manager approves, and nobody approves their own request.
- **Suppliers:** each supplier's open and closed jobs, average days to close, the apartments they worked in, and their invoices (for roles that see invoices).
- **Notifications:** a task given to me, an approval to decide or decided, an emergency request.
- **Supplier invoices:** amounts, handling and sync state.
- **Planfix sync:** changes made directly in Planfix (conflicts to settle, and what was applied on its own), then the outgoing queue, with a resend button on failed jobs.
- **Import from Planfix** (admin, on the sync screen): a dry run that reports what would be imported and skipped, then the real import.
- **Users** (admin): add users, change roles, block, set a new password, and set the approval threshold.
- **Audit log** (admin, management): every change and login attempt, including refused ones.

## Roles

`src/permissions.ts` maps each permission to roles, following section 4 of
the spec: admin, management, department manager, finance, operations and
property manager. Every route declares the permission it needs in `ROUTES`
(`src/api/server.ts`), and a route not listed there is refused. Operations
does not see rent or invoice amounts, and finance cannot open or run service
requests. Scoping by client, property and department is not built yet.

## Running

```bash
cp .env.example .env          # fill PLANFIX_TOKEN; keep it server-side only
docker compose up -d db
npm install
npm run migrate
npm run dev
```

Create the first login, an admin (passwords must be at least 10 characters).
Add everyone else from the users screen:

```bash
MOS_PASSWORD='...' npm run create-user -- you@example.com "Your Name"
```

`MOS_ROLE=finance` (or another role) creates a user with that role instead.

For plain-http local development, set `COOKIE_SECURE=false` so the session cookie works without https.

Tests need a Postgres database they may wipe:

```bash
TEST_DATABASE_URL=postgres://maglard:maglard@localhost:5432/maglard_test npm test
```

## Deploying on Render

`render.yaml` is a Render Blueprint. It defines the app and a PostgreSQL 16
database.

1. In Render, choose **New → Blueprint** and pick `genadi-debug/maglard-os`.
2. When asked, paste the Planfix token for `PLANFIX_TOKEN`. Keep it only in
   Render. `PLANFIX_BASE_URL` defaults to maglardsand; change it in the
   service's Environment when you move to production.
3. Click **Apply**. Render builds the Dockerfile, creates the database and
   wires `DATABASE_URL`, and the app runs its migrations on start.
4. To create the first user, open the service's **Shell** and run
   `MOS_PASSWORD='...' npx tsx src/createUser.ts you@example.com "Name"`.

## Deploying on Railway

1. In Railway, create a project from the GitHub repo `genadi-debug/maglard-os`.
   It builds with the `Dockerfile` (see `railway.json`), and the health check
   is `/health`.
2. Add a **PostgreSQL** database to the project. In the app service's
   variables, set `DATABASE_URL` to `${{Postgres.DATABASE_URL}}`.
3. Set `PLANFIX_TOKEN`, and set `PLANFIX_BASE_URL` if the account is not
   maglardsand. Keep them only in Railway's variables.
4. Under the service's Networking, generate a domain.
5. Create the first user from the service's shell:
   `MOS_PASSWORD='...' npx tsx src/createUser.ts you@example.com "Name"`.

The app runs its migrations on start. Keep one replica: the sync worker runs
in the same process, and a second replica would only compete for jobs, which
is safe but wasteful.

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

## Reading changes back from Planfix

Every 10 minutes (`PLANFIX_READBACK_MINUTES`, 0 turns it off), and on demand
from the sync screen, `src/sync/readback.ts` reads the property (11), intake
(12) and service request (20) tasks. Each field is compared three ways:
MAGLARD OS now, Planfix now, and Planfix at the previous read.

- A field that changed only in Planfix is applied in MAGLARD OS and listed
  as applied.
- A field that changed on both sides, or with no earlier read to compare,
  goes to the conflict queue. So does a value that breaks a rule here, such
  as an end date before the start. Admin or management then either take the
  Planfix value or keep the MAGLARD OS one, which pushes it to Planfix.
- A service request's status always goes to the queue, because a status in
  MAGLARD OS has rules (supplier, approvals, invoice) that Planfix does not
  enforce.
- A record with a push still on its way is checked at the next read.
- Records that exist only in Planfix are counted, and the import brings them in.

Only verified calls are used: `task/list` with filter 51 and the `status`
field (read-only check on tasks 336–344), and `POST task/{id}` to write
back a kept value. Webhooks are not used until they are verified.

## Cost approval

Assigning a supplier needs an estimated cost. Above the approval threshold
(₪1,500 until an admin changes it), the employee must write why, and the
request waits in triage for a manager. A rejection needs a reason and sends
the request back for a new estimate. Work the client pays for also still
needs the client's approval: the supplier starts once both are in.

Taking in the supplier's invoice is separate from approving it for billing.
The server checks the invoice against the approvals every time it matters:
when it is taken in, when a client or manager approval is recorded, when the
request is closed, and when the invoice is charged to the client (from the
request or from the supplier invoices list).

- When the client pays, the amount compared is what the client will be
  charged: the supplier's total, plus VAT on expenses by the client's card
  (on the net or on the whole total). While the card does not say, the
  highest possible charge is compared; the charge itself needs the card.
- Above the threshold a manager's approval is needed for at least the
  amount (the supplier's total, or the client charge when it is higher). A
  manager's approval never replaces the client's, and nobody approves a
  request they asked for.
- An invoice above its approvals is kept, marked "ממתין לאישור חריגה". It is
  not sent to Planfix, cannot be charged to the client and the request cannot
  be closed until the missing approvals are recorded. The request shows what
  was approved, the new amount, the difference and what is missing.
- A manager is asked automatically; after a rejection, "בדיקה מחדש" asks
  again with a reason. If the client's card or the threshold changes after
  the approval, the charge is checked again and refused, and "בדיקה מחדש"
  returns the invoice to waiting until it is approved again.
- Every client approval is kept (amount, who approved, how, reference, when,
  who recorded it) in `client_approvals`; manager approvals stay in
  `approvals`, including superseded and rejected ones.
- An invoice not linked to a service request (keyed in directly or entered
  in Planfix) has no approvals to compare with: it is charged to the client
  only up to the approval threshold, and never when it is marked for the
  owner or absorbed ("בעלים", "נספג").
- Invoices taken in before this rule (`approval_state` empty) are not
  changed. Closing their requests works as before; charging them is checked
  at the time of the charge.

## Archive and delete

Clients, owners, suppliers and apartments are archived, not deleted. An
archived card leaves the lists, search and pickers (each list has an
"ארכיון" tab), keeps its history, and can be restored. Admin, management and
department managers archive; a card with an active engagement or an open
service request cannot be archived. An admin can delete a card only when it
was opened by mistake: nothing links to it and it never reached Planfix,
where nothing is deleted. The audit log keeps the name of what was deleted.

## Supplier invoices and monthly accounts

A supplier invoice is entered from its service request or straight from the
supplier invoices screen, and is pushed to Planfix (template 22). Invoices
entered directly in Planfix are read back on every readback (or with
"רענון מ-Planfix") and listed by their details only, read only; nothing is
written back. The supplier card shows a monthly account: the month's invoices
from both sides, the totals, and when each is due under the supplier's
payment terms ("שוטף+30" is the end of the invoice month plus 30 days).

## Files

Photos and documents (JPEG, PNG, WebP, HEIC, PDF, Word, Excel, up to 10MB)
can be added to a service request, task, property or supplier invoice. They
are stored in Postgres, so they survive redeploys without a disk. Who may
see or add a file follows who may see or work on its record. Images are
served with a sandbox policy, and nothing is served as HTML or SVG.

## Import from Planfix

`src/sync/importer.ts` reads the property (11) and intake (12) tasks and
their owners and clients, and upserts them by Planfix id. Running it again
updates the same rows. Imported rows carry their Planfix ids, so the worker
never pushes them back. A record that misses required data or clashes with
another (same base number or apartment code) is skipped and listed in the
report. A dry run on maglardsand (2026-10-26): 58 contacts, 55 properties,
54 of 59 engagements, 5 skipped. Contracts (82/83) and supplier invoices are
not imported yet.

## Known gaps

- Suppose the process dies after Planfix created a task but before its id was
  stored. The retry would then create a duplicate. The fix is to look up the
  `MAGLARD OS (<ref>)` marker in the task description before creating, and it
  waits on confirming a supported Planfix search filter.
- Only the value `לחיוב` of field 9978 is verified.
- Supplier invoices and contacts' own details (phone, email) are not read
  back from Planfix yet.
- Roles limit actions, not records: every role sees every client and
  property it may see at all. Scopes come after the Planfix import.
- No two-factor login yet.
- Urgency and fault type reach Planfix in the task description only:
  template 20 has no verified fields for them. The estimated cost and the
  approval stay in MAGLARD OS until the "חריג" fields (10154–10160) are
  verified on a template.
- Notifications are in the app only: no email or WhatsApp yet.
- A supplier invoice's approval state stays in MAGLARD OS. An invoice
  waiting for approval is not sent to Planfix, so a charge opened directly in
  Planfix (outside MAGLARD OS) is not stopped by it.
- An invoice not linked to a service request cannot get approvals: above the
  threshold it cannot be charged from MAGLARD OS at all.
- Only a contact's name goes to Planfix. Its other details (ID, bank, tax
  fields, contact people) stay in MAGLARD OS until the Planfix contact
  fields are verified.
- While a record is being created in Planfix, its row stays locked. Staff
  edits to that same record wait for the Planfix call to finish, which takes
  up to a few seconds.
