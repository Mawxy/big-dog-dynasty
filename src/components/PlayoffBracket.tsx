import type { CSSProperties } from "react";
import { useNavigate } from "react-router-dom";
import type { BracketFile, BracketGame } from "../lib/types";
import { fmt } from "../lib/stats";
import { useLeaguePath } from "../lib/context";
import TScroll from "./TScroll";

/** the round a game decides, which is its card's default caption */
const gameTitle = (g: BracketGame) =>
  g.p === 1 ? "Championship" : g.p === 3 ? "3rd place" : g.p === 5 ? "5th place"
    : g.r === 1 ? "Quarterfinal" : g.r === 2 ? "Semifinal" : `Round ${g.r}`;

/**
 * One game as the design system's head-to-head unit: two stacked sides, the
 * winner taking the accent score, no margin figure. Clicking it opens that
 * week's matchup on the Season tab.
 *
 * Exported because the bracket is not the only place a playoff game appears —
 * PlayoffPanel prints the upsets and the superlatives as the same card, and
 * hand-rolled a second copy of it (and of its keyboard contract) to do so.
 * The bracket captions each card with the round it decides; the panel captions
 * it with why the game is on screen ("Won as a 28.9% underdog"), which is the
 * one thing the two ever disagreed on.
 */
export function GameCard({ season, bracket, g, cls, caption, style }: {
  season: string; bracket: BracketFile; g: BracketGame;
  /** extra modifier on the card — `champ`, `plc` */
  cls?: string;
  /** caption override; defaults to the round the game decides */
  caption?: string;
  style?: CSSProperties;
}) {
  const nav = useNavigate();
  const lp = useLeaguePath();
  const nameOf = (rid: number | null) =>
    rid == null ? "—" : bracket.names[String(rid)] ?? `Roster ${rid}`;
  const seedOf = (rid: number | null) => (rid == null ? null : bracket.seeds[String(rid)] ?? null);
  // a card with no team on the near side opens nothing, so it is not a
  // control and must not become a tab stop
  const act = g.t1 != null;
  const go = () => act && nav(lp(`/weekly/${season}/${g.week}/${g.t1}`));
  const side = (rid: number | null, pts: number | null) => (
    <div className={`bside ${rid != null && g.w === rid ? "won" : ""}`}>
      <span className="seed">{seedOf(rid) ?? "—"}</span>
      <span className="team">{nameOf(rid)}</span>
      <span className="pts">{pts == null ? "—" : fmt(pts, 2)}</span>
    </div>
  );
  return (
    <div className={`bgame tap${cls ? ` ${cls}` : ""}`} style={style}
      title={`Open the week ${g.week} matchup`}
      tabIndex={act ? 0 : undefined} role={act ? "button" : undefined}
      onClick={go}
      onKeyDown={act ? e => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); }
      } : undefined}>
      <div className="bgame-head"><span>{caption ?? gameTitle(g)}</span><span>WK {g.week}</span></div>
      {side(g.t1, g.t1_pts)}
      {side(g.t2, g.t2_pts)}
    </div>
  );
}

/**
 * One season's bracket, drawn as a bracket: the quarterfinals on the left with
 * the top seeds' byes in their own slots, the semifinals centered against the
 * pairs that feed them, the final centered against both. Connectors are drawn in CSS
 * off each cell, so the shape survives any column width.
 *
 * The placement games (3rd, 5th) are NOT part of that tree — they decide
 * nothing above them — so they sit below it under their own band rather than
 * hanging off a round column, which is what made the first version read as a
 * five-game round.
 *
 * Each cell is a GameCard (above) — the head-to-head unit from the design
 * system, shared with PlayoffPanel's upset and superlative cards.
 */
export default function PlayoffBracket({ season, bracket }: { season: string; bracket: BracketFile }) {
  // routing lives in GameCard now; the bracket itself only draws the shape
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

  const game = (g: BracketGame, cls?: string) =>
    <GameCard season={season} bracket={bracket} g={g} cls={cls} />;

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
      <TScroll box="dscroll" hint="The bracket scrolls sideways — quarterfinals through the final.">
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
      </TScroll>
    </>
  );
}
