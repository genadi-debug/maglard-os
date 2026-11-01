function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

export const config = {
  databaseUrl: () => required("DATABASE_URL"),
  planfixBaseUrl: () => process.env.PLANFIX_BASE_URL ?? "https://maglardsand.planfix.com/rest",
  planfixToken: () => required("PLANFIX_TOKEN"),
  // The longest a single Planfix call may take before it is cancelled.
  planfixTimeoutMs: () => Number(process.env.PLANFIX_TIMEOUT_MS ?? 20_000),
  port: () => Number(process.env.PORT ?? 3000),
  // Set COOKIE_SECURE=false only for plain-http local development.
  secureCookie: () => process.env.COOKIE_SECURE !== "false",
  syncPollMs: () => Number(process.env.SYNC_POLL_MS ?? 2000),
  // How often to read changes back from Planfix; 0 switches it off.
  readbackMinutes: () => Number(process.env.PLANFIX_READBACK_MINUTES ?? 10),
};

// The Planfix web address for links to tasks and contacts, from the same
// setting the sync uses: "https://<account>.planfix.com/rest" gives
// "https://<account>.planfix.com". Anything else gives no links rather than a
// guess.
export function planfixWebUrl(baseUrl: string): string | null {
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== "https:" || !/^[a-z0-9-]+\.planfix\.(com|ru|ua)$/i.test(u.hostname)) return null;
    if (!/^\/rest\/?$/.test(u.pathname)) return null;
    return u.origin;
  } catch {
    return null;
  }
}
