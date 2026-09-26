// v5 (SPEC_V5 section 4, "State that moves"): where they stand moves a step at a time. The
// status ladder a proposal climbs one rung at a time (with three lateral states beside it),
// friction with a stamp and a phase that heals on story time, cooling off measured on the
// story clock, nicknames appended instead of replaced, and scene records that always carry
// status, location, time and present. Pure: the only run-time imports are the story clock's
// elapsed-time helpers and the API error. The rungs are the record's; they never reach her
// prompt as levels (the prompt shows the words).
import { disabledClock, storyElapsedMs } from "./clock";
import type { StoryClock } from "./clock";
import { ApiHttpError } from "./errors";
import type { RelationshipState } from "./types";

// ------------------------------------------------------------------ the ladder

export const STATUS_LADDER: readonly string[] = ["strangers", "talking", "friends", "seeing each other", "together"];
export type LateralStatus = "cooling off" | "on a break" | "over";
export const LATERAL_STATUSES: readonly LateralStatus[] = ["cooling off", "on a break", "over"];

// The ordered rule table (SPEC_V5 section 4): the first rule that matches the trimmed,
// lowercased status text decides. "seeing each other" comes before "met", so the live
// hand-written "seeing each other, early: met two days ago..." reads rung 3.
const STATUS_RULES: ReadonlyArray<{ result: number | LateralStatus; test: (t: string) => boolean }> = [
  { result: "over", test: (t) => t === "over" || /\b(?:broke up|broken up|split up|ended it|it'?s over)\b/.test(t) },
  { result: "on a break", test: (t) => /\bon a break\b/.test(t) },
  { result: "cooling off", test: (t) => /\bcooling off\b/.test(t) },
  { result: 4, test: (t) => /\b(?:together|official|girlfriend|boyfriend|in a relationship|partners?)\b/.test(t) },
  { result: 3, test: (t) => /\b(?:seeing each other|dating|going out|seeing him|seeing her)\b/.test(t) },
  { result: 2, test: (t) => /\bfriends?\b/.test(t) },
  { result: 0, test: (t) => /\b(?:strangers?|not met|never met|haven'?t met)\b/.test(t) },
  { result: 1, test: (t) => /\b(?:talking|texting|getting to know|acquaint\w*|met)\b/.test(t) },
];

const STATUS_MAX = 200;

function statusText(text: unknown): string {
  return typeof text === "string" ? text.trim().toLowerCase() : "";
}

function classify(text: unknown): number | LateralStatus | null {
  const t = statusText(text);
  if (!t) return null;
  for (const rule of STATUS_RULES) if (rule.test(t)) return rule.result;
  return null;
}

// The rung a status text names (0 strangers .. 4 together); null for a lateral state, an
// unknown word or a non-string.
export function statusRung(text: unknown): number | null {
  const c = classify(text);
  return typeof c === "number" ? c : null;
}

// The lateral state a status text names (cooling off, on a break, over), else null.
export function lateralOf(text: unknown): LateralStatus | null {
  const c = classify(text);
  return typeof c === "string" ? c : null;
}

export interface StatusStep {
  changed: boolean;
  status: string;
  statusBefore: string | null;
  clamped: boolean;
  note: string | null;
}

function ladderText(rung: number): string {
  return STATUS_LADDER[Math.max(0, Math.min(STATUS_LADDER.length - 1, rung))] ?? "strangers";
}

function cut(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

// One status move from a proposal (SPEC_V5 section 4, exactly the spec's rule). "over" only
// by hand and only from seeing each other or closer; a lateral state never at strangers or
// when it already holds; out of "over" only to talking or friends and never by an automatic
// proposal; otherwise one rung at a time, and a proposal naming the rung it already holds
// leaves his richer wording alone.
export function stepStatus(cur: { status?: unknown; status_before?: unknown }, proposed: unknown, opts: { auto: boolean }): StatusStep {
  const curStatus = typeof cur.status === "string" ? cur.status : "";
  const curBefore = typeof cur.status_before === "string" && cur.status_before.trim() ? cur.status_before : null;
  const unchanged = (note: string | null): StatusStep => ({ changed: false, status: curStatus, statusBefore: curBefore, clamped: false, note });
  const p = cut(statusText(proposed), STATUS_MAX);
  if (!p) return unchanged(null);
  const curLat = lateralOf(cur.status);
  const eff = curLat ? (statusRung(cur.status_before) ?? 1) : (statusRung(cur.status) ?? 0);
  // The rung text a lateral move leaves: the one it already left when lateral, else the current words.
  const leftText = cut(curLat ? (curBefore ?? ladderText(eff)) : (curStatus.trim() || ladderText(eff)), STATUS_MAX);
  const propLat = lateralOf(p);

  if (propLat === "over") {
    if (curLat === "over") return unchanged(null);
    if (opts.auto) return unchanged("an automatic proposal never ends it");
    if (eff < 3) return unchanged("over only after seeing each other");
    return { changed: true, status: "over", statusBefore: leftText, clamped: false, note: null };
  }
  if (propLat === "cooling off" || propLat === "on a break") {
    if (curLat === "over") return unchanged("from over only talking or friends");
    if (curLat === propLat) return unchanged(`already ${propLat}`);
    if (eff === 0) return unchanged("strangers cannot cool off");
    return { changed: true, status: propLat, statusBefore: leftText, clamped: false, note: null };
  }

  const rp = statusRung(p);
  if (rp === null) return unchanged(`status not understood: ${p}`);
  if (curLat === "over") {
    if (opts.auto) return unchanged("an automatic proposal never restarts it");
    const target = Math.min(Math.max(rp, 1), 2);
    const clamped = target !== rp;
    return { changed: true, status: ladderText(target), statusBefore: null, clamped, note: clamped ? `starting over (proposed: ${p})` : "starting over" };
  }
  const target = Math.abs(rp - eff) <= 1 ? rp : eff + Math.sign(rp - eff);
  if (target === eff && !curLat) return unchanged(null);
  const clamped = target !== rp;
  return {
    changed: true,
    status: ladderText(target),
    statusBefore: null,
    clamped,
    note: clamped ? `status moved one step (proposed: ${p})` : null,
  };
}

// ------------------------------------------------------------------ nicknames

const NICKNAMES_KEPT = 6;
const NICKNAME_MAX = 100;

function nicknameList(v: unknown): string[] {
  if (typeof v !== "string") return [];
  return v
    .split(/[;,]/)
    .map((s) => cut(s.trim(), NICKNAME_MAX))
    .filter((s) => s && !/^none(?:\s+established)?$/i.test(s));
}

// A nickname that stuck joins the ones before it: split on ";" or ",", the empty ones and
// "none" or "none established" dropped, a repeat (case-insensitive) keeps its first
// spelling, the newest six kept, joined with "; "; "none established" when nothing is left.
export function mergeNicknames(cur: unknown, add: unknown): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of [...nicknameList(cur), ...nicknameList(add)]) {
    const k = n.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(n);
  }
  const kept = out.slice(-NICKNAMES_KEPT);
  return kept.length ? kept.join("; ") : "none established";
}

// ------------------------------------------------------------------ friction

export type FrictionPhase = "fresh" | "healing" | "faint" | "healed" | "none";
export interface FrictionNow { friction: string; phase: FrictionPhase; setAt: string | null; days: number; ageDays: number }

const FRICTION_DAYS_MIN = 1;
const FRICTION_DAYS_MAX = 14;
const FRICTION_DAYS_DEFAULT = 4;
const HEALED_RE = /^(?:none|healed|no friction|nothing)$/i;
const DAY_MS = 86_400_000;

function frictionDays(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.min(FRICTION_DAYS_MAX, Math.max(FRICTION_DAYS_MIN, Math.round(n)));
}

function isoOrNull(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

// Where a sore spot stands, on story time (held days of a together scene never heal it):
// t = age / days; under 0.5 fresh, under 1 healing, under 2 faint, else healed.
export function frictionNow(
  rel: RelationshipState,
  now: Date,
  settings: { frictionDaysDefault?: number } | null | undefined,
  fallbackSetAt: string | null,
  clock: StoryClock | null,
): FrictionNow {
  const friction = typeof rel.friction === "string" ? rel.friction.trim() : "";
  const days = frictionDays(rel.friction_days) ?? frictionDays(settings?.frictionDaysDefault) ?? FRICTION_DAYS_DEFAULT;
  if (!friction || HEALED_RE.test(friction)) return { friction, phase: "none", setAt: null, days, ageDays: 0 };
  const setAt = isoOrNull(rel.friction_set_at) ?? isoOrNull(fallbackSetAt);
  const ageMs = setAt ? storyElapsedMs(clock ?? disabledClock(now), setAt) : 0;
  const ageDays = Math.max(0, ageMs) / DAY_MS;
  const t = ageDays / days;
  const phase: FrictionPhase = t < 0.5 ? "fresh" : t < 1 ? "healing" : t < 2 ? "faint" : "healed";
  return { friction, phase, setAt, days, ageDays };
}

export function frictionLine(f: FrictionNow | null | undefined): string {
  if (!f) return "";
  switch (f.phase) {
    case "fresh": return `Friction: ${f.friction} (fresh; it colours things between you, it is not a way to treat him)`;
    case "healing": return `Friction: ${f.friction} (healing)`;
    case "faint": return `Friction: ${f.friction} (mostly past)`;
    default: return "";
  }
}

// ------------------------------------------------------------------ cooling off

const HOUR_MS = 3_600_000;
const MAX_COOLING_OFF_HOURS = 336;
const DEFAULT_COOLING_OFF_HOURS = 24;

// True while a cooling off is running: the v5 story-time pair (cooling_off_set_at and
// cooling_off_hours) when both are readable, else v2's cooling_off_until against now.
export function coolingOffNow(rel: RelationshipState, now: Date, clock: StoryClock | null): boolean {
  const setAt = isoOrNull(rel.cooling_off_set_at);
  const hours = rel.cooling_off_hours;
  if (setAt && typeof hours === "number" && Number.isFinite(hours) && hours > 0) {
    return storyElapsedMs(clock ?? disabledClock(now), setAt) < hours * HOUR_MS;
  }
  const until = rel.cooling_off_until;
  if (typeof until !== "string" || !until.trim()) return false;
  const t = Date.parse(until);
  return Number.isFinite(t) && t > now.getTime();
}

// ------------------------------------------------------------------ the relationship merge

const MOOD_DAYS_MIN = 1;
const MOOD_DAYS_MAX = 14;
const RELATIONSHIP_FIELD_MAX = 200;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

function num(v: unknown): number {
  return typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
}

// mood, mood_days (v3) and the cooling off from a relationship payload (SPEC_V2 section J,
// SPEC_V3 section CC, SPEC_V5 section 4). A missing field leaves the current value alone;
// cooling_off_hours 0 or below ends a cooling off (both clocks cleared); above 0 it starts
// one on v2's real clock and on the v5 story-time pair, capped at 336 hours.
export function relationshipMood(payload: Record<string, unknown>, now: Date): {
  mood?: string;
  mood_days?: number;
  cooling_off_until?: string | null;
  cooling_off_set_at?: string | null;
  cooling_off_hours?: number | null;
} {
  const out: { mood?: string; mood_days?: number; cooling_off_until?: string | null; cooling_off_set_at?: string | null; cooling_off_hours?: number | null } = {};
  const p = isPlainObject(payload) ? payload : {};
  const mood = str(p.mood, 200);
  if (mood) out.mood = mood;
  const days = num(p.mood_days);
  if (Number.isFinite(days)) out.mood_days = Math.min(MOOD_DAYS_MAX, Math.max(MOOD_DAYS_MIN, Math.round(days)));
  const hours = num(p.cooling_off_hours);
  if (Number.isFinite(hours)) {
    if (hours <= 0) {
      out.cooling_off_until = null;
      out.cooling_off_set_at = null;
      out.cooling_off_hours = null;
    } else {
      const h = Math.min(hours, MAX_COOLING_OFF_HOURS);
      out.cooling_off_until = new Date(now.getTime() + h * HOUR_MS).toISOString();
      out.cooling_off_set_at = now.toISOString();
      out.cooling_off_hours = h;
    }
  }
  return out;
}

export function appendText(existing: unknown, addition: string, sep: string): string {
  const cur = typeof existing === "string" ? existing.trim() : "";
  if (!cur || cur.toLowerCase() === "none" || cur.toLowerCase() === "none established") return addition;
  return cur + sep + addition;
}

const FRICTION_HEALED_WORD = /^(?:none|healed|no friction)$/i;

// The next relationship state from a promoted relationship proposal (pure). Summary and
// frontier as v4; the mood keys and the cooling off from relationshipMood; the status
// through the ladder (never a leap); his_name as v4 (null clears); trust, affection and
// attraction taken when non-empty; friction stamped when it changed and cleared when it
// healed; friction_days clamped 1..14; nicknames appended; a move into cooling off with none
// running starts a 24-hour one. The notes say what the ladder held back.
export function moveRelationship(
  cur: RelationshipState,
  payload: Record<string, unknown>,
  text: string,
  now: Date,
  opts: { auto: boolean },
): { next: Record<string, unknown>; notes: string[] } {
  const p = isPlainObject(payload) ? payload : {};
  const notes: string[] = [];
  const next: Record<string, unknown> = {
    ...cur,
    summary: text,
    frontier: appendText(cur.frontier, text, " | "),
    ...relationshipMood(p, now),
  };

  let enteredCoolingOff = false;
  if (str(p.status, STATUS_MAX)) {
    const step = stepStatus(cur, p.status, { auto: opts.auto === true });
    if (step.changed) {
      next.status = step.status;
      next.status_before = step.statusBefore;
      enteredCoolingOff = step.status === "cooling off";
    }
    if (step.note) notes.push(step.note);
  }

  if (p.his_name === null) next.his_name = null;
  else {
    const name = str(p.his_name, RELATIONSHIP_FIELD_MAX);
    if (name) next.his_name = name;
  }

  for (const key of ["trust", "affection", "attraction"] as const) {
    const v = str(p[key], RELATIONSHIP_FIELD_MAX);
    if (v) next[key] = v;
  }

  const friction = str(p.friction, RELATIONSHIP_FIELD_MAX);
  let healed = false;
  if (friction) {
    if (FRICTION_HEALED_WORD.test(friction)) {
      healed = true;
      next.friction = "none";
      delete next.friction_set_at;
      delete next.friction_days;
    } else {
      const curFriction = typeof cur.friction === "string" ? cur.friction.trim() : "";
      next.friction = friction;
      if (friction.toLowerCase() !== curFriction.toLowerCase()) {
        next.friction_set_at = now.toISOString();
        // A new sore spot heals on its own clock, not on the last one's.
        delete next.friction_days;
      }
    }
  }
  if (!healed) {
    const fd = frictionDays(p.friction_days);
    if (fd !== null) next.friction_days = fd;
  }

  const nick = str(p.nicknames, RELATIONSHIP_FIELD_MAX * 5);
  if (nick) next.nicknames = mergeNicknames(cur.nicknames, nick);

  if (enteredCoolingOff && !Number.isFinite(num(p.cooling_off_hours)) && !coolingOffNow(cur, now, null)) {
    next.cooling_off_set_at = now.toISOString();
    next.cooling_off_hours = DEFAULT_COOLING_OFF_HOURS;
  }
  return { next, notes };
}

// The status the prompt shows: a cooling off that ran out on story time reads as the status
// before it (else "talking"); otherwise the stored words. The record keeps "cooling off"
// until a proposal or the owner moves it.
export function displayStatus(rel: RelationshipState, now: Date, clock: StoryClock | null): string {
  const status = typeof rel.status === "string" ? rel.status : "";
  if (lateralOf(status) === "cooling off" && !coolingOffNow(rel, now, clock)) {
    const before = typeof rel.status_before === "string" ? rel.status_before.trim() : "";
    return before || ladderText(1);
  }
  return status;
}

// The keys the Relationship JSON line in CURRENT STATE drops (the friction line carries the
// friction instead; the clocks and the rung it left are the record's, not hers to read).
export const RELATIONSHIP_V5_HIDDEN_KEYS: readonly string[] = [
  "friction", "friction_set_at", "friction_days", "cooling_off_set_at", "cooling_off_hours", "status_before",
];

// ------------------------------------------------------------------ the scene record

const SCENE_STATUSES: readonly string[] = ["together", "apart", "none"];
const SCENE_LOCATION_MAX = 300;
const SCENE_TIME_MAX = 100;
const SCENE_PRESENT_MAX = 10;
const SCENE_PERSON_MAX = 100;

function sceneStatus(v: unknown): string | null {
  const t = typeof v === "string" ? v.trim().toLowerCase() : "";
  return SCENE_STATUSES.includes(t) ? t : null;
}

function sceneText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

function presentList(v: unknown): { list: string[]; valid: boolean } {
  if (!Array.isArray(v)) return { list: [], valid: false };
  const list = v
    .map((x) => sceneText(x, SCENE_PERSON_MAX))
    .filter((x): x is string => typeof x === "string")
    .slice(0, SCENE_PRESENT_MAX);
  // An explicit empty list is a valid "nobody"; a list of nothing but junk is not.
  return { list, valid: list.length > 0 || v.length === 0 };
}

// Every scene version v5 writes carries status, location, time and present. A together
// scene always has a place (the current one when the writer gave none; the owner's own PUT
// without one is refused when strict; a proposal without one keeps the current status). The
// time words describe one scene: they are dropped whenever the status changes, unless the
// writer set them (opts.timeSet, or, when that is absent, a time differing from the current
// version's), so a new scene never inherits last night's "late, past midnight".
export function normalizeSceneFields(
  next: Record<string, unknown>,
  cur: Record<string, unknown> | null,
  opts: { strict: boolean; timeSet?: boolean },
): Record<string, unknown> {
  const n = isPlainObject(next) ? next : {};
  const c = isPlainObject(cur) ? cur : null;
  const curStatus = c ? sceneStatus(c.status) : null;
  const curLocation = c ? sceneText(c.location, SCENE_LOCATION_MAX) : null;
  const curTime = c ? sceneText(c.time, SCENE_TIME_MAX) : null;

  let status = sceneStatus(n.status) ?? curStatus ?? "none";
  let location = sceneText(n.location, SCENE_LOCATION_MAX);
  if (status === "together" && !location) {
    if (curLocation) location = curLocation;
    else if (opts.strict) throw new ApiHttpError(400, "validation", "a together scene needs a place");
    else status = curStatus ?? "none";
  }

  let time = sceneText(n.time, SCENE_TIME_MAX);
  const statusBefore = c ? (curStatus ?? "none") : status;
  if (time && status !== statusBefore) {
    const writerSet = opts.timeSet === true || (opts.timeSet === undefined && time !== curTime);
    if (!writerSet) time = null;
  }

  const own = presentList(n.present);
  const fromCur = c ? presentList(c.present) : { list: [], valid: false };
  const present = own.valid ? own.list : fromCur.valid ? fromCur.list : [];

  const summary = typeof n.summary === "string" ? n.summary : c && typeof c.summary === "string" ? c.summary : "";
  const lastBeat = typeof n.last_beat === "string"
    ? n.last_beat
    : "last_beat" in n
      ? null
      : c && typeof c.last_beat === "string" ? c.last_beat : null;

  return { ...n, status, location, time, present, summary, last_beat: lastBeat };
}
