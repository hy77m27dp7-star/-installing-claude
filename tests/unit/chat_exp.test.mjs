// The experience pass, chat lane (DESIGN_EXPERIENCE 3.4 to 3.6, 10.2): public/js/chat.js read
// as text (it touches the DOM at import), with its pure pieces extracted and evaluated the
// review_v5 way: the chapter names and rename, the wallpaper, the phone drawer gone, the
// workings only behind their switch, the reaction bar with its heart, the lightbox's three
// decisions, failures in words, the tap-to-record bar, the chapter head surviving a reload of
// the thread, and the v4 and v5 lines other suites pin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const js = readFileSync(new URL("../../public/js/chat.js", import.meta.url), "utf8");

// The source of `function name(...) { ... }`, braces matched, strings and comments skipped.
function fnSrc(name) {
  const start = js.indexOf("function " + name + "(");
  assert.ok(start >= 0, "function " + name + " exists");
  let i = js.indexOf("{", start);
  let depth = 0;
  for (; i < js.length; i++) {
    const c = js[i];
    if (c === "/" && js[i + 1] === "/") { i = js.indexOf("\n", i); continue; }
    if (c === "/" && js[i + 1] === "*") { i = js.indexOf("*/", i) + 1; continue; }
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < js.length && js[i] !== c; i++) if (js[i] === "\\") i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return js.slice(start, i + 1);
  }
  throw new Error("unbalanced " + name);
}

// A tiny stand-in for api.js's h(): plain objects that remember what was built.
function fakeH(tag, props, ...children) {
  const el = { tag, props: props || {}, children: [], append(...xs) { for (const x of xs.flat()) if (x) this.children.push(x); } };
  el.append(...children);
  return el;
}
const texts = (el) => [el.props && el.props.text, ...(el.children || []).flatMap((c) => (typeof c === "object" ? texts(c) : [c]))].filter(Boolean);

test("chapters: the list answers displayTitle; a rename PUTs /api/conversations/:id with { title }, empty sends null", () => {
  assert.ok(js.includes("displayTitle"));
  assert.match(js, /api\("PUT", "\/api\/conversations\/" \+ encodeURIComponent\(id\), \{ title: raw \|\| null \}\)/);
  const label = fnSrc("convLabel");
  assert.ok(!/"chat "/.test(label), "no \"chat \" + a date");
  const convLabel = new Function("dayTitle", label + "\nreturn convLabel;")(() => "Thursday night");
  assert.equal(convLabel({ displayTitle: "The record store", title: null }), "The record store");
  assert.equal(convLabel({ title: "Our bench" }), "Our bench");
  assert.equal(convLabel({ title: null, created_at: "2026-09-24T01:00:00Z" }), "Thursday night");
  assert.equal(convLabel(null), "Thursday night");
});

test("chapters: rows are li.chapter-row > button.chapter-open with title, when and preview; his preview starts \"You: \"", () => {
  const src = fnSrc("renderConversations");
  for (const cls of ["chapter-row", "chapter-open", "chapter-title", "chapter-when", "chapter-preview"]) assert.ok(src.includes(cls), cls);
  const previewLine = new Function(fnSrc("previewLine") + "\nreturn previewLine;")();
  assert.equal(previewLine({ preview: { role: "user", text: "see you at 3:30" } }), "You: see you at 3:30");
  assert.equal(previewLine({ preview: { role: "assistant", text: "that was sweet by the way" } }), "that was sweet by the way");
  assert.equal(previewLine({ preview: null }), "");
});

test("chapter head: the title's label says rename, a turn in an automatic chapter re-reads the list once", () => {
  assert.match(fnSrc("updateTitle"), /setAttribute\("aria-label", title \+ ", rename"\)/);
  const refresh = fnSrc("refreshTitlesAfterTurn");
  assert.match(refresh, /titleFrom === "his"/);
  assert.match(refresh, /api\("GET", "\/api\/conversations"\)/);
  assert.ok((js.match(/refreshTitlesAfterTurn\(/g) || []).length >= 5, "called after send, open, voice and a tasting pick");
  assert.match(js, /els\.chapterEdit\.addEventListener\("blur"/);
  assert.match(js, /e\.key === "Escape"[\s\S]{0,80}cancelRename\(\)/);
});

test("chapterHead survives loadThread: the function re-appends it first and the dots last; an empty chapter shows her face", () => {
  const load = fnSrc("loadThread");
  assert.match(load, /els\.thread\.replaceChildren\(\.\.\.\(els\.chapterHead \? \[els\.chapterHead\] : \[\]\), els\.typing\)/);
  assert.match(load, /showEmptyHer\(\)/);
  const empty = fnSrc("showEmptyHer");
  assert.match(empty, /makeAvatar\(96\)/);
  assert.match(empty, /class: "empty-her"/);
  assert.match(empty, /classList\.add\("ring"\)/);
});

test("the place line: together at the place (a leading at or in dropped), together, texting, hidden when unknown", () => {
  const placeWords = new Function(fnSrc("placeWords") + "\nreturn placeWords;")();
  const placeLineText = new Function("placeWords", fnSrc("placeLineText") + "\nreturn placeLineText;")(placeWords);
  assert.equal(placeLineText({ status: "together", location: "at the record store" }), "together at the record store");
  assert.equal(placeLineText({ status: "together", location: "in  her kitchen" }), "together at her kitchen");
  assert.equal(placeLineText({ status: "together", location: "the bench by the water" }), "together at the bench by the water");
  assert.equal(placeLineText({ status: "together", location: null }), "together");
  assert.equal(placeLineText({ status: "apart" }), "texting");
  assert.equal(placeLineText(null), "");
  assert.match(fnSrc("renderScene"), /els\.placeLine\.classList\.toggle\("hidden", !text\)/);
});

test("the backdrop: the place picture or GET /api/wallpaper with its focus through the CSSOM; --place-url is no longer written", () => {
  assert.ok(js.includes('api("GET", "/api/wallpaper")'));
  assert.match(fnSrc("setBackdrop"), /img\.style\.objectPosition = pos/);
  assert.match(fnSrc("applyPlaceBackground"), /"\/media\/place\/" \+ encodeURIComponent\(placeId\)/);
  assert.match(js, /classList\.add\("ready"\)/);
  assert.ok(!js.includes("--place-url"));
  assert.ok(!/setAttribute\("style"/.test(js), "no style attribute is ever written");
});

test("the phone slide-in and the hold-to-record handling are gone", () => {
  for (const s of ["phoneBtn", "phoneDrawer", "phoneDrawerBody", "phoneClose", "openPhone", "PHONE_IDS", "TAP_MS", "Hold to record", "pointerup\", \"pointercancel\"]) els.micBtn"]) {
    assert.ok(!js.includes(s), s);
  }
});

test("metaRow: why, note, keep and the flags only under state.operator (built and counted)", () => {
  const build = (operator) => {
    const state = { operator, chipsFor: new Map() };
    const metaRow = new Function("h", "state", "fmtTime", "openWhy", "toggleNoteSheet", "markButton", "chip", "flagCodes",
      fnSrc("metaRow") + "\nreturn metaRow;")(fakeH, state, () => "9:04 PM", () => {}, () => {}, () => fakeH("button", { class: "mark", text: "keep" }), (t) => fakeH("span", { class: "chip", text: t }), () => ["written_joke"]);
    return metaRow({ id: "m1", role: "assistant", channel: "story", created_at: "2026-09-26T01:04:00Z", flags_json: "[]" });
  };
  const off = build(false);
  assert.equal(off.children.length, 1, "only the time");
  assert.deepEqual(texts(off), ["9:04 PM"]);
  const on = texts(build(true));
  for (const t of ["why", "note", "keep", "written_joke"]) assert.ok(on.includes(t), t);
});

test("the reaction bar: one .react-bar with the .react-keep heart (keep or its DELETE), note and why; dblclick, contextmenu, a 450 ms long press, Enter or Space", () => {
  const open = fnSrc("openReactBar");
  assert.match(open, /class: "react-btn react-keep", role: "menuitemcheckbox", "aria-checked"/);
  assert.match(open, /"aria-label": "Keep"/);
  assert.match(open, /class: "react-bar glass strong", role: "menu"/);
  assert.match(open, /text: "note"/);
  assert.match(open, /text: "why"/);
  const keep = fnSrc("toggleKeep");
  assert.match(keep, /api\("POST", "\/api\/messages\/" \+ encodeURIComponent\(m\.id\) \+ "\/mark", \{ mark: "keep" \}\)/);
  assert.match(keep, /api\("DELETE", "\/api\/messages\/" \+ encodeURIComponent\(m\.id\) \+ "\/mark"\)/);
  assert.ok(!/mark: "drop"/.test(keep), "the heart never drops");
  const wire = fnSrc("wireReactions");
  for (const ev of ["dblclick", "contextmenu", "pointerdown", "pointermove"]) assert.ok(wire.includes('"' + ev + '"'), ev);
  assert.match(wire, /LONG_PRESS_MS/);
  assert.match(wire, /MOVE_CANCEL_PX/);
  assert.match(js, /const LONG_PRESS_MS = 450;/);
  assert.match(js, /const MOVE_CANCEL_PX = 10;/);
  assert.match(wire, /e\.key !== "Enter" && e\.key !== " "/);
  assert.match(fnSrc("renderMessage"), /b\.setAttribute\("tabindex", "0"\);\s*b\.setAttribute\("aria-haspopup", "menu"\)/);
  assert.match(fnSrc("keptMark"), /class: "kept-mark", role: "img", "aria-label": "kept"/);
});

test("pictures: photoActions( is called only inside a state.operator branch; the lightbox binds lbKeep, lbReject and lbAgain", () => {
  const calls = js.split("\n").filter((l) => l.includes("photoActions(") && !l.includes("function photoActions("));
  assert.ok(calls.length >= 1);
  for (const l of calls) assert.ok(l.includes("state.operator"), l.trim());
  const clipCalls = js.split("\n").filter((l) => l.includes("clipActions(") && !l.includes("function clipActions("));
  for (const l of clipCalls) assert.ok(l.includes("state.operator"), l.trim());
  assert.equal((js.match(/text: "Approve"/g) || []).length, 2, "Approve is built only by photoActions and clipActions");
  for (const id of ["lbKeep", "lbReject", "lbAgain"]) assert.match(js, new RegExp("els\\." + id + "\\.addEventListener\\(\"click\""), id);
  const decide = fnSrc("decidePicture");
  assert.match(decide, /"\/api\/images\/" \+ encodeURIComponent\(imageId\) \+ "\/decide", \{ decision \}/);
  assert.match(fnSrc("regeneratePicture"), /"\/regenerate"/);
});

test("pictures: renderPhoto and renderClip build the picture as button.photo-open, no Open full size, no us chip outside the workings", () => {
  for (const name of ["renderPhoto", "renderClip"]) {
    const src = fnSrc(name);
    assert.ok(!src.includes("Open full size"), name);
    assert.ok(!src.includes('chip("us"'), name);
    assert.match(src, /pictureButton\(/);
  }
  assert.ok(!js.includes("Open full size"));
  assert.match(fnSrc("pictureButton"), /class: "photo-open",\s*"aria-label": "Open picture"/);
  assert.match(fnSrc("workingsChips"), /^function workingsChips\(imageId, withHim\) \{\s*if \(!state\.operator\) return null;/);
  const lb = fnSrc("showLightboxItem");
  assert.match(lb, /url \+ "\?download=1"/);
  assert.match(lb, /controls: true, autoplay: true, playsinline: true/);
  assert.match(fnSrc("lightboxKey"), /trapTab\(e, els\.lightbox\)/);
});

test("failures: errorWords maps codes to words (extracted and evaluated); showError writes errorWords( and the code only with the workings", () => {
  const src = js.slice(js.indexOf("const ERROR_WORDS"), js.indexOf("// The words; with the workings on"));
  const errorWords = new Function(src + "\nreturn errorWords;")();
  assert.equal(errorWords("provider_failed"), "Didn't come through");
  assert.equal(errorWords("budget_exceeded"), "Today's limit reached");
  assert.equal(errorWords("tasting_budget_exceeded"), "Today's limit reached");
  assert.equal(errorWords("price_unknown"), "Today's limit reached");
  for (const c of ["in_progress", "idempotency_conflict", "tasting_pending"]) assert.equal(errorWords(c), "Still on the last one", c);
  for (const c of ["provider_refused", "provider_not_configured", "image_failed", "internal", "error", "something_new", undefined, ""]) assert.equal(errorWords(c), "Didn't come through", String(c));
  for (const c of ["validation", "too_large", "unsupported_media_type"]) assert.equal(errorWords(c), "Couldn't send that", c);
  assert.equal(errorWords("microphone"), "Microphone is off");
  for (const label of ["8 MB max", "jpeg, png or webp", "max 3 photos", "4 MB max"]) assert.equal(errorWords(label), label);
  const show = fnSrc("showError");
  assert.match(show, /errorWords\(/);
  assert.match(show, /state\.operator && raw && raw !== words \? words \+ " -- " \+ raw : words/);
  assert.match(fnSrc("failedPicture"), /text: "didn't come through"/);
  assert.match(fnSrc("failedPicture"), /"aria-label": "Try again"/);
});

test("voice notes: a click on #micBtn starts the recording, recSend sends through sendVoice, recCancel discards, the 60 s cap stops and sends", () => {
  const init = fnSrc("initMic");
  assert.match(init, /els\.micBtn\.addEventListener\("click", \(\) => \{\s*closeMenus\(false\);\s*startRecording\(\);/);
  assert.match(init, /els\.recSend\.addEventListener\("click", \(\) => stopRecording\(\)\)/);
  assert.match(init, /els\.recCancel\.addEventListener\("click", \(\) => cancelRecording\(\)\)/);
  assert.ok(!init.includes("pointerdown"), "no hold");
  assert.match(fnSrc("startRecording"), /setTimeout\(\(\) => stopRecording\(\), MAX_VOICE_MS\)/);
  assert.match(fnSrc("finishRecording"), /if \(rec\.cancelled\) return;[\s\S]*sendVoice\(blob, mime\)/);
  assert.match(fnSrc("showRecBar"), /els\.recBar\.classList\.remove\("hidden"\)/);
});

test("the tools sheet: popover from the button's rect over 760 (CSSOM), cleared at 760 and under; Escape and the scrim give the focus back", () => {
  assert.match(js, /const PHONE_QUERY = "\(max-width: 760px\)";/);
  const place = fnSrc("placeSheet");
  assert.match(place, /sheet\.style\.top = Math\.round\(rect\.bottom \+ 8\) \+ "px"/);
  assert.match(place, /sheet\.style\.right = Math\.round\(window\.innerWidth - rect\.right\) \+ "px"/);
  assert.match(place, /sheet\.style\.removeProperty\("top"\)/);
  assert.match(fnSrc("openPlaces"), /openSheet\(els\.placesPop, anchor\)/);
  assert.match(js, /els\.scrim\.addEventListener\("click", \(\) => \{ closeSidebar\(\); closeDrawers\(\); closeMenus\(true\); \}\)/);
  assert.match(fnSrc("updateSendState"), /els\.tasteBtn\.disabled = [^;]*!els\.input\.value\.trim\(\)/);
});

test("the thread: day separators in words, .rise on arrivals, body.her-typing while the dots show", () => {
  const dayWords = new Function(fnSrc("dayWords") + "\nreturn dayWords;")();
  const now = new Date(2026, 8, 26, 21, 0);
  assert.equal(dayWords(new Date(2026, 8, 26, 8, 0).toISOString(), now), "Today");
  assert.equal(dayWords(new Date(2026, 8, 25, 23, 0).toISOString(), now), "Yesterday");
  assert.equal(dayWords(new Date(2026, 8, 22, 12, 0).toISOString(), now), "Tuesday");
  assert.equal(dayWords(new Date(2026, 8, 20, 12, 0).toISOString(), now), "Sunday", "six days back is still a weekday");
  assert.equal(dayWords(new Date(2026, 8, 19, 12, 0).toISOString(), now), "Sep 19");
  assert.match(fnSrc("layoutDays"), /class: "day-sep"/);
  assert.match(fnSrc("appendMessage"), /el\.classList\.add\("rise"\)/);
  assert.match(fnSrc("arrive"), /appendMessage\(el, \{ rise: true \}\)/);
  assert.match(fnSrc("refreshTyping"), /document\.body\.classList\.toggle\("her-typing", on\)/);
});

test("kept from v4 and v5: player.js import, the song embed slot and play event, the song buttons in both modes, artistNorm", () => {
  assert.match(js, /^import "\.\/player\.js";$/m);
  assert.match(js, /h\("div", \{ class: "song-embed hidden" \}\)/);
  assert.match(js, /new CustomEvent\("avelie:play", \{ detail: \{ uri, target: embed \} \}\)/);
  assert.match(fnSrc("songCard"), /if \(m\.id && artist\) card\.append\(songFeedback\(m\.id, artist\)\)/);
  assert.match(fnSrc("songCard"), /if \(known && state\.operator\) slot\.append/);
  assert.ok(js.includes("know it") && js.includes("not for me"));
  assert.ok(js.includes("function artistNorm(a) {") && js.includes("const FEEDBACK"));
});

test("no class who for the chat bar: the bar is her-who, her-who-text, her-name; span.who stays only on the call transcript and his version", () => {
  assert.ok(!/["'](who-text|who-name)["']/.test(js));
  assert.equal((js.match(/class: "who"/g) || []).length, 2);
  assert.ok(!/class: "who /.test(js));
});
