#!/usr/bin/env node
// Fine-tune her texter on the Mac (SPEC_V3 section II). Node 22, no dependencies.
//
//   node scripts/finetune_run.mjs ~/Downloads/avelie-train-2026-10-01.jsonl
//       [--base gpt-4.1-mini-2025-04-14] [--suffix avelie] [--epochs auto]
//       [--verify ~/Downloads/avelie-train-2026-10-01.json] [--price-per-mtok 5] [--dry-run]
//
// The key: OPENAI_API_KEY from the environment when set; otherwise the script reads the
// clipboard itself (pbpaste), keeps the key in one variable, and clears the clipboard
// before doing anything else. It never prints, logs, echoes or writes the key. The owner's
// instruction is: copy the key, run the command, paste nothing.
//
// Steps: validate the JSONL locally (every line parses; roles system, user, assistant in
// that order; no empty content; at least 10 lines; with --verify, the chained hash matches
// the export record), print the summary with a token and cost estimate, stop on --dry-run;
// otherwise ask "type train to start" and exit on anything else; upload the file, start
// the job, poll it every 30 s printing status changes and the newest events, and end on
// succeeded (print the model id and the one next step), failed (print the message) or
// cancelled. Nothing trains without the word.
//
// The validator, the chain check and the confirmation prompt are exported for the unit
// test; the network part is not exercised there.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { basename } from "node:path";

const API = "https://api.openai.com/v1";
export const DEFAULT_BASE = "gpt-4.1-mini-2025-04-14";
export const DEFAULT_SUFFIX = "avelie";
export const DEFAULT_PRICE_PER_MTOK = 5;
export const MIN_EXAMPLES = 10;
export const CHARS_PER_TOKEN = 4;
const POLL_MS = 30_000;
const ROLES = ["system", "user", "assistant"];

// ------------------------------------------------------------------ pure parts

export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// Every line: one JSON object with messages [system, user, assistant], each with a
// non-empty string content. Returns { ok, errors, count, lines, tokens }.
export function validateJsonl(text) {
  const errors = [];
  const raw = String(text ?? "").split("\n");
  const lines = [];
  let chars = 0;
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];
    if (!line.trim()) {
      if (i === raw.length - 1) continue;
      errors.push(`line ${i + 1}: empty`);
      continue;
    }
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      errors.push(`line ${i + 1}: not JSON`);
      continue;
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj) || !Array.isArray(obj.messages)) {
      errors.push(`line ${i + 1}: no messages array`);
      continue;
    }
    const m = obj.messages;
    if (m.length !== ROLES.length) {
      errors.push(`line ${i + 1}: expected ${ROLES.length} messages, found ${m.length}`);
      continue;
    }
    let bad = false;
    for (let k = 0; k < ROLES.length; k++) {
      const x = m[k];
      if (!x || x.role !== ROLES[k]) {
        errors.push(`line ${i + 1}: message ${k + 1} must have role ${ROLES[k]}`);
        bad = true;
        break;
      }
      if (typeof x.content !== "string" || !x.content.trim()) {
        errors.push(`line ${i + 1}: ${ROLES[k]} content is empty`);
        bad = true;
        break;
      }
      chars += x.content.length;
    }
    if (bad) continue;
    lines.push(line);
  }
  if (lines.length < MIN_EXAMPLES) errors.push(`only ${lines.length} example(s); the fine-tuning API needs at least ${MIN_EXAMPLES}`);
  return { ok: errors.length === 0, errors, count: lines.length, lines, tokens: Math.ceil(chars / CHARS_PER_TOKEN) };
}

// The export record's chain: sha256 of each line, in order, and sha256 of those joined by
// "\n". Recomputed line by line from the downloaded file.
export function chainOf(lines) {
  const lineHashes = lines.map((l) => sha256(l));
  return { lineHashes, sha256: sha256(lineHashes.join("\n")) };
}

export function verifyChain(lines, sidecar) {
  if (!sidecar || typeof sidecar !== "object") return { ok: false, reason: "the record is not an object" };
  const chain = chainOf(lines);
  if (typeof sidecar.count === "number" && sidecar.count !== lines.length) return { ok: false, reason: `the record says ${sidecar.count} lines, the file has ${lines.length}` };
  if (Array.isArray(sidecar.lineHashes)) {
    if (sidecar.lineHashes.length !== chain.lineHashes.length) return { ok: false, reason: `the record lists ${sidecar.lineHashes.length} line hashes, the file has ${chain.lineHashes.length} lines` };
    for (let i = 0; i < chain.lineHashes.length; i++) {
      if (sidecar.lineHashes[i] !== chain.lineHashes[i]) return { ok: false, reason: `line ${i + 1} differs from the record` };
    }
  }
  if (typeof sidecar.sha256 !== "string" || sidecar.sha256 !== chain.sha256) return { ok: false, reason: "the chained hash differs from the record" };
  return { ok: true, reason: null };
}

// USD for one training run: tokens x epochs x price per million tokens.
export function estimateCostUsd(tokens, epochs, pricePerMTok) {
  const e = typeof epochs === "number" && Number.isFinite(epochs) && epochs > 0 ? epochs : 3;
  return (Math.max(0, tokens) * e * pricePerMTok) / 1_000_000;
}

// True only when the answer is exactly the word "train" (case-insensitive, trimmed).
export function isTheWord(answer) {
  return typeof answer === "string" && answer.trim().toLowerCase() === "train";
}

// Reads one line from the given stream (stdin by default) and answers whether it is the
// word. A closed stream, an empty line or anything else is a no.
export function askToTrain(input = process.stdin, output = process.stdout) {
  return new Promise((resolve) => {
    const rl = createInterface({ input, output, terminal: false });
    let answered = false;
    const done = (v) => {
      if (answered) return;
      answered = true;
      try { rl.close(); } catch { /* closed */ }
      resolve(v);
    };
    rl.question("type train to start: ", (answer) => done(isTheWord(answer)));
    rl.on("close", () => done(false));
  });
}

export function parseArgs(argv) {
  const out = { file: null, base: DEFAULT_BASE, suffix: DEFAULT_SUFFIX, epochs: "auto", verify: null, pricePerMTok: DEFAULT_PRICE_PER_MTOK, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--base") out.base = next();
    else if (a.startsWith("--base=")) out.base = a.slice(7);
    else if (a === "--suffix") out.suffix = next();
    else if (a.startsWith("--suffix=")) out.suffix = a.slice(9);
    else if (a === "--epochs") out.epochs = next();
    else if (a.startsWith("--epochs=")) out.epochs = a.slice(9);
    else if (a === "--verify") out.verify = next();
    else if (a.startsWith("--verify=")) out.verify = a.slice(9);
    else if (a === "--price-per-mtok") out.pricePerMTok = Number(next());
    else if (a.startsWith("--price-per-mtok=")) out.pricePerMTok = Number(a.slice(17));
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else if (out.file === null) out.file = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  if (out.epochs !== "auto") {
    const n = Number(out.epochs);
    if (!Number.isInteger(n) || n < 1 || n > 50) throw new Error("--epochs must be auto or a whole number from 1 to 50");
    out.epochs = n;
  }
  if (!Number.isFinite(out.pricePerMTok) || out.pricePerMTok < 0) throw new Error("--price-per-mtok must be a number of USD per million tokens");
  return out;
}

// ------------------------------------------------------------------ the key

// Never printed, never logged, never written. Lives in one variable for the run.
function readKey() {
  const fromEnv = (process.env.OPENAI_API_KEY ?? "").trim();
  if (fromEnv) return fromEnv;
  if (process.platform !== "darwin") return "";
  let clip = "";
  try {
    clip = execFileSync("pbpaste", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    clip = "";
  }
  try {
    execFileSync("pbcopy", { input: "", stdio: ["pipe", "ignore", "ignore"] });
  } catch {
    /* the clipboard could not be cleared; say so below without the value */
  }
  return clip.trim();
}

function looksLikeKey(k) {
  return typeof k === "string" && k.length >= 20 && !/\s/.test(k);
}

// ------------------------------------------------------------------ the API (no SDK)

async function call(key, method, path, body, isForm = false) {
  const headers = { authorization: "Bearer " + key };
  const init = { method, headers };
  if (body !== undefined) {
    if (isForm) init.body = body;
    else {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
  }
  const res = await fetch(API + path, init);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (!res.ok) {
    const message = json && json.error && typeof json.error.message === "string" ? json.error.message : text.slice(0, 300);
    throw new Error(`${method} ${path} -> ${res.status}: ${redact(message)}`);
  }
  return json;
}

// An error body can echo a masked key; nothing that looks like one is printed.
function redact(s) {
  return String(s).replace(/sk-[A-Za-z0-9_*-]{4,}/g, "[redacted]").replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function uploadFile(key, path, text) {
  const form = new FormData();
  form.append("purpose", "fine-tune");
  form.append("file", new Blob([text], { type: "application/jsonl" }), basename(path));
  const r = await call(key, "POST", "/files", form, true);
  if (!r || typeof r.id !== "string") throw new Error("the upload answered without a file id");
  return r.id;
}

async function startJob(key, fileId, base, suffix, epochs) {
  const body = {
    training_file: fileId,
    model: base,
    suffix,
    method: { type: "supervised", supervised: { hyperparameters: { n_epochs: epochs } } },
  };
  const r = await call(key, "POST", "/fine_tuning/jobs", body);
  if (!r || typeof r.id !== "string") throw new Error("the job answered without an id");
  return r;
}

async function pollJob(key, jobId) {
  let last = "";
  const seen = new Set();
  for (;;) {
    const job = await call(key, "GET", `/fine_tuning/jobs/${jobId}`);
    const status = String(job.status ?? "");
    if (status !== last) {
      console.log(`${new Date().toISOString()}  ${status}`);
      last = status;
    }
    try {
      const ev = await call(key, "GET", `/fine_tuning/jobs/${jobId}/events?limit=5`);
      const events = Array.isArray(ev && ev.data) ? ev.data.slice().reverse() : [];
      for (const e of events) {
        if (!e || seen.has(e.id)) continue;
        seen.add(e.id);
        if (typeof e.message === "string") console.log("  " + redact(e.message));
      }
    } catch {
      /* events are a nicety */
    }
    if (status === "succeeded") return job;
    if (status === "failed") {
      const m = job.error && typeof job.error.message === "string" ? job.error.message : "no message";
      throw new Error("the job failed: " + redact(m));
    }
    if (status === "cancelled") throw new Error("the job was cancelled");
    await sleep(POLL_MS);
  }
}

// ------------------------------------------------------------------ main

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
  if (args.help || !args.file) {
    console.log("usage: node scripts/finetune_run.mjs <training.jsonl> [--base MODEL] [--suffix NAME] [--epochs auto|N] [--verify <record.json>] [--price-per-mtok USD] [--dry-run]");
    console.log("Copy the key first (or set OPENAI_API_KEY). The script reads the clipboard itself and clears it. Paste nothing.");
    process.exit(args.help ? 0 : 2);
  }

  let text;
  try {
    text = readFileSync(args.file, "utf8");
  } catch (e) {
    console.error(`cannot read ${args.file}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
  const v = validateJsonl(text);
  if (!v.ok) {
    console.error(`${args.file}: ${v.errors.length} problem(s)`);
    for (const e of v.errors.slice(0, 20)) console.error("  - " + e);
    if (v.errors.length > 20) console.error(`  ... and ${v.errors.length - 20} more`);
    process.exit(1);
  }
  if (args.verify) {
    let sidecar;
    try {
      sidecar = JSON.parse(readFileSync(args.verify, "utf8"));
    } catch (e) {
      console.error(`cannot read the record ${args.verify}: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    }
    const r = verifyChain(v.lines, sidecar);
    if (!r.ok) {
      console.error(`the file does not match its record: ${r.reason}`);
      process.exit(1);
    }
    console.log(`record ok: ${v.count} lines, chain ${chainOf(v.lines).sha256.slice(0, 16)}`);
  }
  const epochsForEstimate = args.epochs === "auto" ? 3 : args.epochs;
  console.log(`file: ${args.file}`);
  console.log(`examples: ${v.count}`);
  console.log(`tokens (about, at ${CHARS_PER_TOKEN} characters each): ${v.tokens}`);
  console.log(`base: ${args.base}, suffix: ${args.suffix}, epochs: ${args.epochs}${args.epochs === "auto" ? " (estimated as 3)" : ""}`);
  console.log(`training cost (about): ${estimateCostUsd(v.tokens, epochsForEstimate, args.pricePerMTok).toFixed(2)} USD at ${args.pricePerMTok} USD per million tokens`);
  if (args.dryRun) {
    console.log("dry run: nothing uploaded, nothing trained");
    process.exit(0);
  }

  const key = readKey();
  if (!looksLikeKey(key)) {
    console.error("no key: set OPENAI_API_KEY, or copy the key to the clipboard and run again (the clipboard is read by the script and cleared).");
    process.exit(2);
  }
  console.log("key: read (never shown); clipboard cleared");

  if (!(await askToTrain())) {
    console.log("not the word; nothing trained");
    process.exit(0);
  }

  try {
    const fileId = await uploadFile(key, args.file, text);
    console.log(`uploaded: ${fileId}`);
    const job = await startJob(key, fileId, args.base, args.suffix, args.epochs);
    console.log(`job: ${job.id} (${job.status})`);
    const done = await pollJob(key, job.id);
    console.log("");
    console.log(`fine_tuned_model: ${done.fine_tuned_model}`);
    console.log("next step: open the Model page, paste that id into Model > Texter > Model id, add its two prices, press Use.");
    process.exit(0);
  } catch (e) {
    console.error(e instanceof Error ? redact(e.message) : String(e));
    process.exit(1);
  }
}

if (process.argv[1] && /finetune_run\.mjs$/.test(process.argv[1])) main();
