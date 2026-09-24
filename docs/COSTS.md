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

The last row is Cloudflare's list price as of the build and is nominal until confirmed on the Workers AI pricing page; correct it in the Prices section of the Model page if it moved. The built-in table sits under the stored one: a price you set on the page wins, and a model priced in the built-in table stays priced on a database seeded before that entry existed.

Cost of one call = input tokens x input price / 1,000,000 + output tokens x output price / 1,000,000. The app stores it as a whole number of micro-dollars so rounding can never let a call slip under a cap.

A model that is not in the table cannot be used. The Model page refuses to save it (400: no entry in prices), and a call on a model whose price is missing is refused with `402 price_unknown` before anything is spent, so an unpriced model can never run at zero on the meter and slip past the caps. Add the model's prices in the Prices section of the Model page first, then switch to it (the page sends only what changed, so a cap change never re-asserts the model line). (The `price_unknown` flag on a run row is a fallback for a post-call lookup that misses; the gate makes it unreachable in practice.)

Photos are billed per call, not per token. `imageCostUsd` (default 0.06 for gpt-image-1 at medium quality, 1024x1536) is added to the day's spend for every generated candidate, approved or not. Change it on the Model page when OpenAI's price changes. It must be above 0 for a paid image provider: the Model page refuses 0 unless the image provider is keyless (the stub), and a photo on a paid provider at 0 is refused with `402 price_unknown`.

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
| Photos | 3 x 0.06 | 0.18 |
| Day on the meter | | 2.23 |
| Proposal pass, if on | 40 calls, about 2,500 in and 150 out each: 100,000 x 2.00 / 1,000,000 + 6,000 x 10.00 / 1,000,000 | 0.26 |
| Day on the meter with proposals | | 2.49 |

That day fits under the 3 USD daily cap with a little room for one or two retries. Thirty such days reach the 30 USD monthly cap on about day 13, so if that is a normal month for you, raise the monthly cap on the Model page.

Prompt caching on the stable prefix makes repeat turns cheaper than this: cache reads are billed at a fraction of the input price (about a tenth on the published rate card; confirm in the Anthropic console). The constitution prefix is byte-identical every turn and is sent with a cache breakpoint, so after the first turn most of those 9,000 tokens are cache reads as long as turns come within the cache lifetime (five minutes by default; a longer pause writes the cache again at a small premium). The meter does not apply that discount: it counts cached input at full price on purpose, so the number on the Model page is a ceiling and the Anthropic invoice is the floor. Check the invoice after the first real week and set the caps from what you see.
