// Grounding (SPEC_V3 section DD): the time-of-day word, the WMO words, the weather line,
// what she is wearing, the RIGHT NOW section, the cache freshness, the geocode reader and
// the portrait prompt.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BAD_TYPOGRAPHY } from "./helpers.mjs";
import { TZ } from "./helpers_v2.mjs";
import { loadSrcIfPresent, guard, firstExport, groundingRow, weatherNow, assetRow, NOW } from "./helpers_v3.mjs";

const grounding = await loadSrcIfPresent("grounding");
const weather = await loadSrcIfPresent("weather");
const portraits = await loadSrcIfPresent("portraits");
const t = guard(grounding, "timeOfDay", "weatherLine", "outfitNow", "groundingSection");

t("timeOfDay: the seven buckets", () => {
  const { timeOfDay } = grounding;
  assert.equal(timeOfDay(5), "early morning");
  assert.equal(timeOfDay(7), "early morning");
  assert.equal(timeOfDay(8), "morning");
  assert.equal(timeOfDay(11), "midday");
  assert.equal(timeOfDay(14), "afternoon");
  assert.equal(timeOfDay(17), "evening");
  assert.equal(timeOfDay(21), "night");
  assert.equal(timeOfDay(23), "night");
  assert.equal(timeOfDay(0), "late night");
  assert.equal(timeOfDay(4), "late night");
});

test("WMO codes map to plain words", (tc) => {
  const w = firstExport(weather, ["wmoWords", "weatherWords", "codeWords", "wmoWord", "describeCode", "wordsForCode"]);
  const g = firstExport(grounding, ["wmoWords", "weatherWords", "codeWords", "wmoWord", "describeCode", "wordsForCode"]);
  const fn = w.fn ?? g.fn;
  if (!fn) {
    tc.skip("no WMO word function found in weather.ts or grounding.ts (tried wmoWords, weatherWords, codeWords, wmoWord, describeCode, wordsForCode)");
    return;
  }
  assert.equal(fn(0), "clear");
  assert.equal(fn(1), "mostly clear");
  assert.equal(fn(2), "mostly clear");
  assert.equal(fn(3), "overcast");
  assert.equal(fn(45), "fog");
  assert.equal(fn(48), "fog");
  assert.equal(fn(53), "drizzle");
  assert.equal(fn(63), "rain");
  assert.equal(fn(75), "snow");
  assert.equal(fn(81), "showers");
  assert.equal(fn(86), "snow showers");
  assert.equal(fn(96), "a storm");
});

t("weatherLine: the wording, the units, and null when there is no weather", () => {
  const { weatherLine } = grounding;
  const f = weatherLine(weatherNow(), "Portland, Maine", NOW, TZ);
  assert.ok(/Portland, Maine: 71F, clear, feels like 73/.test(f), f);
  assert.ok(/sun sets at 7:02pm/.test(f), f);
  const c = weatherLine(weatherNow({ temp: 22, feels: 23, units: "celsius" }), "Lisbon", NOW, TZ);
  assert.ok(/22C, clear, feels like 23/.test(c), c);
  const none = weatherLine(null, "Portland, Maine", NOW, TZ);
  assert.ok(none === "" || none === null, "no line without weather");
  assert.ok(!BAD_TYPOGRAPHY.test(f));
});

t("outfitNow: today's newest of an approved photo and an outfit log row; yesterday is never asserted", () => {
  const { outfitNow } = grounding;
  const photo = assetRow({ decided_at: "2026-09-29T19:10:00Z", prompt: "mirror selfie in a black hoodie" });
  const older = assetRow({ id: "img_old", decided_at: "2026-09-28T19:10:00Z", prompt: "sundress on the porch" });
  const log = groundingRow({ kind: "outfit", note: "the grey sweater", occurred: "2026-09-29T14:00:00Z" });
  const fromPhoto = outfitNow([photo, older], [log], NOW, TZ);
  assert.ok(fromPhoto, "something today");
  assert.ok(/black hoodie/.test(JSON.stringify(fromPhoto)), JSON.stringify(fromPhoto));
  assert.ok(/photo/.test(JSON.stringify(fromPhoto)), "from: photo");
  const laterLog = groundingRow({ kind: "outfit", note: "the grey sweater", occurred: "2026-09-29T19:11:00Z" });
  const fromLog = outfitNow([photo], [laterLog], NOW, TZ);
  assert.ok(/grey sweater/.test(JSON.stringify(fromLog)), "the newer outfit row wins");
  const nothing = outfitNow([older], [groundingRow({ kind: "outfit", note: "yesterday", occurred: "2026-09-28T19:00:00Z" })], NOW, TZ);
  assert.ok(nothing === null || nothing === undefined, "nothing from yesterday");
  const notOutfit = outfitNow([], [groundingRow({ kind: "meal", note: "a bagel" })], NOW, TZ);
  assert.ok(notOutfit === null || notOutfit === undefined, "a meal is not an outfit");
});

t("groundingSection: full and empty", () => {
  const { groundingSection, outfitNow } = grounding;
  const outfit = outfitNow([assetRow({ decided_at: "2026-09-29T19:10:00Z", prompt: "mirror selfie in a black hoodie" })], [], NOW, TZ);
  const today = [groundingRow({ kind: "meal", note: "a bagel", occurred: "2026-09-29T13:00:00Z" }), groundingRow({ id: "g2", kind: "errand", note: "the post office", occurred: "2026-09-29T15:00:00Z" })];
  const s = groundingSection({ now: NOW, tz: TZ, city: "Portland, Maine", weather: weatherNow(), outfit, today });
  assert.ok(s.startsWith("RIGHT NOW"), s.slice(0, 40));
  assert.ok(/without announcing it/.test(s));
  assert.ok(/It is Tuesday 3:10pm, afternoon\./.test(s), s);
  assert.ok(/Portland, Maine: 71F, clear/.test(s));
  assert.ok(/You are wearing: .*black hoodie/.test(s));
  assert.ok(/Today so far: meal: a bagel \(9(:00)?am\); errand: the post office \(11(:00)?am\)/.test(s), s);
  assert.ok(!BAD_TYPOGRAPHY.test(s));
  assert.ok(!/open-meteo|api|weather service/i.test(s), "sealed: nothing about where the weather comes from");
  const empty = groundingSection({ now: NOW, tz: TZ, city: "", weather: null, outfit: null, today: [] });
  assert.ok(empty === "" || /^RIGHT NOW[\s\S]*It is Tuesday 3:10pm, afternoon\.\s*$/.test(empty), "no data beyond the clock: " + JSON.stringify(empty));
  const noWeather = groundingSection({ now: NOW, tz: TZ, city: "Portland, Maine", weather: null, outfit: null, today: [] });
  assert.ok(!/Portland/.test(noWeather) || !/F,/.test(noWeather), "no made-up weather");
});

test("weather cache freshness: 20 minutes", (tc) => {
  const f = firstExport(weather, ["isFresh", "cacheFresh", "fresh"]);
  if (!f.fn) {
    tc.skip("weather.ts exports no isFresh (tried isFresh, cacheFresh, fresh)");
    return;
  }
  assert.equal(f.fn(new Date(NOW.getTime() - 19 * 60000).toISOString(), NOW), true);
  assert.equal(f.fn(new Date(NOW.getTime() - 21 * 60000).toISOString(), NOW), false);
  assert.equal(f.fn("not a time", NOW), false);
});

test("the geocode reader answers [] for a response with no results", (tc) => {
  const f = firstExport(weather, ["parseGeocode", "readGeocode", "geocodeResults", "parseGeocodeResponse", "readGeocodeResponse"]);
  if (!f.fn) {
    tc.skip("weather.ts exports no geocode reader (tried parseGeocode, readGeocode, geocodeResults, parseGeocodeResponse, readGeocodeResponse)");
    return;
  }
  assert.deepEqual(f.fn({}), []);
  assert.deepEqual(f.fn(null), []);
  const r = f.fn({ results: [{ name: "Portland", latitude: 43.66, longitude: -70.26, timezone: "America/New_York", country: "United States", admin1: "Maine" }] });
  assert.equal(r.length, 1);
  assert.equal(r[0].name, "Portland");
  assert.equal(r[0].timezone, "America/New_York");
});

test("the portrait prompt carries no master references and names the relation", (tc) => {
  const f = firstExport(portraits, ["portraitPrompt", "buildPortraitPrompt", "promptFor", "portraitPromptFor"]);
  if (!f.fn) {
    tc.skip("portraits.ts exports no prompt builder (tried portraitPrompt, buildPortraitPrompt, promptFor, portraitPromptFor)");
    return;
  }
  const p = f.fn("a tall guy with a beard and a denim jacket", "brother");
  assert.ok(/A candid phone photo of one person: a tall guy with a beard and a denim jacket\./.test(p), p);
  assert.ok(/not a celebrity/.test(p));
  assert.ok(/They are her brother\./.test(p));
  assert.ok(!/reference images|same young woman|freckles/i.test(p), "no identity block: it is not her");
  const noRel = f.fn("a woman with silver hair", null);
  assert.ok(!/They are her/.test(noRel));
});
