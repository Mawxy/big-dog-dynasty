import IndexBoard from "../components/IndexBoard";

/**
 * Contender Value Index leaderboard — DVI's one-year sibling, same shape.
 *
 * Half FantasyPros redraft consensus, half the non-market signals (projected
 * WAR, roster%, start%). No market input, so no age channel: a 32-year-old who
 * produces this season reads like one.
 */
export default function Cvi() {
  return <IndexBoard file="cvi.json" pick="cvi" title="Contender Value Index"
    footnote={<>A single 0–100 value for THIS SEASON only — half expert consensus, half production
      and usage · unlike DVI it cannot see age, so it never discounts a producer for getting older</>} />;
}
