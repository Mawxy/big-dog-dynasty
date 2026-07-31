import { useNavigate } from "react-router-dom";
import type { BracketFile, BracketGame } from "../lib/types";
import { fmt } from "../lib/stats";
import { useLeaguePath } from "../lib/context";

/**
 * One season's winners bracket as three columns — Round 1, Semifinals,
 * Finals — plus the placement games each round settles. A game is the
 * head-to-head unit from the design system: two stacked sides, the winner
 * takes the accent score; no margin figure, the two scores already state it.
 * Clicking a game opens that week's matchup on the Weekly tab.
 */
export default function PlayoffBracket({ season, bracket }: { season: string; bracket: BracketFile }) {
  const nav = useNavigate();
  const lp = useLeaguePath();
  const { winners, seeds, names } = bracket;

  const titleOf = (g: BracketGame) =>
    g.p === 1 ? "Championship" : g.p === 3 ? "3rd place" : g.p === 5 ? "5th place"
      : g.r === 1 ? "Round 1" : g.r === 2 ? "Semifinal" : `Round ${g.r}`;

  const cols: { label: string; games: BracketGame[] }[] = [1, 2, 3].map(r => ({
    label: r === 3 ? "Finals" : r === 2 ? "Semifinals" : "Round 1",
    games: winners.filter(g => g.r === r)
      .slice().sort((a, b) => (a.p ?? 0) - (b.p ?? 0)),
  })).filter(c => c.games.length);

  const side = (g: BracketGame, rid: number | null, pts: number | null) => {
    const won = rid != null && g.w === rid;
    const seed = rid != null ? seeds[String(rid)] : null;
    return (
      <div className={`bside ${won ? "won" : ""}`}>
        <span className="seed">{seed ?? "—"}</span>
        <span className="team">{rid != null ? names[String(rid)] ?? `Roster ${rid}` : "—"}</span>
        <span className="pts">{pts == null ? "—" : fmt(pts, 2)}</span>
      </div>
    );
  };

  return (
    <div className="dscroll">
      <div className="bracket">
        {cols.map(c => (
          <div key={c.label} className="bcol">
            <div className="bcol-label">{c.label}</div>
            {c.games.map(g => (
              <div key={`${g.r}.${g.p ?? "e"}.${g.t1}`}
                className="bgame tap"
                title={`Open the week ${g.week} matchup`}
                onClick={() => g.t1 != null &&
                  nav(lp(`/weekly/${season}/${g.week}/${g.t1}`))}>
                <div className="bgame-head">
                  <span>{titleOf(g)}</span>
                  <span>WK {g.week}</span>
                </div>
                {side(g, g.t1, g.t1_pts)}
                {side(g, g.t2, g.t2_pts)}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
