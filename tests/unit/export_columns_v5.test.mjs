// Review fix (v5): the export guard covers every table the export carries, not only messages.
// Each TableSpec in src/exportImport.ts must list every column its table has after the
// migrations (CREATE TABLE plus every ALTER TABLE ... ADD COLUMN), so a snapshot restore never
// drops a column. conversations.his_face_seq (0007) was the one missing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const src = readFileSync(new URL("../../src/exportImport.ts", import.meta.url), "utf8");

function specColumns() {
  const out = new Map();
  const re = /table: "([a-z_]+)",/g;
  const hits = [...src.matchAll(re)];
  hits.forEach((m, i) => {
    const end = i + 1 < hits.length ? hits[i + 1].index : src.length;
    const block = src.slice(m.index, end);
    const cols = new Set([...block.matchAll(/\{ name: "([a-z0-9_]+)"/g)].map((x) => x[1]));
    out.set(m[1], cols);
  });
  return out;
}

function splitTop(body) {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

const CONSTRAINT = /^(?:PRIMARY|UNIQUE|CHECK|FOREIGN|CONSTRAINT)\b/i;

function migrationColumns() {
  const dir = new URL("../../migrations/", import.meta.url);
  const out = new Map();
  const add = (t, c) => { if (!out.has(t)) out.set(t, new Set()); out.get(t).add(c); };
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    const sql = readFileSync(new URL(f, dir), "utf8").replace(/--[^\n]*/g, "");
    for (const m of sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+)\s*\(/gi)) {
      let depth = 1;
      let i = m.index + m[0].length;
      const start = i;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "(") depth++;
        if (sql[i] === ")") depth--;
        i++;
      }
      for (const part of splitTop(sql.slice(start, i - 1))) {
        const t = part.trim();
        if (!t || CONSTRAINT.test(t)) continue;
        add(m[1], t.split(/\s+/)[0].replace(/"/g, ""));
      }
    }
    for (const m of sql.matchAll(/ALTER TABLE ([a-z0-9_]+) ADD COLUMN ([a-z0-9_]+)/gi)) add(m[1], m[2]);
  }
  return out;
}

test("every column of every exported table is in its TableSpec", () => {
  const specs = specColumns();
  const tables = migrationColumns();
  assert.ok(specs.size >= 30, "found the table specs");
  const missing = [];
  for (const [table, cols] of specs) {
    const real = tables.get(table);
    assert.ok(real, table + " has a CREATE TABLE");
    for (const c of real) if (!cols.has(c)) missing.push(table + "." + c);
  }
  assert.deepEqual(missing, []);
});
