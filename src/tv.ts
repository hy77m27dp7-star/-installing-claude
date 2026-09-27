// The game on TV (2026-09-27, Justin: "do u think i can actually watch the lions game with
// her?"). While they are together and the game or the TV is in the air, her prompt carries
// the live score, the quarter and clock, and the last play, from ESPN's public scoreboard
// (no key). She knows nothing about football (her canon), so she reacts to what really
// happened instead of inventing a play. Any failure means no section: never a made-up game.

export const TV_TEAM = "Detroit Lions";
const SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
const TV_WORDS_RE = /\b(?:tv|game|football|lions|jets|score|scored|touchdown|td|field goal|quarter|halftime|kickoff|watch(?:ing)?|couch|nfl|goff|sack|interception|fumble|punt)\b/i;

export interface GameNow { text: string; state: string }

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

// Pure: the section from one scoreboard payload, or null when the team has no game on it.
export function gameSection(payload: unknown, team: string = TV_TEAM): GameNow | null {
  for (const e of arr(obj(payload).events)) {
    const ev = obj(e);
    const comp = obj(arr(ev.competitions)[0]);
    const sides = arr(comp.competitors).map(obj);
    if (!sides.some((s) => str(obj(s.team).displayName) === team)) continue;
    const status = obj(obj(comp.status).type);
    const state = str(status.state); // pre, in, post
    const detail = str(status.detail) || str(status.description);
    const score = sides.map((s) => `${str(obj(s.team).displayName)} ${str(s.score) || "0"}`).join(", ");
    const sit = obj(comp.situation);
    const last = str(obj(sit.lastPlay).text);
    const down = str(sit.downDistanceText);
    const possId = str(sit.possession);
    const poss = sides.find((s) => str(obj(s.team).id) === possId);
    const lines: string[] = [];
    if (state === "pre") lines.push(`${str(ev.name)}, not started yet (${detail}).`);
    else if (state === "post") lines.push(`Final: ${score}.`);
    else {
      lines.push(`${score}. ${detail}.`);
      if (poss) lines.push(`${str(obj(poss.team).displayName)} have the ball${down ? ", " + down : ""}.`);
      if (last) lines.push(`Last play: ${last}`);
    }
    return { state, text: lines.join("\n") };
  }
  return null;
}

// Whether the TV belongs in this turn: they are together and the scene or his words are
// about the game, the TV or the couch.
export function tvWanted(mode: string, sceneText: string, hisText: string): boolean {
  if (mode !== "together") return false;
  return TV_WORDS_RE.test(sceneText) || TV_WORDS_RE.test(hisText);
}

export function tvSection(game: GameNow): string {
  return "ON THE TV (live, right now; the two of you are watching the Lions game together)\n"
    + game.text + "\n"
    + "This is the real game as it stands. You know nothing about football: react like it, ask him who is who and what just happened, cheer when he cheers. "
    + "Only mention what is here or what he tells you; never invent a play, a player or a score.";
}

export async function fetchGame(team: string = TV_TEAM): Promise<GameNow | null> {
  try {
    const r = await fetch(SCOREBOARD, { signal: AbortSignal.timeout(3000), cf: { cacheTtl: 20 } } as RequestInit);
    if (!r.ok) return null;
    return gameSection(await r.json(), team);
  } catch {
    return null;
  }
}
