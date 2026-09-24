// The fine-tune pipeline (SPEC_V3 section II): the JSONL line shape, the compact and full
// system, the strip transform, the chained hash, and the Mac script's validator, its
// --verify and its refusal to start without the word.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { loadSrc } from "./helpers.mjs";
import { loadSrcIfPresent, firstExport, settingsV3 } from "./helpers_v3.mjs";

const finetune = await loadSrcIfPresent("finetune");
const prompt = await loadSrc("prompt");
const { ALWAYS_ON, OVERLAY } = await loadSrc("generated/constitution");
const script = await import("../../scripts/finetune_run.mjs");
const S = settingsV3();

const STATE = [
  "FIXED CANON (unchangeable)\n- name: Her name is Avelie, pronounced Av-el-lee.",
  "THINGS TRUE ABOUT YOU\nYou know these about yourself.",
  "WHAT YOU KNOW ABOUT HIM (only what he told you in conversation; nothing else exists)\n- his dog is called biscuit",
  "THINGS YOU HALF REMEMBER (real, but the detail is fuzzy in your memory)\n- his cousin plays drums (you think)",
  "SHARED HISTORY (only what actually happened between you two; add nothing)\n### the first talk\nthey talked",
  "CURRENT STATE\nRelationship: " + JSON.stringify({ status: "talking", summary: "they talk most days", trust: "some", affection: "some", attraction: "some", friction: "none", private_language: "the biscuit thing", his_name: "Justin", nicknames: "J", frontier: "x" }) + "\nScene: {\"status\":\"none\"}",
  "MODE: apart\nYou are texting from wherever your day has you.",
].join("\n\n" + "-".repeat(60) + "\n\n");

// ------------------------------------------------------------------ the module (pure parts)

test("the strip transform removes the two sections and the four keys of the Relationship line, and nothing else", (tc) => {
  const f = firstExport(finetune, ["stripHimState", "stripHim", "stripState", "leaveHimOut"]);
  if (!f.fn) {
    tc.skip("finetune.ts exports no strip transform (tried stripHimState, stripHim, stripState, leaveHimOut)");
    return;
  }
  const out = f.fn(STATE);
  assert.ok(!out.includes("WHAT YOU KNOW ABOUT HIM"), "the facts about him are gone");
  assert.ok(!out.includes("THINGS YOU HALF REMEMBER"), "the half-remembered detail is gone");
  assert.ok(!out.includes("biscuit\n") && !out.includes("- his dog"), "his fact text is gone");
  const rel = /Relationship: (\{.*\})/.exec(out);
  assert.ok(rel, "the Relationship line stays");
  const obj = JSON.parse(rel[1]);
  for (const k of ["his_name", "nicknames", "private_language", "summary"]) assert.ok(!(k in obj), k + " removed");
  assert.equal(obj.status, "talking");
  assert.ok(out.includes("FIXED CANON (unchangeable)\n- name: Her name is Avelie, pronounced Av-el-lee."), "other sections byte-identical");
  assert.ok(out.includes("SHARED HISTORY (only what actually happened between you two; add nothing)\n### the first talk\nthey talked"));
  assert.ok(out.includes("MODE: apart\nYou are texting from wherever your day has you."));
  assert.ok(!out.includes("Justin"));
});

test("the JSONL line: system, user, assistant; compact system is ALWAYS_ON + OVERLAY + state, full is the stable prefix + state", (tc) => {
  const line = firstExport(finetune, ["trainingLine", "jsonlLine", "exportLine", "toLine"]);
  const sys = firstExport(finetune, ["systemFor", "systemText", "trainingSystem", "exportSystem"]);
  if (!line.fn && !sys.fn) {
    tc.skip("finetune.ts exports no line or system builder (tried trainingLine, jsonlLine, exportLine, toLine; systemFor, systemText, trainingSystem, exportSystem)");
    return;
  }
  const ex = { userMessageId: "m1", assistantMessageId: "m2", user: "hey", assistant: "hey yourself", stateText: STATE, promptVersion: "v-p5", source: "keep" };
  if (sys.fn) {
    const compact = sys.fn(ex.stateText, "compact");
    assert.ok(compact.startsWith(ALWAYS_ON.split("\n")[0]));
    assert.ok(compact.includes(OVERLAY.slice(0, 40)));
    assert.ok(compact.endsWith(STATE));
    assert.ok(!compact.includes("REFERENCE: CORE IDENTITY"));
    const full = sys.fn(ex.stateText, "full");
    assert.ok(full.startsWith(prompt.stablePrefix()));
    assert.ok(full.endsWith(STATE));
  }
  if (line.fn) {
    const raw = line.fn(ex, sys.fn ? sys.fn(ex.stateText, "compact") : "SYSTEM");
    const obj = JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw));
    assert.deepEqual(obj.messages.map((m) => m.role), ["system", "user", "assistant"]);
    assert.equal(obj.messages[1].content, "hey");
    assert.equal(obj.messages[2].content, "hey yourself");
    assert.ok(!JSON.stringify(obj).includes("m1"), "no ids in the line");
  }
});

test("the chained hash: sha256 of each line, then sha256 of those joined by newline", (tc) => {
  const f = firstExport(finetune, ["chainHash", "chainedHash", "chainOf", "hashChain"]);
  if (!f.fn) {
    tc.skip("finetune.ts exports no chain helper (tried chainHash, chainedHash, chainOf, hashChain)");
    return;
  }
  const lines = ['{"a":1}', '{"b":2}'];
  const hashes = lines.map((l) => createHash("sha256").update(l).digest("hex"));
  const expected = createHash("sha256").update(hashes.join("\n")).digest("hex");
  const r = f.fn(hashes.length === 2 && f.name === "chainHash" ? hashes : lines);
  const got = typeof r === "string" ? r : r && typeof r === "object" ? r.sha256 : null;
  assert.equal(got, expected);
});

// ------------------------------------------------------------------ the Mac script

const goodLine = (i) => JSON.stringify({ messages: [{ role: "system", content: "SYS " + i }, { role: "user", content: "hey " + i }, { role: "assistant", content: "hi " + i }] });
const goodFile = Array.from({ length: 12 }, (_, i) => goodLine(i)).join("\n") + "\n";

test("script validator: a good file passes with the count and a token estimate", () => {
  const v = script.validateJsonl(goodFile);
  assert.equal(v.ok, true, v.errors.join("; "));
  assert.equal(v.count, 12);
  assert.ok(v.tokens > 0);
  assert.equal(v.lines.length, 12);
});

test("script validator: four bad files are refused with the line named", () => {
  const notJson = goodFile + "not json\n";
  const wrongOrder = goodFile + JSON.stringify({ messages: [{ role: "user", content: "x" }, { role: "system", content: "y" }, { role: "assistant", content: "z" }] }) + "\n";
  const empty = goodFile + JSON.stringify({ messages: [{ role: "system", content: "s" }, { role: "user", content: "  " }, { role: "assistant", content: "z" }] }) + "\n";
  const tooFew = Array.from({ length: 9 }, (_, i) => goodLine(i)).join("\n") + "\n";
  for (const [name, text, re] of [["not JSON", notJson, /line 13: not JSON/], ["wrong order", wrongOrder, /line 13: message 1 must have role system/], ["empty content", empty, /line 13: user content is empty/], ["too few", tooFew, /at least 10/]]) {
    const v = script.validateJsonl(text);
    assert.equal(v.ok, false, name);
    assert.ok(v.errors.some((e) => re.test(e)), name + ": " + v.errors.join("; "));
  }
});

test("script --verify: a matching record passes and a tampered file fails", () => {
  const v = script.validateJsonl(goodFile);
  const chain = script.chainOf(v.lines);
  const sidecar = { count: 12, lineHashes: chain.lineHashes, sha256: chain.sha256 };
  assert.deepEqual(script.verifyChain(v.lines, sidecar), { ok: true, reason: null });
  const tampered = [...v.lines];
  tampered[3] = tampered[3].replace("hi 3", "hi 3!");
  const r = script.verifyChain(tampered, sidecar);
  assert.equal(r.ok, false);
  assert.ok(/line 4/.test(r.reason), r.reason);
  const short = script.verifyChain(v.lines.slice(0, 11), sidecar);
  assert.equal(short.ok, false);
});

test("script: the word is train and nothing else; a stream that says no does not start", async () => {
  assert.equal(script.isTheWord("train"), true);
  assert.equal(script.isTheWord("  TRAIN \n"), true);
  for (const w of ["no", "yes", "trains", "", "t"]) assert.equal(script.isTheWord(w), false, w);
  const no = await script.askToTrain(Readable.from(["no\n"]), { write() {} });
  assert.equal(no, false);
  const closed = await script.askToTrain(Readable.from([]), { write() {} });
  assert.equal(closed, false);
  const yes = await script.askToTrain(Readable.from(["train\n"]), { write() {} });
  assert.equal(yes, true);
});

test("script: the cost estimate and the argument parser defaults (gpt-4.1-mini, the owner's answer)", () => {
  assert.equal(script.estimateCostUsd(1_000_000, 3, 5), 15);
  const a = script.parseArgs(["file.jsonl"]);
  assert.equal(a.base, "gpt-4.1-mini-2025-04-14");
  assert.equal(a.suffix, "avelie");
  assert.equal(a.epochs, "auto");
  assert.equal(a.dryRun, false);
  const b = script.parseArgs(["file.jsonl", "--epochs", "2", "--dry-run", "--verify", "rec.json", "--price-per-mtok", "3"]);
  assert.equal(b.epochs, 2);
  assert.equal(b.dryRun, true);
  assert.equal(b.verify, "rec.json");
  assert.equal(b.pricePerMTok, 3);
  assert.throws(() => script.parseArgs(["--nope"]));
  assert.throws(() => script.parseArgs(["f", "--epochs", "0"]));
});

test("script: the source never prints, logs or writes the key", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../scripts/finetune_run.mjs", import.meta.url), "utf8");
  assert.ok(!/\$\{key\}/.test(src), "the key variable is never interpolated");
  assert.ok(!/console\.\w+\([^)]*[,(]\s*key\s*[,)]/.test(src), "no console line carries the key variable");
  assert.ok(!/writeFileSync\([^)]*\bkey\b/.test(src));
  assert.ok(/pbcopy/.test(src) && /pbpaste/.test(src), "clipboard in, clipboard cleared");
  assert.ok(/type train to start/.test(src));
  assert.equal(S.finetuneSystemMode, "compact");
});
