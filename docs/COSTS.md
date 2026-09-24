# Costs

The app meters every model call and stops itself at two caps. This file shows the arithmetic so the numbers on the Model page are not a surprise.

## The cost model

Text is billed by token. The app multiplies the tokens each call reports by the prices in the settings table (`prices` in the Model panel). Prices are USD per million tokens.

| Model | Input per 1M tokens | Output per 1M tokens |
|---|---:|---:|
| claude-opus-5 (default) | 5.00 | 25.00 |
| claude-sonnet-5 (proposal pass) | 2.00 | 10.00 |
| claude-haiku-4-5 | 1.00 | 5.00 |
| claude-opus-4-8 | 5.00 | 25.00 |
| claude-fable-5-1 | 10.00 | 50.00 |

Cost of one call = input tokens x input price / 1,000,000 + output tokens x output price / 1,000,000. The app stores it as a whole number of micro-dollars so rounding can never let a call slip under a cap.

A model that is not in the table costs zero on the meter and the run carries a `price_unknown` flag. Add the model's prices in the Model panel before you switch to it.

Photos are billed per call, not per token. `imageCostUsd` (default 0.06 for gpt-image-1 at medium quality, 1024x1536) is added to the day's spend for every generated candidate, approved or not. Change it in the Model panel when OpenAI's price changes.

Two more calls can happen around a turn:

- The retry. When the checks reject a draft, the app asks the model once more with a short corrective note. That is a second full call at the same price, recorded as its own run.
- The proposal pass. When proposals are on, each turn is followed by one small call on the proposal model (claude-sonnet-5 by default, at most 800 output tokens) that reads the exchange for durable facts.

The operator channel is metered the same way as a turn when it calls a model.

## The two caps

`dailyCapUsd` (default 3) and `monthlyCapUsd` (default 30). Days and months are UTC.

Before a turn, a photo, or an operator call spends anything, the app estimates the cost (the whole prompt at four characters per token at the input price, plus the full `maxTokens` at the output price, or the flat photo price) and adds it to today's spend and to this month's spend. If either sum passes its cap, the request answers `402 budget_exceeded` and nothing is written: no user message, no reply, no scene change. The estimate is deliberately pessimistic, so the app stops a little before the cap rather than a little after.

A cap set to 0 blocks every call. Raise a cap in the Model panel and the next turn goes through; the past spend is not forgiven.

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

That day fits under the 3 USD daily cap with a little room for one or two retries. Thirty such days reach the 30 USD monthly cap on about day 13, so if that is a normal month for you, raise the monthly cap in the Model panel.

Prompt caching on the stable prefix makes repeat turns cheaper than this: cache reads are billed at a fraction of the input price (about a tenth on the published rate card; confirm in the Anthropic console). The constitution prefix is byte-identical every turn and is sent with a cache breakpoint, so after the first turn most of those 9,000 tokens are cache reads as long as turns come within the cache lifetime (five minutes by default; a longer pause writes the cache again at a small premium). The meter does not apply that discount: it counts cached input at full price on purpose, so the number on the Model page is a ceiling and the Anthropic invoice is the floor. Check the invoice after the first real week and set the caps from what you see.
