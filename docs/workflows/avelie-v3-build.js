export const meta = {
  name: 'avelie-v3-build',
  description: 'Build Avelie v3 (she will be human: voice bank, human memory, wants, grounding, calls, clips, imperfection, tastings, fine-tune) against SPEC_V3.md on top of the green v2 tree',
  phases: [
    { title: 'Gate', detail: 'the v2 tree is in and green, or nothing starts' },
    { title: 'Build', detail: 'six lanes on disjoint files, three at a time' },
    { title: 'Integrate', detail: 'one agent settles drift and makes everything green' },
    { title: 'Review', detail: 'three adversarial reviewers, read-only' },
    { title: 'Fix', detail: 'apply confirmed findings, rerun tests' },
    { title: 'Verify', detail: 'independent final verification' },
  ],
}

// Pass the tree's absolute path as args.repo (on Justin's Mac: /Users/justinnewsome/Documents/ClaudeCode/2026-09-24_avelie,
// or the v2 worktree the lanes were run on).
const REPO = (typeof args === 'object' && args && args.repo) ? args.repo : '/Users/justinnewsome/Documents/ClaudeCode/2026-09-24_avelie'

// ------------------------------------------------------------------ the gate (SPEC_V3 header, "Build gate")

// Nothing below runs unless the v2 tree is in: the ten v2 files and the two lettered 0004
// migrations exist, the tree is clean, npm test and npm run test:integration pass, and the
// v1 fix pass is merged (written_joke in src/checks.ts). The v3 lanes own files that do not
// exist until then.
phase('Gate')
const GATE = `You are the GATE for the Avelie v3 build in ${REPO}. Do not edit any file. Run, in this order, and stop at the first failure:
1. For each of these paths, confirm it exists (ls): src/herfirst.ts, src/push.ts, src/voice.ts, src/vision.ts, src/media.ts, src/timeline.ts, src/voiceprint.ts, src/exportCharacter.ts, public/sw.js, public/manifest.webmanifest, migrations/0004b_push.sql, migrations/0004c_voiceprint.sql.
2. git status --porcelain must print nothing.
3. npm test must pass.
4. npm run test:integration must pass (kill the dev server after).
5. grep -c written_joke src/checks.ts must print a number of 1 or more.
Return exactly one line: "GATE GREEN" when all five hold, otherwise "GATE RED: <which step> <the exact failing output, at most 40 lines>".`
const gate = await agent(GATE, { label: 'v3:gate', phase: 'Gate', effort: 'low' })
if (!gate || !/GATE GREEN/.test(gate)) {
  log('v3 build stopped at the gate: ' + (gate ?? '(no answer)'))
  return { gate, stopped: true }
}
log('gate green; building')

// ------------------------------------------------------------------ the common prompt

const COMMON = `You are extending the Avelie runtime in ${REPO} (do not commit or push; do not run wrangler deploy, wrangler secret, or anything with --remote). Work ONLY inside ${REPO} and ONLY on the files your lane owns. v2 is integrated and green on this tree: npm test (build:canon, typography, assets, tsc, unit) and npm run test:integration pass; keep them passing for your files (run npx tsc --noEmit at the end; run the unit tests that touch your files). Other lanes are writing in parallel against the same SPEC_V3 contract; a file you import may not exist yet: import it by the exact export names in SPEC_V3 and code against the signatures; do NOT create another lane's files. The integrator settles drift.

READ FIRST: ${REPO}/SPEC_V3.md whole (your assignment is the Build lanes section plus the sections it names; the header fixes the migration numbers, the prompt version and the state-section order), then ${REPO}/HANDOFF.md, ${REPO}/SPEC_V2.md, ${REPO}/API.md, and every source file you own or import from. Never edit src/generated/* by hand (npm run build:canon regenerates), canon/constitution/*, or public/images/*.

HARD RULES: typography " -- " and "..." only, never an em dash, en dash or Unicode ellipsis anywhere (node scripts/check_typography.mjs must stay clean). No secrets in code, logs, responses or the browser; the realtime client secret is never logged or audited. She is a person: story-channel text never mentions prompts, models, the app, or the notes he gave. Nothing becomes canon because a model said it. No retention hooks: no scheduled "miss you", no streaks, no guilt, no sadness while the app is closed, no first-text that opens with an unanswered ask. She ALWAYS answers (no day engine; her life is texture, never a reason not to reply). Never sanitize her voice with post-processing (retry or block; mechanical repairs only; the imperfection engine is prompt-driven). TypeScript strict with noUncheckedIndexedAccess. Workers runtime only in src/ (no Node-only APIs). No prose in the UI: labels only. Vanilla HTML, CSS and JS; one stylesheet; keep the v2 design system.

JUSTIN'S ANSWERS to the spec's open questions (bake them in as defaults): (1) her city is Portland, Maine (settings city default; add the fact "Lives in Portland, Maine" scope avelie, subject home, source "Justin's decision 2026-09-24" in migration 0005_v3.sql; weather on). (2) Training export: acceptable; "Leave him out of the state" checkbox ON by default; explicit exchanges LEFT OUT of the export by default (an explicit-exchange detector or the Drop mark; document which). (3) Texter base model default gpt-4.1-mini. (4) No Runway key exists: clips ship OFF, the code path complete. (5) The three numeric defaults ship as written. (6) Approve-all button YES, plus per line and per tag; the second 150 lines later. (7) provisionalRecallEvery 0 and typoCueShare 0 ship off. (8) ElevenLabs calls deferred; settings reserved.

Return a plain-text report: files written, exports and their signatures, deviations from SPEC_V3 with reasons, what you could not do, and the exact test commands you ran with their counts.`

const M1 = `${COMMON}

YOUR ASSIGNMENT, lane M1 (voice + corrections + imperfection + checks + schema). Files you own: src/voicebank.ts, src/corrections.ts, src/imperfection.ts, src/checks.ts (exemplar_verbatim, ask_nag, shape_uniform, over_polish; "bot" and "ai" in the tech-leak table; written_joke untouched), src/voiceprint.ts (the seven new weekly stats), canon/seed/voicebank.json (the 150 lines drafted by hand from the constitution per section AA's rules and count table), scripts/build_voicebank.mjs (validates the file, deterministic ids vl_<sha256 first 16 hex>, emits migrations/0005b_voicebank_seed.sql as INSERT OR IGNORE with status unapproved, origin seed, the fixed stamp; export the validator for the unit test), migrations/0005_v3.sql (the consolidated migration in SPEC_V3 verbatim, plus the Portland fact insert), migrations/0005b_voicebank_seed.sql (generated only).`

const M2 = `${COMMON}

YOUR ASSIGNMENT, lane M2 (memory + wants + grounding + weather + portraits + life). Files you own: src/memory.ts, src/wants.ts, src/grounding.ts, src/weather.ts (getWeather, the geocode call and its reader, the 20-minute cache, the stub provider), src/portraits.ts (generatePortrait, owner-triggered only), src/maintenance.ts (nightly(env, db, settings)), src/callbacks.ts (kinds want and ask, the opener exclusion), src/life.ts (portrait_asset_id carried by updateThread and restoreThread; the people list with the last two log notes; carryStmt in the thread chain). Pure functions must not import db.ts.`

const M3 = `${COMMON}

YOUR ASSIGNMENT, lane M3 (the pipeline). Files you own: src/types.ts (systemParts on GenerateRequest, the new run kinds, the CheckContext fields, PromptState additions), src/db.ts (DEFAULT_SETTINGS for every row of the settings table, with the owner's Portland defaults; the three gpt-4.1 prices), canon/seed/settings.json (mirror every default), scripts/build_constitution.mjs (the TEXTURE paragraph after CORRECTIONS, then npm run build:canon), src/prompt.ts (the v3 sections in the header's order; the Relationship line without the four mood keys; PROMPT_VERSION -p5), src/context.ts (turnKey, opener in LoadOptions, assembleSystemOnly with compact and full, compactSystem), src/chat.ts (the prepareTurn / generateDraft / commitReply split, the pending-tasting gate, systemParts, the v3 batch statements, stateText on message_context, the retry rules for exemplar_verbatim and ask_nag), src/proposals.ts (the new kinds and payloads, weight on every element), src/state.ts (mood_set_at and mood_days, carryStmt in the fact and history chains), src/provenance.ts, src/markers.ts (no change expected; owned here so nobody else touches it).`

const M4 = `${COMMON}

YOUR ASSIGNMENT, lane M4 (calls + video + tastings + finetune + providers + media). Files you own: src/calls.ts, src/video.ts, src/tastings.ts, src/finetune.ts, src/budget.ts (assertTastingBudget, priceUsage), src/images.ts (roles portrait and video, Range serving on /media/:id with a fourth range argument, the portrait approval side effect), src/exportImport.ts (the v3 tables in the export and the import whitelist), src/operator.ts (the v3 counts; judgment on proposalProvider), src/timeline.ts, src/exportCharacter.ts, src/providers/* (anthropic: the two-block systemBlocks split; openai: generateFromText and mintRealtimeSecret; new runway.ts with the stub; stub.ts with every v3 trigger; index.ts and types.ts registries). No elevenlabs.ts in v3. Export from src/finetune.ts, for the router: finetuneStatus(db, settings), exportTrainingStream(db, settings, { stripHim, includeExplicit }) returning a ReadableStream, exportSidecar(db, settings, { stripHim, includeExplicit }), useTexter(env, db, settings, { model, inputPerMTok?, outputPerMTok? }, actor), revertTexter(env, db, settings, actor). From src/tastings.ts: runTastingTurn, pickTasting, ledger(db) returning { performers, recent }, promote, expireStaleStmts. From src/calls.ts: startCall, tickCall, endCall, listCalls, getCall. From src/video.ts: startClip, pollClip.`

const M5 = `${COMMON}

YOUR ASSIGNMENT, lane M5 (the UI). Files you own: everything under public/ except public/images/: index.html and js/chat.js (the Note sheet, Keep/Drop, Taste and the two panels with the pending state, the Call button and the call card, the "his version" line), the new js/call.js (WebRTC to the realtime provider, the page-side segment merge, the 30 s tick, the beacon on pagehide; it never logs the start response), state.html and js/state.js (Voice, Notes, Memory, Wants tabs; the Today list, portraits and weights in Life and Facts; the mood fields in Now; Approve all in Voice), model.html and js/model.js (Grounding, Calls, Tastings, Texter cards with the strip checkbox on by default; the video and texture settings; the memory card with the recall switch), images.html and js/images.js (Clips and Portraits tabs), css/app.css, js/api.js, js/nav.js, sw.js and manifest.webmanifest (no change expected). Talk only to the routes in SPEC_V3 "Routes added" and API.md.`

const M6 = `${COMMON}

YOUR ASSIGNMENT, lane M6 (routes, entry, tests, docs, scripts). Files you own: src/api.ts (every route in the SPEC_V3 Routes added table; settings validation for every row of Settings added; the tasting flag on the turn route; the stripHim query), src/index.ts (CSP and permissions policy for the realtime WebRTC origin and microphone; the nightly maintenance call in scheduled), wrangler.jsonc (no change expected; ACCESS_AUD must keep its value), package.json (build:voicebank in the test chain; finetune:run; keep check:deploy in deploy), scripts/finetune_run.mjs (Mac-side; the key from an env var or the clipboard per run, never a file), tests/** (unit *_v3.test.mjs, the integration checks from Tests added, scenarios, tests/README.md), docs/workflows/avelie-v3-build.js (this file), API.md (a v3 section), README.md, DEPLOY.md, HANDOFF.md, docs/ARCHITECTURE.md, docs/BEHAVIOR.md, docs/COSTS.md.`

// ------------------------------------------------------------------ build: six lanes, three at a time (the laptop rule)

phase('Build')
const first = await parallel([
  () => agent(M1, { label: 'v3:M1 voice+corrections+imperfection+checks+schema', phase: 'Build' }),
  () => agent(M2, { label: 'v3:M2 memory+wants+grounding+weather+portraits+life', phase: 'Build' }),
  () => agent(M3, { label: 'v3:M3 pipeline', phase: 'Build' }),
])
log('v3 lanes M1 to M3 done; M4 to M6')
const second = await parallel([
  () => agent(M4, { label: 'v3:M4 calls+video+tastings+finetune+providers+media', phase: 'Build' }),
  () => agent(M5, { label: 'v3:M5 ui', phase: 'Build' }),
  () => agent(M6, { label: 'v3:M6 api+entry+tests+docs+scripts', phase: 'Build' }),
])
const built = [...first, ...second]
const buildReports = built.map((r, i) => `--- v3 lane M${i + 1} ---\n${r ?? '(no report)'}`).join('\n\n')
log('v3 build done; integrating')

// ------------------------------------------------------------------ integrate

phase('Integrate')
const INTEGRATE = `${COMMON}

YOU ARE THE INTEGRATOR for v3. Six lanes just wrote against SPEC_V3.md in parallel, three at a time. Their reports:

${buildReports}

Make everything green, editing any file except src/generated/* (regenerate with npm run build:canon), canon/constitution/*, and public/images/*. Settle every name that drifted between a lane's export and another lane's import (the reports list both sides); prefer the spec's name. Order: npm run build:canon; node scripts/build_voicebank.mjs; node scripts/check_typography.mjs; node scripts/verify_assets.mjs; npx tsc --noEmit; npm run test:unit (the v3 files skip themselves while a module is missing: make them run, not skip); npm run test:integration (the runner applies 0001 to 0005b to a fresh local state and drives every v3 check; kill the dev server after); node --check on every public/js file; a UI smoke (fetch each page and every referenced asset with the dev server up); node scripts/check_typography.mjs again. Confirm the three cuts the spec names stay cut (no [clip:] marker, no ElevenLabs call path, no recall outcome bookkeeping) and the three switches ship as the owner answered (herCity Portland with the weather on, provisionalRecallEvery 0, typoCueShare 0, clips code-complete with videoProvider runway and no key). Return a report: what failed and what you changed (file by file), final counts, anything still broken with the exact error text. Kill any dev server you started.`
const integ = await agent(INTEGRATE, { label: 'v3:integrate', phase: 'Integrate', effort: 'xhigh' })
log('v3 integration done; adversarial review')

// ------------------------------------------------------------------ review: three lenses, read-only

phase('Review')
const REVIEW_BASE = `${COMMON}

You are a READ-ONLY reviewer for v3. Do not edit files, do not start servers. You may run npx tsc --noEmit and node --check. Report findings only, ranked by severity, each with file:line, a one-sentence claim, a concrete failure scenario, and the smallest fix; mark each confirmed or plausible. Integrator report:
${integ ?? '(none)'}
`
const REVIEWS = [
  { key: 'hooks', prompt: `${REVIEW_BASE}\nLENS: retention hooks and character integrity. Read SPEC_V3 sections AA, BB, CC, EE, GG and the code (voicebank.ts, corrections.ts, memory.ts, wants.ts, callbacks.ts, chat.ts, prompt.ts, calls.ts, imperfection.ts). Could any path make her unavailable, late on purpose or silent (there is no day engine)? Could an ask be repeated, become a debt, or open a first text? Could the half-remember section be used to make him talk, or fire on an opener? Could a mood withhold a reply or become punishment? Could the notes section leak that he gave notes, or the word bot? Could a bank line be sent verbatim without a retry? Could the call note or the cue section name the app? Is the stable prefix byte-identical to v2 except TEXTURE (compare CONSTITUTION_VERSION and the diff of scripts/build_constitution.mjs)? Does the Anthropic adapter cache the prefix block only?` },
  { key: 'pipeline', prompt: `${REVIEW_BASE}\nLENS: correctness of the v3 pipeline and data. The pending-tasting gate on every turn shape (plain, tasting, Retry, /open, first text, voice)? A neither pick leaving exactly one reply per user row after the retry? The call end batch (seq collision recovery, the 80-row fold, the flag-only checks, cost = max(metered, priced))? The tick meter never negative, the stop within one tick of a cap? decideMany as one statement per id in one batch, never IN (...)? Every IN list chunked by 90? state_text cut at a section boundary under 24,000 characters? The strip transform leaving every other section byte-identical? Migration 0005: valid D1 SQLite, the ALTERs once, the Portland fact, no existing row touched? The weather fetch never delaying a turn (timeout, Promise.all, null on failure)? memory touch never more than 10 rows? letGoStaleStmts audited? The secret never in the audit row, the call row, a log, or GET /api/calls/:id?` },
  { key: 'ui', prompt: `${REVIEW_BASE}\nLENS: UI against the routes. Trace every fetch in public/js/*.js to src/api.ts (method, path, body, response fields), including call.js (start, the SDP exchange with the bearer, tick every 30 s with cumulative usage, end on End, stop, close and pagehide through sendBeacon with an application/json Blob; the start response never logged; the secret dropped after the exchange). The Taste flow: two panels, the composer disabled while pending, Retry after Neither, the winner chip after a pick. The Note sheet kinds mapping (the first label to kind ai). Keep/Drop cycling. The Voice tab's Approve all, per tag, per selection. The Texter card's strip checkbox on by default and the two export downloads. The Clips tab polling every 5 s up to 10 minutes and the <video controls playsinline> player. No prose leaked into the UI; still dark, one accent, phone width.` },
]
const findings = await parallel(REVIEWS.map(r => () => agent(r.prompt, { label: 'v3:review:' + r.key, phase: 'Review' })))
const findingsText = REVIEWS.map((r, i) => `=== ${r.key} ===\n${findings[i] ?? '(no findings returned)'}`).join('\n\n')
log('v3 review done; applying fixes')

// ------------------------------------------------------------------ fix

phase('Fix')
const fixReport = await agent(`${COMMON}

You are the FIX agent for v3. Verify each finding below against the code and apply every confirmed one with the smallest correct change; for a plausible one, prove it with a test and fix it, or record "not reproduced". Then: npm run build:canon, node scripts/build_voicebank.mjs, node scripts/check_typography.mjs, npx tsc --noEmit, npm run test:unit, npm run test:integration (kill the dev server after). All green. Return a table finding -> action with file:line and the final counts.

FINDINGS:
${findingsText}`, { label: 'v3:fix', phase: 'Fix', effort: 'xhigh' })
log('v3 fix done; final verification')

// ------------------------------------------------------------------ verify

phase('Verify')
const verdict = await agent(`${COMMON}

You are the FINAL VERIFIER for v3, independent of everyone before you. Run: npm run build:canon; node scripts/build_voicebank.mjs; node scripts/check_typography.mjs; node scripts/verify_assets.mjs; npx tsc --noEmit; npm run test:unit (no v3 file may skip); npm run test:integration; then start your own dev server on port 8791 (apply migrations to tests/integration/.state first; use --test-scheduled) and by hand: GET /api/voicebank shows 150 unapproved seed lines; approve twelve and confirm the next turn's context carries exemplarIds; POST /api/calls/start on the stub, three ticks, an end with four segments, and confirm four story rows with call_id and no secret anywhere; a tasting turn on stub and stub-b, a pick, and the ledger; GET /api/finetune/export.jsonl parses and the sidecar chain matches; GET /api/grounding on the stub weather says 68F clear; hit /__scheduled?cron=0+7+*+*+* and confirm a backup and a maintenance audit row; confirm the CSP header carries connect-src api.openai.com and the permissions-policy the microphone. Kill the server. Return GREEN or RED with counts per step and exact failing output if RED. Fix nothing unless a one-line typo blocks a step, and say so.

Fix report:
${fixReport ?? '(none)'}`, { label: 'v3:verify', phase: 'Verify', effort: 'high' })

return { gate, integ, findingsText, fixReport, verdict }
