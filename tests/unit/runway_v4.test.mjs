// Him in the picture, the provider half (SPEC_V4 section 3): the Runway prompt with him
// stays under 1000 units with a 400-character scene, names @him once, keeps the figure
// clause about her only; the request body carries three references tagged avelie,
// avelie_2, him in that order (proven through makeRunwayImageProvider with a recording
// fetch); the OpenAI fallback's form carries four image[] parts with him.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSrc, BAD_TYPOGRAPHY } from "./helpers.mjs";
import { secretEnv } from "./helpers_v2.mjs";

const runway = await loadSrc("providers/runway");
const stub = await loadSrc("providers/stub");
const openai = await loadSrc("providers/openai");
const { runwayImagePrompt, imageRequestBody, makeRunwayImageProvider, RUNWAY_HIM_TAG, MAX_IMAGE_REFERENCES, RUNWAY_REFERENCE_TAGS, MAX_PROMPT_UNITS } = runway;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
const bytes = () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength);
const LOOK = "The first things you notice are his very long black hair, straight to wavy, falling well past his shoulders, and gold-framed aviator sunglasses with dark lenses. A full dark beard with grey at the chin, a high forehead, light-to-olive skin. Forties, a solid, broad-shouldered build.";
const SCENE_400 = "selfie of the two of us on the harbour bench at dusk, my head on your shoulder, the ferry lights behind us, a black slip dress under a denim jacket, hair down and a little wind in it, half smile, phone held out at arm's length, the water dark blue going purple, the string lights on the pier just switched on, a paper cup on the bench next to us, the kind of quiet that happens right before it gets cold enough to leave.";

function req(him) {
  return {
    prompt: SCENE_400,
    identityPrompt: "x",
    references: [{ name: "05_dress.png", bytes: bytes() }, { name: "00_face.png", bytes: bytes() }, { name: "04_blazer.png", bytes: bytes() }],
    model: "gen4_image",
    quality: "medium",
    size: "1024x1536",
    him,
  };
}

test("the constants: the him tag is three characters and matches the tag rule, three references at most", () => {
  assert.equal(RUNWAY_HIM_TAG, "him");
  assert.equal(MAX_IMAGE_REFERENCES, 3);
  assert.equal(MAX_PROMPT_UNITS, 1000);
  assert.deepEqual([...RUNWAY_REFERENCE_TAGS], ["avelie", "avelie_2", "avelie_3"]);
  assert.match(RUNWAY_HIM_TAG, /^[a-z][a-z0-9_]{2,15}$/);
});

test("runwayImagePrompt with him: under 1000 units with a 400-character scene, @him named once, the scene kept, the figure clause about her only", () => {
  assert.ok(SCENE_400.length >= 400, String(SCENE_400.length));
  const p = runwayImagePrompt(SCENE_400, ["avelie", "avelie_2"], { tag: "him", look: LOOK });
  assert.ok(p.length <= 1000, String(p.length));
  assert.equal((p.match(/@him\b/g) ?? []).length, 1, "@him is named once: " + p);
  assert.ok(/@him is the man in the him reference/.test(p), p);
  assert.ok(/He is in this picture with @avelie exactly as the scene says/.test(p), p);
  assert.ok(p.startsWith("@avelie is the woman in every reference image (@avelie_2 is the same person as @avelie)"), p.slice(0, 120));
  const figure = p.slice(p.indexOf(" Her figure here as "));
  assert.ok(/@avelie and @avelie_2 show it/.test(figure), figure);
  assert.ok(!/@him/.test(figure), "the figure clause never names him");
  assert.ok(/Scene: selfie of the two of us on the harbour bench/.test(p), "the scene rides after his line");
  assert.ok(!/\bhis (?:shoulders|chest)\b/.test(p.replace(/Scene:[\s\S]*Her figure/, "")), "no body-part words in the identity or his line");
  assert.ok(!BAD_TYPOGRAPHY.test(p));
  const without = runwayImagePrompt(SCENE_400, ["avelie", "avelie_2", "avelie_3"]);
  assert.ok(!/@him/.test(without) && without.length <= 1000);
});

test("runwayImagePrompt with him and a long scene: the scene keeps its words and the look is cut before the scene is", () => {
  const long = SCENE_400 + " " + "and the wind kept lifting my hair into the picture so we took it twice".repeat(6);
  const p = runwayImagePrompt(long, ["avelie", "avelie_2"], { tag: "him", look: LOOK });
  assert.ok(p.length <= 1000, String(p.length));
  assert.ok(/@him is the man in the him reference\. He is in this picture/.test(p) || /@him is the man in the him reference: /.test(p), "his line stays, with or without the look");
  assert.ok(/Scene: selfie of the two of us/.test(p));
  const stray = runwayImagePrompt("us at the counter", ["avelie", "avelie_2"], { tag: "him", look: "a man @avelie_2 would know" });
  assert.equal((stray.match(/@avelie_2/g) ?? []).length, 2, "a stray @ in the words is removed (the identity line and the figure clause name @avelie_2, his words do not): " + stray);
  assert.ok(/reference: a man avelie_2 would know\./.test(stray), stray);
});

test("imageRequestBody with him: three references tagged avelie, avelie_2, him in that order; without him the ordinary three", () => {
  const body = imageRequestBody(req({ name: "him_1.png", bytes: bytes(), look: LOOK }));
  assert.deepEqual(body.referenceImages.map((r) => r.tag), ["avelie", "avelie_2", "him"]);
  assert.equal(body.referenceImages.length, MAX_IMAGE_REFERENCES);
  for (const r of body.referenceImages) assert.ok(r.uri.startsWith("data:image/png;base64,"));
  assert.ok(/@him/.test(body.promptText));
  assert.equal(body.ratio, "1080:1440");
  const plain = imageRequestBody(req(null));
  assert.deepEqual(plain.referenceImages.map((r) => r.tag), ["avelie", "avelie_2", "avelie_3"]);
  assert.ok(!/@him/.test(plain.promptText));
  const emptyHim = imageRequestBody(req({ name: "him.png", bytes: new ArrayBuffer(0), look: "" }));
  assert.deepEqual(emptyHim.referenceImages.map((r) => r.tag), ["avelie", "avelie_2", "avelie_3"], "an empty photo of him is no photo");
});

test("makeRunwayImageProvider with a recording fetch: the POST /v1/text_to_image body carries the three tagged references and the prompt with him; the picture comes back", async () => {
  const fake = stub.stubRunwayFetch({ runningPolls: 1 });
  const provider = makeRunwayImageProvider({ fetch: fake.fetch, sleep: async () => {}, now: () => 0 });
  const env = { ...secretEnv(), RUNWAY_API_KEY: "rw-SECRET-key-0009" };
  const out = await provider.generate(env, req({ name: "him_1.png", bytes: bytes(), look: LOOK }));
  assert.equal(out.provider, "runway");
  assert.ok(out.png.byteLength > 0);
  const start = fake.requests.find((r) => r.method === "POST" && /\/v1\/text_to_image$/.test(r.url));
  assert.ok(start, "the start request");
  assert.equal(start.headers.authorization, "Bearer rw-SECRET-key-0009");
  assert.deepEqual(start.body.referenceImages.map((r) => r.tag), ["avelie", "avelie_2", "him"]);
  assert.equal(start.body.model, "gen4_image");
  assert.ok(/@him is the man in the him reference/.test(start.body.promptText));
  assert.ok(start.body.promptText.length <= 1000);
});

test("the OpenAI fallback: the images/edits form carries four image[] parts with him (hers then his) and names him in the prompt", async () => {
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), body: init.body });
    return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(PNG).toString("base64") }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const env = { ...secretEnv(), OPENAI_API_KEY: "sk-SECRET-openai-0002" };
    const out = await openai.openaiImageProvider.generate(env, req({ name: "him_1.png", bytes: bytes(), look: LOOK }));
    assert.equal(out.provider, "openai");
    assert.equal(seen.length, 1);
    assert.ok(/images\/edits/.test(seen[0].url), seen[0].url);
    const fd = seen[0].body;
    assert.ok(fd instanceof FormData, "a multipart form");
    const parts = fd.getAll("image[]");
    assert.equal(parts.length, 4, "three of hers plus him");
    assert.equal(parts[3].name, "him_1.png", "his rides last");
    const prompt = fd.get("prompt");
    assert.ok(/The last reference image is the man who is in the picture with her/.test(prompt), prompt.slice(-200));
    assert.ok(prompt.includes("very long black hair"), "the words about him");
    assert.equal(fd.get("input_fidelity"), "high");
    const plainSeen = seen.length;
    await openai.openaiImageProvider.generate(env, req(null));
    assert.equal(seen[plainSeen].body.getAll("image[]").length, 3, "without him: the ordinary three");
    assert.ok(!/man who is in the picture/.test(seen[plainSeen].body.get("prompt")));
  } finally {
    globalThis.fetch = realFetch;
  }
});
