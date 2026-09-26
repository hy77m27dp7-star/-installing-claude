// What he looks like (v3.1, SPEC_V3 section JJ). Justin's words: "she needs to know what i
// look like in her fucking code". Two things make that durable: his reference photos
// (visual_assets rows with role "him", the bytes in R2 under him/, owner-uploaded and
// approved at upload, never generated, at most hisFaceMax) and the description in words
// (settings.hisLookText, at most 600 characters, written by him or drafted by the
// performer's own eyes through describeHim and saved only when he says so).
//
// The prompt carries a WHAT HE LOOKS LIKE section whenever either exists (prompt.ts places
// it right after WHAT YOU KNOW ABOUT HIM), and on the turns shouldShowFace says yes the
// photos are prepended to the final user turn of the provider call only (context.ts): never
// written to his message, never shown in the chat, never counted against the six-message
// picture window. The pure rule lives at the top of this file so it unit-tests without a
// database; the D1 and provider helpers follow.
import { HIM_PREFIX, STUB_BLIND_MODEL, imageMime, isVisionModel } from "./vision";
import type { ImageRef } from "./vision";
import { assertBudget, costMicro, estimateUsd } from "./budget";
import { getTextProvider, providerConfigured } from "./providers/index";
import { safeErrorMessage } from "./providers/types";
import { dayKey, insertModelRunStmt, newId, nowIso, usageStmt } from "./db";
import { ApiHttpError } from "./errors";
import { ProviderError } from "./types";
import type { Env, HisLook, ModelRunRow, ProviderName, SceneMode, Settings, VisualAssetRow } from "./types";

export { HIM_PREFIX } from "./vision";
export const HIM_ROLE = "him";
export const LOOK_MAX_CHARS = 600;
export const HIS_FACE_MAX_LIMIT = 3;
export const HIS_FACE_APART_EVERY_LIMIT = 50;
export const HIS_FACE_DEFAULTS = { hisLookText: "", hisFaceMax: 3, hisFaceInTogether: true, hisFaceApartEvery: 8 } as const;
// v3.1 fix 2: the turns-since count the caller uses when the cadence read FAILED (the
// conversations.his_face_seq column not there yet, before 0007; a broken query). Zero reads
// as "just shown", the cheap failure: the Apart cadence then waits for the migration, and
// the photos still ride on his first turn, on Together turns and whenever he mentions his
// looks. Never Infinity: that is "never shown", the row's own null, and on a database
// without the column it would put every photo on every Apart turn.
export const FACE_CADENCE_UNREADABLE = 0;

// The section's first line, and the line that stands in for the words while none are on file.
export const LOOK_SECTION_HEADER = "WHAT HE LOOKS LIKE (his face; you know it the way you know any face you have looked at, without narrating it)";
export const LOOK_NO_WORDS_LINE = "- you have seen his face; no words on file yet";

// The system prompt of the "Describe from photo" call. The stub provider recognises the
// pass by its first words (DESCRIBE_PREFIX); keep them first.
export const DESCRIBE_SYSTEM = "Describe this man for someone who will need to recognise him: build, hair, facial hair, eyes if visible, glasses, skin, age impression, the one or two things anyone notices first. Plain words, two to four sentences, no compliments, no guesses about his character.";
export const DESCRIBE_PREFIX = "Describe this man";
const DESCRIBE_USER = "These are photos of the same man. Describe him.";
const DESCRIBE_MAX_TOKENS = 300;
// Rough input cost of one photo for the pre-call estimate: about 1,600 tokens on Anthropic
// for a 2000x2000 picture, at the estimator's four characters per token.
export const IMAGE_ESTIMATE_CHARS = 1600 * 4;

// His looks, mentioned: a small list, case-insensitive, whole words where sensible.
const LOOKS_RE = /\b(?:looks? like|my face|my hair|my beard|my glasses|handsome|ugly|older|younger|selfies?|(?:picture|photo|pic) of me)\b/i;

// Built from code points so this file passes the typography scan.
const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);
const ELLIPSIS = String.fromCharCode(0x2026);
const DASH_RE = new RegExp("\\s*[" + EM_DASH + EN_DASH + "]\\s*", "g");
const ELLIPSIS_RE = new RegExp(ELLIPSIS, "g");

// ------------------------------------------------------------------ pure

export interface HisFaceSettings {
  hisLookText: string;
  hisFaceMax: number;
  hisFaceInTogether: boolean;
  hisFaceApartEvery: number;
}

function intIn(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(v)));
}

// The four settings as the code reads them: the defaults for a missing key (the live
// settings table is not reseeded on deploy), the bounds for a stored value out of range.
export function hisFaceSettings(settings: Partial<Settings> | Record<string, unknown> | null | undefined): HisFaceSettings {
  const s = (settings ?? {}) as Record<string, unknown>;
  return {
    hisLookText: typeof s.hisLookText === "string" ? cleanLookText(s.hisLookText) : HIS_FACE_DEFAULTS.hisLookText,
    hisFaceMax: intIn(s.hisFaceMax, 1, HIS_FACE_MAX_LIMIT, HIS_FACE_DEFAULTS.hisFaceMax),
    hisFaceInTogether: typeof s.hisFaceInTogether === "boolean" ? s.hisFaceInTogether : HIS_FACE_DEFAULTS.hisFaceInTogether,
    hisFaceApartEvery: intIn(s.hisFaceApartEvery, 0, HIS_FACE_APART_EVERY_LIMIT, HIS_FACE_DEFAULTS.hisFaceApartEvery),
  };
}

// The description as stored: house typography (" -- " and "..."), single spaces, trimmed.
// Length is the caller's to refuse (the route answers 400 over LOOK_MAX_CHARS; the
// describe call cuts at the cap).
export function cleanLookText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(DASH_RE, " -- ")
    .replace(ELLIPSIS_RE, "...")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n+ */g, "\n")
    .trim();
}

export function mentionsHisLooks(text: unknown): boolean {
  return typeof text === "string" && LOOKS_RE.test(text);
}

// Whether the performer can look at a picture at all. Anthropic and OpenAI chat models
// see; the stub pretends to (except STUB_BLIND_MODEL, the suites' text-only stand-in); a
// Workers AI model only when its id says vision.
export function performerCanSee(provider: ProviderName | string, model: string): boolean {
  switch (provider) {
    case "anthropic":
    case "openai":
      return true;
    case "stub":
      return model !== STUB_BLIND_MODEL;
    case "workersai":
      return isVisionModel(model);
    default:
      return false;
  }
}

// Whether every performer the call goes to can see. A plain turn names one; a tasting turn
// names two (the live performer and side B), and both read the same system text and the
// same messages, so the photos ride for both or for neither: a side that cannot see would
// otherwise be told about pictures its adapter never sent. An empty list sees nothing.
export function performersCanSee(performers: ReadonlyArray<{ provider: ProviderName | string; model: string }>): boolean {
  return performers.length > 0 && performers.every((p) => p && performerCanSee(p.provider, p.model));
}

// His first turn of a conversation: no story row of his exists before this one. Her opener
// (POST /open) and her first texts are her rows, so a conversation she began still has his
// first turn ahead of it; the pending row is his own message on an idempotent resume. The
// rows are the recent window (oldest first or any order); an all-hers window counts as his
// first turn, which a window shorter than her run of unanswered texts can only get wrong
// by showing the photos once more.
export function isHisFirstTurn(rows: ReadonlyArray<{ id: string; role: string }>, pendingMessageId: string | null): boolean {
  return rows.every((r) => r.role === "assistant" || r.id === pendingMessageId);
}

export interface ShowFaceArgs {
  mode: SceneMode;
  isFirstTurnOfConversation: boolean;
  // Her replies since the photos last rode along in this conversation, plus this turn:
  // Infinity when never (the row says null), FACE_CADENCE_UNREADABLE (0, just shown) when
  // the read failed. Anything that is not a number reads as unreadable, never as never.
  turnsSinceLastShown: number;
  userText: string;
  settings: Partial<HisFaceSettings> | Settings | Record<string, unknown>;
  // false when a performer on the call cannot see (performersCanSee: on a tasting turn both
  // sides must); the section then carries no attached-photos line.
  canSee?: boolean;
}

// The rule (SPEC_V3 JJ): never when a performer on the call cannot see; his first turn of a
// conversation (isHisFirstTurn: her opener does not count); any turn where he mentions his
// looks; every Together turn while hisFaceInTogether is on; in Apart mode every
// hisFaceApartEvery-th turn (0 = never).
export function shouldShowFace(args: ShowFaceArgs): boolean {
  if (args.canSee === false) return false;
  const s = hisFaceSettings(args.settings as Record<string, unknown>);
  if (args.isFirstTurnOfConversation) return true;
  if (mentionsHisLooks(args.userText)) return true;
  if (args.mode === "together") return s.hisFaceInTogether;
  if (args.mode === "apart") {
    if (s.hisFaceApartEvery <= 0) return false;
    const since = typeof args.turnsSinceLastShown === "number" && !Number.isNaN(args.turnsSinceLastShown) ? args.turnsSinceLastShown : FACE_CADENCE_UNREADABLE;
    return since >= s.hisFaceApartEvery;
  }
  return false;
}

// The one line under the words when his photos ride on this turn.
export function attachedLine(n: number): string {
  if (n === 1) {
    return "The first picture attached to his message is your reference photo of him, on file; it is not something he just sent. Never mention it, never thank him for it, never ask why he sent a picture of himself.";
  }
  return `The first ${n} pictures attached to his message are your reference photos of him, on file; they are not something he just sent. Never mention them, never thank him for them, never ask why he sent a picture of himself.`;
}

// The WHAT HE LOOKS LIKE section: present when the words exist or at least one photo is on
// file, omitted entirely otherwise (the prompt bytes then equal a tree without this feature).
export function hisLookSection(look: HisLook | null | undefined): string {
  if (!look) return "";
  const text = cleanLookText(look.text);
  const photos = Array.isArray(look.photos) ? look.photos.length : 0;
  if (!text && photos <= 0) return "";
  const lines = [LOOK_SECTION_HEADER, text || LOOK_NO_WORDS_LINE];
  const attached = typeof look.attached === "number" && Number.isFinite(look.attached) ? Math.max(0, Math.trunc(look.attached)) : 0;
  if (attached > 0) lines.push(attachedLine(attached));
  return lines.join("\n");
}

// The mime of a stored reference photo, from its key's extension (the bytes were sniffed
// on upload, so the extension is the truth).
export function mimeOfKey(key: string): string {
  const ext = (key.split(".").pop() ?? "").toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
}

// The refs the adapters load: the rows as given (newest first, already capped).
export function himRefs(photos: Array<{ key: string; mime?: string }>): ImageRef[] {
  return photos
    .filter((p) => p && typeof p.key === "string" && p.key.startsWith(HIM_PREFIX))
    .map((p) => ({ key: p.key, mime: imageMime(p.mime || mimeOfKey(p.key)) }));
}

// ------------------------------------------------------------------ D1

// His reference photos, newest first, at most `max` (the setting's value when omitted).
export async function listHimPhotos(db: D1Database, max = HIS_FACE_MAX_LIMIT): Promise<VisualAssetRow[]> {
  const n = intIn(max, 1, HIS_FACE_MAX_LIMIT, HIS_FACE_MAX_LIMIT);
  const r = await db
    .prepare("SELECT * FROM visual_assets WHERE role = ?1 AND approval_status = 'approved' ORDER BY created_at DESC, id DESC LIMIT ?2")
    .bind(HIM_ROLE, n)
    .all<VisualAssetRow>();
  return r.results;
}

export async function countHimPhotos(db: D1Database): Promise<number> {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM visual_assets WHERE role = ?1 AND approval_status = 'approved'").bind(HIM_ROLE).first<{ n: number }>();
  return Number(r?.n ?? 0);
}

// ------------------------------------------------------------------ him in a picture (v4, SPEC_V4 section 3)

// Whether his reference photo may ride into a picture of the two of them (the setting
// hisFaceInPhotos, default true; a table without the key reads as on). Read here rather
// than through hisFaceSettings so that function's shape stays what the v3.1 suite compares.
export function hisFaceInPhotosEnabled(settings: Partial<Settings> | Record<string, unknown> | null | undefined): boolean {
  const v = ((settings ?? {}) as Record<string, unknown>).hisFaceInPhotos;
  return v !== false;
}

// The data URI cap of the image models that take references (Runway's referenceImages;
// the same 5 MB video.ts MAX_ENCODED_SOURCE applies to a clip's source). The arithmetic is
// video.ts encodedDataUriLength's, kept here so this module pulls in no pipeline module
// (video.ts imports images.ts, which imports this file).
export const HIM_REFERENCE_MAX_ENCODED = 5 * 1024 * 1024;

export function himReferenceEncodedLength(byteLength: number, mime: string): number {
  const n = typeof byteLength === "number" && Number.isFinite(byteLength) ? Math.max(0, byteLength) : 0;
  return ("data:" + mime + ";base64,").length + Math.ceil(n / 3) * 4;
}

export interface HimReference { id: string; name: string; bytes: ArrayBuffer; mime: string; tooLarge?: false }
export interface HimReferenceTooLarge { id: string; name: string; bytes: null; mime: string; tooLarge: true }

// The newest approved photo of him as an image reference: its bytes from R2, or null when
// none is on file (or its file is gone). A photo whose data URI would pass the cap answers
// bytes null and tooLarge true; the caller treats that as none and flags him_photo_too_large.
export async function loadHimReference(env: Env, db: D1Database): Promise<HimReference | HimReferenceTooLarge | null> {
  const rows = await listHimPhotos(db, 1);
  const row = rows[0];
  if (!row) return null;
  const mime = mimeOfKey(row.file);
  const name = row.file.split("/").pop() || row.id;
  const obj = await env.MEDIA.get(row.file);
  if (!obj) return null;
  if (himReferenceEncodedLength(obj.size, mime) > HIM_REFERENCE_MAX_ENCODED) {
    try { await obj.body?.cancel(); } catch { /* the stream was never read */ }
    return { id: row.id, name, bytes: null, mime, tooLarge: true };
  }
  const bytes = await obj.arrayBuffer();
  if (himReferenceEncodedLength(bytes.byteLength, mime) > HIM_REFERENCE_MAX_ENCODED) {
    return { id: row.id, name, bytes: null, mime, tooLarge: true };
  }
  return { id: row.id, name, bytes, mime };
}

// Which turn since the photos last rode along this turn is, in this conversation: her
// replies since that one plus this turn itself, so the turn right after a showing is 1 and
// a cadence of N fires on every N-th turn (N = 1 is every turn). Infinity when never shown
// (the row's own null). Throws when the column is not there yet (a database before 0007):
// the caller (assembleContext) catches that and counts FACE_CADENCE_UNREADABLE, just shown,
// so a missing migration costs the Apart cadence and nothing else, never a failed turn and
// never the photos on every Apart turn.
export async function turnsSinceFaceShown(db: D1Database, conversationId: string): Promise<number> {
  const row = await db.prepare("SELECT his_face_seq FROM conversations WHERE id = ?1").bind(conversationId).first<{ his_face_seq: number | null }>();
  const seq = row && typeof row.his_face_seq === "number" && Number.isFinite(row.his_face_seq) ? row.his_face_seq : null;
  if (seq === null) return Number.POSITIVE_INFINITY;
  const r = await db
    .prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?1 AND channel = 'story' AND role = 'assistant' AND seq > ?2")
    .bind(conversationId, seq)
    .first<{ n: number }>();
  return Number(r?.n ?? 0) + 1;
}

// Records that the photos rode along on the turn her reply `seq` closed. Best effort by
// the caller (after the turn's batch): on a database without 0007 the write fails and is
// logged, and the cadence read above already counts that shape as just shown.
export function faceShownStmt(db: D1Database, conversationId: string, seq: number): D1PreparedStatement {
  return db.prepare("UPDATE conversations SET his_face_seq = ?2 WHERE id = ?1").bind(conversationId, seq);
}

// The HisLook the prompt state carries: the words on file and the photos, none attached yet.
export async function loadHisLook(db: D1Database, settings: Settings): Promise<HisLook> {
  const s = hisFaceSettings(settings);
  const rows = await listHimPhotos(db, s.hisFaceMax);
  return {
    text: s.hisLookText,
    photos: rows.map((r) => ({ id: r.id, key: r.file, mime: mimeOfKey(r.file) })),
    attached: 0,
  };
}

// ------------------------------------------------------------------ describe (a paid call)

function errorClass(e: unknown): string {
  if (e instanceof ProviderError) return e.kind;
  if (e instanceof Error) return e.name || "Error";
  return "error";
}

// The performer's own eyes on his reference photos: one call on settings.provider and
// settings.model with the photos as image blocks, charged through the same estimate,
// caps and usage row as any call (kind describe). Returns the words; saves nothing.
export async function describeHim(env: Env, db: D1Database, settings: Settings): Promise<{ look: string; run: ModelRunRow }> {
  const providerName = settings.provider;
  const model = settings.model;
  if (!providerConfigured(env, providerName)) throw new ApiHttpError(503, "provider_not_configured", `${providerName} is not configured`, false);
  if (!performerCanSee(providerName, model)) throw new ApiHttpError(409, "cannot_see", `${providerName} ${model} cannot look at a picture; switch the performer first`, false);
  const s = hisFaceSettings(settings);
  const rows = await listHimPhotos(db, s.hisFaceMax);
  if (!rows.length) throw new ApiHttpError(409, "no_photos", "upload a photo of him first", false);
  const refs = himRefs(rows.map((r) => ({ key: r.file })));

  const inputChars = DESCRIBE_SYSTEM.length + DESCRIBE_USER.length + refs.length * IMAGE_ESTIMATE_CHARS;
  await assertBudget(db, settings, estimateUsd(settings, model, inputChars, DESCRIBE_MAX_TOKENS));

  const provider = getTextProvider(providerName);
  const started = Date.now();
  const runBase = {
    id: newId("r"),
    conversation_id: null,
    kind: "describe" as const,
    provider: providerName,
    model,
    prompt_version: null,
    input_tokens: 0,
    output_tokens: 0,
    cost_usd_micro: 0,
    latency_ms: null,
    flags_json: null,
    created_at: nowIso(),
  };
  let result: Awaited<ReturnType<typeof provider.generate>>;
  try {
    result = await provider.generate(env, {
      system: DESCRIBE_SYSTEM,
      messages: [{ role: "user", content: DESCRIBE_USER, images: refs }],
      model,
      maxTokens: DESCRIBE_MAX_TOKENS,
      temperature: 0.2,
      effort: "low",
      cacheable: false,
    });
  } catch (e) {
    const failed: ModelRunRow = { ...runBase, latency_ms: Date.now() - started, status: "failed", error: errorClass(e) };
    try { await insertModelRunStmt(db, failed).run(); } catch { /* the run log is best effort */ }
    console.warn("describe call failed", errorClass(e), safeErrorMessage(e, 200));
    throw e;
  }
  const inputTokens = Math.max(0, result.inputTokens);
  const outputTokens = Math.max(0, result.outputTokens);
  const cost = costMicro(settings, model, inputTokens, outputTokens);
  const refused = result.stopReason === "refusal";
  const run: ModelRunRow = {
    ...runBase,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_usd_micro: cost.micro,
    latency_ms: Date.now() - started,
    status: refused ? "refused" : "ok",
    error: refused ? "refusal" : null,
    flags_json: cost.priceKnown ? null : JSON.stringify([{ code: "price_unknown", severity: "flag", detail: "no price for model " + model }]),
  };
  try {
    await db.batch([insertModelRunStmt(db, run), usageStmt(db, dayKey(), providerName, model, inputTokens, outputTokens, cost.micro)]);
  } catch (e) {
    console.warn("describe run not recorded", errorClass(e));
  }
  if (refused) throw new ApiHttpError(502, "provider_refused", "the model refused to describe the photo", false);
  const look = cleanLookText(result.text).slice(0, LOOK_MAX_CHARS).trim();
  if (!look) throw new ApiHttpError(502, "provider_failed", "the model answered nothing usable", true, "empty_reply");
  return { look, run };
}
