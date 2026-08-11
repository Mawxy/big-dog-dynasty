import { useLeaguePath } from "../lib/context";
import { RouteLink } from "./RouteLink";

/**
 * Player name that navigates to the player's dedicated page.
 *
 * The most-used control on the site — it is in every leaderboard row, every
 * drawer and every roster. A thin wrapper over RouteLink, which owns the
 * anchor and the modifier-click handling.
 */
export function PlayerLink({ pid, name }: { pid: string; name: string }) {
  const lp = useLeaguePath();
  return <RouteLink to={lp(`/player/${pid}`)}>{name}</RouteLink>;
}
