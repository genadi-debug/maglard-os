// The HTTP client for the Planfix REST API.
//
// Every failure says whether Planfix may have carried the request out:
//   outcome "not_done" - certainly not carried out (refused before or at the
//                        door: auth, validation, rate limit, no connection);
//   outcome "unknown"  - it may have been (the request was sent and the answer
//                        was lost: timeout, a broken connection, a server
//                        error, an answer that is not what Planfix sends).
// A write whose outcome is unknown must not be sent again blindly: it may
// create the same record twice. Reads can always be repeated.

export type FailureKind = "network" | "timeout" | "auth" | "rate_limit" | "validation" | "server" | "invalid_response";

export class PlanfixError extends Error {
  readonly kind: FailureKind;
  readonly outcome: "not_done" | "unknown";
  readonly retryAfterMs: number | null;

  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
    opts: { kind?: FailureKind; outcome?: "not_done" | "unknown"; retryAfterMs?: number | null } = {},
  ) {
    super(message);
    this.kind = opts.kind ?? kindOf(status);
    // 503: the server said it is not taking requests; other server errors
    // may come after the request was carried out.
    this.outcome = opts.outcome ?? (this.kind === "server" && status !== 503 ? "unknown" : "not_done");
    this.retryAfterMs = opts.retryAfterMs ?? null;
  }

  // Worth trying again later: not for auth or validation, which will not fix
  // themselves.
  get retryable(): boolean {
    return this.kind !== "auth" && this.kind !== "validation";
  }
}

function kindOf(status: number): FailureKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server";
  if (status === 0) return "network";
  return "validation";
}

export type Fetch = typeof fetch;

export type RequestOptions = {
  // A read (GET, or a list/search sent as POST): safe to repeat on any failure.
  read?: boolean;
  // Cancels the request from outside (a shutdown, for example).
  signal?: AbortSignal;
};

export const clientTiming = {
  // Inline retries of reads and of rate-limited requests, and the most a
  // Retry-After is waited for inline; longer waits go back to the queue.
  retries: 2,
  baseDelayMs: 500,
  maxInlineWaitMs: 10_000,
};

// Errors from the connection layer that mean nothing reached Planfix.
const BEFORE_SEND = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"]);

// Retry-After in seconds or as an HTTP date.
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const s = Number(header);
  if (Number.isFinite(s) && s >= 0) return Math.round(s * 1000);
  const t = Date.parse(header);
  return Number.isNaN(t) ? null : Math.max(0, t - now);
}

// Strips anything that could be a credential from text that is logged or shown.
export function redact(text: string): string {
  return text.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/\b[0-9a-f]{24,}\b/gi, "[redacted]");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class PlanfixClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: Fetch = fetch,
    // The longest a single request may take before it is cancelled.
    private readonly timeoutMs = 20_000,
  ) {}

  async request<T = Record<string, unknown>>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    opts: RequestOptions = {},
  ): Promise<T> {
    const read = opts.read ?? method === "GET";
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once<T>(method, path, body, read, opts.signal);
      } catch (err) {
        if (!(err instanceof PlanfixError) || attempt >= clientTiming.retries || opts.signal?.aborted) throw err;
        // A write is repeated inline only when it certainly was not carried
        // out: a rate limit. A read is repeated on any passing failure.
        const again = err.kind === "rate_limit" || (read && err.retryable);
        if (!again) throw err;
        const wait = err.retryAfterMs ?? clientTiming.baseDelayMs * 2 ** attempt;
        if (wait > clientTiming.maxInlineWaitMs) throw err;
        await sleep(wait);
      }
    }
  }

  private async once<T>(method: "GET" | "POST", path: string, body: unknown, read: boolean, outer?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = outer ? AbortSignal.any([outer, timeout]) : timeout;
    // A write that may have reached Planfix has an unknown outcome; a read never matters.
    const sent = (message: string, kind: FailureKind) =>
      new PlanfixError(message, 0, undefined, { kind, outcome: read ? "not_done" : "unknown" });
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, "")}/${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (timeout.aborted) throw sent(`Planfix לא ענה תוך ${this.timeoutMs / 1000} שניות`, "timeout");
      if (outer?.aborted) throw sent("הבקשה ל־Planfix בוטלה", "network");
      const code = (err as { cause?: { code?: string } }).cause?.code ?? (err as { code?: string }).code;
      if (code && BEFORE_SEND.has(code)) {
        throw new PlanfixError(`אין חיבור ל־Planfix (${code})`, 0, undefined, { kind: "network", outcome: "not_done" });
      }
      throw sent(redact(`תקלת רשת: ${(err as Error).message}`), "network");
    }
    let text: string;
    try {
      text = await res.text();
    } catch {
      throw sent(timeout.aborted ? `Planfix לא סיים לענות תוך ${this.timeoutMs / 1000} שניות` : "התשובה מ־Planfix נקטעה", timeout.aborted ? "timeout" : "network");
    }
    let data: { result?: string; error?: string; code?: number } | null = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      const kind = kindOf(res.status);
      throw new PlanfixError(redact(data?.error ?? `HTTP ${res.status}`), res.status, data?.code, {
        kind,
        // A server error after the request was sent: it may have been carried out.
        outcome: kind === "server" && res.status !== 503 && !read ? "unknown" : "not_done",
        retryAfterMs: retryAfterMs(res.headers.get("retry-after")),
      });
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new PlanfixError("Planfix החזיר תשובה לא תקינה", res.status, undefined, {
        kind: "invalid_response",
        outcome: read ? "not_done" : "unknown",
      });
    }
    if (data.result === "fail") {
      throw new PlanfixError(redact(data.error ?? "Planfix refused the request"), 400, data.code, { kind: "validation" });
    }
    return data as T;
  }
}

// The id of a record Planfix just created. A success without one is not a
// success: the record may exist, and its id is unknown.
export function createdId(res: unknown): number {
  const id = (res as { id?: unknown } | null)?.id;
  if (typeof id === "number" && Number.isInteger(id) && id > 0) return id;
  throw new PlanfixError("Planfix ענה בלי מספר הרשומה שנוצרה", 200, undefined, {
    kind: "invalid_response",
    outcome: "unknown",
  });
}
