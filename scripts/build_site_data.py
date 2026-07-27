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
import argparse, csv, json, re, statistics, time
from pathlib import Path

from leaguepaths import DataDir

ALLOW_EMPTY = False   # set by --allow-empty

# Hand-assigned URL aliases, keyed by founding league_id. Set one here to
# override the name-derived default; leave a league out and it gets
# "<slugified-name>-<last 4 of key>".
ALIASES = {
    "814608002207334400": "big-dog",     # Big Dog Dynasty
}

def slugify(s):
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", (s or "").lower())).strip("-") or "league"

def load(p):
    return json.loads(Path(p).read_text(encoding="utf-8"))

def guard_write(path, obj, content=None):
    """Write JSON, but refuse to replace a non-empty committed file with empty
    output — that's how a run against a missing/partial dump silently empties
    the site (it has happened). `content` overrides what emptiness is judged
    on when the written object is a wrapper. --allow-empty skips the check."""
    gauge = obj if content is None else content
    if not gauge and not ALLOW_EMPTY and Path(path).exists():
        try:
            old = json.loads(Path(path).read_text(encoding="utf-8"))
        except (ValueError, OSError):
            old = None
        if old:
            raise SystemExit(
                f"refusing to overwrite non-empty {path} with empty output — "
                "did sleeper_pull.py / sleeper_war.py run against this --data "
                "dir? (--allow-empty to override)")
    Path(path).write_text(json.dumps(obj))

def main():
    global ALLOW_EMPTY
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="sleeper_data")
    ap.add_argument("--out", default="data")
    ap.add_argument("--allow-empty", action="store_true",
                    help="permit overwriting non-empty outputs with empty ones "
                         "(deliberate resets only)")
    args = ap.parse_args()
    ALLOW_EMPTY = args.allow_empty
    root, root_out = Path(args.data), Path(args.out)
    root_out.mkdir(parents=True, exist_ok=True)
    # `out` is the LEAGUE directory. The founding id isn't known until the
    # seasons are walked, so it starts flat and is repointed below, before
    # anything is written.
    out = root_out

    players = load(root / "players.json")
    used_ids, seasons, league_name = set(), [], "League"
    roster_positions, taxi_slots = [], 0
    latest_with_data = None
    chain = {}            # season -> league_id
    prev_of = {}          # league_id -> previous_league_id (None at the founder)
    commissioners = []    # [{user_id, name}] from the newest season
    pts_min, pts_max = 0.0, 0.0   # league-wide extremes of any single weekly score
    own = {}          # player_id -> [(sortkey, season, week, text), ...]
    # (season, roster_id) whose Sleeper owner had no team/display name that year
    name_override = {("2023", 9): "PicklesPapa"}
    franchises = {}   # roster_id -> {seasons:[...], tx:[...]} (franchise = stable roster_id)
    def fr(rid):
        return franchises.setdefault(rid, {"seasons": [], "tx": []})

    season_dirs = sorted(d for d in root.iterdir()
                         if d.is_dir() and (d / "league.json").exists())
    # pre-flight, before ANY write: a season with scored matchup weeks must
    # have its analysis CSV, or summary/weekly would come out empty mid-run
    if not ALLOW_EMPTY:
        for sdir in season_dirs:
            sn = load(sdir / "league.json")["season"]
            has_weeks = (sdir / "matchups").exists() and \
                any((sdir / "matchups").glob("week_*.json"))
            if has_weeks and not (root / "analysis" / f"waa_war_{sn}.csv").exists():
                raise SystemExit(
                    f"{sdir} has scored matchup weeks but {root}/analysis/"
                    f"waa_war_{sn}.csv is missing — run sleeper_war.py first "
                    "(--allow-empty to override)")

    # League identity, resolved before ANY write. Sleeper mints a new league_id
    # each season and chains them backward; the founder (previous_league_id is
    # null) is the only id that never moves, so it keys the directory.
    for sdir in season_dirs:
        lg = load(sdir / "league.json")
        chain[lg["season"]] = lg["league_id"]
        prev_of[lg["league_id"]] = lg.get("previous_league_id")
    founder = next((lid for lid, prev in prev_of.items() if not prev),
                   chain[min(chain)] if chain else "")
    if founder:
        out = root_out / "leagues" / founder
        out.mkdir(parents=True, exist_ok=True)

    for sdir in season_dirs:
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
        user_list = load(sdir / "users.json") or []
        users = {u["user_id"]: u for u in user_list}
        commissioners = [{"user_id": u["user_id"],
                          "name": u.get("display_name") or "?"}
                         for u in user_list if u.get("is_owner")] or commissioners
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
        guard_write(sout / "teams.json", teams)

        # --- summary + weekly (only exist for seasons with scored weeks) ---
        acsv = root / "analysis" / f"waa_war_{season}.csv"
        summary = []
        vowp_of = {}          # pid -> season VoWP (blank/absent for pre-VoWP dumps)
        if acsv.exists():
            with open(acsv, encoding="utf-8") as f:
                for row in csv.DictReader(f):
                    used_ids.add(row["player_id"])
                    summary.append([row["player_id"], row["pos"], int(row["gp"]),
                                    float(row["pts"]), float(row["ppg"]),
                                    float(row["WAA"]), float(row["WAR"])])
                    vw = row.get("VoWP")
                    if vw not in (None, ""):
                        vowp_of[row["player_id"]] = float(vw)
        wcsv = root / "analysis" / f"weekly_detail_{season}.csv"
        weekly = {}
        if wcsv.exists():
            with open(wcsv, encoding="utf-8") as f:
                for row in csv.DictReader(f):
                    weekly.setdefault(row["player_id"], []).append(
                        [int(row["week"]), float(row["pts"]),
                         float(row["pts_above_avg"]), float(row["pts_above_repl"]),
                         float(row["WAA_week"]), float(row["WAR_week"])])
        guard_write(sout / "weekly.json", weekly)
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
        guard_write(sout / "absence.json", absence)
        for row in summary:                      # append point st-dev, then VoWP
            v = [w[1] for w in weekly.get(row[0], [])]
            row.append(round(statistics.stdev(v), 2) if len(v) > 1 else 0.0)  # [7] sdv
            row.append(vowp_of.get(row[0]))                                   # [8] VoWP (or null)
        guard_write(sout / "summary.json", summary)
        if summary:
            latest_with_data = season

        # --- ownership history: drafts + transactions ---
        tname = {t["roster_id"]: t["team"] for t in teams}
        for df in sorted(sdir.glob("draft_*_picks.json")):
            if df.name.endswith("_traded_picks.json"):
                continue
            for pk in load(df) or []:
                pid = pk.get("player_id")
                if not pid:
                    continue          # unmade pick: a None key serializes to "null"
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
        # sleeper_pull writes brackets only when Sleeper returns one — absent
        # is normal for a season whose bracket hasn't been generated yet
        wbf, lbf = sdir / "winners_bracket.json", sdir / "losers_bracket.json"
        wb = (load(wbf) or []) if wbf.exists() else []
        lb = (load(lbf) or []) if lbf.exists() else []
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
    guard_write(out / "players_min.json", pmin)
    guard_write(out / "ownership.json",
                {pid: [[sn, wk, txt] for _, sn, wk, txt in sorted(evts)]
                 for pid, evts in own.items()})
    guard_write(out / "franchises.json", franchises)

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
        guard_write(out / "picks_owned.json",
                    {"meta": {"seasons": fut, "as_of": newest}, "owned": owned},
                    content=owned)
    # --- league registry -----------------------------------------------------
    # A league is keyed by its FOUNDING league_id, permanently. Sleeper issues a
    # new id every season, so keying on the current one would move every data
    # path and URL annually; the founder is the only id that never changes.
    #
    # The alias is data, not a derived value read at request time. If two
    # leagues would claim the same alias, the second simply doesn't get one and
    # falls back to its id — a visible condition in this file rather than an
    # algorithm that silently reassigns URLs. Full ids always resolve, so an
    # alias is never load-bearing.
    if seasons and founder:
        alias = ALIASES.get(founder) or f"{slugify(league_name)}-{founder[-4:]}"
        guard_write(root_out / "leagues.json", {
            "default": founder,
            "leagues": [{
                "key": founder,
                "alias": alias,
                "name": league_name,
                "seasons": seasons,
                # `latest` is the newest season with games played; `rosterSeason`
                # is whose rosters are live. They differ all offseason, and
                # conflating them is what showed the rookie class as unowned.
                "latest": latest_with_data,
                "rosterSeason": max(seasons),
                "currentLeagueId": chain[max(seasons)],
                "chain": chain,
                "commissioners": commissioners,
            }],
        }, content=founder)

    # gauge meta on `latest`: regressing it to null means no season produced
    # summary data, which for this league is always a broken run
    #
    # `latest` and `rosterSeason` answer different questions and drift apart
    # every offseason. `latest` is the newest season with games played, and is
    # what the stats views default to. `rosterSeason` is whose rosters are live
    # right now. In July 2026 those are 2025 and 2026 — reading `latest` for
    # ownership showed all 68 players added since the 2025 rosters closed, the
    # whole rookie class included, as free agents.
    guard_write(out / "meta.json", {
        "league": league_name, "seasons": seasons, "latest": latest_with_data,
        "rosterSeason": max(seasons) if seasons else None,
        "rosterPositions": roster_positions, "taxiSlots": taxi_slots,
        "ptsRange": [round(pts_min, 1), round(pts_max, 1)],
        "updated": time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime()),
    }, content=latest_with_data)
    print(f"site data written to {out}/ for seasons: {', '.join(seasons)}")

if __name__ == "__main__":
    main()
