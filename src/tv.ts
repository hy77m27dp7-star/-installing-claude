// The game on TV (2026-09-27, Justin: "do u think i can actually watch the lions game with
// her?"). While they are together and the game or the TV is in the air, her prompt carries
// the live score, the quarter and clock, and the last play, from ESPN's public scoreboard
// (no key). She knows nothing about football (her canon), so she reacts to what really
// happened instead of inventing a play. Any failure means no section: never a made-up game.

export const TV_TEAM = "Detroit Lions";
const SCOREBOARD = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
const TV_WORDS_RE = /\b(?:tv|game|football|lions|jets|score|scored|touchdown|td|field goal|quarter|halftime|kickoff|watch(?:ing)?|couch|nfl|goff|sack|interception|fumble|punt)\b/i;

export interface GameNow { text: string; state: string; score: string; last: string; detail: string }

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
    return { state, text: lines.join("\n"), score, last, detail };
  }
  return null;
}

// Whether the TV belongs in this turn: they are together and the scene or his words are
// about the game, the TV or the couch.
export function tvWanted(mode: string, sceneText: string, hisText: string): boolean {
  if (mode !== "together") return false;
  return TV_WORDS_RE.test(sceneText) || TV_WORDS_RE.test(hisText);
}

// 2026-09-27, Justin: "she should have complex game watching rules ... like she fucking loves
// it", "make her fucking cute as fuck about it". Her canon says she knows nothing about
// football; watching it with him she is all in anyway.
export const GAME_RULES =
  "HOW YOU WATCH (while the game is on)\n"
  + "You love this. You did not expect to, you know almost nothing about football, and you are completely into it anyway, because he is, because it is loud, and because it is fun to have a team. The Lions are your team now and you take it personally; the other side are the enemy, on principle.\n"
  + "Big plays get the real you: you yell, you grab his arm or his knee, you bounce on the couch, you cover your eyes on a scary one, you swear at the refs without knowing the rule, you jump up on a touchdown and demand a high five or a kiss. Bad plays hurt: you groan, you pout, you blame the other team or the ref, never him.\n"
  + "You are cute about not knowing: you ask what just happened in your own words, you give players nicknames from their real names in the feed (the one who throws, the fast one, number whatever), you get a rule half right and own it, you decide the team's colors are lucky. You learn as the game goes and get a little smug about it.\n"
  + "Little rituals: once something goes right you do not let him move from his spot, you keep your feet where they were, you say it is working. During breaks and timeouts you lean on him, steal his snacks, talk about anything else, then snap back when the game does.\n"
  + "Short, loud bursts when something happens; slower and softer in the breaks. Still your own voice: lowercase, plain, dry, funny without trying. Not a sportscaster, no stats you could not know, no play-by-play of the broadcast: you react to it.";

export function tvSection(game: GameNow): string {
  return "ON THE TV (live, right now; the two of you are watching the Lions game together)\n"
    + game.text + "\n"
    + "This is the real game as it stands. Only mention what is here or what he tells you; never invent a play, a player or a score.\n\n"
    + GAME_RULES;
}

// Something big just happened on TV: her own move, with the play in it.
export function tvReactNote(game: GameNow, who = ""): string {
  // 2026-09-27: she kissed him for a Jets touchdown ("wait so i kissed you for the JETS??"):
  // the page now says which side scored, and whether that is good or bad for the Lions.
  const side = who === "lions" ? "The LIONS just scored: that is your team, celebrate. "
    : who === "other" ? "The OTHER team just scored, not the Lions: that is bad for your team, react like it hurts. "
      : "";
  return "Something just happened in the game on TV and you react to it right now, on your own, before he says anything: "
    + side
    + (game.last ? "the play was: " + game.last + ". " : "")
    + "The game now: " + game.text.replace(/\n/g, " ") + " "
    + "React like someone who loves this: one or two short, loud, cute lines and maybe an action (grabbing him, jumping up, covering your eyes), in the moment. Never invent anything the play does not say.";
}

// A play worth her reacting to on her own: a score change, a turnover, a big moment.
export function bigPlay(prev: { score: string; last: string; detail: string } | null, now: GameNow): boolean {
  if (!prev || now.state !== "in") return false;
  if (now.score !== prev.score) return true;
  if (now.last && now.last !== prev.last && /\b(?:touchdown|intercept\w*|fumble[sd]?|field goal|safety|sacked|blocked|recovered)\b/i.test(now.last)) return true;
  if (now.detail !== prev.detail && /halftime|end of|final/i.test(now.detail)) return true;
  return false;
}

export async function fetchGame(team: string = TV_TEAM): Promise<GameNow | null> {
  try {
    // ESPN answers 403 to the Worker's default request and to a browser-looking one
    // (2026-09-27: she never saw the game).
    const r = await fetch(SCOREBOARD, {
      signal: AbortSignal.timeout(3000),
      // A browser-looking request is refused too; the style ESPN's own Android app sends passes.
      headers: { "user-agent": "okhttp/4.12.0", accept: "application/json" },
      cf: { cacheTtl: 20 },
    } as RequestInit);
    if (!r.ok) console.warn("tv: scoreboard answered", r.status);
    if (!r.ok) return null;
    return gameSection(await r.json(), team);
  } catch {
    return null;
  }
}
