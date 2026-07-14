#!/usr/bin/env python3
"""
build_site_data.py — turn a sleeper_pull.py dump (+ sleeper_war.py analysis)
into the compact JSON files the website reads. Run AFTER those two scripts.

  python scripts/build_site_data.py --data sleeper_data --out data

Outputs:
  data/meta.json                seasons list, league name, updated timestamp
  data/players_min.json         player_id -> [name, pos, NFL team] (only ids used)
  data/<season>/summary.json    season table: WAR/WAA/gp/pts/ppg per player
  data/<season>/teams.json      fantasy teams: manager, record, roster
  data/<season>/weekly.json     player_id -> [[week, pts, pAA, pAR, WAA, WAR], ...]
"""
import argparse, csv, json, time
from pathlib import Path

def load(p):
    return json.loads(Path(p).read_text(encoding="utf-8"))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="sleeper_data")
    ap.add_argument("--out", default="data")
    args = ap.parse_args()
    root, out = Path(args.data), Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    players = load(root / "players.json")
    used_ids, seasons, league_name = set(), [], "League"
    own = {}          # player_id -> [(sortkey, season, week, text), ...]

    for sdir in sorted((d for d in root.iterdir() if d.is_dir() and (d / "league.json").exists())):
        league = load(sdir / "league.json")
        season = league["season"]
        league_name = league.get("name", league_name)
        sout = out / season
        sout.mkdir(exist_ok=True)

        # --- teams ---
        rosters = load(sdir / "rosters.json") or []
        users = {u["user_id"]: u for u in (load(sdir / "users.json") or [])}
        teams = []
        for r in rosters:
            u = users.get(r.get("owner_id") or "", {})
            meta = u.get("metadata") or {}
            st = r.get("settings") or {}
            plist = r.get("players") or []
            used_ids.update(plist)
            teams.append({
                "roster_id": r["roster_id"],
                "team": meta.get("team_name") or u.get("display_name") or f"Team {r['roster_id']}",
                "manager": u.get("display_name", "?"),
                "wins": st.get("wins", 0), "losses": st.get("losses", 0), "ties": st.get("ties", 0),
                "fpts": round(st.get("fpts", 0) + st.get("fpts_decimal", 0) / 100, 1),
                "players": plist,
                "starters": r.get("starters") or [],
                "taxi": r.get("taxi") or [], "reserve": r.get("reserve") or [],
            })
        (sout / "teams.json").write_text(json.dumps(teams))

        # --- summary + weekly (only exist for seasons with scored weeks) ---
        acsv = root / "analysis" / f"waa_war_{season}.csv"
        summary = []
        if acsv.exists():
            with open(acsv, encoding="utf-8") as f:
                for row in csv.DictReader(f):
                    used_ids.add(row["player_id"])
                    summary.append([row["player_id"], row["pos"], int(row["gp"]),
                                    float(row["pts"]), float(row["ppg"]),
                                    float(row["WAA"]), float(row["WAR"])])
        (sout / "summary.json").write_text(json.dumps(summary))

        wcsv = root / "analysis" / f"weekly_detail_{season}.csv"
        weekly = {}
        if wcsv.exists():
            with open(wcsv, encoding="utf-8") as f:
                for row in csv.DictReader(f):
                    weekly.setdefault(row["player_id"], []).append(
                        [int(row["week"]), float(row["pts"]),
                         float(row["pts_above_avg"]), float(row["pts_above_repl"]),
                         float(row["WAA_week"]), float(row["WAR_week"])])
        (sout / "weekly.json").write_text(json.dumps(weekly))

        # --- ownership history: drafts + transactions ---
        tname = {t["roster_id"]: t["team"] for t in teams}
        for df in sorted(sdir.glob("draft_*_picks.json")):
            if df.name.endswith("_traded_picks.json"):
                continue
            for pk in load(df) or []:
                pid = pk.get("player_id")
                rid = pk.get("roster_id")
                try:
                    rid = int(rid)
                except (TypeError, ValueError):
                    rid = None
                team = tname.get(rid, "?")
                txt = f"drafted {pk.get('round','?')}.{pk.get('draft_slot','?')} by {team}"
                own.setdefault(pid, []).append(((season, 0, pk.get("pick_no", 0)), season, 0, txt))
                used_ids.add(pid)
        for tf in sorted((sdir / "transactions").glob("week_*.json")) if (sdir / "transactions").exists() else []:
            for tx in load(tf) or []:
                if tx.get("status") != "complete":
                    continue
                typ, wk, ts = tx.get("type"), tx.get("leg", 0), tx.get("created", 0)
                adds, drops = tx.get("adds") or {}, tx.get("drops") or {}
                for pid, rid in adds.items():
                    team = tname.get(rid, "?")
                    txt = {"trade": f"traded to {team}",
                           "waiver": f"waiver claim by {team}",
                           "free_agent": f"signed by {team}"}.get(typ, f"{typ} to {team}")
                    own.setdefault(pid, []).append(((season, 1, ts), season, wk, txt))
                    used_ids.add(pid)
                for pid, rid in drops.items():
                    if pid in adds:
                        continue
                    team = tname.get(rid, "?")
                    own.setdefault(pid, []).append(((season, 1, ts), season, wk, f"dropped by {team}"))
                    used_ids.add(pid)
        seasons.append(season)

    pmin = {}
    for pid in used_ids:
        p = players.get(pid)
        if p:
            pmin[pid] = [f"{p.get('first_name','')} {p.get('last_name','')}".strip(),
                         p.get("position") or "?", p.get("team") or ""]
        else:
            pmin[pid] = [f"#{pid}", "?", ""]   # team defenses etc.
    (out / "players_min.json").write_text(json.dumps(pmin))
    (out / "ownership.json").write_text(json.dumps(
        {pid: [[sn, wk, txt] for _, sn, wk, txt in sorted(evts)]
         for pid, evts in own.items()}))
    (out / "meta.json").write_text(json.dumps({
        "league": league_name, "seasons": seasons,
        "updated": time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime()),
    }))
    print(f"site data written to {out}/ for seasons: {', '.join(seasons)}")

if __name__ == "__main__":
    main()