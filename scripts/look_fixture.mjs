#!/usr/bin/env node
// The look fixture (DESIGN_EXPERIENCE 8.10): fills a LOCAL server with a small, realistic
// record in her shape, so every Her and Studio page can be looked at with data before the
// live look. A dev tool only: never run by npm test, never pointed at the live app.
//
//   node scripts/look_fixture.mjs --base http://127.0.0.1:8787
//
// It refuses any base whose host is not 127.0.0.1 or localhost (exit 2, nothing sent). It
// talks only through the documented routes (API.md) and expects the stub performer and the
// stub image provider (`npm run dev` on a fresh local state). It never rejects a picture: the
// stub answers the same bytes for every picture, and a rejection would blacklist them all.
// One line per thing made; exit 0 when everything was made, 1 on the first failure.

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);

function baseFromArgs(argv) {
  const i = argv.indexOf("--base");
  const raw = i >= 0 ? argv[i + 1] : argv.find((a) => a.startsWith("--base="))?.slice("--base=".length);
  return raw || "http://127.0.0.1:8787";
}

const rawBase = baseFromArgs(process.argv.slice(2));
let BASE;
try {
  const u = new URL(rawBase);
  if (!LOCAL_HOSTS.has(u.hostname) || (u.protocol !== "http:" && u.protocol !== "https:")) throw new Error("not local");
  BASE = u.origin;
} catch {
  console.error("look_fixture: refusing " + JSON.stringify(rawBase) + ": the base must be http://127.0.0.1:<port> or http://localhost:<port>");
  process.exit(2);
}

const stamp = Date.now().toString(36);
let counter = 0;
const key = (label) => `look-${stamp}-${label}-${counter++}`;

async function api(method, path, body) {
  const init = { method, headers: { origin: BASE, "sec-fetch-site": "same-origin" } };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text };
}

async function must(method, path, body, ok = [200, 201]) {
  const r = await api(method, path, body);
  if (!ok.includes(r.status)) throw new Error(`${method} ${path} -> ${r.status} ${r.text.slice(0, 200)}`);
  return r.json;
}

const made = (what) => console.log("made: " + what);

async function scene(patch, note) {
  const s = (await must("GET", "/api/state")).scene.state;
  return must("PUT", "/api/state/scene", { state: { ...s, ...patch }, note });
}

async function turn(conversationId, content) {
  const r = await must("POST", `/api/conversations/${conversationId}/turn`, { content, idempotencyKey: key("turn") });
  if (!r.assistantMessage) throw new Error("turn answered no reply of hers: " + JSON.stringify(r).slice(0, 200));
  return r;
}

// Her photo in the thread: the turn records the request, then one POST makes the picture.
async function photoTurn(conversationId, content) {
  const t = await turn(conversationId, content);
  const messageId = t.assistantMessage.id;
  const gen = await must("POST", "/api/images/generate", { conversationId, messageId });
  return { messageId, asset: gen.asset };
}

async function placeByTitle(title) {
  const list = (await must("GET", "/api/places")).places ?? [];
  const norm = title.toLowerCase().replace(/\s+/g, " ").trim();
  return list.find((p) => p.title_norm === norm || String(p.title).toLowerCase().trim() === norm) ?? null;
}

async function ensurePlace(title) {
  const found = await placeByTitle(title);
  if (found) return found;
  return must("POST", "/api/places", { title });
}

function dayIn(tz, offsetDays) {
  const d = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

async function main() {
  const me = await api("GET", "/api/me");
  if (me.status !== 200) throw new Error("GET /api/me -> " + me.status + " (is `npm run dev` running with ACCESS_AUD empty?)");
  const settings = await must("GET", "/api/settings");
  if (settings.provider !== "stub") console.log("note: the performer is " + settings.provider + ", not the stub; every turn is a real call");
  const tz = typeof settings.timezone === "string" && settings.timezone ? settings.timezone : "America/New_York";

  // The bench, and the first chapter (no title: it is named by the place).
  await scene({ status: "together", location: "the bench by the water" }, "look fixture: the bench");
  made("a together scene at the bench by the water");
  const first = await must("POST", "/api/conversations", {});
  made("a conversation " + first.id);
  await turn(first.id, "hi. is this seat taken");
  const kept1 = await turn(first.id, "i like the way you watch the boats");
  const photo = await photoTurn(first.id, "[[PHOTO]] show me what you see from here");
  await must("POST", `/api/images/${photo.asset.id}/decide`, { decision: "approve" });
  made("her picture in the thread, approved (" + photo.asset.id + ")");
  const song = await turn(first.id, "[[SONG]] send me something");
  made("a song she sent (" + song.assistantMessage.id + ")");
  const acted = await turn(first.id, "[[ACTED2]] so what do you do");
  await turn(first.id, "i should walk you home");
  made("six turns, one with an *action* line");
  await must("POST", `/api/messages/${acted.assistantMessage.id}/mark`, { mark: "keep" });
  await must("POST", `/api/messages/${kept1.assistantMessage.id}/mark`, { mark: "keep" });
  made("two of her lines kept");

  // The roof: set and replaced before anyone says a word. It must name nothing.
  await scene({ status: "together", location: "the shoot on the roof" }, "look fixture: a photo setup, replaced at once");
  made("a together scene at the shoot on the roof (never talked in)");
  await scene({ status: "together", location: "the record store on Congress Street" }, "look fixture: the record store");
  made("a together scene at the record store on Congress Street");
  await turn(first.id, "*flips through the used bin* you have to hear this one");
  await turn(first.id, "ok that one is actually good");
  made("two turns at the record store");

  // Apart, and a second chapter named by its day.
  await scene({ status: "apart", location: null }, "look fixture: apart");
  made("an apart scene");
  const second = await must("POST", "/api/conversations", {});
  made("a second conversation " + second.id);
  await turn(second.id, "did you get home ok");
  await turn(second.id, "see ya tomorrow starbrite");
  const undecided = await photoTurn(second.id, "[[PHOTO]] what are you wearing right now");
  made("an undecided candidate in the thread (" + undecided.asset.id + ")");

  // A picture fired by the owner: in the roll, never in the album, no story on the timeline.
  const owner = await must("POST", "/api/images/generate", { conversationId: second.id, description: "her window display at the shop, late light, from the sidewalk" });
  await must("POST", `/api/images/${owner.asset.id}/decide`, { decision: "approve" });
  made("an owner-fired picture, approved (" + owner.asset.id + ")");

  // Places: two pinned, the bench left without a pin (Studio > Pictures > Places lists it).
  const exchange = await ensurePlace("Exchange Street");
  await must("PUT", `/api/places/${exchange.id}`, { lat: 43.6577, lon: -70.2549, geocodedBy: "owner" });
  made("Exchange Street pinned at 43.6577, -70.2549");
  const ferry = await ensurePlace("the ferry");
  await must("PUT", `/api/places/${ferry.id}`, { lat: 43.6562, lon: -70.2482, geocodedBy: "owner" });
  made("the ferry pinned at 43.6562, -70.2482");
  const bench = await ensurePlace("the bench by the water");
  made("the bench by the water, left unpinned (" + bench.id + ")");

  // Two moments.
  await must("POST", "/api/history", { title: "they met on the bench by the water", occurred: dayIn(tz, -2), body: "He sat down at the other end of her bench and they talked until the ferry came in." });
  await must("POST", "/api/history", { title: "the record store on Congress Street", occurred: dayIn(tz, -1), body: "She played him the record she always plays for people she likes." });
  made("two history rows");

  // A want with a step due tomorrow, through the beat route (the beat and its pending run).
  const want = await must("POST", "/api/wants", { title: "sing at an open mic", why: "she has never sung for a room", next_step: "sign up at the bar" });
  const beat = await must("POST", `/api/wants/${want.id}/beats`, { title: "sign up at the bar", kind: "step", dueOn: dayIn(tz, 1), dueTime: "19:00" });
  made("a want (" + want.id + ") with a step due tomorrow (" + beat.beat.id + ")");

  // Where they stand.
  const rel = (await must("GET", "/api/state")).relationship.state;
  await must("PUT", "/api/state/relationship", {
    state: { ...rel, status: "seeing each other, early", his_name: "Justin", nicknames: "Starbrite" },
    note: "look fixture: where they stand",
  });
  made("a relationship: seeing each other, early; his name Justin; the nickname Starbrite");
  console.log("look_fixture: done on " + BASE);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("look_fixture: " + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
