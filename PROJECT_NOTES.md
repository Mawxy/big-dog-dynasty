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
                                                 │
src/ (Vite + React 18 + TypeScript) ────────────┴──> GitHub Pages

nflverse ──> scripts/nfl_history.py ──> nfl_history_data/  (gitignored)
             └─ same sleeper_war.py engine ──> nfl_history/*.csv (committed)
```

- **Front end** reads only `data/*.json` — never calls Sleeper. React Router
  (HashRouter) URLs: `#/players/:season`, `#/teams/:season[/:rid]`,
  `#/weekly/:season[/:wk]`, `#/player/:pid`; season segment `all` = All-time.
- **GitHub Actions workflows:**
  - `deploy.yml` — build & deploy on every push to `main` (also manual /
    `workflow_call`). No Sleeper calls; safe to run constantly.
  - `data-refresh.yml` — Wednesdays 06:00 UTC (1 AM ET) + manual: pulls Sleeper,
    recomputes WAR, commits `data/`, then calls deploy.
  - `values-refresh.yml` — daily: FantasyCalc + KTC market values, no Sleeper.
  - `war-history.yml` — manual: nflverse → league-shaped WAR for 2014+ via
    `scripts/nfl_history.py` + unchanged engine; commits `nfl_history/*.csv`
    (analysis CSVs + players_meta.csv with birth dates and draft slots).
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
5. **Played rule (SETTLED 2026-07-17, position-dependent — Max's ruling)**:
   - **QB**: offensive participation only — `off_snp > 0` OR a real offensive
     stat line. A dressed backup QB with zero snaps is **DNP** (Malik Willis
     2025 wk1, Bagent's 2024 backup weeks). Rationale: QB is the one position
     with a clear starter who takes every snap, so merely dressing carries no
     start-worthiness signal.
   - **RB / WR / TE**: **dressed = played**. Any record beyond the bare
     `gms_active` placeholder (i.e., `gp`, `off_snp`, `st_snp`, or `tm_*_snp`
     present) counts as played; a dressed zero-point game accrues negative
     value. Rationale: these positions rotate — a dressed player who gave you
     nothing is a real 0.00, not an absence.
   - Byes, game-day inactives, and IR/NFI/practice-squad (bare `gms_active`
     records) are excluded (DNP) for all positions.
   - Saved as `<season>/played/week_NN.json` by sleeper_pull; sleeper_war
     falls back to "0.00 = DNP" if played files are absent.
   - IMPLEMENTED in `sleeper_pull.row_played()` and mirrored in
     `nfl_history.row_played_hist()` (2026-07-17; commit + data-refresh rerun
     may still be pending — check git log).
   - History: an earlier all-positions "startability" rule (dressed = played
     for everyone) and an all-positions "participation" rule (off_snp only for
     everyone) were both considered and rejected in favor of this split.
6. Team WAA/WAR (Teams page) = sum over each week's **actual starters**, not
   season totals of the current roster. Lineup WAA runs negative for most
   teams (measured vs the optimal pool) — that's expected, compare relatively.
7. Reference points: ~2 WAR in a 14-week season is a superstar (CMC 2025 ≈ 2);
   a 12-2 team's lineup WAA can be slightly negative — verified correct.

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

## WAR valuation model (in progress — see HANDOFF.md for pickup point)

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

1. ~~0.00 vs DNP conflation~~ **FIXED**, including the 2026-07-17
   position-split refinement (see methodology #5). Played maps regenerate on
   the next data-refresh run after the split is pushed.
2. All-time "Roster" column attributes players to their **current** owner only.
3. Sleeper rate limit: stay under ~1000 calls/min; the 5MB `players/nfl` map
   at most once per day (why data refresh is weekly and deploy is separate).

## Roadmap (Max's stated priorities)

1. **WAR valuation model / value analysis** — aging curves → pick-value
   bridges → trade analyzer (see section above + HANDOFF.md).
2. **Trade analyzer** — traded picks + ownership + WAR data already collected.
3. More interactive charts as ideas arise (recharts in the bundle).
4. Minor: all-time Roster column (bug #2).

## Working conventions (from Max)

- Ask before acting on non-trivial changes; one actionable item per turn.
- Concise replies; options written in text, not selectable widgets.
- Docs in markdown. TypeScript on the front end.
- Max runs git himself — stage specific files (repo has line-ending noise that
  shows unrelated files as modified; don't blind `git add -A` unless everything
  really changed).
- Local repo folder is the connected workspace; edit files there directly,
  then give Max the git commands.
- Dev loop: edit → `npx tsc --noEmit` → `npm run build` (Vite build does NOT
  typecheck — always run tsc manually).
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
