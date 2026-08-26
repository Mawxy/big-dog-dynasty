#!/usr/bin/env python3
"""
backfill_ktc_history.py — extend data/values_history.json backward with the
value history embedded in KeepTradeCut player pages.

Why: values_history.json only reaches back to 2026-07-15 (when the nightly
snapshotting started), so trade-snapshot market backfills stop there. KTC's
player pages carry each player's full value-over-time series (the graph on the
page), embedded in the HTML the same way the rankings page embeds playersArray.
One page per player, politely paced, gets the ledger's "then" figures years of
reach. Values courtesy of KeepTradeCut — same attribution as fetch_values.py.

The embedded variable names are NOT pinned by any API contract, so parsing is
deliberately heuristic: the script scans every JS object/array literal in the
page for date+number series and reports what it found. Run --probe first.

FantasyCalc history rides the same script: their player pages feed the value
graph from `GET api.fantasycalc.com/trades/implied/<fcId>?isDynasty=true&
numQbs=2` -> [{"date": "07/01/2025", "value": 8085}, ...] (found via DevTools
with Max, 2026-08-21; roughly a rolling year of daily values, vs KTC's five).

Usage:
  python scripts/backfill_ktc_history.py --probe        # ONE KTC page, show what parses
  python scripts/backfill_ktc_history.py                # KTC backfill (~5 min)
  python scripts/backfill_ktc_history.py --fc           # FantasyCalc backfill
  python scripts/backfill_ktc_history.py --picks        # KTC mid-tier pick pages
  python scripts/backfill_ktc_history.py --limit 25     # first 25 players only

Writes data/values_history_deep.json — NOT the nightly values_history.json,
whose writer trims every series to 45 days and would delete the backfill the
next night. The deep file is written once and left alone; consumers merge the
two, nightly rows winning. Merging here is per-FIELD: a date's ktc and fc
slots each fill only when empty, so the backfills can run in either order.
Picks are keyed "pick:<season> Mid <round>", matching the nightly writer.
"""
import argparse, json, re, sys, time, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
UA = {"User-Agent": "Mozilla/5.0 (BigDogDynasty league site)"}
DELAY = 0.6                      # be a polite guest: ~600 pages in ~7 minutes
BASE = "https://keeptradecut.com/dynasty-rankings"

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}")


def get(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=45) as r:
        return r.read().decode("utf-8")


ASSIGN_RE = re.compile(
    r"(?:var|let|const)?\s*([\w.]+)\s*=\s*([\[{])", re.S)


def balanced_literal(html, start, opener):
    """The full {...}/[...] literal starting at `start`, by bracket depth —
    the lazy `.*?;` regex dies the moment a literal contains `};` inside."""
    closer = "]" if opener == "[" else "}"
    depth, i, in_str, esc = 0, start, False, False
    while i < len(html):
        c = html[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
        elif c == '"':
            in_str = True
        elif c == opener:
            depth += 1
        elif c == closer:
            depth -= 1
            if depth == 0:
                return html[start:i + 1]
        i += 1
    return None


def js_object_literals(html, report=None):
    """Every `NAME = {...}` / `NAME = [...]` assignment whose literal parses
    as JSON (var/let/const or bare). With `report`, also record what DIDN'T
    parse, so a probe shows the variables that exist either way."""
    out = {}
    for m in ASSIGN_RE.finditer(html):
        name, opener = m.group(1), m.group(2)
        lit = balanced_literal(html, m.end() - 1, opener)
        if lit is None or len(lit) < 50:
            continue
        try:
            out[name] = json.loads(lit)
            if report is not None:
                report.append((name, len(lit), "parsed"))
        except ValueError:
            if report is not None:
                report.append((name, len(lit), f"no-parse: {lit[:70]!r}"))
    return out


def date_series(obj, path="$"):
    """Recursively find lists of {date-ish: 'YYYY-MM-DD', number} points —
    the shape a value-history graph feeds on, whatever the keys are called."""
    found = []
    if isinstance(obj, list) and len(obj) >= 10 and all(isinstance(x, dict) for x in obj[:5]):
        sample = obj[0]
        dkey = next((k for k, v in sample.items()
                     if isinstance(v, str) and DATE_RE.match(v)), None)
        vkey = next((k for k, v in sample.items()
                     if isinstance(v, (int, float)) and not isinstance(v, bool) and v > 100), None)
        if dkey and vkey:
            pts = [(x[dkey][:10], int(x[vkey])) for x in obj
                   if isinstance(x.get(dkey), str) and DATE_RE.match(x[dkey])
                   and isinstance(x.get(vkey), (int, float))]
            if len(pts) >= 10:
                found.append((path, dkey, vkey, pts))
    if isinstance(obj, dict):
        for k, v in obj.items():
            found += date_series(v, f"{path}.{k}")
    elif isinstance(obj, list) and obj and isinstance(obj[0], (dict, list)):
        for i, v in enumerate(obj[:3]):
            found += date_series(v, f"{path}[{i}]")
    return found


def pick_series(candidates):
    """The superflex series: prefer paths mentioning superflex, then the
    longest series — a player page also embeds the 1QB graph."""
    if not candidates:
        return None
    sf = [c for c in candidates if "superflex" in c[0].lower() or "sf" in c[0].lower()]
    pool = sf or candidates
    return max(pool, key=lambda c: len(c[3]))


def sf_history(html):
    """The pinned extraction (probed 2026-08-21): each player page embeds
    `playerSuperflex.overallValue` = [{"d": "YYMMDD", "v": 6994}, ...] — the
    full daily superflex value series back to 2021-03-18 on the probe page.
    Base ladder (no TE premium), which matches values_history's ktc column.
    Returns [("YYYY-MM-DD", value), ...] or None."""
    m = re.search(r"playerSuperflex\s*=\s*\{", html)
    if not m:
        return None
    lit = balanced_literal(html, m.end() - 1, "{")
    if not lit:
        return None
    try:
        obj = json.loads(lit)
    except ValueError:
        return None
    pts = []
    for row in obj.get("overallValue") or []:
        d, v = row.get("d"), row.get("v")
        if isinstance(d, str) and len(d) == 6 and d.isdigit() and \
                isinstance(v, (int, float)) and v > 0:
            pts.append((f"20{d[:2]}-{d[2:4]}-{d[4:6]}", int(v)))
    return pts or None


FC_CURRENT = ("https://api.fantasycalc.com/values/current"
              "?isDynasty=true&numQbs=2&numTeams=12&ppr=1")
FC_IMPLIED = "https://api.fantasycalc.com/trades/implied/{fc_id}?isDynasty=true&numQbs=2"
FC_DATE = re.compile(r"^(\d{2})/(\d{2})/(\d{4})$")


def merge_rows(hist, pid, col, pts):
    """Fill one source's column for one player: [d, ktc, fc], per-field —
    a slot already holding a value (the nightly pull's) is never touched."""
    rows = {r[0]: r for r in hist.get(pid, [])}
    for d, v in pts:
        row = rows.setdefault(d, [d, None, None])
        if row[col] is None:
            row[col] = v
    hist[pid] = sorted(rows.values())


def fc_pick_key(name):
    """FC pick label -> canonical 'pick:<YYYY> Mid <ord>' (mid tier); the
    '(Mid)' variant is preferred over the plain generic by sort order below."""
    m = re.match(r"^(20\d\d) (\d\w\w)( \(Mid\))?$", name or "")
    return (f"pick:{m.group(1)} Mid {m.group(2)}", bool(m.group(3))) if m else (None, False)


def fc_backfill(hist, limit):
    """FantasyCalc: one implied-value call per ranked asset, joined by the
    sleeperId their own API carries — no name matching needed. Picks ride the
    same endpoint (they're rows in values/current too) into pick:* keys."""
    rows = json.loads(get(FC_CURRENT))
    todo = []
    for r in rows:
        p = r.get("player") or {}
        sid = str(p.get("sleeperId") or "")
        if sid.startswith("RESERVED"):
            continue
        if sid.startswith("FP_") or p.get("position") == "PICK":
            key, is_mid = fc_pick_key(p.get("name"))
            if key:
                todo.append((0 if is_mid else 1, key, p))   # "(Mid)" first
        elif sid:
            todo.append((2, sid, p))
    todo.sort(key=lambda t: t[0])
    if limit:
        todo = todo[:limit]
    print(f"{len(todo)} FC-ranked assets (players + mid picks)")
    n_ok = n_empty = 0
    for i, (_, key, p) in enumerate(todo):
        time.sleep(DELAY)
        try:
            series = json.loads(get(FC_IMPLIED.format(fc_id=p["id"])))
        except Exception as e:
            print(f"  skip {p.get('name')}: {e}")
            continue
        pts = []
        for x in series if isinstance(series, list) else []:
            m = FC_DATE.match(str(x.get("date", "")))
            v = x.get("value")
            if m and isinstance(v, (int, float)) and v > 0:
                pts.append((f"{m.group(3)}-{m.group(1)}-{m.group(2)}", int(v)))
        if not pts:
            n_empty += 1
            continue
        merge_rows(hist, key, 2, pts)
        n_ok += 1
        if (i + 1) % 50 == 0:
            print(f"  {i + 1}/{len(todo)}, {n_ok} merged")
    print(f"FC done: {n_ok} assets merged, {n_empty} empty series")


def player_links():
    """(playerName, slug) for every ranked player, straight off the rankings
    page's own playersArray — names and slugs from the source of truth."""
    html = get(BASE)
    m = re.search(r"var\s+playersArray\s*=\s*(\[.*?\]);", html, re.S)
    if not m:
        sys.exit("playersArray not found — KTC page layout changed")
    out = []
    for row in json.loads(m.group(1)):
        slug = row.get("slug")
        if slug and row.get("position") in {"QB", "RB", "WR", "TE"}:
            out.append((row.get("playerName", ""), slug))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--probe", action="store_true",
                    help="fetch ONE player page and print every date+value "
                         "series found, then stop — run this first")
    ap.add_argument("--fc", action="store_true",
                    help="backfill FantasyCalc history (trades/implied) "
                         "instead of KTC pages")
    ap.add_argument("--picks", action="store_true",
                    help="backfill KTC mid-tier PICK pages (a dozen requests)")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--out", default=str(DATA / "values_history_deep.json"))
    args = ap.parse_args()

    if args.picks:
        hist = json.loads(Path(args.out).read_text(encoding="utf-8")) if Path(args.out).exists() else {}
        html = get(BASE)
        rows = json.loads(re.search(r"var\s+playersArray\s*=\s*(\[.*?\]);", html, re.S).group(1))
        mids = [(r["playerName"], r["slug"]) for r in rows
                if r.get("slug") and re.match(r"^20\d\d Mid \d\w\w$", r.get("playerName", ""))]
        print(f"{len(mids)} mid-tier picks")
        n = 0
        for label, slug in mids:
            time.sleep(DELAY)
            pts = sf_history(get(f"{BASE}/players/{slug}"))
            if pts:
                merge_rows(hist, f"pick:{label}", 1, pts)
                n += 1
                print(f"  pick:{label}  {len(pts)} pts  {pts[0][0]}..{pts[-1][0]}")
        Path(args.out).write_text(json.dumps(hist, separators=(",", ":")), encoding="utf-8")
        print(f"done: {n} picks -> {args.out}")
        return

    if args.fc:
        hist = json.loads(Path(args.out).read_text(encoding="utf-8")) if Path(args.out).exists() else {}
        fc_backfill(hist, args.limit)
        Path(args.out).write_text(json.dumps(hist, separators=(",", ":")), encoding="utf-8")
        print(f"wrote {args.out}")
        return

    links = player_links()
    print(f"{len(links)} ranked players")
    if args.probe:
        name, slug = links[0]
        print(f"probe: {name} — {BASE}/players/{slug}")
        html = get(f"{BASE}/players/{slug}")
        report = []
        objs = js_object_literals(html, report)
        print(f"-- {len(report)} JS literals ≥50 chars found:")
        for nm, sz, status in sorted(report, key=lambda r: -r[1])[:25]:
            print(f"   {nm}  ({sz:,} chars)  {status}")
        pts = sf_history(html)
        hits = 0
        if pts:
            hits = 1
            print(f"SERIES playerSuperflex.overallValue  {len(pts)} pts  "
                  f"{pts[0][0]}..{pts[-1][0]}  sample {pts[-3:]}")
        if not hits:
            print("-- no series matched the heuristic; structure of the two "
                  "biggest objects (lists >20 items shown with first element):")

            def dump(obj, path, depth=0):
                if depth > 4:
                    return
                if isinstance(obj, dict):
                    for k, v in obj.items():
                        if isinstance(v, (dict, list)):
                            dump(v, f"{path}.{k}", depth + 1)
                        # scalars only worth naming at shallow depth
                        elif depth <= 1:
                            print(f"   {path}.{k} = {v!r}"[:110])
                elif isinstance(obj, list):
                    if len(obj) > 20:
                        print(f"   {path}  LIST[{len(obj)}]  first={json.dumps(obj[0])[:140]}")
                    elif obj:
                        dump(obj[0], f"{path}[0]", depth + 1)

            for nm in ("playerSuperflex", "playerOneQB"):
                if nm in objs:
                    print(f"--- {nm}:")
                    dump(objs[nm], nm)
        return

    # sleeper-id join: same normalized name+pos matching fetch_values uses
    sys.path.insert(0, str(ROOT / "scripts"))
    from fetch_values import name_index, norm
    players_min = None
    for cand in (DATA / "players_min.json", ROOT / "sleeper_data" / "players.json"):
        if Path(cand).exists():
            players_min = json.loads(Path(cand).read_text(encoding="utf-8"))
            break
    if players_min is None:
        sys.exit("need data/players_min.json or sleeper_data/players.json for the id join")
    idx = name_index(players_min)
    pos_of = {}
    for row in json.loads(re.search(r"var\s+playersArray\s*=\s*(\[.*?\]);",
                                    get(BASE), re.S).group(1)):
        if row.get("slug"):
            pos_of[row["slug"]] = row.get("position")

    hist = json.loads(Path(args.out).read_text(encoding="utf-8")) if Path(args.out).exists() else {}
    todo = links[:args.limit] if args.limit else links
    n_ok = n_nomatch = n_noseries = 0
    for i, (name, slug) in enumerate(todo):
        time.sleep(DELAY)
        try:
            html = get(f"{BASE}/players/{slug}")
        except Exception as e:
            print(f"  skip {slug}: {e}")
            continue
        pts = sf_history(html)
        if not pts:
            n_noseries += 1
            continue
        hit = idx.get((norm(name), pos_of.get(slug)))
        if not hit:
            n_nomatch += 1
            continue
        merge_rows(hist, hit[0], 1, pts)
        n_ok += 1
        if (i + 1) % 50 == 0:
            print(f"  {i + 1}/{len(todo)} pages, {n_ok} merged")
    Path(args.out).write_text(json.dumps(hist, separators=(",", ":")), encoding="utf-8")
    print(f"done: {n_ok} players merged, {n_nomatch} unmatched names, "
          f"{n_noseries} pages with no series -> {args.out}")
    if n_noseries and not n_ok:
        print("WARNING: nothing parsed — run --probe and send me the output")


if __name__ == "__main__":
    main()
