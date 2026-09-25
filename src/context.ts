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
import { PROMPT_VERSION, SYSTEM_SEPARATOR, buildSystemPrompt, compactPrefix, coolingOff, moodPhase, sceneMode, stablePrefix, stateSections } from "./prompt";
import { DEFAULT_SETTINGS, dayKey, getCurrentState, listAssets, listFacts, listHistory, listRecentStoryMessages, listUnknowns, nextSeq } from "./db";
import { listLog, listThreads, localParts, safeTimezone } from "./life";
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
import { getWeather } from "./weather";
import { shapeCue, signature } from "./imperfection";
import { FACE_CADENCE_UNREADABLE, himRefs, isHisFirstTurn, loadHisLook, performersCanSee, shouldShowFace, turnsSinceFaceShown } from "./hisFace";
import type { ImageRef } from "./vision";
import type {
  AssembledContext, AskRow, ChatMessage, Correction, Env, HisLook, HistoryRow, MediaRow, OutfitNow, PromptCallback, PromptState, RecallPick,
  RelationshipState, SceneState, Settings, ShapeCue, SystemMode, VisualAssetRow, VoiceLine, WantLogRow, WantRow, WeatherNow,
} from "./types";
import type { LifeThread } from "./life";

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
  recall?: boolean;
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

export async function loadPromptState(db: D1Database, recentText = "", opts: LoadOptions = {}): Promise<PromptState> {
  const now = opts.now ?? new Date();
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

  const [facts, historyAll, unknowns, rel, scene, threadsAll, log, media, approvedLines, usedIds, corrections, weights, wantsAll, asks, today, approvedAssets, recallCount, hisLook] = await Promise.all([
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
  ]);

  const recentKeywords = keywords(recentText);
  const justinAll = facts.filter((f) => f.scope === "justin" || f.scope === "shared");
  // A fact about him can only exist because they talked: it ends the stranger mode just as
  // a history entry does, so the prompt never says both at once. A faded fact still counts.
  const hasSharedHistory = historyAll.length > 0 || justinAll.length > 0;
  const living = livingThreads(threadsAll);

  // v3 (BB): what mattered and what came up recently stays; what a person would have let
  // go is not in the prompt (and comes back the moment it is touched).
  const justinFacts = attempt("rankFacts", () => rankFacts(justinAll, weights, recentKeywords, now, settings).kept, justinAll);
  const history = attempt("rankHistory", () => rankHistory(historyAll, weights, recentKeywords, now, settings).kept, selectHistory(historyAll, recentText));
  const threads = attempt("rankThreads", () => rankThreads(living, weights, recentKeywords, now, settings).kept, living);

  const mode = sceneMode(scene.state.status);
  const cooling = coolingOff(rel.state.cooling_off_until, now);
  const phase = moodPhase(rel.state, now, numSetting(settings.moodDaysDefault, 3), rel.row.created_at);
  const mood = phase === "gone" ? "" : (typeof rel.state.mood === "string" ? rel.state.mood.trim() : "");

  // v3 (BB): the one half-remembered detail; never on an opener or a first text, never
  // while the setting is 0 (the shipped default).
  let recall: RecallPick | null = null;
  if (recallEvery > 0 && !opener) {
    recall = attempt("pickProvisional", () => pickProvisional(justinAll, weights, recentKeywords, now, settings, recallCount, cooling, hasSharedHistory, opener) ?? null, null);
  }

  // v3 (GG): the shape cue, rolled against the signatures of her last two replies.
  const recentSignatures = attempt("signatures", () => (opts.recentAssistantTexts ?? []).slice(-SIGNATURE_WINDOW).map((t) => signature(t)), [] as string[]);
  let cue: ShapeCue | null = null;
  if (opts.cues !== false) {
    const voiceAllowed = settings.voiceMode !== "off" && opts.env !== undefined && attempt("voiceConfigured", () => voiceConfigured(opts.env as Env, settings), false);
    cue = attempt("shapeCue", () => shapeCue(seed + ":cue:" + turnKey, recentSignatures, {
      voiceAllowed,
      typoShare: numSetting(settings.typoCueShare, 0),
      enabled: settings.textureCuesEnabled !== false,
    }), null);
  }

  // v3 (AA): the tags this turn matches and the bank lines that fit them.
  let tags: string[] = [];
  let exemplars: VoiceLine[] = [];
  if (perTurn > 0 && approvedLines.length) {
    const localHour = localParts(now, safeTimezone(tz)).hour;
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
  // never says what she wore.
  const sceneAssets = approvedAssets.filter((a) => a.role === "scene");
  const outfit = attempt("outfitNow", () => outfitNow(sceneAssets, today, now, tz), null as unknown as OutfitNow);
  const grounding = {
    city: typeof settings.herCity === "string" ? settings.herCity.trim() : "",
    weather: opts.weather ?? null,
    outfit,
    today,
  };

  let callbacks: PromptCallback[] = [];
  try {
    // v3 (CC): the picker also sees her wants and the open asks, and knows an opener when it
    // sees one (an unanswered ask never opens a first text). Passed as a variable, not a
    // literal, so a picker that ignores the extra keys still typechecks.
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
    };
    callbacks = pickCallbacks(cbArgs).slice(0, 2);
  } catch (e) {
    // A callback is a nicety; a broken picker must never cost a turn.
    console.warn("callbacks skipped", errorClass(e));
    callbacks = [];
  }

  return {
    hasSharedHistory,
    fixedFacts: facts.filter((f) => f.scope === "fixed"),
    avelieFacts: facts.filter((f) => f.scope === "avelie"),
    justinFacts,
    history,
    unknowns,
    relationship: rel.state,
    scene: scene.state,
    mode,
    life: { threads, log, now, tz },
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
  const [recentAll, seq, weather, sinceFace] = await Promise.all([
    listRecentStoryMessages(db, conversationId, settings.contextRecentMessages),
    pendingMessageId ? Promise.resolve(0) : nextSeq(db, conversationId),
    weatherFor(opts.env, db, settings, now),
    // v3.1 (JJ): her replies since his photos last rode along here, plus this turn: Infinity
    // when never (the row says null). A failed read (the his_face_seq column not there yet,
    // before 0007) counts as just shown (FACE_CADENCE_UNREADABLE, 0), the cheap failure: the
    // Apart cadence then waits for the migration instead of the photos riding on every
    // Apart turn (v3.1 fix 2; the first turn, Together turns and a mention still show them).
    nicety("his face cadence", turnsSinceFaceShown(db, conversationId), FACE_CADENCE_UNREADABLE),
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
    now,
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
  const [recentAll, seq, weather] = await Promise.all([
    listRecentStoryMessages(db, conversationId, settings.contextRecentMessages),
    nextSeq(db, conversationId),
    weatherFor(opts.env, db, settings, now),
  ]);
  const recentRows = recentAll.filter((r) => r.content.trim().length > 0);
  const recentText = recentRows.slice(-8).map((r) => r.content).join(" ");
  const recentAssistantTexts = recentRows.filter((r) => r.role === "assistant").slice(-5).map((r) => r.content);
  const promptState = await loadPromptState(db, recentText, {
    now,
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
