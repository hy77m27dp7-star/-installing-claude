# Her own voice: ElevenLabs on calls and voice notes (v4, Amendment A2)

One voice that is hers, the same on a phone call and in a voice note. Until every step in
"What Justin does" is done, both switches stay where they are today (voice notes on
Workers AI, calls on OpenAI) and nothing here runs.

## What Justin does (one click at a time; nothing else)

1. Account and plan. Open https://elevenlabs.io, sign in (or make the account), open
   Subscription and pick a plan that includes Agents Platform (conversational agent)
   minutes. The Starter plan is enough to start; the credits are shared across text to
   speech and agent minutes. Calls and voice notes bill against them.
2. Her voice. Open Voices. Pick one from the library or design one (Voice Design), save
   it to My Voices, open it and copy its Voice ID (a short id like `21m00Tcm4TlvDq8ikWAM`;
   an id, not a secret).
3. The agent, once. Open Agents, Create agent, Blank. Name it `Avelie`. Leave the system
   prompt and the first message as they are (the app replaces both on every call). Set the
   voice to the voice from step 2. Open the agent's Security tab and turn ON, under
   Overrides: `System prompt`, `First message`, and `Voice` (the language override may
   stay off). Save. Copy the Agent ID (`agent_...`, shown on the agent's page; an id, not a
   secret).
4. In the app, Model page. Voice card: Voice provider `elevenlabs`, ElevenLabs voice id =
   the id from step 2, ElevenLabs model `eleven_multilingual_v2` (the default; leave it),
   ElevenLabs price per 1k characters (0.30 is the default; see Prices below). Calls card:
   Call provider `elevenlabs`, ElevenLabs agent id = the id from step 3, ElevenLabs price
   per minute (0.10 is the default; see Prices). Save.
5. The API key, from the clipboard to the Worker, never in chat and never in a file. On
   elevenlabs.io open the profile menu, API keys, Create API key, name it `avelie`, click
   copy, then say "copied". The deploy session runs
   `pbpaste | npx wrangler secret put ELEVENLABS_API_KEY` and then `printf '' | pbcopy`.
6. The first call: tap Call in the chat. The browser asks for the microphone once (Allow).
   She picks up and either waits or says hi, her choice.

Nothing else: no agent tools, no knowledge base, no phone number, no widget.

## What the code does

Voice notes (`src/voice.ts`, the `elevenlabs` branch; `src/providers/elevenlabs.ts`
`textToSpeech`): `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format=mp3_44100_128`
with the `xi-api-key` header and the body `{ text, model_id }`, where `model_id` is the
setting `elevenLabsModel` (default `eleven_multilingual_v2`; `eleven_flash_v2_5`,
`eleven_turbo_v2_5` and `eleven_v3` are the other current ids). The answer is mp3 bytes,
stored as `voice/<messageId>.mp3` exactly as the Workers AI note is. Confirmed against
the ElevenLabs API reference on 2026-09-26.

Calls (`src/calls.ts`, the `elevenlabs` branch; `src/providers/elevenlabs.ts`
`mintSession`; `public/js/call_elevenlabs.js`): the Worker mints the session credential
with the API key, `GET https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=<elevenLabsAgentId>`
(the WebRTC transport; the answer is `{ token, conversation_id }`). If that endpoint is
not served for the account (a 404, or a 403 or 422 that is not an authentication
failure) the Worker falls back once to
`GET /v1/convai/conversation/get-signed-url?agent_id=<id>` (the WebSocket transport;
`{ signed_url }`). Both endpoints are in the current API reference (2026-09-26) and both
take `xi-api-key`. The signed URL is good for 15 minutes and the conversation must start
inside that window; the token's life is not stated, so both are treated as fifteen-minute,
one-use credentials. SHIPPED: WebRTC first, the WebSocket fallback coded and covered by
the stub; which one a call used is `transport` in the start response and in the call's
audit row (`call.start`, `transport`). The credential rides to the page once in the start
response (`clientSecret`) and is never stored, logged or audited.

The page passes overrides at session start (the SDK's `overrides` option): the agent's
prompt = her instructions as `callInstructions(...)` builds them (compact or full by
`callSystemMode`, the same text the OpenAI session gets), first message empty, `tts.voiceId`
= the voice id from settings. That is why step 3 turns the three overrides on: an agent
without them refuses the session.

The browser side is ElevenLabs' official client `@elevenlabs/client` (1.25.0), installed
with npm and copied by `npm run vendor:elevenlabs` into `public/js/vendor/elevenlabs-client.js`
(an ES module wrapping the package's IIFE bundle, LiveKit included) with its two
AudioWorklets under `public/js/vendor/worklets/` (self-hosted, so the CSP needs no
`blob:`). No CDN. `npm run check:vendor` fails when the vendored files differ from the
installed package. `call.js` (the chat lane) hands `connectElevenLabs({ start, els, callbacks })`
the sheet's elements and its own callbacks; transcripts arrive as client events
(`onMessage`, role `user` or `agent`) and go through the same caption and segment
callbacks, so `POST /api/calls/:id/end` stores them as story rows exactly as the OpenAI
path does. Her face on the call is driven from the client's speaking / listening mode and
his input level (no analyser on this path).

Meter: `elevenLabsCallPricePerMinute` (default 0.10) per started minute against the daily
and monthly caps, through the same tick and end routes; the page reports no token usage,
so the priced side is zero and the floor is the whole cost. `callMaxMinutes` applies. A
price of 0 refuses the call (402 `price_unknown`). Voice notes: `elevenLabsTtsPricePer1kChars`
(default 0.30) times the characters sent, rounded up to the cent, through `assertBudget`
before the call; the cost on the run row and in `usage_daily` after it; a price of 0
refuses the note and the text message stands.

## Content security policy (`src/index.ts`)

Applied at integration (2026-09-26): `ELEVENLABS_CONNECT` in src/index.ts carries the four
origins below, and `entry_v4` pins them. The page needs, in `connect-src`, beyond `'self'`:

- `https://api.elevenlabs.io` (the client's own fetches)
- `wss://api.elevenlabs.io` (the WebSocket transport, the signed URL)
- `wss://livekit.rtc.elevenlabs.io` (the WebRTC transport: `DEFAULT_LIVEKIT_WS_URL` in
  @elevenlabs/client 1.25.0; the client joins a LiveKit room there with the token)
- `https://livekit.rtc.elevenlabs.io` (livekit-client probes the same host over https
  when a join fails, to tell a bad token from a dead network)

The four are exported as `ELEVENLABS_CONNECT_ORIGINS` from `src/providers/elevenlabs.ts`.
The WebRTC media itself (UDP, or TURN over `turn:` / `turns:`) is not governed by
`connect-src`. `script-src` stays `'self'` (the client and its worklets are same-origin
files; nothing loads from a CDN). `media-src 'self' blob:` already covers playback.

One gap, on the WebSocket fallback only (the signed-URL transport, used when the token
endpoint is unavailable): a browser that cannot set the mic sample rate (Firefox, some
Safari) makes the client load a resampler worklet, `libsamplerate.worklet.js` from
`@alexanderolsen/libsamplerate-js` 2.1.2, whose default address is jsdelivr. The page now
passes the same-origin path `/js/vendor/worklets/libsamplerate.worklet.js`
(`LIBSAMPLERATE_PATH` in `public/js/call_elevenlabs.js`), so no CDN is ever contacted, but
the file itself is not vendored yet (it is not in `node_modules`; adding it means one npm
install of that package and a copy into `public/js/vendor/worklets/`). Until then that one
path fails with `connect_failed`, exactly as it did when the CSP refused the CDN. WebRTC,
the normal transport, never loads it.

NOT YET CONFIRMED IN A REAL BROWSER: this lane ran without one (Justin's word for this
build: no Chrome until he names the project). The list above comes from the client's
source and the docs. On the first real call the integrator or Justin reads the browser
console once: any `Refused to connect to <origin>` line names an origin to add.

## Prices (docs/COSTS.md carries the two lines)

- Calls: `elevenLabsCallPricePerMinute`, default 0.10 USD per started minute. ElevenLabs
  bills agent minutes in credits from the plan; the per-minute figure to enter is what
  the chosen plan works out to (the pricing page lists credits per plan, not a per-minute
  dollar figure; 0.10 is the spec's default and a plan's real figure replaces it).
- Voice notes: `elevenLabsTtsPricePer1kChars`, default 0.30 USD per 1,000 characters
  (one character is one credit; the plan's dollar-per-credit sets the real figure).

## Local runs and the stub

`ELEVENLABS_STUB=1` (a `--var`, local only, while `ACCESS_AUD` is empty) routes every
ElevenLabs call to the `[[ELEVEN]]` stub in `src/providers/stub.ts`: the token mint answers
`{ token: "stub-token" }`, the signed-url fallback a `wss://...invalid` URL, text to speech
64 bytes of a fixed pattern as `audio/mpeg`. The key is still required by the configured
checks (pass `ELEVENLABS_API_KEY=dummy` as a `--var` the way the runner passes the OpenAI
one) and a voice id or agent id must be set. The unit suite
(`tests/unit/elevenlabs_v4.test.mjs`) hands the stub fetch to the adapter directly.

## Laws it keeps

No key in the browser (the Worker mints; the page gets a one-use credential). No prompt
about the app in her speech (the same call note as the OpenAI path). Caps on every minute
and every note. Transcripts are story rows only through the end route; nothing becomes
canon without him. She always answers.
