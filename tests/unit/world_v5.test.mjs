// A stable world (SPEC_V5 section 8, src/world.ts): people shadowing her person threads, the
// fixed facts of people and places, the relation words that pull a person in, WHO AND WHERE,
// and a life proposal for someone she already has.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BAD_TYPOGRAPHY } from "./helpers.mjs";
import { threadRow } from "./helpers_v2.mjs";
import { loadSrcIfPresent, guard, scriptedD1, personRow, worldFactRow, placeRow } from "./helpers_v5.mjs";

const world = await loadSrcIfPresent("world");
const t = guard(world, "relationNorm", "nameNorm", "syncPeople", "resolveLifePerson", "mentionedEntities", "whoAndWhereSection", "addWorldFact");

const MOTHER = threadRow({ id: "lt_v5_canon_mother", kind: "person", title: "her mother", relation: "mother", detail: "Close; very alike." });
const MASON = threadRow({ id: "lt_v5_canon_mason", kind: "person", title: "Mason", relation: "ex", status: "done", detail: "A drummer she dated at seventeen." });

// An in-memory life_threads + people pair behind a scripted D1.
function lifeDb(threads, people = []) {
  const th = threads.map((x) => ({ ...x }));
  const pe = people.map((x) => ({ ...x }));
  const threadCols = ["id", "kind", "title", "detail", "schedule_json", "status", "relation", "source", "version", "supersedes_id", "created_at", "updated_at"];
  const db = scriptedD1([
    [/SELECT \* FROM life_threads WHERE status != 'superseded'/, () => th.filter((x) => x.status !== "superseded")],
    [/SELECT \* FROM life_threads WHERE id = \?1/, (b) => th.filter((x) => x.id === b[0])],
    [/INSERT INTO life_threads/, (b) => { th.push(Object.fromEntries(threadCols.map((c, i) => [c, b[i]]))); return 1; }],
    [/UPDATE life_threads SET status = 'superseded'/, (b) => { const r = th.find((x) => x.id === b[0] && x.status === b[1]); if (r) { r.status = "superseded"; return 1; } return 0; }],
    [/WITH RECURSIVE up/, (b) => {
      const out = [];
      let cur = th.find((x) => x.id === b[0]);
      while (cur) { out.push({ id: cur.id }); cur = cur.supersedes_id ? th.find((x) => x.id === cur.supersedes_id) : null; }
      return out;
    }],
    [/SELECT \* FROM people ORDER BY/, () => pe.slice()],
    [/SELECT \* FROM people WHERE id = \?1/, (b) => pe.filter((x) => x.id === b[0])],
    [/INSERT OR IGNORE INTO people/, (b) => {
      if (pe.some((x) => x.name_norm === b[3] || x.thread_id === b[1])) return 0;
      pe.push({ id: b[0], thread_id: b[1], name: b[2], name_norm: b[3], relation: b[4], relation_norm: b[5], named: b[6], locked_at: b[7], created_at: b[8], updated_at: b[8] });
      return 1;
    }],
    [/UPDATE people SET thread_id/, (b) => {
      const r = pe.find((x) => x.id === b[0]);
      if (!r) return 0;
      Object.assign(r, { thread_id: b[1], name: b[2], name_norm: b[3], relation: b[4], relation_norm: b[5], named: b[6], locked_at: b[7], updated_at: b[8] });
      return 1;
    }],
  ]);
  db.threads = th;
  db.people = pe;
  return db;
}

t("relationNorm table", () => {
  const table = {
    mom: "mother", "her mom": "mother", mum: "mother", Mama: "mother", mother: "mother", "my dad": "father", papa: "father",
    stepmom: "stepmother", stepdad: "stepfather", ex: "ex", "ex boyfriend": "ex", "ex-boyfriend": "ex", "ex girlfriend": "ex",
    bff: "best friend", "best friend": "best friend", cousin: "cousin",
  };
  for (const [k, v] of Object.entries(table)) assert.equal(world.relationNorm(k), v, k);
  assert.equal(world.relationNorm(""), null);
  assert.equal(world.relationNorm(null), null);
});

t("syncPeople: inserts a row per person head (Mason's done thread too, named; her mother a placeholder, unnamed); a quiet read writes nothing", async () => {
  const db = lifeDb([MOTHER, MASON]);
  const rows = await world.syncPeople(db, db.threads);
  assert.equal(rows.length, 2);
  const mason = rows.find((r) => r.name === "Mason");
  assert.equal(mason.named, 1);
  assert.ok(mason.locked_at);
  assert.equal(mason.relation_norm, "ex");
  const mother = rows.find((r) => r.thread_id === "lt_v5_canon_mother");
  assert.equal(mother.named, 0);
  assert.equal(mother.locked_at, null);
  const writesBefore = db.writes().length;
  await world.syncPeople(db, db.threads);
  assert.equal(db.writes().length, writesBefore, "nothing written on a quiet read");
});

t("syncPeople: the chain moved after a rename keeps the row (and so its facts)", async () => {
  const db = lifeDb([MOTHER], [personRow({ id: "pe_mom", thread_id: "lt_v5_canon_mother", name: "her mother", name_norm: "her mother", relation: "mother", relation_norm: "mother", named: 0, locked_at: null })]);
  const renamed = threadRow({ ...MOTHER, id: "lt_mom2", title: "Diane", version: 2, supersedes_id: MOTHER.id, created_at: "2026-09-26T00:00:00.000Z" });
  db.threads[0].status = "superseded";
  db.threads.push(renamed);
  const rows = await world.syncPeople(db, db.threads);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "pe_mom");
  assert.equal(rows[0].name, "Diane");
  assert.equal(rows[0].named, 1);
  assert.equal(rows[0].thread_id, "lt_mom2");
});

t("resolveLifePerson: the same name is the same thread; 'Diane' as mother renames the placeholder; 'Linda' as mother over Diane is 400; a new friend is created", async () => {
  const db = lifeDb([MOTHER, MASON]);
  const same = await world.resolveLifePerson(db, { kind: "person", title: "mason", relation: "ex" }, "auto");
  assert.equal(same.id, MASON.id, "a done thread stays the same person");
  const diane = await world.resolveLifePerson(db, { kind: "person", title: "Diane", relation: "mother" }, "auto");
  assert.equal(diane.title, "Diane");
  assert.equal(diane.supersedes_id, MOTHER.id, "the placeholder renamed, no new person thread");
  assert.equal(db.threads.filter((x) => x.kind === "person" && x.status === "active").length, 1);
  await assert.rejects(world.resolveLifePerson(db, { kind: "person", title: "Linda", relation: "mom" }, "auto"), (e) => e.status === 400 && /already has a name: Diane/.test(e.message));
  const friend = await world.resolveLifePerson(db, { kind: "person", title: "Dana", relation: "best friend" }, "auto");
  assert.equal(friend.title, "Dana");
  assert.equal(db.threads.filter((x) => x.kind === "person" && x.status !== "superseded").length, 3);
});

t("mentionedEntities: a name, her 'my mom', his 'my mom' (nobody), his 'how is your mom', his 'my ex' (nobody), a place by its title, a day thread", () => {
  const mom = personRow({ id: "pe_mom", thread_id: "lt_mom", name: "Diane", name_norm: "diane", relation: "mother", relation_norm: "mother" });
  const mason = personRow({ id: "pe_mason" });
  const dana = personRow({ id: "pe_dana", thread_id: "lt_dana", name: "Dana", name_norm: "dana", relation: "best friend", relation_norm: "best friend" });
  const shop = placeRow({ id: "pl_shop", title: "the shop on Exchange Street" });
  const people = [mom, mason, dana];
  const pick = (texts, extra = {}) => world.mentionedEntities({ people, places: [shop], texts, dayThreadIds: [], dayPlaceTitles: [], ...extra });
  assert.deepEqual(pick([{ hers: false, text: "did Mason ever call" }]).personIds, ["pe_mason"]);
  assert.deepEqual(pick([{ hers: true, text: "my mom called" }]).personIds, ["pe_mom"]);
  assert.deepEqual(pick([{ hers: false, text: "my mom called me today" }]).personIds, []);
  assert.deepEqual(pick([{ hers: false, text: "how is your mom" }]).personIds, ["pe_mom"]);
  assert.deepEqual(pick([{ hers: false, text: "my ex was like that" }]).personIds, []);
  assert.deepEqual(pick([{ hers: true, text: "back at the shop on Exchange Street" }]).placeIds, ["pl_shop"]);
  assert.deepEqual(pick([], { dayThreadIds: ["lt_dana"] }).personIds, ["pe_dana"]);
});

t("whoAndWhereSection: the wording, the limit, the portrait line; empty when nothing is picked", () => {
  const mason = personRow({ id: "pe_mason" });
  const shop = placeRow({ id: "pl_shop", title: "the shop", detail: "she does the windows" });
  const threads = [MASON];
  const facts = [worldFactRow({ entity_id: "pe_mason", fact: "he still has her hoodie" }), worldFactRow({ id: "wf_2", entity_kind: "place", entity_id: "pl_shop", fact: "it sells candles" })];
  const portraits = { lt_v5_canon_mason: "Tall, shaggy hair, a drummer's forearms" };
  const s = world.whoAndWhereSection({ people: [mason], places: [shop], threads, facts, portraits, picked: { personIds: ["pe_mason"], placeIds: ["pl_shop"] }, limit: 6 });
  const lines = s.split("\n");
  assert.equal(lines[0], "WHO AND WHERE (the people and places in this; their names and these facts are fixed: never rename anyone, never give anyone a second name, never contradict these)");
  assert.equal(lines[1], "- Mason (ex): A drummer she dated at seventeen. he still has her hoodie. Looks: Tall, shaggy hair, a drummer's forearms.");
  assert.equal(lines[2], "- the shop: she does the windows. it sells candles.");
  assert.equal(world.whoAndWhereSection({ people: [mason], places: [shop], threads, facts, portraits, picked: { personIds: ["pe_mason"], placeIds: ["pl_shop"] }, limit: 1 }).split("\n").length, 2);
  assert.equal(world.whoAndWhereSection({ people: [mason], places: [], threads, facts, portraits, picked: { personIds: [], placeIds: [] }, limit: 6 }), "");
  assert.equal(world.whoAndWhereSection({ people: [mason], places: [], threads, facts, portraits, picked: { personIds: ["pe_mason"], placeIds: [] }, limit: 0 }), "");
  assert.ok(!BAD_TYPOGRAPHY.test(s));
});

t("addWorldFact: the entity must exist (404); a live duplicate is 409", async () => {
  const live = [];
  const db = scriptedD1([
    [/SELECT id FROM people WHERE id = \?1/, (b) => (b[0] === "pe_mason" ? [{ id: "pe_mason" }] : [])],
    [/FROM world_facts WHERE entity_kind = \?1 AND entity_id = \?2 AND fact_norm = \?3/, (b) => live.filter((f) => f.entity_id === b[1] && f.fact_norm === b[2])],
    [/INSERT INTO world_facts/, (b) => { live.push({ id: b[0], entity_kind: b[1], entity_id: b[2], fact: b[3], fact_norm: b[4] }); return 1; }],
  ]);
  const row = await world.addWorldFact(db, { entityKind: "person", entityId: "pe_mason", fact: "he still has her hoodie" }, "owner");
  assert.equal(row.status, "approved");
  await assert.rejects(world.addWorldFact(db, { entityKind: "person", entityId: "pe_mason", fact: "He still has her hoodie." }, "owner"), (e) => e.status === 409 && e.code === "duplicate");
  await assert.rejects(world.addWorldFact(db, { entityKind: "person", entityId: "pe_nobody", fact: "x y z" }, "owner"), (e) => e.status === 404);
});
