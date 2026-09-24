// Deterministic, key-free providers for tests. Text replies are driven by markers in the
// last user message; the image provider hands back a master's bytes unchanged.
import { ProviderError } from "../types";
import type {
  Env, GenerateRequest, GenerateResult, ImageGenerateRequest, ImageGenerateResult, ImageProvider, TextProvider,
} from "../types";
import { approxTokens, lastUserContent } from "./types";
import { imagesOf } from "../vision";

// Built at runtime so the typography scan of this file stays clean.
const EM_DASH = String.fromCharCode(0x2014);

const PROPOSAL_PREFIX = "You read one exchange";
const OPERATOR_PREFIX = "You are the operator console";

const LONG_REPLY =
  "ok so i was going to say something short and then i started thinking about it and now it is a whole thing, sorry. " +
  "the point is that today was one of those days where nothing goes wrong exactly but nothing lands either, and i kept " +
  "picking up my phone and putting it down again like it owed me something. anyway. i made tea, i did not drink it, i found " +
  "it cold an hour later and that felt like a fair summary of the afternoon. that is the whole update, nothing dramatic, " +
  "just a lot of small nothing stacked up and i am telling you about it because you asked and because it is late.";

const PHOTO_REPLY = "ok fine, one. do not judge the lighting\n[photo: mirror selfie in a black hoodie, messy bun, lamp light, half smile]";
// v2: a sent song (SPEC_V2 section I). The prose names neither the artist nor the title.
const SONG_REPLY = "this has been stuck in my head since tuesday, do not read into it\n[song: Some Artist - Some Title]";
// v2: a voice note (section S) and a library item (section V); the prose names neither.
const VOICE_REPLY = "ok this one i would rather just say out loud\n[voice]";
const MEDIA_PREFIX_REPLY = "this is the one i was talking about, do not read into it\n[media: ";
// v2: he attached a photo (section T). The stub cannot look, so it says only that it got one.
const PHOTO_IN_REPLY = "(photo received) ok, i see it. noted.";

const FACT_MARKER = /\[\[FACT:([^\]]+)\]\]/g;
// v2 proposal triggers: a life thread and a relationship mood change (SPEC_V2 "Stub additions").
const LIFE_MARKER = /\[\[LIFE:([^\]]+)\]\]/g;
const MOOD_MARKER = /\[\[MOOD:([^\]]+)\]\]/g;
const NAME_MARKER = /\[\[NAME:([^\]]+)\]\]/;
const MEDIA_MARKER = /\[\[MEDIA:([^\]]+)\]\]/;
const ANY_MARKER = /\[\[[^\]]*\]\]/g;

function proposalReply(req: GenerateRequest): string {
  const out: Array<Record<string, unknown>> = [];
  for (const m of req.messages) {
    for (const hit of m.content.matchAll(FACT_MARKER)) {
      const x = (hit[1] ?? "").trim();
      if (!x) continue;
      out.push({ kind: "avelie_fact", proposal: x, evidence: "[[FACT:" + x + "]]", confidence: "high", scope: "general" });
    }
    for (const hit of m.content.matchAll(LIFE_MARKER)) {
      const x = (hit[1] ?? "").trim();
      if (!x) continue;
      out.push({ kind: "life", proposal: x, evidence: "[[LIFE:" + x + "]]", confidence: "high", scope: "general", payload: { kind: "routine", title: x } });
    }
    for (const hit of m.content.matchAll(MOOD_MARKER)) {
      const x = (hit[1] ?? "").trim();
      if (!x) continue;
      out.push({
        kind: "relationship", proposal: "she is " + x + " with him", evidence: "[[MOOD:" + x + "]]", confidence: "high", scope: "general",
        payload: { mood: x, cooling_off_hours: 12 },
      });
    }
  }
  return out.length ? JSON.stringify(out) : "[]";
}

// Two plain words from the user text, for the default echo line.
function echoWords(text: string): [string, string] {
  const words = (text.replace(ANY_MARKER, " ").toLowerCase().match(/[a-z']+/g) ?? [])
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter((w) => w.length >= 3);
  const distinct: string[] = [];
  for (const w of words) {
    if (!distinct.includes(w)) distinct.push(w);
    if (distinct.length === 2) break;
  }
  return [distinct[0] ?? "hey", distinct[1] ?? "ok"];
}

function storyReply(last: string, withImages: boolean): { text: string; stopReason: GenerateResult["stopReason"] } {
  if (last.includes("[[FAIL]]")) throw new ProviderError("stub", "server", "stub failure", 502, true);
  if (last.includes("[[REFUSE]]")) return { text: "", stopReason: "refusal" };
  if (withImages) return { text: PHOTO_IN_REPLY, stopReason: "end" };
  if (last.includes("[[VOICE]]")) return { text: VOICE_REPLY, stopReason: "end" };
  const media = MEDIA_MARKER.exec(last);
  if (media && media[1] && media[1].trim()) return { text: MEDIA_PREFIX_REPLY + media[1].trim() + "]", stopReason: "end" };
  if (last.includes("[[EMDASH]]")) return { text: "wait " + EM_DASH + " no, hold on. that is not what i meant", stopReason: "end" };
  if (last.includes("[[LIST]]")) return { text: "ok here is the plan\n- coffee first\n- then the park\n- then nothing", stopReason: "end" };
  if (last.includes("[[PHOTO]]")) return { text: PHOTO_REPLY, stopReason: "end" };
  if (last.includes("[[SONG]]")) return { text: SONG_REPLY, stopReason: "end" };
  if (last.includes("[[QUESTION]]")) return { text: "wait, what do you actually mean by that?", stopReason: "end" };
  if (last.includes("[[LONG]]")) return { text: LONG_REPLY, stopReason: "end" };
  const name = NAME_MARKER.exec(last);
  if (name && name[1]) {
    const x = name[1].trim();
    return { text: x + ". " + x + ". ok " + x + ", i heard you.", stopReason: "end" };
  }
  const [a, b] = echoWords(last);
  return { text: a + " " + b + ", ok. noted.", stopReason: "end" };
}

export const stubProvider: TextProvider = {
  name: "stub",
  async generate(_env: Env, req: GenerateRequest): Promise<GenerateResult> {
    const last = lastUserContent(req.messages);
    let text: string;
    let stopReason: GenerateResult["stopReason"] = "end";

    if (req.system.startsWith(PROPOSAL_PREFIX)) {
      text = proposalReply(req);
    } else if (req.system.startsWith(OPERATOR_PREFIX)) {
      text = "operator: " + last.slice(0, 200);
    } else {
      const lastMessage = [...req.messages].reverse().find((m) => m.role === "user");
      const r = storyReply(last, lastMessage ? imagesOf(lastMessage).length > 0 : false);
      text = r.text;
      stopReason = r.stopReason;
    }

    const inputTokens = approxTokens(req.system + req.messages.map((m) => m.content).join(""));
    return { text, inputTokens, outputTokens: approxTokens(text), stopReason, model: req.model, provider: "stub" };
  },
};

export const stubImageProvider: ImageProvider = {
  name: "stub",
  async generate(_env: Env, req: ImageGenerateRequest): Promise<ImageGenerateResult> {
    const ref = req.references.find((r) => r.name.includes("03_")) ?? req.references[0];
    if (!ref) throw new ProviderError("stub", "bad_request", "no reference images", 400, false);
    return { png: ref.bytes, model: req.model, provider: "stub" };
  },
};
