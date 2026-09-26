// v3.1 "What he looks like" (SPEC_V3 section JJ): the pure rule table (src/hisFace.ts),
// the WHAT HE LOOKS LIKE section (present, absent, with and without the attached-photos
// line, typography clean, byte-identical prompt without the feature), the four settings'
// validation bounds and defaults, the exclusions (outfitNow ignores role him, the
// character export leaves him out, the fine-tune strip drops the section), the stub's
// describe pass and [[HISFACE]] count, and the additive migration.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { loadSrc, promptState, factRow, BAD_TYPOGRAPHY, EM_DASH, ELLIPSIS } from "./helpers.mjs";
import { fakeDb, secretEnv } from "./helpers_v2.mjs";

const hisFace = await loadSrc("hisFace");
const prompt = await loadSrc("prompt");
const vision = await loadSrc("vision");
const { DEFAULT_SETTINGS } = await loadSrc("db");
const { validateSettingsPatch } = await loadSrc("api");
const { outfitNow } = await loadSrc("grounding");
const { exportCharacterJson } = await loadSrc("exportCharacter");
const { stripHimFromState } = await loadSrc("finetune");
const { stubProvider, STUB_LOOK } = await loadSrc("providers/stub");
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const { shouldShowFace, hisLookSection, hisFaceSettings, cleanLookText, mentionsHisLooks, performerCanSee, performersCanSee, isHisFirstTurn, himRefs, mimeOfKey, attachedLine, turnsSinceFaceShown, LOOK_SECTION_HEADER, LOOK_NO_WORDS_LINE, DESCRIBE_SYSTEM, DESCRIBE_PREFIX, HIS_FACE_DEFAULTS, FACE_CADENCE_UNREADABLE } = hisFace;
const { STUB_BLIND_MODEL } = vision;

const S = { hisFaceInTogether: true, hisFaceApartEvery: 8 };
const rule = (over) => shouldShowFace({ mode: "apart", isFirstTurnOfConversation: false, turnsSinceLastShown: 1, userText: "hey", settings: S, canSee: true, ...over });

// ------------------------------------------------------------------ the rule

test("shouldShowFace: never when the performer cannot see, whatever else is true", () => {
  assert.equal(rule({ canSee: false, mode: "together" }), false);
  assert.equal(rule({ canSee: false, isFirstTurnOfConversation: true }), false);
  assert.equal(rule({ canSee: false, userText: "do you like my beard" }), false);
  assert.equal(rule({ canSee: false, turnsSinceLastShown: Infinity }), false);
});

test("shouldShowFace: the first user turn of a conversation, in either mode and with the cadence off", () => {
  assert.equal(rule({ isFirstTurnOfConversation: true }), true);
  assert.equal(rule({ isFirstTurnOfConversation: true, mode: "together", settings: { hisFaceInTogether: false, hisFaceApartEvery: 0 } }), true);
  assert.equal(rule({ isFirstTurnOfConversation: true, settings: { hisFaceInTogether: false, hisFaceApartEvery: 0 } }), true);
});

test("shouldShowFace: together mode follows hisFaceInTogether every turn", () => {
  assert.equal(rule({ mode: "together" }), true);
  assert.equal(rule({ mode: "together", turnsSinceLastShown: 0 }), true);
  assert.equal(rule({ mode: "together", settings: { hisFaceInTogether: false, hisFaceApartEvery: 8 } }), false);
  assert.equal(rule({ mode: "together", settings: { hisFaceInTogether: false, hisFaceApartEvery: 8 }, turnsSinceLastShown: 100 }), false, "the apart cadence never applies to a together turn");
});

test("shouldShowFace: apart mode every hisFaceApartEvery turns; 0 is never; never shown counts as forever ago; an unreadable count as just shown", () => {
  assert.equal(rule({ turnsSinceLastShown: 8 }), true);
  assert.equal(rule({ turnsSinceLastShown: 9 }), true);
  assert.equal(rule({ turnsSinceLastShown: 7 }), false);
  assert.equal(rule({ turnsSinceLastShown: 0 }), false);
  assert.equal(rule({ turnsSinceLastShown: Infinity }), true);
  assert.equal(rule({ turnsSinceLastShown: Infinity, settings: { hisFaceInTogether: true, hisFaceApartEvery: 0 } }), false);
  assert.equal(rule({ turnsSinceLastShown: 1, settings: { hisFaceInTogether: true, hisFaceApartEvery: 1 } }), true);
  // v3.1 fix 2: a count the caller could not read (the column missing before 0007) is the
  // cheap failure, "just shown": the cadence waits, it never fires on every turn.
  assert.equal(FACE_CADENCE_UNREADABLE, 0);
  assert.equal(rule({ turnsSinceLastShown: FACE_CADENCE_UNREADABLE }), false, "the fallback the context uses on a failed read never fires the cadence");
  assert.equal(rule({ turnsSinceLastShown: FACE_CADENCE_UNREADABLE, settings: { hisFaceInTogether: true, hisFaceApartEvery: 1 } }), false, "not even at cadence 1");
  assert.equal(rule({ turnsSinceLastShown: NaN }), false, "an unreadable count reads as just shown, never as never shown");
  assert.equal(rule({ turnsSinceLastShown: undefined }), false);
  assert.equal(rule({ turnsSinceLastShown: "8" }), false);
  // The other three reasons still show on that shape.
  assert.equal(rule({ turnsSinceLastShown: FACE_CADENCE_UNREADABLE, isFirstTurnOfConversation: true }), true);
  assert.equal(rule({ turnsSinceLastShown: FACE_CADENCE_UNREADABLE, mode: "together" }), true);
  assert.equal(rule({ turnsSinceLastShown: FACE_CADENCE_UNREADABLE, userText: "do you like my beard" }), true);
});

// v3.1 fix 2: the D1 read behind the cadence. A row that says null is "never shown"
// (Infinity); a number is her replies after that seq plus this turn; a database without
// the column (before 0007) rejects, and the context's fallback for that is the constant
// above, never Infinity (Infinity on that shape put every photo on every Apart turn).
test("turnsSinceFaceShown: null -> Infinity; a seq -> her replies since plus one; a missing column rejects (the caller then counts it as just shown)", async () => {
  const never = fakeDb({ conversations: [{ id: "c1", his_face_seq: null }], messages: [] });
  assert.equal(await turnsSinceFaceShown(never, "c1"), Infinity);
  const noRow = fakeDb({ conversations: [], messages: [] });
  assert.equal(await turnsSinceFaceShown(noRow, "c1"), Infinity, "no conversation row reads as never shown");
  // The fake evaluates "column = ?N" binds only, so the rows given are the ones the real
  // query would count: her story replies with seq above the marker.
  const shown = fakeDb({ conversations: [{ id: "c1", his_face_seq: 4 }], messages: [{ conversation_id: "c1", role: "assistant", channel: "story", seq: 6 }, { conversation_id: "c1", role: "assistant", channel: "story", seq: 8 }] });
  assert.equal(await turnsSinceFaceShown(shown, "c1"), 3, "two replies since plus this turn");
  const justShown = fakeDb({ conversations: [{ id: "c1", his_face_seq: 4 }], messages: [] });
  assert.equal(await turnsSinceFaceShown(justShown, "c1"), 1, "the turn right after a showing is 1");
  const unmigrated = fakeDb({ conversations: [{ id: "c1" }], messages: [] });
  const prepare = unmigrated.prepare;
  unmigrated.prepare = (sql) => {
    const st = prepare(sql);
    if (/his_face_seq/.test(sql)) st.first = async () => { throw new Error("D1_ERROR: no such column: his_face_seq"); };
    return st;
  };
  await assert.rejects(() => turnsSinceFaceShown(unmigrated, "c1"), /no such column/, "a database before 0007 rejects; assembleContext catches it and counts FACE_CADENCE_UNREADABLE");
  assert.equal(shouldShowFace({ mode: "apart", isFirstTurnOfConversation: false, turnsSinceLastShown: FACE_CADENCE_UNREADABLE, userText: "hey", settings: S, canSee: true }), false);
});

test("shouldShowFace: any mode when he mentions his looks (whole words), and not on look-alike words", () => {
  for (const text of ["do you like my beard", "what do i look like to you", "am i handsome", "ugly day for it", "sent you a selfie", "here is a photo of me", "a picture of me from last year", "pic of me", "my glasses are new", "i feel older today", "You think I look younger?", "it looks like rain", "my hair is a mess", "my face hurts"]) {
    assert.equal(mentionsHisLooks(text), true, text);
    assert.equal(rule({ userText: text }), true, text);
    assert.equal(rule({ userText: text, mode: "together", settings: { hisFaceInTogether: false, hisFaceApartEvery: 0 } }), true, text + " (together, switch off)");
  }
  for (const text of ["the folder is on the desk", "beardless, finally", "handsomely paid", "youngest of three", "hey", "how was your day", "a photo of the harbour", "my faceless friend"]) {
    assert.equal(mentionsHisLooks(text), false, text);
    assert.equal(rule({ userText: text }), false, text);
  }
});

test("shouldShowFace and hisFaceSettings: a missing key reads as its default, an out-of-range one is clamped", () => {
  assert.equal(rule({ settings: {} , turnsSinceLastShown: 8 }), true, "default cadence 8");
  assert.equal(rule({ settings: {}, turnsSinceLastShown: 7 }), false);
  assert.equal(rule({ settings: {}, mode: "together" }), true, "default together on");
  assert.deepEqual(hisFaceSettings(undefined), { hisLookText: "", hisFaceMax: 3, hisFaceInTogether: true, hisFaceApartEvery: 8 });
  assert.deepEqual(hisFaceSettings(null), hisFaceSettings({}));
  assert.equal(hisFaceSettings({ hisFaceMax: 9 }).hisFaceMax, 3);
  assert.equal(hisFaceSettings({ hisFaceMax: 0 }).hisFaceMax, 1);
  assert.equal(hisFaceSettings({ hisFaceApartEvery: 99 }).hisFaceApartEvery, 50);
  assert.equal(hisFaceSettings({ hisFaceApartEvery: -3 }).hisFaceApartEvery, 0);
  assert.equal(hisFaceSettings({ hisFaceInTogether: "yes" }).hisFaceInTogether, true);
  assert.equal(hisFaceSettings({ hisLookText: 42 }).hisLookText, "");
  assert.deepEqual(HIS_FACE_DEFAULTS, { hisLookText: "", hisFaceMax: 3, hisFaceInTogether: true, hisFaceApartEvery: 8 });
});

test("performerCanSee: the chat models see, the stub pretends to (except the blind stub model), a Workers AI model only when its id says vision", () => {
  assert.equal(performerCanSee("anthropic", "claude-opus-5-5"), true);
  assert.equal(performerCanSee("openai", "gpt-4.1"), true);
  assert.equal(performerCanSee("stub", "anything"), true);
  assert.equal(performerCanSee("stub", "stub-b"), true);
  assert.equal(STUB_BLIND_MODEL, "stub-blind");
  assert.equal(performerCanSee("stub", STUB_BLIND_MODEL), false);
  assert.equal(performerCanSee("workersai", "@cf/meta/llama-3.3-70b-instruct-fp8-fast"), false);
  assert.equal(performerCanSee("workersai", "@cf/meta/llama-3.2-11b-vision-instruct"), true);
  assert.equal(performerCanSee("nope", "x"), false);
});

// v3.1 fix 1 (e): a tasting turn names two performers and both read one system text and one
// message list, so the photos ride for both or for neither.
test("performersCanSee: every performer on the call must see; a text-only side B blinds the turn; an empty list sees nothing", () => {
  const live = { provider: "anthropic", model: "claude-opus-5-5" };
  assert.equal(performersCanSee([live]), true);
  assert.equal(performersCanSee([live, { provider: "openai", model: "gpt-4.1" }]), true);
  assert.equal(performersCanSee([live, { provider: "workersai", model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" }]), false, "side B cannot see");
  assert.equal(performersCanSee([{ provider: "workersai", model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" }, live]), false, "the live one cannot see");
  assert.equal(performersCanSee([live, { provider: "workersai", model: "@cf/meta/llama-3.2-11b-vision-instruct" }]), true, "a vision side B sees");
  assert.equal(performersCanSee([{ provider: "stub", model: "stub" }, { provider: "stub", model: STUB_BLIND_MODEL }]), false);
  assert.equal(performersCanSee([{ provider: "stub", model: "stub" }, { provider: "stub", model: "stub-b" }]), true);
  assert.equal(performersCanSee([]), false);
  assert.equal(shouldShowFace({ mode: "together", isFirstTurnOfConversation: true, turnsSinceLastShown: Infinity, userText: "my beard", settings: S, canSee: performersCanSee([live, { provider: "workersai", model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" }]) }), false, "the rule reads it as cannot see");
});

// v3.1 fix 1 (d): his first turn is the first row of HIS, not the first row of the
// conversation: her opener (POST /open) and her first texts come before it.
test("isHisFirstTurn: no rows, only her rows, or only his pending row -> true; any earlier row of his -> false", () => {
  assert.equal(isHisFirstTurn([], null), true, "an empty conversation");
  assert.equal(isHisFirstTurn([{ id: "m_open", role: "assistant" }], null), true, "her opener only");
  assert.equal(isHisFirstTurn([{ id: "m_t1", role: "assistant" }, { id: "m_t2", role: "assistant" }], null), true, "two first texts of hers, unanswered");
  assert.equal(isHisFirstTurn([{ id: "m_pending", role: "user" }], "m_pending"), true, "his own pending row on an idempotent resume");
  assert.equal(isHisFirstTurn([{ id: "m_open", role: "assistant" }, { id: "m_pending", role: "user" }], "m_pending"), true, "her opener, then his pending row");
  assert.equal(isHisFirstTurn([{ id: "m_his", role: "user" }], null), false, "one earlier row of his");
  assert.equal(isHisFirstTurn([{ id: "m_his", role: "user" }, { id: "m_hers", role: "assistant" }], null), false);
  assert.equal(isHisFirstTurn([{ id: "m_open", role: "assistant" }, { id: "m_his", role: "user" }, { id: "m_hers", role: "assistant" }, { id: "m_pending", role: "user" }], "m_pending"), false, "his reply to her opener was answered; this is his second");
  assert.equal(isHisFirstTurn([{ id: "m_his", role: "user" }], "m_other"), false, "a stored row of his that is not the pending one");
});

test("himRefs and mimeOfKey: only him/ keys become refs, the mime from the extension", () => {
  const refs = himRefs([{ key: "him/him_1.jpg" }, { key: "inbox/in_1/0.png" }, { key: "him/him_2.png", mime: "" }, { key: "him/him_3.webp" }, null, { key: "" }]);
  assert.deepEqual(refs, [{ key: "him/him_1.jpg", mime: "image/jpeg" }, { key: "him/him_2.png", mime: "image/png" }, { key: "him/him_3.webp", mime: "image/webp" }]);
  assert.equal(mimeOfKey("him/x.JPG"), "image/jpeg");
  assert.equal(mimeOfKey("him/x.bin"), "image/jpeg");
  assert.equal(vision.isHimRef("him/x.jpg"), true);
  assert.equal(vision.isHimRef({ key: "inbox/a/0.jpg" }), false);
});

// ------------------------------------------------------------------ the section

const photos2 = [{ id: "him_1", key: "him/him_1.jpg", mime: "image/jpeg" }, { id: "him_2", key: "him/him_2.png", mime: "image/png" }];

test("hisLookSection: absent with no words and no photo; the no-words line with a photo only; the words when on file", () => {
  assert.equal(hisLookSection(null), "");
  assert.equal(hisLookSection(undefined), "");
  assert.equal(hisLookSection({ text: "", photos: [], attached: 0 }), "");
  assert.equal(hisLookSection({ text: "   ", photos: [], attached: 0 }), "");
  const photoOnly = hisLookSection({ text: "", photos: photos2, attached: 0 });
  assert.equal(photoOnly, LOOK_SECTION_HEADER + "\n" + LOOK_NO_WORDS_LINE);
  const words = hisLookSection({ text: "short dark hair, a close beard, dark eyes, no glasses", photos: [], attached: 0 });
  assert.equal(words, LOOK_SECTION_HEADER + "\nshort dark hair, a close beard, dark eyes, no glasses");
  assert.ok(LOOK_SECTION_HEADER.startsWith("WHAT HE LOOKS LIKE (his face; you know it the way you know any face you have looked at, without narrating it)"));
  assert.ok(!words.includes("attached to his message"), "no attached line when nothing rode along");
});

test("hisLookSection: the attached-photos line, singular and plural, only when photos ride along", () => {
  const one = hisLookSection({ text: "a beard", photos: photos2, attached: 1 });
  assert.ok(one.endsWith(attachedLine(1)));
  assert.ok(one.includes("The first picture attached to his message is your reference photo of him, on file; it is not something he just sent."));
  assert.ok(one.includes("Never mention it, never thank him for it, never ask why he sent a picture of himself."));
  const two = hisLookSection({ text: "a beard", photos: photos2, attached: 2 });
  assert.ok(two.includes("The first 2 pictures attached to his message are your reference photos of him, on file; they are not something he just sent. Never mention them, never thank him for them, never ask why he sent a picture of himself."));
  assert.ok(!hisLookSection({ text: "a beard", photos: photos2, attached: 0 }).includes("attached to his message"));
  for (const s of [one, two]) assert.ok(!BAD_TYPOGRAPHY.test(s));
});

test("cleanLookText: house typography, single spaces, trimmed; the validator's bounds", () => {
  assert.equal(cleanLookText("  tall " + EM_DASH + " thin " + ELLIPSIS + "  glasses  "), "tall -- thin ... glasses");
  assert.equal(cleanLookText("a\n\n  b"), "a\nb");
  assert.equal(cleanLookText(null), "");
  assert.ok(!BAD_TYPOGRAPHY.test(hisLookSection({ text: "grey " + EM_DASH + " at the temples", photos: [], attached: 0 })));
});

test("stateSections: WHAT HE LOOKS LIKE sits right after WHAT YOU KNOW ABOUT HIM and before SHARED HISTORY; without it the bytes are unchanged", () => {
  const withLook = prompt.stateSections(promptState({
    justinFacts: [factRow({ id: "fj", scope: "justin", fact: "his dog is called biscuit" })],
    hisLook: { text: "short dark hair, a close beard", photos: photos2, attached: 2 },
  }));
  const him = withLook.indexOf("WHAT YOU KNOW ABOUT HIM");
  const look = withLook.indexOf("WHAT HE LOOKS LIKE");
  const shared = withLook.indexOf("SHARED HISTORY");
  assert.ok(him >= 0 && look > him && shared > look, `${him} ${look} ${shared}`);
  assert.ok(withLook.includes("short dark hair, a close beard"));
  assert.ok(withLook.includes("The first 2 pictures attached to his message"));
  assert.ok(!BAD_TYPOGRAPHY.test(withLook));
  const base = prompt.stateSections(promptState());
  assert.equal(prompt.stateSections(promptState({ hisLook: null })), base);
  assert.equal(prompt.stateSections(promptState({ hisLook: { text: "", photos: [], attached: 0 } })), base, "no words and no photo: the exact same prompt bytes");
  assert.ok(!base.includes("WHAT HE LOOKS LIKE"));
  assert.match(prompt.PROMPT_VERSION, /-p7$/);
});

// ------------------------------------------------------------------ settings

test("validateSettingsPatch: the four v3.1 keys, their defaults, bounds and the words' typography", () => {
  assert.deepEqual(validateSettingsPatch({ hisFaceMax: 3, hisFaceInTogether: true, hisFaceApartEvery: 8, hisLookText: "" }), { hisFaceMax: 3, hisFaceInTogether: true, hisFaceApartEvery: 8, hisLookText: "" });
  assert.equal(validateSettingsPatch({ hisFaceMax: 1 }).hisFaceMax, 1);
  assert.equal(validateSettingsPatch({ hisFaceApartEvery: 0 }).hisFaceApartEvery, 0);
  assert.equal(validateSettingsPatch({ hisFaceApartEvery: 50 }).hisFaceApartEvery, 50);
  assert.equal(validateSettingsPatch({ hisFaceInTogether: false }).hisFaceInTogether, false);
  assert.equal(validateSettingsPatch({ hisLookText: " grey " + EM_DASH + " at the temples " }).hisLookText, "grey -- at the temples");
  assert.equal(validateSettingsPatch({ hisLookText: "x".repeat(600) }).hisLookText.length, 600);
  const rejects = (patch) => assert.throws(() => validateSettingsPatch(patch), (e) => e && e.status === 400 && e.code === "validation", JSON.stringify(patch));
  rejects({ hisFaceMax: 4 });
  rejects({ hisFaceMax: 0 });
  rejects({ hisFaceMax: 2.5 });
  rejects({ hisFaceApartEvery: 51 });
  rejects({ hisFaceApartEvery: -1 });
  rejects({ hisFaceInTogether: "yes" });
  rejects({ hisLookText: "x".repeat(601) });
  rejects({ hisLookText: 12 });
  for (const k of ["hisLookText", "hisFaceMax", "hisFaceInTogether", "hisFaceApartEvery"]) assert.ok(k in DEFAULT_SETTINGS, k + " in DEFAULT_SETTINGS");
  assert.equal(DEFAULT_SETTINGS.hisLookText, "");
  assert.equal(DEFAULT_SETTINGS.hisFaceMax, 3);
  assert.equal(DEFAULT_SETTINGS.hisFaceInTogether, true);
  assert.equal(DEFAULT_SETTINGS.hisFaceApartEvery, 8);
  const seed = JSON.parse(readFileSync(join(ROOT, "canon/seed/settings.json"), "utf8"));
  for (const k of ["hisLookText", "hisFaceMax", "hisFaceInTogether", "hisFaceApartEvery"]) assert.deepEqual(seed[k], DEFAULT_SETTINGS[k], "seed " + k);
});

// ------------------------------------------------------------------ exclusions

const D = "2026-09-29T18:00:00.000Z";
const NOW = new Date("2026-09-29T19:10:00Z");
const himRow = (over = {}) => ({
  id: "him_1", file: "him/him_1.jpg", role: "him", sha256: "beef", bytes: 10, approval_status: "approved", conversation_id: null, message_id: null,
  prompt: null, provider: null, model: null, notes: "him", created_at: D, decided_at: D, ...over,
});

test("outfitNow ignores a role him row even when it carries everything a scene photo would", () => {
  const dressed = himRow({ message_id: "m1", prompt: "black hoodie, jeans" });
  assert.equal(outfitNow([dressed], [], NOW, "America/New_York"), null);
  const scene = { ...dressed, id: "img_s", role: "scene", file: "candidates/img_s.png" };
  const out = outfitNow([dressed, scene], [], NOW, "America/New_York");
  assert.ok(out && out.assetId === "img_s", "the scene photo, never the photo of him");
});

test("exportCharacterJson leaves his photos out: no role him image, no him/ key anywhere", async () => {
  const tables = {
    facts: [factRow({ id: "f_fixed", scope: "fixed", subject: "age", fact: "She is 22." })],
    history: [], unknowns: [], life_threads: [], life_log: [], media_library: [],
    state_versions: [],
    visual_assets: [
      { id: "img1", file: "candidates/img1.png", role: "scene", sha256: "abcd", bytes: 10, approval_status: "approved", conversation_id: "c1", message_id: "m1", prompt: "couch, hoodie", provider: "stub", model: "x", notes: null, created_at: D, decided_at: D },
      himRow(),
      himRow({ id: "him_2", file: "him/him_2.png", sha256: "cafe" }),
    ],
    settings: [],
  };
  const pkg = await exportCharacterJson(fakeDb(tables), secretEnv());
  assert.ok(pkg.images.some((i) => i.id === "img1"), "the scene photo is in the package");
  assert.ok(!pkg.images.some((i) => i.role === "him"), "no role him image");
  const text = JSON.stringify(pkg);
  assert.ok(!text.includes("him/"), "no him/ storage key");
  assert.ok(!text.includes("beef") && !text.includes("cafe"), "no hash of his photos");
});

test("stripHimFromState drops WHAT HE LOOKS LIKE with the other two sections about him, and nothing else", () => {
  const SEP = "\n\n" + "-".repeat(60) + "\n\n";
  const state = [
    "FIXED CANON (unchangeable)\n- name: Her name is Avelie, pronounced Av-el-lee.",
    "WHAT YOU KNOW ABOUT HIM (only what he told you in conversation; nothing else exists)\n- his dog is called biscuit",
    hisLookSection({ text: "short dark hair, a close beard", photos: photos2, attached: 1 }),
    "SHARED HISTORY (only what actually happened between you two; add nothing)\n### the first talk\nthey talked",
    "CURRENT STATE\nRelationship: " + JSON.stringify({ status: "talking", his_name: "Justin", summary: "x" }) + "\nScene: {}",
    "MODE: apart\nYou are texting from wherever your day has you.",
  ].join(SEP);
  const out = stripHimFromState(state);
  assert.ok(!out.includes("WHAT HE LOOKS LIKE"));
  assert.ok(!out.includes("a close beard"));
  assert.ok(!out.includes("attached to his message"));
  assert.ok(!out.includes("WHAT YOU KNOW ABOUT HIM"));
  assert.ok(out.includes("FIXED CANON (unchangeable)\n- name: Her name is Avelie, pronounced Av-el-lee."));
  assert.ok(out.includes("SHARED HISTORY (only what actually happened between you two; add nothing)\n### the first talk\nthey talked"));
  assert.ok(out.includes("MODE: apart\nYou are texting from wherever your day has you."));
  assert.ok(!out.includes("Justin"));
});

test("withoutImages: only his reference photos attached is plain text, no 'could not open' line; his own photo still gets it", () => {
  const onlyRefs = vision.withoutImages({ role: "user", content: "hey", images: [{ key: "him/him_1.jpg", mime: "image/jpeg" }] });
  assert.equal(onlyRefs.content, "hey");
  assert.equal("images" in onlyRefs, false);
  const own = vision.withoutImages({ role: "user", content: "hey", images: [{ key: "him/him_1.jpg", mime: "image/jpeg" }, { key: "inbox/in_1/0.png", mime: "image/png" }] });
  assert.ok(own.content.includes(vision.UNSEEN_PHOTO_LINE));
});

// ------------------------------------------------------------------ the stub

test("stub: the describe pass answers a fixed description; [[HISFACE]] reports how many him/ refs the call carried; his own photo still reads as received", async () => {
  assert.ok(DESCRIBE_SYSTEM.startsWith(DESCRIBE_PREFIX));
  const described = await stubProvider.generate({}, { system: DESCRIBE_SYSTEM, messages: [{ role: "user", content: "describe", images: [{ key: "him/x.jpg", mime: "image/jpeg" }] }], model: "stub", maxTokens: 300, temperature: 0.2, effort: "low", cacheable: false });
  assert.equal(described.text, STUB_LOOK);
  assert.ok(!BAD_TYPOGRAPHY.test(STUB_LOOK));
  const base = { system: "story", model: "stub", maxTokens: 700, temperature: 0.9, effort: "medium", cacheable: true };
  const two = await stubProvider.generate({}, { ...base, messages: [{ role: "user", content: "[[HISFACE]] hey", images: [{ key: "him/a.jpg", mime: "image/jpeg" }, { key: "him/b.png", mime: "image/png" }] }] });
  assert.equal(two.text, "i know your face. 2 on file");
  const none = await stubProvider.generate({}, { ...base, messages: [{ role: "user", content: "[[HISFACE]] hey" }] });
  assert.equal(none.text, "i know your face. 0 on file");
  const refsOnly = await stubProvider.generate({}, { ...base, messages: [{ role: "user", content: "hey there", images: [{ key: "him/a.jpg", mime: "image/jpeg" }] }] });
  assert.ok(!refsOnly.text.includes("(photo received)"), "a reference photo of him is not a photo he sent: " + refsOnly.text);
  const own = await stubProvider.generate({}, { ...base, messages: [{ role: "user", content: "hey there", images: [{ key: "him/a.jpg", mime: "image/jpeg" }, { key: "inbox/in_1/0.png", mime: "image/png" }] }] });
  assert.ok(own.text.includes("(photo received)"));
  // v3.1 fix 1: the blind stub model opens nothing: [[HISFACE]] answers 0 and his own photo
  // never reads as received, the way a text-only Workers AI model behaves.
  const blind = await stubProvider.generate({}, { ...base, model: STUB_BLIND_MODEL, messages: [{ role: "user", content: "[[HISFACE]] hey", images: [{ key: "him/a.jpg", mime: "image/jpeg" }, { key: "him/b.png", mime: "image/png" }] }] });
  assert.equal(blind.text, "i know your face. 0 on file");
  assert.equal(blind.model, STUB_BLIND_MODEL);
  const blindOwn = await stubProvider.generate({}, { ...base, model: STUB_BLIND_MODEL, messages: [{ role: "user", content: "hey there", images: [{ key: "inbox/in_1/0.png", mime: "image/png" }] }] });
  assert.ok(!blindOwn.text.includes("(photo received)"), blindOwn.text);
});

// v3.1 fix 2: the wiring itself. The context's fallback for a failed cadence read is the
// constant (just shown), never Infinity; the integration suite proves the behaviour on a
// database whose column was dropped, this guards the line.
test("context.ts counts a failed cadence read as FACE_CADENCE_UNREADABLE, never as never shown", () => {
  const src = readFileSync(join(ROOT, "src", "context.ts"), "utf8");
  const line = src.split("\n").find((l) => l.includes('nicety("his face cadence"'));
  assert.ok(line, "the cadence read is a nicety");
  assert.ok(line.includes("FACE_CADENCE_UNREADABLE"), line);
  assert.ok(!line.includes("POSITIVE_INFINITY") && !line.includes("Infinity"), line);
});

// ------------------------------------------------------------------ the migration

test("migration 0007_his_face.sql adds conversations.his_face_seq, nullable, and nothing destructive", () => {
  const path = join(ROOT, "migrations", "0007_his_face.sql");
  assert.ok(existsSync(path));
  const sql = readFileSync(path, "utf8");
  const body = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert.match(body, /ALTER TABLE\s+conversations\s+ADD COLUMN\s+his_face_seq\s+INTEGER\s*;/i);
  assert.ok(!/NOT NULL/i.test(body));
  assert.ok(!/^\s*(UPDATE|DELETE|DROP|TRUNCATE)\b/im.test(body));
  assert.ok(!BAD_TYPOGRAPHY.test(sql));
});
