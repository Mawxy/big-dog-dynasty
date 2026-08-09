# How every number on the WAR Board is calculated

One page for every figure the site publishes: what it measures, how it is
built, what it deliberately ignores, and where it breaks down. Each section
names the script that owns it — the script's docstring is the deeper reference,
and this file is the map.

Everything starts from one input: `players_points` in Sleeper's weekly matchup
dumps, which are already scored with the league's exact ruleset (PPR, TE
premium, superflex). No figure here re-scores anything by hand.

**Contents**

| Figure | Question it answers | Script |
|---|---|---|
| [WAA / WAR](#waa-and-war) | How many wins was he worth over a season? | `sleeper_war.py` |
| [VoWP](#vowp) | How much better than the waiver wire? | `sleeper_war.py` |
| [Team win probability](#team-win-probability) | Who was favoured in this matchup? | `week_odds.py` |
| [Playoff WPA](#playoff-wpa) | How much did he swing a playoff game? | `playoff_wpa.py` |
| [Win share](#win-share) | How much of a playoff win was his? | `playoff_wpa.py` |
| [MVP and MVP+](#mvp-and-mvp) | Who won the postseason, and how great was it? | `playoff_wpa.py` |
| [Playoff WAR](#playoff-war) | Who produced in the playoffs, win or lose? | `playoff_war.py` |
| [Projections](#projections) | What will he be worth over 3 years? | `project_war.py` |
| [DVI](#dvi-dynasty-value-index) | What is he worth in a dynasty trade? | `blend_values.py` |
| [CVI](#cvi-contender-value-index) | What is he worth for THIS season? | `contender_index.py` |
| [Bridge A / Bridge B](#pick-values-bridge-a-and-bridge-b) | What is a draft pick worth? | `pick_value.py`, `value_bridge.py` |
| [Franchise players](#franchise-players) | Who was a real starter, repeatedly? | `franchise_players.py` |

---

## WAA and WAR

**Owner:** `scripts/sleeper_war.py` · **Scope:** regular season only

The foundational figure. WAR is *wins above replacement*: how many wins a
player added compared to the best player who was freely available.

**1. The startable pool.** Each week, every rostered player (plus every scored
NFL player from the stats feed, so free agents count) is ranked by points and
slotted into the league's total starting lineup — for a 12-team
QB/2RB/3WR/TE/FLEX/SF league that is 12 QB, 24 RB, 36 WR, 12 TE dedicated
slots, then the best remaining fill 12 SUPER_FLEX and 12 FLEX by actual points.
So "is WR48 better than RB25?" is settled by the data each week, not by a rule.

**2. Two baselines, per position, per week.**

- *Average starter* — the mean points of everyone who made the pool at that position.
- *Replacement* — the best player at that position who was left **out** of the
  pool. The genuine next man up once every flex is filled.

**3. Points become wins, week by week.** Adding X points to an average team
changes its win probability by `Φ(X / (σ_week·√2)) − 0.5`, where `σ_week` is
the spread of team scores *in that week*. The opponent is an independent draw
from the same distribution. This is why a 30-point game in a low-scoring week
is worth more wins than the same game in a shootout.

```
WAA = Σ weekly win shift vs the average starter at his position
WAR = Σ weekly win shift vs replacement level
```

**What it deliberately ignores.** Whether the player was actually started, and
whether his team won. WAR is production against a market-wide baseline, not
credit for outcomes.

**Where it breaks down.** It needs a full season of league-wide scoring to
build honest baselines, which is exactly why it does not extend to the
postseason — see [Playoff WAR](#playoff-war).

## VoWP

**Owner:** `scripts/sleeper_war.py`

Value over *waiver* player: the same win-shift conversion, but the baseline is
the 3rd-best unrostered player at the position (`WAIVER_RANK = 3`) rather than
replacement level. It answers "how much better than what I could have just
picked up?" — a harsher bar than WAR in a shallow league, softer in a deep one.

Blank for seasons pulled before the full-NFL stats feed existed, because
without it the unrostered pool cannot be seen at all.

---

## Team win probability

**Owner:** `scripts/week_odds.py` · **Output:** `data/<season>/odds.json`

The pregame line for every matchup, played or upcoming.

Each starter is modelled as a normal distribution. Team score is the sum of
nine independent starters, so

```
P(A beats B) = Φ( (μA − μB) / √(σ²A + σ²B) )
```

**The mean is form shrunk toward his projection.** A starter's mean is his own
weekly scoring so far, pulled toward *his Sleeper projection* — not toward his
position's average — at a rate set by how many games he has played
(`shrink()`, prior strength 4 games). Week 1 is pure projection, roughly half
and half by week 4, mostly form by week 10.

That ordering was measured against 2022–25, not assumed. With a perfect
projection standing in (each player's true season average — a ceiling no real
projection reaches):

| Weeks | Form only | Projection as prior |
|---|---|---|
| 1–4 | log loss 0.678, acc 51.0% | 0.637, **58.3%** |
| 5–9 | 0.629, 65.0% | 0.618, 65.0% |
| 10–14 | 0.552, 71.7% | 0.536, 73.3% |

The entire gain is early — four games of history is mostly noise, and a
form-only model was a coin flip through week 4. Variance always comes from
positional form, because a projection is a point estimate with no spread.

**Strictly pregame.** Week W uses weeks 1..W−1 only, positional priors
included. A team that went on to win week 9 does not get to have known that in
week 9's line. This is what makes an upset legible after the fact.

**Calibration**, 2022–25: favourites win 64.4%; predicted 30% came in at 29%,
60% at 61%, 70% at 71%.

**Where it breaks down.** Sleeper only serves *current* projections, so pricing
a past week needs the projections as they stood then. `--snapshot` archives
them weekly into `proj_history.json`; seasons before that existed fall back to
a positional prior, and week 1 of those seasons is left unpriced entirely
rather than printing a meaningless 50%.

---

## Playoff WPA

**Owner:** `scripts/playoff_wpa.py` · **Scope:** elimination games only

WAR does not extend to the postseason: it needs a replacement baseline from
league-wide weekly scoring and wins that are fungible across a long schedule.
Three single-elimination weeks have neither, and half the league is in a
consolation bracket where lineups stop being set.

WPA sidesteps all of it by working **inside one matchup**, never needing a
league-wide anything.

**1. Pregame distribution.** Each starter's mean and sd from his regular-season
weeks, shrunk toward a positional prior.

**2. The baseline.** The opponent's *final score* is taken as known, and we ask:
given these nine starters' form, what was the chance of clearing that number?
Conditioning on the opponent's actual score is what makes the allocation exact
— with the opponent left as a distribution, the values sum to the wrong total
and need a rescale that explodes when the total is small.

**3. Shapley allocation.** A player's WPA is his Shapley value on that win
probability: averaged over every order the nine results could have arrived in,
how much did revealing his score move the number? Exact, not sampled — nine
starters is 2⁸ = 256 subsets each.

**Why Shapley.** It is *efficient*: every player's WPA in a game sums exactly
to `(1 if won else 0) − pregame P(win)`. The game's entire swing is allocated
to the players who caused it. Nothing invented, nothing lost. Asserted in code,
not assumed.

**Two things fall out for free.** Position neutrality — a superflex QB's 25
points is expected and adds almost nothing, while a TE's 25 is a huge residual,
so the award stops going to quarterbacks by construction. And leverage — 30
points in a blowout adds ~0 because the win was already banked.

**Where it breaks down.** WPA can only hand out what was in doubt. A side that
led a rout from the first snap has almost no probability left to allocate, so a
dominant line in a blowout earns close to nothing — which is precisely why
[win share](#win-share) exists.

## Win share

**Owner:** `scripts/playoff_wpa.py`

Playoff value in **units of wins**. Each elimination game hands out exactly
**1.0** to the side that won it and **0.0** to the loser, so a player's total
reads literally — "he accounted for 1.4 of his team's 3 playoff wins" — and a
champion's nine starters sum to exactly the number of games they won: 3.0 when
they came through the quarterfinals, 2.0 when a bye carried them to the
semifinal. Asserted in code, per season.

**How the 1.0 is divided** — half by *leverage*, half by *production*
(`PRODUCTION_BLEND = 0.5`):

- **Leverage** — each starter's positive Shapley WPA.
- **Production** — each starter's points over positional replacement, the same
  baseline [Playoff WAR](#playoff-war) uses.

Pure leverage under-credits a rout, for the reason above. Pure production
overcorrects: with leverage gone, a comfortable win and a one-point semifinal
miracle pay the same, and the 2023 race collapsed to a dead tie. Half and half
keeps both claims live.

Both components use positive values only. A negative contribution cannot be a
negative share *of a win that still happened*, so those players take 0.0 rather
than a debt — their negative WPA is reported separately. If nobody was positive
(every starter under water, carried by the opponent's collapse), the win splits
evenly, because it still has to land somewhere.

## MVP and MVP+

**Owner:** `scripts/playoff_wpa.py`

Both are the round-weighted win share, on two different scales.

**Round weights.** A bye means the top seeds play one fewer game, and a
championship is not a quarterfinal:

```
quarterfinal 1.0    semifinal 4/3    final 2.0
```

The final is worth double a quarterfinal and half again a semifinal. An earlier,
flatter set (1 / 1.25 / 1.5) produced a 2023 MVP who never played in the final.

**Two scales, because one number cannot answer both questions.**

```
MVP  = 100 × weighted win share / THAT SEASON'S best run
MVP+ = 100 × weighted win share / the AVERAGE MVP-winning run
```

- **MVP** is within-year. The season's winner is always 100 and everyone else
  is a share of him. This is what makes the per-week MVP points readable —
  they are points out of a shared 100, and they sum exactly to the season score
  (the total is computed *as* their sum, so the row always adds up).
- **MVP+** is across-year, on the OPS+ pattern. 100 is a typical MVP-winning
  run, so 122 beat the average champion's best player and 72 was a thin year.

A single historical scale forced the season figure to lie about one of the two
— a thin year's winner reading 44 when he did, in fact, win it. Splitting them
lets both be true.

| Year | MVP winner | MVP | MVP+ |
|---|---|---|---|
| 2022 | George Kittle | 100.0 | 80 |
| 2023 | James Conner | 100.0 | 122 |
| 2024 | Brian Thomas | 100.0 | 72 |
| 2025 | Bijan Robinson | 100.0 | 126 |

**Where it breaks down.** Neither figure can go negative, because win share
cannot. The "who cost them" ranking reads raw WPA instead, which is signed. And
MVP+ rebases as seasons are added — a future run that beats the current best
rescales the history.

## Playoff WAR

**Owner:** `scripts/playoff_war.py`

The one playoff figure **not** conditioned on the result: points above what a
replacement-level player at the same position scored that week, converted to
wins. Credited win or lose.

It exists because every other playoff figure pays a loss nothing. Davante Adams
put up the biggest single contribution in the 2023 final and scores zero win
share, because his team lost it. In 2023, Breece Hall and Josh Allen produced
real WAR with 0.00 win share — their team lost every game it played.

This is the true analogue of basketball's Win Shares (production against a
replacement baseline, converted to wins by an exchange rate), where the other
playoff figures are closer to WPA.

**Two departures from the regular-season engine:**

1. **Sigma is imported from the regular season.** The points-per-win rate comes
   from the spread of team scores, and in playoff weeks the consolation
   bracket's unset lineups score low and inflate that spread — which quietly
   makes every marginal point worth *fewer* wins. Measured: 2025 week 15 read
   σ 41.4 against a regular-season 29.3, so an in-week rate would have
   discounted every quarterfinal by roughly a third.
2. **Elimination games only.** No placement games, no consolation bracket.

**Replacement level needs no correction** — `build_week` reads the player pool
and never anyone's lineup, so a team benching its stars cannot move it.

---

## Projections

**Owner:** `scripts/project_war.py` (model fit by `aging_curves.py`)

Three-year forward WAR per rostered player.

1. **Level** — a recency- and games-weighted per-13 rate over the last three seasons.
2. **Shrink to draft capital** — `level = w·realized + (1−w)·prior`, with
   `w = depth/(depth+K)`. A rookie leans on pedigree; a proven veteran ignores it.
3. **Age forward** — `next_rate = a + b·level` per position/age bucket, rolling
   each projected rate back into the level so the prior fades as seasons accrue.

**Three streams**, each with p20/p80 bands:

- **Natural** — the rate, i.e. a full healthy 13-game season.
- **Composite** — natural blended with Sleeper's year-1 projection aged along
  the natural decay shape (80/20 year 1, 50/50 year 2, 20/80 year 3).
- **Expected** — natural × availability, i.e. discounted for injury.

Composite carries **no** injury discount; only `expected` does.

## DVI (Dynasty Value Index)

**Owner:** `scripts/blend_values.py` · **Output:** `data/dvi.json`

An ensemble trade rating in the spirit of passer rating: each signal is clamped
into a meaningful range (below a floor earns no credit, above a ceiling earns
no extra), then weighted and summed — so no single flawed signal dominates and
separation comes from excelling across all of them.

```
DVI = 0.50 × market  +  0.50 × non-market
      market     = KTC + FantasyCalc
      non-market = projected WAR (1.0), roster% (1.0), start% (1.2)
```

`MARKET_SHARE = 0.50` makes it a genuine second opinion rather than a KTC echo.

**start% is the subtle one.** It blends the crawl's season average with the
current snapshot on a schedule that trusts the snapshot early (when data is
thin) and shifts to the season average by week 8, so one injured week never
tanks a value. Injured-flagged players skip the start component entirely while
the snapshot still dominates.

## CVI (Contender Value Index)

**Owner:** `scripts/contender_index.py` · **Output:** `data/cvi.json`

DVI's opposite number: what a player is worth over **one** season.

```
CVI = 0.50 × FantasyPros ECR  +  0.50 × non-market
      non-market = projected WAR (1.0), roster% (0.4), start% (1.4)
```

ECR is a *redraft* consensus and therefore already scoped to this year.

**The consequence that matters: no age channel.** DVI inherits a youth premium
through KTC and FantasyCalc; CVI has no way to see a birthdate. A 29-year-old
who is a top-5 player this season reads like a top-5 player.

**Known open question.** Team-level CVI barely differs from team-level DVI —
the two diverge sharply per player but rank *teams* almost identically.

## Pick values: Bridge A and Bridge B

**Owners:** `scripts/pick_value.py`, `scripts/value_bridge.py`

Two independent routes to what a rookie pick is worth, blended by sample
confidence and pick maturity.

**Bridge A — empirical.** What picks at each slot have *actually* returned:
~1.5 million rookie picks across a crawled corpus of 12-team superflex leagues
(classes 2019–2025), every season calibrated to this league's WAR scale. A player-season with no source
is skipped, not zeroed — but a player who is out of the league is a real 0.0.

- `picks` — every slot 1.01–4.12 individually.
- `bands` — Early/Mid/Late tiers per round (picks 1–4 / 5–8 / 9–12), larger samples.
- `hit_rate` — share of picks returning ≥ 1.0 WAR over their first three seasons.
- `out_rate` — share out of the NFL **for good** by year k (no trace in year k
  or any later observed season, so it's cumulative). Published only for years
  ≥ 4 draft classes deep; deeper years are class-thin survivor noise.

A year-since-draft column publishes only once *every* slot clears its round's
observation bar, so a published column is honest everywhere on the board.

**Bridge B — market-implied.** An isotonic (monotone) regression fit from
market value to projected 3-year composite WAR, applied to the market's own
pick values. Position-agnostic on purpose: picks have no position, so the
bridge must not either.

---

## Franchise players

**Owner:** `scripts/franchise_players.py` · **Scope:** `nfl_history/waa_war_<season>.csv`, 2012 onward

A **franchise player** cleared his position's bar in at least **three separate
seasons**. Seasons need not be consecutive.

| Position | Bar | Its rank-12 season value |
|---|---|---|
| QB | 1.00 | 1.003 |
| RB | 0.70 | 0.693 |
| WR | 0.85 | 0.845 |
| TE | **0.50** | 0.290 |

The bars are position-specific on purpose. A flat 1.0 WAR test returns 23 QBs
and 5 TEs, which measures the shape of the positions rather than the players
inside them. Three of the four sit at their position's twelfth-rank season
value, so "franchise" means the same thing at each: a genuine starter, three
times over.

**Tight end is a judgement, and is documented as one.** At its rank-12
equivalent of 0.29 the bar admits fringe starters, and no threshold produces a
QB-comparable count — the position averages 0.034 WAR by TE20 and is negative
by TE22, so the players simply do not exist. 0.50 is set where the admitted
players are ones a manager would actually have wanted. It returns 14 against
23–25 elsewhere. **That gap is the finding, not an artefact to tune away**:
tight end produces roughly half as many franchise players as any other
position, and one of them (Kelce, 11 qualifying seasons) accounts for more than
the bottom five combined.

### Position is current-state, and applied to every season

`nfl_history.py` reads one position per player from nflverse's players table —
whatever he is listed as now — and uses it for his whole career. Nothing in the
output reveals this: **no player in the corpus ever changes position.**

It is not only a label. `pos` drives `score_row()`, which applies the TE
premium, and the pool a player is ranked inside, which sets his replacement
baseline. A player whose eligibility changed is therefore *scored* and *pooled*
under his final role for every season he ever played.

The measured scale is small. Nine of 914 players disagree between nflverse and
Sleeper (1.0%), and only one of those ever cleared 0.5 WAR. Correcting the one
case that reached a published table — Jordan Matthews, a WR through 2016 who
finished his career listed at TE — moves TE6 by −0.015 and TE12 by −0.009
across 2012–2025, and moves TE1 and TE3 not at all.

Known cases are corrected at the source in `nfl_history.POS_OVERRIDE`, which is
season-ranged so a correction reaches scoring and pooling, not just the CSV
label. Two kinds of entry live there:

- **Corrections.** Matthews is WR through 2016, then falls back to the source.
- **Pins.** Taysom Hill and Logan Thomas are fixed at TE because that is the
  eligibility the league actually scores, whatever they line up as. Pinning
  players whose sources already agree stops a future nflverse reclassification
  from silently rewriting their history.

Deliberately **not** overridden: Cordarrelle Patterson and Ty Montgomery were
genuinely startable at two positions for years. Either label is defensible and
choosing one would assert precision the data does not have.

The limitation that remains: for any player whose eligibility changed and who
is not in the override map, the whole career is scored under today's label.
The live league data uses the same current-state rule, so the two sets agree
with each other — but a reader comparing a 2014 tight end list against
contemporary reality will find names that were never tight ends.

An override only takes effect on a rebuild: `nfl_history.py` regenerates
`waa_war_<season>.csv`, and every figure downstream of it moves with them.

---

## Conventions that hold everywhere

- **Nulls are em dashes, never zero.** A rookie class that has not played
  returns `—`; `0.00` would read as "returned nothing".
- **Signed values** use `+` / `−` (U+2212), coloured, neutral within ±0.005.
- **Indices (DVI, CVI, MVP) are never metered.** They are already normalised
  0–100; a bar restates the number.
- **No lookahead, anywhere.** A figure describing week W is built from data
  available before week W.
- **Rows add up.** Where a table shows components and a total, the total is
  computed as the sum of the displayed components, not rounded separately.

## Verifying any of this

The methodology decisions above are locked by the test suite — a failure there
is a change in what a figure *means*, not a broken build:

```
python -m unittest discover -s tests      # the invariants
python scripts/validate_data.py           # published-data consistency
```

The suite reports its own size; there is no target number to hit. A handful of
tests are gated on a local Sleeper dump and are skipped everywhere else,
including CI — see the testing section of PROJECT_NOTES.md.

Each engine also has a `--probe` mode that reports without writing:

```
python scripts/playoff_wpa.py --probe
python scripts/playoff_war.py --probe
python scripts/week_odds.py  --probe
```

The two playoff probes read the raw Sleeper dump in `sleeper_data/`, which is
gitignored — on a fresh clone they exit with "players.json missing" and report
nothing. Run `python scripts/sleeper_pull.py <league_id> --players` first, or
point `--raw` at an existing dump. `week_odds.py --probe` is the exception: it
prices played weeks straight out of committed `data/`, so it works anywhere
(only the projected-lineup half needs `league.json` from a dump).
