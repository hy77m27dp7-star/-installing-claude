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

const { shouldShowFace, hisLookSection, hisFaceSettings, cleanLookText, mentionsHisLooks, performerCanSee, himRefs, mimeOfKey, attachedLine, LOOK_SECTION_HEADER, LOOK_NO_WORDS_LINE, DESCRIBE_SYSTEM, DESCRIBE_PREFIX, HIS_FACE_DEFAULTS } = hisFace;

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

test("shouldShowFace: apart mode every hisFaceApartEvery turns; 0 is never; never shown counts as forever ago", () => {
  assert.equal(rule({ turnsSinceLastShown: 8 }), true);
  assert.equal(rule({ turnsSinceLastShown: 9 }), true);
  assert.equal(rule({ turnsSinceLastShown: 7 }), false);
  assert.equal(rule({ turnsSinceLastShown: 0 }), false);
  assert.equal(rule({ turnsSinceLastShown: Infinity }), true);
  assert.equal(rule({ turnsSinceLastShown: Infinity, settings: { hisFaceInTogether: true, hisFaceApartEvery: 0 } }), false);
  assert.equal(rule({ turnsSinceLastShown: 1, settings: { hisFaceInTogether: true, hisFaceApartEvery: 1 } }), true);
  assert.equal(rule({ turnsSinceLastShown: NaN }), true, "an unreadable count reads as never shown");
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

test("performerCanSee: the chat models see, the stub pretends to, a Workers AI model only when its id says vision", () => {
  assert.equal(performerCanSee("anthropic", "claude-opus-5-5"), true);
  assert.equal(performerCanSee("openai", "gpt-4.1"), true);
  assert.equal(performerCanSee("stub", "anything"), true);
  assert.equal(performerCanSee("workersai", "@cf/meta/llama-3.3-70b-instruct-fp8-fast"), false);
  assert.equal(performerCanSee("workersai", "@cf/meta/llama-3.2-11b-vision-instruct"), true);
  assert.equal(performerCanSee("nope", "x"), false);
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
  assert.match(prompt.PROMPT_VERSION, /-p6$/);
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
