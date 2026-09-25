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
| POST | /api/calls/start | `{ conversationId }` | 201 `{ call, provider, clientSecret, expiresAt, sdpUrl, model, voice, maxSeconds, tickSeconds }`. The only place the client secret ever appears: not stored, not audited, not logged, not in any later read. 503 `provider_not_configured` when `callProvider` is `off` or the reserved `elevenlabs` (detail `reserved_v3_1`), 409 `call_in_progress` while a call is live anywhere (a live call with no tick for 120 s is expired first), 402 when two minutes at the per-minute price do not fit under the caps. |
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
| callProvider | `"openai"` | `openai`, `stub`, `off`, `elevenlabs` (reserved: 503 on start) |
| callModel | `"gpt-realtime"` | a string up to 120 characters |
| callVoice | `"marin"` | up to 40 characters |
| callTranscribeModel | `"gpt-4o-mini-transcribe"` | up to 120 characters |
| callSystemMode | `"compact"` | `compact`, `full` |
| callMaxMinutes | 20 | 1 to 60 |
| callPricePerMinute | 0.30 | 0 to 100 (the floor of the meter) |
| callPrices | `{ audioInPerMTok: 32, audioOutPerMTok: 64, textInPerMTok: 4, textOutPerMTok: 16 }` | the four keys, each 0 to 100000, nothing else |
| elevenLabsAgentId | `""` | up to 120 characters (reserved) |
| elevenLabsCallPricePerMinute | 0.10 | 0 to 100 (reserved) |
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
