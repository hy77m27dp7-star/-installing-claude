// Dirty talk mode (2026-09-27): her reply as she says it out loud. Justin: "her voice while
// were fucking also narrating what shes doing". Speech stays as she wrote it; an asterisk
// action becomes a first-person line ("*pulls you closer*" -> "I pull you closer."), so the
// narration is hers, not a stage direction read by someone else. Markers ([photo: ...] and
// the like) are never spoken. Pure: the unit suite checks it without a network.

const MARKER_LINE_RE = /^\s*\[[a-z]+(?::[^\]]*)?\]\s*$/i;
const INLINE_MARKER_RE = /\[(?:photo|clip|song|voice|video)(?::[^\]]*)?\]/gi;

const IRREGULAR: Record<string, string> = {
  "is": "am", "has": "have", "does": "do", "doesn't": "don't", "doesnt": "dont", "isn't": "am not", "isnt": "am not",
  "goes": "go", "lies": "lie", "dies": "die", "ties": "tie", "was": "was",
};

// A third-person verb to the first person: pulls -> pull, pushes -> push, kisses -> kiss,
// tries -> try, reaches -> reach. A word that does not look like one is left alone.
export function firstPersonVerb(word: string): string {
  const lower = word.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(IRREGULAR, lower)) return IRREGULAR[lower]!;
  if (!/^[a-z']+$/.test(lower) || lower.length < 3 || !lower.endsWith("s") || lower.endsWith("ss") || lower.endsWith("us")) return word;
  if (/(ches|shes|sses|xes|zes|oes)$/.test(lower)) return word.slice(0, -2);
  if (/[^aeiou]ies$/.test(lower)) return word.slice(0, -3) + "y";
  return word.slice(0, -1);
}

// One clause of an action: its first verb (after one leading adverb in -ly) in the first person.
function clause(text: string): string {
  const words = text.trim().split(/\s+/);
  if (!words.length || !words[0]) return "";
  let i = 0;
  if (words.length > 1 && /ly$/i.test(words[0]!) && !/^(only|early|daily)$/i.test(words[0]!)) i = 1;
  words[i] = firstPersonVerb(words[i]!);
  return words.join(" ");
}

// "*laughs into your shirt, doesn't move*" -> "I laugh into your shirt, don't move."
export function narrateAction(action: string): string {
  const t = String(action ?? "").replace(/\s+/g, " ").trim().replace(/[.!?,;:]+$/, "");
  if (!t) return "";
  if (/^(i|i'm|im|my)\b/i.test(t)) return t.charAt(0).toUpperCase() + t.slice(1) + ".";
  const parts = t.split(/,\s+|\s+and\s+(?=[a-z']+s\b)/i).map(clause).filter(Boolean);
  if (!parts.length) return "";
  return "I " + parts.join(", ") + ".";
}

// The whole reply as speech: actions narrated (or dropped when narration is off), speech as
// written, markers removed, one line. An action-only reply with narration off says nothing.
export function spokenText(reply: string, narrate: boolean, opts: { tags?: boolean } = {}): string {
  const lines = String(reply ?? "").split(/\r?\n/).filter((l) => !MARKER_LINE_RE.test(l));
  const text = lines.join("\n").replace(INLINE_MARKER_RE, " ");
  const out: string[] = [];
  const re = /\*([^*\n]+)\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const speech = (s: string) => {
    const t = s.replace(/\s+/g, " ").trim();
    if (t) out.push(t);
  };
  while ((m = re.exec(text)) !== null) {
    speech(text.slice(last, m.index));
    if (narrate) {
      const n = narrateAction(m[1] ?? "");
      if (n) out.push(opts.tags ? "[whispers] " + n : n);
    }
    last = m.index + m[0].length;
  }
  speech(text.slice(last).replace(/\*/g, ""));
  return out.join(" ").replace(/\s+/g, " ").trim();
}
