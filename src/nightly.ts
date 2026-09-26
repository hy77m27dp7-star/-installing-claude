// The nightly story pass (SPEC_V5 section 1): one job on the existing 0 7 * * * cron, after
// the backup and the maintenance, with its own budget line. Four steps in a fixed order, each
// its own try, each recorded in nightly_runs so a second run of the same day skips what is
// done (unless forced):
//   her_day  -- one or two small ordinary things from the day that just ended (this file)
//   arcs     -- how her dated steps went (src/arcs.ts)
//   views    -- her read of him (src/views.ts)
//   hygiene  -- duplicate facts and guesses held as facts (src/hygiene.ts)
// Everything a step decides is filed as a proposal with a source; the owner's Inbox, or his
// auto-keep switch, decides. Justin's rule: while a together scene is held, nothing happens
// to her, so her_day and arcs skip (views and hygiene only read the record, so they run).
import { runArcPass } from "./arcs";
import { HER_DAY_MIN_APART_MS, dayBounds, herDayKey, loadStoryClock, localInstant, storyElapsedMs } from "./clock";
import type { StoryClock } from "./clock";
import { auditStmt, getCurrentState, listFacts, nowIso } from "./db";
import { runHygienePass } from "./hygiene";
import { WEEKDAYS, listThreads, safeTimezone } from "./life";
import type { LifeThread } from "./life";
import { keepAutomatically } from "./proposals";
import { saidKey, saidLine } from "./said";
import { cleanLine, fileNightlyProposals, newNightlyBudget, paidJsonCall, parseJsonArray } from "./storycall";
import type { NightlyBudget, NightlyProposal, StepResult } from "./storycall";
import type { Env, RelationshipState, Settings } from "./types";
import { runViewPass } from "./views";
import { dayWeather } from "./weather";
import type { DayWeather } from "./weather";

export type NightlyStep = "her_day" | "arcs" | "views" | "hygiene";
export const NIGHTLY_STEPS: readonly NightlyStep[] = ["her_day", "arcs", "views", "hygiene"];
export const HER_DAY_PREFIX = "Write what happened in Avelie's day";
export const NIGHTLY_ACTOR = "nightly";

export interface NightlyRunRow { day: string; step: NightlyStep; ran_at: string; status: "done" | "skipped" | "failed"; result_json: string | null }

export interface NightlyStoryResult {
  at: string;
  day: string;
  skipped: string | null;
  frozen: boolean;
  spentUsd: number;
  steps: StepResult[];
  kept: number;
  duplicates: number;
}

const RESULT_JSON_MAX = 4000;
const FROZEN_REASON = "frozen: a together scene is held";
const HER_DAY_THREAD_KINDS: ReadonlySet<string> = new Set(["routine", "person", "place", "arc"]);
const HER_DAY_THREADS_MAX = 30;
const HER_DAY_FACTS_MAX = 20;
const HER_DAY_SAID_MAX = 30;
const HER_DAY_SAID_CHARS = 200;
const HER_DAY_ALREADY_MAX = 20;
const HER_DAY_STEPS_MAX = 20;
const HER_DAY_NOTE_MAX = 280;
const HER_DAY_ITEMS_CAP = 3;
const HER_DAY_ITEMS_DEFAULT = 2;
const TIME_RE = /^(\d{1,2}):(\d{2})$/;

function errorClass(e: unknown): string {
  return e instanceof Error ? e.name || "Error" : "error";
}

function intSetting(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : def;
  return Math.min(max, Math.max(min, n));
}

function weekdayOfDay(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return "";
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return WEEKDAYS[d.getUTCDay()] ?? "";
}

// ------------------------------------------------------------------ the her-day text (pure)

export function herDaySystem(day: string, weekday: string, max: number): string {
  return `Write what happened in Avelie's day on ${day} (${weekday}): one to ${max} small, ordinary things, the kind a 22-year-old in Portland, Maine would mention later if it came up. You are not her; you write no dialogue. Each thing belongs to one of her threads (THREADS) or, when it fits none, to none. Stay consistent with who she is (HER), with the weather that day (WEATHER), with what she already said about that day (SHE SAID) and with what is already written for that day (ALREADY). Never anything about him, never a big event, never a new person or place with a name, never how one of her dated steps went (STEPS are decided elsewhere), never sadness about him or waiting. Output strictly a JSON array, no prose, no fences: [{"thread": the exact thread title or "none", "note": one plain line, past tense, lowercase is fine, "time": "HH:MM" in her day}].`;
}

function firstLine(s: string | null | undefined): string {
  if (typeof s !== "string") return "";
  const line = s.split(/\r?\n/).find((l) => l.trim()) ?? "";
  return saidLine(line, 200);
}

function block(header: string, items: string[]): string {
  const lines = items.map((x) => saidLine(x, 400)).filter(Boolean);
  return header + "\n" + (lines.length ? lines.map((x) => "- " + x).join("\n") : "(none)");
}

export function herDayUser(args: { threads: LifeThread[]; her: string[]; weather: DayWeather | null; sheSaid: string[]; already: string[]; steps: string[] }): string {
  const threads = (Array.isArray(args.threads) ? args.threads : []).map((t) => {
    const rel = typeof t.relation === "string" && t.relation.trim() ? ", " + t.relation.trim() : "";
    const detail = firstLine(t.detail);
    return `${t.title} (${t.kind}${rel})${detail ? ": " + detail : ""}`;
  });
  const w = args.weather;
  const weather = w
    ? `WEATHER: ${w.words || "unknown"}, high ${Math.round(w.maxTemp)}, low ${Math.round(w.minTemp)}${w.precip > 0 ? ", rain" : ""}`
    : "WEATHER: (unknown)";
  const said = (Array.isArray(args.sheSaid) ? args.sheSaid : []).slice(0, HER_DAY_SAID_MAX).map((s) => saidLine(s, HER_DAY_SAID_CHARS));
  return [
    block("THREADS:", threads),
    block("HER:", (Array.isArray(args.her) ? args.her : []).slice(0, HER_DAY_FACTS_MAX)),
    weather,
    block("SHE SAID:", said),
    block("ALREADY:", (Array.isArray(args.already) ? args.already : []).slice(0, HER_DAY_ALREADY_MAX)),
    block("STEPS:", Array.isArray(args.steps) ? args.steps : []),
  ].join("\n");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function namesHim(note: string, hisName: string | null): boolean {
  if (/\bjustin\b/i.test(note)) return true;
  const n = typeof hisName === "string" ? hisName.trim() : "";
  if (!n) return false;
  return new RegExp("(^|[^A-Za-z0-9])" + escapeRe(n) + "($|[^A-Za-z0-9])", "i").test(note);
}

function readTime(v: unknown): string {
  const m = typeof v === "string" ? TIME_RE.exec(v.trim()) : null;
  if (!m) return "12:00";
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min) || h < 0 || h > 23 || min < 0 || min > 59) return "12:00";
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

export function parseHerDay(
  text: string,
  threads: LifeThread[],
  day: string,
  tz: string,
  max: number,
  hisName: string | null,
  nowMs: number,
): Array<{ thread: string | null; note: string; occurred: string }> {
  const cap = Number.isFinite(max) ? Math.max(0, Math.trunc(max)) : 0;
  if (cap <= 0) return [];
  const titles = new Map<string, string>();
  for (const t of Array.isArray(threads) ? threads : []) {
    if (!t || typeof t.title !== "string") continue;
    if (t.status !== undefined && t.status !== "active") continue;
    const k = t.title.trim().toLowerCase();
    if (k && !titles.has(k)) titles.set(k, t.title.trim());
  }
  const out: Array<{ thread: string | null; note: string; occurred: string }> = [];
  const seen = new Set<string>();
  for (const item of parseJsonArray(text)) {
    if (out.length >= cap) break;
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const rawThread = typeof o.thread === "string" ? o.thread.trim() : "";
    let thread: string | null = null;
    if (rawThread && rawThread.toLowerCase() !== "none") {
      const hit = titles.get(rawThread.toLowerCase());
      if (!hit) continue;
      thread = hit;
    }
    const note = cleanLine(o.note, HER_DAY_NOTE_MAX);
    if (!note) continue;
    if (namesHim(note, hisName)) continue;
    let occurred: string;
    try {
      occurred = localInstant(day, readTime(o.time), tz);
    } catch {
      continue;
    }
    if (Number.isFinite(nowMs) && Date.parse(occurred) > nowMs) continue;
    const key = saidKey(note);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ thread, note, occurred });
  }
  return out;
}

// ------------------------------------------------------------------ the her-day step

async function readRows<T>(db: D1Database, sql: string, binds: unknown[]): Promise<T[]> {
  try {
    const r = await db.prepare(sql).bind(...binds).all<T>();
    return r.results ?? [];
  } catch (e) {
    console.warn("nightly: read skipped", errorClass(e));
    return [];
  }
}

export async function runHerDay(env: Env, db: D1Database, settings: Settings, clock: StoryClock, budget: NightlyBudget, day: string): Promise<StepResult> {
  const tz = safeTimezone(settings.timezone);
  const { start, end } = dayBounds(day, tz);
  const realMs = Date.parse(clock.real);
  const endMs = Math.min(Date.parse(end), Number.isFinite(realMs) ? realMs : Date.parse(end));
  const apartMs = storyElapsedMs(clock, start, new Date(endMs).toISOString());
  if (apartMs < HER_DAY_MIN_APART_MS) {
    return { step: "her_day", status: "skipped", reason: "the day was mostly inside a held scene", proposalIds: [], detail: { apartMs } };
  }

  const threads = (await listThreads(db, "active")).filter((t) => HER_DAY_THREAD_KINDS.has(t.kind)).slice(0, HER_DAY_THREADS_MAX);
  const her = (await listFacts(db, "avelie"))
    .filter((f) => !(typeof f.subject === "string" && f.subject.trim().toLowerCase().startsWith("opinion:")))
    .map((f) => f.fact)
    .filter((x) => typeof x === "string" && x.trim())
    .slice(0, HER_DAY_FACTS_MAX);
  if (!threads.length && !her.length) return { step: "her_day", status: "skipped", reason: "no threads", proposalIds: [] };

  const [weather, said, lifeNotes, groundNotes, steps] = await Promise.all([
    dayWeather(env, settings, day),
    readRows<{ content: string }>(db, "SELECT content FROM messages WHERE channel = 'story' AND role = 'assistant' AND created_at >= ?1 AND created_at < ?2 ORDER BY created_at ASC LIMIT ?3", [start, end, HER_DAY_SAID_MAX]),
    readRows<{ note: string }>(db, "SELECT note FROM life_log WHERE occurred >= ?1 AND occurred < ?2 ORDER BY occurred ASC LIMIT ?3", [start, end, HER_DAY_ALREADY_MAX]),
    readRows<{ kind: string; note: string }>(db, "SELECT kind, note FROM grounding_log WHERE occurred >= ?1 AND occurred < ?2 ORDER BY occurred ASC LIMIT ?3", [start, end, HER_DAY_ALREADY_MAX]),
    readRows<{ title: string }>(db, "SELECT b.title FROM beat_runs r JOIN arc_beats b ON b.id = r.beat_id WHERE r.reader = 'owner' AND b.status = 'active' AND r.due_at >= ?1 AND r.due_at < ?2 ORDER BY r.due_at ASC LIMIT ?3", [start, end, HER_DAY_STEPS_MAX]),
  ]);
  const already = [
    ...lifeNotes.map((r) => r.note),
    ...groundNotes.map((r) => `${r.kind}: ${r.note}`),
  ].filter((x) => typeof x === "string" && x.trim()).slice(0, HER_DAY_ALREADY_MAX);

  let hisName: string | null = null;
  try {
    const rel = await getCurrentState<RelationshipState>(db, "relationship");
    hisName = typeof rel.state.his_name === "string" && rel.state.his_name.trim() ? rel.state.his_name.trim() : null;
  } catch {
    hisName = null;
  }

  const max = intSetting(settings.herDayItemsMax, HER_DAY_ITEMS_DEFAULT, 0, HER_DAY_ITEMS_CAP);
  const weekday = weekdayOfDay(day);
  const call = await paidJsonCall(env, db, settings, budget, {
    tag: "her_day",
    provider: settings.nightlyProvider,
    model: settings.nightlyModel,
    system: herDaySystem(day, weekday, max),
    user: herDayUser({
      threads,
      her,
      weather,
      sheSaid: said.map((r) => r.content).filter((x) => typeof x === "string" && x.trim()),
      already,
      steps: steps.map((r) => r.title).filter((x) => typeof x === "string" && x.trim()),
    }),
    maxTokens: 500,
    temperature: 0.8,
  });
  if (!call.ok) {
    return { step: "her_day", status: call.reason === "provider_failed" ? "failed" : "skipped", reason: call.reason, proposalIds: [] };
  }

  const items = parseHerDay(call.text, threads, day, tz, max, hisName, realMs);
  const rows: NightlyProposal[] = items.map((it) => ({
    kind: "life_update",
    proposal: `${weekday} ${day}, ${it.thread ?? "her day"}: ${it.note}`,
    evidence: `her day ${day}`,
    confidence: "medium",
    weight: 0.3,
    payload: { thread: it.thread, note: it.note, occurred: it.occurred, her_day: true, day },
    source: `nightly her_day ${day} ${call.runId}`,
  }));
  const ids = rows.length ? await fileNightlyProposals(db, rows) : [];
  const filed = ids.filter((x): x is string => typeof x === "string");
  return {
    step: "her_day",
    status: "done",
    reason: filed.length ? `${filed.length} filed` : "nothing to write",
    proposalIds: filed,
    detail: { runId: call.runId, items: items.length, filed: filed.length, costUsd: call.costUsd },
  };
}

// ------------------------------------------------------------------ the runner

function resultJson(r: StepResult): string {
  const full = JSON.stringify(r);
  if (full.length <= RESULT_JSON_MAX) return full;
  const lean = JSON.stringify({ step: r.step, status: r.status, reason: r.reason.slice(0, 500), proposalIds: r.proposalIds.slice(0, 60), truncated: true });
  if (lean.length <= RESULT_JSON_MAX) return lean;
  return JSON.stringify({ step: r.step, status: r.status, reason: r.reason.slice(0, 500), proposals: r.proposalIds.length, truncated: true });
}

async function stepDone(db: D1Database, day: string, step: NightlyStep): Promise<boolean> {
  const r = await db.prepare("SELECT status FROM nightly_runs WHERE day = ?1 AND step = ?2").bind(day, step).first<{ status: string }>();
  return !!r && r.status === "done";
}

function offReason(step: NightlyStep, settings: Settings): string | null {
  if (step === "her_day" && intSetting(settings.herDayItemsMax, HER_DAY_ITEMS_DEFAULT, 0, HER_DAY_ITEMS_CAP) === 0) return "off";
  if (step === "arcs" && intSetting(settings.nightlyBeatsMax, 3, 0, 10) === 0) return "off";
  if (step === "views" && intSetting(settings.viewsPerNight, 3, 0, 6) === 0) return "off";
  if (step === "hygiene" && settings.hygieneEnabled === false) return "off";
  return null;
}

export async function runNightlyStory(
  env: Env,
  db: D1Database,
  settings: Settings,
  opts: { now?: Date; force?: boolean; steps?: NightlyStep[] } = {},
): Promise<NightlyStoryResult> {
  const now = opts.now instanceof Date && Number.isFinite(opts.now.getTime()) ? opts.now : new Date();
  const at = now.toISOString();
  const tz = safeTimezone(settings.timezone);
  const day = herDayKey(now, tz);
  if (settings.nightlyStoryEnabled === false) {
    return { at, day, skipped: "off", frozen: false, spentUsd: 0, steps: [], kept: 0, duplicates: 0 };
  }

  const clock = await loadStoryClock(db, settings, now);
  const budget = newNightlyBudget(settings.nightlyBudgetUsd);
  const wanted = Array.isArray(opts.steps) ? new Set<NightlyStep>(opts.steps) : null;
  const order = NIGHTLY_STEPS.filter((s) => !wanted || wanted.has(s));
  const force = opts.force === true;
  const steps: StepResult[] = [];

  for (const step of order) {
    let result: StepResult;
    let record = true;
    try {
      if (!force && (await stepDone(db, day, step))) {
        result = { step, status: "skipped", reason: "already done", proposalIds: [] };
        record = false;
      } else {
        const off = offReason(step, settings);
        if (off) result = { step, status: "skipped", reason: off, proposalIds: [] };
        else if ((step === "her_day" || step === "arcs") && clock.frozen) result = { step, status: "skipped", reason: FROZEN_REASON, proposalIds: [] };
        else if (step === "her_day") result = await runHerDay(env, db, settings, clock, budget, day);
        else if (step === "arcs") result = await runArcPass(env, db, settings, clock, budget, now);
        else if (step === "views") result = await runViewPass(env, db, settings, budget, now);
        else result = await runHygienePass(env, db, settings, budget, now);
      }
    } catch (e) {
      console.error("nightly: step failed", step, errorClass(e));
      result = { step, status: "failed", reason: errorClass(e), proposalIds: [] };
    }
    steps.push(result);
    if (!record) continue;
    try {
      await db
        .prepare("INSERT OR REPLACE INTO nightly_runs (day, step, ran_at, status, result_json) VALUES (?1, ?2, ?3, ?4, ?5)")
        .bind(day, step, nowIso(), result.status, resultJson(result))
        .run();
    } catch (e) {
      console.warn("nightly: run not recorded", step, errorClass(e));
    }
  }

  let kept = 0;
  let duplicates = 0;
  const ids = steps.flatMap((s) => (Array.isArray(s.proposalIds) ? s.proposalIds : [])).filter((x) => typeof x === "string" && x);
  if (settings.proposalsAutoApprove === true && ids.length) {
    try {
      const k = await keepAutomatically(db, ids, "auto");
      kept = k.kept;
      duplicates = k.duplicates;
    } catch (e) {
      console.error("nightly: auto-keep failed", errorClass(e));
    }
  }

  const spentUsd = Math.round(budget.spentUsd * 1_000_000) / 1_000_000;
  const out: NightlyStoryResult = { at, day, skipped: null, frozen: clock.frozen, spentUsd, steps, kept, duplicates };
  try {
    await auditStmt(db, NIGHTLY_ACTOR, "nightly.story", "cron", day, null, {
      at,
      day,
      frozen: clock.frozen,
      spentUsd,
      stopped: budget.stopped,
      runs: budget.runIds.length,
      steps: steps.map((s) => ({ step: s.step, status: s.status, reason: s.reason, proposals: s.proposalIds.length })),
      kept,
      duplicates,
    }).run();
  } catch (e) {
    console.warn("nightly: audit not written", errorClass(e));
  }
  return out;
}

export async function listNightlyRuns(db: D1Database, limit = 28): Promise<NightlyRunRow[]> {
  const n = Number.isFinite(limit) ? Math.min(200, Math.max(1, Math.trunc(limit))) : 28;
  const r = await db
    .prepare("SELECT day, step, ran_at, status, result_json FROM nightly_runs ORDER BY ran_at DESC LIMIT ?1")
    .bind(n)
    .all<NightlyRunRow>();
  return r.results ?? [];
}
