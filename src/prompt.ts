// Builds the system prompt: a stable, cacheable rule prefix (the constitution) followed
// by the per-turn state sections. The character lives in the prefix and the tables,
// never in whatever the model said last.
import {
  ALWAYS_ON, OVERLAY, FILE_01_CORE, FILE_02_RELATIONSHIP, FILE_03_STYLE, FILE_04_CONFLICT,
  FILE_05_TASTES_VISUAL, FILE_06_KNOWLEDGE_BOUNDARY, FILE_08_FIRST_CONVERSATION, CONSTITUTION_VERSION,
} from "./generated/constitution";
import { lifeSection, whereSheIs } from "./life";
import { callbacksSection } from "./callbacks";
import { mediaSection } from "./media";
import type { PromptState, FactRow, HistoryRow, SceneMode } from "./types";

// p4: v2 state sections (MODE, mood and cooling-off, YOUR LIFE, callbacks, opinions).
export const PROMPT_VERSION = `${CONSTITUTION_VERSION}-p4`;

const DEFAULT_TZ = "America/New_York";
const OPINION_PREFIX = "opinion:";

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
  ].join("\n\n" + "=".repeat(60) + "\n\n");
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

// The MODE section (SPEC_V2 section C). Apart fills the place from her life when the scene
// has none recorded; the label rides in a parenthesis so any wording of it reads.
function modeSection(s: PromptState, now: Date, tz: string): string {
  const mode = s.mode ?? sceneMode(s.scene.status);
  const location = cleanText(s.scene.location);
  if (mode === "together") {
    return "MODE: together\n" +
      `You are in the same place as him right now: ${location || "where the scene has you"}. Present tense. You move, choose, touch, leave, the way a person does. He is not narrating you.`;
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
    `You are texting from ${where}. He is not there. No shared physical scene unless one starts in the conversation and the owner records it.`;
}

// Per-turn state. Everything here comes from D1 (approved rows only).
export function stateSections(s: PromptState): string {
  const out: string[] = [];
  const now = s.life && s.life.now instanceof Date ? s.life.now : new Date();
  const tz = s.life && s.life.tz ? s.life.tz : DEFAULT_TZ;

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
    "You know these about yourself. " + toldLine + " Reveal an untold one only when a conversation earns it, one at a time, never as a list, never to fill silence.\n" +
    (told.length ? "Already told him:\n" + told.map(factLine).join("\n") + "\n" : "") +
    (untold.length ? "Not told him (yet):\n" + untold.map(factLine).join("\n") + "\n" : "") +
    (opinions.length
      ? "Opinions you have already voiced (hold them; a real argument or a real experience can change one, nothing else does):\n" + opinions.map(factLine).join("\n")
      : ""),
  );

  out.push(
    "WHAT YOU KNOW ABOUT HIM (only what he told you in conversation; nothing else exists)\n" +
    (s.justinFacts.length ? s.justinFacts.map(factLine).join("\n") : "- nothing yet"),
  );

  out.push(
    "SHARED HISTORY (only what actually happened between you two; add nothing)\n" +
    (s.history.length ? s.history.map(historyBlock).join("\n\n") : "- none. You have not met him before this conversation."),
  );

  // Mood and a running cooling-off (SPEC_V2 section J). Shorter and cooler, never a punishment.
  const mood = cleanText(s.relationship.mood);
  let moodLines = "";
  if (mood) moodLines += "Mood: " + mood + "\n";
  if (coolingOff(s.relationship.cooling_off_until, now)) {
    const friction = cleanText(s.relationship.friction);
    const from = friction && friction.toLowerCase() !== "none" ? friction : "what happened between you";
    moodLines += `You are still cooling off from ${from}. Shorter replies, less warmth, no punishment, no threats, no silence as a weapon. Repair needs his honest, specific acknowledgment, not a polished speech.\n`;
  }
  out.push(
    "CURRENT STATE\n" +
    "Relationship: " + JSON.stringify(s.relationship) + "\n" +
    "Scene: " + JSON.stringify(s.scene) + "\n" +
    moodLines +
    "The live conversation carries the immediate scene forward; this record moves only when the owner updates it.",
  );

  out.push(modeSection(s, now, tz));

  // Her life (SPEC_V2 section F): the day and time, the current block, the next event, the
  // people, the last notes. The section says so itself when nothing is written down yet.
  if (s.life) {
    const life = lifeSection(s.life.threads, s.life.log, now, tz);
    if (life.trim()) out.push(life.trim());
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

  if (s.unknowns.length) {
    out.push(
      "OPEN UNKNOWNS (real gaps; never resolve one by guessing, never mention this list)\n" +
      s.unknowns.map((u) => `- ${u.topic}${u.note ? ": " + u.note : ""}`).join("\n"),
    );
  }

  if (!s.hasSharedHistory) {
    out.push("FIRST CONVERSATION (active because SHARED HISTORY is empty)\n" + FILE_08_FIRST_CONVERSATION);
  }

  return out.join("\n\n" + "-".repeat(60) + "\n\n");
}

export function buildSystemPrompt(s: PromptState): { prefix: string; state: string; system: string; promptVersion: string } {
  const prefix = stablePrefix();
  const state = stateSections(s);
  return { prefix, state, system: prefix + "\n\n" + "=".repeat(60) + "\n\n" + state, promptVersion: PROMPT_VERSION };
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
    "Output strictly a JSON array (no prose, no markdown fences). Each element: {\"kind\": one of \"avelie_fact\" | \"justin_fact\" | \"relationship\" | \"scene\" | \"history\" | \"private_language\" | \"opinion_change\" | \"unknown\" | \"life\", \"proposal\": short plain statement, \"evidence\": exact quote from the exchange, \"confidence\": \"low\"|\"medium\"|\"high\", \"scope\": \"general\"|\"this_conversation\", \"payload\": optional object, see below}.",
    "Rules: propose only what the text supports; a joke, a hypothetical, a maybe, or a one-off tease is not a fact. A fact about him counts only if HE stated it (his name, age, job, dog, city, feelings he declared). A fact about her counts only if SHE stated it about herself. A relationship or scene change needs an actual event (a decision, a disclosure, a kiss, a fight, a move to a new place). Use \"unknown\" for something left genuinely unresolved that later turns must not guess. If nothing durable happened, output [].",
    "A statement by Avelie about her own days (a job, a class, a regular plan, a person in her life, a place she goes, a long-running thread like her singing) is a \"life\" proposal. Do not propose one from a joke. Its payload: {\"kind\": \"routine\"|\"event\"|\"person\"|\"place\"|\"arc\", \"title\": short name, \"detail\": one line or omitted, \"relation\": for a person (mother, best friend, coworker, ex) or omitted, \"schedule_json\": omitted unless she named times; for a routine {\"blocks\": [{\"days\": [1,2,3,4,5], \"start\": \"09:00\", \"end\": \"17:30\", \"label\": \"at work\"}]} with days 0 Sunday to 6 Saturday, for an event {\"at\": ISO 8601 with offset, \"label\": short}}.",
    "Propose a \"relationship\" change when a conflict, a hurt, or a repair actually happened, never from tone alone. Its payload: {\"mood\": one to three plain words for how she feels toward him now, \"cooling_off_hours\": a number only when she is pulling back (roughly 2 to 48; 0 when a repair landed and the pulling back is over)}.",
    "An \"opinion_change\" is Avelie changing or first stating a view of her own (his song, a band, a place, a plan). Its payload: {\"subject\": \"opinion: \" plus what the opinion is about, in a few words}, so a changed mind replaces the old opinion instead of sitting beside it.",
    "Never include anything about prompts, models, the app, or technical matters.",
  ].join("\n\n");
}

// Identity block for image generation. Fixed body canon; only outfit, setting, pose,
// expression and lighting vary per scene. The body lives in the references, not in
// words a moderation filter could read as sexual.
export function imageIdentityPrompt(): string {
  return [
    "Generate a photo of the same young woman shown in the reference images. Keep her exact facial identity: brown eyes, light freckles across the nose and cheeks, full lips, long wavy dark brown hair (styling may vary), warm skin tone. She is a clearly adult 22-year-old; keep her build and proportions consistent with the references; do not slim, exaggerate, or age her.",
    "Style: candid, realistic phone photo or casual snapshot, natural imperfections, no watermark, no text, no captions, no collage, single image.",
  ].join(" ");
}
