# Avelie runtime

Avelie is a private, single-owner character runtime that runs inside your own Cloudflare account. Her rules live in versioned code, her memory lives in a D1 database, and the model behind her is a replaceable performer reached through a provider adapter. Nothing she says becomes canon until you approve it.

## What you need

- A Cloudflare account. Workers, D1, R2 and Zero Trust Access are all on the free tier for this app's own traffic.
- One email address. It is the only identity the app accepts. It is set as OWNER_EMAIL in wrangler.jsonc.
- An Anthropic API key for her text. Claude Opus 5 is the default model.
- An OpenAI API key for her photos. Photos use gpt-image-1 with the five master images as identity references. Without this key she still talks; a photo line in her reply fails quietly and the message shows a failed photo instead of a picture.

## Run it on your machine

1. Run `npm install`.
2. Run `cp .dev.vars.example .dev.vars`.
3. Run `npm run build:canon`.
4. Run `npm run db:local`.
5. Run `npm run dev`.
6. Open http://127.0.0.1:8787 in a browser.

Out of the box `.dev.vars` names the stub providers, so the local app needs no keys and spends no money. The stub answers with short lines and hands back one of the master images when she "sends a photo", so you can see the whole photo flow (pending, ready, approve, reject) without paying. One thing to know: the stub returns the same bytes every time, so once you reject a stub photo its hash is on the local blacklist and later stub photos are refused as blacklisted. That is the blacklist working. Approve stub photos instead, or delete `.wrangler/state` and run `npm run db:local` to start the local database over.

To talk to the real models on your machine, edit `.dev.vars`: paste the two keys, then either delete the two DEFAULT_ lines or set `DEFAULT_PROVIDER=anthropic` and `DEFAULT_IMAGE_PROVIDER=openai`. While a DEFAULT_ line is present it overrides the Model page locally. Never commit `.dev.vars`; it is in `.gitignore`.

## Tests

- `npm test` builds the canon, checks typography, checks the master image hashes, typechecks, and runs the unit tests. No keys, no network.
- `npm run test:integration` starts `wrangler dev` on port 8790 with the stub providers and drives the API end to end: a turn, a replayed turn, a failed model call, a photo, a rejected photo, export and import, and the budget cap.
- `npm run behavior` runs the scenario suite against a running app and writes `reports/behavior_<stamp>.md`. Read docs/BEHAVIOR.md before running it against a real model, because it spends money.

## The four screens

- Chat: talk to her. Her photos appear under her messages with Approve and Reject. The Operator toggle turns the composer amber and sends your question to the technical channel instead of to her.
- State: what is true right now. Relationship and scene, the timeline, facts in three columns, open unknowns, the proposal inbox, the rulebook, and export and import.
- Model: provider, model, effort, max tokens, the proposal pass, image settings, the two spending caps, and the usage meter.
- Images: the five masters with their hashes and a Verify button, the candidate queue, approved scene images, and the rejected list.

## Where things live

```
src/                the Worker (index.ts entry, auth, api router, chat pipeline, checks, proposals,
                    budget, images, state, export/import, operator, providers/)
src/generated/      constitution.ts, built from canon/ by npm run build:canon; never hand-edit
public/             the four pages, css/, js/, images/masters/
migrations/         0001_init.sql (schema), 0002_seed.sql (generated from canon/seed)
canon/              the frozen constitution, the seed JSON, the asset manifest, the reference docs
scripts/            build_constitution, build_seed, check_typography, verify_assets
tests/              unit (node:test), integration (boots wrangler dev), behavior (scenarios + runner)
docs/               COSTS.md, BEHAVIOR.md, ARCHITECTURE.md
```

DEPLOY.md is the protected deployment, step by step. HANDOFF.md is the state of the project and what is still yours to decide.
