# Avelie runtime -- API (v1)

All routes require the owner (Cloudflare Access JWT, or the local dev actor). Responses are JSON unless noted. Errors: `{ error, code, retryable?, detail? }` with the HTTP status. Timestamps are ISO 8601 UTC. Money is USD (numbers), stored as micro-USD integers.

## Identity and system

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /api/me | | `{ email, env }` |
| GET | /api/system | | `{ constitutionVersion, promptVersion, settings (no secrets), providerKeys: { anthropic: bool, openai: bool }, counts: { conversations, messages, facts, history, unknowns, pendingProposals, candidates }, spend: { todayUsd, monthUsd, dailyCapUsd, monthlyCapUsd }, state: { relationship, scene } }` |

## Conversations and turns

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /api/conversations | | `ConversationRow[]` |
| POST | /api/conversations | `{ title? }` | `ConversationRow` (201) |
| GET | /api/conversations/:id/messages | `?channel=story|operator` | `MessageRow[]` (asc; v3: her story rows carry `mark` (`keep` or `drop`) when one is set) |
| DELETE | /api/conversations/:id | | `{ ok }` (status deleted; messages kept; audit) |
| POST | /api/conversations/:id/turn | `{ content, idempotencyKey }` | `TurnResponse` (see types.ts) |
| GET | /api/messages/:id | | `MessageRow` (`image_status`: pending, ready, failed or rejected; `image_id` names the photo request / candidate row) |
| POST | /api/operator | `{ content, conversationId? }` | `{ reply, info }` |

Turn error codes: `validation` 400, `not_found` 404, `budget_exceeded` 402, `price_unknown` 402 (the model in use has no entry in `prices`, or a paid image provider has `imageCostUsd` 0; nothing is spent), `provider_failed` 502 (retryable true/false), `provider_refused` 502 (retryable false), `provider_not_configured` 503.

Owner-gate errors carry no reason: a refused Access token is always `{ error: "forbidden", code: "forbidden" }` (403); why it failed goes to the Worker log only.

## State

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /api/state | | `{ relationship: {version, state}, scene: {version, state}, facts: { fixed, avelie, justin }, history, unknowns, hasSharedHistory }` |
| PUT | /api/state/relationship | `{ state, note? }` | `{ version, state }` |
| PUT | /api/state/scene | `{ state, note? }` | `{ version, state }` |
| GET | /api/state/versions/:entity | | `StateVersionRow[]` (desc) |
| POST | /api/state/restore | `{ entity, version }` | `{ version, state }` |
| POST | /api/facts | `{ scope, subject?, fact, source?, disclosed?, provisional? }` | `FactRow` (201) |
| PUT | /api/facts/:id | `{ fact?, subject?, disclosed?, provisional?, source? }` | `FactRow` (new version) |
| DELETE | /api/facts/:id | | `{ ok }` (superseded with status rejected) |
| POST | /api/facts/:id/restore | | `FactRow` |
| GET | /api/facts/:id/versions | | `FactRow[]` (the supersedes chain) |
| POST | /api/history | `{ title, occurred?, body, what_changed?, keep_consistent?, source? }` | `HistoryRow` (201) |
| PUT | /api/history/:id | same fields, partial | `HistoryRow` (new version) |
| DELETE | /api/history/:id | | `{ ok }` |
| POST | /api/history/:id/restore | | `HistoryRow` |
| POST | /api/unknowns | `{ topic, note? }` | `UnknownRow` (201) |
| PUT | /api/unknowns/:id | `{ status?, note?, resolution? }` | `UnknownRow` |

Fixed-scope facts are read-only through the API (403 `fixed_canon`).

## Proposals

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /api/proposals | `?status=pending` (default pending) | `ProposalRow[]` |
| POST | /api/proposals/:id/decide | `{ decision: "approve"|"reject"|"edit", edited?: { proposal, kind? }, note? }` | `{ proposal: ProposalRow, promotedId? }` |

## Settings and usage

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /api/settings | | `Settings` |
| PUT | /api/settings | partial `Settings` | `Settings` (validated: provider in set, effort in set, `imageProvider` one of `runway`, `openai`, `stub` (runway since 2026-09-25: Gen-4 Image with tagged character references, the photo provider; `imageModel` `gen4_image`; the key is checked at call time, so it can be selected before `RUNWAY_API_KEY` exists), 0<=temperature<=2, 64<=maxTokens<=4000, caps >= 0; `model` and `proposalModel` must have an entry in `prices` (the stored table over the built-in one), and `imageCostUsd` must be above 0 unless `imageProvider` is keyless (`stub`); otherwise 400 `validation`) |
| GET | /api/usage | | `{ todayUsd, monthUsd, dailyCapUsd, monthlyCapUsd, byDay: [...] }` |
| GET | /api/audit | `?limit=100` | `audit_events[]` (desc) |

## Images

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /api/assets | | `{ masters, candidates, scenes, videos, portraits, generating, rejected, archive }` (VisualAssetRow lists; `videos` and `portraits` are the approved clips and faces of v3, their candidates sit in `candidates`, and `generating` holds the rows still being made, a clip above all, so the Images page can resume polling after a reload) |
| POST | /api/assets/verify | | `{ results: [{ id, file, expected, actual, ok }], allOk }` (masters only, hashed from ASSETS) |
| POST | /api/images/generate | `{ conversationId, messageId?, description? }` | `{ asset: VisualAssetRow }`. With `description`: owner-triggered, same pipeline as the marker (attached to `messageId` when given). With `messageId` alone: resumes the photo request her message recorded; the page holds this request open for the whole image call (Workers cut background work off 30 s after a response, so the photo is never made in the background). 409 `in_progress` while another request holds it, 409 `already_generated` once the picture exists, 422 `blacklisted`, 402 / 502 / 503 as for turns; any failure leaves the message `image_status` failed and the request retryable. |
| POST | /api/images/:id/decide | `{ decision: "approve"|"reject", note? }` | `{ asset }` |
| GET | /media/:id | | image/png (candidate or approved only; 404 otherwise) |

## Export / import

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /api/export | | export JSON (see SPEC) |
| GET | /api/export/transcript/:conversationId | | text/plain |
| POST | /api/import | export JSON | `{ ok, snapshotId, counts }` |

## Static

Everything under `/` not matching `/api/*` or `/media/*` is served from `public/` through the ASSETS binding, after auth. `/` -> `index.html`.

# v2

Same rules as v1: owner only, JSON unless noted, the one error shape, UTC timestamps. Every v2 write is audited like a v1 write. Routes are grouped by the SPEC_V2 section that defines them.

## Changes to v1 routes

| Route | What changed |
|---|---|
| GET /api/conversations/:id/messages | Hides her replies whose `deliver_at` is still in the future. `?includePending=1` shows them (the Chat page asks for them so it can hold the dots until their time). |
| POST /api/conversations/:id/turn | Also accepts multipart: `content`, `idempotencyKey`, up to 3 `image` files (jpeg, png, webp, 8 MB each). JSON works as before. `TurnResponse.deliverAt` is the ISO time her reply arrives (null when it is already there). `TurnResponse.userMessage` is `null` on an opener turn. |
| MessageRow | New columns: `deliver_at` (ISO or null), `song_json` (`{ artist, title, searchUrl }` or null), `audio_key` (R2 key of a voice note, hers or his), `images_json` (keys and sizes of the photos he sent), `media_id` (a library item she sent). |
| PUT /api/state/scene | `status` is one of `together`, `apart`, `none`. `location` is where they both are (together) or where she is (apart). The Chat header toggle sends `{ status, location?, note: "toggle" }`. |
| PUT /api/state/relationship | The state may carry `mood` (free text, up to 200 characters) and `cooling_off_until` (ISO time or null). Both are validated; anything else in the object passes through as before. |
| GET /api/proposals | New kind `life` (payload: `kind`, `title`, `detail?`, `schedule_json?`, `relation?`). A `relationship` proposal may carry `mood` and `cooling_off_hours` (0 ends a cooling-off). An `opinion_change` proposal carries `subject`; approving it supersedes the approved opinion with the same subject instead of adding a second one. |
| PUT /api/settings | Validates the new settings (table below). |
| GET /api/system | `settings` includes the new keys. |

Turn error codes unchanged. A multipart turn with a file over the size limit or of the wrong type is `validation` 400.

## Her life (F, G, P, W)

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /api/life | `?status=active` (default: every current row; `active`, `done` or `dropped` to filter) | `{ threads: LifeThread[], log: LifeLog[] }` |
| POST | /api/life/threads | `{ kind, title, detail?, schedule_json?, relation? }` (`kind`: routine, event, person, place, arc) | `LifeThread` (201) |
| PUT | /api/life/threads/:id | partial `{ title, detail, schedule_json, relation, status }` (`status`: active or done) | `LifeThread` (new version, old row superseded) |
| DELETE | /api/life/threads/:id | | `{ ok }` (new head with status dropped; the chain stays) |
| POST | /api/life/threads/:id/restore | | `LifeThread` (a dropped head or an older version comes back as the newest active row) |
| POST | /api/life/log | `{ threadId?, occurred, note }` | `LifeLog` (201) |

`schedule_json` shapes. A routine: `{ "tz": "America/New_York", "blocks": [{ "days": [1,2,3,4,5], "start": "09:00", "end": "17:30", "label": "at work" }] }` (days 0 = Sunday to 6 = Saturday; up to 21 blocks). An event: `{ "at": "2026-10-03T19:30:00-04:00", "minutes": 120, "label": "open mic" }` (`minutes` defaults to 120, at most 1440). A malformed schedule is refused with `validation` 400; one that parses is stored re-serialized.

## Why she said that (L)

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /api/messages/:id/context | | `{ promptVersion, provider, model, historyIds, factIds: { avelie, justin }, threadIds, callbacks: [{ sourceId, ageDays, text }], unknownIds, recentMessageCount, flags, mode, runIds, retried, deliverAt, song, photoRequested, opener }`. 404 when the message has no context row (his messages, operator messages, v1 rows). Ids and counts only: never prompt text, never a key. |

## Let her open (Q)

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | /api/conversations/:id/open | | `TurnResponse` with `userMessage: null`. Runs one turn with the one-time opener note appended after the state sections; stores only her message, `reply_to_id` null. Same checks, same caps, same proposal pass. No delay is applied to an opener. |

## Photos (O)

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | /api/images/:id/regenerate | | `{ asset }`. Rejects the candidate (its hash joins the blacklist) and runs the same description through the pipeline again, attached to the same message. Same 402, 409, 422, 502 and 503 answers as `/api/images/generate`. |

## Drift check (N)

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | /api/drift/run | | `{ report: { id, ranAt, summary } }`. Runs the five scenarios tagged `drift: true` against a throwaway conversation (status `drift`, hidden from the chat list) on the configured text provider, stores the transcripts and flag counts, then deletes the throwaway messages. Spend goes through the normal caps (402 when over). 503 `provider_not_configured` on the stub or without a key. |
| GET | /api/drift | `?limit=4` | `[{ id, ran_at, provider, model, prompt_version, json }]` newest first. |

## She texts first (R)

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | /api/herfirst/run | | `{ sent: boolean, reason, message? }`. One tick by hand: the same decision the 20-minute cron makes (off, quiet hours, busy, cap reached, a message in the last 45 minutes, two of hers unanswered, the per-tick probability), then one opener turn when it decides to send. A first text whose checks raise `dependency_hook` is dropped, logged and not retried in that tick. |

## Voice (S)

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | /api/conversations/:id/voice | multipart: `audio` (webm/opus, at most 60 s and 4 MB), `idempotencyKey` | `TurnResponse`. The recording is stored (`voice_in/<id>.webm`), transcribed, and the transcript runs as a normal turn; his message carries `audio_key`. |
| GET | /media/audio/:messageId | | audio/mpeg (her voice note) or audio/webm (his recording), owner only, `private, no-store`. 404 when the message has no audio. |

Her voice note is made when her message ends with `[voice]` (voice mode `some`) or on every reply (voice mode `all`), and stored as `voice/<messageId>.mp3`. With `voiceProvider` `off`, or `elevenlabs` without its key, no audio is made and the message is still stored.

## She can see (T)

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /media/inbox/:messageId/:n | | the n-th photo he sent with that message (jpeg, png or webp), owner only. 404 otherwise. |

The photos ride on the turn (multipart, above). Only the last 6 of his messages carry their images into the prompt.

## Push (U)

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /api/push/public-key | | `{ key }` (the VAPID public key, base64url) or 503 `push_not_configured` when the secrets are absent. |
| POST | /api/push/subscribe | the browser's `PushSubscription.toJSON()` (`endpoint`, `keys`) | `{ ok }` (201). One row per endpoint. |
| DELETE | /api/push/subscribe | `{ endpoint }` | `{ ok }` |
| GET | /api/push/latest | | `{ messageId, text, conversationId, createdAt }` for her latest first text, or 404. The service worker reads this when a push arrives; the push itself carries no body. |

Push is sent for her first texts only. Nothing else ever pushes.

## Media library (V)

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | /api/media | multipart: `file` (audio, video or image, at most 25 MB), `title`, `description`, `kind` (clip, video, image, other) | `MediaRow` (201): `{ id, kind, title, description, key, mime, bytes, sha256, status, created_at }` |
| GET | /api/media | | `MediaRow[]` |
| DELETE | /api/media/:id | | `{ ok }` (the R2 object is removed; a message that sent it keeps its `media_id` and shows a missing card) |
| GET | /media/library/:id | | the file, owner only, `private, no-store` |

She sends one with `[media: <title>]` (exact title, case-insensitive match, one per message). An unknown title strips the marker and adds the flag `media_unknown`.

## Timeline (X)

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /api/timeline | `?limit=500&before=<ISO>` | `{ items: [{ at, type, title, text?, link?, id }], nextBefore }` merging history entries, approved photos, media sent, life log notes, relationship and scene versions, and her first texts, newest last. Read-only. |

## Voiceprint (Y)

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | /api/voiceprint/run | | `{ voiceprint }` for the week ending now: count, mean and median length, share ending with "?", share with "lol" or emoji, share containing his name, top 25 words minus stopwords, bubbles per reply, first-text count, flags per code. |
| GET | /api/voiceprint | `?limit=8` | `[{ id, week, json, created_at }]` newest first. |

## Export her (Z)

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /api/export/character | | `{ constitutionVersion, adaptations, fixedCanon, avelieFacts, opinions, history, life, unknowns, relationship, scene, images: [approved, with hashes], mediaTitles, promptPrefixSha256 }`. No secrets, no keys, no prompt text. |
| GET | /api/export/character.md | | text/markdown: the same as a readable character bible, one heading per section. |

The v1 `GET /api/export` still returns everything (it now includes the v2 tables) and `POST /api/import` still takes it back.

## Settings added in v2

| Key | Default | Accepted |
|---|---|---|
| replyDelayMode | `"instant"` | `instant` or `real` |
| realDelayMaxMinutes | 6 | 1 to 120 (whole minutes) |
| driftCheckEnabled | false | boolean |
| timezone | `"America/New_York"` | an IANA name `Intl.DateTimeFormat` accepts |
| herFirstTextsPerDay | 0 | 0 to 10 (0 = off; his word was opt-in, so it ships off and he sets the number on the Model page) |
| herFirstQuietHours | `"23:30-08:30"` | `HH:MM-HH:MM` in her timezone; may cross midnight |
| voiceProvider | `"workersai"` | `workersai`, `elevenlabs`, `off` (`stub` locally) |
| voiceMode | `"some"` | `off`, `some` (only when she ends a message with `[voice]`), `all` |
| elevenLabsVoiceId | `""` | a string; used only with `elevenlabs` |
| transcribeProvider | `"workersai"` | `workersai` or `openai` |

`PUT /api/settings` refuses a bad value with `validation` 400 and changes nothing.

## Secrets added in v2 (all optional; a feature without its secret stays off and logs why)

| Secret | Used by |
|---|---|
| ELEVENLABS_API_KEY | voice out with `voiceProvider: "elevenlabs"` |
| VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY | push for her first texts (`scripts/gen_vapid.mjs` prints the two `wrangler secret put` lines) |

## Cron triggers (wrangler.jsonc `triggers.crons`)

| Cron (UTC) | What runs |
|---|---|
| `0 7 * * *` | nightly backup: the full export to R2 `backups/avelie-<YYYY-MM-DD>.json`, keep the last 30 |
| `0 13 * * 1` | weekly drift check, only when `driftCheckEnabled` |
| `*/20 * * * *` | her first texts (one decision per tick) |
| `0 14 * * 1` | weekly voiceprint |

Locally: `npx wrangler dev --test-scheduled` then `curl "http://127.0.0.1:8787/__scheduled?cron=0+7+*+*+*"` runs one handler by its cron string.

# v3

Same rules as v1 and v2: owner only, JSON unless noted, the one error shape, UTC timestamps, every write audited. Routes are grouped by the SPEC_V3 section that defines them. The v3 lanes were written in parallel against SPEC_V3; the names below are the contract the router codes against.

## Changes to v1 and v2 routes

| Route | What changed |
|---|---|
| POST /api/conversations/:id/turn | `tasting: true` in the JSON body runs the same turn on two performers (HH) and answers the blind pair, or a normal `TurnResponse` whose `flags` carry `tasting_void` when one side failed. Every turn shape (plain, tasting, Retry, `/open`, a first text, a voice turn) answers 409 `tasting_pending` while a tasting is pending in that conversation; the same key with `tasting: true` replays it. |
| GET /api/messages/:id/context | Carries the v3 provenance: `exemplarIds`, `correctionIds`, `recall: { provisional, firmFactIds, fadedCount }`, `wantIds`, `askIds`, `moodPhase`, `weather`, `outfitFrom`, `groundingRowIds`, `shapeCue`, `signature`, `tasting: { id, winner, loser }`, `callId`. |
| POST /api/images/:id/decide | Also decides roles `portrait` and `video`. Approving a portrait sets `portrait_asset_id` on the person's current head (an earlier approved portrait is archived); rejecting a clip or a portrait deletes the bytes and keeps the hash on the blacklist. |
| GET /media/:id | Serves a clip (role `video`) as `video/mp4` with Range support (a `Range` header answers 206 with `content-range` and `accept-ranges: bytes`, so `<video>` can seek) and a portrait as `image/png`. |
| GET /api/system | `counts` gain `voiceLinesUnapproved`, `voiceLinesApproved`, `correctionsActive`, `wantsActive`, `asksOpen`, `callsToday`, `tastingsPending`, `finetuneApproved`. |
| PUT /api/settings | Validates every v3 setting (table below). Three consistency rules join the v2 ones: `tastingModel` must be priced before `tastingEnabled` can be true; `videoCostUsd` must be above 0 while `videoProvider` is `runway`; `portraitCostUsd` must be above 0 unless the image provider is keyless. |
| GET /api/export, POST /api/import | The export carries every v3 table except `weather_cache`; the import takes them back with the same one-of rules the schema states. |
| POST /api/snapshots `{ label? }`, GET /api/snapshots, POST /api/snapshots/restore `{ key }` | v3.2: a named snapshot is the same export written to R2 under `snapshots/avelie-<day>-<hhmm>-<slug>.json` (outside the nightly pruning); restore runs the same import (story tables replaced, settings and visual assets merged) from a snapshot or a nightly backup key. Made for trying something in another chat and putting her memory back. |
| GET /api/export/character | Gains `voiceLines` (approved), `corrections` (active), `wants`, `asks`. |
| GET /api/timeline | Gains calls, want log rows, asks, corrections and portrait approvals. |

## Voice bank and the notes (AA)

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /api/voicebank | `?status=unapproved|approved|rejected|all&tag=<tag>&limit=500` | `{ lines, counts: { unapproved, approved, rejected }, tags }` (`tags` is the fixed vocabulary; absent status = all) |
| POST | /api/voicebank | `{ text, tags }` (text 1 to 160 plain characters; 1 to 4 tags from the vocabulary) | line (201, status `approved`, origin `owner`) |
| PUT | /api/voicebank/:id | `{ text?, tags? }` | line |
| POST | /api/voicebank/:id/decide | `{ decision: "approve"|"reject" }` | line (409 `already_decided` on a decided line) |
| POST | /api/voicebank/decide | `{ ids, decision }` (at most 500 ids; one statement per id in one batch) | `{ changed }` (a line already decided is not counted) |
| GET | /api/corrections | `?status=active|retired|all&limit=200` | rows |
| POST | /api/corrections | `{ messageId, kind, note?, rewrite?, toBank? }` (`kind`: ai, clever, not_her, too_long, too_nice, too_polished, other; her story messages only, 400 otherwise; a rewrite is 1 to 1000 characters and, with `toBank` or the `correctionRewriteToBank` setting, becomes an approved bank line with origin `correction`) | row (201) |
| POST | /api/corrections/:id/retire | | row |
| POST | /api/corrections/:id/restore | | row |

The tag vocabulary: stranger, familiar, banter, dry, warm, flirt, annoyed, after_friction, repair, tired, sad, excited, morning, day, evening, late, apart, together, answering, decline, no, own_day, ask, photo_ask, photo_send, song_send, one_word, fragment, lowercase, typo_fix. A seed line is read by nobody until it is approved.

## Memory (BB)

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /api/memory | `?entity=fact|history|thread|log|want&limit=200` (absent entity = fact) | rows with `weight`, `lastTouched`, `touches`, `score`, `shown` |
| PUT | /api/memory/:entity/:id | `{ weight?, lastTouched? }` (weight 0..1; lastTouched ISO 8601) | row |
| GET | /api/memory/recalls | `?limit=50` | recalls resolved to text (`outcome` is always `unknown` in v3) |

`provisionalRecallEvery` ships at 0: no half-remembered detail ever enters the prompt until the owner raises it in the Model panel.

## Wants and asks (CC)

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /api/wants | `?status=active|paused|done|dropped|all&askStatus=open|granted|declined|let_go|all` | `{ wants (each with lastLog), asks }` |
| POST | /api/wants | `{ title, why?, stakes?, next_step?, progress?, horizon_days?, source? }` | want (201) |
| PUT | /api/wants/:id | partial, including `status` | want |
| POST | /api/wants/:id/log | `{ kind: progress|setback|note, delta?, note, occurred? }` (delta -100..100; 409 `not_active` on a done or dropped want) | log row (201) |
| GET | /api/wants/:id/log | | rows |
| POST | /api/asks | `{ text, wantId? }` | ask (201) |
| PUT | /api/asks/:id | `{ status: granted|declined|let_go|open, note? }` | ask |

Mood: the relationship state may carry `mood_set_at` (ISO) and `mood_days` (1..14). `PUT /api/state/relationship` validates both; a mood change without `mood_set_at` stamps it now. The prompt shows the mood as fresh, fading or faint and shows nothing once it is gone; the stored state is untouched.

## Grounding (DD)

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | /api/grounding/geocode | `{ name }` | `{ results }` (at most 5 `{ name, latitude, longitude, timezone, country, admin1 }`; `[]` when nothing matches). The one route that calls out for him; settings PUT never does. |
| GET | /api/grounding | | `{ city, weather, timeOfDay, outfit, today }` (`weather` null when the provider is off or the call failed) |
| POST | /api/grounding/log | `{ kind: meal|outfit|errand|misc, note, occurred? }` | row (201) |
| DELETE | /api/grounding/log/:id | | `{ ok }` |
| POST | /api/life/threads/:id/portrait | `{ description }` | `{ asset }` (role `portrait`, held open like a photo; 404 unknown thread, 409 `in_progress` / `already_generated`, 422 `blacklisted`, 402, 502, 503 as for photos) |

## Calls (EE)

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | /api/calls/start | `{ conversationId }` | 201 `{ call, provider, clientSecret, expiresAt, sdpUrl, model, voice, maxSeconds, tickSeconds }`. The only place the client secret ever appears: not stored, not audited, not logged, not in any later read. 503 `provider_not_configured` when `callProvider` is `off`, or `elevenlabs` without `ELEVENLABS_API_KEY` and an agent id (detail `elevenlabs`; built in v4 A2, the start response then carries `transport`, `agentId` and `overrides`), 409 `call_in_progress` while a call is live anywhere (a live call with no tick for 120 s is expired first), 402 when two minutes at the per-minute price do not fit under the caps. |
| POST | /api/calls/:id/tick | `{ seconds, usage? }` (`usage` cumulative token counts `{ audioIn, audioOut, textIn, textOut }`, non-negative integers) | `{ ok, secondsTotal, costUsd, stop, reason? }` (`stop` with `max_minutes` or `budget`; the crossing tick is still recorded) |
| POST | /api/calls/:id/end | `{ reason, segments: [{ who: him|her, text, at }], usage?, seconds? }` (at most 2,000 raw segments, 4,000 characters each; consecutive same-speaker segments are merged, empties dropped, the transcript capped at 80 rows; `seconds` is the page's count since the call went live, taken up to the ticks recorded plus 60, so the per-minute floor sees the time since the last tick and a call that ends before its first tick is not free) | `{ call, messageIds }` (409 `call_over` once ended; the rows are story messages with `call_id`, her rows flagged by the flag-only checks, the proposal pass runs over them) |
| GET | /api/calls | `?conversationId=&limit=50` | rows (no secret) |
| GET | /api/calls/:id | | `{ call, messages }` (no secret) |

The page talks to the realtime provider itself over WebRTC; the Worker mints the short-lived token, meters the call from what the session bills (`max(seconds x callPricePerMinute, usage x callPrices)`), and stores the transcript. The content security policy allows `connect-src https://api.openai.com` and `media-src blob:`, and the permissions policy grants the microphone to this origin only.

## Clips (FF)

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | /api/video/generate | `{ sourceAssetId, description }` (a master or an approved photo of her) | 202 `{ asset }` (role `video`, status `generating`; 400 `source_too_large` over 5 MB encoded, 402, 404, 409, 503 without a Runway key or with `videoProvider` off) |
| POST | /api/video/:id/poll | | `{ asset, status: "running"|"candidate"|"failed" }` (422 `blacklisted` when the finished clip's hash was rejected before) |

Decisions go through `POST /api/images/:id/decide`. The `[clip:]` marker is v3.1; clips are owner-triggered from the Images page only. With no `RUNWAY_API_KEY` the provider reports not configured and the controls stay hidden.

## Tastings (HH)

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | /api/conversations/:id/turn | `{ content, idempotencyKey, tasting: true }` | `{ tastingId, conversationId, userMessage, candidates: [{ side: left|right, text, flags, photo, song }], expiresAt }` (blind: no provider or model names), or a `TurnResponse` with `tasting_void` when one side failed. 400 `validation` while `tastingEnabled` is false, 402 `tasting_budget_exceeded` over `tastingDailyCapUsd` (both sides are estimated at their own performer's price), 409 `idempotency_conflict` when the key already went through a tasting that is no longer pending (after Neither or an expiry; nothing is spent, and the page sends that key as a plain turn), 503 when the tasting performer is not configured. The tasting stores the state its two candidates saw (`tastings.context_json`, migration 0006), and the pick commits that state's provenance, exemplar uses and recall row rather than a state rebuilt at pick time. |
| GET | /api/tastings/:id | | the tasting with its two candidates (blind while pending; `pick`, `winnerSide`, `left`, `right` with their performers once decided) |
| POST | /api/tastings/:id/pick | `{ pick: left|right|neither }` | `{ tasting, assistantMessage }` (`left` or `right` stores that candidate as her message; `neither` voids the tasting and stores nothing, and the page's Retry with the same key runs a normal turn; 409 `already_decided` / `expired` after 30 minutes) |
| GET | /api/tastings/ledger | | `{ performers: [{ performer, wins, losses, draws, rate, last }], recent }` |
| POST | /api/tastings/promote | `{ provider, model }` | `Settings` (400 `price_unknown` for an unpriced model; writes `provider` and `model`, audited) |

## Marks and the texter (II)

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | /api/messages/:id/mark | `{ mark: keep|drop, note? }` (her story messages only, 400 otherwise; upsert) | `{ mark, note, messageId, createdAt }` |
| DELETE | /api/messages/:id/mark | | `{ ok }` (404 when there is no mark) |
| GET | /api/finetune/status | | `{ approved, minimum, ready, breakdown: { keeps, rewrites, picks }, texterModel, live: { provider, model }, previous }` (from the stored settings, never the local overlay) |
| GET | /api/finetune/export.jsonl | `?stripHim=0|1&includeExplicit=0|1` | `text/plain`, `content-disposition: attachment; filename="avelie-train-<date>.jsonl"`, streamed line by line: `{"messages":[system, user, assistant]}`, the system being ALWAYS_ON + OVERLAY + the state she saw (compact) or the whole prefix + the state (full; 413 `too_large` over 1,000 examples). Absent `stripHim` = 1 (his answer of 2026-09-24, on by default, holds for a bare GET from a script or a bookmark as well as for the panel; `stripHim=0` opts out). Absent `includeExplicit` = 0: an exchange the explicit detector flags is left out, and a Drop mark leaves one out by hand either way. |
| GET | /api/finetune/export.json | the same query | the export record: `{ exportedAt, promptVersion, constitutionVersion, systemMode, stripHim, count, skipped: { noState, flagged, dropped }, breakdown, sentFactIds, sentHisName, lineHashes, sha256 }` (`sha256` is the chain over `lineHashes`; `scripts/finetune_run.mjs --verify` recomputes it from the downloaded file) |
| POST | /api/finetune/use | `{ model, inputPerMTok?, outputPerMTok? }` (`ft:...` or a plain OpenAI model id; both prices required when the price table has no row, 400 `price_unknown` otherwise; 503 without `OPENAI_API_KEY`) | `Settings` as stored (provider `openai`, `model`, `texterModel` set, `texterPrevious` remembered; `proposalProvider` and the rest untouched) |
| POST | /api/finetune/revert | | `Settings` (back to `texterPrevious`, or anthropic / claude-opus-5 when there is none) |

What the export carries, said plainly: his approved facts, his recorded name and nicknames, the private language, the shared history and every other state section exactly as she saw them on each turn, unless `stripHim=1`, which removes WHAT YOU KNOW ABOUT HIM and THINGS YOU HALF REMEMBER and the four keys of the Relationship line. His own messages and her replies go as written either way. Never secrets, ids, the operator channel, call rows or the audit.

## What he looks like (JJ, v3.1)

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /api/him | | `{ photos: [{ id, file, bytes, sha256, created_at }], look, settings: { hisFaceMax, hisFaceInTogether, hisFaceApartEvery } }` |
| POST | /api/him/photos | multipart, field `photo` (jpeg, png or webp by its bytes, 8 MB) | 201 the `visual_assets` row (role `him`, approved at upload, file `him/<id>.<ext>`); 409 `him_full` at `hisFaceMax`; 415 for anything else; 400 with no file |
| GET | /api/him/photos/:id | | the photo's bytes, owner only (never on `/media/:id`, never on the Images page) |
| DELETE | /api/him/photos/:id | | 204 (the object and the row go; 404 for anything that is not his photo) |
| POST | /api/him/describe | | `{ look }`: the story performer's own description of the photos on file, cleaned and cut at 600 characters, not saved. A paid call (`model_runs` kind `describe`, under the caps: 402 over one, 503 with the performer not configured, 409 `cannot_see` on a performer that cannot look at a picture, 409 `no_photos` with none on file, 502 on a refusal) |
| PUT | /api/him/look | `{ look }` | `{ look }` as stored (trimmed, " -- " and "..." typography, at most 600 characters; "" clears it; audited `him.look.save`) |

The words reach every turn as the WHAT HE LOOKS LIKE section; the photos ride on the provider call (never on his stored message) on his first turn of a conversation (her opener does not count), whenever he mentions his looks, on every Together turn while `hisFaceInTogether` is on, and every `hisFaceApartEvery` turns in Apart mode; never when a performer on the call cannot see (on a tasting turn both performers must). `GET /api/messages/:id/context` carries `hisFace: { section, shown, photos }`. `GET /api/assets` never lists a role `him` row.

## v4 (SPEC_V4, 2026-09-26): her face, her phone, the call face, the two of us, her playlist and player, the album, deliveries, the memory map, the scene as a place, her clips

Every route below is owner-only behind the same door; the cross-site gate covers every POST, PUT and DELETE. Errors keep the v1 shape (`{ error, code, retryable?, detail? }`). No new state section: `PROMPT_VERSION` still ends `-p7`; the stable prefix moved exactly once, for the CLIPS overlay (amendment A3).

### The avatar (section 0)

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /api/avatar | | `{ assetId, file, focus: [x, y] }` (the stored `avatarAssetId` when it names an approved master, else `master-05`; `file` is the master's path under `/images/masters/`, `focus` the face-centred crop in percent of width and height, the same table public/js/nav.js applies through the CSSOM) |

### Her phone and her places (sections 1 and 8)

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /api/phone | | `PhoneState`: `now`, `tz`, `localClock`, `weekday`, `timeOfDay`, `where { busy, label, until }`, `scene { status, location }`, `weather`, `city`, `outfit`, `mood { mood, phase, setAt, days, ageDays, fraction }` (null when none; `fraction` = ageDays / (2 x days), capped at 1), `wants` (capped at `wantsShown`), `asks` (open), `today`, `listening { artist, title, line, day }` (null with `listeningLineEnabled` off, on a refusal, or under the caps; one small paid call a day on the story performer, cached per her local day in `panel_cache`, run kind `listening`), `places` (each `{ id, title, detail, lat, lon, active, picture, here }`; never the R2 key), `map { bounds, view, outline }`. Writes on a read: `syncPlaces` (a place thread's row) and the listening cache, nothing else |
| GET | /api/places | | `{ places: PlaceRow[] }` after `syncPlaces` (every column but `picture_key`, plus `active` and `picture`) |
| POST | /api/places | `{ title, detail?, lat?, lon? }` | 201 the row (a title already on file answers its row, the pin and detail applied) |
| PUT | /api/places/:id | `{ lat?, lon?, detail?, geocodedBy?: "owner" \| "map" }` | the row (400 on one coordinate without the other or out of range; 404) |
| POST | /api/places/:id/geocode | | the row with `geocoded_by openmeteo` (404 `no_match` when nothing within 30 km of her city; 502 `provider_failed`; the stub answers Stubtown, which is not near Portland) |
| POST | /api/places/:id/picture | `{ remake?: boolean }` | the row with `picture: true` (held open like a photo; 402 under the caps or `price_unknown` at 0 on a paid image provider, 404, 409 `already_generated` without `remake`, 502, 503); one `model_runs` row of kind `place` at `placeCostUsd`; no `visual_assets` row, no approval flow, never the outfit rule or the character export |
| DELETE | /api/places/:id/picture | | the row with `picture: false` |
| GET | /media/place/:id | | `image/png`, `private, no-store`; 404 without a picture |

A place row shadows the newest active place thread per normalised title (`thread_id` is the current head, refreshed on every read); a dropped thread keeps its row, listed with `active: false`. `PUT /api/state/scene` now answers `{ version, state, place: { id, picture } | null }` and, for a Together scene at a known place, touches the place's `last_used_at` (best effort).

### The call face (section 2)

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /api/callface | | `{ provider, source, clips: { idle, listening, talking }, candidates, generating, ready }` (200 whatever the provider; `ready` only on `clips` with all three approved) |
| POST | /api/callface/make | `{ kind: "idle" \| "listening" \| "talking" }` | 202 `{ asset }` (role `callface`, generating; the same clip path as `POST /api/video/generate` with the ratio `960:960` and five seconds, charged at start at `videoCostUsd`); 400; 402; 409 `in_progress` while a clip of that kind generates; 503 `provider_not_configured` with detail `off`, `reserved_v4_1` (lipsync) or `runway` without the key |

Polling through `POST /api/video/:id/poll` (a call-face candidate keeps `callface:<kind>` in `notes`); decisions through `POST /api/images/:id/decide` (approving a kind archives the earlier approved clip of that kind; a rejected face's hash is blacklisted like any clip). `GET /media/:id` streams role `callface` as `video/mp4` with Range. `GET /api/assets` gains `callface` (approved) and lists face candidates and generating rows with the clips.

### Him in the picture (section 3)

No new route. When her photo line says he is in it (`photoIncludesHim`, src/markers.ts) and `hisFaceInPhotos` is on, his newest approved reference photo rides as the third tagged reference (`@him` on Runway; one more `image[]` part on OpenAI) with two of hers; the candidate row carries `with_him = 1`, the audit's `after.withHim` says so, and the reply carries the flag `photo_with_him`. With no photo of him on file the picture is of her alone and the message carries `him_not_on_file` (or `him_photo_too_large` past the 5 MB data-URI cap). `GET /api/assets` rows and `GET /api/album` items carry `with_him` / `withHim`; the character package never carries a with-him picture; the Images page never lists his own photos; the outfit rule never reads them.

### Her playlist and the player on his Spotify (section 4 and amendment A1)

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /api/spotify | | `{ connected, displayName, playlistId, playlistName, scope, configured, playlist: { ok, name } \| null }` (never a token) |
| GET | /api/spotify/connect | | 302 to `accounts.spotify.com/authorize` with `response_type=code`, the seven scopes (`playlist-modify-private playlist-read-private streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state`), the redirect URI (this origin plus `/api/spotify/callback`) and a single-use 32-hex `state`; 503 `provider_not_configured` without both secrets (locally `SPOTIFY_STUB=1` counts while `ACCESS_AUD` is empty). A second press on a connected row rewrites the state only |
| GET | /api/spotify/callback | `?code&state` (or `?error`) | 302 to `/model#spotify`; 400 `validation` on `error`; 403 `forbidden` on a state mismatch (nothing stored); 502 `provider_failed` on a token or profile failure (detail `me_forbidden`, `no_refresh_token`). Stores the tokens in `spotify_auth`, creates the private playlist once when `spotifyPlaylistId` is empty, sets `spotifyEnabled` true, audits `spotify.connected` with ids only |
| GET | /api/spotify/token | | `{ accessToken, expiresAt, premium, deviceName: "Avelie", player }` for the Web Playback SDK (refreshed under five minutes; `premium` from `/v1/me` cached a day); 403 `not_connected`. Never audited, never logged; the refresh token never leaves the Worker |
| POST | /api/spotify/disconnect | | `{ ok: true }` (the row deleted, `spotifyEnabled` false; the playlist stays on his account) |
| POST | /api/messages/:id/spotify | | `{ status }`: `added`, `already`, `not_found`, `failed`, `off` (the add by hand; 400 when the message carries no song; 404) |

The add runs after her reply is stored (`afterReply`, best effort): `messages.spotify_status` starts as `pending` when a reply carries a song and the playlist is on, and `song_json` gains `trackUrl` and `uri` once a track is found. `GET /api/conversations/:id/messages` rows carry `spotify_status` and `pushed_at`. The page talks to Spotify itself only through the SDK loaded from `sdk.scdn.co` with the token above; the CSP names `sdk.scdn.co` (script and frame), `open.spotify.com` (the embed frame) and `api.spotify.com`, `*.spotify.com`, `wss://*.spotify.com` (connect). A song he sends her is never added.

### The album (section 5)

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /api/album | `?limit=100&before=<ISO>&group=all\|approved\|candidates\|us` | `{ items: [{ id, messageId, conversationId, at, status, withHim, description, place, sceneStatus, bytes, provider, kind: "photo" \| "clip" }], nextBefore }` (every picture she sent in a conversation, newest first; the place from the scene version in force when the message was sent; never a role him, portrait, call-face or owner-fired row; never the R2 key; limit 1..200) |

### Deliveries and her first texts (section 6)

No new route. In real mode a reply held two minutes or more (`DELAY_PUSH_MIN_MS`) that lands inside the 25-minute window (`DUE_WINDOW_MS`) gets ONE Web Push for the batch on the `*/20` cron (reason `her_delayed_reply`, the only reason beside `her_first_text`); every row the cron sees is stamped `messages.pushed_at`, pushed or not, so no reply is considered twice; a free-branch reply (5 to 90 s) is stamped without a push. `GET /api/push/latest` answers, in order: her newest first text within the window, else the newest reply the cron stamped, else the newest first text. "Get her texts on this phone" on the Model page subscribes push and sets `herFirstTextsPerDay` 2 with the shipped quiet hours; the defaults stay off (`herFirstTextsPerDay` 0, `replyDelayMode` instant).

### The memory map (section 7)

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /api/memory/map | | `{ facts: [{ id, subject, text, weight, lastTouched, touches, score, recency, halfLifeDays, phase, returned, createdAt }], history: [{ id, seq, title, occurred, weight, score, phase, createdAt }], sealed: [{ id, subject, createdAt }], keptToday: [{ id, kind, proposal, decidedAt }], counts: { facts, vivid, firm, fading, faded, returned, sealed, keptToday }, settings, now }` (read-only; facts about him of scope justin and shared, approved; `phase` vivid/firm/fading/faded; `returned` when a stored row was touched within 7 days and created at least 14 days before that touch; `sealed` = her untold facts by subject only, the text never in the body; `keptToday` = proposals kept automatically on her local day, at most 100) |

### The scene as a place (section 8)

No new route beyond the places above. A promoted `scene` proposal now takes `status`, `location`, `time` and `present` from its payload and keeps the rest; a promoted `relationship` proposal takes `status`, `his_name` (null clears), `trust`, `affection`, `attraction` and `nicknames` and keeps the rest (the v3.2 gap). The proposal system prompt asks for those fields; the stub's `[[SCENE:x]]`, `[[SCENE]]` and `[[REL:status|name]]` drive them.

### Her clips from the chat (amendment A3)

No new route. A reply ending in `[clip: what the clip shows]` (at most one; a photo line beside it keeps the clip and flags `clip_with_photo`) starts a clip after the reply is stored: the source is the newest approved photo she sent in this conversation today, else her newest approved photo, else the avatar master; role `video` bound to the conversation and the message, reusing `messages.image_id` / `image_status` (a message carries a photo or a clip, never both), the flag `clip_pending` with the asset id, polled through `POST /api/video/:id/poll`, a candidate until he approves, blacklisted by hash on a rejection. With `videoMarkerEnabled` false, the provider off or its key missing, the line is stripped and the message carries `clip_unavailable`. `GET /api/album` lists clips beside photos with `kind: "clip"`.

### Changed routes (v4)

`POST /api/images/:id/decide` accepts role `callface`; `GET /api/assets` gains `callface` and every row carries `with_him`; `GET /media/:id` serves role `callface` as `video/mp4` with Range; `GET /api/push/latest` also answers a stamped delayed reply; `PUT /api/state/scene` answers `place`; `GET /api/conversations/:id/messages` rows carry `spotify_status` and `pushed_at`; `GET /api/system` counts gain `placesWithPicture`, `callFaceClips` (approved) and `spotifyConnected` (0 or 1), and `providerKeys` gains `spotify` (both secrets present, or the local stub); `GET /api/export` carries `places` (never `spotify_auth`, never the panel cache) and the import accepts `places`, `with_him`, `spotify_status`, `pushed_at` and role `callface` (a `spotifyAuth` key in a payload is ignored); the `*/20 * * * *` cron runs `pushDueReplies` before `maybeTextFirst`. The router matches on segment count, so `/api/memory/map` never meets `PUT /api/memory/:entity/:id`.

## Settings added in v3

| Key | Default | Accepted |
|---|---|---|
| exemplarsPerTurn | 6 | 0 to 12 (0 = the section is never built) |
| exemplarCooldownTurns | 30 | 0 to 500 |
| correctionsShown | 25 | 0 to 100 |
| correctionRewriteToBank | true | boolean |
| memoryDecayEnabled | true | boolean |
| memoryFactsMax | 40 | 5 to 200 |
| memoryHalfLifeLowDays | 10 | 1 to 365 |
| memoryHalfLifeMidDays | 45 | 1 to 3650 |
| memoryHalfLifeHighDays | 400 | 1 to 36500 |
| provisionalRecallEvery | 0 | 0 to 50 (0 = off; his switch) |
| wantsShown | 5 | 0 to 20 |
| askLetGoDays | 14 | 1 to 90 |
| moodDaysDefault | 3 | 1 to 14 |
| herCity | `"Portland, Maine"` | a string up to 80 characters (empty = no weather line) |
| herLat, herLon | Portland's | numbers (-90..90, -180..180) or null |
| weatherProvider | `"openmeteo"` | `openmeteo`, `stub`, `off` |
| weatherUnits | `"fahrenheit"` | `fahrenheit`, `celsius` |
| portraitCostUsd | 0.04 | 0 to 100 (above 0 on a paid image provider) |
| portraitSize | `"1024x1024"` | like `imageSize` |
| callProvider | `"openai"` | `openai`, `stub`, `off`, `elevenlabs` (v4 A2: needs `ELEVENLABS_API_KEY` and `elevenLabsAgentId`, else 503 on start) |
| callModel | `"gpt-realtime"` | a string up to 120 characters |
| callVoice | `"marin"` | up to 40 characters |
| callTranscribeModel | `"gpt-4o-mini-transcribe"` | up to 120 characters |
| callSystemMode | `"compact"` | `compact`, `full` |
| callMaxMinutes | 20 | 1 to 60 |
| callPricePerMinute | 0.30 | 0 to 100 (the floor of the meter) |
| callPrices | `{ audioInPerMTok: 32, audioOutPerMTok: 64, textInPerMTok: 4, textOutPerMTok: 16 }` | the four keys, each 0 to 100000, nothing else |
| elevenLabsAgentId | `""` | up to 120 characters (v4 A2: the Conversational AI agent with overrides enabled) |
| elevenLabsCallPricePerMinute | 0.10 | 0 to 100 (v4 A2: the floor of the meter on an ElevenLabs call; 0 refuses the start) |
| videoProvider | `"runway"` | `runway`, `stub`, `off` (no key: reports not configured) |
| videoModel | `"gen4_turbo"` | up to 60 characters |
| videoSeconds | 5 | 5 or 10 |
| videoRatio | `"720:1280"` | `\d{3,4}:\d{3,4}` |
| videoCostUsd | 0.25 | 0 to 100 (above 0 on Runway) |
| textureCuesEnabled | true | boolean |
| typoCueShare | 0 | 0 to 0.3 (his switch) |
| tastingEnabled | false | boolean (the tasting performer must be priced first) |
| tastingProvider | `"openai"` | a text provider name |
| tastingModel | `"gpt-4.1"` | up to 200 characters |
| tastingDailyCapUsd | 1 | 0 to 1000 |
| finetuneMinExamples | 200 | 10 to 5000 |
| finetuneSystemMode | `"compact"` | `compact`, `full` |
| texterModel | `""` | up to 200 characters (written by `/use`) |
| texterPrevious | null | null or `{ provider, model }` (written by `/use`, read by `/revert`; not in the panel) |

`prices` gains `gpt-4.1` (2 / 8), `gpt-4.1-mini` (0.4 / 1.6) and `gpt-4.1-mini-2025-04-14` (0.4 / 1.6).

## Settings added in v3.1 (what he looks like, JJ)

| Key | Default | Accepted |
|---|---|---|
| hisLookText | `""` | a string, at most 600 characters after cleaning (em and en dashes become " -- ", the ellipsis character "..."); `PUT /api/him/look` writes it too |
| hisFaceMax | 3 | 1 to 3 (photos of him on file, and how many ride along) |
| hisFaceInTogether | true | boolean (the photos on every Together turn) |
| hisFaceApartEvery | 8 | 0 to 50 (Apart mode: every N of her replies; 0 = only his first turn of a conversation) |

A database seeded before these keys existed reads them as the defaults; the deploy session inserts the four rows with INSERT OR IGNORE. Migration `0007_his_face.sql` adds `conversations.his_face_seq` (nullable; the Worker tolerates its absence: a failed cadence read counts as "just shown", so without the column the Apart cadence waits and the photos ride only on his first turn, on Together turns and on a mention of his looks). Apply it remotely before the deploy.

## Secrets added in v3 (optional)

| Secret | Used by |
|---|---|
| RUNWAY_API_KEY | clips (`videoProvider: "runway"`) and, since 2026-09-25, photos and portraits (`imageProvider: "runway"`); without it every clip control is hidden, clip generate answers 503, and a photo on the runway provider answers 503 `provider_not_configured` (detail `runway`) with the request row left failed and retryable. On the Mac: `pbpaste \| npx wrangler secret put RUNWAY_API_KEY` from the clipboard, or `security find-generic-password -s runwayml -w \| npx wrangler secret put RUNWAY_API_KEY` when the keychain item exists. |

`OPENAI_API_KEY` now also serves calls (the realtime token), portraits (text-to-image) and the fine-tuned texter. The key used for training never becomes a Worker concern: `scripts/finetune_run.mjs` reads it from the environment or the clipboard on the Mac and clears the clipboard.

## Cron (unchanged triggers)

No new trigger. The 07:00 UTC daily handler runs the backup and then the maintenance pass (`src/maintenance.ts`): weather cache rows older than a day deleted, open asks older than `askLetGoDays` let go, pending tastings older than 30 minutes expired, calls with no tick for two minutes expired. Each change is audited; a failure there is logged by class and never stops the backup.

## Settings added in v4 (SPEC_V4 "Settings added" and amendments A1 to A3)

| Key | Default | Accepted |
|---|---|---|
| avatarAssetId | `"master-05"` | `^master-0[0-5]$` (his pick on the Images page; `GET /api/avatar` reads it) |
| callFaceProvider | `"clips"` | `clips`, `off`, `lipsync` (reserved: 503 `reserved_v4_1` on make, `ready: false`) |
| callFaceSourceAssetId | `"master-00"` | `^master-0[0-5]$` (the tight face crop keeps the whole face in a square) |
| hisFaceInPhotos | `true` | boolean (his reference photo may ride into a picture her line puts him in) |
| spotifyEnabled | `false` | boolean (the callback sets it true, disconnect false; his switch too) |
| spotifyPlaylistId | `""` | `^[A-Za-z0-9]{0,62}$` (written by the app; editable) |
| spotifyPlaylistName | `"songs from avelie"` | 1 to 100 characters (used at creation) |
| placeCostUsd | 0.08 | 0 to 100; above 0 unless the image provider is keyless (`assertSettingsConsistent`) |
| listeningLineEnabled | `true` | boolean (one small paid line a day on the phone panel) |
| spotifyPlayer | `"sdk"` | `sdk`, `embed`, `off` (A1: the Web Playback SDK device, the embed fallback, or no player) |
| elevenLabsModel | `"eleven_multilingual_v2"` | a string, at most 60 characters (A2) |
| elevenLabsTtsPricePer1kChars | 0.3 | 0 to 100 (A2: her voice notes on ElevenLabs, through the caps) |
| videoMarkerEnabled | `true` | boolean (A3: her `[clip:]` line makes a clip; off strips it with `clip_unavailable`) |

Migration `0008_v4.sql` (additive, applied remotely BEFORE the deploy): the `places`, `spotify_auth` and `panel_cache` tables, `idx_places_title_norm`, the columns `visual_assets.with_him` (NOT NULL DEFAULT 0), `messages.spotify_status` and `messages.pushed_at`, and `INSERT OR IGNORE` rows for the thirteen keys (the nine of the spec table and the amendment's four: `spotifyPlayer`, `elevenLabsModel`, `elevenLabsTtsPricePer1kChars`, `videoMarkerEnabled`; the integrator added the four so `npm run db:remote` is the whole settings step); a stored table without a key would read it as the default (`DEFAULT_SETTINGS`) either way.

## Secrets added in v4 (optional)

| Secret | Used by |
|---|---|
| SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET | the Spotify connect flow (a confidential client; the Worker exchanges the code and refreshes the token). Without both, every Spotify route answers 503 `provider_not_configured` and `spotify_status` is `off`. On the Mac: `pbpaste \| npx wrangler secret put SPOTIFY_CLIENT_ID`, then the secret the same way, `printf '' \| pbcopy` after each. Locally `SPOTIFY_STUB=1` (with `ACCESS_AUD` empty) drives the stub instead |
| VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY | still optional; `node scripts/gen_vapid.mjs --apply` from the deploy session sets both without showing the private key; until then the phone notification is skipped and "Get her texts on this phone" turns her first texts on without it |
| ELEVENLABS_API_KEY | her voice notes and calls on ElevenLabs (A2; docs/ELEVENLABS.md) |

The Spotify tokens live in `spotify_auth` only: never in a response body, an audit row, a log line, the export, the character package or the browser; `GET /api/spotify/token` hands the page the short-lived access token and nothing else.

## Cron (v4)

No new trigger. The `*/20 * * * *` handler runs `pushDueReplies` (one notification for the delayed replies that landed since the last tick and were held two minutes or more; every seen row stamped) and then `maybeTextFirst`, and returns both results. The other three are unchanged.
