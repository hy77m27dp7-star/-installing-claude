// The Anthropic adapter's two-block system (SPEC_V3 header): the prefix cached, the state
// not, the joined text equal to req.system; one block when systemParts is absent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSrc } from "./helpers.mjs";

const anthropic = await loadSrc("providers/anthropic");
const t = typeof anthropic.systemBlocks === "function" ? test : (name, fn) => test.skip(name + " [skipped: providers/anthropic.ts exports no systemBlocks yet]", fn);

const SEP = "\n\n" + "=".repeat(60) + "\n\n";
const req = (overrides = {}) => ({
  system: "PREFIX TEXT" + SEP + "STATE TEXT",
  systemParts: { prefix: "PREFIX TEXT", state: "STATE TEXT" },
  messages: [{ role: "user", content: "hey" }],
  model: "claude-opus-5",
  maxTokens: 700,
  temperature: 0.9,
  effort: "medium",
  cacheable: true,
  ...overrides,
});

t("systemBlocks: two blocks, cache_control on the first only, the two texts joined by the separator equal req.system", () => {
  const blocks = anthropic.systemBlocks(req());
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, "text");
  assert.deepEqual(blocks[0].cache_control, { type: "ephemeral" });
  assert.equal(blocks[1].type, "text");
  assert.equal(blocks[1].cache_control, undefined);
  assert.equal(blocks[0].text + SEP + blocks[1].text, req().system);
});

t("systemBlocks: one block when systemParts is absent (the whole system, cached when cacheable)", () => {
  const r = req({ systemParts: undefined });
  delete r.systemParts;
  const blocks = anthropic.systemBlocks(r);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].text, r.system);
  assert.deepEqual(blocks[0].cache_control, { type: "ephemeral" });
  const cold = anthropic.systemBlocks({ ...r, cacheable: false });
  assert.equal(cold.length, 1);
  assert.equal(cold[0].cache_control, undefined);
});

t("systemBlocks: byte-identical on a retry (the same request twice)", () => {
  const r = req();
  assert.deepEqual(anthropic.systemBlocks(r), anthropic.systemBlocks({ ...r, messages: [...r.messages, { role: "assistant", content: "draft" }, { role: "user", content: "note" }] }));
});
