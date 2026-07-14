# Big Dog Dynasty — WAR Board

A self-updating website for the league: player WAR/WAA tables, team pages, and
weekly drill-downs, computed from the league's exact Sleeper scoring and lineup
rules. Data refreshes automatically every **Wednesday at 1:00 AM Eastern** via
GitHub Actions — no server, no maintenance.

## One-time setup (about 5 minutes)

1. **Create the repo.** On GitHub click *New repository*, name it anything
   (e.g. `big-dog-dynasty`), set it to **Public** (required for free GitHub
   Pages), and create it.

2. **Upload these files.** Either push this folder with git, or on the repo
   page use *Add file → Upload files* and drag everything in (`index.html`,
   `README.md`, `.gitignore`, the `scripts` folder, and the `.github` folder —
   make sure the `.github/workflows/update.yml` path survives the upload).

3. **Allow the workflow to commit.** Repo *Settings → Actions → General →
   Workflow permissions* → select **Read and write permissions** → Save.

4. **Run the first update.** *Actions* tab → *Weekly WAR update* → *Run
   workflow*. Takes a few minutes (it pulls all seasons and the player
   database). When it finishes, a `data/` folder appears in the repo.

5. **Turn on the website.** *Settings → Pages* → Source: *Deploy from a
   branch* → Branch: `main`, folder `/ (root)` → Save. After a minute the site
   is live at `https://<your-username>.github.io/<repo-name>/`.

Share that URL with the league. Every Wednesday at 1 AM ET the numbers refresh
themselves (you can also rerun manually from the Actions tab anytime).

## What's in here

| File | Purpose |
| --- | --- |
| `scripts/sleeper_pull.py` | Dumps the full league history (all seasons, matchups, drafts) from the Sleeper API to JSON |
| `scripts/sleeper_war.py` | Computes weekly WAA/WAR per player from the dump |
| `scripts/build_site_data.py` | Packs results into the compact JSON the site reads |
| `.github/workflows/update.yml` | The Wednesday 1 AM ET schedule (`0 6 * * 3` UTC) |
| `index.html` | The entire website — reads only `data/*.json`, never calls Sleeper |
| `data/` | Generated league data (created by the workflow) |

## Notes

- The cron is `0 6 * * 3` = 06:00 UTC Wednesday = 1:00 AM EST (2:00 AM during
  daylight saving). Edit `update.yml` to change it.
- The league ID lives in `update.yml` — change it there if the league chain
  ever gets a new ID.
- Methodology for WAR/WAA is documented on the site's *Methodology* tab and in
  the `sleeper_war.py` docstring.
