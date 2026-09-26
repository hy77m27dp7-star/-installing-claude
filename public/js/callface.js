// The call face (SPEC_V4 section 2): three looped clips of her, one per moment (idle,
// listening, talking), stacked in one frame on the call sheet and switched by her audio
// level and his speech. Each kind is a LoopPlayer: two muted videos of the same clip, B
// fading in over the last 350 ms of A so the loop seam is never seen, the roles swapping.
// Only the active kind's pair plays; the other pairs sit paused at frame 0 (a phone caps
// concurrent decoders). No clips, or the provider off: the avatar with a breathing pulse.
//
// The pure part (faceStateFor) has no DOM and is imported under Node by the unit test, so
// nothing here touches document or window at import time; nav.js (which builds the nav on
// load) is imported on demand, only when the avatar fallback is needed.

export const FACE_KINDS = ["idle", "listening", "talking"];
// Her level: talking from 0.020 RMS, held while above 0.012, and for 350 ms after the
// last time it was above the enter level (a breath between words is not a state change).
export const TALK_ENTER = 0.020;
export const TALK_HOLD = 0.012;
export const TALK_HOLD_MS = 350;
// The loop seam and the two fades.
export const LOOP_SEAM_S = 0.35;
export const LOOP_FADE_MS = 350;
export const STATE_FADE_MS = 300;
export const AVATAR_SIZE = 160;

// Pure: the face for this instant. `lastTalkAt` is the last time (ms) the level was at or
// above TALK_ENTER (0 when never). Talking beats listening; listening while he speaks;
// idle otherwise.
export function faceStateFor(rms, hisSpeaking, prev, now, lastTalkAt) {
  const level = Number(rms);
  const t = Number(now);
  const last = Number(lastTalkAt);
  if (Number.isFinite(level) && level >= TALK_ENTER) return "talking";
  if (prev === "talking" && Number.isFinite(level) && level >= TALK_HOLD) return "talking";
  if (Number.isFinite(t) && Number.isFinite(last) && last > 0 && t - last >= 0 && t - last <= TALK_HOLD_MS) return "talking";
  if (hisSpeaking) return "listening";
  return "idle";
}

// The kind a callface row's notes name ("callface:idle", "callface:idle | good", or a claim
// note's "kind:idle" part). The same reading as src/callface.ts callFaceKindOf.
export function callFaceKindOf(notes) {
  if (typeof notes !== "string" || !notes) return null;
  for (const raw of notes.split("|")) {
    const part = raw.trim();
    let value = null;
    if (part.startsWith("callface:")) value = part.slice("callface:".length).trim();
    else if (part.startsWith("kind:")) value = part.slice("kind:".length).trim();
    if (value !== null && FACE_KINDS.includes(value)) return value;
  }
  return null;
}

// RMS (0 to 1) of one analyser frame of 8-bit time-domain samples (128 is silence).
export function rmsOf(samples) {
  if (!samples || !samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = (samples[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / samples.length);
}

function reducedMotion() {
  try {
    return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function makeVideo(src) {
  const v = document.createElement("video");
  v.muted = true;
  v.defaultMuted = true;
  v.loop = false;
  v.setAttribute("muted", "");
  v.setAttribute("playsinline", "");
  v.setAttribute("preload", "auto");
  v.setAttribute("aria-hidden", "true");
  v.src = src;
  v.style.opacity = "0";
  return v;
}

function fadeTo(el, opacity, ms) {
  el.style.transition = ms > 0 ? "opacity " + ms + "ms linear" : "none";
  // Force the transition to start from the current value.
  void el.offsetWidth;
  el.style.opacity = String(opacity);
}

// One kind's seamless loop: two videos of the same source, A playing, B fading in over
// the seam, then the roles swap. play() starts it, stop() pauses both at frame 0,
// firstFrame() shows frame 0 and nothing moves (reduced motion).
function loopPlayer(src, still) {
  const wrap = document.createElement("div");
  wrap.className = "face-pair";
  wrap.style.position = "absolute";
  wrap.style.inset = "0";
  wrap.style.opacity = "0";
  const a = makeVideo(src);
  const b = makeVideo(src);
  wrap.append(a, b);
  let active = a;
  let standby = b;
  let playing = false;
  let swapping = false;
  let raf = 0;
  let swapTimer = 0;

  const swap = () => {
    if (swapping) return;
    swapping = true;
    try { standby.currentTime = 0; } catch { /* not seekable yet */ }
    standby.play().catch(() => { /* a decoder busy; the seam shows once */ });
    fadeTo(standby, 1, LOOP_FADE_MS);
    swapTimer = setTimeout(() => {
      swapTimer = 0;
      const old = active;
      active = standby;
      standby = old;
      old.pause();
      fadeTo(old, 0, 0);
      try { old.currentTime = 0; } catch { /* fine */ }
      swapping = false;
    }, LOOP_FADE_MS);
  };

  const tick = () => {
    if (!playing) return;
    const d = active.duration;
    if (Number.isFinite(d) && d > 0 && active.currentTime >= d - LOOP_SEAM_S) swap();
    raf = requestAnimationFrame(tick);
  };

  return {
    el: wrap,
    play() {
      if (still) { this.firstFrame(); return; }
      if (playing) return;
      playing = true;
      fadeTo(active, 1, 0);
      active.play().catch(() => { /* needs the tap that started the call; the frame shows */ });
      raf = requestAnimationFrame(tick);
    },
    stop() {
      playing = false;
      swapping = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      if (swapTimer) clearTimeout(swapTimer);
      swapTimer = 0;
      for (const v of [a, b]) {
        v.pause();
        try { v.currentTime = 0; } catch { /* fine */ }
      }
      fadeTo(standby, 0, 0);
      fadeTo(active, 1, 0);
    },
    firstFrame() {
      this.stop();
      fadeTo(active, 1, 0);
    },
    onPlaying(fn) {
      let done = false;
      const fire = () => { if (!done) { done = true; fn(); } };
      active.addEventListener("playing", fire, { once: true });
      // A frame that never fires (autoplay refused) still gets its fade.
      setTimeout(fire, 400);
    },
    destroy() {
      this.stop();
      for (const v of [a, b]) {
        try { v.removeAttribute("src"); v.load(); } catch { /* fine */ }
      }
      wrap.remove();
    },
  };
}

// Builds the face in `container` from a CallFaceState (GET /api/callface). Returns
// { setState(kind), destroy(), kinds }. A kind without an approved clip falls back to idle;
// with no clips at all, or the provider off, the frame shows the avatar breathing.
export function createFacePlayer(container, state) {
  const still = reducedMotion();
  const clips = state && state.clips && typeof state.clips === "object" ? state.clips : {};
  const off = !state || state.provider === "off";
  const players = {};
  if (!off) {
    for (const kind of FACE_KINDS) {
      const row = clips[kind];
      if (row && row.id && row.approval_status === "approved") {
        players[kind] = loopPlayer("/media/" + encodeURIComponent(String(row.id)), still);
      }
    }
  }
  const kinds = Object.keys(players);
  const frame = container;
  frame.classList.add("face-frame");
  frame.replaceChildren();
  frame.setAttribute("data-face", "idle");
  // The state word, a label in the corner of the frame (the stylesheet's .face-word).
  const word = document.createElement("span");
  word.className = "face-word";
  word.setAttribute("aria-live", "off");
  const mark = (kind) => {
    frame.setAttribute("data-face", kind);
    word.textContent = kind;
    for (const k of kinds) players[k].el.classList.toggle("active", k === kind);
  };
  let current = null;
  let currentKind = "idle";
  let fadeTimer = 0;
  let destroyed = false;

  if (!kinds.length) {
    // The avatar, breathing (the pulse is CSS on #callFace .avatar; off under
    // prefers-reduced-motion by the stylesheet).
    const holder = document.createElement("div");
    holder.className = "face-avatar";
    frame.append(holder, word);
    word.textContent = "idle";
    import("./nav.js").then((nav) => {
      if (destroyed) return;
      if (typeof nav.avatarImg === "function") {
        const img = nav.avatarImg(AVATAR_SIZE);
        if (img) holder.append(img);
      }
    }).catch(() => { /* the frame stays empty */ });
    return {
      kinds,
      get state() { return currentKind; },
      setState(kind) {
        currentKind = FACE_KINDS.includes(kind) ? kind : "idle";
        frame.setAttribute("data-face", currentKind);
        word.textContent = currentKind;
      },
      destroy() { destroyed = true; frame.replaceChildren(); frame.removeAttribute("data-face"); },
    };
  }

  for (const kind of kinds) frame.append(players[kind].el);
  frame.append(word);

  const resolve = (kind) => (players[kind] ? kind : players.idle ? "idle" : kinds[0]);

  const setState = (kind) => {
    if (destroyed) return;
    const want = resolve(FACE_KINDS.includes(kind) ? kind : "idle");
    const next = players[want];
    if (!next || next === current) {
      currentKind = want;
      mark(want);
      return;
    }
    if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = 0; }
    const prev = current;
    current = next;
    currentKind = want;
    mark(want);
    if (still) {
      // Reduced motion: the idle first frame only, no crossfades, nothing moves.
      for (const k of kinds) fadeTo(players[k].el, players[k] === next ? 1 : 0, 0);
      next.firstFrame();
      return;
    }
    next.play();
    next.onPlaying(() => {
      if (destroyed || current !== next) return;
      fadeTo(next.el, 1, STATE_FADE_MS);
      if (prev) fadeTo(prev.el, 0, STATE_FADE_MS);
      fadeTimer = setTimeout(() => {
        fadeTimer = 0;
        // A state that flipped back inside the fade keeps its pair playing.
        for (const k of kinds) if (players[k] !== current) players[k].stop();
      }, STATE_FADE_MS);
    });
  };

  // The frame opens on idle (or the first kind there is) at once.
  const first = players.idle ? "idle" : kinds[0];
  current = players[first];
  currentKind = first;
  mark(first);
  if (still) {
    fadeTo(current.el, 1, 0);
    current.firstFrame();
  } else {
    fadeTo(current.el, 1, 0);
    current.play();
  }

  return {
    kinds,
    get state() { return currentKind; },
    setState,
    destroy() {
      destroyed = true;
      if (fadeTimer) clearTimeout(fadeTimer);
      for (const k of kinds) players[k].destroy();
      frame.replaceChildren();
      frame.removeAttribute("data-face");
    },
  };
}
