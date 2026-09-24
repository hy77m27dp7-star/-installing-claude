// Fixtures for the v2 unit tests: fixed instants, life rows, a v2 prompt state and a
// tiny D1 stand-in. Builds on helpers.mjs (the resolve hook, the v1 rows) and never
// changes it. Plain Node 22, no Workers runtime.
import { promptState } from "./helpers.mjs";

// 2026-09-29 is a Tuesday. New York is on EDT (UTC-4) all of September.
export const TZ = "America/New_York";
export const TUE_1510_NY = new Date("2026-09-29T19:10:00Z"); // Tuesday 3:10pm New York
export const TUE_2000_NY = new Date("2026-09-30T00:00:00Z"); // Tuesday 8:00pm New York
export const TUE_0830_NY = new Date("2026-09-29T12:30:00Z"); // Tuesday 8:30am New York, 1:30pm London
export const SAT_1000_NY = new Date("2026-10-03T14:00:00Z"); // Saturday 10:00am New York
export const TUE_1730_NY_ISO = "2026-09-29T21:30:00.000Z"; // Tuesday 5:30pm New York, as an instant

const T0 = "2026-09-01T12:00:00.000Z";

export function threadRow(overrides = {}) {
  return {
    id: "lt_test",
    kind: "routine",
    title: "a test thread",
    detail: null,
    schedule_json: null,
    status: "active",
    relation: null,
    source: null,
    version: 1,
    supersedes_id: null,
    created_at: T0,
    updated_at: T0,
    ...overrides,
  };
}

// Monday to Friday, 9:00 to 5:30, labelled "at work".
export function workRoutine(overrides = {}) {
  return threadRow({
    id: "lt_work",
    kind: "routine",
    title: "the shop",
    schedule_json: JSON.stringify({ tz: TZ, blocks: [{ days: [1, 2, 3, 4, 5], start: "09:00", end: "17:30", label: "at work" }] }),
    ...overrides,
  });
}

export function eventRow(atIso, overrides = {}) {
  return threadRow({
    id: "lt_event",
    kind: "event",
    title: "open mic",
    schedule_json: JSON.stringify({ at: atIso, label: "open mic at the bar on 4th" }),
    ...overrides,
  });
}

export function personRow(overrides = {}) {
  return threadRow({ id: "lt_person", kind: "person", title: "Dana", relation: "best friend", detail: "moving apartments this month", ...overrides });
}

export function placeRow(overrides = {}) {
  return threadRow({ id: "lt_place", kind: "place", title: "the laundromat on 9th", detail: "fluorescent, one working dryer", ...overrides });
}

export function arcRow(overrides = {}) {
  return threadRow({ id: "lt_arc", kind: "arc", title: "the singing", detail: "she has sung in front of exactly one person", ...overrides });
}

export function logRow(overrides = {}) {
  return {
    id: "ll_test",
    thread_id: null,
    occurred: "2026-09-27T20:00:00.000Z",
    note: "burnt the rice again",
    source: null,
    created_at: "2026-09-27T20:05:00.000Z",
    ...overrides,
  };
}

// The v1 prompt state plus the v2 fields (mode, life, callbacks), apart with an empty life.
export function promptStateV2(overrides = {}) {
  return promptState({
    mode: "apart",
    life: { threads: [], log: [], now: TUE_1510_NY, tz: TZ },
    callbacks: [],
    ...overrides,
  });
}

// Message rows the way D1 returns them (every column present, null when unset).
export function messageRow(overrides = {}) {
  return {
    id: "m_test",
    conversation_id: "c_test",
    channel: "story",
    role: "assistant",
    content: "ok. noted.",
    created_at: T0,
    seq: 1,
    idempotency_key: null,
    reply_to_id: "m_user",
    model_run_id: null,
    flags_json: null,
    image_id: null,
    image_status: null,
    deliver_at: null,
    song_json: null,
    ...overrides,
  };
}

// ------------------------------------------------------------------ a D1 stand-in

// Enough of the D1 surface for modules that read tables and write rows: prepare(sql)
// returns a statement whose all()/first() answer with the fixture rows of the first
// table named in the SQL (FROM x / JOIN x / INTO x / UPDATE x), run() records the
// bound values, and batch() runs every statement. Rows are returned as given; no SQL is
// evaluated, so a test that needs filtering passes pre-filtered rows.
export function fakeDb(tables = {}) {
  const writes = [];
  const queries = [];
  const store = { ...tables };
  const tableOf = (sql) => {
    const m = /\b(?:FROM|JOIN|INTO|UPDATE)\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(sql);
    return m ? m[1] : null;
  };
  // Rows of the named table, narrowed by every "column = ?N" the SQL binds when the row
  // has that column (so "WHERE entity = ?1" picks the right state rows). Literals,
  // LIMIT and ORDER BY are not evaluated: pass rows pre-filtered and pre-sorted.
  const rowsFor = (sql, binds) => {
    const t = tableOf(sql);
    let rows = t && Array.isArray(store[t]) ? store[t] : [];
    for (const m of sql.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\?(\d+)/g)) {
      const col = m[1];
      const value = binds[Number(m[2]) - 1];
      if (value === undefined) continue;
      rows = rows.filter((r) => !(col in r) || r[col] === value);
    }
    return rows.map((r) => ({ ...r }));
  };
  function statement(sql) {
    const self = {
      sql,
      binds: [],
      bind(...values) { self.binds = values; return self; },
      async all() { queries.push({ sql, binds: self.binds }); return { results: rowsFor(sql, self.binds), success: true, meta: {} }; },
      async first(column) {
        queries.push({ sql, binds: self.binds });
        const rows = rowsFor(sql, self.binds);
        if (/COUNT\(\*\)/i.test(sql)) return { n: rows.length, m: rows.length, s: 0 };
        const row = rows[0] ?? null;
        if (row && column) return row[column];
        return row;
      },
      async run() { writes.push({ sql, binds: self.binds }); return { success: true, meta: { changes: 1 } }; },
      async raw() { return rowsFor(sql, self.binds).map((r) => Object.values(r)); },
    };
    return self;
  }
  return {
    tables: store,
    writes,
    queries,
    prepare: (sql) => statement(sql),
    async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; },
    async exec() { return { count: 0, duration: 0 }; },
  };
}

// An Env with every secret set to a recognisable value, so an export or a log line can be
// searched for leaks.
export function secretEnv(overrides = {}) {
  return {
    ACCESS_TEAM_DOMAIN: "example.cloudflareaccess.com",
    ACCESS_AUD: "",
    OWNER_EMAIL: "owner@example.com",
    APP_ENV: "unit",
    ANTHROPIC_API_KEY: "sk-ant-SECRET-anthropic-0001",
    OPENAI_API_KEY: "sk-SECRET-openai-0002",
    ELEVENLABS_API_KEY: "el-SECRET-elevenlabs-0003",
    VAPID_PUBLIC_KEY: "BPUBLIC-not-secret",
    VAPID_PRIVATE_KEY: "vapid-SECRET-private-0004",
    ...overrides,
  };
}

export const SECRET_VALUES = ["SECRET-anthropic-0001", "SECRET-openai-0002", "SECRET-elevenlabs-0003", "SECRET-private-0004"];
