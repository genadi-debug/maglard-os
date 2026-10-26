function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

export const config = {
  databaseUrl: () => required("DATABASE_URL"),
  planfixBaseUrl: () => process.env.PLANFIX_BASE_URL ?? "https://maglardsand.planfix.com/rest",
  planfixToken: () => required("PLANFIX_TOKEN"),
  port: () => Number(process.env.PORT ?? 3000),
  syncPollMs: () => Number(process.env.SYNC_POLL_MS ?? 2000),
};
