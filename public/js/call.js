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
import { api } from "./api.js";

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

// Data-channel event names (OpenAI Realtime, GA shapes).
const EV_HIS = "conversation.item.input_audio_transcription.completed";
const EV_HER_DONE = "response.output_audio_transcript.done";
const EV_HER_DELTA = "response.output_audio_transcript.delta";
const EV_SPEECH_STARTED = "input_audio_buffer.speech_started";
const EV_RESPONSE_DONE = "response.done";
const EV_ERROR = "error";

// One call from start to end. `els`: { sheet, status, timer, captions, reason, mute, end, audio }.
// Callbacks: onEnd({ callId, reason, messageIds }) after the server accepted the end.
export function createCall(opts) {
  const els = opts.els;
  const st = {
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
    st.clock = null;
    st.ticker = null;
  };

  const releaseMedia = () => {
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
    let r;
    try {
      r = await api("POST", "/api/calls/" + encodeURIComponent(st.id) + "/tick", { seconds: st.tickSeconds, usage: st.usage });
    } catch (e) {
      // A call the server no longer knows ends here; a blip does not.
      if (e && (e.status === 404 || e.status === 409)) end("provider_error");
      return;
    }
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
    });
    for (const track of st.stream.getAudioTracks()) pc.addTrack(track, st.stream);
    const dc = pc.createDataChannel(DATA_CHANNEL);
    st.dc = dc;
    dc.addEventListener("message", (e) => onEvent(e.data));
    pc.addEventListener("connectionstatechange", () => {
      const s = pc.connectionState;
      if (s === "failed" || s === "closed" || s === "disconnected") end("peer_closed");
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

  async function start() {
    show();
    setStatus("Connecting", false);
    els.reason.replaceChildren();
    els.captions.replaceChildren();
    els.timer.textContent = "0:00";
    els.mute.setAttribute("aria-pressed", "false");
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
      await connect(r);
    } catch (e) {
      r = null;
      releaseMedia();
      const code = e && e.code ? String(e.code) : "call_failed";
      flashReason(code);
      setStatus("Ended", false);
      await end("provider_error");
      return;
    }
    r = null;
    st.live = true;
    st.startedAt = Date.now();
    setStatus("Live", true);
    st.clock = setInterval(clockTick, 500);
    st.ticker = setInterval(tick, st.tickSeconds * 1000);
    window.addEventListener("pagehide", onPageHide);
  }

  function endBody(reason) {
    return { reason, segments: mergeSegments(st.segments), usage: st.usage };
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
      if (label && reason !== "hangup") flashReason(label);
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
    els.mute.setAttribute("aria-pressed", on ? "true" : "false");
  }

  return {
    start,
    end,
    mute,
    get live() { return st.live; },
    get ended() { return st.ended; },
    get id() { return st.id; },
  };
}
