import { useMemo } from "react";
import type { Matchups, SleeperProjFile, Team, WeekOdds } from "../../lib/types";
import { useJson } from "../../lib/useJson";
import { useLeague } from "../../lib/context";
import { useLeagueCaps } from "../../lib/caps";
import { fmt } from "../../lib/stats";
import { POS_COLOR, lineupOf, optimalLineup, pInfo } from "../../lib/league";
import { RouteLink } from "../../components/RouteLink";
import { Band, IdCell, NUL, Spine, Strip, useBetaPath } from "../ui";
import { SlotDrawer, type SlotEntry } from "./League";

/**
 * THE WEEKS STILL TO COME (Max, 2026-09-28).
 *
 * Seasons was a record of what happened, and every unplayed week sat in the
 * strip greyed out. A reader planning a lineup, a trade or a playoff push
 * wants the other direction too: who plays whom in week 9 and how the line
 * reads. Every future regular-season week is a destination now, built from
 * the two files the League tab's "This week" card already prices from:
 *
 *   matchups.json `schedule`   the pairings, week -> [[ridA, ridB], …]
 *   odds.json                  each side's projected total (mu), its spread
 *                              (sd) and win probability (wp) — week_odds.py's
 *                              line, off projections for any week not played
 *
 * The matchup page seats each roster's BEST PROJECTED LINEUP off Sleeper's
 * per-week lines (proj_sleeper.json `wk`) — the lineup as managers have set it
 * only exists for the live week (matchups.json `set`), and is used when it is
 * this week. Rosters are today's: a future week is priced on the team as it
 * stands, which is the only roster anyone can know.
 */

const DASH = <span className="lgx-nul">—</span>;

interface Side { rid: number; mu: number | null; sd: number | null; wp: number | null }

function useFuture(wk: number, mw: Matchups, odds: WeekOdds | null | undefined) {
  return useMemo(() => {
    const line = odds?.weeks[String(wk)] ?? {};
    const side = (rid: number): Side => ({
      rid,
      mu: line[String(rid)]?.mu ?? null,
      sd: line[String(rid)]?.sd ?? null,
      wp: line[String(rid)]?.wp ?? null,
    });
    const pairs = (mw.schedule?.[String(wk)] ?? []).map(([a, b]) => ({ a: side(a), b: side(b) }));
    return pairs;
  }, [wk, mw, odds]);
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** the middle block of a card: the projected margin, then the win odds */
function Mid({ a, b }: { a: Side; b: Side }) {
  const has = a.mu != null && b.mu != null;
  const d = has ? a.mu! - b.mu! : 0;
  return (
    <div className="mid">
      <span className="k">Proj</span>
      {has ? (
        <span className="v edge">
          <span className="ar">{d > 0 ? "◂" : ""}</span>
          <span className="n">{fmt(Math.abs(d), 1)}</span>
          <span className="ar">{d < 0 ? "▸" : ""}</span>
        </span>
      ) : <span className="v">—</span>}
      {a.wp != null && b.wp != null && (
        <>
          <span className="k">Odds</span>
          <span className="v">{Math.round(a.wp * 100)}–{Math.round(b.wp * 100)}</span>
        </>
      )}
    </div>
  );
}

function Card({ a, b, nameOf, to }: { a: Side; b: Side; nameOf: (rid: number) => string; to?: string }) {
  const side = (x: Side, right: boolean) => (
    <div className={`side${right ? " r" : ""}`}>
      <div className="nm">{nameOf(x.rid)}</div>
      <div className="fig">{x.mu == null ? NUL : fmt(x.mu, 1)}</div>
    </div>
  );
  const body = <>{side(a, false)}<Mid a={a} b={b} />{side(b, true)}</>;
  return to
    ? <RouteLink className="lgx-game" to={to}>{body}</RouteLink>
    : <div className="lgx-game ssx-still">{body}</div>;
}

/* ---- the week ------------------------------------------------------------ */

export function FutureWeek({ season, wk, mw, odds, nameOf }: {
  season: string; wk: number; mw: Matchups; odds: WeekOdds | null | undefined;
  nameOf: (rid: number) => string;
}) {
  const betaPath = useBetaPath();
  const pairs = useFuture(wk, mw, odds);
  const sides = pairs.flatMap(p => [p.a, p.b]).filter(s => s.mu != null);
  const mus = sides.map(s => s.mu!).sort((x, y) => x - y);
  const median = mus.length
    ? (mus.length % 2 ? mus[(mus.length - 1) / 2] : (mus[mus.length / 2 - 1] + mus[mus.length / 2]) / 2)
    : null;
  /* THE WEEK'S STORYLINES, off the line alone: the most even game, the
     biggest mismatch, the projected high and low. The same four-figure strip
     a played week carries, named for a week that has not happened. */
  const priced = pairs.filter(p => p.a.wp != null && p.b.wp != null);
  const gotw = priced.reduce<(typeof priced)[number] | null>(
    (m, p) => (!m || Math.abs(p.a.wp! - 0.5) < Math.abs(m.a.wp! - 0.5) ? p : m), null);
  const lock = priced.reduce<(typeof priced)[number] | null>(
    (m, p) => (!m || Math.max(p.a.wp!, p.b.wp!) > Math.max(m.a.wp!, m.b.wp!) ? p : m), null);
  const hi = sides.reduce<Side | null>((m, s) => (!m || s.mu! > m.mu! ? s : m), null);
  const lo = sides.reduce<Side | null>((m, s) => (!m || s.mu! < m.mu! ? s : m), null);
  const fav = (p: { a: Side; b: Side }) => (p.a.wp! >= p.b.wp! ? p.a : p.b);
  const dog = (p: { a: Side; b: Side }) => (p.a.wp! >= p.b.wp! ? p.b : p.a);

  return (
    <>
      <Band label={`Week ${wk} · ${season}`}
        note={priced.length ? "Upcoming · the pregame line, off projections" : "Upcoming · no line posted for this week yet"} />
      {!pairs.length ? <div className="empty">No pairings on file for week {wk}.</div> : (
        <>
          {median != null && (
            <div className="lgx-median">
              <span className="k">League median</span>
              <span className="v">{fmt(median, 1)}</span>
              <span className="s">of the projected totals</span>
            </div>
          )}
          <div className="lgx-games">
            {pairs.map(p => (
              <Card key={`${p.a.rid}-${p.b.rid}`} a={p.a} b={p.b} nameOf={nameOf}
                to={betaPath(`/seasons/${season}/${wk}/${p.a.rid}`)} />
            ))}
          </div>
          {priced.length > 0 && (
            <>
              <Band label="Week preview" note="off the pregame line" />
              <div className="lgx-even">
                <Strip figures={[
                  { key: "gotw", label: "Game of the week",
                    value: gotw ? <span className="lgx-warn">{`${pct(fav(gotw).wp!)}`}</span> : DASH,
                    sub: gotw ? `${nameOf(fav(gotw).rid)} over ${nameOf(dog(gotw).rid)}, the closest line` : "no line" },
                  { key: "lock", label: "Lock of the week",
                    value: lock ? <span className="lgx-good">{pct(fav(lock).wp!)}</span> : DASH,
                    sub: lock ? `${nameOf(fav(lock).rid)} over ${nameOf(dog(lock).rid)}` : "no line" },
                  { key: "hi", label: "Projected high",
                    value: hi ? <span className="lgx-good">{fmt(hi.mu!, 1)}</span> : DASH,
                    sub: hi ? nameOf(hi.rid) : "no line" },
                  { key: "lo", label: "Projected low",
                    value: lo ? <span className="lgx-bad">{fmt(lo.mu!, 1)}</span> : DASH,
                    sub: lo ? nameOf(lo.rid) : "no line" },
                ]} />
              </div>
            </>
          )}
        </>
      )}
      <div className="tnote screen">
        A week still to come: the pairings off the league's schedule and week_odds.py's pregame line — each side's
        projected total and its chance to win, the same line the League tab quotes for this week. It moves as the
        projections do, every night until the week is played. Tap a game for both projected lineups.
      </div>
    </>
  );
}

/* ---- one matchup --------------------------------------------------------- */

export function FutureMatchup({ season, wk, rid, mw, odds, teams, nameOf }: {
  season: string; wk: number; rid: number; mw: Matchups;
  odds: WeekOdds | null | undefined; teams: Team[] | null | undefined;
  nameOf: (rid: number) => string;
}) {
  const { meta, players } = useLeague();
  const caps = useLeagueCaps();
  const betaPath = useBetaPath();
  const pairs = useFuture(wk, mw, odds);
  const sproj = useJson<SleeperProjFile>(caps.projections ? "proj_sleeper.json" : null).data;
  const pair = pairs.find(p => p.a.rid === rid || p.b.rid === rid);
  const lineup = useMemo(
    () => lineupOf(meta).filter(sl => !["BN", "IR", "TAXI"].includes(sl)), [meta]);
  const projOf = (pid: string): number | null => sproj?.players[pid]?.wk?.[String(wk)] ?? null;

  /** a roster's lineup for the week: as set, when the live week has one;
   *  otherwise the best projected nine off today's roster */
  const slotsOf = (r: number): { slots: SlotEntry[]; starters: Set<string> } => {
    const set = mw.set?.week === wk ? mw.set.starters[String(r)] ?? null : null;
    if (set && set.length === lineup.length) {
      return {
        slots: lineup.map((slot, i) => {
          const pid = set[i];
          const real = !!pid && pid !== "0";
          return { slot, pid: real ? pid : null, v: real ? projOf(pid) ?? 0 : 0 };
        }),
        starters: new Set(set.filter(p => p && p !== "0")),
      };
    }
    const roster = teams?.find(t => t.roster_id === r)?.players ?? [];
    const pool = roster.map(pid => ({ id: pid, pos: pInfo(players, pid)[1], war: projOf(pid) ?? 0 }))
      .filter(p => p.pos);
    const best = optimalLineup(pool, lineup);
    return {
      slots: best.slots.map(sl => ({ slot: sl.slot, pid: sl.player?.id ?? null, v: sl.player?.war ?? 0 })),
      starters: best.starters,
    };
  };

  if (!pair) return <div className="empty">No game for that team in week {wk}.</div>;
  const { a, b } = pair;
  const la = slotsOf(a.rid), lb = slotsOf(b.rid);
  const setWeek = mw.set?.week === wk;

  const bench = (r: number, starters: Set<string>) => {
    const roster = teams?.find(t => t.roster_id === r)?.players ?? [];
    const list = roster.filter(pid => !starters.has(pid))
      .map(pid => ({ pid, proj: projOf(pid) }))
      .filter(x => pInfo(players, x.pid)[1])
      .sort((x, y) => (y.proj ?? -1) - (x.proj ?? -1));
    return (
      <div>
        <Band label={`Bench · ${nameOf(r)}`} note={`${list.length} not in the lineup · by projection`} />
        {list.length > 0 && (
          <table className="v3tbl lgx-grid">
            <thead>
              <tr>
                <th className="sp" />
                <th className="t">Player</th>
                <th className="n" style={{ width: "24%" }}>Proj</th>
              </tr>
            </thead>
            <tbody>
              {list.map((x, i) => {
                const [name, pos, club] = pInfo(players, x.pid);
                return (
                  <tr key={x.pid} className={i % 2 ? "zebra" : ""}>
                    <Spine color={POS_COLOR[pos]} rank="" />
                    <IdCell name={name} sub={`${club || "FA"} · ${pos}${x.proj == null ? " · no line" : ""}`} />
                    <td className="n">{x.proj == null ? NUL : <span className="f">{fmt(x.proj, 1)}</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    );
  };

  return (
    <>
      <Band label={`${nameOf(a.rid)} vs ${nameOf(b.rid)}`} note={`${season} · week ${wk} · upcoming`} />
      <div className="lgx-games ssx-solo"><Card a={a} b={b} nameOf={nameOf} /></div>
      <Band label="Lineups" note={setWeek ? "as the managers have set them · projected points"
        : "each roster's best projected lineup · today's rosters"} />
      {!sproj && caps.projections ? <div className="empty">Loading…</div> : (
        <div className="ssx-lineups">
          <SlotDrawer
            a={{ rid: a.rid, name: nameOf(a.rid), slots: la.slots }}
            b={{ rid: b.rid, name: nameOf(b.rid), slots: lb.slots }}
            played={false} players={players} board={null} />
        </div>
      )}
      <div className="ssx-two">
        {bench(a.rid, la.starters)}
        {bench(b.rid, lb.starters)}
      </div>
      <div className="tnote screen">
        Projected points are Sleeper's per-week lines scored in this league's settings. A week this far out is priced
        on today's rosters and today's projections, so it moves with every trade, waiver claim and injury report until
        the week is played.
        {" "}<RouteLink to={betaPath(`/seasons/${season}/${wk}`)} className="lgx-all">← Week {wk}</RouteLink>
      </div>
    </>
  );
}
