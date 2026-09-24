# Avelie: handoff (2026-09-24, v3 lanes written on the v2 tree, v1 live)

This is the whole project in one file, written for a Claude Code session on Justin's Mac that carries it forward: the v3 integration, review, fix and verify, then one deploy of v2 plus v3 together, before he tests. Read it whole. Then SPEC_V3.md (the contract), DEPLOY.md sections 13 and 19 to 24. Typography " -- " and "..." only, in code, copy and chat.

## Paste this first (the Mac session's opening move)

1. `cd ~/Documents/ClaudeCode/HQ && git pull`
2. `cd ~/Documents/ClaudeCode/2026-09-24_avelie && git pull` (the clone exists; the branch is claude/modest-dijkstra-ju73pw)
3. `npm install && npm test && npm run test:integration`
4. Read this file, then DEPLOY.md section 13, and do it. Take his one word before the deploy.
5. Then SPEC_V3.md and the Next section below: the v3 lanes are written; the integrator runs next (docs/workflows/avelie-v3-build.js has the gate and every prompt).

## Who she is (the part that must never drift)

Avelie is Justin Newsome's creator-owned persistent fictional character. She is 22. She is a person in her own right with her own life, taste, opinions, limits and days, not an assistant, not a companion product, not a mirror. Justin's words: "my girl don't act like that" about bots that do whatever they are told. The whole point is the character.

Decisions Justin made on 2026-09-24 that override the older handoff docs in canon/reference/handoff-docs:
- She is 22 (the frozen source says 24; the build adapts every 24 to 22 and leaves the source untouched and hashed).
- The named music anchors in the old docs (Harry Styles, Olivia Rodrigo, Elvis, Perry Como, Velvet Underground, Lou Reed, Ariana, older soul, dramatic pop) are HIS taste, not hers. "She's into whatever Avelie is into." Her taste is hers to reveal, never a list to recite.
- Fresh start, code and relationship. "She will meet me for the first time again." Relationship state: strangers. No fact about him is seeded. SHARED HISTORY is empty.
- She must be a person inside Cloudflare: sealed ontology. No prompts, models, files, apps or tech in the story, ever. Technical truth lives only in the operator channel.
- Explicit scenes matter to him. Anthropic models will not write them, so the explicit performer is a provider switch in the Model panel (OpenAI or Workers AI), never a prompt trick. Switching the performer changes nothing about her rules, memory or state.
- Photos must work from v1: "she's gonna show me pics as we talk". OpenAI gpt-image-1 through images/edits with the five master images as identity references; every output is a candidate until he approves it; a rejected picture's hash can never come back.
- Model choice was left to Claude: Claude Opus 5 for her voice (effort medium, 700 output tokens), Claude Sonnet 5 for the proposal pass, gpt-image-1 for photos, Workers AI as the key-free fallback. He asked about claude-opus-5-5 ("way cheaper"): yes, add it to the price table first, switch between conversations.
- "She texts first" is opt-in and capped at 10 a day. His words: "this is not a line for me, I know it's fake the whole time." No retention hooks anywhere: no "miss you", no streaks, no guilt, no urgency, no exclusivity.
- Nothing she says or shows becomes canon until he approves it in the app (proposals inbox, image approvals).
- Everything planned for v3 was folded into v2 (SPEC_V2.md sections A to Z). Then, after the first talk, he decided a further v3 ("SHE WILL BE HUMAN"): voice bank and corrections ledger, human memory, wants and stakes, grounding, phone calls and video clips, an imperfection engine, blind tastings, a fine-tune pipeline. Excluded by him: a day engine that makes her unavailable ("she needs to always be available for now"). SPEC_V3.md is the contract for that, once written.
- Cloudflare Access fronts her at avelie.bladepharoh.com. He lifted HQ's "never touch Access" rule for this one app.
- "Blade" never appears in public copy. No key or token is ever pasted in chat, written to a file, or printed.
- After the first talk (2026-09-24, ~4:50pm): "this is AI as fuck" about built punchlines; "im done talking, i want her real"; "wipe it". The talk was exported to backups/ and the database wiped back to the seed. He will not test again until v3 is deployed. His pre-authorised go for that deploy: "deployed before i even start testing"; still show the before/after list.

The six laws she is built on: agency (she starts beats, decides, goes quiet), continuity of intimacy (closeness is hers to give, pause or stop for a present reason; nothing obligates or entitles), offscreen life (ordinary days that move without inventing shared events; she never claims she waited or suffered), sealed ontology (a person, never a program, in the story), no interviewing (a third question-ending reply in a row is a failure the checks retry), and canon by approval (memory changes only through him).

## Status

v1 is LIVE at https://avelie.bladepharoh.com since 2026-09-24 ~4:04pm EDT: Worker `avelie`, D1 `avelie` (2c14ef65-a599-414d-b0d1-3f71b27c377a, migrations 0001 to 0003 applied), R2 `avelie-media`, Access application "Avelie" (One-time PIN, owner only, 24h, AUD in wrangler.jsonc), secrets ANTHROPIC_API_KEY (workspace-scoped key) and OPENAI_API_KEY set from his clipboard, Workers Paid plan on. The live v1 is the audit fix pass plus the humor rule (HOW YOU ARE FUNNY in the overlay, `written_joke` flag) plus the provider-reason log and the workspace header; latest Worker version e85af696 at ~5:20pm. The database holds the seed only (0 conversations, 33 facts, relationship strangers) after his "wipe it".

v2 is BUILT on this branch (worktree scratchpad/avelie_v2, base commit eac9fe5, six build lanes in parallel) and NOT deployed. The v1 fix pass (spend caps refuse unpriced models, proposal pass budget check, Anthropic maxRetries 0, null-hash masters skipped, import caps and fixed-canon guard, preview_urls false, deploy guard script, the humor rule) lives on the main clone's branch and is merged onto v2 by the integrator, not by the lanes. Until the integrator's merge, this tree does not carry those fixes; do not deploy it as is.

After the integrator: `npm test`, `npm run test:integration`, commit, push, then DEPLOY.md section 13 (`git pull`, `npm run db:remote` for the three 0004 files, `npm run deploy`).

## What was built in v2 (the files, by what they do)

The v1 layout stands (constitution in code, memory in D1, checks that retry or block but never sanitize, the photo pipeline, the Access gate, the four pages). v2 adds:

- `src/markers.ts`: the bracket markers, pure. `parsePhotoMarker` moved here from images.ts (re-exported there), `parseSongMarker` (`[song: Artist - Title]` to `{ artist, title, searchUrl }`, Spotify search, no OAuth), `stripMarkers`. A marker may sit anywhere in the text; every marker is removed, the last one with a value wins.
- `src/life.ts`: her life. Threads (routine, event, person, place, arc) versioned like facts, a life log, `whereSheIs` (routines and events against her timezone with Intl only), `lifeSection` (the YOUR LIFE RIGHT NOW block; when empty it says nothing has been written down yet and she still has days), `computeDeliverAt` (real-mode delay, deterministic from the message id). Nothing seeded.
- `src/callbacks.ts`: up to two things she could bring up, deterministic by UTC date plus conversation id, minus anything mentioned in the last 20 messages, from different kinds when possible. Rendered as THINGS YOU COULD BRING UP, never as an instruction to ask.
- `src/provenance.ts`: one `message_context` row per reply with the ids the turn was built from (prompt version, provider, model, history and fact ids, threads, callbacks, unknowns, counts, flags, mode, run ids, retried, deliverAt, song, photoRequested, opener). Written in the turn's own batch. Ids and counts only.
- `src/chat.ts`: markers off before the checks; `song_json` and `deliver_at` on the row; the provenance statement in the commit; `opts.openerNote` for `/open` and her first texts (no user message stored, `userMessage: null`); two new flags, `song_marker_dup` and `callback_forced`, flag only.
- `src/prompt.ts` (PROMPT_VERSION suffix p4): MODE (together or apart), mood and a running cooling-off, YOUR LIFE, the callbacks, opinions kept with their prefix. The stable prefix is byte-identical to v1 except for the SONGS rule and the photo-look line the constitution build adds to the overlay. `src/context.ts` loads threads and log and picks the callbacks.
- `src/proposals.ts`: kind `life` (promotion creates the thread), `opinion_change` supersedes the same subject, `relationship` carries `mood` and `cooling_off_hours`. `src/state.ts`: `mood` and `cooling_off_until` validated on the relationship state.
- `src/api.ts` and `src/index.ts`: every route in API.md v2; `scheduled` dispatches the four crons. `src/drift.ts` (five scenarios tagged drift, a throwaway conversation, a `drift_reports` row), `src/backup.ts` (the export to R2 `backups/`, keep 30).
- `src/herfirst.ts` (the first-text decision as a pure function plus the runner; `dependency_hook` is a hard reject), `src/push.ts` (VAPID ES256 through crypto.subtle, empty-body Web Push, subscription rows), `scripts/gen_vapid.mjs`, `public/sw.js`, `public/manifest.webmanifest`, `public/icons/`.
- `src/voice.ts` (her voice notes: Workers AI by default, ElevenLabs with its key, off; his recordings transcribed with Workers AI whisper or OpenAI), `src/vision.ts` and the provider adapters (his photos as image blocks; Workers AI without a vision model tells her she could not open it), `src/media.ts` (the library and `[media: title]`).
- `src/timeline.ts`, `src/voiceprint.ts`, `src/exportCharacter.ts`; `public/timeline.html`.
- `public/`: bubbles with human timing (`js/bubbles.js`, pure), the Together / Texting toggle, Let her start, the Photos drawer, song cards, the why panel, Regenerate, the paperclip and the mic, the Life tab with the weekly grid, Mood and Cooling off, the Opinions filter, the Model page's Timing, Her first texts, Voice, Notifications, Weekly drift check, drift reports and voiceprints, the Library tab, the Export tab's Character JSON and bible.
- `migrations/0004_life.sql` (life_threads, life_log, message_context, drift_reports, messages.deliver_at, messages.song_json), `0004b_push.sql` (first_texts_daily, push_subscriptions, messages.audio_key, messages.images_json, media_library, messages.media_id), `0004c_voiceprint.sql` (voiceprints). None touches an existing row.
- Tests: `tests/unit/*_v2.test.mjs`, the v2 checks appended to `tests/integration/run.mjs`, five scenarios tagged `drift: true` plus four new ones in `tests/behavior/scenarios.json`, `--compare` in `tests/behavior/run.mjs`.
- Docs: API.md (v2 section), README.md, DEPLOY.md (sections 13 to 18), docs/BEHAVIOR.md, docs/ARCHITECTURE.md, this file.

Stub provider triggers for tests: `[[FAIL]] [[REFUSE]] [[EMDASH]] [[LIST]] [[PHOTO]] [[QUESTION]] [[LONG]] [[NAME:x]] [[FACT:x]]` from v1, plus `[[SONG]] [[LIFE:x]] [[MOOD:x]] [[VOICE]] [[MEDIA:title]]`; a stub turn with images replies "(photo received)".

## Decisions baked into v2 (recorded so nobody relitigates them)

- Migration numbers: SPEC_V2 says 0003 for v2; the live database already had 0003_messages_seq_unique, so v2 is 0004_life, 0004b_push, 0004c_voiceprint. Never edit 0001 to 0003.
- She texts first: opt-in in his words, capped at 10 a day, quiet hours 23:30 to 08:30 her time, never while her life says busy, never a third in a row, a `dependency_hook` on a first text is dropped and logged. SPEC_V2 seeds the number at 10; his word was opt-in. The integrator sets the shipped default (0 until he turns it on is the reading that matches "opt-in"; 10 matches the spec line). Say which in the deploy before/after.
- Voice: Workers AI is the default voice (no key); ElevenLabs only with its key and a voice id; `voiceMode` `some` (only when she ends a message with `[voice]`). Voice clips of her singing are not in v2.
- Vision: on by default; up to three photos per message, only the last six of his messages carry their images into the prompt; a performer that cannot see gets a plain line saying she could not open it, so she never pretends.
- Push: only for her first texts, never anything else; empty-body pushes, the service worker fetches the text; keys optional, feature off without them.
- Songs: Spotify search links, no Spotify account linking in v2; her taste, not his; the flag `song_marker_dup` when she names the song twice.
- Delay: real mode is off by default (`replyDelayMode` instant); when on, a busy block delays up to the cap (6 minutes default, 120 max), otherwise 5 to 90 seconds; never explained in the story, never framed as her waiting or hurting; an opener turn has no delay.
- Mood and cooling-off: no automatic decay; he clears it in the Now tab or the extractor proposes the thaw.
- Drift check: off by default; five scenarios, Mondays 13:00 UTC, inside the caps; the report is information, not a verdict.
- Backup: nightly to R2 `backups/`, 30 kept; the SQL dump from the Mac stays as the second copy.
- Her life is empty at the fresh start on purpose. The prompt says she still has days; the record fills through him and through approved proposals.
- The interface: his words, "that interface is not COOL btw". v2 adds controls, still dark, still one accent, still no prose; the real design pass is his call for v3.

## How to run locally

```
npm install
cp .dev.vars.example .dev.vars      # DEV_ACTOR_EMAIL, stub providers, no keys
npm run build:canon
npm run db:local
npm run dev                         # http://127.0.0.1:8787
npm test                            # canon build, typography, master hashes, typecheck, unit tests
npm run test:integration            # wrangler dev on 8790 on the stub, drives the API
npm run behavior                    # scenario suite against a running app; writes reports/
```

A cron job by hand: `npx wrangler dev --port 8787 --var ACCESS_AUD: --test-scheduled`, then `curl "http://127.0.0.1:8787/__scheduled?cron=0+7+*+*+*"` (the others: `0+13+*+*+1`, `*/20+*+*+*+*`, `0+14+*+*+1`).

## Deploy

DEPLOY.md. Sections 1 to 9 are done (v1). Section 10 is any redeploy. Section 13 is the v2 round: pull, `ls migrations`, `npm test`, `npm run test:integration`, `npm run db:remote`, `npm run deploy`, the proof curls, the four cron rows in the dashboard. Sections 14 to 18: the optional secrets (ElevenLabs, VAPID), the backups, the drift check, the phone install and notifications, what she-texts-first does and does not do. One before/after list, one word from him, one deploy.

## v3: what was built (2026-09-24, six lanes on the v2 tree, unintegrated)

SPEC_V3.md is the contract (revision 2, the skeptic's cuts folded in). His direction: "she needs to be REAL, not this AI BULLSHIT"; "SHE WILL BE HUMAN"; everything except a day engine ("she needs to always be available for now"); he will not test until v3 is deployed. His answers to the spec's open questions, baked in as defaults: her city is Portland, Maine with the weather on; training on OpenAI is acceptable, "Leave him out of the state" on by default, explicit exchanges left out by default; the texter base is gpt-4.1-mini; there is no Runway key, so clips ship off with the code path complete; the three numeric defaults ship as written; an Approve-all button as well as per line and per tag, the second 150 lines later; `provisionalRecallEvery` 0 and `typoCueShare` 0 ship off; ElevenLabs calls deferred, the settings reserved.

The lanes (files by owner, in SPEC_V3 "Build lanes"): M1 voice bank, corrections, imperfection, checks, the 0005 migrations; M2 memory, wants, grounding, weather, portraits, maintenance, callbacks, life; M3 the pipeline (types, db defaults, the TEXTURE paragraph and -p5, prompt, context, the prepareTurn / generateDraft / commitReply split with the pending-tasting gate, proposals, state, provenance); M4 calls, video, tastings, finetune, budget, images (Range, portrait approval), export, operator, timeline, character export, the providers (the two-block cache split, generateFromText, mintRealtimeSecret, runway.ts, the stub triggers); M5 the UI; M6 the router (every route in the table and every settings row), the entry (CSP for the realtime origin, the microphone permission, the nightly maintenance), the Mac fine-tune script, the unit and integration tests, the scenarios, the v3 workflow and these docs.

M6's contract notes for the integrator (names the router imports that the spec did not fix, settled by the integrator on 2026-09-24, see below): `geocode(env, settings, name)` from weather.ts; `finetuneStatus`, `exportTrainingStream(db, settings, { stripHim, includeExplicit })` (a ReadableStream), `exportSidecar`, `useTexter`, `revertTexter` from finetune.ts; `ledger(db)` returning `{ performers, recent }` and `promote` from tastings.ts; `nightly(env, db, settings)` from maintenance.ts; `serveMedia(env, db, id, range)` in images.ts (the fourth argument, as the other three media servers already take). The router reads a tasting and a call's messages with its own SQL (no export named for them). The marks routes are the router's own SQL on `message_marks`. `GET /api/finetune/status`, `/use` and `/revert` read the stored settings, never the local `.dev.vars` overlay. `GET /api/memory` defaults to entity fact. The v3 unit tests skip themselves (visibly) while a lane's module is not in the tree, and look through short alias lists where the spec names a behavior but not an export; the integration block skips itself when the server has no v3 routes. The runner passes `OPENAI_API_KEY=dummy-for-settings-only` as a `--var` so `/use` can be exercised on the stub.

## v3: integrated (2026-09-24, commit "v3: six lanes integrated")

The integrator's pass on the six lanes, everything green on the tree: build:canon, build:voicebank, typography, verify_assets, tsc, unit 417/417 (0 skipped), integration 129/129 (0001 to 0005b applied by the runner), node --check on every public script, the UI smoke against wrangler dev, the 07:00 cron through `--test-scheduled`, check:deploy. What it changed, by file: `src/exportImport.ts` no longer exports `push_subscriptions` (its keys_json holds the browser's subscription secrets; the v2 check caught it); `src/memory.ts` gains `FIRM_EPSILON` 0.001 under the 0.20 line so "Remind her" makes a Low fact firm at once (the spec's own arithmetic lands a hair under it); `src/providers/stub.ts` answers a retry with the previous real message, triggers stripped, instead of echoing the operator note (which read as a tech leak and hid what the first draft raised); `src/api.ts` `GET /api/assets` gains `videos` and `portraits` (approved) and `GET /api/conversations/:id/messages` attaches `mark` to her story rows (the page's Keep / Drop survives a reload); `src/maintenance.ts` uses `tastings.expireStaleStmts` and `calls.expireStaleCallsStmt` (one statement each, the modules' own) and `calls.expireStaleCallsStmt` now sets `ended_at` and `end_reason` expired; `src/tastings.ts` drops the second provenance write after a pick (commitReply carries the tasting block); `public/js/state.js` reads the server's `shown` for the faded chip; `tests/unit/prompt_v3.test.mjs` reads TEXTURE in the generated file's escaped form; the two retry checks in `tests/integration/run.mjs` assert the stored reply is the clean retry. Not done here, by design: the three read-only reviewers, the fix pass and the independent verify (the workflow's later phases), and the deploy.

## Next

1. The v3 integrator ran (above). Still to run from docs/workflows/avelie-v3-build.js: the three read-only reviewers (hooks and character integrity; pipeline and data; UI against routes), the fix pass, the independent verify.
2. Deploy v2 and v3 together per DEPLOY.md sections 13 and 19 (one before/after list, his pre-authorised go still shown once), then sections 20 to 24 as they apply (no Runway key today; the city is already Portland; the two switches stay off). Then HQ (STATE.md, MAP.md, memory/avelie.md, CONFLICTS.md), commit and push, the Drive STATE copy, ONE zip in chat with its hash.
3. Only then his first real talk on v3. Read what he says about her before touching her rules (docs/BEHAVIOR.md, the standing rule). Approve some voice lines first (State > Voice), or she reads none of them.
4. Run `npm run behavior -- --only v3` on the real provider once (H03 is the gate for `provisionalRecallEvery`; H05 for `typoCueShare`), `--compare` once (Opus 5 against the tasting performer), and read the reports as a person before looking at the counts.
5. v3.1 when he asks: the second 150 seed lines, the recall outcome bookkeeping, the `[clip:]` marker, the ElevenLabs call path (SPEC_V3 "Deferred to v3.1").

## Rules that stay on (each one cost real hours)

- Nothing becomes canon without his approval. No retention hooks. She never interviews. Sealed ontology.
- Never sanitize her voice with post-processing; a bad reply is retried or blocked, not edited into blandness (mechanical repairs only: the em dash, a stray list marker).
- No secrets in code, logs, browser or chat. Keys go clipboard to Worker.
- Typography: " -- " and "..." only. `npm run check:typography` guards the repo.
- One before/after list and ONE "go" from Justin before anything irreversible (deploys, DNS, Access, mailboxes). Deploys: he decides.
- Every finished round ends with ONE zip attached in chat, a copy in ~/Downloads, its SHA256 stated. Exclude node_modules, .git, .dev.vars, backups/ and anything with a key.
- HQ before you stop: STATE.md (dated EDT, latest first), MAP.md rows, memory/avelie.md, CONFLICTS.md for anything needing his decision, commit and push HQ, refresh the Google Drive STATE copy if the update-hq skill is present.
- He wants child-simple, one-click-at-a-time instructions, no doc quotes, no jargon. He will not create API tokens.
- node_modules is never a symlink inside a worktree that git can see (.gitignore says `node_modules`, no trailing slash, since e2c89fc). A tracked symlink once replaced the real packages with a link to itself.

## Open items for him (ask once, in one list, when the time comes)

- v3, after the deploy: approve the first voice lines (State > Voice: per line, per tag, or Approve all); whether to turn on the half-remembered recall (Model > Memory, 8) and the typo cue (Model > Text, 0.05) once the two scenarios read right; a Runway key if he wants clips; which ElevenLabs voice for calls in v3.1; the first Keep marks toward the 200 the texter needs.

- The shipped default for her first texts (0 until he turns it on, or 10 from the start); the two optional secrets (ElevenLabs, VAPID) if he wants the voice he chooses and the phone notification.
- claude-opus-5-5 as her performer: add it to the price table on the Model page, then switch between conversations.
- Masters 02 and 04 carry a strip of screenshot text at the bottom edge; cropping changes their hashes. The live database already holds the old hashes and 0002_seed.sql can never be re-applied, so a crop needs: the new PNGs in public/images/masters, canon/seed/assets.json and canon/ASSET_MANIFEST.json updated, a NEW migration (0005_masters.sql with `UPDATE visual_assets SET sha256 = ..., bytes = ... WHERE id = ...` for each changed master), `npm test`, `npm run db:remote`, then `npm run deploy`. Without the migration every photo fails with "master image hash mismatch" while every local check stays green. Keeping them as they are is fine.
- The photo price (`imageCostUsd`, flat 0.06) and the model price table are in the Model panel; confirm against current prices.
- What the interface should feel like (the v3 design pass).
- Interns: parked by his choice ("I'll fix them later"). HQ drafts/CUT_OFF_MEGAN_RYAN_2026-09-24.md has the steps. Do not mix it into Avelie work.

## Rollback

`npx wrangler rollback` for the Worker (v1 code runs fine against the v2 tables; it ignores the new columns). State > Export in the app for the JSON, State > Import takes it back after snapshotting; the nightly copies sit in R2 `avelie-media/backups/` (DEPLOY.md section 15). `npm run export:remote` for the raw SQL dump. Tag every deployed tree (`git tag -a v0.2.0 -m "v2 deploy"`).
