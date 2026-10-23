// ---------------------------------------------------------------------------
// replays/eye/eyeAgent.js
// One conversation turn with aim4 eye: ask the model, run the tools it asks
// for, hand the results back, and repeat until it answers.
//
// The model runs on the user's own computer (the aim4 desktop app) and is
// reached through the server's relay (POST /api/eye/chat, server-sent events
// in the OpenAI streaming shape). The tools run here, in the page.
// ---------------------------------------------------------------------------

import { accessToken } from '../api.js';
import { MEMORY_PROMPT, transcriptOf } from './eyeCommands.js';
import {
  CHARS_PER_TOKEN,
  MEMORY_CHARS,
  MODEL_CONTEXT,
  OUTPUT_TOKENS,
  TEMPLATE_TOKENS,
  applyFold,
  compactHistory,
  digestOf,
  foldPoint,
  historyBudget,
  memoryOf,
  modelMessages,
  recallEarlier,
  sizeOf,
  turnsOf
} from './eyeContext.js';
import { limitImages } from './eyeImages.js';
import { resetTurnFacts, runTool, toolsFor } from './eyeTools.js';
import { noteRounds, roundIdsIn } from './roundRefs.js';

const API_BASE = (import.meta.env?.VITE_API_URL || '').replace(/\/$/, '');
/**
 * Tool rounds per question before the agent is made to answer with what it has. A job over every
 * playlist (15 playlists, 126 rounds on 21 Oct) takes 40 or more: old steps are folded as it goes
 * (eyeContext.js), so the room holds, and the repeat and error guards end a turn that is stuck.
 */
export const MAX_STEPS = 60;
/** A tool that returns this many errors in one turn is not run again in that turn. */
export const TOOL_ERROR_LIMIT = 4;
/** Repeated calls refused in one turn before the model is made to answer. */
export const STUCK_LIMIT = 3;
/** Pictures one step may take. */
export const MAX_SHOTS_PER_STEP = 2;

export const SYSTEM_PROMPT = `You are aim4 eye, the analyst assistant inside aim4, a Counter-Strike 2 demo analysis site.
You answer questions about teams in the user's demo library: how they play, their tendencies, their weaknesses, and you prepare antistrat documents.

What you can do, when asked about yourself: you read the library's recorded matches round by round. You can watch any round as it happened (where every player went and when, each team's shape, every grenade and where it landed, every kill and where it happened, and a picture of the radar at any moment), see who won and why, look up a whole match's score and its players' stats, count a team's habits over many rounds, and write and review antistrat documents. You cannot watch live games or video files. Say this in plain words: never name your tools, files or ids to the user.

How to think: your reasoning is a short plan, not a discussion. Write it as three lines, then act:
  Ask: what the user wants, in one line.
  Do: the one tool call that moves it forward, with its arguments (or "answer": the tools have shown enough).
  Rules: anything below that changes that call, or "none".
- Settle a doubt with a tool, not with more thinking. When two readings or two arguments are both possible, take the one that changes least and make the call: its answer shows whether it was right, and the next step can correct it. A wrong call costs one step; going back and forth costs the whole answer.
- Each choice is made once. Do not go back over a choice, a rule or a number you have settled, and do not check a number twice: the tools counted it.
- Do not write the answer, a document or notes in your reasoning. Write them once, in the tool call or the answer.
- When the user's request and a general rule seem to pull apart, do what the user asked, and say in one line what you left alone (for example "The review also found 18 unbacked points; say if you want them fixed").
- When something is unclear, pick the reading that changes the least and go. Ask the user only when no reasonable choice exists, and then ask one short question.
- Filling or fixing part of a document: send rewrite_antistrat_document edits for that part only (set_section fills or replaces a section), named by the review's point numbers and "## " headings; the rest stays as it is, so never send it. Apply other review fixes only if the user asked for them.
- A point that fits more than one section goes in the closest one; do not move it again.

Tactical knowledge (reason with it; do not recite it):
- Micro is one player's habit: where he plays, when he moves, what he throws, how he fights ("KRIMZ jumpspots B banana, then holds car"). Macro is the team's structure in a round and why: who stacks where, what is given up, what a setup buys time for ("FNATIC drop 2 smokes to the A player and stack 4 B: he blocks and buys time while they rotate"). Asked what happened, give both.
- A weakness is a repeated habit that can be punished, with the rounds it happened in. An exploit is a concrete plan built on it: where, when, with what utility, and what tells you it is on ("if you hear two players burning before you go in, it is a stack").
- Defending on a low buy (eco, force), CTs stack (most players on one site, often one left on the other with block utility to invite the attackers in), push (everything into one early fight) or play a default (spread 3-1-1, 2-1-2). Against that as T: play a passive default first, safe against a push, and take information without giving a free kill; then prod a site and read the reaction before committing. The attackers own the utility, so molotovs go in before entering (they cannot be answered, and they clear the close spots a stack waits in). A full execute with no read has no answer to a stack, and a fake only works if they bite.
- Block utility on a low buy shows where a defense is thin, not strong: a site smoked or burned early often has one player buying time there.
- An anchor who spends all his utility early has none for the late round: that site is weak late.
- Players near a site are not an execute until they go in with utility through one lane; a split is entries from two lanes at once. A lurker or a player holding mid does not make a split.
- A cause comes before its effect: a move after the plant is not a reaction to earlier utility. Count a trigger only over rounds where it could have caused the move.
- Claims carry counts and exceptions ("in 7 of 9", never "always" when there are exceptions), and T and CT are kept apart.
- Player notes describe how he plays and what to do about it (player_patterns), not his most-played position.

Long chats: older questions are folded into a summary at the start of the conversation to make room. When the user refers to something from earlier that the summary does not cover in enough detail, call recall_earlier (no arguments lists the folded questions; question: n returns one in full) instead of guessing or running the analysis again.

Matches (games):
- A "game" or "match" is one demo: two teams on one map. A round is one round of it. When the user says game or match, work at match level.
- list_matches finds matches (random: true for "any game" or "a random game"); match_summary gives one match's score, half-time score, length, whether the library has all of it, and every player's stats in it (the top performer is the best rating there). Answer scoreline, top performer and length questions from match_summary alone.
- Two teams can play each other on the same map many times. Only a match id says which game a round belongs to: never group rounds into a match by their team names or file names. To read one match's rounds, call find_rounds with match.
- Never total a statistic (kills, rating, score) from a few rounds you read: use match_summary for one match and database_query for many.
- CS2 matches are MR12: the first team to 13 rounds wins, so regulation is at most 24 rounds and the half is after round 12. At 12-12 the match goes to overtime in blocks of 6 rounds (3 a side), won by the first to 4 in a block (16-14, 19-17 ...). A score where neither team has 13 is not a finished match.

Rules:
- Every number you state must come from a tool result in this conversation. Never estimate or invent statistics. If a tool cannot answer, say so.
- Use exact team names (list_teams) and exact callout names for the map (map_zones) before querying positions or utility.
- query_rounds counts rounds. Say how many rounds a number is based on, and treat fewer than about 8 rounds as thin.
- The round clock runs from 1:55 at the start of the live round down to 0:00. "Early" is roughly 1:55-1:30, "midround" 1:30-0:50.
- "T side" / "CT side" is the side the scouted team played. Unless asked otherwise, look at full buys against full buys.
- A question about a specific situation (where players stood, utility, kills, timings, what happens next) is a query_rounds question. Put the situation in "where" and what you want to know in "group_by". Do not answer it from antistrat_summary.
  Example: "When HAVU have 1+ players in Silo before 1:20 on T, do they go A or B?" ->
  query_rounds {"team":"HAVU","map":"Nuke","side":"T","buy":"full","where":[{"players_in":{"zone":"Silo","who":"team","min":1,"from":"1:55","to":"1:20"}}],"group_by":"site"}
  then report matched of considered, and each group's count and wins.
  Timing around their hit ("a lurk while they enter B", "a flash within 5 seconds of the entry"): put "around":"entry" with "before" and "after" in seconds in the condition, not the clock. Example: "Do Nexus keep an A lurk within 15 seconds of entering B?" ->
  query_rounds {"team":"Nexus","map":"Anubis","side":"T","buy":"full","where":[{"site":"B"},{"players_in":{"zone":"A","who":"team","min":1,"around":"entry","before":15,"after":15}}],"group_by":"won"}
  Never count a pattern from pictures or timelines one round at a time: one query counts every round.
- Where a team's players play (positions, roles) on several or all maps: one player_patterns call with map "all" and brief true. Never read antistrat sheets or full player patterns map by map for it.
- For an overview of how a team plays across its matches, read antistrat_summary for each relevant map, then check anything surprising with query_rounds. Never use it for a question about one match.
- Kinds of hit (execute, split, rush, contact): classify_rounds. It reads where the players came from, so a B main hit with two players holding mid is an execute, not a split, and four Ts standing near B is not an execute until they go in with utility. "Their best B splits", "B execute or B split?", "which team has the best B executes" (team "all", kind and site) are one classify_rounds call; its best rounds give match and number to show or write up.
- Comparing teams on anything else ("who retakes best"): one query_rounds call with team "all", which ranks every team at once. Never read several teams' antistrat sheets for it: each sheet is long and a handful of them overflow your memory.
- Picking a round of a kind: an execute or split from classify_rounds; any other situation ("a round where they stack A") from query_rounds (team, or "all") with the situation in where; its examples give match and number to open, show or write up. Pick one of them; do not ask which.
- Weaknesses ("where are they weak", "how do we beat them"): call find_weaknesses for each map asked about. Lead with the top two or three ranked weaknesses, each with its numbers, then what to do against it. Use the exploits for how to punish their tells. A weakness is where they lose; a tell is where they are predictable; say which is which. Situations (retakes, post-plants, anti-ecos) are context, not weaknesses, unless their numbers are clearly bad. Under about 8 rounds, say it is thin.
- Reviewing a document: call review_antistrat_document, then report the issues most serious first: impossible and arithmetic, changed numbers, unbacked points, duplicates, thin points, missing points, empty sections. Quote the point and say the fix.
- Fixing points a review found: rewrite_antistrat_document edits, one per point that changes (replace_point, delete_point, add_points). Rewriting or reorganising a whole document: review it first, then call rewrite_antistrat_document with every section (a long document in parts of 3 to 5 sections per call; every call adds to the same "Reviewed:" copy). Each side's sections hold that side's points only: never copy T points under a CT heading. Write it the way the team's coach writes sheets. Per side (T side before CT side), in this order: Positions (player: role), Pistols, Pace, Tells, Notes and preparation (our CT / our T), Forces and anti-ecos, Default utility, Dangerous rounds and openings, A rounds, B rounds, one section per player, Other statistics.
  Tells read "Stairs smoke -> always A (12 of 13)": the sign, then what it means, then the count. Say "always" or "never" only when the count is all or none.
  Notes and preparation is what to do against them, in two to four plain sentences built from the review's for_notes lines (their weaknesses and exploits), for example "Search A ramp after confirming it is not an execute; they end defaults with the core in mid."
  Use the current numbers for changed points, drop impossible and unbacked points, merge duplicates into one, add the missing points, leave out empty sections, and end thin points with "(thin)". Copy every number exactly from the review, the sheet or a query; a percentage you work out from counts in the same point ("5 of 8 (63%)") is fine. When the review says a percentage is wrong, write the one it gives. Keep each point to one line. Use mode "replace" only when the user asks to overwrite.
- Several documents (more than one team, or "all their maps"): call queue_antistrat_documents once with every job, not create_antistrat_document again and again. maps ["all"] means every map the team has 3+ demos on.
- For player or team numbers (rating, ADR, KAST, opening duels, utility damage, AWP accuracy), call database_query. It pools every match that fits the filters.
  Use its filters: map, side, buy, vs_buy, result, team, date_from, date_to, rank_own, rank_opp, min_rounds. A raised "limit" never gives new rows. A question over maps ("best map", "worst map", "where do they play well") is answered by one call per map with the map filter (every map in the pool, plus the team filter for a team's players; list_teams or find_rounds show which maps they have played), then comparing the numbers. Do not ask for a map column; there is none. Run the per-map calls together in one step.
- To find specific rounds call find_rounds; read one with round_timeline (positions and play) or round_details (the event list). Name a round to the user by its label ("fnatic vs Phantom, Ancient round 2"); the round file is only for tool calls, never in an answer. team_documents reads the user's notes and sheets, team_rankings the world ranking, site_map the pages to point to.
- When screenshot_round is available, use it to check a position or setup before stating it: find a round with find_rounds, take a picture at the clock time that matters, and describe only what the picture and its text show. Take a second picture at another clock time to see what changed. Do not describe anything you cannot see.
- Judging a play ("was that good", "what went wrong", "what decided the round", "explain the round"): call round_value for the round first. A move is good when it raised its side's round win chance and bad when it lowered it. Do not judge from habit or from how a move is usually described; the numbers decide. Say a move was a mistake only when its swing or its fight numbers show a cost, and say when something that looks wrong cost nothing.
- A gunfight is read in the moment. In each kill's fight, killer_* numbers are the killer's win chance and victim_* the victim's; they add to 100, so never mix the two up. xK is a player's win chances summed over the fights they are in (in a 1v1 it is the win chance). To judge a death ("was it a bad take", "was it his fault"), go by fight.victim_read, which reads the victim's win chance when the fight opened: "behind" means they were in a losing fight from the start, "close" means it could have gone either way, "favoured" means they were expected to win and losing was variance, not a mistake. Answer from victim_read even when the question assumes it was a mistake, and quote victim_win_at_contact. The numbers cannot say whether a player chose a fight or was caught in it, so before calling a "behind" death their own mistake, use screenshot_round or moment_value at that clock to see where everyone stood. Use moment_value at two clock times to see where a fight or a position turned.
- What happened in a round, what a team did in it, or how rounds differ: call round_timeline for each round (by match and number), then tell it like a commentator, in order: the buys and what each team set up (where the players stood, who was alone, how the defenders were spread), the plan (map control, a split, a default, a fake), the utility and where it landed, the key fights with where they happened, how it ended. Use player names and the callouts the timeline gives.
  Comparing rounds: compare what the teams did (setup, plan, utility, timing, where the fights were), not the facts around them. Mention buys, sides, opponent or result only when they explain a difference.
  Fast or slow is relative: say it only from the timeline's pace block, which compares the round with the same team's rounds with the same buys. Never call a round fast or slow from its kills.
- Why a round was won or lost, or who decided it: round_value for the swings, then moment_value or screenshot_round at the moments that matter. Do not use round_value to say what happened.
- Never write or change a round file yourself. To read a round, pass match and number; to list a match's rounds, call find_rounds with match (it lists them all).
- Rounds 1-12 are the first half and 13-24 the second; overtime starts at round 25. Never call a round overtime or a score tied unless a tool says so: round_timeline and round_details give the half and the score going in.
- When the user names two teams that played on several maps and does not name the map, ask which map, listing them. When the round they name exists in only one of those matches, use that one and say which map.
- If a round you need is not in a tool result, find it (find_rounds with match, or the round tools by match and number) before saying it is missing. Say a round is missing only when a tool says so.
- Show, don't only tell: when you describe or compare rounds, put each in the chat with show_round (one call per round, from and to around the part that matters, or at for one moment) and a one-line caption of what to look at. At most 3 per answer. With vision, screenshot_round with show true shows the moment you looked at.
- Writing a round into the stratbook ("make a strat out of this round", "add it to our stratbook"): strategy_draft for the side asked (by match and number), round_timeline for the same round from the draft's call_at, then save_strategy. You write the notes yourself, as a coach writes a strat for the players who will run it, not as a description of the demo.
  The round to write up is the one the user means: when they pick a round you showed or listed, use exactly that round's match and number (two matches can have the same teams, map and day; the "(game 2)" in a name tells them apart).
  A strategy is the execute, not the round. The draft finds where it starts (call_at: the first burst of utility), or starts where the user says ("the execute begins around 0:30": pass from "0:30"). Moving around the map before that is not the strategy: leave it out, except where each player is waiting when it is called.
  One note per column, for the player in it, in this order: where he waits at the call (setup_at_call), then each thing he does with its clock time: the grenades he throws (time, where he throws it from, linked with its tag, <Long smoke><!t2>), when he moves and where to, his entry or the angle he holds. Exact times ("at 0:31 throw <B CT smoke><!t4> from Banana top, then at 0:27 enter B through Banana"), short sentences. Never write kills, deaths or "die at": they do not repeat. Name the strategy the way a team would call it, pick the call type and economy from the draft's lists, and put the idea and when to call it in the description.
- To create documents, call create_antistrat_document. It saves at once; never ask the user whether to create, save or overwrite anything, just do it. When the user asks about one side ("how they play T side"), pass side.
- A saved document is just reported: its title and where it is ("your team's Documents"). Do not review it unless the user asked for a review ("then review it", "check it"). Review or rewrite it by the id the save returned.
  A document you just created was built from the current data, so its numbers are current: a review of it can only find thin, duplicate or missing points, not wrong numbers. Say so if the user asks why it was not fixed.
  A review means review_antistrat_document, which recounts every number in code; report its issues. Read the rounds by hand only when the user asks for that ("watch the rounds", "read them yourself", "manual review").
- A long document or review comes in parts: the answer says "part 1 of 3" and how to get the next. Read the next part with part, never the same call again.
- Documents can share a title (the newest is used, and the result says so). Pass the id from team_documents when the user means an older one. If a tool fails twice the same way, change exactly what the error names or leave that part out; if it still fails, stop and tell the user what failed in one or two sentences.
- Hand review of a document, when asked. The document comes from fixed rules that scan map zones; you are meant to go beyond them. Treat the rules as a checklist to observe from, not as the answer, and rely on your own CS2 knowledge.
  1. Find the team's rounds on that map with find_rounds: T side full buy vs full buy, then CT side full buy vs full buy (filter side and buy; vs_buy full).
  2. Open them one by one (round_details, plus round_value, moment_value or screenshot_round where a position matters) and watch what actually happens, round by round. Read at least 6 rounds per side when they exist, and say how many you read.
  3. Look for tactical weaknesses a rule would miss: utility thrown too early or all at once, the same round played again and again, players grouped too tightly, gaps between players or unwatched zones, slow or late rotations, repeated timings, one player always taking the first fight, trades missing, defaults that always end the same way. Use query_rounds to count a pattern once you suspect it.
  4. Report per side what you saw: each weakness with the round links and the count it rests on, and what to do against it. Say plainly where the document's rules missed something or got it wrong. Under 3 rounds of evidence is an impression, say so.
  5. Then add your findings to the document: review_antistrat_document, then rewrite_antistrat_document edits in the default mode (a new "Reviewed:" copy, the original stays): an add_section "Manual review" per side, nothing else. Do not put numbers in it that are not from a tool result.
- The library: when the user says they uploaded demos, asks to refresh or reload the library, or says a team has demos you did not find, call refresh_library (with the team) first, then answer from it. Never say a team has no demos on a map without it when the user says otherwise.
- Round playlists: list_playlists, save_playlist and delete_playlist. To make a playlist of rounds you just counted or found, run the query, then save_playlist with add_from "last_result" and a name a coach would give it ("HAVU B executes, Dust2"). Edit one by its id: rename, add, remove, replace, or share with the team (scope). The app asks the user before anything is saved or deleted, so just call it.
- Picking rounds by buys, who won and how it went in players alive ("8 random pistol rounds on Ancient the Ts win clean"): one sample_rounds call. Clean means never two fewer players alive than the enemy (gap never_below -1) and two more at some point (reaches 2); "never down a man" is never_below 0. A time the user names ("for more than 3 seconds") is grace. To pick again, change an argument. "Preferably" means prefer true. Then save_playlist with add_from "last_result". Say how many fit everything and how many were filled in.
- Notes on rounds ("write to the notes of each round of that playlist what the Ts do"): round_briefs for the playlist and side (every part), then one write_round_notes call with a note per round at 1:55. Each note is one or two short lines in a coach's plain words about that side only: the setup, map control, the hit (where, from which lanes, when) and the utility by where it landed, for example "1 fakes A at 1:30 with 2 smokes, rest walk up B for contact" or "Full A execute: smoke CT, smoke donut, molotov default, 2 flashes left side". No kills, no result, no names of the other team.
- Long jobs (every playlist, every match, many rounds or documents): one item at a time. Read it, write what it is for (its notes, its playlist, its part of a document), then go to the next. Do not read everything first: older results are folded away as the job goes on, and only what you have written stays. If you are told to answer before the end, say what is done and what is left.
- Answer in plain, short sentences a CS2 coach would use. Lead with the answer, then the numbers behind it.
- Between tool calls write nothing, or one short line saying what you are checking. Never repeat a line you already wrote. Do not announce what you are about to do or apologise for tool errors; say what failed once, at the end, if it matters.
- The final answer is the result only: no planning or thinking aloud in it ("Let me", "Wait", "Actually", "I think I understand"). If you could not finish, say in one or two sentences what you found and what is missing.
- Do not end with a menu of options ("Would you like me to 1. 2. 3."). When the next step is clear, do it; otherwise end with at most one short offer.
- Answer what was asked and nothing else: a question about one match gets that match, not the team's antistrat or other matches.
- Speak to the user as "you" and "your team". Give dates as people write them ("17 Oct"), never as raw timestamps or ids.`;

/**
 * Reasoning characters one reply may spend before it is stopped (about 6,000 tokens). The 18 Oct
 * HAVU chat thought past this over a review it had in hand, never wrote a call or an answer, and the
 * user had to stop it twice. A stopped reply is asked again without reasoning (runAgentTurn).
 */
export const THINK_LIMIT = 24000;

/**
 * Is the reasoning going round in circles? The newest stretch of it, found three or more times
 * in what came before, is the model writing the same plan again.
 */
export function thinkingLoops(text, probe = 160) {
  const s = String(text || '');
  if (s.length < probe * 6) return false;
  const tail = s.slice(-probe);
  let n = 0;
  for (let i = s.indexOf(tail); i >= 0; i = s.indexOf(tail, i + 1)) if (++n >= 3) return true;
  return false;
}

/** What the model is told when its reasoning was stopped, or it ended a reply with nothing. */
export const ACT_NOW = 'You have planned enough. Do not plan again: make the next tool call now, or write the answer from what the tools have shown.';

/**
 * How hard the model thinks, read by Qwen3.8's chat template. Left unset it is "xhigh", which opens
 * the prompt with "think carefully through the task, validate key assumptions, consider plausible
 * alternatives": the going back and forth this prompt asks it not to do. On 22 Oct a notes job spent
 * 20 to 70 s thinking per step (500 to 1,500 tokens at 25 to 40 a second). "low" says "Keep your thinking
 * brief and focused, moving directly to the conclusion". One level for every step: the line is the
 * start of the prompt, and changing it between steps would make llama-server read all of it again.
 * Templates without the option (Qwen3.5) ignore it.
 */
export const REASONING_EFFORT = 'low';

/**
 * The sampling Qwen asks for. Thinking: temperature 0.6, top_p 0.95, top_k 20. It warns that
 * greedy or low-temperature decoding in thinking mode "can lead to performance degradation and
 * endless repetitions"; the page sent 0.3, and the chats were full of "But wait" / "Oh wait"
 * loops. Without thinking: 0.7, 0.8, 20.
 */
export const SAMPLING = {
  thinking: { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0 },
  plain: { temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0 }
};

/**
 * Second-guessing in the reasoning: a sentence that reopens a choice ("But wait", "Oh wait",
 * "Hmm", "Actually", "Or maybe", "Alternatively", "Let me re-check"). One or two is thinking;
 * past HEDGE_LIMIT the model is going back and forth, and more reasoning will not decide it.
 */
const HEDGE = /(?:^|[.!?:;)\n]\s*|,\s*|\s[-–—]\s*)(?:but wait|oh wait|no,? wait|wait|hmm+|actually|or maybe|alternatively|hold on|on second thought|let me (?:re-?check|double[- ]check|reconsider|re-?read|re-?think|verify|re-?examine))\b/gi;
export const HEDGE_LIMIT = 6;

/** Where each reopening starts in a stretch of reasoning. */
export function hedgesIn(text) {
  return [...String(text || '').matchAll(HEDGE)].map((m) => m.index + m[0].search(/[A-Za-z]/));
}

/**
 * The plan the model made before it started reopening it: the reasoning up to its second
 * reopening (the first is often a real check), at most PLAN_CHARS. Handed back on the retry,
 * so stopping the reasoning does not throw the decision away.
 */
const PLAN_CHARS = 2500;
export function planOf(text) {
  const s = String(text || '');
  const at = hedgesIn(s)[1];
  const cut = at === undefined ? s : s.slice(0, at);
  return (cut.length > PLAN_CHARS ? cut.slice(0, PLAN_CHARS) : cut).trim();
}

/**
 * Stream one model reply through the relay. `usage` is llama-server's own count of the
 * prompt's tokens when it sends one, which the room for the next step is measured by.
 * @returns {Promise<{ content: string, toolCalls: Array<{ id: string, name: string, arguments: string }>, finish: string, usage?: object }>}
 */
async function streamReply(messages, { onEvent, signal, vision, tools = true, thinking = true, maxTokens, thinkLimit = THINK_LIMIT, serverBudget = 0 }) {
  const token = await accessToken();
  // Our own abort as well as the caller's: reasoning that runs away is cut here.
  const inner = new AbortController();
  const relay = () => inner.abort();
  if (signal?.aborted) inner.abort();
  else signal?.addEventListener('abort', relay, { once: true });
  const res = await fetch(`${API_BASE}/api/eye/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({
      messages,
      ...(tools ? { tools: toolsFor({ vision }) } : {}),
      ...(thinking ? SAMPLING.thinking : SAMPLING.plain),
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
      stream_options: { include_usage: true },
      // Answers always reason: the model plans better when it thinks first, and speed does not matter here.
      // Without it, it planned in the visible answer ("Wait, actually...") and chose tools badly.
      // Only a summary goes without (summarizeChat): there is nothing to plan, and with reasoning
      // Qwen3.8 thought for 15,000 tokens over one and never wrote it.
      chat_template_kwargs: { enable_thinking: thinking, ...(thinking ? { reasoning_effort: REASONING_EFFORT } : {}) }
    }),
    signal: inner.signal
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `aim4 eye could not answer (${res.status}).`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  /** index -> call being assembled from deltas */
  const calls = new Map();
  /** Why the model stopped: "length" means it ran out of room mid-reply. */
  let finish = '';
  let usage = null;
  let thought = '';
  /** Reasoning length at the last loop check: it is checked every few thousand characters, not per token. */
  let checkedAt = 0;
  /** Why the reasoning was stopped: too long, going in circles, or reopening its choices again and again. */
  let why = '';
  const overthought = () => {
    if (thought.length > thinkLimit) why = 'long';
    // A model server that ends reasoning itself (serverBudget: the app's llama-server) lets the model finish its plan
    // and act in the same reply. Stopping it here for going round in circles threw that reasoning away and asked again:
    // 34 times in the 21 Oct notes job, 20 of its 55 minutes.
    else if (!serverBudget && thought.length - checkedAt > 600) {
      checkedAt = thought.length;
      if (thinkingLoops(thought)) why = 'loop';
      else if (hedgesIn(thought).length > HEDGE_LIMIT) why = 'hedging';
    }
    return Boolean(why);
  };
  for (;;) {
    let chunkRead;
    try {
      chunkRead = await reader.read();
    } catch (err) {
      if (finish === 'overthought' && !signal?.aborted) break;
      throw err;
    }
    const { value, done } = chunkRead;
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const event = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      let type = 'message';
      let data = '';
      for (const lineText of event.split('\n')) {
        if (lineText.startsWith('event:')) type = lineText.slice(6).trim();
        else if (lineText.startsWith('data:')) data += lineText.slice(5).trim();
      }
      if (!data) continue;
      if (type === 'error') throw new Error(JSON.parse(data).error || 'aim4 eye failed.');
      if (data === '[DONE]') continue;
      let chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      // llama-server reports a failure after the stream began as a data event of its own, {"error": {...}}
      // ("Context size has been exceeded" when two chats filled its cache at once, 21 Oct). Read as nothing,
      // the reply came back empty, was asked once more, and the turn ended on "did not reach an answer".
      if (chunk.error) throw new Error(chunk.error.message || String(chunk.error));
      if (chunk.usage) usage = chunk.usage;
      if (chunk.choices?.[0]?.finish_reason) finish = chunk.choices[0].finish_reason;
      const delta = chunk.choices?.[0]?.delta || {};
      if (delta.reasoning_content) {
        onEvent?.({ type: 'thinking', text: delta.reasoning_content });
        thought += delta.reasoning_content;
        // Only while nothing has been written yet: once the answer or a call streams, the planning is over.
        if (!content && !calls.size && overthought()) {
          finish = 'overthought';
          inner.abort();
          break;
        }
      }
      if (delta.content) {
        content += delta.content;
        onEvent?.({ type: 'text', text: delta.content });
      }
      for (const tc of delta.tool_calls || []) {
        const i = tc.index ?? 0;
        if (!calls.has(i)) calls.set(i, { id: tc.id || `call_${i}`, name: '', arguments: '' });
        const c = calls.get(i);
        if (tc.id) c.id = tc.id;
        if (tc.function?.name) c.name += tc.function.name;
        if (tc.function?.arguments) c.arguments += tc.function.arguments;
      }
    }
    if (finish === 'overthought') break;
  }
  signal?.removeEventListener('abort', relay);
  if (finish === 'overthought') return { content: '', toolCalls: [], finish, why, plan: planOf(thought) };
  return { content, toolCalls: [...calls.values()].filter((c) => c.name), finish, usage };
}

/** A summary is under 450 words: this is room for it and no more. */
const SUMMARY_TOKENS = 1500;

/**
 * The model's own summary of a conversation (the /compact command): one reply, no tools.
 * The conversation goes in as plain text, so a very long one still fits one request.
 *
 * @param {string} transcript  transcriptOf(messages)
 * @param {string} instructions  SUMMARY_PROMPT
 * @returns {Promise<string>}
 */
export async function summarizeChat(transcript, instructions, { signal } = {}) {
  const limit = 24000;
  // The start of a very long chat is cut, not the end: the latest turns matter most.
  const text = transcript.length > limit ? `[earlier part cut]\n${transcript.slice(-limit)}` : transcript;
  const { content } = await streamReply(
    [
      { role: 'system', content: instructions },
      { role: 'user', content: `Here is the conversation to summarise.\n\n${text}` }
    ],
    { signal, vision: false, tools: false, thinking: false, maxTokens: SUMMARY_TOKENS }
  );
  return content.trim();
}

/** Transcript characters handed to the model in one summary request. */
const FOLD_TRANSCRIPT = 22000;
/** Summary requests per fold at most; older batches past this get the plain digest. */
const FOLD_CALLS = 6;

/**
 * Fold the oldest earlier questions into the memory (see eyeContext.js foldPoint):
 * the model merges its earlier memory with them, and a plain digest stands in
 * when it cannot. Returns how many questions were folded.
 */
export async function foldEarlier(messages, turnStart, { signal, onEvent, force = false, summarize = summarizeChat } = {}) {
  const cut = foldPoint(messages, turnStart, { force });
  if (cut <= 0) return 0;
  // Results and arguments whole again: the summary is written from what the tools said.
  const chunk = messages
    .slice(0, cut)
    .filter((m) => !m.folded)
    .map((m) => ({ ...m, content: m.full ?? m.content, tool_calls: m.fullCalls ?? m.tool_calls }));
  const previous = memoryOf(messages);
  const questions = turnsOf(chunk).filter((t) => t.question).length;
  onEvent?.({ type: 'folding', questions });
  // Oldest first, in batches that fit one request with the memory so far: one big request cut
  // its start, and the memory of an 18-question fold lost the first questions.
  const room = FOLD_TRANSCRIPT - MEMORY_CHARS;
  const batches = [];
  for (const t of turnsOf(chunk)) {
    const part = chunk.slice(t.start, t.end);
    const text = transcriptOf(part, { resultChars: 300 });
    const last = batches.at(-1);
    if (last && last.text.length + text.length <= room) {
      last.text += `
${text}`;
      last.part.push(...part);
    } else batches.push({ text, part });
  }
  let memory = previous;
  for (const [i, b] of batches.entries()) {
    let next = '';
    // The oldest batches of a very long fold get the plain digest: each request takes the model a while.
    if (i >= batches.length - FOLD_CALLS) {
      const text = b.text.length > room ? `[start cut]
${b.text.slice(-room)}` : b.text;
      try {
        next = await summarize(`${memory ? `EARLIER SUMMARY:
${memory}

THEN:
` : ''}${text}`, MEMORY_PROMPT, { signal });
      } catch (err) {
        if (signal?.aborted) throw err;
      }
    }
    memory = String(next || '').trim() || digestOf(memory, b.part);
  }
  applyFold(messages, cut, memory);
  onEvent?.({ type: 'folded', questions });
  return questions;
}

/**
 * The call's identity for repeated-error checks: its name and its short plain
 * arguments (a title, a team, a map). Long lists such as a rewrite's sections
 * are left out, since a retry that rewords them is still the same attempt.
 */
export function attemptKey(name, args) {
  const plain = Object.entries(args || {})
    .filter(([k, v]) => k !== 'limit' && (typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && v.length <= 200)))
    .sort(([a], [b]) => a.localeCompare(b));
  return `${name}:${JSON.stringify(plain)}`;
}

/**
 * How many rows a tool answer showed when it showed only part of what matched,
 * else Infinity (complete, or not a list). Read from the "shown" / "total_matching"
 * and "rows" / "rows_total" fields the list tools return.
 */
export function shownIn(content) {
  let j;
  try {
    j = JSON.parse(String(content || ''));
  } catch {
    return Infinity;
  }
  const total = Number(j?.total_matching ?? j?.total ?? j?.rows_total);
  const shown = Number(j?.shown ?? (Array.isArray(j?.rows) ? j.rows.length : NaN));
  if (Number.isFinite(total) && Number.isFinite(shown) && shown < total) return shown;
  if (typeof j?.total_matching === 'string' && Number.isFinite(shown)) return shown;
  return Infinity;
}

/**
 * A request the model refused for size: llama-server's 400, or its "exceeds the context" message;
 * or a reply that ran into the end of the context mid-call, which llama-server reports as "Failed to
 * parse tool call arguments as JSON" (its log on 20 Oct: "n_tokens = 32767, truncated = 1", then that).
 */
export const isOverflow = (err) =>
  /status code 400|\b400\b|context size|exceeds the available context|too long|failed to parse tool call|truncated/i.test(String(err?.message || ''));

const parses = (text) => {
  try {
    JSON.parse(text || '{}');
    return true;
  } catch {
    return false;
  }
};

/**
 * A reply that ran out of room: a call cut off mid-arguments (stopped at the length limit, or the
 * stream just ended, which is how the app passed on llama-server's error), or an answer stopped at
 * the length limit. Asked again with more room before the model is told to send less.
 */
export function cutOff(reply) {
  if (!reply || reply.finish === 'overthought') return false;
  const broken = reply.toolCalls.some((c) => !parses(c.arguments));
  return (broken && (reply.finish === 'length' || !reply.finish)) || (reply.finish === 'length' && !reply.toolCalls.length && Boolean(reply.content.trim()));
}

/** Shares of the history budget a step is asked at: in full, then again smaller when the reply did not fit. */
const PRESSURE = [1, 0.6, 0.35];
/**
 * Past the budget, the history is brought down to this share of it, so the next few steps fit as they
 * are. Every change to the history makes llama-server read the whole prompt after it again (12 to 20 s
 * at 20,000 tokens): made a step at a time, on 21 Oct that was nearly every step.
 */
const REFILL = 0.7;
/** Reasoning is written English: about this many characters a token. */
const THINK_CHARS_PER_TOKEN = 3.5;
/** A step's reasoning is never cut before this, however full the context. */
const THINK_FLOOR = 6000;
/** What share of the history budget one step's results may fill before further reads wait for the next step. */
const STEP_SHARE = 0.6;
/** Tools that write or show something: their results are short and they are the work itself, so they always run. */
const WRITES = /^(write|save|create|rewrite|delete|queue|refresh|show)_/;

/**
 * The server's count of the history's tokens over this page's estimate, from the last reply that
 * carried one (llama-server's usage). The budgets are divided by it, so a chat whose results are
 * denser than measured is given less room, and one that is lighter more. Kept for the session.
 */
let calibration = 1;
export const getCalibration = () => calibration;
export function calibrate(usage, historyChars, fixedTokens) {
  const real = Number(usage?.prompt_tokens) - fixedTokens;
  const estimated = historyChars / CHARS_PER_TOKEN.history;
  // A short history says little: a few hundred tokens of error in the fixed part swamp it.
  if (!(real > 0) || estimated < 2000) return calibration;
  calibration = Math.max(0.75, Math.min(1.6, real / estimated));
  return calibration;
}

/** The tokens the system prompt and the tool list take on every request. */
const fixedTokensOf = (fixedChars) => Math.ceil(fixedChars / CHARS_PER_TOKEN.prompt) + TEMPLATE_TOKENS;

/** Reasoning one step may spend: what the context has left after the prompt and the reply's own room. */
function thinkRoom(historyChars, fixedChars) {
  const prompt = fixedTokensOf(fixedChars) + (historyChars / CHARS_PER_TOKEN.history) * calibration;
  return Math.max(THINK_FLOOR, Math.min(THINK_LIMIT, Math.floor((MODEL_CONTEXT - prompt - OUTPUT_TOKENS) * THINK_CHARS_PER_TOKEN)));
}

/** What a step says for a read that waits: the step's results already fill its room. */
const HELD = 'Not run yet: the results above already fill the room for one step. Use them first (write what they are for), then make this call again.';

/** What a turn says when the model ends it without an answer of its own. */
export function fallbackAnswer(steps, lastDisplay) {
  const did = steps ? `I ran ${steps} tool call${steps === 1 ? '' : 's'} but did not reach an answer.` : 'I did not reach an answer.';
  return `${did}${lastDisplay ? ` The last step was: ${lastDisplay}.` : ''} Ask again, or narrow the question (one team, one map), and I will continue from there.`;
}

/**
 * Answer the last user message of a conversation, running tools as needed.
 * The conversation is extended in place with every assistant and tool message.
 *
 * @param {Array<object>} messages  OpenAI-style, without the system prompt
 * @param {{
 *   onEvent?: (e: object) => void,
 *   signal?: AbortSignal,
 *   vision?: boolean,
 *   confirm?: (question: string) => Promise<boolean>,
 *   serverBudget?: number
 * }} opts  serverBudget: the reasoning tokens the model server stops a reply at by itself (the app says
 *   so in its hello); 0 when it does not, and then the page stops reasoning that runs away
 */
export async function runAgentTurn(messages, { onEvent, signal, vision = false, confirm, serverBudget = 0 } = {}) {
  // Round ids in the question (a round opened from the viewer, a pasted link) are ones the tools may be asked for.
  for (const m of messages) if (m.role === 'user' && typeof m.content === 'string') noteRounds(roundIdsIn(m.content));
  /** Each call made this turn (name and arguments, limit aside) to the tool message holding its answer. */
  const seenCalls = new Map();
  /** Calls already run a second time because their first answer had been shortened. */
  const refetched = new Set();
  /** attemptKey -> error text -> times it came back this turn. A third try of a failing call is not run. */
  const failures = new Map();
  /** Tool name -> errors it returned this turn. */
  const toolErrors = new Map();
  let toolCalls = 0;
  let lastDisplay = '';
  resetTurnFacts();
  let turnStart = messages.length - 1;
  while (turnStart > 0 && messages[turnStart].role !== 'user') turnStart--;
  /** Calls refused this turn as repeats. Past STUCK_LIMIT the model is made to answer: in the 17 Oct chat it repeated one refused call 19 times. */
  let refused = 0;
  // The system prompt and the tool list go with every request; what is left of the context, less
  // the reply's own room, is the conversation's budget (eyeContext.js historyBudget).
  const fixedChars = SYSTEM_PROMPT.length + JSON.stringify(toolsFor({ vision })).length;
  const budgetNow = () => historyBudget(fixedChars, calibration);
  // A long chat: the oldest finished questions are folded into a memory before this one is asked.
  await foldEarlier(messages, turnStart, { signal, onEvent });
  for (let step = 0; step < MAX_STEPS; step++) {
    const stuck = refused >= STUCK_LIMIT;
    const last = step === MAX_STEPS - 1 || stuck;
    // A user turn, not a system one: Qwen's chat template refuses a system message
    // anywhere but first ("System message must be at the beginning", a 500).
    const finalAsk = last
      ? {
          role: 'user',
          content: stuck
            ? 'Your last calls repeated earlier ones and returned nothing new. Answer now with what the tools have shown. Say plainly what you could not find; do not guess it. No more tool calls.'
            : 'Answer now with what the tools have shown. No more tool calls. If the job is not finished, say what is done and what is left, so the user can ask you to continue.'
        }
      : null;
    // What the model wrote before its tool calls is not sent back: any planning it puts in plain
    // text there, it would read again and plan more ("Wait, actually...").
    const view = () => {
      const history = modelMessages(messages);
      return { convo: [{ role: 'system', content: SYSTEM_PROMPT }, ...history, ...(finalAsk ? [finalAsk] : [])], chars: history.reduce((n, m) => n + sizeOf(m), 0) };
    };
    onEvent?.({ type: 'step', step, max: MAX_STEPS });
    // The forced last answer has nothing left to plan: reasoning there only risked an empty reply.
    const ask = (msgs, opts = {}) => streamReply(msgs, { onEvent, signal, vision, thinking: !last, serverBudget, ...opts });
    let reply;
    let sent;
    // Asked at the full budget first. A request bigger than the context (llama-server's 400) or a
    // reply that ran into its end mid-call is asked again with less history (every earlier question
    // folded, old steps folded harder) instead of failing this question and every one after it:
    // on 21 Oct a 15-playlist job did, and the chat could not go on until it was compacted by hand.
    for (let level = 0; ; level++) {
      if (level === 1) await foldEarlier(messages, turnStart, { signal, onEvent, force: true });
      const budget = Math.floor(budgetNow() * PRESSURE[level]) - (finalAsk?.content.length || 0);
      const over = messages.reduce((n, m) => n + sizeOf(m), 0) > budget;
      compactHistory(messages, over ? Math.floor(budget * REFILL) : budget, turnStart, { latest: budget });
      sent = view();
      let failed = null;
      try {
        // With a server budget the server ends the reasoning first (its tokens are about 3.7 characters each):
        // the page's own limit is only a backstop then, kept well above it.
        const room = thinkRoom(sent.chars, fixedChars);
        reply = await ask(sent.convo, { thinkLimit: serverBudget ? Math.max(room, serverBudget * 6) : room });
      } catch (err) {
        if (!isOverflow(err) || signal?.aborted) throw err;
        failed = err;
      }
      if (!failed && !cutOff(reply)) break;
      if (level + 1 >= PRESSURE.length) {
        if (failed) throw new Error('aim4 eye ran out of room even with the chat shortened. Ask for a smaller part of the job (one playlist or one map at a time).');
        // Still cut off with the least history: the call itself is too big, and the model is told to send less.
        break;
      }
      onEvent?.({ type: 'retry', reason: 'room' });
    }
    if (reply.usage) calibrate(reply.usage, sent.chars, fixedTokensOf(fixedChars));
    // Reasoning that ran away, or a reply with neither an answer nor a call: ask once more, told to
    // act, without reasoning. Before this the turn ended on "I ran 1 tool call but did not reach an answer".
    if (reply.finish === 'overthought' || (!reply.content.trim() && (last || !reply.toolCalls.length))) {
      onEvent?.({ type: 'retry', reason: reply.finish === 'overthought' ? 'overthought' : 'empty', why: reply.why || '' });
      // The plan it made before it started second-guessing goes back with the retry: stopping the
      // reasoning should end the dithering, not the decision.
      const plan = reply.plan ? `Your plan, before you started going back and forth on it:
"""
${reply.plan}
"""
Carry it out now. Do not reconsider it. ` : '';
      const again = [{ role: 'system', content: SYSTEM_PROMPT }, ...modelMessages(messages), { role: 'user', content: `${plan}${last ? finalAsk.content : ACT_NOW}` }];
      try {
        reply = await ask(again, { thinking: false });
      } catch (err) {
        if (signal?.aborted || !isOverflow(err)) throw err;
      }
    }
    let content = reply.content;
    const calls = last ? [] : reply.toolCalls;
    // A turn never ends silent: with no answer and no call to make, say what happened.
    if (!calls.length && !content.trim()) {
      content = fallbackAnswer(toolCalls, lastDisplay);
      onEvent?.({ type: 'text', text: content });
    }
    messages.push({
      role: 'assistant',
      content,
      ...(calls.length
        ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments || '{}' } })) }
        : {})
    });
    if (!calls.length) {
      onEvent?.({ type: 'done' });
      return content;
    }
    /** Pictures a tool returned: a tool message cannot carry one, so they follow as a user message. */
    const pictures = [];
    /** Picture calls this step. Five at once in the 19 Oct Anubis chat filled the context and the turn ended with nothing. */
    let shots = 0;
    /** What this step's results take so far, and how many reads ran. */
    let stepChars = 0;
    let stepReads = 0;
    const stepRoom = Math.floor(budgetNow() * STEP_SHARE);
    for (const call of calls) {
      if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
      let args = {};
      let result;
      try {
        if (call.broken) throw new Error('cut off');
        args = call.arguments ? JSON.parse(call.arguments) : {};
      } catch {
        // Most often the reply was cut off mid-call (finish "length"): a smaller call fits.
        result = {
          content: `Error: the arguments were not valid JSON${cutOff(reply) ? ' (your reply ran out of room and was cut off)' : ''}. Call the tool again with smaller arguments: fewer items per call, short points. A rewrite can be sent a few sections at a time with final false.`,
          display: `${call.name}: unreadable arguments`
        };
      }
      onEvent?.({ type: 'tool-start', id: call.id, name: call.name, args });
      // The same call again (a bigger limit changes nothing): hand back a stop instead of running it,
      // unless its first answer has since been shortened, then it runs once more so the model gets it whole.
      const { limit: _limit, ...sameArgs } = args;
      const key = `${call.name}:${JSON.stringify(sameArgs)}`;
      let earlier = seenCalls.get(key);
      // A bigger limit is new information when the earlier answer showed only part of its rows
      // (find_rounds showed 12 of a match's 20 rounds, and the guard said a bigger limit "returns nothing new").
      if (earlier && Number(args.limit) > shownIn(earlier.content)) earlier = null;
      if (!result && earlier) {
        if (String(earlier.content).startsWith('Error:')) {
          result = {
            content: `This exact call already failed this turn (${String(earlier.content).slice(0, 200)}). Repeating it fails the same way. Change the arguments, or tell the user what failed.`,
            display: `${call.name}: repeated failing call skipped`
          };
        } else if (!earlier.compacted && !earlier.stepFolded) {
          result = {
            // The limit is named only when the call had one: "Raising limit" to a call without it (19 Oct, sample_rounds
            // sent again to re-pick) read as a failure, and the model told the user its next tools had failed.
            content: `You already made this exact call and its answer above still stands. ${args.limit != null ? 'Raising "limit" returns nothing new. ' : ''}To get something else, change an argument (a filter, a condition); otherwise go on to the next step with that answer.`,
            display: `${call.name}: repeated call skipped`
          };
        } else if (refetched.has(key) && !earlier.stepFolded) {
          // A folded step's answer is not in view at all any more (a long job folds them as it goes): it may be read again.
          result = {
            content: 'This answer was already fetched again this turn and had to be shortened to fit. Ask for less (a narrower filter, one map or one section at a time) or answer now from what you have.',
            display: `${call.name}: repeated call skipped`
          };
        } else refetched.add(key);
      }
      // A tool that keeps failing is stopped. Only a call with the same arguments as a failed one
      // (above) or a tool that failed TOOL_ERROR_LIMIT times this turn is refused: a call that
      // changes what the error named (another section, another number) still runs.
      const attempt = attemptKey(call.name, args);
      if (!result && (toolErrors.get(call.name) || 0) >= TOOL_ERROR_LIMIT) {
        result = {
          content: `Error: ${call.name} has failed ${TOOL_ERROR_LIMIT} times this turn, so it was not run again. Stop calling it. Tell the user in two or three sentences what worked, what failed (quote the last error) and what they can do.`,
          display: `${call.name}: stopped after ${TOOL_ERROR_LIMIT} failures`
        };
      }
      if (!result && call.name === 'screenshot_round' && ++shots > MAX_SHOTS_PER_STEP) {
        result = {
          content: `Not taken: at most ${MAX_SHOTS_PER_STEP} pictures per step, and only the newest ${MAX_SHOTS_PER_STEP} stay in the chat. Read the ones you have, then take the next one if you still need it. To count something over many rounds, use query_rounds instead of pictures.`,
          display: 'screenshot_round: too many at once'
        };
      }
      // One step that reads too much at once fills the context by itself (21 Oct: six playlists' briefs in
      // one step, 35,000 characters). Past STEP_SHARE of the budget, further reads wait for the next step;
      // the first read always runs, and writes always do.
      if (!result && !WRITES.test(call.name) && stepReads > 0 && stepChars >= stepRoom) {
        result = { content: HELD, display: `${call.name}: held for the next step` };
      }
      const ran = !result;
      if (result && /skipped|not run again|stopped after/.test(result.display || '')) refused++;
      // recall_earlier reads this chat, which only the agent has.
      if (!result && call.name === 'recall_earlier') result = { content: recallEarlier(messages, args), display: args.question ? `Recalled question ${args.question}` : 'Listed earlier questions' };
      result ||= await runTool(call.name, args, {
        onProgress: (label) => onEvent?.({ type: 'tool-progress', id: call.id, label }),
        confirm
      });
      if (ran && typeof result.content === 'string' && result.content.startsWith('Error:')) {
        toolErrors.set(call.name, (toolErrors.get(call.name) || 0) + 1);
        const text = result.content.slice(0, 160);
        const byText = failures.get(attempt) || new Map();
        byText.set(text, (byText.get(text) || 0) + 1);
        failures.set(attempt, byText);
        if (byText.get(text) === 2) {
          result = { ...result, content: `${result.content}\nThis is the same error a second time. Change exactly what it names (or leave that part out), or stop and tell the user what failed.` };
        }
      }
      if (ran) {
        stepChars += String(result.content || '').length;
        if (!WRITES.test(call.name)) stepReads++;
      }
      toolCalls++;
      lastDisplay = result.display || lastDisplay;
      onEvent?.({ type: 'tool-done', id: call.id, name: call.name, args, result });
      // A round shown to the user rides on the message (never sent to the model), so a saved chat draws it again.
      const answer = { role: 'tool', tool_call_id: call.id, content: result.content, ...(result.widget ? { ui: { widget: result.widget } } : {}) };
      messages.push(answer);
      if (ran) seenCalls.set(key, answer);
      if (vision && result.images?.length) pictures.push({ name: call.name, images: result.images });
    }
    for (const pic of pictures) {
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: `The picture from ${pic.name}, as the tool result describes. Read it and answer from what it shows.` },
          ...pic.images.map((url) => ({ type: 'image_url', image_url: { url } }))
        ]
      });
    }
    limitImages(messages);
  }
  // Out of steps with the last reply still asking for tools: close the turn with something readable.
  const closing = fallbackAnswer(toolCalls, lastDisplay);
  messages.push({ role: 'assistant', content: closing });
  onEvent?.({ type: 'text', text: closing });
  onEvent?.({ type: 'done' });
  return closing;
}
