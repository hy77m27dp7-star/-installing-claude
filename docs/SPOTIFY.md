# Spotify: her playlist on his account, and the player (v4, SPEC_V4 section 4 and Amendment A1)

What it does: when she sends a song (`[song: Artist - Title]`), the Worker looks the track up on
Spotify and adds it to ONE private playlist on Justin's account ("songs from avelie", made once by
the app). The chat's song card then opens the track, and, through the Web Playback SDK, the page
itself is a Spotify Connect device named "Avelie" on his account, so the song plays in full inside
the chat and her phone panel (Premium required by Spotify; without it the embedded player shows).

The app never reads his listening history, his library or any other playlist. The "listening to"
line on her phone panel comes from her own facts, never from his Spotify.

## What Justin does himself (once)

1. https://developer.spotify.com/dashboard -> Create app. Name it anything ("Avelie"). Redirect URI,
   exactly: `https://avelie.bladepharoh.com/api/spotify/callback`. Web API and Web Playback SDK ticked.
   (For a local run add `http://127.0.0.1:8787/api/spotify/callback`; Spotify accepts a loopback
   IP, it refuses `localhost`. Confirm on the first local connect.)
2. The two secrets from the clipboard, never in chat, never in a file:
   `pbpaste | npx wrangler secret put SPOTIFY_CLIENT_ID` then `printf '' | pbcopy`, and the same
   for `SPOTIFY_CLIENT_SECRET`.
3. After the deploy: Model page -> Spotify card -> Connect. The consent screen lists the seven
   scopes below. Approve. The page comes back to `/model#spotify` with the chip `connected` and
   his display name; the playlist appears on his Spotify within a second of the first song.
4. A Premium account for full playback (the SDK needs it). Without Premium the song card falls
   back to Spotify's embed (30-second previews unless that browser is logged into Premium).

## Scopes (exactly these, nothing else)

`playlist-modify-private playlist-read-private streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state`

The first two make and fill the playlist. `streaming`, `user-read-email` and `user-read-private`
are what the Web Playback SDK requires to register a device; `user-read-playback-state` is used
only to show what the Avelie device is playing; `user-modify-playback-state` is the play and
queue calls on that device.

## Where the secrets and tokens live

- `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`: Worker secrets. Never in code, logs, responses,
  audit rows, exports or the browser.
- The refresh token and the access token: the one row of `spotify_auth` (id `owner`) in D1. Never
  exported (the export whitelist leaves the table out; the import ignores a `spotifyAuth` key), never
  in an audit row (`spotify.connect`, `spotify.connected`, `spotify.revoked`, `spotify.disconnect`
  carry status, user id, display name and playlist id only), never logged.
- The page gets only a short-lived access token from `GET /api/spotify/token` (refreshed by the
  Worker when under five minutes remain). That response is never audited or logged.
- The Premium flag (`GET /v1/me` `product`) is cached for a day in `panel_cache` under the key
  `spotify:premium` (the `spotify_auth` row has no column for it; the migration is fixed).

## Content security policy (the origins the SDK needs)

The base policy is `default-src 'self'` (src/index.ts). The player needs these additions, which the
integrator applies to `CSP` in src/index.ts (lane L8's file):

| Directive | Add | Why |
|---|---|---|
| `script-src` | `https://sdk.scdn.co` | the SDK script itself (`https://sdk.scdn.co/spotify-player.js`); Spotify's terms require loading it from Spotify, so it is never vendored |
| `frame-src` | `https://sdk.scdn.co` | the SDK plays inside a hidden iframe it creates from its own origin (EME and the audio element live there) |
| `frame-src` | `https://open.spotify.com` | the embed fallback (`https://open.spotify.com/embed/track/<id>`) |
| `connect-src` | `https://api.spotify.com` | the page's own play and queue calls (`PUT /v1/me/player/play`, `POST /v1/me/player/queue`) |
| `connect-src` | `https://*.spotify.com` | the SDK's HTTPS calls to Spotify's client endpoints (`cpapi.spotify.com`, `*.spclient.spotify.com`, `apresolve.spotify.com`) |
| `connect-src` | `wss://*.spotify.com` | the SDK's dealer WebSocket (`*-dealer.spotify.com`) |

`media-src` is unchanged: the audio plays inside the SDK's own frame, where our page's policy does
not apply. `img-src` is unchanged: the now-playing strip shows text only. If a later design wants
album art in the strip, `img-src` needs `https://i.scdn.co`.

Status of confirmation: these origins are the ones Spotify's Web Playback SDK documentation and
the SDK's own network behaviour name. The spec asked this lane to confirm them by loading the SDK
once in a real browser and reading the console; that step was NOT run, on Justin's instruction
during the build ("don't do that in Chrome until I tell you what project to access"). The
integrator or the verifier can do it in one minute after the deploy: open the chat, press play on
a song card, read the console for a `Refused to connect to` or `Refused to load the script` line
and add the origin it names to the table above and to `CSP`. The integrator applied the table
as written (`SPOTIFY_SDK_ORIGIN`, `SPOTIFY_EMBED_ORIGIN`, `SPOTIFY_CONNECT` in src/index.ts;
`entry_v4` pins them).

## The page contract (public/js/player.js)

Events the song card (chat.js) and the phone panel (phone.js) dispatch on `window`:

- `avelie:play` detail `{ uri, uris?, target? }` (`target`: the play control's element, where the
  embed renders when the SDK cannot play)
- `avelie:pause`, `avelie:resume`, `avelie:toggle`, `avelie:next`
- `avelie:queue` detail `{ uri }`

The event player.js dispatches: `avelie:player` detail `{ state: "ready" | "playing" | "paused" |
"off", track: { name, artist, uri } | null, position, duration, reason?, embedSrc? }`. `off` with
an `embedSrc` means the embed was rendered (no Premium, the SDK refused, iOS Safari, or
`spotifyPlayer` set to `embed`); `off` with reason `player_off` means `spotifyPlayer` is `off`.

Nothing loads at import time: the SDK script is fetched and the device created on the first
`avelie:play`, and no token is requested until then. `ensurePlayer()` is exported for a page that
wants to warm the device after a tap.

## Settings

- `spotifyEnabled` (the callback sets it true; Disconnect sets it false; his switch too)
- `spotifyPlaylistId` (written by the app; editable to point at a playlist he made himself)
- `spotifyPlaylistName` (used when the playlist is created; renaming later is his, on Spotify)
- `spotifyPlayer` (`sdk` | `embed` | `off`)

## Routes

`GET /api/spotify` (status, never a token), `GET /api/spotify/connect` (302 to accounts.spotify.com),
`GET /api/spotify/callback`, `POST /api/spotify/disconnect`, `GET /api/spotify/token`,
`POST /api/messages/:id/spotify` (runs the add by hand).

## Local run with no key

`--var SPOTIFY_STUB:1` while `ACCESS_AUD` is empty routes every Spotify call to
`stubSpotifyFetch()` (src/providers/stub.ts): the token URL, `/v1/me` (`product` premium, or free
with `--var SPOTIFY_STUB_PREMIUM:0`), the playlist create, the search (`[[NOTFOUND]]` in the
query answers no track), the add (201 on `stubplaylist`, 404 on any other playlist id, which is
how the recreate-once path is exercised) and the playlist read.

## Costs

None on the meter: Spotify's Web API is free, no model call is made. The playlist is one private
playlist on his account.
