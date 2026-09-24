#!/usr/bin/env node
// Refuses a deploy from a checkout that would take her offline or expose her. Runs before
// `wrangler deploy` (package.json "deploy"). Three things must hold in wrangler.jsonc:
//
//   vars.ACCESS_AUD   non-empty  (empty = the Worker fails closed: 503 on every request)
//   workers_dev       false      (no workers.dev address)
//   preview_urls      false      (no preview address)
//
// wrangler.jsonc carries comments, which JSON.parse refuses, so they are stripped first
// (outside strings only), along with trailing commas.
import { readFileSync } from "node:fs";

const FILE = "wrangler.jsonc";

// Removes // and /* */ comments and trailing commas without touching string contents.
export function stripJsonc(text) {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\" && i + 1 < text.length) {
        out += next;
        i += 2;
        continue;
      }
      if (ch === "\"") inString = false;
      i += 1;
      continue;
    }
    if (ch === "\"") {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    if (ch === ",") {
      // A comma followed only by whitespace or comments and then a closing bracket is dropped.
      let j = i + 1;
      for (;;) {
        while (j < text.length && /\s/.test(text[j])) j += 1;
        if (text[j] === "/" && text[j + 1] === "/") {
          while (j < text.length && text[j] !== "\n") j += 1;
          continue;
        }
        if (text[j] === "/" && text[j + 1] === "*") {
          const end = text.indexOf("*/", j + 2);
          j = end < 0 ? text.length : end + 2;
          continue;
        }
        break;
      }
      if (text[j] === "}" || text[j] === "]") {
        i += 1;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

export function deployProblems(config) {
  const problems = [];
  const aud = config && config.vars ? config.vars.ACCESS_AUD : undefined;
  if (typeof aud !== "string" || !aud.trim()) {
    problems.push("vars.ACCESS_AUD is empty: every request would answer 503 access_not_configured (DEPLOY.md section 3 has the tag)");
  }
  if (!config || config.workers_dev !== false) problems.push("workers_dev must be false: the workers.dev address stays off");
  if (!config || config.preview_urls !== false) problems.push("preview_urls must be false: no preview address");
  return problems;
}

function main() {
  let raw;
  try {
    raw = readFileSync(FILE, "utf8");
  } catch (e) {
    console.error(`deploy check: cannot read ${FILE}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  let config;
  try {
    config = JSON.parse(stripJsonc(raw));
  } catch (e) {
    console.error(`deploy check: ${FILE} does not parse: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
  const problems = deployProblems(config);
  if (problems.length) {
    console.error(`deploy check: refusing to deploy from this ${FILE}:`);
    for (const p of problems) console.error("  - " + p);
    process.exit(1);
  }
  console.log(`deploy check: ${FILE} ok (ACCESS_AUD set, workers_dev off, preview_urls off)`);
}

// Runs as a script; importable for the unit test.
if (process.argv[1] && /check_deploy\.mjs$/.test(process.argv[1])) main();
