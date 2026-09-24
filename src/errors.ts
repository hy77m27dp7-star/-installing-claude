// One error shape for the whole API. Handlers throw ApiHttpError; the router renders it.
import type { ApiError } from "./types";

export class ApiHttpError extends Error {
  status: number;
  code: string;
  retryable: boolean | undefined;
  detail: string | undefined;
  constructor(status: number, code: string, message: string, retryable?: boolean, detail?: string) {
    super(message);
    this.name = "ApiHttpError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.detail = detail;
  }
  toBody(): ApiError {
    const body: ApiError = { error: this.message, code: this.code };
    if (this.retryable !== undefined) body.retryable = this.retryable;
    if (this.detail !== undefined) body.detail = this.detail;
    return body;
  }
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export function errorResponse(e: unknown): Response {
  if (e instanceof ApiHttpError) return json(e.toBody(), e.status);
  if (e instanceof Response) return e;
  const message = e instanceof Error ? e.message : String(e);
  return json({ error: message, code: "internal" }, 500);
}
