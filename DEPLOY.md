# Deploying Avelie from a Claude Code session on Justin's Mac

This file is for a Claude Code session running ON JUSTIN'S MAC (a local session with his browser, his folders and his logged-in Chrome). A cloud session cannot do this: its network cannot reach Cloudflare's API. Read the whole file, then do it in order. Justin gives ONE "go" before the first deploy (step 6). Never print, log, echo or paste a key. Typography " -- " and "..." only.

## What already happened (do not redo, do not re-verify)

- The code: repository hy77m27dp7-star/-installing-claude, branch claude/modest-dijkstra-ju73pw. Built and tested in the cloud on 2026-09-24.
- D1 database `avelie` exists, id 2c14ef65-a599-414d-b0d1-3f71b27c377a, already in wrangler.jsonc. Migrations 0001_init.sql, 0002_seed.sql and 0003_messages_seq_unique.sql are ALREADY applied to it (the seed is her fresh start at 22: strangers, no facts about Justin; 0003 went on with the first Mac deploy on 2026-09-24). The v2 files 0004_life.sql, 0004b_push.sql and 0004c_voiceprint.sql are NOT yet applied: section 13 does that with `npm run db:remote` before the v2 deploy. A migration that was already applied is never applied twice, so the command is safe to repeat.
- The seed (0002) can never be re-applied: `wrangler d1 migrations apply` records each file by name and skips it forever after. `npm test` rebuilds 0002_seed.sql locally, but a change to canon/seed/*.json only reaches the live database through a NEW migration file (0003 or later) with the UPDATE statements, followed by `npm run db:remote`.
- R2 bucket `avelie-media` exists.
- Hostname: avelie.bladepharoh.com (Justin approved it 2026-09-24). wrangler.jsonc attaches it as a Worker custom domain on deploy.
- Justin lifted the "never touch Cloudflare Access" rule for THIS app only, in his words on 2026-09-24: "I lift the Access rule for this app". Create and edit the Access application named Avelie and nothing else in Access.
- Justin already said go to the deploy itself, several times, on 2026-09-24 ("deploy Avelie", "you do the cloudflare for me"). Still show the before/after list once (step 6) and take one word from him before the first deploy, because it creates DNS and an Access door.
- v1 IS LIVE since 2026-09-24 ~4:04pm EDT (Worker `avelie`, custom domain, Access application "Avelie", both secrets set, proof curls passed). Sections 1 to 9 are history now; a session that arrives for v2 starts at section 13.

## 0. If a wrangler or git command is blocked by the app's permission mode

Justin's HQ rule: wrangler deploys from Claude Code only work when the desktop app's permission mode is Manual with Always-allow; Auto mode blocks them. If a command is refused, ask Justin to switch the session's permission mode (the picker at the bottom of the chat box) and to answer "Always allow" when the prompt appears. Do not work around it.

## 1. Get the code (about two minutes)

```
mkdir -p ~/Documents/ClaudeCode
cd ~/Documents/ClaudeCode
git clone -b claude/modest-dijkstra-ju73pw https://github.com/hy77m27dp7-star/-installing-claude.git 2026-09-24_avelie
cd 2026-09-24_avelie
npm install
npm test
```

If the clone asks for GitHub credentials, `~/.local/bin/gh auth setup-git` then retry (gh is logged in on this Mac). Node 22.15 or newer is required (`node --version`; the unit suite uses `module.registerHooks`). `npm test` builds the constitution from the canon, checks typography and the five master image hashes, typechecks, and runs the unit tests. It must pass. If it fails, stop and show Justin the failing lines; do not deploy a failing build.

Also confirm the account is on the Workers Paid plan (Cloudflare dashboard > Workers & Pages > Plans). Photos need it: one image edit moves several megabytes through the Worker and the Free plan allows 10 ms of CPU per request, which kills the request after OpenAI has already been paid. Her text works on either plan.

## 2. Log in to Cloudflare (one click from Justin)

```
npx wrangler login
```

A Cloudflare page opens in his browser. Tell him: "Click Allow." That is his only action. When the terminal says it is logged in, continue. No API token is created and none is needed.

`npx wrangler whoami` must show account id 0cfd47fde7b8ec136a3ee459f9481edb.

## 3. The Access door (you do this in his Chrome; he watches)

Use the browser tool. His Chrome is logged in to Cloudflare. If the browser tool is missing in this session, read each line below to Justin as one click at a time and let him click.

3a. Open https://dash.cloudflare.com/0cfd47fde7b8ec136a3ee459f9481edb/one/access-controls/apps (the older /one/access/apps URL 404s).
3b. Click "Add an application". Choose "Self-hosted".
3c. Application name: `Avelie`. Session duration: 24 hours. Application domain: `avelie.bladepharoh.com` (no path).
3d. Identity providers: only "One-time PIN" ticked. Untick everything else. Under "Cookie settings", set SameSite Attribute to `Strict` (the Worker also refuses cross-site posts on its own; this is the second lock).
3e. Policy: name `Owner`, action Allow, Include: Emails, `justin@newsomeprojects.com`. Save the policy. Save the application.
3f. Open the Avelie application you just made. Copy its "Application Audience (AUD) Tag" (a long hex string; it is an identifier, not a secret, fine to paste in chat).
3g. Put it in wrangler.jsonc: `"ACCESS_AUD": "<the tag>"` under vars. Leave ACCESS_TEAM_DOMAIN as it is (still-leaf-20a0.cloudflareaccess.com).

Do not touch any other Access application (BLADEGOD, BLADEGOD MCP, BLADEGOD well-known, bladeversedemo, or anything else).

## 4. Her two keys (never through chat, never on screen)

She talks through Anthropic (Claude Opus 5) and makes her photos through OpenAI (gpt-image-1) until the Runway key exists (section 25: Runway is the photo provider since 2026-09-25, OpenAI the fallback). Each needs an API key stored as a Worker secret. The keys go from Justin's clipboard straight into Cloudflare through `pbpaste`; you never see them, print them or write them to a file. The Worker must exist before secrets can be set, so this step runs AFTER the first deploy in step 6. Read it now so you can prepare him.

Ask Justin, yes or no, without asking him to paste anything:
- "Do you have an OpenAI account with API billing (platform.openai.com)?" Photos need it.
- "Do you have an Anthropic account with API billing (console.anthropic.com)?" Her voice needs it. If no, she can start on Cloudflare's own model (step 8) and be upgraded later.

For each key he has or makes:
1. In his Chrome, open the key page (https://platform.openai.com/api-keys or https://console.anthropic.com/settings/keys). He clicks "Create key", names it `avelie`, and clicks the copy button. If he has no account, open the sign-up page and let him do the account and the card himself; you fill nothing on a payment page.
2. He tells you "copied".
3. Run, for the OpenAI key: `pbpaste | npx wrangler secret put OPENAI_API_KEY` and for the Anthropic key: `pbpaste | npx wrangler secret put ANTHROPIC_API_KEY`. Then clear his clipboard: `printf '' | pbcopy`.
4. Never run `pbpaste` on its own, never pipe it to anything but wrangler, never `echo` it.

## 5. Before/after (show this once, then take ONE word)

Before: nothing at avelie.bladepharoh.com; Worker `avelie` does not exist.
After: Worker `avelie` deployed with the code from this folder, custom domain avelie.bladepharoh.com created (DNS record and certificate made by Cloudflare), Access application "Avelie" in front of it with One-time PIN for justin@newsomeprojects.com only, secrets ANTHROPIC_API_KEY and OPENAI_API_KEY stored in the Worker. Nothing else in the account changes.

Wait for his one word.

## 6. Deploy

```
npm run db:remote
npm run deploy
```

The first command applies migration 0003 (already-applied files are skipped). The second runs `npm test` again and then `wrangler deploy`. Expected output includes the custom domain avelie.bladepharoh.com. If wrangler says a DNS record for avelie.bladepharoh.com already exists and conflicts, open DNS for bladepharoh.com in his Chrome, delete that one record only, and rerun. If the deploy output shows `workers.dev` as enabled, stop: wrangler.jsonc has `"workers_dev": false` and must stay so.

Now do step 4 (the secrets). Then, since wrangler.jsonc changed in 3g, commit and push it so the repository stays the truth:

```
git add wrangler.jsonc
git commit -m "deploy: Access AUD for avelie.bladepharoh.com"
git push -u origin claude/modest-dijkstra-ju73pw
```

## 7. Proof (two commands, read the answers to Justin)

```
curl -sI https://avelie.bladepharoh.com/ | head -5
curl -sI https://avelie.bladepharoh.com/api/me | head -5
```

Run them only once the custom domain shows "Active" in the dashboard (Workers & Pages > avelie > Settings > Domains & Routes); while Cloudflare is still issuing its certificate, curl reports a TLS failure, which means "wait", not "open". The first must be `302` with a `location:` pointing at still-leaf-20a0.cloudflareaccess.com. The second must be `302` or `401`, never `200`. A `200` means the door is open to the world: stop and fix step 3 before anything else. The Worker itself answers `401` to anything without a valid Access identity, so there are two locks; the curl checks the first.

## 8. If there is no Anthropic key yet

Open https://avelie.bladepharoh.com/model.html in his Chrome (he logs in with the emailed PIN once). Provider: `workersai`. Model: `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. Save. She talks on Cloudflare's model until the Anthropic key exists; then switch provider back to `anthropic`, model `claude-opus-5`. Photos stay off until the OpenAI key exists (a photo request then shows as failed, nothing breaks).

## 9. First words

Tell Justin: "Open https://avelie.bladepharoh.com in your browser. Type your email. Type the code from your inbox. Say hello to her." Everything after that is theirs.

## 10. Later redeploys

```
cd ~/Documents/ClaudeCode/2026-09-24_avelie
git pull
ls migrations
npm run db:remote
npm run deploy
```

`npm run db:remote` applies any migration file the live database has not seen yet (today: the three 0004 files of v2) and skips the rest; run it every time, before `npm run deploy`. Secrets and the Access door survive redeploys; never redo steps 2 to 4. Section 13 is the v2 version of this step with its checks.

## 11. Backups and rollback

- `mkdir -p backups && npm run export:remote` writes a SQL dump into backups/ (git ignores it). In the app, State > Export gives the JSON that Import accepts.
- `npx wrangler rollback` returns to the previous deployment.

## 12. HQ, before you stop

- `cd ~/Documents/ClaudeCode/HQ && git pull`.
- STATE.md: a new dated section at the top: Avelie live at avelie.bladepharoh.com, Worker avelie, D1 avelie, R2 avelie-media, Access app Avelie (One-time PIN, owner only), which keys are set (names only), provider in use, the two proof results.
- MAP.md: add the row `avelie.bladepharoh.com | Worker avelie = Avelie (D1 avelie, R2 avelie-media), behind Cloudflare Access | 2026-09-24_avelie` to the live sites table, and the folder to the job folders list.
- memory/avelie.md: one file with the facts above and the standing rules: she is 22, fresh start 2026-09-24, nothing becomes canon without Justin's approval, no retention hooks, Access rule lifted for this app only.
- Commit and push HQ. Refresh the Google Drive "Claude HQ STATE" doc if the update-hq skill is present.
- Report to Justin in one short paragraph: what is live, what is set, what is not.

## 13. v2: pull, migrate, deploy (one round, one "go")

v2 adds three migration files, four cron jobs and new pages. The Worker name, the domain, the Access door and the two secrets do not change. Before/after for his one word:

Before: v1 live (Worker avelie, the four pages, no cron jobs, tables through 0003).
After: the same Worker with the v2 code, new tables (her life, message context, drift reports, first-text counts, push subscriptions, media library, voiceprints) and new columns on messages, four cron triggers on the Worker, the Timeline page, the phone shell. Nothing in the account outside the Worker and its database changes. No row that exists today is touched: the new columns start empty and her life starts empty on purpose.

Then, in order:

```
cd ~/Documents/ClaudeCode/2026-09-24_avelie
git pull
ls migrations
npm test
npm run test:integration
npm run db:remote
npm run deploy
```

- `ls migrations` must show 0004_life.sql, 0004b_push.sql and 0004c_voiceprint.sql.
- `npm test` and `npm run test:integration` must pass. If either fails, stop and show Justin the failing lines; do not deploy a failing build.
- `npm run db:remote` prints the three 0004 files as applied (and skips 0001 to 0003). Run it BEFORE the deploy: the new code reads the new tables on its first request.
- `npm run deploy` runs `npm test` again and then `wrangler deploy`. The output must list the custom domain avelie.bladepharoh.com and four cron triggers: `0 7 * * *`, `0 13 * * 1`, `*/20 * * * *`, `0 14 * * 1`. They come from `triggers.crons` in wrangler.jsonc and deploy with the Worker; there is nothing to click. If the output shows `workers.dev` as enabled, stop: wrangler.jsonc has `"workers_dev": false` and must stay so.

Proof, the same two curls as section 7 plus one: `curl -sI https://avelie.bladepharoh.com/timeline.html | head -3` must be `302` to still-leaf-20a0.cloudflareaccess.com, never `200`.

To see the crons in the dashboard: Workers & Pages > avelie > Settings > Triggers > Cron Triggers (four rows). To roll back: `npx wrangler rollback` (the previous code runs fine against the new tables; the new columns are ignored).

## 14. Optional secrets (each one only if he wants the feature)

Every one of these is optional. Without it the feature stays off and the app says so in its log; nothing breaks.

ElevenLabs, for her voice notes in a chosen voice (the default voice needs no key: Cloudflare's own model through the AI binding):
1. In his Chrome he opens https://elevenlabs.io, signs in, opens his profile's API keys, creates one named `avelie`, clicks copy, and says "copied".
2. Run `pbpaste | npx wrangler secret put ELEVENLABS_API_KEY`, then `printf '' | pbcopy`.
3. On the Model page: Voice provider `elevenlabs`, ElevenLabs voice id (from his ElevenLabs voice library, an id, not a secret), Save.

VAPID keys, for the phone notification when she texts first (no account, made on the Mac):
1. Run `node scripts/gen_vapid.mjs`. It makes a P-256 key pair in memory and prints the public key plus the two commands to run. It never writes the private key to a file.
2. Run the two printed lines: `... | npx wrangler secret put VAPID_PUBLIC_KEY` and `... | npx wrangler secret put VAPID_PRIVATE_KEY`, exactly as printed.
3. Redeploy is not needed; secrets are live at once. Then section 17 on the phone.

Never run `pbpaste` on its own, never `echo` a key, never paste one in chat.

## 15. Backups

The Worker writes a backup every day at 07:00 UTC (3am EDT): the full export, the same JSON that State > Export gives, to the R2 bucket `avelie-media` under `backups/avelie-<YYYY-MM-DD>.json`. It keeps the newest 30 and deletes older ones. Each run writes an audit event you can see under State > Rulebook > Audit (or `GET /api/audit`).

To look at them: Cloudflare dashboard > R2 Object Storage > `avelie-media` > `backups/`.

To download one to the Mac (dated example; use the file name you see):

```
cd ~/Documents/ClaudeCode/2026-09-24_avelie
mkdir -p backups
npx wrangler r2 object get avelie-media/backups/avelie-2026-09-25.json --file backups/avelie-2026-09-25.json
```

To put one back: State > Import in the app takes that file (it snapshots the current state first). The raw SQL dump from section 11 (`npm run export:remote`) still works and is the belt to this suspenders.

## 16. The weekly drift check

Off by default. When on, every Monday at 13:00 UTC (9am EDT) the Worker runs five fixed scenarios against her current performer in a throwaway conversation you never see in the chat list, stores the transcripts and flag counts, and deletes the throwaway messages. It costs five short conversations at the current model's price, inside the normal caps.

To turn it on: open https://avelie.bladepharoh.com/model.html, under Caps tick "Weekly drift check", click Save. To run it by hand: the Run now button in the Drift section of the same page. To read the results: the same section shows the last four reports (date, provider, model, flags per scenario). Read docs/BEHAVIOR.md before judging one.

It needs a real text provider: on the stub or without a key the run answers 503 and stores nothing.

## 17. The phone: home screen and notifications

The app is a web app. Installed to the home screen it opens full screen with her icon, works on the phone's clock, and can receive a notification when she texts first. Two things to know first: the login is the same emailed code, once a day; and on an iPhone the notification only works from the home-screen copy, not from Safari.

iPhone (Safari):
1. Open https://avelie.bladepharoh.com in Safari. Type the email, type the code from the inbox.
2. Tap the Share button (the square with the arrow).
3. Tap "Add to Home Screen". Tap "Add".
4. Close Safari. Open Avelie from the home screen. Log in again if it asks.

Android (Chrome):
1. Open https://avelie.bladepharoh.com in Chrome. Log in.
2. Tap the three dots, then "Install app" (or "Add to Home screen"). Tap "Install".
3. Open Avelie from the home screen.

Notifications (only after section 14's VAPID keys exist; the switch stays grey until then):
1. From the home-screen copy, open the Model page (the Model link at the top).
2. Under Notifications, turn on "Her first texts".
3. The phone asks to allow notifications. Tap "Allow".
4. A test: under Her first texts, tap "Send one now". Within a few seconds the phone shows her message. If nothing arrives, the reason is on the same page (off, quiet hours, busy, cap reached, a recent message, or two of hers unanswered).

Turning the switch off removes this phone from the list. No other event ever sends a notification.

## 18. She texts first: what it does and does not do

It is off until the number is above 0. Model page > Her first texts > Per day (0 to 10) and Quiet hours (default 23:30 to 08:30, her time), then Save. He decided the cap: 10 a day, at most.

What it does: every 20 minutes the Worker looks once. It skips if the number is 0, if it is her quiet hours, if her life says she is busy right now, if today's count is at the cap, if anyone wrote in the last 45 minutes, or if her last two messages have no reply from him. Otherwise it rolls a per-tick chance tuned so the expected count over her waking hours equals the cap, and on a hit she writes one or two bubbles from her own day or something she remembers, into the most recent conversation (a new one titled by the date if none). The message goes through the same checks as any reply. If the phone is subscribed, it gets a notification.

What it does not do: she never says she missed him, waited, or wondered where he was; never mentions how long it has been; never asks him to reply; never sends a third message in a row without an answer; never texts during quiet hours or while her schedule says she is busy; never pushes a notification for anything else. A first text that trips the `dependency_hook` check is dropped and logged, not retried. There is no streak, no counter he can see in the story, and nothing happens while the number is 0.

## 19. v3: pull, migrate, deploy (one round, one "go")

v3 adds two migration files, no new cron trigger, no new page, and one optional secret. The Worker name, the domain, the Access door and the existing secrets do not change. He pre-authorised this deploy ("deployed before i even start testing"); still show the before/after once.

Before: v2 live (tables through 0004d, four cron triggers).
After: the same Worker with the v3 code; new tables (the voice bank and its uses, the corrections, memory weights and recalls, wants, the want log, asks, the grounding log, the weather cache, calls, tastings and their candidates, message marks) and three new columns (`life_threads.portrait_asset_id`, `messages.call_id`, `message_context.state_text`); 150 seed voice lines, every one unapproved; one new fact about her (she lives in Portland, Maine, his decision); the same four cron triggers, the nightly one now also running the maintenance pass. Nothing in the account outside the Worker and its database changes. No row that exists today is touched.

Then, in order:

```
cd ~/Documents/ClaudeCode/2026-09-24_avelie
git pull
ls migrations
npm test
npm run test:integration
npm run db:remote
npm run deploy
```

- `ls migrations` must show 0005_v3.sql, 0005b_voicebank_seed.sql and 0006_tasting_context.sql after the 0004 files (0006 is the v3 review fix: one nullable column on `tastings`).
- `npm test` now also runs `build:voicebank` (it regenerates 0005b from canon/seed/voicebank.json; a regenerated file is byte-identical, so nothing changes in git).
- `npm run db:remote` prints the two 0005 files and 0006 as applied and skips 0001 to 0004d. Run it BEFORE the deploy: the new code reads the new tables on its first request. Apply 0005, 0005b and 0006 together; the seed file is written to be applied once and never re-applied (the ledger records it by name).
- `npm run deploy` runs `npm test` and `check:deploy` again and then `wrangler deploy`. The output must list the custom domain and the same four cron triggers as v2. If it shows `workers.dev` as enabled, stop.

Proof: the two curls of section 7, then `curl -sI https://avelie.bladepharoh.com/ | grep -i -E "content-security-policy|permissions-policy"` after logging in is not possible from curl (Access), so open the site in his Chrome and check the response headers in the Network tab: `content-security-policy` carries `connect-src 'self' https://api.openai.com` and `media-src 'self' blob:`, and `permissions-policy` carries `microphone=(self)`. Without them the Call button cannot reach the realtime provider or the microphone.

## 20. v3: the optional Runway secret (only if there is a key)

Clips ship OFF: there is no Runway key on the Mac today (his answer to open question 4), the code path is complete, and without the secret every clip control stays hidden and `POST /api/video/generate` answers 503. When a key exists in the keychain item `runwayml`:

```
security find-generic-password -s runwayml -w | npx wrangler secret put RUNWAY_API_KEY
```

That line never prints the key. Then on the Model page: Images > Video provider `runway`, model `gen4_turbo`, 5 seconds, `720:1280`, price 0.25 per clip (confirm on Runway's pricing page), Save. Clips are made from the Images page, Clips tab, and are candidates until approved.

## 21. v3: her city and the weather

Her city ships as Portland, Maine (his decision, 2026-09-24) with the weather on through Open-Meteo, which needs no key. To change it: Model page > Grounding > type a city, click Find, pick one from the list (that writes the city, its coordinates and its timezone), Save. Weather provider `off` turns the line off; nothing else changes. The weather is fetched at most once every 20 minutes and never delays a turn: a slow or failed call produces no line.

## 22. v3: calls, what the browser needs

Calls run on OpenAI Realtime with the OpenAI key already in the Worker. The first time he taps Call, the browser asks for the microphone once: tap Allow. On the phone the call works from Safari or the home-screen copy alike. The call sheet shows Connecting, Live, captions both ways, Mute and End; every 30 seconds the app meters the call from what the session bills (never below `callPricePerMinute` a minute), and it hangs up on its own at `callMaxMinutes` (20) or when a spending cap is reached, with the reason on the sheet. The transcript lands in the thread as a card. Calls on an ElevenLabs voice are v3.1; the two fields on the Calls card are marked Reserved.

## 23. v3: the texter, step by step (only when the meter says ready)

Nothing trains until he runs the script and types the word.

1. Model page > Texter. The bar shows approved exchanges against the minimum (200). Approved means: her messages he marked Keep, his rewrites in the Notes tab, and tasting picks. "Leave him out of the state" is on by default (his facts and his name are left out of the state part; his own messages still go as written, and the export record lists which fact ids went out). An exchange the explicit detector flags is left out by default; a Drop mark leaves one out by hand.
2. Click Export training set (the JSONL lands in Downloads) and Export record (the JSON beside it).
3. On the Mac, copy the OpenAI key (platform.openai.com, the key page, the copy button). Paste nothing.
4. Run `npm run finetune:run -- ~/Downloads/avelie-train-<date>.jsonl --verify ~/Downloads/avelie-train-<date>.json` (add `--dry-run` first to see the count and the cost estimate without uploading). The script reads the key from the clipboard and clears it, validates the file, prints the estimate, and asks: `type train to start`. Type `train` and press Return; anything else stops it.
5. It uploads, starts the job on `gpt-4.1-mini-2025-04-14` (his answer to open question 3; `--base gpt-4.1-2025-04-14` for the bigger one) and prints the status every 30 seconds. On success it prints the model id (`ft:...`).
6. Back in the panel: paste the id into Model id, add its two prices (USD per million tokens; the fine-tuned mini is about 0.8 in, 3.2 out, confirm on the pricing page), click Use. Her texts now come from that model; proposals, checks and the operator stay on Claude. Back to Claude puts the previous performer back.

If OpenAI's moderation refuses the file, the job fails with a message the script prints; leave the flagged exchanges out with Drop marks and export again.

## 24. v3: the two switches that ship off, and how to turn them on

- `provisionalRecallEvery` (Model page > Memory): 0 means she never half-remembers a detail. The behavior scenario H03 ("she half-remembers a low-weight detail and takes his correction in one line") is the gate; when it reads as a person on the real performer, set it to 8.
- `typoCueShare` (Model page > Text): 0 means the app never cues a typo; the TEXTURE paragraph lets typos happen on their own. If none ever do, set it to 0.05.
- Clips (section 20) are off for want of a key. Everything else in v3 is on.

## 25. Photos on Runway (2026-09-25; the key arrives later)

Runway's Gen-4 Image with tagged character references is the photo provider now (four OpenAI pictures were rejected on 2026-09-25: the face drifted and the body never came from the references). OpenAI stays selectable as the fallback. The code is deployed with the rest; the only missing piece is the secret, and until it exists a photo on the runway provider fails cleanly with `503 provider_not_configured` (the message shows a failed photo with Retry; nothing is spent).

When Justin has the key on his clipboard (never through chat, never on screen):
1. Run `pbpaste | npx wrangler secret put RUNWAY_API_KEY`, then `printf '' | pbcopy`. (If the key sits in the keychain item `runwayml` instead: `security find-generic-password -s runwayml -w | npx wrangler secret put RUNWAY_API_KEY`.) Secrets are live at once; no redeploy.
2. On the Model page, Images: Image provider `runway`, Image model `gen4_image`, Size `1024x1536` (sent to Runway as `1080:1440`), Cost USD `0.08` (8 credits at 0.01 USD each for a 1080p image; `gen4_image_turbo` would be `0.02`), Quality can stay (it is not sent to Runway), Save. The Model page's System panel shows the `runway` key dot on once the secret is set.
3. Ask her for a photo (or Images > Generate with a description). Expect 10 to 40 seconds: the page holds the request open while the Worker starts the Runway task, polls it every 3 seconds for up to 90 seconds, downloads the picture and stores it as a candidate, exactly as before. A moderated prompt comes back as a failed photo whose notes start with `refusal: moderated by Runway`; a slow task past 90 seconds is cancelled and reported as a retryable failure.
4. If the pictures are wrong, switch Image provider back to `openai` (model `gpt-image-1`, cost `0.06`) and Save; nothing else changes.

What the secret is used for: clips (section 20) and photos share it. Never run `pbpaste` on its own, never `echo` a key, never paste one in chat.

## Cost ceilings (from the build brief, 2026-09-24; confirm on Cloudflare's pricing pages, they move)

- Workers Paid (5 USD a month) is required for photos: the Free plan's 10 ms CPU per request cannot decode and hash a multi-megabyte image. Paid allows 30 s. Requests: 100,000 per day free on either plan. D1 Free: 5 million rows read and 100,000 written per day, 5 GB. Workers AI: 10,000 free Neurons per day.
- Anthropic and OpenAI bill separately; the app's own caps (docs/COSTS.md, default 3 USD a day, 30 USD a month) are what stop that spend.
- R2 for photo candidates is small at this scale but is its own line.
- v2 lines: the nightly backup is one small R2 write a day; the drift check is five short conversations a week at the text model's price, only when on; her voice notes cost Workers AI Neurons (inside the free 10,000 a day at this scale) or ElevenLabs characters on that account; her first texts are ordinary turns, at most 10 a day, inside the caps; push is free.
- v3 lines: the weather and geocoding are free (Open-Meteo); a call is metered every 30 seconds from the session's real usage with a floor of `callPricePerMinute` (0.30 a minute, so a 20-minute call is at least 6 USD and needs the daily cap raised for the day); a portrait is `portraitCostUsd` (0.04); a clip is `videoCostUsd` per five seconds (0.25) on his Runway account; a tasting turn spends double and is capped by `tastingDailyCapUsd` (1 a day) on top of the normal caps; training runs on his OpenAI account from the Mac and never through the app (docs/COSTS.md has the arithmetic).
