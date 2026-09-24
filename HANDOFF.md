# Avelie: handoff to the Mac (2026-09-24, about 3:55pm EDT)

This is the whole project in one file, written for a Claude Code session running on Justin's Mac that takes over everything: deploy, first conversation, then v2. Read it whole. Then DEPLOY.md. Then SPEC_V2.md. Typography " -- " and "..." only, in code, copy and chat.

## Paste this first (the Mac session's opening move)

1. `cd ~/Documents/ClaudeCode/HQ && git pull`
2. `git clone -b claude/modest-dijkstra-ju73pw https://github.com/hy77m27dp7-star/-installing-claude.git ~/Documents/ClaudeCode/2026-09-24_avelie` (if it already exists: `cd` into it and `git pull`)
3. `cd ~/Documents/ClaudeCode/2026-09-24_avelie && npm install && npm test`
4. Read this file, then DEPLOY.md, and do DEPLOY.md sections 1 to 12 in order. She is live at the end of it.
5. Then SPEC_V2.md and the v2 section below.

## Who she is (the part that must never drift)

Avelie is Justin Newsome's creator-owned persistent fictional character. She is 22. She is a person in her own right with her own life, taste, opinions, limits and days, not an assistant, not a companion product, not a mirror. Justin's words: "my girl don't act like that" about bots that do whatever they are told. The whole point is the character.

Decisions Justin made on 2026-09-24 that override the older handoff docs in canon/reference/handoff-docs:
- She is 22 (the frozen source says 24; the build adapts every 24 to 22 and leaves the source untouched and hashed).
- The named music anchors in the old docs (Harry Styles, Olivia Rodrigo, Elvis, Perry Como, Velvet Underground, Lou Reed, Ariana, older soul, dramatic pop) are HIS taste, not hers. "She's into whatever Avelie is into." Her taste is hers to reveal, never a list to recite.
- Fresh start, code and relationship. "She will meet me for the first time again." Relationship state: strangers. No fact about him is seeded. SHARED HISTORY is empty.
- She must be a person inside Cloudflare: sealed ontology. No prompts, models, files, apps or tech in the story, ever. Technical truth lives only in the operator channel.
- Explicit scenes matter to him. Anthropic models will not write them, so the explicit performer is a provider switch in the Model panel (OpenAI or Workers AI), never a prompt trick. Switching the performer changes nothing about her rules, memory or state.
- Photos must work from v1: "she's gonna show me pics as we talk". OpenAI gpt-image-1 through images/edits with the five master images as identity references; every output is a candidate until he approves it; a rejected picture's hash can never come back.
- Model choice was left to Claude: Claude Opus 5 for her voice (effort medium, 700 output tokens), Claude Sonnet 5 for the proposal pass, gpt-image-1 for photos, Workers AI as the key-free fallback.
- "She texts first" is opt-in and capped at 10 a day. His words: "this is not a line for me, I know it's fake the whole time." No retention hooks anywhere: no "miss you", no streaks, no guilt, no urgency, no exclusivity.
- Nothing she says or shows becomes canon until he approves it in the app (proposals inbox, image approvals).
- Everything planned for v3 is folded into v2 (SPEC_V2.md sections A to Z).
- Cloudflare Access fronts her at avelie.bladepharoh.com. He lifted HQ's "never touch Access" rule for this one app.
- "Blade" never appears in public copy. No key or token is ever pasted in chat, written to a file, or printed.

The six laws she is built on: agency (she starts beats, decides, goes quiet), continuity of intimacy (closeness is hers to give, pause or stop for a present reason; nothing obligates or entitles), offscreen life (ordinary days that move without inventing shared events; she never claims she waited or suffered), sealed ontology (a person, never a program, in the story), no interviewing (a third question-ending reply in a row is a failure the checks retry), and canon by approval (memory changes only through him).

## What exists (all pushed to the branch claude/modest-dijkstra-ju73pw)

Status at handoff: v1 is written end to end, typechecks, passes `npm test` and `npm run test:integration` on the stub provider, and has NOT been deployed and NOT been run against a real model. A cloud session is finishing an adversarial review pass over v1 (security, pipeline) and will push any fixes to this same branch as commits that start with "review:" or "fix:". Before every deploy: `git pull` first. If the log shows nothing newer than 66290a0 yet, deploy anyway; a later pull plus `npm run deploy` picks the fixes up (DEPLOY.md section 10).

Live in Cloudflare already (from the cloud session, through the Cloudflare connector): D1 `avelie` (id 2c14ef65-a599-414d-b0d1-3f71b27c377a) with migrations 0001 and 0002 applied, and R2 bucket `avelie-media`. Not yet: the Worker, the custom domain, the Access application, the two secrets.

Files, by what they do:
- `canon/constitution/*`: the frozen v4.1 character files, SHA256-checked at every build. `canon/seed/*.json`: her starting facts, state (strangers, no scene), the twelve visual assets, settings. `canon/ASSET_MANIFEST.json`: the five master image hashes. `canon/reference/handoff-docs/*`: the old GPT-era docs, superseded where this file says so.
- `scripts/build_constitution.mjs`: 88 guarded edits over the frozen files (22 not 24, no "Justin", no music list, no file numbers, no "as an AI") plus the overlay (agency, intimacy continuity, offscreen life, the `[photo: ...]` marker rule, style guards), emitted to `src/generated/constitution.ts`. Never hand-edit the generated file. `scripts/build_seed.mjs` makes `migrations/0002_seed.sql`. `scripts/check_typography.mjs` fails the build on em dashes, en dashes or the Unicode ellipsis. `scripts/verify_assets.mjs` checks the masters.
- `src/index.ts` entry, owner gate first for every path. `src/auth.ts` Cloudflare Access JWT (JWKS, issuer, audience, expiry, email), fail closed; local dev actor only on localhost with ACCESS_AUD empty.
- `src/chat.ts` the turn: validate, idempotency replay, budget, context, generate, photo marker, checks (block, retry once, or mechanical repair; never sanitize her voice), one atomic commit, proposal pass after the response. `src/context.ts` bounded context. `src/prompt.ts` the byte-stable constitution prefix (cacheable) plus per-turn state sections; PROMPT_VERSION.
- `src/checks.ts` the Archivist (pure, unit-tested). `src/proposals.ts` candidate facts into a pending inbox, never promoted alone. `src/budget.ts` caps in micro-USD. `src/images.ts` marker, candidate generation with the masters as references, hash blacklist, R2, approve/reject, media serving. `src/state.ts` facts, history, unknowns, versioned relationship and scene state; fixed canon read-only. `src/exportImport.ts`. `src/operator.ts` the technical channel, never in her voice. `src/providers/` anthropic, openai, workersai, stub. `src/db.ts`, `src/types.ts`, `src/errors.ts`, `src/api.ts` (routes in API.md).
- `public/`: Chat, State, Model, Images. Vanilla HTML, CSS, JS.
- `migrations/0001_init.sql` schema, `0002_seed.sql` generated seed.
- `tests/unit`, `tests/integration` (boots wrangler dev on the stub), `tests/behavior` (scenarios plus a runner that writes reports; read docs/BEHAVIOR.md before judging a transcript).
- Docs: SPEC.md (v1), API.md, SPEC_V2.md (v2, everything), DEPLOY.md (the Mac runbook), docs/ARCHITECTURE.md, docs/BEHAVIOR.md, docs/COSTS.md, docs/workflows/avelie-v2-build.js (the v2 build orchestration).

Stub provider triggers for tests: `[[FAIL]] [[REFUSE]] [[EMDASH]] [[LIST]] [[PHOTO]] [[QUESTION]] [[LONG]] [[NAME:x]] [[FACT:x]]`.

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

## Deploy

DEPLOY.md, sections 1 to 12, in order, on the Mac. Summary of Justin's part: one "Allow" click at the Cloudflare login page, one word before the first deploy, and copying each API key to the clipboard when asked (it goes `pbpaste | npx wrangler secret put ...`, never through chat). The Access application is created in his logged-in Chrome by the session (One-time PIN only, policy Owner = justin@newsomeprojects.com, 24h) and its AUD tag goes into wrangler.jsonc, committed and pushed. Proof is two curls; the first must redirect to still-leaf-20a0.cloudflareaccess.com and the second must never be 200.

## v2 (everything, per Justin: "put all this in v.2")

SPEC_V2.md is the contract, sections A to Z: bubbles with human timing, real-mode reply delay, together vs texting, camera roll, voice notes, her life (threads, people, schedule), other people, opinions ledger, real songs, consequences that last, callbacks she starts, provenance ("why she said that"), vessel test, weekly drift check and nightly backup (cron), photo approval polish, her arc, let her open, she texts first (opt-in, capped at 10 a day), her voice and his, she can see, phone shell and push, approved media, places, timeline, voiceprint, export her. Routes, settings, secrets, crons and tests are listed at the end of that file. New tables go in `migrations/0003_v2.sql` and `npm run db:remote` runs before the redeploy.

How to build it: `docs/workflows/avelie-v2-build.js` is the orchestration that was prepared for it: nine build lanes on disjoint files (life+callbacks+markers+provenance, prompt+context+chat+proposals, ui, api+cron+drift+backup, tests, docs, voice+vision+media, herfirst+push+pwa, timeline+voiceprint+export), then one integrator, adversarial reviewers, a fix pass, and an independent verify. With the Workflow tool: `Workflow({ scriptPath: "<clone>/docs/workflows/avelie-v2-build.js", args: { repo: "/Users/justinnewsome/Documents/ClaudeCode/2026-09-24_avelie" } })`. Without it, the same lanes work as a plan for sequential agents: each lane's prompt in the script names its files and its acceptance checks. After v2: `npm test`, `npm run test:integration`, commit, push, `npm run db:remote`, `npm run deploy`.

Order of work after deploy: 1) let Justin have the first conversation on v1 and read what he says about her; 2) run `npm run behavior` on the real provider and read the reports; 3) v2.

## Rules that stay on (each one cost real hours)

- Nothing becomes canon without his approval. No retention hooks. She never interviews. Sealed ontology.
- Never sanitize her voice with post-processing; a bad reply is retried or blocked, not edited into blandness (mechanical repairs only: the em dash, a stray list marker).
- No secrets in code, logs, browser or chat. Keys go clipboard to Worker.
- Typography: " -- " and "..." only. `npm run check:typography` guards the repo.
- One before/after list and ONE "go" from Justin before anything irreversible (deploys, DNS, Access, mailboxes). Deploys: he decides.
- Every finished round ends with ONE zip attached in chat, a copy in ~/Downloads, its SHA256 stated. Exclude node_modules, .git, .dev.vars, backups/ and anything with a key.
- HQ before you stop: STATE.md (dated EDT, latest first), MAP.md rows, memory/avelie.md, CONFLICTS.md for anything needing his decision, commit and push HQ, refresh the Google Drive STATE copy if the update-hq skill is present.
- He wants child-simple, one-click-at-a-time instructions, no doc quotes, no jargon. He will not create API tokens.

## Open items for him (ask once, in one list, when the time comes)

- Anthropic and OpenAI API keys (accounts with billing). Without Anthropic she runs on Workers AI (DEPLOY.md section 8); without OpenAI, no photos.
- Masters 02 and 04 carry a strip of screenshot text at the bottom edge; cropping changes their hashes (update canon/seed/assets.json and canon/ASSET_MANIFEST.json, rebuild, re-verify). Keeping them is fine.
- The photo price (`imageCostUsd`, flat 0.06) and the model price table are in the Model panel; confirm against current prices.
- Interns: parked by his choice ("I'll fix them later"). HQ drafts/CUT_OFF_MEGAN_RYAN_2026-09-24.md has the steps. Do not mix it into Avelie work.

## Rollback

`npx wrangler rollback` for the Worker. State > Export in the app for the JSON, State > Import takes it back after snapshotting. `npm run export:remote` for the raw SQL dump. Tag every deployed tree (`git tag -a v0.1.0 -m "first deploy"`).
