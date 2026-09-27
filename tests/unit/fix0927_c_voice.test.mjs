// Fix 2026-09-27 (lane C4): no voice note in a Together scene. Her 9:30am reply ended with the
// hidden [voice] marker while they stood together at the record store, and the app made a voice
// note in the generic Workers AI voice. Now: in a Together scene no note is ever made (the marker
// is still stripped from her text), and the prompt's rhythm cue never offers a voice note there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadSrc } from "./helpers.mjs";
import { scriptedD1, settingsV5 } from "./helpers_v5.mjs";

const voice = await loadSrc("voice");
const context = await loadSrc("context");
const chat = await loadSrc("chat");

const src = (name) => readFileSync(new URL(`../../src/${name}.ts`, import.meta.url), "utf8");

test("voiceWanted: a Together scene never gets a note, in any mode; outside one nothing changed", () => {
  for (const voiceMode of ["off", "some", "all"]) {
    for (const marker of [true, false]) {
      const s = settingsV5({ voiceProvider: "stub", voiceMode });
      assert.equal(voice.voiceWanted(s, marker, true), false, `${voiceMode} ${marker}`);
      assert.equal(voice.voiceWanted(s, marker, false), voice.voiceWanted(s, marker), "the two-argument call is the apart answer");
    }
  }
  assert.equal(voice.voiceWanted(settingsV5({ voiceProvider: "stub", voiceMode: "some" }), true), true);
  assert.equal(voice.voiceWanted(settingsV5({ voiceProvider: "stub", voiceMode: "all" }), false), true);
});

test("the [voice] marker is still stripped from her text (parseVoiceMarker is untouched by the scene)", () => {
  const r = voice.parseVoiceMarker("ok im right here\n[voice]");
  assert.equal(r.clean, "ok im right here");
  assert.equal(r.voice, true);
});

test("voiceCueAllowed: never in a Together scene; apart only with notes on and a provider configured", () => {
  const env = { APP_ENV: "unit" };
  const on = settingsV5({ voiceProvider: "stub", voiceMode: "some" });
  assert.equal(context.voiceCueAllowed(on, env, "together"), false);
  assert.equal(context.voiceCueAllowed(on, env, "apart"), true);
  assert.equal(context.voiceCueAllowed(settingsV5({ voiceProvider: "stub", voiceMode: "off" }), env, "apart"), false);
  assert.equal(context.voiceCueAllowed(on, undefined, "apart"), false);
  assert.equal(context.voiceCueAllowed(settingsV5({ voiceProvider: "workersai", voiceMode: "all" }), env, "together"), false);
});

test("the prompt's rhythm cue reads voiceCueAllowed with the scene mode", () => {
  const c = src("context");
  assert.ok(/const voiceAllowed = attempt\("voiceCueAllowed", \(\) => voiceCueAllowed\(settings, opts\.env, mode\), false\);/.test(c));
});

test("commitReply decides the note with the scene the reply was written in and hands that to afterReply", () => {
  const c = src("chat");
  assert.ok(/const together = assembled\.state\.mode === "together";\n\s+const wantsVoice = voiceWanted\(settings, chosen\.voice, together\);/.test(c));
  assert.ok(/REPLY_TOGETHER\.set\(response, together\);\n\s+REPLY_INTIMATE\.set\(response, [^\n]+\);\n\s+return response;/.test(c));
  // Two callers since dirty talk mode (2026-09-27): the voice note, and the spoken line of an
  // intimate scene (her own ElevenLabs voice only), in the same afterReply, one or the other.
  assert.equal((c.match(/attachVoiceNote\(/g) ?? []).length, 2, "the note and the spoken line");
});

// afterReply with a response it has not seen (the fallback reads the current scene).
function harness(sceneStatus) {
  const db = scriptedD1([
    [/SELECT \* FROM state_versions WHERE entity = \?1/, (b) => (b[0] === "scene"
      ? [{ id: "st_s", entity: "scene", version: 40, state_json: JSON.stringify({ status: sceneStatus, location: "the record store" }), source: "owner", note: null, created_at: "2026-09-27T13:00:00.000Z" }]
      : [])],
  ]);
  const puts = [];
  const env = { APP_ENV: "unit", MEDIA: { put: async (key) => { puts.push(key); }, delete: async () => {} } };
  const waits = [];
  const ctx = { waitUntil: (p) => { waits.push(p); }, passThroughOnException: () => {} };
  const response = {
    conversationId: "c_1",
    userMessage: null,
    assistantMessage: { id: "m_her", conversation_id: "c_1", channel: "story", role: "assistant", content: "come here, listen to this", created_at: "2026-09-27T13:30:00.000Z", seq: 9, idempotency_key: null, reply_to_id: null, model_run_id: null, flags_json: null, image_id: null, image_status: null, song_json: null },
    deliverAt: null,
    run: { provider: "stub", model: "stub", inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0, promptVersion: "p" },
    flags: [],
    imagePending: false,
    replayed: false,
  };
  return { db, env, ctx, waits, puts, response };
}

const noteSettings = (voiceMode) => settingsV5({ voiceProvider: "stub", voiceMode, proposalsEnabled: false, spotifyEnabled: false });

test("afterReply: in a Together scene no note is made, even with her marker and voice mode all", async () => {
  for (const mode of ["some", "all"]) {
    const h = harness("together");
    chat.afterReply(h.env, h.ctx, h.db, noteSettings(mode), h.response, true, "owner");
    await Promise.all(h.waits);
    assert.deepEqual(h.puts, [], mode);
    assert.ok(!h.db.log.some((e) => /audio_key/.test(e.sql)), mode);
  }
});

test("afterReply: apart, her marker still makes the note", async () => {
  const h = harness("apart");
  chat.afterReply(h.env, h.ctx, h.db, noteSettings("some"), h.response, true, "owner");
  await Promise.all(h.waits);
  assert.deepEqual(h.puts, ["voice/m_her.mp3"]);
  assert.ok(h.db.log.some((e) => /UPDATE messages SET audio_key/.test(e.sql)));
});

test("afterReply: no marker in mode some schedules nothing, as before", () => {
  const h = harness("apart");
  chat.afterReply(h.env, h.ctx, h.db, noteSettings("some"), h.response, false, "owner");
  assert.equal(h.waits.length, 0);
});
