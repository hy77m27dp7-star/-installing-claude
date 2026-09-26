// Arcs that go somewhere (SPEC_V5 section 2): dated beats on her wants. A beat is the
// authored step (arc_beats: title, kind, local date and time, variants); its run is that
// step for one reader (beat_runs: the reader's due instant, which moves only when a scene
// of his was held across it, and the outcome). v5 has one reader, "owner".
//
// A beat is written by the owner, or by a promoted want_beat proposal (she named a dated
// step in the conversation); never by a model on its own. An outcome arrives by a promoted
// beat_outcome proposal (the extractor, from her own words, or the nightly arc step below)
// or by the owner's Resolve. Nothing a model decides here is written to a story table
// directly: the nightly step files a proposal and the owner (or his auto-keep) decides.
//
// The move of pending runs when a held span closes is NOT here: it is shiftBeatsForSpan in
// src/clock.ts, beside the sync that calls it, so clock.ts never imports this module.
// wants.ts never imports this module either (the caller renders beat lines with
// beatLinesByWant and hands them to wantsSection).
import { auditStmt, getCurrentState, listFacts, newId, nowIso } from "./db";
import { ApiHttpError } from "./errors";
import { agoLabel, formatClock, localParts, safeTimezone, WEEKDAYS } from "./life";
import { saidLine } from "./said";
import { herDayKey, localDayKeyOf, localInstant, storyAgeDays, storyElapsedMs, storyNow } from "./clock";
import type { StoryClock } from "./clock";
import { cleanLine, fileNightlyProposals, paidJsonCall, parseJsonObject } from "./storycall";
import type { NightlyBudget, StepResult } from "./storycall";
import { findWant, getWant, logWant, moodLine, moodNow } from "./wants";
import type { WantLogKind, WantRow } from "./wants";
import type { Env, FactRow, RelationshipState, Settings } from "./types";

// ------------------------------------------------------------------ types and constants

export type BeatKind = "step" | "event";
export type BeatOutcome = "did_it" | "missed" | "went" | "went_well" | "went_badly" | "chickened_out" | "postponed";
export type HisPart = "encouraged" | "asked" | "came" | "forgot" | "none";

export const STEP_OUTCOMES: readonly BeatOutcome[] = ["did_it", "missed", "postponed"];
export const EVENT_OUTCOMES: readonly BeatOutcome[] = ["went", "went_well", "went_badly", "chickened_out", "postponed"];
export const HIS_PARTS: readonly HisPart[] = ["encouraged", "asked", "came", "forgot", "none"];
export const OWNER_READER = "owner";
export const ARC_PREFIX = "Decide how one dated step";
export const BEAT_RESOLVE_AFTER_MS = 60 * 60 * 1000;
export const BEAT_MAX_ATTEMPTS = 2;
export const BEAT_VARIANTS_MAX = 4;
export const OUTCOME_LOG: Record<BeatOutcome, { kind: WantLogKind; delta: number | null }> = {
  did_it: { kind: "progress", delta: 15 },
  went: { kind: "progress", delta: 10 },
  went_well: { kind: "progress", delta: 20 },
  went_badly: { kind: "setback", delta: 10 },
  chickened_out: { kind: "setback", delta: 10 },
  missed: { kind: "setback", delta: 5 },
  postponed: { kind: "note", delta: null },
};

export interface ArcBeatRow {
  id: string;
  want_id: string;
  title: string;
  kind: BeatKind;
  due_on: string;
  due_time: string | null;
  due_at: string;
  variants_json: string | null;
  status: "active" | "cancelled";
  source: string | null;
  created_at: string;
  updated_at: string;
}

export interface BeatRunRow {
  id: string;
  beat_id: string;
  reader: string;
  status: "pending" | "proposed" | "resolved" | "skipped";
  due_at: string;
  outcome: BeatOutcome | null;
  variant_id: string | null;
  outcome_note: string | null;
  his_part: HisPart | null;
  his_note: string | null;
  evidence_json: string | null;
  proposal_id: string | null;
  attempts: number;
  shifted_ms: number;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BeatVariant { id: string; outcome: BeatOutcome; note: string }

export interface BeatView {
  beat: ArcBeatRow;
  run: BeatRunRow | null;
  want: { id: string; title: string; status: string };
  variants: BeatVariant[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const IN_CHUNK = 90;
const MAX_TITLE = 200;
const MAX_NOTE = 300;
const MAX_HIS_NOTE = 160;
const MAX_EVIDENCE = 20;
const PASSED_DAYS = 3;
const WITH_HIM_MAX = 30;
const WITH_HIM_BACK_DAYS = 14;
const HIS_READ_MAX = 500;
const TOGETHER_AROUND_MS = 6 * HOUR_MS;
const HER_FACTS_MAX = 8;
const HER_OPINIONS_MAX = 4;
const OPINION_PREFIX = "opinion:";
const OUTCOME_SET = new Set<string>([...STEP_OUTCOMES, ...EVENT_OUTCOMES]);

// ------------------------------------------------------------------ small helpers

function isBeatKind(v: unknown): v is BeatKind {
  return v === "step" || v === "event";
}

function isHisPart(v: unknown): v is HisPart {
  return typeof v === "string" && (HIS_PARTS as readonly string[]).includes(v);
}

function isOutcome(v: unknown): v is BeatOutcome {
  return typeof v === "string" && OUTCOME_SET.has(v);
}

function parseMs(s: string | null | undefined): number {
  return typeof s === "string" && s ? Date.parse(s) : NaN;
}

// A local calendar day key ("YYYY-MM-DD") as a day number, so two keys subtract to days.
function dayNumber(key: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return NaN;
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS);
}

function calendarDiff(fromMs: number, toMs: number, tz: string): number {
  return dayNumber(localDayKeyOf(new Date(toMs), tz)) - dayNumber(localDayKeyOf(new Date(fromMs), tz));
}

function weekdayOf(ms: number, tz: string): string {
  return WEEKDAYS[localParts(new Date(ms), tz).weekday] ?? "";
}

function clockOf(ms: number, tz: string): string {
  const p = localParts(new Date(ms), tz);
  return formatClock(p.hour * 60 + p.minute);
}

function hhmmOf(ms: number, tz: string): string {
  const p = localParts(new Date(ms), tz);
  return String(p.hour).padStart(2, "0") + ":" + String(p.minute).padStart(2, "0");
}

// A line's own trailing stop dropped, so a sentence built around it never reads "..".
function bare(s: string | null | undefined): string {
  if (typeof s !== "string") return "";
  const t = saidLine(s, 400);
  return t.endsWith("...") ? t : t.replace(/[.!?;:,\s]+$/, "");
}

function chunk<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function settingNumber(settings: unknown, key: string, fallback: number, lo: number, hi: number): number {
  const v = settings && typeof settings === "object" ? (settings as Record<string, unknown>)[key] : undefined;
  return typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fallback;
}

function settingString(settings: unknown, key: string, fallback: string): string {
  const v = settings && typeof settings === "object" ? (settings as Record<string, unknown>)[key] : undefined;
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}

// Content words for keyword matching, loosely stemmed ("sings" and "singing" meet "sing").
const KEY_STOP = new Set(["the", "and", "but", "for", "with", "that", "this", "your", "from", "have", "what", "about", "then", "than", "very", "just", "like", "into", "over", "they", "them", "their", "there", "when", "will", "would", "could", "should", "been", "were", "some"]);
function stem(w: string): string {
  if (w.length > 6 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 5 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 5 && w.endsWith("es")) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}
function keywords(text: string, minLen = 4): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/)) {
    const w = raw.replace(/^'+|'+$/g, "").replace(/'s$/, "");
    if (w.length < minLen || KEY_STOP.has(w)) continue;
    out.add(stem(w));
  }
  return out;
}
function shares(a: Set<string>, b: Set<string>): boolean {
  for (const w of a) if (b.has(w)) return true;
  return false;
}

// ------------------------------------------------------------------ pure half

export function outcomesFor(kind: BeatKind): readonly BeatOutcome[] {
  return kind === "step" ? STEP_OUTCOMES : EVENT_OUTCOMES;
}

export function validateVariants(v: unknown, kind: BeatKind): BeatVariant[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new ApiHttpError(400, "validation", "variants must be a list");
  if (v.length > BEAT_VARIANTS_MAX) throw new ApiHttpError(400, "validation", `at most ${BEAT_VARIANTS_MAX} variants`);
  const allowed = outcomesFor(kind);
  const out: BeatVariant[] = [];
  v.forEach((item, i) => {
    if (!item || typeof item !== "object") throw new ApiHttpError(400, "validation", `variant ${i + 1} must be an object`);
    const o = item as Record<string, unknown>;
    if (typeof o.outcome !== "string" || !(allowed as readonly string[]).includes(o.outcome)) {
      throw new ApiHttpError(400, "validation", `variant ${i + 1} outcome must be one of ${allowed.join(", ")}`);
    }
    const note = saidLine(o.note, 10000);
    if (!note) throw new ApiHttpError(400, "validation", `variant ${i + 1} needs a note`);
    if (note.length > MAX_NOTE) throw new ApiHttpError(400, "validation", `variant ${i + 1} note exceeds ${MAX_NOTE} characters`);
    out.push({ id: `v${i + 1}`, outcome: o.outcome as BeatOutcome, note });
  });
  return out;
}

export function parseVariants(json: string | null, kind: BeatKind): BeatVariant[] {
  if (typeof json !== "string" || !json.trim()) return [];
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  const allowed = outcomesFor(kind) as readonly string[];
  const out: BeatVariant[] = [];
  for (const item of raw) {
    if (out.length >= BEAT_VARIANTS_MAX) break;
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o.outcome !== "string" || !allowed.includes(o.outcome)) continue;
    const note = saidLine(o.note, MAX_NOTE);
    if (!note) continue;
    const id = typeof o.id === "string" && o.id.trim() ? o.id.trim() : `v${out.length + 1}`;
    out.push({ id, outcome: o.outcome as BeatOutcome, note });
  }
  return out;
}

export function dueAtFor(dueOn: string, dueTime: string | null, tz: string): string {
  return localInstant(dueOn, dueTime ?? "23:59", tz);
}

export function beatIsDue(run: BeatRunRow, storyNowMs: number): boolean {
  if (!run || run.status !== "pending") return false;
  const due = parseMs(run.due_at);
  return Number.isFinite(due) && due + BEAT_RESOLVE_AFTER_MS <= storyNowMs;
}

export function outcomeWords(o: BeatOutcome): string {
  switch (o) {
    case "did_it": return "you did it";
    case "missed": return "you missed it";
    case "went": return "you went";
    case "went_well": return "you went and it went well";
    case "went_badly": return "you went and it went badly";
    case "chickened_out": return "you got scared and did not go";
    case "postponed": return "it got moved";
    default: return "";
  }
}

export function hisPartSentence(p: HisPart | null, note: string | null): string {
  const n = bare(note);
  switch (p) {
    case "encouraged": return " He encouraged you before it" + (n ? ": " + n : "") + ".";
    case "asked": return " He asked how it went.";
    case "came": return " He came" + (n ? ": " + n : "") + ".";
    case "forgot": return " He knew about it and never asked; you noticed, and it is not a debt.";
    default: return "";
  }
}

// The his-part sentence at the end of a "Lately" line (src/finetune.ts cuts it from a
// training line: what he did about her step is about him).
export const HIS_PART_RE = /\s+He (?:encouraged you before it|asked how it went|came\b|knew about it and never asked)[^\n]*$/;

// The age in days of an instant: story time with a clock, real time against `now` without.
function ageDaysOf(iso: string, now: Date, clock: StoryClock | null): number {
  if (clock) return storyAgeDays(clock, iso);
  const t = parseMs(iso);
  return Number.isFinite(t) ? Math.max(0, (now.getTime() - t) / DAY_MS) : 0;
}

type LineKind = "coming" | "was" | "lately";

function beatLine(view: BeatView, now: Date, tz: string, clock: StoryClock | null, opts: { horizonDays: number; memoryDays: number; opener?: boolean }): { kind: LineKind; line: string; at: number } | null {
  const run = view?.run;
  const beat = view?.beat;
  if (!run || !beat || beat.status !== "active") return null;
  const title = bare(beat.title);
  if (!title) return null;
  const zone = safeTimezone(tz);
  const nowMs = now.getTime();
  const due = parseMs(run.due_at);
  if (!Number.isFinite(due) || !Number.isFinite(nowMs)) return null;
  const horizon = Number.isFinite(opts?.horizonDays) ? Math.max(0, opts.horizonDays) : 7;
  const memory = Number.isFinite(opts?.memoryDays) ? Math.max(0, opts.memoryDays) : 7;

  if (run.status === "pending" && due > nowMs) {
    const diff = calendarDiff(nowMs, due, zone);
    if (!Number.isFinite(diff) || diff > horizon) return null;
    const when = diff <= 0 ? "today" : diff === 1 ? "tomorrow" : diff <= 6 ? weekdayOf(due, zone) : `in ${diff} days`;
    const at = beat.due_time ? " at " + clockOf(due, zone) : "";
    return { kind: "coming", line: `  Coming up: ${title}, ${when}${at}.`, at: due };
  }
  if ((run.status === "pending" || run.status === "proposed") && due <= nowMs) {
    const age = clock ? storyElapsedMs(clock, run.due_at, clock.real) : nowMs - due;
    if (age > PASSED_DAYS * DAY_MS) return null;
    const diff = calendarDiff(due, nowMs, zone);
    const day = diff <= 0 ? "today" : diff === 1 ? "yesterday" : diff <= 6 ? weekdayOf(due, zone) : `${diff} days ago`;
    return { kind: "was", line: `  ${title} was ${day}. How it went is yours to say if he asks; once you say it, that is what happened.`, at: due };
  }
  if (run.status === "resolved" && run.outcome && isOutcome(run.outcome)) {
    const age = ageDaysOf(run.due_at, now, clock);
    if (age > memory) return null;
    // The label reads Portland's calendar ("yesterday" for last night's step) unless held
    // time lies between the step and now; then it is the story age in whole days.
    const held = clock ? Math.max(0, (Date.parse(clock.real) - due) - storyElapsedMs(clock, run.due_at, clock.real)) : 0;
    const labelDays = held > 0 || due > nowMs ? age : Math.max(0, calendarDiff(due, nowMs, zone));
    const note = bare(run.outcome_note);
    const his = opts?.opener ? "" : hisPartSentence(run.his_part, run.his_note);
    return { kind: "lately", line: `  Lately: ${title} (${agoLabel(Number.isFinite(labelDays) ? labelDays : age)}): ${outcomeWords(run.outcome)}${note ? ": " + note : ""}.${his}`, at: due };
  }
  return null;
}

export function beatLines(view: BeatView, now: Date, tz: string, clock: StoryClock | null, opts: { horizonDays: number; memoryDays: number; opener?: boolean }): string[] {
  const l = beatLine(view, now, tz, clock, opts);
  return l ? [l.line] : [];
}

// Want id -> its lines: at most two "Coming up" (soonest first), one "was" (the latest),
// two "Lately" (newest first), in that order. Wants with nothing to say are absent.
export function beatLinesByWant(views: BeatView[], now: Date, tz: string, clock: StoryClock | null, opts: { horizonDays: number; memoryDays: number; opener?: boolean }): Map<string, string[]> {
  const buckets = new Map<string, { coming: Array<{ line: string; at: number }>; was: Array<{ line: string; at: number }>; lately: Array<{ line: string; at: number }> }>();
  for (const v of Array.isArray(views) ? views : []) {
    if (!v || !v.beat) continue;
    const l = beatLine(v, now, tz, clock, opts);
    if (!l) continue;
    const id = v.beat.want_id || v.want?.id;
    if (!id) continue;
    let b = buckets.get(id);
    if (!b) { b = { coming: [], was: [], lately: [] }; buckets.set(id, b); }
    b[l.kind].push({ line: l.line, at: l.at });
  }
  const out = new Map<string, string[]>();
  for (const [id, b] of buckets) {
    const lines = [
      ...b.coming.sort((x, y) => x.at - y.at).slice(0, 2),
      ...b.was.sort((x, y) => y.at - x.at).slice(0, 1),
      ...b.lately.sort((x, y) => y.at - x.at).slice(0, 2),
    ].map((x) => x.line);
    if (lines.length) out.set(id, lines);
  }
  return out;
}

export function arcSystem(hasVariants: boolean): string {
  return "Decide how one dated step in Avelie's own life went. Avelie is 22; this is her goal, her day and her nerve, not his. You are not her and you write no dialogue. "
    + "Choose from what the record shows: who she is (HER), how she has been (MOOD), where things stand with him (STANDING), and what happened with him about it (WITH HIM, and the times they were together under TOGETHER). "
    + "Never a coin toss: the choice that fits her. "
    + (hasVariants ? "VARIANTS are listed: pick exactly one variant id; its outcome is the outcome. " : "")
    + "Output strictly one JSON object, no prose, no fences: {\"variant_id\": the variant id or omitted, \"outcome\": one of OUTCOMES, \"note\": what happened in one plain line, past tense, her life only, \"his_part\": \"encouraged\"|\"asked\"|\"came\"|\"forgot\"|\"none\", \"his_note\": one short line or \"\", \"evidence\": the ids in brackets of the messages behind his_part}. "
    + "\"came\" only when TOGETHER shows them together around that time; \"forgot\" only when a message shows he knew about it AND he wrote to her after that message before the day was over without asking or saying anything about it (him not writing at all is never \"forgot\"; it is \"none\"); \"none\" when he did not know or did not write.";
}

function block(header: string, items: string[]): string {
  return items.length ? header + "\n" + items.map((x) => "- " + x).join("\n") : header + "\n(none)";
}

export function arcUser(args: {
  want: WantRow;
  view: BeatView;
  her: string[];
  mood: string;
  standing: string;
  withHim: Array<{ id: string; role: string; content: string }>;
  together: Array<{ frozenAt: string; resumedAt: string | null; location: string | null }>;
  tz: string;
}): string {
  const zone = safeTimezone(args.tz);
  const w = args.want;
  const beat = args.view.beat;
  let wantLine = `WANT: ${bare(w.title)} (${Math.max(0, Math.min(100, Math.round(Number(w.progress) || 0)))}%).`;
  if (bare(w.why)) wantLine += ` Why: ${bare(w.why)}.`;
  if (bare(w.stakes)) wantLine += ` If it falls through: ${bare(w.stakes)}.`;
  const dueIso = args.view.run?.due_at ?? beat.due_at;
  const dueMs = parseMs(dueIso);
  let stepLine: string;
  if (Number.isFinite(dueMs)) {
    stepLine = `STEP: ${bare(beat.title)} (${beat.kind}), ${weekdayOf(dueMs, zone)} ${localDayKeyOf(new Date(dueMs), zone)}${beat.due_time ? " at " + hhmmOf(dueMs, zone) : ""}.`;
  } else {
    stepLine = `STEP: ${bare(beat.title)} (${beat.kind}), ${beat.due_on}${beat.due_time ? " at " + beat.due_time : ""}.`;
  }
  const lines: string[] = [wantLine, stepLine, `OUTCOMES: ${outcomesFor(beat.kind).join(", ")}`];
  if (args.view.variants.length) lines.push(block("VARIANTS:", args.view.variants.map((v) => `${v.id}: ${v.outcome}: ${saidLine(v.note, MAX_NOTE)}`)));
  lines.push(block("HER:", (args.her ?? []).map((h) => saidLine(h, 300)).filter(Boolean)));
  lines.push(`MOOD: ${saidLine(args.mood, 200) || "steady"}`);
  lines.push(`STANDING: ${saidLine(args.standing, 200) || "(unknown)"}`);
  lines.push(block("WITH HIM:", (args.withHim ?? []).map((m) => `[${m.id}] ${m.role === "user" || m.role === "him" ? "him" : "her"}: ${saidLine(m.content, 240)}`)));
  lines.push(block("TOGETHER:", (args.together ?? []).map((t) => `${t.frozenAt} to ${t.resumedAt ?? "now"}: ${saidLine(t.location ?? "", 120) || "(no place)"}`)));
  return lines.join("\n");
}

export function parseArcAnswer(
  text: string,
  view: BeatView,
  messageIds: ReadonlySet<string>,
  togetherKnown: boolean,
  hisAfter: ReadonlyMap<string, number>,
): { outcome: BeatOutcome; variantId: string | null; note: string; hisPart: HisPart; hisNote: string; evidence: string[] } | null {
  const obj = parseJsonObject(typeof text === "string" ? text : "");
  if (!obj) return null;
  const kind = view.beat.kind;
  let outcome: BeatOutcome;
  let variant: BeatVariant | null = null;
  if (view.variants.length) {
    const vid = typeof obj.variant_id === "string" ? obj.variant_id.trim() : "";
    variant = view.variants.find((v) => v.id === vid) ?? null;
    if (!variant) return null;
    outcome = variant.outcome;
  } else {
    if (typeof obj.outcome !== "string" || !(outcomesFor(kind) as readonly string[]).includes(obj.outcome)) return null;
    outcome = obj.outcome as BeatOutcome;
  }
  const note = cleanLine(obj.note, MAX_NOTE) ?? (variant ? variant.note : "") ?? "";
  let hisPart: HisPart = isHisPart(obj.his_part) ? obj.his_part : "none";
  if (hisPart === "came" && !togetherKnown) hisPart = "none";
  const evidence: string[] = [];
  if (Array.isArray(obj.evidence)) {
    for (const e of obj.evidence) {
      if (typeof e !== "string") continue;
      const id = e.trim().replace(/^\[|\]$/g, "");
      if (id && messageIds.has(id) && !evidence.includes(id)) evidence.push(id);
      if (evidence.length >= MAX_EVIDENCE) break;
    }
  }
  if (hisPart === "forgot") {
    let most = 0;
    for (const id of evidence) most = Math.max(most, hisAfter.get(id) ?? 0);
    if (!evidence.length || most < 1) hisPart = "none";
  }
  const hisNote = hisPart === "none" ? "" : cleanLine(obj.his_note, MAX_HIS_NOTE) ?? "";
  return { outcome, variantId: variant ? variant.id : null, note, hisPart, hisNote, evidence };
}

// ------------------------------------------------------------------ database half

type BeatJoinRow = ArcBeatRow & { want_title: string; want_status: string };

function viewOf(row: BeatJoinRow, run: BeatRunRow | null): BeatView {
  const { want_title, want_status, ...beat } = row;
  return {
    beat: beat as ArcBeatRow,
    run,
    want: { id: row.want_id, title: want_title, status: want_status },
    variants: parseVariants(row.variants_json, isBeatKind(row.kind) ? row.kind : "event"),
  };
}

async function runsFor(db: D1Database, beatIds: string[], reader: string): Promise<Map<string, BeatRunRow>> {
  const out = new Map<string, BeatRunRow>();
  const ids = Array.from(new Set(beatIds.filter((x) => typeof x === "string" && x)));
  for (const part of chunk(ids, IN_CHUNK)) {
    const marks = part.map((_, i) => "?" + (i + 2)).join(", ");
    const r = await db.prepare(`SELECT * FROM beat_runs WHERE reader = ?1 AND beat_id IN (${marks})`).bind(reader, ...part).all<BeatRunRow>();
    for (const run of r.results ?? []) if (run && run.beat_id) out.set(run.beat_id, run);
  }
  return out;
}

export async function listBeatViews(
  db: D1Database,
  opts: { wantId?: string; status?: "active" | "cancelled" | "all"; reader?: string; limit?: number } = {},
): Promise<BeatView[]> {
  const wantId = typeof opts.wantId === "string" ? opts.wantId : "";
  const status = opts.status === "cancelled" || opts.status === "all" ? opts.status : "active";
  const reader = typeof opts.reader === "string" && opts.reader ? opts.reader : OWNER_READER;
  const limit = typeof opts.limit === "number" && Number.isFinite(opts.limit) ? Math.min(500, Math.max(1, Math.round(opts.limit))) : 200;
  const r = await db.prepare(
    "SELECT b.*, w.title AS want_title, w.status AS want_status FROM arc_beats b JOIN wants w ON w.id = b.want_id WHERE (?1 = '' OR b.want_id = ?1) AND (?2 = 'all' OR b.status = ?2) ORDER BY b.due_at ASC LIMIT ?3",
  ).bind(wantId, status, limit).all<BeatJoinRow>();
  const rows = (r.results ?? []).filter((x) => x && x.id);
  const runs = await runsFor(db, rows.map((x) => x.id), reader);
  return rows.map((row) => viewOf(row, runs.get(row.id) ?? null));
}

export async function getBeatView(db: D1Database, beatId: string, reader = OWNER_READER): Promise<BeatView | null> {
  if (typeof beatId !== "string" || !beatId.trim()) return null;
  const row = await db.prepare("SELECT b.*, w.title AS want_title, w.status AS want_status FROM arc_beats b JOIN wants w ON w.id = b.want_id WHERE b.id = ?1")
    .bind(beatId.trim()).first<BeatJoinRow>();
  if (!row) return null;
  const run = await db.prepare("SELECT * FROM beat_runs WHERE beat_id = ?1 AND reader = ?2").bind(row.id, reader).first<BeatRunRow>();
  return viewOf(row, run ?? null);
}

function requireTitle(v: unknown): string {
  const t = saidLine(v, 10000);
  if (!t) throw new ApiHttpError(400, "validation", "title is required");
  if (t.length > MAX_TITLE) throw new ApiHttpError(400, "validation", `title exceeds ${MAX_TITLE} characters`);
  return t;
}

function requireDueOn(v: unknown): string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) throw new ApiHttpError(400, "validation", "dueOn must be YYYY-MM-DD");
  return v.trim();
}

function optionalDueTime(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v.trim())) throw new ApiHttpError(400, "validation", "dueTime must be HH:MM");
  return v.trim();
}

function optionalSource(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new ApiHttpError(400, "validation", "source must be a string");
  const t = v.trim();
  return t ? t.slice(0, 500) : null;
}

export async function createBeat(
  db: D1Database,
  input: { wantId: string; title: string; kind: BeatKind; dueOn: string; dueTime?: string | null; variants?: unknown; source?: string | null },
  actor: string,
  tz: string,
): Promise<BeatView> {
  const inp = input && typeof input === "object" ? input : ({} as typeof input);
  if (typeof inp.wantId !== "string" || !inp.wantId.trim()) throw new ApiHttpError(400, "validation", "wantId is required");
  const want = await getWant(db, inp.wantId.trim());
  if (!want) throw new ApiHttpError(404, "not_found", "want not found");
  if (want.status === "dropped") throw new ApiHttpError(409, "not_active", "the want is dropped");
  const title = requireTitle(inp.title);
  if (!isBeatKind(inp.kind)) throw new ApiHttpError(400, "validation", "kind must be step or event");
  const dueOn = requireDueOn(inp.dueOn);
  const dueTime = optionalDueTime(inp.dueTime);
  const dueAt = dueAtFor(dueOn, dueTime, safeTimezone(tz));
  const variants = validateVariants(inp.variants, inp.kind);
  const t = nowIso();
  const beat: ArcBeatRow = {
    id: newId("ab"),
    want_id: want.id,
    title,
    kind: inp.kind,
    due_on: dueOn,
    due_time: dueTime,
    due_at: dueAt,
    variants_json: variants.length ? JSON.stringify(variants) : null,
    status: "active",
    source: optionalSource(inp.source),
    created_at: t,
    updated_at: t,
  };
  const run: BeatRunRow = {
    id: newId("br"),
    beat_id: beat.id,
    reader: OWNER_READER,
    status: "pending",
    due_at: dueAt,
    outcome: null,
    variant_id: null,
    outcome_note: null,
    his_part: null,
    his_note: null,
    evidence_json: null,
    proposal_id: null,
    attempts: 0,
    shifted_ms: 0,
    resolved_at: null,
    created_at: t,
    updated_at: t,
  };
  await db.batch([
    db.prepare("INSERT INTO arc_beats (id, want_id, title, kind, due_on, due_time, due_at, variants_json, status, source, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)")
      .bind(beat.id, beat.want_id, beat.title, beat.kind, beat.due_on, beat.due_time, beat.due_at, beat.variants_json, beat.status, beat.source, beat.created_at, beat.updated_at),
    db.prepare("INSERT INTO beat_runs (id, beat_id, reader, status, due_at, attempts, shifted_ms, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 0, 0, ?6, ?7)")
      .bind(run.id, run.beat_id, run.reader, run.status, run.due_at, run.created_at, run.updated_at),
    auditStmt(db, actor, "beat.create", "arc_beat", beat.id, null, { beat, run: { id: run.id, due_at: run.due_at } }),
  ]);
  return { beat, run, want: { id: want.id, title: want.title, status: want.status }, variants };
}

export async function updateBeat(
  db: D1Database,
  id: string,
  patch: { title?: string; dueOn?: string; dueTime?: string | null; variants?: unknown; status?: "active" | "cancelled" },
  actor: string,
  tz: string,
): Promise<BeatView> {
  const view = await getBeatView(db, id);
  if (!view) throw new ApiHttpError(404, "not_found", "beat not found");
  const p = patch && typeof patch === "object" ? patch : {};
  const old = view.beat;
  if (p.status !== undefined && p.status !== "active" && p.status !== "cancelled") throw new ApiHttpError(400, "validation", "status must be active or cancelled");
  const title = p.title === undefined ? old.title : requireTitle(p.title);
  const dueOn = p.dueOn === undefined ? old.due_on : requireDueOn(p.dueOn);
  const dueTime = p.dueTime === undefined ? old.due_time : optionalDueTime(p.dueTime);
  const dateChanged = dueOn !== old.due_on || dueTime !== old.due_time;
  const dueAt = dateChanged ? dueAtFor(dueOn, dueTime, safeTimezone(tz)) : old.due_at;
  const variants = p.variants === undefined ? view.variants : validateVariants(p.variants, old.kind);
  const t = nowIso();
  const beat: ArcBeatRow = {
    ...old,
    title,
    due_on: dueOn,
    due_time: dueTime,
    due_at: dueAt,
    variants_json: p.variants === undefined ? old.variants_json : variants.length ? JSON.stringify(variants) : null,
    status: p.status ?? old.status,
    updated_at: t,
  };
  const stmts: D1PreparedStatement[] = [
    db.prepare("UPDATE arc_beats SET title = ?2, due_on = ?3, due_time = ?4, due_at = ?5, variants_json = ?6, status = ?7, updated_at = ?8 WHERE id = ?1")
      .bind(beat.id, beat.title, beat.due_on, beat.due_time, beat.due_at, beat.variants_json, beat.status, beat.updated_at),
  ];
  let run = view.run;
  if (dateChanged && run && (run.status === "pending" || run.status === "proposed")) {
    stmts.push(db.prepare("UPDATE beat_runs SET due_at = ?2, shifted_ms = 0, status = 'pending', updated_at = ?3 WHERE id = ?1 AND status IN ('pending','proposed')")
      .bind(run.id, dueAt, t));
    run = { ...run, due_at: dueAt, shifted_ms: 0, status: "pending", updated_at: t };
  }
  stmts.push(auditStmt(db, actor, "beat.update", "arc_beat", beat.id, old, beat));
  await db.batch(stmts);
  return { ...view, beat, run, variants };
}

export async function resolveBeat(
  db: D1Database,
  beatId: string,
  input: { outcome: BeatOutcome; note?: string | null; variantId?: string | null; hisPart?: HisPart | null; hisNote?: string | null; evidence?: string[]; source?: string | null },
  actor: string,
): Promise<BeatView> {
  const view = await getBeatView(db, beatId);
  if (!view || !view.run) throw new ApiHttpError(404, "not_found", "beat not found");
  const run = view.run;
  if (run.status === "resolved") throw new ApiHttpError(409, "already_resolved", "the beat is already resolved");
  const inp = input && typeof input === "object" ? input : ({} as typeof input);
  const kind = view.beat.kind;
  if (!isOutcome(inp.outcome) || !(outcomesFor(kind) as readonly string[]).includes(inp.outcome)) {
    throw new ApiHttpError(400, "validation", `outcome must be one of ${outcomesFor(kind).join(", ")}`);
  }
  const outcome = inp.outcome;
  if (inp.hisPart !== undefined && inp.hisPart !== null && !isHisPart(inp.hisPart)) throw new ApiHttpError(400, "validation", `hisPart must be one of ${HIS_PARTS.join(", ")}`);
  const variantId = typeof inp.variantId === "string" && view.variants.some((v) => v.id === inp.variantId) ? inp.variantId : null;
  const note = saidLine(inp.note, MAX_NOTE) || null;
  const hisPart: HisPart | null = inp.hisPart ?? null;
  const hisNote = hisPart && hisPart !== "none" ? saidLine(inp.hisNote, MAX_HIS_NOTE) || null : null;
  const evidence = Array.isArray(inp.evidence) ? inp.evidence.filter((e): e is string => typeof e === "string" && !!e.trim()).map((e) => e.trim().slice(0, 120)).slice(0, MAX_EVIDENCE) : [];
  const source = optionalSource(inp.source);
  const t = nowIso();
  const resolved: BeatRunRow = {
    ...run,
    status: "resolved",
    outcome,
    variant_id: variantId,
    outcome_note: note,
    his_part: hisPart,
    his_note: hisNote,
    evidence_json: evidence.length ? JSON.stringify(evidence) : null,
    resolved_at: t,
    updated_at: t,
  };
  const res = await db.batch([
    db.prepare("UPDATE beat_runs SET status = 'resolved', outcome = ?2, variant_id = ?3, outcome_note = ?4, his_part = ?5, his_note = ?6, evidence_json = ?7, resolved_at = ?8, updated_at = ?8 WHERE id = ?1 AND status != 'resolved'")
      .bind(run.id, outcome, variantId, note, hisPart, hisNote, resolved.evidence_json, t),
    auditStmt(db, actor, "beat.resolve", "beat_run", run.id, { status: run.status, due_at: run.due_at }, { outcome, variant_id: variantId, outcome_note: note, his_part: hisPart, his_note: hisNote, source }),
  ]);
  const changes = (res?.[0] as { meta?: { changes?: number } } | undefined)?.meta?.changes;
  if (changes === 0) throw new ApiHttpError(409, "already_resolved", "the beat is already resolved");
  const log = OUTCOME_LOG[outcome];
  try {
    await logWant(db, view.beat.want_id, {
      kind: log.kind,
      delta: log.delta,
      note: `${bare(view.beat.title)}: ${outcomeWords(outcome)}${note ? ". " + bare(note) : ""}`,
      occurred: run.due_at,
      source,
      messageId: null,
    }, actor);
  } catch (e) {
    // A done or dropped want takes no log; the beat still resolves.
    if (!(e instanceof ApiHttpError && (e.code === "not_active" || e.code === "not_found"))) throw e;
  }
  return { ...view, run: resolved };
}

function firstSentence(text: string): string {
  const t = saidLine(text, 10000);
  const first = t.split(/(?<=[.!?])\s+/)[0] ?? "";
  return first.replace(/[.!?]+$/, "");
}

export async function createBeatFromProposal(db: D1Database, payload: Record<string, unknown>, text: string, source: string, actor: string, tz: string): Promise<string> {
  const p = payload && typeof payload === "object" ? payload : {};
  const ref = typeof p.want === "string" ? p.want : typeof p.want_id === "string" ? p.want_id : "";
  const want = ref ? await findWant(db, ref) : null;
  if (!want || want.status !== "active") throw new ApiHttpError(400, "validation", "want_beat names no active want");
  const rawTitle = typeof p.title === "string" && p.title.trim() ? p.title : firstSentence(typeof text === "string" ? text : "");
  const title = saidLine(rawTitle, MAX_TITLE);
  if (!title) throw new ApiHttpError(400, "validation", "want_beat needs a title");
  const kind: BeatKind = isBeatKind(p.kind) ? p.kind : "event";
  if (typeof p.due_on !== "string" || !p.due_on.trim()) throw new ApiHttpError(400, "validation", "want_beat needs due_on");
  const dueOn = requireDueOn(p.due_on);
  const dueTime = optionalDueTime(typeof p.due_time === "string" ? p.due_time : null);
  const existing = await db.prepare("SELECT id FROM arc_beats WHERE want_id = ?1 AND status = 'active' AND lower(trim(title)) = lower(trim(?2)) AND due_on = ?3 ORDER BY created_at ASC LIMIT 1")
    .bind(want.id, title, dueOn).first<{ id: string }>();
  if (existing && existing.id) return existing.id;
  const view = await createBeat(db, { wantId: want.id, title, kind, dueOn, dueTime, source }, actor, tz);
  return view.beat.id;
}

export async function applyBeatOutcome(db: D1Database, payload: Record<string, unknown>, source: string, actor: string): Promise<string> {
  const p = payload && typeof payload === "object" ? payload : {};
  let beatId: string | null = null;
  let runId: string | null = null;
  if (typeof p.run_id === "string" && p.run_id.trim()) {
    const r = await db.prepare("SELECT id, beat_id FROM beat_runs WHERE id = ?1").bind(p.run_id.trim()).first<{ id: string; beat_id: string }>();
    if (r) { beatId = r.beat_id; runId = r.id; }
  }
  if (!beatId && typeof p.beat === "string" && p.beat.trim()) {
    const r = await db.prepare(
      "SELECT b.id AS beat_id, r.id AS run_id, r.due_at AS due_at FROM arc_beats b JOIN beat_runs r ON r.beat_id = b.id AND r.reader = ?2 WHERE b.status = 'active' AND lower(trim(b.title)) = lower(trim(?1)) ORDER BY r.due_at ASC LIMIT 50",
    ).bind(p.beat.trim(), OWNER_READER).all<{ beat_id: string; run_id: string; due_at: string }>();
    const rows = (r.results ?? []).filter((x) => x && Number.isFinite(parseMs(x.due_at)));
    const now = Date.now();
    const past = rows.filter((x) => parseMs(x.due_at) <= now);
    const pick = past.length ? past[past.length - 1] : rows.find((x) => parseMs(x.due_at) > now);
    if (pick) { beatId = pick.beat_id; runId = pick.run_id; }
  }
  if (!beatId || !runId) throw new ApiHttpError(400, "validation", "beat_outcome names no dated step");
  const evidence = Array.isArray(p.evidence) ? p.evidence.filter((e): e is string => typeof e === "string") : [];
  const view = await resolveBeat(db, beatId, {
    outcome: p.outcome as BeatOutcome,
    note: typeof p.note === "string" ? p.note : null,
    variantId: typeof p.variant_id === "string" ? p.variant_id : null,
    hisPart: isHisPart(p.his_part) ? p.his_part : null,
    hisNote: typeof p.his_note === "string" ? p.his_note : null,
    evidence,
    source,
  }, actor);
  return view.run?.id ?? runId;
}

// ------------------------------------------------------------------ the nightly arc step

function isOpinion(f: FactRow): boolean {
  return typeof f.subject === "string" && f.subject.trim().toLowerCase().startsWith(OPINION_PREFIX);
}

function pickHer(facts: FactRow[], keys: Set<string>): string[] {
  const plain = facts.filter((f) => f && f.status === "approved" && !isOpinion(f) && typeof f.fact === "string" && f.fact.trim());
  const opinions = facts.filter((f) => f && f.status === "approved" && isOpinion(f) && typeof f.fact === "string" && f.fact.trim());
  const choose = (list: FactRow[], max: number): FactRow[] => {
    const hit = list.filter((f) => shares(keywords(f.fact + " " + (f.subject ?? "")), keys));
    const rest = list.filter((f) => !hit.includes(f));
    return [...hit, ...rest].slice(0, max);
  };
  return [
    ...choose(plain, HER_FACTS_MAX).map((f) => saidLine(f.fact, 300)),
    ...choose(opinions, HER_OPINIONS_MAX).map((f) => saidLine((f.subject ?? "").replace(/^opinion:\s*/i, "") + ": " + f.fact, 300)),
  ].filter(Boolean);
}

function runUpdateStmt(db: D1Database, runId: string, status: BeatRunRow["status"], proposalId: string | null, attempts: number, at: string): D1PreparedStatement {
  return db.prepare("UPDATE beat_runs SET status = ?2, proposal_id = COALESCE(?3, proposal_id), attempts = ?4, updated_at = ?5 WHERE id = ?1 AND status IN ('pending','proposed')")
    .bind(runId, status, proposalId, attempts, at);
}

export async function runArcPass(env: Env, db: D1Database, settings: Settings, clock: StoryClock, budget: NightlyBudget, now: Date): Promise<StepResult> {
  const proposalIds: string[] = [];
  const detail: Record<string, unknown> = { reset: 0, due: 0, filed: 0, refiled: 0, unparsed: 0, skipped: 0, failed: 0 };
  const count = (k: string): void => { detail[k] = (Number(detail[k]) || 0) + 1; };
  const max = settingNumber(settings, "nightlyBeatsMax", 3, 0, 10);
  if (max === 0) return { step: "arcs", status: "skipped", reason: "off", proposalIds, detail };
  if (clock && clock.enabled && clock.frozen) return { step: "arcs", status: "skipped", reason: "frozen: a together scene is held", proposalIds, detail };
  const tz = safeTimezone(settingString(settings, "timezone", "UTC"));
  const at = nowIso();

  // 1. A proposed run whose proposal was rejected goes back to pending (another night may
  // decide it) until it has used its attempts; then it is skipped (the owner can still Resolve).
  const rejected = await db.prepare(
    "SELECT r.id AS id, r.attempts AS attempts FROM beat_runs r JOIN proposals p ON p.id = r.proposal_id WHERE r.status = 'proposed' AND r.reader = ?1 AND p.status = 'rejected' LIMIT 200",
  ).bind(OWNER_READER).all<{ id: string; attempts: number }>();
  const resetStmts: D1PreparedStatement[] = [];
  for (const r of rejected.results ?? []) {
    if (!r || !r.id) continue;
    const attempts = Number(r.attempts) || 0;
    const next = attempts < BEAT_MAX_ATTEMPTS ? "pending" : "skipped";
    resetStmts.push(db.prepare("UPDATE beat_runs SET status = ?2, updated_at = ?3 WHERE id = ?1 AND status = 'proposed'").bind(r.id, next, at));
    count(next === "pending" ? "reset" : "skipped");
  }
  if (resetStmts.length) await db.batch(resetStmts);

  // 2. The owner runs that fell due at least an hour ago in story time, oldest first.
  const storyNowDate = storyNow(clock);
  const storyNowMs = storyNowDate.getTime();
  const cutoff = new Date(storyNowMs - BEAT_RESOLVE_AFTER_MS).toISOString();
  const due = await db.prepare(
    "SELECT r.* FROM beat_runs r JOIN arc_beats b ON b.id = r.beat_id WHERE r.status = 'pending' AND r.reader = ?1 AND b.status = 'active' AND r.due_at <= ?2 ORDER BY r.due_at ASC LIMIT ?3",
  ).bind(OWNER_READER, cutoff, max).all<BeatRunRow>();
  const runs = (due.results ?? []).filter((r) => r && r.id);
  detail.due = runs.length;
  if (!runs.length) return { step: "arcs", status: "done", reason: "nothing due", proposalIds, detail };

  // Shared inputs, read once.
  let rel: { state: RelationshipState; created: string | null } | null = null;
  try {
    const cur = await getCurrentState<RelationshipState>(db, "relationship");
    rel = { state: cur.state, created: cur.row?.created_at ?? null };
  } catch { rel = null; }
  const mood = rel ? moodLine(moodNow(rel.state, storyNowDate, settings, rel.created, clock)).replace(/^Mood:\s*/, "") : "";
  const standing = rel && typeof rel.state.status === "string" ? rel.state.status : "";
  let facts: FactRow[] = [];
  try { facts = await listFacts(db, "avelie"); } catch { facts = []; }
  const day = herDayKey(now, tz);

  let calls = 0;
  let stoppedReason: string | null = null;
  for (const run of runs) {
    const view = await getBeatView(db, run.beat_id);
    if (!view || !view.run || view.run.status !== "pending") continue;
    const want = await getWant(db, view.beat.want_id);
    if (!want) continue;
    const beat = view.beat;
    const keys = new Set<string>([...keywords(beat.title), ...keywords(want.title), ...keywords(want.why ?? "")]);
    const titleKeys = new Set<string>([...keywords(beat.title), ...keywords(want.title)]);
    const dueMs = Date.parse(view.run.due_at);
    const windowEnd = new Date(dueMs + DAY_MS).toISOString();
    const createdMs = Date.parse(beat.created_at);
    // The message that named the step comes a moment before the beat itself (a promoted
    // proposal), so the window opens a day before the beat was created, never more than
    // fourteen days before the step.
    const fromMs = Math.max(Number.isFinite(createdMs) ? createdMs - DAY_MS : dueMs - WITH_HIM_BACK_DAYS * DAY_MS, dueMs - WITH_HIM_BACK_DAYS * DAY_MS);
    const from = new Date(fromMs).toISOString();
    const msgs = await db.prepare(
      "SELECT id, role, content, created_at FROM messages WHERE channel = 'story' AND created_at >= ?1 AND created_at <= ?2 ORDER BY created_at ASC LIMIT 500",
    ).bind(from, windowEnd).all<{ id: string; role: string; content: string; created_at: string }>();
    const withHim = (msgs.results ?? [])
      .filter((m) => m && m.id && typeof m.content === "string" && shares(keywords(m.content), titleKeys))
      .slice(-WITH_HIM_MAX);
    const hisAfter = new Map<string, number>();
    if (withHim.length) {
      const earliest = withHim[0]?.created_at ?? from;
      const his = await db.prepare(
        "SELECT created_at FROM messages WHERE channel = 'story' AND role = 'user' AND created_at > ?1 AND created_at <= ?2 ORDER BY created_at ASC LIMIT ?3",
      ).bind(earliest, windowEnd, HIS_READ_MAX).all<{ created_at: string }>();
      const times = (his.results ?? []).map((h) => Date.parse(h.created_at)).filter((x) => Number.isFinite(x));
      for (const m of withHim) {
        const t = Date.parse(m.created_at);
        hisAfter.set(m.id, times.filter((x) => x > t).length);
      }
    }
    const together = (clock?.spans ?? [])
      .filter((s) => {
        const start = Date.parse(s.frozen_at);
        const end = s.resumed_at ? Date.parse(s.resumed_at) : Date.parse(clock.real);
        return Number.isFinite(start) && Number.isFinite(end) && start <= dueMs + TOGETHER_AROUND_MS && end >= dueMs - TOGETHER_AROUND_MS;
      })
      .map((s) => ({ frozenAt: s.frozen_at, resumedAt: s.resumed_at, location: s.location }));

    const result = await paidJsonCall(env, db, settings, budget, {
      tag: "arcs",
      provider: settingString(settings, "nightlyProvider", "anthropic") as Settings["provider"],
      model: settingString(settings, "nightlyModel", "claude-sonnet-5"),
      system: arcSystem(view.variants.length > 0),
      user: arcUser({ want, view, her: pickHer(facts, keys), mood, standing, withHim, together, tz }),
      maxTokens: 400,
      temperature: 0.5,
    });
    if (!result.ok) {
      count("failed");
      if (result.reason !== "provider_failed") { stoppedReason = result.reason; break; }
      continue;
    }
    calls++;
    const attempts = (Number(view.run.attempts) || 0) + 1;
    const exhausted = attempts >= BEAT_MAX_ATTEMPTS + 1;
    const parsed = parseArcAnswer(result.text, view, new Set(withHim.map((m) => m.id)), together.length > 0, hisAfter);
    if (!parsed) {
      count("unparsed");
      if (exhausted) count("skipped");
      await runUpdateStmt(db, view.run.id, exhausted ? "skipped" : "pending", null, attempts, nowIso()).run();
      continue;
    }
    const localDay = localDayKeyOf(new Date(dueMs), tz);
    const note = bare(parsed.note);
    const filed = await fileNightlyProposals(db, [{
      kind: "beat_outcome",
      proposal: `${bare(beat.title)} (${localDay}): ${outcomeWords(parsed.outcome)}${note ? ". " + note : ""}`,
      evidence: `nightly arcs ${day}`,
      confidence: "medium",
      weight: 0.6,
      payload: {
        run_id: view.run.id,
        beat_id: beat.id,
        outcome: parsed.outcome,
        variant_id: parsed.variantId,
        note: parsed.note,
        his_part: parsed.hisPart,
        his_note: parsed.hisNote,
        evidence: parsed.evidence,
      },
      source: `nightly arcs ${day} ${result.runId}`,
    }]);
    const id = Array.isArray(filed) ? filed[0] ?? null : null;
    if (id) {
      proposalIds.push(id);
      count("filed");
      await runUpdateStmt(db, view.run.id, "proposed", id, attempts, nowIso()).run();
    } else {
      count("refiled");
      if (exhausted) count("skipped");
      await runUpdateStmt(db, view.run.id, exhausted ? "skipped" : "pending", null, attempts, nowIso()).run();
    }
  }
  if (!calls && stoppedReason) return { step: "arcs", status: "skipped", reason: stoppedReason, proposalIds, detail };
  const reason = `${proposalIds.length} decided of ${runs.length} due` + (stoppedReason ? `; stopped: ${stoppedReason}` : "");
  return { step: "arcs", status: "done", reason, proposalIds, detail };
}
