// ---------------------------------------------------------------------------
// replays/analytics/reportMessages.js
// Every sentence the summary and internal reports can write.
//
// Same contract as the autocoach's table (coach/coachMessages.js): one key per
// kind of finding, a few phrasings of it, and the pick is a hash of what the
// finding is about rather than a random draw, so the same rounds produce the
// same document twice. Keeping the words here means the wording can be argued
// about without reading the code that decides when a line is true.
//
// House rules, from the reports these mirror:
//   - Short. A bullet is a fact, not an essay.
//   - Name players by name. No pronouns for them: "he" is a guess, and the
//     sentence never needs one.
//   - Numbers go in brackets after the claim: "Always B (6 of 6)".
//   - No long dashes.
// ---------------------------------------------------------------------------

import { phrase } from './reportProse.js';

export const REPORT_MESSAGES = Object.freeze({
  // ---- Summary: pace notes -------------------------------------------------

  'pace-never': ['They never {verb} {site}'],
  'pace-never-again': ['Still never early {site}'],
  'pace-once': ['Only 1 round early {site}'],
  'pace-rare': ['Rarely early {site} ({n} of {total})'],
  'pace-defaults': ['{share}% default + slow default'],
  'pace-exec-site': ['{freq} {site}'],

  // ---- Summary: tells ------------------------------------------------------

  'tells-none-first-buy': ['No tells for first buy'],
  'tells-none': ['No utility gives the round away'],

  // ---- Summary: openings ---------------------------------------------------

  'open-all-late': ['but all in laterounds'],
  'open-all-set': ['but all in set calls'],
  'open-all-late-set': ['but all in lateround/set calls'],
  'open-rest': ['rest {what}'],
  'open-rest-spread': ['rest spread out'],
  'open-nothing-early': ['nothing {zone} early'],
  'open-only-aggressive': ['only x{n} aggressive towards {zone}'],
  'open-no-aggressive': ['none of them early'],
  'open-very-active': ['Very active {site}'],

  // ---- Summary: anti-force rounds -----------------------------------------

  'af-blocked': [
    'Blocked with a smoke at {zone}, they did not get in and lost',
    'A smoke at {zone} stopped them and they lost the round'
  ],
  'af-counter-exec': [
    'Counter with a smoke to block {zone} and play close to {site}',
    'Block {zone} with a smoke early and play close on {site}'
  ],
  'af-counter-fast': [
    'If anything shows {lane} fast, expect {n} {lane}',
    'Anything fast through {lane} is {n} players'
  ],
  'af-tendency': [
    'Tendency to play {pace} rounds and end {site} if given nothing',
    'Given nothing, they play {pace} rounds and end {site}'
  ],
  'af-alternatives': ['Alternatives are {list}', 'Otherwise {list}'],
  'af-hold-pair': [
    'If we play {zone} on force, one needs to be antiflash and one hold',
    'Hold {zone} as a pair on force buys, one antiflashing and one holding'
  ],
  'af-save-smoke': ['Save a smoke to block {list}', 'Keep a smoke for {list}'],
  'af-keep-info': ['keep info {zone}', 'keep information on {zone}'],
  'af-not-aggressive': ["don't play {lane} too aggressively", 'stay passive {lane}'],
  'af-stacks': [
    'Stacks + blocks will work better than aggressive rounds',
    'Stacks and blocks beat aggressive rounds against these'
  ],
  'af-aggression': [
    'Taking the first fight works: they lose {share}% of these when they lose the opening',
    'Early aggression pays off here: {share}% lost once they lose the opening'
  ],

  'af-ct-hold': [
    'Even after losing the opening duel they win {share}% of these, so an eco needs more than one pick',
    'They still win {share}% of these after losing the opening, one pick is not enough on an eco'
  ],
  'af-ct-weak': [
    'They lose {share}% of these once the opening goes against them, a fast eco hit is worth it',
    'Win the opening and they lose {share}% of these, so take the first fight on an eco'
  ],

  // ---- Summary: site habits --------------------------------------------------

  'site-never-pace': ['Never {paces} on full buy vs full buy'],
  'site-never-solo': ['Never send 1 person to aggressively play / try to open {site}'],
  'site-never-solo-short': ['Never aggressive with 1 player'],
  'site-solo-aggressive': [
    'Very aggressive with 1 player+ towards {site}{tail}',
    'Often 1 player early towards {site}{tail}'
  ],
  'site-solo-defaults': [' and focusing here on default', ', mostly in defaults'],
  'site-if-util': ['If {utility}, be very careful for {call}'],
  'site-call-util': ['On {call}: {utility}'],
  'site-call-util-after-if': ['On this, {utility}'],
  'site-rare-call': ['One round of {call}: {steps}'],
  'site-rare-calls': ['{n} rounds of {call}: {steps}'],
  'site-winrate': ['{what}: {winrate}% won ({rounds} rounds){planted}'],
  'site-planted': [', {winrate}% once planted ({rounds})'],
  'site-retake': ['{site} retakes: {winrate}% won ({rounds} rounds){from}'],
  'site-anchor': ['{name} anchors {site} in {share}% of rounds', '{name} holds {site} in {share}% of rounds'],
  'site-stack': ['Stacks {site} ({n}+ players at {clock}) in {share}% of rounds'],

  // ---- Summary: players ------------------------------------------------------

  'player-plays': ['Plays {where}'],
  'player-aggr-low': ['but never too aggressive'],
  'player-aggr-mid': ['decently aggressive'],
  'player-aggr-high': ['very aggressive'],
  'player-awp-dynamic': ['Decently dynamic with AWP'],
  'player-awp-static': ['Static with the AWP'],
  'player-awp-split': ['{split}'],
  'player-first-timing': [
    'First possible timing is {action} at {clock}{with}',
    'Earliest habit is {action} at {clock}{with}'
  ],
  'player-with-mates': [' with {n} teammates'],
  'player-with-mate': [' with 1 teammate'],
  'player-team-lane': ['At {clock} only {count} with 3+ players {lane}'],
  'player-active-around': [
    'Tends to be most active {where} around {clock}',
    'Most of the fights {where} come around {clock}'
  ],
  'player-otherwise-passive': ['otherwise passive and rotating around the map'],
  'player-early-peeks': [
    'A few early peeks {zone} but rarely ever taking map control',
    'Peeks {zone} early a few times but rarely takes map control'
  ],
  'player-holds': ['Most rounds still holding {zone} to about {clock}'],
  'player-late-hold': ['Only {n} rounds where holding {zone} later than {clock}'],
  'player-utility': ['Often throws {list}', 'A lot of rounds with {list}'],
  'player-stays': [
    'Does tend to stay {zone} even if the team is playing {other}',
    'Stays {zone} even when the team plays {other}'
  ],
  'player-joins': [
    'If the plan is {lane}, joins very often ({share}% of those rounds)',
    'Joins the {lane} plays in {share}% of those rounds'
  ],

  'rec-leave-lane': [
    'Recommended to leave {lane} early and focus on {other} pressure',
    'Recommended to give up {lane} early and put pressure on {other}'
  ],
  'rec-no-early-punish': ['No recommendations for early punishes'],
  'rec-dont-search': [
    'Recommended to NOT search {zone} in midround',
    'Do not search {zone} in the midround'
  ],
  'rec-retake-after': [
    'Good risk to retake {zone} after {clock} with flash first to bait out the AWP shot',
    'After {clock}, retake {zone} with a flash first to bait the AWP shot'
  ],
  'rec-expect-contact': [
    'Expect contact from {name} on {zone} around {clock}, play it with two or with utility',
    'Expect {name} on {zone} around {clock}, hold it with two or use utility there'
  ],
  'rec-he-spot': [
    'Often waits on {zone}, good possibility for HEs there',
    'Waits on {zone} a lot, a good spot for HEs'
  ],
  'rec-push-when-gone': [
    'When the team plays {lane}, {zone} is often left empty, push it',
    'With the team on {lane}, {zone} is often empty, take it'
  ],

  // ---- Internal: notes on rounds ----------------------------------------------

  'int-intro': [
    "As seen by the table above, let's focus on the weakest performing rounds and most punishing enemy moves:"
  ],
  'int-weakest': ['Weakest round type:'],
  'int-punishing': ['Most punishing enemy moves:'],
  'int-no-weak': ['Every round type we run on this side is at 50% or better.'],
  'int-no-punishing': ['No enemy move beats us more often than not on this side.'],
  'int-rest-fine': [
    'Everything else is close to >50% winrate, and will therefore not be the focus of this document.'
  ],
  'int-start-own': ["Let's start with our {call} rounds:"],
  'int-start-faced': [
    "Let's take a look at the rounds that the enemy does something aggressive and catches us off guard, starting with the {n} {call} rounds:"
  ],
  'int-couple-examples': ["I'll take only a couple examples from the {call} rounds next:"],
  'int-random-intro': [
    "Let's take a look at some lost rounds at random to see if there's a continuous underlying thread in the reasoning for why rounds are lost:"
  ],
  'int-random-last': ['in the last round I checked'],

  // One clause per autocoach rule, said about the player it flagged.
  'flag-advantage-lost': ['{p} dies untraded while up a man', '{p} gives the man advantage back untraded'],
  'flag-negative-ev': ['{p} takes a solo fight the round did not need', '{p} looks for a fight alone in a won round'],
  'flag-untraded-won-round': ['{p} dies untraded in a round that was already won', '{p} gives away a won round untraded'],
  'flag-pushed-advantage': ['{p} pushes alone into their ground while up a man'],
  'flag-afterplant-duel': ['{p} takes an early afterplant duel instead of playing the bomb'],
  'flag-underdog-won-round': ['{p} takes a losing duel in a round that was won'],
  'flag-unaware-openness': ['{p} is caught looking away by {enemy}', '{p} is unaware and dies to {enemy}'],
  'flag-running-shot': ['{p} shoots while moving and loses the duel'],
  'flag-awp-miss': ['{p} misses the AWP shot'],
  'flag-lost-ahead': ['{p} loses a duel that was in their favour'],
  'flag-flick-error': ['{p} loses the duel on aim'],
  'flag-missed-everything': ['{p} misses every shot in the duel'],
  'flag-spray-past-control': ['{p} sprays past control'],
  'flag-not-ready': ['{p} is not ready for the fight'],
  'flag-solo-even': ['{p} dies alone in an even fight with no trade', '{p} is caught alone with nobody to trade'],
  'flag-multikill-refrag': ['{enemy} gets a multikill with nobody refragging'],
  'flag-utility-unawareness': ['{p} dies to an enemy standing in their own molotov'],
  'flag-missed-flash': ["{p}'s flash blinds the team instead of the enemy"],
  'flag-ate-team-flash': ['{p} is blinded by a team flash'],
  'flag-team-util-damage': ["{p} takes damage from the team's own utility"],
  'flag-died-holding-util': ['{p} dies with utility still in hand'],
  'flag-knife-out': ['{p} is caught without a gun out'],
  'flag-flash-no-followup': ["{p}'s flash is not followed up"],
  'flag-spacing': ['{p} and a teammate die to the same player one at a time', 'spacing with {p} is too wide to trade'],
  'flag-nade-stack': ['the group around {p} is stacked into one HE'],
  'flag-no-trade-attempt': ['{p} does not go for the trade'],
  'flag-trade-failure': ['{p} goes for the trade and loses it'],
  'flag-late-off-flash': ['{p} is late off the flash'],
  'flag-early-off-flash': ['{p} crosses before the flash pops'],
  'flag-smoke-peek': ['{p} peeks before the smoke lands'],
  'flag-lurk-first': ['{p} dies lurking before the team takes a fight'],
  'flag-free-opening': ['{p} gives a free opening kill'],
  'flag-unchecked-position': ['{p} dies to an angle nobody checked'],
  'flag-understack': ['the site is understacked for the execute'],
  'flag-late-rotation': ['{p} rotates too late'],
  'flag-a-understack': ['A is understacked for the execute'],
  'flag-b-understack': ['B is understacked for the execute'],

  // What a death on the opening was, when the coach flagged it.
  'why-advantage-lost': ['with a man advantage already in hand'],
  'why-negative-ev': ['taking a fight the round did not need'],
  'why-unaware-openness': ['unaware of the angle', 'caught looking away'],
  'why-not-ready': ['not ready for the fight'],
  'why-solo-even': ['alone with nobody to trade'],
  'why-free-opening': ['with nothing happening anywhere else'],
  'why-lurk-first': ['lurking before the team took a fight'],
  'why-smoke-peek': ['before the smoke landed'],
  'why-spacing': ['too far from a teammate to fight together'],
  'why-utility-unawareness': ['to an enemy in their own molotov'],
  'why-unchecked-position': ['from an angle nobody checked'],
  'why-running-shot': ['shooting on the move'],
  'why-knife-out': ['without a gun out'],
  'why-late-off-flash': ['late off the flash'],
  'why-early-off-flash': ['ahead of the flash'],
  'why-lost-ahead': ['in a duel that was in their favour'],

  // How rounds ended.
  'end-afterplant-lost': ['{n}v{m} {site} afterplant lost', 'Lost the {n}v{m} afterplant on {site}'],
  'end-retake-lost': ['Lost the {n}v{m} retake on {site}', '{n}v{m} {site} retake lost'],
  'end-time': ['Ran out of time with {n} alive'],
  'end-never-recovered': ['Never recovered from the 4v5', 'The 4v5 was never turned around'],
  'end-wiped': ['Wiped before the plant', 'Eliminated before the bomb went down'],
  'end-advantage': ['Threw away the {n}v{m}', 'Lost it from a {n}v{m}'],
  'end-eliminated': ['Lost the {n}v{m} that followed'],
  'end-save': ['At {wp}% to win with {n} alive, saving was the better call'],
  'end-converted': ['Converted the 5v4', 'Turned the opening into the round'],
  'end-comeback': ['Came back from the 4v5', 'Won it from a man down'],
  'end-clutch': ['{p} wins the 1v{n}', '{p} closes the 1v{n}'],
  'end-multikill': ['{p} gets {n} kills', '{p} takes {n} in the round'],
  'end-trades': ['good trades all round', 'every early death traded'],
  'end-won': ['Round won', 'Won the round'],

  // A block of rounds, summed up.
  'concl-synchronization': [
    'Most rounds in this category are prone to a slight poorly timed decision, resulting in a player being caught off, extending into fights without a backup plan.'
  ],
  'concl-quality': [
    'Most rounds in this category come down to spacing: untradable 50/50 duels and fights taken without a backup plan.'
  ],
  'concl-carelessness': [
    'Most rounds in this category are lost to a slight overextension: fights the round did not need, taken while the advantage was already ours.'
  ],
  'concl-mechanical': [
    'Most rounds in this category are lost in the duel itself: players caught unaware or losing fights they were set up to win.'
  ],
  'concl-none': [
    'Few of these rounds carry a clear mistake. They look more like the enemy executing well than like us giving the round away.'
  ],
  'concl-won': [
    'Overall, the won rounds show the exact opposite: well coordinated patience results in punishing THEIR mistakes, not the other way around.'
  ],
  'concl-faced': ['We win {wins} of {rounds} against {call} ({winrate}%).'],
  'concl-faced-eco': ['The only won round against {call} came against an eco.'],

  // The narrated thread through the random rounds.
  'thread-synchronization': ['bad timing'],
  'thread-quality': ['poor spacing discipline'],
  'thread-carelessness': ['bad judgement'],
  'thread-mechanical': ['unawareness'],
  'thread-aim': ['lost aim duels'],
  'thread-utility': ['utility mistakes'],
  'thread-none': ['unlucky'],

  // Player notes.
  'pl-best': [
    "In a more general note, I'd like to highlight the fact that {name} is playing exceptionally well on the {side} side of {map}, but sadly, no one is joining in that level of performance."
  ],
  'pl-best-clean': [
    'Of all the rounds checked, it is not often that {name} is the one with poor discipline, awareness, sub-par spacing or other risk factors: {flags} in {rounds} rounds, the fewest on the team.'
  ],
  'pl-officials': [
    'Compared with the official games, as the ratings for official games on {side} side show:'
  ],
  'pl-worst': [
    'However, {name} has been struggling. The average rating {name} has across all rounds on {side} side regardless of buy is {rating}, with a KD of {kd}. Even more importantly, the KAST% is at {kast}%, meaning there are only {kast}% of rounds that {name} objectively contributes in a positive way to. A couple of rounds, focusing on what may be causing a lack of impact:'
  ],
  'pl-worst-concl': [
    "There's a low impact floor and an average impact ceiling visible in the gameplay of {name} across the {side} side of {map}. The most impactful rounds are {best}. The least impactful rounds are rounds where {name} has potential to have impact, but due to {why}, ends up losing the duel; with this sometimes costing the team the round in a snowball effect."
  ],
  'pl-impact-trades': ['1-for-1 duels in situations where it is hard to find more'],
  'pl-impact-opens': ['the rounds where {name} takes the opening duel and wins it'],
  'pl-worst-kill-refragged': ['{p} kills one and is refragged instantly', '{p} gets one and is traded straight away'],
  'pl-worst-one-then-dies': ['{p} gets one and then dies to {enemy}{zone}', '{p} takes one before dying to {enemy}{zone}'],
  'pl-worst-no-kill': ['{p} dies to {enemy}{zone} without a kill', '{p} is killed by {enemy}{zone} before getting a kill'],

  // Player internal.
  'pi-summary': [
    '{name} is rated {rating} over {rounds} rounds on {side} ({kd} KD, {kast}% KAST, {adr} ADR), against a team average of {team}.'
  ],
  'pi-above-team': ['{name} sits {gap} above the team on the {side} side of {map}.'],
  'pi-below-team': ['{name} sits {gap} under the team on the {side} side of {map}.'],
  'pi-weak-calls': ['The calls to work on are {list}.', 'Most of the gap is in {list}.'],
  'pi-strong-calls': ['The best rounds come on {list}.', 'At their best on {list}.'],
  'pi-focus': ['The flagged mistakes point at {focus}.', 'What keeps coming back is {focus}.'],
  'cat-carelessness': ['Carelessness'],
  'cat-mechanical': ['Mechanical error'],
  'cat-quality': ['Quality'],
  'cat-synchronization': ['Synchronization'],
  'rule-advantage-lost': ['untraded deaths while up a man'],
  'rule-negative-ev': ['solo fights the round did not need'],
  'rule-untraded-won-round': ['untraded deaths in won rounds'],
  'rule-pushed-advantage': ['solo pushes while ahead'],
  'rule-afterplant-duel': ['early afterplant duels'],
  'rule-underdog-won-round': ['losing duels taken in won rounds'],
  'rule-unaware-openness': ['caught looking away'],
  'rule-running-shot': ['shooting on the move'],
  'rule-awp-miss': ['missed AWP shots'],
  'rule-lost-ahead': ['favoured duels lost'],
  'rule-flick-error': ['duels lost on aim'],
  'rule-missed-everything': ['duels with no shot landed'],
  'rule-spray-past-control': ['spraying past control'],
  'rule-not-ready': ['not ready for the fight'],
  'rule-solo-even': ['alone in even fights'],
  'rule-multikill-refrag': ['multikills against with no refrag'],
  'rule-utility-unawareness': ['killed by enemies in their own molotov'],
  'rule-missed-flash': ['flashes that blind the team'],
  'rule-ate-team-flash': ['blinded by team flashes'],
  'rule-team-util-damage': ["damage from the team's utility"],
  'rule-died-holding-util': ['dying with utility in hand'],
  'rule-knife-out': ['caught without a gun out'],
  'rule-flash-no-followup': ['flashes nobody followed'],
  'rule-spacing': ['spacing too wide to trade'],
  'rule-nade-stack': ['stacked into one HE'],
  'rule-no-trade-attempt': ['no trade attempt'],
  'rule-trade-failure': ['trades attempted and lost'],
  'rule-late-off-flash': ['late off the flash'],
  'rule-early-off-flash': ['ahead of the flash'],
  'rule-smoke-peek': ['peeks before the smoke lands'],
  'rule-lurk-first': ['lurk deaths before the team fights'],
  'rule-free-opening': ['free opening deaths'],
  'rule-unchecked-position': ['deaths to unchecked angles'],
  'rule-late-rotation': ['late rotations'],

  // The conclusion.
  'cc-practice-official': [
    "It's worth noticing that the overall performance of players in practices reflects the official performance {team} has."
  ],
  'cc-strong-weak': [
    'Very strong {strong} sides result in a {strongWr}% round winrate as {strong} across {games}. Likewise, the {weak} side lacks in strength, and as a result, {team} maintains only a {weakWr}% round winrate on {weak}.'
  ],
  'cc-both': ['{team} wins {tWr}% of T rounds and {ctWr}% of CT rounds on {map} across {games}.'],
  'cc-official-rates': [
    'In official games the numbers are {tWr}% on T and {ctWr}% on CT, very close to what practice shows.',
    'Officials read {tWr}% on T and {ctWr}% on CT against practice.'
  ],
  'int-fixable-some': [
    'Still, {share}% of the rounds lost on {side} carry at least one flagged mistake, and those are fixable. Bad spacing, discipline, awareness or a lacking call is not the same as doing everything perfectly and still being annihilated by lucky multikills.'
  ],
  'int-fixable': [
    'However, most of the rounds lost on {side} have a fixable issue: {share}% of them carry at least one flagged mistake. Bad spacing, discipline, awareness or a lacking call is not the same as doing everything perfectly and still being annihilated by lucky multikills.'
  ],
  'int-benchmark': [
    'When the best team in the world wins everything for a year, it still only wins about 56.8% of its rounds across all maps, and the average top 50 team wins around 50% of all its rounds played. Let\'s take a look at what these statistics mean:'
  ],
  'int-math-game': ['The average game lasts 21 rounds (13-8).'],
  'int-math-line': ['{wr}% round win rate: 21 × {frac} = {rounds} rounds{diff}'],
  'int-math-one': [
    "That's just ONE round more per game, in total across all games played. This means that putting all the energy into avoiding losing ONE round more per {side} side played will bring {team}'s {side} side {map} winrate to {one}%, and winning TWO more rounds per {side} side played will place it at {two}%, on the level of era-defining teams."
  ],
  'int-closing': [
    'Most of the mistakes spotted are fixable. Place a lot of effort into {focus}. That will likely be sufficient in accomplishing this goal.'
  ],
  'focus-synchronization': ['the timing of every move and making the right reads'],
  'focus-quality': ['perfect spacing and closing every trade'],
  'focus-carelessness': ['closing out advantages instead of taking fights the round does not need'],
  'focus-mechanical': ['being ready for every angle and covering ALL the gaps in the map'],
  'focus-default': ['the quality of the movements across the map']
});

/** A line from the table above. */
export function say(key, seed, vars) {
  return phrase(REPORT_MESSAGES, key, seed, vars);
}
