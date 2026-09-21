import type { BracketFile, Matchups } from "./types";
import { indexKey, jl } from "./data";
import { emptyWL, wlSum, type WL } from "./records";

/**
 * THE POSTSEASON, per player — the Stats board's other half.
 *
 * Everything here is scoped exactly the way `scripts/playoff_war.py` scopes its
 * WAR: the WINNERS bracket, ELIMINATION GAMES ONLY. The championship game
 * counts (`p === 1` is still an elimination), third- and fifth-place games do
 * not, and the consolation bracket does not at all. That has to match, or the
 * WAR column and the record beside it would be counting different games and a
 * reader would have no way to see it.
 *
 * THE BYE IS A WIN (Max, 2026-09-03). The top two seeds sit out round one and
 * advance, and a column that recorded that as nothing would rank the reward for
 * finishing first below the reward for finishing third. It is credited as a win
 * to everyone on that roster in the bye week — starters into both records,
 * bench into the rostered one — because advancing is a fact about the roster,
 * which is what both these records are.
 *
 * THE BYE WEEK'S POINTS ARE THE PLAYER'S OWN AVERAGE, not a real score. The
 * lineup did score that week — Sleeper settles it — but the site's data carries
 * only the TEAM total for it: per-player playoff points come from the bracket's
 * WAR block, which is built from elimination games and therefore has no bye
 * week in it, and weekly.json stops at the regular season. So the bye week is
 * carried at the player's own playoff average: it moves games and points and
 * leaves PPG exactly where it was, which is the least the imputation can do
 * while still counting the week. A player with no elimination game has no
 * average to carry, so he takes the win and no game — never a zero, which would
 * read as "played and scored nothing".
 */

export interface PostSeasonRow {
  /** the franchise he started for, and what it was called that season */
  rid: number | null;
  team: string | null;
  /** elimination games started, plus the bye where one was carried */
  gp: number;
  pts: number;
  /** null when the season's bracket carries no WAR block */
  war: number | null;
  /** WIN SHARE, in wins — the bracket's own `wpa.ws`, the same quantity
   *  season_wpa.py computes for the other fourteen weeks. Each elimination
   *  game hands out exactly 1.0, so a champion's nine starters sum to 3.0. */
  ws: number | null;
  start: WL;
  roster: WL;
  /** first-round byes he was on the roster for. 0 or 1 in a season. */
  byes: number;
}

export interface PostSeasonIndex {
  /** pid -> season -> that season's postseason */
  byPlayer: Record<string, Record<string, PostSeasonRow>>;
  /** seasons whose bracket actually produced rows */
  seasons: string[];
}

/** one index per (league, season list) — see `lib/data.ts#indexKey` */
const cache = new Map<string, Promise<PostSeasonIndex>>();

/** the games playoff WAR counts: winners bracket, placement games dropped */
const counted = (b: BracketFile) =>
  b.winners.filter(g => !(g.p && g.p > 1) && g.w != null && g.l != null);

/** every SEAT in the winners bracket, decided or not — the same placement
 *  filter, without the "has a result" one. `counted` answers "which games have
 *  been played"; this answers "who is in the bracket", and while a round is
 *  still in flight those are different sets. */
const seats = (b: BracketFile) => b.winners.filter(g => !(g.p && g.p > 1));

export function loadPostseason(seasons: string[]): Promise<PostSeasonIndex> {
  const ck = indexKey(seasons);
  const hit = cache.get(ck);
  if (hit) return hit;

  const pending = (async () => {
    const [brackets, mus] = await Promise.all([
      Promise.all(seasons.map(s => jl<BracketFile>(`${s}/bracket.json`).catch(() => null))),
      Promise.all(seasons.map(s => jl<Matchups>(`${s}/matchups.json`).catch(() => null))),
    ]);

    const byPlayer: PostSeasonIndex["byPlayer"] = {};
    const played: string[] = [];

    seasons.forEach((season, i) => {
      const b = brackets[i], m = mus[i];
      if (!b) return;
      const games = counted(b);
      if (!games.length) return;

      /** who a roster started / benched in a given playoff week */
      const lineup = (rid: number, wk: number) => {
        const e = m?.teams[String(rid)]?.find(x => x[0] === wk);
        const starters = (e?.[4] ?? []).filter(p => p && p !== "0");
        const bench = (e?.[5] ?? []).filter(p => p && p !== "0" && !starters.includes(p));
        return { starters, bench };
      };

      const row = (pid: string): PostSeasonRow => {
        const bag = (byPlayer[pid] ??= {});
        return bag[season] ??= {
          rid: null, team: null, gp: 0, pts: 0, war: null, ws: null,
          start: emptyWL(), roster: emptyWL(), byes: 0,
        };
      };

      /* ---- production, straight off the bracket's WAR block -------------
         gp, pts and war together, from one source, so the four production
         columns can never disagree about which games they counted. */
      for (const [pid, w] of Object.entries(b.war ?? {})) {
        const r = row(pid);
        r.rid = w.rid;
        r.team = b.names[String(w.rid)] ?? null;
        r.gp = w.gp;
        r.pts = w.pts;
        r.war = w.war;
      }

      /* WIN SHARE rides the wpa block, not the war one — different scripts,
         and a season built before playoff_wpa.py ran has the second and not
         the first. Read separately so that case is an em dash in one column
         rather than a missing row. */
      for (const [pid, v] of Object.entries(b.wpa ?? {})) {
        if (v.ws == null) continue;
        const r = row(pid);
        r.ws = v.ws;
        if (r.rid == null) { r.rid = v.rid; r.team = b.names[String(v.rid)] ?? null; }
      }

      /* ---- the record, game by game ------------------------------------- */
      for (const g of games) {
        for (const side of [g.w, g.l] as (number | null)[]) {
          if (side == null) continue;
          const key = side === g.w ? "w" : "l";
          const { starters, bench } = lineup(side, g.week);
          for (const pid of starters) {
            const r = row(pid);
            r.start[key]++; r.roster[key]++;
            if (r.rid == null) { r.rid = side; r.team = b.names[String(side)] ?? null; }
          }
          for (const pid of bench) row(pid).roster[key]++;
        }
      }

      /* ---- the bye ------------------------------------------------------
         A team in the counted bracket that never appears in its first round
         did not lose its way in — it was seeded past it. Derived from the
         bracket rather than from a matchups row with no opponent, because that
         same shape also describes a team that is simply finished: four rosters
         sit out the final week every year and none of them earned anything. */
      /* MEMBERSHIP COMES OFF THE SEATS, NOT OFF THE RESULTS. A bye is visible
         only as "in the bracket and not in round one", and the only place a
         bye team appears is its round-TWO game — so reading membership off the
         DECIDED games credited nobody until round two was in the books. For a
         finished season the two sets are identical and nothing moves; for the
         fortnight the bracket is live, the top seeds' byes now land the week
         they actually happened. */
      const all = seats(b);
      const firstRound = Math.min(...all.map(g => g.r));
      const byeWeek = Math.min(...all.filter(g => g.r === firstRound).map(g => g.week));
      const inRound1 = new Set<number>();
      for (const g of all.filter(g => g.r === firstRound))
        for (const t of [g.t1, g.t2]) if (t != null) inRound1.add(t);
      const inBracket = new Set<number>();
      for (const g of all) for (const t of [g.t1, g.t2]) if (t != null) inBracket.add(t);

      for (const rid of inBracket) {
        if (inRound1.has(rid)) continue;
        const { starters, bench } = lineup(rid, byeWeek);
        for (const pid of starters) {
          const r = row(pid);
          r.start.w++; r.roster.w++; r.byes++;
          if (r.rid == null) { r.rid = rid; r.team = b.names[String(rid)] ?? null; }
          // the average carried into the bye week — see the header note
          if (r.gp > 0) { r.pts += r.pts / r.gp; r.gp += 1; }
        }
        for (const pid of bench) {
          const r = row(pid);
          r.roster.w++;
          if (r.rid == null) { r.rid = rid; r.team = b.names[String(rid)] ?? null; }
        }
      }

      played.push(season);
    });

    return { byPlayer, seasons: played };
  })();

  cache.set(ck, pending);
  pending.catch(() => cache.delete(ck));
  return pending;
}

/** one player's postseason over a set of seasons — one year, or a career */
export function postseasonOf(
  idx: PostSeasonIndex | null, pid: string, seasons: string[],
): PostSeasonRow | null {
  const bag = idx?.byPlayer[pid];
  if (!bag) return null;
  const got = seasons
    .map(s => [s, bag[s]] as const)
    .filter((e): e is [string, PostSeasonRow] => !!e[1]);
  if (!got.length) return null;
  const rows = got.map(e => e[1]);
  if (rows.length === 1) return rows[0];
  const war = rows.some(r => r.war != null)
    ? rows.reduce((a, r) => a + (r.war ?? 0), 0) : null;
  const ws = rows.some(r => r.ws != null)
    ? rows.reduce((a, r) => a + (r.ws ?? 0), 0) : null;
  /* The most recent season's franchise; a career has no single one, and the
     caller prints a seasons count in that slot rather than a team.
     BY SEASON, not by position in the list: this took `rows[rows.length - 1]`
     and every caller passes its seasons NEWEST FIRST, so the "most recent"
     franchise was reliably the OLDEST one he played for. */
  const last = got.reduce((a, b) => (Number(b[0]) > Number(a[0]) ? b : a))[1];
  return {
    rid: last.rid, team: last.team,
    gp: rows.reduce((a, r) => a + r.gp, 0),
    pts: rows.reduce((a, r) => a + r.pts, 0),
    war, ws,
    start: wlSum(rows.map(r => r.start)),
    roster: wlSum(rows.map(r => r.roster)),
    byes: rows.reduce((a, r) => a + r.byes, 0),
  };
}
