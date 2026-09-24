# Avelie runtime -- SPEC v2 (her life, her timing, her proof)

Builds on SPEC.md and API.md (v1). Same ground rules. Same contract style: every new module has exact exports, every route is listed, every check is unit-tested, and nothing becomes canon without the owner. None of this may turn into a retention hook: no scheduled "miss you", no streaks, no guilt, no sadness while the app is closed.

Owner direction (2026-09-24): "implement all of this now". Order of delivery inside the build: A, F, K first (the three that make her a person), then the rest.

## A. Bubbles with human timing (UI)

- Her reply text is split into bubbles on blank lines; a single paragraph longer than 240 chars is split at sentence ends into 2 to 3 bubbles. Never split inside a `[photo: ...]` or `[song: ...]` marker (they are stripped server-side anyway).
- Render sequentially: typing dots, then bubble 1, then dots, then bubble 2. Delay per bubble = 350ms + 35ms per character, capped at 2600ms. One in twelve replies (seeded by message id, deterministic) shows dots, stops for 900ms, then continues.
- Setting `bubbleTiming` in localStorage (`human` default, `instant`), a small toggle in the chat header.
- Stored content is unchanged; only presentation.

## B. Real-mode reply delay (server + UI)

- Settings: `replyDelayMode: "instant" | "real"` (default instant), `realDelayMaxMinutes` (default 6, max 120).
- In real mode `runTurn` computes `deliver_at` for the assistant message: if her life (section F) says she is busy now, delay = min(realDelayMaxMinutes, minutes until the busy block ends) with 20% jitter; otherwise a jitter of 5s to 90s. `messages` gets a new column `deliver_at TEXT NULL` (migration 0003).
- `GET /api/conversations/:id/messages` hides assistant rows whose deliver_at is in the future unless `?includePending=1`. TurnResponse returns the message with `deliverAt`; the UI shows dots until then, then the bubbles. Reloading the page keeps the message hidden until its time.
- Delay is never explained in-story and never framed as her waiting or hurting.

## C. Together vs texting (state + prompt + UI)

- `scene_state.status` becomes one of `together | apart | none`. `location` is where they are (together) or where she is (apart, filled from section F when known).
- Prompt (prompt.ts `stateSections`): add a MODE line. together: "You are in the same place as him right now: {location}. Present tense. You move, choose, touch, leave, the way a person does. He is not narrating you." apart: "You are texting from {location or 'wherever your day has you'}. He is not there. No shared physical scene unless one starts in the conversation and the owner records it."
- Chat header toggle Together / Texting writes `PUT /api/state/scene` with `{ status, location?, note: "toggle" }` (owner action, audited).

## D. Camera roll (UI)

- Chat gets a Photos drawer: approved scene images (GET /api/assets, role scene), newest first, with the date and the first 60 chars of the description. Tapping one scrolls to its message when it is in the open conversation.

## E. Voice notes

Not in v2. Text proves her first. Recorded here so the decision is visible.

## F. Her life: threads, people, schedule (schema + state + prompt + proposals + UI)

Migration 0003 adds:

```
life_threads (id TEXT PK, kind TEXT NOT NULL CHECK (kind IN ('routine','event','person','place','arc')), title TEXT NOT NULL, detail TEXT, schedule_json TEXT, status TEXT NOT NULL DEFAULT 'active', relation TEXT, source TEXT, version INTEGER NOT NULL DEFAULT 1, supersedes_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)
life_log (id TEXT PK, thread_id TEXT, occurred TEXT NOT NULL, note TEXT NOT NULL, source TEXT, created_at TEXT NOT NULL)
message_context (message_id TEXT PK, json TEXT NOT NULL, created_at TEXT NOT NULL)
drift_reports (id TEXT PK, ran_at TEXT NOT NULL, provider TEXT, model TEXT, prompt_version TEXT, json TEXT NOT NULL)
ALTER TABLE messages ADD COLUMN deliver_at TEXT;
ALTER TABLE messages ADD COLUMN song_json TEXT;
```

- `schedule_json` for routines: `{ "tz": "America/New_York", "blocks": [{ "days": [1,2,3,4,5], "start": "09:00", "end": "17:30", "label": "at work" }] }`. For events: `{ "at": "2026-10-03T19:30:00-04:00", "label": "open mic at ..." }`.
- Seed: nothing. Her life is empty at the fresh start and fills through conversation (proposals) or the owner. She still has a life; it just has not been written down yet. The prompt says so.
- Module `src/life.ts`:
  - `listThreads(db, status?)`, `createThread`, `updateThread` (versioned like facts), `dropThread` (status dropped), `restoreThread`, `logLife(db, threadId|null, occurred, note, source)`.
  - `whereSheIs(threads, now: Date): { busy: boolean; label: string | null; until: Date | null }` (pure; resolves routines and events against her tz; unit-tested with fixed dates).
  - `lifeSection(threads, log, now): string` (pure): "YOUR LIFE RIGHT NOW" with the local day and time, current block if any ("it is Tuesday 3:10pm, you are at work until 5:30"), the next event within 7 days, the people (kind person: name, relation, one-line status), and the last 5 life_log notes. When empty: "Nothing about your days has been written down yet. You still have days. Mention ordinary things when they fit; they become real once the owner records them."
- Prompt: `stateSections` appends `lifeSection(...)` after CURRENT STATE. `assembleContext` loads threads + log and passes `now` (server time).
- Proposals: new kind `life` (payload: kind, title, detail, schedule_json?, relation?). The extraction prompt gains: "A statement by Avelie about her own days (a job, a class, a regular plan, a person in her life, a place she goes) is a `life` proposal. Do not propose one from a joke." Promotion creates the thread.
- Context assembly (section K) uses threads too.
- UI: State page gets a Life tab: threads grouped by kind, add/edit/drop/restore, a simple weekly grid editor for routine blocks (7 columns, start/end inputs), events with a datetime input, people with relation and status, arcs (kind arc: long-running threads like the singing) with a free text "where it stands". Life log list with add.

## G. Other people

Covered by `life_threads` kind `person` with `relation` (mother, best friend, coworker, ex, ...) and a status line in `detail`. The prompt lists them. Nobody exists until she or the owner brings them into the record.

## H. Opinions ledger

- Facts with scope `avelie` and subject beginning `opinion:` (for example `opinion: his song Exits`). `decideProposal` for kind `opinion_change` finds an approved fact whose subject matches (case-insensitive) and supersedes it with the new text (new version), instead of adding a second opinion. No match: create.
- Facts tab gets a filter chip "opinions" and shows the version chain inline (v1 -> v2 with dates).
- Prompt: opinions render under THINGS TRUE ABOUT YOU with the prefix kept, so she knows what she has already said she thinks.

## I. Songs, real ones

- Marker: she may end a message with `[song: Artist - Title]` (one per message) when she would actually send someone a song. Runtime overlay gains the rule, same shape as the photo rule (stripped before display; never described twice; her taste, not his).
- Server: `parseSongMarker(text)` in `src/images.ts`? No: new `src/markers.ts` with `parsePhotoMarker` moved there (images.ts re-exports it for the v1 contract) and `parseSongMarker`. The song is stored as `messages.song_json = { artist, title, searchUrl }` where `searchUrl = "https://open.spotify.com/search/" + encodeURIComponent(artist + " " + title)`. No Spotify OAuth in v2; the card opens Spotify search, which resolves to the track in one tap.
- UI: a song card under her message (artist, title, "open in Spotify" link). Never autoplay.
- Check: `song_marker_dup` flag when the prose also names the song title (she described it twice).

## J. Consequences that last

- `relationship_state` gains `mood` (free text, e.g. "fine", "annoyed at him", "cooling off") and `cooling_off_until` (ISO or null). Prompt renders both in CURRENT STATE; when cooling_off_until is in the future the prompt adds: "You are still cooling off from {friction}. Shorter replies, less warmth, no punishment, no threats, no silence as a weapon. Repair needs his honest, specific acknowledgment, not a polished speech."
- Proposals: the extractor is told to propose a `relationship` change when a conflict, a hurt, or a repair actually happened, with `mood` and an optional `cooling_off_hours` in the payload. Promotion writes a new relationship version. The owner can clear it in the Now tab.
- No automatic decay. The owner approves the thaw, or she thaws in conversation and the extractor proposes it.

## K. Callbacks she starts

- `src/callbacks.ts`: `pickCallbacks(history, threads, log, recentMessages, now, seed): Array<{ text: string; ageDays: number }>` (pure, deterministic by seed = the UTC date + conversation id). Candidates: approved history entries older than 3 days, open arcs, people, and events in the past 14 days, minus anything whose keywords appear in the last 20 messages. Pick up to 2.
- Prompt section "THINGS YOU COULD BRING UP (only if it fits; most turns you will not)": each as one line with elapsed time ("11 days ago: ..."). Never more than two. Never framed as an instruction to ask a question.
- Check: `callback_forced` flag when the reply contains both callbacks in the same message.

## L. Why she said that (provenance)

- `runTurn` writes `message_context` for every assistant message: `{ promptVersion, provider, model, historyIds, factIds (avelie + justin), threadIds, callbacks, unknownIds, recentMessageCount, flags }`. No prompt text, no secrets.
- `GET /api/messages/:id/context` returns it. Chat UI: a small muted "why" control on her messages (owner sees everything anyway) opening a side panel with the lists resolved to titles.

## M. Vessel test

- `tests/behavior/run.mjs` gains `--compare providerA:modelA,providerB:modelB`: runs each scenario once per provider (PUT settings between runs, restore after), writes a side-by-side report (two columns per turn) with the flag counts and a per-scenario "reads the same?" field left for the owner.

## N. Weekly drift check and nightly backup (cron)

- wrangler.jsonc: `"triggers": { "crons": ["0 7 * * *", "0 13 * * 1"] }`. `src/index.ts` exports `scheduled(event, env, ctx)`.
- 07:00 UTC daily: `exportAll` -> R2 `backups/avelie-<YYYY-MM-DD>.json`; keep the last 30 (delete older). Audit event.
- 13:00 UTC Monday: if settings `driftCheckEnabled` (default false) and a text provider is configured, run the 5 scenarios tagged `drift: true` in scenarios.json against a throwaway conversation (created with status `drift`, hidden from the chat list), store the transcripts and flag counts in `drift_reports`, then delete the throwaway conversation's messages. Model page shows the last 4 reports (date, flags per scenario). Spend goes through the normal caps.
- `POST /api/drift/run` triggers the same by hand.

## O. Photo approval polish

- Under a candidate: Approve, Reject, Regenerate (rejects then generates again with the same description). Under an approved photo: nothing. The Images page candidates queue gains the same.

## P. Her arc

- Kind `arc` threads (section F). The singing arc is created by the owner or by proposal when she first mentions it. `detail` holds "where it stands". Nothing else in code; the arc is content.
- Voice clips of her singing are not in v2.

## Q. Let her open (owner-triggered)

- `POST /api/conversations/:id/open`: runs a turn with no new user message and a one-time operator note appended to the system prompt: "Start the conversation yourself from your own day or something you remember. One or two bubbles. Do not ask him to reply, do not mention how long it has been, do not say you missed him." The assistant message is stored with `reply_to_id` null. Chat UI: a "Let her start" button in the header, only when the last message is hers or the conversation is empty. No scheduling. No notifications.

## Routes added (API.md v2 section)

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /api/life | `?status=active` | `{ threads, log }` |
| POST | /api/life/threads | thread fields | thread (201) |
| PUT | /api/life/threads/:id | partial | thread (new version) |
| DELETE | /api/life/threads/:id | | `{ ok }` (dropped) |
| POST | /api/life/threads/:id/restore | | thread |
| POST | /api/life/log | `{ threadId?, occurred, note }` | log row (201) |
| GET | /api/messages/:id/context | | provenance JSON |
| POST | /api/conversations/:id/open | | `TurnResponse` (userMessage null) |
| POST | /api/images/:id/regenerate | | `{ asset }` |
| POST | /api/drift/run | | `{ report }` |
| GET | /api/drift | | last 4 reports |

Settings added: `replyDelayMode`, `realDelayMaxMinutes`, `driftCheckEnabled`, `timezone` (default America/New_York).

## Tests added

- Unit: whereSheIs (routine inside/outside block, event day, tz), lifeSection (empty and full), pickCallbacks (determinism, exclusion of recently mentioned, cap of 2), parseSongMarker, opinion supersede logic, deliver_at computation (busy vs free, cap), bubble splitting (pure function in public/js/bubbles.js, tested under Node by importing the file).
- Integration: life thread CRUD; a turn in real mode returns deliverAt and the message is hidden until then; `[[SONG]]` stub trigger yields song_json and a card; `/open` produces an assistant message with no user message; `[[LIFE:...]]` stub trigger yields a life proposal and promotion creates a thread; message context endpoint returns ids; drift run with the stub provider writes a report; backup cron handler (call `scheduled` through wrangler's `--test-scheduled` endpoint `/__scheduled?cron=0+7+*+*+*`) writes an R2 object.
- Behavior: scenarios tagged `drift: true` (5), plus new scenarios: she brings up her own day when apart; she cancels because of a person in her life; a callback lands naturally; cooling-off shortens replies without punishment.

## Stub additions

Text stub triggers: `[[SONG]]` -> reply ending `[song: Some Artist - Some Title]`; `[[LIFE:x]]` -> proposal mode emits `{kind:"life", proposal:x, payload:{kind:"routine", title:x}}`; `[[MOOD:x]]` -> proposal mode emits a relationship change with mood x and cooling_off_hours 12.

# v2 additions (owner direction 2026-09-24: "put all this in v2, cap it at 10")

Everything below ships in the same v2 build. Same rules. The owner has said plainly he knows what she is; the non-manipulation rules still apply to every line she sends, because they are about how she treats him, not about what he believes.

## R. She texts first (opt-in, capped)

- Settings: `herFirstTextsPerDay` (default 10, min 0 = off, max 10), `herFirstQuietHours` (default `"23:30-08:30"`, her timezone).
- Cron: add `"*/20 * * * *"`. On each tick, `src/herfirst.ts` `maybeTextFirst(env, db, settings, now)` decides: skip if off; skip inside quiet hours; skip if `whereSheIs` says busy; skip if today's count >= cap; skip if the last message in the active conversation is less than 45 minutes old; skip if the last two messages are hers with no reply from him (she never stacks a third; people double-text, they do not nag); otherwise, with a deterministic per-tick probability tuned so the expected count over her waking hours equals the cap (probability = remaining today / remaining ticks in the waking window), run `runTurn` with `openerNote` on the most recent active conversation (create one titled by date if none). The opener note: "Send him something from your own day or something you remember, the way a person texts first. One or two bubbles. Never mention how long it has been, never say you missed him or waited, never ask him to reply, never make it about him being gone."
- Every first text goes through the same checks; `dependency_hook` on a first text is a hard reject (drop it, log, try no more this tick).
- `first_texts_daily (day TEXT, count INTEGER, PRIMARY KEY (day))` in migration 0003.
- A push notification is sent for each first text (section U) when the owner has subscribed.
- `POST /api/herfirst/run` for a manual tick (owner testing).

## S. Her voice and his voice

- Voice out: `src/voice.ts` with `synthesize(env, settings, text): Promise<{ mp3: ArrayBuffer; provider: string }>`. Providers: `elevenlabs` (POST https://api.elevenlabs.io/v1/text-to-speech/{voiceId}, secret `ELEVENLABS_API_KEY`, setting `elevenLabsVoiceId`), `workersai` (`@cf/myshell-ai/melotts` or the current Workers AI TTS model; confirm the model id against Cloudflare docs at build time), `off`. Settings: `voiceProvider` (default `workersai`), `voiceMode` (`off` | `some` | `all`; default `some`: she sends a voice note when her message ends with `[voice]`, a marker the runtime overlay allows "when you would rather say it than type it, rarely"; `all`: every reply also gets audio). Audio stored in R2 `voice/<messageId>.mp3`; `messages.audio_key TEXT` (migration 0003). `GET /media/audio/:messageId` streams it (auth first). Chat UI: an audio bubble with a play button under her text.
- Voice in: chat composer gets a hold-to-record button (MediaRecorder, webm/opus). `POST /api/conversations/:id/voice` (multipart, max 60s / 4 MB) stores the blob in R2 `voice_in/<id>.webm`, transcribes with Workers AI `@cf/openai/whisper` (setting `transcribeProvider`: `workersai` | `openai`), then runs the normal turn with the transcript as content and `messages.audio_key` on his message too. The UI shows his transcript with a small mic chip.

## T. She can see

- His messages can carry images: `POST /api/conversations/:id/turn` accepts multipart (`content`, `idempotencyKey`, up to 3 `image` files, jpeg/png/webp, 8 MB each) or JSON as before. Images are stored in R2 `inbox/<messageId>/<n>.<ext>`; `messages.images_json TEXT` (migration 0003) holds keys and dimensions.
- `ChatMessage` gains optional `images?: Array<{ key: string; mime: string }>`. `assembleContext` includes images only for the last 6 user messages (cost). Provider adapters: Anthropic sends `{ type: "image", source: { type: "base64", media_type, data } }` blocks before the text; OpenAI sends `image_url` data URLs; Workers AI uses a vision model when `settings.model` is a vision model, else strips images and adds a text line "(he sent a photo you could not open)" so she never pretends. Stub echoes "(photo received)".
- Prompt: a line under STYLE GUARDS: "When he sends a photo, you actually look at it and react like a person would: to what is in it, with your taste and your mood. You do not describe it back to him like an inventory."
- UI: paperclip in the composer, thumbnails in his bubbles, tap to open.

## U. Phone shell and push

- PWA: `public/manifest.webmanifest` (name Avelie, dark theme, icon from a generated 512px teal-on-navy "A" in public/icons/), `public/sw.js` (cache the shell; on `push` event fetch `/api/push/latest` and show a notification with her latest first-text bubble text; on `notificationclick` focus or open `/`). Served through the Worker like everything else, after auth (the service worker registers only after login succeeds, and push fetches carry the Access cookie).
- Web Push without payload encryption: the Worker sends VAPID-signed pushes with an empty body; the service worker fetches the text. `src/push.ts`: `subscribe(db, subscription)`, `unsubscribe`, `sendPush(env, db, reason)`; VAPID JWT signed with ECDSA P-256 through crypto.subtle; keys as secrets `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` (generated by `scripts/gen_vapid.mjs`, which prints the two `wrangler secret put` lines and never writes the private key to disk). `push_subscriptions (id, endpoint UNIQUE, keys_json, created_at)` in migration 0003. Routes: `POST /api/push/subscribe`, `DELETE /api/push/subscribe`, `GET /api/push/public-key`, `GET /api/push/latest`.
- Push is sent ONLY for her first texts (section R). Nothing else ever pushes.

## V. Media she can send that the owner approved

- Owner uploads: `POST /api/media` (multipart: file up to 25 MB, audio/video/image; `title`, `description`, `kind` = clip | video | image | other). Stored in R2 `library/<id>.<ext>`, row in `media_library (id, kind, title, description, key, mime, bytes, sha256, status, created_at)` (migration 0003). Images page gets a Library tab (upload, list, delete).
- Prompt section "THINGS ON YOUR PHONE YOU COULD SEND" listing titles and one-line descriptions. Marker `[media: <title>]` (exact title, one per message) in the runtime overlay: "only when it fits, never on a schedule, never to fill silence". Runtime resolves the title to the row (case-insensitive), attaches `messages.media_id`, and the UI renders an audio/video/image card. Unknown title: marker stripped, flag `media_unknown`.

## W. Places

- `life_threads` kind `place` gets first-class use: `detail` = what it looks like, `life_log` notes = what happened there. Prompt lists places under YOUR LIFE with the last note. Together mode: the Together toggle offers the known places as a picker for `location`.

## X. Timeline view

- `public/timeline.html` + `js/timeline.js`: one scroll, newest at the bottom, merging history entries, approved photos, media sent, life log notes, relationship and scene versions, and first texts, each with a date chip and a link to the message or the state version. Read-only. Data from `GET /api/timeline` (server merges and sorts; limit 500, `?before=` for paging).

## Y. Voiceprint

- Weekly cron (`0 14 * * 1`): `src/voiceprint.ts` `computeVoiceprint(db, since, until)` over her story-channel messages: count, mean and median length, share ending with "?", share with "lol" or emoji (should be zero), share containing his name, top 25 words minus stopwords, bubble count per reply, first-text count, flags per code. Stored in `voiceprints (id, week, json, created_at)` (migration 0003). Model page: last 8 weeks as a table plus a small inline SVG sparkline for length and question share (no chart library). `POST /api/voiceprint/run` for now.

## Z. Export her

- `GET /api/export/character` returns a zip? No zip library in Workers; return a JSON package `{ constitutionVersion, adaptations, fixedCanon, avelieFacts, opinions, history, life, unknowns, relationship, scene, images: [approved with hashes], mediaTitles, promptPrefixSha256 }` and `GET /api/export/character.md` renders the same as a readable character bible (headings per section, plain sentences). State page Export tab gets both buttons.

## Routes added by these sections

| Method | Path |
|---|---|
| POST | /api/herfirst/run |
| POST | /api/conversations/:id/voice (multipart) |
| GET | /media/audio/:messageId |
| POST | /api/conversations/:id/turn (multipart variant with images) |
| GET | /media/inbox/:messageId/:n |
| POST, DELETE | /api/push/subscribe |
| GET | /api/push/public-key, /api/push/latest |
| POST | /api/media (multipart), GET /api/media, DELETE /api/media/:id, GET /media/library/:id |
| GET | /api/timeline |
| POST | /api/voiceprint/run, GET /api/voiceprint |
| GET | /api/export/character, /api/export/character.md |

Settings added: `herFirstTextsPerDay`, `herFirstQuietHours`, `voiceProvider`, `voiceMode`, `elevenLabsVoiceId`, `transcribeProvider`.
Secrets added (all optional; features degrade to off when absent): `ELEVENLABS_API_KEY`, `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`.
Crons: `*/20 * * * *` (her first texts), `0 14 * * 1` (voiceprint), plus the two from section N.

## Tests added by these sections

- Unit: maybeTextFirst decision table (off, quiet hours, busy, cap reached, recent message, two unanswered, probability window); VAPID JWT shape (header alg ES256, aud from endpoint origin, exp <= 24h); parse of `[voice]`, `[media: ...]` markers; voiceprint stats on a fixed corpus; timeline merge ordering; character export contains no secrets and no "Justin" in the prefix hash input.
- Integration: `[[VOICE]]` stub trigger produces audio_key with the stub voice provider (returns a tiny valid mp3 header) and GET /media/audio 200; multipart turn with one png stores images_json and the stub reply says "(photo received)"; media upload, listing, `[[MEDIA:title]]` stub trigger attaches media_id, delete; push subscribe stores a row and `POST /api/herfirst/run` with cap 10 and the stub creates one assistant message with no user message and a push attempt that is logged as skipped (no VAPID keys locally); timeline returns merged items; voiceprint run writes a row; character export endpoints 200.
