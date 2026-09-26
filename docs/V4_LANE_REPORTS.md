# v4 lane reports (2026-09-26)

Eleven lanes wrote against SPEC_V4.md at the same time in the v4 worktree. Their reports, verbatim, as handed to the integrator.

--- L0 Design pass: tokens, the shell with her face, the thread look, every page ---
LANE L0 REPORT (design pass: tokens, the shell with her face, the thread look, every page)

Worktree: /private/tmp/claude-501/-Users-justinnewsome-Documents-ClaudeCode-HQ/e5dcbc67-4480-4c1c-bdb2-d7e749c0c830/scratchpad/avelie_v4 (nothing committed, nothing deployed, no dev server, no browser).

FILES WRITTEN (all under public/)
- css/app.css (1628 -> 2244 lines): the token layer on :root; the brand shell (.brand, .avatar, .avatar.lg); the phone-width nav as one scrollable row; the thread (her bubbles as a 28px-avatar grid, .msg-avatar / .msg-spacer, typing avatar, photo bubble at 280px, .audio-note bar, song status slot, .chip.us, video bubble, the place background); the now-playing strip; the phone drawer; #callFace frame with stacked videos and the 4 s breathe pulse; the avatar picker and the call face card; the phone panel (map, dial, meters, listening line, places list); the album (.polaroid); the memory page (tiles, phases, envelope, timeline, kept rows); the Spotify card and #herTextsBtn; widths; reduced motion.
- js/nav.js (rewritten): LINKS, AVATAR_FOCUS, avatarFocus, mountAvatar, avatarImg; load-time nav build kept; mountAvatar() runs at load.
- index.html: the shell; #phoneBtn in the thread bar; aside.drawer.phone-drawer#phoneDrawer with #phoneClose and #phoneDrawerBody; #callFace above #callCaptions in the call sheet; the now-playing strip #nowPlaying (#npTitle, #npArtist, #npProgress, #npTime, #npPause, #npNext) between the thread and the composer.
- phone.html (new): main.page.phone with #phoneStatus, #phoneNow, #phoneWhere, #phoneWeather, #phoneOutfit, #phoneMood (.dial-wrap), #phoneWants, #phoneAsks, #phoneToday, #phoneListening, #phoneMap, #mapFoot, #placesList, #placesStatus, plus an add form (#placeTitle, #placeDetail, #placeAdd, #placeAddStatus). Loads /js/phone.js.
- album.html (new): main.page.album with #albumStatus, #albumFilter (buttons data-group=all|approved|candidates|us, aria-pressed), #albumGrid, #albumOlder. Loads /js/album.js.
- memory.html (new): main.page.memory with #memoryStatus, #memoryLegend, #memoryFacts, #memoryFading, #memoryReturned, #memoryHistory, #memorySealed, #memoryKept. Loads /js/memory.js.
- images.html: the shell; #avatarSection with #avatarStatus and #avatarPick (.avatar-pick) at the top of the Photos tab; the Call face card on the Clips tab: #callFaceCard, #callFaceStatus, #callFaceSources (.source-picker.round), #callFaceMake, #callFaceMakeStatus, #faceSlots with #faceIdle/#faceListening/#faceTalking (data-kind, each with a #face<Kind>Body).
- model.html: the shell; #herTextsBtn (aria-pressed) and #herTextsStatus in Her first texts; elevenLabsModel and elevenLabsTtsPricePer1kChars in Voice; callFaceProvider select (clips, off, lipsync) in Calls; videoMarkerEnabled, placeCostUsd, listeningLineEnabled in Images; hisFaceInPhotos in His face; section.card#spotifyCard after the form with #spotifyStatus, #spotifyPlaylist, a#spotifyConnect (href /api/spotify/connect), button#spotifyDisconnect, and the fields spotifyEnabled, spotifyPlaylistName, spotifyPlaylistId, spotifyPlayer carrying form="settingsForm" so model.js's form.elements loop finds them, plus a submit button for the form.
- state.html, timeline.html: the shell only.
- manifest.webmanifest, icons/*: unchanged.

EXPORTS (public/js/nav.js, browser only)
- export const LINKS = [["/", "Chat"], ["/phone", "Phone"], ["/album", "Album"], ["/memory", "Memory"], ["/state", "State"], ["/model", "Model"], ["/images", "Images"], ["/timeline", "Timeline"]]
- export const AVATAR_FOCUS = { "master-00": [50, 40], "master-01": [48, 28], "master-02": [58, 24], "master-03": [50, 32], "master-04": [44, 27], "master-05": [50, 24] }
- export function avatarFocus(assetId): [number, number] (a fresh pair; [50, 30] for an unknown id)
- export function mountAvatar(el?): void (el defaults to #avatar; reads localStorage avelie.avatar {assetId, file}, paints at once from the focus table, then GET /api/avatar {assetId, file, focus}, repaints when it differs, stores the answer; also repaints every img.avatar[data-avatar] on the page, e.g. the phone drawer's head)
- export function avatarImg(size): HTMLImageElement (a new img.avatar with the same src and object-position, width/height attributes and --avatar-size through the CSSOM, data-avatar="her")
- The src is "/" + file (files are images/masters/<name>.png); the default before any answer is master-05. The crop is img.style.objectPosition, never a style attribute.

CROSS-LANE CSS CONTRACT (all defined in app.css)
- L1: .map (svg, 3:2, --bg-2 ground), .map-water, .map-land (--panel-2 fill, --line-2 stroke), .map-dot (--accent-solid), .map-dot.here (map-pulse, off under reduced motion), .map-label (--fs-0, --text-2, halo stroke), .map g[tabindex] focus ring, .map.armed (crosshair), .map-pin; .dial (rotated -90deg, 88px), .dial-track, .dial-fill (stroke-dasharray is the script's attribute); .dial-wrap / .dial-text / .dial-mood / .dial-age; .phone-now (.clock .day .tod), .phone-line (.k .v), .weather-line, .want-meter, .listening (.np-note .song-text .song-title .song-artist .song-line), .place-row (.place-thumb[.empty], .place-text, .place-title, .place-detail, .place-coords, .place-actions, .inactive), .phone-cols.
- L2: #callFace (square min(80vw, 320px)), #callFace video (absolute, cover, opacity 0 by default; opacity via the CSSOM or class "on"), #callFace .face-pair[.active], #callFace .avatar (160px, animation breathe 4s), #callFace .face-word; @keyframes breathe; .avatar-pick button[aria-pressed] with --avatar-ring; .source-picker.round; .face-slots / .face-slot (.face-kind, video square, .clip-pending).
- L5: .album-grid (2 / 3 at 761px / 4 at 1101px), .polaroid (.shot, img|video 3:4, .pfoot, .pdate button, .pactions, .corner, modifiers .candidate .us), .chip.candidate, .chip.place, .chip.us; .filter-chips for #albumFilter.
- L6: .msg.hers grid with .msg-avatar (first of a run) and .msg-spacer or .msg-avatar.spacer (the rest); .typing .msg-avatar; .song-card .song-status, .song-retry, .song-play[aria-pressed], .song-embed; .video-bubble (video|.video-pending 9:16 up to 280px, .video-links); .now-playing (.np-note .np-text .np-title .np-artist .np-progress .np-time); .drawer.phone-drawer; the place background: chat.js sets thread.style.setProperty("--place-url", "url(/media/place/<id>)") and removes it when apart.
- L7: .memory-legend; .phase-vivid/.phase-firm/.phase-fading/.phase-faded (four opacities of the one accent, on .chip, .tile, .mem-node); .memory-field; a.tile.low|mid|high (.subject .text .tile-foot, .chip.back); .tile.envelope with .chip.sealed; .mem-list / .mem-row (.text .age); .mem-timeline / .mem-node (.title .when); .kept-row (.text .when).
- L4: #spotifyCard .spotify-row, #spotifyPlaylist .name, #herTextsBtn[aria-pressed="true"].

CONTRAST PAIRS (WCAG, computed from the token hex values; AA is 4.5:1 text, 3:1 large text and UI parts)
--text on --bg 16.37; --text-2 on --panel 10.56; --muted on --panel 6.48 (--fs-0 text uses --text-2 everywhere new); --text on --bubble-hers 14.20; --text on --bubble-his 11.75; --text-2 on --bubble-hers 9.77; --text-2 on --bubble-his 8.08; --accent-solid on --bg 10.96 and on --panel 10.27 (links, focus ring); .chip 6.48, .chip.ok 10.02, .chip.amber 9.90, .chip.danger 6.85 (on the chip ground over --panel); white on --place-veil over black 20.03 and over white 12.10, --text on the veil over white 10.00; .map-label --text-2 on --panel-2 9.77 and on --bg-2 10.73; .btn.primary ink #04121a on #14b8a6 7.62 and on #22d3ee 10.50; --text-2 on --field 10.90. Below 3:1 and decorative only: the land outline stroke (--line-2) on the water (1.69). :focus-visible is the existing 2px --accent-solid outline on every interactive element (brand link, nav, map dots via .map g[tabindex]:focus-visible, avatar picker, polaroid controls); tap targets are --tap 44px (album controls and the date button lifted to 40/44px at 600px; avatar picker buttons 56px); no page carries a style= attribute or an inline script; the phone-width nav scrolls inside the header with no page overflow.

DEVIATIONS FROM SPEC_V4, WITH REASONS
1. The place background is painted by .thread's own background (background-image: var(--place-veil), var(--place-url); cover; center; attachment scroll), not by .thread::before. A pseudo-element child of the scroll container either scrolls away with the messages (absolute) or, as a sticky box tall enough to cover the view, adds its height to the scroll range so a short thread scrolls into empty space and "scroll to bottom" lands past the messages. The element's own background is fixed to its box by default while the contents scroll over it, and adds nothing to the scroll range. The rule .thread::before { content: none; } is present but paints nothing. Same contract for L6 (the variable on .thread, nothing when unset: an invalid background-image computes to none); ui_v4 (L9) should assert the .thread background-image line rather than a ::before painter.
2. @keyframes breathe (4 s scale/opacity pulse for the avatar) took the name; the existing 1.2 s box-shadow ring on .icon-btn.recording and .icon-btn.calling was renamed ring-pulse (same look).
3. #callFace video defaults to opacity 0 (the script sets the active one through the CSSOM, or adds class "on"); a default of 1 would show six stacked frames before callface.js runs.
4. The header shell's nav is empty markup filled by nav.js (as the spec's shell shows); the old static fallback links are gone.
5. The typing indicator's avatar is not in index.html markup: chat.js (L6) owns that DOM and prepends avatarImg(28); the CSS (.typing .msg-avatar) is ready for it.
6. Amendment A2: the two ElevenLabs call fields (elevenLabsAgentId, elevenLabsCallPricePerMinute) lost disabled/data-reserved and the "(Reserved)" labels, and the callProvider option reads "elevenlabs"; L4 may drop the reserved branch in model.js or keep it (it no longer matches anything).
7. The album's two-column grid is at phone width with three columns from 761px and four from 1101px (the spec's 760/1100 breakpoints); .polaroid hover tilt is off under prefers-reduced-motion.
8. phone.html carries a small add-a-place form (#placeTitle, #placeDetail, #placeAdd, #placeAddStatus) and #mapFoot beyond the listed ids, for POST /api/places; L1 may use or ignore them.

WHAT I COULD NOT DO
- No browser check at 375px (lanes may not start a server or a browser); the no-horizontal-scroll claim rests on the stylesheet (every new grid uses minmax(0, 1fr), the nav row scrolls inside the header, the map and the call face use min()/100%).
- The integration UI smoke and npm run test:integration were not run for the same reason.

TESTS RUN
- npm test: build:canon, build:voicebank, check:typography (clean), check:assets (all hashes match), typecheck (clean), unit 483 passed / 0 failed.
- npx tsc --noEmit: exit 0 (no missing-module errors at the time of the run; other lanes' modules were present on disk).
- node scripts/check_typography.mjs: clean.
- node --check on every public/js/*.js and public/sw.js: clean.
- node --experimental-strip-types --test tests/unit/bubbles_v2.test.mjs: 10 passed / 0 failed.
- Markup checks by script: the shell markup is byte-identical and appears exactly once on all 8 pages; zero style= attributes and zero inline scripts across public/*.html; every token, every contract class name and every listed id present.

--- L1 Her phone and her places: panel state, the drawn map, place pictures ---
LANE L1 REPORT (her phone and her places; sections 1, 8's places and picture half, A1's panel player)

FILES WRITTEN (all under /private/tmp/claude-501/-Users-justinnewsome-Documents-ClaudeCode-HQ/e5dcbc67-4480-4c1c-bdb2-d7e749c0c830/scratchpad/avelie_v4, nothing committed, no deploy, no dev server)
- src/places.ts (new)
- src/phone.ts (new)
- public/js/map.js (new)
- public/js/phone.js (new)
Nothing else touched.

EXPORTS AND SIGNATURES

src/places.ts
- types: `GeocodedBy = "owner" | "openmeteo" | "map"`, `PlaceLight = "day" | "night"`, `Season = "winter" | "spring" | "summer" | "fall"`, `MapBounds`, `MapView`
- `interface PlaceRow` (the 0008 columns in snake_case; `lat`/`lon` number|null; `geocoded_by: GeocodedBy | null`; `picture_light: PlaceLight | null`; plus two computed optional fields `active?: boolean`, `picture?: boolean` that every db function fills on the way out)
- consts: `PLACE_PREFIX = "places/"`, `PLACE_NEAR_KM = 30`, `PLACE_PROMPT_MAX = 900`, `PLACE_COST_DEFAULT = 0.08`, `PORTLAND_OUTLINE: ReadonlyArray<[number, number]>` (15 points, closed), `PORTLAND_BOUNDS = { latMin: 43.636, latMax: 43.686, lonMin: -70.294, lonMax: -70.232 }`, `MAP_VIEW = { w: 360, h: 240 }`
- `placeTitleNorm(title: string): string`
- `placeSlug(title: string, id: string): string` (lowercase, [^a-z0-9]+ to "-", dash-trimmed, cut at 40, "-" + first 6 chars of the id without its prefix; "The Harbour Bench" + "pl_38edf830605b4fa9bb51" -> "the-harbour-bench-38edf8")
- `placeKey(title: string, id: string): string` (`places/<slug>.png`)
- `project(lat, lon, bounds = PORTLAND_BOUNDS, view = MAP_VIEW): { x; y; clamped?: true }`
- `unproject(x, y, bounds = PORTLAND_BOUNDS, view = MAP_VIEW): { lat; lon }`
- `distanceKm(aLat, aLon, bLat, bLon): number` (haversine; Portland to Boston 165.5 km)
- `isPlaceNearCity(lat, lon, settings: { herLat?; herLon? } | null | undefined, maxKm = 30): boolean` (false without her coordinates)
- `seasonOf(now: Date, tz: string): Season`
- `lightOf(now: Date, tz: string, weather: WeatherNow | null | undefined): PlaceLight`
- `placePicturePrompt(place: { title; detail }, city: string, season: string, light: PlaceLight): string` (the exact sentence; cut at 900 with the "no people" tail always whole)
- `placeCostUsd(settings): number` (placeCostUsd as stored, 0.08 when missing)
- `publicPlace(row: PlaceRow): Omit<PlaceRow, "picture_key"> & { active: boolean; picture: boolean }` (for L8's `GET /api/places` "never the R2 key beyond picture: boolean")
- `syncPlaces(db, threads: LifeThread[]): Promise<PlaceRow[]>` (newest active head per title_norm by created_at then id; thread_id updated only when it differs; INSERT OR IGNORE for a new head; dropped threads keep their row with active false; active first)
- `listPlaces(db): Promise<PlaceRow[]>`, `getPlace(db, id): Promise<PlaceRow | null>`, `findPlaceByTitle(db, title): Promise<PlaceRow | null>`
- `createPlace(db, input: { title; detail?; threadId?; lat?; lon? }, actor): Promise<PlaceRow>` (title 1..300; audit `place.create`)
- `updatePlace(db, id, patch: { lat?; lon?; detail?; geocodedBy?: "owner" | "map" }, actor): Promise<PlaceRow>` (lat -90..90, lon -180..180, both or neither, 400 `validation`; 404; audit `place.update`)
- `geocodePlace(env, db, settings, id, actor): Promise<PlaceRow>` (query = title cut so ", city" rides under weather.ts's 80-char cap; first result within 30 km kept as geocoded_by `openmeteo`; 404 `no_match` on none and on a 400 from geocode; 502 passes through; audit `place.geocode`)
- `touchPlaceStmt(db, id, now: Date | string): D1PreparedStatement`
- `makePlacePicture(env, db, settings, args: { id; remake?; actor; now?; weather? }): Promise<PlaceRow>` (404; 409 `already_generated`; 503 `provider_not_configured`; 402 `price_unknown` when placeCostUsd is 0 on a keyed provider; `assertBudget`; `generateFromText`; sha256; R2 put at `places/<slug>.png`; one batch: picture columns + model_runs kind `place` + usage row + audit `place.picture`; old object deleted after the new one only when the key changed; a failed provider call writes a failed run row; no visual_assets row)
- `deletePlacePicture(env, db, id, actor): Promise<PlaceRow>` (audit `place.picture_delete`)
- `servePlacePicture(env, db, id): Promise<Response>` (image/png, `private, no-store`, 404 without a picture or object)

src/phone.ts
- `interface PhoneState` (exactly the section 1 shape; `mood.phase` typed `Exclude<MoodPhase, "none">`), `type Listening = PhoneState["listening"]`
- `LISTENING_PREFIX = "Name one real song"` (L4's copy in src/providers/stub.ts line 45 is byte-equal), `LISTENING_MAX_TOKENS = 120`, `LISTENING_CACHE_PREFIX = "listening:"`, `LISTENING_USER`
- `cleanTypography(s: string): string`, `listeningFacts(facts: FactRow[]): FactRow[]` (scope avelie, subject music/singing/film/everyday, approved, max 12)
- `listeningSystem(facts: FactRow[]): string` (starts with the prefix; names no artist; contains no "his")
- `parseListening(text: string): { artist; title; line } | null` (plain, fenced or wrapped JSON; fields 1..120; line typography-cleaned and cut at 90)
- `localDayKey(now, tz): string`, `listeningCacheKey(now, tz): string` (`listening:<YYYY-MM-DD>` in her tz)
- `readListening(db, key): Promise<{ hit: boolean; value: Listening }>` (`{"none":true}` is a hit with null)
- `listeningNow(env, db, settings, now = new Date()): Promise<Listening>` (switch off -> null; cache hit -> value; else one call on settings.provider/model, maxTokens 120, effort low, temperature 0.9, cacheable false, `estimateUsd` + `assertBudget` with 402 -> null and nothing written; model_runs kind `listening` + usage row + cache row in one batch; a refusal or unparsed answer cached as none; never throws)
- `phoneState(env, db, settings, now = new Date()): Promise<PhoneState>` (threads first, then one Promise.all over weather with the 3.5 s race, todayRows, listAssets approved, both current states, listWants active, listAsks open, syncPlaces, listeningNow; every read a nicety with a fallback; mood null when phase none, `fraction = min(1, ageDays / (2 * days))`; `here` by a together scene's location, else the whereabouts label; wants capped at wantsShown; map outline projected)

public/js/map.js (no top-level DOM, location or fetch; imports under Node)
- `PORTLAND_BOUNDS`, `MAP_VIEW`, `DOT_R = 6`
- `project(lat, lon, bounds?, view?)`, `unproject(x, y, bounds?, view?)` (verified equal to src/places.ts on the same points)
- `outlinePath(points, bounds?, view?): string`
- `drawMap(container, state, opts: { onTap?: (lat, lon, pt) => void; onPlace?: (id, place) => void }): SVGElement` (one `svg.map[viewBox="0 0 360 240"][role=img][aria-label=Map]`, `rect.map-water`, `path.map-land`, per pinned place `g.map-place[tabindex=0][role=button][aria-label=title]` holding `circle.map-dot[r=6]` (`.here` on the here place) and `text.map-label`; a tap converts through unproject when onTap is armed; the svg gets class `armed` then; never a style attribute)

public/js/phone.js (page code only when `main.page.phone` exists; nothing fetched at import time; imports under Node)
- `renderPhone(container, state, opts?)`; opts `{ full?, reload?, readOnly?, places?, tap? }`. L6's call `renderPhone(panel, phone, { places: false, tap: false, readOnly: true })` gives the read-only drawer (map drawn, no tap, no places list); the page passes `{ full: true, reload }`. Fills `#phoneStatus #phoneNow #phoneWhere #phoneWeather #phoneOutfit #phoneMood #phoneWants #phoneAsks #phoneToday #phoneListening #phonePlayer #phoneMap #placesList #placesStatus` (L0's phone.html carries these ids except `#phonePlayer`, which the renderer creates when missing, as it creates every slot inside the drawer).
- `moodDial(mood): SVGElement` (`svg.dial` > `circle.dial-track` then `circle.dial-fill` with `pathLength="100"` and `stroke-dasharray="<arc> 100"`, `data-fraction`; colours and the -90deg turn from L0's `.dial*` rules)
- Places list: Add row (POST /api/places), per place: Save pin (typed lat/lon, PUT geocodedBy owner), Set on map (arms one tap, PUT geocodedBy map, unarms), Geocode, Make picture / Remake / Remove picture, the thumbnail from `/media/place/:id`, chips for coordinates or `no pin`, `here`, `gone`, the geocode source, `day`/`night` and the season, last use. Refresh every 60 s while visible; `visibilitychange` pauses and reloads.
- A1: `#phonePlayer` renders the playlist embed iframe (`https://open.spotify.com/embed/playlist/<id>`, 352 px) and the queue control (Play -> `avelie:play` `{ uri: "spotify:playlist:<id>" }`, Pause -> `avelie:pause`, Next -> `avelie:next`) plus a now-playing strip rendered from `avelie:player` (state, track name/artist, progress); it never calls Spotify. The playlist id comes from `GET /api/spotify` (L8's route), asked once per five minutes at render time; hidden when not connected or no playlist.

DEVIATIONS FROM SPEC_V4, WITH REASONS
1. PlaceRow carries computed `active?` and `picture?` on top of the columns, and `publicPlace()` exists for L8 to strip `picture_key` from API answers; the spec wanted `active: false` listed and `picture: boolean` exposed, and the columns alone cannot carry either.
2. `createPlace` on a title whose title_norm already has a row applies the given detail/pin to that row and returns it instead of inserting a second row (audit `place.update`): syncPlaces keys everything by title_norm, so two rows for one title would make findPlaceByTitle and the map ambiguous. L8's route still answers 201 with a PlaceRow.
3. `phoneState` awaits `listThreads` first, then one Promise.all (syncPlaces and whereSheIs both need the threads); the spec described a single Promise.all.
4. `mood.fraction` follows the spec's formula `min(1, ageDays / (2 * days))`, which gives 0.25 at one day of a two-day mood; the spec's test line says 0.5. The formula is stated twice and the test once, so the formula won; L9 should align the assertion (or the integrator changes the divisor).
5. The dial's `stroke-dasharray` is two plain numbers (`<arc> 100` on `pathLength=100`): a single number cannot draw one arc (it repeats dash/gap). Still numeric, never `var()`, never a style attribute. My own `transform` on the ring was removed because L0's `.dial` rule already rotates the svg.
6. `listeningSystem` says "from her own taste, never anyone else's" rather than the spec's "never his", because the spec's test asserts the text contains no "his".
7. `makePlacePicture` takes two extra optional args (`now`, `weather`); when `weather` is not passed it fetches it itself with the 3.5 s race, so the day/night word follows `weather.isDay` as section 8 says. Audit actions `place.geocode` and `place.picture_delete` are my names (the spec only said "audited").
8. The A1 queue control dispatches the playlist uri (`spotify:playlist:<id>`) on `avelie:play`, since the panel holds no track uris; L4's player.js must treat a playlist uri as a context (or ignore it). The Play/Pause/Next labels are labels, no prose.
9. Extra exports beyond the spec (placeKey, placeCostUsd, publicPlace, cleanTypography, listeningFacts, localDayKey, listeningCacheKey, readListening, outlinePath, moodDial, DOT_R): all pure or read-only, named here so the integrator can ignore or keep them.

WHAT I COULD NOT DO
- No dev server, no browser (lane rule), so the page was not rendered live; DOM code was syntax-checked and imported under Node only.
- The v4 unit suites (`phone_v4`, `places_v4`) are L9's and do not exist yet; I proved the same claims with a scratch script outside the tree (in scratchpad/l1_scratch/, not committed).
- L0's app.css has no `.playlist-embed`, `.place-card`, `.place-pin`, `.place-thumb`, `.phone-block` or `.map-wrap` rules yet; the panel renders with the existing `.card`, `.row`, `.chips`, `.progress`, `.want-card`, `.ask-row`, `.today-row`, `.now-line`, `.dial*`, `.map*` classes, so those five are cosmetic gaps for L0 or the integrator.

TEST COMMANDS RUN AND COUNTS
- `npx tsc --noEmit`: 2 errors, both in src/spotify.ts (L4: missing `SongRef` in types.ts and `stubSpotifyFetch` in stub.ts, other lanes' files); zero errors in src/places.ts and src/phone.ts.
- `node scripts/check_typography.mjs`: clean.
- `npm run check:assets`: all hashes match.
- `npm run test:unit`: 483 pass, 0 fail (the existing suites; none touch my files yet).
- `node --check public/js/phone.js` and `node --check public/js/map.js`: ok.
- Scratch checks (node --experimental-strip-types, scratchpad/l1_scratch/l1_check.mjs, l1_ui.mjs, l1_db.mjs): project/unproject round trip and clamp, 15 outline points inside the bounds, Portland to Boston 165.5 km, isPlaceNearCity, placeTitleNorm, placeSlug, seasonOf, lightOf, placePicturePrompt (no people, under 900 on a 300-char title with a 2000-char detail), listeningSystem (prefix, no "his", no artist), parseListening (plain, fenced with an em dash cleaned to " -- ", junk), the cache key by her local day, syncPlaces on the fake D1 (same-title newer head moves thread_id, new title inserts, dropped thread kept with active false), phoneState shape on the stand-in (every key, mood fraction 0.25 at one day of two, here by scene, weather 68F on the stub, listening null when off), makePlacePicture on the stand-in with a fake R2 (key `places/the-harbour-bench-38edf8.png`, run row kind place, usage 80000 micro, audit place.picture, 409 without remake, remake ok, 402 price_unknown at 0 on a keyed provider, 503 unconfigured), servePlacePicture 200 image/png private no-store and 404, deletePlacePicture clears the object and columns, geocodePlace 404 no_match on Stubtown and 200 with herLat/herLon 40.7/-74.0 (geocoded_by openmeteo), updatePlace 400 on one coordinate and on 91, clear both, 404 unknown, createPlace normalises and refuses empty or half-pinned input, touchPlaceStmt binds the ISO time, listeningNow on the stub writes one run row of kind listening plus the usage and cache rows, reads the cached value and the cached none without writing, answers null with no writes when the switch is off or the daily cap is 0; map.js project/unproject equal src/places.ts on five points including a clamped one; phone.js imports under Node without touching the DOM or fetching. All passed.

--- L2 The call face: three looped clips, the level meter, the Images page behaviour, clips for messages ---
Lane L2 report (the call face, clips for messages, the Images page behaviour)

FILES WRITTEN (all under /private/tmp/claude-501/-Users-justinnewsome-Documents-ClaudeCode-HQ/e5dcbc67-4480-4c1c-bdb2-d7e749c0c830/scratchpad/avelie_v4; nothing committed, no deploy, no dev server, no browser)
- src/callface.ts (new, 160 lines)
- src/video.ts (edited: startClip args, claimNote/parseClaimNote with kind, pollClip for role callface, startClipForMessage + chooseClipSource + clipPromptText)
- public/js/callface.js (new, 305 lines)
- public/js/call.js (edited: level meter, hisSpeaking, face frame, AudioContext close, the one ElevenLabs branch)
- public/js/images.js (edited: avatar picker behaviour, Call face card, `us` chip)
- Scratch only (not in the tree): ../l2_check.test.mjs in the scratchpad, my own 12-test check.

EXPORTS AND SIGNATURES

src/callface.ts
- `type CallFaceKind = "idle" | "listening" | "talking"`; `const CALL_FACE_KINDS: readonly CallFaceKind[]`
- `type CallFaceProvider = "clips" | "off" | "lipsync"`; `const CALL_FACE_PROVIDERS`; `const CALL_FACE_ROLE = "callface"`
- `const CALL_FACE_RATIO = "960:960"`; `const CALL_FACE_SECONDS = 5`; `const CALL_FACE_DEFAULT_SOURCE = "master-00"`
- `const CALL_FACE_PROMPTS: Record<CallFaceKind, string>` (the three section-2 texts verbatim, 156 to 189 chars, none of the runway_image BODY_WORDS)
- `function isCallFaceKind(x: unknown): x is CallFaceKind`
- `function callFaceSettingsOf(settings): { provider: CallFaceProvider; sourceAssetId: string }` (reads callFaceProvider / callFaceSourceAssetId by key with the spec defaults, so it compiles before L8 adds them to Settings)
- `function callFaceNote(kind: CallFaceKind): string`
- `function callFaceKindOf(notes: string | null | undefined): CallFaceKind | null` (splits on |, trims, reads `callface:<kind>` or `kind:<kind>`)
- `interface CallFaceState { provider; source; clips: Record<CallFaceKind, VisualAssetRow | null>; candidates; generating; ready }`
- `function callFaceStateOf(rows: readonly VisualAssetRow[], settings): CallFaceState` (pure; ready only when provider is clips and all three approved)
- `async function callFaceState(db: D1Database, settings: Settings): Promise<CallFaceState>`
- `async function makeCallFace(env, db, settings, args: { kind: CallFaceKind; actor: string }): Promise<VisualAssetRow>` (400 validation on a bad kind; 503 provider_not_configured detail "off" / "reserved_v4_1"; 409 in_progress while a generating callface row of that kind exists (detail = kind); then startClip with role callface, kind, ratio 960:960, seconds 5, which gives the same 503 without the Runway key and the 402 through assertBudget(db, settings, clipCostUsd(...)))
- `function callFaceSetCostUsd(settings: Settings): number` (3 x clipCostUsd at 5 s)

src/video.ts (existing exports unchanged; added)
- `type ClipRole = "video" | "callface"`; `const CLIP_ROLES`; `function isClipRole(x): x is ClipRole`; `const CALLFACE_NOTE_PREFIX = "callface:"`; `const DEFAULT_AVATAR_ASSET_ID = "master-05"`
- `claimNote(sourceId, taskId, at, kind?: CallFaceKind | null): string` (fourth part `kind:<kind>` when given)
- `parseClaimNote(notes): { sourceId; taskId; since; kind: CallFaceKind | null } | null`
- `interface StartClipArgs { sourceAssetId; description; actor; role?: ClipRole; kind?: CallFaceKind; ratio?: string; seconds?: 5 | 10; conversationId?: string | null; messageId?: string | null; promptText?: string }`; `startClip(env, db, settings, args: StartClipArgs)` (role default video; ratio/seconds override videoSettingsOf; the cost uses the overridden seconds; the audit row carries role, kind, conversation_id, message_id when set)
- `pollClip`: role check `isClipRole(roleOf(row))`; the abandoned-claim re-stamp passes `claim.kind`; the candidate write binds `notes = ?7` = `'callface:' + kind` for role callface and null for video (the `notes = ?6` guard unchanged); a message-bound clip also runs `UPDATE messages SET image_status = 'ready' WHERE id = ? AND image_id = ? AND image_status = 'pending'` (and 'failed' on a failed task or a failed start)
- `const CLIP_IDENTITY_TEXT`; `function clipPromptText(description: string): string` (identity words + her description, cut to 1000 UTF-16 units)
- `function chooseClipSource(rows: readonly VisualAssetRow[], args: { conversationId: string; today: string; avatarAssetId?: string | null }): VisualAssetRow | null` (pure: today's approved photo she sent in this conversation (role scene, approved, message_id set, created_at on `today`), else her newest approved sent photo, else the avatar master (settings.avatarAssetId or master-05); null when not even the master exists)
- `async function startClipForMessage(env, db, settings, args: { conversationId: string; messageId: string; description: string; actor: string }): Promise<VisualAssetRow>` (one SELECT of approved scene+master rows, chooseClipSource with dayKey(), then startClip with role video, conversationId, messageId, promptText = clipPromptText(description); the row's prompt is her description alone; videoSeconds/videoRatio/videoCostUsd from settings; the caps through assertBudget; the blacklist by hash in pollClip as for every clip)

public/js/callface.js (no DOM at import; nav.js imported on demand)
- `FACE_KINDS`, `TALK_ENTER = 0.020`, `TALK_HOLD = 0.012`, `TALK_HOLD_MS = 350`, `LOOP_SEAM_S = 0.35`, `LOOP_FADE_MS = 350`, `STATE_FADE_MS = 300`, `AVATAR_SIZE = 160`
- `faceStateFor(rms, hisSpeaking, prev, now, lastTalkAt)` (pure, exactly the spec order: enter >= 0.020; hold while prev talking and >= 0.012; within 350 ms of lastTalkAt; else listening while hisSpeaking; else idle)
- `callFaceKindOf(notes)` (the JS twin), `rmsOf(samples)` (8-bit time-domain RMS)
- `createFacePlayer(container, state)` -> `{ kinds, state, setState(kind), destroy() }`: one LoopPlayer per approved kind (two muted playsinline preload=auto videos of the same /media/<id>, B fades in over 350 ms when A reaches duration - 0.35, roles swap; opacity and transition set through the CSSOM); wrappers use L0's `.face-pair` class with `.active` on the current pair; only the active pair plays, the others paused at 0; 300 ms crossfade after the incoming pair fires `playing` (400 ms fallback), a flip back inside the fade just reverses; a missing kind falls back to idle; no clips or provider off -> `nav.avatarImg(160)` inside `.face-avatar` (the breathe pulse is L0's `#callFace .avatar` rule); prefers-reduced-motion -> idle first frame only, no fades; a `.face-word` label shows the state.

public/js/call.js (existing exports unchanged; added `METER_STEP_MS = 100`, `HIS_SPEECH_HOLD_MS = 1500`, `ANALYSER_FFT = 512`, `EV_SPEECH_STOPPED`, and `call.face` getter)
- The AudioContext is created synchronously at the top of start() (inside the starting tap); on the `track` event the remote stream feeds createMediaStreamSource -> AnalyserNode fftSize 512; a requestAnimationFrame loop throttled to 100 ms reads getByteTimeDomainData -> RMS -> faceStateFor -> face.setState; `input_audio_buffer.speech_started` sets hisSpeaking (cleared by `speech_stopped` or 1,500 ms later); the frame is `els.face` or `#callFace`, filled from GET /api/callface at start (a missing route shows the avatar); the stub call shows idle; releaseMedia closes the AudioContext and the meter; the face is destroyed when the sheet hides.
- A2, the one branch: when the start response carries `provider === "elevenlabs"` (src/calls.ts already returns it), call.js does `import("./call_elevenlabs.js")` and calls `connectElevenLabs({ start, els, callbacks: { caption, segment, setStatus, flashReason, onEvent, setHisSpeaking, attachRemoteStream, setFace, end } })` (also accepts `createElevenLabsCall` or a default export), expecting a handle `{ mute(on), close() }`; mute() and releaseMedia() forward to it. L10 codes against those names.

public/js/images.js
- Avatar picker in `#avatarPick` (L0's markup; built if absent): the six masters as 56 px `.avatar` crops with the focus from `nav.avatarFocus` (a local fallback table when nav.js lacks it), current one `aria-pressed="true"` (L0's ring rule), a tap PUTs `{ avatarAssetId }` to /api/settings, re-renders and calls `nav.mountAvatar()` so the header follows; errors flash into `#avatarStatus`.
- Call face card on the Clips tab using L0's ids (`#callFaceCard`, `#callFaceStatus`, `#callFaceSources`, `#callFaceMake`, `#callFaceMakeStatus`, `#faceIdleBody`, `#faceListeningBody`, `#faceTalkingBody`; built if absent): provider chip (clips / off / reserved) + `ready` chip + `no key`; the source as six ringed crops saving `callFaceSourceAssetId` through PUT /api/settings; "Make her call face" fires POST /api/callface/make for idle, listening, talking in sequence, each 202 polled through the existing clip poller, a 409 skips the kind, any other error stops and shows code + detail; each slot shows the approved clip as `<video controls playsinline muted loop>`, candidates with Approve / Reject (POST /api/images/:id/decide), generating rows as a pending shimmer. State comes from GET /api/callface, or is derived from the callface rows in GET /api/assets when the route is not there yet. Photo candidates on the Photos tab now exclude role callface.
- `us` chip (`chip.us`? no: `chip("us", "accent")` plus the card class `with-him`) on candidate and approved image cards when `with_him` is 1.

DEVIATIONS FROM SPEC_V4, WITH REASONS
1. `startClip` gained three more optional args beyond the four named (`conversationId`, `messageId`, `promptText`): startClipForMessage needs the row bound to the message and the provider text to carry the identity words while the row's `prompt` stays her description (what the Images page shows). All optional, additive.
2. `pollClip` also updates `messages.image_status` ('ready' on the candidate write, 'failed' on a failed task or start) when the row has a message_id, guarded by `image_id = row.id`. A3 gives the `image_id` / `image_status` reuse to L8 (chat.ts sets them at commit); without this the page would poll forever, so the completion side lives next to the candidate write. L8 should set `image_id` and `image_status = 'pending'` on the message when it calls startClipForMessage.
3. `callFaceSettingsOf` reads the two settings by key (like hisFaceSettings) because src/types.ts is L8's; once L8 adds them nothing changes.
4. `callFaceKindOf` in JS and `chooseClipSource`, `clipPromptText`, `callFaceStateOf`, `callFaceSetCostUsd`, `rmsOf`, `isClipRole` are extra pure exports for tests and reuse, not in the spec.
5. In `parseClaimNote` `kind` is null (not the raw string) for any value outside the three kinds; video.ts keeps a local copy of the three kinds so it never imports a value from callface.ts (callface.ts imports video.ts).
6. The `us` chip is rendered as `chip("us", "accent")`; L0's stylesheet also defines `.chip.us`. If the integrator wants that class instead, it is one string in `imageCard`.

WHAT I COULD NOT DO
- The integration suite was not run (it boots wrangler dev, which lanes must not start). The unit gate is green.
- The 960:960 ratio on gen4_turbo is unconfirmed against the live API (the spec's own caveat); the fallback to 720:1280 is a one-constant change (`CALL_FACE_RATIO`).
- No v4 test files (L9's); my checks ran from a scratch file outside the tree.

TEST COMMANDS RUN AND COUNTS
- `node --check public/js/callface.js public/js/call.js public/js/images.js`: all ok
- `node scripts/check_typography.mjs`: clean
- `npx tsc --noEmit`: clean (0 errors at the time of the run, including the other lanes' files present then; no missing-module errors, the modules I import all exist)
- `node --experimental-strip-types --test ../l2_check.test.mjs` (scratch: prompts clean and under 1000; note round trips incl. "callface:idle | good" and a claim note's kind; claimNote/parseClaimNote/re-stamp with kind; faceStateFor table (enter, hold, 350 ms hold, listening, idle, talking beats listening); callFaceStateOf two approved + one candidate -> ready false, three -> true, lipsync -> false; makeCallFace 503 off / 503 reserved_v4_1 / 409 in_progress / 400; startClip role callface writes role callface, kind in the claim note, ratio 960:960 and seconds 5 in the audit, cost 0.25; pollClip on a fake D1 with a callface row of a stub task: no 404, the abandoned note re-stamped with the kind intact, candidate notes "callface:talking", a video row gets NULL and its message set ready; chooseClipSource order; clipPromptText; startClipForMessage binds conversation and message): 12 tests, 12 pass
- `npm test` (build:canon, build:voicebank, typography, assets, tsc, unit): 483 tests, 483 pass, before the other lanes' later edits
- `node --experimental-strip-types --test "tests/unit/*.test.mjs"` (rerun after aligning to L0's markup): 483 tests, 482 pass, 1 fail: `entry_v3` "CSP: the realtime origin in connect-src ..." -- that is src/index.ts (L8, amendment A1's CSP change, now expected by entry_v4 per A4), not an L2 file.

NOTES FOR THE INTEGRATOR
- Route handlers (L8) can call `callFaceState(db, settings)` and `makeCallFace(env, db, settings, { kind, actor })`; the make route should answer 202 `{ asset }`.
- src/chat.ts (L8): after commitReply, `startClipForMessage(env, db, settings, { conversationId, messageId, description, actor })`; set `messages.image_id = row.id, image_status = 'pending'` on the message; catch ApiHttpError 503/402 for the `clip_unavailable` flag.
- L3's images.ts already accepts role callface in decideImage/serveMedia and reads `callface:` / `kind:` notes the same way.

--- L3 Him in the picture: the detector, the reference pipeline, Runway and OpenAI with him, the clip marker ---
FILES WRITTEN (all in /private/tmp/claude-501/-Users-justinnewsome-Documents-ClaudeCode-HQ/e5dcbc67-4480-4c1c-bdb2-d7e749c0c830/scratchpad/avelie_v4; nothing committed, nothing deployed, no dev server started)
- src/markers.ts (+61/-4)
- src/hisFace.ts (+46)
- src/images.ts (+118/-16)
- src/providers/runway.ts (+66/-10)
- src/providers/openai.ts (+28/-4)

EXPORTS AND SIGNATURES
src/markers.ts
- export const HIM_STRONG_RE, HIM_WEAK_RE, HIM_ABSENT_RE: RegExp (the three exactly as written in SPEC_V4 section 3)
- export function photoIncludesHim(description: string): boolean (strong -> true; else weak and not absent -> true; else false; 25/25 on the spec table, empty or non-string -> false)
- export function parseClipMarker(text: string): { clean: string; description: string | null } ([clip: ...] anywhere in the text, last one with words wins, every marker stripped, marker-only lines removed, same rules as the photo marker)
- StrippedMarkers gains clip: string | null; stripAllMarkers(text) now answers { clean, photo, song, voice, media, clip } (clip parsed last, after voice)
- stripMarkers(text) UNCHANGED at { clean, photo, song } (see deviations)

src/hisFace.ts
- export function hisFaceInPhotosEnabled(settings): boolean (settings.hisFaceInPhotos !== false; missing key reads as on)
- export const HIM_REFERENCE_MAX_ENCODED = 5 * 1024 * 1024
- export function himReferenceEncodedLength(byteLength: number, mime: string): number (the video.ts encodedDataUriLength arithmetic)
- export interface HimReference { id; name; bytes: ArrayBuffer; mime; tooLarge?: false }; export interface HimReferenceTooLarge { id; name; bytes: null; mime; tooLarge: true }
- export async function loadHimReference(env: Env, db: D1Database): Promise<HimReference | HimReferenceTooLarge | null> (newest approved role him row via listHimPhotos(db, 1); bytes from env.MEDIA.get(row.file); null with no row or no object; over the 5 MB data URI cap -> { id, name, bytes: null, mime, tooLarge: true }, body cancelled unread)
- hisFaceSettings, listHimPhotos and every v3.1 export unchanged (the v31 suite deep-compares hisFaceSettings, so the new setting is read by its own function)

src/images.ts
- export const MASTER_ORDER_WITH_HIM: readonly string[] = ["master-05", "master-00"]
- loadMasterBytes(env, db, max: number = MAX_REFERENCES (3), order: readonly string[] = MASTER_ORDER) (existing two-argument calls unchanged)
- export function appendFlag(json: string | null, flag: Flag): string (a message's flags_json plus one flag; unreadable JSON starts a fresh list)
- export function callFaceKindFromNotes(notes: string | null | undefined): "idle" | "listening" | "talking" | null as string (reads callface:<kind>, callface:<kind> | note, and a claim note's kind:<kind> part; the same reading as L2's callFaceKindOf, kept local to avoid the callface.ts -> video.ts -> images.ts cycle)
- export type AssetRole gains "callface"
- generateCandidate: withHim = photoIncludesHim(description) && hisFaceInPhotosEnabled(settings); him = loadHimReference(...) when withHim; a usable him -> references = loadMasterBytes(env, db, 2, MASTER_ORDER_WITH_HIM) and the provider request carries him: { name, bytes, look: hisFaceSettings(settings).hisLookText }; him null or too large -> ordinary three references, him: null; the candidate UPDATE now reads "... notes = NULL, with_him = ?8 WHERE ..." bound to 1 or 0; the audit after gains withHim (boolean, equal to the row's with_him); when withHim and him is unusable AND the request has a message, the batch appends him_not_on_file or him_photo_too_large ({ code, severity: "flag", detail }) to messages.flags_json (read first, write back guarded by id); a message-less owner picture writes nothing. The returned row carries with_him. photoRequestRow unchanged; regenerate unchanged (keeps the description).
- decideImage: accepts role callface; on approve under role === "callface", every other approved callface row whose notes name the same kind goes to approval_status 'archive' (decided_at stamped), the way a portrait approval archives the earlier face; a row whose kind cannot be read archives nothing.
- serveMedia: roleOk gains callface; role video or callface streams video/mp4 through the unchanged streamObject (Range 206 proven). Role him still excluded.

src/providers/runway.ts
- export const RUNWAY_HIM_TAG = "him"; export const HIM_LOOK_PROMPT_CHARS = 160; export const HIM_LOOK_MIN_CHARS = 40
- export interface HimImageRef { name; bytes: ArrayBuffer; look }; export interface RunwayHim { tag; look }
- export function himOf(req: ImageGenerateRequest): HimImageRef | null (reads req.him through a local intersection type; an empty or non-ArrayBuffer bytes reads as no him)
- runwayImagePrompt(scene: string, tags: readonly string[] = RUNWAY_REFERENCE_TAGS, him: RunwayHim | null = null): string; with him: identity head as today (naming @avelie and @avelie_2), then " @him is the man in the him reference" + (look ? ": " + look : "") + ". He is in this picture with @avelie exactly as the scene says; his face and build as the reference shows them.", then " Scene: " + the scene, then the figure clause naming @avelie and @avelie_2 only; always <= 1000 units; "@" stripped from the look words. Without him byte-identical to before (runway_image suite 15/15).
- imageRequestBody(req): with req.him the references are [her first, her second, him] tagged ["avelie", "avelie_2", "him"] (her list cut to MAX_IMAGE_REFERENCES - 1, so the count never passes 3); his URI through the same referenceUri cap; the tags TAG_RE-checked. Proven through makeRunwayImageProvider({ fetch: recorder }): the recorded body carries three referenceImages tagged avelie, avelie_2, him in that order, his as a data URI.

src/providers/openai.ts
- export function himPromptLine(look: string): string (" The last reference image is the man who is in the picture with her; show him as that image shows him: " + look + "."; the ": " is dropped when the look is empty)
- openaiImageProvider.generate: with req.him, one more image[] part after hers (Blob type from his file's extension: webp/jpeg/png) and the prompt gains himPromptLine(look). Without him unchanged.

DEVIATIONS FROM SPEC_V4, WITH REASONS
1. stripMarkers does NOT gain clip; stripAllMarkers does. tests/unit/markers_v2.test.mjs line 97 deep-equals stripMarkers("just words") to { clean, photo, song } and markers.ts documents that contract as "kept exact"; chat.ts (L8) already destructures stripAllMarkers, which is where clip now rides. If L8 or L9 want it on stripMarkers too, it is one line, but the v2 suite would have to change with it.
2. The with-him prompt gives the SCENE priority over the look words, not the look 160 characters first. Measured: identity head 489 + figure clause 186 + " Scene: " 8 = 683 fixed units; his bare line adds 148 (831); the spec's 160-character look would leave 7 units for the scene (the first run cut a 400-character scene to "selfie of the two"). Now the scene takes what it needs first (up to the ~169 left), the look rides in what remains, capped at 160 and dropped under 40 units (a fragment says nothing); his face rides in the reference either way. Results: 400-char scene -> 167 scene units kept, no look; 150-char scene -> whole scene, no look; 85-char scene -> whole scene plus 83 look characters. The spec's own assertions (under 1000 units with a 400-character scene, @him named once, figure clause about her only, three tags in order) all hold; a runway_v4 test that expects the look text to appear beside a long scene would fail and should be written against a short scene.
3. loadHimReference does not import encodedDataUriLength from src/video.ts (the spec allows "the same arithmetic"): video.ts imports images.ts, which imports hisFace.ts, so the import would close a cycle through a module the prompt path loads. The arithmetic is exported as himReferenceEncodedLength.
4. The callface kind is read by a local callFaceKindFromNotes in images.ts rather than by importing L2's callFaceKindOf (callface.ts -> video.ts -> images.ts cycle); same parse rules.
5. The him field on ImageGenerateRequest and with_him on VisualAssetRow are read and written through local intersection types (ImageGenerateRequest & { him?: ... }, VisualAssetRow & { with_him: number }) so my files compile before and after L8 adds them to src/types.ts; hisFaceInPhotos is read through hisFaceInPhotosEnabled for the same reason. No change needed once L8 lands.
6. The audit after.withHim equals the row's with_him (true only when his photo actually rode), which is what the integration assertions read; the detector's own answer is visible through the photo_with_him flag L8 pushes.

WHAT I COULD NOT DO
- npm run test:integration: it boots wrangler dev, which the lane rules reserve for the integrator and the verifier; the with-him, him_not_on_file, hisFaceInPhotos-false and callface serve/decide/archive paths were driven on fake D1 and R2 stand-ins instead (results below). The live UPDATE now binds with_him, so it needs migrations/0008_v4.sql (L9) applied before any photo on a database; on the v3.3 schema every photo would fail with a missing-column error, which is the spec's deploy order (migration first).
- No v4 unit files written (tests/unit/*_v4.test.mjs are L9's). My check scripts live in the scratchpad at /private/tmp/claude-501/-Users-justinnewsome-Documents-ClaudeCode-HQ/e5dcbc67-4480-4c1c-bdb2-d7e749c0c830/scratchpad/l3/ (detector_check.mjs, him_check.mjs, prompt_check2.mjs, measure.mjs, pipeline_check.mjs) if L9 wants to lift assertions from them.

TEST COMMANDS RUN (from the worktree)
- npx tsc --noEmit -> exit 0 (an earlier run showed two errors in src/spotify.ts, L4's file importing L8's SongRef and L4's stubSpotifyFetch; they were gone on the final run as those lanes landed; none ever in my files)
- node scripts/check_typography.mjs -> typography: clean
- node --experimental-strip-types --test tests/unit/<name>.test.mjs, each: markers_v2 14/14, images 14/14, runway_image 15/15, hisface_v31 23/23, video_v3 4/4, voice_media_v2 10/10, checks 48/48, export_character_v2 6/6, grounding_v3 8/8, calls_v3 9/9
- npm run test:unit -> tests 483, pass 483, fail 0 (the whole tree as it stood with the other lanes' files present)
- Stand-in drives (node --experimental-strip-types, through tests/unit/helpers.mjs loadSrc and fakeD1): detector 25/25 on the spec table; parseClipMarker and stripAllMarkers with clip; runwayImagePrompt with him 998 units on a 400-character scene, @him once, figure clause about her only; imageRequestBody tags avelie,avelie_2,him with three of hers plus him and avelie,avelie_2,avelie_3 without him; recorded fetch body through makeRunwayImageProvider tags avelie,avelie_2,him with a data URI; loadHimReference newest row / null / tooLarge; generateCandidate: with him -> with_him 1 bound, after.withHim true, no flag; no photo -> with_him 0, him_not_on_file appended after the existing photo_with_him flag; hisFaceInPhotos false -> with_him 0, no flag; her alone -> with_him 0; serveMedia callface -> 206 video/mp4 with Range and 200 whole; decideImage callface approve -> role kept, notes "callface:idle | nice", the earlier approved idle clip archived and the talking one untouched.

--- L4 Spotify, the player, the stub and the Model page ---
LANE L4 REPORT (Spotify, the player, the stub, the Model page)

FILES WRITTEN (all under /private/tmp/claude-501/-Users-justinnewsome-Documents-ClaudeCode-HQ/e5dcbc67-4480-4c1c-bdb2-d7e749c0c830/scratchpad/avelie_v4)
- src/spotify.ts (new, 676 lines)
- src/providers/stub.ts (edited: +217 lines)
- public/js/player.js (new, 289 lines)
- public/js/model.js (edited: +167/-4)
- docs/SPOTIFY.md (new)
Nothing committed, no deploy, no dev server, no browser.

EXPORTS AND SIGNATURES

src/spotify.ts
- Constants: SPOTIFY_AUTHORIZE_URL, SPOTIFY_TOKEN_URL, SPOTIFY_API = "https://api.spotify.com/v1", SPOTIFY_SCOPES (the seven of A1, exactly), SPOTIFY_CALLBACK_PATH = "/api/spotify/callback", SPOTIFY_ADD_PATH = (id: string) => "/playlists/" + id + "/tracks", DEFAULT_PLAYLIST_NAME = "songs from avelie", PLAYLIST_DESCRIPTION = "songs she sent", SPOTIFY_DEVICE_NAME = "Avelie", TOKEN_SLACK_MS (60 s), PAGE_TOKEN_SLACK_MS (5 min), PREMIUM_CACHE_MS (1 day).
- Types: SpotifyStatus = "added" | "already" | "not_found" | "failed" | "off" | "pending"; SpotifyFetch; SpotifyAuthRow (the row's columns); SpotifyTrack { id, uri, url, name, artist }; SpotifyStatusView { connected, displayName, playlistId, playlistName, scope, configured }; SpotifyTokenView { accessToken, expiresAt, premium, deviceName, player }; SpotifyDeps { fetch?, now? }.
- spotifyConfigured(env: Env): boolean
- spotifyFetch(env: Env): SpotifyFetch (stubSpotifyFetch() when env.SPOTIFY_STUB === "1" and ACCESS_AUD is empty; SPOTIFY_STUB_PREMIUM "0" makes the stub a free account)
- authorizeUrl(clientId: string, redirectUri: string, state: string): string
- redirectUriFor(requestUrl: string): string
- searchQuery(song: { artist; title }): string
- pickTrack(items: unknown, song): SpotifyTrack | null
- statusView(row: SpotifyAuthRow | null, settings: Settings, configured: boolean | Env = false): SpotifyStatusView
- getSpotifyAuth(db: D1Database): Promise<SpotifyAuthRow | null>
- beginConnect(env, db, requestUrl: string, actor: string): Promise<{ url: string }>
- finishConnect(env, db, settings, requestUrl, params: { code?; state?; error? }, actor, deps?): Promise<{ playlistId: string }>
- accessToken(env, db, deps?): Promise<string | null>
- tokenView(env, db, settings, deps?): Promise<SpotifyTokenView> (403 not_connected; refresh under five minutes; premium cached a day; never audited or logged)
- addSongForMessage(env, db, settings, messageId: string, deps?): Promise<SpotifyStatus> (404 not_found when the message does not exist; never throws otherwise)
- disconnect(env, db, actor): Promise<void>
- playlistStatus(env, db, settings, deps?): Promise<{ ok: boolean; name: string | null }>
- statusResponse(env, db, settings, deps?): the whole GET /api/spotify body ({ ...statusView, playlist }) in one call, for L8's convenience.

src/providers/stub.ts (additions; every v1 to v3.1 trigger kept)
- Text stub: the listening answer {"artist":"Stub Artist","title":"Stub Song","line":"stuck in my head since the shop"} when the system text starts with the local COPY of LISTENING_PREFIX ("Name one real song"); story trigger [[CLIP]] -> "...\n[clip: she looks up from the record and half smiles, then looks away]".
- Proposal stub: [[SCENE:x]] -> kind scene, payload { status: "together", location: x }; bare [[SCENE]] -> kind scene with proposal text only (no payload); [[REL:status|name]] -> kind relationship, payload { status, his_name } (his_name omitted when the name part is empty).
- stubSpotifyFetch(options?: { premium?: boolean }): StubSpotifyFetch (a FetchLike that also carries .requests: Array<{ method, url, body }>, .fetch and .premium). Answers the token URL (a refresh_token of "stub-revoked" answers 400 invalid_grant), GET /v1/me (product premium or free), POST /v1/users/stublistener/playlists (201, echoes name), GET /v1/search (one stub track, none on [[NOTFOUND]]), POST /v1/playlists/stubplaylist/tracks (201 { snapshot_id: "stub" }; any other playlist id 404, which drives the recreate-once path), GET /v1/playlists/stubplaylist; everything else 404. Constants STUB_SPOTIFY_SCOPES (copy of SPOTIFY_SCOPES), STUB_SPOTIFY_TOKEN_URL, STUB_SPOTIFY_USER, STUB_SPOTIFY_PLAYLIST, STUB_SPOTIFY_TRACK.
- stubElevenLabsFetch(): StubElevenFetch (alias stubElevenFetch; the [[ELEVEN]] stub): GET /v1/convai/conversation/token -> { token: "stub-token" }, GET /v1/convai/conversation/get-signed-url -> { signed_url }, POST /v1/text-to-speech/* -> 64 bytes of a fixed pattern as audio/mpeg; .requests recorded (method, url, headers, body). Constants STUB_ELEVEN_TOKEN, STUB_ELEVEN_SIGNED_URL; stubElevenMp3(): ArrayBuffer.
- stubImageProvider.generate ignores req.him (comment added; behaviour unchanged).

public/js/player.js (self-booting listener on import; nothing fetched until the first play)
- Listens: avelie:play { uri, uris?, target? }, avelie:pause, avelie:resume, avelie:toggle, avelie:next, avelie:queue { uri }. Dispatches avelie:player { state: "ready" | "playing" | "paused" | "off", track, position, duration, reason?, embedSrc? }.
- Exports: SDK_URL, EMBED_BASE, DEVICE_NAME, trackIdOf(uri), embedSrcFor(uri), playerState(), play(detail), pause(), resume(), toggle(), next(), queue(detail), ensurePlayer().
- Loads https://sdk.scdn.co/spotify-player.js on the first play, creates the Connect device "Avelie" once per page with getOAuthToken calling GET /api/spotify/token (token cached until a minute before expiry), plays through PUT https://api.spotify.com/v1/me/player/play?device_id=<id> { uris }, queues through POST /v1/me/player/queue. Without Premium (or SDK init/auth/account errors, iOS Safari, spotifyPlayer "embed") renders the embed iframe https://open.spotify.com/embed/track/<id> into the event's target element (else #nowPlaying) and dispatches state "off" with embedSrc; spotifyPlayer "off" dispatches "off" with reason player_off.

public/js/model.js
- FIELDS gained callFaceProvider, callFaceSourceAssetId, hisFaceInPhotos, listeningLineEnabled, placeCostUsd, spotifyEnabled, spotifyPlaylistName, spotifyPlaylistId, spotifyPlayer, elevenLabsModel, elevenLabsTtsPricePer1kChars, videoMarkerEnabled; NUMERIC gained placeCostUsd, elevenLabsTtsPricePer1kChars; BOOL gained hisFaceInPhotos, listeningLineEnabled, spotifyEnabled, videoMarkerEnabled.
- Spotify card (#spotifyCard, #spotifyStatus, #spotifyPlaylist, #spotifyConnect, #spotifyDisconnect): chips connected: <name> / not connected / not configured, plus adding or paused from spotifyEnabled; the playlist name with ok or missing and the id; Connect is a plain link to /api/spotify/connect (hidden when connected or not configured; reads Reconnect when connected); Disconnect POSTs /api/spotify/disconnect after a confirm and reloads settings; /model#spotify scrolls the card into view. Reloaded after every settings save.
- "Get her texts on this phone" (#herTextsBtn, #herTextsStatus): GET /api/push/public-key first (configured false -> chip "no push key", subscription skipped; unsupported browser -> "no push here"), else subscribePush() ("denied" chip when refused, texts still turned on), then PUT /api/settings { herFirstTextsPerDay: 2, herFirstQuietHours: "23:30-08:30" }; chips on + notes; aria-pressed reflects herFirstTextsPerDay > 0; a second press sets herFirstTextsPerDay: 0 and unsubscribes when a subscription exists. All ids in L0's model.html verified present.
- Confirmed against the tree as it stands: every id and field name above exists in L0's public/model.html; #nowPlaying exists in public/index.html; L8's CSP constants in src/index.ts match the origins in docs/SPOTIFY.md exactly; Settings and Env in src/types.ts already carry the v4 keys.

DEVIATIONS FROM SPEC_V4, WITH REASONS
1. The Premium flag is cached in panel_cache under key "spotify:premium" (json { premium }, fetched_at), not "in the row": the spotify_auth schema in 0008_v4.sql (L9's fixed SQL) has no column for it. Same one-day TTL.
2. statusView takes an optional third argument (configured: boolean | Env, default false) because the two-argument signature cannot know whether the secrets exist; statusResponse(env, db, settings) is offered so L8 can answer GET /api/spotify in one call. L8 should pass spotifyConfigured(env) (or env) if it uses statusView directly.
3. finishConnect, accessToken, tokenView, addSongForMessage, playlistStatus take an optional trailing deps { fetch?, now? } (test hooks; the routes never pass it). Local-only env var SPOTIFY_STUB_PREMIUM ("0" = free account on the stub) read through a loose cast; not declared in Env.
4. tokenView's response carries one extra field, player (the spotifyPlayer setting), so player.js can honour "embed" and "off" without a second request.
5. finishConnect sets spotifyEnabled true on every successful connect, also when spotifyPlaylistId was already set (a reconnect); the playlist is created only when the id is empty, as specified.
6. The Settings and Env keys are read through loose local interfaces (spotifySettingsOf, spotifyEnvOf) so the module compiled before L8's declarations landed; behaviour is identical now that they exist.
7. model.js no longer honours the v3 data-reserved attribute on the two ElevenLabs call fields (A2 makes them live); L0's markup carries no data-reserved anyway.
8. player.js extras beyond the spec's three events: avelie:resume, avelie:toggle, avelie:queue and an optional detail.target on avelie:play (where the embed renders); the embed's src also rides in the "off" event as embedSrc.
9. stubSpotifyFetch takes { premium } and answers 404 on the add for any playlist id but stubplaylist (so the recreate path is testable) and invalid_grant for the refresh token "stub-revoked".

WHAT I COULD NOT DO
- docs/SPOTIFY.md records the CSP origins from Spotify's SDK documentation and behaviour but they were NOT confirmed by loading the SDK in a real browser: Justin's relayed instruction for this run was not to use Chrome until he says which project to access. The doc says so and gives the integrator/verifier the one-minute post-deploy check (press play, read the console for a "Refused to ..." line).
- No tests written (tests/unit is L9's); my checks ran as a scratch script outside the tree: /private/tmp/claude-501/-Users-justinnewsome-Documents-ClaudeCode-HQ/e5dcbc67-4480-4c1c-bdb2-d7e749c0c830/scratchpad/l4_scratch/spotify_smoke.mjs (covers authorizeUrl, searchQuery, pickTrack, statusView never a token, beginConnect pending row + 32-hex state + audit without it, connected row state-only rewrite, finishConnect 403/400/stub flow with playlist created once and spotifyEnabled true, accessToken refresh + rotation + revoked, addSongForMessage added/already/not_found/off/failed/recreate-once, disconnect, playlistStatus, statusResponse, tokenView 403/refresh/premium cache, the listening/SCENE/REL/CLIP stub answers, the ElevenLabs stub). L9 can lift it into spotify_v4.test.mjs.
- L8 has not yet registered the Spotify routes or the chat hook (grep of src/api.ts and src/chat.ts for "spotify" is empty), so the end-to-end path is untested until integration.

TEST COMMANDS RUN AND COUNTS
- npx tsc --noEmit -> clean (0 errors, with every other lane's files as they stand)
- node scripts/check_typography.mjs -> typography: clean
- npm run check:assets -> all hashes match
- node --check public/js/model.js; node --check public/js/player.js -> both ok
- node --experimental-strip-types ../l4_scratch/spotify_smoke.mjs -> all assertions passed
- node --experimental-strip-types --test tests/unit/hisface_v31.test.mjs tests/unit/runway_image.test.mjs tests/unit/providers_v3.test.mjs -> 41 pass, 0 fail
- npm run test:unit -> 483 tests, 482 pass, 1 fail: tests/unit/entry_v3.test.mjs "CSP: the realtime origin in connect-src ..." fails on L8's amended CSP string in src/index.ts (the v3 test pins the v3 string; SPEC_V4 A4 says entry_v4 pins the amended one). Not a file of this lane.
- npm run test:integration not run (needs wrangler dev; lanes do not start servers).

--- L5 The album (camera roll) ---
Lane L5 report (the album / camera roll), worktree /private/tmp/claude-501/-Users-justinnewsome-Documents-ClaudeCode-HQ/e5dcbc67-4480-4c1c-bdb2-d7e749c0c830/scratchpad/avelie_v4

FILES WRITTEN (the two the lane owns; nothing else touched, nothing committed)
- /private/tmp/claude-501/-Users-justinnewsome-Documents-ClaudeCode-HQ/e5dcbc67-4480-4c1c-bdb2-d7e749c0c830/scratchpad/avelie_v4/src/album.ts (new, 243 lines)
- /private/tmp/claude-501/-Users-justinnewsome-Documents-ClaudeCode-HQ/e5dcbc67-4480-4c1c-bdb2-d7e749c0c830/scratchpad/avelie_v4/public/js/album.js (new, 245 lines)

EXPORTS, src/album.ts
- `export interface AlbumItem { id: string; messageId: string; conversationId: string | null; at: string; status: "approved" | "candidate"; withHim: boolean; description: string | null; place: string | null; sceneStatus: string | null; bytes: number | null; provider: string | null; kind: "photo" | "clip" }`
- `export type AlbumGroup = "all" | "approved" | "candidates" | "us"`; `export interface AlbumOpts { limit?: number; before?: string; group?: AlbumGroup }`; `export interface AlbumPage { items: AlbumItem[]; nextBefore: string | null }`; `export interface SceneVersionLike { version: number; state_json: string; created_at: string }`
- `export function sceneAt(versions: SceneVersionLike[], at: string): { status: string | null; location: string | null }` (pure: newest version with created_at <= at, ties broken by higher version; location only when status is together; an unparsable state_json is skipped and the next newest counts; no eligible version or an unreadable `at` gives nulls)
- `export async function listAlbum(db: D1Database, opts: AlbumOpts = {}): Promise<AlbumPage>` (SQL: `SELECT * FROM visual_assets WHERE role IN ('candidate', 'scene', 'video') AND approval_status IN ('candidate', 'approved') AND message_id IS NOT NULL [AND approval_status = ?n | AND with_him = ?n] [AND created_at < ?n] ORDER BY created_at DESC, id DESC LIMIT ?n`; the same rule re-applied in memory so the unit suite's stand-in (which evaluates only `col = ?N` binds) pages correctly; messages read by id in chunks of 90 (`SELECT id, conversation_id, created_at FROM messages WHERE id IN (...)`); scene versions read once as `SELECT version, state_json, created_at FROM state_versions WHERE entity = ?1 ORDER BY version` bound to "scene"; `at` = the message's created_at (falls back to the asset's when the message row is gone); `nextBefore` = the oldest asset created_at on a full page; limit 1..200 default 100; group "us" keeps with_him = 1; description = prompt cut at 160; 400 `validation` (ApiHttpError) on an unknown group or an unparsable `before`; never a role him, portrait, callface, master, rejected, generating or message-less row; the R2 key (`file`) never leaves the module)
- `export function albumDescription(prompt: string | null | undefined): string | null`
- `export const ALBUM_GROUPS`, `ALBUM_ROLES` (["candidate","scene","video"]), `ALBUM_STATUSES`, `ALBUM_LIMIT_DEFAULT = 100`, `ALBUM_LIMIT_MAX = 200`, `ALBUM_DESCRIPTION_MAX = 160`

EXPORTS, public/js/album.js (browser module; boots only when `main.page.album` exists, no DOM or fetch at import time, `node --check` clean)
- `mediaUrl(id, download)`, `dateLabel(iso, now)`, `groupFromHash(hash)`, `cardFor(item)` (a `.polaroid` article: `.polaroid-pic` link to `/media/<id>` target=_blank rel=noopener wrapping `<img class="polaroid-media">` or, for a clip, `<video class="polaroid-media" preload="metadata" playsinline muted>`; `.polaroid-foot` with a `.polaroid-date` button holding a `<time>` (a tap writes localStorage `avelie.conversation` and navigates to `/`), `.chips.polaroid-chips` (place chip `accent`, `us` chip when withHim, `clip` chip, `candidate` chip `amber` when not approved), `.row.polaroid-actions` with Save (`/media/<id>?download=1`, `download` attribute) and, on a candidate, Approve / Reject through `POST /api/images/:id/decide` (approve re-renders the card approved in place, reject removes it); card classes also carry `candidate`, `us`, `clip`, `data-id`, `data-status`). The filter row `#albumFilter button[data-group]` switches the group (`.active` + `aria-pressed`, mirrored into the hash `#us` etc.); `#albumOlder` pages with `nextBefore` (hidden when null); `#albumStatus` gets the flashes; empty grid shows a `none` chip; the grid gains class `album-grid` and class `reduced-motion` when `prefers-reduced-motion: reduce` matches (live-updated).

CROSS-LANE CONTRACT (class names the design lane's app.css must define; nothing here writes a style attribute): `.album-grid` (2 columns at phone width, 3 at 760px, 4 at 1100px), `.polaroid` (6px `--panel` frame, taller bottom edge, hover tilt gated by `@media (prefers-reduced-motion: reduce)` or `.album-grid.reduced-motion`), `.polaroid-pic`, `.polaroid-media`, `.polaroid-foot`, `.polaroid-date` (`--fs-0`), `.polaroid-chips`, `.polaroid-actions`, plus the existing `.chip`, `.chip.accent`, `.chip.amber`, `.btn.small`, `.btn.small.quiet`, `.btn.small.danger`, `.hidden`. Route L8 registers: `GET /api/album?limit&before&group` -> `listAlbum(db, { limit, before, group })` (400s already thrown as ApiHttpError).

DEVIATIONS FROM SPEC_V4, with reasons
1. `AlbumItem` gains `kind: "photo" | "clip"` and `listAlbum` includes role `video` rows bound to a message (A3: "the album shows clips beside photos"); owner-made clips (message_id null) and callface rows stay out. Additive field only.
2. The scene-versions statement binds `entity = ?1` ("scene") instead of the literal `entity = 'scene'`: same rows on D1, and the unit stand-in narrows on a bind but not on a literal (a relationship version would otherwise be read as a scene).
3. The eligibility, ordering, `before` cut and limit are applied in memory after the SQL as well (the stand-in evaluates none of IN, ORDER BY, LIMIT or `<`); on D1 this is a no-op.
4. `before` and `group` are validated in the module (400 `validation`) rather than left to the route, matching how images.ts and others throw.
5. The grid columns and the tilt are CSS (design lane) as the cross-lane contract puts them; album.js only exposes the `reduced-motion` class hook.

COULD NOT DO / NOTES FOR THE INTEGRATOR
- album.html does not exist yet in the tree (L0 in flight); coded against the spec's ids `#albumStatus`, `#albumFilter`, `#albumGrid`, `#albumOlder` and `main.page.album`.
- Save on a clip: `serveMedia` (src/images.ts, L3) streams role video without the `content-disposition: attachment` branch and its download filename is hardcoded `avelie-<id>.png`; a clip's Save therefore opens inline or saves with a .png name until L3 adds a video branch (`avelie-<id>.mp4`). Photos are fine.
- `nextBefore` cuts on `created_at < before`; two assets sharing an identical created_at would lose one across a page boundary (ids are ms-stamped, so this is theoretical).

TESTS RUN
- `npx tsc --noEmit`: 0 errors in src/album.ts; the tree's only error is another lane's in flight: `src/callface.ts(149,5): 'role' does not exist in type { sourceAssetId; description; actor }` (L2's callface.ts ahead of its own video.ts `startClip` change), expected.
- `node scripts/check_typography.mjs`: clean. `node --check public/js/album.js`: parses.
- Scratch check (outside the tree, /private/tmp/claude-501/-Users-justinnewsome-Documents-ClaudeCode-HQ/e5dcbc67-4480-4c1c-bdb2-d7e749c0c830/scratchpad/l5_album_scratch.test.mjs, run with `node --experimental-strip-types --test <path>`): 6/6 pass (sceneAt newest/together/apart/broken-skipped/none/tie; description cut; listAlbum order, exclusions of owner-fired, him, portrait, rejected, callface and generating rows, message join with the message's time and conversation, place from the scene at the time, photo vs clip kind, no `file` on an item; groups us/approved/candidates and the 400; limit and before paging with nextBefore; 200 message ids read as chunks of 90/90/20).
- Existing suites near the album: `node --experimental-strip-types --test tests/unit/images.test.mjs tests/unit/timeline_v2.test.mjs tests/unit/entry_v3.test.mjs`: 26 tests, 26 pass, 0 fail.
- Not run: the full `npm test` and `npm run test:integration` (other lanes' files are mid-edit in the shared tree, so the whole-tree gates are the integrator's); no dev server or browser started; nothing committed, nothing deployed.

--- L6 Rhythm, first texts, push and the whole chat page DOM ---
LANE L6 REPORT (rhythm, first texts, push, the chat page DOM)

Worktree: /private/tmp/claude-501/-Users-justinnewsome-Documents-ClaudeCode-HQ/e5dcbc67-4480-4c1c-bdb2-d7e749c0c830/scratchpad/avelie_v4 (branch v4, nothing committed, nothing pushed, no wrangler, no dev server, no browser). Note: the relayed user request ("dont do that in chrome until i tell you what project to access") was honoured; no Chrome or browser tool was used.

FILES WRITTEN (only the five L6 owns)
1. src/deliveries.ts (new, 122 lines)
2. src/push.ts (the second reason)
3. public/js/bubbles.js (appended, pure)
4. public/js/chat.js (1740 -> 2413 lines)
5. public/sw.js (shell list, cache name)
A pre-patch copy of chat.js sits at /private/tmp/claude-501/-Users-justinnewsome-Documents-ClaudeCode-HQ/e5dcbc67-4480-4c1c-bdb2-d7e749c0c830/scratchpad/chat.js.v33.bak (outside the tree).

EXPORTS AND SIGNATURES
src/deliveries.ts
- export const DUE_WINDOW_MS = 25 * 60 * 1000
- export const DELAY_PUSH_MIN_MS = 120000
- export const PUSH_REASON_DELAYED = "her_delayed_reply"
- export interface DueRow { id: string; created_at: string; deliver_at: string | null; pushed_at: string | null }
- export interface DueSplit { push: string[]; skip: string[] }
- export function dueReplies(rows: ReadonlyArray<DueRow>, now: Date): DueSplit (pure; push = deliver_at <= now, > now - window, held >= 120 s by deliver_at - created_at, pushed_at null; skip = in-window rows under the floor; not-yet-due, before-window, already-pushed, unreadable deliver_at and deliver_at null are in neither)
- export interface PushDueResult { due: number; pushed: boolean; result: PushSendResult | null }
- export async function pushDueReplies(env: Env, db: D1Database, now = new Date()): Promise<PushDueResult> (the exact SELECT from the spec with binds [nowIso, floorIso, 50]; push empty -> { due: 0, pushed: false, result: null } with skip rows still stamped; else ONE sendPush(env, db, "her_delayed_reply", now); then UPDATE messages SET pushed_at = ?1 WHERE id IN (...) over push+skip, chunked by 90 (91 binds max), run as one db.batch, whatever the push result; a failed stamp is logged, never thrown)
src/push.ts (additions; every existing export unchanged)
- export const PUSH_REASONS = ["her_first_text", "her_delayed_reply"] as const
- export type PushReason
- export function isPushReason(reason: unknown): reason is PushReason
- sendPush(env, db, reason: string, now?) keeps its signature; the header comment, the sendPush comment and the log lines now name the two reasons; a reason outside the two answers { skipped: "reason not allowed" } without reading subscriptions (the no-retention-hook law enforced in code, not only in a comment). herfirst.ts passes "her_first_text" and is unaffected.
public/js/bubbles.js
- export const DOTS_LEAD_MS = 20000
- export function dotsLeadMs(deliverAtMs, nowMs) -> max(0, deliverAt - now - DOTS_LEAD_MS); 0 on non-finite input
public/sw.js
- CACHE "avelie-shell-v3"; SHELL gains /phone, /album, /memory, /js/phone.js, /js/map.js, /js/album.js, /js/memory.js, /js/callface.js; push handler unchanged in shape (fetches /api/push/latest); header comment says the server picks a first text or a held reply.
public/js/chat.js (no exports; the page)
- Imports: dotsLeadMs from ./bubbles.js; `import * as nav from "./nav.js"` and uses nav.avatarImg(28) (namespace import so the page still loads if the export is missing; falls back to cloning #avatar's src and object-position, data-avatar="her" so nav's later /api/avatar update re-applies).
- Section 0: renderMessage sets data-at and gives every message of hers a leading `<span class="msg-avatar spacer">`; layoutRuns() (run after every load and append) walks `.msg[data-at]`, computes runs (same sender, not operator, within RUN_GAP_MS = 10 min), puts `<img class="avatar msg-avatar" width=28 height=28>` on the first of a run of hers and the spacer on the rest, toggles classes run-first / run-rest, and hides `.meta > .time` (a new span.time around the timestamp) on same-run messages except the last message of the thread. The why/note/mark buttons stay on every message (only the time is per run). mountTypingAvatar() prepends the same avatar to #typing at init unless one is already there. In arrive(), her avatar is revealed with her first bubble, not before.
- Section 6: scheduleDelivery keeps two timers per delivery ({ at, dots, dotsTimer, arriveTimer }): dots at dotsLeadMs(at, now), arrival at at - now; refreshTyping shows the dots only for entries whose dots flag is set; clearDeliveries clears both; document visibilitychange -> onVisible() reloads the thread when any scheduled delivery's time passed while hidden.
- Section 1: #phoneBtn toggles #phoneDrawer (class drawer; closeDrawers/syncScrim/Escape/scrim include it; aria-expanded kept); openPhone() does `await Promise.all([import("./phone.js"), api("GET", "/api/phone")])` on open (never at page load), builds a skeleton `div.phone-panel.drawer-phone` with the section-0 ids (phoneStatus, phoneNow, phoneWhere, phoneWeather, phoneOutfit, phoneMood, phoneWants, phoneAsks, phoneToday, phoneListening, phoneMap; NOT placesList, since the chat's own #placesList is the scene picker) and calls renderPhone(panel, state, { places: false, tap: false, readOnly: true }); afterwards removes any #placesList / #placesStatus the renderer added and marks svg.map read-only.
- Section 4 / A1: songCard links trackUrl when present else searchUrl; `span.song-status.chips` slot with chips added (ok) / already / not found (amber) / failed (danger); Retry (POST /api/messages/:id/spotify) on failed or not_found, re-rendering from { status }; pending shows nothing and refreshes ONCE after 8 s via GET /api/messages/:id (state.songRefreshed guards the loop; a Retry re-arms it). Play control: `button.icon-btn.song-play[data-uri]` hidden until an avelie:player event says ready/playing/paused; click dispatches avelie:play { uri } or avelie:pause when that track is playing; aria-pressed reflects it. The now-playing strip renders into L0's landed markup (#nowPlaying with #npTitle, #npArtist, #npProgress > span (width via CSSOM), #npTime, #npPause, #npNext) and builds the same markup under the thread if a shell lacks it; #npPause dispatches avelie:pause / avelie:play, #npNext dispatches avelie:next; a 1 s ticker advances the bar while playing; the page never calls Spotify.
- Section 3: the assets route's lists are indexed by id (state.assets); a ready photo whose row has with_him === 1 gets class with-him and a `chip("us", "us")` in .photo-links.
- A3: isClip(m) = the asset row's role is "video", or the id starts with "vid_" before the row is listed; renderClip: pending -> `div.photo.video-bubble > div.video-pending > img` (poster = the source photo parsed from the row's claim note "source:<id>|task:...|since ...", remembered in state.clipSources so the poster survives the note being cleared) and startClipPoll (POST /api/video/:id/poll every 5 s, up to 120 polls, exactly the Images page's cadence; on candidate/approved/failed it re-GETs the message and re-renders; 404/409/422 stop it as failed); ready -> `<video playsinline controls preload="metadata" src="/media/:id" poster=...>` plus Open full size and Save (`?download=1`, download="avelie-<id>.mp4") in `div.video-links.photo-links`, and Approve / Reject (POST /api/images/:id/decide) until decided; failed -> chips. stopPollers also stops clip polls and song timers.
- Section 8: openPlaces lists GET /api/places (button per place with a 40px `img.place-thumb` from /media/place/<id> when picture; falls back to the life place threads when the route is absent) and prefills #placeInput in order: current scene location when together, else the first row with status together in GET /api/state/versions/scene?limit=50 (state_json parsed), else localStorage avelie.lastPlace; setScene("together", where) writes avelie.lastPlace; the background: applyPlaceBackground() sets `--place-url` on #thread through els.thread.style.setProperty("--place-url", "url(/media/place/<id>)") when the scene is together and a place (placeNorm(title) === placeNorm(location), the same lowercase-one-space rule as title_norm) has a picture, using the scene PUT's `place` answer when present else GET /api/places (cached 60 s), and removeProperty otherwise (apart, none, no picture); no fade is added by the script (reduced motion is the stylesheet's transition rule).
- Everything else in chat.js as before.

CROSS-LANE NAMES CHECKED AGAINST WHAT HAS LANDED
- nav.js (L0) exports avatarImg(size) and re-applies /api/avatar to every img.avatar[data-avatar]: matched.
- index.html (L0) has #phoneBtn, #phoneDrawer (drawer phone-drawer), #phoneDrawerBody, #phoneClose, #nowPlaying with #npTitle/#npArtist/#npProgress/#npTime/#npPause/#npNext, #typing, #avatar: matched.
- app.css (L0) defines .msg-avatar / .msg-avatar.spacer on a 28px grid column, .typing .msg-avatar, .song-status, .song-play[aria-pressed], .chip.us, .video-bubble with .video-pending and .video-links, .now-playing with .np-*, .thread::before from --place-url, .drawer.phone-drawer: matched (the video bubble and strip DOM were realigned to those class names).
- phone.js (L1) and player.js (L4) have not landed; chat.js loads phone.js dynamically on open and only listens for / dispatches the A1 window events, so their absence does not break the page.

DEVIATIONS FROM SPEC_V4, WITH REASONS
1. renderPhone is called with a third argument { places: false, tap: false, readOnly: true } and the drawer skeleton omits #placesList; the spec's signature is renderPhone(container, state) with "minus the places list and the map's tap" unstated in the API. If L1 ignores the options, chat.js strips #placesList/#placesStatus from the drawer after the render; the map tap can only be disarmed by L1 (a `read-only` class is set on svg.map as a hook). Integrator: confirm L1 reads the options or scopes its element lookups to the container (a document-wide getElementById("placesList") would hit the chat's scene picker).
2. Run timestamps hide only the time span, not the whole .meta row, so the why / note / mark controls stay reachable on every message of hers.
3. The pending video bubble shows the poster with the stylesheet's shimmer instead of a separate play glyph (the "play control" before ready); the native controls carry play once ready. L0's .video-pending markup has no slot for a glyph.
4. sendPush now refuses reasons outside the two (spec asked for the comment and log line only); it is a strict tightening of the same law and herfirst.ts is unaffected.
5. The song pending refresh is once per message per page load (state.songRefreshed), so a status that stays pending never loops; a Retry re-arms it.
6. dueReplies takes ReadonlyArray<DueRow> (a named interface for the row shape in the spec) and pushDueReplies returns a named PushDueResult with the spec's three fields.

WHAT I COULD NOT DO
- No browser check of the DOM (lanes may not open a browser; the user also said no Chrome). Every JS file passes node --check; behaviour is by reading.
- tests/unit/deliveries_v4.test.mjs and bubbles_v4.test.mjs are L9's; my ad hoc check of deliveries.ts and the push guard on the fake D1 lives OUTSIDE the tree at /private/tmp/claude-501/-Users-justinnewsome-Documents-ClaudeCode-HQ/e5dcbc67-4480-4c1c-bdb2-d7e749c0c830/scratchpad/deliveries_adhoc.test.mjs (7 tests: the fixed table incl. 30 s -> skip and exactly 120 s -> push, one push attempt for three due rows with one UPDATE binding a b c plus the 30 s row, nothing due -> no push but the skip row stamped, nothing at all -> no writes, 200 ids -> chunks of 91/91/21 binds, sendPush refusing "miss_you"); L9 may lift it.
- Integration (npm run test:integration) not run: it starts wrangler dev, which lanes must not do.

TEST COMMANDS RUN AND COUNTS (all on the current tree, with other lanes' files present)
- node --check public/js/chat.js public/sw.js public/js/bubbles.js: ok
- node scripts/check_typography.mjs: typography: clean
- npx tsc --noEmit: exit 0, no errors (nothing missing from other lanes at the time of the run)
- node --experimental-strip-types --test tests/unit/bubbles_v2.test.mjs tests/unit/push_v2.test.mjs tests/unit/herfirst_v2.test.mjs ../deliveries_adhoc.test.mjs: 36 tests, 36 pass, 0 fail
- npm run test:unit: 483 tests, 483 pass, 0 fail
- npm test (build:canon, build:voicebank, typography, assets, typecheck, unit): typography clean, assets all hashes match, tsc clean, 483/483 pass; src/generated unchanged by the rebuild.

--- L7 The memory map (read-only) ---
Everything is green. Final report:

FILES WRITTEN (lane L7, worktree /private/tmp/claude-501/-Users-justinnewsome-Documents-ClaudeCode-HQ/e5dcbc67-4480-4c1c-bdb2-d7e749c0c830/scratchpad/avelie_v4, nothing committed)
- src/memory.ts (edited: import line gains `listProposals` and `ProposalRow`; a new tail section "the memory map (SPEC_V4 section 7)", +228 lines; nothing above it changed)
- public/js/memory.js (new, 210 lines)

EXPORTS ADDED TO src/memory.ts
- `export type MemoryPhase = "vivid" | "firm" | "fading" | "faded"`
- `export function phaseOf(sc: MemoryScore): MemoryPhase` -- faded when `!sc.firm`; else vivid at `recency >= 0.5`, firm at `recency >= 0.15`, else fading
- `export function returnedRecently(w: WeightInfo, createdAt: string, now: Date): boolean` -- `w.stored && w.touches >= 1`, touch within the last 7 days (not in the future), and `lastTouched - createdAt >= 14 days`
- `export const RETURNED_WINDOW_DAYS = 7`, `export const RETURNED_MIN_AGE_DAYS = 14`, `export const KEPT_AUTOMATICALLY_NOTE = "kept automatically"`
- `export interface MemoryMapFact`, `MemoryMapHistory`, `MemoryMapSealed`, `MemoryMapKept` exactly as the spec lists them; plus `export interface MemoryMapCounts` and `export interface MemoryMap` (the return object's named type)
- `export function localDayKey(d: Date, tz: string | null | undefined): string` -- "YYYY-MM-DD" in a timezone, UTC on a bad name (kept local because life.ts imports memory.ts; no cycle added)
- `export function keptOnDay(rows: ProposalRow[], dayKey: string, tz, max = 100): MemoryMapKept[]` -- the pure filter behind keptToday (status approved, decision_note 'kept automatically', decided_at on that local day, newest first, cap 100)
- `export async function memoryMap(db: D1Database, settings: MemorySettings | null | undefined, now: Date = new Date()): Promise<MemoryMap>` -- a full `Settings` object passes (MemorySettings overlaps on `timezone`; her timezone is read from it). Four reads in parallel: `SELECT * FROM facts WHERE status = ?1 AND scope IN ('justin','shared','avelie')`, `SELECT * FROM history WHERE status = ?1`, `loadWeights(db)`, `listProposals(db, "approved", 500)`. Facts of scope justin/shared scored through `rankFacts(..., null relevance)` and `weightFor`; ordered by score desc; history through `rankHistory`, ordered by seq; sealed = approved avelie facts with `disclosed = 0`, subject or "(untitled)", the `fact` text never copied; every SQL filter is repeated in JS so the D1 stand-in (which evaluates no literals) and the live D1 give the same answer. Zero writes (the scratch test asserts `db.writes.length === 0`). Scores, recency and weight rounded to 3 decimals.

public/js/memory.js: `export async function load()` (GET /api/memory/map, renders, returns the map or null on error); boots itself only when `document` exists, so a Node import is harmless. Renders into the spec's ids (#memoryStatus, #memoryLegend, #memoryFacts, #memoryFading, #memoryReturned, #memoryHistory, #memorySealed, #memoryKept). No button, no write, no `style` attribute, no inline CSS; labels only ("vivid", "firm", "fading", "faded", "back", "sealed", "decay off", "none"). Tile tap = `<a href="/state#memory">` (state.js reads the hash as the tab name, so no row fragment is possible without touching L8/L0 files). Sealed envelopes have no link and no handler.

CLASS-NAME CONTRACT FOR L0 (app.css) -- the integrator should confirm these against what L0 drew:
- legend chips: `.chip.phase-vivid`, `.chip.phase-firm`, `.chip.phase-fading`, `.chip.phase-faded` (four opacities of the accent)
- the field: container `.mem-field`; tiles `a.mem-tile.size-low|size-mid|size-high` (weight bands 0.34 / 0.67 of src/memory.ts) `.phase-<phase>`, `.returned` on returned tiles; children `.mem-subject`, `.mem-text`; also `data-phase`, `data-size`, `data-id`
- fading / returned lists: `a.list-row.mem-row.phase-<phase>`
- history: container `.mem-timeline`; `.mem-node.phase-<phase>` with `.mem-node-dot`, `.mem-node-body`, `.mem-node-title`, `data-seq`
- sealed: container `.mem-sealed`; `.mem-envelope` with `.mem-envelope-flap`, `.mem-subject`
- kept today: `.list-row` with a kind chip (`chip.accent`), time, `.mem-text`

DEVIATIONS FROM SPEC_V4 (with reasons)
- keptToday reads through `listProposals(db, "approved", 500)` as the spec's consumes list says, then filters in JS. An auto-kept row is created and decided in the same instant, so today's rows are at the top of the created_at DESC order; a row created weeks ago and decided today by a hand backfill could fall past 500 on a very long day. A direct `decided_at` query would be exact; left as spec'd, noted for the integrator.
- `phaseOf` is by score only, as specified; a firm fact past `memoryFactsMax` (out of the prompt by the cap, not by score) still reads firm/vivid on the map.
- Legend adds a "back N" accent chip when any fact returned, and "decay off" uses the existing amber status chip (already the app's faded/status colour in state.js).
- Extra pure exports (`localDayKey`, `keptOnDay`, `MemoryMapCounts`, `MemoryMap`, the two constants) beyond the spec's list; nothing removed or renamed.

COULD NOT DO
- No memory.html or app.css memory rules exist yet (L0's, not on disk when I finished), so the class names above are my side of the contract, unverified against L0.
- No dev server or browser run (forbidden for lanes); memory.js was syntax-checked only.

TESTS RUN
- `npx tsc --noEmit` -> clean (0 errors; one transient error in src/callface.ts, L2's file, appeared mid-run and was gone on the final run)
- `node scripts/check_typography.mjs` -> "typography: clean"
- `node --check public/js/memory.js` -> ok
- `node --experimental-strip-types --test tests/unit/memory_v3.test.mjs` -> 9 tests, 9 pass, 0 fail
- `npm run test:unit` -> 483 tests, 483 pass, 0 fail
- Scratch check (outside the tree, at /private/tmp/claude-501/-Users-justinnewsome-Documents-ClaudeCode-HQ/e5dcbc67-4480-4c1c-bdb2-d7e749c0c830/scratchpad/l7_check.test.mjs, mirroring the spec's memory_v4 cases on `fakeDb`): 4 tests, 4 pass -- phaseOf four bands, returnedRecently table, memoryMap (0.2 fact 40 days old faded, 0.9 fact vivid, one returned, sealed subject present with its text absent from the JSON, a 03:00Z row excluded as yesterday in America/New_York and an 05:00Z row kept, counts, zero writes), decay off -> vivid.

--- L8 The pipeline and the router: types, settings, routes, chat hooks, promotion merge, export, CSP, the CLIPS overlay ---
LANE L8 REPORT (the pipeline and the router), worktree /private/tmp/claude-501/-Users-justinnewsome-Documents-ClaudeCode-HQ/e5dcbc67-4480-4c1c-bdb2-d7e749c0c830/scratchpad/avelie_v4, branch v4. Nothing committed, nothing pushed, no wrangler, no dev server, no browser. Per the relayed user request, Chrome was not touched.

FILES WRITTEN (all under the worktree; only lane-owned files, plus the two the build script regenerates)
- src/types.ts: Env gains SPOTIFY_CLIENT_ID?, SPOTIFY_CLIENT_SECRET?, SPOTIFY_STUB?; new types CallFaceProviderName ("clips" | "off" | "lipsync"), SpotifyPlayerMode ("sdk" | "embed" | "off"); Settings gains avatarAssetId, callFaceProvider, callFaceSourceAssetId, hisFaceInPhotos, spotifyEnabled, spotifyPlaylistId, spotifyPlaylistName, placeCostUsd, listeningLineEnabled, spotifyPlayer, elevenLabsModel, elevenLabsTtsPricePer1kChars, videoMarkerEnabled; ModelRunRow.kind gains "place" | "listening"; VisualAssetRow.role gains "callface" and with_him?: number | null; MessageRow gains spotify_status?: string | null and pushed_at?: string | null; ImageGenerateRequest gains him?: { name: string; bytes: ArrayBuffer; look: string } | null.
- src/db.ts: DEFAULT_SETTINGS carries the 13 defaults (master-05, clips, master-00, true, false, "", "songs from avelie", 0.08, true, "sdk", "eleven_multilingual_v2", 0.3, true; herFirstTextsPerDay 0 and replyDelayMode "instant" unchanged). insertMessageStmt now builds its column list: the v2 shape, plus call_id when set (as before) and spotify_status when set, so a database behind 0008 still takes every other insert.
- canon/seed/settings.json: the same 13 keys (91 keys, equal to DEFAULT_SETTINGS' key set, checked).
- src/api.ts: imports from ./phone, ./places, ./callface, ./spotify, ./album, ./deliveries, ./memory by the spec's names. `export const AVATAR_FOCUS: Record<string, [number, number]>` (the six ids, the spec's values), `export const AVATAR_FOCUS_DEFAULT: [number, number] = [50, 30]`, `export function avatarFocus(assetId: unknown): [number, number]`; GET /api/avatar -> { assetId, file, focus } (stored id must name an approved master, else master-05, else the first approved master; 404 only with no master at all). V4_EXTRA_KEYS (13 keys) in validateSettingsPatch with the table's rules (master ids ^master-0[0-5]$, the two enums, playlist id ^[A-Za-z0-9]{0,62}$, playlist name 1..100, placeCostUsd 0..100, elevenLabsModel 1..60, TTS price 0..100, the four booleans); assertSettingsConsistent gains the place price rule (placeCostUsd above 0 unless the image provider is keyless). PUT /api/state/scene answers { version, state, place: { id, picture } | null } and runs touchPlaceStmt best effort when stored status is together and findPlaceByTitle matches (a missing places table answers place null). GET /api/assets: every row carries with_him (Number, 0 when absent) and a `callface` list of approved callface rows (candidates and generating already include them). GET /api/push/latest: newest first text within DUE_WINDOW_MS, else newest pushed reply (pushed_at DESC, same window; a missing column falls through), else the newest arrived first text. New routes: GET /api/phone; GET /api/places (syncPlaces with the active threads, then listPlaces, rows through publicPlace: never picture_key); POST /api/places (201); PUT /api/places/:id; POST /api/places/:id/geocode; POST /api/places/:id/picture ({ remake? }); DELETE /api/places/:id/picture; GET /api/callface; POST /api/callface/make (kind oneOf CALL_FACE_KINDS, 202 { asset }); GET /api/album (limit 1..200 default 100, before, group oneOf ALBUM_GROUPS); GET /api/memory/map; GET /api/spotify (statusResponse); GET /api/spotify/connect (302 to beginConnect's url); GET /api/spotify/callback (code/state/error to finishConnect, 302 to /model#spotify); POST /api/spotify/disconnect ({ ok: true }); GET /api/spotify/token (tokenView); POST /api/messages/:id/spotify (404 unless her story row; 400 without song_json; { status }). The cross-site gate in index.ts already covers every non-GET.
- src/operator.ts: counts placesWithPicture, callFaceClips (approved), spotifyConnected (0/1) in their own batch (zeros behind 0008); providerKeys.spotify = spotifyConfigured(env).
- src/index.ts: serveMediaPath gains `parts.length === 2 && kind === "place"` -> servePlacePicture(env, env.DB, a); CRON_HER_FIRST runs pushDueReplies(env, db, at) then maybeTextFirst and returns { delayed: <push result>, ...<first text result> }; CSP amended: `default-src 'self'; script-src 'self' https://sdk.scdn.co; frame-src https://sdk.scdn.co https://open.spotify.com; connect-src 'self' https://api.openai.com https://api.spotify.com https://*.spotify.com wss://*.spotify.com https://api.elevenlabs.io wss://api.elevenlabs.io; img-src 'self' data: blob:; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'` (media-src and PERMISSIONS_POLICY unchanged; the integrator adds any further origin from docs/SPOTIFY.md or docs/ELEVENLABS.md). /media/:id already serves role callface as video/mp4 with Range through images.ts serveMedia (L3); comment only.
- src/chat.ts: evaluate pushes photo_with_him (flag) when draft.photo and photoIncludesHim, and clip_with_photo (flag, the photo dropped) when both lines are present; Draft gains clip?: string | null; Prepared gains env: Env (prepareTurn sets it); commitReply writes spotify_status "pending" when chosen.song and settings.spotifyEnabled === true, else null; before the batch a clip with videoMarkerEnabled false, videoProvider off or no key gets the flag clip_unavailable (line stripped, nothing else changes); after the batch (and the face cadence) `attachClip` calls startClipForMessage(env, db, settings, { conversationId, messageId, description, actor }) and binds the row with `UPDATE messages SET image_id = ?, image_status = 'pending', flags_json = ? WHERE id = ? AND image_id IS NULL` (image_status 'pending' is what video.ts's ready/failed statements match), adding the flag clip_pending (detail: the asset id); a failed start adds clip_failed (detail: the error code) and never fails the reply. Because it lives in commitReply, the tasting pick path gets it too, with no change to tastings.ts. afterReply, after the voice note and the proposal pass, runs ctx.waitUntil(addSongForMessage(env, db, settings, assistantRow.id)) when spotifyEnabled and the row carries song_json. Provenance gains clipRequested.
- src/proposals.ts: `export function mergeSceneState(cur: SceneState, payload: Record<string, unknown>, text: string): Record<string, unknown>` and `export function mergeRelationshipState(cur: RelationshipState, payload: Record<string, unknown>, text: string, now: Date): Record<string, unknown>` exactly per section 8 (status/location/time/present; status/his_name (null clears)/trust/affection/attraction/nicknames 1..200; the mood keys still stamp; empty payload keeps everything); the promote cases scene and relationship call them; private_language unchanged.
- src/prompt.ts: proposalSystemPrompt only (the relationship payload line gains status, his_name, trust, affection, attraction, nicknames; the new scene line with { status, location, time, present } and "Never omit location when the scene moved somewhere new"). PROMPT_VERSION still `${CONSTITUTION_VERSION}-p7`; stablePrefix()/compactPrefix() untouched by hand.
- scripts/build_constitution.mjs: a CLIPS section between PHOTOS and SONGS in the runtime overlay (her own words, at most one per message, only when it fits, never to fill silence or seem closer, the line stripped so never described twice, never a mention of recording, filming or sending, a clip of her singing only when she chooses it, never on request alone). `npm run build:canon` run once: CONSTITUTION_VERSION moved from c-a9c9fa928994ef1f to c-3b558e179c4c9d09 (src/generated/constitution.ts regenerated by the script, never by hand; static prompt 40774 chars). L9's prompt_v4 must pin the NEW prefix sha256.
- src/exportImport.ts: EXTRA_TABLES gains { key: "places", sql: "SELECT * FROM places ORDER BY created_at, id" } and no panelCache; spotify_auth is never exported; importAll drops a spotifyAuth key if one arrives; V3_TABLES gains PLACES (every column; geocoded_by and picture_light one-of); visual_assets gains with_him (int, default 0); messages gains spotify_status (text, max 20) and pushed_at; RUNTIME_ASSET_ROLES gains "callface" (ASSET_PREFIXES unchanged).
- src/exportCharacter.ts: images leave out with_him = 1 rows.
- src/timeline.ts: TimelineItem gains withHim?: boolean; photo items set it.
- src/state.ts, src/context.ts: untouched (no change expected).
- Regenerated by the build (not hand-edited): src/generated/constitution.ts, migrations/0002_seed.sql (+13 INSERT rows for the new settings keys; 0002 is the generated seed the v3.1 and v3.2 builds also regenerated, and migrations_v3 freezes only 0001 to 0004c).

DEVIATIONS FROM SPEC_V4, WITH REASONS
1. pushed_at in the messages import whitelist is type "text" (max 64), not "time": a "time" column in coerce() is stamped with the import instant when null, which would mark every never-pushed reply as pushed on restore; "text" (as decided_at) keeps null null.
2. Two flags beyond the spec's: clip_pending (a successful start, detail the asset id, so the chat page can tell a clip from a photo request on a message whose image_status is 'pending') and clip_failed (a start refused by the caps, the size gate or the provider; the reply stands). clip_with_photo and clip_unavailable are as specified.
3. The clip is started inside commitReply (Prepared now carries env) rather than in runTurn: the same code path then serves a plain turn, an opener, a voice turn and both tasting commits without touching tastings.ts.
4. The cron result shape is { delayed, ...firstTextResult } ("both results in one object").
5. GET /api/avatar falls back past master-05 to the first approved master only when master-05 itself is missing (never in production); 404 with no master at all.
6. GET /api/spotify uses L4's statusResponse (statusView plus the playlist check), which is the spec's body exactly.

WHAT I COULD NOT DO
- npm run test:integration: not run, it starts wrangler dev (forbidden for lanes); the integrator runs it.
- tests/unit/entry_v3.test.mjs "CSP: the realtime origin in connect-src ... nothing else opened" now fails by design (it asserts the v3 CSP string and no ElevenLabs origin); SPEC_V4 A4 gives the amended-CSP expectation to L9 (entry_v4, and entry_v3 needs the same update). Every other suite passes.
- Notes for the integrator: chat.js (L6) must treat a message with image_status 'pending' and the flag clip_pending as a clip (never call POST /api/images/generate for it); if L10 or L4 record further origins, add them to SPOTIFY_CONNECT / ELEVENLABS_CONNECT in src/index.ts; a tasting candidate stored without its clip text loses the clip at pick time (draftFromStored sets clip null).

TEST COMMANDS RUN, WITH COUNTS
- npm run build:canon -> constitution: 93 guarded edits, version c-3b558e179c4c9d09; seed: 33 facts, 2 state versions, 13 assets, 91 settings.
- npx tsc --noEmit -> exit 0, 0 errors (every lane's module exists in the tree, so no missing-module errors either).
- node scripts/check_typography.mjs -> clean.
- npm run test:unit -> 483 tests, 482 pass, 1 fail (the v3 CSP test named above).
- A lane smoke script (node --experimental-strip-types through tests/unit/helpers.mjs loadSrc): mergeSceneState takes status/location/present and keeps on an empty or bad payload; mergeRelationshipState takes status and his_name, clears on null, keeps on empty, mood keys stamp; validateSettingsPatch accepts the 13 good values and refuses 9 bad ones with 400 validation; the place price rule throws 400 on runway at 0 and passes on stub; avatarFocus master-05 = [50,24], unknown = [50,30], six ids; proposalSystemPrompt carries the his_name line, the scene line and the "Never omit location" sentence; PROMPT_VERSION ends -p7; seed keys equal DEFAULT_SETTINGS keys (91).

--- L9 Migration, tests, docs and the build workflow ---
Files written (all under /private/tmp/claude-501/-Users-justinnewsome-Documents-ClaudeCode-HQ/e5dcbc67-4480-4c1c-bdb2-d7e749c0c830/scratchpad/avelie_v4):
- migrations/0008_v4.sql: verbatim from SPEC_V4's tail (places + idx_places_title_norm, spotify_auth, panel_cache, the three ALTER TABLE ADD COLUMN lines, nine INSERT OR IGNORE settings rows stamped 2026-09-26T00:00:00.000Z). 0001 to 0007 untouched.
- tests/unit/helpers_v4.mjs: exports placeRow(overrides), spotifyAuthRow(overrides), callfaceRow(overrides, with a `kind` option), settingsV4(overrides) (settingsV3 plus the nine keys and the amendment's four), V4_SETTINGS_TABLE and V4_AMENDMENT_SETTINGS_TABLE ([default, good, bad]), fakeR2(initial) (get/put/delete/head over a Map, `store`, `log`, `has`, `bytesOf`), fakeFetch(handler) (a recorder with `.requests`), carriesNone(value, needles), publicFileExists(rel), SPOTIFY_SECRET_VALUES; re-exports loadSrcIfPresent, loadFileIfPresent, guard, firstExport, T0, NOW, DAY_MS, daysAgo from helpers_v3.
- tests/unit/*_v4.test.mjs (20 files): nav, ui, phone, places, callface, video, markers, images, runway, spotify, album, deliveries, bubbles, memory, proposals, settings, migrations, entry, prompt, exportImport. entry_v4 pins the AMENDED CSP (resolving index.ts's template constants); prompt_v4 pins the NEW stablePrefix sha256 f51997ec0b46d6e6c3b66ef063466bbe0fdc1bbbe61fa1432d8ffe915eb66c1f (CONSTITUTION_VERSION c-3b558e179c4c9d09) and asserts -p7; spotify_v4 covers tokenView's five-minute window, the premium cache and never-audited rule; the A3 marker and source-choice tests are in markers_v4 and video_v4.
- tests/integration/run.mjs: a scenariosV4 block (23 checks, the spec's order plus A3), run in its OWN phase on a fresh state (tests/integration/.state-v4, migrations applied by the runner, booted with --var SPOTIFY_STUB:1 and --test-scheduled) between the Runway phase and the gate; the gate phase gains the v4 routes, the callback, the three pages and /media/place/x -> 401; helpers apiRaw (manual redirect), auditAfter, pollToCandidate; ROOT imported from helpers.
- tests/README.md (v4 unit list, the v4 phase and why it is a fresh state), docs/workflows/avelie-v4-build.js (gate: clean tree, npm test, test:integration, IN_BED_SECTION, 0007 exists and 0008 does not; eleven lanes L0 to L10 three at a time; integrator with the known drift list; three read-only reviewers; fix; verifier), API.md (a v4 section: every route, changed routes, Settings added in v4, Secrets added in v4, Cron), README.md, DEPLOY.md (section 26: 0008 by npm run db:remote as its own command with a check before npm run deploy, the VAPID line, the Spotify developer-app steps and the two secret lines, the call-face set, the before/after, a link to docs/ELEVENLABS.md), HANDOFF.md (a v4 section and a new Next list), docs/ARCHITECTURE.md (nine v4 sections), docs/COSTS.md (place picture, three face clips, listening line, Spotify at zero, message clips at 0.25 per 5 s, the two ElevenLabs prices), docs/BEHAVIOR.md (photo_with_him, him_not_on_file, him_photo_too_large, clip_with_photo, clip_unavailable, plus clip_pending and clip_failed that chat.ts emits).
- wrangler.jsonc: no change. package.json: not touched (its M in git status is L10's dependency).
- One edit outside my listed files: tests/unit/entry_v3.test.mjs, whose CSP check asserted "no ElevenLabs origin" and an exact connect-src; A1/A2 superseded both, so it now keeps the v3 invariants (openai origin, blob:, no unsafe-inline, no bare wildcard) and leaves the amended string to entry_v4.

Deviations from SPEC_V4, with reasons:
1. The v4 integration block runs on a fresh state directory, not on the shared state after v3.1. The stub image and video providers return the same bytes on purpose, and the v1 and v3 blocks each reject one, blacklisting every later stub photo and clip in that state (run.mjs lines 240 and 2059 rely on it); every v4 photo and clip check would 422. The block makes what it needs itself (a photo of him, a faded fact, its places) and never rejects a picture or clip.
2. The reply flag photo_with_him is not proven in the integration block: the stub has no reply whose photo line names him; the with-him path is driven through the owner's completion of a [[PHOTO]] message (POST /api/images/generate with messageId and a with-him description), which proves with_him on the row, the audit's after.withHim and him_not_on_file on the message. A [[PHOTOUS]]-style stub trigger (L4) would close it.
3. The delayed-reply push: with realDelayMaxMinutes 1 a reply is never held two minutes, so the cron STAMPS pushed_at without a push attempt (the check asserts the stamp, the second tick changing nothing, and /api/push/latest); the two-minute floor and the single push attempt are proven in deliveries_v4.
4. The place-thread edit in the integration check edits the thread's detail, not its title (a new title is a new normalised title and, per syncPlaces, a new row); the row keeps its id and follows the new thread_id.
5. phone_v4 tests the spec's own formula, fraction = ageDays / (2 x days): one day of a two-day mood is 0.25 and two days is 0.5 (the spec's "0.5 at one day" contradicts its formula; the code follows the formula).
6. Over-long merge payload strings: L8 cuts (location at 300, present at 10, relationship fields at 200) rather than ignoring; proposals_v4 asserts the cut.

Drift for the integrator (not invented here): 0008 carries the spec's nine settings rows while src/db.ts, the seed and src/api.ts carry thirteen keys (spotifyPlayer, elevenLabsModel, elevenLabsTtsPricePer1kChars, videoMarkerEnabled read as defaults without a row); the stable-prefix pin in prompt_v4 must move once more if the CLIPS overlay text changes; entry_v4 accepts only the spec's origins in connect-src plus anything matching elevenlabs/livekit, so a further origin from docs/SPOTIFY.md or docs/ELEVENLABS.md needs the test's `known` set widened.

What I could not do: run the integration suite (no dev server allowed in this lane), so the v4 block is syntax-checked (node --check) and written against the landed handlers in src/api.ts, src/chat.ts, src/video.ts and src/spotify.ts, but unrun. node --check on docs/workflows/avelie-v4-build.js fails on the top-level return exactly as avelie-v3-build.js does (a Workflow script body); both parse as an async script body.

Test commands run:
- node scripts/check_typography.mjs -> typography: clean
- npx tsc --noEmit -> 0 errors (every lane had landed by the end; no missing-module errors remained)
- node --experimental-strip-types --test tests/unit/<each>_v4.test.mjs -> nav 6, ui 8, phone 10, places 10, callface 8, video 8, markers 5, images 8, runway 6, spotify 14, album 3, deliveries 5, bubbles 3, memory 5, proposals 7, settings 7, migrations 7, entry 6, prompt 5, exportImport 5 (136 tests in my twenty files, all pass, 0 skipped; L10's elevenlabs_v4 adds 25)
- node --experimental-strip-types --test "tests/unit/*.test.mjs" -> 644 tests, 644 pass, 0 fail, 0 skipped
- npm test -> exit 0 (build:canon version c-3b558e179c4c9d09, build:voicebank, typography clean, assets PASS, tsc clean, unit 644/644)
- node --check tests/integration/run.mjs -> ok (174 report.check calls in the file; the v4 phase and gate additions unrun)

--- L10 Her own voice: ElevenLabs on calls and voice notes ---
L10 report (her own voice: ElevenLabs on calls and voice notes). Worktree: /private/tmp/claude-501/-Users-justinnewsome-Documents-ClaudeCode-HQ/e5dcbc67-4480-4c1c-bdb2-d7e749c0c830/scratchpad/avelie_v4. Nothing committed, no deploy, no dev server, no browser (per the relayed instruction, no Chrome; the ElevenLabs docs were read with WebFetch and the SDK's own source).

FILES WRITTEN (all absolute under the worktree above)
- src/providers/elevenlabs.ts (new): the adapter.
- src/voice.ts (edited, elevenlabs branch only; Workers AI, stub, transcription untouched).
- src/calls.ts (edited, elevenlabs branch only; the OpenAI mint and SDP path untouched).
- public/js/call_elevenlabs.js (new): the browser side.
- public/js/vendor/elevenlabs-client.js (generated, 1,094,689 bytes) and public/js/vendor/worklets/rawAudioProcessor.js, audioConcatProcessor.js (generated).
- scripts/vendor_elevenlabs.mjs (new).
- tests/unit/elevenlabs_v4.test.mjs (new, 25 tests).
- docs/ELEVENLABS.md (new).
- package.json (dependency "@elevenlabs/client": "^1.25.0"; scripts "vendor:elevenlabs" and "check:vendor"), package-lock.json (npm install of that one package; livekit-client and @elevenlabs/types come with it).

EXPORTS AND SIGNATURES
src/providers/elevenlabs.ts:
- consts ELEVENLABS_ORIGIN, ELEVENLABS_TOKEN_URL, ELEVENLABS_SIGNED_URL_URL, ELEVENLABS_TTS_URL, ELEVENLABS_LIVEKIT_HOST ("livekit.rtc.elevenlabs.io"), ELEVENLABS_CONNECT_ORIGINS: readonly string[] (the four origins below), ELEVENLABS_DEFAULT_MODEL ("eleven_multilingual_v2"), ELEVENLABS_TTS_MODELS, ELEVENLABS_TTS_OUTPUT ("mp3_44100_128"), ELEVENLABS_TTS_PRICE_PER_1K_CHARS (0.3), ELEVENLABS_CALL_PRICE_PER_MINUTE (0.1), ELEVENLABS_CREDENTIAL_TTL_S (900), MAX_MODEL_ID_CHARS (60), ELEVENLABS_MAX_TTS_CHARS (5000).
- type ElevenTransport = "webrtc" | "websocket"; interfaces ElevenSession { transport; credential; expiresAt; conversationId: string | null; agentId }, ElevenMintRequest { agentId }, ElevenTtsRequest { voiceId; text; model }, ElevenTtsResult { mp3: ArrayBuffer; model; chars }, ElevenLabsProvider { name: "elevenlabs"; mintSession(env, req): Promise<ElevenSession>; textToSpeech(env, req): Promise<ElevenTtsResult> }, ElevenOverrides { agent: { prompt: { prompt }; firstMessage }; tts: { voiceId } }, ElevenSettings { voiceId; agentId; model; ttsPricePer1kChars; callPricePerMinute }, ElevenLabsDeps { fetch?; now? }.
- elevenLabsSettingsOf(settings: Settings): ElevenSettings (reads elevenLabsModel and elevenLabsTtsPricePer1kChars by name with the spec defaults when absent); isElevenId(v: unknown): v is string; elevenLabsVoiceConfigured(env, settings): boolean (key + voice id); elevenLabsCallConfigured(env, settings): boolean (key + agent id); ttsEstimateUsd(chars, pricePer1kChars): number (rounded up to the cent); elevenLabsOverrides({ instructions, voiceId }): ElevenOverrides; makeElevenLabsProvider(deps?): ElevenLabsProvider; elevenLabsProvider (the default instance); elevenLabsStubMode(env): boolean (ELEVENLABS_STUB === "1" while ACCESS_AUD is empty); elevenLabsProviderFor(env): ElevenLabsProvider (stub-backed in stub mode).
src/voice.ts additions: SynthesisResult gains chars?: number; ELEVENLABS_TTS_MODEL now equals ELEVENLABS_DEFAULT_MODEL; elevenLabsNoteCostMicro(chars, pricePer1kChars): number; assertVoiceBudget(db, settings, text): Promise<{ estimateUsd; chars }> (402 price_unknown at a 0 price, then assertBudget; a no-op on workersai/stub). attachVoiceNote now runs it before synthesize, writes cost_usd_micro on the run row and one usage_daily row for an ElevenLabs note; voiceConfigured("elevenlabs") delegates to elevenLabsVoiceConfigured.
src/calls.ts changes: callSettingsOf(settings, provider?: string) (the second argument is new and optional; for elevenlabs: pricePerMinute = elevenLabsCallPricePerMinute, the four token prices zero, model = agent id, voice = voice id); tickCall and endCall read callSettingsOf(settings, row.provider) so a mid-call switch never changes that call's meter; StartCallResponse gains optional transport, agentId, overrides; startCall on elevenlabs: 503 provider_not_configured detail "elevenlabs" without key or agent id (the reserved_v3_1 answer is gone), 402 price_unknown at a 0 price, mints through elevenLabsProviderFor(env).mintSession, clientSecret = the token or signed URL, sdpUrl "", model = agent id; the audit row carries transport only (no credential, no overrides, no instructions).
public/js/call_elevenlabs.js: connectElevenLabs({ start, els, callbacks }) -> Promise<{ mute(on), close(), id }> (also the default export; call.js's branch tries connectElevenLabs first); pure: sessionOptions(start), clientCallbacks(cb, state), endReasonFor(details); consts VENDOR_PATH, WORKLET_PATHS, HIS_LEVEL, LEVEL_STEP_MS. Transcripts go through the page's caption/segment callbacks (role agent = her, user = him); the face from onModeChange (speaking -> talking, listening -> idle) plus his input level -> setHisSpeaking; an agent hangup ends with "hangup", an error with "peer_closed"; errors show a code only; the start response is never logged or kept.
scripts/vendor_elevenlabs.mjs: buildVendorFiles(packageDir?) -> { version, files }, wrapIife(iife, version), exportedNames(iife), asciiTypography(text), consts ROOT, PACKAGE_DIR, VENDOR_DIR, CLIENT_FILE, WORKLET_DIR, WORKLET_FILES, HEADER_PREFIX; CLI: write, or --check (exit 1 on drift).

WHAT WAS CONFIRMED (docs and SDK source, 2026-09-26)
- Token mint GET /v1/convai/conversation/token?agent_id= answers { token, conversation_id } (the WebRTC transport); GET /v1/convai/conversation/get-signed-url?agent_id= answers { signed_url } (WebSocket; good for 15 minutes). Both take xi-api-key. SHIPPED: WebRTC first, with a one-time fallback to the signed URL on 404 (or a non-auth 403/422); never on 401. The transport used is in the start response and the audit row.
- TTS POST /v1/text-to-speech/{voice_id}?output_format=mp3_44100_128, body { text, model_id }; model_id default eleven_multilingual_v2 (the setting elevenLabsModel overrides).
- @elevenlabs/client 1.25.0: startSession({ conversationToken | signedUrl, connectionType, overrides: { agent: { prompt: { prompt }, firstMessage }, tts: { voiceId } }, workletPaths }); callbacks onMessage({ message, role }), onModeChange, onDisconnect, onError; methods endSession, setMicMuted, getInputVolume, getId. The overrides need System prompt, First message and Voice enabled in the agent's Security tab (docs/ELEVENLABS.md step 3).
- CSP origins the page needs in connect-src (exported as ELEVENLABS_CONNECT_ORIGINS): https://api.elevenlabs.io, wss://api.elevenlabs.io, wss://livekit.rtc.elevenlabs.io (DEFAULT_LIVEKIT_WS_URL in the SDK), https://livekit.rtc.elevenlabs.io (livekit-client's validate probe). src/index.ts already carries the first two (ELEVENLABS_CONNECT); the integrator adds the two livekit origins. script-src stays 'self': the SDK's worklets are self-hosted through workletPaths (its default is a blob: URL, which the CSP would refuse), and the SDK's jsdelivr libsamplerate fallback is only reached on the WebSocket transport when the browser cannot set the mic sample rate (documented; not reached on WebRTC).

DEVIATIONS FROM SPEC_V4, WITH REASONS
1. "confirmed in a real browser" for the CSP origins: NOT done. The relayed user instruction forbids Chrome for now and the lane rule forbids headless browsers. The list comes from the SDK source and the docs; docs/ELEVENLABS.md says so and tells the integrator to read the console once on the first real call.
2. The settings elevenLabsModel and elevenLabsTtsPricePer1kChars are not yet in src/types.ts Settings (L8's file); elevenLabsSettingsOf reads them by name with the defaults, so the code compiles and behaves now and stays correct when L8 lands them.
3. A local stub switch ELEVENLABS_STUB=1 (while ACCESS_AUD is empty), mirroring SPOTIFY_STUB, was added so the integrator can exercise callProvider elevenlabs and voiceProvider elevenlabs against the [[ELEVEN]] stub; Env has no such field (read through a narrow cast; L8 may add `ELEVENLABS_STUB?: string` beside SPOTIFY_STUB). The key is still required (pass ELEVENLABS_API_KEY=dummy as a --var the way OPENAI_API_KEY is).
4. The vendor script rewrites the 24 em/en dashes and ellipses in the SDK bundle's comments and strings to ASCII (the typography sweep scans public/js/vendor); none sit in a regex or identifier. package.json also gained two scripts (vendor:elevenlabs, check:vendor) beyond the one dependency.
5. providers/index.ts callProviderConfigured still answers false for elevenlabs (not a lane file); calls.ts checks elevenLabsCallConfigured before it, so nothing there had to change.

FOR OTHER LANES / THE INTEGRATOR
- tests/integration/run.mjs line 2011 ("callProvider elevenlabs -> start 503 with detail reserved_v3_1") must become: without the key or agent id -> 503 provider_not_configured detail "elevenlabs"; with --var ELEVENLABS_STUB:1, ELEVENLABS_API_KEY:dummy and an agent id set -> 201 with transport "webrtc", clientSecret "stub-token", overrides present (L9).
- API.md rows for /api/calls/start, callProvider and the two ElevenLabs settings still say "reserved" (L9).
- public/js/chat.js line 1230 hides the Call button when callProvider is elevenlabs (L6): drop that clause.
- src/index.ts CSP: add wss://livekit.rtc.elevenlabs.io and https://livekit.rtc.elevenlabs.io to connect-src (L8/integrator); entry_v3.test.mjs "CSP: the realtime origin ..." already fails on the amended string (pre-existing, not from this lane).
- L2's call.js branch already matches (connectElevenLabs, the callbacks object, { mute, close }).

COULD NOT DO
- No real ElevenLabs call (no key, no agent, no browser); the WebRTC join itself is exercised only by the SDK's own code, not by a test.
- npm run test:integration not run (needs wrangler dev; forbidden for lanes).

TEST COMMANDS RUN
- node --experimental-strip-types --test tests/unit/elevenlabs_v4.test.mjs: 25 tests, 25 pass, 0 fail.
- node --experimental-strip-types --test tests/unit/calls_v3.test.mjs tests/unit/voice_media_v2.test.mjs tests/unit/providers_v3.test.mjs tests/unit/settings_v3.test.mjs tests/unit/settings_v2.test.mjs: 42 tests, 42 pass, 0 fail.
- npm test (build:canon, build:voicebank, check:typography "typography: clean", check:assets, tsc --noEmit clean with zero errors, unit): 550 tests, 548 pass, 2 fail; both failures are other lanes' in-progress work, not this lane's files: tests/unit/callface_v4.test.mjs "callFaceSetCostUsd: three clips..." (L2/L9) and tests/unit/entry_v3.test.mjs "CSP: the realtime origin in connect-src..." (the v4-amended CSP in src/index.ts, L8/L9).
- npx tsc --noEmit: clean (no missing-module or missing-export errors at all, since every cross-lane setting is read by name).
- node scripts/vendor_elevenlabs.mjs then --check: "public/js/vendor matches @elevenlabs/client 1.25.0"; node --check public/js/call_elevenlabs.js: ok; node scripts/check_typography.mjs: clean.
