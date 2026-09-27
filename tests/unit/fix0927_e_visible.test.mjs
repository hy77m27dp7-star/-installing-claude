// fix0927 hand pass: what the redesign hid, back in plain sight. The note under each of her
// replies without the workings switch; her mood and outfit on one line under the place line;
// a labelled way into her phone's apps on the lock screen. chat.js touches the DOM at import,
// so it is read as text and its pure pieces evaluated (the chat_exp way).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const js = readFileSync(new URL("../../public/js/chat.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../../public/index.html", import.meta.url), "utf8");
const phone = readFileSync(new URL("../../public/phone.html", import.meta.url), "utf8");
const css = readFileSync(new URL("../../public/css/app.css", import.meta.url), "utf8");

function slice(from, to) {
  const i = js.indexOf(from);
  const j = js.indexOf(to, i);
  assert.ok(i >= 0 && j > i, from);
  return js.slice(i, j);
}

test("the note button is outside the workings switch", () => {
  const src = slice("function metaRow(", "\n}\n");
  const note = src.indexOf('class: "note-btn"');
  const operator = src.indexOf("if (state.operator && hers)");
  assert.match(src, /class: "meta-heart"/);
  assert.ok(note > 0 && operator > 0 && note < operator, "note is appended before the operator-only block");
  assert.match(src, /if \(hers\) row\.append\(h\("button", \{ type: "button", class: "note-btn"/);
  assert.match(src, /const hers = m\.role === "assistant" && m\.channel !== "operator" && m\.id;/);
});

test("nowLineText reads mood and outfit, and nothing when there is nothing", () => {
  const f = new Function(slice("function nowLineText(", "let nowLoadedAt") + "; return nowLineText;")();
  assert.equal(f({ mood: { mood: "wanting him" }, outfit: { text: "Black fitted tank, jeans." } }), "wanting him · wearing black fitted tank, jeans");
  assert.equal(f({ mood: { mood: "  quiet  " }, outfit: null }), "quiet");
  assert.equal(f({ mood: null, outfit: { text: "His shirt" } }), "wearing his shirt");
  assert.equal(f({}), "");
  assert.equal(f(null), "");
  assert.equal(f({ mood: { mood: 3 }, outfit: { text: "" } }), "");
});

test("the now line sits under the place line and loads after the scene and after a reply", () => {
  assert.match(html, /id="placeLine"[^>]*><\/button>\s*<span class="now-line hidden" id="nowLine"><\/span>/);
  assert.match(slice("async function loadScene(", "\n}\n") + "\n}", /loadNow\(true\);/);
  assert.match(js, /refreshTitlesAfterTurn\(id\);\n\s*loadNow\(false\);/);
  assert.match(css, /\.now-line \{[^}]*text-overflow: ellipsis;/);
});

test("the lock screen says where her apps are", () => {
  assert.match(phone, /id="openHome"[^>]*><em class="home-label" aria-hidden="true">her apps<\/em>/);
  assert.match(css, /\.home-label \{/);
  const rm = css.lastIndexOf("@media (prefers-reduced-motion");
  assert.ok(css.indexOf(".home-label {") < rm, "the reduced-motion block stays last");
});
