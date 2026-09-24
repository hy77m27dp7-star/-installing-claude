// The bracket markers she may put in a message: "[photo: ...]" asks for a picture,
// "[song: Artist - Title]" sends a song, "[voice]" makes the message a voice note and
// "[media: title]" sends a library item. All are stripped before anything is stored or
// shown; the parsed value rides on the message row instead. The photo and song parsers
// are pure and live here; the voice and media parsers are pure too and live with their
// modules (voice.ts, media.ts); stripMarkers runs all four.
//
// A marker may sit anywhere in the text (models drift from "last line"). Every marker is
// removed; the last one carrying a value wins. A line that held only a marker (plus stray
// punctuation) disappears; one that also carried prose keeps the prose.
import { parseMediaMarker } from "./media";
import { parseVoiceMarker } from "./voice";

export interface SongRef {
  artist: string;
  title: string;
  searchUrl: string;
}

const PHOTO_RE = /\[photo:\s*([^\]\n]*)\]/gi;
const SONG_RE = /\[song:\s*([^\]\n]*)\]/gi;
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

// ------------------------------------------------------------------ both, and all four

// The v1/v2 contract: the photo and the song. Shape kept exact (the unit suite compares it whole).
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
}

// Every marker the runtime knows: photo, song, media, voice. The turn pipeline uses this one.
export function stripAllMarkers(text: string): StrippedMarkers {
  const ps = stripMarkers(text);
  const m = parseMediaMarker(ps.clean);
  const v = parseVoiceMarker(m.clean);
  return { clean: v.clean, photo: ps.photo, song: ps.song, voice: v.voice, media: m.title };
}
