// Usage: MOS_PASSWORD='...' npm run create-user -- <email> <name>
import { createUser } from "./auth.js";
import { config } from "./config.js";
import { migrate } from "./db/migrate.js";
import { createPool } from "./db/pool.js";

const [email, ...nameParts] = process.argv.slice(2);
const password = process.env.MOS_PASSWORD;
if (!email || !nameParts.length || !password) {
  console.error("Usage: MOS_PASSWORD='...' npm run create-user -- <email> <name>");
  process.exit(1);
}
const db = createPool(config.databaseUrl());
await migrate(db);
await createUser(db, email, nameParts.join(" "), password)
  .then(() => console.log(`Created ${email}`))
  .finally(() => db.end());
