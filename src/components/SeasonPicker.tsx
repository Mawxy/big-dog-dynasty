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
  return (
    <select className="season-chip" value={cur}
      // deeper segments (a team, a week) belong to the season being left, so
      // changing season returns to the view's index rather than carrying them
      onChange={e => nav(lp(`/${view}/${e.target.value}`))}>
      {meta.seasons.slice().reverse().map(s => <option key={s} value={s}>{s}</option>)}
      {allTime && <option value="all">All-time</option>}
    </select>
  );
}
