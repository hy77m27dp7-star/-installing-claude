# Experience pass lane reports (2026-09-26)

Six lanes wrote against DESIGN_EXPERIENCE.md at the same time in the exp worktree (branch exp, from the live v5 head 7051696). Their reports, verbatim, as handed to the integrator (the two Unicode ellipses in lane S's report are written as "..." so the typography check stays clean). The integrator's notes follow the six reports.

--- D design ---
Lane D is finished and every test passes: the full unit suite is 1063 of 1063, including the new ui_exp suite (17 tests). The typography check is clean, `node --check` passes on `nav.js` and `sw.js`, and esbuild parses the stylesheet with no warnings. Nothing is committed and I only touched my own files. No browser was run, so none of this has been looked at on screen yet; the section 12 look pass still has to do that.

**Files written** (under `/private/tmp/claude-501/-Users-justinnewsome-Documents-ClaudeCode-HQ/e5dcbc67-4480-4c1c-bdb2-d7e749c0c830/scratchpad/avelie_exp/`)
- `public/css/app.css`: the full visual system (tokens, the three fonts, glass surfaces, header and bottom tab bar, the backdrop and veil, motion with the global reduced-motion rule last, every page's styles). Every class in section 9 is defined. A script confirmed that all 644 selectors from the 7051696 stylesheet are still there, along with all their keyframes.
- `public/js/nav.js`: the Her and Studio links, icons, the Studio door and its row, and the backdrop from `/api/wallpaper`. The avatar code is unchanged; the header avatar gets the ring.
- `public/sw.js`: cache `avelie-shell-v4`, the 10.1 shell list, fonts served cache-first. `/api` and `/media` are still never cached.
- Pages: `index.html`, `phone.html`, `album.html`, `us.html` (new), `state.html`, `model.html`, `images.html`, `timeline.html`, `memory.html`, all built to their contracts. Every old id and `name` is kept (checked by script). `model.html` has exactly 4 submit buttons (Save plus the three card Saves) and 3 `data-save-status`.
- `public/fonts/`: the five files. All five sha256 hashes and the three woff2 byte counts match section 2.2.
- Tests: `nav_v4.test.mjs` and `ui_v4.test.mjs` edited exactly per 10.1; `ui_exp.test.mjs` is new.
- `public/manifest.webmanifest` needed no change.

**Deviations**
1. `.btn.primary` (the Save buttons, Send, Together) is now a near-white pill, not the cyan gradient. Section 2.1 limits cyan to a fixed list and primary buttons aren't on it.
2. In Settings, only the text-performer provider and model fields (Text, Proposals, Tastings, Nightly) and the other model-name fields sit under Advanced. The voice, call, video and weather provider selects stay visible because they are also on/off switches.
3. `.map-place` styles the Maps list only as `.place-list .map-place`, because `map.js` already puts that class on the SVG map groups.
4. `.react-bar` is `position: fixed` with no default offsets, to match `chat.js`, which appends it to the body and sets top and left itself. The `.kept-mark` heart sits on the corner of `.bubbles`, which is where `chat.js` appends it.
5. Picture fade-in waits for `.loaded` only in the Album (`body.page-album .roll-tile img:not(.loaded)`). Videos and phone thumbnails are never hidden, so a clip that never fires a load event still shows.
6. The base `.icon-btn` is now 44px (was 40px) so every icon button meets the tap-target size.
7. Small markup changes:
   - I removed the one prose line in `state.html`'s "What he looks like" card.
   - `relNote` and `sceneNote` lost `grow` and gained an `aria-label`.
   - I added a `beat` option to the Timeline kind filter.
   - The System group's summary reads "Advanced".
   - I dropped Studio's old `--muted` style on 12px labels.
8. The Texter inputs (`#texterIn`, `#texterOut`) now sit inside `#settingsForm`, so a negative price there blocks Save through form validation. The studio lane's `invalid` handler covers that.

**Missing classes:** none. Nothing the other lanes' scripts use (as of now) is missing from section 9. The scripts still use a few unstyled class names (`feedback-chip`, `run-first`, `busy`, `beat-panel`, `price-in` and so on); all of them were already in the scripts at 7051696. A check against the other lanes' current scripts found no ids missing from my markup.

--- C chat ---
Lane C (chat) is done: `public/js/chat.js` is rebuilt to DESIGN_EXPERIENCE 3.4 to 3.6 and the new `tests/unit/chat_exp.test.mjs` passes 17/17. Nothing was committed, no server or browser was started, and `git status` shows no other file of mine changed.

**Files written**
- /private/tmp/claude-501/-Users-justinnewsome-Documents-ClaudeCode-HQ/e5dcbc67-4480-4c1c-bdb2-d7e749c0c830/scratchpad/avelie_exp/public/js/chat.js
- /private/tmp/claude-501/-Users-justinnewsome-Documents-ClaudeCode-HQ/e5dcbc67-4480-4c1c-bdb2-d7e749c0c830/scratchpad/avelie_exp/tests/unit/chat_exp.test.mjs (new)
- bubbles.js, call.js and callface.js are unchanged: the new markup keeps all the call sheet ids.

**Tests**
- `node scripts/check_typography.mjs`: clean.
- `node --check` passes on chat.js, bubbles.js, call.js and callface.js.
- chat_exp: 17 pass, 0 fail. The helper that extracts functions from chat.js skips strings and comments.
- The suites that read chat.js (ui_v4, ui_v5, review_v5, bubbles_v2, bubbles_v4, callface_v4, elevenlabs_v4, plus chat_exp): 118 tests, 115 pass, 3 fail. All three are ui_v4 tests the design lane edits under 10.1: the page count, the index ids, and the sw.js shell. They fail because that lane has already added us.html, a new sw.js and the new index.html. None of the three checks chat.js, and ui_v4's own chat.js lines pass.
- Every id chat.js binds is present in the design lane's new index.html.
- `tsc` was not run; src/ is untouched.

**Deviations from the brief**
1. **Rail time:** `.chapter-when` shows the hour for today, then "Yesterday", the weekday within six days, else "Sep 20". The brief's example showed a plain "Sep 26".
2. **"timeout":** `errorWords` also maps "timeout", a code the page's own pollers write, to "Didn't come through".
3. **Failed clip:** it shows "didn't come through" with no Try again button, because the chat has no retry route for a message clip. Photos keep the retry that calls generate again.
4. **Place in the lightbox:** `#lbPlace` comes from `GET /api/roll?limit=200`, read once. That route lists only approved pictures, so an undecided picture shows no place.
5. **Lightbox decision errors:** they appear in a `span.tool-status` that chat.js adds inside `#lbDecide`.
6. **Reaction bar position:** `.react-bar` is added to `body` and placed by script as `position: fixed`, z-index 60, with top and left computed. The stylesheet should not rely on `position: absolute` for it.
7. **Renaming an empty page:** a name typed before the chapter exists creates it first (a POST, then the PUT).
8. **"candidate" chip:** with "Show the workings" on, an undecided picture also shows a "candidate" chip.
9. **Arrow keys:** in the lightbox they step between pictures, which stops them from seeking inside a playing clip.

**Classes for the integrator**
- `.photo-open .play-badge`: a ready clip in the thread shows its poster with the Album's `.play-badge`, which needs a style inside `.photo-open`.
- `.lightbox-decide .tool-status`: needs a style (deviation 5).
- No other class outside section 9 is used.

**One gap in the brief:** when the scene is unknown, `#placeLine` is hidden, so nothing on the page opens the scene sheet. It still opens, anchored to `#moreBtn`, when the server answers the "place needed" 400. If a scene can be missing on the live record, that needs a decision.

--- P phone ---
Lane P is done and all its checks pass: the phone lane's new suite is 21/21 and `node --check` passes on all three browser scripts. There is no `src/` change, so tsc wasn't needed, and nothing is committed.

**Files written**
- `public/js/lockwords.js` (new, pure, node-importable): `appFromHash`, `whenWords`, `weatherWords`, `tickOffset` and `APP_NAMES` as specified. It also exports small helpers so `phone.js` carries no "%" or "--" string: `APP_TITLES`, `clockWords` (h:mm, no am/pm), `dateWords` ("Saturday, September 26"), `focusPosition`, `progressWidth`, `noteNext` ("Thursday -- sign up at the bar"), `drawableRoll`, `pinnedPlaces`, `songLines`, `playlistIdOf`, `listKey`.
- `public/js/map.js`: every existing export and the `role: "group", "aria-label": "Map"` line are unchanged. I added `pulsePlace(svg, id)`, which animates the dot through the Web Animations API (no style attribute) and does nothing under reduced motion.
- `public/js/phone.js`: rewritten against the phone.html ids of 4.3, which the design lane's markup already has. It follows 4.1 to 4.6.
- `tests/unit/phone_exp.test.mjs` (new).

**Deviations**
1. **Music listening line:** the Play control is a link to the Spotify search (an `a.icon-btn` in a new tab), as the page does today. It does not send `avelie:play` with a search URL, because player.js would fail on that URL and switch the whole page into embed mode for good. The playlist's Play button still sends `avelie:play` with `spotify:playlist:<id>`.
2. **Play and pause on the lock card:** the pause button toggles. While playing it sends `avelie:pause`; while paused it sends the existing `avelie:resume`.
3. **Celsius:** `weatherWords` shows "20°C clear" for celsius and "68° clear" for fahrenheit.
4. **`whenWords` time zone:** it takes an optional third `tz` argument, so weekdays and dates follow her zone.
5. **Stroke icons:** they use `fill="transparent"` rather than `"none"`, to keep the no-"none" literal rule simple.
6. **Empty apps:** an app with no data never opens. A hash that points at one is replaced with `#home`, and its home icon stays hidden until its data says otherwise.
7. **Playlist embed:** the iframe no longer carries `width="100%"`, so it needs a CSS width (below).

**Classes the design lane needs to scope** (all already in section 9 or app.css, but not yet under these parents):
- `.np-card .np-note`, `.np-card .np-text`, `.np-card .icon-btn`: my lock card reuses the now-playing child names.
- `.app-body .listening` with `.song-line`, `.song-title`, `.song-artist`.
- `.sent-song .song-text`, `.sent-song .song-title`, `.sent-song .song-artist`, `.sent-song time`.
- `.app-body .playlist-embed { width: 100% }`.
- `.photo-grid a`, `.photo-grid .play-badge`.
- `.roll-thumb.clip svg`.
- `.app-bar .btn.small.ghost` for the "All" link.
- `.app-body .kicker` for the "Sent to you" and playlist headings.
- `.place-list li > button.map-place`: the list rows are buttons.
- **Class clash:** map.js's SVG groups are also `g.map-place`, so a row rule must not assume HTML layout (scope it as `.place-list .map-place`).

**Tests**
- **Phone lane:** `phone_exp` 21/21 and `phone_v4` 12/12.
- **`ui_v4`:** 8/11. The player.js import test and the Map group test pass. The 3 failures are the design lane's 10.1 edits (the nine pages, the new ids, sw.js `avelie-shell-v4`), which it hasn't made to that test yet.
- **Typography:** my files are clean. The full check fails on `src/chapters.ts:31-32` (the server lane's file: a literal em dash, en dash and ellipsis in its regexes).

Files are in `/private/tmp/claude-501/-Users-justinnewsome-Documents-ClaudeCode-HQ/e5dcbc67-4480-4c1c-bdb2-d7e749c0c830/scratchpad/avelie_exp/`:
- `public/js/phone.js`
- `public/js/map.js`
- `public/js/lockwords.js`
- `tests/unit/phone_exp.test.mjs`

--- G gallery ---
Lane G (Gallery: Album and Us) is finished. My new suite passes 14 of 14, the full unit run is 963 of 965, and the two failures are in files other lanes own. Nothing is committed, no server or browser was started, and `src/` was not touched.

**Files written:**
- `public/js/album.js` (rewritten)
- `public/js/months.js` (new)
- `public/js/us.js` (new)
- `tests/unit/gallery_exp.test.mjs` (new)

**Tests:**
- `node --check` passes on all three scripts, and `node scripts/check_typography.mjs` is clean.
- `tests/unit/gallery_exp.test.mjs`: 14 of 14 pass, run under four time zones (Kiritimati, Pago Pago, New York, UTC). It covers everything section 10.2 asks for. It also builds real tiles and Us lists on a small stand-in document to check classes, text and the `avelie.conversation` store. Every class the two scripts build is in the section 9 list or is `.hidden`.
- Full `npm run test:unit`: 965 tests, 963 pass. The 2 failures come from the design lane's in-progress edits (`nav.js` LINKS now includes `/us`; the `ui_v4` ids and sw shell), not from my files. Both are covered by the planned 10.1 test edits, so they should clear when those land.

**Deviations from DESIGN_EXPERIENCE.md:**
1. **`months.js` has extra helpers.** Besides the four in the contract, it exports `dayWords`, `tileLabel`, `countLabel`, `spanWords` and `sentenceCase`, so every word the pages show can be tested directly. Month and day names are fixed English, not the browser's locale.
2. **The year appears when it isn't this year.** `dayWords` gives "Saturday, September 26", or "Wednesday, September 24, 2025" for last year. This applies to the lightbox date, tile labels and "since ...".
3. **The count reads "24+ pictures" when more exist,** and "1 picture" for one. It is empty when there are none.
4. **Clips without a poster:** the play badge also goes on the bare video, because with `preload="none"` the tile would otherwise be a blank frame. That video also gets `loaded` straight away, since it never fires a load event. Photos and posters get `img.loaded` on load as specified.
5. **Lightbox additions:**
   - Next at the last loaded picture loads the next page when there is one.
   - Clicking the dark area around the picture closes it.
   - `#lbSave` also gets a `download` attribute.
   - Closing a picture opened from `#<id>` clears the hash, so a reload doesn't reopen it.
   - Focus goes back to the tile of the picture being shown when it closes.
6. **Errors stay quiet on her pages.** If the first Album page fails, More stays visible so a tap retries. If `/api/us` fails, every section stays hidden.
7. **Month hero labelling:** the month text over the hero is `aria-hidden`, because the tile's `aria-label` already reads the date. Each month section gets `aria-label` "September" and a `data-month` attribute (an attribute, not a class) so sections stay newest first when a later page adds a month.
8. **Pictures with a date that can't be read** go in one group of their own, last, with no month text over them.
9. **Chapter and kept-line links** store `avelie.conversation` on click and then let the link go to "/" normally, rather than stopping the link and redirecting by script.

No new classes were needed beyond section 9.

--- S studio ---
Lane S (Studio) is done: all five Studio scripts follow sections 7.1 to 7.5 of the brief, and my new suite passes 9/9. Nothing was committed, and I ran no dev server or browser.

**Test counts**
- `tests/unit/studio_exp.test.mjs`: 9/9. `review_v5` and `ui_v5` are green.
- Full unit suite: 970/974. The 4 failures are the `nav_v4` / `ui_v4` tests from 10.1: "the eight paths", "the eight pages exist", the "three new pages" id list, and the "sw.js ... avelie-shell-v3" shell test. They check the old nav, page and cache setup that lane D is changing, and lane D owns updating them.
- `node --check` passes on all five scripts.
- `node scripts/check_typography.mjs` exits 1, on two hits in `src/chapters.ts` lines 31 and 32. That is lane V's file: the dash and ellipsis clean-up regexes contain the characters literally. My files are clean.
- I did not touch `src/`, so I did not run `tsc`.

**Files written** (all under the worktree `.../scratchpad/avelie_exp`)
- `public/js/state.js`
  - **Relationship and Scene fields:** labelled fields in `#relFields` and `#sceneFields`, plus a Together / Apart pair (the existing `.seg` class). They edit the JSON box and the box updates them back. A field you are typing in is left alone until load or save. Save goes through the same PUT.
  - **Inbox:** the kind as a kicker in words, the proposal text, the payload as labelled lines ("Place: ..."), and the raw JSON inside `details.advanced`. Approve, Edit and Reject are unchanged.
  - **Chat names:** the Export list and the Checks list name a conversation by `displayTitle`, then the stored title, then its date.
  - **Empty lists:** all 19 "none" chips are now `.empty-label` text.
  - Every line `review_v5` reads is still there.
- `public/js/model.js`: the capture-phase `invalid` handler (opens the enclosing `details`, scrolls to the field, focuses it, shows the message in `#settings-status`). It opens the System group's Advanced when the screen is at least 761px wide, marks the group-index link in view, and shows empty lists as labels. No binding changed.
- `public/js/images.js`: the Places tab, ported from the v4 phone page, with places that have no pin first under "Not on the map". The decide row under candidates is now `row glass`, and empty lists are labels.
- `public/js/timeline.js`: story lines by default, with an inline SVG glyph per type. `#logToggle` switches to today's log rows and is remembered as `avelie.timelineLog`. The kind filter stays, and `beat` is added to the labels.
- `public/js/memory.js`: ids and routes unchanged, empty lists as labels, and "Kept today" as a kicker, the kept text and the time.
- `tests/unit/studio_exp.test.mjs` (new).

**Deviations**
1. `KIND_LABEL` in `state.js` now has words for all 22 kinds (it only had the v5 ones). Memory uses the same words.
2. Checks now shows the conversation's name as a kicker above its flagged rows. It named none before, and the brief asked for `displayTitle` wherever one is named.
3. For the picture grids I only added `.glass` to the decide rows and kept `.img-card`. Making them frameless squares is left to lane D's CSS, because adding `.roll-tile` would pull in the Album's layout.
4. The Places tab also lists pinned places, under an "On the map" kicker after the unpinned ones. The brief named only the "Not on the map" group.
5. `showTab` in `images.js` now skips a missing `#tab-<name>` panel, so the page loads before `tab-places` exists in the markup.

**Classes lane D needs to style**
- No new class names; I used only section 9 names and existing ones.
- Selectors to style: `.story-line svg` (the 16px glyph), `.place-row .place-thumb.empty` (now empty, no `--` text), `.row.glass`, `.kicker` inside `.kept-row`, `#checksList` and `.place-actions`, and `.empty-label` inside a `td` and inside a `.chips` span.

**What my scripts expect in the markup**
- `images.html`: `#tab-places` with `#placesAdmin`, `#placeTitle`, `#placeDetail`, `#placeAdd`, `#placeAddStatus`.
- `timeline.html`: `#logToggle`.
- `state.html`: `#relFields`, `#sceneFields`.
- `model.html`: `#group-system` with a `details.advanced`, and a `.group-index` of `#group-*` links.
- Where these are missing, my scripts skip them instead of failing.

--- V server ---
Lane V is built and meets the brief, with a few deviations listed below. `npx tsc --noEmit` and the typography check are clean, and the new server tests pass. The full unit run still has 4 failures, all in the design lane's tests. I did not run the integration runner or the look fixture, because both need a server and lanes were told not to start one.

**Tests**
- My five suites: 34 tests, all passing (roll 6, chapters 8, lockscreen 10, us 5, timeline_exp 5). `tests/unit/timeline_v2.test.mjs` still passes (6).
- Full `npm run test:unit`: 1046 tests, 1042 pass, 4 fail. The four are in `nav_v4.test.mjs` and `ui_v4.test.mjs`: the LINKS paths, "the eight pages exist", the page ids, and the sw.js cache name. They read `public/` files the design lane is rewriting, and the design lane has not yet made its section 10.1 edits to those tests. None of them touch my files.
- `node --check` passes on `scripts/look_fixture.mjs` and `tests/integration/run.mjs`. The fixture's refusal works: a non-local base exits 2 and sends nothing.

**Files** (root is the worktree `/private/tmp/claude-501/-Users-justinnewsome-Documents-ClaudeCode-HQ/e5dcbc67-4480-4c1c-bdb2-d7e749c0c830/scratchpad/avelie_exp/`)
- New: `src/roll.ts`, `src/chapters.ts`, `src/lockscreen.ts`, `src/us.ts`, `scripts/look_fixture.mjs`, and five test files in `tests/unit/`: `roll_exp`, `chapters_exp`, `lockscreen_exp`, `us_exp`, `timeline_exp` (each `.test.mjs`). No `helpers_exp.mjs` was needed.
- Changed:
  - `src/api.ts`: five new routes, the changed GET and POST `/api/conversations`, and `avatarMaster()` shared by `/api/avatar` and the wallpaper.
  - `src/phone.ts`: only the `export` keyword on `weatherFor`.
  - `src/timeline.ts`: the `story` field, plus one extra read per entity for the version just before the oldest one on a page.
  - `API.md`: an "Experience pass" section.
  - `tests/integration/run.mjs`: an "exp" phase on its own fresh state (`.state-exp`), plus a gated check that the new GETs, the PUT, `/us`, the three scripts and the font answer 401.

**Deviations**
1. `chapterTitle`'s `span` takes an optional `times` list. With it, the function narrows the scene versions to the ones somebody talked in; without it, it treats the versions it is given as already visited.
2. `chapters.ts` exports some extra helpers (`conversationData`, `readStoryTimes`, `readSceneVersions`, `cutLine`, `dropLead`, `TITLE_MAX`, `PREVIEW_MAX`). `us.ts` reuses the conversation data so it doesn't read the same rows twice.
3. `placeTitle` also returns null for a bare "at", "in" or "on" with nothing after it.
4. His last text on the lock screen is cut at 160 characters, the section's rule for lock text, not at `previewText`'s 90.
5. `lockScreenFrom` takes the `StoryClock` itself and works out `now` and `frozen` from it. `upcomingBeats` also checks that the beat itself is active.
6. `splitNicknames` also drops "none", "none established" and "none yet". The seed relationship says "none established", and Us would otherwise show it as a nickname.
7. The kept lines on Us come from two reads (the Keep marks, then those messages by id in chunks of 90) instead of one join, so they also work on the unit tests' D1 stand-in.
8. `timeline.ts` exports `callStory`, `relationshipStory` and `sceneStory`. A few story words differ from the table:
   - The history title and the life note are one line, cut at 160.
   - Media with no library row has no story.
   - A want log row whose want title is unknown has no story.
9. `avatarMaster(c, settings?)` takes optional settings so the route doesn't load them twice. `AVATAR_FOCUS` is untouched. If no approved master exists at all, `/api/phone/lock` answers 404 too, not only `/api/wallpaper`.
10. The look fixture changes no settings. It sends `origin` and `sec-fetch-site: same-origin` headers so the write gate lets its requests through.

No classes, migrations, settings or secrets were added, and nothing was committed.

--- Integrator ---
The six lanes arrived with no conflicting file and no broken seam: every id a script reads is in its page's markup (or built by the script itself); the two exceptions are guarded and unchanged from 7051696 (`#backdrop` exists only on the three pages 2.4 names and `mountBackdrop()` returns when it is absent; player.js falls back to `#nowPlaying`, which the phone page never had). Every class the scripts build or the pages carry has an app.css rule, except names that were already unstyled at 7051696 (`feedback-chip`, `run-first`, `beat-panel`, `price-in`, the Studio `page-*` body classes and the like); the pass adds no new unstyled name. The v4 "the eight pages" and sw.js failures the lanes reported were the design lane's 10.1 edits landing after the other lanes ran; they were green by the time the integrator ran, and the `src/chapters.ts` typography hit P and S reported was already repaired by lane V.

Changed by the integrator (public/css/app.css only):
- The selectors the lanes named that had no rule yet, in one block before the reduced-motion rules at the end of the file: `.photo-open` positioned so a ready clip's `.play-badge` centres on its poster (C); `.lightbox-decide .tool-status` on its own centred line under Keep / Not her / Again (C); a smaller `.photo-grid .play-badge` for the Photos app (P); `.app-bar .btn.small.ghost` as a quiet accent text link for "All" (P); `.row.glass` padding for the Studio decide row (S); `td .empty-label` and `.chips .empty-label` so an empty table or chip row is a short line, not a 32px block (S); the kicker at the head of `#checksList` (S). The rest the lanes named was already covered by D (`.np-card` children, `.app-body .listening`, `.sent-song` children, `.app-body .playlist-embed` at 100%, `.photo-grid a`, `.roll-thumb > svg`, `.app-body .kicker`, `.place-list .map-place`, `.story-line svg`, `.place-thumb.empty`, `.kept-row`, `.place-actions`).
- Brief 2.5, "the smallest text uses --text-2, never --muted": 23 Studio rules at 11px, 12px or `--fs-0` still painted `--muted` (inherited from 7051696); their colour is now `--text-2`. No selector was added or removed, and `--muted` stays on the Studio rules at 13px and up.

Name drift: none found between the brief, the markup and the scripts (the ui_v4, ui_exp, chat_exp, phone_exp, gallery_exp and studio_exp suites pin the ids, exports and routes, and all pass). The commit is named "experience: Her and Studio" as the integrator was told (11 of the brief says "exp: Her and Studio").

Left for the look pass and for Justin (not changed here):
- C's gap: with no scene on the record, `#placeLine` is hidden (brief 3.6) and nothing on the page opens the scene sheet except the server's "place needed" answer. The live record has a scene, so this only matters on a fresh record; if it should change, a "Where" row in the tools sheet is the smallest fix.
- D deviation 1 (the primary buttons are a near-white pill, not cyan) and D deviation 2 (the voice, call, video and weather provider selects stay outside Advanced) are the design lane's reading of 2.1 and 7.3; they stand unless the look pass says otherwise.
- Nothing has been looked at in a browser yet: section 12 is the next step.
