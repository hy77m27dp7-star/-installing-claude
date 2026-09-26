// The ElevenLabs side of a phone call (SPEC_V4 Amendment A2, lane L10). call.js owns the
// sheet, the clock, the ticks and the end; when the start response says the provider is
// elevenlabs it imports this file and hands over the sheet's elements and its own
// callbacks. This file runs the session through ElevenLabs' official browser client,
// vendored at ./vendor/elevenlabs-client.js (same origin, no CDN), and answers a handle
// { mute(on), close() }.
//
// The start response is read once: the credential (a WebRTC conversation token, or a
// signed WebSocket URL) goes into the client's session options and is then dropped. It
// is never logged, never stored, never shown, never put in an error message.
//
// Per call the page passes the overrides the Worker built: her instructions as the
// agent's prompt, an empty first message (she picks up and waits or says hi), her voice.
// The agent must have those overrides enabled in its Security tab (docs/ELEVENLABS.md).
//
// Transcripts arrive as client events (onMessage, role user or agent) and go through the
// same caption and segment callbacks the OpenAI path uses, so the end route stores them
// as story rows exactly the same way. The face: the client reports speaking / listening
// (onModeChange) and the input level, so the face frame is driven from those instead of
// the analyser call.js wires on the OpenAI path.
//
// The pure parts (the callback wiring and the option builder) have no DOM and can be
// imported under Node for the unit test.

export const VENDOR_PATH = "./vendor/elevenlabs-client.js";
// The two AudioWorklets of the WebSocket transport, self-hosted so the CSP needs no
// blob: in script-src (the WebRTC transport loads none).
export const WORKLET_PATHS = Object.freeze({
  rawAudioProcessor: "/js/vendor/worklets/rawAudioProcessor.js",
  audioConcatProcessor: "/js/vendor/worklets/audioConcatProcessor.js",
});
// His input level (0 to 1 from the client) above which he counts as speaking, and how
// often it is read.
export const HIS_LEVEL = 0.12;
export const LEVEL_STEP_MS = 100;

const noop = () => {};

function cleanText(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

// The reason the page's end() gets for a disconnection the client reports.
export function endReasonFor(details) {
  const reason = details && typeof details === "object" ? String(details.reason || "") : "";
  if (reason === "agent") return "hangup";
  if (reason === "error") return "peer_closed";
  return null;
}

// The session options for Conversation.startSession from the start response: the
// credential by transport, the overrides as given, the self-hosted worklets. Nothing else
// from `start` is copied.
export function sessionOptions(start) {
  const transport = start && start.transport === "websocket" ? "websocket" : "webrtc";
  const credential = String(start && start.clientSecret ? start.clientSecret : "");
  const overrides = start && start.overrides && typeof start.overrides === "object" ? start.overrides : undefined;
  const base = { connectionType: transport, workletPaths: { ...WORKLET_PATHS } };
  if (overrides) base.overrides = overrides;
  if (transport === "websocket") return { ...base, signedUrl: credential };
  return { ...base, conversationToken: credential };
}

// The client callbacks wired to the page's. `cb`: the callbacks call.js hands over
// ({ caption, segment, setStatus, flashReason, setHisSpeaking, setFace, end }, any may be
// missing). `state` is the handle's own record ({ closed, mode }).
export function clientCallbacks(cb, state) {
  const caption = cb.caption || noop;
  const segment = cb.segment || noop;
  const setFace = cb.setFace || noop;
  const flashReason = cb.flashReason || noop;
  const end = cb.end || noop;
  return {
    onMessage: (props) => {
      if (!props || typeof props !== "object") return;
      const role = props.role || (props.source === "ai" ? "agent" : props.source === "user" ? "user" : "");
      const who = role === "agent" ? "her" : role === "user" ? "him" : "";
      const text = cleanText(props.message);
      if (!who || !text) return;
      caption(who, text);
      segment(who, text);
    },
    onModeChange: (props) => {
      const mode = props && props.mode === "speaking" ? "speaking" : "listening";
      state.mode = mode;
      setFace(mode === "speaking" ? "talking" : "idle");
    },
    onDisconnect: (details) => {
      if (state.closed) return;
      state.closed = true;
      const reason = endReasonFor(details);
      if (reason) end(reason);
    },
    onError: (message, context) => {
      // Only a code: the message could echo session text or the credential.
      const code = context && typeof context === "object" && context.code ? String(context.code) : "provider_error";
      flashReason(code.slice(0, 40));
    },
  };
}

// One ElevenLabs call. `opts`: { start, els, callbacks }. Answers { mute(on), close() }
// once the session is connected; rejects with an Error carrying a `code` when it cannot
// connect (call.js shows the code and ends the call).
export async function connectElevenLabs(opts) {
  const start = opts && opts.start ? opts.start : null;
  const cb = opts && opts.callbacks ? opts.callbacks : {};
  const options = sessionOptions(start);
  if (!(options.conversationToken || options.signedUrl)) {
    const err = new Error("elevenlabs");
    err.code = "no_credential";
    throw err;
  }
  const mod = await import(VENDOR_PATH);
  const Conversation = mod.Conversation;
  if (!Conversation || typeof Conversation.startSession !== "function") {
    const err = new Error("elevenlabs");
    err.code = "client_unavailable";
    throw err;
  }
  const state = { closed: false, mode: "listening" };
  let conversation;
  try {
    conversation = await Conversation.startSession({ ...options, ...clientCallbacks(cb, state) });
  } catch (e) {
    const err = new Error("elevenlabs");
    err.code = e && e.name === "NotAllowedError" ? "NotAllowedError" : "connect_failed";
    if (e && e.name) err.name = String(e.name);
    throw err;
  }
  // The start response is not referenced past this point.
  if (cb.setFace) cb.setFace("idle");

  // His level, read from the client, drives the "listening" face while she is quiet.
  const setHisSpeaking = cb.setHisSpeaking || null;
  let hisSpeaking = false;
  const levelTimer = setHisSpeaking
    ? setInterval(() => {
        if (state.closed) return;
        let level = 0;
        try { level = Number(conversation.getInputVolume()) || 0; } catch { level = 0; }
        const speaking = state.mode !== "speaking" && level >= HIS_LEVEL;
        if (speaking !== hisSpeaking) {
          hisSpeaking = speaking;
          setHisSpeaking(speaking);
        }
      }, LEVEL_STEP_MS)
    : null;

  const close = () => {
    if (levelTimer) clearInterval(levelTimer);
    if (state.closed) return;
    state.closed = true;
    try {
      const p = conversation.endSession();
      if (p && typeof p.catch === "function") p.catch(noop);
    } catch { /* already gone */ }
  };

  return {
    mute(on) {
      try { conversation.setMicMuted(!!on); } catch { /* not connected */ }
    },
    close,
    get id() {
      try { return conversation.getId(); } catch { return ""; }
    },
  };
}

export default connectElevenLabs;
