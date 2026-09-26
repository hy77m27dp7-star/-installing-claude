// 2026-09-26: a snapshot restore dropped her song cards because the message export whitelist
// left out five columns that migrations 0004 and 0004d added. Every messages column must be in it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const src = readFileSync(new URL("../../src/exportImport.ts", import.meta.url), "utf8");
const start = src.indexOf('table: "messages"');
const block = src.slice(start, src.indexOf("table:", start + 20));
const exported = new Set([...block.matchAll(/name: "([a-z_]+)"/g)].map((m) => m[1]));

test("every column the migrations add to messages is exported", () => {
  const dir = new URL("../../migrations/", import.meta.url);
  const cols = new Set();
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql"))) {
    const sql = readFileSync(new URL(f, dir), "utf8");
    for (const m of sql.matchAll(/ALTER TABLE messages ADD COLUMN ([a-z_]+)/gi)) cols.add(m[1]);
  }
  assert.ok(cols.size >= 7, "found the ALTERs");
  for (const c of cols) assert.ok(exported.has(c), "messages." + c + " is not exported");
});
