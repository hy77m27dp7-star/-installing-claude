// Export her (SPEC_V2 section Z): the character as a package that survives this runtime.
// The JSON form carries what makes her her (the constitution version and its adaptations,
// the fixed canon, her facts and opinions, the shared history, her life, the open
// unknowns, the current relationship and scene, the approved photos by hash, the titles
// of what is on her phone) and a hash of the stable prompt prefix so a rebuild elsewhere
// can prove it runs the same rules. No settings, no secrets, no storage keys, no prompt
// text. The markdown form is the same record as a readable character bible.
//
// v3 (SPEC_V3 "Export and import"): the package gains her approved voice lines (AA), the
// active corrections (AA), her wants and the asks (CC). A database behind migration 0005
// answers empty lists for them.
import { ADAPTATIONS, CONSTITUTION_VERSION } from "./generated/constitution";
import { getCurrentState, listAssets, listFacts, listHistory, listUnknowns, sha256Hex } from "./db";
import { listLog, listThreads, parseSchedule } from "./life";
import type { LifeLog, LifeThread, Schedule } from "./life";
import { listMedia } from "./media";
import { PROMPT_VERSION, isOpinionFact, stablePrefix } from "./prompt";
import type { Env, FactRow, HistoryRow, RelationshipState, SceneState, UnknownRow, VisualAssetRow } from "./types";

// ------------------------------------------------------------------ the package

export interface CharacterFact {
  id: string;
  subject: string | null;
  fact: string;
  provisional: boolean;
  version: number;
  createdAt: string;
}

export interface CharacterOpinion {
  id: string;
  subject: string;
  opinion: string;
  version: number;
  supersedesId: string | null;
  createdAt: string;
}

export interface CharacterHistory {
  id: string;
  seq: number;
  title: string;
  occurred: string | null;
  body: string;
  whatChanged: string | null;
  keepConsistent: string | null;
  createdAt: string;
}

export interface CharacterThread {
  id: string;
  kind: LifeThread["kind"];
  title: string;
  detail: string | null;
  relation: string | null;
  schedule: Schedule | null;
  status: LifeThread["status"];
  createdAt: string;
}

export interface CharacterLogEntry {
  id: string;
  threadId: string | null;
  occurred: string;
  note: string;
}

export interface CharacterImage {
  id: string;
  role: VisualAssetRow["role"];
  sha256: string | null;
  bytes: number | null;
  description: string | null;
  messageId: string | null;
  createdAt: string;
}

// v3 rows, typed here so the package never depends on a table's full shape.
export interface CharacterVoiceLine {
  id: string;
  text: string;
  tags: string[];
  origin: string;
}

export interface CharacterCorrection {
  id: string;
  kind: string;
  note: string | null;
  original: string;
  rewrite: string | null;
  createdAt: string;
}

export interface CharacterWant {
  id: string;
  title: string;
  why: string | null;
  stakes: string | null;
  nextStep: string | null;
  progress: number;
  status: string;
  lastMoved: string | null;
}

export interface CharacterAsk {
  id: string;
  text: string;
  status: string;
  askedAt: string;
}

export interface CharacterPackage {
  format: "avelie-character";
  version: 1;
  exportedAt: string;
  constitutionVersion: string;
  promptVersion: string;
  adaptations: typeof ADAPTATIONS;
  fixedCanon: CharacterFact[];
  avelieFacts: CharacterFact[];
  opinions: CharacterOpinion[];
  history: CharacterHistory[];
  life: { threads: CharacterThread[]; log: CharacterLogEntry[] };
  unknowns: Array<{ id: string; topic: string; note: string | null }>;
  relationship: { version: number; state: RelationshipState } | null;
  scene: { version: number; state: SceneState } | null;
  images: CharacterImage[];
  mediaTitles: Array<{ kind: string; title: string; description: string | null }>;
  promptPrefixSha256: string;
  // v3
  voiceLines: CharacterVoiceLine[];
  corrections: CharacterCorrection[];
  wants: CharacterWant[];
  asks: CharacterAsk[];
}

interface VoiceLineRow { id: string; text: string; tags_json: string; origin: string; status: string }
interface CorrectionRow { id: string; kind: string; note: string | null; original: string; rewrite: string | null; status: string; created_at: string }
interface WantRow { id: string; title: string; why: string | null; stakes: string | null; next_step: string | null; progress: number; status: string; last_moved: string | null }
interface AskRow { id: string; text: string; status: string; asked_at: string }

async function rowsOrEmpty<T>(db: D1Database, sql: string): Promise<T[]> {
  try {
    return (await db.prepare(sql).all<T>()).results;
  } catch {
    return [];
  }
}

function tagsOf(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

const LOG_ROWS = 200;

function fact(f: FactRow): CharacterFact {
  return { id: f.id, subject: f.subject, fact: f.fact, provisional: Boolean(f.provisional), version: f.version, createdAt: f.created_at };
}

function opinion(f: FactRow): CharacterOpinion {
  return { id: f.id, subject: f.subject ?? "opinion", opinion: f.fact, version: f.version, supersedesId: f.supersedes_id, createdAt: f.created_at };
}

function historyEntry(h: HistoryRow): CharacterHistory {
  return {
    id: h.id, seq: h.seq, title: h.title, occurred: h.occurred, body: h.body,
    whatChanged: h.what_changed, keepConsistent: h.keep_consistent, createdAt: h.created_at,
  };
}

function thread(t: LifeThread): CharacterThread {
  return {
    id: t.id, kind: t.kind, title: t.title, detail: t.detail, relation: t.relation,
    schedule: parseSchedule(t.schedule_json), status: t.status, createdAt: t.created_at,
  };
}

function logEntry(l: LifeLog): CharacterLogEntry {
  return { id: l.id, threadId: l.thread_id, occurred: l.occurred, note: l.note };
}

function image(a: VisualAssetRow): CharacterImage {
  return { id: a.id, role: a.role, sha256: a.sha256, bytes: a.bytes, description: a.prompt, messageId: a.message_id, createdAt: a.created_at };
}

async function currentState<T extends RelationshipState | SceneState>(db: D1Database, entity: "relationship" | "scene"): Promise<{ version: number; state: T } | null> {
  try {
    const r = await getCurrentState<T>(db, entity);
    return { version: r.version, state: r.state };
  } catch {
    return null;
  }
}

export async function exportCharacterJson(db: D1Database, _env: Env): Promise<CharacterPackage> {
  const [fixed, avelie, history, unknowns, threads, log, assets, media, relationship, scene, prefixHash, voiceLines, corrections, wants, asks] = await Promise.all([
    listFacts(db, "fixed", "approved"),
    listFacts(db, "avelie", "approved"),
    listHistory(db, "approved"),
    listUnknowns(db, "open"),
    listThreads(db),
    listLog(db, LOG_ROWS),
    listAssets(db, "approved"),
    listMedia(db, "active"),
    currentState<RelationshipState>(db, "relationship"),
    currentState<SceneState>(db, "scene"),
    sha256Hex(stablePrefix()),
    rowsOrEmpty<VoiceLineRow>(db, "SELECT id, text, tags_json, origin, status FROM voice_lines WHERE status = 'approved' ORDER BY created_at, id"),
    rowsOrEmpty<CorrectionRow>(db, "SELECT id, kind, note, original, rewrite, status, created_at FROM corrections WHERE status = 'active' ORDER BY created_at, id"),
    rowsOrEmpty<WantRow>(db, "SELECT id, title, why, stakes, next_step, progress, status, last_moved FROM wants WHERE status != 'dropped' ORDER BY created_at, id"),
    rowsOrEmpty<AskRow>(db, "SELECT id, text, status, asked_at FROM asks ORDER BY asked_at, id"),
  ]);

  const approvedFixed = fixed.filter((f) => f.status === "approved");
  const approvedAvelie = avelie.filter((f) => f.status === "approved");
  const liveThreads = threads.filter((t) => t.status === "active" || t.status === "done");

  return {
    format: "avelie-character",
    version: 1,
    exportedAt: new Date().toISOString(),
    constitutionVersion: CONSTITUTION_VERSION,
    promptVersion: PROMPT_VERSION,
    adaptations: ADAPTATIONS,
    fixedCanon: approvedFixed.map(fact),
    avelieFacts: approvedAvelie.filter((f) => !isOpinionFact(f)).map(fact),
    opinions: approvedAvelie.filter(isOpinionFact).map(opinion),
    history: history.filter((h) => h.status === "approved").map(historyEntry),
    life: { threads: liveThreads.map(thread), log: log.map(logEntry) },
    unknowns: unknowns.filter((u: UnknownRow) => u.status === "open").map((u) => ({ id: u.id, topic: u.topic, note: u.note })),
    relationship,
    scene,
    // v4 (SPEC_V4 section 3): a picture with him in it (with_him = 1) never enters the
    // package; a real person's face is not part of her.
    images: assets.filter((a) => a.approval_status === "approved" && (a.role === "scene" || a.role === "master") && Number(a.with_him ?? 0) !== 1).map(image),
    mediaTitles: media.filter((m) => m.status === "active").map((m) => ({ kind: m.kind, title: m.title, description: m.description })),
    promptPrefixSha256: prefixHash,
    voiceLines: voiceLines.filter((v) => v.status === "approved").map((v) => ({ id: v.id, text: v.text, tags: tagsOf(v.tags_json), origin: v.origin })),
    corrections: corrections.filter((c) => c.status === "active").map((c) => ({ id: c.id, kind: c.kind, note: c.note, original: c.original, rewrite: c.rewrite, createdAt: c.created_at })),
    wants: wants.filter((w) => w.status !== "dropped").map((w) => ({ id: w.id, title: w.title, why: w.why, stakes: w.stakes, nextStep: w.next_step, progress: w.progress, status: w.status, lastMoved: w.last_moved })),
    asks: asks.map((a) => ({ id: a.id, text: a.text, status: a.status, askedAt: a.asked_at })),
  };
}

// ------------------------------------------------------------------ the bible

const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);
const ELLIPSIS = String.fromCharCode(0x2026);

// The stored text is never changed; the bible renders it in the house typography.
function plain(v: unknown): string {
  const s = typeof v === "string" ? v : v === null || v === undefined ? "" : String(v);
  return s.split(EM_DASH).join(" -- ").split(EN_DASH).join(" -- ").split(ELLIPSIS).join("...").replace(/[ \t]+\n/g, "\n").trim();
}

function line(label: string, value: unknown): string | null {
  const v = plain(value);
  return v ? `- ${label}: ${v}` : null;
}

function lines(parts: Array<string | null>): string {
  return parts.filter((p): p is string => typeof p === "string" && p.length > 0).join("\n");
}

function day(iso: string | null | undefined): string {
  return typeof iso === "string" && iso.length >= 10 ? iso.slice(0, 10) : "";
}

const KIND_LABEL: Record<LifeThread["kind"], string> = {
  routine: "Routines",
  event: "Events",
  person: "People",
  place: "Places",
  arc: "Arcs",
};

function scheduleLine(s: Schedule | null): string | null {
  if (!s) return null;
  if (typeof s.at === "string" && s.at) return `${s.at}${s.label ? " (" + s.label + ")" : ""}`;
  if (Array.isArray(s.blocks) && s.blocks.length) {
    const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    return s.blocks
      .map((b) => `${b.days.map((d) => names[d] ?? String(d)).join("/")} ${b.start}-${b.end}${b.label ? " " + b.label : ""}`)
      .join("; ") + (s.tz ? ` (${s.tz})` : "");
  }
  return null;
}

function stateBlock(title: string, entry: { version: number; state: Record<string, unknown> } | null): string {
  if (!entry) return `## ${title}\n\nNo ${title.toLowerCase()} has been recorded.`;
  const rows = Object.entries(entry.state)
    .filter(([, v]) => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0))
    .map(([k, v]) => line(k.replace(/_/g, " "), Array.isArray(v) ? v.map(plain).join(", ") : typeof v === "object" ? JSON.stringify(v) : v));
  return `## ${title} (version ${entry.version})\n\n${lines(rows) || "Nothing recorded."}`;
}

export function renderCharacterMarkdown(pkg: CharacterPackage): string {
  const out: string[] = [];
  out.push("# Avelie -- character bible");
  out.push(lines([
    `Exported ${day(pkg.exportedAt)}.`,
    `Constitution ${pkg.constitutionVersion}, prompt ${pkg.promptVersion}.`,
    `Stable prompt prefix sha256: ${pkg.promptPrefixSha256}.`,
    "Everything below was approved by the owner. Nothing in it came from a model on its own.",
  ]));

  out.push("## Fixed canon");
  out.push(lines(pkg.fixedCanon.map((f) => line(f.subject ?? "fact", f.fact))) || "Nothing recorded.");

  out.push("## Things true about her");
  out.push(lines(pkg.avelieFacts.map((f) => line((f.subject ?? "fact") + (f.provisional ? " (provisional)" : ""), f.fact))) || "Nothing recorded yet.");

  out.push("## Her opinions");
  out.push(lines(pkg.opinions.map((o) => line(o.subject + (o.version > 1 ? ` (v${o.version})` : ""), o.opinion))) || "None recorded yet.");

  out.push("## Shared history");
  if (pkg.history.length) {
    for (const h of pkg.history) {
      out.push(`### ${h.seq}. ${plain(h.title)}${h.occurred ? " (" + plain(h.occurred) + ")" : ""}`);
      out.push(lines([
        plain(h.body),
        h.whatChanged ? "What changed: " + plain(h.whatChanged) : null,
        h.keepConsistent ? "Keep consistent: " + plain(h.keepConsistent) : null,
      ]));
    }
  } else {
    out.push("There is no shared history yet.");
  }

  out.push("## Her life");
  const kinds: Array<LifeThread["kind"]> = ["routine", "event", "person", "place", "arc"];
  let anyThread = false;
  for (const kind of kinds) {
    const of = pkg.life.threads.filter((t) => t.kind === kind);
    if (!of.length) continue;
    anyThread = true;
    out.push(`### ${KIND_LABEL[kind]}`);
    out.push(lines(of.map((t) => {
      const bits = [
        t.relation ? plain(t.relation) : null,
        t.detail ? plain(t.detail) : null,
        scheduleLine(t.schedule),
        t.status === "done" ? "done" : null,
      ].filter((b): b is string => Boolean(b));
      return `- ${plain(t.title)}${bits.length ? ": " + bits.join("; ") : ""}`;
    })));
  }
  if (!anyThread) out.push("Nothing about her days has been written down yet.");
  if (pkg.life.log.length) {
    out.push("### Life log");
    const titles = new Map(pkg.life.threads.map((t) => [t.id, t.title] as const));
    out.push(lines(pkg.life.log.map((l) => {
      const t = l.threadId ? titles.get(l.threadId) : undefined;
      return `- ${day(l.occurred)}${t ? " (" + plain(t) + ")" : ""}: ${plain(l.note)}`;
    })));
  }

  out.push("## Open unknowns");
  out.push(lines(pkg.unknowns.map((u) => `- ${plain(u.topic)}${u.note ? ": " + plain(u.note) : ""}`)) || "None open.");

  out.push(stateBlock("Relationship", pkg.relationship as { version: number; state: Record<string, unknown> } | null));
  out.push(stateBlock("Scene", pkg.scene as { version: number; state: Record<string, unknown> } | null));

  out.push("## Photos (approved)");
  out.push(lines(pkg.images.map((i) => `- ${i.role} ${i.id}, sha256 ${i.sha256 ?? "unknown"}${i.description ? ": " + plain(i.description) : ""}`)) || "None approved.");

  out.push("## Things on her phone");
  out.push(lines(pkg.mediaTitles.map((m) => `- ${m.kind}: ${plain(m.title)}${m.description ? " (" + plain(m.description) + ")" : ""}`)) || "Nothing uploaded.");

  out.push("## How she texts (approved lines)");
  out.push(lines((pkg.voiceLines ?? []).map((v) => `- ${plain(v.text)}${v.tags.length ? " (" + v.tags.join(", ") + ")" : ""}`)) || "None approved yet.");

  out.push("## Notes from him (active)");
  out.push(lines((pkg.corrections ?? []).map((c) => line(c.kind.replace(/_/g, " "), (c.note ? plain(c.note) + ". " : "") + "She wrote: " + plain(c.original) + (c.rewrite ? ". His version: " + plain(c.rewrite) : "")))) || "None.");

  out.push("## What she wants");
  out.push(lines((pkg.wants ?? []).map((w) => `- ${plain(w.title)} (${w.status}, ${w.progress}%)${w.nextStep ? ": next, " + plain(w.nextStep) : ""}${w.stakes ? "; if it falls through, " + plain(w.stakes) : ""}`)) || "Nothing yet.");

  out.push("## What she asked him");
  out.push(lines((pkg.asks ?? []).map((a) => `- ${day(a.askedAt)}: ${plain(a.text)} (${a.status.replace(/_/g, " ")})`)) || "Nothing yet.");

  out.push(`## Constitution adaptations (${pkg.adaptations.length})`);
  out.push(lines(pkg.adaptations.map((a) => `- ${a.id} (${a.file}): ${plain(a.to)}`)) || "None.");

  return out.join("\n\n") + "\n";
}

export async function exportCharacterMarkdown(db: D1Database, env: Env): Promise<string> {
  return renderCharacterMarkdown(await exportCharacterJson(db, env));
}
