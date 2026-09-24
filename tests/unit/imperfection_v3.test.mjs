// The imperfection engine (SPEC_V3 section GG): the shape signature, the seeded cue and
// its distribution, the exclusion after two equal shapes, and the cue section.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BAD_TYPOGRAPHY } from "./helpers.mjs";
import { loadSrcIfPresent, guard } from "./helpers_v3.mjs";

const mod = await loadSrcIfPresent("imperfection");
const t = guard(mod, "signature", "shapeCue", "cueSection");
const CUES = ["one_word", "fragment", "lowercase", "bubbles", "typo_fix", "voice", "long"];

t("signature: eight fixed texts", () => {
  const { signature } = mod;
  assert.equal(signature("no"), "1|short|lower|s");
  assert.equal(signature("No."), "1|short|mixed|s");
  assert.equal(signature("what do you mean?"), "1|short|lower|q");
  assert.equal(signature("ok that was werid\n\nweird*"), "2|short|lower|s");
  assert.equal(signature("first bubble\n\nsecond bubble\n\nthird bubble"), "3|short|lower|s");
  assert.equal(signature("a\n\nb\n\nc\n\nd\n\ne"), "3|short|lower|s", "three or more bands as 3");
  assert.equal(signature("Fine, that is fair. I did not think of it that way."), "1|short|mixed|s");
  const mid = "i was going to say something short and then it became a whole thing, sorry, the point is that today was one of those days where";
  assert.equal(signature(mid), "1|mid|lower|s");
  const long = ("word ".repeat(70)).trim() + "?";
  assert.equal(signature(long), "1|long|lower|q");
});

function distribution(opts, n = 4000) {
  const counts = { none: 0 };
  for (const c of CUES) counts[c] = 0;
  for (let i = 0; i < n; i++) {
    const cue = mod.shapeCue("seed-" + i, [], opts);
    counts[cue === null ? "none" : cue]++;
  }
  return counts;
}

t("shapeCue: the distribution over 4,000 seeds at the shipped settings", () => {
  const c = distribution({ voiceAllowed: true, typoShare: 0, enabled: true });
  const share = (k) => c[k] / 4000;
  assert.ok(share("none") >= 0.5 && share("none") <= 0.6, "none " + share("none"));
  assert.equal(c.typo_fix, 0, "the typo cue never rolls at the shipped share");
  assert.ok(share("bubbles") > 0.05 && share("bubbles") < 0.16, "bubbles " + share("bubbles"));
  assert.ok(share("voice") > 0.01 && share("voice") < 0.08, "voice " + share("voice"));
  assert.ok(share("long") > 0.005 && share("long") < 0.07, "long " + share("long"));
  const noVoice = distribution({ voiceAllowed: false, typoShare: 0, enabled: true });
  assert.equal(noVoice.voice, 0, "voice exactly 0 when not allowed");
  const typo = distribution({ voiceAllowed: true, typoShare: 0.05, enabled: true });
  assert.ok(typo.typo_fix / 4000 > 0.025 && typo.typo_fix / 4000 < 0.08, "typo_fix near 0.05 when the share is 0.05: " + typo.typo_fix / 4000);
});

t("shapeCue: deterministic by seed, null when disabled", () => {
  const opts = { voiceAllowed: true, typoShare: 0.05, enabled: true };
  for (let i = 0; i < 50; i++) assert.equal(mod.shapeCue("s" + i, [], opts), mod.shapeCue("s" + i, [], opts));
  assert.equal(mod.shapeCue("anything", [], { ...opts, enabled: false }), null);
});

t("shapeCue: after two equal signatures the cue that would repeat that shape is excluded", () => {
  const opts = { voiceAllowed: true, typoShare: 0, enabled: true };
  const sig = "1|short|lower|s";
  let oneWordSeen = 0;
  for (let i = 0; i < 4000; i++) {
    const cue = mod.shapeCue("x" + i, [sig, sig], opts);
    if (cue === "one_word" || cue === "fragment" || cue === "lowercase") oneWordSeen++;
  }
  assert.equal(oneWordSeen, 0, "a one-line lowercase statement must not be cued again after two of them");
  let bubbles = 0;
  for (let i = 0; i < 4000; i++) if (mod.shapeCue("y" + i, ["2|short|lower|s", "2|short|lower|s"], opts) === "bubbles") bubbles++;
  assert.equal(bubbles, 0, "bubbles is excluded after two two-bubble replies");
  const differing = mod.shapeCue("z", ["1|short|lower|s", "2|mid|mixed|q"], opts);
  assert.ok(differing === null || CUES.includes(differing));
});

t("cueSection: text per cue, empty for null, THIS MESSAGE header", () => {
  const { cueSection } = mod;
  assert.equal(cueSection(null), "");
  for (const c of CUES) {
    const s = cueSection(c);
    assert.ok(s.startsWith("THIS MESSAGE"), c);
    assert.ok(!BAD_TYPOGRAPHY.test(s));
    assert.ok(!/the app|prompt|model/i.test(s), c);
  }
  assert.ok(/One word, or two, is the whole reply/.test(cueSection("one_word")));
  assert.ok(/A fragment\. No full sentence needed\./.test(cueSection("fragment")));
  assert.ok(/All lowercase/.test(cueSection("lowercase")));
  assert.ok(/Two or three short bubbles/.test(cueSection("bubbles")));
  assert.ok(/never a joke word/.test(cueSection("typo_fix")));
  assert.ok(/end with \[voice\]/.test(cueSection("voice")));
  assert.ok(/Let this one run/.test(cueSection("long")));
});
