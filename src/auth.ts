import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Db } from "./db/pool.js";
import { isRole, type Role } from "./permissions.js";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export const SESSION_COOKIE = "mos_session";
export const SESSION_DAYS = 14;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, key] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !key) return false;
  const expected = Buffer.from(key, "base64");
  const actual = await scrypt(password, Buffer.from(salt, "base64"), expected.length);
  return timingSafeEqual(actual, expected);
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export class AuthError extends Error {}

function checkPassword(password: string) {
  if (password.length < 10) throw new AuthError("הסיסמה צריכה להיות באורך 10 תווים לפחות");
}

export async function createUser(db: Db, email: string, name: string, password: string, role: Role = "admin") {
  checkPassword(password);
  if (!isRole(role)) throw new AuthError(`תפקיד לא מוכר: ${role}`);
  const { rows } = await db.query(
    "INSERT INTO users (email, name, password_hash, role) VALUES (lower($1), $2, $3, $4) RETURNING id",
    [email, name, await hashPassword(password), role],
  );
  return rows[0].id as string;
}

export async function listUsers(db: Db) {
  const { rows } = await db.query("SELECT id, email, name, role, active, created_at FROM users ORDER BY name");
  return rows;
}

// Changes a user's role, active flag or password. Ending a user's access
// (deactivation or a new password) also ends their open sessions.
export async function updateUser(
  db: Db,
  id: string,
  change: { role?: Role; active?: boolean; password?: string },
) {
  if (change.role !== undefined && !isRole(change.role)) throw new AuthError(`תפקיד לא מוכר: ${change.role}`);
  if (change.password !== undefined) checkPassword(change.password);
  const hash = change.password === undefined ? null : await hashPassword(change.password);
  const { rowCount } = await db.query(
    `UPDATE users SET role = coalesce($2, role), active = coalesce($3, active), password_hash = coalesce($4, password_hash)
      WHERE id = $1`,
    [id, change.role ?? null, change.active ?? null, hash],
  );
  if (!rowCount) return false;
  if (change.active === false || hash) await db.query("DELETE FROM sessions WHERE user_id = $1", [id]);
  return true;
}

// Returns a new session token, or null when the email/password do not match.
export async function login(
  db: Db,
  email: string,
  password: string,
): Promise<{ token: string; userId: string } | null> {
  const { rows } = await db.query("SELECT id, password_hash FROM users WHERE email = lower($1) AND active", [email]);
  // Hash against a dummy when the user is unknown so timing does not reveal which emails exist.
  const ok = await verifyPassword(password, rows[0]?.password_hash ?? DUMMY_HASH);
  if (!rows[0] || !ok) return null;
  const token = randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))`,
    [hashToken(token), rows[0].id, SESSION_DAYS],
  );
  return { token, userId: rows[0].id };
}

export type User = { id: string; email: string; name: string; role: Role };

export async function userForToken(db: Db, token: string | undefined): Promise<User | null> {
  if (!token) return null;
  const { rows } = await db.query(
    `SELECT u.id, u.email, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active`,
    [hashToken(token)],
  );
  return rows[0] ?? null;
}

export async function logout(db: Db, token: string | undefined) {
  if (token) await db.query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]);
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

const DUMMY_HASH = "scrypt$AAAAAAAAAAAAAAAAAAAAAA==$" + Buffer.alloc(64).toString("base64");
