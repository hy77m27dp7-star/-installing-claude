// parseProposalJson: tolerant parsing of the proposal model's output. Nothing here promotes.
// extractProposals: the pass is a paid call, so the caps apply to it and a refusal is a
// flagged run row, never an exception into the turn.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeD1, loadSrc, testSettings } from "./helpers.mjs";

const { parseProposalJson, extractProposals, BUDGET_SKIPPED_FLAG } = await loadSrc("proposals");

const ONE = { kind: "avelie_fact", proposal: "she hates cilantro", evidence: "[[FACT:she hates cilantro]]", confidence: "high", scope: "general" };

test("a plain JSON array parses", () => {
  const out = parseProposalJson(JSON.stringify([ONE]));
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "avelie_fact");
  assert.equal(out[0].proposal, "she hates cilantro");
  assert.equal(out[0].evidence, "[[FACT:she hates cilantro]]");
  assert.equal(out[0].confidence, "high");
  assert.equal(out[0].scope, "general");
});

test("a fenced code block parses", () => {
  const out = parseProposalJson("```json\n" + JSON.stringify([ONE]) + "\n```");
  assert.equal(out.length, 1);
  assert.equal(parseProposalJson("```\n" + JSON.stringify([ONE]) + "\n```").length, 1);
});

test("prose around the array is ignored", () => {
  const out = parseProposalJson("Here is what I found:\n\n" + JSON.stringify([ONE]) + "\n\nLet me know if you need more.");
  assert.equal(out.length, 1);
});

test("invalid kinds are dropped, valid ones kept", () => {
  const out = parseProposalJson(JSON.stringify([{ ...ONE, kind: "nope" }, ONE, { ...ONE, kind: 42 }]));
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "avelie_fact");
});

test("every contract kind is accepted", () => {
  const kinds = ["avelie_fact", "justin_fact", "relationship", "scene", "history", "private_language", "opinion_change", "unknown"];
  const out = parseProposalJson(JSON.stringify(kinds.map((kind, i) => ({ ...ONE, kind, proposal: "p" + i }))));
  assert.deepEqual(out.map((p) => p.kind), kinds);
});

test("a non-array (object, empty array, empty string, garbage) yields []", () => {
  assert.deepEqual(parseProposalJson(JSON.stringify(ONE)), []);
  assert.deepEqual(parseProposalJson("[]"), []);
  assert.deepEqual(parseProposalJson(""), []);
  assert.deepEqual(parseProposalJson("nothing durable happened"), []);
  assert.deepEqual(parseProposalJson("[not json"), []);
  assert.deepEqual(parseProposalJson("null"), []);
});

test("an element without a proposal string is dropped; missing fields get safe defaults", () => {
  const out = parseProposalJson(JSON.stringify([
    { kind: "avelie_fact" },
    { kind: "avelie_fact", proposal: "   " },
    { kind: "justin_fact", proposal: "he has a dog", confidence: "certain" },
  ]));
  assert.equal(out.length, 1);
  assert.equal(out[0].proposal, "he has a dog");
  assert.ok(["low", "medium", "high"].includes(out[0].confidence));
  assert.equal(typeof out[0].evidence, "string");
  assert.equal(typeof out[0].scope, "string");
});

test("non-object elements are skipped", () => {
  const out = parseProposalJson(JSON.stringify(["text", 1, null, [ONE], ONE]));
  assert.equal(out.length, 1);
});

// ------------------------------------------------------------------ extractProposals under the caps

const T0 = "2026-09-24T00:00:00.000Z";
const ENV = { DB: {}, MEDIA: {}, ASSETS: {}, AI: {}, ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "", OWNER_EMAIL: "", APP_ENV: "test" };

function message(id, role, content) {
  return { id, conversation_id: "c_1", channel: "story", role, content, created_at: T0, seq: 1, idempotency_key: null, reply_to_id: null, model_run_id: null, flags_json: null, image_id: null, image_status: null };
}

// A database with the seeded state rows, no facts, no messages, and a day's spend.
function db(spentMicro) {
  return fakeD1((sql) => {
    if (/FROM state_versions WHERE entity = \?1/.test(sql)) return [{ id: "st", entity: "relationship", version: 1, state_json: JSON.stringify({ summary: "strangers" }), source: "seed", note: null, created_at: T0 }];
    if (/SUM\(cost_usd_micro\)/.test(sql)) return [{ s: spentMicro }];
    return [];
  });
}

const user = message("m_u", "user", "[[FACT:she hates cilantro]] noted");
const assistant = message("m_a", "assistant", "noted, ok.");
const runInserts = (d) => d.log.filter((s) => s.sql.startsWith("INSERT INTO model_runs "));

test("extractProposals: over the daily cap the pass is skipped, a failed run row carries the budget flag, nothing is proposed", async () => {
  const d = db(2_999_000);
  const n = await extractProposals(ENV, d, testSettings(), "c_1", user, assistant);
  assert.equal(n, 0);
  const runs = runInserts(d);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].via, "run");
  assert.equal(runs[0].binds[2], "proposal");
  assert.equal(runs[0].binds[10], "failed");
  assert.equal(runs[0].binds[11], "budget_exceeded");
  assert.deepEqual(JSON.parse(runs[0].binds[12]), [BUDGET_SKIPPED_FLAG]);
  assert.ok(!d.log.some((s) => s.sql.startsWith("INSERT INTO proposals ")), "no proposal row");
  assert.ok(!d.log.some((s) => s.sql.startsWith("INSERT INTO usage_daily ")), "no spend recorded");
});

test("extractProposals: an unpriced proposal model is skipped the same way (price_unknown), never run at $0", async () => {
  const d = db(0);
  const n = await extractProposals(ENV, d, testSettings({ proposalModel: "nobody-priced-this" }), "c_1", user, assistant);
  assert.equal(n, 0);
  const runs = runInserts(d);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].binds[11], "price_unknown");
  assert.deepEqual(JSON.parse(runs[0].binds[12]), [BUDGET_SKIPPED_FLAG]);
});

test("extractProposals: under the caps the stub pass runs and parks the fact as a pending proposal with its spend", async () => {
  const d = db(0);
  const n = await extractProposals(ENV, d, testSettings(), "c_1", user, assistant);
  assert.equal(n, 1);
  const proposal = d.log.find((s) => s.sql.startsWith("INSERT INTO proposals "));
  assert.ok(proposal && proposal.via === "batch");
  assert.equal(proposal.binds[4], "she hates cilantro");
  assert.equal(proposal.binds[9], "pending");
  const run = runInserts(d)[0];
  assert.equal(run.binds[10], "ok");
  assert.equal(run.binds[12], null, "no flag on a priced run");
  assert.ok(d.log.some((s) => s.sql.startsWith("INSERT INTO usage_daily ")));
});
