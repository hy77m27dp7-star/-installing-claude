// Post-generation checks (the Archivist). Pure: no D1, no env, no imports beyond types,
// so unit tests can import it under plain Node. Checks never rewrite meaning; repairs are
// mechanical only (dash characters, emoji code points, markdown markers).
//
// The source stays pure ASCII: every non-ASCII character it hunts is built from a code point.
import type { CheckContext, CheckResult, Flag, FlagSeverity } from "./types";

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

export type LengthBand = "short" | "mid" | "long";

export function lengthBand(text: string): LengthBand {
  const n = text.trim().length;
  if (n < 80) return "short";
  if (n <= 300) return "mid";
  return "long";
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

  // action
  const needsRetry = flags.some((f) => f.severity === "retry");
  const needsRepair = flags.some((f) => REPAIR_CODES.has(f.code));
  const result: CheckResult = { flags, action: needsRetry ? "retry" : needsRepair ? "repair" : "accept" };
  if (needsRepair) result.repaired = repairText(text);
  return result;
}
