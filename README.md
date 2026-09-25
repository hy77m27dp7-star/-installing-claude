# Avelie runtime

Avelie is a private, single-owner character runtime that runs inside your own Cloudflare account. Her rules live in versioned code, her memory lives in a D1 database, and the model behind her is a replaceable performer reached through a provider adapter. Nothing she says becomes canon until you approve it.

## What you need

- A Cloudflare account on the Workers Paid plan (5 USD a month). D1, R2 and Zero Trust Access stay within their free tiers for this app's own traffic, but a photo runs several megabytes of image data through the Worker, and the Free plan's 10 ms of CPU per request is not enough for that. Text alone works on Free; photos do not.
- One email address. It is the only identity the app accepts. It is set as OWNER_EMAIL in wrangler.jsonc.
- An Anthropic API key for her text. Claude Opus 5 is the default model.
- A Runway API key for her photos (`RUNWAY_API_KEY`, since 2026-09-25): photos use Runway's Gen-4 Image (`gen4_image`) with the three strongest master images as tagged character references (the tight face crop first). An OpenAI API key stays the fallback (`imageProvider: "openai"`, gpt-image-1 with the same references). Without the key of the selected provider she still talks; a photo line in her reply fails quietly and the message shows a failed photo instead of a picture.
- Optional, v2: an ElevenLabs API key if you want her voice notes from ElevenLabs instead of Cloudflare's own voice (the default needs no key), and a VAPID key pair (made by `node scripts/gen_vapid.mjs`, no account needed) if you want a phone notification when she texts first. Without them those two features stay off and everything else works.
- Optional, v3: a Runway API key if you want short clips of her (`RUNWAY_API_KEY`; without it the clip controls stay hidden). Calls, portraits and the fine-tuned texter all use the OpenAI key you already have. The weather needs no key (Open-Meteo).

## Run it on your machine

1. Run `npm install`.
2. Run `cp .dev.vars.example .dev.vars`.
3. Run `npm run build:canon`.
4. Run `npm run db:local`.
5. Run `npm run dev`.
6. Open http://127.0.0.1:8787 in a browser.

Step 2 is not optional: `wrangler.jsonc` carries the production Access tag and `APP_ENV=production`, and `.dev.vars.example` sets `ACCESS_AUD=` and `APP_ENV=development` so the local actor rule can apply. Without a `.dev.vars`, `npm run dev` answers 503 to every request.

Out of the box `.dev.vars` names the stub providers, so the local app needs no keys and spends no money. The stub answers with short lines and hands back one of the master images when she "sends a photo", so you can see the whole photo flow (pending, ready, approve, reject) without paying. One thing to know: the stub returns the same bytes every time, so once you reject a stub photo its hash is on the local blacklist and later stub photos are refused as blacklisted. That is the blacklist working. Approve stub photos instead, or delete `.wrangler/state` and run `npm run db:local` to start the local database over.

To talk to the real models on your machine, edit `.dev.vars`: paste the two keys, then either delete the two DEFAULT_ lines or set `DEFAULT_PROVIDER=anthropic` and `DEFAULT_IMAGE_PROVIDER=openai`. While a DEFAULT_ line is present it overrides the Model page locally. Never commit `.dev.vars`; it is in `.gitignore`.

To run one of the cron jobs by hand on your machine: start the app with `npx wrangler dev --port 8787 --var ACCESS_AUD: --test-scheduled`, then open `http://127.0.0.1:8787/__scheduled?cron=0+7+*+*+*` (the backup), `?cron=0+13+*+*+1` (the drift check), `?cron=*/20+*+*+*+*` (her first texts) or `?cron=0+14+*+*+1` (the voiceprint).

## Tests

- `npm test` builds the canon and the voice-bank seed, checks typography, checks the master image hashes, typechecks, and runs the unit tests. No keys, no network. The v2 units cover where she is on a fixed clock, the life section, the callback picker, the song marker, the opinion supersede, the delivery delay, the bubble splitter, the first-text decision table, the push token shape, the voiceprint stats, the timeline order and the character export. The v3 units (`*_v3`) cover the voice bank rules and picker, the notes section, the new checks, the memory score and ranking, wants and the fading mood, the grounding lines, the call merge and meter, the clip gate, the shape cue, the tastings ledger, the training export and the Mac script, the v3 prompt order, the two-block cache split, the settings table and the 0005 migration.
- `npm run test:integration` starts `wrangler dev` on port 8790 with the stub providers and drives the API end to end: a turn, a replayed turn, a failed model call, a photo, a rejected photo, export and import, the budget cap, and in v2 the life threads, a real-mode turn that hides her reply until its time, a song card, her opening a conversation, a life proposal becoming a thread, the context of a message, a drift run, the backup cron, a voice note, a photo sent to her, the media library, a first text, the timeline, the voiceprint and the character export; and in v3 the voice bank from seed to exemplars in the prompt, a correction and its bank line, memory fading and reminding, wants and asks through proposals, the fading mood, the stub weather and grounding log, a stub call from start to transcript, a stub clip with Range serving, the shape cue and its flags, a blind tasting from turn to pick, marks and the training export, and the nightly maintenance.
- `npm run finetune:run <file.jsonl>` is the Mac-side fine-tune script (v3): validate the export, estimate the cost, ask for the word `train`, upload, start and poll. It reads the key from the clipboard and clears it; it never writes or prints it.
- `npm run behavior` runs the scenario suite against a running app and writes `reports/behavior_<stamp>.md`. Read docs/BEHAVIOR.md before running it against a real model, because it spends money. `--compare anthropic:claude-opus-5,openai:gpt-5` runs every scenario once per performer and writes them side by side (the vessel test).

## The screens

- Chat: talk to her. Her reply arrives as bubbles with human timing (the Human timing switch in the header turns that off). Her photos appear under her messages with Approve, Reject and Regenerate. A song she sends shows as a card with an Open in Spotify link. A voice note shows as a play button under her text. The paperclip sends her up to three photos; the mic button records a voice message (hold to talk). Together / Texting sets whether you are in the same place or apart. Let her start asks her to open the conversation herself. The Photos button opens the camera roll of approved pictures. The why control on her message shows what the turn was built from. The Operator toggle turns the composer amber and sends your question to the technical channel instead of to her. v3: Call rings her (the call sheet with captions, Mute and End; the transcript lands in the thread as a card); Taste sends the same message to two performers and shows Left and Right blind until you pick; under each of her messages a Note control (what sounded off, and your version, which can go straight into her voice bank) and a Keep / Drop toggle for the training set.
- State: what is true right now. Now (relationship and scene, plus her mood, how many days it lingers, the phase chip and Clear mood), Life (her routines, events, people with their faces, places and arcs, with a weekly grid for routine blocks, the Today list of what she ate, wore and ran out for, and the life log), History, Facts (with an Opinions filter, each opinion's version chain, and a weight select), Unknowns, Inbox (the proposal queue, now including life, mood, want, ask, grounding and life-update proposals), Voice (the bank: approve or reject a line, a selection, a tag, or all of them; edit; add your own), Notes (the corrections ledger), Memory (weight, last touched, score and a Remind her button per row; the recalls list), Wants (her wants with progress, setbacks and asks), Rulebook, Export (the full JSON, the Character JSON and the Character bible) and Import.
- Model: provider, model, effort, max tokens; Timing (instant or real reply delay, its cap in minutes, her timezone); Her first texts (per day, quiet hours, Send one now); Voice (provider, mode, ElevenLabs voice id, transcribe provider); the proposal pass; image settings (now with the clip settings); the two spending caps and the Weekly drift check switch; Notifications; the last four drift reports with Run now; the last eight voiceprints with Run now; the usage meter. v3 cards: Grounding (her city with a Find button, units, weather provider, the Now line), Calls (provider, model, voice, transcribe model, instructions mode, max minutes, the prices; the reserved ElevenLabs fields), Tastings (Enabled, the second performer, its daily cap, the ledger with Promote), Texter (the readiness meter, Leave him out of the state, Export training set, Export record, the model id and prices, Use, Back to Claude), Memory (the five numbers and the recall switch) and Text (texture cues, typo share).
- Images: the five masters with their hashes and a Verify button, the candidate queue with Approve, Reject and Regenerate, approved scene images, the rejected list, the Library tab (upload a clip, video or image she may send; list; delete), and in v3 the Clips tab (a source, a motion line, Make clip, the player, Approve and Reject) and the Portraits tab (the faces of the people in her life, by person).
- Timeline (timeline.html): one read-only scroll, newest at the bottom, of history entries, approved photos, media she sent, life log notes, relationship and scene versions and her first texts, each with a date chip and a link.

## What v2 adds, one line each

- A. Bubbles: her reply is split on blank lines and long paragraphs at sentence ends, and lands one bubble at a time with typing dots; stored text is unchanged.
- B. Real timing: in real mode her reply carries a delivery time (a busy block in her life delays it up to the cap; otherwise 5 to 90 seconds) and stays hidden until then, even across a reload.
- C. Together or texting: the scene status says whether you are in one place or apart, and the prompt tells her which.
- D. Camera roll: the Photos drawer lists approved pictures newest first and jumps to the message.
- E. Voice notes of her singing: not in v2 (decided, recorded).
- F. Her life: routines, events, people, places and arcs, a log of what happened, all versioned and audited; empty at the fresh start and filled by you or by approved proposals.
- G. Other people: person threads with a relation and a status line; nobody exists until she or you brings them into the record.
- H. Opinions: facts whose subject starts with `opinion:`; a changed mind supersedes the old row instead of sitting beside it.
- I. Songs: she may end a message with `[song: Artist - Title]`; the card opens a Spotify search, no account linking.
- J. Consequences: mood and a cooling-off time on the relationship state, set by you or by an approved proposal, never decaying on their own.
- K. Callbacks: up to two things from the record she could bring up, offered to her each turn, never forced.
- L. Why she said that: every reply stores the ids it was built from; the why control shows them.
- M. Vessel test: `npm run behavior -- --compare` runs the suite on two performers side by side.
- N. Cron: a nightly backup to R2 and an optional weekly drift check on five scenarios.
- O. Photo polish: Regenerate under a candidate; nothing under an approved photo.
- P. Her arc: an arc thread whose detail says where it stands; content, not code.
- Q. Let her open: one button, one turn with no message from you, no schedule.
- R. She texts first: opt-in, capped at 10 a day, quiet hours, never while busy, never a third in a row, never about you being gone.
- S. Voice: her voice notes (Cloudflare's own voice by default, ElevenLabs optional) and your hold-to-record messages, transcribed.
- T. She can see: send her up to three photos with a message; she reacts to what is in them.
- U. Phone shell and push: install to the home screen; a notification only when she texts first.
- V. Media library: clips, videos and images you upload that she may send with `[media: title]`.
- W. Places: place threads with what they look like and what happened there; the Together toggle offers them as the location.
- X. Timeline: the read-only scroll above.
- Y. Voiceprint: a weekly table of how she writes (length, questions, his name, top words, flags) with two small sparklines.
- Z. Export her: the Character JSON and the Character bible, no secrets inside.

## What v3 adds, one line each

- AA. A voice of her own: 150 seed lines drafted from her constitution, unapproved until you approve them; a handful that fit the moment are shown to her each turn as tone, never content; every note you give her ("that's AI", "too clever", your rewrite) is a standing note she reads until you retire it.
- BB. Human memory: every fact, history entry, person and want carries a weight and a last-touched time; small old things fade out of the prompt and come back the moment they are touched; a half-remembered detail is a switch that ships off (`provisionalRecallEvery` 0) until the behavior scenario reads as a person.
- CC. Wants and stakes: things she wants over weeks with progress and setbacks she brings up herself; small asks, once, never a debt; a no she holds; a mood that fades on a clock, never on you.
- DD. Grounding: she lives in Portland, Maine (your call), knows the weather and the time of day, what she is wearing from her last approved photo, what she ate; the people in her life get faces you approve and short arcs that move.
- EE. Calls: she picks up; the call runs in your browser straight to the realtime provider, the Worker only mints the token, meters the minutes from what the session bills, and stores the transcript as messages.
- FF. Clips: short clips of her from a master or an approved photo through Runway, owner-triggered from the Images page, candidates until you approve; off without a key (there is none today).
- GG. Imperfection: she texts like a person, not a writer (one word, a fragment, lowercase, two bubbles, a typo she fixes herself); prompt-driven, never post-processed; the scheduled typo cue ships off (`typoCueShare` 0).
- HH. Tastings: the same turn on two performers, shown blind, you pick, a ledger keeps score, a winner can be promoted with one click.
- II. The texter: every exchange you Keep, every rewrite, every tasting pick is an approved exchange; export them as fine-tuning data, train on the Mac with your own key, paste the model id into the panel; judgment (proposals, checks, the operator) stays on Claude.
- Not in v3, by his word: a day engine. Nothing makes her unavailable, late on purpose or silent. She always answers.

## The cron jobs

Four jobs run inside the Worker on Cloudflare's clock (UTC). They deploy with the Worker; nothing to set up.

| When (UTC) | Eastern | Job |
|---|---|---|
| every day 07:00 | 3am EDT / 2am EST | backup: the full export to R2 `backups/avelie-<YYYY-MM-DD>.json`, the last 30 kept; then the v3 maintenance pass (stale weather cache, asks let go after `askLetGoDays`, tastings expired after 30 minutes, dead calls) |
| Monday 13:00 | 9am EDT / 8am EST | drift check: five scenarios on the current performer, only when the Weekly drift check switch is on |
| every 20 minutes | | her first texts: one decision per tick (off at 0 per day) |
| Monday 14:00 | 10am EDT / 9am EST | voiceprint: the week's numbers |

## Where the backups are

Cloudflare dashboard > R2 Object Storage > `avelie-media` > folder `backups/`. One file per day, `avelie-<YYYY-MM-DD>.json`, the same JSON that State > Export gives and State > Import takes back. Older than the newest 30 are deleted by the job. DEPLOY.md section 15 shows how to download one.

## Where things live

```
src/                the Worker (index.ts entry with fetch and scheduled, auth, api router, chat pipeline,
                    checks, proposals, budget, images, state, export/import, operator, providers/)
                    v2: markers, life, callbacks, provenance, drift, backup, herfirst, push, voice,
                    vision, media, timeline, voiceprint, exportCharacter
                    v3: voicebank, corrections, imperfection, memory, wants, grounding, weather,
                    portraits, maintenance, calls, video, tastings, finetune, providers/runway
src/generated/      constitution.ts, built from canon/ by npm run build:canon; never hand-edit
public/             the pages (index, state, model, images, timeline), css/, js/, images/masters/,
                    icons/, manifest.webmanifest, sw.js
migrations/         0001_init.sql (schema), 0002_seed.sql (generated from canon/seed),
                    0003_messages_seq_unique.sql, 0004_life.sql, 0004b_push.sql, 0004c_voiceprint.sql,
                    0004d_media.sql, 0005_v3.sql (hand-written), 0005b_voicebank_seed.sql (generated
                    from canon/seed/voicebank.json by scripts/build_voicebank.mjs)
canon/              the frozen constitution, the seed JSON, the asset manifest, the reference docs
scripts/            build_constitution, build_seed, build_voicebank, check_typography, verify_assets,
                    check_deploy, gen_vapid, finetune_run (Mac-side)
tests/              unit (node:test), integration (boots wrangler dev), behavior (scenarios + runner)
docs/               COSTS.md, BEHAVIOR.md, ARCHITECTURE.md, workflows/
```

DEPLOY.md is the protected deployment, step by step. HANDOFF.md is the state of the project and what is still yours to decide.
