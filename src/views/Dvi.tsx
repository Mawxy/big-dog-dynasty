import IndexBoard from "../components/IndexBoard";

/** Dynasty Value Index leaderboard. One 0–100 value per player, no breakdown. */
export default function Dvi() {
  return <IndexBoard file="dvi.json" pick="dvi" title="Dynasty Value Index"
    note="Prices the dynasty horizon · a clamped 0–100 score, so it is a bare figure and never metered"
    footnote={<>A single 0–100 dynasty value per player — deliberately no component breakdown.
      The position badge carries rank within position. A DVI built from one signal reads
      identically to one built from four, so a low figure can mean “cheap” or “barely
      measured”. What a player actually did in a given year is on Players → Stats.</>} />;
}
