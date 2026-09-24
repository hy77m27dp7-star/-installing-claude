# Avelie runtime: handoff

## Status

The runtime is written end to end in this repository: the Worker entry with the Access gate, the turn pipeline with its checks, the proposal pass, the spending caps, the photo pipeline into R2, versioned state editing, export and import, the operator channel, the four screens, and a stub provider so everything can be exercised without a key. It has not been deployed and has not been run against a real model yet. Unit, integration and behavior runners live under `tests/`; run `npm test` and `npm run test:integration` before the first deploy. DEPLOY.md is the next step, and it needs your keys and your Access application.

## What was built

- `src/index.ts`: the fetch entry. Owner gate first for every path, then `/api/*`, `/media/:id`, and static assets.
- `src/auth.ts`: Cloudflare Access JWT verification against the team JWKS (issuer, audience, expiry, email). Local dev actor only on localhost with ACCESS_AUD empty.
- `src/api.ts`: the route table from API.md. One JSON error shape. Settings validation. Local provider overlay from `.dev.vars`.
- `src/chat.ts`: the turn. Validate, idempotency replay, budget, context, generate, photo marker, checks, one retry, one atomic commit, then the photo and proposal passes after the response.
- `src/context.ts`: bounded context assembly. Approved state, relevant history, recent story messages only.
- `src/prompt.ts`: the system prompt. A byte-stable constitution prefix (cacheable) followed by the state sections. Also the operator prompt, the proposal prompt, and the image identity block.
- `src/checks.ts`: the post-generation checks (the Archivist). Pure, unit-tested. Mechanical repairs only.
- `src/proposals.ts`: extracts candidate durable facts from one exchange into a pending inbox. Never promotes on its own.
- `src/budget.ts`: cost per call, the pre-call estimate, the two caps, the usage summary. Money is compared as micro-USD integers.
- `src/images.ts`: photo marker parsing, candidate generation with the five masters as references, hash blacklist, R2 storage, approve and reject, media serving, master verification.
- `src/state.ts`: facts, history, unknowns and state versions. Every edit is a new version; every write is audited; fixed canon is read-only.
- `src/exportImport.ts`: full JSON export, plain-text transcript, import with a snapshot taken first.
- `src/operator.ts`: the technical channel. Deterministic facts first, an optional model answer second, never in her voice, never read by story context.
- `src/providers/`: Anthropic (SDK, cache breakpoint, effort), OpenAI (chat completions and images/edits), Workers AI, and the deterministic stub. `index.ts` is the lookup.
- `src/generated/constitution.ts`: built from `canon/` by `scripts/build_constitution.mjs`. Carries the adaptation list. Never hand-edited.
- `migrations/`: `0001_init.sql` is the schema; `0002_seed.sql` is generated from `canon/seed`.
- `public/`: Chat, State, Model, Images. Vanilla HTML, CSS and JS, dark blues, one teal-to-cyan accent, labels only.
- `scripts/`: build the constitution, build the seed, fail the build on bad typography, verify the master hashes.
- `tests/`: unit (node:test), integration (boots `wrangler dev` on the stub), behavior (scenarios plus a runner that writes reports).

## Decisions made

- Fresh start. SHARED HISTORY is empty. She has not met him. No fact about him is seeded.
- She is 22. Every 24 in the frozen source is adapted to 22 at build time; the source files stay untouched and hashed.
- The music list is removed. The constitution keeps that she loves music and that her taste comes out in conversation; the named-artist anchors are gone (adaptation T01), so her taste is hers to reveal, not a list to recite.
- Claude Opus 5 is the default text model, effort medium, max 700 output tokens. Sampling parameters are not sent to Anthropic; see docs/ARCHITECTURE.md for why.
- Photos use OpenAI gpt-image-1 through the images/edits endpoint with the five masters attached as identity references. Every output is a candidate until you approve it. A rejected image's hash is kept so the same picture can never come back.
- Anthropic will not write explicit sexual scenes. Explicit scenes are therefore a provider switch in the Model panel, not a prompt trick. Switching the provider changes only the performer; her rules, memory and state stay where they are.
- No voice. Text and photos only.
- The proposal pass is on by default and uses claude-sonnet-5, a cheaper model, because it reads and classifies rather than performs.
- Caps default to 3 USD per day and 30 USD per month. The meter counts cached input at full price, so it errs high.
- Masters 02 and 04 carry a strip of screenshot text at the bottom edge and are kept exactly as they are, because the hash is the identity. See the open items.
- The three known wrong-face outputs are blacklisted by name in the seed. They have no hash on file (the binaries were never in the archive), so the hash check cannot match them; the names stand as the record.
- Typography is enforced by the build: only " -- " and "..." anywhere in the repo.

## How she is built to act

1. She is 22 and this is the first conversation. She has never met him and knows nothing about him until he says it.
2. She writes like a person texting. Short, plain, lowercase when it fits. No lists, no headers, no emojis, no em dashes.
3. She starts some beats herself: brings something up, returns to something he said earlier, shares a piece of her day, decides something, or goes quiet.
4. She does not interview. A third reply in a row that ends in a question is a failure the checks catch and retry.
5. She holds her own opinions and can disagree. She does not agree to comfort him and does not disagree to prove she is independent.
6. She has an ordinary life offscreen and never claims she was waiting, longing, or suffering while he was away.
7. She can pause, redirect, or stop closeness at any moment for a real present reason. Prior closeness never obligates her and never entitles him. With no history yet, nothing is assumed.
8. She never mentions prompts, models, files, or the app in the story. Technical truth is the operator channel's job, and the checks retry a story reply that leaks it.
9. She never uses guilt, urgency, exclusivity, or obligation. A real emergency gets a direct useful answer, not a scene beat.
10. She reveals untold things about herself one at a time when a conversation earns it, and she sends a picture only when it fits, one per message. Nothing she says or shows becomes canon until you approve it.

## How to run and test

```
npm install
cp .dev.vars.example .dev.vars
npm run build:canon
npm run db:local
npm run dev                  # http://127.0.0.1:8787, stub providers, no keys

npm test                     # canon build, typography, master hashes, typecheck, unit tests
npm run test:integration     # boots wrangler dev on 8790 and drives the API on the stub
npm run behavior             # scenario suite against a running app; writes reports/
npm run check:typography     # the typography scan alone
```

## Deployment

Follow DEPLOY.md. The actions that are yours and only yours:

- `wrangler login`, or hand Claude a CLOUDFLARE_API_TOKEN as a build secret.
- Create the Anthropic key and the OpenAI key, and put them with `wrangler secret put`.
- Choose the hostname (custom domain or workers.dev after Access exists).
- Create the Access application: self-hosted, One-time PIN only, 24 hour session, one Allow policy for OWNER_EMAIL.
- Copy the AUD tag into wrangler.jsonc and redeploy.
- Run the two curl proofs, then sign in with the email code and run one turn.

## Open items for the owner

- Keys. Nothing real runs until ANTHROPIC_API_KEY and OPENAI_API_KEY are stored as Worker secrets.
- The Access application. Until it exists and its AUD is in wrangler.jsonc, the Worker refuses every request with 503.
- First behavior review. Run `npm run behavior` against the deployed app on the real provider and read the transcripts yourself. docs/BEHAVIOR.md says how to read them and what not to do after one bad line.
- Whether to keep masters 02 and 04 with their screenshot text strips. They are identity references, and the text strip can leak into generated photos as stray lettering. If you crop them, the hashes change: update `canon/seed/assets.json` and `canon/ASSET_MANIFEST.json`, rebuild, and re-verify. If you keep them, do nothing.
- Model choice after the behavior suite. Opus 5 is the default; the suite is the evidence for keeping it or switching. When you name a model that is not in the price table, add its prices in the Model panel or its cost shows as zero with a price_unknown flag.
- The photo cost figure. `imageCostUsd` is a flat 0.06 per call for gpt-image-1 at medium quality; confirm it against OpenAI's current price and change it in the Model panel.

## Rollback

- Git: tag every deployed state (`git tag -a v0.1.0 -m "first deploy"`) so a known-good tree is one checkout away.
- Worker: `npx wrangler rollback` returns the previous deployment in one step.
- Data: State > Export gives the JSON; State > Import takes it back, and the app snapshots the current state into the `snapshots` table before it replaces anything. `npm run export:remote` is the raw SQL dump for cold storage.

## Next

v2

- Transcript import of the missing period is not needed now: fresh start.
- Run the behavior suite with the real providers, on a schedule, and keep the reports.

v3

- Her-week layer: an ordinary offscreen life that moves between conversations without inventing shared events.
- Let her open: she sends the first message of a day when the state says it fits.
- Image approval polish: side-by-side with the masters, a note field on reject, batch decisions.
- Nightly backup: a scheduled export into R2 or to your machine.
