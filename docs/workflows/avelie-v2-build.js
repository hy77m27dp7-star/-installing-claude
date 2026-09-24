export const meta = {
  name: 'avelie-v2-build',
  description: 'Build Avelie v2 (her life, timing, callbacks, provenance, songs, consequences, cron) against SPEC_V2.md on top of the verified v1',
  phases: [
    { title: 'Build', detail: 'six agents on disjoint files' },
    { title: 'Integrate', detail: 'one agent makes everything green again' },
    { title: 'Review', detail: 'adversarial reviewers, read-only' },
    { title: 'Fix', detail: 'apply confirmed findings, rerun tests' },
    { title: 'Verify', detail: 'independent final verification' },
  ],
}

// Pass the clone's absolute path as args.repo (on Justin's Mac: /Users/justinnewsome/Documents/ClaudeCode/2026-09-24_avelie).
const REPO = (typeof args === 'object' && args && args.repo) ? args.repo : '/home/user/-installing-claude'

const COMMON = `You are extending the Avelie runtime in ${REPO} (git branch claude/modest-dijkstra-ju73pw; do not commit or push). Work ONLY inside ${REPO}. HQ rituals (STATE.md, zips) are the main session's job at the end, not yours. v1 is complete and green: npm test (build:canon, typography, assets, tsc, unit) and npm run test:integration pass. Keep them passing.

READ FIRST: ${REPO}/SPEC_V2.md (your assignment lives there), then ${REPO}/SPEC.md, ${REPO}/API.md, ${REPO}/src/types.ts, ${REPO}/src/db.ts, ${REPO}/src/prompt.ts, ${REPO}/src/context.ts, ${REPO}/src/chat.ts, ${REPO}/src/api.ts, ${REPO}/src/proposals.ts, ${REPO}/src/state.ts, ${REPO}/src/images.ts, ${REPO}/src/providers/stub.ts, ${REPO}/tests/integration/run.mjs, ${REPO}/public/js/chat.js. Do not edit src/generated/constitution.ts by hand (scripts/build_constitution.mjs generates it; if the runtime overlay needs the song rule, add it in that script with the same guarded style and rerun npm run build:canon). Never edit canon/constitution/* or public/images/*.

HARD RULES: typography " -- " and "..." only, never an em dash, en dash or Unicode ellipsis anywhere (node scripts/check_typography.mjs must stay clean). No secrets in code, logs, responses or the browser. She is a person: story-channel text never mentions prompts, models, the app. Nothing becomes canon because a model said it. No retention hooks: no scheduled "miss you", no streaks, no guilt, no sadness while the app is closed. TypeScript strict with noUncheckedIndexedAccess; npx tsc --noEmit must pass for your files. Workers runtime only in src/ (no Node-only APIs). No prose in the UI: labels only.

NEW MODULE CONTRACT (exact names; everyone codes against these):

src/markers.ts
  export function parsePhotoMarker(text: string): { clean: string; description: string | null }   // moved from images.ts; images.ts re-exports it
  export function parseSongMarker(text: string): { clean: string; song: { artist: string; title: string; searchUrl: string } | null }
  export function stripMarkers(text: string): { clean: string; photo: string | null; song: { artist: string; title: string; searchUrl: string } | null }
src/life.ts
  export interface LifeThread { id: string; kind: "routine"|"event"|"person"|"place"|"arc"; title: string; detail: string | null; schedule_json: string | null; status: "active"|"done"|"dropped"|"superseded"; relation: string | null; source: string | null; version: number; supersedes_id: string | null; created_at: string; updated_at: string }
  export interface LifeLog { id: string; thread_id: string | null; occurred: string; note: string; source: string | null; created_at: string }
  export async function listThreads(db: D1Database, status?: string): Promise<LifeThread[]>
  export async function createThread(db: D1Database, input: { kind: LifeThread["kind"]; title: string; detail?: string | null; schedule_json?: string | null; relation?: string | null; source?: string | null }, actor: string): Promise<LifeThread>
  export async function updateThread(db: D1Database, id: string, patch: Partial<{ title: string; detail: string | null; schedule_json: string | null; relation: string | null; status: "active"|"done" }>, actor: string): Promise<LifeThread>   // versioned like facts
  export async function dropThread(db: D1Database, id: string, actor: string): Promise<void>
  export async function restoreThread(db: D1Database, id: string, actor: string): Promise<LifeThread>
  export async function listLog(db: D1Database, limit?: number): Promise<LifeLog[]>
  export async function logLife(db: D1Database, threadId: string | null, occurred: string, note: string, source: string | null, actor: string): Promise<LifeLog>
  export function whereSheIs(threads: LifeThread[], now: Date, tz: string): { busy: boolean; label: string | null; until: Date | null }   // pure
  export function lifeSection(threads: LifeThread[], log: LifeLog[], now: Date, tz: string): string   // pure
  export function computeDeliverAt(threads: LifeThread[], now: Date, tz: string, maxMinutes: number, seed: string): Date   // pure; SPEC_V2 section B; deterministic jitter from seed
src/callbacks.ts
  export function pickCallbacks(args: { history: HistoryRow[]; threads: LifeThread[]; log: LifeLog[]; recentTexts: string[]; now: Date; seed: string }): Array<{ text: string; ageDays: number; sourceId: string }>   // pure, max 2
  export function callbacksSection(items: ReturnType<typeof pickCallbacks>): string
src/provenance.ts
  export async function writeContext(db: D1Database, messageId: string, ctx: Record<string, unknown>): Promise<void>
  export async function readContext(db: D1Database, messageId: string): Promise<Record<string, unknown> | null>
src/drift.ts
  export async function runDrift(env: Env, db: D1Database, settings: Settings): Promise<{ id: string; ranAt: string; summary: Record<string, unknown> }>   // uses scenarios tagged drift:true from a bundled JSON (import tests/behavior/scenarios.json via a generated src/generated/drift_scenarios.ts written by scripts/build_drift.mjs, or embed the 5 scenarios in src/drift.ts; either is fine, say which)
  export async function listDrift(db: D1Database, limit?: number): Promise<Array<{ id: string; ran_at: string; provider: string | null; model: string | null; prompt_version: string | null; json: string }>>
src/backup.ts
  export async function runBackup(env: Env, db: D1Database): Promise<{ key: string; bytes: number; kept: number }>   // exportAll -> R2 backups/avelie-<date>.json, keep last 30
src/chat.ts (extend)
  runTurn gains: song marker handling (messages.song_json), deliver_at in real mode (computeDeliverAt), message_context write (provenance.writeContext) with the ids used, and an optional opts argument: runTurn(env, ctx, db, settings, conversationId, content, idempotencyKey, actor, opts?: { openerNote?: string })   // opts.openerNote appends the one-time operator note for /open and skips storing a user message (userMessage null in the response; TurnResponse.userMessage type becomes MessageRow | null)
src/prompt.ts (extend)
  stateSections gains MODE (together/apart), mood/cooling-off lines, the life section and the callbacks section; PromptState gains: mode, life: { threads, log, now, tz }, callbacks. Keep the stable prefix byte-identical to v1 except for the song rule added to the runtime overlay through scripts/build_constitution.mjs.
src/index.ts (extend)
  export default { fetch, scheduled }: scheduled dispatches on event.cron: "0 7 * * *" -> runBackup; "0 13 * * 1" -> runDrift when settings.driftCheckEnabled.

Settings additions in types.ts/db.ts DEFAULT_SETTINGS and canon/seed/settings.json: replyDelayMode "instant", realDelayMaxMinutes 6, driftCheckEnabled false, timezone "America/New_York". Migration migrations/0003_life.sql exactly as SPEC_V2 section F (plus the two ALTER TABLE lines). The live D1 in the owner's account already has 0001 and 0002 applied; 0003 will be applied by the owner's deploy step, so it must be idempotent-safe to run once and must not touch existing rows.

Return a plain-text report: files written, deviations from the contract with reasons, anything you could not do.`

const L1 = `${COMMON}

YOUR ASSIGNMENT (agent L1, write ONLY): src/markers.ts, src/life.ts, src/callbacks.ts, src/provenance.ts, migrations/0003_life.sql, and the re-export line in src/images.ts (parsePhotoMarker now imported from ./markers and re-exported; move the implementation, keep behaviour identical). Pure functions must not import db.ts (so unit tests can import them under Node with --experimental-strip-types). Timezone math: use Intl.DateTimeFormat with timeZone to get weekday and HH:MM for now; do not pull a library.`

const L2 = `${COMMON}

YOUR ASSIGNMENT (agent L2, write ONLY): src/types.ts (additions only, keep every existing export), src/db.ts (DEFAULT_SETTINGS additions, a helper listMessagesVisible(db, conversationId, channel, now) that hides future deliver_at rows, and insert/select support for song_json and deliver_at), canon/seed/settings.json (the four new settings), scripts/build_constitution.mjs (add the SONGS rule to the runtime OVERLAY constant, same shape as PHOTOS: one line "[song: Artist - Title]" at most, only when she would actually send someone a song, her taste not his, stripped before display, never described twice; then run npm run build:canon), src/prompt.ts, src/context.ts, src/chat.ts, src/proposals.ts (kind "life" and the opinion supersede rule and the relationship mood/cooling_off payload; extraction prompt additions from SPEC_V2 F and J), src/state.ts (putState accepts mood and cooling_off_until; nothing else changes). Coordinate with L1's contract by name only (import from ./life, ./callbacks, ./markers, ./provenance); the files may not exist yet when you start, so write against the signatures above and run tsc at the end to confirm.`

const L3 = `${COMMON}

YOUR ASSIGNMENT (agent L3, write ONLY files under public/ except public/images/): public/js/bubbles.js (pure: export function splitBubbles(text) and export function bubbleDelayMs(text); must be importable under Node for the unit test, so no DOM access at module top level), public/js/chat.js (bubbles with timing per SPEC_V2 A, the bubbleTiming toggle, deliverAt handling per B, Together/Texting toggle per C writing PUT /api/state/scene, the Photos drawer per D, song cards per I, the "why" panel per L calling GET /api/messages/:id/context, the "Let her start" button per Q calling POST /api/conversations/:id/open, Regenerate under candidates per O), public/index.html and public/css/app.css (the new controls, still dark, still one accent, still no prose), public/js/state.js and public/state.html (Life tab per F with the weekly grid editor, the opinions filter per H, mood and cooling_off_until fields in the Now tab per J), public/js/model.js and public/model.html (the four new settings, the drift reports list per N with a Run now button), public/js/images.js and public/images.html (Regenerate). Every fetch must match the routes in SPEC_V2 "Routes added" and API.md. Phone width still works.`

const L4 = `${COMMON}

YOUR ASSIGNMENT (agent L4, write ONLY): src/api.ts (every route in SPEC_V2 "Routes added", plus GET /api/conversations/:id/messages honouring ?includePending=1 via db.listMessagesVisible; PUT /api/settings validating the four new settings: replyDelayMode in ["instant","real"], 1 <= realDelayMaxMinutes <= 120, driftCheckEnabled boolean, timezone a string accepted by Intl.DateTimeFormat), src/index.ts (scheduled handler; keep fetch behaviour), src/drift.ts, src/backup.ts, src/images.ts (POST /api/images/:id/regenerate support: a function regenerateImage(env, db, settings, id, actor) that rejects the candidate and calls generateCandidate again with the same description and message), wrangler.jsonc (add "triggers": { "crons": ["0 7 * * *", "0 13 * * 1"] }; touch nothing else), src/providers/stub.ts (the three stub additions from SPEC_V2 "Stub additions"; keep every v1 trigger). Import life/callbacks/provenance/markers by the contract names.`

const L5 = `${COMMON}

YOUR ASSIGNMENT (agent L5, write ONLY): tests/unit/*_v2.test.mjs (new files; do not edit v1 tests except to fix an import path if L1 moved parsePhotoMarker), tests/integration/run.mjs (append the v2 checks from SPEC_V2 "Tests added"; keep every v1 check; the runner must still exit non-zero on any failure), tests/behavior/scenarios.json (tag five existing scenarios "drift": true and add the four new scenarios from SPEC_V2; keep the schema the runner expects), tests/behavior/run.mjs (the --compare mode per SPEC_V2 M), tests/README.md (update). Unit tests import .ts files with --experimental-strip-types as v1 does; the bubbles test imports public/js/bubbles.js. Write the tests against the contract and SPEC_V2 even if the modules are not there yet; the integrator runs them.`

const L6 = `${COMMON}

YOUR ASSIGNMENT (agent L6, write ONLY): API.md (append a "v2" section with the routes table and the new settings), HANDOFF.md (update Status, What was built, Decisions, Next; keep the fixed sections), README.md (the new screens and controls in one line each; the cron jobs; the backup location), DEPLOY.md (add: apply migration 0003 with npm run db:remote after pulling; the two crons deploy with the Worker automatically; how to see backups in R2; how to turn the drift check on), docs/BEHAVIOR.md (the new flag codes song_marker_dup and callback_forced; the drift check; the vessel test), docs/ARCHITECTURE.md (life, callbacks, provenance, delivery delay, cron). Plain sentences, child-simple steps, the owner's typography, no AI-tell phrasing, no wrap-up lines.`

const L7 = `${COMMON}

YOUR ASSIGNMENT (agent L7, SPEC_V2 sections S, T, V; write ONLY): src/voice.ts (synthesize with providers elevenlabs | workersai | off, plus transcribe(env, settings, bytes, mime) using Workers AI @cf/openai/whisper or OpenAI audio transcriptions; a stub voice provider returning a tiny valid mp3 header buffer when settings.voiceProvider is "stub"), src/media.ts (library upload/list/delete/serve and resolveMediaTitle), src/vision.ts (helpers: loadInboxImages(env, keys) -> base64 blocks; used by providers), and the vision additions inside src/providers/anthropic.ts, src/providers/openai.ts, src/providers/workersai.ts, src/providers/stub.ts (ChatMessage.images support exactly as SPEC_V2 T; the stub replies "(photo received)" when images are present, and answers [[VOICE]] with a reply ending "[voice]" and [[MEDIA:title]] with a reply ending "[media: title]"). Extend src/markers.ts is NOT yours (L1 owns it): instead export from src/media.ts a parseMediaMarker(text) and from src/voice.ts a parseVoiceMarker(text), both pure, and tell the integrator to have L1's stripMarkers call them (or wire it yourself if src/markers.ts already exists when you finish, keeping L1's exports intact). Confirm the exact Workers AI model ids against Cloudflare docs (the search_cloudflare_documentation MCP tool is available through ToolSearch, or read node_modules/@cloudflare/workers-types for the Ai model catalogue types) and write the ids into DEFAULT_SETTINGS via a small exported constant that L2 can import, plus a note in your report.`

const L8 = `${COMMON}

YOUR ASSIGNMENT (agent L8, SPEC_V2 sections R and U; write ONLY): src/herfirst.ts (maybeTextFirst decision function as a pure decide(args) plus the impure runner; uses runTurn with openerNote per the L2 contract; hard-rejects dependency_hook), src/push.ts (VAPID ES256 JWT via crypto.subtle, empty-body Web Push, subscription CRUD), scripts/gen_vapid.mjs (Node: generate a P-256 key pair, print the public key base64url and the two wrangler secret put commands; never write the private key to a file), public/sw.js, public/manifest.webmanifest, public/icons/ (generate a 512x512 and 192x192 PNG with a tiny Node script using no dependencies: write a solid navy PNG with a teal "A" is hard without a library, so instead write a valid minimal PNG (solid navy square) programmatically with zlib from node:zlib and use maskable icons; note it in the report), and the four crons lines in wrangler.jsonc triggers (coordinate: L4 also edits wrangler.jsonc triggers; to avoid a clash, L4 writes triggers with all four crons: "0 7 * * *", "0 13 * * 1", "*/20 * * * *", "0 14 * * 1", and you do NOT touch wrangler.jsonc). Migration additions for first_texts_daily and push_subscriptions go into migrations/0003_life.sql, which L1 owns: write them into migrations/0003b_push.sql instead as a separate migration file. Expose from src/herfirst.ts: export function decideFirstText(args: { enabled: boolean; cap: number; countToday: number; now: Date; tz: string; quietHours: string; busy: boolean; lastMessageAt: Date | null; lastTwoAreHers: boolean; seed: string }): { send: boolean; reason: string }.`

const L9 = `${COMMON}

YOUR ASSIGNMENT (agent L9, SPEC_V2 sections X, Y, Z, W; write ONLY): src/timeline.ts (merge and sort with paging), src/voiceprint.ts (computeVoiceprint pure over rows + runner + list), src/exportCharacter.ts (JSON package and the markdown bible), migrations/0003c_voiceprint.sql (voiceprints table), public/timeline.html and public/js/timeline.js (read-only scroll per section X, dark, no prose), and the places picker data helper: export function placesForPicker(threads) in src/timeline.ts (L3 wires the picker). Routes are added by L4 per the "Routes added by these sections" table; you export the functions with these names: getTimeline(db, env, opts: { before?: string; limit?: number }), computeVoiceprint(rows, since, until), runVoiceprint(db, now), listVoiceprints(db, limit), exportCharacterJson(db, env), exportCharacterMarkdown(db, env).`

phase('Build')
const built = await parallel([
  () => agent(L1, { label: 'v2:life+callbacks+markers+provenance', phase: 'Build' }),
  () => agent(L2, { label: 'v2:prompt+context+chat+proposals', phase: 'Build' }),
  () => agent(L3 + `\n\nADDITIONAL UI SCOPE (SPEC_V2 sections R, S, T, U, V, W, X, Z): hold-to-record mic button and audio bubbles (his transcript with a mic chip; her audio player under her text); paperclip image attach with thumbnails and multipart turn submission (fall back to JSON when no images); service worker registration after a successful GET /api/me and a "Notifications" toggle in the Model page that subscribes through POST /api/push/subscribe with the key from GET /api/push/public-key; Library tab on the Images page (upload with title/description/kind, list, delete) and media cards under her messages (audio, video, image); places picker in the Together toggle from GET /api/life (kind place); Timeline nav link (L9 writes timeline.html; you add the nav entry in js/nav.js and every page header); the two character export buttons in the State Export tab; the her-first settings (herFirstTextsPerDay 0..10, quiet hours), voice settings (provider, mode, ElevenLabs voice id), transcribe provider on the Model page, plus a "Send one now" button calling POST /api/herfirst/run.`, { label: 'v2:ui', phase: 'Build' }),
  () => agent(L4 + `\n\nADDITIONAL API SCOPE: every route in SPEC_V2 "Routes added by these sections" (herfirst run, voice upload multipart with size limits, media audio/inbox/library serving with auth and no-store, multipart turn variant, push subscribe/unsubscribe/public-key/latest, media upload/list/delete, timeline, voiceprint run/list, character export json and md). Import the functions by the names in the L7, L8 and L9 contracts (src/voice.ts, src/media.ts, src/herfirst.ts, src/push.ts, src/timeline.ts, src/voiceprint.ts, src/exportCharacter.ts). scheduled(): also "*/20 * * * *" -> herfirst.maybeTextFirst and "0 14 * * 1" -> voiceprint.runVoiceprint. Write all four crons into wrangler.jsonc triggers. Validate the new settings in PUT /api/settings (herFirstTextsPerDay integer 0..10; herFirstQuietHours "HH:MM-HH:MM"; voiceProvider in ["elevenlabs","workersai","stub","off"]; voiceMode in ["off","some","all"]; transcribeProvider in ["workersai","openai","stub"]).`, { label: 'v2:api+cron+drift+backup', phase: 'Build' }),
  () => agent(L5 + `\n\nADDITIONAL TEST SCOPE: the unit and integration items in SPEC_V2 "Tests added by these sections". For multipart uploads in the integration runner use Node's FormData and Blob (global in Node 22). For the push test, no VAPID keys are set locally, so assert the run reports the push as skipped and the message still exists.`, { label: 'v2:tests', phase: 'Build' }),
  () => agent(L6 + `\n\nADDITIONAL DOCS SCOPE: sections R through Z of SPEC_V2 in README (one line each), DEPLOY (the optional secrets ELEVENLABS_API_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY with the gen_vapid script; the four crons; how to install the app to the phone home screen and turn on notifications; what "she texts first" does and does not do), HANDOFF (decisions: cap 10 opt-in, voice via Workers AI by default, vision on, push only for first texts), docs/BEHAVIOR (first-text rules and the hard reject), docs/ARCHITECTURE (voice, vision, push, media, timeline, voiceprint).`, { label: 'v2:docs', phase: 'Build' }),
  () => agent(L7, { label: 'v2:voice+vision+media', phase: 'Build' }),
  () => agent(L8, { label: 'v2:herfirst+push+pwa', phase: 'Build' }),
  () => agent(L9, { label: 'v2:timeline+voiceprint+export', phase: 'Build' }),
])
const buildReports = built.map((r, i) => `--- v2 build agent ${i} ---\n${r ?? '(no report)'}`).join('\n\n')
log('v2 build done; integrating')

phase('Integrate')
const INTEGRATE = `${COMMON}

YOU ARE THE INTEGRATOR for v2. Six agents just wrote against SPEC_V2.md in parallel. Their reports:

${buildReports}

Make everything green, editing any file except src/generated/constitution.ts (regenerate it with npm run build:canon), canon/constitution/*, and public/images/*. Order: npm run build:canon; node scripts/check_typography.mjs; node scripts/verify_assets.mjs; npx tsc --noEmit; npm run test:unit; npm run test:integration (wrangler dev on 8790 with the stub providers; the runner applies migrations 0001..0003 to a fresh local state dir); node --check on every public/js file; a UI smoke (fetch each page and every referenced asset with the dev server up); node scripts/check_typography.mjs again. Also run the scheduled handler locally: wrangler dev exposes /__scheduled when started with --test-scheduled; hit http://127.0.0.1:8790/__scheduled?cron=0+7+*+*+* and confirm a backups/ object exists in the local R2 (list via the export or a small debug route you then remove). Return a report: what failed and what you changed (file by file), final counts, anything still broken with the exact error text. Kill any dev server you started.`
const integ = await agent(INTEGRATE, { label: 'v2:integrate', phase: 'Integrate', effort: 'xhigh' })
log('v2 integration done; adversarial review')

phase('Review')
const REVIEW_BASE = `${COMMON}

You are a READ-ONLY reviewer for v2. Do not edit files, do not start servers. You may run npx tsc --noEmit and node --check. Report findings only, ranked by severity, each with file:line, a one-sentence claim, a concrete failure scenario, and the smallest fix; mark each confirmed or plausible. Integrator report:
${integ ?? '(none)'}
`
const REVIEWS = [
  { key: 'hooks', prompt: `${REVIEW_BASE}\nLENS: retention hooks and character integrity. Read SPEC_V2 sections B, F, J, K, Q and the code (life.ts, callbacks.ts, chat.ts, prompt.ts, proposals.ts). Could any path make her claim she waited, missed him, or suffered; create urgency or guilt; nag; ask him to reply; or turn a cooling-off into punishment or silence-as-weapon? Could the callbacks section push questions or force both callbacks? Could the /open route be scheduled or produce a notification? Does the delay ever get explained in story? Could a life thread be created from a joke? Could the song rule make her push his taste? Does the stable prefix stay byte-identical except the song rule (compare CONSTITUTION_VERSION change to the diff of scripts/build_constitution.mjs)?` },
  { key: 'pipeline', prompt: `${REVIEW_BASE}\nLENS: correctness of the v2 pipeline and data. deliver_at: hidden rows leak through any route (messages list, export, transcript, idempotent replay)? Replay of a turn with deliver_at in the future returns the same deliverAt? Song and photo markers both present: stripped correctly, stored once? message_context written inside the same batch or after commit (must not block the response; must not fail the turn)? Opinion supersede picks the right fact and versions correctly? Migration 0003: valid SQLite for D1, ALTER TABLE ADD COLUMN idempotency, indexes? whereSheIs across midnight and week boundaries and DST in America/New_York? computeDeliverAt determinism and cap? pickCallbacks exclusion logic and determinism? runBackup keeps exactly 30 and handles an empty bucket? runDrift respects the budget caps and cleans up its throwaway conversation? scheduled handler errors swallowed and audited?` },
  { key: 'ui', prompt: `${REVIEW_BASE}\nLENS: UI against the routes. Trace every fetch in public/js/*.js to src/api.ts (method, path, body, response fields). Bubble timing: does splitBubbles ever split inside a URL, a quoted phrase or a number; does the timing loop stop on navigation; does a deliverAt in the future keep the composer usable; does reload re-hide correctly; does the Together toggle write valid scene state; does the Life tab grid produce valid schedule_json; does the why panel resolve ids; no prose leaked into the UI; still dark, one accent, phone width.` },
]
const findings = await parallel(REVIEWS.map(r => () => agent(r.prompt, { label: 'v2:review:' + r.key, phase: 'Review' })))
const findingsText = REVIEWS.map((r, i) => `=== ${r.key} ===\n${findings[i] ?? '(no findings returned)'}`).join('\n\n')
log('v2 review done; applying fixes')

phase('Fix')
const fixReport = await agent(`${COMMON}

You are the FIX agent for v2. Verify each finding below against the code and apply every confirmed one with the smallest correct change; for a plausible one, prove it with a test and fix it, or record "not reproduced". Then: npm run build:canon, node scripts/check_typography.mjs, npx tsc --noEmit, npm run test:unit, npm run test:integration (kill the dev server after). All green. Return a table finding -> action with file:line and the final counts.

FINDINGS:
${findingsText}`, { label: 'v2:fix', phase: 'Fix', effort: 'xhigh' })
log('v2 fix done; final verification')

phase('Verify')
const verdict = await agent(`${COMMON}

You are the FINAL VERIFIER for v2, independent of everyone before you. Run: npm run build:canon; node scripts/check_typography.mjs; node scripts/verify_assets.mjs; npx tsc --noEmit; npm run test:unit; npm run test:integration; then start your own dev server on port 8791 (apply migrations to tests/integration/.state first; use --test-scheduled) and by hand: create a conversation, PUT settings replyDelayMode real, send "hey", confirm the response carries deliverAt and GET messages hides it until then and shows it after; POST /open and confirm an assistant message with no user message and no "miss you" language; create a life thread (routine, weekday block covering now in America/New_York) and confirm GET /api/system or a turn's context shows busy; hit /__scheduled?cron=0+7+*+*+* and confirm a backup exists; confirm GET /api/messages/:id/context returns ids for the last assistant message. Kill the server. Return GREEN or RED with counts per step and exact failing output if RED. Fix nothing unless a one-line typo blocks a step, and say so.

Fix report:
${fixReport ?? '(none)'}`, { label: 'v2:verify', phase: 'Verify', effort: 'high' })

return { integ, findingsText, fixReport, verdict }
