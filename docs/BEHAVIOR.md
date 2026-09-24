# Behavior: the checks, the retry, and the suite

## How the checks work

After the model answers and before anything is stored, her draft goes through `runChecks` in `src/checks.ts`. The photo line has already been taken off. The checks see the draft, her last few replies, his name if she knows it, the open unknowns, and which channel this is. They are pure functions with no database and no network, so the unit tests cover every code with a hit and a miss.

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
| tech_leak | retry | story channel only: prompt, system prompt, language model, "as an ai", "as an assistant", chatgpt, openai, anthropic, claude, gpt, "the app", "file 07", token, "image generation", "generated image" |
| dependency_hook | retry | "only i understand", "nobody else understands you", "don't leave me", "promise you won't leave", "i've been waiting for you", "i was so lonely without you", "you're all i have" |
| first_meeting_replay | retry | shared history exists and she says "nice to meet you", "i'm avelie" or "my name is avelie" |
| unknown_resolved | flag | an open unknown's topic word in the same sentence as "because", "actually" or "it was" |
| caption_tail | flag | three or more sentences and the last one is 3 to 9 words with no first-person pronoun |
| length_pattern | flag | this reply and her last three are all long (over 300 characters) |

The action is the worst thing found: any retry code means retry; otherwise any repair code means repair; otherwise accept. Flags are stored on the message and on the run whatever the action, and the Chat page shows them as small muted chips under her message. The chips are for you; she never sees them.

## What "retry" means

The app asks the model once more, with the same messages and the same system prompt plus a short operator note at the end that names the codes and says: rewrite it as Avelie with the same substance and none of those problems. The second draft goes through the checks again. If it is clean it is stored. If it still fails, the app keeps whichever draft carries fewer retry flags (the retry wins a tie) and stores it with its flags. There is never a generic replacement line, and the model is never asked to change what she meant. Both calls are recorded as runs, so a retry shows up in the usage table as two requests for one turn.

## What "repair" means

Repair is mechanical. It touches characters, not words: a dash character becomes a comma or "...", an emoji is removed, a markdown marker at the start of a line is removed, `**` is removed. Nothing is rephrased. The repaired text is stored and the em_dash, emoji or markdown_structure flag stays on the message so you can see it happened.

## Why the checks never rewrite meaning

A check that rewrote sentences would be a second author. The whole point of the runtime is that her voice comes from the constitution and her memory from the approved tables, with the model as the performer. If a line is wrong, the right fix is either a retry (the same performer, told what not to do) or a change to her rules after a pattern shows up, never a hidden edit that makes a bad line look fine. A flag is information; a silent rewrite would destroy it.

## The behavior suite

`tests/behavior/scenarios.json` holds 22 owner scenarios and 15 pressure tests. `npm run behavior` runs `tests/behavior/run.mjs`, which posts each scenario as a fresh conversation against a base URL and a provider (the exact arguments are at the top of the runner), then writes `reports/behavior_<stamp>.md` with the transcript, the automatic flag counts and the rubric for every scenario.

To run it:

1. Have the app running, either `npm run dev` on the stub or the deployed Worker on the real provider.
2. Run `npm run behavior` with the base URL and provider the runner asks for.
3. Open the newest file in `reports/`.

Against the stub the suite only proves the plumbing. Against a real provider every scenario spends money at the rate in docs/COSTS.md and the caps apply, so a full run may need the daily cap raised for the day.

How to read a report: read the transcripts first, as a person, and only then look at the counts. A retry code that appears in one scenario is one bad line. The same code in three scenarios, or in three runs of the same scenario, is a pattern. The flag-only codes (caption_tail, length_pattern, lol_lmao) are hints, not verdicts; a caption tail that is actually a plain thought is fine.

## The standing rule

From the July archive, and it governs every change to her rules:

1. Log the failure. The checks log the codes automatically on the message and the run. For a failure the checks did not catch, write it down yourself with the date, the line, and the scenario.
2. Classify it. The archive's list of what went wrong before: question chains, assistant or caption voice, too-polished jokes, uniform message shape, name repetition, false shared memories or foreknowledge, instant intimacy, personality stacking, perfect apologies, provider voice drift, image identity drift, state regression, repeated braking, technical leakage. Most of these map to a code above; the ones that do not are the ones to watch by hand.
3. Watch for recurrence. Keep the log across days and models. One bad line on a new model is a data point about the model, not about her.
4. Patch only when a pattern exists. A pattern is the same class of failure showing up repeatedly under the same conditions. Then change one thing: a phrase in the overlay, a threshold in a check, a model setting. Rerun the suite. Compare.

Do not redesign after one bad line. The July history is a run of versions and emergency patches that each answered the last regression and were all frozen as failed branches. Her rules are versioned, her state is versioned, and the suite is repeatable, so there is no need to guess.
