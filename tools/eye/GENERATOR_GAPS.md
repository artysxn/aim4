# What the coach's sheets have that the generator does not

Compared: the manual NAVI Junior Mirage sheet (`gold/navi-junior-mirage.en.txt`, `.ru.txt`) against the generated sheet for the same 17 demos (`node tools/eye/gold-pairs.mjs`), plus the patterns that repeat across the other gold sheets (HAVU, INFINITE, EAC, ENCE, WBT).

The generator already covers the structure (positions, pace, tells, forces, anti-ecos, site rounds, pistols, players, misc statistics) and most of the counting. What's missing is below, most valuable first. Each item says how a rule could detect it from data the scan already keeps.

## Detections to add

Done on 2026-10-17: #1, #2, #5, #13 (`antistratCoachReads.test.js`); #6 was already in the generator. On NAVI Junior Mirage they now read:

- "17 demos, against Bushido Wildcats (3), Entropy, …"
- "Fake on A: A smoke, then B (3 of the 6 rounds with A utility that went B)."
- "After an early kill on the other side of the map (before 1:00, with 3+ of them on one site's side), they still hit their side in 8 of 8 rounds. *They stick to the call instead of following their kills". This matches the coach's "they risk it instead of rotating".
- Under skizzyee: "With FAZERY at 1:30 in 31 of 59 rounds, mostly B."

1. **(Done) Fakes, said outright.** The coach writes: "Stairs smoke ALWAYS means A, they NEVER fake it", "they DO fake: Jungle smoke + Stairs molo", "they never fake B: any B molo means B." The generator stops at "Mostly A (12 of 13)".
   *Rule:* for each utility tell, list the rounds where the team hit the other site. Same utility combo in 2+ of those rounds → "Fake: …". Zero such rounds over 8+ → "never faked".
2. **(Done) Stubbornness.** "They stand 3 B, kill two on A and still go B."
   *Rule (as built):* an early kill (before 1:00 and the hit) on one site's side while 3+ of them stand on the other, then the hit. Kills the main group makes on its own way in are the hit itself and don't count. The first version, which counted any 2 early kills, read the opposite way (2 of 13), for exactly that reason.
3. **Plan conditioned on the opponent's AWP.** "With no enemy AWP they take a second timing without a top-mid smoke; when an AWP is possible they smoke top mid and pop through it."
   *Rule:* split force rounds and full buys by whether the opponent has an AWP alive at 1:50. Report a tell or pace that differs by 25+ points.
4. **Aborted hits.** "If they were seen or got a kill in underground, they went back and tried B, then mid."
   *Rule:* 3+ players move toward area X, then the hit lands elsewhere after contact in X.
5. **(Done) Player pairs.** "skizzyee in underground is always with FAZERY. If they push somewhere and FAZERY isn't there, the round isn't going there."
   *Rule:* from the 1:30 positions, how often two players share an area, and the hit site when they're together vs apart.
6. **(Already there) Pistol order.** "They never played the same pistol twice in a row. The last one was an A rush."
   *Rule:* sort pistol rounds by demo date. Report repeats and the most recent call.
7. **Late utility as a tell.** "7 late Boxes molos, and every one was a 3+ player mid fight."
   *Rule:* utility thrown after 1:20 in a zone, grouped by what the round turned into (CT side).
8. **Utility that predicts an unusual CT setup.** "An early B molo comes in only 40% of rounds, and in 75% of those they did something unusual (AWP B, B push, only 1 B)."
   *Rule:* condition the CT "Calls" on early utility being there or missing.
9. **Anchor spot conditioned on utility.** "Ramp-smoke rounds: MahaR takes off-angles by ramp/sandwich. Palace smoke first: he's near balcony."
   *Rule:* join `anchorUtilityFor` with `ctPositionsFor` for the same player.
10. **Force type by weapons.** "With deagles they take risky 1v1s at window, con and short. With SMGs or saved rifles they stack 4A or 4B."
    *Rule:* split CT force rounds by the main weapon bought.
11. **Covering for a role.** "skizzyee is only on short in 40% of rounds, but the AWP is on short often."
    *Rule:* when a role's player leaves his spot, who holds it instead.
12. **Rotation speed.** "Very fast rotations (3A 2B) if they see nothing mid."
    *Rule:* seconds from the first T commit to the CT's arrival, against the map median.
13. **(Done) Sources line.** "All 15 demos from September and October: Lazer Cats, Aimclub, …"
    *Rule (as built):* demo count and opponents, a team met twice counted once ("Bushido Wildcats (3)"). Demos carry only an upload date, not a match date, so there's no date range: it would have said "October" for matches from September and October.

## Numbers that disagree

The coach's misc statistics don't match the generator's:

| What | Coach | Generator |
| --- | --- | --- |
| CT starts with a positive win rate against them | 3 | 7 |
| Win rate vs A defaults | 78% | 72% |
| Win rate vs 4-mid | 86% | 60% |

The phrasing in the coach's sheet is this generator's own, so the coach's figures most likely came from it, run on a different set of demos:

- The coach's sheet lists Iberian Soul and Banger Gang. Neither is in the local library.
- The local library has Gentle Mates, Viresse and a third Bushido Wildcats game. The coach's sheet doesn't list them.

So at least part of the gap is data, and the local library can't settle it. Check it again on the full library.

## Written by aim4 eye, not by rules

Some of what the coach writes is judgement, and that's the model's job. It needs the measured facts (`find_weaknesses`, the opinions) as input:

- **Notes and preparation (our CT / our T):** what to do against them, in prose ("disrupt their T side by confirming it isn't an A or B execute, then search the sites").
- **Asterisk notes** under a section that sum it up ("*26% default + slow default", "*They risk it instead of rotating").
- **Hedging on thin data** ("6 rounds failed, so don't count them").

The SFT pairs from `gold-pairs.mjs` teach this. The system prompt's sheet style covers it until there's a fine-tune.
