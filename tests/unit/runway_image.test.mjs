// Runway as the photo provider (2026-09-25): the request shaping (references tagged, the
// prompt opening with @avelie and carrying no body-part words, the ratio from the size),
// the poll, the error mapping and the registry wiring, all driven through the Runway
// stand-in in providers/stub.ts. No key, no wait, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { BAD_TYPOGRAPHY, loadSrc, testSettings } from "./helpers.mjs";

const runway = await loadSrc("providers/runway");
const stub = await loadSrc("providers/stub");
const registry = await loadSrc("providers/index");
const providerTypes = await loadSrc("providers/types");
const api = await loadSrc("api");

const {
  makeRunwayImageProvider, runwayImagePrompt, ratioForSize, referenceUri, imageRequestBody, taskFailureError,
  RUNWAY_IMAGE_MODEL, RUNWAY_IMAGE_RATIOS, RUNWAY_REFERENCE_TAGS, RUNWAY_VERSION, RUNWAY_BASE, IMAGE_POLL_BUDGET_MS, IMAGE_POLL_STEP_MS, MAX_PROMPT_UNITS,
} = runway;

const sha = (bytes) => createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
const png = (fill) => {
  const b = new Uint8Array(64);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  b.fill(fill, 8);
  return b.buffer;
};
const references = () => [
  { name: "00_face.png", bytes: png(1) },
  { name: "04_full.png", bytes: png(2) },
  { name: "05_side.png", bytes: png(3) },
];
const request = (overrides = {}) => ({
  prompt: "mirror selfie in a black hoodie, messy bun, lamp light, half smile",
  identityPrompt: "OPENAI IDENTITY BLOCK (must not be sent to Runway)",
  references: references(),
  model: RUNWAY_IMAGE_MODEL,
  quality: "medium",
  size: "1024x1536",
  ...overrides,
});
const env = (key = "rw_test_key_not_a_secret") => ({ RUNWAY_API_KEY: key });
const noWait = { sleep: async () => {} };

// Anatomy words the prompt must never carry (the OpenAI filter refused one this morning;
// Runway moderates prompt text too). "face" and "build" are allowed on purpose.
// Words that risk Runway moderation stay out of the identity line. "figure", "curvy",
// "hourglass" and "bust" are allowed on purpose: Runway accepted them on 2026-09-25 and
// they are what keeps her build matching the references (a picture without them came
// out slimmer than every master).
const BODY_WORDS = /\b(body|bodies|breast\w*|chest|cleavage|hips?|waist|thighs?|legs?|torso|lips|skin|butt|bottom)\b/i;

// ------------------------------------------------------------------ pure pieces

test("ratioForSize: exact enum values pass through, 1024x1536 lands on 1080:1440, auto and junk on the portrait default", () => {
  assert.equal(ratioForSize("1024x1536"), "1080:1440");
  assert.equal(ratioForSize("1024x1024"), "1024:1024");
  assert.equal(ratioForSize("1536x1024"), "1440:1080");
  assert.equal(ratioForSize("1024x1792"), "1080:1920");
  assert.equal(ratioForSize("1792x1024"), "1920:1080");
  assert.equal(ratioForSize("720x1280"), "720:1280");
  assert.equal(ratioForSize("auto"), "1080:1440");
  assert.equal(ratioForSize(""), "1080:1440");
  assert.equal(ratioForSize("banana"), "1080:1440");
  for (const size of ["1024x1536", "1024x1024", "512x512", "2048x1024", "auto"]) {
    assert.ok(RUNWAY_IMAGE_RATIOS.includes(ratioForSize(size)), size + " -> " + ratioForSize(size));
  }
});

test("runwayImagePrompt: opens with @avelie, names every tag, states her build, ends with the scene, no moderation-risk words, clean typography, within the 1000-unit cap", () => {
  const p = runwayImagePrompt("mirror selfie in a black hoodie, messy bun, lamp light, half smile");
  assert.ok(p.startsWith("@avelie "), p.slice(0, 40));
  for (const t of RUNWAY_REFERENCE_TAGS) assert.ok(p.includes("@" + t), "mentions @" + t);
  assert.ok(p.includes(" Scene: mirror selfie in a black hoodie, messy bun, lamp light, half smile"), p);
  assert.ok(p.includes("half smile Her figure in this picture: the same full bust and curvy hourglass build as @avelie_2 and @avelie_3, clearly visible under whatever she is wearing, never slimmed or flattened."), p.slice(-260));
  assert.ok(p.endsWith("never slimmed or flattened."), "the figure clause closes the prompt");
  assert.ok(!BODY_WORDS.test(p), "body-part word in: " + p);
  assert.ok(!BAD_TYPOGRAPHY.test(p));
  assert.ok(p.includes("fully clothed"));
  assert.ok(p.includes("22-year-old"));
  assert.ok(p.includes("full curvy hourglass figure"), "build line present");
  assert.ok(p.includes("full bust"), "bust line present");
  assert.ok(p.includes("never slimmed or flattened"));
  assert.ok(p.length <= MAX_PROMPT_UNITS);
  // Fewer references: only the tags that were sent are named.
  const two = runwayImagePrompt("x", ["avelie", "avelie_2"]);
  assert.ok(two.includes("@avelie_2 is the same person as @avelie"));
  assert.ok(!two.includes("avelie_3"));
  const one = runwayImagePrompt("x", ["avelie"]);
  assert.ok(one.startsWith("@avelie is the woman in every reference image. "));
  assert.ok(!one.includes("avelie_2"));
  assert.ok(one.endsWith("build as @avelie, clearly visible under whatever she is wearing, never slimmed or flattened."), "one reference: the figure clause names it");
});

test("runwayImagePrompt: a long scene is cut at a word so the whole prompt fits 1000 units; the identity line is never cut", () => {
  const long = Array.from({ length: 400 }, (_, i) => "word" + i).join(" ");
  const p = runwayImagePrompt(long);
  assert.ok(p.length <= MAX_PROMPT_UNITS, String(p.length));
  assert.ok(p.length > MAX_PROMPT_UNITS - 12, "fills the cap: " + p.length);
  assert.ok(p.includes(" Scene: word0 word1"));
  assert.ok(/word\d+ Her figure in this picture:/.test(p), "the scene is cut on a whole word before the figure clause: " + p.slice(-260));
  assert.ok(p.endsWith("never slimmed or flattened."));
  assert.ok(p.includes("no collage, one image."), "identity line intact");
});

test("referenceUri: a PNG becomes data:image/png;base64 that decodes to the same bytes; a JPEG is sniffed; empty and oversize are refused before encoding", () => {
  const uri = referenceUri("00_face.png", png(7));
  assert.ok(uri.startsWith("data:image/png;base64,"));
  const back = Buffer.from(uri.slice("data:image/png;base64,".length), "base64");
  assert.equal(sha(back), sha(png(7)));
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).buffer;
  assert.ok(referenceUri("x.jpg", jpeg).startsWith("data:image/jpeg;base64,"));
  assert.throws(() => referenceUri("empty.png", new ArrayBuffer(0)), (e) => e.name === "ProviderError" && e.kind === "bad_request" && !e.retryable);
  // 4 MB of bytes encode to about 5.6 MB, over the 5 MB data URI cap.
  assert.throws(() => referenceUri("big.png", new ArrayBuffer(4 * 1024 * 1024)), (e) => e.kind === "bad_request" && e.status === 413 && /5 MB/.test(e.message) && /big\.png/.test(e.message));
});

test("imageRequestBody: model, promptText, ratio and three tagged data-URI references in order; a fourth reference is dropped; OpenAI's identity block is not sent", () => {
  const body = imageRequestBody(request());
  assert.equal(body.model, "gen4_image");
  assert.equal(body.ratio, "1080:1440");
  assert.ok(String(body.promptText).startsWith("@avelie "));
  assert.ok(!String(body.promptText).includes("OPENAI IDENTITY BLOCK"));
  assert.deepEqual(body.referenceImages.map((r) => r.tag), ["avelie", "avelie_2", "avelie_3"]);
  for (const r of body.referenceImages) {
    assert.ok(r.uri.startsWith("data:image/png;base64,"), r.uri.slice(0, 30));
    assert.ok(/^[a-z][a-z0-9_]{2,15}$/.test(r.tag), r.tag);
  }
  assert.deepEqual(Object.keys(body).sort(), ["model", "promptText", "ratio", "referenceImages"]);
  const four = imageRequestBody(request({ references: [...references(), { name: "03_extra.png", bytes: png(4) }] }));
  assert.equal(four.referenceImages.length, 3);
  const one = imageRequestBody(request({ references: [references()[0]] }));
  assert.equal(one.referenceImages.length, 1);
  assert.ok(!String(one.promptText).includes("avelie_2"));
});

test("taskFailureError: SAFETY codes are a non-retryable refusal with the reason redacted; ASSET is a bad request; INTERNAL.BAD_OUTPUT and a missing code may be retried; CANCELLED is not", () => {
  const safety = taskFailureError({ status: "FAILED", output: [], failure: "Text was moderated. key Bearer sk-FAKE-not-a-key-0000 leaked", failureCode: "SAFETY.INPUT.TEXT" });
  assert.equal(safety.kind, "refusal");
  assert.equal(safety.retryable, false);
  assert.ok(safety.message.includes("SAFETY.INPUT.TEXT"));
  assert.ok(!safety.message.includes("sk-FAKE"), safety.message);
  assert.equal(taskFailureError({ status: "FAILED", output: [], failure: "x", failureCode: "INPUT_PREPROCESSING.SAFETY.TEXT" }).kind, "refusal");
  const asset = taskFailureError({ status: "FAILED", output: [], failure: "bad image", failureCode: "ASSET.INVALID" });
  assert.equal(asset.kind, "bad_request");
  assert.equal(asset.retryable, false);
  const internal = taskFailureError({ status: "FAILED", output: [], failure: "quality", failureCode: "INTERNAL.BAD_OUTPUT.01" });
  assert.equal(internal.kind, "server");
  assert.equal(internal.retryable, true);
  assert.equal(taskFailureError({ status: "FAILED", output: [], failure: null, failureCode: null }).retryable, true);
  const cancelled = taskFailureError({ status: "CANCELLED", output: [], failure: null, failureCode: null });
  assert.equal(cancelled.retryable, false);
});

// ------------------------------------------------------------------ the whole path on the stand-in

test("generate: start, poll (RUNNING then SUCCEEDED), download; the request carries the bearer, the version header and the shaped body; the picture is the face crop's bytes", async () => {
  const rw = stub.stubRunwayFetch();
  const provider = makeRunwayImageProvider({ fetch: rw.fetch, ...noWait });
  assert.equal(provider.name, "runway");
  const result = await provider.generate(env(), request());
  assert.equal(result.provider, "runway");
  assert.equal(result.model, "gen4_image");
  assert.equal(sha(result.png), sha(png(1)), "the output is the first reference's bytes");

  const methods = rw.requests.map((r) => r.method + " " + new URL(r.url).pathname);
  assert.deepEqual(methods, [
    "POST /v1/text_to_image",
    "GET /v1/tasks/" + rw.taskIds[0],
    "GET /v1/tasks/" + rw.taskIds[0],
    "GET /output/" + rw.taskIds[0],
  ]);
  const start = rw.requests[0];
  assert.equal(new URL(start.url).origin, RUNWAY_BASE);
  assert.equal(start.headers.authorization, "Bearer rw_test_key_not_a_secret");
  assert.equal(start.headers["x-runway-version"], RUNWAY_VERSION);
  assert.equal(start.headers["content-type"], "application/json");
  assert.equal(start.body.model, "gen4_image");
  assert.equal(start.body.ratio, "1080:1440");
  assert.ok(start.body.promptText.startsWith("@avelie "));
  assert.ok(!BODY_WORDS.test(start.body.promptText));
  assert.deepEqual(start.body.referenceImages.map((r) => r.tag), ["avelie", "avelie_2", "avelie_3"]);
  // The output download carries no key.
  const download = rw.requests[3];
  assert.equal(download.headers.authorization, undefined);
  // The status reads carry the key and the version.
  assert.equal(rw.requests[1].headers["x-runway-version"], RUNWAY_VERSION);
});

test("generate: no key -> config error before any request; no references or an empty scene -> bad_request", async () => {
  const rw = stub.stubRunwayFetch();
  const provider = makeRunwayImageProvider({ fetch: rw.fetch, ...noWait });
  await assert.rejects(provider.generate({}, request()), (e) => e.name === "ProviderError" && e.kind === "config" && e.status === 503 && !e.retryable);
  await assert.rejects(provider.generate({ RUNWAY_API_KEY: "  " }, request()), (e) => e.kind === "config");
  assert.equal(rw.requests.length, 0);
  await assert.rejects(provider.generate(env(), request({ references: [] })), (e) => e.kind === "bad_request");
  await assert.rejects(provider.generate(env(), request({ prompt: "   " })), (e) => e.kind === "bad_request");
  assert.equal(rw.requests.length, 0);
});

test("generate: HTTP errors on the start call map like the video adapter (429 rate_limit retryable, 401 auth, 400 bad_request, 503 server retryable), bodies redacted", async () => {
  const cases = [
    [429, "rate_limit", true],
    [401, "auth", false],
    [400, "bad_request", false],
    [503, "server", true],
  ];
  for (const [status, kind, retryable] of cases) {
    const rw = stub.stubRunwayFetch({ startStatus: status });
    const provider = makeRunwayImageProvider({ fetch: rw.fetch, ...noWait });
    await assert.rejects(provider.generate(env(), request()), (e) => {
      assert.equal(e.name, "ProviderError");
      assert.equal(e.kind, kind, "status " + status);
      assert.equal(e.retryable, retryable, "status " + status);
      assert.ok(!e.message.includes("rw_test_key"), e.message);
      return true;
    });
    assert.equal(rw.requests.length, 1, "no poll after a failed start");
  }
});

test("generate: a moderated task (FAILED, SAFETY.INPUT.TEXT) is a non-retryable refusal; INTERNAL.BAD_OUTPUT is a retryable server error; CANCELLED is not retried", async () => {
  const moderated = stub.stubRunwayFetch({ fail: { status: "FAILED", failureCode: "SAFETY.INPUT.TEXT", failure: "prompt text was moderated" } });
  await assert.rejects(makeRunwayImageProvider({ fetch: moderated.fetch, ...noWait }).generate(env(), request()), (e) => e.kind === "refusal" && !e.retryable && /SAFETY\.INPUT\.TEXT/.test(e.message));
  assert.ok(!moderated.requests.some((r) => r.method === "DELETE"), "a finished task is not cancelled");

  const bad = stub.stubRunwayFetch({ fail: { status: "FAILED", failureCode: "INTERNAL.BAD_OUTPUT.01", failure: "quality" } });
  await assert.rejects(makeRunwayImageProvider({ fetch: bad.fetch, ...noWait }).generate(env(), request()), (e) => e.kind === "server" && e.retryable);

  const cancelled = stub.stubRunwayFetch({ fail: { status: "CANCELLED" } });
  await assert.rejects(makeRunwayImageProvider({ fetch: cancelled.fetch, ...noWait }).generate(env(), request()), (e) => e.kind === "other" && !e.retryable);
});

test("generate: the poll is bounded; past the budget the task is cancelled (DELETE) and a retryable server error is thrown", async () => {
  const rw = stub.stubRunwayFetch({ runningPolls: -1 });
  let clock = 1_000_000;
  const sleeps = [];
  const provider = makeRunwayImageProvider({
    fetch: rw.fetch,
    now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
  });
  await assert.rejects(provider.generate(env(), request()), (e) => e.kind === "server" && e.retryable && e.status === 504 && /cancelled/.test(e.message));
  assert.ok(sleeps.every((ms) => ms === IMAGE_POLL_STEP_MS));
  assert.equal(sleeps.length, Math.ceil(IMAGE_POLL_BUDGET_MS / IMAGE_POLL_STEP_MS));
  const last = rw.requests[rw.requests.length - 1];
  assert.equal(last.method, "DELETE");
  assert.equal(new URL(last.url).pathname, "/v1/tasks/" + rw.taskIds[0]);
  assert.equal(last.headers.authorization, "Bearer rw_test_key_not_a_secret");
});

test("generate: a transport failure is a retryable network error; an output download that fails is a server error; an empty output is refused", async () => {
  const dead = makeRunwayImageProvider({ fetch: async () => { throw new TypeError("fetch failed"); }, ...noWait });
  await assert.rejects(dead.generate(env(), request()), (e) => e.kind === "network" && e.retryable && e.message === "fetch failed");
  const broken = stub.stubRunwayFetch({ outputStatus: 500 });
  await assert.rejects(makeRunwayImageProvider({ fetch: broken.fetch, ...noWait }).generate(env(), request()), (e) => e.kind === "server" && e.retryable);
  const empty = stub.stubRunwayFetch({ output: new ArrayBuffer(0) });
  await assert.rejects(makeRunwayImageProvider({ fetch: empty.fetch, ...noWait }).generate(env(), request()), (e) => e.kind === "server");
});

test("generateFromText (portraits): no references, the prompt as given within the cap, the ratio from the portrait size", async () => {
  const rw = stub.stubRunwayFetch();
  const provider = makeRunwayImageProvider({ fetch: rw.fetch, ...noWait });
  const result = await provider.generateFromText(env(), { prompt: "a friendly barista, mid twenties, warm smile", model: "gen4_image", quality: "medium", size: "1024x1024" });
  assert.equal(result.provider, "runway");
  const start = rw.requests[0];
  assert.deepEqual(Object.keys(start.body).sort(), ["model", "promptText", "ratio"]);
  assert.equal(start.body.promptText, "a friendly barista, mid twenties, warm smile");
  assert.equal(start.body.ratio, "1024:1024");
  await assert.rejects(provider.generateFromText(env(), { prompt: " ", model: "gen4_image", quality: "medium", size: "1024x1024" }), (e) => e.kind === "bad_request");
});

// ------------------------------------------------------------------ wiring

test("registry: runway is an image provider, configured only with RUNWAY_API_KEY, never keyless; the module-level provider is the one in the registry", () => {
  assert.ok(providerTypes.isImageProviderName("runway"));
  assert.deepEqual([...providerTypes.IMAGE_PROVIDER_NAMES], ["openai", "runway", "stub"]);
  assert.equal(registry.getImageProvider("runway"), runway.runwayImageProvider);
  assert.equal(registry.getImageProvider("runway").name, "runway");
  assert.equal(registry.imageProviderConfigured({}, "runway"), false);
  assert.equal(registry.imageProviderConfigured({ RUNWAY_API_KEY: "" }, "runway"), false);
  assert.equal(registry.imageProviderConfigured({ RUNWAY_API_KEY: "rw_x" }, "runway"), true);
  assert.equal(registry.imageProviderConfigured({ OPENAI_API_KEY: "sk-x" }, "runway"), false, "the OpenAI key does not configure Runway");
  assert.equal(registry.isKeylessImageProvider("runway"), false);
  assert.equal(typeof registry.getImageProvider("runway").generateFromText, "function", "portraits can run on it too");
});

test("settings: imageProvider runway is accepted by validation and needs a price above 0 like any paid provider; the default model id is gen4_image", () => {
  assert.equal(api.validateSettingsPatch({ imageProvider: "runway" }).imageProvider, "runway");
  assert.equal(api.validateSettingsPatch({ imageModel: "gen4_image" }).imageModel, "gen4_image");
  assert.throws(() => api.validateSettingsPatch({ imageProvider: "runway-image" }), (e) => e.status === 400 && e.code === "validation");
  const current = testSettings({ imageProvider: "stub", imageCostUsd: 0 });
  assert.throws(() => api.assertSettingsConsistent(current, { imageProvider: "runway" }), (e) => e.status === 400 && /imageCostUsd/.test(e.message));
  assert.doesNotThrow(() => api.assertSettingsConsistent(current, { imageProvider: "runway", imageCostUsd: 0.08 }));
  assert.equal(RUNWAY_IMAGE_MODEL, "gen4_image");
});
