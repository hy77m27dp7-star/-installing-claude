// Callbacks she could start: things from the record old enough to bring up again and
// not touched in the recent conversation. Pure and deterministic by seed (the UTC date
// plus the conversation id), at most two, never an instruction to ask a question.
import { agoLabel, parseSchedule, seededUnit } from "./life";
import type { LifeLog, LifeThread } from "./life";
import type { HistoryRow } from "./types";

export interface Callback {
  text: string;
  ageDays: number;
  sourceId: string;
}

interface Candidate extends Callback {
  kind: "history" | "arc" | "person" | "event" | "log";
  // The words that identify it (a name, a title) and every word of its line.
  key: Set<string>;
  words: Set<string>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_MIN_AGE_DAYS = 3;
const EVENT_WINDOW_DAYS = 14;
const LOG_WINDOW_DAYS = 14;
const MAX_PICK = 2;
const MAX_TEXT = 160;

// The same stop list context.ts uses for history selection (kept local: prompt.ts
// imports this module, and context.ts imports prompt.ts).
const STOP = new Set(["the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "at", "for", "with", "is", "it", "was", "i", "you", "he", "she", "we", "they", "that", "this", "my", "your", "her", "his", "me", "so", "do", "not", "just", "like", "what", "about", "have", "had", "be", "are", "were", "from", "as", "if", "then", "than", "too", "very", "ok", "okay", "yeah", "no", "yes"]);

function words(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/)) {
    const t = w.replace(/^'+|'+$/g, "");
    if (t.length >= 3 && !STOP.has(t)) out.add(t);
  }
  return out;
}

function firstSentence(s: string | null, max = 120): string {
  if (!s) return "";
  const first = s.trim().split(/\r?\n/)[0]?.split(/(?<=[.!?])\s+/)[0] ?? "";
  return first.length > max ? first.slice(0, max - 3) + "..." : first;
}

function clip(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > MAX_TEXT ? t.slice(0, MAX_TEXT - 3) + "..." : t;
}

function ageDays(from: number, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - from) / DAY_MS));
}

function parseDate(s: string | null | undefined): number {
  if (!s) return NaN;
  return Date.parse(s);
}

function candidate(kind: Candidate["kind"], sourceId: string, key: string, text: string, age: number): Candidate | null {
  const t = clip(text);
  if (!t) return null;
  return { kind, sourceId, text: t, ageDays: age, key: words(key), words: words(t) };
}

function overlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n;
}

// Mentioned recently: half or more of its identifying words (a name counts on its own),
// or three words of its whole line, appear in the last messages.
function mentioned(c: Candidate, recent: Set<string>): boolean {
  if (c.key.size && overlap(c.key, recent) >= Math.ceil(c.key.size / 2)) return true;
  return c.words.size >= 3 && overlap(c.words, recent) >= 3;
}

export function pickCallbacks(args: {
  history: HistoryRow[];
  threads: LifeThread[];
  log: LifeLog[];
  recentTexts: string[];
  now: Date;
  seed: string;
}): Array<{ text: string; ageDays: number; sourceId: string }> {
  const now = args.now;
  const t = now.getTime();
  const threads = Array.isArray(args.threads) ? args.threads : [];
  const titles = new Map<string, string>();
  for (const th of threads) titles.set(th.id, th.title);
  const list: Candidate[] = [];

  for (const h of Array.isArray(args.history) ? args.history : []) {
    if (!h || h.status !== "approved") continue;
    const when = Number.isFinite(parseDate(h.occurred)) ? parseDate(h.occurred) : parseDate(h.created_at);
    if (!Number.isFinite(when)) continue;
    const age = ageDays(when, now);
    if (age < HISTORY_MIN_AGE_DAYS) continue;
    const c = candidate("history", h.id, h.title, h.title, age);
    if (c) list.push(c);
  }

  for (const th of threads) {
    if (!th) continue;
    if (th.kind === "arc" && th.status === "active") {
      const d = firstSentence(th.detail);
      const c = candidate("arc", th.id, th.title, th.title + (d ? ": " + d : ""), ageDays(parseDate(th.updated_at) || t, now));
      if (c) list.push(c);
    } else if (th.kind === "person" && th.status === "active") {
      const d = firstSentence(th.detail);
      const rel = th.relation ? ` (${th.relation})` : "";
      const c = candidate("person", th.id, th.title, th.title + rel + (d ? ": " + d : ""), ageDays(parseDate(th.updated_at) || t, now));
      if (c) list.push(c);
    } else if (th.kind === "event" && (th.status === "active" || th.status === "done")) {
      const sched = parseSchedule(th.schedule_json);
      const at = sched && sched.at ? parseDate(sched.at) : NaN;
      if (!Number.isFinite(at) || at >= t || t - at > EVENT_WINDOW_DAYS * DAY_MS) continue;
      const d = firstSentence(th.detail);
      const label = sched?.label ?? th.title;
      const c = candidate("event", th.id, label + " " + th.title, label + (d ? ": " + d : ""), ageDays(at, now));
      if (c) list.push(c);
    }
  }

  for (const l of Array.isArray(args.log) ? args.log : []) {
    if (!l) continue;
    const at = parseDate(l.occurred);
    if (!Number.isFinite(at) || at > t || t - at > LOG_WINDOW_DAYS * DAY_MS) continue;
    const who = l.thread_id ? titles.get(l.thread_id) : undefined;
    const note = firstSentence(l.note, MAX_TEXT);
    const c = candidate("log", l.id, note, (who ? who + ": " : "") + note, ageDays(at, now));
    if (c) list.push(c);
  }

  const recent = words((Array.isArray(args.recentTexts) ? args.recentTexts : []).join(" "));
  const eligible = list.filter((c) => !mentioned(c, recent));

  // Deterministic order from the seed; two picks, from different kinds when possible.
  const ranked = eligible
    .map((c) => ({ c, key: seededUnit(args.seed + "|" + c.sourceId) }))
    .sort((a, b) => a.key - b.key || a.c.sourceId.localeCompare(b.c.sourceId))
    .map((x) => x.c);
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const c of ranked) {
    if (out.length >= MAX_PICK) break;
    if (seen.has(c.sourceId)) continue;
    if (out.length === 1 && out[0]?.kind === c.kind && ranked.some((o) => !seen.has(o.sourceId) && o.kind !== c.kind)) continue;
    seen.add(c.sourceId);
    out.push(c);
  }
  if (out.length < MAX_PICK) {
    for (const c of ranked) {
      if (out.length >= MAX_PICK) break;
      if (!seen.has(c.sourceId)) { seen.add(c.sourceId); out.push(c); }
    }
  }
  return out.map((c) => ({ text: c.text, ageDays: c.ageDays, sourceId: c.sourceId }));
}

export function callbacksSection(items: ReturnType<typeof pickCallbacks>): string {
  const list = (Array.isArray(items) ? items : []).filter((i) => i && typeof i.text === "string" && i.text.trim()).slice(0, MAX_PICK);
  if (!list.length) return "";
  return [
    "THINGS YOU COULD BRING UP (only if it fits; most turns you will not)",
    "Yours, not a script. One at most, the way it would come up in a text, or neither.",
    ...list.map((i) => `- ${agoLabel(i.ageDays)}: ${i.text.trim()}`),
  ].join("\n");
}
