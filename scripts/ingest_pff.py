#!/usr/bin/env python3
"""
Ingest PFF Premium Stats CSV exports and publish role LABELS derived from them.

THE WEEKLY ROUTINE (Max, 2026-09-30): export the Receiving Summary,
Receiving Scheme, Rushing Summary, Passing Summary and Passing Pressure reports
from PFF in your own browser (any you skip keep their stored copy), then
double-click ingest_pff.bat at the repo root. Nothing here logs into PFF or
scripts the account; it only picks up files you already downloaded.

THE RAW EXPORTS NEVER LEAVE THIS PC. PFF's Terms of Use (sec. 1.2, 1.5(f))
license Premium Stats for personal use and bar redistributing or publicly
displaying them, and this repo is public. So data/pff/<season>/ is gitignored,
and the only thing committed is data/pff/roles_<season>.json: one categorical
label per receiver (slot / mixed / perimeter for WRs, inline / move for TEs)
with no PFF numbers in it. Max decided on 2026-09-30 to publish the labels,
knowing they are derived from PFF charting.

What a run does:
  1. scans your Downloads folder for CSVs modified in the last --days days;
  2. identifies each one by its HEADER, not its name (PFF names them
     receiving_summary.csv, receiving_summary (1).csv, ... and the name alone
     can't tell a summary from a scheme export);
  3. keeps the newest file of each kind and validates it (required columns,
     row count, positions, 32 teams, rates in 0..100);
  4. refuses an export that is OLDER than the one already stored (its max
     games played went down) unless --force;
  5. stores it LOCALLY at data/pff/<season>/<kind>.csv (gitignored);
  6. rebuilds data/pff/roles_<season>.json from the receiving summary and, if
     the labels changed, commits ONLY that file and pushes. The push fires
     .github/workflows/pff-ingest.yml.

  python scripts/ingest_pff.py               # scan Downloads, ingest, push
  python scripts/ingest_pff.py --no-push     # ingest and commit, don't push
  python scripts/ingest_pff.py --dry-run     # report only, write nothing
  python scripts/ingest_pff.py --from DIR    # scan DIR instead of Downloads
  python scripts/ingest_pff.py --check       # validate the committed labels (CI)

Stdlib only, so it runs on a bare Windows Python and in the CI invariants step.
"""
import argparse
import csv
import datetime as dt
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PFF_DIR = ROOT / "data" / "pff"

# Each kind is identified by its header. `required` must all be present;
# `marker` is the column that tells kinds apart (the summary and scheme exports
# share the identity columns). Add a kind here to ingest another PFF report.
IDENTITY = ["player", "player_id", "position", "team_name", "player_game_count"]
KINDS = {
    "receiving_summary": {
        "marker": "slot_rate",
        "required": IDENTITY + [
            "routes", "route_rate", "targets",
            "slot_rate", "slot_snaps", "wide_rate", "wide_snaps",
            "inline_rate", "inline_snaps",
        ],
        "rates": ["slot_rate", "wide_rate", "inline_rate", "route_rate"],
        "positions": {"WR", "TE", "HB"},
        "min_rows": 150,          # a full-league receiving export is ~340 rows
    },
    "receiving_scheme": {
        "marker": "man_routes",
        "required": IDENTITY + [
            "man_routes", "man_targets", "man_yards", "man_yprr",
            "zone_routes", "zone_targets", "zone_yards", "zone_yprr",
        ],
        "rates": ["man_route_rate", "zone_route_rate"],
        "positions": {"WR", "TE", "HB"},
        "min_rows": 150,
    },
    # Only players with a carry appear, so it is shorter (~175 rows through
    # three weeks) and WRs/TEs are sparse; QBs and RBs are what must be there.
    # elusive_rating is NOT a rate: it runs past 100 on tiny samples.
    "rushing_summary": {
        "marker": "gap_attempts",
        "required": IDENTITY + [
            "attempts", "yards", "touchdowns", "run_plays",
            "gap_attempts", "zone_attempts", "designed_yards",
            "scrambles", "scramble_yards", "yards_after_contact",
            "routes", "targets", "receptions", "rec_yards",
        ],
        "rates": ["breakaway_percent"],
        "positions": {"HB", "QB"},
        "min_rows": 100,
    },
    # QB reports: one row per passer, so ~53 rows through three weeks and at
    # least one per club. The two share identity columns but neither carries
    # the other's marker: the pressure export has pressure_/no_pressure_/
    # blitz_/no_blitz_ splits and no bare `attempts` or `big_time_throws`.
    "passing_summary": {
        "marker": "big_time_throws",
        "required": IDENTITY + [
            "dropbacks", "attempts", "completions", "yards", "touchdowns",
            "interceptions", "sacks", "scrambles", "big_time_throws",
            "turnover_worthy_plays", "avg_depth_of_target", "avg_time_to_throw",
        ],
        "rates": ["accuracy_percent", "completion_percent", "btt_rate", "twp_rate",
                  "sack_percent", "pressure_to_sack_rate", "drop_rate",
                  "positive_epa_percent"],
        "positions": {"QB"},
        "min_rows": 32,
    },
    "passing_pressure": {
        "marker": "pressure_dropbacks",
        "required": IDENTITY + [
            "pressure_dropbacks", "pressure_dropbacks_percent", "pressure_attempts",
            "pressure_yards", "pressure_twp_rate",
            "no_pressure_dropbacks", "no_pressure_attempts", "no_pressure_yards",
            "blitz_dropbacks", "blitz_dropbacks_percent", "no_blitz_dropbacks",
        ],
        "rates": ["pressure_dropbacks_percent", "blitz_dropbacks_percent",
                  "no_pressure_dropbacks_percent", "no_blitz_dropbacks_percent",
                  "pressure_completion_percent", "pressure_twp_rate"],
        "positions": {"QB"},
        "min_rows": 32,
    },
}

TEAMS = 32


class IngestError(Exception):
    pass


# ---------------------------------------------------------------- reading --

def read_header(path):
    with open(path, newline="", encoding="utf-8-sig") as f:
        return next(csv.reader(f), [])


def read_rows(path):
    with open(path, newline="", encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def classify(header):
    """Return the kind whose marker and required columns the header carries."""
    cols = set(header)
    for kind, spec in KINDS.items():
        if spec["marker"] in cols and set(spec["required"]) <= cols:
            return kind
    return None


def lf_bytes(path):
    """File bytes with CRLF folded to LF. .gitattributes pins every text file
    to LF, so hashing the raw bytes of a CRLF export would never match the copy
    CI checks out; the ingest writes and hashes this form instead."""
    return re.sub(rb"\r+\n", b"\n", Path(path).read_bytes())


def sha256(path):
    return hashlib.sha256(lf_bytes(path)).hexdigest()


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


# ------------------------------------------------------------- validation --

def validate(kind, rows):
    """Raise IngestError if the export doesn't look like a full-league report.
    Returns the facts recorded in the manifest."""
    spec = KINDS[kind]
    if len(rows) < spec["min_rows"]:
        raise IngestError(f"{kind}: only {len(rows)} rows (expected {spec['min_rows']}+). "
                          "Was a team or position filter left on in PFF?")
    positions = {r["position"] for r in rows}
    missing = spec["positions"] - positions
    if missing:
        raise IngestError(f"{kind}: no {', '.join(sorted(missing))} rows. "
                          "Export with all positions selected.")
    teams = {r["team_name"] for r in rows if r["team_name"]}
    if len(teams) != TEAMS:
        raise IngestError(f"{kind}: {len(teams)} teams, expected {TEAMS}. "
                          "Was a team filter left on in PFF?")
    ids = [r["player_id"] for r in rows]
    if len(set(ids)) != len(ids):
        raise IngestError(f"{kind}: duplicate player_id rows.")
    for col in spec["rates"]:
        if col not in rows[0]:
            continue
        bad = [r["player"] for r in rows
               if num(r[col]) is not None and not 0 <= num(r[col]) <= 100]
        if bad:
            raise IngestError(f"{kind}: {col} outside 0..100 for {bad[:3]}")
    games = [num(r["player_game_count"]) for r in rows]
    games = [g for g in games if g is not None]
    if not games:
        raise IngestError(f"{kind}: player_game_count is empty.")
    return {"rows": len(rows), "max_games": int(max(games))}


# ------------------------------------------------------------------ roles --
# Labels only. A player with fewer than MIN_ROUTES routes gets no label: three
# snaps in the slot says nothing. Thresholds are on PFF's slot_rate and
# inline_rate (percent of snaps aligned there).
MIN_ROUTES = 20
WR_SLOT = 60        # slot_rate >= 60 -> slot
WR_PERIMETER = 30   # slot_rate <= 30 -> perimeter; in between -> mixed
TE_INLINE = 50      # inline_rate >= 50 -> inline, else move
ROLE_VALUES = {"WR": {"slot", "mixed", "perimeter"}, "TE": {"inline", "move"}}
ROLE_FIELDS = {"pff_id", "name", "team", "pos", "role"}


def role_for(row):
    pos = row["position"]
    routes, slot, inline = num(row["routes"]), num(row["slot_rate"]), num(row["inline_rate"])
    if routes is None or routes < MIN_ROUTES:
        return None
    if pos == "WR" and slot is not None:
        if slot >= WR_SLOT:
            return "slot"
        return "perimeter" if slot <= WR_PERIMETER else "mixed"
    if pos == "TE" and inline is not None:
        return "inline" if inline >= TE_INLINE else "move"
    return None


def build_roles(season, rows, max_games):
    players = []
    for r in rows:
        role = role_for(r)
        if role:
            players.append({"pff_id": int(r["player_id"]), "name": r["player"],
                            "team": r["team_name"], "pos": r["position"], "role": role})
    players.sort(key=lambda p: (p["pos"], p["team"], p["name"]))
    return {
        "season": season,
        "through_games": max_games,
        "source": "Derived from PFF alignment charting; labels only, no PFF figures.",
        "rules": {"min_routes": MIN_ROUTES, "wr_slot_rate_slot": WR_SLOT,
                  "wr_slot_rate_perimeter": WR_PERIMETER, "te_inline_rate_inline": TE_INLINE},
        "players": players,
    }


def roles_path(season):
    return PFF_DIR / f"roles_{season}.json"


def validate_roles(doc):
    """The published file must carry labels and nothing else."""
    if not doc.get("players"):
        raise IngestError("roles file has no players")
    for p in doc["players"]:
        if set(p) != ROLE_FIELDS:
            raise IngestError(f"roles entry has fields {sorted(p)}; only "
                              f"{sorted(ROLE_FIELDS)} may be published")
        if p["role"] not in ROLE_VALUES.get(p["pos"], set()):
            raise IngestError(f"bad role {p['role']!r} for {p['pos']} {p['name']}")
    return len(doc["players"])


# --------------------------------------------------------------- manifest --

def season_default():
    """The default league's roster season, same read data-refresh.yml uses."""
    try:
        r = json.loads((ROOT / "data" / "leagues.json").read_text(encoding="utf-8"))
        lg = next(l for l in r["leagues"] if l["key"] == r["default"])
        return str(lg["rosterSeason"])
    except Exception:
        return str(dt.date.today().year)


def load_manifest(season_dir):
    p = season_dir / "manifest.json"
    if p.exists():
        return json.loads(p.read_text(encoding="utf-8"))
    return {}


def write_manifest(season_dir, manifest):
    p = season_dir / "manifest.json"
    p.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n",
                 encoding="utf-8", newline="\n")


# ------------------------------------------------------------------ scan --

def find_exports(src, days):
    """Newest CSV of each kind in `src` modified within `days` days."""
    cutoff = dt.datetime.now().timestamp() - days * 86400
    best = {}
    for p in sorted(src.glob("*.csv")):
        try:
            mtime = p.stat().st_mtime
            if mtime < cutoff:
                continue
            kind = classify(read_header(p))
        except (OSError, UnicodeDecodeError, csv.Error):
            continue
        if kind and (kind not in best or mtime > best[kind][1]):
            best[kind] = (p, mtime)
    return best


# ------------------------------------------------------------------- git --

def git(*args, check=True):
    r = subprocess.run(["git", *args], cwd=ROOT, text=True,
                       capture_output=True)
    if check and r.returncode != 0:
        raise IngestError(f"git {' '.join(args)} failed:\n{r.stderr.strip()}")
    return r


def commit_and_push(path, message, push):
    rel = path.relative_to(ROOT).as_posix()
    branch = git("rev-parse", "--abbrev-ref", "HEAD").stdout.strip()
    if branch != "main":
        raise IngestError(f"on branch '{branch}', not main. {rel} was written; "
                          "switch to main and rerun, or commit it by hand.")
    # belt and braces: no raw export may ever be tracked, whatever .gitignore says
    tracked = git("ls-files", "--", "data/pff/*/").stdout.split()
    if tracked:
        raise IngestError(f"raw PFF exports are tracked by git: {tracked[:3]}. "
                          "Run: git rm -r --cached data/pff/<season>  and recheck .gitignore")
    git("add", "--", rel)
    if git("diff", "--cached", "--quiet", "--", rel, check=False).returncode == 0:
        print("labels unchanged; nothing to commit")
        return
    # pathspec commit: only the roles file goes in, whatever else is staged
    git("commit", "-m", message, "--", rel)
    print(f"committed: {message}")
    if not push:
        print("--no-push: not pushed")
        return
    # the bot commits to main nightly, so catch up before pushing. --autostash
    # carries any uncommitted work of yours across the rebase untouched.
    r = git("pull", "--rebase", "--autostash", "origin", "main", check=False)
    if r.returncode != 0:
        git("rebase", "--abort", check=False)
        raise IngestError("pull --rebase failed; your commit is local. "
                          f"Resolve and push by hand.\n{r.stderr.strip()}")
    git("push", "origin", "HEAD:main")
    print("pushed to origin/main; pff-ingest.yml will run")


# ------------------------------------------------------------------ main --

def ingest(src, season, days, force, dry_run, push):
    found = find_exports(src, days)
    if not found:
        raise IngestError(f"no PFF exports modified in the last "
                          f"{days} days in {src}")
    season_dir = PFF_DIR / season
    manifest = load_manifest(season_dir)
    changed = []
    for kind in KINDS:
        if kind not in found:
            print(f"[{kind}] not found in {src}; keeping the stored copy")
            continue
        path, mtime = found[kind]
        facts = validate(kind, read_rows(path))
        digest = sha256(path)
        prev = manifest.get(kind, {})
        tag = f"[{kind}] {path.name}: {facts['rows']} rows, through {facts['max_games']} games"
        if prev.get("sha256") == digest:
            print(f"{tag} - unchanged since last ingest, skipped")
            continue
        if prev and facts["max_games"] < prev.get("max_games", 0) and not force:
            raise IngestError(f"{tag} is OLDER than the stored export "
                              f"({prev['max_games']} games). Use --force to take it anyway.")
        if prev and facts["max_games"] == prev.get("max_games"):
            tag += " (same games as last drop; a re-export)"
        print(tag)
        if dry_run:
            continue
        season_dir.mkdir(parents=True, exist_ok=True)
        (season_dir / f"{kind}.csv").write_bytes(lf_bytes(path))
        manifest[kind] = {
            **facts,
            "source_name": path.name,
            "exported": dt.datetime.fromtimestamp(mtime).isoformat(timespec="seconds"),
            "ingested": dt.datetime.now().isoformat(timespec="seconds"),
            "sha256": digest,
        }
        changed.append(f"{kind} (thru {facts['max_games']} gp)")
    if dry_run:
        print("--dry-run: nothing written")
        return
    if changed:
        write_manifest(season_dir, manifest)
    summary = season_dir / "receiving_summary.csv"
    if not summary.exists():
        print("no receiving summary stored yet; no role labels to publish")
        return
    rows = read_rows(summary)
    doc = build_roles(season, rows, manifest["receiving_summary"]["max_games"])
    n = validate_roles(doc)
    out = roles_path(season)
    out.write_text(json.dumps(doc, indent=1) + "\n", encoding="utf-8", newline="\n")
    counts = {}
    for p in doc["players"]:
        counts[p["role"]] = counts.get(p["role"], 0) + 1
    print(f"roles: {n} labelled ({', '.join(f'{k} {v}' for k, v in sorted(counts.items()))})")
    commit_and_push(out, f"PFF role labels {season} (thru {doc['through_games']} gp)", push)


def check(season):
    """CI: the committed labels are well formed, and no raw export is tracked."""
    path = roles_path(season)
    if not path.exists():
        raise IngestError(f"no roles file at {path.relative_to(ROOT)}")
    doc = json.loads(path.read_text(encoding="utf-8"))
    n = validate_roles(doc)
    raw = sorted(q.relative_to(ROOT).as_posix() for q in PFF_DIR.glob("*/*.csv"))
    if raw:
        raise IngestError(f"raw PFF exports are in the checkout: {raw[:3]}")
    print(f"[roles_{season}] ok: {n} labelled, through {doc['through_games']} games")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--from", dest="src", type=Path, default=Path.home() / "Downloads",
                    help="folder to scan (default: your Downloads)")
    ap.add_argument("--season", default=None, help="default: the league's roster season")
    ap.add_argument("--days", type=int, default=7,
                    help="only consider files modified in the last N days (default 7)")
    ap.add_argument("--force", action="store_true", help="accept an older export")
    ap.add_argument("--dry-run", action="store_true", help="report only")
    ap.add_argument("--no-push", action="store_true", help="commit but don't push")
    ap.add_argument("--check", action="store_true", help="validate the committed labels (CI)")
    a = ap.parse_args(argv)
    season = a.season or season_default()
    try:
        if a.check:
            check(season)
        else:
            ingest(a.src, season, a.days, a.force, a.dry_run, not a.no_push)
    except IngestError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
