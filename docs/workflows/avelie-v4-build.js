export const meta = {
  name: 'avelie-v4-build',
  description: 'Build Avelie v4 (her face in the shell, her phone and map, the call face, the first picture of us, her playlist and player on his Spotify, the album, real texting rhythm, a memory he can see, the scene as a place, her own voice, clips from the chat) against SPEC_V4.md on top of the green v3.3 tree',
  phases: [
    { title: 'Gate', detail: 'the v3.3 tree is in and green, or nothing starts' },
    { title: 'Build', detail: 'eleven lanes on disjoint files, three at a time' },
    { title: 'Integrate', detail: 'one agent settles drift and makes everything green, one dev server at a time' },
    { title: 'Review', detail: 'three adversarial reviewers, read-only' },
    { title: 'Fix', detail: 'apply confirmed findings, rerun tests' },
    { title: 'Verify', detail: 'independent final verification' },
  ],
}

// Pass the tree's absolute path as args.repo (on Justin's Mac the v4 worktree the lanes run on,
// scratchpad/avelie_v4, or /Users/justinnewsome/Documents/ClaudeCode/2026-09-24_avelie once merged).
const REPO = (typeof args === 'object' && args && args.repo) ? args.repo : '/Users/justinnewsome/Documents/ClaudeCode/2026-09-24_avelie'

// ------------------------------------------------------------------ the gate (SPEC_V4 header, "Build gate")

phase('Gate')
const GATE = `You are the GATE for the Avelie v4 build in ${REPO}. Do not edit any file. Run, in this order, and stop at the first failure:
1. git status --porcelain must print nothing (SPEC_V4.md may be the one untracked file; anything else is red).
2. npm test must pass (build:canon, build:voicebank, typography, assets, tsc, unit).
3. npm run test:integration must pass (kill the dev server after; nothing else may be listening on 8790).
4. grep -c IN_BED_SECTION src/prompt.ts must print a number of 1 or more (the v3.3 tree).
5. ls migrations/0007_his_face.sql must succeed and ls migrations/0008_v4.sql must FAIL (0008 is this build's).
Return exactly one line: "GATE GREEN" when all five hold, otherwise "GATE RED: <which step> <the exact failing output, at most 40 lines>".`
const gate = await agent(GATE, { label: 'v4:gate', phase: 'Gate', effort: 'low' })
if (!gate || !/GATE GREEN/.test(gate)) {
  log('v4 build stopped at the gate: ' + (gate ?? '(no answer)'))
  return { gate, stopped: true }
}
log('gate green; building')

// ------------------------------------------------------------------ the common prompt

const COMMON = `You are extending the Avelie runtime in ${REPO} (do not commit or push; do not run wrangler deploy, wrangler secret, or anything with --remote; do NOT start dev servers or headless browsers, the integrator and the verifier do that one at a time). Work ONLY inside ${REPO} and ONLY on the files your lane owns; other lanes are writing their files at the same time, so import their modules by the exact export names and signatures in SPEC_V4 and code against them even when the file does not exist yet (run npx tsc --noEmit at the end and report the errors that are only missing-module or missing-export errors from other lanes as expected). The tree is green at the start: npm test (build:canon, build:voicebank, typography, assets, tsc, unit) and npm run test:integration pass; keep them passing for your files and run the EXISTING unit tests that touch your files (the v4 suites are L9's and land at the same time; the integrator runs them first).

READ FIRST: ${REPO}/SPEC_V4.md whole (your assignment is your lane in the Build lanes section plus every section it names, and amendments A1 to A4 at the end bind every lane; the header fixes the migration number, the prompt version and the state-section order), then ${REPO}/HANDOFF.md, ${REPO}/SPEC_V3.md and ${REPO}/API.md for the shape of what exists, and every source file you own or import from.

HARD RULES: typography " -- " and "..." only, never an em dash, en dash or Unicode ellipsis anywhere (node scripts/check_typography.mjs must stay clean); no secrets in code, logs, responses, audit rows, exports or the browser (the Spotify refresh token, the realtime client secret and every API key above all); she is a person: story-channel text never mentions prompts, models, the app or the notes he gave; nothing becomes canon because a model said it; no retention hooks (no scheduled "miss you", no streaks, no guilt, no urgency, no exclusivity, no first text that opens with an unanswered ask; her first texts stay an opt-in with a daily cap and quiet hours); she ALWAYS answers; never sanitize her voice with post-processing (retry or block; mechanical repairs only); every paid path (turns, retries, proposals, operator, photos, the two-of-you picture, place pictures, call-face clips, calls per tick, tastings, the listening-to line, her clips, ElevenLabs speech) goes through the caps in src/budget.ts and refuses unpriced models; his reference photo (role him) rides into a picture only when her line says he is in it, and never into the Images page, the outfit rule or any export; migrations 0001 to 0007 are applied on the live D1 and are never edited, 0008_v4.sql is additive and idempotent-safe; D1 bound-parameter limit 100 in every IN list; the CSP in src/index.ts stays default-src 'self' with only the origins the spec and its amendments name; TypeScript strict with noUncheckedIndexedAccess (npx tsc --noEmit clean); Workers runtime only in src/ (no Node-only APIs); no prose in the UI, labels only; vanilla HTML, CSS and JS, one stylesheet, dark ground with blues and one accent, nothing lightened, phone width first, WCAG AA. Never edit src/generated/* by hand (npm run build:canon regenerates), canon/constitution/*, or public/images/masters/*.

Return a plain-text report: files written, exports and their signatures, deviations from SPEC_V4 with reasons, what you could not do, and the exact test commands you ran with their counts.`

// ------------------------------------------------------------------ the eleven lanes (SPEC_V4 "Build lanes" and A4)

const L0 = `${COMMON}

YOUR ASSIGNMENT, lane L0 (the design pass, SPEC_V4 section 0 and the shells of every page, plus the markup A1 to A3 name for L0). Files you own: public/css/app.css (the tokens, the shell, the thread look, the phone panel, the album, the memory page, the place veil, the call face frame, the avatar picker, the now-playing strip, the video bubble; one stylesheet, one accent), public/js/nav.js (LINKS, AVATAR_FOCUS, avatarFocus, mountAvatar, avatarImg; the crop through the CSSOM), public/index.html, public/phone.html, public/album.html, public/memory.html, public/state.html, public/model.html (every v4 control's markup and ids, the Spotify card, the "Get her texts on this phone" button, the callFaceProvider select, the spotifyPlayer, elevenLabsModel, elevenLabsTtsPricePer1kChars and videoMarkerEnabled fields), public/images.html (the avatar picker and the call face card), public/timeline.html, public/manifest.webmanifest (no change expected), public/icons/* (no change expected). No page may carry a style attribute or an inline script. Prove the contrast pairs in your report.`

const L1 = `${COMMON}

YOUR ASSIGNMENT, lane L1 (her phone and her places, SPEC_V4 sections 1 and 8's places and pictures, plus A1's playlist embed and queue control in the phone panel). Files you own: src/phone.ts, src/places.ts, public/js/phone.js, public/js/map.js. LISTENING_PREFIX is copied into stub.ts by L4 (never an import from phone.ts). map.js has no top-level DOM, location or fetch; phone.js runs its page code only when main.page.phone exists and fetches nothing at import time (chat.js imports renderPhone from it).`

const L2 = `${COMMON}

YOUR ASSIGNMENT, lane L2 (the call face, SPEC_V4 section 2, plus A2's one branch in call.js and A3's startClipForMessage). Files you own: src/callface.ts, src/video.ts (startClip args role, kind, ratio, seconds; pollClip writing callface:<kind>; claimNote and parseClaimNote with kind; chooseClipSource, clipPromptText and startClipForMessage for A3), public/js/callface.js (faceStateFor exported, no DOM at import), public/js/call.js (the analyser, the face frame, speech_stopped, and the one branch that imports call_elevenlabs.js when callProvider is elevenlabs), public/js/images.js (the avatar picker's behaviour, the call face card, the us chip on cards).`

const L3 = `${COMMON}

YOUR ASSIGNMENT, lane L3 (him in the picture, SPEC_V4 section 3, plus A3's marker parse). Files you own: src/markers.ts (photoIncludesHim and the three regexes; parseClipMarker; stripAllMarkers gains clip; stripMarkers keeps its v1 shape), src/images.ts (loadMasterBytes args, MASTER_ORDER_WITH_HIM, generateCandidate with him, with_him, the message flags him_not_on_file and him_photo_too_large, serveMedia and decideImage for role callface with the archive-the-previous rule), src/hisFace.ts (loadHimReference, hisFaceInPhotosEnabled), src/providers/runway.ts (runwayImagePrompt with him, imageRequestBody with the him tag, RUNWAY_HIM_TAG), src/providers/openai.ts (him on images/edits).`

const L4 = `${COMMON}

YOUR ASSIGNMENT, lane L4 (Spotify and the Model page, SPEC_V4 section 4 and A1, plus the Model page's v4 behaviour and every stub trigger). Files you own: src/spotify.ts (the section's exports plus tokenView, the seven scopes, the premium check), src/providers/stub.ts (stubSpotifyFetch with the premium flag, the listening answer on LISTENING_PREFIX (a copy of the string), [[SCENE:x]], [[SCENE]], [[REL:status|name]], [[CLIP]], the [[ELEVEN]] stub to L10's stated shape), public/js/player.js (the Web Playback SDK device "Avelie", the avelie:play / avelie:pause / avelie:next events and avelie:player), docs/SPOTIFY.md (the exact origins the SDK needs, read from a real browser's console once, for the integrator's CSP), public/js/model.js (the Spotify card, "Get her texts on this phone", and the v4 fields in FIELDS/NUMERIC/BOOL: callFaceProvider, callFaceSourceAssetId, hisFaceInPhotos, listeningLineEnabled, placeCostUsd, avatarAssetId, spotifyEnabled, spotifyPlaylistId, spotifyPlaylistName, spotifyPlayer, elevenLabsModel, elevenLabsTtsPricePer1kChars, videoMarkerEnabled).`

const L5 = `${COMMON}

YOUR ASSIGNMENT, lane L5 (the album, SPEC_V4 section 5, plus A3's clips beside photos). Files you own: src/album.ts (sceneAt, listAlbum, the AlbumItem with kind photo|clip), public/js/album.js (the Polaroid grid, the filters, Load older, Approve and Reject on a candidate, the us and candidate chips, the clip cards).`

const L6 = `${COMMON}

YOUR ASSIGNMENT, lane L6 (rhythm, first texts and the chat page, SPEC_V4 section 6, plus every v4 change to the chat DOM: A1's song card play control and now-playing strip, A3's video bubble). Files you own: src/deliveries.ts (dueReplies, pushDueReplies, DUE_WINDOW_MS, DELAY_PUSH_MIN_MS), src/push.ts (the second reason her_delayed_reply; nothing else pushes, ever), public/js/bubbles.js (DOTS_LEAD_MS, dotsLeadMs), public/js/chat.js (the dots lead and the visibility reload, the avatar beside her bubbles and the typing indicator, the run timestamps, the phone slide-in, the song status chip and Retry, the play control and the avelie:play / avelie:player events, the us chip, the place picker prefill and the background through the CSSOM, the video bubble with its poster and polling), public/sw.js (the shell list and CACHE avelie-shell-v3).`

const L7 = `${COMMON}

YOUR ASSIGNMENT, lane L7 (the memory map, SPEC_V4 section 7). Files you own: src/memory.ts (phaseOf, returnedRecently, memoryMap and the four interfaces; nothing else in the module moves), public/js/memory.js (the legend, the field of facts, Fading, Returned, the timeline, Sealed, Kept today; read-only; no button writes).`

const L8 = `${COMMON}

YOUR ASSIGNMENT, lane L8 (the pipeline and the router, plus A1's route and CSP, A2's settings and CSP lines, A3's chat hooks and the CLIPS overlay). Files you own: src/types.ts, src/db.ts, canon/seed/settings.json (every v4 setting: the nine of the table plus spotifyPlayer, elevenLabsModel, elevenLabsTtsPricePer1kChars, videoMarkerEnabled), src/api.ts (every route in the tables, GET /api/spotify/token, the settings validation with a V4_EXTRA_KEYS list and the place price rule, the avatar route with its AVATAR_FOCUS copy, the scene PUT's place, GET /api/assets callface and with_him, GET /api/push/latest, the system counts through src/operator.ts), src/operator.ts (placesWithPicture, callFaceClips, spotifyConnected, providerKeys.spotify), src/index.ts (the place media path, the cron order, the AMENDED CSP: script-src 'self' https://sdk.scdn.co; frame-src https://sdk.scdn.co https://open.spotify.com; connect-src gaining https://api.spotify.com https://*.spotify.com wss://*.spotify.com https://api.elevenlabs.io wss://api.elevenlabs.io), src/chat.ts (photo_with_him, clip_with_photo, clip_unavailable, the spotify_status pending write, the Spotify hook in afterReply, the clip start after the reply is committed with image_id and image_status reused), src/proposals.ts (mergeSceneState, mergeRelationshipState, the two promote cases), src/prompt.ts (the proposal system prompt lines only; PROMPT_VERSION untouched), scripts/build_constitution.mjs (the CLIPS section next to PHOTOS, then npm run build:canon; this moves CONSTITUTION_VERSION once, on purpose), src/exportImport.ts, src/exportCharacter.ts, src/timeline.ts, src/state.ts (no change expected), src/context.ts (no change expected).`

const L9 = `${COMMON}

YOUR ASSIGNMENT, lane L9 (migration, tests, docs and this workflow). Files you own: migrations/0008_v4.sql (verbatim from the spec's tail; nine INSERT OR IGNORE rows, the amendment's four settings are L8's drift for the integrator to settle), tests/unit/helpers_v4.mjs, tests/unit/*_v4.test.mjs (nav, ui, phone, places, callface, video, markers, images, runway, spotify, album, deliveries, bubbles, memory, proposals, settings, migrations, entry, prompt, exportImport; NOT elevenlabs_v4, which is L10's), tests/integration/run.mjs (the v4 block on its own fresh state with --var SPOTIFY_STUB:1, the UI smoke, the gate list), tests/README.md, docs/workflows/avelie-v4-build.js, API.md (a v4 section), README.md, DEPLOY.md (section 26), HANDOFF.md (a v4 section and the Next list), docs/ARCHITECTURE.md, docs/COSTS.md, docs/BEHAVIOR.md, wrangler.jsonc (no change expected; ACCESS_AUD keeps its value). package.json is L10's in this build.`

const L10 = `${COMMON}

YOUR ASSIGNMENT, lane L10 (her own voice, SPEC_V4 amendment A2). Files you own: src/providers/elevenlabs.ts (the conversation token mint, the signed-url fallback, text-to-speech), the elevenlabs branches in src/voice.ts and src/calls.ts (additive; the OpenAI path untouched; elevenLabsTtsPricePer1kChars and elevenLabsCallPricePerMinute through assertBudget; callProvider elevenlabs stops answering 503 reserved), public/js/call_elevenlabs.js, public/js/vendor/elevenlabs-client.js (generated by scripts/vendor_elevenlabs.mjs from the one dependency @elevenlabs/client; no CDN), scripts/vendor_elevenlabs.mjs, tests/unit/elevenlabs_v4.test.mjs, docs/ELEVENLABS.md (the exact steps for Justin and the origins the client needs, read from a real browser once), package.json and package-lock.json (the one dependency only). The [[ELEVEN]] stub is L4's, to your stated shape: the token mint answers { token: "stub-token" } and the TTS answers 64 bytes of a fixed pattern as audio/mpeg.`

// ------------------------------------------------------------------ build: eleven lanes, three at a time (the laptop rule)

phase('Build')
const lanes = [
  ['L0 design pass', L0], ['L1 phone+places', L1], ['L2 call face', L2], ['L3 him in the picture', L3], ['L4 spotify+model', L4],
  ['L5 album', L5], ['L6 rhythm+chat', L6], ['L7 memory map', L7], ['L8 pipeline+router', L8], ['L9 migration+tests+docs', L9], ['L10 her voice', L10],
]
const built = []
for (let i = 0; i < lanes.length; i += 3) {
  const batch = lanes.slice(i, i + 3)
  const results = await parallel(batch.map(([name, prompt]) => () => agent(prompt, { label: 'v4:' + name, phase: 'Build' })))
  built.push(...results)
  log('v4 lanes done: ' + batch.map(([name]) => name).join(', '))
}
const buildReports = built.map((r, i) => `--- v4 lane ${lanes[i][0]} ---\n${r ?? '(no report)'}`).join('\n\n')
log('v4 build done; integrating')

// ------------------------------------------------------------------ integrate

phase('Integrate')
const INTEGRATE = `${COMMON}

YOU ARE THE INTEGRATOR for v4. Eleven lanes just wrote against SPEC_V4.md in parallel, three at a time. Their reports:

${buildReports}

Make everything green, editing any file except src/generated/* (regenerate with npm run build:canon), canon/constitution/*, and public/images/masters/*. Settle every name that drifted between a lane's export and another lane's import (the reports list both sides); prefer the spec's name. Known drift to settle first: (1) migrations/0008_v4.sql carries the spec's nine INSERT OR IGNORE settings rows while src/db.ts, the seed and src/api.ts carry the amendment's four more (spotifyPlayer, elevenLabsModel, elevenLabsTtsPricePer1kChars, videoMarkerEnabled): decide whether the live table gets four more rows in 0008 (the defaults read through DEFAULT_SETTINGS either way; document the decision in DEPLOY.md section 26); (2) tests/unit/prompt_v4.test.mjs pins the stable prefix sha256 AFTER the CLIPS overlay: if the overlay text moves, move the pin once and say so; (3) the CSP: apply what docs/SPOTIFY.md and docs/ELEVENLABS.md recorded from a real browser, nothing more; (4) the v4 integration phase runs on its own fresh state (tests/integration/.state-v4) with --var SPOTIFY_STUB:1 because the stub's photo and clip bytes are blacklisted on the shared state by the v1 and v3 rejection checks; keep it that way. Order: npm run build:canon; node scripts/build_voicebank.mjs; node scripts/check_typography.mjs; node scripts/verify_assets.mjs; npx tsc --noEmit; npm run test:unit (the v4 files skip themselves while a module is missing: make them run, not skip); npm run test:integration (the runner applies 0001 to 0008 to a fresh local state and drives every v4 check; kill the dev server after); node --check on every public/js file; the UI smoke (the runner's v4 phase does it: every page and asset 200 with the shell); node scripts/check_typography.mjs again. Confirm the laws hold: no retention hook (the delayed-reply push has its two-minute floor and its window; her first texts still ship at 0), she always answers, the prefix moved exactly once (CLIPS) and PROMPT_VERSION still ends -p7, his photo rides only on a line that names him and never leaves through the Images page or an export, no Spotify body carries refresh_token, the four switches ship as the spec says (herFirstTextsPerDay 0, replyDelayMode instant, spotifyEnabled false, callFaceProvider clips). One wrangler dev at a time, never a headless browser beside it. Return a report: what failed and what you changed (file by file), final counts, anything still broken with the exact error text. Kill any dev server you started.`
const integ = await agent(INTEGRATE, { label: 'v4:integrate', phase: 'Integrate', effort: 'xhigh' })
log('v4 integration done; adversarial review')

// ------------------------------------------------------------------ review: three lenses, read-only

phase('Review')
const REVIEW_BASE = `${COMMON}

You are a READ-ONLY reviewer for v4. Do not edit files, do not start servers. You may run npx tsc --noEmit and node --check. Report findings only, ranked by severity, each with file:line, a one-sentence claim, a concrete failure scenario, and the smallest fix; mark each confirmed or plausible. Integrator report:
${integ ?? '(none)'}
`
const REVIEWS = [
  { key: 'hooks', prompt: `${REVIEW_BASE}\nLENS: retention hooks and character integrity. Read SPEC_V4 sections 1, 4, 6, 7, 8 and A3 and the code (deliveries.ts, push.ts, herfirst.ts, chat.ts, phone.ts, spotify.ts, proposals.ts, prompt.ts, scripts/build_constitution.mjs, video.ts). Could the delayed-reply push fire for a reply he watched land (the two-minute floor, the window), for anything but her_first_text and her_delayed_reply, or twice for one reply? Could a first text open with an unanswered ask now that GET /api/push/latest answers replies too? Could the listening line read his Spotify or name his taste? Could a clip line, a photo line or a song line become a way to fill silence, or be described twice? Could a place picture carry a person? Could the promotion merge erase a field the previous version knew, or take a field the payload did not carry? Is the stable prefix changed only by CLIPS (diff scripts/build_constitution.mjs against HEAD) and PROMPT_VERSION still -p7? Does the CLIPS section keep singing to her choice? Does anything in her rules name the app, a prompt or a model?` },
  { key: 'pipeline', prompt: `${REVIEW_BASE}\nLENS: correctness, data and secrets. Migration 0008: valid D1 SQLite, every table and index IF NOT EXISTS, the three ADD COLUMN lines once, with_him NOT NULL DEFAULT 0, the settings rows INSERT OR IGNORE, no existing row touched, the ledger order after 0007. The Spotify tokens: never in a response body, an audit row, a log line, the export, the character package or the browser (grep every JSON path from spotify_auth outward; GET /api/spotify/token is the one hand-off and carries the access token only); the state single-use; a second Connect never disconnecting; invalid_grant marking the row pending. His photo: rides only when photoIncludesHim says so and hisFaceInPhotos is on; never listed on the Images page; with_him rows out of the character package; the import accepting with_him, spotify_status, pushed_at and role callface (a snapshot restore after a face clip exists must not refuse). Every IN list chunked by 90 (deliveries, album, places). Every paid path under assertBudget with a price (the place picture, the listening line, the three face clips, her clips at videoCostUsd, ElevenLabs speech and calls). The blacklist on a rejected face clip. pollClip on a callface row: no 404, the kind kept on a takeover, callface:<kind> on the candidate. The scene PUT touching last_used_at best effort. The cron: pushDueReplies before maybeTextFirst, both results returned, a failure never stopping the other.` },
  { key: 'ui', prompt: `${REVIEW_BASE}\nLENS: UI against the routes and the design rule. Trace every fetch in public/js/*.js to src/api.ts (method, path, body, response fields): nav.js (/api/avatar, the CSSOM crop), phone.js and map.js (/api/phone, /api/places, the tap through unproject, no fetch in the map, no style attribute anywhere, SVG attributes as plain numbers), chat.js (the dots lead, the visibility reload, the avatar per run, the run timestamps, the slide-in from /api/phone, the song chip and Retry on /api/messages/:id/spotify, the play control through window events only, the us chip, the place picker prefill chain and --place-url through setProperty, the video bubble polling /api/video/:id/poll), callface.js and call.js (the analyser on the tap, faceStateFor, one pair playing, reduced motion, the AudioContext closed in releaseMedia, the elevenlabs branch), images.js (the avatar picker saving avatarAssetId, the call face card's three makes with 409 skipped, the us chip), album.js (/api/album groups and paging, Approve and Reject, the conversation jump through localStorage), memory.js (read-only, /api/memory/map, the four shades of one accent), model.js (the Spotify card with Connect as a plain link, "Get her texts on this phone" and its three chips, every v4 field), player.js (the SDK from sdk.scdn.co only, the token from /api/spotify/token, the embed fallback). Every page: the shell once, no style attribute, no inline script, the eight links, phone width with no horizontal scroll, tap targets 44px, contrast AA (compute the pairs the design lane listed), one accent, nothing lightened, no prose.` },
]
const findings = await parallel(REVIEWS.map(r => () => agent(r.prompt, { label: 'v4:review:' + r.key, phase: 'Review' })))
const findingsText = REVIEWS.map((r, i) => `=== ${r.key} ===\n${findings[i] ?? '(no findings returned)'}`).join('\n\n')
log('v4 review done; applying fixes')

// ------------------------------------------------------------------ fix

phase('Fix')
const fixReport = await agent(`${COMMON}

You are the FIX agent for v4. Verify each finding below against the code and apply every confirmed one with the smallest correct change; for a plausible one, prove it with a test and fix it, or record "not reproduced". Then: npm run build:canon, node scripts/build_voicebank.mjs, node scripts/check_typography.mjs, npx tsc --noEmit, npm run test:unit, npm run test:integration (one dev server at a time; kill it after). All green. If the CLIPS overlay text moved, move the pin in tests/unit/prompt_v4.test.mjs once and say so. Return a table finding -> action with file:line and the final counts.

FINDINGS:
${findingsText}`, { label: 'v4:fix', phase: 'Fix', effort: 'xhigh' })
log('v4 fix done; final verification')

// ------------------------------------------------------------------ verify

phase('Verify')
const verdict = await agent(`${COMMON}

You are the FINAL VERIFIER for v4, independent of everyone before you. Run: npm run build:canon; node scripts/build_voicebank.mjs; node scripts/check_typography.mjs; node scripts/verify_assets.mjs; npx tsc --noEmit; npm run test:unit (no v4 file may skip); npm run test:integration (its v4 phase on the fresh state must run every v4 check); then start your own dev server on port 8791 (a fresh state directory of your own, migrations applied first, --var ACCESS_AUD: --var SPOTIFY_STUB:1 --test-scheduled) and by hand, with curl: GET /api/avatar answers master-05 with focus [50, 24]; GET /api/phone answers every key and the stub weather; POST /api/places then POST /api/places/:id/picture on the stub answers 200 and GET /media/place/:id serves a PNG; POST /api/callface/make idle, poll to a candidate, approve, and GET /api/callface shows clips.idle; GET /api/spotify/connect answers 302 to accounts.spotify.com and the callback with the right state connects Stub Listener, and no Spotify body anywhere carries refresh_token; a [[SONG]] turn reaches spotify_status added; a [[CLIP]] turn binds one video row to its message; GET /api/memory/map answers the seeded sealed subjects with no fact text; GET /api/album lists the pictures with a message behind them; the */20 cron through /__scheduled stamps a delayed real-mode reply; GET / carries the amended CSP (script-src with sdk.scdn.co, connect-src with api.spotify.com and api.elevenlabs.io, no unsafe-inline) and every page carries the shell. Kill the server. Return GREEN or RED with counts per step and exact failing output if RED. Fix nothing unless a one-line typo blocks a step, and say so.

Fix report:
${fixReport ?? '(none)'}`, { label: 'v4:verify', phase: 'Verify', effort: 'high' })

return { gate, integ, findingsText, fixReport, verdict }
