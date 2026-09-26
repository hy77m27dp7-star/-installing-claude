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
import { STUB_BLIND_MODEL, base64ToBytes, imagesOf, isHimRef } from "../vision";

// Built at runtime so the typography scan of this file stays clean.
const EM_DASH = String.fromCharCode(0x2014);

const PROPOSAL_PREFIX = "You read one exchange";
// chat.ts retryMessages: the note appended as the last user turn on a retry.
const RETRY_NOTE_PREFIX = "OPERATOR NOTE (not part of the story";
const STUB_MARKER_RE = /\[\[[A-Z_]+(?::[^\]]*)?\]\]/g;

function stripStubMarkers(text: string): string {
  const out = text.replace(STUB_MARKER_RE, " ").replace(/\s+/g, " ").trim();
  return out || "ok";
}

// The user turn before the last one (the real message under a retry's operator note).
function previousUserContent(messages: GenerateRequest["messages"]): string {
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "user") continue;
    seen += 1;
    if (seen === 2) return m.content;
  }
  return "";
}
const OPERATOR_PREFIX = "You are the operator console";
// v3.1 (SPEC_V3 JJ): the "Describe from photo" pass (hisFace.ts DESCRIBE_SYSTEM) answers a
// fixed plausible description, so the route runs keyless in the integration suite.
const DESCRIBE_PREFIX = "Describe this man";
// v4 (SPEC_V4 section 1): the "listening to" line (phone.ts LISTENING_PREFIX). A COPY of
// the string, never an import: phone.ts imports providers/index.ts, which imports this
// file, so an import the other way would be a module cycle. phone_v4 asserts the two
// strings are equal.
const LISTENING_PREFIX = "Name one real song";
const LISTENING_REPLY = "{\"artist\":\"Stub Artist\",\"title\":\"Stub Song\",\"line\":\"stuck in my head since the shop\"}";
export const STUB_LOOK = "Medium build, a little over average height. Short dark hair, a close-cut beard with some grey in it, dark eyes, no glasses. Looks around forty. The first things anyone notices are the beard and the steady look.";
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
// v4 (Amendment A3): a clip she sends, the way she sends a photo. The prose describes nothing twice.
const CLIP_REPLY = "ok one. do not make it a thing\n[clip: she looks up from the record and half smiles, then looks away]";
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
// v4 proposal triggers (SPEC_V4 section 8, "Stub additions"): a scene proposal whose payload
// carries status together and a location ([[SCENE:x]]; the bare [[SCENE]] carries a summary
// only), and a relationship proposal whose payload carries status and his_name
// ([[REL:status|name]]). The payload shapes are the ones proposals.ts mergeSceneState and
// mergeRelationshipState read.
const SCENE_MARKER = /\[\[SCENE(?::([^\]]*))?\]\]/g;
const REL_MARKER = /\[\[REL:([^\]|]*)(?:\|([^\]]*))?\]\]/g;
const NAME_MARKER = /\[\[NAME:([^\]]+)\]\]/;
const MEDIA_MARKER = /\[\[MEDIA:([^\]]+)\]\]/;
// v3 story triggers (SPEC_V3 AA, CC).
const EXEMPLAR_MARKER = /\[\[EXEMPLAR:([^\]]+)\]\]/;
// [[NAG:x]] nags about x; the bare [[NAG]] nags about the open ask the system prompt shows
// ("You asked him: ..."), so his own message carries none of the ask's words (an ask he
// raises himself is answered, never nagged, checks.ts ask_nag).
const NAG_MARKER = /\[\[NAG(?::([^\]]*))?\]\]/;
const ASKED_LINE_RE = /You asked him: "([^"]+)"/;
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
    // v4 (SPEC_V4 section 8): the scene as a place, and where they stand.
    for (const hit of m.content.matchAll(SCENE_MARKER)) {
      const x = (hit[1] ?? "").trim();
      if (x) {
        out.push({ kind: "scene", proposal: "they are together at " + x, evidence: "[[SCENE:" + x + "]]", confidence: "high", scope: "general", payload: { status: "together", location: x } });
      } else {
        out.push({ kind: "scene", proposal: "the scene moved on, same place", evidence: "[[SCENE]]", confidence: "high", scope: "general" });
      }
    }
    for (const hit of m.content.matchAll(REL_MARKER)) {
      const status = (hit[1] ?? "").trim();
      const name = (hit[2] ?? "").trim();
      if (!status) continue;
      const payload: Record<string, unknown> = { status };
      if (name) payload.his_name = name;
      out.push({
        kind: "relationship", proposal: "they are " + status + (name ? "; his name is " + name : ""), evidence: "[[REL:" + status + (name ? "|" + name : "") + "]]",
        confidence: "high", scope: "general", payload,
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

function storyReply(last: string, withImages: boolean, model: string, system = "", hisRefs = 0): { text: string; stopReason: GenerateResult["stopReason"] } {
  if (last.includes("[[FAIL]]")) throw new ProviderError("stub", "server", "stub failure", 502, true);
  // v3 (HH): the tasting side fails alone, so the void rule can be exercised.
  if (last.includes("[[BFAIL]]") && model === STUB_B_MODEL) throw new ProviderError("stub", "server", "stub failure on side B", 502, true);
  if (last.includes("[[REFUSE]]")) return { text: "", stopReason: "refusal" };
  // v3.1 (JJ): says how many of his reference photos rode on this call (the pipeline's
  // prepend is the thing under test; the number is what the call actually received).
  if (last.includes("[[HISFACE]]")) return { text: "i know your face. " + hisRefs + " on file", stopReason: "end" };
  if (withImages) return { text: PHOTO_IN_REPLY, stopReason: "end" };
  if (last.includes("[[VOICE]]")) return { text: VOICE_REPLY, stopReason: "end" };
  const media = MEDIA_MARKER.exec(last);
  if (media && media[1] && media[1].trim()) return { text: MEDIA_PREFIX_REPLY + media[1].trim() + "]", stopReason: "end" };
  if (last.includes("[[EMDASH]]")) return { text: "wait " + EM_DASH + " no, hold on. that is not what i meant", stopReason: "end" };
  if (last.includes("[[LIST]]")) return { text: "ok here is the plan\n- coffee first\n- then the park\n- then nothing", stopReason: "end" };
  if (last.includes("[[PHOTO]]")) return { text: PHOTO_REPLY, stopReason: "end" };
  // v4 (Amendment A3): a clip line, parsed by markers.ts parseClipMarker.
  if (last.includes("[[CLIP]]")) return { text: CLIP_REPLY, stopReason: "end" };
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
  if (nag) {
    const x = (nag[1] ?? "").trim() || (ASKED_LINE_RE.exec(system)?.[1] ?? "").trim();
    if (x) return { text: "so about " + x + ". still there. just saying", stopReason: "end" };
  }
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
    } else if (req.system.startsWith(DESCRIBE_PREFIX)) {
      text = STUB_LOOK;
    } else if (req.system.startsWith(LISTENING_PREFIX)) {
      // v4: the phone panel's one small call a day (phone.ts listeningNow).
      text = LISTENING_REPLY;
    } else {
      const lastMessage = [...req.messages].reverse().find((m) => m.role === "user");
      // A retry's last user turn is chat.ts's operator note. The stub answers the previous
      // real message with its triggers stripped, so a retried draft comes back clean (the
      // note's own words would read as a tech leak and hide what the first draft raised).
      const retry = last.startsWith(RETRY_NOTE_PREFIX);
      const subject = retry ? stripStubMarkers(previousUserContent(req.messages)) : last;
      // v3.1: his reference photos (him/ keys) are not a photo he sent; only his own count.
      // On a retry the real message is the one before the note, and its pictures too.
      const pictured = retry ? [...req.messages].reverse().filter((m) => m.role === "user")[1] : lastMessage;
      // v3.1 fix 1: the blind stub model opens no picture at all (a text-only performer),
      // so [[HISFACE]] answers 0 on it and his own photo never reads as received.
      const refs = pictured && req.model !== STUB_BLIND_MODEL ? imagesOf(pictured) : [];
      const hisRefs = refs.filter((i) => isHimRef(i)).length;
      const r = storyReply(subject, refs.length - hisRefs > 0, req.model, req.system, hisRefs);
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
  // v4 (SPEC_V4 section 3): `req.him` (his tagged reference on a with-him picture) is
  // ignored here on purpose; the tag and body check is a unit test on the Runway adapter
  // with a recording fetch. The answer is the 03_ reference or else the FIRST one.
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

// ------------------------------------------------------------------ Runway stand-in (photos, 2026-09-25)

// A fake of the three Runway calls the image adapter makes (POST /v1/text_to_image, GET
// /v1/tasks/{id}, GET the output URL; DELETE /v1/tasks/{id} is recorded), so the whole
// request shaping, polling and error mapping runs in the unit suite without a key or a
// wait. The output is the first reference's own bytes decoded from its data URI (the
// same trick the image stub plays with master 03), so a caller can check the picture
// that comes back is the one that went in. Every request is recorded with its headers
// and parsed body for assertions.
export interface StubRunwayOptions {
  // How many status reads answer RUNNING before SUCCEEDED (default 1; -1 = forever).
  runningPolls?: number;
  // A terminal failure instead of a success.
  fail?: { status: "FAILED" | "CANCELLED"; failureCode?: string; failure?: string };
  // An HTTP status for the start call (429, 500, ...) with a JSON error body, instead of a task.
  startStatus?: number;
  // Bytes to answer the output URL with; default: the first reference's bytes (or a 1x1 PNG).
  output?: ArrayBuffer;
  // An HTTP status for the output download instead of the bytes.
  outputStatus?: number;
}

export interface StubRunwayRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface StubRunway {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  requests: StubRunwayRequest[];
  taskIds: string[];
}

export const STUB_RUNWAY_OUTPUT_ORIGIN = "https://stub-runway.invalid";

function headerMap(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  const h = init?.headers;
  if (!h) return out;
  if (h instanceof Headers) {
    h.forEach((v, k) => { out[k.toLowerCase()] = v; });
  } else if (Array.isArray(h)) {
    for (const [k, v] of h) out[String(k).toLowerCase()] = String(v);
  } else {
    for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v);
  }
  return out;
}

function firstReferenceBytes(body: unknown): ArrayBuffer | null {
  const refs = typeof body === "object" && body !== null ? (body as { referenceImages?: unknown }).referenceImages : null;
  const first = Array.isArray(refs) ? refs[0] : null;
  const uri = typeof first === "object" && first !== null ? (first as { uri?: unknown }).uri : null;
  if (typeof uri !== "string" || !uri.startsWith("data:")) return null;
  const view = base64ToBytes(uri);
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

let stubRunwayCounter = 0;

export function stubRunwayFetch(options: StubRunwayOptions = {}): StubRunway {
  const requests: StubRunwayRequest[] = [];
  const taskIds: string[] = [];
  const polls = new Map<string, number>();
  const outputs = new Map<string, ArrayBuffer>();
  const runningPolls = options.runningPolls ?? 1;
  const json = (data: unknown, status = 200): Response =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = headerMap(init);
    let body: unknown = null;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    requests.push({ method, url, headers, body });
    const u = new URL(url);

    if (u.origin === STUB_RUNWAY_OUTPUT_ORIGIN) {
      if (options.outputStatus && options.outputStatus !== 200) return new Response("nope", { status: options.outputStatus });
      const id = u.pathname.split("/").pop() ?? "";
      const bytes = options.output ?? outputs.get(id) ?? (STUB_PNG.buffer.slice(STUB_PNG.byteOffset, STUB_PNG.byteOffset + STUB_PNG.byteLength) as ArrayBuffer);
      return new Response(bytes.slice(0), { status: 200, headers: { "content-type": "image/png", "content-length": String(bytes.byteLength) } });
    }

    if (!headers.authorization || !headers.authorization.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);
    if (!headers["x-runway-version"]) return json({ error: "X-Runway-Version header is required" }, 400);

    if (method === "POST" && u.pathname === "/v1/text_to_image") {
      if (options.startStatus && options.startStatus !== 200) return json({ error: "stub start failure " + options.startStatus }, options.startStatus);
      const b = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
      if (typeof b.promptText !== "string" || !b.promptText || typeof b.ratio !== "string" || typeof b.model !== "string") {
        return json({ error: "Invalid request", issues: [{ code: "invalid_type", path: ["promptText"], message: "Required" }] }, 400);
      }
      stubRunwayCounter += 1;
      const id = "stub-image-task-" + stubRunwayCounter;
      taskIds.push(id);
      const first = firstReferenceBytes(body);
      if (first) outputs.set(id, first);
      return json({ id, estimatedCost: { credits: 8 } });
    }

    const task = /^\/v1\/tasks\/([^/]+)$/.exec(u.pathname);
    if (task) {
      const id = decodeURIComponent(task[1] ?? "");
      if (!taskIds.includes(id)) return json({ error: "Task not found" }, 404);
      if (method === "DELETE") return json({});
      const n = (polls.get(id) ?? 0) + 1;
      polls.set(id, n);
      const created = "2026-09-25T12:00:00.000Z";
      if (runningPolls < 0 || n <= runningPolls) return json({ id, createdAt: created, status: "RUNNING", progress: 0.5, estimatedCost: { credits: 8 } });
      if (options.fail) {
        const { status, failureCode, failure } = options.fail;
        return json({ id, createdAt: created, status, failure: failure ?? "stub failure", failureCode: failureCode ?? null, cost: { credits: 8 } });
      }
      return json({ id, createdAt: created, status: "SUCCEEDED", output: [STUB_RUNWAY_OUTPUT_ORIGIN + "/output/" + id], cost: { credits: 8 } });
    }

    return json({ error: "Not found" }, 404);
  };

  return { fetch: fetchImpl, requests, taskIds };
}

// ------------------------------------------------------------------ Spotify stand-in (v4, SPEC_V4 section 4, A1)

// A fetch that answers the six Spotify calls src/spotify.ts makes, so the whole connect,
// token, search and add flow runs with no key (the integration runner passes
// --var SPOTIFY_STUB:1; the unit tests hand it in through the deps argument). The value is
// a FetchLike that also carries `requests` (every request, with its parsed body) and a
// `fetch` property pointing at itself, so both readings of "the stub fetch" work.
export interface StubSpotifyOptions {
  // What GET /v1/me reports as `product` (Amendment A1: the Premium check). Default premium.
  premium?: boolean;
}

export interface StubSpotifyRequest {
  method: string;
  url: string;
  body: unknown;
}

export type StubSpotifyFetch = ((url: string, init?: RequestInit) => Promise<Response>) & {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  requests: StubSpotifyRequest[];
  premium: boolean;
};

// A copy of src/spotify.ts SPOTIFY_SCOPES (spotify.ts imports this file; the other way
// would be a cycle). spotify_v4 may assert the two are equal.
export const STUB_SPOTIFY_SCOPES = "playlist-modify-private playlist-read-private streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state";
export const STUB_SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
export const STUB_SPOTIFY_USER = "stublistener";
export const STUB_SPOTIFY_PLAYLIST = "stubplaylist";
export const STUB_SPOTIFY_TRACK = "stubtrack";

function parseStubBody(init?: RequestInit): unknown {
  if (typeof init?.body !== "string") return null;
  const raw = init.body;
  try {
    return JSON.parse(raw);
  } catch {
    /* not JSON */
  }
  if (/^[A-Za-z0-9_%+.-]+=/.test(raw)) {
    const out: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
    return out;
  }
  return raw;
}

// The query's track: and artist: parts, for the echoed stub track.
function stubTrackFromQuery(q: string): { title: string; artist: string } {
  const m = /^track:(.*?)(?:\s+artist:(.*))?$/.exec(q.trim());
  const title = (m && m[1] ? m[1] : q).trim() || "Stub Song";
  const artist = (m && m[2] ? m[2] : "").trim() || "Stub Artist";
  return { title, artist };
}

export function stubSpotifyFetch(options: StubSpotifyOptions = {}): StubSpotifyFetch {
  const requests: StubSpotifyRequest[] = [];
  const premium = options.premium !== false;
  const json = (data: unknown, status = 200): Response =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

  const impl = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? "GET").toUpperCase();
    const body = parseStubBody(init);
    requests.push({ method, url, body });
    const u = new URL(url);

    if (method === "POST" && u.origin === "https://accounts.spotify.com" && u.pathname === "/api/token") {
      const form = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
      if (form.grant_type === "refresh_token" && form.refresh_token === "stub-revoked") {
        return json({ error: "invalid_grant", error_description: "Refresh token revoked" }, 400);
      }
      return json({ access_token: "stub-access", refresh_token: "stub-refresh", expires_in: 3600, scope: STUB_SPOTIFY_SCOPES, token_type: "Bearer" });
    }
    if (u.origin !== "https://api.spotify.com") return json({ error: { status: 404, message: "Not found" } }, 404);

    if (method === "GET" && u.pathname === "/v1/me") {
      return json({ id: STUB_SPOTIFY_USER, display_name: "Stub Listener", product: premium ? "premium" : "free" });
    }
    if (method === "POST" && u.pathname === "/v1/users/" + STUB_SPOTIFY_USER + "/playlists") {
      const b = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
      return json({ id: STUB_SPOTIFY_PLAYLIST, name: typeof b.name === "string" ? b.name : "songs from avelie" }, 201);
    }
    if (method === "GET" && u.pathname === "/v1/search") {
      const q = u.searchParams.get("q") ?? "";
      if (q.includes("[[NOTFOUND]]")) return json({ tracks: { items: [] } });
      const t = stubTrackFromQuery(q);
      return json({
        tracks: {
          items: [{
            id: STUB_SPOTIFY_TRACK, uri: "spotify:track:" + STUB_SPOTIFY_TRACK, name: t.title, artists: [{ name: t.artist }],
            external_urls: { spotify: "https://open.spotify.com/track/" + STUB_SPOTIFY_TRACK },
          }],
        },
      });
    }
    const add = /^\/v1\/playlists\/([^/]+)\/tracks$/.exec(u.pathname);
    if (method === "POST" && add) {
      if (add[1] !== STUB_SPOTIFY_PLAYLIST) return json({ error: { status: 404, message: "Not found." } }, 404);
      return json({ snapshot_id: "stub" }, 201);
    }
    const one = /^\/v1\/playlists\/([^/]+)$/.exec(u.pathname);
    if (method === "GET" && one) {
      if (one[1] !== STUB_SPOTIFY_PLAYLIST) return json({ error: { status: 404, message: "Not found." } }, 404);
      return json({ id: STUB_SPOTIFY_PLAYLIST, name: "songs from avelie" });
    }
    // The player's own calls (Amendment A1) go from the browser, never through here.
    return json({ error: { status: 404, message: "Not found" } }, 404);
  };

  const f = impl as StubSpotifyFetch;
  f.fetch = impl;
  f.requests = requests;
  f.premium = premium;
  return f;
}

// ------------------------------------------------------------------ ElevenLabs stand-in (v4, Amendment A2; the [[ELEVEN]] stub)

// The shape lane L10 stated: the conversation token mint answers { token: "stub-token" }
// (the signed-url fallback answers a wss:// URL on an .invalid host), and text-to-speech
// answers 64 bytes of a fixed pattern as audio/mpeg. Every request is recorded. Any other
// URL is 404. No key is read or checked: a missing xi-api-key header is recorded, not refused.
export const STUB_ELEVEN_TOKEN = "stub-token";
export const STUB_ELEVEN_SIGNED_URL = "wss://stub-elevenlabs.invalid/v1/convai/conversation?agent_id=stub";
const STUB_ELEVEN_BYTES = 64;

export function stubElevenMp3(): ArrayBuffer {
  const out = new Uint8Array(STUB_ELEVEN_BYTES);
  for (let i = 0; i < out.length; i++) out[i] = (i * 7 + 3) & 0xff;
  return out.buffer;
}

export interface StubElevenRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export type StubElevenFetch = ((url: string, init?: RequestInit) => Promise<Response>) & {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  requests: StubElevenRequest[];
};

export function stubElevenLabsFetch(): StubElevenFetch {
  const requests: StubElevenRequest[] = [];
  const json = (data: unknown, status = 200): Response =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

  const impl = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = (init?.method ?? "GET").toUpperCase();
    requests.push({ method, url, headers: headerMap(init), body: parseStubBody(init) });
    const u = new URL(url);
    if (u.origin !== "https://api.elevenlabs.io") return json({ detail: "Not found" }, 404);
    if (method === "GET" && u.pathname === "/v1/convai/conversation/token") return json({ token: STUB_ELEVEN_TOKEN });
    if (method === "GET" && u.pathname === "/v1/convai/conversation/get-signed-url") return json({ signed_url: STUB_ELEVEN_SIGNED_URL });
    if (method === "POST" && u.pathname.startsWith("/v1/text-to-speech/")) {
      const bytes = stubElevenMp3();
      return new Response(bytes, { status: 200, headers: { "content-type": "audio/mpeg", "content-length": String(bytes.byteLength) } });
    }
    return json({ detail: "Not found" }, 404);
  };

  const f = impl as StubElevenFetch;
  f.fetch = impl;
  f.requests = requests;
  return f;
}

// The same stub under the shorter name the amendment uses ("the [[ELEVEN]] stub").
export const stubElevenFetch = stubElevenLabsFetch;
