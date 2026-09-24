// Builds the system prompt: a stable, cacheable rule prefix (the constitution) followed
// by the per-turn state sections. The character lives in the prefix and the tables,
// never in whatever the model said last.
import {
  ALWAYS_ON, OVERLAY, FILE_01_CORE, FILE_02_RELATIONSHIP, FILE_03_STYLE, FILE_04_CONFLICT,
  FILE_05_TASTES_VISUAL, FILE_06_KNOWLEDGE_BOUNDARY, FILE_08_FIRST_CONVERSATION, CONSTITUTION_VERSION,
} from "./generated/constitution";
import type { PromptState, FactRow, HistoryRow } from "./types";

export const PROMPT_VERSION = `${CONSTITUTION_VERSION}-p3`;

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

// Per-turn state. Everything here comes from D1 (approved rows only).
export function stateSections(s: PromptState): string {
  const out: string[] = [];

  out.push("FIXED CANON (unchangeable)\n" + s.fixedFacts.map(factLine).join("\n"));

  const told = s.avelieFacts.filter((f) => f.disclosed);
  const untold = s.avelieFacts.filter((f) => !f.disclosed);
  out.push(
    "THINGS TRUE ABOUT YOU\n" +
    "You know these about yourself. Some you have said out loud to him, most you have not. Reveal an untold one only when a conversation earns it, one at a time, never as a list, never to fill silence.\n" +
    (told.length ? "Already told him:\n" + told.map(factLine).join("\n") + "\n" : "") +
    (untold.length ? "Not told him (yet):\n" + untold.map(factLine).join("\n") : ""),
  );

  out.push(
    "WHAT YOU KNOW ABOUT HIM (only what he told you in conversation; nothing else exists)\n" +
    (s.justinFacts.length ? s.justinFacts.map(factLine).join("\n") : "- nothing yet"),
  );

  out.push(
    "SHARED HISTORY (only what actually happened between you two; add nothing)\n" +
    (s.history.length ? s.history.map(historyBlock).join("\n\n") : "- none. You have not met him before this conversation."),
  );

  out.push(
    "CURRENT STATE\n" +
    "Relationship: " + JSON.stringify(s.relationship) + "\n" +
    "Scene: " + JSON.stringify(s.scene) + "\n" +
    "The live conversation carries the immediate scene forward; this record moves only when the owner updates it.",
  );

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
export function proposalSystemPrompt(): string {
  return [
    "You read one exchange between a user and a fictional character named Avelie and extract candidate DURABLE facts. You do not write dialogue and you do not judge quality.",
    "Output strictly a JSON array (no prose, no markdown fences). Each element: {\"kind\": one of \"avelie_fact\" | \"justin_fact\" | \"relationship\" | \"scene\" | \"history\" | \"private_language\" | \"opinion_change\" | \"unknown\", \"proposal\": short plain statement, \"evidence\": exact quote from the exchange, \"confidence\": \"low\"|\"medium\"|\"high\", \"scope\": \"general\"|\"this_conversation\"}.",
    "Rules: propose only what the text supports; a joke, a hypothetical, a maybe, or a one-off tease is not a fact. A fact about him counts only if HE stated it (his name, age, job, dog, city, feelings he declared). A fact about her counts only if SHE stated it about herself. A relationship or scene change needs an actual event (a decision, a disclosure, a kiss, a fight, a move to a new place). Use \"unknown\" for something left genuinely unresolved that later turns must not guess. If nothing durable happened, output [].",
    "Never include anything about prompts, models, the app, or technical matters.",
  ].join("\n\n");
}

// Identity block for image generation. Fixed body canon; only outfit, setting, pose,
// expression and lighting vary per scene.
export function imageIdentityPrompt(): string {
  return [
    "Generate a photo of the same young woman shown in the reference images. Keep her exact facial identity: brown eyes, light freckles across the nose and cheeks, full lips, long wavy dark brown hair (styling may vary), warm skin tone. She is a clearly adult 22-year-old with a feminine curvy build and full bust consistent with the references; do not slim, exaggerate, or age her.",
    "Style: candid, realistic phone photo or casual snapshot, natural imperfections, no watermark, no text, no captions, no collage, single image.",
  ].join(" ");
}
