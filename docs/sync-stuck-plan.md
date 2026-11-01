# Writes to Planfix that are stuck: a handling plan

This plan is **not run automatically**. Migration 022 only adds tables and
columns. It changes no existing row, and nothing is sent to Planfix by it. Each
step below is done by a person with the `sync.resolve` permission (admin,
management) after looking at Planfix.

## 1. List what is stuck (read only)

```
DATABASE_URL=... npx tsx src/sync/stuckReport.ts > stuck.json
```

The report reads the database only. It does not call Planfix. It lists:

| Group | What it means | Risk if sent again blindly |
|---|---|---|
| `legacyFormWrites` | A charge, bill, rent or refund form from before 022 that was claimed and never recorded a result (the process stopped, or the old `once` was cut off) | A duplicate charge or bill |
| `formWritesUnknown` | A form write since 022 whose outcome is unknown | Covered by the journal: it is not sent again |
| `queueFailed` | A queued push that gave up (validation, auth, or attempts used up) | Low: certainly not carried out, or an update |
| `queueStuckRunning` | A queued push left "running" by a restart | A duplicate record if it was a create |
| `queueUnknown` | A queued push waiting for an operation to be checked | Covered by the journal |
| `operationsOpen` | Operations whose outcome is unknown, or running with an expired lease | Covered by the journal |

## 2. Check each item in Planfix

- **Queue items (`queueFailed`, `queueStuckRunning`).** Check whether the record has a Planfix id locally (`planfix_id` / `planfix_task_id` on its row).
  - If it has one, the item can be retried safely: it is an update, or the id is already stored.
  - If it has none, search Planfix for a task of the record's template whose description says `Created by MAGLARD OS (<type>:<id>)`. The `<type>:<id>` value is the job's entity, for example `supplier_invoice:<uuid>`.
    - **Found:** write its id to the row. Then retry the job from the sync screen ("שליחה חוזרת").
    - **Not found:** retry it from the sync screen. The journal now prevents a second create.
- **Old form writes (`legacyFormWrites`).** The key alone does not say which action it was. Look in `audit_log` around `created_at` for `charge.created`, `bill.created` or `rent.charged` by the same user, and in Planfix for a charge or bill created at that time with the matching name.
  - **Found:** nothing to do in Planfix. Marking the key as done is optional.
  - **Not found:** the person can send the form again. The new keys are journaled.
- **Operations (`operationsOpen`).** Handle them on the sync screen:
  - "חיפוש ב־Planfix" searches read-only by template, name and the `op <id>` marker.
  - "נמצא ב־Planfix" is recorded with the task id.
  - "לא נוצר" allows the action to be sent again.

  Every decision is kept in the log with the person and a note.

## 3. Changes that need a person's go-ahead

These SQL statements are examples to run **only** after the check above, one item at a time, inside a transaction. Keep the output.

```sql
-- A queued create that was found in Planfix: store its id, then retry from the screen.
UPDATE supplier_invoices SET planfix_task_id = <found id> WHERE id = '<uuid>' AND planfix_task_id IS NULL;

-- An old form key that was checked: mark it so it is not shown again.
UPDATE planfix_writes SET status = 'failed', error = 'checked by <name> on <date>: not in Planfix' WHERE key = '<key>' AND status IS NULL AND result IS NULL;
```

## 4. Rollback

The plan changes only the rows a person chose. Migration 022 can be rolled
back as written at the top of `src/db/migrations/022_planfix_operations.sql`,
once no outbox row has the status `unknown`.
