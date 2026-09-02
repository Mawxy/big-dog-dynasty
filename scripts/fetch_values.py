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

from ioutil import atomic_write
from leaguepaths import DataDir

ROOT = Path(__file__).resolve().parent.parent
DATA = DataDir(ROOT / "data")

UA = {"User-Agent": "Mozilla/5.0 (BigDogDynasty league site)"}
FC_URL = "https://api.fantasycalc.com/values/current?isDynasty=true&numQbs=2&numTeams=12&ppr=1"
KTC_URL = "https://keeptradecut.com/dynasty-rankings"
CORE = {"QB", "RB", "WR", "TE"}

def get(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=45) as r:
        return r.read().decode("utf-8")

def norm(name):
    # The suffix set must match the one pick_value.py, project_war.py and
    # sleeper_crawl.py strip, or a player carries a suffix on one side of the
    # join and not the other and simply never matches. "v" was missing here and
    # present in all three of those, so every Roman-numeral-V player was dropped
    # by KTC matching (this) and by FantasyPros matching (fetch_ecr imports it).
    # Order matters: the longer numerals are tested before the shorter ones they
    # end with, so "iii" is not read as "ii" and "iv" is not read as "v".
    # tests/test_names.py pins the parity.
    n = re.sub(r"[^a-z]", "", name.lower())   # strip punctuation/spaces first
    for suf in ("jr", "sr", "iii", "ii", "iv", "v"):
        # the length guard is what stops a genuinely short name ending in one of
        # these from being mangled — this normalizer has already thrown the
        # word boundaries away, so it cannot tell a suffix from a last syllable
        if n.endswith(suf) and len(n) > len(suf) + 3:
            n = n.removesuffix(suf)
            break
    return n

PICK_RE = re.compile(r"^20\d\d\b")

def fetch_fantasycalc(out, picks):
    for row in json.loads(get(FC_URL)):
        p = row.get("player") or {}
        sid = p.get("sleeperId")
        name = p.get("name") or ""
        # FC picks carry a synthetic sleeperId like "FP_2026_1", so detect
        # picks by position/name BEFORE treating rows as players
        if p.get("position") == "PICK" or PICK_RE.match(name) or str(sid or "").startswith("FP_"):
            if row.get("value"):
                picks.setdefault("fc", []).append([name, row["value"]])
            continue
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

def fetch_ktc(out, picks, players):
    idx = name_index(players)
    tep_hits = [0]   # list so the row loop can bump it
    html = get(KTC_URL)
    m = re.search(r"var\s+playersArray\s*=\s*(\[.*?\]);", html, re.S)
    if not m:
        raise RuntimeError("playersArray not found — KTC page layout changed")
    rows = []
    for row in json.loads(m.group(1)):
        pos = row.get("position")
        sf = row.get("superflexValues") or {}
        if pos not in CORE:
            name = row.get("playerName") or ""
            if PICK_RE.match(name) and sf.get("value"):
                picks.setdefault("ktc", []).append([name, sf["value"]])
            continue
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
        # TE-premium variants. KTC precomputes every tier in the same payload
        # as sub-objects of superflexValues — tep (TE+), tepp (TE++), teppp
        # (TE+++). Consumers pick the tier matching a league's scoring
        # (sleeper bonus_rec_te / TE slot count); `ktc` stays the no-premium
        # value. Parsed defensively: if KTC moves these, the base value still
        # lands and the tally below flags the loss instead of failing the run.
        for sub, field in (("tep", "ktcTep"), ("tepp", "ktcTepp"),
                           ("teppp", "ktcTeppp")):
            tv = sf.get(sub)
            if isinstance(tv, dict):
                tv = tv.get("value")
            if isinstance(tv, (int, float)) and tv > 0:
                e[field] = tv
                tep_hits[0] += 1
        for key, days in (("overall7DayTrend", 7), ("sevenDayTrend", 7),
                          ("overallTrend", 7), ("overall30DayTrend", 30)):
            t = sf.get(key)
            if t is not None:
                e["ktcT"] = {str(days): int(t)}
                break
        matched += 1
    print(f"KTC matched {matched} players, {tep_hits[0]} TE-premium values")
    if matched and not tep_hits[0]:
        print("WARNING: no tep/tepp/teppp values parsed — KTC payload layout "
              "may have changed; TEP-aware consumers will fall back to base ktc")

def update_history(hist, vals, seen_today, today, cutoffs):
    """Record TODAY'S OBSERVATIONS into `hist`, then refresh each player's
    7/14/30-day deltas off it. Mutates `hist` and the rows of `vals`.

    `seen_today[src]` is the set of pids that source actually LISTED on this
    run — not every pid that ends up carrying a number for it.

    THAT DISTINCTION IS THE WHOLE FUNCTION. main() carries the previous run's
    numbers forward into `vals` so the site still shows a price for a player who
    stopped being listed (retired, renamed, or a name that stopped matching).
    Carrying the PRICE is right; recording it as a fresh observation is not.
    The guard used to be per-SOURCE — "did KTC answer at all" — so a
    carried-forward player had yesterday's number re-stamped under today's date
    on every run, and the delta scan below then compared that number against
    itself: his 7/14/30-day moves flattened to ~0 and stayed there for good.

    So a source that did not list him today records nothing for him, and his
    carried deltas are dropped rather than restated as today's. The scan skips
    nulls (it walks back to the newest row that has a real number), so a gap is
    honest and heals itself on the next run that actually sees him.
    """
    for pid, e in vals.items():
        ktc = e.get("ktc") if pid in seen_today.get("ktc", ()) else None
        fc = e.get("fc") if pid in seen_today.get("fc", ()) else None
        if ktc is None and fc is None:
            # nothing fresh for him from either source: leave his history
            # untouched, and do not leave the last run's deltas standing as
            # though they described a move that happened today
            e.pop("ktcT", None)
            e.pop("fcT", None)
            continue
        h = hist.setdefault(pid, [])
        entry = [today, ktc, fc]
        if h and h[-1][0] == today:
            # a second run on the same day must not blank a source that
            # succeeded on the first
            for i in (1, 2):
                if entry[i] is None and len(h[-1]) > i:
                    entry[i] = h[-1][i]
            h[-1] = entry
        else:
            h.append(entry)
        del h[:-45]                          # keep ~45 most recent days; the
                                             # years-deep KTC/FC backfill lives
                                             # in values_history_deep.json,
                                             # written once and never trimmed
        for name, idx in (("ktc", 1), ("fc", 2)):
            cur = e.get(name)
            if cur is None or pid not in seen_today.get(name, ()):
                # a price this source did not quote today is carried forward and
                # has no new move to report — N/A beats yesterday's delta
                e.pop(name + "T", None)
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

def main():
    ap = argparse.ArgumentParser()
    # players_min.json is LEAGUE-scoped (data/leagues/<key>/), values.json is
    # global — it is a raw market pull and belongs to no league. Both defaults
    # go through DataDir so neither has to be passed on the command line.
    ap.add_argument("--players", default=str(DATA / "players_min.json"))
    ap.add_argument("--out", default=str(DATA / "values.json"))
    args = ap.parse_args()
    players = json.loads(Path(args.players).read_text(encoding="utf-8"))
    out_path = Path(args.out)
    prev, prev_picks = {}, {}
    if out_path.exists():
        try:
            prev_all = json.loads(out_path.read_text(encoding="utf-8"))
            prev = prev_all.get("players", {})
            prev_picks = prev_all.get("picks", {})
        except Exception:
            pass
    vals, picks, ok, fresh = {}, {}, [], set()
    for name, key, fn in (("FantasyCalc", "fc", lambda: fetch_fantasycalc(vals, picks)),
                          ("KeepTradeCut", "ktc", lambda: fetch_ktc(vals, picks, players))):
        try:
            fn()
            ok.append(name)
            fresh.add(key)
        except Exception as e:
            print(f"WARNING: {name} fetch failed: {e}")
    if not vals:
        print("No sources succeeded — keeping previous values.json")
        return
    # scrub synthetic pick ids that earlier runs stored as players
    for d in (vals, prev):
        for k in [k for k in d if str(k).startswith("FP_")]:
            del d[k]
    # WHO EACH SOURCE ACTUALLY LISTED TODAY. Captured HERE, before the
    # carry-forward below merges the previous run's numbers into `vals` and the
    # two become indistinguishable. A source that failed outright lists nobody,
    # which subsumes the old per-source guard. See update_history.
    seen_today = {k: ({pid for pid, e in vals.items() if e.get(k) is not None}
                      if k in fresh else set())
                  for k in ("ktc", "fc")}
    # carry forward the other source's numbers if one failed this week
    for pid, old in prev.items():
        cur = vals.setdefault(pid, {})
        for k, v in old.items():
            cur.setdefault(k, v)
    for src, old in prev_picks.items():
        picks.setdefault(src, old)
    for src in picks:
        picks[src].sort(key=lambda x: -x[1])
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
    # A VALUE NOBODY QUOTED TODAY IS NOT AN OBSERVATION — not when the source
    # failed outright, and not when the source answered but stopped listing this
    # player. Both are carried forward into values.json (the site should still
    # show a price) and neither is written into the history. See update_history.
    update_history(hist, vals, seen_today, today, cutoffs)
    # canonical PICK history rows, keyed "pick:<season> <Early|Mid|Late> <round>".
    # Mid is what a slotless pick was worth until 2026-09-02; the ledger now
    # prices a pick at the tier its original owner's finish puts it in, so
    # EVERY tier is recorded (Max, 2026-09-02). KTC publishes the tier
    # directly ("2027 Early 1st"); FC's mid is the "(Mid)" variant when it
    # exists, else the plain generic ("2027 1st"), and "(Early)" / "(Late)"
    # name themselves.
    ktc_mid = {}
    for label, val in picks.get("ktc", []):
        m = re.match(r"^(20\d\d) (Early|Mid|Late) (\d\w\w)$", label)
        if m:
            ktc_mid[f"{m.group(1)} {m.group(2)} {m.group(3)}"] = val
    fc_mid = {}
    for label, val in picks.get("fc", []):
        m = re.match(r"^(20\d\d) (\d\w\w)( \((Early|Mid|Late)\))?$", label)
        if m:
            key = f"{m.group(1)} {m.group(4) or 'Mid'} {m.group(2)}"
            if m.group(3) or key not in fc_mid:      # "(Mid)" beats plain
                fc_mid[key] = val
    for key in sorted(set(ktc_mid) | set(fc_mid)):
        h = hist.setdefault(f"pick:{key}", [])
        entry = [today, ktc_mid.get(key) if "ktc" in fresh else None,
                 fc_mid.get(key) if "fc" in fresh else None]
        if h and h[-1][0] == today:
            for i in (1, 2):
                if entry[i] is None and len(h[-1]) > i:
                    entry[i] = h[-1][i]
            h[-1] = entry
        else:
            h.append(entry)
        del h[:-45]
    atomic_write(hist_path, json.dumps(hist, separators=(",", ":")))
    atomic_write(out_path, json.dumps({
        "fetched": time.strftime("%Y-%m-%d", time.gmtime()),
        "sources": ok, "picks": picks, "players": vals}, separators=(",", ":")))
    print(f"wrote {out_path} ({len(vals)} players; fresh: {', '.join(ok)})")

if __name__ == "__main__":
    main()
