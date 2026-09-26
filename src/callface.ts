// The call face (SPEC_V4 section 2): three short looped clips of her, made once from a
// master through the same Runway image-to-video path a clip takes (video.ts startClip),
// owner-triggered, approved like any clip, and shown on the call sheet by the moment
// (idle, listening while he speaks, talking while her audio is above a level). Not a
// lip-synced avatar: no lip-sync provider exists on this Mac; the setting value
// "lipsync" is reserved for one (v4.1) and answers 503 reserved_v4_1 until then.
//
// The rows are visual_assets rows with role callface, file videos/<id>.mp4, prompt = the
// motion text, notes = the claim note while generating (with a kind:<kind> part), then
// "callface:<kind>" once the clip is a candidate (an approved clip may carry his decision
// note after " | "). One approved clip per kind: images.ts archives the earlier one.
import { listAssets } from "./db";
import { ApiHttpError } from "./errors";
import { clipCostUsd, startClip, videoSettingsOf } from "./video";
import type { Env, Settings, VisualAssetRow } from "./types";

export type CallFaceKind = "idle" | "listening" | "talking";
export const CALL_FACE_KINDS: readonly CallFaceKind[] = ["idle", "listening", "talking"];

export type CallFaceProvider = "clips" | "off" | "lipsync";
export const CALL_FACE_PROVIDERS: readonly CallFaceProvider[] = ["clips", "off", "lipsync"];
export const CALL_FACE_ROLE = "callface";
export const CALL_FACE_RATIO = "960:960";
export const CALL_FACE_SECONDS = 5;
export const CALL_FACE_DEFAULT_SOURCE = "master-00";
const NOTE_PREFIX = "callface:";
const CLAIM_KIND_PREFIX = "kind:";
const SOURCE_ID_RE = /^master-0[0-5]$/;

// The three motion texts (each under 1000 characters; no body-part words that trip
// moderation: the runway_image unit test's list is the rule).
export const CALL_FACE_PROMPTS: Record<CallFaceKind, string> = {
  idle: "She sits still and relaxed, looking just off camera, breathing softly, one slow blink, the faintest smile, no talking, no big movement, the camera does not move, the light does not change.",
  listening: "She looks at the camera and listens, attentive and warm, a small nod, her eyebrows lift a little, her mouth stays closed, the camera does not move, the light does not change.",
  talking: "She talks to the camera, relaxed, her mouth moving naturally as if mid-sentence, small head movements, natural expression, no text, the camera does not move, the light does not change.",
};

export interface CallFaceSettings {
  provider: CallFaceProvider;
  sourceAssetId: string;
}

export interface CallFaceState {
  provider: CallFaceProvider;
  source: string;
  clips: Record<CallFaceKind, VisualAssetRow | null>;
  candidates: VisualAssetRow[];
  generating: VisualAssetRow[];
  ready: boolean;
}

// ------------------------------------------------------------------ pure pieces

export function isCallFaceKind(x: unknown): x is CallFaceKind {
  return typeof x === "string" && (CALL_FACE_KINDS as readonly string[]).includes(x);
}

// The two v4 settings as stored, the spec's defaults for a value that is missing or
// malformed (the settings type is the pipeline lane's; this reads the keys by name).
export function callFaceSettingsOf(settings: Partial<Settings> | Record<string, unknown> | null | undefined): CallFaceSettings {
  const s = (settings ?? {}) as Record<string, unknown>;
  const provider = typeof s.callFaceProvider === "string" && (CALL_FACE_PROVIDERS as readonly string[]).includes(s.callFaceProvider)
    ? (s.callFaceProvider as CallFaceProvider)
    : "clips";
  const sourceAssetId = typeof s.callFaceSourceAssetId === "string" && SOURCE_ID_RE.test(s.callFaceSourceAssetId.trim())
    ? s.callFaceSourceAssetId.trim()
    : CALL_FACE_DEFAULT_SOURCE;
  return { provider, sourceAssetId };
}

export function callFaceNote(kind: CallFaceKind): string {
  return NOTE_PREFIX + kind;
}

// The kind a callface row's notes name: a bare "callface:idle", an approved clip's
// "callface:idle | good" (images.ts appends a decision note after " | "), or a generating
// clip's claim note "source:...|task:...|since ...|kind:idle". Null otherwise.
export function callFaceKindOf(notes: string | null | undefined): CallFaceKind | null {
  if (typeof notes !== "string" || !notes) return null;
  for (const raw of notes.split("|")) {
    const part = raw.trim();
    const value = part.startsWith(NOTE_PREFIX) ? part.slice(NOTE_PREFIX.length).trim()
      : part.startsWith(CLAIM_KIND_PREFIX) ? part.slice(CLAIM_KIND_PREFIX.length).trim()
      : null;
    if (value !== null && isCallFaceKind(value)) return value;
  }
  return null;
}

function isCallFaceRow(row: VisualAssetRow): boolean {
  return (row.role as string) === CALL_FACE_ROLE;
}

function newest(a: VisualAssetRow, b: VisualAssetRow): number {
  const ta = a.decided_at ?? a.created_at;
  const tb = b.decided_at ?? b.created_at;
  return tb.localeCompare(ta) || b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id);
}

// The state from a list of rows (the callface rows are picked out here, so the caller
// may hand over the whole table).
export function callFaceStateOf(rows: readonly VisualAssetRow[], settings: Partial<Settings> | Record<string, unknown> | null | undefined): CallFaceState {
  const cs = callFaceSettingsOf(settings);
  const faces = rows.filter(isCallFaceRow);
  const clips: Record<CallFaceKind, VisualAssetRow | null> = { idle: null, listening: null, talking: null };
  for (const row of [...faces].sort(newest)) {
    if (row.approval_status !== "approved") continue;
    const kind = callFaceKindOf(row.notes);
    if (kind && !clips[kind]) clips[kind] = row;
  }
  const candidates = faces.filter((r) => r.approval_status === "candidate").sort(newest);
  const generating = faces.filter((r) => r.approval_status === "generating" || r.approval_status === "pending").sort(newest);
  const ready = cs.provider === "clips" && CALL_FACE_KINDS.every((k) => clips[k] !== null);
  return { provider: cs.provider, source: cs.sourceAssetId, clips, candidates, generating, ready };
}

// ------------------------------------------------------------------ state

export async function callFaceState(db: D1Database, settings: Settings): Promise<CallFaceState> {
  const rows = await listAssets(db);
  return callFaceStateOf(rows, settings);
}

// ------------------------------------------------------------------ make

// Starts one clip of one kind. The provider gates answer before anything is written; the
// clip itself goes through startClip (the source must be a master, the size gate, the
// Runway key, the price and the caps, the charge at start). 409 while a clip of that
// kind is already generating.
export async function makeCallFace(
  env: Env,
  db: D1Database,
  settings: Settings,
  args: { kind: CallFaceKind; actor: string },
): Promise<VisualAssetRow> {
  if (!isCallFaceKind(args.kind)) throw new ApiHttpError(400, "validation", "kind must be idle, listening or talking");
  const cs = callFaceSettingsOf(settings);
  if (cs.provider === "off") throw new ApiHttpError(503, "provider_not_configured", "the call face is off", false, "off");
  if (cs.provider === "lipsync") throw new ApiHttpError(503, "provider_not_configured", "a lip-synced call face is reserved for v4.1", false, "reserved_v4_1");

  const rows = await listAssets(db, "generating");
  const busy = rows.some((r) => isCallFaceRow(r) && callFaceKindOf(r.notes) === args.kind);
  if (busy) throw new ApiHttpError(409, "in_progress", "a " + args.kind + " clip is already being made", true, args.kind);

  return startClip(env, db, settings, {
    sourceAssetId: cs.sourceAssetId,
    description: CALL_FACE_PROMPTS[args.kind],
    actor: args.actor,
    role: CALL_FACE_ROLE,
    kind: args.kind,
    ratio: CALL_FACE_RATIO,
    seconds: CALL_FACE_SECONDS,
  });
}

// The price of the whole set (three clips at the clip price for CALL_FACE_SECONDS).
export function callFaceSetCostUsd(settings: Settings): number {
  const vs = videoSettingsOf(settings);
  return CALL_FACE_KINDS.length * clipCostUsd({ costUsd: vs.costUsd, seconds: CALL_FACE_SECONDS });
}
