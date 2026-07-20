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
import argparse, csv, json, statistics, time
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
    roster_positions, taxi_slots = [], 0
    latest_with_data = None
    pts_min, pts_max = 0.0, 0.0   # league-wide extremes of any single weekly score
    own = {}          # player_id -> [(sortkey, season, week, text), ...]
    # (season, roster_id) whose Sleeper owner had no team/display name that year
    name_override = {("2023", 9): "PicklesPapa"}
    franchises = {}   # roster_id -> {seasons:[...], tx:[...]} (franchise = stable roster_id)
    def fr(rid):
        return franchises.setdefault(rid, {"seasons": [], "tx": []})

    for sdir in sorted((d for d in root.iterdir() if d.is_dir() and (d / "league.json").exists())):
        league = load(sdir / "league.json")
        season = league["season"]
        league_name = league.get("name", league_name)
        # newest season's lineup shape wins — the site uses it to build an
        # optimal-lineup view (starters vs bench) from roster WAR
        roster_positions = league.get("roster_positions") or roster_positions
        taxi_slots = (league.get("settings") or {}).get("taxi_slots", taxi_slots)
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
                "team": name_override.get((season, r["roster_id"])) or meta.get("team_name")
                        or u.get("display_name") or f"Team {r['roster_id']}",
                "manager": name_override.get((season, r["roster_id"]), u.get("display_name", "?")),
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
        for rows_w in weekly.values():
            for w in rows_w:
                if w[1] < pts_min: pts_min = w[1]
                if w[1] > pts_max: pts_max = w[1]

        # --- weekly matchups: points, opponent, starters per team ---
        mws = {}
        mdir = sdir / "matchups"
        if mdir.exists():
            for wf in sorted(mdir.glob("week_*.json")):
                wk = int(wf.stem.split("_")[1])
                teamsw = load(wf) or []
                pts = {t["roster_id"]: t.get("points") or 0 for t in teamsw}
                if not any(pts.values()):
                    continue
                bym = {}
                for t in teamsw:
                    if t.get("matchup_id") is not None:
                        bym.setdefault(t["matchup_id"], []).append(t["roster_id"])
                opp = {}
                for rids in bym.values():
                    if len(rids) == 2:
                        opp[rids[0]], opp[rids[1]] = rids[1], rids[0]
                for t in teamsw:
                    rid = t["roster_id"]
                    o = opp.get(rid)
                    mws.setdefault(str(rid), []).append(
                        [wk, round(pts.get(rid, 0), 2), o,
                         round(pts.get(o, 0), 2) if o else None,
                         t.get("starters") or []])
        # NFL bye weeks (team -> week), derived by sleeper_pull from the NFL
        # schedule feed; project_war attaches each player's bye to projections
        bf = sdir / "byes.json"
        if bf.exists():
            (sout / "byes.json").write_text(bf.read_text())

        # future-week pairings (sleeper_pull's schedule/ dir): lets the site
        # project records against the real schedule before any games are scored
        sched = {}
        scdir = sdir / "schedule"
        if scdir.exists():
            scored_wks = {e[0] for lst in mws.values() for e in lst}
            for wf in sorted(scdir.glob("week_*.json")):
                wk = int(wf.stem.split("_")[1])
                if wk in scored_wks:
                    continue
                pairs = load(wf) or []
                if pairs:
                    sched[str(wk)] = pairs
        mpayload = {"playoff_start": league.get("settings", {}).get("playoff_week_start", 15),
                    "teams": mws}
        if sched:
            mpayload["schedule"] = sched
        (sout / "matchups.json").write_text(json.dumps(mpayload))

        # --- absences: label each missing regular-season week BYE / DNP / NR ---
        ps_wk = league.get("settings", {}).get("playoff_week_start", 15)
        played_maps = {}
        pdir = sdir / "played"
        if pdir.exists():
            for pf in sorted(pdir.glob("week_*.json")):
                wk = int(pf.stem.split("_")[1])
                if wk >= ps_wk:
                    continue
                pm = load(pf)
                # old dumps stored a bare list (no teams); tolerate both shapes
                played_maps[wk] = pm if isinstance(pm, dict) else {x: "" for x in (pm or [])}
        absence = {}
        if played_maps:
            all_teams = {t for m in played_maps.values() for t in m.values() if t}
            byes = {wk: all_teams - {t for t in m.values() if t} for wk, m in played_maps.items()}
            wks_sorted = sorted(played_maps)
            for pid, wrows in weekly.items():
                have = {r[0] for r in wrows}
                ab = {}
                for w in wks_sorted:
                    if w in have:
                        continue
                    if pid in played_maps[w]:
                        ab[w] = "NR"        # played in the NFL, wasn't on a league roster
                        continue
                    team = None             # infer his team from the nearest played week
                    for dist in range(1, 20):
                        for cand in (w - dist, w + dist):
                            t = played_maps.get(cand, {}).get(pid)
                            if t:
                                team = t
                                break
                        if team:
                            break
                    ab[w] = "BYE" if team and team in byes.get(w, set()) else "DNP"
                if ab:
                    absence[pid] = ab
        (sout / "absence.json").write_text(json.dumps(absence))
        for row in summary:                      # append point st-dev per player
            v = [w[1] for w in weekly.get(row[0], [])]
            row.append(round(statistics.stdev(v), 2) if len(v) > 1 else 0.0)
        (sout / "summary.json").write_text(json.dumps(summary))
        if summary:
            latest_with_data = season

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
        def pname(pid):
            pl = players.get(pid)
            return f"{pl.get('first_name','')} {pl.get('last_name','')}".strip() if pl else f"#{pid}"
        ORD = {1: "1st", 2: "2nd", 3: "3rd"}
        for tf in sorted((sdir / "transactions").glob("week_*.json")) if (sdir / "transactions").exists() else []:
            for tx in load(tf) or []:
                if tx.get("status") != "complete":
                    continue
                typ, wk, ts = tx.get("type"), tx.get("leg", 0), tx.get("created", 0)
                adds, drops = tx.get("adds") or {}, tx.get("drops") or {}
                trade_note = ""
                if typ == "trade":
                    got = {}   # roster_id -> assets received in this deal
                    for pid, rid in adds.items():
                        got.setdefault(rid, []).append(pname(pid))
                    for pk in tx.get("draft_picks") or []:
                        r = pk.get("round")
                        got.setdefault(pk.get("owner_id"), []).append(
                            f"{pk.get('season')} {ORD.get(r, str(r) + 'th')}")
                    for wb in tx.get("waiver_budget") or []:
                        got.setdefault(wb.get("receiver"), []).append(f"${wb.get('amount')} FAAB")
                    trade_note = "; ".join(
                        f"{tname.get(rid, '?')} get {', '.join(a)}" for rid, a in got.items())
                # franchise transaction log (one entry per roster involved)
                if typ == "trade":
                    for rid_g, assets in got.items():
                        others = [o for o in got if o != rid_g]
                        fr(rid_g)["tx"].append({
                            "season": season, "week": wk, "ts": ts, "type": "trade",
                            "with": [tname.get(o, "?") for o in others],
                            "got": assets, "gave": [a for o in others for a in got[o]]})
                else:
                    per = {}
                    for pid, rid in adds.items():
                        per.setdefault(rid, {"adds": [], "drops": []})["adds"].append(pname(pid))
                    for pid, rid in drops.items():
                        if pid not in adds:
                            per.setdefault(rid, {"adds": [], "drops": []})["drops"].append(pname(pid))
                    for rid, ad in per.items():
                        fr(rid)["tx"].append({"season": season, "week": wk, "ts": ts, "type": typ, **ad})
                for pid, rid in adds.items():
                    team = tname.get(rid, "?")
                    txt = {"trade": f"traded to {team}" + (f" — {trade_note}" if trade_note else ""),
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
        # --- franchise year-by-year: record, team WAR, seed, playoff finish ---
        war_idx = {}
        for pid, rows_w in weekly.items():
            for w in rows_w:
                war_idx[(pid, w[0])] = w[5]          # WAR_week
        team_war, team_top, team_low = {}, {}, {}
        for rid_str, ents in mws.items():
            tw = 0.0
            pstats = {}                              # pid -> [WAR while starting, starts]
            for e in ents:
                if e[0] >= ps_wk:                    # regular season only
                    continue
                for p in e[4]:                       # starters
                    w = war_idx.get((p, e[0]), 0.0)
                    tw += w
                    s = pstats.setdefault(p, [0.0, 0]); s[0] += w; s[1] += 1
            rid = int(rid_str)
            team_war[rid] = round(tw, 3)
            if pstats:
                tp = max(pstats.items(), key=lambda kv: kv[1][0])
                team_top[rid] = {"pid": tp[0], "war": round(tp[1][0], 2)}
                regs = [kv for kv in pstats.items() if kv[1][1] > 6]   # >6 starts = a starter
                if regs:
                    lo = min(regs, key=lambda kv: kv[1][0])
                    team_low[rid] = {"pid": lo[0], "war": round(lo[1][0], 2), "starts": lo[1][1]}
        standing = sorted(teams, key=lambda t: (-t["wins"], -t["fpts"]))
        seed = {t["roster_id"]: i + 1 for i, t in enumerate(standing)}
        finish = {}                                  # roster_id -> final placement
        wb = load(sdir / "winners_bracket.json") or []
        lb = load(sdir / "losers_bracket.json") or []
        n_playoff = len({r for m in wb for r in (m.get("t1"), m.get("t2")) if r})
        for m in wb:                                 # winners bracket: places 1..N
            if m.get("p") and m.get("w") and m.get("l"):
                finish[m["w"]] = m["p"]; finish[m["l"]] = m["p"] + 1
        for m in lb:                                 # losers bracket: places N+1..2N
            if m.get("p") and m.get("w") and m.get("l"):
                finish[m["w"]] = n_playoff + m["p"]; finish[m["l"]] = n_playoff + m["p"] + 1
        for t in teams:
            rid = t["roster_id"]
            g = t["wins"] + t["losses"] + t["ties"]
            fr(rid)["seasons"].append({
                "season": season, "name": t["team"], "manager": t["manager"],
                "wins": t["wins"], "losses": t["losses"], "ties": t["ties"],
                "fpts": t["fpts"], "ppg": round(t["fpts"] / g, 1) if g else 0,
                "war": team_war.get(rid, 0.0), "seed": seed.get(rid),
                "finish": finish.get(rid),
                "top": team_top.get(rid), "low": team_low.get(rid),
            })
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
    (out / "franchises.json").write_text(json.dumps(franchises))

    # --- future draft-pick ownership (trade calculator's team postures) ------
    # Every roster owns its own pick for the next drafts unless traded_picks
    # says otherwise. Rounds 1-4, two seasons out (the calculator's horizon).
    if seasons:
        newest = max(seasons)
        tp = load(root / newest / "traded_picks.json") or []
        rosters = load(root / newest / "rosters.json") or []
        rids = [r["roster_id"] for r in rosters]
        fut = [int(newest) + 1, int(newest) + 2]
        owner = {(int(s), rnd, rid): rid for s in fut for rnd in (1, 2, 3, 4) for rid in rids}
        for t in tp:
            k = (int(t["season"]), t["round"], t["roster_id"])
            if k in owner:
                owner[k] = t["owner_id"]
        owned = {}
        for (s, rnd, orig), holder in sorted(owner.items()):
            owned.setdefault(str(holder), []).append({"season": s, "round": rnd, "orig": orig})
        (out / "picks_owned.json").write_text(json.dumps(
            {"meta": {"seasons": fut, "as_of": newest}, "owned": owned}))
    (out / "meta.json").write_text(json.dumps({
        "league": league_name, "seasons": seasons, "latest": latest_with_data,
        "rosterPositions": roster_positions, "taxiSlots": taxi_slots,
        "ptsRange": [round(pts_min, 1), round(pts_max, 1)],
        "updated": time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime()),
    }))
    print(f"site data written to {out}/ for seasons: {', '.join(seasons)}")

if __name__ == "__main__":
    main()
