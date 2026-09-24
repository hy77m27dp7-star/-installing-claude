// Runway adapter (SPEC_V3 FF): image-to-video on the Runway dev platform. Three calls:
// start a task, read its status, download the finished mp4. The key is the optional
// Worker secret RUNWAY_API_KEY; without it the registry reports the provider not
// configured and no clip is ever attempted. Errors map to ProviderError the way the
// OpenAI adapter maps them (401 auth, 429 rate_limit, 400 bad_request including a
// moderation refusal, 5xx server); a refusal is recorded as failed, never worked around.
import { ProviderError } from "../types";
import type { Env } from "../types";
import { redactSecrets, safeErrorMessage } from "./types";
import type { VideoProvider, VideoStartRequest, VideoTaskState, VideoTaskStatus } from "./types";

export const RUNWAY_BASE = "https://api.dev.runwayml.com";
// The dated API version header the dev platform requires (current as of the build).
export const RUNWAY_VERSION = "2024-11-06";
// A finished clip larger than this is refused (a 5 or 10 second 720p clip is a few MB).
export const MAX_OUTPUT_BYTES = 25 * 1024 * 1024;
const START_TIMEOUT_MS = 30_000;
const STATUS_TIMEOUT_MS = 20_000;
const OUTPUT_TIMEOUT_MS = 120_000;

const TASK_STATES: ReadonlySet<string> = new Set<VideoTaskState>(["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED", "THROTTLED"]);

function requireKey(env: Env): string {
  const key = env.RUNWAY_API_KEY;
  if (!key || !key.trim()) throw new ProviderError("runway", "config", "RUNWAY_API_KEY not set", 503, false);
  return key;
}

function headers(key: string, json: boolean): Record<string, string> {
  const h: Record<string, string> = { authorization: "Bearer " + key, "x-runway-version": RUNWAY_VERSION };
  if (json) h["content-type"] = "application/json";
  return h;
}

function networkError(e: unknown): ProviderError {
  const name = e instanceof Error ? e.name : "";
  const msg = name === "TimeoutError" || name === "AbortError" ? "request timed out" : safeErrorMessage(e);
  return new ProviderError("runway", "network", msg, 502, true);
}

async function errorFromResponse(res: Response): Promise<ProviderError> {
  let detail = "";
  try {
    const text = (await res.text()).slice(0, 2000);
    try {
      const j = JSON.parse(text) as { error?: unknown; message?: unknown };
      detail = typeof j.error === "string" ? j.error : typeof j.message === "string" ? j.message : text;
    } catch {
      detail = text;
    }
  } catch {
    detail = "";
  }
  const msg = redactSecrets(detail).replace(/\s+/g, " ").trim().slice(0, 300);
  const s = res.status;
  if (s === 401) return new ProviderError("runway", "auth", "authentication failed", 401, false);
  if (s === 403) return new ProviderError("runway", "auth", "permission denied", 403, false);
  if (s === 429) return new ProviderError("runway", "rate_limit", msg || "rate limited", 429, true);
  if (s === 400 || s === 404 || s === 413 || s === 415 || s === 422) {
    return new ProviderError("runway", "bad_request", msg || "bad request", s, false);
  }
  if (s >= 500) return new ProviderError("runway", "server", msg || "server error", s, true);
  return new ProviderError("runway", "other", msg || "unexpected status " + s, s, false);
}

async function readJson<T>(res: Response): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    throw new ProviderError("runway", "server", "unreadable response body", 502, true);
  }
}

// Pure: the status document as the module reads it. An unknown state reads as RUNNING
// (the poll asks again) rather than as a success with no output.
export function readTaskStatus(data: unknown): VideoTaskStatus {
  const o = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
  const raw = typeof o.status === "string" ? o.status.toUpperCase() : "";
  const status: VideoTaskState = TASK_STATES.has(raw) ? (raw as VideoTaskState) : "RUNNING";
  const output = Array.isArray(o.output) ? o.output.filter((u): u is string => typeof u === "string" && u.length > 0) : [];
  const failure = typeof o.failure === "string" ? redactSecrets(o.failure).slice(0, 300) : null;
  const failureCode = typeof o.failureCode === "string" ? o.failureCode.slice(0, 80) : null;
  return { status, output, failure, failureCode };
}

export const runwayProvider: VideoProvider = {
  name: "runway",

  async startImageToVideo(env: Env, req: VideoStartRequest): Promise<{ id: string }> {
    const key = requireKey(env);
    let res: Response;
    try {
      res = await fetch(RUNWAY_BASE + "/v1/image_to_video", {
        method: "POST",
        headers: headers(key, true),
        body: JSON.stringify({ model: req.model, promptImage: req.promptImage, promptText: req.promptText, ratio: req.ratio, duration: req.duration }),
        signal: AbortSignal.timeout(START_TIMEOUT_MS),
      });
    } catch (e) {
      throw networkError(e);
    }
    if (!res.ok) throw await errorFromResponse(res);
    const data = await readJson<{ id?: unknown }>(res);
    if (typeof data.id !== "string" || !data.id) throw new ProviderError("runway", "server", "task response carried no id", 502, true);
    return { id: data.id };
  },

  async taskStatus(env: Env, id: string): Promise<VideoTaskStatus> {
    const key = requireKey(env);
    let res: Response;
    try {
      res = await fetch(RUNWAY_BASE + "/v1/tasks/" + encodeURIComponent(id), {
        method: "GET",
        headers: headers(key, false),
        signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
      });
    } catch (e) {
      throw networkError(e);
    }
    if (!res.ok) throw await errorFromResponse(res);
    return readTaskStatus(await readJson<unknown>(res));
  },

  // The output URL is a signed, time-limited link the task carries; no key goes with it.
  async fetchOutput(_env: Env, url: string): Promise<ArrayBuffer> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new ProviderError("runway", "server", "task output is not a URL", 502, true);
    }
    if (u.protocol !== "https:") throw new ProviderError("runway", "server", "task output is not https", 502, false);
    let res: Response;
    try {
      res = await fetch(u.toString(), { method: "GET", signal: AbortSignal.timeout(OUTPUT_TIMEOUT_MS) });
    } catch (e) {
      throw networkError(e);
    }
    if (!res.ok) throw new ProviderError("runway", "server", "output download failed with status " + res.status, 502, true);
    const declared = Number(res.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_OUTPUT_BYTES) throw new ProviderError("runway", "bad_request", "clip exceeds " + MAX_OUTPUT_BYTES + " bytes", 413, false);
    const bytes = await res.arrayBuffer();
    if (!bytes.byteLength) throw new ProviderError("runway", "server", "empty clip", 502, true);
    if (bytes.byteLength > MAX_OUTPUT_BYTES) throw new ProviderError("runway", "bad_request", "clip exceeds " + MAX_OUTPUT_BYTES + " bytes", 413, false);
    return bytes;
  },
};
