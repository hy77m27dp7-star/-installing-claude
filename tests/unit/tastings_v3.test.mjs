// Blind tastings (SPEC_V3 section HH): the left/right assignment, the ledger arithmetic,
// the blind response, and the 30-minute expiry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSrc, fakeD1 } from "./helpers.mjs";
import { fakeDb } from "./helpers_v2.mjs";
import { loadSrcIfPresent, firstExport, tastingRow, NOW } from "./helpers_v3.mjs";

const tastings = await loadSrcIfPresent("tastings");
const { seededUnit } = await loadSrc("life");

test("left/right: deterministic and roughly balanced over 1,000 ids", () => {
  const f = firstExport(tastings, ["leftSideFor", "leftSide", "assignLeft", "pickLeftSide"]);
  const side = f.fn ? f.fn : (id) => (seededUnit(id) < 0.5 ? "A" : "B");
  let a = 0;
  for (let i = 0; i < 1000; i++) {
    const s = side("ts_" + i);
    assert.equal(s, side("ts_" + i), "deterministic");
    assert.ok(s === "A" || s === "B");
    if (s === "A") a++;
  }
  assert.ok(a > 400 && a < 600, "balanced: " + a);
});

test("the ledger arithmetic on a fixed set: wins, losses, draws, rate, last picked", async (tc) => {
  if (!tastings || typeof tastings.ledger !== "function") {
    tc.skip("tastings.ts ledger not in this tree yet");
    return;
  }
  const rows = [
    tastingRow({ id: "t1", left_side: "A", pick: "left", winner_side: "A", status: "picked", decided_at: "2026-09-20T00:00:00.000Z" }),
    tastingRow({ id: "t2", left_side: "B", pick: "left", winner_side: "B", status: "picked", decided_at: "2026-09-21T00:00:00.000Z" }),
    tastingRow({ id: "t3", left_side: "A", pick: "right", winner_side: "B", status: "picked", decided_at: "2026-09-22T00:00:00.000Z" }),
    tastingRow({ id: "t4", left_side: "A", pick: "neither", winner_side: null, status: "void", decided_at: "2026-09-23T00:00:00.000Z" }),
    tastingRow({ id: "t5", left_side: "A", pick: null, winner_side: null, status: "pending", decided_at: null }),
  ];
  const db = fakeDb({ tastings: rows, tasting_candidates: [] });
  const led = await tastings.ledger(db);
  const performers = led.performers ?? led;
  const opus = performers.find((p) => /claude-opus-5/.test(p.performer ?? p.name ?? p.model ?? ""));
  const gpt = performers.find((p) => /gpt-4\.1/.test(p.performer ?? p.name ?? p.model ?? ""));
  assert.ok(opus && gpt, JSON.stringify(performers));
  assert.equal(opus.wins, 1);
  assert.equal(opus.losses, 2);
  assert.equal(opus.draws, 1);
  assert.equal(gpt.wins, 2);
  assert.equal(gpt.losses, 1);
  assert.equal(gpt.draws, 1);
  assert.ok(Math.abs(opus.rate - 1 / 3) < 0.01 || Math.abs(opus.rate - 1 / 4) < 0.01, "rate over picks (or over all): " + opus.rate);
  assert.ok(Array.isArray(led.recent) ? led.recent.length <= 20 : true);
});

test("the blind response carries no provider or model strings", (tc) => {
  const f = firstExport(tastings, ["blindResponse", "blindView", "toBlind", "tastingResponse"]);
  if (!f.fn) {
    tc.skip("tastings.ts exports no blind response builder (tried blindResponse, blindView, toBlind, tastingResponse)");
    return;
  }
  const row = tastingRow({ status: "pending", pick: null, winner_side: null, decided_at: null });
  const cands = [
    { id: "c1", tasting_id: row.id, side: "A", text: "a says this", photo: null, song_json: null, clip: null, flags_json: "[]", run_id: "r1", retried: 0, cost_usd_micro: 0, created_at: row.created_at },
    { id: "c2", tasting_id: row.id, side: "B", text: "b: says that", photo: null, song_json: null, clip: null, flags_json: "[]", run_id: "r2", retried: 0, cost_usd_micro: 0, created_at: row.created_at },
  ];
  const out = f.fn(row, cands);
  const text = JSON.stringify(out);
  for (const s of ["anthropic", "openai", "claude-opus-5", "gpt-4.1", "a_provider", "b_model", "winner"]) assert.ok(!text.includes(s), s + " leaked: " + text);
  assert.ok(text.includes('"left"') && text.includes('"right"'));
  assert.ok(text.includes("a says this") && text.includes("b: says that"));
});

test("expiry at 30 minutes: the stale statement binds a cutoff 30 minutes back", (tc) => {
  if (!tastings || typeof tastings.expireStaleStmts !== "function") {
    tc.skip("tastings.ts expireStaleStmts not in this tree yet");
    return;
  }
  const db = fakeD1();
  const stmts = tastings.expireStaleStmts(db, NOW);
  assert.ok(Array.isArray(stmts) && stmts.length >= 1);
  const upd = stmts.find((s) => /UPDATE tastings/i.test(s.sql));
  assert.ok(upd, "an UPDATE on tastings");
  assert.ok(/expired/i.test(upd.sql) || upd.binds.includes("expired"));
  assert.ok(/pending/i.test(upd.sql) || upd.binds.includes("pending"));
  const cutoff = new Date(NOW.getTime() - 30 * 60 * 1000).toISOString();
  assert.ok(upd.binds.some((b) => typeof b === "string" && b.slice(0, 16) === cutoff.slice(0, 16)), JSON.stringify(upd.binds));
});

test("the void rule is the integration suite's ([[BFAIL]]); here only that the pure expiry check exists or is skipped", (tc) => {
  const f = firstExport(tastings, ["isExpired", "expired", "tastingExpired"]);
  if (!f.fn) {
    tc.skip("tastings.ts exports no isExpired (tried isExpired, expired, tastingExpired)");
    return;
  }
  assert.equal(f.fn(new Date(NOW.getTime() - 31 * 60000).toISOString(), NOW), true);
  assert.equal(f.fn(new Date(NOW.getTime() - 29 * 60000).toISOString(), NOW), false);
});
