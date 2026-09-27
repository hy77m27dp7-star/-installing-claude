// The experience pass, design lane (DESIGN_EXPERIENCE sections 2, 3.3 to 7.4, 9 and 10.2),
// read as text: the shell and the two font preloads on every page, the self-hosted fonts
// with their hashes, every token and rule of the visual system, the containing-block rule
// for the fixed tab bar and the sheets, the class vocabulary of section 9, no --muted on a
// Her page, the contrast table of 2.5 recomputed from the tokens, no style attribute or
// inline script anywhere, no machinery words in the visible text of the Her pages, the nav
// and backdrop exports of nav.js, the service worker's shell and font cache.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { BAD_TYPOGRAPHY } from "./helpers.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PUBLIC = join(ROOT, "public");
const read = (rel) => readFileSync(join(PUBLIC, rel), "utf8");
const pages = readdirSync(PUBLIC).filter((f) => f.endsWith(".html")).sort();
const css = read("css/app.css");
const nav = read("js/nav.js");
const sw = read("sw.js");
const count = (text, needle) => text.split(needle).length - 1;

// ------------------------------------------------------------ a small CSS reader

// Every innermost rule: its selectors (comma split, whitespace collapsed) and its body.
// Rules inside @media keep their own selectors; @font-face and keyframe steps are skipped.
function rules(source) {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = [];
  for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const prelude = m[1].trim();
    if (prelude.startsWith("@") || /^(from|to|\d+%)(\s*,\s*(from|to|\d+%))*$/.test(prelude)) continue;
    out.push({ selectors: prelude.split(",").map((s) => s.replace(/\s+/g, " ").trim()), body: m[2] });
  }
  return out;
}

const RULES = rules(css);
const rootBlock = /:root\s*\{([\s\S]*?)\n\}/.exec(css);
function token(name) {
  const m = new RegExp("\\s" + name.replace(/[-]/g, "\\-") + ":\\s*([^;]+);").exec(rootBlock ? rootBlock[1] : "");
  return m ? m[1].trim() : null;
}

// ------------------------------------------------------------ WCAG 2.x

function hexRgb(hex) {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}
function lum(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a, b) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
// A translucent colour composited over an opaque one, rounded like a screen pixel.
function over(rgba, below) {
  const a = rgba[3];
  return [0, 1, 2].map((i) => Math.round(rgba[i] * a + below[i] * (1 - a)));
}
function rgbaOf(value) {
  const m = /rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\s*\)/.exec(value || "");
  assert.ok(m, "an rgba() value: " + value);
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
}

// ------------------------------------------------------------ the pages

const HER_PAGES = ["index.html", "phone.html", "album.html", "us.html"];
const PRELOADS = [
  '<link rel="preload" href="/fonts/fraunces-latin-full-normal.woff2" as="font" type="font/woff2" crossorigin>',
  '<link rel="preload" href="/fonts/instrument-sans-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>',
];

test("every page carries the shell once (the wordmark reads Avelie) and the two font preloads after the stylesheet", () => {
  assert.ok(pages.includes("us.html"), "us.html exists");
  for (const p of pages) {
    const html = read(p);
    for (const needle of ['class="brand"', 'id="avatar"', 'class="wordmark"', 'class="nav"', '<header class="top">']) assert.equal(count(html, needle), 1, p + " " + needle);
    assert.ok(html.includes('<span class="wordmark">Avelie</span>'), p + " the wordmark is sentence case");
    const sheet = html.indexOf('<link rel="stylesheet" href="/css/app.css">');
    assert.ok(sheet > 0, p + " the stylesheet");
    for (const pre of PRELOADS) {
      assert.equal(count(html, pre), 1, p + " " + pre);
      assert.ok(html.indexOf(pre) > sheet, p + " the preload follows the stylesheet");
    }
  }
});

test("no page carries a style attribute or an inline script; every page is typography clean", () => {
  for (const p of pages) {
    const html = read(p);
    assert.ok(!/\sstyle\s*=\s*["']/.test(html), p + " has a style attribute");
    assert.ok(!/<script(?![^>]*\ssrc=)[^>]*>/.test(html), p + " has an inline script");
    assert.ok(!BAD_TYPOGRAPHY.test(html), p);
  }
  assert.ok(!BAD_TYPOGRAPHY.test(css), "app.css");
  assert.ok(!BAD_TYPOGRAPHY.test(nav), "nav.js");
  assert.ok(!BAD_TYPOGRAPHY.test(sw), "sw.js");
});

test("the Her pages show no machinery words in their visible text", () => {
  const BANNED = /\b(proposal|version|seq|id|model|prompt|flag|json|phase|weight)\b/i;
  for (const p of HER_PAGES) {
    const visible = read(p)
      .replace(/<script[\s\S]*?<\/script>/g, " ")
      .replace(/<svg[\s\S]*?<\/svg>/g, " ")
      .replace(/<[^>]+>/g, " ");
    const hit = BANNED.exec(visible);
    assert.ok(!hit, p + " shows " + (hit && hit[0]));
  }
});

test("index.html: the two sheets sit at body level after <main>, the chapter head leads the thread with aria-live off, the phone slide-in is gone", () => {
  const html = read("index.html");
  const mainEnd = html.indexOf("</main>");
  assert.ok(mainEnd > 0);
  for (const id of ["moreMenu", "placesPop"]) {
    const at = html.indexOf('id="' + id + '"');
    assert.ok(at > mainEnd, "#" + id + " after </main>");
  }
  const bar = html.slice(html.indexOf('<div class="thread-bar">'), html.indexOf('<div class="thread" id="thread"'));
  assert.ok(!bar.includes("moreMenu\"") || !/id="moreMenu"/.test(bar), "#moreMenu is not inside the bar");
  assert.ok(/<div class="thread" id="thread" aria-live="polite">\s*<header class="chapter-head" id="chapterHead" aria-live="off">/.test(html), "#chapterHead is the thread's first child");
  assert.ok(/<img class="backdrop" id="backdrop"[^>]*data-manual>/.test(html), "the chat fills its own backdrop");
  for (const id of ["phoneBtn", "phoneDrawer", "phoneDrawerBody", "phoneClose"]) assert.ok(!html.includes('id="' + id + '"'), "no #" + id);
  for (const id of ["recBar", "recTime", "recCancel", "recSend", "toolStudio", "whoAvatar", "placeLine", "chapterEdit", "chapterDate", "lbDecide", "lbKeep", "lbReject", "lbAgain", "clockChip", "nowPlaying", "whyDrawer", "photosDrawer", "callSheet"]) assert.equal(count(html, 'id="' + id + '"'), 1, "#" + id);
  assert.ok(/<span class="kicker tool-kicker">|<p class="kicker tool-kicker">Writer<\/p>/.test(html), "the Writer kicker");
});

test("phone.html, album.html and us.html: the markup contracts of 4.3, 5.3 and 6.3", () => {
  const phone = read("phone.html");
  assert.ok(/<img class="backdrop" id="backdrop" alt="" aria-hidden="true" decoding="async">/.test(phone));
  for (const gone of ["phoneStatus", "phoneNow", "phoneMood", "phoneWants", "phoneMap", "placesStatus", "mapFoot", "placeTitle", "placeAdd"]) assert.ok(!phone.includes('id="' + gone + '"'), "phone.html has no #" + gone);
  for (const app of ["maps", "notes", "photos", "messages", "music"]) assert.ok(phone.includes('data-app="' + app + '"'), "app " + app);
  const album = read("album.html");
  for (const gone of ["albumStatus", "albumFilter", "albumGrid", "data-group"]) assert.ok(!album.includes(gone), "album.html has no " + gone);
  for (const id of ["lbClose", "lbPrev", "lbNext", "lbDate", "lbPlace", "lbOpen"]) assert.ok(album.includes('id="' + id + '"'), "#" + id);
  const us = read("us.html");
  assert.ok(/<main class="page us-page">/.test(us), "main.us-page, never a bare .us");
  assert.ok(/<img class="avatar ring hero"[^>]*data-avatar="her">/.test(us), "the hero face");
  for (const id of ["chaptersSection", "momentsSection", "placesSection", "keptSection"]) assert.ok(us.includes('id="' + id + '"'), "#" + id);
});

test("Studio markup: Record grouped with human fields and Advanced, Settings in one form with eight groups, Pictures has Places, Timeline has the log switch", () => {
  const state = read("state.html");
  assert.ok(/<nav class="studio-tabs" aria-label="Record">/.test(state));
  assert.equal(count(state, 'class="tab-group"'), 4, "four tab groups");
  for (const tab of ["now", "life", "wants", "facts", "history", "memory", "unknowns", "inbox", "voice", "notes", "rulebook", "export"]) assert.equal(count(state, 'data-tab="' + tab + '"'), 1, "tab " + tab);
  for (const id of ["relFields", "sceneFields"]) assert.ok(state.includes('<div class="human-fields" id="' + id + '"></div>'), "#" + id);
  assert.equal(count(state, '<details class="advanced">'), 2, "Advanced around each JSON");
  const model = read("model.html");
  assert.equal(count(model, "<form"), 1, "one form");
  const formStart = model.indexOf('<form id="settingsForm"');
  const formEnd = model.indexOf("</form>");
  assert.ok(formStart > 0 && formEnd > formStart);
  const form = model.slice(formStart, formEnd);
  for (const g of ["voice", "memory", "time", "pictures", "calls", "songs", "money", "system"]) assert.ok(form.includes('id="group-' + g + '"'), "group-" + g);
  const buttons = Array.from(form.matchAll(/<button[^>]*>/g)).map((m) => m[0]);
  const submits = buttons.filter((b) => /type="submit"/.test(b));
  assert.equal(submits.length, 4, "Save and the three card Saves");
  for (const b of buttons) assert.ok(/type="(button|submit)"/.test(b), b);
  assert.equal(count(model, "data-save-status"), 3);
  assert.ok(/<div class="save-bar"><button type="submit" class="btn primary" id="saveBtn">Save<\/button><span class="chips" id="settings-status"><\/span><\/div>/.test(model), "the sticky save bar");
  const system = form.slice(form.indexOf('id="group-system"'));
  assert.ok(/<details class="advanced">/.test(system) && !/<details class="advanced" open/.test(model), "System sits in a closed Advanced");
  const images = read("images.html");
  assert.ok(images.includes('<button type="button" role="tab" data-tab="places">Places</button>'));
  for (const id of ["tab-places", "placesAdmin", "placeTitle", "placeDetail", "placeAdd", "placeAddStatus"]) assert.ok(images.includes('id="' + id + '"'), "#" + id);
  const timeline = read("timeline.html");
  assert.ok(/<label class="switch" for="logToggle"><input type="checkbox" id="logToggle"><span class="track"><\/span><span class="switch-label">Show the log<\/span><\/label>/.test(timeline));
});

// ------------------------------------------------------------ fonts

const FONTS = [
  ["fonts/fraunces-latin-full-normal.woff2", 121016, "7e744849028e2219e2aa1bc467dc4032980dc4487c9c3da3010081cd72d3b103"],
  ["fonts/fraunces-latin-full-italic.woff2", 149720, "04a14ea380db53a35a3ec651934b21061234685bb604d30aac82663b5d9e539b"],
  ["fonts/instrument-sans-latin-wght-normal.woff2", 30092, "2ee17598a98d8a59e4df8152d015bec9ab8e4d5672cc0ab42bef806b568e3971"],
];

test("the three woff2 files are the checked bytes; the two OFL licences sit beside them", () => {
  for (const [rel, bytes, sha] of FONTS) {
    const buf = readFileSync(join(PUBLIC, rel));
    assert.equal(buf.subarray(0, 4).toString("latin1"), "wOF2", rel);
    assert.equal(buf.length, bytes, rel);
    assert.equal(createHash("sha256").update(buf).digest("hex"), sha, rel);
  }
  for (const [rel, sha] of [["fonts/OFL-Fraunces.txt", "cd3384cafac6f2bddc3955273958a2e029f97027c8037ac539ef5744a77b579e"], ["fonts/OFL-InstrumentSans.txt", "c27a3c53c3beed7f5c26853afa15991478ff7145d3754a36b0382f84e10c0d03"]]) {
    assert.ok(existsSync(join(PUBLIC, rel)), rel);
    const text = readFileSync(join(PUBLIC, rel));
    assert.equal(createHash("sha256").update(text).digest("hex"), sha, rel);
    assert.ok(!BAD_TYPOGRAPHY.test(text.toString("utf8")), rel);
  }
});

test("app.css: the three @font-face rules, Fraunces as --display, Instrument Sans first in --sans", () => {
  const faces = Array.from(css.matchAll(/@font-face\s*\{([^}]*)\}/g)).map((m) => m[1]);
  assert.equal(faces.length, 3);
  const want = [
    ['"Fraunces"', "/fonts/fraunces-latin-full-normal.woff2", "normal", "100 900"],
    ['"Fraunces"', "/fonts/fraunces-latin-full-italic.woff2", "italic", "100 900"],
    ['"Instrument Sans"', "/fonts/instrument-sans-latin-wght-normal.woff2", "normal", "400 700"],
  ];
  for (const [family, url, style, weight] of want) {
    const f = faces.find((x) => x.includes(url));
    assert.ok(f, url);
    assert.ok(f.includes("font-family: " + family) && f.includes("font-style: " + style) && f.includes("font-weight: " + weight) && f.includes("font-display: swap") && f.includes("unicode-range: U+0000-00FF"), url);
  }
  assert.equal(token("--display"), '"Fraunces", var(--serif)');
  assert.ok(/^"Instrument Sans",/.test(token("--sans") || ""), "--sans starts with Instrument Sans");
});

// ------------------------------------------------------------ tokens and the one accent

const NEW_TOKENS = {
  "--ink": "#03060c", "--night": "#070b16", "--deep": "#0a1224",
  "--glass": "rgba(12, 18, 34, 0.62)", "--glass-strong": "rgba(9, 14, 28, 0.82)", "--glass-edge": "rgba(150, 190, 255, 0.10)", "--glass-blur": "20px",
  "--shadow-1": "0 8px 30px rgba(0, 0, 0, 0.35)", "--shadow-2": "0 24px 80px rgba(0, 0, 0, 0.55)",
  "--glow": "0 0 28px rgba(34, 211, 238, 0.28)", "--glow-soft": "0 0 64px rgba(34, 211, 238, 0.10)",
  "--radius-l": "22px", "--radius-xl": "32px", "--fs-5": "28px", "--fs-6": "40px", "--fs-clock": "clamp(84px, 24vw, 128px)",
  "--dur-1": "160ms", "--dur-2": "280ms", "--dur-3": "700ms", "--tabbar-h": "58px",
  "--backdrop-filter": "blur(28px) brightness(0.42) saturate(1.15)",
  "--lock-veil": "linear-gradient(180deg, rgba(4, 7, 14, 0.18) 0%, rgba(4, 7, 14, 0.18) 55%, rgba(4, 7, 14, 0.40) 72%, rgba(4, 7, 14, 0.74) 100%)",
  "--lock-shade": "rgba(4, 7, 14, 0.62)", "--polaroid": "#0e1628", "--her-name": "#f4f7fc",
  "--bubble-hers": "linear-gradient(160deg, #16304c 0%, #123341 100%)",
  "--bubble-his": "linear-gradient(160deg, #22457f 0%, #1a386e 100%)",
  "--avatar-ring": "0 0 0 2px rgba(3, 6, 12, 0.9), 0 0 0 3.5px rgba(34, 211, 238, 0.85), 0 0 22px rgba(34, 211, 238, 0.35)",
};

test("app.css: every token of 2.1 with its value; the one accent and no second; no gradient text and no WONK anywhere", () => {
  assert.ok(rootBlock, ":root block");
  for (const [name, value] of Object.entries(NEW_TOKENS)) assert.equal(token(name), value, name);
  assert.equal(token("--accent-solid"), "#22d3ee");
  const accents = Array.from(rootBlock[1].matchAll(/(--accent[a-z0-9-]*):/g)).map((m) => m[1]).sort();
  assert.deepEqual(accents, ["--accent", "--accent-dim", "--accent-ring", "--accent-solid"], "no accent token added");
  assert.ok(!/background-clip:\s*text/.test(css), "no background-clip: text");
  assert.ok(!/"WONK" 1/.test(css), 'no "WONK" 1');
  const wordmark = RULES.filter((r) => r.selectors.includes(".wordmark"));
  assert.ok(wordmark.length && wordmark.every((r) => !/gradient|drop-shadow/.test(r.body)), "her name is plain type");
  assert.ok(wordmark.some((r) => /color: var\(--her-name\)/.test(r.body) && /font-family: var\(--display\)/.test(r.body)));
});

test("app.css: the backdrop, the veil, glass painted by ::before on the header and the chat bar, the lock shade, the focus-within rule, the global reduced-motion rule last", () => {
  const backdrop = RULES.find((r) => r.selectors.includes(".backdrop"));
  assert.ok(backdrop && /filter: var\(--backdrop-filter\)/.test(backdrop.body) && /position: fixed/.test(backdrop.body) && /opacity: 0/.test(backdrop.body));
  assert.ok(RULES.some((r) => r.selectors.includes(".backdrop.ready") && /opacity: 1/.test(r.body)));
  assert.ok(RULES.some((r) => r.selectors.includes("body::after") && /position: fixed/.test(r.body) && /rgba\(13, 23, 48, 0\.55\)/.test(r.body)), "the veil, top stop 0.55");
  for (const sel of ["header.top::before", ".thread-bar::before"]) assert.ok(RULES.some((r) => r.selectors.includes(sel) && /backdrop-filter: blur\(var\(--glass-blur\)\)/.test(r.body)), sel + " paints the glass");
  // The containing-block trap: nothing that holds the fixed tab bar or a sheet may carry these.
  for (const sel of ["header.top", ".top", ".thread-bar"]) {
    for (const r of RULES.filter((x) => x.selectors.includes(sel))) assert.ok(!/(^|[;\s])(backdrop-filter|-webkit-backdrop-filter|filter|transform)\s*:/.test(r.body), sel + " { " + r.body.trim().slice(0, 80) + " }");
  }
  assert.ok(RULES.some((r) => r.selectors.includes(".lock-top::before") && /var\(--lock-shade\)/.test(r.body)), ".lock-top::before on --lock-shade");
  assert.ok(css.includes("body.page-chat:has(#composer:focus-within) .nav"), "the tab bar steps aside while he types");
  const lastMedia = css.lastIndexOf("@media");
  const tail = css.slice(lastMedia).replace(/\s+/g, " ").trim();
  assert.equal(tail, "@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; } }");
  for (const kf of ["rise", "dot", "breathe", "sheet-in", "lock-in", "settle", "heart-pop"]) assert.ok(new RegExp("@keyframes " + kf + "\\s*\\{").test(css), "@keyframes " + kf);
});

// ------------------------------------------------------------ the class vocabulary (section 9)

const SHELL = [".nav-icon", ".nav-label", ".studio-link", ".studio-nav", ".avatar.ring", ".avatar.hero", ".backdrop", ".backdrop.ready", ".glass", ".glass.strong", ".sheet", ".display", ".display.xl", ".kicker", ".rise", ".page-head", ".row.center", ".empty-label", "body.studio", "body.page-us"];
const CHAT = [".chapters", ".chapter-row", ".chapter-row.active", ".chapter-open", ".chapter-title", ".chapter-when", ".chapter-preview", ".chapter-head", ".chapter-name", ".chapter-edit", ".chapter-date", ".empty-her", ".her-who", ".her-who-text", ".her-name", ".place-line", ".tools-sheet", ".tool-row", ".tool-sep", ".tool-kicker", ".tool-switch", ".tool-status", ".scene-sheet", ".day-sep", ".rec-bar", ".rec-dot", ".rec-time", ".icon-btn.send", "body.her-typing", ".react-bar", ".react-btn", ".react-keep", '.react-keep[aria-checked="true"]', ".kept-mark", ".photo-open", ".pic-failed", ".lightbox-decide"];
const PHONE = [".phone-stage", ".phone-shell", ".lock", ".lock-wallpaper", ".lock-veil", ".lock-top", ".lock-top::before", ".lock-date", ".lock-time", ".lock-meta", ".lock-weather", ".np-card", ".np-title", ".np-artist", ".np-progress", ".lock-stack", ".notif", '.notif[data-app="calendar"]', ".notif-head", ".notif-app", ".notif-when", ".notif-title", ".notif-text", ".roll-strip", ".roll-thumb", ".roll-thumb.clip", ".home-handle", ".home", ".home-wallpaper", ".home-grid", ".home-dock", ".app", ".app-icon", ".app-name", ".app-screen", ".app-bar", ".app-title", ".app-body", ".place-list", ".map-place", ".note-line", ".note-title", ".note-next", ".sent-song", ".photo-grid"];
const ALBUM = [".gallery-section", ".us-row", ".gallery", ".gallery.edge", ".roll-tile", ".roll-tile.clip", ".month-hero", ".month-over", ".cap-date", ".cap-place", ".play-badge", "img.loaded", "video.loaded", ".lightbox", ".lightbox-media", ".lightbox-cap", ".lightbox-actions", ".lb-close", ".lb-prev", ".lb-next"];
const US = [".us-page", ".us-hero", ".us-standing", ".us-since", ".us-names", ".us-section", ".chapter-list", ".chapter-card", ".moments", ".moment", ".moment-when", ".moment-title", ".places-together", ".place-together", ".place-together .place-thumb", ".place-name", ".place-first", ".place-times", ".kept-quotes", ".kept-quote", ".kept-text", ".kept-when"];
const STUDIO = [".studio-tabs", ".tab-group", ".tab-group-label", ".human-fields", "details.advanced", ".studio-settings", ".group-index", ".group-index a.active", ".studio-group", ".group-title", ".setting-block", ".block-title", ".setting", ".setting-hint", ".save-bar", ".story-line", ".story-when", ".story-text"];
// Pinned by ui_v4 and ui_v5: restyled, never dropped.
const KEPT = [".map", ".map-water", ".map-land", ".map-dot", ".map-dot.here", ".map-label", ".dial", ".dial-track", ".dial-fill", ".polaroid", ".drawer", ".msg-avatar", "#callFace", ".thread::before", ".beat-row", ".view-row", ".artist-row", ".song-feedback", ".chip.guess", "#clockChip"];

function hasSelector(sel) {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(esc + "(?![\\w-])").test(css);
}

test("app.css defines every class of section 9 and keeps every pinned selector", () => {
  for (const sel of [...SHELL, ...CHAT, ...PHONE, ...ALBUM, ...US, ...STUDIO, ...KEPT]) assert.ok(hasSelector(sel), "selector " + sel);
  assert.ok(/background-image:\s*var\(--place-veil\),\s*var\(--place-url\)/.test(css));
  assert.ok(/\.drawer:not\(\.open\) \{ visibility: hidden;/.test(css));
  assert.ok(/\.playlist-embed, \.spotify-embed \{[^}]*border: 0/.test(css));
});

test("rule 4: no bare .who, .quiet, .envelope, .us or .place-thumb rule (each already means something else)", () => {
  for (const bare of [".who", ".quiet", ".envelope", ".us", ".place-thumb"]) {
    const hit = RULES.find((r) => r.selectors.includes(bare));
    assert.ok(!hit, "a bare " + bare + " rule");
  }
  assert.ok(!/(^|\n)\.who \{|(^|\n)\.quiet \{|(^|\n)\.envelope \{|(^|\n)\.us \{/.test(css));
});

test("--muted is never used by a rule of a Her page (it measures 3.80 over the veil)", () => {
  const herClasses = [...CHAT, ...PHONE, ...ALBUM, ...US]
    .map((s) => (/^[.#]?[a-z]/.test(s) ? s : s))
    .flatMap((s) => Array.from(s.matchAll(/\.([a-z][\w-]*)/g)).map((m) => m[1]))
    // place-thumb is Studio's (.place-row); the Us page reaches it only through .place-together.
    .filter((c) => !["active", "clip", "edge", "loaded", "send", "icon-btn", "place-thumb"].includes(c));
  const classRe = new RegExp("\\.(" + Array.from(new Set(herClasses)).map((c) => c.replace(/-/g, "\\-")).join("|") + ")(?![\\w-])");
  for (const r of RULES) {
    if (!/var\(--muted\)/.test(r.body)) continue;
    for (const s of r.selectors) {
      assert.ok(!/^body\.page-(chat|phone|album|us)\b/.test(s), "Her page rule uses --muted: " + s);
      assert.ok(!classRe.test(s), "a Her class uses --muted: " + s);
    }
  }
});

test("the contrast table of 2.5, recomputed from the tokens; --text-2 on the lock shade fails and is never used inside .lock-top", () => {
  const c = (name) => hexRgb(token(name));
  const white = [255, 255, 255];
  const bright = over([0, 0, 0, 0], [Math.round(255 * 0.42), Math.round(255 * 0.42), Math.round(255 * 0.42)]);
  const veilRule = RULES.find((r) => r.selectors.includes("body::after"));
  const veilTop = rgbaOf(/radial-gradient\([^,]+,\s*(rgba\([^)]+\))/.exec(veilRule.body)[1]);
  const onVeil = over(veilTop, bright);
  assert.deepEqual(onVeil, [55, 61, 75], "the veil's top over the brightest backdrop pixel");
  const glass = over(rgbaOf(token("--glass")), onVeil);
  const strongWhite = over(rgbaOf(token("--glass-strong")), white);
  const shadeWhite = over(rgbaOf(token("--lock-shade")), white);
  const veilBand = over([4, 7, 14, 0.74], white);
  assert.ok(token("--lock-veil").includes("rgba(4, 7, 14, 0.74) 100%"), "the lock veil's bottom band");
  const hers = Array.from(token("--bubble-hers").matchAll(/#[0-9a-f]{6}/g)).map((m) => hexRgb(m[0]));
  const his = Array.from(token("--bubble-his").matchAll(/#[0-9a-f]{6}/g)).map((m) => hexRgb(m[0]));
  const rows = [
    ["--text on --bg", c("--text"), c("--bg"), 4.5],
    ["--text-2 on --bg", c("--text-2"), c("--bg"), 4.5],
    ["--muted on --panel", c("--muted"), c("--panel"), 4.5],
    ["--muted on --panel-2", c("--muted"), c("--panel-2"), 4.5],
    ...hers.map((h, i) => ["--text on her bubble stop " + i, c("--text"), h, 4.5]),
    ...his.map((h, i) => ["--text on his bubble stop " + i, c("--text"), h, 4.5]),
    ["--accent-solid on --bg", c("--accent-solid"), c("--bg"), 4.5],
    ["--ink on --accent-solid", c("--ink"), c("--accent-solid"), 3],
    ["--ink on #14b8a6", c("--ink"), hexRgb("#14b8a6"), 3],
    ["--text on the veil", c("--text"), onVeil, 4.5],
    ["--text-2 on the veil", c("--text-2"), onVeil, 4.5],
    ["--text-2 on --glass over the veil", c("--text-2"), glass, 4.5],
    ["--text on --glass-strong over white", c("--text"), strongWhite, 4.5],
    ["--text-2 on --glass-strong over white", c("--text-2"), strongWhite, 4.5],
    ["--her-name on --lock-shade over white", c("--her-name"), shadeWhite, 4.5],
    ["lock text on the lock veil's bottom band", c("--her-name"), veilBand, 4.5],
    ["--text on --polaroid", c("--text"), c("--polaroid"), 4.5],
    ["--text-2 on --polaroid", c("--text-2"), c("--polaroid"), 4.5],
    ["focus --accent-solid on --panel-2", c("--accent-solid"), c("--panel-2"), 3],
  ];
  assert.equal(hers.length, 2);
  assert.equal(his.length, 2);
  for (const [label, fg, bg, floor] of rows) {
    const r = ratio(fg, bg);
    assert.ok(r >= floor, label + ": " + r.toFixed(2) + " < " + floor);
  }
  assert.ok(Math.abs(ratio(c("--text"), onVeil) - 9.0) < 0.05, "9.00 as the table says");
  assert.ok(Math.abs(ratio(c("--her-name"), shadeWhite) - 5.41) < 0.05, "5.41 as the table says");
  const fails = ratio(c("--text-2"), shadeWhite);
  assert.ok(fails < 4.5, "--text-2 on the lock shade must stay below AA: " + fails.toFixed(2));
  for (const r of RULES) {
    if (r.selectors.some((s) => /\.lock-top\b/.test(s))) assert.ok(!/var\(--text-2\)|var\(--muted\)/.test(r.body), "inside .lock-top: " + r.selectors.join(", "));
  }
  for (const sel of [".lock-date", ".lock-time", ".lock-meta", ".lock-weather"]) {
    assert.ok(RULES.some((x) => x.selectors.includes(sel) && /color: var\(--her-name\)/.test(x.body)), sel + " is --her-name");
  }
});

test("the smallest text is --text-2 on a Her page; every text field is 16px or more at phone width", () => {
  const phone = /@media \(max-width: 760px\) \{([\s\S]*?)\n\}/.exec(css.slice(css.indexOf("/* 760 and under: the phone.")));
  assert.ok(phone, "the 760 block");
  assert.ok(/input\[type="text"\][^{]*select, textarea \{ font-size: 16px; \}/.test(phone[1]), "text fields at 16px");
  assert.ok(/\.composer-box textarea \{[^}]*font-size: 16px/.test(css), "the composer at 16px");
  assert.ok(/\.nav \{[^}]*position: fixed;[^}]*bottom: 0;[^}]*height: calc\(var\(--tabbar-h\) \+ var\(--safe-b\)\)/.test(phone[1]), "the bottom tab bar");
  assert.ok(/\.page \{ padding-bottom: calc\(var\(--tabbar-h\) \+ var\(--safe-b\) \+ 16px\); \}/.test(phone[1]), "pages clear the tab bar");
  assert.ok(/body\.page-chat \.brand, body\.page-chat \.studio-link, body\.page-phone \.brand, body\.page-phone \.studio-link \{ display: none; \}/.test(phone[1]));
});

// ------------------------------------------------------------ nav.js and sw.js

test("nav.js: the exports of 2.8, the wallpaper read, the crop through the CSSOM, the studio door and row", () => {
  for (const name of ["export const LINKS", "export const STUDIO_LINKS", "export const STUDIO_HOME = \"/state\"", "export function isStudioPath", "export const NAV_ICONS", "export function mountBackdrop", "export function mountAvatar", "export function avatarImg", "export function avatarFocus"]) assert.ok(nav.includes(name), name);
  const icons = /export const NAV_ICONS = \{([\s\S]*?)\};/.exec(nav);
  assert.ok(icons, "NAV_ICONS");
  for (const key of ['"/"', '"/phone"', '"/album"', '"/us"', "studio"]) assert.ok(new RegExp("\\n\\s*" + key.replace(/[/"]/g, "\\$&") + ":\\s*\"M").test(icons[1]), "icon " + key);
  assert.ok(nav.includes('fetch("/api/wallpaper"'), "GET /api/wallpaper");
  assert.ok(/hasAttribute\("data-manual"\)/.test(nav), "data-manual leaves the backdrop to the page");
  assert.ok(/classList\.add\("ready"\)/.test(nav), ".ready on load");
  assert.ok(/\.style\.objectPosition\s*=/.test(nav), "objectPosition through the CSSOM");
  assert.ok(!/setAttribute\(\s*["']style["']/.test(nav), "no style attribute");
  assert.ok(/"nav-icon"/.test(nav) && /"nav-label"/.test(nav), "icon plus label");
  assert.ok(/"studio-link"/.test(nav) && /"studio-nav"/.test(nav) && /classList\.add\("studio"\)/.test(nav), "the Studio door, row and body class");
  assert.ok(/setAttribute\("aria-current", "page"\)/.test(nav), "aria-current on the active link");
  assert.ok(/classList\.add\("ring"\)/.test(nav), "the header avatar wears the ring");
  assert.ok(/\nmountBackdrop\(\);\nmountAvatar\(\);\s*$/.test(nav), "mountBackdrop() then mountAvatar() at load");
});

test("sw.js: avelie-shell-v4, the shell of 10.1, the fonts cache-first, /api and /media never cached", () => {
  assert.ok(/const CACHE = "avelie-shell-v4"/.test(sw));
  for (const u of ["/", "/phone", "/album", "/us", "/memory", "/js/us.js", "/js/lockwords.js", "/js/months.js", "/fonts/fraunces-latin-full-normal.woff2", "/fonts/instrument-sans-latin-wght-normal.woff2"]) assert.ok(sw.includes('"' + u + '"'), "shell " + u);
  assert.ok(/const FONTS = "\/fonts\/";/.test(sw));
  assert.ok(/url\.pathname\.startsWith\(FONTS\)[\s\S]{0,200}caches\.match\(request, \{ ignoreSearch: true \}\)/.test(sw));
  assert.ok(/url\.pathname\.startsWith\("\/api\/"\) \|\| url\.pathname\.startsWith\("\/media\/"\)\) return;/.test(sw));
  assert.ok(/\/api\/push\/latest/.test(sw));
});
