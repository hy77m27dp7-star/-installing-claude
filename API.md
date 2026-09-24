# Avelie runtime -- API (v1)

All routes require the owner (Cloudflare Access JWT, or the local dev actor). Responses are JSON unless noted. Errors: `{ error, code, retryable?, detail? }` with the HTTP status. Timestamps are ISO 8601 UTC. Money is USD (numbers), stored as micro-USD integers.

## Identity and system

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /api/me | | `{ email, env }` |
| GET | /api/system | | `{ constitutionVersion, promptVersion, settings (no secrets), providerKeys: { anthropic: bool, openai: bool }, counts: { conversations, messages, facts, history, unknowns, pendingProposals, candidates }, spend: { todayUsd, monthUsd, dailyCapUsd, monthlyCapUsd }, state: { relationship, scene } }` |

## Conversations and turns

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /api/conversations | | `ConversationRow[]` |
| POST | /api/conversations | `{ title? }` | `ConversationRow` (201) |
| GET | /api/conversations/:id/messages | `?channel=story|operator` | `MessageRow[]` (asc) |
| DELETE | /api/conversations/:id | | `{ ok }` (status deleted; messages kept; audit) |
| POST | /api/conversations/:id/turn | `{ content, idempotencyKey }` | `TurnResponse` (see types.ts) |
| GET | /api/messages/:id | | `MessageRow` (`image_status`: pending, ready, failed or rejected; `image_id` names the photo request / candidate row) |
| POST | /api/operator | `{ content, conversationId? }` | `{ reply, info }` |

Turn error codes: `validation` 400, `not_found` 404, `budget_exceeded` 402, `provider_failed` 502 (retryable true/false), `provider_refused` 502 (retryable false), `provider_not_configured` 503.

## State

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /api/state | | `{ relationship: {version, state}, scene: {version, state}, facts: { fixed, avelie, justin }, history, unknowns, hasSharedHistory }` |
| PUT | /api/state/relationship | `{ state, note? }` | `{ version, state }` |
| PUT | /api/state/scene | `{ state, note? }` | `{ version, state }` |
| GET | /api/state/versions/:entity | | `StateVersionRow[]` (desc) |
| POST | /api/state/restore | `{ entity, version }` | `{ version, state }` |
| POST | /api/facts | `{ scope, subject?, fact, source?, disclosed?, provisional? }` | `FactRow` (201) |
| PUT | /api/facts/:id | `{ fact?, subject?, disclosed?, provisional?, source? }` | `FactRow` (new version) |
| DELETE | /api/facts/:id | | `{ ok }` (superseded with status rejected) |
| POST | /api/facts/:id/restore | | `FactRow` |
| GET | /api/facts/:id/versions | | `FactRow[]` (the supersedes chain) |
| POST | /api/history | `{ title, occurred?, body, what_changed?, keep_consistent?, source? }` | `HistoryRow` (201) |
| PUT | /api/history/:id | same fields, partial | `HistoryRow` (new version) |
| DELETE | /api/history/:id | | `{ ok }` |
| POST | /api/history/:id/restore | | `HistoryRow` |
| POST | /api/unknowns | `{ topic, note? }` | `UnknownRow` (201) |
| PUT | /api/unknowns/:id | `{ status?, note?, resolution? }` | `UnknownRow` |

Fixed-scope facts are read-only through the API (403 `fixed_canon`).

## Proposals

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /api/proposals | `?status=pending` (default pending) | `ProposalRow[]` |
| POST | /api/proposals/:id/decide | `{ decision: "approve"|"reject"|"edit", edited?: { proposal, kind? }, note? }` | `{ proposal: ProposalRow, promotedId? }` |

## Settings and usage

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /api/settings | | `Settings` |
| PUT | /api/settings | partial `Settings` | `Settings` (validated: provider in set, effort in set, 0<=temperature<=2, 64<=maxTokens<=4000, caps >= 0) |
| GET | /api/usage | | `{ todayUsd, monthUsd, dailyCapUsd, monthlyCapUsd, byDay: [...] }` |
| GET | /api/audit | `?limit=100` | `audit_events[]` (desc) |

## Images

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /api/assets | | `{ masters, candidates, scenes, rejected, archive }` (VisualAssetRow lists) |
| POST | /api/assets/verify | | `{ results: [{ id, file, expected, actual, ok }], allOk }` (masters only, hashed from ASSETS) |
| POST | /api/images/generate | `{ conversationId, messageId?, description? }` | `{ asset: VisualAssetRow }`. With `description`: owner-triggered, same pipeline as the marker (attached to `messageId` when given). With `messageId` alone: resumes the photo request her message recorded; the page holds this request open for the whole image call (Workers cut background work off 30 s after a response, so the photo is never made in the background). 409 `in_progress` while another request holds it, 409 `already_generated` once the picture exists, 422 `blacklisted`, 402 / 502 / 503 as for turns; any failure leaves the message `image_status` failed and the request retryable. |
| POST | /api/images/:id/decide | `{ decision: "approve"|"reject", note? }` | `{ asset }` |
| GET | /media/:id | | image/png (candidate or approved only; 404 otherwise) |

## Export / import

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | /api/export | | export JSON (see SPEC) |
| GET | /api/export/transcript/:conversationId | | text/plain |
| POST | /api/import | export JSON | `{ ok, snapshotId, counts }` |

## Static

Everything under `/` not matching `/api/*` or `/media/*` is served from `public/` through the ASSETS binding, after auth. `/` -> `index.html`.
