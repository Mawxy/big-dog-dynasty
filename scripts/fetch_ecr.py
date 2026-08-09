#!/usr/bin/env python3
"""
fetch_ecr.py — FantasyPros Expert Consensus Rankings -> data/ecr.json.

  python scripts/fetch_ecr.py                        # ppr-superflex
  python scripts/fetch_ecr.py --formats ppr-superflex ppr standard
  python scripts/fetch_ecr.py --probe                # report, write nothing

ECR is an ORDINAL ranking, not a value: rank, best, worst, average, stdev,
tier. It cannot be averaged into blend_values.py as-is — a rank has to be
mapped to a value scale first. Its use is as an independent opinion signal:
KTC and FantasyCalc are market prices, ECR is what analysts think, and the two
disagreeing is itself information.

Note these are REDRAFT rankings, so they price win-now. Against a dynasty
market they will sit young players lower and proven veterans higher, and that
gap is roughly "how much of this price is the future". Don't read it as a
dynasty valuation.

Output is GLOBAL (data/ecr.json), not league-scoped: like values.json it is a
property of the format, not of Big Dog. Formats are chosen to match the league
(PPR, superflex) but any league on those settings would use the same numbers.

ROBOTS: fantasypros.com/robots.txt allows /nfl/rankings/ with Crawl-delay: 5
and disallows /api/, /json/, /xml/, /ajax/. This only requests /nfl/rankings/
pages and sleeps the full delay between them. The rankings are embedded in the
page as an `ecrData` payload, so no disallowed endpoint is ever touched.
"""
import argparse, json, re, sys, time, urllib.request
from pathlib import Path

from leaguepaths import DataDir
from fetch_values import name_index, norm    # same name->sleeper-id matching

ROOT = Path(__file__).resolve().parent.parent
DATA = DataDir(ROOT / "data")
UA = {"User-Agent": "Mozilla/5.0 (BigDogDynasty league site; contact via GitHub)"}
CRAWL_DELAY = 5
BASE = "https://www.fantasypros.com/nfl/rankings/"

# FantasyPros uses the name people say; Sleeper uses the name on the birth
# certificate. Keyed by normalised FP name -> normalised Sleeper name.
ALIASES = {
    "hollywoodbrown": "marquisebrown",
    "bamknight": "zonovanknight",
}

# Only `ppr-superflex` is verified against the live site. The others follow
# FantasyPros' naming and are checked at runtime — a wrong slug silently
# redirects to the standard cheat sheet, which is why verify() exists.
FORMATS = {
    "ppr-superflex":  ("ppr-superflex-cheatsheets.php", "PPR"),
    "half-superflex": ("half-point-ppr-superflex-cheatsheets.php", "HALF"),
    "superflex":      ("superflex-cheatsheets.php", "STD"),
    "ppr":            ("ppr-cheatsheets.php", "PPR"),
    "half":           ("half-point-ppr-cheatsheets.php", "HALF"),
    "standard":       ("consensus-cheatsheets.php", "STD"),
}


def get(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=45) as r:
        return r.read().decode("utf-8", errors="replace"), r.geturl()


def balanced(src, start):
    """The JSON value starting at `start`, matched by depth and string-aware so
    a brace inside a player name can't end the capture early."""
    open_c = src[start]
    close_c = {"{": "}", "[": "]"}[open_c]
    depth = i = 0
    in_str = esc = False
    i = start
    while i < len(src):
        c = src[i]
        if in_str:
            if esc: esc = False
            elif c == "\\": esc = True
            elif c == '"': in_str = False
        elif c == '"': in_str = True
        elif c == open_c: depth += 1
        elif c == close_c:
            depth -= 1
            if depth == 0:
                return src[start:i + 1]
        i += 1
    return None


def payload(html):
    m = re.search(r"\becrData\b\s*=\s*([\{\[])", html)
    if not m:
        return None
    raw = balanced(html, m.start(1))
    try:
        return json.loads(raw) if raw else None
    except ValueError:
        return None


def fit(fp_team, sleeper_team):
    """How well a FantasyPros row's team supports it being this sleeper id.

    2 = both known and equal, 1 = at least one unknown, 0 = both known and
    different. FantasyPros leaves players stale at FA, so "FA" must not be read
    as "not him" — that would hand the id to the wrong twin whenever the real
    player is the one with the stale row."""
    a, b = (fp_team or "").upper(), (sleeper_team or "").upper()
    if a in ("", "FA") or b in ("", "FA"):
        return 1
    return 2 if a == b else 0


def verify(data, key, url, final_url):
    """A bad slug redirects to the standard cheat sheet rather than 404ing, so
    confirm the page we got is the format we asked for before trusting it."""
    want = FORMATS[key][1]
    got = (data.get("scoring") or "").upper()
    problems = []
    if final_url.rstrip("/") != url.rstrip("/"):
        problems.append(f"redirected to {final_url}")
    if got and want and got != want:
        problems.append(f"scoring is {got}, expected {want}")
    # There is deliberately no superflex assertion here: the payload carries no
    # superflex marker (`type` is just "Draft PPR"). FantasyPros redirects a bad
    # slug rather than 404ing, so "we asked for the superflex URL and were not
    # redirected" is the whole guarantee, and the check above is it.
    return problems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--formats", nargs="+", default=["ppr-superflex"],
                    choices=sorted(FORMATS))
    ap.add_argument("--players", default=str(DATA / "players_min.json"))
    ap.add_argument("--out", default=str(DATA / "ecr.json"))
    ap.add_argument("--probe", action="store_true", help="report only, write nothing")
    args = ap.parse_args()

    players = json.loads(Path(args.players).read_text(encoding="utf-8"))
    idx = name_index(players)
    # pid -> NFL team, the only field that separates two players who share a
    # name AND a position. players_min rows are [name, pos, team].
    teams = {pid: (pl[2] or "").upper()
             for pid, pl in players.items() if isinstance(pl, list) and len(pl) > 2}

    out = {"fetched": time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime()),
           "source": "FantasyPros ECR", "formats": {}, "players": {}}
    prev_fetched = None
    if not args.probe and Path(args.out).exists():
        try:                                   # keep formats fetched previously
            old = json.loads(Path(args.out).read_text(encoding="utf-8"))
            out["formats"] = old.get("formats", {})
            out["players"] = old.get("players", {})
            prev_fetched = old.get("fetched")
        except ValueError:
            pass

    fresh = []                                 # formats that actually returned rows
    for n, key in enumerate(args.formats):
        slug, _ = FORMATS[key]
        url = BASE + slug
        if n:
            time.sleep(CRAWL_DELAY)
        print(f"GET {url}")
        try:
            html, final = get(url)
        except Exception as e:
            print(f"  !! fetch failed: {e}")
            continue
        data = payload(html)
        if not data:
            print("  !! no ecrData payload — page structure changed")
            continue
        for p in verify(data, key, url, final):
            print(f"  ~~ {p}")
        rows = data.get("players") or []
        # This format just fetched fresh rows, so every CARRIED entry for it is
        # now stale. Strip the key before writing today's: a player who fell
        # out of the consensus loses his slug — absence is real information
        # (the ECR component scores 0) — while other formats' carried entries
        # survive a single-format run untouched. Without this, setdefault()
        # unions old and new and the carrier count drifts past meta.matched.
        for rec in out["players"].values():
            rec.pop(key, None)
        matched = unmatched = 0
        posfix = 0
        misses: list[str] = []
        # Two ranked players resolving to one sleeper id means the second
        # overwrites the first — a silent wrong answer, not a missing one, so
        # it is worth more noise than an unmatched name.
        claimed: dict[str, tuple[str, str]] = {}    # pid -> (label, fp team)
        dupes: list[str] = []
        resolved: list[str] = []
        for r in rows:
            pos = (r.get("player_position_id") or "").upper()
            # norm() strips punctuation AND name suffixes, so "Marvin Harrison
            # Jr." matches Sleeper's "Marvin Harrison". name_index values are
            # (pid, preference) — the pid is the first element.
            nm = norm(r.get("player_name") or "")
            nm = ALIASES.get(nm, nm)
            hit = idx.get((nm, pos))
            if not hit:
                # The two sources disagree on position more often than on
                # identity — Kyle Juszczyk is FB to Sleeper and RB to
                # FantasyPros. Fall back to the name alone, but only when it
                # is unambiguous across positions.
                cands = [v for (n2, _p), v in idx.items() if n2 == nm]
                if len(cands) == 1:
                    hit = cands[0]
                    posfix += 1
            if not hit:
                unmatched += 1
                if unmatched <= 8:
                    misses.append(f"{r.get('player_name')} ({pos})")
                continue
            pid = hit[0]
            tm = (r.get("player_team_id") or "").upper()
            who = f"{r.get('player_name')} ({pos}, {tm or '--'})"
            prev = claimed.get(pid)
            if prev:
                # Two RANKED players, one sleeper id. Not a normalisation bug:
                # FantasyPros ranks everyone, players_min only holds ids this
                # league references, so the twin genuinely isn't ours. Team is
                # the only field that separates them — but FantasyPros carries
                # stale FAs, so an UNKNOWN team is absence of evidence while a
                # known conflicting one is evidence of a different player.
                want = teams.get(pid, "")
                mine, theirs = fit(tm, want), fit(prev[1], want)
                if mine > theirs:
                    # evict: the row already counted was the other player
                    matched -= 1
                    unmatched += 1
                    resolved.append(f"{who} over {prev[0]} [sleeper: {want or '--'}]")
                elif theirs > mine:
                    unmatched += 1             # already had the better one
                    resolved.append(f"{prev[0]} over {who} [sleeper: {want or '--'}]")
                    continue
                else:
                    dupes.append(f"{prev[0]} / {who} -> {pid}"
                                 f" [sleeper: {want or '--'}]")
                    continue                   # no separation: keep the higher-ranked
            matched += 1
            claimed[pid] = (who, tm)
            out["players"].setdefault(pid, {})[key] = {
                "ecr": r.get("rank_ecr"), "posRank": r.get("pos_rank"),
                "best": r.get("rank_min"), "worst": r.get("rank_max"),
                "avg": r.get("rank_ave"), "std": r.get("rank_std"),
                "tier": r.get("tier"), "delta": r.get("player_ecr_delta"),
            }
        out["formats"][key] = {
            "scoring": data.get("scoring"), "year": data.get("year"),
            "week": data.get("week"), "type": data.get("type"),
            "experts": data.get("total_experts"),
            "updated": data.get("last_updated"),
            "ranked": len(rows), "matched": matched,
        }
        fresh.append(key)
        print(f"  {len(rows)} ranked · {matched} matched to sleeper ids · "
              f"{unmatched} unmatched ({data.get('total_experts')} experts, "
              f"updated {data.get('last_updated')})")
        if posfix:
            print(f"     {posfix} matched by name after a position disagreement")
        for d in resolved:
            print(f"     same name, split by team: kept {d}")
        for d in dupes:
            print(f"  !! ambiguous, kept the higher-ranked: {d}")
        if misses:
            print(f"     first unmatched: {', '.join(misses)}")

    if args.probe:
        print("\n--probe: nothing written")
        return
    if not out["formats"]:
        sys.exit("no formats fetched — refusing to write")
    if not fresh:
        # Every format failed and everything in `out` was carried over from the
        # previous file. Stamping today's date on it would make week-old data
        # read as fetched-just-now, which is the one thing this timestamp is
        # for. Keep the old one — each format's own `updated` is unchanged too.
        out["fetched"] = prev_fetched or out["fetched"]
        print("\n!! no format fetched — carried data kept, `fetched` left at "
              f"{out['fetched']}")
    # a player stripped from his last remaining format is an empty record
    out["players"] = {pid: rec for pid, rec in out["players"].items() if rec}
    Path(args.out).write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print(f"\nwrote {args.out} · {len(out['players'])} players across "
          f"{len(out['formats'])} format(s)")


if __name__ == "__main__":
    main()
