# Architecture

One Cloudflare Worker, one D1 database, one R2 bucket, static assets served through the Worker. TypeScript, strict, ESM, no Node-only APIs in `src/`. The character survives the model: her rules are code, her memory is rows, the model is a performer behind an adapter.

## Request flow

1. A request arrives at `src/index.ts`. Before anything else, `requireOwner` in `src/auth.ts` checks the identity. A failure is returned as a JSON 401, 403 or 503 and nothing else runs. This includes static pages and images.
2. `/api/*` goes to the route table in `src/api.ts`. `/media/:id` goes to `serveMedia`. Everything else goes to the ASSETS binding, which serves `public/` (the root serves `index.html`).
3. A story turn is `POST /api/conversations/:id/turn` with `content` and an `idempotencyKey`. `runTurn` in `src/chat.ts` validates both (content 1 to 4000 characters, key 8 to 80) and loads the conversation.
4. Idempotency. If a user message with this key already has a reply, the stored pair comes back with `replayed: true` and no model call is made. If the message exists without a reply (the app died mid-turn), the turn continues with that message.
5. Context. `assembleContext` in `src/context.ts` loads the last 40 story messages (bounded to 24,000 characters), the approved facts, the history entries that matter for the recent text, the open unknowns, and the current relationship and scene versions, and builds the system prompt.
6. Budget. The prompt size gives an estimate; `assertBudget` compares today's and this month's spend plus the estimate against the two caps. Over a cap: 402, nothing written.
7. Generate. The provider named in settings is called with the system prompt, the messages, the model, max tokens and effort. A thrown provider error or a refusal writes one failed run row and returns 502. No message is written and the scene does not move.
8. Photo marker. `parsePhotoMarker` removes a final `[photo: ...]` line and keeps its description.
9. Checks. `runChecks` returns flags and an action. Retry means one more call with a corrective note; repair means a mechanical cleanup. See docs/BEHAVIOR.md.
10. Commit. One `db.batch`: the user message, the run row (and the retry's run row), the assistant message with its flags, the conversation timestamp, the usage row, and, when a photo was asked for, the photo request (a `visual_assets` row with status `pending` and the description as its prompt) with the message pointing at it (`image_id`, `image_status: "pending"`). Either everything lands or nothing does.
11. Respond with the `TurnResponse`: both messages, the run summary with cost, the flags, `imagePending`.
12. After the response, in `ctx.waitUntil`: the proposal pass runs if proposals are on. Best effort; a failure is logged as a run and swallowed. The turn is already committed. The photo is not made here: Workers cancel `waitUntil` work 30 seconds after the response is sent and an image call takes longer, so the Chat page asks for it with its own request (next section).

The operator channel (`POST /api/operator`) is a separate path in `src/operator.ts`. It answers with deterministic facts from `systemInfo` and, on a real provider, one model call under the operator prompt. Its messages are stored with channel `operator` and are never read by story context assembly.

## Prompt layout

`src/prompt.ts` builds the system prompt in two parts.

The stable prefix comes first: the always-on rules, the runtime overlay, and the reference files (core identity, relationship and evolution, text and style, conflict and boundaries, tastes and visual canon, knowledge boundary). It is assembled from `src/generated/constitution.ts`, which `scripts/build_constitution.mjs` produces from the frozen files in `canon/constitution` plus the adaptation list (22 replaces 24, the music list is removed, and so on). The prefix is identical bytes every turn. The Anthropic adapter sends it as one system block with a cache breakpoint, so repeat turns read it from the cache.

The state sections follow, from D1, approved rows only: fixed canon; things true about her, split into told and untold; what she knows about him (only what he said); shared history; the current relationship and scene JSON; open unknowns; and, while shared history is empty, the first-conversation file. The prompt version is the constitution version plus a prompt revision suffix, and it is stored on every run.

Nothing the model said last turn is in the prompt except as ordinary conversation messages. Developer notes, flags and operator messages never enter it.

## Memory model

Every durable thing is a row, every change is a new row, every write is audited.

- Facts (`facts`): scope fixed, avelie, justin or shared. Fixed rows are read-only through the API (403 fixed_canon). Avelie facts carry `disclosed` (has she said it out loud) and `provisional`. An edit inserts a new version with `supersedes_id` and marks the old row superseded; delete is a supersede with status rejected; restore inserts a copy of an old version as the newest.
- History (`history`): the shared timeline, ordered by `seq`, with title, when, body, what changed, what to keep consistent. Same versioning as facts. It is empty now; when it stops being empty, the first-conversation section leaves the prompt and the first_meeting_replay check turns on.
- Unknowns (`unknowns`): real gaps she must not resolve by guessing. Open or resolved, with a resolution note.
- State versions (`state_versions`): relationship and scene are append-only JSON versions. Save appends; restore appends a copy of the chosen version. The prompt always reads the newest.
- Proposals (`proposals`): what the proposal pass thinks was durable in one exchange, with the kind, the quote it rests on, and a confidence. Pending until you approve, edit or reject in the inbox. Approval promotes through the state helpers above, so a promoted fact is versioned and audited like a hand-written one. Duplicates of pending proposals and approved facts are dropped on the way in.
- Audit (`audit_events`): actor, action, entity, before and after JSON, for every write that changes canon, state, images or settings.
- Runs (`model_runs`): every model call, including failed and refused ones, with provider, model, prompt version, tokens, cost, latency, status and flags. The error field holds a class, never a message that could echo a key.
- Snapshots (`snapshots`): the full export taken automatically before an import replaces anything.

## Image pipeline

She asks for a photo by ending a reply with one line: `[photo: what it shows, outfit, place, expression, selfie or taken by someone]`. The line is removed before the message is stored or shown; only the description survives.

1. The turn commits the request: a `visual_assets` row with status `pending` holding the description, and the message with `image_status: "pending"` and `image_id` naming that row. The Chat page shows a placeholder and sends `POST /api/images/generate { conversationId, messageId }`, and keeps that request open until the picture exists. A request the page holds open has no time limit; background work in a Worker is cancelled 30 seconds after the response, which is why the photo is never made in the background. A reload resumes any message still pending. If another request already holds the picture (a second tab, an earlier attempt), the server answers 409 `in_progress` and the page polls the message every 3 seconds for up to 2 minutes instead.
2. `generateCandidate` in `src/images.ts` claims the request (status `generating`, with a timestamp; a claim older than four minutes counts as abandoned and is taken over), then checks that the image provider is configured, checks the budget with the flat photo price, and loads the five masters through the ASSETS binding. Each master's bytes are hashed and compared to the registry; a master that has drifted stops the run, because a wrong reference is worse than no photo.
3. The prompt is the fixed identity block from `imageIdentityPrompt()` (her face, hair, skin, build, age 22, candid phone-photo style, no text, no collage) followed by ` Scene: ` and her description. Only outfit, setting, pose, expression and lighting vary.
4. The OpenAI adapter posts a multipart request to `images/edits` with the model, the prompt, size, quality, `n=1`, and the five masters as `image[]` PNG blobs, with a 180 second timeout. It reads `data[0].b64_json` and decodes it. 401 is an auth error, 429 is a rate limit, 400 (including a content policy refusal) is a non-retryable bad request, 5xx is a server error. Locally the stub adapter returns master 03's bytes so the whole path runs without a key.
5. The result is hashed. If the hash matches any rejected asset, the candidate is refused (422 blacklisted) and never stored.
6. The PNG goes to R2 as `candidates/<id>.png`. One batch then turns the request row into the candidate (status candidate, hash, size, provider, model), writes the run row with the photo cost, the usage row, an audit event, and sets the message's `image_status: "ready"`.
7. On any failure the run row is written as failed, the request row becomes `failed` with the reason in its notes, and the message's `image_status` becomes `failed`; the Chat page shows the error code and a Retry control that re-requests the same description. Her text reply is already stored and stays.
8. `GET /media/:id` streams the PNG from R2, only for a candidate or an approved scene image, with `cache-control: private, no-store`. Anything else is 404.
9. Approve sets status approved and role scene; the message keeps its picture. Reject deletes the R2 object, keeps the row with its hash so the blacklist persists, and sets the message's `image_status` to `rejected` so the Chat page hides it.

You can also ask for a photo yourself with `POST /api/images/generate` and a description; it is the same pipeline. `POST /api/assets/verify` hashes the five masters from ASSETS and compares them with the registry; the Images page has the button.

## Auth

Every request, including static assets and `/media`, passes `requireOwner` first. There are exactly two ways in.

Production: the request carries the Access JWT in the `CF-Access-Jwt-Assertion` header or the `CF_Authorization` cookie. The Worker fetches the team's JWKS from `https://<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs` (cached in memory; refetched when a token names an unknown key id, at most once a minute, and in any case once a day), verifies the RS256 signature with `crypto.subtle`, and checks the issuer is `https://<ACCESS_TEAM_DOMAIN>`, the audience contains `ACCESS_AUD`, the token has not expired, and the email equals `OWNER_EMAIL` case-insensitively. Anything else is 403. If the JWKS cannot be fetched and nothing is cached, 503.

Local: only when `ACCESS_AUD` is empty, the request host is `localhost` or `127.0.0.1`, and `DEV_ACTOR_EMAIL` is set in `.dev.vars`. Then the actor is that email. Production never has `DEV_ACTOR_EMAIL`.

With `ACCESS_AUD` empty and no local actor, every request is 503 "access not configured". The Worker fails closed. No header from the browser is ever trusted as an identity, and nothing in `src/auth.ts` logs a header, a token or a key.

## Provider adapter

Settings name a text provider (anthropic, openai, workersai, stub) and an image provider (openai, stub). `src/providers/index.ts` hands back the adapter and says whether the environment holds what it needs: the stub and Workers AI need nothing; Anthropic needs `ANTHROPIC_API_KEY`; OpenAI needs `OPENAI_API_KEY`. Every adapter maps its own errors into one `ProviderError` with a kind (auth, rate_limit, bad_request, server, network, config) and a retryable flag, so the turn pipeline never sees a raw SDK error and never logs one.

Anthropic (`src/providers/anthropic.ts`): the official SDK. The system prompt goes as one text block with `cache_control: { type: "ephemeral" }`, the messages follow, `max_tokens` is the settings value, and `output_config.effort` is the settings effort. Thinking is left at the model default. Input tokens are counted as `input_tokens` plus `cache_read_input_tokens` plus `cache_creation_input_tokens`, so the meter sees every token the model read. Stop reason `refusal` becomes a refused run, `max_tokens` is passed through, anything else is a normal end.

Temperature is never sent to Anthropic, and neither is top_p or top_k. The exact reason: Claude Opus 5, Claude Sonnet 5, Opus 4.7, Opus 4.8 and the Fable models reject sampling parameters with an HTTP 400 invalid_request_error. A request carrying `temperature` would fail on every turn, which the pipeline would record as a failed run with no reply. On these models `output_config.effort` is the only depth control, and that is what the Model panel's effort setting maps to. The temperature field in the Model panel still applies to the OpenAI and Workers AI adapters, which accept it.

OpenAI text (`src/providers/openai.ts`): `POST /v1/chat/completions` over fetch with a system message, the messages, `temperature` and `max_completion_tokens`. `finish_reason: "content_filter"` or a refusal field is a refusal; `"length"` is max_tokens. The images adapter lives in the same file and is described above.

Workers AI (`src/providers/workersai.ts`): `env.AI.run(model, { messages, max_tokens, temperature })`. Accepts a string or `{ response }` result. Token counts are zero when the runtime does not report them, so the meter cannot price it; it is for comparison, not for the daily meter.

Stub (`src/providers/stub.ts`): deterministic and key-free. Markers in the last user message drive it (`[[FAIL]]`, `[[REFUSE]]`, `[[EMDASH]]`, `[[LIST]]`, `[[PHOTO]]`, `[[QUESTION]]`, `[[LONG]]`, `[[NAME:x]]`, `[[FACT:x]]`); otherwise it echoes two words of the input in a short lowercase line. The stub image provider returns master 03's bytes. The integration suite runs on it.

Switching providers changes only the performer. The prompt, the checks, the memory tables and the caps are the same for all of them.
