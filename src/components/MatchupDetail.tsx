import { useMemo } from "react";
import type {
  Matchups, PlayersMin, SeasonData, SleeperProjFile, Weekly as WeeklyT,
} from "../lib/types";
import { useJson } from "../lib/useJson";
import { fmt, sgnWar, normCdf } from "../lib/stats";
import { pInfo, lineupOf, SLOT_LABEL, optimalLineup } from "../lib/league";
import { useLeague } from "../lib/context";
import PosBadge from "./PosBadge";
import { PlayerLink } from "./PlayerLink";

/** the NFL opponent beside a name — "MIA", or BYE in the caution ink a bye
 *  takes on the week grid; nothing at all when the schedule is not known */
function Opp({ v }: { v: string | null }) {
  if (v == null) return null;
  return <span className={`mopp${v === "BYE" ? " bye" : ""}`}>{v}</span>;
}

interface Side {
  rid: number; name: string;
  /** slot label, player, and what he scored (or is projected to) */
  slots: { label: string; pid: string | null; pts: number; war: number | null }[];
  total: number;
  /** whether this week's entry carried a bench at all */
  hasBench: boolean;
  /** what the best legal lineup would have scored from the same roster */
  max: number;
  /** THE BENCH, whole (Max, 2026-09-08): everyone rostered and not started,
   *  by points. Not "the best five not started" — a manager reading his own
   *  week wants to see the whole bench, zeros included; the zeros are the
   *  byes and the busts, which is information. Taxi and IR stay out: they
   *  could not have been started. */
  benched: { pid: string; pts: number }[];
}

/**
 * One matchup, both lineups side by side.
 *
 * Played weeks read the actual starters out of matchups.json and their real
 * points and WAR out of weekly.json. Unplayed weeks have no starters at all —
 * the roster hasn't been set — so the lineup is the OPTIMAL one by projected
 * points, which is a forecast of the manager's decision as much as the result.
 * The two are labeled differently for that reason.
 */
export default function MatchupDetail({ season, wk, rid, data, weekly, mw, players, back }: {
  season: string; wk: number; rid: number;
  data: SeasonData; weekly: WeeklyT; mw: Matchups; players: PlayersMin;
  back: () => void;
}) {
  const { meta } = useLeague();
  const lineup = lineupOf(meta)
    .filter(s => !["BN", "IR", "TAXI"].includes(s));

  // the entry for this week, if it was played
  const entryOf = (r: number) => (mw.teams[String(r)] ?? []).find(x => x[0] === wk);
  const mine = entryOf(rid);
  const oppRid = mine?.[2]
    ?? (mw.schedule?.[String(wk)] ?? []).flatMap(p => p[0] === rid ? [p[1]] : p[1] === rid ? [p[0]] : [])[0]
    ?? null;
  const played = !!mine && mine[1] > 0;

  // an unplayed week needs the projection to stand in for a result; every
  // week of the roster season needs its NFL schedule, which rides on the same
  // file (fetch_projections.py `schedule`)
  const sproj = useJson<SleeperProjFile>("proj_sleeper.json").data;
  /** the player's NFL opponent this week, or BYE, or null when the file has no
   *  schedule for this season (past years — it carries the current one only) */
  const oppOf = (pid: string): string | null => {
    const sched = sproj?.schedule;
    if (!sched || String(sproj?.meta?.season) !== season) return null;
    const club = pInfo(players, pid)[2];
    if (!club) return null;
    const line = sched[club];
    if (!line) return null;
    return line[String(wk)] ?? "BYE";
  };

  /** league-wide weekly scoring sigma, for the win probability. Same shape the
   *  WAR engine uses: a margin is worth more in a low-scoring week. */
  const sigma = useMemo(() => {
    const scores: number[] = [];
    for (const list of Object.values(mw.teams))
      for (const e of list) if (e[1] > 0) scores.push(e[1]);
    if (scores.length < 4) return 25;
    const m = scores.reduce((a, b) => a + b, 0) / scores.length;
    return Math.sqrt(scores.reduce((a, b) => a + (b - m) ** 2, 0) / (scores.length - 1));
  }, [mw]);

  const wkIdx = useMemo(() => {
    const idx: Record<string, [number, number]> = {};
    for (const [pid, rows] of Object.entries(weekly)) {
      const r = rows.find(x => x[0] === wk);
      if (r) idx[pid] = [r[1], r[5]];      // points, WAR
    }
    return idx;
  }, [weekly, wk]);

  /** an unplayed week's bench: the roster less the lineup, less taxi and IR,
   *  each at this week's projected line, best first */
  const benchOf = (team: { players: string[]; taxi: string[]; reserve: string[] } | undefined,
    started: (string | null)[]) => {
    if (!team) return [];
    const out = new Set([...started.filter((x): x is string => !!x), ...team.taxi, ...team.reserve]);
    const sp = (pid: string) => {
      const row = sproj?.players?.[pid];
      return row?.wk ? row.wk[String(wk)] ?? 0 : row?.ppg ?? 0;
    };
    return team.players.filter(pid => !out.has(pid))
      .map(pid => ({ pid, pts: sp(pid) }))
      .sort((a, b) => b.pts - a.pts);
  };

  const sideOf = (r: number | null): Side | null => {
    if (r == null) return null;
    const team = data.teams.find(t => t.roster_id === r);
    const name = team?.team ?? `Roster ${r}`;
    const e = entryOf(r);
    if (played && e) {
      const slots = e[4].map((pid, i) => ({
        label: SLOT_LABEL[lineup[i]] ?? lineup[i] ?? "—",
        pid: pid || null,
        pts: wkIdx[pid]?.[0] ?? 0,
        war: wkIdx[pid]?.[1] ?? null,
      }));
      // Optimal score from the roster AS IT WAS that week. e[5] is the bench
      // carried by build_site_data; teams.json can't substitute, being the
      // end-of-season roster. Absent for data built before it was carried, in
      // which case there is no bench to show and max collapses to the actual.
      const bench = e[5] ?? [];
      const all = [...e[4], ...bench].filter(Boolean);
      const { slots: bestSlots } = optimalLineup(
        all.map(pid => ({ id: pid, pos: pInfo(players, pid)[1],
                          war: wkIdx[pid]?.[0] ?? 0 })), lineup);
      return {
        rid: r, name, slots, total: e[1],
        hasBench: bench.length > 0,
        max: bestSlots.reduce((a, sl) => a + (sl.player?.war ?? 0), 0),
        benched: bench
          .map(pid => ({ pid, pts: wkIdx[pid]?.[0] ?? 0 }))
          .sort((a, b) => b.pts - a.pts),
      };
    }
    // not played: price with THIS week's own projection line, not the season
    // average multiplied out. A weekly-covered player with no line this week
    // is on bye (0.0); season-only rows keep ppg.
    const wkPts = (pid: string) => {
      const sp = sproj?.players?.[pid];
      return sp?.wk ? sp.wk[String(wk)] ?? 0 : sp?.ppg ?? 0;
    };
    // The LIVE week shows the lineup as the manager actually SET it (settled
    // with Max, 2026-08-31); future weeks stay the best legal projection.
    const setL = mw.set?.week === wk ? mw.set.starters[String(r)] : undefined;
    if (setL?.length) {
      const rows = setL.map((pid, i) => ({
        label: SLOT_LABEL[lineup[i]] ?? lineup[i] ?? "?",
        pid: pid && pid !== "0" ? pid : null,
        pts: pid && pid !== "0" ? wkPts(pid) : 0,
        war: null,
      }));
      const total = rows.reduce((a, s) => a + s.pts, 0);
      // the optimal projection still prices `max`, so the header can show
      // what the set lineup leaves on the bench
      const poolAll = (team?.players ?? [])
        .map(pid => ({ id: pid, pos: pInfo(players, pid)[1], war: wkPts(pid) }))
        .filter(p => p.war > 0);
      const best = optimalLineup(poolAll, lineup).slots
        .reduce((a, s) => a + (s.player?.war ?? 0), 0);
      return {
        rid: r, name, slots: rows, total,
        hasBench: true, max: Math.max(best, total),
        benched: benchOf(team, rows.map(x => x.pid)),
      };
    }
    const pool = (team?.players ?? [])
      .map(pid => ({ id: pid, pos: pInfo(players, pid)[1], war: wkPts(pid) }))
      .filter(p => p.war > 0);
    const { slots } = optimalLineup(pool, lineup);
    return {
      rid: r, name,
      slots: slots.map(s => ({
        label: SLOT_LABEL[s.slot] ?? s.slot,
        pid: s.player?.id ?? null,
        pts: s.player?.war ?? 0,
        war: null,
      })),
      total: slots.reduce((a, s) => a + (s.player?.war ?? 0), 0),
      hasBench: true,      // nothing to report, but nothing is missing either
      // the projected lineup already IS the optimal one, so max is the total
      max: slots.reduce((a, s) => a + (s.player?.war ?? 0), 0),
      benched: benchOf(team, slots.map(s => s.player?.id ?? null)),
    };
  };

  const A = sideOf(rid), B = sideOf(oppRid);
  if (!A) return <div className="empty">No matchup found for week {wk}.</div>;

  // P(A wins) from the projected margin — Φ(margin / (σ√2)), the same
  // formulation the WAR engine uses to turn points into win probability
  const margin = A.total - (B?.total ?? 0);
  const pA = B ? normCdf(margin / (sigma * Math.SQRT2)) : 1;

  /** one side of the head-to-head; a missing opponent is a bye, drawn the same
   *  way the week grid draws one */
  const sideBlock = (s: Side | null, i: 0 | 1) => {
    if (!s) return (
      <div className="h2h-side">
        <div className="nm">Bye</div>
        <div className="score" style={{ color: "var(--dim3)" }}>—</div>
        <div className="res">{" "}</div>
      </div>
    );
    // against the OPPONENT, not against the higher of the two: a tied played
    // matchup matched both sides to the max and accented both as winners.
    // A tie is neither. A bye has no opponent, so the lone side keeps it.
    const opp = i === 0 ? B : A;
    const win = played
      ? (opp ? s.total > opp.total : true)
      : (i === 0 ? pA >= 0.5 : pA < 0.5);
    return (
      <div className={`h2h-side${win ? " win" : ""}`}>
        <div className="nm">{s.name}</div>
        <div className="score">{fmt(s.total, 1)}</div>
        <div className="res">
          {played ? <>
            max {fmt(s.max, 1)}
            {s.max > s.total + 0.05 &&
              <span className="left"> · left {fmt(s.max - s.total, 1)} on the bench</span>}
          </> : B ? `${fmt((i === 0 ? pA : 1 - pA) * 100, 0)}% to win` : " "}
        </div>
      </div>
    );
  };

  return (
    <>
      {/* the back control is a chip in the header, the same place and shape the
          draft's own page puts it — it used to be a bare link sitting outside
          the header with the whole block pulled flush to x=0, so this was the
          one screen whose title didn't line up with the gutter */}
      <div className="screen-head">
        <span className="screen-title">
          {A.name} {played ? "vs" : "at"} {B?.name ?? "bye"}
        </span>
        <button type="button" className="chip" onClick={back}>‹ Week {wk}</button>
        <span className="screen-note">
          {season} · {played ? "final" : "projected"}
        </span>
      </div>

      {/* The headline is the SAME head-to-head unit the week grid draws, at
          full board width. Opening a matchup used to swap it for a second
          idiom of its own (.mscore/.mside), so the object changed shape purely
          by being looked at more closely. */}
      <div className="h2h-grid solo">
        <div className="h2h">
          {sideBlock(A, 0)}
          <div className="h2h-spine">vs</div>
          {sideBlock(B, 1)}
        </div>
      </div>

      <div className="mlineups">
        {[A, B].filter(Boolean).map(sd => {
          const s = sd as Side;
          return (
            <div key={s.rid} className="feed-panel">
              <div className="pick-title">{s.name}</div>
              <table className="feed">
                <tbody>
                  {/* NO SEAT LABELS (Max, 2026-09-08): the badge says the
                      position and the order is the league's lineup order, so
                      a QB / RB / FLX column said it twice. The NFL opponent
                      sits where it was — the thing a reader checks a lineup
                      against on a Sunday. */}
                  {s.slots.map((sl, i) => (
                    <tr key={`${sl.label}${i}`}>
                      <td className="t">
                        {sl.pid ? <span className="line">
                          <PosBadge pos={pInfo(players, sl.pid)[1]} />
                          <PlayerLink pid={sl.pid} name={pInfo(players, sl.pid)[0]} />
                          <Opp v={oppOf(sl.pid)} />
                        </span> : <span className="sub">— empty —</span>}
                      </td>
                      <td className="n"><b>{fmt(sl.pts, 1)}</b></td>
                      <td className="n sub">{sl.war == null ? "" : sgnWar(sl.war)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {played && !s.hasBench && (
                <div className="tnote" style={{ padding: "8px 10px" }}>
                  No bench on record for this week — the data predates it.
                  Re-run <code>build_site_data.py</code>.
                </div>
              )}
              {s.benched.length > 0 && (
                <table className="feed">
                  <tbody>
                    <tr className="grp"><th scope="colgroup" className="t" colSpan={3}>Bench</th></tr>
                    {s.benched.map(b => (
                      <tr key={b.pid}>
                        <td className="t">
                          <span className="line">
                            <PosBadge pos={pInfo(players, b.pid)[1]} />
                            <PlayerLink pid={b.pid} name={pInfo(players, b.pid)[0]} />
                            <Opp v={oppOf(b.pid)} />
                          </span>
                        </td>
                        <td className="n"><b className={b.pts > 0 ? "" : "sub"}>{fmt(b.pts, 1)}</b></td>
                        <td className="n sub">{played ? sgnWar(wkIdx[b.pid]?.[1] ?? 0) : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          );
        })}
      </div>

      <div className="tnote screen">
        {played
          ? "Actual starters and what they scored; WAR is that player's contribution in this week. Max is the best legal lineup from that week's roster — bench included. The bench is everyone rostered and not started, taxi and IR excluded."
          : `Lineups are the best legal eleven by projected points — rosters aren't set yet. Win probability from the projected margin against a league weekly sigma of ${fmt(sigma, 1)}. Beside each name: his NFL opponent this week. The bench is the rest of the active roster at this week's projected line.`}
      </div>
    </>
  );
}
