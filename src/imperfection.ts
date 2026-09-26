// The imperfection engine's per-turn cue (SPEC_V3 section GG). Pure: one seeded roll picks
// a shape for this one message, or nothing (most turns), and the section is one line the
// performer reads. The cue is an instruction to her, never an edit: no post-processor adds
// an error, and the repair pass never touches spelling. The typo cue ships at share 0.
import { seededUnit } from "./life";
import { RHYTHM_SIZES, lengthBand, observedRhythm, signature, stripActionLines } from "./checks";
import type { Rhythm, RhythmAction, RhythmExtra, RhythmSize } from "./types";

// The shape signature and the observed rhythm live in checks.ts (they read the length band
// and the action-line rule there); re-exported here so the contract names hold.
export { observedRhythm, signature, stripActionLines };

export type ShapeCue = "one_word" | "fragment" | "lowercase" | "bubbles" | "typo_fix" | "voice" | "long";

export interface ShapeCueOptions {
  // A voice cue only when v2's voice notes are on (voiceMode some or all, provider configured).
  voiceAllowed: boolean;
  // The typo_fix share of the whole table, 0..0.3. 0 (shipped): the cue never rolls.
  typoShare: number;
  // textureCuesEnabled; false returns null every turn.
  enabled: boolean;
}

export interface CueRow {
  cue: ShapeCue | "none";
  p: number;
}

// The table: none 0.55; the cues share the other 0.45. typo_fix takes exactly typoShare of
// the whole, and the remaining cues share what is left of the 0.45 in these proportions.
// At typoShare 0.05 with voice allowed the table is exactly the spec's: none 0.55,
// one_word 0.07, fragment 0.08, lowercase 0.08, bubbles 0.10, typo_fix 0.05, voice 0.04,
// long 0.03. With voice off or typoShare 0 the other cues grow and none stays 0.55.
export const NONE_WEIGHT = 0.55;
export const CUE_WEIGHTS: Record<Exclude<ShapeCue, "typo_fix">, number> = {
  one_word: 0.07,
  fragment: 0.08,
  lowercase: 0.08,
  bubbles: 0.10,
  voice: 0.04,
  long: 0.03,
};
export const TYPO_SHARE_MAX = 0.3;

export const CUE_LINES: Record<ShapeCue, string> = {
  one_word: "One word, or two, is the whole reply if that is the honest answer.",
  fragment: "A fragment. No full sentence needed.",
  lowercase: "All lowercase, you cannot be bothered with the shift key right now.",
  bubbles: "Two or three short bubbles (blank line between them), not one block.",
  typo_fix: "You are typing fast. One real slip lands in this (a doubled letter, two swapped letters, a missing one; never a joke word), and you fix it in a second bubble with an asterisk, or leave it if it is obvious.",
  voice: "You would rather say this one than type it: end with [voice].",
  long: "You are in the mood to talk. Let this one run.",
};

const CUE_ORDER: ShapeCue[] = ["one_word", "fragment", "lowercase", "bubbles", "typo_fix", "voice", "long"];

// One roll in [0, 1) from the seed. seededUnit is FNV-1a, whose top bits follow the last
// character of the input; the turn key ends in a cycling sequence number, so the raw value
// would fall into bands and the cue would follow the sequence. A murmur3 finaliser over the
// same 32-bit hash spreads it; still one deterministic roll per seed (a retry rolls the same).
export function rollUnit(seed: string): number {
  let h = Math.floor(seededUnit(String(seed ?? "")) * 4294967296) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function clampShare(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return Math.min(TYPO_SHARE_MAX, Math.max(0, v));
}

// The cues that would produce a signature again. Two or more bubbles: the bubble cues.
// A long single block: long. A short or lowercase block: the short and lowercase cues.
// A plain mid-length mixed-case block is what no cue produces, so "none" is what to
// exclude then: the third message rolls a real cue and changes shape.
export function cuesForSignature(sig: string): Array<ShapeCue | "none"> {
  const parts = String(sig ?? "").split("|");
  const bubbles = parts[0] ?? "1";
  const length = parts[1] ?? "mid";
  const caseWord = parts[2] ?? "mixed";
  if (bubbles === "2" || bubbles === "3") return ["bubbles", "typo_fix"];
  if (length === "long") return ["long"];
  const out: Array<ShapeCue | "none"> = [];
  if (caseWord === "lower") out.push("lowercase");
  if (length === "short") out.push("one_word", "fragment");
  return out.length ? out : ["none"];
}

// The probability table for one turn, after the allowed-cue and exclusion rules.
export function cueTable(recentSignatures: string[], opts: ShapeCueOptions): CueRow[] {
  const typo = clampShare(opts.typoShare);
  const rest = Math.max(0, 1 - NONE_WEIGHT - typo);
  const allowed = CUE_ORDER.filter((c) => c !== "typo_fix" && (c !== "voice" || opts.voiceAllowed)) as Array<Exclude<ShapeCue, "typo_fix">>;
  const baseSum = allowed.reduce((s, c) => s + CUE_WEIGHTS[c], 0);
  const rows: CueRow[] = [{ cue: "none", p: NONE_WEIGHT }];
  for (const c of CUE_ORDER) {
    if (c === "typo_fix") rows.push({ cue: c, p: typo });
    else if (allowed.includes(c as Exclude<ShapeCue, "typo_fix">)) rows.push({ cue: c, p: baseSum > 0 ? (CUE_WEIGHTS[c as Exclude<ShapeCue, "typo_fix">] / baseSum) * rest : 0 });
    else rows.push({ cue: c, p: 0 });
  }

  const sigs = Array.isArray(recentSignatures) ? recentSignatures.filter((s) => typeof s === "string" && s) : [];
  if (sigs.length >= 2) {
    const last = sigs[sigs.length - 1];
    const before = sigs[sigs.length - 2];
    if (last !== undefined && last === before) {
      const excluded = new Set<ShapeCue | "none">(cuesForSignature(last));
      for (const r of rows) if (excluded.has(r.cue)) r.p = 0;
    }
  }

  const total = rows.reduce((s, r) => s + r.p, 0);
  if (total <= 0) return [{ cue: "none", p: 1 }];
  return rows.map((r) => ({ cue: r.cue, p: r.p / total }));
}

// One roll per turn from the seed chat.ts computes before generation (so a retry rolls the
// same cue). Returns null for "none" and whenever the cues are off.
export function shapeCue(seed: string, recentSignatures: string[], opts: ShapeCueOptions): ShapeCue | null {
  if (!opts || !opts.enabled) return null;
  const rows = cueTable(recentSignatures, opts);
  const r = rollUnit(seed);
  let acc = 0;
  let picked: ShapeCue | "none" = "none";
  for (const row of rows) {
    if (row.p <= 0) continue;
    acc += row.p;
    picked = row.cue;
    if (r < acc) break;
  }
  return picked === "none" ? null : picked;
}

// THIS MESSAGE: the last state section, present only on the turns that roll a cue.
export function cueSection(cue: ShapeCue | null): string {
  if (!cue || !(cue in CUE_LINES)) return "";
  return "THIS MESSAGE\n" + CUE_LINES[cue];
}

// ------------------------------------------------------------------ v5 reply rhythm (SPEC_V5 section 5)
//
// The v3 cue above rolled a shape on about 45% of turns. v5 rolls a rhythm on every turn
// while the cues are on: a size from a texting distribution, an action choice in Together
// mode, and at most one extra, each steered by the shapes of her last three replies. It is
// an instruction in THIS MESSAGE; nothing ever cuts or rewrites what she wrote.

export const RHYTHM_SIZE_WEIGHTS: Record<RhythmSize, number> = {
  one_word: 0.12,
  one_line: 0.34,
  two_lines: 0.26,
  three_lines: 0.14,
  longer: 0.14,
};

export const RHYTHM_ACTION_WEIGHTS: Record<RhythmAction, number> = { none: 0.5, one: 0.4, only: 0.1 };

// typo_fix takes typoCueShare; "no extra" takes what is left of 1.
export const RHYTHM_EXTRA_WEIGHTS = { lowercase: 0.12, voice: 0.04 } as const;

export const RHYTHM_REPEAT_FACTOR = 0.4;

export const RHYTHM_SUBSTANTIVE_CHARS = 200;

const RHYTHM_ACTIONS: readonly RhythmAction[] = ["none", "one", "only"];
const RHYTHM_EXTRAS: ReadonlyArray<RhythmExtra | null> = ["lowercase", "typo_fix", "voice", null];

// His pending text asked something or said something real (a "?" or more than 200
// characters after trimming): it earns more than a word or an action.
export function hisTextIsSubstantive(text: string | null | undefined): boolean {
  const t = typeof text === "string" ? text.trim() : "";
  if (!t) return false;
  return t.includes("?") || t.length > RHYTHM_SUBSTANTIVE_CHARS;
}

export interface RhythmOptions {
  // textureCuesEnabled; false: no rhythm at all.
  enabled: boolean;
  // The scene is together: the action row is rolled.
  together: boolean;
  // An opener or a first text: one or two bubbles, no action, lowercase the only extra.
  opener: boolean;
  // An intimate scene she chose (prompt.ts intimateScene): never one word, one action.
  intimate: boolean;
  // A voice extra only when voice notes are on.
  voiceAllowed: boolean;
  // typoCueShare, clamped to 0..0.3; 0 as shipped.
  typoShare: number;
  // hisTextIsSubstantive of his pending text.
  substantive: boolean;
}

export interface RhythmTable {
  sizes: Array<{ size: RhythmSize; p: number }>;
  actions: Array<{ action: RhythmAction; p: number }>;
  extras: Array<{ extra: RhythmExtra | null; p: number }>;
}

function renormalise<T extends { p: number }>(rows: T[], base: T[]): T[] {
  const clean = rows.map((r) => ({ ...r, p: Number.isFinite(r.p) && r.p > 0 ? r.p : 0 }));
  const total = clean.reduce((s, r) => s + r.p, 0);
  if (total <= 0) {
    const baseTotal = base.reduce((s, r) => s + r.p, 0);
    return base.map((r) => ({ ...r, p: baseTotal > 0 ? r.p / baseTotal : 0 }));
  }
  return clean.map((r) => ({ ...r, p: r.p / total }));
}

// The three tables for one turn, rules 1 to 8 of SPEC_V5 section 5 in order.
export function rhythmTable(recentTexts: string[], opts: RhythmOptions): RhythmTable {
  const o = opts ?? ({} as RhythmOptions);
  // (1) the base weights
  const size: Record<RhythmSize, number> = { ...RHYTHM_SIZE_WEIGHTS };
  const action: Record<RhythmAction, number> = { ...RHYTHM_ACTION_WEIGHTS };

  // (2) an opener is one or two bubbles, no action, lowercase the only extra
  if (o.opener === true) {
    for (const k of RHYTHM_SIZES) if (k !== "one_line" && k !== "two_lines") size[k] = 0;
    action.none = 1;
    action.one = 0;
    action.only = 0;
  }

  // (3) an intimate scene: never one word, and one action (IN BED writes the scene)
  if (o.intimate === true) {
    size.one_word = 0;
    action.none = 0;
    action.one = 1;
    action.only = 0;
  }

  const texts = (Array.isArray(recentTexts) ? recentTexts : []).filter((t) => typeof t === "string").slice(-3);
  const seen = texts.map((t) => observedRhythm(t));

  // (4) each size she used among the last three is steered away from, once per time
  for (const r of seen) size[r.size] *= RHYTHM_REPEAT_FACTOR;

  // (5) length_pattern feeds the cue
  if (texts.length >= 3 && texts.every((t) => lengthBand(t) === "long")) {
    size.longer = 0;
    size.two_lines *= 0.5;
    size.three_lines *= 0.5;
    size.one_word *= 2;
    size.one_line *= 2;
  }
  if (seen.filter((r) => r.size === "longer").length >= 2) size.longer = 0;

  // (6) Together: steer away from the actions just used and from the bookend habit
  if (o.together === true) {
    for (const r of seen) action[r.action] *= 0.5;
    if (seen.filter((r) => r.bookended).length >= 2) {
      action.one *= 0.3;
      action.none *= 1.6;
    }
  }

  // (6b) he asked something or said something real: never a shrug
  if (o.substantive === true) {
    size.one_word = 0;
    action.only = 0;
  }

  const sizeBase = RHYTHM_SIZES.map((k) => ({ size: k, p: RHYTHM_SIZE_WEIGHTS[k] }));
  const sizes = renormalise(RHYTHM_SIZES.map((k) => ({ size: k, p: size[k] })), sizeBase);

  // (7) apart: no action row to roll
  const actionBase = RHYTHM_ACTIONS.map((k) => ({ action: k, p: RHYTHM_ACTION_WEIGHTS[k] }));
  const actions = o.together === true
    ? renormalise(RHYTHM_ACTIONS.map((k) => ({ action: k, p: action[k] })), actionBase)
    : [{ action: "none" as RhythmAction, p: 1 }];

  // (8) the extras
  const typo = o.opener === true ? 0 : clampShare(o.typoShare);
  const lower = RHYTHM_EXTRA_WEIGHTS.lowercase;
  const voice = o.opener !== true && o.voiceAllowed === true ? RHYTHM_EXTRA_WEIGHTS.voice : 0;
  const rest = Math.max(0, 1 - lower - typo - voice);
  const extraRows: Array<{ extra: RhythmExtra | null; p: number }> = RHYTHM_EXTRAS.map((k) => ({
    extra: k,
    p: k === "lowercase" ? lower : k === "typo_fix" ? typo : k === "voice" ? voice : rest,
  }));
  const extraBase: Array<{ extra: RhythmExtra | null; p: number }> = [
    { extra: "lowercase", p: lower },
    { extra: "typo_fix", p: 0 },
    { extra: "voice", p: 0 },
    { extra: null, p: 1 - lower },
  ];
  const extras = renormalise(extraRows, extraBase);

  return { sizes, actions, extras };
}

// Walk a table with one roll in [0, 1): the row whose cumulative share first passes the
// roll (rows at 0 never picked; the last live row when rounding leaves the roll past the end).
function pickRow<T extends { p: number }>(rows: T[], roll: number): T | undefined {
  let acc = 0;
  let picked: T | undefined;
  for (const row of rows) {
    if (row.p <= 0) continue;
    acc += row.p;
    picked = row;
    if (roll < acc) break;
  }
  return picked;
}

// One rhythm per turn from the seed chat.ts computes before generation (a retry rolls the
// same one). Null when the cues are off.
export function rhythmCue(seed: string, recentTexts: string[], opts: RhythmOptions): Rhythm | null {
  if (!opts || opts.enabled !== true) return null;
  const table = rhythmTable(recentTexts, opts);
  const s = String(seed ?? "");
  const size: RhythmSize = pickRow(table.sizes, rollUnit(s + "|size"))?.size ?? "one_line";
  const action: RhythmAction | null = opts.together === true
    ? pickRow(table.actions, rollUnit(s + "|action"))?.action ?? "none"
    : null;
  const extra: RhythmExtra | null = pickRow(table.extras, rollUnit(s + "|extra"))?.extra ?? null;
  return { size, action, extra };
}

export const RHYTHM_SIZE_LINES: Record<RhythmSize, string> = {
  one_word: "One word, or two. That is the whole reply.",
  one_line: "One short line. One bubble, nothing after it.",
  two_lines: "Two short bubbles (a blank line between them), each one line.",
  three_lines: "Three short bubbles (blank lines between them), each one line or less.",
  longer: "You have something to say: one longer message, a few sentences, still how you text, no tidy last line.",
};

export const RHYTHM_ACTION_LINES: Record<RhythmAction, string> = {
  none: "No asterisk action in this one; just what you say.",
  one: "At most one short action between asterisks, where it belongs, never one at the start and another at the end.",
  only: "Just an action between asterisks, or an action and a word or two; nothing else.",
};

export const RHYTHM_HEADER = "THIS MESSAGE (its shape; the words are yours)";

// THIS MESSAGE on every turn that carries a rhythm.
export function rhythmSection(r: Rhythm | null): string {
  if (!r || !(r.size in RHYTHM_SIZE_LINES)) return "";
  const lines = [RHYTHM_HEADER, RHYTHM_SIZE_LINES[r.size]];
  if (r.action && r.action in RHYTHM_ACTION_LINES) lines.push(RHYTHM_ACTION_LINES[r.action]);
  if (r.extra && r.extra in CUE_LINES) lines.push(CUE_LINES[r.extra]);
  return lines.join("\n");
}

// The v3 cue this rhythm reads as, for turnTags and provenance.
export function rhythmAsShapeCue(r: Rhythm | null): ShapeCue | null {
  if (!r) return null;
  if (r.extra) return r.extra;
  switch (r.size) {
    case "one_word": return "one_word";
    case "two_lines":
    case "three_lines": return "bubbles";
    case "longer": return "long";
    default: return null;
  }
}
