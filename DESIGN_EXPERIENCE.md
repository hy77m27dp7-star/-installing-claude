# Avelie -- the experience pass: Her and Studio (design brief and build contract)

Written 2026-09-26 on branch `exp` at 7051696 (the live v5 head), every file, route, id, class and test named below read from that tree. Same ground rules as SPEC.md to SPEC_V5.md: typography " -- " and "..." only (`node scripts/check_typography.mjs` clean), no secret anywhere, TypeScript strict, the Workers runtime only in src/, vanilla HTML, CSS and JS, one stylesheet (public/css/app.css), the CSP in src/index.ts unchanged (no `style=` attribute, no inline script, run-time values through the CSSOM only), dark overall with blues and ONE accent (`--accent`, the teal-to-cyan gradient, solid `--accent-solid #22d3ee`), nothing lightened, no second accent, phone width first, WCAG AA, visible focus, no prose in the UI (labels only), never an edit to src/generated/*, canon/constitution/* or public/images/masters/*, no migration (none is needed; 0010 does not exist after this pass), nothing with `--remote`, no deploy, no push, no commit except where a lane is told. Avelie is her own product; nothing here names anything else of his.

## 0. Why this pass exists

Justin, 2026-09-26: "this UI sucks"; "why is the phone section so lame"; 8:55pm: "can u sexy up my UI while youre at it somehow. still seems too botty".

The audit of the live app with her real data found one root cause: every page was built as a back office in a nicer skin, and the pages meant to feel like her show the machinery.

- Chat is decent but cluttered with developer controls: why / note / keep under every message of hers, the Together and Texting toggle, Let her start, the call, photos and phone buttons in the bar, the paperclip, mic and taste in the composer, chats named "chat Sep 24".
- Phone is a report of her internals: "Wearing --", mood "fresh 5d 23h ago", one want at 0%, an empty map card because no place has coordinates.
- Album shows one picture, because her other approved photos were made without a message and the album reads only message-bound rows.
- Memory shows empty "none" boxes, "MUSIC X4 sealed" and a system log as "kept today".
- State is a database editor with twelve tabs and raw JSON; Model is ninety knobs in one column; Timeline is an engineering log ("scene v33: together, proposal p_0b32...").

"Botty", read literally: boxes with borders everywhere, chips and labels on everything, grids of cards, form fields, admin spacing, system fonts, flat panels.

The fix he approved: split the app in two. HER is the experience (Chat, Phone, Album, Us), designed experience-first. STUDIO is the writer's room (Record, Settings, Pictures, Timeline, Memory), honest tools in the same visual language. Then look at every page with her data before calling it done (section 12).

What this pass is not: no change to who she is. No prompt byte moves (`PROMPT_VERSION`, `CONSTITUTION_VERSION`, `stablePrefix()` untouched), no new setting, no new secret, no new cron, no new origin, no migration. Every new route reads the story and writes none of it, except one rename.

## 1. The feeling (the brief)

A beautiful late-night phone. A fashion magazine meets iMessage at 2am: intimate, editorial, dark, quiet. Her face is the light source of the app. Things float on glass over her photographs instead of sitting in boxes. Type has a voice: a sharp, high-contrast display serif (not soft, not cute) for her name, headings, dates and the lock-screen clock; a clean, warm sans for everything you read. Her name is plain near-white type, never a glowing gradient wordmark (that is the stock AI-product look). Space is generous. Motion is slow and small, the way a phone screen breathes at night. There is almost nothing to read that is not hers or yours.

Screen by screen, what it must feel like before anything else:

- Chat: you are texting her. Her avatar glows at the top, her name in the display face, one small line under it says where the two of you are ("together at the record store", "texting"). Behind the thread, a soft, dark, blurred photograph of her (or of the place, when you are there together). Bubbles are round and generous; hers carry a faint deep-teal gradient; yours are deep blue. Her pictures sit in the thread as pictures, nothing under them; a tap opens them full-screen. Nothing else on screen. Every tool of the writer is one quiet icon away, and keeping a line of hers is a heart, the way you would react to a text.
- Phone: you picked up her phone. A lock screen with her wallpaper full-bleed, Portland time huge in the display face, the date and her weather under it, a few real notifications (your last text to her, the song she sent, what is on her calendar), a strip of her last pictures. Swipe up and her apps are there: Maps with her places, Notes with the things she wants, Photos, and Messages and Music in the dock.
- Album: her camera roll, full-bleed. Each month opens on its newest picture edge to edge with the month set over it in the display face; the rest in a tight edge-to-edge grid. The pictures of the two of you gathered at the top under "Us". Tap and it opens full-screen with the date and the place.
- Us: the story of the two of you, set like a magazine feature. Where you stand and since when, the chapters, the moments that mattered, the places you have been, the lines of hers you kept, her names for each other. Nothing about what she has on file about you, no reads of you, no subjects of her secrets. No numbers.
- Studio: a clean, honest tool in the same dark glass. Grouped by what each thing does for her. Labels, not paragraphs. Raw JSON only behind "Advanced".

## 2. The visual system (design lane, public/css/app.css)

### 2.1 Tokens

Every existing `:root` token stays (the v4 tests pin `--avatar-size: 36px`, `--avatar-size-lg: 56px`, `--avatar-ring:`, `--bubble-hers:`, `--bubble-his:`, `--bubble-max: 78%`, `--fs-0: 12px` to `--fs-4: 21px`, `--s-1: 4px` to `--s-6: 32px`, `--place-veil: linear-gradient(180deg, rgba(6, 10, 19, 0.86)`, `--dial-track:`, `--dial-fill:`, `--safe-b:`, and `--accent-solid: #22d3ee`). Values may change only where this list says so. Added:

```
--ink: #03060c;                 /* the deepest ground, text on the accent */
--night: #070b16;
--deep: #0a1224;
--glass: rgba(12, 18, 34, 0.62);        /* a floating panel over a photograph */
--glass-strong: rgba(9, 14, 28, 0.82);  /* notifications, sheets, the composer */
--glass-edge: rgba(150, 190, 255, 0.10);/* the one hairline: an inset top highlight, never a border */
--glass-blur: 20px;
--shadow-1: 0 8px 30px rgba(0, 0, 0, 0.35);
--shadow-2: 0 24px 80px rgba(0, 0, 0, 0.55);
--glow: 0 0 28px rgba(34, 211, 238, 0.28);
--glow-soft: 0 0 64px rgba(34, 211, 238, 0.10);
--display: "Fraunces", var(--serif);
--radius-l: 22px;
--radius-xl: 32px;
--fs-5: 28px;
--fs-6: 40px;
--fs-clock: clamp(84px, 24vw, 128px);
--dur-1: 160ms; --dur-2: 280ms; --dur-3: 700ms;
--tabbar-h: 58px;
--backdrop-filter: blur(28px) brightness(0.55) saturate(1.15);
--lock-veil: linear-gradient(180deg, rgba(4, 7, 14, 0.18) 0%, rgba(4, 7, 14, 0.18) 55%, rgba(4, 7, 14, 0.40) 72%, rgba(4, 7, 14, 0.74) 100%);   /* the lower screen only; the top block carries its own shade (4.2) */
--lock-shade: rgba(4, 7, 14, 0.62);     /* behind .lock-top, anchored to that block, never to a screen percentage */
--polaroid: #0e1628;
--her-name: #f4f7fc;
```

Changed values: `--sans` becomes `"Instrument Sans", -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif`; `--bubble-hers` becomes `linear-gradient(160deg, #16304c 0%, #123341 100%)` (deep blue into deep teal, used as `background`); `--bubble-his` becomes `linear-gradient(160deg, #22457f 0%, #1a386e 100%)`; `--avatar-ring` becomes `0 0 0 2px rgba(3, 6, 12, 0.9), 0 0 0 3.5px rgba(34, 211, 238, 0.85), 0 0 22px rgba(34, 211, 238, 0.35)` (the glowing ring). No other `--accent*` token is added (the v4 test rejects any `accent-2` or `second`). Blues are the ground; the teal-to-cyan is the only accent and it appears in exactly these places (never on her name, never as gradient text): the focus ring, the avatar ring and glow, the send button, the active nav mark, links, switches on, the typing dots, the lock-screen home handle, the Keep heart when pressed. Nothing else is cyan.

### 2.2 Type

Two OFL families, self-hosted, no outside host, CSP untouched (`default-src 'self'` covers fonts). The files are already downloaded and checked in this session's scratchpad (npm pack of `@fontsource-variable/fraunces@5.3.0` and `@fontsource-variable/instrument-sans@5.3.0`); the design lane COPIES them, it does not add a dependency:

| Copy from (scratchpad/fontcheck/...) | To | Bytes | sha256 |
|---|---|---|---|
| fontsource-variable-fraunces-5.3.0/package/files/fraunces-latin-full-normal.woff2 | public/fonts/fraunces-latin-full-normal.woff2 | 121016 | 7e744849028e2219e2aa1bc467dc4032980dc4487c9c3da3010081cd72d3b103 |
| fontsource-variable-fraunces-5.3.0/package/files/fraunces-latin-full-italic.woff2 | public/fonts/fraunces-latin-full-italic.woff2 | 149720 | 04a14ea380db53a35a3ec651934b21061234685bb604d30aac82663b5d9e539b |
| fontsource-variable-instrument-sans-5.3.0/package/files/instrument-sans-latin-wght-normal.woff2 | public/fonts/instrument-sans-latin-wght-normal.woff2 | 30092 | 2ee17598a98d8a59e4df8152d015bec9ab8e4d5672cc0ab42bef806b568e3971 |
| fontsource-variable-fraunces-5.3.0/package/LICENSE | public/fonts/OFL-Fraunces.txt | | cd3384cafac6f2bddc3955273958a2e029f97027c8037ac539ef5744a77b579e |
| fontsource-variable-instrument-sans-5.3.0/package/LICENSE | public/fonts/OFL-InstrumentSans.txt | | c27a3c53c3beed7f5c26853afa15991478ff7145d3754a36b0382f84e10c0d03 |

The scratchpad root is `/private/tmp/claude-501/-Users-justinnewsome-Documents-ClaudeCode-HQ/e5dcbc67-4480-4c1c-bdb2-d7e749c0c830/scratchpad`. If the folder is gone, `npm pack <package>@5.3.0` in a temporary directory outside the repo gives the same bytes (check the sha256). Both licenses are typography clean (checked: no em dash, en dash or Unicode ellipsis). The `.woff2` files are not scanned by check_typography.mjs (binary extension); the `.txt` licenses are and pass.

```
@font-face { font-family: "Fraunces"; src: url("/fonts/fraunces-latin-full-normal.woff2") format("woff2"); font-weight: 100 900; font-style: normal; font-display: swap; unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD; }
@font-face { font-family: "Fraunces"; src: url("/fonts/fraunces-latin-full-italic.woff2") format("woff2"); font-weight: 100 900; font-style: italic; font-display: swap; unicode-range: (same); }
@font-face { font-family: "Instrument Sans"; src: url("/fonts/instrument-sans-latin-wght-normal.woff2") format("woff2"); font-weight: 400 700; font-style: normal; font-display: swap; unicode-range: (same); }
```

Every page head gains, after the stylesheet link: `<link rel="preload" href="/fonts/fraunces-latin-full-normal.woff2" as="font" type="font/woff2" crossorigin>` and the same for `instrument-sans-latin-wght-normal.woff2` (the italic loads on demand). Both "full" Fraunces files carry every axis (wght, opsz, SOFT, WONK), so the italic dates match the roman they sit beside; the "wght" italic has no SOFT or opsz axis and is not used. sw.js serves `/fonts/` cache-first (section 2.9), so the fonts download once per device, not on every page.

Scale and use (the settings are editorial, not storybook: SOFT 0 to 30, WONK 0 everywhere, weights 300 to 380, `font-optical-sizing: auto` so the large sizes draw at display contrast):
- Her name (the `.wordmark` in the header and `.her-name` in the chat bar): Fraunces, sentence case "Avelie" (the wordmark text changes from "AVELIE" to "Avelie"), 24px header / 19px bar, weight 380, `font-variation-settings: "SOFT" 0, "WONK" 0`, letter-spacing 0.005em, `color: var(--her-name)` (#f4f7fc). No gradient, no glow, no `background-clip: text` anywhere in the app: the accent lives on her avatar ring beside the name, not in it.
- Display headings (`.display`): Fraunces, weight 340, SOFT 20, WONK 0, `--fs-5` on phone, `--fs-6` at 1280 for page titles (`.display.xl`, weight 300), letter-spacing -0.01em, `--text`.
- Kicker labels (`.kicker`): Instrument Sans 600, 11px, uppercase, letter-spacing 0.14em, `--text-2`.
- Dates and small captions (`.cap-date`, `.chapter-date`, `.lock-date`): Fraunces italic 15px, weight 360, SOFT 30, `--text-2`.
- Lock clock (`.lock-time`): Fraunces, `--fs-clock`, weight 300, SOFT 0, WONK 0, `font-variant-numeric: lining-nums tabular-nums`, letter-spacing -0.03em, color `--her-name`.
- Body and bubbles: Instrument Sans 400, 16px on phone (bubbles 16px, line-height 1.38), 15px in Studio; labels 13px 500. Every text field (the composer, the chapter rename, the place input, Studio inputs) is at least 16px at 760 and under: iOS zooms the page on focus into a smaller field.
- Numbers in Studio tables: `--mono` as today.

### 2.3 Surfaces: glass, not boxes

- `.glass`: `background: var(--glass); backdrop-filter: blur(var(--glass-blur)) saturate(140%); -webkit-backdrop-filter: (same); border: 0; border-radius: var(--radius-l); box-shadow: inset 0 1px 0 var(--glass-edge), var(--shadow-1);`. `.glass.strong` uses `--glass-strong`.
- No `border:` on any Her-side surface (bubbles, cards, notifications, sheets, picture tiles). Separation comes from depth (shadow), tone and space. Studio may keep 1px `--line` rules inside tables only.
- `.card` (used everywhere in Studio) is restyled as a quiet surface: `background: rgba(12, 19, 34, 0.72); border: 0; box-shadow: inset 0 1px 0 var(--glass-edge); border-radius: var(--radius-l);`.
- CONTAINING-BLOCK TRAP: an element with `backdrop-filter`, `filter` or `transform` becomes the containing block of its `position: fixed` descendants. The header at phone width holds the fixed bottom tab bar (the nav), so the header's own glass is painted by `header.top::before` (the pseudo-element carries the backdrop-filter), never by `header.top` itself. The same rule for any element that contains a fixed sheet. In the chat, the glass of `.thread-bar` is painted by `.thread-bar::before`, AND the two sheets that used to live inside it (`#moreMenu`, `#placesPop`) move to body level beside `#photosDrawer` (section 3.3), so neither can be pinned inside the 60px bar. No ancestor of a fixed sheet carries `backdrop-filter`, `filter` or `transform`; ui_exp checks the `.thread-bar {` and `header.top {` rules for all three.

### 2.4 The backdrop (her photograph behind the page)

`<img class="backdrop" id="backdrop" alt="" aria-hidden="true" decoding="async">` sits first in `body` on index.html, phone.html and us.html. CSS: `position: fixed; inset: -40px; width: calc(100% + 80px); height: calc(100% + 80px); object-fit: cover; filter: var(--backdrop-filter); z-index: -2; pointer-events: none; opacity: 0; transition: opacity var(--dur-3) var(--ease);` and `.backdrop.ready { opacity: 1; }`; `body::after` paints the veil above it (`position: fixed; inset: 0; z-index: -1; background: radial-gradient(120% 70% at 50% 0%, rgba(13, 23, 48, 0.55), rgba(4, 7, 14, 0.5) 60%, rgba(3, 6, 12, 0.75));`; the top stop is 0.55, not 0.35, because the chapter head and its date are drawn straight on this veil without glass; the day separators and the run times sit on small `--glass` pills; her action lines (a bubble that is only `*...*`, no ground) sit on the 0.5 middle stop, see 2.5). The visual fix pass raised the brightness from 0.42 to 0.55 and lowered the middle stop from 0.6 to 0.5 so her photograph reads behind the thread. The body keeps its dark radial ground under both, so a page without a picture is still the v4 night. The source is set by script (`img.src`), and the crop of a master by the CSSOM (`img.style.objectPosition`), never by markup.

nav.js fills `#backdrop` from `GET /api/wallpaper` at load unless the element carries `data-manual` (index.html does: the chat sets it itself, because a together scene at a pictured place shows the place). The script adds `.ready` on the image's `load` event and leaves the image empty on any failure.

### 2.5 Contrast (computed, WCAG 2.x relative luminance; the design lane re-runs them in ui_exp.test.mjs)

| Pair | Ratio | Need |
|---|---|---|
| `--text` #e3eaf6 on `--bg` #060a13 | 16.37 | 4.5 |
| `--text-2` #b9c4d8 on `--bg` | 11.27 | 4.5 |
| `--muted` #8d99b2 on `--panel` #0c1322 | 6.48 | 4.5 |
| `--muted` on `--panel-2` #111b30 | 5.99 | 4.5 |
| `--text` on her bubble, both stops #16304c / #123341 | 11.12 / 11.02 | 4.5 |
| `--text` on his bubble, both stops #22457f / #1a386e | 7.80 / 9.47 | 4.5 |
| `--accent-solid` on `--bg` (links, focus) | 10.96 | 4.5 |
| `--ink` on `--accent-solid` / on #14b8a6 (the send icon on the gradient) | 11.22 / 8.15 | 3 |
| `--text` / `--text-2` straight on the backdrop veil at its TOP stop (0.55) over the brightest backdrop pixel (white after brightness 0.55 = rgb(140), under the veil = rgb(70, 76, 89)): the chapter head, the chapter date | 7.12 / 4.90 | 4.5 |
| `--text-2` on the veil's MIDDLE stop (0.5) over that pixel (rgb(72, 74, 77)): her action lines | 5.06 | 4.5 |
| `--text-2` on `--glass` over the veil's top (rgb(34, 40, 55)): the day separators and the run times on their pills | 8.38 | 4.5 |
| `--text` / `--text-2` on `--glass-strong` over pure white (rgb(53, 57, 69)) | 9.53 / 6.56 | 4.5 |
| lock text `--her-name` #f4f7fc on `--lock-shade` (0.62, behind `.lock-top`) over pure white (rgb(99, 101, 106)) | 5.41 | 4.5 |
| `--text-2` on `--lock-shade` over pure white | 3.31 (FAILS: never used there) | 4.5 |
| lock text on the bottom band of `--lock-veil` (0.74, rgb(69, 71, 77)) | 8.60 | 4.5 |
| `--text` / `--text-2` on `--polaroid` #0e1628 (Studio frames) | 14.92 / 10.27 | 4.5 |
| focus ring `--accent-solid` on `--panel-2` | 9.50 | 3 |

Rules that keep them true: the smallest text (`--fs-0`) uses `--text-2`, never `--muted`; `--muted` is NEVER used on a Her page (no rule whose selector starts with `body.page-chat`, `body.page-phone`, `body.page-album`, `body.page-us`, or names a class of section 9's Chat, Phone, Album or Us lists, uses `var(--muted)`; over the veil's top it measures 3.80, a fail); in Studio `--muted` only on opaque surfaces at 13px or more; any text over a photograph sits on `--glass`, `--glass-strong`, the `--lock-shade` block or the bottom band of `--lock-veil`. The lock veil is anchored to the content, not to screen percentages: `.lock-top::before` paints `--lock-shade` behind the whole date / clock / weather block (inset -24px top, -16px sides, and a 48px fade to transparent below it), so on any phone height the text sits on 0.62; every text inside `.lock-top` is `--her-name` (never `--text-2`), and it all carries `text-shadow: 0 1px 12px rgba(0, 0, 0, 0.5)` (the clock `0 2px 24px rgba(0, 0, 0, 0.45)`). ui_exp recomputes every row above, including the one that must stay unused.

### 2.6 Motion (all of it off under `prefers-reduced-motion: reduce`)

- Message arrival: `.msg.rise` plays `rise` (opacity 0 -> 1, translateY(8px) scale(0.985) -> none, `--dur-2`, `--ease`). The existing `@keyframes rise` name stays.
- Typing dots: three 7px accent dots, `@keyframes dot` (translateY 0 -> -4px -> 0 and opacity 0.4 -> 1 -> 0.4), 1.2s, delays 0 / 0.15s / 0.3s.
- Her avatar while she types: `body.her-typing .her-who .avatar` plays the existing `breathe` (the glow swells, 2.4s ease-in-out infinite).
- Lock screen: `.lock` fades in (opacity 0 -> 1, `--dur-3`) and its wallpaper settles (`scale(1.06)` -> `scale(1)`, 1.2s); notifications rise in one after another (`animation-delay` by `:nth-child`, 60ms steps, pure CSS).
- Sheets (`.sheet`) slide up 14px and fade (`--dur-2`); the lightbox fades (`--dur-2`); the reaction bar (`.react-bar`) scales from 0.9 and fades in `--dur-1` above the bubble it belongs to; the Keep heart pops once (scale 1 -> 1.25 -> 1, `--dur-2`) when pressed.
- Album images fade in when loaded (`img.loaded` set by album.js on `load`; `opacity` transition `--dur-3`).
- The one global switch, last in the file:

```
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
}
```

### 2.7 Icons

Line icons, inline SVG, `stroke="currentColor"`, 1.7px, round caps and joins, 24 viewBox, in markup (html) or built with `document.createElementNS` (nav.js, page scripts). No icon font, no image icons besides public/icons (the app icons, untouched).

### 2.8 The shell (every page)

Markup, unchanged from v4 except the wordmark text and the preloads (the v4 test counts each once):

```
<header class="top">
  <a class="brand" href="/" aria-label="Avelie, home">
    <img class="avatar" id="avatar" alt="" width="36" height="36" decoding="async">
    <span class="wordmark">Avelie</span>
  </a>
  <nav class="nav" aria-label="Sections"></nav>
</header>
```

public/js/nav.js (design lane) builds the rest:

```
export const LINKS = [["/", "Chat"], ["/phone", "Phone"], ["/album", "Album"], ["/us", "Us"]];
export const STUDIO_LINKS = [["/state", "Record"], ["/model", "Settings"], ["/images", "Pictures"], ["/timeline", "Timeline"], ["/memory", "Memory"]];
export const STUDIO_HOME = "/state";
export function isStudioPath(pathname): boolean   // normalize(pathname) is one of STUDIO_LINKS' paths
export const NAV_ICONS = { "/": "<d>", "/phone": "<d>", "/album": "<d>", "/us": "<d>", studio: "<d>" }  // SVG path data strings
export function mountBackdrop(img?)               // fills #backdrop from GET /api/wallpaper (section 2.4)
// unchanged: AVATAR_FOCUS, avatarFocus, mountAvatar, avatarImg, DEFAULT_FOCUS = [50, 30], "avelie.avatar", GET /api/avatar, master-05 default
```

- The `.nav` loop (`document.querySelectorAll(".nav")`, kept as the nav_v4 test reads it) builds one `a` per LINKS entry: `<a href><svg class="nav-icon" aria-hidden="true">...</svg><span class="nav-label">Chat</span></a>`, `.active` plus `aria-current="page"` on the current one. On a Studio page no Her link is active.
- It appends once, inside `header.top` after the nav, `<a class="studio-link" href="/state" aria-label="Studio"><svg class="nav-icon" aria-hidden="true">(sliders)</svg><span class="nav-label">Studio</span></a>`, `.active` plus `aria-current="page"` on Studio pages.
- On a Studio page it adds `body.studio` and inserts, right after `header.top`, `<nav class="studio-nav" aria-label="Studio">` with one `a` per STUDIO_LINKS entry, the current one `.active` with `aria-current="page"`.
- `mountAvatar()` still runs last at load (the nav_v4 regex `\nmountAvatar\(\);\s*$` stays true: put `mountBackdrop()` before it). The header image gets the `ring` class.

Widths:
- 1280 (and anything over 760): the header is a 64px glass bar (glass painted by `::before`), brand left, the four Her links centred-right as icon plus label, `a.studio-link` at the far right as icon plus label, separated from the Her links by 24px of air (no rule). Studio pages add the 48px `.studio-nav` row under it, links as quiet text with the accent underline on the active one.
- 390 (760 and under): the header is 56px with the brand left and `a.studio-link` right (icon only, the label visually hidden, the aria-label stays). The `.nav` becomes the bottom tab bar: `position: fixed; left: 0; right: 0; bottom: 0; height: calc(var(--tabbar-h) + var(--safe-b)); padding-bottom: var(--safe-b);` glass (`::before`), four equal items, icon over a 11px label, the active item in `--text` with a 4px accent dot under the icon, the rest `--text-2`. `main` pages get `padding-bottom: calc(var(--tabbar-h) + var(--safe-b) + 16px)`. On `body.page-chat` and `body.page-phone` the header's brand and studio link are hidden at this width (the chat bar and the lock screen carry her face); the header keeps only the fixed tab bar. `.studio-nav` on a Studio page at this width is one horizontally scrollable row (no scrollbar, scroll-snap). The tab bar also shows on Studio pages.
- While the composer has focus on the chat page, the tab bar steps aside: `body.page-chat:has(#composer:focus-within) .nav { display: none; }` and the composer drops its tab-bar margin (same selector). `:focus-within` on the form, not `#input:focus`, so pressing Send (which takes the focus from the textarea) does not bring the bar back under his thumb. Engines without `:has` keep the bar; nothing breaks.
- 16px side gutters (`--gutter`), no horizontal page scroll at 375, tap targets at least 44px, the sticky header and the tab bar clear of the safe areas.

### 2.9 Caching (what downloads once, what downloads every time)

`harden()` in src/index.ts sets `cache-control: private, no-store` on every response and stays as it is (index.ts is frozen in this pass). The Cache API ignores that header, so the service worker is where caching happens:
- sw.js (design lane) gains `const FONTS = "/fonts/";` served cache-first exactly like `MASTERS` (the same `caches.match(request, { ignoreSearch: true })` then network-and-put branch). The two preloads and the italic then cost nothing after the first visit, and `font-display: swap` no longer flashes the system face on every page (the lock clock does not reflow). The file names carry no version, so a font change ships with a new file name and a new `CACHE` name.
- `/media/` stays never cached (ui_v4 pins it, and candidates change approval in place). Instead, the Her pages ask for fewer pictures per screen: the lock roll strip 6, the Photos app 12, the Album 24 per page (`More` loads the next 24), the Us page at most 6 place thumbnails. The backdrop and the lock wallpaper are the same daily picture, so the browser's in-memory image cache serves the second use on the same page.
- Named, not built (section 14): a narrow `harden` exception (`private, max-age=31536000, immutable` for `/fonts/` and for approved photo ids under `/media/`), which needs index.ts unfrozen and a check that a rejected picture is never served from a cache.

## 3. HER: Chat (public/index.html by the design lane, public/js/chat.js by the chat lane)

### 3.1 Feel

A messaging app and nothing else. Her photograph blurred and dark behind everything. At the top her face in its glowing ring, her name, and one line of place. The chapter title sits at the head of the thread like a chapter opening in a book, and it is also where you rename it. Every tool of the writer lives behind one icon.

### 3.2 Layout

390:
```
[chat bar, glass (::before), 60px + safe top]  (=) chapters | (avatar 40, ring) Avelie / together at the record store | (...) tools
[thread, full width, bubbles max 78%]
   The record store          <- .chapter-head: display 28px, tap to rename
   Saturday, Sep 26           <- .chapter-date, italic
   ...day separators "Today", "Friday" as small kicker text centred...
   [her picture, rounded, nothing under it]   <- tap: the lightbox
[composer, glass-strong pill]  ( Message ............ ) (send)
[tab bar]                      Chat  Phone  Album  Us   (hidden while the composer has focus)
```
1280:
```
[global header 64px: brand | Chat Phone Album Us | Studio]
[chapters rail 320px, glass] [thread column, centred, max 760px]
                                [chat bar inside the column: avatar, name, place line, tools]
                                [thread]
                                [composer]
```
The chapters rail at 390 is the existing slide-in drawer (`#sidebar`, opened by `#openDrawer`), glass-strong, full height. The bar's glass is `.thread-bar::before` (2.3).

### 3.3 Markup contract (index.html; design lane writes it exactly, chat lane binds these ids)

Kept ids (same element role): `sidebar`, `closeDrawer`, `newChat`, `convList`, `openDrawer`, `convTitle` (now the chapter name button at the head of the thread), `sceneTogether`, `sceneApart`, `placesPop`, `placesList`, `placeInput`, `placeNeeded`, `placeCancel`, `placeSet`, `letHerStart`, `callBtn`, `photosBtn`, `moreBtn`, `moreMenu`, `timingToggle`, `operatorToggle`, `clockChip`, `thread`, `typing`, `nowPlaying` (and its inner `npTitle`, `npArtist`, `npProgress`, `npTime`, `npPause`, `npNext`), `composer`, `errorRow`, `errorChip`, `retryBtn`, `lockRow`, `attachStrip`, `attachBtn`, `fileInput`, `input`, `micBtn`, `tasteBtn`, `sendBtn`, `scrim`, `photosDrawer`, `photosClose`, `photosList`, `callSheet`, `callStatus`, `callReason`, `callTimer`, `callFace`, `callCaptions`, `callMute`, `callEnd`, `callAudio`, `whyDrawer`, `whyClose`, `whyBody`.

Removed: `phoneBtn`, `phoneDrawer`, `phoneDrawerBody`, `phoneClose` (the Phone is its own page). New: `backdrop`, `whoAvatar`, `placeLine`, `chapterHead`, `chapterEdit`, `chapterDate`, `recBar`, `recTime`, `recCancel`, `recSend`, `toolStudio`, and the chat's own lightbox (the Album's markup and ids, 5.3, plus the three decide buttons): `lightbox`, `lbClose`, `lbPrev`, `lbNext`, `lbMedia`, `lbDate`, `lbPlace`, `lbSave`, `lbOpen`, `lbDecide`, `lbKeep`, `lbReject`, `lbAgain`.

Moved: `#moreMenu` and `#placesPop` are no longer inside `.thread-bar`; they sit at body level after `#scrim` (ids unchanged), so no glass or transform on the bar can become their containing block.

```
<body class="page-chat">
<img class="backdrop" id="backdrop" alt="" aria-hidden="true" decoding="async" data-manual>
<header class="top"> (the shell) </header>
<main class="chat">
  <aside class="sidebar chapters glass strong" id="sidebar" aria-label="Chapters">
    <div class="sidebar-head">
      <h2 class="display">Chapters</h2>
      <button type="button" class="icon-btn" id="newChat" aria-label="New chapter">(plus)</button>
      <button type="button" class="icon-btn phone-only" id="closeDrawer" aria-label="Close">(x)</button>
    </div>
    <ul class="conv-list" id="convList"></ul>
  </aside>
  <section class="thread-wrap">
    <div class="thread-bar">
      <button type="button" class="icon-btn phone-only" id="openDrawer" aria-controls="sidebar" aria-expanded="false" aria-label="Chapters">(lines)</button>
      <div class="her-who">
        <img class="avatar ring" id="whoAvatar" alt="" width="40" height="40" decoding="async" data-avatar="her">
        <div class="her-who-text">
          <span class="her-name">Avelie</span>
          <button type="button" class="place-line" id="placeLine" aria-haspopup="dialog" aria-controls="placesPop" aria-expanded="false"></button>
        </div>
      </div>
      <button type="button" class="icon-btn" id="moreBtn" aria-label="Tools" aria-haspopup="dialog" aria-expanded="false" aria-controls="moreMenu">(dots)</button>
    </div>
    <div class="thread" id="thread" aria-live="polite">
      <header class="chapter-head" id="chapterHead" aria-live="off">
        <button type="button" class="chapter-name" id="convTitle"></button>
        <input type="text" class="chapter-edit hidden" id="chapterEdit" maxlength="80" aria-label="Chapter name">
        <span class="chapter-date" id="chapterDate"></span>
      </header>
      <div class="typing hidden" id="typing" aria-label="Typing"><span></span><span></span><span></span></div>
    </div>
    (the #nowPlaying strip exactly as today)
    <form class="composer" id="composer" autocomplete="off">
      (#errorRow with #errorChip and #retryBtn, #lockRow, as today)
      <div class="attach-strip hidden" id="attachStrip"></div>
      <div class="rec-bar hidden" id="recBar" role="status"><span class="rec-dot" aria-hidden="true"></span><span class="rec-time" id="recTime">0:00</span><button type="button" class="btn small ghost" id="recCancel">Cancel</button><button type="button" class="btn small primary" id="recSend">Send</button></div>
      <div class="composer-box">
        <input type="file" id="fileInput" class="hidden" accept="image/jpeg,image/png,image/webp" multiple aria-label="Photos to send">
        <textarea id="input" rows="1" placeholder="Message" maxlength="4000" aria-label="Message"></textarea>
        <button type="submit" class="icon-btn send" id="sendBtn" aria-label="Send">(arrow up)</button>
      </div>
    </form>
  </section>
</main>
<div class="scrim hidden" id="scrim"></div>
<div class="sheet tools-sheet hidden" id="moreMenu" role="dialog" aria-label="Tools">
  <button type="button" class="tool-row" id="callBtn" aria-pressed="false">(phone)<span>Call her</span></button>
  <button type="button" class="tool-row" id="letHerStart">(spark)<span>Let her start</span></button>
  <button type="button" class="tool-row" id="attachBtn">(image)<span>Send a photo</span></button>
  <button type="button" class="tool-row" id="micBtn" aria-pressed="false">(mic)<span>Voice note</span></button>
  <button type="button" class="tool-row" id="photosBtn" aria-controls="photosDrawer" aria-expanded="false">(stack)<span>Her pictures</span></button>
  <div class="tool-sep" role="separator"></div>
  <p class="kicker tool-kicker">Writer</p>
  <button type="button" class="tool-row hidden" id="tasteBtn">(fork)<span>Taste two</span></button>
  <label class="switch tool-switch" for="timingToggle"><input type="checkbox" id="timingToggle" checked><span class="track"></span><span class="switch-label">Human timing</span></label>
  <label class="switch tool-switch" for="operatorToggle"><input type="checkbox" id="operatorToggle"><span class="track"></span><span class="switch-label">Show the workings</span></label>
  <span class="tool-status hidden" id="clockChip" role="status"></span>
  <a class="tool-row" id="toolStudio" href="/state">(sliders)<span>Studio</span></a>
</div>
<div class="sheet scene-sheet hidden" id="placesPop" role="dialog" aria-label="Where">
  <div class="seg" role="group" aria-label="Scene">
    <button type="button" id="sceneTogether" aria-pressed="false">Together</button>
    <button type="button" id="sceneApart" aria-pressed="false">Texting</button>
  </div>
  <div class="places" id="placesList"></div>
  <input type="text" id="placeInput" placeholder="Where" maxlength="200" aria-label="Where">
  <span class="tool-status hidden" id="placeNeeded" role="status">place needed</span>
  <div class="row end">
    <button type="button" class="btn small ghost" id="placeCancel">Cancel</button>
    <button type="button" class="btn small primary" id="placeSet">Together</button>
  </div>
</div>
<div class="lightbox hidden" id="lightbox" role="dialog" aria-modal="true" aria-label="Picture">
  (lbClose, lbPrev, lbMedia, lbNext and the .lightbox-cap with lbDate and lbPlace exactly as album.html, 5.3)
  <div class="lightbox-actions"><a class="btn ghost" id="lbSave">Save</a><a class="btn ghost" id="lbOpen" target="_blank" rel="noopener">Full size</a></div>
  <div class="lightbox-decide hidden" id="lbDecide"><button type="button" class="btn ghost" id="lbKeep">Keep</button><button type="button" class="btn ghost" id="lbReject">Not her</button><button type="button" class="btn ghost" id="lbAgain">Again</button></div>
</div>
(#photosDrawer, #callSheet, #whyDrawer exactly as today)
<script type="module" src="/js/nav.js"></script>
<script type="module" src="/js/chat.js"></script>
```

The tools sheet: a bottom sheet with the scrim at 760 and under (CSS only; chat.js clears any inline position there); over 760 a popover whose `top` and `right` chat.js sets through the CSSOM from `#moreBtn.getBoundingClientRect()` each time it opens (`top` = the button's bottom + 8px, `right` = `innerWidth` - the button's right). `#placesPop` is placed the same way from `#placeLine`. Everything under the "Writer" kicker is the writer's, not hers: tasting, timing, the workings, the held-clock line and the Studio door, below her own actions.

### 3.4 Behaviour (chat lane)

1. Chapters. `GET /api/conversations` answers `ConversationView[]` (section 8.2). `convLabel(c)` is `c.displayTitle` (falling back to the stored title, then to the date words, never "chat " plus a date). Each row is `<li class="chapter-row"><button type="button" class="chapter-open"><span class="chapter-title">The record store</span><span class="chapter-when">Sep 26</span><span class="chapter-preview">that was sweet by the way</span></button></li>`, `.active` on the open one; the preview is `c.preview.text` (his lines prefixed "You: "), one line, clipped by CSS. "New chapter" (`#newChat`) posts with no title, as today.
2. The chapter head. `#convTitle` shows `displayTitle` (its `aria-label` set to the title plus ", rename"); `#chapterDate` the first day in words ("Saturday, Sep 26"). After a turn lands in a chapter whose title is not his, the list is re-read once, so a new chapter takes its automatic title as soon as it has one. A tap swaps it for `#chapterEdit` (the value is the stored title, or empty when the title is automatic, placeholder the displayTitle); Enter or blur saves `PUT /api/conversations/:id { title }` (empty string sends `null`: back to the automatic title), Escape cancels. On success the head, the rail row and `state.conversations` take the answer. `loadThread()` keeps `#chapterHead` as the thread's first child and `#typing` as its last (today it clears the thread and re-appends only the dots); the head carries `aria-live="off"`, so renaming it or re-appending it is not announced by the thread's polite region. A thread with no messages shows the head and, under it, her avatar at 96px with the ring, centred (`.empty-her`); nothing else.
3. The place line. `#placeLine` text from the scene: together with a location -> "together at " plus the location with a leading "at " or "in " removed ("together at the record store"); together without a location -> "together"; apart -> "texting"; unknown -> empty and hidden. Its tap opens `#placesPop` (the scene sheet: the Together / Texting pair, the place buttons, the input, Cancel, Together) with the existing `openPlaces()` and `setScene()` flow and the v5 400 "place needed" path.
4. The one menu. `#moreBtn` opens `#moreMenu` (3.3); Escape and the scrim close it and focus returns to `#moreBtn`. Every row closes the sheet, then acts: `#callBtn` starts the call as today (the row is hidden when today's rule hides the Call button); `#letHerStart` as today (hidden when today's rule hides it); `#attachBtn` opens `#fileInput`; `#micBtn` starts a recording (tap, not hold): `#recBar` replaces the composer box with a pulsing accent dot and `#recTime`, `#recSend` stops and sends through the existing `sendVoice`, `#recCancel` discards, the 60 s cap stops and sends; `#photosBtn` opens `#photosDrawer`; `#tasteBtn` (shown only when tastings are on, as today) sends the typed text as a tasting and is disabled while the input is empty; the two switches keep their storage keys; `#clockChip` shows the held-clock words while held (today's `renderClock`), as a status line, not a chip.
5. Reacting to her line (the Keep mark, without the workings). On any bubble of hers that has an id: a double-click / double-tap, a long press (450 ms, cancelled by 10px of movement), the `contextmenu` event, or Enter / Space on the focused bubble (her bubbles carry `tabindex="0"` and `aria-haspopup="menu"`) opens ONE `.react-bar` (a small `glass strong` pill, `role="menu"`, above the bubble, below it when there is no room): a heart button (`.react-btn.react-keep`, `role="menuitemcheckbox"`, `aria-checked` from the mark, `aria-label` "Keep"; pressed = the accent heart), a "note" text button and a "why" text button (`.react-btn`). The heart uses the routes `markButton` uses today: pressed on a line that is not kept, it sets the mark `keep`; pressed on a kept line, it clears the mark (the existing DELETE). "Drop" stays in the workings row only (the heart never drops); note opens today's note sheet; why opens today's `#whyDrawer`. Escape, a tap outside or any choice closes the bar and focus returns to the bubble. A kept bubble shows a small accent heart at its lower corner (`.kept-mark`, `aria-label` "kept"), in both modes, so the marks he makes stay visible and keep feeding the voice data.
6. The workings. With `#operatorToggle` off (off at every page load, as today), under her messages there is NO why / note / keep row, no flag chips, no Spotify status chip, no `us` chip and no picture controls: the default thread is only the conversation (and the `.kept-mark` hearts). With it on, `metaRow` shows why, note, keep and the flags exactly as today, the song status chip returns, a picture shows its status chips and the Approve / Reject / Regenerate row as today (`photoActions`), and the operator channel rows load as today. The v5 song buttons "know it" and "not for me" stay visible in both modes, as quiet text buttons under the song card (they are his taste, not machinery).
7. Her pictures in the thread (`renderPhoto`, `renderClip`). Workings off: the picture (or the clip with its poster) in a rounded frame and NOTHING under it: no "Open full size" / "Save" link row, no `us` chip, no Approve / Reject / Regenerate. A tap (or Enter on the focused picture, which is a `button`, `aria-label` "Open picture") opens the chat's `#lightbox`: the image, or the clip with `controls autoplay playsinline`; `#lbDate` and `#lbPlace` as the Album does; `#lbSave` `/media/<id>?download=1`; `#lbOpen` `/media/<id>`; the arrows walk the pictures of the open chapter. While the picture is not yet approved, `#lbDecide` shows three quiet words: `#lbKeep` (approve), `#lbReject` ("Not her": reject) and `#lbAgain` (regenerate), each calling exactly the route `photoActions` calls today; after a decision the row hides and the thread picture updates. Focus is trapped while open and returns to the picture. `photoActions` (the builder of the "Approve" text) is called only under `state.operator`; the lightbox path builds its own three buttons from the markup.
8. Failures read as words, not codes. A picture or clip that failed shows, in place of the picture, a quiet line "didn't come through" with a retry icon button (`.icon-btn`, `aria-label` "Try again", the existing regenerate or retry call); the error code chips appear only with the workings on. `showError(code, retry)` sets `#errorChip` to `errorWords(code)`, a small pure map in chat.js: `budget_exceeded`, `tasting_budget_exceeded`, `price_unknown` -> "Today's limit reached"; `in_progress`, `idempotency_conflict`, `tasting_pending` -> "Still on the last one"; `provider_failed`, `provider_refused`, `provider_not_configured`, `image_failed`, `internal`, `error`, and anything unknown that looks like a code (lowercase with an underscore) -> "Didn't come through"; `validation`, `too_large`, `unsupported_media_type` -> "Couldn't send that"; a local label chat.js already writes in words ("8 MB max", "jpeg, png or webp", "max 4 photos", "4 MB max") passes through unchanged, and "microphone" becomes "Microphone is off". With the workings on, the raw code follows the words in the same chip ("Didn't come through -- provider_failed").
9. The thread. Runs, avatars and run timestamps as in v4; `.day-sep` rows between days ("Today", "Yesterday", weekday within six days, else "Sep 20"); every newly arrived message gets `.rise`; `body.her-typing` is set while `#typing` is visible. The song card keeps its v4 embed slot and play event (`h("div", { class: "song-embed hidden" })` and `new CustomEvent("avelie:play", { detail: { uri, target: embed } })`, both pinned by ui_v4) and `import "./player.js";` stays. `artistNorm` stays byte-for-byte (review_v5 "ui 6" evaluates it).
10. The backdrop. `#backdrop` shows the place picture when the scene is together at a place that has one (`/media/place/<id>`, today's lookup in `applyPlaceBackground`), otherwise her wallpaper (`GET /api/wallpaper`, section 8.4, `url`, and `focus` through `style.objectPosition`); `.ready` on load. chat.js no longer writes `--place-url` on the thread (app.css keeps the v4 rule so the v4 test still reads it).
11. Remove the phone slide-in code (`openPhone`, `PHONE_IDS`, the phone drawer in `drawers()`), the hold-to-record pointer handling (replaced by 4), and every reference to the removed ids. Keep every `els` entry optional-safe as today. The class names chat.js uses for the bar are `her-who`, `her-who-text`, `her-name`; the existing `span.who` of the call transcript and "his version" is untouched and its rules in app.css stay as they are.

### 3.5 Data

`GET /api/conversations` (changed, 8.2), `PUT /api/conversations/:id` (new, 8.3), `GET /api/wallpaper` (new, 8.4); everything else as today (`/api/conversations/:id/messages`, `/turn`, `/open`, `/voice`, `/api/state/scene`, `/api/places`, `/api/clock`, `/api/known-artists`, `/api/assets`, `/api/settings`...).

### 3.6 Empty data

No conversation: the page opens on an empty chapter (head with the day title, her avatar); the first send creates the conversation as today. No scene: the place line is hidden. No wallpaper answer: no backdrop, the night gradient shows.

## 4. HER: Phone (public/phone.html by the design lane, public/js/phone.js, public/js/map.js and the new public/js/lockwords.js by the phone lane)

### 4.1 Feel

You picked up her phone. Her lock screen: her photograph full-bleed, the time huge in the display face, the date and the weather small above and below it. A few real notifications on dark glass, each one a thing on the record (your last text to her, the song she sent you, what is on her calendar), never a narrator's line dressed up as a text. A strip of her last pictures. A soft handle at the bottom: tap it or swipe up and her apps are there. Nothing on this page is a report, and nothing empty is ever shown.

### 4.2 Layout

390: the lock screen fills the viewport from the top to the tab bar (the header's brand and studio link hide on this page at this width, 2.8); the wallpaper is `object-fit: cover`; the top block (date, clock, weather) on its own `--lock-shade` (`.lock-top::before`, 2.5), whatever the screen height; the lower screen under `--lock-veil` (`.lock-veil`); the notification stack below the clock with 16px gutters; the roll strip above the handle; the handle 44px tall, a 120x5px accent-tinted pill.

1280: `main.phone-stage` centres one device: `.phone-shell` 400px wide, `height: min(860px, calc(100dvh - 112px))`, `border-radius: 48px`, `overflow: hidden`, `box-shadow: inset 0 0 0 1px var(--glass-edge), var(--shadow-2), var(--glow-soft)`. The page `#backdrop` (filled by nav.js with the same wallpaper) glows blurred around it. Everything inside the device is the 390 layout.

Views inside the shell (one visible at a time, by the hash; `lockwords.js appFromHash`):
- `#lock` (no hash, or `#lock`): the lock screen.
- `#home` (`#home`): her apps over her wallpaper blurred (`filter: blur(18px) brightness(0.5)`): a 4-column grid of 64px glass rounded-square icons with 12px labels near the top (Maps, Notes, Photos), and a glass dock at the bottom above the handle (`.home-dock`, one rounded bar, 16px inset) with Messages (a link to "/") and Music, the two she lives in. An app whose data is empty is not shown (Maps always shows: the city outline is never empty; Messages always shows).
- `#appScreen` (`#maps`, `#notes`, `#music`, `#photos`): one app full-screen with `.app-bar` (back to `#home`, the app name in the display face).
Swipe: a vertical pointer drag of 80px or more upward on `#lock` opens `#home`; downward on `#home` returns to `#lock`; the handle buttons do the same for keyboard and taps. `.lock` and `.home` set `touch-action: none` (so the drag is not a page scroll) and `.lock-stack` and `.roll-strip` set `touch-action: pan-y` and `pan-x`. History entries follow the hash, so Back works.

### 4.3 Markup contract (phone.html; the old ids `phoneStatus`, `phoneNow`, `phoneWhere`, `phoneWeather`, `phoneOutfit`, `phoneMood`, `phoneWants`, `phoneAsks`, `phoneToday`, `phoneListening`, `phoneMap`, `placesStatus`, `mapFoot`, `placeTitle`, `placeDetail`, `placeAdd`, `placeAddStatus` are gone; `placesList` moves into the Maps app and is built by phone.js)

```
<body class="page-phone">
<img class="backdrop" id="backdrop" alt="" aria-hidden="true" decoding="async">
<header class="top"> (the shell) </header>
<main class="phone-stage">
  <div class="phone-shell" id="phoneShell">
    <section class="lock" id="lock" aria-label="Her lock screen">
      <img class="lock-wallpaper" id="wallpaper" alt="" decoding="async">
      <div class="lock-veil" aria-hidden="true"></div>
      <div class="lock-top">
        <div class="lock-date" id="lockDate"></div>
        <div class="lock-time" id="lockTime"></div>
        <div class="lock-meta"><span class="lock-weather" id="lockWeather"></span></div>
      </div>
      <div class="np-card hidden" id="lockPlaying" aria-live="polite"></div>
      <ol class="lock-stack" id="lockStack" aria-label="Notifications"></ol>
      <div class="roll-strip hidden" id="rollStrip" aria-label="Her pictures"></div>
      <button type="button" class="home-handle" id="openHome" aria-label="Her apps"><span aria-hidden="true"></span></button>
    </section>
    <section class="home hidden" id="home" aria-label="Her apps">
      <img class="home-wallpaper" id="homeWallpaper" alt="" decoding="async">
      <div class="home-grid" id="homeGrid">
        <a class="app" href="#maps" data-app="maps"><span class="app-icon">(map)</span><span class="app-name">Maps</span></a>
        <a class="app" href="#notes" data-app="notes"><span class="app-icon">(note)</span><span class="app-name">Notes</span></a>
        <a class="app" href="#photos" data-app="photos"><span class="app-icon">(flower)</span><span class="app-name">Photos</span></a>
      </div>
      <nav class="home-dock" id="homeDock" aria-label="Dock">
        <a class="app" href="/" data-app="messages"><span class="app-icon">(bubble)</span><span class="app-name">Messages</span></a>
        <a class="app" href="#music" data-app="music"><span class="app-icon">(note glyph)</span><span class="app-name">Music</span></a>
      </nav>
      <button type="button" class="home-handle" id="closeHome" aria-label="Lock"><span aria-hidden="true"></span></button>
    </section>
    <section class="app-screen hidden" id="appScreen" aria-labelledby="appTitle">
      <div class="app-bar"><button type="button" class="icon-btn" id="appBack" aria-label="Back">(chevron)</button><h2 class="app-title" id="appTitle"></h2></div>
      <div class="app-body" id="appBody"></div>
    </section>
  </div>
</main>
<script type="module" src="/js/nav.js"></script>
<script type="module" src="/js/phone.js"></script>
```

### 4.4 The lock screen (phone lane)

Data: `GET /api/phone/lock` (section 8.5), refreshed every 60 s while the page is visible. The clock follows HER clock, not the wall: the answer carries `now` (the story instant, `storyNow` of her clock) and `frozen` (a together scene is held). While `frozen` is false the page ticks the time and the date locally every 15 s from the offset `Date.parse(now) - Date.now()` measured at the read, with `Intl.DateTimeFormat` in `tz` (`h:mm`, no am/pm, like a phone; the date "Saturday, September 26"), so the time is never stale between reads; while `frozen` is true the time and date stay exactly as answered (a held scene does not move on her phone either), and the next read picks up the resume. The calendar day words come from the server on the same clock (8.5), so "Tomorrow" never contradicts a scene he has moved to the next day.

- `#wallpaper` and `#homeWallpaper`: `wallpaper.url`, `style.objectPosition` from `wallpaper.focus` when set (a master), else `50% 30%`.
- `#lockWeather`: `68° clear` (the degree sign; `units` celsius gives the C value); hidden when `weather` is null.
- No status line. (The relationship `mood` field is an author or extractor word about her feeling toward him, "annoyed" or worse, not her words; it stays in Studio.)
- `#lockPlaying`: while player.js reports a track playing (`avelie:player` events, as phone.js listens today; `import "./player.js";` stays, ui_v4 pins it), a glass card: a note glyph, the track name, the artist, a thin accent progress line, pause and next controls dispatching the existing `avelie:pause` / `avelie:next` events. Hidden otherwise.
- `#lockStack`: one `<li class="notif" data-app="messages|music|calendar">` per `notes` entry, in the server's order: `<div class="notif-head"><span class="notif-app">(glyph) Messages</span><time class="notif-when">2h</time></div><div class="notif-title">Justin</div><div class="notif-text">see ya tomorrow starbrite</div>`. App names: messages "Messages", music "Music", calendar "Calendar". `.notif-title` is left out when `title` is empty. When words (`lockwords.whenWords(at, nowMs)`, `nowMs` = the story now): "now" under a minute, "12m", "3h", "yesterday", a weekday within six days, else "Sep 20"; a calendar entry shows its `title` ("Tomorrow") and no time. No stack when `notes` is empty.
- `#rollStrip`: the `roll` items (at most 6, never a picture of the two of you: the server filters them, 8.5), 48px, radius 12, each a link to `/album#<id>`; a clip shows its `poster` with a play glyph over it (no `<video>` element in the strip), and a clip with no poster is left out of the strip; hidden when `roll` is empty.

### 4.5 Her apps (phone lane)

- Maps (`#maps`): `GET /api/phone` for `map` and `places` (unchanged shape), drawn by map.js `drawMap` full-width in the app body (the v4 SVG, restyled by app.css: the land in `--deep`, the water in `--night` with a faint blue line, her places as accent dots with a soft glow, the one she is at pulsing). Only places WITH stored coordinates appear, as dots with their names (the name in a small glass label on tap, and in `#placesList` under the map as a plain list of names, class `place-list`, each row `.map-place` with the title only; tapping a row pulses its dot). No unplaced rows, no "Pin", no "Place", no approximate rings, no add form, no geocode and no picture buttons: placing a place is a writer's job and lives in Studio > Pictures > Places (section 7.4). When no place has coordinates the map shows the city alone and the list is not drawn.
- Notes (`#notes`): `lock.wants` as an Apple-Notes-like list: `<article class="note-line"><h3 class="note-title">sing at an open mic</h3><p class="note-next">Thursday -- sign up at the bar</p></article>`; `note-next` only when `next` exists (the day word, " -- ", the step title). No percent, no bars, no status words. The app icon is hidden when `wants` is empty.
- Music (`#music`, in the dock): the listening line from `GET /api/phone` `listening` ("stuck in my head since the shop", the song and artist under it, a play control dispatching `avelie:play` with the Spotify search uri as today); "Sent to you": `GET /api/sent` items of kind `song` (label as the title line, the day word); her playlist from `GET /api/spotify` when connected (the v4 embed or an "Open" link, as phone.js does today). The app icon is hidden when all three are empty.
- Photos (`#photos`): `GET /api/roll?limit=12` as a 3-column square grid (2px gaps, no frames; a clip shows its `poster` with the play glyph, or is left out when it has none), each opening `/album#<id>`; an "All" link to `/album` in the app bar. Hidden when the roll is empty.

public/js/lockwords.js (phone lane, pure, no DOM, importable in node):
```
export function appFromHash(hash: string): "lock" | "home" | "maps" | "notes" | "music" | "photos"   // anything else is "lock"
export function whenWords(iso: string, nowMs: number): string                                       // section 4.4
export function weatherWords(w: { temp: number; units: string; words: string } | null): string      // "68° clear", "" for null
export function tickOffset(storyNowIso: string, wallMs: number): number                             // Date.parse(storyNowIso) - wallMs, 0 when unreadable
export const APP_NAMES: Record<"messages" | "music" | "calendar", string>
```

### 4.6 Empty data

The wallpaper always exists (a master when she has no approved photo), the time and date always show; every other element is hidden when its data is empty. The page never renders "--", "none", "0%" or an empty card.

## 5. HER: Album (public/album.html by the design lane, public/js/album.js and the new public/js/months.js by the gallery lane)

### 5.1 Feel

Her camera roll, full-bleed, the way a photographer's phone looks at night. Pictures big and frameless. Each month opens on its newest picture edge to edge with the month set over it; the rest in a tight grid. The two of you at the top under "Us". Tap any picture and the room goes dark around it; the date and the place are written there, not under every tile.

### 5.2 Layout

390: page title "Album" (`.display.xl`) with a kicker count ("24 pictures"); the "Us" section (when any) as a horizontal scroll row of large frameless tiles (72vw each, 4:5, radius 14, scroll-snap); then one section per month: its newest picture as `.month-hero` (full width of the viewport, edge to edge, no gutter, 4:5, `object-fit: cover`), the month name over its lower left in the display face (`.month-over`, Fraunces 40px, `--her-name`, on a bottom gradient `linear-gradient(180deg, transparent 50%, rgba(4, 7, 14, 0.72))`, which is the lock screen's bottom band, 8.60:1), then the month's other pictures in `.gallery.edge`: 3 columns, square tiles, 2px gaps, edge to edge (no side gutter), no frames, no captions, no rotation. 1280: max 1180px centred, the Us row as a 3-up grid, the month hero at 16:9 (max 640px tall), the grid 5 columns (6 over 1400). A clip carries a 36px round glass play badge centred. `.polaroid` stays defined in app.css (ui_v4 pins the selector) for Studio's frames; the Her side does not use it.

### 5.3 Markup contract (album.html; old ids `albumStatus`, `albumFilter`, `albumGrid` and the four `data-group` buttons are gone; `albumOlder` stays)

```
<body class="page-album">
<header class="top"> (the shell) </header>
<main class="page album">
  <header class="page-head"><h1 class="display xl">Album</h1><p class="kicker" id="albumCount"></p></header>
  <section class="gallery-section us-row hidden" id="usSection" aria-labelledby="usHead"><h2 class="display" id="usHead">Us</h2><div class="gallery" id="usGrid"></div></section>
  <div id="albumMonths"></div>
  <p class="empty-label hidden" id="albumEmpty">No pictures yet</p>
  <div class="row center"><button type="button" class="btn ghost hidden" id="albumOlder">More</button></div>
</main>
<div class="lightbox hidden" id="lightbox" role="dialog" aria-modal="true" aria-label="Picture">
  <button type="button" class="icon-btn lb-close" id="lbClose" aria-label="Close">(x)</button>
  <button type="button" class="icon-btn lb-prev" id="lbPrev" aria-label="Previous">(chevron)</button>
  <figure class="lightbox-media" id="lbMedia"></figure>
  <button type="button" class="icon-btn lb-next" id="lbNext" aria-label="Next">(chevron)</button>
  <div class="lightbox-cap"><span class="cap-date" id="lbDate"></span><span class="cap-place" id="lbPlace"></span></div>
  <div class="lightbox-actions"><a class="btn ghost" id="lbSave">Save</a><a class="btn ghost" id="lbOpen" target="_blank" rel="noopener">Full size</a></div>
</div>
<script type="module" src="/js/nav.js"></script>
<script type="module" src="/js/album.js"></script>
```

### 5.4 Behaviour (gallery lane)

Data: `GET /api/roll?limit=24` and `&before=<nextBefore>` for More (8.1). Items with `us` true go to `#usGrid`; the rest are grouped by month of `at` in the browser's local time (`months.js`), each month appended to `#albumMonths` as `<section class="gallery-section"><a class="roll-tile month-hero" ...>(the month's first item)<span class="month-over display">September</span></a><div class="gallery edge">(the rest)</div></section>` (a later page appends to the month already on screen, into its grid; the hero stays the month's newest). Each item: `<a class="roll-tile" href="/media/<id>" data-id="<id>"><img loading="lazy" decoding="async" alt="" src="/media/<id>"></a>`; a clip is `a.roll-tile.clip` with its `poster` as the `<img>` (8.1) and `<span class="play-badge" aria-hidden="true">`, or `<video muted playsinline preload="none">` when it has no poster; `img.loaded` on load. Every tile's `aria-label` is its date and place in words ("Saturday, September 26, the record store"). A click opens the lightbox (the default navigation is prevented; a middle click or a new-tab gesture still opens the file): the image, or the clip with `controls autoplay playsinline`; `#lbDate` "Saturday, September 26", `#lbPlace` the place or hidden; `#lbSave` href `/media/<id>?download=1`; `#lbOpen` href `/media/<id>`; arrows and the prev and next buttons walk the loaded items; Escape and `#lbClose` close; focus is trapped inside while open and returns to the tile. `location.hash` of `#<id>` (from the phone's roll strip) opens that picture once it is loaded (loading More pages until found, at most 5 pages). `#albumCount` "24 pictures" (the loaded count, "+" when more exist); `#albumEmpty` only when the first page is empty. No approve or reject here (Studio's Pictures page keeps them), no chips, no captions on tiles.

public/js/months.js (gallery lane, pure):
```
export function monthKey(iso: string): string                 // "2026-09", local time
export function monthLabel(key: string, nowIso: string): string  // "September", or "September 2025" when not this year
export function groupByMonth(items: Array<{ at: string }>): Array<{ key: string; items: object[] }>   // newest month first, order kept
export function capDate(iso: string): string                  // "Sep 26"
```

## 6. HER: Us (public/us.html by the design lane, public/js/us.js by the gallery lane)

### 6.1 Feel

A magazine feature about the two of you. Her face large in its ring at the top, "Us" in the display face, where you stand in one line under it ("seeing each other, early"), since when, and her names for each other. Then the chapters, the moments, the places, and the lines of hers you kept, set as pull quotes. It is the story, not the file: nothing about what she has on record about you, no reads of you, no subjects of what she has not told you (those are the writer's and live in Studio > Memory, which already lists them with their retire controls). No weights, no phases, no logs, no numbers.

### 6.2 Layout

One editorial column, max 720px, centred; 390 uses 16px gutters. Section headings are `.display` 28px with a kicker above ("Chapters", "Moments", "Places", "Her words"). Chapters: a vertical list, each chapter title in Fraunces 21px with its dates in italic beside it; at 1280 two columns. Moments: a thin accent-tinted vertical line (1px, `rgba(34, 211, 238, 0.35)`) with a small glowing node per moment, the date in italic, the title in 17px. Places: a list of place names in the display face, "first on Sep 24" in italic, "3 times" when more than once, a small round thumbnail when the place has a picture (the first six places only). Her words: each kept line as a pull quote, Fraunces italic 22px (19px at 390), weight 340, `--text`, a large open quote mark in `--text-2` hanging in the margin, the date in the sans kicker under it; one per row, generous air between them; a tap opens that chapter.

### 6.3 Markup contract (us.html, new)

```
<body class="page-us">
<img class="backdrop" id="backdrop" alt="" aria-hidden="true" decoding="async">
<header class="top"> (the shell) </header>
<main class="page us-page">
  <header class="us-hero">
    <img class="avatar ring hero" alt="" width="120" height="120" decoding="async" data-avatar="her">
    <h1 class="display xl">Us</h1>
    <p class="us-standing hidden" id="usStanding"></p>
    <p class="us-since hidden" id="usSince"></p>
    <p class="us-names hidden" id="usNames"></p>
  </header>
  <section class="us-section hidden" id="chaptersSection"><p class="kicker">Chapters</p><ol class="chapter-list" id="usChapters"></ol></section>
  <section class="us-section hidden" id="momentsSection"><p class="kicker">Moments</p><ol class="moments" id="usMoments"></ol></section>
  <section class="us-section hidden" id="placesSection"><p class="kicker">Places</p><ul class="places-together" id="usPlaces"></ul></section>
  <section class="us-section hidden" id="keptSection"><p class="kicker">Her words</p><div class="kept-quotes" id="usKept"></div></section>
</main>
<script type="module" src="/js/nav.js"></script>
<script type="module" src="/js/us.js"></script>
```

(nav.js `mountAvatar` fills every `img.avatar[data-avatar]`, so the hero needs no script. The main's class is `us-page`, not `us`: a bare `.us` rule would restyle the existing `.chip.us` and `.polaroid.us`.)

### 6.4 Behaviour (gallery lane)

Data: `GET /api/us` (8.7), once. `#usStanding` = `standing` (sentence case); `#usSince` "since Thursday, September 24" from `since`; `#usNames` "Starbrite" when `nicknames` has any (joined with " / ", italic). Chapters: `<li><a class="chapter-card" href="/" data-id><span class="chapter-title">The bench</span><span class="chapter-when">Sep 24 -- Sep 25</span></a></li>` (one date when both are the same day); a click stores `avelie.conversation` (the key chat.js reads) and goes to "/". Moments: `<li class="moment"><time class="moment-when">Sep 24</time><span class="moment-title">first kiss at the record store</span></li>` (no `at` -> no time element). Places: `<li class="place-together"><img class="place-thumb" src="/media/place/<placeId>" alt="" loading="lazy"> (only with a picture, first six rows) <span class="place-name">the record store</span><span class="place-first">first on Sep 26</span><span class="place-times">3 times</span></li>` (app.css styles it as `.place-together .place-thumb`, never a bare `.place-thumb` rule, which Studio's `.place-row .place-thumb` owns). Her words: `<a class="kept-quote" href="/" data-conversation><blockquote class="kept-text">...</blockquote><span class="kicker kept-when">Sep 25</span></a>`; a click stores `avelie.conversation` and goes to "/". Every section stays hidden while its list is empty. us.js makes no write (no retire, no mark).

## 7. STUDIO (the writer's room)

### 7.1 Feel and shell

A clean, honest tool in the same dark glass and the same type: the page titles in the display face, everything else in the sans, labels only, generous rows, no borders except inside tables, raw JSON only behind "Advanced". `body.studio` on every Studio page; `.studio-nav` (built by nav.js) under the header: Record, Settings, Pictures, Timeline, Memory. The same five pages as today, same paths, same scripts (state.js, model.js, images.js, timeline.js, memory.js), every existing id and `name` kept (the v1 to v5 tests and the scripts bind them). Grouping is by what each thing does for her, with the same group names across pages: Her time, Her memory, Her voice, Pictures, Calls, Songs, Money, System. (The six he named, plus Songs for the playlist and the listening line, and System for keys, counts and the drift check.) The operator chips and flags stay reachable: in the chat behind "Show the workings", on Record > Now > Checks, and in the Timeline's log. Every Studio place that names a conversation (the Export tab's transcript list in state.js, today `(c.title || "chat") + " " + date`, and any Checks row that names one) uses `c.displayTitle` from 8.2, falling back to the stored title, never "chat".

### 7.2 Record (/state; markup by the design lane, state.js by the studio lane)

The twelve tabs stay (`TABS` in state.js, the `data-tab` buttons, the `#tab-<name>` panels, hash routing). The design lane regroups the tab list under group labels and renames the visible labels (the `data-tab` values do not change):

```
<nav class="studio-tabs" aria-label="Record">
  <div class="tab-group"><span class="tab-group-label">Her time</span><div class="tabs" role="tablist" aria-label="Her time">
    <button type="button" role="tab" data-tab="now">Now</button><button type="button" role="tab" data-tab="life">Her days</button><button type="button" role="tab" data-tab="wants">Wants</button></div></div>
  <div class="tab-group"><span class="tab-group-label">Her memory</span><div class="tabs" role="tablist" aria-label="Her memory">
    <button ... data-tab="facts">Facts</button><button ... data-tab="history">Moments</button><button ... data-tab="memory">Recall</button><button ... data-tab="unknowns">Questions</button><button ... data-tab="inbox">Inbox</button></div></div>
  <div class="tab-group"><span class="tab-group-label">Her voice</span><div class="tabs" role="tablist" aria-label="Her voice">
    <button ... data-tab="voice">Voice</button><button ... data-tab="notes">Notes</button><button ... data-tab="rulebook">Rulebook</button></div></div>
  <div class="tab-group"><span class="tab-group-label">Backup</span><div class="tabs" role="tablist" aria-label="Backup">
    <button ... data-tab="export">Export</button></div></div>
</nav>
```

(state.js finds its buttons with `document.querySelectorAll(".tabs button")`, which matches all four groups' `div.tabs`; no change is needed there.) At 390 the groups stack as rows, each a horizontally scrollable pill row; at 1280 they sit in one row with the group labels as kickers.

Now tab markup changes (design lane): the Relationship card gains `<div class="human-fields" id="relFields"></div>` above the textarea, and the Scene card `<div class="human-fields" id="sceneFields"></div>`; in each card the textarea, the note input and the Versions list move inside `<details class="advanced"><summary>Advanced</summary> ... </details>`; the Save button and its status stay outside. Inbox: nothing in markup.

state.js (studio lane):
- `#relFields`: labelled inputs for `status` "Where you stand", `his_name` "His name", `nicknames` "Nicknames", `trust` "Trust", `affection` "Affection", `attraction` "Attraction", `private_language` "Private language", `summary` "Summary" (textarea, 3 rows). `#sceneFields`: a Together / Apart segmented pair for `status`, `location` "Place", `time` "Time", `present` "Who is there". Each field edits the parsed JSON object; Save (`#relSave`, `#sceneSave`) writes the merged object through the existing PUT exactly as today (the textarea is kept in sync both ways, so Advanced still works and is still the source of any key not listed). The review_v5 regexes on state.js stay true (the cooling-off removal line, `const cooling = live ? live.coolingOff === true : coolingLocal(st)`, `const phase = live ? (typeof live.friction === "string"`, `if (guess) body.inferred = guess.checked;`, the `loadWants` block with `loadSettingsOnce()`, `/api/beats?status=all`, `lifeTz = settings.timezone`, and the variant `missingNote` flash).
- Inbox: each proposal reads as words first: the kind as a kicker in human words (the existing `KIND_LABEL`), the proposal text at 16px, the payload as labelled lines ("Place: the record store") instead of `key value` chips, and the raw payload JSON inside a `details.advanced`. Approve / Edit / Reject unchanged.
- Empty lists show a quiet label ("Nothing waiting", "No questions") instead of a `none` chip.
- The Export tab's transcript list: the label is `c.displayTitle` (7.1).

### 7.3 Settings (/model; markup by the design lane, model.js by the studio lane)

One form, grouped. `#settingsForm` becomes the wrapper of every group (there is only one form on the page; every other button inside it is `type="button"`, which the design lane checks one by one), so `form.elements[name]` finds every field wherever it sits. Every `name`, every id and the three card Saves with `data-save-status` stay (review_v5 "ui 7" counts exactly 3). The top `#saveBtn` and `#settings-status` move into a sticky `.save-bar` at the bottom of the viewport (above the tab bar at 390).

```
<main class="page studio-settings">
  <h1 class="display xl">Settings</h1>
  <nav class="group-index" aria-label="Groups"><a href="#group-voice">Her voice</a> ... <a href="#group-system">System</a></nav>
  <form id="settingsForm" autocomplete="off">
    <section class="studio-group" id="group-voice" aria-labelledby="gh-voice"><h2 class="group-title" id="gh-voice">Her voice</h2> ...blocks... </section>
    ... group-memory, group-time, group-pictures, group-calls, group-songs, group-money, group-system ...
    <div class="save-bar"><button type="submit" class="btn primary" id="saveBtn">Save</button><span class="chips" id="settings-status"></span></div>
  </form>
</main>
```

Each old card or `h2` block becomes a `.setting-block` with an `h3.block-title` inside its group; each field is a `.setting` row: the label (one line), the control right-aligned at 1280 and below the label at 390, an optional `.setting-hint` of at most six words (no paragraphs; the "USD per 1M tokens" line under Prices becomes the table's caption). Rarely touched internals sit in a `details.advanced` inside their block (provider and model names, price table, call prices, the system keys and counts). The mapping, block by block (every field of each block moves with it):

| Group | Blocks (today's heading or id) |
|---|---|
| Her voice (`group-voice`) | Text; Voice bank; Voice (her voice notes); Tastings (the settings block and `#tastingsBox`); Texter (the settings block and `#texterBox`); `#voiceprintBox` |
| Her memory (`group-memory`) | Memory; Proposals; Her story (beats, reads, friction, sent, world, known artists) |
| Her time (`group-time`) | `#storyCard`; `#nightlyCard`; Grounding; Timing; Her first texts (with `#herTextsBtn`, `#herTextsStatus`); Wants; `#pushBox` |
| Pictures (`group-pictures`) | Images (without `listeningLineEnabled`); His face |
| Calls (`group-calls`) | Calls (the call face select included) |
| Songs (`group-songs`) | `#spotifyCard` (with its ids `spotifyStatus`, `spotifyConnect`, `spotifyDisconnect`, `spotifyPlaylist`); the `listeningLineEnabled` switch |
| Money (`group-money`) | Caps (without `driftCheckEnabled`); Prices (`#priceRows`, `#addPriceBtn`); Usage |
| System (`group-system`, the whole group inside `details.advanced`; its open state is set by model.js at load, see below) | the `driftCheckEnabled` switch; Drift; System (keys, counts) |

Layout: 390 one column, the group index a scrollable row under the title; 1280 a 220px sticky group index on the left and the groups on the right (max 820px). model.js (studio lane): no binding change is needed (it binds by name and id); it may mark the group index link of the group in view (IntersectionObserver) and must keep every line the tests read (`FIELDS`, `NUMERIC`, `BOOL`, `e.submitter`, `querySelector("[data-save-status]")`, `/api/nightly/run` with `force: true`, the twenty v5 keys). Two additions, because the form has 52 fields with `min`, `max`, `required` or `pattern` and no `novalidate`, and a field inside a closed `details.advanced` that fails the browser's check blocks Save with "not focusable" and nothing he can see: (1) `form.addEventListener("invalid", onInvalid, true)` (capture phase; `invalid` does not bubble): open every `details` ancestor of the field (`el.closest("details")`, walking up), `scrollIntoView({ block: "center" })`, focus it, and put the field's `validationMessage` in `#settings-status`; (2) at load, `document.getElementById("group-system")`'s `details.advanced` gets `open` when `matchMedia("(min-width: 761px)").matches` (markup cannot do width-dependent `open`); the markup leaves it closed.

### 7.4 Pictures (/images), Timeline (/timeline), Memory (/memory)

- Pictures: the four tabs Photos, Clips, Portraits, Library stay with their ids (`#avatarPick`, `#callFaceCard` included), and a fifth tab joins them: Places (`<button type="button" role="tab" data-tab="places">Places</button>`, panel `<section id="tab-places" class="stack hidden" role="tabpanel">` holding `<div id="placesAdmin"></div>` and the add form moved from the v4 phone page with its ids `placeTitle`, `placeDetail`, `placeAdd`, `placeAddStatus`). images.js adds `"places"` to its `TABS` and ports the v4 phone page's place card (Save pin, Set on map is dropped, Geocode, Make picture, Remake, Remove picture, the add form) from the base commit's public/js/phone.js `placeCard` and `renderPlaces`, reading `GET /api/places` (its rows use the table's snake_case names: `geocoded_by`, `picture_light`, `picture_season`, `last_used_at`, plus `active` and `picture`); the rows keep the class `.place-row`; `showTab` gains its `places` branch. Grids of pictures lose borders and become the Album's frameless squares with a glass action row (Approve, Reject) under each candidate. Beyond the Places tab, images.js changes only class names (section 9); no other route changes. Candidates made in a conversation are approved here or from the chat's lightbox (3.4 item 7), now that the Album shows only approved pictures. The Places tab lists the places with no stored coordinates first, under a kicker "Not on the map", each with the ported "Save pin" (typed `lat` and `lon`, `PUT /api/places/:id` with `geocodedBy: "owner"`, exactly as the v4 card sends) and Geocode; her Maps app shows a place only once it has a pin. No gazetteer is built: the handful of live places are pinned once by hand after the deploy (section 12).
- Timeline: words first. `GET /api/timeline` items carry `story` (8.8). The default list shows only items with a `story`, each as `.story-line`: the date in italic (`.story-when`), the sentence (`.story-text`), a small glyph by type; the kind filter stays. timeline.html gains, next to the filter, `<label class="switch" for="logToggle"><input type="checkbox" id="logToggle"><span class="track"></span><span class="switch-label">Show the log</span></label>`; with it on every item shows as today's log rows (timeline.js renders them as `.list-row` and, for pictures, `.photo-row`: mono title, ids, links), including the items with no story. There is no `.log-line` class; section 9 does not add one. The choice is stored per browser (`avelie.timelineLog`).
- Memory: the old memory map internals, unchanged in data and ids (`memoryStatus`, `memoryLegend`, `memoryFacts`, `memoryFading`, `memoryReturned`, `memoryHistory`, `memorySealed`, `memoryViews`, `memoryArtists`, `memoryKept`), restyled; memory.js (studio lane) keeps `/retire`, `/api/known-artists` and `view-row` (ui_v5), shows empty lists as a quiet label instead of a `none` chip, and renders "Kept today" as words: the proposal text, the kind as a kicker in human words, the time.

### 7.5 Empty data

Studio shows quiet labels for empty lists ("Nothing waiting"); it never hides a control he needs.

## 8. SERVER (the server lane: src/api.ts, four new modules, two one-line edits, API.md)

No migration, no setting, no secret, no new origin. Every route owner-only behind Access and the auth gate; the one PUT passes the cross-site gate in src/index.ts as every write does. No pattern collides: `matchRoute` counts segments first (`/api/phone/lock` is three segments beside `/api/phone`; `PUT /api/conversations/:id` is a new method on the pattern `DELETE` already uses; `/api/roll`, `/api/wallpaper` and `/api/us` are new literals). D1 limits as always (IN lists chunked by 90). Every new text the routes return is either the record as stored (cut to length) or a fixed label from this section; nothing is generated, nothing calls a provider. Every new GET is a read of the story: it writes no story row on the way (in particular the lock route never calls `syncPeople`, which inserts people). The only writes a new GET can cause are the two bookkeeping writes today's reads already cause: the story clock's idempotent sync inside `loadStoryClock` (as `GET /api/clock` does) and the weather cache inside `getWeather` (as `GET /api/phone` does).

### 8.1 `GET /api/roll?limit=&before=` (new; src/roll.ts)

Her camera roll: every picture and clip of hers that is APPROVED, bound to a message or not.

```ts
export interface RollItem { id: string; kind: "photo" | "clip"; url: string; poster: string | null; at: string; place: string | null; us: boolean; conversationId: string | null; messageId: string | null }
export interface RollPage { items: RollItem[]; nextBefore: string | null }
export const ROLL_ROLES: readonly string[] = ["scene", "candidate", "video"];
export const ROLL_LIMIT_DEFAULT = 60;
export const ROLL_LIMIT_MAX = 200;
export function rollEligible(row: { role: string; approval_status: string }): boolean
export async function listRoll(db: D1Database, opts?: { limit?: number; before?: string }): Promise<RollPage>
```

Rows: `visual_assets` with `role IN ('scene', 'candidate', 'video')` AND `approval_status = 'approved'` (so never `master`, `him`, `portrait`, `callface`, `legacy_archive`, `blacklisted`, `missing`; never a candidate, rejected, pending, generating or failed row), newest first by `created_at DESC, id DESC`, `before` cutting on `created_at` with the same tie rule `listAlbum` uses (a tie at the page edge joins the page). `kind` is `clip` for role video; `url` is `"/media/" + id`; `poster` is null for a photo, and for a clip `"/media/" + <source id>` where the source id is read from the asset's `notes` the way chat.js `clipSourceOf` does (the part of `notes` before the first "|", when it starts with "source:", trimmed after the prefix; null when absent), exported as `clipSourceOf(notes: string | null): string | null`; `us` is `with_him = 1`; `at` is the message's `created_at` when `message_id` is set, else the asset's `created_at`; `place` is `sceneAt(versions, at).location` (imported from src/album.ts) when the row is bound to a message, else null; `conversationId` from the message, else the row. `limit` 1..200 (default 60), `before` any time `Date.parse` reads (400 `validation` otherwise, as the album does). `nextBefore` is the oldest row's `created_at` on a full page, else null. `GET /api/album` is unchanged (its test pins its item keys and its "owner-fired picture absent" check).

### 8.2 `GET /api/conversations` (changed; src/chapters.ts)

Answers `ConversationView[]` (same order, same filter of drift conversations): every `ConversationRow` field as today plus

```ts
export type TitleFrom = "his" | "place" | "day";
export interface ConversationView extends ConversationRow {
  displayTitle: string;
  titleFrom: TitleFrom;
  firstAt: string | null;   // first visible story message
  lastAt: string | null;    // last visible story message
  preview: { role: "user" | "assistant"; text: string; at: string } | null;
}
export function placeTitle(location: string | null | undefined): string | null
export function dayTitle(iso: string, tz: string): string
export function chapterTitle(conv: { title: string | null; created_at: string }, span: { firstAt: string | null; lastAt: string | null }, versions: SceneVersionLike[], tz: string): { displayTitle: string; titleFrom: TitleFrom }
export function cleanTitle(raw: unknown): string | null
export function previewText(content: string | null | undefined): string | null
export function visitedVersions(versions: SceneVersionLike[], storyTimes: readonly string[]): SceneVersionLike[]   // the versions with at least one visible story message in [created_at, next version's created_at)
export async function conversationViews(db: D1Database, rows: ConversationRow[], tz: string, now?: Date): Promise<ConversationView[]>
export async function renameConversation(db: D1Database, id: string, title: string | null, actor: string, tz: string): Promise<ConversationView>
```

The title, computed on every read and never stored (only his rename writes `conversations.title`):
1. `his`: the stored title, trimmed, when not empty.
2. `place`: when `firstAt` exists: the scene in force at `firstAt` (`sceneAt(versions, firstAt)`) when it is together with a location; else the first VISITED scene version (`visitedVersions` over this conversation's visible story message times) with `firstAt < created_at <= lastAt`, status together and a location. A version nobody talked in (a photo re-shoot setup, a test fast-forward, a scene set and changed again before a word) never names a chapter. The words: `placeTitle(location)`: collapse whitespace, trim, drop one leading "at ", "in " or "on " (any case), cut at the first ",", ";", "(" or " -- ", cut at the last space before 40 characters when longer, drop trailing punctuation, upper-case the first letter; null when nothing is left. "the bench by the water" -> "The bench by the water"; "at the record store on Congress Street, late" -> "The record store on Congress Street".
3. `day`: `dayTitle(firstAt ?? created_at, tz)`: the weekday in her timezone (`settings.timezone`, en-US, long) and the part of the day by her local hour: 5 to 11 "morning", 12 to 16 "afternoon", 17 to 20 "evening", otherwise "night". "Thursday night".

`firstAt`, `lastAt` and `preview` come from two statements for the whole list, both only over visible story rows (`channel = 'story' AND (deliver_at IS NULL OR deliver_at <= ?now)`): one `SELECT conversation_id, created_at ... ORDER BY created_at` (the per-conversation times feed `visitedVersions`; `firstAt` and `lastAt` are the first and last of them), and one join on the per-conversation `MAX(seq)` of those rows for the last row's `role`, `content`, `created_at`. `previewText`: every `*...*` action removed (a line that is only an action keeps the action's words without the asterisks), whitespace collapsed, trimmed, cut at the last space before 90 characters with "..." appended when longer; empty content gives a null preview. The scene versions are read once per call (`SELECT version, state_json, created_at FROM state_versions WHERE entity = ?1 ORDER BY version` bound to "scene").

`POST /api/conversations` answers the new row as a `ConversationView` too (title null -> the day title from `created_at`), still 201.

### 8.3 `PUT /api/conversations/:id` (new)

Body `{ title: string | null }`. `cleanTitle`: `null` or a string that is empty after trimming -> null (back to the automatic title); otherwise whitespace collapsed, trimmed, every em dash or en dash (with the spaces around it) becomes " -- " and every Unicode ellipsis "..." (his phone's smart punctuation), at most 80 characters after that (400 `validation` "title is too long"); a body without the `title` key or with a non-string, non-null value is 400 `validation`. 404 `not_found` for an unknown or deleted conversation. One batch: `UPDATE conversations SET title = ?1 WHERE id = ?2` and an audit row `conversation.rename` (entity `conversation`, the before and after rows). Answers 200 with the `ConversationView`.

### 8.4 `GET /api/wallpaper` (new; src/lockscreen.ts)

```ts
export interface Wallpaper { kind: "photo" | "master"; id: string; url: string; focus: [number, number] | null; day: string }
export function fnv1a32(s: string): number
export function pickWallpaper(day: string, photos: Array<{ id: string; created_at: string }>, fallback: { id: string; file: string; focus: [number, number] }): Wallpaper
export async function wallpaperNow(db: D1Database, settings: Settings, now: Date, fallback: { id: string; file: string; focus: [number, number] }): Promise<Wallpaper>
```

The day is her local calendar day on the real clock (`localDayKey(now, settings.timezone)` from src/phone.ts; the phone panel stays on the real clock, SPEC_V5 "Deferred"). The photos: `visual_assets` with `role IN ('scene', 'candidate')`, `approval_status = 'approved'`, `COALESCE(with_him, 0) = 0`, `bytes IS NOT NULL`, newest 30 by `created_at DESC, id DESC`. `pickWallpaper`: none -> the fallback master (`kind` master, `url` "/" + file, `focus` its focus); otherwise the photo at index `fnv1a32(day) % n` of that newest-first list (`kind` photo, `url` "/media/" + id, `focus` null). Deterministic: one wallpaper per day, a new one after midnight her time, the same on every device. The fallback is the avatar master: api.ts factors the body of `GET /api/avatar` into `avatarMaster(c)` (the stored `avatarAssetId` when it names an approved master, else master-05, else the first approved master, 404 when none) and both routes use it; `AVATAR_FOCUS` stays in api.ts exactly as it is (nav_v4 compares it with nav.js).

### 8.5 `GET /api/phone/lock` (new; src/lockscreen.ts)

```ts
export type LockApp = "messages" | "music" | "calendar";
export interface LockNote { id: string; app: LockApp; title: string; text: string; at: string }
export interface LockScreen {
  now: string;        // her story now: storyNow(loadStoryClock(...)), the real instant unless a together scene is held
  frozen: boolean;    // the story clock is held (the page stops ticking, 4.4)
  tz: string;
  time: string;       // "11:42" at `now`, her timezone, 12-hour, no am/pm
  dateLine: string;   // "Saturday, September 26" at `now`
  weather: { temp: number; units: "fahrenheit" | "celsius"; words: string } | null;
  wallpaper: Wallpaper;
  notes: LockNote[];
  roll: RollItem[];   // listRoll(db, { limit: 12 }).items without `us` items and without a clip that has no poster, first 6
  wants: Array<{ id: string; title: string; next: { title: string; dueOn: string; day: string } | null }>;
}
export interface LockBeat { id: string; wantId: string; title: string; dueOn: string; dueAt: string }
export interface LockInput {
  now: Date;          // the story now
  tz: string;
  his: { id: string; text: string; at: string } | null;       // his newest visible story message with text
  hisName: string | null;                                      // relationship state his_name, trimmed
  song: { messageId: string; artist: string; title: string; at: string } | null;   // her newest visible story row with song_json
  beats: LockBeat[];  // upcomingBeats(...) below
}
export function upcomingBeats(views: BeatView[], tz: string): LockBeat[]
export function dayWord(dueOn: string, todayKey: string): string   // same day "Today", next day "Tomorrow", 2 to 6 days ahead the long weekday ("Thursday"), anything else "Oct 3"
export function lockNotes(input: LockInput): LockNote[]
export async function lockScreen(env: Env, db: D1Database, settings: Settings, realNow: Date, wallpaper: Wallpaper): Promise<LockScreen>
```

`upcomingBeats`: from `listBeatViews(db, { status: "active" })` (src/arcs.ts; every beat is created WITH its pending run in the same batch, so "a beat without a run" is never a real case), keep the views whose `run` is null or has `status` "pending" (not proposed, resolved or anything later); `dueAt` = `run.due_at` when the run exists (it already carries any `shifted_ms` the story clock added, src/clock.ts), else `beat.due_at`; `dueOn` = the local day of `dueAt` in `tz` (`localDayKeyOf`); sorted by `dueAt`.

`lockNotes`, every text a line of the record as stored (one line, at most 160 characters, cut at a word with "..."), never a generated, narrated or rewritten sentence, and never a life-log or grounding line (those are the nightly narrator's and the extractor's words about her, not texts on her phone):
- `messages` (at most 1): his last text to her, when `his` is within the last 48 hours of `now`: `title` = `hisName` or "" (the page then shows no title line), `text` = his words (`previewText`), `id` "msg:" + message id. A message of his with no text (a photo alone) is skipped by the read.
- `music` (at most 1): the song she last sent, when within the last 72 hours: `title` the song title, `text` the artist. `id` "song:" + message id.
- `calendar` (at most 2, soonest first): `beats` whose `dueOn` is her today (`localDayKeyOf(now, tz)`) or one of the next two days and whose `dueAt` is not already past: `title` = `dayWord(dueOn, todayKey)`, `text` the beat title, `at` its `dueAt`. `id` "beat:" + beat id.
- Order: the calendar entries first (soonest first), then the rest newest first; at most 4 in all.

`now` is the story instant (`storyNow(await loadStoryClock(db, settings, realNow))`), so a held together scene holds her phone's clock and day words too; the wallpaper keeps the real day (8.4). `weather`: `weatherFor(env, db, settings, realNow)` from src/phone.ts (the same cached read with its 3.5 s timeout that `phoneState` makes; the server lane adds the `export` keyword to that one function and changes nothing else in the file), as `{ temp: Math.round(temp), units, words }`, null on any failure. `time` and `dateLine` with `Intl.DateTimeFormat` in her timezone at `now`. `wants`: `listWants(db, "active")` in its order, at most 8, each with `next` = its soonest `upcomingBeats` entry (the same filtered list) as `{ title, dueOn, day: dayWord(dueOn, todayKey) }`. `his`: `SELECT id, content, created_at FROM messages WHERE role = 'user' AND channel = 'story' AND (deliver_at IS NULL OR deliver_at <= ?1) AND trim(COALESCE(content, '')) <> '' ORDER BY created_at DESC LIMIT 1` over the conversations the list shows. The route: `lockScreen(env, db, settings, new Date(), await wallpaperNow(...))`. Any sub-read that throws on an older shape answers its empty value (the v4 style), never a 500 for the whole screen.

### 8.6 `GET /api/phone` (unchanged)

No field is added. (Her Maps app shows only places with stored coordinates, 4.5; placing the rest is Studio's, 7.4.) The only edit to src/phone.ts in this pass is the `export` keyword on `weatherFor` (8.5).

### 8.7 `GET /api/us` (new; src/us.ts)

```ts
export interface UsView {
  since: string | null;
  standing: string | null;
  nicknames: string[];
  chapters: Array<{ id: string; title: string; from: string; to: string }>;
  moments: Array<{ id: string; title: string; at: string | null }>;
  places: Array<{ title: string; first: string; times: number; placeId: string | null; picture: boolean }>;
  kept: Array<{ id: string; text: string; at: string; conversationId: string }>;
}
export function togetherPlaces(versions: SceneVersionLike[], storyTimes: readonly string[]): Array<{ title: string; norm: string; first: string; times: number }>
export function quoteText(content: string | null | undefined): string | null
export function splitNicknames(s: string | null | undefined): string[]
export async function usView(db: D1Database, settings: Settings, now: Date): Promise<UsView>
```

- `chapters`: `conversationViews` of the listed conversations (drift and deleted left out) that have a `firstAt`, oldest first; `title` = `displayTitle`, `from` = `firstAt`, `to` = `lastAt`. `since` = the first chapter's `from`, else null.
- `moments`: history rows with status `approved`, ordered by `occurred` (nulls last), then `seq`; `title` as stored, `at` = `occurred`.
- `places`: `togetherPlaces` walks `visitedVersions(versions, storyTimes)` (8.2; `storyTimes` = every visible story message time across the listed conversations) oldest first (by `created_at`, then `version`); a visit starts at a visited together version with a location whose `placeTitleNorm` (src/places.ts) differs from the previous visited version's together place (or the previous visited version was not together); `title` = `placeTitle(location)` (8.2: the first clause, "The record store on Congress Street", never the stage directions after it), the visit keyed by its `placeTitleNorm`; a filler location (`isFillerPlace`: "same scene", "same place", "k", under three characters) is no place and carries the visit before it; `first` the first visit's `created_at`; `times` the visit count; order by `first`. A scene set for a picture or a test and never talked in is not a visit. `placeId` and `picture` (`picture_key` not null) from `listPlaces` by `title_norm`, or by the norm of the place row's own `placeTitle`.
- `kept`: the lines of hers he marked Keep: `message_marks` with `mark = 'keep'` joined to `messages` with `role = 'assistant'`, `channel = 'story'`, visible (`deliver_at IS NULL OR deliver_at <= now`), in a listed conversation; newest first, at most 12. `text` = `quoteText(content)`: every `*...*` action segment removed, whitespace collapsed, trimmed, cut at the last space before 240 characters with "..." appended when longer; a row whose text is empty after that is left out.
- `standing`: the relationship state's display status (`displayStatus` from src/standing.ts with the story clock, as the State page reads it), else its `status`, trimmed; null when empty. `nicknames`: `splitNicknames(state.nicknames)`: every `(...)` aside removed first, then split on commas, semicolons, " / " and newlines, trimmed, empty dropped, deduplicated without regard to case.
- Not in the view, on purpose: facts about him, guesses, her reads of him, her untold facts or their subjects (Studio > Memory lists them with retire). Every sub-read that throws on an older shape answers its empty value.

### 8.8 `GET /api/timeline` (changed; src/timeline.ts)

`TimelineItem` gains `story: string | null`, the event in words, set by each builder:

| type | story |
|---|---|
| history | the title |
| photo | bound to a message (`messageId` set): "She sent you a picture", plus " of the two of you" when `withHim`; a picture with no message (fired from Studio or the API) null: she did not send it |
| media | "She sent you " + the library item's title |
| life | the note |
| relationship | the status with its first letter upper-cased ("Seeing each other, early"), ONLY when it differs (trimmed, case-folded) from the previous relationship version's status; null otherwise and without a status |
| scene | ONLY when the status differs from the previous scene version's, or the status is together and the place differs by `placeTitleNorm` of `placeWords(location)` (8.2: the first clause, a filler location like "same scene" or "k" never moves it and the version before it stays the one compared with): together with a place: "Together at " + `placeWords(location)`; together without one: "Together"; apart: "Apart"; null otherwise (every save and every auto-kept proposal writes a version, and scene is past v33: without this rule "Together at the bench" would repeat dozens of times) |
| first_text | "She texted first" |
| call | "You talked for a minute" under 90 s, else "You talked for N minutes" (rounded) |
| want | the want title, plus " -- " + the log note when there is one |
| ask | "She asked: " + the ask text |
| beat | the beat title + " -- " + its outcome words (the v5 `outcomeWords`) |
| correction, portrait | null |

"The previous version" is the previous version of the same entity by `version`, not the previous row on the page: the timeline pages `state_versions` by `created_at` with a limit, so for the oldest version of each entity on a page timeline.ts reads its predecessor with one more statement (`SELECT state_json FROM state_versions WHERE entity = ?1 AND version < ?2 ORDER BY version DESC LIMIT 1`, at most two, one per entity), and a page edge never reads as a change. Every other field unchanged (`title` keeps the engineering words for the log view).

### 8.9 API.md

The server lane adds an "Experience pass" section: the five new routes (`GET /api/roll`, `PUT /api/conversations/:id`, `GET /api/wallpaper`, `GET /api/phone/lock`, `GET /api/us`), the changed `GET /api/conversations`, `POST /api/conversations` and `GET /api/timeline` shapes, with codes (`GET /api/phone` is unchanged). Nothing else in the docs moves in this pass (the integrator writes the HANDOFF section).

### 8.10 The look fixture (scripts/look_fixture.mjs, server lane)

A dev tool that fills a LOCAL server with a small, realistic record in her shape, so the verifier can look at every page with data before the live look: `node scripts/look_fixture.mjs --base http://127.0.0.1:8787`. It refuses any base whose host is not `127.0.0.1` or `localhost` (exit 2, nothing sent). Through the documented routes only, on the stub provider, it makes: a together scene at "the bench by the water", a conversation of six turns (one with `[[PHOTO]]`, then that picture approved; one with `[[SONG]]`; one of her lines with an `*action*` in it); two of her lines marked Keep (`POST /api/messages/:id/mark { mark: "keep" }`); a together scene at "the shoot on the roof" set and replaced by the next one before any message (it must name nothing and count as no visit); a together scene at "the record store on Congress Street" and a few turns; an apart scene and a second conversation (so one chapter is named by a place, one by its day; no title is set); one owner-fired picture approved (in the roll, not in `/api/album`, and with no story words on the timeline); one candidate picture left undecided in the thread (for the lightbox's Keep / Not her / Again); places "Exchange Street" and "the ferry" pinned with `PUT /api/places/:id { lat, lon, geocodedBy: "owner" }` (43.6577, -70.2549 and 43.6562, -70.2482) and "the bench by the water" left unpinned (it appears in Studio > Pictures > Places under "Not on the map", never in her Maps); two history rows; a want with a beat due tomorrow made through the beat route (so it has its pending run, the real shape); a relationship state with a status, `his_name` "Justin" and the nickname "Starbrite". It prints one line per thing made and exits 0. It is never run by `npm test`.

## 9. Class vocabulary (app.css defines every one; the JS lanes use only these and the existing ones)

Rule 1: every selector app.css has at 7051696 stays defined (restyled in the new language; several are pinned by ui_v4 and ui_v5: `.map`, `.map-water`, `.map-land`, `.map-dot`, `.map-dot.here`, `.map-label`, `.dial`, `.dial-track`, `.dial-fill`, `.polaroid`, `.drawer`, `.msg-avatar`, `#callFace`, `.thread::before`, the `background-image: var(--place-veil), var(--place-url)` composite, `.tile .subject` and `.tile .tile-foot` in `--text-2`, `.playlist-embed, .spotify-embed { ... border: 0`, `.drawer:not(.open) { visibility: hidden;`, `.beat-row`, `.view-row`, `.artist-row`, `.song-feedback`, `.chip.guess`, `#clockChip`). Rule 2: the names below are added. Rule 3: no JS lane invents a class for styling that is not in this list or already in app.css; a lane that needs one names it in its report and the integrator adds it.

- Shell: `.nav-icon`, `.nav-label`, `.studio-link`, `.studio-nav`, `.avatar.ring`, `.avatar.hero` (120px), `.backdrop`, `.backdrop.ready`, `.glass`, `.glass.strong`, `.sheet` (+ `.sheet.open` is not used: `.hidden` toggles it), `.display`, `.display.xl`, `.kicker`, `.rise`, `.page-head`, `.row.center`, `.empty-label`, `body.studio`, `body.page-us`. (No bare `.quiet`: `.btn.quiet` already exists at app.css 279 and a bare rule would restyle every Regenerate and Retry button; an empty list uses `.empty-label`.)
- Chat: `.chapters`, `.chapter-row`, `.chapter-row.active`, `.chapter-open`, `.chapter-title`, `.chapter-when`, `.chapter-preview`, `.chapter-head`, `.chapter-name`, `.chapter-edit`, `.chapter-date`, `.empty-her`, `.her-who`, `.her-who-text`, `.her-name`, `.place-line`, `.tools-sheet`, `.tool-row`, `.tool-sep`, `.tool-kicker`, `.tool-switch`, `.tool-status`, `.scene-sheet`, `.day-sep`, `.rec-bar`, `.rec-dot`, `.rec-time`, `.icon-btn.send`, `body.her-typing`, `.react-bar`, `.react-btn`, `.react-keep`, `.react-keep[aria-checked="true"]`, `.kept-mark`, `.photo-open` (the picture as a button), `.pic-failed` (the quiet "didn't come through" line), `.lightbox-decide`. (Not `.who`, `.who-text`, `.who-name`: `span.who` already styles the call transcript and "his version" at app.css 1397, 1489, 1524; those rules stay untouched.)
- Phone: `.phone-stage`, `.phone-shell`, `.lock`, `.lock-wallpaper`, `.lock-veil`, `.lock-top`, `.lock-top::before`, `.lock-date`, `.lock-time`, `.lock-meta`, `.lock-weather`, `.np-card` (with `.np-title`, `.np-artist`, `.np-progress` reused from the chat strip), `.lock-stack`, `.notif`, `.notif[data-app="calendar"]`, `.notif-head`, `.notif-app`, `.notif-when`, `.notif-title`, `.notif-text`, `.roll-strip`, `.roll-thumb`, `.roll-thumb.clip`, `.home-handle`, `.home`, `.home-wallpaper`, `.home-grid`, `.home-dock`, `.app`, `.app-icon`, `.app-name`, `.app-screen`, `.app-bar`, `.app-title`, `.app-body`, `.place-list`, `.map-place`, `.note-line`, `.note-title`, `.note-next`, `.sent-song`, `.photo-grid`.
- Album: `.gallery-section`, `.us-row`, `.gallery`, `.gallery.edge`, `.roll-tile`, `.roll-tile.clip`, `.month-hero`, `.month-over`, `.cap-date`, `.cap-place`, `.play-badge`, `img.loaded`, `video.loaded`, `.lightbox`, `.lightbox-media`, `.lightbox-cap`, `.lightbox-actions`, `.lb-close`, `.lb-prev`, `.lb-next`. (`.polaroid` stays defined for ui_v4 and Studio, unused on the Her side.)
- Us: `.us-page`, `.us-hero`, `.us-standing`, `.us-since`, `.us-names`, `.us-section`, `.chapter-list`, `.chapter-card`, `.moments`, `.moment`, `.moment-when`, `.moment-title`, `.places-together`, `.place-together`, `.place-together .place-thumb` (scoped; the bare `.place-thumb` belongs to Studio's `.place-row`), `.place-name`, `.place-first`, `.place-times`, `.kept-quotes`, `.kept-quote`, `.kept-text`, `.kept-when`. (Not `.us`: a bare rule would hit `.chip.us` and `.polaroid.us`. No `.envelope`: Memory's `.tile.envelope` at app.css 2158 stays as it is.)
- Studio: `.studio-tabs`, `.tab-group`, `.tab-group-label`, `.human-fields`, `details.advanced` (with its `summary`), `.studio-settings`, `.group-index`, `.group-index a.active`, `.studio-group`, `.group-title`, `.setting-block`, `.block-title`, `.setting`, `.setting-hint`, `.save-bar`, `.story-line`, `.story-when`, `.story-text`. (The log view keeps timeline.js's existing `.list-row` and `.photo-row`.)

Rule 4: before adding a name, the design lane greps app.css and public/js for it as a bare class; a name already used with another meaning is renamed or scoped, never restyled globally. ui_exp asserts that app.css has no bare `.who {`, `.quiet {`, `.envelope {` or `.us {` rule.

## 10. Tests

### 10.1 Existing tests that change (the design lane edits exactly these; nothing else in them moves)

- tests/unit/nav_v4.test.mjs, the test "nav.js LINKS: the eight paths ...": becomes "nav.js LINKS: the four Her paths; STUDIO_LINKS: the five Studio paths"; the constant `LINKS` becomes `[["/", "Chat"], ["/phone", "Phone"], ["/album", "Album"], ["/us", "Us"]]` and a second parse of `/export const STUDIO_LINKS = \[([\s\S]*?)\];/` must equal `[["/state", "Record"], ["/model", "Settings"], ["/images", "Pictures"], ["/timeline", "Timeline"], ["/memory", "Memory"]]`. The header comment line "the eight links in order" becomes "the four Her links and the five Studio links in order".
- tests/unit/ui_v4.test.mjs:
  - "the eight pages exist" -> "the nine pages exist", `EXPECTED_PAGES` gains `us.html` (sorted: album, images, index, memory, model, phone, state, timeline, us).
  - "the three new pages carry the ids ..." -> the id lists of this document: phone.html `lock`, `wallpaper`, `lockDate`, `lockTime`, `lockWeather`, `lockPlaying`, `lockStack`, `rollStrip`, `openHome`, `home`, `homeWallpaper`, `homeGrid`, `homeDock`, `closeHome`, `appScreen`, `appBack`, `appTitle`, `appBody` and `<main class="phone-stage"`; album.html `albumCount`, `usSection`, `usGrid`, `albumMonths`, `albumEmpty`, `albumOlder`, `lightbox`, `lbMedia`, `lbSave`; us.html `usStanding`, `usSince`, `usChapters`, `usMoments`, `usPlaces`, `usKept` and NOT `usKnows`, `usReads` or `usUntold`; memory.html its ten ids (unchanged); index.html `callFace`, `typing`, `placeInput`, `placeLine`, `convTitle`, `chapterEdit`, `moreMenu`, `recBar`, `backdrop`, `lightbox`, `lbKeep`, `lbReject`, `lbAgain` and NOT `phoneBtn` or `phoneDrawer`; images.html `avatarPick`, `callFaceCard`, `tab-places`, `placesAdmin`; model.html the same ids and names as today.
  - "sw.js: the shell list ..." -> the cache name `avelie-shell-v4`; the shell list carries "/", "/phone", "/album", "/us", "/memory", "/js/phone.js", "/js/map.js", "/js/album.js", "/js/memory.js", "/js/us.js", "/js/lockwords.js", "/js/months.js", "/js/callface.js", "/js/player.js", "/fonts/fraunces-latin-full-normal.woff2", "/fonts/instrument-sans-latin-wght-normal.woff2"; `const FONTS = "/fonts/";` served cache-first (the same `caches.match(request` shape the masters test reads); `/api/push/latest` still read; the existing "/api and /media are never cached" test unchanged and green.
- tests/unit/ui_v5.test.mjs, tests/unit/review_v5.test.mjs and every other suite: unchanged, and must stay green (the lanes keep what they read: memory.html's `memoryViews` and `memoryArtists`, index.html's `clockChip`, model.html's story and nightly ids and the three `data-save-status`, the state.js and chat.js lines named in 3.4 and 7.2, model.js as it is, memory.js's `/retire`, `/api/known-artists`, `view-row`).

### 10.2 New suites (each owned by its lane; node --test, read-as-text for browser files that touch `window` at import, direct import for the pure ones)

- tests/unit/ui_exp.test.mjs (design): every page has the shell once and the two font preloads; us.html exists; the three woff2 files exist, start with the bytes "wOF2" and match the sha256 of section 2.2 (the italic is `fraunces-latin-full-italic.woff2`); the two OFL files exist; app.css has the three `@font-face` rules, `--display`, `--sans` starting with "Instrument Sans", every token of 2.1, `--accent-solid: #22d3ee`, no second `--accent*` token, no `background-clip: text` and no `"WONK" 1` anywhere, the global reduced-motion rule of 2.6, `.backdrop` with `filter: var(--backdrop-filter)`, the `header.top::before` and `.thread-bar::before` glass (and no `backdrop-filter`, `filter` or `transform` in the `header.top {` or `.thread-bar {` rules themselves), `.lock-top::before` with `--lock-shade`, `:has(#composer:focus-within)`; index.html has `#moreMenu` and `#placesPop` outside `.thread-bar` (a text check: both ids appear after the closing of `<main`) and `#chapterHead` with `aria-live="off"`; every class of section 9 appears in app.css and no bare `.who {`, `.quiet {`, `.envelope {` or `.us {` rule exists; no rule under the Her page classes of 2.5 uses `var(--muted)`; the contrast table of 2.5 recomputed from the token hex values and the stated alphas (a 15-line WCAG function) with each ratio at or above its floor, and the `--text-2` on `--lock-shade` row asserted BELOW 4.5 together with no `--text-2` inside a `.lock-top` rule; no `style=` attribute and no inline script on any page; the visible text of index.html, phone.html, album.html and us.html (tags and attributes stripped) contains none of the words proposal, version, seq, id, model, prompt, flag, JSON, phase, weight (whole words, any case); nav.js exports `LINKS`, `STUDIO_LINKS`, `STUDIO_HOME`, `isStudioPath`, `NAV_ICONS`, `mountBackdrop`, fetches `/api/wallpaper`, sets `objectPosition` through the CSSOM and never writes a style attribute; sw.js as in 10.1.
- tests/unit/chat_exp.test.mjs (chat): chat.js calls `PUT` on `/api/conversations/` and reads `displayTitle`; calls `/api/wallpaper`; references none of `phoneBtn`, `phoneDrawer`, `openPhone`, `PHONE_IDS`; `metaRow` creates the inline why, note and keep controls only under `state.operator`; the `react-bar` is built with a `react-keep` heart that posts `/mark` with `keep` and deletes it, plus note and why, and opens on `dblclick`, `contextmenu` and a long press; `photoActions(` (the only builder of the "Approve" text) is called only inside a `state.operator` branch, and the lightbox binds `lbKeep`, `lbReject`, `lbAgain`; `renderPhoto` builds no "Open full size" text and no `chip("us"` outside the operator branch; `errorWords` exists, maps `provider_failed` to "Didn't come through" and `budget_exceeded` to "Today's limit reached" (the function is extracted and evaluated, the review_v5 way), and `showError` writes `errorWords(`; the recording starts from a click on `#micBtn` and `recSend` / `recCancel` are wired; `chapterHead` survives `loadThread` (the function re-appends it); `import "./player.js";`, the song embed slot and the play event lines of ui_v4 are present; the string "chat " + a date is gone from `convLabel`; no class `who` is created for the chat bar.
- tests/unit/phone_exp.test.mjs (phone): imports public/js/lockwords.js: `appFromHash` for every hash and junk; `whenWords` at 30 s, 12 min, 3 h, 26 h, 3 days, 10 days against a fixed now; `weatherWords` for both units and null; `tickOffset` for a readable and an unreadable instant; `APP_NAMES` has exactly messages, music, calendar; map.js still exports `PORTLAND_BOUNDS`, `MAP_VIEW`, `project`, `unproject`, `outlinePath`, `drawMap` and `role: "group", "aria-label": "Map"` (ui_v4); phone.js (as text) reads `/api/phone/lock`, `/api/roll`, `/api/phone`, `/api/sent`, `/api/spotify`, imports player.js, sends no `PUT` to `/api/places` (placing is Studio's), reads `frozen` and stops the tick with it, never writes `lockStatus`, and renders nothing for an empty list (no "none", "--" or "%" literal in its UI strings).
- tests/unit/gallery_exp.test.mjs (gallery): imports public/js/months.js: `monthKey`, `monthLabel` (this year and last), `groupByMonth` order, `capDate`; album.js (as text) reads `/api/roll` with `limit=24`, builds `month-hero` and `roll-tile`, never builds `polaroid`, uses `?download=1` for Save, never calls `/api/images/` (no approval on the Her side), handles `location.hash`; us.js (as text) reads `/api/us`, stores `avelie.conversation`, makes no `POST`, `PUT` or `DELETE`, and reads none of `knows`, `guesses`, `reads`, `untold`.
- tests/unit/studio_exp.test.mjs (studio): timeline.js reads `story` and `#logToggle` and stores `avelie.timelineLog`; state.js fills `relFields` and `sceneFields`, labels transcripts with `displayTitle`, and still carries every line review_v5 reads; images.js has `"places"` in `TABS`, calls `/api/places`, `/geocode` and `/picture`, and shows "Not on the map"; model.js listens for `invalid` in the capture phase and opens the enclosing `details`, and reads `matchMedia(` for the System group; memory.js keeps `/retire`, `/api/known-artists`, `view-row`; no Studio script renders `chip("none")`.
- Server (each its own file): tests/unit/roll_exp.test.mjs (on `fakeDb`: an owner-fired approved picture is in, a candidate, a rejected, a him, a portrait, a callface and a master row are out; `us`, `kind`, `url`, `at` from the message, `place` from the scene for a bound row and null for an unbound one; a clip's `poster` from `notes` "source:<id>|..." and null without it, `clipSourceOf` cases; paging and the tie rule; a bad `before` 400), chapters_exp.test.mjs (`placeTitle` cases of 8.2; `dayTitle` for 7:00, 13:00, 18:00, 23:30 and 02:00 in America/New_York; `chapterTitle` his > place in force at firstAt > first VISITED together version inside the span > day, with an unvisited together version inside the span skipped; `visitedVersions` on windows with and without a message; `cleanTitle` null, empty, 80 and 81 characters, the em dash, en dash and ellipsis repairs; `previewText` at 90), lockscreen_exp.test.mjs (`upcomingBeats` on views made the way `createBeat` makes them, beat plus a pending run in the same batch: the beat IS listed, `dueAt` from the run including a shift, a proposed or resolved run is not listed; `lockNotes`: his last message becomes a Messages entry titled with `hisName` and untitled without it, outside 48 h nothing, no message nothing (nothing invented), the 72 h song window, calendar first, at most 2, a past `dueAt` left out, at most 4 in all, no `today` app ever; `dayWord`; `pickWallpaper` deterministic for a day, different across days for n > 1, the master fallback with its focus; `fnv1a32("")` = 2166136261; `lockScreen` with a held story clock answers `frozen` true and the frozen instant as `now`, and its `roll` has no `us` item; on `fakeDb` when it can hold the clock and span tables, else through a pure `lockScreenFrom(parts)` core that `lockScreen` calls, which the lane may add to lockscreen.ts), us_exp.test.mjs (`togetherPlaces` visits and edits, an unvisited version is no visit; `quoteText` strips `*actions*`, cuts at 240, empty -> null; `splitNicknames`; `usView` on `fakeDb` leaves out drift chapters, lists kept lines of hers newest first and never one of his or a dropped one, and its keys are exactly the seven of 8.7), timeline_exp.test.mjs (the story words of 8.8 for each type, including null for correction and portrait, null for a photo with no message, a repeated scene or relationship status null, and a page-edge version compared with its predecessor, not with nothing).
- tests/integration/run.mjs (server lane): an "exp" phase on its own fresh state (the v4 and v5 phases' pattern): the conversations list carries `displayTitle`, `titleFrom`, `firstAt`, `lastAt`, `preview`; a together scene before the first turn names the chapter after its place; a rename answers the new title, `null` restores the automatic one, 81 characters 400, a deleted conversation 404; `/api/roll` holds an owner-fired approved picture that `/api/album` leaves out; `/api/wallpaper` answers a master on an empty roll and the photo after one approval; `/api/phone/lock` keys, a Messages entry after his turn, and a Calendar entry "Tomorrow" after a beat made through `POST /api/wants/:id/beats` (the real shape, with its run); `/api/us` has exactly its seven keys and a kept line after `POST /api/messages/:id/mark { mark: "keep" }`; `/api/timeline` items carry `story`; the pages `/us` and the scripts `/js/us.js`, `/js/lockwords.js`, `/js/months.js` 200; `/fonts/fraunces-latin-full-normal.woff2` 200 with content type `font/woff2`; with `ACCESS_AUD` set, the four new GET routes, the PUT and `/us` answer 401.

## 11. Build lanes (one owner per file; every lane codes against this document, none waits on another)

| Lane | Owns (and nothing else) | Depends on (by contract, not by waiting) |
|---|---|---|
| D design | public/css/app.css; public/js/nav.js; public/sw.js; public/manifest.webmanifest; every public/*.html (index, phone, album, us (new), memory, state, model, images, timeline); public/fonts/* (new); tests/unit/nav_v4.test.mjs and tests/unit/ui_v4.test.mjs (the edits of 10.1 only); tests/unit/ui_exp.test.mjs | the routes of 8 (`/api/wallpaper` in nav.js) |
| C chat | public/js/chat.js; public/js/bubbles.js, public/js/call.js, public/js/callface.js (only if the new markup needs it); tests/unit/chat_exp.test.mjs | index.html ids of 3.3; 8.2, 8.3, 8.4 |
| P phone | public/js/phone.js; public/js/map.js; public/js/lockwords.js (new); tests/unit/phone_exp.test.mjs | phone.html ids of 4.3; 8.1, 8.5, 8.6 |
| G gallery | public/js/album.js; public/js/months.js (new); public/js/us.js (new); tests/unit/gallery_exp.test.mjs | album.html and us.html ids of 5.3 and 6.3; 8.1, 8.7 |
| S studio | public/js/state.js; public/js/model.js; public/js/images.js; public/js/timeline.js; public/js/memory.js; tests/unit/studio_exp.test.mjs | state, model, images, timeline and memory markup of 7; 8.8 |
| V server | src/api.ts; src/roll.ts, src/chapters.ts, src/lockscreen.ts, src/us.ts (new); src/phone.ts (the `export` keyword on `weatherFor` only); src/timeline.ts (the `story` field and its predecessor read only); API.md; scripts/look_fixture.mjs (new); tests/unit/roll_exp, chapters_exp, lockscreen_exp, us_exp, timeline_exp .test.mjs (new), and tests/unit/helpers_exp.mjs if it needs helpers; tests/integration/run.mjs (the exp phase and the gated list only) | nothing |

No gazetteer is built (no src/gazetteer.ts, no `approx` field, no gazetteer_exp suite): pinning her handful of live places is a hand fix after the deploy (section 12).

Frozen in this pass (no lane edits them): src/index.ts (`harden`, the CSP and the gates; the media caching exception is deferred, 2.9 and 14), src/arcs.ts, src/clock.ts, src/world.ts, public/js/api.js, public/js/player.js, public/js/call_elevenlabs.js, public/js/vendor/*, public/images/*, public/icons/*, every other src/ file, migrations/*, canon/*, scripts/* except the new fixture, the shared test helpers (helpers.mjs, helpers_v2 to helpers_v5), every other test file, SPEC*.md, HANDOFF.md, DEPLOY.md, README.md, docs/*, package.json and package-lock.json (the fonts are copied, not installed).

Each lane, before it reports: its files only (`git status` shows nothing outside its row), `node scripts/check_typography.mjs` clean, `node --check` on every browser script it owns, its own new suite green, and for V `npx tsc --noEmit` clean and the full `npm run test:unit` green on its own changes. Lanes do not start a dev server or a browser (the laptop rule, HQ memory feedback-laptop-load-limits.md); the integrator does, once. Each lane reports: the files changed, every deviation from this document with its reason, any class it needed that section 9 lacks, and the tests it ran with their counts. No lane commits; the integrator commits.

The integrator, after the six lanes: `npm test`, `npm run test:integration`, `node scripts/check_typography.mjs`, `npm run check:deploy`; settles drift between markup and scripts (an id a script reads that the markup lacks is fixed in the markup unless this document says otherwise); adds any class a lane reported; one commit "exp: Her and Studio" on branch exp; then the look pass.

## 12. The look pass (before anyone calls it done)

One `wrangler dev` on the stub with a fresh local state (`npm run db:local` on an empty `.wrangler/state`), ONE headless browser at a time, 390x844 and 1280x800.

First, on the EMPTY record (no approved picture, so the wallpaper and the chat backdrop are the avatar master): the stub image provider answers master 03's bytes (the dark hoodie shot) for every picture and a 1x1 PNG for places (src/providers/stub.ts), so the fixture's photographs are all the same dark image and could never prove legibility. So: `PUT /api/settings { avatarAssetId: "master-01" }` (the cream sweater, the brightest master), screenshots of `/phone#lock` and `/` at both widths, then the same with `"master-05"`; on each, the lock date, clock, weather and a notification, and the chat bar, chapter head, day separator and run time, must read clearly (checked by eye on the screenshot and by `getComputedStyle` colour against the 2.5 table). Then put `avatarAssetId` back to its default.

Then `node scripts/look_fixture.mjs --base http://127.0.0.1:8787`, and screenshots of: `/` (a chapter named by its place and none named after the roof scene, the tools sheet open with the Writer group, the scene sheet open, a picture with nothing under it, the lightbox on the undecided candidate with Keep / Not her / Again, the reaction bar open on her line and a kept heart, "Show the workings" on and off, a voice note recording), `/phone` (`#lock` with a Messages entry titled "Justin" and a Calendar "Tomorrow", `#home` with the dock, `#maps` with the two pinned dots and no unplaced row, `#notes`, `#music`, `#photos`), `/album` (the Us row, a month hero with its month over it, the edge grid, the lightbox on a photo and on a clip), `/us` (chapters, moments, places without the roof, her words with the action stripped), `/state#now` (the human fields, Advanced closed and open), `/state#inbox`, `/model` (the group index, two groups, the save bar; an out-of-range value typed into a field inside a closed Advanced opens it on Save), `/images#places` ("Not on the map" with the bench), `/timeline` (words, then the log; the owner-fired picture has no words), `/memory`. For `/` and `/phone` once more with `prefers-reduced-motion: reduce`. The checklist, each item looked at on the screenshots and asserted in the page where it can be:
- nothing on a Her page reads "--" as an empty value, "none", "0%", "v33", "proposal", "JSON", an id, a phase, an error code or "Approve"; no empty card anywhere on Her pages;
- no horizontal scroll at 375 (`document.documentElement.scrollWidth <= innerWidth`); the tab bar clears the composer and the safe area; the tab bar hides while the composer has focus and stays hidden when Send is pressed;
- the fonts loaded (`document.fonts.check('16px "Instrument Sans"')` and `'40px Fraunces'` true), and a second page load fetches no `/fonts/` file from the network (the service worker serves them);
- her name is near-white, not gradient; no text anywhere is gradient-filled;
- Tab through each page: every control shows the accent focus ring; the sheets, the reaction bar and the lightbox trap focus and give it back; the tools sheet opens as a popover under the button at 1280 and as a bottom sheet at 390, and is never clipped inside the chat bar;
- her photograph behind the chat and around the phone at 1280;
- every console clean of errors on every page.

Then, after Justin's word and the deploy (not part of this pass), the main session looks at the LIVE app with her real data at both widths and fixes by hand what the real record shows (long place names, many notifications, a chapter with no scene), the way the handoff's "builds vs hand fixes" rule says. Two hand jobs are known now: (1) pin her live places once (Studio > Pictures > Places, "Save pin", or `PUT /api/places/:id { lat, lon, geocodedBy: "owner" }` from the logged-in pane), so her Maps app has dots; (2) before the look, show Justin the wallpaper candidates (13.2): four of her approved pictures (the kitchen, the doorway, the dock and the bench, 2026-09-25) were Claude's test scenes, and the roll and the daily wallpaper now include pictures with no message, so they would rotate onto her lock screen unless he rejects them or picks one.

## 13. Open questions for Justin (each ships with its default)

1. Studio's door: a quiet "Studio" link in the header and in the chat's tools sheet (default), or only in the tools sheet.
2. Her wallpaper: rotates daily among her approved solo photos (default), or one he picks. Before the look: four of those approved photos (the kitchen, the doorway, the dock and the bench of 2026-09-25) were Claude's test scenes, fired without a message; with this pass they enter the roll and the wallpaper rotation. Default: they stay (he approved them for the face); his call to reject any.
3. Pictures of the two of you on her lock screen: never (default; they live in Us and the Album).
4. Her name in the header: sentence case "Avelie" in the display serif, near-white, no gradient (default), or the v4 spaced capitals.
5. On a phone: the bottom tab bar (default), or the v4 scrolling row at the top.
6. "Show the workings" off at every load, as today (default); Keep lives on the heart either way.
7. A single quiet line on Us, "3 things she hasn't told you yet", with no subjects: off (default; the untold facts stay in Studio > Memory).

## 14. Deferred (named so nothing is lost)

- Album art on the now-playing card and in Music: the CSP allows no outside image origin; a same-origin image proxy is new surface, so a glyph stands in.
- A picture per chapter (a cover on the Us page and in the rail).
- Making a place picture from her Maps app (Studio > Pictures > Places keeps it).
- The album, the timeline and the phone's Maps and Notes on the story clock (SPEC_V5 "Deferred"; this pass moves only the lock screen's time, date and calendar words onto it). The lock does not read the scene's own free-text time words ("it is now 3:30pm"); it follows the held clock only.
- A narrow `harden` exception in src/index.ts for long-lived caching of `/fonts/` and approved `/media/` ids (2.9); until then the fonts are cached by the service worker and the Her pages ask for fewer pictures.
- A gazetteer that suggests a pin for a new place from her city's streets (a Studio helper, if hand pins ever become a chore).
- Her day's life-log lines as a dated "Today" note in her Notes app (written by the nightly narrator in its own voice, so they would need her voice first).
- A lip-synced face on calls (SPEC_V4 A, unchanged).
- Swipe between pictures in the lightbox by touch gesture (arrows and keys only in this pass).

## 15. Critic pass (2026-09-26, the ranked findings against 7051696)

All twenty findings were checked against the code and held; each is folded in above (1: 3.3, 3.4 items 6 to 8; 2: section 6, 8.7; 3 and 4: 4.4, 8.5; 5: 2.9; 6: section 9 and rule 4; 7: 2.3, 3.3; 8: 4.5, 7.4, 11, 12; 9: 3.3, 3.4 item 5; 10: section 5; 11: 2.1, 2.2; 12: 4.4, 8.5; 13: 7.1, 8.1, 8.5; 14: 7.3; 15: 8.8; 16: 8.2, 8.7; 17: 12; 18: 2.4, 2.5; 19: 4.2, 8.5, 12, 13; 20: 2.8, 3.3). The scope note is taken: no gazetteer, no reads, knows, guesses or untold on the Her side, no person or narrator notifications, so the server lane is four read modules and the pass stays visual. Taken in part or not taken, with the reason:

- 3, "strip a leading her/my before RELATION_WORDS": moot. With the notification rebuilt from his real last message, no person or life-log entry reaches the lock screen, so `RELATION_WORDS` and `personLabel` are not built at all. Moving the day's log lines into Notes is deferred (14), not built: the nightly narrator writes them in its own past-tense voice ("You are not her"), which would read as her Notes only after a voice pass.
- 5, the `harden` exception for fonts and approved media: not taken in this pass (index.ts stays frozen; the media rule needs a check that a rejected picture is never served from a cache). The service-worker font cache and the smaller picture counts are taken; the exception is named in 14.
- 8, "at most, keep the gazetteer as a Studio suggest-a-pin helper": deferred (14), not built.
- 12, "show the status only when the mood is a sentence that doesn't name him": not taken; the status line is dropped outright (the field is an author or extractor word even when it is a sentence). "Read `/api/clock` for the time": taken server-side instead (the lock route reads the story clock itself and answers `now` and `frozen`), so the page makes one read, not two. The scene's own free-text time words are not parsed (14).
- 13, `syncPeople` on the lock read: resolved by 3 (the lock no longer reads people at all), not by moving the sync.
- 19, "or change question 3": not taken; question 3's default stands and the lock roll filters `us` items (8.5).
- 2, "3 things she hasn't told you": not built by default; offered as open question 7.

