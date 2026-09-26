// Weather where she lives (SPEC_V3 section DD): Open-Meteo, free and keyless, read once
// every 20 minutes into weather_cache and rendered as one line she knows the way a person
// knows the weather. A slow or failed call produces no line, never a made-up one: the
// fetch has a 3 s timeout and context assembly runs it beside the state load. Geocoding
// is the owner's action from the Model panel; settings never call out on their own.
//
// The pure half (the WMO words, the cache freshness, the two readers, the two URLs) runs
// under Node for the unit suite. Nothing here reads a key.
import { ApiHttpError } from "./errors";
import type { Env } from "./types";

export type WeatherProviderName = "openmeteo" | "stub" | "off";
export type WeatherUnits = "fahrenheit" | "celsius";

export interface WeatherNow {
  temp: number;
  feels: number;
  units: WeatherUnits;
  code: number;
  words: string;
  isDay: boolean;
  windMph: number;
  precip: number;
  // Local wall-clock ISO strings as Open-Meteo gives them ("2026-09-24T06:33"), or null.
  sunrise: string | null;
  sunset: string | null;
  fetchedAt: string;
}

export interface GeoResult {
  name: string;
  latitude: number;
  longitude: number;
  timezone: string;
  country?: string;
  admin1?: string;
}

// The settings this module reads (optional so an older Settings shape still resolves;
// `timezone` keeps the v1 shape overlapping for the weak-type check).
export interface WeatherSettings {
  herCity?: string;
  herLat?: number | null;
  herLon?: number | null;
  weatherProvider?: string;
  weatherUnits?: string;
  timezone?: string;
}

export const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
export const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
export const CACHE_FRESH_MS = 20 * 60 * 1000;
export const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const FETCH_TIMEOUT_MS = 3000;
export const GEOCODE_TIMEOUT_MS = 5000;
export const GEOCODE_MAX = 5;
const MAX_CITY = 80;
const DEFAULT_TZ = "America/New_York";
const STUB_PREFIX = "zzzz";

// ------------------------------------------------------------------ pure

// WMO weather interpretation codes, in her words.
export function wmoWords(code: number): string {
  const c = Number.isFinite(code) ? Math.round(code) : -1;
  if (c === 0) return "clear";
  if (c === 1 || c === 2) return "mostly clear";
  if (c === 3) return "overcast";
  if (c === 45 || c === 48) return "fog";
  if (c >= 51 && c <= 57) return "drizzle";
  if (c >= 61 && c <= 67) return "rain";
  if (c >= 71 && c <= 77) return "snow";
  if (c >= 80 && c <= 82) return "showers";
  if (c === 85 || c === 86) return "snow showers";
  if (c >= 95 && c <= 99) return "a storm";
  return "";
}

export function isWeatherProvider(v: unknown): v is WeatherProviderName {
  return v === "openmeteo" || v === "stub" || v === "off";
}

export function isWeatherUnits(v: unknown): v is WeatherUnits {
  return v === "fahrenheit" || v === "celsius";
}

export function weatherProviderOf(settings: WeatherSettings | null | undefined): WeatherProviderName {
  const p = settings ? settings.weatherProvider : undefined;
  return isWeatherProvider(p) ? p : "openmeteo";
}

export function weatherUnitsOf(settings: WeatherSettings | null | undefined): WeatherUnits {
  const u = settings ? settings.weatherUnits : undefined;
  return isWeatherUnits(u) ? u : "fahrenheit";
}

function finite(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

// Her coordinates when both are set and in range; null otherwise (the line is off).
export function herCoordinates(settings: WeatherSettings | null | undefined): { lat: number; lon: number } | null {
  if (!settings) return null;
  const lat = settings.herLat;
  const lon = settings.herLon;
  if (!finite(lat) || !finite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

export function isFresh(fetchedAt: string | null | undefined, now: Date, freshMs = CACHE_FRESH_MS): boolean {
  if (typeof fetchedAt !== "string") return false;
  const t = Date.parse(fetchedAt);
  if (!Number.isFinite(t)) return false;
  const age = now.getTime() - t;
  return age >= 0 && age < freshMs;
}

export function cacheKey(lat: number, lon: number, units: WeatherUnits): string {
  return `${lat},${lon},${units}`;
}

export function forecastUrl(lat: number, lon: number, tz: string, units: WeatherUnits): string {
  const q = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: "temperature_2m,apparent_temperature,is_day,precipitation,rain,showers,snowfall,weather_code,cloud_cover,wind_speed_10m",
    daily: "sunrise,sunset,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
    timezone: tz && tz.trim() ? tz.trim() : DEFAULT_TZ,
    forecast_days: "1",
    temperature_unit: units,
    wind_speed_unit: "mph",
  });
  return FORECAST_URL + "?" + q.toString();
}

export function geocodeUrl(name: string, count: number = GEOCODE_MAX): string {
  const n = Number.isInteger(count) && count >= 1 && count <= 100 ? count : GEOCODE_MAX;
  const q = new URLSearchParams({ name, count: String(n), language: "en", format: "json" });
  return GEOCODE_URL + "?" + q.toString();
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

// The geocoding response: { results: [{ name, latitude, longitude, timezone, country, admin1 }] }.
// Open-Meteo omits empty fields, so a missing `results` reads as [] (a mistyped city
// answers an empty list, never a throw).
export function readGeocode(json: unknown): GeoResult[] {
  if (typeof json !== "object" || json === null) return [];
  const list = (json as { results?: unknown }).results;
  if (!Array.isArray(list)) return [];
  const out: GeoResult[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    const name = str(r.name);
    if (!name || !finite(r.latitude) || !finite(r.longitude)) continue;
    const g: GeoResult = { name, latitude: r.latitude, longitude: r.longitude, timezone: str(r.timezone) ?? DEFAULT_TZ };
    const country = str(r.country);
    const admin1 = str(r.admin1);
    if (country) g.country = country;
    if (admin1) g.admin1 = admin1;
    out.push(g);
    if (out.length >= GEOCODE_MAX) break;
  }
  return out;
}

// The forecast response: { current: {...}, daily: { sunrise: [..], sunset: [..], ... } }.
// Null when the current block is missing or carries no temperature.
export function readForecast(json: unknown, units: WeatherUnits, fetchedAt: string): WeatherNow | null {
  if (typeof json !== "object" || json === null) return null;
  const cur = (json as { current?: unknown }).current;
  if (typeof cur !== "object" || cur === null) return null;
  const c = cur as Record<string, unknown>;
  if (!finite(c.temperature_2m)) return null;
  const daily = (json as { daily?: unknown }).daily;
  const d = typeof daily === "object" && daily !== null ? (daily as Record<string, unknown>) : {};
  const first = (v: unknown): string | null => (Array.isArray(v) && typeof v[0] === "string" ? v[0] : null);
  const code = finite(c.weather_code) ? Math.round(c.weather_code) : -1;
  const isDay = c.is_day === 1 || c.is_day === true || c.is_day === "1";
  return {
    temp: c.temperature_2m,
    feels: finite(c.apparent_temperature) ? c.apparent_temperature : c.temperature_2m,
    units,
    code,
    words: wmoWords(code),
    isDay,
    windMph: finite(c.wind_speed_10m) ? c.wind_speed_10m : 0,
    precip: finite(c.precipitation) ? c.precipitation : 0,
    sunrise: first(d.sunrise),
    sunset: first(d.sunset),
    fetchedAt,
  };
}

// The stub: 68F clear, day (SPEC_V3 "Stub additions").
export function stubWeather(units: WeatherUnits, fetchedAt: string): WeatherNow {
  const f = units === "fahrenheit";
  return {
    temp: f ? 68 : 20,
    feels: f ? 68 : 20,
    units,
    code: 0,
    words: "clear",
    isDay: true,
    windMph: 5,
    precip: 0,
    sunrise: "2026-09-24T06:41",
    sunset: "2026-09-24T19:02",
    fetchedAt,
  };
}

// The geocode stub: one result, Stubtown, for any name except one starting with "zzzz".
export function stubGeocode(name: string): GeoResult[] {
  const n = typeof name === "string" ? name.trim().toLowerCase() : "";
  if (!n || n.startsWith(STUB_PREFIX)) return [];
  return [{ name: "Stubtown", latitude: 40.7, longitude: -74.0, timezone: "America/New_York", country: "United States", admin1: "New York" }];
}

// ------------------------------------------------------------------ cache (db)

interface CacheRow { k: string; json: string; fetched_at: string }

async function readCache(db: D1Database, key: string): Promise<CacheRow | null> {
  try {
    return await db.prepare("SELECT k, json, fetched_at FROM weather_cache WHERE k = ?1").bind(key).first<CacheRow>();
  } catch {
    return null;
  }
}

async function writeCache(db: D1Database, key: string, w: WeatherNow): Promise<void> {
  try {
    await db.prepare("INSERT INTO weather_cache (k, json, fetched_at) VALUES (?1, ?2, ?3) ON CONFLICT(k) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at")
      .bind(key, JSON.stringify(w), w.fetchedAt).run();
  } catch (e) {
    console.warn("weather cache not written", e instanceof Error ? e.name : "error");
  }
}

// Rows older than `olderThan` go (the nightly maintenance runs this).
export function purgeCacheStmt(db: D1Database, olderThan: Date): D1PreparedStatement {
  return db.prepare("DELETE FROM weather_cache WHERE fetched_at < ?1").bind(olderThan.toISOString());
}

// ------------------------------------------------------------------ the two calls

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error("status " + res.status);
  return res.json();
}

export function weatherEnabled(settings: WeatherSettings | null | undefined): boolean {
  const provider = weatherProviderOf(settings);
  if (provider === "off") return false;
  if (provider === "stub") return true;
  return herCoordinates(settings) !== null;
}

// The weather right now, from the cache when it is under 20 minutes old, else from
// Open-Meteo within 3 s. Null on off, on no coordinates, and on any failure.
export async function getWeather(_env: Env, db: D1Database, settings: WeatherSettings | null | undefined, now: Date = new Date()): Promise<WeatherNow | null> {
  const provider = weatherProviderOf(settings);
  const units = weatherUnitsOf(settings);
  const at = now.toISOString();
  if (provider === "off") return null;
  if (provider === "stub") return stubWeather(units, at);
  const coords = herCoordinates(settings);
  if (!coords) return null;
  const key = cacheKey(coords.lat, coords.lon, units);
  const cached = await readCache(db, key);
  if (cached && isFresh(cached.fetched_at, now)) {
    try {
      const parsed = JSON.parse(cached.json) as WeatherNow;
      if (parsed && finite(parsed.temp)) return { ...parsed, units, fetchedAt: cached.fetched_at };
    } catch {
      /* a broken cache row is refetched */
    }
  }
  const tz = settings && typeof settings.timezone === "string" && settings.timezone.trim() ? settings.timezone.trim() : DEFAULT_TZ;
  let json: unknown;
  try {
    json = await fetchJson(forecastUrl(coords.lat, coords.lon, tz, units), FETCH_TIMEOUT_MS);
  } catch (e) {
    console.warn("weather skipped", e instanceof Error ? e.name : "error");
    return null;
  }
  const w = readForecast(json, units, at);
  if (!w) return null;
  await writeCache(db, key, w);
  return w;
}

// Up to five places for a name, for the owner to pick from. The stub answers Stubtown
// (none for a name starting "zzzz"); Open-Meteo otherwise. A failed call is a 502.
// `count`: how many results to ask for (default GEOCODE_MAX; the places geocode asks for
// more and lets its own distance filter pick).
export async function geocode(_env: Env, settings: WeatherSettings | null | undefined, name: string, count: number = GEOCODE_MAX): Promise<GeoResult[]> {
  const n = typeof name === "string" ? name.trim() : "";
  if (!n) throw new ApiHttpError(400, "validation", "name is required");
  if (n.length > MAX_CITY) throw new ApiHttpError(400, "validation", `name exceeds ${MAX_CITY} characters`);
  if (weatherProviderOf(settings) === "stub") return stubGeocode(n);
  let json: unknown;
  try {
    json = await fetchJson(geocodeUrl(n, count), GEOCODE_TIMEOUT_MS);
  } catch (e) {
    const cls = e instanceof Error ? e.name : "error";
    throw new ApiHttpError(502, "provider_failed", "geocoding did not answer", true, cls === "TimeoutError" ? "timeout" : "network");
  }
  return readGeocode(json);
}
