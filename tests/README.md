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
`tests/behavior/scenarios.json` holds 41 scenarios: 12 acceptance tests from the handoff test
plan adapted to a fresh start (A01 to A12), the 10 V5 pending tests adapted the same way
(V01 to V10), the 15 pressure tests (P01 to P15) and the 4 life scenarios of SPEC_V2 (L01 to
L04: her own day when apart, a cancellation because of a person in her life, a callback
landing naturally, cooling-off shortening replies without punishment). Each scenario is a
fresh conversation; a turn that starts with `OPERATOR: ` is sent to `/api/operator` instead
of the story. The life scenarios carry a `notes` field with the setup they need (a routine,
a person, shared history, a cooling-off state); run them after setting that up on the State
page. Five scenarios carry `"drift": true` (A01, A03, A09, V03, P08): those are the ones the
weekly drift check runs inside the Worker (`src/drift.ts` embeds the same five; a unit test
keeps the two in step).

`autoChecks` are mechanical only: Archivist flag codes that must not appear on any reply
(the v1 codes plus `song_marker_dup`, `callback_forced`, `media_unknown`, `truncated`), and
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
