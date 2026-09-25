// She can see (SPEC_V2 section T): the photos he attaches ride on ChatMessage.images as
// R2 keys, and the provider adapters turn them into what each API wants (Anthropic image
// blocks, OpenAI image_url data URLs, a Workers AI vision model's content parts). A
// performer that cannot see gets one plain line instead, so she never pretends.
//
// Pure helpers plus one R2 read. No database, no provider calls, no Node-only APIs.
import type { ChatMessage, Env } from "./types";

export interface ImageRef {
  key: string;
  mime: string;
}

export interface ImageBlock extends ImageRef {
  base64: string;
  bytes: number;
}

export type ImageMime = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

// Only the last six of his messages carry their photos into a call (cost).
export const MAX_IMAGE_MESSAGES = 6;
// The same ceiling the upload route enforces; a larger object is skipped, never sent.
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
// The line a model that cannot see gets in place of the picture.
export const UNSEEN_PHOTO_LINE = "(he sent a photo you could not open)";
// v3.1 (SPEC_V3 section JJ): his reference photos live under this R2 prefix and ride on
// the final user turn of a call only; they are never something he just sent, so the
// "could not open" line never counts them and the stub never reads them as an inbox photo.
export const HIM_PREFIX = "him/";

export function isHimRef(ref: { key: string } | string): boolean {
  const key = typeof ref === "string" ? ref : ref && typeof ref.key === "string" ? ref.key : "";
  return key.startsWith(HIM_PREFIX);
}

// Workers AI model ids that take images in a chat call. Kept broad on purpose: a new
// vision model should not silently fall back to the "could not open" line.
const VISION_MODEL_RE = /vision|llava|llama-4|scout|maverick|gemma-3|qwen[^/]*vl|pixtral|phi-4-multimodal/i;

export function isVisionModel(model: string): boolean {
  return typeof model === "string" && VISION_MODEL_RE.test(model);
}

// v3.1 fix 1: the one stub model that cannot look at a picture, so the keyless suites can
// exercise the cannot-see branch (a tasting side on a text-only model, hisFace.ts
// performerCanSee). Every other stub model pretends to see.
export const STUB_BLIND_MODEL = "stub-blind";

// The four types the APIs accept; anything else is sent as jpeg (the bytes were sniffed
// on upload, so an unknown value here is a missing one, not a wrong one).
export function imageMime(mime: string | null | undefined): ImageMime {
  const m = (mime ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (m === "image/png" || m === "image/webp" || m === "image/gif") return m;
  return "image/jpeg";
}

type Base64Static = { fromBase64?: (s: string) => Uint8Array };
type Base64Proto = { toBase64?: () => string };

// Base64 for multi-megabyte buffers: the native encoder where the runtime has it, else
// btoa over 32 KB chunks (a single fromCharCode over the whole buffer blows the stack).
export function bytesToBase64(input: ArrayBuffer | Uint8Array): string {
  const view = input instanceof Uint8Array ? input : new Uint8Array(input);
  const native = (view as unknown as Base64Proto).toBase64;
  if (typeof native === "function") return native.call(view);
  const CHUNK = 0x8000;
  let s = "";
  for (let i = 0; i < view.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, Array.from(view.subarray(i, i + CHUNK)));
  }
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  const native = (Uint8Array as unknown as Base64Static).fromBase64;
  if (typeof native === "function") return native.call(Uint8Array, clean);
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function dataUrl(block: ImageBlock): string {
  return "data:" + imageMime(block.mime) + ";base64," + block.base64;
}

// Loads his photos from R2 as base64 blocks, in order. A missing, empty or oversize
// object is skipped and logged by key; nothing here throws, because a lost picture must
// never cost the turn.
export async function loadInboxImages(env: Env, keys: Array<string | ImageRef>): Promise<ImageBlock[]> {
  const out: ImageBlock[] = [];
  for (const k of keys) {
    const ref: ImageRef = typeof k === "string" ? { key: k, mime: "" } : { key: k.key, mime: k.mime ?? "" };
    if (!ref.key || typeof ref.key !== "string") continue;
    try {
      const obj = await env.MEDIA.get(ref.key);
      if (!obj) {
        console.warn("inbox image missing", ref.key);
        continue;
      }
      if (obj.size > MAX_IMAGE_BYTES) {
        console.warn("inbox image too large", ref.key, obj.size);
        continue;
      }
      const bytes = await obj.arrayBuffer();
      if (!bytes.byteLength) continue;
      const mime = ref.mime || obj.httpMetadata?.contentType || "";
      out.push({ key: ref.key, mime: imageMime(mime), base64: bytesToBase64(bytes), bytes: bytes.byteLength });
    } catch (e) {
      console.warn("inbox image unreadable", ref.key, e instanceof Error ? e.name : "error");
    }
  }
  return out;
}

export function imagesOf(m: ChatMessage): ImageRef[] {
  if (!m || !Array.isArray(m.images)) return [];
  return m.images.filter((i): i is ImageRef => typeof i === "object" && i !== null && typeof i.key === "string" && i.key.length > 0);
}

export function hasImages(messages: ChatMessage[]): boolean {
  return messages.some((m) => imagesOf(m).length > 0);
}

// Keeps images only on the last `max` of his messages; older ones go back to plain text
// (the conversation still says what happened around them).
export function limitImageMessages(messages: ChatMessage[], max = MAX_IMAGE_MESSAGES): ChatMessage[] {
  let seen = 0;
  const out: ChatMessage[] = new Array<ChatMessage>(messages.length);
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "user" && imagesOf(m).length) {
      seen++;
      if (seen > max) {
        const { images: _dropped, ...rest } = m;
        out[i] = rest;
        continue;
      }
    }
    out[i] = m;
  }
  return out;
}

// The message with its pictures gone and the honest line in their place, for a model
// that cannot look at them.
// His own reference photos (v3.1) are not something he sent: with only those attached
// the message goes as plain text and no line is added.
export function withoutImages(m: ChatMessage): ChatMessage {
  const { images: _dropped, ...rest } = m;
  if (!imagesOf(m).some((i) => !isHimRef(i))) return rest;
  const text = rest.content.trim();
  return { ...rest, content: text ? text + "\n" + UNSEEN_PHOTO_LINE : UNSEEN_PHOTO_LINE };
}
