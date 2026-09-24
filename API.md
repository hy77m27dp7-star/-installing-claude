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
| GET | /api/conversations/:id/messages | `?channel=story|operator` | `MessageRow[]` (asc) |
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
| PUT | /api/settings | partial `Settings` | `Settings` (validated: provider in set, effort in set, 0<=temperature<=2, 64<=maxTokens<=4000, caps >= 0; `model` and `proposalModel` must have an entry in `prices` (the stored table over the built-in one), and `imageCostUsd` must be above 0 unless `imageProvider` is keyless (`stub`); otherwise 400 `validation`) |
| GET | /api/usage | | `{ todayUsd, monthUsd, dailyCapUsd, monthlyCapUsd, byDay: [...] }` |
| GET | /api/audit | `?limit=100` | `audit_events[]` (desc) |

## Images

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /api/assets | | `{ masters, candidates, scenes, rejected, archive }` (VisualAssetRow lists) |
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
| herFirstTextsPerDay | 10 | 0 to 10 (0 = off) |
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
