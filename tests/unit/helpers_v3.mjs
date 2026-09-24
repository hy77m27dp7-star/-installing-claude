// Fixtures and guards for the v3 unit tests (SPEC_V3). Builds on helpers.mjs and
// helpers_v2.mjs and never changes them. Plain Node 22, no Workers runtime.
//
// The v3 lanes land their modules in parallel, so a module may not be in the tree when a
// test file runs. `loadSrcIfPresent` answers null for a missing file and `guard(mod)` hands
// back `test` or `test.skip` accordingly, so a missing module reads as skipped (visible in
// the output), never as passed. The integrator runs the files once every lane is in.
import { test } from "node:test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadSrc } from "./helpers.mjs";

export async function loadSrcIfPresent(name) {
  const path = fileURLToPath(new URL(`../../src/${name}.ts`, import.meta.url));
  if (!existsSync(path)) return null;
  return loadSrc(name);
}

export async function loadFileIfPresent(relative) {
  const url = new URL(relative, import.meta.url);
  if (!existsSync(fileURLToPath(url))) return null;
  return import(url);
}

// `test` when the module (and, when named, every export) is present; a skipper otherwise.
export function guard(mod, ...exportsNeeded) {
  const missing = !mod ? ["module"] : exportsNeeded.filter((e) => typeof mod[e] === "undefined");
  if (!missing.length) return test;
  const why = !mod ? "module not in this tree yet" : "missing export(s): " + missing.join(", ");
  const skipper = (name, fn) => test.skip(`${name} [skipped: ${why}]`, fn);
  skipper.skip = skipper;
  return skipper;
}

// The first export whose name is in the alias list, with the name it was found under.
export function firstExport(mod, aliases) {
  if (!mod) return { fn: null, name: null };
  for (const a of aliases) if (typeof mod[a] === "function") return { fn: mod[a], name: a };
  return { fn: null, name: null };
}

// ------------------------------------------------------------------ fixed instants

export const T0 = "2026-09-24T00:00:00.000Z";
export const NOW = new Date("2026-09-29T19:10:00Z"); // Tuesday 3:10pm New York
export const DAY_MS = 24 * 60 * 60 * 1000;
export const daysAgo = (n, from = NOW) => new Date(from.getTime() - n * DAY_MS).toISOString();

// ------------------------------------------------------------------ v3 rows

export function voiceLine(overrides = {}) {
  const text = overrides.text ?? "ok sent, do not judge the lighting";
  return {
    id: overrides.id ?? "vl_" + text.replace(/[^a-z0-9]/gi, "").slice(0, 12),
    text,
    text_norm: text.toLowerCase().replace(/\s+/g, " ").trim(),
    tags_json: JSON.stringify(overrides.tags ?? ["photo_send", "dry"]),
    source: null,
    origin: "seed",
    status: "approved",
    uses: 0,
    last_used_at: null,
    created_at: T0,
    updated_at: T0,
    decided_at: T0,
    ...overrides,
  };
}

export function correctionRow(overrides = {}) {
  return {
    id: "cor_test",
    message_id: "m_her",
    conversation_id: "c_test",
    kind: "ai",
    note: null,
    original: "That is a really thoughtful way to put it, and I appreciate you sharing it with me.",
    rewrite: null,
    voice_line_id: null,
    status: "active",
    created_at: T0,
    retired_at: null,
    ...overrides,
  };
}

export function weightRow(overrides = {}) {
  return { entity: "fact", entity_id: "f_test", weight: 0.5, last_touched: T0, touches: 0, source: null, updated_at: T0, ...overrides };
}

export function wantRow(overrides = {}) {
  return {
    id: "w_test",
    title: "finish the bridge",
    why: "the song is stuck at the bridge",
    stakes: "it stays a demo",
    next_step: "sing it through once without stopping",
    progress: 20,
    status: "active",
    horizon_days: 42,
    last_moved: daysAgo(4),
    source: "owner",
    created_at: daysAgo(10),
    updated_at: daysAgo(4),
    ...overrides,
  };
}

export function wantLogRow(overrides = {}) {
  return { id: "wl_test", want_id: "w_test", occurred: daysAgo(4), kind: "progress", delta: 10, note: "got through the first half", source: null, message_id: null, created_at: daysAgo(4), ...overrides };
}

export function askRow(overrides = {}) {
  return {
    id: "ask_test",
    want_id: null,
    text: "send me the song you meant",
    status: "open",
    asked_message_id: "m_her",
    asked_at: daysAgo(4),
    brought_up: 0,
    resolved_at: null,
    resolution_note: null,
    created_at: daysAgo(4),
    ...overrides,
  };
}

export function groundingRow(overrides = {}) {
  return { id: "g_test", kind: "meal", note: "a bagel", occurred: "2026-09-29T13:00:00Z", source: "owner", message_id: null, created_at: "2026-09-29T13:00:00Z", ...overrides };
}

export function weatherNow(overrides = {}) {
  return { temp: 71, feels: 73, units: "fahrenheit", code: 0, words: "clear", isDay: true, windMph: 5, precip: 0, sunrise: "2026-09-29T06:35", sunset: "2026-09-29T19:02", fetchedAt: NOW.toISOString(), ...overrides };
}

export function assetRow(overrides = {}) {
  return {
    id: "img_test",
    file: "candidates/img_test.png",
    role: "scene",
    sha256: "ab".repeat(32),
    bytes: 1000,
    approval_status: "approved",
    conversation_id: "c_test",
    message_id: "m_her",
    prompt: "mirror selfie in a black hoodie, messy bun, lamp light, half smile",
    provider: "stub",
    model: "gpt-image-1",
    notes: null,
    created_at: "2026-09-29T19:00:00Z",
    decided_at: "2026-09-29T19:05:00Z",
    ...overrides,
  };
}

export function tastingRow(overrides = {}) {
  return {
    id: "ts_test",
    conversation_id: "c_test",
    user_message_id: "m_user",
    idempotency_key: "it-key-0001",
    left_side: "A",
    status: "picked",
    a_provider: "anthropic",
    a_model: "claude-opus-5",
    b_provider: "openai",
    b_model: "gpt-4.1",
    pick: "left",
    winner_side: "A",
    cost_usd_micro: 20000,
    created_at: T0,
    decided_at: T0,
    ...overrides,
  };
}

// A v3 settings object: the v2 test settings plus every v3 default the spec ships.
export function settingsV3(overrides = {}) {
  return {
    provider: "stub",
    model: "claude-opus-5",
    effort: "medium",
    temperature: 0.9,
    maxTokens: 700,
    proposalsEnabled: true,
    proposalProvider: "stub",
    proposalModel: "claude-sonnet-5",
    imageProvider: "stub",
    imageModel: "gpt-image-1",
    imageQuality: "medium",
    imageSize: "1024x1536",
    imageCostUsd: 0.06,
    dailyCapUsd: 3,
    monthlyCapUsd: 30,
    contextRecentMessages: 40,
    contextMaxChars: 24000,
    prices: { "claude-opus-5": { inputPerMTok: 5, outputPerMTok: 25 }, "claude-sonnet-5": { inputPerMTok: 2, outputPerMTok: 10 }, "gpt-4.1": { inputPerMTok: 2, outputPerMTok: 8 } },
    replyDelayMode: "instant",
    realDelayMaxMinutes: 6,
    driftCheckEnabled: false,
    timezone: "America/New_York",
    herFirstTextsPerDay: 10,
    herFirstQuietHours: "23:30-08:30",
    voiceProvider: "stub",
    voiceMode: "some",
    elevenLabsVoiceId: "",
    transcribeProvider: "stub",
    exemplarsPerTurn: 6,
    exemplarCooldownTurns: 30,
    correctionsShown: 25,
    correctionRewriteToBank: true,
    memoryDecayEnabled: true,
    memoryFactsMax: 40,
    memoryHalfLifeLowDays: 10,
    memoryHalfLifeMidDays: 45,
    memoryHalfLifeHighDays: 400,
    provisionalRecallEvery: 0,
    wantsShown: 5,
    askLetGoDays: 14,
    moodDaysDefault: 3,
    herCity: "Portland, Maine",
    herLat: 43.6591,
    herLon: -70.2568,
    weatherProvider: "stub",
    weatherUnits: "fahrenheit",
    portraitCostUsd: 0.04,
    portraitSize: "1024x1024",
    callProvider: "stub",
    callModel: "gpt-realtime",
    callVoice: "marin",
    callTranscribeModel: "gpt-4o-mini-transcribe",
    callSystemMode: "compact",
    callMaxMinutes: 20,
    callPricePerMinute: 0.3,
    callPrices: { audioInPerMTok: 32, audioOutPerMTok: 64, textInPerMTok: 4, textOutPerMTok: 16 },
    elevenLabsAgentId: "",
    elevenLabsCallPricePerMinute: 0.1,
    videoProvider: "stub",
    videoModel: "gen4_turbo",
    videoSeconds: 5,
    videoRatio: "720:1280",
    videoCostUsd: 0.25,
    textureCuesEnabled: true,
    typoCueShare: 0,
    tastingEnabled: false,
    tastingProvider: "openai",
    tastingModel: "gpt-4.1",
    tastingDailyCapUsd: 1,
    finetuneMinExamples: 200,
    finetuneSystemMode: "compact",
    texterModel: "",
    texterPrevious: null,
    ...overrides,
  };
}

// The whole SPEC_V3 settings table: key -> [default, one good value, one bad value].
export const V3_SETTINGS_TABLE = {
  exemplarsPerTurn: [6, 12, 13],
  exemplarCooldownTurns: [30, 500, -1],
  correctionsShown: [25, 100, 101],
  correctionRewriteToBank: [true, false, "yes"],
  memoryDecayEnabled: [true, false, 1],
  memoryFactsMax: [40, 5, 4],
  memoryHalfLifeLowDays: [10, 365, 366],
  memoryHalfLifeMidDays: [45, 3650, 0],
  memoryHalfLifeHighDays: [400, 36500, 36501],
  provisionalRecallEvery: [0, 50, 51],
  wantsShown: [5, 20, 21],
  askLetGoDays: [14, 90, 0],
  moodDaysDefault: [3, 14, 15],
  herCity: ["Portland, Maine", "Lisbon", "x".repeat(81)],
  herLat: [43.6591, null, 91],
  herLon: [-70.2568, null, -181],
  weatherProvider: ["openmeteo", "stub", "noaa"],
  weatherUnits: ["fahrenheit", "celsius", "kelvin"],
  portraitCostUsd: [0.04, 1, -1],
  portraitSize: ["1024x1024", "auto", "big"],
  callProvider: ["openai", "stub", "twilio"],
  callModel: ["gpt-realtime", "gpt-realtime-2.1", ""],
  callVoice: ["marin", "cedar", "x".repeat(41)],
  callTranscribeModel: ["gpt-4o-mini-transcribe", "whisper-1", ""],
  callSystemMode: ["compact", "full", "long"],
  callMaxMinutes: [20, 60, 61],
  callPricePerMinute: [0.3, 0, 101],
  callPrices: [{ audioInPerMTok: 32, audioOutPerMTok: 64, textInPerMTok: 4, textOutPerMTok: 16 }, { audioInPerMTok: 0, audioOutPerMTok: 0, textInPerMTok: 0, textOutPerMTok: 0 }, { audioInPerMTok: -1, audioOutPerMTok: 64, textInPerMTok: 4, textOutPerMTok: 16 }],
  elevenLabsAgentId: ["", "agent_123", "x".repeat(121)],
  elevenLabsCallPricePerMinute: [0.1, 100, 101],
  videoProvider: ["runway", "off", "pika"],
  videoModel: ["gen4_turbo", "gen4", ""],
  videoSeconds: [5, 10, 7],
  videoRatio: ["720:1280", "1280:720", "16:9"],
  videoCostUsd: [0.25, 0, 101],
  textureCuesEnabled: [true, false, "on"],
  typoCueShare: [0, 0.3, 0.31],
  tastingEnabled: [false, true, "no"],
  tastingProvider: ["openai", "anthropic", "mistral"],
  tastingModel: ["gpt-4.1", "gpt-5", ""],
  tastingDailyCapUsd: [1, 1000, 1001],
  finetuneMinExamples: [200, 10, 9],
  finetuneSystemMode: ["compact", "full", "medium"],
  texterModel: ["", "ft:gpt-4.1-mini-2025-04-14:org:avelie:abc", "x".repeat(201)],
  texterPrevious: [null, { provider: "anthropic", model: "claude-opus-5" }, { provider: "mistral", model: "x" }],
};
