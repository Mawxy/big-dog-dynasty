# Big Dog Dynasty — WAR Board

A self-updating stats and valuation site for Sleeper fantasy leagues: WAR/WAA
tables, franchise pages, weekly and playoff breakdowns, projections, dynasty
and contender value indices, pick values, a trade machine and a trade ledger,
all computed from each league's exact scoring and lineup rules. Home league is
**Big Dog Dynasty** (12-team superflex dynasty); **Pineapple Pizza FFL**
(redraft) rides along on the same pipeline. Data refreshes automatically
**every day at 1:00 AM Eastern** via GitHub Actions.

- **Live site:** https://mawxy.github.io/big-dog-dynasty/
- **Every figure explained:** [METHODOLOGY.md](METHODOLOGY.md) — what it
  measures, how it is built, what it ignores, and where it breaks down.
- **Working notes for new sessions:** [PROJECT_NOTES.md](PROJECT_NOTES.md).

## Architecture

```
Sleeper API ─► scripts/sleeper_pull.py ─► sleeper_data/           raw dump (gitignored)
               scripts/sleeper_war.py  ─► sleeper_data/analysis/  WAA/WAR per player-week
               scripts/build_site_data.py ─► data/leagues/<key>/   compact JSON (committed)
               pick_value · draft_analysis · trade_analysis · playoff_wpa · playoff_war
               fetch_projections · week_odds · project_war · value_bridge
               project_war_knn · project_matrix · shard_players · index_models
               validate_data                                       gate before commit

nflverse ─► scripts/nfl_history.py ─► same WAR engine ─► nfl_history/*.csv   2012+ (committed)
                                       aging_curves.py ─► nfl_history/aging_curves.json

Sleeper (other leagues) ─► scripts/sleeper_crawl.py ─► data/*_signals.json, corpora
KTC / FantasyCalc / FantasyPros ─► fetch_values · fetch_ecr ─► data/values.json, data/ecr.json

src/ (Vite + React 18 + TypeScript) reads data/**/*.json only ─► GitHub Pages
```

- **Multi-league.** `data/leagues.json` is the registry. Each league is keyed
  by its *founding* Sleeper league_id (Big Dog `814608002207334400`, alias
  `big-dog`), because Sleeper mints a new id every season; the current-season
  ids live in `data-refresh.yml` and must be updated by hand each September.
  Routes are league-first: `#/big-dog/stats/2025`.
- **Two shells on one data set.** The classic board and a phone-first **beta**
  shell (`#/<league>/beta/…`) share every number; the trade maths
  (`src/lib/tradeModel.ts`) is one module under test for both.
- **The front end never calls Sleeper.** Built by GitHub Actions; you never
  need Node locally.

## Workflows

| Workflow | When | Does | Commits |
|---|---|---|---|
| `data-refresh.yml` | daily 06:00 UTC | tests → pull both leagues → WAR → every model step → validate | `data/leagues/**`, `data/leagues.json`, `data/values.json` → deploy |
| `values-refresh.yml` | daily 11:00 UTC | KTC + FantasyCalc + FantasyPros ECR, Bridge B | `data/values*.json`, `data/ecr.json`, `data/leagues/*/value_bridge.json` → deploy |
| `players-refresh.yml` | Tuesdays 05:00 UTC | the ~19 MB Sleeper player map, into the Actions cache | nothing |
| `deploy.yml` | push to `main` (minus crawl corpora), manual, or called | typecheck → build → copy `data/` (minus corpora) → Pages | nothing |
| `tests.yml` | push to `main`, PRs | Python invariants (8 expected skips) + `tsc` + `npm test` | nothing |
| `war-history.yml` | manual | nflverse → league-shaped WAR 2012+ | `nfl_history/` |
| `crawl-signals.yml` | every 6 h | discover dynasty leagues; roster % / start % | `data/league_signals.json`, `data/crawl_leagues.json` |
| `crawl-signals-redraft.yml` | every 6 h (offset 3 h) | same for redraft leagues (CVI input) | `data/*_redraft.json` |
| `crawl-drafts.yml` | 4× daily | startup / rookie ADP, the Bridge A pick corpus | `data/draft_*.json`, `data/rookie_pick_corpus.json` |
| `crawl-trades.yml` | every 2 h | 4-shard trade corpus → dynasty movers | `data/dynasty_movers.json`, `data/tep_map.json` → deploy |
| `crawl-outcomes.yml` | 2× daily | 4-shard championship benchmarks | `data/outcome_signals_*.json`, `data/benchmarks.json` |

Every committing job re-parents onto `origin/main` and stages an explicit
allow-list — never `git add data`. The three pipeline jobs share the
`data-push` concurrency group; the crawls each own their own so a five-hour
crawl cannot block the nightly refresh.

## One-time setup

Pages must deploy from the workflow, not the branch:
**Settings → Pages → Source: "GitHub Actions".**

## Local development (optional)

```
npm install
npm run dev          # dev server with hot reload (copy data/ into the served root or symlink it)
npm run typecheck    # tsc --noEmit — Vite does NOT typecheck
npm test             # tests/tradeModel.test.ts under node --test (Node ≥ 22.18)
npm run build        # production build into dist/
python -m unittest discover -s tests      # engine invariants
python scripts/validate_data.py           # published-data consistency
```

The pipeline scripts run standalone on any machine:
`python scripts/sleeper_pull.py <league_id> --players --out <dir>` then
`python scripts/sleeper_war.py --data <dir>`. Historical WAR needs
`pip install nflreadpy`.

## Notes

- Cron `0 6 * * *` = 06:00 UTC = 1:00 AM EST / 2:00 AM EDT. The player map is
  `0 5 * * 2` (Tuesdays). Deploy builds on Node 20; tests run on Node 22.
- The methodology decisions are locked by `tests/` — a failure there is a
  change in what a figure *means*, not a broken build.
- Market data: KeepTradeCut, FantasyCalc, FantasyPros (attributed in the site
  footer). Analytics: GoatCounter, pageviews only, no cookies.
