# Big Dog Dynasty — WAR Board

A self-updating website for the league: player WAR/WAA tables, team pages,
weekly breakdowns, and all-time career stats, computed from the league's exact
Sleeper scoring and lineup rules. Data refreshes automatically every
**Wednesday at 1:00 AM Eastern** via GitHub Actions.

## Architecture

- **Data pipeline (Python, `scripts/`)** — unchanged from v1:
  `sleeper_pull.py` dumps the full league history from the Sleeper API,
  `sleeper_war.py` computes weekly WAA/WAR per player,
  `build_site_data.py` packs everything into compact JSON under `data/`.
- **Front end (Vite + React + TypeScript, `src/`)** — reads only `data/*.json`,
  never calls Sleeper. Built by GitHub Actions; you never need Node locally.
- **One workflow (`.github/workflows/update.yml`)** does everything:
  - Wednesdays 1 AM ET (and manual runs): refresh data → commit → build → deploy
  - Any push to `main`: build → deploy (no data refresh)

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

- Cron `0 6 * * 3` = 06:00 UTC Wednesday = 1:00 AM EST (2:00 AM EDT).
- The league ID lives in `update.yml`.
- WAR/WAA methodology is documented on the site footer and in `scripts/sleeper_war.py`.
