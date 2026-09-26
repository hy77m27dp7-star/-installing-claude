// Fixtures for the v4 unit tests (SPEC_V4). Builds on helpers.mjs, helpers_v2.mjs and
// helpers_v3.mjs and never changes them. Plain Node 22, no Workers runtime.
//
// As in v3, the lanes land their modules in parallel: `loadSrcIfPresent` and `guard` from
// helpers_v3.mjs make a missing module read as skipped, never as passed, and the integrator
// runs every file once the tree is whole.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { settingsV3, T0 } from "./helpers_v3.mjs";

export { loadSrcIfPresent, loadFileIfPresent, guard, firstExport, T0, NOW, DAY_MS, daysAgo } from "./helpers_v3.mjs";

// ------------------------------------------------------------------ files

// True when a public file (relative to the repo root) is in the tree.
export function publicFileExists(relative) {
  return existsSync(fileURLToPath(new URL("../../public/" + relative, import.meta.url)));
}

// ------------------------------------------------------------------ v4 rows

export function placeRow(overrides = {}) {
  const title = overrides.title ?? "the harbour bench";
  return {
    id: "pl_test0001",
    thread_id: null,
    title,
    title_norm: title.toLowerCase().replace(/\s+/g, " ").trim(),
    detail: null,
    lat: null,
    lon: null,
    geocoded_by: null,
    picture_key: null,
    picture_sha256: null,
    picture_bytes: null,
    picture_light: null,
    picture_season: null,
    picture_prompt: null,
    picture_provider: null,
    picture_model: null,
    picture_made_at: null,
    last_used_at: null,
    created_at: T0,
    updated_at: T0,
    ...overrides,
  };
}

export function spotifyAuthRow(overrides = {}) {
  return {
    id: "owner",
    status: "connected",
    state: null,
    refresh_token: "stub-refresh-SECRET-0001",
    access_token: "stub-access-SECRET-0002",
    access_expires_at: "2026-09-29T20:10:00.000Z",
    scope: "playlist-modify-private playlist-read-private",
    spotify_user_id: "stublistener",
    display_name: "Stub Listener",
    created_at: T0,
    updated_at: T0,
    ...overrides,
  };
}

// A call-face clip row (SPEC_V4 section 2): role callface, file under videos/, the kind in
// notes ("callface:<kind>" once a candidate; a claim note while generating).
export function callfaceRow(overrides = {}) {
  const kind = overrides.kind ?? "idle";
  const { kind: _k, ...rest } = overrides;
  return {
    id: "vid_face_" + kind,
    file: "videos/vid_face_" + kind + ".mp4",
    role: "callface",
    sha256: "cd".repeat(32),
    bytes: 4096,
    approval_status: "approved",
    conversation_id: null,
    message_id: null,
    prompt: "she sits still",
    provider: "stub",
    model: "gen4_turbo",
    notes: "callface:" + kind,
    created_at: "2026-09-29T18:00:00.000Z",
    decided_at: "2026-09-29T18:05:00.000Z",
    ...rest,
  };
}

// Secret-looking values that must never leave through a view, an audit row or an export.
export const SPOTIFY_SECRET_VALUES = ["SECRET-0001", "SECRET-0002", "stub-refresh", "refresh_token"];

// ------------------------------------------------------------------ v4 settings

// The v3 test settings plus every v4 default of the spec table (nine keys) and the four the
// amendment names (spotifyPlayer, elevenLabsModel, elevenLabsTtsPricePer1kChars,
// videoMarkerEnabled).
export function settingsV4(overrides = {}) {
  return settingsV3({
    avatarAssetId: "master-05",
    callFaceProvider: "clips",
    callFaceSourceAssetId: "master-00",
    hisFaceInPhotos: true,
    spotifyEnabled: false,
    spotifyPlaylistId: "",
    spotifyPlaylistName: "songs from avelie",
    placeCostUsd: 0.08,
    listeningLineEnabled: true,
    spotifyPlayer: "sdk",
    elevenLabsModel: "eleven_multilingual_v2",
    elevenLabsTtsPricePer1kChars: 0.3,
    videoMarkerEnabled: true,
    ...overrides,
  });
}

// The SPEC_V4 settings table: key -> [default, one good value, one bad value].
export const V4_SETTINGS_TABLE = {
  avatarAssetId: ["master-05", "master-02", "master-09"],
  callFaceProvider: ["clips", "off", "hedra"],
  callFaceSourceAssetId: ["master-00", "master-04", "master-6"],
  hisFaceInPhotos: [true, false, "yes"],
  spotifyEnabled: [false, true, "on"],
  spotifyPlaylistId: ["", "37i9dQZF1DXcBWIGoYBM5M", "not a playlist id!"],
  spotifyPlaylistName: ["songs from avelie", "her songs", "x".repeat(101)],
  placeCostUsd: [0.08, 1, -1],
  listeningLineEnabled: [true, false, 1],
};

// Amendment A1, A2 and A3 (SPEC_V4 A4 names them for the pipeline lane).
export const V4_AMENDMENT_SETTINGS_TABLE = {
  spotifyPlayer: ["sdk", "embed", "cast"],
  elevenLabsModel: ["eleven_multilingual_v2", "eleven_turbo_v2_5", "x".repeat(61)],
  elevenLabsTtsPricePer1kChars: [0.3, 1, -1],
  videoMarkerEnabled: [true, false, "yes"],
};

// ------------------------------------------------------------------ a fake R2 bucket

// get, put, delete and head over a Map; every call recorded in `log`. `get` answers an
// object with arrayBuffer(), a readable body, size and httpMetadata, the way a Worker reads
// one; null when the key is not there.
export function fakeR2(initial = {}) {
  const store = new Map();
  const log = [];
  for (const [k, v] of Object.entries(initial)) store.set(k, { bytes: toBuffer(v), contentType: null });
  const objectOf = (key) => {
    const entry = store.get(key);
    if (!entry) return null;
    const bytes = entry.bytes;
    return {
      key,
      size: bytes.byteLength,
      httpMetadata: entry.contentType ? { contentType: entry.contentType } : {},
      async arrayBuffer() { return bytes.slice(0); },
      get body() {
        return new ReadableStream({
          start(controller) { controller.enqueue(new Uint8Array(bytes.slice(0))); controller.close(); },
        });
      },
      writeHttpMetadata(headers) { if (entry.contentType) headers.set("content-type", entry.contentType); },
    };
  };
  return {
    store,
    log,
    has: (key) => store.has(key),
    bytesOf: (key) => (store.has(key) ? store.get(key).bytes : null),
    async get(key) { log.push({ op: "get", key }); return objectOf(key); },
    async head(key) { log.push({ op: "head", key }); const o = objectOf(key); return o ? { key, size: o.size, httpMetadata: o.httpMetadata } : null; },
    async put(key, value, options) {
      log.push({ op: "put", key, options });
      store.set(key, { bytes: toBuffer(value), contentType: options && options.httpMetadata ? options.httpMetadata.contentType ?? null : null });
      return { key };
    },
    async delete(key) { log.push({ op: "delete", key }); for (const k of Array.isArray(key) ? key : [key]) store.delete(k); },
  };
}

function toBuffer(v) {
  if (v instanceof ArrayBuffer) return v.slice(0);
  if (ArrayBuffer.isView(v)) return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);
  if (typeof v === "string") return new TextEncoder().encode(v).buffer;
  if (v && typeof v === "object" && typeof v.arrayBuffer === "function") throw new Error("fakeR2: pass bytes, not a stream");
  return new ArrayBuffer(0);
}

// ------------------------------------------------------------------ a recording fetch

// A fetch stand-in: every call recorded in `requests` ({ method, url, headers, body, json });
// `handler(request)` answers a Response, or plain data (JSON 200), or `{ status, json }`,
// or `{ status, text }`. Without a handler every URL is 404.
export function fakeFetch(handler = null) {
  const requests = [];
  const f = async (url, init = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const headers = {};
    const h = init.headers;
    if (h instanceof Headers) h.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    else if (Array.isArray(h)) for (const [k, v] of h) headers[String(k).toLowerCase()] = String(v);
    else if (h && typeof h === "object") for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = String(v);
    let body = init.body ?? null;
    let json = null;
    if (typeof body === "string") {
      try { json = JSON.parse(body); } catch { json = null; }
    } else if (body instanceof URLSearchParams) {
      body = body.toString();
      json = Object.fromEntries(new URLSearchParams(body));
    }
    const req = { method, url: String(url), headers, body, json };
    requests.push(req);
    const answer = handler ? await handler(req) : null;
    if (answer instanceof Response) return answer;
    if (answer === null || answer === undefined) return new Response("not found", { status: 404 });
    if (typeof answer === "object" && ("status" in answer) && ("json" in answer || "text" in answer)) {
      const status = answer.status ?? 200;
      if ("json" in answer) return new Response(JSON.stringify(answer.json), { status, headers: { "content-type": "application/json" } });
      return new Response(String(answer.text ?? ""), { status, headers: { "content-type": answer.contentType ?? "text/plain" } });
    }
    return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
  };
  f.requests = requests;
  return f;
}

// The JSON of a value with every token-looking key scanned: true when none of `needles`
// appears anywhere in it (a view, an audit row, an export).
export function carriesNone(value, needles) {
  const text = JSON.stringify(value) ?? "";
  return needles.every((n) => !text.includes(n));
}
