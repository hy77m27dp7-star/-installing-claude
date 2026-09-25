# Costs

The app meters every model call and stops itself at two caps. This file shows the arithmetic so the numbers on the Model page are not a surprise.

## The cost model

Text is billed by token. The app multiplies the tokens each call reports by the prices in the settings table (the Prices section of the Model page). Prices are USD per million tokens.

| Model | Input per 1M tokens | Output per 1M tokens |
|---|---:|---:|
| claude-opus-5 (default) | 5.00 | 25.00 |
| claude-sonnet-5 (proposal pass) | 2.00 | 10.00 |
| claude-haiku-4-5 | 1.00 | 5.00 |
| claude-opus-4-8 | 5.00 | 25.00 |
| claude-fable-5-1 | 10.00 | 50.00 |
| @cf/meta/llama-3.3-70b-instruct-fp8-fast (Workers AI fallback, DEPLOY.md section 8) | 0.29 | 2.25 |
| gpt-4.1 (the default tasting performer, v3) | 2.00 | 8.00 |
| gpt-4.1-mini, gpt-4.1-mini-2025-04-14 (the texter base, v3) | 0.40 | 1.60 |

The last row is Cloudflare's list price as of the build and is nominal until confirmed on the Workers AI pricing page; correct it in the Prices section of the Model page if it moved. The built-in table sits under the stored one: a price you set on the page wins, and a model priced in the built-in table stays priced on a database seeded before that entry existed.

Cost of one call = input tokens x input price / 1,000,000 + output tokens x output price / 1,000,000. The app stores it as a whole number of micro-dollars so rounding can never let a call slip under a cap.

A model that is not in the table cannot be used. The Model page refuses to save it (400: no entry in prices), and a call on a model whose price is missing is refused with `402 price_unknown` before anything is spent, so an unpriced model can never run at zero on the meter and slip past the caps. Add the model's prices in the Prices section of the Model page first, then switch to it (the page sends only what changed, so a cap change never re-asserts the model line). (The `price_unknown` flag on a run row is a fallback for a post-call lookup that misses; the gate makes it unreachable in practice.)

Photos are billed per call, not per token. `imageCostUsd` is a flat price per photo added to the day's spend for every generated candidate, approved or not, whichever provider made it; the stored default is 0.06 (gpt-image-1 at medium quality, 1024x1536). Since 2026-09-25 the photo provider is Runway's `gen4_image` with tagged character references, which Runway bills in credits, not dollars: 5 credits per 720p image, 8 credits per 1080p image, a credit being 0.01 USD (https://docs.dev.runwayml.com/guides/pricing, fetched at the build), so at the app's default size (1024x1536, sent as `1080:1440`) set `imageCostUsd` to 0.08; `gen4_image_turbo` is 2 credits (0.02) per image; a moderated generation costs the same as a successful one; Runway's estimate is the most a task may charge and the final amount may be lower once it completes (its API description); a task the app cancels after its 90 second poll budget may still be charged, and the meter keeps its flat charge either way. Change the price on the Model page when Runway's or OpenAI's price changes. It must be above 0 for a paid image provider: the Model page refuses 0 unless the image provider is keyless (the stub), and a photo on a paid provider at 0 is refused with `402 price_unknown`. A portrait on Runway costs the same credits as a photo of the same tier (`portraitCostUsd`, 1024x1024).

Two more calls can happen around a turn:

- The retry. When the checks reject a draft, the app asks the model once more with a short corrective note. That is a second full call at the same price, recorded as its own run, and it is gated like the first: the estimate for the retry plus the first call's own cost (not yet on the meter) is checked against both caps, and over a cap the retry is skipped, the first draft stands and its message carries a `retry_skipped` flag. The Anthropic SDK itself never retries (a resend after a timeout or a 5xx could bill a generation the app never sees); a transport failure comes back as a retryable error and the page offers Retry.
- The proposal pass. When proposals are on, each turn is followed by one small call on the proposal model (claude-sonnet-5 by default, at most 800 output tokens) that reads the exchange for durable facts. It is estimated and checked against the caps like any other call; when the caps or a missing price refuse it, the pass is skipped quietly (the turn is already answered) and the run log keeps a failed row with a `budget_skipped` flag.

The operator channel is metered the same way as a turn when it calls a model.

## The two caps

`dailyCapUsd` (default 3) and `monthlyCapUsd` (default 30). Days and months are UTC.

Before a turn, a photo, or an operator call spends anything, the app estimates the cost (the whole prompt at four characters per token at the input price, plus the full `maxTokens` at the output price, or the flat photo price) and adds it to today's spend and to this month's spend. If either sum passes its cap, the request answers `402 budget_exceeded` and nothing is written: no user message, no reply, no scene change. The estimate is deliberately pessimistic, so the app stops a little before the cap rather than a little after.

A cap set to 0 blocks every call. Raise a cap on the Model page and the next turn goes through; the past spend is not forgiven.

## The usage screen

The Model page shows Today, Month, both caps, and a table by day with provider, model, requests, input tokens, output tokens and cost. A photo shows as a row with zero tokens and the flat cost. A failed text call that reported usage is counted; one that failed before the model answered costs nothing.

The same numbers come from `GET /api/usage`, and `GET /api/system` includes them under `spend`.

## A normal day

Forty turns on claude-opus-5, each about 9,000 input tokens (the constitution prefix plus state plus recent messages) and about 250 output tokens, plus three photos.

| Line | Arithmetic | USD |
|---|---|---:|
| Input | 40 x 9,000 = 360,000 tokens x 5.00 / 1,000,000 | 1.80 |
| Output | 40 x 250 = 10,000 tokens x 25.00 / 1,000,000 | 0.25 |
| Photos (0.08 on Runway gen4_image at 1080:1440; 0.06 on the OpenAI fallback) | 3 x 0.08 | 0.24 |
| Day on the meter | | 2.29 |
| Proposal pass, if on | 40 calls, about 2,500 in and 150 out each: 100,000 x 2.00 / 1,000,000 + 6,000 x 10.00 / 1,000,000 | 0.26 |
| Day on the meter with proposals | | 2.55 |

That day fits under the 3 USD daily cap with a little room for one or two retries. Thirty such days reach the 30 USD monthly cap on about day 13, so if that is a normal month for you, raise the monthly cap on the Model page.

Prompt caching on the stable prefix makes repeat turns cheaper than this: cache reads are billed at a fraction of the input price (about a tenth on the published rate card; confirm in the Anthropic console). The constitution prefix is byte-identical every turn and is sent with a cache breakpoint, so after the first turn most of those 9,000 tokens are cache reads as long as turns come within the cache lifetime (five minutes by default; a longer pause writes the cache again at a small premium). The meter does not apply that discount: it counts cached input at full price on purpose, so the number on the Model page is a ceiling and the Anthropic invoice is the floor. Check the invoice after the first real week and set the caps from what you see.

## v3: the two-block cache and what it changes in the arithmetic

The system prompt is about 12,000 tokens: roughly 10,000 of stable prefix and 2,000 of per-turn state. Before v3 the whole prompt went as one cached block with the breakpoint after the state, so any change in the state missed the whole prompt; at 5.00 per million that is about 0.06 USD a turn uncached, and the 3 USD daily cap is about 45 such turns. v3 changes the state every turn by design (the exemplars, the RIGHT NOW clock, the cue), so the Anthropic adapter now sends two blocks: the prefix with the cache breakpoint, the state without. The prefix is byte-identical every turn and on a retry; only the state (about 2,000 tokens) is read at full price. The meter still counts every input token at full price on purpose, so the number on the Model page stays a ceiling and the invoice the floor.

## v3: calls, from the real usage with a per-minute floor

A call is metered every 30 seconds. The page reports the session's cumulative token counts; the Worker prices them at `callPrices` (32 / 64 per million audio tokens in and out, 4 / 16 for text, list prices to confirm) and takes the larger of that and `secondsTotal / 60 x callPricePerMinute` (0.30 a minute, the floor). The difference from the previous tick is written to `usage_daily`, never negative, so the usual caps see the call grow tick by tick and stop it within one tick of a cap. To start, two minutes at the floor must fit under both caps. A 20-minute call is therefore at least 6.00 USD on the meter, more when the audio runs heavy: raise the daily cap for the day before a long call. Compact instructions (about 3,000 tokens of rules plus the state) are the default because the realtime session bills the whole instruction text on every response and a conversational call is several hundred responses; full mode roughly doubles the text part.

## v3: portraits, clips, tastings and the texter

- A portrait costs `portraitCostUsd` (0.04) per face, checked against both caps before the call, like a photo.
- A clip costs `videoCostUsd` (0.25) per five seconds on his Runway account (gen4_turbo at five credits a second, one cent a credit, fetched at the build), charged at start because Runway charges when the task runs; a failed task stays charged, honestly. There is no key today, so this line is 0.
- A tasting turn spends double: both drafts and their retries are metered under their own performer, and `tastingDailyCapUsd` (1.00 a day) bounds the sum of the tasting rows on top of the normal caps. A day of twenty tastings on Opus 5 against gpt-4.1 is about 20 x (0.06 + 0.02) uncached; the two-block cache brings the Opus side down.
- The texter: exports and marks are free; training runs on his own OpenAI account from the Mac (the script estimates it: tokens x epochs x the training price per million, about 5.00 for gpt-4.1-mini, confirm) and never through the app; inference on the fine-tuned model is metered through `settings.prices` like any model (add its two prices in the panel when pressing Use; the fine-tuned mini is about 0.80 in and 3.20 out, confirm).
- Weather, geocoding and the maintenance pass are free.

## v3.1: his face in her calls

When his reference photos ride on a turn (SPEC_V3 section JJ: his first turn of a conversation, a turn that mentions his looks, every Together turn while `hisFaceInTogether` is on, every `hisFaceApartEvery` replies in Apart mode), each photo is sent as an image block on the final user turn, uncached: a 2000x2000 photo is about 1,600 input tokens on Anthropic, so at the default three photos a turn carries about 4,800 extra input tokens, which at claude-opus-5-5's input price is under a cent a turn and at claude-opus-5's 5.00 per million about 2.4 cents. The cached constitution prefix is untouched (the photos are on the message, not the system prompt). A Together conversation is where it adds up; lower `hisFaceMax` to 1 or turn the Together switch off on the Model page to trim it. The describe call (`POST /api/him/describe`) is one small paid call on the story performer, estimated with the photos counted at that rate and metered as kind `describe`. Uploads, the words and the State page are free.

