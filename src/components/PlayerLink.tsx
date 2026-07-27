import { useNavigate } from "react-router-dom";
import { useLeaguePath } from "../lib/context";

/** Player name that navigates to the player's dedicated page. */
export function PlayerLink({ pid, name }: { pid: string; name: string }) {
  const nav = useNavigate();
  const lp = useLeaguePath();
  return (
    <span className="tlink" onClick={e => { e.stopPropagation(); nav(lp(`/player/${pid}`)); }}>
      {name}
    </span>
  );
}
