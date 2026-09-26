// Fetch entry. The owner gate runs first for every path, static assets and images included
// (run_worker_first), so nothing is ever served to a stranger. Then: /api/* to the router,
// /media/* to R2 (her photos, voice notes, his photos, the library), everything else to
// the ASSETS binding.
//
// v2: a scheduled entry for the four crons in wrangler.jsonc (backup, drift check, her
// first texts, voiceprint). A cron that fails is logged by class and audited; it never
// touches a conversation.
//
// v3 (SPEC_V3 sections EE and Crons): the content security policy lets the page open a
// WebRTC call straight to the realtime provider (connect-src api.openai.com, media-src
// blob:) and the permissions policy allows the microphone for this origin only; the
// nightly 07:00 UTC handler also runs the maintenance pass (stale weather cache, asks to
// let go, expired tastings, dead calls) after the backup, and a failure there is logged
// and swallowed so the backup is never lost to it.
//
// v4 (SPEC_V4 sections 6 and 8, amendments A1 and A2): /media/place/:id serves a place
// picture; /media/:id also serves a call-face clip (role callface, images.ts serveMedia,
// video/mp4 with Range); the 20-minute cron pushes the delayed replies that came due
// before it asks whether she texts first; the content security policy opens the Web
// Playback SDK and its frames, the Spotify API and dealer, and the ElevenLabs API for the
// browser client (the exact origins the SDK and the client need are what L4 and L10
// record in docs/SPOTIFY.md and docs/ELEVENLABS.md; the integrator applies any further one).
import { requireOwner } from "./auth";
import { handleApi, overlaySettings } from "./api";
import { serveAudio, serveInbox, serveLibrary, serveMedia } from "./images";
import { servePlacePicture } from "./places";
import { pushDueReplies } from "./deliveries";
import { runBackup } from "./backup";
import { runDrift } from "./drift";
import { maybeTextFirst } from "./herfirst";
import { runVoiceprint } from "./voiceprint";
import { nightly as nightlyMaintenance } from "./maintenance";
import { auditStmt, getSettings } from "./db";
import { safeErrorMessage } from "./providers/types";
import { json } from "./errors";
import type { Env } from "./types";

const READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD"]);
const MEDIA_PREFIX = "/media/";
const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1"]);
// v3: the call runs in the browser over WebRTC to the realtime provider (SPEC_V3 EE), so
// the page may connect to api.openai.com and play her track from a blob; images may come
// from a blob (a captured frame) too.
// v4 (SPEC_V4 A1, A2): the one outside script is Spotify's Web Playback SDK, loaded from
// Spotify as its terms require; it opens frames on sdk.scdn.co and the embedded player on
// open.spotify.com, and connects to the Spotify API and the dealer WebSocket. The ElevenLabs
// browser client (vendored, same-origin) connects to api.elevenlabs.io over https and wss.
// Nothing is loosened: no unsafe-inline, no unsafe-eval, no wildcard scheme.
const REALTIME_ORIGIN = "https://api.openai.com";
const SPOTIFY_SDK_ORIGIN = "https://sdk.scdn.co";
const SPOTIFY_EMBED_ORIGIN = "https://open.spotify.com";
const SPOTIFY_CONNECT = "https://api.spotify.com https://*.spotify.com wss://*.spotify.com";
// v4 A2: the API and its WebSocket, plus the LiveKit host the vendored @elevenlabs/client
// joins for the WebRTC transport (docs/ELEVENLABS.md records the four; ELEVENLABS_CONNECT_ORIGINS
// in src/providers/elevenlabs.ts is the same list).
const ELEVENLABS_CONNECT = "https://api.elevenlabs.io wss://api.elevenlabs.io wss://livekit.rtc.elevenlabs.io https://livekit.rtc.elevenlabs.io";
const CSP = `default-src 'self'; script-src 'self' ${SPOTIFY_SDK_ORIGIN}; frame-src ${SPOTIFY_SDK_ORIGIN} ${SPOTIFY_EMBED_ORIGIN}; connect-src 'self' ${REALTIME_ORIGIN} ${SPOTIFY_CONNECT} ${ELEVENLABS_CONNECT}; img-src 'self' data: blob:; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`;
// The microphone for this origin only (the call button); nothing else is granted.
const PERMISSIONS_POLICY = "microphone=(self), camera=(), geolocation=(), payment=()";

// The crons in wrangler.jsonc, by what they do. Not exported: workerd reads every named
// export of the entry module as a handler and refuses to start on a string.
const CRON_BACKUP = "0 7 * * *";
const CRON_DRIFT = "0 13 * * 1";
const CRON_HER_FIRST = "*/20 * * * *";
const CRON_VOICEPRINT = "0 14 * * 1";

function methodNotAllowed(): Response {
  return json({ error: "method not allowed", code: "method_not_allowed" }, 405);
}

function notFound(): Response {
  return json({ error: "not found", code: "not_found" }, 404);
}

// A state-changing request from another site is refused, whatever cookie it carries.
// Browsers say where a request came from (Sec-Fetch-Site, Origin); a request that says
// nothing (curl, the test runner) is not a browser form. Local dev is lenient about
// localhost versus 127.0.0.1, which wrangler dev rewrites.
function crossSite(request: Request, url: URL): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return true;
  const origin = request.headers.get("origin");
  if (!origin) return false;
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return true;
  }
  if (o.origin === url.origin) return false;
  return !(LOCAL_HOSTS.has(o.hostname) && LOCAL_HOSTS.has(url.hostname));
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// Private, uncached, unframed. Applied to every response that leaves this Worker.
function harden(res: Response): Response {
  const out = new Response(res.body, res);
  const h = out.headers;
  h.set("cache-control", "private, no-store");
  h.set("x-content-type-options", "nosniff");
  h.set("strict-transport-security", "max-age=31536000");
  const type = (h.get("content-type") ?? "").toLowerCase();
  if (type.includes("text/html")) {
    h.set("x-frame-options", "DENY");
    h.set("referrer-policy", "no-referrer");
    h.set("content-security-policy", CSP);
    h.set("permissions-policy", PERMISSIONS_POLICY);
  }
  return out;
}

// /media/:id her photos (v1); /media/audio/:messageId a voice note; /media/inbox/:messageId/:n
// one of his photos; /media/library/:id an owner-uploaded clip, video or image;
// /media/place/:id a place picture (v4, SPEC_V4 section 8; image/png, 404 without one).
function serveMediaPath(request: Request, env: Env, path: string): Promise<Response> {
  const parts = path.slice(MEDIA_PREFIX.length).split("/").map(safeDecode);
  const range = request.headers.get("range");
  const [kind, a, b] = parts;
  if (parts.length === 2 && kind === "audio" && a) return serveAudio(env, env.DB, a, range);
  if (parts.length === 2 && kind === "place" && a) return servePlacePicture(env, env.DB, a);
  if (parts.length === 3 && kind === "inbox" && a && b !== undefined) return serveInbox(env, env.DB, a, b, range);
  if (parts.length === 2 && kind === "library" && a) return serveLibrary(env, env.DB, a, range);
  // v3: a clip (role video) is served with Range support so <video> can seek; the range
  // rides along for every /media/:id and is ignored for a png. v4: a call-face clip (role
  // callface) streams the same way, video/mp4 with Range (images.ts serveMedia).
  // ?download=1 sends the same bytes as an attachment so the chat's Save link works.
  if (parts.length === 1 && kind) return serveMedia(env, env.DB, kind, range, new URL(request.url).searchParams.get("download") === "1");
  return Promise.resolve(notFound());
}

async function dispatch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  let owner: { email: string; mode: "access" | "dev" };
  try {
    owner = await requireOwner(request, env);
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }

  const url = new URL(request.url);
  const path = url.pathname;

  if (!READ_METHODS.has(request.method) && crossSite(request, url)) {
    return json({ error: "cross-site request refused", code: "forbidden" }, 403);
  }

  if (path === "/api" || path.startsWith("/api/")) {
    return handleApi(request, env, ctx, owner.email, url);
  }

  if (path.startsWith(MEDIA_PREFIX)) {
    if (!READ_METHODS.has(request.method)) return methodNotAllowed();
    return serveMediaPath(request, env, path);
  }

  if (!READ_METHODS.has(request.method)) return methodNotAllowed();
  // The assets binding maps "/" to index.html and answers 404 for anything missing.
  return env.ASSETS.fetch(request);
}

// ------------------------------------------------------------------ cron

// The nightly maintenance pass (SPEC_V3 Crons). Every change it makes is audited by the
// module; a failure is logged by class here and never reaches the backup's result.
async function runMaintenance(env: Env, db: D1Database): Promise<Record<string, unknown>> {
  try {
    const settings = overlaySettings(env, await getSettings(db));
    const r: unknown = await nightlyMaintenance(env, db, settings);
    return typeof r === "object" && r !== null ? (r as Record<string, unknown>) : { result: r ?? null };
  } catch (e) {
    const cls = e instanceof Error ? e.name || "Error" : "error";
    console.error("maintenance failed", cls, safeErrorMessage(e, 200));
    return { error: cls };
  }
}

async function runCron(cron: string, at: Date, env: Env, db: D1Database): Promise<Record<string, unknown> | null> {
  if (cron === CRON_BACKUP) {
    const r = await runBackup(env, db);
    const maintenance = await runMaintenance(env, db);
    return { key: r.key, bytes: r.bytes, kept: r.kept, maintenance };
  }
  const settings = overlaySettings(env, await getSettings(db));
  if (cron === CRON_DRIFT) {
    if (!settings.driftCheckEnabled) return null;
    const r = await runDrift(env, db, settings);
    return { id: r.id, ranAt: r.ranAt };
  }
  if (cron === CRON_HER_FIRST) {
    // v4 (SPEC_V4 section 6): the delayed replies that came due since the last tick are
    // pushed first (one notification for the batch, the rows stamped whatever the push
    // did), then the first-text decision runs as before. Both results in one object.
    const delayed: unknown = await pushDueReplies(env, db, at);
    const r: unknown = await maybeTextFirst(env, db, settings, at);
    const first = typeof r === "object" && r !== null ? (r as Record<string, unknown>) : { result: r ?? null };
    return { delayed: typeof delayed === "object" && delayed !== null ? delayed : { result: delayed ?? null }, ...first };
  }
  if (cron === CRON_VOICEPRINT) {
    const r: unknown = await runVoiceprint(db, at);
    return typeof r === "object" && r !== null ? (r as Record<string, unknown>) : { result: r ?? null };
  }
  console.warn("scheduled: no handler for cron", cron);
  return null;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    let res: Response;
    try {
      res = await dispatch(request, env, ctx);
    } catch (e) {
      // Class only in the log; the body says nothing about what went wrong.
      console.error("unhandled", e instanceof Error ? e.name : "error");
      res = json({ error: "internal error", code: "internal" }, 500);
    }
    return harden(res);
  },

  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const cron = controller.cron;
    const at = new Date(Number.isFinite(controller.scheduledTime) ? controller.scheduledTime : Date.now());
    const db = env.DB;
    try {
      const result = await runCron(cron, at, env, db);
      if (result) console.log("scheduled ok", cron, JSON.stringify(result).slice(0, 300));
      else console.log("scheduled skipped", cron);
    } catch (e) {
      const cls = e instanceof Error ? e.name || "Error" : "error";
      const message = safeErrorMessage(e, 200);
      console.error("scheduled failed", cron, cls, message);
      try {
        await auditStmt(db, "cron", "cron.failed", "cron", cron, null, { at: at.toISOString(), error: cls, message }).run();
      } catch {
        /* the audit row is best effort */
      }
    }
  },
} satisfies ExportedHandler<Env>;
