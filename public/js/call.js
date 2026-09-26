// Phone calls (SPEC_V3 section EE). The call runs in this browser over WebRTC straight to
// the realtime provider; the Worker mints a short-lived client secret, meters the call
// from the usage this page reports every 30 s, and stores the transcript when it ends.
//
// The start response is handled once: the secret goes from the response into one local
// variable, into the Authorization header of the SDP exchange, and is then dropped. It is
// never logged, never stored, never put in an error message, never shown.
//
// The pure parts (segment merge, usage accumulation, the clock) have no DOM and can be
// imported under Node for the unit test that checks the page rule and the server rule agree.
//
// v4 (SPEC_V4 section 2): her face on the call. The remote stream also feeds an
// AnalyserNode; a loop throttled to 100 ms reads her level and drives the face frame
// (#callFace) through callface.js: talking above a level, listening while he speaks
// (speech_started / speech_stopped on the data channel), idle otherwise. The stub call
// shows the face idle. Amendment A2: when the call provider is elevenlabs, the call runs
// through call_elevenlabs.js with the same sheet elements and callbacks.
import { api } from "./api.js";
import { createFacePlayer, faceStateFor, rmsOf, TALK_ENTER } from "./callface.js";

// The level meter: one analyser read every 100 ms; his speech counts for 1,500 ms after
// the last speech_started unless speech_stopped arrives first.
export const METER_STEP_MS = 100;
export const HIS_SPEECH_HOLD_MS = 1500;
export const ANALYSER_FFT = 512;
export const EV_SPEECH_STOPPED = "input_audio_buffer.speech_stopped";

export const TICK_SECONDS = 30;
// The server's raw gates: 2,000 segments and 4,000 characters per text. The page merges
// first, so a beacon that cannot retry never trips them.
export const MAX_SEGMENTS = 2000;
export const MAX_TEXT = 4000;
export const DATA_CHANNEL = "oai-events";

export function emptyUsage() {
  return { audioIn: 0, audioOut: 0, textIn: 0, textOut: 0 };
}

function nonneg(v) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Adds one response's usage (response.done -> response.usage) to the running total.
// Cached text tokens count as text in: the meter takes no discount.
export function accumulateUsage(total, usage) {
  const out = { ...emptyUsage(), ...(total || {}) };
  if (!usage || typeof usage !== "object") return out;
  const inD = usage.input_token_details && typeof usage.input_token_details === "object" ? usage.input_token_details : null;
  const outD = usage.output_token_details && typeof usage.output_token_details === "object" ? usage.output_token_details : null;
  if (inD) {
    out.textIn += nonneg(inD.text_tokens);
    out.audioIn += nonneg(inD.audio_tokens);
  } else {
    out.textIn += nonneg(usage.input_tokens);
  }
  if (outD) {
    out.textOut += nonneg(outD.text_tokens);
    out.audioOut += nonneg(outD.audio_tokens);
  } else {
    out.textOut += nonneg(usage.output_tokens);
  }
  return out;
}

function cleanText(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

// The page rule: a segment by the same speaker as the last one is appended to it, so the
// array is already one row per speaker turn; empty text is dropped; a merged text never
// grows past MAX_TEXT (a new row starts instead, and the server merges again on its side).
export function addSegment(list, seg) {
  if (!seg || (seg.who !== "him" && seg.who !== "her")) return list;
  const text = cleanText(seg.text);
  if (!text) return list;
  const at = typeof seg.at === "string" && seg.at ? seg.at : new Date().toISOString();
  const last = list.length ? list[list.length - 1] : null;
  if (last && last.who === seg.who && last.text.length + 1 + text.length <= MAX_TEXT) {
    last.text = last.text + " " + text;
    return list;
  }
  list.push({ who: seg.who, text: text.slice(0, MAX_TEXT), at });
  return list;
}

export function mergeSegments(segments) {
  const out = [];
  for (const s of Array.isArray(segments) ? segments : []) addSegment(out, s);
  return out;
}

export function fmtClock(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const m = Math.floor(s / 60);
  return m + ":" + String(s % 60).padStart(2, "0");
}

export const REASON_LABEL = {
  max_minutes: "Max minutes reached",
  budget: "Budget reached",
  provider_error: "Call failed",
  peer_closed: "Call dropped",
  hangup: "Ended",
  page_hidden: "Ended",
};

// A refused or missing microphone by its DOMException name (the legacy `.code` is 0 for
// NotAllowedError, which would read as a chip saying "0").
export function micErrorLabel(e) {
  const name = e && typeof e.name === "string" ? e.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Microphone blocked";
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "NotReadableError") return "No microphone";
  return e && e.code ? String(e.code) : "call_failed";
}

// A WebRTC "disconnected" is transient (ICE usually recovers within seconds); only a state
// still not connected after this long ends the call. "failed" and "closed" end it at once.
export const DISCONNECT_GRACE_MS = 10_000;

// Data-channel event names (OpenAI Realtime, GA shapes).
const EV_HIS = "conversation.item.input_audio_transcription.completed";
const EV_HER_DONE = "response.output_audio_transcript.done";
const EV_HER_DELTA = "response.output_audio_transcript.delta";
const EV_SPEECH_STARTED = "input_audio_buffer.speech_started";
const EV_RESPONSE_DONE = "response.done";
const EV_ERROR = "error";

// One call from start to end. `els`: { sheet, status, timer, captions, reason, mute, end, audio,
// face? }; the face frame is els.face or #callFace when the page has one.
// Callbacks: onEnd({ callId, reason, messageIds }) after the server accepted the end.
export function createCall(opts) {
  const els = opts.els;
  const faceEl = els.face || (typeof document !== "undefined" ? document.getElementById("callFace") : null);
  const st = {
    // v4: the face and the level meter.
    audioCtx: null,
    analyser: null,
    meterRaf: 0,
    meterLast: 0,
    meterData: null,
    hisSpeaking: false,
    hisSpeakingTimer: null,
    lastTalkAt: 0,
    faceKind: "idle",
    face: null,
    faceLoading: null,
    // Amendment A2: the ElevenLabs call handle when that provider carries the call.
    eleven: null,
    id: null,
    conversationId: opts.conversationId,
    live: false,
    ended: false,
    startedAt: 0,
    seconds: 0,
    maxSeconds: 0,
    tickSeconds: TICK_SECONDS,
    usage: emptyUsage(),
    segments: [],
    pc: null,
    dc: null,
    stream: null,
    clock: null,
    ticker: null,
    ending: null,
    liveHer: null,
    // The wall clock of the last tick the server accepted: a tick reports the seconds since
    // then (a background tab's timers are throttled; the constant would under-meter).
    lastTickAt: 0,
    disconnectTimer: null,
  };

  const setStatus = (label, live) => {
    els.status.textContent = label;
    els.status.classList.toggle("live", !!live);
  };

  const show = () => {
    els.sheet.classList.remove("hidden");
    els.sheet.setAttribute("aria-hidden", "false");
  };

  const hide = () => {
    els.sheet.classList.add("hidden");
    els.sheet.setAttribute("aria-hidden", "true");
    destroyFace();
  };

  // ---- the face (v4)

  const setFace = (kind) => {
    st.faceKind = kind;
    if (st.face) st.face.setState(kind);
  };

  const destroyFace = () => {
    if (st.face) { try { st.face.destroy(); } catch { /* gone */ } }
    st.face = null;
    st.faceLoading = null;
  };

  // The clips from GET /api/callface; a route that is missing or failing shows the avatar.
  const loadFace = () => {
    if (!faceEl) return Promise.resolve();
    destroyFace();
    const p = api("GET", "/api/callface").catch(() => null).then((state) => {
      if (st.faceLoading !== p || st.ended) return;
      try {
        st.face = createFacePlayer(faceEl, state);
        st.face.setState(st.faceKind);
      } catch { st.face = null; }
    });
    st.faceLoading = p;
    return p;
  };

  const setHisSpeaking = (on) => {
    clearTimeout(st.hisSpeakingTimer);
    st.hisSpeakingTimer = null;
    st.hisSpeaking = !!on;
    if (on) {
      st.hisSpeakingTimer = setTimeout(() => {
        st.hisSpeakingTimer = null;
        st.hisSpeaking = false;
        meterStep(performance.now(), true);
      }, HIS_SPEECH_HOLD_MS);
    }
    meterStep(performance.now(), true);
  };

  // One read of her level (throttled to METER_STEP_MS unless forced) and the face for it.
  const meterStep = (now, force) => {
    if (!force && now - st.meterLast < METER_STEP_MS) return;
    st.meterLast = now;
    let rms = 0;
    if (st.analyser && st.meterData) {
      st.analyser.getByteTimeDomainData(st.meterData);
      rms = rmsOf(st.meterData);
    }
    if (rms >= TALK_ENTER) st.lastTalkAt = now;
    const kind = faceStateFor(rms, st.hisSpeaking, st.faceKind, now, st.lastTalkAt);
    if (kind !== st.faceKind) setFace(kind);
  };

  const meterLoop = (now) => {
    if (!st.analyser) return;
    meterStep(now, false);
    st.meterRaf = requestAnimationFrame(meterLoop);
  };

  // The remote stream into the analyser. The AudioContext was made on the tap that
  // started the call (iOS allows it there), so this only wires nodes.
  const attachMeter = (stream) => {
    if (!st.audioCtx || !stream) return;
    try {
      if (st.audioCtx.state === "suspended") st.audioCtx.resume().catch(() => { /* stays silent */ });
      const source = st.audioCtx.createMediaStreamSource(stream);
      const analyser = st.audioCtx.createAnalyser();
      analyser.fftSize = ANALYSER_FFT;
      analyser.smoothingTimeConstant = 0.5;
      source.connect(analyser);
      st.analyser = analyser;
      st.meterData = new Uint8Array(analyser.fftSize);
      if (!st.meterRaf) st.meterRaf = requestAnimationFrame(meterLoop);
    } catch {
      st.analyser = null;
    }
  };

  const releaseMeter = () => {
    if (st.meterRaf) cancelAnimationFrame(st.meterRaf);
    st.meterRaf = 0;
    st.analyser = null;
    st.meterData = null;
    clearTimeout(st.hisSpeakingTimer);
    st.hisSpeakingTimer = null;
    st.hisSpeaking = false;
    if (st.audioCtx) { try { st.audioCtx.close().catch(() => { /* closed */ }); } catch { /* closed */ } }
    st.audioCtx = null;
  };

  const caption = (who, text) => {
    const el = document.createElement("div");
    el.className = "cap " + who;
    const w = document.createElement("span");
    w.className = "who";
    w.textContent = who === "him" ? "you" : "her";
    if (who === "him") el.append(document.createTextNode(text), w);
    else el.append(w, document.createTextNode(text));
    els.captions.append(el);
    els.captions.scrollTop = els.captions.scrollHeight;
    return el;
  };

  const segment = (who, text) => {
    addSegment(st.segments, { who, text, at: new Date().toISOString() });
    if (st.segments.length >= MAX_SEGMENTS) end("max_segments");
  };

  const clockTick = () => {
    st.seconds = Math.floor((Date.now() - st.startedAt) / 1000);
    els.timer.textContent = fmtClock(st.seconds);
    if (st.maxSeconds && st.seconds > st.maxSeconds + TICK_SECONDS) end("max_minutes");
  };

  const stopTimers = () => {
    clearInterval(st.clock);
    clearInterval(st.ticker);
    clearTimeout(st.disconnectTimer);
    st.clock = null;
    st.ticker = null;
    st.disconnectTimer = null;
  };

  const releaseMedia = () => {
    releaseMeter();
    if (st.eleven) { try { st.eleven.close(); } catch { /* closed */ } }
    st.eleven = null;
    if (st.dc) { try { st.dc.close(); } catch { /* closed */ } }
    if (st.pc) { try { st.pc.close(); } catch { /* closed */ } }
    if (st.stream) st.stream.getTracks().forEach((t) => t.stop());
    st.dc = null;
    st.pc = null;
    st.stream = null;
    try { els.audio.srcObject = null; } catch { /* not set */ }
  };

  async function tick() {
    if (!st.id || !st.live || st.ended) return;
    const now = Date.now();
    // The elapsed wall seconds since the last accepted tick, at most one minute (the
    // server's cap): a throttled interval or a lost tick still meters the time it covered.
    const seconds = Math.min(60, Math.max(0, Math.floor((now - (st.lastTickAt || st.startedAt)) / 1000)));
    let r;
    try {
      r = await api("POST", "/api/calls/" + encodeURIComponent(st.id) + "/tick", { seconds, usage: st.usage });
    } catch (e) {
      // A call the server no longer knows ends here; a blip does not.
      if (e && (e.status === 404 || e.status === 409)) end("provider_error");
      return;
    }
    st.lastTickAt = now;
    if (r && r.stop) end(r.reason || "budget");
  }

  function onEvent(raw) {
    let ev;
    try { ev = JSON.parse(raw); } catch { return; }
    if (!ev || typeof ev !== "object") return;
    const type = String(ev.type || "");
    if (type === EV_HIS) {
      const text = cleanText(ev.transcript);
      if (text) { caption("him", text); segment("him", text); }
    } else if (type === EV_HER_DELTA) {
      const delta = String(ev.delta ?? "");
      if (!delta) return;
      if (!st.liveHer) st.liveHer = caption("her", "");
      st.liveHer.lastChild.textContent += delta;
      els.captions.scrollTop = els.captions.scrollHeight;
    } else if (type === EV_HER_DONE) {
      const text = cleanText(ev.transcript);
      if (st.liveHer) { st.liveHer.remove(); st.liveHer = null; }
      if (text) { caption("her", text); segment("her", text); }
    } else if (type === EV_SPEECH_STARTED) {
      // He cut in; the server stops her over WebRTC. The partial caption stays as spoken.
      if (st.liveHer) st.liveHer = null;
      setHisSpeaking(true);
    } else if (type === EV_SPEECH_STOPPED) {
      setHisSpeaking(false);
    } else if (type === EV_RESPONSE_DONE) {
      const usage = ev.response && typeof ev.response === "object" ? ev.response.usage : null;
      st.usage = accumulateUsage(st.usage, usage);
    } else if (type === EV_ERROR) {
      const code = ev.error && typeof ev.error === "object" ? String(ev.error.code || ev.error.type || "error") : "error";
      // Only the code: a provider message could echo session text.
      flashReason(code);
    }
  }

  function flashReason(label) {
    els.reason.replaceChildren();
    const c = document.createElement("span");
    c.className = "chip amber";
    c.textContent = label;
    els.reason.append(c);
  }

  async function connect(start) {
    // `start` is read here and nowhere else. Nothing in this function logs it.
    const secret = String(start.clientSecret || "");
    const sdpUrl = String(start.sdpUrl || "");
    if (!sdpUrl) {
      // The stub provider: no network, no microphone; the sheet is live and the meter runs.
      return;
    }
    st.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const pc = new RTCPeerConnection();
    st.pc = pc;
    pc.addEventListener("track", (e) => {
      const stream = e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track]);
      els.audio.srcObject = stream;
      els.audio.play().catch(() => { /* autoplay may need the tap that started the call */ });
      attachMeter(stream);
    });
    for (const track of st.stream.getAudioTracks()) pc.addTrack(track, st.stream);
    const dc = pc.createDataChannel(DATA_CHANNEL);
    st.dc = dc;
    dc.addEventListener("message", (e) => onEvent(e.data));
    pc.addEventListener("connectionstatechange", () => {
      const s = pc.connectionState;
      if (s === "failed" || s === "closed") { end("peer_closed"); return; }
      if (s === "disconnected") {
        // Transient in WebRTC: give ICE its chance before hanging up on a network hop.
        if (!st.disconnectTimer) {
          st.disconnectTimer = setTimeout(() => {
            st.disconnectTimer = null;
            if (st.pc && st.pc.connectionState !== "connected" && !st.ended) end("peer_closed");
          }, DISCONNECT_GRACE_MS);
        }
        return;
      }
      if (s === "connected" && st.disconnectTimer) {
        clearTimeout(st.disconnectTimer);
        st.disconnectTimer = null;
      }
    });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    // The session (model, voice, instructions) rides on the secret; the URL is sent as given.
    const res = await fetch(sdpUrl, {
      method: "POST",
      headers: { authorization: "Bearer " + secret, "content-type": "application/sdp" },
      body: offer.sdp,
    });
    if (!res.ok) {
      const err = new Error("sdp");
      err.code = "sdp_" + res.status;
      throw err;
    }
    const answer = await res.text();
    await pc.setRemoteDescription({ type: "answer", sdp: answer });
  }

  // Amendment A2: the ElevenLabs path. call_elevenlabs.js (its own lane) gets the sheet's
  // elements and the same callbacks the OpenAI path uses, and answers a handle
  // { mute(on), close() }. The start response is handed over once and dropped here too.
  async function connectElevenLabs(start) {
    const mod = await import("./call_elevenlabs.js");
    const connectFn = mod.connectElevenLabs || mod.createElevenLabsCall || mod.default;
    if (typeof connectFn !== "function") {
      const err = new Error("elevenlabs");
      err.code = "elevenlabs_unavailable";
      throw err;
    }
    st.eleven = await connectFn({
      start,
      els,
      callbacks: {
        caption,
        segment,
        setStatus,
        flashReason,
        onEvent,
        setHisSpeaking,
        attachRemoteStream: attachMeter,
        setFace,
        end,
      },
    });
  }

  async function start() {
    // The AudioContext is made on the tap that started the call (iOS allows it there);
    // it feeds the level meter once the remote stream arrives.
    if (!st.audioCtx && typeof AudioContext === "function") {
      try { st.audioCtx = new AudioContext(); } catch { st.audioCtx = null; }
    }
    show();
    setStatus("Connecting", false);
    els.reason.replaceChildren();
    els.captions.replaceChildren();
    els.timer.textContent = "0:00";
    els.mute.setAttribute("aria-pressed", "false");
    st.faceKind = "idle";
    st.lastTalkAt = 0;
    loadFace();
    let r;
    try {
      r = await api("POST", "/api/calls/start", { conversationId: st.conversationId });
    } catch (e) {
      hide();
      throw e;
    }
    st.id = r && r.call ? String(r.call.id || "") : "";
    st.maxSeconds = Number(r && r.maxSeconds) || 0;
    st.tickSeconds = Number(r && r.tickSeconds) || TICK_SECONDS;
    try {
      if (r && r.provider === "elevenlabs") await connectElevenLabs(r);
      else await connect(r);
    } catch (e) {
      r = null;
      releaseMedia();
      // The cause, not the generic label: a blocked microphone says so.
      flashReason(micErrorLabel(e));
      setStatus("Ended", false);
      await end("provider_error");
      return;
    }
    r = null;
    st.live = true;
    st.startedAt = Date.now();
    st.lastTickAt = st.startedAt;
    setStatus("Live", true);
    st.clock = setInterval(clockTick, 500);
    st.ticker = setInterval(tick, st.tickSeconds * 1000);
    window.addEventListener("pagehide", onPageHide);
  }

  // The seconds ride along so the per-minute floor sees the time since the last tick (and
  // a call that ends before its first tick is not free); the server bounds the figure.
  function endBody(reason) {
    return { reason, segments: mergeSegments(st.segments), usage: st.usage, seconds: st.seconds };
  }

  function onPageHide() {
    if (!st.id || st.ended) return;
    st.ended = true;
    stopTimers();
    releaseMedia();
    const body = new Blob([JSON.stringify(endBody("page_hidden"))], { type: "application/json" });
    if (navigator.sendBeacon) navigator.sendBeacon("/api/calls/" + encodeURIComponent(st.id) + "/end", body);
  }

  async function end(reason) {
    if (st.ending) return st.ending;
    st.ending = (async () => {
      st.ended = true;
      st.live = false;
      stopTimers();
      releaseMedia();
      window.removeEventListener("pagehide", onPageHide);
      const label = REASON_LABEL[reason];
      // A more specific chip already set (a blocked microphone, a provider code) stays.
      if (label && reason !== "hangup" && !els.reason.childElementCount) flashReason(label);
      setStatus("Ended", false);
      let result = null;
      if (st.id) {
        try {
          result = await api("POST", "/api/calls/" + encodeURIComponent(st.id) + "/end", endBody(reason));
        } catch (e) {
          flashReason(e && e.code ? String(e.code) : "end_failed");
        }
      }
      setTimeout(hide, label && reason !== "hangup" ? 2200 : 400);
      if (opts.onEnd) opts.onEnd({ callId: st.id, reason, messageIds: result && Array.isArray(result.messageIds) ? result.messageIds : [] });
      return result;
    })();
    return st.ending;
  }

  function mute(on) {
    if (st.stream) for (const t of st.stream.getAudioTracks()) t.enabled = !on;
    if (st.eleven && typeof st.eleven.mute === "function") { try { st.eleven.mute(!!on); } catch { /* fine */ } }
    els.mute.setAttribute("aria-pressed", on ? "true" : "false");
  }

  return {
    start,
    end,
    mute,
    get live() { return st.live; },
    get ended() { return st.ended; },
    get id() { return st.id; },
    get face() { return st.faceKind; },
  };
}
