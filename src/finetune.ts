// Fine-tune pipeline (SPEC_V3 II). Every exchange he marks Keep, every rewrite he made in
// the corrections ledger, and every tasting he picked is an approved exchange. The app
// exports them as OpenAI fine-tuning JSONL (streamed line by line) with a sidecar record
// that says exactly what went out (which fact ids, whether his name, a chained hash the
// Mac script verifies); nothing trains until he runs scripts/finetune_run.mjs and types
// the word. The resulting model id becomes her texter through /use; judgment (proposals,
// the operator, checks) stays on Claude.
//
// What the export carries, said plainly: his approved facts, his recorded name and
// nicknames, the private language, the shared history and the rest of the state sections
// exactly as she saw them on each turn (state_text), because she cannot be trained on an
// exchange without the memory that shaped it. stripHim removes WHAT YOU KNOW ABOUT HIM and
// THINGS YOU HALF REMEMBER and the four personal keys of the Relationship line; his own
// messages and her replies go as written either way. Explicit exchanges are left out by
// default (his answer to open question 2): a word-list detector below, plus the Drop mark
// by hand; includeExplicit keeps them.
import { ALWAYS_ON, CONSTITUTION_VERSION, OVERLAY } from "./generated/constitution";
import { PROMPT_VERSION, stablePrefix } from "./prompt";
import { auditStmt, getSettings, putSettings } from "./db";
import { ApiHttpError } from "./errors";
import { providerConfigured } from "./providers/index";
import type { Env, Flag, MessageRow, ProviderName, Settings } from "./types";

// The state sections are joined by this in prompt.ts (stateSections); the strip transform
// splits on it and re-joins with it so every other section stays byte-identical.
const SECTION_SEP = "\n\n" + "-".repeat(60) + "\n\n";
const PART_SEP = "\n\n";
const STRIP_SECTIONS = ["WHAT YOU KNOW ABOUT HIM", "THINGS YOU HALF REMEMBER"];
const RELATIONSHIP_LINE = "Relationship: ";
const STRIP_KEYS = ["his_name", "nicknames", "private_language", "summary"];
// The opener cue chat.ts stores for no message of his (an opener has no user row at all).
const OPENER_CUE = "[opener]";
export const PAGE_SIZE = 200;
// D1 binds at most 100 parameters per statement.
const CHUNK = 90;
// Full mode is roughly 12,000 tokens per example; more than this is refused (413).
export const FULL_MODE_MAX_EXAMPLES = 1000;
const DEFAULT_MIN_EXAMPLES = 200;
const FALLBACK_PREVIOUS: { provider: ProviderName; model: string } = { provider: "anthropic", model: "claude-opus-5" };
const TEXTER_MODEL_RE = /^(ft:)?[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

// The explicit-exchange detector (his answer of 2026-09-24: left out of the export by
// default). Whole-word, lowercase; a coarse list on purpose, since the Drop mark is the
// precise tool and includeExplicit the override.
const EXPLICIT_TERMS: string[] = [
  "fuck", "fucking", "fucked", "cock", "dick", "pussy", "cum", "cumming", "orgasm", "blowjob", "handjob", "anal", "nipples", "tits",
  "naked", "nude", "moan", "moaning", "thrust", "thrusting", "horny", "sex", "sexting", "masturbat", "clit", "erection", "inside me", "inside you",
];
const EXPLICIT_RE = new RegExp("\\b(?:" + EXPLICIT_TERMS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")", "i");

// ------------------------------------------------------------------ types

export type ExchangeSource = "keep" | "rewrite" | "pick";

export interface ApprovedExchange {
  userMessageId: string;
  assistantMessageId: string;
  user: string;
  assistant: string;
  stateText: string;
  promptVersion: string;
  source: ExchangeSource;
  // The facts about him the state carried (provenance factIds.justin), for the sidecar.
  factIds: string[];
}

export interface ExportOptions {
  stripHim?: boolean;
  includeExplicit?: boolean;
  // The system mode for this export; the setting when absent.
  systemMode?: "compact" | "full";
}

export interface ExportSkipped {
  noState: number;
  flagged: number;
  dropped: number;
  explicit: number;
}

export interface ExportBreakdown {
  keeps: number;
  rewrites: number;
  picks: number;
}

export interface Sidecar {
  exportedAt: string;
  promptVersion: string;
  constitutionVersion: string;
  systemMode: "compact" | "full";
  stripHim: boolean;
  includeExplicit: boolean;
  count: number;
  skipped: ExportSkipped;
  breakdown: ExportBreakdown;
  sentFactIds: string[];
  sentHisName: boolean;
  lineHashes: string[];
  sha256: string;
}

export interface FinetuneStatus {
  approved: number;
  minimum: number;
  ready: boolean;
  breakdown: ExportBreakdown;
  skipped: ExportSkipped;
  texterModel: string;
  live: { provider: string; model: string };
  previous: { provider: string; model: string } | null;
  systemMode: "compact" | "full";
}

interface MarkRow { message_id: string; mark: "keep" | "drop" }
interface CorrectionRow { id: string; message_id: string; rewrite: string | null; status: string }
interface TastingPickRow { id: string; user_message_id: string; pick: string | null; winner_side: string | null }
interface ContextRow { message_id: string; json: string; state_text: string | null }

// ------------------------------------------------------------------ pure pieces

export function systemModeOf(settings: Settings, override?: "compact" | "full"): "compact" | "full" {
  if (override === "compact" || override === "full") return override;
  return settings.finetuneSystemMode === "full" ? "full" : "compact";
}

export function minExamplesOf(settings: Settings): number {
  const v = settings.finetuneMinExamples;
  return Number.isInteger(v) && v >= 10 && v <= 5000 ? v : DEFAULT_MIN_EXAMPLES;
}

// The system text of one training example: the compact core (ALWAYS_ON + OVERLAY) or the
// whole stable prefix, then the state sections exactly as she saw them.
export function systemFor(stateText: string, mode: "compact" | "full"): string {
  const prefix = mode === "full" ? stablePrefix() : ALWAYS_ON + PART_SEP + OVERLAY;
  return prefix + PART_SEP + stateText;
}

function firstLine(section: string): string {
  return section.split("\n")[0] ?? "";
}

// The Relationship JSON line without the four personal keys; anything unreadable is left as is.
function stripRelationshipLine(line: string): string {
  if (!line.startsWith(RELATIONSHIP_LINE)) return line;
  try {
    const parsed: unknown = JSON.parse(line.slice(RELATIONSHIP_LINE.length));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return line;
    const o = { ...(parsed as Record<string, unknown>) };
    for (const k of STRIP_KEYS) delete o[k];
    return RELATIONSHIP_LINE + JSON.stringify(o);
  } catch {
    return line;
  }
}

// The strip transform (SPEC_V3 II): the two sections about him gone, the Relationship line
// without his_name, nicknames, private_language and summary; every other section byte-identical.
export function stripHimFromState(stateText: string): string {
  const sections = stateText.split(SECTION_SEP);
  const kept = sections
    .filter((s) => !STRIP_SECTIONS.some((h) => firstLine(s).startsWith(h)))
    .map((s) => (firstLine(s).startsWith("CURRENT STATE") ? s.split("\n").map(stripRelationshipLine).join("\n") : s));
  return kept.join(SECTION_SEP);
}

export const stripHim = stripHimFromState;

// ------------------------------------------------------------------ sha256, synchronous

// A pure SHA-256 over UTF-8 text (FIPS 180-4), so the sidecar's chain needs no await per
// line and no Node-only API; the async crypto.subtle digest stays for the bytes elsewhere.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256HexSync(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const bitLen = bytes.length * 8;
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(padded.length - 4, bitLen >>> 0, false);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15]!;
      const w2 = w[i - 2]!;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!, f = h[5]!, g = h[6]!, hh = h[7]!;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0; h[1] = (h[1]! + b) >>> 0; h[2] = (h[2]! + c) >>> 0; h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0; h[5] = (h[5]! + f) >>> 0; h[6] = (h[6]! + g) >>> 0; h[7] = (h[7]! + hh) >>> 0;
  }
  return Array.from(h).map((x) => x.toString(16).padStart(8, "0")).join("");
}

// The export record's chain (the Mac script recomputes it with --verify): sha256 of each
// line, in order, and sha256 of those joined by newline.
export function chainOf(lines: string[]): { lineHashes: string[]; sha256: string } {
  const lineHashes = lines.map(sha256HexSync);
  return { lineHashes, sha256: sha256HexSync(lineHashes.join("\n")) };
}

// Whether the state text's Relationship line carries a name for him.
export function stateCarriesHisName(stateText: string): boolean {
  for (const line of stateText.split("\n")) {
    if (!line.startsWith(RELATIONSHIP_LINE)) continue;
    try {
      const parsed: unknown = JSON.parse(line.slice(RELATIONSHIP_LINE.length));
      const name = typeof parsed === "object" && parsed !== null ? (parsed as { his_name?: unknown }).his_name : null;
      return typeof name === "string" && name.trim().length > 0;
    } catch {
      return false;
    }
  }
  return false;
}

export function isExplicitExchange(user: string, assistant: string): boolean {
  return EXPLICIT_RE.test(user) || EXPLICIT_RE.test(assistant);
}

// One JSONL line (no trailing newline): the OpenAI chat fine-tuning shape.
export function trainingLine(ex: { user: string; assistant: string; stateText: string }, mode: "compact" | "full", stripHim: boolean): string {
  const state = stripHim ? stripHimFromState(ex.stateText) : ex.stateText;
  return JSON.stringify({
    messages: [
      { role: "system", content: systemFor(state, mode) },
      { role: "user", content: ex.user },
      { role: "assistant", content: ex.assistant },
    ],
  });
}

function parseFlags(json: string | null): Flag[] {
  if (!json) return [];
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((f): f is Flag => typeof f === "object" && f !== null && typeof (f as Flag).code === "string") : [];
  } catch {
    return [];
  }
}

function factIdsOf(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as { factIds?: { justin?: unknown } };
    const ids = v && typeof v === "object" && v.factIds && typeof v.factIds === "object" ? v.factIds.justin : null;
    return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function chunk<T>(items: T[], n = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

async function rowsIn<T>(db: D1Database, sql: (marks: string) => string, ids: string[]): Promise<T[]> {
  const out: T[] = [];
  for (const part of chunk(ids)) {
    const marks = part.map((_, i) => "?" + (i + 1)).join(", ");
    const r = await db.prepare(sql(marks)).bind(...part).all<T>();
    out.push(...r.results);
  }
  return out;
}

// ------------------------------------------------------------------ the approved set

// The candidate assistant message ids with their source and priority (rewrite > pick > keep),
// and the count of drop marks (a drop wins over everything).
async function candidateIds(db: D1Database): Promise<{ sources: Map<string, { source: ExchangeSource; rewrite: string | null }>; dropped: number }> {
  const [marks, corrections, tastings] = await Promise.all([
    db.prepare("SELECT message_id, mark FROM message_marks").all<MarkRow>().then((r) => r.results),
    db.prepare("SELECT id, message_id, rewrite, status FROM corrections WHERE status = 'active' AND rewrite IS NOT NULL AND rewrite != ''").all<CorrectionRow>().then((r) => r.results),
    db.prepare("SELECT id, user_message_id, pick, winner_side FROM tastings WHERE status = 'picked' AND pick IN ('left', 'right')").all<TastingPickRow>().then((r) => r.results),
  ]);
  const out = new Map<string, { source: ExchangeSource; rewrite: string | null }>();
  for (const m of marks) if (m.mark === "keep") out.set(m.message_id, { source: "keep", rewrite: null });
  // A picked tasting's stored reply is the assistant message that answers its user message.
  if (tastings.length) {
    const userIds = tastings.map((t) => t.user_message_id);
    const replies = await rowsIn<{ id: string; reply_to_id: string }>(db, (m) => `SELECT id, reply_to_id FROM messages WHERE role = 'assistant' AND channel = 'story' AND reply_to_id IN (${m})`, userIds);
    for (const r of replies) {
      const cur = out.get(r.id);
      if (!cur || cur.source === "keep") out.set(r.id, { source: "pick", rewrite: null });
    }
  }
  for (const c of corrections) out.set(c.message_id, { source: "rewrite", rewrite: c.rewrite });
  // A drop mark wins over everything.
  let dropped = 0;
  for (const m of marks) {
    if (m.mark !== "drop") continue;
    out.delete(m.message_id);
    dropped += 1;
  }
  return { sources: out, dropped };
}

export interface ExchangeWalk {
  exchanges: ApprovedExchange[];
  skipped: ExportSkipped;
  breakdown: ExportBreakdown;
}

// Loads one page of candidate ids into exchanges, applying the exclusions: a retry-severity
// flag, no user message (an opener) or the opener cue, a call row, an operator row, no
// state text (older than v3), an explicit exchange unless included.
async function loadPage(
  db: D1Database,
  ids: string[],
  sources: Map<string, { source: ExchangeSource; rewrite: string | null }>,
  opts: { includeExplicit: boolean },
  acc: ExchangeWalk,
  seenUsers: Set<string>,
): Promise<void> {
  const messages = await rowsIn<MessageRow>(db, (m) => `SELECT * FROM messages WHERE id IN (${m})`, ids);
  const byId = new Map(messages.map((m) => [m.id, m] as const));
  const userIds = messages.map((m) => m.reply_to_id).filter((x): x is string => typeof x === "string" && x.length > 0);
  const users = userIds.length ? await rowsIn<MessageRow>(db, (m) => `SELECT * FROM messages WHERE id IN (${m})`, userIds) : [];
  const userById = new Map(users.map((m) => [m.id, m] as const));
  const contexts = await rowsIn<ContextRow>(db, (m) => `SELECT message_id, json, state_text FROM message_context WHERE message_id IN (${m})`, ids);
  const ctxById = new Map(contexts.map((c) => [c.message_id, c] as const));

  // Priority order inside the page: rewrites first, then picks, then keeps, so a user
  // message seen twice keeps its highest source.
  const order: ExchangeSource[] = ["rewrite", "pick", "keep"];
  const sorted = ids.slice().sort((a, b) => order.indexOf(sources.get(a)?.source ?? "keep") - order.indexOf(sources.get(b)?.source ?? "keep"));
  for (const id of sorted) {
    const src = sources.get(id);
    const m = byId.get(id);
    if (!src || !m) continue;
    if (m.role !== "assistant" || m.channel !== "story") continue;
    if (typeof m.call_id === "string" && m.call_id) continue;
    if (!m.reply_to_id) continue;
    const u = userById.get(m.reply_to_id);
    if (!u || u.role !== "user" || u.channel !== "story" || !u.content.trim() || u.content.trim() === OPENER_CUE) continue;
    if (seenUsers.has(u.id)) continue;
    if (parseFlags(m.flags_json).some((f) => f.severity === "retry" || f.severity === "block")) {
      acc.skipped.flagged += 1;
      continue;
    }
    const ctx = ctxById.get(id);
    const stateText = ctx && typeof ctx.state_text === "string" && ctx.state_text.trim() ? ctx.state_text : null;
    if (!ctx || !stateText) {
      acc.skipped.noState += 1;
      continue;
    }
    const assistant = src.source === "rewrite" && src.rewrite ? src.rewrite : m.content;
    if (!opts.includeExplicit && isExplicitExchange(u.content, assistant)) {
      acc.skipped.explicit += 1;
      continue;
    }
    let promptVersion = PROMPT_VERSION;
    try {
      const pv = (JSON.parse(ctx.json) as { promptVersion?: unknown }).promptVersion;
      if (typeof pv === "string" && pv) promptVersion = pv;
    } catch {
      /* the stored version is a nicety */
    }
    seenUsers.add(u.id);
    acc.exchanges.push({ userMessageId: u.id, assistantMessageId: m.id, user: u.content, assistant, stateText, promptVersion, source: src.source, factIds: factIdsOf(ctx.json) });
    if (src.source === "rewrite") acc.breakdown.rewrites += 1;
    else if (src.source === "pick") acc.breakdown.picks += 1;
    else acc.breakdown.keeps += 1;
  }
}

// Walks the approved set a page at a time; `onPage` receives each page's exchanges in a
// stable order (by assistant message id). The counts come back at the end.
export async function walkExchanges(
  db: D1Database,
  opts: { includeExplicit: boolean },
  onPage?: (page: ApprovedExchange[]) => Promise<void> | void,
): Promise<ExchangeWalk> {
  const { sources, dropped } = await candidateIds(db);
  const acc: ExchangeWalk = { exchanges: [], skipped: { noState: 0, flagged: 0, dropped, explicit: 0 }, breakdown: { keeps: 0, rewrites: 0, picks: 0 } };
  const ids = Array.from(sources.keys()).sort();
  const seenUsers = new Set<string>();
  for (const page of chunk(ids, PAGE_SIZE)) {
    const before = acc.exchanges.length;
    await loadPage(db, page, sources, opts, acc, seenUsers);
    const fresh = acc.exchanges.slice(before);
    if (onPage) {
      await onPage(fresh);
      // A streamed export keeps only the counts, never the whole file.
      acc.exchanges.length = before;
    }
  }
  return acc;
}

// The whole approved set in memory (status, the sidecar); the stream walks it instead.
export async function approvedExchanges(db: D1Database, _settings: Settings, opts: { includeExplicit?: boolean } = {}): Promise<ApprovedExchange[]> {
  return (await walkExchanges(db, { includeExplicit: opts.includeExplicit === true })).exchanges;
}

// ------------------------------------------------------------------ status

export async function finetuneStatus(db: D1Database, settings: Settings): Promise<FinetuneStatus> {
  const walk = await walkExchanges(db, { includeExplicit: false }, () => undefined);
  const approved = walk.breakdown.keeps + walk.breakdown.rewrites + walk.breakdown.picks;
  const minimum = minExamplesOf(settings);
  const previous = settings.texterPrevious && typeof settings.texterPrevious === "object" ? settings.texterPrevious : null;
  return {
    approved,
    minimum,
    ready: approved >= minimum,
    breakdown: walk.breakdown,
    skipped: walk.skipped,
    texterModel: typeof settings.texterModel === "string" ? settings.texterModel : "",
    live: { provider: settings.provider, model: settings.model },
    previous: previous ? { provider: previous.provider, model: previous.model } : null,
    systemMode: systemModeOf(settings),
  };
}

// ------------------------------------------------------------------ export

// The JSONL, streamed line by line from the paged walk (one string for the whole file
// would sit against the isolate's memory in full mode with a few thousand marks). Full
// mode refuses more than FULL_MODE_MAX_EXAMPLES with 413 before the first byte.
export async function exportTrainingStream(db: D1Database, settings: Settings, opts: ExportOptions = {}): Promise<ReadableStream<Uint8Array>> {
  const mode = systemModeOf(settings, opts.systemMode);
  const stripHim = opts.stripHim === true;
  const includeExplicit = opts.includeExplicit === true;
  if (mode === "full") {
    const status = await finetuneStatus(db, settings);
    if (status.approved > FULL_MODE_MAX_EXAMPLES) {
      throw new ApiHttpError(413, "too_large", `full mode exports at most ${FULL_MODE_MAX_EXAMPLES} examples; use compact`, false);
    }
  }
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        await walkExchanges(db, { includeExplicit }, (page) => {
          for (const ex of page) controller.enqueue(encoder.encode(trainingLine(ex, mode, stripHim) + "\n"));
        });
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
  });
}

// The sidecar record: counts, what went out about him, and the chained hash the Mac
// script recomputes line by line (sha256 of each line; sha256 of those joined by "\n").
export async function exportSidecar(db: D1Database, settings: Settings, opts: ExportOptions = {}): Promise<Sidecar> {
  const mode = systemModeOf(settings, opts.systemMode);
  const stripHim = opts.stripHim === true;
  const includeExplicit = opts.includeExplicit === true;
  const lineHashes: string[] = [];
  const factIds = new Set<string>();
  let sentHisName = false;
  const walk = await walkExchanges(db, { includeExplicit }, (page) => {
    for (const ex of page) {
      lineHashes.push(sha256HexSync(trainingLine(ex, mode, stripHim)));
      if (!stripHim) {
        for (const id of ex.factIds) factIds.add(id);
        if (stateCarriesHisName(ex.stateText)) sentHisName = true;
      }
    }
  });
  const count = lineHashes.length;
  if (mode === "full" && count > FULL_MODE_MAX_EXAMPLES) {
    throw new ApiHttpError(413, "too_large", `full mode exports at most ${FULL_MODE_MAX_EXAMPLES} examples; use compact`, false);
  }
  return {
    exportedAt: new Date().toISOString(),
    promptVersion: PROMPT_VERSION,
    constitutionVersion: CONSTITUTION_VERSION,
    systemMode: mode,
    stripHim,
    includeExplicit,
    count,
    skipped: walk.skipped,
    breakdown: walk.breakdown,
    sentFactIds: Array.from(factIds).sort(),
    sentHisName,
    lineHashes,
    sha256: sha256HexSync(lineHashes.join("\n")),
  };
}

// ------------------------------------------------------------------ the texter

function settingsSlice(s: Settings, keys: Array<keyof Settings>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = s[k];
  return out;
}

// Makes a fine-tuned (or plain OpenAI) model her performer. The model needs a price: when
// the table has none, both prices are required and written. The live performer is saved
// as texterPrevious for /revert. Proposals, the operator (which follows proposalProvider),
// checks, tastings, calls and images are untouched.
export async function useTexter(
  env: Env,
  db: D1Database,
  settings: Settings,
  input: { model: string; inputPerMTok?: number; outputPerMTok?: number },
  actor: string,
): Promise<Settings> {
  const model = typeof input.model === "string" ? input.model.trim() : "";
  if (!model || !TEXTER_MODEL_RE.test(model)) throw new ApiHttpError(400, "validation", "model must be a fine-tuned id (ft:...) or a plain OpenAI model id");
  if (!providerConfigured(env, "openai")) throw new ApiHttpError(503, "provider_not_configured", "OPENAI_API_KEY is not set", false, "openai");
  const prices = { ...settings.prices };
  const has = prices[model] && typeof prices[model]?.inputPerMTok === "number" && typeof prices[model]?.outputPerMTok === "number";
  const hasIn = typeof input.inputPerMTok === "number" && Number.isFinite(input.inputPerMTok) && input.inputPerMTok >= 0;
  const hasOut = typeof input.outputPerMTok === "number" && Number.isFinite(input.outputPerMTok) && input.outputPerMTok >= 0;
  if (hasIn !== hasOut) throw new ApiHttpError(400, "validation", "inputPerMTok and outputPerMTok go together");
  if (hasIn && hasOut) prices[model] = { inputPerMTok: input.inputPerMTok as number, outputPerMTok: input.outputPerMTok as number };
  else if (!has) throw new ApiHttpError(400, "price_unknown", `no price for model ${model}; send inputPerMTok and outputPerMTok (USD per million tokens)`, false, model);

  const keys: Array<keyof Settings> = ["provider", "model", "texterModel", "texterPrevious", "prices"];
  const before = settingsSlice(settings, keys);
  const patch: Partial<Settings> = {
    texterPrevious: { provider: settings.provider, model: settings.model },
    provider: "openai",
    model,
    texterModel: model,
    prices,
  };
  const after = await putSettings(db, patch);
  await auditStmt(db, actor, "finetune.use", "settings", null, before, settingsSlice(after, keys)).run();
  return after;
}

// Back to the performer that was live before /use (or Claude Opus 5 when none was saved).
export async function revertTexter(_env: Env, db: D1Database, settings: Settings, actor: string): Promise<Settings> {
  const prev = settings.texterPrevious && typeof settings.texterPrevious === "object" && typeof settings.texterPrevious.model === "string"
    ? settings.texterPrevious
    : FALLBACK_PREVIOUS;
  const keys: Array<keyof Settings> = ["provider", "model", "texterPrevious"];
  const before = settingsSlice(settings, keys);
  const after = await putSettings(db, { provider: prev.provider, model: prev.model, texterPrevious: null });
  await auditStmt(db, actor, "finetune.revert", "settings", null, before, settingsSlice(after, keys)).run();
  return after;
}

// The settings as stored (no local overlay), for a caller that only holds the overlaid copy.
export async function storedSettings(db: D1Database): Promise<Settings> {
  return getSettings(db);
}
