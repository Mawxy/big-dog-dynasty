import { useMemo } from "react";
import type { Matchups, SleeperProjFile, Team, WeekOdds, Weekly } from "../../lib/types";
import { useJson } from "../../lib/useJson";
import { useLeague } from "../../lib/context";
import { useLeagueCaps } from "../../lib/caps";
import { fmt } from "../../lib/stats";
import { POS_CHIPS, POS_COLOR, lineupOf, pInfo } from "../../lib/league";
import { weekFigures, type WeekRow } from "../week";
import { Performers } from "./Seasons";
import {
  isStale, useLiveWeekFeed, useNflBoardFeed, type LiveSide, type Scoreboard,
} from "../../lib/liveScores";
import { estWar, settledBaseline, weekBaseline, type WarBaseline } from "../../lib/liveWar";
import { RouteLink } from "../../components/RouteLink";
import { Band, IdCell, NUL, sgnWar, Spine, Strip, useBetaPath } from "../ui";
import { PosLeaders, SlotDrawer, warLabel, type SlotEntry } from "./League";

const POSITIONS = POS_CHIPS.filter(p => p !== "ALL");
const DASH = <span className="lgx-nul">—</span>;

/**
 * THE WEEK IN PROGRESS ON THE WEEK FLOOR (Max, 2026-09-28).
 *
 * Seasons reads the pipeline's files, and the pipeline scores a week once it
 * is over — so the week everyone is watching had no page, and the League
 * card's "Full matchup →" landed on "No game for that team". These two views
 * fill that week from the same live feed the League card polls (Sleeper's
 * matchups endpoint, ESPN's scoreboard for the clocks), and put an ESTIMATED
 * WAR beside every man's points: lib/liveWar says how the estimate is built
 * and when it tightens. Once the nightly build writes the week, Seasons reads
 * the file again and these views are never reached for it.
 */

interface LiveCtx {
  live: { sides: Record<string, LiveSide>; started: boolean } | null;
  board: Scoreboard | null;
  stale: boolean;
  /** every NFL game this week is final */
  done: boolean;
  base: WarBaseline | null;
  pairs: [number, number][];
}

function useLiveCtx(season: string, wk: number, mw: Matchups, weekly: Weekly | null | undefined): LiveCtx {
  const { league, meta, players } = useLeague();
  const leagueId = league.chain?.[season] ?? league.currentLeagueId ?? null;
  const boardFeed = useNflBoardFeed(season, wk, true);
  const board = boardFeed.week === wk ? boardFeed.data : null;
  const liveFeed = useLiveWeekFeed(leagueId, wk, true, board);
  const live = liveFeed.week === wk ? liveFeed.data : null;
  const stale = !!live?.started && isStale(liveFeed);
  const done = !!board && Object.keys(board).length > 0
    && Object.values(board).every(g => g.state === "post");

  const base = useMemo(() => {
    const own = () => {
      if (!live) return null;
      const all: Record<string, number> = {};
      for (const s of Object.values(live.sides)) Object.assign(all, s.ppts);
      const sides = Object.values(live.sides);
      return weekBaseline(all, sides.map(s => s.pts), players, lineupOf(meta), sides.length);
    };
    // the week's own baselines once it is over; the season's until then,
    // and the partial week's only when no week has settled to average
    return (done ? own() : null) ?? settledBaseline(weekly, mw, players) ?? own();
  }, [done, live, weekly, mw, players, meta]);

  const pairs = useMemo<[number, number][]>(() => (mw.schedule?.[String(wk)] ?? []).slice(), [mw, wk]);
  return { live, board, stale, done, base, pairs };
}

/** a man's estimated WAR and how settled it is, off his game's clock: no
 *  figure before kickoff, "live" during, "est" once it is over. A player
 *  with no game on the board (a bye) or a final with no points has no
 *  figure — the pipeline counts only men who played. */
function warFor(pid: string, pts: number, ctx: LiveCtx, players: ReturnType<typeof useLeague>["players"]):
  Pick<SlotEntry, "war" | "warEst"> {
  const [, pos, team] = pInfo(players, pid);
  const g = ctx.board?.[team];
  if (!g) return { war: pts ? estWar(pts, pos, ctx.base) : null, warEst: "est" };
  if (g.state === "pre") return { war: null };
  if (g.state === "post" && !pts) return { war: null };
  return { war: estWar(pts, pos, ctx.base), warEst: g.state === "post" ? "est" : "live" };
}

function baseNote(ctx: LiveCtx): string {
  if (!ctx.base) return "no baseline yet — WAR fills in as the week is played";
  return ctx.base.source === "week"
    ? "est WAR against this week's own replacement level and spread; the pipeline's figure replaces it once the week is scored"
    : `est WAR against the season's replacement level and spread (${ctx.base.weeks} settled week${ctx.base.weeks === 1 ? "" : "s"}), on points so far`;
}

/* ---- the week's games, live -------------------------------------------- */

export function LiveWeek({ season, wk, mw, weekly, odds, teams, nameOf }: {
  season: string; wk: number; mw: Matchups; weekly: Weekly | null | undefined;
  odds: WeekOdds | null | undefined; teams: Team[] | null | undefined;
  nameOf: (rid: number) => string;
}) {
  const { players } = useLeague();
  const betaPath = useBetaPath();
  const ctx = useLiveCtx(season, wk, mw, weekly);
  const ptsOf = (rid: number) => ctx.live?.sides[String(rid)]?.pts ?? null;

  /* THE FINAL WEEK'S MODULES, LIVE (Max, 2026-09-28): the median, the four
     week figures, the position leaders and the top performers — the same
     components a scored week draws, fed from the live feed. The rows are the
     scored week's shape (beta/week.ts WeekRow) built from the pairings and
     the running totals, and the player-weeks a synthetic weekly.json row
     [week, pts, vs avg, vs repl, 0, est WAR] for everyone with points so far,
     so weekFigures and Performers run unchanged. */
  const liveRows = useMemo<WeekRow[]>(() => {
    const L = ctx.live;
    if (!L?.started) return [];
    const out: WeekRow[] = [];
    for (const [a, b] of ctx.pairs) {
      const sa = L.sides[String(a)], sb = L.sides[String(b)];
      if (!sa || !sb) continue;
      const side = (s: LiveSide, opp: LiveSide): WeekRow => {
        const starters = s.starters.filter(p => p && p !== "0");
        const roster = teams?.find(t => t.roster_id === s.rid)?.players ?? Object.keys(s.ppts);
        return {
          rid: s.rid, pts: s.pts, opp: opp.rid, oppPts: opp.pts,
          starters, bench: roster.filter(p => !starters.includes(p)),
        };
      };
      out.push(side(sa, sb), side(sb, sa));
    }
    return out;
  }, [ctx.live, ctx.pairs, teams]);
  const liveWeekly = useMemo<Weekly | null>(() => {
    const L = ctx.live;
    if (!L?.started || !ctx.base) return null;
    const out: Weekly = {};
    for (const s of Object.values(L.sides))
      for (const [pid, pts] of Object.entries(s.ppts)) {
        if (!pts) continue;
        const pos = pInfo(players, pid)[1];
        const w = warFor(pid, pts, ctx, players).war;
        if (w == null) continue;
        out[pid] = [[wk, pts, pts - (ctx.base.avg[pos] ?? 0), pts - (ctx.base.repl[pos] ?? 0), 0, w]];
      }
    return out;
  }, [ctx, players, wk]);
  const figs = useMemo(
    () => (liveRows.length ? weekFigures(liveRows, wk, odds, liveWeekly, players) : null),
    [liveRows, wk, odds, liveWeekly, players]);
  const teamOf = (pid: string) => teams?.find(t => t.players.includes(pid))?.team ?? null;
  /** UPSET WATCH: the underdog leading by the widest pregame gap — the
   *  leader the line liked least, and only if the line had him under 50% */
  const upset = useMemo(() => {
    const line = odds?.weeks[String(wk)] ?? {};
    let best: { row: WeekRow; wp: number } | null = null;
    for (const r of liveRows) {
      const wp = line[String(r.rid)]?.wp;
      if (wp == null || wp >= 0.5 || r.oppPts == null || r.pts <= r.oppPts) continue;
      if (!best || wp < best.wp) best = { row: r, wp };
    }
    return best;
  }, [liveRows, odds, wk]);
  return (
    <>
      <Band label={`Week ${wk} · ${season}`}
        note={ctx.stale ? "Live · the feed has stopped answering; these are the last good read"
          : ctx.live?.started ? (ctx.done ? "Every game final · the pipeline scores the week overnight" : "Live · points so far")
            : "Not under way yet"} />
      {!ctx.pairs.length ? <div className="empty">No pairings on file for week {wk}.</div> : (
        <div className="lgx-games">
          {ctx.pairs.map(([a, b]) => {
            const pa = ptsOf(a), pb = ptsOf(b);
            const aWon = ctx.done && pa != null && pb != null && pa > pb;
            const bWon = ctx.done && pa != null && pb != null && pb > pa;
            const side = (rid: number, p: number | null, won: boolean, right: boolean) => (
              <div className={`side${right ? " r" : ""}${won ? " won" : ""}`}>
                <div className="nm">{nameOf(rid)}</div>
                <div className="fig">{p == null ? NUL : fmt(p, 1)}</div>
              </div>
            );
            return (
              <RouteLink key={`${a}-${b}`} className="lgx-game" to={betaPath(`/seasons/${season}/${wk}/${a}`)}>
                {side(a, pa, aWon, false)}
                <div className="mid">
                  <span className="k">{ctx.done ? "Final*" : ctx.live?.started ? "Live" : "Pregame"}</span>
                  {pa != null && pb != null && (
                    <span className="v edge">
                      <span className="ar">{pa > pb ? "◂" : ""}</span>
                      <span className="n">{fmt(Math.abs(pa - pb), 1)}</span>
                      <span className="ar">{pb > pa ? "▸" : ""}</span>
                    </span>
                  )}
                </div>
                {side(b, pb, bWon, true)}
              </RouteLink>
            );
          })}
        </div>
      )}
      {figs && (
        <>
          {figs.median != null && (
            <div className="lgx-median">
              <span className="k">League median</span>
              <span className="v">{fmt(figs.median, 1)}</span>
              <span className="s">of the points so far</span>
            </div>
          )}
          <Band label="Week figures" note={ctx.done ? "every game final · not yet scored" : "so far · moving with the games"} />
          <div className="lgx-even">
            <Strip figures={[
              /* THE LIVE WEEK TALKS LIKE A SCOREBOARD SHOW (Max, 2026-09-28):
                 "upset watch", "nail-biter", "in the basement" — the same four
                 figures a final week prints, named for a week still moving. */
              { key: "top", label: ctx.done ? "Top score" : "Leading the league",
                value: <span className="lgx-good">{fmt(figs.top.pts, 1)}</span>, sub: nameOf(figs.top.rid) },
              { key: "low", label: ctx.done ? "Low score" : "In the basement",
                value: <span className="lgx-bad">{fmt(figs.low.pts, 1)}</span>, sub: nameOf(figs.low.rid) },
              { key: "upset", label: ctx.done ? "Upset" : "Upset watch",
                value: upset ? <span className="lgx-warn">{`${Math.round(upset.wp * 100)}%`}</span> : DASH,
                sub: upset
                  ? `${nameOf(upset.row.rid)} ${ctx.done ? "beat" : "leads"} ${upset.row.opp != null ? nameOf(upset.row.opp) : "—"} by ${fmt(upset.row.pts - (upset.row.oppPts ?? 0), 1)} · pregame odds`
                  : ctx.done ? "every favorite won" : "every favorite leads" },
              { key: "close", label: ctx.done ? "Nail-biter" : "Nail-biter watch",
                value: figs.closest ? fmt(figs.closest.pts - figs.closest.oppPts, 1) : DASH,
                sub: figs.closest
                  ? `${nameOf(figs.closest.rid)} ${ctx.done ? "edged" : "leads"} ${nameOf(figs.closest.opp)}, ${fmt(figs.closest.pts, 1)}–${fmt(figs.closest.oppPts, 1)}`
                  : "no game under way" },
            ]} />
          </div>
          <PosLeaders
            leaders={POSITIONS.map(pos => {
              const t = figs.posTop[pos];
              return t ? { pid: t.pid, value: `${fmt(t.pts, 1)} pts`, note: teamOf(t.pid) ?? "unrostered" } : null;
            })}
            settled={!!liveWeekly}
            empty={pos => `no ${pos} scored yet`} />
          <Performers wk={wk} rows={liveRows} weekly={liveWeekly} nameOf={nameOf} betaPath={betaPath} est />
        </>
      )}
      <div className="tnote screen">
        The week in progress, off Sleeper's live scoring. Tap a game for both lineups with an estimated WAR
        beside every man's points. {ctx.done ? "* Final on the field; the official figures land when the nightly build scores the week." : ""}
      </div>
    </>
  );
}

/* ---- one matchup, live --------------------------------------------------- */

export function LiveMatchup({ season, wk, rid, mw, weekly, teams, nameOf }: {
  season: string; wk: number; rid: number; mw: Matchups;
  weekly: Weekly | null | undefined; teams: Team[] | null | undefined;
  nameOf: (rid: number) => string;
}) {
  const { meta, players } = useLeague();
  const caps = useLeagueCaps();
  const betaPath = useBetaPath();
  const ctx = useLiveCtx(season, wk, mw, weekly);
  const sproj = useJson<SleeperProjFile>(caps.projections ? "proj_sleeper.json" : null).data;
  const pair = ctx.pairs.find(([a, b]) => a === rid || b === rid);

  const lineup = useMemo(
    () => lineupOf(meta).filter(sl => !["BN", "IR", "TAXI"].includes(sl)), [meta]);

  const slotsOf = (r: number): SlotEntry[] => {
    const ls = ctx.live?.sides[String(r)] ?? null;
    const set = ls?.starters.length ? ls.starters
      : mw.set?.week === wk ? mw.set.starters[String(r)] ?? [] : [];
    const n = Math.max(lineup.length, set.length);
    return Array.from({ length: n }, (_, i) => {
      const pid = set[i];
      const slot = lineup[i] ?? "FLEX";
      if (!pid || pid === "0") return { slot, pid: null, v: 0 };
      const v = ls?.ppts[pid] ?? 0;
      const proj = sproj?.players[pid]?.wk?.[String(wk)];
      const g = ctx.board?.[pInfo(players, pid)[2]];
      const over = g ? g.state === "post" : ctx.done;
      const rem = over ? 0 : g ? g.remaining : v > 0 ? 0 : 1;
      return {
        slot, pid, v, over,
        ...(proj != null
          ? { proj, miss: over && v < proj, beat: over && v > proj, est: v + rem * proj }
          : { est: v }),
        ...warFor(pid, v, ctx, players),
      };
    });
  };

  if (!pair) return <div className="empty">No game for that team in week {wk}.</div>;
  const [a, b] = pair;

  const bench = (r: number) => {
    const ls = ctx.live?.sides[String(r)] ?? null;
    const starters = new Set(ls?.starters ?? []);
    const roster = teams?.find(t => t.roster_id === r)?.players ?? Object.keys(ls?.ppts ?? {});
    const list = roster
      .filter(pid => !starters.has(pid) && ls?.ppts[pid] != null)
      .map(pid => ({ pid, pts: ls!.ppts[pid], ...warFor(pid, ls!.ppts[pid], ctx, players) }))
      .sort((x, y) => y.pts - x.pts);
    return (
      <div>
        <Band label={`Bench · ${nameOf(r)}`}
          note={list.length ? `${list.length} not started · by points so far` : "no bench on file"} />
        {list.length > 0 && (
          <table className="v3tbl lgx-grid">
            <thead>
              <tr>
                <th className="sp" />
                <th className="t">Player</th>
                <th className="n" style={{ width: "20%" }}>Pts</th>
                <th className="n" style={{ width: "22%" }}>Est WAR</th>
              </tr>
            </thead>
            <tbody>
              {list.map((x, i) => {
                const [name, pos, club] = pInfo(players, x.pid);
                return (
                  <tr key={x.pid} className={i % 2 ? "zebra" : ""}>
                    <Spine color={POS_COLOR[pos]} rank="" />
                    <IdCell name={name} sub={`${club || "FA"} · ${pos}`} />
                    <td className="n"><span className="f">{fmt(x.pts, 1)}</span></td>
                    <td className="n">{x.war == null ? NUL
                      : <span className={`f ssx-war${x.warEst === "live" ? " ssx-live" : ""}`}
                        title={warLabel(x.warEst)}>{sgnWar(x.war)}</span>}</td>
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
      <Band label={`${nameOf(a)} vs ${nameOf(b)}`}
        note={`${season} · week ${wk} · ${ctx.stale ? "live feed stalled" : ctx.done ? "final on the field, not yet scored" : ctx.live?.started ? "live" : "not under way"}`} />
      <Band label="Lineups" note={baseNote(ctx)} />
      {ctx.live ? (
        <div className="ssx-lineups">
          <SlotDrawer
            a={{ rid: a, name: nameOf(a), slots: slotsOf(a) }}
            b={{ rid: b, name: nameOf(b), slots: slotsOf(b) }}
            played={false} live={!!ctx.live.started} war
            players={players} board={ctx.board} />
        </div>
      ) : <div className="empty">Reading the live scores…</div>}
      <div className="ssx-two">
        {bench(a)}
        {bench(b)}
      </div>
      <div className="tnote screen">
        Est WAR is an estimate: the pipeline has not scored this week yet. It is the same formula — the
        win-probability shift of his points over his position's replacement level — with the week's baselines
        estimated; live WAR means his game is still on and the figure is moving with it. A man who has not kicked
        off has no figure. The official WAR replaces all of it once the nightly build scores the week.
        {" "}<RouteLink to={betaPath(`/seasons/${season}/${wk}`)} className="lgx-all">← Week {wk}</RouteLink>
      </div>
    </>
  );
}
