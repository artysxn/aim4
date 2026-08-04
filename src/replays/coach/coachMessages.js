// ---------------------------------------------------------------------------
// replays/coach/coachMessages.js
// Every line the coach can say, and which category the note belongs to.
//
// One table rather than strings scattered through the rules, for three reasons
// the rules themselves cannot solve:
//
//   1. Each note has four variants. A match that fires the same rule eight
//      times should not read the same way eight times, but the same round must
//      read the same way every time it is opened, so the pick is a hash of the
//      flag tick rather than a random draw.
//   2. Categories are a property of the mistake, not of the code path that
//      found it. Two rules in different modules can share one category and the
//      panel groups on it.
//   3. Copy review is a text problem. Keeping it in one file means the wording
//      can be argued about without reading the detection logic.
//
// House rules for the copy, from the plan:
//   - No long dash. Plain English, short sentences.
//   - State the consequence, not just the event.
//   - Never write the win-chance sentence into a variant. Rules that measure a
//     drop append "Round win chance fell from X to Y." themselves.
// ---------------------------------------------------------------------------

/** The four kinds of mistake, plus a lane for the one note that is praise. */
export const COACH_CATEGORY = Object.freeze({
  CARELESSNESS: 'carelessness',
  MECHANICAL: 'mechanical',
  QUALITY: 'quality',
  SYNCHRONIZATION: 'synchronization',
  PRAISE: 'praise'
});

export const COACH_CATEGORY_LABELS = Object.freeze({
  [COACH_CATEGORY.CARELESSNESS]: 'Carelessness',
  [COACH_CATEGORY.MECHANICAL]: 'Mechanical error',
  [COACH_CATEGORY.QUALITY]: 'Quality',
  [COACH_CATEGORY.SYNCHRONIZATION]: 'Synchronization',
  [COACH_CATEGORY.PRAISE]: 'Well played'
});

const C = COACH_CATEGORY;

/**
 * Message key -> { rule, category, variants }.
 *
 * The key is not always the rule id: `negative-ev` fires both when the solo
 * duel was lost and when it was won, and those need different copy while
 * staying one rule for filtering and for notes already on disk.
 */
export const COACH_MESSAGES = Object.freeze({
  // ---- Carelessness -------------------------------------------------------

  'advantage-lost': {
    rule: 'advantage-lost',
    category: C.CARELESSNESS,
    variants: [
      'You died in a {n}v{m} with nobody able to trade you. Being up a man only wins the round if you stay up a man, and this made it even again.',
      'That death was untraded in a man advantage. The extra player was the whole edge and it is gone.',
      'You were up a man and died for free. Your team now has to win a duel they never had to take.',
      'No teammate was close enough to punish that. When you are ahead you should be the last one taking a risk, not the first.'
    ]
  },

  'negative-ev': {
    rule: 'negative-ev',
    category: C.CARELESSNESS,
    variants: [
      'You took a solo fight with the round already {win} won. Winning it added almost nothing and losing it cost most of the round.',
      'The round was {win} in your favour before this duel. A fight nobody can trade is a bad deal even when it works, and this one did not.',
      'There was no reason to go looking for that fight. At {win} the round wins itself if you stay alive and make them come to you.',
      'You put a {win} round on a coinflip nobody could back you up on. That is the whole loss right there.'
    ]
  },

  'negative-ev-won': {
    rule: 'negative-ev',
    category: C.CARELESSNESS,
    variants: [
      'You won that solo duel, but you took it at {win} with no support. The round did not need it.',
      'Good fight, wrong fight. At {win} you risked a won round to gain almost nothing.',
      'That came off, but it was still the wrong choice. Take the same fight ten times at {win} and you lose rounds you had already won.',
      'You did not need that kill. Holding your angle wins the round with none of the risk.'
    ]
  },

  'untraded-won-round': {
    rule: 'untraded-won-round',
    category: C.CARELESSNESS,
    variants: [
      "You died untraded in a round you were already {win} to win. You dropped your gun as well, so this costs the next round's buy on top of it.",
      'That death was free for them. Even when the round still wins, losing a rifle for nothing quietly costs you the round after it.',
      'The round was {win} yours and nobody could trade you. Every one of these takes a percent or two off the match, not just the round.',
      'You had the round won on health and guns. Dying here hands them equipment they did not earn.'
    ]
  },

  'pushed-advantage': {
    rule: 'pushed-advantage',
    category: C.CARELESSNESS,
    variants: [
      'You pushed alone into space they had held for {seconds} seconds while up a man. Nothing to gain there and a whole round to lose.',
      'That was their ground and you walked into it on your own with the advantage. They only had to stand still and wait.',
      'Up a man you do not need to find them. Going into territory they already control hands the extra player straight back.',
      'You gave the advantage away by moving into their space alone. Make them come to you when you are the ones ahead.'
    ]
  },

  'afterplant-duel': {
    rule: 'afterplant-duel',
    category: C.CARELESSNESS,
    variants: [
      'You took a 1v1 in the first {seconds} seconds after the plant at only {win} to win it. Below about two thirds, the bomb wins you more rounds than the fight does.',
      'The bomb was down and the clock was already working for you. A {win} duel this early throws that away.',
      'In an afterplant your job is to make them come to you. Taking a {win} fight this early gives them a free defuse when it goes wrong.',
      'That duel was close to a coinflip and you did not need it. Play off the bomb and make them find you.'
    ]
  },

  // ---- Mechanical error ---------------------------------------------------

  'unaware-openness': {
    rule: 'unaware-openness',
    category: C.MECHANICAL,
    variants: [
      'You died to {enemy} with your crosshair {deg} degrees off them. The fight was over before you could aim at it.',
      'Your crosshair was nowhere near {enemy} when they opened. Pre-aiming the angle you walk into is what makes these fights winnable.',
      'You were looking {deg} degrees away from where the shot came from. That is a free kill for them every time.',
      '{enemy} did not have to out-aim you here. Your crosshair was already off the angle before the duel started.'
    ]
  },

  'running-shot': {
    rule: 'running-shot',
    category: C.MECHANICAL,
    variants: [
      'You fired at {speed} units per second. Standing still made that fight {was}. Moving turned it into {is}.',
      'Those bullets went nowhere near your crosshair because you were still running. You dropped the duel from {was} to {is} on your own.',
      'You had the better fight until you shot while moving. {was} became {is} before they even fired back.',
      'Stop first, then shoot. That one habit was worth {delta} points of win chance in this duel alone.'
    ]
  },

  'awp-miss': {
    rule: 'awp-miss',
    category: C.MECHANICAL,
    variants: [
      'That AWP shot was {win} free when you pulled it and you missed. One shot decided the round and it did not land.',
      'You had {enemy} dead to rights at {win} and the shot missed. Whatever happened after, that was the round.',
      'A {win} AWP shot is a kill you are expected to take. Missing it costs your team the man advantage you had already earned.',
      'That was as close to free as an AWP shot gets. Missing turns a won angle into a fight you now have to reload through.'
    ]
  },

  'lost-ahead': {
    rule: 'lost-ahead',
    category: C.MECHANICAL,
    variants: [
      'You entered that duel {win} in front and lost it. Every advantage was yours going in.',
      'The fight was {win} yours the moment you had sight of them. Losing it hands over a round you should have had.',
      'You saw them first, from the better spot, {win} to win, and died anyway. That is the fight to convert every time.',
      'Everything about that duel was in your favour at {win}. Losing it costs the round and the gun.'
    ]
  },

  'flick-error': {
    rule: 'flick-error',
    category: C.MECHANICAL,
    variants: [
      '{share} of your shots in that fight went past or short of the target. You were aiming through them, not at them.',
      'You overshot and undershot your way through that engagement and died to it. Slow the first shot down and land it.',
      'Most of your shots in that duel missed on one side of the target or the other. That is crosshair speed, not reaction time.',
      'You kept flicking past the target. Every one of those misses gave them a free shot back.'
    ]
  },

  'missed-everything': {
    rule: 'missed-everything',
    category: C.MECHANICAL,
    variants: [
      'You fired {shots} shots in that fight and hit none. That is a duel you were in and lost for free.',
      '{shots} shots, {hits} hits, and you died. The fight was there, the aim was not.',
      'You missed {missed} of {shots} before dying. Your team is a player down because none of those landed.',
      'None of that spray touched them. Take the first shot properly instead of hoping the rest catch up.'
    ]
  },

  'spray-past-control': {
    rule: 'spray-past-control',
    category: C.MECHANICAL,
    variants: [
      'You kept firing for {n} more bullets after your last one did any damage. That is an empty magazine and a dead player.',
      'The spray stopped working {n} bullets before you stopped shooting. Reset and take a second burst.',
      '{n} bullets after your last hit is not a spray, it is a reload you are giving them for free.',
      'You held the trigger long past the point it was landing. Burst it, let the pattern reset, and you win that fight.'
    ]
  },

  'not-ready': {
    rule: 'not-ready',
    category: C.MECHANICAL,
    variants: [
      '{enemy} was on your screen for {seconds} seconds and you never fired. You were in that fight before you were ready for it.',
      'You had line of sight and time to shoot and did neither. Clear angles expecting a fight, not hoping there is not one.',
      'That fight caught you unprepared. Being on the angle is not the same as being ready for the angle.',
      'You never got a shot off. Come to the angle already set up and that duel is a normal one.'
    ]
  },

  // ---- Quality ------------------------------------------------------------

  'solo-even': {
    rule: 'solo-even',
    category: C.QUALITY,
    variants: [
      'You died alone in a {n}v{n} with no trade. Even rounds go to the team that fights together.',
      'Nobody could trade you in an even fight. That one death is what turned it into a losing one.',
      'You were on your own in a {n}v{n}. That costs the round even when your health already looked bad.',
      'In an even fight a teammate has to be close enough to punish whoever kills you. Nobody was.'
    ]
  },

  'multikill-refrag': {
    rule: 'multikill-refrag',
    category: C.QUALITY,
    variants: [
      '{enemy} killed {n} of you alone. Someone had to punish the first kill and nobody did.',
      '{n} players died to one enemy with no help from their side at all. That is a refrag your team never attempted.',
      'One player took {n} of yours by themselves. Whatever the first fight was, the rest were free.',
      '{enemy} won a {n}v1. That does not happen when the second player is ready to trade the first.'
    ]
  },

  'utility-unawareness': {
    rule: 'utility-unawareness',
    category: C.QUALITY,
    variants: [
      'You died to {enemy} standing in your own fire. Once you throw it, watch it.',
      'Your molotov was burning and {enemy} played it against you. That is your own utility used against your position.',
      'You lost that fight to someone in your own fire. The fire told you exactly where they had to be.',
      'You threw the fire and stopped tracking it. {enemy} did not.'
    ]
  },

  'missed-flash': {
    rule: 'missed-flash',
    category: C.QUALITY,
    variants: [
      'That flash blinded {teammate} for {seconds} seconds and did less to the enemy. You took a player out of the fight and it was one of yours.',
      'Your flash hurt your own team more than theirs. Anyone on your side who could not see was a free kill.',
      '{teammate} ate that flashbang. You spent a grenade to make your own team easier to kill.',
      'That was a bad lineup. The flash has to land behind their angle, not in front of yours.'
    ]
  },

  'ate-team-flash': {
    rule: 'ate-team-flash',
    category: C.QUALITY,
    variants: [
      "You were blind for {seconds} seconds from your own team's flash. You cannot hold or take an angle while you cannot see.",
      'A teammate flashed you for {seconds} seconds. Turn away from your own utility so you are not the one paying for it.',
      'You lost {seconds} seconds of the round to a friendly flash. That is free time for the enemy to move.',
      "Your own team's flash took you out of the fight. Watch for the throw and turn."
    ]
  },

  'team-util-damage': {
    rule: 'team-util-damage',
    category: C.QUALITY,
    variants: [
      "You lost {hp} health to your own team's utility. Every point of that makes the next fight harder to win.",
      '{hp} damage from a friendly grenade. Now you have to win the next duel from behind for no reason.',
      "Your own team's utility took {hp} off you. That is a duel you would have won at full health.",
      'You walked into your own team\u2019s grenades for {hp}. Let the utility come down before you move.'
    ]
  },

  'died-holding-util': {
    rule: 'died-holding-util',
    category: C.QUALITY,
    variants: [
      'You died with {n} grenades still unthrown. All of that value goes back to nobody.',
      '{n} pieces of utility died with you. They were bought to be used, not carried.',
      'You had {n} grenades in hand and never used one. Throw them into the fight, or throw them for the next round\u2019s buy.',
      'Utility does nothing in your inventory. You died holding {n} pieces that could have won that fight.'
    ]
  },

  'knife-out': {
    rule: 'knife-out',
    category: C.QUALITY,
    variants: [
      'You died without a gun out. There was no version of that fight you could win.',
      'You were caught holding {item} instead of your weapon. Free kill for them, lost round for you.',
      'Running with the knife saves a second and costs the duel. You had nothing to shoot back with.',
      'You died with no gun in hand. Switch back before you cross anywhere someone can see you.'
    ]
  },

  'flash-no-followup': {
    rule: 'flash-no-followup',
    category: C.QUALITY,
    variants: [
      'That flash blinded {enemy} in the {zone} and nothing happened. Nobody moved in, no fight was taken, and the grenade was spent for nothing.',
      'You bought {seconds} seconds of blindness late in the round and nobody used them. That is a grenade and a timing gone.',
      'The flash landed and the round stood still. Late round utility has to be followed by someone taking space.',
      'Nothing came of that flash. If nobody is moving, hold the grenade until someone is.'
    ]
  },

  spacing: {
    rule: 'spacing',
    category: C.QUALITY,
    variants: [
      'You and {teammate} both died to {enemy} in separate fights. Each of you was close to a coinflip alone. Together it was {win} in your favour.',
      '{enemy} got to fight you one at a time. Peeking together turns two coinflips into a {win} kill.',
      'You were close enough to die to the same player and too far apart to fight them together. That is the worst place to be.',
      'Two isolated duels against one enemy. The same two players peeking at once wins that {win} of the time.'
    ]
  },

  'nade-stack': {
    rule: 'nade-stack',
    category: C.QUALITY,
    variants: [
      'One HE took {hp} health across {n} of you. Standing that close means a single grenade can decide the round.',
      '{n} players damaged by one grenade for {hp} total. Spread out before their utility comes down.',
      'That grenade got {hp} damage because you were all in the same place. Now every one of you fights from behind.',
      'One enemy HE hurt {n} of you. That is one throw putting the whole group at a disadvantage.'
    ]
  },

  'no-trade-attempt': {
    rule: 'no-trade-attempt',
    category: C.QUALITY,
    variants: [
      '{teammate} died right next to you and you never moved. Stepping up was a {win} fight for you and you did not take it.',
      'You were close enough to trade {teammate} and did not try. Their death bought the enemy a free player.',
      'The trade was there at {win} in your favour. Not going for it turns one loss into two.',
      'You had one second to punish that kill and stayed where you were. That is the difference between an even round and a losing one.'
    ]
  },

  'trade-failure': {
    rule: 'trade-failure',
    category: C.QUALITY,
    variants: [
      'You went for the trade on {teammate} and lost it. The attempt was right, the fight was not won.',
      'Right instinct, wrong outcome. You had {win} on that refrag and it did not land.',
      'You tried to trade and died doing it. Check the angle before you step out so the second death is not free too.',
      'The refrag was there and you missed it. Now they are up two for one fight.'
    ]
  },

  'late-off-flash': {
    rule: 'late-off-flash',
    category: C.QUALITY,
    variants: [
      '{enemy} was blind {seconds} seconds ago and could see again by the time you fired. You paid for the flash and arrived after it.',
      'You took that fight just after the flash ended. All the value of the grenade went to nobody.',
      'The flash did its job and you were {seconds} seconds late to use it. Move on the pop, not after it.',
      'By the time you shot, {enemy} could see you fine. The grenade was wasted and the fight was even.'
    ]
  },

  'early-off-flash': {
    rule: 'early-off-flash',
    category: C.QUALITY,
    variants: [
      'You crossed before your own flash went off. {enemy} was never blind when you got there.',
      'The flash detonated behind you. You took the fight at full disadvantage with a grenade already spent.',
      'You were early. Wait for the pop, then move, or the flash does nothing at all.',
      'That flash blinded nobody because you were already in the fight. Timing the move is what makes the grenade work.'
    ]
  },

  'smoke-peek': {
    rule: 'smoke-peek',
    category: C.QUALITY,
    variants: [
      '{enemy} killed you across a line that a smoke closed {seconds} seconds later. Waiting would have removed the fight completely.',
      'You crossed with a smoke already in the air. Two more seconds and they could not have seen you at all.',
      'That angle was about to be smoked off. You took the one fight the utility was there to prevent.',
      'Your team was closing that line for you. Peeking before it landed gave away a player for nothing.'
    ]
  },

  // ---- Synchronization ----------------------------------------------------

  'lurk-first': {
    rule: 'lurk-first',
    category: C.SYNCHRONIZATION,
    variants: [
      'You died on your own before the rest of the team had taken a fight. There was no information yet for the lurk to work off.',
      'The core had not moved and you were already dead. A lurk works after the team pulls attention, not before.',
      'You went alone before anything happened on the map. Your team now plays the round a man down with nothing gained.',
      'Nothing had happened anywhere when you died. Let the group take a fight first, then open the map behind it.'
    ]
  },

  'free-opening': {
    rule: 'free-opening',
    category: C.SYNCHRONIZATION,
    variants: [
      'You opened the round by dying with nothing happening anywhere else. Nothing was traded and nothing was gained.',
      'First death of the round with the map completely quiet. Your team starts behind for free.',
      'Nobody else was in a fight when you died. That death bought your team no space and no information.',
      'That was a free opening kill for them. Take that fight when your team is set up to use it.'
    ]
  },

  'unchecked-position': {
    rule: 'unchecked-position',
    category: C.SYNCHRONIZATION,
    variants: [
      'You died to {enemy} from an angle none of the {n} of you were watching. With that many players someone has to hold it.',
      '{n} players stacked and nobody covering the angle they came from. That is a team mistake, not a duel you lost.',
      'Nobody was looking where {enemy} came from. Split the angles when you group up, or the group dies one at a time.',
      'All {n} of you were watching the same direction. That is the one thing a stack cannot afford.'
    ]
  },

  understack: {
    rule: 'understack',
    category: C.SYNCHRONIZATION,
    variants: [
      'The T side is setting up on {site} and you have {n} there. Could you have taken info or rotated earlier?',
      '{n} players on {site} against a full execute. That defense needs an earlier read to survive.',
      'You are about to defend {site} with {n}. Anything you learn before this point is worth a rotation.',
      'The execute is coming to {site} and you are at {n}. Getting one more body there in time is the whole round.'
    ]
  },

  'late-rotation': {
    rule: 'late-rotation',
    category: C.SYNCHRONIZATION,
    variants: [
      'You started rotating {seconds} seconds after the plant with {distance} still to travel. You cannot arrive in time to matter.',
      'The bomb was down before you moved. From there the retake happens without you.',
      'You had {seconds} seconds of readable information before the plant and rotated after it. Your team retakes a player short.',
      'That rotation started too late to reach the site. Read the commitment earlier and you are part of the retake.'
    ]
  },

  // ---- Praise (not a mistake, kept in its own lane) ------------------------

  overstack: {
    rule: 'overstack',
    category: C.PRAISE,
    variants: [
      'You are about to take on a T execute with {n} more than the default for a {site} bombsite defense. Well done on rotating and stacking correctly.',
      '{site} is stacked {n} over the default before the execute lands. That is the rotation working.',
      'You read the execute early and brought {n} extra to {site}. That is how a retake stops being a retake.',
      'You are {n} over the default on {site} with the execute coming. Good rotate.'
    ]
  }
});

/** rule id -> category, including the per-site variants of the stack rules. */
const CATEGORY_BY_RULE = (() => {
  const out = new Map();
  for (const entry of Object.values(COACH_MESSAGES)) {
    if (!out.has(entry.rule)) out.set(entry.rule, entry.category);
  }
  for (const site of ['a', 'b']) {
    out.set(`${site}-understack`, C.SYNCHRONIZATION);
    out.set(`${site}-overstack`, C.PRAISE);
  }
  return out;
})();

/** Which of the four categories a stored note belongs to, or '' when unknown. */
export function coachCategory(rule) {
  return CATEGORY_BY_RULE.get(String(rule || '')) || '';
}

/**
 * Deterministic variant index.
 *
 * The tick alone would make every rule that fires on the same death pick the
 * same slot, so the key is mixed in. FNV-1a over the string is enough: the only
 * property that matters is that it is stable across sessions and machines.
 */
function variantIndex(key, tick, count) {
  let h = 0x811c9dc5;
  const s = `${key}:${Math.round(Number(tick) || 0)}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % count;
}

/**
 * One coach line, picked deterministically and with its placeholders filled.
 *
 * Unknown placeholders are left as-is rather than printed as "undefined": a
 * variant that references a value the rule did not compute is a copy bug, and
 * leaving `{seconds}` visible in the note makes it obvious instead of quiet.
 *
 * @param {string} key   key into COACH_MESSAGES
 * @param {number} tick  flag tick, the seed for the variant pick
 * @param {Record<string, string|number>} [vars]
 * @returns {string}
 */
export function coachText(key, tick, vars = {}) {
  const entry = COACH_MESSAGES[key];
  if (!entry?.variants?.length) return '';
  const text = entry.variants[variantIndex(key, tick, entry.variants.length)];
  return text.replace(/\{(\w+)\}/g, (whole, name) =>
    vars[name] === undefined || vars[name] === null ? whole : String(vars[name])
  );
}

/** The rule id a message key writes, for callers that build flags from a key. */
export function coachRule(key) {
  return COACH_MESSAGES[key]?.rule || key;
}
