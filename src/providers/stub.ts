// Deterministic, key-free providers for tests. Text replies are driven by markers in the
// last user message; the image provider hands back a master's bytes unchanged; the video
// stub (v3) answers a task that succeeds on its second poll with a tiny mp4 whose hash is
// stable. Every v1 and v2 trigger is kept; v3 adds the ones SPEC_V3 "Stub additions" lists.
import { ProviderError } from "../types";
import type {
  Env, GenerateRequest, GenerateResult, ImageGenerateRequest, ImageGenerateResult, TextProvider,
} from "../types";
import { approxTokens, lastUserContent } from "./types";
import type { ImageFromTextRequest, ImageProviderV3, VideoProvider, VideoStartRequest, VideoTaskStatus } from "./types";
import { imagesOf } from "../vision";

// Built at runtime so the typography scan of this file stays clean.
const EM_DASH = String.fromCharCode(0x2014);

const PROPOSAL_PREFIX = "You read one exchange";
const OPERATOR_PREFIX = "You are the operator console";
// The tasting performer's model id (SPEC_V3 HH): its replies carry the "b: " prefix so
// the two candidates differ, and [[BFAIL]] throws only on this side.
export const STUB_B_MODEL = "stub-b";

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
// v3 (SPEC_V3 GG): the shapes the imperfection checks read.
const TYPO_REPLY = "ok that was werid\n\nweird*";
const ONEWORD_REPLY = "no";
const LOWER_REPLY = "cant. tired. tomorrow maybe";
const SAME_REPLY = "Fine, that is fair. I did not think of it that way.";
const POLISH_REPLY =
  "It was not the rain that ruined the evening; it was the waiting. I stood there with my coffee, my phone, and my patience. " +
  "Some nights simply do not want to be saved.";

const FACT_MARKER = /\[\[FACT:([^\]]+)\]\]/g;
// v2 proposal triggers: a life thread and a relationship mood change (SPEC_V2 "Stub additions").
const LIFE_MARKER = /\[\[LIFE:([^\]]+)\]\]/g;
const MOOD_MARKER = /\[\[MOOD:([^\]]+)\]\]/g;
// v3 proposal triggers (SPEC_V3 BB, CC, DD).
const WEIGHT_MARKER = /\[\[WEIGHT:([^\]|]+)\|([^\]]+)\]\]/g;
const WANT_MARKER = /\[\[WANT:([^\]]+)\]\]/g;
const WANTUP_MARKER = /\[\[WANTUP:([^\]|]+)\|([^\]]+)\]\]/g;
const ASK_MARKER = /\[\[ASK:([^\]]+)\]\]/g;
const MOODDAYS_MARKER = /\[\[MOODDAYS:([^\]|]+)\|([^\]]+)\]\]/g;
const GROUND_MARKER = /\[\[GROUND:([^\]|]+)\|([^\]]+)\]\]/g;
const LIFEUP_MARKER = /\[\[LIFEUP:([^\]|]+)\|([^\]]+)\]\]/g;
const NAME_MARKER = /\[\[NAME:([^\]]+)\]\]/;
const MEDIA_MARKER = /\[\[MEDIA:([^\]]+)\]\]/;
// v3 story triggers (SPEC_V3 AA, CC).
const EXEMPLAR_MARKER = /\[\[EXEMPLAR:([^\]]+)\]\]/;
const NAG_MARKER = /\[\[NAG:([^\]]+)\]\]/;
const ANY_MARKER = /\[\[[^\]]*\]\]/g;

function numberOr(s: string, fallback: number): number {
  const n = Number(s.trim());
  return Number.isFinite(n) ? n : fallback;
}

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
    // v3: a fact about him with a memory weight (BB).
    for (const hit of m.content.matchAll(WEIGHT_MARKER)) {
      const x = (hit[1] ?? "").trim();
      if (!x) continue;
      out.push({ kind: "justin_fact", proposal: x, evidence: "[[WEIGHT:" + x + "]]", confidence: "high", scope: "general", weight: numberOr(hit[2] ?? "", 0.2) });
    }
    // v3: wants, progress, asks, a mood with its days (CC).
    for (const hit of m.content.matchAll(WANT_MARKER)) {
      const x = (hit[1] ?? "").trim();
      if (!x) continue;
      out.push({ kind: "want", proposal: x, evidence: "[[WANT:" + x + "]]", confidence: "high", scope: "general", payload: { title: x } });
    }
    for (const hit of m.content.matchAll(WANTUP_MARKER)) {
      const x = (hit[1] ?? "").trim();
      if (!x) continue;
      const delta = numberOr(hit[2] ?? "", 10);
      out.push({
        kind: "want_update", proposal: x + ": moved", evidence: "[[WANTUP:" + x + "]]", confidence: "high", scope: "general",
        payload: { want: x, kind: delta < 0 ? "setback" : "progress", delta: Math.abs(delta), note: "moved by " + delta },
      });
    }
    for (const hit of m.content.matchAll(ASK_MARKER)) {
      const x = (hit[1] ?? "").trim();
      if (!x) continue;
      out.push({ kind: "ask", proposal: "she asked him: " + x, evidence: "[[ASK:" + x + "]]", confidence: "high", scope: "general", payload: { text: x } });
    }
    for (const hit of m.content.matchAll(MOODDAYS_MARKER)) {
      const x = (hit[1] ?? "").trim();
      if (!x) continue;
      out.push({
        kind: "relationship", proposal: "she is " + x + " with him", evidence: "[[MOODDAYS:" + x + "]]", confidence: "high", scope: "general",
        payload: { mood: x, mood_days: numberOr(hit[2] ?? "", 3) },
      });
    }
    // v3: what she ate, wore or ran out to do; news about someone in her life (DD).
    for (const hit of m.content.matchAll(GROUND_MARKER)) {
      const kind = (hit[1] ?? "").trim();
      const note = (hit[2] ?? "").trim();
      if (!kind || !note) continue;
      out.push({ kind: "grounding", proposal: kind + ": " + note, evidence: "[[GROUND:" + kind + "|" + note + "]]", confidence: "high", scope: "general", payload: { kind, note } });
    }
    for (const hit of m.content.matchAll(LIFEUP_MARKER)) {
      const title = (hit[1] ?? "").trim();
      const note = (hit[2] ?? "").trim();
      if (!title || !note) continue;
      out.push({ kind: "life_update", proposal: title + ": " + note, evidence: "[[LIFEUP:" + title + "|" + note + "]]", confidence: "high", scope: "general", payload: { thread: title, note } });
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

function storyReply(last: string, withImages: boolean, model: string): { text: string; stopReason: GenerateResult["stopReason"] } {
  if (last.includes("[[FAIL]]")) throw new ProviderError("stub", "server", "stub failure", 502, true);
  // v3 (HH): the tasting side fails alone, so the void rule can be exercised.
  if (last.includes("[[BFAIL]]") && model === STUB_B_MODEL) throw new ProviderError("stub", "server", "stub failure on side B", 502, true);
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
  // v3 (GG): the shapes.
  if (last.includes("[[TYPO]]")) return { text: TYPO_REPLY, stopReason: "end" };
  if (last.includes("[[ONEWORD]]")) return { text: ONEWORD_REPLY, stopReason: "end" };
  if (last.includes("[[LOWER]]")) return { text: LOWER_REPLY, stopReason: "end" };
  if (last.includes("[[SAME]]")) return { text: SAME_REPLY, stopReason: "end" };
  if (last.includes("[[POLISH]]")) return { text: POLISH_REPLY, stopReason: "end" };
  // v3 (AA): an offered exemplar reused verbatim.
  const exemplar = EXEMPLAR_MARKER.exec(last);
  if (exemplar && exemplar[1] && exemplar[1].trim()) return { text: exemplar[1].trim() + ", basically. anyway", stopReason: "end" };
  // v3 (CC): bringing an ask up again.
  const nag = NAG_MARKER.exec(last);
  if (nag && nag[1] && nag[1].trim()) return { text: "so about " + nag[1].trim() + ". still there. just saying", stopReason: "end" };
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
      const r = storyReply(last, lastMessage ? imagesOf(lastMessage).length > 0 : false, req.model);
      text = r.text;
      stopReason = r.stopReason;
      // v3 (HH): the tasting performer's replies are told apart by a prefix.
      if (req.model === STUB_B_MODEL && text) text = "b: " + text;
    }

    const inputTokens = approxTokens(req.system + req.messages.map((m) => m.content).join(""));
    return { text, inputTokens, outputTokens: approxTokens(text), stopReason, model: req.model, provider: "stub" };
  },
};

// ------------------------------------------------------------------ images

// Master 03's bytes for a portrait, the way the photo stub answers with master 03: the
// registry rows are read by the caller (images.ts loadMasterBytes) and handed in as
// references, which a text-to-image call does not carry, so the stub carries a fallback
// PNG of its own (a 1x1 image, stable bytes) when no reference bytes were attached.
const STUB_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x60, 0x60, 0x60, 0x60,
  0x00, 0x00, 0x00, 0x05, 0x00, 0x01, 0x87, 0xa1, 0x4e, 0xd6, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
  0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

// A per-isolate slot the portrait path may fill with master 03's bytes before calling
// the stub (SPEC_V3 DD: "image stub generateFromText -> master 03's bytes"). Unset, the
// stub answers its own tiny PNG.
let stubPortraitBytes: ArrayBuffer | null = null;

export function setStubPortraitBytes(bytes: ArrayBuffer | null): void {
  stubPortraitBytes = bytes ? bytes.slice(0) : null;
}

export const stubImageProvider: ImageProviderV3 = {
  name: "stub",
  async generate(_env: Env, req: ImageGenerateRequest): Promise<ImageGenerateResult> {
    const ref = req.references.find((r) => r.name.includes("03_")) ?? req.references[0];
    if (!ref) throw new ProviderError("stub", "bad_request", "no reference images", 400, false);
    return { png: ref.bytes, model: req.model, provider: "stub" };
  },
  async generateFromText(_env: Env, req: ImageFromTextRequest): Promise<ImageGenerateResult> {
    if (!req.prompt.trim()) throw new ProviderError("stub", "bad_request", "empty prompt", 400, false);
    const png = stubPortraitBytes ? stubPortraitBytes.slice(0) : STUB_PNG.buffer.slice(STUB_PNG.byteOffset, STUB_PNG.byteOffset + STUB_PNG.byteLength) as ArrayBuffer;
    return { png, model: req.model, provider: "stub" };
  },
};

// ------------------------------------------------------------------ video (v3, SPEC_V3 FF)

// A minimal mp4: an ftyp box (isom), an empty moov and an empty mdat. About 40 bytes,
// never meant to play; the point is a stable sha256 the blacklist can hold.
function box(type: string, payload: number[]): number[] {
  const size = 8 + payload.length;
  return [(size >>> 24) & 0xff, (size >>> 16) & 0xff, (size >>> 8) & 0xff, size & 0xff, ...type.split("").map((c) => c.charCodeAt(0)), ...payload];
}

const ascii = (s: string): number[] => s.split("").map((c) => c.charCodeAt(0));
const STUB_MP4 = new Uint8Array([
  ...box("ftyp", [...ascii("isom"), 0, 0, 2, 0, ...ascii("isom"), ...ascii("iso2"), ...ascii("mp41")]),
  ...box("moov", []),
  ...box("mdat", []),
]);

export function stubMp4(): ArrayBuffer {
  return STUB_MP4.buffer.slice(STUB_MP4.byteOffset, STUB_MP4.byteOffset + STUB_MP4.byteLength) as ArrayBuffer;
}

export const STUB_TASK_PREFIX = "stub-task";
// Poll counts per task id, per isolate: the first poll answers RUNNING, the second
// SUCCEEDED (SPEC_V3 FF, "SUCCEEDED on the second poll").
const stubPolls = new Map<string, number>();
let stubTaskCounter = 0;

export const stubVideoProvider: VideoProvider = {
  name: "stub",
  async startImageToVideo(_env: Env, req: VideoStartRequest): Promise<{ id: string }> {
    if (!req.promptImage) throw new ProviderError("stub", "bad_request", "no source image", 400, false);
    stubTaskCounter += 1;
    // A fresh id per clip, so a second clip in the same isolate also takes two polls.
    return { id: STUB_TASK_PREFIX + "-" + stubTaskCounter };
  },
  async taskStatus(_env: Env, id: string): Promise<VideoTaskStatus> {
    const n = (stubPolls.get(id) ?? 0) + 1;
    stubPolls.set(id, n);
    if (n < 2) return { status: "RUNNING", output: [], failure: null, failureCode: null };
    return { status: "SUCCEEDED", output: ["stub://" + id + ".mp4"], failure: null, failureCode: null };
  },
  async fetchOutput(_env: Env, _url: string): Promise<ArrayBuffer> {
    return stubMp4();
  },
};
