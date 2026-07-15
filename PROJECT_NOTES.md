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
```

- **Front end** reads only `data/*.json` — never calls Sleeper. React Router
  (HashRouter) URLs: `#/players/:season`, `#/teams/:season[/:rid]`,
  `#/weekly/:season[/:wk]`, `#/player/:pid`; season segment `all` = All-time.
- **Two GitHub Actions workflows:**
  - `deploy.yml` — build & deploy on every push to `main` (also manual /
    `workflow_call`). No Sleeper calls; safe to run constantly.
  - `data-refresh.yml` — Wednesdays 06:00 UTC (1 AM ET) + manual: pulls Sleeper,
    recomputes WAR, commits `data/`, then calls deploy.
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
5. **0.00-point weeks = DNP** (bye/injury): no game played, no PAA/PAR accrued.
6. Team WAA/WAR (Teams page) = sum over each week's **actual starters**, not
   season totals of the current roster. Lineup WAA runs negative for most
   teams (measured vs the optimal pool) — that's expected, compare relatively.
7. Reference points: ~2 WAR in a 14-week season is a superstar (CMC 2025 ≈ 2);
   a 12-2 team's lineup WAA can be slightly negative — verified correct.

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
- Methodology lives in a collapsed footer.

## Known bugs / caveats (tracked, not yet fixed)

1. **0.00 vs DNP conflation**: Sleeper `players_points` can't distinguish
   played-and-scored-0.00 from bye/inactive. Fix path: pull the undocumented
   weekly stats endpoint (`api.sleeper.app/v1/stats/nfl/regular/<yr>/<wk>`),
   use "has stat line" as the played signal; also enables a "started a ghost"
   flag for lineup blunders. ~18 extra calls/season in sleeper_pull.py.
2. All-time "Roster" column attributes players to their **current** owner only.
3. Sleeper rate limit: stay under ~1000 calls/min; the 5MB `players/nfl` map
   at most once per day (why data refresh is weekly and deploy is separate).

## Roadmap (Max's stated priorities)

1. **Interactive charts** — recharts is already in package.json, unused.
   Ideas: weekly WAR lines per player, team score distributions, WAR over time.
2. **Value analysis** — TBD with Max.
3. **Trade analyzer** — traded picks + ownership + WAR data already collected.
4. Fix known bug #1 above at some point.

## Working conventions (from Max)

- Ask before acting on non-trivial changes; one actionable item per turn.
- Concise replies; options written in text, not selectable widgets.
- Docs in markdown. TypeScript on the front end.
- Max runs git himself — stage specific files (repo has line-ending noise that
  shows unrelated files as modified; don't blind `git add -A` unless everything
  really changed).
- Local repo folder is the connected workspace; edit files there directly,
  then give Max the git commands.
- Dev loop: edit in sandbox, `npx tsc --noEmit`, `npm run build`, then sync
  `src/` to the repo folder.

## Related tooling (outside the repo)

- **sleeper-api skill** (installed in Claude): full Sleeper HTTP API reference.
- `sleeper_pull.py` / `sleeper_war.py` also work standalone on any machine:
  `python sleeper_pull.py <league_id> --players --out <dir>` then
  `python sleeper_war.py --data <dir>`.
