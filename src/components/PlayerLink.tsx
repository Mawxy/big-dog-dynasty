import { useShellPath } from "../lib/context";
import { RouteLink } from "./RouteLink";

/**
 * Player name that navigates to the player's dedicated page.
 *
 * The most-used control on the site — it is in every leaderboard row, every
 * drawer and every roster. A thin wrapper over RouteLink, which owns the
 * anchor and the modifier-click handling.
 *
 * `useShellPath`, not `useLeaguePath`: several of the views this link sits in
 * (Player, DraftDetail, History, Insights) are mounted by BOTH shells, and the
 * player page exists in both. Building `/classic/player/<pid>` unconditionally
 * dumped a beta reader out of the shell on the first tap of a name.
 */
export function PlayerLink({ pid, name }: { pid: string; name: string }) {
  const sp = useShellPath();
  return <RouteLink to={sp(`/player/${pid}`)}>{name}</RouteLink>;
}
