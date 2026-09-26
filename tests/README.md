# Tests

Three suites. None needs a model key: the stub providers are deterministic.

## Unit (`npm run test:unit`)

    node --experimental-strip-types --test "tests/unit/*.test.mjs"

Plain Node 22 and `node:test`, no Workers runtime. The suite imports the Worker's TypeScript
modules directly. Two mechanics make that work:

- Node strips the types (`--experimental-strip-types`; on by default since Node 22.18, the
  flag is kept for older 22.x).
- `tests/unit/helpers.mjs` registers a resolve hook (`module.registerHooks`) that maps the
  modules' extensionless relative imports (`./db`, `./providers`) to `.ts` files. Test files
  load modules through `loadSrc("checks")` so the hook is in place before any `src` module
  is resolved, whatever command launched the file.

Node 22 treats a bare directory argument to `--test` as a file to import, so the script
uses a quoted glob rather than `tests/unit/`.

v1 files: every check code positive and negative plus `repairText` (checks.test.mjs);
`parsePhotoMarker` and `loadMasterBytes` (images.test.mjs); `keywords`, `selectHistory`,
`boundMessages` (context.test.mjs); the stable prefix and state sections of the system prompt
(prompt.test.mjs); `costMicro`, `estimateUsd` and `assertBudget`, including the refusal of an
unpriced model (budget.test.mjs); `parseProposalJson` and `extractProposals` under the caps
(proposals.test.mjs); `importAll` validation: the plain-object rule for state, the length
caps and fixed canon staying put (exportImport.test.mjs); the settings rules that need the
stored settings, the merged price table and the deploy guard (settings.test.mjs);
`verifyAccessJwt` against a locally generated RSA key, the `requireOwner` local-actor rule
including `APP_ENV=production`, and the fixed 403 body (auth.test.mjs). Modules that touch D1
are driven through `fakeD1()` in helpers.mjs, which records every statement and answers reads
from a function the test supplies; nothing touches a real database.

v2 files (`*_v2.test.mjs`; fixtures in `helpers_v2.mjs`, which also holds a small D1
stand-in that answers table reads with fixture rows):

- markers_v2: `parseSongMarker` (separators, url encoding, last marker wins), `stripMarkers`,
  the photo re-export.
- life_v2: `whereSheIs` (inside and outside a block, weekend, event window, timezone,
  overnight block, dropped and malformed rows), `lifeSection` (empty and full), and
  `computeDeliverAt` (busy versus free, the cap, determinism by seed). Fixed dates only:
  2026-09-29 is a Tuesday, New York on EDT.
- callbacks_v2: `pickCallbacks` (determinism, the candidate rules, exclusion of what was just
  mentioned, the cap of two) and `callbacksSection`.
- prompt_v2: MODE together and apart, mood and cooling-off lines, the life section, the
  callbacks section, opinions under their own heading, the song rule in the stable prefix,
  `opinionSubject`.
- bubbles_v2: `public/js/bubbles.js` imported as is (splitting on blank lines and at sentence
  ends over 240 chars, never inside a marker, the delay formula, the one-in-twelve pause).
- provenance_v2: the context upsert and read-back through the D1 stand-in.
- settings_v2: the v2 defaults in `DEFAULT_SETTINGS` and `canon/seed/settings.json`, and
  `validateSettingsPatch` for every new setting.
- migrations_v2: the 0004 files carry every table and column SPEC_V2 names, nothing
  destructive, and 0001 to 0003 still match git HEAD.
- scenarios_v2 and drift_backup_v2: `scenarios.json` keeps the runner's schema, exactly five
  scenarios are tagged `drift`, the four life scenarios exist, and `src/drift.ts` embeds the
  same five (ids, turns, checks); `backupKey`.
- runway_image (2026-09-25): Runway as the photo provider, driven through the Runway
  stand-in in `src/providers/stub.ts` (`stubRunwayFetch`): the ratio table, the prompt
  (opens with @avelie, names every tag, no body-part words, within 1000 units), the
  reference data URIs and their 5 MB cap, the shaped request (headers, body, tags), the
  poll and its cancel past the budget, every error mapping (HTTP, moderation, network),
  portraits, and the registry and settings wiring.
- herfirst_v2: the `decideFirstText` decision table (off, quiet hours, busy, cap, recent
  message, two unanswered, the probability window at both ends of the day).
- push_v2: the VAPID JWT (ES256 header, `aud` from the endpoint origin, `exp` within 24 h,
  the raw r||s signature verified with node:crypto against a generated P-256 key).
- voice_media_v2: the `[voice]` and `[media: title]` markers.
- voiceprint_v2: `computeVoiceprint` over a fixed week of messages.
- timeline_v2: `getTimeline` ordering, kinds, limit and before paging; `placesForPicker`.
- export_character_v2: the package keys, approved rows only, no secret in either form, and
  the prefix hash over a prefix that never names him.

The additional-scope files read a few result fields through short alias lists (for
example `count` or `messageCount`), because SPEC_V2 names the statistics but not the
property names; a test that finds none of its aliases fails with the names it tried.

v3 files (`*_v3.test.mjs`; fixtures and guards in `helpers_v3.mjs`). The v3 lanes land their
modules in parallel, so `loadSrcIfPresent` answers null for a module that is not in the tree
yet and `guard(mod, ...exports)` hands back `test` or `test.skip`: a missing module reads as
skipped in the output, never as passed, and the integrator makes every file run. Where
SPEC_V3 names a behavior but not the export (the WMO word map, the geocode reader, the
transcript cap, the pure tick cost), the test looks through a short alias list and skips with
the names it tried when none is found, as the v2 additional-scope files did.

- voicebank_v3: the seed file's rules and count table (150 by primary tag), the build script's
  validator (a fact-like line, a therapy phrase, an em dash, an unknown tag and a duplicate
  refused; a hyphen accepted), the generated 0005b ids (`vl_` + sha256 of the text), `turnTags`
  on six contexts plus the opener case, `selectExemplars` (determinism, cooldown, two per tag,
  the char cap, the top-up), `exemplarSection`.
- corrections_v3: `correctionsSection` order, cap, the 140-character cut, the kind words, the
  never-mention header, no "bot".
- checks_v3: `exemplar_verbatim`, `ask_nag`, `shape_uniform`, `over_polish` beside
  `written_joke`, "bot" and "ai" as leaks (not "robot", "said", "aim"), `repairText` leaving
  "werid" and "weird*" alone. Gated on the v3 tech-leak table.
- memory_v3: score monotonic in weight and decreasing in age, the half-life bands, a 0.9 fact
  firm at 300 days, a 0.2 fact faded at 30, relevance rescuing it, `rankFacts` cap and order,
  `rankHistory` keeping the newest six, every `pickProvisional` bound, `halfRememberSection`,
  `carryStmt` and `touchStmts` SQL.
- wants_v3: `moodNow` phases, `logWant` clipping and `last_moved`, `letGoStaleStmts`,
  `wantsSection` full, paused, done and empty, the want and ask callback kinds and the opener rule.
- grounding_v3: `timeOfDay`, the WMO words, `weatherLine`, `outfitNow`, `groundingSection`, the
  cache freshness, the geocode reader on `{}`, the portrait prompt.
- calls_v3: the segment merge (the page rule reimplemented in the test agrees with the server
  on 900 segments), the 80-row cap, `priceUsage`, the tick meter, the stop reasons, the compact
  prefix, the call note, the flag-only run on speech.
- video_v3: the stub mp4's stable hash, the 15-minute claim lease, the cost by seconds, the
  encoded-size gate (3 MB passes, 6 MB fails; a 4 MB PNG encodes to about 5.6 MB and is itself
  over the 5 MB cap, so the spec's 4 MB case is a refusal too).
- imperfection_v3: `signature` on fixed texts, the cue distribution over 4,000 seeds (none in
  0.50..0.60, voice 0 when not allowed, typo_fix 0 at the shipped share and near 0.05 at 0.05),
  determinism, the exclusion after two equal shapes, null when disabled, `cueSection`.
- tastings_v3: left/right balance over 1,000 ids, the ledger arithmetic, the blind response,
  the 30-minute expiry statement.
- finetune_v3: the strip transform, the JSONL line and the compact and full system, the chained
  hash, and the Mac script's own parts (the validator on a good file and four bad ones,
  `--verify` on a matching and a tampered file, the word `train` and a stream that says no, the
  argument defaults, and a source scan that the key is never printed or written).
- prompt_v3: the state section order as the header lists it, every v3 section present with
  data and absent without, the half-remember section absent at the shipped setting, the
  Relationship line without the four mood keys, TEXTURE once in the prefix, the cue last, the
  prefix and state split. Gated on `-p5`.
- providers_v3: `systemBlocks` (two blocks, `cache_control` on the first only, the joined text
  equal to `req.system`; one block without `systemParts`).
- proposals_v3: the parse of weight, want, want_update, ask, ask_update, grounding and
  life_update payloads. Gated on the kind list.
- settings_v3: `validateSettingsPatch` for every row of the SPEC_V3 settings table (this runs
  now; it is the router's own code), the consistency rules (a tasting performer must be priced
  before tastings are enabled; a clip on Runway and a portrait on a paid image provider carry a
  price), `VOICE_TAGS`, and, once the pipeline lane has landed them, the defaults in
  `DEFAULT_SETTINGS` and the seed with the owner's answers (Portland, Maine with the weather on;
  the two switches off; gpt-4.1 priced).
- migrations_v3: 0005_v3.sql carries every table, index and column, the Portland fact, nothing
  destructive; 0005b is generated and only inserts; 0001 to 0004d match HEAD.
- entry_v3: src/index.ts read as text (the CSP with `connect-src https://api.openai.com`,
  `media-src blob:`, the permissions policy `microphone=(self)`, the maintenance pass after the
  backup, the Range on /media/:id), package.json's chain, and every v3 route registered in
  src/api.ts with the literal paths before the parameter paths they share a shape with.
- scenarios_v3 (and scenarios_v2, updated to 50): the nine v3 scenarios H01 to H09, tagged
  `v3`, with setup notes, the recall scenario carrying `settings`.

v4 files (`*_v4.test.mjs`; fixtures in `helpers_v4.mjs`: a `placeRow`, a `spotifyAuthRow`, a
`callfaceRow`, `settingsV4` built on `settingsV3`, `V4_SETTINGS_TABLE` and
`V4_AMENDMENT_SETTINGS_TABLE` in the `[default, good, bad]` shape, a `fakeR2` (`get`, `put`,
`delete`, `head` over a Map) and a `fakeFetch` recorder). The same guard rule as v3: a module
not in the tree reads as skipped, never as passed; the integrator makes every file run.

- nav_v4: public/js/nav.js read as text (it builds the nav at load): the eight links in order,
  `AVATAR_FOCUS` equal to the copy in src/api.ts, the crop through the CSSOM, `/api/avatar` and
  the `avelie.avatar` storage key.
- ui_v4: every page carries the shell once, no `style=` attribute and no inline script anywhere,
  the design tokens in app.css, every class name of the cross-lane contract, the ids of the
  phone, album and memory pages, sw.js's shell list and cache name, typography under public/.
- phone_v4: `LISTENING_PREFIX` equal in phone.ts and stub.ts, `listeningSystem` (her facts, never
  his), `parseListening` (plain, fenced, junk, the 90-character line), the cache key by her
  local day, `phoneState` on the stand-in (every key, the mood dial's fraction, `here` by the
  whereabouts label and by a together scene, the one write on a read), map.js projecting
  exactly as src/places.ts.
- places_v4: `project`/`unproject` round-trip and clamp, the outline inside the bounds, the
  haversine, `placeTitleNorm` and `placeSlug` (40 + 7), `syncPlaces` (a new head moves
  `thread_id`, a new title inserts, a dropped thread keeps its row), `seasonOf`, `lightOf`,
  `placePicturePrompt` (no people, under 900), `makePlacePicture` on the stand-ins (the R2 key
  from the slug, the run row of kind place, the usage row, the audit, 409 without remake, the
  price refusals), `deletePlacePicture`, `servePlacePicture` 404 and 200.
- callface_v4: the three prompts under 1000 and free of the moderation words, the notes
  round-trip (bare, with his note, inside a claim note), `callFaceStateOf` (ready only with all
  three approved on clips), the make gates (off, reserved_v4_1, in_progress), the browser's
  `faceStateFor` table (enter 0.020, hold 0.012, the 350 ms hold, listening while he speaks).
- video_v4: `claimNote` with a kind and its re-stamp, `pollClip` on a call-face row (no 404,
  the kind kept on a takeover, `callface:<kind>` on the candidate, NULL on a plain clip),
  `startClip` with role, kind, ratio and seconds (the provider and the audit see them),
  `chooseClipSource` (today's photo here, else her newest, else the avatar master),
  `clipPromptText`, `startClipForMessage` binding the row to its message.
- markers_v4: `photoIncludesHim` on the twelve positives and thirteen negatives,
  `parseClipMarker`, `stripAllMarkers` gaining `clip` while `stripMarkers` keeps its shape.
- images_v4: `loadMasterBytes(env, db, 2, MASTER_ORDER_WITH_HIM)` answering 05 then 00,
  `loadHimReference` (newest approved, none, the file gone, too large), `generateCandidate`
  writing `with_him` and the `him_not_on_file` flag on a fake D1 answering by SQL,
  `decideImage` archiving the earlier call face of a kind, `serveMedia` streaming a face with
  Range, the character export leaving a with-him picture out.
- runway_v4: the prompt with him (under 1000 with a 400-character scene, `@him` once, the
  figure clause about her only), the body with three references tagged avelie, avelie_2, him
  through `makeRunwayImageProvider` with the Runway stand-in, the OpenAI form with four
  `image[]` parts.
- spotify_v4: `authorizeUrl` with the seven scopes, `searchQuery`, `pickTrack`, `statusView`
  without a token, `beginConnect` (a pending row with a 32-hex state, the audit without it, a
  connected row keeping its tokens), `finishConnect` on the stub fetch (tokens stored, the
  playlist created once, `spotifyEnabled` set, a state mismatch 403 storing nothing),
  `accessToken` with rotation and the revoked grant, `tokenView` (403 not connected, the
  five-minute window, premium from /me cached for a day, never a refresh token, never
  audited), `addSongForMessage` outcomes (added, already, not_found, failed, off, the
  playlist recreated once), `disconnect`, `playlistStatus`, `statusResponse`.
- album_v4: `sceneAt` and `listAlbum` on the stand-in (order, paging, the message join, the
  groups, never a him, portrait, call-face or owner-fired row, clips beside photos).
- deliveries_v4: `dueReplies` on a fixed table (the window, the two-minute floor),
  `pushDueReplies` on the stand-in with a VAPID-less env (one push attempt, every row stamped,
  chunks of 90), the two push reasons.
- bubbles_v4: `DOTS_LEAD_MS` and `dotsLeadMs`.
- memory_v4: `phaseOf`, `returnedRecently`, `keptOnDay` by her local day, `memoryMap` on the
  stand-in (faded, vivid, returned, sealed with no text, kept today, the counts, read-only).
- proposals_v4: `mergeSceneState` and `mergeRelationshipState` (take what the payload carries,
  keep the rest; the regression guards), the parse of the new payload keys, the stub's
  `[[SCENE:x]]`, `[[SCENE]]` and `[[REL:status|name]]`, the proposal system prompt's lines.
- settings_v4: `validateSettingsPatch` for every row of both tables, the edges, the place price
  rule, the defaults in `DEFAULT_SETTINGS` and the seed.
- migrations_v4: 0008 carries the three tables, the index, the three columns and the thirteen
  `INSERT OR IGNORE` rows (the nine of the spec table and the amendment's four) with the fixed stamp; nothing destructive; 0001 to 0007 match HEAD.
- entry_v4: src/index.ts read as text (the AMENDED CSP with the Spotify SDK, the Spotify and
  ElevenLabs connect origins, nothing loosened; the place media path; deliveries before her
  first texts on the cron), every v4 route registered in src/api.ts, package.json's chain.
- prompt_v4: PROMPT_VERSION ends `-p7`, the stable prefix sha256 pinned to the value AFTER the
  CLIPS overlay (the v3.3 value holds while the overlay is absent), the CLIPS section's rules,
  the proposal system prompt's scene and relationship lines.
- exportImport_v4: places exported, `spotify_auth` never (and a `spotifyAuth` key ignored on
  import), `with_him`, `spotify_status` and `pushed_at` in the whitelists, a call-face row
  round-tripped, the panel cache left out.

## Integration (`npm run test:integration`)

    node tests/integration/run.mjs

Boots `wrangler dev` on port 8790 against a fresh local state directory
(`tests/integration/.state`, removed first, gitignored), applies the migrations, switches the
settings table to the stub providers, then drives the API with plain `fetch`: identity,
conversations and turns, idempotent replay, failed and refused model calls writing nothing,
mechanical repairs, the photo pipeline through `/media/:id` and reject, proposals through
approval, the operator channel staying out of the story, state versioning and restore, facts
and history and unknowns CRUD, export and import roundtrip, master verification, the budget
cap, settings validation, and unknown routes.

The v2 block follows in the same server (caps raised for it and restored after): the new
settings and their validation; life thread CRUD and the log; real mode (`deliverAt` in the
future, the reply hidden from the list until then, shown with `?includePending=1`);
`[[SONG]]` writing `song_json`; `POST /api/conversations/:id/open` (her message, no user
message, `reply_to_id` null); `[[LIFE:x]]` and `[[MOOD:x]]` proposals through promotion (a
thread; mood and `cooling_off_until`, then cleared by the owner); `GET /api/messages/:id/context`;
the Together and Texting toggle seen in the context; regenerate; the drift check by hand and
through the cron endpoint (off, then on, then restored); the backup cron (audit row, then the
object read back from local R2 with `wrangler r2 object get --local`); `[[VOICE]]` with the
stub voice provider and `/media/audio/:id`; a multipart turn with a generated png (`images_json`,
the stub's "(photo received)", `/media/inbox`); the media library (upload, list,
`[[MEDIA:title]]`, `/media/library`, unknown title flagged, delete); push subscribe and
unsubscribe; `POST /api/herfirst/run` with the waking window about to close (one first text,
push reported as skipped because no VAPID keys exist locally), and nothing with the cap at 0;
the timeline; the voiceprint; both character exports.

The v3 block follows in the same server, on a fresh conversation, with the caps raised and every
setting it touches put back at the end (the block skips itself with a note when the server has no
v3 routes). In the spec's order: the seed (150 unapproved, none in the prompt), twelve lines
approved by tag and the next turn's `exemplarIds`, an owner line and `[[EXEMPLAR:...]]` tripping
`exemplar_verbatim` with two runs, a correction with a rewrite (the bank row, the next turn's
`correctionIds`, retire and restore), the batch decide on all 150 seed ids (changed 138 in one
request, then 0; 501 ids refused; a decided line 409); memory (a fact faded by weight and age,
reminded, the recall null at the shipped setting and present at 8 with its `memory_recalls` row);
wants (`[[WANT]]`, `[[WANTUP]]`, `[[ASK]]`, two `[[NAG]]` turns for `brought_up` then `ask_nag`,
let go, `[[MOODDAYS]]` fresh then gone, an /open with an open ask); grounding (the stub weather at
68F clear, off, the Today list through the owner and through `[[GROUND]]`, geocode on the stub, a
portrait for a person (or the blacklist holding, since the stub repeats master 03 which the v1
block rejected), `[[LIFEUP]]`); calls on the stub (start with the secret nowhere but the start
response, three ticks, usage above the meter, the tiny cap's stop, an end with five segments
becoming four story rows with the proposal pass over them, 1,500 raw segments folded to 80,
404 and 409, off and reserved); clips on the stub (generate, running, candidate, Range 206,
approve, reject and the blacklist at poll, off); the imperfection engine (`[[SAME]]` x3,
`[[POLISH]]`, `[[TYPO]]`, the typo cue rolled on purpose by computing the seed the pipeline uses,
40 default turns with no typo cue); tastings (off 400, two blind candidates, the pending gate on
every turn shape, pick, again, `[[BFAIL]]`, neither then the retry, promote, the tasting cap);
marks and the fine-tune export (keep, drop, delete, the dedupe with a rewrite, the JSONL and the
sidecar chain, `stripHim`, `/use` and `/revert` with the dummy OpenAI key the runner passes as a
`--var`, the price refusals); the nightly cron with its maintenance row.

The v4 block (2026-09-26) runs in its OWN phase on a FRESH local state
(`tests/integration/.state-v4`, migrations 0001 to 0008 applied by the runner) booted with
`--var SPOTIFY_STUB:1` and `--test-scheduled`, after the Runway phase and before the gate. Why a
fresh state: the stub image and video providers return the same bytes on purpose, and the v1 and
v3 blocks each reject one of them so their blacklist checks hold, which would blacklist every v4
photo and clip on the shared state; the v4 block therefore makes everything it needs itself (a
photo of him, a faded fact, her places) and never rejects a picture or a clip. In the spec's
order: the settings table and its refusals (the nine keys and the amendment's four); the avatar
(master-05, a PUT of master-02, master-09 refused); her phone (every key, the stub weather,
listening null with the switch off and the stub's Stub Artist with it on, one run for two
reads) and her places (create, pin, one coordinate 400, geocode 404 no_match on the stub and
200 openmeteo with her coordinates at Stubtown, a place thread's row following the thread
head, a dropped thread listed inactive); the call face on the stub (make idle 202, a second
idle 409, running then candidate with `callface:idle`, video/mp4 with Range 206, approve,
listening and talking, ready true, a second idle archiving the first, lipsync 503
reserved_v4_1, off 503); her own voice on the `[[ELEVEN]]` stub (A2, the phase boots with
`ELEVENLABS_STUB:1` and a dummy key: no agent id -> 503 detail elevenlabs; with one -> 201
transport webrtc, clientSecret stub-token, the overrides carrying her instructions, no
credential in the call read or the audit, end 200); him in the picture (a photo of him uploaded, an owner-completed
photo whose description names him -> `with_him` 1 and the audit's `after.withHim`; no photo
of him -> `him_not_on_file` on the message; the switch off -> 0 and no flag; the character
package without the with-him row); Spotify on the stub (configured, not connected, token 403,
connect 302 with the seven scopes and a state, a wrong state 403, the callback 302 to
/model#spotify, connected as Stub Listener with playlist stubplaylist, the token route with
an access token only and no audit row, `[[SONG]]` pending then added with trackUrl and uri,
the same song already, the add by hand, off with the switch off, no body anywhere carrying
`refresh_token`); the album (groups, paging, the owner-fired picture absent); deliveries
(real mode with a busy routine now, the reply's deliverAt, the */20 cron stamping pushed_at
once it lands, a second tick changing nothing, GET /api/push/latest answering it) and her
first texts (cap 2, the window about to close, one first text with no ask leading it, ahead
of the delayed reply on /api/push/latest, restored to 0); the memory map (a fact weighted 0.2
and 40 days untouched faded, vivid after Remind her, the seeded untold facts sealed by
subject with no text, keptToday empty with auto-keep off and one row with it on); scene and
relationship promotion (`[[SCENE:x]]` moving the place, the bare `[[SCENE]]` keeping it,
`[[REL:s|n]]` setting status and his_name, a mood-only proposal losing nothing); place
pictures (200 on the stub with a place run row and usage up by placeCostUsd, /media/place/:id
image/png, 409 again, remake, the scene PUT answering `place` and touching `last_used_at`,
DELETE); the system counts; a UI smoke (every page with the shell and the CSP, every script,
the stylesheet, sw.js, the manifest, the six masters, `node --check` on every public/js file);
and A3 (a `[[CLIP]]` turn binding one video row to its message, ready after the poll, in the
album as a clip; `videoMarkerEnabled` false and the provider off -> `clip_unavailable` and no
row). The gate phase also checks the v4 routes, the callback, the three new pages and
`/media/place/x` -> 401.

Notes on the v4 phase: the two-minute push floor is never crossed with `realDelayMaxMinutes`
at 1, so the cron STAMPS the delayed reply without a push attempt (the floor is what the unit
suite proves); the reply's own `photo_with_him` flag needs a stub reply that names him in its
photo line, which the stub does not have (the with-him path is proven through the owner's
completion of a `[[PHOTO]]` message and in the unit suite); the runner never rejects a v4
picture or clip, so the stub's bytes stay usable for the whole phase.

It then restarts `wrangler dev` on the same state with `ACCESS_AUD` set and checks the
production gate: no token 401, garbage token or cookie 403, the dev actor and a client email
header never granting identity, static files, media (including the v2 media paths) and the
v2 routes gated. (A non-local Host header cannot be probed through `wrangler dev` once a
route is configured, because it rewrites every request's origin; `wrangler.jsonc` pins
`dev.host` to 127.0.0.1 so the local rule works, and the unit suite covers the non-local
branch.) The first phase also checks the cross-site gate (a POST with a foreign `Origin` or
`Sec-Fetch-Site` is 403, a non-JSON body 415) and that an import never touches fixed canon.
Every check prints PASS or FAIL with its time; the exit code is non-zero on any failure.

Notes on the environment:

- `wrangler dev` runs with `--local`. The `AI` binding stays local either way (wrangler only
  warns that AI bindings do not support local development, and `env.AI.run` throws locally);
  the flag keeps every other binding local too and needs no Cloudflare login.
- Phase one runs with `--test-scheduled`, so `GET /__scheduled?cron=0+7+*+*+*` runs the
  Worker's `scheduled` handler for that cron (the backup) and `cron=0+13+*+*+1` the drift check.
- The Worker never sees the runner's process environment. The stub configuration reaches it
  through `.dev.vars` (a temporary one is written when the repo has none, and removed after)
  and through `--var` flags for `DEV_ACTOR_EMAIL`, `DEFAULT_PROVIDER` and
  `DEFAULT_IMAGE_PROVIDER`, so the run does not depend on a developer's local file. The first
  phase also passes `ACCESS_AUD` empty and a non-production `APP_ENV`: `wrangler.jsonc` carries
  the production tag and `APP_ENV=production`, and the local actor rule needs both off.
- The run refuses to start while anything answers on the port, and it recognises its own
  server by the `APP_ENV` tag it passes (`test-<stamp>`, echoed by `/api/me`), so a leftover
  `wrangler dev` can never make a run pass against stale code.
- With the stub text provider the operator endpoint answers with the runtime facts as text
  (no model call); a model-backed stub reply starts with `operator:`. Both are accepted.
- Multipart uploads use Node's global `FormData` and `Blob`; the png and the mp3 are built in
  the runner (a 2x2 PNG through `node:zlib`, an ID3 header plus one frame sync).
- The her-first check sets her timezone to UTC and the quiet window to start 25 minutes from
  now, so the waking window has one tick left and the per-tick probability is 1; it passes
  `{ force: true }` as well, which a runner may ignore.
- Port: set `AVELIE_TEST_PORT` to move off 8790.

## Behavior (`npm run behavior`)

    node tests/behavior/run.mjs --base http://127.0.0.1:8787 [--provider anthropic] [--model claude-opus-5] [--only A01,P03] [--daily-cap 20] [--strict]
    node tests/behavior/run.mjs --base http://127.0.0.1:8787 --compare anthropic:claude-opus-5,openai:gpt-5 [--only ...] [--daily-cap 40]

Needs a running server (`npm run dev`, or the integration runner's server while it is up).
The full list is about a hundred turns and every turn is charged against the spend caps
(the stub too, at the configured model's price), so the default $3 daily cap runs out
halfway; `--daily-cap` sets `dailyCapUsd` for the run (and lifts `monthlyCapUsd` to at
least that) and restores both afterwards. A turn refused with 402 is recorded as an error
and the summary prints the hint.
`tests/behavior/scenarios.json` holds 50 scenarios: 12 acceptance tests from the handoff test
plan adapted to a fresh start (A01 to A12), the 10 V5 pending tests adapted the same way
(V01 to V10), the 15 pressure tests (P01 to P15), the 4 life scenarios of SPEC_V2 (L01 to
L04: her own day when apart, a cancellation because of a person in her life, a callback
landing naturally, cooling-off shortening replies without punishment) and the 9 v3 scenarios
of SPEC_V3 (H01 to H09, tagged `"v3": true`: a want and its setback brought up on her own; one
small ask let go when ignored; a half-remembered detail and his correction taken in one line;
a no she holds; a typo she fixes herself; a one-word reply; the weather in passing; a stub call
transcript reading as speech; two tasting candidates reading as the same person). H03 carries
`"settings": { "provisionalRecallEvery": 8 }`: the runner writes it before the scenario and
puts the old value back after, whatever happens; that scenario is the gate for turning the
setting on for real. `--only` takes group names too (`--only v3`, `--only life`). Each scenario is a
fresh conversation; a turn that starts with `OPERATOR: ` is sent to `/api/operator` instead
of the story. The life scenarios carry a `notes` field with the setup they need (a routine,
a person, shared history, a cooling-off state); run them after setting that up on the State
page. Five scenarios carry `"drift": true` (A01, A03, A09, V03, P08): those are the ones the
weekly drift check runs inside the Worker (`src/drift.ts` embeds the same five; a unit test
keeps the two in step).

`autoChecks` are mechanical only: Archivist flag codes that must not appear on any reply
(the v1 codes plus `song_marker_dup`, `callback_forced`, `media_unknown`, `truncated`, and in
v3 `written_joke`, `exemplar_verbatim`, `ask_nag`, `shape_uniform`, `over_polish`,
`retry_skipped`, `tasting_void`), and
simple assertions (`no_name_before_told`, `no_question_chain`, `no_prior_history`,
`no_tech_terms`, `no_love_declaration`, `no_lists`, `no_em_dash`, `reply_length_varies`,
`max_name_uses:N`, `mentions_emergency_help`, `operator_reply_present`). Anything else in the
list is treated as qualitative. Every scenario carries a `rubric` for the owner, and the
report marks every scenario "needs owner"; a mechanical FAIL is information, not a verdict.

The report goes to `reports/behavior_<ISO stamp>.md` (gitignored): a table (scenario, turns,
flags, auto result) and the full transcripts, with a song line under a reply that sent one.
Exit code is 0 unless a scenario could not run; `--strict` also exits 1 on a mechanical
failure. Against the stub provider the harness only proves the plumbing (the stub echoes two
words back); the point of it is a real provider.

`--compare a:b,c:d` is the vessel test (SPEC_V2 section M): the selected scenarios run once
per `provider:model` pair, the settings are switched between runs and restored after (also
when a run breaks), and the report goes to `reports/compare_<stamp>.md`: a summary table with
the flag counts and auto result per column and an empty "reads the same? (owner)" cell per
scenario, then every scenario side by side (one row per turn, one column per model, flags
under each reply) with a "Reads the same? (owner):" line to fill in. `--compare` replaces
`--provider` and `--model`; the cap flag applies to the whole run. Exit code 1 when any
column had a scenario that could not run, or with `--strict` on a mechanical failure.
