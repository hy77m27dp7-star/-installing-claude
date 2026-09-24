// The v3 proposal kinds and payloads (SPEC_V3 sections BB, CC, DD): weight on every
// element, want, want_update, ask, ask_update, grounding and life_update. Gated on the
// kind list carrying "want".
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSrc } from "./helpers.mjs";

const proposals = await loadSrc("proposals");
const { parseProposalJson, PROPOSAL_KINDS } = proposals;
const v3 = PROPOSAL_KINDS.includes("want");
const t = v3 ? test : (name, fn) => test.skip(name + " [skipped: proposals.ts has no v3 kinds yet]", fn);

const el = (extra) => ({ proposal: "x", evidence: "q", confidence: "high", scope: "general", ...extra });
const one = (extra) => parseProposalJson(JSON.stringify([el(extra)]))[0];

t("the seven v3 kinds are known and the v2 list is intact", () => {
  for (const k of ["want", "want_update", "ask", "ask_update", "grounding", "life_update"]) assert.ok(PROPOSAL_KINDS.includes(k), k);
  for (const k of ["avelie_fact", "justin_fact", "relationship", "scene", "history", "private_language", "opinion_change", "unknown", "life"]) assert.ok(PROPOSAL_KINDS.includes(k), k);
});

t("weight: a number 0.1 to 1 on any element survives the parse; junk is dropped or clipped, never a throw", () => {
  const p = one({ kind: "justin_fact", proposal: "his dog is called biscuit", weight: 0.8 });
  assert.ok(p, "parsed");
  const w = p.weight ?? (p.payload && p.payload.weight);
  assert.equal(w, 0.8);
  const junk = one({ kind: "justin_fact", proposal: "x", weight: "heavy" });
  assert.ok(junk, "a bad weight never loses the proposal");
  const jw = junk.weight ?? (junk.payload && junk.payload.weight);
  assert.ok(jw === undefined || jw === null || (typeof jw === "number" && jw >= 0.1 && jw <= 1));
});

t("want: the payload carries title, why, stakes, next_step, horizon_days", () => {
  const p = one({ kind: "want", proposal: "she wants to finish the bridge", payload: { title: "finish the bridge", why: "stuck", stakes: "a demo forever", next_step: "sing it through", horizon_days: 30 } });
  assert.equal(p.kind, "want");
  assert.equal(p.payload.title, "finish the bridge");
  assert.equal(p.payload.horizon_days, 30);
});

t("want_update: kind progress, setback or note with a delta and a note", () => {
  const p = one({ kind: "want_update", proposal: "she got through the first half", payload: { want: "finish the bridge", kind: "progress", delta: 30, note: "got through the first half" } });
  assert.equal(p.kind, "want_update");
  assert.equal(p.payload.kind, "progress");
  assert.equal(p.payload.delta, 30);
  assert.equal(p.payload.want, "finish the bridge");
});

t("ask and ask_update", () => {
  const a = one({ kind: "ask", proposal: "she asked him for the song", payload: { text: "send me the song you meant", want: "finish the bridge" } });
  assert.equal(a.kind, "ask");
  assert.equal(a.payload.text, "send me the song you meant");
  const u = one({ kind: "ask_update", proposal: "he sent it", payload: { ask: "send me the song you meant", status: "granted" } });
  assert.equal(u.kind, "ask_update");
  assert.equal(u.payload.status, "granted");
});

t("grounding and life_update", () => {
  const g = one({ kind: "grounding", proposal: "she had a bagel", payload: { kind: "meal", note: "a bagel", occurred: "2026-09-29T13:00:00Z" } });
  assert.equal(g.kind, "grounding");
  assert.equal(g.payload.kind, "meal");
  assert.equal(g.payload.note, "a bagel");
  const l = one({ kind: "life_update", proposal: "Dani cancelled again", payload: { thread: "Dani", note: "cancelled again" } });
  assert.equal(l.kind, "life_update");
  assert.equal(l.payload.thread, "Dani");
  assert.equal(l.payload.note, "cancelled again");
});

t("relationship: mood_days rides in the payload, 1 to 14", () => {
  const p = one({ kind: "relationship", proposal: "she is annoyed with him", payload: { mood: "annoyed", mood_days: 2 } });
  assert.equal(p.payload.mood, "annoyed");
  assert.equal(p.payload.mood_days, 2);
});
