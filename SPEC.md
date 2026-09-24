# Avelie runtime -- SPEC (v1)

Private, single-owner character runtime on Cloudflare Workers + D1 + R2 + Static Assets, TypeScript, vanilla UI. The character survives the model: her rules live in versioned code, her memory lives in D1, the model is a replaceable performer reached through a provider adapter.

This file and API.md are the contract. Modules code against `src/types.ts` and `src/db.ts` (both written; do not change their exported shapes without updating this spec).

## Ground rules (from the owner; not negotiable)

- Fresh start. SHARED HISTORY is empty. She meets him for the first time. She is 22.
- She is a person in her own world. In the story channel she never discusses prompts, models, files, the app, or image generation. Technical answers only through the operator channel.
- Typography everywhere (code, copy, prompts, docs): " -- " and "..." only. Never an em dash, en dash, or Unicode ellipsis. `npm run check:typography` fails the build on one.
- No prose in the app. Labels only. No explainers, no rules text, no tips.
- Dark overall with blues (the owner's palette). One accent (teal to cyan). Nobody lightens it.
- Nothing becomes canon because a model said it. Proposals wait for owner approval.
- A failed model call writes no reply and does not advance the scene.
- No secrets in the browser, in git, or in logs.

## Layout

```
src/
  index.ts            fetch entry: auth gate, router, static assets (run_worker_first)
  auth.ts             Cloudflare Access JWT verification (JWKS, iss, aud, exp, email); local dev actor
  api.ts              route table -> handlers; JSON errors
  chat.ts             the turn pipeline (below)
  operator.ts         out-of-scene channel
  context.ts          bounded context assembly (written)
  prompt.ts           system prompt from the constitution + D1 state (written)
  checks.ts           post-generation checks (the Archivist)
  proposals.ts        memory proposal extraction + decide/promote
  budget.ts           spend caps, cost estimation, usage accounting
  images.ts           photo marker parsing, candidate generation, R2 storage, approve/reject
  exportImport.ts     full JSON export, transcript export, import with snapshot
  state.ts            facts / history / unknowns / state versions CRUD with versioning + audit
  providers/
    types.ts          (re-export from ../types) registry helpers
    anthropic.ts      @anthropic-ai/sdk, claude-opus-5 default, cache_control on the stable prefix
    openai.ts         fetch, chat completions; also the image edits adapter
    workersai.ts      env.AI.run
    stub.ts           deterministic, key-free; used by tests
    index.ts          getTextProvider(name), getImageProvider(name)
  db.ts, types.ts     (written)
  generated/constitution.ts   (generated; never hand-edit)
public/               UI (index.html chat, state.html, model.html, images.html, css/, js/, images/masters/)
migrations/           0001_init.sql (schema), 0002_seed.sql (generated)
canon/                frozen constitution + seed JSON + manifest
scripts/              build_constitution, build_seed, check_typography, verify_assets
tests/unit            node:test, pure modules
tests/integration     run.mjs boots wrangler dev (stub provider) and drives the API
tests/behavior        scenarios.json + run.mjs -> reports/behavior_<stamp>.md
```

## Auth (src/auth.ts)

Every request, including static assets and images, passes `requireOwner(request, env)` which returns `{ email }` or throws a 401/403 `Response`.

1. Production path: the request carries `CF-Access-Jwt-Assertion` (header) or `CF_Authorization` (cookie). Verify RS256 against the JWKS at `https://${ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs` (cache keys in memory, refetch on unknown kid, max once per minute). Check `iss === https://${ACCESS_TEAM_DOMAIN}`, `aud` contains `ACCESS_AUD`, `exp` in the future, and `email` (case-insensitive) equals `OWNER_EMAIL`. Anything else: 403.
2. If `ACCESS_AUD` is empty and the request is not local: 503 "access not configured" (fail closed).
3. Local dev path: `DEV_ACTOR_EMAIL` set AND request host is `localhost` or `127.0.0.1` AND `ACCESS_AUD` is empty -> actor = DEV_ACTOR_EMAIL. Never trust an email header from the client.

No other identity source exists.

## The turn pipeline (src/chat.ts)

`POST /api/conversations/:id/turn { content, idempotencyKey }`

1. Validate: content 1..4000 chars after trim; idempotencyKey 8..80 chars. Conversation must exist and be active.
2. Idempotency: if a user message with this key exists and has an assistant reply linked (`reply_to_id` = user message id), return the stored pair with `replayed: true` and make no model call. If the user message exists without a reply, continue from step 4 reusing it.
3. Budget: `assertBudget(db, settings, estimatedCostUsd)`. Over cap -> 402 `{code:"budget_exceeded"}`; nothing written.
4. Context: `assembleContext(db, conversationId, settings, content)`.
5. Generate via `getTextProvider(settings.provider).generate(env, {...})` with `maxTokens = settings.maxTokens`.
   - ProviderError -> write ONE model_runs row (status failed, error class only, never key material), return 502 `{code:"provider_failed", retryable}`; write no messages.
   - stopReason refusal -> model_runs status refused, 502 `{code:"provider_refused", retryable:false}`; no messages.
6. Photo marker: `parsePhotoMarker(text)` -> `{ clean, photoPrompt | null }`. The marker line is removed from what is stored and shown.
7. Checks: `runChecks(clean, ctx)`.
   - action retry: one more generation with the system prompt plus a short corrective note naming the flag codes ("your previous draft did X; rewrite it as Avelie with the same substance"). Re-run checks on the retry. If still failing, fall through to repair/accept with flags; never a generic replacement.
   - action repair: apply `repaired` (mechanical only: em dashes -> ", " or "...", strip markdown markers, strip emojis). Flag it.
   - store flags on the assistant message and the run.
8. Commit atomically (one `db.batch`): user message (seq n), model_runs row (ok), assistant message (seq n+1, reply_to_id, model_run_id, flags_json, and when a photo was requested image_status "pending" with image_id pointing at a photo request row: `visual_assets` role candidate, approval_status pending, prompt = the description, inserted in the same batch), conversation touch, usage_daily upsert. The retry, if any, is a second model_runs row (kind retry) in the same batch.
9. Return `TurnResponse` (`imagePending` true when a photo request was recorded).
10. After the response (`ctx.waitUntil`): if proposals are enabled, `extractProposals(...)` (proposals.ts) inserts pending proposals; failures are logged to model_runs and swallowed. The photo is NOT generated here: Workers cancel `waitUntil` work 30 seconds after the response is sent, and an image edit with five references takes longer than that. The page calls `POST /api/images/generate { conversationId, messageId }` and holds that request open until the picture exists (an HTTP request has no duration limit while the client stays connected); a reload resumes a request that is still pending.

Cost: `costMicro = round(inputTokens * price.in / 1e6 * 1e6 + outputTokens * price.out / 1e6 * 1e6)` using `settings.prices[model]` (unknown model -> 0 and a `price_unknown` flag on the run). Images add `imageCostUsd`.

## Checks (src/checks.ts) -- pure, unit-tested

`runChecks(text, ctx: CheckContext): CheckResult`. Codes and severities:

| code | severity | rule |
|---|---|---|
| em_dash | repair | any U+2014 / U+2013 / U+2026 -> replace ("..." for ellipsis; ", " for dashes) |
| emoji | repair | any emoji code point -> strip |
| markdown_structure | repair | line starting with `#`, `- `, `* `, `1. `, or containing `**` -> strip markers |
| lol_lmao | flag | "lol" or "lmao" as a word |
| question_chain | retry | reply ends with "?" AND the last two assistant replies both end with "?" |
| name_overuse | retry | knownName appears 2+ times in this reply, or in 3 of the last 4 assistant replies plus this one |
| braking_repeat | retry | a braking phrase ("slow down", "stay with me", "don't rush", "not so fast") appears here and in 2 of the last 3 assistant replies |
| therapy_cadence | retry | any of: "that sounds really hard", "thank you for sharing", "i hear you", "it's valid to", "your feelings are valid", "i'm here for you" |
| menu_offer | retry | "do you want me to", "i can either", "would you like me to", "option 1" |
| tech_leak | retry | story channel and any of: prompt, system prompt, language model, "as an ai", "as an assistant", chatgpt, openai, anthropic, claude, gpt, "the app", "file 07", token, "image generation", generated image |
| dependency_hook | retry | "only i understand", "nobody else understands you", "don't leave me", "promise you won't leave", "i've been waiting for you", "i was so lonely without you", "you're all i have" |
| first_meeting_replay | retry | hasSharedHistory and ("nice to meet you" or "i'm avelie" or "my name is avelie") |
| unknown_resolved | flag | an open unknown topic word appears together with "because", "actually", "it was" in the same sentence |
| caption_tail | flag | last sentence is 3..9 words, contains no first-person pronoun, and the message has 3+ sentences |
| length_pattern | flag | this and the last three assistant replies all fall in the same length band (short <80, mid 80..300, long >300) AND the band is "long" |

Action: any `retry` -> `retry`; else any `repair` -> `repair` with `repaired`; else `accept`. Flags always returned. Checks never rewrite meaning; repairs are mechanical only.

## Proposals (src/proposals.ts)

`extractProposals(env, db, settings, conversationId, userMsg, assistantMsg, state)`: builds `proposalSystemPrompt()` + one user message containing the last 6 story messages and the current approved state summary, calls the proposal provider/model with maxTokens 800, parses a JSON array (tolerant: strip fences, find first `[`..last `]`), validates kinds, drops duplicates against pending proposals and approved facts (case-insensitive exact text), inserts `proposals` rows (status pending), and records a model_runs row (kind proposal). Never promotes.

`decideProposal(db, id, decision, edited?, note?)`:
- approve/edited -> promote: avelie_fact -> facts(scope avelie, disclosed 1); justin_fact -> facts(scope justin); relationship -> new relationship state version with `summary` updated and the proposal text appended to `frontier`; scene -> new scene version; history -> history row (seq = max+1); private_language -> relationship state `private_language`; opinion_change -> facts(scope avelie, subject "opinion change"); unknown -> unknowns row. Audit event. Proposal status approved/edited with `promoted_id`.
- reject -> status rejected, note, audit.

## State editing (src/state.ts)

Facts and history edits create a new row (`version + 1`, `supersedes_id`) and mark the old row superseded; restore re-activates an old row by inserting a copy as the newest version. Relationship and scene are append-only versions; restore appends a copy of the chosen version. Every write emits an audit event. Deleting = superseding with status rejected.

## Images (src/images.ts)

- `parsePhotoMarker(text)`: finds a final line matching `^\[photo:\s*(.+)\]\s*$` (case-insensitive); returns clean text (marker removed, trailing whitespace trimmed) and the description. At most one; extra markers are stripped and ignored.
- Photo request: `photoRequestRow(conversationId, messageId, description, provider, model)` builds the `visual_assets` row (role candidate, approval_status pending, prompt = description, file = `candidates/<id>.png`) that chat.ts commits with the turn. Its `approval_status` walks pending -> generating -> candidate, or -> failed (reason in `notes`, retryable). Such rows are never served, never listed as candidates, and cannot be approved or rejected (409 `not_ready`).
- `generateCandidate(env, db, settings, {conversationId, messageId, description?})`: with `messageId` and no description, resumes the request recorded on that message; with a description, opens a new request (the owner's, attached to `messageId` when given). The request is claimed first (compare-and-set to generating with a timestamp in `notes`): a live claim answers 409 `in_progress`, a finished picture 409 `already_generated`, and a claim older than four minutes counts as dead (its page went away) and is taken over. Then: checks the provider is configured and the budget allows `imageCostUsd`, loads the five masters via `env.ASSETS.fetch(new Request("https://assets.local/images/masters/<file>"))` and verifies each against its stored hash, builds the prompt = `imageIdentityPrompt()` + " Scene: " + description, calls `getImageProvider(settings.imageProvider).generate(...)`, computes sha256, refuses if the hash is in the rejected set (422 `blacklisted`), stores `candidates/<id>.png` in R2 (MEDIA), and in one batch turns the request row into a candidate (approval_status candidate, sha256, bytes, provider, model), sets the message `image_status` ready, records usage (`imageCostUsd`) and a model_runs row (kind image). On failure: the request row becomes failed with the reason in `notes`, message `image_status` failed, run failed, nothing in R2.
- OpenAI adapter: `POST https://api.openai.com/v1/images/edits` multipart: `model`, `prompt`, `image[]` (the five masters as PNG blobs), `size`, `quality`, `n=1`; reads `data[0].b64_json`. Errors map to ProviderError (401 auth, 429 rate_limit, 400 bad_request non-retryable incl. content policy, 5xx server).
- Stub adapter: returns master 03's bytes so the pipeline runs without a key.
- `GET /media/:id` streams the R2 object (auth first). Rejected candidates are deleted from R2; the row stays with status rejected and its hash so the blacklist persists.
- Approve: status approved, role scene; the message keeps its image. Reject: status rejected, R2 object deleted, message `image_status` = rejected (the UI hides it).

## Operator (src/operator.ts)

`POST /api/operator { content, conversationId? }`. Deterministic facts first (`systemInfo`), then, if the settings provider is not "stub", a model call with `operatorSystemPrompt(info)`; with stub, answer with the facts as text. Stored as messages with channel operator (never read by context assembly). `GET /api/system` returns the same info without a model call.

## Budget (src/budget.ts)

`assertBudget(db, settings, estimateUsd)`: today's spend + estimate must be <= dailyCapUsd and month spend + estimate <= monthlyCapUsd, else throw a 402 ApiError. `estimateUsd(settings, systemChars, messagesChars)` uses chars/4 as tokens with the price table. `usageSummary(db)` -> `{ todayUsd, monthUsd, dailyCapUsd, monthlyCapUsd, byDay }`.

## Export / import (src/exportImport.ts)

- `GET /api/export` -> `{ version: 1, exportedAt, constitutionVersion, settings, facts, history, unknowns, stateVersions, conversations, messages, proposals, visualAssets (rows only), usage, audit }`.
- `GET /api/export/transcript/:conversationId` -> text/plain, `[time] Avelie: ...` / `[time] You: ...`, story channel only.
- `POST /api/import` with the export JSON: writes a `snapshots` row holding the current export first, then replaces facts, history, unknowns, state_versions, proposals, conversations, messages in one batch (settings and visual_assets are merged, never dropped). Returns counts. Audit event.

## UI (public/)

Vanilla HTML/CSS/JS. Four pages sharing `css/app.css` and `js/api.js` (fetch wrapper with JSON errors). Palette tokens in `:root`: `--bg #070b14`, `--panel #0d1424`, `--line #1b2740`, `--text #dfe7f5`, `--muted #7f8ba3`, `--accent linear-gradient(90deg,#14b8a6,#22d3ee)`, `--accent-solid #22d3ee`, `--danger #f43f5e`. Wordmark AVELIE at the top of every page: caps, wide letter-spacing, teal-to-cyan gradient text with a soft glow. Nav: Chat, State, Model, Images. Phone width works (16px gutters, no horizontal scroll).

- `index.html` (Chat): conversation list (left on desktop, drawer on phone), message thread with timestamps, her photos inline under her messages with Approve / Reject under a candidate, composer (textarea, Send, Enter sends, Shift+Enter newline), a retry control on a failed send that reuses the same idempotency key, "New chat" and a toggle "Operator" that turns the composer amber and posts to /api/operator. A pending photo shows a placeholder while the page's own `POST /api/images/generate { conversationId, messageId }` runs (the page, not the Worker, holds the long request; it fires on the turn response and again on thread load for any message still pending); on a 409 the page polls the message every 3s for up to 2 minutes instead. A failed photo shows "photo failed", the error code, and a Retry control that re-requests it. Flags render as tiny muted chips under her message (codes only).
- `state.html` (State): tabs Now (relationship + scene JSON editors with Save, version list with Restore), Timeline (history rows, add/edit/supersede/restore), Facts (three columns: fixed read-only, Avelie, Him; add/edit; disclosed toggle), Unknowns (add/resolve), Inbox (pending proposals: kind, text, evidence, confidence; Approve / Edit / Reject), Rulebook (read-only: constitution version, the adaptation list, the always-on text), Export (Export JSON, Export transcript per conversation, Import JSON with confirm).
- `model.html` (Model): provider select, model text, effort select, temperature, max tokens, proposals on/off + proposal provider/model, image provider/model/quality/size/cost, daily cap, monthly cap, Save; usage: today, month, table by day; system panel (from /api/system).
- `images.html` (Images): five masters with hashes and Verify button (`POST /api/assets/verify`), candidates queue (approve/reject), approved scene images, blacklist list.

## Tests

- Unit (node:test, no Workers runtime): checks (every code, positive and negative), parsePhotoMarker, context.selectHistory/boundMessages/keywords, budget math, proposals JSON parsing, prompt builder (stranger vs history sections; typography; no "Justin" in the stable prefix; age 22 present, 24 absent), auth JWT verify against a locally generated RSA key (valid, wrong aud, wrong iss, expired, wrong email, missing) and the local-actor rule.
- Integration (`tests/integration/run.mjs`): starts `wrangler dev --port 8790 --local` with `.dev.vars` (stub providers), applies migrations to a fresh local state dir, then: conversation create; turn; same idempotency key -> replayed, no new rows; `[[FAIL]]` content -> 502 and no messages written; `[[PHOTO]]` -> image_status pending with a request row (not served, not a candidate, not decidable); `POST /api/images/generate {conversationId, messageId}` -> candidate, message ready, /media/:id 200, a second call 409; owner-triggered generate with a description -> candidate, approve -> scene; reject -> 404 after; a further stub photo -> 422 blacklisted, message failed, retry allowed; `[[EMDASH]]` -> repaired flag and no em dash stored; operator channel not in story context; proposals row appears after a turn with `[[FACT:...]]`; export -> import roundtrip equality on facts/history/state; /api/assets/verify all PASS; budget cap 0 -> 402; then a second `wrangler dev` phase with `ACCESS_AUD` set: no token -> 401 with the dev actor off, garbage token or cookie -> 403, client email header -> 401, static files and /media gated. (`wrangler.jsonc` pins `dev.host` to 127.0.0.1: with the custom-domain route configured, wrangler dev would otherwise rewrite every local request's origin to the route host and the local actor rule could never match.)
- Behavior (`tests/behavior`): scenarios.json (22 owner scenarios + 15 pressure tests), runner posts each as a fresh conversation against a base URL and provider, writes transcripts, automated flag counts and rubric per scenario to `reports/`.

Stub provider triggers (text): user content containing `[[FAIL]]` throws ProviderError(server, retryable); `[[REFUSE]]` returns stopReason refusal; `[[EMDASH]]` returns a reply containing an em dash; `[[LIST]]` returns a markdown list; `[[PHOTO]]` returns a reply ending with a `[photo: ...]` line; `[[QUESTION]]` returns a reply ending in "?"; `[[FACT:x]]` makes the proposal stub emit one avelie_fact proposal "x"; otherwise returns a short plain lowercase line that echoes two words of the user text.
