// Her own voice through ElevenLabs (SPEC_V4 Amendment A2, lane L10): the adapter's mint
// (WebRTC token, the signed-url fallback) and text-to-speech on the [[ELEVEN]] stub, the
// pricing of a note through the caps, the elevenlabs branches of calls.ts and voice.ts,
// the browser side's pure pieces, and the vendored client on disk.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSrc, fakeD1, BAD_TYPOGRAPHY } from "./helpers.mjs";
import { secretEnv, SECRET_VALUES } from "./helpers_v2.mjs";
import { settingsV3 } from "./helpers_v3.mjs";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..", "..");
const eleven = await loadSrc("providers/elevenlabs");
const stub = await loadSrc("providers/stub");
const calls = await loadSrc("calls");
const voice = await loadSrc("voice");
const { ProviderError } = await loadSrc("types");
const page = await import(new URL("../../public/js/call_elevenlabs.js", import.meta.url));
const vendorScript = await import(new URL("../../scripts/vendor_elevenlabs.mjs", import.meta.url));

const KEY = "el-SECRET-elevenlabs-0003";
const env = (overrides = {}) => secretEnv({ ELEVENLABS_STUB: "1", ...overrides });
const settings = (overrides = {}) =>
  settingsV3({ voiceProvider: "elevenlabs", elevenLabsVoiceId: "voice_abc123", elevenLabsAgentId: "agent_7101k5", elevenLabsCallPricePerMinute: 0.1, callProvider: "elevenlabs", ...overrides });

const noSecret = (text) => {
  for (const s of SECRET_VALUES) assert.ok(!String(text).includes(s), "a secret leaked: " + String(text).slice(0, 200));
};

// ------------------------------------------------------------------ the mint

test("mintSession: GET /v1/convai/conversation/token?agent_id= with xi-api-key -> a webrtc session carrying the stub token; nothing else in it", async () => {
  const rw = stub.stubElevenLabsFetch();
  const p = eleven.makeElevenLabsProvider({ fetch: rw.fetch, now: () => 1_700_000_000_000 });
  const s = await p.mintSession(env(), { agentId: "agent_7101k5" });
  assert.equal(s.transport, "webrtc");
  assert.equal(s.credential, stub.STUB_ELEVEN_TOKEN);
  assert.equal(s.agentId, "agent_7101k5");
  assert.equal(s.expiresAt, 1_700_000_000 + eleven.ELEVENLABS_CREDENTIAL_TTL_S);
  assert.equal(rw.requests.length, 1);
  const r = rw.requests[0];
  assert.equal(r.method, "GET");
  assert.ok(r.url.startsWith(eleven.ELEVENLABS_TOKEN_URL + "?agent_id=agent_7101k5"), r.url);
  assert.equal(r.headers["xi-api-key"], KEY);
  noSecret(JSON.stringify(s));
});

test("mintSession: a 404 on the token endpoint falls back once to get-signed-url -> a websocket session with the wss url", async () => {
  const rw = stub.stubElevenLabsFetch();
  const f = async (url, init) => {
    if (url.startsWith(eleven.ELEVENLABS_TOKEN_URL)) return new Response(JSON.stringify({ detail: { status: "not_found", message: "no token endpoint" } }), { status: 404, headers: { "content-type": "application/json" } });
    return rw.fetch(url, init);
  };
  const s = await eleven.makeElevenLabsProvider({ fetch: f }).mintSession(env(), { agentId: "agent_7101k5" });
  assert.equal(s.transport, "websocket");
  assert.equal(s.credential, stub.STUB_ELEVEN_SIGNED_URL);
  assert.equal(rw.requests.length, 1);
  assert.ok(rw.requests[0].url.startsWith(eleven.ELEVENLABS_SIGNED_URL_URL + "?agent_id="));
});

test("mintSession: a 401 never falls back and never echoes the key; a missing key is a config error; a bad agent id too", async () => {
  let calls = 0;
  const f = async () => {
    calls++;
    return new Response(JSON.stringify({ detail: { status: "invalid_api_key", message: "Invalid API key: " + KEY } }), { status: 401, headers: { "content-type": "application/json" } });
  };
  const p = eleven.makeElevenLabsProvider({ fetch: f });
  await assert.rejects(p.mintSession(env(), { agentId: "agent_7101k5" }), (e) => {
    assert.ok(e instanceof ProviderError);
    assert.equal(e.kind, "auth");
    noSecret(e.message);
    return true;
  });
  assert.equal(calls, 1, "no fallback on an authentication failure");
  await assert.rejects(p.mintSession(env({ ELEVENLABS_API_KEY: "" }), { agentId: "agent_7101k5" }), (e) => e.kind === "config" && e.status === 503);
  await assert.rejects(p.mintSession(env(), { agentId: "not an id!" }), (e) => e.kind === "config");
  await assert.rejects(eleven.makeElevenLabsProvider({ fetch: async () => { throw new TypeError("fetch failed"); } }).mintSession(env(), { agentId: "agent_1" }), (e) => e.kind === "network" && e.retryable);
});

// ------------------------------------------------------------------ text-to-speech

test("textToSpeech: POST /v1/text-to-speech/<voice>?output_format=mp3_44100_128 with xi-api-key and { text, model_id } -> the stub's 64 bytes as audio/mpeg, chars counted", async () => {
  const rw = stub.stubElevenLabsFetch();
  const p = eleven.makeElevenLabsProvider({ fetch: rw.fetch });
  const r = await p.textToSpeech(env(), { voiceId: "voice_abc123", text: "  i would rather   say this  ", model: "eleven_flash_v2_5" });
  assert.equal(r.mp3.byteLength, 64);
  const bytes = new Uint8Array(r.mp3);
  for (let i = 0; i < 64; i++) assert.equal(bytes[i], (i * 7 + 3) & 0xff, "byte " + i);
  assert.deepEqual(bytes, new Uint8Array(stub.stubElevenMp3()));
  assert.equal(r.model, "eleven_flash_v2_5");
  assert.equal(r.chars, "i would rather say this".length);
  const q = rw.requests[0];
  assert.equal(q.method, "POST");
  assert.equal(q.url, eleven.ELEVENLABS_TTS_URL + "voice_abc123?output_format=" + eleven.ELEVENLABS_TTS_OUTPUT);
  assert.equal(q.headers["xi-api-key"], KEY);
  assert.equal(q.headers["content-type"], "application/json");
  assert.deepEqual(q.body, { text: "i would rather say this", model_id: "eleven_flash_v2_5" });
});

test("textToSpeech: the default model when none is given; empty text is a bad request; a 429 is retryable and redacted", async () => {
  const rw = stub.stubElevenLabsFetch();
  const p = eleven.makeElevenLabsProvider({ fetch: rw.fetch });
  const r = await p.textToSpeech(env(), { voiceId: "voice_abc123", text: "hi", model: "" });
  assert.equal(r.model, eleven.ELEVENLABS_DEFAULT_MODEL);
  assert.equal(rw.requests[0].body.model_id, "eleven_multilingual_v2");
  await assert.rejects(p.textToSpeech(env(), { voiceId: "voice_abc123", text: "   ", model: "" }), (e) => e.kind === "bad_request" && e.status === 400);
  const limited = eleven.makeElevenLabsProvider({ fetch: async () => new Response("slow down " + KEY, { status: 429 }) });
  await assert.rejects(limited.textToSpeech(env(), { voiceId: "voice_abc123", text: "hi", model: "" }), (e) => {
    assert.equal(e.kind, "rate_limit");
    assert.ok(e.retryable);
    noSecret(e.message);
    return true;
  });
});

// ------------------------------------------------------------------ settings, prices, overrides

test("elevenLabsSettingsOf: the spec's defaults when the v4 keys are absent, the stored values when present, clamped", () => {
  const d = eleven.elevenLabsSettingsOf(settings());
  assert.equal(d.model, "eleven_multilingual_v2");
  assert.equal(d.ttsPricePer1kChars, 0.3);
  assert.equal(d.callPricePerMinute, 0.1);
  assert.equal(d.voiceId, "voice_abc123");
  assert.equal(d.agentId, "agent_7101k5");
  const s = eleven.elevenLabsSettingsOf(settings({ elevenLabsModel: " eleven_v3 ", elevenLabsTtsPricePer1kChars: 0.5, elevenLabsCallPricePerMinute: 250 }));
  assert.equal(s.model, "eleven_v3");
  assert.equal(s.ttsPricePer1kChars, 0.5);
  assert.equal(s.callPricePerMinute, 100, "clamped to the setting's range");
  assert.equal(eleven.elevenLabsSettingsOf(settings({ elevenLabsModel: "x".repeat(200) })).model.length, eleven.MAX_MODEL_ID_CHARS);
  assert.ok(eleven.ELEVENLABS_TTS_MODELS.includes(eleven.ELEVENLABS_DEFAULT_MODEL));
  assert.equal(eleven.ELEVENLABS_TTS_PRICE_PER_1K_CHARS, 0.3);
  assert.equal(eleven.ELEVENLABS_CALL_PRICE_PER_MINUTE, 0.1);
});

test("configured: voice needs the key and a voice id; calls need the key and an agent id", () => {
  assert.equal(eleven.elevenLabsVoiceConfigured(env(), settings()), true);
  assert.equal(eleven.elevenLabsVoiceConfigured(env({ ELEVENLABS_API_KEY: "" }), settings()), false);
  assert.equal(eleven.elevenLabsVoiceConfigured(env(), settings({ elevenLabsVoiceId: "" })), false);
  assert.equal(eleven.elevenLabsVoiceConfigured(env(), settings({ elevenLabsVoiceId: "has spaces" })), false);
  assert.equal(eleven.elevenLabsCallConfigured(env(), settings()), true);
  assert.equal(eleven.elevenLabsCallConfigured(env(), settings({ elevenLabsAgentId: "" })), false);
  assert.equal(eleven.elevenLabsCallConfigured(env({ ELEVENLABS_API_KEY: undefined }), settings()), false);
  // voice.ts delegates to the same rule.
  assert.equal(voice.voiceConfigured(env(), settings()), true);
  assert.equal(voice.voiceConfigured(env(), settings({ elevenLabsVoiceId: "" })), false);
});

test("ttsEstimateUsd: 2,000 characters at 0.30 -> 0.60; rounded up to the cent; 0 characters or a 0 price -> 0", () => {
  assert.equal(eleven.ttsEstimateUsd(2000, 0.3), 0.6);
  assert.equal(eleven.ttsEstimateUsd(10, 0.3), 0.01, "a ten-character note is never free");
  assert.equal(eleven.ttsEstimateUsd(0, 0.3), 0);
  assert.equal(eleven.ttsEstimateUsd(500, 0), 0);
  assert.equal(voice.elevenLabsNoteCostMicro(2000, 0.3), 600_000);
  assert.equal(voice.elevenLabsNoteCostMicro(1, 0.3), 300);
});

test("elevenLabsOverrides: the agent's prompt is her instructions, the first message is empty, the voice is hers", () => {
  const o = eleven.elevenLabsOverrides({ instructions: "RULES\n\nSTATE", voiceId: "voice_abc123" });
  assert.deepEqual(o, { agent: { prompt: { prompt: "RULES\n\nSTATE" }, firstMessage: "" }, tts: { voiceId: "voice_abc123" } });
});

test("stub mode: ELEVENLABS_STUB=1 only while ACCESS_AUD is empty; the connect origins are the four the client needs", () => {
  assert.equal(eleven.elevenLabsStubMode(env()), true);
  assert.equal(eleven.elevenLabsStubMode(env({ ACCESS_AUD: "aud" })), false);
  assert.equal(eleven.elevenLabsStubMode(env({ ELEVENLABS_STUB: "0" })), false);
  assert.deepEqual([...eleven.ELEVENLABS_CONNECT_ORIGINS], ["https://api.elevenlabs.io", "wss://api.elevenlabs.io", "wss://livekit.rtc.elevenlabs.io", "https://livekit.rtc.elevenlabs.io"]);
  assert.notEqual(eleven.elevenLabsProviderFor(env()), eleven.elevenLabsProvider, "the stub-backed adapter is its own instance");
  assert.equal(eleven.elevenLabsProviderFor(env({ ELEVENLABS_STUB: undefined })), eleven.elevenLabsProvider);
});

// ------------------------------------------------------------------ calls.ts

test("callSettingsOf on elevenlabs: the per-minute price is elevenLabsCallPricePerMinute, the token prices are zero, the model is the agent id; the OpenAI reading is unchanged", () => {
  const cs = calls.callSettingsOf(settings({ elevenLabsCallPricePerMinute: 0.25 }));
  assert.equal(cs.provider, "elevenlabs");
  assert.equal(cs.pricePerMinute, 0.25);
  assert.deepEqual(cs.prices, { audioInPerMTok: 0, audioOutPerMTok: 0, textInPerMTok: 0, textOutPerMTok: 0 });
  assert.equal(cs.model, "agent_7101k5");
  assert.equal(cs.voice, "voice_abc123");
  const openai = calls.callSettingsOf(settings({ callProvider: "openai" }));
  assert.equal(openai.pricePerMinute, 0.3);
  assert.equal(openai.model, "gpt-realtime");
  assert.deepEqual(openai.prices, { audioInPerMTok: 32, audioOutPerMTok: 64, textInPerMTok: 4, textOutPerMTok: 16 });
  // A tick reads the call row's own provider, whatever the setting says now.
  const byRow = calls.callSettingsOf(settings({ callProvider: "openai" }), "elevenlabs");
  assert.equal(byRow.provider, "elevenlabs");
  assert.equal(byRow.pricePerMinute, 0.1);
});

test("the meter on elevenlabs: usage the page reports prices at nothing, so the cost is the per-minute floor; 90 s at 0.10 -> 0.15", () => {
  const cs = calls.callSettingsOf(settings());
  // meteredMicro rounds the float product up (150000.00000000003 -> 150001), as every
  // provider's floor does; the point here is that the usage adds nothing on top of it.
  const floor90 = calls.meteredMicro(90, 0.1);
  assert.ok(floor90 >= 150_000 && floor90 <= 150_001, String(floor90));
  const withUsage = calls.callCostMicro(90, { audioIn: 100000, audioOut: 50000, textIn: 200000, textOut: 10000 }, cs);
  assert.equal(withUsage, floor90);
  assert.equal(calls.callCostMicro(90, null, cs), floor90);
  assert.equal(calls.callCost({ secondsTotal: 30, settings: settings() }), calls.meteredMicro(30, 0.1));
  const stop = calls.stopReason({ secondsTotal: 30, deltaMicro: 50_000, settings: settings({ callMaxMinutes: 1 }), todayMicro: 0, monthMicro: 0 });
  assert.equal(stop.stop, false);
  assert.deepEqual(calls.stopReason({ secondsTotal: 61, deltaMicro: 0, settings: settings({ callMaxMinutes: 1 }), todayMicro: 0, monthMicro: 0 }), { stop: true, reason: "max_minutes" });
});

test("startCall on elevenlabs: without the key or the agent id -> 503 provider_not_configured detail elevenlabs, before any row is written", async () => {
  const conv = { id: "c_1", status: "active", title: null, mode: "apart", created_at: "2026-09-26T00:00:00.000Z", updated_at: "2026-09-26T00:00:00.000Z" };
  for (const [e, s] of [
    [env({ ELEVENLABS_API_KEY: "" }), settings()],
    [env(), settings({ elevenLabsAgentId: "" })],
  ]) {
    const db = fakeD1((sql) => (/FROM conversations/.test(sql) ? [conv] : []));
    await assert.rejects(calls.startCall(e, db, s, { conversationId: "c_1", actor: "owner" }), (err) => {
      assert.equal(err.status, 503);
      assert.equal(err.code, "provider_not_configured");
      assert.equal(err.detail, "elevenlabs");
      return true;
    });
    assert.ok(!db.log.some((l) => /INSERT INTO calls/.test(l.sql)), "no call row");
  }
  // The reserved answer is gone.
  const db = fakeD1((sql) => (/FROM conversations/.test(sql) ? [conv] : []));
  await assert.rejects(calls.startCall(env({ ELEVENLABS_API_KEY: "" }), db, settings(), { conversationId: "c_1", actor: "owner" }), (err) => err.detail !== "reserved_v3_1");
});

test("startCall on elevenlabs: a price per minute of 0 is refused (402 price_unknown) like every paid provider", async () => {
  const conv = { id: "c_1", status: "active", title: null, mode: "apart", created_at: "2026-09-26T00:00:00.000Z", updated_at: "2026-09-26T00:00:00.000Z" };
  const db = fakeD1((sql) => (/FROM conversations/.test(sql) ? [conv] : []));
  await assert.rejects(calls.startCall(env(), db, settings({ elevenLabsCallPricePerMinute: 0 }), { conversationId: "c_1", actor: "owner" }), (err) => err.status === 402 && err.code === "price_unknown");
});

test("calls.ts as text: the elevenlabs branch mints through providers/elevenlabs, the OpenAI mint and SDP url are untouched, the audit row never carries the credential or the overrides", () => {
  const src = readFileSync(join(ROOT, "src", "calls.ts"), "utf8");
  assert.ok(src.includes('from "./providers/elevenlabs"'));
  assert.ok(src.includes("mintRealtimeSecret(env, { model: cs.model, voice: cs.voice, instructions, transcribeModel: cs.transcribeModel })"), "the OpenAI mint call is as it was");
  assert.ok(src.includes("sdpUrl = REALTIME_SDP_URL;"));
  assert.ok(!src.includes("reserved_v3_1"), "the reserved answer is gone");
  const audit = src.slice(src.indexOf('"call.start"'), src.indexOf('"call.start"') + 200);
  assert.ok(!/clientSecret|credential|overrides|instructions[^M]/.test(audit), audit);
});

// ------------------------------------------------------------------ voice.ts

function voiceDb(spentMicro = 0) {
  return fakeD1((sql) => (/FROM usage_daily/.test(sql) ? [{ s: spentMicro }] : []));
}

function fakeMedia() {
  const puts = [];
  return { puts, async put(key, bytes, opts) { puts.push({ key, bytes, opts }); }, async delete() {} };
}

test("attachVoiceNote on elevenlabs (stub fetch): the 64 bytes land at voice/<id>.mp3, the run row carries the cost, usage_daily gets the note, the audit row carries no key", async () => {
  const db = voiceDb(0);
  const media = fakeMedia();
  const text = "i would rather say this than type it";
  const r = await voice.attachVoiceNote(env({ MEDIA: media }), db, settings({ elevenLabsTtsPricePer1kChars: 0.3 }), { messageId: "m_1", conversationId: "c_1", text, actor: "system" });
  assert.deepEqual(r, { key: "voice/m_1.mp3", bytes: 64 });
  assert.equal(media.puts.length, 1);
  assert.equal(media.puts[0].opts.httpMetadata.contentType, "audio/mpeg");
  assert.deepEqual(new Uint8Array(media.puts[0].bytes), new Uint8Array(stub.stubElevenMp3()));
  const run = db.log.find((l) => /INSERT INTO model_runs/.test(l.sql));
  assert.ok(run, "a run row");
  const expectedMicro = Math.ceil((text.length / 1000) * 0.3 * 1_000_000);
  assert.ok(run.binds.includes(expectedMicro), "cost on the run row: " + JSON.stringify(run.binds));
  assert.ok(run.binds.includes("elevenlabs") && run.binds.includes("eleven_multilingual_v2"));
  const usage = db.log.find((l) => /INSERT INTO usage_daily/.test(l.sql));
  assert.ok(usage, "a usage row");
  assert.ok(usage.binds.includes(expectedMicro));
  const audit = db.log.find((l) => /INSERT INTO audit/.test(l.sql));
  assert.ok(audit);
  noSecret(JSON.stringify(audit.binds));
  noSecret(JSON.stringify(db.log));
});

test("attachVoiceNote on elevenlabs: a price of 0 refuses the note (no call, a failed run price_unknown); a cap already spent refuses it (budget_exceeded); the text message stands", async () => {
  const media = fakeMedia();
  const db0 = voiceDb(0);
  const r0 = await voice.attachVoiceNote(env({ MEDIA: media }), db0, settings({ elevenLabsTtsPricePer1kChars: 0 }), { messageId: "m_1", conversationId: "c_1", text: "hello", actor: "system" });
  assert.equal(r0, null);
  assert.equal(media.puts.length, 0, "nothing stored");
  const failed0 = db0.log.find((l) => /INSERT INTO model_runs/.test(l.sql));
  assert.ok(failed0 && failed0.binds.some((b) => typeof b === "string" && b.startsWith("price_unknown")), JSON.stringify(failed0 && failed0.binds));
  const dbFull = voiceDb(3_000_000);
  const r1 = await voice.attachVoiceNote(env({ MEDIA: media }), dbFull, settings(), { messageId: "m_2", conversationId: "c_1", text: "hello", actor: "system" });
  assert.equal(r1, null);
  assert.equal(media.puts.length, 0);
  const failed1 = dbFull.log.find((l) => /INSERT INTO model_runs/.test(l.sql));
  assert.ok(failed1 && failed1.binds.some((b) => typeof b === "string" && b.startsWith("budget_exceeded")), JSON.stringify(failed1 && failed1.binds));
  assert.ok(!dbFull.log.some((l) => /UPDATE messages/.test(l.sql)), "the message row is untouched");
});

test("assertVoiceBudget: nothing to check on workersai or the stub; the character count is the flattened, capped text", async () => {
  const db = voiceDb(3_000_000);
  const a = await voice.assertVoiceBudget(db, settings({ voiceProvider: "workersai" }), "a  b");
  assert.deepEqual(a, { estimateUsd: 0, chars: 3 });
  const b = await voice.assertVoiceBudget(voiceDb(0), settings(), "x".repeat(5000));
  assert.equal(b.chars, voice.MAX_SPEECH_CHARS);
  assert.equal(b.estimateUsd, 0.75);
  await assert.rejects(voice.assertVoiceBudget(db, settings(), "hello"), (e) => e.status === 402 && e.code === "budget_exceeded");
});

test("the stub and Workers AI paths of synthesize are as they were (the stub mp3, no ElevenLabs call)", async () => {
  const r = await voice.synthesize(env(), settings({ voiceProvider: "stub" }), "hi");
  assert.equal(r.provider, "stub");
  assert.equal(r.chars, undefined);
  assert.equal(voice.ELEVENLABS_TTS_MODEL, "eleven_multilingual_v2");
  await assert.rejects(voice.synthesize(env({ ELEVENLABS_API_KEY: "" }), settings(), "hi"), (e) => e.kind === "config" && e.status === 503);
});

// ------------------------------------------------------------------ the browser side (pure parts)

test("sessionOptions: the token for webrtc, the signed url for websocket, the overrides as given, the self-hosted worklets; nothing else from the start response", () => {
  const start = { call: { id: "call_1" }, provider: "elevenlabs", clientSecret: "tok", transport: "webrtc", agentId: "agent_1", overrides: { agent: { prompt: { prompt: "P" }, firstMessage: "" }, tts: { voiceId: "v" } }, maxSeconds: 1200 };
  const o = page.sessionOptions(start);
  assert.equal(o.conversationToken, "tok");
  assert.equal(o.connectionType, "webrtc");
  assert.equal(o.signedUrl, undefined);
  assert.deepEqual(o.overrides, start.overrides);
  assert.deepEqual(o.workletPaths, page.WORKLET_PATHS);
  assert.ok(!("call" in o) && !("agentId" in o) && !("maxSeconds" in o));
  const ws = page.sessionOptions({ ...start, transport: "websocket", clientSecret: "wss://x" });
  assert.equal(ws.signedUrl, "wss://x");
  assert.equal(ws.connectionType, "websocket");
  assert.equal(ws.conversationToken, undefined);
  for (const p of Object.values(page.WORKLET_PATHS)) assert.ok(existsSync(join(ROOT, "public", p)), p + " exists");
});

test("clientCallbacks: agent messages caption and segment as her, user messages as him; speaking -> talking face, listening -> idle; an agent hangup ends with hangup, an error with peer_closed, a user close with nothing; errors show a code only", () => {
  const got = { captions: [], segments: [], faces: [], ends: [], reasons: [] };
  const cb = {
    caption: (who, text) => got.captions.push([who, text]),
    segment: (who, text) => got.segments.push([who, text]),
    setFace: (k) => got.faces.push(k),
    end: (r) => got.ends.push(r),
    flashReason: (r) => got.reasons.push(r),
  };
  const state = { closed: false, mode: "listening" };
  const c = page.clientCallbacks(cb, state);
  c.onMessage({ message: "  hey  you ", role: "agent", source: "ai" });
  c.onMessage({ message: "hi", source: "user" });
  c.onMessage({ message: "   ", role: "agent" });
  assert.deepEqual(got.captions, [["her", "hey you"], ["him", "hi"]]);
  assert.deepEqual(got.segments, got.captions);
  c.onModeChange({ mode: "speaking" });
  c.onModeChange({ mode: "listening" });
  assert.deepEqual(got.faces, ["talking", "idle"]);
  assert.equal(state.mode, "listening");
  c.onError("Invalid token tok_secret_value", { code: "auth_failed" });
  c.onError("boom");
  assert.deepEqual(got.reasons, ["auth_failed", "provider_error"]);
  c.onDisconnect({ reason: "agent" });
  assert.deepEqual(got.ends, ["hangup"]);
  assert.equal(state.closed, true);
  c.onDisconnect({ reason: "error", message: "x" });
  assert.deepEqual(got.ends, ["hangup"], "a second disconnect does nothing");
  const s2 = { closed: false, mode: "listening" };
  page.clientCallbacks(cb, s2).onDisconnect({ reason: "error", message: "x" });
  assert.deepEqual(got.ends, ["hangup", "peer_closed"]);
  const s3 = { closed: false, mode: "listening" };
  page.clientCallbacks(cb, s3).onDisconnect({ reason: "user" });
  assert.deepEqual(got.ends, ["hangup", "peer_closed"], "the page's own close ends nothing twice");
  assert.equal(page.endReasonFor(null), null);
});

test("connectElevenLabs: exported by the names call.js tries, rejects with no_credential before loading the client when the start carries none", async () => {
  assert.equal(typeof page.connectElevenLabs, "function");
  assert.equal(page.default, page.connectElevenLabs);
  await assert.rejects(page.connectElevenLabs({ start: { provider: "elevenlabs" }, els: {}, callbacks: {} }), (e) => e.code === "no_credential");
});

test("call_elevenlabs.js as text: never logs, never stores the start response, no inline secrets, clean typography", () => {
  const src = readFileSync(join(ROOT, "public", "js", "call_elevenlabs.js"), "utf8");
  assert.ok(!/console\.(log|info|debug|warn|error)/.test(src), "no console output");
  assert.ok(!/localStorage|sessionStorage|indexedDB/.test(src));
  assert.ok(!BAD_TYPOGRAPHY.test(src));
  assert.ok(src.includes('import(VENDOR_PATH)'), "the client loads on demand, same origin");
  assert.ok(!/https?:\/\/(cdn|unpkg|jsdelivr)/.test(src), "no CDN");
});

// ------------------------------------------------------------------ the vendored client

test("public/js/vendor/elevenlabs-client.js: generated from the installed package, an ES module exporting Conversation, no dash or ellipsis characters, no source map comment; the worklets beside it", () => {
  const file = join(ROOT, "public", "js", "vendor", "elevenlabs-client.js");
  assert.ok(existsSync(file), "run npm run vendor:elevenlabs");
  const text = readFileSync(file, "utf8");
  const pkg = JSON.parse(readFileSync(join(ROOT, "node_modules", "@elevenlabs", "client", "package.json"), "utf8"));
  assert.ok(text.startsWith(vendorScript.HEADER_PREFIX + pkg.version + " "), "the header names the installed version");
  assert.ok(/^export const \{ [^}]*\bConversation\b[^}]* \} = ElevenLabsClient;$/m.test(text));
  assert.ok(/^export default ElevenLabsClient;$/m.test(text));
  assert.ok(!BAD_TYPOGRAPHY.test(text));
  assert.ok(!text.includes("sourceMappingURL"));
  assert.ok(text.includes("wss://livekit.rtc.elevenlabs.io"), "the WebRTC host the CSP names");
  assert.ok(text.includes("https://api.elevenlabs.io"));
  const built = vendorScript.buildVendorFiles();
  assert.equal(built.version, pkg.version);
  assert.equal(built.files[vendorScript.CLIENT_FILE], text, "the file on disk is what the script builds");
  for (const w of vendorScript.WORKLET_FILES) {
    const wt = readFileSync(join(ROOT, "public", "js", "vendor", "worklets", w), "utf8");
    assert.equal(built.files["worklets/" + w], wt);
    assert.ok(!BAD_TYPOGRAPHY.test(wt));
    assert.ok(wt.includes("registerProcessor("));
  }
  const rs = readFileSync(join(ROOT, "public", "js", "vendor", "worklets", vendorScript.RESAMPLER_FILE), "utf8");
  const rpkg = JSON.parse(readFileSync(join(ROOT, "node_modules", "@alexanderolsen", "libsamplerate-js", "package.json"), "utf8"));
  assert.equal(built.files["worklets/" + vendorScript.RESAMPLER_FILE], rs, "the resampler on disk is what the script builds");
  assert.ok(rs.startsWith(vendorScript.RESAMPLER_HEADER_PREFIX + rpkg.version + " "), "the resampler header names the installed version");
  assert.equal(vendorScript.resamplerVersionNamed(readFileSync(join(ROOT, "node_modules", "@elevenlabs", "client", "dist", "lib.iife.js"), "utf8")), rpkg.version, "the version the client names is the one vendored");
  assert.ok(rs.includes("Copyright (c) 2021 Alexander Olsen") && rs.includes("Erik de Castro Lopo"), "both licenses ride on top");
  assert.ok(rs.includes("globalThis.LibSampleRate="), "it registers what the client's worklets read");
  assert.ok(!BAD_TYPOGRAPHY.test(rs));
  assert.ok(!/https?:\/\//.test(rs.slice(rs.indexOf("*/"))), "no network address in the code");
  assert.ok(!rs.includes("WebAssembly") && !/\beval\(|new Function\(/.test(rs), "WASM2JS: nothing the CSP would refuse");
  assert.throws(() => vendorScript.resamplerFile("x", "a */ b", "1"), /close its comment/);
  assert.equal(vendorScript.asciiTypography("a " + String.fromCharCode(0x2014) + " b" + String.fromCharCode(0x2026)), "a -- b...");
  assert.deepEqual(vendorScript.exportedNames("exports.B = 1; exports.A = 2; exports.B = 3;"), ["B", "A"]);
  assert.throws(() => vendorScript.wrapIife("var Other = (function(exports){ exports.Conversation = 1; return exports; })({});", "0"), /var ElevenLabsClient/);
});

test("package.json: @elevenlabs/client is the one dependency added, with the vendor scripts", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ["@anthropic-ai/sdk", "@elevenlabs/client"]);
  assert.equal(pkg.scripts["vendor:elevenlabs"], "node scripts/vendor_elevenlabs.mjs");
  assert.equal(pkg.scripts["check:vendor"], "node scripts/vendor_elevenlabs.mjs --check");
  assert.equal(pkg.devDependencies["@alexanderolsen/libsamplerate-js"], "2.1.2", "the resampler pinned to the version the client names");
});

test("the face on the ElevenLabs path (review): faceFor gives talking while she speaks, listening while he does, idle otherwise; the level timer sets it directly, never through call.js's analyser meter", () => {
  assert.equal(page.faceFor("speaking", false), "talking");
  assert.equal(page.faceFor("speaking", true), "talking", "her speaking wins");
  assert.equal(page.faceFor("listening", true), "listening");
  assert.equal(page.faceFor("listening", false), "idle");
  assert.ok(page.HIS_HOLD_MS > 0 && page.HIS_HOLD_MS <= 1500);
  const src = readFileSync(new URL("../../public/js/call_elevenlabs.js", import.meta.url), "utf8");
  assert.ok(!/setHisSpeaking\(/.test(src.replace(/\/\/.*$/gm, "")), "no call into the analyser path");
  const state = { closed: false, mode: "listening", face: "idle" };
  const faces = [];
  const cb = page.clientCallbacks({ setFace: (k) => faces.push(k) }, state);
  cb.onModeChange({ mode: "speaking" });
  assert.equal(state.face, "talking", "the mode change and the level timer share one record");
  assert.deepEqual(faces, ["talking"]);
});

test("sessionOptions (review): the WebSocket transport names the same-origin resampler, never the client's CDN default; WebRTC loads none", () => {
  const ws = page.sessionOptions({ transport: "websocket", clientSecret: "wss://x" });
  assert.equal(ws.libsampleratePath, page.LIBSAMPLERATE_PATH);
  assert.ok(page.LIBSAMPLERATE_PATH.startsWith("/js/vendor/worklets/"), "same origin");
  assert.equal(page.sessionOptions({ transport: "webrtc", clientSecret: "tok" }).libsampleratePath, undefined);
  assert.ok(existsSync(join(ROOT, "public", page.LIBSAMPLERATE_PATH)), page.LIBSAMPLERATE_PATH + " exists (verifier: it answered 404)");
  assert.equal(page.LIBSAMPLERATE_PATH, "/js/vendor/" + vendorScript.WORKLET_DIR + "/" + vendorScript.RESAMPLER_FILE, "the path the page passes is the file the vendor script writes");
});
