export class PlanfixError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
  ) {
    super(message);
  }

  // Validation failures (missing required field, bad value) will not fix themselves on retry.
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500 || this.status === 0;
  }
}

export type Fetch = typeof fetch;

export class PlanfixClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  async request<T = Record<string, unknown>>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new PlanfixError(`Network error: ${(err as Error).message}`, 0);
    }
    const data = (await res.json().catch(() => ({}))) as { result?: string; error?: string; code?: number };
    if (!res.ok || data.result === "fail") {
      throw new PlanfixError(data.error ?? `HTTP ${res.status}`, res.ok ? 400 : res.status, data.code);
    }
    return data as T;
  }
}
