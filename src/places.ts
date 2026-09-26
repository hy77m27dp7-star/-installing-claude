// Her places (SPEC_V4 sections 1 and 8): a row per place she has, shadowing an active
// life thread of kind place (joined by the normalised title, since threads are versioned),
// or typed by the owner on the Phone page. A place gets coordinates three ways (a tap on
// the drawn map, typed numbers, one Open-Meteo geocode kept only within 30 km of her
// city) and, once, a picture of the place itself (no person in it) that sits behind the
// chat while a Together scene is there.
//
// The pure half (the normalisers, the outline, the projection, the distance, the season
// and light words, the picture prompt) runs under Node for the unit suite; the D1 half
// reads and writes `places` and `panel_cache`, audited. A place picture is never a
// visual_assets row: it is not a picture of her, so it never enters the approval flow,
// the blacklist, the outfit rule or the character export.
import { assertBudget } from "./budget";
import { auditStmt, dayKey, insertModelRunStmt, newId, nowIso, sha256Hex, usageStmt } from "./db";
import { ApiHttpError } from "./errors";
import { localParts, safeTimezone } from "./life";
import type { LifeThread } from "./life";
import { getImageProvider, imageProviderConfigured, isKeylessImageProvider } from "./providers/index";
import { safeErrorMessage } from "./providers/types";
import { ProviderError } from "./types";
import type { Env, ModelRunRow, Settings } from "./types";
import { geocode, getWeather } from "./weather";
import type { WeatherNow } from "./weather";

export type GeocodedBy = "owner" | "openmeteo" | "map";
export type PlaceLight = "day" | "night";
export type Season = "winter" | "spring" | "summer" | "fall";

// The 0008 columns, snake_case as D1 returns them. `active` and `picture` are computed on
// the way out (a dropped thread keeps its row, listed active false; the R2 key is never
// what a page needs, only whether a picture exists).
export interface PlaceRow {
  id: string;
  thread_id: string | null;
  title: string;
  title_norm: string;
  detail: string | null;
  lat: number | null;
  lon: number | null;
  geocoded_by: GeocodedBy | null;
  picture_key: string | null;
  picture_sha256: string | null;
  picture_bytes: number | null;
  picture_light: PlaceLight | null;
  picture_season: string | null;
  picture_prompt: string | null;
  picture_provider: string | null;
  picture_model: string | null;
  picture_made_at: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
  active?: boolean;
  picture?: boolean;
}

export const PLACE_PREFIX = "places/";
export const PLACE_NEAR_KM = 30;
export const PLACE_PROMPT_MAX = 900;
export const PLACE_COST_DEFAULT = 0.08;
const MAX_TITLE = 300;
const MAX_DETAIL = 2000;
const SLUG_MAX = 40;
const SLUG_ID_CHARS = 6;
const MICRO = 1_000_000;
// weather.ts caps a geocode name at 80 characters (MAX_CITY) and throws 400 past it.
const GEOCODE_MAX_QUERY = 80;
const EARTH_KM = 6371;
const DEFAULT_TZ = "America/New_York";
const PLACE_RUN_KIND = "place" as ModelRunRow["kind"];
// The weather race the panel uses (context.ts does the same): a slow call means the hour decides.
const WEATHER_TIMEOUT_MS = 3500;

// ------------------------------------------------------------------ pure: names

export function placeTitleNorm(title: string): string {
  return String(title ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

// The title lowercased, [^a-z0-9]+ to "-", trimmed of dashes, cut at 40, then "-" and the
// first six characters of the id without its prefix. Stable and ASCII: the R2 key.
export function placeSlug(title: string, id: string): string {
  let base = String(title ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (base.length > SLUG_MAX) base = base.slice(0, SLUG_MAX).replace(/-+$/g, "");
  if (!base) base = "place";
  const raw = String(id ?? "");
  const under = raw.indexOf("_");
  const bare = (under >= 0 ? raw.slice(under + 1) : raw).replace(/[^a-z0-9]/gi, "").toLowerCase();
  return base + "-" + (bare || "000000").slice(0, SLUG_ID_CHARS);
}

export function placeKey(title: string, id: string): string {
  return PLACE_PREFIX + placeSlug(title, id) + ".png";
}

// ------------------------------------------------------------------ pure: the map

// A closed polyline of the Portland peninsula and Back Cove, lat then lon, approximate and
// for the drawing only.
export const PORTLAND_OUTLINE: ReadonlyArray<[number, number]> = [
  [43.669, -70.239], // Fort Allen Park
  [43.672, -70.243], // East End Beach
  [43.676, -70.25], // Tukey's Bridge
  [43.679, -70.26], // Back Cove east shore
  [43.68, -70.27], // Back Cove north
  [43.676, -70.278], // Back Cove west shore
  [43.668, -70.278], // Deering Oaks
  [43.659, -70.283], // Parkside
  [43.65, -70.285], // Western Promenade
  [43.642, -70.278], // Veterans Bridge
  [43.648, -70.262], // Casco Bay Bridge foot
  [43.656, -70.25], // the Old Port waterfront
  [43.66, -70.247], // Ocean Gateway
  [43.665, -70.242], // the Eastern Promenade foot
  [43.669, -70.239], // back to Fort Allen
];

export const PORTLAND_BOUNDS = { latMin: 43.636, latMax: 43.686, lonMin: -70.294, lonMax: -70.232 };
export const MAP_VIEW = { w: 360, h: 240 };

export interface MapBounds { latMin: number; latMax: number; lonMin: number; lonMax: number }
export interface MapView { w: number; h: number }

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// Equirectangular: x grows east, y grows south. A point outside the bounds is clamped to
// the edge and says so.
export function project(lat: number, lon: number, bounds: MapBounds = PORTLAND_BOUNDS, view: MapView = MAP_VIEW): { x: number; y: number; clamped?: true } {
  const la = Number(lat);
  const lo = Number(lon);
  const spanLat = bounds.latMax - bounds.latMin || 1;
  const spanLon = bounds.lonMax - bounds.lonMin || 1;
  const fx = Number.isFinite(lo) ? (lo - bounds.lonMin) / spanLon : 0.5;
  const fy = Number.isFinite(la) ? (bounds.latMax - la) / spanLat : 0.5;
  const cx = clamp01(fx);
  const cy = clamp01(fy);
  const out: { x: number; y: number; clamped?: true } = { x: cx * view.w, y: cy * view.h };
  if (cx !== fx || cy !== fy) out.clamped = true;
  return out;
}

// The inverse, for a tap.
export function unproject(x: number, y: number, bounds: MapBounds = PORTLAND_BOUNDS, view: MapView = MAP_VIEW): { lat: number; lon: number } {
  const fx = view.w ? Number(x) / view.w : 0;
  const fy = view.h ? Number(y) / view.h : 0;
  return {
    lon: bounds.lonMin + clamp01(fx) * (bounds.lonMax - bounds.lonMin),
    lat: bounds.latMax - clamp01(fy) * (bounds.latMax - bounds.latMin),
  };
}

// Haversine, in kilometres.
export function distanceKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const rad = (d: number): number => (d * Math.PI) / 180;
  const dLat = rad(bLat - aLat);
  const dLon = rad(bLon - aLon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

// Within maxKm of her city. Without her coordinates nothing is near: a geocode is kept
// only when it can be checked.
export function isPlaceNearCity(lat: number, lon: number, settings: { herLat?: number | null; herLon?: number | null } | null | undefined, maxKm = PLACE_NEAR_KM): boolean {
  if (!settings || !finite(settings.herLat) || !finite(settings.herLon)) return false;
  if (!finite(lat) || !finite(lon)) return false;
  return distanceKm(lat, lon, settings.herLat, settings.herLon) <= maxKm;
}

// ------------------------------------------------------------------ pure: the picture words

// 12, 1, 2 winter; 3 to 5 spring; 6 to 8 summer; 9 to 11 fall, in her timezone.
export function seasonOf(now: Date, tz: string): Season {
  const m = localParts(now, safeTimezone(tz)).month;
  if (m === 12 || m <= 2) return "winter";
  if (m <= 5) return "spring";
  if (m <= 8) return "summer";
  return "fall";
}

// The weather's own day flag when there is one, else the local hour 6..18 is day.
export function lightOf(now: Date, tz: string, weather: WeatherNow | null | undefined): PlaceLight {
  if (weather && typeof weather.isDay === "boolean") return weather.isDay ? "day" : "night";
  const h = localParts(now, safeTimezone(tz)).hour;
  return h >= 6 && h < 18 ? "day" : "night";
}

function oneLine(s: unknown): string {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

// "{title}{, detail}, in {city}, {season}, {light words}. A real place seen from where a
// person would stand, no people, no faces, no text, no watermark, photographic, one image."
export function placePicturePrompt(place: { title: string; detail: string | null }, city: string, season: string, light: PlaceLight): string {
  const title = oneLine(place.title).replace(/[.,\s]+$/, "");
  const detail = oneLine(place.detail).replace(/[.,\s]+$/, "");
  const where = oneLine(city) || "her city";
  const lightWords = light === "night" ? "at night, street lights and windows lit" : "in daylight";
  const head = `${title}${detail ? ", " + detail : ""}, in ${where}, ${oneLine(season)}, ${lightWords}.`;
  const tail = " A real place seen from where a person would stand, no people, no faces, no text, no watermark, photographic, one image.";
  const full = head + tail;
  if (full.length <= PLACE_PROMPT_MAX) return full;
  // The tail is the law of the picture (no people); it always rides whole.
  return head.slice(0, Math.max(0, PLACE_PROMPT_MAX - tail.length - 1)).replace(/[,\s]+$/, "") + "." + tail;
}

// The price for one place picture: placeCostUsd as stored, the spec default when missing.
export function placeCostUsd(settings: Settings | Record<string, unknown> | null | undefined): number {
  const v = settings ? (settings as Record<string, unknown>).placeCostUsd : undefined;
  return finite(v) && v >= 0 ? v : PLACE_COST_DEFAULT;
}

// ------------------------------------------------------------------ db: shaping

function decorate(row: PlaceRow, active: boolean): PlaceRow {
  const lat = finite(row.lat) ? row.lat : row.lat === null || row.lat === undefined ? null : Number(row.lat);
  const lon = finite(row.lon) ? row.lon : row.lon === null || row.lon === undefined ? null : Number(row.lon);
  return { ...row, lat: finite(lat) ? lat : null, lon: finite(lon) ? lon : null, active, picture: typeof row.picture_key === "string" && row.picture_key.length > 0 };
}

// What a page gets: every column but the R2 key, plus `active` and `picture`.
export function publicPlace(row: PlaceRow): Omit<PlaceRow, "picture_key"> & { active: boolean; picture: boolean } {
  const { picture_key, ...rest } = row;
  return { ...rest, active: row.active !== false, picture: row.picture === true || (typeof picture_key === "string" && picture_key.length > 0) };
}

async function activePlaceThreadIds(db: D1Database): Promise<Set<string>> {
  const r = await db.prepare("SELECT id FROM life_threads WHERE status = ?1 AND kind = ?2").bind("active", "place").all<{ id: string }>();
  return new Set(r.results.map((t) => t.id));
}

function activeOf(row: PlaceRow, activeIds: Set<string>): boolean {
  return row.thread_id === null || row.thread_id === undefined || activeIds.has(row.thread_id);
}

function sortRows(rows: PlaceRow[]): PlaceRow[] {
  return rows.slice().sort((a, b) => {
    const aa = a.active === false ? 1 : 0;
    const bb = b.active === false ? 1 : 0;
    if (aa !== bb) return aa - bb;
    const c = a.created_at.localeCompare(b.created_at);
    return c !== 0 ? c : a.id.localeCompare(b.id);
  });
}

async function readAll(db: D1Database): Promise<PlaceRow[]> {
  const r = await db.prepare("SELECT * FROM places ORDER BY created_at, id").all<PlaceRow>();
  return r.results;
}

async function readOne(db: D1Database, id: string): Promise<PlaceRow | null> {
  if (typeof id !== "string" || !id.trim()) return null;
  return db.prepare("SELECT * FROM places WHERE id = ?1").bind(id).first<PlaceRow>();
}

function requireId(id: unknown): string {
  if (typeof id !== "string" || !id.trim()) throw new ApiHttpError(400, "validation", "place id is required");
  return id.trim();
}

async function requirePlace(db: D1Database, id: string): Promise<PlaceRow> {
  const row = await readOne(db, requireId(id));
  if (!row) throw new ApiHttpError(404, "not_found", "place not found");
  return row;
}

// ------------------------------------------------------------------ db: sync with her life

// A place row shadows the newest active place thread per normalised title (by created_at,
// then id). A head whose title matches a row updates that row's thread_id only when it
// differs; a head with no row gets one (INSERT OR IGNORE). A dropped thread keeps its row.
// Returns every row, active first.
export async function syncPlaces(db: D1Database, threads: LifeThread[]): Promise<PlaceRow[]> {
  const heads = new Map<string, LifeThread>();
  for (const t of Array.isArray(threads) ? threads : []) {
    if (!t || t.kind !== "place" || t.status !== "active") continue;
    const norm = placeTitleNorm(t.title);
    if (!norm) continue;
    const cur = heads.get(norm);
    if (!cur) { heads.set(norm, t); continue; }
    const c = String(t.created_at ?? "").localeCompare(String(cur.created_at ?? ""));
    if (c > 0 || (c === 0 && String(t.id).localeCompare(String(cur.id)) > 0)) heads.set(norm, t);
  }
  const rows = await readAll(db);
  const byNorm = new Map<string, PlaceRow>();
  for (const r of rows) if (!byNorm.has(r.title_norm)) byNorm.set(r.title_norm, r);
  const stmts: D1PreparedStatement[] = [];
  const now = nowIso();
  const inserted: PlaceRow[] = [];
  for (const [norm, head] of heads) {
    const row = byNorm.get(norm);
    if (row) {
      if (row.thread_id !== head.id) {
        stmts.push(db.prepare("UPDATE places SET thread_id = ?2, updated_at = ?3 WHERE id = ?1").bind(row.id, head.id, now));
        row.thread_id = head.id;
        row.updated_at = now;
      }
      continue;
    }
    const fresh: PlaceRow = {
      id: newId("pl"),
      thread_id: head.id,
      title: oneLine(head.title).slice(0, MAX_TITLE),
      title_norm: norm,
      detail: typeof head.detail === "string" && head.detail.trim() ? head.detail.trim().slice(0, MAX_DETAIL) : null,
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
      created_at: now,
      updated_at: now,
    };
    stmts.push(
      db.prepare("INSERT OR IGNORE INTO places (id, thread_id, title, title_norm, detail, lat, lon, geocoded_by, picture_key, picture_sha256, picture_bytes, picture_light, picture_season, picture_prompt, picture_provider, picture_model, picture_made_at, last_used_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?6, ?6)")
        .bind(fresh.id, fresh.thread_id, fresh.title, fresh.title_norm, fresh.detail, now),
    );
    inserted.push(fresh);
    byNorm.set(norm, fresh);
  }
  if (stmts.length) await db.batch(stmts);
  const headIds = new Set(Array.from(heads.values()).map((h) => h.id));
  const all = rows.concat(inserted).map((r) => decorate(r, activeOf(r, headIds)));
  return sortRows(all);
}

export async function listPlaces(db: D1Database): Promise<PlaceRow[]> {
  const [rows, activeIds] = await Promise.all([readAll(db), activePlaceThreadIds(db)]);
  return sortRows(rows.map((r) => decorate(r, activeOf(r, activeIds))));
}

export async function getPlace(db: D1Database, id: string): Promise<PlaceRow | null> {
  const row = await readOne(db, id);
  if (!row) return null;
  const activeIds = await activePlaceThreadIds(db);
  return decorate(row, activeOf(row, activeIds));
}

export async function findPlaceByTitle(db: D1Database, title: string): Promise<PlaceRow | null> {
  const norm = placeTitleNorm(title);
  if (!norm) return null;
  const row = await db.prepare("SELECT * FROM places WHERE title_norm = ?1 ORDER BY created_at, id LIMIT 1").bind(norm).first<PlaceRow>();
  if (!row) return null;
  const activeIds = await activePlaceThreadIds(db);
  return decorate(row, activeOf(row, activeIds));
}

// ------------------------------------------------------------------ db: the owner's writes

function coordinate(v: unknown, name: string, limit: number): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.trim()) : NaN;
  if (!Number.isFinite(n) || n < -limit || n > limit) throw new ApiHttpError(400, "validation", `${name} must be a number between -${limit} and ${limit}`);
  return n;
}

// Both or neither: a pin needs two numbers; clearing clears both.
function coordinates(input: { lat?: unknown; lon?: unknown }): { lat: number | null; lon: number | null } | undefined {
  const lat = coordinate(input.lat, "lat", 90);
  const lon = coordinate(input.lon, "lon", 180);
  if (lat === undefined && lon === undefined) return undefined;
  if (lat === undefined || lon === undefined || (lat === null) !== (lon === null)) {
    throw new ApiHttpError(400, "validation", "lat and lon go together: both numbers, or both empty");
  }
  return { lat, lon };
}

function detailOf(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string") throw new ApiHttpError(400, "validation", "detail must be a string");
  const s = v.trim();
  if (s.length > MAX_DETAIL) throw new ApiHttpError(400, "validation", `detail exceeds ${MAX_DETAIL} characters`);
  return s || null;
}

// A place with no thread: the owner typed one on the Phone page. A title that already
// has a row (by title_norm) answers that row, with the given detail and pin applied to
// it, so the map never carries two pins for one place.
export async function createPlace(
  db: D1Database,
  input: { title: string; detail?: string | null; threadId?: string | null; lat?: number | null; lon?: number | null },
  actor: string,
): Promise<PlaceRow> {
  const title = typeof input.title === "string" ? oneLine(input.title) : "";
  if (!title) throw new ApiHttpError(400, "validation", "title is required");
  if (title.length > MAX_TITLE) throw new ApiHttpError(400, "validation", `title exceeds ${MAX_TITLE} characters`);
  const norm = placeTitleNorm(title);
  const detail = detailOf(input.detail);
  const pin = coordinates(input);
  const threadId = typeof input.threadId === "string" && input.threadId.trim() ? input.threadId.trim() : null;
  const existing = await findPlaceByTitle(db, title);
  if (existing) {
    const patch: { lat?: number | null; lon?: number | null; detail?: string | null; geocodedBy?: "owner" | "map" } = {};
    if (pin) { patch.lat = pin.lat; patch.lon = pin.lon; patch.geocodedBy = "owner"; }
    if (detail !== undefined) patch.detail = detail;
    return Object.keys(patch).length ? updatePlace(db, existing.id, patch, actor) : existing;
  }
  const now = nowIso();
  const row: PlaceRow = {
    id: newId("pl"),
    thread_id: threadId,
    title,
    title_norm: norm,
    detail: detail ?? null,
    lat: pin ? pin.lat : null,
    lon: pin ? pin.lon : null,
    geocoded_by: pin && pin.lat !== null ? "owner" : null,
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
    created_at: now,
    updated_at: now,
  };
  await db.batch([
    db.prepare("INSERT INTO places (id, thread_id, title, title_norm, detail, lat, lon, geocoded_by, picture_key, picture_sha256, picture_bytes, picture_light, picture_season, picture_prompt, picture_provider, picture_model, picture_made_at, last_used_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?9, ?9)")
      .bind(row.id, row.thread_id, row.title, row.title_norm, row.detail, row.lat, row.lon, row.geocoded_by, now),
    auditStmt(db, actor, "place.create", "place", row.id, null, { title: row.title, detail: row.detail, thread_id: row.thread_id, lat: row.lat, lon: row.lon }),
  ]);
  return decorate(row, true);
}

export async function updatePlace(
  db: D1Database,
  id: string,
  patch: { lat?: number | null; lon?: number | null; detail?: string | null; geocodedBy?: "owner" | "map" },
  actor: string,
): Promise<PlaceRow> {
  const before = await requirePlace(db, id);
  const pin = coordinates(patch);
  const detail = detailOf(patch.detail);
  if (patch.geocodedBy !== undefined && patch.geocodedBy !== "owner" && patch.geocodedBy !== "map") {
    throw new ApiHttpError(400, "validation", "geocodedBy must be owner or map");
  }
  if (pin === undefined && detail === undefined) throw new ApiHttpError(400, "validation", "nothing to change");
  const now = nowIso();
  const after: PlaceRow = { ...before, updated_at: now };
  if (pin) {
    after.lat = pin.lat;
    after.lon = pin.lon;
    after.geocoded_by = pin.lat === null ? null : (patch.geocodedBy ?? "owner");
  }
  if (detail !== undefined) after.detail = detail;
  await db.batch([
    db.prepare("UPDATE places SET lat = ?2, lon = ?3, geocoded_by = ?4, detail = ?5, updated_at = ?6 WHERE id = ?1")
      .bind(before.id, after.lat, after.lon, after.geocoded_by, after.detail, now),
    auditStmt(db, actor, "place.update", "place", before.id,
      { lat: before.lat, lon: before.lon, geocoded_by: before.geocoded_by, detail: before.detail },
      { lat: after.lat, lon: after.lon, geocoded_by: after.geocoded_by, detail: after.detail }),
  ]);
  const activeIds = await activePlaceThreadIds(db);
  return decorate(after, activeOf(after, activeIds));
}

// One Open-Meteo search of the title with her city, the first result within 30 km kept.
// The title is cut so the city always rides whole under weather.ts's 80-character cap; a
// 400 from geocode is still a 404 no_match, never the caller's fault. Nothing is written
// on a miss.
export async function geocodePlace(env: Env, db: D1Database, settings: Settings, id: string, actor: string): Promise<PlaceRow> {
  const place = await requirePlace(db, id);
  const city = oneLine(settings.herCity);
  const room = Math.max(1, GEOCODE_MAX_QUERY - (city ? city.length + 2 : 0));
  const query = oneLine(place.title).slice(0, room).trim() + (city ? ", " + city : "");
  let results: Awaited<ReturnType<typeof geocode>>;
  try {
    results = await geocode(env, settings, query);
  } catch (e) {
    if (e instanceof ApiHttpError && e.status === 400) throw new ApiHttpError(404, "no_match", "no place found within 30 km of her city", false);
    throw e;
  }
  const hit = results.find((r) => isPlaceNearCity(r.latitude, r.longitude, settings));
  if (!hit) throw new ApiHttpError(404, "no_match", "no place found within 30 km of her city", false);
  const now = nowIso();
  const after: PlaceRow = { ...place, lat: hit.latitude, lon: hit.longitude, geocoded_by: "openmeteo", updated_at: now };
  await db.batch([
    db.prepare("UPDATE places SET lat = ?2, lon = ?3, geocoded_by = 'openmeteo', updated_at = ?4 WHERE id = ?1").bind(place.id, after.lat, after.lon, now),
    auditStmt(db, actor, "place.geocode", "place", place.id,
      { lat: place.lat, lon: place.lon, geocoded_by: place.geocoded_by },
      { lat: after.lat, lon: after.lon, geocoded_by: "openmeteo", match: hit.name }),
  ]);
  const activeIds = await activePlaceThreadIds(db);
  return decorate(after, activeOf(after, activeIds));
}

// last_used_at: the scene PUT calls it when a Together scene names a known place.
export function touchPlaceStmt(db: D1Database, id: string, now: Date | string): D1PreparedStatement {
  const at = now instanceof Date ? now.toISOString() : String(now);
  return db.prepare("UPDATE places SET last_used_at = ?2 WHERE id = ?1").bind(id, at);
}

// ------------------------------------------------------------------ db: the picture

function toApiError(e: unknown): ApiHttpError {
  if (e instanceof ApiHttpError) return e;
  if (e instanceof ProviderError) {
    const message = safeErrorMessage(e);
    if (e.kind === "config") return new ApiHttpError(503, "provider_not_configured", message, false, e.provider);
    return new ApiHttpError(502, "provider_failed", message, e.retryable, e.kind);
  }
  return new ApiHttpError(500, "image_failed", safeErrorMessage(e), false);
}

// The weather for the light word, within 3.5 s; null (the local hour decides) on off, slow or failed.
async function weatherForLight(env: Env, db: D1Database, settings: Settings, now: Date): Promise<WeatherNow | null> {
  if (settings.weatherProvider === "off") return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), WEATHER_TIMEOUT_MS); });
  try {
    return await Promise.race([getWeather(env, db, settings, now).catch((): null => null), late]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function recordPictureFailure(db: D1Database, args: { provider: string; model: string; latencyMs: number; message: string }): Promise<void> {
  const run: ModelRunRow = {
    id: newId("run"),
    conversation_id: null,
    kind: PLACE_RUN_KIND,
    provider: args.provider,
    model: args.model,
    prompt_version: null,
    input_tokens: 0,
    output_tokens: 0,
    cost_usd_micro: 0,
    latency_ms: args.latencyMs,
    status: "failed",
    error: args.message,
    flags_json: null,
    created_at: nowIso(),
  };
  try {
    await insertModelRunStmt(db, run).run();
  } catch (e) {
    console.warn("place picture failure not recorded", safeErrorMessage(e));
  }
}

// One picture of the place (no person in it): held open by the page like a photo. 404
// unknown; 409 already_generated unless remake; 503 without the image provider; 402
// price_unknown when the price is 0 on a keyed provider; the caps through assertBudget.
export async function makePlacePicture(
  env: Env,
  db: D1Database,
  settings: Settings,
  args: { id: string; remake?: boolean; actor: string; now?: Date; weather?: WeatherNow | null },
): Promise<PlaceRow> {
  const place = await requirePlace(db, args.id);
  if (place.picture_key && args.remake !== true) {
    throw new ApiHttpError(409, "already_generated", "this place already has a picture; remake it to replace it", false, place.id);
  }
  const providerName = settings.imageProvider;
  const model = settings.imageModel;
  if (!imageProviderConfigured(env, providerName)) {
    throw new ApiHttpError(503, "provider_not_configured", `${providerName} image provider not configured`, false, providerName);
  }
  const cost = placeCostUsd(settings);
  if (!(cost > 0) && !isKeylessImageProvider(providerName)) {
    throw new ApiHttpError(402, "price_unknown", "placeCostUsd is 0 on a paid image provider; set the place price on the Model page", false);
  }
  await assertBudget(db, settings, cost);

  const now = args.now instanceof Date ? args.now : new Date();
  const tz = safeTimezone(settings.timezone || DEFAULT_TZ);
  const season = seasonOf(now, tz);
  const weather = args.weather === undefined ? await weatherForLight(env, db, settings, now) : args.weather;
  const light = lightOf(now, tz, weather);
  const prompt = placePicturePrompt({ title: place.title, detail: place.detail }, settings.herCity, season, light);
  const started = Date.now();
  let png: ArrayBuffer;
  let usedModel = model;
  try {
    const provider = getImageProvider(providerName);
    const result = await provider.generateFromText(env, { prompt, model, quality: settings.imageQuality, size: settings.imageSize });
    png = result.png;
    usedModel = result.model || model;
  } catch (e) {
    const err = toApiError(e);
    await recordPictureFailure(db, { provider: providerName, model, latencyMs: Date.now() - started, message: safeErrorMessage(e, 200) });
    console.warn("place picture failed", err.code, err.message);
    throw err;
  }
  const latencyMs = Date.now() - started;
  const sha = await sha256Hex(png);
  const key = placeKey(place.title, place.id);
  await env.MEDIA.put(key, png, { httpMetadata: { contentType: "image/png" } });

  const costMicro = Math.max(0, Math.round(cost * MICRO));
  const madeAt = nowIso();
  const run: ModelRunRow = {
    id: newId("run"),
    conversation_id: null,
    kind: PLACE_RUN_KIND,
    provider: providerName,
    model: usedModel,
    prompt_version: null,
    input_tokens: 0,
    output_tokens: 0,
    cost_usd_micro: costMicro,
    latency_ms: latencyMs,
    status: "ok",
    error: null,
    flags_json: null,
    created_at: madeAt,
  };
  const after: PlaceRow = {
    ...place,
    picture_key: key,
    picture_sha256: sha,
    picture_bytes: png.byteLength,
    picture_light: light,
    picture_season: season,
    picture_prompt: prompt,
    picture_provider: providerName,
    picture_model: usedModel,
    picture_made_at: madeAt,
    updated_at: madeAt,
  };
  await db.batch([
    db.prepare("UPDATE places SET picture_key = ?2, picture_sha256 = ?3, picture_bytes = ?4, picture_light = ?5, picture_season = ?6, picture_prompt = ?7, picture_provider = ?8, picture_model = ?9, picture_made_at = ?10, updated_at = ?10 WHERE id = ?1")
      .bind(place.id, key, sha, after.picture_bytes, light, season, prompt, providerName, usedModel, madeAt),
    insertModelRunStmt(db, run),
    usageStmt(db, dayKey(), providerName, usedModel, 0, 0, costMicro),
    auditStmt(db, args.actor, "place.picture", "place", place.id,
      place.picture_key ? { picture_key: place.picture_key, picture_sha256: place.picture_sha256 } : null,
      { picture_key: key, picture_sha256: sha, picture_bytes: after.picture_bytes, light, season, provider: providerName, model: usedModel, remake: args.remake === true }),
  ]);
  // A remake with a different key drops the old object once the new one is stored. The
  // slug is stable, so most remakes overwrite in place and there is nothing to delete.
  if (place.picture_key && place.picture_key !== key) {
    try {
      await env.MEDIA.delete(place.picture_key);
    } catch (e) {
      console.warn("old place picture not deleted", safeErrorMessage(e));
    }
  }
  const activeIds = await activePlaceThreadIds(db);
  return decorate(after, activeOf(after, activeIds));
}

export async function deletePlacePicture(env: Env, db: D1Database, id: string, actor: string): Promise<PlaceRow> {
  const place = await requirePlace(db, id);
  const now = nowIso();
  if (place.picture_key) {
    try {
      await env.MEDIA.delete(place.picture_key);
    } catch (e) {
      console.warn("place picture not deleted from storage", safeErrorMessage(e));
    }
  }
  await db.batch([
    db.prepare("UPDATE places SET picture_key = NULL, picture_sha256 = NULL, picture_bytes = NULL, picture_light = NULL, picture_season = NULL, picture_prompt = NULL, picture_provider = NULL, picture_model = NULL, picture_made_at = NULL, updated_at = ?2 WHERE id = ?1")
      .bind(place.id, now),
    auditStmt(db, actor, "place.picture_delete", "place", place.id,
      { picture_key: place.picture_key, picture_sha256: place.picture_sha256 }, null),
  ]);
  const after: PlaceRow = {
    ...place,
    picture_key: null,
    picture_sha256: null,
    picture_bytes: null,
    picture_light: null,
    picture_season: null,
    picture_prompt: null,
    picture_provider: null,
    picture_model: null,
    picture_made_at: null,
    updated_at: now,
  };
  const activeIds = await activePlaceThreadIds(db);
  return decorate(after, activeOf(after, activeIds));
}

// GET /media/place/:id: image/png, private and never cached; 404 without a picture.
export async function servePlacePicture(env: Env, db: D1Database, id: string): Promise<Response> {
  const row = await readOne(db, typeof id === "string" ? id : "");
  if (!row || !row.picture_key) return new Response("not found", { status: 404, headers: { "cache-control": "private, no-store" } });
  const obj = await env.MEDIA.get(row.picture_key);
  if (!obj) return new Response("not found", { status: 404, headers: { "cache-control": "private, no-store" } });
  const headers = new Headers({ "content-type": "image/png", "cache-control": "private, no-store", "x-content-type-options": "nosniff" });
  if (typeof obj.size === "number") headers.set("content-length", String(obj.size));
  return new Response(obj.body, { status: 200, headers });
}
