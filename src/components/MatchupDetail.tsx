import { useEffect, useMemo, useState } from "react";
import type {
  Matchups, PlayersMin, SeasonData, SleeperProjFile, Weekly as WeeklyT,
} from "../lib/types";
import { jl } from "../lib/data";
import { fmt, sgn, normCdf } from "../lib/stats";
import { pInfo, DEFAULT_LINEUP, SLOT_LABEL, optimalLineup } from "../lib/league";
import { useLeague } from "../lib/context";
import PosBadge from "./PosBadge";
import { PlayerLink } from "./PlayerLink";

interface Side {
  rid: number; name: string;
  /** slot label, player, and what he scored (or is projected to) */
  slots: { label: string; pid: string | null; pts: number; war: number | null }[];
  total: number;
  /** whether this week's entry carried a bench at all */
  hasBench: boolean;
  /** what the best legal lineup would have scored from the same roster */
  max: number;
  /** highest-scoring players who were NOT started */
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
/** how many of the best benched players to name */
const BENCH_SHOWN = 5;

export default function MatchupDetail({ season, wk, rid, data, weekly, mw, players, back }: {
  season: string; wk: number; rid: number;
  data: SeasonData; weekly: WeeklyT; mw: Matchups; players: PlayersMin;
  back: () => void;
}) {
  const { meta } = useLeague();
  const [sproj, setSproj] = useState<SleeperProjFile | null>(null);
  const lineup = (meta.rosterPositions?.length ? meta.rosterPositions : DEFAULT_LINEUP)
    .filter(s => !["BN", "IR", "TAXI"].includes(s));

  // the entry for this week, if it was played
  const entryOf = (r: number) => (mw.teams[String(r)] ?? []).find(x => x[0] === wk);
  const mine = entryOf(rid);
  const oppRid = mine?.[2]
    ?? (mw.schedule?.[String(wk)] ?? []).flatMap(p => p[0] === rid ? [p[1]] : p[1] === rid ? [p[0]] : [])[0]
    ?? null;
  const played = !!mine && mine[1] > 0;

  useEffect(() => {
    if (played) return;
    let live = true;
    jl<SleeperProjFile>("proj_sleeper.json")
      .then(p => { if (live) setSproj(p); }).catch(() => {});
    return () => { live = false; };
  }, [played]);

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
          .filter(b => b.pts > 0)
          .sort((a, b) => b.pts - a.pts)
          .slice(0, BENCH_SHOWN),
      };
    }
    // not played: project the best legal lineup by expected points
    const pool = (team?.players ?? [])
      .map(pid => ({ id: pid, pos: pInfo(players, pid)[1],
                     war: sproj?.players?.[pid]?.ppg ?? 0 }))
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
      // the projected lineup already IS the optimal one, and nothing has been
      // benched yet, so neither has anything to say
      max: slots.reduce((a, s) => a + (s.player?.war ?? 0), 0),
      benched: [],
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
    const win = played
      ? s.total === Math.max(A.total, B?.total ?? 0)
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
                  {s.slots.map((sl, i) => (
                    <tr key={`${sl.label}${i}`}>
                      <td className="t sub" style={{ width: 52 }}>{sl.label}</td>
                      <td className="t">
                        {sl.pid ? <span className="line">
                          <PosBadge pos={pInfo(players, sl.pid)[1]} />
                          <PlayerLink pid={sl.pid} name={pInfo(players, sl.pid)[0]} />
                        </span> : <span className="sub">— empty —</span>}
                      </td>
                      <td className="n"><b>{fmt(sl.pts, 1)}</b></td>
                      <td className="n sub">{sl.war == null ? "" : sgn(sl.war, 2)}</td>
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
                    <tr className="grp"><th scope="colgroup" className="t" colSpan={3}>Best not started</th></tr>
                    {s.benched.map(b => (
                      <tr key={b.pid}>
                        <td className="t sub" style={{ width: 52 }} />
                        <td className="t">
                          <span className="line">
                            <PosBadge pos={pInfo(players, b.pid)[1]} />
                            <PlayerLink pid={b.pid} name={pInfo(players, b.pid)[0]} />
                          </span>
                        </td>
                        <td className="n"><b>{fmt(b.pts, 1)}</b></td>
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
          ? "Actual starters and what they scored; WAR is that player's contribution in this week. Max is the best legal lineup from that week's roster — bench included."
          : `Lineups are the best legal eleven by projected points — rosters aren't set yet. Win probability from the projected margin against a league weekly sigma of ${fmt(sigma, 1)}.`}
      </div>
    </>
  );
}
