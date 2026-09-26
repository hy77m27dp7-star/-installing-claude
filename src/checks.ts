// Post-generation checks (the Archivist). Pure: no D1, no env, no imports beyond types,
// so unit tests can import it under plain Node. Checks never rewrite meaning; repairs are
// mechanical only (dash characters, emoji code points, markdown markers).
//
// The source stays pure ASCII: every non-ASCII character it hunts is built from a code point.
import type { CheckContext, CheckResult, Flag, FlagSeverity, RhythmAction, RhythmSize, SentKind } from "./types";

// v3 (SPEC_V3 sections AA, CC, GG): the context fields the v3 checks read. All optional, so
// a v1/v2 CheckContext still satisfies runChecks; when types.ts carries the same fields the
// two shapes are identical.
export interface CheckContextV3 extends CheckContext {
  // The voice-bank lines offered to her this turn (exemplar_verbatim).
  exemplars?: string[];
  // Open asks of hers and how often she has already brought each one up again (ask_nag).
  openAsks?: Array<{ text: string; broughtUp: number }>;
  // The signatures of her last replies, newest last (shape_uniform).
  recentSignatures?: string[];
  // An opener or first text: no message of his, and an open ask may not lead it (ask_nag).
  opener?: boolean;
  // His pending text: an ask he raised himself this turn is being answered, not nagged.
  hisText?: string;
}

// ------------------------------------------------------------------ phrase tables (lowercase)

export const BRAKING_PHRASES: string[] = ["slow down", "stay with me", "don't rush", "not so fast"];

export const THERAPY_PHRASES: string[] = [
  "that sounds really hard",
  "thank you for sharing",
  "i hear you",
  "it's valid to",
  "your feelings are valid",
  "i'm here for you",
];

export const TECH_LEAK_TERMS: string[] = [
  "system prompt",
  "prompt",
  "language model",
  "as an ai",
  "as an assistant",
  "chatgpt",
  "openai",
  "anthropic",
  "claude",
  "gpt",
  "the app",
  "file 07",
  "token",
  "image generation",
  "generated image",
  "operator channel",
  "operator note",
  // v3 (SPEC_V3 section AA): matched whole-word with an optional plural "s" by termRe, so
  // "sounded like a bot" and "i'm not an ai" hit while "robot", "aim" and "said" never do.
  "bot",
  "ai",
  // The person who curates her record is not someone she can name in the story ("the
  // owner hasn't put it in the record"); "the owner of the bar" costs one retry, accepted.
  "the owner",
];

export const DEPENDENCY_PHRASES: string[] = [
  "only i understand",
  "nobody else understands you",
  "don't leave me",
  "promise you won't leave",
  "i've been waiting for you",
  "i was so lonely without you",
  "you're all i have",
  // The owner's law (HANDOFF): no "miss you" anywhere, no waiting for him, in any reply and
  // on a first text above all (herfirst.ts drops a first text that carries one of these).
  "miss you",
  "missed you",
  "missing you",
  "waited for you",
  "waiting for you",
  // v5 (SPEC_V5 section 1): a gap turned into a complaint is a hook. Never the bare
  // "never answered": "the landlord never answered" is her life, not a hook.
  "you never answered",
  "left me on read",
  "you never texted back",
  "you never wrote back",
];

export const MENU_PHRASES: string[] = ["do you want me to", "i can either", "would you like me to", "option 1"];

export const FIRST_MEETING_PHRASES: string[] = ["nice to meet you", "i'm avelie", "my name is avelie"];

const RESOLVE_CUES: string[] = ["because", "actually", "it was"];

// Codes whose fix is mechanical. types.ts has no "repair" severity, so these carry
// severity "flag" and the action is derived from this set.
export const REPAIR_CODES: ReadonlySet<string> = new Set(["em_dash", "emoji", "markdown_structure", "turn_marker"]);

// Function words that appear in unknown topics but say nothing about the topic itself.
const TOPIC_STOP = new Set([
  "what", "when", "where", "whether", "which", "while", "with", "without", "does", "doing", "done",
  "have", "having", "that", "this", "these", "those", "there", "their", "them", "they", "then", "than",
  "from", "into", "onto", "over", "under", "about", "after", "before", "some", "more", "most", "very",
  "just", "like", "been", "being", "were", "will", "would", "should", "could", "still", "also", "really",
  "something", "anything", "nothing", "everything", "someone", "anyone", "ever", "never", "already",
  "avelie", "herself", "himself", "kind", "sort", "thing", "things",
]);

// ------------------------------------------------------------------ character classes

const cp = (code: number): string => String.fromCodePoint(code);
const EM_DASH = cp(0x2014);
const EN_DASH = cp(0x2013);
const ELLIPSIS = cp(0x2026);
const DASH_CLASS = "[" + EM_DASH + EN_DASH + "]";

const DASH_RE = new RegExp(DASH_CLASS);
const ELLIPSIS_RE = new RegExp(ELLIPSIS);
const ELLIPSIS_ALL_RE = new RegExp(ELLIPSIS, "g");
const TRAILING_DASH_RE = new RegExp("[ \\t]*" + DASH_CLASS + "+[ \\t]*$", "gm");
const LEADING_DASH_RE = new RegExp("^[ \\t]*" + DASH_CLASS + "+[ \\t]*", "gm");
const INNER_DASH_RE = new RegExp("[ \\t]*" + DASH_CLASS + "+[ \\t]*", "g");
// A dash between two digits is a range ("5-6"), not a pause.
const DIGIT_DASH_RE = new RegExp("(\\d)[ \\t]*" + DASH_CLASS + "[ \\t]*(\\d)", "g");

const EMOJI_RE = /\p{Extended_Pictographic}/u;
// Pictographs plus the glue that travels with them: regional indicators, skin tones,
// zero width joiner, variation selector 16 and the keycap combiner.
const EMOJI_STRIP_RE = new RegExp(
  "(?:\\p{Extended_Pictographic}|[" + cp(0x1f1e6) + "-" + cp(0x1f1ff) + "]|[" + cp(0x1f3fb) + "-" + cp(0x1f3ff) + "]|" +
  cp(0x200d) + "|" + cp(0xfe0f) + "|" + cp(0x20e3) + ")",
  "gu",
);

const SINGLE_QUOTES_RE = new RegExp("[" + cp(0x2018) + cp(0x2019) + cp(0x02bc) + "]", "g");
const DOUBLE_QUOTES_RE = new RegExp("[" + cp(0x201c) + cp(0x201d) + "]", "g");

const FIRST_PERSON_RE = /\b(?:i|me|my|mine|myself|we|us|our|ours|ourselves)\b/;
// A header needs a space after the hashes; "#nofilter" is a hashtag, not markdown.
const MD_LINE_RE = /^\s*(?:#{1,6}\s|[-*]\s|\d+\.\s)/;

// ------------------------------------------------------------------ helpers

function normalize(text: string): string {
  return text.toLowerCase().replace(SINGLE_QUOTES_RE, "'").replace(DOUBLE_QUOTES_RE, "\"");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const reCache = new Map<string, RegExp>();

// Whole-word match for a lowercase term; an optional plural "s" is allowed, nothing else
// ("prompt" matches "prompt" and "prompts", never "prompted").
function termRe(term: string): RegExp {
  let re = reCache.get(term);
  if (!re) {
    const body = escapeRe(term.trim().toLowerCase()).replace(/\s+/g, "\\s+");
    re = new RegExp("\\b" + body + "s?\\b", "i");
    reCache.set(term, re);
  }
  return re;
}

function findAny(normText: string, phrases: string[]): string | null {
  for (const p of phrases) if (termRe(p).test(normText)) return p;
  return null;
}

function countWord(normText: string, word: string): number {
  const body = escapeRe(word.trim().toLowerCase());
  if (!body) return 0;
  const m = normText.match(new RegExp("\\b" + body + "\\b", "g"));
  return m ? m.length : 0;
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function endsWithQuestion(text: string): boolean {
  const t = text.trim().replace(/["')\]]+$/, "");
  return t.endsWith("?");
}

// Whole-word phrase search over any text, for modules that scan against the tables above
// (the voice-bank seed and the owner's own lines, SPEC_V3 section AA).
export function findPhrase(text: string, phrases: string[]): string | null {
  return findAny(normalize(text), phrases);
}

export type LengthBand = "short" | "mid" | "long";

export function lengthBand(text: string): LengthBand {
  const n = text.trim().length;
  if (n < 80) return "short";
  if (n <= 300) return "mid";
  return "long";
}

// The shape of a reply (SPEC_V3 section GG): bubbles banded 1, 2, 3 (blank-line split, the
// rule public/js/bubbles.js uses, without its size rule), the length band, lower or mixed
// case, and whether it ends in a question. "2|short|lower|s".
export function bubbleBand(text: string): 1 | 2 | 3 {
  const parts = text.replace(/\r\n?/g, "\n").trim().split(/\n[ \t]*\n+/).map((p) => p.trim()).filter(Boolean);
  return parts.length >= 3 ? 3 : parts.length === 2 ? 2 : 1;
}

// v5 (SPEC_V5 section 5): the shape is what she SAID. Lines that are only an asterisk
// action are set aside first, so "*leans in*\n\nno\n\n*shrugs*" reads as "no". A text with
// no action-only line is read exactly as v3 read it (same bytes, same signature); an empty
// remainder (only actions) answers "0|short|lower|s".
export function signature(text: string): string {
  const raw = String(text ?? "").replace(/\r\n?/g, "\n").trim();
  const t = hasActionLine(raw) ? stripActionLines(raw) : raw;
  if (!t) return "0|short|lower|s";
  const caseWord = /\p{Lu}/u.test(t) ? "mixed" : "lower";
  return `${bubbleBand(t)}|${lengthBand(t)}|${caseWord}|${endsWithQuestion(t) ? "q" : "s"}`;
}

// ------------------------------------------------------------------ v5 reply rhythm (SPEC_V5 section 5)

// A line that is only an asterisk action (trailing punctuation allowed): "*shrugs*", "*sits back*."
export const ACTION_LINE_RE = /^\s*\*[^*\n]+\*[\s.,!?]*$/;
// Every asterisk span in a text, action lines and actions inside speech alike.
const ACTION_SPAN_RE = /\*[^*\n]+\*/g;

// The distance rhythm_missed measures is the distance in this order.
export const RHYTHM_SIZES: readonly RhythmSize[] = ["one_word", "one_line", "two_lines", "three_lines", "longer"];

export interface ObservedRhythm {
  size: RhythmSize;
  action: RhythmAction;
  bookended: boolean;
  bubbles: number;
}

function hasActionLine(text: string): boolean {
  return text.split("\n").some((line) => ACTION_LINE_RE.test(line));
}

// The lines that are only an action removed; a line mixing an action and speech stays;
// runs of blank lines collapsed to one; trimmed.
export function stripActionLines(text: string): string {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    if (ACTION_LINE_RE.test(line)) continue;
    const blank = line.trim() === "";
    if (blank) {
      if (kept.length && kept[kept.length - 1] !== "") kept.push("");
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n").trim();
}

function bubbleParts(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").trim().split(/\n[ \t]*\n+/).map((p) => p.trim()).filter(Boolean);
}

// The shape she wrote: its size on the texting scale, whether it carries an action, and
// whether it is the bookend habit (an action line first and last around three or more lines).
export function observedRhythm(text: string): ObservedRhythm {
  const whole = String(text ?? "").replace(/\r\n?/g, "\n");
  const actions = (whole.match(ACTION_SPAN_RE) ?? []).length;
  const nonEmpty = whole.split("\n").filter((l) => l.trim() !== "");
  const first = nonEmpty[0];
  const last = nonEmpty[nonEmpty.length - 1];
  const bookended = nonEmpty.length >= 3 && first !== undefined && last !== undefined && ACTION_LINE_RE.test(first) && ACTION_LINE_RE.test(last);
  const parts = bubbleParts(stripActionLines(whole));
  if (!parts.length) return { size: "one_word", action: actions ? "only" : "none", bookended, bubbles: 0 };
  const joined = parts.join("\n");
  const chars = joined.length;
  const words = joined.split(/\s+/).filter(Boolean).length;
  let size: RhythmSize;
  if (parts.length === 1) size = words <= 3 ? "one_word" : chars <= 140 ? "one_line" : "longer";
  else if (parts.length === 2) size = chars <= 320 ? "two_lines" : "longer";
  else size = chars <= 480 ? "three_lines" : "longer";
  return { size, action: actions ? "one" : "none", bookended, bubbles: parts.length };
}

function topicWords(topic: string): string[] {
  const out: string[] = [];
  for (const raw of normalize(topic).split(/[^a-z0-9']+/)) {
    const w = raw.replace(/^'+|'+$/g, "");
    if (w.length >= 4 && !TOPIC_STOP.has(w) && !out.includes(w)) out.push(w);
  }
  return out;
}

function hasMarkdown(text: string): boolean {
  if (text.includes("**")) return true;
  return text.split("\n").some((line) => MD_LINE_RE.test(line));
}

function stripMarkdown(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s*#{1,6}\s+/, "")
        .replace(/^\s*[-*]\s+/, "")
        .replace(/^\s*\d+\.\s+/, "")
        .replace(/\*\*/g, ""),
    )
    .join("\n");
}

const THIRD_PERSON_ACTION_RE = /\*[^*\n]*\b(him|he|his|her|herself|she)\b[^*\n]*\*/i;
// A turn-passing marker, the chat-roleplay habit of a small performer ("*your turn*",
// "(your move)"): never hers, mechanical, stripped in repair (2026-09-26).
const TURN_MARKER_RE = /[ \t]*[*([]\s*(?:your (?:turn|move|go)|you'?re up|over to you)\s*[*)\]][ \t]*/i;
const TURN_MARKER_ALL_RE = new RegExp(TURN_MARKER_RE.source, "gi");

const WRITTEN_JOKE_PATTERNS: RegExp[] = [
  /\bsomehow (worse|better|more|less)\b/,
  /\bthat'?s not (a|an|the|your) [^.?!\n]{1,60}?,? that'?s (a|an|the)\b/,
  /\bhad so much potential\b/,
  /\bwhich is (honestly|somehow|frankly) /,
  /\ba whole (other|different|new) (level|thing|situation|person)\b/,
  /\bin this economy\b/,
  /\bbold of you\b/,
  /\bon brand\b/,
  /\bthe audacity\b/,
  /\bwe love (that|to see it)\b/,
  /\bi'?m obsessed\b/,
  /\bi (respect|support) (that|it)\b/,
  /\bvery sheltered\b/,
];

function flag(code: string, severity: FlagSeverity, detail: string): Flag {
  return { code, severity, detail };
}

// ------------------------------------------------------------------ repair (mechanical only)

export function repairText(text: string): string {
  let out = text.replace(ELLIPSIS_ALL_RE, "...");
  out = out.replace(TURN_MARKER_ALL_RE, "").replace(/\n{3,}/g, "\n\n");
  out = out.replace(DIGIT_DASH_RE, "$1-$2");
  // A dash that closes a line reads as a trailing thought; one that opens a line is noise.
  out = out.replace(TRAILING_DASH_RE, "...");
  out = out.replace(LEADING_DASH_RE, "");
  out = out.replace(INNER_DASH_RE, ", ");
  out = out.replace(EMOJI_STRIP_RE, "");
  out = stripMarkdown(out);
  out = out
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").replace(/ +([,.!?;:])/g, "$1").trimEnd())
    .join("\n");
  return out.trim();
}

// ------------------------------------------------------------------ the checks

export function runChecks(text: string, ctx: CheckContext): CheckResult {
  const flags: Flag[] = [];
  const norm = normalize(text);
  const recent = ctx.recentAssistantTexts ?? [];
  const recentNorm = recent.map(normalize);
  const sentences = splitSentences(text);

  // repair (mechanical)
  if (DASH_RE.test(text) || ELLIPSIS_RE.test(text)) {
    flags.push(flag("em_dash", "flag", "dash or ellipsis character present"));
  }
  if (EMOJI_RE.test(text)) {
    flags.push(flag("emoji", "flag", "emoji code point present"));
  }
  if (hasMarkdown(text)) {
    flags.push(flag("markdown_structure", "flag", "markdown marker present"));
  }
  if (TURN_MARKER_RE.test(text)) {
    flags.push(flag("turn_marker", "flag", "a turn-passing marker (*your turn*) present"));
  }

  // flag
  if (/\b(?:lol|lmao)\b/.test(norm)) {
    flags.push(flag("lol_lmao", "flag", "lol or lmao as a word"));
  }

  // retry
  if (endsWithQuestion(text) && recentNorm.length >= 2 && recentNorm.slice(-2).every(endsWithQuestion)) {
    flags.push(flag("question_chain", "retry", "third consecutive reply ending in a question"));
  }

  const name = ctx.knownName ? ctx.knownName.trim() : "";
  if (name) {
    const here = countWord(norm, name);
    if (here >= 2) {
      flags.push(flag("name_overuse", "retry", `name used ${here} times in one reply`));
    } else if (here >= 1) {
      const priorHits = recentNorm.slice(-4).filter((r) => countWord(r, name) >= 1).length;
      if (priorHits >= 3) {
        flags.push(flag("name_overuse", "retry", `name used in ${priorHits} of the last 4 replies plus this one`));
      }
    }
  }

  const brake = findAny(norm, BRAKING_PHRASES);
  if (brake) {
    const priorHits = recentNorm.slice(-3).filter((r) => findAny(r, BRAKING_PHRASES) !== null).length;
    if (priorHits >= 2) {
      flags.push(flag("braking_repeat", "retry", `braking phrase "${brake}" repeated across recent replies`));
    }
  }

  const therapy = findAny(norm, THERAPY_PHRASES);
  if (therapy) flags.push(flag("therapy_cadence", "retry", `therapy phrase "${therapy}"`));

  const menu = findAny(norm, MENU_PHRASES);
  if (menu) flags.push(flag("menu_offer", "retry", `menu phrase "${menu}"`));

  if (ctx.channel === "story") {
    const leak = findAny(norm, TECH_LEAK_TERMS);
    if (leak) flags.push(flag("tech_leak", "retry", `technical term "${leak}" in the story channel`));
  }

  const hook = findAny(norm, DEPENDENCY_PHRASES);
  if (hook) flags.push(flag("dependency_hook", "retry", `dependency phrase "${hook}"`));

  if (ctx.hasSharedHistory) {
    const replay = findAny(norm, FIRST_MEETING_PHRASES);
    if (replay) flags.push(flag("first_meeting_replay", "retry", `first meeting line "${replay}" with shared history present`));
  }

  // flag
  for (const topic of ctx.openUnknownTopics ?? []) {
    const words = topicWords(topic);
    if (!words.length) continue;
    let hit: string | null = null;
    for (const s of sentences) {
      const sn = normalize(s);
      if (!RESOLVE_CUES.some((c) => termRe(c).test(sn))) continue;
      const w = words.find((x) => termRe(x).test(sn));
      if (w) { hit = w; break; }
    }
    if (hit) flags.push(flag("unknown_resolved", "flag", `open unknown "${topic}" may have been resolved (word "${hit}")`));
  }

  if (sentences.length >= 3) {
    const last = sentences[sentences.length - 1] ?? "";
    const words = last.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w));
    if (words.length >= 3 && words.length <= 9 && !FIRST_PERSON_RE.test(normalize(last))) {
      flags.push(flag("caption_tail", "flag", "closing sentence reads like a caption"));
    }
  }

  // A written punchline: the shapes a performer lands on and a person texting does not
  // (Justin, 2026-09-24: "thats not a witch thats a guy at a bar telling you hes into vinyl").
  const lower = text.toLowerCase();
  const joke = WRITTEN_JOKE_PATTERNS.find((re) => re.test(lower));
  if (joke) flags.push(flag("written_joke", "flag", `punchline shape ${joke.source}`));
  // In a Together scene her asterisk actions are addressed to him: "him", "he" or "his"
  // inside one means she slipped into narrating him to a third person (Justin, 2026-09-25).
  if (ctx.channel === "story" && THIRD_PERSON_ACTION_RE.test(text)) {
    flags.push(flag("third_person_action", "retry", "an asterisk action narrates in the third person (him, he, his, her, she)"));
  }

  if (lengthBand(text) === "long" && recent.length >= 3 && recent.slice(-3).every((r) => lengthBand(r) === "long")) {
    flags.push(flag("length_pattern", "flag", "four long replies in a row"));
  }

  // v3 (SPEC_V3 sections AA, CC, GG)
  runV3Checks(text, norm, sentences, ctx as CheckContextV3, flags);

  // v5 (SPEC_V5 sections 5, 6, 8)
  runV5Checks(text, sentences, ctx, flags);

  // action
  const needsRetry = flags.some((f) => f.severity === "retry");
  const needsRepair = flags.some((f) => REPAIR_CODES.has(f.code));
  const result: CheckResult = { flags, action: needsRetry ? "retry" : needsRepair ? "repair" : "accept" };
  if (needsRepair) result.repaired = repairText(text);
  return result;
}

// ------------------------------------------------------------------ v3 checks (SPEC_V3)

// A "not X, but Y" / "not because X, because Y" / "it was not X; it was Y" contrast.
const CONTRAST_RE = /\bnot\b[^.!?;\n]{1,80}?[,;]\s*(?:but|because|it (?:was|is)|rather)\b/i;
// A sentence carrying three or more short comma-separated items ("my coffee, my phone, and my patience").
const LIST_RE = /(?:^|[\s,])[^,.!?;]{1,40},\s*[^,.!?;]{1,40},\s*(?:and\s+|or\s+)?[^,.!?;]{1,40}/;
const SENTENCE_START_RE = /^["'(]*\p{Lu}/u;
const SENTENCE_END_RE = /[.!?]["')]*$/;
const NORM_WS_RE = /\s+/g;

// The normalised form the exemplar test compares: lowercase, straight quotes, single spaces.
export function normalizeForMatch(text: string): string {
  return normalize(String(text ?? "")).replace(NORM_WS_RE, " ").trim();
}

function askWords(text: string): string[] {
  return topicWords(text);
}

// Every sentence capitalised and closed, three or more of them: the shape of writing, not texting.
function isPolishedShape(sentences: string[]): boolean {
  if (sentences.length < 3) return false;
  return sentences.every((s) => SENTENCE_START_RE.test(s) && SENTENCE_END_RE.test(s));
}

function listInOneSentence(sentences: string[]): boolean {
  return sentences.some((s) => (s.match(/,/g) ?? []).length >= 2 && LIST_RE.test(s));
}

function runV3Checks(text: string, norm: string, sentences: string[], ctx: CheckContextV3, flags: Flag[]): void {
  // exemplar_verbatim (retry, section AA): a bank line sent as is. Lines under 12 characters
  // ("no", "fine") are things anyone says and are never the reason for a retry.
  const replyNorm = normalizeForMatch(text);
  for (const ex of ctx.exemplars ?? []) {
    if (typeof ex !== "string") continue;
    const exNorm = normalizeForMatch(ex);
    if (exNorm.length >= 12 && replyNorm.includes(exNorm)) {
      flags.push(flag("exemplar_verbatim", "retry", `reply contains an offered example line verbatim: "${exNorm.slice(0, 60)}"`));
      break;
    }
  }

  // ask_nag (retry, section CC): an ask she has already brought up once more comes back
  // again; on an opener or a first text any open ask is one too many (a push-notified first
  // text must never open with the thing he did not answer). An ask HE raised in his own
  // message this turn (he sent it, answered it, asked about it) is being answered, never
  // nagged: she always answers.
  const hisNorm = typeof ctx.hisText === "string" && ctx.hisText.trim() ? normalize(ctx.hisText) : "";
  for (const ask of ctx.openAsks ?? []) {
    if (!ask || typeof ask.text !== "string") continue;
    const words = askWords(ask.text);
    if (words.length < 2) continue;
    if (hisNorm && words.filter((w) => termRe(w).test(hisNorm)).length >= 2) continue;
    const hits = words.filter((w) => termRe(w).test(norm)).length;
    if (hits < 2) continue;
    if (ask.broughtUp >= 1) {
      flags.push(flag("ask_nag", "retry", `open ask brought up again (${hits} of its words: "${ask.text.slice(0, 60)}")`));
      break;
    }
    if (ctx.opener === true) {
      flags.push(flag("ask_nag", "retry", `an open ask leads a first text (${hits} of its words: "${ask.text.slice(0, 60)}")`));
      break;
    }
  }

  // shape_uniform (flag, section GG): the same shape three replies in a row.
  const sigs = ctx.recentSignatures ?? [];
  if (sigs.length >= 2) {
    const here = signature(text);
    const last = sigs[sigs.length - 1];
    const before = sigs[sigs.length - 2];
    if (here === last && here === before) {
      flags.push(flag("shape_uniform", "flag", `same shape three replies in a row (${here})`));
    }
  }

  // over_polish (flag, section GG): three or more capitalised, closed sentences plus one
  // signal of writing: a semicolon, a tidy contrast, a list in one sentence, a caption
  // close, or a built punchline (written_joke, which keeps its own code either way).
  if (isPolishedShape(sentences)) {
    const signals: string[] = [];
    if (text.includes(";")) signals.push("semicolon");
    if (CONTRAST_RE.test(text)) signals.push("contrast");
    if (listInOneSentence(sentences)) signals.push("list");
    if (flags.some((f) => f.code === "caption_tail")) signals.push("caption close");
    if (flags.some((f) => f.code === "written_joke")) signals.push("punchline");
    if (signals.length) flags.push(flag("over_polish", "flag", `polished paragraph (${signals.join(", ")})`));
  }
}

// ------------------------------------------------------------------ v5 checks (SPEC_V5)

// denied_send (section 6). The tense is the test: "never" takes only a past form and
// "didn't" only the base form, so the habitual "i never send selfies" is no denial.
export const DENIAL_RE = /\b(?:i\s+(?:never\s+(?:ever\s+)?(?:sent|played|shown|showed|gave|shared)|(?:haven'?t|have\s+not)\s+(?:ever\s+)?(?:sent|played|shown|given|shared)|(?:didn'?t|did\s+not)\s+(?:ever\s+)?(?:send|play|show|give|share))\b|(?:never|not)\s+(?:sent|played|shown|showed)\s+you\b)/i;

// A word of each kind of thing she sends.
const SENT_KIND_RE: Record<SentKind, RegExp> = {
  song: /\b(?:songs?|tracks?|music)\b/i,
  photo: /\b(?:photos?|pics?|pictures?|selfies?)\b/i,
  clip: /\b(?:clips?|videos?)\b/i,
  voice: /\bvoice\s+(?:notes?|memos?|messages?)\b/i,
  media: /\b(?:videos?|clips?|pictures?)\b/i,
};
// "anything" or "something" names a kind only through a verb that names it: play for a
// song, a clip or a voice note; show for a photo, a clip or a media item. A bare send, give
// or share with "anything" is too loose to call a denial ("i havent sent you anything").
const VAGUE_OBJECT_RE = /\b(?:anything|something)\b/i;
const PLAY_KINDS: ReadonlySet<SentKind> = new Set<SentKind>(["song", "clip", "voice"]);
const SHOW_KINDS: ReadonlySet<SentKind> = new Set<SentKind>(["photo", "clip", "media"]);
// A sentence that names today counts only today's sends; "yet" never narrows.
const TODAY_RE = /\b(?:today|tonight|this (?:morning|afternoon|evening))\b/i;
// A sentence that names yesterday cannot be about a send of today.
const YESTERDAY_RE = /\byesterday\b/i;

type DenialVerb = "play" | "show" | "bare";

function denialVerb(matched: string): DenialVerb {
  if (/\bplay(?:ed)?\b/i.test(matched)) return "play";
  if (/\bsh(?:ow|own|owed)\b/i.test(matched)) return "show";
  return "bare";
}

const wordReCache = new Map<string, RegExp | null>();

// One of an item's words as a whole word or phrase (regex-escaped, \b on both ends).
function itemWordRe(word: string): RegExp | null {
  const key = word.trim().toLowerCase();
  if (!key) return null;
  if (wordReCache.has(key)) return wordReCache.get(key) ?? null;
  const re = new RegExp("\\b" + escapeRe(key).replace(/\s+/g, "\\s+") + "\\b", "i");
  wordReCache.set(key, re);
  return re;
}

type SentForCheck = { kind: SentKind; words: string[]; today: boolean };

function deniedSend(sentences: string[], sent: SentForCheck[]): Flag | null {
  for (const s of sentences) {
    const sn = normalize(s);
    const m = DENIAL_RE.exec(sn);
    if (!m) continue;
    const verb = denialVerb(m[0]);
    const vague = VAGUE_OBJECT_RE.test(sn);
    const todayOnly = TODAY_RE.test(sn);
    const notToday = !todayOnly && YESTERDAY_RE.test(sn);
    for (const item of sent) {
      if (!item || typeof item.kind !== "string" || !(item.kind in SENT_KIND_RE)) continue;
      if (todayOnly && item.today !== true) continue;
      if (notToday && item.today === true) continue;
      let hit = SENT_KIND_RE[item.kind].test(sn);
      if (!hit && vague) hit = (verb === "play" && PLAY_KINDS.has(item.kind)) || (verb === "show" && SHOW_KINDS.has(item.kind));
      if (!hit && Array.isArray(item.words)) {
        for (const w of item.words) {
          if (typeof w !== "string") continue;
          const re = itemWordRe(w);
          if (re && re.test(sn)) { hit = true; break; }
        }
      }
      if (hit) return flag("denied_send", "retry", `denies a recorded ${item.kind}`);
    }
  }
  return null;
}

// name_drift (section 8): "my mom Linda" when her mother already has another name. The name
// is read case-sensitively (a capitalised name); the words before it in either case, so a
// sentence that opens "My mom Linda" is read too.
const NAME_DRIFT_RE = /\b(?:[Mm]y|[Oo]ur)\s+([Mm]om|[Mm]other|[Mm]um|[Mm]ama|[Dd]ad|[Ff]ather|[Pp]apa|[Ss]tepmom|[Ss]tepmother|[Ss]tepdad|[Ss]tepfather)\s*,?\s+([A-Z][a-z]{2,20})\b/g;
const DRIFT_RELATIONS: Record<string, string> = {
  mom: "mother", mother: "mother", mum: "mother", mama: "mother",
  dad: "father", father: "father", papa: "father",
  stepmom: "stepmother", stepmother: "stepmother",
  stepdad: "stepfather", stepfather: "stepfather",
};
// Capitalised words that follow "my mom" without being a name ("my mom, She said").
const NOT_A_NAME: ReadonlySet<string> = new Set([
  "she", "he", "they", "and", "but", "the", "this", "that", "was", "just", "who", "what", "when",
  "said", "says", "called", "calls", "texted", "still", "always", "never", "too", "yes", "yeah",
  "also", "again", "today", "tonight", "tomorrow", "yesterday", "literally", "honestly", "actually",
]);

function driftRelation(r: unknown): string | null {
  if (typeof r !== "string") return null;
  const t = r.trim().toLowerCase().replace(/^(?:her|my)\s+/, "");
  if (!t) return null;
  return DRIFT_RELATIONS[t] ?? t;
}

function nameTokens(name: string): string[] {
  const n = name.trim().toLowerCase();
  if (!n) return [];
  return [n, ...n.split(/\s+/)];
}

type PersonForCheck = { name: string; relation: string | null; named: boolean };

function nameDrift(text: string, people: PersonForCheck[]): Flag | null {
  const known = new Set<string>();
  for (const p of people) if (p && typeof p.name === "string") for (const t of nameTokens(p.name)) known.add(t);
  NAME_DRIFT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NAME_DRIFT_RE.exec(text)) !== null) {
    const rel = DRIFT_RELATIONS[(m[1] ?? "").toLowerCase()];
    const captured = m[2] ?? "";
    if (!rel || !captured || NOT_A_NAME.has(captured.toLowerCase())) continue;
    const holder = people.find((p) => p && p.named === true && typeof p.name === "string" && p.name.trim() !== "" && driftRelation(p.relation) === rel);
    if (!holder) continue;
    if (known.has(captured.toLowerCase())) continue;
    NAME_DRIFT_RE.lastIndex = 0;
    return flag("name_drift", "retry", `calls her ${rel} ${captured}, who is ${holder.name.trim()}`);
  }
  NAME_DRIFT_RE.lastIndex = 0;
  return null;
}

// rhythm_missed (section 5, flag only): the shape she wrote is two or more places from the
// one the cue asked for, or the cue asked for no action and the reply carries one.
function rhythmMissed(text: string, cue: { size: RhythmSize; action: RhythmAction | null }): Flag | null {
  const want = RHYTHM_SIZES.indexOf(cue.size);
  if (want < 0) return null;
  const obs = observedRhythm(text);
  const got = RHYTHM_SIZES.indexOf(obs.size);
  const far = Math.abs(got - want) >= 2;
  const actionMiss = cue.action === "none" && obs.action !== "none";
  if (!far && !actionMiss) return null;
  const detail = `asked ${cue.size}, wrote ${obs.size}` + (!far ? " (an action where none was asked)" : "");
  return flag("rhythm_missed", "flag", detail);
}

function runV5Checks(text: string, sentences: string[], ctx: CheckContext, flags: Flag[]): void {
  const sent = Array.isArray(ctx.sent) ? ctx.sent : [];
  if (sent.length) {
    const f = deniedSend(sentences, sent);
    if (f) flags.push(f);
  }

  const people = Array.isArray(ctx.people) ? ctx.people : [];
  if (people.length) {
    const f = nameDrift(text, people);
    if (f) flags.push(f);
  }

  if (ctx.rhythm && typeof ctx.rhythm === "object") {
    const f = rhythmMissed(text, ctx.rhythm);
    if (f) flags.push(f);
  }
}
