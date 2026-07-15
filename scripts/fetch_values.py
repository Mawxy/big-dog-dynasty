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
        e["fcTrend"] = row.get("trend30Day")

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
    matched = 0
    for row in json.loads(m.group(1)):
        pos = row.get("position")
        if pos not in CORE:
            continue
        val = (row.get("superflexValues") or {}).get("value")
        if not val:
            continue
        hit = idx.get((norm(row.get("playerName", "")), pos))
        if hit:
            out.setdefault(hit[0], {})["ktc"] = val
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
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps({
        "fetched": time.strftime("%Y-%m-%d", time.gmtime()),
        "sources": ok, "players": vals}))
    print(f"wrote {out_path} ({len(vals)} players; fresh: {', '.join(ok)})")

if __name__ == "__main__":
    main()
