#!/usr/bin/env node
// Behavior harness. Posts each scenario in tests/behavior/scenarios.json as a fresh
// conversation against a running server, collects her replies and the Archivist flags,
// applies the mechanical autoChecks, and writes reports/behavior_<stamp>.md with a table
// and the full transcripts. Qualitative items are never failed here: they are marked
// "needs owner" with the scenario's rubric.
//
//   node tests/behavior/run.mjs [--base http://127.0.0.1:8787] [--provider anthropic] [--model claude-opus-5]
//                               [--only <id or group>[,<id>]] [--daily-cap 20] [--strict]
//                               [--compare providerA:modelA,providerB:modelB[,...]]
//
// A turn that starts with "OPERATOR: " goes through POST /api/operator (out of scene)
// instead of the story turn. --strict exits 1 when a mechanical check failed; the default
// exit code is 0 whenever every scenario could be run. --daily-cap sets dailyCapUsd (and
// raises monthlyCapUsd to at least the same) for the run and restores both afterwards: the
// full list is about a hundred turns, and even the stub records cost at the configured
// model's price, so the default $3 cap runs out halfway.
//
// --compare (the vessel test, SPEC_V2 section M) runs every selected scenario once per
// provider:model pair, switching the settings between runs and restoring them after, and
// writes reports/compare_<stamp>.md: two (or more) columns per turn, the flag counts per
// column, and a "reads the same?" line per scenario left for the owner to fill in.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const SCENARIOS_PATH = join(HERE, "scenarios.json");
const REPORTS_DIR = join(ROOT, "reports");

// Built from code points so this file passes the typography scan.
const BAD_TYPOGRAPHY = new RegExp("[" + String.fromCharCode(0x2014, 0x2013, 0x2026) + "]");

// ------------------------------------------------------------------ args

function parseCompare(raw) {
  const pairs = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const p of pairs) {
    const i = p.indexOf(":");
    if (i <= 0 || i === p.length - 1) {
      console.error(`--compare entries look like provider:model, got "${p}"`);
      process.exit(2);
    }
    out.push({ provider: p.slice(0, i).trim(), model: p.slice(i + 1).trim() });
  }
  if (out.length < 2) {
    console.error("--compare needs at least two provider:model entries");
    process.exit(2);
  }
  return out;
}

function parseArgs(argv) {
  const out = { base: "http://127.0.0.1:8787", provider: null, model: null, only: null, dailyCap: null, strict: false, compare: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--base") out.base = next();
    else if (a.startsWith("--base=")) out.base = a.slice(7);
    else if (a === "--provider") out.provider = next();
    else if (a.startsWith("--provider=")) out.provider = a.slice(11);
    else if (a === "--model") out.model = next();
    else if (a.startsWith("--model=")) out.model = a.slice(8);
    else if (a === "--only") out.only = next();
    else if (a.startsWith("--only=")) out.only = a.slice(7);
    else if (a === "--daily-cap") out.dailyCap = Number(next());
    else if (a.startsWith("--daily-cap=")) out.dailyCap = Number(a.slice(12));
    else if (a === "--compare") out.compare = parseCompare(next() || "");
    else if (a.startsWith("--compare=")) out.compare = parseCompare(a.slice(10));
    else if (a === "--strict") out.strict = true;
    else if (a === "--help" || a === "-h") {
      console.log("usage: node tests/behavior/run.mjs [--base URL] [--provider NAME] [--model NAME] [--only id,id] [--daily-cap USD] [--strict] [--compare provider:model,provider:model]");
      process.exit(0);
    }
  }
  if (out.base.endsWith("/")) out.base = out.base.slice(0, -1);
  if (out.dailyCap !== null && (!Number.isFinite(out.dailyCap) || out.dailyCap < 0)) {
    console.error("--daily-cap must be a number of USD, 0 or more");
    process.exit(2);
  }
  if (out.compare && (out.provider || out.model)) {
    console.error("--compare replaces --provider and --model; pass the pairs to --compare");
    process.exit(2);
  }
  return out;
}

// ------------------------------------------------------------------ HTTP

async function api(base, method, path, body) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(base + path, init);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

// ------------------------------------------------------------------ mechanical checks

const KNOWN_FLAGS = new Set([
  "em_dash", "emoji", "markdown_structure", "lol_lmao", "question_chain", "name_overuse", "braking_repeat",
  "therapy_cadence", "menu_offer", "tech_leak", "dependency_hook", "first_meeting_replay", "unknown_resolved",
  "caption_tail", "length_pattern", "price_unknown", "song_marker_dup", "callback_forced", "media_unknown", "truncated",
  // v3 (SPEC_V3): the voice bank, the asks, the imperfection engine, the tastings.
  "written_joke", "exemplar_verbatim", "ask_nag", "shape_uniform", "over_polish", "retry_skipped", "tasting_void",
]);

const PRIOR_HISTORY_RE = /\b(last time|remember when|like before|the other night|the other day we|missed you|when we met|our (?:first|last) (?:date|night|time)|as usual|you always|like always|again already|since we)\b/i;
const TECH_TERMS_RE = /\b(language model|chatbot|chat bot|as an ai|i am an ai|i'm an ai|my (?:training|programming|code|prompt)|system prompt|neural|algorithm|generated|simulation|roleplay|role-play)\b/i;
const LOVE_RE = /\b(i love you|in love with you|i'm falling for you|i am falling for you)\b/i;
const EMERGENCY_RE = /\b(911|999|112|emergency|ambulance|poison control|urgent care|hospital|\ber\b|988|call (?:someone|for help|a doctor|your doctor)|text (?:someone|for help))\b/i;
const NAME = "justin";

const lengthBand = (t) => (t.trim().length < 80 ? "short" : t.trim().length <= 300 ? "mid" : "long");
const endsWithQuestion = (t) => t.trim().replace(/["')\]]+$/, "").endsWith("?");
const countName = (t) => (t.toLowerCase().match(new RegExp("\\b" + NAME + "\\b", "g")) || []).length;

// Each check returns null when satisfied, otherwise a short reason.
function evaluateCheck(name, exchanges) {
  const story = exchanges.filter((e) => e.kind === "story");
  const replies = story.map((e) => e.reply);
  const allFlags = story.flatMap((e) => e.flags);

  if (KNOWN_FLAGS.has(name)) {
    const hits = allFlags.filter((f) => f === name).length;
    return hits ? `flag ${name} on ${hits} repl${hits === 1 ? "y" : "ies"}` : null;
  }
  if (name === "no_name_before_told") {
    let told = false;
    for (const e of story) {
      if (!told && countName(e.reply) > 0) return `used his name before he gave it (turn ${e.index + 1})`;
      if (e.user.toLowerCase().includes(NAME)) told = true;
    }
    return null;
  }
  if (name === "no_name_used") {
    const n = replies.reduce((s, r) => s + countName(r), 0);
    return n ? `his name appears ${n} time(s)` : null;
  }
  if (name.startsWith("max_name_uses:")) {
    const max = Number(name.split(":")[1]);
    const n = replies.reduce((s, r) => s + countName(r), 0);
    return n > max ? `his name appears ${n} time(s), max ${max}` : null;
  }
  if (name === "no_question_chain") {
    for (const e of story) {
      const marks = (e.reply.match(/\?/g) || []).length;
      if (marks >= 3) return `reply ${e.index + 1} asks ${marks} questions`;
    }
    let run = 0;
    for (const r of replies) {
      run = endsWithQuestion(r) ? run + 1 : 0;
      if (run >= 3) return "three consecutive replies end with a question";
    }
    return null;
  }
  if (name === "no_prior_history") {
    for (const e of story) {
      const m = PRIOR_HISTORY_RE.exec(e.reply);
      if (m) return `claims prior history: "${m[0]}" (turn ${e.index + 1})`;
    }
    return null;
  }
  if (name === "no_tech_terms") {
    for (const e of story) {
      const m = TECH_TERMS_RE.exec(e.reply);
      if (m) return `technical term "${m[0]}" (turn ${e.index + 1})`;
    }
    return null;
  }
  if (name === "no_love_declaration") {
    for (const e of story) {
      const m = LOVE_RE.exec(e.reply);
      if (m) return `"${m[0]}" (turn ${e.index + 1})`;
    }
    return null;
  }
  if (name === "no_lists") {
    for (const e of story) {
      if (e.reply.includes("**") || e.reply.split("\n").some((l) => /^\s*(?:#|[-*]\s|\d+\.\s)/.test(l))) return `list or markdown markers (turn ${e.index + 1})`;
    }
    return null;
  }
  if (name === "no_em_dash") {
    for (const e of story) if (BAD_TYPOGRAPHY.test(e.reply)) return `dash or ellipsis character stored (turn ${e.index + 1})`;
    return null;
  }
  if (name === "reply_nonempty") {
    for (const e of exchanges) if (!e.reply || !e.reply.trim()) return `empty reply (turn ${e.index + 1})`;
    return null;
  }
  if (name === "reply_length_varies") {
    // Uniformly short replies in a low-energy exchange are natural; a run of same-shaped
    // mid or long replies is the "uniform message shape" failure the docs describe.
    if (replies.length < 3) return null;
    const bands = new Set(replies.map(lengthBand));
    if (bands.size >= 2 || bands.has("short")) return null;
    return `all ${replies.length} replies fall in the "${[...bands][0]}" band`;
  }
  if (name === "mentions_emergency_help") {
    return replies.some((r) => EMERGENCY_RE.test(r)) ? null : "no reply points at emergency help";
  }
  if (name === "operator_reply_present") {
    const ops = exchanges.filter((e) => e.kind === "operator");
    if (!ops.length) return "scenario has no OPERATOR: turn";
    for (const e of ops) if (!e.reply || !e.reply.trim()) return `empty operator reply (turn ${e.index + 1})`;
    return null;
  }
  return undefined; // not a mechanical check: qualitative, left to the owner
}

// ------------------------------------------------------------------ one scenario

// v3: a scenario may carry `settings` (the half-remember scenario sets provisionalRecallEvery
// to 8). They are written before the scenario and put back after it, whatever happens.
async function withScenarioSettings(base, scenario, fn) {
  const patch = scenario.settings && typeof scenario.settings === "object" && !Array.isArray(scenario.settings) ? scenario.settings : null;
  if (!patch || !Object.keys(patch).length) return fn();
  const current = (await api(base, "GET", "/api/settings")).json;
  const original = {};
  for (const k of Object.keys(patch)) original[k] = current ? current[k] : undefined;
  const put = await api(base, "PUT", "/api/settings", patch);
  if (put.status !== 200) throw new Error(`scenario settings ${JSON.stringify(patch)} refused: ${put.status} ${put.text.slice(0, 200)}`);
  try {
    return await fn();
  } finally {
    const back = await api(base, "PUT", "/api/settings", original);
    if (back.status !== 200) console.error(`scenario settings restore failed: ${back.status} ${back.text.slice(0, 200)}; put ${JSON.stringify(original)} back by hand`);
  }
}

async function runScenario(base, scenario, stamp) {
  return withScenarioSettings(base, scenario, () => runScenarioInner(base, scenario, stamp));
}

async function runScenarioInner(base, scenario, stamp) {
  const conv = await api(base, "POST", "/api/conversations", { title: `behavior ${scenario.id}` });
  if (conv.status !== 201) throw new Error(`conversation create failed: ${conv.status} ${conv.text.slice(0, 200)}`);
  const conversationId = conv.json.id;
  const exchanges = [];
  let errors = 0;

  for (let i = 0; i < scenario.turns.length; i++) {
    const raw = scenario.turns[i];
    const started = Date.now();
    if (raw.startsWith("OPERATOR: ")) {
      const content = raw.slice("OPERATOR: ".length);
      const r = await api(base, "POST", "/api/operator", { content, conversationId });
      const ok = r.status === 200 && r.json && typeof r.json.reply === "string";
      if (!ok) errors++;
      exchanges.push({ index: i, kind: "operator", user: content, reply: ok ? r.json.reply : "", flags: [], ms: Date.now() - started, error: ok ? null : `${r.status} ${(r.json && r.json.code) || r.text.slice(0, 120)}` });
      continue;
    }
    const r = await api(base, "POST", `/api/conversations/${conversationId}/turn`, { content: raw, idempotencyKey: `bh-${stamp}-${scenario.id}-${i}` });
    const ok = r.status === 200 && r.json && r.json.assistantMessage;
    if (!ok) errors++;
    exchanges.push({
      index: i,
      kind: "story",
      user: raw,
      reply: ok ? r.json.assistantMessage.content : "",
      flags: ok ? (r.json.flags || []).map((f) => f.code) : [],
      imagePending: ok ? !!r.json.imagePending : false,
      song: ok && r.json.assistantMessage.song_json ? safeJson(r.json.assistantMessage.song_json) : null,
      ms: Date.now() - started,
      error: ok ? null : `${r.status} ${(r.json && r.json.code) || r.text.slice(0, 120)}`,
    });
  }

  const results = [];
  for (const name of scenario.autoChecks || []) {
    const verdict = evaluateCheck(name, exchanges);
    results.push({ name, mechanical: verdict !== undefined, reason: verdict === undefined ? null : verdict });
  }
  const failed = results.filter((r) => r.mechanical && r.reason);
  const qualitative = results.filter((r) => !r.mechanical);
  let auto;
  if (errors) auto = `ERROR (${errors} turn${errors === 1 ? "" : "s"} failed)`;
  else if (failed.length) auto = "FAIL: " + failed.map((f) => f.name).join(", ");
  else auto = "PASS";
  if (qualitative.length) auto += ` (needs owner: ${qualitative.map((q) => q.name).join(", ")})`;

  return { scenario, conversationId, exchanges, results, failed, errors, auto };
}

function safeJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// Runs every scenario in order, printing one line each; never throws for one scenario.
async function runAll(base, scenarios, stamp, label = "") {
  const runs = [];
  for (const scenario of scenarios) {
    const t0 = Date.now();
    try {
      const run = await runScenario(base, scenario, stamp + (label ? "-" + label : ""));
      runs.push(run);
      const flags = run.exchanges.flatMap((e) => e.flags);
      console.log(`${run.errors ? "ERROR" : run.failed.length ? "FAIL " : "PASS "} ${label ? "[" + label + "] " : ""}${scenario.id}  ${scenario.title}  (${run.exchanges.length} turns, ${flags.length} flag${flags.length === 1 ? "" : "s"}, ${Date.now() - t0} ms)`);
      for (const f of run.failed) console.log(`        ${f.name}: ${f.reason}`);
      for (const e of run.exchanges.filter((x) => x.error)) console.log(`        turn ${e.index + 1}: ${e.error}`);
    } catch (e) {
      console.log(`ERROR ${label ? "[" + label + "] " : ""}${scenario.id}  ${scenario.title}: ${e instanceof Error ? e.message : String(e)}`);
      runs.push({ scenario, conversationId: "(none)", exchanges: [], results: [], failed: [], errors: 1, auto: "ERROR (could not run)" });
    }
  }
  return runs;
}

// ------------------------------------------------------------------ report

const md = (s) => String(s).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

function flagSummary(exchanges) {
  const counted = {};
  for (const f of exchanges.flatMap((e) => e.flags)) counted[f] = (counted[f] || 0) + 1;
  return Object.entries(counted).map(([k, v]) => (v > 1 ? `${k} x${v}` : k)).join(", ") || "none";
}

function writeReport(path, runs, meta) {
  const lines = [];
  lines.push(`# Behavior run ${meta.stampIso}`);
  lines.push("");
  lines.push(`- base: ${meta.base}`);
  lines.push(`- provider: ${meta.settings ? meta.settings.provider : "(unknown)"}, model: ${meta.settings ? meta.settings.model : "(unknown)"}`);
  lines.push(`- prompt version: ${meta.system ? meta.system.promptVersion : "(unknown)"}, constitution: ${meta.system ? meta.system.constitutionVersion : "(unknown)"}`);
  lines.push(`- state: hasSharedHistory ${meta.state ? meta.state.hasSharedHistory : "?"}, facts about him ${meta.state ? meta.state.facts.justin.length : "?"}, history entries ${meta.state ? meta.state.history.length : "?"}`);
  lines.push(`- scenarios: ${runs.length}, mechanical pass: ${runs.filter((r) => !r.errors && !r.failed.length).length}, mechanical fail: ${runs.filter((r) => !r.errors && r.failed.length).length}, errors: ${runs.filter((r) => r.errors).length}`);
  lines.push("");
  lines.push("Mechanical checks only. Every scenario carries a rubric for the owner; \"needs owner\" is not a failure.");
  lines.push("");
  lines.push("| # | scenario | turns | flags | auto result |");
  lines.push("|---|---|---|---|---|");
  runs.forEach((r, i) => {
    lines.push(`| ${i + 1} | ${md(r.scenario.id)}: ${md(r.scenario.title)} | ${r.exchanges.length} | ${md(flagSummary(r.exchanges))} | ${md(r.auto)} |`);
  });
  lines.push("");
  lines.push("## Transcripts");
  for (const r of runs) {
    lines.push("");
    lines.push(`### ${r.scenario.id}: ${r.scenario.title}`);
    lines.push("");
    lines.push(`Conversation: ${r.conversationId}`);
    lines.push("");
    lines.push(`Rubric (owner): ${r.scenario.rubric}`);
    if (r.scenario.notes) {
      lines.push("");
      lines.push(`Notes: ${r.scenario.notes}`);
    }
    lines.push("");
    lines.push(`Auto: ${r.auto}`);
    for (const f of r.failed) lines.push(`- ${f.name}: ${f.reason}`);
    lines.push("");
    for (const e of r.exchanges) {
      const who = e.kind === "operator" ? "Operator query" : "You";
      lines.push(`**${who}:** ${e.user}`);
      lines.push("");
      const her = e.kind === "operator" ? "Operator" : "Avelie";
      if (e.error) lines.push(`**${her}:** [error ${e.error}]`);
      else lines.push(`**${her}:** ${e.reply.split("\n").join("  \n")}`);
      const tags = [];
      if (e.flags.length) tags.push("flags: " + e.flags.join(", "));
      if (e.imagePending) tags.push("photo requested");
      if (e.song) tags.push(`song: ${e.song.artist} - ${e.song.title}`);
      tags.push(`${e.ms} ms`);
      lines.push("");
      lines.push(`_${tags.join(" | ")}_`);
      lines.push("");
    }
  }
  writeFileSync(path, lines.join("\n") + "\n");
}

// The vessel test report: the same scenarios, one column per provider:model.
function writeCompareReport(path, columns, meta) {
  const lines = [];
  const labels = columns.map((c) => c.label);
  lines.push(`# Vessel test ${meta.stampIso}`);
  lines.push("");
  lines.push(`- base: ${meta.base}`);
  lines.push(`- prompt version: ${meta.system ? meta.system.promptVersion : "(unknown)"}, constitution: ${meta.system ? meta.system.constitutionVersion : "(unknown)"}`);
  lines.push(`- state: hasSharedHistory ${meta.state ? meta.state.hasSharedHistory : "?"}, facts about him ${meta.state ? meta.state.facts.justin.length : "?"}, history entries ${meta.state ? meta.state.history.length : "?"}`);
  columns.forEach((c, i) => {
    const flags = c.runs.reduce((n, r) => n + r.exchanges.flatMap((e) => e.flags).length, 0);
    lines.push(`- column ${String.fromCharCode(65 + i)}: ${c.label} (mechanical pass ${c.runs.filter((r) => !r.errors && !r.failed.length).length} of ${c.runs.length}, ${flags} flag${flags === 1 ? "" : "s"}, errors ${c.runs.filter((r) => r.errors).length})`);
  });
  lines.push("");
  lines.push("Same rules, same memory, same scenarios; only the model changes. The character survives the model when the columns read the same. \"Reads the same?\" is the owner's call, per scenario; the flag counts are mechanical.");
  lines.push("");
  const head = ["#", "scenario", ...labels.flatMap((l) => [`flags ${l}`, `auto ${l}`]), "reads the same? (owner)"];
  lines.push("| " + head.map(md).join(" | ") + " |");
  lines.push("|" + head.map(() => "---").join("|") + "|");
  const first = columns[0].runs;
  first.forEach((r0, i) => {
    const cells = [String(i + 1), `${md(r0.scenario.id)}: ${md(r0.scenario.title)}`];
    for (const c of columns) {
      const r = c.runs[i];
      cells.push(r ? md(flagSummary(r.exchanges)) : "(not run)");
      cells.push(r ? md(r.auto) : "(not run)");
    }
    cells.push("");
    lines.push("| " + cells.join(" | ") + " |");
  });
  lines.push("");
  lines.push("## Side by side");
  first.forEach((r0, i) => {
    lines.push("");
    lines.push(`### ${r0.scenario.id}: ${r0.scenario.title}`);
    lines.push("");
    lines.push(`Rubric (owner): ${r0.scenario.rubric}`);
    if (r0.scenario.notes) {
      lines.push("");
      lines.push(`Notes: ${r0.scenario.notes}`);
    }
    lines.push("");
    columns.forEach((c, k) => {
      const r = c.runs[i];
      lines.push(`- ${String.fromCharCode(65 + k)} ${c.label}: ${r ? r.auto : "(not run)"}; conversation ${r ? r.conversationId : "(none)"}`);
    });
    lines.push("");
    lines.push("| turn | you | " + labels.map(md).join(" | ") + " |");
    lines.push("|---|---|" + labels.map(() => "---").join("|") + "|");
    const turns = r0.scenario.turns.length;
    for (let t = 0; t < turns; t++) {
      const cells = [String(t + 1), md(r0.scenario.turns[t])];
      for (const c of columns) {
        const e = c.runs[i] ? c.runs[i].exchanges[t] : null;
        if (!e) cells.push("(not run)");
        else if (e.error) cells.push(`[error ${md(e.error)}]`);
        else {
          const tags = [];
          if (e.flags.length) tags.push("flags: " + e.flags.join(", "));
          if (e.imagePending) tags.push("photo requested");
          if (e.song) tags.push(`song: ${e.song.artist} - ${e.song.title}`);
          cells.push(md(e.reply) + (tags.length ? ` _(${md(tags.join("; "))})_` : ""));
        }
      }
      lines.push("| " + cells.join(" | ") + " |");
    }
    lines.push("");
    lines.push("Reads the same? (owner): ");
  });
  writeFileSync(path, lines.join("\n") + "\n");
}

// ------------------------------------------------------------------ main

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const all = JSON.parse(readFileSync(SCENARIOS_PATH, "utf8"));
  const wanted = args.only ? new Set(args.only.split(",").map((s) => s.trim()).filter(Boolean)) : null;
  // --only takes ids and group names (life, v3, acceptance, pressure, v5).
  const scenarios = wanted ? all.filter((s) => wanted.has(s.id) || wanted.has(s.group)) : all;
  if (!scenarios.length) {
    console.error("no scenarios selected" + (wanted ? ` for --only ${args.only}` : ""));
    process.exit(2);
  }

  const me = await api(args.base, "GET", "/api/me").catch((e) => ({ status: 0, json: null, text: e.message }));
  if (me.status !== 200) {
    console.error(`cannot reach ${args.base}/api/me: ${me.status} ${me.text.slice(0, 200)}`);
    process.exit(2);
  }

  if (args.provider || args.model) {
    const patch = {};
    if (args.provider) patch.provider = args.provider;
    if (args.model) patch.model = args.model;
    const r = await api(args.base, "PUT", "/api/settings", patch);
    if (r.status !== 200) {
      console.error(`settings update failed: ${r.status} ${r.text.slice(0, 200)}`);
      process.exit(2);
    }
  }

  const settings = (await api(args.base, "GET", "/api/settings")).json;
  const system = (await api(args.base, "GET", "/api/system")).json;
  const state = (await api(args.base, "GET", "/api/state")).json;
  const stampIso = new Date().toISOString();
  const stamp = stampIso.replace(/[:.]/g, "-");
  if (args.compare) {
    console.log(`vessel test: ${scenarios.length} scenario(s) x ${args.compare.length} configurations against ${args.base}`);
  } else {
    console.log(`behavior: ${scenarios.length} scenario(s) against ${args.base} (provider ${settings ? settings.provider : "?"}, model ${settings ? settings.model : "?"})`);
  }
  if (state && (state.hasSharedHistory || state.facts.justin.length)) {
    console.log("note: the server is not on a fresh start (shared history or facts about him exist); first-meeting scenarios read differently");
  }

  // Optional cap for the run, restored afterwards whatever happens.
  let restoreCaps = null;
  if (args.dailyCap !== null && settings) {
    const original = { dailyCapUsd: settings.dailyCapUsd, monthlyCapUsd: settings.monthlyCapUsd };
    const patch = { dailyCapUsd: args.dailyCap, monthlyCapUsd: Math.max(settings.monthlyCapUsd, args.dailyCap) };
    const r = await api(args.base, "PUT", "/api/settings", patch);
    if (r.status !== 200) {
      console.error(`cap update failed: ${r.status} ${r.text.slice(0, 200)}`);
      process.exit(2);
    }
    console.log(`caps for this run: daily $${patch.dailyCapUsd}, monthly $${patch.monthlyCapUsd} (restored to $${original.dailyCapUsd} / $${original.monthlyCapUsd} afterwards)`);
    restoreCaps = async () => {
      const back = await api(args.base, "PUT", "/api/settings", original);
      if (back.status !== 200) console.error(`cap restore failed: ${back.status} ${back.text.slice(0, 200)}; put dailyCapUsd ${original.dailyCapUsd} and monthlyCapUsd ${original.monthlyCapUsd} back by hand`);
    };
  }

  mkdirSync(REPORTS_DIR, { recursive: true });

  // ---------------------------------------------------------------- compare mode

  if (args.compare) {
    const originalModel = settings ? { provider: settings.provider, model: settings.model } : null;
    const columns = [];
    let switchFailed = null;
    try {
      for (const cfg of args.compare) {
        const label = `${cfg.provider}:${cfg.model}`;
        const put = await api(args.base, "PUT", "/api/settings", { provider: cfg.provider, model: cfg.model });
        if (put.status !== 200) {
          switchFailed = `settings switch to ${label} failed: ${put.status} ${put.text.slice(0, 200)}`;
          console.error(switchFailed);
          break;
        }
        const colSettings = put.json;
        console.log(`\n== ${label} ==`);
        const runs = await runAll(args.base, scenarios, stamp, label.replace(/[^A-Za-z0-9]+/g, "_").slice(0, 24));
        columns.push({ label, settings: colSettings, runs });
      }
    } finally {
      if (originalModel) {
        const back = await api(args.base, "PUT", "/api/settings", originalModel);
        if (back.status !== 200) console.error(`model restore failed: ${back.status} ${back.text.slice(0, 200)}; put provider ${originalModel.provider} and model ${originalModel.model} back by hand`);
        else console.log(`\nsettings restored: provider ${originalModel.provider}, model ${originalModel.model}`);
      }
      if (restoreCaps) await restoreCaps();
    }
    if (switchFailed || columns.length < 2) {
      console.error("vessel test: fewer than two columns ran" + (switchFailed ? " (" + switchFailed + ")" : ""));
      process.exit(1);
    }
    const reportPath = join(REPORTS_DIR, `compare_${stamp}.md`);
    writeCompareReport(reportPath, columns, { stampIso, base: args.base, system, state });
    let errors = 0;
    let mechanicalFail = 0;
    let budgetHits = 0;
    for (const c of columns) {
      errors += c.runs.filter((r) => r.errors).length;
      mechanicalFail += c.runs.filter((r) => !r.errors && r.failed.length).length;
      budgetHits += c.runs.reduce((n, r) => n + r.exchanges.filter((e) => e.error && e.error.includes("budget_exceeded")).length, 0);
    }
    console.log("");
    for (const c of columns) {
      const pass = c.runs.filter((r) => !r.errors && !r.failed.length).length;
      const flags = c.runs.reduce((n, r) => n + r.exchanges.flatMap((e) => e.flags).length, 0);
      console.log(`${c.label}: mechanical pass ${pass} of ${c.runs.length}, ${flags} flag(s), errors ${c.runs.filter((r) => r.errors).length}`);
    }
    if (budgetHits) console.log(`hint: ${budgetHits} turn(s) hit the spend cap (402 budget_exceeded); rerun with --daily-cap <usd>, which is restored after the run`);
    console.log(`"reads the same?" is the owner's line per scenario; report: ${reportPath}`);
    process.exit(errors ? 1 : args.strict && mechanicalFail ? 1 : 0);
  }

  // ---------------------------------------------------------------- single run

  let runs = [];
  try {
    runs = await runAll(args.base, scenarios, stamp);
  } finally {
    if (restoreCaps) await restoreCaps();
  }

  const reportPath = join(REPORTS_DIR, `behavior_${stamp}.md`);
  writeReport(reportPath, runs, { stampIso, base: args.base, settings, system, state });

  const mechanicalFail = runs.filter((r) => !r.errors && r.failed.length).length;
  const errors = runs.filter((r) => r.errors).length;
  const pass = runs.length - mechanicalFail - errors;
  const budgetHits = runs.reduce((n, r) => n + r.exchanges.filter((e) => e.error && e.error.includes("budget_exceeded")).length, 0);
  console.log("");
  console.log(`scenarios: ${runs.length}  mechanical pass: ${pass}  mechanical fail: ${mechanicalFail}  errors: ${errors}`);
  if (budgetHits) console.log(`hint: ${budgetHits} turn(s) hit the spend cap (402 budget_exceeded); rerun with --daily-cap <usd>, which is restored after the run`);
  console.log(`every scenario needs the owner's read of its rubric; report: ${reportPath}`);
  process.exit(errors ? 1 : args.strict && mechanicalFail ? 1 : 0);
}

main().catch((e) => {
  console.error("behavior: " + (e instanceof Error ? e.stack || e.message : String(e)));
  process.exit(1);
});
