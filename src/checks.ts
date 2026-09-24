// Post-generation checks (the Archivist). Pure: no D1, no env, no imports beyond types,
// so unit tests can import it under plain Node. Checks never rewrite meaning; repairs are
// mechanical only (dash characters, emoji code points, markdown markers).
//
// The source stays pure ASCII: every non-ASCII character it hunts is built from a code point.
import type { CheckContext, CheckResult, Flag, FlagSeverity } from "./types";

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
];

export const DEPENDENCY_PHRASES: string[] = [
  "only i understand",
  "nobody else understands you",
  "don't leave me",
  "promise you won't leave",
  "i've been waiting for you",
  "i was so lonely without you",
  "you're all i have",
];

export const MENU_PHRASES: string[] = ["do you want me to", "i can either", "would you like me to", "option 1"];

export const FIRST_MEETING_PHRASES: string[] = ["nice to meet you", "i'm avelie", "my name is avelie"];

const RESOLVE_CUES: string[] = ["because", "actually", "it was"];

// Codes whose fix is mechanical. types.ts has no "repair" severity, so these carry
// severity "flag" and the action is derived from this set.
export const REPAIR_CODES: ReadonlySet<string> = new Set(["em_dash", "emoji", "markdown_structure"]);

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

export function signature(text: string): string {
  const t = String(text ?? "").replace(/\r\n?/g, "\n").trim();
  const caseWord = /\p{Lu}/u.test(t) ? "mixed" : "lower";
  return `${bubbleBand(t)}|${lengthBand(t)}|${caseWord}|${endsWithQuestion(t) ? "q" : "s"}`;
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

  if (lengthBand(text) === "long" && recent.length >= 3 && recent.slice(-3).every((r) => lengthBand(r) === "long")) {
    flags.push(flag("length_pattern", "flag", "four long replies in a row"));
  }

  // v3 (SPEC_V3 sections AA, CC, GG)
  runV3Checks(text, norm, sentences, ctx as CheckContextV3, flags);

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

  // ask_nag (retry, section CC): an ask she has already brought up once more comes back again.
  for (const ask of ctx.openAsks ?? []) {
    if (!ask || typeof ask.text !== "string" || !(ask.broughtUp >= 1)) continue;
    const words = askWords(ask.text);
    const hits = words.filter((w) => termRe(w).test(norm)).length;
    if (words.length >= 2 && hits >= 2) {
      flags.push(flag("ask_nag", "retry", `open ask brought up again (${hits} of its words: "${ask.text.slice(0, 60)}")`));
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
