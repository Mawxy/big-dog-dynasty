import { useLocation, useNavigate } from "react-router-dom";
import { useLeague, useLeaguePath } from "../lib/context";
import { seasonSeg } from "../lib/league";

/**
 * The season selector, rendered by the views that are actually season-scoped.
 *
 * It used to live in the masthead, which made it look global — but only three
 * of the seven views take a season at all, so on League, Draft, Trades and DVI
 * it was either hidden (leaving a gap) or, worse, present and inert. Owning it
 * per-view means the control appears exactly where it applies.
 *
 * View and current season come from the path rather than props, so a view drops
 * it in with no wiring: `/<league>/<view>/<season>/...`.
 */
export default function SeasonPicker({ allTime = true }: { allTime?: boolean }) {
  const { meta } = useLeague();
  const nav = useNavigate();
  const lp = useLeaguePath();
  const parts = useLocation().pathname.split("/");
  const view = parts[2] || "players";
  const cur = parts[3] || seasonSeg(meta.latest && meta.seasons.includes(meta.latest)
    ? meta.latest : meta.seasons[meta.seasons.length - 1]);
  // "Week 12" and "the playoffs" are the same question asked of a different
  // year, so the season switch carries that segment across instead of dropping
  // the reader back on the view's index. Only the weekly view has a week
  // there — elsewhere a fourth segment is season-specific (a roster id), which
  // would mean something different or nothing at all in the new season. A
  // deeper segment still (one matchup) is always left behind: that pairing
  // belongs to the season being left.
  const carry = view === "weekly" && parts[4] ? `/${parts[4]}` : "";
  const label = cur.toLowerCase() === "all" ? "All-time" : cur;
  // The chip is a SPAN that carries the text, with the <select> laid over it
  // transparently. A bare styled <select> sizes itself to its text without
  // counting the trailing letter-space or the condensed font's overhang, so
  // the last character clipped ("2025" reading as "202") and no amount of
  // padding fixed it reliably across browsers. Here the span does the sizing —
  // ordinary inline text, measured correctly — and the select only handles
  // interaction, so the two can't disagree.
  return (
    <span className="season-chip">
      <span className="season-chip-label">{label}</span>
      <select value={cur} aria-label="Season"
        onChange={e => nav(lp(`/${view}/${e.target.value}${carry}`))}>
        {meta.seasons.slice().reverse().map(s => <option key={s} value={s}>{s}</option>)}
        {allTime && <option value="all">All-time</option>}
      </select>
      <span className="season-chip-caret" aria-hidden="true">▾</span>
    </span>
  );
}
