#!/usr/bin/env python3
"""
project_war.py — project rostered players' WAR forward 3 seasons using the
model fit by aging_curves.py (per-13 rate + capital priors + availability).

For each rostered player:
  1. LEVEL = recency/games-weighted per-13 rate over the last 3 seasons.
  2. Shrink toward the player's draft-capital prior by resume depth: a rookie
     leans on pedigree, a proven vet ignores it (this also encodes experience).
        level_used = w*realized + (1-w)*prior,  w = depth/(depth + K)
  3. Age forward: next_rate = a + b*level_used per position/age bucket, rolling
     the projected rate back into the level each year (so the prior fades as
     projected seasons accrue and the player ages into new buckets).
  4. Report three streams, plus p20/p80 bands:
       natural   — the rate, i.e. a full healthy 13-game season
       composite — natural blended with Sleeper's year-1 projection aged along
                   the natural path's decay shape (80/20 yr1, 50/50 yr2,
                   20/80 yr3); falls back to pure natural if no projection
       expected  — natural x availability, i.e. discounted for injury
     Composite carries NO injury discount; only `expected` does.

Everything is per-13 (a full healthy season). Inputs are all committed.

Usage: python scripts/project_war.py [--horizon 3]
Output: data/projections.json + diagnostics.
"""
import argparse, csv, datetime, json, math, re, statistics
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RECENCY = [0.5, 0.4, 0.1]            # recency weights (rate over volume; not games-weighted)
BLEND_W = [0.8, 0.5, 0.2]            # composite: projected weight by year (math = 1 - this)
ELITE_WAR = 1.2                      # a season at/above this counts toward durability
DUR_STEP = 0.15                     # durability pull per elite season beyond 3
DUR_MAX = 0.30                      # cap: proven perennials (4+ elite yrs, ~84% retention
                                    # vs ~74%) regress less; pulls projection toward level
DECAY_DAMP = 0.6                    # anti-compounding: fraction pulled back toward the
                                    # anchor level when rolling a projection forward, so a
                                    # player regresses ONCE then ages gently (matches the
                                    # gradual ~62% QB / ~52% 3-yr retention, not ~47%)
FULL_GP = 13
MIN_GP = 4
def prior_weight(exp, level):
    """Weight on the draft-capital prior. Fades two ways:
      - years since draft: ~0.5 yr1, 0.33 yr2, 0.17 yr3, 0 from yr4 on;
      - proven production: once a player has shown a high level, pedigree is
        irrelevant (day-3 gems retain just like R1 studs), so the prior is shed
        as demonstrated level rises (gone by ~1.2).
    Unknown experience -> ignore the prior."""
    if exp is None:
        return 0.0
    base = max(0.0, min(0.5, (4 - exp) / 6.0))
    proven = max(0.0, min(1.0, (level - 0.5) / 0.7))
    return base * (1 - proven)
NICK = {'cam': 'cameron', 'tank': 'nathaniel', 'joe': 'joseph', 'trevor': 'william',
        'matt': 'matthew', 'josh': 'joshua', 'ken': 'kenneth', 'mike': 'michael',
        'gabe': 'gabriel', 'chig': 'chigoziem'}
DEFAULT_AGE = {"QB": 28, "RB": 25, "WR": 26, "TE": 27}


def norm(s):
    s = s.lower().replace('.', '').replace("'", '').replace('-', ' ')
    return re.sub(r'\s+(jr|sr|ii|iii|iv|v)$', '', s.strip())


def age_on_sep1(birth, season):
    return season - birth.year - (1 if (birth.month, birth.day) > (9, 1) else 0)


def build_meta_index():
    idx = defaultdict(list)
    for r in csv.DictReader(open(ROOT / 'nfl_history' / 'players_meta.csv', encoding='utf-8')):
        n = norm(r['name'])
        idx[(n.split()[-1], r['pos'])].append((
            n,
            datetime.date.fromisoformat(r['birth_date']) if r['birth_date'] else None,
            int(r['draft_season']) if r['draft_season'] else None,
            int(r['draft_pick']) if r['draft_pick'] else 999,
            r['gsis_id']))
    return idx


# Sleeper display name -> nflverse LEGAL name (2026-07-20). nflverse indexes
# some players by legal first name, beyond what nickname/prefix matching can
# bridge. Every entry was verified against the player's real draft slot.
MANUAL_NAMES = {
    'DK Metcalf': 'DeKaylin Metcalf', 'CeeDee Lamb': 'Cedarian Lamb',
    'A.J. Brown': 'Arthur Brown', 'Tee Higgins': 'Tamurice Higgins',
    'Geno Smith': 'Eugene Smith', 'J.J. McCarthy': 'Jonathan McCarthy',
    'Mac Jones': 'Michael Jones', 'Chris Godwin': 'Rod Godwin',
    'Zay Flowers': 'Xavien Flowers', 'Deebo Samuel': 'Tyshun Samuel',
    'Ladd McConkey': 'Andrew McConkey', 'Jauan Jennings': 'Bennie Jennings',
    'DJ Moore': 'Denniston Moore', "Tre' Harris": 'Cleveland Harris',
    'RJ Harvey': 'Robert Harvey', 'Parker Washington': 'Christopher Washington',
    'Malachi Fields': 'Steven Fields', 'Jaylin Lane': 'Joshua Lane',
    'Ray Davis': "Re'Mahn Davis",
}


def match_meta(name, pos, idx):
    name = MANUAL_NAMES.get(name, name)
    n = norm(name); first, last = n.split()[0], n.split()[-1]
    cands = idx.get((last, pos), [])
    if len(cands) == 1:
        return cands[0][1:]
    # Tiered: exact full name > exact first name > nickname > 3-letter prefix.
    # The old single loose pass returned the FIRST prefix hit, which matched
    # Jameson Williams to a 1978-born "James Williams" (age 47 in projections,
    # 2026-07-20). Within a tier, ties break to the YOUNGEST birth date —
    # nflverse history is full of decades-old namesakes (Marvin Harrison Sr,
    # a 1970s Cedric Tillman) and the roster player is essentially always the
    # recent one. Prefix stays as a last resort for nickname-ish spellings.
    for test in (lambda cf, cn: cn == n,
                 lambda cf, cn: cf == first,
                 lambda cf, cn: NICK.get(first) == cf,
                 lambda cf, cn: cf.startswith(first[:3])):
        hits = [rest for cn, *rest in cands if test(cn.split()[0], cn)]
        if hits:
            return max(hits, key=lambda h: h[0] or datetime.date.min)
    return None


def group_for(groups, age):
    for g in groups:
        if g['min_age'] <= age <= g['max_age']:
            return g
    return groups[-1] if groups else None


def tier_of(pick, tiers):
    for label, lo, hi in tiers:
        if lo <= pick <= hi:
            return label
    return "udfa"


def wlevel(rates, gps, upto):
    """recency-weighted per-13 rate over upto, upto-1, upto-2, softened by
    sqrt(games): short seasons count less than full ones, but rate dominates."""
    num = den = 0.0
    for k, rw in enumerate(RECENCY):
        rt = rates.get(upto - k)
        if rt is None:
            continue
        w = rw * min(gps.get(upto - k, 0), FULL_GP) ** 0.5
        num += w * rt; den += w
    return (num / den, den) if den else (None, 0.0)


def depth_of(gps, upto):
    return sum(min(gps.get(upto - k, 0), FULL_GP) / FULL_GP for k in range(3)
               if gps.get(upto - k))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--horizon', type=int, default=3)
    args = ap.parse_args()
    H = args.horizon

    meta = json.load(open(ROOT / 'data' / 'meta.json', encoding='utf-8'))
    seasons = sorted(int(s) for s in meta['seasons'])
    seed = int(meta.get('latest') or seasons[-2])
    roster_season = seasons[-1]

    # per-13 rate + gp per player for seed-2..seed
    rate_s, gp_s, pos_s, war_s = defaultdict(dict), defaultdict(dict), {}, defaultdict(dict)
    for yr in (seed - 2, seed - 1, seed):
        f = ROOT / 'data' / f'{yr}' / 'summary.json'
        if not f.exists():
            continue
        for row in json.load(open(f, encoding='utf-8')):
            pid, g, w = row[0], int(row[2]), float(row[6])
            gp_s[pid][yr] = g; war_s[pid][yr] = w
            if g >= MIN_GP:
                rate_s[pid][yr] = w / g * FULL_GP
            if yr == seed:
                pos_s[pid] = row[1]

    teams = json.load(open(ROOT / 'data' / f'{roster_season}' / 'teams.json', encoding='utf-8'))
    owner = {pid: t['team'] for t in teams for pid in t['players']}
    names = json.load(open(ROOT / 'data' / 'players_min.json', encoding='utf-8'))
    # NFL bye weeks for the roster season (team -> week), when published
    byes_f = ROOT / 'data' / f'{roster_season}' / 'byes.json'
    byes = json.load(open(byes_f, encoding='utf-8')) if byes_f.exists() else {}

    # ---- fantasy rookie-draft capital ------------------------------------
    # An incoming rookie has no league history and isn't in nflverse yet, so
    # the NFL-pick prior can't reach them. Their FANTASY rookie-draft slot is
    # known the moment they're drafted, and Bridge A already prices every slot
    # in realized WAR — so that's the seed. Sleeper's projection then carries
    # year 1 through the existing composite blend.
    fslot, slot_exp = {}, {}
    dfile = ROOT / 'data' / 'drafts.json'
    if dfile.exists():
        for picks in json.load(open(dfile, encoding='utf-8')).values():
            for p in picks:
                if p.get('kind') == 'rookie' and p.get('pid') and not p.get('traded'):
                    fslot[p['pid']] = (int(p['season']), p['slot'])
    pvfile = ROOT / 'data' / 'pick_values.json'
    if pvfile.exists():
        pv = json.load(open(pvfile, encoding='utf-8'))
        yrs = sorted(int(y) for y in (pv.get('meta') or {}).get('years_published') or [])
        slot_exp = {b['bucket']: [float(b.get('raw', {}).get(str(y), 0.0)) for y in yrs]
                    for b in pv.get('picks', [])}
    model = json.load(open(ROOT / 'nfl_history' / 'aging_curves.json', encoding='utf-8'))
    curves, avail, priors = model['curves'], model['availability'], model['capital_priors']
    UDFA_PICK = model['meta'].get('udfa_pick', 260)
    ptw = model.get('pts_to_war', {})
    sfile = ROOT / 'data' / 'proj_sleeper.json'
    sproj = json.load(open(sfile, encoding='utf-8'))['players'] if sfile.exists() else {}
    idx = build_meta_index()

    # full-career WAR: real Big Dog WAR for league years, league-shaped NFL
    # history for earlier ones (for the projection chart's actual line)
    realwar = defaultdict(dict)
    for yr in seasons:
        if yr > seed:
            continue
        f = ROOT / 'data' / f'{yr}' / 'summary.json'
        if f.exists():
            for row in json.load(open(f, encoding='utf-8')):
                realwar[row[0]][yr] = float(row[6])
    histwar = defaultdict(dict)
    for yr in range(2012, seed + 1):
        f = ROOT / 'nfl_history' / f'waa_war_{yr}.csv'
        if f.exists():
            for r in csv.DictReader(open(f, encoding='utf-8')):
                histwar[r['player_id']][yr] = float(r['WAR'])
    proj_years = [seed + 1 + k for k in range(H)]

    def avail_for(pos, age):
        return group_for(avail[pos], age)['avail']

    rows, skipped, age_def, rookies = [], 0, 0, 0
    for pid in owner:
        # a player with no league history is still projectable if we know his
        # fantasy draft capital — that's the whole point of the slot prior
        pos = pos_s.get(pid) or (names.get(pid) or [None, None])[1]
        if not pos or pos not in curves or not curves[pos]:
            if pid not in pos_s:
                skipped += 1
            continue
        nm = names.get(pid, [pid, pos, ''])[0]
        m = match_meta(nm, pos, idx)
        birth, draft_season, pick, gsis = (m if m else (None, None, 999, None))
        fs = fslot.get(pid)
        if draft_season is None and fs:
            draft_season = fs[0]          # fantasy class stands in for the NFL one
        if birth is None:
            base_age, asrc = DEFAULT_AGE.get(pos, 26), 'default'; age_def += 1
        else:
            base_age, asrc = age_on_sep1(birth, seed), 'matched'
        cf = priors[pos]
        pick_eff = pick if pick < 999 else UDFA_PICK
        prior = cf['a'] + cf['b'] * math.log(pick_eff)
        # Prefer the fantasy rookie slot when the NFL pick is unknown (nflverse
        # has no 2026 class yet). Bridge A's year-1 value is a realized WAR, so
        # divide out availability to get the per-13 RATE the model works in.
        if pick >= 999 and fs and fs[1] in slot_exp and slot_exp[fs[1]]:
            av0 = avail_for(pos, base_age) or 1.0
            prior = slot_exp[fs[1]][0] / av0
            rookies += 1

        rw = realwar.get(pid, {}); hw = histwar.get(gsis, {}) if gsis else {}
        career = [[y, round(rw.get(y, hw.get(y, 0.0)), 3)] for y in sorted(set(rw) | set(hw))]
        elite = sum(1 for _, w in career if w >= ELITE_WAR)
        dur = min(DUR_MAX, max(0.0, (elite - 3) * DUR_STEP))

        rates = dict(rate_s[pid]); gps = dict(gp_s[pid])

        # Personal durability (2026-07-20, fitted in aging_curves "durability"):
        # shift the pos x age availability baseline by the player's own recent
        # GP history. Feature + slope are per-position (QB best-2-of-3 with a
        # big slope, RB plain mean with a tiny one — matching how weakly each
        # position's injury history persists). 3 contributor seasons = full
        # weight, 2 = half weight (plain mean), fewer = baseline as-is.
        dcfg = model.get('durability', {}).get(pos)
        av_delta = 0.0
        if dcfg:
            hist = [min(gps[y], FULL_GP) / FULL_GP
                    for y in (seed - 2, seed - 1, seed) if gps.get(y)]
            if len(hist) >= 2:
                fname = dcfg['feature']
                if len(hist) == 3:
                    f = (statistics.mean(sorted(hist)[1:]) if fname == 'best2'
                         else statistics.mean(hist) if fname == 'mean3'
                         else 0.5 * hist[2] + 0.3 * hist[1] + 0.2 * hist[0])
                else:
                    f = statistics.mean(hist)
                av_delta = dcfg['b'] * (f - dcfg['feat_mean'])
                if fname == 'recency_sd' and len(hist) == 3:
                    av_delta += dcfg['b_sd'] * (statistics.pstdev(hist) - dcfg['sd_mean'])
                av_delta *= 1.0 if len(hist) == 3 else 0.5

        proj, expv = [], []
        nat_lo, nat_hi, adj_lo, adj_hi = [], [], [], []
        p20s, p80s = [], []
        anchor = None
        for fy in proj_years:
            frm = fy - 1
            L_real, _ = wlevel(rates, gps, frm)
            if L_real is None:
                L_real = prior
            pw = prior_weight((frm - draft_season + 1) if draft_season else None, L_real)
            L = (1 - pw) * L_real + pw * prior
            if anchor is None:
                anchor = L                    # true-talent anchor (year-1 level)
            age = base_age + (frm - seed)
            g = group_for(curves[pos], age)
            r = g['a'] + g['b'] * L
            # pedigree hold (fitted in aging_curves): young early-pick
            # producers deviate from their bucket's pooled regression —
            # +0.08/yr for the Chase/Jefferson WR archetype, negative for
            # young workhorse RBs. Applied only while the player still fits
            # the cohort (ages out of it naturally as the stream advances).
            ped = model.get('pedigree_hold', {})
            pm = ped.get('meta', {})
            pc = ped.get(pos)
            if pc and age <= pm.get('max_age', 24) and pick <= pm.get('max_pick', 40) \
                    and L >= pm.get('min_level', 0.8):
                r += pc['bump']
            r = (1 - dur) * r + dur * L      # durability: proven perennials regress less
            av = min(1.0, max(0.35, avail_for(pos, age) + av_delta))
            e = r * av
            proj.append(round(r, 3)); expv.append(round(e, 3))
            # NO zero-floor on the pessimistic band: negative projections are
            # real, and a band that can't go below 0 renders ABOVE the line
            # for sub-replacement players (Darnell Washington bug, 2026-07-20)
            nat_lo.append(round(r + g['p20'], 3))
            nat_hi.append(round(r + g['p80'], 3))
            adj_lo.append(round((r + g['p20']) * av, 3))
            adj_hi.append(round((r + g['p80']) * av, 3))
            p20s.append(g['p20']); p80s.append(g['p80'])
            # roll forward WITHOUT re-regressing: feed a value dampened toward the
            # anchor so the level holds and aging (not compounding) drives the decline
            rates[fy] = r + DECAY_DAMP * (anchor - r)
            gps[fy] = FULL_GP
        # composite: blend the math path with a "projected path" (Sleeper's
        # year-1 number aged forward along the math's decay shape), weighting
        # the projection heavily near-term and handing off to the math:
        # yr1 80/20, yr2 50/50, yr3 20/80.  Falls back to pure math if no projection.
        sp = sproj.get(pid)
        if sp is not None and pos in ptw:
            proj_ext = round(ptw[pos]['a'] + ptw[pos]['b'] * sp['pts13'], 3)
            comp = []
            for i in range(len(proj)):
                w = BLEND_W[i] if i < len(BLEND_W) else 0.0
                shape = proj[i] / proj[0] if proj[0] > 0.05 else 1.0   # decay of the math path
                comp.append(round(w * (proj_ext * shape) + (1 - w) * proj[i], 3))
        else:
            proj_ext = None
            comp = list(proj)
        comp_lo = [round(comp[i] + p20s[i], 3) for i in range(len(comp))]
        comp_hi = [round(comp[i] + p80s[i], 3) for i in range(len(comp))]
        # PPG derived from OUR model, not Sleeper: invert the fitted
        # pts_to_war line (WAR = a + b*pts per 13) at the year-1 composite
        # rate, so leaderboard Pts/PPG and WAR come from one source.
        ppg = (round((comp[0] - ptw[pos]['a']) / ptw[pos]['b'] / FULL_GP, 2)
               if pos in ptw and ptw[pos]['b'] else None)
        L0, _ = wlevel(rate_s[pid], gp_s[pid], seed)
        exp0 = (seed - draft_season + 1) if draft_season else None
        pw0 = prior_weight(exp0, L0 if L0 is not None else 0.0)
        rows.append({
            'pid': pid, 'name': nm, 'pos': pos, 'team': owner[pid],
            'age': base_age, 'age_src': asrc, 'pick': pick, 'exp': exp0,
            'elite': elite, 'war25': round(war_s[pid].get(seed, 0.0), 3), 'career': career,
            'availAdj': round(av_delta, 3),
            'level': round((1 - pw0) * (L0 if L0 is not None else prior) + pw0 * prior, 3),
            'proj': proj, 'nat_low': nat_lo, 'nat_high': nat_hi,
            'expected': expv, 'adj_low': adj_lo, 'adj_high': adj_hi,
            'composite': comp, 'comp_low': comp_lo, 'comp_high': comp_hi,
            'ppg': ppg, 'bye': byes.get((names.get(pid) or [None, None, None])[2]),
            'proj_ext': proj_ext,
            'total': round(sum(proj), 3), 'total_exp': round(sum(expv), 3),
            'total_comp': round(sum(comp), 3),
        })

    # projected positional finish per year (composite stream): lets the UI say
    # "WAR declines but he's still WR6" — ranks fall far slower than raw WAR
    # because the whole position ages together. Ranked among projected
    # (rostered) players, same convention as the leaderboard pos ranks.
    for y in range(H):
        for ps in {r['pos'] for r in rows}:
            grp = sorted((r for r in rows if r['pos'] == ps),
                         key=lambda r: -(r['composite'][y] if y < len(r['composite']) else -9))
            for i, r in enumerate(grp):
                r.setdefault('posFin', [0] * H)[y] = i + 1

    rows.sort(key=lambda r: r['total'], reverse=True)
    out = {'meta': {
        'generated': datetime.date.today().isoformat(),
        'seed_season': seed, 'roster_season': roster_season,
        'horizon': H, 'years': proj_years, 'players': len(rows),
        'model': 'per-13 rate + capital-shrinkage + availability; three streams: '
                 'natural(if healthy) / composite(natural blended with Sleeper '
                 'projection, 80/50/20 by year) / expected(natural x availability)',
    }, 'players': rows}
    (ROOT / 'data' / 'projections.json').write_text(json.dumps(out, indent=1), encoding='utf-8')

    print(f"seed {seed}  rosters {roster_season}  projected {len(rows)}  "
          f"skipped no-history {skipped}  age-default {age_def}  "
          f"seeded from fantasy draft slot {rookies}")
    print(f"\n{'name':21s} {'pos':3s} {'ag':>2s} {'pick':>4s} {'lvl':>5s} | "
          f"3-yr totals: healthy / composite / injury")
    for r in rows[:22]:
        print(f"{r['name'][:21]:21s} {r['pos']:3s} {r['age']:>2d} {r['pick']:>4d} {r['level']:>5.2f} | "
              f"{r['total']:>5.2f}  {r['total_comp']:>5.2f}  {r['total_exp']:>5.2f}")
    print(f"\nwrote data/projections.json")


if __name__ == '__main__':
    main()
