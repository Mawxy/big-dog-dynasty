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
  4. Report both "if healthy" (the rate) and "expected" (rate x availability),
     plus p20/p80 bands.

Everything is per-13 (a full healthy season). Inputs are all committed.

Usage: python scripts/project_war.py [--horizon 3]
Output: data/projections.json + diagnostics.
"""
import argparse, csv, datetime, json, math, re
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RECENCY = [0.5, 0.3, 0.2]
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
            int(r['draft_pick']) if r['draft_pick'] else 999))
    return idx


def match_meta(name, pos, idx):
    n = norm(name); first, last = n.split()[0], n.split()[-1]
    cands = idx.get((last, pos), [])
    if len(cands) == 1:
        return cands[0][1:]
    for cn, *rest in cands:
        cf = cn.split()[0]
        if cf == first or cf.startswith(first[:3]) or NICK.get(first) == cf:
            return tuple(rest)
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
    """recency/games weighted per-13 rate over upto, upto-1, upto-2."""
    num = den = 0.0
    for k, rw in enumerate(RECENCY):
        rt = rates.get(upto - k)
        if rt is None:
            continue
        w = rw * min(gps.get(upto - k, 0), FULL_GP)
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
    model = json.load(open(ROOT / 'nfl_history' / 'aging_curves.json', encoding='utf-8'))
    curves, avail, priors = model['curves'], model['availability'], model['capital_priors']
    UDFA_PICK = model['meta'].get('udfa_pick', 260)
    ptw = model.get('pts_to_war', {})
    sfile = ROOT / 'data' / 'proj_sleeper.json'
    sproj = json.load(open(sfile, encoding='utf-8'))['players'] if sfile.exists() else {}
    idx = build_meta_index()
    proj_years = [seed + 1 + k for k in range(H)]

    def avail_for(pos, age):
        return group_for(avail[pos], age)['avail']

    rows, skipped, age_def = [], 0, 0
    for pid in owner:
        if pid not in pos_s:
            skipped += 1; continue
        pos = pos_s[pid]
        if pos not in curves or not curves[pos]:
            continue
        nm = names.get(pid, [pid, pos, ''])[0]
        m = match_meta(nm, pos, idx)
        birth, draft_season, pick = (m if m else (None, None, 999))
        if birth is None:
            base_age, asrc = DEFAULT_AGE.get(pos, 26), 'default'; age_def += 1
        else:
            base_age, asrc = age_on_sep1(birth, seed), 'matched'
        cf = priors[pos]
        pick_eff = pick if pick < 999 else UDFA_PICK
        prior = cf['a'] + cf['b'] * math.log(pick_eff)

        rates = dict(rate_s[pid]); gps = dict(gp_s[pid])
        proj, expv, low, high = [], [], [], []
        for fy in proj_years:
            frm = fy - 1
            L_real, _ = wlevel(rates, gps, frm)
            if L_real is None:
                L_real = prior
            pw = prior_weight((frm - draft_season + 1) if draft_season else None, L_real)
            L = (1 - pw) * L_real + pw * prior
            age = base_age + (frm - seed)
            g = group_for(curves[pos], age)
            r = g['a'] + g['b'] * L
            av = avail_for(pos, age)
            proj.append(round(r, 3))
            expv.append(round(r * av, 3))
            low.append(round(max(r + g['p20'], 0.0), 3))
            high.append(round(r + g['p80'], 3))
            rates[fy] = r; gps[fy] = FULL_GP
        # composite: yr1 = half math + half external (Sleeper) projection;
        # yrs 2-3 = pure math (if-healthy). Falls back to pure math if no projection.
        sp = sproj.get(pid)
        if sp is not None and pos in ptw:
            proj_ext = round(ptw[pos]['a'] + ptw[pos]['b'] * sp['pts13'], 3)
            comp = [round(0.5 * proj[0] + 0.5 * proj_ext, 3), proj[1], proj[2]]
        else:
            proj_ext = None
            comp = list(proj)
        L0, _ = wlevel(rate_s[pid], gp_s[pid], seed)
        exp0 = (seed - draft_season + 1) if draft_season else None
        pw0 = prior_weight(exp0, L0 if L0 is not None else 0.0)
        rows.append({
            'pid': pid, 'name': nm, 'pos': pos, 'team': owner[pid],
            'age': base_age, 'age_src': asrc, 'pick': pick, 'exp': exp0,
            'war25': round(war_s[pid].get(seed, 0.0), 3),
            'level': round((1 - pw0) * (L0 if L0 is not None else prior) + pw0 * prior, 3),
            'proj': proj, 'expected': expv, 'composite': comp, 'proj_ext': proj_ext,
            'low': low, 'high': high,
            'total': round(sum(proj), 3), 'total_exp': round(sum(expv), 3),
            'total_comp': round(sum(comp), 3),
        })

    rows.sort(key=lambda r: r['total'], reverse=True)
    out = {'meta': {
        'generated': datetime.date.today().isoformat(),
        'seed_season': seed, 'roster_season': roster_season,
        'horizon': H, 'years': proj_years, 'players': len(rows),
        'model': 'per-13 rate + capital-shrinkage + availability; '
                 'three streams: if-healthy / composite(half injury) / expected(full injury)',
    }, 'players': rows}
    (ROOT / 'data' / 'projections.json').write_text(json.dumps(out, indent=1), encoding='utf-8')

    print(f"seed {seed}  rosters {roster_season}  projected {len(rows)}  "
          f"skipped no-history {skipped}  age-default {age_def}")
    print(f"\n{'name':21s} {'pos':3s} {'ag':>2s} {'pick':>4s} {'lvl':>5s} | "
          f"3-yr totals: healthy / composite / injury")
    for r in rows[:22]:
        print(f"{r['name'][:21]:21s} {r['pos']:3s} {r['age']:>2d} {r['pick']:>4d} {r['level']:>5.2f} | "
              f"{r['total']:>5.2f}  {r['total_comp']:>5.2f}  {r['total_exp']:>5.2f}")
    print(f"\nwrote data/projections.json")


if __name__ == '__main__':
    main()
