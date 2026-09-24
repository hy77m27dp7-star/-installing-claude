// The imperfection engine's per-turn cue (SPEC_V3 section GG). Pure: one seeded roll picks
// a shape for this one message, or nothing (most turns), and the section is one line the
// performer reads. The cue is an instruction to her, never an edit: no post-processor adds
// an error, and the repair pass never touches spelling. The typo cue ships at share 0.
import { seededUnit } from "./life";
import { signature } from "./checks";

// The shape signature lives in checks.ts (it reads the length band there); re-exported
// here so the contract name holds.
export { signature };

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
