// Callbacks she could start: things from the record old enough to bring up again and
// not touched in the recent conversation. Pure and deterministic by seed (the UTC date
// plus the conversation id), at most two, never an instruction to ask a question.
//
// v5 (SPEC_V5 sections 1 and 2): with a story clock every age is story time (a held Together
// scene never counts) and a life event that fell inside a held span is read at the same
// distance after it (deferredInstant); dated beats on her wants are a kind of their own.
// Only ACTIVE person and arc threads are read, so a person of her past (a done thread)
// never becomes a callback.
import { agoLabel, formatClock, localParts, parseSchedule, safeTimezone, seededUnit, WEEKDAYS } from "./life";
import type { LifeLog, LifeThread } from "./life";
import type { HistoryRow } from "./types";
import type { AskRow, WantLogRow, WantRow } from "./wants";
import { deferredInstant, localDayKeyOf, storyElapsedMs, storyNow } from "./clock";
import type { StoryClock } from "./clock";
import { OUTCOME_LOG, outcomeWords } from "./arcs";
import type { BeatView } from "./arcs";

export interface Callback {
  text: string;
  ageDays: number;
  sourceId: string;
}

// v3 (SPEC_V3 section CC) adds kinds want and ask; v5 (SPEC_V5 section 2) adds beat.
export type CallbackKind = "history" | "arc" | "person" | "event" | "log" | "want" | "ask" | "beat";

interface Candidate extends Callback {
  kind: CallbackKind;
  // The words that identify it (a name, a title) and every word of its line.
  key: Set<string>;
  words: Set<string>;
  // v3: a want whose newest log row is a setback (kept out of an opener).
  setback?: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_MIN_AGE_DAYS = 3;
const EVENT_WINDOW_DAYS = 14;
const LOG_WINDOW_DAYS = 14;
const MAX_PICK = 2;
const MAX_TEXT = 160;
// v3: a want counts once it has sat still for two days; an ask once it has waited three
// and she has not brought it up yet.
const WANT_STILL_DAYS = 2;
const ASK_MIN_AGE_DAYS = 3;
// v5: a resolved step is fresh for three story days; a pending one counts two days ahead.
const BEAT_RESOLVED_DAYS = 3;
const BEAT_AHEAD_DAYS = 2;

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

// The local calendar day as a day number, so two instants subtract to calendar days.
function dayNumber(ms: number, tz: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDayKeyOf(new Date(ms), tz));
  if (!m) return NaN;
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS);
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

// The newest want_log row per want (by occurred, then created_at).
function newestLogByWant(log: WantLogRow[]): Map<string, WantLogRow> {
  const out = new Map<string, WantLogRow>();
  for (const l of log) {
    if (!l || !l.want_id) continue;
    const cur = out.get(l.want_id);
    if (!cur) { out.set(l.want_id, l); continue; }
    const diff = (parseDate(l.occurred) || 0) - (parseDate(cur.occurred) || 0) || (l.created_at ?? "").localeCompare(cur.created_at ?? "");
    if (diff > 0) out.set(l.want_id, l);
  }
  return out;
}

export function pickCallbacks(args: {
  history: HistoryRow[];
  threads: LifeThread[];
  log: LifeLog[];
  recentTexts: string[];
  now: Date;
  seed: string;
  // v3 (SPEC_V3 section CC): her wants and open asks as candidates; `opener` is true for
  // her own first text of a conversation or of the day (POST /open, her first texts).
  wants?: WantRow[];
  wantLog?: WantLogRow[];
  asks?: AskRow[];
  opener?: boolean;
  // v5 (SPEC_V5 sections 1 and 2): the dated beats on her wants and the story clock. With a
  // clock every age is story time, measured to the real instant the clock was read at, and
  // "now" is the story now. `tz` names the calendar a pending beat's day word is read in
  // (her timezone; UTC when absent).
  beats?: BeatView[];
  clock?: StoryClock | null;
  tz?: string;
}): Array<{ text: string; ageDays: number; sourceId: string }> {
  const clock = args.clock ?? null;
  const now = clock ? storyNow(clock) : args.now;
  const t = now.getTime();
  const opener = args.opener === true;
  // v5: the elapsed time since an instant, in story time with a clock, real time without.
  const sinceMs = (from: number): number => {
    if (!Number.isFinite(from)) return 0;
    if (clock) return storyElapsedMs(clock, new Date(from).toISOString(), clock.real);
    return Math.max(0, t - from);
  };
  const ageOf = (from: number): number => Math.max(0, Math.floor(sinceMs(from) / DAY_MS));
  const threads = Array.isArray(args.threads) ? args.threads : [];
  const titles = new Map<string, string>();
  for (const th of threads) titles.set(th.id, th.title);
  const list: Candidate[] = [];

  // v3: active wants that have sat still for two days, with their last note; open asks
  // older than three days that she has not brought up again. Her first text never opens
  // with an ask or a setback (the retention hook the opener note forbids by another name).
  const newestLog = newestLogByWant(Array.isArray(args.wantLog) ? args.wantLog : []);
  for (const w of Array.isArray(args.wants) ? args.wants : []) {
    if (!w || w.status !== "active" || typeof w.title !== "string" || !w.title.trim()) continue;
    const moved = Number.isFinite(parseDate(w.last_moved)) ? parseDate(w.last_moved) : parseDate(w.created_at);
    if (!Number.isFinite(moved) || sinceMs(moved) < WANT_STILL_DAYS * DAY_MS) continue;
    const last = newestLog.get(w.id);
    const setback = !!last && last.kind === "setback";
    if (opener && setback) continue;
    const note = last ? firstSentence(last.note, MAX_TEXT) : "";
    const c = candidate("want", w.id, w.title, w.title + (note ? ": " + note : ""), ageOf(moved));
    if (c) { c.setback = setback; list.push(c); }
  }
  if (!opener) {
    for (const a of Array.isArray(args.asks) ? args.asks : []) {
      if (!a || a.status !== "open" || typeof a.text !== "string" || !a.text.trim()) continue;
      if ((a.brought_up ?? 0) !== 0) continue;
      const asked = parseDate(a.asked_at);
      if (!Number.isFinite(asked) || sinceMs(asked) < ASK_MIN_AGE_DAYS * DAY_MS) continue;
      const c = candidate("ask", a.id, a.text, "you asked him: " + a.text, ageOf(asked));
      if (c) list.push(c);
    }
  }

  for (const h of Array.isArray(args.history) ? args.history : []) {
    if (!h || h.status !== "approved") continue;
    const when = Number.isFinite(parseDate(h.occurred)) ? parseDate(h.occurred) : parseDate(h.created_at);
    if (!Number.isFinite(when)) continue;
    const age = ageOf(when);
    if (age < HISTORY_MIN_AGE_DAYS) continue;
    const c = candidate("history", h.id, h.title, h.title, age);
    if (c) list.push(c);
  }

  for (const th of threads) {
    if (!th) continue;
    if (th.kind === "arc" && th.status === "active") {
      const d = firstSentence(th.detail);
      const c = candidate("arc", th.id, th.title, th.title + (d ? ": " + d : ""), ageOf(parseDate(th.updated_at) || t));
      if (c) list.push(c);
    } else if (th.kind === "person" && th.status === "active") {
      const d = firstSentence(th.detail);
      const rel = th.relation ? ` (${th.relation})` : "";
      const c = candidate("person", th.id, th.title, th.title + rel + (d ? ": " + d : ""), ageOf(parseDate(th.updated_at) || t));
      if (c) list.push(c);
    } else if (th.kind === "event" && (th.status === "active" || th.status === "done")) {
      const sched = parseSchedule(th.schedule_json);
      // v5: an event that fell inside a held span is read the same distance after it.
      const at = sched && sched.at ? parseDate(clock ? deferredInstant(clock, sched.at) : sched.at) : NaN;
      if (!Number.isFinite(at) || at >= t || sinceMs(at) > EVENT_WINDOW_DAYS * DAY_MS) continue;
      const d = firstSentence(th.detail);
      const label = sched?.label ?? th.title;
      const c = candidate("event", th.id, label + " " + th.title, label + (d ? ": " + d : ""), ageOf(at));
      if (c) list.push(c);
    }
  }

  for (const l of Array.isArray(args.log) ? args.log : []) {
    if (!l) continue;
    const at = parseDate(l.occurred);
    if (!Number.isFinite(at) || at > t || sinceMs(at) > LOG_WINDOW_DAYS * DAY_MS) continue;
    const who = l.thread_id ? titles.get(l.thread_id) : undefined;
    const note = firstSentence(l.note, MAX_TEXT);
    const c = candidate("log", l.id, note, (who ? who + ": " : "") + note, ageOf(at));
    if (c) list.push(c);
  }

  // v5: dated beats on her wants (the owner run). A resolved one at most three story days
  // past its due instant ("the open mic: you went and it went well"; never what he did about
  // it) and a pending one due within the next two days ("sign up: tomorrow at 6:00pm"). Her
  // first text never leads with a setback outcome.
  const zone = safeTimezone(typeof args.tz === "string" ? args.tz : "");
  for (const v of Array.isArray(args.beats) ? args.beats : []) {
    const run = v?.run;
    const beat = v?.beat;
    if (!run || !beat || beat.status !== "active" || typeof beat.title !== "string" || !beat.title.trim()) continue;
    if (v.want && v.want.status === "dropped") continue;
    const due = parseDate(run.due_at);
    if (!Number.isFinite(due)) continue;
    const title = beat.title.trim().replace(/[.!?;:,\s]+$/, "");
    if (run.status === "resolved" && run.outcome && OUTCOME_LOG[run.outcome]) {
      if (due > t || sinceMs(due) > BEAT_RESOLVED_DAYS * DAY_MS) continue;
      const setback = OUTCOME_LOG[run.outcome].kind === "setback";
      if (opener && setback) continue;
      const c = candidate("beat", run.id, title, `${title}: ${outcomeWords(run.outcome)}`, ageOf(due));
      if (c) { c.setback = setback; list.push(c); }
    } else if (run.status === "pending" && due > t && due - t <= BEAT_AHEAD_DAYS * DAY_MS) {
      const diff = dayNumber(due, zone) - dayNumber(t, zone);
      const p = localParts(new Date(due), zone);
      const day = !Number.isFinite(diff) || diff <= 0 ? "today" : diff === 1 ? "tomorrow" : (WEEKDAYS[p.weekday] ?? "soon");
      const when = day + (beat.due_time ? " at " + formatClock(p.hour * 60 + p.minute) : "");
      const c = candidate("beat", run.id, title, `${title}: ${when}`, ageOf(parseDate(beat.created_at)));
      if (c) list.push(c);
    }
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
