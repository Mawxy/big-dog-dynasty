import { useNavigate } from "react-router-dom";
import { useLeaguePath } from "../lib/context";

/**
 * Player name that navigates to the player's dedicated page.
 *
 * A real anchor, not a span with an onClick. This is the most-used control on
 * the site — it is in every leaderboard row, every drawer and every roster —
 * and as a span it was unreachable by keyboard and impossible to open in a new
 * tab. The href is the hash route the HashRouter already uses, so middle-click
 * and ⌘-click work natively; a plain left click is still an in-app navigation,
 * and still stops the row underneath from also opening its drawer.
 */
export function PlayerLink({ pid, name }: { pid: string; name: string }) {
  const nav = useNavigate();
  const lp = useLeaguePath();
  const to = lp(`/player/${pid}`);
  return (
    <a className="tlink" href={`#${to}`}
      onClick={e => {
        // a modifier click belongs to the browser: let it open its own tab,
        // but never let it also toggle the row this link sits in
        e.stopPropagation();
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        nav(to);
      }}>
      {name}
    </a>
  );
}
