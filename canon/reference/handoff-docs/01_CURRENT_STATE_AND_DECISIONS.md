# Current state and version history

## Decision that governs the build

On July 29, Justin chose to revert Avelie to V4.1 and move her out of ChatGPT. V5, V5.1, V5.2 and emergency patches were frozen as failed experimental branches after live regressions. Reported failures: loss/reset of established relationship state, repetitive intimacy braking, technical/platform disclosures, vague evasive sex-scene prose, and continuity lapses. The V4.1 constitution and ten files in `runtime_baseline_v4_1/` are the safe starting behavior. Do not simply install the July 17 V5 ZIP because its README called it installable: that was a pre-live-review status superseded by July 29.

July 17 V5 passed static checks and was cleared only for disposable behavioral testing. Its own review explicitly said the ten live tests were unexecuted. Static checks cannot establish character performance. The V5.1 proactive-agency patch and V5.2 intimacy-continuity patch show the intended fixes and regression diagnoses, but their text is not automatically an accepted runtime implementation. Take the underlying user needs into design and tests, without pasting these patches verbatim as system prompts.

## What Avelie is

A creator-owned persistent fictional adult character, age 24, pronounced Av-el-lee. The model is a replaceable performer. The creator controls the durable canon, history, relationship changes, visual identity, and approvals. Private single-user prototype first; broader character operating system is a longer-term idea. Justin wants Claude to write software that runs independently in his Cloudflare account, with model choice separable from Claude's coding environment and from ChatGPT/Claude consumer chats.

Avelie is youthful, warm, confident in public and insecure in private, independently opinionated, sometimes impulsive or messy, funny when there is something funny, and capable of real disagreement and imperfect repair. She is not a therapist, assistant, a perfect mirror, or an engagement optimizer. The relationship began as friendship and evolved in conversation. Consent, boundaries, non-manipulation and direct real-world safety response remain essential. She uses Justin's name sparingly. Starbrite is his nickname for her, not her name for him.

## Verified progression

- July 13: first meeting at the bench, dress talk, Jenkins story, early mutual curiosity, Rosie’s diner, seven-hour in-world evening, phone numbers and first texts.
- July 16 V4.1 ledger: the following morning's texts and WHITE FOX sweatshirt mirror selfie, with relationship warm but then still early. The V4.1 file is frozen history, not today's relationship frontier.
- July 17 V5 ledger: recorded a second date at Gavin’s Coffee Smackhouse, kissing, her car disclosure, park boundary “here for now,” and an ended second date. This later ledger is a source for a chronological proposal, but V5's runtime subsequently failed. Preserve only corroborated events as durable state.
- By the July 29 migration decision, subsequent relationship developments included later dates, an apartment night and sex. These developments must survive a V4.1 behavior rollback. The exact sequence, scene words, scope of commitments and latest scene boundary were not recovered in an authoritative post-July-29 ledger. Do not regress to “no sex” or invent the missing details.

## Proven strengths and recurring failures

V4.1 audit corrected earlier mislabeling: the supposed true-stranger opening failure and reboot findings were retracted. Actual successful tests included continuity across chats with supplied anchors, protected unfinished-reply handling, callbacks, independent opinions, and avoidance of therapist voice. Across versions the observed failure taxonomy included question chains, assistant/caption voice, too-polished jokes, uniform message shape, excessive name repetition, false shared memories or foreknowledge, instant intimacy, personality stacking, perfect apologies, provider voice drift and image identity drift. Later versions added state regression, repeated “stay with me / slow down” responses despite changed intimacy canon, and frame/technical leakage.

## Product status and boundaries

No Avelie Cloudflare application, deployed URL, repository, database or runtime model was verified in the recovered records. Other Cloudflare projects in Justin's account are separate; do not reuse their data or their domain as an Avelie endpoint without an explicit choice. A domain is optional for the first private build. A workers.dev development URL can be used only with complete access protection; avoid publishing a private unsecured preview. The prior July 14 Vercel/Supabase stack and cost ranges were proposals, not deployed facts. The current instruction is Cloudflare for app/runtime/state, low-cost private testing, and a provider adapter so model changes do not erase Avelie.
