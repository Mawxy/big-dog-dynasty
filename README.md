# Big Dog Dynasty — WAR Board

A self-updating stats and valuation site for Sleeper fantasy leagues: WAR/WAA
tables, franchise pages, weekly and playoff breakdowns, projections, dynasty
and contender value indices, pick values, a trade machine and a trade ledger,
all computed from each league's exact scoring and lineup rules. Home league is
**Big Dog Dynasty** (12-team superflex dynasty); **Pineapple Pizza FFL**
(redraft) rides along on the same pipeline. Data refreshes **nightly** via
GitHub Actions.

- **Live site:** https://www.bigdogdynasty.app
- **Every figure explained:** [METHODOLOGY.md](METHODOLOGY.md) — what it
  measures, how it is built, what it ignores, and where it breaks down.
- **Working notes for new sessions:** [PROJECT_NOTES.md](PROJECT_NOTES.md).

## Architecture

```
Sleeper API ─► scripts/sleeper_pull.py ─► sleeper_data/           raw dump (gitignored)
               scripts/sleeper_war.py  ─► sleeper_data/analysis/  WAA/WAR per player-week
               scripts/build_site_data.py ─► data/leagues/<key>/   compact JSON (committed)
               pick_value · draft_analysis · playoff_wpa · playoff_war · season_wpa
               fetch_projections · week_odds · project_war · project_points --site
               value_bridge · project_war_knn · project_matrix · trade_analysis
               nfl_features · usage_stats · shard_players · index_models
               validate_data                                       gate before commit

nflverse ─► scripts/nfl_history.py ─► same WAR engine ─► nfl_history/*.csv   2012+ (committed)
                                       nfl_features.py ─► features_<yr>.csv, features_weekly_<yr>.csv
                                       aging_curves.py ─► nfl_history/aging_curves.json
            (1999–2011 WAR and 1999–2013 features live in nfl_history/early/)

Sleeper (other leagues) ─► scripts/sleeper_crawl.py ─► data/*_signals.json, corpora
KTC / FantasyCalc / FantasyPros ─► fetch_values · fetch_ecr ─► data/values.json, data/ecr.json
nflverse ─► espn_ids.py ─► data/espn_ids.json (headshots) · vig_model.py ─► data/vig_model.json

src/ (Vite + React 18 + TypeScript) reads data/**/*.json ─► GitHub Pages
```

- **Multi-league.** `data/leagues.json` is the registry. Each league is keyed
  by its *founding* Sleeper league_id (Big Dog `814608002207334400`, alias
  `big-dog`), because Sleeper mints a new id every season; the current-season
  ids live in `data-refresh.yml` and must be updated by hand each September.
- **Two shells on one data set.** The phone-first board answers the bare
  league address — `#/big-dog/...` — and the classic desktop board lives at
  `#/big-dog/classic/...` (so `#/big-dog/classic/stats/2025`). Old addresses,
  including `#/big-dog/beta/…` and the pre-league `#/stats/2025`, redirect.
  Both shells share every number; the trade math (`src/lib/tradeModel.ts`) is
  one module under test for both.
- **The front end reads committed JSON, with one exception.** Everything is
  built by GitHub Actions and you never need Node locally — except live
  scoring: while an NFL week is in progress the League screen calls Sleeper's
  and ESPN's public endpoints from the browser so the cards move during games.

## Workflows

| Workflow | When (UTC) | Does | Commits |
|---|---|---|---|
| `data-refresh.yml` | daily 06:17 | tests → pull both leagues → WAR → build → every model step → validate | `data/leagues/**`, `data/leagues.json`, `data/values.json`, `nfl_history/features_*.csv` → deploy |
| `values-refresh.yml` | daily 11:23 | KTC + FantasyCalc + FantasyPros ECR, Bridge B | `data/values*.json`, `data/ecr.json`, `data/leagues/*/value_bridge.json` → deploy |
| `players-refresh.yml` | Tuesdays 05:38 | the ~19 MB Sleeper player map into the Actions cache, then the nflverse → ESPN id join | `data/espn_ids.json` |
| `deploy.yml` | push to `main` (minus files the site never fetches), manual, or called | typecheck → build → copy `data/` minus pipeline-only files → Pages | nothing |
| `tests.yml` | push to `main`, PRs | Python invariants (8 expected skips) + `tsc` + `npm test` | nothing |
| `war-history.yml` | manual | nflverse → league-shaped WAR and skill features, 1999+ | `nfl_history/` |
| `crawl-signals.yml` | 00/06/12/18 at :11 | discover dynasty leagues; roster % / start % | `data/league_signals.json`, `data/crawl_leagues.json` |
| `crawl-signals-redraft.yml` | 03/09/15/21 at :29 | same for redraft leagues (CVI input) | `data/*_redraft.json` |
| `crawl-drafts.yml` | 02/08/14/20 at :47 | startup / rookie ADP, the Bridge A pick corpus | `data/draft_*.json`, `data/rookie_pick_corpus.json` |
| `crawl-trades.yml` | odd hours at :13 | 4-shard trade corpus → dynasty movers | `data/dynasty_movers.json`, `data/recent_trades/*.json`, `data/tep_map.json` → deploy |
| `crawl-outcomes.yml` | 03/15 at :07 | 4-shard championship benchmarks | `data/outcome_signals_*.json`, `data/benchmarks.json` |

Every committing job re-parents onto `origin/main` and stages an explicit
allow-list — never `git add data`. The **four** pipeline jobs (`data-refresh`,
`values-refresh`, `war-history`, `players-refresh`) share the `data-push`
concurrency group; the crawls each own their own so a five-hour crawl cannot
block the nightly refresh.

## One-time setup

Pages must deploy from the workflow, not the branch:
**Settings → Pages → Source: "GitHub Actions".**

## Local development (optional)

```
npm install
npm run dev          # dev server with hot reload (copy data/ into the served root or symlink it)
npm run typecheck    # tsc --noEmit on src/, then tsconfig.test.json — Vite does NOT typecheck
npm test             # tests/tradeModel.test.ts under node --test (Node ≥ 22.18)
npm run build        # production build into dist/
python -m unittest discover -s tests      # engine invariants
python scripts/validate_data.py           # published-data consistency
```

The pipeline scripts run standalone on any machine:
`python scripts/sleeper_pull.py <league_id> --players --out <dir>` then
`python scripts/sleeper_war.py --data <dir>`. Historical WAR needs
`pip install nflreadpy`; the projection models need the pinned stack in
`requirements-ci.txt`.

## Notes

- The crons above are **schedule requests, not promises** — GitHub starts
  scheduled runs late under load, sometimes by hours, so the site says "Rebuilt
  nightly" with the build stamp rather than a clock time. Minutes are
  deliberately off the hour (`:00` is Actions' most congested slot).
- Both the deploy and the tests run on Node 22 (`engines.node: >=22.18`).
- The methodology decisions are locked by `tests/` — a failure there is a
  change in what a figure *means*, not a broken build.
- Market data: KeepTradeCut, FantasyCalc, FantasyPros (attributed in the site
  footer). Analytics: GoatCounter, pageviews only, no cookies.
