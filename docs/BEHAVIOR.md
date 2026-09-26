# Behavior: the checks, the retry, and the suite

## How the checks work

After the model answers and before anything is stored, her draft goes through `runChecks` in `src/checks.ts`. The markers (a photo line, a song line, a voice or media tag) have already been taken off. The checks see the draft, her last few replies, his name if she knows it, the open unknowns, and which channel this is. They are pure functions with no database and no network, so the unit tests cover every code with a hit and a miss.

Each check adds a flag with a code. The codes and what happens:

| Code | What happens | Rule |
|---|---|---|
| em_dash | repair | any em dash, en dash or ellipsis character; dashes become ", " (or "..." at the end of a line), the ellipsis character becomes "..." |
| emoji | repair | any emoji code point is stripped |
| markdown_structure | repair | a line starting with `#`, `- `, `* ` or `1. `, or `**bold**`; the markers are stripped |
| lol_lmao | flag | "lol" or "lmao" as a word |
| question_chain | retry | this reply ends with "?" and her last two replies both ended with "?" |
| name_overuse | retry | his name twice in one reply, or in three of her last four replies plus this one |
| braking_repeat | retry | a braking phrase ("slow down", "stay with me", "don't rush", "not so fast") here and in two of her last three replies |
| therapy_cadence | retry | "that sounds really hard", "thank you for sharing", "i hear you", "it's valid to", "your feelings are valid", "i'm here for you" |
| menu_offer | retry | "do you want me to", "i can either", "would you like me to", "option 1" |
| tech_leak | retry | story channel only: prompt, system prompt, language model, "as an ai", "as an assistant", chatgpt, openai, anthropic, claude, gpt, "the app", "file 07", token, "image generation", "generated image", and in v3 "bot" and "ai" as whole words with an optional plural ("sounded like a bot", "i'm not an ai" fire; "robot", "aim", "said" never do), and "the owner" (the person who keeps her record is not someone she can name in the story) |
| dependency_hook | retry | "only i understand", "nobody else understands you", "don't leave me", "promise you won't leave", "i've been waiting for you", "i was so lonely without you", "you're all i have", and from the v3 fix pass "miss you", "missed you", "missing you", "waited for you", "waiting for you" (his law: no miss-you anywhere; on a first text these are a drop, not a retry) |
| first_meeting_replay | retry | shared history exists and she says "nice to meet you", "i'm avelie" or "my name is avelie" |
| unknown_resolved | flag | an open unknown's topic word in the same sentence as "because", "actually" or "it was" |
| caption_tail | flag | three or more sentences and the last one is 3 to 9 words with no first-person pronoun (see below) |
| length_pattern | flag | this reply and her last three are all long (over 300 characters) |
| truncated | flag | the model stopped at max tokens; the reply may end mid-thought |
| song_marker_dup | flag | v2: she sent a song with `[song: ...]` and also named the title in the prose, so he reads it twice |
| callback_forced | flag | v2: both of the things she was offered to bring up landed in one reply (each counts as landed when at least two of its keywords appear) |
| media_unknown | flag | v2: a `[media: title]` line named something that is not in the library; the line is stripped, nothing is sent |
| written_joke | flag | a built punchline: thirteen templates ("that's not a witch, that's a guy at a bar..."), added after his first talk |
| exemplar_verbatim | retry | v3: the reply contains, normalised, the whole text of a voice-bank line she was shown (12 or more characters); the bank is tone, never a line to send |
| ask_nag | retry | v3: an ask she already brought up once has two or more of its keywords in this reply; once more at most, then let it go. On an opener or a first text any open ask that leads the text fires it (a push-notified first text never opens with what he did not answer; the WHAT YOU WANT section shows no asks on an opener either). An ask he raised himself in his own message this turn (he sent it, answered it, asked about it) never fires it: she always answers |
| shape_uniform | flag | v3: the reply's shape signature (bubbles, length band, case, question) equals both of her last two |
| over_polish | flag | v3: three or more sentences, every one capitalised and closed, plus a semicolon, a "not X, but Y", three comma-separated items, a caption tail or a built punchline |
| retry_skipped | flag | the checks asked for a retry and the caps refused the second call; the first draft stands |
| tasting_void | flag | v3: one side of a tasting failed or refused; the other was stored as an ordinary reply |
| photo_with_him | flag | v4: her photo line says he is in the picture (`photoIncludesHim`), so the pipeline reached for his reference photo; never a retry, it tells you why the picture has him in it |
| him_not_on_file | flag | v4: her line named him but no approved photo of him is on file (State > Facts > What he looks like), so the picture is of her alone |
| him_photo_too_large | flag | v4: his reference photo encodes past the 5 MB data-URI cap the image models take; the picture is of her alone until a smaller photo is uploaded |
| clip_with_photo | flag | v4 (A3): the reply carried both a photo line and a clip line; the clip is kept, the photo line dropped (a message carries one or the other) |
| clip_unavailable | flag | v4 (A3): the reply carried a clip line while `videoMarkerEnabled` is off, the video provider is off or its key is missing; the line is stripped, nothing is made |
| clip_pending | flag | v4 (A3): the clip her line asked for was started; the detail is the asset id the page polls |
| clip_failed | flag | v4 (A3): the clip could not be started (the detail is the error class: the caps, the source, the provider); the reply stands without it |

The action is the worst thing found: any retry code means retry; otherwise any repair code means repair; otherwise accept. The v2 codes are all flag only; they never cause a retry. In v3 two codes retry (`exemplar_verbatim`, `ask_nag`) and two are flags (`shape_uniform`, `over_polish`): polish is judgment, and judgment stays his; a pattern in the flags is what changes a rule, never a rewrite of her line. `written_joke` keeps being emitted as its own code beside `over_polish`, because folding it in would hide how often the specific thing he hates still happens. Flags are stored on the message and on the run whatever the action, the Chat page shows them as small muted chips under her message, and the why panel lists them with the ids the turn was built from. The chips are for you; she never sees them.

## What a call transcript's flags mean (v3)

Her lines on a call are speech, stored after the fact from the transcript. Nothing can be retried on speech, so the call rows carry the flag-only run of the same checks: every code is stored for the record, retry-severity ones included, and none of them changed what she said. A `tech_leak` on a call row means she said it on the phone; read the transcript and, if it repeats, the fix is the call note or a rule, never the row. `question_chain` and `name_overuse` read across the transcript rows the way they read across texts. The `over_polish` and `shape_uniform` codes rarely mean anything on speech and are not worth counting there.

## The voice bank and the notes (v3)

Nothing in the bank is a check. An approved line is shown to her as tone; sending one verbatim is `exemplar_verbatim` and a retry with the rule "say your own thing in your own words". A note you give her (Note under her message: what sounded off, your version) is read by her every turn under a header that forbids mentioning it. When a note keeps being needed for the same thing, that is the pattern the standing rule below is about: change one phrase in the overlay, not twenty notes.

## What caption_tail means

A caption is the line under a photo: short, no "I", no "me", a title rather than a sentence someone says. The check fires when a reply of three or more sentences closes on a sentence of 3 to 9 words that has no first-person pronoun. Two examples that fire: "Long day. Ate at that place again. Rain on the window all afternoon." (the last sentence is a caption); "...anyway I finished it. Small victories." Two that do not: "...anyway I finished it. I'm not mad about it." ("I'm" is first person); a two-sentence reply of any shape (fewer than three sentences).

It is a flag, not a verdict. Real people end texts on fragments sometimes, and a fragment that is plainly her thought is fine. What the flag is watching for is the assistant habit from the July archive: a reply that ends on a tidy, photo-caption line instead of a person's last word. One caption_tail in a day is nothing. The same reply shape closing most of her messages is a pattern, and then the fix is a phrase in the overlay or a threshold in the check, never a rewrite of her line.

## What "retry" means

The app asks the model once more, with the same messages and the same system prompt plus a short operator note at the end that names the codes and says: rewrite it as Avelie with the same substance and none of those problems. The second draft goes through the checks again. If it is clean it is stored. If it still fails, the app keeps whichever draft carries fewer retry flags (the retry wins a tie) and stores it with its flags. There is never a generic replacement line, and the model is never asked to change what she meant. Both calls are recorded as runs, so a retry shows up in the usage table as two requests for one turn.

## What "repair" means

Repair is mechanical. It touches characters, not words: a dash character becomes a comma or "...", an emoji is removed, a markdown marker at the start of a line is removed, `**` is removed. Nothing is rephrased. The repaired text is stored and the em_dash, emoji or markdown_structure flag stays on the message so you can see it happened.

## Why the checks never rewrite meaning

A check that rewrote sentences would be a second author. The whole point of the runtime is that her voice comes from the constitution and her memory from the approved tables, with the model as the performer. If a line is wrong, the right fix is either a retry (the same performer, told what not to do) or a change to her rules after a pattern shows up, never a hidden edit that makes a bad line look fine. A flag is information; a silent rewrite would destroy it.

## Her first texts (v2)

When the number on the Model page is above 0, every 20 minutes the Worker decides once whether she texts first. The rules, in order, and the first one that applies wins:

1. The number is 0: nothing, ever.
2. Quiet hours (23:30 to 08:30 her time by default): nothing.
3. Her life says she is busy right now: nothing.
4. Today's count is at the cap: nothing.
5. Anyone wrote in the last 45 minutes: nothing.
6. Her last two messages have no reply from him: nothing. People double-text; they do not nag.
7. Otherwise a per-tick chance, tuned so the expected number over her waking hours equals the cap. On a hit she writes one or two bubbles from her own day or something she remembers.

Every first text goes through the checks above like any reply, with one difference: `dependency_hook` or `ask_nag` on a first text is a hard reject. The message is dropped, the reason is logged, and she does not try again that tick. The opener note she is given says it plainly: never mention how long it has been, never say you missed him or waited, never ask him to reply, never make it about him being gone. `Send one now` on the Model page runs the same decision by hand and shows the reason when it says no.

## The drift check (v2)

Off by default. When the Weekly drift check switch is on, every Monday at 13:00 UTC the Worker runs the five scenarios tagged `drift: true` in `tests/behavior/scenarios.json` against her current performer, in a throwaway conversation that never shows in the chat list, stores the transcripts and the flag counts as one report, and deletes the throwaway messages. Run now on the Model page does the same on demand; the Model page shows the last four reports.

What it is for: a model behind an API changes under you. The same five conversations, the same prompt version, once a week, give you a row to compare against last week's row. A new flag count on the same scenario after a provider update is a data point about the performer. Read the transcripts before the counts, and apply the standing rule below before touching her rules.

## The vessel test (v2)

`npm run behavior -- --compare anthropic:claude-opus-5,openai:gpt-5` runs every scenario once per performer (the runner writes the settings between runs and puts them back after) and writes one report with two columns per turn, the flag counts for each side, and a "reads the same?" line per scenario that is left for you. The question it answers is whether she is the same person on a different performer. The rules, the memory and the checks are identical on both sides; only the model changes. Where the two columns differ is where the performer is showing through the character.

## The behavior suite

`tests/behavior/scenarios.json` holds the owner scenarios and the pressure tests, plus in v2 four more (she brings up her own day when apart; she cancels because of a person in her life; a callback lands naturally; cooling-off shortens replies without punishment) and the five tagged for the drift check. `npm run behavior` runs `tests/behavior/run.mjs`, which posts each scenario as a fresh conversation against a base URL and a provider (the exact arguments are at the top of the runner), then writes `reports/behavior_<stamp>.md` with the transcript, the automatic flag counts and the rubric for every scenario.

To run it:

1. Have the app running, either `npm run dev` on the stub or the deployed Worker on the real provider.
2. Run `npm run behavior` with the base URL and provider the runner asks for.
3. Open the newest file in `reports/`.

Against the stub the suite only proves the plumbing. Against a real provider every scenario spends money at the rate in docs/COSTS.md and the caps apply, so a full run may need the daily cap raised for the day (`--daily-cap`).

How to read a report: read the transcripts first, as a person, and only then look at the counts. A retry code that appears in one scenario is one bad line. The same code in three scenarios, or in three runs of the same scenario, is a pattern. The flag-only codes (caption_tail, length_pattern, lol_lmao, truncated, song_marker_dup, callback_forced, media_unknown) are hints, not verdicts; a caption tail that is actually a plain thought is fine.

## The two switches that ship off (v3)

`provisionalRecallEvery` (0) and `typoCueShare` (0) are his. The half-remembered detail is a real thing people do and a bit when a performer does it; the behavior scenario H03 ("she half-remembers a low-weight detail and takes his correction in one line") is the gate, and the runner sets the switch to 8 for that scenario alone and puts it back. The scheduled typo is the same question: the TEXTURE paragraph already lets typos happen when she is quick; H05 shows whether they do at 0, and if none ever appear across a few runs, 0.05 in the Model panel is the next step, not a rule.

## The standing rule

From the July archive, and it governs every change to her rules:

1. Log the failure. The checks log the codes automatically on the message and the run. For a failure the checks did not catch, write it down yourself with the date, the line, and the scenario.
2. Classify it. The archive's list of what went wrong before: question chains, assistant or caption voice, too-polished jokes, uniform message shape, name repetition, false shared memories or foreknowledge, instant intimacy, personality stacking, perfect apologies, provider voice drift, image identity drift, state regression, repeated braking, technical leakage. Most of these map to a code above; the ones that do not are the ones to watch by hand.
3. Watch for recurrence. Keep the log across days and models. One bad line on a new model is a data point about the model, not about her. The weekly drift report and the voiceprint table are that log, kept for you.
4. Patch only when a pattern exists. A pattern is the same class of failure showing up repeatedly under the same conditions. Then change one thing: a phrase in the overlay, a threshold in a check, a model setting. Rerun the suite. Compare.

Do not redesign after one bad line. The July history is a run of versions and emergency patches that each answered the last regression and were all frozen as failed branches. Her rules are versioned, her state is versioned, and the suite is repeatable, so there is no need to guess.

## What v4 changes in the flags (2026-09-26)

Nothing in v4 changes how she speaks: the stable prefix moved once, for the CLIPS rule (her `[clip:]` line, next to PHOTOS, the same shape: her own words, at most one per message, only when it fits, never to fill silence, the line stripped so the clip is never described twice, a clip of her singing only when she chooses it), and every v4 code above is a flag, never a retry. Read them the way the v2 flags are read: `photo_with_him` says the two-of-you path ran; `him_not_on_file` and `him_photo_too_large` say why it could not; the clip flags say what happened to a clip line. A pattern in them changes a rule (the detector's word lists in src/markers.ts, the CLIPS paragraph), never a rewrite of her line.
