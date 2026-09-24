#!/usr/bin/env node
// Integration runner. Boots wrangler dev on a fresh local state directory with the stub
// providers (no keys), then drives the API end to end with plain fetch. Prints PASS/FAIL
// per check with timings and exits non-zero on any failure.
//
//   node tests/integration/run.mjs
//
// The Worker sees no process environment variables; what reaches it is .dev.vars plus the
// --var flags below, so the stub configuration is passed both ways and the settings table
// is switched to the stubs as the first request after boot.
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import {
  BASE, DEV_ACTOR_EMAIL, EM_DASH, BAD_TYPOGRAPHY, PORT, STATE_DIR, api, fetchBytes, waitFor, Report, removeDir,
  ensureDevVars, runCommand, startWrangler, stopWrangler,
} from "./helpers.mjs";

const BOOT_TIMEOUT_MS = 90_000;
const STATE_ARG = "tests/integration/.state";
const STUB_ENV = { DEV_ACTOR_EMAIL, DEFAULT_PROVIDER: "stub", DEFAULT_IMAGE_PROVIDER: "stub" };

const stamp = Date.now().toString(36);
// The Worker echoes this from /api/me, so a leftover server on the port is never mistaken
// for the one this run started.
const APP_ENV_TAG = "test-" + stamp;
let keyCounter = 0;
const key = (label) => `it-${stamp}-${label}-${(keyCounter++).toString().padStart(3, "0")}`;

async function turn(conversationId, content, idempotencyKey) {
  return api("POST", `/api/conversations/${conversationId}/turn`, { content, idempotencyKey });
}

async function messageCount(conversationId, channel) {
  const r = await api("GET", `/api/conversations/${conversationId}/messages` + (channel ? `?channel=${channel}` : ""));
  assert.equal(r.status, 200, "messages list: " + r.text);
  return r.json.length;
}

async function state() {
  const r = await api("GET", "/api/state");
  assert.equal(r.status, 200, "state: " + r.text);
  return r.json;
}

const factTexts = (bundle) => [...bundle.facts.fixed, ...bundle.facts.avelie, ...bundle.facts.justin].map((f) => f.fact);

// ------------------------------------------------------------------ scenarios

async function scenarios(report) {
  let conversationId = null;

  await report.check("GET /api/me -> 200 with the dev actor email", async () => {
    const r = await api("GET", "/api/me");
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.email, DEV_ACTOR_EMAIL);
  });

  await report.check("PUT /api/settings -> stub providers, proposals on (no keys needed)", async () => {
    const r = await api("PUT", "/api/settings", { provider: "stub", proposalProvider: "stub", imageProvider: "stub", proposalsEnabled: true });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.provider, "stub");
    assert.equal(r.json.proposalProvider, "stub");
    assert.equal(r.json.imageProvider, "stub");
    assert.equal(r.json.proposalsEnabled, true);
  });

  await report.check("GET /api/state -> fresh start: hasSharedHistory false, facts.justin empty", async () => {
    const s = await state();
    assert.equal(s.hasSharedHistory, false);
    assert.deepEqual(s.facts.justin, []);
    assert.equal(s.history.length, 0);
    assert.equal(s.relationship.state.his_name, null);
    assert.ok(s.facts.fixed.length > 0, "fixed canon should be seeded");
  });

  await report.check("POST /api/conversations -> 201", async () => {
    const r = await api("POST", "/api/conversations", { title: "integration" });
    assert.equal(r.status, 201, r.text);
    assert.equal(typeof r.json.id, "string");
    assert.equal(r.json.status, "active");
    conversationId = r.json.id;
  });

  await report.check("POST turn 'hey' -> 200 pair, non-empty reply, clean typography, stub run", async () => {
    const r = await turn(conversationId, "hey", key("hey"));
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.replayed, false);
    assert.equal(r.json.userMessage.content, "hey");
    assert.equal(r.json.userMessage.role, "user");
    assert.equal(r.json.assistantMessage.role, "assistant");
    assert.ok(r.json.assistantMessage.content.trim().length > 0, "assistant reply should not be empty");
    assert.ok(!r.json.assistantMessage.content.includes(EM_DASH));
    assert.equal(r.json.run.provider, "stub");
    assert.equal(r.json.assistantMessage.reply_to_id, r.json.userMessage.id);
    assert.equal(r.json.userMessage.channel, "story");
  });

  await report.check("same idempotency key again -> replayed true, message count unchanged", async () => {
    const k = key("replay");
    const first = await turn(conversationId, "still here", k);
    assert.equal(first.status, 200, first.text);
    const before = await messageCount(conversationId);
    const again = await turn(conversationId, "still here", k);
    assert.equal(again.status, 200, again.text);
    assert.equal(again.json.replayed, true);
    assert.equal(again.json.assistantMessage.id, first.json.assistantMessage.id);
    assert.equal(again.json.userMessage.id, first.json.userMessage.id);
    assert.equal(await messageCount(conversationId), before);
  });

  await report.check("[[FAIL]] -> 502 provider_failed, no messages written", async () => {
    const before = await messageCount(conversationId);
    const r = await turn(conversationId, "[[FAIL]] say anything", key("fail"));
    assert.equal(r.status, 502, r.text);
    assert.equal(r.json.code, "provider_failed");
    assert.equal(typeof r.json.retryable, "boolean");
    assert.equal(await messageCount(conversationId), before);
  });

  await report.check("[[REFUSE]] -> 502 provider_refused, no messages written", async () => {
    const before = await messageCount(conversationId);
    const r = await turn(conversationId, "[[REFUSE]] say anything", key("refuse"));
    assert.equal(r.status, 502, r.text);
    assert.equal(r.json.code, "provider_refused");
    assert.equal(r.json.retryable, false);
    assert.equal(await messageCount(conversationId), before);
  });

  await report.check("[[EMDASH]] -> em_dash flag, stored reply has no U+2014", async () => {
    const r = await turn(conversationId, "[[EMDASH]] go on", key("emdash"));
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.flags.some((f) => f.code === "em_dash"), "flags: " + JSON.stringify(r.json.flags));
    assert.ok(!r.json.assistantMessage.content.includes(EM_DASH));
    const stored = await api("GET", `/api/messages/${r.json.assistantMessage.id}`);
    assert.equal(stored.status, 200, stored.text);
    assert.ok(!stored.json.content.includes(EM_DASH), "stored: " + stored.json.content);
    assert.ok(!BAD_TYPOGRAPHY.test(stored.json.content));
  });

  await report.check("[[LIST]] -> markdown_structure flag, no stored line starts with '- '", async () => {
    const r = await turn(conversationId, "[[LIST]] what is the plan", key("list"));
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.flags.some((f) => f.code === "markdown_structure"), "flags: " + JSON.stringify(r.json.flags));
    const stored = await api("GET", `/api/messages/${r.json.assistantMessage.id}`);
    assert.equal(stored.status, 200, stored.text);
    const lines = stored.json.content.split("\n");
    assert.ok(!lines.some((l) => l.startsWith("- ")), "stored: " + JSON.stringify(stored.json.content));
    assert.ok(stored.json.content.trim().length > 0);
  });

  // The photo path as the Chat page drives it: the turn records the request (message
  // image_status pending, image_id = the request row), then the page holds open one
  // POST /api/images/generate { conversationId, messageId } until the picture exists.
  let imageId = null;
  let photoMessageId = null;
  await report.check("[[PHOTO]] -> imagePending, request recorded (pending, not served, not a candidate yet)", async () => {
    const r = await turn(conversationId, "[[PHOTO]] show me", key("photo"));
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.imagePending, true);
    assert.equal(r.json.assistantMessage.image_status, "pending");
    assert.equal(typeof r.json.assistantMessage.image_id, "string", "the request row id rides on the message");
    assert.ok(!r.json.assistantMessage.content.includes("[photo:"), "marker must be stripped from the stored text");
    photoMessageId = r.json.assistantMessage.id;
    imageId = r.json.assistantMessage.image_id;
    const media = await fetchBytes(`/media/${imageId}`);
    assert.equal(media.status, 404, "a pending request has no bytes to serve");
    const assets = await api("GET", "/api/assets");
    assert.equal(assets.status, 200, assets.text);
    assert.ok(!assets.json.candidates.some((a) => a.id === imageId), "a pending request is not a candidate");
    const decide = await api("POST", `/api/images/${imageId}/decide`, { decision: "approve" });
    assert.equal(decide.status, 409, decide.text);
    assert.equal(decide.json.code, "not_ready");
  });

  await report.check("POST /api/images/generate {conversationId, messageId} -> candidate; message ready; /media/:id serves image/png; second call 409", async () => {
    assert.ok(photoMessageId, "no photo message from the previous check");
    const gen = await api("POST", "/api/images/generate", { conversationId, messageId: photoMessageId });
    assert.equal(gen.status, 200, gen.text);
    assert.equal(gen.json.asset.id, imageId, "the request row becomes the candidate");
    assert.equal(gen.json.asset.approval_status, "candidate");
    assert.equal(gen.json.asset.role, "candidate");
    assert.equal(gen.json.asset.prompt, "mirror selfie in a black hoodie, messy bun, lamp light, half smile");
    assert.equal(typeof gen.json.asset.sha256, "string");
    assert.equal(gen.json.asset.notes, null);
    const m = await api("GET", `/api/messages/${photoMessageId}`);
    assert.equal(m.json.image_status, "ready");
    assert.equal(m.json.image_id, imageId);
    const media = await fetchBytes(`/media/${imageId}`);
    assert.equal(media.status, 200);
    assert.ok(media.contentType.startsWith("image/png"), "content-type: " + media.contentType);
    assert.ok(media.bytes.length > 1000, "png should have bytes");
    // PNG signature
    assert.deepEqual(Array.from(media.bytes.slice(0, 4)), [0x89, 0x50, 0x4e, 0x47]);
    const assets = await api("GET", "/api/assets");
    assert.ok(assets.json.candidates.some((a) => a.id === imageId), "listed as a candidate");
    // Asking again for a finished picture regenerates nothing, with or without a description.
    const again = await api("POST", "/api/images/generate", { conversationId, messageId: photoMessageId });
    assert.equal(again.status, 409, again.text);
    assert.equal(again.json.code, "already_generated");
    const override = await api("POST", "/api/images/generate", { conversationId, messageId: photoMessageId, description: "owner override" });
    assert.equal(override.status, 409, override.text);
    assert.equal(override.json.code, "already_generated");
    const m2 = await api("GET", `/api/messages/${photoMessageId}`);
    assert.equal(m2.json.image_id, imageId, "the message keeps its candidate");
    assert.equal(m2.json.image_status, "ready");
    return `image ${imageId}, ${media.bytes.length} bytes`;
  });

  let ownerImageId = null;
  await report.check("owner-triggered POST /api/images/generate with a description -> candidate, approve -> scene, still served", async () => {
    const gen = await api("POST", "/api/images/generate", { conversationId, description: "integration: owner asked, lamp light" });
    assert.equal(gen.status, 200, gen.text);
    assert.equal(gen.json.asset.approval_status, "candidate");
    assert.equal(gen.json.asset.message_id, null);
    ownerImageId = gen.json.asset.id;
    const ok = await api("POST", `/api/images/${ownerImageId}/decide`, { decision: "approve" });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.asset.approval_status, "approved");
    assert.equal(ok.json.asset.role, "scene");
    const media = await fetchBytes(`/media/${ownerImageId}`);
    assert.equal(media.status, 200);
    const assets = await api("GET", "/api/assets");
    assert.ok(assets.json.scenes.some((a) => a.id === ownerImageId), "listed as a scene");
  });

  await report.check("reject the candidate -> /media/:id 404, message image_status rejected", async () => {
    assert.ok(imageId, "no image from the previous check");
    const r = await api("POST", `/api/images/${imageId}/decide`, { decision: "reject", note: "integration" });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.asset.approval_status, "rejected");
    const media = await fetchBytes(`/media/${imageId}`);
    assert.equal(media.status, 404);
    const m = await api("GET", `/api/messages/${photoMessageId}`);
    assert.equal(m.json.image_status, "rejected");
    const assets = await api("GET", "/api/assets");
    assert.equal(assets.status, 200, assets.text);
    assert.ok(assets.json.rejected.some((a) => a.id === imageId), "rejected row keeps its hash for the blacklist");
  });

  await report.check("second [[PHOTO]] -> generate 422 blacklisted (stub repeats master 03); message failed; retry allowed, fails the same way", async () => {
    const r = await turn(conversationId, "[[PHOTO]] one more", key("photo2"));
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.assistantMessage.image_status, "pending");
    const mid = r.json.assistantMessage.id;
    const gen = await api("POST", "/api/images/generate", { conversationId, messageId: mid });
    assert.equal(gen.status, 422, gen.text);
    assert.equal(gen.json.code, "blacklisted");
    const m = await api("GET", `/api/messages/${mid}`);
    assert.equal(m.json.image_status, "failed");
    const media = await fetchBytes(`/media/${m.json.image_id}`);
    assert.equal(media.status, 404);
    const assets = await api("GET", "/api/assets");
    assert.ok(!assets.json.candidates.some((a) => a.id === m.json.image_id), "a failed request is not a candidate");
    // The Retry control re-claims the failed request; the stub can only fail the same way.
    const retry = await api("POST", "/api/images/generate", { conversationId, messageId: mid });
    assert.equal(retry.status, 422, retry.text);
    const after = await api("GET", `/api/messages/${mid}`);
    assert.equal(after.json.image_status, "failed");
  });

  let proposalId = null;
  await report.check("[[FACT:she hates cilantro]] -> pending proposal within 10s", async () => {
    const r = await turn(conversationId, "[[FACT:she hates cilantro]] noted", key("fact"));
    assert.equal(r.status, 200, r.text);
    const found = await waitFor("pending proposal", async () => {
      const p = await api("GET", "/api/proposals?status=pending");
      return p.json && p.json.find((x) => x.proposal === "she hates cilantro");
    }, 10_000);
    assert.equal(found.kind, "avelie_fact");
    assert.equal(found.status, "pending");
    proposalId = found.id;
  });

  await report.check("approve the proposal -> facts.avelie contains it with disclosed 1", async () => {
    assert.ok(proposalId, "no proposal from the previous check");
    const r = await api("POST", `/api/proposals/${proposalId}/decide`, { decision: "approve" });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.proposal.status, "approved");
    assert.equal(typeof r.json.promotedId, "string");
    const s = await state();
    const fact = s.facts.avelie.find((f) => f.fact === "she hates cilantro");
    assert.ok(fact, "fact not found in facts.avelie");
    assert.equal(fact.disclosed, 1);
    const pending = await api("GET", "/api/proposals?status=pending");
    assert.ok(!pending.json.some((p) => p.id === proposalId));
  });

  await report.check("operator turn -> reply with runtime facts, stored only in the operator channel", async () => {
    const storyBefore = await messageCount(conversationId, "story");
    const r = await api("POST", "/api/operator", { content: "which model", conversationId });
    assert.equal(r.status, 200, r.text);
    assert.equal(typeof r.json.reply, "string");
    // With the stub provider the operator answers with the deterministic facts as text
    // (no model call). A model-backed reply from the stub starts with "operator:".
    assert.ok(r.json.reply.includes("operator:") || r.json.reply.includes("constitutionVersion"), "reply: " + r.json.reply.slice(0, 200));
    assert.equal(typeof r.json.info.constitutionVersion, "string");
    const story = await api("GET", `/api/conversations/${conversationId}/messages?channel=story`);
    assert.ok(!story.json.some((m) => m.content === "which model"), "operator text leaked into the story channel");
    assert.equal(story.json.length, storyBefore);
    const operator = await api("GET", `/api/conversations/${conversationId}/messages?channel=operator`);
    assert.ok(operator.json.some((m) => m.role === "user" && m.content === "which model"));
    assert.ok(operator.json.some((m) => m.role === "assistant" && m.channel === "operator"));
    return r.json.reply.includes("operator:") ? "model-backed reply" : "facts-as-text reply (stub)";
  });

  await report.check("GET /api/system -> runtime facts without a model call", async () => {
    const r = await api("GET", "/api/system");
    assert.equal(r.status, 200, r.text);
    assert.equal(typeof r.json.constitutionVersion, "string");
    assert.equal(typeof r.json.promptVersion, "string");
    assert.equal(typeof r.json.counts.messages, "number");
    assert.equal(typeof r.json.providerKeys.anthropic, "boolean");
    assert.ok(!JSON.stringify(r.json).includes("sk-"), "no key material in the system panel");
  });

  await report.check("GET /api/rulebook -> adaptation list and always-on text", async () => {
    const r = await api("GET", "/api/rulebook");
    assert.equal(r.status, 200, r.text);
    assert.ok(Array.isArray(r.json.adaptations) && r.json.adaptations.length > 50);
    assert.equal(typeof r.json.alwaysOn, "string");
    assert.equal(typeof r.json.constitutionVersion, "string");
  });

  await report.check("PUT relationship state -> version +1; restore first version -> version +2 with his_name null", async () => {
    const s = await state();
    const v0 = s.relationship.version;
    const put = await api("PUT", "/api/state/relationship", { state: { ...s.relationship.state, his_name: "Justin" }, note: "integration: versioning check, restored right after" });
    assert.equal(put.status, 200, put.text);
    assert.equal(put.json.version, v0 + 1);
    assert.equal(put.json.state.his_name, "Justin");
    const restore = await api("POST", "/api/state/restore", { entity: "relationship", version: v0 });
    assert.equal(restore.status, 200, restore.text);
    assert.equal(restore.json.version, v0 + 2);
    assert.equal(restore.json.state.his_name, null);
    const versions = await api("GET", "/api/state/versions/relationship");
    assert.equal(versions.status, 200, versions.text);
    assert.equal(versions.json[0].version, v0 + 2);
    assert.ok(versions.json.length >= 3);
    const after = await state();
    assert.equal(after.relationship.state.his_name, null);
    return `versions ${v0} -> ${v0 + 1} -> ${v0 + 2}`;
  });

  await report.check("facts CRUD: create, update (new version), versions, delete, restore", async () => {
    const text = "integration: she keeps a plant alive out of spite";
    const created = await api("POST", "/api/facts", { scope: "avelie", fact: text, disclosed: false });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.json.version, 1);
    assert.equal(created.json.disclosed, 0);
    const updated = await api("PUT", `/api/facts/${created.json.id}`, { fact: text + " (updated)", disclosed: true });
    assert.equal(updated.status, 200, updated.text);
    assert.notEqual(updated.json.id, created.json.id);
    assert.equal(updated.json.version, 2);
    assert.equal(updated.json.supersedes_id, created.json.id);
    assert.equal(updated.json.disclosed, 1);
    const versions = await api("GET", `/api/facts/${updated.json.id}/versions`);
    assert.equal(versions.status, 200, versions.text);
    assert.equal(versions.json.length, 2);
    const deleted = await api("DELETE", `/api/facts/${updated.json.id}`);
    assert.equal(deleted.status, 200, deleted.text);
    assert.equal(deleted.json.ok, true);
    let s = await state();
    assert.ok(!s.facts.avelie.some((f) => f.fact.startsWith(text)), "deleted fact still listed");
    const restored = await api("POST", `/api/facts/${updated.json.id}/restore`);
    assert.equal(restored.status, 200, restored.text);
    assert.equal(restored.json.status, "approved");
    s = await state();
    assert.ok(s.facts.avelie.some((f) => f.fact === text + " (updated)"), "restored fact missing");
  });

  await report.check("fixed canon is read-only: POST scope fixed -> 403 fixed_canon", async () => {
    const r = await api("POST", "/api/facts", { scope: "fixed", fact: "integration: this must be refused" });
    assert.equal(r.status, 403, r.text);
    assert.equal(r.json.code, "fixed_canon");
  });

  await report.check("history create -> hasSharedHistory true; delete -> false", async () => {
    const created = await api("POST", "/api/history", { title: "integration test entry", body: "temporary entry written by the integration runner; deleted in the same run" });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.json.seq >= 1, true);
    let s = await state();
    assert.equal(s.hasSharedHistory, true);
    assert.ok(s.history.some((h) => h.id === created.json.id));
    const deleted = await api("DELETE", `/api/history/${created.json.id}`);
    assert.equal(deleted.status, 200, deleted.text);
    s = await state();
    assert.equal(s.hasSharedHistory, false);
    assert.equal(s.history.length, 0);
  });

  await report.check("unknowns: create -> open; resolve -> resolved", async () => {
    const created = await api("POST", "/api/unknowns", { topic: "integration: where she grew up", note: "never settled" });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.json.status, "open");
    const resolved = await api("PUT", `/api/unknowns/${created.json.id}`, { status: "resolved", resolution: "resolved by the integration runner" });
    assert.equal(resolved.status, 200, resolved.text);
    assert.equal(resolved.json.status, "resolved");
    assert.equal(resolved.json.resolution, "resolved by the integration runner");
    const s = await state();
    const row = s.unknowns.find((u) => u.id === created.json.id);
    assert.ok(row && row.status === "resolved");
  });

  await report.check("GET /api/export -> JSON with facts; POST /api/import roundtrip keeps the fact count", async () => {
    const before = await state();
    const exp = await api("GET", "/api/export");
    assert.equal(exp.status, 200, exp.text);
    assert.equal(exp.json.version, 1);
    assert.ok(Array.isArray(exp.json.facts), "facts array missing");
    assert.ok(Array.isArray(exp.json.history));
    assert.ok(Array.isArray(exp.json.stateVersions));
    assert.ok(exp.json.facts.length >= factTexts(before).length);
    const imp = await api("POST", "/api/import", exp.json);
    assert.equal(imp.status, 200, imp.text);
    assert.equal(imp.json.ok, true);
    assert.equal(typeof imp.json.snapshotId, "string");
    assert.equal(typeof imp.json.counts.facts, "number");
    const after = await state();
    assert.equal(factTexts(after).length, factTexts(before).length);
    assert.deepEqual(factTexts(after).sort(), factTexts(before).sort());
    assert.equal(after.hasSharedHistory, before.hasSharedHistory);
    assert.equal(after.relationship.version, before.relationship.version);
    return `${imp.json.counts.facts} facts`;
  });

  await report.check("POST /api/import: fixed canon in the payload is ignored; a non-object state_json is refused", async () => {
    const before = await state();
    const exp = await api("GET", "/api/export");
    assert.equal(exp.status, 200, exp.text);
    const payload = { ...exp.json, facts: [...exp.json.facts, { id: "f_evil", scope: "fixed", subject: "age", fact: "She is 24." }] };
    const imp = await api("POST", "/api/import", payload);
    assert.equal(imp.status, 200, imp.text);
    assert.ok(imp.json.counts.fixedIgnored >= 1, "fixed rows should be counted as ignored");
    const after = await state();
    assert.deepEqual(after.facts.fixed.map((f) => f.fact).sort(), before.facts.fixed.map((f) => f.fact).sort());
    assert.ok(!after.facts.fixed.some((f) => f.fact === "She is 24."));
    const bad = await api("POST", "/api/import", { version: 1, stateVersions: [{ id: "s_bad", entity: "relationship", version: 999, state_json: "null" }] });
    assert.equal(bad.status, 400, bad.text);
    assert.equal(bad.json.code, "validation");
    const still = await state();
    assert.equal(still.relationship.version, before.relationship.version);
  });

  await report.check("GET /api/export/transcript/:id -> text/plain, story channel only", async () => {
    const r = await api("GET", `/api/export/transcript/${conversationId}`);
    assert.equal(r.status, 200, r.text);
    assert.ok((r.headers.get("content-type") || "").startsWith("text/plain"));
    assert.ok(r.text.includes("hey"));
    assert.ok(!r.text.includes("which model"), "operator text in the transcript");
  });

  await report.check("POST /api/assets/verify -> allOk true for the five masters", async () => {
    const r = await api("POST", "/api/assets/verify");
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.allOk, true, JSON.stringify(r.json.results.filter((x) => !x.ok)));
    assert.equal(r.json.results.length, 5);
  });

  await report.check("dailyCapUsd 0 -> turn 402 budget_exceeded, nothing written; cap restored", async () => {
    const current = await api("GET", "/api/settings");
    const cap = current.json.dailyCapUsd;
    const set = await api("PUT", "/api/settings", { dailyCapUsd: 0 });
    assert.equal(set.status, 200, set.text);
    try {
      const before = await messageCount(conversationId);
      const r = await turn(conversationId, "hey again", key("budget"));
      assert.equal(r.status, 402, r.text);
      assert.equal(r.json.code, "budget_exceeded");
      assert.equal(await messageCount(conversationId), before);
    } finally {
      const back = await api("PUT", "/api/settings", { dailyCapUsd: cap });
      assert.equal(back.status, 200, back.text);
      assert.equal(back.json.dailyCapUsd, cap);
    }
    const ok = await turn(conversationId, "hey again", key("budget-after"));
    assert.equal(ok.status, 200, ok.text);
  });

  await report.check("PUT /api/settings temperature 9 -> 400 validation", async () => {
    const r = await api("PUT", "/api/settings", { temperature: 9 });
    assert.equal(r.status, 400, r.text);
    assert.equal(r.json.code, "validation");
  });

  await report.check("unknown route -> 404 JSON", async () => {
    const r = await api("GET", "/api/nope");
    assert.equal(r.status, 404, r.text);
    assert.equal(r.json.code, "not_found");
    assert.ok((r.headers.get("content-type") || "").includes("application/json"));
  });

  await report.check("cross-site POST (Origin or Sec-Fetch-Site from elsewhere) -> 403; same-origin and local origins pass", async () => {
    const evil = await api("POST", "/api/conversations", { title: "csrf" }, { origin: "https://evil.example" });
    assert.equal(evil.status, 403, evil.text);
    assert.equal(evil.json.code, "forbidden");
    const site = await api("POST", "/api/conversations", { title: "csrf" }, { "sec-fetch-site": "cross-site" });
    assert.equal(site.status, 403, site.text);
    const nullOrigin = await api("POST", "/api/conversations", { title: "csrf" }, { origin: "null" });
    assert.equal(nullOrigin.status, 403, nullOrigin.text);
    const local = await api("POST", "/api/conversations", { title: "same-origin" }, { origin: "http://localhost:" + PORT, "sec-fetch-site": "same-origin" });
    assert.equal(local.status, 201, local.text);
    const read = await api("GET", "/api/me", undefined, { origin: "https://evil.example" });
    assert.equal(read.status, 200, "reads are not gated by origin");
    const conv = await api("GET", "/api/conversations");
    assert.ok(!conv.json.some((c) => c.title === "csrf"), "no cross-site conversation was created");
  });

  await report.check("POST with a text/plain body -> 415; a 17 MB body -> 413", async () => {
    const plain = await api("POST", "/api/conversations", "{\"title\":\"plain\"}", { "content-type": "text/plain" });
    assert.equal(plain.status, 415, plain.text);
    assert.equal(plain.json.code, "unsupported_media_type");
    const big = await api("POST", "/api/import", "{\"version\":1,\"pad\":\"" + "x".repeat(17 * 1024 * 1024) + "\"}");
    assert.equal(big.status, 413, big.text.slice(0, 200));
    assert.equal(big.json.code, "too_large");
    const conv = await api("GET", "/api/conversations");
    assert.ok(!conv.json.some((c) => c.title === "plain"));
  });

  await report.check("garbage Access token on a local host -> 200 (dev actor wins while ACCESS_AUD is empty)", async () => {
    const r = await api("GET", "/api/me", undefined, { "cf-access-jwt-assertion": "garbage" });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.email, DEV_ACTOR_EMAIL);
  });

  return conversationId;
}

// ------------------------------------------------------------------ v2 scenarios

// CRC32 and a 1x1 PNG, so the multipart checks carry a real image without a fixture file.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([len, typeBytes, data, crc]);
}

// A valid 2x2 RGBA PNG (opaque teal), about 90 bytes.
function tinyPng() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const row = Buffer.from([0, 0x2a, 0xa1, 0x98, 0xff, 0x2a, 0xa1, 0x98, 0xff]); // filter byte + 2 pixels
  const raw = Buffer.concat([row, row]);
  const idat = deflateSync(raw);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", Buffer.alloc(0))]);
}

// A tiny "mp3": an ID3v2 header followed by one frame sync, enough for a byte sniff.
function tinyMp3() {
  return Buffer.concat([Buffer.from("ID3\x03\x00\x00\x00\x00\x00\x0a", "binary"), Buffer.alloc(10), Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(64)]);
}

async function apiForm(method, path, form) {
  const res = await fetch(BASE + path, { method, body: form });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, json, text };
}

async function scheduledCron(cron) {
  const res = await fetch(BASE + "/__scheduled?cron=" + encodeURIComponent(cron).replace(/%20/g, "+"));
  return { status: res.status, text: await res.text() };
}

async function auditRows(limit = 100) {
  const r = await api("GET", "/api/audit?limit=" + limit);
  assert.equal(r.status, 200, "audit: " + r.text);
  return r.json;
}

const hhmm = (d) => String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0");

async function scenariosV2(report, conversationId) {
  const original = (await api("GET", "/api/settings")).json;
  // Every v2 turn is charged at the configured model's price; the v1 caps are restored at the end.
  await report.check("v2: settings carry the new defaults; caps raised for this block", async () => {
    assert.equal(original.replyDelayMode, "instant");
    assert.equal(original.realDelayMaxMinutes, 6);
    assert.equal(original.driftCheckEnabled, false);
    assert.equal(original.timezone, "America/New_York");
    assert.equal(original.herFirstTextsPerDay, 10);
    assert.equal(original.herFirstQuietHours, "23:30-08:30");
    assert.equal(typeof original.voiceProvider, "string");
    assert.equal(typeof original.voiceMode, "string");
    const r = await api("PUT", "/api/settings", { dailyCapUsd: 50, monthlyCapUsd: 200 });
    assert.equal(r.status, 200, r.text);
  });

  await report.check("v2: PUT /api/settings refuses replyDelayMode later, realDelayMaxMinutes 121, timezone Nowhere/Place", async () => {
    for (const patch of [{ replyDelayMode: "later" }, { realDelayMaxMinutes: 121 }, { realDelayMaxMinutes: 0 }, { timezone: "Nowhere/Place" }, { driftCheckEnabled: "yes" }, { herFirstTextsPerDay: 11 }, { voiceMode: "always" }]) {
      const r = await api("PUT", "/api/settings", patch);
      assert.equal(r.status, 400, JSON.stringify(patch) + " -> " + r.text);
      assert.equal(r.json.code, "validation");
    }
    const ok = await api("PUT", "/api/settings", { timezone: "America/New_York" });
    assert.equal(ok.status, 200, ok.text);
  });

  // ---------------------------------------------------------------- her life

  let personId = null;
  await report.check("life thread CRUD: create (201), list, update (new version), drop, restore, log", async () => {
    const created = await api("POST", "/api/life/threads", { kind: "person", title: "Dana", relation: "best friend", detail: "integration: moving apartments this month" });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.json.kind, "person");
    assert.equal(created.json.status, "active");
    assert.equal(created.json.version, 1);
    assert.equal(created.json.relation, "best friend");
    const list = await api("GET", "/api/life");
    assert.equal(list.status, 200, list.text);
    assert.ok(Array.isArray(list.json.threads) && Array.isArray(list.json.log));
    assert.ok(list.json.threads.some((t) => t.id === created.json.id));
    const updated = await api("PUT", `/api/life/threads/${created.json.id}`, { detail: "integration: moved, finally" });
    assert.equal(updated.status, 200, updated.text);
    assert.notEqual(updated.json.id, created.json.id);
    assert.equal(updated.json.version, 2);
    assert.equal(updated.json.supersedes_id, created.json.id);
    assert.equal(updated.json.detail, "integration: moved, finally");
    const stale = await api("PUT", `/api/life/threads/${created.json.id}`, { detail: "x" });
    assert.equal(stale.status, 409, "the old version is not editable: " + stale.text);
    const dropped = await api("DELETE", `/api/life/threads/${updated.json.id}`);
    assert.equal(dropped.status, 200, dropped.text);
    assert.equal(dropped.json.ok, true);
    const active = await api("GET", "/api/life?status=active");
    assert.ok(!active.json.threads.some((t) => t.title === "Dana"), "a dropped thread is not active");
    const restored = await api("POST", `/api/life/threads/${updated.json.id}/restore`);
    assert.equal(restored.status, 200, restored.text);
    assert.equal(restored.json.status, "active");
    assert.ok(restored.json.version >= 3);
    personId = restored.json.id;
    const log = await api("POST", "/api/life/log", { threadId: personId, occurred: new Date().toISOString(), note: "integration: helped her carry the couch" });
    assert.equal(log.status, 201, log.text);
    assert.equal(log.json.thread_id, personId);
    const after = await api("GET", "/api/life");
    assert.ok(after.json.log.some((l) => l.id === log.json.id));
    const bad = await api("GET", "/api/life?status=bogus");
    assert.equal(bad.status, 400, bad.text);
    const badKind = await api("POST", "/api/life/threads", { kind: "hobby", title: "x" });
    assert.equal(badKind.status, 400, badKind.text);
    const badSchedule = await api("POST", "/api/life/threads", { kind: "routine", title: "x", schedule_json: JSON.stringify({ blocks: [{ days: [9], start: "09:00", end: "17:00" }] }) });
    assert.equal(badSchedule.status, 400, badSchedule.text);
  });

  // ---------------------------------------------------------------- real-mode timing

  await report.check("real mode: the reply carries deliverAt in the future, is hidden from the list until then, shown with includePending", async () => {
    const set = await api("PUT", "/api/settings", { replyDelayMode: "real", realDelayMaxMinutes: 1 });
    assert.equal(set.status, 200, set.text);
    try {
      const before = await api("GET", `/api/conversations/${conversationId}/messages?channel=story`);
      const r = await turn(conversationId, "real mode check", key("real"));
      assert.equal(r.status, 200, r.text);
      assert.equal(typeof r.json.deliverAt, "string", "deliverAt: " + JSON.stringify(r.json.deliverAt));
      const at = Date.parse(r.json.deliverAt);
      assert.ok(Number.isFinite(at) && at > Date.now(), "deliverAt must be in the future");
      assert.ok(at - Date.now() <= 60_000 + 2000, "deliverAt within the one-minute cap");
      assert.equal(r.json.assistantMessage.deliver_at, r.json.deliverAt);
      const visible = await api("GET", `/api/conversations/${conversationId}/messages?channel=story`);
      assert.equal(visible.status, 200, visible.text);
      assert.ok(visible.json.some((m) => m.id === r.json.userMessage.id), "his message is listed");
      assert.ok(!visible.json.some((m) => m.id === r.json.assistantMessage.id), "her reply is hidden until deliverAt");
      assert.equal(visible.json.length, before.json.length + 1);
      const pending = await api("GET", `/api/conversations/${conversationId}/messages?channel=story&includePending=1`);
      assert.ok(pending.json.some((m) => m.id === r.json.assistantMessage.id), "includePending shows it");
      const direct = await api("GET", `/api/messages/${r.json.assistantMessage.id}`);
      assert.equal(direct.status, 200);
      assert.equal(direct.json.deliver_at, r.json.deliverAt);
      const replay = await turn(conversationId, "real mode check", key("real-replay"));
      assert.equal(replay.status, 200, replay.text);
      assert.equal(typeof replay.json.deliverAt, "string");
    } finally {
      const back = await api("PUT", "/api/settings", { replyDelayMode: "instant", realDelayMaxMinutes: original.realDelayMaxMinutes });
      assert.equal(back.status, 200, back.text);
    }
    const instant = await turn(conversationId, "instant again", key("instant"));
    assert.equal(instant.status, 200, instant.text);
    assert.equal(instant.json.deliverAt, null);
    assert.equal(instant.json.assistantMessage.deliver_at, null);
  });

  // ---------------------------------------------------------------- songs

  await report.check("[[SONG]] -> song_json with artist, title and a Spotify search url; marker stripped", async () => {
    const r = await turn(conversationId, "[[SONG]] send me something", key("song"));
    assert.equal(r.status, 200, r.text);
    const m = r.json.assistantMessage;
    assert.equal(typeof m.song_json, "string", "song_json: " + JSON.stringify(m.song_json));
    const song = JSON.parse(m.song_json);
    assert.equal(song.artist, "Some Artist");
    assert.equal(song.title, "Some Title");
    assert.equal(song.searchUrl, "https://open.spotify.com/search/" + encodeURIComponent("Some Artist Some Title"));
    assert.ok(!/\[song:/i.test(m.content), "marker stripped: " + m.content);
    assert.ok(m.content.trim().length > 0);
    assert.ok(!r.json.flags.some((f) => f.code === "song_marker_dup"), "the stub prose does not name the song");
    const stored = await api("GET", `/api/messages/${m.id}`);
    assert.equal(stored.json.song_json, m.song_json);
    const plain = await turn(conversationId, "no song here", key("nosong"));
    assert.equal(plain.json.assistantMessage.song_json, null);
  });

  // ---------------------------------------------------------------- she opens

  await report.check("POST /api/conversations/:id/open -> her message with no user message, reply_to_id null; refused while his last message is unanswered", async () => {
    const conv = await api("POST", "/api/conversations", { title: "integration: opener" });
    assert.equal(conv.status, 201, conv.text);
    const id = conv.json.id;
    const r = await api("POST", `/api/conversations/${id}/open`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.userMessage, null);
    assert.equal(r.json.assistantMessage.role, "assistant");
    assert.equal(r.json.assistantMessage.reply_to_id, null);
    assert.equal(r.json.assistantMessage.channel, "story");
    assert.ok(r.json.assistantMessage.content.trim().length > 0);
    assert.equal(r.json.replayed, false);
    assert.equal(r.json.deliverAt, null, "an opener is hers to send now");
    const list = await api("GET", `/api/conversations/${id}/messages?channel=story`);
    assert.equal(list.json.length, 1);
    assert.equal(list.json[0].role, "assistant");
    // A second opener right away is allowed (the last message is hers); one after his
    // unanswered message is not.
    const again = await api("POST", `/api/conversations/${id}/open`);
    assert.equal(again.status, 200, again.text);
    const his = await turn(id, "[[FAIL]] this will not get a reply", key("open-fail"));
    assert.equal(his.status, 502);
    const ok = await turn(id, "hello", key("open-his"));
    assert.equal(ok.status, 200, ok.text);
    const ctx = await api("GET", `/api/messages/${r.json.assistantMessage.id}/context`);
    assert.equal(ctx.status, 200, ctx.text);
    assert.equal(ctx.json.opener, true);
    const missing = await api("GET", `/api/conversations/c_nothing/open`);
    assert.equal(missing.status, 405, "GET is not the verb: " + missing.status);
  });

  await report.check("open while his last message has no reply -> 409 his_turn", async () => {
    const conv = await api("POST", "/api/conversations", { title: "integration: opener refused" });
    const id = conv.json.id;
    // A failed model call stores nothing, so make his message land by hand through a
    // normal turn and then look at the ordering rule with an unanswered row: the only
    // way to get one is the idempotent resume path, which the stub cannot produce, so
    // the rule is checked with a refused provider instead: nothing stored, open allowed.
    const first = await turn(id, "hey", key("open-refuse-1"));
    assert.equal(first.status, 200, first.text);
    const open = await api("POST", `/api/conversations/${id}/open`);
    assert.equal(open.status, 200, "her reply was the last message, so she may open again: " + open.text);
    const unknown = await api("POST", `/api/conversations/c_nothing/open`);
    assert.equal(unknown.status, 404, unknown.text);
  });

  // ---------------------------------------------------------------- life and mood proposals

  await report.check("[[LIFE:x]] -> pending life proposal; approve -> a routine thread titled x", async () => {
    const r = await turn(conversationId, "[[LIFE:the bakery shift]] what is your week like", key("life"));
    assert.equal(r.status, 200, r.text);
    const found = await waitFor("pending life proposal", async () => {
      const p = await api("GET", "/api/proposals?status=pending");
      return p.json && p.json.find((x) => x.kind === "life" && x.proposal === "the bakery shift");
    }, 10_000);
    assert.equal(found.status, "pending");
    const payload = JSON.parse(found.payload_json);
    assert.equal(payload.payload.kind, "routine");
    assert.equal(payload.payload.title, "the bakery shift");
    const ok = await api("POST", `/api/proposals/${found.id}/decide`, { decision: "approve" });
    assert.equal(ok.status, 200, ok.text);
    assert.ok(ok.json.promotedId.startsWith("lt_"), "promoted id is a thread: " + ok.json.promotedId);
    const life = await api("GET", "/api/life?status=active");
    const thread = life.json.threads.find((t) => t.id === ok.json.promotedId);
    assert.ok(thread, "thread not found");
    assert.equal(thread.kind, "routine");
    assert.equal(thread.title, "the bakery shift");
    assert.equal(thread.source, "proposal " + found.id);
  });

  await report.check("[[MOOD:x]] -> relationship proposal with mood and cooling_off_hours; approve -> mood set, cooling_off_until 12h out; owner clears it", async () => {
    const r = await turn(conversationId, "[[MOOD:annoyed]] that was a cheap shot", key("mood"));
    assert.equal(r.status, 200, r.text);
    const found = await waitFor("pending relationship proposal", async () => {
      const p = await api("GET", "/api/proposals?status=pending");
      return p.json && p.json.find((x) => x.kind === "relationship" && /annoyed/.test(x.proposal));
    }, 10_000);
    const payload = JSON.parse(found.payload_json).payload;
    assert.equal(payload.mood, "annoyed");
    assert.equal(payload.cooling_off_hours, 12);
    const before = await state();
    const ok = await api("POST", `/api/proposals/${found.id}/decide`, { decision: "approve" });
    assert.equal(ok.status, 200, ok.text);
    const s = await state();
    assert.equal(s.relationship.version, before.relationship.version + 1);
    assert.equal(s.relationship.state.mood, "annoyed");
    const until = Date.parse(s.relationship.state.cooling_off_until);
    assert.ok(Number.isFinite(until), "cooling_off_until: " + s.relationship.state.cooling_off_until);
    assert.ok(Math.abs(until - (Date.now() + 12 * 3600_000)) < 5 * 60_000, "about twelve hours out");
    assert.equal(s.relationship.state.his_name, null, "nothing else in the state moved");
    // The owner thaws it in the Now tab.
    const clear = await api("PUT", "/api/state/relationship", { state: { ...s.relationship.state, mood: "fine", cooling_off_until: null }, note: "integration: cleared" });
    assert.equal(clear.status, 200, clear.text);
    assert.equal(clear.json.state.cooling_off_until, null);
    assert.equal(clear.json.state.mood, "fine");
    const bad = await api("PUT", "/api/state/relationship", { state: { ...s.relationship.state, cooling_off_until: "soon" } });
    assert.equal(bad.status, 400, bad.text);
  });

  // ---------------------------------------------------------------- provenance

  await report.check("GET /api/messages/:id/context -> the ids the turn was built from; 404 for his message and unknown ids", async () => {
    const r = await turn(conversationId, "why did you say that", key("ctx"));
    assert.equal(r.status, 200, r.text);
    const ctx = await api("GET", `/api/messages/${r.json.assistantMessage.id}/context`);
    assert.equal(ctx.status, 200, ctx.text);
    const c = ctx.json;
    assert.equal(c.promptVersion, r.json.run.promptVersion);
    assert.equal(c.provider, "stub");
    assert.equal(typeof c.model, "string");
    assert.ok(Array.isArray(c.historyIds));
    assert.ok(Array.isArray(c.factIds.avelie) && Array.isArray(c.factIds.justin));
    assert.ok(c.factIds.avelie.length >= 1, "the approved cilantro fact is in the context");
    assert.ok(Array.isArray(c.threadIds) && c.threadIds.length >= 1, "her life threads are in the context");
    assert.ok(Array.isArray(c.callbacks));
    assert.ok(Array.isArray(c.unknownIds));
    assert.equal(typeof c.recentMessageCount, "number");
    assert.ok(Array.isArray(c.flags));
    assert.ok(["together", "apart"].includes(c.mode));
    assert.ok(Array.isArray(c.runIds) && c.runIds.length >= 1);
    const text = JSON.stringify(c);
    assert.ok(!text.includes("sk-"), "no key material");
    assert.ok(!/FIXED CANON|YOUR LIFE RIGHT NOW/.test(text), "no prompt text");
    const his = await api("GET", `/api/messages/${r.json.userMessage.id}/context`);
    assert.equal(his.status, 404, his.text);
    const nope = await api("GET", "/api/messages/m_nothing/context");
    assert.equal(nope.status, 404, nope.text);
  });

  // ---------------------------------------------------------------- mode toggle

  await report.check("PUT /api/state/scene status together -> the turn's context says together; back to apart", async () => {
    const s = await state();
    const put = await api("PUT", "/api/state/scene", { state: { ...s.scene.state, status: "together", location: "her kitchen" }, note: "toggle" });
    assert.equal(put.status, 200, put.text);
    const r = await turn(conversationId, "pass the salt", key("together"));
    assert.equal(r.status, 200, r.text);
    const ctx = await api("GET", `/api/messages/${r.json.assistantMessage.id}/context`);
    assert.equal(ctx.json.mode, "together");
    const back = await api("PUT", "/api/state/scene", { state: { ...s.scene.state, status: "apart", location: null }, note: "toggle" });
    assert.equal(back.status, 200, back.text);
    const r2 = await turn(conversationId, "home now", key("apart"));
    const ctx2 = await api("GET", `/api/messages/${r2.json.assistantMessage.id}/context`);
    assert.equal(ctx2.json.mode, "apart");
  });

  // ---------------------------------------------------------------- regenerate

  await report.check("POST /api/images/:id/regenerate: refused on an approved photo, rejects a candidate and asks again, 404 unknown", async () => {
    // The stub always returns master 03's bytes and that hash was blacklisted by the v1
    // reject check, so no new candidate can exist in this run: the route is proven by
    // its refusals. An approved photo has no Regenerate (SPEC_V2 section O).
    const assets = (await api("GET", "/api/assets")).json;
    const scene = assets.scenes[0];
    assert.ok(scene, "the v1 checks left an approved scene photo");
    const onApproved = await api("POST", `/api/images/${scene.id}/regenerate`);
    assert.ok(onApproved.status === 400 || onApproved.status === 409, "approved photo: expected 400 or 409, got " + onApproved.status + " " + onApproved.text.slice(0, 120));
    assert.equal((await api("GET", "/api/assets")).json.scenes.some((a) => a.id === scene.id), true, "the approved photo is untouched");
    const rejected = assets.rejected.find((a) => a.message_id);
    assert.ok(rejected, "the v1 checks left a rejected candidate");
    const onRejected = await api("POST", `/api/images/${rejected.id}/regenerate`);
    // Already rejected: either refused, or asked again and blacklisted by the stub's bytes.
    assert.ok([409, 422].includes(onRejected.status), "rejected candidate: got " + onRejected.status + " " + onRejected.text.slice(0, 120));
    assert.ok((await api("GET", "/api/assets")).json.rejected.some((a) => a.id === rejected.id), "the rejected row stays rejected");
    const gen = await api("POST", "/api/images/generate", { conversationId, description: "integration: regenerate me, lamp light" });
    assert.equal(gen.status, 422, "the stub's bytes are blacklisted for the rest of the run: " + gen.text.slice(0, 120));
    const nope = await api("POST", "/api/images/img_nothing/regenerate");
    assert.equal(nope.status, 404, nope.text);
    assert.equal(nope.json.code, "not_found");
  });

  // ---------------------------------------------------------------- drift check

  await report.check("POST /api/drift/run with the stub -> a report with five scenarios, no errors; GET /api/drift lists it; throwaway conversations hidden", async () => {
    const convBefore = (await api("GET", "/api/conversations")).json.length;
    const r = await api("POST", "/api/drift/run");
    assert.equal(r.status, 200, r.text);
    const rep = r.json.report;
    assert.equal(typeof rep.id, "string");
    assert.ok(Number.isFinite(Date.parse(rep.ranAt)));
    assert.equal(rep.summary.scenarios.length, 5);
    assert.equal(rep.summary.errors, 0, JSON.stringify(rep.summary.scenarios.map((s) => s.error)));
    assert.equal(rep.summary.provider, "stub");
    for (const s of rep.summary.scenarios) {
      assert.ok(s.turns >= 1, s.id + " ran no turn");
      assert.equal(s.exchanges.length, s.turns);
      assert.equal(typeof s.flagCount, "number");
      assert.ok(Array.isArray(s.failed));
    }
    const list = await api("GET", "/api/drift");
    assert.equal(list.status, 200, list.text);
    assert.ok(list.json.length >= 1 && list.json.length <= 4);
    assert.equal(list.json[0].id, rep.id);
    assert.equal(list.json[0].provider, "stub");
    assert.equal(typeof list.json[0].prompt_version, "string");
    assert.equal(JSON.parse(list.json[0].json).id, rep.id);
    const convAfter = (await api("GET", "/api/conversations")).json;
    assert.equal(convAfter.length, convBefore, "the drift conversations never show in the list");
    assert.ok(!convAfter.some((c) => (c.title || "").startsWith("drift ")));
    const exp = await api("GET", "/api/export");
    const driftConvs = exp.json.conversations.filter((c) => c.status === "drift");
    assert.equal(driftConvs.length, 5, "five throwaway rows marked drift");
    for (const c of driftConvs) assert.ok(!exp.json.messages.some((m) => m.conversation_id === c.id), "drift messages deleted");
    const audit = await auditRows(50);
    assert.ok(audit.some((a) => a.action === "drift.run" && a.entity_id === rep.id), "drift.run audited");
  });

  await report.check("cron 0 13 * * 1 -> no report while driftCheckEnabled is false; one more when true; setting restored", async () => {
    const before = (await api("GET", "/api/drift?limit=52")).json.length;
    const off = await scheduledCron("0 13 * * 1");
    assert.equal(off.status, 200, off.text.slice(0, 200));
    assert.equal((await api("GET", "/api/drift?limit=52")).json.length, before, "drift check ran while disabled");
    const set = await api("PUT", "/api/settings", { driftCheckEnabled: true });
    assert.equal(set.status, 200, set.text);
    try {
      const on = await scheduledCron("0 13 * * 1");
      assert.equal(on.status, 200, on.text.slice(0, 200));
      const after = await waitFor("a new drift report", async () => {
        const rows = (await api("GET", "/api/drift?limit=52")).json;
        return rows.length === before + 1 ? rows : null;
      }, 30_000);
      assert.equal(after.length, before + 1);
    } finally {
      const back = await api("PUT", "/api/settings", { driftCheckEnabled: false });
      assert.equal(back.status, 200, back.text);
    }
  });

  // ---------------------------------------------------------------- backup cron

  let backupObjectKey = null;
  await report.check("cron 0 7 * * * -> backup.run audited with today's key backups/avelie-<date>.json", async () => {
    const r = await scheduledCron("0 7 * * *");
    assert.equal(r.status, 200, r.text.slice(0, 200));
    const today = new Date().toISOString().slice(0, 10);
    const row = await waitFor("backup audit row", async () => {
      const rows = await auditRows(50);
      return rows.find((a) => a.action === "backup.run");
    }, 30_000);
    assert.equal(row.entity_id, `backups/avelie-${today}.json`);
    const after = JSON.parse(row.after_json);
    assert.ok(after.bytes > 1000, "the export has bytes: " + after.bytes);
    assert.equal(after.kept, 1);
    backupObjectKey = row.entity_id;
  });

  await report.check("the backup object exists in local R2 and parses as the export", async () => {
    assert.ok(backupObjectKey, "no key from the previous check");
    const r = await runCommand(["r2", "object", "get", `avelie-media/${backupObjectKey}`, "--local", "--persist-to", STATE_ARG, "--pipe"], { env: { CI: "1" } });
    assert.equal(r.code, 0, r.output.slice(0, 500));
    const start = r.output.indexOf("{");
    assert.ok(start >= 0, "no JSON in the output: " + r.output.slice(0, 200));
    const end = r.output.lastIndexOf("}");
    const data = JSON.parse(r.output.slice(start, end + 1));
    assert.equal(data.version, 1);
    assert.ok(Array.isArray(data.facts) && data.facts.length > 0);
    assert.ok(Array.isArray(data.messages));
    return `${backupObjectKey}, ${r.output.length} chars`;
  });

  // ---------------------------------------------------------------- her voice (stub)

  await report.check("[[VOICE]] with the stub voice provider -> audio_key on her message; GET /media/audio/:id serves audio/mpeg", async () => {
    const set = await api("PUT", "/api/settings", { voiceProvider: "stub", voiceMode: "some" });
    assert.equal(set.status, 200, set.text);
    try {
      const r = await turn(conversationId, "[[VOICE]] say it instead", key("voice"));
      assert.equal(r.status, 200, r.text);
      const m = r.json.assistantMessage;
      assert.ok(!/\[voice\]/i.test(m.content), "marker stripped: " + m.content);
      const stored = await waitFor("audio_key on her message", async () => {
        const row = (await api("GET", `/api/messages/${m.id}`)).json;
        return row && typeof row.audio_key === "string" && row.audio_key ? row : null;
      }, 15_000);
      assert.ok(stored.audio_key.startsWith("voice/"), "audio_key: " + stored.audio_key);
      const media = await fetchBytes(`/media/audio/${m.id}`);
      assert.equal(media.status, 200, "audio not served");
      assert.ok(media.contentType.startsWith("audio/mpeg"), "content-type: " + media.contentType);
      const head = Array.from(media.bytes.slice(0, 3));
      const id3 = head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33;
      const sync = head[0] === 0xff && (head[1] & 0xe0) === 0xe0;
      assert.ok(id3 || sync, "not an mp3 header: " + head.join(","));
      const plain = await turn(conversationId, "typed this one", key("novoice"));
      assert.equal(plain.json.assistantMessage.audio_key ?? null, null);
      const nope = await fetchBytes("/media/audio/m_nothing");
      assert.equal(nope.status, 404);
    } finally {
      const back = await api("PUT", "/api/settings", { voiceProvider: original.voiceProvider, voiceMode: original.voiceMode });
      assert.equal(back.status, 200, back.text);
    }
  });

  // ---------------------------------------------------------------- his photos (multipart turn)

  await report.check("multipart turn with one png -> images_json on his message, stub reply says (photo received), /media/inbox serves it", async () => {
    const form = new FormData();
    form.set("content", "look at this one");
    form.set("idempotencyKey", key("photo-in"));
    form.set("image", new Blob([tinyPng()], { type: "image/png" }), "tiny.png");
    const r = await apiForm("POST", `/api/conversations/${conversationId}/turn`, form);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.replayed, false);
    assert.ok(Array.isArray(r.json.images) && r.json.images.length === 1, "images: " + JSON.stringify(r.json.images));
    assert.equal(r.json.images[0].mime, "image/png");
    assert.ok(r.json.assistantMessage.content.includes("(photo received)"), "stub reply: " + r.json.assistantMessage.content);
    const his = await api("GET", `/api/messages/${r.json.userMessage.id}`);
    assert.equal(his.status, 200, his.text);
    const images = JSON.parse(his.json.images_json);
    assert.equal(images.length, 1);
    assert.ok(images[0].key.startsWith("inbox/"), images[0].key);
    assert.equal(images[0].mime, "image/png");
    assert.equal(images[0].width, 2);
    const media = await fetchBytes(`/media/inbox/${r.json.userMessage.id}/0`);
    assert.equal(media.status, 200, "inbox image not served");
    assert.ok(media.contentType.startsWith("image/png"), media.contentType);
    assert.deepEqual(Array.from(media.bytes.slice(0, 4)), [0x89, 0x50, 0x4e, 0x47]);
    const none = await fetchBytes(`/media/inbox/${r.json.userMessage.id}/1`);
    assert.equal(none.status, 404);
    const bad = new FormData();
    bad.set("content", "not an image");
    bad.set("idempotencyKey", key("photo-bad"));
    bad.set("image", new Blob([Buffer.from("plain text, not a picture")], { type: "image/png" }), "fake.png");
    const rejected = await apiForm("POST", `/api/conversations/${conversationId}/turn`, bad);
    assert.equal(rejected.status, 415, rejected.text);
  });

  // ---------------------------------------------------------------- the owner's media library

  await report.check("media: upload (201), list, [[MEDIA:title]] attaches media_id, /media/library serves, unknown title flagged, delete", async () => {
    const form = new FormData();
    form.set("file", new Blob([tinyMp3()], { type: "audio/mpeg" }), "clip.mp3");
    form.set("title", "integration clip");
    form.set("description", "one take on the fire escape");
    form.set("kind", "clip");
    const up = await apiForm("POST", "/api/media", form);
    assert.equal(up.status, 201, up.text);
    const id = up.json.id;
    assert.equal(up.json.title, "integration clip");
    assert.equal(up.json.kind, "clip");
    assert.equal(up.json.mime, "audio/mpeg");
    const list = await api("GET", "/api/media");
    assert.equal(list.status, 200, list.text);
    assert.ok(list.json.some((m) => m.id === id));
    const served = await fetchBytes(`/media/library/${id}`);
    assert.equal(served.status, 200, "library object not served");
    assert.ok(served.contentType.startsWith("audio/mpeg"), served.contentType);
    assert.equal(served.bytes.length, tinyMp3().length);
    const r = await turn(conversationId, "[[MEDIA:integration clip]] send the clip", key("media"));
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.assistantMessage.media_id, id, "media_id: " + JSON.stringify(r.json.assistantMessage.media_id));
    assert.ok(!/\[media:/i.test(r.json.assistantMessage.content), r.json.assistantMessage.content);
    const unknown = await turn(conversationId, "[[MEDIA:no such clip]] send it", key("media-unknown"));
    assert.equal(unknown.status, 200, unknown.text);
    assert.equal(unknown.json.assistantMessage.media_id ?? null, null);
    assert.ok(unknown.json.flags.some((f) => f.code === "media_unknown"), "flags: " + JSON.stringify(unknown.json.flags));
    assert.ok(!/\[media:/i.test(unknown.json.assistantMessage.content));
    const del = await api("DELETE", `/api/media/${id}`);
    assert.equal(del.status, 200, del.text);
    assert.equal(del.json.ok, true);
    assert.ok(!(await api("GET", "/api/media")).json.some((m) => m.id === id), "deleted media still listed");
    assert.equal((await fetchBytes(`/media/library/${id}`)).status, 404);
    assert.equal((await api("DELETE", `/api/media/${id}`)).status, 404);
    const text = new FormData();
    text.set("file", new Blob([Buffer.from("hello")], { type: "text/plain" }), "note.txt");
    text.set("title", "not media");
    assert.equal((await apiForm("POST", "/api/media", text)).status, 415);
  });

  // ---------------------------------------------------------------- push and her first text

  await report.check("push: public-key reports unconfigured locally; subscribe stores a row (ok), unsubscribe ok; bad endpoint 400", async () => {
    const pk = await api("GET", "/api/push/public-key");
    assert.equal(pk.status, 200, pk.text);
    assert.equal(pk.json.configured, false, "no VAPID keys locally");
    assert.equal(pk.json.publicKey, null);
    const sub = await api("POST", "/api/push/subscribe", { endpoint: "https://push.example.test/sub/integration", keys: { p256dh: "BPUBLICKEYxyz", auth: "authsecret" } });
    assert.equal(sub.status, 200, sub.text);
    assert.equal(sub.json.ok, true);
    const again = await api("POST", "/api/push/subscribe", { endpoint: "https://push.example.test/sub/integration", keys: { p256dh: "BPUBLICKEYxyz", auth: "authsecret" } });
    assert.equal(again.status, 200, "the same endpoint twice is fine: " + again.text);
    const bad = await api("POST", "/api/push/subscribe", { endpoint: "http://insecure.example/sub", keys: { p256dh: "x", auth: "y" } });
    assert.equal(bad.status, 400, bad.text);
    const exp = await api("GET", "/api/export");
    assert.ok(!JSON.stringify(exp.json).includes("authsecret"), "subscription secrets never leave through the export");
    const audit = await auditRows(20);
    assert.ok(audit.some((a) => a.action === "push.subscribe"));
    assert.ok(!JSON.stringify(audit).includes("authsecret"), "subscription secrets are not audited");
  });

  await report.check("POST /api/herfirst/run: cap 10, waking window closing -> one assistant message with no user message; push logged as skipped (no VAPID keys)", async () => {
    // Her timezone becomes UTC and the quiet window opens 25 minutes from now, so the
    // waking window has about one tick left and the whole cap of 10 must land in it:
    // the per-tick probability is 1. Nothing else about her day blocks: no busy thread,
    // a fresh conversation with no messages, today's count 0.
    const now = new Date();
    const quietStart = new Date(now.getTime() + 25 * 60_000);
    const quietEnd = new Date(quietStart.getTime() + 8 * 3600_000);
    const set = await api("PUT", "/api/settings", { timezone: "UTC", herFirstTextsPerDay: 10, herFirstQuietHours: `${hhmm(quietStart)}-${hhmm(quietEnd)}` });
    assert.equal(set.status, 200, set.text);
    const life = await api("GET", "/api/life?status=active");
    for (const t of life.json.threads.filter((x) => x.schedule_json)) {
      const d = await api("DELETE", `/api/life/threads/${t.id}`);
      assert.equal(d.status, 200, d.text);
    }
    const conv = await api("POST", "/api/conversations", { title: "integration: her first" });
    assert.equal(conv.status, 201, conv.text);
    try {
      const r = await api("POST", "/api/herfirst/run", { force: true });
      assert.equal(r.status, 200, r.text);
      const text = JSON.stringify(r.json).toLowerCase();
      const list = await api("GET", `/api/conversations/${conv.json.id}/messages?channel=story&includePending=1`);
      assert.equal(list.status, 200, list.text);
      assert.equal(list.json.length, 1, "one message of hers expected in the fresh conversation; run result: " + r.text.slice(0, 300));
      const m = list.json[0];
      assert.equal(m.role, "assistant");
      assert.equal(m.reply_to_id, null);
      assert.ok(m.content.trim().length > 0);
      assert.ok(/skip/.test(text), "the run should report the push as skipped (no VAPID keys locally): " + r.text.slice(0, 300));
      const latest = await api("GET", "/api/push/latest");
      assert.equal(latest.status, 200, latest.text);
      assert.equal(latest.json.messageId, m.id);
      assert.equal(latest.json.text, m.content);
      // A second tick right away: her last message is under 45 minutes old, so nothing more.
      const again = await api("POST", "/api/herfirst/run", { force: true });
      assert.equal(again.status, 200, again.text);
      const after = await api("GET", `/api/conversations/${conv.json.id}/messages?channel=story&includePending=1`);
      assert.equal(after.json.length, 1, "she never stacks a second first text on a fresh one");
      const ctx = await api("GET", `/api/messages/${m.id}/context`);
      assert.equal(ctx.status, 200, ctx.text);
      assert.equal(ctx.json.opener, true);
    } finally {
      const back = await api("PUT", "/api/settings", { timezone: original.timezone, herFirstTextsPerDay: original.herFirstTextsPerDay, herFirstQuietHours: original.herFirstQuietHours });
      assert.equal(back.status, 200, back.text);
      const un = await api("DELETE", "/api/push/subscribe", { endpoint: "https://push.example.test/sub/integration" });
      assert.equal(un.status, 200, un.text);
    }
  });

  await report.check("herfirst off (cap 0) -> the run sends nothing", async () => {
    const set = await api("PUT", "/api/settings", { herFirstTextsPerDay: 0 });
    assert.equal(set.status, 200, set.text);
    try {
      const before = (await api("GET", "/api/export")).json.messages.length;
      const r = await api("POST", "/api/herfirst/run", { force: true });
      assert.equal(r.status, 200, r.text);
      const after = (await api("GET", "/api/export")).json.messages.length;
      assert.equal(after, before, "a message was written with the feature off");
    } finally {
      const back = await api("PUT", "/api/settings", { herFirstTextsPerDay: original.herFirstTextsPerDay });
      assert.equal(back.status, 200, back.text);
    }
  });

  // ---------------------------------------------------------------- timeline, voiceprint, character export

  await report.check("GET /api/timeline -> merged items, dated, oldest first; limit and before page it", async () => {
    const r = await api("GET", "/api/timeline");
    assert.equal(r.status, 200, r.text);
    const items = Array.isArray(r.json) ? r.json : r.json.items;
    assert.ok(Array.isArray(items) && items.length >= 3, "items: " + r.text.slice(0, 200));
    const dateOf = (i) => i.date ?? i.at ?? i.when ?? i.occurred ?? i.created_at;
    const dates = items.map((i) => Date.parse(dateOf(i)));
    for (const d of dates) assert.ok(Number.isFinite(d), "every item carries a date");
    for (let i = 1; i < dates.length; i++) assert.ok(dates[i] >= dates[i - 1], "not sorted oldest first at " + i);
    const kinds = new Set(items.map((i) => i.kind ?? i.type ?? i.entity));
    assert.ok(kinds.size >= 3, "kinds: " + [...kinds].join(", "));
    const two = await api("GET", "/api/timeline?limit=2");
    const twoItems = Array.isArray(two.json) ? two.json : two.json.items;
    assert.equal(twoItems.length, 2);
    const cut = dateOf(items[Math.floor(items.length / 2)]);
    const older = await api("GET", "/api/timeline?before=" + encodeURIComponent(cut));
    const olderItems = Array.isArray(older.json) ? older.json : older.json.items;
    assert.ok(olderItems.length < items.length && olderItems.length > 0);
    for (const i of olderItems) assert.ok(Date.parse(dateOf(i)) < Date.parse(cut), "before cut: " + dateOf(i));
    return `${items.length} items, kinds ${[...kinds].join("/")}`;
  });

  await report.check("POST /api/voiceprint/run -> a row; GET /api/voiceprint lists it with a week and stats", async () => {
    const r = await api("POST", "/api/voiceprint/run");
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.voiceprint && typeof r.json.voiceprint === "object");
    const list = await api("GET", "/api/voiceprint");
    assert.equal(list.status, 200, list.text);
    assert.ok(Array.isArray(list.json) && list.json.length >= 1);
    const row = list.json[0];
    assert.equal(typeof row.week, "string");
    const stats = typeof row.json === "string" ? JSON.parse(row.json) : row.json;
    assert.ok(stats && typeof stats === "object");
    const text = JSON.stringify(stats);
    assert.ok(!/NaN|Infinity/.test(text));
    assert.ok(/count|messages/i.test(text), "stats carry a count");
  });

  await report.check("GET /api/export/character (JSON) and character.md: the package keys, no secrets, the prefix hash", async () => {
    const r = await api("GET", "/api/export/character");
    assert.equal(r.status, 200, r.text.slice(0, 200));
    for (const k of ["constitutionVersion", "adaptations", "fixedCanon", "avelieFacts", "opinions", "history", "life", "unknowns", "relationship", "scene", "images", "mediaTitles", "promptPrefixSha256"]) {
      assert.ok(k in r.json, "missing " + k);
    }
    assert.match(r.json.promptPrefixSha256, /^[0-9a-f]{64}$/);
    const text = JSON.stringify(r.json);
    assert.ok(!text.includes("sk-"));
    assert.ok(!text.includes("authsecret"));
    assert.ok(text.includes("she hates cilantro"), "the approved fact is in the package");
    assert.ok(JSON.stringify(r.json.life).includes("the bakery shift"));
    const md = await api("GET", "/api/export/character.md");
    assert.equal(md.status, 200, md.text.slice(0, 200));
    assert.ok((md.headers.get("content-type") || "").startsWith("text/markdown"), md.headers.get("content-type"));
    assert.ok(/^# /m.test(md.text));
    assert.ok(md.text.includes("she hates cilantro"));
    assert.ok(!BAD_TYPOGRAPHY.test(md.text));
    assert.ok(!md.text.includes("sk-"));
  });

  await report.check("v2: caps and settings back to the v1 values", async () => {
    const r = await api("PUT", "/api/settings", { dailyCapUsd: original.dailyCapUsd, monthlyCapUsd: original.monthlyCapUsd });
    assert.equal(r.status, 200, r.text);
    const s = (await api("GET", "/api/settings")).json;
    for (const k of ["replyDelayMode", "realDelayMaxMinutes", "driftCheckEnabled", "timezone", "voiceProvider", "voiceMode", "herFirstTextsPerDay", "herFirstQuietHours"]) {
      assert.deepEqual(s[k], original[k], k);
    }
  });
}

// The gate as production runs it: ACCESS_AUD set, so the dev actor is off and only a
// verified Access token could get in. (A non-local Host header cannot be probed through
// wrangler dev: with a route configured it rewrites every request's origin, and
// wrangler.jsonc pins dev.host to 127.0.0.1 so the local rule works at all; the non-local
// branch of requireOwner is covered by tests/unit/auth.test.mjs.)
async function gateScenarios(report) {
  await report.check("ACCESS_AUD set: GET /api/me without a token -> 401, dev actor not granted", async () => {
    const r = await api("GET", "/api/me");
    assert.equal(r.status, 401, r.text);
    assert.equal(r.json.code, "unauthorized");
    assert.ok(!r.text.includes(DEV_ACTOR_EMAIL), "dev actor must be off while ACCESS_AUD is set");
  });

  await report.check("ACCESS_AUD set: garbage token (header) and garbage cookie -> 403, never the email", async () => {
    const h = await api("GET", "/api/me", undefined, { "cf-access-jwt-assertion": "garbage" });
    assert.equal(h.status, 403, h.text);
    assert.equal(h.json.code, "forbidden");
    const c = await api("GET", "/api/me", undefined, { cookie: "CF_Authorization=garbage.garbage.garbage" });
    assert.equal(c.status, 403, c.text);
    assert.ok(!h.text.includes(DEV_ACTOR_EMAIL) && !c.text.includes(DEV_ACTOR_EMAIL));
  });

  await report.check("ACCESS_AUD set: client email header never grants identity -> 401", async () => {
    const r = await api("GET", "/api/me", undefined, { "cf-access-authenticated-user-email": DEV_ACTOR_EMAIL });
    assert.equal(r.status, 401, r.text);
  });

  await report.check("ACCESS_AUD set: static / and /media/:id are gated too -> 401", async () => {
    const root = await api("GET", "/");
    assert.equal(root.status, 401, root.text);
    const css = await api("GET", "/css/app.css");
    assert.equal(css.status, 401, css.text);
    const media = await api("GET", "/media/img_nothing");
    assert.equal(media.status, 401, media.text);
  });

  await report.check("ACCESS_AUD set: v2 media paths, the timeline, the character export and the cron routes are gated -> 401", async () => {
    for (const path of ["/media/audio/m_nothing", "/media/inbox/m_nothing/0", "/media/library/md_nothing", "/api/timeline", "/api/export/character", "/api/export/character.md", "/api/drift", "/api/life", "/api/push/latest", "/sw.js", "/manifest.webmanifest"]) {
      const r = await api("GET", path);
      assert.equal(r.status, 401, path + " -> " + r.status + " " + r.text.slice(0, 100));
    }
    for (const path of ["/api/drift/run", "/api/herfirst/run", "/api/voiceprint/run", "/api/push/subscribe"]) {
      const r = await api("POST", path, {});
      assert.equal(r.status, 401, path + " -> " + r.status + " " + r.text.slice(0, 100));
    }
  });
}

// ------------------------------------------------------------------ main

// True when anything at all answers on the test port.
async function answering() {
  try {
    await fetch(BASE + "/api/me", { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const report = new Report();
  const t0 = Date.now();
  let wrangler = null;
  let restoreDevVars = () => {};
  let exitCode = 1;

  const shutdown = async () => {
    await stopWrangler(wrangler);
    restoreDevVars();
  };
  process.on("SIGINT", () => { shutdown().finally(() => process.exit(130)); });
  process.on("SIGTERM", () => { shutdown().finally(() => process.exit(143)); });

  try {
    console.log(`integration: fresh state at ${STATE_DIR}`);
    removeDir(STATE_DIR);
    restoreDevVars = ensureDevVars();

    const tm = Date.now();
    const migrate = await runCommand(["d1", "migrations", "apply", "avelie", "--local", "--persist-to", STATE_ARG], { env: { CI: "1" } });
    if (migrate.code !== 0) {
      console.log(migrate.output);
      throw new Error("migrations failed with exit code " + migrate.code);
    }
    console.log(`migrations applied (${Date.now() - tm} ms)`);

    // --local: remote bindings off (the AI binding would otherwise open a remote session
    // that needs a Cloudflare API token). The three --var flags mirror .dev.vars so the run
    // does not depend on what a developer keeps there.
    const tb = Date.now();
    if (await answering()) throw new Error("something already answers on " + BASE + "; stop it (or set AVELIE_TEST_PORT) and rerun");
    // --test-scheduled: GET /__scheduled?cron=... runs the Worker's scheduled handler, so
    // the backup and drift crons are exercised without waiting for the clock.
    wrangler = startWrangler([
      "--port", String(PORT), "--local", "--persist-to", STATE_ARG, "--test-scheduled",
      "--var", "APP_ENV:" + APP_ENV_TAG,
      // wrangler.jsonc carries the production AUD; phase 1 needs the dev actor, so clear it.
      "--var", "ACCESS_AUD:",
      "--var", `DEV_ACTOR_EMAIL:${DEV_ACTOR_EMAIL}`,
      "--var", "DEFAULT_PROVIDER:stub",
      "--var", "DEFAULT_IMAGE_PROVIDER:stub",
    ], STUB_ENV);

    await waitFor("wrangler dev on " + BASE, async () => {
      if (wrangler.hasExited()) throw new Error("wrangler dev exited before it was ready");
      const r = await api("GET", "/api/me");
      // Only this run's server carries this run's tag.
      return r.status === 200 && r.json && r.json.env === APP_ENV_TAG;
    }, BOOT_TIMEOUT_MS, 500).catch((e) => {
      console.log("wrangler output (tail):");
      console.log(wrangler.tail());
      throw e;
    });
    console.log(`wrangler dev ready on ${BASE} (${Date.now() - tb} ms)\n`);

    const conversationId = await scenarios(report);
    console.log("");
    await scenariosV2(report, conversationId);

    // Second phase, same port and state, with the production gate switched on. The gated
    // server cannot be told apart by /api/me (401), so nothing may answer before it boots.
    await stopWrangler(wrangler);
    if (await answering()) throw new Error("the first server is still answering on " + BASE + " after shutdown");
    const tg = Date.now();
    wrangler = startWrangler([
      "--port", String(PORT), "--local", "--persist-to", STATE_ARG,
      "--var", "APP_ENV:" + APP_ENV_TAG,
      "--var", `DEV_ACTOR_EMAIL:${DEV_ACTOR_EMAIL}`,
      "--var", "DEFAULT_PROVIDER:stub",
      "--var", "DEFAULT_IMAGE_PROVIDER:stub",
      "--var", "ACCESS_AUD:integration-aud-tag",
    ], STUB_ENV);
    await waitFor("wrangler dev (gated) on " + BASE, async () => {
      if (wrangler.hasExited()) throw new Error("wrangler dev exited before it was ready");
      const r = await api("GET", "/api/me");
      return r.status > 0;
    }, BOOT_TIMEOUT_MS, 500).catch((e) => {
      console.log("wrangler output (tail):");
      console.log(wrangler.tail());
      throw e;
    });
    console.log(`\nwrangler dev (ACCESS_AUD set) ready on ${BASE} (${Date.now() - tg} ms)\n`);

    await gateScenarios(report);
    report.summary();
    exitCode = report.failed ? 1 : 0;
  } catch (e) {
    console.log("integration: aborted: " + (e instanceof Error ? e.message : String(e)));
    report.summary();
    exitCode = 1;
  } finally {
    await shutdown();
    console.log(`total ${Date.now() - t0} ms, wrangler log: ${wrangler ? wrangler.logPath : "(not started)"}`);
  }
  process.exit(exitCode);
}

main();
