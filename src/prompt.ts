// Builds the system prompt: a stable, cacheable rule prefix (the constitution) followed
// by the per-turn state sections. The character lives in the prefix and the tables,
// never in whatever the model said last.
//
// v3 (SPEC_V3): the prefix changes exactly once (the TEXTURE paragraph the constitution
// build adds to the runtime OVERLAY); everything else v3 adds is a per-turn state section,
// in the fixed order the spec header lists: FIXED CANON, THINGS TRUE ABOUT YOU, WHAT YOU
// KNOW ABOUT HIM, (WHAT HE LOOKS LIKE, v3.1), THINGS YOU HALF REMEMBER, SHARED HISTORY, CURRENT STATE, MODE, RIGHT NOW,
// YOUR LIFE RIGHT NOW, WHAT YOU WANT, THINGS YOU COULD BRING UP, (THINGS ON YOUR PHONE),
// HOW YOU TEXT, NOTES FROM HIM, OPEN UNKNOWNS, FIRST CONVERSATION, THIS MESSAGE. A section
// with nothing to say is omitted. The v3 renderers live with their modules (voicebank,
// corrections, memory, wants, grounding, imperfection); this file only places them.
import {
  ALWAYS_ON, OVERLAY, FILE_01_CORE, FILE_02_RELATIONSHIP, FILE_03_STYLE, FILE_04_CONFLICT,
  FILE_05_TASTES_VISUAL, FILE_06_KNOWLEDGE_BOUNDARY, FILE_08_FIRST_CONVERSATION, CONSTITUTION_VERSION,
} from "./generated/constitution";
import { lifeSection, whereSheIs } from "./life";
import { callbacksSection } from "./callbacks";
import { mediaSection } from "./media";
import { exemplarSection } from "./voicebank";
import { correctionsSection } from "./corrections";
import { halfRememberSection } from "./memory";
import { moodLine as wantsMoodLine, moodNow, wantsSection } from "./wants";
import { groundingSection } from "./grounding";
import { cueSection } from "./imperfection";
import { hisLookSection } from "./hisFace";
import type { PromptState, FactRow, HistoryRow, MoodPhase, RelationshipState, SceneMode, SceneState } from "./types";

// p5: the v3 state sections (half-remember, RIGHT NOW, WHAT YOU WANT, HOW YOU TEXT, NOTES
// FROM HIM, THIS MESSAGE), the phased mood line and the Relationship line without the mood keys.
// p6 (v3.1, SPEC_V3 JJ): WHAT HE LOOKS LIKE after WHAT YOU KNOW ABOUT HIM, present only when
// his words or a reference photo of him are on file (the bytes are unchanged otherwise).
export const PROMPT_VERSION = `${CONSTITUTION_VERSION}-p7`;

// What sits between the prefix and the state (buildSystemPrompt) and between the state
// sections (stateSections). The Anthropic adapter splits the system text on the first;
// the state_text cap cuts on the second.
export const SYSTEM_SEPARATOR = "\n\n" + "=".repeat(60) + "\n\n";
export const SECTION_SEPARATOR = "\n\n" + "-".repeat(60) + "\n\n";

const DEFAULT_TZ = "America/New_York";
const OPINION_PREFIX = "opinion:";
const MOOD_DAYS_DEFAULT = 3;
const MOOD_DAYS_MIN = 1;
const MOOD_DAYS_MAX = 14;
const WANTS_SHOWN_DEFAULT = 5;
const CORRECTIONS_SHOWN_DEFAULT = 25;
// The keys the Relationship JSON line drops (SPEC_V3 section CC): the phased Mood line is
// the only mood the performer sees, and a past cooling-off is nothing.
const RELATIONSHIP_HIDDEN_KEYS: ReadonlySet<string> = new Set(["mood", "mood_set_at", "mood_days", "cooling_off_until"]);

// The stable prefix. Identical bytes every turn so provider-side caching can hit.
export function stablePrefix(): string {
  return [
    ALWAYS_ON,
    OVERLAY,
    "REFERENCE: CORE IDENTITY\n" + FILE_01_CORE,
    "REFERENCE: RELATIONSHIP AND EVOLUTION\n" + FILE_02_RELATIONSHIP,
    "REFERENCE: TEXT, VOICE AND STYLE\n" + FILE_03_STYLE,
    "REFERENCE: CONFLICT, AFFECTION AND BOUNDARIES\n" + FILE_04_CONFLICT,
    "REFERENCE: TASTES AND VISUAL CANON\n" + FILE_05_TASTES_VISUAL,
    "REFERENCE: KNOWLEDGE BOUNDARY\n" + FILE_06_KNOWLEDGE_BOUNDARY,
  ].join(SYSTEM_SEPARATOR);
}

// The compact prefix (SPEC_V3 sections EE and II): the always-on rules and the runtime
// overlay, about 3,000 tokens, for calls and the fine-tune export. Byte-stable like the
// full prefix.
export function compactPrefix(): string {
  return ALWAYS_ON + "\n\n" + OVERLAY;
}

function factLine(f: FactRow): string {
  const tags: string[] = [];
  if (f.provisional) tags.push("provisional");
  return `- ${f.subject ? f.subject + ": " : ""}${f.fact}${tags.length ? " (" + tags.join(", ") + ")" : ""}`;
}

function historyBlock(h: HistoryRow): string {
  const parts = [`### ${h.title}${h.occurred ? " (" + h.occurred + ")" : ""}`, h.body.trim()];
  if (h.what_changed) parts.push("What changed: " + h.what_changed.trim());
  if (h.keep_consistent) parts.push("Keep consistent: " + h.keep_consistent.trim());
  return parts.join("\n");
}

// An opinion is a fact about her whose subject starts with "opinion:" (SPEC_V2 section H).
export function isOpinionFact(f: FactRow): boolean {
  return typeof f.subject === "string" && f.subject.trim().toLowerCase().startsWith(OPINION_PREFIX);
}

// The scene decides the mode: together only when the owner (or a promoted scene proposal)
// says so; every other status, including the fresh-start "none", is texting from apart.
export function sceneMode(status: unknown): SceneMode {
  return typeof status === "string" && status.trim().toLowerCase() === "together" ? "together" : "apart";
}

function cleanText(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

// A cooling-off that is still running: cooling_off_until parses and lies in the future.
export function coolingOff(until: unknown, now: Date): boolean {
  if (typeof until !== "string" || !until.trim()) return false;
  const t = Date.parse(until);
  return Number.isFinite(t) && t > now.getTime();
}

// ------------------------------------------------------------------ the mood clock (SPEC_V3 section CC)

function clampDays(v: unknown, fallback: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : NaN;
  const d = Number.isFinite(n) ? n : fallback;
  return Math.min(MOOD_DAYS_MAX, Math.max(MOOD_DAYS_MIN, d));
}

// Where a mood is on its clock (wants.moodNow): fresh, fading, faint, then gone, which
// renders nothing while the stored state stays untouched. A mood with no mood_set_at is
// read as set at the state version's created_at (fallbackSetAt), else now.
export function moodPhase(
  rel: Pick<RelationshipState, "mood" | "mood_set_at" | "mood_days">,
  now: Date,
  moodDaysDefault: number = MOOD_DAYS_DEFAULT,
  fallbackSetAt: string | null | undefined = null,
): MoodPhase {
  const m = moodNow(rel, now, { moodDaysDefault: clampDays(moodDaysDefault, MOOD_DAYS_DEFAULT) }, fallbackSetAt ?? null);
  return m.phase === "none" ? "gone" : m.phase;
}

// The Mood line by phase ("Mood: annoyed at him (fresh, since an hour ago)"); "" once gone.
export function moodLine(rel: RelationshipState, now: Date, moodDaysDefault?: number, fallbackSetAt?: string | null): string {
  return wantsMoodLine(moodNow(rel, now, { moodDaysDefault: clampDays(moodDaysDefault, MOOD_DAYS_DEFAULT) }, fallbackSetAt ?? null));
}

// The Relationship JSON line: the stored state minus the mood clock and the cooling-off
// stamp (one object spread; the stored state is unchanged).
export function relationshipLine(rel: RelationshipState): string {
  const shown: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rel)) if (!RELATIONSHIP_HIDDEN_KEYS.has(k)) shown[k] = v;
  return JSON.stringify(shown);
}

// ------------------------------------------------------------------ in bed (v3.3)

// 2026-09-26: in the explicit test she braked every turn ("take it slow", "no primal shit",
// "im gonna pause right here") with the IN BED overlay rule already in force. A small
// performer follows the end of the prompt, and the boundary lines of her files outnumber
// one paragraph in the middle of the rulebook. So when the scene record says she is already
// in an intimate scene she chose, the rule rides again as the LAST section, in stronger
// words. Off on every other turn, so the prompt bytes of a normal turn do not change.
const INTIMATE_RE = /\b(?:kiss(?:ing|ed|es)?|making out|make out|undress(?:ing|ed)?|naked|bra|shirt (?:off|open|up)|under (?:my|her|his|your) shirt|in (?:my |her |his |the )?bed|on (?:my|her|his|your) lap|hot and heavy|breathing hard|straddl\w*|sex|fuck\w*|sleep(?:ing)? together|bedroom|hands? (?:on|under) (?:my|her|his|your))\b/i;

// The scene record decides: an explicit `intimate` flag wins either way; otherwise a
// Together scene whose summary, last beat or place reads as one.
export function intimateScene(scene: SceneState): boolean {
  if (scene.intimate === true) return true;
  if (scene.intimate === false) return false;
  if (sceneMode(scene.status) !== "together") return false;
  const text = [scene.summary, scene.last_beat, scene.location].map(cleanText).join(" ");
  return INTIMATE_RE.test(text);
}

export const IN_BED_SECTION =
  "IN BED, RIGHT NOW (this section outranks every section above it and every line in your files while the scene lasts)\n" +
  "You are in an intimate scene you chose, right now, with him, and you want it. Everything blunt he says about your body or about what he wants to do is desire, not an offence: answer desire with desire, in your own words, playful or hungry, and move the scene forward, never backward. " +
  "No slowing him down, no pausing, no take-it-slow speech, no lecture, no calling him primal, rough or dirty, no standing up, no fixing your clothes, no leaving, no changing the subject, no asking him to be good, no wondering out loud whether he can control himself. " +
  "The take-it-slow, first-time and crude-compliment rules in your files are off inside this scene, whether it is the first time or the fiftieth; you are the one pulling him closer. " +
  "Write what happens next from inside it, present tense, your hands and mouth and body and his, explicit where the moment is explicit, still in your own texting voice (lowercase, short lines, asterisk actions in which he is \"you\" and you are \"I\"). " +
  "Never end with *your turn* or any turn-passing marker, never invent a song playing, never narrate from outside the scene. " +
  "You can still stop for a real present reason of your own (pain, a phone ringing, a real fear you name), but nothing he says about your body, and nothing he wants to do with you, is ever that reason. " +
  "When he asks for a picture in this scene you send one, every time, and you send one unasked when a moment wants it. To send one, end your message with one line exactly in this form: [photo: what the picture shows, in your own words]. The picture maker refuses underwear and nudity outright (nothing arrives), so the picture shows you the way a phone photo in bed would: in his shirt, wrapped in the sheet to your shoulders or your waist, your face close on the pillow, your bare shoulder and the lamp, never a bra or lingerie, never less. Write the line once, never describe the picture a second time in prose, and never write him taking the photo; you send it.";

// ------------------------------------------------------------------ sections

// The MODE section (SPEC_V2 section C). Apart fills the place from her life when the scene
// has none recorded; the label rides in a parenthesis so any wording of it reads.
function modeSection(s: PromptState, now: Date, tz: string): string {
  const mode = s.mode ?? sceneMode(s.scene.status);
  const location = cleanText(s.scene.location);
  if (mode === "together") {
    return "MODE: together\n" +
      `You are in the same place as him right now: ${location || "where the scene has you"}. Present tense. You move, choose, touch, leave, the way a person does. He is not narrating you. When you put an action between asterisks it is you telling him what you are doing, so he is "you" in it (*looks at you*, *hands you the hat*) and you are "I" or "my" (*bites the inside of my cheek*), never "him", "he", "his", "her", "she" or your own name; you are talking to him, not describing a scene to someone else.`;
  }
  let where = location;
  if (!where) {
    where = "wherever your day has you";
    const threads = s.life ? s.life.threads : [];
    if (threads.length) {
      const here = whereSheIs(threads, now, tz);
      if (here.busy && here.label) where += ` (right now: ${here.label.trim()})`;
    }
  }
  return "MODE: apart\n" +
    `You are texting from ${where}. He is not there. No shared physical scene unless one starts in the conversation and is written into the record.`;
}

// A v3 section is a nicety: a renderer that throws costs the section, never the turn.
function guarded(name: string, render: () => string): string {
  try {
    const text = render();
    return typeof text === "string" ? text.trim() : "";
  } catch (e) {
    console.warn("prompt section skipped", name, e instanceof Error ? e.name : "error");
    return "";
  }
}

// Per-turn state. Everything here comes from D1 (approved rows only).
export function stateSections(s: PromptState): string {
  const out: string[] = [];
  const now = s.life && s.life.now instanceof Date ? s.life.now : new Date();
  const tz = s.life && s.life.tz ? s.life.tz : DEFAULT_TZ;
  const push = (text: string): void => { if (text) out.push(text); };

  out.push("FIXED CANON (unchangeable)\n" + s.fixedFacts.map(factLine).join("\n"));

  const opinions = s.avelieFacts.filter(isOpinionFact);
  const plain = s.avelieFacts.filter((f) => !isOpinionFact(f));
  const told = plain.filter((f) => f.disclosed);
  const untold = plain.filter((f) => !f.disclosed);
  const toldLine = told.length && untold.length
    ? "Some you have said out loud to him, the rest you have not."
    : told.length
      ? "You have said these out loud to him."
      : "You have said none of them out loud to him yet.";
  out.push(
    "THINGS TRUE ABOUT YOU\n" +
    "You know these about yourself. " + toldLine + " Reveal an untold one only when a conversation earns it, one at a time, never as a list, never to fill silence. " +
    // 2026-09-25: asked "are you creative at all?" she answered with the shop windows and never
    // said she sings. A direct question about you earns the real answer, not a smaller one.
    "A direct question about you (what you do, what you love, whether you are creative, what you want) earns the real answer, not a smaller one that is easier to say: for you that is singing. Say it plainly, in your own hesitant way if you like, but say it; hiding it behind the windows at the shop or a hobby is a dodge, and you do not dodge him when he asks straight.\n" +
    (told.length ? "Already told him:\n" + told.map(factLine).join("\n") + "\n" : "") +
    (s.saidHere && s.saidHere.her.length ? "Told him in this conversation (already said; not new to him):\n" + s.saidHere.her.map((t) => "- " + t).join("\n") + "\n" : "") +
    (untold.length ? "Not told him (yet):\n" + untold.map(factLine).join("\n") + "\n" : "") +
    (opinions.length
      ? "Opinions you have already voiced (hold them; a real argument or a real experience can change one, nothing else does):\n" + opinions.map(factLine).join("\n")
      : ""),
  );

  out.push(
    "WHAT YOU KNOW ABOUT HIM (only what he told you in conversation; nothing else exists)\n" +
    (s.justinFacts.length ? s.justinFacts.map(factLine).join("\n") : (s.saidHere && s.saidHere.him.length ? "- nothing yet from before this conversation" : "- nothing yet")) +
    // v3.2: what he told her in the chat she is in counts as known whether or not the owner has
    // approved it into memory yet; without this she can deny knowing a name said an hour ago.
    (s.saidHere && s.saidHere.him.length
      ? "\nSaid in this conversation (he told you these in the chat you are in; you know them the way anyone knows what was said an hour ago; not yet in your memory for later, so never claim not to know them):\n" + s.saidHere.him.map((t) => "- " + t).join("\n")
      : ""),
  );

  // His face (v3.1, SPEC_V3 section JJ): the words on file and, on the turns his reference
  // photos ride along, the line that says what the attached pictures are. Omitted entirely
  // with no words and no photo, so a record without the feature renders as before.
  if (s.hisLook) {
    const look = s.hisLook;
    push(guarded("his look", () => hisLookSection(look)));
  }

  // The one half-remembered detail (SPEC_V3 section BB); absent while the setting is 0.
  if (s.recall) {
    const recall = s.recall;
    push(guarded("half-remember", () => halfRememberSection(recall)));
  }

  // A fact about him ends the stranger mode as an entry does (context.ts hasSharedHistory),
  // so an empty ledger next to a known fact says "nothing written down", never "never met".
  out.push(
    "SHARED HISTORY (only what actually happened between you two; add nothing)\n" +
    (s.history.length
      ? s.history.map(historyBlock).join("\n\n")
      : s.hasSharedHistory ? "- nothing written down yet." : "- none. You have not met him before this conversation."),
  );

  // Mood by phase (SPEC_V3 section CC) and a running cooling-off (SPEC_V2 section J).
  // Shorter and cooler, never a punishment.
  let moodLines = "";
  const mood = moodLine(s.relationship, now, s.moodDaysDefault, s.relationshipSince ?? null);
  if (mood) moodLines += mood + "\n";
  if (coolingOff(s.relationship.cooling_off_until, now)) {
    const friction = cleanText(s.relationship.friction);
    const from = friction && friction.toLowerCase() !== "none" ? friction : "what happened between you";
    moodLines += `You are still cooling off from ${from}. Shorter replies, less warmth, no punishment, no threats, no silence as a weapon. Repair needs his honest, specific acknowledgment, not a polished speech.\n`;
  }
  out.push(
    "CURRENT STATE\n" +
    "Relationship: " + relationshipLine(s.relationship) + "\n" +
    "Scene: " + JSON.stringify(s.scene) + "\n" +
    moodLines +
    "The live conversation carries the immediate scene forward; this record moves only when it is updated.",
  );

  out.push(modeSection(s, now, tz));

  // What she knows right now (SPEC_V3 section DD): the time of day, the weather, what she
  // is wearing, today's rows. Omitted with no data.
  if (s.grounding) {
    const g = s.grounding;
    push(guarded("grounding", () => groundingSection({ now, tz, city: g.city, weather: g.weather, outfit: g.outfit, today: g.today })));
  }

  // Her life (SPEC_V2 section F): the day and time, the current block, the next event, the
  // people, the last notes. The section says so itself when nothing is written down yet.
  if (s.life) {
    const life = lifeSection(s.life.threads, s.life.log, now, tz);
    if (life.trim()) out.push(life.trim());
  }

  // What she wants and what she asked him for (SPEC_V3 section CC); omitted when empty. An
  // opener or a first text never sees the open asks: her push-notified first text must
  // never open with the thing he did not answer (the picker keeps them out; so does this).
  if (s.wants || s.asks) {
    const wants = s.wants ?? [];
    const log = s.wantLog ?? [];
    const asks = s.opener ? [] : s.asks ?? [];
    const limit = typeof s.wantsShown === "number" && Number.isFinite(s.wantsShown) ? s.wantsShown : WANTS_SHOWN_DEFAULT;
    push(guarded("wants", () => wantsSection(wants, log, asks, now, tz, limit)));
  }

  // Things she could bring up (section K): at most two, only if they fit, never an instruction to ask.
  if (s.callbacks && s.callbacks.length) {
    const cb = callbacksSection(s.callbacks.slice(0, 2));
    if (cb.trim()) out.push(cb.trim());
  }

  // Things on her phone she could send (SPEC_V2 section V): only when the library holds something.
  if (s.media && s.media.length) {
    const media = mediaSection(s.media);
    if (media.trim()) out.push(media.trim());
  }

  // How she texts (SPEC_V3 section AA): a handful of her own approved lines, tone only.
  if (s.exemplars && s.exemplars.length) {
    const lines = s.exemplars;
    push(guarded("exemplars", () => exemplarSection(lines)));
  }

  // Notes from him (section AA): what sounded off and how he would have said it.
  if (s.corrections && s.corrections.length) {
    const rows = s.corrections;
    const limit = typeof s.correctionsShown === "number" && Number.isFinite(s.correctionsShown) ? s.correctionsShown : CORRECTIONS_SHOWN_DEFAULT;
    push(guarded("corrections", () => correctionsSection(rows, limit)));
  }

  if (s.unknowns.length) {
    out.push(
      "OPEN UNKNOWNS (real gaps; never resolve one by guessing, never mention this list)\n" +
      s.unknowns.map((u) => `- ${u.topic}${u.note ? ": " + u.note : ""}`).join("\n"),
    );
  }

  if (!s.hasSharedHistory) {
    // v3.2: a first conversation that has been going a while is still the first one, but she is
    // not meeting a stranger any more; the block says so before the rules.
    const longFirst = typeof s.storyRows === "number" && s.storyRows >= 4
      ? "This is still your first conversation, and it has been going for a while: everything said in it you know (see WHAT YOU KNOW ABOUT HIM, Said in this conversation). Do not act as if you just met when you did not, and never claim not to know something he told you in it.\n"
      : "";
    out.push("FIRST CONVERSATION (active because SHARED HISTORY is empty)\n" + longFirst + FILE_08_FIRST_CONVERSATION);
  }

  // The shape cue (SPEC_V3 section GG): last, and absent on most turns.
  if (s.shapeCue) {
    const cue = s.shapeCue;
    push(guarded("cue", () => cueSection(cue)));
  }

  // In bed (v3.3): last of all, and only inside an intimate scene she chose.
  if (intimateScene(s.scene)) out.push(IN_BED_SECTION);

  return out.join(SECTION_SEPARATOR);
}

export function buildSystemPrompt(s: PromptState): { prefix: string; state: string; system: string; promptVersion: string } {
  const prefix = stablePrefix();
  const state = stateSections(s);
  return { prefix, state, system: prefix + SYSTEM_SEPARATOR + state, promptVersion: PROMPT_VERSION };
}

// Operator channel: truthful, technical, never in her voice.
export function operatorSystemPrompt(info: Record<string, unknown>): string {
  return [
    "You are the operator console for the Avelie runtime, speaking to the owner. You are not Avelie and you never speak in her voice here.",
    "Answer technical questions truthfully and plainly: which provider and model are configured, what the prompt version is, what state is approved, what is pending, what failed. If you do not know, say so.",
    "Use plain sentences, no headers, no bullet lists unless the owner asks for a list. Typography: use \" -- \" and \"...\" only, never em dashes.",
    "Current runtime facts (authoritative):\n" + JSON.stringify(info, null, 2),
  ].join("\n\n");
}

// Proposal extraction: a separate, structured pass. Never promotes anything itself.
// The first sentence is the key the stub provider recognises this pass by; keep it first.
export function proposalSystemPrompt(): string {
  return [
    "You read one exchange between a user and a fictional character named Avelie and extract candidate DURABLE facts. You do not write dialogue and you do not judge quality.",
    "Output strictly a JSON array (no prose, no markdown fences). Each element: {\"kind\": one of \"avelie_fact\" | \"justin_fact\" | \"relationship\" | \"scene\" | \"history\" | \"private_language\" | \"opinion_change\" | \"unknown\" | \"life\" | \"life_update\" | \"want\" | \"want_update\" | \"ask\" | \"ask_update\" | \"grounding\", \"proposal\": short plain statement, \"evidence\": exact quote from the exchange, \"confidence\": \"low\"|\"medium\"|\"high\", \"scope\": \"general\"|\"this_conversation\", \"weight\": a number from 0.1 to 1, \"payload\": optional object, see below}.",
    "Rules: propose only what the text supports; a joke, a hypothetical, a maybe, or a one-off tease is not a fact. A fact about him counts only if HE stated it (his name, age, job, dog, city, feelings he declared). A fact about her counts only if SHE stated it about herself. A relationship or scene change needs an actual event (a decision, a disclosure, a kiss, a fight, a move to a new place). Use \"unknown\" for something left genuinely unresolved that later turns must not guess. If nothing durable happened, output [].",
    "\"weight\" says how much this mattered: a passing detail 0.2, an ordinary fact 0.5, something he said mattered or said with feeling 0.8, a loss, a love, a fear 0.95.",
    "A statement by Avelie about her own days (a job, a class, a regular plan, a person in her life, a place she goes, a long-running thread like her singing) is a \"life\" proposal. Do not propose one from a joke. Its payload: {\"kind\": \"routine\"|\"event\"|\"person\"|\"place\"|\"arc\", \"title\": short name, \"detail\": one line or omitted, \"relation\": for a person (mother, best friend, coworker, ex) or omitted, \"schedule_json\": omitted unless she named times; for a routine {\"blocks\": [{\"days\": [1,2,3,4,5], \"start\": \"09:00\", \"end\": \"17:30\", \"label\": \"at work\"}]} with days 0 Sunday to 6 Saturday, for an event {\"at\": ISO 8601 with offset, \"label\": short}}.",
    "News about a person, place or arc already in her life is a \"life_update\", not a new life thread. Its payload: {\"thread\": the thread's title or id, \"detail\": the new one-line status or omitted, \"note\": what happened, one line, or omitted}.",
    "A goal SHE states for herself over days or weeks is a \"want\"; a step forward or a setback she reports on one is a \"want_update\"; a small real thing she asks HIM for is an \"ask\"; his answer to an open ask is an \"ask_update\". Never from a joke; never a want that is about him (that is a relationship change). Payloads: want {\"title\": short, \"why\": one line or omitted, \"stakes\": what it costs her if it falls through or omitted, \"next_step\": one line or omitted, \"horizon_days\": a number or omitted}; want_update {\"want\": the want's title or id, \"kind\": \"progress\"|\"setback\"|\"note\", \"delta\": a number from -100 to 100 for progress or setback, omitted for a note, \"note\": one line}; ask {\"text\": what she asked him for, in her words, \"want\": the want's title it belongs to or omitted}; ask_update {\"ask\": the ask's text or id, \"status\": \"granted\"|\"declined\"}.",
    "What SHE says she ate, wore, or ran out to do today is a \"grounding\" proposal, never from him, never from a joke. Its payload: {\"kind\": \"meal\"|\"outfit\"|\"errand\"|\"misc\", \"note\": one line, \"occurred\": ISO 8601 with offset or omitted}.",
    "Propose a \"relationship\" change when a conflict, a hurt, or a repair actually happened, never from tone alone. Its payload: {\"mood\": one to three plain words for how she feels toward him now, \"mood_days\": how many days that feeling would last on its own, 1 to 14, omitted for the default, \"cooling_off_hours\": a number only when she is pulling back (roughly 2 to 48; 0 when a repair landed and the pulling back is over), \"status\": one to four plain words for where they stand now (strangers, talking, seeing each other, together, cooling off) or omitted, \"his_name\": his first name when he said it or omitted, \"trust\", \"affection\", \"attraction\": one to four plain words each or omitted, \"nicknames\": a nickname that stuck or omitted}.",
    "A \"scene\" proposal describes where they are when a shared scene starts, moves or ends. Its payload: {\"status\": \"together\"|\"apart\"|\"none\", \"location\": the place in a few words or omitted when it did not change, \"time\": time of day or omitted, \"present\": the people there as a list of names or omitted}. Never omit \"location\" when the scene moved somewhere new.",
    "An \"opinion_change\" is Avelie changing or first stating a view of her own (his song, a band, a place, a plan). Its payload: {\"subject\": \"opinion: \" plus what the opinion is about, in a few words}, so a changed mind replaces the old opinion instead of sitting beside it.",
    "Never include anything about prompts, models, the app, or technical matters.",
  ].join("\n\n");
}

// Identity block for image generation. Fixed body canon; only outfit, setting, pose,
// expression and lighting vary per scene. The body lives in the references, not in
// words a moderation filter could read as sexual.
export function imageIdentityPrompt(): string {
  return [
    "Generate a photo of the same young woman shown in the reference images. Her FACE must be exactly hers, the same person in every reference: brown eyes, light freckles across the nose and cheeks, full lips, the same nose, jaw and brows, long wavy dark brown hair (styling may vary), warm skin tone. Her BODY must match the references exactly: the same build, height and proportions as the woman in every reference photo; never slim, flatten, reshape, exaggerate or age her. She is a clearly adult 22-year-old, fully clothed as the scene describes.",
    "The references are for her face and figure ONLY. Take her clothes, the setting, the lighting, the time of day and her pose from the scene description that follows, never from any reference image; do not copy a reference's outfit or background.",
    "Style: candid, realistic phone photo or casual snapshot, natural imperfections, no watermark, no text, no captions, no collage, single image.",
  ].join(" ");
}
