// State that moves (SPEC_V5 section 4, src/standing.ts): the status ladder one rung at a time
// with its lateral states, nicknames appended, friction stamped and healing on story time,
// cooling off on story time, the scene record's four keys, displayStatus.
import { test } from "node:test";
import assert from "node:assert/strict";
import { relationshipState } from "./helpers.mjs";
import {
  loadSrcIfPresent, guard, clockSpan, storyClock, TUE_2100_NY, FRI_1000_NY, DAY_MS, HOUR_MS, plusMs,
} from "./helpers_v5.mjs";

const st = await loadSrcIfPresent("standing");
const t = guard(st, "stepStatus", "statusRung", "lateralOf", "mergeNicknames", "frictionNow", "frictionLine", "coolingOffNow", "moveRelationship", "displayStatus", "normalizeSceneFields", "relationshipMood");

const NOW = new Date(FRI_1000_NY);
const LIVE_STATUS = "seeing each other, early: met two days ago, one real date since";

// ------------------------------------------------------------------ the ladder

t("the ladder: five rungs in order, three lateral states", () => {
  assert.deepEqual([...st.STATUS_LADDER], ["strangers", "talking", "friends", "seeing each other", "together"]);
  assert.deepEqual([...st.LATERAL_STATUSES].sort(), ["cooling off", "on a break", "over"].sort());
});

t("statusRung and lateralOf read the table in its order; the live hand-written status reads rung 3", () => {
  assert.equal(st.statusRung("strangers"), 0);
  assert.equal(st.statusRung("  Talking "), 1);
  assert.equal(st.statusRung("just friends"), 2);
  assert.equal(st.statusRung("dating"), 3);
  assert.equal(st.statusRung("official"), 4);
  assert.equal(st.statusRung("haven't met"), 0);
  assert.equal(st.statusRung(LIVE_STATUS), 3, "the 'seeing each other' rule comes before 'met'");
  assert.equal(st.statusRung("cooling off"), null);
  assert.equal(st.statusRung("purple"), null);
  assert.equal(st.statusRung(42), null);
  assert.equal(st.lateralOf("over"), "over");
  assert.equal(st.lateralOf("they broke up"), "over");
  assert.equal(st.lateralOf("on a break"), "on a break");
  assert.equal(st.lateralOf("cooling off"), "cooling off");
  assert.equal(st.lateralOf("friends"), null);
});

t("stepStatus: strangers to talking; strangers proposed 'seeing each other' clamped to talking with the note", () => {
  const a = st.stepStatus({ status: "strangers" }, "talking", { auto: true });
  assert.equal(a.changed, true);
  assert.equal(a.status, "talking");
  assert.equal(a.clamped, false);
  const b = st.stepStatus({ status: "strangers" }, "seeing each other", { auto: true });
  assert.equal(b.status, "talking");
  assert.equal(b.clamped, true);
  assert.match(b.note ?? "", /status moved one step \(proposed: seeing each other\)/);
  assert.equal(b.statusBefore, null);
});

t("stepStatus: seeing each other to friends is one step down; the same rung keeps his richer wording", () => {
  const a = st.stepStatus({ status: "seeing each other" }, "friends", { auto: false });
  assert.equal(a.status, "friends");
  const same = st.stepStatus({ status: LIVE_STATUS }, "seeing each other", { auto: true });
  assert.equal(same.changed, false, "a target equal to the effective rung is unchanged");
});

t("stepStatus: friends to cooling off keeps status_before friends; back to friends clears it", () => {
  const a = st.stepStatus({ status: "friends" }, "cooling off", { auto: true });
  assert.equal(a.status, "cooling off");
  assert.equal(a.statusBefore, "friends");
  const b = st.stepStatus({ status: "cooling off", status_before: "friends" }, "friends", { auto: true });
  assert.equal(b.changed, true);
  assert.equal(b.status, "friends");
  assert.equal(b.statusBefore, null);
  const again = st.stepStatus({ status: "cooling off", status_before: "friends" }, "cooling off", { auto: true });
  assert.equal(again.changed, false, "the current state is unchanged");
});

t("stepStatus: strangers cannot cool off", () => {
  const a = st.stepStatus({ status: "strangers" }, "cooling off", { auto: false });
  assert.equal(a.changed, false);
  assert.match(a.note ?? "", /strangers cannot cool off/);
});

t("stepStatus: over refused on auto and below rung 3, allowed by hand from seeing each other", () => {
  const auto = st.stepStatus({ status: "seeing each other" }, "over", { auto: true });
  assert.equal(auto.changed, false);
  assert.match(auto.note ?? "", /never ends it/);
  const low = st.stepStatus({ status: "friends" }, "over", { auto: false });
  assert.equal(low.changed, false);
  assert.match(low.note ?? "", /over only after seeing each other/);
  const hand = st.stepStatus({ status: "seeing each other" }, "over", { auto: false });
  assert.equal(hand.status, "over");
  assert.equal(hand.statusBefore, "seeing each other");
});

t("stepStatus: from over only talking or friends, never by auto", () => {
  const auto = st.stepStatus({ status: "over", status_before: "seeing each other" }, "friends", { auto: true });
  assert.equal(auto.changed, false);
  assert.match(auto.note ?? "", /never restarts it/);
  const toTogether = st.stepStatus({ status: "over", status_before: "seeing each other" }, "together", { auto: false });
  assert.equal(toTogether.status, "friends", "starting over lands at most on friends");
  const toStrangers = st.stepStatus({ status: "over" }, "strangers", { auto: false });
  assert.equal(toStrangers.status, "talking", "and at least on talking");
});

t("stepStatus: an unknown word leaves the status unchanged with the note; empty is unchanged", () => {
  const a = st.stepStatus({ status: "friends" }, "purple", { auto: false });
  assert.equal(a.changed, false);
  assert.match(a.note ?? "", /status not understood: purple/);
  assert.equal(st.stepStatus({ status: "friends" }, "   ", { auto: false }).changed, false);
});

// ------------------------------------------------------------------ nicknames

t("mergeNicknames: appended, deduplicated case-insensitively, 'none established' replaced, the newest six kept", () => {
  assert.equal(st.mergeNicknames("Starbrite", "trouble"), "Starbrite; trouble");
  assert.equal(st.mergeNicknames("Starbrite; trouble", "starbrite"), "Starbrite; trouble", "a repeat is not added");
  assert.equal(st.mergeNicknames("none established", "Starbrite"), "Starbrite");
  assert.equal(st.mergeNicknames("a; b; c; d; e; f", "g"), "b; c; d; e; f; g", "seven keeps the newest six");
  assert.equal(st.mergeNicknames("none", ""), "none established");
});

// ------------------------------------------------------------------ friction

t("frictionNow: fresh, healing, faint, healed on story time; held days do not heal it", () => {
  const setAt = TUE_2100_NY;
  const rel = relationshipState({ friction: "the photo thing", friction_set_at: setAt, friction_days: 2 });
  const at = (ms) => new Date(Date.parse(setAt) + ms);
  const noClock = (ms) => st.frictionNow(rel, at(ms), {}, null, null).phase;
  assert.equal(noClock(12 * HOUR_MS), "fresh");
  assert.equal(noClock(1.5 * DAY_MS), "healing");
  assert.equal(noClock(3 * DAY_MS), "faint");
  assert.equal(noClock(5 * DAY_MS), "healed");
  // A 3-day held span right after the friction was set: 3.25 real days later is 6 story hours.
  const real = plusMs(setAt, 3.25 * DAY_MS);
  const held = storyClock({ real, spans: [clockSpan({ frozen_at: plusMs(setAt, HOUR_MS), resumed_at: plusMs(setAt, 3 * DAY_MS + HOUR_MS) })] });
  assert.equal(st.frictionNow(rel, new Date(real), {}, null, held).phase, "fresh");
  assert.equal(st.frictionNow(rel, new Date(real), {}, null, null).phase, "faint");
});

t("frictionNow: none or healed words read phase none; days default from settings, clamped", () => {
  assert.equal(st.frictionNow(relationshipState({ friction: "none" }), NOW, {}, null, null).phase, "none");
  assert.equal(st.frictionNow(relationshipState({ friction: "healed" }), NOW, {}, null, null).phase, "none");
  const f = st.frictionNow(relationshipState({ friction: "x", friction_set_at: NOW.toISOString() }), NOW, { frictionDaysDefault: 6 }, null, null);
  assert.equal(f.days, 6);
  assert.equal(st.frictionNow(relationshipState({ friction: "x" }), NOW, {}, null, null).days, 4, "the default is 4");
});

t("frictionLine renders by phase", () => {
  const f = (phase) => st.frictionLine({ friction: "the photo thing", phase, setAt: null, days: 4, ageDays: 0 });
  assert.equal(f("fresh"), "Friction: the photo thing (fresh; it colours things between you, it is not a way to treat him)");
  assert.equal(f("healing"), "Friction: the photo thing (healing)");
  assert.equal(f("faint"), "Friction: the photo thing (mostly past)");
  assert.equal(f("healed"), "");
  assert.equal(f("none"), "");
  assert.equal(st.frictionLine(null), "");
});

// ------------------------------------------------------------------ cooling off

t("relationshipMood: cooling_off_hours sets the story-time pair (capped at 336); 0 clears it", () => {
  const on = st.relationshipMood({ cooling_off_hours: 500, mood: "hurt" }, NOW);
  assert.equal(on.cooling_off_set_at, NOW.toISOString());
  assert.equal(on.cooling_off_hours, 336);
  assert.equal(on.mood, "hurt");
  const off = st.relationshipMood({ cooling_off_hours: 0 }, NOW);
  assert.equal(off.cooling_off_set_at, null);
  assert.equal(off.cooling_off_hours, null);
});

t("coolingOffNow: true inside the hours, false after; held days excluded; the v2 until path when the pair is absent", () => {
  const setAt = TUE_2100_NY;
  const rel = relationshipState({ status: "cooling off", cooling_off_set_at: setAt, cooling_off_hours: 24 });
  assert.equal(st.coolingOffNow(rel, new Date(plusMs(setAt, 10 * HOUR_MS)), null), true);
  assert.equal(st.coolingOffNow(rel, new Date(plusMs(setAt, 30 * HOUR_MS)), null), false);
  const real = plusMs(setAt, 30 * HOUR_MS);
  const held = storyClock({ real, spans: [clockSpan({ frozen_at: plusMs(setAt, 2 * HOUR_MS), resumed_at: plusMs(setAt, 22 * HOUR_MS) })] });
  assert.equal(st.coolingOffNow(rel, new Date(real), held), true, "10 story hours, 20 of the 30 were held");
  const v2 = relationshipState({ cooling_off_until: plusMs(NOW.toISOString(), HOUR_MS) });
  assert.equal(st.coolingOffNow(v2, NOW, null), true);
  assert.equal(st.coolingOffNow(relationshipState({ cooling_off_until: plusMs(NOW.toISOString(), -HOUR_MS) }), NOW, null), false);
});

// ------------------------------------------------------------------ moveRelationship

t("moveRelationship: his_name taken and null clears; trust, affection, attraction taken, empty ignored, 200 characters", () => {
  const cur = relationshipState({ his_name: "Justin", trust: "starting" });
  const a = st.moveRelationship(cur, { his_name: "J", trust: "", affection: "warm", attraction: "x".repeat(300) }, "they talked", NOW, { auto: true }).next;
  assert.equal(a.his_name, "J");
  assert.equal(a.trust, "starting", "the empty string is ignored");
  assert.equal(a.affection, "warm");
  assert.equal(String(a.attraction).length, 200);
  assert.equal(st.moveRelationship(cur, { his_name: null }, "x", NOW, { auto: true }).next.his_name, null);
});

t("moveRelationship: friction taken and stamped; the same friction keeps its stamp; 'none' clears the stamp; friction_days clamped", () => {
  const a = st.moveRelationship(relationshipState(), { friction: "the photo thing", friction_days: 30 }, "x", NOW, { auto: true }).next;
  assert.equal(a.friction, "the photo thing");
  assert.equal(a.friction_set_at, NOW.toISOString());
  assert.equal(a.friction_days, 14);
  const later = new Date(NOW.getTime() + DAY_MS);
  const b = st.moveRelationship(a, { friction: "The Photo Thing" }, "y", later, { auto: true }).next;
  assert.equal(b.friction_set_at, NOW.toISOString(), "the same friction keeps its stamp");
  const c = st.moveRelationship(a, { friction: "none" }, "z", later, { auto: true }).next;
  assert.equal(c.friction, "none");
  assert.ok(!("friction_set_at" in c));
  assert.ok(!("friction_days" in c));
  const lo = st.moveRelationship(relationshipState(), { friction: "x", friction_days: 0 }, "x", NOW, { auto: true }).next;
  assert.equal(lo.friction_days, 1);
});

t("moveRelationship: the mood keys still stamp; nicknames appended; the status through the ladder with a note", () => {
  const r = st.moveRelationship(relationshipState({ nicknames: "Starbrite" }), { status: "seeing each other", nicknames: "trouble", mood: "warm", mood_days: 3 }, "they kissed", NOW, { auto: true });
  assert.equal(r.next.status, "talking");
  assert.equal(r.next.nicknames, "Starbrite; trouble");
  assert.equal(r.next.mood, "warm");
  assert.equal(r.next.mood_days, 3);
  assert.equal(r.next.summary, "they kissed");
  assert.match(r.next.frontier, /before the first conversation \| they kissed/);
  assert.ok(r.notes.some((n) => /moved one step/.test(n)));
});

t("moveRelationship: moving into cooling off with none running starts 24 hours", () => {
  const r = st.moveRelationship(relationshipState({ status: "friends" }), { status: "cooling off" }, "a fight", NOW, { auto: true }).next;
  assert.equal(r.status, "cooling off");
  assert.equal(r.status_before, "friends");
  assert.equal(r.cooling_off_set_at, NOW.toISOString());
  assert.equal(r.cooling_off_hours, 24);
  const withHours = st.moveRelationship(relationshipState({ status: "friends" }), { status: "cooling off", cooling_off_hours: 6 }, "a fight", NOW, { auto: true }).next;
  assert.equal(withHours.cooling_off_hours, 6);
});

// ------------------------------------------------------------------ displayStatus

t("displayStatus: cooling off inside its hours reads 'cooling off'; after them status_before; with none 'talking'; held days do not run it out", () => {
  const setAt = TUE_2100_NY;
  const rel = relationshipState({ status: "cooling off", status_before: "friends", cooling_off_set_at: setAt, cooling_off_hours: 24 });
  assert.equal(st.displayStatus(rel, new Date(plusMs(setAt, 2 * HOUR_MS)), null), "cooling off");
  assert.equal(st.displayStatus(rel, new Date(plusMs(setAt, 30 * HOUR_MS)), null), "friends");
  assert.equal(st.displayStatus({ ...rel, status_before: null }, new Date(plusMs(setAt, 30 * HOUR_MS)), null), "talking");
  const real = plusMs(setAt, 3 * DAY_MS);
  const held = storyClock({ real, spans: [clockSpan({ frozen_at: plusMs(setAt, HOUR_MS), resumed_at: plusMs(setAt, 3 * DAY_MS - HOUR_MS) })] });
  assert.equal(st.displayStatus(rel, new Date(real), held), "cooling off");
  assert.equal(st.displayStatus(relationshipState({ status: LIVE_STATUS }), NOW, null), LIVE_STATUS, "any other status as stored");
});

t("RELATIONSHIP_V5_HIDDEN_KEYS: the six keys", () => {
  assert.deepEqual([...st.RELATIONSHIP_V5_HIDDEN_KEYS].sort(), ["cooling_off_hours", "cooling_off_set_at", "friction", "friction_days", "friction_set_at", "status_before"]);
});

// ------------------------------------------------------------------ the scene record

t("normalizeSceneFields fills every key", () => {
  const n = st.normalizeSceneFields({ status: "Apart" }, null, { strict: false });
  for (const k of ["status", "location", "time", "present", "summary", "last_beat"]) assert.ok(k in n, k);
  assert.equal(n.status, "apart");
  assert.equal(n.location, null);
  assert.equal(n.time, null);
  assert.deepEqual(n.present, []);
});

t("normalizeSceneFields: together with no place keeps the current place, refuses on strict, keeps the status on a proposal", () => {
  const cur = { status: "together", location: "the pier", time: "dusk", present: ["Avelie", "him"] };
  const kept = st.normalizeSceneFields({ status: "together" }, cur, { strict: true });
  assert.equal(kept.location, "the pier");
  const apart = { status: "apart", location: null, time: null, present: [] };
  assert.throws(() => st.normalizeSceneFields({ status: "together" }, apart, { strict: true }), (e) => e.status === 400 && /a together scene needs a place/.test(e.message));
  const prop = st.normalizeSceneFields({ status: "together" }, apart, { strict: false });
  assert.equal(prop.status, "apart", "a proposal never moves the scene into together without a place");
});

t("normalizeSceneFields: an unknown status reads the current one", () => {
  const n = st.normalizeSceneFields({ status: "dancing" }, { status: "apart" }, { strict: false });
  assert.equal(n.status, "apart");
});

t("normalizeSceneFields: the chat's toggle sending the old time back comes out with time null; a new time is kept; a proposal with no time drops the old one", () => {
  const cur = { status: "apart", location: null, time: "late, past midnight", present: [] };
  const toggled = st.normalizeSceneFields({ ...cur, status: "together", location: "the harbour bench" }, cur, { strict: true });
  assert.equal(toggled.status, "together");
  assert.equal(toggled.time, null);
  const withNew = st.normalizeSceneFields({ ...cur, status: "together", location: "the harbour bench", time: "morning" }, cur, { strict: true });
  assert.equal(withNew.time, "morning");
  const prop = st.normalizeSceneFields({ ...cur, status: "together", location: "the pier" }, cur, { strict: false, timeSet: false });
  assert.equal(prop.time, null);
  const same = st.normalizeSceneFields({ status: "apart", time: "late, past midnight" }, cur, { strict: false, timeSet: false });
  assert.equal(same.time, "late, past midnight", "the status unchanged keeps the time");
});
