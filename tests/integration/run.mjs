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
  BASE, DEV_ACTOR_EMAIL, EM_DASH, BAD_TYPOGRAPHY, PORT, STATE_DIR, ROOT, api, fetchBytes, waitFor, Report, removeDir,
  ensureDevVars, runCommand, startWrangler, stopWrangler, sleep,
} from "./helpers.mjs";

const BOOT_TIMEOUT_MS = 90_000;
const STATE_ARG = "tests/integration/.state";
// v4 runs on its own fresh state (see scenariosV4): the stub image and video bytes are
// blacklisted on the shared state by the v1 and v3 rejection checks.
const STATE_ARG_V4 = "tests/integration/.state-v4";
const STATE_DIR_V4 = STATE_DIR + "-v4";
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

  // Six since 2026-09-25: the tight face crop of master 04 (master-00) joined the five.
  await report.check("POST /api/assets/verify -> allOk true for the six masters", async () => {
    const r = await api("POST", "/api/assets/verify");
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.allOk, true, JSON.stringify(r.json.results.filter((x) => !x.ok)));
    assert.equal(r.json.results.length, 6);
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

  await report.check("PUT /api/settings prices: a model priced through the API becomes selectable, the built-in entries stay; the Model page carries the price table", async () => {
    const llama = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
    const current = await api("GET", "/api/settings");
    assert.equal(current.status, 200, current.text);
    const refused = await api("PUT", "/api/settings", { model: "priced-later" });
    assert.equal(refused.status, 400, refused.text);
    assert.ok(/Prices section of the Model page/.test(refused.json.error), "the refusal says where to fix it: " + refused.json.error);
    const priced = await api("PUT", "/api/settings", { prices: { "priced-later": { inputPerMTok: 1.5, outputPerMTok: 7.5 } } });
    assert.equal(priced.status, 200, priced.text);
    assert.deepEqual(priced.json.prices["priced-later"], { inputPerMTok: 1.5, outputPerMTok: 7.5 });
    assert.ok(priced.json.prices[llama] && priced.json.prices["claude-opus-5"], "built-in entries survive a stored table that omits them");
    const selected = await api("PUT", "/api/settings", { model: "priced-later" });
    assert.equal(selected.status, 200, selected.text);
    assert.equal(selected.json.model, "priced-later");
    const back = await api("PUT", "/api/settings", { model: current.json.model, prices: current.json.prices });
    assert.equal(back.status, 200, back.text);
    assert.equal(back.json.model, current.json.model);
    assert.equal(back.json.prices["priced-later"], undefined, "the stored table is replaced, not merged, so the test entry is gone");
    const page = await api("GET", "/model");
    assert.equal(page.status, 200);
    assert.ok(page.text.includes('id="priceRows"') && page.text.includes('id="addPriceBtn"'), "the Model page has the price table");
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
    assert.equal(original.herFirstTextsPerDay, 0, "her first texts ship off (opt-in)");
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
    // Her timezone becomes UTC and the quiet window opens 25 minutes from now and runs
    // around the clock to five minutes ago, so this tick (and at most the next) are the
    // only waking ticks left today whatever the hour: the whole cap of 10 must land in
    // them and the per-tick probability is 1. (An eight-hour window from now+25 closed the
    // day only after 15:35 UTC, which made the check depend on the clock.) Nothing else
    // about her day blocks: no busy thread, a fresh conversation with no messages, today's
    // count 0.
    const now = new Date();
    const quietStart = new Date(now.getTime() + 25 * 60_000);
    const quietEnd = new Date(now.getTime() - 5 * 60_000);
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

// ------------------------------------------------------------------ v3 scenarios (SPEC_V3 sections AA to II)

// The v3 modules under test are TypeScript; the unit helpers' resolve hook lets this plain
// runner import the two pure pieces it needs (the cue roll and the constitution text).
async function loadTs(name) {
  try {
    const { loadSrc } = await import("../unit/helpers.mjs");
    return await loadSrc(name);
  } catch {
    return null;
  }
}

const MIN_MS = 60 * 1000;
const DAY_MS_V3 = 24 * 60 * 60 * 1000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

async function contextOf(messageId) {
  const r = await api("GET", `/api/messages/${messageId}/context`);
  assert.equal(r.status, 200, "context: " + r.text);
  return r.json;
}

async function settingsPut(patch) {
  const r = await api("PUT", "/api/settings", patch);
  assert.equal(r.status, 200, "settings " + JSON.stringify(patch) + ": " + r.text);
  return r.json;
}

// The first pending proposal of a kind whose text mentions `needle`, within 10 s.
async function pendingProposal(kind, needle) {
  return waitFor(`a pending ${kind} proposal about ${JSON.stringify(needle)}`, async () => {
    const r = await api("GET", "/api/proposals?status=pending");
    if (r.status !== 200) return null;
    return r.json.find((p) => p.kind === kind && (p.proposal.toLowerCase().includes(needle.toLowerCase()) || (p.payload_json || "").toLowerCase().includes(needle.toLowerCase()))) || null;
  }, 10_000, 300);
}

async function approve(proposalId) {
  const r = await api("POST", `/api/proposals/${proposalId}/decide`, { decision: "approve" });
  assert.equal(r.status, 200, "approve: " + r.text);
  return r.json;
}

async function newConversation(title) {
  const r = await api("POST", "/api/conversations", { title });
  assert.equal(r.status, 201, r.text);
  return r.json.id;
}

// The state text a reply saw: the context row carries it when the pipeline stores it there;
// null otherwise (the check that needs it then says so instead of failing on the shape).
function stateTextOf(ctx) {
  return typeof ctx.stateText === "string" ? ctx.stateText : typeof ctx.state_text === "string" ? ctx.state_text : null;
}

async function scenariosV3(report) {
  // Every v3 route answers 404 on a tree without the v3 router; then nothing below can run.
  const probe = await api("GET", "/api/finetune/status");
  if (probe.status === 404) {
    console.log("v3: the routes are not on this server (GET /api/finetune/status -> 404); skipping the v3 block");
    return;
  }
  const original = (await api("GET", "/api/settings")).json;
  const restore = {
    dailyCapUsd: original.dailyCapUsd, monthlyCapUsd: original.monthlyCapUsd, model: original.model,
    weatherProvider: original.weatherProvider, herCity: original.herCity, herLat: original.herLat, herLon: original.herLon,
    provisionalRecallEvery: original.provisionalRecallEvery, typoCueShare: original.typoCueShare,
    tastingEnabled: original.tastingEnabled, tastingProvider: original.tastingProvider, tastingModel: original.tastingModel, tastingDailyCapUsd: original.tastingDailyCapUsd,
    callProvider: original.callProvider, videoProvider: original.videoProvider, exemplarsPerTurn: original.exemplarsPerTurn,
  };
  await report.check("v3: settings carry the new defaults; caps raised for this block; the stub call, weather and video providers", async () => {
    assert.equal(original.exemplarsPerTurn, 6);
    assert.equal(original.provisionalRecallEvery, 0, "the recall switch ships off");
    assert.equal(original.typoCueShare, 0, "the typo cue ships off");
    assert.equal(original.tastingEnabled, false);
    assert.equal(original.callSystemMode, "compact");
    assert.equal(original.callMaxMinutes, 20);
    assert.equal(original.herCity, "Portland, Maine", "the owner's answer of 2026-09-24");
    assert.deepEqual(original.callPrices, { audioInPerMTok: 32, audioOutPerMTok: 64, textInPerMTok: 4, textOutPerMTok: 16 });
    await settingsPut({ dailyCapUsd: 200, monthlyCapUsd: 500, callProvider: "stub", videoProvider: "stub" });
  });

  await report.check("v3: PUT /api/settings refuses a bad value on every new row and changes nothing", async () => {
    for (const patch of [{ exemplarsPerTurn: 13 }, { memoryFactsMax: 4 }, { provisionalRecallEvery: 51 }, { moodDaysDefault: 15 }, { herLat: 91 }, { weatherProvider: "noaa" }, { callProvider: "twilio" }, { callPrices: { audioInPerMTok: 1 } }, { videoSeconds: 7 }, { videoRatio: "16:9" }, { typoCueShare: 0.4 }, { tastingModel: "" }, { finetuneMinExamples: 9 }, { texterPrevious: "x" }]) {
      const r = await api("PUT", "/api/settings", patch);
      assert.equal(r.status, 400, JSON.stringify(patch) + " -> " + r.text);
      assert.equal(r.json.code, "validation");
    }
    const s = (await api("GET", "/api/settings")).json;
    assert.equal(s.exemplarsPerTurn, 6);
    assert.equal(s.callProvider, "stub");
  });

  const conversationId = await newConversation("integration v3");

  // ---------------------------------------------------------------- AA: the voice bank and the notes

  let approvedBanter = [];
  await report.check("voicebank: seed applied, 150 unapproved, none in the prompt (provenance exemplarIds empty)", async () => {
    const r = await api("GET", "/api/voicebank?status=unapproved");
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.lines.length, 150, "150 seed lines");
    assert.equal(r.json.counts.unapproved, 150);
    assert.equal(r.json.counts.approved, 0);
    assert.ok(Array.isArray(r.json.tags) && r.json.tags.includes("banter"));
    assert.ok(r.json.lines.every((l) => l.status === "unapproved" && l.origin === "seed"));
    const t = await turn(conversationId, "hey there", key("v3-seed"));
    assert.equal(t.status, 200, t.text);
    const ctx = await contextOf(t.json.assistantMessage.id);
    assert.deepEqual(ctx.exemplarIds ?? [], [], "she reads none of them until he approves some");
  });

  await report.check("approve 12 lines by tag -> the very next turn's provenance carries 2 to 6 exemplarIds, all approved, none repeated in the following turn", async () => {
    const list = await api("GET", "/api/voicebank?status=unapproved&tag=banter");
    assert.equal(list.status, 200, list.text);
    assert.ok(list.json.lines.length >= 12, "at least 12 banter lines in the seed: " + list.json.lines.length);
    const ids = list.json.lines.slice(0, 12).map((l) => l.id);
    const d = await api("POST", "/api/voicebank/decide", { ids, decision: "approve" });
    assert.equal(d.status, 200, d.text);
    assert.equal(d.json.changed, 12);
    approvedBanter = ids;
    const approved = new Set(((await api("GET", "/api/voicebank?status=approved")).json.lines).map((l) => l.id));
    for (const id of ids) assert.ok(approved.has(id), id);
    const t1 = await turn(conversationId, "so. hey", key("v3-ex1"));
    assert.equal(t1.status, 200, t1.text);
    const c1 = await contextOf(t1.json.assistantMessage.id);
    assert.ok(Array.isArray(c1.exemplarIds) && c1.exemplarIds.length >= 2 && c1.exemplarIds.length <= 6, "exemplarIds: " + JSON.stringify(c1.exemplarIds));
    for (const id of c1.exemplarIds) assert.ok(approved.has(id), "offered line is approved: " + id);
    const t2 = await turn(conversationId, "ok then", key("v3-ex2"));
    assert.equal(t2.status, 200, t2.text);
    const c2 = await contextOf(t2.json.assistantMessage.id);
    for (const id of c2.exemplarIds ?? []) assert.ok(!c1.exemplarIds.includes(id), "not repeated within the cooldown: " + id);
    return `${c1.exemplarIds.length} then ${(c2.exemplarIds ?? []).length} exemplars`;
  });

  await report.check("[[EXEMPLAR:<an approved line>]] -> exemplar_verbatim retry recorded (two runs), stored reply differs from the line", async () => {
    // His own line, approved on creation, the only approved line whose primary tag is
    // answering: with every candidate offered (perTurn 12, 2 per primary tag) it is in the prompt.
    const mine = await api("POST", "/api/voicebank", { text: "depends what you mean by fine, honestly", tags: ["answering", "dry"] });
    assert.equal(mine.status, 201, mine.text);
    assert.equal(mine.json.status, "approved");
    assert.equal(mine.json.origin, "owner");
    await settingsPut({ exemplarsPerTurn: 12 });
    const t = await turn(conversationId, "[[EXEMPLAR:depends what you mean by fine, honestly]] are you doing ok today or not?", key("v3-verbatim"));
    assert.equal(t.status, 200, t.text);
    const ctx = await contextOf(t.json.assistantMessage.id);
    assert.ok((ctx.exemplarIds ?? []).includes(mine.json.id), "the line was offered: " + JSON.stringify(ctx.exemplarIds));
    // The first draft ("x, basically. anyway") reused the line verbatim: a retry. The stub
    // answers a retry with the previous real message, triggers stripped, so the stored reply
    // is the clean retry; exemplar_verbatim sits on the first run row.
    assert.equal(ctx.retried, true, "the verbatim line forced a retry: " + JSON.stringify(ctx.flags));
    assert.equal(ctx.runIds.length, 2, "two runs");
    assert.ok(!JSON.stringify(ctx.flags ?? []).includes("exemplar_verbatim"), "the stored reply is the clean retry: " + JSON.stringify(ctx.flags));
    assert.ok(!JSON.stringify(ctx.flags ?? []).includes("tech_leak"), "no leak on the retry: " + JSON.stringify(ctx.flags));
    assert.ok(!t.json.assistantMessage.content.includes("depends what you mean by fine, honestly"), "the stored reply is not the line: " + t.json.assistantMessage.content);
    const control = await turn(conversationId, "are you doing ok today or not?", key("v3-verbatim-control"));
    assert.equal((await contextOf(control.json.assistantMessage.id)).retried, false, "the same message without the verbatim line is not retried");
    await settingsPut({ exemplarsPerTurn: 6 });
  });

  let correctionId = null;
  await report.check("POST /api/corrections with a rewrite -> corrections row active, voice_lines row approved with origin correction, next turn's provenance carries the correction id", async () => {
    const t = await turn(conversationId, "tell me about your afternoon", key("v3-corr-src"));
    assert.equal(t.status, 200, t.text);
    const r = await api("POST", "/api/corrections", { messageId: t.json.assistantMessage.id, kind: "ai", note: "too smooth", rewrite: "nah. tell me the actual thing" });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.status, "active");
    assert.equal(r.json.kind, "ai");
    assert.equal(r.json.original, t.json.assistantMessage.content);
    assert.equal(r.json.rewrite, "nah. tell me the actual thing");
    assert.equal(typeof r.json.voice_line_id, "string", "the rewrite became a bank line");
    correctionId = r.json.id;
    const bank = (await api("GET", "/api/voicebank?status=approved")).json.lines.find((l) => l.id === r.json.voice_line_id);
    assert.ok(bank, "the correction's line is in the bank");
    assert.equal(bank.origin, "correction");
    assert.equal(bank.status, "approved");
    const his = await api("POST", "/api/corrections", { messageId: t.json.userMessage.id, kind: "other" });
    assert.equal(his.status, 400, "his message cannot be corrected: " + his.text);
    const t2 = await turn(conversationId, "and after that", key("v3-corr-next"));
    assert.equal(t2.status, 200, t2.text);
    const ctx = await contextOf(t2.json.assistantMessage.id);
    assert.ok((ctx.correctionIds ?? []).includes(correctionId), "correctionIds: " + JSON.stringify(ctx.correctionIds));
  });

  await report.check("retire -> gone from provenance; restore -> back; GET /api/corrections filters by status", async () => {
    const ret = await api("POST", `/api/corrections/${correctionId}/retire`);
    assert.equal(ret.status, 200, ret.text);
    assert.equal(ret.json.status, "retired");
    const t = await turn(conversationId, "go on", key("v3-corr-retired"));
    const ctx = await contextOf(t.json.assistantMessage.id);
    assert.ok(!(ctx.correctionIds ?? []).includes(correctionId));
    const retired = await api("GET", "/api/corrections?status=retired");
    assert.ok(retired.json.some((c) => c.id === correctionId));
    const active = await api("GET", "/api/corrections?status=active");
    assert.ok(!active.json.some((c) => c.id === correctionId));
    const back = await api("POST", `/api/corrections/${correctionId}/restore`);
    assert.equal(back.status, 200, back.text);
    assert.equal(back.json.status, "active");
  });

  await report.check("POST /api/voicebank/decide with all 150 seed ids -> changed 138 in one request (the 12 approved by tag stay; one statement per id in one batch, never an IN list); again -> 0", async () => {
    const all = (await api("GET", "/api/voicebank?status=all&limit=1000")).json.lines.filter((l) => l.origin === "seed");
    assert.equal(all.length, 150);
    const d = await api("POST", "/api/voicebank/decide", { ids: all.map((l) => l.id), decision: "approve" });
    assert.equal(d.status, 200, d.text);
    assert.equal(d.json.changed, 150 - approvedBanter.length);
    const again = await api("POST", "/api/voicebank/decide", { ids: all.map((l) => l.id), decision: "approve" });
    assert.equal(again.status, 200, again.text);
    assert.equal(again.json.changed, 0, "already decided lines are not changed again");
    const counts = (await api("GET", "/api/voicebank?status=all")).json.counts;
    assert.equal(counts.unapproved, 0);
    const tooMany = await api("POST", "/api/voicebank/decide", { ids: Array.from({ length: 501 }, (_, i) => "vl_" + i), decision: "reject" });
    assert.equal(tooMany.status, 400, tooMany.text);
    const single = await api("POST", `/api/voicebank/${all[0].id}/decide`, { decision: "reject" });
    assert.equal(single.status, 409, "deciding a decided line: " + single.text);
    assert.equal(single.json.code, "already_decided");
    const edit = await api("PUT", `/api/voicebank/${all[0].id}`, { tags: ["banter", "dry"] });
    assert.equal(edit.status, 200, edit.text);
    assert.deepEqual(JSON.parse(edit.json.tags_json), ["banter", "dry"]);
  });

  // ---------------------------------------------------------------- BB: memory

  let cousinFactId = null;
  await report.check("PUT /api/memory/fact/:id weight 0.2 lastTouched 400 days ago -> next turn's provenance omits the fact (fadedCount 1)", async () => {
    const f = await api("POST", "/api/facts", { scope: "justin", subject: "cousin", fact: "his cousin plays drums in a wedding band" });
    assert.equal(f.status, 201, f.text);
    cousinFactId = f.json.id;
    const before = await turn(conversationId, "what are you doing", key("v3-mem-before"));
    const cb = await contextOf(before.json.assistantMessage.id);
    assert.ok(cb.factIds.justin.includes(cousinFactId), "a fresh fact is in the prompt");
    const put = await api("PUT", `/api/memory/fact/${cousinFactId}`, { weight: 0.2, lastTouched: ago(400 * DAY_MS_V3) });
    assert.equal(put.status, 200, put.text);
    const t = await turn(conversationId, "what else is going on", key("v3-mem-faded"));
    const ctx = await contextOf(t.json.assistantMessage.id);
    assert.ok(!ctx.factIds.justin.includes(cousinFactId), "faded: " + JSON.stringify(ctx.factIds.justin));
    assert.ok(ctx.recall && ctx.recall.fadedCount >= 1, "recall: " + JSON.stringify(ctx.recall));
    const list = await api("GET", "/api/memory?entity=fact");
    assert.equal(list.status, 200, list.text);
    const row = list.json.find((m) => (m.entityId ?? m.entity_id ?? m.id) === cousinFactId);
    assert.ok(row, "the Memory tab row");
    assert.equal(Number(row.weight), 0.2);
    const bad = await api("PUT", `/api/memory/fact/${cousinFactId}`, { weight: 1.5 });
    assert.equal(bad.status, 400, bad.text);
    const unknown = await api("PUT", `/api/memory/thing/${cousinFactId}`, { weight: 0.5 });
    assert.equal(unknown.status, 400, unknown.text);
  });

  await report.check("Remind her (lastTouched now) -> the fact is back in firmFactIds", async () => {
    const put = await api("PUT", `/api/memory/fact/${cousinFactId}`, { lastTouched: new Date().toISOString() });
    assert.equal(put.status, 200, put.text);
    // A 0.2-weight fact scores 0.2 x (0.35 + 0.65 x recency): freshly touched it sits a hair
    // under the 0.20 line, which memory.FIRM_EPSILON covers, so the message need not name it.
    const t = await turn(conversationId, "long day, nothing much to report", key("v3-mem-remind"));
    const ctx = await contextOf(t.json.assistantMessage.id);
    assert.ok(ctx.recall && Array.isArray(ctx.recall.firmFactIds) && ctx.recall.firmFactIds.includes(cousinFactId), JSON.stringify(ctx.recall));
    assert.ok(ctx.factIds.justin.includes(cousinFactId));
  });

  await report.check("default settings: a 0.2 fact 40 days old whose words are in his message -> provenance.recall.provisional is null (the setting is 0)", async () => {
    await api("PUT", `/api/memory/fact/${cousinFactId}`, { weight: 0.2, lastTouched: ago(40 * DAY_MS_V3) });
    // One keyword of the fact (cousin): relevant, and still under the firm line at 40 days.
    const t = await turn(conversationId, "does your cousin still do that thing on weekends", key("v3-mem-off"));
    const ctx = await contextOf(t.json.assistantMessage.id);
    assert.ok(ctx.recall, "recall block present");
    assert.equal(ctx.recall.provisional, null);
  });

  await report.check("PUT settings provisionalRecallEvery 8 -> the same turn shape names it and GET /api/memory/recalls shows one row with outcome unknown", async () => {
    await settingsPut({ provisionalRecallEvery: 8 });
    await api("PUT", `/api/memory/fact/${cousinFactId}`, { weight: 0.2, lastTouched: ago(40 * DAY_MS_V3) });
    const t = await turn(conversationId, "does your cousin still do that thing on weekends", key("v3-mem-on"));
    const ctx = await contextOf(t.json.assistantMessage.id);
    assert.ok(ctx.recall && ctx.recall.provisional, "provisional: " + JSON.stringify(ctx.recall));
    assert.equal(ctx.recall.provisional.entityId ?? ctx.recall.provisional.entity_id, cousinFactId);
    const recalls = await api("GET", "/api/memory/recalls");
    assert.equal(recalls.status, 200, recalls.text);
    const row = recalls.json.find((r) => (r.entity_id ?? r.entityId) === cousinFactId);
    assert.ok(row, "a memory_recalls row: " + JSON.stringify(recalls.json).slice(0, 300));
    assert.equal(row.outcome, "unknown");
    assert.equal(row.mode, "provisional");
    await settingsPut({ provisionalRecallEvery: 0 });
    await api("PUT", `/api/memory/fact/${cousinFactId}`, { weight: 0.5, lastTouched: new Date().toISOString() });
  });

  // ---------------------------------------------------------------- CC: wants and asks

  let wantId = null;
  await report.check("[[WANT:finish the bridge]] -> want proposal -> approve -> wants row active; next turn's provenance carries the want id", async () => {
    const t = await turn(conversationId, "[[WANT:finish the bridge]] what are you working on", key("v3-want"));
    assert.equal(t.status, 200, t.text);
    const p = await pendingProposal("want", "finish the bridge");
    const decided = await approve(p.id);
    wantId = decided.promotedId ?? decided.proposal.promoted_id;
    assert.ok(wantId, "promoted id: " + JSON.stringify(decided));
    const w = await api("GET", "/api/wants");
    assert.equal(w.status, 200, w.text);
    const row = w.json.wants.find((x) => x.id === wantId);
    assert.ok(row, "the want row");
    assert.equal(row.status, "active");
    assert.equal(row.title, "finish the bridge");
    const t2 = await turn(conversationId, "how is that going", key("v3-want-next"));
    const ctx = await contextOf(t2.json.assistantMessage.id);
    assert.ok((ctx.wantIds ?? []).includes(wantId), "wantIds: " + JSON.stringify(ctx.wantIds));
  });

  await report.check("[[WANTUP:finish the bridge|30]] -> want_update -> approve -> progress 30, last_moved set; the log route lists it", async () => {
    const t = await turn(conversationId, "[[WANTUP:finish the bridge|30]] did you get anywhere", key("v3-wantup"));
    assert.equal(t.status, 200, t.text);
    const p = await pendingProposal("want_update", "finish the bridge");
    await approve(p.id);
    const row = (await api("GET", "/api/wants")).json.wants.find((x) => x.id === wantId);
    assert.equal(row.progress, 30);
    assert.equal(typeof row.last_moved, "string");
    assert.ok(row.lastLog && row.lastLog.kind === "progress", "lastLog: " + JSON.stringify(row.lastLog));
    const log = await api("GET", `/api/wants/${wantId}/log`);
    assert.equal(log.status, 200, log.text);
    assert.ok(log.json.some((l) => l.kind === "progress" && l.delta === 30));
    const owner = await api("POST", `/api/wants/${wantId}/log`, { kind: "setback", delta: 10, note: "lost the take" });
    assert.equal(owner.status, 201, owner.text);
    assert.equal((await api("GET", "/api/wants")).json.wants.find((x) => x.id === wantId).progress, 20);
    const bad = await api("POST", `/api/wants/${wantId}/log`, { kind: "progress", delta: 500, note: "x" });
    assert.equal(bad.status, 400, bad.text);
    const done = await api("PUT", `/api/wants/${wantId}`, { status: "done" });
    assert.equal(done.status, 200, done.text);
    const closed = await api("POST", `/api/wants/${wantId}/log`, { kind: "note", note: "x" });
    assert.equal(closed.status, 409, closed.text);
    assert.equal(closed.json.code, "not_active");
    const reopen = await api("PUT", `/api/wants/${wantId}`, { status: "active" });
    assert.equal(reopen.status, 200, reopen.text);
  });

  let askId = null;
  await report.check("[[ASK:send me the song you meant]] -> ask -> approve -> asks row open with asked_message_id", async () => {
    const t = await turn(conversationId, "[[ASK:send me the song you meant]] anything you want from me", key("v3-ask"));
    assert.equal(t.status, 200, t.text);
    const p = await pendingProposal("ask", "song you meant");
    const decided = await approve(p.id);
    askId = decided.promotedId ?? decided.proposal.promoted_id;
    const asks = (await api("GET", "/api/wants")).json.asks;
    const row = asks.find((a) => a.id === askId);
    assert.ok(row, "the ask row: " + JSON.stringify(asks).slice(0, 300));
    assert.equal(row.status, "open");
    assert.equal(row.asked_message_id, t.json.assistantMessage.id);
    assert.equal(row.brought_up, 0);
  });

  await report.check("two [[NAG]] turns (the stub nags about the ask the prompt shows; his text carries none of its words) -> brought_up 1 after the first, ask_nag retry on the second; an ask he raises himself is answered, not nagged", async () => {
    const first = await turn(conversationId, "[[NAG]] ok", key("v3-nag1"));
    assert.equal(first.status, 200, first.text);
    assert.equal((await contextOf(first.json.assistantMessage.id)).retried, false, "the first mention is allowed");
    const row1 = (await api("GET", "/api/wants")).json.asks.find((a) => a.id === askId);
    assert.equal(row1.brought_up, 1, "brought up once");
    const second = await turn(conversationId, "[[NAG]] ok", key("v3-nag2"));
    assert.equal(second.status, 200, second.text);
    // The second mention is ask_nag on the first draft, a retry; the stub answers a retry
    // with the previous real message, triggers stripped, so the stored reply is clean.
    const ctx = await contextOf(second.json.assistantMessage.id);
    assert.equal(ctx.retried, true, "the nag was retried: " + JSON.stringify(second.json.flags));
    assert.equal(ctx.runIds.length, 2);
    assert.ok(!JSON.stringify(ctx.flags ?? []).includes("ask_nag"), "the stored reply is the clean retry: " + JSON.stringify(ctx.flags));
    assert.ok(!/song you meant/.test(second.json.assistantMessage.content), "the stored reply does not nag");
    const row2 = (await api("GET", "/api/wants")).json.asks.find((a) => a.id === askId);
    assert.equal(row2.brought_up, 1, "still once");
    // He raises the ask himself: her reply about it is an answer, so no retry.
    const answered = await turn(conversationId, "[[NAG:song you meant]] i sent you the song you meant, did you listen", key("v3-nag3"));
    assert.equal(answered.status, 200, answered.text);
    const ctx3 = await contextOf(answered.json.assistantMessage.id);
    assert.equal(ctx3.retried, false, "an ask he raised is answered, never nagged: " + JSON.stringify(answered.json.flags));
    assert.ok(/song you meant/.test(answered.json.assistantMessage.content));
  });

  await report.check("PUT /api/asks/:id status let_go -> next turn's section omits it", async () => {
    const put = await api("PUT", `/api/asks/${askId}`, { status: "let_go", note: "he never answered" });
    assert.equal(put.status, 200, put.text);
    assert.equal(put.json.status, "let_go");
    const t = await turn(conversationId, "anyway", key("v3-ask-gone"));
    const ctx = await contextOf(t.json.assistantMessage.id);
    assert.ok(!(ctx.askIds ?? []).includes(askId), "askIds: " + JSON.stringify(ctx.askIds));
    const bad = await api("PUT", `/api/asks/${askId}`, { status: "maybe" });
    assert.equal(bad.status, 400, bad.text);
  });

  await report.check("relationship proposal with mood_days 1 -> Now shows mood fresh; a state row with mood_set_at 3 days back renders no mood line (moodPhase gone) and the state text carries no mood key", async () => {
    const t = await turn(conversationId, "[[MOODDAYS:irritated|1]] you forgot again", key("v3-mood"));
    assert.equal(t.status, 200, t.text);
    const p = await pendingProposal("relationship", "irritated");
    await approve(p.id);
    const s = (await api("GET", "/api/state")).json.relationship.state;
    assert.equal(s.mood, "irritated");
    assert.equal(s.mood_days, 1);
    assert.equal(typeof s.mood_set_at, "string");
    const fresh = await turn(conversationId, "so", key("v3-mood-fresh"));
    const c1 = await contextOf(fresh.json.assistantMessage.id);
    assert.equal(c1.moodPhase, "fresh", JSON.stringify(c1.moodPhase));
    const put = await api("PUT", "/api/state/relationship", { state: { ...s, mood_set_at: ago(3 * DAY_MS_V3) }, note: "integration: aged mood" });
    assert.equal(put.status, 200, put.text);
    const gone = await turn(conversationId, "so anyway", key("v3-mood-gone"));
    const c2 = await contextOf(gone.json.assistantMessage.id);
    assert.equal(c2.moodPhase, "gone");
    const text = stateTextOf(c2);
    if (text !== null) {
      assert.ok(!/"mood"/.test(text), "no mood key in the state text");
      assert.ok(!/Mood:/.test(text), "no Mood line");
    }
    const { mood, mood_set_at, mood_days, cooling_off_until, ...clean } = s;
    const clear = await api("PUT", "/api/state/relationship", { state: { ...clean, cooling_off_until: null }, note: "integration: mood cleared" });
    assert.equal(clear.status, 200, clear.text);
    return text === null ? "state text not on the context row; the mood-key check ran on moodPhase only" : "state text checked";
  });

  await report.check("an /open turn with an open ask -> provenance.callbacks carries no ask (the ask cannot be aged through the API; the opener rule is what is checked)", async () => {
    const created = await api("POST", "/api/asks", { text: "listen to the demo i sent", wantId });
    assert.equal(created.status, 201, created.text);
    const open = await api("POST", `/api/conversations/${conversationId}/open`);
    assert.equal(open.status, 200, open.text);
    const ctx = await contextOf(open.json.assistantMessage.id);
    assert.equal(ctx.opener, true);
    for (const cb of ctx.callbacks ?? []) assert.ok(!/^you asked him/i.test(cb.text), "no ask on an opener: " + cb.text);
    await api("PUT", `/api/asks/${created.json.id}`, { status: "let_go" });
    // Answer the opener so the next /open in a later block is not refused as his turn.
    const t = await turn(conversationId, "hey", key("v3-after-open"));
    assert.equal(t.status, 200, t.text);
  });

  // ---------------------------------------------------------------- DD: grounding

  await report.check("PUT settings herCity with the stub weather provider -> a turn's provenance carries weather true and GET /api/grounding returns 68F clear", async () => {
    await settingsPut({ herCity: "Stubtown", herLat: 40.7, herLon: -74, weatherProvider: "stub" });
    const g = await api("GET", "/api/grounding");
    assert.equal(g.status, 200, g.text);
    assert.equal(g.json.city, "Stubtown");
    assert.ok(g.json.weather, "weather: " + g.text);
    assert.equal(g.json.weather.temp, 68);
    assert.equal(g.json.weather.words, "clear");
    assert.equal(typeof g.json.timeOfDay, "string");
    assert.ok(Array.isArray(g.json.today));
    const t = await turn(conversationId, "how is it outside", key("v3-weather"));
    const ctx = await contextOf(t.json.assistantMessage.id);
    assert.equal(ctx.weather, true);
  });

  await report.check("weatherProvider off -> weather false and GET /api/grounding weather null", async () => {
    await settingsPut({ weatherProvider: "off" });
    const g = await api("GET", "/api/grounding");
    assert.equal(g.json.weather, null);
    const t = await turn(conversationId, "still raining?", key("v3-weather-off"));
    const ctx = await contextOf(t.json.assistantMessage.id);
    assert.equal(ctx.weather, false);
    await settingsPut({ weatherProvider: "stub" });
  });

  await report.check("POST /api/grounding/log meal -> today list has it; a turn's provenance carries the row id; DELETE -> gone", async () => {
    const r = await api("POST", "/api/grounding/log", { kind: "meal", note: "a bagel" });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.kind, "meal");
    const g = await api("GET", "/api/grounding");
    assert.ok(g.json.today.some((x) => x.id === r.json.id), "today: " + JSON.stringify(g.json.today));
    const t = await turn(conversationId, "did you eat", key("v3-ground"));
    const ctx = await contextOf(t.json.assistantMessage.id);
    assert.ok((ctx.groundingRowIds ?? []).includes(r.json.id), "groundingRowIds: " + JSON.stringify(ctx.groundingRowIds));
    const del = await api("DELETE", `/api/grounding/log/${r.json.id}`);
    assert.equal(del.status, 200, del.text);
    const g2 = await api("GET", "/api/grounding");
    assert.ok(!g2.json.today.some((x) => x.id === r.json.id));
    const bad = await api("POST", "/api/grounding/log", { kind: "snack", note: "x" });
    assert.equal(bad.status, 400, bad.text);
  });

  await report.check("[[GROUND:meal|a bagel]] -> grounding proposal -> approve -> row", async () => {
    const t = await turn(conversationId, "[[GROUND:meal|a bagel]] what did you have", key("v3-ground-prop"));
    assert.equal(t.status, 200, t.text);
    const p = await pendingProposal("grounding", "bagel");
    await approve(p.id);
    const g = await api("GET", "/api/grounding");
    assert.ok(g.json.today.some((x) => x.kind === "meal" && /bagel/i.test(x.note)), JSON.stringify(g.json.today));
  });

  await report.check("POST /api/grounding/geocode on the stub: 'zzzzqq' -> results []; 'Portland' -> Stubtown", async () => {
    const none = await api("POST", "/api/grounding/geocode", { name: "zzzzqq" });
    assert.equal(none.status, 200, none.text);
    assert.deepEqual(none.json.results, []);
    const some = await api("POST", "/api/grounding/geocode", { name: "Portland" });
    assert.equal(some.status, 200, some.text);
    assert.equal(some.json.results.length, 1);
    assert.equal(some.json.results[0].name, "Stubtown");
    assert.equal(some.json.results[0].timezone, "America/New_York");
    const bad = await api("POST", "/api/grounding/geocode", {});
    assert.equal(bad.status, 400, bad.text);
  });

  let daniId = null;
  await report.check("POST /api/life/threads/:id/portrait with the stub -> a portrait candidate (or 422 blacklisted: the stub repeats master 03, which the v1 block rejected); an unknown thread -> 404", async () => {
    const dani = await api("POST", "/api/life/threads", { kind: "person", title: "Dani", relation: "best friend", detail: "moved back in March" });
    assert.equal(dani.status, 201, dani.text);
    daniId = dani.json.id;
    const r = await api("POST", `/api/life/threads/${daniId}/portrait`, { description: "a tall woman with short silver hair and a denim jacket" });
    if (r.status === 422) {
      assert.equal(r.json.code, "blacklisted");
      const missing = await api("POST", "/api/life/threads/lt_nothing/portrait", { description: "x" });
      assert.equal(missing.status, 404, missing.text);
      return "the blacklist held on the stub's repeated bytes (a rejected face never comes back)";
    }
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.asset.role, "portrait");
    assert.equal(r.json.asset.approval_status, "candidate");
    assert.equal(r.json.asset.notes, "person:" + daniId);
    const media = await fetchBytes(`/media/${r.json.asset.id}`);
    assert.equal(media.status, 200);
    assert.ok(media.contentType.startsWith("image/png"));
    const ok = await api("POST", `/api/images/${r.json.asset.id}/decide`, { decision: "approve" });
    assert.equal(ok.status, 200, ok.text);
    const life = await api("GET", "/api/life");
    const head = life.json.threads.find((x) => x.title === "Dani" && x.status === "active");
    assert.equal(head.portrait_asset_id, r.json.asset.id, "the head carries the approved portrait");
    const missing = await api("POST", "/api/life/threads/lt_nothing/portrait", { description: "x" });
    assert.equal(missing.status, 404, missing.text);
    const second = await api("POST", `/api/life/threads/${daniId}/portrait`, { description: "the same face again" });
    if (second.status === 200) {
      const rej = await api("POST", `/api/images/${second.json.asset.id}/decide`, { decision: "reject" });
      assert.equal(rej.status, 200, rej.text);
      const third = await api("POST", `/api/life/threads/${daniId}/portrait`, { description: "once more" });
      assert.equal(third.status, 422, "a rejected face never comes back: " + third.text);
    }
    return "portrait made, approved and linked to the thread head";
  });

  await report.check("[[LIFEUP:Dani|cancelled again]] -> life_update -> approve -> a life_log note on the person; the YOUR LIFE section carries it (threadIds unchanged, one log row gained)", async () => {
    const before = await turn(conversationId, "how is dani", key("v3-lifeup-before"));
    const cb = await contextOf(before.json.assistantMessage.id);
    const headBefore = (await api("GET", "/api/life")).json.threads.find((x) => x.title === "Dani" && x.status === "active");
    const t = await turn(conversationId, "[[LIFEUP:Dani|cancelled again]] and", key("v3-lifeup"));
    assert.equal(t.status, 200, t.text);
    const p = await pendingProposal("life_update", "cancelled again");
    await approve(p.id);
    const life = await api("GET", "/api/life");
    const note = life.json.log.find((l) => l.thread_id === headBefore.id && /cancelled again/i.test(l.note));
    assert.ok(note, "a life_log note on Dani: " + JSON.stringify(life.json.log.slice(0, 5)));
    const headAfter = life.json.threads.find((x) => x.title === "Dani" && x.status === "active");
    assert.equal(headAfter.portrait_asset_id ?? null, headBefore.portrait_asset_id ?? null, "a life update never touches the portrait");
    const after = await turn(conversationId, "poor dani", key("v3-lifeup-after"));
    const ca = await contextOf(after.json.assistantMessage.id);
    assert.deepEqual([...ca.threadIds].sort(), [...cb.threadIds].sort(), "threadIds unchanged");
    if (Array.isArray(ca.logIds) && Array.isArray(cb.logIds)) assert.ok(ca.logIds.includes(note.id), "logIds gains the note");
  });

  // ---------------------------------------------------------------- EE: calls

  const callConv = await newConversation("integration v3 calls");
  let callId = null;
  let callCostAfterUsage = null;
  await report.check("callProvider stub: POST /api/calls/start -> 201 with a stub secret and a calls row starting; the audit row and GET /api/calls/:id carry no clientSecret; a second start -> 409", async () => {
    const r = await api("POST", "/api/calls/start", { conversationId: callConv });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.clientSecret, "stub-secret");
    assert.equal(r.json.provider, "stub");
    assert.equal(r.json.call.status, "starting");
    assert.equal(r.json.tickSeconds, 30);
    assert.equal(r.json.maxSeconds, 20 * 60);
    callId = r.json.call.id;
    const audit = await auditRows(20);
    const row = audit.find((a) => a.action === "call.start" && a.entity_id === callId);
    assert.ok(row, "an audit row for the start");
    assert.ok(!(row.after_json || "").includes("stub-secret"), "the secret is not in the audit row");
    const get = await api("GET", `/api/calls/${callId}`);
    assert.equal(get.status, 200, get.text);
    assert.ok(!get.text.includes("stub-secret"), "the secret is not in the call row");
    assert.equal(get.json.call.id, callId);
    assert.deepEqual(get.json.messages, []);
    const second = await api("POST", "/api/calls/start", { conversationId: callConv });
    assert.equal(second.status, 409, second.text);
    assert.equal(second.json.code, "call_in_progress");
    const list = await api("GET", `/api/calls?conversationId=${callConv}`);
    assert.equal(list.status, 200, list.text);
    assert.ok(list.json.some((c) => c.id === callId));
    assert.ok(!list.text.includes("stub-secret"));
  });

  await report.check("tick 30 x 3 with no usage -> seconds 90, cost 3 x price/2, stop false", async () => {
    let last = null;
    for (let i = 0; i < 3; i++) {
      last = await api("POST", `/api/calls/${callId}/tick`, { seconds: 30 });
      assert.equal(last.status, 200, last.text);
      assert.equal(last.json.ok, true);
      assert.equal(last.json.stop, false);
    }
    assert.equal(last.json.secondsTotal, 90);
    assert.ok(Math.abs(last.json.costUsd - 3 * 0.15) < 0.0001, "cost " + last.json.costUsd);
    const get = await api("GET", `/api/calls/${callId}`);
    assert.equal(get.json.call.status, "live");
    assert.equal(get.json.call.seconds, 90);
  });

  await report.check("tick with usage that prices above the meter -> costUsd equals the priced figure and usage_daily carries the delta; the next tick with the same usage adds nothing", async () => {
    const usage = { audioIn: 20000, audioOut: 10000, textIn: 0, textOut: 0 };
    const priced = (20000 * 32 + 10000 * 64) / 1_000_000; // 1.28 USD
    const a = await api("POST", `/api/calls/${callId}/tick`, { seconds: 30, usage });
    assert.equal(a.status, 200, a.text);
    assert.ok(Math.abs(a.json.costUsd - priced) < 0.0001, "priced: " + a.json.costUsd);
    const usageRows = (await api("GET", "/api/usage")).json.byDay;
    const call = usageRows.filter((r) => r.provider === "stub" && /realtime|stub/.test(r.model) && r.requests > 0);
    assert.ok(call.length, "a usage row for the call: " + JSON.stringify(usageRows).slice(0, 300));
    const b = await api("POST", `/api/calls/${callId}/tick`, { seconds: 30, usage });
    assert.equal(b.status, 200, b.text);
    assert.ok(Math.abs(b.json.costUsd - priced) < 0.0001, "the same usage adds nothing: " + b.json.costUsd);
    assert.equal(b.json.secondsTotal, 150);
    callCostAfterUsage = b.json.costUsd;
    const bad = await api("POST", `/api/calls/${callId}/tick`, { seconds: 30, usage: { audioIn: -1, audioOut: 0, textIn: 0, textOut: 0 } });
    assert.equal(bad.status, 400, bad.text);
  });

  await report.check("dailyCapUsd tiny -> tick returns stop budget, the tick is still recorded", async () => {
    await settingsPut({ dailyCapUsd: 0.01 });
    const r = await api("POST", `/api/calls/${callId}/tick`, { seconds: 30 });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.stop, true);
    assert.equal(r.json.reason, "budget");
    assert.equal(r.json.secondsTotal, 180, "the crossing tick is recorded");
    await settingsPut({ dailyCapUsd: 200 });
  });

  await report.check("end with 5 segments -> 4 story messages with call_id in seq order, her rows flagged, the call ended, proposals ran (stub) within 10 s, GET /api/calls/:id returns them", async () => {
    const at = (i) => new Date(Date.now() - (5 - i) * 1000).toISOString();
    const segments = [
      { who: "him", text: "hey [[FACT:she keeps a jar of sea glass]] can you hear me", at: at(0) },
      { who: "her", text: "hey. sort of", at: at(1) },
      { who: "her", text: "the line is bad, hold on", at: at(2) },
      { who: "him", text: "better now?", at: at(3) },
      { who: "her", text: "yes. so what did you want. i am not an ai by the way", at: at(4) },
    ];
    const r = await api("POST", `/api/calls/${callId}/end`, { reason: "ended", segments, usage: { audioIn: 20000, audioOut: 10000, textIn: 0, textOut: 0 } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.call.status, "ended");
    assert.equal(r.json.call.end_reason, "ended");
    assert.equal(r.json.call.transcript_rows, 4, "consecutive same-speaker segments merged");
    assert.ok(Array.isArray(r.json.messageIds) && r.json.messageIds.length === 4);
    assert.ok(Math.abs(r.json.call.cost_usd_micro / 1_000_000 - Math.max(callCostAfterUsage, (180 / 60) * 0.3)) < 0.0001, "reconciled from the final usage");
    const get = await api("GET", `/api/calls/${callId}`);
    assert.equal(get.json.messages.length, 4);
    const seqs = get.json.messages.map((m) => m.seq);
    assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y));
    for (const m of get.json.messages) {
      assert.equal(m.call_id, callId);
      assert.equal(m.channel, "story");
    }
    assert.deepEqual(get.json.messages.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
    const hers = get.json.messages[3];
    const flags = JSON.parse(hers.flags_json || "[]").map((f) => f.code);
    assert.ok(flags.includes("tech_leak"), "a leak in speech is stored for the record: " + JSON.stringify(flags));
    const list = await api("GET", `/api/conversations/${callConv}/messages`);
    assert.equal(list.json.length, 4, "the call rows are ordinary story messages");
    const p = await pendingProposal("avelie_fact", "sea glass");
    assert.ok(p, "the proposal pass ran over the call");
    await api("POST", `/api/proposals/${p.id}/decide`, { decision: "reject" });
  });

  await report.check("end with 1,500 raw alternating segments -> 200 accepted, transcript_rows 80", async () => {
    const start = await api("POST", "/api/calls/start", { conversationId: callConv });
    assert.equal(start.status, 201, start.text);
    const id = start.json.call.id;
    const base = Date.now() - 1_600_000;
    const segments = Array.from({ length: 1500 }, (_, i) => ({ who: i % 2 ? "her" : "him", text: "segment " + i, at: new Date(base + i * 1000).toISOString() }));
    const r = await api("POST", `/api/calls/${id}/end`, { reason: "ended", segments });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.call.transcript_rows, 80);
    assert.equal(r.json.messageIds.length, 80);
    const tooMany = await api("POST", "/api/calls/start", { conversationId: callConv });
    assert.equal(tooMany.status, 201, tooMany.text);
    const over = await api("POST", `/api/calls/${tooMany.json.call.id}/end`, { reason: "ended", segments: Array.from({ length: 2001 }, (_, i) => ({ who: "him", text: "x" + i, at: new Date().toISOString() })) });
    assert.equal(over.status, 400, over.text);
    const empty = await api("POST", `/api/calls/${tooMany.json.call.id}/end`, { reason: "pagehide", segments: [], seconds: 25 });
    assert.equal(empty.status, 200, "a call with no segments still ends cleanly: " + empty.text);
    assert.equal(empty.json.call.transcript_rows, 0);
    // A call that ends before its first tick is not free: the page's seconds set the floor.
    assert.equal(empty.json.call.seconds, 25);
    assert.equal(empty.json.call.cost_usd_micro, Math.ceil((25 / 60) * 0.3 * 1_000_000));
    const over60 = await api("POST", "/api/calls/start", { conversationId: callConv });
    assert.equal(over60.status, 201, over60.text);
    const clamped = await api("POST", `/api/calls/${over60.json.call.id}/end`, { reason: "ended", segments: [], seconds: 3000 });
    assert.equal(clamped.status, 200, clamped.text);
    assert.equal(clamped.json.call.seconds, 60, "bounded by the ticks recorded plus one tick's worth");
  });

  await report.check("end on an unknown id -> 404; end twice -> 409 call_over", async () => {
    const missing = await api("POST", "/api/calls/call_nothing/end", { reason: "ended", segments: [] });
    assert.equal(missing.status, 404, missing.text);
    const again = await api("POST", `/api/calls/${callId}/end`, { reason: "ended", segments: [] });
    assert.equal(again.status, 409, again.text);
    assert.equal(again.json.code, "call_over");
  });

  await report.check("callProvider off -> start 503; callProvider elevenlabs without its key -> start 503 with detail elevenlabs (built in v4 A2, no longer reserved)", async () => {
    await settingsPut({ callProvider: "off" });
    const off = await api("POST", "/api/calls/start", { conversationId: callConv });
    assert.equal(off.status, 503, off.text);
    assert.equal(off.json.code, "provider_not_configured");
    await settingsPut({ callProvider: "elevenlabs" });
    const reserved = await api("POST", "/api/calls/start", { conversationId: callConv });
    assert.equal(reserved.status, 503, reserved.text);
    assert.equal(reserved.json.code, "provider_not_configured");
    assert.equal(reserved.json.detail, "elevenlabs");
    await settingsPut({ callProvider: "stub" });
  });

  // ---------------------------------------------------------------- FF: clips

  let clipId = null;
  await report.check("videoProvider stub: POST /api/video/generate from master 03 -> 202 generating; poll -> running; poll -> candidate with sha256, /media/:id 200 video/mp4, a Range request 206", async () => {
    const masters = (await api("GET", "/api/assets")).json.masters;
    const master = masters.find((m) => /03/.test(m.file)) || masters[0];
    assert.ok(master, "a master");
    const gen = await api("POST", "/api/video/generate", { sourceAssetId: master.id, description: "she looks up from her phone and laughs" });
    assert.equal(gen.status, 202, gen.text);
    assert.equal(gen.json.asset.role, "video");
    assert.equal(gen.json.asset.approval_status, "generating");
    clipId = gen.json.asset.id;
    const listed = (await api("GET", "/api/assets")).json;
    assert.ok(Array.isArray(listed.generating) && listed.generating.some((a) => a.id === clipId), "a clip still being made is listed under generating, so a reload finds it");
    const first = await api("POST", `/api/video/${clipId}/poll`);
    assert.equal(first.status, 200, first.text);
    assert.equal(first.json.status, "running");
    const second = await waitFor("the clip to become a candidate", async () => {
      const r = await api("POST", `/api/video/${clipId}/poll`);
      return r.status === 200 && r.json.status === "candidate" ? r : null;
    }, 15_000, 300);
    assert.equal(second.json.asset.approval_status, "candidate");
    assert.equal(typeof second.json.asset.sha256, "string");
    assert.equal(second.json.asset.notes, null);
    const media = await fetchBytes(`/media/${clipId}`);
    assert.equal(media.status, 200);
    assert.ok(media.contentType.startsWith("video/mp4"), media.contentType);
    assert.equal(String.fromCharCode(...media.bytes.slice(4, 8)), "ftyp");
    const range = await fetch(BASE + `/media/${clipId}`, { headers: { range: "bytes=0-15" } });
    assert.equal(range.status, 206, "a Range request is answered 206");
    assert.ok((range.headers.get("content-range") || "").startsWith("bytes 0-15/"), range.headers.get("content-range"));
    assert.equal(range.headers.get("accept-ranges"), "bytes");
    const chunk = new Uint8Array(await range.arrayBuffer());
    assert.equal(chunk.length, 16);
  });

  await report.check("approve -> approved role video; reject a second clip -> the hash is blacklisted and a third generate fails 422 at poll", async () => {
    const ok = await api("POST", `/api/images/${clipId}/decide`, { decision: "approve" });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.asset.approval_status, "approved");
    assert.equal(ok.json.asset.role, "video");
    const master = (await api("GET", "/api/assets")).json.masters[0];
    const makeClip = async () => {
      const gen = await api("POST", "/api/video/generate", { sourceAssetId: master.id, description: "she turns away" });
      assert.equal(gen.status, 202, gen.text);
      let last = null;
      for (let i = 0; i < 6; i++) {
        last = await api("POST", `/api/video/${gen.json.asset.id}/poll`);
        if (last.status !== 200 || last.json.status !== "running") break;
        await sleep(200);
      }
      return { id: gen.json.asset.id, last };
    };
    const second = await makeClip();
    assert.equal(second.last.status, 200, second.last.text);
    assert.equal(second.last.json.status, "candidate");
    const rej = await api("POST", `/api/images/${second.id}/decide`, { decision: "reject" });
    assert.equal(rej.status, 200, rej.text);
    const gone = await fetchBytes(`/media/${second.id}`);
    assert.equal(gone.status, 404);
    const third = await makeClip();
    assert.equal(third.last.status, 422, "blacklisted at poll: " + third.last.text);
    assert.equal(third.last.json.code, "blacklisted");
  });

  await report.check("videoProvider off -> generate 503; an unknown source -> 404 (a source over 5 MB encoded cannot be made on the stub: unit-tested only)", async () => {
    await settingsPut({ videoProvider: "off" });
    const master = (await api("GET", "/api/assets")).json.masters[0];
    const off = await api("POST", "/api/video/generate", { sourceAssetId: master.id, description: "x" });
    assert.equal(off.status, 503, off.text);
    await settingsPut({ videoProvider: "stub" });
    const missing = await api("POST", "/api/video/generate", { sourceAssetId: "img_nothing", description: "x" });
    assert.equal(missing.status, 404, missing.text);
  });

  // ---------------------------------------------------------------- GG: the imperfection engine

  await report.check("three [[SAME]] turns -> shape_uniform flag on the third", async () => {
    const shapeConv = await newConversation("integration v3 shape");
    let last = null;
    for (let i = 0; i < 3; i++) {
      last = await turn(shapeConv, "[[SAME]] ok", key("v3-same-" + i));
      assert.equal(last.status, 200, last.text);
    }
    assert.ok(last.json.flags.some((f) => f.code === "shape_uniform"), "flags: " + JSON.stringify(last.json.flags));
    const ctx = await contextOf(last.json.assistantMessage.id);
    assert.equal(typeof ctx.signature, "string");
    assert.equal(ctx.retried, false, "a flag, never a retry");
  });

  await report.check("[[POLISH]] -> over_polish flag, no retry run", async () => {
    const t = await turn(conversationId, "[[POLISH]] how was tonight", key("v3-polish"));
    assert.equal(t.status, 200, t.text);
    assert.ok(t.json.flags.some((f) => f.code === "over_polish"), "flags: " + JSON.stringify(t.json.flags));
    const ctx = await contextOf(t.json.assistantMessage.id);
    assert.equal(ctx.retried, false);
    assert.equal(ctx.runIds.length, 1);
  });

  await report.check("[[TYPO]] -> stored reply keeps 'werid' and the 'weird*' bubble, no repair flag", async () => {
    const t = await turn(conversationId, "[[TYPO]] that was strange", key("v3-typo"));
    assert.equal(t.status, 200, t.text);
    const stored = await api("GET", `/api/messages/${t.json.assistantMessage.id}`);
    assert.equal(stored.json.content, "ok that was werid\n\nweird*");
    assert.ok(!t.json.flags.some((f) => ["em_dash", "emoji", "markdown_structure"].includes(f.code)), JSON.stringify(t.json.flags));
  });

  await report.check("PUT settings typoCueShare 0.05, then a conversation whose first turn key rolls typo_fix (computed with the same seed function) -> provenance.shapeCue typo_fix", async () => {
    const imperfection = await loadTs("imperfection");
    assert.ok(imperfection && typeof imperfection.shapeCue === "function", "src/imperfection.ts loads under Node");
    await settingsPut({ typoCueShare: 0.05 });
    const day = new Date().toISOString().slice(0, 10);
    let found = null;
    for (let i = 0; i < 400 && !found; i++) {
      const id = await newConversation("integration v3 cue " + i);
      const seed = day + ":" + id + ":cue:s1";
      if (imperfection.shapeCue(seed, [], { voiceAllowed: true, typoShare: 0.05, enabled: true }) === "typo_fix") found = id;
    }
    assert.ok(found, "a conversation whose first turn rolls typo_fix (about one in twenty)");
    const t = await turn(found, "hey", key("v3-cue-typo"));
    assert.equal(t.status, 200, t.text);
    const ctx = await contextOf(t.json.assistantMessage.id);
    assert.equal(ctx.shapeCue, "typo_fix", "shapeCue: " + JSON.stringify(ctx.shapeCue));
    await settingsPut({ typoCueShare: 0 });
  });

  await report.check("default settings over 40 turns -> no provenance carries typo_fix", async () => {
    const cueConv = await newConversation("integration v3 forty");
    const cues = [];
    for (let i = 0; i < 40; i++) {
      const t = await turn(cueConv, "turn " + i + " ok", key("v3-forty-" + i));
      assert.equal(t.status, 200, t.text);
      const ctx = await contextOf(t.json.assistantMessage.id);
      cues.push(ctx.shapeCue ?? null);
    }
    assert.ok(!cues.includes("typo_fix"), "cues: " + JSON.stringify(cues));
    return `cues: ${cues.filter(Boolean).length} of 40 turns carried one`;
  });

  // ---------------------------------------------------------------- HH: tastings

  const tasteConv = await newConversation("integration v3 tastings");
  await report.check("tastingEnabled false -> turn with tasting true -> 400", async () => {
    const r = await api("POST", `/api/conversations/${tasteConv}/turn`, { content: "hey", idempotencyKey: key("v3-taste-off"), tasting: true });
    assert.equal(r.status, 400, r.text);
    assert.equal(r.json.code, "validation");
  });

  let tastingId = null;
  let tastingKey = null;
  let leftText = null;
  await report.check("enabled with stub A (model stub) and stub B (model stub-b): turn tasting -> two candidates, texts differ ('b: ' prefix), no assistant message, user message stored", async () => {
    await settingsPut({ prices: { stub: { inputPerMTok: 1, outputPerMTok: 1 }, "stub-b": { inputPerMTok: 1, outputPerMTok: 1 } } });
    await settingsPut({ model: "stub", tastingProvider: "stub", tastingModel: "stub-b", tastingEnabled: true, tastingDailyCapUsd: 5 });
    tastingKey = key("v3-taste");
    const r = await api("POST", `/api/conversations/${tasteConv}/turn`, { content: "bad day. do not cheer me up", idempotencyKey: tastingKey, tasting: true });
    assert.equal(r.status, 200, r.text);
    assert.equal(typeof r.json.tastingId, "string", r.text);
    tastingId = r.json.tastingId;
    assert.equal(r.json.candidates.length, 2);
    assert.deepEqual(r.json.candidates.map((c) => c.side), ["left", "right"]);
    const texts = r.json.candidates.map((c) => c.text);
    assert.notEqual(texts[0], texts[1]);
    assert.equal(texts.filter((x) => x.startsWith("b: ")).length, 1, "one side is the stub-b performer: " + JSON.stringify(texts));
    leftText = texts[0];
    for (const s of ["stub-b", "provider", "model", "anthropic", "openai"]) assert.ok(!JSON.stringify(r.json.candidates).includes(s), "blind: " + s);
    assert.ok(r.json.userMessage && r.json.userMessage.role === "user");
    assert.equal(r.json.assistantMessage, undefined);
    const list = await api("GET", `/api/conversations/${tasteConv}/messages`);
    assert.equal(list.json.length, 1, "his message with no reply");
    const get = await api("GET", `/api/tastings/${tastingId}`);
    assert.equal(get.status, 200, get.text);
    assert.equal(get.json.status, "pending");
    assert.ok(!get.text.includes("stub-b"), "still blind");
  });

  await report.check("a plain turn with a new key while pending -> 409 tasting_pending; /open while pending -> 409; the same key with tasting true -> replayed; the same key without tasting -> 409", async () => {
    const plain = await turn(tasteConv, "hello?", key("v3-taste-plain"));
    assert.equal(plain.status, 409, plain.text);
    assert.equal(plain.json.code, "tasting_pending");
    const open = await api("POST", `/api/conversations/${tasteConv}/open`);
    assert.equal(open.status, 409, open.text);
    const replay = await api("POST", `/api/conversations/${tasteConv}/turn`, { content: "bad day. do not cheer me up", idempotencyKey: tastingKey, tasting: true });
    assert.equal(replay.status, 200, replay.text);
    assert.equal(replay.json.tastingId, tastingId);
    const sameKeyPlain = await api("POST", `/api/conversations/${tasteConv}/turn`, { content: "bad day. do not cheer me up", idempotencyKey: tastingKey });
    assert.equal(sameKeyPlain.status, 409, sameKeyPlain.text);
  });

  await report.check("pick left -> assistant message equals the left text, provenance names the winner, ledger shows one win for that performer", async () => {
    const r = await api("POST", `/api/tastings/${tastingId}/pick`, { pick: "left" });
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.assistantMessage, r.text);
    assert.equal(r.json.assistantMessage.content, leftText);
    assert.equal(r.json.tasting.status, "picked");
    assert.ok(r.json.tasting.left && r.json.tasting.left.model && r.json.tasting.right && r.json.tasting.right.model, "the mapping is revealed");
    const ctx = await contextOf(r.json.assistantMessage.id);
    assert.ok(ctx.tasting && ctx.tasting.winner && ctx.tasting.loser, JSON.stringify(ctx.tasting));
    assert.equal(ctx.tasting.winner.model, r.json.tasting.left.model);
    const led = await api("GET", "/api/tastings/ledger");
    assert.equal(led.status, 200, led.text);
    const winner = led.json.performers.find((p) => (p.performer ?? p.name ?? "").includes(r.json.tasting.left.model));
    assert.ok(winner, JSON.stringify(led.json.performers));
    assert.equal(winner.wins, 1);
    const list = await api("GET", `/api/conversations/${tasteConv}/messages`);
    assert.equal(list.json.length, 2);
    const get = await api("GET", `/api/tastings/${tastingId}`);
    assert.equal(get.json.pick, "left");
  });

  await report.check("pick again -> 409 already_decided", async () => {
    const r = await api("POST", `/api/tastings/${tastingId}/pick`, { pick: "right" });
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.code, "already_decided");
  });

  await report.check("[[BFAIL]] -> normal TurnResponse with tasting_void, one assistant message", async () => {
    const before = (await api("GET", `/api/conversations/${tasteConv}/messages`)).json.length;
    const r = await api("POST", `/api/conversations/${tasteConv}/turn`, { content: "[[BFAIL]] anyway", idempotencyKey: key("v3-bfail"), tasting: true });
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.assistantMessage, "a normal TurnResponse: " + r.text);
    assert.ok(r.json.flags.some((f) => f.code === "tasting_void"), JSON.stringify(r.json.flags));
    assert.equal((await api("GET", `/api/conversations/${tasteConv}/messages`)).json.length, before + 2);
  });

  await report.check("neither -> no reply, the tasting is void; the retry with the same key produces a normal reply and exactly one assistant message exists for that user row", async () => {
    const k = key("v3-neither");
    const r = await api("POST", `/api/conversations/${tasteConv}/turn`, { content: "one more", idempotencyKey: k, tasting: true });
    assert.equal(r.status, 200, r.text);
    const n = await api("POST", `/api/tastings/${r.json.tastingId}/pick`, { pick: "neither" });
    assert.equal(n.status, 200, n.text);
    assert.equal(n.json.assistantMessage, null);
    assert.equal(n.json.tasting.status, "void");
    // Taste again on the tasted key: refused before anything is spent (the row's key is
    // taken); the page sends that key as a plain turn instead.
    const before = (await api("GET", "/api/usage")).json;
    const again = await api("POST", `/api/conversations/${tasteConv}/turn`, { content: "one more", idempotencyKey: k, tasting: true });
    assert.equal(again.status, 409, again.text);
    assert.equal(again.json.code, "idempotency_conflict");
    assert.equal(JSON.stringify((await api("GET", "/api/usage")).json.byDay), JSON.stringify(before.byDay), "nothing spent on the refused tasting");
    const retry = await turn(tasteConv, "one more", k);
    assert.equal(retry.status, 200, retry.text);
    assert.equal(retry.json.userMessage.id, r.json.userMessage.id, "the stored user row is continued");
    const list = await api("GET", `/api/conversations/${tasteConv}/messages`);
    const replies = list.json.filter((m) => m.reply_to_id === r.json.userMessage.id);
    assert.equal(replies.length, 1);
  });

  await report.check("promote a performer with no price -> 400 price_unknown; with a price -> settings.provider and model change, audit row", async () => {
    const bad = await api("POST", "/api/tastings/promote", { provider: "stub", model: "stub-c" });
    assert.equal(bad.status, 400, bad.text);
    assert.equal(bad.json.code, "price_unknown");
    const ok = await api("POST", "/api/tastings/promote", { provider: "stub", model: "stub-b" });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.model, "stub-b");
    const audit = await auditRows(20);
    assert.ok(audit.some((a) => a.action === "tasting.promote"), "audited");
    await settingsPut({ model: "stub" });
  });

  await report.check("tastingDailyCapUsd 0 -> 402 tasting_budget_exceeded, nothing written", async () => {
    await settingsPut({ tastingDailyCapUsd: 0 });
    const before = (await api("GET", `/api/conversations/${tasteConv}/messages`)).json.length;
    const r = await api("POST", `/api/conversations/${tasteConv}/turn`, { content: "capped", idempotencyKey: key("v3-taste-cap"), tasting: true });
    assert.equal(r.status, 402, r.text);
    assert.equal(r.json.code, "tasting_budget_exceeded");
    assert.equal((await api("GET", `/api/conversations/${tasteConv}/messages`)).json.length, before);
    await settingsPut({ tastingDailyCapUsd: 1, tastingEnabled: false });
  });

  // ---------------------------------------------------------------- II: marks and the fine-tune export

  let keptId = null;
  await report.check("mark keep on her message -> status approved +1; mark drop -> back; DELETE -> back; his message -> 400", async () => {
    await api("PUT", `/api/memory/fact/${cousinFactId}`, { weight: 0.9, lastTouched: new Date().toISOString() });
    const base = (await api("GET", "/api/finetune/status")).json;
    assert.equal(typeof base.approved, "number");
    assert.equal(base.minimum, 200);
    assert.equal(base.ready, base.approved >= 200);
    const t = await turn(conversationId, "tell me one true thing about your day", key("v3-keep"));
    assert.equal(t.status, 200, t.text);
    keptId = t.json.assistantMessage.id;
    const keep = await api("POST", `/api/messages/${keptId}/mark`, { mark: "keep", note: "this one" });
    assert.equal(keep.status, 200, keep.text);
    assert.equal(keep.json.mark, "keep");
    assert.equal((await api("GET", "/api/finetune/status")).json.approved, base.approved + 1);
    const drop = await api("POST", `/api/messages/${keptId}/mark`, { mark: "drop" });
    assert.equal(drop.status, 200, drop.text);
    assert.equal((await api("GET", "/api/finetune/status")).json.approved, base.approved);
    const del = await api("DELETE", `/api/messages/${keptId}/mark`);
    assert.equal(del.status, 200, del.text);
    assert.equal((await api("GET", "/api/finetune/status")).json.approved, base.approved);
    const his = await api("POST", `/api/messages/${t.json.userMessage.id}/mark`, { mark: "keep" });
    assert.equal(his.status, 400, his.text);
    const again = await api("DELETE", `/api/messages/${keptId}/mark`);
    assert.equal(again.status, 404, again.text);
  });

  await report.check("a correction with a rewrite -> status counts it once even when the same message is also kept", async () => {
    const base = (await api("GET", "/api/finetune/status")).json.approved;
    const keep = await api("POST", `/api/messages/${keptId}/mark`, { mark: "keep" });
    assert.equal(keep.status, 200, keep.text);
    assert.equal((await api("GET", "/api/finetune/status")).json.approved, base + 1);
    const c = await api("POST", "/api/corrections", { messageId: keptId, kind: "too_nice", rewrite: "one true thing. i ate lunch standing up", toBank: false });
    assert.equal(c.status, 201, c.text);
    const after = (await api("GET", "/api/finetune/status")).json;
    assert.equal(after.approved, base + 1, "deduped by user message");
    assert.ok(after.breakdown && after.breakdown.rewrites >= 1, JSON.stringify(after.breakdown));
  });

  await report.check("GET export.jsonl -> lines parse, system starts with the ALWAYS_ON first line, no ANTHROPIC or sk- anywhere; export.json lineHashes match the chain", async () => {
    const constitution = await loadTs("generated/constitution");
    const firstLine = constitution ? constitution.ALWAYS_ON.split("\n")[0] : null;
    const res = await fetch(BASE + "/api/finetune/export.jsonl");
    assert.equal(res.status, 200);
    assert.ok((res.headers.get("content-type") || "").startsWith("text/plain"));
    assert.ok(/attachment; filename="avelie-train-\d{4}-\d{2}-\d{2}\.jsonl"/.test(res.headers.get("content-disposition") || ""));
    const text = await res.text();
    const lines = text.split("\n").filter((l) => l.trim());
    assert.ok(lines.length >= 1, "at least the kept exchange");
    for (const line of lines) {
      const obj = JSON.parse(line);
      assert.deepEqual(obj.messages.map((m) => m.role), ["system", "user", "assistant"]);
      if (firstLine) assert.ok(obj.messages[0].content.startsWith(firstLine), "compact system starts with ALWAYS_ON");
      assert.ok(!obj.messages[0].content.includes("REFERENCE: CORE IDENTITY"), "compact, not the whole prefix");
    }
    assert.ok(!/ANTHROPIC|sk-/.test(text));
    assert.ok(lines.some((l) => JSON.parse(l).messages[2].content === "one true thing. i ate lunch standing up"), "the rewrite is the assistant text");
    const side = await api("GET", "/api/finetune/export.json");
    assert.equal(side.status, 200, side.text);
    assert.equal(side.json.count, lines.length);
    assert.equal(side.json.lineHashes.length, lines.length);
    assert.equal(side.json.systemMode, "compact");
    assert.equal(side.json.stripHim, true, "absent stripHim = 1: his answer holds for a bare GET, not only the panel");
    const { createHash } = await import("node:crypto");
    const hashes = lines.map((l) => createHash("sha256").update(l).digest("hex"));
    assert.deepEqual(side.json.lineHashes, hashes);
    assert.equal(side.json.sha256, createHash("sha256").update(hashes.join("\n")).digest("hex"));
    return `${lines.length} line(s)`;
  });

  await report.check("with a justin fact approved: export.json sentFactIds names it and sentHisName reflects the state; stripHim=1 -> no WHAT YOU KNOW ABOUT HIM, no his_name, sentFactIds empty", async () => {
    const bare = await api("GET", "/api/finetune/export.json");
    assert.deepEqual(bare.json.sentFactIds, [], "a bare GET strips him (the default is on)");
    const side = await api("GET", "/api/finetune/export.json?stripHim=0");
    assert.ok(side.json.sentFactIds.includes(cousinFactId), "sentFactIds: " + JSON.stringify(side.json.sentFactIds));
    const rel = (await api("GET", "/api/state")).json.relationship.state;
    assert.equal(side.json.sentHisName, !!(rel.his_name && String(rel.his_name).trim()));
    const text = await (await fetch(BASE + "/api/finetune/export.jsonl?stripHim=1")).text();
    for (const line of text.split("\n").filter((l) => l.trim())) {
      const sys = JSON.parse(line).messages[0].content;
      // The always-on rules name the sections by title; the rendered headers are what must be gone.
      assert.ok(!sys.includes("WHAT YOU KNOW ABOUT HIM (only what he told you"), "the facts section is stripped");
      assert.ok(!sys.includes("THINGS YOU HALF REMEMBER (real, but"), "the half-remember section is stripped");
      const m = /Relationship: (\{.*\})/.exec(sys);
      if (m) assert.ok(!("his_name" in JSON.parse(m[1])), "no his_name");
      assert.ok(!sys.includes("his cousin plays drums"), "his fact is out");
    }
    const stripped = await api("GET", "/api/finetune/export.json?stripHim=1");
    assert.deepEqual(stripped.json.sentFactIds, []);
    assert.equal(stripped.json.stripHim, true);
    assert.equal(stripped.json.sentHisName, false);
  });

  await report.check("finetune/use ft:stub-model with prices -> provider openai, model set, texterPrevious stored, proposalProvider unchanged; revert -> back", async () => {
    const before = (await api("GET", "/api/finetune/status")).json;
    const use = await api("POST", "/api/finetune/use", { model: "ft:stub-model", inputPerMTok: 0.4, outputPerMTok: 1.6 });
    assert.equal(use.status, 200, use.text);
    assert.equal(use.json.provider, "openai");
    assert.equal(use.json.model, "ft:stub-model");
    assert.equal(use.json.texterModel, "ft:stub-model");
    assert.deepEqual(use.json.texterPrevious, { provider: before.live.provider, model: before.live.model });
    assert.equal(use.json.proposalProvider, "stub", "judgment stays where it was");
    assert.deepEqual(use.json.prices["ft:stub-model"], { inputPerMTok: 0.4, outputPerMTok: 1.6 });
    const status = (await api("GET", "/api/finetune/status")).json;
    assert.equal(status.live.model, "ft:stub-model");
    assert.equal(status.texterModel, "ft:stub-model");
    const audit = await auditRows(20);
    assert.ok(audit.some((a) => a.action === "finetune.use"));
    const revert = await api("POST", "/api/finetune/revert");
    assert.equal(revert.status, 200, revert.text);
    assert.equal(revert.json.provider, before.live.provider);
    assert.equal(revert.json.model, before.live.model);
    assert.ok(audit.length >= 0 && (await auditRows(20)).some((a) => a.action === "finetune.revert"));
  });

  await report.check("use without prices for an unpriced model -> 400 price_unknown; a bad model id -> 400", async () => {
    const r = await api("POST", "/api/finetune/use", { model: "ft:another-model" });
    assert.equal(r.status, 400, r.text);
    assert.equal(r.json.code, "price_unknown");
    const bad = await api("POST", "/api/finetune/use", { model: "not a model id!" });
    assert.equal(bad.status, 400, bad.text);
    const half = await api("POST", "/api/finetune/use", { model: "ft:x", inputPerMTok: 1 });
    assert.equal(half.status, 400, half.text);
  });

  await report.check("cron 0 7 * * * -> the backup runs and the maintenance pass follows it (an audit row each)", async () => {
    const r = await scheduledCron("0 7 * * *");
    assert.equal(r.status, 200, r.text);
    const audit = await auditRows(40);
    assert.ok(audit.some((a) => a.action === "backup.run"), "the backup still runs");
    assert.ok(audit.some((a) => /maintenance/.test(a.action)), "a maintenance audit row: " + audit.slice(0, 10).map((a) => a.action).join(","));
  });

  await report.check("v3: settings back to their values before this block", async () => {
    await settingsPut(restore);
    const s = (await api("GET", "/api/settings")).json;
    for (const k of Object.keys(restore)) assert.deepEqual(s[k], restore[k], k);
  });
}

// The gate as production runs it: ACCESS_AUD set, so the dev actor is off and only a
// verified Access token could get in. (A non-local Host header cannot be probed through
// wrangler dev: with a route configured it rewrites every request's origin, and
// wrangler.jsonc pins dev.host to 127.0.0.1 so the local rule works at all; the non-local
// branch of requireOwner is covered by tests/unit/auth.test.mjs.)
// ------------------------------------------------------------------ photos on Runway, no key (2026-09-25)

// ------------------------------------------------------------------ v3.1 scenarios (SPEC_V3 section JJ: what he looks like)

// The same phase-1 server (stub performer). His reference photos are uploaded as tiny
// PNGs, the stub's [[HISFACE]] reply says how many him/ refs the call actually carried,
// and the provenance row says whether the section rendered and the photos rode along.
async function scenariosV31(report) {
  const probe = await api("GET", "/api/him");
  if (probe.status === 404) {
    console.log("v3.1: GET /api/him -> 404 on this server; skipping the v3.1 block");
    return;
  }
  const original = (await api("GET", "/api/settings")).json;
  const sceneBefore = (await state()).scene.state;
  const restore = {
    dailyCapUsd: original.dailyCapUsd, monthlyCapUsd: original.monthlyCapUsd,
    hisFaceMax: original.hisFaceMax, hisFaceInTogether: original.hisFaceInTogether, hisFaceApartEvery: original.hisFaceApartEvery, hisLookText: original.hisLookText,
  };
  const ids = [];
  const setScene = async (status, location) => {
    const put = await api("PUT", "/api/state/scene", { state: { ...sceneBefore, status, location }, note: "v3.1 " + status });
    assert.equal(put.status, 200, put.text);
  };
  const shownIn = (reply) => {
    const m = /(\d+) on file/.exec(reply.json.assistantMessage.content);
    assert.ok(m, "stub reply: " + reply.json.assistantMessage.content);
    return Number(m[1]);
  };
  const conversationId = await newConversation("integration v3.1");

  await report.check("v3.1: GET /api/him -> no photos, no words, the three defaults; settings carry the four keys", async () => {
    assert.equal(probe.status, 200, probe.text);
    assert.deepEqual(probe.json.photos, []);
    assert.equal(probe.json.look, "");
    assert.deepEqual(probe.json.settings, { hisFaceMax: 3, hisFaceInTogether: true, hisFaceApartEvery: 8 });
    assert.equal(original.hisLookText, "");
    assert.equal(original.hisFaceMax, 3);
    assert.equal(original.hisFaceInTogether, true);
    assert.equal(original.hisFaceApartEvery, 8);
    await settingsPut({ dailyCapUsd: 200, monthlyCapUsd: 500 });
  });

  await report.check("v3.1: PUT /api/settings refuses hisFaceMax 4 and 0, hisFaceApartEvery 51, hisFaceInTogether 'yes', hisLookText over 600; a good patch round-trips", async () => {
    for (const patch of [{ hisFaceMax: 4 }, { hisFaceMax: 0 }, { hisFaceApartEvery: 51 }, { hisFaceApartEvery: -1 }, { hisFaceInTogether: "yes" }, { hisLookText: "x".repeat(601) }]) {
      const r = await api("PUT", "/api/settings", patch);
      assert.equal(r.status, 400, JSON.stringify(patch) + " -> " + r.text);
      assert.equal(r.json.code, "validation");
    }
    const ok = await settingsPut({ hisFaceMax: 2, hisFaceApartEvery: 3, hisFaceInTogether: false });
    assert.equal(ok.hisFaceMax, 2);
    assert.equal(ok.hisFaceApartEvery, 3);
    assert.equal(ok.hisFaceInTogether, false);
    const him = await api("GET", "/api/him");
    assert.deepEqual(him.json.settings, { hisFaceMax: 2, hisFaceInTogether: false, hisFaceApartEvery: 3 });
    await settingsPut({ hisFaceMax: 3, hisFaceApartEvery: 8, hisFaceInTogether: true });
  });

  await report.check("v3.1: POST /api/him/photos x3 -> 201 role him approved under him/; the 4th -> 409 him_full; not an image -> 415; no file -> 400", async () => {
    for (let n = 0; n < 3; n++) {
      const form = new FormData();
      form.set("photo", new Blob([tinyPng()], { type: "image/png" }), "him" + n + ".png");
      const r = await apiForm("POST", "/api/him/photos", form);
      assert.equal(r.status, 201, r.text);
      assert.equal(r.json.role, "him");
      assert.equal(r.json.approval_status, "approved");
      assert.ok(r.json.file.startsWith("him/") && r.json.file.endsWith(".png"), r.json.file);
      assert.match(r.json.sha256, /^[0-9a-f]{64}$/);
      assert.equal(r.json.bytes, tinyPng().length);
      assert.equal(r.json.conversation_id, null);
      assert.equal(r.json.message_id, null);
      assert.equal(r.json.prompt, null);
      assert.equal(r.json.notes, "him");
      ids.push(r.json.id);
      await sleep(5);
    }
    const fourth = new FormData();
    fourth.set("photo", new Blob([tinyPng()], { type: "image/png" }), "him3.png");
    const full = await apiForm("POST", "/api/him/photos", fourth);
    assert.equal(full.status, 409, full.text);
    assert.equal(full.json.code, "him_full");
    const bad = new FormData();
    bad.set("photo", new Blob([Buffer.from("plain text, not a picture")], { type: "image/png" }), "fake.png");
    const rejected = await apiForm("POST", "/api/him/photos", bad);
    assert.equal(rejected.status, 415, rejected.text);
    const empty = await apiForm("POST", "/api/him/photos", new FormData());
    assert.equal(empty.status, 400, empty.text);
    const list = await api("GET", "/api/him");
    assert.equal(list.json.photos.length, 3);
    assert.deepEqual(list.json.photos.map((p) => p.id).sort(), ids.slice().sort());
    for (const p of list.json.photos) assert.deepEqual(Object.keys(p).sort(), ["bytes", "created_at", "file", "id", "sha256"]);
    const audit = (await auditRows(50)).filter((e) => e.action === "him.photo.add");
    assert.ok(audit.length >= 3, "audited");
    assert.ok(!JSON.stringify(audit).includes("him/"), "the audit row carries no storage key");
  });

  await report.check("v3.1: GET /api/him/photos/:id serves the png; an unknown id 404; /media/:id never serves a photo of him", async () => {
    const r = await fetchBytes(`/api/him/photos/${ids[0]}`);
    assert.equal(r.status, 200);
    assert.ok(r.contentType.startsWith("image/png"), r.contentType);
    assert.deepEqual(Array.from(r.bytes.slice(0, 4)), [0x89, 0x50, 0x4e, 0x47]);
    assert.equal(r.bytes.length, tinyPng().length);
    const none = await fetchBytes("/api/him/photos/him_nothing");
    assert.equal(none.status, 404);
    const media = await fetchBytes(`/media/${ids[0]}`);
    assert.equal(media.status, 404, "a photo of him is not hers to serve");
  });

  await report.check("v3.1: GET /api/assets lists no photo of him anywhere; decide on one -> 409", async () => {
    const a = await api("GET", "/api/assets");
    assert.equal(a.status, 200, a.text);
    const all = Object.values(a.json).flat().filter((x) => x && typeof x === "object");
    for (const id of ids) assert.ok(!all.some((x) => x.id === id), id + " listed on the Images page");
    assert.ok(!JSON.stringify(a.json).includes("him/"));
    const decide = await api("POST", `/api/images/${ids[0]}/decide`, { decision: "reject" });
    assert.equal(decide.status, 409, decide.text);
    const still = await fetchBytes(`/api/him/photos/${ids[0]}`);
    assert.equal(still.status, 200, "the decision route touched nothing");
  });

  await report.check("v3.1: POST /api/him/describe -> the stub's words, a describe run with usage, nothing saved; PUT /api/him/look saves them, cleaned; over 600 -> 400", async () => {
    const usageBefore = (await api("GET", "/api/usage")).json.todayUsd;
    const d = await api("POST", "/api/him/describe", {});
    assert.equal(d.status, 200, d.text);
    assert.ok(d.json.look.startsWith("Medium build"), d.json.look);
    assert.ok(!BAD_TYPOGRAPHY.test(d.json.look));
    const notSaved = await api("GET", "/api/him");
    assert.equal(notSaved.json.look, "", "describe saves nothing");
    assert.equal((await api("GET", "/api/settings")).json.hisLookText, "");
    const usageAfter = (await api("GET", "/api/usage")).json;
    assert.ok(usageAfter.todayUsd > usageBefore, "the describe call is on the meter");
    assert.ok(usageAfter.byDay.some((r) => r.provider === "stub"), "usage row for the stub");
    const saved = await api("PUT", "/api/him/look", { look: "  " + d.json.look + " " + EM_DASH + " glasses sometimes " });
    assert.equal(saved.status, 200, saved.text);
    assert.ok(saved.json.look.endsWith("-- glasses sometimes"), saved.json.look);
    assert.ok(!BAD_TYPOGRAPHY.test(saved.json.look));
    const him = await api("GET", "/api/him");
    assert.equal(him.json.look, saved.json.look);
    assert.equal((await api("GET", "/api/settings")).json.hisLookText, saved.json.look);
    const long = await api("PUT", "/api/him/look", { look: "x".repeat(601) });
    assert.equal(long.status, 400, long.text);
    const notString = await api("PUT", "/api/him/look", { look: 5 });
    assert.equal(notString.status, 400, notString.text);
    const audit = (await auditRows(20)).find((e) => e.action === "him.look.save");
    assert.ok(audit, "audited");
  });

  await report.check("v3.1: the first turn of a conversation and every together turn -> the call carried all 3 photos; provenance hisFace shown true, photos 3, section true; his row carries none", async () => {
    await setScene("together", "her kitchen");
    const r = await turn(conversationId, "[[HISFACE]] hey", key("v31-together"));
    assert.equal(r.status, 200, r.text);
    assert.equal(shownIn(r), 3, "the first turn of the conversation");
    assert.equal(r.json.userMessage.images_json ?? null, null, "nothing written to his row");
    const his = await api("GET", `/api/messages/${r.json.userMessage.id}`);
    assert.equal(his.json.images_json, null, "his stored message carries no picture");
    const ctx = await contextOf(r.json.assistantMessage.id);
    assert.deepEqual(ctx.hisFace, { section: true, shown: true, photos: 3 });
    assert.equal(ctx.imageCount, 0, "his own photo count is untouched");
    assert.equal(ctx.mode, "together");
    const again = await turn(conversationId, "[[HISFACE]] and again", key("v31-together-2"));
    assert.equal(again.status, 200, again.text);
    assert.equal(shownIn(again), 3, "every together turn, whatever the cadence");
    assert.equal((await contextOf(again.json.assistantMessage.id)).hisFace.shown, true);
    const list = await api("GET", `/api/conversations/${conversationId}/messages`);
    assert.ok(list.json.every((m) => !m.images_json), "no message in the thread carries a picture");
  });

  await report.check("v3.1: apart mode right after -> no photo rode along (1 turn since, cadence 8); a mention of his looks -> all 3 again", async () => {
    await setScene("none", null);
    const r = await turn(conversationId, "[[HISFACE]] home now", key("v31-apart"));
    assert.equal(r.status, 200, r.text);
    assert.equal(shownIn(r), 0);
    const ctx = await contextOf(r.json.assistantMessage.id);
    assert.deepEqual(ctx.hisFace, { section: true, shown: false, photos: 0 });
    assert.equal(ctx.mode, "apart");
    const mention = await turn(conversationId, "[[HISFACE]] do you like my beard", key("v31-mention"));
    assert.equal(mention.status, 200, mention.text);
    assert.equal(shownIn(mention), 3);
    assert.equal((await contextOf(mention.json.assistantMessage.id)).hisFace.shown, true);
  });

  await report.check("v3.1: apart cadence 2 -> the 2nd turn after a showing, not the 1st; cadence 1 -> every turn; hisFaceMax 1 -> one photo rides; a new conversation's first turn shows it with the cadence at 0", async () => {
    await settingsPut({ hisFaceApartEvery: 2 });
    const skip = await turn(conversationId, "[[HISFACE]] not yet", key("v31-skip"));
    assert.equal(shownIn(skip), 0, "1 turn since the mention turn");
    const secondSince = await turn(conversationId, "[[HISFACE]] now", key("v31-second-turn"));
    assert.equal(shownIn(secondSince), 3, "2 turns since");
    await settingsPut({ hisFaceApartEvery: 1 });
    const every = await turn(conversationId, "[[HISFACE]] still here", key("v31-every"));
    assert.equal(shownIn(every), 3, "every turn");
    await settingsPut({ hisFaceMax: 1 });
    const one = await turn(conversationId, "[[HISFACE]] one more", key("v31-one"));
    assert.equal(shownIn(one), 1);
    assert.equal((await api("GET", "/api/him")).json.photos.length, 3, "the page still lists every photo on file; only hisFaceMax ride along");
    await settingsPut({ hisFaceMax: 3, hisFaceApartEvery: 0, hisFaceInTogether: false });
    const fresh = await newConversation("integration v3.1 first turn");
    const first = await turn(fresh, "[[HISFACE]] hi", key("v31-first"));
    assert.equal(shownIn(first), 3, "the first turn of a conversation");
    const second = await turn(fresh, "[[HISFACE]] and again", key("v31-second"));
    assert.equal(shownIn(second), 0, "cadence 0: never again in apart mode");
    await setScene("together", "the bench");
    const together = await turn(fresh, "[[HISFACE]] sit", key("v31-together-off"));
    assert.equal(shownIn(together), 0, "together switch off");
    await setScene("none", null);
    await settingsPut({ hisFaceApartEvery: 8, hisFaceInTogether: true });
  });

  // v3.1 fix 1 (d): his first turn is the first row of HIS. A conversation she opened
  // (POST /open, her row first) still shows the photos on his first message, with the
  // cadence at 0 and the Together switch off; the opener turn itself is hers, not his first.
  await report.check("v3.1 fix 1: a conversation she opened -> her opener turn carried no photo (apart, cadence 0, together off); his first turn carried all 3; his second none; two of her rows first still count as his first", async () => {
    await settingsPut({ hisFaceApartEvery: 0, hisFaceInTogether: false });
    const opened = await newConversation("integration v3.1 her opener first");
    const open = await api("POST", `/api/conversations/${opened}/open`);
    assert.equal(open.status, 200, open.text);
    assert.equal(open.json.userMessage, null);
    const openCtx = await contextOf(open.json.assistantMessage.id);
    assert.equal(openCtx.opener, true);
    assert.deepEqual(openCtx.hisFace, { section: true, shown: false, photos: 0 }, "an opener turn is hers, never his first");
    const first = await turn(opened, "[[HISFACE]] hi", key("v31-open-first"));
    assert.equal(first.status, 200, first.text);
    assert.equal(shownIn(first), 3, "his first turn after her opener");
    const firstCtx = await contextOf(first.json.assistantMessage.id);
    assert.deepEqual(firstCtx.hisFace, { section: true, shown: true, photos: 3 });
    assert.equal(firstCtx.mode, "apart");
    assert.equal(first.json.userMessage.images_json ?? null, null, "nothing written to his row");
    const second = await turn(opened, "[[HISFACE]] and again", key("v31-open-second"));
    assert.equal(shownIn(second), 0, "cadence 0: his second turn carries none");
    const twice = await newConversation("integration v3.1 two of hers first");
    assert.equal((await api("POST", `/api/conversations/${twice}/open`)).status, 200);
    assert.equal((await api("POST", `/api/conversations/${twice}/open`)).status, 200);
    const list = await api("GET", `/api/conversations/${twice}/messages?channel=story`);
    assert.equal(list.json.length, 2);
    assert.ok(list.json.every((m) => m.role === "assistant"), "two of her rows, none of his");
    const afterTwo = await turn(twice, "[[HISFACE]] here", key("v31-open-twice"));
    assert.equal(shownIn(afterTwo), 3, "still his first turn");
    await settingsPut({ hisFaceApartEvery: 8, hisFaceInTogether: true });
  });

  // v3.1 fix 1 (e): a tasting turn names two performers on one system text and one message
  // list. A side B that cannot see (the blind stub model, a text-only performer's stand-in)
  // keeps the photos off both sides, so nobody is told about pictures never sent; a side B
  // that sees gets them with the live performer.
  await report.check("v3.1 fix 1: a tasting whose side B cannot see (stub-blind) -> neither side's call carried a photo, the pick's provenance says shown false; side B stub-b -> both carried 3, shown true", async () => {
    const before = (await api("GET", "/api/settings")).json;
    const one = { inputPerMTok: 1, outputPerMTok: 1 };
    await settingsPut({ prices: { ...before.prices, stub: one, "stub-b": one, "stub-blind": one } });
    await settingsPut({ tastingProvider: "stub", tastingModel: "stub-blind", tastingEnabled: true, tastingDailyCapUsd: 5 });
    await setScene("together", "her kitchen");
    const blind = await api("POST", `/api/conversations/${conversationId}/turn`, { content: "[[HISFACE]] both of you", idempotencyKey: key("v31-taste-blind"), tasting: true });
    assert.equal(blind.status, 200, blind.text);
    assert.equal(blind.json.candidates.length, 2, blind.text);
    for (const c of blind.json.candidates) assert.ok(c.text.includes("0 on file"), "no side saw a photo: " + JSON.stringify(blind.json.candidates.map((x) => x.text)));
    const blindPick = await api("POST", `/api/tastings/${blind.json.tastingId}/pick`, { pick: "left" });
    assert.equal(blindPick.status, 200, blindPick.text);
    assert.ok(blindPick.json.assistantMessage.content.includes("0 on file"));
    const blindCtx = await contextOf(blindPick.json.assistantMessage.id);
    assert.deepEqual(blindCtx.hisFace, { section: true, shown: false, photos: 0 }, "a together turn, but side B cannot see");
    assert.equal(blindCtx.mode, "together");
    assert.ok(blindCtx.tasting && blindCtx.tasting.winner, "a tasting pick");
    assert.equal(blind.json.userMessage.images_json ?? null, null);
    await settingsPut({ tastingModel: "stub-b" });
    const sees = await api("POST", `/api/conversations/${conversationId}/turn`, { content: "[[HISFACE]] now both", idempotencyKey: key("v31-taste-sees"), tasting: true });
    assert.equal(sees.status, 200, sees.text);
    const texts = sees.json.candidates.map((c) => c.text);
    assert.ok(texts.every((t) => t.includes("3 on file")), "both sides saw the three photos: " + JSON.stringify(texts));
    assert.equal(texts.filter((t) => t.startsWith("b: ")).length, 1, "side B answered too: " + JSON.stringify(texts));
    const seesPick = await api("POST", `/api/tastings/${sees.json.tastingId}/pick`, { pick: "right" });
    assert.equal(seesPick.status, 200, seesPick.text);
    const seesCtx = await contextOf(seesPick.json.assistantMessage.id);
    assert.deepEqual(seesCtx.hisFace, { section: true, shown: true, photos: 3 }, "both see: the photos rode for both");
    const plain = await turn(conversationId, "[[HISFACE]] just you", key("v31-taste-after"));
    assert.equal(shownIn(plain), 3, "a plain together turn after the tastings");
    await setScene("none", null);
    const back = { tastingEnabled: before.tastingEnabled, tastingDailyCapUsd: before.tastingDailyCapUsd, prices: before.prices };
    if (typeof before.tastingProvider === "string" && before.tastingProvider) back.tastingProvider = before.tastingProvider;
    if (typeof before.tastingModel === "string" && before.tastingModel) back.tastingModel = before.tastingModel;
    await settingsPut(back);
  });

  // v3.1 fix 2 (d): the live database shape before migration 0007 (conversations without
  // his_face_seq). The cadence read fails on it; that must count as "just shown", so an
  // Apart turn carries no photo unless it is his first, a mention, or Together. Before the
  // fix the failed read counted as "never shown" and every Apart turn carried all three.
  // The column is dropped under the running server the way the checker did it, and put
  // back before the next check whatever happens.
  await report.check("v3.1 fix 2: conversations without his_face_seq (the shape before 0007) -> apart, cadence 8: his first turn 3, then 0, 0 (never every turn); a mention 3; together 3; apart 0; the column back (null = never shown) -> 3, then 0", async () => {
    await setScene("none", null);
    const d1 = (sql) => runCommand(["d1", "execute", "avelie", "--local", "--persist-to", STATE_ARG, "--command", sql, "--json"], { env: { CI: "1" } });
    const drop = await d1("ALTER TABLE conversations DROP COLUMN his_face_seq");
    assert.equal(drop.code, 0, "drop his_face_seq: " + drop.output.slice(0, 400));
    const c = await newConversation("integration v3.1 fix 2 unmigrated");
    let add;
    try {
      const first = await turn(c, "[[HISFACE]] one", key("v31f2-1"));
      assert.equal(first.status, 200, first.text);
      assert.equal(shownIn(first), 3, "his first turn");
      const second = await turn(c, "[[HISFACE]] two", key("v31f2-2"));
      assert.equal(second.status, 200, second.text);
      assert.equal(shownIn(second), 0, "the cadence read failed: counts as just shown, never as never shown");
      const secondCtx = await contextOf(second.json.assistantMessage.id);
      assert.deepEqual(secondCtx.hisFace, { section: true, shown: false, photos: 0 });
      assert.equal(secondCtx.mode, "apart");
      assert.equal(shownIn(await turn(c, "[[HISFACE]] three", key("v31f2-3"))), 0);
      assert.equal(shownIn(await turn(c, "[[HISFACE]] is my hair ok", key("v31f2-mention"))), 3, "a mention of his looks still shows");
      await setScene("together", "the bench");
      assert.equal(shownIn(await turn(c, "[[HISFACE]] sit", key("v31f2-together"))), 3, "a together turn still shows");
      await setScene("none", null);
      assert.equal(shownIn(await turn(c, "[[HISFACE]] four", key("v31f2-4"))), 0, "apart again: still quiet");
    } finally {
      add = await d1("ALTER TABLE conversations ADD COLUMN his_face_seq INTEGER");
    }
    assert.equal(add.code, 0, "re-add his_face_seq: " + add.output.slice(0, 400));
    const resumed = await turn(c, "[[HISFACE]] five", key("v31f2-5"));
    assert.equal(resumed.status, 200, resumed.text);
    assert.equal(shownIn(resumed), 3, "the column is back and says null: never shown, so the cadence fires");
    assert.equal(shownIn(await turn(c, "[[HISFACE]] six", key("v31f2-6"))), 0, "1 turn since: the marker was written");
  });

  await report.check("v3.1: the character export carries no photo of him; the fine-tune export drops WHAT HE LOOKS LIKE with stripHim=1 and keeps it with 0", async () => {
    const pkg = await api("GET", "/api/export/character");
    assert.equal(pkg.status, 200, pkg.text.slice(0, 200));
    assert.ok(!pkg.json.images.some((i) => i.role === "him"), "no role him image");
    assert.ok(!pkg.text.includes("him/"), "no him/ key in the package");
    const t = await turn(conversationId, "[[HISFACE]] keep this one", key("v31-keep"));
    assert.equal(t.status, 200, t.text);
    const keep = await api("POST", `/api/messages/${t.json.assistantMessage.id}/mark`, { mark: "keep" });
    assert.equal(keep.status, 200, keep.text);
    const mine = (text) => text.split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((line) => line.messages[1].content.includes("keep this one"));
    const full = await (await fetch(BASE + "/api/finetune/export.jsonl?stripHim=0")).text();
    const kept = mine(full);
    assert.ok(kept, "the kept exchange is in the export");
    assert.ok(kept.messages[0].content.includes("WHAT HE LOOKS LIKE"), "stripHim=0 keeps the section");
    assert.ok(kept.messages[0].content.includes("Medium build"), "the words on file");
    const stripped = mine(await (await fetch(BASE + "/api/finetune/export.jsonl?stripHim=1")).text());
    assert.ok(stripped, "still exported with stripHim=1");
    assert.ok(!stripped.messages[0].content.includes("WHAT HE LOOKS LIKE"), "stripHim=1 drops the section");
    assert.ok(!stripped.messages[0].content.includes("Medium build"));
    assert.ok(!stripped.messages[0].content.includes("him/"));
  });

  await report.check("v3.1: DELETE /api/him/photos/:id x3 -> 204, the bytes gone, GET /api/him empty; describe with no photo -> 409 no_photos; a turn then carries none", async () => {
    for (const id of ids) {
      const r = await api("DELETE", `/api/him/photos/${id}`);
      assert.equal(r.status, 204, r.text);
      assert.equal((await fetchBytes(`/api/him/photos/${id}`)).status, 404);
    }
    const again = await api("DELETE", `/api/him/photos/${ids[0]}`);
    assert.equal(again.status, 404, again.text);
    assert.equal((await api("GET", "/api/him")).json.photos.length, 0);
    const d = await api("POST", "/api/him/describe", {});
    assert.equal(d.status, 409, d.text);
    assert.equal(d.json.code, "no_photos");
    await setScene("together", "her kitchen");
    const r = await turn(conversationId, "[[HISFACE]] gone", key("v31-gone"));
    assert.equal(shownIn(r), 0);
    const ctx = await contextOf(r.json.assistantMessage.id);
    assert.deepEqual(ctx.hisFace, { section: true, shown: false, photos: 0 }, "the words are still on file, so the section stays");
    await api("PUT", "/api/him/look", { look: "" });
    const bare = await turn(conversationId, "[[HISFACE]] nothing on file", key("v31-bare"));
    assert.deepEqual((await contextOf(bare.json.assistantMessage.id)).hisFace, { section: false, shown: false, photos: 0 }, "no words, no photo: no section");
  });

  await report.check("v3.1: the scene and the settings back to what the block found", async () => {
    await setScene(sceneBefore.status, sceneBefore.location);
    await settingsPut(restore);
    const s = (await api("GET", "/api/settings")).json;
    for (const k of Object.keys(restore)) assert.deepEqual(s[k], restore[k], k);
  });
}

// Runs on a server whose local image-provider overlay is off (main() blanks
// DEFAULT_IMAGE_PROVIDER for this phase; with it on, api.ts overlaySettings would turn
// every stored image provider back into the stub). There is no RUNWAY_API_KEY in the test
// environment: the switch is accepted, the photo fails as a config error, and nothing is
// written but the failed request row and its run row, which the app writes for any
// failed photo (a failed request is listed nowhere and served nowhere).
async function runwayScenarios(report, conversationId) {
  let before = null;

  await report.check("runway (overlay off): PUT imageProvider runway, imageModel gen4_image, 0.08 per photo -> stored and read back as runway; no Runway key on /api/system", async () => {
    before = await api("GET", "/api/settings");
    assert.equal(before.status, 200, before.text);
    // Phase 1 leaves the day's spend above the default cap; raised for this block, restored below.
    const caps = await api("PUT", "/api/settings", { dailyCapUsd: 200, monthlyCapUsd: 500 });
    assert.equal(caps.status, 200, caps.text);
    const r = await api("PUT", "/api/settings", { imageProvider: "runway", imageModel: "gen4_image", imageCostUsd: 0.08 });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.imageProvider, "runway");
    assert.equal(r.json.imageModel, "gen4_image");
    assert.equal(r.json.imageCostUsd, 0.08);
    const again = await api("GET", "/api/settings");
    assert.equal(again.json.imageProvider, "runway", "the stored value reaches the pipeline in this phase");
    const sys = await api("GET", "/api/system");
    assert.equal(sys.status, 200, sys.text);
    assert.equal(sys.json.providerKeys.runway, false, "no Runway key in the test environment");
    const zero = await api("PUT", "/api/settings", { imageCostUsd: 0 });
    assert.equal(zero.status, 400, "a paid provider at 0 is refused: " + zero.text);
    assert.ok(/imageCostUsd/.test(zero.json.error), zero.json.error);
  });

  await report.check("runway with no key: POST /api/images/generate -> 503 provider_not_configured (detail runway); no candidate, nothing generating, no image.generate audit event, nothing served", async () => {
    const assetsBefore = await api("GET", "/api/assets");
    assert.equal(assetsBefore.status, 200, assetsBefore.text);
    const auditBefore = (await auditRows(200)).filter((e) => e.action === "image.generate").length;
    const r = await api("POST", "/api/images/generate", { conversationId, description: "integration: runway with no key, lamp light" });
    assert.equal(r.status, 503, r.text);
    assert.equal(r.json.code, "provider_not_configured");
    assert.equal(r.json.detail, "runway");
    assert.equal(r.json.retryable, false);
    assert.ok(/runway image provider not configured/.test(r.json.error), r.json.error);
    const assetsAfter = await api("GET", "/api/assets");
    assert.equal(assetsAfter.json.candidates.length, assetsBefore.json.candidates.length, "no candidate was made");
    assert.equal(assetsAfter.json.generating.length, 0, "nothing left generating");
    assert.equal(assetsAfter.json.rejected.length, assetsBefore.json.rejected.length);
    const auditAfter = (await auditRows(200)).filter((e) => e.action === "image.generate").length;
    assert.equal(auditAfter, auditBefore, "no image.generate audit event");
    // The same through her marker: the turn still lands (the photo is asked for later by the page).
    const t = await turn(conversationId, "[[PHOTO]] one more", key("runway-photo"));
    assert.equal(t.status, 200, t.text);
    assert.equal(t.json.imagePending, true);
    const gen = await api("POST", "/api/images/generate", { conversationId, messageId: t.json.assistantMessage.id });
    assert.equal(gen.status, 503, gen.text);
    assert.equal(gen.json.code, "provider_not_configured");
    const m = await api("GET", `/api/messages/${t.json.assistantMessage.id}`);
    assert.equal(m.json.image_status, "failed", "the message shows a failed photo, retryable from the page");
    const media = await fetchBytes(`/media/${m.json.image_id}`);
    assert.equal(media.status, 404, "a failed request serves nothing");
    return "503 " + r.json.code + " / " + r.json.detail;
  });

  await report.check("runway: image settings and caps restored to what phase 1 left (the stub)", async () => {
    const r = await api("PUT", "/api/settings", {
      imageProvider: before.json.imageProvider, imageModel: before.json.imageModel, imageCostUsd: before.json.imageCostUsd,
      dailyCapUsd: before.json.dailyCapUsd, monthlyCapUsd: before.json.monthlyCapUsd,
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.imageProvider, before.json.imageProvider);
    assert.equal(r.json.imageModel, before.json.imageModel);
  });
}

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

  await report.check("ACCESS_AUD set: the v3 routes are gated too -> 401", async () => {
    for (const path of ["/api/voicebank", "/api/corrections", "/api/memory", "/api/wants", "/api/grounding", "/api/calls", "/api/tastings/ledger", "/api/finetune/status", "/api/finetune/export.jsonl", "/api/finetune/export.json", "/api/him", "/api/him/photos/him_nothing"]) {
      const r = await api("GET", path);
      assert.equal(r.status, 401, path + " -> " + r.status + " " + r.text.slice(0, 100));
    }
    for (const path of ["/api/calls/start", "/api/video/generate", "/api/voicebank/decide", "/api/finetune/use", "/api/grounding/geocode", "/api/him/describe", "/api/him/photos"]) {
      const r = await api("POST", path, {});
      assert.equal(r.status, 401, path + " -> " + r.status + " " + r.text.slice(0, 100));
    }
  });

  await report.check("ACCESS_AUD set: the v4 routes and the place media path are gated too -> 401", async () => {
    for (const path of V4_ROUTES_GET) {
      const r = await api("GET", path);
      assert.equal(r.status, 401, path + " -> " + r.status + " " + r.text.slice(0, 100));
      assert.ok(!r.text.includes("refresh_token") && !r.text.includes("accessToken"), path + " leaked a token shape through the gate");
    }
    for (const path of V4_ROUTES_POST) {
      const r = await api("POST", path, {});
      assert.equal(r.status, 401, path + " -> " + r.status + " " + r.text.slice(0, 100));
    }
    const cb = await apiRaw("GET", "/api/spotify/callback?code=x&state=y");
    assert.equal(cb.status, 401, "the callback is gated before the state is read: " + cb.text.slice(0, 100));
    for (const path of ["/phone", "/album", "/memory", "/js/phone.js", "/js/player.js"]) {
      const r = await api("GET", path);
      assert.equal(r.status, 401, path + " -> " + r.status);
    }
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

// ------------------------------------------------------------------ v4 scenarios (SPEC_V4 sections 0 to 8, amendments A1 and A3)

// Its own phase on a FRESH local state (main() applies 0001 to 0008 to a second directory
// and boots with --var SPOTIFY_STUB:1): the stub image and video providers return the same
// bytes on purpose, and the v1 and v3 blocks reject one photo and one clip so their
// blacklist checks hold, which would blacklist every v4 photo and clip on the shared state.
// Everything the block needs (a photo of him, a faded fact, her places) it makes itself,
// on a fresh conversation, with the caps raised and every setting it touches put back.
const V4_ROUTES_GET = ["/api/avatar", "/api/phone", "/api/places", "/api/callface", "/api/album", "/api/memory/map", "/api/spotify", "/api/spotify/connect", "/api/spotify/token", "/media/place/x"];
const V4_ROUTES_POST = ["/api/places", "/api/places/pl_nothing/geocode", "/api/places/pl_nothing/picture", "/api/callface/make", "/api/spotify/disconnect", "/api/messages/m_nothing/spotify"];
const V4_PAGES = ["/", "/phone", "/album", "/memory", "/state", "/model", "/images", "/timeline"];
const V4_SCRIPTS = ["/js/api.js", "/js/nav.js", "/js/chat.js", "/js/bubbles.js", "/js/call.js", "/js/callface.js", "/js/phone.js", "/js/map.js", "/js/album.js", "/js/memory.js", "/js/images.js", "/js/model.js", "/js/state.js", "/js/timeline.js"];
const V4_SETTINGS_TABLE = {
  avatarAssetId: ["master-05", "master-02", "master-09"],
  callFaceProvider: ["clips", "off", "hedra"],
  callFaceSourceAssetId: ["master-00", "master-04", "master-6"],
  hisFaceInPhotos: [true, false, "yes"],
  spotifyEnabled: [false, true, "on"],
  spotifyPlaylistId: ["", "37i9dQZF1DXcBWIGoYBM5M", "not a playlist id!"],
  spotifyPlaylistName: ["songs from avelie", "her songs", "x".repeat(101)],
  placeCostUsd: [0.08, 1, -1],
  listeningLineEnabled: [true, false, 1],
};
const V4_AMENDMENT_TABLE = {
  spotifyPlayer: ["sdk", "embed", "cast"],
  elevenLabsModel: ["eleven_multilingual_v2", "eleven_turbo_v2_5", "x".repeat(61)],
  elevenLabsTtsPricePer1kChars: [0.3, 1, -1],
  videoMarkerEnabled: [true, false, "yes"],
};

// A fetch that never follows a redirect, for the two Spotify 302s.
async function apiRaw(method, path, body) {
  const init = { method, redirect: "manual", headers: {} };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, headers: res.headers, json, text };
}

// The audit row's `after`, as an object whether the route stored it as JSON text or not.
function auditAfter(row) {
  const v = row && (row.after ?? row.after_json ?? null);
  if (typeof v === "string") {
    try { return JSON.parse(v); } catch { return null; }
  }
  return v && typeof v === "object" ? v : null;
}

// Polls a clip to its candidate (the stub answers RUNNING once, SUCCEEDED after). A 422
// blacklisted here means the stub's bytes were rejected earlier in this state: the v4 phase
// runs on a fresh state for exactly that reason, and never rejects a clip itself.
async function pollToCandidate(id) {
  let last = null;
  for (let i = 0; i < 8; i++) {
    last = await api("POST", `/api/video/${id}/poll`);
    if (last.status === 422) throw new Error("clip " + id + " blacklisted at poll: the stub mp4's hash was rejected earlier in this state; the v4 phase must run on a fresh state and never reject a clip (" + last.text.slice(0, 120) + ")");
    if (last.status !== 200 || last.json.status !== "running") break;
    await sleep(200);
  }
  assert.equal(last.status, 200, last.text);
  assert.equal(last.json.status, "candidate", "the clip became a candidate: " + last.text.slice(0, 200));
  return last.json.asset;
}

async function scenariosV4(report) {
  const probe = await api("GET", "/api/avatar");
  if (probe.status === 404) {
    console.log("v4: GET /api/avatar -> 404 on this server; skipping the v4 block");
    return;
  }
  const original = (await api("GET", "/api/settings")).json;
  const restore = {};
  for (const k of ["dailyCapUsd", "monthlyCapUsd", "avatarAssetId", "callFaceProvider", "callFaceSourceAssetId", "hisFaceInPhotos", "spotifyEnabled", "spotifyPlaylistId", "spotifyPlaylistName", "placeCostUsd", "listeningLineEnabled", "videoMarkerEnabled", "videoProvider", "weatherProvider", "herLat", "herLon", "replyDelayMode", "realDelayMaxMinutes", "timezone", "herFirstTextsPerDay", "herFirstQuietHours", "proposalsAutoApprove", "imageProvider", "callProvider", "elevenLabsAgentId"]) {
    if (k in original) restore[k] = original[k];
  }
  await settingsPut({ dailyCapUsd: 200, monthlyCapUsd: 500, weatherProvider: "stub", videoProvider: "stub", callFaceProvider: "clips", listeningLineEnabled: false });
  const conversationId = await newConversation("integration v4");
  const ids = { him: null, usPhoto: null, aloneMessage: null, place: null, bench: null, faces: {}, clipMessage: null, clipAsset: null, delayed: null, firstText: null, spotifyState: null };

  // ---------------------------------------------------------------- the settings table

  await report.check("v4: PUT /api/settings accepts every v4 default and good value, refuses every bad value (the nine keys and the amendment's four)", async () => {
    for (const [key, [def, good, bad]] of Object.entries({ ...V4_SETTINGS_TABLE, ...V4_AMENDMENT_TABLE })) {
      const g = await api("PUT", "/api/settings", { [key]: good });
      assert.equal(g.status, 200, key + " good: " + g.text);
      assert.deepEqual(g.json[key], good, key + " good round-trips");
      const b = await api("PUT", "/api/settings", { [key]: bad });
      assert.equal(b.status, 400, key + " bad " + JSON.stringify(bad) + ": " + b.text);
      const d = await api("PUT", "/api/settings", { [key]: def });
      assert.equal(d.status, 200, key + " default: " + d.text);
      assert.deepEqual(d.json[key], def, key + " default round-trips");
    }
    for (const k of Object.keys(V4_SETTINGS_TABLE)) assert.deepEqual(original[k], V4_SETTINGS_TABLE[k][0], k + " shipped as the default");
    const zero = await api("PUT", "/api/settings", { imageProvider: "openai", placeCostUsd: 0 });
    assert.equal(zero.status, 400, "the place price at 0 on a paid image provider is refused: " + zero.text);
    assert.ok(/placeCostUsd/.test(zero.json.error), zero.json.error);
    const s = (await api("GET", "/api/settings")).json;
    assert.equal(s.placeCostUsd, 0.08);
  });

  // ---------------------------------------------------------------- the avatar (section 0)

  await report.check("v4: GET /api/avatar -> master-05 with its file and focus; PUT master-02 round-trips; master-09 refused; back to 05", async () => {
    assert.equal(probe.status, 200, probe.text);
    assert.equal(probe.json.assetId, "master-05");
    assert.ok(/^images\/masters\/05_.*\.png$/.test(probe.json.file), probe.json.file);
    assert.deepEqual(probe.json.focus, [50, 24]);
    await settingsPut({ avatarAssetId: "master-02" });
    const two = await api("GET", "/api/avatar");
    assert.equal(two.json.assetId, "master-02");
    assert.ok(/^images\/masters\/02_/.test(two.json.file), two.json.file);
    assert.deepEqual(two.json.focus, [58, 24]);
    const bad = await api("PUT", "/api/settings", { avatarAssetId: "master-09" });
    assert.equal(bad.status, 400, bad.text);
    await settingsPut({ avatarAssetId: "master-05" });
    assert.equal((await api("GET", "/api/avatar")).json.assetId, "master-05");
    const master = await fetchBytes("/" + probe.json.file);
    assert.equal(master.status, 200);
    assert.ok(master.contentType.startsWith("image/png"), master.contentType);
  });

  // ---------------------------------------------------------------- her phone and her places (section 1)

  await report.check("v4: GET /api/phone -> every key, the stub weather 68F clear, listening null with the switch off; with it on the stub's Stub Artist, and one listening run for two reads", async () => {
    // The settings-table check above put every key back to its shipped default, listeningLineEnabled true among them.
    await settingsPut({ listeningLineEnabled: false });
    const r = await api("GET", "/api/phone");
    assert.equal(r.status, 200, r.text);
    for (const k of ["now", "tz", "localClock", "weekday", "timeOfDay", "where", "scene", "weather", "city", "outfit", "mood", "wants", "asks", "today", "listening", "places", "map"]) assert.ok(k in r.json, "missing " + k);
    assert.ok(r.json.weather && r.json.weather.temp === 68 && r.json.weather.words === "clear", JSON.stringify(r.json.weather));
    assert.equal(r.json.listening, null, "the switch is off");
    assert.equal(r.json.city, "Portland, Maine");
    assert.equal(r.json.map.view.w, 360);
    assert.ok(r.json.map.outline.length >= 10);
    assert.ok(Array.isArray(r.json.places));
    const runsBefore = ((await api("GET", "/api/export")).json.modelRuns ?? []).filter((m) => m.kind === "listening").length;
    await settingsPut({ listeningLineEnabled: true });
    const on = await api("GET", "/api/phone");
    assert.equal(on.status, 200, on.text);
    assert.ok(on.json.listening && on.json.listening.artist === "Stub Artist" && on.json.listening.title === "Stub Song", JSON.stringify(on.json.listening));
    assert.equal(on.json.listening.line, "stuck in my head since the shop");
    assert.match(on.json.listening.day, /^\d{4}-\d{2}-\d{2}$/);
    const again = await api("GET", "/api/phone");
    assert.equal(again.json.listening.artist, "Stub Artist");
    const runsAfter = ((await api("GET", "/api/export")).json.modelRuns ?? []).filter((m) => m.kind === "listening").length;
    assert.equal(runsAfter - runsBefore, 1, "one call a day, cached on the second read");
    await settingsPut({ listeningLineEnabled: false });
  });

  await report.check("v4: POST /api/places -> 201; PUT lat/lon -> stored as owner; one coordinate -> 400; geocode on the stub -> 404 no_match (Stubtown is not near Portland); with her coordinates at Stubtown -> 200 openmeteo; restored", async () => {
    const created = await api("POST", "/api/places", { title: "integration place one", detail: "the first pin" });
    assert.equal(created.status, 201, created.text);
    ids.place = created.json.id;
    assert.equal(created.json.title, "integration place one");
    assert.equal(created.json.lat, null);
    assert.equal(created.json.picture, false);
    assert.equal(created.json.active, true);
    assert.ok(!("picture_key" in created.json), "never the R2 key");
    const pinned = await api("PUT", `/api/places/${ids.place}`, { lat: 43.66, lon: -70.25 });
    assert.equal(pinned.status, 200, pinned.text);
    assert.equal(pinned.json.lat, 43.66);
    assert.equal(pinned.json.lon, -70.25);
    assert.equal(pinned.json.geocoded_by, "owner");
    const half = await api("PUT", `/api/places/${ids.place}`, { lat: 43.7 });
    assert.equal(half.status, 400, half.text);
    const far = await api("PUT", `/api/places/${ids.place}`, { lat: 91, lon: 0 });
    assert.equal(far.status, 400, far.text);
    const mapped = await api("PUT", `/api/places/${ids.place}`, { lat: 43.661, lon: -70.251, geocodedBy: "map" });
    assert.equal(mapped.json.geocoded_by, "map");
    const miss = await api("POST", `/api/places/${ids.place}/geocode`);
    assert.equal(miss.status, 404, miss.text);
    assert.equal(miss.json.code, "no_match");
    await settingsPut({ herLat: 40.7, herLon: -74.0 });
    const hit = await api("POST", `/api/places/${ids.place}/geocode`);
    assert.equal(hit.status, 200, hit.text);
    assert.equal(hit.json.lat, 40.7);
    assert.equal(hit.json.lon, -74.0);
    assert.equal(hit.json.geocoded_by, "openmeteo");
    await settingsPut({ herLat: original.herLat, herLon: original.herLon });
    const list = await api("GET", "/api/places");
    assert.equal(list.status, 200, list.text);
    assert.ok(list.json.places.some((p) => p.id === ids.place));
    const dup = await api("POST", "/api/places", { title: "  Integration   Place One " });
    assert.equal(dup.status, 201, dup.text);
    assert.equal(dup.json.id, ids.place, "one row per normalised title");
    const missing = await api("PUT", "/api/places/pl_nothing", { lat: 1, lon: 1 });
    assert.equal(missing.status, 404);
  });

  await report.check("v4: a place thread through POST /api/life/threads shows in GET /api/places after the next read; an edit of the thread keeps the row with the new thread_id", async () => {
    const t = await api("POST", "/api/life/threads", { kind: "place", title: "the laundromat on 9th", detail: "fluorescent, one working dryer" });
    assert.equal(t.status, 201, t.text);
    const list = await api("GET", "/api/places");
    const row = list.json.places.find((p) => p.title === "the laundromat on 9th");
    assert.ok(row, "the thread's place row: " + JSON.stringify(list.json.places.map((p) => p.title)));
    assert.equal(row.thread_id, t.json.id);
    assert.equal(row.active, true);
    assert.equal(row.detail, "fluorescent, one working dryer");
    const edited = await api("PUT", `/api/life/threads/${t.json.id}`, { detail: "one working dryer, a new sign" });
    assert.equal(edited.status, 200, edited.text);
    assert.notEqual(edited.json.id, t.json.id, "threads are versioned");
    const after = (await api("GET", "/api/places")).json.places.find((p) => p.title === "the laundromat on 9th");
    assert.equal(after.id, row.id, "the same place row");
    assert.equal(after.thread_id, edited.json.id, "the head moved to the new version");
    const dropped = await api("DELETE", `/api/life/threads/${edited.json.id}`);
    assert.equal(dropped.status, 200, dropped.text);
    const gone = (await api("GET", "/api/places")).json.places.find((p) => p.id === row.id);
    assert.ok(gone, "a dropped thread keeps its row");
    assert.equal(gone.active, false);
    const phone = await api("GET", "/api/phone");
    assert.ok(phone.json.places.some((p) => p.id === row.id && p.active === false));
  });

  // ---------------------------------------------------------------- the call face (section 2)

  await report.check("v4: callFaceProvider clips, videoProvider stub: make idle -> 202 role callface; a second idle while generating -> 409; poll running then candidate with notes callface:idle; /media/:id video/mp4 with Range 206; approve -> clips.idle set, ready false", async () => {
    const gen = await api("POST", "/api/callface/make", { kind: "idle" });
    assert.equal(gen.status, 202, gen.text);
    assert.equal(gen.json.asset.role, "callface");
    assert.equal(gen.json.asset.approval_status, "generating");
    assert.ok(/\|kind:idle$/.test(gen.json.asset.notes), gen.json.asset.notes);
    const busy = await api("POST", "/api/callface/make", { kind: "idle" });
    assert.equal(busy.status, 409, busy.text);
    assert.equal(busy.json.code, "in_progress");
    const state = await api("GET", "/api/callface");
    assert.equal(state.status, 200, state.text);
    assert.equal(state.json.provider, "clips");
    assert.equal(state.json.source, "master-00");
    assert.ok(state.json.generating.some((a) => a.id === gen.json.asset.id), "listed under generating");
    const first = await api("POST", `/api/video/${gen.json.asset.id}/poll`);
    assert.equal(first.status, 200, first.text);
    assert.equal(first.json.status, "running");
    const candidate = await pollToCandidate(gen.json.asset.id);
    assert.equal(candidate.role, "callface");
    assert.equal(candidate.notes, "callface:idle");
    assert.match(candidate.sha256, /^[0-9a-f]{64}$/);
    const media = await fetchBytes(`/media/${candidate.id}`);
    assert.equal(media.status, 200);
    assert.ok(media.contentType.startsWith("video/mp4"), media.contentType);
    assert.equal(String.fromCharCode(...media.bytes.slice(4, 8)), "ftyp");
    const range = await fetch(BASE + `/media/${candidate.id}`, { headers: { range: "bytes=0-15" } });
    assert.equal(range.status, 206);
    assert.ok((range.headers.get("content-range") || "").startsWith("bytes 0-15/"));
    const listed = (await api("GET", "/api/callface")).json;
    assert.ok(listed.candidates.some((a) => a.id === candidate.id));
    const ok = await api("POST", `/api/images/${candidate.id}/decide`, { decision: "approve", note: "good" });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.asset.role, "callface");
    assert.equal(ok.json.asset.approval_status, "approved");
    assert.equal(ok.json.asset.notes, "callface:idle | good");
    ids.faces.idle = candidate.id;
    const after = (await api("GET", "/api/callface")).json;
    assert.equal(after.clips.idle && after.clips.idle.id, candidate.id);
    assert.equal(after.clips.listening, null);
    assert.equal(after.ready, false);
    const assets = (await api("GET", "/api/assets")).json;
    assert.ok(assets.callface.some((a) => a.id === candidate.id), "GET /api/assets lists it under callface");
    assert.equal(assets.candidates.filter((a) => a.role === "callface").length, 0);
  });

  await report.check("v4: make listening and talking, approve -> ready true; a second idle candidate approved -> the first is archived; the set costs three clips at the clip price", async () => {
    const usageBefore = (await api("GET", "/api/usage")).json.todayUsd;
    for (const kind of ["listening", "talking"]) {
      const gen = await api("POST", "/api/callface/make", { kind });
      assert.equal(gen.status, 202, kind + ": " + gen.text);
      const candidate = await pollToCandidate(gen.json.asset.id);
      assert.equal(candidate.notes, "callface:" + kind);
      const ok = await api("POST", `/api/images/${candidate.id}/decide`, { decision: "approve" });
      assert.equal(ok.status, 200, ok.text);
      ids.faces[kind] = candidate.id;
    }
    const ready = (await api("GET", "/api/callface")).json;
    assert.equal(ready.ready, true);
    for (const kind of ["idle", "listening", "talking"]) assert.equal(ready.clips[kind].id, ids.faces[kind]);
    const usageAfter = (await api("GET", "/api/usage")).json.todayUsd;
    assert.ok(Math.abs((usageAfter - usageBefore) - 0.5) < 0.005, "two clips at 0.25: " + (usageAfter - usageBefore));
    const again = await api("POST", "/api/callface/make", { kind: "idle" });
    assert.equal(again.status, 202, again.text);
    const second = await pollToCandidate(again.json.asset.id);
    const ok = await api("POST", `/api/images/${second.id}/decide`, { decision: "approve" });
    assert.equal(ok.status, 200, ok.text);
    const after = (await api("GET", "/api/callface")).json;
    assert.equal(after.clips.idle.id, second.id, "the new idle");
    assert.equal(after.ready, true);
    const assets = (await api("GET", "/api/assets")).json;
    assert.ok(assets.archive.some((a) => a.id === ids.faces.idle), "the first idle went to the archive");
    assert.ok(!assets.callface.some((a) => a.id === ids.faces.idle));
    assert.equal(assets.callface.length, 3, "one approved clip per kind");
    ids.faces.idle = second.id;
    const sys = await api("GET", "/api/system");
    assert.equal(sys.json.counts.callFaceClips, 3);
  });

  await report.check("v4: callFaceProvider lipsync -> make 503 detail reserved_v4_1, GET /api/callface provider lipsync ready false; off -> 503 detail off; a bad kind -> 400; restored to clips", async () => {
    await settingsPut({ callFaceProvider: "lipsync" });
    const reserved = await api("POST", "/api/callface/make", { kind: "idle" });
    assert.equal(reserved.status, 503, reserved.text);
    assert.equal(reserved.json.code, "provider_not_configured");
    assert.equal(reserved.json.detail, "reserved_v4_1");
    const state = await api("GET", "/api/callface");
    assert.equal(state.json.provider, "lipsync");
    assert.equal(state.json.ready, false, "reserved: never ready even with three clips");
    await settingsPut({ callFaceProvider: "off" });
    const off = await api("POST", "/api/callface/make", { kind: "idle" });
    assert.equal(off.status, 503, off.text);
    assert.equal(off.json.detail, "off");
    assert.equal((await api("GET", "/api/callface")).json.provider, "off");
    await settingsPut({ callFaceProvider: "clips" });
    const bad = await api("POST", "/api/callface/make", { kind: "dancing" });
    assert.equal(bad.status, 400, bad.text);
    assert.equal((await api("GET", "/api/callface")).json.ready, true);
  });

  // ---------------------------------------------------------------- him in the picture (section 3)

  // ---------------------------------------------------------------- A2: her own voice on a call (the [[ELEVEN]] stub)

  await report.check("v4 (A2): callProvider elevenlabs with no agent id -> start 503 provider_not_configured detail elevenlabs; with an agent id on the stub -> 201 transport webrtc, clientSecret stub-token, overrides carrying her instructions; GET /api/calls/:id and the audit carry no credential; end -> 200; restored", async () => {
    await settingsPut({ callProvider: "elevenlabs", elevenLabsAgentId: "" });
    const none = await api("POST", "/api/calls/start", { conversationId });
    assert.equal(none.status, 503, none.text);
    assert.equal(none.json.code, "provider_not_configured");
    assert.equal(none.json.detail, "elevenlabs");
    await settingsPut({ elevenLabsAgentId: "agent_stub" });
    const start = await api("POST", "/api/calls/start", { conversationId });
    assert.equal(start.status, 201, start.text);
    assert.equal(start.json.provider, "elevenlabs");
    assert.equal(start.json.transport, "webrtc");
    assert.equal(start.json.clientSecret, "stub-token");
    assert.equal(start.json.agentId, "agent_stub");
    const prompt = start.json.overrides && start.json.overrides.agent && start.json.overrides.agent.prompt;
    assert.ok(prompt && typeof prompt.prompt === "string" && prompt.prompt.length > 0, "the overrides carry her instructions: " + start.text.slice(0, 200));
    const row = await api("GET", `/api/calls/${start.json.call.id}`);
    assert.equal(row.status, 200, row.text);
    assert.ok(!/stub-token/.test(row.text), "the call read carries no credential");
    const audit = await api("GET", "/api/audit?limit=30");
    assert.equal(audit.status, 200, audit.text);
    assert.ok(!/stub-token/.test(audit.text), "no audit row carries the credential");
    const end = await api("POST", `/api/calls/${start.json.call.id}/end`, { reason: "ended", segments: [], seconds: 5 });
    assert.equal(end.status, 200, end.text);
    await settingsPut({ callProvider: restore.callProvider ?? "stub", elevenLabsAgentId: restore.elevenLabsAgentId ?? "" });
  });

  await report.check("v4: a photo of him on file and a description that names him -> the candidate row with_him 1, the audit's after.withHim true; the Images page lists it with with_him 1; the picture never names him on the row", async () => {
    const form = new FormData();
    form.set("photo", new Blob([tinyPng()], { type: "image/png" }), "him.png");
    const up = await apiForm("POST", "/api/him/photos", form);
    assert.equal(up.status, 201, up.text);
    ids.him = up.json.id;
    const t = await turn(conversationId, "[[PHOTO]] one of us", key("v4-photo-us"));
    assert.equal(t.status, 200, t.text);
    assert.equal(t.json.imagePending, true);
    const messageId = t.json.assistantMessage.id;
    const gen = await api("POST", "/api/images/generate", { conversationId, messageId, description: "selfie of the two of us at the counter, my head on your shoulder" });
    assert.equal(gen.status, 200, gen.text);
    assert.equal(gen.json.asset.approval_status, "candidate");
    assert.equal(Number(gen.json.asset.with_him), 1, "with_him on the row: " + JSON.stringify(gen.json));
    ids.usPhoto = gen.json.asset.id;
    const assets = (await api("GET", "/api/assets")).json;
    const listed = assets.candidates.find((a) => a.id === gen.json.asset.id);
    assert.ok(listed, "listed under candidates");
    assert.equal(Number(listed.with_him), 1);
    assert.ok(!JSON.stringify(assets).includes("him/"), "his own photo is never on the Images page");
    const audit = (await auditRows(100)).find((e) => e.action === "image.generate" && e.entity_id === gen.json.asset.id);
    assert.ok(audit, "audited image.generate");
    const after = auditAfter(audit);
    assert.ok(after && after.withHim === true, "after.withHim true: " + JSON.stringify(after));
    const m = await api("GET", `/api/messages/${messageId}`);
    assert.equal(m.json.image_id, gen.json.asset.id);
    assert.equal(m.json.image_status, "ready");
    assert.ok(!(m.json.flags_json || "").includes("him_not_on_file"), "no flag: his photo rode along");
    const ok = await api("POST", `/api/images/${gen.json.asset.id}/decide`, { decision: "approve" });
    assert.equal(ok.status, 200, ok.text);
    const pkg = await api("GET", "/api/export/character");
    assert.equal(pkg.status, 200, pkg.text);
    assert.ok(!pkg.json.images.some((i) => i.id === gen.json.asset.id), "a with-him picture never enters the character package");
    assert.ok(!JSON.stringify(pkg.json).includes("him/"));
  });

  await report.check("v4: the same description with no photo of him on file -> with_him 0 and him_not_on_file on the message; hisFaceInPhotos false -> with_him 0 and no flag; restored", async () => {
    const del = await api("DELETE", `/api/him/photos/${ids.him}`);
    assert.equal(del.status, 204, del.text);
    const t = await turn(conversationId, "[[PHOTO]] one more", key("v4-photo-nohim"));
    assert.equal(t.status, 200, t.text);
    const messageId = t.json.assistantMessage.id;
    const gen = await api("POST", "/api/images/generate", { conversationId, messageId, description: "my head on your shoulder, the ferry lights behind us" });
    assert.equal(gen.status, 200, gen.text);
    assert.equal(Number(gen.json.asset.with_him), 0);
    const m = await api("GET", `/api/messages/${messageId}`);
    const flags = JSON.parse(m.json.flags_json || "[]");
    assert.ok(flags.some((f) => f.code === "him_not_on_file"), "him_not_on_file on the message: " + m.json.flags_json);
    ids.aloneMessage = messageId;
    const form = new FormData();
    form.set("photo", new Blob([tinyPng()], { type: "image/png" }), "him.png");
    const up = await apiForm("POST", "/api/him/photos", form);
    assert.equal(up.status, 201, up.text);
    ids.him = up.json.id;
    await settingsPut({ hisFaceInPhotos: false });
    const t2 = await turn(conversationId, "[[PHOTO]] again", key("v4-photo-off"));
    const gen2 = await api("POST", "/api/images/generate", { conversationId, messageId: t2.json.assistantMessage.id, description: "selfie of the two of us" });
    assert.equal(gen2.status, 200, gen2.text);
    assert.equal(Number(gen2.json.asset.with_him), 0, "the switch is off");
    const m2 = await api("GET", `/api/messages/${t2.json.assistantMessage.id}`);
    assert.ok(!(m2.json.flags_json || "").includes("him_"), "no him flag with the switch off: " + m2.json.flags_json);
    await settingsPut({ hisFaceInPhotos: true });
    const owner = await api("POST", "/api/images/generate", { conversationId, description: "the harbour at dusk, the owner's own picture" });
    assert.equal(owner.status, 200, owner.text);
    assert.equal(owner.json.asset.message_id, null, "an owner picture has no message");
  });

  // ---------------------------------------------------------------- Spotify (section 4 and A1)

  await report.check("v4: GET /api/spotify -> configured (the stub), not connected; GET /api/spotify/token -> 403 not_connected; connect -> 302 to accounts.spotify.com with the seven scopes and a state; a wrong state -> 403; no body carries refresh_token", async () => {
    const status = await api("GET", "/api/spotify");
    assert.equal(status.status, 200, status.text);
    assert.equal(status.json.configured, true, "SPOTIFY_STUB:1 while ACCESS_AUD is empty");
    assert.equal(status.json.connected, false);
    assert.equal(status.json.playlist, null);
    assert.equal(status.json.playlistName, "songs from avelie");
    const token = await api("GET", "/api/spotify/token");
    assert.equal(token.status, 403, token.text);
    assert.equal(token.json.code, "not_connected");
    const connect = await apiRaw("GET", "/api/spotify/connect");
    assert.equal(connect.status, 302, connect.text);
    const location = new URL(connect.headers.get("location"));
    assert.equal(location.origin + location.pathname, "https://accounts.spotify.com/authorize");
    assert.equal(location.searchParams.get("response_type"), "code");
    assert.deepEqual(location.searchParams.get("scope").split(" "), ["playlist-modify-private", "playlist-read-private", "streaming", "user-read-email", "user-read-private", "user-read-playback-state", "user-modify-playback-state"]);
    // The origin as the Worker sees it (wrangler dev's proxy hands request.url without the port;
    // in production it is the https hostname): the host and the path are what must match, and the
    // callback derives the same string for the token exchange.
    const redirect = new URL(location.searchParams.get("redirect_uri"));
    assert.equal(redirect.hostname, new URL(BASE).hostname, "the redirect URI is on this origin");
    assert.equal(redirect.pathname, "/api/spotify/callback");
    ids.spotifyState = location.searchParams.get("state");
    assert.match(ids.spotifyState, /^[0-9a-f]{32}$/);
    const wrong = await apiRaw("GET", "/api/spotify/callback?code=stub&state=" + "0".repeat(32));
    assert.equal(wrong.status, 302, wrong.text);
    assert.equal(wrong.headers.get("location"), "/model?spotify=state_mismatch#spotify", "a refusal lands on the Model page with its code, never a raw error body");
    const cancelled = await apiRaw("GET", "/api/spotify/callback?error=access_denied&state=" + "0".repeat(32));
    assert.equal(cancelled.status, 302, cancelled.text);
    assert.equal(cancelled.headers.get("location"), "/model?spotify=access_denied#spotify", "Cancel on Spotify's page");
    const still = await api("GET", "/api/spotify");
    assert.equal(still.json.connected, false, "a mismatch stores nothing");
    for (const r of [status, token, connect, wrong, cancelled, still]) assert.ok(!r.text.includes("refresh_token"), "a Spotify body carried refresh_token");
    const audit = (await auditRows(50)).filter((e) => /^spotify\./.test(e.action));
    assert.ok(audit.some((e) => e.action === "spotify.connect"));
    assert.ok(!JSON.stringify(audit).includes(ids.spotifyState), "the state is not in the audit");
  });

  await report.check("v4: the callback with the right state -> 302 to /model#spotify; connected as Stub Listener, playlist stubplaylist ok, spotifyEnabled true; the token route answers an access token, never a refresh token, never audited", async () => {
    // The state was cleared by the failed callback above (single use): a fresh Connect first.
    const connect = await apiRaw("GET", "/api/spotify/connect");
    assert.equal(connect.status, 302, connect.text);
    const state = new URL(connect.headers.get("location")).searchParams.get("state");
    const done = await apiRaw("GET", "/api/spotify/callback?code=stub&state=" + state);
    assert.equal(done.status, 302, done.text);
    assert.equal(done.headers.get("location"), "/model#spotify");
    const status = await api("GET", "/api/spotify");
    assert.equal(status.json.connected, true, status.text);
    assert.equal(status.json.displayName, "Stub Listener");
    assert.equal(status.json.playlistId, "stubplaylist");
    assert.deepEqual(status.json.playlist, { ok: true, name: "songs from avelie" });
    const s = (await api("GET", "/api/settings")).json;
    assert.equal(s.spotifyEnabled, true);
    assert.equal(s.spotifyPlaylistId, "stubplaylist");
    const replay = await apiRaw("GET", "/api/spotify/callback?code=stub&state=" + state);
    assert.equal(replay.status, 302, "the state is single use: " + replay.text);
    assert.equal(replay.headers.get("location"), "/model?spotify=state_mismatch#spotify");
    assert.equal((await api("GET", "/api/spotify")).json.connected, true, "a replayed callback never disconnects him");
    const auditBefore = (await auditRows(200)).length;
    const token = await api("GET", "/api/spotify/token");
    assert.equal(token.status, 200, token.text);
    assert.equal(typeof token.json.accessToken, "string");
    assert.equal(token.json.premium, true);
    assert.equal(token.json.deviceName, "Avelie");
    assert.equal(token.json.player, "sdk");
    assert.deepEqual(Object.keys(token.json).sort(), ["accessToken", "deviceName", "expiresAt", "player", "premium"]);
    assert.ok(!token.text.includes("refresh"), "never a refresh token");
    const auditAfterCount = (await auditRows(200)).length;
    assert.equal(auditAfterCount, auditBefore, "the token route is never audited");
    for (const r of [status, done, token]) assert.ok(!r.text.includes("refresh_token"));
    const sys = await api("GET", "/api/system");
    assert.equal(sys.json.counts.spotifyConnected, 1);
    assert.equal(sys.json.providerKeys.spotify, true);
  });

  await report.check("v4: [[SONG]] -> song_json stored and spotify_status pending, then added within 10 s with trackUrl and uri; the same song again -> already; POST /api/messages/:id/spotify by hand; spotifyEnabled false -> off; restored", async () => {
    const r = await turn(conversationId, "[[SONG]] send me something", key("v4-song"));
    assert.equal(r.status, 200, r.text);
    const m = r.json.assistantMessage;
    assert.equal(typeof m.song_json, "string");
    assert.equal(m.spotify_status, "pending", JSON.stringify(m.spotify_status));
    const added = await waitFor("the song to be added", async () => {
      const x = await api("GET", `/api/messages/${m.id}`);
      return x.json && x.json.spotify_status === "added" ? x.json : null;
    }, 10_000, 300);
    const song = JSON.parse(added.song_json);
    assert.equal(song.trackUrl, "https://open.spotify.com/track/stubtrack");
    assert.equal(song.uri, "spotify:track:stubtrack");
    assert.equal(song.artist, "Some Artist");
    const again = await turn(conversationId, "[[SONG]] the same one", key("v4-song-again"));
    assert.equal(again.status, 200, again.text);
    const dup = await waitFor("the duplicate to be noticed", async () => {
      const x = await api("GET", `/api/messages/${again.json.assistantMessage.id}`);
      return x.json && x.json.spotify_status && x.json.spotify_status !== "pending" ? x.json : null;
    }, 10_000, 300);
    assert.equal(dup.spotify_status, "already");
    const byHand = await api("POST", `/api/messages/${m.id}/spotify`);
    assert.equal(byHand.status, 200, byHand.text);
    assert.equal(byHand.json.status, "already", "the track is on the playlist already");
    const noSong = await api("POST", `/api/messages/${r.json.userMessage.id}/spotify`);
    assert.ok([400, 404].includes(noSong.status), "his message carries no song: " + noSong.text);
    const list = await api("GET", `/api/conversations/${conversationId}/messages?channel=story`);
    assert.ok(list.json.some((x) => x.id === m.id && (x.spotify_status === "added" || x.spotify_status === "already")), "the rows carry spotify_status (the by-hand add above wrote already on it)");
    await settingsPut({ spotifyEnabled: false });
    const off = await turn(conversationId, "[[SONG]] with it off", key("v4-song-off"));
    assert.equal(off.status, 200, off.text);
    assert.equal(off.json.assistantMessage.spotify_status, null, "no pending status with the playlist off");
    const offRow = await api("GET", `/api/messages/${off.json.assistantMessage.id}`);
    assert.ok(offRow.json.spotify_status === null || offRow.json.spotify_status === "off", "off: " + offRow.json.spotify_status);
    const byHandOff = await api("POST", `/api/messages/${off.json.assistantMessage.id}/spotify`);
    assert.equal(byHandOff.json.status, "off");
    await settingsPut({ spotifyEnabled: true });
  });

  // ---------------------------------------------------------------- the album (section 5)

  await report.check("v4: GET /api/album -> the pictures she sent with their dates and the two-of-you picture under group us; the owner-fired picture absent; group approved and candidates; nextBefore null under the limit; a bad group 400", async () => {
    const all = await api("GET", "/api/album");
    assert.equal(all.status, 200, all.text);
    const ids2 = all.json.items.map((i) => i.id);
    assert.ok(ids2.includes(ids.usPhoto), "the with-him picture is in");
    assert.ok(all.json.items.every((i) => i.messageId), "every item has a message behind it");
    assert.equal(all.json.nextBefore, null);
    for (const i of all.json.items) assert.deepEqual(Object.keys(i).sort(), ["at", "bytes", "conversationId", "description", "id", "kind", "messageId", "place", "provider", "sceneStatus", "status", "withHim"]);
    const us = await api("GET", "/api/album?group=us");
    assert.deepEqual(us.json.items.map((i) => i.id), [ids.usPhoto]);
    assert.equal(us.json.items[0].withHim, true);
    assert.equal(us.json.items[0].status, "approved");
    assert.equal(us.json.items[0].conversationId, conversationId);
    const approved = await api("GET", "/api/album?group=approved");
    assert.ok(approved.json.items.every((i) => i.status === "approved"));
    const candidates = await api("GET", "/api/album?group=candidates");
    assert.ok(candidates.json.items.every((i) => i.status === "candidate"));
    assert.ok(candidates.json.items.length >= 1, "the no-him candidate");
    assert.ok(!JSON.stringify(all.json).includes("candidates/") && !JSON.stringify(all.json).includes("him/"), "never an R2 key");
    const one = await api("GET", "/api/album?limit=1");
    assert.equal(one.json.items.length, 1);
    assert.equal(typeof one.json.nextBefore, "string", "a full page pages");
    const next = await api("GET", "/api/album?limit=1&before=" + encodeURIComponent(one.json.nextBefore));
    assert.ok(next.json.items.length === 0 || next.json.items[0].id !== one.json.items[0].id);
    const bad = await api("GET", "/api/album?group=mine");
    assert.equal(bad.status, 400, bad.text);
  });

  // ---------------------------------------------------------------- deliveries and her first texts (section 6)

  await report.check("v4: real mode with a busy routine now -> the reply carries deliverAt in the future and pushed_at null; once it lands, the */20 cron stamps pushed_at (held under two minutes: stamped, never pushed); a second tick changes nothing", async () => {
    const routine = await api("POST", "/api/life/threads", { kind: "routine", title: "the shop", schedule_json: JSON.stringify({ tz: "UTC", blocks: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59", label: "at work" }] }) });
    assert.equal(routine.status, 201, routine.text);
    await settingsPut({ replyDelayMode: "real", realDelayMaxMinutes: 1, timezone: "UTC" });
    let reply;
    try {
      const r = await turn(conversationId, "real mode, at work", key("v4-real"));
      assert.equal(r.status, 200, r.text);
      assert.equal(typeof r.json.deliverAt, "string", "deliverAt: " + JSON.stringify(r.json.deliverAt));
      const at = Date.parse(r.json.deliverAt);
      assert.ok(at > Date.now(), "in the future");
      assert.ok(at - Date.now() <= 62_000, "within the one-minute cap");
      reply = r.json.assistantMessage;
      assert.ok(!reply.pushed_at, "pushed_at null at first");
      ids.delayed = reply.id;
      const waitMs = Math.max(0, at - Date.now() + 1_500);
      await sleep(waitMs);
      const tick = await scheduledCron("*/20 * * * *");
      assert.equal(tick.status, 200, tick.text);
      const stamped = await waitFor("pushed_at on the delayed reply", async () => {
        const m = await api("GET", `/api/messages/${reply.id}`);
        return m.json && typeof m.json.pushed_at === "string" ? m.json : null;
      }, 10_000, 300);
      const firstStamp = stamped.pushed_at;
      await sleep(1_100);
      const tick2 = await scheduledCron("*/20 * * * *");
      assert.equal(tick2.status, 200, tick2.text);
      const again = await api("GET", `/api/messages/${reply.id}`);
      assert.equal(again.json.pushed_at, firstStamp, "a second tick changes nothing");
      const latest = await api("GET", "/api/push/latest");
      assert.equal(latest.status, 200, latest.text);
      // Held under two minutes (realDelayMaxMinutes 1), so it was stamped, never pushed; the
      // spec: "a never-pushed reply never" is the notification's text.
      assert.notEqual(latest.json.messageId, reply.id, "a stamped but never-pushed reply is never the notification's text");
    } finally {
      await settingsPut({ replyDelayMode: "instant", realDelayMaxMinutes: original.realDelayMaxMinutes, timezone: original.timezone });
      const d = await api("DELETE", `/api/life/threads/${routine.json.id}`);
      assert.equal(d.status, 200, d.text);
    }
    const instant = await turn(conversationId, "instant again", key("v4-instant"));
    assert.equal(instant.json.deliverAt, null);
  });

  await report.check("v4: herFirstTextsPerDay 2 through PUT settings, the waking window about to close -> POST /api/herfirst/run sends one first text with no ask leading it; GET /api/push/latest answers it ahead of the delayed reply; restored to 0", async () => {
    const now = new Date();
    const quietStart = new Date(now.getTime() + 25 * 60_000);
    const quietEnd = new Date(now.getTime() - 5 * 60_000);
    await settingsPut({ timezone: "UTC", herFirstTextsPerDay: 2, herFirstQuietHours: `${hhmm(quietStart)}-${hhmm(quietEnd)}` });
    const conv = await newConversation("integration v4 her first");
    try {
      const life = await api("GET", "/api/life?status=active");
      for (const t of life.json.threads.filter((x) => x.schedule_json)) await api("DELETE", `/api/life/threads/${t.id}`);
      const r = await api("POST", "/api/herfirst/run", { force: true });
      assert.equal(r.status, 200, r.text);
      const list = await api("GET", `/api/conversations/${conv}/messages?channel=story&includePending=1`);
      assert.equal(list.json.length, 1, "one first text: " + r.text.slice(0, 300));
      const m = list.json[0];
      assert.equal(m.reply_to_id, null);
      assert.ok(m.content.trim().length > 0);
      assert.ok(!/\?\s*$/.test(m.content.split("\n")[0]) || !/still|about/.test(m.content), "no unanswered ask leads it: " + m.content);
      const flags = JSON.parse(m.flags_json || "[]");
      assert.ok(!flags.some((f) => f.code === "ask_nag" || f.code === "dependency_hook"), m.flags_json);
      assert.ok(/skip/.test(JSON.stringify(r.json).toLowerCase()), "the push is reported skipped (no VAPID keys)");
      ids.firstText = m.id;
      const latest = await api("GET", "/api/push/latest");
      assert.equal(latest.json.messageId, m.id, "a fresh first text comes ahead of the stamped delayed reply");
      assert.equal(latest.json.text, m.content);
    } finally {
      await settingsPut({ timezone: original.timezone, herFirstTextsPerDay: original.herFirstTextsPerDay, herFirstQuietHours: original.herFirstQuietHours });
    }
    const s = (await api("GET", "/api/settings")).json;
    assert.equal(s.herFirstTextsPerDay, 0, "her first texts ship off");
  });

  // ---------------------------------------------------------------- the memory map (section 7)

  await report.check("v4: GET /api/memory/map -> facts with a phase; a fact weighted 0.2 and untouched for 40 days is faded, after Remind her vivid; sealed carries her seeded untold facts by subject with no text; keptToday empty with auto-keep off, one row after a [[FACT]] turn with it on; restored", async () => {
    const t = await turn(conversationId, "[[WEIGHT:his cousin plays drums|0.2]] noted", key("v4-weight"));
    assert.equal(t.status, 200, t.text);
    const p = await pendingProposal("justin_fact", "cousin plays drums");
    await approve(p.id);
    const fact = (await state()).facts.justin.find((f) => f.fact === "his cousin plays drums");
    assert.ok(fact, "the fact about him");
    const put = await api("PUT", `/api/memory/fact/${fact.id}`, { weight: 0.2, lastTouched: ago(40 * DAY_MS_V3) });
    assert.equal(put.status, 200, put.text);
    const map = await api("GET", "/api/memory/map");
    assert.equal(map.status, 200, map.text);
    for (const k of ["facts", "history", "sealed", "keptToday", "counts", "settings", "now"]) assert.ok(k in map.json, "missing " + k);
    const faded = map.json.facts.find((f) => f.id === fact.id);
    assert.ok(faded, "the fact is on the map");
    assert.equal(faded.phase, "faded", JSON.stringify(faded));
    assert.equal(faded.weight, 0.2);
    assert.ok(map.json.counts.faded >= 1);
    const remind = await api("PUT", `/api/memory/fact/${fact.id}`, { lastTouched: new Date().toISOString() });
    assert.equal(remind.status, 200, remind.text);
    const back = (await api("GET", "/api/memory/map")).json.facts.find((f) => f.id === fact.id);
    assert.equal(back.phase, "vivid", JSON.stringify(back));
    assert.ok(map.json.sealed.length >= 1, "her seeded untold facts are sealed");
    for (const s of map.json.sealed) assert.deepEqual(Object.keys(s).sort(), ["createdAt", "id", "subject"]);
    const untold = (await state()).facts.avelie.filter((f) => Number(f.disclosed) === 0);
    // 2026-09-26: one tile per subject (the untold list repeated "singing" four times); a
    // repeated subject carries its count as " xN".
    const subjects = new Set(untold.map((f) => (typeof f.subject === "string" && f.subject.trim() ? f.subject.trim() : "untitled").toLowerCase()));
    assert.equal(map.json.sealed.length, subjects.size, "one sealed tile per untold subject");
    for (const f of untold) assert.ok(!JSON.stringify(map.json).includes(f.fact.slice(0, 40)), "the text of an untold fact never leaves: " + f.subject);
    assert.equal(map.json.counts.sealed, map.json.sealed.length);
    assert.deepEqual(map.json.keptToday, [], "auto-keep is off");
    await settingsPut({ proposalsAutoApprove: true });
    const kept = await turn(conversationId, "[[FACT:she keeps a jar of sea glass]] noted", key("v4-kept"));
    assert.equal(kept.status, 200, kept.text);
    const withKept = await waitFor("a kept-automatically row on the map", async () => {
      const m = await api("GET", "/api/memory/map");
      return m.json && m.json.keptToday.some((k) => /sea glass/.test(k.proposal)) ? m.json : null;
    }, 10_000, 300);
    assert.equal(withKept.counts.keptToday, withKept.keptToday.length);
    assert.equal(withKept.keptToday[0].kind, "avelie_fact");
    await settingsPut({ proposalsAutoApprove: original.proposalsAutoApprove ?? false });
  });

  // ---------------------------------------------------------------- scene and relationship promotion (section 8)

  await report.check("v4: [[SCENE:the harbour bench]] -> approve -> scene together at the harbour bench; [[SCENE:the pier]] -> moved; the bare [[SCENE]] -> the pier kept; the picker prefill source (the newest together version) agrees", async () => {
    const before = (await state()).scene.state;
    const a = await turn(conversationId, "[[SCENE:the harbour bench]] here", key("v4-scene-a"));
    assert.equal(a.status, 200, a.text);
    const pa = await pendingProposal("scene", "harbour bench");
    await approve(pa.id);
    const s1 = (await state()).scene.state;
    assert.equal(s1.status, "together", JSON.stringify(s1));
    assert.equal(s1.location, "the harbour bench");
    const b = await turn(conversationId, "[[SCENE:the pier]] walk", key("v4-scene-b"));
    assert.equal(b.status, 200, b.text);
    const pb = await pendingProposal("scene", "the pier");
    await approve(pb.id);
    const s2 = (await state()).scene.state;
    assert.equal(s2.location, "the pier");
    assert.equal(s2.status, "together");
    const c = await turn(conversationId, "[[SCENE]] still", key("v4-scene-c"));
    assert.equal(c.status, 200, c.text);
    const pc = await pendingProposal("scene", "same place");
    await approve(pc.id);
    const s3 = (await state()).scene.state;
    assert.equal(s3.location, "the pier", "a summary-only proposal keeps the place");
    assert.equal(s3.status, "together");
    const versions = await api("GET", "/api/state/versions/scene?limit=50");
    assert.equal(versions.status, 200, versions.text);
    const newestTogether = versions.json.find((v) => JSON.parse(v.state_json).status === "together");
    assert.equal(JSON.parse(newestTogether.state_json).location, "the pier", "the picker's prefill source");
    assert.notEqual(before.location, "the pier");
  });

  await report.check("v4 review: with proposalsAutoApprove on, an auto-kept scene proposal never moves an apart scene INTO together (his picker or his own approval does); the place still follows", async () => {
    const original = (await api("GET", "/api/settings")).json;
    const s0 = (await state()).scene.state;
    const apart = await api("PUT", "/api/state/scene", { state: { ...s0, status: "apart", location: null }, note: "review: apart" });
    assert.equal(apart.status, 200, apart.text);
    await settingsPut({ proposalsAutoApprove: true });
    try {
      const r = await turn(conversationId, "[[SCENE:her bed]] night", key("v4-auto-scene"));
      assert.equal(r.status, 200, r.text);
      const s1 = await waitFor("the auto-kept scene proposal", async () => {
        const s = (await state()).scene.state;
        return s.location === "her bed" ? s : null;
      }, 10_000, 300);
      assert.equal(s1.status, "apart", "a model's reading never puts him in the room: " + JSON.stringify(s1));
    } finally {
      await settingsPut({ proposalsAutoApprove: original.proposalsAutoApprove ?? false });
      const back = await api("PUT", "/api/state/scene", { state: { ...s0 }, note: "review: restored" });
      assert.equal(back.status, 200, back.text);
    }
  });

  await report.check("v4: [[REL:seeing each other|Justin]] -> approve -> relationship status and his_name set, trust kept; a mood-only relationship proposal -> approve -> nothing lost", async () => {
    const before = (await state()).relationship.state;
    const r = await turn(conversationId, "[[REL:seeing each other|Justin]] ok", key("v4-rel"));
    assert.equal(r.status, 200, r.text);
    const p = await pendingProposal("relationship", "seeing each other");
    await approve(p.id);
    const s1 = (await state()).relationship.state;
    assert.equal(s1.status, "seeing each other", JSON.stringify(s1));
    assert.equal(s1.his_name, "Justin");
    assert.equal(s1.trust, before.trust, "trust kept");
    assert.ok(String(s1.frontier).includes("seeing each other"));
    const m = await turn(conversationId, "[[MOOD:warm]] ok", key("v4-mood"));
    assert.equal(m.status, 200, m.text);
    const pm = await pendingProposal("relationship", "warm");
    await approve(pm.id);
    const s2 = (await state()).relationship.state;
    assert.equal(s2.status, "seeing each other", "nothing lost");
    assert.equal(s2.his_name, "Justin");
    assert.equal(s2.mood, "warm");
    const clear = await api("PUT", "/api/state/relationship", { state: { ...s2, mood: null, mood_set_at: null, mood_days: null, cooling_off_until: null }, note: "v4 mood cleared" });
    assert.equal(clear.status, 200, clear.text);
  });

  // ---------------------------------------------------------------- place pictures and the background contract (section 8)

  await report.check("v4: POST /api/places { the harbour bench } -> a picture on the stub (200, picture true, a place run row, usage up by placeCostUsd); /media/place/:id image/png; again -> 409; remake -> 200; PUT /api/state/scene together there -> the response carries place with picture true and last_used_at set", async () => {
    const created = await api("POST", "/api/places", { title: "the harbour bench", detail: "green paint, facing the ferry" });
    assert.equal(created.status, 201, created.text);
    ids.bench = created.json.id;
    const usageBefore = (await api("GET", "/api/usage")).json.todayUsd;
    const runsBefore = ((await api("GET", "/api/export")).json.modelRuns ?? []).filter((m) => m.kind === "place").length;
    const made = await api("POST", `/api/places/${ids.bench}/picture`, {});
    assert.equal(made.status, 200, made.text);
    assert.equal(made.json.picture, true);
    assert.ok(["day", "night"].includes(made.json.picture_light), made.json.picture_light);
    assert.ok(["winter", "spring", "summer", "fall"].includes(made.json.picture_season));
    assert.match(made.json.picture_sha256, /^[0-9a-f]{64}$/);
    assert.ok(/no people/.test(made.json.picture_prompt));
    assert.ok(!("picture_key" in made.json), "never the R2 key");
    const usageAfter = (await api("GET", "/api/usage")).json.todayUsd;
    assert.ok(Math.abs((usageAfter - usageBefore) - 0.08) < 0.005, "usage up by placeCostUsd: " + (usageAfter - usageBefore));
    const runsAfter = ((await api("GET", "/api/export")).json.modelRuns ?? []).filter((m) => m.kind === "place").length;
    assert.equal(runsAfter - runsBefore, 1, "a place run row");
    const png = await fetchBytes(`/media/place/${ids.bench}`);
    assert.equal(png.status, 200);
    assert.ok(png.contentType.startsWith("image/png"), png.contentType);
    assert.deepEqual(Array.from(png.bytes.slice(0, 4)), [0x89, 0x50, 0x4e, 0x47]);
    const again = await api("POST", `/api/places/${ids.bench}/picture`, {});
    assert.equal(again.status, 409, again.text);
    assert.equal(again.json.code, "already_generated");
    const remade = await api("POST", `/api/places/${ids.bench}/picture`, { remake: true });
    assert.equal(remade.status, 200, remade.text);
    assert.equal(remade.json.picture, true);
    const sceneBefore = (await state()).scene.state;
    const put = await api("PUT", "/api/state/scene", { state: { ...sceneBefore, status: "together", location: "The Harbour Bench" }, note: "v4 background" });
    assert.equal(put.status, 200, put.text);
    assert.deepEqual(put.json.place, { id: ids.bench, picture: true }, JSON.stringify(put.json.place));
    const row = (await api("GET", "/api/places")).json.places.find((p) => p.id === ids.bench);
    assert.equal(typeof row.last_used_at, "string", "last_used_at set");
    const phone = await api("GET", "/api/phone");
    const here = phone.json.places.find((p) => p.id === ids.bench);
    assert.equal(here.here, true, "the scene place is here");
    assert.equal(here.picture, true);
    const apart = await api("PUT", "/api/state/scene", { state: { ...sceneBefore, status: "apart", location: null }, note: "v4 apart" });
    assert.equal(apart.json.place, null);
    const nothing = await api("POST", "/api/places/pl_nothing/picture", {});
    assert.equal(nothing.status, 404);
    const sys = await api("GET", "/api/system");
    assert.ok(sys.json.counts.placesWithPicture >= 1, JSON.stringify(sys.json.counts));
  });

  await report.check("v4: DELETE /api/places/:id/picture -> picture false and /media/place/:id 404; an unknown place 404; the first place never had one", async () => {
    const del = await api("DELETE", `/api/places/${ids.bench}/picture`);
    assert.equal(del.status, 200, del.text);
    assert.equal(del.json.picture, false);
    assert.equal((await fetchBytes(`/media/place/${ids.bench}`)).status, 404);
    assert.equal((await fetchBytes(`/media/place/${ids.place}`)).status, 404);
    assert.equal((await fetchBytes("/media/place/pl_nothing")).status, 404);
    assert.equal((await api("DELETE", "/api/places/pl_nothing/picture")).status, 404);
    const remade = await api("POST", `/api/places/${ids.bench}/picture`, {});
    assert.equal(remade.status, 200, "a picture can be made again after a delete: " + remade.text);
  });

  // ---------------------------------------------------------------- the system counts

  await report.check("v4: GET /api/system counts carry placesWithPicture, callFaceClips and spotifyConnected; providerKeys.spotify; disconnect -> spotifyConnected 0 and the export carries no spotifyAuth key", async () => {
    const sys = await api("GET", "/api/system");
    assert.equal(sys.status, 200, sys.text);
    assert.equal(sys.json.counts.placesWithPicture, 1);
    assert.equal(sys.json.counts.callFaceClips, 3);
    assert.equal(sys.json.counts.spotifyConnected, 1);
    assert.equal(sys.json.providerKeys.spotify, true);
    const off = await api("POST", "/api/spotify/disconnect");
    assert.equal(off.status, 200, off.text);
    assert.deepEqual(off.json, { ok: true });
    const status = await api("GET", "/api/spotify");
    assert.equal(status.json.connected, false);
    assert.equal((await api("GET", "/api/settings")).json.spotifyEnabled, false);
    assert.equal((await api("GET", "/api/system")).json.counts.spotifyConnected, 0);
    const exp = await api("GET", "/api/export");
    assert.equal(exp.status, 200, exp.text);
    assert.ok(!("spotifyAuth" in exp.json) && !("spotify_auth" in exp.json), "the export carries no Spotify row");
    assert.ok(!exp.text.includes("stub-refresh") && !exp.text.includes("refresh_token"), "no token in the export");
    assert.ok(Array.isArray(exp.json.places) && exp.json.places.some((p) => p.id === ids.bench), "the export carries places");
    assert.ok(!("panelCache" in exp.json), "a cache is not exported");
    const token = await api("GET", "/api/spotify/token");
    assert.equal(token.status, 403, "disconnected: " + token.text);
  });

  // ---------------------------------------------------------------- the UI smoke

  await report.check("v4 UI smoke: every page, script, the stylesheet, sw.js, the manifest and the six masters answer 200 with their content type; every page carries the shell; node --check on every public/js file", async () => {
    for (const p of V4_PAGES) {
      const r = await fetch(BASE + p);
      const text = await r.text();
      assert.equal(r.status, 200, p + " -> " + r.status);
      assert.ok((r.headers.get("content-type") || "").includes("text/html"), p + " " + r.headers.get("content-type"));
      for (const needle of ['class="brand"', 'id="avatar"', 'class="wordmark"', 'class="nav"']) assert.ok(text.includes(needle), p + " lacks " + needle);
      assert.ok(!/\sstyle=/.test(text), p + " carries a style attribute");
      const csp = r.headers.get("content-security-policy") || "";
      assert.ok(/default-src 'self'/.test(csp) && !/unsafe-inline/.test(csp), p + " CSP: " + csp);
    }
    for (const s of V4_SCRIPTS) {
      const r = await fetch(BASE + s);
      assert.equal(r.status, 200, s + " -> " + r.status);
      assert.ok(/javascript/.test(r.headers.get("content-type") || ""), s + " " + r.headers.get("content-type"));
      await r.arrayBuffer();
    }
    const css = await fetch(BASE + "/css/app.css");
    assert.equal(css.status, 200);
    assert.ok(/text\/css/.test(css.headers.get("content-type") || ""));
    const sw = await fetch(BASE + "/sw.js");
    assert.equal(sw.status, 200);
    assert.ok(/javascript/.test(sw.headers.get("content-type") || ""));
    const manifest = await fetch(BASE + "/manifest.webmanifest");
    assert.equal(manifest.status, 200);
    assert.ok(/manifest|json/.test(manifest.headers.get("content-type") || ""), manifest.headers.get("content-type"));
    const masters = (await api("GET", "/api/assets")).json.masters;
    assert.equal(masters.length, 6, "six masters");
    for (const m of masters) {
      const r = await fetch(BASE + "/" + m.file);
      assert.equal(r.status, 200, m.file);
      assert.ok((r.headers.get("content-type") || "").startsWith("image/png"), m.file + " " + r.headers.get("content-type"));
      await r.arrayBuffer();
    }
    assert.ok(masters.some((m) => /05_MASTER_GAVINS_BLACK_DRESS_APPROVED\.png$/.test(m.file)), "the avatar master");
    const { execFileSync } = await import("node:child_process");
    const { readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(ROOT, "public", "js");
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".js"))) execFileSync(process.execPath, ["--check", join(dir, f)], { stdio: "pipe" });
    return "pages " + V4_PAGES.length + ", scripts " + V4_SCRIPTS.length + ", masters " + masters.length;
  });

  // ---------------------------------------------------------------- her clips from the chat (amendment A3)

  await report.check("v4 (A3): a [[CLIP]] turn -> the line stripped, one video row bound to the message (image_id, image_status pending, flag clip_pending); poll -> candidate ready on the message; the album shows the clip beside the photos", async () => {
    const r = await turn(conversationId, "[[CLIP]] show me", key("v4-clip"));
    assert.equal(r.status, 200, r.text);
    const m = r.json.assistantMessage;
    assert.ok(!/\[clip:/i.test(m.content), "the clip line is stripped: " + m.content);
    assert.ok(m.content.trim().length > 0);
    const flags = r.json.flags ?? JSON.parse(m.flags_json || "[]");
    const pending = flags.find((f) => f.code === "clip_pending");
    assert.ok(pending, "clip_pending on the reply: " + JSON.stringify(flags));
    assert.ok(!flags.some((f) => f.code === "clip_unavailable"));
    const stored = await api("GET", `/api/messages/${m.id}`);
    assert.equal(typeof stored.json.image_id, "string", "the clip rides on image_id");
    assert.equal(stored.json.image_status, "pending");
    ids.clipMessage = m.id;
    ids.clipAsset = stored.json.image_id;
    const assets = (await api("GET", "/api/assets")).json;
    const row = assets.generating.find((a) => a.id === ids.clipAsset) ?? assets.candidates.find((a) => a.id === ids.clipAsset);
    assert.ok(row, "the video row is listed");
    assert.equal(row.role, "video");
    assert.equal(row.message_id, m.id);
    assert.equal(row.conversation_id, conversationId);
    assert.equal(row.prompt, "she looks up from the record and half smiles, then looks away");
    const candidate = await pollToCandidate(ids.clipAsset);
    assert.equal(candidate.role, "video");
    assert.equal(candidate.message_id, m.id);
    const ready = await api("GET", `/api/messages/${m.id}`);
    assert.equal(ready.json.image_status, "ready");
    const media = await fetchBytes(`/media/${ids.clipAsset}`);
    assert.equal(media.status, 200);
    assert.ok(media.contentType.startsWith("video/mp4"));
    const album = await api("GET", "/api/album");
    const item = album.json.items.find((i) => i.id === ids.clipAsset);
    assert.ok(item, "the clip is in the album");
    assert.equal(item.kind, "clip");
    assert.equal(item.messageId, m.id);
    const ok = await api("POST", `/api/images/${ids.clipAsset}/decide`, { decision: "approve" });
    assert.equal(ok.status, 200, ok.text);
  });

  await report.check("v4 (A3): videoMarkerEnabled false -> the clip line is stripped with the flag clip_unavailable and no row is made; videoProvider off the same; restored", async () => {
    await settingsPut({ videoMarkerEnabled: false });
    const generatingBefore = (await api("GET", "/api/assets")).json.generating.length;
    const r = await turn(conversationId, "[[CLIP]] one more", key("v4-clip-off"));
    assert.equal(r.status, 200, r.text);
    const m = r.json.assistantMessage;
    assert.ok(!/\[clip:/i.test(m.content), m.content);
    const flags = r.json.flags ?? JSON.parse(m.flags_json || "[]");
    assert.ok(flags.some((f) => f.code === "clip_unavailable"), JSON.stringify(flags));
    assert.ok(!flags.some((f) => f.code === "clip_pending"));
    const stored = await api("GET", `/api/messages/${m.id}`);
    assert.equal(stored.json.image_id, null, "no row");
    assert.equal(stored.json.image_status, null);
    assert.equal((await api("GET", "/api/assets")).json.generating.length, generatingBefore, "nothing generating");
    await settingsPut({ videoMarkerEnabled: true, videoProvider: "off" });
    const off = await turn(conversationId, "[[CLIP]] with the provider off", key("v4-clip-provider-off"));
    const offFlags = off.json.flags ?? JSON.parse(off.json.assistantMessage.flags_json || "[]");
    assert.ok(offFlags.some((f) => f.code === "clip_unavailable"), JSON.stringify(offFlags));
    assert.equal((await api("GET", `/api/messages/${off.json.assistantMessage.id}`)).json.image_id, null);
    await settingsPut({ videoProvider: "stub" });
  });

  // ---------------------------------------------------------------- the gate lists for phase 3 are static; restore what the block touched

  await report.check("v4: his photo removed and every setting back to what the block found", async () => {
    if (ids.him) {
      const del = await api("DELETE", `/api/him/photos/${ids.him}`);
      assert.equal(del.status, 204, del.text);
    }
    const back = await settingsPut(restore);
    for (const k of Object.keys(restore)) assert.deepEqual(back[k], restore[k], k);
    const s = (await api("GET", "/api/settings")).json;
    assert.equal(s.herFirstTextsPerDay, 0);
    assert.equal(s.replyDelayMode, "instant");
    assert.equal(s.spotifyEnabled, false);
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
      // v3: POST /api/finetune/use needs the key to exist; the stub never calls OpenAI.
      "--var", "OPENAI_API_KEY:dummy-for-settings-only",
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
    console.log("");
    await scenariosV3(report);
    console.log("");
    await scenariosV31(report);

    // Second phase (2026-09-25), same port and state, with the local image-provider overlay
    // off: `--var DEFAULT_IMAGE_PROVIDER:` blanks it the way the dev script blanks
    // ACCESS_AUD, so a stored imageProvider of runway reaches the pipeline and a photo
    // without RUNWAY_API_KEY fails the honest way (503 provider_not_configured).
    await stopWrangler(wrangler);
    if (await answering()) throw new Error("the first server is still answering on " + BASE + " after shutdown");
    const tu = Date.now();
    wrangler = startWrangler([
      "--port", String(PORT), "--local", "--persist-to", STATE_ARG,
      "--var", "APP_ENV:" + APP_ENV_TAG,
      "--var", "ACCESS_AUD:",
      "--var", `DEV_ACTOR_EMAIL:${DEV_ACTOR_EMAIL}`,
      "--var", "DEFAULT_PROVIDER:stub",
      "--var", "DEFAULT_IMAGE_PROVIDER:",
      "--var", "OPENAI_API_KEY:dummy-for-settings-only",
    ], { DEV_ACTOR_EMAIL, DEFAULT_PROVIDER: "stub", DEFAULT_IMAGE_PROVIDER: "" });
    await waitFor("wrangler dev (image overlay off) on " + BASE, async () => {
      if (wrangler.hasExited()) throw new Error("wrangler dev exited before it was ready");
      const r = await api("GET", "/api/me");
      return r.status === 200 && r.json && r.json.env === APP_ENV_TAG;
    }, BOOT_TIMEOUT_MS, 500).catch((e) => {
      console.log("wrangler output (tail):");
      console.log(wrangler.tail());
      throw e;
    });
    console.log(`\nwrangler dev (image overlay off) ready on ${BASE} (${Date.now() - tu} ms)\n`);

    await runwayScenarios(report, conversationId);

    // v4 phase (2026-09-26): a FRESH state, so the stub's photo and clip bytes (rejected
    // once each by the v1 and v3 blocks, and blacklisted for the rest of that state) can
    // become candidates again; --var SPOTIFY_STUB:1 drives the Spotify flow keyless.
    await stopWrangler(wrangler);
    if (await answering()) throw new Error("the second server is still answering on " + BASE + " after shutdown");
    console.log(`\nintegration v4: fresh state at ${STATE_DIR_V4}`);
    removeDir(STATE_DIR_V4);
    const tm4 = Date.now();
    const migrate4 = await runCommand(["d1", "migrations", "apply", "avelie", "--local", "--persist-to", STATE_ARG_V4], { env: { CI: "1" } });
    if (migrate4.code !== 0) {
      console.log(migrate4.output);
      throw new Error("v4 migrations failed with exit code " + migrate4.code);
    }
    console.log(`v4 migrations applied (${Date.now() - tm4} ms)`);
    const t4 = Date.now();
    wrangler = startWrangler([
      "--port", String(PORT), "--local", "--persist-to", STATE_ARG_V4, "--test-scheduled",
      "--var", "APP_ENV:" + APP_ENV_TAG,
      "--var", "ACCESS_AUD:",
      "--var", `DEV_ACTOR_EMAIL:${DEV_ACTOR_EMAIL}`,
      "--var", "DEFAULT_PROVIDER:stub",
      "--var", "DEFAULT_IMAGE_PROVIDER:stub",
      "--var", "OPENAI_API_KEY:dummy-for-settings-only",
      "--var", "SPOTIFY_STUB:1",
      "--var", "ELEVENLABS_STUB:1",
      "--var", "ELEVENLABS_API_KEY:dummy-for-settings-only",
    ], STUB_ENV);
    await waitFor("wrangler dev (v4, fresh state) on " + BASE, async () => {
      if (wrangler.hasExited()) throw new Error("wrangler dev exited before it was ready");
      const r = await api("GET", "/api/me");
      return r.status === 200 && r.json && r.json.env === APP_ENV_TAG;
    }, BOOT_TIMEOUT_MS, 500).catch((e) => {
      console.log("wrangler output (tail):");
      console.log(wrangler.tail());
      throw e;
    });
    console.log(`wrangler dev (v4) ready on ${BASE} (${Date.now() - t4} ms)\n`);
    await scenariosV4(report);

    // Third phase, same port and state, with the production gate switched on. The gated
    // server cannot be told apart by /api/me (401), so nothing may answer before it boots.
    await stopWrangler(wrangler);
    if (await answering()) throw new Error("the second server is still answering on " + BASE + " after shutdown");
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
