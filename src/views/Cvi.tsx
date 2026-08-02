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
    note="Prices this season alone · a clamped 0–100 score, so it is a bare figure and never metered"
    footnote={<>A single 0–100 value for this season only — half expert consensus, half production
      and usage. Unlike DVI it cannot see age, so it never discounts a producer for getting
      older. The position badge carries rank within position. Both indices side by side, with
      the market beside them, are on Players → Value.</>} />;
}
