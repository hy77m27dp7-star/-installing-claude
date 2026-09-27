// Bounded context assembly: approved state + relevant history + recent story messages,
// plus (v2) her life and the things she could bring up, plus (v3) her voice bank and his
// notes, memory that fades, her wants, where she is and what the weather is doing, and the
// shape cue for this message. Never the whole transcript, never operator-channel messages,
// never developer text.
//
// v3 seeds (SPEC_V3 header, Seeds): every per-turn seeded choice keys on `turnKey`, which
// assembleContext computes before generation: the pending user row id on an idempotent
// resume, else "s" + the next seq of the conversation. A retry reuses the same request, so
// the exemplars and the cue are identical on the retry.
//
// v5 (SPEC_V5): the story clock is read first (Justin's rule: time runs while apart and
// holds inside a together scene), and every story consumer of the turn reads the held
// instant (fix0927: only the stated time of day reads `storyNow`, which moves with the talk);
// the new per-turn state (her read of him, dated beats, the people and places in this,
// what she sent him, the songs he knows, the time since they last talked) joins the reads,
// each a nicety; the rhythm cue replaces the v3 shape cue.
import { PROMPT_VERSION, SYSTEM_SEPARATOR, buildSystemPrompt, compactPrefix, intimateScene, moodPhase, sceneMode, stablePrefix, stateSections } from "./prompt";
import { DEFAULT_SETTINGS, dayKey, getCurrentState, listAssets, listFacts, listHistory, listRecentStoryMessages, listUnknowns, nextSeq } from "./db";
import { listLog, listThreads, localParts, safeTimezone, whereSheIs } from "./life";
import { pickCallbacks } from "./callbacks";
import { listMedia } from "./media";
import { parseInboxImages } from "./images";
import { limitImageMessages } from "./vision";
import { voiceConfigured } from "./voice";
import { listApproved, recentUseIds, selectExemplars, turnTags } from "./voicebank";
import { listCorrections } from "./corrections";
import { loadWeights, pickProvisional, rankFacts, rankHistory, rankThreads, recentRecallCount } from "./memory";
import { listAsks, listWantLogRecent, listWants } from "./wants";
import { outfitNow, todayRows } from "./grounding";
import { CACHE_FRESH_MS, getWeather } from "./weather";
import { hisTextIsSubstantive, rhythmAsShapeCue, rhythmCue, signature } from "./imperfection";
// v5: the clock (L1), beats (L2), her read of him (L3), state that moves (L4), the record,
// the world and the songs (L6), places and portraits (unchanged modules).
import {
  clockWordsFor, disabledClock, heldGrounding, heldNow, lastExchange as readLastExchange, loadStoryClock, localDayKeyOf, storyAgeDays,
  storyNow as storyNowOf, storyWindowStart, timeSince,
} from "./clock";
import type { LastExchange, StoryClock } from "./clock";
import { listBeatViews } from "./arcs";
import type { BeatView } from "./arcs";
import { listViews, recentWrongViews } from "./views";
import type { HerViewRow } from "./views";
import { coolingOffNow } from "./standing";
import { listPeople, listWorldFacts, mentionedEntities, syncPeople } from "./world";
import type { PersonRow, WorldFactRow } from "./world";
import { listSent } from "./honest";
import type { SentItem } from "./honest";
import { listKnownArtists, missingSongNotice } from "./songs";
import type { KnownArtistRow } from "./songs";
import { listPlaces, syncPlaces } from "./places";
import type { PlaceRow } from "./places";
import { personThreadId } from "./portraits";
import { FACE_CADENCE_UNREADABLE, himRefs, isHisFirstTurn, loadHisLook, performersCanSee, shouldShowFace, turnsSinceFaceShown } from "./hisFace";
import type { ImageRef } from "./vision";
import type {
  AssembledContext, AskRow, ChatMessage, Correction, Env, HisLook, HistoryRow, MediaRow, OutfitNow, PromptCallback, PromptGrounding, PromptSongs,
  PromptState, PromptWorld, RecallPick, RelationshipState, Rhythm, SceneState, Settings, ShapeCue, SystemMode, TimeSince, VisualAssetRow, VoiceLine,
  WantLogRow, WantRow, WeatherNow,
} from "./types";
import type { LifeLog, LifeThread } from "./life";

const STOP = new Set(["the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "at", "for", "with", "is", "it", "was", "i", "you", "he", "she", "we", "they", "that", "this", "my", "your", "her", "his", "me", "so", "do", "not", "just", "like", "what", "about", "have", "had", "be", "are", "were", "from", "as", "if", "then", "than", "too", "very", "ok", "okay", "yeah", "no", "yes"]);

const DEFAULT_TZ = "America/New_York";
// The window the callback picker checks against ("minus anything whose keywords appear in
// the last 20 messages", SPEC_V2 section K).
const CALLBACK_RECENT = 20;
// Enough log rows for the prompt's "last 5 notes" and the callback picker's recent-past look.
const LOG_ROWS = 60;
// v3: the exemplar section's character cap (AA), the signature window (GG), the log rows
// per want (CC), how long a paused or done want still renders (CC), the weather race (DD).
const EXEMPLAR_MAX_CHARS = 1200;
const SIGNATURE_WINDOW = 2;
const WANT_LOG_ROWS = 3;
const WANT_SETTLED_DAYS = 14;
const WEATHER_TIMEOUT_MS = 3500;
const DAY_MS = 24 * 60 * 60 * 1000;
// v5: the rhythm window (section 5), the reads of him and the proven-wrong window (section
// 3), the beats read (section 2), the messages the world looks for names in (section 8).
const RHYTHM_WINDOW = 3;
const VIEWS_READ = 30;
const WRONG_VIEWS_DAYS = 7;
const WRONG_VIEWS_SHOWN = 2;
const BEATS_READ = 200;
const MENTION_WINDOW = 8;

export function keywords(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/)) {
    const t = w.replace(/^'+|'+$/g, "");
    if (t.length >= 3 && !STOP.has(t)) out.add(t);
  }
  return out;
}

// Keep every history entry while the ledger is short; when it grows, keep the newest
// six in full plus any older entry that shares vocabulary with the recent conversation.
// v3: the memory ranking (rankHistory) replaces this in the turn; kept as the fallback
// and for the unit suite.
export function selectHistory(all: HistoryRow[], recentText: string, maxFull = 12): HistoryRow[] {
  if (all.length <= maxFull) return all;
  const recent = all.slice(-6);
  const kw = keywords(recentText);
  const older = all.slice(0, -6).filter((h) => {
    const hk = keywords(h.title + " " + h.body);
    let hits = 0;
    for (const k of kw) if (hk.has(k)) hits++;
    return hits >= 2;
  });
  return [...older, ...recent].sort((a, b) => a.seq - b.seq);
}

export function boundMessages(rows: ChatMessage[], maxChars: number): ChatMessage[] {
  const out: ChatMessage[] = [];
  let total = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const m = rows[i]!;
    total += m.content.length;
    if (total > maxChars && out.length > 0) break;
    out.unshift(m);
  }
  // Providers require the first message to be from the user.
  while (out.length && out[0]!.role !== "user") out.shift();
  return out;
}

// Deterministic per day and conversation, so the same two callbacks stay on offer through
// a day's conversation instead of shuffling every turn.
export function callbackSeed(now: Date, conversationId: string | null): string {
  return dayKey(now) + ":" + (conversationId ?? "");
}

export interface LoadOptions {
  now?: Date;
  tz?: string;
  conversationId?: string | null;
  // The last messages' texts (both roles), for the callback picker's exclusion rule.
  recentTexts?: string[];
  // v3. The settings the sections render with (the defaults when absent); the turn key
  // every seeded choice keys on; whether this turn is an opener or a first text (no message
  // of his; the hisText-derived tags are skipped and an unanswered ask never leads); his
  // pending text; her last replies (the signature window); the weather already fetched;
  // the env (whether a voice note is possible); cues false skips the shape cue (a call).
  settings?: Settings;
  turnKey?: string;
  opener?: boolean;
  hisText?: string;
  recentAssistantTexts?: string[];
  weather?: WeatherNow | null;
  env?: Env;
  cues?: boolean;
  // false skips the voice bank (no HOW YOU TEXT, no uses to record) and the half-remembered
  // pick (no memory_recalls row): a call's instructions, where neither is checked or booked.
  exemplars?: boolean;
  // v3.2: how many story rows the conversation holds before this turn (the first-conversation
  // block softens once it has been going a while).
  storyRows?: number;
  recall?: boolean;
  // v5 (SPEC_V5 section 1): the story clock of the turn (absent: no clock, v4's real time),
  // the last exchange across every conversation (TIME SINCE), and the real instant the turn
  // runs at (`now` is the story instant; the reads that are his, not hers, use this one).
  clock?: StoryClock;
  lastExchange?: LastExchange | null;
  realNow?: Date;
  // fix0927: the story's time of day (clock storyNow), which inside a held scene moves with
  // the conversation while `now` stays the frozen instant (clock heldNow). Only the stated
  // time reads it: RIGHT NOW, the "It is" line of her life and the time-of-day tags. Every
  // measure (her plans coming up or past, her day, the callbacks, the mood, what she sent)
  // reads `now`. Absent: now.
  clockNow?: Date;
  // v5 (section 8): the last messages with who wrote each (hers: her lines), so a relation
  // word ("my mom") pulls in her mother only from her lines, or from his after "your".
  // Absent: the plain recentTexts are read as his.
  mentionTexts?: Array<{ hers: boolean; text: string }>;
}

// Fix 2026-09-27: whether the rhythm cue may offer her a voice note this turn. Never in a
// Together scene (she is right there with him, and chat.ts makes no note there either); never
// with voice notes off or no voice provider configured.
export function voiceCueAllowed(settings: Settings, env: Env | undefined, mode: string): boolean {
  if (mode === "together") return false;
  if (settings.voiceMode === "off" || env === undefined) return false;
  return voiceConfigured(env, settings);
}

// Threads the prompt may know about: live ones and finished ones (a done event is still
// something she could mention); dropped and superseded rows are gone from her world.
function livingThreads(threads: LifeThread[]): LifeThread[] {
  return threads.filter((t) => t.status === "active" || t.status === "done");
}

// A v3 read or ranking is a nicety: a table that is not there yet or a broken helper must
// never cost a turn. The class is logged, never the message.
function errorClass(e: unknown): string {
  return e instanceof Error ? e.name || "Error" : "error";
}

function nicety<T>(name: string, p: Promise<T>, fallback: T): Promise<T> {
  return p.catch((e: unknown): T => {
    console.warn("context: " + name + " skipped", errorClass(e));
    return fallback;
  });
}

function attempt<T>(name: string, fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (e) {
    console.warn("context: " + name + " skipped", errorClass(e));
    return fallback;
  }
}

function intSetting(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : fallback;
}

function numSetting(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

// Active wants first; a paused or done want still shows for two weeks after the change
// (the section renders it as one line), then only in the UI. Dropped wants never render.
function wantsForPrompt(all: WantRow[], now: Date): WantRow[] {
  const out: WantRow[] = [];
  for (const w of all) {
    if (!w) continue;
    if (w.status === "active") { out.push(w); continue; }
    if (w.status !== "paused" && w.status !== "done") continue;
    const at = Date.parse(w.updated_at);
    if (Number.isFinite(at) && now.getTime() - at <= WANT_SETTLED_DAYS * DAY_MS) out.push(w);
  }
  return out;
}

// The last few log rows of the active wants the section shows (M2's bulk reader, chunked
// by 90 ids), oldest first so the newest lands last.
async function wantLogsFor(db: D1Database, wants: WantRow[], limit: number): Promise<WantLogRow[]> {
  const ids = wants.filter((w) => w.status === "active").slice(0, Math.max(1, limit)).map((w) => w.id);
  if (!ids.length) return [];
  const rows = await nicety("want log", listWantLogRecent(db, ids, WANT_LOG_ROWS), [] as WantLogRow[]);
  return rows.slice().sort((a, b) => a.occurred.localeCompare(b.occurred) || a.created_at.localeCompare(b.created_at));
}


export { saidLine, saidKey, dedupeSaid, listSaidRows, buildSaidHere } from "./said";
import { buildSaidHere, listSaidRows } from "./said";
import type { SaidRow } from "./said";

// v5 (section 8): the threads that are in her day: today's life notes (her local day of the
// story instant) and any beat due today or tomorrow whose title names a person or place of hers.
function dayThreadIdsFor(threads: LifeThread[], log: LifeLog[], beats: BeatView[], now: Date, tz: string): string[] {
  const zone = safeTimezone(tz);
  const today = localDayKeyOf(now, zone);
  const tomorrow = localDayKeyOf(new Date(now.getTime() + DAY_MS), zone);
  const out = new Set<string>();
  for (const row of log) {
    if (!row || !row.thread_id) continue;
    const t = Date.parse(row.occurred);
    if (Number.isFinite(t) && localDayKeyOf(new Date(t), zone) === today) out.add(row.thread_id);
  }
  const named = threads.filter((t) => (t.kind === "person" || t.kind === "place") && typeof t.title === "string" && t.title.trim().length >= 3);
  for (const v of beats) {
    if (!v || !v.beat || !v.run || v.run.status !== "pending") continue;
    const at = Date.parse(v.run.due_at);
    if (!Number.isFinite(at)) continue;
    const day = localDayKeyOf(new Date(at), zone);
    if (day !== today && day !== tomorrow) continue;
    const title = String(v.beat.title ?? "").toLowerCase();
    for (const t of named) {
      const words = t.title.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp("\\b" + words + "\\b").test(title)) out.add(t.id);
    }
  }
  return Array.from(out);
}

// v5 (section 8): the place she is at: the scene's location together, her schedule's label apart.
function dayPlaceTitlesFor(mode: string, scene: SceneState, threads: LifeThread[], now: Date, tz: string): string[] {
  if (mode === "together") {
    const loc = typeof scene.location === "string" ? scene.location.trim() : "";
    return loc ? [loc] : [];
  }
  const here = attempt("whereSheIs", () => whereSheIs(threads, now, tz), null as ReturnType<typeof whereSheIs> | null);
  return here && here.busy && here.label && here.label.trim() ? [here.label.trim()] : [];
}

// v5 (section 8): the portrait descriptions of her people, by thread id: every approved
// portrait by the thread its notes name, and every person thread by the portrait it carries.
function portraitsByThread(assets: VisualAssetRow[], threads: LifeThread[]): Record<string, string> {
  const out: Record<string, string> = {};
  const byId = new Map<string, VisualAssetRow>();
  for (const a of assets) {
    if (!a || a.role !== "portrait" || a.approval_status !== "approved") continue;
    byId.set(a.id, a);
    const tid = personThreadId(a.notes);
    if (tid && typeof a.prompt === "string" && a.prompt.trim()) out[tid] = a.prompt.trim();
  }
  for (const t of threads) {
    if (t.kind !== "person" || !t.portrait_asset_id) continue;
    const a = byId.get(t.portrait_asset_id);
    if (a && typeof a.prompt === "string" && a.prompt.trim()) out[t.id] = a.prompt.trim();
  }
  return out;
}

function artistName(r: KnownArtistRow): string {
  return typeof r.artist === "string" ? r.artist.trim() : "";
}

export async function loadPromptState(db: D1Database, recentText = "", opts: LoadOptions = {}): Promise<PromptState> {
  // v5: `now` is the story instant (the real now unless a together scene holds the moment);
  // `realNow` is the wall clock for the reads that are his (the sends window, the missing
  // song, the proven-wrong window).
  // fix0927: `clockNow` is the time of day, which moves with the conversation inside a held
  // scene; `now` stays the held instant for everything that measures time.
  const now = opts.now ?? new Date();
  const realNow = opts.realNow ?? now;
  const clockNow = opts.clockNow instanceof Date && Number.isFinite(opts.clockNow.getTime()) ? opts.clockNow : now;
  const clock: StoryClock | null = opts.clock ?? null;
  const tz = opts.tz && opts.tz.trim() ? opts.tz.trim() : DEFAULT_TZ;
  const settings = opts.settings ?? DEFAULT_SETTINGS;
  const conversationId = opts.conversationId ?? null;
  const turnKey = opts.turnKey && opts.turnKey.trim() ? opts.turnKey.trim() : "s0";
  const opener = opts.opener === true;
  const perTurn = opts.exemplars === false ? 0 : Math.min(12, intSetting(settings.exemplarsPerTurn, 6));
  const cooldownTurns = intSetting(settings.exemplarCooldownTurns, 30);
  const correctionsShown = Math.min(100, intSetting(settings.correctionsShown, 25));
  const wantsShown = Math.min(20, intSetting(settings.wantsShown, 5));
  const recallEvery = opts.recall === false ? 0 : intSetting(settings.provisionalRecallEvery, 0);
  const seed = callbackSeed(now, conversationId);
  // v5 numbers (the defaults when a stored table predates them).
  const viewsShown = Math.min(12, intSetting(settings.viewsShown, 6));
  const sentShown = Math.min(30, intSetting(settings.sentShown, 12));
  const sentWindowDays = Math.max(1, Math.min(60, intSetting(settings.sentWindowDays, 7)));
  const knownArtistsShown = Math.min(200, intSetting(settings.knownArtistsShown, 40));
  const worldShown = Math.min(20, intSetting(settings.worldShown, 6));

  const [facts, historyAll, unknowns, rel, scene, threadsAll, log, media, approvedLines, usedIds, corrections, weights, wantsAll, asks, today, approvedAssets, recallCount, hisLook, saidRows, views, wrongViews, beats, worldFacts, sent, knownRows, missing] = await Promise.all([
    listFacts(db),
    listHistory(db),
    listUnknowns(db, "open"),
    getCurrentState<RelationshipState>(db, "relationship"),
    getCurrentState<SceneState>(db, "scene"),
    listThreads(db),
    listLog(db, LOG_ROWS),
    // The library is a nicety; a missing table (migration not applied yet) costs no turn.
    listMedia(db).catch((): MediaRow[] => []),
    // v3 (AA): the approved bank, read fresh every turn (no cache: an approval made a
    // second ago is in the next turn); the lines used in the cooldown window; his notes.
    nicety("voice bank", perTurn > 0 ? listApproved(db) : Promise.resolve([] as VoiceLine[]), [] as VoiceLine[]),
    nicety("exemplar uses", perTurn > 0 && conversationId && cooldownTurns > 0 ? recentUseIds(db, conversationId, cooldownTurns) : Promise.resolve(new Set<string>()), new Set<string>()),
    nicety("corrections", correctionsShown > 0 ? listCorrections(db, "active", correctionsShown) : Promise.resolve([] as Correction[]), [] as Correction[]),
    // v3 (BB): the weights map, read once; (CC): her wants and the open asks; (DD): today's
    // grounding rows and the approved photos (what she wore); (BB): the recall rate window.
    nicety("memory weights", loadWeights(db), new Map() as Awaited<ReturnType<typeof loadWeights>>),
    nicety("wants", listWants(db), [] as WantRow[]),
    nicety("asks", listAsks(db, "open"), [] as AskRow[]),
    nicety("grounding rows", todayRows(db, now, tz), [] as Awaited<ReturnType<typeof todayRows>>),
    nicety("approved assets", listAssets(db, "approved"), [] as VisualAssetRow[]),
    nicety("recall count", conversationId && recallEvery > 0 ? recentRecallCount(db, conversationId, recallEvery) : Promise.resolve(0), 0),
    // v3.1 (JJ): the words on file and his reference photos; none attached until assembleContext decides.
    nicety("his look", loadHisLook(db, settings), null as HisLook | null),
    // v3.2: what was said in this conversation and is not approved yet.
    nicety("said here", conversationId ? listSaidRows(db, conversationId) : Promise.resolve([] as SaidRow[]), [] as SaidRow[]),
    // v5 (section 3): her reads of him and the ones he proved wrong in the last week.
    nicety("views", viewsShown > 0 ? listViews(db, "active", VIEWS_READ) : Promise.resolve([] as HerViewRow[]), [] as HerViewRow[]),
    nicety("wrong views", viewsShown > 0 ? recentWrongViews(db, new Date(realNow.getTime() - WRONG_VIEWS_DAYS * DAY_MS).toISOString(), WRONG_VIEWS_SHOWN) : Promise.resolve([] as HerViewRow[]), [] as HerViewRow[]),
    // v5 (section 2): the dated beats on her wants, with the owner's runs.
    nicety("beats", listBeatViews(db, { status: "active", limit: BEATS_READ }), [] as BeatView[]),
    // v5 (section 8): the fixed facts about her people and places.
    nicety("world facts", listWorldFacts(db, { status: "approved" }), [] as WorldFactRow[]),
    // v5 (section 6): what she sent him, on the wall clock's window.
    // Review fix: the window is story time (held spans do not use it up).
    nicety("sent", sentShown > 0 ? listSent(db, { now: realNow, windowDays: sentWindowDays, limit: sentShown, since: clock ? storyWindowStart(clock, sentWindowDays * DAY_MS) : null }) : Promise.resolve([] as SentItem[]), [] as SentItem[]),
    // v5 (section 9): the artists he knows or did not like, and a pick of hers that is not anywhere.
    nicety("known artists", knownArtistsShown > 0 ? listKnownArtists(db, undefined, knownArtistsShown) : Promise.resolve([] as KnownArtistRow[]), [] as KnownArtistRow[]),
    nicety("missing song", knownArtistsShown > 0 ? missingSongNotice(db, realNow) : Promise.resolve(null), null as Awaited<ReturnType<typeof missingSongNotice>>),
  ]);

  // v5 (section 8): her people and places, synced from the threads just read (a write only
  // when something moved), each a nicety.
  const [people, places] = await Promise.all([
    nicety("people", syncPeople(db, threadsAll).then(() => listPeople(db)), [] as PersonRow[]),
    nicety("places", syncPlaces(db, threadsAll).then(() => listPlaces(db)), [] as PlaceRow[]),
  ]);

  const recentKeywords = keywords(recentText);
  const justinAll = facts.filter((f) => f.scope === "justin" || f.scope === "shared");
  const avelieAll = facts.filter((f) => f.scope === "avelie");
  // A fact about him can only exist because they talked: it ends the stranger mode just as
  // a history entry does, so the prompt never says both at once. A faded fact still counts.
  const hasSharedHistory = historyAll.length > 0 || justinAll.length > 0;
  const living = livingThreads(threadsAll);

  // v3 (BB): what mattered and what came up recently stays; what a person would have let
  // go is not in the prompt (and comes back the moment it is touched). v5: the ages are
  // story time, so nothing fades inside a held scene (section 7, Justin's rule).
  const memSettings = clock ? { ...settings, ageDaysOf: (iso: string): number => storyAgeDays(clock, iso) } : settings;
  const justinFacts = attempt("rankFacts", () => rankFacts(justinAll, weights, recentKeywords, now, memSettings).kept, justinAll);
  const history = attempt("rankHistory", () => rankHistory(historyAll, weights, recentKeywords, now, memSettings).kept, selectHistory(historyAll, recentText));
  const threads = attempt("rankThreads", () => rankThreads(living, weights, recentKeywords, now, memSettings).kept, living);

  const mode = sceneMode(scene.state.status);
  // v5: the cooling off and the mood phase on story time (section 4, section 1).
  const cooling = attempt("coolingOffNow", () => coolingOffNow(rel.state, now, clock), false);
  const phase = attempt("moodPhase", () => moodPhase(rel.state, now, numSetting(settings.moodDaysDefault, 3), rel.row.created_at, clock), "gone" as ReturnType<typeof moodPhase>);
  const mood = phase === "gone" ? "" : (typeof rel.state.mood === "string" ? rel.state.mood.trim() : "");

  // v3 (BB): the one half-remembered detail; never on an opener or a first text, never
  // while the setting is 0 (the shipped default).
  let recall: RecallPick | null = null;
  if (recallEvery > 0 && !opener) {
    recall = attempt("pickProvisional", () => pickProvisional(justinAll, weights, recentKeywords, now, memSettings, recallCount, cooling, hasSharedHistory, opener) ?? null, null);
  }

  // v3 (GG): the signatures of her last two replies (shape_uniform reads them).
  const recentSignatures = attempt("signatures", () => (opts.recentAssistantTexts ?? []).slice(-SIGNATURE_WINDOW).map((t) => signature(t)), [] as string[]);
  // v5 (section 5): the rhythm cue on every turn while the cues are on (never for a call),
  // rolled against her last three replies and his message; the v3 shape cue is its mapping.
  let rhythm: Rhythm | null = null;
  if (opts.cues !== false) {
    const voiceAllowed = attempt("voiceCueAllowed", () => voiceCueAllowed(settings, opts.env, mode), false);
    const pendingText = opener ? "" : opts.hisText ?? "";
    rhythm = attempt("rhythmCue", () => rhythmCue(seed + ":cue:" + turnKey, (opts.recentAssistantTexts ?? []).slice(-RHYTHM_WINDOW), {
      enabled: settings.textureCuesEnabled !== false,
      together: mode === "together",
      opener,
      intimate: intimateScene(scene.state),
      voiceAllowed,
      typoShare: numSetting(settings.typoCueShare, 0),
      substantive: hisTextIsSubstantive(pendingText),
    }), null);
  }
  const cue: ShapeCue | null = attempt("rhythmAsShapeCue", () => rhythmAsShapeCue(rhythm), null);

  // v3 (AA): the tags this turn matches and the bank lines that fit them.
  let tags: string[] = [];
  let exemplars: VoiceLine[] = [];
  if (perTurn > 0 && approvedLines.length) {
    const localHour = localParts(clockNow, safeTimezone(tz)).hour;
    tags = attempt("turnTags", () => turnTags({
      mode, localHour, hasSharedHistory, mood, coolingOff: cooling, hisText: opts.hisText ?? "", cue, opener,
    }), []);
    exemplars = attempt("selectExemplars", () => selectExemplars(approvedLines, tags, usedIds, seed + ":" + turnKey, { perTurn, maxChars: EXEMPLAR_MAX_CHARS }), []);
  }

  // v3 (CC): the wants the section shows and their last log rows.
  const wants = wantsForPrompt(wantsAll, now);
  const wantLog = wants.length ? await wantLogsFor(db, wants, wantsShown) : [];

  // v3 (DD): what she is wearing today, from today's approved photo or today's outfit row.
  // Only her scene photos: a master, a portrait, a clip or (v3.1) a reference photo of him
  // never says what she wore. v5 (section 1): while a together scene is held, the held
  // snapshot (the weather, the outfit and today's rows of that moment, everything inside
  // the span stamped at it) and the scene's own time words.
  const city = typeof settings.herCity === "string" ? settings.herCity.trim() : "";
  const sceneAssets = approvedAssets.filter((a) => a.role === "scene");
  let grounding: PromptGrounding;
  let clockWords: string | null = null;
  const open = clock && clock.enabled && clock.frozen && clock.open ? clock.open : null;
  const held = open && clock ? attempt("heldGrounding", () => heldGrounding(open, { assets: approvedAssets, rows: today }, clock), null) : null;
  if (held && clock) {
    grounding = { city, weather: held.weather ?? opts.weather ?? null, outfit: held.outfit, today: held.today };
    clockWords = attempt("clockWordsFor", () => clockWordsFor(scene.state, clock), null);
  } else {
    const outfit = attempt("outfitNow", () => outfitNow(sceneAssets, today, now, tz), null as unknown as OutfitNow);
    grounding = { city, weather: opts.weather ?? null, outfit, today };
  }

  let callbacks: PromptCallback[] = [];
  try {
    // v3 (CC): the picker also sees her wants and the open asks, and knows an opener when it
    // sees one (an unanswered ask never opens a first text). Passed as a variable, not a
    // literal, so a picker that ignores the extra keys still typechecks. v5: the dated beats
    // (section 2) and the story clock for every age it measures (section 1).
    const cbArgs = {
      history: historyAll,
      threads,
      log,
      recentTexts: opts.recentTexts ?? [],
      now,
      seed,
      opener,
      wants,
      wantLog,
      asks,
      beats,
      clock,
      // Her calendar for a pending beat's day word (the picker falls back to UTC without it).
      tz,
    };
    callbacks = pickCallbacks(cbArgs).slice(0, 2);
  } catch (e) {
    // A callback is a nicety; a broken picker must never cost a turn.
    console.warn("callbacks skipped", errorClass(e));
    callbacks = [];
  }

  // v5 (section 8): the people and places in this: named in the last messages or his
  // pending text, or in her day.
  const mentionTexts = opts.mentionTexts
    ? opts.mentionTexts.slice(-MENTION_WINDOW)
    : (opts.recentTexts ?? []).slice(-MENTION_WINDOW).map((text) => ({ hers: false, text }));
  const texts = [...mentionTexts, ...(opener || !opts.hisText ? [] : [{ hers: false, text: opts.hisText }])];
  const picked = attempt("mentionedEntities", () => mentionedEntities({
    people,
    places,
    texts,
    dayThreadIds: dayThreadIdsFor(threadsAll, log, beats, now, tz),
    dayPlaceTitles: dayPlaceTitlesFor(mode, scene.state, threadsAll, now, tz),
  }), { personIds: [] as string[], placeIds: [] as string[] });
  const world: PromptWorld = {
    people,
    places,
    threads: living,
    facts: worldFacts,
    portraits: portraitsByThread(approvedAssets, threadsAll),
    picked,
  };

  // v5 (section 9): the artists by name, newest first (the list is read newest first).
  const songs: PromptSongs | null = knownArtistsShown > 0
    ? {
      known: knownRows.filter((r) => r.kind === "known").map(artistName).filter(Boolean),
      disliked: knownRows.filter((r) => r.kind === "disliked").map(artistName).filter(Boolean),
      missing: missing ? { messageId: missing.messageId, artist: missing.artist, title: missing.title } : null,
    }
    : null;

  // v5 (section 1): how long since they last talked, on the story clock (the section builder
  // decides whether it renders: apart only, never on an opener, never under the minimum).
  let timeSinceValue: TimeSince | null = null;
  if (clock && opts.lastExchange) {
    const last = opts.lastExchange;
    timeSinceValue = attempt("timeSince", () => timeSince(clock, last, tz), null);
  }

  return {
    hasSharedHistory,
    fixedFacts: facts.filter((f) => f.scope === "fixed"),
    avelieFacts: avelieAll,
    justinFacts,
    // v5 (section 7): the said lines drop anything already kept, compared against EVERY
    // approved fact of each scope, not only the ones firm this turn.
    saidHere: buildSaidHere(saidRows, justinAll, avelieAll),
    storyRows: typeof opts.storyRows === "number" && Number.isFinite(opts.storyRows) ? Math.max(0, Math.trunc(opts.storyRows)) : 0,
    history,
    unknowns,
    relationship: rel.state,
    scene: scene.state,
    mode,
    life: { threads, log, now, clockNow, tz },
    callbacks,
    media,
    // v3
    exemplars,
    corrections,
    turnTags: tags,
    recall,
    fadedFactCount: Math.max(0, justinAll.length - justinFacts.length),
    wants,
    wantLog,
    asks,
    grounding,
    shapeCue: cue,
    recentSignatures,
    turnKey,
    opener,
    relationshipSince: rel.row.created_at,
    moodDaysDefault: numSetting(settings.moodDaysDefault, 3),
    wantsShown,
    correctionsShown,
    // v3.1 (JJ)
    hisLook,
    // v5
    clock,
    timeSince: timeSinceValue,
    clockWords,
    gapLineMinMinutes: numSetting(settings.gapLineMinMinutes, 120),
    ...(viewsShown > 0 ? { views, wrongViews } : {}),
    viewsShown,
    viewMinConfidence: numSetting(settings.viewMinConfidence, 0.4),
    beats,
    beatHorizonDays: numSetting(settings.beatHorizonDays, 7),
    arcMemoryDays: numSetting(settings.arcMemoryDays, 7),
    world,
    worldShown,
    ...(sentShown > 0 ? { sent } : {}),
    songs,
    knownArtistsShown,
    rhythm,
    frictionDaysDefault: numSetting(settings.frictionDaysDefault, 4),
  };
}

// The photos on a stored message of his, as refs the adapters can load.
function imageRefs(row: { role: string; images_json?: string | null }): ImageRef[] {
  if (row.role !== "user" || !row.images_json) return [];
  return parseInboxImages(row.images_json).map((i) => ({ key: i.key, mime: i.mime }));
}

// The weather for the turn (SPEC_V3 section DD), fetched alongside the state load. A slow
// or failed call costs the turn nothing and produces no line, never a made-up weather.
async function weatherFor(env: Env | undefined, db: D1Database, settings: Settings, now: Date): Promise<WeatherNow | null> {
  if (!env) return null;
  if (settings.weatherProvider === "off") return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), WEATHER_TIMEOUT_MS); });
  try {
    return await Promise.race([nicety("weather", getWeather(env, db, settings, now), null), late]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// v5 (section 1, skeptic 11): the clock of a turn, read first and never costing the turn.
async function clockFor(db: D1Database, settings: Settings, realNow: Date): Promise<StoryClock> {
  return nicety("story clock", loadStoryClock(db, settings, realNow), disabledClock(realNow));
}

// Whether this turn may fetch the weather. Apart (or no clock): always, as v4. While a
// together scene is held: only when the open span has no weather yet AND the real now is
// within CACHE_FRESH_MS of the moment the scene froze, so a held scene never shows the real
// weather of a later hour or day (then the commit holds what was fetched).
export function weatherAllowed(clock: StoryClock, realNow: Date): boolean {
  if (!clock.enabled || !clock.frozen || !clock.open) return true;
  if (clock.open.weather_json) return false;
  const frozenAt = Date.parse(clock.open.frozen_at);
  if (!Number.isFinite(frozenAt)) return false;
  const age = realNow.getTime() - frozenAt;
  return age >= 0 && age <= CACHE_FRESH_MS;
}

// The last messages with who wrote each, for the people and places in this (section 8).
function mentionRows(rows: Array<{ role: string; content: string }>): Array<{ hers: boolean; text: string }> {
  return rows.slice(-MENTION_WINDOW).map((r) => ({ hers: r.role === "assistant", text: r.content }));
}

export interface AssembleOptions {
  // The turn has no message of his (an /open turn, a first text): the cue is the pending text.
  opener?: boolean;
  // The env, for the weather call and the voice-cue check; absent in the unit suite.
  env?: Env;
  // false skips the shape cue (assembleSystemOnly uses it for calls).
  cues?: boolean;
  // v3.1: false keeps his reference photos off the call (the drift cron's throwaway turns);
  // the words still render.
  hisFace?: boolean;
  // v3.1 fix 1: every performer this turn's call goes to (a tasting turn names the live one
  // and side B); the live performer alone when absent. The photos ride only when all can see.
  performers?: ReadonlyArray<{ provider: string; model: string }>;
}

// pendingMessageId names a stored user row that pendingUserText repeats (an idempotent
// resume), so it is not sent twice. Rows with no text are dropped: providers reject
// empty content, and an empty row would otherwise block every later turn.
// pendingImages are the photos attached to the message being sent (SPEC_V2 section T);
// only the last six of his messages keep their pictures in the call.
export async function assembleContext(
  db: D1Database,
  conversationId: string,
  settings: Settings,
  pendingUserText: string,
  pendingMessageId: string | null = null,
  now: Date = new Date(),
  pendingImages: ImageRef[] = [],
  opts: AssembleOptions = {},
): Promise<AssembledContext> {
  const opener = opts.opener === true;
  // v5 (section 1): the real now is the parameter; the story clock is read first (never
  // throws), and every story consumer below reads the story instant.
  const realNow = now;
  const clock = await clockFor(db, settings, realNow);
  // fix0927: storyNow is the time of day (it moves with the conversation inside a held
  // scene); heldAt is the frozen instant every measure of the turn reads (review finding 1:
  // on the moving clock a plan due a few minutes into the scene read as already happened).
  const storyNow = storyNowOf(clock);
  const heldAt = heldNow(clock);
  const [recentAll, seq, weather, sinceFace, last] = await Promise.all([
    listRecentStoryMessages(db, conversationId, settings.contextRecentMessages),
    pendingMessageId ? Promise.resolve(0) : nextSeq(db, conversationId),
    weatherAllowed(clock, realNow) ? weatherFor(opts.env, db, settings, realNow) : Promise.resolve(null),
    // v3.1 (JJ): her replies since his photos last rode along here, plus this turn: Infinity
    // when never (the row says null). A failed read (the his_face_seq column not there yet,
    // before 0007) counts as just shown (FACE_CADENCE_UNREADABLE, 0), the cheap failure: the
    // Apart cadence then waits for the migration instead of the photos riding on every
    // Apart turn (v3.1 fix 2; the first turn, Together turns and a mention still show them).
    nicety("his face cadence", turnsSinceFaceShown(db, conversationId), FACE_CADENCE_UNREADABLE),
    // v5 (section 1): the last exchange across every conversation (TIME SINCE).
    nicety("last exchange", readLastExchange(db, pendingMessageId, realNow), null as LastExchange | null),
  ]);
  const turnKey = pendingMessageId ?? "s" + seq;
  const recentRows = recentAll.filter((r) => r.content.trim().length > 0 && r.id !== pendingMessageId);
  const chat: ChatMessage[] = recentRows.map((r) => {
    const images = imageRefs(r);
    return images.length ? { role: r.role, content: r.content, images } : { role: r.role, content: r.content };
  });
  const pendingRefs = pendingImages.filter((i) => i && typeof i.key === "string" && i.key);
  chat.push(pendingRefs.length ? { role: "user", content: pendingUserText, images: pendingRefs } : { role: "user", content: pendingUserText });
  const messages = boundMessages(limitImageMessages(chat), settings.contextMaxChars);
  const recentText = messages.slice(-8).map((m) => m.content).join(" ");
  const recentAssistantTexts = recentRows.filter((r) => r.role === "assistant").slice(-5).map((r) => r.content);
  const state = await loadPromptState(db, recentText, {
    storyRows: recentRows.length,
    now: heldAt,
    clockNow: storyNow,
    realNow,
    clock,
    lastExchange: last,
    mentionTexts: mentionRows(recentRows),
    tz: settings.timezone,
    conversationId,
    recentTexts: [...recentRows.slice(-CALLBACK_RECENT).map((r) => r.content), pendingUserText],
    settings,
    turnKey,
    opener,
    hisText: pendingUserText,
    recentAssistantTexts,
    weather,
    env: opts.env,
    cues: opts.cues,
  });
  // v3.1 (JJ): his reference photos ride on the final user turn of the provider call when
  // the rule says so: prepended there only, after the six-message window was applied, so
  // they are never written to his row, never shown in the chat, and never push one of his
  // own photo messages out of the window. The section's attached-photos line follows.
  let hisFaceShown = 0;
  const look = state.hisLook;
  if (look && look.photos.length && opts.hisFace !== false) {
    // His first turn: no earlier row of his in the window (her opener or her first texts do
    // not make it a later turn); an opener turn is hers, never his first.
    const firstTurn = !opener && isHisFirstTurn(recentAll, pendingMessageId);
    const performers = opts.performers && opts.performers.length ? opts.performers : [{ provider: settings.provider, model: settings.model }];
    const show = attempt("shouldShowFace", () => shouldShowFace({
      mode: state.mode,
      isFirstTurnOfConversation: firstTurn,
      turnsSinceLastShown: sinceFace,
      userText: opener ? "" : pendingUserText,
      settings,
      canSee: performersCanSee(performers),
      opener,
    }), false);
    const last = messages[messages.length - 1];
    if (show && last && last.role === "user") {
      const refs = himRefs(look.photos);
      if (refs.length) {
        messages[messages.length - 1] = { ...last, images: [...refs, ...(last.images ?? [])] };
        hisFaceShown = refs.length;
        look.attached = refs.length;
      }
    }
  }
  const built = buildSystemPrompt(state);
  return {
    state,
    system: built.system,
    systemParts: { prefix: built.prefix, state: built.state },
    promptVersion: built.promptVersion,
    messages,
    recentAssistantTexts,
    turnKey,
    opener,
    hisFaceShown,
    clock,
    storyNow: storyNow.toISOString(),
  };
}

// The compact system text (SPEC_V3 sections EE and II): the always-on rules and the
// runtime overlay in front of the given state sections, joined the way the live prompt is.
export function compactSystem(state: string): string {
  return compactPrefix() + SYSTEM_SEPARATOR + state;
}

export function fullSystem(state: string): string {
  return stablePrefix() + SYSTEM_SEPARATOR + state;
}

export interface SystemOnly {
  prefix: string;
  state: string;
  system: string;
  promptVersion: string;
  promptState: PromptState;
}

// Her rules and her state with no pending user text (SPEC_V3 section EE): the instructions
// of a phone call. `compact` is ALWAYS_ON + OVERLAY plus every state section; `full` is the
// whole stable prefix plus the state. No shape cue (she speaks; nothing about bubbles
// applies), no opener, no HOW YOU TEXT (bank lines are texting examples, and a call books
// no uses and checks no verbatim), no half-remembered pick (a call writes no recall row).
// The caller appends its own note after the state.
export async function assembleSystemOnly(
  db: D1Database,
  conversationId: string,
  settings: Settings,
  now: Date = new Date(),
  mode: SystemMode = "compact",
  opts: { env?: Env } = {},
): Promise<SystemOnly> {
  // v5 (section 1): the same clock as a turn, with no pending row.
  const realNow = now;
  const clock = await clockFor(db, settings, realNow);
  const storyNow = storyNowOf(clock);
  const heldAt = heldNow(clock);
  const [recentAll, seq, weather, last] = await Promise.all([
    listRecentStoryMessages(db, conversationId, settings.contextRecentMessages),
    nextSeq(db, conversationId),
    weatherAllowed(clock, realNow) ? weatherFor(opts.env, db, settings, realNow) : Promise.resolve(null),
    nicety("last exchange", readLastExchange(db, null, realNow), null as LastExchange | null),
  ]);
  const recentRows = recentAll.filter((r) => r.content.trim().length > 0);
  const recentText = recentRows.slice(-8).map((r) => r.content).join(" ");
  const recentAssistantTexts = recentRows.filter((r) => r.role === "assistant").slice(-5).map((r) => r.content);
  const promptState = await loadPromptState(db, recentText, {
    now: heldAt,
    clockNow: storyNow,
    realNow,
    clock,
    lastExchange: last,
    mentionTexts: mentionRows(recentRows),
    tz: settings.timezone,
    conversationId,
    recentTexts: recentRows.slice(-CALLBACK_RECENT).map((r) => r.content),
    settings,
    turnKey: "sys" + seq,
    opener: false,
    hisText: "",
    recentAssistantTexts,
    weather,
    env: opts.env,
    cues: false,
    exemplars: false,
    recall: false,
  });
  const state = stateSections(promptState);
  const prefix = mode === "full" ? stablePrefix() : compactPrefix();
  return { prefix, state, system: prefix + SYSTEM_SEPARATOR + state, promptVersion: PROMPT_VERSION, promptState };
}
