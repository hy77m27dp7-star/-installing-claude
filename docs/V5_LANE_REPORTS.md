# v5 lane reports (2026-09-26)

Ten lanes wrote against SPEC_V5.md at the same time in the v5 worktree. Their reports, verbatim, as handed to the integrator (the one Unicode ellipsis in L8's report is written as "..." so the typography check stays clean).

--- L1 Her clock and the nightly pass ---
Lane L1 (her clock and the nightly pass) is finished. `npx tsc --noEmit` shows no errors on the whole tree as it stands. That includes the other lanes' files that already exist: arcs, views, hygiene, proposals, types, wants, context, prompt, api and index. So there are no missing-module or missing-export errors left to excuse. Nothing was committed, pushed or deployed. I started no dev server or browser.

**Files written**, all under `/private/tmp/claude-501/-Users-justinnewsome-Documents-ClaudeCode-HQ/e5dcbc67-4480-4c1c-bdb2-d7e749c0c830/scratchpad/avelie_v5/`:
- New: `src/clock.ts`, `src/storycall.ts`, `src/nightly.ts`
- Changed: `src/grounding.ts`, `src/weather.ts`, `src/herfirst.ts`, `src/deliveries.ts`, `src/maintenance.ts`

**Exports.** All signatures match SPEC_V5 exactly.
- **`src/clock.ts`:**
  - Constants: `CLOCK_ACTOR`, `CLOCK_HORIZON_DAYS`, `HER_DAY_MIN_APART_MS`, `SNAPSHOT_WEATHER_MAX_AGE_MS`, plus one extra, `TIME_SINCE_HEADER`.
  - Types: `ClockSpan`, `StoryClock`, `ClockView`, `LastExchange`, `HeldGrounding`.
  - Pure: `isTogether`, `disabledClock`, `storyNow`, `frozenOverlapMs`, `storyElapsedMs`, `storyAgeDays`, `storyInstantOf`, `deferredInstant`, `spansFromVersions`, `localDayKeyOf`, `localInstant`, `dayBounds`, `herDayKey`, `gapWords`, `timeSince`, `timeSinceSection`, `clockWordsFor`, `heldGrounding`, `clockView`.
  - Database: `syncStoryClock`, `loadStoryClock`, `lastExchange`, `holdWeatherStmt`, `shiftBeatsForSpan`.
  - It imports none of prompt, wants, arcs, callbacks, memory or proposals.
- **`src/storycall.ts`:** `NightlyTag`, `NightlyBudget`, `newNightlyBudget`, `PaidJsonCall`, `PaidJsonResult`, `paidJsonCall`, `parseJsonArray`, `parseJsonObject`, `cleanLine`, `NightlyProposal`, `fileNightlyProposals`, `StepResult`. Extra constants: `NIGHTLY_BUDGET_DEFAULT_USD`, `NIGHTLY_BUDGET_MAX_USD`, `NIGHTLY_REFILE_DAYS`. It never imports proposals.ts.
- **`src/nightly.ts`:** `NightlyStep`, `NIGHTLY_STEPS`, `HER_DAY_PREFIX`, `NightlyRunRow`, `NightlyStoryResult`, `runNightlyStory`, `listNightlyRuns`, `herDaySystem` (the spec text verbatim), `herDayUser`, `parseHerDay`, `runHerDay`. Extra: `NIGHTLY_ACTOR = "nightly"`.
- **`src/weather.ts`:** adds `DayWeather`, `dayForecastUrl`, `readDayWeather`, `dayWeather`.
- **`src/grounding.ts`:** `groundingSection` accepts `clockWords?: string | null`.
- **`src/herfirst.ts`:**
  - The together gate and then the frozen gate sit after `gateReason(neutral)` and before the count and the cap.
  - The `lastMessageAt` passed on is the story-time age turned back into an instant.
- **`src/deliveries.ts`:** `pushDueReplies(..., opts: { quiet?; frozen? })` returns `frozen: true` when held, and `PushDueResult` gains `frozen?: true`.
- **`src/maintenance.ts`:** `nightly()` takes `(Partial<Settings> & WantsSettings) | null | undefined`. It loads the clock once and passes it as the fifth argument of `letGoStaleStmts`.

**Deviations from SPEC_V5:**
1. **`dayWeather` with the stub provider** returns the fixed clear 68/55 day even with no coordinates, as `getWeather` does. The spec lists "no coordinates -> null" first.
2. **Nightly steps skipped as "already done"** do not write a `nightly_runs` row. Otherwise `INSERT OR REPLACE` would overwrite the done row with "skipped".
3. **Her-day step status when the paid call fails:** `provider_failed` is recorded as `failed`. Budget stops, price and configuration problems are recorded as `skipped` with that reason, so the "skipped 'nightly budget'" integration check holds.
4. **"Normalised proposal" in `fileNightlyProposals`** means lowercased, trimmed and whitespace collapsed, the same as proposals.ts `normText`. It also skips a repeat inside the same call.
5. **The held-scene snapshot reads the database directly:**
   - The outfit comes from its own `visual_assets` query (approved scene photos with `decided_at <= frozen_at`, limit 50) instead of `listAssets`.
   - Each snapshot part is in its own try, so a failed weather, rows or outfit read gives a span without that part.
   - The runs listed for the her-day `STEPS:` block come from a direct join, not `listBeatViews`, and read as empty on a database without the v5 tables.
6. **Timestamps:** `syncStoryClock` uses its `now` argument for the rows it writes (`created_at`, `updated_at`, `resumed_at` stamp and the `beats_shifted_at` claim). The beat-move statements use `nowIso()`.
7. **Beat-move batch failure:** if the batch that moves beats fails after the claim, it is logged and the result reports 0 moved. The claim is not released, so those beats will not be moved later.
8. **`herDayUser` layout:** an empty block reads as its header line followed by a `(none)` line. There are no blank lines between blocks, and the weather temperatures are rounded with no unit letter.

**What I could not do:**
- **Stale span edge case, not handled:** a restore that keeps the start of a together run (same `created_at`) but drops the version that closed it. The existing closed `sc_v<N>` row makes the insert a no-op, so the clock would not freeze. I kept to the spec's exact reads; the backstop is the export rule that deletes `story_clock` on a restore.
- **v5 unit suites:** `clock_v5`, `nightly_v5` and `consumers_v5` are not in the tree yet (they are L10's). Instead I ran throwaway scripts, since deleted, through `tests/unit/helpers.mjs` `fakeD1`. All passed:
  - The spec's clock cases: frozen across midnight gives Tuesday 11:50pm, 5 minutes elapsed and 23h50m apart. Frozen three days then resumed gives 2 minutes and then 3 minutes. Friday's apart time is 13h55m.
  - `herDayKey` at 07:00Z, 14:00 and 00:30 her time; `localInstant` across the November DST change and its 400 on a bad date; `gapWords`; `timeSinceSection`; `spansFromVersions`; `clockWordsFor` with carried-over words; `heldGrounding`.
  - `syncStoryClock` case B: the delete, the insert with `prior_time` and the bounded weather read, then the freeze audit.
  - `syncStoryClock` case C: the close, the claim, one beat moved to exactly resumed plus (due minus frozen) with its want note, and the resume audit.
  - `runNightlyStory`: off, and a forced her_day that filed one `life_update` and wrote the model run, the `nightly_runs` row and the audit.
  - `parseHerDay`: case-insensitive thread match, a line naming him dropped, an unknown thread dropped, a bad time read as 12:00.

**Commands run, from the worktree:**
- `npx tsc --noEmit`: 0 errors.
- `node scripts/check_typography.mjs`: typography clean.
- `node --experimental-strip-types --test tests/unit/<name>.test.mjs`. My suites, all passing:

| Suite | Pass | Fail |
|---|---|---|
| grounding_v3 | 8 | 0 |
| herfirst_v2 | 13 | 0 |
| deliveries_v4 | 6 | 0 |
| wants_v3 | 10 | 0 |

- Other suites that load these files:

| Suite | Pass | Fail |
|---|---|---|
| places_v4 | 15 | 0 |
| phone_v4 | 12 | 0 |
| settings_v3 | 10 | 0 |
| entry_v3 | 6 | 0 |
| life_v2 | 21 | 0 |
| migrations_v3 | 5 | 0 |
| exportImport_v4 | 6 | 0 |
| proposals_v3 | 7 | 0 |
| prompt_v3 | 8 | 0 |
| scenarios_v3 | 3 | 0 |
| hisface_v31 | 22 | 1 |
| entry_v4 | 6 | 1 |

  - The hisface_v31 failure is a test still expecting `PROMPT_VERSION` to end `-p7`; the move to `-p8` is L7's, and the test line is L10's to change.
  - The entry_v4 failure is in the `*/20` cron text of `src/index.ts`, which is L8's.

--- L2 Arcs: dated beats on her wants ---
LANE L2 REPORT (Arcs: dated beats on her wants). All three lane files are written, and they typecheck and run clean. Nothing was committed or pushed, and I started no servers or browsers.

FILES WRITTEN (worktree /private/tmp/claude-501/-Users-justinnewsome-Documents-ClaudeCode-HQ/e5dcbc67-4480-4c1c-bdb2-d7e749c0c830/scratchpad/avelie_v5)
- src/arcs.ts (new)
- src/wants.ts (modified)
- src/callbacks.ts (modified)

EXPORTS
src/arcs.ts:
- Types: BeatKind, BeatOutcome, HisPart, ArcBeatRow, BeatRunRow (the snake_case columns of 0009), BeatVariant, BeatView.
- Constants: STEP_OUTCOMES, EVENT_OUTCOMES, HIS_PARTS, OWNER_READER, ARC_PREFIX, BEAT_RESOLVE_AFTER_MS, BEAT_MAX_ATTEMPTS, BEAT_VARIANTS_MAX, OUTCOME_LOG, HIS_PART_RE. The values are exactly those in the spec.
- Pure functions:
  - outcomesFor(kind)
  - validateVariants(v, kind)
  - parseVariants(json, kind)
  - dueAtFor(dueOn, dueTime, tz)
  - beatIsDue(run, storyNowMs)
  - outcomeWords(o)
  - hisPartSentence(p, note)
  - beatLines(view, now, tz, clock, opts)
  - beatLinesByWant(views, now, tz, clock, opts)
  - arcSystem(hasVariants)
  - arcUser(args)
  - parseArcAnswer(text, view, messageIds, togetherKnown, hisAfter)
- Database functions:
  - listBeatViews(db, opts = {}) (runs read in chunks of 90)
  - getBeatView(db, beatId, reader = OWNER_READER)
  - createBeat(db, input, actor, tz)
  - updateBeat(db, id, patch, actor, tz)
  - resolveBeat(db, beatId, input, actor)
  - createBeatFromProposal(db, payload, text, source, actor, tz)
  - applyBeatOutcome(db, payload, source, actor)
  - runArcPass(env, db, settings, clock, budget, now): Promise<StepResult>

src/wants.ts:
- moodNow(rel, now, settings, fallbackSetAt = null, clock: StoryClock | null = null)
- wantsSection(wants, log, asks, now, tz, limit, opts: { clock?; beatLines? } = {})
- letGoStaleStmts(db, now, days, actor = "maintenance", clock = null)
- wants.ts never imports arcs.ts. findWant and logWant are unchanged and still exported.

src/callbacks.ts:
- CallbackKind gains "beat".
- pickCallbacks args gain beats?, clock? and tz? (the tz arg is not in the spec; see deviation 1).
- With a clock, every age is story time and event instants go through deferredInstant.
- On an opener, a setback outcome is never offered.
- Only active person and arc threads are read. The event rule is unchanged from v4, as skeptic item 4 says.

DEVIATIONS FROM SPEC_V5
1. pickCallbacks takes an extra optional `tz`. The "{title}: {when}" day word of a pending beat needs her calendar. Without it the word falls back to UTC. **Integrator action:** context.ts (L7) does not pass it yet, so add `tz` to cbArgs at context.ts:458.
2. The "ageDays" of an upcoming beat callback is its story age since the beat was created. The spec leaves this value open, and 0 would have rendered "today: ...".
3. In runArcPass, the WITH HIM window opens at max(beat.created_at - 1 day, due_at - 14 days) and closes at due_at + 1 day. The spec says "since the beat was created"; that would miss the very message that named the step, because a promoted proposal creates the beat moments after it. When more than 30 messages match, the 30 nearest the step are kept, oldest first.
4. The "(agoLabel)" in a "Lately" line uses Portland's calendar days, so last night's step reads "yesterday", not "today". When held time lies between the step and now, it uses the story age instead. The memoryDays cutoff always uses story age.
5. HER in runArcPass lists facts that share a keyword with the step first. It then fills up to 8 plain facts and 4 opinions, so the model always sees who she is.
6. Opinions are recognised locally (subject starting "opinion:"). Importing isOpinionFact from prompt.ts would create a cycle, since prompt.ts imports arcs.ts.
7. Two small runArcPass choices. A failed paid call other than provider_failed stops the step without counting an attempt. If nothing was called, the step returns "skipped" with that reason, which is what the integration check "the paid steps skipped 'nightly budget'" expects.
8. createBeat answers 409 not_active only for a dropped want, as the spec says. resolveBeat on a done want skips the want_log row and still resolves the beat.

WHAT I COULD NOT DO
- The arc answer in src/providers/stub.ts belongs to lane L10. To test the filing path, I added a temporary arc answer to a stub in a scratch copy of src/, since deleted; nothing in the worktree was touched.
- The v5 unit suites (arcs_v5, wants_v5, consumers_v5) are also L10's and do not exist yet. I covered their listed cases in scratch tests outside the tree, in scratchpad/l2check/.

TESTS RUN
- `node --experimental-strip-types --test tests/unit/wants_v3.test.mjs tests/unit/callbacks_v2.test.mjs`: 23 pass, 0 fail.
- The same command per file on the other suites that reach my files: prompt_v2 19/19, prompt_v3 8/8, phone_v4 12/12, context 10/10.
- `node --experimental-strip-types --test scratchpad/l2check/l2.test.mjs scratchpad/l2check/db.test.mjs scratchpad/l2check/pass.test.mjs`: 19 pass, 0 fail. These cover every arcs_v5 and wants_v5 case the spec lists, plus the database half and runArcPass on a fake D1 with the stub provider.
- With the staged stub answer in the scratch copy, runArcPass filed one beat_outcome: "the open mic (2026-10-01): you went and it went badly. stub outcome". It carried the full payload and source "nightly arcs 2026-10-01 r_...", and the run moved to proposed with attempts 1.
- `node scripts/check_typography.mjs`: clean.
- `npx tsc --noEmit`: 0 errors across the whole tree at the end. Other lanes' modules were all present by then, so there were no missing-module errors to discount.

--- L3 Her read of him and memory hygiene ---
Lane L3 is finished: `src/views.ts` and `src/hygiene.ts` are new, and `src/said.ts` and `src/memory.ts` are changed. `npx tsc --noEmit` is clean on the whole tree, the typography scan is clean, and nothing was committed, deployed or started. One existing test now fails because of a change the spec asks for, and it needs an edit from L10.

**Test that needs an edit (L10 or the integrator):** `tests/unit/memory_v4.test.mjs` line 99 checks the exact list of keys on each memory-map fact. The spec adds `inferred` to that list, so the test fails. It is not one of the spec's "five named edits", so it is a sixth: add `"inferred"` between `"id"` and `"lastTouched"` in that array.

**Files written**
- `src/said.ts` (changed)
  - new: `numberWordsToDigits(text: string): string`
  - `saidKey` now folds number words to digits first, so "Justin is 44" and "Justin is forty-four" share a key.
  - `saidLine`, `dedupeSaid`, `listSaidRows` and `buildSaidHere` keep their signatures.
- `src/memory.ts` (changed)
  - `MemorySettings.ageDaysOf?: ((iso: string) => number) | null`
  - `ResolvedMemorySettings.ageDaysOf: ((iso: string) => number) | null`; `MEMORY_DEFAULTS` sets it to null and `memorySettings()` copies a function through.
  - `scoreDetail` reads the age through `ageDaysOf` when set, so the rankings and `memoryMap` follow with no new parameter. It does not import `src/clock.ts`.
  - `MemoryMapFact.inferred: boolean`, filled by `memoryMap`.
- `src/views.ts` (new). Exports:
  - `VIEWS_PREFIX`, `ViewOp`, `VIEW_CONFIDENCE_MIN`/`MAX`, `VIEW_EVIDENCE_MAX`, `VIEW_RETIRE_BELOW`, `HerViewRow`
  - `subjectNorm`, `confidenceWords`
  - `viewsSection(views, wrong, { limit, minConfidence })`, `viewsSystem(max)`, `viewsUser(views, messages)`
  - `parseViewOps(text, known, messageIds, max)`
  - `listViews(db, status = "active", limit = 50)`, `recentWrongViews(db, sinceIso, limit = 2)`
  - `applyViewProposal(db, payload, source, actor): Promise<string>`
  - `retireView(db, id, note, actor): Promise<HerViewRow>`
  - `runViewPass(env, db, settings, budget, now): Promise<StepResult>`
  - extras not in the spec: `VIEW_OPS`, `ViewOpParsed`
- `src/hygiene.ts` (new; it does not import `proposals.ts`). Exports:
  - `MERGE_PREFIX`, `INFERRED_PREFIX`, `DupGroup`
  - `hygieneScope`, `factKey`, `rawKey`
  - `exactDuplicateGroups(facts)`, `nearDuplicateGroups(facts, exclude, { max = 12 })`
  - `mergeGuard(merged, sources)`, `mergeSystem()`, `mergeUser(groups)`, `parseMergeAnswer(text, groups)`
  - `proposalUserMessageId(p)`, `inferredCandidates(facts, proposals, hisTexts)`
  - `inferredSystem()`, `inferredUser(cands)`, `parseInferredAnswer(text, ids)`
  - `applyFactMerge` and `applyFactMark` (both `(db, payload, source, actor): Promise<string>`)
  - `runHygienePass(env, db, settings, budget, now): Promise<StepResult>`
  - extra not in the spec: `InferredCandidate`
- The v5 settings are read through a loose settings type with the spec defaults, so the code works whether or not the new settings keys are in `Settings` yet.

**Where I departed from SPEC_V5, and why**
1. `viewsSection` returns "" when `limit` is 0, even if a read was proven wrong recently. `viewsShown` 0 means the section is never built.
2. `runViewPass`:
   - The window starts after the last views run marked done on a different day, so a forced rerun of the same day reads the same messages again.
   - It reads only his and her story messages that have already been delivered.
   - It answers "skipped" for `viewsPerNight` 0, or when the nightly budget or the caps stop the call. Any other call failure is "failed".
3. `parseViewOps`:
   - Square brackets around evidence ids are removed.
   - When a confirm, weaken or wrong op has no view or subject of its own, it takes the existing read's.
   - Every op, not only new ones, goes through the drop regex, and "answer" is not in it (skeptic 12).
4. `applyViewProposal` for "wrong": the note is `payload.note`, or else `payload.view`. An id that names no read gets 400 `validation`. A read that is no longer active gets 409 `not_active`, which is detected from the UPDATE changing nothing.
5. `retireView`: an older, superseded version gets 409 `not_current`; a read already retired is returned unchanged.
6. For near duplicates the spec gives no proposal text, so I used "same fact: {merged} (was: {a = b})", cut at 300 characters. Exact duplicates use the spec's text, with no day in it.
7. `inferredCandidates` takes the newest facts first, and `inferredUser` cuts each quote and message at 600 characters.
8. The hygiene step always reports "done"; a failed call is named in the reason and in `detail.problems`.
9. `mergeGuard` checks a number against whole numbers only, and splits "Justin's" into "Justin" before checking.
10. If `ageDaysOf` throws or returns something that is not a number, the real age is used.

**Test commands and counts**
- `npx tsc --noEmit`: 0 errors on the whole tree, including missing-module errors.
- `node scripts/check_typography.mjs`: clean.
- In the live tree, with `node --experimental-strip-types --test tests/unit/<name>.test.mjs`:

| Suite | Pass | Fail |
|---|---|---|
| saidhere_v32 | 3 | 0 |
| memory_v3 | 9 | 0 |
| memory_v4 | 4 | 1 (the `inferred` key above) |
| memory_collapse_v41 | 2 | 0 |
| proposals_v3 | 7 | 0 |
| context | 10 | 0 |
| proposals_v4 | 6 | 3 |

- The three proposals_v4 failures come from other lanes' intended changes (the relationship ladder, the scene time, the extractor text). On a clean copy of HEAD with only my files swapped in, proposals_v4 passes 9 of 9, so my `saidKey` change does not cause them.
- My own lane checks ran on a scratch copy of HEAD, with the live `clock.ts`, `storycall.ts`, `state.ts` and `standing.ts` copied in and the spec's stub triggers patched into that copy's stub provider:
  - `l3.test.mjs`: 10 of 10 pass. It covers the pure functions, `buildSaidHere`, `ageDaysOf`, the view and fact ops on a fake database, and the duplicate groups.
  - `l3pass.test.mjs`: 2 of 2 pass. It runs `runViewPass` and `runHygienePass` end to end on a scripted database.
  - Both are in `/private/tmp/claude-501/-Users-justinnewsome-Documents-ClaudeCode-HQ/e5dcbc67-4480-4c1c-bdb2-d7e749c0c830/scratchpad/l3test/`, outside the worktree, and L10 can borrow from them.

**Could not do:** the v5 test suites (`views_v5`, `hygiene_v5`, `said_v5`) are L10's and do not exist yet, so I could not run them. I ran no integration tests (no dev server, as instructed).

--- L4 State that moves and the proposal machinery ---
L4 is done: `src/standing.ts` (new), `src/state.ts` and `src/proposals.ts` are written and type-clean, and typography is clean. Nothing was committed, pushed or deployed, and no server or browser was started.

**Test status**
- `npx tsc --noEmit` shows no errors in my three files. An earlier run's only error in them was `Cannot find module './songs'`, and it is gone now that L6's `songs.ts` has landed.
- `node scripts/check_typography.mjs`: clean.
- The unit suites could not run in the worktree while `songs.ts` was missing, so I ran them in a scratch copy (`scratchpad/l4_shadow`, since removed) with a stub `songs.ts` in place:
  - `node --experimental-strip-types --test tests/unit/<name>.test.mjs` for these suites:

    | Suite | Result | Note |
    |---|---|---|
    | proposals | 11/11 | |
    | proposals_v3 | 7/7 | |
    | proposals_v4 | 6/9 | the 3 failures are below |
    | saidhere_v32 | 3/3 | |
    | memory_v3 | 9/9 | |
    | memory_v4 | 4/5 | the failure is L3's new `inferred` key on `MemoryMapFact` |
    | context | 10/10 | |

  - The three proposals_v4 failures are all planned changes. Two are the v4 expectations L10 is due to edit: the relationship status now comes out "talking", and the scene time is null after a status change. The third is the relationship payload line in `proposalSystemPrompt`, which belongs to L7.
  - A full `tests/unit/*.test.mjs` run gave 604 of 618 passing. The 14 failures are the ones above plus other lanes' work in progress: `src/nightly` missing (api.ts imports it), the `-p7` prompt version, and the `*/20` cron.
  - My own test of this lane's rules passes 15/15. It covers the ladder cases, nicknames, friction on story time, cooling off, `displayStatus`, scene normalisation, relationship validation, `putState` strict and via a proposal, the `mergeFacts` batch shape and refusals, `setFactInferred`, the duplicate exemption, the her-day log, the occurred stamp, and the relationship note. It is at `scratchpad/l4_adhoc.test.mjs`, outside the worktree, for L10 or the integrator to fold in.

**Exports**
- **`src/standing.ts`**: every export the spec names, with its exact signature. It imports only `storyElapsedMs`, `disabledClock` and the `StoryClock` type from clock.ts, `ApiHttpError`, and the `RelationshipState` type.
- **`src/state.ts`**:
  - `normalizeRelationshipFields` validates the six new relationship keys.
  - `putState` passes the relationship through a new private `stampFriction` and the scene through `normalizeSceneFields`.
  - Facts gain `inferred`: `createFact` and `updateFact` accept it, and the `inferred` column is written only when the value is 1, so a database without migration 0009 keeps working.
  - New exports:
    - `mergeFacts(db, { keepId, mergeIds, text, source }, actor): Promise<FactRow>`
    - `setFactInferred(db, id, inferred, source, actor): Promise<FactRow>`
- **`src/proposals.ts`**:
  - `PROPOSAL_KINDS` has the seven new kinds, and `NIGHTLY_ONLY_KINDS` is exported.
  - `mergeRelationshipState(cur, payload, text, now, opts = {})` now just calls `moveRelationship`.
  - `mergeSceneState` keeps v4's auto guard and ends in `normalizeSceneFields`.
  - The extractor drops the nightly-only kinds and passes today's date and weekday from the story clock to `proposalSystemPrompt`.
  - `keepAutomatically` never rejects a `beat_outcome` or `want_beat` as a text duplicate.
  - All promotions are wired as the spec's table says.
  - The local `relationshipMood` and `appendText` are removed; `appendText` now comes from standing.ts.

**Deviations from SPEC_V5, with reasons**
1. **`putState` for a scene written by a proposal.** It uses `normalizeSceneFields(..., { strict: false, timeSet: true })` instead of the strict form. `mergeSceneState` has already normalised the state and decided the time words from its payload. The strict pass would drop a time the payload deliberately repeated, and would throw on an old together record with no place. The owner's own PUT stays strict.
2. **`stepStatus` refuses moving from "over" to "cooling off" or "on a break"**, with the note "from over only talking or friends". The spec's rule text does not cover this case, but its test list says "from over only talking or friends".
3. **`stepStatus` leaves "over" unchanged** when the current status is already over, with no note.
4. **Leaving "over" gives the note "starting over"**, with " (proposed: ...)" added when the rung was clamped.
5. **`moveRelationship` drops the old `friction_days`** when a new, different friction arrives without its own `friction_days`, so a new sore spot heals on its own clock.
6. **Nickname lists are cut at 100 characters per nickname.**
7. **`normalizeSceneFields` and `present`:**
   - An explicit empty `present` list is accepted as "nobody".
   - A list made only of junk falls back to the current version's list.
8. **`normalizeSceneFields` cuts rather than refuses:** `location` over 300 characters and `time` over 100 are cut instead of answered with a 400.
9. **`stampFriction` treats a stamp the caller sent that equals the stored one as "not stamped"**, so the Now tab sending back the old stamp alongside a changed friction still gets a new stamp.
10. **`mergeFacts` scope rule for her facts:** when the fact being kept is one of hers (`avelie`), the merged facts must also be hers. The spec only states the rule for facts about him.
11. **`mergeFacts` puts `input.source` in the audit row only.** The new head's source is the "merged: ..." string, as the spec says.
12. **`known_artist` promotion:** a payload with no artist answers 400, and any kind other than "disliked" is read as "known".

**What I could not do**
- None of the edits to the v4 test expectations, or any new `*_v5` test files: those belong to L10.

**Exact test commands**
- `npx tsc --noEmit`
- `node scripts/check_typography.mjs`
- `node --experimental-strip-types --test tests/unit/<name>.test.mjs` for proposals, proposals_v3, proposals_v4, saidhere_v32, memory_v3, memory_v4, context and l4_adhoc
- `node --experimental-strip-types --test "tests/unit/*.test.mjs"`

All `node` test runs were in the scratch copy.

Files:
- /private/tmp/claude-501/-Users-justinnewsome-Documents-ClaudeCode-HQ/e5dcbc67-4480-4c1c-bdb2-d7e749c0c830/scratchpad/avelie_v5/src/standing.ts
- /private/tmp/claude-501/-Users-justinnewsome-Documents-ClaudeCode-HQ/e5dcbc67-4480-4c1c-bdb2-d7e749c0c830/scratchpad/avelie_v5/src/state.ts
- /private/tmp/claude-501/-Users-justinnewsome-Documents-ClaudeCode-HQ/e5dcbc67-4480-4c1c-bdb2-d7e749c0c830/scratchpad/avelie_v5/src/proposals.ts
- /private/tmp/claude-501/-Users-justinnewsome-Documents-ClaudeCode-HQ/e5dcbc67-4480-4c1c-bdb2-d7e749c0c830/scratchpad/l4_adhoc.test.mjs

--- L5 Reply rhythm and the checks ---
Lane L5 is done. `src/checks.ts` and `src/imperfection.ts` are updated, `npx tsc --noEmit` shows no errors in either file, and every existing suite that loads them passes. The four suites that fail do so only because `src/clock.ts` from lane L1 does not exist yet.

**Files written** (only these two; nothing committed or pushed):
- `/private/tmp/claude-501/-Users-justinnewsome-Documents-ClaudeCode-HQ/e5dcbc67-4480-4c1c-bdb2-d7e749c0c830/scratchpad/avelie_v5/src/checks.ts`
- `/private/tmp/claude-501/-Users-justinnewsome-Documents-ClaudeCode-HQ/e5dcbc67-4480-4c1c-bdb2-d7e749c0c830/scratchpad/avelie_v5/src/imperfection.ts`

**src/checks.ts** (still pure; imports only types from `./types`: CheckContext, CheckResult, Flag, FlagSeverity, RhythmAction, RhythmSize, SentKind)
- `export const ACTION_LINE_RE = /^\s*\*[^*\n]+\*[\s.,!?]*$/`
- `export function stripActionLines(text: string): string`
- `export const RHYTHM_SIZES: readonly RhythmSize[]` = one_word, one_line, two_lines, three_lines, longer
- `export interface ObservedRhythm { size: RhythmSize; action: RhythmAction; bookended: boolean; bubbles: number }`
- `export function observedRhythm(text: string): ObservedRhythm`, using the spec's thresholds exactly.
- `export function signature(text: string): string` now reads the text with action-only lines removed. If only actions remain it answers "0|short|lower|s". A text with no action-only line is read byte for byte as before, so the eight v3 fixtures are unchanged.
- `export const DENIAL_RE` (the spec regex, verbatim).
- `DEPENDENCY_PHRASES` gains "you never answered", "left me on read", "you never texted back" and "you never wrote back". The bare "never answered" is not added.
- `runChecks` now calls a private `runV5Checks` after the v3 checks:
  - **denied_send** (retry). It uses the tense rule, the kind regexes, and "anything"/"something" only when the verb is a form of play or show. An item's words are matched as whole words or phrases. "today", "tonight" and "this morning/afternoon/evening" narrow the count to today's sends, and "yet" does not narrow. It raises at most one flag ("denies a recorded {kind}") and never fires when nothing is recorded.
  - **name_drift** (retry), detail "calls her {relation} {captured}, who is {name}". A person with no name yet never triggers it.
  - **rhythm_missed** (flag only), detail "asked {size}, wrote {observed size}".
- Existing exports are unchanged: `findPhrase`, `TECH_LEAK_TERMS`, `normalizeForMatch`, `splitSentences`, `lengthBand`, `bubbleBand`, `repairText`, `runChecks`, `CheckContextV3` and the phrase tables.

**src/imperfection.ts** (imports `seededUnit` from `./life`, its own `./checks`, and types from `./types`)
- Re-exports `observedRhythm`, `signature` and `stripActionLines`.
- Constants as specified:
  - `RHYTHM_SIZE_WEIGHTS`
  - `RHYTHM_ACTION_WEIGHTS`
  - `RHYTHM_EXTRA_WEIGHTS = { lowercase: 0.12, voice: 0.04 } as const`
  - `RHYTHM_REPEAT_FACTOR = 0.4`
  - `RHYTHM_SUBSTANTIVE_CHARS = 200`
- `export function hisTextIsSubstantive(text: string | null | undefined): boolean`
- `export interface RhythmOptions { enabled; together; opener; intimate; voiceAllowed; typoShare: number; substantive }` (all boolean except `typoShare`).
- `export function rhythmTable(recentTexts: string[], opts: RhythmOptions): RhythmTable`
  - `RhythmTable` is `{ sizes: {size,p}[]; actions: {action,p}[]; extras: {extra,p}[] }`.
  - It applies rules 1 to 8 in order, including 6b and the fall-back to base weights when a table sums to zero.
- `export function rhythmCue(seed: string, recentTexts: string[], opts: RhythmOptions): Rhythm | null`
  - It rolls `rollUnit(seed+"|size")`, `rollUnit(seed+"|action")` (together only) and `rollUnit(seed+"|extra")`.
- `export function rhythmSection(r: Rhythm | null): string` uses the exact header and lines. The extra line is taken from v3's `CUE_LINES`.
- `export function rhythmAsShapeCue(r: Rhythm | null): ShapeCue | null`
- Also exported, beyond the spec: `RhythmTable` (the type), `RHYTHM_SIZE_LINES`, `RHYTHM_ACTION_LINES` and `RHYTHM_HEADER`.
- v3's `shapeCue`, `cueTable`, `cueSection`, `CUE_LINES`, `rollUnit` and `cuesForSignature` are unchanged.

**Deviations from SPEC_V5**, each narrower or more careful than the spec:
1. **"yesterday" narrowing in denied_send.** A sentence that names "yesterday" counts only items whose `today` is false. The spec defines narrowing for today only; this stops "i didn't send you a song yesterday" firing on a song sent today.
2. **Capitalised "My"/"Our" and relation words in name_drift.** The regex also accepts a capital first letter on "my", "our" and the relation word (so "My mom Linda" at a sentence start is caught). The name itself is still case-sensitive `[A-Z][a-z]{2,20}`.
3. **Name matching in name_drift.** The captured word counts as a known name if it equals a person's full name or any single word of it, so "Diane" does not fire against "Diane Smith". There is also a small list of capitalised non-names ("She", "Said", "Literally" and similar) that never count as names.
4. **Relation normalising in name_drift.** Each person's `relation` is normalised again inside the check (lowercase, a leading "her"/"my" removed, mom to mother and so on), in case lane L7 passes it raw.
5. **rhythm_missed detail when only the action misses.** If the size is close enough but an action appeared where the cue asked for none, the detail adds " (an action where none was asked)".
6. **Opener extras.** On an opener the typo and voice extras are zero, since the spec says lowercase is the only extra there.

**Could not do / left to others:** I wrote no test files; the `rhythm_v5` and `checks_v5` suites are lane L10's. Lane L7 had already written the v5 types in `src/types.ts`, so I imported them directly.

**Test commands run:**
- `npx tsc --noEmit`: 23 errors, none in my files. All are other lanes' in-progress work: missing modules (`clock`, `nightly`, `arcs`, `views`, `world`, `honest`, `songs`, `standing`) and argument or property mismatches in `api.ts`, `context.ts`, `prompt.ts` and `views.ts`.
- `node --experimental-strip-types --test tests/unit/<name>.test.mjs`:

| Suite | Result |
|---|---|
| checks | 48/48 pass |
| checks_v3 | 15/15 pass |
| imperfection_v3 | 5/5 pass (the eight signature fixtures unchanged) |
| voicebank_v3 | 11/11 pass |
| corrections_v3 | 4/4 pass |
| bubbles_v4 | 3/3 pass |
| herfirst_v2, calls_v3, prompt_v3, prompt_v4, context | 1/1 fail each: `src/prompt.ts` imports `src/clock.ts`, which lane L1 has not written yet |

- `node scripts/check_typography.mjs`: clean.
- `npm run build:voicebank`: 150 lines validated. The new phrases catch nothing in the seed, and `0005b` is unchanged.
- A throwaway script covering the spec's L5 test cases ran 62/62 assertions: every `denied_send` and `name_drift` positive and negative, `rhythm_missed`, "you left me on read", "you never answered" and "the landlord never answered", and the rhythm tables. Over 4,000 seeds with no history, one_line came out 0.341, longer 0.133, typo_fix 0 at share 0, and typo_fix 0.0525 at share 0.05. The script is `/private/tmp/claude-501/-Users-justinnewsome-Documents-ClaudeCode-HQ/e5dcbc67-4480-4c1c-bdb2-d7e749c0c830/scratchpad/l5_check.mjs`, outside the worktree.

--- L6 The record and the world ---
Lane L6 is done: `src/honest.ts`, `src/songs.ts` and `src/world.ts` are new, and `src/life.ts` is extended. Nothing was committed or deployed, and no server or browser was started. `npx tsc --noEmit` is fully clean, the typography check is clean, and the existing suites touching my files pass.

**Files written**
- `src/life.ts` (edited)
- `src/world.ts` (new)
- `src/honest.ts` (new)
- `src/songs.ts` (new)

**Exports and signatures**

`src/life.ts`
- `PLACEHOLDER_NAMES: readonly string[]` (the spec list) and `isPlaceholderName(name: unknown): boolean`.
- `updateThread(db, id, patch, actor, opts: { allowRename?: boolean } = {})`:
  - It throws `ApiHttpError(409, "name_locked", "a person's name never changes; use Rename on the State page")` when a person thread's real (not placeholder) title would change without `allowRename`.
  - A placeholder may be named once. A change of case only is not a rename. Places are not affected.
- `lifeSection(threads, log, now, tz, opts: LifeSectionOptions = {})`:
  - `together` drops the "You are ... until ..." and "Nothing on your schedule right now." halves.
  - `clockWords` makes the line "It is {weekday}, {clockWords}.".
  - `deferAt` moves the Next up event; if it throws or answers something unreadable, the stored instant is used.
  - It still reads active threads only, so Mason's done thread never appears.
- New type exports: `LifeSectionOptions` and `LocalParts`.
- life.ts does not import clock.ts. `localParts`, `safeTimezone`, `listThreads`, `listLog`, `WEEKDAYS`, `formatClock`, `agoLabel`, `seededUnit`, `createThread` and `logLife` are still exported.

`src/world.ts`
- Types: `PersonRow`, `WorldFactRow`. Constants: `UNIQUE_RELATIONS`, `WHO_AND_WHERE_HEADER`.
- Pure: `relationNorm(r: unknown): string | null`, `nameNorm(s: string): string`.
- `syncPeople(db, threads): Promise<PersonRow[]>`: handles the four spec cases, and a read with nothing new writes nothing.
- `listPeople(db)`; `listWorldFacts(db, opts = {})`.
- `addWorldFact(db, input, actor)`, `retireWorldFact(db, id, actor)`, `addWorldFactFromProposal(db, payload, text, source, actor): Promise<string>`.
- `resolveLifePerson(db, input, actor): Promise<LifeThread>`, `renamePerson(db, personId, name, actor): Promise<PersonRow>`.
- `mentionedEntities(args)`: role-aware ("my mom" counts in her lines; in his only as "your mom").
- `whoAndWhereSection(args)`, `worldView(db)`.

`src/honest.ts`
- `SENT_KIND_WORDS`, `SENT_HEADER`, `SentItem`.
- `sentWords(text): string[]`, `listSent(db, { now, windowDays, limit }): Promise<SentItem[]>`.
- `sentSection(items, storyNow, tz, clock = null)` and `sentForCheck(items, storyNow, tz, clock = null)`: both use the story instant (skeptic 10).
- Imports `storyInstantOf` and `localDayKeyOf` from clock.ts and `SentKind` from types.ts.

`src/songs.ts`
- Types: `KnownKind`, `KnownSource`, `KnownArtistRow`. Constant: `SONGS_HEADER`.
- `artistNorm(a): string`, `isListedArtist(song, listed): boolean`.
- `setKnownArtist(db, input, actor)`: upsert on `artist_norm`, audited `artist.set`.
- `songFeedback(db, messageId, kind, actor)`: 404 for an unknown message, 400 "no song on this message".
- `listKnownArtists(db, kind?, limit = 200)`, `removeKnownArtist(db, id, actor)` (audited `artist.remove`).
- `missingSongNotice(db, now)`, `songToldStmt(db, messageId, at)`, `songsSection(args)`.

**Deviations from SPEC_V5, with reasons**
1. **`resolveLifePerson`**:
   - When she names a placeholder (e.g. "Diane" for "her mother"), the proposal's `detail` is carried over only if the existing thread has none, so nothing she said is lost.
   - A placeholder title offered for a unique relation that is already held returns the existing person instead of renaming one placeholder to another.
   - After a create or rename it re-syncs `people`, and a failure there is ignored.
2. **`syncPeople`**:
   - If a thread was edited more than once between two reads, it walks the version chain once, so no orphan person row is created.
   - If the new name already belongs to another row, the moved row keeps its old name instead of breaking the batch on the unique name.
   - Case 3 (a match by name) also refreshes the relation.
3. **World facts**:
   - `addWorldFact`: when `saidKey` of the fact is empty, `fact_norm` falls back to the lowercased fact; a race on the unique index answers 409 `duplicate`.
   - `retireWorldFact`: retiring an already retired fact returns it unchanged; the audit action is `world.fact.retire`.
   - `listWorldFacts`: defaults to status `approved`, at most 2,000 rows.
4. **`renamePerson`**: answers 409 `duplicate` when another person already has the name, and 409 `no_thread` when the row has no thread.
5. **`whoAndWhereSection`**:
   - At most 4 facts per line, to keep the section small.
   - The portrait is looked up by the thread id and also by the thread's `portrait_asset_id`.
   - Text is not capitalised.
6. **`mentionedEntities`**:
   - Only named people match by name; placeholders match through relation words.
   - It assumes the texts are oldest first with his pending text last, and entities that are only in her day rank after text mentions.
7. **`songsSection`**: when both lists are long, each gets up to half the limit (rounded up) and any leftover goes to the longer list.
8. **`sentSection`**: an item stamped later than `storyNow` on the same day reads "today" with no clock time. Double quotes inside a voice label become single quotes. A library item with no title is skipped. Only asset roles candidate and scene count as photos.
9. **Small safety additions**: `missingSongNotice` also filters on `deliver_at` and answers null when the read fails. `listSent` clamps `limit` to 0..200 and `windowDays` to 1..60.

**Notes for L7 and L8**
- Pass all threads (not only active ones) as `PromptWorld.threads` and to `syncPeople`. Otherwise Mason's done thread and its detail are missing from WHO AND WHERE.
- `PersonRow.named` is a number (0 or 1), as the column is stored.

**Could not do**: nothing in scope was skipped. The v5 unit suites belong to L10; I did not write into `tests/`.

**Test commands run**
- `npx tsc --noEmit`: 0 errors. My files never had errors; the only earlier errors were other lanes' missing `./nightly` and related type errors, now gone.
- `node scripts/check_typography.mjs`: clean.
- `node --experimental-strip-types --test --test-reporter=tap tests/unit/<name>.test.mjs`:

| Suite | Result |
|---|---|
| life_v2 | 21/21 |
| places_v4 | 15/15 |
| spotify_v4 | 15/15 |
| phone_v4 | 12/12 |
| proposals | 11/11 |
| proposals_v3 | 7/7 |
| proposals_v4 | 6/9 |

- The 3 proposals_v4 failures are the v5 behaviour changes the spec lists for L10 to edit (the relationship ladder "talking", the scene time reset, and the proposal prompt text). They come from L4 and L7 files, not mine.
- I also ran my own check against a real SQLite database with every migration applied plus the 0009 SQL from the spec: 6/6 tests covering everything above, including the canon mother and Mason seeds. It lives outside the repo, in the scratchpad under `l6check/` (`check.test.mjs`, `d1.mjs`, `0009_spec.sql`).

Files are in /private/tmp/claude-501/-Users-justinnewsome-Documents-ClaudeCode-HQ/e5dcbc67-4480-4c1c-bdb2-d7e749c0c830/scratchpad/avelie_v5:
- src/life.ts
- src/world.ts
- src/honest.ts
- src/songs.ts

--- L7 The turn: types, settings, context, prompt, chat ---
LANE L7 REPORT (the turn: types, settings, context, prompt, chat)

Worktree: /private/tmp/claude-501/-Users-justinnewsome-Documents-ClaudeCode-HQ/e5dcbc67-4480-4c1c-bdb2-d7e749c0c830/scratchpad/avelie_v5 (branch v5). Nothing committed or pushed, nothing deployed, no dev server or browser started.

Result: `npx tsc --noEmit` is clean for the whole tree, and all the landed lanes are included in that check. `node scripts/check_typography.mjs` is clean. The 10 failing unit tests are all expected: seven assert v4 text or behaviour that v5 changes on purpose, and three belong to other lanes (details below).

FILES WRITTEN
- src/types.ts: the section "Types" additions, word for word:
  - the type-only imports from ./clock, ./arcs, ./views, ./world, ./places and ./honest
  - RhythmSize, RhythmAction, RhythmExtra, Rhythm, SentKind, TimeSince (no role), PromptWorld, PromptSongs
  - the twenty Settings keys after videoMarkerEnabled
  - ModelRunRow.kind gains "nightly"; FactRow gains inferred?; MessageRow gains song_told_at?
  - RelationshipState gains friction_set_at?, friction_days?, cooling_off_set_at?, cooling_off_hours?, status_before?
  - ProposalKind gains the seven new kinds
  - CheckContext gains sent?, people?, rhythm?, knownArtists?
  - PromptState gains the 18 optional v5 fields
  - AssembledContext gains `clock: StoryClock; storyNow: string`
  - Env is unchanged.
- src/db.ts: DEFAULT_SETTINGS gains the twenty defaults (true, 120, true, "anthropic", "claude-sonnet-5", "claude-haiku-4-5", 0.25, 2, 3, 7, 7, 6, 0.4, 3, 4, 12, 7, true, 6, 40).
- canon/seed/settings.json: the same twenty keys, appended as text. Checked against the rest of the tree:
  - they match 0009_v5.sql's INSERT OR IGNORE rows
  - `node scripts/build_seed.mjs` leaves migrations/0002_seed.sql byte-identical.
- src/prompt.ts:
  - `PROMPT_VERSION = ${CONSTITUTION_VERSION}-p8`.
  - stablePrefix(), compactPrefix() and SYSTEM_SEPARATOR are unchanged; the prefix-hash test passes.
  - stateSections(s) renders the 24 slots in spec order. Every new renderer runs inside `guarded`.
  - HOW YOU READ HIM is omitted when `s.opener === true`.
  - Guesses sub-list: "Your guesses about him (he never said these; hold them loosely, never tell him one as a fact):" for facts with inferred === 1. The "nothing yet" wording reads the non-inferred list and saidHere.
  - The Relationship line hides the v3 keys plus RELATIONSHIP_V5_HIDDEN_KEYS and shows the status through displayStatus. It is followed by the Mood line, the friction line, and cooling off through coolingOffNow.
  - RIGHT NOW passes clockWords; TIME SINCE, the lifeSection options (together, clockWords, deferAt via deferredInstant), WHO AND WHERE, beats through beatLinesByWant into wantsSection opts, sentSection and songsSection are all wired.
  - THIS MESSAGE is rhythmSection(s.rhythm), falling back to cueSection(s.shapeCue).
- src/context.ts:
  - LoadOptions gains clock?, lastExchange?, realNow?, and mentionTexts? (a deviation, see below).
  - loadPromptState adds every read the spec lists, each through `nicety`.
  - syncPeople→listPeople and syncPlaces→listPlaces run in a second Promise.all, because they need the threads the first one reads.
  - Memory ranking uses `{ ...settings, ageDaysOf: iso => storyAgeDays(clock, iso) }`. Cooling uses coolingOffNow; the mood phase uses moodPhase(..., clock). pickCallbacks gets beats and clock. buildSaidHere gets every approved justin/shared and avelie fact.
  - The rhythm cue uses `substantive`; shapeCue is now rhythmAsShapeCue(rhythm).
  - When the clock is frozen, grounding comes from heldGrounding and clockWords from clockWordsFor.
  - Also computed here: timeSince; mentionedEntities with dayThreadIds/dayPlaceTitles; portraits looked up by personThreadId and by thread.portrait_asset_id.
  - assembleContext and assembleSystemOnly load the clock first (a failure falls back to disabledClock), gate the weather with the new `weatherAllowed(clock, realNow)` (the skeptic 11 window), add lastExchange to the Promise.all, and pass `now: storyNow`. The context returned by assembleContext now carries clock and storyNow.
- src/chat.ts:
  - RETRY_RULES gains denied_send and name_drift (the spec's wording).
  - The check context gains sent (sentForCheck on the story clock), people (named ones only, with relationNorm), rhythm {size, action} and knownArtists (artistNorm).
  - evaluate pushes the `song_known_artist` flag.
  - The provenance mood phase takes the clock. Provenance gains clock, timeSince, rhythm, viewIds, beatRunIds, world, sentIds, songs and inferredFactIds, and keeps shapeCue.
  - Her real-mode delay applies only when `assembled.state.mode === "apart"`.
  - The commit batch gains songToldStmt when the missing-song notice rode, and holdWeatherStmt when the held span had no weather and this turn fetched some.
- src/provenance.ts: unchanged.

EXPORTS (new or changed)
- prompt.ts:
  - `proposalSystemPrompt(opts: { today?: string | null; weekday?: string | null } = {}): string`. It carries the four new kinds, the new relationship line, the five new lines, and "Today, in her timezone, is {weekday} {today}." when today is set.
  - `moodPhase(rel, now, moodDaysDefault?, fallbackSetAt?, clock: StoryClock | null = null)`
  - `moodLine(rel, now, moodDaysDefault?, fallbackSetAt?, clock = null)`
  - `relationshipLine(rel, now = new Date(), clock = null)`
  - new `isInferredFact(f: FactRow): boolean`
  - `coolingOff(until, now)` is kept.
- context.ts: new `weatherAllowed(clock: StoryClock, realNow: Date): boolean`.

DEVIATIONS
1. `LoadOptions.mentionTexts?: Array<{ hers: boolean; text: string }>` is an addition the spec does not list. mentionedEntities needs to know who wrote each message, and loadPromptState only received plain strings. If it is missing, the recent texts are read as his.
2. Held grounding and clockWords are computed inside loadPromptState, from the clock passed in. The spec places this in assembleContext, but the assets and today's rows are loaded in loadPromptState. The result is the same.
3. With knownArtistsShown at 0, the missing-song notice is not read either. I followed "0 = no section" literally.
4. With viewsShown at 0, her reads are not loaded into the state.
5. beatRunIds in the provenance are the runs whose `beatLines` line appears in `beatLinesByWant`'s output for a want in s.wants.

TESTS THAT FAIL (expected, not caused by a defect in my files)
- Listed in the spec as L10 edits:
  - prompt_v4.test.mjs:28 (-p7)
  - proposals_v4.test.mjs:22 and :84 (L4's merge behaviour)
- NOT listed in the spec's "L10 edits exactly these lines" (spec drift; L10 or the integrator must edit these):
  - inbed_v33.test.mjs:20 and hisface_v31.test.mjs:214 assert -p7.
  - prompt_v4.test.mjs:69 (line 78) asserts `"nicknames": a nickname that stuck or omitted`.
  - proposals_v4.test.mjs:156 (line 157) asserts `"status": one to four plain words for where they stand now`.
  - Both of those texts change because the spec rewrites the relationship line word for word.
- Other lanes' work in progress, not mine: entry_v4:80 (the */20 cron, L1/L8), memory_v4:84 (memoryMap, L3), migrations_v4:87 (ordering after 0009, L10).

COMMANDS RUN, WITH COUNTS
- `node --experimental-strip-types --test tests/unit/<f>.test.mjs`:

| Suite | Pass | Fail |
|---|---|---|
| prompt | 15 | 0 |
| prompt_v2 | 19 | 0 |
| prompt_v3 | 8 | 0 |
| prompt_v4 | 3 | 2 |
| context | 10 | 0 |
| provenance_v2 | 5 | 0 |
| settings | 8 | 0 |
| settings_v2 | 10 | 0 |
| settings_v3 | 10 | 0 |
| settings_v4 | 7 | 0 |
| saidhere_v32 | 3 | 0 |
| inbed_v33 | 7 | 1 |
| hisface_v31 | 22 | 1 |
| scenarios_v2 | 5 | 0 |
| scenarios_v3 | 3 | 0 |
| tastings_v3 | 5 | 0 |
| proposals | 11 | 0 |
| proposals_v3 | 7 | 0 |
| proposals_v4 | 6 | 3 |
| memory_v3 | 9 | 0 |
| imperfection_v3 | 5 | 0 |
| calls_v3 | 9 | 0 |
| drift_backup_v2 | 4 | 0 |
| wants_v3 | 10 | 0 |
| grounding_v3 | 8 | 0 |
| callbacks_v2 | 13 | 0 |
| voicebank_v3 | 11 | 0 |
| finetune_v3 | 9 | 0 |
| export_character_v2 | 6 | 0 |

- `node --experimental-strip-types --test "tests/unit/*.test.mjs"`: 670 tests, 660 pass, 10 fail (the ten listed above).
- `npx tsc --noEmit`: 0 errors.
- `node scripts/check_typography.mjs`: clean.
- `node scripts/build_seed.mjs`: 0002 unchanged.
- An ad-hoc fake-D1 smoke of assembleContext (deleted afterwards):
  - Held together scene: storyNow equals frozen_at, no TIME SINCE, the together rhythm, no writes.
  - Apart: TIME SINCE reads "You last talked 3 days ago." plus the new-day line.
- A full-fixture render of stateSections confirmed the v5 order and wording.

NOT DONE
- npm test and npm run test:integration: other lanes are still mid-flight, and the integrator runs these.

--- L8 The router and the entry ---
LANE L8 REPORT (the router and the entry). Nothing committed or pushed, no deploy, no remote command, no dev server, no browser.

Worktree: /private/tmp/claude-501/-Users-justinnewsome-Documents-ClaudeCode-HQ/e5dcbc67-4480-4c1c-bdb2-d7e749c0c830/scratchpad/avelie_v5

**Result:** all seven owned files are done. `npx tsc --noEmit` is clean on the whole tree once L1's deliveries.ts landed, typography is clean, and every unit suite that touches my files passes except one entry_v4 assertion that the spec's own wording breaks (item 1 under "Deviations").

**Files written (only the seven L8 files):** src/api.ts, src/index.ts, src/exportImport.ts, src/exportCharacter.ts, src/operator.ts, src/timeline.ts, src/finetune.ts

**src/api.ts**
- **Routes added,** all behind the existing auth gate and the cross-site gate in index.ts; `matchRoute` sees no collisions:
  - GET /api/clock
  - POST /api/nightly/run: 400 on an unknown step, checked against `NIGHTLY_STEPS`. Steps run in the fixed order and the request stays open until the pass ends.
  - GET /api/nightly: limit 1..200, default 28.
  - GET /api/beats: status active, cancelled or all; limit 1..500, default 200.
  - GET /api/wants/:id/beats: 404 for an unknown want. It also accepts `?status`, default active.
  - POST /api/wants/:id/beats: 201; source is "owner"; tz is `settings.timezone`.
  - PUT /api/beats/:id: 400 when there is nothing to change.
  - POST /api/beats/:id/resolve: outcome checked against `STEP_OUTCOMES` and `EVENT_OUTCOMES` combined; `resolveBeat` refuses a kind mismatch with 400 and a second resolve with 409. `hisPart` is checked against `HIS_PARTS`; source is "owner".
  - GET /api/views and POST /api/views/:id/retire
  - GET /api/world, POST /api/world/facts (201, source "owner"), DELETE /api/world/facts/:id
  - POST /api/people/:id/rename: 400 unless the body has `confirm: "rename"`.
  - GET /api/sent: uses the `sentWindowDays` and `sentShown` settings, falling back to 7 and 12.
  - POST /api/messages/:id/song-feedback
  - GET, POST (201, source "owner") and DELETE /api/known-artists
- **Routes changed:**
  - PUT /api/state/scene: after `putState` it calls `loadStoryClock(db, settings, new Date())` and answers `{ ...r, place, clock: clockView(clock) }`.
  - GET /api/memory/map: one `loadStoryClock`, then `memoryMap(db, { ...settings, ageDaysOf: (iso) => storyAgeDays(clock, iso) }, now)`, plus `views: listViews(db, "all", 100)` and `knownArtists: { known, disliked }`.
  - Proposals: the local v1 `PROPOSAL_KINDS` is removed and replaced by the import from proposals.ts (skeptic 19).
  - These need no router change and get their behaviour from other lanes: relationship PUT and life-thread PUT (`name_locked`) pass through `putState` and `updateThread`; `song_told_at` rides in the `SELECT *` message rows; context comes from provenance.ts; GET /api/system is served by operator.ts.
- **Settings:**
  - `V5_EXTRA_KEYS` holds the twenty keys, each validated to the range in the spec's Settings table.
  - `assertSettingsConsistent` requires `nightlyModel` to be priced while `nightlyStoryEnabled` is on, and `hygieneModel` while `hygieneEnabled` is on. It fires when the model, `prices` or the on-switch is touched; a missing key reads as on and as the default model.
  - `overlaySettings` also sets `nightlyProvider`.

**src/index.ts**
- **07:00 cron:** backup, then maintenance, then `runNightlyStory(env, db, settings, { now: at })`, each in its own try. A failed backup is logged and audited as `cron.failed` with `step: "backup"`, and the other two still run. The result gains `nightly`: day, skipped, frozen, spentUsd, each step's status/reason/filed count, kept, duplicates.
- The scheduled log line is now cut at 2000 characters instead of 300, so the nightly part is visible.
- **Every-20-minutes cron:** one `loadStoryClock` at the top, then `pushDueReplies(env, db, at, { quiet, frozen: clock.frozen })`.
- No new trigger; the CSP is untouched.

**src/exportImport.ts**
- `EXTRA_TABLES` gains the eight v5 tables, each with a `TableSpec` in `V3_TABLES`: storyClock, nightlyRuns, arcBeats, beatRuns, herViews, people, worldFacts, knownArtists.
- `facts.inferred` (int, default 0) and `messages.song_told_at` (text, `TIME_MAX`) are added to the whitelists.
- `TableSpec` gains two optional fields:
  - `keyCols`: nightly_runs is keyed on (day, step).
  - `unique`: the schema's UNIQUE sets are checked before the batch, so a bad payload gets a 400 instead of a failed batch. They are opened_version; (beat_id, reader); thread_id; name_norm; artist_norm; and (entity_kind, entity_id, fact_norm) among approved rows.
- A `her_views` confidence outside 0..1 is refused.
- `frozen_at` and `due_at` are required text and are never stamped with the import time.
- **Skeptic 3:** when the payload replaces the scene versions and has no `storyClock` key (or a null one), the batch carries `DELETE FROM story_clock` and `counts.storyClockCleared = 1`. A payload that carries `storyClock` replaces the table the normal way.

**src/exportCharacter.ts**
- `CharacterPackage` gains `arcBeats: CharacterBeat[]` (active beats with variants and the owner run's status, outcome, note and resolvedAt; nothing of his) and `world: { people: CharacterPerson[]; places: CharacterPlace[] }` (places listed only when they have fixed facts).
- The markdown gains "Her dated steps" and "Her people and places".
- It never reads her_views, known_artists or nightly_runs.

**src/operator.ts:** `systemInfo` counts gain, in their own batch, `clockFrozen` (0 or 1; 0 when `storyClockEnabled` is false), `clockSpans`, `beatsPending`, `beatsResolved`, `viewsActive`, `factsInferred`, `peopleNamed`, `worldFacts`, `knownArtists` and `lastNightlyDay` (string or null). A database behind 0009 answers zeros and null.

**src/timeline.ts:** `TimelineType` gains `"beat"`: a resolved owner run placed at `due_at`, titled with the beat title, text `outcomeWords(outcome)` plus her note, link `/state#wants`.

**src/finetune.ts:** `STRIP_SECTIONS` gains HOW YOU READ HIM, SONGS AND HIM and TIME SINCE. `stripHimFromState` drops `Friction: ` lines inside CURRENT STATE and applies `line.replace(HIS_PART_RE, "")` to every `"  Lately: "` line inside WHAT YOU WANT (skeptic 21).

**Deviations and things the integrator should know**
1. **entry_v4 needs a one-line test edit that the spec's list of v3/v4 test edits misses.** The assertion regex `/pushDueReplies\(env, db, at, \{ quiet \}\)\.catch\(/` at tests/unit/entry_v4.test.mjs:82 cannot match the spec's required `{ quiet, frozen: clock.frozen }`. That regex should become `\{ quiet, frozen: clock\.frozen \}`. It is L10's file, so I did not touch it.
2. GET /api/wants/:id/beats also takes `?status` (default active), for consistency with GET /api/beats.
3. `getBeatView` is not imported, because no route needs it.
4. The timeline uses `outcomeWords` from arcs.ts as the spec says. Those words are second person ("you went..."), which reads oddly on his timeline; say if you want a third-person map there.

**Could not do:** the integration suite and the UI smoke (no dev server, as instructed).

**Tests run** (each as `node --experimental-strip-types --test tests/unit/<name>.test.mjs`):

| Suite | Pass |
|---|---|
| entry_v3 | 6/6 |
| entry_v4 | 6/7 (the regex in item 1) |
| exportImport | 6/6 |
| exportImport_v4 | 6/6 |
| export_character_v2 | 6/6 |
| export_messages_v41 | 1/1 |
| timeline_v2 | 6/6 |
| finetune_v3 | 9/9 |
| settings | 8/8 |
| settings_v2 | 10/10 |
| settings_v3 | 10/10 |
| settings_v4 | 7/7 |
| snapshots_v32 | 2/2 |
| images_v4 | 9/9 |
| nav_v4 | 6/6 |

- `npx tsc --noEmit`: clean.
- `npm run check:typography`: clean.
- Two throwaway scratchpad tests, since deleted, passed 2/2 and 1/1: the story_clock delete, replace and keep rules, the new uniqueness refusals, the confidence check, the strip transform, and all twenty settings validators with the two price rules and the `nightlyProvider` overlay.
- Failures in other lanes' files, for reference: memory_v4 1 failure (L3's new `inferred` field on memory-map facts); proposals_v4 3 and prompt_v4 2 failures, which match the expectations the spec already lists for L10 to change.

--- L9 The interface ---
LANE L9 (the interface): report

All work is in /private/tmp/claude-501/-Users-justinnewsome-Documents-ClaudeCode-HQ/e5dcbc67-4480-4c1c-bdb2-d7e749c0c830/scratchpad/avelie_v5 on branch v5. Nothing was committed or pushed. No dev server or browser was started, and nothing was deployed.

FILES WRITTEN (all nine are in my lane)
- public/js/chat.js
- public/index.html
- public/js/state.js
- public/state.html
- public/js/memory.js
- public/memory.html
- public/js/model.js
- public/model.html
- public/css/app.css

WHAT EACH FILE NOW DOES
- **public/index.html**
  - `#clockChip`: a hidden `span.chip.accent` with `role="status"`, in the scene bar's `.bar-tools`.
  - `#placeNeeded`: a hidden amber chip reading "place needed", inside `#placesPop`.
- **public/js/chat.js**
  - **Clock chip:** `loadClock(view?)` reads `GET /api/clock`. When `frozen` is true, the chip reads "held Tue 9:04pm" in her timezone (from `/api/settings`); otherwise it is hidden. It runs on page load and after every `setScene`. After a scene change it uses the `clock` field the scene PUT returns when there is one, and fetches `/api/clock` otherwise.
  - **Place needed:** `setScene` catches a 400 on a together switch, reopens the Together form and shows the "place needed" chip. Every other error goes to `showError` as before.
  - **Song feedback:** `songCard` adds a `.song-feedback` group with two buttons, "know it" (`data-kind` known) and "not for me" (`data-kind` disliked).
    - `aria-pressed` reflects the stored kind. The page reads `GET /api/known-artists` once and caches it by `artistNorm`, a copy of the spec's normalisation.
    - A press posts `POST /api/messages/:id/song-feedback`. The pressed kind shows a chip, "known" or "not for me".
- **public/state.html and public/js/state.js**
  - **Wants tab:** each want card gets a Beats block.
    - The list comes from `GET /api/wants/:id/beats?status=all`.
    - Each `.beat-row` shows the title, a kind chip, the date and time in her timezone (from the run's `due_at`), a "moved" chip when `shifted_ms` is above 0, and a status chip. Once resolved it adds the outcome chip, a his-part chip and the outcome note.
    - Add beat form: title, kind (step or event), date, time, and up to four variant rows. Each variant's outcome select is limited to that kind's outcomes and rebuilds when the kind changes. It posts `POST /api/wants/:id/beats`.
    - Per beat: Edit (`PUT /api/beats/:id`; the kind cannot be changed once the beat exists), Cancel (`PUT` with status cancelled, after a confirm) and Resolve (an optional variant select that pre-fills the outcome, outcome, note, his part, his note; `POST /api/beats/:id/resolve`).
  - **Now tab:** a new Friction card with a friction field, a friction days field (1 to 14) and a phase chip (fresh, healing, faint, healed).
    - The phase is computed on story time: real time minus the held spans listed by `GET /api/clock`.
    - `status_before` shows read-only, with a chip for the current status, while a lateral state (cooling off, on a break, over) holds.
    - Save and Clear write through `PUT /api/state/relationship`. When the friction text changes, the page drops `friction_set_at` so the server stamps it fresh.
  - **Life tab:** `loadLife` also reads `GET /api/world`. People are matched by `thread_id`, places by normalised title.
    - Person rows show a "locked" chip when named and a "name" chip when the name is a placeholder.
    - A Rename button opens a name field. The second press ("Confirm rename") sends `POST /api/people/:id/rename` with `confirm: "rename"`.
    - Person and place rows both get a Fixed facts list, with Remove (`DELETE /api/world/facts/:id`) and an Add fact field (`POST /api/world/facts`).
    - The thread editor's title field is read-only for a named person.
  - **Facts tab:** a "guess" chip on facts where `inferred` is 1. The versions list shows the `merged into` / `merged:` sources as a chip, plus the guess chip.
  - **Inbox:** `KINDS` now includes the seven new kinds, and `KIND_LABEL` gives them labels: beat, beat outcome, her read, same fact, guess, world fact, his ears.
- **public/memory.html and public/js/memory.js**
  - **Her read (`#memoryViews`):** one `.view-row` per read, with superseded rows hidden.
    - Each row shows the read, a `.progress` confidence meter (its width set in script, never a style attribute) and a status chip (active, proven wrong, retired).
    - An evidence-count button fetches the first evidence message, stores its conversation under `avelie.conversation` and opens `/`.
    - "not true" posts `POST /api/views/:id/retire`.
  - **His ears (`#memoryArtists`):** two lists, known and not for me, each artist an `.artist-row` with Remove (`DELETE /api/known-artists/:id`).
  - Fact tiles with `inferred: true` get a `.chip.guess`. All data comes from `GET /api/memory/map`.
- **public/model.html and public/js/model.js**
  - All twenty new settings are in `FIELDS`. The fifteen numeric ones are in `NUMERIC`, and the three switches (`storyClockEnabled`, `nightlyStoryEnabled`, `hygieneEnabled`) are in `BOOL`.
  - A "Her story" group inside the settings form holds the nine remaining settings.
  - **`#storyCard`:** `storyClockEnabled`, `gapLineMinMinutes`, and status chips in `#clockStatus` (clock on or off; held with the time and place, or running; how many held spans; the last three spans with their length).
  - **`#nightlyCard`:** the nine nightly settings.
    - `#nightlyRun` posts `POST /api/nightly/run { force: true }` and shows a status chip per step (ok, amber or danger, with the reason) plus the day, what was spent and how many proposals were kept.
    - `#nightlyRuns` lists the last runs from `GET /api/nightly?limit=28`, grouped by day, in the order her_day, arcs, views, hygiene.
  - Card inputs use `form="settingsForm"`, the pattern the Spotify card already uses.
- **public/css/app.css:** `.beat-row`, `.view-row`, `.artist-row`, `.song-feedback`, `.chip.guess` and `#clockChip`, plus small helpers (`.beats`, `.beat-form`, `.view-list`, `.artist-list`, `.world-fact`). They use only existing tokens, add no second accent, and bring controls up to full tap size at 600px and below.

EXPORTS: none new. These are browser scripts, and they talk to the L8 routes only.

DEVIATIONS FROM SPEC_V5
1. **Song feedback undo:** a second press on the already-pressed song button sends `DELETE /api/known-artists/:id`, which takes the artist off his list. That is a route the spec defines; otherwise the chat would have no way to undo a press.
2. **Beats list scope:** it reads `GET /api/wants/:id/beats?status=all`, so cancelled beats still show, with a "cancelled" chip. L8's route accepts `?status`.
3. **Friction location:** the friction controls are a separate Friction card on the Now tab, beside the Mood card, not fields inside the relationship JSON editor. They save through the same `PUT`.
4. **Evidence control:** the evidence count is a small button rather than a plain chip, so it can be focused and clicked.
5. **Nightly skipped reasons:** a step that did not run shows its reason as a short chip (at most 40 characters); the reason is also in the step chip's tooltip.

WHAT I COULD NOT DO
- No browser run, by the lane rules. ui_v5 does not exist yet (L10 writes it), so I checked its listed conditions by hand with a Node script. All passed: `#memoryViews` and `#memoryArtists`; `#storyCard`, `#nightlyCard`, `#nightlyRun` and `#nightlyRuns`; `#clockChip`; "song-feedback", "know it" and "not for me" in chat.js; "/beats", "/api/world" and "/rename" in state.js; each of the twenty settings present in model.js and as a `name=` in model.html. No page has a `style=` attribute and there is no inline script.

TESTS RUN (from the worktree root)
- `for f in public/js/*.js; do node --check "$f"; done`: all pass.
- `node scripts/check_typography.mjs`: clean.
- `node --experimental-strip-types --test tests/unit/ui_v4.test.mjs tests/unit/nav_v4.test.mjs`: 17 of 17 pass.
- `node --experimental-strip-types --test tests/unit/bubbles_v4.test.mjs tests/unit/bubbles_v2.test.mjs tests/unit/callface_v4.test.mjs tests/unit/elevenlabs_v4.test.mjs tests/unit/phone_v4.test.mjs tests/unit/album_v4.test.mjs`: 64 of 64 pass.
- `npx tsc --noEmit`: exit 0, no errors at the time of the run. My files are JavaScript, so tsc does not check them.

--- L10 Migration, stubs, tests, docs, workflow ---
I finished lane L10 but could not run the integration runner: this lane is not allowed to start a dev server. `npm test` passes 916/916 with nothing skipped (typography clean, tsc 0 errors). The runner has only passed `node --check`, so its v5 phase has never actually run.

**Files written or changed** (all under `/private/tmp/claude-501/-Users-justinnewsome-Documents-ClaudeCode-HQ/e5dcbc67-4480-4c1c-bdb2-d7e749c0c830/scratchpad/avelie_v5`)
- `migrations/0009_v5.sql`: the spec's SQL block. `migrations_v5` checks it against `SPEC_V5.md`.
- `src/providers/stub.ts`: every v5 trigger from "Stub additions".
  - The five nightly prefixes are copies, not imports; `stub_v5` checks each copy equals its module's constant.
  - The four nightly pass answers, the six story replies and the ten proposal triggers.
  - `[[REL]]` accepts a lateral status; `[[VIEW]]` is not a proposal trigger.
  - `stubSpotifyFetch` finds no track when the query contains "notfound" in any case.
  - Every v1 to v4 trigger is kept.
- `tests/unit/helpers_v5.mjs` has everything the spec lists. It also adds `repoText`, `plusMs`, `MIN_MS`, `HOUR_MS`, `beatView`, `sceneVersion` and `clockScript` (answers the reads `syncStoryClock` makes).
- 24 v5 suites, as listed in the spec: 246/246 pass.
  - clock, nightly and consumers came from this lane's earlier run (17:26 to 17:36). I rechecked them; all pass.
  - The other 21 are new: arcs, wants, views, standing, state, proposals, rhythm, checks, honest, songs, world, life, hygiene, said, prompt, settings, migrations, entry, exportImport, ui, stub.
- `tests/integration/run.mjs`:
  - Named edits 3 and 4 are done (`[[REL]]` now expects talking; the typo prediction uses `rhythmCue`).
  - Edit 5 needed no change: every together scene PUT already carried a location.
  - Added a v5 phase on a fresh `.state-v5` (31 checks, in the spec's order) and a v5 block in the 401 gate list.
- `tests/behavior/scenarios.json`: five scenarios R01 to R05, group `v5`, `"v5": true`.
- `docs/workflows/avelie-v5-build.js`:
  - The gate from the spec, then the ten lane paragraphs verbatim, all running in parallel.
  - Lanes and the fix pass use `{ model: 'opus' }`; the gate, integrator, three reviewers and verifier use `{ model: 'fable' }`.
- Docs: API.md (v5 section, settings, cron), README.md, DEPLOY.md section 27, HANDOFF.md (v5 section and new Next list), docs/ARCHITECTURE.md, docs/COSTS.md, docs/BEHAVIOR.md, tests/README.md.
- `package.json` and `wrangler.jsonc` are unchanged.

**Test files edited beyond the five named edits.** Each was needed to keep the tree green:
- `prompt_v4`: the nickname regex also accepts v5's "(it joins the ones before it)".
- `proposals_v4`: the status-line regex also accepts the ladder wording.
- `hisface_v31` and `inbed_v33`: now expect `-p8`.
- `entry_v4`: the push-call regex allows `frozen: clock.frozen`.
- `memory_v4`: a map fact's keys now include `inferred`.
- `migrations_v4`: allows 0009 to sort after 0008.
- `scenarios_v2`: counts 55 scenarios and excludes v5 from the older counts.
- `tests/behavior/run.mjs`: the four new flag codes added to `KNOWN_FLAGS`.

These were made by this lane's earlier run (17:29) or by me; together they pass 70/70.

**Deviations from SPEC_V5**
1. The integration check `[[OUTCOME:sign up|did_it]]` uses `went` instead. The stub files `[[BEAT]]` as kind event, and `did_it` is a step outcome, so `resolveBeat` would answer 400.
2. The integration check "a scene proposal with status together and no location stays unchanged" is missing because no stub trigger produces that payload. `standing_v5` and `proposals_v4`/`v5` cover it as unit tests.
3. The context route returns only the provenance JSON. The runner therefore reads a turn's state text from `GET /api/export` (`messageContext[].state_text`).
4. `nightlyProvider` always reads `stub` through the local overlay. The settings-table check verifies its row by status code only, and the restore writes back `"anthropic"`.
5. `.gitignore` needs `tests/integration/.state-v5/`. That file is not in L10's list; the workflow tells the integrator to add it.

**Commands run**
- `npm test`: 916/916 (all unit suites, including the 24 v5 ones).
- `node --experimental-strip-types --test tests/unit/*_v5.test.mjs`: 246/246.
- The eight edited older suites: 70/70.
- `npx tsc --noEmit`: clean.
- `node scripts/check_typography.mjs`: clean.
- `node --check` on `tests/integration/run.mjs`, `tests/behavior/run.mjs` and the workflow file: ok.
