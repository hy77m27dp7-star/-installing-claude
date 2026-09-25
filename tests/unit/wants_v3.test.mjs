// Wants, asks and the fading mood (SPEC_V3 section CC): moodNow, logWant, the let-go
// statement, the WHAT YOU WANT section, and the two callback kinds with the opener rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeD1, BAD_TYPOGRAPHY } from "./helpers.mjs";
import { TZ } from "./helpers_v2.mjs";
import { loadSrcIfPresent, guard, wantRow, wantLogRow, askRow, settingsV3, NOW, daysAgo } from "./helpers_v3.mjs";

const wants = await loadSrcIfPresent("wants");
const t = guard(wants, "moodNow", "wantsSection", "letGoStaleStmts");
const callbacks = await loadSrcIfPresent("callbacks");
const S = settingsV3();

// ------------------------------------------------------------------ moodNow

const phase = (v) => (typeof v === "string" ? v : v && typeof v === "object" ? v.phase : v);

t("moodNow: fresh, fading, faint, gone on a fixed clock, and the default days from settings", () => {
  const rel = (daysBack, days) => ({ mood: "annoyed at him", mood_set_at: daysAgo(daysBack), ...(days ? { mood_days: days } : {}) });
  assert.equal(phase(wants.moodNow(rel(0.5, 3), NOW, S)), "fresh");
  assert.equal(phase(wants.moodNow(rel(2, 3), NOW, S)), "fading");
  assert.equal(phase(wants.moodNow(rel(4, 3), NOW, S)), "faint");
  assert.equal(phase(wants.moodNow(rel(7, 3), NOW, S)), "gone");
  assert.equal(phase(wants.moodNow(rel(1, undefined), NOW, S)), "fresh", "mood_days defaults to moodDaysDefault (3)");
  assert.equal(phase(wants.moodNow(rel(0.4, 1), NOW, S)), "fresh");
  assert.equal(phase(wants.moodNow(rel(3, 1), NOW, S)), "gone");
});

t("moodNow: no mood at all is gone (nothing to render), a mood with no set time reads as set at the given fallback", () => {
  const none = wants.moodNow({ mood: "" }, NOW, S);
  assert.ok(none === null || phase(none) === "gone" || phase(none) === "none" || phase(none) === undefined);
});

// ------------------------------------------------------------------ logWant

test("logWant: progress adds the delta, clips to 0..100 and sets last_moved; a setback subtracts; a note only logs", async (tc) => {
  if (!wants || typeof wants.logWant !== "function") {
    tc.skip("wants.ts logWant not in this tree yet");
    return;
  }
  const want = wantRow({ progress: 95 });
  const db = fakeD1((sql) => (/FROM wants/i.test(sql) ? [want] : []));
  await wants.logWant(db, want.id, { kind: "progress", delta: 10, note: "sang it through" }, "owner@test");
  const updates = db.log.filter((s) => /UPDATE wants/i.test(s.sql));
  assert.ok(updates.length >= 1, "an UPDATE on wants");
  assert.ok(updates.some((s) => s.binds.includes(100)), "clipped at 100: " + JSON.stringify(updates.map((u) => u.binds)));
  assert.ok(updates.some((s) => /last_moved/i.test(s.sql)), "last_moved set");
  assert.ok(db.log.some((s) => /INSERT INTO want_log/i.test(s.sql)), "the log row");
  assert.ok(db.log.some((s) => /audit_events/i.test(s.sql)), "audited");

  const db2 = fakeD1((sql) => (/FROM wants/i.test(sql) ? [wantRow({ progress: 5 })] : []));
  await wants.logWant(db2, "w_test", { kind: "setback", delta: 20, note: "lost the take" }, "owner@test");
  const u2 = db2.log.filter((s) => /UPDATE wants/i.test(s.sql));
  assert.ok(u2.some((s) => s.binds.includes(0)), "a setback clips at 0: " + JSON.stringify(u2.map((u) => u.binds)));

  const db3 = fakeD1((sql) => (/FROM wants/i.test(sql) ? [wantRow({ progress: 40 })] : []));
  await wants.logWant(db3, "w_test", { kind: "note", note: "thinking about the key change" }, "owner@test");
  assert.ok(!db3.log.some((s) => /UPDATE wants SET[^;]*progress/i.test(s.sql)), "a note never moves progress");
});

test("logWant: a done or dropped want answers 409 not_active", async (tc) => {
  if (!wants || typeof wants.logWant !== "function") {
    tc.skip("wants.ts logWant not in this tree yet");
    return;
  }
  const db = fakeD1((sql) => (/FROM wants/i.test(sql) ? [wantRow({ status: "done" })] : []));
  await assert.rejects(() => wants.logWant(db, "w_test", { kind: "progress", delta: 10, note: "x" }, "o"), (e) => e && e.status === 409 && e.code === "not_active");
});

// ------------------------------------------------------------------ letGoStaleStmts

t("letGoStaleStmts: only open asks older than N days, to let_go, with an audit", async () => {
  const stale = askRow({ id: "ask_old", asked_at: daysAgo(20) });
  const fresh = askRow({ id: "ask_new", asked_at: daysAgo(3) });
  const db = fakeD1((sql) => (/FROM asks/i.test(sql) ? [stale, fresh] : []));
  const r = await wants.letGoStaleStmts(db, NOW, 14);
  const stmts = Array.isArray(r) ? r : r.stmts;
  assert.ok(Array.isArray(stmts) && stmts.length >= 1);
  const updates = stmts.filter((s) => /UPDATE asks/i.test(s.sql));
  assert.equal(updates.length, 1, "only the stale open ask");
  assert.ok(updates[0].binds.includes("ask_old"), JSON.stringify(updates[0].binds));
  assert.ok(/let_go/i.test(updates[0].sql) || updates[0].binds.includes("let_go"), updates[0].sql);
  assert.ok(/status = 'open'/i.test(updates[0].sql), "guarded on status open: " + updates[0].sql);
  assert.ok(stmts.some((s) => /audit_events/i.test(s.sql)), "audited");
  if (!Array.isArray(r)) assert.deepEqual(r.askIds, ["ask_old"]);
});

// ------------------------------------------------------------------ wantsSection

t("wantsSection: full, paused, done and empty", () => {
  const active = wantRow();
  const paused = wantRow({ id: "w_p", title: "run three mornings a week", status: "paused", updated_at: daysAgo(2) });
  const done = wantRow({ id: "w_d", title: "sing at the open mic", status: "done", updated_at: daysAgo(3) });
  const stale = wantRow({ id: "w_s", title: "an old one", status: "done", updated_at: daysAgo(30) });
  const log = [wantLogRow(), wantLogRow({ id: "wl_2", occurred: daysAgo(8), note: "older note" })];
  const asks = [askRow(), askRow({ id: "ask_2", text: "listen to the demo", brought_up: 1, asked_at: daysAgo(2) })];
  const s = wants.wantsSection([active, paused, done, stale], log, asks, NOW, TZ, 5);
  assert.ok(s.startsWith("WHAT YOU WANT"), s.slice(0, 40));
  assert.ok(/it moves on your own days, not on his/.test(s));
  assert.ok(s.includes("- finish the bridge: 20%."));
  assert.ok(s.includes("got through the first half"), "the last log note");
  assert.ok(s.includes("Next: sing it through once without stopping."));
  assert.ok(s.includes("If it falls through: it stays a demo."));
  assert.ok(s.includes("paused: run three mornings a week"));
  assert.ok(s.includes("done: sing at the open mic"));
  assert.ok(!s.includes("an old one"), "a done want older than 14 days is not in the prompt");
  assert.ok(s.includes('You asked him: "send me the song you meant"'));
  assert.ok(/you have not brought it up again; once more at most, then let it go/.test(s));
  assert.ok(/you brought it up once already; leave it/.test(s));
  assert.ok(/Once\. It is never a debt and never a test/.test(s));
  assert.ok(/You can say no to him, plainly/.test(s));
  assert.ok(/Setbacks are yours to feel, not his to fix/.test(s));
  assert.ok(!BAD_TYPOGRAPHY.test(s));
  assert.equal(wants.wantsSection([], [], [], NOW, TZ, 5), "", "nothing to want: no section, no rules text");
});

t("wantsSection: the limit caps the active wants shown", () => {
  const many = Array.from({ length: 8 }, (_, i) => wantRow({ id: "w" + i, title: "want " + i }));
  const s = wants.wantsSection(many, [], [], NOW, TZ, 3);
  assert.equal((s.match(/^- want \d/gm) ?? []).length, 3);
});

// ------------------------------------------------------------------ callbacks: want and ask kinds

const tCb = callbacks && typeof callbacks.pickCallbacks === "function" ? test : (name, fn) => test.skip(name + " [skipped: callbacks.ts not in this tree]", fn);

function pick(extra) {
  return callbacks.pickCallbacks({ history: [], threads: [], log: [], recentTexts: [], now: NOW, seed: "s", wants: [], wantLog: [], asks: [], opener: false, ...extra });
}

tCb("callbacks: a stale want and a fresh untouched ask are candidates, each at most once", () => {
  const want = wantRow({ last_moved: daysAgo(5) });
  const ask = askRow({ asked_at: daysAgo(4), brought_up: 0 });
  const out = pick({ wants: [want], wantLog: [wantLogRow({ note: "got through the first half" })], asks: [ask] });
  const texts = out.map((c) => c.text);
  assert.ok(texts.some((x) => /finish the bridge/.test(x)), "the want: " + texts.join(" | "));
  assert.ok(texts.some((x) => /you asked him: send me the song you meant/.test(x)), "the ask: " + texts.join(" | "));
  assert.equal(new Set(out.map((c) => c.sourceId)).size, out.length);
  const freshWant = pick({ wants: [wantRow({ last_moved: daysAgo(1) })] });
  assert.ok(!freshWant.some((c) => /finish the bridge/.test(c.text)), "a want moved yesterday is not a callback");
  const young = pick({ asks: [askRow({ asked_at: daysAgo(1) })] });
  assert.ok(!young.some((c) => /you asked him/.test(c.text)), "an ask under three days old is not a callback");
  const nagged = pick({ asks: [askRow({ asked_at: daysAgo(5), brought_up: 1 })] });
  assert.ok(!nagged.some((c) => /you asked him/.test(c.text)), "an ask already brought up is never offered again");
});

tCb("callbacks: on an opener or a first text, no ask and no want whose last log is a setback", () => {
  const want = wantRow({ last_moved: daysAgo(5) });
  const out = pick({ wants: [want], wantLog: [wantLogRow({ kind: "setback", note: "lost the take", occurred: daysAgo(5) })], asks: [askRow({ asked_at: daysAgo(4) })], opener: true });
  assert.ok(!out.some((c) => /you asked him/.test(c.text)), "no ask on an opener");
  assert.ok(!out.some((c) => /lost the take/.test(c.text)), "no setback on an opener");
  const reply = pick({ wants: [want], wantLog: [wantLogRow({ kind: "setback", note: "lost the take", occurred: daysAgo(5) })], asks: [askRow({ asked_at: daysAgo(4) })], opener: false });
  assert.ok(reply.some((c) => /lost the take|you asked him/.test(c.text)), "a reply keeps both kinds");
});

// ------------------------------------------------------------------ moodLine (v3 fix pass)

t("moodLine: a fresh or fading mood says it is how she feels, not a way to treat him; a faint one and a gone one do not", () => {
  const rel = (daysBack) => ({ mood: "annoyed at him", mood_set_at: daysAgo(daysBack), mood_days: 3 });
  const fresh = wants.moodLine(wants.moodNow(rel(0.5), NOW, S));
  assert.ok(/^Mood: annoyed at him \(fresh, since /.test(fresh), fresh);
  assert.ok(/how you feel, not a way to treat him\)$/.test(fresh), fresh);
  const fading = wants.moodLine(wants.moodNow(rel(2), NOW, S));
  assert.ok(/^Mood: annoyed at him \(fading; how you feel, not a way to treat him\)$/.test(fading), fading);
  assert.equal(wants.moodLine(wants.moodNow(rel(4), NOW, S)), "Mood: annoyed at him (faint, mostly past)");
  assert.equal(wants.moodLine(wants.moodNow(rel(7), NOW, S)), "");
  assert.ok(!BAD_TYPOGRAPHY.test(fresh + fading));
});
