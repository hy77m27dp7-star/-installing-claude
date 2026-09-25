// v3.2 "Said in this conversation" and "memory keeps itself": the pure helpers that read a
// proposal line, key it by its content words and deduplicate a list. Shared by context.ts
// (the prompt) and proposals.ts (automatic keeping), so this file imports nothing heavy.
import type { FactRow, SaidHere } from "./types";

// "Said in this conversation": her memory used to be approval-gated, but what he told her an hour
// ago in the chat she is in is known whether or not the owner has approved it yet. The pending
// justin_fact and avelie_fact proposals of the current conversation ride into the prompt as
// such, deduplicated against each other and against the facts already in memory.
const SAID_STOP = new Set(["a", "an", "the", "is", "are", "was", "were", "be", "his", "her", "he", "she", "him", "it", "its", "that", "this", "of", "to", "and", "s"]);

// One line, plain typography (" -- " and "..."), trimmed and capped.
export function saidLine(text: unknown, max = 160): string {
  if (typeof text !== "string") return "";
  const t = text.replace(/[\u2014\u2013]/g, " -- ").replace(/\u2026/g, "...").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 3).trimEnd() + "..." : t;
}

// The identity of a line for deduplication: its content words as a sorted set, so "His name
// is Justin" and "Justin's name is Justin" are one line.
export function saidKey(text: string): string {
  const words = text.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(" ").filter((w) => w && !SAID_STOP.has(w));
  return Array.from(new Set(words)).sort().join(" ");
}

export function dedupeSaid(lines: readonly string[], exclude: readonly string[] = [], cap = 25): string[] {
  const seen = new Set(exclude.map((e) => saidKey(saidLine(e))).filter(Boolean));
  const out: string[] = [];
  for (const raw of Array.isArray(lines) ? lines : []) {
    const t = saidLine(raw);
    if (!t) continue;
    const k = saidKey(t);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out.length > cap ? out.slice(-cap) : out;
}

export interface SaidRow { kind: string; proposal: string }

// The pending proposal lines of one conversation, oldest first. A read failure is the caller's
// nicety (empty lists), never a failed turn.
export async function listSaidRows(db: D1Database, conversationId: string): Promise<SaidRow[]> {
  const r = await db.prepare("SELECT kind, proposal FROM proposals WHERE conversation_id = ?1 AND status = 'pending' AND kind IN ('justin_fact', 'avelie_fact') ORDER BY created_at ASC LIMIT 200").bind(conversationId).all<SaidRow>();
  return (r.results ?? []).filter((x) => x && typeof x.proposal === "string");
}

export function buildSaidHere(rows: readonly SaidRow[], justinFacts: readonly FactRow[], avelieFacts: readonly FactRow[]): SaidHere {
  return {
    him: dedupeSaid(rows.filter((x) => x.kind === "justin_fact").map((x) => x.proposal), justinFacts.map((f) => f.fact)),
    her: dedupeSaid(rows.filter((x) => x.kind === "avelie_fact").map((x) => x.proposal), avelieFacts.map((f) => f.fact)),
  };
}

