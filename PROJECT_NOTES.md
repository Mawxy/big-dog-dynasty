# Big Dog Dynasty WAR Board — Project Notes

Context doc for new work sessions. Read this first.

## What this is

A self-updating stats website for the Big Dog Dynasty fantasy football league
(12-team superflex dynasty on Sleeper, league_id `1312221243742621696`, run by
Max / Sleeper username `mawxy`, user_id `471740157079318528`). League history:
2022 (startup) → 2023 → 2024 → 2025 → 2026, chained via `previous_league_id`.

- **Live site:** https://mawxy.github.io/big-dog-dynasty/
- **Repo:** https://github.com/Mawxy/big-dog-dynasty (branch `main`)
- Scoring: PPR + 0.5 TE premium, superflex (QB/2RB/3WR/TE/FLEX/SF), taxi + IR,
  FAAB $100, 6-team playoffs starting week 15, trade deadline week 12.

## Architecture

```
Sleeper API ──> scripts/sleeper_pull.py ──> sleeper_data/   (raw dump, gitignored)
                scripts/sleeper_war.py  ──> analysis CSVs   (WAA/WAR per player/week)
                scripts/build_site_data.py ──> data/        (compact JSON, committed)
                scripts/{draft,trade}_analysis.py ──> data/drafts|trades.json
                scripts/project_war.py ──> data/projections.json
                scripts/shard_players.py ──> data/player/<pid>.json
                                                 │
src/ (Vite + React 18 + TypeScript) ────────────┴──> GitHub Pages

nflverse ──> scripts/nfl_history.py ──> nfl_history_data/  (gitignored)
             └─ same sleeper_war.py engine ──> nfl_history/*.csv (committed)
```

- **Front end** reads only `data/*.json` — never calls Sleeper. React Router
  (HashRouter) URLs: `#/players/:season`, `#/teams/:season[/:rid]`,
  `#/weekly/:season[/:wk]`, `#/player/:pid`; season segment `all` = All-time.
- **Front end fetches per-player data as shards.** `data/player/<pid>.json`
  (written by `shard_players.py`, gated to the ~800 ids in `players_min.json`
  plus analog-only players with a knn cohort) carries that player's projection,
  Sleeper projection, matrix row (`mx` + `blend_w`) and knn subset (`knn`,
  incl. the `near` comparables), so a player page pulls ~2 KB instead of
  `projections.json` + `proj_sleeper.json` + `projections_matrix.json` +
  `projections_knn_hybrid.json` (~1.6 MB) (shards enriched 2026-09-01). A
  missing field means that source has nothing for him; a shard with neither
  projection falls back to the plain WAR trend chart. The shard step runs
  AFTER `project_matrix` in `data-refresh.yml` so shards carry the same
  night's projections.
- **GitHub Actions workflows:**
  - `tests.yml` — engine invariants + `tsc --noEmit` + `npm test` (the
    tradeModel invariants, Node 22 native type stripping) on pushes to `main`
    and on every PR (`branches: [main]` on the push trigger only — a push to a
    side branch runs nothing until it opens a PR).
  - `deploy.yml` — build & deploy on pushes to `main` (also manual /
    `workflow_call`), minus a `paths-ignore` list of crawler corpora the site
    never fetches — so the ~30 crawl commits a day no longer each trigger a
    full rebuild + publish. Typechecks before building: **Vite does not
    typecheck**, so this is the only gate. No Sleeper calls; safe to run
    constantly.
  - `data-refresh.yml` — DAILY, 06:00 UTC (1 AM ET) + manual: runs the
    engine tests, pulls Sleeper, recomputes WAR, shards player data, commits
    `data/`, then calls deploy.
  - `players-refresh.yml` — weekly, Tuesdays: the ~19 MB Sleeper player map,
    cached. The daily job restores that cache instead of re-downloading it,
    which is what makes a daily cadence cheap.
  - `values-refresh.yml` — daily: FantasyCalc + KTC market values, no Sleeper.
  - The three PIPELINE jobs that commit — `data-refresh`, `values-refresh` and
    `war-history` — share `concurrency: data-push`, so a manual dispatch during
    a scheduled run can't lose a race to a rejected push. The crawls
    deliberately do NOT join that group: each owns its own
    (`crawl-signals`, `crawl-drafts`, `crawl-outcomes-<shard>`,
    `crawl-trades-<shard>`), because a five-hour crawl holding `data-push`
    would block the daily refresh behind it. They absorb the race in their own
    fetch / re-parent / retry loop.
  - **Every committing workflow now RE-PARENTS rather than rebases**
    (2026-08-12; the three pipeline jobs were the last holdouts). Everything any
    of them commits is a generated file rewritten whole, so a rebase that lands
    on a conflicting edit conflicts identically on all five retries and the run
    exits 1 with the day's work dropped. Fetch, mixed-reset onto origin, stage
    our own paths, commit, push: ours wins by construction, everything else on
    main carries forward. Reasoning in `crawl-signals.yml`; the concurrency
    split in `data-refresh.yml`.
  - The corollary is that **a re-parenting job may not `git add <dir>`** unless
    it is the sole writer of that directory. After the reset the index is at
    origin while the tree is still at checkout, so a directory add stages a
    *reversion* of anything that pushed mid-run. `war-history` is a sole writer
    and keeps `git add nfl_history`; `values-refresh` and `data-refresh` stage
    explicit allow-lists. `data-refresh`'s entire committed surface is
    `data/leagues/`, `data/leagues.json` and `data/values.json` — everything
    else under `data/` is crawl-owned, and a guard in that step fails the run
    loudly if a crawl-owned path is ever staged.
  - **The analog projection arm is nightly as of 2026-08-12.** `data-refresh`
    runs `project_war_knn.py --space hybrid` between `build_site_data` (which
    writes the `players_min.json` it joins against) and `project_matrix` (which
    consumes it). ~3s, ~45 MB, stdlib-only, no network — every input is
    committed. `--space hybrid` is not the script's default; the writer names
    its output `projections_knn_<space>.json` and the matrix only reads the
    hybrid one, so changing the space here silently orphans it.
    `data/leagues/*/projections_knn.json` is a pre-`--space` relic that nothing
    reads — untracking candidate.
  - That closes the DATE half of the staleness check only. The analog corpus is
    `nfl_history/*.csv`, rebuilt solely by the manual `war-history.yml`, so
    after a season is played the scalar arm advances to it nightly and the
    analog arm does not until someone dispatches that job. A SEED warning means
    run war-history; a DATE warning now means the nightly step broke.
  - `data/values.json` has TWO writers: `fetch_values.py` creates it and
    `value_bridge.py` writes it back with `impWar`/`modelWar`, and value_bridge
    runs in both `values-refresh` and `data-refresh`. Safe only because those
    two share `data-push`. A third writer outside that group would corrupt it.
  - `war-history.yml` — manual: nflverse → league-shaped WAR for 2014+ via
    `scripts/nfl_history.py` + unchanged engine; commits `nfl_history/*.csv`
    (analysis CSVs + players_meta.csv with birth dates and draft slots).
    Synthetic team scores are σ-calibrated to the real league: weekly σ =
    SIGMA_COEF (0.160) × mean synthetic team score, fitted so matched
    player-season WAR ratios (league/hist 2022-25) center on 1.0. The raw
    slot-wise deal ran WAR ~1.4-1.55× hot (σ too tight); naive real-CV
    (0.216) overcorrected ~1.35× because synthetic optimal-pool means run
    ~1.26× real team means. Residual ±10% season ratios = real CV drift,
    accepted (measured 2026-07-17).
- Pages source is **GitHub Actions** (not branch). `npm ci && npm run build`,
  then `data/` is copied into `dist/`.
- UI conventions: dark theme, pos badge colors (QB purple #9333ea, RB green,
  WR blue, TE orange), clicking a **name** (accent link) navigates to a page,
  clicking the **row** toggles a quick dropdown panel. Tables sortable via
  header clicks; `hm` class hides columns on mobile (≤640px).

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
     Sleeper's `tm_*_snp` is weekly roster ACT status — which also closed the
     old asymmetry where a dressed RB/WR/TE with no snaps in any phase read DNP
     historically but a played 0.00 in league data.
   - Locked down by `tests/test_war_engine.py::TestPlayedRule`.
   - Decision history (kept — the rule has moved twice):
     - An all-positions "participation" rule (`off_snp` only, everyone) was
       considered and rejected early.
     - **2026-07-17 (superseded)**: settled as POSITION-DEPENDENT. QB required
       offensive participation — `off_snp > 0` OR a real offensive stat line —
       so a dressed backup QB with zero snaps was DNP (Malik Willis 2025 wk1,
       Bagent's 2024 backup weeks); RB/WR/TE took dressed = played. Rationale
       was that QB is the one position with a clear starter who takes every
       snap, so merely dressing carried no start-worthiness signal.
     - 2026-07-19: the RB/WR/TE branch was only testing snaps, never the stat
       line, so it disagreed with the history pipeline. It now checks
       `_OFF_STATS` too — this can only ADD played weeks.
     - **2026-08-07**: the QB carve-out was RETIRED. "Dressing carries no
       signal" is an argument about OPPORTUNITY, and WAR measures production
       against replacement, not opportunity. A backup QB is often valuable to
       OWN and reliably unproductive — different facts, and ownership value is
       what DVI, CVI and market price measure. Excluding his weeks let a backup
       keep a per-13 rate built from two mop-up appearances, which was the root
       of the projection model pricing unproven QBs as startable assets.
6. Team WAA/WAR (Teams page) = sum over each week's **actual starters**, not
   season totals of the current roster. Lineup WAA runs negative for most
   teams (measured vs the optimal pool) — that's expected, compare relatively.
7. Reference points: ~2 WAR in a 14-week season is a superstar (CMC 2025 ≈ 2);
   a 12-2 team's lineup WAA can be slightly negative — verified correct.
8. **DVI and CVI are computed under ALL SIX projection curves** —
   **2026-08-13**. `scripts/curves.py` owns the vocabulary (mirrors
   `MATRIX_CURVES` in `src/lib/types.ts`, locked by `tests/test_curves.py`) and
   the year-1 lookup into `projections_matrix.json`. `blend_values.py` and
   `contender_index.py` each split into `load_inputs()` / `compute(war_of)` /
   `to_*()`; `scripts/index_models.py` drives both across the six curves from
   ONE load (the ~19 MB Sleeper map would otherwise be read fourteen times) in
   about a second, and writes `dvi.json` + `cvi.json` on the default plus
   `index_models.json` (~181 KB) with all six.
   - **The published default is `blend_composite`**, not the scalar composite
     that was hardcoded. `--curve scalar_composite` reproduces the old numbers
     exactly — proven against the pre-refactor scripts, 393/393 on both indices,
     and locked by a test. That equivalence is what makes any future diff here
     readable: a repricing bug and an intended model change look identical
     otherwise.
   - Both indices clamp on **year-1** WAR, which is inherited and is the odd
     part of a DYNASTY index. Left alone deliberately — changing the horizon
     moves every published figure and is a separate argument from changing the
     model.
   - **`has_analog` / `has_sleeper` are claims about the PROJECTION, never about
     the figure.** 65 players have no analog cohort; their WAR is identical
     across curves in all 65 cases and their published DVI in only 4, because
     both indices clamp on percentiles of the whole field and changing the model
     reprices everyone around them. Any UI copy must read these as "no second
     opinion was measured for him", never as "this number won't move".
   - `validate_data.check_index_models` catches the quiet failure — a curve loop
     that runs six times but reads one projection, publishing six identical sets
     that look like six models agreeing. Proven to reject a file collapsed that
     way while the default stayed self-consistent.
9. **The projection model is a SITE-WIDE control** — **2026-08-13**. The
   masthead carries the one global switch on the site (`components/
   ModelPicker`, state in `lib/model.ts`): three models x two streams, driving
   DVI, CVI and projected WAR everywhere at once.
   - It lives in the masthead precisely because it is NOT view-scoped — the
     deliberate opposite of the season picker, which is per-view. A global
     control that changes figures on screens where it isn't visible is a trap;
     the masthead is on every screen, so it can't be out of sight while biting.
   - **The URL carries it** (`?m=analog_natural`), so a shared link shows the
     numbers the sender was reading. localStorage only remembers it between
     sessions, and the URL wins when they disagree. The default is stored as
     the ABSENCE of the param.
   - `lib/useIndices.ts` returns the same `DviFile`/`CviFile` shapes the screens
     already expected, so eight consumers changed by one line. Everything comes
     from `index_models.json` — one ~181 KB fetch instead of two ~37 KB ones,
     after which every model flip is free and no two screens can show different
     curves. `IndexBoard`'s `file` prop is gone: both indices come from one
     file now, so the DVI/CVI race it guarded against is impossible.
   - NOT accent-filled, unlike the design system's lens control. That pattern
     is for a control inside a view; this one sits above every view, where an
     accent would compete with each screen's headline figure.
10. **The trade machine shops one basket against many offers** —
   **2026-08-13**. The outgoing side is pinned and each offer is a return
   scored against it, so every row of the comparison table shares a
   denominator. Deltas are signed on BOTH sides, per currency, and never
   combined.
   - This is a deliberate, scoped exception to "never colour a trade". That
     rule is right for the Ledger, which records a settled fact; this screen
     evaluates a hypothetical and refusing to say who gains is refusing the
     job. What is still refused is a SINGLE verdict — DVI and CVI answer
     different questions and routinely point at different sides.
   - Worked example, sending Josh Allen: under `blend_composite` one offer led
     all three columns; under `analog_natural` the WAR leader flipped to a
     different offer while dynasty and win-now did not. The model control
     changes the answer, which is the point of shipping it.
   - The model does NOT reach picks — they are priced by Bridge A's slot/tier
     WAR and have no index or analog cohort until they convert. Said out loud
     in the screen's footnote.
11. **FINISH (final placing) is a SPLIT column** — **2026-08-12**. Places 1..N
   come from the winners bracket; places N+1.. are the regular-season
   standings, NOT the consolation bracket. The toilet bowl is a tournament a
   bad team can win, and in 2025 one did: it placed a 1-13 / 90.9 ppg roster
   8th and a 7-7 / 118.3 roster 10th. A team that made the playoffs is placed
   by the playoffs; a team that missed never got that chance and is placed by
   the season it played. Consistent with `playoff_war.py` and `playoff_wpa.py`,
   which already refuse to let consolation games into any pool. Gated on a
   DECIDED winners-bracket game, so an unplayed season still has no placings.
   Written in `build_site_data.py`; the History footnote states the split.

### Sleeper stats-feed signatures (probed 2026-07-17, verified on 2024 + 2025 data)

Per-week record shapes in `api.sleeper.app/stats/nfl/<yr>/<wk>?season_type=
regular&position[]=...` (and the per-player `stats/nfl/player/<id>` endpoint):

- **Played**: `gp`/`off_snp` + real stats. Either key can appear WITHOUT the
  other (a TE had `off_snp:4`, no `gp`; Chism 2025 wk18 had a catch with
  `off_snp:0`) — so test snaps OR stat line, never one alone.
- **Dressed, zero offensive snaps**: `gms_active:1` + `tm_off_snp/tm_def_snp/
  tm_st_snp`, no `gp`/`off_snp`, pos_rank 999. Under rule #5: DNP for QB,
  played 0.00 for RB/WR/TE.
- **IR / NFI / practice squad**: bare `gms_active:1` + pos_rank 999, no
  `tm_*_snp`. So `gms_active` fires even for IR and practice-squad players
  (verified: McCaffrey's 2024 IR weeks, Jordan Travis all of 2024) — it is
  NEVER a played signal. `tm_*_snp` presence is the dressed/not-dressed
  discriminator.
- **Game-day inactive / scratch / bye**: no record at all (null). This is the
  dash in Sleeper's UI (verified: Zach Wilson all 2024, Efton Chism 12542's
  2025 scratch weeks).
- Open: 2022-era field conventions not yet spot-checked (all probes were
  2024/2025, `company: sportradar`).

## Tests

`python -m unittest discover -s tests -v` (or `python -m pytest tests -q`) —
stdlib `unittest`, no network, no third-party runner required. Seventeen
Python files; the table covers the figure/engine core, and the rest lock
utilities and fetchers (`test_curves`, `test_fetch_ecr`, `test_fetch_values`,
`test_names`, `test_project_war_knn`, `test_shard_players`,
`test_sleeper_http`). `tests/tradeModel.test.ts` is separate — `npm test`
(Node ≥ 22.18, native type stripping, no dependencies), run in CI by
`tests.yml` — and locks the trade machine's invariants for both shells:

| File | What it locks |
|---|---|
| `test_war_engine.py` | the 108-slot pool shape, dedicated-before-flex, flex-by-points, replacement = best-left-out, average = mean-of-startable (so WAA sums to 0 per position), weekly-sigma behaviour, the VoWP waiver ladder, every branch of the played rule |
| `test_week_odds.py` | pregame only — week W is built from weeks 1..W−1, week 1 without a snapshot is left unpriced, and `--snapshot` is first-write-wins |
| `test_playoff_wpa.py` | Shapley efficiency, win-share totals, round weights, MVP vs MVP+ |
| `test_playoff_war.py` | sigma imported from the regular season, elimination games only |
| `test_value_stack.py` | DVI / CVI shares and weights, Bridge B isotonic monotonicity, Bridge A's board and outcome rule |
| `test_franchise.py` | `POS_OVERRIDE`, `FRANCHISE_BAR`, and the shape (not the exact counts) the definition produces on the committed history |
| `test_outcomes.py` | the crawl's champion / pick-holding / placement / chain-grouping logic |
| `test_slot_value.py` | lineup-slot pricing: median not mean, hit rate against the position's bar |
| `test_aging_curves.py` | the aging-curve fit's production weighting — a season a player dressed for but produced nothing must not count as a full observation of what players like him do next year. `MIN_GP` used to enforce that by filtering on `gp`; the played rule redefined `gp` from "games he produced in" to "games he dressed for" and silently disabled the gate |
| `test_projection_matrix.py` | the six-curve projection matrix stays six curves — it exists to publish a DISAGREEMENT between two models, so these lock down the decisions that stop the curves collapsing into one number or a composite landing where none of its inputs support |

Most tests are pure and synthetic. **Some are not, and do not run in CI:**
eight are gated on `sleeper_data/` or a local crawl artefact, both gitignored,
so they are skipped on every clone and on every CI run. They execute only on a
machine that has done a `sleeper_pull.py` / crawl first. `python -m pytest
tests -q` reporting "8 skipped" is the normal, expected result — CI does not
cover those paths, and each affected file says so in its docstring.

These cover the settled methodology, not implementation detail. **A failure
here is a change in what a figure means**, not a broken test — if one fails,
decide whether the methodology moved on purpose before touching the test.

## WAR valuation model (shipped; see HANDOFF.md for open threads)

Aging curves, pick-value bridges, projections and the trade/draft analyses are
built and wired into `data-refresh.yml`; the Draft and Trades views render them.
Settled shape: every asset (player or pick) → expected future WAR stream;
per-team discount δ ≈ 0.6-0.8 collapses streams to numbers; trade = Σ streams
in vs out. Pick slots priced via two bridges — A: empirical realized-WAR vs
draft slot; B: market-implied (KTC/FantasyCalc value→WAR) — blended by sample
confidence + pick maturity. Player streams need per-position aging curves fit
on 2014+ historical WAR (`nfl_history/` CSVs from war-history.yml).

## Site features (all shipped)

- **Players**: sortable leaderboard (GP/Pts/PPG/σ/WAA/WAA-G/WAR/WAR-G), pos
  filter, search, min-GP filter defaulting to 45% of max GP; All-time mode
  aggregates careers. Row dropdown = weekly table, box plot, ownership history.
- **Player pages** (`#/player/:pid`): career totals, per-season summary table,
  career box plot, ownership history (drafted/traded/waivers with full trade
  packages), season-by-season weekly tables.
- **Teams**: sortable (Seed/Record/vs-Median/PPG/σ/WAA/WAR), row dropdown =
  weekly matchups + lineup WAR + top/bottom 5 by WAR; team name → full roster
  page with START/TAXI/IR tags. "vs Median" = record vs each week's league
  median score (schedule-luck detector).
- **Weekly**: per week biggest WAR + lowest WAR among *started* players; row
  dropdown = top 5 per position; week number → week page (all matchups with
  winners + lineup WAR, top-50 performers).
- **Draft** (`#/draft`, not season-scoped): realized WAR by pick slot and by
  tier, with per-year and 3-year box plots and a median/IQR trajectory chart.
- **Trades** (`#/trades`, not season-scoped): every trade with each side's
  return scored in WAR.
- Every chart is hand-rolled SVG; there is no charting library in the bundle.
  They share `components/BoxMarks.tsx` (five-number summary + box geometry +
  `AXIS` colour) and `lib/useWidth.ts`; callers own their own axes and labels.
- Methodology lives in a collapsed footer, with KTC/FantasyCalc attribution.
- Season box plots share one axis from `meta.ptsRange` with dashed, labeled
  boundary lines at the domain min/max (2026-07-17).
- **Market values** (player pages only, not leaderboards): daily
  `values-refresh.yml` workflow (no Sleeper calls) pulls FantasyCalc API +
  KeepTradeCut page scrape into `data/values.json` + `values_history.json`.
  Grid shows per source: value, ≈ closest draft pick, OVR, pos rank, and
  7/14/30-day deltas (computed from our own daily snapshots for aligned
  windows; native trends as fallback; N/A until history accrues).
  DECISION: deltas are raw VALUE only — Max explicitly does not want rank
  deltas ("less meaningful"). Position badge on player pages shows WAR rank
  from the most recent season with data (auto-rolls to 2026).

## Known bugs / caveats (tracked, not yet fixed)

1. ~~0.00 vs DNP conflation~~ **FIXED**. The rule has since moved off the
   2026-07-17 position split to the position-independent 2026-08-07 form (see
   methodology #5). Played maps regenerate on the next data-refresh run.
2. All-time "Roster" column attributes players to their **current** owner only.
3. Sleeper rate limit: stay under ~1000 calls/min; the ~19 MB `players/nfl`
   map at most once per day. That one call is why the PLAYER MAP fetch is
   weekly (`players-refresh.yml`, Tuesdays) and cached — the data refresh
   itself runs daily off that cache, and deploy is separate again because it
   never calls Sleeper at all.

## Roadmap (Max's stated priorities)

1. **WAR valuation model / value analysis** — aging curves → pick-value
   bridges → trade analyzer (see section above + HANDOFF.md).
2. **Trade analyzer** — traded picks + ownership + WAR data already collected.
3. More interactive charts as ideas arise (hand-rolled SVG — adding a charting
   library would be a deliberate reversal, not a default).
4. Minor: all-time Roster column (bug #2).
5. **Team pages — franchise lineage.** A franchise is keyed by `roster_id`
   (stable across seasons), and its name/owner can change year to year. Team
   pages should aggregate by `roster_id` and show the full name history as one
   continuous team. Known lineage: roster 9 = PicklesPapa (2022-23, note 2023
   was a Sleeper name gap patched via name_override in build_site_data) →
   Dchaillier10 / "Captain Jah'Merica" (2024-26) — same team, maintain the
   lineage.
6. **Multi-league / "any league" support (long term — parked 2026-07-20).**
   Version A (a chosen handful of leagues) needs no new infrastructure: the
   pipeline is league_id-parameterized, so run it over a list and write
   `data/<league_id>/...` + a league switcher. Version B (anyone enters a
   league_id) is the goal, built on the insight that raw weekly stat lines are
   league-independent: pull them ONCE into a shared store (document DB — Mongo
   or Postgres JSONB — fits the JSON shape), then a league costs only its
   settings + light pulls (matchups/rosters/transactions/drafts) and points =
   Σ scoring_settings[k] × stat[k]. Compute layer re-scores and runs the WAR
   engine with the pool derived from `roster_positions` + team count instead
   of the hardcoded 108 superflex slots. Caveats: scoring reimplementation
   must be exactly faithful (bonuses, TE premium); nfl_history curves are
   superflex-shaped, so projections approximate for other formats until refit.
   First step when picked up: validation spike — re-score Big Dog itself from
   raw stats × our own scoring_settings and diff against Sleeper's
   `players_points`; reconciling a full season proves the thesis and yields
   the scoring engine. Not before the current feature work is done.

## Working conventions (from Max)

- Ask before acting on non-trivial changes; one actionable item per turn.
- Concise replies; options written in text, not selectable widgets.
- Docs in markdown. TypeScript on the front end.
- Max runs git himself — stage specific files (repo has line-ending noise that
  shows unrelated files as modified; don't blind `git add -A` unless everything
  really changed).
- Local repo folder is the connected workspace; edit files there directly,
  then give Max the git commands.
- Dev loop: edit → `npx tsc --noEmit` → `python -m unittest discover -s tests`
  → `npm run build`. Vite build does NOT typecheck; CI now runs both gates
  (`tests.yml`, and `deploy.yml` typechecks before building), but run them
  locally first — a red deploy still means a red site.
- Prefer running Cowork sessions ON Max's computer (direct folder + network
  access); cloud sessions can't write `.github/workflows/` or reach
  api.sleeper.app / nflverse downloads directly.

## Related tooling (outside the repo)

- **sleeper-api skill** (installed in Claude): full Sleeper HTTP API reference.
- `sleeper_pull.py` / `sleeper_war.py` also work standalone on any machine:
  `python sleeper_pull.py <league_id> --players --out <dir>` then
  `python sleeper_war.py --data <dir>`.
- Historical WAR standalone: `pip install nflreadpy`, then
  `python scripts/nfl_history.py --start 2014 --end 2025` and
  `python scripts/sleeper_war.py --data nfl_history_data`.
