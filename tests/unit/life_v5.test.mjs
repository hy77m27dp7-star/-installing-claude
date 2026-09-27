// Her life in v5 (SPEC_V5 sections 1 and 8, src/life.ts): placeholder names and the name
// lock, the together and clock-word options of YOUR LIFE RIGHT NOW, and a person from her
// past (a done thread) kept out of her present day.
import { test } from "node:test";
import assert from "node:assert/strict";
import { threadRow, workRoutine, TUE_1510_NY } from "./helpers_v2.mjs";
import { loadSrcIfPresent, guard, scriptedD1, TZ } from "./helpers_v5.mjs";

const life = await loadSrcIfPresent("life");
const callbacks = await loadSrcIfPresent("callbacks");
const t = guard(life, "isPlaceholderName", "PLACEHOLDER_NAMES", "updateThread", "lifeSection");

const MASON = threadRow({ id: "lt_v5_canon_mason", kind: "person", title: "Mason", relation: "ex", status: "done", detail: "A drummer she dated at seventeen." });
const MOTHER = threadRow({ id: "lt_mom", kind: "person", title: "her mother", relation: "mother" });
const DIANE = threadRow({ id: "lt_diane", kind: "person", title: "Diane", relation: "mother" });
const SHOP = threadRow({ id: "lt_shop", kind: "place", title: "the shop" });

function threadDb(rows) {
  const store = rows.map((x) => ({ ...x }));
  const db = scriptedD1([
    [/SELECT \* FROM life_threads WHERE id = \?1/, (b) => store.filter((x) => x.id === b[0])],
    [/INSERT INTO life_threads/, 1],
  ]);
  return db;
}

t("isPlaceholderName: the list, trimmed and case-insensitive; a real name is not one", () => {
  for (const n of ["her mother", " Mom ", "MY DAD", "the shop owner", "her roommate"]) assert.equal(life.isPlaceholderName(n), true, n);
  for (const n of ["Diane", "Mason", "", null]) assert.equal(life.isPlaceholderName(n), false, String(n));
  assert.ok(life.PLACEHOLDER_NAMES.includes("her mother"));
});

t("updateThread: a named person's rename is 409 name_locked; a placeholder may be named; allowRename allows any; a place's title may change", async () => {
  await assert.rejects(life.updateThread(threadDb([DIANE]), "lt_diane", { title: "Linda" }, "owner"), (e) => e.status === 409 && e.code === "name_locked");
  const same = await life.updateThread(threadDb([DIANE]), "lt_diane", { title: " diane ", detail: "a nurse" }, "owner");
  assert.equal(same.detail, "a nurse", "the same name in another case is no rename");
  const named = await life.updateThread(threadDb([MOTHER]), "lt_mom", { title: "Diane" }, "owner");
  assert.equal(named.title, "Diane");
  const forced = await life.updateThread(threadDb([DIANE]), "lt_diane", { title: "Linda" }, "owner", { allowRename: true });
  assert.equal(forced.title, "Linda");
  const place = await life.updateThread(threadDb([SHOP]), "lt_shop", { title: "the shop on Exchange Street" }, "owner");
  assert.equal(place.title, "the shop on Exchange Street");
});

t("lifeSection together: the 'You are ... until' and 'Nothing on your schedule' halves dropped", () => {
  const apart = life.lifeSection([workRoutine()], [], TUE_1510_NY, TZ);
  assert.match(apart, /You are at work until 5:30pm\./);
  const tog = life.lifeSection([workRoutine()], [], TUE_1510_NY, TZ, { together: true });
  assert.ok(!/You are at work/.test(tog));
  assert.ok(!/Nothing on your schedule/.test(tog));
  assert.match(tog, /It is Tuesday 3:10pm\./);
});

t("lifeSection clockWords replace the clock", () => {
  const s = life.lifeSection([workRoutine()], [], TUE_1510_NY, TZ, { together: true, clockWords: "late night" });
  assert.match(s, /It is Tuesday, late night\./);
  assert.ok(!/3:10pm/.test(s));
});

t("Mason's done thread never shows in YOUR LIFE RIGHT NOW", () => {
  const s = life.lifeSection([MASON, DIANE], [], TUE_1510_NY, TZ);
  assert.ok(!/Mason/.test(s));
  assert.match(s, /- Diane \(mother\)/);
});

const tc = guard(callbacks, "pickCallbacks");
tc("Mason's done thread is never a callback", () => {
  for (let i = 0; i < 10; i++) {
    const picks = callbacks.pickCallbacks({ history: [], threads: [MASON], log: [], recentTexts: [], now: TUE_1510_NY, seed: "s" + i });
    assert.deepEqual(picks, []);
  }
});
