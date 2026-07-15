#!/usr/bin/env python3
"""
fetch_values.py — pull current dynasty market values into data/values.json.

Sources:
  FantasyCalc  — public API, superflex/12-team/PPR, maps by sleeperId directly.
  KeepTradeCut — no API; parses the playersArray embedded in their rankings
                 page (superflex values), matched by normalized name+position.
                 Values courtesy of KeepTradeCut — attribution shown on site.

Each source fails independently and gracefully: on error the previous
values.json (if any) is preserved rather than overwritten with less data.

Runs standalone — needs NO Sleeper API access. Name matching uses the
committed data/players_min.json (full sleeper_data/players.json also works).

Usage:
  python scripts/fetch_values.py --players data/players_min.json --out data/values.json
"""
import argparse, json, re, urllib.request
from pathlib import Path

UA = {"User-Agent": "Mozilla/5.0 (BigDogDynasty league site)"}
FC_URL = "https://api.fantasycalc.com/values/current?isDynasty=true&numQbs=2&numTeams=12&ppr=1"
KTC_URL = "https://keeptradecut.com/dynasty-rankings"
CORE = {"QB", "RB", "WR", "TE"}

def get(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=45) as r:
        return r.read().decode("utf-8")

def norm(name):
    n = re.sub(r"[^a-z]", "", name.lower())   # strip punctuation/spaces first
    for suf in ("jr", "sr", "iii", "ii", "iv"):
        if n.endswith(suf) and len(n) > len(suf) + 3:
            n = n.removesuffix(suf)
            break
    return n

def fetch_fantasycalc(out):
    for row in json.loads(get(FC_URL)):
        p = row.get("player") or {}
        sid = p.get("sleeperId")
        if not sid:
            continue
        e = out.setdefault(str(sid), {})
        e["fc"] = row.get("value")
        e["fcRank"] = row.get("overallRank")
        e["fcPosRank"] = row.get("positionRank")
        if row.get("trend30Day") is not None:
            e["fcT"] = {"30": row["trend30Day"]}

def name_index(players):
    """name+pos -> sleeper id. Accepts players_min.json ([name,pos,team] lists)
    or the full sleeper players.json (dicts). Collisions prefer active/ranked."""
    idx = {}
    for pid, pl in players.items():
        if isinstance(pl, list):
            name, pos = pl[0], pl[1]
            pref = 0 if (len(pl) > 2 and pl[2]) else 1
        else:
            pos = pl.get("position")
            name = f"{pl.get('first_name', '')} {pl.get('last_name', '')}"
            pref = pl.get("search_rank") or 10 ** 9
        if pos not in CORE:
            continue
        key = (norm(name), pos)
        cur = idx.get(key)
        if cur is None or pref < cur[1]:
            idx[key] = (pid, pref)
    return idx

def fetch_ktc(out, players):
    idx = name_index(players)
    html = get(KTC_URL)
    m = re.search(r"var\s+playersArray\s*=\s*(\[.*?\]);", html, re.S)
    if not m:
        raise RuntimeError("playersArray not found — KTC page layout changed")
    rows = []
    for row in json.loads(m.group(1)):
        pos = row.get("position")
        if pos not in CORE:
            continue
        sf = row.get("superflexValues") or {}
        if sf.get("value"):
            rows.append((row, pos, sf))
    # fallback ranks derived from values, in case KTC's rank fields move/rename
    ordered = sorted(rows, key=lambda r: -r[2]["value"])
    ovr, posrk, posctr = {}, {}, {}
    for i, r in enumerate(ordered):
        ovr[id(r[0])] = i + 1
        posctr[r[1]] = posctr.get(r[1], 0) + 1
        posrk[id(r[0])] = posctr[r[1]]
    matched = 0
    for row, pos, sf in rows:
        hit = idx.get((norm(row.get("playerName", "")), pos))
        if not hit:
            continue
        e = out.setdefault(hit[0], {})
        e["ktc"] = sf["value"]
        e["ktcRank"] = sf.get("rank") or ovr[id(row)]
        e["ktcPosRank"] = sf.get("positionalRank") or posrk[id(row)]
        for key, days in (("overall7DayTrend", 7), ("sevenDayTrend", 7),
                          ("overallTrend", 7), ("overall30DayTrend", 30)):
            t = sf.get(key)
            if t is not None:
                e["ktcT"] = {str(days): int(t)}
                break
        matched += 1
    print(f"KTC matched {matched} players")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--players", default="data/players_min.json")
    ap.add_argument("--out", default="data/values.json")
    args = ap.parse_args()
    players = json.loads(Path(args.players).read_text(encoding="utf-8"))
    out_path = Path(args.out)
    prev = {}
    if out_path.exists():
        try:
            prev = json.loads(out_path.read_text(encoding="utf-8")).get("players", {})
        except Exception:
            pass
    vals, ok = {}, []
    for name, fn in (("FantasyCalc", lambda: fetch_fantasycalc(vals)),
                     ("KeepTradeCut", lambda: fetch_ktc(vals, players))):
        try:
            fn()
            ok.append(name)
        except Exception as e:
            print(f"WARNING: {name} fetch failed: {e}")
    if not vals:
        print("No sources succeeded — keeping previous values.json")
        return
    # carry forward the other source's numbers if one failed this week
    for pid, old in prev.items():
        cur = vals.setdefault(pid, {})
        for k, v in old.items():
            cur.setdefault(k, v)
    import time
    from datetime import date, timedelta
    # aligned 7-day trends for BOTH sources, derived from our own daily
    # snapshots (FantasyCalc has no native 7-day; KTC's field spelling can
    # drift). Native trends (KTC 7-day, FC 30-day) remain as labeled
    # fallbacks until a week of history exists.
    hist_path = out_path.parent / "values_history.json"
    hist = {}
    if hist_path.exists():
        try:
            hist = json.loads(hist_path.read_text(encoding="utf-8"))
        except Exception:
            pass
    today = date.today().isoformat()
    cutoffs = {d: (date.today() - timedelta(days=d)).isoformat() for d in (7, 14, 30)}
    for pid, e in vals.items():
        if e.get("ktc") is None and e.get("fc") is None:
            continue
        h = hist.setdefault(pid, [])
        entry = [today, e.get("ktc"), e.get("fc")]
        if h and h[-1][0] == today:
            h[-1] = entry
        else:
            h.append(entry)
        del h[:-45]                          # keep ~45 most recent days
        for name, idx in (("ktc", 1), ("fc", 2)):
            cur = e.get(name)
            if cur is None:
                continue
            trends = e.get(name + "T") or {}
            for d, cutoff in cutoffs.items():
                base = None
                for row in h:                # most recent snapshot >= d days old
                    if row[0] <= cutoff and len(row) > idx and row[idx] is not None:
                        base = row[idx]
                if base is not None:
                    trends[str(d)] = cur - base
            if trends:
                e[name + "T"] = trends
    hist_path.write_text(json.dumps(hist))
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps({
        "fetched": time.strftime("%Y-%m-%d", time.gmtime()),
        "sources": ok, "players": vals}))
    print(f"wrote {out_path} ({len(vals)} players; fresh: {', '.join(ok)})")

if __name__ == "__main__":
    main()
