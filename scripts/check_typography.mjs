#!/usr/bin/env node
// Fails the build on any em dash, en dash or Unicode ellipsis anywhere in the repo
// (Justin's locked rule: " -- " and "..." only). Frozen source files under
// canon/constitution are checked too; they are known clean.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const ROOT = process.cwd();
const SKIP_DIRS = new Set(["node_modules", ".git", ".wrangler", "backups", "reports", "public/images"]);
const EXT = new Set([".ts", ".js", ".mjs", ".json", ".jsonc", ".md", ".txt", ".sql", ".html", ".css", ".toml", ".yml", ".yaml"]);
const BAD = new RegExp("[" + String.fromCharCode(0x2014, 0x2013, 0x2026) + "]");

const hits = [];
function walk(dir, rel = "") {
  for (const name of readdirSync(dir)) {
    const relPath = rel ? `${rel}/${name}` : name;
    if (SKIP_DIRS.has(relPath) || SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) { walk(full, relPath); continue; }
    if (!EXT.has(extname(name))) continue;
    const text = readFileSync(full, "utf8");
    const lines = text.split("\n");
    lines.forEach((line, i) => { if (BAD.test(line)) hits.push(`${relPath}:${i + 1}: ${line.trim().slice(0, 100)}`); });
  }
}
walk(ROOT);
if (hits.length) {
  console.error(`typography: ${hits.length} hit(s) (em dash, en dash or Unicode ellipsis)`);
  for (const h of hits) console.error("  " + h);
  process.exit(1);
}
console.log("typography: clean");
