// Delayed replies and their one notification (SPEC_V4 section 6): dueReplies on a fixed
// table (inside the window, before it, not yet due, already pushed, the two-minute floor)
// and pushDueReplies on the D1 stand-in with a VAPID-less env (one push attempt for three
// due rows, every row stamped, a free-branch row stamped with no push, nothing when
// nothing is due). Also the two push reasons: nothing else ever pushes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadSrc } from "./helpers.mjs";
import { fakeDb, secretEnv } from "./helpers_v2.mjs";
import { loadSrcIfPresent, guard } from "./helpers_v4.mjs";

const deliveries = await loadSrcIfPresent("deliveries");
const push = await loadSrc("push");
const t = guard(deliveries, "dueReplies", "pushDueReplies", "DUE_WINDOW_MS", "DELAY_PUSH_MIN_MS");

const NOW = new Date("2026-09-29T19:10:00Z");
const at = (minutesFromNow) => new Date(NOW.getTime() + minutesFromNow * 60_000).toISOString();
const row = (id, deliverMin, heldMs, pushed = null) => ({ id, created_at: new Date(NOW.getTime() + deliverMin * 60_000 - heldMs).toISOString(), deliver_at: at(deliverMin), pushed_at: pushed });

t("the constants: a 25-minute window for a 20-minute cron, a two-minute floor, the reason her_delayed_reply", () => {
  assert.equal(deliveries.DUE_WINDOW_MS, 25 * 60 * 1000);
  assert.equal(deliveries.DELAY_PUSH_MIN_MS, 120000);
  assert.equal(deliveries.PUSH_REASON_DELAYED, "her_delayed_reply");
  assert.deepEqual([...push.PUSH_REASONS], ["her_first_text", "her_delayed_reply"]);
  assert.equal(push.isPushReason("miss_you"), false);
});

t("dueReplies: due inside the window and held two minutes -> push; a free-branch reply (30 s) -> skip; exactly 120 s -> push; before the window, not yet due, already pushed, unreadable -> neither", () => {
  const rows = [
    row("m_due", -5, 6 * 60_000),
    row("m_free", -3, 30_000),
    row("m_floor", -1, 120_000),
    row("m_old", -30, 10 * 60_000),
    row("m_future", 5, 10 * 60_000),
    row("m_pushed", -4, 10 * 60_000, "2026-09-29T19:07:00.000Z"),
    { id: "m_bad", created_at: at(-9), deliver_at: "not a time", pushed_at: null },
    { id: "m_none", created_at: at(-9), deliver_at: null, pushed_at: null },
    { id: "", created_at: at(-9), deliver_at: at(-2), pushed_at: null },
    row("m_edge", 0, 5 * 60_000),
  ];
  const split = deliveries.dueReplies(rows, NOW);
  assert.deepEqual(split.push, ["m_due", "m_floor", "m_edge"]);
  assert.deepEqual(split.skip, ["m_free"]);
  const exactWindow = deliveries.dueReplies([row("m_at_floor", -25, 10 * 60_000)], NOW);
  assert.deepEqual(exactWindow, { push: [], skip: [] }, "exactly the window edge is before the window");
  assert.deepEqual(deliveries.dueReplies([], NOW), { push: [], skip: [] });
});

t("pushDueReplies on the stand-in: three due rows -> one push attempt (skipped: no VAPID keys) and every row stamped, a 30 s row stamped without a push, nothing when nothing is due", async () => {
  const env = { ...secretEnv(), VAPID_PUBLIC_KEY: "", VAPID_PRIVATE_KEY: "" };
  const db = fakeDb({ messages: [row("m1", -5, 6 * 60_000), row("m2", -4, 3 * 60_000), row("m3", -2, 2 * 60_000), row("m_free", -1, 40_000), row("m_future", 10, 5 * 60_000)], push_subscriptions: [] });
  const r = await deliveries.pushDueReplies(env, db, NOW);
  assert.equal(r.due, 3);
  assert.equal(r.pushed, true);
  assert.ok(r.result && r.result.reason === "her_delayed_reply" && r.result.skipped === "no VAPID keys", JSON.stringify(r.result));
  assert.equal(r.result.sent, 0);
  const stamps = db.writes.filter((w) => /UPDATE messages SET pushed_at = \?1 WHERE id IN/.test(w.sql));
  assert.equal(stamps.length, 1, "one statement under the 90 chunk");
  assert.equal(stamps[0].binds[0], NOW.toISOString());
  assert.deepEqual(stamps[0].binds.slice(1).sort(), ["m1", "m2", "m3", "m_free"], "push and skip stamped together; the future row untouched");
  const read = db.queries.find((q) => /deliver_at IS NOT NULL AND pushed_at IS NULL/.test(q.sql));
  assert.ok(read && read.binds[0] === NOW.toISOString() && read.binds[2] === 50, "the query binds now, the floor and the limit");

  const onlyFree = fakeDb({ messages: [row("m_free", -1, 30_000)], push_subscriptions: [] });
  const r2 = await deliveries.pushDueReplies(env, onlyFree, NOW);
  assert.deepEqual(r2, { due: 0, pushed: false, result: null }, "a free-branch reply never pushes");
  assert.equal(onlyFree.writes.filter((w) => /pushed_at/.test(w.sql)).length, 1, "but it is stamped so it never comes back");

  const nothing = fakeDb({ messages: [], push_subscriptions: [] });
  assert.deepEqual(await deliveries.pushDueReplies(env, nothing, NOW), { due: 0, pushed: false, result: null });
  assert.equal(nothing.writes.length, 0);
});

t("pushDueReplies stamps in chunks of 90 (the D1 bound-parameter limit)", async () => {
  const many = [];
  for (let i = 0; i < 100; i++) many.push(row("m" + i, -1 - (i % 20) * 0.5, 3 * 60_000));
  const db = fakeDb({ messages: many, push_subscriptions: [] });
  const r = await deliveries.pushDueReplies({ ...secretEnv(), VAPID_PUBLIC_KEY: "", VAPID_PRIVATE_KEY: "" }, db, NOW);
  assert.equal(r.due, 100);
  const stamps = db.writes.filter((w) => /UPDATE messages SET pushed_at/.test(w.sql));
  assert.equal(stamps.length, 2);
  for (const s of stamps) assert.ok(s.binds.length <= 91, String(s.binds.length));
  assert.equal(stamps.reduce((n, s) => n + s.binds.length - 1, 0), 100);
});

test("sendPush refuses any reason but the two; a courtesy that never throws", async () => {
  const db = fakeDb({ push_subscriptions: [] });
  const r = await push.sendPush(secretEnv(), db, "miss_you", NOW);
  assert.equal(r.skipped, "reason not allowed");
  assert.equal(r.sent, 0);
  const ok = await push.sendPush({ ...secretEnv(), VAPID_PUBLIC_KEY: "", VAPID_PRIVATE_KEY: "" }, db, "her_delayed_reply", NOW);
  assert.equal(ok.skipped, "no VAPID keys");
});

t("pushDueReplies with quiet (her quiet hours): nothing is sent, every due row is still stamped so it never buzzes later; the result says quiet", async () => {
  const env = { ...secretEnv(), VAPID_PUBLIC_KEY: "", VAPID_PRIVATE_KEY: "" };
  const db = fakeDb({ messages: [row("m1", -5, 6 * 60_000), row("m_free", -1, 40_000)], push_subscriptions: [] });
  const r = await deliveries.pushDueReplies(env, db, NOW, { quiet: true });
  assert.deepEqual(r, { due: 1, pushed: false, result: null, quiet: true });
  assert.ok(!db.queries.some((q) => /push_subscriptions/.test(q.sql)), "no push attempted");
  const stamps = db.writes.filter((w) => /UPDATE messages SET pushed_at = \?1 WHERE id IN/.test(w.sql));
  assert.deepEqual(stamps[0].binds.slice(1).sort(), ["m1", "m_free"]);
  const loud = await deliveries.pushDueReplies(env, fakeDb({ messages: [row("m1", -5, 6 * 60_000)], push_subscriptions: [] }), NOW, { quiet: false });
  assert.equal(loud.pushed, true);
  assert.ok(!("quiet" in loud));
});
