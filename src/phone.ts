// Her phone, live (SPEC_V4 section 1): his window on her day right now. Where she is,
// the weather she is standing in, what she is wearing, her mood on its clock, what she
// wants and the asks still open, today's rows, what she is listening to, and her places
// on the drawn map. Every line comes from data that already exists; the panel is his,
// outside the story, and nothing here enters a prompt.
//
// The one paid line: "listening to", one small call a day on the story performer, cached
// per local day in panel_cache, under the caps (kind listening). It comes from her own
// facts; his Spotify is never read for it.
//
// The pure half (LISTENING_PREFIX, listeningSystem, parseListening, listeningCacheKey)
// runs under Node for the unit suite.
import { assertBudget, costMicro, estimateUsd } from "./budget";
import { dayKey, getCurrentState, insertModelRunStmt, listAssets, listFacts, newId, nowIso, usageStmt } from "./db";
import { ApiHttpError } from "./errors";
import { outfitNow, timeOfDay, todayRows } from "./grounding";
import type { GroundingRow, Outfit, TimeOfDay } from "./grounding";
import { WEEKDAYS, formatClock, listThreads, localParts, safeTimezone, whereSheIs } from "./life";
import { MAP_VIEW, PORTLAND_BOUNDS, PORTLAND_OUTLINE, placeTitleNorm, project, syncPlaces } from "./places";
import type { PlaceRow } from "./places";
import { getTextProvider, providerConfigured } from "./providers/index";
import { safeErrorMessage } from "./providers/types";
import type { Env, FactRow, ModelRunRow, RelationshipState, SceneState, Settings } from "./types";
import { listAsks, listWants, moodNow, wantsSettings } from "./wants";
import type { MoodPhase } from "./wants";
import { getWeather } from "./weather";
import type { WeatherNow } from "./weather";

export interface PhoneState {
  now: string;
  tz: string;
  localClock: string;
  weekday: string;
  timeOfDay: TimeOfDay;
  where: { busy: boolean; label: string | null; until: string | null };
  scene: { status: string; location: string | null };
  weather: WeatherNow | null;
  city: string;
  outfit: Outfit | null;
  mood: { mood: string; phase: Exclude<MoodPhase, "none">; setAt: string | null; days: number; ageDays: number; fraction: number } | null;
  wants: Array<{ id: string; title: string; progress: number; status: string; lastMoved: string | null; nextStep: string | null }>;
  asks: Array<{ id: string; text: string; askedAt: string; broughtUp: number }>;
  today: GroundingRow[];
  listening: { artist: string; title: string; line: string; day: string } | null;
  places: Array<{ id: string; title: string; detail: string | null; lat: number | null; lon: number | null; active: boolean; picture: boolean; here: boolean }>;
  map: { bounds: typeof PORTLAND_BOUNDS; view: typeof MAP_VIEW; outline: Array<{ x: number; y: number }> };
}

export type Listening = PhoneState["listening"];

export const LISTENING_PREFIX = "Name one real song";
export const LISTENING_MAX_TOKENS = 120;
export const LISTENING_CACHE_PREFIX = "listening:";
export const LISTENING_USER = "What are you listening to right now?";
const LISTENING_FACT_SUBJECTS: ReadonlySet<string> = new Set(["music", "singing", "film", "everyday"]);
const LISTENING_FACTS_MAX = 12;
const LISTENING_FIELD_MAX = 120;
const LISTENING_LINE_MAX = 90;
const WEATHER_TIMEOUT_MS = 3500;
const DEFAULT_TZ = "America/New_York";
const LISTENING_RUN_KIND = "listening" as ModelRunRow["kind"];
// How long a claimed or failed day row keeps another call away.
export const LISTENING_RETRY_MS = 10 * 60 * 1000;
const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);
const ELLIPSIS = String.fromCharCode(0x2026);
const DASHES_RE = new RegExp("\\s*[" + EM_DASH + EN_DASH + "]\\s*", "g");
const ELLIPSIS_RE = new RegExp(ELLIPSIS, "g");

// ------------------------------------------------------------------ pure

function oneLine(s: unknown): string {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

export function cleanTypography(s: string): string {
  return String(s ?? "").replace(DASHES_RE, " -- ").replace(ELLIPSIS_RE, "...");
}

// The facts that carry her taste: scope avelie, subject music, singing, film or everyday,
// and only what she has told him (disclosed). An untold fact (the open mics, the private
// clips) never reaches his panel through this line before she chooses to say it.
export function listeningFacts(facts: FactRow[]): FactRow[] {
  const out: FactRow[] = [];
  for (const f of Array.isArray(facts) ? facts : []) {
    if (!f || f.scope !== "avelie" || f.status !== "approved") continue;
    if (Number(f.disclosed) !== 1) continue;
    const subject = typeof f.subject === "string" ? f.subject.trim().toLowerCase() : "";
    if (!LISTENING_FACT_SUBJECTS.has(subject)) continue;
    if (typeof f.fact !== "string" || !f.fact.trim()) continue;
    out.push(f);
    if (out.length >= LISTENING_FACTS_MAX) break;
  }
  return out;
}

// The system text. Starts with LISTENING_PREFIX (the stub's key); names no artist and
// never "his".
export function listeningSystem(facts: FactRow[]): string {
  const lines = listeningFacts(facts).map((f) => "- " + oneLine(f.fact));
  const taste = lines.length ? "\n" + lines.join("\n") + "\n" : " (nothing written down yet; a singer in her early twenties who likes voices with room to grow)\n";
  return (
    LISTENING_PREFIX +
    " by a real artist Avelie might be listening to right now, from her own taste, never anyone else's. Her taste, from her record:" +
    taste +
    'Answer only JSON: {"artist": "...", "title": "...", "line": "one short lowercase line in her texting voice about why, under 90 characters, no emoji"}.'
  );
}

function field(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = cleanTypography(oneLine(v));
  if (!s || s.length > max) return null;
  return s;
}

function extractJson(text: string): unknown {
  const raw = String(text ?? "").trim();
  const candidates: string[] = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  if (fence && fence[1]) candidates.push(fence[1].trim());
  candidates.push(raw);
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(raw.slice(first, last + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      /* the next shape */
    }
  }
  return null;
}

// A tolerant JSON read: plain, fenced, or wrapped in words. Fields 1..120 characters, the
// line typography-cleaned and cut at 90. Null on anything else.
export function parseListening(text: string): { artist: string; title: string; line: string } | null {
  const obj = extractJson(text);
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  const artist = field(o.artist, LISTENING_FIELD_MAX);
  const title = field(o.title, LISTENING_FIELD_MAX);
  if (!artist || !title) return null;
  let line = field(o.line, LISTENING_FIELD_MAX) ?? "";
  if (line.length > LISTENING_LINE_MAX) line = line.slice(0, LISTENING_LINE_MAX - 3).trimEnd() + "...";
  return { artist, title, line };
}

// "YYYY-MM-DD" of an instant in her timezone.
export function localDayKey(now: Date, tz: string): string {
  const p = localParts(now, safeTimezone(tz));
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function listeningCacheKey(now: Date, tz: string): string {
  return LISTENING_CACHE_PREFIX + localDayKey(now, tz);
}

function tzOf(settings: Settings | null | undefined): string {
  const tz = settings && typeof settings.timezone === "string" && settings.timezone.trim() ? settings.timezone.trim() : DEFAULT_TZ;
  return safeTimezone(tz);
}

// ------------------------------------------------------------------ the listening line

interface CacheRow { k: string; json: string; fetched_at: string }

export async function readListening(db: D1Database, key: string): Promise<{ hit: boolean; value: Listening }> {
  let row: CacheRow | null = null;
  try {
    row = await db.prepare("SELECT k, json, fetched_at FROM panel_cache WHERE k = ?1").bind(key).first<CacheRow>();
  } catch {
    return { hit: false, value: null };
  }
  if (!row || typeof row.json !== "string") return { hit: false, value: null };
  try {
    const v = JSON.parse(row.json) as Record<string, unknown> | null;
    if (!v || typeof v !== "object") return { hit: false, value: null };
    if (v.none === true) return { hit: true, value: null };
    const parsed = parseListening(JSON.stringify(v));
    if (!parsed) return { hit: false, value: null };
    return { hit: true, value: { ...parsed, day: typeof v.day === "string" ? v.day : key.slice(LISTENING_CACHE_PREFIX.length) } };
  } catch {
    return { hit: false, value: null };
  }
}

function writeListeningStmt(db: D1Database, key: string, value: unknown, at: string): D1PreparedStatement {
  return db.prepare("INSERT INTO panel_cache (k, json, fetched_at) VALUES (?1, ?2, ?3) ON CONFLICT(k) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at")
    .bind(key, JSON.stringify(value), at);
}

function errorClass(e: unknown): string {
  if (e instanceof ApiHttpError) return e.code;
  return e instanceof Error ? e.name : "error";
}

// listeningLineEnabled false -> null; the day's cache row -> its value; else one call on
// the story performer under the caps, recorded as a model_runs row of kind listening, the
// answer cached (a null answer too, so a refusal costs one call a day, not one per load).
// The day's row is claimed before the call, so two panel loads at once (the chat drawer
// and the Phone page) pay once; a claim or a failed call holds the row LISTENING_RETRY_MS,
// so a failing provider is asked again after ten minutes, not on every one-minute refresh.
// Never throws: the panel is never the caps' to break, and a failed call is a null line.
export async function listeningNow(env: Env, db: D1Database, settings: Settings, now: Date = new Date()): Promise<Listening> {
  const enabled = (settings as unknown as Record<string, unknown>).listeningLineEnabled;
  if (enabled === false) return null;
  const tz = tzOf(settings);
  const key = listeningCacheKey(now, tz);
  const day = key.slice(LISTENING_CACHE_PREFIX.length);
  const cached = await readListening(db, key);
  if (cached.hit) return cached.value;

  const providerName = settings.provider;
  const model = settings.model;
  if (!providerConfigured(env, providerName)) return null;
  let facts: FactRow[] = [];
  try {
    facts = await listFacts(db, "avelie");
  } catch (e) {
    console.warn("listening: facts skipped", errorClass(e));
  }
  const system = listeningSystem(facts);
  try {
    await assertBudget(db, settings, estimateUsd(settings, model, system.length + LISTENING_USER.length, LISTENING_MAX_TOKENS));
  } catch (e) {
    console.warn("listening line skipped", errorClass(e));
    return null;
  }
  try {
    const claimAt = nowIso();
    const staleBefore = new Date(Date.now() - LISTENING_RETRY_MS).toISOString();
    const claim = await db.prepare(
      "INSERT INTO panel_cache (k, json, fetched_at) VALUES (?1, ?2, ?3) ON CONFLICT(k) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at WHERE panel_cache.fetched_at < ?4",
    ).bind(key, JSON.stringify({ pending: true, day }), claimAt, staleBefore).run();
    if (!(Number(claim.meta?.changes ?? 0) > 0)) return null;
  } catch (e) {
    console.warn("listening: claim skipped", errorClass(e));
    return null;
  }
  const provider = getTextProvider(providerName);
  const started = Date.now();
  const runBase = {
    id: newId("r"),
    conversation_id: null,
    kind: LISTENING_RUN_KIND,
    provider: providerName,
    model,
    prompt_version: null,
    input_tokens: 0,
    output_tokens: 0,
    cost_usd_micro: 0,
    latency_ms: null,
    flags_json: null,
    created_at: nowIso(),
  };
  let result: Awaited<ReturnType<typeof provider.generate>>;
  try {
    result = await provider.generate(env, {
      system,
      messages: [{ role: "user", content: LISTENING_USER }],
      model,
      maxTokens: LISTENING_MAX_TOKENS,
      temperature: 0.9,
      effort: "low",
      cacheable: false,
    });
  } catch (e) {
    const failed: ModelRunRow = { ...runBase, latency_ms: Date.now() - started, status: "failed", error: safeErrorMessage(e, 200) };
    try { await insertModelRunStmt(db, failed).run(); } catch { /* the run log is best effort */ }
    console.warn("listening call failed", errorClass(e));
    return null;
  }
  const inputTokens = Math.max(0, result.inputTokens);
  const outputTokens = Math.max(0, result.outputTokens);
  const cost = costMicro(settings, model, inputTokens, outputTokens);
  const refused = result.stopReason === "refusal";
  const parsed = refused ? null : parseListening(result.text);
  const run: ModelRunRow = {
    ...runBase,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_usd_micro: cost.micro,
    latency_ms: Date.now() - started,
    status: refused ? "refused" : "ok",
    error: refused ? "refusal" : parsed ? null : "unparsed",
    flags_json: cost.priceKnown ? null : JSON.stringify([{ code: "price_unknown", severity: "flag", detail: "no price for model " + model }]),
  };
  const value: Listening = parsed ? { ...parsed, day } : null;
  const at = nowIso();
  try {
    await db.batch([
      insertModelRunStmt(db, run),
      usageStmt(db, dayKey(), providerName, model, inputTokens, outputTokens, cost.micro),
      writeListeningStmt(db, key, value ?? { none: true, day }, at),
    ]);
  } catch (e) {
    console.warn("listening run not recorded", errorClass(e));
  }
  return value;
}

// ------------------------------------------------------------------ the panel

function nicety<T>(name: string, p: Promise<T>, fallback: T): Promise<T> {
  return p.catch((e: unknown): T => {
    console.warn("phone: " + name + " skipped", errorClass(e));
    return fallback;
  });
}

async function weatherFor(env: Env, db: D1Database, settings: Settings, now: Date): Promise<WeatherNow | null> {
  if (settings.weatherProvider === "off") return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), WEATHER_TIMEOUT_MS); });
  try {
    return await Promise.race([nicety("weather", getWeather(env, db, settings, now), null), late]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const EMPTY_STATE = { version: 0, state: null, row: null } as const;

async function currentState<T extends RelationshipState | SceneState>(db: D1Database, entity: "relationship" | "scene"): Promise<{ version: number; state: T | null; row: { created_at: string } | null }> {
  try {
    const r = await getCurrentState<T>(db, entity);
    return { version: r.version, state: r.state, row: r.row };
  } catch (e) {
    console.warn("phone: " + entity + " state skipped", errorClass(e));
    return EMPTY_STATE;
  }
}

// One read for the whole panel. Writes on a read: syncPlaces (a thread_id refresh or an
// INSERT OR IGNORE, only when a head is new) and the listening cache; nothing else.
export async function phoneState(env: Env, db: D1Database, settings: Settings, now: Date = new Date()): Promise<PhoneState> {
  const tz = tzOf(settings);
  const city = typeof settings.herCity === "string" ? settings.herCity.trim() : "";
  const threads = await nicety("threads", listThreads(db, "active"), [] as Awaited<ReturnType<typeof listThreads>>);
  const [weather, today, approvedAssets, rel, scene, wantsAll, asks, placeRows, listening] = await Promise.all([
    weatherFor(env, db, settings, now),
    nicety("grounding rows", todayRows(db, now, tz), [] as GroundingRow[]),
    nicety("approved assets", listAssets(db, "approved"), [] as Awaited<ReturnType<typeof listAssets>>),
    currentState<RelationshipState>(db, "relationship"),
    currentState<SceneState>(db, "scene"),
    nicety("wants", listWants(db, "active"), [] as Awaited<ReturnType<typeof listWants>>),
    nicety("asks", listAsks(db, "open"), [] as Awaited<ReturnType<typeof listAsks>>),
    nicety("places", syncPlaces(db, threads), [] as PlaceRow[]),
    nicety("listening", listeningNow(env, db, settings, now), null as Listening),
  ]);

  const p = localParts(now, tz);
  const here = whereSheIs(threads, now, tz);
  const sceneAssets = approvedAssets.filter((a) => a.role === "scene");
  let outfit: Outfit | null = null;
  try {
    outfit = outfitNow(sceneAssets, today, now, tz);
  } catch (e) {
    console.warn("phone: outfit skipped", errorClass(e));
  }

  let mood: PhoneState["mood"] = null;
  if (rel.state) {
    const m = moodNow(rel.state, now, settings, rel.row ? rel.row.created_at : null);
    if (m.phase !== "none") {
      mood = { mood: m.mood, phase: m.phase, setAt: m.setAt, days: m.days, ageDays: m.ageDays, fraction: Math.min(1, m.ageDays / (2 * Math.max(1, m.days))) };
    }
  }

  const shown = wantsSettings(settings).wantsShown;
  const wants = wantsAll.slice(0, shown).map((w) => ({
    id: w.id, title: w.title, progress: Number(w.progress) || 0, status: w.status, lastMoved: w.last_moved ?? null, nextStep: w.next_step ?? null,
  }));

  const sceneStatus = scene.state && typeof scene.state.status === "string" ? scene.state.status : "none";
  const sceneLocation = scene.state && typeof scene.state.location === "string" && scene.state.location.trim() ? scene.state.location.trim() : null;
  const sceneNorm = sceneStatus === "together" && sceneLocation ? placeTitleNorm(sceneLocation) : "";
  const whereNorm = here.label ? placeTitleNorm(here.label) : "";
  const places = placeRows.map((r) => ({
    id: r.id,
    title: r.title,
    detail: r.detail ?? null,
    lat: typeof r.lat === "number" && Number.isFinite(r.lat) ? r.lat : null,
    lon: typeof r.lon === "number" && Number.isFinite(r.lon) ? r.lon : null,
    active: r.active !== false,
    picture: typeof r.picture_key === "string" && r.picture_key.length > 0,
    here: (sceneNorm !== "" && sceneNorm === r.title_norm) || (sceneNorm === "" && whereNorm !== "" && whereNorm === r.title_norm),
  }));

  return {
    now: now.toISOString(),
    tz,
    localClock: formatClock(p.hour * 60 + p.minute),
    weekday: WEEKDAYS[p.weekday] ?? "",
    timeOfDay: timeOfDay(p.hour),
    where: { busy: here.busy, label: here.label, until: here.until ? here.until.toISOString() : null },
    scene: { status: sceneStatus, location: sceneLocation },
    weather,
    city,
    outfit,
    mood,
    wants,
    asks: asks.map((a) => ({ id: a.id, text: a.text, askedAt: a.asked_at, broughtUp: Number(a.brought_up) || 0 })),
    today,
    listening,
    places,
    map: {
      bounds: PORTLAND_BOUNDS,
      view: MAP_VIEW,
      outline: PORTLAND_OUTLINE.map(([lat, lon]) => { const q = project(lat, lon); return { x: q.x, y: q.y }; }),
    },
  };
}
