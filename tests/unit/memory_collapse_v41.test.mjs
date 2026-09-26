// 2026-09-26: the memory page repeated kept lines and sealed subjects. Only live rows show,
// the same kept thing in other words shows once, and a lone short fact never folds into a
// longer one that happens to share its words.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSrc } from "./helpers.mjs";

const memory = await loadSrc("memory");
const k = (id, kind, proposal) => ({ id, kind, proposal, decidedAt: "2026-09-26T16:00:00.000Z" });

test("collapseKept: the same event reworded collapses; different kinds and short facts do not", () => {
  const out = memory.collapseKept([
    k("a", "scene", "They took a selfie together at the sandwich place, then left to walk to a record store on Congress Street"),
    k("b", "scene", "They took a selfie together at the sandwich place"),
    k("c", "unknown", "Justin has not said the real reason he left LA for Maine"),
    k("d", "unknown", "Why Justin left LA for Maine is unresolved"),
    k("e", "avelie_fact", "Mason cheated on Avelie and later wrote a song about her with inaccurate details (said blue eyes, hers are brown)"),
    k("f", "avelie_fact", "Has brown eyes"),
    k("g", "life", "Avelie sings almost constantly when alone (car, shower, shop)"),
    k("h", "life", "Avelie sings/writes music as a long-running personal thread"),
  ]);
  assert.deepEqual(out.map((x) => x.id), ["a", "c", "e", "f", "g", "h"]);
});

test("deadChainIds: a chain whose newest row is dropped marks every id in it; a live chain none", () => {
  const rows = [
    { id: "t1", supersedes_id: null, status: "superseded" },
    { id: "t2", supersedes_id: "t1", status: "dropped" },
    { id: "u1", supersedes_id: null, status: "superseded" },
    { id: "u2", supersedes_id: "u1", status: "active" },
  ];
  assert.deepEqual(memory.deadChainIds(rows, (s) => s === "dropped").sort(), ["t1", "t2"]);
});
