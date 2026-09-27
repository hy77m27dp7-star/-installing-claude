// src/timeline.ts (DESIGN_EXPERIENCE 8.8): every item carries `story`, the event in words, or
// null when it is machinery. A relationship or scene version has words only when it changed
// against the previous version of the same entity (by version), and the oldest version on a
// page is compared with its predecessor read at the page edge, never with nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSrc, historyRow } from "./helpers.mjs";
import { fakeDb, messageRow, logRow, secretEnv } from "./helpers_v2.mjs";

const { getTimeline, callStory, relationshipStory, sceneStory } = await loadSrc("timeline");
const { outcomeWords } = await loadSrc("arcs");

const D = (n, h = 12) => `2026-09-${String(n).padStart(2, "0")}T${String(h).padStart(2, "0")}:00:00.000Z`;
const S = (id, entity, version, state, created_at) => ({ id, entity, version, state_json: JSON.stringify(state), source: "owner", note: null, created_at });
const asset = (id, extra) => ({ id, file: "candidates/" + id + ".png", role: "scene", sha256: "ab", bytes: 10, approval_status: "approved", conversation_id: "c1", message_id: null, prompt: "a picture", provider: "stub", model: "x", notes: null, created_at: D(5), decided_at: D(5), with_him: 0, ...extra });

function tables() {
  return {
    history: [historyRow({ id: "h1", seq: 1, title: "first kiss at the record store", created_at: D(3), updated_at: D(3) })],
    visual_assets: [
      asset("img_sent", { message_id: "m_photo", created_at: D(5) }),
      asset("img_us", { message_id: "m_photo2", created_at: D(5, 13), with_him: 1 }),
      asset("img_owner", { message_id: null, created_at: D(5, 14) }),
      asset("por_1", { role: "portrait", file: "portraits/por_1.png", created_at: D(6) }),
    ],
    life_log: [logRow({ id: "ll1", occurred: D(7), created_at: D(7), note: "burnt the rice again" })],
    state_versions: [
      S("r1", "relationship", 1, { status: "strangers" }, D(1)),
      S("r2", "relationship", 2, { status: "Strangers " }, D(2)),
      S("r3", "relationship", 3, { status: "seeing each other, early" }, D(8)),
      S("r4", "relationship", 4, { summary: "no status" }, D(9)),
      S("s1", "scene", 1, { status: "none" }, D(1)),
      S("s2", "scene", 2, { status: "together", location: "at the bench by the water" }, D(2)),
      S("s3", "scene", 3, { status: "together", location: "At the  Bench by the water" }, D(2, 13)),
      S("s4", "scene", 4, { status: "together", location: "the record store" }, D(3)),
      S("s5", "scene", 5, { status: "apart", location: null }, D(4)),
      S("s6", "scene", 6, { status: "apart", location: null }, D(4, 13)),
      S("s7", "scene", 7, { status: "together" }, D(9)),
    ],
    messages: [
      messageRow({ id: "m_first", content: "hey you up", created_at: D(10), seq: 9, reply_to_id: null }),
      messageRow({ id: "m_media", content: "listen", created_at: D(11), seq: 10, reply_to_id: "m1", media_id: "md1" }),
    ],
    media_library: [{ id: "md1", kind: "clip", title: "fire escape take 2", description: "her, singing", key: "library/md1.mp3", mime: "audio/mpeg", bytes: 100, sha256: "ef", status: "active", created_at: D(4) }],
    calls: [
      { id: "call_short", conversation_id: "c1", status: "ended", started_at: D(12), ended_at: D(12, 13), seconds: 45, transcript_rows: 3, end_reason: "ended" },
      { id: "call_long", conversation_id: "c1", status: "ended", started_at: D(13), ended_at: D(13, 13), seconds: 150, transcript_rows: 9, end_reason: "ended" },
    ],
    want_log: [
      { id: "wl1", want_id: "w1", occurred: D(14), kind: "progress", delta: 10, note: "signed up at the bar", created_at: D(14) },
      { id: "wl2", want_id: "w1", occurred: D(15), kind: "note", delta: null, note: "", created_at: D(15) },
    ],
    wants: [{ id: "w1", title: "sing at an open mic" }],
    asks: [{ id: "ask1", text: "come to the open mic", status: "open", asked_at: D(16), asked_message_id: null, created_at: D(16) }],
    corrections: [{ id: "cor1", message_id: "m_x", conversation_id: "c1", kind: "not_her", note: "too sharp", original: "x", rewrite: null, created_at: D(17) }],
    beat_runs: [{ id: "br1", due_at: D(18), outcome: "went_well", outcome_note: null, title: "the open mic" }],
  };
}

const storyOf = (items, id) => {
  const i = items.find((x) => x.id === id);
  assert.ok(i, "no item " + id + " in " + items.map((x) => x.id).join(", "));
  return i.story;
};

test("callStory: a minute under 90 s, else the rounded minutes", () => {
  assert.equal(callStory(0), "You talked for a minute");
  assert.equal(callStory(89), "You talked for a minute");
  assert.equal(callStory(90), "You talked for 2 minutes");
  assert.equal(callStory(150), "You talked for 3 minutes");
  assert.equal(callStory(600), "You talked for 10 minutes");
});

test("getTimeline: every item carries story; the words of 8.8 for each type; correction, portrait and a picture she did not send are null", async () => {
  const { items } = await getTimeline(fakeDb(tables()), secretEnv(), {});
  for (const i of items) assert.ok("story" in i, "story on " + i.id);
  assert.equal(storyOf(items, "history:h1"), "first kiss at the record store");
  assert.equal(storyOf(items, "photo:img_sent"), "She sent you a picture");
  assert.equal(storyOf(items, "photo:img_us"), "She sent you a picture of the two of you");
  assert.equal(storyOf(items, "photo:img_owner"), null, "fired from Studio: she did not send it");
  assert.equal(storyOf(items, "portrait:por_1"), null);
  assert.equal(storyOf(items, "life:ll1"), "burnt the rice again");
  assert.equal(storyOf(items, "first_text:m_first"), "She texted first");
  assert.equal(storyOf(items, "media:m_media"), "She sent you fire escape take 2");
  assert.equal(storyOf(items, "call:call_short"), "You talked for a minute");
  assert.equal(storyOf(items, "call:call_long"), "You talked for 3 minutes");
  assert.equal(storyOf(items, "want:wl1"), "sing at an open mic -- signed up at the bar");
  assert.equal(storyOf(items, "want:wl2"), "sing at an open mic", "no note: the title alone");
  assert.equal(storyOf(items, "ask:ask1"), "She asked: come to the open mic");
  assert.equal(storyOf(items, "correction:cor1"), null);
  assert.equal(storyOf(items, "beat:br1"), "the open mic -- " + outcomeWords("went_well"));
  const photo = items.find((i) => i.id === "photo:img_owner");
  assert.equal(photo.title, "photo", "the title keeps its log words");
});

test("getTimeline: a relationship or scene version has words only when it changed against the previous version of the same entity", async () => {
  const { items } = await getTimeline(fakeDb(tables()), secretEnv(), {});
  assert.equal(storyOf(items, "relationship:r1"), "Strangers", "the first version ever");
  assert.equal(storyOf(items, "relationship:r2"), null, "the same status, trimmed and case-folded");
  assert.equal(storyOf(items, "relationship:r3"), "Seeing each other, early");
  assert.equal(storyOf(items, "relationship:r4"), null, "no status");
  assert.equal(storyOf(items, "scene:s1"), null, "none has no words");
  assert.equal(storyOf(items, "scene:s2"), "Together at the bench by the water");
  assert.equal(storyOf(items, "scene:s3"), null, "the same place by placeTitleNorm is no change");
  assert.equal(storyOf(items, "scene:s4"), "Together at the record store");
  assert.equal(storyOf(items, "scene:s5"), "Apart");
  assert.equal(storyOf(items, "scene:s6"), null, "apart again is no change");
  assert.equal(storyOf(items, "scene:s7"), "Together", "together with no place");
  const rel = items.find((i) => i.id === "relationship:r3");
  assert.equal(rel.title, "relationship v3: seeing each other, early", "the title keeps its log words");
});

test("relationshipStory and sceneStory: compared with the given predecessor, or with nothing", () => {
  const j = (o) => JSON.stringify(o);
  assert.equal(relationshipStory(j({ status: "talking" }), null), "Talking");
  assert.equal(relationshipStory(j({ status: "talking" }), j({ status: "TALKING" })), null);
  assert.equal(sceneStory(j({ status: "together", location: "the pier" }), j({ status: "together", location: "the pier" })), null);
  assert.equal(sceneStory(j({ status: "together", location: "the pier" }), j({ status: "together", location: "the diner" })), "Together at the pier");
  assert.equal(sceneStory(j({ status: "Apart" }), j({ status: "together", location: "the pier" })), "Apart");
  assert.equal(sceneStory(j({ status: "none" }), j({ status: "apart" })), null);
  assert.equal(sceneStory("{broken", null), null);
  const store = "the record store on Congress Street, at the used bins by the listening station, the big headphones on the hook";
  assert.equal(sceneStory(j({ status: "together", location: store }), j({ status: "apart" })), "Together at the record store on Congress Street", "the place, not the stage directions");
  assert.equal(sceneStory(j({ status: "together", location: "the record store on Congress Street, at the bins" }), j({ status: "together", location: store })), null, "the same place in other words");
  assert.equal(sceneStory(j({ status: "together", location: "same scene" }), j({ status: "together", location: store })), null, "a filler location never moves the scene");
  assert.equal(sceneStory(j({ status: "together", location: "k" }), j({ status: "apart" })), "Together", "never Together at k");
});

// The page read answers only the rows a real page would hold (newest first, cut at `limit`);
// every other statement goes to the stand-in as usual. The predecessor read is the only way
// the older versions can be seen.
function pagedDb(tablesIn, pageVersions) {
  const base = fakeDb(tablesIn);
  return {
    ...base,
    prepare(sql) {
      const st = base.prepare(sql);
      if (!/FROM state_versions WHERE created_at < \?1/.test(sql)) return st;
      const self = {
        sql,
        binds: [],
        bind(...values) { self.binds = values; st.bind(...values); return self; },
        async all() { base.queries.push({ sql, binds: self.binds }); return { results: pageVersions.map((r) => ({ ...r })), success: true, meta: {} }; },
      };
      return self;
    },
  };
}

test("getTimeline: the oldest version of each entity on a page is compared with its predecessor (one extra read per entity), so a page edge never reads as a change", async () => {
  const all = [
    S("r1", "relationship", 1, { status: "talking" }, D(1)),
    S("r2", "relationship", 2, { status: "talking" }, D(5)),
    S("r3", "relationship", 3, { status: "seeing each other" }, D(6)),
    S("s1", "scene", 1, { status: "together", location: "the bench" }, D(1)),
    S("s2", "scene", 2, { status: "together", location: "The Bench" }, D(5)),
  ];
  const page = all.filter((v) => v.created_at >= D(5));
  const db = pagedDb({ state_versions: all }, page);
  const { items } = await getTimeline(db, secretEnv(), {});
  assert.equal(storyOf(items, "relationship:r2"), null, "compared with v1 (talking), not with nothing");
  assert.equal(storyOf(items, "relationship:r3"), "Seeing each other");
  assert.equal(storyOf(items, "scene:s2"), null, "compared with the bench before the page");
  assert.ok(!items.some((i) => i.id === "relationship:r1" || i.id === "scene:s1"), "the predecessors are not items");
  const edgeReads = db.queries.filter((q) => /version < \?2/.test(q.sql));
  assert.equal(edgeReads.length, 2, "one predecessor read per entity");
  assert.deepEqual(edgeReads.map((q) => q.binds).sort(), [["relationship", 2], ["scene", 2]]);

  // With no predecessor on file the oldest version is its own first change.
  const lone = pagedDb({ state_versions: page }, page);
  const again = await getTimeline(lone, secretEnv(), {});
  assert.equal(storyOf(again.items, "relationship:r2"), "Talking");
  assert.equal(storyOf(again.items, "scene:s2"), "Together at The Bench");
});
