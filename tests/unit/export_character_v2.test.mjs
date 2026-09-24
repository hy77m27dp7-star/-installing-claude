// src/exportCharacter.ts: the character package (SPEC_V2 section Z). No secret in either
// form, and the prefix hash is over a prefix that never names him.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { loadSrc, factRow, historyRow, unknownRow, relationshipState, sceneState, BAD_TYPOGRAPHY } from "./helpers.mjs";
import { fakeDb, secretEnv, SECRET_VALUES, threadRow, workRoutine, personRow, logRow } from "./helpers_v2.mjs";

const { exportCharacterJson, exportCharacterMarkdown } = await loadSrc("exportCharacter");
const { stablePrefix } = await loadSrc("prompt");
const { CONSTITUTION_VERSION } = await loadSrc("generated/constitution");

const D = "2026-09-20T12:00:00.000Z";

function tables() {
  return {
    facts: [
      factRow({ id: "f_fixed", scope: "fixed", subject: "age", fact: "She is 22." }),
      factRow({ id: "f_a1", scope: "avelie", fact: "she keeps a plant alive out of spite" }),
      factRow({ id: "f_op", scope: "avelie", subject: "opinion: his song Exits", fact: "the bridge is the only honest part" }),
      factRow({ id: "f_j1", scope: "justin", fact: "he has a dog" }),
      factRow({ id: "f_gone", scope: "avelie", fact: "superseded and gone", status: "superseded" }),
    ],
    history: [historyRow({ id: "h1", title: "the bench", body: "they sat on the bench", created_at: D, updated_at: D })],
    unknowns: [unknownRow({ id: "u1", topic: "where she grew up" })],
    state_versions: [
      { id: "s1", entity: "relationship", version: 1, state_json: JSON.stringify(relationshipState({ his_name: "Justin" })), source: "seed", note: null, created_at: D },
      { id: "s2", entity: "scene", version: 1, state_json: JSON.stringify(sceneState()), source: "seed", note: null, created_at: D },
    ],
    life_threads: [workRoutine(), personRow(), threadRow({ id: "lt_gone", kind: "arc", title: "dropped arc", status: "dropped" })],
    life_log: [logRow()],
    visual_assets: [
      { id: "img1", file: "candidates/img1.png", role: "scene", sha256: "abcd", bytes: 10, approval_status: "approved", conversation_id: "c1", message_id: "m1", prompt: "couch, hoodie", provider: "stub", model: "x", notes: null, created_at: D, decided_at: D },
      { id: "img2", file: "candidates/img2.png", role: "candidate", sha256: "ef01", bytes: 10, approval_status: "rejected", conversation_id: "c1", message_id: null, prompt: "no", provider: "stub", model: "x", notes: null, created_at: D, decided_at: D },
    ],
    media_library: [{ id: "md1", kind: "clip", title: "fire escape take 2", description: "one take", key: "library/md1.mp3", mime: "audio/mpeg", bytes: 100, sha256: "aa", status: "active", created_at: D }],
    settings: [{ key: "provider", value: JSON.stringify("stub"), updated_at: D }],
  };
}

const KEYS = ["constitutionVersion", "adaptations", "fixedCanon", "avelieFacts", "opinions", "history", "life", "unknowns", "relationship", "scene", "images", "mediaTitles", "promptPrefixSha256"];

test("exportCharacterJson: every key of SPEC_V2 section Z", async () => {
  const pkg = await exportCharacterJson(fakeDb(tables()), secretEnv());
  for (const k of KEYS) assert.ok(k in pkg, "missing " + k + " (have " + Object.keys(pkg).join(", ") + ")");
  assert.equal(pkg.constitutionVersion, CONSTITUTION_VERSION);
  assert.ok(Array.isArray(pkg.adaptations) && pkg.adaptations.length > 50);
});

test("exportCharacterJson: the prefix hash is sha256 of the stable prefix, and that prefix never names him", async () => {
  const pkg = await exportCharacterJson(fakeDb(tables()), secretEnv());
  const prefix = stablePrefix();
  assert.ok(!prefix.includes("Justin"), "the hashed input must not carry his name");
  assert.equal(pkg.promptPrefixSha256, createHash("sha256").update(prefix, "utf8").digest("hex"));
  assert.match(pkg.promptPrefixSha256, /^[0-9a-f]{64}$/);
});

test("exportCharacterJson: approved rows only; opinions separated from plain facts; images carry hashes, not bytes", async () => {
  const pkg = await exportCharacterJson(fakeDb(tables()), secretEnv());
  const text = JSON.stringify(pkg);
  assert.ok(text.includes("she keeps a plant alive out of spite"));
  assert.ok(text.includes("the bridge is the only honest part"));
  assert.ok(!text.includes("superseded and gone"));
  assert.ok(JSON.stringify(pkg.opinions).includes("opinion: his song Exits"));
  assert.ok(!JSON.stringify(pkg.avelieFacts).includes("opinion: his song Exits"), "an opinion is not also a plain fact");
  assert.ok(JSON.stringify(pkg.images).includes("abcd"), "approved image hash present");
  assert.ok(!JSON.stringify(pkg.images).includes("ef01"), "rejected image absent");
  assert.ok(JSON.stringify(pkg.mediaTitles).includes("fire escape take 2"));
  assert.ok(!text.includes("library/md1.mp3"), "storage keys are not part of the package");
  assert.ok(JSON.stringify(pkg.life).includes("Dana"));
  assert.ok(!JSON.stringify(pkg.life).includes("dropped arc"));
  assert.ok(JSON.stringify(pkg.unknowns).includes("where she grew up"));
  assert.ok(text.includes("She is 22."));
});

test("exportCharacterJson: no secret, no key material, no settings", async () => {
  const pkg = await exportCharacterJson(fakeDb(tables()), secretEnv());
  const text = JSON.stringify(pkg);
  for (const s of SECRET_VALUES) assert.ok(!text.includes(s), "leaked " + s);
  assert.ok(!text.includes("sk-"));
  assert.ok(!("settings" in pkg));
  assert.ok(!text.includes("ANTHROPIC_API_KEY"));
});

test("exportCharacterMarkdown: a readable bible with headings, the same content, no secrets, clean typography", async () => {
  const md = await exportCharacterMarkdown(fakeDb(tables()), secretEnv());
  assert.equal(typeof md, "string");
  assert.ok(/^# /m.test(md), "a top heading");
  assert.ok((md.match(/^#{1,3} /gm) || []).length >= 6, "one heading per section");
  for (const needle of ["She is 22.", "she keeps a plant alive out of spite", "the bridge is the only honest part", "the bench", "Dana", "where she grew up", "fire escape take 2"]) {
    assert.ok(md.includes(needle), "missing " + needle);
  }
  for (const s of SECRET_VALUES) assert.ok(!md.includes(s), "leaked " + s);
  assert.ok(!md.includes("sk-"));
  assert.ok(!BAD_TYPOGRAPHY.test(md));
  assert.ok(md.includes(CONSTITUTION_VERSION));
});

test("both exports work on an empty record", async () => {
  const db = fakeDb({
    facts: [], history: [], unknowns: [], life_threads: [], life_log: [], visual_assets: [], media_library: [],
    state_versions: [
      { id: "s1", entity: "relationship", version: 1, state_json: JSON.stringify(relationshipState()), source: "seed", note: null, created_at: D },
      { id: "s2", entity: "scene", version: 1, state_json: JSON.stringify(sceneState()), source: "seed", note: null, created_at: D },
    ],
  });
  const pkg = await exportCharacterJson(db, secretEnv());
  assert.deepEqual(pkg.avelieFacts, []);
  const md = await exportCharacterMarkdown(db, secretEnv());
  assert.ok(md.length > 100);
});
