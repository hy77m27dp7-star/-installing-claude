// Web Push for her first texts (SPEC_V2 section U) and, since v4 (SPEC_V4 section 6),
// for a reply she held two minutes or more in real mode (src/deliveries.ts). Those are
// the only two reasons; nothing else ever pushes, and sendPush refuses any other reason.
//
// The push carries no body: the Worker sends a VAPID-signed request with an empty payload
// and the service worker fetches /api/push/latest to show her line. No payload means no
// content encryption, so the subscription's p256dh and auth values are stored only for
// completeness and never used to build a message.
//
// VAPID (RFC 8292): a compact ES256 JWT signed with the private key through crypto.subtle,
// carried as `Authorization: vapid t=<jwt>, k=<public key>`. Key form: the public key is the
// base64url of the 65-byte uncompressed P-256 point, the private key the base64url of the
// 32-byte scalar (what scripts/gen_vapid.mjs prints and the two secrets hold). Both are
// read from env at send time; absent keys mean the send is skipped, never an error.
//
// Nothing here logs a key, an endpoint or a subscription secret: logs carry the endpoint's
// host and the status code only.
import { newId, nowIso } from "./db";
import type { Env } from "./types";

// The two secrets are optional (the feature degrades to off without them) and live outside
// the shared Env type on purpose: nothing else in the runtime may read them.
type EnvSecrets = Env & { VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string };

export interface PushKeys {
  p256dh: string;
  auth: string;
}

export interface PushSubscriptionInput {
  endpoint: string;
  expirationTime?: number | null;
  keys: PushKeys;
}

export interface PushSubscriptionRow {
  id: string;
  endpoint: string;
  keys_json: string;
  created_at: string;
}

// What the API and the audit log may see: never keys_json.
export interface PushSubscriptionPublic {
  id: string;
  endpoint: string;
  created_at: string;
}

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  // "mailto:owner@example.com" or an https origin: who the push service may contact.
  subject: string;
}

export interface PushSendResult {
  reason: string;
  // Subscriptions on file when the send ran.
  total: number;
  sent: number;
  failed: number;
  // Endpoints the push service reported gone (404 or 410); their rows were deleted.
  removed: number;
  // Why nothing was attempted, or null when the send ran.
  skipped: string | null;
}

const MAX_ENDPOINT_CHARS = 2000;
const MAX_KEY_CHARS = 512;
const JWT_LIFETIME_SECONDS = 12 * 3600; // RFC 8292 allows up to 24 h
const PUSH_TTL_SECONDS = 12 * 3600;
const PUSH_TIMEOUT_MS = 10_000;
const MAX_SUBSCRIPTIONS = 50;
const FALLBACK_SUBJECT = "https://avelie.bladepharoh.com";

// ------------------------------------------------------------------ base64url (no Buffer: Workers and Node alike)

export function b64urlEncode(bytes: Uint8Array | ArrayBuffer): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i] ?? 0);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array {
  const clean = s.trim().replace(/-/g, "+").replace(/_/g, "/");
  const padded = clean + "=".repeat((4 - (clean.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlJson(v: unknown): string {
  return b64urlEncode(new TextEncoder().encode(JSON.stringify(v)));
}

// ------------------------------------------------------------------ keys

// The keys from env, or null when either is missing. The subject is the owner's mailbox
// when one is configured, otherwise the app's own origin.
export function vapidKeysFrom(env: Env): VapidKeys | null {
  const e = env as EnvSecrets;
  const publicKey = (e.VAPID_PUBLIC_KEY ?? "").trim();
  const privateKey = (e.VAPID_PRIVATE_KEY ?? "").trim();
  if (!publicKey || !privateKey) return null;
  const owner = (env.OWNER_EMAIL ?? "").trim();
  const subject = owner.includes("@") ? "mailto:" + owner : FALLBACK_SUBJECT;
  return { publicKey, privateKey, subject };
}

// The uncompressed point (0x04 || x || y, 65 bytes) split into its coordinates. A bare
// 64-byte x || y is accepted too. Anything else is malformed.
function pointCoordinates(publicKey: string): { x: Uint8Array; y: Uint8Array } {
  const raw = b64urlDecode(publicKey);
  if (raw.length === 65 && raw[0] === 0x04) return { x: raw.slice(1, 33), y: raw.slice(33, 65) };
  if (raw.length === 64) return { x: raw.slice(0, 32), y: raw.slice(32, 64) };
  throw new Error("VAPID public key is malformed");
}

async function signingKey(keys: VapidKeys): Promise<CryptoKey> {
  const { x, y } = pointCoordinates(keys.publicKey);
  const d = b64urlDecode(keys.privateKey);
  if (d.length !== 32) throw new Error("VAPID private key is malformed");
  const jwk: JsonWebKey = { kty: "EC", crv: "P-256", x: b64urlEncode(x), y: b64urlEncode(y), d: b64urlEncode(d), ext: true };
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

// ------------------------------------------------------------------ the VAPID JWT

// A compact ES256 JWT: header { typ, alg }, payload { aud: the push service's origin, exp:
// at most 24 h out (12 h here), sub: the contact }. WebCrypto's ECDSA signature is the raw
// r || s form JWS wants (64 bytes), not DER.
export async function vapidJwt(keys: VapidKeys, endpoint: string, now: Date = new Date()): Promise<string> {
  const aud = new URL(endpoint).origin;
  const at = Number.isFinite(now.getTime()) ? now.getTime() : Date.now();
  const header = b64urlJson({ typ: "JWT", alg: "ES256" });
  const payload = b64urlJson({ aud, exp: Math.floor(at / 1000) + JWT_LIFETIME_SECONDS, sub: keys.subject });
  const signingInput = `${header}.${payload}`;
  const key = await signingKey(keys);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64urlEncode(sig)}`;
}

// The request headers for one push: RFC 8292 authorization, a TTL, no payload.
export async function vapidHeaders(keys: VapidKeys, endpoint: string, now: Date = new Date()): Promise<Record<string, string>> {
  const t = await vapidJwt(keys, endpoint, now);
  return {
    authorization: `vapid t=${t}, k=${keys.publicKey}`,
    ttl: String(PUSH_TTL_SECONDS),
    urgency: "normal",
    "content-length": "0",
  };
}

// ------------------------------------------------------------------ subscriptions

function cleanEndpoint(v: string): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s || s.length > MAX_ENDPOINT_CHARS) throw new Error("endpoint is required");
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error("endpoint must be a URL");
  }
  if (u.protocol !== "https:") throw new Error("endpoint must be https");
  return u.toString();
}

function cleanKey(v: unknown, name: string): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s || s.length > MAX_KEY_CHARS) throw new Error(name + " is required");
  return s;
}

// One row per endpoint: a second subscribe from the same browser refreshes its keys and
// keeps the row's id. Returns the row without its keys.
export async function subscribe(db: D1Database, sub: PushSubscriptionInput): Promise<PushSubscriptionPublic> {
  const endpoint = cleanEndpoint(sub.endpoint);
  const keys = sub && typeof sub.keys === "object" && sub.keys !== null ? sub.keys : ({} as PushKeys);
  const keysJson = JSON.stringify({ p256dh: cleanKey(keys.p256dh, "p256dh"), auth: cleanKey(keys.auth, "auth") });
  const row: PushSubscriptionRow = { id: newId("ps"), endpoint, keys_json: keysJson, created_at: nowIso() };
  await db
    .prepare("INSERT INTO push_subscriptions (id, endpoint, keys_json, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(endpoint) DO UPDATE SET keys_json = excluded.keys_json")
    .bind(row.id, row.endpoint, row.keys_json, row.created_at)
    .run();
  const stored = await db.prepare("SELECT id, endpoint, created_at FROM push_subscriptions WHERE endpoint = ?1").bind(endpoint).first<PushSubscriptionPublic>();
  return stored ?? { id: row.id, endpoint: row.endpoint, created_at: row.created_at };
}

// Removing an endpoint that is not on file is not an error: the phone is off the list either way.
export async function unsubscribe(db: D1Database, endpoint: string): Promise<void> {
  const clean = cleanEndpoint(endpoint);
  await db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?1").bind(clean).run();
}

export async function listSubscriptions(db: D1Database): Promise<PushSubscriptionRow[]> {
  const r = await db.prepare("SELECT * FROM push_subscriptions ORDER BY created_at LIMIT ?1").bind(MAX_SUBSCRIPTIONS).all<PushSubscriptionRow>();
  return r.results;
}

export async function countSubscriptions(db: D1Database): Promise<number> {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").first<{ n: number }>();
  return r?.n ?? 0;
}

// ------------------------------------------------------------------ sending

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return "?";
  }
}

type Outcome = "sent" | "gone" | "failed";

async function pushOne(keys: VapidKeys, endpoint: string, now: Date): Promise<{ outcome: Outcome; status: number | null }> {
  let headers: Record<string, string>;
  try {
    headers = await vapidHeaders(keys, endpoint, now);
  } catch (e) {
    console.warn("push: could not sign", hostOf(endpoint), e instanceof Error ? e.name : "error");
    return { outcome: "failed", status: null };
  }
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: new Uint8Array(0),
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    });
    // The body is drained so the connection is released; it is never read.
    try { await res.arrayBuffer(); } catch { /* nothing to keep */ }
    if (res.status === 201 || res.status === 200 || res.status === 202) return { outcome: "sent", status: res.status };
    if (res.status === 404 || res.status === 410) return { outcome: "gone", status: res.status };
    return { outcome: "failed", status: res.status };
  } catch (e) {
    console.warn("push: request failed", hostOf(endpoint), e instanceof Error ? e.name : "error");
    return { outcome: "failed", status: null };
  }
}

// The only two reasons a notification ever goes out: her first text of the day (an
// opt-in under a daily cap and quiet hours) and a reply she held two minutes or more
// (v4, the */20 cron). No "miss you", no streak, no nudge: a reason outside this list is
// refused here, not just frowned on.
export const PUSH_REASONS = ["her_first_text", "her_delayed_reply"] as const;
export type PushReason = (typeof PUSH_REASONS)[number];

export function isPushReason(reason: unknown): reason is PushReason {
  return typeof reason === "string" && (PUSH_REASONS as ReadonlyArray<string>).includes(reason);
}

// One push to every subscription on file, for `reason` ("her_first_text" or
// "her_delayed_reply"; anything else is skipped with `skipped` set). With no VAPID keys or
// no subscriptions nothing is attempted and `skipped` says why. A push service that
// reports an endpoint gone removes that row. Never throws: a notification is a courtesy,
// the message she sent is the thing.
export async function sendPush(env: Env, db: D1Database, reason: string, now: Date = new Date()): Promise<PushSendResult> {
  const why = typeof reason === "string" && reason.trim() ? reason.trim().slice(0, 80) : "unspecified";
  const result: PushSendResult = { reason: why, total: 0, sent: 0, failed: 0, removed: 0, skipped: null };
  if (!isPushReason(why)) {
    result.skipped = "reason not allowed";
    console.warn("push refused", why, "only", PUSH_REASONS.join(" and "), "may push");
    return result;
  }
  let subs: PushSubscriptionRow[];
  try {
    subs = await listSubscriptions(db);
  } catch (e) {
    console.warn("push: subscriptions not read", e instanceof Error ? e.name : "error");
    result.skipped = "subscriptions not read";
    return result;
  }
  result.total = subs.length;
  const keys = vapidKeysFrom(env);
  if (!keys) {
    result.skipped = "no VAPID keys";
    console.log("push skipped", why, "no VAPID keys", "subscriptions", subs.length);
    return result;
  }
  if (!subs.length) {
    result.skipped = "no subscriptions";
    console.log("push skipped", why, "no subscriptions");
    return result;
  }
  const gone: string[] = [];
  for (const s of subs) {
    const r = await pushOne(keys, s.endpoint, now);
    console.log("push", why, hostOf(s.endpoint), r.outcome, r.status ?? "-");
    if (r.outcome === "sent") result.sent++;
    else if (r.outcome === "gone") gone.push(s.endpoint);
    else result.failed++;
  }
  for (const endpoint of gone) {
    try {
      await db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?1").bind(endpoint).run();
      result.removed++;
    } catch (e) {
      console.warn("push: gone subscription not removed", hostOf(endpoint), e instanceof Error ? e.name : "error");
      result.failed++;
    }
  }
  return result;
}
