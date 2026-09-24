// Cloudflare Access at the door. Every request, static assets and images included, passes
// here first. Identity comes from a verified Access JWT (header or cookie) or, only on a
// local host with ACCESS_AUD empty, from DEV_ACTOR_EMAIL. No other identity source exists,
// and nothing here ever logs a header, a token or a key.
import { json } from "./errors";
import type { Env } from "./types";

const JWT_HEADER = "CF-Access-Jwt-Assertion";
const JWT_COOKIE = "CF_Authorization";
const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1"]);

// The key set is refetched when a token names a kid we do not hold, at most once a
// minute, and in any case once it is a day old.
const REFETCH_MIN_MS = 60_000;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

type Jwk = JsonWebKey & { kid?: string };

interface JwksEntry {
  keys: Jwk[];
  byKid: Map<string, Jwk>;
  fetchedAt: number;
}

const jwksCache = new Map<string, JwksEntry>();

class JwksUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JwksUnavailable";
  }
}

export function jwksUrl(teamDomain: string): string {
  return "https://" + teamDomain + "/cdn-cgi/access/certs";
}

// ------------------------------------------------------------------ token plumbing

function base64UrlDecode(part: string): Uint8Array {
  const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  let bin: string;
  try {
    bin = atob(padded);
  } catch {
    throw new Error("malformed token");
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJsonPart(part: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64UrlDecode(part)));
  } catch {
    throw new Error("malformed token");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("malformed token");
  return parsed as Record<string, unknown>;
}

export interface DecodedJwt {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signature: Uint8Array;
  signed: Uint8Array;
}

// Splits and decodes without verifying anything. Callers verify.
export function decodeJwt(token: string): DecodedJwt {
  const parts = token.trim().split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const [h, p, s] = parts as [string, string, string];
  if (!h || !p || !s) throw new Error("malformed token");
  return {
    header: decodeJsonPart(h),
    payload: decodeJsonPart(p),
    signature: base64UrlDecode(s),
    signed: new TextEncoder().encode(h + "." + p),
  };
}

function peekKid(token: string): string | null {
  const parts = token.trim().split(".");
  if (parts.length !== 3 || !parts[0]) throw new Error("malformed token");
  const header = decodeJsonPart(parts[0]);
  return typeof header.kid === "string" ? header.kid : null;
}

function pickKey(keys: Jwk[], kid: string | null): Jwk | null {
  if (kid !== null) return keys.find((k) => k.kid === kid) ?? null;
  return keys.length === 1 ? keys[0] ?? null : null;
}

function audList(aud: unknown): string[] {
  if (typeof aud === "string") return [aud];
  if (Array.isArray(aud)) return aud.filter((a): a is string => typeof a === "string");
  return [];
}

// ------------------------------------------------------------------ verification (pure)

export async function verifyAccessJwt(
  token: string,
  opts: {
    teamDomain: string;
    aud: string;
    ownerEmail: string;
    now: number;
    fetchJwks: (url: string) => Promise<{ keys: JsonWebKey[] }>;
  },
): Promise<{ email: string }> {
  const { header, payload, signature, signed } = decodeJwt(token);
  if (header.alg !== "RS256") throw new Error("unsupported algorithm");
  const kid = typeof header.kid === "string" ? header.kid : null;

  const jwks = await opts.fetchJwks(jwksUrl(opts.teamDomain));
  const keys: Jwk[] = jwks && Array.isArray(jwks.keys) ? (jwks.keys as Jwk[]) : [];
  const jwk = pickKey(keys, kid);
  if (!jwk) throw new Error("unknown key id");
  if (jwk.kty !== "RSA" || typeof jwk.n !== "string" || typeof jwk.e !== "string") throw new Error("unusable key");

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256" },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  } catch {
    throw new Error("unusable key");
  }
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signed);
  if (!ok) throw new Error("bad signature");

  if (payload.iss !== "https://" + opts.teamDomain) throw new Error("wrong issuer");
  if (!opts.aud || !audList(payload.aud).includes(opts.aud)) throw new Error("wrong audience");
  const exp = payload.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= opts.now) throw new Error("expired");
  const nbf = payload.nbf;
  if (typeof nbf === "number" && nbf > opts.now + 60) throw new Error("not yet valid");
  const email = typeof payload.email === "string" ? payload.email.trim() : "";
  if (!email || email.toLowerCase() !== opts.ownerEmail.trim().toLowerCase()) throw new Error("wrong email");
  return { email };
}

// ------------------------------------------------------------------ JWKS cache

function isJwk(v: unknown): v is Jwk {
  return typeof v === "object" && v !== null && typeof (v as Jwk).kty === "string";
}

async function fetchKeySet(url: string): Promise<JwksEntry> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "application/json" } });
  } catch {
    throw new JwksUnavailable("jwks fetch failed");
  }
  if (!res.ok) throw new JwksUnavailable("jwks fetch failed: " + res.status);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new JwksUnavailable("jwks body unreadable");
  }
  const raw = typeof body === "object" && body !== null ? (body as { keys?: unknown }).keys : undefined;
  const keys = Array.isArray(raw) ? raw.filter(isJwk) : [];
  const byKid = new Map<string, Jwk>();
  for (const k of keys) if (typeof k.kid === "string") byKid.set(k.kid, k);
  return { keys, byKid, fetchedAt: Date.now() };
}

// Serves the cached set while it holds the kid the token names; otherwise refetches,
// never more than once a minute. A failed refetch falls back to the cached set.
async function cachedJwks(url: string, kid: string | null): Promise<{ keys: JsonWebKey[] }> {
  const cached = jwksCache.get(url);
  const now = Date.now();
  if (cached) {
    const known = kid !== null && cached.byKid.has(kid);
    const fresh = now - cached.fetchedAt < REFETCH_MIN_MS;
    const young = now - cached.fetchedAt < MAX_AGE_MS;
    if ((known && young) || fresh) return { keys: cached.keys };
  }
  try {
    const entry = await fetchKeySet(url);
    jwksCache.set(url, entry);
    return { keys: entry.keys };
  } catch (e) {
    if (cached) return { keys: cached.keys };
    throw e;
  }
}

// ------------------------------------------------------------------ request gate

function tokenFrom(request: Request): string | null {
  const header = request.headers.get(JWT_HEADER);
  if (header && header.trim()) return header.trim();
  const cookie = request.headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === JWT_COOKIE) {
      const value = part.slice(eq + 1).trim();
      return value || null;
    }
  }
  return null;
}

// The local rule, exactly: DEV_ACTOR_EMAIL set, host localhost or 127.0.0.1, ACCESS_AUD empty.
export function localActor(request: Request, env: Env): string | null {
  const aud = (env.ACCESS_AUD ?? "").trim();
  const dev = (env.DEV_ACTOR_EMAIL ?? "").trim();
  if (aud || !dev) return null;
  let host: string;
  try {
    host = new URL(request.url).hostname;
  } catch {
    return null;
  }
  return LOCAL_HOSTS.has(host) ? dev : null;
}

function deny(status: number, code: string, error: string, detail?: string): Response {
  const body: Record<string, unknown> = { error, code };
  if (detail) body.detail = detail;
  return json(body, status);
}

export async function requireOwner(request: Request, env: Env): Promise<{ email: string; mode: "access" | "dev" }> {
  const aud = (env.ACCESS_AUD ?? "").trim();

  if (!aud) {
    const dev = localActor(request, env);
    if (dev) return { email: dev, mode: "dev" };
    throw deny(503, "access_not_configured", "access not configured");
  }

  const teamDomain = (env.ACCESS_TEAM_DOMAIN ?? "").trim();
  const ownerEmail = (env.OWNER_EMAIL ?? "").trim();
  if (!teamDomain || !ownerEmail) throw deny(503, "access_not_configured", "access not configured");

  const token = tokenFrom(request);
  if (!token) throw deny(401, "unauthorized", "unauthorized");

  let kid: string | null;
  try {
    kid = peekKid(token);
  } catch {
    throw deny(403, "forbidden", "forbidden", "malformed token");
  }

  try {
    const { email } = await verifyAccessJwt(token, {
      teamDomain,
      aud,
      ownerEmail,
      now: Math.floor(Date.now() / 1000),
      fetchJwks: (url) => cachedJwks(url, kid),
    });
    return { email, mode: "access" };
  } catch (e) {
    if (e instanceof JwksUnavailable) throw deny(503, "access_unavailable", "access key set unavailable");
    const reason = e instanceof Error && e.message ? e.message : "verification failed";
    throw deny(403, "forbidden", "forbidden", reason);
  }
}
