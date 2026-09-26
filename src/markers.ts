// The bracket markers she may put in a message: "[photo: ...]" asks for a picture,
// "[song: Artist - Title]" sends a song, "[voice]" makes the message a voice note,
// "[media: title]" sends a library item and "[clip: ...]" (v4, SPEC_V4 A3) sends a short
// video of herself. All are stripped before anything is stored or shown; the parsed value
// rides on the message row instead. The photo, song and clip parsers are pure and live
// here; the voice and media parsers are pure too and live with their modules (voice.ts,
// media.ts); stripAllMarkers runs all five.
//
// A marker may sit anywhere in the text (models drift from "last line"). Every marker is
// removed; the last one carrying a value wins. A line that held only a marker (plus stray
// punctuation) disappears; one that also carried prose keeps the prose.
//
// Also here (v4, SPEC_V4 section 3): the pure detector that reads her photo description
// and says whether he is in the picture, so the pipeline knows when to reach for his
// reference photo. Nothing about that reaches her.
import { parseMediaMarker } from "./media";
import { parseVoiceMarker } from "./voice";

export interface SongRef {
  artist: string;
  title: string;
  searchUrl: string;
}

const PHOTO_RE = /\[photo:\s*([^\]\n]*)\]/gi;
const SONG_RE = /\[song:\s*([^\]\n]*)\]/gi;
const CLIP_RE = /\[clip:\s*([^\]\n]*)\]/gi;
// What a line may be left with once its marker is gone and still count as empty.
const LEFTOVER_RE = /^[\s.,;:!?)]*$/;

// "Artist - Title": a spaced hyphen, a spaced double hyphen, or (built at runtime so this
// file stays typography-clean) a spaced en or em dash the model may have produced.
const SEPARATOR_RE = new RegExp("\\s+(?:-{1,2}|[" + String.fromCharCode(0x2013, 0x2014) + "])\\s+");
const MAX_PART = 200;
const SPOTIFY_SEARCH = "https://open.spotify.com/search/";

// Strips every match of `re` from the text, line by line. Returns the cleaned text and
// the raw inner values in order of appearance.
function strip(text: string, re: RegExp): { clean: string; values: string[] } {
  const values: string[] = [];
  const kept: string[] = [];

  for (const line of text.split(/\r?\n/)) {
    let had = false;
    const stripped = line.replace(re, (_m, d: string) => {
      had = true;
      values.push(d.trim());
      return "";
    });
    if (!had) {
      kept.push(line);
      continue;
    }
    if (LEFTOVER_RE.test(stripped)) continue;
    kept.push(stripped.replace(/[ \t]{2,}/g, " ").trimEnd());
  }

  return { clean: kept.join("\n").trimEnd(), values };
}

// ------------------------------------------------------------------ photo

export function parsePhotoMarker(text: string): { clean: string; description: string | null } {
  const { clean, values } = strip(text, PHOTO_RE);
  let description: string | null = null;
  for (const v of values) if (v) description = v;
  return { clean, description };
}

// ------------------------------------------------------------------ song

export function songSearchUrl(artist: string, title: string): string {
  return SPOTIFY_SEARCH + encodeURIComponent((artist + " " + title).trim());
}

// "Artist - Title" -> the song; anything without both halves is not one (the marker is
// still stripped, the way an empty photo marker is).
function parseSong(inner: string): SongRef | null {
  const m = SEPARATOR_RE.exec(inner);
  if (!m || m.index === undefined) return null;
  const artist = inner.slice(0, m.index).trim().slice(0, MAX_PART);
  const title = inner.slice(m.index + m[0].length).trim().slice(0, MAX_PART);
  if (!artist || !title) return null;
  return { artist, title, searchUrl: songSearchUrl(artist, title) };
}

export function parseSongMarker(text: string): { clean: string; song: SongRef | null } {
  const { clean, values } = strip(text, SONG_RE);
  let song: SongRef | null = null;
  for (const v of values) {
    const s = parseSong(v);
    if (s) song = s;
  }
  return { clean, song };
}

// ------------------------------------------------------------------ clip (v4, SPEC_V4 A3)

// "[clip: what the clip shows, in her own words]": at most one per message by her rules;
// when a model writes two, the last one carrying words wins and every marker is stripped,
// exactly as the photo marker is handled.
export function parseClipMarker(text: string): { clean: string; description: string | null } {
  const { clean, values } = strip(text, CLIP_RE);
  let description: string | null = null;
  for (const v of values) if (v) description = v;
  return { clean, description };
}

// ------------------------------------------------------------------ both, and all five

// The v1/v2 contract: the photo and the song. Shape kept exact (the unit suite compares it
// whole with deepEqual, so the clip rides on stripAllMarkers below, not here).
export function stripMarkers(text: string): { clean: string; photo: string | null; song: SongRef | null } {
  const p = parsePhotoMarker(text);
  const s = parseSongMarker(p.clean);
  return { clean: s.clean, photo: p.description, song: s.song };
}

export interface StrippedMarkers {
  clean: string;
  photo: string | null;
  song: SongRef | null;
  // She asked for this message to go as a voice note (SPEC_V2 section S).
  voice: boolean;
  // The library title she named (SPEC_V2 section V); resolved by the runtime.
  media: string | null;
  // v4 (SPEC_V4 A3): the clip she is sending, in her own words; the pipeline starts it.
  clip: string | null;
}

// Every marker the runtime knows: photo, song, media, voice, clip. The turn pipeline uses this one.
export function stripAllMarkers(text: string): StrippedMarkers {
  const ps = stripMarkers(text);
  const m = parseMediaMarker(ps.clean);
  const v = parseVoiceMarker(m.clean);
  const c = parseClipMarker(v.clean);
  return { clean: c.clean, photo: ps.photo, song: ps.song, voice: v.voice, media: m.title, clip: c.description };
}

// ------------------------------------------------------------------ him in the picture (v4, SPEC_V4 section 3)

// Her photo description says he is in it. Strong: an unmistakable co-presence phrase.
export const HIM_STRONG_RE = /\b(?:the two of us|both of us|us two|us both|selfie (?:of|with) (?:us|you|him)|(?:you|him) and me|me and (?:you|him)|(?:you|he)(?:'re|'s| are| is)? (?:next to|beside|behind|holding|hugging|kissing) me|(?:your|his) (?:shoulder|shoulders|arm|arms|hand|hands|lap|chest|neck|face|hair|beard|glasses|sunglasses|jacket|hoodie|shirt)|(?:leaning|resting|my head) (?:on|against) (?:you|him)|with (?:you|him) in it|(?:you|him) in (?:it|the (?:picture|photo|shot|frame)))\b/i;

// Weak: "us" or "him" as the subject of the picture (at the start, after "of", or next to a
// co-presence word). A bare "we", "us", "him", "you" or "your" is not a signal: "the view we
// talked about", "the barista behind me, him again", "trust us, the light was better in
// person" and "the sweater you like" are pictures of her.
export const HIM_WEAK_RE = /(?:^\s*(?:us|him)\b|\bof (?:us|him)\b|\b(?:with|next to|beside|behind|holding|hugging|against|leaning (?:on|against)) (?:him|us)\b|\b(?:him|us) (?:next to|beside|behind|in front of|holding) me\b)/i;

// Absent: she says outright that it is her alone.
export const HIM_ABSENT_RE = /\b(?:alone|just me|only me|by myself|me only|without (?:you|him)|no one else|nobody else|of (?:me|myself))\b/i;

// Strong -> true; else weak and not absent -> true; else false.
export function photoIncludesHim(description: string): boolean {
  if (typeof description !== "string" || !description.trim()) return false;
  if (HIM_STRONG_RE.test(description)) return true;
  return HIM_WEAK_RE.test(description) && !HIM_ABSENT_RE.test(description);
}
