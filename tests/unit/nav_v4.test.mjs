// The shell's nav and her avatar (SPEC_V4 section 0): public/js/nav.js read as text (it
// builds the nav at load, so it is never imported under Node), the eight links in order,
// the focus table equal to the copy in src/api.ts, the crop through the CSSOM, and the
// route and storage key the avatar reads.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BAD_TYPOGRAPHY } from "./helpers.mjs";

const nav = readFileSync(new URL("../../public/js/nav.js", import.meta.url), "utf8");
const api = readFileSync(new URL("../../src/api.ts", import.meta.url), "utf8");

const LINKS = [["/", "Chat"], ["/phone", "Phone"], ["/album", "Album"], ["/memory", "Memory"], ["/state", "State"], ["/model", "Model"], ["/images", "Images"], ["/timeline", "Timeline"]];
const FOCUS = { "master-00": [50, 40], "master-01": [48, 28], "master-02": [58, 24], "master-03": [50, 32], "master-04": [44, 27], "master-05": [50, 24] };

// The AVATAR_FOCUS literal of a source file, read as JSON: `"master-00": [50, 40], ...`.
function focusTableOf(source, label) {
  const m = /AVATAR_FOCUS[^=]*=\s*\{([^}]*)\}/.exec(source);
  assert.ok(m, label + " carries an AVATAR_FOCUS table");
  const out = {};
  for (const entry of m[1].matchAll(/"(master-0\d)"\s*:\s*\[\s*(\d+)\s*,\s*(\d+)\s*\]/g)) out[entry[1]] = [Number(entry[2]), Number(entry[3])];
  return out;
}

test("nav.js LINKS: the eight paths in the header's order, Chat first and Timeline last", () => {
  const m = /export const LINKS = \[([\s\S]*?)\];/.exec(nav);
  assert.ok(m, "LINKS exported");
  const pairs = Array.from(m[1].matchAll(/\["([^"]+)",\s*"([^"]+)"\]/g)).map((x) => [x[1], x[2]]);
  assert.deepEqual(pairs, LINKS);
});

test("nav.js AVATAR_FOCUS: the six masters with the values read off the masters on 2026-09-26", () => {
  assert.deepEqual(focusTableOf(nav, "nav.js"), FOCUS);
});

test("src/api.ts carries the same AVATAR_FOCUS table (one table in two places, kept equal here)", (tc) => {
  if (!/AVATAR_FOCUS/.test(api)) {
    tc.skip("src/api.ts has no AVATAR_FOCUS yet (pipeline lane)");
    return;
  }
  assert.deepEqual(focusTableOf(api, "src/api.ts"), focusTableOf(nav, "nav.js"));
});

test("nav.js exports avatarFocus, mountAvatar and avatarImg; an unknown id falls back to [50, 30]", () => {
  for (const name of ["export function avatarFocus", "export function mountAvatar", "export function avatarImg"]) assert.ok(nav.includes(name), name);
  assert.ok(/DEFAULT_FOCUS = \[50, 30\]/.test(nav), "the default focus");
});

test("the crop goes through the CSSOM, never a style attribute; the route and the storage key are the spec's", () => {
  assert.ok(/\.style\.objectPosition\s*=/.test(nav), "objectPosition set on the CSSOM");
  assert.ok(!/setAttribute\(\s*["']style["']/.test(nav), "no style attribute is written");
  assert.ok(nav.includes('fetch("/api/avatar"'), "GET /api/avatar");
  assert.ok(nav.includes('"avelie.avatar"'), "localStorage avelie.avatar");
  assert.ok(/master-05/.test(nav) && /05_MASTER_GAVINS_BLACK_DRESS_APPROVED\.png/.test(nav), "the default avatar is master-05");
  assert.ok(!BAD_TYPOGRAPHY.test(nav));
});

test("nav.js is browser-only on purpose: it builds the nav and mounts the avatar at load", () => {
  assert.ok(/document\.querySelectorAll\("\.nav"\)/.test(nav), "the nav is rebuilt from LINKS");
  assert.ok(/\nmountAvatar\(\);\s*$/.test(nav), "mountAvatar() runs at load");
});
