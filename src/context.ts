// Bounded context assembly: approved state + relevant history + recent story messages,
// plus (v2) her life and the things she could bring up. Never the whole transcript,
// never operator-channel messages, never developer text.
import { buildSystemPrompt, sceneMode } from "./prompt";
import { dayKey, getCurrentState, listFacts, listHistory, listRecentStoryMessages, listUnknowns } from "./db";
import { listLog, listThreads } from "./life";
import { pickCallbacks } from "./callbacks";
import { listMedia } from "./media";
import { parseInboxImages } from "./images";
import { limitImageMessages } from "./vision";
import type { ImageRef } from "./vision";
import type {
  AssembledContext, ChatMessage, HistoryRow, MediaRow, PromptCallback, PromptState, RelationshipState, SceneState, Settings,
} from "./types";
import type { LifeThread } from "./life";

const STOP = new Set(["the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "at", "for", "with", "is", "it", "was", "i", "you", "he", "she", "we", "they", "that", "this", "my", "your", "her", "his", "me", "so", "do", "not", "just", "like", "what", "about", "have", "had", "be", "are", "were", "from", "as", "if", "then", "than", "too", "very", "ok", "okay", "yeah", "no", "yes"]);

const DEFAULT_TZ = "America/New_York";
// The window the callback picker checks against ("minus anything whose keywords appear in
// the last 20 messages", SPEC_V2 section K).
const CALLBACK_RECENT = 20;
// Enough log rows for the prompt's "last 5 notes" and the callback picker's recent-past look.
const LOG_ROWS = 60;

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
}

// Threads the prompt may know about: live ones and finished ones (a done event is still
// something she could mention); dropped and superseded rows are gone from her world.
function livingThreads(threads: LifeThread[]): LifeThread[] {
  return threads.filter((t) => t.status === "active" || t.status === "done");
}

export async function loadPromptState(db: D1Database, recentText = "", opts: LoadOptions = {}): Promise<PromptState> {
  const now = opts.now ?? new Date();
  const tz = opts.tz && opts.tz.trim() ? opts.tz.trim() : DEFAULT_TZ;
  const [facts, historyAll, unknowns, rel, scene, threadsAll, log, media] = await Promise.all([
    listFacts(db),
    listHistory(db),
    listUnknowns(db, "open"),
    getCurrentState<RelationshipState>(db, "relationship"),
    getCurrentState<SceneState>(db, "scene"),
    listThreads(db),
    listLog(db, LOG_ROWS),
    // The library is a nicety; a missing table (migration not applied yet) costs no turn.
    listMedia(db).catch((): MediaRow[] => []),
  ]);
  const history = selectHistory(historyAll, recentText);
  const justinFacts = facts.filter((f) => f.scope === "justin" || f.scope === "shared");
  const threads = livingThreads(threadsAll);
  let callbacks: PromptCallback[] = [];
  try {
    callbacks = pickCallbacks({
      history: historyAll,
      threads,
      log,
      recentTexts: opts.recentTexts ?? [],
      now,
      seed: callbackSeed(now, opts.conversationId ?? null),
    }).slice(0, 2);
  } catch (e) {
    // A callback is a nicety; a broken picker must never cost a turn.
    console.warn("callbacks skipped", e instanceof Error ? e.name : "error");
    callbacks = [];
  }
  return {
    // A fact about him can only exist because they talked: it ends the stranger mode
    // just as a history entry does, so the prompt never says both at once.
    hasSharedHistory: historyAll.length > 0 || justinFacts.length > 0,
    fixedFacts: facts.filter((f) => f.scope === "fixed"),
    avelieFacts: facts.filter((f) => f.scope === "avelie"),
    justinFacts,
    history,
    unknowns,
    relationship: rel.state,
    scene: scene.state,
    mode: sceneMode(scene.state.status),
    life: { threads, log, now, tz },
    callbacks,
    media,
  };
}

// The photos on a stored message of his, as refs the adapters can load.
function imageRefs(row: { role: string; images_json?: string | null }): ImageRef[] {
  if (row.role !== "user" || !row.images_json) return [];
  return parseInboxImages(row.images_json).map((i) => ({ key: i.key, mime: i.mime }));
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
): Promise<AssembledContext> {
  const recentRows = (await listRecentStoryMessages(db, conversationId, settings.contextRecentMessages))
    .filter((r) => r.content.trim().length > 0 && r.id !== pendingMessageId);
  const chat: ChatMessage[] = recentRows.map((r) => {
    const images = imageRefs(r);
    return images.length ? { role: r.role, content: r.content, images } : { role: r.role, content: r.content };
  });
  const pendingRefs = pendingImages.filter((i) => i && typeof i.key === "string" && i.key);
  chat.push(pendingRefs.length ? { role: "user", content: pendingUserText, images: pendingRefs } : { role: "user", content: pendingUserText });
  const messages = boundMessages(limitImageMessages(chat), settings.contextMaxChars);
  const recentText = messages.slice(-8).map((m) => m.content).join(" ");
  const state = await loadPromptState(db, recentText, {
    now,
    tz: settings.timezone,
    conversationId,
    recentTexts: [...recentRows.slice(-CALLBACK_RECENT).map((r) => r.content), pendingUserText],
  });
  const built = buildSystemPrompt(state);
  const recentAssistantTexts = recentRows.filter((r) => r.role === "assistant").slice(-5).map((r) => r.content);
  return { state, system: built.system, promptVersion: built.promptVersion, messages, recentAssistantTexts };
}
