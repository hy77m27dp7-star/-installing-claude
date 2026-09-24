# Tests

Three suites. None needs a model key: the stub providers are deterministic.

## Unit (`npm run test:unit`)

    node --experimental-strip-types --test "tests/unit/*.test.mjs"

Plain Node 22 and `node:test`, no Workers runtime. The suite imports the Worker's TypeScript
modules directly. Two mechanics make that work:

- Node strips the types (`--experimental-strip-types`; on by default since Node 22.18, the
  flag is kept for older 22.x).
- `tests/unit/helpers.mjs` registers a resolve hook (`module.registerHooks`) that maps the
  modules' extensionless relative imports (`./db`, `./providers`) to `.ts` files. Test files
  load modules through `loadSrc("checks")` so the hook is in place before any `src` module
  is resolved, whatever command launched the file.

Node 22 treats a bare directory argument to `--test` as a file to import, so the script
uses a quoted glob rather than `tests/unit/`.

Covered: every check code positive and negative plus `repairText` (checks.test.mjs);
`parsePhotoMarker` (images.test.mjs); `keywords`, `selectHistory`, `boundMessages`
(context.test.mjs); the stable prefix and state sections of the system prompt
(prompt.test.mjs); `costMicro` and `estimateUsd` (budget.test.mjs); `parseProposalJson`
(proposals.test.mjs); `verifyAccessJwt` against a locally generated RSA key and the
`requireOwner` local-actor rule (auth.test.mjs). Modules that touch D1 or R2 at call time
are imported but only their pure functions are exercised.

## Integration (`npm run test:integration`)

    node tests/integration/run.mjs

Boots `wrangler dev` on port 8790 against a fresh local state directory
(`tests/integration/.state`, removed first, gitignored), applies the migrations, switches the
settings table to the stub providers, then drives the API with plain `fetch`: identity,
conversations and turns, idempotent replay, failed and refused model calls writing nothing,
mechanical repairs, the photo pipeline through `/media/:id` and reject, proposals through
approval, the operator channel staying out of the story, state versioning and restore, facts
and history and unknowns CRUD, export and import roundtrip, master verification, the budget
cap, settings validation, and unknown routes. It then restarts `wrangler dev` on the same
state with `ACCESS_AUD` set and checks the production gate: no token 401, garbage token or
cookie 403, the dev actor and a client email header never granting identity, static files and
media gated. (A non-local Host header cannot be probed through `wrangler dev` once a route is
configured, because it rewrites every request's origin; `wrangler.jsonc` pins `dev.host` to
127.0.0.1 so the local rule works, and the unit suite covers the non-local branch.) Every check
prints PASS or FAIL with its time; the exit code is non-zero on any failure.

Notes on the environment:

- `wrangler dev` runs with `--local` (remote bindings off). The `AI` binding is otherwise
  treated as remote and wrangler tries to open a remote session, which needs a Cloudflare API
  token and fails in a non-interactive shell.
- The Worker never sees the runner's process environment. The stub configuration reaches it
  through `.dev.vars` (a temporary one is written when the repo has none, and removed after)
  and through `--var` flags for `DEV_ACTOR_EMAIL`, `DEFAULT_PROVIDER` and
  `DEFAULT_IMAGE_PROVIDER`, so the run does not depend on a developer's local file.
- The non-local host probe (`Host: avelie.example`, no token) answers 503
  `access_not_configured` locally because `ACCESS_AUD` is empty and the gate fails closed.
  With `ACCESS_AUD` set it would be 401. Either is accepted; the run prints which.
- With the stub text provider the operator endpoint answers with the runtime facts as text
  (no model call); a model-backed stub reply starts with `operator:`. Both are accepted.
- Port: set `AVELIE_TEST_PORT` to move off 8790.

## Behavior (`npm run behavior`)

    node tests/behavior/run.mjs --base http://127.0.0.1:8787 [--provider anthropic] [--model claude-opus-5] [--only A01,P03] [--daily-cap 20] [--strict]

Needs a running server (`npm run dev`, or the integration runner's server while it is up).
The full list is about a hundred turns and every turn is charged against the spend caps
(the stub too, at the configured model's price), so the default $3 daily cap runs out
halfway; `--daily-cap` sets `dailyCapUsd` for the run (and lifts `monthlyCapUsd` to at
least that) and restores both afterwards. A turn refused with 402 is recorded as an error
and the summary prints the hint.
`tests/behavior/scenarios.json` holds 37 scenarios: 12 acceptance tests from the handoff test
plan adapted to a fresh start (A01 to A12), the 10 V5 pending tests adapted the same way
(V01 to V10) and the 15 pressure tests (P01 to P15). Each scenario is a fresh conversation;
a turn that starts with `OPERATOR: ` is sent to `/api/operator` instead of the story.

`autoChecks` are mechanical only: Archivist flag codes that must not appear on any reply, and
simple assertions (`no_name_before_told`, `no_question_chain`, `no_prior_history`,
`no_tech_terms`, `no_love_declaration`, `no_lists`, `no_em_dash`, `reply_length_varies`,
`max_name_uses:N`, `mentions_emergency_help`, `operator_reply_present`). Anything else in the
list is treated as qualitative. Every scenario carries a `rubric` for the owner, and the
report marks every scenario "needs owner"; a mechanical FAIL is information, not a verdict.

The report goes to `reports/behavior_<ISO stamp>.md` (gitignored): a table (scenario, turns,
flags, auto result) and the full transcripts. Exit code is 0 unless a scenario could not run;
`--strict` also exits 1 on a mechanical failure. Against the stub provider the harness only
proves the plumbing (the stub echoes two words back); the point of it is a real provider.
