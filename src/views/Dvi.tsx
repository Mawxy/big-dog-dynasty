import IndexBoard from "../components/IndexBoard";

/** Dynasty Value Index leaderboard. One 0–100 value per player, no breakdown. */
export default function Dvi() {
  return <IndexBoard file="dvi.json" pick="dvi" title="Dynasty Value Index"
    footnote="A single 0–100 dynasty value per player — deliberately no component breakdown" />;
}
