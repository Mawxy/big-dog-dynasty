#!/usr/bin/env python3
"""
pick_value.py — Bridge A: rookie-draft slot -> realized WAR streams.

Inputs (all committed):
  nfl_history/rookie_drafts.csv   960 picks, 21 drafts, 4 superflex leagues
  nfl_history/waa_war_*.csv       sigma-calibrated historical WAR (fallback)
  nfl_history/players_meta.csv    gsis id, name, pos, draft class
  data/<season>/summary.json      REAL Big Dog league WAR (takes precedence,
                                  2022+; rows [pid,pos,gp,pts,ppg,waa,war,...])

Output: data/pick_values.json (read by the site's Draft page):
  picks: every slot 1.01-4.12 individually
  bands: dynasty-standard tiers — Early/Mid/Late Nth (picks 1-4 / 5-8 / 9-12
         within each round) — larger samples, used for the box plots.

Method (settled with Max 2026-07-17):
  * Outcome per pick-year: player's season WAR in years-since-draft 1..K.
    Real Big Dog WAR by sleeper_id when available, else calibrated
    historical WAR by gsis id, else 0.0 (busted/out of league = real zero).
    Player-seasons with no source at all (e.g. Travis Hunter pre-league,
    nflverse position filter) are skipped, not zeroed.
  * Raw values only (Max's call 2026-07-17): each season counts at its
    actual WAR, negatives included — no flooring, no smoothing.
  * Dynamic maturity: year-since-draft column K is published once
    >= MIN_CLASSES draft classes have completed that season. Year 4 unlocks
    automatically after the 2026 season — just rerun, no code change.
  * hit%% = share of picks (classes with 3 finished seasons) whose 3-year
    raw WAR total >= 1.0.  dist3 = those raw totals, for box plots.
  * Round 5 excluded (one league, tiny n).

Matching: name+pos+draft-class against players_meta, nickname fixups,
manual overrides below. Unmatched names are printed — extend MANUAL/ZEROES
if a future class adds edge cases.

Usage: python scripts/pick_value.py [--last-season 2025]
"""
import argparse, csv, json, re, statistics
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIRST_CLASS = 2019
# A year-since-draft column is published once every slot has enough real
# observations behind it — NOT after a fixed number of calendar years. Add
# leagues to the corpus and a year unlocks on the next run.
# Keyed by round: round 4 carries a lower bar because not every league in the
# corpus drafts 4 rounds, so those slots have structurally fewer contributors.
MIN_OBS_BY_ROUND = {1: 10, 2: 10, 3: 10, 4: 7}
MAX_YEARS = 6
MAX_PICK = 48            # rounds 1-4
HIT_WAR = 1.0            # 3-yr raw total that counts as a "hit"

NICK = {'cam': 'cameron', 'tank': 'nathaniel', 'joe': 'joseph', 'trevor': 'william',
        'matt': 'matthew', 'josh': 'joshua', 'ken': 'kenneth', 'mike': 'michael',
        'gabe': 'gabriel'}
MANUAL = {'Ray Davis': '00-0039875',          # nflverse legal name Re'Mahn Davis
          'A.J. Brown': '00-0035676',         # nflverse legal name Arthur Brown
          # Position mismatches: nflverse pos != Sleeper pos, so the
          # (surname, pos) key misses. Harry failed loudly (unmatched);
          # Bowden failed silently onto Ellis Bowden, a 1950s player.
          "N'Keal Harry": '00-0035624',       # nflverse TE, Sleeper WR
          'Lynn Bowden Jr.': '00-0036364'}    # nflverse WR, Sleeper RB
ZEROES = {'Brennan Eagles', 'Pooka Williams', 'Riley Ferguson', 'Tamorrion Terry'}
NO_GSIS = {'Travis Hunter'}                   # nflverse pos CB -> absent from
                                              # history; real league WAR only

ROUND_NAME = {1: '1st', 2: '2nd', 3: '3rd', 4: '4th'}
TIER_NAME = {'E': 'Early', 'M': 'Mid', 'L': 'Late'}


def norm(s):
    s = s.lower().replace('.', '').replace("'", '').replace('-', ' ')
    return re.sub(r'\s+(jr|sr|ii|iii|iv|v)$', '', s.strip())


def pick_key(p):
    rd, within = (p - 1) // 12 + 1, (p - 1) % 12 + 1
    return f"{rd}.{within:02d}"


def band_key(p):
    rd, within = (p - 1) // 12 + 1, (p - 1) % 12 + 1
    return f"{rd}{'E' if within <= 4 else 'M' if within <= 8 else 'L'}"


PICK_ORDER = [pick_key(p) for p in range(1, MAX_PICK + 1)]
BAND_ORDER = [f"{r}{t}" for r in (1, 2, 3, 4) for t in ('E', 'M', 'L')]


def band_label(b):
    return f"{TIER_NAME[b[1]]} {ROUND_NAME[int(b[0])]}"


def band_slots(b):
    rd = int(b[0])
    lo = {'E': 1, 'M': 5, 'L': 9}[b[1]]
    return f"{rd}.{lo:02d}–{rd}.{lo + 3:02d}"


def load_sources(last_season):
    meta = defaultdict(list)                       # (last, pos) -> [(name, gsis, class)]
    for r in csv.DictReader(open(ROOT / 'nfl_history' / 'players_meta.csv',
                                 encoding='utf-8')):
        n = norm(r['name'])
        meta[(n.split()[-1], r['pos'])].append((n, r['gsis_id'], r['draft_season']))

    hist = defaultdict(dict)                       # gsis -> {season: war}
    hist_seasons = set()                           # seasons whose waa_war file exists
    for yr in range(FIRST_CLASS, last_season + 1):
        f = ROOT / 'nfl_history' / f'waa_war_{yr}.csv'
        if f.exists():
            hist_seasons.add(yr)
            for r in csv.DictReader(open(f, encoding='utf-8')):
                hist[r['player_id']][yr] = float(r['WAR'])

    real = defaultdict(dict)                       # sleeper_id -> {season: war}
    for d in sorted((ROOT / 'data').iterdir()):
        if d.is_dir() and d.name.isdigit() and int(d.name) <= last_season:
            f = d / 'summary.json'
            if f.exists():
                for row in json.load(open(f, encoding='utf-8')):
                    real[str(row[0])][int(d.name)] = float(row[6])
    return meta, hist, real, hist_seasons


def match_gsis(name, pos, season, meta):
    n = norm(name)
    first, last = n.split()[0], n.split()[-1]
    # NOTE: do not widen this lookup across positions when the surname+pos key
    # misses. Tried it — a draft-class filter alone is too weak, and it
    # silently rematched Carson Strong -> Pierre Strong and Tyrod Taylor ->
    # Jonathan Taylor. Nor should first names be required to agree: nflverse
    # stores legal names (CeeDee Lamb is "Cedarian Lamb"), so ~85 correct
    # matches depend on the len(pool)==1 shortcut below. Position mismatches
    # go in MANUAL instead.
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


def summarize(order, cells, hits, years, labels=None):
    """Aggregate sample lists into the JSON bucket rows (raw means only)."""
    rows = []
    for b in order:
        h = hits.get(b, [])
        row = {
            'bucket': b,
            'n': {k: len(cells[b][k]) for k in years},
            'raw': {k: round(statistics.mean(cells[b][k]), 3)
                    for k in years if cells[b][k]},
            'hit_rate': round(sum(1 for x in h if x >= HIT_WAR) / len(h), 3) if h else None,
            'hit_n': len(h),
            'dist3': sorted(round(x, 2) for x in h),
            'dist': {k: sorted(round(x, 2) for x in cells[b][k])
                     for k in years if cells[b][k]},
        }
        if labels:
            row['label'] = labels[0](b)
            row['slots'] = labels[1](b)
        rows.append(row)
    return rows


def latest_history_season():
    """Newest NFL season with published historical WAR (waa_war_<yr>.csv).
    These land only after a season completes, so this is the right default for
    'last completed season' — and it advances on its own once war-history runs,
    which is what lets the weekly refresh pick up year-4 unlocks with no edit."""
    yrs = [int(f.stem.rsplit('_', 1)[-1])
           for f in (ROOT / 'nfl_history').glob('waa_war_*.csv')
           if f.stem.rsplit('_', 1)[-1].isdigit()]
    return max(yrs) if yrs else 2025


def main():
    ap = argparse.ArgumentParser(description="rookie pick -> WAR stream (Bridge A)")
    ap.add_argument('--last-season', type=int, default=None,
                    help='last completed NFL season '
                         '(default: newest nfl_history/waa_war_<yr>.csv)')
    args = ap.parse_args()
    last = args.last_season if args.last_season is not None else latest_history_season()

    meta, hist, real, hist_seasons = load_sources(last)

    def war_of(sleeper_id, gsis, season):
        """Real league WAR first, calibrated history second, else None."""
        if season in real.get(sleeper_id, {}):
            return real[sleeper_id][season]
        # Only treat a missing player-season as a real (busted) zero if that
        # season's waa_war file actually exists. A missing waa_war_<season>.csv
        # is "no source" -> None (skip), never a corpus-wide zero — otherwise
        # running before war-history regenerates poisons the whole column.
        if gsis is not None and season in hist_seasons:
            return hist.get(gsis, {}).get(season, 0.0)
        return None

    picks, unmatched, vets = [], [], 0
    for r in csv.DictReader(open(ROOT / 'nfl_history' / 'rookie_drafts.csv',
                                 encoding='utf-8')):
        season, pick = int(r['season']), int(r['pick_no'])
        if season > last or pick > MAX_PICK:
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
        picks.append((season, pick, r['sleeper_id'], gsis))

    # Fill every candidate year, then prune below by real observation counts.
    candidates = list(range(1, MAX_YEARS + 1))

    pcells = {b: {k: [] for k in candidates} for b in PICK_ORDER}
    bcells = {b: {k: [] for k in candidates} for b in BAND_ORDER}
    phits, bhits = defaultdict(list), defaultdict(list)
    for season, pick, sid, gsis in picks:
        pk, bk = pick_key(pick), band_key(pick)
        for k in candidates:
            yr = season + k - 1
            if yr > last:
                continue
            v = war_of(sid, gsis, yr)
            if v is not None:
                pcells[pk][k].append(v)
                bcells[bk][k].append(v)
        if season + 2 <= last:                      # 3 finished seasons
            tot = [war_of(sid, gsis, season + i) for i in range(3)]
            if all(t is not None for t in tot):
                phits[pk].append(sum(tot))
                bhits[bk].append(sum(tot))

    # Publish year k only if EVERY slot clears its round's bar. The thinnest
    # slot governs, so a published column is honest everywhere on the board.
    def slot_n(k):
        return {b: len(pcells[b][k]) for b in PICK_ORDER}

    years, gate_report = [], []
    for k in candidates:
        n = slot_n(k)
        worst = {rd: min(n[b] for b in PICK_ORDER if int(b[0]) == rd)
                 for rd in MIN_OBS_BY_ROUND}
        ok = all(worst[rd] >= MIN_OBS_BY_ROUND[rd] for rd in worst)
        gate_report.append((k, worst, ok))
        if ok:
            years.append(k)
    # Years must be contiguous from 1: a gap would break the elapsed-window
    # comparison in draft_analysis.py, which sums years 1..n.
    years = [k for i, k in enumerate(years) if k == i + 1]

    for b in PICK_ORDER:
        pcells[b] = {k: pcells[b][k] for k in years}
    for b in BAND_ORDER:
        bcells[b] = {k: bcells[b][k] for k in years}

    out = {'meta': {
        'generated_for_season': last,
        'classes': f"{FIRST_CLASS}-{last}",
        'years_published': years,
        'min_obs_by_round': MIN_OBS_BY_ROUND,
        'hit_threshold_war': HIT_WAR,
        'picks_used': len(picks), 'vets_excluded': vets,
        'unmatched': len(unmatched),
        'source': 'real Big Dog WAR where available, calibrated NFL history otherwise',
    },
        'picks': summarize(PICK_ORDER, pcells, phits, years),
        'bands': summarize(BAND_ORDER, bcells, bhits, years,
                           labels=(band_label, band_slots)),
    }

    dest = ROOT / 'data' / 'pick_values.json'
    dest.write_text(json.dumps(out, indent=1), encoding='utf-8')

    print(f"picks {len(picks)}  vets excluded {vets}  unmatched {len(unmatched)}")
    for u in unmatched:
        print('  UNMATCHED', u)
    print("year gate (thinnest slot per round vs bar "
          f"{MIN_OBS_BY_ROUND}):")
    for k, worst, ok in gate_report:
        cells = '  '.join(f"R{rd}={worst[rd]:>3}" for rd in sorted(worst))
        print(f"  yr{k}: {cells}   {'PUBLISH' if ok else 'hold'}")
    print(f"years published: {years}")
    for name, rows in (('PICKS', out['picks']), ('BANDS', out['bands'])):
        print(f"\n{name}")
        for row in rows:
            n = row['n'][years[0]]
            cols = " ".join(f"{row['raw'].get(k, float('nan')):5.2f}"
                            for k in years)
            hit = f"{row['hit_rate']:.0%}" if row['hit_rate'] is not None else '-'
            lbl = row.get('label', row['bucket'])
            print(f"  {lbl:10s} {n:>3d} | {cols} | {hit}")
    print(f"\nwrote {dest}")


if __name__ == '__main__':
    main()
