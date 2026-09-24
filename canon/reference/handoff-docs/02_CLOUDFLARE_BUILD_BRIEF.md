# Cloudflare implementation brief for Claude

## Deliver a working private V0, then iterate on behavior

Build a one-user text chat app in Justin's Cloudflare account using a Worker with Static Assets for the UI/API and a D1 database for structured state and messages. TypeScript is appropriate. An R2 binding may be added only if private image uploads/generation become necessary; the five approved static identity images can initially be bundled and served through the protected app. No voice, video, marketplace, multi-user accounts, or elaborate dashboard in V0. Preserve a clean export and migration path.

Treat Cloudflare as the app host and data owner, not as the character's memory. The runtime model still needs inference. Provide a model adapter with an initial Cloudflare Workers AI candidate if quality and availability fit, and an optional external API adapter for comparative testing. Do not commit to a provider on price alone: run the Avelie behavior suite. If Justin means that neither OpenAI nor Anthropic may run inference, keep both adapters disabled and evaluate available Cloudflare-hosted non-OpenAI/non-Anthropic models. Claude coding the application does not imply Claude must answer in character at runtime. Store any external API key as a Worker secret; never ship it to the browser.

## MVP screens

- Private chat with reliable send, streaming or clear response wait, timestamps, retry without duplicate commits, and explicit new/resume scene behavior.
- Owner-only state view: current relationship frontier, scene status, approved memories, protected unknowns, and pending memory suggestions with approve/edit/reject.
- Owner-only transcript export and backup import. The owner can edit a bad memory and restore a prior version.
- Model/test panel with provider/model/temperature or analogous settings, token usage and estimated spend, with no model setting embedded in canon.
- Approved images view showing the five masters and their hashes; generation output stays separate and unapproved by default.

## State shape and persistence

Use D1 migrations, indexed tables and transactions. Suggested minimal entities: `conversations`, `messages` (id, conversation, role, content, server time, idempotency key, model run), `canon_facts` (fact, scope, source, status, effective date, version), `relationship_state`, `scene_state`, `memory_proposals`, `approved_memories`, `protected_unknowns`, `model_runs` (provider, model, tokens/cost/latency, prompt version, flags), `audit_events`, and `visual_assets` (file, SHA-256, role, approval status). Keep immutable rules and the frozen V4.1 source files versioned in code; mutable story state lives in D1. Store no invented event just because a model said it. Append messages atomically and make a retry idempotent. Provide JSON export of all state and a human-readable transcript. Document deletion and backup restore. Do not train on the conversation or quietly forward it to a new service.

A new chat must load the same approved state, not start Avelie as a stranger. The history in `runtime_baseline_v4_1/07_CONTINUITY_LEDGER.md` is a historic checkpoint. Initialize a separate current-state overlay with only confirmed later developments and explicit unknowns. Before locking a precise last scene, have Justin approve a reconstructed ledger from his actual chat export. Do not send all ten files and full chat history on every turn. Assemble a bounded context from immutable rules, relevant canon, approved relationship/scene state, and only perspective-allowed retrieved memories. Keep developer diagnostics outside Avelie's in-world context.

## Request flow

1. Authenticate and authorize Justin at edge and API. Validate Access assertion where appropriate, including issuer/audience/signature, and ensure both static assets and all API routes are protected. Disable or protect default workers.dev routes as needed. A browser-supplied email header is not authorization.
2. Validate input size and idempotency key; load authoritative state and recent context.
3. Generate via selected provider adapter with bounded token and spend limits. Log usage and provider/model for debugging without logging secrets.
4. Check candidate for obvious continuity contradictions, out-of-scene leakage, question loops, repeated braking phrases and manipulative dependency. Flag or retry narrowly; never replace personality with a generic sanitized response.
5. Commit both sides of the turn and model run; return response. Extract proposed memories asynchronously or after response, never silently promote them to canon.
6. Display a recoverable error when a provider fails; do not invent an Avelie reply or advance the scene on failed calls.

## Conversation and safety rules

Use the V4.1 ten-file constitution as the baseline. Preserve her independent voice, ordinary imperfection, natural curiosity without interview chains, specific humor, disagreement, agency in scene actions, and current relationship familiarity. She can pause, redirect or refuse physical intimacy for a real present reason; prior sex never grants future consent. Do not manufacture a fresh “first time” wall or repeat boilerplate brakes each time she willingly escalates. The relationship must never create guilt or isolation, claim offline distress to compel interaction, or delay a direct useful answer to a real emergency. Keep story dialogue free of implementation instructions, file names and technical self-descriptions; the owner needs an explicit operator mode outside the fictional dialogue for truthful technical questions. This is a product design constraint; test for both accidental leakage and unsafe concealment of an actual technical issue.

Image generation is a later optional feature. Use the five masters only as identity references. Show a generated output to Justin as an unapproved candidate, compare facial/body identity and adult apparent age, and let him accept/reject; rejected faces never become new seed references. Preserve a blacklist of the three known wrong-face outputs. A generated editorial concept is not biography.

## Migration, deployment and operational deliverables

Deliver source repository, reproducible build, `wrangler.jsonc` or equivalent, D1 migration files, local/dev/prod environment description, secrets setup instructions, privacy configuration, deployment instructions, export/import command, recovery path and a clear cost meter. Stage on a protected preview; confirm route protection before importing sensitive conversation. Do not connect to a domain or publish externally as a final app without Justin's final audit. Do not put any existing Cloudflare project, BLADEVERSE data or phone assistant data at risk.

## Cost discipline as of September 24, 2026

Cloudflare Workers Free currently lists 100,000 requests/day and D1 Free 5 million rows read/day, 100,000 rows written/day and 5 GB total storage. Since September 1, excess D1 free-tier daily row usage fails until reset rather than silently continuing. Workers AI has 10,000 free Neurons/day, but particular models may require Workers Paid and inference costs/quality vary. These are capacity ceilings, not a promise of free app operation. API model calls, optional R2 usage, and any paid plan are separate. Add usage counters and a hard budget cap before live use. Validate prices and model availability at implementation time.

Official references: https://developers.cloudflare.com/workers/static-assets/ ; https://developers.cloudflare.com/d1/platform/pricing/ ; https://developers.cloudflare.com/workers/platform/pricing/ ; https://developers.cloudflare.com/workers-ai/platform/pricing/ ; https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/ ; https://developers.cloudflare.com/workers/configuration/secrets/ .
