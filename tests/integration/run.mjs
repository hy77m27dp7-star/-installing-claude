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

  await report.check("PUT /api/settings: an unpriced model or proposalModel -> 400; the Workers AI model is priced by default and selectable", async () => {
    const llama = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
    const current = await api("GET", "/api/settings");
    assert.equal(current.status, 200, current.text);
    assert.ok(current.json.prices && current.json.prices[llama], "the built-in price reaches a seeded database");
    const model = await api("PUT", "/api/settings", { model: "nobody-priced-this" });
    assert.equal(model.status, 400, model.text);
    assert.equal(model.json.code, "validation");
    assert.ok(/prices/.test(model.json.error), model.json.error);
    const proposal = await api("PUT", "/api/settings", { proposalModel: "nobody-priced-this" });
    assert.equal(proposal.status, 400, proposal.text);
    const unchanged = await api("GET", "/api/settings");
    assert.equal(unchanged.json.model, current.json.model);
    assert.equal(unchanged.json.proposalModel, current.json.proposalModel);
    const ok = await api("PUT", "/api/settings", { model: llama });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.model, llama);
    const back = await api("PUT", "/api/settings", { model: current.json.model });
    assert.equal(back.status, 200, back.text);
    assert.equal(back.json.model, current.json.model);
  });

  await report.check("PUT /api/settings: imageCostUsd 0 is refused for openai and allowed for the stub", async () => {
    const current = await api("GET", "/api/settings");
    const paid = await api("PUT", "/api/settings", { imageProvider: "openai", imageCostUsd: 0 });
    assert.equal(paid.status, 400, paid.text);
    assert.equal(paid.json.code, "validation");
    assert.ok(/imageCostUsd/.test(paid.json.error), paid.json.error);
    const after = await api("GET", "/api/settings");
    assert.equal(after.json.imageProvider, "stub", "a refused patch changes nothing");
    assert.equal(after.json.imageCostUsd, current.json.imageCostUsd);
    const free = await api("PUT", "/api/settings", { imageCostUsd: 0 });
    assert.equal(free.status, 200, free.text);
    assert.equal(free.json.imageCostUsd, 0);
    const back = await api("PUT", "/api/settings", { imageCostUsd: current.json.imageCostUsd });
    assert.equal(back.status, 200, back.text);
    assert.equal(back.json.imageCostUsd, current.json.imageCostUsd);
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
    // that needs a Cloudflare API token). The --var flags mirror .dev.vars so the run does
    // not depend on what a developer keeps there. ACCESS_AUD is passed empty on purpose:
    // wrangler.jsonc carries the production tag, and the local actor rule needs it empty.
    const tb = Date.now();
    if (await answering()) throw new Error("something already answers on " + BASE + "; stop it (or set AVELIE_TEST_PORT) and rerun");
    wrangler = startWrangler([
      "--port", String(PORT), "--local", "--persist-to", STATE_ARG,
      "--var", "APP_ENV:" + APP_ENV_TAG,
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

    await scenarios(report);

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
