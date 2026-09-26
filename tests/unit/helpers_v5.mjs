// Fixtures for the v5 unit tests (SPEC_V5 "Tests added"). Builds on helpers.mjs to
// helpers_v4.mjs and never changes them. Plain Node 22, no Workers runtime.
//
// As in v3 and v4 the lanes land their modules in parallel: `loadSrcIfPresent` and `guard`
// make a missing module or export read as skipped (visible in the output), never as passed.
// The integrator runs every file once the tree is whole.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { settingsV4 } from "./helpers_v4.mjs";
import { T0 } from "./helpers_v3.mjs";

export { loadSrcIfPresent, loadFileIfPresent, guard, firstExport, T0, NOW, DAY_MS, daysAgo, publicFileExists, fakeFetch, carriesNone, placeRow } from "./helpers_v4.mjs";

// ------------------------------------------------------------------ files

// A repo file's text (relative to the repo root), or "" when it is not in the tree.
export function repoText(relative) {
  const path = fileURLToPath(new URL("../../" + relative, import.meta.url));
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

// ------------------------------------------------------------------ fixed instants (SPEC_V5)

export const TZ = "America/New_York";
export const TUE_2350_NY = "2026-09-30T03:50:00.000Z"; // Tuesday 11:50pm New York
export const WED_0030_NY = "2026-09-30T04:30:00.000Z"; // Wednesday 12:30am New York
export const TUE_2100_NY = "2026-09-30T01:00:00.000Z"; // Tuesday 9:00pm New York
export const FRI_1000_NY = "2026-10-02T14:00:00.000Z"; // Friday 10:00am New York
export const FRI_1005_NY = "2026-10-02T14:05:00.000Z"; // Friday 10:05am New York
export const MIN_MS = 60 * 1000;
export const HOUR_MS = 60 * MIN_MS;
export const plusMs = (iso, ms) => new Date(Date.parse(iso) + ms).toISOString();

// ------------------------------------------------------------------ the clock

// One story_clock row (a held span), every column present the way D1 answers it.
export function clockSpan(overrides = {}) {
  const opened = overrides.opened_version ?? 7;
  return {
    id: "sc_v" + opened,
    opened_version: opened,
    frozen_at: TUE_2100_NY,
    closed_version: null,
    resumed_at: null,
    location: "the harbour bench",
    weather_json: null,
    outfit_json: null,
    today_json: null,
    prior_time: null,
    beats_shifted_at: null,
    created_at: TUE_2100_NY,
    updated_at: TUE_2100_NY,
    ...overrides,
  };
}

// A StoryClock value as src/clock.ts builds it: `open` is the newest span with no resumed_at.
export function storyClock({ spans = [], real = FRI_1000_NY, enabled = true } = {}) {
  const sorted = [...spans].sort((a, b) => Date.parse(a.frozen_at) - Date.parse(b.frozen_at));
  const openSpans = sorted.filter((s) => !s.resumed_at);
  const open = enabled && openSpans.length ? openSpans[openSpans.length - 1] : null;
  const realIso = real instanceof Date ? real.toISOString() : real;
  return { enabled, real: realIso, frozen: Boolean(enabled && open), open, spans: sorted };
}

// ------------------------------------------------------------------ v5 rows

export function beatRow(overrides = {}) {
  return {
    id: "ab_test",
    want_id: "w_test",
    title: "the open mic",
    kind: "event",
    due_on: "2026-10-01",
    due_time: "20:00",
    due_at: "2026-10-02T00:00:00.000Z", // Thursday 8:00pm New York
    variants_json: null,
    status: "active",
    source: "owner",
    created_at: T0,
    updated_at: T0,
    ...overrides,
  };
}

export function beatRunRow(overrides = {}) {
  return {
    id: "br_test",
    beat_id: "ab_test",
    reader: "owner",
    status: "pending",
    due_at: "2026-10-02T00:00:00.000Z",
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
    created_at: T0,
    updated_at: T0,
    ...overrides,
  };
}

// A BeatView (src/arcs.ts): the beat, its owner run, its want, its variants.
export function beatView({ beat = {}, run = {}, want = {}, variants = [] } = {}) {
  const b = beatRow(beat);
  return {
    beat: b,
    run: run === null ? null : beatRunRow({ beat_id: b.id, due_at: b.due_at, ...run }),
    want: { id: b.want_id, title: "sing in front of people", status: "active", ...want },
    variants,
  };
}

export function viewRow(overrides = {}) {
  return {
    id: "hv_test",
    subject: "dodges family",
    subject_norm: "dodges family",
    view: "you dodge when i ask about your family",
    confidence: 0.6,
    evidence_json: JSON.stringify(["m_1", "m_2"]),
    status: "active",
    version: 1,
    supersedes_id: null,
    source: "nightly views 2026-09-29 run_x",
    wrong_note: null,
    wrong_evidence_json: null,
    created_at: T0,
    updated_at: T0,
    ...overrides,
  };
}

// A people row (SPEC_V5 section 8). Not helpers_v2's personRow (a life thread): this is the
// named entity that shadows one.
export function personRow(overrides = {}) {
  const name = overrides.name ?? "Mason";
  return {
    id: "pe_test",
    thread_id: "lt_v5_canon_mason",
    name,
    name_norm: name.toLowerCase().replace(/\s+/g, " ").trim(),
    relation: "ex",
    relation_norm: "ex",
    named: 1,
    locked_at: T0,
    created_at: T0,
    updated_at: T0,
    ...overrides,
  };
}

export function worldFactRow(overrides = {}) {
  return {
    id: "wf_test",
    entity_kind: "person",
    entity_id: "pe_test",
    fact: "he still has her hoodie",
    fact_norm: "still hoodie",
    source: "owner",
    status: "approved",
    created_at: T0,
    updated_at: T0,
    ...overrides,
  };
}

export function knownArtistRow(overrides = {}) {
  return {
    id: "ka_test",
    artist: "Some Artist",
    artist_norm: "some artist",
    kind: "known",
    source: "button",
    message_id: "m_her",
    note: null,
    created_at: T0,
    updated_at: T0,
    ...overrides,
  };
}

// ------------------------------------------------------------------ v5 settings

// The v4 test settings plus every v5 default of the SPEC_V5 settings table (twenty keys),
// and the nightly and hygiene models priced so a paid step can run on the stub.
export function settingsV5(overrides = {}) {
  const base = settingsV4();
  return settingsV4({
    storyClockEnabled: true,
    gapLineMinMinutes: 120,
    nightlyStoryEnabled: true,
    nightlyProvider: "stub",
    nightlyModel: "claude-sonnet-5",
    hygieneModel: "claude-haiku-4-5",
    nightlyBudgetUsd: 0.25,
    herDayItemsMax: 2,
    nightlyBeatsMax: 3,
    beatHorizonDays: 7,
    arcMemoryDays: 7,
    viewsShown: 6,
    viewMinConfidence: 0.4,
    viewsPerNight: 3,
    frictionDaysDefault: 4,
    sentShown: 12,
    sentWindowDays: 7,
    hygieneEnabled: true,
    worldShown: 6,
    knownArtistsShown: 40,
    prices: { ...base.prices, "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5 } },
    ...overrides,
  });
}

// The SPEC_V5 settings table: key -> [default, one good value, one bad value].
export const V5_SETTINGS_TABLE = {
  storyClockEnabled: [true, false, "yes"],
  gapLineMinMinutes: [120, 15, 14],
  nightlyStoryEnabled: [true, false, 1],
  nightlyProvider: ["anthropic", "stub", "mistral"],
  nightlyModel: ["claude-sonnet-5", "claude-opus-5", ""],
  hygieneModel: ["claude-haiku-4-5", "claude-sonnet-5", "x".repeat(201)],
  nightlyBudgetUsd: [0.25, 5, 5.01],
  herDayItemsMax: [2, 0, 4],
  nightlyBeatsMax: [3, 10, 11],
  beatHorizonDays: [7, 30, 0],
  arcMemoryDays: [7, 1, 31],
  viewsShown: [6, 0, 13],
  viewMinConfidence: [0.4, 1, 1.01],
  viewsPerNight: [3, 6, 7],
  frictionDaysDefault: [4, 14, 0],
  sentShown: [12, 30, 31],
  sentWindowDays: [7, 60, 0],
  hygieneEnabled: [true, false, "no"],
  worldShown: [6, 20, 21],
  knownArtistsShown: [40, 200, 201],
};

// ------------------------------------------------------------------ a scripted D1

// A D1 stand-in that answers from a script: `pairs` is a list of [regex, answer], where
// answer is an array of rows, a number (the `changes` a write reports), or a function
// (binds, sql) -> rows | number. The first pair whose regex matches the SQL answers; no
// match is no rows and `defaultChanges` changes. Every statement is recorded in `log`
// ({ sql, binds, via }) whether it ran through all, first, run, raw or batch; `writes()`
// lists the non-SELECT statements. A statement is recorded once per execution.
export function scriptedD1(pairs = [], { defaultChanges = 1 } = {}) {
  const log = [];
  const answerOf = (sql, binds) => {
    for (const [re, answer] of pairs) {
      if (re.test(sql)) return typeof answer === "function" ? answer(binds, sql) : answer;
    }
    return undefined;
  };
  const rowsOf = (sql, binds) => {
    const a = answerOf(sql, binds);
    return Array.isArray(a) ? a.map((r) => (r && typeof r === "object" ? { ...r } : r)) : [];
  };
  const changesOf = (sql, binds) => {
    const a = answerOf(sql, binds);
    if (typeof a === "number") return a;
    if (Array.isArray(a) && !/^\s*SELECT\b/i.test(sql)) return a.length;
    return defaultChanges;
  };
  function statement(sql, binds) {
    const st = {
      sql,
      binds,
      bind: (...b) => statement(sql, b),
      async all() {
        log.push({ sql, binds, via: "all" });
        return { results: rowsOf(sql, binds), success: true, meta: { changes: 0 } };
      },
      async first(column) {
        log.push({ sql, binds, via: "first" });
        const row = rowsOf(sql, binds)[0] ?? null;
        if (row && column) return row[column] ?? null;
        return row;
      },
      async run() {
        log.push({ sql, binds, via: "run" });
        return { results: [], success: true, meta: { changes: changesOf(sql, binds) } };
      },
      async raw() {
        log.push({ sql, binds, via: "raw" });
        return rowsOf(sql, binds).map((r) => Object.values(r));
      },
    };
    return st;
  }
  const db = {
    log,
    prepare: (sql) => statement(sql, []),
    async batch(stmts) {
      const out = [];
      for (const s of stmts) {
        log.push({ sql: s.sql, binds: s.binds, via: "batch" });
        const select = /^\s*(?:WITH\b[\s\S]*?\)\s*)?SELECT\b/i.test(s.sql);
        out.push({ results: select ? rowsOf(s.sql, s.binds) : [], success: true, meta: { changes: select ? 0 : changesOf(s.sql, s.binds) } });
      }
      return out;
    },
    async exec() { return { count: 0, duration: 0 }; },
    writes: () => log.filter((e) => !/^\s*SELECT\b/i.test(e.sql)),
    reads: () => log.filter((e) => /^\s*SELECT\b/i.test(e.sql)),
    matching: (re) => log.filter((e) => re.test(e.sql)),
  };
  return db;
}

// A scene state_versions row the way syncStoryClock reads it (version, created_at, the
// lowercased trimmed status, the location).
export function sceneVersion(version, status, created_at, location = null, time = null) {
  return { version, created_at, status, location, time };
}

// The rows syncStoryClock asks for, answered from one list of scene versions (the way the
// real reads would): the current version, the first non-together version after ?1, the
// run start at or before ?1, the version after ?1, the time words of version ?1 and the
// stale guard's opening version ?1. `spans` are the story_clock rows; `extra` goes first.
export function clockScript(versions, spans = [], extra = []) {
  const sorted = [...versions].sort((a, b) => a.version - b.version);
  const together = (v) => String(v.status ?? "").trim().toLowerCase() === "together";
  return [
    ...extra,
    [/FROM story_clock WHERE resumed_at IS NULL ORDER BY opened_version DESC/i, () => {
      const open = spans.filter((s) => !s.resumed_at).sort((a, b) => b.opened_version - a.opened_version);
      return open.slice(0, 1);
    }],
    [/FROM story_clock WHERE resumed_at IS NULL OR resumed_at >=/i, () => spans],
    [/WHERE entity = 'scene' ORDER BY version DESC LIMIT 1/i, () => (sorted.length ? [sorted[sorted.length - 1]] : [])],
    [/version > \?1\s+AND COALESCE\(lower\(trim\(json_extract\(state_json, '\$\.status'\)\)\), ''\) != 'together' ORDER BY version ASC LIMIT 1/i, (b) => {
      const v = sorted.find((x) => x.version > Number(b[0]) && !together(x));
      return v ? [{ version: v.version, created_at: v.created_at }] : [];
    }],
    [/COALESCE\(MAX\(version\), 0\) AS v/i, (b) => {
      const nt = sorted.filter((x) => x.version <= Number(b[0]) && !together(x));
      return [{ v: nt.length ? nt[nt.length - 1].version : 0 }];
    }],
    [/WHERE entity = 'scene' AND version > \?1 ORDER BY version ASC LIMIT 1/i, (b) => {
      const v = sorted.find((x) => x.version > Number(b[0]));
      return v ? [{ version: v.version, created_at: v.created_at, location: v.location }] : [];
    }],
    [/json_extract\(state_json, '\$\.time'\) AS time FROM state_versions/i, (b) => {
      const v = sorted.find((x) => x.version === Number(b[0]));
      return v ? [{ time: v.time ?? null }] : [];
    }],
    [/SELECT created_at, COALESCE\(lower\(trim\(json_extract\(state_json, '\$\.status'\)\)\), ''\) AS status FROM state_versions/i, (b) => {
      const v = sorted.find((x) => x.version === Number(b[0]));
      return v ? [{ created_at: v.created_at, status: String(v.status).trim().toLowerCase() }] : [];
    }],
    [/FROM weather_cache/i, []],
    [/FROM visual_assets/i, []],
    [/FROM grounding_log/i, []],
    [/FROM beat_runs/i, []],
  ];
}
