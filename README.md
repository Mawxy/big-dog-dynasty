# Big Dog Dynasty — WAR Board

A self-updating website for the league: player WAR/WAA tables, team pages,
weekly breakdowns, and all-time career stats, computed from the league's exact
Sleeper scoring and lineup rules. Data refreshes automatically every
**Wednesday at 1:00 AM Eastern** via GitHub Actions.

## How the numbers work

**[METHODOLOGY.md](METHODOLOGY.md)** documents every published figure — what it
measures, how it is built, what it deliberately ignores, and where it breaks
down: WAR/WAA, VoWP, team win probability, playoff WPA, win share, MVP and
MVP+, playoff WAR, projections, DVI, CVI, and the two pick-value bridges.

## Architecture

- **Data pipeline (Python, `scripts/`)** — unchanged from v1:
  `sleeper_pull.py` dumps the full league history from the Sleeper API,
  `sleeper_war.py` computes weekly WAA/WAR per player,
  `build_site_data.py` packs everything into compact JSON under `data/`.
- **Front end (Vite + React + TypeScript, `src/`)** — reads only `data/*.json`,
  never calls Sleeper. Built by GitHub Actions; you never need Node locally.
- **Two workflows:**
  - `deploy.yml` — build & deploy. Runs on every push to `main` (and manually).
    Never touches the Sleeper API, so rebuild as often as you like.
  - `data-refresh.yml` — Wednesdays 1 AM ET (and manually): pulls Sleeper,
    recomputes WAR, commits `data/`, then calls the deploy workflow.

## One-time setup change for v2

Pages must deploy from the workflow now, not the branch:
**Settings → Pages → Source: “GitHub Actions”.**

## Local development (optional)

```
npm install
npm run dev        # dev server with hot reload (copy data/ into the served root or symlink it)
npm run typecheck  # TypeScript check
npm run build      # production build into dist/
```

## Notes

- Cron `0 6 * * 3` = 06:00 UTC Wednesday = 1:00 AM EST (2:00 AM EDT), in `data-refresh.yml`.
- The league ID lives in `data-refresh.yml`.
- Every figure's methodology is in [METHODOLOGY.md](METHODOLOGY.md); each
  engine's docstring is the deeper reference.
- The methodology decisions are locked by `tests/` — a failure there is a
  change in what a figure *means*, not a broken build.
