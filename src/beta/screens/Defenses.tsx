import { useMemo } from "react";
import type { DefenseVsPosition, DvpCell } from "../../lib/types";
import { useJson } from "../../lib/useJson";
import { useLeagueCaps } from "../../lib/caps";
import { clubName } from "../../lib/league";
import { lum, mix } from "../../lib/color";
import { ord, sgn } from "../../lib/stats";
import { useSeasonPhase } from "../model";
import { Band, DataError, IdCell, Spine, TapRow, Th, sortBy, useSort } from "../ui";
import "./defenses.css";

/**
 * DEFENSE VS POSITION — the lineup builder's grid (Max, 2026-09-30).
 *
 * Every NFL defense against QB, RB, WR and TE: the fantasy points per game it
 * gives up to that position OVER what those players normally score, in Big Dog
 * scoring, shrunk toward last season (scripts/defense_vs_position.py).
 *
 * POINTS LEAD, RANK FOLLOWS (Max, 2026-09-30). The signal is noisy — a
 * defense's figure takes 20-35 games to be half signal — so early in a season
 * nearly every cell sits within a point of zero. A bare rank would make the
 * gap between 3rd and 30th look decisive when it is a point and a half; the
 * figure says how much, the ordinal under it says where.
 *
 * THE SHADE IS ON A FIXED SCALE, not stretched to the table: full color at
 * ±SCALE points. A table-relative ramp would paint a week-3 spread of ±1.8 as
 * loudly as a week-17 spread of ±4, which is exactly the overstatement the
 * points-first rule exists to avoid. Near neutral stays near the board color.
 *
 * Green is SOFT (good for the offense you start against it), rose is tough.
 */
const POS = ["QB", "RB", "WR", "TE"] as const;
type Pos = typeof POS[number];
type SortKey = Pos | "club";

/** points at which a cell reaches full color */
const SCALE = 3;
const NEUTRAL = "#151a21";
const SOFT = "#2e8f56";
const TOUGH = "#a8474f";

export function heatBg(v: number): string {
  const t = Math.min(1, Math.abs(v) / SCALE);
  return mix(NEUTRAL, v >= 0 ? SOFT : TOUGH, t);
}
/** ink off the cell's own luminance — dark on the bright greens, cream
 *  elsewhere — so every cell clears 4.5:1 whatever its shade */
export function heatFg(v: number): string {
  if (Math.abs(v) < 0.05) return "var(--txt2)";
  return lum(heatBg(v)) > 0.173 ? "#08170e" : "#fdeee0";
}

/** "Commanders" from "Washington Commanders" — the phone has room for one word */
const nick = (club: string) => {
  const n = clubName(club);
  return n.slice(n.lastIndexOf(" ") + 1);
};

type NflGames = Record<string, Record<string, [string, number, number | null, number | null, string]>>;

export default function Defenses() {
  const caps = useLeagueCaps();
  const phase = useSeasonPhase();
  const season = phase.rosterSeason;
  const dvp = useJson<DefenseVsPosition>(
    caps.dvp ? `${season}/defense_vs_position.json` : null, "leagueDaily");
  const games = useJson<NflGames>(caps.dvp ? `${season}/nfl_games.json` : null).data;
  const s = useSort<SortKey>("WR", -1, "dvp-sort");

  // this week's opponent for each defense: the OFFENSE a reader would start
  // against it. Null outside the regular season.
  const opp = useMemo(() => {
    const wk = phase.week;
    const m = new Map<string, string>();
    if (wk == null || !games?.[String(wk)]) return { wk, m };
    for (const [club, g] of Object.entries(games[String(wk)]))
      m.set(club, `${g[1] ? "vs" : "at"} ${nick(g[0])}`);
    return { wk, m };
  }, [games, phase.week]);

  const rows = useMemo(() => {
    if (!dvp.data) return null;
    const list = Object.entries(dvp.data.defenses).map(([club, cells]) => ({ club, cells }));
    return sortBy(list, r => s.sort === "club" ? nick(r.club) : r.cells[s.sort]?.est ?? null, s.dir);
  }, [dvp.data, s.sort, s.dir]);

  if (!caps.dvp) {
    return (
      <>
        <div className="v3-head"><h1>Defense vs position</h1></div>
        <div className="empty">Built for Big Dog Dynasty's scoring only — not published for this league.</div>
      </>
    );
  }

  const through = dvp.data?.through_week ?? 0;
  // names, not club codes (Max, 2026-09-30): "Wk 4 at Panthers"
  const sub = (club: string) => {
    if (opp.wk == null) return clubName(club);
    const o = opp.m.get(club);
    return `Wk ${opp.wk} ${o ?? "bye"}`;
  };

  return (
    <>
      <div className="v3-head">
        <h1>Defense vs position</h1>
        <span className="sub">
          {dvp.data ? (through ? `${season} through week ${through}` : `${season} preseason — last season only`) : null}
        </span>
      </div>
      <Band label="Points over expectation allowed"
        note="Per game, Big Dog scoring · + is softer" />
      <div className="dvp-legend" aria-hidden="true">
        <span>Tougher</span>
        <span className="sw">
          {[-1, -0.66, -0.33, 0, 0.33, 0.66, 1].map(u => (
            <i key={u} style={{ background: heatBg(u * SCALE) }} />
          ))}
        </span>
        <span>Softer</span>
        <span className="scale">±{SCALE} pts = full shade</span>
      </div>
      {dvp.error ? <DataError what="The defense grid didn't load"
          note="It's rebuilt nightly; if it was never built, the nightly hasn't run with it yet." />
        : !rows ? <div className="empty">Loading…</div>
        : (
          <table className="v3tbl dvp-tbl">
            <thead>
              <tr>
                <th className="c sp">#</th>
                <Th id="club" label="Defense" align="t" asc
                  sort={s.sort} onSort={s.onSort} />
                {POS.map(p => (
                  <Th key={p} id={p} label={p} align="n" width="17%"
                    sort={s.sort} onSort={s.onSort} />
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <TapRow key={r.club} className={i % 2 ? "zebra" : ""}>
                  <Spine rank={i + 1} />
                  <IdCell name={nick(r.club)} sub={sub(r.club)} />
                  {POS.map(p => <Cell key={p} c={r.cells[p]} on={s.sort === p} />)}
                </TapRow>
              ))}
            </tbody>
          </table>
        )}
      <div className="tnote screen">
        Each figure is the extra fantasy points per game a defense has given up to
        that position beyond what the players it faced normally score, blended with
        last season and pulled toward zero while the sample is small. The ordinal
        under it is its rank, 1st softest to 32nd toughest. Early in a season most
        defenses sit within a point of zero; that is the data being honest about
        how little three games say, and the spread widens as weeks are played.
      </div>
    </>
  );
}

function Cell({ c, on }: { c: DvpCell | undefined; on: boolean }) {
  if (!c) return <td className="n dvp-cell"><span className="nul">—</span></td>;
  return (
    <td className={`n dvp-cell${on ? " on" : ""}`}
      style={{ background: heatBg(c.est), color: heatFg(c.est) }}>
      <span className="v">{sgn(c.est, 1)}</span>
      <span className="r">{ord(c.rank)}</span>
    </td>
  );
}
