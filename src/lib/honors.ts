import type { Franchises, Matchups, SummaryRow, Team, Weekly } from "./types";
import { jl } from "./data";

/**
 * Career honor marks — the five things a player season can earn.
 *
 * Every tier is computed from data already on the site; nothing here is
 * hand-maintained.
 *
 * TWO KINDS, and they are not comparable. `champ` is a TEAM outcome: it says
 * the roster he was on won, and 28–33 players earn it every season regardless
 * of what any of them did. The other four are INDIVIDUAL, ordered by rarity.
 * Ranking a team result inside an individual ladder would read the trophy as
 * "rarer than an MVP season", which it is not — it is a different question.
 * The render order is team first, then the individual ladder, separated.
 */
export type HonorKey = "champ" | "mvp" | "king" | "elite" | "bar";

/** render order: the team result, then the individual marks rarest first */
export const HONOR_ORDER: HonorKey[] = ["champ", "mvp", "king", "elite", "bar"];

export const HONOR_LABEL: Record<HonorKey, string> = {
  champ: "Championship",
  mvp: "MVP season",
  king: "Positional king",
  elite: "Elite season",
  bar: "Franchise bar",
};

export const HONOR_NOTE: Record<HonorKey, string> = {
  champ: "on the winner's roster in the title game",
  mvp: "most WAR in the league that season",
  king: "most WAR at the position that season",
  elite: "top 2% of season WAR at the position, all seasons pooled",
  bar: "cleared the position's franchise-player bar",
};

/**
 * The franchise-player bar, per position. These are METHODOLOGY.md's numbers —
 * three of the four sit at that position's rank-12 season value, and TE is a
 * documented judgment at 0.50. Do not retune here; change the doc first.
 */
export const FRANCHISE_BAR: Record<string, number> = {
  QB: 1.0, RB: 0.7, WR: 0.85, TE: 0.5,
};

/** what a player earned in one season */
export interface SeasonHonors { season: string; keys: HonorKey[] }

export interface HonorIndex {
  /** pid -> season -> keys */
  byPlayer: Record<string, Record<string, HonorKey[]>>;
  /** position -> p98 season WAR, pooled across every season */
  eliteBar: Record<string, number>;
  /** seasons that had a decided champion */
  champSeasons: string[];
}

/** p98 of a sorted ascending list, nearest-rank */
function p98(sorted: number[]): number {
  if (!sorted.length) return Infinity;
  return sorted[Math.min(sorted.length - 1, Math.round(0.98 * (sorted.length - 1)))];
}

let pending: Promise<HonorIndex> | null = null;

/**
 * Build the whole-league honor index once per page load.
 *
 * Elite is a pooled percentile rather than a per-season one because a single
 * season of one twelve-team league is far too thin a population for a 98th
 * percentile — it would collapse into "the best one or two", which is already
 * what `king` means. Pooling every season also keeps the bar stable as
 * seasons accumulate instead of moving under a player's feet each year.
 */
export function loadHonors(seasons: string[]): Promise<HonorIndex> {
  if (pending) return pending;

  pending = (async () => {
    const sums = await Promise.all(seasons.map(s =>
      jl<SummaryRow[]>(`${s}/summary.json`).catch(() => [] as SummaryRow[])));

    // pooled position distributions -> the elite bar
    const pool: Record<string, number[]> = {};
    sums.forEach(rows => rows.forEach(r => {
      const war = r[6];
      if (typeof war === "number") (pool[r[1]] ??= []).push(war);
    }));
    const eliteBar: Record<string, number> = {};
    for (const [pos, v] of Object.entries(pool)) eliteBar[pos] = p98(v.slice().sort((a, b) => a - b));

    const byPlayer: HonorIndex["byPlayer"] = {};
    const add = (pid: string, season: string, k: HonorKey) => {
      const bag = ((byPlayer[pid] ??= {})[season] ??= []);
      if (!bag.includes(k)) bag.push(k);
    };

    seasons.forEach((season, i) => {
      const rows = sums[i].filter(r => typeof r[6] === "number");
      if (!rows.length) return;

      // MVP — most WAR in the league
      const best = rows.reduce((a, b) => (b[6] > a[6] ? b : a));
      if (best[6] > 0) add(best[0], season, "mvp");

      // positional king — most WAR at each position
      const kings: Record<string, SummaryRow> = {};
      for (const r of rows) {
        const k = kings[r[1]];
        if (!k || r[6] > k[6]) kings[r[1]] = r;
      }
      for (const r of Object.values(kings)) if (r[6] > 0) add(r[0], season, "king");

      for (const r of rows) {
        const [pid, pos, , , , , war] = r;
        if (eliteBar[pos] != null && war >= eliteBar[pos]) add(pid, season, "elite");
        if (FRANCHISE_BAR[pos] != null && war >= FRANCHISE_BAR[pos]) add(pid, season, "bar");
      }
    });

    /* Championships — ON THE WINNER'S ROSTER IN THE TITLE GAME.
     *
     * Starters AND bench, from the week the final was played. A ring goes to
     * the whole roster, not to the nine who happened to be in the lineup, and
     * the week-17 roster is the closest thing the data has to "who was on the
     * team when they won it". It deliberately excludes anyone dropped before
     * the final.
     *
     * This is the widest of the five tiers by some distance — roughly 29 a
     * season against 9 for the lineup-only rule. That is the intended
     * meaning, not an oversight. */
    const champSeasons: string[] = [];
    try {
      const fr = await jl<Franchises>("franchises.json");
      const champRid: Record<string, string> = {};
      for (const [rid, f] of Object.entries(fr))
        for (const s of f.seasons) if (s.finish === 1) champRid[s.season] = rid;

      const wanted = seasons.filter(s => champRid[s]);
      const mus = await Promise.all(wanted.map(s =>
        jl<Matchups>(`${s}/matchups.json`).catch(() => null)));

      wanted.forEach((season, i) => {
        const m = mus[i];
        const rows = m?.teams[champRid[season]];
        if (!m || !rows?.length) return;
        const playoff = rows.filter(r => r[0] >= m.playoff_start);
        if (!playoff.length) return;
        const finalWk = Math.max(...playoff.map(r => r[0]));
        const final = playoff.find(r => r[0] === finalWk);
        if (!final) return;
        champSeasons.push(season);
        for (const pid of [...(final[4] ?? []), ...(final[5] ?? [])]) add(pid, season, "champ");
      });
    } catch { /* no franchises.json — the other four tiers still stand */ }

    return { byPlayer, eliteBar, champSeasons };
  })();

  pending.catch(() => { pending = null; });
  return pending;
}

/** one player's honors, newest season first */
export function playerHonors(idx: HonorIndex | null, pid: string): SeasonHonors[] {
  const bag = idx?.byPlayer[pid];
  if (!bag) return [];
  return Object.entries(bag)
    .map(([season, keys]) => ({
      season,
      keys: HONOR_ORDER.filter(k => keys.includes(k)),
    }))
    .sort((a, b) => Number(b.season) - Number(a.season));
}

/** one league season of a player's career, for the career table */
export interface CareerSeason {
  pid: string;
  season: string;
  pos: string;
  gp: number;
  pts: number;
  ppg: number;
  waa: number;
  war: number;
  /** rank within position that season, 1 = best */
  posRank: number | null;
  /** rank overall that season */
  rank: number | null;
  /** every franchise that rostered him that season, in the order they held him.
   *  `team` is what the franchise was CALLED that season; `rid` and `manager`
   *  are what it actually is. Names change annually — Crustufer's roster has
   *  been London Has Fallen, The Drake Snake, Point Drake and Drake Mungo. */
  owners: { rid: string; team: string; manager: string; from: number; to: number }[];
  keys: HonorKey[];
}

let careerPending: Promise<Record<string, CareerSeason[]>> | null = null;

/**
 * Every player's league seasons, newest first — the career table's source.
 *
 * Ranks are computed here rather than read from a file so they always agree
 * with the honors computed alongside them: `king` is exactly posRank 1, and
 * `mvp` is exactly rank 1. Two different sources would eventually disagree.
 */
export function loadCareer(seasons: string[]): Promise<Record<string, CareerSeason[]>> {
  if (careerPending) return careerPending;

  careerPending = (async () => {
    const [sums, teamSets, mus] = await Promise.all([
      Promise.all(seasons.map(s => jl<SummaryRow[]>(`${s}/summary.json`).catch(() => [] as SummaryRow[]))),
      Promise.all(seasons.map(s => jl<Team[]>(`${s}/teams.json`).catch(() => [] as Team[]))),
      Promise.all(seasons.map(s => jl<Matchups>(`${s}/matchups.json`).catch(() => null))),
    ]);
    const honors = await loadHonors(seasons);

    const out: Record<string, CareerSeason[]> = {};
    seasons.forEach((season, i) => {
      const rows = sums[i].filter(r => typeof r[6] === "number");
      if (!rows.length) return;

      const named: Record<string, { team: string; manager: string }> = {};
      for (const t of teamSets[i]) named[String(t.roster_id)] = { team: t.team, manager: t.manager };

      /* Who held him, week by week.
       *
       * This comes from the weekly rosters rather than from ownership.json,
       * which is prose and provably lossy — McCaffrey's entry has a 2022 draft
       * and a 2025 trade and nothing at all for the season he spent on a third
       * team. matchups.json is what actually happened, and loadHonors has
       * already pulled every season of it, so this costs no extra fetch.
       *
       * The end-of-season roster alone was the previous answer and it quietly
       * erased the manager who held a player through the weeks he earned his
       * honors. */
      const spans: Record<string, CareerSeason["owners"]> = {};
      const m = mus[i];
      if (m) {
        const held: Record<string, Record<number, string>> = {};
        for (const [rid, weeks] of Object.entries(m.teams))
          for (const wk of weeks)
            for (const pid of [...(wk[4] ?? []), ...(wk[5] ?? [])]) (held[pid] ??= {})[wk[0]] = rid;

        for (const [pid, byWk] of Object.entries(held)) {
          const run: CareerSeason["owners"] = [];
          for (const w of Object.keys(byWk).map(Number).sort((a, b) => a - b)) {
            const rid = byWk[w];
            const { team, manager } = named[rid]
              ?? { team: `Roster ${rid}`, manager: `Roster ${rid}` };
            const tail = run[run.length - 1];
            /* Same team as the stint before it extends that stint, even across
             * a gap in weeks. Requiring consecutive weeks split one owner into
             * four whenever a manager dropped and re-added the same player —
             * Kenny McIntosh's 2024 rendered as the same franchise four times
             * in a row. A gap under one owner is a roster move, not a change
             * of hands, and the arrow means a change of hands. */
            if (tail && tail.rid === rid) tail.to = w;
            else run.push({ rid, team, manager, from: w, to: w });
          }
          /* Every stint, including one-week ones. A bye-week waiver stash is
           * still someone who owned him, and filtering short holds meant the
           * table quietly disagreed with the ownership log below it. If a run
           * is noisy, that is the season being noisy. */
          spans[pid] = run;
        }
      }
      // fall back to the end-of-season roster when a season has no matchups
      if (!m) for (const t of teamSets[i])
        for (const pid of t.players)
          spans[pid] = [{ rid: String(t.roster_id), team: t.team, manager: t.manager, from: 0, to: 0 }];

      const byWar = rows.slice().sort((a, b) => b[6] - a[6]);
      const rank = new Map(byWar.map((r, k) => [r[0], k + 1]));
      const posSeen: Record<string, number> = {};
      const posRank = new Map<string, number>();
      for (const r of byWar) posRank.set(r[0], (posSeen[r[1]] = (posSeen[r[1]] ?? 0) + 1));

      for (const r of rows) {
        (out[r[0]] ??= []).push({
          pid: r[0], season, pos: r[1], gp: r[2], pts: r[3], ppg: r[4], waa: r[5], war: r[6],
          rank: rank.get(r[0]) ?? null,
          posRank: posRank.get(r[0]) ?? null,
          owners: spans[r[0]] ?? [],
          keys: HONOR_ORDER.filter(k => honors.byPlayer[r[0]]?.[season]?.includes(k)),
        });
      }
    });

    for (const v of Object.values(out)) v.sort((a, b) => Number(b.season) - Number(a.season));
    return out;
  })();

  careerPending.catch(() => { careerPending = null; });
  return careerPending;
}

/** one franchise's share of a player's career */
export interface OwnerSplit {
  rid: string;
  /** the manager — the only label that holds still across seasons */
  manager: string;
  /** what the franchise was called in the most recent season it held him */
  team: string;
  /** seasons in which this franchise held him at any point */
  seasons: number;
  /** those seasons, ascending — so a split row can name its own years */
  years: string[];
  gp: number;
  pts: number;
  war: number;
}

/** ["2022","2023","2024","2026"] -> "2022–24, 2026" */
export function yearSpan(years: string[]): string {
  const n = years.map(Number).sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < n.length;) {
    let j = i;
    while (j + 1 < n.length && n[j + 1] === n[j] + 1) j++;
    out.push(j > i ? `${n[i]}–${String(n[j]).slice(2)}` : String(n[i]));
    i = j + 1;
  }
  return out.join(", ");
}

/**
 * Career split by the franchise that held him — the "DET (6 Yrs)" rows.
 *
 * Grouped by roster_id and labelled with the manager, never by team name. A
 * franchise renames itself most years: roster 1 has been London Has Fallen,
 * The Drake Snake, Point Drake and Drake Mungo, so grouping on the name gave
 * Justin Jefferson three one-year owners where he has had one for four years.
 *
 * A season with one owner is attributed whole from the summary row and costs
 * nothing. A season he changed hands in is allocated week by week, which needs
 * that season's weekly.json — so the fetch happens only for the seasons that
 * actually split. About one player-season in six, and for most players none.
 *
 * Weeks are capped at 14 so a split always sums back to the season's own WAR;
 * summary WAR is regular season, while the ownership spans run through the
 * playoffs.
 */
export async function ownerSplits(rows: CareerSeason[]): Promise<OwnerSplit[]> {
  const acc = new Map<string, OwnerSplit & { yrs: Set<string>; last: string }>();
  const bump = (
    o: { rid: string; team: string; manager: string },
    season: string, gp: number, pts: number, war: number,
  ) => {
    const e = acc.get(o.rid)
      ?? { rid: o.rid, manager: o.manager, team: o.team, seasons: 0, years: [], gp: 0, pts: 0, war: 0,
        yrs: new Set<string>(), last: season };
    e.gp += gp; e.pts += pts; e.war += war; e.yrs.add(season);
    // keep the newest name and manager we have seen for this roster
    if (season >= e.last) { e.last = season; e.team = o.team; e.manager = o.manager; }
    acc.set(o.rid, e);
  };

  const split = rows.filter(r => r.owners.length > 1);
  const weeklies = new Map<string, Weekly>();
  await Promise.all(split.map(async r => {
    const w = await jl<Weekly>(`${r.season}/weekly.json`).catch(() => null);
    if (w) weeklies.set(r.season, w);
  }));

  for (const r of rows) {
    if (r.owners.length === 1) { bump(r.owners[0], r.season, r.gp, r.pts, r.war); continue; }
    if (!r.owners.length) continue;
    const wk = weeklies.get(r.season)?.[r.pid];
    if (!wk) {
      // no weekly file — credit the franchise that held him longest rather
      // than silently dropping the season out of the splits
      const main = r.owners.reduce((a, b) => (b.to - b.from > a.to - a.from ? b : a));
      bump(main, r.season, r.gp, r.pts, r.war);
      continue;
    }
    for (const o of r.owners) {
      const mine = wk.filter(x => x[0] <= 14 && x[0] >= o.from && x[0] <= o.to);
      if (!mine.length) continue;
      bump(o, r.season, mine.length,
        mine.reduce((s, x) => s + x[1], 0),
        mine.reduce((s, x) => s + x[5], 0));
    }
  }

  return [...acc.values()]
    .map(({ yrs, last: _last, ...e }) => ({
      ...e, seasons: yrs.size, years: [...yrs].sort(),
    }))
    .sort((a, b) => b.war - a.war || b.seasons - a.seasons);
}

/** career totals per tier, in render order */
export function honorTotals(rows: SeasonHonors[]): [HonorKey, number][] {
  const n: Partial<Record<HonorKey, number>> = {};
  for (const r of rows) for (const k of r.keys) n[k] = (n[k] ?? 0) + 1;
  return HONOR_ORDER.filter(k => n[k]).map(k => [k, n[k] as number]);
}
