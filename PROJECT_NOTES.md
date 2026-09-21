# Big Dog Dynasty WAR Board — Project Notes

Context doc for new work sessions. Read this first. Refreshed 2026-09-21
against the **working tree on top of `f7f80aac`** (a large audit-and-fix
session is uncommitted; this file describes the tree, not HEAD). The
per-session handoffs in `scratch/` (gitignored) carry the decision trail.

## What this is

A self-updating stats and valuation site for Sleeper leagues. Home league is
**Big Dog Dynasty** (12-team superflex dynasty, run by Max / Sleeper username
`mawxy`, user_id `471740157079318528`): 2022 (startup) → 2026, chained via
`previous_league_id`. **Pineapple Pizza FFL** (12-team redraft, 2023 →) runs
on the same pipeline with reduced coverage (see Multi-league).

- **Live site:** https://www.bigdogdynasty.app (Pages custom domain;
  `public/CNAME` holds the apex `bigdogdynasty.app` — see caveats)
- **Repo:** https://github.com/Mawxy/big-dog-dynasty (branch `main`)
- Big Dog scoring: PPR + 0.5 TE premium, superflex (QB/2RB/3WR/TE/FLEX/SF),
  taxi + IR, FAAB $100, 6-team playoffs starting week 15, trade deadline
  week 12.
- Every published figure is explained in `METHODOLOGY.md`; each engine's
  docstring is the deeper reference.

## Multi-league layout

`data/leagues.json` is the registry: `default`, and per league `key`,
`alias`, `name`, `kind`, `seasons`, `latest`, `rosterSeason`,
`currentLeagueId`, `chain`. A league is keyed by its **founding** league_id
(`scripts/leaguepaths.py`) because Sleeper mints a new id every season.

| League | Key (founding id) | Alias | Current-season id (in `data-refresh.yml`) |
|---|---|---|---|
| Big Dog Dynasty | `814608002207334400` | `big-dog` | `1312221243742621696` (2026) |
| Pineapple Pizza FFL | `1001613650664165376` | `pineapple-pizza` | `1382780734728597504` (2026) |

**September ritual:** both current-season ids are hand-edited in
`data-refresh.yml` when Sleeper creates the new season. A missed update fails
quietly — history keeps working, the site never gains the new season. Since
2026-09-10 it also costs LIVE SCORING: the beta League screen reads
`league.chain[rosterSeason] ?? league.currentLeagueId` out of the registry and
calls Sleeper with it, so a stale id means no in-progress week on the site.

`leaguepaths.DataDir` routes a filename either to `data/<file>` or to
`data/leagues/<key>/<file>`, and `GLOBAL_FILES` is the explicit list of the
former: `leagues.json`, `values*.json`, `ecr.json`, the crawl corpora and
state, `benchmarks.json`, `slot_values.json`, `tep_map.json`. Anything
unlisted is league-scoped — including `dvi.json` and `value_bridge.json`,
because they derive from that league's projections. Three scripts write under
`data/` WITHOUT going through `DataDir` and so are not in that list:
`dynasty_movers.py`, `espn_ids.py` and `vig_model.py`.

**Pineapple Pizza coverage is pull → WAR → build only.** No projections,
indices, drafts, trades, odds, usage, bracket or shards — every downstream step
defaults to Big Dog. `src/lib/caps.ts` derives that from the registry (is this
`leagues.default`? is `kind` dynasty?) so a screen built on a file this league
never produces renders **"Not published for this league."** instead of a
permanent `Loading…`.

## Architecture

```
Sleeper API ──> scripts/sleeper_pull.py ──> sleeper_data/  (+ sleeper_data_pizza/)   gitignored
                scripts/sleeper_war.py  ──> sleeper_data/analysis/*.csv
                scripts/build_site_data.py ──> data/leagues/<key>/
                    <season>/{summary,weekly,teams,matchups,byes,absence,nfl_teams,bracket}.json
                    players_min · ownership · franchises · picks_owned · meta .json
                    data/leagues.json
                pick_value.py      ──> pick_values.json          (Bridge A)
                draft_analysis.py  ──> drafts.json
                playoff_wpa.py / playoff_war.py ──> <season>/bracket.json (wpa, war)
                season_wpa.py      ──> <season>/winshare.json    (regular-season win share)
                fetch_projections.py ──> proj_sleeper.json, proj_sleeper_history/<yr>.json
                week_odds.py --snapshot ──> <season>/odds.json, <season>/proj_history.json
                project_war.py     ──> projections.json           (scalar arm)
                project_points.py --site ──> projections_scalar.json (the scalar arm, parked)
                                             projections.json       (REWRITTEN: points-first)
                                             projections_points.json
                value_bridge.py    ──> value_bridge.json          (Bridge B)
                project_war_knn.py --space hybrid ──> projections_knn_hybrid.json  (analog)
                project_matrix.py  ──> projections_matrix.json    (EIGHT curves + meta.inseason)
                trade_analysis.py  ──> trades.json, trade_snapshots.json
                nfl_features.py    ──> nfl_history/features_<Y>.csv, features_weekly_<Y>.csv
                usage_stats.py     ──> <season>/usage.json
                shard_players.py   ──> player/<pid>.json          (~800 shards)
                index_models.py    ──> dvi.json, cvi.json, index_models.json
                validate_data.py                                  gate
                                                     │
src/ (Vite + React 18 + TypeScript, HashRouter) ─────┴──> GitHub Pages

shared rules:   scripts/seasons.py   which season is FINISHED (every arm seeds off it)
                scripts/inseason.py  how much of the roster season is banked
                scripts/curves.py    the eight curve names + the year-1 lookup

nflverse ──> scripts/nfl_history.py ──> nfl_history_data/ (gitignored)
             └─ same sleeper_war.py engine ──> nfl_history/*.csv 2012+ (committed)
                                               nfl_history/early/ 1999-2011 WAR, 1999-2013 features
             nfl_features.py  ──> nfl_history/features*_<yr>.csv
             aging_curves.py  ──> nfl_history/aging_curves.json   (hand-run)
             espn_ids.py      ──> data/espn_ids.json              (headshot id join)
             vig_model.py     ──> data/vig_model.json             (hand-run, one-time fit)

sleeper_crawl.py (signals / trades / drafts / outcomes, sharded) ──> data/*_signals.json, corpora
merge_trade_corpus.py + dynasty_movers.py ──> data/dynasty_movers.json, data/recent_trades/<0..31>.json
benchmarks.py ──> data/benchmarks.json
fetch_values.py / fetch_ecr.py ──> data/values.json, values_history.json, ecr.json
```

- **The front end reads `data/**/*.json` — with ONE exception.** Boot loads
  `data/leagues.json`, resolves the league from the first hash segment, then
  `meta.json` + `players_min.json`; cache-busting is `?v=<meta.updated>`, not a
  build id (a build id changed the JS hash ~30×/day on crawl commits). The
  exception is **live scoring** (`src/lib/liveScores.ts`, 2026-09-10): while a
  week is in progress the beta League screen calls Sleeper
  (`/v1/league/<id>/matchups/<week>`) and ESPN's public scoreboard directly. One
  poller drives both feeds, and since 2026-09-21 it has a stop condition (the
  NFL scoreboard knows whether the week has started or finished), backoff, a
  fetch timeout + abort on unmount, one chain across visibility changes, and no
  stale frame across a league/week change.
- **Per-player shards.** `player/<pid>.json` carries projection, Sleeper
  projection, matrix row + `blend_w`, usage rows, `banked`/`gp` + the in-season
  block, and the kNN subset with comparables, so a player page pulls ~2 KB
  instead of ~1.6 MB. Sharding runs **last** in the projection chain so a shard
  never pairs last night's curves with tonight's scalar. Written atomically per
  shard, pruned last.
- **`insights.json`** (per-team verdicts on the league home and franchise
  pages) **has no producer.** Hand-written 2026-07-20 from preseason
  projections and hand-edited once since (commit `fb5463c6`, 2026-09-08).
  Decide: script, preseason ritual, or remove the band.
- **Index loaders are cache-keyed per league + season list** (`data.indexKey`) —
  honors, career, teamHonors, records, postseason, winshare, weekpoints, usage.
  The module-level promise used to be keyed on nothing, so whichever caller
  mounted first decided what the others got (League asks for played seasons,
  the franchise page for all of them).

## GitHub Actions

Eleven workflows. Every committing job **re-parents** (fetch → mixed-reset
onto `origin/main` → stage own paths → commit → push; never rebase — a
regenerated file conflicts identically on every retry) and stages an
**explicit allow-list**. Canonical reasoning lives in `crawl-signals.yml`.

**Crons moved off the hour (2026-09-21).** Every workflow used to fire at
`:00`, which is the most congested slot in all of Actions; the nightly was
observed starting four to six hours late. Each workflow now owns a distinct
minute; the hours are unchanged.

| Workflow | Cron (UTC) | Concurrency | Runs | Commits |
|---|---|---|---|---|
| `data-refresh` | `17 6 * * *` daily | `data-push` | tests (stdlib only, before any pip) → date-keyed DAILY player map → pull Big Dog → WAR → build → pull/WAR/build Pizza (fail-soft) → pick_value → draft_analysis → playoff_wpa → playoff_war → season_wpa → fetch_projections (fail-soft) → week_odds --snapshot → project_war → `pip install -r requirements-ci.txt` (fail-soft) → project_points --site (fail-soft + restore) → value_bridge → project_war_knn --space hybrid → project_matrix (fail-soft + restore) → **trade_analysis** → nfl_features (roster season) → usage_stats → shard_players → index_models → validate_data | `data/leagues`, `data/leagues.json`, `data/values.json`, `nfl_history/features_*.csv`; a guard fails the run if any crawl-owned path is staged; calls `deploy` |
| `values-refresh` | `23 11 * * *` daily | `data-push` | fetch_values → fetch_ecr (fail-soft + warning) → value_bridge → validate_data --values-only | `data/values.json`, `values_history.json`, `ecr.json`, `data/leagues/*/value_bridge.json`; calls `deploy` |
| `war-history` | manual (`start`/`end`, defaults **1999–2025**) | `data-push` | validate range → nfl_history → sleeper_war → nfl_features → collect (`early/` split) | `nfl_history/` (whole-dir add) |
| `players-refresh` | `38 5 * * 2` Tuesdays | `data-push` | `sleeper_pull --players-only` → cache save → `espn_ids.py --no-patch` (fail-soft) | `data/espn_ids.json` |
| `deploy` | push to `main` minus `paths-ignore`, manual, `workflow_call` | `pages-deploy` (job-level, cancel-in-progress) | **Node 22** → `npm ci` → typecheck → build → `cp -r data dist/data` → strip pipeline-only files → Pages | nothing |
| `tests` | push to `main`, PRs | none | Python 3.12 unittest with `EXPECTED_SKIPS=8` pinned; Node 22 typecheck + `npm test` | nothing |
| `crawl-signals` | `11 0,6,12,18 * * *` | `crawl-signals` | `sleeper_crawl --mode signals` (the only discoverer) | `league_signals.json`, `crawl_leagues.json` |
| `crawl-signals-redraft` | `29 3,9,15,21 * * *` | `crawl-signals-redraft` | same, `--league-type redraft`, seeded from Pizza | `league_signals_redraft.json`, `crawl_leagues_redraft.json` |
| `crawl-drafts` | `47 2,8,14,20 * * *` | `crawl-drafts` | `--mode drafts`, walks chains back to 2019 | `draft_signals.json`, `draft_index.json`, `rookie_pick_corpus.json` |
| `crawl-trades` | `13 1-23/2 * * *` | per shard + `crawl-trades-movers` | 4 shards → artifacts → `movers` job: merge_trade_corpus → dynasty_movers | `dynasty_movers.json`, `recent_trades/*.json` (per-player 7-day trades, bucketed by pid — the player page's Recent trades section), `tep_map.json`; calls `deploy` (a `GITHUB_TOKEN` push never triggers `on: push`) |
| `crawl-outcomes` | `7 3,15 * * *` | per shard | 4 shards → artifact rows + committed counters → benchmarks.py (warn-only) | `outcome_signals_<n>.json`, `benchmarks.json` |

Notes that bite:

- **Four pipeline jobs share `data-push`** — `data-refresh`, `values-refresh`,
  `war-history` and `players-refresh` (which now commits `espn_ids.json`). The
  group is also what ORDERS them: the clock only staggers the starts and a
  congested queue can reorder that. `data/values.json` has two writers
  (`fetch_values.py` creates it, `value_bridge.py` writes `impWar`/`modelWar`
  back) in two workflows; both are in the group, which is why it is safe.
- The crawls deliberately do **not** join `data-push`: a five-hour crawl
  holding it would block the nightly. They absorb push races in their own
  fetch / re-parent / retry loop.
- **The nightly's mid-chain steps are fail-soft with a RESTORE**, not just
  `continue-on-error`. `project_points --site` and `project_matrix` rewrite
  files every later step reads, and both can now genuinely fail (the points
  model exits non-zero when it rewrote nothing; the matrix on a broken seed
  mismatch). On failure the workflow `git checkout --`s `projections.json` /
  `projections_points.json` / `projections_scalar.json` /
  `projections_matrix.json`, so the rest of the chain prices off yesterday's
  numbers — one day stale but internally consistent — and `validate_data` still
  gates the commit. Third-party Python is pinned in `requirements-ci.txt`
  (scikit-learn, numpy, scipy, joblib, threadpoolctl, narwhals, nflreadpy,
  polars); an unpinned `pip install scikit-learn` took the nightly out for
  three days in week 1.
- **`trade_analysis` now runs AFTER the projection chain** (2026-09-21): it
  reads `projections.json` for `future`, the projected draft slots and the
  frozen-once `exp` snapshot, and that file is not final until
  `project_points --site` rewrites it. At its old slot it priced tonight's
  rosters against yesterday's projections and froze the skew.
- **The player map is fetched at most once a day**, by a DATE-KEYED cache
  shared between `data-refresh` and the `crawl-trades` movers job (identical
  key `players-nfl-daily-<UTC date>`; both run on `main`, so one fetch serves
  both). `players-refresh` still saves a weekly copy, but that is now only the
  last-resort restore prefix — its real job is the ESPN id join. Before
  2026-09-21 the nightly read the weekly cache: in-season `injury_status` up to
  seven days old, a mid-week addition outside the WAR pool for a week.
- `deploy.yml`'s `paths-ignore` list and its strip step must be kept in
  lockstep (the yml says so). The strip list now also covers `espn_ids.json`,
  `projections_knn.json`, `projections_scalar.json` and `proj_sleeper_history/`
  — each verified to have no `fetch` in `src/`. **`trade_corpus*` /
  `outcome_corpus*` do NOT ship and never did** (both gitignored, so a CI
  checkout never has them); the old note claiming they ship, and its "16.4 MB"
  figure, were wrong — `data/` is ~50 MB. Deliberately NOT stripped:
  `projections_points.json` and `<season>/proj_history.json`, both NAMED in
  `src/` (types.ts, caps.ts), so a reader may be intended.
- `war-history.yml` defaults to **1999–2025** and now VALIDATES the range: an
  `end` at or past the in-progress season is refused (a season is complete in
  March of the following year) because `project_points.py` would fit a partial
  `waa_war_<yr>.csv` as a full season; a `start` later than 2012 warns (the
  played rule changes at 2012, when snap counts begin). The collect step files
  pre-2012 WAR and pre-2014 features under `nfl_history/early/` — only
  `project_points.py` reads those; every other reader globs the snap era.
  `aging_curves.py` is in no workflow: a corpus rebuild does not refit the
  curve (open item).
- Pages source is **GitHub Actions** (not branch).

### The gate: `validate_data.py`

Floors catch the silent-empty class (a script that exits 0 with gutted output).
The 2026-09 additions are about AGREEMENT instead, because 09-15 cleared every
floor. `check_projection_coherence`: every projection file must name the same
seed and the same year one, year one = seed+1, the seed must be
`seasons.last_completed_season`, and year one must be the roster season or one
past it (a window, not an equality — between the title game and September's
rollover year one legitimately leads the roster season).
`check_points_model`: when `projections.json` is the points model's it must
state how many rows IT priced and the count must be true, because a run that
fit nothing still writes a full-shaped file. `check_matrix`: the published
curve list must equal `curves.CURVES` (not a hardcoded six), every curve
`horizon` non-null numbers in range. `check_inseason`: the fraction in [0,1]
and equal to `(reg−played)/reg`, the week count and `reg_weeks` matching that
season's `matchups.json`, no row missing `banked` — absent is normal and
passes. `check_current_season_features`: floors and no null cells on the roster
season's `usage.json` (`usage_players` 100, observed 354) and `winshare.json`
(50 / 108), skipped before the season has a scored week and for a league that
produces neither. `check_record_vs_matchups`: `teams.json` W+L+T must equal the
scored regular-season weeks in `matchups.json` — the two land out of step
mid-week, and WAR is summed off one while the record is read off the other.
Older: `check_index_models` (curves must not collapse into one), `check_odds`
(priced-week floor), and the floors themselves.

### Hand-run scripts (no workflow)

`aging_curves.py` (curve fit; production-weighted default), `vig_model.py`
(one-time nflverse moneyline-hold fit → `data/vig_model.json`, read by the beta
League screen's moneyline; falls back to a flat −110 when absent),
`backtest_curves.py` (walk-forward grading of the four NATURAL curves; writes
to the gitignored `bt/`), `probe_sleeper_vintage.py` (is a past season's
Sleeper projection a preseason forecast or a backfill? — the question that
decides whether composites are ever gradeable), `slot_value.py` (needs
artifact-only outcome rows → `data/slot_values.json`),
`backfill_ktc_history.py` (KTC/FantasyCalc deep history →
`data/values_history_deep.json`, run `--probe` first), `pull_rookie_drafts.py`
(add a league's rookie drafts to `nfl_history/rookie_drafts.csv`, tagged by
`--source`), `franchise_players.py`, `make_icons.py`.

### Rebuild order (local, after a corpus change)

```
python -m unittest discover -s tests
python scripts/nfl_history.py --start 1999 --end 2025 --out scratch/hist_new   # nflreadpy; local only
python scripts/sleeper_war.py --data scratch/hist_new --top 10
python scripts/nfl_features.py --start 1999 --end 2025 --out scratch/hist_new/features
# copy: waa_war_<2012+> and features_<2014+> to nfl_history/, the rest to nfl_history/early/
cp scratch/hist_new/players_meta.csv nfl_history/
python scripts/aging_curves.py
python scripts/project_war.py
python scripts/project_points.py --site
python scripts/value_bridge.py
python scripts/project_war_knn.py --space hybrid
python scripts/project_matrix.py
python scripts/trade_analysis.py
python scripts/usage_stats.py --out data
python scripts/shard_players.py --out data
python scripts/index_models.py
python scripts/validate_data.py
```

## WAA / WAR methodology (settled decisions — don't change casually)

Computed by `scripts/sleeper_war.py` from `players_points` in matchup data
(already scored with league rules). Per week:

1. **Startable pool**: fill 108 league-wide slots by actual points — 12 QB,
   24 RB, 36 WR, 12 TE, then best remaining into 12 SF (QB/RB/WR/TE) and
   12 FLEX (RB/WR/TE). Flex demand is settled empirically each week.
2. **Baselines** per position per week: *average* = mean of startable at pos;
   *replacement* = best player at pos left out of the pool (weekly next-man-up,
   deliberately harsher than a fixed season-long RB25-style baseline).
3. **Points → wins**: weekly margin → win-prob shift via Φ(x/(σ_wk·√2)) − 0.5,
   using **that week's** σ of the 12 team scores (pure weekly, no blending —
   Max explicitly wants big games in low-scoring weeks to earn more).
4. Weekly shifts summed over **regular season only** (playoffs excluded;
   `--include-playoffs` flag exists).
5. **Played rule (SETTLED 2026-08-07, position-INDEPENDENT)**: **dressed =
   played, for every position**, and a dressed zero-point game accrues negative
   value. Any record beyond the bare `gms_active` placeholder (`gp`, `off_snp`,
   `def_snp`, `st_snp`, `tm_*_snp`, or a real offensive stat line) counts as
   played. A dressed player who gave you nothing is a real 0.00, not an absence.
   - Byes, game-day inactives, and IR/NFI/practice-squad (bare `gms_active`
     records) are excluded (DNP) for all positions.
   - Saved as `<season>/played/week_NN.json` by sleeper_pull; sleeper_war
     falls back to "0.00 = DNP" if played files are absent. `sleeper_pull`
     is now STRICT about the stats feed for a completed week from 2022 on: a
     null response raises instead of silently zeroing the week.
   - IMPLEMENTED in `sleeper_pull.row_played()`, mirrored in
     `nfl_history.row_played_hist()`. On nflverse inputs the counterpart to
     Sleeper's `tm_*_snp` is weekly roster ACT status.
   - Locked down by `tests/test_war_engine.py::TestPlayedRule`.
   - Decision history (kept — the rule has moved twice): an all-positions
     "participation" rule (`off_snp` only) was rejected early; **2026-07-17**
     settled a POSITION-DEPENDENT rule (QB required offensive participation;
     Malik Willis 2025 wk1, Bagent's 2024 backup weeks read DNP); 2026-07-19
     the RB/WR/TE branch gained the stat-line test; **2026-08-07** the QB
     carve-out was RETIRED — "dressing carries no signal" is an argument about
     OPPORTUNITY, and WAR measures production. Excluding backup weeks let a
     backup QB keep a per-13 rate built from two mop-up appearances, which
     was the root of the projection model pricing unproven QBs as startable.
   - Downstream consequence: `gp` now means "games dressed". `aging_curves.py`
     lost its `MIN_GP` gate to this silently and now weights by production
     (see `test_aging_curves.py`).
6. Team WAA/WAR = sum over each week's **actual starters**, not season totals
   of the current roster. Lineup WAA runs negative for most teams (measured vs
   the optimal pool) — expected, compare relatively.
7. Reference points: ~2 WAR in a 14-week season is a superstar (CMC 2025 ≈ 2);
   a 12-2 team's lineup WAA can be slightly negative — verified correct.
8. **DVI and CVI are computed under ALL EIGHT projection curves** (six from
   2026-08-13; the points-first pair joined 2026-09-11). `scripts/curves.py`
   owns the vocabulary (mirrors `MATRIX_CURVES` in `src/lib/types.ts`, locked by
   `tests/test_curves.py`) and the year-1 lookup. `index_models.py` drives
   `blend_values` and `contender_index` across all eight from ONE load and
   writes `dvi.json` + `cvi.json` on the default plus `index_models.json` with
   all eight. **Default is `blend_composite`** (points-first held it 09-11 →
   09-16). `--curve scalar_composite` reproduces the pre-matrix numbers exactly
   (393/393, locked by a test) and its own numbers now live in
   `projections_scalar.json` — `curves.py`'s fallback is per curve since
   2026-09-21, because `projections.json` became the points model's file and one
   shared fallback was answering scalar queries with points figures. Both
   indices clamp on **year-1** WAR — inherited, left alone deliberately.
   `has_analog` / `has_sleeper` are claims about the PROJECTION, never the
   figure (65 no-cohort players: identical WAR across curves, identical DVI in
   only 4).
9. **The projection model is a SITE-WIDE control** (2026-08-13). Masthead
   `ModelPicker` (two controls, not one eight-way), state in `lib/model.ts`;
   `?m=<curve>` in the URL wins over localStorage (`warboard.curve`); default
   is the absence of the param. Not accent-filled (it sits above every view).
   In the beta shell it lives on the More screen. `lib/useIndices.ts` reads
   `index_models.json` once (~180 KB) and slices it; the `dvi.json`/`cvi.json`
   and `projections.json` fallbacks are requested ONLY on the error branch.
10. **The trade machine shops one basket against many offers** (2026-08-13).
   Outgoing side pinned; each offer scored against it; deltas signed on both
   sides per currency, never combined into one verdict. A scoped exception to
   "never color a trade" (the Ledger records a fact; the machine evaluates a
   hypothetical). Math in `src/lib/tradeModel.ts`, shared with beta, locked
   by `tests/tradeModel.test.ts` (2026-08-18): consolidation utilization
   `s(v)` per currency (`u_min 0.10`; market v50 3400 / τ 1200; DVI 34 / 24;
   CVI 72 / 9 — the 108-starting-jobs ruler), adjustment shown as its own
   row, never folded into a total; WAR gets no adjustment. Picks carry an
   estimated index (`≈`) via a monotone KTC→index fit shaped by
   `value_bridge` timing (CVI kernel `[1, .35, .10]`). `dynasty_movers.py`
   copies the market curve — **keep in lockstep**.
11. **FINISH (final placing) is a SPLIT column** (2026-08-12): places 1..N
   from the winners bracket, N+1.. from regular-season standings, never the
   consolation bracket (2025's toilet-bowl winner was 1-13). Gated on a
   decided winners-bracket game. Written in `build_site_data.py`, and the same
   test is what `seasons.py` and `src/lib/seasons.ts` call "settled".
12. **Projections: Sleeper weight `BLEND_W = [0.9, 0.5, 0.1]`**, no Sleeper
   gate (`SLEEPER_GATE = "none"`; a 25-pt floor was measured and removed —
   projected WAR is production, not worth). Sleeper projections are summed
   from the **weekly** endpoint (2026-08-31), not the season product, and
   `fetch_projections.py` refuses a THIN week (`MIN_WEEK_LINES = 12` lines per
   position) rather than publishing a half-fetched slate. It also archives each
   vintage to `proj_sleeper_history/<season>.json`, which is what lets a past
   week be priced off what was known at the time.
   `composite_path()` has one home (`project_war.py`); the matrix imports it.
   No corpus→league rescale (0.9645 was indistinguishable from 1.0 on four
   seasons).

   **Points-first is the PRICING arm** (`project_points.py`, Max 2026-09-11):
   project ppg and games (gradient-boosted trees on league history + nflverse
   skill features; rookies from draft capital), then let the WAR engine's pool
   logic set that season's replacement level from the projections themselves —
   so a player's WAR moves when HIS points move, not when the twelfth-best at
   his position has a good year. `--site` parks the scalar arm at
   `projections_scalar.json`, rewrites `projections.json` in the same schema
   with `meta.engine: "points-first"`, and **exits non-zero when it rewrote
   nothing** (which is what makes the workflow's restore meaningful). Its rows
   feed the matrix's `points_*` curves, rookies included — but the default
   curve is still `blend_composite` (caveat 12).
13. **Analog model** (`project_war_knn.py`): gaussian kernel (`KERNEL_H 0.5`,
   was a quartic by accident), `MAX_DIST 1.0954`, cohort median, vanished
   analogs count as 0, `TOP_N 3` comparables with a 0–100 match score. Trust
   `1/(1+(d_med/d_ref[pos])⁴)` (halved when padded) weights the blend and
   Sleeper's leg on the analog composite (`0.25 + 0.65·(1−trust)`).
14. **Trade ledger** (`trade_analysis.py`): realized WAR while starting for
   the acquirer, one hop, `DELTA = 0.7` stream discount with pick lag;
   at-trade snapshot frozen once, enrich-only merge, and a guard that refuses
   a ledger whose newest trade predates the committed one (2026-08-21
   incident). **In-season the year-1 term of the unrealized stream is prorated**
   by `remaining = (reg_weeks − weeks_played) / reg_weeks` (2026-09-21), so the
   live season is not counted once as realized WAR and again as projection;
   published as `meta.year1_remaining`. Out of season the factor is exactly 1.0
   and the ledger is bit-for-bit what it was. Later stream years and `DELTA`
   are untouched; a future pick's first year is never the live season.
15. **Dynasty movers** (settled 2026-08-20): centerpiece attribution, a
   player's own value never deflated (consolidation is package-level only),
   per-league TE-premium ladder fetched live, KTC generic mid for picks, FAAB
   0, `--min-value 2000`, adaptive `min_n`.
16. **Owner-keyed franchises** (2026-08-31): the franchise key `fkey` is
   `roster_id` in dynasty leagues and the owner's Sleeper `user_id` in
   redraft/keeper (a redraft owner's rid varies by season). Legacy rid links
   resolve. Career owner splits cut on change-of-hands boundaries; finish and
   honors go whole to the season's primary owner (2026-09-01). `ridOf` /
   `seasonRow` in `src/lib/seasons.ts` are the one expression for "which
   franchise held roster slot N that year" — never `fr[String(rid)]`, which is
   right for Big Dog and wrong for every redraft league.
17. **EVERY PROJECTION ARM SEEDS FROM THE LAST COMPLETED SEASON** (settled
   2026-09-21, `scripts/seasons.py`). "Complete" = the winners bracket has a
   decided champion — the same test `build_site_data.py` gates FINISH on — read
   from `<season>/bracket.json` with `franchises.json` `finish == 1` as the
   fallback. Never `meta.latest`.
   **The incident.** `meta.latest` flips the moment week 1 freezes, so on
   2026-09-15 the scalar arm seeded off a ONE-GAME 2026 and published years
   `[2027, 2028, 2029]` while the analog arm stayed on 2025 → `[2026, 2027,
   2028]`; `blend_composite` averaged a 2027 number with a 2026 one under one
   heading, and every file parsed and every floor cleared. **The committed
   `data/` still carries it** (`projections.json` seed 2026,
   `projections_knn_hybrid.json` seed 2025); the next run of the fixed chain
   re-seeds to 2025. Three defences: `project_war.py`, `value_bridge.py` and
   `project_points.py` all call `seasons.last_completed_season`;
   `project_matrix.py` **exits non-zero** on a *broken* mismatch (a scalar seed
   past the last completed season, or a corpus ahead of the league) while the
   old *stale* case stays a loud warning; and
   `validate_data.check_projection_coherence` gates the commit.
18. **IN-SEASON OUTLOOK** (Max, 2026-09-21 — `scripts/inseason.py` ↔
   `src/lib/outlook.ts`, **keep in lockstep**). Year 1 of every curve is a
   FULL-SEASON figure: the right model input, the wrong thing to show a reader
   in week 4. The displayed figure is
   `outlook = banked + year1 × remaining_frac`, with
   `remaining_frac = (reg_weeks − weeks_played) / reg_weeks`. `banked` is
   realized regular-season WAR to date (`<season>/summary.json`, the column the
   stats page prints); `reg_weeks` is `playoff_start − 1` (14 for Big Dog) and
   `weeks_played` the scored regular-season weeks in that season's
   `matchups.json` — the pipeline's only definition of "played". The pipeline
   publishes the two FACTS and the browser does the arithmetic:
   `projections_matrix.json` gains `meta.inseason`
   `{season, weeks_played, reg_weeks, remaining_frac}`, every row gains
   `banked` + `gp`, and `shard_players.py` copies both onto the shard. The
   block appears only while year 1 IS the roster season and that season is
   underway but unfinished — the offseason is untouched (factor 1.0).
   **The un-prorated year 1 stays the INPUT** to DVI, CVI, `value_bridge`, the
   pick tiers and the trade machine: banked WAR has no trade value, and an index
   that shrank to it by week 14 would price every asset at nothing in December.
   The outlook is a display figure, labelled as one ("2026 outlook · 4 wks
   banked").
19. **The projected record has ONE calculation** (`src/lib/projRecord.ts`,
   2026-09-21): banked W-L-T plus Σ`wp` over the unplayed regular-season weeks
   that carry a line. There were two and they disagreed — the League home page
   summed a normal CDF over `matchups.schedule`, which holds only the weeks
   still to come, so a fourteen-game projection shrank by a game a week and
   banked wins were never added (a 1-0 team read 6.9-6.1 of thirteen). A week
   counts only once it has a `wp` (week 1 without a snapshot is deliberately
   unpriced); ties stay a third figure, never `games − wins`.

### Sleeper stats-feed signatures (probed 2026-07-17, verified on 2024 + 2025 data)

Per-week record shapes in `api.sleeper.app/stats/nfl/<yr>/<wk>?season_type=
regular&position[]=...` (and the per-player `stats/nfl/player/<id>` endpoint):

- **Played**: `gp`/`off_snp` + real stats. Either key can appear WITHOUT the
  other (a TE had `off_snp:4`, no `gp`; Chism 2025 wk18 had a catch with
  `off_snp:0`) — so test snaps OR stat line, never one alone.
- **Dressed, zero offensive snaps**: `gms_active:1` + `tm_off_snp/tm_def_snp/
  tm_st_snp`, no `gp`/`off_snp`, pos_rank 999. Under rule #5: played 0.00
  for every position.
- **IR / NFI / practice squad**: bare `gms_active:1` + pos_rank 999, no
  `tm_*_snp`. `gms_active` fires even for IR and practice-squad players
  (McCaffrey's 2024 IR weeks, Jordan Travis all of 2024) — it is NEVER a
  played signal. `tm_*_snp` presence is the dressed/not-dressed discriminator.
- **Game-day inactive / scratch / bye**: no record at all (null). This is the
  dash in Sleeper's UI (Zach Wilson all 2024, Efton Chism's 2025 scratch weeks).
- Open: 2022-era field conventions not yet spot-checked (all probes were
  2024/2025, `company: sportradar`). Pre-2019 nflverse rosters have no `INA`,
  so 2012–2018 scratches read as played 0.00 in the history corpus.

## Tests

`python -m unittest discover -s tests` (stdlib, no network) — **665 tests in
25 files**; `npm test` runs `tests/tradeModel.test.ts` (**31 tests**,
`node --test`, Node ≥ 22.18) and now carries a `lib/` section alongside the
trade maths. CI (`tests.yml`) runs both and **pins 8 expected skips** — tests
gated on `sleeper_data/` or `scratch/sample_corpus_0.json`. On Max's machine
those files exist, so the local result is 665 / 0 skipped.

| File | What it locks |
|---|---|
| `test_war_engine.py` | 108-slot pool, dedicated-before-flex, replacement = best-left-out, WAA sums to 0 per position, weekly sigma, VoWP ladder, every branch of the played rule |
| `test_week_odds.py` | pregame only; week 1 without a snapshot unpriced; `--snapshot` first-write-wins; absent from a snapshot = 0.0 in both paths; the season sim's generic bracket (any field size, clamped not crashing) |
| `test_playoff_wpa.py` | Shapley efficiency, win-share totals, round weights, MVP vs MVP+ |
| `test_playoff_war.py` | sigma imported from the regular season, elimination games only |
| `test_value_stack.py` | DVI / CVI shares and weights, Bridge B isotonic monotonicity, Bridge A board and outcome rule |
| `test_curves.py` | the eight-curve vocabulary; `scalar_composite` ≡ the old `composite[0]`; the per-curve fallback file |
| `test_projection_matrix.py` | eight curves stay eight; composite and the remaining fraction each have ONE home; the seed-mismatch verdicts (stale vs fatal); a rookie the rookie arm priced IS a points row; the `inseason` block and per-row `banked` |
| `test_validate_data.py` | the gate's newer AGREEMENT checks — projection coherence, and record vs matchups |
| `test_project_war_knn.py` | a missing season is not a season of zero |
| `test_project_points.py` | the strict feature glob (`features_weekly_*` must not overwrite the season table), the pool, the rookie arm, `--site`'s non-zero exit |
| `test_seasons.py` | "complete" = a decided champion, from either file; `last_completed_season` |
| `test_inseason.py` | `weeks_played` / `reg_weeks` / `remaining_frac`, the edges (week 0, week 14), and when a block is published at all |
| `test_lockstep.py` | the cross-language pair PROJECT_NOTES §10 only asserted in prose: `tradeModel.ts`'s consolidation curve vs `dynasty_movers.py` — `u_min`, `v50`, `τ` and the formula itself |
| `test_trade_analysis.py` | the live season counted once (the year-1 proration), and the tier frozen at the time of the trade |
| `test_usage_stats.py` | the league's own windows, capped at the last scored week |
| `test_fetch_projections.py` | the thin-week guard and the vintage archive |
| `test_aging_curves.py` | production weighting; the `MIN_GP` gate that the played rule disabled |
| `test_shard_players.py` | shard contents; atomic in-place writes |
| `test_franchise.py` | `POS_OVERRIDE`, `FRANCHISE_BAR`, the shape of the result |
| `test_outcomes.py` | outcome crawl's champion / pick-holding / placement / chain logic (mostly gated) |
| `test_slot_value.py` | median not mean; hit rate vs the position's bar |
| `test_fetch_values.py` | history freshness guard (deltas must not flatten to 0), the date-based trim |
| `test_fetch_ecr.py` | ECR scrape parsing, same-name twins |
| `test_sleeper_http.py` | 404/"null" → None is the only None; 429 raises |
| `test_names.py` | shared name-suffix set across joins |
| `tradeModel.test.ts` | monotonicity, 1-for-1 neutrality, pick timing per lens, floor, estimate flagging; plus `lib/seasons.ts` (settled seasons, `ridOf`, `seasonRow`, `currentPickClass`) and `lib/projRecord.ts` |

**A failure here is a change in what a figure means**, not a broken test —
decide whether the methodology moved on purpose before touching the test.

## Site (both shells)

**Router:** `HashRouter`, league-first. **The beta shell IS the board** (Max,
2026-09-02): it answers the **bare league address** `#/<league>/...`, and the
classic board moved to `#/<league>/classic/...` (`CLASSIC_SEG` in
`src/lib/context.ts`). `#/<league>/beta/*` and `#/<league>/v3/*` are
drop-segment redirects; old season-first URLs (`#/players/2025`) are
`LegacyRedirect`s onto `/classic`; a classic view's old BARE address is
forwarded to `/classic` by BetaShell's `ToClassic`. Route table in
`src/App.tsx` (~:217–246).

**Three path builders, and using the wrong one is the classic bug.**
`useLeaguePath` (`lib/context.ts`) → `/<league>/classic<path>`, for a
classic-only view. `useBetaPath` (`beta/ui.tsx`) → `/<league><path>`, for a
beta-only screen. **`useShellPath`** takes the CLASSIC path and lands it in
whichever shell the reader is actually in, via `useShell()` (which reads the
URL) plus a rename table (`draft→drafts`, `weekly→seasons`,
`home`/`""`→`league`) and `/franchise/<rid>` → `/team/<rid>` when the key is a
roster id. **Any component mounted in BOTH shells must use this one** — Player,
Draft, DraftDetail, History, Insights, QuickJump, PlayerLink, TradeCalc and the
rest of the shared components; building a classic link there is what dropped a
beta reader into `/classic` on the first tap of a Draft chip. A path with no
beta equivalent stays classic on purpose.

### Classic board — `#/<league>/classic/...`

Tabs: **League · Players · Teams · Season · Draft · Trade · Insights**;
masthead carries the model picker, the "Rebuilt nightly · `meta.updated`" stamp
(no clock time — the cron is 06:17 UTC and GitHub starts scheduled runs hours
late) and the "← Beta board" link. Everything but Home is lazy-loaded.

| Route (under `/:league/classic`) | View |
|---|---|
| `/`, `/home` | Home — champion + title race, power rankings (starters DVI, projected records), value plays (DVI−CVI), market movers (KTC 7d), dynasty movers, recent waivers/trades |
| `/value` | one merged price table: DVI, CVI, Proj WAR, Analog, KTC, FantasyCalc, ECR; team filter incl. "No team" |
| `/stats[/:season]`, `/stats/all` | production only: GP, PPG, volatility, WAR (metered), WAR/G; all-time aggregates careers |
| `/teams[/:season]`, `/teams/all` | Value board / Standings (seed, record, projected record, vs median, luck, lineup WAR) / All-time |
| `/franchise/:fkey[/:tab]` | franchise page: roster with group bands, seat-rank strengths, picks, year-by-year, drafts, trades, waivers, rename history |
| `/weekly/:season[/:wk[/:mid]]`, `/weekly/:season/playoffs` | one week at a time: matchup grid, top performers with "Started for"; playoffs scope = `PlayoffPanel` (bracket, WPA, win share, MVP/MVP+, playoff WAR) |
| `/draft[/:sub]`, `/draft/history/:season` | pick values (box plots, slot heat map, tiered returns) vs what we did |
| `/trades` | trade machine (`TradeCalc`) |
| `/ledger` | every trade scored on realized WAR, team multi-select, then-vs-now market drawer |
| `/history` | year-by-year league story (hand-maintained `LEAGUE_NOTES` for 2022–23) |
| `/insights` | cross-league benchmarks beside this league's figures |
| `/dvi`, `/cvi` | bare index boards, file order, never metered |
| `/player/:pid` | split rail: honors, career ladder, projection table (3 streams + the eight-curve model table), closest comparables, career with owner splits, ownership, market values, usage |

### Beta shell — `#/<league>/...` (the default board)

Phone-first, lazy-loaded with its own CSS, entered from the classic masthead
and left from its More screen (or the desktop-only "Classic board →" link).
Bottom tab bar **My Team · League · Players · Trade · More**, plus a seasonal
**Draft** tab while the roster season's rookie draft has not been recorded
(`lib/seasons.rookieDraftRecorded`, gated on `caps.drafts` so the redraft
league never fetches the 218 KB `drafts.json` to answer "no"). The index is a
redirect, not a screen: a claimed reader lands on `team`, everyone else on
`league`. Reader identity via `/claim` (username → roster, localStorage
`warboard.v3.identity`, never in the URL); league switcher sheet (long-press
the League tab). The bar hides on scroll-down and returns on scroll-up.

| Route (under `/:league`) | Screen |
|---|---|
| `league` | `League.tsx` — the dashboard, the live in-progress week (Sleeper + ESPN) and the book-style moneyline |
| `team`, `team/:rid` | `Team.tsx`, with `TeamSeasons.tsx` + `TeamRivals.tsx` as inner tabs |
| `claim` | `Claim.tsx` — username → roster |
| `players` / `teams` | `Players.tsx` (one board, own controls) / `Teams.tsx` (the franchise leaderboard, filed under More) |
| `trade` | `Trade.tsx` — Build (machine) + History (ledger, reads the frozen `trade_snapshots.json`); `ledger` → here with `?scope=history` |
| `more` | `More.tsx` — model picker, refresh row, deep links |
| `trends`, `movers/:kind` | `Trends.tsx` / `Movers.tsx` — value \| dynasty \| market |
| `player/:pid[/trades]` | classic `Player` in-shell; `PlayerTrades.tsx` for the full window |
| `seasons[/:season[/:wk[/:mid]]]` | `Seasons.tsx` — the week floor, rebuilt on League's modules (2026-09-15) |
| `drafts[/:sub]`, `drafts/history/:season`, `history`, `insights` | classic views mounted in-shell |
| `rankings[/:scope]` | redirect → `players` |

**`CLASSIC_ONLY`** (BetaShell ~:512) lists the classic first segments the shell
has no screen for — `home`, `stats`, `value`, `teams`, `standings`,
`franchise`, `weekly`, `draft`, `trades`, `dvi`, `cvi`, `playoffs` — whose old
bare addresses forward to `/classic` with path and query intact. `teams` is in
the list AND has a beta screen: the exact `teams` route outranks the `teams/*`
forward, so `/teams` is the beta leaderboard and `/teams/2025` the classic
standings. Rule: no *functional* improvement may live only in beta.

**Shared definitions worth knowing.** `beta/model.ts#starterSet` is the ONE
starters-DVI definition — **each index prices its own best legal lineup**
(taxi and IR included, an unpriced player absent rather than seated at zero),
so the best dynasty nine and the best win-now nine can differ; `STARTERS_NOTE`
is the band every screen showing one prints. Honors and team honors
(`lib/honors.ts`, `lib/teamHonors.ts`) are **settled-seasons-only** — an
in-progress season cannot hand out an Elite season or a title.

**UI conventions.** Dark "Broadcast" theme, zero border-radius, two type
roles (Archivo / Saira Condensed; beta adds IBM Plex Mono for figures). Pos
colors QB `#9333ea`, RB green, WR blue, TE orange; mark tints are separate
tokens. Name click navigates, row click opens a drawer (classic only). One
metered column per table — the sorted one — and indices are never metered.
Nulls are `—`, estimates `≈`. Every chart is hand-rolled SVG (no charting
library — adding one is a deliberate reversal). `hm` hides columns ≤640px;
records mode on mobile. GoatCounter pageviews, queued until the collector
loads. Design system in the `war-board-design-system` skill.

## Known caveats (tracked)

1. All-time "Roster" column attributes players to their **current** owner only.
2. `insights.json` is frozen hand-written prose — 2026-07-20, hand-edited
   2026-09-08 (`fb5463c6`). No producer.
3. `projections_knn.json` (pre-`--space`, 2026-08-07), `projections_check.json`
   (2026-08-10) and `nfl_history/projections_points.json` are tracked relics
   nothing reads, all stripped from the deployed artifact. The last is
   `project_points.py`'s corpus copy, **opt-in via `--out` since 2026-09-21**:
   the nightly used to rewrite it and throw the result away, and only
   `war-history.yml` should write `nfl_history/`.
4. `nfl_history.py`'s `SCORING` is a frozen copy from 2026-07-17; a Sleeper
   scoring change would not reach the corpus.
5. `aging_curves.py` is not chained to `war-history.yml`; the analog corpus
   and the curve can drift from each other after a rebuild.
6. `projections_knn_hybrid.json` (~800 KB) is still fetched whole by the Value
   view's Analog column (player pages use shards).
7. Rookies cannot be projected by the ANALOG model (it seeds from played
   seasons). Points-first has a rookie arm, and since 2026-09-21 those rows
   reach the matrix's `points_*` curves with `has_points` true — before that
   all 56 rookies silently got the SCALAR pair under a points heading.
8. Home's sell-high still ranks by `dvi − cvi`; the market-premium variant
   with a KTC floor is unbuilt.
9. Team-level CVI ≈ team-level DVI (open question in METHODOLOGY).
10. **Past seasons carry no `snap_pct`.** `nfl_features.py` grew the
    `snaps`/`team_snaps` columns after the corpus was last rebuilt, so only
    `features_weekly_2026.csv` (the nightly's season) has them; `usage_stats.py`
    warns and omits the figure for 2022–2025. Remedy: re-dispatch
    `war-history.yml` (`1999..2025` on today's defaults, `2012` at the latest).
11. **`project_points` pool drift — owner decision pending.** `war_from_points`
    filters the pool to players projected for `games >= 1`; `pool_war` (the
    rookie recompute path) does not, so veteran WAR is measured against a
    rookie-less pool and rookie WAR against a pool with rookies in it.
12. **Two "projected WAR" figures live — owner decision pending.** A reader on
    the default board sees `blend_composite`; anything reading
    `projections.json` gets points-first (see §12 above).
13. **Git bloat.** `data/draft_index.json` is 18 MB and `data/recent_trades/`
    8.7 MB, both rewritten whole several times a day — the audit measured
    ~262 MB of new blobs in three weeks; `.git` is ~700 MB against a 50 MB
    working `data/`. Neither ships. Stop committing `draft_index.json`, or
    shard it the way `recent_trades` is.
14. Root clutter: 80 `vite.config.ts.timestamp-*.mjs` files — a Vite 5 bug
    (it fails to unlink them on the OneDrive mount), gitignored, fixed by
    Vite ≥ 6. `.pytest_cache/` is not in `.gitignore` but ignores itself
    (pytest writes `.pytest_cache/.gitignore` = `*`), and `HANDOFF.md` /
    `HANDOFF_*.md` are both ignored — so the two HANDOFF files outside
    `scratch/` are untracked clutter, not repo content. No LICENSE file
    (added and deleted 2026-09-02).
15. **`public/CNAME` is the apex `bigdogdynasty.app`** while the site is linked
    as `https://www.bigdogdynasty.app`, and GitHub's "Enforce HTTPS" is off.
    Pick one host, redirect the other, turn enforcement on.
16. **`tests/*.ts` are not typechecked.** `tsconfig.json` includes `src` only;
    `tsconfig.test.json` covers `vite.config.ts` and stops there, because
    `tests/tradeModel.test.ts` imports `node:*` and would need `@types/node`
    (a devDependency + a lockfile regen; `npm ci` fails hard on a mismatch).
    A 2026-09-21 probe found exactly one real error behind it (an implicit
    `any` around line 314); the steps to take it are in `tsconfig.test.json`.
17. **Two trade snapshots froze an un-prorated `exp`** — the trades dated
    2026-09-09 and 2026-09-10, taken before ledger proration landed. Frozen
    means frozen, so they read a little rich against every later in-season
    trade.

## Roadmap (Max's stated priorities)

1. **Trade machine v2** — measured start-share curves replacing the logistic
   consolidation; CVI variance haircut; real kernel streams for picks.
2. **Chain model fits to the corpus** — `aging_curves.py` (and, if the
   analog seed needs it, `project_war_knn.py`) as steps in `war-history.yml`.
   `nfl_features.py` was chained in 2026-09-16; the curve fit was not.
3. **Analog model for rookies** — a second cohort keyed on draft slot. (The
   points-first arm now prices rookies from draft capital; the analog arm still
   cannot.)
4. **Decide caveats 11 and 12** — the `war_from_points` / `pool_war` pool
   mismatch, and whether the site quotes points-first or the default curve.
5. **Re-dispatch `war-history.yml`** for `snap_pct` and the `early/` split
   (caveat 10), then re-fit the aging curves.
6. **Multi-league Version B** (parked 2026-07-20): any league by id. Raw
   weekly stat lines are league-independent — pull once into a shared store,
   re-score per league from `scoring_settings`, derive the pool from
   `roster_positions` × team count. First step is a validation spike:
   re-score Big Dog from raw stats and diff against `players_points`.
   Version A (chosen leagues, `data/leagues/<key>/`, switcher) is shipped, and
   `lib/caps.ts` is the seam a registry feature-list would slot into.
7. Beta shell deferred items: walk-up username flow, TS WAR engine, rankings
   movement arrows (needs daily index snapshots), draft countdown (needs
   `start_time`, which exists only in the gitignored raw scrape).
8. Minor: all-time Roster column (caveat 1); untrack the relic files
   (caveat 3); curb the `draft_index.json` churn (caveat 13).

## Working conventions (from Max)

- Ask before acting on non-trivial changes; one actionable item per turn.
- Concise replies; options written in text, not selectable widgets.
- Docs in markdown. TypeScript on the front end. Scratch work and handoffs go
  in `scratch/` (gitignored).
- Max runs git himself — stage specific files (line-ending noise shows
  unrelated files as modified; never blind `git add -A`).
- Local repo folder is the connected workspace; edit files there directly,
  then give Max the git commands.
- Dev loop: edit → `npx tsc --noEmit` → `python -m unittest discover -s tests`
  → `npm test` → `npm run build`. Vite does NOT typecheck; CI runs both gates
  but a red deploy is still a red site. `npm run typecheck` runs both TS
  projects (`src`, then `tsconfig.test.json`).
- Prefer running Cowork sessions ON Max's computer (direct folder + network
  access); cloud sessions can't write `.github/workflows/` or reach
  api.sleeper.app / nflverse. The agent sandbox cannot unlink on the OneDrive
  mount: `vite build` into `dist/` EPERMs (use `--outDir /tmp/x`),
  `shard_players.py` and git tree rewrites need the local terminal.

## Related tooling (outside the repo)

- **sleeper-api skill** (installed in Claude): full Sleeper HTTP API reference.
- **war-board-design-system skill**: tokens, table rules, screen shells.
- `sleeper_pull.py` / `sleeper_war.py` work standalone on any machine:
  `python sleeper_pull.py <league_id> --players --out <dir>` then
  `python sleeper_war.py --data <dir>`.
- Historical WAR standalone: `pip install nflreadpy`, then
  `python scripts/nfl_history.py --start 1999 --end 2025` and
  `python scripts/sleeper_war.py --data nfl_history_data`.
