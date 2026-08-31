// ---------------------------------------------------------------------------
// lib/coachNotes.js
// What to actually do about a weak mechanic.
//
// Numbers say WHAT dropped; these notes say what to change at the desk. They
// show on the post-game Coach page when a targeted mechanic comes in lower
// than the run before, and on the routines page under the mechanics a routine
// targets.
//
// The voice is deliberate: encourage first, then one concrete adjustment. A
// player reading this just underperformed at the exact thing they are trying
// to fix, which is the moment coaching either lands or stings. A dip on a
// targeted mechanic during retraining is EXPECTED, and half these notes exist
// to say so before saying anything else.
//
// Pure data plus lookup helpers. No DOM, no storage.
// ---------------------------------------------------------------------------

/**
 * One note per mechanic, keyed like lib/routines.js MECHANICS.
 *
 * `short` is one sentence for the intermission screen between routine modes.
 * `full` is the whole note for the post-game Coach page and the routines page,
 * paragraph per entry.
 */
export const COACH_NOTES = Object.freeze({
  adjustments: {
    title: 'Adjustments',
    short:
      'Lower the tension in your arm and reach the target in one controlled motion, like dragging a file across your desktop, not stabbing at it.',
    full: [
      'More motions per kill usually means your aim is arriving in pieces: a fast macro flick that lands near the target, then one or more micro corrections to finish. That two-part habit feels quick, but the correction is where time and consistency leak out. The best aimers merge both parts into one smooth, controlled motion, and they got there by accepting a small speed loss up front.',
      'So slow down on purpose. Lower the tension in your arm, and move the mouse the way you would drag a file across your desktop: one deliberate motion that stops where you meant it to stop, not a snap at a target you then have to chase. If the first motion ends on the target, the second motion never needs to exist, and that is the whole statistic.',
      'Speed is not gone, it is deferred. Train at the pace where one-motion aim is comfortable, and let speed build back gradually as the new muscle memory settles. Lower speed, lower tension, more control, one motion. The players who sacrifice a little speed early are the ones who collect the consistency later.'
    ]
  },
  precision: {
    title: 'Precision',
    short:
      'Slow down and let the first motion finish on the target. Hitting the first headshot beats three fast bodyshots every time.',
    full: [
      'Precision drops when speed is bought with placement. A 50 ms difference in who shoots first almost never decides a fight; hitting the first headshot instead of three bodyshots decides it constantly. When this number dips, the fix is nearly always to slow the hand down, not to speed it up.',
      'The proof that slower can be better sits at the top of the game. Donk averages about 97 degrees per second of flick speed, noticeably under the 120 of an average player, and it would score him around 58 of 100 on raw speed. He still lands 72.6% of his flicks, against roughly 63% for an average professional. He gives away a little speed and takes back the fight itself.',
      'Rebuild at a pace where your flicks finish ON the target rather than near it, and treat the settle as part of the motion, not an afterthought. The speed returns on its own as the controlled version becomes automatic. It always does. What never comes back on its own is precision lost to rushing.'
    ]
  },
  speed: {
    title: 'Speed',
    short:
      'Get comfortable hitting first, then train speed together with reactions. Alertness is where real speed comes from.',
    full: [
      'Low speed is not automatically a problem. It is easy to hit a static target given enough time, and easy to hit anything if the target is big enough; the game only pays for the balance between speed and accuracy. Some players deliberately run slower to hit more, and it works. But the honest version of that trade is this: a player who keeps their exact accuracy AND gets faster is simply better. Speed is worth training once accuracy is stable enough to survive it.',
      'The order matters. Get comfortable hitting first. Then raise speed together with reaction training, because a fight is where the speed will actually be spent, and speed trained in isolation from the see-react-commit loop does not transfer. Modes that make you acquire, decide and fire in one breath train the version of speed that wins duels.',
      'The last multiplier is mental. Work on visualization so you are ready for everything before it appears: where the target can come from, what your hand will do when it does. More alertness reads on the stat sheet as higher speed and lower reaction time at once, because the motion started earlier in your head.'
    ]
  },
  flicks: {
    title: 'Flicks',
    short:
      'Stop steering the flick mid-air. Calm hand, read the target, and let repetition build the muscle memory.',
    full: [
      'There is no clever shortcut for flicks. The only thing that builds them is playing, repetition inside a consistent setup, until the motion belongs to your body instead of your thoughts. What you can control is the environment that repetition happens in.',
      'Find a way to hold the mouse that is consistent and stable for you, and let every part of the arm contribute by reflex: shoulder for the big travel, elbow, wrist and fingers for the small. Do not force a doctrine like "wrist only for stability". Instead of thinking about which joint to use, think "calmest aim possible" and let the body distribute the work. It will, and better than a rule would.',
      'While training, keep your attention on the target, not on the hand. Visualize, read the target if it is moving, and, as cliche as it sounds, let yourself develop a feeling for how to hit. Identify with the eyes and brain; do not narrate the mechanics of the shot mid-flick. Repetition in that state is what converts conscious aiming into the automatic kind, and the automatic kind is the one that shows up in matches.'
    ]
  },
  reaction: {
    title: 'Reaction',
    short:
      'Reaction time falls when the answer is preloaded. Visualize the peek before it happens and the commit gets faster for free.',
    full: [
      'A high reaction number is rarely about raw reflexes. Most of the delay is decision time: seeing the target, working out what to do, then committing. Reflexes are near-fixed; the decision is trainable, and the way to train it is to have the decision made before the target appears.',
      'That is visualization. Before every peek and every hold, answer in your head: where can they appear, what will my hand do when they appear there. When the guess is right, your measured reaction time collapses, because the seeing and the deciding overlapped. This is also why reaction and speed train best together: the fight is where both get spent, so drill them in fight-shaped modes rather than in isolation.',
      'And keep the honest frame: slower reactions are survivable if you hit what you commit to. A calm, slightly later commit that lands beats a twitch that misses. Train the calm version first, then move the whole motion earlier with anticipation, not with hurry.'
    ]
  },
  tension: {
    title: 'Tension',
    short:
      'Tension spikes are usually stress. If calm will not come on command, change the setup so control is easier, then train speed there.',
    full: [
      'Tension usually spikes in the moments that matter, because stress tightens the grip before you notice it happening. The first thing to try is the direct route: a way to stay calm under pressure, whatever that is for you. Breathing between rounds, a pre-peek routine, deliberately loosening the grip at freeze time.',
      'But be honest if calm will not come on command, because for some players it will not, and there is a second route. One of us trained for three years to stay relaxed on a high sensitivity: fine while calm, useless the moment the round mattered, because you cannot force calmness at match point. The fix was not more calm training. It was switching to a lower sensitivity, where control comes naturally even with a tight grip, and then training SPEED there. The stress stopped mattering because the setup no longer punished it.',
      'The deeper lesson: tension itself is not the enemy. Players like Xantares, Woxic and Ropz are tense and snappy all the time and it works, because they train in the same state they play in. What breaks players is the mismatch, training relaxed and playing tense, so the trained aim never shows up when it counts. Match your training state to your match state, or change the setup until the two can meet, then train flow and speed inside that.'
    ]
  },
  tracking: {
    title: 'Tracking',
    short:
      'Tracking collapses when the grip tightens. Loosen the hand, smooth the path, and consider whether your sensitivity fights you under stress.',
    full: [
      'Tracking and tension are the same story from two sides: stress tightens the grip, the tight grip turns smooth pursuit into jitter, and the crosshair starts orbiting the target instead of living on it. When tracking dips in important moments specifically, treat it as a pressure problem before a mechanics problem.',
      'The mechanical half: track with the arm relaxed and let the motion be continuous. Chasing a strafing target with corrections is flicking in disguise; real tracking is one flowing path that the target happens to be on. Lower the intensity until the path is smooth, then bring the target speed back up.',
      'The setup half: if no amount of calm training survives contact with a real match, stop forcing it. A lower sensitivity makes control naturally cheaper, tension and tracking both, and you can spend the training budget on speed instead. Training control you can only access while relaxed, then playing tense, buys inconsistency. Train in the state you actually play in.'
    ]
  },
  crosshairError: {
    title: 'Crosshair placement',
    short:
      'Placement is bought with spare attention. Automate your mechanics so your mind is free to pre-aim where they will be.',
    full: [
      'Crosshair placement is not a hand skill, it is an attention skill. The concept worth learning here is the mental stack: the total amount of conscious attention and working memory you can spend tracking the game at once. Placement is what your crosshair does when you are NOT thinking about it, so it is a direct readout of how much of your stack the mechanics are still eating.',
      'The path is to move habits from conscious to subconscious, and there is only one road there: extensive repetition, plus self-correction from watching your own demos. Master the mechanics, accuracy and speed, until hitting a shot needs no thought at all. Every mechanical worry you automate hands attention back to the things that decide fights: should you jiggle or wide-strafe this peek, where exactly to hold, how this specific duel is won. That layer is duel gamesense, and placement is its most visible symptom.',
      'To train it directly once the mechanics are automatic: low-intensity deathmatch where placement is the only goal, duels against better players, retakes played purely for awareness, and grinding matches with the single intention of being completely locked in. Visualize everything. Where are they, how will they peek, what does your crosshair do about it. Then let the mechanics you automated do the rest.'
    ]
  },
  readyRate: {
    title: 'Readiness',
    short:
      'Readiness is anticipation. Ask where they are and how they will peek before every fight, and the crosshair is there first.',
    full: [
      'Readiness measures how often a fight starts with you already aimed at it, which makes it the purest anticipation statistic in the game. You cannot flick your way to a high ready rate. You think your way there, ahead of time.',
      'The frame that helps is the mental stack: the finite attention you can spend on the game at once. While aiming itself still costs conscious thought, there is nothing left over for prediction, and fights keep starting with your crosshair somewhere else. So the first fix is upstream: automate the mechanics with repetition and demo review until they are things you do, not things you think about. Professionals push even their duel decisions into habit, which is what frees them to think about the round instead of the fight.',
      'With the stack freed, train anticipation on purpose. Before every corner: where do I believe they are, how do they peek this angle, what is my answer. Watch your demos and count the deaths where the enemy appeared exactly where you should have expected them. Low-intensity deathmatch for placement, retakes for awareness, and matches played fully locked in are where this number moves. Every fight your brain predicted is a fight you were ready for, and the statistic follows.'
    ]
  },
  accuracy: {
    title: 'Accuracy',
    short:
      'Find your balance point between speed and hitting. Slow down until shots land, then bring speed back without losing them.',
    full: [
      'Accuracy is the balance statistic: it falls when you shoot faster than you can place, and it inflates emptily when you play so slow the number stops meaning anything. The skill is finding the fastest pace at which you still hit, and nudging that pace upward over weeks, not within one run.',
      'When it dips, do the simple audit. Are you firing while still moving? Committing before the crosshair has settled? Spraying at range where taps would land? Most accuracy loss is one of those three, and all three are pace problems, not talent problems.',
      'Rebuild from hitting. It is easy to hit a static target with enough time, so start there, and add speed only while the hits hold. The players who look both fast and accurate built the accuracy first and then sped up the whole package; nobody keeps accuracy that was never there while accelerating.'
    ]
  },
  firstBullet: {
    title: 'First bullet',
    short:
      'The first bullet is the fight. Let the flick settle for one beat before committing, placed beats early.',
    full: [
      'First-bullet accuracy is the one shot where nothing can be corrected afterwards: the fight often ends, one way or the other, before a second bullet matters. It rewards exactly one habit, arriving placed rather than arriving early.',
      'The usual leak is committing on top of the flick, firing while the crosshair is still travelling. Merge the motion the way the adjustments note describes, one controlled movement that ends on the head, and let there be a single beat of settle before the click. That beat costs a few milliseconds and buys the whole duel; a 50 ms head start means nothing next to a first bullet that hits.',
      'Crosshair placement multiplies everything here. The closer to head height and the nearer the corner you already hold, the shorter the flick, and the shorter the flick, the easier it is to land its first bullet. Half of first-bullet training is not aim at all, it is holding the right pixel before the fight exists.'
    ]
  },
  overflick: {
    title: 'Overflick',
    short:
      'Flying past the target is speed the motion cannot cash. Ease off the launch and let one controlled motion stop on the head.',
    full: [
      'Overflicking means the hand is launching harder than the stop can handle: the crosshair flies through the target and needs a pull back. It is the classic signature of aiming faster than your current control allows, and often of tension, because a tight arm is bad at braking.',
      'The fix is the one-motion discipline. Lower the tension, start the flick softer, and think of the movement as placing the crosshair, like setting a file down on the desktop where it belongs, not hurling it in the target direction. Train at the speed where the motion stops itself on the head with no return trip. That speed is your honest speed; everything above it is borrowed and paid back in corrections.',
      'Rebuild from there and the ceiling rises on its own. A motion that reliably stops on target can be gradually accelerated; a motion that overshoots cannot be patched with a better correction, because the correction was the problem.'
    ]
  },
  underflick: {
    title: 'Underflick',
    short:
      'Stopping short is hesitation in the hand. Commit to one full motion that ends on the target instead of creeping the last degrees.',
    full: [
      'Underflicking, stopping short and creeping the last few degrees, is usually hesitation rather than a speed limit: the hand does not fully trust where the target is, so it undershoots deliberately and finishes with a careful crawl. Safe-feeling, and slow, and it turns every flick into two motions.',
      'Two things dissolve it. First, commitment: decide during the flick that the motion ends ON the target, not near it, and let the read of the target set the distance. Visualize where the flick lands before the hand moves. Second, trust built by repetition: the more one-motion flicks that land, the less the hand insists on its insurance crawl.',
      'If underflicks and overflicks are BOTH high, the motion is simply not calibrated yet, and that is fine, it is what training is for. Slow the whole thing down until single motions land, then bring the speed up. Consistency first, then speed, in that order, always.'
    ]
  }
});

/** The note for a mechanic, or null. */
export function coachNoteFor(mechanic) {
  return COACH_NOTES[mechanic] || null;
}

/**
 * Encouragement openers for a run that came in lower than the one before on a
 * TARGETED mechanic. Rotated by run count so the line does not wear out, and
 * every one of them says the same true thing: a dip while retraining a
 * mechanic is the process working, not failing.
 */
const ENCOURAGEMENT = Object.freeze([
  'A dip while retraining is normal. New muscle memory gets worse before it gets better.',
  'Down a little from last run. That is what rebuilding looks like, keep the reps honest.',
  'Lower than last time, and expected. You are trading short-term comfort for long-term consistency.',
  'One run is noise, the trend is the signal. Stay slow, stay controlled.'
]);

export function encouragementLine(seed = 0) {
  const n = Math.abs(Math.round(Number(seed) || 0));
  return ENCOURAGEMENT[n % ENCOURAGEMENT.length];
}
