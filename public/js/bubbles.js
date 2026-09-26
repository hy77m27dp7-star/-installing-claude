// Bubble splitting and timing. Pure: no DOM, importable under Node for the unit test.
// Her stored text never changes; this only decides how it arrives on screen.

export const MAX_PARA = 240;
export const BASE_MS = 350;
export const PER_CHAR_MS = 35;
export const CAP_MS = 2600;
export const PAUSE_MS = 900;
export const PAUSE_ONE_IN = 12;

// A sentence end: terminal punctuation, optional closing quote or bracket, then space.
const SENTENCE_END = /[.!?]+["')\]]*\s+/g;

// 1 for every character that sits inside [...] (a photo, song or media marker); a split
// never lands there even though the server strips markers before anything is stored.
function bracketMask(text) {
  const mask = new Uint8Array(text.length);
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "[") depth++;
    mask[i] = depth > 0 ? 1 : 0;
    if (c === "]" && depth > 0) depth--;
  }
  return mask;
}

function sentenceCuts(text) {
  const mask = bracketMask(text);
  const cuts = [];
  SENTENCE_END.lastIndex = 0;
  let m;
  while ((m = SENTENCE_END.exec(text))) {
    const cut = m.index + m[0].length;
    if (cut >= text.length) break;
    if (!mask[m.index]) cuts.push(cut);
  }
  return cuts;
}

// A paragraph over MAX_PARA characters becomes 2 or 3 bubbles cut at the sentence ends
// nearest the even split points. No sentence end: it stays one bubble.
function splitLong(text) {
  const ends = sentenceCuts(text);
  if (!ends.length) return [text];
  const n = Math.min(3, Math.max(2, Math.ceil(text.length / MAX_PARA)));
  const chosen = [];
  for (let k = 1; k < n; k++) {
    const target = (text.length * k) / n;
    const floor = chosen.length ? chosen[chosen.length - 1] : 0;
    let best = null;
    for (const e of ends) {
      if (e <= floor) continue;
      if (best === null || Math.abs(e - target) < Math.abs(best - target)) best = e;
    }
    if (best !== null) chosen.push(best);
  }
  const out = [];
  let from = 0;
  for (const c of chosen) {
    const piece = text.slice(from, c).trim();
    if (piece) out.push(piece);
    from = c;
  }
  const tail = text.slice(from).trim();
  if (tail) out.push(tail);
  return out.length ? out : [text];
}

// Blank lines separate bubbles; single newlines stay inside one.
export function splitBubbles(text) {
  const s = String(text ?? "").replace(/\r\n?/g, "\n").trim();
  if (!s) return [];
  const paras = s.split(/\n[ \t]*\n+/).map((p) => p.trim()).filter(Boolean);
  const out = [];
  for (const p of paras) {
    if (p.length <= MAX_PARA) out.push(p);
    else out.push(...splitLong(p));
  }
  return out;
}

export function bubbleDelayMs(text) {
  const len = String(text ?? "").length;
  return Math.min(CAP_MS, BASE_MS + PER_CHAR_MS * len);
}

// FNV-1a, 32 bit. Same id, same answer, on every device.
export function hashString(s) {
  let h = 0x811c9dc5;
  const str = String(s ?? "");
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// One reply in twelve pauses mid-typing (dots, a stop, dots again) before its first bubble.
export function pauseForId(id) {
  if (!id) return false;
  return hashString(id) % PAUSE_ONE_IN === 0;
}

// Real mode (SPEC_V4 section 6): a reply minutes away shows no dots (she is not typing
// for six minutes); the dots start this long before it lands, then the bubbles arrive at
// her cadence as above.
export const DOTS_LEAD_MS = 20000;

// Milliseconds until the dots should start for a reply landing at deliverAtMs: never
// negative, zero when it lands within the lead already.
export function dotsLeadMs(deliverAtMs, nowMs) {
  const at = Number(deliverAtMs);
  const now = Number(nowMs);
  if (!Number.isFinite(at) || !Number.isFinite(now)) return 0;
  return Math.max(0, at - now - DOTS_LEAD_MS);
}
