# Big Dog Dynasty WAR Board — Project Notes

Context doc for new work sessions. Read this first. Refreshed 2026-09-02
against `611bf393`; the per-session handoffs in `scratch/` (gitignored) carry
the decision trail.

## What this is

A self-updating stats and valuation site for Sleeper leagues. Home league is
**Big Dog Dynasty** (12-team superflex dynasty, run by Max / Sleeper username
`mawxy`, user_id `471740157079318528`): 2022 (startup) → 2026, chained via
`previous_league_id`. **Pineapple Pizza FFL** (12-team redraft, 2023 →) runs
on the same pipeline with reduced coverage (see Multi-league).

- **Live site:** https://mawxy.github.io/big-dog-dynasty/
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
quietly — history keeps working, the site never gains the new season.

`leaguepaths.DataDir` routes a filename either to `data/<file>` (global:
`leagues.json`, `values*.json`, `ecr.json`, the crawl corpora,
`benchmarks.json`, `dynasty_movers.json`, `tep_map.json`) or to
`data/leagues/<key>/<file>` (everything league-specific, including `dvi.json`
and `value_bridge.json` because they derive from that league's projections).

**Pineapple Pizza coverage is pull → WAR → build only.** No projections,
indices, drafts, trades, odds, bracket or shards — every downstream step
defaults to Big Dog. The site renders what exists and prints `—` for the rest.

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
                trade_analysis.py  ──> trades.json, trade_snapshots.json
                playoff_wpa.py / playoff_war.py ──> <season>/bracket.json (wpa, war)
                fetch_projections.py ──> proj_sleeper.json
                week_odds.py --snapshot ──> <season>/odds.json, <season>/proj_history.json
                project_war.py     ──> projections.json           (scalar)
                value_bridge.py    ──> value_bridge.json          (Bridge B)
                project_war_knn.py --space hybrid ──> projections_knn_hybrid.json  (analog)
                project_matrix.py  ──> projections_matrix.json    (six curves)
                shard_players.py   ──> player/<pid>.json          (~800 shards)
                index_models.py    ──> dvi.json, cvi.json, index_models.json
                validate_data.py                                  gate
                                                     │
src/ (Vite + React 18 + TypeScript, HashRouter) ─────┴──> GitHub Pages

nflverse ──> scripts/nfl_history.py ──> nfl_history_data/ (gitignored)
             └─ same sleeper_war.py engine ──> nfl_history/*.csv 2012+ (committed)
             aging_curves.py ──> nfl_history/aging_curves.json   (hand-run)

sleeper_crawl.py (signals / trades / drafts / outcomes, sharded) ──> data/*_signals.json, corpora
merge_trade_corpus.py + dynasty_movers.py ──> data/dynasty_movers.json
benchmarks.py ──> data/benchmarks.json
fetch_values.py / fetch_ecr.py ──> data/values.json, values_history.json, ecr.json
```

- **Front end reads only `data/**/*.json`** — never calls Sleeper. Boot loads
  `data/leagues.json`, resolves the league from the first hash segment, then
  `meta.json` + `players_min.json`; cache-busting is `?v=<meta.updated>`, not a
  build id (a build id changed the JS hash ~30×/day on crawl commits).
- **Per-player shards.** `player/<pid>.json` carries projection, Sleeper
  projection, matrix row + `blend_w`, and the kNN subset with comparables, so a
  player page pulls ~2 KB instead of ~1.6 MB. Sharding runs **last** in the
  projection chain so a shard never pairs last night's curves with tonight's
  scalar. Written atomically per shard, pruned last.
- **`insights.json`** (per-team verdicts on the league home and franchise
  pages) **has no producer.** It was hand-written 2026-07-20 from preseason
  projections and has not moved since. Decide: script, preseason ritual, or
  remove the band.

## GitHub Actions

Eleven workflows. Every committing job **re-parents** (fetch → mixed-reset
onto `origin/main` → stage own paths → commit → push; never rebase — a
regenerated file conflicts identically on every retry) and stages an
**explicit allow-list**. Canonical reasoning lives in `crawl-signals.yml`.

| Workflow | Cron (UTC) | Concurrency | Runs | Commits |
|---|---|---|---|---|
| `data-refresh` | `0 6 * * *` daily | `data-push` | tests → restore player-map cache (self-heals) → pull Big Dog → WAR → build → pull/WAR/build Pizza (`continue-on-error`) → pick_value → draft_analysis → trade_analysis → playoff_wpa → playoff_war → fetch_projections (+ stale warning) → week_odds --snapshot → project_war → value_bridge → project_war_knn --space hybrid → project_matrix → shard_players → index_models → validate_data | `data/leagues`, `data/leagues.json`, `data/values.json`; a guard fails the run if any crawl-owned path is staged; calls `deploy` |
| `values-refresh` | `0 11 * * *` daily | `data-push` | fetch_values → fetch_ecr (`continue-on-error`) → value_bridge → validate_data --values-only | `data/values.json`, `values_history.json`, `ecr.json`, `data/leagues/*/value_bridge.json`; calls `deploy` |
| `war-history` | manual (`start`/`end` inputs, default 2014–2025 — **use 2012**) | `data-push` | nfl_history → sleeper_war → copy CSVs | `nfl_history/` (sole writer, whole-dir add) |
| `players-refresh` | `0 5 * * 2` Tuesdays | `players-map` | `sleeper_pull --players-only` → cache save | nothing |
| `deploy` | push to `main` minus `paths-ignore` (corpora), manual, `workflow_call` | `pages-deploy` (job-level, cancel-in-progress) | Node 20 → `npm ci` → typecheck → build → `cp data dist/data` → strip corpora + `projections_check.json` → Pages | nothing |
| `tests` | push to `main`, PRs | none | Python 3.12 unittest with `EXPECTED_SKIPS=8` pinned; Node 22 typecheck + `npm test` | nothing |
| `crawl-signals` | `0 0,6,12,18 * * *` | `crawl-signals` | `sleeper_crawl --mode signals` (the only discoverer) | `league_signals.json`, `crawl_leagues.json` |
| `crawl-signals-redraft` | `0 3,9,15,21 * * *` | `crawl-signals-redraft` | same, `--league-type redraft`, seeded from Pizza | `league_signals_redraft.json`, `crawl_leagues_redraft.json` |
| `crawl-drafts` | `0 2,8,14,20 * * *` | `crawl-drafts` | `--mode drafts`, walks chains back to 2019 | `draft_signals.json`, `draft_index.json`, `rookie_pick_corpus.json` |
| `crawl-trades` | `0 1-23/2 * * *` | per shard + `crawl-trades-movers` | 4 shards → artifacts → `movers` job: merge_trade_corpus → dynasty_movers | `dynasty_movers.json`, `tep_map.json`; calls `deploy` (a `GITHUB_TOKEN` push never triggers `on: push`) |
| `crawl-outcomes` | `0 3,15 * * *` | per shard | 4 shards → artifact rows + committed counters → benchmarks.py (warn-only) | `outcome_signals_<n>.json`, `benchmarks.json` |

Notes that bite:

- `data/values.json` has two writers (`fetch_values.py` creates it,
  `value_bridge.py` writes `impWar`/`modelWar` back) in two workflows. Safe
  only because both share `data-push`. Both `data-refresh` and
  `values-refresh` write under `data/leagues/` — same reason.
- The crawls deliberately do **not** join `data-push`: a five-hour crawl
  holding it would block the nightly. They absorb push races in their own
  fetch / re-parent / retry loop.
- `deploy.yml`'s `paths-ignore` list and its strip step must be kept in
  lockstep (the yml says so). Corpora with no reader in `src/` are ~12.8 MB
  of the 16.4 MB `data/` tree; `trade_corpus*` / `outcome_corpus*` still ship.
- The player map (~19 MB) is fetched by `players-refresh` (weekly, cached),
  by the `movers` job (date-keyed cache), and by each crawl lane
  (`.crawl-state/players_nfl.json`) — once a day per consumer, on separate
  runner IPs. Sleeper's cap is ~1000 calls/min per IP.
- `war-history.yml` defaults to 2014; the corpus must start at **2012** or a
  partial rebuild splices two played rules. `aging_curves.py` is in no
  workflow — a corpus rebuild does not refit the curve (open item).
- Pages source is **GitHub Actions** (not branch).

### Hand-run scripts (no workflow)

`aging_curves.py` (curve fit; production-weighted default), `slot_value.py`
(needs artifact-only outcome rows → `data/slot_values.json`),
`backfill_ktc_history.py` (KTC/FantasyCalc deep history →
`data/values_history_deep.json`, run `--probe` first), `pull_rookie_drafts.py`
(add a league's rookie drafts to `nfl_history/rookie_drafts.csv`, tagged by
`--source`), `franchise_players.py`, `make_icons.py`.

### Rebuild order (local, after a corpus change)

```
python -m unittest discover -s tests
python scripts/nfl_history.py --start 2012 --end 2025 --out scratch/hist_new   # nflreadpy; local only
python scripts/sleeper_war.py --data scratch/hist_new --top 10
cp scratch/hist_new/analysis/*.csv nfl_history/ && cp scratch/hist_new/players_meta.csv nfl_history/
python scripts/aging_curves.py
python scripts/project_war.py
python scripts/value_bridge.py
python scripts/project_war_knn.py --space hybrid
python scripts/project_matrix.py
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
     falls back to "0.00 = DNP" if played files are absent.
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
8. **DVI and CVI are computed under ALL SIX projection curves** (2026-08-13).
   `scripts/curves.py` owns the vocabulary (mirrors `MATRIX_CURVES` in
   `src/lib/types.ts`, locked by `tests/test_curves.py`) and the year-1 lookup
   into `projections_matrix.json`. `index_models.py` drives `blend_values`
   and `contender_index` across the six curves from ONE load and writes
   `dvi.json` + `cvi.json` on the default plus `index_models.json` with all
   six. **Default is `blend_composite`.** `--curve scalar_composite`
   reproduces the pre-matrix numbers exactly (393/393, locked by a test).
   Both indices clamp on **year-1** WAR — inherited, left alone deliberately.
   `has_analog` / `has_sleeper` are claims about the PROJECTION, never the
   figure (65 no-cohort players: identical WAR across curves, identical DVI in
   only 4). `validate_data.check_index_models` rejects a file whose six curves
   collapsed into one.
9. **The projection model is a SITE-WIDE control** (2026-08-13). Masthead
   `ModelPicker` (two controls, not one six-way), state in `lib/model.ts`;
   `?m=<curve>` in the URL wins over localStorage (`warboard.curve`); default
   is the absence of the param. Not accent-filled (it sits above every view).
   In the beta shell it lives on the More screen. `lib/useIndices.ts` reads
   `index_models.json` once (~180 KB) and slices it; the `dvi.json`/`cvi.json`
   fallbacks are fetched only if that file errors.
10. **The trade machine shops one basket against many offers** (2026-08-13).
   Outgoing side pinned; each offer scored against it; deltas signed on both
   sides per currency, never combined into one verdict. A scoped exception to
   "never colour a trade" (the Ledger records a fact; the machine evaluates a
   hypothetical). Maths in `src/lib/tradeModel.ts`, shared with beta, locked
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
   decided winners-bracket game. Written in `build_site_data.py`.
12. **Projections: Sleeper weight `BLEND_W = [0.9, 0.5, 0.1]`**, no Sleeper
   gate (`SLEEPER_GATE = "none"`; a 25-pt floor was measured and removed —
   projected WAR is production, not worth). Sleeper projections are summed
   from the **weekly** endpoint (2026-08-31), not the season product.
   `composite_path()` has one home (`project_war.py`); the matrix imports it.
   No corpus→league rescale (0.9645 was indistinguishable from 1.0 on four
   seasons).
13. **Analog model** (`project_war_knn.py`): gaussian kernel (`KERNEL_H 0.5`,
   was a quartic by accident), `MAX_DIST 1.0954`, cohort median, vanished
   analogs count as 0, `TOP_N 3` comparables with a 0–100 match score. Trust
   `1/(1+(d_med/d_ref[pos])⁴)` (halved when padded) weights the blend and
   Sleeper's leg on the analog composite (`0.25 + 0.65·(1−trust)`).
14. **Trade ledger** (`trade_analysis.py`): realized WAR while starting for
   the acquirer, one hop, `DELTA = 0.7` stream discount with pick lag;
   at-trade snapshot frozen once, enrich-only merge, and a guard that refuses
   a ledger whose newest trade predates the committed one (2026-08-21
   incident).
15. **Dynasty movers** (settled 2026-08-20): centerpiece attribution, a
   player's own value never deflated (consolidation is package-level only),
   per-league TE-premium ladder fetched live, KTC generic mid for picks, FAAB
   0, `--min-value 2000`, adaptive `min_n`.
16. **Owner-keyed franchises** (2026-08-31): the franchise key `fkey` is
   `roster_id` in dynasty leagues and the owner's Sleeper `user_id` in
   redraft/keeper (a redraft owner's rid varies by season). Legacy rid links
   resolve. Career owner splits cut on change-of-hands boundaries; finish and
   honors go whole to the season's primary owner (2026-09-01).

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

`python -m unittest discover -s tests` (stdlib, no network) — 382 tests in 17
files; `npm test` runs `tests/tradeModel.test.ts` (16 tests, `node --test`,
Node ≥ 22.18). CI (`tests.yml`) runs both and **pins 8 expected skips** —
tests gated on `sleeper_data/` or `scratch/sample_corpus_0.json`. On Max's
machine those files exist, so the local result is 382 / 0 skipped.

| File | What it locks |
|---|---|
| `test_war_engine.py` | 108-slot pool, dedicated-before-flex, replacement = best-left-out, WAA sums to 0 per position, weekly sigma, VoWP ladder, every branch of the played rule |
| `test_week_odds.py` | pregame only; week 1 without a snapshot unpriced; `--snapshot` first-write-wins |
| `test_playoff_wpa.py` | Shapley efficiency, win-share totals, round weights, MVP vs MVP+ |
| `test_playoff_war.py` | sigma imported from the regular season, elimination games only |
| `test_value_stack.py` | DVI / CVI shares and weights, Bridge B isotonic monotonicity, Bridge A board and outcome rule |
| `test_curves.py` | six-curve vocabulary; `scalar_composite` ≡ the old `composite[0]` |
| `test_projection_matrix.py` | six curves stay six; composite has ONE home |
| `test_project_war_knn.py` | a missing season is not a season of zero |
| `test_aging_curves.py` | production weighting; the `MIN_GP` gate that the played rule disabled |
| `test_shard_players.py` | shard contents; atomic in-place writes |
| `test_franchise.py` | `POS_OVERRIDE`, `FRANCHISE_BAR`, the shape of the result |
| `test_outcomes.py` | outcome crawl's champion / pick-holding / placement / chain logic (mostly gated) |
| `test_slot_value.py` | median not mean; hit rate vs the position's bar |
| `test_fetch_values.py` | history freshness guard (deltas must not flatten to 0) |
| `test_fetch_ecr.py` | ECR scrape parsing, same-name twins |
| `test_sleeper_http.py` | 404/"null" → None is the only None; 429 raises |
| `test_names.py` | shared name-suffix set across joins |
| `tradeModel.test.ts` | monotonicity, 1-for-1 neutrality, pick timing per lens, floor, estimate flagging |

**A failure here is a change in what a figure means**, not a broken test —
decide whether the methodology moved on purpose before touching the test.

## Site (both shells)

**Router:** `HashRouter`, league-first: `#/<league>/<view>[/<season>...]`.
Old season-first URLs (`#/players/2025`) are `LegacyRedirect`s. Tabs:
**League · Players · Teams · Season · Draft · Trade · Insights**; masthead
carries the model picker, "Rebuilt nightly" stamp, and the "Beta board →"
link. Everything but Home is lazy-loaded.

| Route | View |
|---|---|
| `/:league`, `/home` | Home — champion + title race, power rankings (starters DVI, projected records), value plays (DVI−CVI), market movers (KTC 7d), dynasty movers, recent waivers/trades |
| `/value` | one merged price table: DVI, CVI, Proj WAR, Analog, KTC, FantasyCalc, ECR; team filter incl. "No team" |
| `/stats[/:season]`, `/stats/all` | production only: GP, PPG, volatility, WAR (metered), WAR/G; all-time aggregates careers |
| `/teams[/:season]`, `/teams/all` | Value board (each index prices its own best legal lineup) / Standings (seed, record, projected record, vs median, luck, lineup WAR) / All-time |
| `/franchise/:fkey[/:tab]` | franchise page: roster with group bands, seat-rank strengths (`TeamStrengths`), picks, year-by-year, drafts, trades, waivers, rename history |
| `/weekly/:season[/:wk[/:mid]]`, `/weekly/:season/playoffs` | one week at a time: matchup grid, top performers with "Started for"; playoffs scope = `PlayoffPanel` (bracket, WPA, win share, MVP/MVP+, playoff WAR) |
| `/draft[/:sub]`, `/draft/history/:season` | pick values (box plots, slot heat map, tiered returns) vs what we did (best/worst, Sleeper-style boards) |
| `/trades` | trade machine (`TradeCalc`) |
| `/ledger` | every trade scored on realized WAR, team multi-select, then-vs-now market drawer |
| `/history` | year-by-year league story (hand-maintained `LEAGUE_NOTES` for 2022–23) |
| `/insights` | cross-league benchmarks beside this league's figures |
| `/dvi`, `/cvi` | bare index boards, file order, never metered |
| `/player/:pid` | split rail: honors, career ladder, projection table (3 streams + six-curve model table), closest comparables, career with owner splits, ownership, market values |

**Beta shell** (`/:league/beta/*`; `/v3/*` redirects) — the phone-first
redesign, lazy-loaded with its own CSS, entered from the masthead and left
from its More screen. Bottom tab bar **My Team · League · Players · Trade ·
More** (+ a seasonal Draft tab while the roster season's draft is pending);
`Current | History` scope control in the URL (`?scope=history&season=`);
reader identity via `/beta/claim` (username → roster, localStorage
`warboard.v3.identity`, never in the URL); league switcher sheet (long-press
League). Trade screen = Build (machine) + History (ledger, reads the frozen
`trade_snapshots.json`). Player, drafts, seasons, history and insights mount
the classic views inside the shell. Rule: no *functional* improvement may
live only in beta.

**UI conventions.** Dark "Broadcast" theme, zero border-radius, two type
roles (Archivo / Saira Condensed; beta adds IBM Plex Mono for figures). Pos
colours QB `#9333ea`, RB green, WR blue, TE orange; mark tints are separate
tokens. Name click navigates, row click opens a drawer (classic only). One
metered column per table — the sorted one — and indices are never metered.
Nulls are `—`, estimates `≈`. Every chart is hand-rolled SVG (no charting
library — adding one is a deliberate reversal). `hm` hides columns ≤640px;
records mode on mobile. GoatCounter pageviews, queued until the collector
loads. Design system in the `war-board-design-system` skill; mobile rules in
MOBILE.md conventions referenced in source.

## Known caveats (tracked)

1. All-time "Roster" column attributes players to their **current** owner only.
2. `insights.json` is frozen hand-written prose (see Architecture).
3. `projections_knn.json` (pre-`--space`, 2026-08-07) and
   `projections_check.json` (2026-08-10) are tracked relics nothing reads.
4. `nfl_history.py`'s `SCORING` is a frozen copy from 2026-07-17; a Sleeper
   scoring change would not reach the corpus.
5. `aging_curves.py` is not chained to `war-history.yml`; the analog corpus
   and the curve can drift from each other after a rebuild.
6. `projections_knn_hybrid.json` (~800 KB) is still fetched whole by the Value
   view's Analog column (player pages use shards).
7. Rookies cannot be projected by the analog model (seeds from played seasons).
8. Home's sell-high still ranks by `dvi − cvi`; the market-premium variant
   with a KTC floor is unbuilt.
9. Team-level CVI ≈ team-level DVI (open question in METHODOLOGY).
10. No LICENSE file (added and deleted 2026-09-02).
11. Root clutter: `vite.config.ts.timestamp-*.mjs` (ignored), `.pytest_cache/`
    (not ignored), two HANDOFF files outside `scratch/`.

## Roadmap (Max's stated priorities)

1. **Trade machine v2** — measured start-share curves replacing the logistic
   consolidation; CVI variance haircut; real kernel streams for picks.
2. **Chain model fits to the corpus** — `aging_curves.py` (and, if the
   analog seed needs it, `project_war_knn.py`) as steps in `war-history.yml`.
3. **Analog model for rookies** — a second cohort keyed on draft slot.
4. **Multi-league Version B** (parked 2026-07-20): any league by id. Raw
   weekly stat lines are league-independent — pull once into a shared store,
   re-score per league from `scoring_settings`, derive the pool from
   `roster_positions` × team count. First step is a validation spike:
   re-score Big Dog from raw stats and diff against `players_points`.
   Version A (chosen leagues, `data/leagues/<key>/`, switcher) is shipped.
5. Beta shell deferred items: walk-up username flow, TS WAR engine, rankings
   movement arrows (needs daily index snapshots), draft countdown (needs
   `start_time` surfaced from the dump).
6. Minor: all-time Roster column (caveat 1); untrack the two relic files.

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
  but a red deploy is still a red site.
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
  `python scripts/nfl_history.py --start 2012 --end 2025` and
  `python scripts/sleeper_war.py --data nfl_history_data`.
