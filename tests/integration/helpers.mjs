// Helpers for the integration runner: a fetch wrapper, a raw HTTP request (for a custom
// Host header, which fetch refuses to send), polling, a PASS/FAIL report with timings, and
// wrangler process control. Plain Node 22, no Workers runtime.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync, createWriteStream } from "node:fs";
import http from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const STATE_DIR = join(ROOT, "tests", "integration", ".state");
export const PORT = Number(process.env.AVELIE_TEST_PORT || 8790);
export const HOST = "127.0.0.1";
export const BASE = `http://${HOST}:${PORT}`;
export const DEV_ACTOR_EMAIL = "justin@newsomeprojects.com";

// Built from code points so this file passes the typography scan.
export const EM_DASH = String.fromCharCode(0x2014);
export const BAD_TYPOGRAPHY = new RegExp("[" + String.fromCharCode(0x2014, 0x2013, 0x2026) + "]");

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ HTTP

export async function api(method, path, body, headers = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, init);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, json, text };
}

export async function fetchBytes(path, headers = {}) {
  const res = await fetch(BASE + path, { headers });
  const buf = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, contentType: res.headers.get("content-type") || "", bytes: buf };
}

// fetch drops a caller-supplied Host header, so the non-local-host probe goes over node:http.
export function rawRequest(path, headers = {}) {
  return new Promise((resolvePromise, reject) => {
    const req = http.request({ host: HOST, port: PORT, path, method: "GET", headers, setHost: false }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { data += c; });
      res.on("end", () => resolvePromise({ status: res.statusCode, text: data }));
    });
    req.on("error", reject);
    req.end();
  });
}

export async function waitFor(label, fn, timeoutMs, intervalMs = 500) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastError = e;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}` + (lastError ? `: ${lastError.message}` : ""));
}

// ------------------------------------------------------------------ report

export class Report {
  constructor() {
    this.results = [];
    this.started = Date.now();
  }

  async check(name, fn) {
    const t0 = Date.now();
    try {
      const note = await fn();
      const ms = Date.now() - t0;
      this.results.push({ name, ok: true, ms, note: note || "" });
      console.log(`PASS  ${name}  (${ms} ms)${note ? "  [" + note + "]" : ""}`);
    } catch (e) {
      const ms = Date.now() - t0;
      const message = e instanceof Error ? e.message : String(e);
      this.results.push({ name, ok: false, ms, error: message });
      console.log(`FAIL  ${name}  (${ms} ms)`);
      for (const line of message.split("\n")) console.log("      " + line);
    }
  }

  get passed() { return this.results.filter((r) => r.ok).length; }
  get failed() { return this.results.filter((r) => !r.ok).length; }

  summary() {
    const total = Date.now() - this.started;
    console.log("");
    console.log(`checks: ${this.results.length}  pass: ${this.passed}  fail: ${this.failed}  (${total} ms total)`);
    if (this.failed) {
      console.log("failed:");
      for (const r of this.results.filter((x) => !x.ok)) console.log(`  - ${r.name}`);
    }
  }
}

// ------------------------------------------------------------------ files

export function removeDir(path) {
  rmSync(path, { recursive: true, force: true });
}

// wrangler dev reads .dev.vars for local secrets. When the repo has none, write the stub
// configuration and hand back a restore function that removes it again.
export function ensureDevVars() {
  const path = join(ROOT, ".dev.vars");
  if (existsSync(path)) return () => {};
  writeFileSync(path, [
    "# temporary: written by tests/integration/run.mjs, removed when the run ends",
    `DEV_ACTOR_EMAIL=${DEV_ACTOR_EMAIL}`,
    "ANTHROPIC_API_KEY=",
    "OPENAI_API_KEY=",
    "DEFAULT_PROVIDER=stub",
    "DEFAULT_IMAGE_PROVIDER=stub",
    "",
  ].join("\n"));
  console.log("wrote a temporary .dev.vars (stub providers); it is removed at the end of the run");
  return () => {
    try {
      rmSync(path);
    } catch {
      /* already gone */
    }
  };
}

// ------------------------------------------------------------------ processes

function wranglerCommand() {
  const local = join(ROOT, "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");
  if (existsSync(local)) return { cmd: local, prefix: [] };
  return { cmd: process.platform === "win32" ? "npx.cmd" : "npx", prefix: ["wrangler"] };
}

export function runCommand(args, opts = {}) {
  const { cmd, prefix } = wranglerCommand();
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, [...prefix, ...args], { cwd: ROOT, env: { ...process.env, ...(opts.env || {}) }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (c) => { output += c; });
    child.stderr.on("data", (c) => { output += c; });
    child.on("close", (code) => resolvePromise({ code: code ?? 1, output }));
    child.on("error", (e) => resolvePromise({ code: 1, output: output + "\n" + e.message }));
  });
}

// Starts wrangler dev in its own process group so the whole tree (workerd included) can be
// stopped at the end. Output goes to a log file under the state directory and the last
// lines stay in memory for the failure report.
export function startWrangler(args, env = {}) {
  const { cmd, prefix } = wranglerCommand();
  mkdirSync(STATE_DIR, { recursive: true });
  const logPath = join(STATE_DIR, "wrangler.log");
  const log = createWriteStream(logPath, { flags: "a" });
  const child = spawn(cmd, [...prefix, "dev", ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tail = [];
  const keep = (chunk) => {
    const text = String(chunk);
    log.write(text);
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      tail.push(line);
      if (tail.length > 60) tail.shift();
    }
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  let exited = false;
  const exit = new Promise((resolvePromise) => {
    child.on("exit", (code, signal) => { exited = true; resolvePromise({ code, signal }); });
    child.on("error", (e) => { exited = true; keep("spawn error: " + e.message + "\n"); resolvePromise({ code: 1, signal: null }); });
  });
  return {
    child,
    logPath,
    exit,
    hasExited: () => exited,
    tail: () => tail.join("\n"),
  };
}

export async function stopWrangler(handle) {
  if (!handle || handle.hasExited()) return;
  const pid = handle.child.pid;
  const signalTree = (sig) => {
    try {
      if (process.platform !== "win32") process.kill(-pid, sig);
      else handle.child.kill(sig);
    } catch {
      try { handle.child.kill(sig); } catch { /* gone */ }
    }
  };
  signalTree("SIGTERM");
  const done = await Promise.race([handle.exit.then(() => true), sleep(8000).then(() => false)]);
  if (!done) {
    signalTree("SIGKILL");
    await Promise.race([handle.exit, sleep(3000)]);
  }
}
