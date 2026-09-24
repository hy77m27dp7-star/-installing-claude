// Bounded context assembly: approved state + relevant history + recent story messages.
// Never the whole transcript, never operator-channel messages, never developer text.
import { buildSystemPrompt } from "./prompt";
import { getCurrentState, listFacts, listHistory, listRecentStoryMessages, listUnknowns } from "./db";
import type { AssembledContext, ChatMessage, HistoryRow, PromptState, RelationshipState, SceneState, Settings } from "./types";

const STOP = new Set(["the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "at", "for", "with", "is", "it", "was", "i", "you", "he", "she", "we", "they", "that", "this", "my", "your", "her", "his", "me", "so", "do", "not", "just", "like", "what", "about", "have", "had", "be", "are", "were", "from", "as", "if", "then", "than", "too", "very", "ok", "okay", "yeah", "no", "yes"]);

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

export async function loadPromptState(db: D1Database, recentText = ""): Promise<PromptState> {
  const [facts, historyAll, unknowns, rel, scene] = await Promise.all([
    listFacts(db),
    listHistory(db),
    listUnknowns(db, "open"),
    getCurrentState<RelationshipState>(db, "relationship"),
    getCurrentState<SceneState>(db, "scene"),
  ]);
  const history = selectHistory(historyAll, recentText);
  const justinFacts = facts.filter((f) => f.scope === "justin" || f.scope === "shared");
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
  };
}

// pendingMessageId names a stored user row that pendingUserText repeats (an idempotent
// resume), so it is not sent twice. Rows with no text are dropped: providers reject
// empty content, and an empty row would otherwise block every later turn.
export async function assembleContext(
  db: D1Database,
  conversationId: string,
  settings: Settings,
  pendingUserText: string,
  pendingMessageId: string | null = null,
): Promise<AssembledContext> {
  const recentRows = (await listRecentStoryMessages(db, conversationId, settings.contextRecentMessages))
    .filter((r) => r.content.trim().length > 0 && r.id !== pendingMessageId);
  const chat: ChatMessage[] = recentRows.map((r) => ({ role: r.role, content: r.content }));
  chat.push({ role: "user", content: pendingUserText });
  const messages = boundMessages(chat, settings.contextMaxChars);
  const recentText = messages.slice(-8).map((m) => m.content).join(" ");
  const state = await loadPromptState(db, recentText);
  const built = buildSystemPrompt(state);
  const recentAssistantTexts = recentRows.filter((r) => r.role === "assistant").slice(-5).map((r) => r.content);
  return { state, system: built.system, promptVersion: built.promptVersion, messages, recentAssistantTexts };
}
