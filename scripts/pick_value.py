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
    raw WAR total >= 1.0.
  * Round 5 excluded (one league, tiny n).

Matching: name+pos+draft-class against players_meta, nickname fixups,
manual overrides below. Unmatched names are printed — extend MANUAL/ZEROES
if a future class adds edge cases.

Usage: python scripts/pick_value.py [--last-season 2025]
"""
import argparse, csv, json, re, statistics
from collections import defaultdict
from pathlib import Path
from leaguepaths import DataDir
# franchise bars live in one place — see METHODOLOGY.md "Franchise players"
from franchise_players import FRANCHISE_BAR, MIN_SEASONS as FRANCHISE_SEASONS


ROOT = Path(__file__).resolve().parent.parent
DATA = DataDir(ROOT / "data")
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
OUT_MIN_CLASSES = 4      # classes that must complete year k before its
                         # out_rate publishes (deeper years are class-thin)
# crawl rookie-pick corpus blend: ignore (slot, player) combos taken in fewer
# than CRAWL_MIN leagues (flukes), and give each slot EXACTLY CRAWL_BUDGET
# weighted observations split across its players by how often each was taken.
#
# "Exactly" is load-bearing. The allocation used to be
# `max(1, round(BUDGET * cnt / tot))`, and the floor of one broke the budget:
# a median slot keeps ~54 distinct players, ~50 of whom round to zero share and
# were each handed a rep anyway. Slots ran to ~78 reps against a budget of 40,
# and the surplus was all noise tail. At 2023 1.01 that gave Bijan Robinson —
# 88.9% of real league picks — only 47.4% of the model's weight, with 39 rarely
# taken players carrying the rest. Across all 336 slots the modal pick held a
# median 14.7% of real picks but 7.5% of model weight. Because rare picks are
# on average worse players, every slot median was biased DOWN, worst at the top
# of round one where consensus is strongest. Largest-remainder allocation with
# no floor fixes it: the reps sum to CRAWL_BUDGET and a player nobody really
# takes contributes nothing.
CRAWL_MIN = 3
CRAWL_BUDGET = 40

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
    for d in sorted((DATA).iterdir()):
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


def summarize(order, cells, hits, years, outs, out_years, fran=None, labels=None):
    """Aggregate sample lists into the JSON bucket rows (raw means only)."""
    rows = []
    for b in order:
        h = hits.get(b, [])
        row = {
            'bucket': b,
            'n': {k: len(cells[b][k]) for k in years},
            'raw': {k: round(statistics.mean(cells[b][k]), 3)
                    for k in years if cells[b][k]},
            # share of year-k observations that are out-of-league FOR GOOD:
            # no trace in year k or any later observed season, so the column
            # is cumulative (monotone within a class). A missed year before a
            # comeback is a hiatus and does not count. Distinct from "played,
            # ~0 WAR" — that carries a real figure. Published only for
            # out_years (enough classes deep) — later years are class-thin
            # survivor noise, not yet available rather than wrong.
            'out_rate': {k: round(outs[b][k] / len(cells[b][k]), 3)
                         for k in out_years if cells[b][k]},
            'hit_rate': round(sum(1 for x in h if x >= HIT_WAR) / len(h), 3) if h else None,
            'hit_n': len(h),
            # share of matured picks at this slot that became a franchise
            # player at their position. Replaces out_rate on the Draft page:
            # "did it become a long-term starter" is the question a dynasty
            # manager is actually asking of a pick.
            'fran_rate': (round(fran[b][0] / fran[b][1], 3)
                          if fran and fran.get(b) and fran[b][1] else None),
            'fran_n': (fran[b][1] if fran and fran.get(b) else 0),
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

    last_trace_cache = {}

    def last_trace(sleeper_id, gsis):
        """Newest season with ANY trace of the player (real league WAR or
        calibrated history). None = never seen."""
        key = (sleeper_id, gsis)
        if key not in last_trace_cache:
            mx = max(real.get(sleeper_id, {}), default=None)
            if gsis:
                h = max(hist.get(gsis, {}), default=None)
                if mx is None or (h is not None and h > mx):
                    mx = h
            last_trace_cache[key] = mx
        return last_trace_cache[key]

    def war_of(sleeper_id, gsis, season):
        """Real league WAR first, calibrated history second, else None.
        Returns (war, out): out=True marks the busted/out-of-league real zero —
        CUMULATIVE: no trace in this season or any later observed season, so a
        redshirt year before a comeback is a hiatus, not out."""
        if season in real.get(sleeper_id, {}):
            return real[sleeper_id][season], False
        # Only treat a missing player-season as a real (busted) zero if that
        # season's waa_war file actually exists. A missing waa_war_<season>.csv
        # is "no source" -> None (skip), never a corpus-wide zero — otherwise
        # running before war-history regenerates poisons the whole column.
        if gsis is not None and season in hist_seasons:
            h = hist.get(gsis, {})
            if season in h:
                return h[season], False
            lt = last_trace(sleeper_id, gsis)
            return 0.0, (lt is None or season > lt)
        return None

    def resolve(name, pos, season):
        """name+pos+class -> (gsis, status). gsis '' = zero output, None = real-
        WAR-only. status 'ok' | 'unmatched' | 'vet'."""
        if name in MANUAL:
            return MANUAL[name], 'ok'
        if name in ZEROES:
            return '', 'ok'
        if name in NO_GSIS:
            return None, 'ok'
        m = match_gsis(name, pos, season, meta)
        if not m:
            return None, 'unmatched'
        if m[2] and int(m[2]) != season:            # veteran pick, not a rookie
            return None, 'vet'
        return m[1], 'ok'

    picks, unmatched, vets = [], [], 0
    for r in csv.DictReader(open(ROOT / 'nfl_history' / 'rookie_drafts.csv',
                                 encoding='utf-8')):
        season, pick = int(r['season']), int(r['pick_no'])
        if season > last or pick > MAX_PICK:
            continue
        gsis, st = resolve(r['name'], r['pos'], season)
        if st == 'unmatched':
            unmatched.append((r['season'], r['name'], r['source']))
            continue
        if st == 'vet':
            vets += 1
            continue
        picks.append((season, pick, r['sleeper_id'], gsis, r['pos']))

    csv_n = len(picks)                 # curated CSV observations
    curated = picks                    # kept aside; used only as the fallback
    picks = []
    # --- Bridge A: the crawled rookie-draft corpus (thousands of superflex
    #     leagues). Per slot, distribute a fixed observation budget across the
    #     players taken there, weighted by how many leagues took each, so the
    #     modal pick dominates without swamping memory.
    #
    #     This REPLACES the curated CSV rather than blending with it. Blending
    #     weighted them at parity, which is indefensible in both directions:
    #     one curated row is a single league's single pick, while one crawl rep
    #     stands for 1/CRAWL_BUDGET of the global consensus at that slot (~2.5%
    #     of what tens of thousands of leagues did). The CSV was also entirely
    #     redundant on coverage — same 336 (season, slot) cells, same resolve()
    #     path — so all it contributed was 7.4% of the weight sourced from five
    #     hand-picked leagues. It stays as the fallback for a missing or empty
    #     corpus, which is the job it was actually doing before the crawl.
    corpus_f = DATA / 'rookie_pick_corpus.json'
    raw_crawl = 0                      # actual rookie picks analyzed (all leagues)
    if corpus_f.exists():
        by_slot = defaultdict(list)
        for season, pick, sid, name, pos, cnt in (json.load(open(corpus_f)).get('picks') or []):
            if season <= last and pick <= MAX_PICK:
                raw_crawl += cnt
                if cnt >= CRAWL_MIN:
                    by_slot[(season, pick)].append((sid, name, pos, cnt))
        added = 0
        for (season, pick), es in by_slot.items():
            # Resolve BEFORE allocating. Resolving inside the loop and skipping
            # failures left the unresolvable player's count in the denominator,
            # so a slot with a name we can't map silently spent part of its
            # budget on nothing.
            live = []
            for sid, name, pos, cnt in es:
                gsis, st = resolve(name, pos, season)
                if st == 'ok':
                    live.append((sid, gsis, cnt, pos))
            tot = sum(c for _s, _g, c, _p in live)
            if not tot:
                continue
            # Largest remainder: floor each player's exact quota, then hand the
            # leftover reps to the largest fractional parts. Sums to exactly
            # CRAWL_BUDGET, preserves proportions, and drops the tail without a
            # floor. See the CRAWL_BUDGET note above for why the floor was wrong.
            quota = [(CRAWL_BUDGET * cnt / tot, sid, gsis, pos)
                     for sid, gsis, cnt, pos in live]
            base = [(int(q), q - int(q), sid, gsis, pos) for q, sid, gsis, pos in quota]
            left = CRAWL_BUDGET - sum(b for b, *_ in base)
            order = sorted(range(len(base)), key=lambda i: -base[i][1])
            bonus = set(order[:max(0, left)])
            for i, (b, _, sid, gsis, pos) in enumerate(base):
                reps = b + (1 if i in bonus else 0)
                if reps:
                    picks.extend([(season, pick, sid, gsis, pos)] * reps)
                    added += reps
        print(f"  crawl corpus: {added} weighted picks from {len(by_slot)} slots")

    # Fallback: no corpus (or one that produced nothing) => the curated CSV is
    # the whole population, exactly as it was before the crawl existed.
    source = 'crawl corpus'
    if not picks:
        picks = curated
        source = 'curated CSV (no crawl corpus)'
        print(f"  no crawl corpus — falling back to {len(picks)} curated picks")

    # Fill every candidate year, then prune below by real observation counts.
    candidates = list(range(1, MAX_YEARS + 1))

    pcells = {b: {k: [] for k in candidates} for b in PICK_ORDER}
    bcells = {b: {k: [] for k in candidates} for b in BAND_ORDER}
    pouts = {b: {k: 0 for k in candidates} for b in PICK_ORDER}
    bouts = {b: {k: 0 for k in candidates} for b in BAND_ORDER}
    phits, bhits = defaultdict(list), defaultdict(list)
    # franchise hit: did the pick become a FRANCHISE PLAYER at his position —
    # FRANCHISE_SEASONS seasons clearing FRANCHISE_BAR[pos]. Unlike hit_rate
    # (a 3-year WAR total against one flat bar) this asks the dynasty question:
    # did this pick turn into a long-term starter at a position where that is
    # hard? The bar is position-specific because a flat one measures the shape
    # of the positions rather than the players — see METHODOLOGY.md.
    pfran, bfran = defaultdict(lambda: [0, 0]), defaultdict(lambda: [0, 0])
    for season, pick, sid, gsis, pos in picks:
        pk, bk = pick_key(pick), band_key(pick)
        for k in candidates:
            yr = season + k - 1
            if yr > last:
                continue
            r = war_of(sid, gsis, yr)
            if r is not None:
                v, out = r
                pcells[pk][k].append(v)
                bcells[bk][k].append(v)
                if out:
                    pouts[pk][k] += 1
                    bouts[bk][k] += 1
        if season + 2 <= last:                      # 3 finished seasons
            tot = [war_of(sid, gsis, season + i) for i in range(3)]
            if all(t is not None for t in tot):
                phits[pk].append(sum(v for v, _ in tot))
                bhits[bk].append(sum(v for v, _ in tot))
            # Franchise status needs the SAME maturity gate: a class with fewer
            # than FRANCHISE_SEASONS finished years cannot have cleared the bar
            # that many times, and counting it would read as a miss rather than
            # as "not yet". Every season the player has had is examined, so a
            # 2019 pick gets all seven.
            bar = FRANCHISE_BAR.get(pos)
            if bar is not None:
                good = 0
                for yr in range(season, last + 1):
                    r = war_of(sid, gsis, yr)
                    if r is not None and r[0] >= bar:
                        good += 1
                hit = 1 if good >= FRANCHISE_SEASONS else 0
                for store, key in ((pfran, pk), (bfran, bk)):
                    store[key][0] += hit
                    store[key][1] += 1

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

    # out_rate gets a stricter gate than the WAR columns: each year column
    # mixes whichever classes have reached it, so the deepest years are
    # survivor noise from two classes. Publish out_rate for year k only once
    # >= OUT_MIN_CLASSES classes have completed it; year 5 unlocks after the
    # 2027 season on its own — data not yet available, not wrong.
    out_years = [k for k in years
                 if last - FIRST_CLASS - k + 2 >= OUT_MIN_CLASSES]

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
        'franchise_bars': FRANCHISE_BAR,
        'franchise_seasons': FRANCHISE_SEASONS,
        'picks_used': len(picks), 'vets_excluded': vets,
        # Three different quantities. The Draft page headlines picks_analyzed
        # by Max's explicit call (2026-08-04) — the scale of the crawl is the
        # point — but it must always be LABELED a coverage number ("picks
        # analyzed", never bare "picks"), with picks_distinct named beside it.
        #   picks_analyzed  every drafting DECISION observed (one per league per
        #                   pick). A coverage statistic, not a sample: 10k leagues
        #                   taking Bijan at 1.01 is one fact about 1.01.
        #   picks_used      rows fed to the aggregation, i.e. the weighted sample.
        #                   Reps are deliberate duplicates that place the median.
        #   picks_distinct  distinct (slot, player) rows behind those reps. This
        #                   is the closest thing to an honest evidence count.
        'picks_analyzed': csv_n + raw_crawl,
        'picks_distinct': len(set(picks)),
        'population': source,
        'curated_available': csv_n,
        'unmatched': len(unmatched),
        'source': 'real Big Dog WAR where available, calibrated NFL history otherwise',
    },
        'picks': summarize(PICK_ORDER, pcells, phits, years, pouts, out_years, pfran),
        'bands': summarize(BAND_ORDER, bcells, bhits, years, bouts, out_years, bfran,
                           labels=(band_label, band_slots)),
    }

    dest = DATA / 'pick_values.json'
    # compact separators: the site fetches this file, and indentation was 52%
    # of its bytes — gzip hides the transfer but not the JSON.parse cost
    dest.write_text(json.dumps(out, separators=(',', ':')), encoding='utf-8')

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
            o = row['out_rate'].get(out_years[-1]) if out_years else None
            out = f"out y{out_years[-1]} {o:.0%}" if o is not None else ''
            lbl = row.get('label', row['bucket'])
            print(f"  {lbl:10s} {n:>3d} | {cols} | {hit} | {out}")
    print(f"\nwrote {dest}")


if __name__ == '__main__':
    main()
