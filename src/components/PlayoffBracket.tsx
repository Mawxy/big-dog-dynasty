import { useNavigate } from "react-router-dom";
import type { BracketFile, BracketGame } from "../lib/types";
import { fmt } from "../lib/stats";
import { useLeaguePath } from "../lib/context";

/**
 * One season's bracket, drawn as a bracket: the quarterfinals on the left with
 * the top seeds' byes in their own slots, the semifinals centred against the
 * pairs that feed them, the final centred against both. Connectors are drawn in CSS
 * off each cell, so the shape survives any column width.
 *
 * The placement games (3rd, 5th) are NOT part of that tree — they decide
 * nothing above them — so they sit below it under their own band rather than
 * hanging off a round column, which is what made the first version read as a
 * five-game round.
 *
 * A game is the head-to-head unit from the design system: two stacked sides,
 * winner takes the accent score, no margin figure. Clicking one opens that
 * week's matchup on the Season tab.
 */
export default function PlayoffBracket({ season, bracket }: { season: string; bracket: BracketFile }) {
  const nav = useNavigate();
  const lp = useLeaguePath();
  const { winners, seeds, names } = bracket;

  const nameOf = (rid: number | null) =>
    rid == null ? "—" : names[String(rid)] ?? `Roster ${rid}`;
  const seedOf = (rid: number | null) => (rid == null ? null : seeds[String(rid)] ?? null);

  // --- the tree: round 1, the semis it feeds, the final ---------------------
  const r1 = winners.filter(g => g.r === 1);
  const r1teams = new Set(r1.flatMap(g => [g.t1, g.t2]).filter((x): x is number => x != null));
  const semis = winners.filter(g => g.r === 2 && !g.p);
  const final = winners.find(g => g.p === 1) ?? null;
  // Placement games decide a finish, not a round — they hang below the tree
  // rather than inside it. Each sits in the COLUMN OF THE WEEK IT WAS PLAYED:
  // the 5th-place game runs in the semifinal week and the 3rd-place game in
  // the final week, so putting them in a list ordered by placing read as
  // though 3rd place happened first. Column-aligning them says when.
  const placements = winners.filter(g => g.p && g.p > 1);
  /** which round column a placement game belongs under, by its week */
  const colOf = (g: BracketGame): number => {
    const peers = winners.filter(x => x.week === g.week && !(x.p && x.p > 1));
    if (peers.some(x => x.p === 1)) return 3;      // final week
    if (peers.some(x => x.r === 2)) return 2;      // semifinal week
    return 1;                                      // quarterfinal week
  };

  /** a semi's bye team (never played round 1) and the game that fed its opponent */
  const legs = semis.map(s => {
    const sides = [s.t1, s.t2];
    const bye = sides.find(t => t != null && !r1teams.has(t)) ?? null;
    const feeder = r1.find(g => g.w != null && sides.includes(g.w)) ?? null;
    return { semi: s, bye, feeder };
  }).sort((a, b) => (seedOf(a.bye) ?? 99) - (seedOf(b.bye) ?? 99));

  const title = (g: BracketGame) =>
    g.p === 1 ? "Championship" : g.p === 3 ? "3rd place" : g.p === 5 ? "5th place"
      : g.r === 1 ? "Quarterfinal" : g.r === 2 ? "Semifinal" : `Round ${g.r}`;

  const side = (g: BracketGame, rid: number | null, pts: number | null) => (
    <div className={`bside ${rid != null && g.w === rid ? "won" : ""}`}>
      <span className="seed">{seedOf(rid) ?? "—"}</span>
      <span className="team">{nameOf(rid)}</span>
      <span className="pts">{pts == null ? "—" : fmt(pts, 2)}</span>
    </div>
  );

  const game = (g: BracketGame, cls = "") => (
    <div className={`bgame tap ${cls}`} title={`Open the week ${g.week} matchup`}
      onClick={() => g.t1 != null && nav(lp(`/weekly/${season}/${g.week}/${g.t1}`))}>
      <div className="bgame-head"><span>{title(g)}</span><span>WK {g.week}</span></div>
      {side(g, g.t1, g.t1_pts)}
      {side(g, g.t2, g.t2_pts)}
    </div>
  );

  /** a bye is a real slot in the bracket — the seed earned the week off */
  const byeCard = (rid: number | null, cls: string) => (
    <div className={`bgame bye ${cls}`}>
      <div className="bgame-head"><span>Bye</span><span>SEED {seedOf(rid) ?? "—"}</span></div>
      <div className="bside won">
        <span className="seed">{seedOf(rid) ?? "—"}</span>
        <span className="team">{nameOf(rid)}</span>
        <span className="pts rest">REST</span>
      </div>
    </div>
  );

  return (
    <>
      <div className="dscroll">
        <div className="pbr">
          <div className="pbr-lbl c1">Quarterfinals</div>
          <div className="pbr-lbl c2">Semifinals</div>
          <div className="pbr-lbl c3">Final</div>
          {legs.map((leg, i) => (
            <div key={i} className={`pbr-leg leg${i + 1}`}>
              <div className="pbr-feed">
                {byeCard(leg.bye, "")}
                {leg.feeder ? game(leg.feeder) : <div className="bgame empty-slot" />}
              </div>
              <div className="pbr-semi">{game(leg.semi)}</div>
            </div>
          ))}
          <div className="pbr-final">{final ? game(final, "champ") : null}</div>

          {/* placement games, each under the round it was played alongside */}
          {placements.length > 0 && (
            <div className="pbr-plc-rule">
              <span>Placement games · settle a finish, nothing advances, no WPA</span>
            </div>
          )}
          {placements.map(g => (
            <div key={g.p} className={`pbr-plc c${colOf(g)}`}>{game(g, "plc")}</div>
          ))}
        </div>
      </div>
    </>
  );
}
