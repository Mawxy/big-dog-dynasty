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
import argparse, json, re, time, urllib.error, urllib.request
from datetime import date as _dt_date, timedelta as _dt_td
from pathlib import Path

from ioutil import atomic_write
from leaguepaths import DataDir

ROOT = Path(__file__).resolve().parent.parent
DATA = DataDir(ROOT / "data")

UA = {"User-Agent": "Mozilla/5.0 (BigDogDynasty league site)"}
FC_URL = "https://api.fantasycalc.com/values/current?isDynasty=true&numQbs=2&numTeams=12&ppr=1"
KTC_URL = "https://keeptradecut.com/dynasty-rankings"
CORE = {"QB", "RB", "WR", "TE"}
# how long a source may go unanswered before its trends are dropped rather
# than shown "as of" the last day it answered
STALE_DAYS = 10
# the delta windows the board shows, in days. Only the SPAN matters — the
# cutoff dates are derived per player from his own last observation, not from
# a table computed here (see update_history).
DELTA_DAYS = (7, 14, 30)
# how far back values_history.json keeps a row. Long enough for the widest
# delta window above with room for missed days, and for trade_analysis's
# "price it as of the trade day" backfill, which tolerates a 45-day gap.
HISTORY_DAYS = 45

# Two attempts and a short backoff. One tries; the second covers the transient
# — a reset connection, a 502 from KTC's CDN, a DNS blip — which is otherwise a
# whole day with no market observation for that source, and a hole in the
# history that no later run can fill. A 4xx is not retried: a moved page or a
# blocked scrape will say the same thing a second later.
RETRIES = 3
BACKOFF = 2.0


def get(url):
    req = urllib.request.Request(url, headers=UA)
    for attempt in range(1, RETRIES + 1):
        try:
            with urllib.request.urlopen(req, timeout=45) as r:
                return r.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            if e.code < 500 or attempt == RETRIES:
                raise
            why = f"HTTP {e.code}"
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            if attempt == RETRIES:
                raise
            why = str(e)
        print(f"  retry {attempt}/{RETRIES - 1} for {url.split('?')[0]}: {why}")
        time.sleep(BACKOFF * attempt)

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

def ktc_players(html):
    """The rankings page's player array, wherever KTC keeps it this month.

    On 2026-09-08 KTC moved it out of the inline `var playersArray = [...]`
    into a `<script id="ktc-players" type="application/json">` block that
    the page then parses (`var playersArray = JSON.parse(document
    .getElementById('ktc-players').textContent)`). The row shape did not
    change — superflexValues.value / rank / tep / overall7DayTrend are all
    still there — so the parser tries the JSON block first and falls back
    to the old inline literal, and says which one it found.
    """
    m = re.search(
        r"<script[^>]*\bid=[\"']ktc-players[\"'][^>]*>(.*?)</script>", html, re.S)
    if m:
        arr = json.loads(m.group(1).strip())
        print(f"KTC: {len(arr)} rows from the ktc-players JSON block")
        return arr
    m = re.search(r"var\s+playersArray\s*=\s*(\[.*?\]);", html, re.S)
    if m:
        arr = json.loads(m.group(1))
        print(f"KTC: {len(arr)} rows from the inline playersArray")
        return arr
    raise RuntimeError("playersArray not found — KTC page layout changed "
                       "(neither #ktc-players nor an inline literal)")


def fetch_ktc(out, picks, players):
    idx = name_index(players)
    tep_hits = [0]   # list so the row loop can bump it
    html = get(KTC_URL)
    rows = []
    for row in ktc_players(html):
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

def trim_history(hist, today, days=HISTORY_DAYS, max_rows=HISTORY_DAYS):
    """Age rows out of `hist`, and drop keys that empty.

    The old trim was `del h[:-45]` — the 45 most recent ROWS. For a player
    quoted every day that is 45 days; for one who stopped being quoted it is
    forever, because no new row ever arrives to push the old ones off the
    front. A delisted player (retired, renamed, a name that stopped matching)
    therefore kept his last handful of rows in values_history.json for good,
    and the file only ever grew. Trimming by DATE ages him out; the row cap
    stays as a backstop against a day with several runs."""
    cut = (_dt_date.fromisoformat(today) - _dt_td(days=days)).isoformat()
    for key in list(hist):
        rows = [r for r in hist[key] if r and r[0] >= cut][-max_rows:]
        if rows:
            hist[key] = rows
        else:
            del hist[key]


def update_history(hist, vals, seen_today, today, deltas=DELTA_DAYS):
    """Record TODAY'S OBSERVATIONS into `hist`, then refresh each player's
    7/14/30-day deltas off it. Mutates `hist` and the rows of `vals`.

    `seen_today[src]` is the set of pids that source actually LISTED on this
    run — not every pid that ends up carrying a number for it. `deltas` is the
    windows to report, in DAYS: each one's baseline is derived per player from
    his own last observation, so a caller has nothing to compute.

    THAT DISTINCTION IS THE WHOLE FUNCTION. main() carries the previous run's
    numbers forward into `vals` so the site still shows a price for a player who
    stopped being listed (retired, renamed, or a name that stopped matching).
    Carrying the PRICE is right; recording it as a fresh observation is not.
    The guard used to be per-SOURCE — "did KTC answer at all" — so a
    carried-forward player had yesterday's number re-stamped under today's date
    on every run, and the delta scan below then compared that number against
    itself: his 7/14/30-day moves flattened to ~0 and stayed there for good.

    So a source that did not list him today records nothing for him. His
    deltas are then computed AS OF his last real observation — the newest
    history row where that source quoted him — and stamped `<src>AsOf` with
    that date, so the board can say "as of Sep 7" rather than go blank
    (Max, 2026-09-08: one missed KTC scrape emptied the market movers). A
    delta is only ever measured between two observations of the same source,
    never against a carried-forward copy of itself. Past STALE_DAYS the
    deltas are dropped rather than shown as a move nobody has seen lately.
    """
    _date, _td = _dt_date, _dt_td
    for pid, e in vals.items():
        ktc = e.get("ktc") if pid in seen_today.get("ktc", ()) else None
        fc = e.get("fc") if pid in seen_today.get("fc", ()) else None
        # no empty history entry for a player nobody quoted today
        h = hist.setdefault(pid, []) if (ktc is not None or fc is not None) else hist.get(pid, [])
        if ktc is not None or fc is not None:
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
        for name, idx in (("ktc", 1), ("fc", 2)):
            fresh = pid in seen_today.get(name, ()) and e.get(name) is not None
            # the source's own native trend (KTC's 7-day) is the labeled
            # fallback while our history is too shallow to align one — but
            # only when the source listed him TODAY; otherwise it is the
            # previous run's figure wearing today's date
            native = (e.get(name + "T") or {}) if fresh else {}
            e.pop(name + "T", None)
            e.pop(name + "AsOf", None)
            # the newest row where THIS source actually quoted him — today if
            # it answered, else the last day it did
            obs = None
            for row in h:
                if len(row) > idx and row[idx] is not None:
                    obs = row
            if obs is None:
                continue
            as_of, cur = obs[0], obs[idx]
            try:
                age = (_date.fromisoformat(today) - _date.fromisoformat(as_of)).days
            except ValueError:
                continue
            if age > STALE_DAYS:
                continue
            trends = dict(native)
            for d in deltas:
                cutoff = (_date.fromisoformat(as_of) - _td(days=d)).isoformat()
                base = None
                for row in h:                # most recent snapshot >= d days before as_of
                    if row[0] <= cutoff and len(row) > idx and row[idx] is not None:
                        base = row[idx]
                if base is not None:
                    trends[str(d)] = cur - base
            if trends:
                e[name + "T"] = trends
                if age > 0:
                    e[name + "AsOf"] = as_of
    # the rows that just aged past the window, plus any left behind by a player
    # nobody quotes any more — see trim_history
    trim_history(hist, today)

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
    today = _dt_date.today().isoformat()
    # A VALUE NOBODY QUOTED TODAY IS NOT AN OBSERVATION — not when the source
    # failed outright, and not when the source answered but stopped listing this
    # player. Both are carried forward into values.json (the site should still
    # show a price) and neither is written into the history. See update_history.
    update_history(hist, vals, seen_today, today)
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
    # the pick ladders age out on the same rule as the players above; a tier
    # KTC stops publishing must not sit in the file forever either
    trim_history(hist, today)
    atomic_write(hist_path, json.dumps(hist, separators=(",", ":")))
    atomic_write(out_path, json.dumps({
        "fetched": time.strftime("%Y-%m-%d", time.gmtime()),
        "sources": ok, "picks": picks, "players": vals}, separators=(",", ":")))
    print(f"wrote {out_path} ({len(vals)} players; fresh: {', '.join(ok)})")

if __name__ == "__main__":
    main()
