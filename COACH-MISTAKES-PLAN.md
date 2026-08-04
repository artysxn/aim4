# Coach mistakes: taxonomy and roadmap

Every mistake the coach can find today plus every one worth adding, sorted into four
categories, each note carrying its trigger and its four message variants.
Written 2026-08-04. Code lives in `src/replays/coach/`.

**Notes marked `*` do not exist yet.** Feasibility on those:

- **(disk)** every input is already in the round file or tick buffer. Index rebuild at worst, no reparse.
- **(geom)** on disk, but needs work against `duels/sightRay.js`, `duels/visionState.js`, or the zone network.
- **(model)** needs `duels/duelModel.js` evaluated at coach time, which it currently is not.

## 1. The four categories

| Category | What it is | Cost when it happens |
|---|---|---|
| **Carelessness** | Single-handedly ruining a round that was already won. Untraded deaths while ahead, solo fights taken with the round in hand. | The round. |
| **Mechanical error** | Bad aiming or movement. Crosshair nowhere near the fight, shooting at running speed, missing the shot that was free. | A duel, and often the round with it. |
| **Quality** | Things that raise the win chance a few points each if slightly improved. Missed utility, missed refrags, bad spacing, missed timings against utility. | A few percent, compounding. |
| **Synchronization** | The team acting out of step with itself. The lurker going before the core has done anything, rotations arriving late, an angle nobody was covering. | The shape of the round. |

Two rules for placing a note that could fit twice:

- **Advantage first.** Anything that would be a Quality note becomes a Carelessness note when the
  side was already up a man or already above 70% win chance. Spacing in a 3v3 is Quality. The same
  spacing in a 4v2 is Carelessness.
- **Timing splits on what you were out of step with.** Late against a *grenade* is Quality. Late
  against a *teammate* is Synchronization.

## 2. Shared gates

Most tuning arguments end up being about these rather than about the rules.

- **Buy gate.** A side that opened freezetime below 25% win chance (`HOPELESS`) is never coached
  that round. It was lost on the buy.
- **Coach window.** 1s after freezetime through 1s before `endTick`, hard-stopped at the defuse tick.
- **Frag grace.** A kill in the previous 5s (`FRAG_GRACE_SECONDS`) suppresses the death.
- **Trade window.** A teammate's kill within 3s (`TRADE_SECONDS`) answers the death.
- **Last alive.** A 1vX is never coached.
- **Win-chance line.** Rules read `ct`/`t` from the trained round model, never the duel-lookahead
  overlay (`ctDuel`). A probability that has already priced the death in reports that every death
  cost nothing.

These gates are all death-side. Mechanical error is not. See section 7.

## 3. Writing the messages

Every fired event type has four variants below. Rules for all of them:

- **Never use the long dash character.** Plain simple English, short sentences.
- **State the consequence.** The player has to finish the sentence knowing what it cost, not just
  what happened.
- **Pick one variant deterministically** by hashing the flag tick, so the same round always reads the
  same way but a match does not repeat one line eight times.
- **Do not write the win-chance sentence into the variant.** Rules that compute a drop already append
  "Round win chance fell from X to Y."

Placeholders: `{player}` `{enemy}` `{teammate}` `{n}` `{m}` `{win}` `{seconds}` `{hp}` `{shots}`
`{hits}` `{missed}` `{share}` `{deg}` `{speed}` `{was}` `{is}` `{delta}` `{site}` `{zone}`
`{item}` `{distance}`.

---

## 4. Carelessness

### `advantage-lost` (existing) [coach.js:531](src/replays/coach/coach.js:531)

Died untraded while up a man, with the side already up a man 3s earlier (`HOLD_SECONDS`).

1. You died in a {n}v{m} with nobody able to trade you. Being up a man only wins the round if you stay up a man, and this made it even again.
2. That death was untraded in a man advantage. The extra player was the whole edge and it is gone.
3. You were up a man and died for free. Your team now has to win a duel they never had to take.
4. No teammate was close enough to punish that. When you are ahead you should be the last one taking a risk, not the first.

### `negative-ev` died (existing) [coach.js:590](src/replays/coach/coach.js:590)

Solo duel taken and lost with the live win chance at or above 75% (`DOMINANT`). Gated at the
fight, not at freezetime, because a buy that opened at 94% can be 33% by the time the duel happens.

1. You took a solo fight with the round already {win} won. Winning it added almost nothing and losing it cost most of the round.
2. The round was {win} in your favour before this duel. A fight nobody can trade is a bad deal even when it works, and this one did not.
3. There was no reason to go looking for that fight. At {win} the round wins itself if you stay alive and make them come to you.
4. You put a {win} round on a coinflip nobody could back you up on. That is the whole loss right there.

### `negative-ev` survived (existing) [coach.js:891](src/replays/coach/coach.js:891)

Same fight, won. Read off the kill side of the log because a won duel leaves no death behind.

1. You won that solo duel, but you took it at {win} with no support. The round did not need it.
2. Good fight, wrong fight. At {win} you risked a won round to gain almost nothing.
3. That came off, but it was still the wrong choice. Take the same fight ten times at {win} and you lose rounds you had already won.
4. You did not need that kill. Holding your angle wins the round with none of the risk.

### `*` `untraded-won-round` **(disk)**

Untraded death at even headcount when live win chance was 70% or higher and had been for 3s.
The headcount gate on `advantage-lost` misses rounds that are won on health and equipment instead
of bodies. Consequence framing is deliberately economic: the dropped rifle costs the next round too,
and 1 to 2% off a match win is still off a match win.

1. You died untraded in a round you were already {win} to win. You dropped your gun as well, so this costs the next round's buy on top of it.
2. That death was free for them. Even when the round still wins, losing a rifle for nothing quietly costs you the round after it.
3. The round was {win} yours and nobody could trade you. Every one of these takes a percent or two off the match, not just the round.
4. You had the round won on health and guns. Dying here hands them equipment they did not earn.

### `*` `pushed-advantage` **(geom)**

Up a man, moved **deliberately alone** (no teammate within `ALONE_DISTANCE` for the whole approach)
toward a zone the enemy has held control of for 8 seconds or more, and died there. The 8s ownership
window comes from the per-zone possession shares in `mapControlAdvantage.js`, and it is what keeps
this off ordinary map movement.

1. You pushed alone into space they had held for {seconds} seconds while up a man. Nothing to gain there and a whole round to lose.
2. That was their ground and you walked into it on your own with the advantage. They only had to stand still and wait.
3. Up a man you do not need to find them. Going into territory they already control hands the extra player straight back.
4. You gave the advantage away by moving into their space alone. Make them come to you when you are the ones ahead.

### `*` `afterplant-duel` **(model)**

T side only. Post-plant, within the first 15 seconds of `plantTick`, a clean isolated 1v1 at equal
numbers, where the duel model's **average** win probability across the duel was below 66%. Below
that line the bomb timer is worth more than the fight, so the correct play was to hold off the bomb
instead. Requires `predictDuel` sampled across the engagement rather than at a single tick.

1. You took a 1v1 in the first {seconds} seconds after the plant at only {win} to win it. Below about two thirds, the bomb wins you more rounds than the fight does.
2. The bomb was down and the clock was already working for you. A {win} duel this early throws that away.
3. In an afterplant your job is to make them come to you. Taking a {win} fight this early gives them a free defuse when it goes wrong.
4. That duel was close to a coinflip and you did not need it. Play off the bomb and make them find you.

---

## 5. Mechanical error

The emptiest category and the one with the most data already sitting unused. `shared/aimMetrics.js`
computes crosshair error and over/underflicks, `shared/awpAccuracy.js` gates AWP fires on being
within 10 degrees of a living enemy with no smoke on the path, and `duels/duelModel.js` carries a
movement penalty. None of it reaches a coach flag.

### `unaware-openness` (existing) [coach.js:698](src/replays/coach/coach.js:698)

Victim's yaw was 30 degrees or more (`UNAWARE_DEGREES`) off the killer at the tick before death.

1. You died to {enemy} with your crosshair {deg} degrees off them. The fight was over before you could aim at it.
2. Your crosshair was nowhere near {enemy} when they opened. Pre-aiming the angle you walk into is what makes these fights winnable.
3. You were looking {deg} degrees away from where the shot came from. That is a free kill for them every time.
4. {enemy} did not have to out-aim you here. Your crosshair was already off the angle before the duel started.

### `*` `running-shot` **(model)**

Fired above the weapon's accurate movement cap. **Weapon whitelist only: full rifles (AK-47, M4A4,
M4A1-S, Galil, FAMAS, AUG, SG 553), the Desert Eagle, and the AWP.** SMGs and pistols are excluded
because running accuracy is part of how they are meant to be used, and including them would bury the
note in false positives.

Checked **per fired bullet**, not once per duel. The cost is quantified rather than asserted:
`predictDuel` runs once at the real speed and once at speed 0, and the difference is the note.
The movement term already exists at [duelModel.js:118](src/replays/duels/duelModel.js:118)
(`moveP * me.speed / RUN_SPEED`), so the counterfactual is a second call to a function that already
runs. Highest-value note in the plan.

1. You fired at {speed} units per second. Standing still made that fight {was}. Moving turned it into {is}.
2. Those bullets went nowhere near your crosshair because you were still running. You dropped the duel from {was} to {is} on your own.
3. You had the better fight until you shot while moving. {was} became {is} before they even fired back.
4. Stop first, then shoot. That one habit was worth {delta} points of win chance in this duel alone.

### `*` `awp-miss` **(model)**

An AWP shot that was 75% or more free **at the moment of shooting**, that dealt no damage. Fires off
the shot and not the outcome: it counts whether you then won the fight, lost it, or backed out.
`awpAccuracy.js` supplies the eligibility gate, `events.shots` supplies the fire, `events.damage`
supplies the miss.

1. That AWP shot was {win} free when you pulled it and you missed. One shot decided the round and it did not land.
2. You had {enemy} dead to rights at {win} and the shot missed. Whatever happened after, that was the round.
3. A {win} AWP shot is a kill you are expected to take. Missing it costs your team the man advantage you had already earned.
4. That was as close to free as an AWP shot gets. Missing turns a won angle into a fight you now have to reload through.

### `*` `lost-ahead` **(model)**

You died in a duel that the model put at **75% or better in your favour at the moment you had clear
line of sight** to the opponent. The 75% floor applies regardless of crosshair error, position, or
anything else that made you the favourite: if the fight was not clearly yours, this does not fire.

1. You entered that duel {win} in front and lost it. Every advantage was yours going in.
2. The fight was {win} yours the moment you had sight of them. Losing it hands over a round you should have had.
3. You saw them first, from the better spot, {win} to win, and died anyway. That is the fight to convert every time.
4. Everything about that duel was in your favour at {win}. Losing it costs the round and the gun.

### `*` `flick-error` **(disk)**

At least **50% of all shots fired during the engagement that ended in your death** were overflicks or
underflicks, meaning off target on either side. `classifyFlickMiss` in `aimMetrics.js` already does
the classification.

1. {share} of your shots in that fight went past or short of the target. You were aiming through them, not at them.
2. You overshot and undershot your way through that engagement and died to it. Slow the first shot down and land it.
3. Most of your shots in that duel missed on one side of the target or the other. That is crosshair speed, not reaction time.
4. You kept flicking past the target. Every one of those misses gave them a free shot back.

### `*` `missed-everything` **(disk)**

The blunt variation of the above, with no flick classification required. Fires when you died after
firing **3 or more shots and hitting none**, or **4 or more shots and missing 66% or more of them**.

1. You fired {shots} shots in that fight and hit none. That is a duel you were in and lost for free.
2. {shots} shots, {hits} hits, and you died. The fight was there, the aim was not.
3. You missed {missed} of {shots} before dying. Your team is a player down because none of those landed.
4. None of that spray touched them. Take the first shot properly instead of hoping the rest catch up.

### `*` `spray-past-control` **(disk)**

**6 or more bullets fired after the last bullet that did any damage**, inside a single burst. Bursts
are segmented on `cycleSeconds` from the weapon table.

1. You kept firing for {n} more bullets after your last one did any damage. That is an empty magazine and a dead player.
2. The spray stopped working {n} bullets before you stopped shooting. Reset and take a second burst.
3. {n} bullets after your last hit is not a spray, it is a reload you are giving them for free.
4. You held the trigger long past the point it was landing. Burst it, let the pattern reset, and you win that fight.

### `*` `not-ready` **(geom)**

Died with the killer inside your cone for 0.4s or more having fired zero shots. Framed as readiness
rather than as freezing: the problem is that you were in the fight before you were set for it.

1. {enemy} was on your screen for {seconds} seconds and you never fired. You were in that fight before you were ready for it.
2. You had line of sight and time to shoot and did neither. Clear angles expecting a fight, not hoping there is not one.
3. That fight caught you unprepared. Being on the angle is not the same as being ready for the angle.
4. You never got a shot off. Come to the angle already set up and that duel is a normal one.

---

## 6. Quality

Nothing here loses a round on its own. Each one is worth a few percent and they compound.

### `solo-even` (existing) [coach.js:614](src/replays/coach/coach.js:614)

Died alone, untraded, in a 3v3 or 4v4 that had held for 3s.

1. You died alone in a {n}v{n} with no trade. Even rounds go to the team that fights together.
2. Nobody could trade you in an even fight. That one death is what turned it into a losing one.
3. You were on your own in a {n}v{n}. That costs the round even when your health already looked bad.
4. In an even fight a teammate has to be close enough to punish whoever kills you. Nobody was.

### `multikill-refrag` (existing) [coach.js:859](src/replays/coach/coach.js:859)

One lone enemy killed 2 or more stacked teammates in a 4s chain and was the only player to deal them
damage in a plus or minus 4s window. Needs `events.damage`.

1. {enemy} killed {n} of you alone. Someone had to punish the first kill and nobody did.
2. {n} players died to one enemy with no help from their side at all. That is a refrag your team never attempted.
3. One player took {n} of yours by themselves. Whatever the first fight was, the rest were free.
4. {enemy} won a {n}v1. That does not happen when the second player is ready to trade the first.

### `utility-unawareness` (existing) [coach.js:752](src/replays/coach/coach.js:752)

Died to an enemy standing within 150 units of your own molotov, 1s to 7s after it landed.

1. You died to {enemy} standing in your own fire. Once you throw it, watch it.
2. Your molotov was burning and {enemy} played it against you. That is your own utility used against your position.
3. You lost that fight to someone in your own fire. The fire told you exactly where they had to be.
4. You threw the fire and stopped tracking it. {enemy} did not.

### `*` `missed-flash` **(disk)**

Fires when **at least one teammate was blinded more than at least one enemy** by the same flashbang,
with the teammate above the 0.5s floor. An enemy blinded for zero seconds counts, so a flash that
catches a teammate and misses the enemy entirely fires here. `blindFromFlash` in
[utilityMetrics.js:98](src/replays/shared/utilityMetrics.js:98) already measures the rise in each
player's blind timer across detonation and deliberately skips teammates. Measuring both sides is a
small change to a function that already exists.

1. That flash blinded {teammate} for {seconds} seconds and did less to the enemy. You took a player out of the fight and it was one of yours.
2. Your flash hurt your own team more than theirs. Anyone on your side who could not see was a free kill.
3. {teammate} ate that flashbang. You spent a grenade to make your own team easier to kill.
4. That was a bad lineup. The flash has to land behind their angle, not in front of yours.

### `*` `ate-team-flash` **(disk)**

Blinded more than 1.0s by a teammate's flashbang. Separate from the throw because the fix is
different: the thrower needs a lineup, the victim needs to turn. Escalate the copy when the player
died within 2s of it.

1. You were blind for {seconds} seconds from your own team's flash. You cannot hold or take an angle while you cannot see.
2. A teammate flashed you for {seconds} seconds. Turn away from your own utility so you are not the one paying for it.
3. You lost {seconds} seconds of the round to a friendly flash. That is free time for the enemy to move.
4. Your own team's flash took you out of the fight. Watch for the throw and turn.

### `*` `team-util-damage` **(disk)**

Lost more than 20 HP in a round to grenades or fire thrown by your own side. `events.damage` carries
both ids, so same-side attribution is direct. Flag the thrower and the victim with different copy.

1. You lost {hp} health to your own team's utility. Every point of that makes the next fight harder to win.
2. {hp} damage from a friendly grenade. Now you have to win the next duel from behind for no reason.
3. Your own team's utility took {hp} off you. That is a duel you would have won at full health.
4. You walked into your own team's grenades for {hp}. Let the utility come down before you move.

### `*` `died-holding-util` **(disk)**

Died with **3 or more grenades still in the loadout**. Freezetime `loadout` minus `events.grenades`
for that player.

1. You died with {n} grenades still unthrown. All of that value goes back to nobody.
2. {n} pieces of utility died with you. They were bought to be used, not carried.
3. You had {n} grenades in hand and never used one. Throw them into the fight, or throw them for the next round's buy.
4. Utility does nothing in your inventory. You died holding {n} pieces that could have won that fight.

### `*` `knife-out` **(disk)**

Died while holding no gun: knife, grenade, bomb, or taser in hand at the death tick. Reads the
`weapon` byte against the round's weapon dictionary.

1. You died without a gun out. There was no version of that fight you could win.
2. You were caught holding {item} instead of your weapon. Free kill for them, lost round for you.
3. Running with the knife saves a second and costs the duel. You had nothing to shoot back with.
4. You died with no gun in hand. Switch back before you cross anywhere someone can see you.

### `*` `flash-no-followup` **(geom)**

Late round phase only, and only for a flash detonating inside a bombsite or a key bomb zone. Fires
when the flash blinded at least one enemy and **nothing at all happened** before that enemy
recovered: no teammate took new space, no damage was dealt, no kill occurred, in either direction.

1. That flash blinded {enemy} in the {zone} and nothing happened. Nobody moved in, no fight was taken, and the grenade was spent for nothing.
2. You bought {seconds} seconds of blindness late in the round and nobody used them. That is a grenade and a timing gone.
3. The flash landed and the round stood still. Late round utility has to be followed by someone taking space.
4. Nothing came of that flash. If nobody is moving, hold the grenade until someone is.

### `*` `spacing` **(model)**

Fires only when **two teammates die to the same enemy**, where each individual duel sat in the 40 to
60 band for either side, but the model puts that enemy at **85% or higher to die** if the two had
peeked together. The point is the counterfactual: two near coinflips that should have been one
near certainty.

1. You and {teammate} both died to {enemy} in separate fights. Each of you was close to a coinflip alone. Together it was {win} in your favour.
2. {enemy} got to fight you one at a time. Peeking together turns two coinflips into a {win} kill.
3. You were close enough to die to the same player and too far apart to fight them together. That is the worst place to be.
4. Two isolated duels against one enemy. The same two players peeking at once wins that {win} of the time.

### `*` `nade-stack` **(disk)**

A single **enemy HE grenade** dealing **40 or more combined damage across 2 or more teammates**, where
**every teammate it hit lost at least 10 HP**. Grouped by grenade weapon and tick proximity in
`events.damage`.

1. One HE took {hp} health across {n} of you. Standing that close means a single grenade can decide the round.
2. {n} players damaged by one grenade for {hp} total. Spread out before their utility comes down.
3. That grenade got {hp} damage because you were all in the same place. Now every one of you fights from behind.
4. One enemy HE hurt {n} of you. That is one throw putting the whole group at a disadvantage.

### `*` `no-trade-attempt` **(geom)**

Fires when a teammate dies in a duel that was roughly 66/33 for either party, you were near them, and
you made **no attempt to engage within 1 second**. The reachability test is the important part: if you
had moved to the exact position the teammate died at, would you have been in an engaged position? If
yes, and your own resulting fight would itself have been 66/33 or better in your favour, the trade
was available and you did not go for it.

1. {teammate} died right next to you and you never moved. Stepping up was a {win} fight for you and you did not take it.
2. You were close enough to trade {teammate} and did not try. Their death bought the enemy a free player.
3. The trade was there at {win} in your favour. Not going for it turns one loss into two.
4. You had one second to punish that kill and stayed where you were. That is the difference between an even round and a losing one.

### `*` `trade-failure` **(geom)**

Same setup, opposite outcome. You **did** attempt the trade inside the window and lost it. Separate
note because the coaching is different: the read was right, the execution was not.

1. You went for the trade on {teammate} and lost it. The attempt was right, the fight was not won.
2. Right instinct, wrong outcome. You had {win} on that refrag and it did not land.
3. You tried to trade and died doing it. Check the angle before you step out so the second death is not free too.
4. The refrag was there and you missed it. Now they are up two for one fight.

### `*` `late-off-flash` **(disk)**

You engaged an enemy who **was blind at some point in the previous 3 seconds** and **was no longer
blind by the time your first shot landed or was fired**. The per-tick `flash` byte gives the exact
recovery tick, so the note is a subtraction.

1. {enemy} was blind {seconds} seconds ago and could see again by the time you fired. You paid for the flash and arrived after it.
2. You took that fight just after the flash ended. All the value of the grenade went to nobody.
3. The flash did its job and you were {seconds} seconds late to use it. Move on the pop, not after it.
4. By the time you shot, {enemy} could see you fine. The grenade was wasted and the fight was even.

### `*` `early-off-flash` **(disk)**

The mirror. You made contact before your own flash detonated, so the enemy was never blind when you
arrived.

1. You crossed before your own flash went off. {enemy} was never blind when you got there.
2. The flash detonated behind you. You took the fight at full disadvantage with a grenade already spent.
3. You were early. Wait for the pop, then move, or the flash does nothing at all.
4. That flash blinded nobody because you were already in the fight. Timing the move is what makes the grenade work.

### `*` `smoke-peek` **(geom)**

An enemy had line of sight to you and killed you, and **within 2 seconds that line of sight would not
have existed** because a smoke was already in the air and about to bloom.

1. {enemy} killed you across a line that a smoke closed {seconds} seconds later. Waiting would have removed the fight completely.
2. You crossed with a smoke already in the air. Two more seconds and they could not have seen you at all.
3. That angle was about to be smoked off. You took the one fight the utility was there to prevent.
4. Your team was closing that line for you. Peeking before it landed gave away a player for nothing.

---

## 7. Synchronization

### `lurk-first` (existing) [coach.js:549](src/replays/coach/coach.js:549)

Even headcount, victim was a lurker outside the core per `cores.js`, and the core had not taken a
single fight yet. The best example of the category: the lurk happened before the round produced
anything to lurk off.

1. You died on your own before the rest of the team had taken a fight. There was no information yet for the lurk to work off.
2. The core had not moved and you were already dead. A lurk works after the team pulls attention, not before.
3. You went alone before anything happened on the map. Your team now plays the round a man down with nothing gained.
4. Nothing had happened anywhere when you died. Let the group take a fight first, then open the map behind it.

### `free-opening` (existing) [coach.js:565](src/replays/coach/coach.js:565)

The round's first death, with no other kill anywhere within 3s.

1. You opened the round by dying with nothing happening anywhere else. Nothing was traded and nothing was gained.
2. First death of the round with the map completely quiet. Your team starts behind for free.
3. Nobody else was in a fight when you died. That death bought your team no space and no information.
4. That was a free opening kill for them. Take that fight when your team is set up to use it.

### `unchecked-position` (existing) [coach.js:662](src/replays/coach/coach.js:662)

A connected stack of 3 or more where every one of them was more than 15 degrees off the angle the
killer came from. Beats `unaware-openness` when both fire.

1. You died to {enemy} from an angle none of the {n} of you were watching. With that many players someone has to hold it.
2. {n} players stacked and nobody covering the angle they came from. That is a team mistake, not a duel you lost.
3. Nobody was looking where {enemy} came from. Split the angles when you group up, or the group dies one at a time.
4. All {n} of you were watching the same direction. That is the one thing a stack cannot afford.

### `a-understack` / `b-understack` (existing) [siteExecute.js:166](src/replays/coach/siteExecute.js:166)

T core sat on a bombsite for 3s in mid or late round and the CT count there was at or below the
per-map default (`CT_SITE_DEFAULTS`). At most once per site.

1. The T side is setting up on {site} and you have {n} there. Could you have taken info or rotated earlier?
2. {n} players on {site} against a full execute. That defense needs an earlier read to survive.
3. You are about to defend {site} with {n}. Anything you learn before this point is worth a rotation.
4. The execute is coming to {site} and you are at {n}. Getting one more body there in time is the whole round.

### `*` `late-rotation` **(geom)**

A CT who began moving toward the other site only after `plantTick`. Three thresholds keep it from
misfiring, and all three are required:

- The T commitment had to be **readable for at least 5 seconds before the plant**, from the per-zone
  possession shares in `mapControlAdvantage.js`. If the read was not available, the rotation was not late.
- The player has to be **far enough from the bomb that the delay actually cost arrival time**. Compute
  path distance from their position at `plantTick` to the bomb and require it to exceed what they could
  cover in the remaining bomb timer at normal movement speed.
- The player must not have been **in an engagement or holding a live angle** during the readable
  window. Someone pinned on their own site is not rotating late, they are doing their job.

1. You started rotating {seconds} seconds after the plant with {distance} still to travel. You cannot arrive in time to matter.
2. The bomb was down before you moved. From there the retake happens without you.
3. You had {seconds} seconds of readable information before the plant and rotated after it. Your team retakes a player short.
4. That rotation started too late to reach the site. Read the commitment earlier and you are part of the retake.

---

## 8. Structural change: Mechanical error cannot be a death rule

Every rule in the coach today iterates `kills` in pass two and inherits the death-side gates from
section 2. Mechanical error does not fit that shape. A missed AWP shot that was 75% free is the same
mistake whether you then won the fight, lost it, or backed out of it. So:

- Mechanical rules need a **third pass over `events.shots`** and over the engagement episodes
  `duels/duelScanner.js` already produces, not over the kill log.
- `recentlyFragged` and the trade window must **not** apply to them. Both are arguments about whether a
  death was avoidable and neither says anything about whether a shot was hit.
- The buy gate still applies. A missed AWP shot on a full eco is not worth coaching.
- Notes attach to a shot tick rather than a death tick. `flagToNote` already keys on `tick`, so this
  costs nothing.

Three Quality notes fire off a throw rather than a death and need the same treatment: `missed-flash`,
`ate-team-flash`, and `flash-no-followup`.

`running-shot`, `awp-miss`, `lost-ahead`, `afterplant-duel`, and `spacing` all need `duels/duelModel.js`
evaluated during the coach pass. It currently is not, and the counterfactual evaluations
(same duel at speed 0, same duel with both teammates present) are the entire value of those notes.
This is the one shared piece of plumbing worth building before any of them.

## 9. Not carried forward

- `round-decided` [coach.js:927](src/replays/coach/coach.js:927) and `roundDecided.js`. Marks the tick
  win% crossed 88% and never came back on an equal buy. Being removed. Not a mistake, and the only flag
  pinned to a side rather than a player.
- `a-overstack` / `b-overstack` [siteExecute.js:154](src/replays/coach/siteExecute.js:154). Praise for
  rotating correctly. Keep it, but it is not a mistake and does not belong in the taxonomy. If the panel
  groups by category it needs a lane of its own.

## 10. Build order

1. **Utility friendly fire.** `missed-flash`, `ate-team-flash`, `team-util-damage`, `nade-stack`. All
   four are `events.damage` plus a small extension to `blindFromFlash`. No geometry, no reparse, no model.
2. **The duel model plumbing** from section 8, then `running-shot` and `awp-miss`. These two carry the
   whole Mechanical category and both are quantified rather than asserted.
3. **The cheap disk notes.** `died-holding-util`, `knife-out`, `missed-everything`, `spray-past-control`,
   `flick-error`, `late-off-flash`, `early-off-flash`. Each is small and independent.
4. **`untraded-won-round`.** One extension of the existing Carelessness gate to cover rounds won on
   health rather than headcount.
5. **`no-trade-attempt` and `trade-failure`.** The natural completion of the existing rules, which
   currently only ever blame the player who died.
6. **The remaining model notes.** `lost-ahead`, `afterplant-duel`, `spacing`.
7. Everything left marked **(geom)**, ordered by whichever zone work lands first.
