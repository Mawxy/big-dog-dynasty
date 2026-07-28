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
}

/**
 * One matchup, both lineups side by side.
 *
 * Played weeks read the actual starters out of matchups.json and their real
 * points and WAR out of weekly.json. Unplayed weeks have no starters at all —
 * the roster hasn't been set — so the lineup is the OPTIMAL one by projected
 * points, which is a forecast of the manager's decision as much as the result.
 * The two are labelled differently for that reason.
 */
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
      return { rid: r, name, slots, total: e[1] };
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
    };
  };

  const A = sideOf(rid), B = sideOf(oppRid);
  if (!A) return <div className="empty">No matchup found for week {wk}.</div>;

  // P(A wins) from the projected margin — Φ(margin / (σ√2)), the same
  // formulation the WAR engine uses to turn points into win probability
  const margin = A.total - (B?.total ?? 0);
  const pA = B ? normCdf(margin / (sigma * Math.SQRT2)) : 1;

  return (
    <>
      <span className="back" onClick={back}>← week {wk}</span>
      <div className="screen-head" style={{ paddingLeft: 0 }}>
        <span className="screen-title">
          {A.name} {played ? "vs" : "at"} {B?.name ?? "bye"}
        </span>
        <span className="screen-note">
          Week {wk} · {season} · {played ? "final" : "projected"}
        </span>
      </div>

      {/* headline: the two totals, and who is favoured when it hasn't happened */}
      <div className="mscore">
        {[A, B].filter(Boolean).map((sd, i) => {
          const s = sd as Side;
          const win = played
            ? s.total === Math.max(A.total, B?.total ?? 0)
            : (i === 0 ? pA >= 0.5 : pA < 0.5);
          return (
            <div key={s.rid} className={`mside${win ? " win" : ""}`}>
              <div className="nm">{s.name}</div>
              <div className="pts">{fmt(s.total, 1)}</div>
              {!played && B && (
                <div className="by">{fmt((i === 0 ? pA : 1 - pA) * 100, 0)}% to win</div>
              )}
            </div>
          );
        })}
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
            </div>
          );
        })}
      </div>

      <div className="tnote">
        {played
          ? "Actual starters and what they scored; WAR is that player's contribution in this week."
          : `Lineups are the best legal eleven by projected points — rosters aren't set yet. Win probability from the projected margin against a league weekly sigma of ${fmt(sigma, 1)}.`}
      </div>
    </>
  );
}
