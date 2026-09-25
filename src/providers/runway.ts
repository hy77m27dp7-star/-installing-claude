// Runway adapter. Two jobs on the Runway dev platform, one key (the optional Worker
// secret RUNWAY_API_KEY), one task model: start a task, read its status, download the
// finished file.
//
// 1. Video (SPEC_V3 FF): image-to-video for clips. Unchanged.
// 2. Photos (2026-09-25): Gen-4 Image with tagged character references. Her masters go
//    as data URIs tagged @avelie, @avelie_2, @avelie_3, the prompt names them, and the
//    adapter polls the task itself inside the one request the Chat page holds open
//    (images.ts generateCandidate, which then hashes, blacklists and stores the bytes
//    exactly as it does for OpenAI). OpenAI stays selectable as the fallback.
//
// Every shape below is written against docs.dev.runwayml.com (api.md and openapi.json,
// fetched 2026-09-25) and recorded in docs/ARCHITECTURE.md. Errors map to ProviderError
// the way the OpenAI adapter maps them (401 auth, 429 rate_limit, 400 bad_request, 5xx
// server); a content-moderation failure is a task that FAILED with a SAFETY code, which
// becomes a non-retryable refusal, never worked around. No key ever leaves this layer:
// every message goes through redactSecrets.
import { ProviderError } from "../types";
import type { Env, ImageGenerateRequest, ImageGenerateResult } from "../types";
import { redactSecrets, safeErrorMessage } from "./types";
import type { ImageFromTextRequest, ImageProviderV3, VideoProvider, VideoStartRequest, VideoTaskState, VideoTaskStatus } from "./types";
import { bytesToBase64 } from "../vision";

export const RUNWAY_BASE = "https://api.dev.runwayml.com";
// The dated API version header the dev platform requires on every request
// (docs.dev.runwayml.com/api.md, "Conventions": X-Runway-Version: 2024-11-06).
export const RUNWAY_VERSION = "2024-11-06";
// A finished clip larger than this is refused (a 5 or 10 second 720p clip is a few MB).
export const MAX_OUTPUT_BYTES = 25 * 1024 * 1024;
const START_TIMEOUT_MS = 30_000;
const STATUS_TIMEOUT_MS = 20_000;
const OUTPUT_TIMEOUT_MS = 120_000;

const TASK_STATES: ReadonlySet<string> = new Set<VideoTaskState>(["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED", "THROTTLED"]);

// fetch as the adapter calls it. The tests hand in a stand-in (stub.ts stubRunwayFetch).
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
const realFetch: FetchLike = (url, init) => fetch(url, init);

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

// The HTTP matrix (docs.dev.runwayml.com/errors/errors): 400 inputs (no retry), 401 key
// (no retry), 404 resource (no retry), 429 rate limit (retry), 502/503/504 load (retry).
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

// ------------------------------------------------------------------ shared task calls

// GET /v1/tasks/{id} (api.md "Task management"): status PENDING | THROTTLED | RUNNING |
// SUCCEEDED | FAILED | CANCELLED, output (array of URLs, expire within 24-48 hours),
// failure and failureCode on FAILED. The docs ask for no more than one read every five
// seconds per task.
async function getTask(f: FetchLike, key: string, id: string): Promise<VideoTaskStatus> {
  let res: Response;
  try {
    res = await f(RUNWAY_BASE + "/v1/tasks/" + encodeURIComponent(id), {
      method: "GET",
      headers: headers(key, false),
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
  } catch (e) {
    throw networkError(e);
  }
  if (!res.ok) throw await errorFromResponse(res);
  return readTaskStatus(await readJson<unknown>(res));
}

// DELETE /v1/tasks/{id} cancels a pending, throttled or running task. Best effort: a
// failure here is swallowed, the caller is already reporting the real error.
async function cancelTask(f: FetchLike, key: string, id: string): Promise<void> {
  try {
    await f(RUNWAY_BASE + "/v1/tasks/" + encodeURIComponent(id), {
      method: "DELETE",
      headers: headers(key, false),
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
  } catch {
    // ignored on purpose
  }
}

// The output URL is a signed, time-limited link the task carries; no key goes with it.
async function downloadOutput(f: FetchLike, url: string, maxBytes: number, what: string): Promise<ArrayBuffer> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ProviderError("runway", "server", "task output is not a URL", 502, true);
  }
  if (u.protocol !== "https:") throw new ProviderError("runway", "server", "task output is not https", 502, false);
  let res: Response;
  try {
    res = await f(u.toString(), { method: "GET", signal: AbortSignal.timeout(OUTPUT_TIMEOUT_MS) });
  } catch (e) {
    throw networkError(e);
  }
  if (!res.ok) throw new ProviderError("runway", "server", "output download failed with status " + res.status, 502, true);
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) throw new ProviderError("runway", "bad_request", what + " exceeds " + maxBytes + " bytes", 413, false);
  const bytes = await res.arrayBuffer();
  if (!bytes.byteLength) throw new ProviderError("runway", "server", "empty " + what, 502, true);
  if (bytes.byteLength > maxBytes) throw new ProviderError("runway", "bad_request", what + " exceeds " + maxBytes + " bytes", 413, false);
  return bytes;
}

// ------------------------------------------------------------------ video (SPEC_V3 FF)

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
    return getTask(realFetch, requireKey(env), id);
  },

  async fetchOutput(_env: Env, url: string): Promise<ArrayBuffer> {
    return downloadOutput(realFetch, url, MAX_OUTPUT_BYTES, "clip");
  },
};

// ------------------------------------------------------------------ images (her photos)

// POST /v1/text_to_image, model gen4_image (api.md "Start generating"): promptText (1 to
// 1000 UTF-16 units, references named by @tag), referenceImages (up to three { uri, tag };
// gen4_image_turbo takes the same shape and requires one to three), ratio (the enum
// below), optional seed (0 to 4294967295), optional contentModeration. A tag is 3 to 16
// characters, starts with a letter, letters digits and underscores only. A reference uri
// is an https URL, a runway:// upload or a data URI of at most 5 MB encoded (openapi
// maxLength 5242880; a 3.3 MB file), which is how the masters are sent: they sit behind
// Access, so no URL of ours would work.
export const RUNWAY_IMAGE_MODEL = "gen4_image";
export const RUNWAY_IMAGE_MODELS: readonly string[] = ["gen4_image", "gen4_image_turbo"];
export const RUNWAY_IMAGE_RATIOS: readonly string[] = [
  "1024:1024", "1080:1080", "1168:880", "1360:768", "1440:1080", "1080:1440", "1808:768", "1920:1080",
  "1080:1920", "2112:912", "1280:720", "720:1280", "720:720", "960:720", "720:960", "1680:720",
];
// Her photos are portrait (imageSize 1024x1536 by default); "auto" and anything unreadable
// land here.
export const RUNWAY_PORTRAIT_RATIO = "1080:1440";
// One tag per reference, distinct (the platform's other image models refuse a shared tag,
// gen4_image's docs do not say either way). The face crop is first and carries the bare
// name; the prompt opens with it.
export const RUNWAY_REFERENCE_TAGS: readonly string[] = ["avelie", "avelie_2", "avelie_3"];
export const MAX_IMAGE_REFERENCES = 3;
export const MAX_PROMPT_UNITS = 1000;
export const MAX_REFERENCE_URI_LENGTH = 5 * 1024 * 1024;
// A finished photo larger than this is refused (a 1080x1440 image is a few MB at most).
export const MAX_IMAGE_OUTPUT_BYTES = 20 * 1024 * 1024;
// The poll: three-second steps inside a ninety-second budget, then the task is cancelled
// so an unwatched picture is not paid for. (The docs say status moves at most every five
// seconds; the finer step only costs a few reads.)
export const IMAGE_POLL_STEP_MS = 3_000;
export const IMAGE_POLL_BUDGET_MS = 90_000;
// Three data URIs of a few MB each ride in the start request; give the upload a minute.
const IMAGE_START_TIMEOUT_MS = 60_000;
const TAG_RE = /^[a-z][a-z0-9_]{2,15}$/;

// Aspects this close (in log space, about 2 percent) count as the same shape; the pixel
// count then decides between them, so 1792x1024 lands on 1920:1080 and not on 1360:768.
const ASPECT_TOLERANCE = 0.02;

// Pure: the enum ratio nearest the requested WxH (an exact match first, then the closest
// aspect, then the closest pixel count among the aspects within tolerance). 1024x1536
// lands on 1080:1440; 1024x1024 on itself; "auto" and junk on the portrait default.
export function ratioForSize(size: string): string {
  const s = (size ?? "").trim().toLowerCase();
  const m = /^(\d{3,4})[x:](\d{3,4})$/.exec(s);
  if (!m) return RUNWAY_PORTRAIT_RATIO;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!(w > 0 && h > 0)) return RUNWAY_PORTRAIT_RATIO;
  const exact = w + ":" + h;
  if (RUNWAY_IMAGE_RATIOS.includes(exact)) return exact;
  const want = Math.log(w / h);
  const pixels = w * h;
  const scored = RUNWAY_IMAGE_RATIOS.map((r) => {
    const [rw, rh] = r.split(":").map(Number);
    const ok = !!rw && !!rh;
    return { r, aspect: ok ? Math.abs(Math.log(rw / rh) - want) : Number.POSITIVE_INFINITY, px: ok ? Math.abs(rw * rh - pixels) : Number.POSITIVE_INFINITY };
  });
  const nearest = Math.min(...scored.map((x) => x.aspect));
  if (!Number.isFinite(nearest)) return RUNWAY_PORTRAIT_RATIO;
  let best = scored[0];
  for (const x of scored) {
    if (x.aspect > nearest + ASPECT_TOLERANCE) continue;
    if (!best || best.aspect > nearest + ASPECT_TOLERANCE || x.px < best.px) best = x;
  }
  return best ? best.r : RUNWAY_PORTRAIT_RATIO;
}

function trimToWords(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max / 2 ? cut.slice(0, space) : cut).trim();
}

// Pure: the prompt. A short identity line that names the references by tag (no body-part
// words: OpenAI's filter refused one this morning and Runway moderates text too), then
// " Scene: " and her description, the whole thing within the 1000-unit cap (the scene is
// cut at a word if it must be; the identity line never is).
export function runwayImagePrompt(scene: string, tags: readonly string[] = RUNWAY_REFERENCE_TAGS): string {
  const list = tags.length ? tags : RUNWAY_REFERENCE_TAGS;
  const head = "@" + list[0];
  const rest = list.slice(1).map((t) => "@" + t);
  const others = rest.length
    ? " (" + (rest.length === 1 ? rest[0] + " is" : rest.slice(0, -1).join(", ") + " and " + rest[rest.length - 1] + " are") + " the same person as " + head + ")"
    : "";
  const identity =
    head + " is the woman in every reference image" + others + ". Show exactly her: the same person as " + head +
    ", her face exactly as the references show it, and her full curvy hourglass figure with the same full bust the references show, never slimmed or flattened; her face fully visible and clearly lit even in a dusk, night or grainy scene, the eyes, brows, nose and mouth matching the references feature for feature; a clearly adult 22-year-old, fully clothed as the scene describes. " +
    "Her clothes, the setting, the lighting and her pose come from the scene only, never from a reference. " +
    "Candid, realistic phone photo, natural imperfections, no text, no watermark, no collage, one image.";
  const prefix = identity + " Scene: ";
  const clean = scene.replace(/\s+/g, " ").trim();
  return prefix + trimToWords(clean, MAX_PROMPT_UNITS - prefix.length);
}

function sniffMime(bytes: ArrayBuffer): string {
  const b = new Uint8Array(bytes, 0, Math.min(12, bytes.byteLength));
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return "image/png";
}

// Pure: one reference as a data URI, refused before encoding when it cannot fit the cap.
export function referenceUri(name: string, bytes: ArrayBuffer): string {
  if (!bytes.byteLength) throw new ProviderError("runway", "bad_request", "reference image is empty: " + name, 400, false);
  const mime = sniffMime(bytes);
  const prefix = "data:" + mime + ";base64,";
  const encoded = prefix.length + Math.ceil(bytes.byteLength / 3) * 4;
  if (encoded > MAX_REFERENCE_URI_LENGTH) {
    throw new ProviderError("runway", "bad_request", "reference image exceeds the 5 MB data URI cap: " + name, 413, false);
  }
  return prefix + bytesToBase64(bytes);
}

// Pure: the text_to_image body for her photo. The first three references (the face crop
// leads, images.ts loadMasterBytes orders them) tagged avelie, avelie_2, avelie_3.
export function imageRequestBody(req: ImageGenerateRequest): Record<string, unknown> {
  const chosen = req.references.slice(0, MAX_IMAGE_REFERENCES);
  const tags = RUNWAY_REFERENCE_TAGS.slice(0, chosen.length);
  for (const t of tags) if (!TAG_RE.test(t)) throw new ProviderError("runway", "bad_request", "bad reference tag", 400, false);
  const referenceImages = chosen.map((r, i) => ({ uri: referenceUri(r.name, r.bytes), tag: tags[i] }));
  return { model: req.model, promptText: runwayImagePrompt(req.prompt, tags), ratio: ratioForSize(req.size), referenceImages };
}

// Pure: a terminal task that is not a success, as a ProviderError. SAFETY.* and the
// INPUT_PREPROCESSING.SAFETY.* codes are content moderation (docs.dev.runwayml.com/errors/
// task-failures: do not retry); ASSET.* is a bad input; INTERNAL.BAD_OUTPUT.*,
// INPUT_PREPROCESSING.INTERNAL, THIRD_PARTY.UNAVAILABLE and a missing code may be retried.
export function taskFailureError(status: VideoTaskStatus): ProviderError {
  const code = (status.failureCode ?? "").trim();
  const reason = redactSecrets(status.failure ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  const detail = (code || status.status.toLowerCase()) + (reason ? ": " + reason : "");
  if (status.status === "CANCELLED") return new ProviderError("runway", "other", "task cancelled", 502, false);
  if (/SAFETY/.test(code)) return new ProviderError("runway", "refusal", "moderated by Runway (" + detail + ")", 502, false);
  if (/^ASSET\./.test(code)) return new ProviderError("runway", "bad_request", detail, 400, false);
  return new ProviderError("runway", "server", detail, 502, true);
}

export interface RunwayImageDeps {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

// The image provider, with its clock and transport injectable so the unit suite can run
// the whole path against stub.ts stubRunwayFetch without waiting or a key.
export function makeRunwayImageProvider(deps: RunwayImageDeps = {}): ImageProviderV3 {
  const f: FetchLike = deps.fetch ?? realFetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => Date.now());

  async function startTask(key: string, body: Record<string, unknown>): Promise<string> {
    let res: Response;
    try {
      res = await f(RUNWAY_BASE + "/v1/text_to_image", {
        method: "POST",
        headers: headers(key, true),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(IMAGE_START_TIMEOUT_MS),
      });
    } catch (e) {
      throw networkError(e);
    }
    if (!res.ok) throw await errorFromResponse(res);
    const data = await readJson<{ id?: unknown }>(res);
    if (typeof data.id !== "string" || !data.id) throw new ProviderError("runway", "server", "task response carried no id", 502, true);
    return data.id;
  }

  async function waitForOutput(key: string, id: string): Promise<string> {
    const deadline = now() + IMAGE_POLL_BUDGET_MS;
    for (;;) {
      await sleep(IMAGE_POLL_STEP_MS);
      const status = await getTask(f, key, id);
      if (status.status === "SUCCEEDED") {
        const url = status.output?.[0];
        if (!url) throw new ProviderError("runway", "server", "task succeeded with no output", 502, true);
        return url;
      }
      if (status.status === "FAILED" || status.status === "CANCELLED") throw taskFailureError(status);
      if (now() >= deadline) {
        await cancelTask(f, key, id);
        throw new ProviderError("runway", "server", "photo task did not finish within " + IMAGE_POLL_BUDGET_MS / 1000 + " s and was cancelled", 504, true);
      }
    }
  }

  async function run(env: Env, body: Record<string, unknown>, model: string): Promise<ImageGenerateResult> {
    const key = requireKey(env);
    const id = await startTask(key, body);
    const url = await waitForOutput(key, id);
    const png = await downloadOutput(f, url, MAX_IMAGE_OUTPUT_BYTES, "photo");
    return { png, model, provider: "runway" };
  }

  return {
    name: "runway",

    async generate(env: Env, req: ImageGenerateRequest): Promise<ImageGenerateResult> {
      requireKey(env);
      if (!req.references.length) throw new ProviderError("runway", "bad_request", "no reference images", 400, false);
      if (!req.prompt.trim()) throw new ProviderError("runway", "bad_request", "empty prompt", 400, false);
      // req.identityPrompt is OpenAI's long block; Runway's prompt has a 1000-unit cap and
      // names the references by tag, so the body carries the adapter's own line.
      return run(env, imageRequestBody(req), req.model);
    },

    // v3, SPEC_V3 DD: a portrait of someone in her life. No references (gen4_image accepts
    // none; gen4_image_turbo requires one and would answer 400), the portrait size.
    async generateFromText(env: Env, req: ImageFromTextRequest): Promise<ImageGenerateResult> {
      requireKey(env);
      const prompt = req.prompt.replace(/\s+/g, " ").trim();
      if (!prompt) throw new ProviderError("runway", "bad_request", "empty prompt", 400, false);
      return run(env, { model: req.model, promptText: trimToWords(prompt, MAX_PROMPT_UNITS), ratio: ratioForSize(req.size) }, req.model);
    },
  };
}

export const runwayImageProvider: ImageProviderV3 = makeRunwayImageProvider();
