// Video clips (SPEC_V3 section FF): the stub mp4, the claim lease, the cost by seconds
// and the encoded-size gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { loadSrcIfPresent, firstExport, settingsV3 } from "./helpers_v3.mjs";

const video = await loadSrcIfPresent("video");
const runway = await loadSrcIfPresent("providers/runway");
const S = settingsV3();

const sha = (bytes) => createHash("sha256").update(new Uint8Array(bytes)).digest("hex");

test("the stub mp4 has a stable sha256 and an ftyp box", async (tc) => {
  const f = firstExport(runway, ["stubMp4", "STUB_MP4", "minimalMp4"]).fn ? firstExport(runway, ["stubMp4", "minimalMp4"]) : firstExport(video, ["stubMp4", "minimalMp4"]);
  if (!f.fn) {
    tc.skip("no stubMp4 in providers/runway.ts or video.ts (tried stubMp4, minimalMp4)");
    return;
  }
  const a = await f.fn();
  const b = await f.fn();
  assert.equal(sha(a), sha(b), "stable bytes");
  const bytes = new Uint8Array(a);
  assert.ok(bytes.length >= 32 && bytes.length <= 4096, String(bytes.length));
  assert.equal(String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]), "ftyp");
});

test("the claim lease: a claim older than 15 minutes counts as abandoned", (tc) => {
  const f = firstExport(video, ["claimAbandoned", "leaseExpired", "isAbandoned", "claimStale"]);
  if (!f.fn) {
    tc.skip("video.ts exports no lease check (tried claimAbandoned, leaseExpired, isAbandoned, claimStale)");
    return;
  }
  const now = new Date("2026-09-29T19:10:00Z");
  assert.equal(f.fn("source:img_1|task:stub-task|since 2026-09-29T18:50:00.000Z", now), true);
  assert.equal(f.fn("source:img_1|task:stub-task|since 2026-09-29T19:00:00.000Z", now), false);
  assert.equal(f.fn(null, now), true);
});

test("the clip cost is the price per five seconds times the seconds", (tc) => {
  const f = firstExport(video, ["clipCostUsd", "videoCostUsd", "clipCost", "costForClip"]);
  if (!f.fn) {
    tc.skip("video.ts exports no cost helper (tried clipCostUsd, videoCostUsd, clipCost, costForClip)");
    return;
  }
  assert.equal(f.fn(S), 0.25);
  assert.equal(f.fn(settingsV3({ videoSeconds: 10 })), 0.5);
  assert.equal(f.fn(settingsV3({ videoSeconds: 10, videoCostUsd: 0.4 })), 0.8);
});

// SPEC_V3 names a 4 MB and a 6 MB buffer; base64 grows bytes by a third, so 4 MB encodes to
// about 5.6 MB and is itself over the 5 MB cap. The passing case here is 3 MB (about 4.2 MB
// encoded, the size of the largest master); 6 MB is the failing case as written.
test("the encoded-size gate: a 3 MB source passes, a 6 MB source is over the 5 MB data-URI cap", (tc) => {
  const f = firstExport(video, ["encodedSize", "dataUriSize", "sourceTooLarge", "encodedLength"]);
  if (!f.fn) {
    tc.skip("video.ts exports no encoded-size helper (tried encodedSize, dataUriSize, sourceTooLarge, encodedLength)");
    return;
  }
  const three = new Uint8Array(3 * 1024 * 1024);
  const six = new Uint8Array(6 * 1024 * 1024);
  const cap = 5 * 1024 * 1024;
  const r3 = f.fn(three.buffer, "image/png");
  const r6 = f.fn(six.buffer, "image/png");
  if (typeof r3 === "boolean") {
    assert.equal(r3, false, "3 MB is not too large");
    assert.equal(r6, true, "6 MB is too large");
  } else {
    assert.ok(typeof r3 === "number" && typeof r6 === "number");
    assert.ok(r3 > three.length && r3 <= cap, "3 MB encodes under the cap: " + r3);
    assert.ok(r6 > cap, "6 MB encodes over the cap: " + r6);
  }
});
