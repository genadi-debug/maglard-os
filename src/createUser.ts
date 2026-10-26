// Usage: MOS_PASSWORD='...' [MOS_ROLE=finance] npm run create-user -- <email> <name>
// Without MOS_ROLE the user is an admin. Later users are best added from the users screen.
import { createUser } from "./auth.js";
import { config } from "./config.js";
import { migrate } from "./db/migrate.js";
import { createPool } from "./db/pool.js";
import { isRole } from "./permissions.js";

const [email, ...nameParts] = process.argv.slice(2);
const password = process.env.MOS_PASSWORD;
const role = process.env.MOS_ROLE ?? "admin";
if (!email || !nameParts.length || !password || !isRole(role)) {
  console.error("Usage: MOS_PASSWORD='...' npm run create-user -- <email> <name>");
  process.exit(1);
}
const db = createPool(config.databaseUrl());
await migrate(db);
await createUser(db, email, nameParts.join(" "), password, role)
  .then(() => console.log(`Created ${email}`))
  .finally(() => db.end());
