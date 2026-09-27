// fix0927 lane A: the chat page. A1 her actions as their own stage lines (chat.js renders
// splitReply's pieces), A2 the voice-note row in place of the bare <audio controls>, A3 the
// controls in plain sight (the Together / Texting pill and Call in the bar, Send a photo and
// Voice note beside the box, the Let her start chip). chat.js touches the DOM at import, so
// it is read as text and its pure pieces are extracted and evaluated (the chat_exp way).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const js = readFileSync(new URL("../../public/js/chat.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../../public/index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../../public/css/app.css", import.meta.url), "utf8");
const bubbles = await import("../../public/js/bubbles.js");

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

function fakeH(tag, props, ...children) {
  const el = { tag, props: props || {}, children: [], append(...xs) { for (const x of xs.flat()) if (x) this.children.push(x); } };
  el.append(...children);
  return el;
}
const doc = { createTextNode: (t) => ({ text: t }) };
const count = (text, needle) => text.split(needle).length - 1;

// ------------------------------------------------------------ A1

test("A1: chat.js renders splitReply's pieces: an action is a .bubble.action stage line, speech a .bubble with em.emph", () => {
  assert.match(js, /^import \{ splitReply, bubbleDelayMs, pauseForId, PAUSE_MS, dotsLeadMs \} from "\.\/bubbles\.js";$/m);
  const pieceEl = new Function("h", "document", fnSrc("pieceEl") + "\nreturn pieceEl;")(fakeH, doc);
  const lineEls = new Function("h", "document", "splitReply", "bubbleEl", fnSrc("pieceEl") + fnSrc("lineEls") + "\nreturn lineEls;")(fakeH, doc, bubbles.splitReply, (t) => ({ fallback: t }));
  const out = lineEls("*presses my face back into your jacket* okay... keep me then");
  assert.equal(out.length, 2, "two elements, not one fused bubble");
  assert.equal(out[0].props.class, "bubble action");
  assert.equal(out[0].props.text, "presses my face back into your jacket");
  assert.equal(out[1].props.class, "bubble");
  assert.deepEqual(out[1].children.map((c) => c.text), ["okay... keep me then"]);
  const emph = pieceEl(bubbles.splitReply("i *really* mean it")[0]);
  assert.deepEqual(emph.children.map((c) => (c.tag ? [c.tag, c.props.class, c.props.text] : c.text)), ["i ", ["em", "emph", "really"], " mean it"]);
  const three = lineEls("okay *pulls the blanket over both of us* goodnight").map((e) => [e.props.class, e.props.text || e.children.map((c) => c.text).join("")]);
  assert.deepEqual(three, [["bubble", "okay"], ["bubble action", "pulls the blanket over both of us"], ["bubble", "goodnight"]]);
  assert.deepEqual(lineEls(""), [{ fallback: "" }], "an empty line keeps one empty bubble");
  assert.ok(!/innerHTML/.test(fnSrc("pieceEl")), "text nodes, never markup");
});

test("A1: renderMessage sends her line, his line and the tasting panels through lineEls; the operator row stays whole", () => {
  const render = fnSrc("renderMessage");
  // 2026-09-27: a line of hers with audio shows only her voice (spokenOnly: no bubbles).
  assert.match(render, /const parts = op \? \[bubbleEl\(m\.content \|\| ""\)\] : spokenOnly \? \[\] : lineEls\(m\.content\);/);
  assert.match(render, /bubbles\.append\(\.\.\.lineEls\(m\.content, \{ long: false \}\)\)/, "his actions read the same way, his line never cut for length");
  assert.match(render, /for \(const b of parts\) \{\s*if \(reacts\) \{\s*b\.setAttribute\("tabindex", "0"\);/);
  assert.match(fnSrc("renderTasting"), /bubbles\.append\(\.\.\.lineEls\(c\.text\)\);/);
  assert.ok(!js.includes("splitBubbles("), "the old whole-paragraph splitter is not used by the page");
});

// ------------------------------------------------------------ A2

test("A2: a reply with audio renders the voice-note row, never the bare <audio controls>", () => {
  assert.match(fnSrc("renderMessage"), /if \(m\.audio_key && m\.id\) extras\.append\(voiceNote\(m\.id\)\);/);
  assert.ok(!/controls: true/.test(fnSrc("renderMessage")) && !/controls: true/.test(fnSrc("voiceNote")), "no bare player for her voice note");
  const vn = fnSrc("voiceNote");
  assert.match(vn, /h\("audio", \{ preload: "metadata", src: "\/media\/audio\/" \+ encodeURIComponent\(messageId\) \}\)/);
  assert.match(vn, /class: "vn-play", "aria-label": "Play voice note", "aria-pressed": "false"/);
  assert.match(vn, /role: "progressbar", "aria-label": "Voice note played"/);
  assert.match(vn, /h\("div", \{ class: "audio-note voice-note" \}, btn, track, time, audio\)/);
  assert.match(vn, /audio\.addEventListener\("error", \(\) => \{\s*row\.classList\.add\("hidden"\);/, "a note that cannot load hides the whole row");
  assert.match(vn, /audio\.addEventListener\("loadedmetadata", paint\)/);
  assert.match(vn, /btn\.setAttribute\("aria-label", on \? "Pause voice note" : "Play voice note"\)/);
  assert.match(vn, /fill\.style\.transform = /, "the fill moves through the CSSOM");
  assert.ok(!/setAttribute\("style"/.test(vn));
  assert.match(vn, /other && other !== audio && !other\.paused\) other\.pause\(\)/, "one note at a time");
});

test("A2: voiceNoteLabel: the length at rest, the time played while it plays, nothing before the length is known", () => {
  const fmt = (s) => Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");
  const label = new Function(fnSrc("voiceNoteLabel") + "\nreturn voiceNoteLabel;")();
  assert.equal(label(0, 12.4, fmt), "0:12");
  assert.equal(label(0, NaN, fmt), "");
  assert.equal(label(0, Infinity, fmt), "");
  assert.equal(label(0, 0, fmt), "");
  assert.equal(label(3.2, 12.4, fmt), "0:03");
  assert.equal(label(65, Infinity, fmt), "1:05", "a stream of unknown length still counts up");
});

test("A2: the row is styled from the design tokens: the accent play button and a thin fill line, 40px targets", () => {
  const block = css.slice(css.indexOf("/* ------------------------------------------------------------ fix0927 lane A */"));
  assert.ok(block.length > 100, "the lane A block");
  assert.match(block, /\.voice-note audio \{ display: none; \}/);
  assert.match(block, /\.vn-play \{[^}]*width: 40px;[^}]*height: 40px;[^}]*background: var\(--accent\);/);
  assert.match(block, /\.vn-fill \{[^}]*transform: scaleX\(0\);[^}]*transform-origin: left center;/);
  assert.match(block, /\.vn-time \{[^}]*color: var\(--text-2\)/);
});

// ------------------------------------------------------------ A3

test("A3: index.html: the pill and Call sit in the thread bar before the three dots; the place line stays under her name", () => {
  const bar = html.slice(html.indexOf('<div class="thread-bar">'), html.indexOf('<div class="thread" id="thread"'));
  const at = (id) => bar.indexOf('id="' + id + '"');
  for (const id of ["modePill", "modeTogether", "modeTexting", "barCall", "moreBtn", "placeLine"]) assert.ok(at(id) > 0, "#" + id + " in the bar");
  assert.ok(at("placeLine") < at("modePill") && at("modePill") < at("barCall") && at("barCall") < at("moreBtn"), "name and place, the pill, Call, the dots");
  assert.match(bar, /<div class="seg mode-pill" id="modePill" role="group" aria-label="[^"]+">\s*<button type="button" id="modeTogether" aria-pressed="false" aria-haspopup="dialog" aria-controls="placesPop" aria-expanded="false">Together<\/button>\s*<button type="button" id="modeTexting" aria-pressed="false">Texting<\/button>\s*<\/div>/);
  assert.match(bar, /<button type="button" class="icon-btn bar-call hidden" id="barCall" aria-label="Call her" aria-pressed="false">/);
});

test("A3: index.html: Send a photo and Voice note to the left of the text box, the Let her start chip above the composer", () => {
  const box = html.slice(html.indexOf('<div class="composer-box">'), html.indexOf("</form>"));
  const at = (id) => box.indexOf('id="' + id + '"');
  assert.ok(at("composerPhoto") > 0 && at("composerMic") > at("composerPhoto") && at("input") > at("composerMic") && at("sendBtn") > at("input"));
  assert.match(box, /id="composerPhoto" aria-label="Send a photo"/);
  assert.match(box, /id="composerMic" aria-label="Voice note" aria-pressed="false"/);
  const form = html.slice(html.indexOf('<form class="composer"'), html.indexOf('<div class="composer-box">'));
  assert.match(form, /<div class="start-chip-row hidden" id="startRow">\s*<button type="button" class="start-chip" id="startChip">[\s\S]*<span>Let her start<\/span><\/button>/);
});

test("A3: the menu keeps every row it had; no id is cloned; every icon-only button has a label", () => {
  const menu = html.slice(html.indexOf('id="moreMenu"'), html.indexOf('id="placesPop"'));
  for (const id of ["callBtn", "letHerStart", "attachBtn", "micBtn", "photosBtn", "tasteBtn", "timingToggle", "operatorToggle", "toolStudio"]) assert.ok(menu.includes('id="' + id + '"'), "the menu keeps #" + id);
  const ids = Array.from(html.matchAll(/\sid="([^"]+)"/g)).map((m) => m[1]);
  assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), [], "every id once");
  // The bar and the composer (the place line takes its words from the script at load).
  const bar = html.slice(html.indexOf('<div class="thread-bar">'), html.indexOf('<div class="thread" id="thread"'));
  const form = html.slice(html.indexOf('<form class="composer"'), html.indexOf("</form>"));
  let checked = 0;
  for (const m of (bar + form).matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
    if (m[1].includes('id="placeLine"')) continue;
    const inner = m[2].replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, "").trim();
    if (!inner) {
      checked++;
      assert.match(m[1], /aria-label="[^"]+"/, "an icon-only button without a label: " + m[1].trim());
    }
  }
  assert.ok(checked >= 6, "drawer, Call, dots, photo, mic and send are icon-only and labelled");
});

test("A3: one handler per action, bound to the menu row and its twin in sight", () => {
  assert.match(js, /const callButtons = \(\) => \[els\.callBtn, els\.barCall\]\.filter\(Boolean\);/);
  assert.match(js, /const micButtons = \(\) => \[els\.micBtn, els\.composerMic\]\.filter\(Boolean\);/);
  assert.match(js, /const photoButtons = \(\) => \[els\.attachBtn, els\.composerPhoto\]\.filter\(Boolean\);/);
  // 2026-09-27: with her own voice set up, every call is the hands-free loop in her voice.
  assert.match(js, /const onCallClick = \(\) => \{ closeMenus\(false\); if \(state\.dt \|\| herVoiceReady\(\)\) dtToggle\(\); else startCall\(\); \};\nconst onStartClick = \(\) => \{ closeMenus\(false\); letHerStart\(\); \};\nconst onPhotoClick = \(\) => \{ closeMenus\(false\); els\.fileInput\.click\(\); \};\n/);
  // fix0927 review: Texting while already apart writes nothing (no scene version, the place kept).
  assert.match(js, /const onTextingClick = \(\) => \{\n  closeMenus\(true\);\n  if \(state\.scene && state\.scene\.status === "apart"\) return;\n  setScene\("apart", null\);\n\};/);
  assert.match(js, /for \(const b of callButtons\(\)\) b\.addEventListener\("click", onCallClick\);/);
  assert.match(js, /for \(const b of \[els\.letHerStart, els\.startChip\]\) if \(b\) b\.addEventListener\("click", onStartClick\);/);
  assert.match(js, /for \(const b of \[els\.sceneApart, els\.modeTexting\]\) if \(b\) b\.addEventListener\("click", onTextingClick\);/);
  assert.match(js, /els\.modeTogether\.addEventListener\("click", \(\) => onPlaceToggle\(els\.modeTogether\)\)/, "Together opens the place sheet as the place line does, under the pill");
  assert.match(js, /els\.placeLine\.addEventListener\("click", \(\) => onPlaceToggle\(\)\)/);
  assert.match(js, /for \(const b of photoButtons\(\)\) b\.addEventListener\("click", onPhotoClick\);/);
  assert.match(fnSrc("initMic"), /els\.composerMic\.addEventListener\("click", \(\) => \{\s*closeMenus\(false\);\s*startRecording\(\);/, "the same tap-to-record");
  assert.match(fnSrc("initMic"), /for \(const b of micButtons\(\)\) b\.classList\.add\("hidden"\);/);
  assert.match(fnSrc("openPlaces"), /const anchor = from \|\| \(/);
  assert.match(fnSrc("closeMenus"), /els\.modeTogether\.setAttribute\("aria-expanded", "false"\)/);
  assert.match(js, /t\.closest\("#placeLine"\) \|\| t\.closest\("#modePill"\)/, "a tap on the pill does not close the sheet it opens");
});

test("A3: the twins share state: calling, recording, disabled and hidden, and the pill lights the scene", () => {
  const send = fnSrc("updateSendState");
  assert.match(send, /for \(const b of micButtons\(\)\) b\.disabled = busy \|\| state\.operator;/);
  assert.match(send, /for \(const b of photoButtons\(\)\) b\.disabled = busy \|\| state\.operator;/);
  assert.match(send, /for \(const b of callButtons\(\)\) \{\s*b\.classList\.toggle\("hidden", !callVisible\(\) \|\| state\.operator\);/);
  assert.match(send, /updateStartChip\(\);/);
  assert.match(fnSrc("markCalling"), /for \(const b of callButtons\(\)\)/);
  assert.match(fnSrc("markRecording"), /for \(const b of micButtons\(\)\)/);
  assert.ok(!/els\.callBtn\.classList\.(add|remove)\("calling"\)/.test(js), "no single-button calling state left");
  assert.ok(!/els\.micBtn\.classList\.(add|remove)\("recording"\)/.test(js), "no single-button recording state left");
  const render = fnSrc("renderScene");
  assert.match(render, /\[els\.sceneTogether, els\.modeTogether\]/);
  assert.match(render, /\[els\.sceneApart, els\.modeTexting\]/);
  assert.match(fnSrc("setScene"), /for \(const b of sceneButtons\(\)\) b\.disabled = true;/);
});

test("A3: startChipShows: an empty chapter, or her line two minutes old; never while busy, pending, on a call, tasting or with the workings", () => {
  const src = js.slice(js.indexOf("const START_CHIP_MS"), js.indexOf("function startChipState("));
  const shows = new Function(src + "\nreturn startChipShows;")();
  const now = Date.parse("2026-09-27T12:00:00Z");
  const ago = (ms) => new Date(now - ms).toISOString();
  const base = { lastRole: null, lastAt: null, operator: false, tasting: false, busy: false, onCall: false, pending: false };
  assert.equal(shows(base, now), true, "no messages yet");
  assert.equal(shows({ ...base, lastRole: "assistant", lastAt: ago(3 * 60000) }, now), true, "hers, three minutes old");
  assert.equal(shows({ ...base, lastRole: "assistant", lastAt: ago(2 * 60000) }, now), true, "exactly two minutes");
  assert.equal(shows({ ...base, lastRole: "assistant", lastAt: ago(60000) }, now), false, "hers, one minute old");
  assert.equal(shows({ ...base, lastRole: "user", lastAt: ago(3600000) }, now), false, "his line is last: she answers it, no chip");
  assert.equal(shows({ ...base, lastRole: "assistant", lastAt: "junk" }, now), false);
  for (const k of ["operator", "tasting", "busy", "onCall", "pending"]) assert.equal(shows({ ...base, [k]: true }, now), false, k);
  assert.equal(shows(null, now), false);
});

test("A3: the chip re-checks itself: a timer for the two-minute mark, on return to the tab, after a delivery is scheduled", () => {
  const upd = fnSrc("updateStartChip");
  assert.match(upd, /els\.startRow\.classList\.toggle\("hidden", !show\)/);
  assert.match(upd, /state\.startTimer = setTimeout\(updateStartChip,/);
  assert.match(fnSrc("updateStartButton"), /updateStartChip\(\);/);
  assert.match(fnSrc("onVisible"), /else updateStartChip\(\);/);
  assert.match(fnSrc("scheduleDelivery"), /state\.deliveries\.set\(m\.id, entry\);\s*refreshTyping\(\);\s*updateStartChip\(\);/);
  assert.match(fnSrc("noteRole"), /state\.lastStoryAt = storyAt\(m\);/);
  const storyAt = new Function(fnSrc("storyAt") + "\nreturn storyAt;")();
  assert.equal(storyAt({ deliver_at: "2026-09-27T10:00:00Z", created_at: "2026-09-27T09:00:00Z" }), "2026-09-27T10:00:00Z", "a delayed reply counts from when it landed");
  assert.equal(storyAt({ created_at: "2026-09-27T09:00:00Z" }), "2026-09-27T09:00:00Z");
  assert.ok(Number.isFinite(Date.parse(storyAt({}))), "a row straight from a turn is now");
});

test("A3: app.css: the lane A block sits before the global reduced-motion switch; 40px targets; the phone bar takes a second row for the pill", () => {
  const start = css.indexOf("/* ------------------------------------------------------------ fix0927 lane A */");
  const last = css.lastIndexOf("@media");
  assert.ok(start > 0 && start < last, "before the last @media (the global switch stays last)");
  const block = css.slice(start, css.indexOf("/* The one global switch, last in the file"));
  assert.ok(!/var\(--muted\)/.test(block), "no --muted on a Her page");
  assert.match(block, /\.composer-tool \{ width: 40px; height: 40px; \}/);
  assert.match(block, /\.msg\.his \.bubble\.action \{ background: none; box-shadow: none; \}/, "his stage lines have no ground either");
  assert.match(block, /\.msg\.hers \.bubble\.action \+ \.bubble:not\(\.action\) \{ border-top-left-radius: 22px; \}/);
  assert.match(block, /\.start-chip \{[^}]*min-height: 40px;/);
  assert.match(block, /\.mode-pill button\[aria-pressed="true"\],\s*\.mode-pill button\[aria-pressed="true"\]:hover \{ background: var\(--accent\); color: var\(--ink\);/, "the active mode is lit");
  assert.match(block, /@media \(max-width: 520px\) \{[\s\S]*?\.thread-bar \{ flex: none; flex-wrap: wrap;[\s\S]*?\.thread-bar::after \{ content: ""; order: 9; flex: 0 0 100%; height: 0; \}[\s\S]*?\.mode-pill \{ order: 10; margin: 0 auto; \}/);
  assert.match(block, /@media \(max-width: 360px\) \{\s*\.thread-bar \.icon-btn \{ width: 40px; height: 40px; \}/, "icon buttons never under 40px");
  for (const m of block.matchAll(/(^|\n)([^{}\n]*\.thread-bar[^{}\n]*)\{([^}]*)\}/g)) {
    if (/::after|::before/.test(m[2])) continue;
    assert.ok(!/(^|[;\s])(backdrop-filter|-webkit-backdrop-filter|filter|transform)\s*:/.test(m[3]), "the bar holds the sheets: no containing block, " + m[2].trim());
  }
});
