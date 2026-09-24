# Deploying Avelie from a Claude Code session on Justin's Mac

This file is for a Claude Code session running ON JUSTIN'S MAC (a local session with his browser, his folders and his logged-in Chrome). A cloud session cannot do this: its network cannot reach Cloudflare's API. Read the whole file, then do it in order. Justin gives ONE "go" before the first deploy (step 6). Never print, log, echo or paste a key. Typography " -- " and "..." only.

## What already happened (do not redo, do not re-verify)

- The code: repository hy77m27dp7-star/-installing-claude, branch claude/modest-dijkstra-ju73pw. Built and tested in the cloud on 2026-09-24.
- D1 database `avelie` exists, id 2c14ef65-a599-414d-b0d1-3f71b27c377a, already in wrangler.jsonc. Migrations 0001_init.sql and 0002_seed.sql are ALREADY applied to it (the seed is her fresh start at 22: strangers, no facts about Justin). Migration 0003_messages_seq_unique.sql is NOT yet applied: run `npm run db:remote` once, before the first deploy (step 6), and again whenever a newer migration file appears. A migration that was already applied is never applied twice, so the command is safe to repeat.
- The seed (0002) can never be re-applied: `wrangler d1 migrations apply` records each file by name and skips it forever after. `npm test` rebuilds 0002_seed.sql locally, but a change to canon/seed/*.json only reaches the live database through a NEW migration file (0003 or later) with the UPDATE statements, followed by `npm run db:remote`.
- R2 bucket `avelie-media` exists.
- Hostname: avelie.bladepharoh.com (Justin approved it 2026-09-24). wrangler.jsonc attaches it as a Worker custom domain on deploy.
- Justin lifted the "never touch Cloudflare Access" rule for THIS app only, in his words on 2026-09-24: "I lift the Access rule for this app". Create and edit the Access application named Avelie and nothing else in Access.
- Justin already said go to the deploy itself, several times, on 2026-09-24 ("deploy Avelie", "you do the cloudflare for me"). Still show the before/after list once (step 6) and take one word from him before the first deploy, because it creates DNS and an Access door.

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

She talks through Anthropic (Claude Opus 5) and makes her photos through OpenAI (gpt-image-1). Each needs an API key stored as a Worker secret. The keys go from Justin's clipboard straight into Cloudflare through `pbpaste`; you never see them, print them or write them to a file. The Worker must exist before secrets can be set, so this step runs AFTER the first deploy in step 6. Read it now so you can prepare him.

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

## 10. Later redeploys (the cloud session keeps improving her)

```
cd ~/Documents/ClaudeCode/2026-09-24_avelie
git pull
ls migrations
npm run deploy
```

If `ls migrations` shows a file newer than 0002 (0003_..., 0004_...), run `npm run db:remote` BEFORE `npm run deploy`. Secrets and the Access door survive redeploys; never redo steps 2 to 4.

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

## Cost ceilings (from the build brief, 2026-09-24; confirm on Cloudflare's pricing pages, they move)

- Workers Paid (5 USD a month) is required for photos: the Free plan's 10 ms CPU per request cannot decode and hash a multi-megabyte image. Paid allows 30 s. Requests: 100,000 per day free on either plan. D1 Free: 5 million rows read and 100,000 written per day, 5 GB. Workers AI: 10,000 free Neurons per day.
- Anthropic and OpenAI bill separately; the app's own caps (docs/COSTS.md, default 3 USD a day, 30 USD a month) are what stop that spend.
- R2 for photo candidates is small at this scale but is its own line.
