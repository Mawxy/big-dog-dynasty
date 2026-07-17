#!/usr/bin/env python3
"""
pick_value.py — Bridge A: rookie-draft slot -> realized WAR streams.

Inputs (all committed):
  nfl_history/rookie_drafts.csv   960 picks, 21 drafts, 4 superflex leagues
  nfl_history/waa_war_*.csv       sigma-calibrated historical WAR (fallback)
  nfl_history/players_meta.csv    gsis id, name, pos, draft class
  data/<season>/summary.json      REAL Big Dog league WAR (takes precedence,
                                  2022+; rows [pid,pos,gp,pts,ppg,waa,war,...])

Output: data/pick_values.json (read by the site's Draft page).

Method (settled with Max 2026-07-17):
  * Buckets: round 1 by individual pick (1.01-1.12); rounds 2-4 in
    early/mid/late thirds (E=picks 1-4, M=5-8, L=9-12 within round).
    Round 5 excluded (one league, tiny n).
  * Outcome per pick-year: player's season WAR in years-since-draft 1..K.
    Real Big Dog WAR by sleeper_id when available, else calibrated
    historical WAR by gsis id, else 0.0 (busted/out of league = real zero).
    Player-seasons with no source at all (e.g. Travis Hunter pre-league,
    nflverse position filter) are skipped, not zeroed.
  * "floor" stream clamps each season at 0 — a pick is an option; busts
    ride the bench, they don't torch your lineup. Valuation uses floor.
  * "smooth" = floor run through a pool-adjacent-violators pass so value
    never increases down the draft board (kills n~17 jitter like 1.07<1.09).
  * Dynamic maturity: year-since-draft column K is published once
    >= MIN_CLASSES draft classes have completed that season. Year 4 unlocks
    automatically after the 2026 season, year 5 after 2027 — no code change,
    just rerun.
  * hit%% = share of picks (classes with 3 finished seasons) whose 3-year
    raw WAR total >= 1.0.

Matching: name+pos+draft-class against players_meta, nickname fixups,
manual overrides below. Unmatched names are printed — extend MANUAL/ZEROES
if a future class adds edge cases.

Usage: python scripts/pick_value.py [--last-season 2025]
"""
import argparse, csv, json, re, statistics
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIRST_CLASS = 2020
MIN_CLASSES = 4          # classes needed before a year column is published
MAX_YEARS = 6
HIT_WAR = 1.0            # 3-yr raw total that counts as a "hit"

NICK = {'cam': 'cameron', 'tank': 'nathaniel', 'joe': 'joseph', 'trevor': 'william',
        'matt': 'matthew', 'josh': 'joshua', 'ken': 'kenneth', 'mike': 'michael',
        'gabe': 'gabriel'}
MANUAL = {'Ray Davis': '00-0039875'}          # nflverse legal name Re'Mahn Davis
ZEROES = {'Brennan Eagles', 'Pooka Williams', 'Riley Ferguson', 'Tamorrion Terry'}
NO_GSIS = {'Travis Hunter'}                   # nflverse pos CB -> absent from
                                              # history; real league WAR only


def norm(s):
    s = s.lower().replace('.', '').replace("'", '').replace('-', ' ')
    return re.sub(r'\s+(jr|sr|ii|iii|iv|v)$', '', s.strip())


def bucket(pick):
    if pick > 48:
        return None
    if pick <= 12:
        return f"1.{pick:02d}"
    rd = (pick - 1) // 12 + 1
    within = (pick - 1) % 12 + 1
    return f"{rd}{'E' if within <= 4 else 'M' if within <= 8 else 'L'}"


BUCKET_ORDER = [f"1.{p:02d}" for p in range(1, 13)] + \
               [f"{r}{t}" for r in (2, 3, 4) for t in ('E', 'M', 'L')]


def load_sources(last_season):
    meta = defaultdict(list)                       # (last, pos) -> [(name, gsis, class)]
    for r in csv.DictReader(open(ROOT / 'nfl_history' / 'players_meta.csv',
                                 encoding='utf-8')):
        n = norm(r['name'])
        meta[(n.split()[-1], r['pos'])].append((n, r['gsis_id'], r['draft_season']))

    hist = defaultdict(dict)                       # gsis -> {season: war}
    for yr in range(FIRST_CLASS, last_season + 1):
        f = ROOT / 'nfl_history' / f'waa_war_{yr}.csv'
        if f.exists():
            for r in csv.DictReader(open(f, encoding='utf-8')):
                hist[r['player_id']][yr] = float(r['WAR'])

    real = defaultdict(dict)                       # sleeper_id -> {season: war}
    for d in sorted((ROOT / 'data').iterdir()):
        if d.is_dir() and d.name.isdigit() and int(d.name) <= last_season:
            f = d / 'summary.json'
            if f.exists():
                for row in json.load(open(f, encoding='utf-8')):
                    real[str(row[0])][int(d.name)] = float(row[6])
    return meta, hist, real


def match_gsis(name, pos, season, meta):
    n = norm(name)
    first, last = n.split()[0], n.split()[-1]
    cands = meta.get((last, pos), [])
    cls = [c for c in cands if c[2] and int(c[2]) == season]
    pool = cls if cls else cands
    if len(pool) == 1:
        return pool[0]
    for c in pool:
        cf = c[0].split()[0]
        if cf == first or cf.startswith(first[:3]) or NICK.get(first) == cf:
            return c
    return None


def main():
    ap = argparse.ArgumentParser(description="rookie pick -> WAR stream (Bridge A)")
    ap.add_argument('--last-season', type=int, default=2025,
                    help='last completed NFL season')
    args = ap.parse_args()
    last = args.last_season

    meta, hist, real = load_sources(last)

    def war_of(sleeper_id, gsis, season):
        """Real league WAR first, calibrated history second, else None."""
        if season in real.get(sleeper_id, {}):
            return real[sleeper_id][season]
        if gsis is not None:
            return hist.get(gsis, {}).get(season, 0.0)
        return None

    picks, unmatched, vets = [], [], 0
    for r in csv.DictReader(open(ROOT / 'nfl_history' / 'rookie_drafts.csv',
                                 encoding='utf-8')):
        season = int(r['season'])
        if season > last:
            continue
        b = bucket(int(r['pick_no']))
        if not b:
            continue
        if r['name'] in MANUAL:
            gsis = MANUAL[r['name']]
        elif r['name'] in ZEROES:
            gsis = ''                              # matched, zero output
        elif r['name'] in NO_GSIS:
            gsis = None                            # real-WAR only
        else:
            m = match_gsis(r['name'], r['pos'], season, meta)
            if not m:
                unmatched.append((r['season'], r['name'], r['source']))
                continue
            if m[2] and int(m[2]) != season:        # veteran pick, not a rookie
                vets += 1
                continue
            gsis = m[1]
        picks.append((season, b, r['sleeper_id'], gsis))

    years = [k for k in range(1, MAX_YEARS + 1)
             if sum(1 for c in range(FIRST_CLASS, last + 1)
                    if c + k - 1 <= last) >= MIN_CLASSES]

    cells = {b: {k: [] for k in years} for b in BUCKET_ORDER}
    hits = defaultdict(list)
    for season, b, sid, gsis in picks:
        for k in years:
            yr = season + k - 1
            if yr > last:
                continue
            v = war_of(sid, gsis, yr)
            if v is not None:
                cells[b][k].append(v)
        if season + 2 <= last:                      # 3 finished seasons
            tot = [war_of(sid, gsis, season + i) for i in range(3)]
            if all(t is not None for t in tot):
                hits[b].append(sum(tot))

    out = {'meta': {
        'generated_for_season': last,
        'classes': f"{FIRST_CLASS}-{last}",
        'years_published': years,
        'min_classes_per_year': MIN_CLASSES,
        'hit_threshold_war': HIT_WAR,
        'picks_used': len(picks), 'vets_excluded': vets,
        'unmatched': len(unmatched),
        'source': 'real Big Dog WAR where available, calibrated NFL history otherwise',
    }, 'buckets': []}

    floor_by_year = {k: [] for k in years}          # for the monotone pass
    for b in BUCKET_ORDER:
        raw = {k: round(statistics.mean(cells[b][k]), 3)
               for k in years if cells[b][k]}
        flr = {k: round(statistics.mean([max(0.0, v) for v in cells[b][k]]), 3)
               for k in years if cells[b][k]}
        h = hits.get(b, [])
        out['buckets'].append({
            'bucket': b,
            'n': {k: len(cells[b][k]) for k in years},
            'raw': raw, 'floor': flr,
            'hit_rate': round(sum(1 for x in h if x >= HIT_WAR) / len(h), 3) if h else None,
            'hit_n': len(h),
            # sorted raw 3-yr totals (matured picks) for box plots
            'dist3': sorted(round(x, 2) for x in h),
        })
        for k in years:
            floor_by_year[k].append(flr.get(k))

    # pool-adjacent-violators: value never increases down the board
    for k in years:
        vals = floor_by_year[k]
        idx = [i for i, v in enumerate(vals) if v is not None]
        seq = [[vals[i], 1] for i in idx]            # [value, weight] blocks
        merged = []
        for blk in seq:
            merged.append(blk)
            while len(merged) > 1 and merged[-2][0] < merged[-1][0]:
                b2, b1 = merged.pop(), merged.pop()
                merged.append([(b1[0] * b1[1] + b2[0] * b2[1]) / (b1[1] + b2[1]),
                               b1[1] + b2[1]])
        flat = []
        for val, w in merged:
            flat += [val] * w
        for pos_i, i in enumerate(idx):
            out['buckets'][i].setdefault('smooth', {})[k] = round(flat[pos_i], 3)

    dest = ROOT / 'data' / 'pick_values.json'
    dest.write_text(json.dumps(out, indent=1), encoding='utf-8')

    print(f"picks {len(picks)}  vets excluded {vets}  unmatched {len(unmatched)}")
    for u in unmatched:
        print('  UNMATCHED', u)
    print(f"years published: {years}")
    hdr = " ".join(f"y{k}flr y{k}sm" for k in years)
    print(f"{'bucket':7s} {'n':>3s} | {hdr} | hit%")
    for bkt in out['buckets']:
        n = bkt['n'][years[0]]
        cols = " ".join(f"{bkt['floor'].get(k, float('nan')):5.2f} "
                        f"{bkt.get('smooth', {}).get(k, float('nan')):5.2f}"
                        for k in years)
        hit = f"{bkt['hit_rate']:.0%}" if bkt['hit_rate'] is not None else '-'
        print(f"{bkt['bucket']:7s} {n:>3d} | {cols} | {hit}")
    print(f"wrote {dest}")


if __name__ == '__main__':
    main()
