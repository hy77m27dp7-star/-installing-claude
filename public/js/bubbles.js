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

// `spans` ([start, end) pairs) are masked as well: a cut never lands inside one (fix0927:
// an emphasis span such as *no. way* stays whole).
function sentenceCuts(text, spans) {
  const mask = bracketMask(text);
  for (const [a, b] of spans || []) mask.fill(1, a, b);
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
function splitLong(text, spans) {
  const ends = sentenceCuts(text, spans);
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

// ------------------------------------------------------------ her *actions* (fix0927 lane A)

// Inside a paragraph an asterisk span is an ACTION when it sits at the paragraph's start or
// end (after trimming; a span touching an action there counts too), when it fills a line of
// its own, or when it holds ACTION_MIN_WORDS words or more. An action becomes its own stage
// line in reading order and the words around it become speech bubbles. A shorter span in
// the middle of speech ("i *really* mean it") is emphasis and stays inside its bubble. An
// asterisk without a partner is plain text. Nothing of her words is dropped or reordered:
// only the pair of asterisks around a span and the white space at a cut go.
export const ACTION_MIN_WORDS = 3;

// Every *span*, left to right: an asterisk pairs with the next asterisk when what sits
// between them is on one line and not only space (the pairing the old /\*([^*\n]+)\*/g
// made); a lone asterisk stays text.
export function asteriskSpans(text) {
  const s = String(text ?? "");
  const spans = [];
  let i = 0;
  while (i < s.length) {
    const open = s.indexOf("*", i);
    if (open < 0) break;
    const close = s.indexOf("*", open + 1);
    if (close < 0) break;
    const inner = s.slice(open + 1, close);
    if (inner.includes("\n") || !inner.trim()) {
      i = open + 1;
      continue;
    }
    spans.push({ start: open, end: close + 1, inner: inner.trim() });
    i = close + 1;
  }
  return spans;
}

function wordCount(s) {
  return String(s).split(/\s+/).filter(Boolean).length;
}

function blank(s) {
  return !s.trim();
}

// The runs of one speech bubble: plain text and *emphasis* (the asterisks gone), trimmed at
// both ends. Every span inside a speech piece is emphasis (its actions were cut out first).
export function speechRuns(text) {
  const s = String(text ?? "");
  const runs = [];
  let pos = 0;
  for (const sp of asteriskSpans(s)) {
    if (sp.start > pos) runs.push({ em: false, text: s.slice(pos, sp.start) });
    runs.push({ em: true, text: sp.inner });
    pos = sp.end;
  }
  if (pos < s.length) runs.push({ em: false, text: s.slice(pos) });
  if (runs.length && !runs[0].em) runs[0].text = runs[0].text.trimStart();
  const last = runs[runs.length - 1];
  if (last && !last.em) last.text = last.text.trimEnd();
  return runs.filter((r) => r.text);
}

function speechPiece(text) {
  return { kind: "speech", text, runs: speechRuns(text) };
}

// One paragraph (no blank line inside) as its pieces in reading order:
// { kind: "action", text } and { kind: "speech", text, runs }.
export function splitActions(paragraph) {
  const p = String(paragraph ?? "").trim();
  if (!p) return [];
  const spans = asteriskSpans(p);
  const n = spans.length;
  const action = spans.map((sp) => {
    if (wordCount(sp.inner) >= ACTION_MIN_WORDS) return true;
    const lineStart = p.lastIndexOf("\n", sp.start - 1) + 1;
    const nl = p.indexOf("\n", sp.end);
    const lineEnd = nl < 0 ? p.length : nl;
    return blank(p.slice(lineStart, sp.start)) && blank(p.slice(sp.end, lineEnd));
  });
  // The edges: a span with only space (or other spans) between it and the paragraph's start
  // or end is an action, so "*laughs* *covers her face* ok" and "ok *pulls you closer*
  // *smiles*" read as two stage lines each. fix0927 review: the chain is anchored at the edge
  // itself; a short span that only touches a mid-sentence action ("i said *leans in close
  // now* *so* dramatic") stays emphasis.
  for (let k = 0; k < n; k++) {
    if (!blank(p.slice(k === 0 ? 0 : spans[k - 1].end, spans[k].start))) break;
    action[k] = true;
  }
  for (let k = n - 1; k >= 0; k--) {
    if (!blank(p.slice(spans[k].end, k === n - 1 ? p.length : spans[k + 1].start))) break;
    action[k] = true;
  }
  const out = [];
  let from = 0;
  const flush = (to) => {
    const t = p.slice(from, to).trim();
    if (t) out.push(speechPiece(t));
  };
  for (let k = 0; k < n; k++) {
    if (!action[k]) continue;
    flush(spans[k].start);
    out.push({ kind: "action", text: spans[k].inner });
    from = spans[k].end;
  }
  flush(p.length);
  return out;
}

// A whole reply as its pieces: blank lines separate paragraphs (as in splitBubbles), each
// paragraph splits into actions and speech, and a speech piece over MAX_PARA characters is
// cut at its sentence ends as before (never inside an emphasis span). { long: false } keeps
// a long piece whole (his lines).
export function splitReply(text, opts) {
  const long = !(opts && opts.long === false);
  const s = String(text ?? "").replace(/\r\n?/g, "\n").trim();
  if (!s) return [];
  const out = [];
  for (const para of s.split(/\n[ \t]*\n+/).map((x) => x.trim()).filter(Boolean)) {
    for (const piece of splitActions(para)) {
      if (piece.kind !== "speech" || !long || piece.text.length <= MAX_PARA) {
        out.push(piece);
        continue;
      }
      const spans = asteriskSpans(piece.text).map((sp) => [sp.start, sp.end]);
      for (const t of splitLong(piece.text, spans)) out.push(speechPiece(t));
    }
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
